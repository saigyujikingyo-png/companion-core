import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { sha } from '../src/durable-codec.ts';
import { directoryReader, reconstruct } from '../src/incremental-storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import {
  RECEIPT_POINTER_PREFIX,
  receiptPointer,
  parseReceiptPointer,
  encodeReceiptSegment,
  decodeReceiptSegment,
  segmentFrame,
} from '../src/receipt-segments.ts';
import { brotliCompressSync } from 'node:zlib';
import { DurableMemory } from '../src/durable-memory.ts';
import { inspectLegacyM2 } from '../src/legacy-m2-import.ts';
import { randomBytes } from 'node:crypto';
import { RetrievalService } from '../src/retrieval.ts';
const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'test' };
const event = {
  source: 'synthetic',
  eventKey: 'original',
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: '合成紫罗兰',
    occurredAt: null,
  },
};
const clock = { wall: () => 100, monotonic: () => 0 };
function database<T>(path: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}
function fixture(t: TestContext, writeLimitBytes = 524288, schema: 2 | 3 | 4 = 4) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aemc-if8-'))),
    authorityConfig = {
      directory: join(root, 'authority'),
      authorityId: 'synthetic',
      custodyDomain: 'independent',
      writeLimitBytes,
    };
  let authority = LocalSqliteAuthority.create(authorityConfig);
  if (schema >= 3) {
    authority.close();
    LocalSqliteAuthority.upgradeSchema(authorityConfig, 'operator-attested-stopped');
  }
  if (schema === 4) LocalSqliteAuthority.upgradeReceiptSchema(authorityConfig, 'operator-attested-stopped');
  if (schema >= 3) authority = LocalSqliteAuthority.open(authorityConfig);
  const config = {
    directory: join(root, 'vault'),
    vaultId: 'vault',
    identity: '合成用户',
    storageDomain: 'payload',
    storageProfile: 'blocks-br4-v1' as const,
    schemaVersion: 2 as const,
    authority,
    keys: generateKeySet(),
  };
  const v = AnchoredVault.create(config, 4, { clock });
  t.after(() => {
    v.close();
    authority.close();
  });
  return { root, authorityConfig, authority, config, v, path: join(authority.directory, 'authority.sqlite') };
}
function fill(f: ReturnType<typeof fixture>, count = 40, prefix = 'fill') {
  for (let i = 0; i < count; i++) f.v.claim(`${prefix}-${i}`, '合成payload');
}
function receipts(f: ReturnType<typeof fixture>) {
  return database(f.path, (db) => db.prepare('SELECT * FROM receipts ORDER BY vault_id,operation_id').all());
}
function sourceFiles(path: string) {
  return readdirSync(path)
    .sort()
    .map((name) => [name, sha(readFileSync(join(path, name)))]);
}
function untouched(f: ReturnType<typeof fixture>) {
  return {
    source: sourceFiles(f.config.directory),
    rows: database(f.path, (db) =>
      ['metadata', 'vaults', 'legacy_imports'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
    ),
    head: f.authority.inspect('vault'),
  };
}
function safety(f: ReturnType<typeof fixture>) {
  const head = f.authority.inspect('vault')!.head!,
    decoded = reconstruct(head, directoryReader(f.config.directory), f.config.keys, 4);
  try {
    return { image: sha(decoded.image), state: decoded.state };
  } finally {
    decoded.image.fill(0);
  }
}

test('receipt schema upgrade is explicit and enables the rollover API', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aemc-if8-')));
  const config = { directory: join(root, 'authority'), authorityId: 'synthetic', custodyDomain: 'independent' };
  LocalSqliteAuthority.create(config).close();
  LocalSqliteAuthority.upgradeSchema(config, 'operator-attested-stopped');
  assert.deepEqual(LocalSqliteAuthority.upgradeReceiptSchema(config, 'operator-attested-stopped'), {
    from: 3,
    to: 4,
    alreadyCurrent: false,
  });
  const authority = LocalSqliteAuthority.open(config);
  t.after(() => authority.close());
  assert.throws(() => authority.rolloverReceipts({ operationId: 'empty' }), /ANCHOR_ROLLOVER_EMPTY/);
});

