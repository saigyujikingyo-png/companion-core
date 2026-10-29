import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  Dir,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import type { AuthorityTransaction, PendingCommit } from '../src/local-sqlite-authority.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredFault } from '../src/anchored-vault.ts';
import { ANCHORED_FORMAT, decodeStage, generateKeySet, identityOf, sealV2 } from '../src/anchored-codec.ts';
import { directoryReader, reconstruct } from '../src/incremental-storage.ts';
import { CAPACITY_DIRECTORY_ENTRY_LIMIT } from '../src/capacity-types.ts';
import { DurableMemory } from '../src/durable-memory.ts';
import { inspectLegacyM2 } from '../src/legacy-m2-import.ts';
import { sha } from '../src/durable-codec.ts';

function fixture(t: TestContext, schemaVersion: 1 | 2 = 1, incremental = false) {
  let wall = 100,
    clockCalls = 0,
    fault: ((point: AnchoredFault) => void) | undefined;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aemc-if7-')));
  const authorityConfig = {
    directory: join(root, 'authority'),
    authorityId: 'synthetic',
    custodyDomain: 'independent',
  };
  const authority = LocalSqliteAuthority.create(authorityConfig),
    keys = generateKeySet();
  const config = {
    directory: join(root, 'vault'),
    vaultId: 'vault',
    identity: 'synthetic',
    storageDomain: 'payload',
    authority,
    keys,
    schemaVersion,
    ...(incremental ? { storageProfile: 'blocks-br4-v1' as const } : {}),
  };
  const v = AnchoredVault.create(config, 4, {
    clock: {
      wall: () => {
        clockCalls++;
        return wall;
      },
      monotonic: () => 0,
    },
    fault: (point) => fault?.(point),
  });
  const request = { authority, vaultId: 'vault', keys, maxCalls: 4 };
  t.after(() => {
    v.close();
    authority.close();
  });
  return {
    root,
    authorityConfig,
    authority,
    keys,
    config,
    v,
    request,
    setWall: (n: number) => {
      wall = n;
    },
    clockCalls: () => clockCalls,
    setFault: (next: (point: AnchoredFault) => void) => {
      fault = next;
    },
  };
}
function files(directory: string) {
  return readdirSync(directory)
    .sort()
    .map((name) => ({ name, bytes: readFileSync(join(directory, name)) }));
}
function database<T>(path: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}
function decoded(f: ReturnType<typeof fixture>) {
  const head = f.authority.inspect('vault')!.head!;
  return head.format === ANCHORED_FORMAT
    ? decodeStage(
        Buffer.from(
          JSON.stringify({
            format: ANCHORED_FORMAT,
            head,
            checkpoint: readFileSync(join(head.directory, `checkpoint-${head.sequence}.bin`)).toString('base64'),
            record: readFileSync(join(head.directory, `record-${head.sequence}.bin`)).toString('base64'),
          }),
        ),
        f.keys,
        4,
      )
    : reconstruct(head, directoryReader(head.directory), f.keys, 4);
}
const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'test' };
const event = {
  source: 'synthetic',
  eventKey: 'one',
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: 'SYNTHETIC_PRIVATE_BODY',
    occurredAt: null,
  },
};

test('capacity APIs inspect an ACTIVE v2 vault without changing bytes or its head', (t) => {
  const f = fixture(t),
    source = files(f.config.directory),
    authority = files(f.authority.directory),
    head = f.v.head,
    calls = f.clockCalls();
  const report = AnchoredVault.inspectCapacity(f.request);
  assert.equal(report.status, 'ACTIVE');
  assert.equal(report.detailsRead, true);
  assert.deepEqual(report.currentHead, head);
  assert.deepEqual(report.authority, f.authority.inspectCapacity());
  assert.equal(
    report.generation!.directory.totalBytes,
    source.reduce((n, file) => n + file.bytes.length, 0),
  );
  assert.equal(report.authority.database.fileBytes, statSync(join(f.authority.directory, 'authority.sqlite')).size);
  assert.deepEqual(files(f.config.directory), source);
  assert.deepEqual(files(f.authority.directory), authority);
  assert.equal(f.clockCalls(), calls);
  assert.equal(report.image!.fanout.applicable, false);
  assert.equal(report.authority.legacyRegistry.applicable, false);
  const snapshot = decoded(f);
  try {
    assert.equal(
      report.generation!.requiredChain.encodedBytes,
      Buffer.byteLength(snapshot.stage.record, 'base64') +
        ('checkpoint' in snapshot.stage ? Buffer.byteLength(snapshot.stage.checkpoint, 'base64') : 0),
    );
  } finally {
    snapshot.image.fill(0);
  }
});

