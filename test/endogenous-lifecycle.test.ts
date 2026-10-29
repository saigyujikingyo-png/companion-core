import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { EndogenousOwner } from '../src/endogenous-lifecycle.ts';
import type { EndogenousDecisionPort, EndogenousLimits, EndogenousRequest } from '../src/endogenous-lifecycle.ts';

const rest = (wake?: number) =>
  JSON.stringify({ version: 1, choice: 'REST', ...(wake === undefined ? {} : { nextWakeInMs: wake }) });
const noop = (wake?: number) =>
  JSON.stringify({ version: 1, choice: 'NOOP', ...(wake === undefined ? {} : { nextWakeInMs: wake }) });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function deferred() {
  let resolve!: (value: string) => void, reject!: (error: unknown) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t: TestContext, port: EndogenousDecisionPort, limits: Partial<EndogenousLimits> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { now: 0 };
  const owner = new EndogenousOwner({
    clock: () => clock.now,
    limits: { maxCalls: 4, maxDurationMs: 1_000, callTimeoutMs: 100, maxResultBytes: 1_024, ...limits },
  });
  const session = owner.bind(port);
  t.after(() => owner.close());
  return {
    owner,
    session,
    clock,
    tick: async (ms: number) => {
      clock.now += ms;
      t.mock.timers.tick(ms);
      await flush();
    },
  };
}

test('zero-input boot -> REST -> wake -> NOOP; each choice is terminal but neither forbids a future opportunity', async (t) => {
  const seen: EndogenousRequest[] = [];
  const f = fixture(t, async (request) => {
    seen.push(request);
    return seen.length === 1 ? rest(20) : noop(30);
  });
  assert.equal(seen.length, 0);
  f.session.start();
  await flush();
  assert.equal(f.owner.read().state, 'waiting');
  assert.equal(f.owner.read().timerPending, true);
  await f.tick(19);
  assert.equal(seen.length, 1);
  await f.tick(1);
  assert.equal(seen.length, 2);
  await f.tick(30);
  assert.equal(seen.length, 3);
  assert.deepEqual(
    seen.map((x) => x.trigger),
    ['boot', 'wake', 'wake'],
  );
  assert.deepEqual(
    f.owner.read().entries.map((x) => x.outcome),
    ['REST', 'NOOP', 'NOOP'],
  );
  assert.equal(new Set(seen.map((x) => x.decisionId)).size, 3);
  assert.equal(new Set(seen.map((x) => x.ownerEpoch)).size, 1);
  assert.ok(seen.every((x) => Object.isFrozen(x) && !('selectedText' in x) && !('evidence' in x)));
});

test('REST with no next opportunity remains quiet until owner duration expires', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return rest();
  });
  f.session.start();
  await flush();
  assert.equal(f.owner.read().state, 'resting');
  assert.equal(f.owner.read().timerPending, true);
  await f.tick(999);
  assert.equal(calls, 1);
  await f.tick(1);
  assert.equal(f.owner.read().state, 'exhausted');
  assert.equal(f.owner.read().code, 'DURATION');
  assert.equal(f.owner.read().timerPending, false);
});

test('pause removes the scheduled opportunity; advancing time cannot resume it', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return rest(20);
  });
  f.session.start();
  await flush();
  f.session.pause();
  assert.equal(f.owner.read().timerPending, false);
  await f.tick(100);
  assert.equal(calls, 1);
  assert.equal(f.owner.read().state, 'paused');
  f.session.resume();
  await flush();
  assert.equal(calls, 2);
  assert.equal(f.owner.read().entries[0]?.outcome, 'REST');
});

