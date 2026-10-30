import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { sha } from '../src/durable-codec.ts';
import type { ShardInput } from '../src/authority-sharded-format.ts';
import { DurableMemory } from '../src/durable-memory.ts';
import { inspectLegacyM2 } from '../src/legacy-m2-import.ts';
import { ColdWorkspace } from '../src/authority-cold-storage.ts';
import { loadShards, inspectShardFiles, obligations } from '../src/authority-sharded-storage.ts';
import { parseReceiptPointer } from '../src/receipt-segments.ts';
import { ShardDatabase, manifest as validateManifest, partition } from '../src/authority-sharded-format.ts';
import type { ShardManifest, ShardMeta } from '../src/authority-sharded-format.ts';
import type { RawRow } from '../src/authority-cold-format.ts';

function fixture(t: TestContext, epochs = 4, writeLimitBytes = 1048576, upgrade = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'authority-v2-'))),
    ac = {
      directory: join(root, 'authority'),
      authorityId: 'synthetic',
      custodyDomain: 'independent',
      writeLimitBytes,
    };
  LocalSqliteAuthority.create(ac).close();
  LocalSqliteAuthority.upgradeSchema(ac, 'operator-attested-stopped');
  LocalSqliteAuthority.upgradeReceiptSchema(ac, 'operator-attested-stopped');
  LocalSqliteAuthority.upgradeColdSchema(ac, 'operator-attested-stopped');
  let authority = LocalSqliteAuthority.open(ac);
  const keys = generateKeySet(),
    config = {
      directory: join(root, 'vault'),
      vaultId: 'vault',
      identity: 'synthetic',
      storageDomain: 'payload',
      storageProfile: 'blocks-br4-v1' as const,
      schemaVersion: 2 as const,
      keys,
      authority,
    };
  let vault = AnchoredVault.create(config, 8, { clock: { wall: () => 100, monotonic: () => 0 } });
  const receipts = [];
  for (let e = 0; e < epochs; e++) {
    for (let i = 0; i < 24; i++) vault.claim(`e${e}-${i}`, 'synthetic');
    receipts.push(authority.archivePermanentKeys({ operationId: `ac1-old-${e}`, expectedRouteEpoch: e }));
  }
  const oldFiles = new Map(
    readdirSync(ac.directory)
      .filter((n) => n.startsWith('cold-slot-'))
      .map((n) => [n, sha(readFileSync(join(ac.directory, n)))]),
  );
  vault.close();
  authority.close();
  if (upgrade) LocalSqliteAuthority.upgradeShardedColdSchema(ac, 'operator-attested-stopped');
  authority = LocalSqliteAuthority.open(ac);
  config.authority = authority;
  vault = AnchoredVault.open(config, 8, { clock: { wall: () => 100, monotonic: () => 0 } });
  t.after(() => {
    vault.close();
    authority.close();
  });
  return { root, ac, authority, config, vault, receipts, oldFiles };
}
function request(f: ReturnType<typeof fixture>, id = 'ac2-next'): ShardInput {
  const c = f.authority.inspectCapacity().shardedColdRouting!;
  return { operationId: id, expectedRouteEpoch: c.generation, expectedManifestDigest: c.manifestDigest };
}
function child(f: ReturnType<typeof fixture>, body: string) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {DatabaseSync} from 'node:sqlite';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const x=JSON.parse(fs.readFileSync(0,'utf8')),a=LocalSqliteAuthority.open(x.config);${body}`,
    ],
    {
      cwd: process.cwd(),
      input: JSON.stringify({ config: f.ac, request: request(f) }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    },
  );
}
function rootBytes(f: ReturnType<typeof fixture>) {
  return readFileSync(join(f.ac.directory, 'authority.sqlite'));
}
function mutableManifest(value: unknown): ShardManifest {
  const copy = structuredClone(value);
  validateManifest(copy);
  return copy;
}

test('schema6 fifth maintenance releases used pages, preserves v1 bytes and exact old M, then fresh process reopens', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.vault.claim('fifth-' + i, 'synthetic');
  const before = f.authority.inspectCapacity(),
    head = f.authority.inspect('vault'),
    r = request(f);
  const result = f.authority.archivePermanentKeysV2(r),
    after = f.authority.inspectCapacity();
  assert.equal(result.toEpoch, 5);
  assert.ok(after.shardedColdRouting!.usedPages < before.shardedColdRouting!.usedPages);
  assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(f.authority.inspect('vault'), head);
  assert.equal(after.shardedColdRouting!.cold.operations, 4);
  assert.equal(after.shardedColdRouting!.hot.operations, 1);
  assert.ok(after.shardedColdRouting!.workspacePeakBytes <= 12582912);
  assert.deepEqual(f.authority.archivePermanentKeysV2(r), result);
  assert.throws(
    () => f.authority.archivePermanentKeysV2({ ...r, expectedManifestDigest: 'a'.repeat(64) }),
    /ANCHOR_COLD_CONFLICT/,
  );
  for (let e = 0; e < 4; e++) {
    assert.deepEqual(
      f.authority.archivePermanentKeys({ operationId: `ac1-old-${e}`, expectedRouteEpoch: e }),
      f.receipts[e],
    );
    assert.throws(
      () => f.authority.archivePermanentKeys({ operationId: `ac1-old-${e}`, expectedRouteEpoch: (e + 1) % 4 }),
      /ANCHOR_COLD_CONFLICT/,
    );
  }
  assert.throws(
    () => f.authority.archivePermanentKeys({ operationId: 'ac1-new', expectedRouteEpoch: 4 }),
    /ANCHOR_COLD_REQUEST/,
  );
  for (const [name, digest] of f.oldFiles) assert.equal(sha(readFileSync(join(f.ac.directory, name))), digest);
  const reopened = child(
    f,
    "const c=a.inspectCapacity();if(c.schemaVersion!==6||c.shardedColdRouting.generation!==5)throw Error('REOPEN');for(let e=0;e<4;e++)if(a.archivePermanentKeys({operationId:'ac1-old-'+e,expectedRouteEpoch:e}).toEpoch!==e+1)throw Error('OLD_M');console.log('FRESH_REOPEN_PASS');a.close();",
  );
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.match(reopened.stdout, /FRESH_REOPEN_PASS/);
});

test('v2 closure is complete, older v1 package is stale and only missing exact files can be repaired', (t) => {
  const f = fixture(t, 1),
    old = join(f.root, 'old');
  f.authority.exportColdClosure(old);
  for (let i = 0; i < 30; i++) f.vault.claim('closure-' + i, 'p');
  f.authority.archivePermanentKeysV2(request(f));
  assert.throws(() => f.authority.verifyColdClosure(old), /ANCHOR_COLD_PACKAGE_STALE/);
  const pack = join(f.root, 'closure');
  f.authority.exportColdClosure(pack);
  assert.deepEqual(readdirSync(pack).sort(), ['closure.json', 'intent.json', 'part-0.sqlite', 'part-1.sqlite']);
  f.authority.verifyColdClosure(pack);
  const name = readdirSync(f.ac.directory).find((n) => n.startsWith('cold-v2-') && n.endsWith('-0.sqlite'))!,
    path = join(f.ac.directory, name),
    before = sha(rootBytes(f));
  renameSync(path, join(f.root, 'retained-part.sqlite'));
  assert.throws(() => f.authority.inspectCapacity());
  f.authority.repairMissingColdClosure(pack);
  assert.equal(sha(rootBytes(f)), before);
  assert.ok(readFileSync(path).equals(readFileSync(join(f.root, 'retained-part.sqlite'))));
  const corrupt = Buffer.from(readFileSync(path));
  corrupt[100] = corrupt[100]! ^ 1;
  writeFileSync(path, corrupt);
  assert.throws(() => f.authority.repairMissingColdClosure(pack));
  assert.ok(readFileSync(path).equals(corrupt));
});

test('fifth maintenance admits the same business workload previously refused by the fixed soft limit', (t) => {
  const f = fixture(t, 4, 196608);
  let refusedId: string | null = null;
  for (let i = 0; i < 120; i++) {
    const name = 'capacity-' + i,
      before = f.authority.inspect('vault');
    try {
      f.vault.claim(name, 'unchanged-payload');
    } catch (e) {
      assert.match(String(e), /ANCHOR_CAPACITY|ANCHOR_WRITE_FAILED/);
      assert.deepEqual(f.authority.inspect('vault'), before);
      refusedId = name;
      break;
    }
  }
  assert.ok(refusedId, 'must reach real new-business capacity refusal');
  const before = f.authority.inspectCapacity();
  assert.ok(before.database.pageBytes <= 196608);
  f.vault.close();
  const oldNames = readdirSync(f.config.directory),
    r = request(f);
  f.authority.archivePermanentKeysV2(r);
  const after = f.authority.inspectCapacity();
  assert.ok(after.shardedColdRouting!.usedPages < before.shardedColdRouting!.usedPages);
  assert.equal(after.limits.writeLimitBytes, 196608);
  const v = AnchoredVault.open(f.config, 8, { clock: { wall: () => 100, monotonic: () => 0 } });
  t.after(() => v.close());
  v.claim(refusedId, 'unchanged-payload');
  assert.throws(() => v.claim(refusedId!, 'changed'), /INTERACTION_IDEMPOTENCY_CONFLICT/);
  for (const name of oldNames) assert.ok(existsSync(join(f.config.directory, name)));
  assert.ok(f.authority.inspectCapacity().database.pageBytes <= 196608);
});

test('schema6 upgrade is explicit, rollback preserves root bytes, old handles expire and over-soft DDL refuses', (t) => {
  const f = fixture(t, 1, 1048576, false);
  f.vault.close();
  const before = sha(rootBytes(f));
  for (const point of ['after-table', 'after-version']) {
    assert.throws(
      () =>
        LocalSqliteAuthority.upgradeShardedColdSchema(f.ac, 'operator-attested-stopped', (p) => {
          if (p === point) throw Error('SYNTHETIC_UPGRADE');
        }),
      /SYNTHETIC_UPGRADE/,
    );
    assert.equal(sha(rootBytes(f)), before);
  }
  // Separate structural boundary fixture: compact this synthetic root to eliminate reusable pages.
  const g = fixture(t, 0, 1048576, false);
  for (let i = 0; i < 25; i++) g.vault.claim('ddl-' + i, 'p');
  g.vault.close();
  g.authority.close();
  const packed = new DatabaseSync(join(g.ac.directory, 'authority.sqlite'));
  packed.exec('VACUUM');
  assert.equal(packed.prepare('PRAGMA freelist_count').get()!.freelist_count, 0);
  packed.close();
  const low = { ...g.ac, writeLimitBytes: rootBytes(g).length },
    prior = sha(rootBytes(g));
  assert.ok(low.writeLimitBytes >= 65536);
  assert.throws(
    () => LocalSqliteAuthority.upgradeShardedColdSchema(low, 'operator-attested-stopped'),
    /ANCHOR_CAPACITY/,
  );
  assert.equal(sha(rootBytes(g)), prior);
  assert.deepEqual(LocalSqliteAuthority.upgradeShardedColdSchema(f.ac, 'operator-attested-stopped'), {
    from: 5,
    to: 6,
    alreadyCurrent: false,
  });
  assert.throws(() => f.authority.inspectCapacity(), /ANCHOR_SCHEMA_CHANGED/);
  assert.deepEqual(LocalSqliteAuthority.upgradeShardedColdSchema(f.ac, 'operator-attested-stopped'), {
    from: 6,
    to: 6,
    alreadyCurrent: true,
  });
});

test('IF8 exact pointer closure crosses both parts and repeated current maintenance is independent from IF8 IDs', (t) => {
  const f = fixture(t, 1);
  for (let i = 0; i < 42; i++) f.vault.claim('segment-' + i, 'p');
  const db = new DatabaseSync(join(f.ac.directory, 'authority.sqlite')),
    original = db.prepare('SELECT vault_id,operation_id,receipt FROM receipts ORDER BY 1,2').all();
  db.close();
  const roll = f.authority.rolloverReceipts({ operationId: 'ac2-shared', maxReceipts: 24 }),
    r = request(f, 'ac2-shared'),
    before = f.authority.inspectCapacity();
  const archived = f.authority.archivePermanentKeysV2(r);
  assert.ok(archived.moved.segments > 0);
  assert.deepEqual(f.authority.rolloverReceipts({ operationId: 'ac2-shared', maxReceipts: 24 }), roll);
  assert.throws(
    () => f.authority.rolloverReceipts({ operationId: 'ac2-shared', maxReceipts: 23 }),
    /ANCHOR_ROLLOVER_CONFLICT/,
  );
  assert.deepEqual(f.authority.inspectCapacity().receipts, before.receipts);
  const w = new ColdWorkspace(),
    loaded = loadShards(f.ac.directory, mutableManifest(archived.manifest), w);
  let segmentPart = -1;
  const pointerParts = new Set<number>();
  try {
    for (const [part, db] of loaded.dbs.entries()) {
      for (const row of db.rows('S')) if (row.values[0] === 'ac2-shared') segmentPart = part;
      for (const row of db.rows('R'))
        if (parseReceiptPointer(Buffer.from(row.values[2] as Uint8Array).toString('utf8'))?.segmentId === 'ac2-shared')
          pointerParts.add(part);
    }
  } finally {
    loaded.close();
  }
  assert.equal(w.used, 0);
  assert.ok(
    [...pointerParts].some((part) => part !== segmentPart),
    'real IF8 group must cross the two fixed partitions',
  );
  for (const row of original)
    assert.equal(
      JSON.stringify(f.authority.transaction((tx) => tx.receipt(row.vault_id as string, row.operation_id as string))),
      row.receipt,
    );
});

for (const point of ['intent', 'part0', 'part1', 'delete', 'commit'] as const)
  test(`real process death at ${point} preserves old current or the complete new publication`, (t) => {
    const f = fixture(t, 1);
    for (let i = 0; i < 30; i++) f.vault.claim('crash-' + i, 'p');
    f.vault.close();
    const r = request(f),
      before = f.authority.inspectCapacity().receipts;
    const result = child(
      f,
      `const point=${JSON.stringify(point)},paths=new Map(),open=fs.openSync,flush=fs.fsyncSync,prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let published=false;
 fs.openSync=function(path,...args){const fd=open.call(this,path,...args);paths.set(fd,String(path));return fd;};fs.fsyncSync=function(fd){flush.call(this,fd);const path=paths.get(fd)||'';if((point==='intent'&&path.includes('cold-v2-')&&path.endsWith('.intent.json'))||(point==='part0'&&path.endsWith('-0.sqlite'))||(point==='part1'&&path.endsWith('-1.sqlite')))process.exit(42);};syncBuiltinESMExports();
 let preview=0;DatabaseSync.prototype.exec=function(sql){if(sql==='SAVEPOINT shard_preview')preview++;const value=exec.call(this,sql);if(sql==='ROLLBACK TO shard_preview; RELEASE shard_preview')preview--;if(point==='commit'&&published&&sql==='COMMIT')process.exit(42);return value;};DatabaseSync.prototype.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=function(...args){const out=run.apply(this,args);if(!preview&&sql.startsWith('UPDATE authority_shard_root SET manifest='))published=true;if(!preview&&point==='delete'&&sql.startsWith('DELETE FROM receipts'))process.exit(42);return out;};return s;};a.archivePermanentKeysV2(x.request);`,
    );
    assert.equal(result.status, 42, result.stderr);
    assert.deepEqual(f.authority.inspectCapacity().receipts, before);
    assert.deepEqual(
      f.authority.archivePermanentKeys({ operationId: 'ac1-old-0', expectedRouteEpoch: 0 }),
      f.receipts[0],
    );
    const retained = new Map(
      readdirSync(f.ac.directory)
        .filter((n) => n.startsWith('cold-v2-'))
        .map((n) => [n, sha(readFileSync(join(f.ac.directory, n)))]),
    );
    const completed = f.authority.archivePermanentKeysV2(r);
    assert.equal(completed.toEpoch, 2);
    assert.equal(f.authority.inspectCapacity().shardedColdRouting!.pending, null);
    for (const [name, digest] of retained) assert.equal(sha(readFileSync(join(f.ac.directory, name))), digest);
    assert.equal(
      readdirSync(f.ac.directory).filter((n) => n.startsWith('cold-v2-')).length,
      point === 'intent' ? 4 : point === 'part0' ? 5 : 3,
    );
  });

const stopAtIntent = `const paths=new Map(),open=fs.openSync,flush=fs.fsyncSync;fs.openSync=function(path,...args){const fd=open.call(this,path,...args);paths.set(fd,String(path));return fd;};fs.fsyncSync=function(fd){flush.call(this,fd);if((paths.get(fd)||'').includes('cold-v2-')&&(paths.get(fd)||'').endsWith('.intent.json'))process.exit(42);};syncBuiltinESMExports();a.archivePermanentKeysV2(x.request);`;
test('persistent reservation fences new writes, keeps old retry priority and completes under a subsequently lowered soft limit', (t) => {
  const f = fixture(t, 1);
  for (let i = 0; i < 30; i++) f.vault.claim('reservation-' + i, 'p');
  const roll = f.authority.rolloverReceipts({ operationId: 'reserved-if8', maxReceipts: 16 }),
    r = request(f);
  f.vault.close();
  const dead = child(f, stopAtIntent);
  assert.equal(dead.status, 42, dead.stderr);
  assert.deepEqual(f.authority.rolloverReceipts({ operationId: 'reserved-if8', maxReceipts: 16 }), roll);
  assert.throws(() => f.authority.rolloverReceipts({ operationId: 'new-if8' }), /ANCHOR_SHARD_PENDING/);
  assert.throws(() => f.authority.archivePermanentKeysV2({ ...r, operationId: 'ac2-other' }), /ANCHOR_SHARD_PENDING/);
  assert.throws(
    () => f.authority.archivePermanentKeysV2({ ...r, expectedManifestDigest: 'e'.repeat(64) }),
    /ANCHOR_COLD_CONFLICT/,
  );
  const cap = f.authority.inspectCapacity().shardedColdRouting!;
  assert.ok(cap.pending);
  assert.ok(cap.obligationBytes > cap.retainedBytes);
  assert.ok(cap.missingObligationBytes > 0);
  const lower = LocalSqliteAuthority.open({ ...f.ac, writeLimitBytes: 65536 });
  t.after(() => lower.close());
  assert.ok(lower.inspectCapacity().database.pageBytes > 65536);
  assert.equal(lower.archivePermanentKeysV2(r).toEpoch, 2);
  assert.equal(lower.inspectCapacity().shardedColdRouting!.pending, null);
});

test('two partial attempt deaths exhaust the bounded recovery and never create a third attempt', (t) => {
  const f = fixture(t, 1);
  for (let i = 0; i < 30; i++) f.vault.claim('exhaust-' + i, 'p');
  f.vault.close();
  const r = request(f);
  for (let i = 0; i < 2; i++) {
    const dead = child(f, stopAtIntent);
    assert.equal(dead.status, 42, dead.stderr);
  }
  const files = new Map(readdirSync(f.ac.directory).map((n) => [n, sha(readFileSync(join(f.ac.directory, n)))]));
  assert.throws(() => f.authority.archivePermanentKeysV2(r), /ANCHOR_SHARD_ATTEMPTS_EXHAUSTED/);
  assert.equal(f.authority.inspectCapacity().shardedColdRouting!.pending!.activeAttempt, 1);
  assert.deepEqual(
    f.authority.archivePermanentKeys({ operationId: 'ac1-old-0', expectedRouteEpoch: 0 }),
    f.receipts[0],
  );
  for (const [n, h] of files) assert.equal(sha(readFileSync(join(f.ac.directory, n))), h);
  assert.equal(readdirSync(f.ac.directory).length, files.size);
});

test('two processes share one root reservation and committed M wins after the first writer resumes', async (t) => {
  const f = fixture(t, 1);
  for (let i = 0; i < 30; i++) f.vault.claim('race-' + i, 'p');
  const r = request(f),
    ready = join(f.root, 'ready'),
    release = join(f.root, 'release');
  const script = `import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const x=JSON.parse(fs.readFileSync(0,'utf8')),a=LocalSqliteAuthority.open(x.config),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let reserved=false,waited=false;
 DatabaseSync.prototype.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=function(...args){const result=run.apply(this,args);if(sql==='UPDATE authority_shard_root SET reservation=? WHERE id=1 AND reservation IS NULL')reserved=true;return result;};return s;};DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(reserved&&!waited&&sql==='COMMIT'){waited=true;fs.writeFileSync(x.ready,'READY',{flag:'wx'});const end=Date.now()+20000;while(!fs.existsSync(x.release)){if(Date.now()>end)throw Error('TIMEOUT');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return result;};console.log(JSON.stringify(a.archivePermanentKeysV2(x.request)));a.close();`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (proc.exitCode === null) proc.kill();
  });
  let stdout = '',
    stderr = '';
  proc.stdout.on('data', (b) => (stdout += b));
  proc.stderr.on('data', (b) => (stderr += b));
  const done = new Promise<number | null>((resolve) => proc.on('exit', resolve));
  proc.stdin.end(JSON.stringify({ config: f.ac, request: r, ready, release }));
  const end = Date.now() + 15000;
  while (!existsSync(ready)) {
    if (Date.now() > end) throw Error('READY_TIMEOUT ' + stderr);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(
    f.authority.archivePermanentKeys({ operationId: 'ac1-old-0', expectedRouteEpoch: 0 }),
    f.receipts[0],
  );
  assert.throws(() => f.vault.claim('during-reservation', 'p'), /ANCHOR_SHARD_PENDING|ANCHOR_WRITE_FAILED/);
  f.vault.close();
  const result = f.authority.archivePermanentKeysV2(r);
  writeFileSync(release, 'GO', { flag: 'wx' });
  assert.equal(await done, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), result);
  assert.equal(readdirSync(f.ac.directory).filter((n) => n.startsWith('cold-v2-')).length, 3);
});

test('UNKNOWN, revocation and current-head fencing survive v2 archive and real vault fresh-process reopen', (t) => {
  const f = fixture(t, 1),
    who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'synthetic', relationshipId: 'synthetic' },
    event = {
      source: 'synthetic',
      eventKey: 'revoked-event',
      evidence: {
        speakerId: 'subject',
        speakerRole: 'subject' as const,
        mode: 'self_report' as const,
        selectedText: 'SYNTHETIC_REVOKED',
        occurredAt: null,
      },
    };
  const scope = f.vault.store.ensureScope(who),
    accepted = f.vault.store.acceptEvent(scope, event);
  f.vault.store.revoke(scope, accepted);
  f.vault.claim('unknown-business', 'same');
  f.vault.reserve('unknown-business');
  f.vault.terminal('unknown-business', 'failed');
  for (let i = 0; i < 25; i++) f.vault.claim('safety-' + i, 'p');
  const old = f.vault.head,
    before = f.vault.status.unknownRequests;
  f.authority.archivePermanentKeysV2(request(f));
  f.authority.transaction((tx) => tx.assertActive(old));
  f.vault.close();
  const data = {
    config: f.ac,
    vault: { ...f.config, authority: undefined, keys: undefined },
    keys: {
      ...f.config.keys,
      storageDEK: Buffer.from(f.config.keys.storageDEK).toString('base64'),
      ingressKey: Buffer.from(f.config.keys.ingressKey).toString('base64'),
    },
    scopeId: scope.id,
    event,
    before,
  };
  const script = `import assert from 'node:assert/strict';import fs from 'node:fs';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';import {AnchoredVault} from './src/anchored-vault.ts';const x=JSON.parse(fs.readFileSync(0,'utf8')),authority=LocalSqliteAuthority.open(x.config),keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')},v=AnchoredVault.open({...x.vault,authority,keys},8,{clock:{wall:()=>100,monotonic:()=>0}});assert.ok(v.status.unknownRequests>=x.before);assert.throws(()=>v.claim('unknown-business','same'),/INTERACTION_TERMINATED/);assert.throws(()=>v.claim('unknown-business','different'),/INTERACTION_IDEMPOTENCY_CONFLICT/);assert.equal(v.store.acceptEvent(v.store.scope(x.scopeId),x.event).currentStatus,'revoked');v.close();authority.close();console.log('BUSINESS_FRESH_REOPEN_PASS');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    input: JSON.stringify(data),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BUSINESS_FRESH_REOPEN_PASS/);
  assert.throws(() => f.authority.transaction((tx) => tx.assertActive(old)), /ANCHOR_FENCED/);
});