test('schema4 migration is atomic, preserves rows, refuses schema2 and expires existing handles', (t) => {
  const f = fixture(t, 262144, 2);
  fill(f, 2);
  const original = receipts(f);
  assert.throws(
    () => LocalSqliteAuthority.upgradeReceiptSchema(f.authorityConfig, 'operator-attested-stopped'),
    /ANCHOR_RECEIPT_UPGRADE_REQUIRED/,
  );
  f.v.close();
  f.authority.close();
  LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped');
  const old = LocalSqliteAuthority.open(f.authorityConfig);
  t.after(() => old.close());
  const before = sha(readFileSync(f.path));
  for (const stop of ['after-table', 'after-version']) {
    assert.throws(
      () =>
        LocalSqliteAuthority.upgradeReceiptSchema(f.authorityConfig, 'operator-attested-stopped', (p) => {
          if (p === stop) throw Error('SYNTHETIC_UPGRADE');
        }),
      /SYNTHETIC_UPGRADE/,
    );
    assert.equal(sha(readFileSync(f.path)), before);
    assert.equal(old.inspectCapacity().schemaVersion, 3);
  }
  LocalSqliteAuthority.upgradeReceiptSchema(f.authorityConfig, 'operator-attested-stopped');
  assert.throws(() => old.inspectCapacity(), /ANCHOR_SCHEMA_CHANGED/);
  assert.deepEqual(receipts(f), original);
  assert.deepEqual(LocalSqliteAuthority.upgradeReceiptSchema(f.authorityConfig, 'operator-attested-stopped'), {
    from: 4,
    to: 4,
    alreadyCurrent: true,
  });
  assert.throws(
    () => LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped'),
    /ANCHOR_SCHEMA_ALREADY_NEWER/,
  );
});

test('real Unicode receipts roundtrip, counters retain original bytes and multiple segments permit new writes', (t) => {
  const f = fixture(t);
  fill(f);
  const original = receipts(f),
    state = untouched(f),
    payload = safety(f),
    before = f.authority.inspectCapacity();
  const result = f.authority.rolloverReceipts({ operationId: 'first' }),
    after = f.authority.inspectCapacity();
  assert.equal(result.receiptCount, original.length);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.limits), true);
  assert.deepEqual(untouched(f), state);
  assert.deepEqual(safety(f), payload);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(after.receiptStorage!.hot.count, 0);
  assert.equal(after.receiptStorage!.pointers.count, original.length);
  assert.equal(after.receiptStorage!.segments.jsonUtf8Bytes, before.receipts.jsonUtf8Bytes);
  assert.ok(after.database.freelistPages > before.database.freelistPages);
  assert.equal(after.database.pageCount, before.database.pageCount);
  assert.deepEqual(
    receipts(f).map((r) => [r.vault_id, r.operation_id]),
    original.map((r) => [r.vault_id, r.operation_id]),
  );
  for (const row of original)
    assert.equal(
      JSON.stringify(f.authority.transaction((tx) => tx.receipt(row.vault_id as string, row.operation_id as string))),
      row.receipt,
    );
  const bytes = sha(readFileSync(f.path));
  assert.deepEqual(
    f.authority.rolloverReceipts({ operationId: 'first', maxReceipts: 128, maxJsonBytes: 1048576 }),
    result,
  );
  assert.equal(sha(readFileSync(f.path)), bytes);
  assert.throws(
    () => f.authority.rolloverReceipts({ operationId: 'first', maxReceipts: 127 }),
    /ANCHOR_ROLLOVER_CONFLICT/,
  );
  assert.equal(sha(readFileSync(f.path)), bytes);
  fill(f, 30, 'second');
  const next = f.authority.rolloverReceipts({ operationId: 'second' });
  assert.equal(next.receiptCount, 30);
  f.v.claim('after-second', 'p');
  assert.equal(f.authority.inspectCapacity().receiptStorage!.segments.count, 2);
});

test('receipt-schema upgrade preserves pending and near-capacity schema3 authorities on refusal', (t) => {
  const f = fixture(t, 65536, 3);
  let refused = false;
  for (let i = 0; i < 100; i++) {
    try {
      f.v.claim(`before-upgrade-${i}`, 'p');
    } catch (error) {
      assert.equal((error as { code: string }).code, 'ANCHOR_CAPACITY');
      refused = true;
      break;
    }
  }
  assert.equal(refused, true);
  f.v.close();
  const before = sha(readFileSync(f.path));
  assert.throws(
    () => LocalSqliteAuthority.upgradeReceiptSchema(f.authorityConfig, 'operator-attested-stopped'),
    /ANCHOR_CAPACITY/,
  );
  assert.equal(sha(readFileSync(f.path)), before);
  assert.equal(f.authority.inspectCapacity().schemaVersion, 3);
  const p = fixture(t, 524288, 3);
  p.v.close();
  let armed = false;
  const active = AnchoredVault.open(p.config, 4, {
    clock,
    fault: (point) => {
      if (armed && point === 'prepared') throw Error('SYNTHETIC_PENDING');
    },
  });
  t.after(() => active.close());
  armed = true;
  assert.throws(() => active.claim('pending', 'p'), /ANCHOR_WRITE_FAILED/);
  const pending = sha(readFileSync(p.path));
  assert.throws(
    () => LocalSqliteAuthority.upgradeReceiptSchema(p.authorityConfig, 'operator-attested-stopped'),
    /ANCHOR_CAPACITY_PENDING/,
  );
  assert.equal(sha(readFileSync(p.path)), pending);
});

