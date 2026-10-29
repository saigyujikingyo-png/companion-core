import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CanaryGate, CanaryLedger, scopeDigest, validateCanaryRecord } from '../src/tj1-ledger.ts';
import type { CanaryAuthority, CanaryLedgerMeta } from '../src/tj1-ledger.ts';
import { canonical, CanaryError, f64Bits, makeTensors, sha256, TARGET_WEIGHTS, TARGET_BIAS } from '../src/tj1-spec.ts';

const auth = (): CanaryAuthority => ({
  scopeId: 'fixture',
  generation: '0',
  consentRevision: '0',
  runtimeId: 'fixture-runtime',
  now: 1000,
  expiresAt: 2000,
  read: true,
  write: true,
  train: true,
  export: true,
});
const rejects = (fn: () => unknown, code?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof CanaryError && (!code || e.code === code));
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'companion-tj1-offline-')));
function fixture(t: TestContext) {
  const directory = fresh(),
    current = auth(),
    gate = new CanaryGate(() => current),
    meta: CanaryLedgerMeta = {
      logical: 'tj1-local-canary-v1',
      container: 'sqlite-event-ledger-v1',
      codec: 'identity-json-v1',
      lane: 'OFFLINE_FIXTURE',
      runId: 'fixture-run',
      attemptId: 'fixture-attempt',
      manifestDigest: 'a'.repeat(64),
      scopeDigest: scopeDigest(current),
    };
  const ledger = CanaryLedger.create(directory, gate, meta);
  t.after(() => ledger.close());
  return { directory, current, gate, meta, ledger };
}
const prepared = (j: CanaryLedger) => j.append('PREPARED', { manifestDigest: 'a'.repeat(64) }, 'HOST_CONTROL');
const consumed = (j: CanaryLedger) => j.append('LAUNCH_CONSUMED', { launchId: 'fixture-launch' }, 'HOST_CONTROL');
const ready = (j: CanaryLedger) =>
  j.append(
    'TRAINER_READY',
    { runtime: 'torch:2.11.0+cu128', rssBytes: '1000000', availableBytes: '2147483648' },
    'PINNED_TRAINER_OBSERVED',
  );
const step = (j: CanaryLedger, n: number) =>
  j.append(
    'STEP',
    {
      step: String(n),
      lossBits: f64Bits(0.5),
      rssBytes: '1000000',
      gradient: makeTensors(
        TARGET_WEIGHTS.map((x) => -x),
        TARGET_BIAS.map((x) => -x),
      ),
      tensors: makeTensors(
        TARGET_WEIGHTS.map((x) => 0.1 * x),
        TARGET_BIAS.map((x) => 0.1 * x),
      ),
    },
    'PINNED_TRAINER_OBSERVED',
  );