test('authority reports independent SQLite counts, UTF-8 receipt bytes, freelist and actual lower write limit', (t) => {
  const f = fixture(t),
    path = join(f.authority.directory, 'authority.sqlite');
  database(path, (db) => {
    db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('synthetic', 'unicode', JSON.stringify({ label: '合成😀' }));
    db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('synthetic', 'retired-padding', 'x'.repeat(32768));
    db.prepare('DELETE FROM receipts WHERE vault_id=? AND operation_id=?').run('synthetic', 'retired-padding');
  });
  const limited = LocalSqliteAuthority.open({ ...f.authorityConfig, writeLimitBytes: 65536 });
  t.after(() => limited.close());
  const before = files(f.authority.directory),
    report = limited.inspectCapacity();
  database(path, (db) => {
    const rows = db.prepare('SELECT receipt FROM receipts').all();
    assert.equal(report.receipts.count, rows.length);
    assert.equal(
      report.receipts.jsonUtf8Bytes,
      rows.reduce((n, row) => n + Buffer.byteLength(row.receipt as string), 0),
    );
    assert.ok(report.receipts.jsonUtf8Bytes > rows.reduce((n, row) => n + (row.receipt as string).length, 0));
    assert.equal(report.database.pageCount, db.prepare('PRAGMA page_count').get()!.page_count);
    assert.equal(report.database.pageSize, db.prepare('PRAGMA page_size').get()!.page_size);
    assert.equal(report.database.freelistPages, db.prepare('PRAGMA freelist_count').get()!.freelist_count);
  });
  assert.ok(report.database.freelistPages > 0);
  assert.equal(report.limits.writeLimitBytes, 65536);
  assert.equal(report.limits.readLimitBytes, 67108864);
  assert.equal(report.totalFileBytes, report.database.fileBytes);
  assert.equal(report.sidecars.totalBytes, 0);
  assert.deepEqual(files(f.authority.directory), before);
  f.v.close();
  f.authority.close();
  LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped');
  const upgraded = LocalSqliteAuthority.open(f.authorityConfig);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.inspectCapacity().legacyRegistry, { applicable: true, count: 0 });
});