for (const late of ['resolve', 'reject'] as const) {
  test(`pause fences pending ${late}; actual lane stays occupied and UNKNOWN is never refunded`, async (t) => {
    const pending = deferred();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const f = fixture(t, (request) => {
      signal = request.signal;
      calls++;
      return calls === 1 ? pending.promise : Promise.resolve(noop());
    });
    f.session.start();
    f.session.pause();
    assert.equal(signal?.aborted, true);
    assert.equal(f.owner.read().actualPending, true);
    assert.equal(f.owner.read().timerPending, false);
    assert.throws(() => f.session.resume(), /E1_RAW_BUSY/);
    await f.tick(150);
    assert.equal(calls, 1);
    if (late === 'resolve') pending.resolve(rest(10));
    else pending.reject(new Error('synthetic late failure'));
    await flush();
    assert.equal(f.owner.read().actualPending, false);
    assert.equal(f.owner.read().state, 'paused');
    assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
    assert.equal(f.owner.read().callsConsumed, 1);
    assert.equal(f.owner.read().resultBytesReserved, 256);
    await f.tick(100);
    assert.equal(calls, 1);
    f.session.resume();
    await flush();
    assert.equal(calls, 2);
    assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
  });
}

test('timeout fences late success, keeps raw lane and requires explicit resume after real settlement', async (t) => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(t, () => {
    calls++;
    return calls === 1 ? pending.promise : Promise.resolve(noop());
  });
  f.session.start();
  await f.tick(100);
  assert.equal(f.owner.read().code, 'TIMEOUT');
  assert.equal(f.owner.read().actualPending, true);
  assert.equal(f.owner.read().timerPending, false);
  assert.throws(() => f.session.resume(), /E1_RAW_BUSY/);
  pending.resolve(rest(10));
  await flush();
  await f.tick(50);
  assert.equal(calls, 1);
  assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
  f.session.resume();
  await flush();
  assert.equal(calls, 2);
});

test('delayed event-loop settlement checks deadline before accepting an already resolved value', async (t) => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  f.session.start();
  f.clock.now = 100;
  pending.resolve(noop());
  await flush();
  assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
  assert.equal(f.owner.read().code, 'TIMEOUT');
  assert.equal(f.owner.read().actualPending, false);
});

test('close/rebind/new session retain owner epoch, consumed IDs, budget and unresolved actual lane', async (t) => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  f.session.start();
  const initial = f.owner.read();
  f.session.close();
  const next = f.owner.bind(async () => noop());
  assert.throws(() => f.session.resume(), /E1_STALE_SESSION/);
  assert.throws(() => next.start(), /E1_RAW_BUSY/);
  assert.equal(f.owner.read().callsConsumed, 1);
  pending.resolve(rest(10));
  await flush();
  assert.equal(f.owner.read().state, 'created');
  next.start();
  await flush();
  const final = f.owner.read();
  assert.equal(final.ownerEpoch, initial.ownerEpoch);
  assert.equal(final.entries[0]?.decisionId, initial.entries[0]?.decisionId);
  assert.equal(final.entries[0]?.outcome, 'UNKNOWN');
  assert.equal(final.entries[1]?.sequence, 2);
  assert.equal(final.entries[1]?.session, 2);
});

test('owner close is permanent and late rejection cannot revive any session', async (t) => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  f.session.start();
  f.owner.close();
  assert.throws(() => f.owner.bind(async () => rest()), /E1_OWNER_CLOSED/);
  assert.throws(() => f.session.resume(), /E1_OWNER_CLOSED/);
  pending.reject(new Error('synthetic'));
  await flush();
  assert.equal(f.owner.read().state, 'closed');
  assert.equal(f.owner.read().actualPending, false);
  assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
});

test('single pending timeout then single wake timer; duplicate start/resume/bind cannot dispatch', async (t) => {
  let active = 0,
    peak = 0;
  const pending = deferred();
  const f = fixture(t, () => {
    active++;
    peak = Math.max(peak, active);
    return pending.promise;
  });
  f.session.start();
  assert.throws(() => f.session.start(), /E1_STATE/);
  assert.throws(() => f.session.resume(), /E1_STATE/);
  assert.throws(() => f.owner.bind(async () => noop()), /E1_SESSION_ACTIVE/);
  assert.equal(f.owner.read().timerPending, true);
  pending.resolve(rest(20));
  active--;
  await flush();
  assert.equal(f.owner.read().actualPending, false);
  assert.equal(f.owner.read().timerPending, true);
  f.session.pause();
  await f.tick(100);
  assert.equal(peak, 1);
  assert.equal(f.owner.read().callsConsumed, 1);
});