test('admitted legacy retains all three identities and original admission with current-head priority', (t) => {
  const f = fixture(t, 0),
    source = join(f.root, 'legacy');
  mkdirSync(source);
  const key = randomBytes(32),
    legacy = new DurableMemory(
      { directory: source, identity: 'synthetic-legacy', keyBase64: key.toString('base64') },
      8,
      { clock: { wall: () => 100, monotonic: () => 0 } },
    );
  t.after(() => legacy.close());
  legacy.claim('old-unknown', 'p');
  legacy.reserve('old-unknown');
  const backup = join(f.root, 'legacy-backup');
  legacy.exportBackup(backup);
  const inspect = {
      backupDirectory: backup,
      legacyKey: key,
      identity: 'synthetic-legacy',
      expectedMaxCalls: 8,
      declaredHead: legacy.head,
      trust: { policy: 'trusted-lower-bound' as const, minimumHead: legacy.head },
    },
    inspection = inspectLegacyM2(inspect),
    storageDEK = randomBytes(32),
    requestImport = {
      ...inspect,
      sourceFreeze: inspection.sourceFreeze,
      authority: f.authority,
      vaultId: 'imported',
      targetDirectory: join(f.root, 'imported'),
      storageDomain: 'payload',
      storageProfile: 'blocks-br4-v1' as const,
      newStorageDEK: storageDEK,
      operationId: inspection.migrationId,
    };
  const imported = AnchoredVault.importLegacyM2(requestImport),
    keys = { version: 2 as const, keyEpoch: 1, storageDEK, ingressKey: key },
    v = AnchoredVault.open(
      {
        directory: requestImport.targetDirectory,
        authority: f.authority,
        vaultId: 'imported',
        identity: 'synthetic-legacy',
        storageDomain: 'payload',
        storageProfile: 'blocks-br4-v1',
        keys,
      },
      8,
      { clock: { wall: () => 100, monotonic: () => 0 } },
    );
  t.after(() => v.close());
  const admission = {
      migrationId: inspection.migrationId,
      head: f.authority.inspect('imported')!.head!,
      operationId: 'admit',
      operatorId: 'synthetic',
      attestation: 'operator-attested-stopped' as const,
    },
    admitted = f.authority.admitLegacyImport(admission),
    original = f.authority.transaction((tx) => tx.legacy(inspection.lineageId));
  for (let i = 0; i < 25; i++) f.vault.claim('legacy-fill-' + i, 'p');
  f.authority.archivePermanentKeysV2(request(f));
  assert.equal(f.authority.inspectCapacity().shardedColdRouting!.cold.legacy, 1);
  assert.deepEqual(
    f.authority.transaction((tx) => tx.legacy(inspection.lineageId)),
    original,
  );
  assert.deepEqual(f.authority.admitLegacyImport(admission), admitted);
  assert.throws(() => f.authority.admitLegacyImport({ ...admission, head: imported.newHead }), /ANCHOR_FENCED/);
  assert.deepEqual(AnchoredVault.importLegacyM2(requestImport), imported);
  assert.throws(
    () => AnchoredVault.importLegacyM2({ ...requestImport, vaultId: 'other', targetDirectory: join(f.root, 'other') }),
    /LEGACY_LINEAGE_CONSUMED/,
  );
  assert.throws(() => v.claim('old-unknown', 'p'), /INTERACTION_TERMINATED/);
  const db = new DatabaseSync(join(f.ac.directory, 'authority.sqlite'));
  try {
    for (const column of ['lineage_id', 'migration_id', 'vault_id']) {
      const x = structuredClone(original)!,
        args = [
          column === 'lineage_id' ? x.lineageId : 'different-lineage',
          column === 'migration_id' ? x.migrationId : 'different-migration',
          column === 'vault_id' ? x.vaultId : 'different-vault',
          JSON.stringify(x),
        ];
      db.prepare('INSERT INTO legacy_imports VALUES (?,?,?,?)').run(...args);
      assert.throws(() => f.authority.inspectCapacity());
      db.prepare('DELETE FROM legacy_imports WHERE lineage_id=?').run(args[0]!);
    }
  } finally {
    db.close();
  }
});

