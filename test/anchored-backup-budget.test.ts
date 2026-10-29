import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredConfig } from '../src/anchored-vault.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import type { StorageProfile } from '../src/anchored-codec.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { COLD_SAFETY_PROFILE } from '../src/safety-format.ts';
import { parseControl } from '../src/endogenous-durable.ts';
import { sha } from '../src/durable-codec.ts';

const clock = { wall: () => 100, monotonic: () => 0 };
const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'test' };
const event = {
  source: 'synthetic',
  eventKey: 'revoked-event',
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: 'synthetic backup history',
    occurredAt: null,
  },
};
const profiles = [undefined, 'blocks-br4-v1', 'full-br4-v1', 'blocks-br4-safety-br4-v1', COLD_SAFETY_PROFILE] as const;
function fixture(t: TestContext, profile?: StorageProfile) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aemc-backup-budget-合成-')));
  const authority = LocalSqliteAuthority.create({
    directory: join(root, 'authority'),
    authorityId: 'synthetic',
    custodyDomain: 'independent',
  });
  const config: AnchoredConfig = {
    directory: join(root, 'vault'),
    vaultId: 'synthetic',
    identity: '合成🧪',
    storageDomain: 'payload',
    keys: generateKeySet(),
    authority,
    ...(profile ? { storageProfile: profile } : {}),
  };
  const v = AnchoredVault.create(config, 1, { clock }),
    handles = [v];
  t.after(() => {
    for (const h of handles.reverse()) h.close();
    authority.close();
  });
  t.diagnostic(`retained synthetic directory: ${root}`);
  return { root, authority, config, v, handles };
}
type Fixture = ReturnType<typeof fixture>;
const hashes = (directory: string) =>
  readdirSync(directory)
    .sort()
    .map((name) => [name, sha(readFileSync(join(directory, name)))]);
const verify = (f: Fixture, backupDirectory: string) =>
  AnchoredVault.verifyBackup({ backupDirectory, authority: f.authority, keys: f.config.keys, maxCalls: 1 });
const restore = (f: Fixture, backupDirectory: string) =>
  AnchoredVault.restoreBackup({
    backupDirectory,
    targetDirectory: join(f.root, 'restored'),
    authority: f.authority,
    keys: f.config.keys,
    maxCalls: 1,
    storageDomain: 'payload',
    operationId: 'restore',
  });
function archive(f: Fixture) {
  const r = AnchoredVault.archiveTerminalSafety({
    authority: f.authority,
    vaultId: f.config.vaultId,
    keys: f.config.keys,
    maxCalls: 1,
    targetDirectory: join(f.root, 'archived'),
    storageDomain: 'payload',
    operationId: 'archive',
  });
  f.v.close();
  f.config = { ...f.config, directory: r.newHead.directory };
  f.v = AnchoredVault.open(f.config, 1, { clock });
  f.handles.push(f.v);
  assert.ok(f.v.head.safetyCold);
}
function noTargetWrites(t: TestContext, target: string, body: () => void) {
  const writes: string[] = [],
    mkdir = fs.mkdirSync,
    open = fs.openSync;
  const inside = (path: unknown) => typeof path === 'string' && (path === target || path.startsWith(target + sep));
  const m = t.mock.method(fs, 'mkdirSync', (...args: Parameters<typeof fs.mkdirSync>) => {
    if (inside(args[0])) writes.push('mkdir');
    return Reflect.apply(mkdir, fs, args);
  });
  const o = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (inside(args[0]) && args[1] !== 'r') writes.push('open');
    return Reflect.apply(open, fs, args);
  });
  syncBuiltinESMExports();
  try {
    body();
    assert.deepEqual(writes, []);
  } finally {
    m.mock.restore();
    o.mock.restore();
    syncBuiltinESMExports();
  }
}