test('real lowered-cap refusal, rollover and fresh boot/new writing preserve UNKNOWN quota feedback and revocation', (t) => {
  const f = fixture(t, 131072),
    s = f.v.store,
    scope = s.ensureScope(who),
    ref = s.acceptEvent(scope, event);
  s.revoke(scope, ref);
  f.v.claim('delivered', 'p');
  f.v.reserve('delivered');
  f.v.terminal('delivered', 'ready', 'delivery');
  f.v.terminal('delivered', 'taken', 'delivery');
  f.v.terminal('delivered', 'acknowledged', 'delivery');
  f.v.consumeFeedback('delivery');
  f.v.claim('unknown', 'p');
  f.v.reserve('unknown');
  f.v.close();
  const running = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => running.close());
  let refused = false;
  for (let i = 0; i < 150; i++) {
    const head = f.authority.inspect('vault');
    try {
      running.claim(`capacity-${i}`, 'p');
    } catch (error) {
      assert.equal((error as { code: string }).code, 'ANCHOR_CAPACITY');
      assert.deepEqual(f.authority.inspect('vault'), head);
      refused = true;
      break;
    }
  }
  assert.equal(refused, true);
  assert.throws(() => running.status, /ANCHOR_UNAVAILABLE/);
  running.close();
  const before = f.authority.inspectCapacity(),
    unchanged = untouched(f),
    snapshot = safety(f);
  assert.ok(before.database.pageBytes <= 131072);
  assert.equal(snapshot.state.safety.reserved, 2);
  assert.equal(snapshot.state.safety.ingress.find((e) => e.state === 'unknown') !== undefined, true);
  const result = f.authority.rolloverReceipts({ operationId: 'capacity-relief' }),
    after = f.authority.inspectCapacity();
  assert.deepEqual(untouched(f), unchanged);
  assert.deepEqual(safety(f), snapshot);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(after.database.pageCount, before.database.pageCount);
  assert.ok(after.database.freelistPages > before.database.freelistPages);
  const fresh = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => fresh.close());
  assert.equal(fresh.head.sequence, unchanged.head!.head!.sequence + 1);
  fresh.claim('after-relief', 'p');
  assert.equal(fresh.reserved, 2);
  assert.throws(() => fresh.claim('unknown', 'p'), /INTERACTION_TERMINATED/);
  assert.throws(() => fresh.consumeFeedback('delivery'), /DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
  assert.throws(() => fresh.claim('unknown', 'changed'), /INTERACTION_IDEMPOTENCY_CONFLICT/);
  assert.throws(() => fresh.reserve('unknown'), /DURABLE_REQUEST_REQUIRED/);
  assert.equal(fresh.store.revocationHighWater(), 1);
  assert.deepEqual(fresh.store.acceptEvent(fresh.store.scope(scope.id), event), { ...ref, currentStatus: 'revoked' });
  assert.throws(
    () =>
      fresh.store.acceptEvent(fresh.store.scope(scope.id), {
        ...event,
        evidence: { ...event.evidence, selectedText: 'changed' },
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(fresh.store.search(fresh.store.scope(scope.id), '紫罗兰').length, 0);
  fresh.reserve('after-relief');
  fresh.claim('last-budget', 'p');
  fresh.reserve('last-budget');
  fresh.claim('over-budget', 'p');
  assert.throws(() => fresh.reserve('over-budget'), /REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(f.authority.inspectCapacity().limits.writeLimitBytes, 131072);
  assert.ok(f.authority.inspectCapacity().database.pageBytes <= 131072);
  t.diagnostic(
    JSON.stringify({
      before: before.database,
      after: after.database,
      receipts: before.receipts,
      segment: result,
      postBoot: f.authority.inspectCapacity().database,
    }),
  );
});

test('empty, no-benefit, invalid requests and overbound rows preserve the exact database', (t) => {
  const f = fixture(t),
    before = sha(readFileSync(f.path));
  assert.throws(
    () => f.authority.rolloverReceipts({ operationId: 'tiny', maxReceipts: 1 }),
    /ANCHOR_ROLLOVER_NO_BENEFIT/,
  );
  assert.equal(sha(readFileSync(f.path)), before);
  let touched = 0;
  for (const bad of [
    { operationId: 'x', path: 'override' },
    { operationId: 'x', maxReceipts: 257 },
    { operationId: 'x', maxJsonBytes: 1048577 },
    { operationId: 'x', maxJsonBytes: 1023 },
    Object.defineProperty({}, 'operationId', {
      get() {
        touched++;
        return 'x';
      },
    }),
    new Proxy(
      { operationId: 'x' },
      {
        ownKeys() {
          touched++;
          return [];
        },
      },
    ),
  ])
    assert.throws(() => f.authority.rolloverReceipts(bad as any), /ANCHOR_ROLLOVER_REQUEST/);
  assert.equal(touched, 0);
  assert.equal(sha(readFileSync(f.path)), before);
  const large = fixture(t);
  fill(large, 12);
  database(large.path, (db) => {
    const row = db.prepare('SELECT * FROM receipts LIMIT 1').get()!;
    const value = JSON.parse(row.receipt as string);
    db.prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?').run(
      JSON.stringify({ ...value, syntheticBoundary: 'x'.repeat(2048) }),
      row.vault_id!,
      row.operation_id!,
    );
  });
  const largeBefore = sha(readFileSync(large.path));
  assert.throws(
    () => large.authority.rolloverReceipts({ operationId: 'small', maxJsonBytes: 1024 }),
    /ANCHOR_ROLLOVER_BOUND/,
  );
  assert.equal(sha(readFileSync(large.path)), largeBefore);
  large.authority.rolloverReceipts({ operationId: 'all' });
  const archived = sha(readFileSync(large.path));
  assert.throws(() => large.authority.rolloverReceipts({ operationId: 'empty' }), /ANCHOR_ROLLOVER_EMPTY/);
  assert.equal(sha(readFileSync(large.path)), archived);
});

test('schema2 and schema3 retain their original capacity shape and reject rollover', (t) => {
  for (const version of [2, 3] as const) {
    const f = fixture(t, 262144, version);
    fill(f, 2);
    const before = sha(readFileSync(f.path)),
      report = f.authority.inspectCapacity();
    assert.equal(report.schemaVersion, version);
    assert.equal('receiptStorage' in report, false);
    assert.throws(() => f.authority.rolloverReceipts({ operationId: 'denied' }), /ANCHOR_RECEIPT_UPGRADE_REQUIRED/);
    assert.equal(sha(readFileSync(f.path)), before);
  }
});

test('segment decoder bounds full frames and rejects malformed, truncated, trailing, hash, key and UTF-8 corruption', () => {
  const entry = {
    vaultId: 'vault',
    operationId: 'operation',
    json: JSON.stringify({ version: 2, operationId: 'operation', newHead: { vaultId: 'vault' }, extra: '合成🚀' }),
  };
  const packed = encodeReceiptSegment('segment', [entry], 1048576);
  const decode = (
    payload: Uint8Array = packed.payload,
    size = packed.decodedBytes,
    digest = packed.digest,
    count = 1,
    bytes = packed.jsonBytes,
  ) => decodeReceiptSegment(payload, 'segment', size, digest, count, bytes);
  assert.deepEqual(decode(), [entry]);
  assert.equal(decode()[0]!.json, entry.json);
  for (const bytes of [
    packed.payload.subarray(0, packed.payload.length - 1),
    Buffer.concat([packed.payload, Buffer.from('trailing')]),
    Buffer.alloc(1048577),
  ])
    assert.throws(() => decode(bytes), /ANCHOR_RECEIPT_SEGMENT/);
  for (const size of [0, packed.decodedBytes - 1, packed.decodedBytes + 1, 1048577])
    assert.throws(() => decode(packed.payload, size), /ANCHOR_RECEIPT_SEGMENT/);
  assert.throws(() => decode(packed.payload, packed.decodedBytes, '0'.repeat(64)), /ANCHOR_RECEIPT_SEGMENT/);
  assert.throws(() => decode(packed.payload, packed.decodedBytes, packed.digest, 2), /ANCHOR_RECEIPT_SEGMENT/);
  assert.throws(
    () => decode(packed.payload, packed.decodedBytes, packed.digest, 1, packed.jsonBytes + 1),
    /ANCHOR_RECEIPT_SEGMENT/,
  );
  const frames = [
    { format: 'wrong', segmentId: 'segment', entries: [entry] },
    { format: 'companion-authority-receipts-v1', segmentId: 'wrong', entries: [entry] },
    { format: 'companion-authority-receipts-v1', segmentId: 'segment', entries: [{ ...entry, operationId: 'wrong' }] },
    { format: 'companion-authority-receipts-v1', segmentId: 'segment', entries: [{ ...entry, extra: 1 }] },
    { format: 'companion-authority-receipts-v1', segmentId: 'segment', entries: [entry], extra: 1 },
  ];
  for (const frame of frames) {
    const raw = Buffer.from(JSON.stringify(frame));
    assert.throws(() => decode(brotliCompressSync(raw), raw.length, sha(raw)), /ANCHOR_RECEIPT_SEGMENT/);
  }
  const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
  assert.throws(
    () => decode(brotliCompressSync(invalid), invalid.length, sha(invalid), 1, 1),
    /ANCHOR_RECEIPT_SEGMENT/,
  );
  const repeated = Buffer.from(segmentFrame('segment', [entry, entry]));
  assert.throws(
    () => decode(brotliCompressSync(repeated), repeated.length, sha(repeated), 2, packed.jsonBytes * 2),
    /ANCHOR_RECEIPT_SEGMENT/,
  );
  assert.throws(() => encodeReceiptSegment('segment', Array(257).fill(entry), 1048576), /ANCHOR_RECEIPT_SEGMENT/);
  const almost = { ...entry, json: 'x'.repeat(1048576) };
  assert.throws(() => encodeReceiptSegment('segment', [almost], 1048576), /ANCHOR_ROLLOVER_BOUND/);
  const pointer = receiptPointer('segment', 0, Buffer.byteLength(entry.json));
  assert.deepEqual(parseReceiptPointer(pointer), {
    segmentId: 'segment',
    index: 0,
    jsonBytes: Buffer.byteLength(entry.json),
  });
  for (const suffix of [
    '[]',
    '["segment",256,1]',
    '["segment",0,1048577]',
    '["segment",0,1,2]',
    '["segment", 0,1]',
    'x'.repeat(257),
  ])
    assert.throws(() => parseReceiptPointer(RECEIPT_POINTER_PREFIX + suffix), /ANCHOR_RECEIPT_SEGMENT/);
});

test('damaged persisted segment or pointer never becomes a missing receipt or idempotent success', (t) => {
  const f = fixture(t);
  fill(f);
  const original = receipts(f);
  f.authority.rolloverReceipts({ operationId: 'archive' });
  const segment = database(f.path, (db) =>
    db.prepare('SELECT * FROM receipt_segments WHERE segment_id=?').get('archive'),
  )!;
  const target = original[0]!,
    pointer = database(
      f.path,
      (db) =>
        db
          .prepare('SELECT receipt FROM receipts WHERE vault_id=? AND operation_id=?')
          .get(target.vault_id!, target.operation_id!)!.receipt,
    );
  const restore = () =>
    database(f.path, (db) => {
      db.prepare('DELETE FROM receipt_segments WHERE segment_id=?').run('archive');
      db.prepare('INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)').run(
        segment.segment_id!,
        segment.request!,
        segment.digest!,
        segment.decoded_bytes!,
        segment.encoded_bytes!,
        segment.entry_count!,
        segment.json_bytes!,
        segment.payload!,
      );
      db.prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?').run(
        pointer!,
        target.vault_id!,
        target.operation_id!,
      );
    });
  const lookup = () =>
    f.authority.transaction((tx) => tx.receipt(target.vault_id as string, target.operation_id as string));
  const faults = [
    (db: DatabaseSync) => db.prepare('DELETE FROM receipt_segments WHERE segment_id=?').run('archive'),
    (db: DatabaseSync) =>
      db
        .prepare(
          'UPDATE receipt_segments SET payload=substr(payload,1,length(payload)-1),encoded_bytes=encoded_bytes-1',
        )
        .run(),
    (db: DatabaseSync) =>
      db
        .prepare('UPDATE receipt_segments SET payload=?,encoded_bytes=?')
        .run(
          Buffer.concat([segment.payload as Uint8Array, Buffer.from('tail')]),
          (segment.encoded_bytes as number) + 4,
        ),
    (db: DatabaseSync) => db.prepare('UPDATE receipt_segments SET digest=?').run('0'.repeat(64)),
    (db: DatabaseSync) => db.prepare('UPDATE receipt_segments SET decoded_bytes=decoded_bytes-1').run(),
    (db: DatabaseSync) => db.prepare('UPDATE receipt_segments SET entry_count=entry_count+1').run(),
    (db: DatabaseSync) =>
      db
        .prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?')
        .run(receiptPointer('archive', 255, 1), target.vault_id!, target.operation_id!),
    (db: DatabaseSync) =>
      db
        .prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?')
        .run(RECEIPT_POINTER_PREFIX + 'not-json', target.vault_id!, target.operation_id!),
    (db: DatabaseSync) =>
      db
        .prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?')
        .run(pointer + '\0tail', target.vault_id!, target.operation_id!),
    (db: DatabaseSync) =>
      db.prepare('UPDATE receipt_segments SET payload=zeroblob(1048577),encoded_bytes=1048577').run(),
  ];
  for (const fault of faults) {
    database(f.path, fault);
    const before = sha(readFileSync(f.path));
    assert.throws(lookup, /ANCHOR_RECEIPT_SEGMENT/);
    assert.throws(() => f.authority.rolloverReceipts({ operationId: 'archive' }), /ANCHOR_RECEIPT_SEGMENT/);
    assert.equal(sha(readFileSync(f.path)), before);
    restore();
  }
  // A metadata length refusal must precede allocation of the stored BLOB.
  database(f.path, (db) =>
    db.prepare('UPDATE receipt_segments SET payload=zeroblob(1048577),encoded_bytes=1048577').run(),
  );
  const prepare = DatabaseSync.prototype.prepare;
  let blobRead = false;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql === 'SELECT * FROM receipt_segments WHERE segment_id=?') blobRead = true;
      return prepare.call(this, sql);
    };
    assert.throws(lookup, /ANCHOR_RECEIPT_SEGMENT/);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(blobRead, false);
});

