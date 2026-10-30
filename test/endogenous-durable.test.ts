import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredFault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { MemoryStore } from '../src/store.ts';
import type { Clock } from '../src/store.ts';
import { DurableMemory } from '../src/durable-memory.ts';
import { readAuthority, seal, sha } from '../src/durable-codec.ts';
import { directoryReader, reconstruct } from '../src/incremental-storage.ts';
import { ENDOGENOUS_CONTROL_KEY, parseControl, encodeControl, bootControl } from '../src/endogenous-durable.ts';
import { configureRepackRuntime, fingerprintMemoryDatabase, repackMemoryImage } from '../src/memory-image.ts';
import { CoreError } from '../src/validation.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'synthetic', relationshipId: 'synthetic' };
const answer = '{"version":1,"choice":"REST"}';
const limits = { maxCalls: 4, maxDurationMs: 60_000, callTimeoutMs: 5000, maxResultBytes: 1024 };
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const processEvidence: { mode: string; exit: number | null; signal: string | null; maxRssKiB: number | null }[] = [];
after(() =>
  console.log(
    JSON.stringify({
      evidence: 'E1B_SYNTHETIC_PROCESSES',
      parentMaxRssKiB: process.resourceUsage().maxRSS,
      children: processEvidence,
    }),
  ),
);
function deferred() {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t: TestContext, schemaVersion: 1 | 2 = 1, fault?: (p: AnchoredFault) => void, clock?: Clock) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'companion-e1b-')));
  const authorityConfig = {
    directory: join(root, 'authority'),
    authorityId: 'synthetic-authority',
    custodyDomain: 'synthetic-custody',
  };
  const authority = LocalSqliteAuthority.create(authorityConfig),
    keys = generateKeySet();
  const config = {
    directory: join(root, 'vault'),
    vaultId: 'synthetic-vault',
    identity: 'synthetic',
    storageDomain: 'synthetic-store',
    authority,
    keys,
    schemaVersion,
  };
  const v = AnchoredVault.create(config, 2, { ...(fault ? { fault } : {}), ...(clock ? { clock } : {}) });
  const scope = v.store.ensureScope(who);
  t.after(() => {
    v.close();
    authority.close();
  });
  t.diagnostic(`retained synthetic directory: ${root}`);
  return { root, authorityConfig, authority, keys, config, v, scope };
}
function read(v: AnchoredVault) {
  return parseControl(v.store.endogenousControl()!);
}
function assertCoreUsable(f: ReturnType<typeof fixture>, label: string) {
  const scope = f.v.store.scope(f.scope.id);
  f.v.store.acceptEvent(scope, {
    source: 'synthetic',
    eventKey: label,
    evidence: {
      speakerId: 'subject',
      speakerRole: 'subject',
      mode: 'self_report',
      selectedText: 'synthetic core availability',
      occurredAt: null,
    },
  });
  f.v.exportBackup(join(f.root, label));
}
function child(f: ReturnType<typeof fixture>, mode: string, extra: Record<string, unknown> = {}) {
  const data = {
    mode,
    authority: f.authorityConfig,
    config: { ...f.config, authority: undefined, keys: undefined },
    keys: {
      ...f.keys,
      storageDEK: Buffer.from(f.keys.storageDEK).toString('base64'),
      ingressKey: Buffer.from(f.keys.ingressKey).toString('base64'),
    },
    ...extra,
  };
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=128',
      '--input-type=module',
      '-e',
      `
    process.on('exit',()=>process.stderr.write('E1B_MAX_RSS_KIB='+process.resourceUsage().maxRSS+'\\n'));
    import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';
    import {AnchoredVault} from './src/anchored-vault.ts';
    let chunks=[];for await(const c of process.stdin)chunks.push(c);
    const d=JSON.parse(Buffer.concat(chunks));
    const a=LocalSqliteAuthority.open(d.authority);
    const keys={...d.keys,storageDEK:Buffer.from(d.keys.storageDEK,'base64'),ingressKey:Buffer.from(d.keys.ingressKey,'base64')};
    let active=false,finalized=0;
    try {
      const v=AnchoredVault.open({...d.config,authority:a,keys},2,{fault:p=>{
        if(!active)return;
        if(p==='finalized'){finalized++;if(d.mode==='reserve-crash'&&finalized===1)process.exit(71);}
        if(d.mode==='terminal-crash'&&p==='stage-written'&&finalized===2)process.exit(73);
      }});
      if(d.mode==='inspect') {console.log(JSON.stringify(JSON.parse(v.store.endogenousControl())));v.close();a.close();}
      else {
        const s=v.openEndogenousControl(()=>{if(d.mode==='dispatch-crash')process.exit(72);return Promise.resolve('${answer}');});
        active=true;s.resume();await new Promise(r=>setImmediate(r));
        s.close();console.log(JSON.stringify(s.readControl()));v.close();a.close();
      }
    } catch(e){console.log(JSON.stringify({error:e.code??e.message}));a.close();process.exitCode=4;}
  `,
    ],
    { cwd: process.cwd(), input: JSON.stringify(data), encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  const rss = /E1B_MAX_RSS_KIB=(\d+)/.exec(result.stderr);
  processEvidence.push({ mode, exit: result.status, signal: result.signal, maxRssKiB: rss ? Number(rss[1]) : null });
  return result;
}