test('TJ1 fixture ledger stores only claims and reopens RECONCILE_REQUIRED with durable consumed state', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  consumed(f.ledger);
  ready(f.ledger);
  step(f.ledger, 1);
  f.ledger.close();
  const re = CanaryLedger.open(f.directory, new CanaryGate(() => ({ ...auth(), runtimeId: 'fresh' })));
  try {
    const view = re.read();
    assert.equal(view.assurance, 'RECORDED_CLAIMS_ONLY');
    assert.equal(view.recovery, 'RECONCILE_REQUIRED');
    assert.equal(view.meta.lane, 'OFFLINE_FIXTURE');
    assert.equal(view.projection.consumed, true);
    assert.equal(view.projection.steps, 1);
    rejects(() => consumed(re), 'TJ1_CONSUMED');
  } finally {
    re.close();
  }
});
test('TJ1 same event identity/digest is idempotent, different bytes conflict across reopen', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  consumed(f.ledger);
  const head = f.ledger.read().head;
  f.ledger.close();
  const re = CanaryLedger.open(f.directory, new CanaryGate(auth));
  try {
    re.append('LAUNCH_CONSUMED', { launchId: 'fixture-launch' }, 'HOST_CONTROL', null, 'LAUNCH_CONSUMED:2');
    assert.equal(re.read().head, head);
    rejects(
      () => re.append('LAUNCH_CONSUMED', { launchId: 'different' }, 'HOST_CONTROL', null, 'LAUNCH_CONSUMED:2'),
      'TJ1_CONFLICT',
    );
  } finally {
    re.close();
  }
});
test('TJ1 meta, appended payload and returned gate snapshots do not alias their callers', (t) => {
  const f = fixture(t),
    data = { manifestDigest: 'a'.repeat(64) };
  f.ledger.append('PREPARED', data, 'HOST_CONTROL');
  data.manifestDigest = 'b'.repeat(64);
  f.meta.manifestDigest = 'c'.repeat(64);
  assert.equal(f.ledger.read().meta.manifestDigest, 'a'.repeat(64));
  assert.equal(f.ledger.read().records[0]!.data.manifestDigest, 'a'.repeat(64));
  const received = f.gate.check('read');
  received.generation = '1';
  f.current.generation = '1';
  rejects(() => f.gate.check('read'), 'TJ1_AUTHORITY');
});
test('TJ1 terminal preserves observed effects and rejects late restart, changed terminal or forged success', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  consumed(f.ledger);
  ready(f.ledger);
  step(f.ledger, 1);
  rejects(
    () => f.ledger.append('TRAIN_TERMINAL', { outcome: 'COMPLETED', observedSteps: '64', exitCode: 0 }, 'HOST_CONTROL'),
    'TJ1_ORDER',
  );
  f.ledger.append('TRAIN_TERMINAL', { outcome: 'FAILED', observedSteps: '1', exitCode: 3221225477 }, 'HOST_CONTROL');
  assert.equal(f.ledger.read().projection.steps, 1);
  rejects(() => step(f.ledger, 2), 'TJ1_ORDER');
  rejects(
    () => f.ledger.append('TRAIN_TERMINAL', { outcome: 'COMPLETED', observedSteps: '1', exitCode: 0 }, 'HOST_CONTROL'),
    'TJ1_TERMINAL',
  );
  f.ledger.append(
    'OBSERVATION_END',
    {
      training: 'FAILED',
      delta: 'NOT_RUN',
      export: 'NOT_RUN',
      reload: 'NOT_RUN',
      evaluation: 'NOT_RUN',
      code: 'FIXTURE_FAILURE',
    },
    'HOST_CONTROL',
  );
  rejects(
    () => f.ledger.append('ARTIFACT', { name: 'weights.json', bytes: '1', sha256: 'b'.repeat(64) }, 'PARENT_VERIFIED'),
    'TJ1_TERMINAL',
  );
});
test('TJ1 independent evaluation failure cannot rewrite completed training', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  consumed(f.ledger);
  ready(f.ledger);
  for (let n = 1; n <= 64; n++) step(f.ledger, n);
  f.ledger.append('TRAIN_TERMINAL', { outcome: 'COMPLETED', observedSteps: '64', exitCode: 0 }, 'HOST_CONTROL');
  f.ledger.append(
    'EVALUATION',
    { result: 'FAIL', mseBits: f64Bits(1), baselineBits: f64Bits(0.5), predictionsDigest: 'c'.repeat(64) },
    'PARENT_VERIFIED',
  );
  f.ledger.append(
    'OBSERVATION_END',
    { training: 'COMPLETED', delta: 'PASS', export: 'PASS', reload: 'PASS', evaluation: 'FAIL', code: 'FIXTURE_ONLY' },
    'HOST_CONTROL',
  );
  assert.equal(f.ledger.read().projection.training, 'COMPLETED');
  assert.equal(f.ledger.read().meta.lane, 'OFFLINE_FIXTURE');
});
test('TJ1 process outcome references preserve fixed stage facts without becoming a training terminal', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  consumed(f.ledger);
  rejects(
    () =>
      f.ledger.append('PROCESS_OUTCOME', { stage: 'evaluator', bytes: '10', sha256: 'b'.repeat(64) }, 'HOST_CONTROL'),
    'TJ1_ORDER',
  );
  f.ledger.append('PROCESS_OUTCOME', { stage: 'trainer', bytes: '10', sha256: 'b'.repeat(64) }, 'HOST_CONTROL');
  assert.equal(f.ledger.read().projection.training, 'NOT_STARTED');
  assert.equal(f.ledger.read().projection.steps, 0);
  for (const right of ['train', 'export'] as const) {
    const current = auth();
    current[right] = false;
    const gate = new CanaryGate(() => current);
    gate.check('read');
    rejects(() => gate.check(right), 'TJ1_AUTHORITY');
    current[right] = true;
    rejects(() => gate.check('read'), 'TJ1_FENCED');
  }
});
test('TJ1 closed canonical schema cannot accept real-evidence tags, unknown fields or noncanonical bytes', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  const raw = canonical(f.ledger.read().records[0]);
  for (const bad of [
    raw.replace('"data":', '"assurance":"VERIFIED","data":'),
    ' ' + raw,
    raw.replace('OFFLINE_FIXTURE', 'IMPORTED_ACTUAL'),
    raw.replace('"sequence":"1"', '"sequence":"01"'),
  ])
    rejects(() => validateCanaryRecord(bad));
  rejects(() => f.ledger.append('PREPARED', { manifestDigest: 'b'.repeat(64) }, 'HOST_CONTROL'), 'TJ1_CONFLICT');
});
test('TJ1 permission denial, epochs, expiry, async and reentry permanently fence without exposing private error data', (t) => {
  for (const field of ['read', 'write', 'generation', 'runtimeId', 'now', 'expiresAt'] as const) {
    const f = fixture(t);
    prepared(f.ledger);
    if (field === 'read' || field === 'write') f.current[field] = false;
    if (field === 'generation') f.current.generation = '1';
    if (field === 'runtimeId') f.current.runtimeId = 'other';
    if (field === 'now') f.current.now = 999;
    if (field === 'expiresAt') f.current.expiresAt = 1000;
    rejects(() => (field === 'write' ? consumed(f.ledger) : f.ledger.read()), 'TJ1_AUTHORITY');
    Object.assign(f.current, auth());
    rejects(() => f.ledger.read(), 'TJ1_FENCED');
  }
  for (const callback of [
    () => ({ ...auth(), scopeId: 123 }),
    () => Promise.resolve(auth()),
    () => {
      throw Error('PRIVATE_EXCEPTION');
    },
  ])
    rejects(() => new CanaryGate(callback as unknown as () => CanaryAuthority).check('read'), 'TJ1_AUTHORITY');
  let gate: CanaryGate;
  gate = new CanaryGate(() => {
    try {
      gate.check('read');
    } catch {}
    return auth();
  });
  rejects(() => gate.check('read'), 'TJ1_AUTHORITY');
});
test('TJ1 missing middle row, incorrect digest and contradictory prepared binding are never skipped on reconstruction', (t) => {
  for (const mutation of ['gap', 'hash', 'manifest']) {
    const f = fixture(t);
    prepared(f.ledger);
    consumed(f.ledger);
    ready(f.ledger);
    f.ledger.close();
    const db = new DatabaseSync(join(f.directory, 'tj1-receipts.sqlite'));
    if (mutation === 'gap') db.exec('DELETE FROM events WHERE sequence=2');
    else if (mutation === 'hash') db.exec("UPDATE events SET digest='bad' WHERE sequence=2");
    else {
      const row = db.prepare('SELECT body,previous FROM events WHERE sequence=1').get()!;
      const e = JSON.parse(row.body as string);
      e.data.manifestDigest = 'b'.repeat(64);
      const body = canonical(e);
      db.prepare('UPDATE events SET body=?,digest=? WHERE sequence=1').run(body, sha256(row.previous + '\n' + body));
    }
    db.close();
    rejects(() => CanaryLedger.open(f.directory, new CanaryGate(auth)));
  }
});
test('TJ1 another opener is refused, external file change fences, and oversized SQLite inputs fail before opening', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  rejects(() => CanaryLedger.open(f.directory, new CanaryGate(auth)), 'TJ1_LOCKED');
  const before = readFileSync(join(f.directory, 'tj1-receipts.sqlite'));
  writeFileSync(join(f.directory, 'tj1-receipts.sqlite'), Buffer.concat([before, Buffer.from('x')]));
  rejects(() => f.ledger.read(), 'TJ1_CHANGED');
  rejects(() => f.ledger.read(), 'TJ1_FENCED');
  const directory = fresh();
  writeFileSync(join(directory, 'tj1-receipts.sqlite'), Buffer.alloc(4_194_305));
  rejects(() => CanaryLedger.open(directory, new CanaryGate(auth)), 'TJ1_PATH');
});
test('TJ1 read CLI requires an external current authority file and never authenticates cold fixture history', (t) => {
  const f = fixture(t);
  prepared(f.ledger);
  f.ledger.close();
  const cli = fileURLToPath(new URL('../src/tj1-canary-cli.ts', import.meta.url));
  const { now: _, ...permission } = {
    ...auth(),
    expiresAt: Date.now() + 60_000,
    write: false,
    train: false,
    export: false,
  };
  const internal = join(f.directory, 'untrusted-authority.json');
  writeFileSync(internal, canonical(permission));
  const invoke = (path: string) =>
    spawnSync(process.execPath, [cli, 'read', '--directory', f.directory, '--authority-file', path], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096,
      windowsHide: true,
    });
  const denied = invoke(internal);
  assert.equal(denied.status, 1);
  assert.equal(denied.stderr.trim(), 'TJ1_AUTHORITY_LOCATION');
  const external = join(fresh(), 'host-authority.json');
  writeFileSync(external, canonical(permission));
  const accepted = invoke(external);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.status, 0);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.assurance, 'RECORDED_CLAIMS_ONLY');
  assert.equal(result.recovery, 'RECONCILE_REQUIRED');
  assert.equal(result.projection.consumed, false);
});