test('global pending blocks a new rollover but confirmed maintenance retries remain read-only', (t) => {
  const f = fixture(t);
  fill(f);
  const done = f.authority.rolloverReceipts({ operationId: 'done' });
  f.v.close();
  let armed = false;
  const active = AnchoredVault.open(f.config, 4, {
    clock,
    fault: (p) => {
      if (armed && p === 'prepared') throw Error('SYNTHETIC_PENDING');
    },
  });
  t.after(() => active.close());
  armed = true;
  assert.throws(() => active.claim('interrupted', 'p'), /ANCHOR_WRITE_FAILED/);
  const pending = f.authority.inspect('vault')!,
    before = sha(readFileSync(f.path));
  assert.equal(pending.status, 'PREPARED');
  assert.deepEqual(f.authority.rolloverReceipts({ operationId: 'done' }), done);
  assert.equal(sha(readFileSync(f.path)), before);
  assert.throws(() => f.authority.rolloverReceipts({ operationId: 'blocked' }), /ANCHOR_CAPACITY_PENDING/);
  assert.equal(sha(readFileSync(f.path)), before);
  AnchoredVault.reconcile({
    authority: f.authority,
    vaultId: 'vault',
    operationId: pending.pending!.operationId,
    keys: f.config.keys,
    maxCalls: 4,
  });
  assert.equal(f.authority.inspect('vault')!.status, 'ACTIVE');
});