for (const schema of [1, 2] as const)
  test(`schema${schema}: explicit creation, stopped open, durable terminal and process reopen retain IDs/limits`, async (t) => {
    const f = fixture(t, schema);
    assert.throws(() => f.v.openEndogenousControl(async () => answer), /E1_CONTROL_MISSING/);
    const initial = f.v.createEndogenousControl(f.scope, limits);
    assert.throws(() => f.v.createEndogenousControl(f.scope, { maxCalls: 64 }), /E1_CONTROL_EXISTS/);
    let invoked = 0;
    const s = f.v.openEndogenousControl((request) => {
      invoked++;
      assert.equal(request.decisionId, `${initial.controlId}:${invoked}`);
      assert.throws(() => f.v.store.endogenousControl(), /ANCHOR_ACCESS_BUSY/);
      return Promise.resolve(answer);
    });
    assert.equal(invoked, 0);
    assert.equal(s.read().state, 'paused');
    assert.throws(() => s.start(), /E1_STATE/);
    assert.throws(() => f.v.openEndogenousControl(async () => answer), /E1_SESSION_ACTIVE/);
    s.resume();
    await flush();
    assert.equal(s.read().entries[0]!.outcome, 'REST');
    assert.equal(read(f.v).permitHeld, false);
    assert.equal(read(f.v).entries[0]!.outcome, 'REST');
    s.close();
    f.v.close();
    const reopened = child(f, 'normal');
    assert.equal(reopened.status, 0, reopened.stderr + reopened.stdout);
    const state = JSON.parse(reopened.stdout);
    assert.equal(state.controlId, initial.controlId);
    assert.equal(state.entries.length, 2);
    assert.equal(state.entries[1].decisionId, `${initial.controlId}:2`);
    assert.deepEqual(state.limits, limits);
    assert.equal(state.expiresAt, initial.expiresAt);
    assert.equal(state.stop, 'CLOSED');
    for (const name of readdirSync(f.config.directory).filter((n) => n.endsWith('.bin'))) {
      assert.equal(readFileSync(join(f.config.directory, name)).includes(Buffer.from(initial.controlId)), false);
    }
  });

test('same original observer releases only held permit after pause; UNKNOWN never becomes success', async (t) => {
  const f = fixture(t);
  f.v.createEndogenousControl(f.scope, limits);
  const pending = deferred();
  const s = f.v.openEndogenousControl(() => pending.promise);
  s.resume();
  s.pause();
  assert.equal(read(f.v).permitHeld, true);
  assert.equal(read(f.v).entries[0]!.outcome, 'UNKNOWN');
  assert.throws(() => s.resume(), /E1_RAW_BUSY/);
  pending.resolve(answer);
  await flush();
  assert.equal(read(f.v).permitHeld, false);
  assert.equal(read(f.v).entries[0]!.outcome, 'UNKNOWN');
  assert.equal(s.read().state, 'paused');
  assert.equal(read(f.v).entries.length, 1);
});

