import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredFault, LegacyImportRequest } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import type { AuthorityTransaction } from '../src/local-sqlite-authority.ts';
import { DurableMemory } from '../src/durable-memory.ts';
import { captureLegacyM2, inspectLegacyM2 } from '../src/legacy-m2-import.ts';
import { directoryReader, reconstruct } from '../src/incremental-storage.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { makeHead, readAuthority, readCheckpoint, seal, sha } from '../src/durable-codec.ts';
import type { Safety } from '../src/durable-codec.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'test' };
const event = {
  source: 'synthetic',
  eventKey: 'one',
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: 'SYNTHETIC_LEGACY_VIOLET',
    occurredAt: null,
  },
};
const clock = { wall: () => 100, monotonic: () => 0 };
function files(path: string) {
  return readdirSync(path)
    .sort()
    .map((name) => ({ name, hash: sha(readFileSync(join(path, name))) }));
}
function fixture(t: TestContext, upgrade = true, identity = '合成用户:legacy') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aemc-legacy-import-'))),
    source = join(root, 'source');
  mkdirSync(source);
  const legacyKey = randomBytes(32);
  const legacyConfig = { directory: source, identity, keyBase64: legacyKey.toString('base64') },
    legacy = new DurableMemory(legacyConfig, 4, { clock });
  const scope = legacy.store.ensureScope(who),
    ref = legacy.store.acceptEvent(scope, event);
  legacy.store.revoke(scope, ref);
  legacy.claim('delivered', 'payload');
  legacy.reserve('delivered');
  legacy.terminal('delivered', 'ready', 'delivery');
  legacy.terminal('delivered', 'taken', 'delivery');
  legacy.terminal('delivered', 'acknowledged', 'delivery');
  legacy.consumeFeedback('delivery');
  legacy.claim('unfinished', 'payload2');
  legacy.reserve('unfinished');
  const backup = join(root, 'backup');
  legacy.exportBackup(backup);
  const authorityConfig = {
    directory: join(root, 'authority'),
    authorityId: 'authority',
    custodyDomain: 'independent',
  };
  let authority = LocalSqliteAuthority.create(authorityConfig);
  if (upgrade) {
    authority.close();
    LocalSqliteAuthority.upgradeSchema(authorityConfig, 'operator-attested-stopped');
    authority = LocalSqliteAuthority.open(authorityConfig);
  }
  const inspectRequest = {
    backupDirectory: backup,
    legacyKey,
    identity,
    expectedMaxCalls: 4,
    declaredHead: legacy.head,
    trust: { policy: 'trusted-lower-bound' as const, minimumHead: legacy.head },
  };
  const inspection = inspectLegacyM2(inspectRequest),
    newStorageDEK = randomBytes(32);
  const request: LegacyImportRequest = {
    ...inspectRequest,
    sourceFreeze: inspection.sourceFreeze,
    authority,
    vaultId: 'destination',
    targetDirectory: join(root, 'imported'),
    storageDomain: 'payload',
    storageProfile: 'blocks-br4-v1',
    newStorageDEK,
    operationId: inspection.migrationId,
  };
  const keys = { version: 2 as const, keyEpoch: 1, storageDEK: newStorageDEK, ingressKey: legacyKey };
  const config = {
    directory: request.targetDirectory,
    authority,
    keys,
    vaultId: request.vaultId,
    identity,
    storageDomain: 'payload',
    storageProfile: 'blocks-br4-v1' as const,
  };
  t.after(() => {
    legacy.close();
    authority.close();
  });
  return {
    root,
    source,
    backup,
    legacy,
    legacyKey,
    legacyConfig,
    scope,
    ref,
    authorityConfig,
    authority,
    inspectRequest,
    inspection,
    request,
    keys,
    config,
  };
}
function database(path: string, body: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try {
    body(db);
  } finally {
    db.close();
  }
}
function ledger(image: Uint8Array) {
  const db = new DatabaseSync(':memory:');
  try {
    db.deserialize(image);
    return db.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()!.value;
  } finally {
    db.close();
  }
}
const admission = (f: ReturnType<typeof fixture>, head = f.authority.inspect(f.config.vaultId)!.head!) => ({
  migrationId: f.inspection.migrationId,
  head,
  operationId: 'admission',
  operatorId: '合成操作者',
  attestation: 'operator-attested-stopped' as const,
});