test('continuous v2 maintenance ends at retained directory reservation without forgetting earlier operations', (t) => {
  const f = fixture(t),
    completed: { input: ShardInput; receipt: ReturnType<LocalSqliteAuthority['archivePermanentKeysV2']> }[] = [];
  let refused = false;
  for (let generation = 4; generation < 14; generation++) {
    for (let i = 0; i < 12; i++) f.vault.claim(`continued-${generation}-${i}`, 'p');
    const input = request(f, `ac2-generation-${generation}`),
      before = sha(rootBytes(f)),
      names = readdirSync(f.ac.directory);
    try {
      completed.push({ input, receipt: f.authority.archivePermanentKeysV2(input) });
    } catch (e) {
      assert.match(String(e), /ANCHOR_SHARD_CAPACITY/);
      assert.equal(sha(rootBytes(f)), before);
      assert.deepEqual(readdirSync(f.ac.directory), names);
      refused = true;
      break;
    }
  }
  assert.ok(completed.length >= 2, 'supports successive v2 publications');
  assert.equal(refused, true);
  assert.ok(readdirSync(f.ac.directory).length <= 32);
  for (const c of completed) assert.deepEqual(f.authority.archivePermanentKeysV2(c.input), c.receipt);
  for (let e = 0; e < 4; e++)
    assert.deepEqual(
      f.authority.archivePermanentKeys({ operationId: `ac1-old-${e}`, expectedRouteEpoch: e }),
      f.receipts[e],
    );
});