for (const action of ['purge', 'consent', 'revoke'] as const)
  test(`${action} immediately cancels owner, preserves consumption; original late settlement cannot succeed`, async (t) => {
    const f = fixture(t);
    const source = f.v.store.acceptEvent(f.scope, {
      source: 'synthetic',
      eventKey: 'event',
      evidence: {
        speakerId: 'subject',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'synthetic',
        occurredAt: null,
      },
    });
    f.v.createEndogenousControl(f.scope, limits);
    const pending = deferred();
    let signal: AbortSignal | undefined;
    const s = f.v.openEndogenousControl((request) => {
      signal = request.signal;
      return pending.promise;
    });
    s.resume();
    if (action === 'purge') f.v.store.purge(f.scope);
    else if (action === 'consent') f.v.store.setLearningConsent(f.scope, true);
    else f.v.store.revoke(f.scope, source);
    assert.equal(signal!.aborted, true);
    assert.equal(s.read().timerPending, false);
    assert.equal(read(f.v).stop, 'FENCED');
    assert.equal(read(f.v).permitHeld, true);
    pending.resolve(answer);
    await flush();
    assert.equal(read(f.v).permitHeld, false);
    assert.equal(read(f.v).entries[0]!.outcome, 'UNKNOWN');
    assert.equal(read(f.v).entries.length, 1);
    assert.throws(() => s.resume(), /E1_OWNER_CLOSED/);
    const retained = f.v.store.endogenousControl();
    f.v.close();
    const reopened = AnchoredVault.open(f.config, 2);
    t.after(() => reopened.close());
    assert.equal(reopened.store.endogenousControl(), retained);
    const current = reopened.store.ensureScope(who);
    reopened.store.acceptEvent(current, {
      source: 'synthetic',
      eventKey: 'after-reopen',
      evidence: {
        speakerId: 'subject',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'synthetic current core data',
        occurredAt: null,
      },
    });
    assert.throws(() => reopened.openEndogenousControl(async () => answer), /E1_CONTROL_SCOPE/);
    assert.throws(() => reopened.createEndogenousControl(current), /E1_CONTROL_SCOPE/);
    reopened.exportBackup(join(f.root, 'fenced-backup'));
    assert.equal(reopened.store.endogenousControl(), retained); // exact original binding, consumption and held bit
  });

for (const [mode, exit] of [
  ['reserve-crash', 71],
  ['dispatch-crash', 72],
  ['terminal-crash', 73],
] as const)
  test(`real child ${mode}: next process refuses inherited work and retains full consumed allocation`, (t) => {
    const f = fixture(t);
    const initial = f.v.createEndogenousControl(f.scope, limits);
    f.v.close();
    const crashed = child(f, mode);
    assert.equal(crashed.status, exit, crashed.stderr + crashed.stdout);
    const inspect = child(f, 'inspect');
    assert.equal(inspect.status, 0, inspect.stderr + inspect.stdout);
    const r = JSON.parse(inspect.stdout);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].decisionId, `${initial.controlId}:1`);
    assert.equal(r.entries[0].outcome, 'UNKNOWN');
    assert.equal(r.permitHeld, true);
    assert.equal(r.stop, 'RECONCILE_REQUIRED');
    const refused = child(f, 'normal');
    assert.equal(refused.status, 4);
    assert.match(refused.stdout, /E1_RECONCILE_REQUIRED/);
  });

test('another real process cannot claim the open vault writer', (t) => {
  const f = fixture(t);
  f.v.createEndogenousControl(f.scope, limits);
  const other = child(f, 'normal');
  assert.equal(other.status, 4);
  assert.match(other.stdout, /ANCHOR_WRITER_BUSY/);
  assert.equal(read(f.v).entries.length, 0);
});

test('cutover fences a still-live generation and its pending raw observer', async (t) => {
  const f = fixture(t);
  f.v.createEndogenousControl(f.scope, limits);
  const pending = deferred(),
    s = f.v.openEndogenousControl(() => pending.promise);
  s.resume();
  const backup = join(f.root, 'backup');
  f.v.exportBackup(backup);
  const target = join(f.root, 'restored');
  AnchoredVault.restoreBackup({
    backupDirectory: backup,
    targetDirectory: target,
    storageDomain: f.config.storageDomain,
    authority: f.authority,
    keys: f.keys,
    maxCalls: 2,
    operationId: 'restore-live',
  });
  pending.resolve(answer);
  await flush();
  assert.equal(s.read().state, 'faulted');
  assert.equal(s.read().timerPending, false);
  const next = AnchoredVault.open({ ...f.config, directory: target }, 2);
  t.after(() => next.close());
  assert.equal(read(next).entries[0]!.outcome, 'UNKNOWN');
  assert.equal(read(next).permitHeld, true);
  assert.throws(() => next.openEndogenousControl(async () => answer), /E1_RECONCILE_REQUIRED/);
});