test('inspection canonicalizes declared/lower heads and preserves exact frozen package and source bytes', (t) => {
  const f = fixture(t),
    before = files(f.backup),
    source = files(f.source),
    head = f.inspectRequest.declaredHead;
  const reordered = {
    identity: head.identity,
    authoritySha256: head.authoritySha256,
    sequence: head.sequence,
    format: head.format,
    version: head.version,
  };
  assert.deepEqual(
    inspectLegacyM2({
      ...f.inspectRequest,
      declaredHead: reordered,
      trust: { minimumHead: reordered, policy: 'trusted-lower-bound' },
    }),
    f.inspection,
  );
  assert.equal(f.inspection.latestProven, false);
  assert.equal(f.inspection.legacyCopiesFenced, false);
  assert.equal(f.inspection.consumedRequests, 2);
  const snapshotOnly = inspectLegacyM2({ ...f.inspectRequest, trust: { policy: 'declared-snapshot-only' } });
  assert.equal(snapshotOnly.lineageId, f.inspection.lineageId);
  assert.notDeepEqual(snapshotOnly.sourceFreeze.trust, f.inspection.sourceFreeze.trust);
  assert.deepEqual(files(f.backup), before);
  assert.deepEqual(files(f.source), source);
});
test('actual v3 import preserves key/ledger/quota/revocation, defaults closed and admits only by exact-head CAS', (t) => {
  const f = fixture(t),
    packageBefore = files(f.backup),
    sourceBefore = files(f.source),
    oldImage = f.legacy.store.snapshot();
  const receipt = AnchoredVault.importLegacyM2(f.request);
  assert.deepEqual(AnchoredVault.importLegacyM2(f.request), receipt);
  assert.equal(receipt.kind, 'legacy-m2-import');
  assert.equal(receipt.legacyImport!.latestProven, false);
  assert.equal(receipt.legacyImport!.legacyCopiesFenced, false);
  assert.equal(receipt.legacyImport!.quotaScope, 'this-authority-only');
  const genesis = reconstruct(receipt.newHead, directoryReader(f.config.directory), f.keys, 4);
  assert.equal(ledger(genesis.image), ledger(oldImage));
  assert.ok(genesis.image.equals(oldImage));
  assert.equal(genesis.state.safety.reserved, 2);
  assert.deepEqual(
    genesis.state.safety.ingress.map((e) => e.state),
    ['acknowledged', 'unknown'],
  );
  assert.equal(genesis.state.safety.ingress[0]!.feedbackConsumed, true);
  assert.equal(genesis.state.safety.lastAcknowledgedDeliveryId, null);
  assert.equal(genesis.state.revocationHighWater, 1);
  assert.equal(genesis.baseline.depth, 1);
  assert.throws(
    () => reconstruct(receipt.newHead, directoryReader(f.config.directory), { ...f.keys, storageDEK: f.legacyKey }, 4),
    /INCREMENTAL_CORRUPT/,
  );
  const v = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => v.close());
  const before = v.head,
    allBefore = files(f.config.directory),
    authorityBefore = files(f.authority.directory);
  assert.throws(() => v.claim('new', 'payload'), /LEGACY_ADMISSION_REQUIRED/);
  assert.throws(() => v.reserve('unfinished'), /LEGACY_ADMISSION_REQUIRED/);
  assert.deepEqual(v.head, before);
  assert.deepEqual(files(f.config.directory), allBefore);
  assert.deepEqual(files(f.authority.directory), authorityBefore);
  assert.throws(() => f.authority.admitLegacyImport(admission(f, receipt.newHead)), /ANCHOR_FENCED/);
  const admitted = f.authority.admitLegacyImport({ ...admission(f), version: 9, extra: 'ignored' } as any);
  assert.deepEqual(f.authority.admitLegacyImport(admission(f)), admitted);
  assert.equal(admitted.legacyCopiesFenced, false);
  assert.equal(admitted.version, 1);
  assert.equal('extra' in admitted, false);
  assert.throws(() => v.claim('unfinished', 'payload2'), /INTERACTION_TERMINATED/);
  assert.throws(() => v.consumeFeedback('delivery'), /DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
  v.claim('third', 'p');
  v.reserve('third');
  v.claim('fourth', 'p');
  v.reserve('fourth');
  v.claim('fifth', 'p');
  assert.throws(() => v.reserve('fifth'), /REQUEST_BUDGET_EXHAUSTED/);
  assert.deepEqual(files(f.backup), packageBefore);
  assert.deepEqual(files(f.source), sourceBefore);
  // Honest limitation: the legacy instance still independently accepts work.
  f.legacy.claim('legacy-only', 'p');
  f.legacy.reserve('legacy-only');
  assert.equal(f.legacy.status.consumedRequests, 3);
  assert.deepEqual(f.authority.transaction((tx) => tx.legacy(f.inspection.lineageId))!.importReceipt, receipt);
});
test('inconsistent persistent ACTIVE registry and admission receipts fail closed without vault mutations', (t) => {
  const f = fixture(t);
  AnchoredVault.importLegacyM2(f.request);
  const v = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => v.close());
  const path = join(f.authority.directory, 'authority.sqlite');
  const read = () => {
    let state = '';
    database(path, (db) => {
      state = db.prepare('SELECT state FROM legacy_imports').get()!.state as string;
    });
    return state;
  };
  const write = (state: string) =>
    database(path, (db) => {
      db.prepare('UPDATE legacy_imports SET state=?').run(state);
    });
  const reject = (original: string, mutate: (value: any) => void) => {
    const value = JSON.parse(original);
    mutate(value);
    write(JSON.stringify(value));
    const before = files(f.config.directory),
      authority = files(f.authority.directory);
    assert.throws(() => v.claim('never', 'p'), /LEGACY_REGISTRY/);
    assert.throws(() => v.reserve('unfinished'), /LEGACY_REGISTRY/);
    assert.deepEqual(files(f.config.directory), before);
    assert.deepEqual(files(f.authority.directory), authority);
    write(original);
  };
  const required = read();
  reject(required, (v) => {
    v.importReceipt = null;
  });
  reject(required, (v) => {
    v.importReceipt.requestDigest = 'a'.repeat(64);
  });
  reject(required, (v) => {
    v.admission = 'admitted';
  });
  reject(required, (v) => {
    v.admissionReceipt = { version: 1 };
  });
  f.authority.admitLegacyImport(admission(f));
  const admitted = read();
  reject(admitted, (v) => {
    v.admissionReceipt.requestDigest = 'a'.repeat(64);
  });
  reject(admitted, (v) => {
    v.admissionReceipt.legacyCopiesFenced = true;
  });
  reject(admitted, (v) => {
    v.admissionReceipt.head.vaultId = 'different';
  });
  reject(admitted, (v) => {
    v.admission = 'required';
  });
  assert.equal(v.status.consumedRequests, 2);
});
test('persistent PREPARED registry must match the corresponding import intent and cannot be pre-admitted', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      AnchoredVault.importLegacyM2({
        ...f.request,
        fault: (p) => {
          if (p === 'prepared') throw new Error('stop');
        },
      }),
    /stop/,
  );
  const path = join(f.authority.directory, 'authority.sqlite');
  let original = '';
  database(path, (db) => {
    original = db.prepare('SELECT state FROM legacy_imports').get()!.state as string;
  });
  for (const mutate of [
    (v: any) => {
      v.admission = 'admitted';
    },
    (v: any) => {
      v.requestDigest = 'a'.repeat(64);
    },
    (v: any) => {
      v.importReceipt = { version: 2 };
    },
  ]) {
    const value = JSON.parse(original);
    mutate(value);
    database(path, (db) => {
      db.prepare('UPDATE legacy_imports SET state=?').run(JSON.stringify(value));
    });
    assert.throws(() => f.authority.transaction((tx) => tx.legacy(f.inspection.lineageId)), /LEGACY_REGISTRY/);
    database(path, (db) => {
      db.prepare('UPDATE legacy_imports SET state=?').run(original);
    });
  }
  assert.equal(
    AnchoredVault.reconcile({
      authority: f.authority,
      vaultId: f.config.vaultId,
      operationId: f.inspection.migrationId,
      keys: f.keys,
      maxCalls: 4,
    }).kind,
    'legacy-m2-import',
  );
});
test('source changes, wrong key/tip/trust and key reuse refuse before target creation', (t) => {
  const f = fixture(t);
  assert.throws(() => inspectLegacyM2({ ...f.inspectRequest, legacyKey: randomBytes(32) }), /DURABLE_/);
  assert.throws(
    () => inspectLegacyM2({ ...f.inspectRequest, declaredHead: { ...f.inspectRequest.declaredHead, sequence: 1 } }),
    /LEGACY_DECLARED_HEAD|DURABLE_/,
  );
  assert.throws(() => inspectLegacyM2({ ...f.inspectRequest, trust: undefined as any }), /LEGACY_TRUST_REQUIRED/);
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...f.request, newStorageDEK: f.legacyKey }),
    /LEGACY_KEY_SEPARATION/,
  );
  assert.throws(
    () =>
      AnchoredVault.importLegacyM2({
        ...f.request,
        sourceFreeze: { ...f.request.sourceFreeze, packageDigest: '0'.repeat(64) },
      }),
    /LEGACY_SOURCE_CHANGED/,
  );
  assert.throws(() => AnchoredVault.importLegacyM2({ ...f.request, operationId: 'different' }), /LEGACY_OPERATION/);
  assert.equal(existsSync(f.config.directory), false);
  const path = join(f.backup, 'manifest.json'),
    original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
  assert.throws(() => AnchoredVault.importLegacyM2(f.request), /LEGACY_SOURCE_CHANGED/);
  writeFileSync(path, original);
  assert.throws(() => AnchoredVault.importLegacyM2({ ...f.request, vaultId: '目的地' }), /ANCHOR_ID/);
});
test('global lineage blocks later prefixes, forks, different vaults and target requests without releasing the slot', (t) => {
  const f = fixture(t);
  AnchoredVault.importLegacyM2(f.request);
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...f.request, vaultId: 'second', targetDirectory: join(f.root, 'second') }),
    /LEGACY_LINEAGE_CONSUMED/,
  );
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...f.request, targetDirectory: join(f.root, 'other') }),
    /LEGACY_LINEAGE_CONSUMED/,
  );
  const fork = join(f.root, 'fork');
  cpSync(f.source, fork, { recursive: true });
  f.legacy.claim('later', 'p');
  const later = join(f.root, 'later');
  f.legacy.exportBackup(later);
  const nextRequest = { ...f.inspectRequest, backupDirectory: later, declaredHead: f.legacy.head },
    next = inspectLegacyM2(nextRequest);
  assert.equal(next.lineageId, f.inspection.lineageId);
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...f.request, ...nextRequest, sourceFreeze: next.sourceFreeze }),
    /LEGACY_LINEAGE_CONSUMED/,
  );
  const branch = new DurableMemory({ ...f.legacyConfig, directory: fork }, 4, { clock });
  try {
    branch.claim('forked', 'p');
    const b = join(f.root, 'fork-backup');
    branch.exportBackup(b);
    const ir = { ...f.inspectRequest, backupDirectory: b, declaredHead: branch.head },
      ins = inspectLegacyM2(ir);
    assert.equal(ins.lineageId, f.inspection.lineageId);
    assert.throws(
      () => AnchoredVault.importLegacyM2({ ...f.request, ...ir, sourceFreeze: ins.sourceFreeze }),
      /LEGACY_LINEAGE_CONSUMED/,
    );
  } finally {
    branch.close();
  }
});
test('authority upgrade is explicit, atomic, preserves old rows and expires old handles/capabilities', (t) => {
  const f = fixture(t, false);
  assert.throws(() => AnchoredVault.importLegacyM2(f.request), /LEGACY_AUTHORITY_UPGRADE_REQUIRED/);
  assert.equal(existsSync(f.config.directory), false);
  const cfg = {
    directory: join(f.root, 'ordinary'),
    vaultId: 'ordinary',
    identity: 'synthetic',
    storageDomain: 'payload',
    keys: generateKeySet(),
    authority: f.authority,
  };
  const v = AnchoredVault.create(cfg, 2, { clock });
  v.claim('one', 'p');
  v.close();
  let old: unknown;
  database(join(f.authority.directory, 'authority.sqlite'), (db) => {
    old = ['metadata', 'vaults', 'receipts'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
  });
  let captured: AuthorityTransaction | undefined;
  f.authority.transaction((tx) => {
    captured = tx;
  });
  for (const point of ['after-table', 'after-version'] as const) {
    assert.throws(
      () =>
        LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped', (p) => {
          if (p === point) throw new Error('FAULT');
        }),
      /FAULT/,
    );
    assert.ok(f.authority.inspect('ordinary'));
  }
  assert.deepEqual(LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped'), {
    from: 2,
    to: 3,
    alreadyCurrent: false,
  });
  assert.throws(() => f.authority.inspect('ordinary'), /ANCHOR_SCHEMA_CHANGED/);
  assert.throws(() => captured!.row('ordinary'), /ANCHOR_TRANSACTION_EXPIRED/);
  database(join(f.authority.directory, 'authority.sqlite'), (db) =>
    assert.deepEqual(
      ['metadata', 'vaults', 'receipts'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()),
      old,
    ),
  );
  assert.deepEqual(LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped'), {
    from: 3,
    to: 3,
    alreadyCurrent: true,
  });
  const authority = LocalSqliteAuthority.open(f.authorityConfig);
  t.after(() => authority.close());
  assert.equal(AnchoredVault.importLegacyM2({ ...f.request, authority }).kind, 'legacy-m2-import');
});
test('authority upgrade refuses PREPARED without changes and succeeds after explicit reconciliation', (t) => {
  const f = fixture(t, false);
  let armed = false;
  const cfg = {
    directory: join(f.root, 'pending'),
    vaultId: 'pending',
    identity: 'synthetic',
    storageDomain: 'payload',
    keys: generateKeySet(),
    authority: f.authority,
  };
  const v = AnchoredVault.create(cfg, 2, {
    clock,
    fault: (p) => {
      if (armed && p === 'prepared') throw new Error('FAULT');
    },
  });
  armed = true;
  assert.throws(() => v.claim('one', 'p'), /FAULT|ANCHOR_WRITE_FAILED/);
  v.close();
  const before = f.authority.inspect('pending')!;
  assert.throws(
    () => LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped'),
    /ANCHOR_CAPACITY_PENDING/,
  );
  assert.deepEqual(f.authority.inspect('pending'), before);
  AnchoredVault.reconcile({
    authority: f.authority,
    vaultId: 'pending',
    operationId: before.pending!.operationId,
    keys: cfg.keys,
    maxCalls: 2,
  });
  const active = f.authority.inspect('pending');
  LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped');
  const authority = LocalSqliteAuthority.open(f.authorityConfig);
  t.after(() => authority.close());
  assert.deepEqual(authority.inspect('pending'), active);
});

