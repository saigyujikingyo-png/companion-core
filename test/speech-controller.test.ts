import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLegacyMediaFacade, SpeechController } from '../src/speech-controller.ts';
import { canonicalSpeech, speechEffectKey, speechHash, speechResourceKey } from '../src/speech-contract.ts';
import { FakeAuthority, FakeBackend, FakeGate, fixture, plan, text, tick } from './fixtures/speech-synthetic.ts';

test('F01 F03 F24 one consumed final expression, immutable completion and technical-only receipt', async () => {
  const f = fixture(),
    p = plan(),
    op = f.controller.submit(p, text),
    duplicate = f.controller.submit(p, text);
  assert.equal(op, duplicate);
  await tick();
  const w = f.backend.workers[0]!;
  assert.equal(w.dispatches.length, 1);
  w.complete();
  const result = await op.result;
  await tick();
  assert.equal(result.outcome, 'backend_completed_reported');
  assert.equal(f.controller.submit(p, text), op);
  assert.equal(f.authority.claimCalls, 1);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0]!.eventClass, 'technical-delivery');
  assert.equal(f.receipts[0]!.userAudibility, 'NOT_EVALUATED');
  assert.equal(f.receipts[0]!.deviceEvidence, 'not_observed');
  assert.ok(!JSON.stringify(result).includes(text));
  // There is no user-event/ACK/feedback/appraisal callback in any injected port or result.
  assert.deepEqual(
    Object.keys(f.receipts[0]!).sort(),
    [
      'code',
      'deviceEvidence',
      'effectKey',
      'eventClass',
      'naturalness',
      'outcome',
      'receiptId',
      'sequence',
      'userAudibility',
      'userIntelligibility',
    ].sort(),
  );
  await f.controller.close();
});
test('F02 legacy requires one prepared intent and matching session/text; duplicate signal cannot replay', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  assert.equal(
    (await createLegacyMediaFacade(f.controller).speak({ sessionId: 'session', text, signal })).status,
    'failed',
  );
  const facade = createLegacyMediaFacade(f.controller, { plan: plan(), text });
  assert.equal((await facade.speak({ sessionId: 'wrong', text, signal })).status, 'failed');
  const first = facade.speak({ sessionId: 'session', text, signal });
  await tick();
  f.backend.workers[0]!.complete();
  assert.equal((await first).status, 'completed');
  assert.equal((await facade.speak({ sessionId: 'session', text, signal: AbortSignal.abort() })).status, 'completed');
  assert.equal(f.backend.workers.length, 1);
  await f.controller.close();
});
test('F04 stable key conflicts on turn, source, profile, permission and epoch changes', async () => {
  const f = fixture(),
    p = plan(),
    op = f.controller.submit(p, text);
  for (const changed of [
    { ...p, turnId: 'changed' },
    { ...p, sourceRefs: [{ id: 'other', revision: 0 }] },
    { ...p, binding: { ...p.binding, permissionEpoch: 1 } },
    { ...p, binding: { ...p.binding, runtimeEpoch: 1 } },
  ])
    assert.throws(() => f.controller.submit(changed, text), /EFFECT_CONFLICT/);
  await tick();
  await f.controller.close();
  await op.result;
});
test('F05 F06 global queue bound across sessions and queued abort has no dispatch', async () => {
  const f = fixture(),
    a = f.controller.submit(plan('a'), text),
    abort = new AbortController();
  const b = f.controller.submit(plan('b', { sessionId: 'B' }), text, abort.signal);
  assert.throws(() => f.controller.submit(plan('c', { sessionId: 'C' }), text), /BACKPRESSURE/);
  abort.abort();
  assert.equal((await b.result).outcome, 'cancelled_before_dispatch');
  await tick();
  assert.equal(f.backend.workers.length, 1);
  f.backend.workers[0]!.complete();
  await a.result;
  await f.controller.close();
});
test('F06 already aborted body is never sent or claimed', async () => {
  const f = fixture();
  assert.equal(
    (await f.controller.submit(plan(), text, AbortSignal.abort()).result).outcome,
    'cancelled_before_dispatch',
  );
  assert.equal(f.authority.claimCalls, 0);
  assert.equal(f.backend.workers.length, 0);
  await f.controller.close();
});
test('F07 revocation across claim await preserves consumed key and releases only undispatched lease', async () => {
  const f = fixture();
  let release!: (r: { status: 'claimed' }) => void;
  f.authority.claimHook = async (input) => {
    f.authority.effects.set(input.effectKey, input.fingerprint);
    return new Promise((r) => {
      release = r;
    });
  };
  const op = f.controller.submit(plan(), text);
  await tick();
  f.gate.invalidate();
  release({ status: 'claimed' });
  assert.equal((await op.result).outcome, 'cancelled_before_dispatch');
  await tick();
  assert.equal(f.backend.workers.length, 0);
  assert.equal(f.authority.effects.size, 1);
  assert.equal(f.authority.leases.size, 0);
  await f.controller.close();
});
test('F07 missing current gate after native-ready prevents body even without callback notification', async () => {
  const backend = new FakeBackend();
  backend.autoReady = false;
  const f = fixture({ backend });
  const op = f.controller.submit(plan(), text);
  await tick();
  f.gate.current = false;
  backend.workers[0]!.makeReady();
  assert.equal((await op.result).outcome, 'cancelled_before_dispatch');
  assert.equal(backend.workers[0]!.dispatches.length, 0);
  await f.controller.close();
});
test('F06 F14 unsolicited stopped before ready fences future dispatch even if ready later resolves', async () => {
  const backend = new FakeBackend();
  backend.autoReady = false;
  const f = fixture({ backend });
  const op = f.controller.submit(plan(), text);
  await tick();
  const w = backend.workers[0]!;
  w.event('stopped');
  w.makeReady();
  assert.equal((await op.result).outcome, 'cancelled_before_dispatch');
  assert.equal(w.dispatches.length, 0);
  assert.equal(op.snapshot().firstRejectedEventCode, 'UNREQUESTED_STOP_EVENT');
  await f.controller.close();
});
test('F08 F25 stale completion is forensic only and cannot enter technical sink', async () => {
  const f = fixture(),
    op = f.controller.submit(plan(), text);
  await tick();
  const w = f.backend.workers[0]!;
  f.gate.invalidate();
  w.event('completed');
  await op.result;
  assert.notEqual(op.snapshot().outcome, 'backend_completed_reported');
  assert.equal(f.receipts.length, 0);
  assert.ok(op.snapshot().rejectedEvents >= 1);
  assert.equal(op.snapshot().receipts.length, 1);
  await f.controller.close();
});
test('F09 dispatch-stop race never late-completes and stops before allowing another active worker', async () => {
  const backend = new FakeBackend(),
    f = fixture({ backend });
  backend.startHook = (w) => {
    w.dispatchHook = () => {
      void f.controller.stopDetailed();
    };
  };
  const op = f.controller.submit(plan(), text);
  await op.result;
  assert.equal(backend.workers[0]!.dispatches.length, 1);
  assert.equal(op.snapshot().outcome, 'stopped_reported');
  assert.equal(op.snapshot().deviceSilenceObserved, false);
  await f.controller.close();
});
test('F10 stop request is not silence; no settlement retains raw ownership and UNKNOWN lock', async () => {
  const f = fixture();
  f.backend.startHook = (w) => {
    w.stopSettles = false;
  };
  const op = f.controller.submit(plan(), text);
  await tick();
  const report = await f.controller.stopDetailed();
  assert.equal(report.requestAccepted, true);
  assert.equal(report.workerExited, false);
  assert.equal(report.engineStoppedReported, false);
  assert.equal(op.snapshot().outcome, 'unknown_after_dispatch');
  assert.throws(() => f.controller.submit(plan('new'), text), /CONTROLLER_UNAVAILABLE/);
  assert.equal(f.authority.leases.size, 1);
  f.backend.workers[0]!.exit();
  await tick();
  assert.equal(f.authority.leases.size, 1);
  await assert.rejects(f.controller.rebind('new'), /REBIND_REQUIRES_SETTLEMENT/);
  await f.controller.close();
});
test('F11 death after dispatch stays UNKNOWN even after forged completion', async () => {
  const f = fixture(),
    p = plan(),
    op = f.controller.submit(p, text);
  await tick();
  const w = f.backend.workers[0]!;
  w.exit({ exitCode: 1 });
  assert.equal((await op.result).outcome, 'unknown_after_dispatch');
  w.event('completed');
  assert.equal(op.snapshot().outcome, 'unknown_after_dispatch');
  assert.equal(f.controller.submit(p, text), op);
  await f.controller.close();
});
test('F13 clean rebind fences and drains old callbacks; UNKNOWN has no recovery shortcut', async () => {
  const f = fixture(),
    op = f.controller.submit(plan(), text);
  await tick();
  const old = f.backend.workers[0]!;
  await f.controller.rebind('binding-2');
  assert.equal((await op.result).outcome, 'stopped_reported');
  assert.equal(f.authority.leases.size, 0);
  old.event('completed');
  const p = plan('next');
  const next = f.controller.submit({ ...p, binding: { ...p.binding, controllerBindingId: 'binding-2' } }, text);
  await tick();
  assert.equal(f.backend.workers.length, 2);
  f.backend.workers[1]!.complete();
  assert.equal((await next.result).outcome, 'backend_completed_reported');
  await f.controller.close();
});
for (const defect of ['token', 'sequence', 'stream', 'chunk', 'duplicate'] as const)
  test(`F14 rejects ${defect} with bounded metadata`, async () => {
    const f = fixture(),
      op = f.controller.submit(plan(), text);
    await tick();
    const w = f.backend.workers[0]!;
    const event = { token: w.token, sequence: 2, kind: 'completed', streamId: w.stream, code: 'SYNTHETIC' };
    if (defect === 'token') event.token = { ...w.token, workerInstanceId: 'wrong' };
    if (defect === 'sequence') event.sequence = 8;
    if (defect === 'stream') event.streamId = 8;
    if (defect === 'duplicate') event.sequence = 1;
    w.receive(defect === 'chunk' ? { ...event, chunkIndex: 1 } : event);
    await op.result;
    assert.notEqual(op.snapshot().outcome, 'backend_completed_reported');
    assert.equal(op.snapshot().rejectedEvents >= 1, true);
    for (let i = 0; i < 100; i++) w.receive({ bad: true });
    assert.equal(op.snapshot().receipts.length, 1);
    assert.ok(op.snapshot().firstRejectedEventCode);
    await f.controller.close();
  });