test('stop persistence failure leaves local cancellation and a poisoned vault', async (t) => {
  let failWrite = false;
  const f = fixture(t, 1, (p) => {
    if (failWrite && p === 'stage-written') throw new Error('synthetic stop failure');
  });
  f.v.createEndogenousControl(f.scope, limits);
  const pending = deferred();
  let signal: AbortSignal | undefined;
  const s = f.v.openEndogenousControl((r) => {
    signal = r.signal;
    return pending.promise;
  });
  s.resume();
  failWrite = true;
  s.pause();
  assert.equal(signal!.aborted, true);
  assert.equal(s.read().state, 'faulted');
  assert.equal(s.read().timerPending, false);
  assert.throws(() => f.v.store.endogenousControl(), /ANCHOR_UNAVAILABLE/);
  pending.resolve(answer);
  await flush();
  assert.equal(s.read().entries[0]!.outcome, 'UNKNOWN');
});

test('unknown control versions and identity changes reject, without an automatic replacement record', (t) => {
  const f = fixture(t);
  f.v.createEndogenousControl(f.scope, limits);
  const original = f.v.store.endogenousControl()!;
  const altered = JSON.stringify({ ...JSON.parse(original), version: 2 });
  assert.throws(() => bootControl(altered, (id) => f.v.store.scope(id), f.v.head), /E1_CONTROL_INVALID/);
  assert.equal(f.v.store.endogenousControl(), original);
  const r = parseControl(original);
  r.authorityId = 'other-authority';
  assert.throws(() => bootControl(encodeControl(r), (id) => f.v.store.scope(id), f.v.head), /E1_CONTROL_IDENTITY/);
  assert.throws(() => f.v.createEndogenousControl(f.scope), /E1_CONTROL_EXISTS/);
});

test('raw store roundtrip carries the record but cannot silently rebind its stale runtime', (t) => {
  const f = fixture(t);
  f.v.createEndogenousControl(f.scope, limits);
  const image = f.v.store.snapshot(),
    raw = new MemoryStore(':memory:', { image });
  image.fill(0);
  const carried = raw.endogenousControl()!;
  assert.equal(parseControl(carried).runtimeEpoch + 1, raw.scope(f.scope.id).runtimeEpoch);
  assert.throws(() => bootControl(carried, (id) => raw.scope(id), f.v.head), /E1_CONTROL_SCOPE/);
  raw.close();
});