test('rollover SQL failure rolls back every selected key and cannot be swallowed into a durable partial archive', (t) => {
  const f = fixture(t);
  fill(f);
  const before = sha(readFileSync(f.path)),
    original = receipts(f),
    prepare = DatabaseSync.prototype.prepare;
  let hit = 0;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql === 'INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)') {
        hit++;
        throw Error('SYNTHETIC_SEGMENT_SQL');
      }
      return prepare.call(this, sql);
    };
    try {
      f.authority.rolloverReceipts({ operationId: 'failed' });
    } catch (error) {
      assert.match(String(error), /SYNTHETIC_SEGMENT_SQL/);
    }
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(hit, 1);
  assert.equal(sha(readFileSync(f.path)), before);
  assert.deepEqual(receipts(f), original);
  assert.equal(f.authority.inspectCapacity().receiptStorage!.segments.count, 0);
  f.authority.rolloverReceipts({ operationId: 'fresh' });
});

function child(f: ReturnType<typeof fixture>, body: string) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';import assert from 'node:assert/strict';const config=JSON.parse(readFileSync(0,'utf8'));${body}`,
    ],
    {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
      input: JSON.stringify(f.authorityConfig),
    },
  );
}
test('real process death before COMMIT restores the original set; post-COMMIT response loss retries the original result', (t) => {
  const f = fixture(t);
  fill(f);
  f.v.close();
  const before = sha(readFileSync(f.path)),
    original = receipts(f);
  const pre = child(
    f,
    `const a=LocalSqliteAuthority.open(config),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let armed=false;
    DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)')armed=true;return prepare.call(this,sql);};
    DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT')process.exit(42);return exec.call(this,sql);};a.rolloverReceipts({operationId:'crashed'});`,
  );
  assert.equal(pre.status, 42, pre.stderr);
  const reopened = LocalSqliteAuthority.open(f.authorityConfig);
  reopened.close();
  assert.equal(sha(readFileSync(f.path)), before);
  assert.deepEqual(receipts(f), original);
  const post = child(
    f,
    `const a=LocalSqliteAuthority.open(config),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let armed=false;
    DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)')armed=true;return prepare.call(this,sql);};
    DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(armed&&sql==='COMMIT')process.exit(43);return result;};a.rolloverReceipts({operationId:'committed'});`,
  );
  assert.equal(post.status, 43, post.stderr);
  const after = sha(readFileSync(f.path)),
    done = f.authority.rolloverReceipts({ operationId: 'committed' });
  assert.equal(done.receiptCount, original.length);
  assert.equal(sha(readFileSync(f.path)), after);
  assert.deepEqual(f.authority.rolloverReceipts({ operationId: 'committed' }), done);
});