test('synchronous decision callback cannot reenter lifecycle mutations or bypass reservation', async (t) => {
  const errors: string[] = [];
  const f = fixture(t, () => {
    for (const action of [
      () => f.session.pause(),
      () => f.session.close(),
      () => f.owner.close(),
      () => f.session.resume(),
      () => f.owner.bind(async () => rest()),
    ]) {
      try {
        action();
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    assert.equal(f.owner.read().callsConsumed, 1);
    assert.equal(f.owner.read().actualPending, true);
    return Promise.resolve(noop());
  });
  f.session.start();
  await flush();
  assert.deepEqual(errors, Array(5).fill('E1_REENTRANT'));
  assert.equal(f.owner.read().entries[0]?.outcome, 'NOOP');
});

test('synchronous abort callback observes fence and cannot resume or rebind', async (t) => {
  const pending = deferred();
  let seen = '';
  const f = fixture(t, (request) => {
    request.signal.addEventListener('abort', () => {
      assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
      try {
        f.session.resume();
      } catch (error) {
        seen = (error as Error).message;
      }
    });
    return pending.promise;
  });
  f.session.start();
  f.session.pause();
  assert.equal(seen, 'E1_REENTRANT');
  pending.resolve(noop());
  await flush();
  assert.equal(f.owner.read().callsConsumed, 1);
});

for (const result of [
  'null',
  '[]',
  '{}',
  '{',
  '{"version":2,"choice":"REST"}',
  '{"version":1,"choice":"ACT"}',
  '{"version":1,"choice":"REST","reason":"private reasoning"}',
  '{"version":1,"choice":"REST","evidence":[]}',
  ...[0, -1, 1, 9, 10.5, 300001, null, '20'].map((nextWakeInMs) =>
    JSON.stringify({ version: 1, choice: 'REST', nextWakeInMs }),
  ),
  '{"version":1,"choice":"REST","nextWakeInMs":1e999}',
  JSON.stringify({ version: 1, choice: 'REST', extra: 'x'.repeat(256) }),
  JSON.stringify({ version: 1, choice: 'REST', extra: '猫'.repeat(90) }),
]) {
  test(`invalid/oversize/unsafe wake response is consumed UNKNOWN without retry: ${result.slice(0, 65)}`, async (t) => {
    let calls = 0;
    const f = fixture(t, async () => {
      calls++;
      return result;
    });
    f.session.start();
    await flush();
    await f.tick(200);
    assert.equal(calls, 1);
    assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
    assert.equal(f.owner.read().code, 'INVALID_DECISION');
    assert.equal(f.owner.read().timerPending, false);
  });
}

for (const mode of ['throw', 'reject'] as const) {
  test(`port ${mode} consumes budget with no auto retry`, async (t) => {
    let calls = 0;
    const f = fixture(t, () => {
      calls++;
      if (mode === 'throw') throw new Error('synthetic');
      return Promise.reject(new Error('synthetic'));
    });
    f.session.start();
    await flush();
    await f.tick(200);
    assert.equal(calls, 1);
    assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
    assert.equal(f.owner.read().actualPending, false);
    assert.equal(f.owner.read().timerPending, false);
    f.session.resume();
    await flush();
    assert.equal(calls, 2);
    assert.equal(f.owner.read().resultBytesReserved, 512);
  });
}

for (const mode of ['thenable', 'own-then', 'own-constructor', 'subclass', 'plain-value'] as const) {
  test(`unsupported promise ${mode} poisons owner without invoking spoofed then or freeing lane`, async (t) => {
    let touched = 0;
    const f = fixture(t, () => {
      if (mode === 'thenable')
        return {
          then: () => {
            touched++;
          },
        } as unknown as Promise<string>;
      if (mode === 'plain-value') return rest() as unknown as Promise<string>;
      if (mode === 'subclass') {
        class P<T> extends Promise<T> {}
        return P.resolve(rest());
      }
      const promise = Promise.resolve(rest());
      Object.defineProperty(promise, mode === 'own-then' ? 'then' : 'constructor', {
        get() {
          touched++;
          throw new Error('hook');
        },
      });
      return promise;
    });
    f.session.start();
    await flush();
    assert.equal(touched, 0);
    assert.equal(f.owner.read().state, 'faulted');
    assert.equal(f.owner.read().actualPending, true);
    assert.equal(f.owner.read().timerPending, false);
    assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
    f.session.close();
    assert.throws(() => f.owner.bind(async () => rest()), /E1_OWNER_CLOSED/);
  });
}

test('call capacity bounds decisions and retained entries even through repeated session rebinding', async (t) => {
  const f = fixture(t, async () => rest(10), { maxCalls: 2 });
  f.session.start();
  await flush();
  await f.tick(10);
  await f.tick(50);
  assert.equal(f.owner.read().entries.length, 2);
  assert.equal(f.owner.read().state, 'exhausted');
  f.session.close();
  const next = f.owner.bind(async () => noop());
  next.start();
  await flush();
  assert.equal(f.owner.read().callsConsumed, 2);
  assert.equal(f.owner.read().state, 'exhausted');
  next.pause();
  assert.throws(() => next.resume(), /E1_STATE/);
});

test('response byte reservation limits actual calls independently of maxCalls, with no refund for tiny REST', async (t) => {
  const f = fixture(t, async () => rest(10), { maxResultBytes: 256 });
  f.session.start();
  await flush();
  await f.tick(100);
  assert.equal(f.owner.read().callsConsumed, 1);
  assert.equal(f.owner.read().resultBytesReserved, 256);
  assert.equal(f.owner.read().state, 'exhausted');
  assert.equal(f.owner.read().timerPending, false);
});

test('the 256-byte response boundary includes whitespace and UTF-8 before parsing', async (t) => {
  let response = rest().padEnd(256, ' ');
  const f = fixture(t, async () => response);
  f.session.start();
  await flush();
  assert.equal(f.owner.read().entries[0]?.outcome, 'REST');
  f.session.pause();
  response += ' ';
  f.session.resume();
  await flush();
  assert.equal(f.owner.read().entries[1]?.outcome, 'UNKNOWN');
  assert.equal(f.owner.read().code, 'INVALID_DECISION');
});

test('owner duration while raw work is pending aborts once, retains the lane and consumes UNKNOWN', async (t) => {
  const pending = deferred();
  let signal: AbortSignal | undefined;
  const f = fixture(
    t,
    (request) => {
      signal = request.signal;
      return pending.promise;
    },
    { maxDurationMs: 100 },
  );
  f.session.start();
  await f.tick(100);
  assert.equal(signal?.aborted, true);
  assert.equal(f.owner.read().code, 'DURATION');
  assert.equal(f.owner.read().actualPending, true);
  assert.equal(f.owner.read().timerPending, false);
  pending.resolve(noop());
  await flush();
  assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
  assert.equal(f.owner.read().state, 'exhausted');
  assert.equal(f.owner.read().actualPending, false);
});

test('a non-string fulfilled result does not execute object getters or toJSON', async (t) => {
  let touched = 0;
  const value = {
    get version() {
      touched++;
      return 1;
    },
    toJSON() {
      touched++;
      return rest();
    },
  };
  const f = fixture(t, () => Promise.resolve(value) as unknown as Promise<string>);
  f.session.start();
  await flush();
  assert.equal(touched, 0);
  assert.equal(f.owner.read().code, 'INVALID_DECISION');
});

for (const now of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
  test(`invalid initial clock refuses dispatch: ${String(now)}`, (t) => {
    let calls = 0;
    const f = fixture(t, async () => {
      calls++;
      return rest();
    });
    f.clock.now = now;
    f.session.start();
    assert.equal(calls, 0);
    assert.equal(f.owner.read().state, 'faulted');
    f.session.close();
    assert.throws(() => f.owner.bind(async () => rest()), /E1_OWNER_CLOSED/);
  });
}

test('clock rollback fences pending decision permanently; corrected time cannot refund or restart', async (t) => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  f.clock.now = 20;
  f.session.start();
  f.clock.now = 19;
  pending.resolve(rest(10));
  await flush();
  assert.equal(f.owner.read().state, 'faulted');
  assert.equal(f.owner.read().entries[0]?.outcome, 'UNKNOWN');
  f.clock.now = 21;
  f.session.pause();
  assert.throws(() => f.session.resume(), /E1_OWNER_CLOSED/);
});

test('large clock jump expires the owner and never catches up missed opportunities', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return rest(10);
  });
  f.session.start();
  await flush();
  await f.tick(100_000);
  assert.equal(calls, 1);
  assert.equal(f.owner.read().state, 'exhausted');
  assert.equal(f.owner.read().timerPending, false);
});