test('schema migration, restore/rekey and lossless repack retain the fixed metadata cell', (t) => {
  const f = fixture(t);
  const initial = f.v.createEndogenousControl(f.scope, limits);
  // Add and release disposable pages in the synthetic image so physical repack has a real benefit.
  const image = f.v.store.snapshot(),
    scratch = new DatabaseSync(':memory:');
  scratch.deserialize(image);
  scratch.exec(
    'CREATE TABLE disposable(value BLOB); INSERT INTO disposable VALUES (zeroblob(524288)); DROP TABLE disposable',
  );
  const bloated = scratch.serialize();
  scratch.close();
  const runtimeRefusal = (error: unknown) =>
    error instanceof CoreError && error.code === 'REPACK_RUNTIME' && error.message === 'REPACK_RUNTIME';
  const probe = new DatabaseSync(':memory:');
  let repackSupported = true;
  try {
    configureRepackRuntime(probe);
  } catch (error) {
    if (!runtimeRefusal(error)) throw error;
    repackSupported = false;
  } finally {
    probe.close();
  }
  t.diagnostic(`repack capability: ${repackSupported ? 'SUPPORTED' : 'UNSUPPORTED_REAL_REFUSAL'}`);
  if (repackSupported) {
    const repacked = repackMemoryImage(bloated, 1);
    const db = new DatabaseSync(':memory:');
    db.deserialize(repacked);
    assert.equal(
      db.prepare('SELECT value FROM meta WHERE key=?').get(ENDOGENOUS_CONTROL_KEY)!.value,
      f.v.store.endogenousControl(),
    );
    assert.ok(fingerprintMemoryDatabase(db, 1));
    db.close();
    repacked.fill(0);
  } else {
    const before = sha(bloated),
      exec = DatabaseSync.prototype.exec;
    let vacuumCalls = 0;
    DatabaseSync.prototype.exec = function (sql: string) {
      if (/\bVACUUM\b/i.test(sql)) vacuumCalls++;
      return exec.call(this, sql);
    };
    try {
      assert.throws(() => repackMemoryImage(bloated, 1), runtimeRefusal);
    } finally {
      DatabaseSync.prototype.exec = exec;
    }
    assert.equal(vacuumCalls, 0, 'unsupported runtime must not execute VACUUM');
    assert.equal(sha(bloated), before, 'runtime refusal must preserve the source image');
  }
  image.fill(0);
  bloated.fill(0);
  const backup = join(f.root, 'backup');
  f.v.exportBackup(backup);
  f.v.close();
  const target = join(f.root, 'schema2');
  AnchoredVault.migrateBackup({
    backupDirectory: backup,
    targetDirectory: target,
    storageDomain: f.config.storageDomain,
    authority: f.authority,
    keys: f.keys,
    maxCalls: 2,
    operationId: 'migrate-e1',
    targetSchema: 2,
  });
  const migrated = AnchoredVault.open({ ...f.config, directory: target, schemaVersion: 2 }, 2);
  assert.equal(read(migrated).controlId, initial.controlId);
  assert.deepEqual(read(migrated).limits, initial.limits);
  const second = join(f.root, 'backup2');
  migrated.exportBackup(second);
  migrated.close();
  const rekeyed = join(f.root, 'rekeyed'),
    newStorageDEK = randomBytes(32);
  AnchoredVault.rekeyBackup({
    backupDirectory: second,
    targetDirectory: rekeyed,
    storageDomain: f.config.storageDomain,
    authority: f.authority,
    keys: f.keys,
    maxCalls: 2,
    operationId: 'rekey-e1',
    newStorageDEK,
  });
  const reopened = AnchoredVault.open(
    { ...f.config, directory: rekeyed, schemaVersion: 2, keys: { ...f.keys, keyEpoch: 2, storageDEK: newStorageDEK } },
    2,
  );
  t.after(() => reopened.close());
  assert.equal(read(reopened).controlId, initial.controlId);
  assert.equal(read(reopened).expiresAt, initial.expiresAt);
});

test('fixed wall expiry survives pause/reopen and no expired call or missed wake is replayed', async (t) => {
  let wall = 1000,
    mono = 0;
  const clock = { wall: () => wall, monotonic: () => mono };
  const f = fixture(t, 1, undefined, clock);
  f.v.createEndogenousControl(f.scope, limits);
  const s = f.v.openEndogenousControl(async () => answer);
  s.resume();
  await flush();
  s.pause();
  f.v.close();
  wall += limits.maxDurationMs;
  mono += limits.maxDurationMs;
  const v = AnchoredVault.open(f.config, 2, { clock });
  t.after(() => v.close());
  let calls = 0;
  const reopened = v.openEndogenousControl(async () => {
    calls++;
    return answer;
  });
  reopened.resume();
  assert.equal(calls, 0);
  assert.equal(reopened.read().state, 'exhausted');
  assert.equal(read(v).entries.length, 1);
  assert.equal(read(v).stop, 'EXHAUSTED');
});

test('expiry before reservation stops E1 without consuming a call or disabling Core', (t) => {
  let wall = 1000;
  const f = fixture(t, 1, undefined, { wall: () => wall, monotonic: () => 0 });
  f.v.createEndogenousControl(f.scope, limits);
  let calls = 0;
  const s = f.v.openEndogenousControl(async () => {
    calls++;
    return answer;
  });
  wall += limits.maxDurationMs;
  s.resume();
  assert.equal(calls, 0);
  assert.equal(s.read().state, 'faulted');
  assert.equal(s.read().timerPending, false);
  assert.equal(s.read().callsConsumed, 0);
  assert.equal(s.read().actualPending, false);
  assert.equal(read(f.v).entries.length, 0);
  assert.equal(read(f.v).permitHeld, false);
  assert.equal(read(f.v).stop, 'EXHAUSTED');
  assert.throws(() => s.resume(), /E1_OWNER_CLOSED/);
  assertCoreUsable(f, 'pre-reserve-expiry-backup');
  f.v.close();
  const reopened = AnchoredVault.open(f.config, 2, { clock: { wall: () => wall, monotonic: () => 0 } });
  t.after(() => reopened.close());
  assert.throws(() => reopened.openEndogenousControl(async () => answer), /E1_CONTROL_STOPPED/);
  assert.equal(read(reopened).entries.length, 0);
});