test('v3 schema2 inspection preserves TTL, epochs, journal, Safety and private data across repeated reads', (t) => {
  const f = fixture(t, 2, true),
    s = f.v.store,
    scope = s.ensureScope(who),
    sourceRef = s.acceptEvent(scope, event),
    job = s.beginJob(scope, [sourceRef]),
    lease = s.claimLease(scope, job.id);
  s.propose(scope, job.id, lease.token, {
    kind: 'belief',
    statement: 'SYNTHETIC_PRIVATE_DERIVED',
    basis: 'inference',
    validFrom: null,
    validTo: 200,
  });
  s.publish(scope, job.id, lease.token);
  const consumer = s.registerConsumer('synthetic-consumer', scope, 'scene-source-refs-v1');
  s.applyConsumers([consumer]);
  f.v.claim('still-pending', 'SYNTHETIC_PRIVATE_REQUEST');
  f.v.reserve('still-pending');
  f.v.claim('unknown', 'p');
  f.v.terminal('unknown', 'unknown');
  const before = decoded(f),
    source = files(f.config.directory),
    authority = files(f.authority.directory),
    calls = f.clockCalls();
  f.setWall(300);
  try {
    const first = AnchoredVault.inspectCapacity(f.request),
      second = AnchoredVault.inspectCapacity(f.request);
    assert.deepEqual(second, first);
    assert.equal(f.clockCalls(), calls);
    assert.equal(first.status, 'ACTIVE');
    if (first.status !== 'ACTIVE') assert.fail();
    assert.equal(first.image.bytes, before.image.byteLength);
    assert.equal(first.safety.ingressCount, 2);
    assert.equal(first.safety.unknownCount, 1);
    assert.equal(first.safety.reserved, 1);
    assert.equal(first.image.fanout.applicable, true);
    if (!first.image.fanout.applicable) assert.fail();
    const fanout = first.image.fanout;
    database(':memory:', (db) => {
      db.deserialize(before.image);
      for (const [table, count] of Object.entries(first.image.rows))
        assert.equal(count, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
      assert.equal(fanout.counts.batches, db.prepare('SELECT count(*) AS n FROM fanout_batches').get()!.n);
      assert.equal(fanout.counts.items, db.prepare('SELECT count(*) AS n FROM fanout_items').get()!.n);
      assert.equal(fanout.counts.consumers, 1);
      assert.equal(fanout.counts.projectionRows, 2);
      assert.equal(
        fanout.counts.projectionJsonUtf8Bytes,
        db
          .prepare('SELECT metadata FROM fanout_projection')
          .all()
          .reduce((n, row) => n + Buffer.byteLength(row.metadata as string), 0),
      );
    });
    assert.equal(first.generation.requiredChain.frames, 'baseline' in before ? before.baseline.depth : 0);
    assert.equal(first.generation.requiredChain.encodedBytes, 'baseline' in before ? before.baseline.readBytes : 0);
    const text = JSON.stringify(first);
    for (const privateValue of [
      'SYNTHETIC_PRIVATE_BODY',
      'SYNTHETIC_PRIVATE_DERIVED',
      sourceRef.id,
      consumer.id,
      ...before.state.safety.ingress.map((entry) => entry.key),
    ])
      assert.equal(text.includes(privateValue), false);
    const after = decoded(f);
    try {
      assert.deepEqual(after.image, before.image);
      assert.deepEqual(after.state.safety, before.state.safety);
    } finally {
      after.image.fill(0);
    }
    assert.deepEqual(files(f.config.directory), source);
    assert.deepEqual(files(f.authority.directory), authority);
  } finally {
    before.image.fill(0);
  }
});

test('a capacity-poisoned ACTIVE handle remains inspectable above the lower soft limit without boot', (t) => {
  const f = fixture(t, 2, true),
    path = join(f.authority.directory, 'authority.sqlite');
  f.v.claim('pending', 'p');
  f.v.reserve('pending');
  const low = LocalSqliteAuthority.open({ ...f.authorityConfig, writeLimitBytes: 65536 });
  t.after(() => low.close());
  f.v.close();
  const live = AnchoredVault.open({ ...f.config, authority: low }, 4, {
    clock: { wall: () => 100, monotonic: () => 0 },
  });
  t.after(() => live.close());
  database(path, (db) =>
    db
      .prepare('INSERT INTO receipts VALUES (?,?,?)')
      .run('historical-fixture', 'padding', JSON.stringify({ synthetic: true, padding: 'x'.repeat(70000) })),
  );
  const before = low.inspect('vault');
  assert.throws(() => live.claim('refused', 'p'), /ANCHOR_CAPACITY/);
  assert.throws(() => live.claim('still-poisoned', 'p'), /ANCHOR_UNAVAILABLE/);
  const source = files(f.config.directory),
    authority = files(f.authority.directory),
    report = AnchoredVault.inspectCapacity({ ...f.request, authority: low });
  assert.equal(report.status, 'ACTIVE');
  assert.deepEqual(report.currentHead, before!.head);
  assert.ok(report.authority.blockers.includes('CURRENT_EXTENT_OVER_WRITE_LIMIT'));
  assert.equal(report.safety!.ingressCount, 1);
  assert.deepEqual(files(f.config.directory), source);
  assert.deepEqual(files(f.authority.directory), authority);
});

test('PREPARED never reads missing old/new payload or stage and UNREGISTERED creates nothing', (t) => {
  const f = fixture(t, 2, true);
  f.setFault((point) => {
    if (point === 'prepared') throw Error('SYNTHETIC_STOP');
  });
  assert.throws(() => f.v.claim('stop', 'p'), /ANCHOR_WRITE_FAILED/);
  const pending = f.authority.inspect('vault')!.pending!;
  database(join(f.authority.directory, 'authority.sqlite'), (db) => {
    const row = JSON.parse(db.prepare('SELECT state FROM vaults WHERE vault_id=?').get('vault')!.state as string);
    row.pending.extraPrivateBody = 'SYNTHETIC_PRIVATE_PENDING';
    row.pending.newHead.extraPrivateBody = 'SYNTHETIC_PRIVATE_HEAD';
    db.prepare('UPDATE vaults SET state=? WHERE vault_id=?').run(JSON.stringify(row), 'vault');
  });
  f.v.close();
  renameSync(f.config.directory, f.config.directory + '-retained');
  const before = files(f.authority.directory),
    root = readdirSync(f.root);
  const report = AnchoredVault.inspectCapacity(f.request);
  assert.equal(report.status, 'PREPARED');
  assert.equal(report.currentHead, null);
  assert.equal(report.detailsRead, false);
  assert.equal(report.pending!.proposedSequence, pending.newHead.sequence);
  assert.equal(report.generation, null);
  assert.ok(report.authority.blockers.includes('GLOBAL_PENDING'));
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_PRIVATE'), false);
  const absent = AnchoredVault.inspectCapacity({ ...f.request, vaultId: 'unregistered' });
  assert.equal(absent.status, 'UNREGISTERED');
  assert.equal(absent.detailsRead, false);
  assert.equal(absent.currentHead, null);
  assert.deepEqual(readdirSync(f.root), root);
  assert.deepEqual(files(f.authority.directory), before);
});

test('an authenticated frame containing a bad image is rejected by the no-boot image validator', (t) => {
  const f = fixture(t),
    head = f.v.head,
    prior = decoded(f),
    identity = identityOf(head);
  f.v.close();
  const image = database(':memory:', (db) => {
    db.deserialize(prior.image);
    db.exec('CREATE TABLE synthetic_unknown(id INTEGER)');
    return db.serialize();
  });
  try {
    const sequence = head.sequence + 1,
      operationId = randomUUID(),
      checkpoint = sealV2(
        { ...prior.state, sequence, image: Buffer.from(image).toString('base64') },
        'checkpoint',
        identity,
        f.keys.storageDEK,
      );
    const record = sealV2(
      {
        version: 2,
        identity,
        sequence,
        operationId,
        previous: head.digest,
        parentHead: null,
        checkpointDigest: sha(checkpoint),
        revocationHighWater: prior.state.revocationHighWater,
      },
      'record',
      identity,
      f.keys.storageDEK,
    );
    const next = { ...identity, sequence, digest: sha(record) },
      bytes = Buffer.from(
        JSON.stringify({
          format: ANCHORED_FORMAT,
          head: next,
          checkpoint: checkpoint.toString('base64'),
          record: record.toString('base64'),
        }),
      ),
      stagePath = join(head.directory, `stage-${operationId}.json`);
    writeFileSync(stagePath, bytes, { flag: 'wx' });
    f.authority.transaction((tx) => {
      const pending: PendingCommit = {
        version: 2,
        kind: 'write',
        operationId,
        requestDigest: sha(bytes),
        oldHead: head,
        newHead: next,
        stagePath,
        stageDigest: sha(bytes),
      };
      tx.prepare(pending);
      writeFileSync(join(head.directory, `checkpoint-${sequence}.bin`), checkpoint, { flag: 'wx' });
      writeFileSync(join(head.directory, `record-${sequence}.bin`), record, { flag: 'wx' });
      tx.finalize(pending);
    });
    const source = files(f.config.directory),
      authority = files(f.authority.directory);
    assert.throws(() => AnchoredVault.inspectCapacity(f.request), /SCHEMA_MISMATCH/);
    assert.deepEqual(files(f.config.directory), source);
    assert.deepEqual(files(f.authority.directory), authority);
  } finally {
    prior.image.fill(0);
    image.fill(0);
  }
});

test('legacy capacity inspection preserves required admission and never converts its Safety or registry', (t) => {
  const f = fixture(t);
  f.v.close();
  f.authority.close();
  LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped');
  const authority = LocalSqliteAuthority.open(f.authorityConfig);
  t.after(() => authority.close());
  const directory = join(f.root, 'legacy');
  mkdirSync(directory);
  const legacyKey = randomBytes(32),
    legacy = new DurableMemory({ directory, identity: '合成 legacy', keyBase64: legacyKey.toString('base64') }, 4, {
      clock: { wall: () => 100, monotonic: () => 0 },
    });
  t.after(() => legacy.close());
  legacy.claim('unfinished', 'synthetic');
  legacy.reserve('unfinished');
  const backupDirectory = join(f.root, 'legacy-backup');
  legacy.exportBackup(backupDirectory);
  const inspectionRequest = {
      backupDirectory,
      legacyKey,
      identity: '合成 legacy',
      expectedMaxCalls: 4,
      declaredHead: legacy.head,
      trust: { policy: 'trusted-lower-bound' as const, minimumHead: legacy.head },
    },
    inspection = inspectLegacyM2(inspectionRequest),
    storageDEK = randomBytes(32),
    targetDirectory = join(f.root, 'imported');
  AnchoredVault.importLegacyM2({
    ...inspectionRequest,
    sourceFreeze: inspection.sourceFreeze,
    authority,
    vaultId: 'imported',
    targetDirectory,
    storageDomain: 'payload',
    storageProfile: 'blocks-br4-v1',
    newStorageDEK: storageDEK,
    operationId: inspection.migrationId,
  });
  const before = files(authority.directory),
    source = files(targetDirectory),
    registry = authority.transaction((tx) => tx.legacy(inspection.lineageId));
  const report = AnchoredVault.inspectCapacity({
    authority,
    vaultId: 'imported',
    keys: { version: 2, keyEpoch: 1, storageDEK, ingressKey: legacyKey },
    maxCalls: 4,
  });
  assert.equal(report.status, 'ACTIVE');
  assert.equal(report.legacyAdmission, 'required');
  assert.ok(report.blockers.includes('LEGACY_ADMISSION_REQUIRED'));
  assert.equal(report.safety!.unknownCount, 1);
  assert.equal(report.safety!.reserved, 1);
  assert.deepEqual(report.authority.legacyRegistry, { applicable: true, count: 1 });
  assert.deepEqual(
    authority.transaction((tx) => tx.legacy(inspection.lineageId)),
    registry,
  );
  assert.deepEqual(files(authority.directory), before);
  assert.deepEqual(files(targetDirectory), source);
});

test('authority file replacement is OS-refused on Windows or detected before inspection on POSIX', (t) => {
  const f = fixture(t),
    path = join(f.authority.directory, 'authority.sqlite'),
    bytes = readFileSync(path),
    source = files(f.config.directory);
  if (process.platform === 'win32') {
    assert.throws(() => renameSync(path, path + '.retained'), /EBUSY|EPERM/);
    assert.equal(AnchoredVault.inspectCapacity(f.request).status, 'ACTIVE');
    assert.deepEqual(readFileSync(path), bytes);
  } else {
    renameSync(path, path + '.retained');
    writeFileSync(path, bytes, { flag: 'wx' });
    assert.throws(() => AnchoredVault.inspectCapacity(f.request), /ANCHOR_REPLACED/);
    assert.deepEqual(readFileSync(path), bytes);
  }
  assert.deepEqual(files(f.config.directory), source);
});

test('another vault pending allows ACTIVE diagnostics without consuming its completion reservation', (t) => {
  const f = fixture(t, 1, true);
  let armed = false;
  const other = AnchoredVault.create({ ...f.config, directory: join(f.root, 'other'), vaultId: 'other' }, 4, {
    fault: (point) => {
      if (armed && point === 'prepared') throw Error('SYNTHETIC_STOP');
    },
  });
  t.after(() => other.close());
  armed = true;
  assert.throws(() => other.claim('stop', 'p'), /ANCHOR_WRITE_FAILED/);
  const before = files(f.authority.directory),
    head = f.authority.inspect('vault')!.head;
  const report = AnchoredVault.inspectCapacity(f.request);
  assert.equal(report.status, 'ACTIVE');
  assert.deepEqual(report.currentHead, head);
  assert.ok(report.authority.blockers.includes('GLOBAL_PENDING'));
  assert.deepEqual(files(f.authority.directory), before);
});

test('directory scanning reports exact totals or explicit lower bounds with a strictly lower budget', (t) => {
  const f = fixture(t, 1, true);
  writeFileSync(join(f.config.directory, 'synthetic-retained-note'), Buffer.from('not disposable garbage'));
  const before = files(f.config.directory),
    full = AnchoredVault.inspectCapacity(f.request),
    readSync = Dir.prototype.readSync;
  const observedSizes: number[] = [];
  let partial: ReturnType<typeof AnchoredVault.inspectCapacity>;
  try {
    Dir.prototype.readSync = function () {
      const entry = readSync.call(this);
      if (this.path === f.config.directory && entry !== null)
        observedSizes.push(statSync(join(f.config.directory, entry.name)).size);
      return entry;
    };
    partial = AnchoredVault.inspectCapacity({ ...f.request, directoryEntryLimit: 1 });
  } finally {
    Dir.prototype.readSync = readSync;
  }
  assert.equal(observedSizes.length, 1);
  assert.equal(full.generation!.directory.complete, true);
  assert.equal(full.generation!.directory.totalEntries, before.length);
  assert.equal(
    full.generation!.directory.totalBytes,
    before.reduce((n, x) => n + x.bytes.length, 0),
  );
  const scan = partial.generation!.directory;
  assert.equal(scan.complete, false);
  assert.equal(scan.entriesObserved, 1);
  assert.equal(scan.totalEntries, null);
  assert.equal(scan.totalBytes, null);
  assert.ok(Number.isSafeInteger(scan.observedBytes) && scan.observedBytes >= 0);
  assert.equal(scan.observedBytes, observedSizes[0]);
  assert.ok(scan.observedBytes <= full.generation!.directory.totalBytes!);
  assert.equal(partial.generation!.otherGenerationsAndBackups, 'unmeasured');
  assert.deepEqual(files(f.config.directory), before);
  assert.throws(() => {
    (full as any).currentHead.sequence = 0;
  }, TypeError);
  assert.throws(() => {
    (full as any).authority.blockers.push('READY');
  }, TypeError);
  assert.deepEqual(AnchoredVault.inspectCapacity(f.request), full);
});

for (const firstBytes of [0, 17])
  test(`bounded directory scan measures a real ${firstBytes}-byte first file without reading a second entry`, (t) => {
    const f = fixture(t, 1, true),
      name = `synthetic-first-${firstBytes}`;
    writeFileSync(join(f.config.directory, name), Buffer.alloc(firstBytes, 97));
    const selected = readdirSync(f.config.directory, { withFileTypes: true }).find((entry) => entry.name === name)!;
    assert.equal(selected.isFile(), true);
    const before = files(f.config.directory),
      authority = files(f.authority.directory),
      full = AnchoredVault.inspectCapacity(f.request),
      readSync = Dir.prototype.readSync;
    let reads = 0,
      partial: ReturnType<typeof AnchoredVault.inspectCapacity>;
    try {
      Dir.prototype.readSync = function () {
        if (this.path !== f.config.directory) return readSync.call(this);
        assert.equal(++reads, 1, 'entryLimit=1 must not request another directory entry');
        return selected;
      };
      partial = AnchoredVault.inspectCapacity({ ...f.request, directoryEntryLimit: 1 });
    } finally {
      Dir.prototype.readSync = readSync;
    }
    assert.equal(reads, 1);
    const scan = partial.generation!.directory;
    assert.equal(scan.entriesObserved, 1);
    assert.equal(scan.complete, false);
    assert.equal(scan.totalEntries, null);
    assert.equal(scan.totalBytes, null);
    assert.equal(scan.observedBytes, statSync(join(f.config.directory, name)).size);
    assert.equal(scan.observedBytes, firstBytes);
    assert.ok(scan.observedBytes <= full.generation!.directory.totalBytes!);
    assert.equal(full.generation!.directory.complete, true);
    assert.equal(full.generation!.directory.totalEntries, before.length);
    assert.equal(
      full.generation!.directory.totalBytes,
      before.reduce((n, file) => n + file.bytes.length, 0),
    );
    assert.deepEqual(files(f.config.directory), before);
    assert.deepEqual(files(f.authority.directory), authority);
    assert.deepEqual(AnchoredVault.inspectCapacity(f.request), full);
  });

test('inspection rejects invalid file types in the scanned generation using the existing refusal', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.config.directory, 'unexpected-directory'));
  assert.throws(() => AnchoredVault.inspectCapacity(f.request), /ANCHOR_FILE/);
});