test('global pending fences new legacy admission while idempotent admitted receipts remain readable', (t) => {
  const f = fixture(t);
  AnchoredVault.importLegacyM2(f.request);
  const v = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => v.close());
  let armed = false;
  const cfg = {
    directory: join(f.root, 'ordinary-pending'),
    vaultId: 'ordinary-pending',
    identity: 'synthetic',
    storageDomain: 'payload',
    keys: generateKeySet(),
    authority: f.authority,
  };
  let ordinary = AnchoredVault.create(cfg, 2, {
    clock,
    fault: (p) => {
      if (armed && p === 'prepared') throw Error('SYNTHETIC_STOP');
    },
  });
  t.after(() => ordinary.close());
  armed = true;
  assert.throws(() => ordinary.claim('one', 'p'), /SYNTHETIC_STOP|ANCHOR_WRITE_FAILED/);
  ordinary.close();
  const before = files(f.authority.directory),
    request = admission(f);
  assert.throws(() => f.authority.admitLegacyImport(request), /ANCHOR_CAPACITY_PENDING/);
  assert.deepEqual(files(f.authority.directory), before);
  let pending = f.authority.inspect(cfg.vaultId)!.pending!;
  AnchoredVault.reconcile({
    authority: f.authority,
    vaultId: cfg.vaultId,
    operationId: pending.operationId,
    keys: cfg.keys,
    maxCalls: 2,
  });
  const admitted = f.authority.admitLegacyImport(request);
  armed = false;
  ordinary = AnchoredVault.open(cfg, 2, {
    clock,
    fault: (p) => {
      if (armed && p === 'prepared') throw Error('SYNTHETIC_STOP');
    },
  });
  armed = true;
  assert.throws(() => ordinary.claim('two', 'p'), /SYNTHETIC_STOP|ANCHOR_WRITE_FAILED/);
  ordinary.close();
  assert.deepEqual(f.authority.admitLegacyImport(request), admitted);
  pending = f.authority.inspect(cfg.vaultId)!.pending!;
  AnchoredVault.reconcile({
    authority: f.authority,
    vaultId: cfg.vaultId,
    operationId: pending.operationId,
    keys: cfg.keys,
    maxCalls: 2,
  });
});