test('expiry after committed reservation keeps UNKNOWN/held and Core available; wall rollback still rejects', (t) => {
  let wall = 1000,
    advance = false;
  const f = fixture(
    t,
    1,
    (p) => {
      if (advance && p === 'finalized') wall += 6000;
    },
    { wall: () => wall, monotonic: () => 0 },
  );
  f.v.createEndogenousControl(f.scope, limits);
  let calls = 0;
  const s = f.v.openEndogenousControl(async () => {
    calls++;
    return answer;
  });
  advance = true;
  s.resume();
  assert.equal(calls, 0);
  assert.equal(s.read().state, 'faulted');
  assert.equal(s.read().callsConsumed, 1);
  assert.equal(s.read().timerPending, false);
  assert.equal(read(f.v).entries[0]!.outcome, 'UNKNOWN');
  assert.equal(read(f.v).permitHeld, true);
  assert.equal(read(f.v).entries.length, 1);
  assert.equal(read(f.v).stop, 'EXHAUSTED');
  assert.throws(() => s.resume(), /E1_OWNER_CLOSED/);
  advance = false;
  assertCoreUsable(f, 'post-reserve-expiry-backup');
  f.v.close();
  const reopened = AnchoredVault.open(f.config, 2, { clock: { wall: () => wall, monotonic: () => 0 } });
  assert.throws(() => reopened.openEndogenousControl(async () => answer), /E1_RECONCILE_REQUIRED/);
  assert.equal(read(reopened).entries.length, 1);
  assert.equal(read(reopened).permitHeld, true);
  reopened.close();
  wall = 999;
  assert.throws(
    () => AnchoredVault.open(f.config, 2, { clock: { wall: () => wall, monotonic: () => 0 } }),
    /ANCHOR_CLOCK_ROLLBACK/,
  );
});

for (const at of ['native-settlement', 'terminal-commit'] as const)
  test(`expiry at ${at} persists UNKNOWN, releases only the actual settled permit, and preserves Core`, async (t) => {
    let wall = 1000,
      active = false,
      finalized = 0;
    const f = fixture(
      t,
      1,
      (p) => {
        if (active && p === 'finalized' && ++finalized === 3 && at === 'terminal-commit') wall += limits.maxDurationMs;
      },
      { wall: () => wall, monotonic: () => 0 },
    );
    f.v.createEndogenousControl(f.scope, limits);
    const pending = deferred();
    let calls = 0;
    const s = f.v.openEndogenousControl(() => {
      calls++;
      return pending.promise;
    });
    active = true;
    s.resume();
    assert.equal(read(f.v).permitHeld, true);
    if (at === 'native-settlement') wall += limits.maxDurationMs;
    pending.resolve(answer);
    await flush();
    active = false;
    assert.equal(calls, 1);
    assert.equal(s.read().state, 'faulted');
    assert.equal(s.read().timerPending, false);
    assert.equal(s.read().entries[0]!.outcome, 'UNKNOWN');
    assert.equal(s.read().actualPending, false);
    assert.equal(read(f.v).entries[0]!.outcome, 'UNKNOWN');
    assert.equal(read(f.v).permitHeld, false);
    assert.equal(read(f.v).entries.length, 1);
    assert.equal(read(f.v).stop, 'EXHAUSTED');
    assert.throws(() => s.resume(), /E1_OWNER_CLOSED/);
    assertCoreUsable(f, `${at}-expiry-backup`);
    f.v.close();
    const reopened = AnchoredVault.open(f.config, 2, { clock: { wall: () => wall, monotonic: () => 0 } });
    t.after(() => reopened.close());
    assert.throws(() => reopened.openEndogenousControl(async () => answer), /E1_CONTROL_STOPPED/);
    assert.equal(read(reopened).entries[0]!.outcome, 'UNKNOWN');
  });

