import test from 'node:test';
import assert from 'node:assert/strict';
import { Wf1Error } from '../src/wf1-json.ts';
import { parseDshTeacherOperation, TeacherControlService, validateTeacherReply } from '../src/wf2-teacher-service.ts';
import type { BoundTeachingRun, TeacherSafeMetadata } from '../src/wf2-teacher-service.ts';
const CAP = 'a1'.repeat(32),
  error = (c: string) => (e: unknown) => e instanceof Wf1Error && e.code === c;
const metadata = (status: TeacherSafeMetadata['campaignStatus'] = 'ACTIVE'): TeacherSafeMetadata => ({
  campaignStatus: status,
  countCompleteness: 'CURRENT_AUTHORITY',
  calls: { deepseek: 0, together: 0 },
  candidates: { deepseek: 0, together: 0, qualified: 0, quarantined: 0 },
  sealed: false,
  planned: false,
  manifestFrozen: status === 'COMPLETED',
  usage: { input: 0, completion: 0, unknown: 0 },
  estimatedReserveMicroUsd: 0,
});
function fixture() {
  let count = 0,
    close = 0,
    withdrawals: string[] = [],
    current = metadata(),
    resolve!: () => void,
    reject!: (e: Error) => void;
  const work = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const run: BoundTeachingRun = {
    run: () => {
      count++;
      return work;
    },
    metadata: () => current,
    withdraw: (mode) => {
      withdrawals.push(mode);
    },
    close: () => {
      close++;
    },
  };
  const service = new TeacherControlService(run, CAP);
  return {
    service,
    run,
    get count() {
      return count;
    },
    get close() {
      return close;
    },
    withdrawals,
    complete() {
      current = metadata('COMPLETED');
      resolve();
    },
    reject() {
      reject(new Error('private error never projected'));
    },
  };
}
function request(operation: string, id = operation) {
  return { version: 1, requestId: id, operation, capability: CAP };
}
test('DSH pipe operation is closed, has no capability, paths, content or caller configuration', () => {
  assert.deepEqual(parseDshTeacherOperation({ version: 1, requestId: 'a', operation: 'status' }), {
    version: 1,
    requestId: 'a',
    operation: 'status',
  });
  for (const extra of ['path', 'capability', 'credentials', 'reference', 'payload'])
    assert.throws(
      () => parseDshTeacherOperation({ version: 1, requestId: 'a', operation: 'status', [extra]: 'private' }),
      error('WF1_FIELDS'),
    );
  assert.throws(() => parseDshTeacherOperation({ version: 1, requestId: 'a', operation: 'resume' }));
});
test('single start is synchronously consumed; duplicates return current metadata and conflicts cannot execute', async () => {
  const f = fixture(),
    first = f.service.dispatch(request('start'));
  assert.equal(first.state, 'RUNNING');
  assert.equal(first.startConsumed, true);
  const dup = f.service.dispatch(request('start'));
  assert.equal(dup.duplicate, true);
  assert.equal(dup.state, 'RUNNING');
  assert.throws(() => f.service.dispatch(request('cancel', 'start')), error('WF2_SERVICE_REQUEST_CONFLICT'));
  assert.throws(() => f.service.dispatch(request('start', 'another')), error('WF2_SERVICE_ALREADY_CONSUMED'));
  await Promise.resolve();
  assert.equal(f.count, 1);
  f.complete();
  await f.service.settled();
  const status = f.service.dispatch(request('status'));
  assert.equal(status.state, 'COMPLETED');
  assert.equal(status.metadata.manifestFrozen, true);
  assert.equal(status.rawWorkClosure, 'NOT_ESTABLISHED');
  assert.equal(f.close, 0);
  f.service.acknowledgeCompleted(f.service.completionReceipt().digest);
  assert.equal(f.close, 1);
});
test('pause before the start microtask prevents invocation and is permanently terminal', async () => {
  const f = fixture();
  f.service.dispatch(request('start'));
  const r = f.service.dispatch(request('pause'));
  await f.service.settled();
  assert.equal(r.state, 'PAUSED');
  assert.equal(r.metadata.calls.deepseek, null);
  assert.equal(r.metadata.countCompleteness, 'STALE_OR_UNKNOWN');
  assert.equal(f.count, 0);
  assert.deepEqual(f.withdrawals, ['PAUSED']);
  assert.equal(f.close, 1);
  assert.throws(() => f.service.dispatch(request('start', 'new')), error('WF2_SERVICE_ALREADY_CONSUMED'));
  assert.equal(f.service.dispatch(request('cancel')).state, 'CANCELLED');
  assert.deepEqual(f.withdrawals, ['PAUSED', 'REVOKED']);
  assert.equal(f.close, 1);
});
test('cancel and owner EOF fence late success and close exactly once', async () => {
  for (const action of ['cancel', 'ownerLost'] as const) {
    const f = fixture();
    f.service.dispatch(request('start'));
    await Promise.resolve();
    assert.equal(f.count, 1);
    if (action === 'cancel') f.service.dispatch(request('cancel'));
    else f.service.ownerLost();
    f.complete();
    await f.service.settled();
    assert.equal(f.close, 1);
    assert.deepEqual(f.withdrawals, ['REVOKED']);
    if (action === 'cancel') {
      const r = f.service.dispatch(request('status'));
      assert.equal(r.state, 'CANCELLED');
      assert.equal(r.metadata.manifestFrozen, false);
    } else assert.throws(() => f.service.dispatch(request('status')), error('WF2_SERVICE_CAPABILITY'));
  }
});
test('unknown exception withdraws, never leaks body and cannot restore the run', async () => {
  const f = fixture();
  f.service.dispatch(request('start'));
  await Promise.resolve();
  f.reject();
  await f.service.settled();
  const r = f.service.dispatch(request('status'));
  assert.equal(r.state, 'UNKNOWN');
  assert.equal(r.metadata.calls.deepseek, null);
  assert.ok(!JSON.stringify(r).includes('private error'));
  assert.deepEqual(f.withdrawals, ['REVOKED']);
  assert.equal(f.close, 1);
});
test('wrong capability and closed schema refuse without invoking the underlying worker', () => {
  const f = fixture();
  assert.throws(
    () => f.service.dispatch({ ...request('start'), capability: 'b2'.repeat(32) }),
    error('WF2_SERVICE_CAPABILITY'),
  );
  assert.throws(() => f.service.dispatch({ ...request('start'), path: 'untrusted' }), error('WF1_FIELDS'));
  assert.equal(f.count, 0);
  assert.equal(f.close, 0);
});
test('bounded request table refuses a new identity but retained duplicates stay idempotent', () => {
  const f = fixture();
  for (let i = 0; i < 64; i++) f.service.dispatch(request('status', 's' + i));
  assert.throws(() => f.service.dispatch(request('status', 'overflow')), error('WF2_SERVICE_REQUEST_LIMIT'));
  assert.equal(f.service.dispatch(request('status', 's0')).duplicate, true);
  assert.equal(f.count, 0);
  assert.equal(f.service.dispatch(request('cancel', 'terminal')).state, 'CANCELLED');
  assert.equal(f.close, 1);
  f.service.ownerLost();
});
test('caller cannot accidentally forward arbitrary worker metadata or private error strings', () => {
  const f = fixture();
  f.run.metadata = () => ({ ...metadata(), privateBody: 'DO_NOT_PROJECT' }) as TeacherSafeMetadata;
  const r = f.service.dispatch(request('status'));
  assert.equal(r.metadata.countCompleteness, 'STALE_OR_UNKNOWN');
  assert.ok(!JSON.stringify(r).includes('DO_NOT_PROJECT'));
  assert.throws(() => validateTeacherReply({ ...r, secret: 'extra' }), error('WF1_FIELDS'));
  f.service.ownerLost();
});
test('withdrawal failure still closes and declares UNKNOWN, never graceful child closure', () => {
  const f = fixture();
  f.run.withdraw = () => {
    throw new Error('host private failure');
  };
  const r = f.service.dispatch(request('cancel'));
  assert.equal(r.state, 'UNKNOWN');
  assert.equal(r.remoteCancellation, 'UNKNOWN');
  assert.equal(r.rawWorkClosure, 'NOT_ESTABLISHED');
  assert.equal(f.close, 1);
  assert.equal(r.metadata.calls.deepseek, null);
});
test('owner loss after pause still revokes fresh authority without closing twice', () => {
  const f = fixture();
  f.service.dispatch(request('pause'));
  f.service.ownerLost();
  f.service.ownerLost();
  assert.deepEqual(f.withdrawals, ['PAUSED', 'REVOKED']);
  assert.equal(f.close, 1);
});
test('only explicit completed acknowledgement permits normal EOF without revoking retained artifacts', async () => {
  for (const ack of [false, true]) {
    const f = fixture();
    assert.throws(() => f.service.acknowledgeCompleted('0'.repeat(64)), error('WF2_SERVICE_COMPLETION_ACK'));
    f.service.dispatch(request('start'));
    await Promise.resolve();
    f.complete();
    await f.service.settled();
    if (ack) f.service.acknowledgeCompleted(f.service.completionReceipt().digest);
    f.service.ownerLost();
    assert.deepEqual(f.withdrawals, ack ? [] : ['REVOKED']);
    assert.equal(f.close, 1);
  }
});
test('completion acknowledgement binds the exact safe snapshot and rechecks authority before close', async () => {
  const f = fixture();
  f.service.dispatch(request('start'));
  await Promise.resolve();
  f.complete();
  await f.service.settled();
  const receipt = f.service.completionReceipt();
  assert.throws(() => f.service.acknowledgeCompleted('0'.repeat(64)), error('WF2_SERVICE_COMPLETION_ACK'));
  assert.equal(f.close, 0);
  f.run.metadata = () => {
    throw new Error('withdrawn outside owner');
  };
  assert.throws(() => f.service.acknowledgeCompleted(receipt.digest), error('WF2_SERVICE_COMPLETION_ACK'));
  assert.equal(f.close, 1);
  assert.deepEqual(f.withdrawals, ['REVOKED']);
  assert.equal(f.service.dispatch(request('status')).state, 'UNKNOWN');
});
test('a failing close during completion acknowledgement is attempted once and remains UNKNOWN', async () => {
  const f = fixture();
  f.service.dispatch(request('start'));
  await Promise.resolve();
  f.complete();
  await f.service.settled();
  const receipt = f.service.completionReceipt();
  let closeCalls = 0;
  f.run.close = () => {
    closeCalls++;
    throw new Error('private close error');
  };
  assert.throws(() => f.service.acknowledgeCompleted(receipt.digest), error('WF2_SERVICE_COMPLETION_ACK'));
  f.service.ownerLost();
  assert.equal(closeCalls, 1);
  assert.deepEqual(f.withdrawals, ['REVOKED']);
});