test('actual retained obligations allow a large root within B; missing current bytes never release their budget', (t) => {
  const f = fixture(t, 1, 22369621);
  for (let i = 0; i < 30; i++) f.vault.claim('large-root-' + i, 'p');
  // Structural size fixture only; the separate fixed-soft test supplies the business benefit evidence.
  const db = new DatabaseSync(join(f.ac.directory, 'authority.sqlite'));
  db.exec(
    "INSERT INTO receipts VALUES ('synthetic-padding','padding',CAST(zeroblob(20971520) AS TEXT));DELETE FROM receipts WHERE vault_id='synthetic-padding'",
  );
  db.close();
  const before = f.authority.inspectCapacity();
  assert.ok(before.database.pageBytes > 20971520);
  assert.ok(before.database.pageBytes <= 22369621);
  const archived = f.authority.archivePermanentKeysV2(request(f));
  assert.ok(f.authority.inspectCapacity().shardedColdRouting!.usedPages < before.shardedColdRouting!.usedPages);
  const m = mutableManifest(archived.manifest),
    initial = obligations(inspectShardFiles(f.ac.directory), m, null);
  assert.ok(m.current?.format === 'two-shards-v2');
  const part = m.current.parts[0],
    path = join(f.ac.directory, part.name),
    pack = join(f.root, 'large-closure');
  f.authority.exportColdClosure(pack);
  renameSync(path, join(f.root, 'large-retained.sqlite'));
  const missing = obligations(inspectShardFiles(f.ac.directory), m, null);
  assert.equal(missing.bytes, initial.bytes);
  assert.equal(missing.missingBytes, part.bytes);
  assert.equal(missing.files, initial.files);
  f.authority.repairMissingColdClosure(pack);
  assert.equal(obligations(inspectShardFiles(f.ac.directory), m, null).missingBytes, 0);
});