test('legacy admission over a lower write limit refuses with registry and historical receipt bytes preserved', (t) => {
  const f = fixture(t);
  AnchoredVault.importLegacyM2(f.request);
  const v = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => v.close());
  database(join(f.authority.directory, 'authority.sqlite'), (db) => {
    const receipt = JSON.parse(db.prepare('SELECT receipt FROM receipts LIMIT 1').get()!.receipt as string);
    db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(
      'historical-fixture',
      'padding',
      JSON.stringify({ ...receipt, padding: 'x'.repeat(65536) }),
    );
  });
  const limited = LocalSqliteAuthority.open({ ...f.authorityConfig, writeLimitBytes: 65536 });
  t.after(() => limited.close());
  const before = files(f.authority.directory);
  assert.throws(() => limited.admitLegacyImport(admission(f)), /ANCHOR_CAPACITY/);
  assert.deepEqual(files(f.authority.directory), before);
  assert.equal(f.authority.transaction((tx) => tx.legacy(f.inspection.lineageId))!.admission, 'required');
});

test('legacy import capacity refusal rolls back both lineage registration and proposed PREPARED', (t) => {
  // A legal 128-character identity grows the completed registry past one page
  // without lengthening filesystem paths. Padding leaves PREPARED at 64 KiB.
  const f = fixture(t, true, '界'.repeat(128)),
    padding = 24576,
    writeLimitBytes = 65536,
    path = join(f.authority.directory, 'authority.sqlite');
  database(path, (db) =>
    db
      .prepare('INSERT INTO receipts VALUES (?,?,?)')
      .run('historical-fixture', 'padding', JSON.stringify({ synthetic: true, padding: 'x'.repeat(padding) })),
  );
  const limited = LocalSqliteAuthority.open({ ...f.authorityConfig, writeLimitBytes });
  t.after(() => limited.close());
  const before = files(f.authority.directory),
    beforeBytes = readFileSync(path),
    prepare = DatabaseSync.prototype.prepare;
  let registration = 0,
    completion = 0,
    preparedBytes = 0,
    previewBytes = 0;
  try {
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql),
        db = this;
      if (
        sql === 'INSERT INTO legacy_imports VALUES (?,?,?,?)' ||
        sql.startsWith('INSERT INTO vaults ') ||
        sql === 'INSERT INTO receipts VALUES (?,?,?)'
      ) {
        const run = statement.run;
        statement.run = function (...args) {
          const result = Reflect.apply(run, this, args);
          const bytes =
            (prepare.call(db, 'PRAGMA page_count').get()!.page_count as number) *
            (prepare.call(db, 'PRAGMA page_size').get()!.page_size as number);
          if (sql === 'INSERT INTO legacy_imports VALUES (?,?,?,?)') registration++;
          else if (sql.startsWith('INSERT INTO vaults ')) preparedBytes = bytes;
          else {
            completion++;
            previewBytes = bytes;
          }
          return result;
        };
      }
      return statement;
    };
    assert.throws(() => AnchoredVault.importLegacyM2({ ...f.request, authority: limited }), /ANCHOR_CAPACITY/);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(registration, 1);
  assert.equal(completion, 1, 'execute the future-finalization receipt INSERT');
  assert.ok(preparedBytes > 0 && preparedBytes <= writeLimitBytes);
  assert.ok(previewBytes > writeLimitBytes);
  assert.deepEqual(files(f.authority.directory), before);
  assert.deepEqual(readFileSync(path), beforeBytes);
  assert.equal(limited.inspect(f.config.vaultId), null);
  assert.equal(
    limited.transaction((tx) => tx.legacy(f.inspection.lineageId)),
    null,
  );
  t.diagnostic(
    `import capacity refusal: target-bytes=${Buffer.byteLength(f.request.targetDirectory)}, padding=${padding}, registered-in-transaction=${registration}, prepared-bytes=${preparedBytes}, preview-insert=${completion}, preview-bytes=${previewBytes}, limit=${writeLimitBytes}`,
  );
});
test('unknown authority layouts are refused rather than repaired or implicitly upgraded', (t) => {
  const f = fixture(t, false);
  f.authority.close();
  database(join(f.authority.directory, 'authority.sqlite'), (db) => db.exec('CREATE TABLE unexpected(id INTEGER)'));
  assert.throws(
    () => LocalSqliteAuthority.upgradeSchema(f.authorityConfig, 'operator-attested-stopped'),
    /ANCHOR_IDENTITY/,
  );
  assert.throws(() => LocalSqliteAuthority.open(f.authorityConfig), /ANCHOR_IDENTITY/);
});
for (const point of [
  'stage-written',
  'prepared',
  'checkpoint-published',
  'record-published',
  'finalized',
] as AnchoredFault[])
  test(`import ${point} fault preserves its exact pre-prepare, pending or active state`, (t) => {
    const f = fixture(t),
      source = files(f.source),
      pack = files(f.backup);
    assert.throws(
      () =>
        AnchoredVault.importLegacyM2({
          ...f.request,
          fault: (p) => {
            if (p === point) throw new Error('FAULT');
          },
        }),
      /FAULT/,
    );
    const registered = f.authority.transaction((tx) => tx.legacy(f.inspection.lineageId));
    if (point === 'stage-written') {
      assert.equal(registered, null);
      assert.equal(f.authority.inspect(f.config.vaultId), null);
      assert.throws(() => AnchoredVault.open(f.config, 4), /ANCHOR_UNREGISTERED/);
    } else if (point !== 'finalized') {
      assert.equal(registered!.status, 'PREPARED');
      assert.throws(() => AnchoredVault.importLegacyM2(f.request), /ANCHOR_PENDING/);
      assert.throws(() => AnchoredVault.open(f.config, 4), /ANCHOR_PENDING/);
      const pending = f.authority.inspect(f.config.vaultId)!.pending!,
        stage = readFileSync(pending.stagePath);
      writeFileSync(pending.stagePath, Buffer.from('bad'));
      const rr = {
        authority: f.authority,
        vaultId: f.config.vaultId,
        operationId: f.inspection.migrationId,
        keys: f.keys,
        maxCalls: 4,
      };
      assert.throws(() => AnchoredVault.reconcile(rr), /ANCHOR_UNRESOLVED/);
      writeFileSync(pending.stagePath, stage);
      renameSync(f.backup, f.backup + '-retained');
      const receipt = AnchoredVault.reconcile(rr);
      assert.deepEqual(AnchoredVault.reconcile(rr), receipt);
      assert.equal(f.authority.transaction((tx) => tx.legacy(f.inspection.lineageId))!.status, 'ACTIVE');
      assert.deepEqual(files(f.backup + '-retained'), pack);
    } else assert.equal(registered!.status, 'ACTIVE');
    assert.deepEqual(files(f.source), source);
  });