test('request copying rejects getters, proxies, overrides and invalid budgets without invoking user code', (t) => {
  const f = fixture(t),
    before = files(f.authority.directory);
  let invoked = 0;
  const getter = Object.defineProperty({ ...f.request }, 'maxCalls', {
    get() {
      invoked++;
      return 4;
    },
  });
  const proxy = new Proxy(f.request, {
    ownKeys() {
      invoked++;
      return [];
    },
    get() {
      invoked++;
      return undefined;
    },
  });
  const keyGetter = {
    ...f.request,
    keys: Object.defineProperty({ ...f.keys }, 'storageDEK', {
      get() {
        invoked++;
        return f.keys.storageDEK;
      },
    }),
  };
  for (const bad of [
    getter,
    proxy,
    keyGetter,
    { ...f.request, head: f.v.head },
    { ...f.request, targetDirectory: f.root },
    {
      ...f.request,
      keys: new Proxy(f.keys, {
        get() {
          invoked++;
          return null;
        },
      }),
    },
  ])
    assert.throws(() => AnchoredVault.inspectCapacity(bad as any), /INVALID_INPUT/);
  for (const limit of [0, -1, 1.5, NaN, Infinity, CAPACITY_DIRECTORY_ENTRY_LIMIT + 1, null, '1'])
    assert.throws(
      () => AnchoredVault.inspectCapacity({ ...f.request, directoryEntryLimit: limit } as any),
      /INVALID_INPUT/,
    );
  for (const maxCalls of [-1, 1.5, NaN, Infinity, 33, null, '4'])
    assert.throws(() => AnchoredVault.inspectCapacity({ ...f.request, maxCalls } as any), /INVALID_INPUT/);
  assert.equal(invoked, 0);
  assert.deepEqual(files(f.authority.directory), before);
});