test('shared workspace refusal and second-part builder failure leave no root reservation or new disk files', (t) => {
  const f = fixture(t, 1);
  for (let i = 0; i < 30; i++) f.vault.claim('preflight-' + i, 'p');
  const r = request(f),
    before = sha(rootBytes(f)),
    names = readdirSync(f.ac.directory),
    reserve = ColdWorkspace.prototype.reserve,
    build = ShardDatabase.build;
  let pool: ColdWorkspace | undefined, held: (() => void) | undefined;
  try {
    ColdWorkspace.prototype.reserve = function (n, label) {
      pool = this;
      if (label === 'v2 builder image and metadata')
        held = reserve.call(this, this.limit - this.used, 'synthetic exhaust');
      return reserve.call(this, n, label);
    };
    assert.throws(() => f.authority.archivePermanentKeysV2(r), /ANCHOR_COLD_WORKSPACE/);
  } finally {
    held?.();
    ColdWorkspace.prototype.reserve = reserve;
  }
  assert.equal(pool!.used, 0);
  assert.equal(sha(rootBytes(f)), before);
  assert.deepEqual(readdirSync(f.ac.directory), names);
  let calls = 0;
  try {
    ShardDatabase.build = function (...args) {
      if (++calls === 2) throw Error('SYNTHETIC_SECOND_PART_FULL');
      return build.apply(this, args);
    };
    assert.throws(() => f.authority.archivePermanentKeysV2(r), /SYNTHETIC_SECOND_PART_FULL/);
  } finally {
    ShardDatabase.build = build;
  }
  assert.equal(calls, 2);
  assert.equal(sha(rootBytes(f)), before);
  assert.deepEqual(readdirSync(f.ac.directory), names);
  assert.equal(f.authority.inspectCapacity().shardedColdRouting!.pending, null);
});