test('real competing process cannot enter rollover while the selected set is guarded', (t) => {
  const f = fixture(t);
  fill(f);
  const prepare = DatabaseSync.prototype.prepare;
  let attempts = 0;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql === 'INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)') {
        attempts++;
        const other = child(
          f,
          `const a=LocalSqliteAuthority.open(config);assert.throws(()=>a.rolloverReceipts({operationId:'contender'}),/ANCHOR_BUSY/);a.close();console.log('REFUSED');`,
        );
        assert.equal(other.status, 0, other.stderr);
        assert.match(other.stdout, /REFUSED/);
      }
      return prepare.call(this, sql);
    };
    f.authority.rolloverReceipts({ operationId: 'winner' });
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(attempts, 1);
  assert.equal(f.authority.inspectCapacity().receiptStorage!.segments.count, 1);
});

test('row and segment limits bind new work while an existing receipt remains available at the segment ceiling', (t) => {
  const f = fixture(t, 8388608);
  fill(f, 280);
  const original = receipts(f);
  const result = f.authority.rolloverReceipts({ operationId: 'bounded', maxReceipts: 256 });
  assert.equal(result.receiptCount, 256);
  const after = receipts(f);
  assert.deepEqual(
    after.map((r) => [r.vault_id, r.operation_id]),
    original.map((r) => [r.vault_id, r.operation_id]),
  );
  for (const row of after)
    if (!(row.receipt as string).startsWith(RECEIPT_POINTER_PREFIX))
      assert.deepEqual(
        row,
        original.find((r) => r.vault_id === row.vault_id && r.operation_id === row.operation_id),
      );
  assert.equal(f.authority.inspectCapacity().receiptStorage!.hot.count, 25);
  // Structural ceiling fixture only: it is not evidence of 128 legal historical rollovers.
  database(f.path, (db) => {
    const row = db.prepare('SELECT * FROM receipt_segments').get()!;
    for (let i = 1; i < 128; i++)
      db.prepare('INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)').run(
        `structural-${i}`,
        row.request!,
        row.digest!,
        row.decoded_bytes!,
        row.encoded_bytes!,
        row.entry_count!,
        row.json_bytes!,
        row.payload!,
      );
  });
  const before = sha(readFileSync(f.path));
  assert.deepEqual(f.authority.rolloverReceipts({ operationId: 'bounded', maxReceipts: 256 }), result);
  assert.throws(() => f.authority.rolloverReceipts({ operationId: 'full' }), /ANCHOR_ROLLOVER_SEGMENT_LIMIT/);
  assert.equal(sha(readFileSync(f.path)), before);
});