test('request fields and key buffers are copied before the actual authority guard', (t) => {
  const f = fixture(t),
    request = { ...f.request },
    original = Buffer.from(f.keys.storageDEK),
    exec = DatabaseSync.prototype.exec;
  let observed = 0;
  try {
    DatabaseSync.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE' && !observed++) {
        request.vaultId = 'different';
        request.maxCalls = 0;
        f.keys.storageDEK.fill(0);
      }
      return result;
    };
    const report = AnchoredVault.inspectCapacity(request);
    assert.equal(report.status, 'ACTIVE');
    assert.equal(report.currentHead!.vaultId, 'vault');
    assert.equal(report.safety!.maxCalls, 4);
  } finally {
    DatabaseSync.prototype.exec = exec;
    f.keys.storageDEK.set(original);
    original.fill(0);
  }
  assert.ok(observed > 0);
  assert.equal(AnchoredVault.inspectCapacity(f.request).status, 'ACTIVE');
});

test('key byte bounds precede index enumeration and valid offset views preserve caller bytes', (t) => {
  const f = fixture(t),
    oversized = new Uint8Array(33),
    shared = new Uint8Array(new SharedArrayBuffer(32)),
    ownKeys = Reflect.ownKeys;
  let rejectedViewEnumerations = 0;
  try {
    Reflect.ownKeys = function (value) {
      if (value === oversized || value === shared) rejectedViewEnumerations++;
      return ownKeys(value);
    };
    for (const storageDEK of [oversized, shared])
      assert.throws(
        () => AnchoredVault.inspectCapacity({ ...f.request, keys: { ...f.keys, storageDEK } }),
        /ANCHOR_KEYSET/,
      );
  } finally {
    Reflect.ownKeys = ownKeys;
  }
  assert.equal(
    rejectedViewEnumerations,
    0,
    'reject invalid byte length/shared buffers before enumerating their indices',
  );
  const backing = new Uint8Array(48);
  backing.fill(173);
  backing.set(f.keys.storageDEK, 8);
  const original = Buffer.from(backing),
    storageDEK = backing.subarray(8, 40);
  assert.equal(AnchoredVault.inspectCapacity({ ...f.request, keys: { ...f.keys, storageDEK } }).status, 'ACTIVE');
  assert.deepEqual(Buffer.from(backing), original);
});