test('exact root-bound current files fail closed when one part is absent, swapped, or malformed', (t) => {
  const f = fixture(t, 1);
  for (let i = 0; i < 30; i++) f.vault.claim('bound-' + i, 'p');
  const receipt = f.authority.archivePermanentKeysV2(request(f)),
    m = receipt.manifest;
  assert.ok(m.current?.format === 'two-shards-v2');
  const a = join(f.ac.directory, m.current.parts[0].name),
    b = join(f.ac.directory, m.current.parts[1].name),
    originalA = readFileSync(a),
    originalB = readFileSync(b);
  const saved = join(f.root, 'missing-part.sqlite');
  renameSync(a, saved);
  assert.throws(() => f.authority.transaction((tx) => tx.receipt('absent', 'absent')));
  renameSync(saved, a);
  writeFileSync(a, originalB);
  writeFileSync(b, originalA);
  assert.throws(() => f.authority.transaction((tx) => tx.receipt('absent', 'absent')));
  writeFileSync(a, originalA);
  writeFileSync(b, originalB);
  const bad = Buffer.from(originalA);
  bad[100] = bad[100]! ^ 1;
  writeFileSync(a, bad);
  assert.throws(() => f.authority.archivePermanentKeysV2(request(f)), /ANCHOR_COLD_DIGEST/);
  writeFileSync(a, originalA);
  assert.deepEqual(
    f.authority.archivePermanentKeysV2({
      operationId: 'ac2-next',
      expectedRouteEpoch: 1,
      expectedManifestDigest: m.parentManifestDigest!,
    }),
    receipt,
  );
});