test('an archived real compaction operation returns its original receipt and retains conflict fencing', (t) => {
  const f = fixture(t);
  fill(f);
  f.v.close();
  const request = {
    authority: f.authority,
    vaultId: 'vault',
    keys: f.config.keys,
    maxCalls: 4,
    targetDirectory: join(f.root, 'compacted'),
    storageDomain: 'payload',
    operationId: 'compact',
  };
  const result = AnchoredVault.compact(request),
    head = f.authority.inspect('vault');
  f.authority.rolloverReceipts({ operationId: 'archive-compaction' });
  assert.ok(
    (receipts(f).find((r) => r.operation_id === 'compact')!.receipt as string).startsWith(RECEIPT_POINTER_PREFIX),
  );
  assert.deepEqual(AnchoredVault.compact(request), result);
  assert.deepEqual(
    f.authority.transaction((tx) => tx.receipt('vault', 'compact')),
    result,
  );
  assert.throws(
    () => AnchoredVault.compact({ ...request, targetDirectory: join(f.root, 'conflict') }),
    /ANCHOR_OPERATION_CONFLICT/,
  );
  assert.deepEqual(f.authority.inspect('vault'), head);
});

for (const phase of ['deleted', 'partial-insert', 'before-blob'] as const)
  test(`real process death at ${phase} restores every original key and JSON`, (t) => {
    const f = fixture(t);
    fill(f);
    f.v.close();
    const before = sha(readFileSync(f.path)),
      original = receipts(f);
    const crashed = child(
      f,
      `const a=LocalSqliteAuthority.open(config),prepare=DatabaseSync.prototype.prepare;let inserts=0;
    DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipts VALUES (?,?,?)'){inserts++;if((${JSON.stringify(phase)}==='deleted'&&inserts===1)||(${JSON.stringify(phase)}==='partial-insert'&&inserts===3))process.exit(44);}
      if(${JSON.stringify(phase)}==='before-blob'&&sql==='INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)')process.exit(44);return prepare.call(this,sql);};
    a.rolloverReceipts({operationId:'partial'});`,
    );
    assert.equal(crashed.status, 44, crashed.stderr);
    LocalSqliteAuthority.open(f.authorityConfig).close();
    assert.equal(sha(readFileSync(f.path)), before);
    assert.deepEqual(receipts(f), original);
    assert.equal(f.authority.inspectCapacity().receiptStorage!.segments.count, 0);
  });