for (const incremental of [false, true])
  test(`wrong keys and damaged required records refuse without mutation (${incremental ? 'v3' : 'v2'})`, (t) => {
    const f = fixture(t, 1, incremental),
      source = files(f.config.directory),
      authority = files(f.authority.directory),
      key = Buffer.from(f.keys.storageDEK);
    assert.throws(
      () => AnchoredVault.inspectCapacity({ ...f.request, keys: generateKeySet() }),
      /ANCHOR_CORRUPT|INCREMENTAL_CORRUPT/,
    );
    assert.deepEqual(f.keys.storageDEK, key);
    assert.deepEqual(files(f.config.directory), source);
    assert.deepEqual(files(f.authority.directory), authority);
    const path = join(f.config.directory, `record-${f.v.head.sequence}.bin`);
    renameSync(path, path + '.retained');
    assert.throws(() => AnchoredVault.inspectCapacity(f.request), /ENOENT/);
    writeFileSync(path, Buffer.from('SYNTHETIC_CORRUPT'));
    const corrupt = files(f.config.directory);
    assert.throws(() => AnchoredVault.inspectCapacity(f.request), /ANCHOR_CORRUPT|INCREMENTAL_CORRUPT/);
    assert.deepEqual(files(f.config.directory), corrupt);
    assert.deepEqual(files(f.authority.directory), authority);
  });