test('v2 codec refuses a real overfull partition and old v1 images without leaking workspace', (t) => {
  const f = fixture(t, 1),
    w = new ColdWorkspace(),
    oldName = [...f.oldFiles.keys()].find((n) => n.endsWith('.sqlite'))!;
  assert.throws(() => ShardDatabase.open(readFileSync(join(f.ac.directory, oldName)), w), /ANCHOR_COLD_LAYOUT/);
  assert.equal(w.used, 0);
  const row: RawRow = { kind: 'R', values: ['vault', 'huge', Buffer.alloc(1048576, 97)], epoch: 2 },
    meta: ShardMeta = {
      format: 'companion-authority-shard-sqlite-v2',
      version: 2,
      authorityId: 'synthetic',
      custodyDomain: 'independent',
      operationId: 'ac2-big',
      requestDigest: 'a'.repeat(64),
      fromEpoch: 1,
      toEpoch: 2,
      partition: partition(row),
      sourceSnapshotDigest: 'b'.repeat(64),
      selectionDigest: 'c'.repeat(64),
      counts: { receipts: 1, segments: 0, legacy: 0, operations: 0 },
    };
  assert.throws(
    () => ShardDatabase.build(meta, [row], w),
    (e: unknown) => (e as { errcode?: number }).errcode === 13,
  );
  assert.equal(w.used, 0);
});

test('an unexpected file at a reserved rebuild name never gains publication authority', (t) => {
  const f = fixture(t, 1);
  for (let i = 0; i < 30; i++) f.vault.claim('unexpected-' + i, 'p');
  f.vault.close();
  const r = request(f),
    dead = child(f, stopAtIntent);
  assert.equal(dead.status, 42, dead.stderr);
  const db = new DatabaseSync(join(f.ac.directory, 'authority.sqlite')),
    pending = JSON.parse(
      db.prepare('SELECT reservation FROM authority_shard_root WHERE id=1').get()!.reservation as string,
    );
  db.close();
  const path = join(f.ac.directory, pending.plans[1].parts[0].name);
  writeFileSync(path, 'UNKNOWN_SAME_NAME', { flag: 'wx' });
  const before = sha(rootBytes(f));
  assert.throws(() => f.authority.archivePermanentKeysV2(r), /ANCHOR_SHARD_STAGE/);
  assert.equal(sha(rootBytes(f)), before);
  assert.equal(readFileSync(path, 'utf8'), 'UNKNOWN_SAME_NAME');
  assert.deepEqual(
    f.authority.archivePermanentKeys({ operationId: 'ac1-old-0', expectedRouteEpoch: 0 }),
    f.receipts[0],
  );
});