test('duration budget includes paused time and survives close/rebind', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return rest();
  });
  f.session.start();
  await flush();
  f.session.pause();
  await f.tick(1_000);
  f.session.close();
  const next = f.owner.bind(async () => {
    calls++;
    return rest();
  });
  next.start();
  assert.equal(calls, 1);
  assert.equal(f.owner.read().state, 'exhausted');
});

test('wake exceeding remaining lifetime expires without a final extra call', async (t) => {
  const f = fixture(t, async () => noop(300_000));
  f.session.start();
  await flush();
  await f.tick(1_000);
  assert.equal(f.owner.read().callsConsumed, 1);
  assert.equal(f.owner.read().state, 'exhausted');
});

test('early timer or frozen injected clock faults once instead of creating a polling loop', async (t) => {
  const f = fixture(t, async () => rest(10));
  f.session.start();
  await flush();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(f.owner.read().state, 'faulted');
  assert.equal(f.owner.read().callsConsumed, 1);
  assert.equal(f.owner.read().timerPending, false);
});

test('metadata reads are detached and cannot change consumed IDs or limits', async (t) => {
  const f = fixture(t, async () => noop());
  f.session.start();
  await flush();
  const snapshot = f.owner.read();
  (snapshot.entries[0] as { outcome: string }).outcome = 'PENDING';
  (snapshot.limits as { maxCalls: number }).maxCalls = 64;
  assert.equal(f.owner.read().entries[0]?.outcome, 'NOOP');
  assert.equal(f.owner.read().limits.maxCalls, 4);
  assert.equal(JSON.stringify(f.owner.read()).includes('private reasoning'), false);
});

test('binding handles have a fixed owner-lifetime upper bound even without starting', (t) => {
  const f = fixture(t, async () => rest());
  f.session.close();
  for (let i = 1; i < 1_024; i++) f.owner.bind(async () => rest()).close();
  assert.throws(() => f.owner.bind(async () => rest()), /E1_BINDING_CAPACITY/);
  assert.equal(f.owner.read().callsConsumed, 0);
});

for (const limits of [
  { maxCalls: 0 },
  { maxCalls: 65 },
  { maxDurationMs: Infinity },
  { maxDurationMs: 300_001 },
  { maxDurationMs: 100, callTimeoutMs: 101 },
  { callTimeoutMs: 0 },
  { callTimeoutMs: 30_001 },
  { maxResultBytes: 255 },
  { maxResultBytes: 16_385 },
  { maxCalls: 1.5 },
]) {
  test(`invalid fixed resource limits rejected: ${JSON.stringify(limits)}`, () => {
    assert.throws(() => new EndogenousOwner({ limits }), /E1_INVALID_LIMITS/);
  });
}