for (const profile of profiles)
  test(`${profile ?? 'v2 embedded'}: complete UTF-8 output N admits N, refuses N-1 and metadata omissions; recovery retains history`, async (t) => {
    const f = fixture(t, profile);
    f.v.claim('unknown', 'payload');
    f.v.reserve('unknown');
    f.v.terminal('unknown', 'failed');
    const scope = f.v.store.ensureScope(who),
      ref = f.v.store.acceptEvent(scope, event);
    f.v.createEndogenousControl(scope, {
      maxCalls: 1,
      maxDurationMs: 60_000,
      callTimeoutMs: 5000,
      maxResultBytes: 256,
    });
    let settle!: (answer: string) => void;
    const pending = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const session = f.v.openEndogenousControl(() => pending);
    session.resume();
    f.v.store.revoke(scope, ref);
    settle('{"version":1,"choice":"REST"}');
    await Promise.resolve();
    await Promise.resolve();
    session.close();
    if (profile === COLD_SAFETY_PROFILE) archive(f);
    const control = f.v.store.endogenousControl()!,
      parsed = parseControl(control);
    assert.equal(parsed.entries[0]!.outcome, 'UNKNOWN');
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.permitHeld, false);
    assert.equal(parsed.stop, 'FENCED');
    assert.equal(f.v.status.unknownRequests, 1);
    assert.equal(f.v.reserved, 1);
    const head = f.v.head,
      source = hashes(f.config.directory),
      authority = hashes(f.authority.directory),
      row = f.authority.inspect(f.config.vaultId);
    // The omitted-budget export is the independently measured, unchanged wire format.
    const baseline = join(f.root, 'baseline'),
      receipt = f.v.exportBackup(baseline),
      names = readdirSync(baseline);
    const total = names.reduce((n, name) => n + statSync(join(baseline, name)).size, 0);
    const current = readFileSync(join(baseline, 'current-state.json')),
      metadata = readFileSync(join(baseline, 'backup.json'));
    assert.ok(current.length > current.toString('utf8').length);
    assert.ok(metadata.length > metadata.toString('utf8').length);
    const manifest = JSON.parse(current.toString('utf8'));
    const dataOnly = profile
      ? total - current.length - metadata.length
      : Buffer.from(manifest.checkpoint, 'base64').length + Buffer.from(manifest.record, 'base64').length;
    if (profile)
      assert.deepEqual(
        names.sort(),
        [...manifest.files.map((file: { name: string }) => file.name), 'backup.json', 'current-state.json'].sort(),
      );
    else assert.deepEqual(names.sort(), ['backup.json', 'current-state.json']);
    for (const [i, budget] of [
      ...new Set([0, total - 1, dataOnly, total - current.length, total - metadata.length]),
    ].entries()) {
      const target = join(f.root, `refused-${i}`);
      noTargetWrites(t, target, () =>
        assert.throws(() => f.v.exportBackup(target, budget), /ANCHOR_BACKUP_OUTPUT_LIMIT/),
      );
      assert.equal(existsSync(target), false);
    }
    const exact = join(f.root, 'exact'),
      explicitUndefined = join(f.root, 'undefined');
    assert.deepEqual(f.v.exportBackup(exact, total), receipt);
    assert.deepEqual(hashes(exact), hashes(baseline));
    assert.deepEqual(f.v.exportBackup(explicitUndefined, undefined), receipt);
    assert.deepEqual(hashes(explicitUndefined), hashes(baseline));
    assert.deepEqual(verify(f, exact), receipt);
    assert.deepEqual(f.v.head, head);
    assert.equal(f.v.store.endogenousControl(), control);
    assert.deepEqual(f.authority.inspect(f.config.vaultId), row);
    assert.deepEqual(hashes(f.config.directory), source);
    assert.deepEqual(hashes(f.authority.directory), authority);
    const restored = restore(f, exact);
    assert.throws(() => f.v.exportBackup(join(f.root, 'stale'), 0), /ANCHOR_FENCED/);
    assert.equal(existsSync(join(f.root, 'stale')), false);
    assert.deepEqual(hashes(f.config.directory), source);
    f.v.close();
    const next = AnchoredVault.open({ ...f.config, directory: restored.newHead.directory }, 1, { clock });
    f.handles.push(next);
    assert.equal(next.reserved, 1);
    assert.equal(next.status.unknownRequests, 1);
    assert.equal(next.store.revocationHighWater(), 1);
    assert.equal(next.store.endogenousControl(), control);
    assert.throws(() => next.claim('unknown', 'payload'), /INTERACTION_TERMINATED/);
    assert.throws(() => next.claim('unknown', 'changed'), /INTERACTION_IDEMPOTENCY_CONFLICT/);
    assert.throws(() => next.reserve('unknown'), /REQUEST_BUDGET_EXHAUSTED/);
    assert.deepEqual(next.store.acceptEvent(next.store.scope(scope.id), event), { ...ref, currentStatus: 'revoked' });
    assert.throws(() => next.openEndogenousControl(async () => '{"version":1,"choice":"REST"}'), /E1_CONTROL_SCOPE/);
  });