test('large IF8 and growing two-part current complete closure export verify and missing-only repair within shared W', (t) => {
  const f = fixture(t, 1, 4194304),
    reserve = ColdWorkspace.prototype.reserve,
    pools = new Set<ColdWorkspace>();
  let peak = 0;
  const padHot = (padding: () => string) => {
    const db = new DatabaseSync(join(f.ac.directory, 'authority.sqlite'));
    try {
      for (const r of db.prepare('SELECT vault_id,operation_id,receipt FROM receipts').all()) {
        const raw = r.receipt as string;
        if (parseReceiptPointer(raw)) continue;
        const receipt = JSON.parse(raw);
        receipt.syntheticCapacityPadding = padding();
        db.prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?').run(
          JSON.stringify(receipt),
          r.vault_id!,
          r.operation_id!,
        );
      }
    } finally {
      db.close();
    }
  };
  // Structural sizing only: valid synthetic receipt objects preserve their original fields.
  // The distinct fixed-soft test proves the actual unchanged business request benefit.
  for (let i = 0; i < 100; i++) f.vault.claim('large-if8-' + i, 'p');
  padHot(() => 'x'.repeat(6900));
  try {
    ColdWorkspace.prototype.reserve = function (bytes, label) {
      pools.add(this);
      const release = reserve.call(this, bytes, label);
      peak = Math.max(peak, this.used);
      return release;
    };
    const roll = f.authority.rolloverReceipts({ operationId: 'large-if8', maxReceipts: 128, maxJsonBytes: 1048576 });
    assert.ok(roll.decodedBytes >= 700000);
    f.authority.archivePermanentKeysV2(request(f, 'ac2-large-if8'));
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 38; i++) f.vault.claim(`large-current-${round}-${i}`, 'p');
      padHot(() => randomBytes(2500).toString('hex'));
      f.authority.archivePermanentKeysV2(request(f, `ac2-large-current-${round}`));
    }
    const c = f.authority.inspectCapacity().shardedColdRouting!,
      pack = join(f.root, 'large-w-closure');
    assert.ok(c.currentBytes >= 500000);
    const root = sha(rootBytes(f));
    f.authority.exportColdClosure(pack);
    f.authority.verifyColdClosure(pack);
    const open = ShardDatabase.open;
    try {
      ShardDatabase.open = () => {
        throw Error('SYNTHETIC_PACKAGE_OPEN');
      };
      assert.throws(() => f.authority.repairMissingColdClosure(pack), /SYNTHETIC_PACKAGE_OPEN/);
    } finally {
      ShardDatabase.open = open;
    }
    for (const pool of pools) assert.equal(pool.used, 0);
    assert.equal(sha(rootBytes(f)), root);
    const db = new DatabaseSync(join(f.ac.directory, 'authority.sqlite')),
      m = mutableManifest(
        JSON.parse(db.prepare('SELECT manifest FROM authority_shard_root WHERE id=1').get()!.manifest as string),
      );
    db.close();
    assert.ok(m.current?.format === 'two-shards-v2');
    const ref = m.current.parts[1],
      path = join(f.ac.directory, ref.name);
    renameSync(path, join(f.root, 'retained-large-part.sqlite'));
    f.authority.repairMissingColdClosure(pack);
    assert.equal(sha(rootBytes(f)), root);
    assert.equal(sha(readFileSync(path)), ref.sha256);
    assert.deepEqual(
      f.authority.rolloverReceipts({ operationId: 'large-if8', maxReceipts: 128, maxJsonBytes: 1048576 }),
      roll,
    );
    assert.ok(peak <= 12582912);
    t.diagnostic(
      JSON.stringify({
        currentBytes: c.currentBytes,
        if8DecodedBytes: roll.decodedBytes,
        if8EncodedBytes: roll.encodedBytes,
        workspacePeakBytes: peak,
        workspaceLimitBytes: 12582912,
      }),
    );
  } finally {
    ColdWorkspace.prototype.reserve = reserve;
  }
  for (const pool of pools) assert.equal(pool.used, 0);
});

test('real full-key skew plus mandatory old cold data refuses before reservation without changing accepted bytes', (t) => {
  const f = fixture(t, 0, 4194304),
    completed: { input: ShardInput; receipt: ReturnType<LocalSqliteAuthority['archivePermanentKeysV2']> }[] = [];
  const db = new DatabaseSync(join(f.ac.directory, 'authority.sqlite')),
    template = JSON.parse(db.prepare('SELECT receipt FROM receipts LIMIT 1').get()!.receipt as string);
  db.close();
  let refused = false,
    sequence = 0;
  for (let round = 0; round < 7; round++) {
    const source = new DatabaseSync(join(f.ac.directory, 'authority.sqlite'));
    try {
      for (let accepted = 0; accepted < 32;) {
        const op = 'skew-' + sequence++,
          r = { kind: 'R' as const, values: ['vault', op], epoch: 0 };
        if (partition(r) !== 0) continue;
        const value = { ...template, operationId: op, syntheticCapacityPadding: 'x'.repeat(4900) };
        source.prepare('INSERT INTO receipts VALUES (?,?,?)').run('vault', op, JSON.stringify(value));
        accepted++;
      }
    } finally {
      source.close();
    }
    const input = request(f, `ac2-skew-${round}`),
      before = sha(rootBytes(f)),
      files = new Map(readdirSync(f.ac.directory).map((n) => [n, sha(readFileSync(join(f.ac.directory, n)))]));
    try {
      completed.push({ input, receipt: f.authority.archivePermanentKeysV2(input) });
    } catch (e) {
      assert.equal((e as { errcode?: number }).errcode, 13);
      assert.equal(sha(rootBytes(f)), before);
      assert.deepEqual(readdirSync(f.ac.directory), [...files.keys()]);
      for (const [n, h] of files) assert.equal(sha(readFileSync(join(f.ac.directory, n))), h);
      assert.equal(f.authority.inspectCapacity().shardedColdRouting!.pending, null);
      refused = true;
      break;
    }
  }
  assert.equal(refused, true);
  assert.ok(completed.length >= 2);
  for (const c of completed) assert.deepEqual(f.authority.archivePermanentKeysV2(c.input), c.receipt);
});