test('schema2 migration and required/admitted lineage survive compaction, rekey and restore', (t) => {
  const f = fixture(t);
  AnchoredVault.importLegacyM2({ ...f.request, targetSchema: 2 });
  let config = { ...f.config, schemaVersion: 2 as const },
    v = AnchoredVault.open(config, 4, { clock });
  t.after(() => v.close());
  assert.equal(v.store.diagnostics().schema, 2);
  const compact = join(f.root, 'compact');
  AnchoredVault.compact({
    authority: f.authority,
    vaultId: config.vaultId,
    keys: config.keys,
    maxCalls: 4,
    targetDirectory: compact,
    storageDomain: 'payload',
    operationId: 'compact',
  });
  v.close();
  config = { ...config, directory: compact };
  v = AnchoredVault.open(config, 4, { clock });
  assert.throws(() => v.claim('new', 'p'), /LEGACY_ADMISSION_REQUIRED/);
  f.authority.admitLegacyImport(admission(f, v.head));
  const backup = join(f.root, 'v3-backup');
  v.exportBackup(backup);
  const target = join(f.root, 'rekey'),
    dek = randomBytes(32);
  AnchoredVault.rekeyBackup({
    backupDirectory: backup,
    targetDirectory: target,
    storageDomain: 'payload',
    authority: f.authority,
    keys: config.keys,
    newStorageDEK: dek,
    maxCalls: 4,
    operationId: 'rekey',
  });
  v.close();
  config = { ...config, directory: target, keys: { ...config.keys, storageDEK: dek, keyEpoch: 2 } };
  v = AnchoredVault.open(config, 4, { clock });
  const b2 = join(f.root, 'v3-b2');
  v.exportBackup(b2);
  const restored = join(f.root, 'restored');
  AnchoredVault.restoreBackup({
    backupDirectory: b2,
    targetDirectory: restored,
    storageDomain: 'payload',
    authority: f.authority,
    keys: config.keys,
    maxCalls: 4,
    operationId: 'restore',
  });
  v.close();
  config = { ...config, directory: restored };
  v = AnchoredVault.open(config, 4, { clock });
  assert.deepEqual(v.head.legacyImport, { lineageId: f.inspection.lineageId, migrationId: f.inspection.migrationId });
  v.claim('new', 'p');
  v.reserve('new');
  assert.equal(v.reserved, 3);
  assert.throws(() => v.claim('unfinished', 'payload2'), /INTERACTION_TERMINATED/);
});
test('missing registry cannot turn an imported vault into an ordinary admitted vault', (t) => {
  const f = fixture(t);
  AnchoredVault.importLegacyM2(f.request);
  database(join(f.authority.directory, 'authority.sqlite'), (db) => db.exec('DELETE FROM legacy_imports'));
  const before = files(f.config.directory);
  assert.throws(() => AnchoredVault.open(f.config, 4, { clock }), /LEGACY_REGISTRY/);
  assert.deepEqual(
    files(f.config.directory).filter((f) => f.name !== 'writer.sqlite'),
    before,
  );
});
test('claimed/quarantine namespaces are rejected for source or target including ancestors', (t) => {
  const f = fixture(t),
    ancestor = join(f.root, 'M2.restore-quarantine.v1-reserved');
  mkdirSync(ancestor);
  const b = join(ancestor, 'backup');
  cpSync(f.backup, b, { recursive: true });
  assert.throws(() => inspectLegacyM2({ ...f.inspectRequest, backupDirectory: b }), /LEGACY_RESERVED_NAMESPACE/);
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...f.request, targetDirectory: join(ancestor, 'target') }),
    /LEGACY_RESERVED_NAMESPACE/,
  );
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...f.request, targetDirectory: join(f.source, 'target') }),
    /LEGACY_RESERVED_NAMESPACE/,
  );
  AnchoredVault.importLegacyM2(f.request);
  const v = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => v.close());
  const backup = join(f.root, 'anchored-backup');
  v.exportBackup(backup);
  const before = v.head;
  const request = {
    authority: f.authority,
    keys: f.keys,
    maxCalls: 4,
    storageDomain: 'payload',
    operationId: 'reserved-target',
    targetDirectory: join(ancestor, 'cutover'),
  };
  assert.throws(() => AnchoredVault.compact({ ...request, vaultId: f.config.vaultId }), /LEGACY_RESERVED_NAMESPACE/);
  assert.throws(
    () => AnchoredVault.restoreBackup({ ...request, backupDirectory: backup }),
    /LEGACY_RESERVED_NAMESPACE/,
  );
  assert.throws(
    () => AnchoredVault.rekeyBackup({ ...request, backupDirectory: backup, newStorageDEK: randomBytes(32) }),
    /LEGACY_RESERVED_NAMESPACE/,
  );
  assert.throws(() => AnchoredVault.open({ ...f.config, directory: b }, 4), /LEGACY_RESERVED_NAMESPACE/);
  assert.deepEqual(v.head, before);
  assert.equal(existsSync(request.targetDirectory), false);
  const { storageProfile: _profile, ...base } = f.config;
  const ordinary = { ...base, vaultId: 'ordinary-v2', directory: join(f.root, 'ordinary-v2'), keys: generateKeySet() };
  const v2 = AnchoredVault.create(ordinary, 4, { clock });
  v2.close();
  const reopened = AnchoredVault.open(ordinary, 4, { clock });
  assert.equal(reopened.head.format, 'companion-anchored-vault-v2');
  reopened.close();
});
function forgeSafety(f: ReturnType<typeof fixture>, mutate: (s: Safety) => void) {
  const db = new DatabaseSync(':memory:');
  try {
    db.deserialize(readFileSync(join(f.backup, 'authority.sqlite')));
    const chain = readAuthority(db, f.legacyKey, f.request.identity, 4),
      a = chain.latest!;
    const image = readCheckpoint(readFileSync(join(f.backup, 'checkpoint.bin')), a, f.legacyKey, f.request.identity);
    mutate(a.safety);
    const checkpoint = seal(
      {
        version: 1,
        identity: a.identity,
        sequence: a.sequence,
        image: image.toString('base64'),
        safety: a.safety,
        revocationHighWater: a.revocationHighWater,
      },
      'checkpoint',
      f.legacyKey,
    );
    image.fill(0);
    a.sha256 = sha(checkpoint);
    const row = seal(a, 'authority', f.legacyKey);
    db.prepare('UPDATE entries SET sealed=? WHERE sequence=?').run(row, a.sequence);
    const authority = db.serialize(),
      head = makeHead(a.identity, a.sequence, sha(row));
    const path = join(f.backup, 'manifest.json'),
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.head = head;
    manifest.files[0].bytes = authority.length;
    manifest.files[0].sha256 = sha(authority);
    manifest.files[1].bytes = checkpoint.length;
    manifest.files[1].sha256 = sha(checkpoint);
    writeFileSync(join(f.backup, 'authority.sqlite'), authority);
    writeFileSync(join(f.backup, 'checkpoint.bin'), checkpoint);
    writeFileSync(path, JSON.stringify(manifest));
    return head;
  } finally {
    db.close();
  }
}
test('strict new Safety compatibility is checked before unfinished entries become UNKNOWN', (t) => {
  for (const mutate of [
    (s: Safety) => {
      s.ingress[1]!.state = 'ready';
      s.ingress[1]!.deliveryId = null;
    },
    (s: Safety) => {
      s.ingress[1]!.deliveryId = s.ingress[0]!.deliveryId;
    },
    (s: Safety) => {
      s.ingress[1]!.reserved = false;
    },
  ]) {
    const f = fixture(t),
      declaredHead = forgeSafety(f, mutate);
    assert.throws(
      () => inspectLegacyM2({ ...f.inspectRequest, declaredHead, trust: { policy: 'declared-snapshot-only' } }),
      /ANCHOR_CORRUPT/,
    );
    assert.equal(existsSync(f.config.directory), false);
  }
});
test('explicit snapshot-only import records weaker trust without claiming latest or fencing', (t) => {
  const f = fixture(t),
    request = { ...f.inspectRequest, trust: { policy: 'declared-snapshot-only' as const } },
    inspection = inspectLegacyM2(request);
  const receipt = AnchoredVault.importLegacyM2({ ...f.request, ...request, sourceFreeze: inspection.sourceFreeze });
  assert.equal(receipt.legacyImport!.sourceFreeze.trust.policy, 'declared-snapshot-only');
  assert.equal(receipt.legacyImport!.latestProven, false);
  assert.equal(receipt.legacyImport!.legacyCopiesFenced, false);
});
const childScript = `import {AnchoredVault} from './src/anchored-vault.ts';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';
  let chunks=[];for await(const c of process.stdin)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks).toString());
  const authority=LocalSqliteAuthority.open(data.authority),request={...data.request,authority,legacyKey:Buffer.from(data.request.legacyKey,'base64'),newStorageDEK:Buffer.from(data.request.newStorageDEK,'base64')};
  if(data.wait){process.send('ready');await new Promise(resolve=>process.once('message',resolve));}
  try{const result=AnchoredVault.importLegacyM2({...request,fault:p=>{if(p===data.crash)process.exit(42);}});process.stdout.write(JSON.stringify({ok:true,vaultId:result.newHead.vaultId}));}
  catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code??error.message}));process.exitCode=3;}
  finally{authority.close();if(process.connected)process.disconnect();}`;