test('actual legacy import/admission receipts survive archived lookup with lineage and Safety unchanged', (t) => {
  const f = fixture(t);
  fill(f, 30);
  const source = join(f.root, 'legacy');
  mkdirSync(source);
  const key = randomBytes(32);
  const legacy = new DurableMemory(
    { directory: source, identity: '合成 legacy', keyBase64: key.toString('base64') },
    4,
    { clock },
  );
  t.after(() => legacy.close());
  const scope = legacy.store.ensureScope(who),
    ref = legacy.store.acceptEvent(scope, event);
  legacy.store.revoke(scope, ref);
  legacy.claim('delivered', 'p');
  legacy.reserve('delivered');
  legacy.terminal('delivered', 'ready', 'delivery');
  legacy.terminal('delivered', 'taken', 'delivery');
  legacy.terminal('delivered', 'acknowledged', 'delivery');
  legacy.consumeFeedback('delivery');
  legacy.claim('pending', 'p');
  legacy.reserve('pending');
  const backup = join(f.root, 'legacy-backup');
  legacy.exportBackup(backup);
  const inspect = {
    backupDirectory: backup,
    legacyKey: key,
    identity: '合成 legacy',
    expectedMaxCalls: 4,
    declaredHead: legacy.head,
    trust: { policy: 'trusted-lower-bound' as const, minimumHead: legacy.head },
  };
  const inspected = inspectLegacyM2(inspect),
    newStorageDEK = randomBytes(32);
  const request = {
    ...inspect,
    sourceFreeze: inspected.sourceFreeze,
    authority: f.authority,
    vaultId: 'legacy',
    targetDirectory: join(f.root, 'imported'),
    storageDomain: 'payload',
    storageProfile: 'blocks-br4-v1' as const,
    newStorageDEK,
    operationId: inspected.migrationId,
  };
  const original = AnchoredVault.importLegacyM2(request),
    keys = { version: 2 as const, keyEpoch: 1, storageDEK: newStorageDEK, ingressKey: key };
  const beforeSource = sourceFiles(source),
    beforeBackup = sourceFiles(backup),
    head = f.authority.inspect('legacy'),
    registry = f.authority.transaction((tx) => tx.legacy(inspected.lineageId));
  f.authority.rolloverReceipts({ operationId: 'with-legacy' });
  const archived = database(
    f.path,
    (db) =>
      db
        .prepare('SELECT receipt FROM receipts WHERE vault_id=? AND operation_id=?')
        .get('legacy', inspected.migrationId)!.receipt as string,
  );
  assert.ok(archived.startsWith(RECEIPT_POINTER_PREFIX));
  assert.deepEqual(
    f.authority.transaction((tx) => tx.receipt('legacy', inspected.migrationId)),
    original,
  );
  assert.deepEqual(
    f.authority.transaction((tx) => tx.legacy(inspected.lineageId)),
    registry,
  );
  assert.deepEqual(f.authority.inspect('legacy'), head);
  assert.deepEqual(AnchoredVault.importLegacyM2(request), original);
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...request, targetDirectory: join(f.root, 'other-import') }),
    /LEGACY_LINEAGE_CONSUMED/,
  );
  const v = AnchoredVault.open(
    {
      directory: request.targetDirectory,
      authority: f.authority,
      keys,
      vaultId: 'legacy',
      identity: '合成 legacy',
      storageDomain: 'payload',
      storageProfile: 'blocks-br4-v1',
    },
    4,
    { clock },
  );
  t.after(() => v.close());
  assert.throws(() => v.claim('denied', 'p'), /LEGACY_ADMISSION_REQUIRED/);
  const admission = {
    migrationId: inspected.migrationId,
    head: f.authority.inspect('legacy')!.head!,
    operationId: 'admit',
    operatorId: '合成 operator',
    attestation: 'operator-attested-stopped' as const,
  };
  const admitted = f.authority.admitLegacyImport(admission);
  assert.deepEqual(f.authority.admitLegacyImport(admission), admitted);
  assert.throws(
    () => f.authority.admitLegacyImport({ ...admission, operatorId: 'other' }),
    /LEGACY_ADMISSION_CONFLICT/,
  );
  assert.equal(v.reserved, 2);
  assert.throws(() => v.claim('pending', 'p'), /INTERACTION_TERMINATED/);
  assert.throws(() => v.consumeFeedback('delivery'), /DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
  assert.equal(v.store.revocationHighWater(), 1);
  assert.deepEqual(v.store.acceptEvent(v.store.scope(scope.id), event), { ...ref, currentStatus: 'revoked' });
  assert.deepEqual(sourceFiles(source), beforeSource);
  assert.deepEqual(sourceFiles(backup), beforeBackup);
});

test('rollover leaves an existing durable retrieval consumer and current source capability unchanged', (t) => {
  const f = fixture(t),
    store = f.v.store,
    scope = store.ensureScope(who),
    ref = store.acceptEvent(scope, event),
    job = store.beginJob(scope, [ref]),
    lease = store.claimLease(scope, job.id);
  store.propose(scope, job.id, lease.token, {
    kind: 'claim',
    statement: '合成紫罗兰',
    basis: 'self_report',
    validFrom: null,
    validTo: null,
  });
  store.publish(scope, job.id, lease.token);
  const handle = store.registerConsumer('retrieval', scope, 'retrieval-refs-v1'),
    service = new RetrievalService(store),
    binding = service.bindConsumer(handle);
  service.refresh(binding);
  const candidate = service.query(binding, { text: '紫罗兰' }).candidate,
    head = f.v.head,
    consumer = store.consumerStatus('retrieval');
  fill(f, 30);
  const before = untouched(f),
    snapshot = safety(f);
  f.authority.rolloverReceipts({ operationId: 'retrieval' });
  assert.deepEqual(untouched(f), before);
  assert.deepEqual(safety(f), snapshot);
  assert.deepEqual(store.consumerStatus('retrieval'), consumer);
  assert.ok(service.resolve(binding, candidate));
  assert.equal(f.v.head.ownerEpoch, head.ownerEpoch);
  store.revoke(scope, ref);
  assert.throws(() => service.resolve(binding, candidate));
});