test('invalid budgets are strict primitive nonnegative safe integers, without coercion or handle poisoning', (t) => {
  const f = fixture(t);
  let touched = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        touched++;
        throw Error('must not inspect');
      },
    },
  );
  const invalid: unknown[] = [
    null,
    true,
    '1',
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    Symbol('budget'),
    hostile,
  ];
  for (const [i, budget] of invalid.entries()) {
    const target = join(f.root, `invalid-${i}`);
    noTargetWrites(t, target, () => assert.throws(() => f.v.exportBackup(target, budget as number), /INVALID_INPUT/));
    assert.equal(existsSync(target), false);
  }
  assert.equal(touched, 0);
  f.v.exportBackup(join(f.root, 'safe-maximum'), Number.MAX_SAFE_INTEGER);
  const zero = join(f.root, 'negative-zero');
  assert.throws(() => f.v.exportBackup(zero, -0), /ANCHOR_BACKUP_OUTPUT_LIMIT/);
  assert.equal(existsSync(zero), false);
  f.v.close();
  assert.throws(() => f.v.exportBackup(join(f.root, 'closed'), NaN), /ANCHOR_UNAVAILABLE/);
});

test('current image and existing-target gates precede budget errors, preserving source validation order', (t) => {
  const f = fixture(t),
    existing = join(f.root, 'existing');
  mkdirSync(existing);
  for (const budget of [0, NaN]) assert.throws(() => f.v.exportBackup(existing, budget), /ANCHOR_TARGET_EXISTS/);
  assert.deepEqual(readdirSync(existing), []);
  const path = join(f.config.directory, `checkpoint-${f.v.head.sequence}.bin`);
  renameSync(path, path + '.retained');
  for (const target of [existing, join(f.root, 'missing-image')]) {
    assert.throws(() => f.v.exportBackup(target, 0), /ENOENT/);
  }
  assert.equal(existsSync(join(f.root, 'missing-image')), false);
});

test('missing mandatory cold segment keeps its original refusal before budget and target checks', (t) => {
  const f = fixture(t, COLD_SAFETY_PROFILE);
  f.v.claim('old', 'payload');
  f.v.terminal('old', 'failed');
  archive(f);
  const head = f.v.head,
    path = join(f.config.directory, head.safetyCold!.file);
  renameSync(path, path + '.retained');
  let original: unknown;
  try {
    f.v.exportBackup(join(f.root, 'unbounded'));
  } catch (error) {
    original = error;
  }
  assert.ok(original instanceof Error);
  for (const budget of [0, NaN]) {
    const target = join(f.root, `cold-${String(budget)}`);
    noTargetWrites(t, target, () =>
      assert.throws(
        () => f.v.exportBackup(target, budget),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, original.message);
          return true;
        },
      ),
    );
    assert.equal(existsSync(target), false);
  }
  assert.deepEqual(f.authority.inspect(f.config.vaultId)!.head, head);
});

test('admitted write failure retains partial output and original error without cleanup or another target attempt', (t) => {
  const f = fixture(t, 'blocks-br4-v1'),
    baseline = join(f.root, 'baseline');
  f.v.exportBackup(baseline);
  const total = readdirSync(baseline).reduce((n, name) => n + statSync(join(baseline, name)).size, 0);
  const source = hashes(f.config.directory),
    authority = hashes(f.authority.directory),
    head = f.v.head;
  const target = join(f.root, 'partial'),
    before = readdirSync(f.root).sort(),
    open = fs.openSync,
    write = fs.writeFileSync;
  const injected = Object.assign(new Error('synthetic backup disk write failed'), { code: 'ENOSPC' });
  let receiptFd = -1,
    attempts = 0;
  const o = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(open, fs, args);
    if (args[0] === join(target, 'backup.json')) receiptFd = fd;
    return fd;
  });
  const w = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === receiptFd) {
      attempts++;
      throw injected;
    }
    return Reflect.apply(write, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => f.v.exportBackup(target, total),
      (error) => error === injected,
    );
  } finally {
    o.mock.restore();
    w.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(attempts, 1);
  assert.deepEqual(readdirSync(f.root).sort(), [...before, 'partial'].sort());
  assert.deepEqual(
    readFileSync(join(target, 'current-state.json')),
    readFileSync(join(baseline, 'current-state.json')),
  );
  assert.equal(statSync(join(target, 'backup.json')).size, 0);
  assert.throws(() => verify(f, target), /ANCHOR_BACKUP/);
  const partial = hashes(target);
  assert.throws(() => f.v.exportBackup(target, total), /ANCHOR_TARGET_EXISTS/);
  assert.deepEqual(hashes(target), partial);
  assert.deepEqual(f.v.head, head);
  assert.deepEqual(hashes(f.config.directory), source);
  assert.deepEqual(hashes(f.authority.directory), authority);
});