test('actual compaction selects only the newly authoritative generation while retaining Safety and image counts', (t) => {
  const f = fixture(t, 2, true);
  f.v.claim('pending', 'p');
  f.v.reserve('pending');
  const before = AnchoredVault.inspectCapacity(f.request);
  f.v.close();
  const oldFiles = files(f.config.directory); // Exclude the live writer's normal close/journal cleanup from the observation interval.
  const receipt = AnchoredVault.compact({
    authority: f.authority,
    vaultId: 'vault',
    keys: f.keys,
    maxCalls: 4,
    targetDirectory: join(f.root, 'compacted'),
    storageDomain: 'payload',
    operationId: 'compact',
  });
  const report = AnchoredVault.inspectCapacity(f.request);
  assert.deepEqual(report.currentHead, receipt.newHead);
  assert.equal(report.generation!.sequence, 1);
  assert.deepEqual(report.image, before.image);
  assert.deepEqual(report.safety, before.safety);
  assert.equal(report.generation!.requiredChain.frames, 1);
  assert.deepEqual(files(f.config.directory), oldFiles);
});

test('capacity capability expires, rejects reentry and cannot escape a caught mutation failure', (t) => {
  const f = fixture(t);
  let saved: AuthorityTransaction | undefined;
  f.authority.transaction((tx) => {
    saved = tx;
    assert.equal(tx.capacity().vaults.active, 1);
    assert.throws(() => f.authority.inspectCapacity(), /ANCHOR_TRANSACTION/);
  });
  assert.throws(() => saved!.capacity(), /ANCHOR_TRANSACTION_EXPIRED/);
  const before = files(f.authority.directory),
    head = f.v.head,
    stagePath = join(f.config.directory, 'stage-synthetic.json');
  writeFileSync(stagePath, Buffer.from('synthetic'));
  const pending: PendingCommit = {
    version: 2,
    kind: 'write',
    operationId: 'synthetic',
    requestDigest: sha('synthetic'),
    oldHead: head,
    newHead: { ...head, sequence: head.sequence + 1, digest: sha('synthetic') },
    stagePath,
    stageDigest: sha('synthetic'),
  };
  const prepare = DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql === 'INSERT INTO receipts VALUES (?,?,?)') throw Error('SYNTHETIC_PREVIEW');
      return prepare.call(this, sql);
    };
    assert.throws(
      () =>
        f.authority.transaction((tx) => {
          saved = tx;
          assert.throws(() => tx.prepare(pending), /SYNTHETIC_PREVIEW/);
          assert.throws(() => tx.capacity(), /ANCHOR_TRANSACTION_FAILED/);
        }),
      /ANCHOR_TRANSACTION_FAILED/,
    );
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.throws(() => saved!.capacity(), /ANCHOR_TRANSACTION_EXPIRED/);
  assert.deepEqual(files(f.authority.directory), before);
  assert.equal(f.authority.inspectCapacity().vaults.pending, 0);
});

test('a real competing process cannot begin a write while capacity is measured under the guard', (t) => {
  const f = fixture(t),
    before = files(f.authority.directory),
    prepare = DatabaseSync.prototype.prepare;
  let attempted = 0;
  const script = `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';
    const config=JSON.parse(readFileSync(0,'utf8')),a=LocalSqliteAuthority.open(config);try{assert.throws(()=>a.transaction(()=>assert.fail('writer acquired guard')),/ANCHOR_BUSY/);console.log('WRITER_REFUSED');}finally{a.close();}`;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      const result = prepare.call(this, sql);
      if (sql === 'PRAGMA freelist_count' && !attempted++) {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: process.cwd(),
          input: JSON.stringify(f.authorityConfig),
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        });
        assert.equal(
          child.status,
          0,
          JSON.stringify({ error: child.error?.message, signal: child.signal, stderr: child.stderr }),
        );
        assert.match(child.stdout, /WRITER_REFUSED/);
      }
      return result;
    };
    assert.equal(AnchoredVault.inspectCapacity(f.request).status, 'ACTIVE');
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(attempted, 1);
  assert.deepEqual(files(f.authority.directory), before);
});