function wire(f: ReturnType<typeof fixture>, request: LegacyImportRequest = f.request) {
  return {
    authority: f.authorityConfig,
    request: {
      ...request,
      authority: undefined,
      legacyKey: Buffer.from(request.legacyKey).toString('base64'),
      newStorageDEK: Buffer.from(request.newStorageDEK).toString('base64'),
    },
  };
}
test('two actual processes contend for one lineage; exactly one destination becomes registered', async (t) => {
  const f = fixture(t),
    requests = [f.request, { ...f.request, vaultId: 'other-vault', targetDirectory: join(f.root, 'other-vault') }];
  const children = requests.map((request) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let output = '',
      error = '';
    child.stdout!.on('data', (c) => {
      output += c;
    });
    child.stderr!.on('data', (c) => {
      error += c;
    });
    let ready = false;
    const waiting = new Promise<void>((resolve, reject) => {
      child.once('message', () => {
        ready = true;
        resolve();
      });
      child.once('error', reject);
      child.once('close', () => {
        if (!ready) reject(new Error(error));
      });
    });
    const done = new Promise<{ exit: number | null; output: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exit) => resolve({ exit, output }));
    });
    child.stdin!.end(JSON.stringify({ ...wire(f, request), wait: true }));
    return { child, waiting, done };
  });
  await Promise.all(children.map((c) => c.waiting));
  for (const child of children) child.child.send('go');
  const results = await Promise.all(children.map((c) => c.done));
  assert.equal(results.filter((r) => r.exit === 0).length, 1);
  assert.equal(results.filter((r) => r.exit === 3).length, 1);
  const loser = results.findIndex((r) => r.exit === 3);
  assert.match(JSON.parse(results[loser]!.output).code, /ANCHOR_BUSY|LEGACY_LINEAGE_CONSUMED/);
  assert.throws(() => AnchoredVault.importLegacyM2(requests[loser]!), /LEGACY_LINEAGE_CONSUMED/);
  database(join(f.authority.directory, 'authority.sqlite'), (db) => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM legacy_imports').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM vaults').get()!.n, 1);
  });
});
test('real process exit after import PREPARED retains the lineage slot and reconciles without re-reading the package', (t) => {
  const f = fixture(t),
    result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
      input: JSON.stringify({ ...wire(f), crash: 'prepared' }),
    });
  assert.equal(result.status, 42, result.stderr);
  assert.equal(f.authority.transaction((tx) => tx.legacy(f.inspection.lineageId))!.status, 'PREPARED');
  renameSync(f.backup, f.backup + '-preserved');
  const receipt = AnchoredVault.reconcile({
    authority: f.authority,
    vaultId: f.config.vaultId,
    operationId: f.inspection.migrationId,
    keys: f.keys,
    maxCalls: 4,
  });
  assert.equal(receipt.legacyImport!.lineageId, f.inspection.lineageId);
  const v = AnchoredVault.open(f.config, 4, { clock });
  t.after(() => v.close());
  assert.throws(() => v.claim('new', 'p'), /LEGACY_ADMISSION_REQUIRED/);
});