test('F17 finite monotonic clock, queued expiry and active deadline fail closed', async () => {
  for (const invalid of [NaN, Infinity, 99]) {
    let now = 100;
    const f = fixture({ now: () => now });
    const p = plan('clock', { dispatchDeadlineMonotonicMs: 200 });
    const op = f.controller.submit(p, text);
    await tick();
    now = invalid;
    f.backend.workers[0]!.event('completed');
    assert.notEqual((await op.result).outcome, 'backend_completed_reported');
    await f.controller.close();
  }
  const f = fixture(),
    a = f.controller.submit(plan('active', { maxUtteranceMs: 35 }), text);
  const b = f.controller.submit(
    plan('queued', { dispatchDeadlineMonotonicMs: Math.ceil(performance.now() + 15) }),
    text,
  );
  assert.equal((await b.result).outcome, 'cancelled_before_dispatch');
  assert.equal((await a.result).outcome, 'stopped_reported');
  await f.controller.close();
});
test('F17 gate and lease callbacks cannot cross the deadline or roll back time before dispatch', async () => {
  for (const callback of ['gate', 'lease'] as const)
    for (const afterCallback of [201, 99]) {
      let now = 100;
      const backend = new FakeBackend();
      backend.autoReady = false;
      const f = fixture({ backend, now: () => now }),
        op = f.controller.submit(plan('callback-clock', { dispatchDeadlineMonotonicMs: 200 }), text);
      await tick();
      const worker = backend.workers[0]!,
        originalLeaseCheck = f.authority.output.isCurrent;
      let leaseChecks = 0;
      f.authority.output.isCurrent = (lease) => {
        leaseChecks++;
        const current = originalLeaseCheck(lease);
        if (callback === 'lease') now = afterCallback;
        return current;
      };
      if (callback === 'gate')
        f.gate.hook = () => {
          now = afterCallback;
        };
      worker.makeReady();
      assert.equal((await op.result).outcome, 'cancelled_before_dispatch', `${callback}/${afterCallback}`);
      assert.equal(worker.dispatches.length, 0, `${callback}/${afterCallback}`);
      if (callback === 'gate')
        assert.equal(leaseChecks, 0, 'expired/rollback gate stops before entering lease callback');
      await f.controller.close();
    }
});
test('F19 thrown and hanging sink cannot change execution or delay stop/replay protection', async () => {
  for (const hanging of [false, true]) {
    const f = fixture({
        sink: () => {
          if (hanging) return new Promise<void>(() => {});
          throw new Error('synthetic');
        },
      }),
      p = plan(),
      op = f.controller.submit(p, text);
    await tick();
    f.backend.workers[0]!.complete();
    assert.equal((await op.result).outcome, 'backend_completed_reported');
    await f.controller.close();
    if (hanging) await delay(520);
    else await tick();
    assert.equal(op.snapshot().forwarding, hanging ? 'timed_out' : 'failed');
    assert.equal(f.controller.submit(p, text), op);
  }
});
test('F21 repeated close/stop and wrong session cannot launch a worker', async () => {
  const f = fixture();
  assert.equal((await f.controller.stopDetailed('missing')).requestAccepted, false);
  await f.controller.close();
  await f.controller.close();
  assert.equal(f.backend.workers.length, 0);
  assert.throws(() => f.controller.submit(plan(), text), /CONTROLLER_UNAVAILABLE/);
});
test('F22 lifetime history cannot be cleared by rebind, and cleanup survives exhaustion', async () => {
  const f = fixture();
  let first: ReturnType<typeof plan> | undefined;
  for (let i = 0; i < 64; i++) {
    const p = plan('budget-' + i);
    first ??= p;
    const op = f.controller.submit(p, text);
    await tick();
    f.backend.workers.at(-1)!.complete();
    await op.result;
    await tick();
  }
  assert.throws(() => f.controller.submit(plan('65'), text), /EFFECT_LIMIT/);
  await f.controller.rebind('binding');
  assert.equal(f.controller.submit(first!, text).snapshot().outcome, 'backend_completed_reported');
  assert.throws(() => f.controller.submit(plan('65'), text), /EFFECT_LIMIT/);
  await f.controller.close();
});
test('F28 completion-first and invalidation-first preserve one terminal outcome', async () => {
  for (const invalidateFirst of [false, true]) {
    const f = fixture(),
      op = f.controller.submit(plan(), text);
    await tick();
    if (invalidateFirst) {
      f.gate.invalidate();
      f.backend.workers[0]!.complete();
    } else {
      f.backend.workers[0]!.complete();
      await op.result;
      f.gate.invalidate();
    }
    const result = await op.result;
    assert.equal(result.outcome === 'backend_completed_reported', !invalidateFirst);
    assert.equal(op.snapshot().receipts.length, 1);
    await f.controller.close();
  }
});
test('F29 shared synthetic authority blocks a new controller/effect until explicit reconciliation', async () => {
  const authority = new FakeAuthority(),
    a = fixture({ authority }),
    p = plan('X'),
    x = a.controller.submit(p, text);
  await tick();
  const old = a.backend.workers[0]!;
  old.exit({ exitCode: 1 });
  assert.equal((await x.result).outcome, 'unknown_after_dispatch');
  const b = fixture({ authority }),
    yPlan = plan('Y', { binding: { ...p.binding, runtimeEpoch: 2 } }),
    y = b.controller.submit(yPlan, text);
  assert.equal((await y.result).code, 'OUTPUT_LEASE_UNAVAILABLE');
  assert.equal(b.backend.workers.length, 0);
  assert.equal(authority.effects.get(speechEffectKey(p)), speechHash(canonicalSpeech(p)));
  const resource = speechResourceKey(p);
  assert.equal(authority.leases.get(resource)!.blocked, true);
  authority.reconcile(resource);
  const c = fixture({ authority }),
    next = c.controller.submit(plan('Z'), text);
  await tick();
  const newToken = c.backend.workers[0]!.token.lease;
  await assert.rejects(
    authority.output.release(old.token.lease, {
      bodyNeverDispatched: false,
      engineTerminalReported: true,
      workerExited: true,
    }),
    /LEASE_RELEASE_REFUSED/,
  );
  assert.equal(authority.output.isCurrent(newToken), true);
  old.event('completed');
  assert.equal(authority.output.isCurrent(newToken), true);
  c.backend.workers[0]!.complete();
  await next.result;
  await tick();
  const d = fixture({ authority }),
    replay = d.controller.submit(p, text);
  assert.equal((await replay.result).code, 'ALREADY_CONSUMED');
  assert.equal(d.backend.workers.length, 0);
  await Promise.all([a.controller.close(), b.controller.close(), c.controller.close(), d.controller.close()]);
});
test('default business refuses synthetic authority; async/truthy and reentrant gate cannot bypass', async () => {
  assert.throws(
    () =>
      new SpeechController({
        backend: new FakeBackend(),
        gate: new FakeGate(),
        authority: new FakeAuthority(),
        sink: { forward() {} },
        controllerBindingId: 'binding',
      }),
    /HOST_DURABLE_AUTHORITY_REQUIRED/,
  );
  const ports = new FakeAuthority();
  assert.throws(
    () =>
      new SpeechController({
        backend: new FakeBackend(),
        gate: new FakeGate(),
        authority: { assurance: 'host-durable', claims: ports.claims, output: ports.output },
        sink: { forward() {} },
        controllerBindingId: 'binding',
      }),
    /BUSINESS_BACKEND_REQUIRED/,
  );
  for (const value of [1, {}, Promise.resolve(true), Promise.reject(new Error('synthetic'))]) {
    const gate = new FakeGate();
    gate.current = value;
    const f = fixture({ gate });
    assert.throws(() => f.controller.submit(plan(), text), /CURRENT_GATE_REJECTED/);
    await f.controller.close();
  }
  const f = fixture();
  f.gate.hook = () => {
    assert.throws(() => f.controller.submit(plan('nested'), text), /REENTRANT_PORT/);
  };
  assert.throws(() => f.controller.submit(plan(), text), /CURRENT_GATE_REJECTED/);
  assert.equal(f.backend.workers.length, 0);
  await f.controller.close();
});