test('an uncertain stop write after normal expiry still poisons Core', (t) => {
  let wall = 1000,
    active = false,
    reserved = false;
  const f = fixture(
    t,
    1,
    (p) => {
      if (!active) return;
      if (p === 'stage-written' && reserved) throw new Error('synthetic expiry stop write failure');
      if (p === 'finalized') {
        reserved = true;
        wall += 6000;
      }
    },
    { wall: () => wall, monotonic: () => 0 },
  );
  f.v.createEndogenousControl(f.scope, limits);
  let calls = 0;
  const s = f.v.openEndogenousControl(async () => {
    calls++;
    return answer;
  });
  active = true;
  s.resume();
  assert.equal(calls, 0);
  assert.equal(s.read().state, 'faulted');
  assert.equal(s.read().callsConsumed, 1);
  assert.equal(s.read().timerPending, false);
  assert.throws(() => f.v.store.scope(f.scope.id), /ANCHOR_UNAVAILABLE/);
});

test('synchronous durable port throw has no settlement witness and retains its permit across reopen', (t) => {
  const f = fixture(t);
  f.v.createEndogenousControl(f.scope, limits);
  const s = f.v.openEndogenousControl(() => {
    throw new Error('synthetic');
  });
  s.resume();
  assert.equal(read(f.v).entries[0]!.outcome, 'UNKNOWN');
  assert.equal(read(f.v).permitHeld, true);
  assert.equal(s.read().actualPending, true);
  f.v.close();
  const reopened = AnchoredVault.open(f.config, 2);
  t.after(() => reopened.close());
  assert.throws(() => reopened.openEndogenousControl(async () => answer), /E1_RECONCILE_REQUIRED/);
});

test('terminal persistence failure never accepts REST or schedules its next wake', async (t) => {
  let active = false,
    finalized = 0;
  const f = fixture(t, 1, (p) => {
    if (!active) return;
    if (p === 'finalized') finalized++;
    if (p === 'stage-written' && finalized === 2) throw new Error('synthetic terminal commit failure');
  });
  f.v.createEndogenousControl(f.scope, limits);
  const s = f.v.openEndogenousControl(async () => '{"version":1,"choice":"REST","nextWakeInMs":10}');
  active = true;
  s.resume();
  await flush();
  assert.equal(s.read().state, 'faulted');
  assert.equal(s.read().entries[0]!.outcome, 'UNKNOWN');
  assert.equal(s.read().timerPending, false);
  assert.throws(() => f.v.store.endogenousControl(), /ANCHOR_UNAVAILABLE/);
});

for (const kind of ['foreign-identity', 'unknown-version', 'old-runtime'] as const)
  test(`legacy ${kind} control preserves Core read/write/backup while refusing all E1 entrypoints`, (t) => {
    const f = fixture(t);
    const initial = f.v.createEndogenousControl(f.scope, limits),
      originalImage = f.v.store.snapshot();
    const synthetic = new DatabaseSync(':memory:');
    synthetic.deserialize(originalImage);
    originalImage.fill(0);
    // Fixture-only metadata construction. Old-runtime names the target but cannot bind its newer epoch.
    const carried = JSON.stringify({
      ...initial,
      ...(kind === 'unknown-version' ? { version: 2 } : {}),
      ...(kind === 'old-runtime' ? { authorityId: 'another-authority', vaultId: 'new-vault' } : {}),
    });
    synthetic.prepare('UPDATE meta SET value=? WHERE key=?').run(carried, ENDOGENOUS_CONTROL_KEY);
    const image = synthetic.serialize();
    synthetic.close();
    const source = join(f.root, 'synthetic-legacy');
    mkdirSync(source);
    const key = randomBytes(32),
      config = { directory: source, identity: 'synthetic', keyBase64: key.toString('base64') };
    const empty = new DurableMemory(config, 2);
    empty.close();
    // Synthetic fixture construction: replace its fresh empty encrypted image with the known test graph.
    const db = new DatabaseSync(join(source, 'authority.sqlite'));
    const latest = readAuthority(db, key, 'synthetic', 2).latest!;
    const checkpoint = seal(
      {
        version: 1,
        identity: 'synthetic',
        sequence: latest.sequence,
        image: Buffer.from(image).toString('base64'),
        safety: latest.safety,
        revocationHighWater: 0,
      },
      'checkpoint',
      key,
    );
    image.fill(0);
    latest.sha256 = sha(checkpoint);
    writeFileSync(join(source, latest.checkpoint), checkpoint);
    db.prepare('UPDATE entries SET sealed=? WHERE sequence=?').run(seal(latest, 'authority', key), latest.sequence);
    db.close();
    const legacy = new DurableMemory(config, 2);
    assert.equal(legacy.store.endogenousControl(), carried);
    assert.equal(legacy.store.scope(f.scope.id).runtimeEpoch, initial.runtimeEpoch + 1);
    const backup = join(f.root, 'legacy-backup');
    legacy.exportBackup(backup);
    const head = legacy.head;
    legacy.close();
    const ac = {
      directory: join(f.root, 'import-authority'),
      authorityId: 'another-authority',
      custodyDomain: 'another-custody',
    };
    let authority = LocalSqliteAuthority.create(ac);
    authority.close();
    LocalSqliteAuthority.upgradeSchema(ac, 'operator-attested-stopped');
    authority = LocalSqliteAuthority.open(ac);
    t.after(() => authority.close());
    const request = {
      backupDirectory: backup,
      legacyKey: key,
      identity: 'synthetic',
      expectedMaxCalls: 2,
      declaredHead: head,
      trust: { policy: 'trusted-lower-bound' as const, minimumHead: head },
    };
    const inspected = AnchoredVault.inspectLegacyM2(request),
      newStorageDEK = randomBytes(32),
      target = join(f.root, 'legacy-imported');
    const receipt = AnchoredVault.importLegacyM2({
      ...request,
      sourceFreeze: inspected.sourceFreeze,
      authority,
      vaultId: 'new-vault',
      targetDirectory: target,
      storageDomain: 'payload',
      storageProfile: 'blocks-br4-v1',
      newStorageDEK,
      operationId: inspected.migrationId,
    });
    const importedKeys = { version: 2 as const, keyEpoch: 1, storageDEK: newStorageDEK, ingressKey: key };
    const decoded = reconstruct(receipt.newHead, directoryReader(target), importedKeys, 2);
    const imported = new DatabaseSync(':memory:');
    imported.deserialize(decoded.image);
    assert.equal(imported.prepare('SELECT value FROM meta WHERE key=?').get(ENDOGENOUS_CONTROL_KEY)!.value, carried);
    imported.close();
    decoded.image.fill(0);
    decoded.ledger.close();
    const importedConfig = {
      directory: target,
      authority,
      vaultId: 'new-vault',
      identity: 'synthetic',
      storageDomain: 'payload',
      storageProfile: 'blocks-br4-v1' as const,
      keys: importedKeys,
    };
    const live = AnchoredVault.open(importedConfig, 2);
    t.after(() => live.close());
    assert.equal(live.store.endogenousControl(), carried);
    assert.throws(() => live.openEndogenousControl(async () => answer), /LEGACY_ADMISSION_REQUIRED/);
    authority.admitLegacyImport({
      migrationId: inspected.migrationId,
      head: live.head,
      operationId: 'admit-carried-control',
      operatorId: 'synthetic',
      attestation: 'operator-attested-stopped',
    });
    const current = live.store.ensureScope(who);
    live.store.acceptEvent(current, {
      source: 'synthetic',
      eventKey: 'import-core-write',
      evidence: {
        speakerId: 'subject',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'synthetic admitted core data',
        occurredAt: null,
      },
    });
    const rejection =
      kind === 'foreign-identity'
        ? /E1_CONTROL_IDENTITY/
        : kind === 'unknown-version'
          ? /E1_CONTROL_INVALID/
          : /E1_CONTROL_SCOPE/;
    assert.throws(() => live.openEndogenousControl(async () => answer), rejection);
    assert.throws(() => live.createEndogenousControl(current), rejection);
    const carriedBackup = join(f.root, 'carried-control-backup');
    live.exportBackup(carriedBackup);
    assert.equal(live.store.endogenousControl(), carried);
    live.close();
    if (kind === 'foreign-identity') {
      const restoredPath = join(f.root, 'carried-control-restored');
      AnchoredVault.restoreBackup({
        backupDirectory: carriedBackup,
        targetDirectory: restoredPath,
        storageDomain: 'payload',
        authority,
        keys: importedKeys,
        maxCalls: 2,
        operationId: 'restore-carried-control',
      });
      const restored = AnchoredVault.open({ ...importedConfig, directory: restoredPath }, 2);
      t.after(() => restored.close());
      assert.equal(restored.store.endogenousControl(), carried);
      assert.equal(restored.store.ensureScope(who).id, current.id);
      assert.throws(() => restored.openEndogenousControl(async () => answer), rejection);
    }
  });
