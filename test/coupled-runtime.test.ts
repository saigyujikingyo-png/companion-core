import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CoupledSession } from '../src/coupled-runtime.ts';
import { BackgroundState } from '../src/background-state.ts';
import { HttpInteractionProvider } from '../src/http-interaction.ts';
import { InteractionResources, RawOperationPermit, RequestBudget } from '../src/interaction.ts';
import type { InteractionRequest, InteractionResponse, PriorAdapter } from '../src/interaction.ts';
import { MemoryStore } from '../src/store.ts';
import { CoreError } from '../src/validation.ts';
const neutral: InteractionResponse = {
  version: 1,
  responseText: '好的，已收到。',
  appraisal: { kind: 'appraisal-hypothesis', confidence: 0, valence: 0, arousal: 0, uncertainty: 0, fatigue: 0 },
  memoryProposal: null,
};
const positive: InteractionResponse = { ...neutral, appraisal: { ...neutral.appraisal, confidence: 1, valence: 1 } };
const code = (c: string) => (error: unknown) => error instanceof CoreError && error.code === c;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture(
  t: TestContext,
  run: (request: InteractionRequest) => Promise<InteractionResponse> = async () => neutral,
  options: { backend?: 'baseline' | 'no-state'; maxEntries?: number; enableProactive?: boolean } = {},
) {
  const clock = { now: 0 };
  const store = new MemoryStore(':memory:', {
    clock: { wall: () => 1_000_000 + Math.floor(clock.now), monotonic: () => clock.now },
  });
  t.after(() => store.close());
  const scope = store.ensureScope({
    tenantId: 'synthetic',
    subjectId: 'test-user',
    personaId: 'test',
    relationshipId: 'test',
  });
  const requests: InteractionRequest[] = [];
  const provider = {
    interact: async (request: InteractionRequest) => {
      requests.push(request);
      return run(request);
    },
  };
  const resources = new InteractionResources(
    new RequestBudget({ total: 100, hourly: 100, daily: 100 }, () => clock.now),
  );
  const session = new CoupledSession(store, scope, { provider, resources, clock: () => clock.now, ...options });
  t.after(() => session.stopScheduler());
  const ready = () => {
    session.setHostContext({ quiet: false, available: true, ttlMs: 300_000 });
    session.resume();
  };
  const send = (id: string, selectedText = 'synthetic selected text', extra: object = {}) =>
    session.submit({ sessionId: session.sessionId, id, selectedText, ...extra });
  const ack = (id: string) => {
    session.takeDelivery(id);
    session.acknowledgeDelivery(id);
  };
  let serial = 0;
  const memory = (statement: string) => {
    const event = store.acceptEvent(scope, {
      source: 'synthetic',
      eventKey: String(++serial),
      evidence: {
        speakerId: scope.subjectId,
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: statement,
        occurredAt: null,
      },
    });
    const job = store.beginJob(scope, [event]),
      lease = store.claimLease(scope, job.id);
    store.propose(scope, job.id, lease.token, {
      kind: 'episode',
      basis: 'self_report',
      statement,
      validFrom: null,
      validTo: null,
    });
    return { id: store.publish(scope, job.id, lease.token).id, revision: 1 };
  };
  return { clock, store, scope, requests, resources, session, ready, send, ack, memory, provider };
}
test('default paused/quiet and missing/expired host heartbeat prohibit provider calls', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.send('a'), code('SESSION_PAUSED'));
  f.session.resume();
  await assert.rejects(f.send('a'), code('HOST_CONTEXT_BLOCKED'));
  f.ready();
  f.clock.now = 300_000;
  await assert.rejects(f.send('a'), code('HOST_CONTEXT_BLOCKED'));
  assert.equal(f.requests.length, 0);
});
test('same input pending, completed, conflict and reset never generate a second request; session tokens are fresh', async (t) => {
  const d = deferred<InteractionResponse>(),
    f = fixture(t, () => d.promise);
  f.ready();
  const first = f.send('one');
  await tick();
  await assert.rejects(f.send('one'), code('INTERACTION_IN_PROGRESS'));
  d.resolve(neutral);
  const result = await first;
  assert.equal((await f.send('one')).deliveryId, result.deliveryId);
  await assert.rejects(f.send('one', 'different'), code('INTERACTION_IDEMPOTENCY_CONFLICT'));
  f.session.reset();
  await assert.rejects(f.send('one'), code('DELIVERY_STALE'));
  assert.equal(f.requests.length, 1);
  await assert.rejects(
    f.session.submit({ sessionId: 'previous-boot', id: 'new', selectedText: 'synthetic' }),
    code('SESSION_TOKEN_MISMATCH'),
  );
});
test('appraisal changes prior; neither generating, taking nor ACKing text is actual engagement', async (t) => {
  const f = fixture(t, async () => positive);
  f.ready();
  const initial = f.session.background();
  const result = await f.send('one');
  assert.equal(result.appraisalStatus, 'applied');
  const after = f.session.background();
  assert.ok(after.latent.affiliativeTone > initial.latent.affiliativeTone);
  f.ack(result.deliveryId);
  assert.deepEqual(f.session.background().latent, after.latent);
  assert.equal(f.session.acknowledgeDelivery(result.deliveryId).status, 'duplicate');
  assert.throws(() => f.session.takeDelivery(result.deliveryId), code('DELIVERY_ALREADY_CONSUMED'));
});
test('explicit self-report feedback requires actual ACK, is source bound and consumed once', async (t) => {
  const f = fixture(t);
  f.ready();
  const first = await f.send('first');
  await assert.rejects(
    f.send('premature', '我想继续', { feedback: { deliveryId: first.deliveryId, outcome: 'engaged' } }),
    code('FEEDBACK_REQUIRES_DELIVERED_RECEIPT'),
  );
  f.ack(first.deliveryId);
  const before = f.session.background().latent.affiliativeTone;
  const feedback = await f.send('feedback', '我愿意继续这次交流', {
    feedback: { deliveryId: first.deliveryId, outcome: 'engaged' },
  });
  assert.ok(f.session.background().latent.affiliativeTone > before);
  assert.equal(
    (await f.send('feedback', '我愿意继续这次交流', { feedback: { deliveryId: first.deliveryId, outcome: 'engaged' } }))
      .deliveryId,
    feedback.deliveryId,
  );
  await assert.rejects(
    f.send('alias', '我愿意继续这次交流', { feedback: { deliveryId: first.deliveryId, outcome: 'engaged' } }),
    code('DELIVERY_FEEDBACK_ALREADY_CONSUMED'),
  );
  assert.equal(f.requests.length, 2);
});
test('legal recall order depends on history and no-state removes effect; recall itself never rewards', async (t) => {
  const f = fixture(t);
  f.ready();
  f.memory('topic: quiet rest alone');
  f.memory('topic: chat together friend');
  let prior = await f.send('start');
  f.ack(prior.deliveryId);
  for (let i = 0; i < 2; i++) {
    prior = await f.send(`declined-${i}`, '明确希望暂时休息', {
      feedback: { deliveryId: prior.deliveryId, outcome: 'declined' },
    });
    f.ack(prior.deliveryId);
  }
  f.clock.now = 60_000;
  const before = f.session.recall('topic');
  for (let i = 0; i < 4; i++) {
    prior = await f.send(`feedback-${i}`, '明确希望继续交流', {
      feedback: { deliveryId: prior.deliveryId, outcome: 'engaged' },
    });
    f.ack(prior.deliveryId);
  }
  const after = f.session.recall('topic');
  assert.notEqual(after[0]!.ref.id, before[0]!.ref.id);
  assert.deepEqual(new Set(after.map((r) => r.ref.id)), new Set(before.map((r) => r.ref.id)));
  const state = f.session.background();
  for (let i = 0; i < 5; i++) f.session.recall('topic');
  assert.deepEqual(f.session.background().latent, state.latent);
  const n = fixture(t, async () => positive, { backend: 'no-state' });
  n.ready();
  n.memory('topic: quiet rest alone');
  n.memory('topic: chat together friend');
  const original = n.session.recall('topic').map((x) => x.statement);
  await n.send('positive');
  assert.deepEqual(
    n.session.recall('topic').map((x) => x.statement),
    original,
  );
  assert.equal(n.session.background().nextWakeAt, null);
  assert.ok(n.session.recall('topic').every((x) => x.beforeScore === x.afterScore && x.beforeRank === x.afterRank));
  assert.equal(n.requests[0]!.engineeredPrior.background, null);
});
test('proactive intent is consumed once; accepted 5s token allows 6s response under independent 30s deadline', async (t) => {
  const d = deferred<InteractionResponse>();
  let slow = false;
  const f = fixture(t, () => (slow ? d.promise : Promise.resolve(positive)));
  f.ready();
  f.memory('topic: chat together');
  for (let i = 0; i < 3; i++) {
    const r = await f.send(`warm-${i}`);
    f.ack(r.deliveryId);
  }
  f.clock.now = f.session.background().nextWakeAt! + 1;
  const intent = f.session.considerShadow()!;
  assert.ok(intent);
  slow = true;
  const pending = f.session.considerProactive('topic', intent);
  await tick();
  f.clock.now += 6_000;
  d.resolve(positive);
  const result = await pending;
  assert.ok(result);
  assert.equal(result.appraisalStatus, 'not-applied');
  f.ack(result.deliveryId);
  await assert.rejects(f.session.considerProactive('topic', intent));
  assert.equal(f.requests.length, 4);
});
test('unaccepted five-second shadow cannot be refreshed; appraisal exact fifteen-second boundary drops hypothesis only', async (t) => {
  const f = fixture(t, async () => positive);
  f.ready();
  f.memory('topic chat');
  for (let i = 0; i < 3; i++) await f.send(`w-${i}`);
  f.clock.now = f.session.background().nextWakeAt! + 1;
  const intent = f.session.considerShadow()!;
  f.clock.now += 5_000;
  await assert.rejects(f.session.considerProactive('topic', intent), code('BACKGROUND_INTENT_STALE'));
  assert.equal(f.requests.length, 3);
  const d = deferred<InteractionResponse>(),
    g = fixture(t, () => d.promise);
  g.ready();
  const pending = g.send('late');
  await tick();
  g.clock.now = 15_000;
  d.resolve(positive);
  const result = await pending;
  assert.equal(result.appraisalStatus, 'not-applied');
  assert.equal(g.session.background().latent.affiliativeTone, 0);
  assert.equal(g.session.takeDelivery(result.deliveryId).text, positive.responseText);
});
test('pause promptly cancels and retains raw permit; resume/new session cannot wash pending raw call', async (t) => {
  const d = deferred<InteractionResponse>(),
    f = fixture(t, () => d.promise);
  f.ready();
  const pending = f.send('old');
  await tick();
  f.session.pause();
  await assert.rejects(pending);
  assert.equal(f.resources.calls.active, true);
  f.session.resume();
  await assert.rejects(f.send('new'), code('INTERACTION_BACKPRESSURE'));
  const rebound = new CoupledSession(f.store, f.scope, {
    provider: f.provider,
    resources: f.resources,
    clock: () => f.clock.now,
  });
  rebound.setHostContext({ quiet: false, available: true, ttlMs: 300_000 });
  rebound.resume();
  await assert.rejects(
    rebound.submit({ sessionId: rebound.sessionId, id: 'other', selectedText: 'synthetic' }),
    code('INTERACTION_BACKPRESSURE'),
  );
  d.resolve(positive);
  await tick();
  assert.equal(f.resources.calls.active, false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.session.background().latent.affiliativeTone, 0);
});
for (const change of ['revoke', 'purge', 'consent'] as const)
  test(`${change} cancels pending output; no late delivery`, async (t) => {
    const d = deferred<InteractionResponse>(),
      f = fixture(t, () => d.promise);
    f.ready();
    const ref = f.memory('topic prior');
    const pending = f.send('old', 'synthetic', { recallQuery: 'topic' });
    await tick();
    if (change === 'revoke') f.session.revoke(ref);
    else if (change === 'purge') f.session.purge();
    else f.session.setLearningConsent(true);
    await assert.rejects(pending);
    d.resolve(positive);
    await tick();
    assert.equal(f.session.status.invalidated, true);
    assert.equal(f.session.status.deliveries, 0);
  });
test('conditioning sources stay revocable but do not consume repeated fresh appraisal roots', async (t) => {
  const f = fixture(t);
  const old = f.memory('old context'),
    a = f.memory('fresh a'),
    b = f.memory('fresh b');
  const state = new BackgroundState(f.store, f.scope, { clock: () => f.clock.now });
  state.setContext({ quiet: false, available: true });
  await state.appraise({ id: 'a', refs: [a], conditioningRefs: [old] }, async () => positive.appraisal);
  await state.appraise({ id: 'b', refs: [b], conditioningRefs: [old] }, async () => positive.appraisal);
  assert.equal(state.read().sourceRefs.length, 3);
  await assert.rejects(
    state.appraise({ id: 'alias', refs: [a], conditioningRefs: [old] }, async () => positive.appraisal),
    code('BACKGROUND_APPRAISAL_SOURCE_REPLAY'),
  );
  f.store.revoke(f.scope, old);
  assert.throws(() => state.read());
});
test('external authority mutation after recall cannot be laundered via fresh beginRun', async (t) => {
  const d = deferred<InteractionResponse>(),
    f = fixture(t, () => d.promise);
  f.ready();
  const ref = f.memory('topic recalled');
  const pending = f.send('first', 'synthetic', { recallQuery: 'topic' });
  await tick();
  f.store.revoke(f.scope, ref);
  d.resolve(positive);
  await assert.rejects(pending);
  assert.equal(f.session.status.deliveries, 0);
});
test('switch backend resets worker/state and retains dedup and quota resources', async (t) => {
  const f = fixture(t);
  f.ready();
  const result = await f.send('same');
  f.ack(result.deliveryId);
  let resets = 0,
    steps = 0;
  const adapter: PriorAdapter = {
    manifest: { implementation: 'synthetic', sourceHash: 'a'.repeat(64), biologicalClaim: 'none' },
    reset: async () => {
      resets++;
    },
    step: async () => {
      steps++;
      return { social: 1, novelty: 0, disengagement: 0 };
    },
  };
  await f.session.switchBackend('flywire', adapter);
  assert.equal(f.session.status.paused, true);
  f.session.resume();
  await assert.rejects(f.send('same'), code('DELIVERY_STALE'));
  await f.send('fresh');
  assert.equal(steps, 1);
  assert.equal(resets, 1);
  await f.session.switchBackend('no-state');
  assert.equal(resets, 2);
  assert.equal(f.requests.length, 2);
});
test('bounded session ledger refuses rather than evicting identities', async (t) => {
  const f = fixture(t, async () => neutral, { maxEntries: 1 });
  f.ready();
  await f.send('one');
  await assert.rejects(f.send('two'), code('SESSION_CAPACITY_REACHED'));
  assert.equal(f.requests.length, 1);
});
test('coupled model memory is an uncommitted candidate and cannot launder recalled facts', async (t) => {
  const f = fixture(t, async () => ({
    ...neutral,
    memoryProposal: {
      kind: 'claim',
      basis: 'self_report',
      statement: 'Violet old fact',
      validFrom: null,
      validTo: null,
    },
  }));
  f.ready();
  const old = f.memory('Violet old fact');
  const result = await f.send('fresh', 'new selected text', { recallQuery: 'Violet' });
  const delivery = f.session.takeDelivery(result.deliveryId);
  assert.equal(delivery.memoryRef, null);
  assert.equal(delivery.memoryCandidate!.statement, 'Violet old fact');
  f.store.revoke(f.scope, old);
  assert.equal(f.store.search(f.scope, 'Violet').length, 0);
});
test('stateful neural worker requires confirmed clean reset and can never cross session ownership', async (t) => {
  const f = fixture(t);
  f.ready();
  let hidden = 0,
    resets = 0;
  const seen: number[] = [];
  const adapter: PriorAdapter = {
    manifest: { implementation: 'synthetic', sourceHash: 'b'.repeat(64), biologicalClaim: 'none' },
    reset: async () => {
      hidden = 0;
      resets++;
    },
    step: async () => {
      hidden += 0.3;
      seen.push(hidden);
      return { social: hidden, novelty: 0, disengagement: 0 };
    },
  };
  await f.session.switchBackend('flywire', adapter);
  f.session.resume();
  await f.send('a');
  f.session.reset();
  await f.send('b');
  assert.deepEqual(seen, [0.3, 0.3]);
  assert.equal(resets, 2);
  assert.throws(
    () =>
      new CoupledSession(f.store, f.scope, {
        provider: f.provider,
        resources: f.resources,
        priorAdapter: adapter,
        backend: 'flywire',
      }),
    code('NEURAL_BINDING_REUSE_FORBIDDEN'),
  );
  f.session.pause();
  f.session.purge();
  assert.equal(f.session.status.invalidated, true);
});
test('reset failure never permits a neural step', async (t) => {
  const f = fixture(t);
  f.ready();
  let steps = 0;
  const adapter: PriorAdapter = {
    manifest: { implementation: 'synthetic', sourceHash: 'c'.repeat(64), biologicalClaim: 'none' },
    reset: async () => {
      throw new Error('synthetic reset refusal');
    },
    step: async () => {
      steps++;
      return { social: 0, novelty: 0, disengagement: 0 };
    },
  };
  await assert.rejects(f.session.switchBackend('flywire', adapter));
  assert.equal(f.session.status.paused, true);
  assert.equal(steps, 0);
});
test('stopScheduler cancels its active proactive request and suppresses the stale consumer', async (t) => {
  const started = deferred<void>(),
    late = deferred<InteractionResponse>();
  const f = fixture(t, async (request) => {
    if (request.kind === 'proactive') {
      started.resolve();
      return late.promise;
    }
    return positive;
  });
  f.ready();
  f.memory('topic chat');
  for (let i = 0; i < 3; i++) await f.send(`warm-${i}`);
  f.clock.now = f.session.background().nextWakeAt! + 1;
  let delivered = 0,
    errors = 0;
  f.session.startScheduler({
    recallQuery: 'topic',
    refreshContext: () => ({ quiet: false, available: true, ttlMs: 300_000 }),
    onReady: () => {
      delivered++;
    },
    onError: () => {
      errors++;
    },
  });
  const hold = setTimeout(() => started.resolve(), 1000);
  await started.promise;
  clearTimeout(hold);
  assert.equal(f.requests.length, 4);
  f.session.stopScheduler();
  late.resolve(positive);
  await tick();
  await tick();
  assert.equal(delivered, 0);
  assert.equal(errors, 0);
});
test('cancelled scheduler logical work and its raw provider must both drain before foreground admission', async (t) => {
  const started = deferred<void>(),
    late = deferred<InteractionResponse>();
  const f = fixture(t, async (request) => {
    if (request.kind === 'proactive') {
      started.resolve();
      return late.promise;
    }
    return positive;
  });
  f.ready();
  for (let i = 0; i < 3; i++) await f.send(`warm-idle-${i}`);
  f.clock.now = f.session.background().nextWakeAt! + 1;
  f.session.startScheduler({
    recallQuery: 'synthetic',
    refreshContext: () => ({ quiet: false, available: true, ttlMs: 300000 }),
    onReady: () => assert.fail('cancelled proactive must not deliver'),
    onError: () => {},
  });
  const guard = setTimeout(() => started.resolve(), 1000);
  await started.promise;
  clearTimeout(guard);
  assert.equal(f.requests.length, 4);
  f.session.stopScheduler();
  let idle = false;
  const waiting = f.session.waitForIdle(new AbortController().signal).then(() => {
    idle = true;
  });
  await tick();
  assert.equal(idle, false);
  assert.equal(f.resources.calls.active, true);
  late.resolve(positive);
  await waiting;
  assert.equal(f.resources.calls.active, false);
  await f.send('new-foreground');
  assert.equal(f.requests.length, 5);
  assert.equal(f.requests.at(-1)!.kind, 'user');
});
test('raw idle observer cancellation removes only the waiter and permits one subsequent observer', async () => {
  const permit = new RawOperationPermit(),
    done = deferred<void>(),
    runAbort = new AbortController();
  const running = permit.run(runAbort.signal, () => done.promise),
    aborted = assert.rejects(running, { name: 'AbortError' });
  runAbort.abort();
  await aborted;
  const one = new AbortController(),
    first = permit.waitForIdle(one.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(permit.waitForIdle(new AbortController().signal), /INTERACTION_BACKPRESSURE/);
  one.abort();
  await rejected;
  assert.equal(permit.active, true);
  let settled = false;
  const second = permit.waitForIdle(new AbortController().signal).then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  done.resolve();
  await second;
  assert.equal(permit.active, false);
});
test('foreground admitted after drain keeps only the original remaining host lease', async (t) => {
  const f = fixture(t, async () => neutral);
  f.ready();
  f.session.setHostContext({ quiet: false, available: true, ttlMs: 30000 });
  const raw = deferred<void>(),
    operation = f.resources.transport.run(new AbortController().signal, () => raw.promise);
  const waiting = f.session.waitForIdle(new AbortController().signal);
  f.clock.now = 29000;
  raw.resolve();
  await operation;
  await waiting;
  const result = await f.send('after-long-drain'),
    delivery = f.session.takeDelivery(result.deliveryId);
  assert.equal(delivery.expiresAtMonotonicMs, 30000);
});
test('scheduler contains thrown and async rejecting consumers', async (t) => {
  const f = fixture(t, async () => positive);
  f.ready();
  f.memory('topic chat');
  for (let i = 0; i < 3; i++) await f.send(`warm-${i}`);
  f.clock.now = f.session.background().nextWakeAt! + 1;
  const notified = deferred<void>();
  f.session.startScheduler({
    recallQuery: 'topic',
    refreshContext: () => ({ quiet: false, available: true, ttlMs: 300_000 }),
    onReady: async () => {
      notified.resolve();
      throw new Error('synthetic consumer failure');
    },
    onError: () => {
      throw new Error('synthetic error consumer');
    },
  });
  const hold = setTimeout(() => notified.resolve(), 1000);
  await notified.promise;
  clearTimeout(hold);
  await tick();
  f.session.stopScheduler();
  assert.equal(f.requests.length, 4);
});
test('request caps are rolling windows and total never resets', () => {
  let now = 0;
  const budget = new RequestBudget({ total: 3, hourly: 2, daily: 3 }, () => now);
  budget.reserve();
  now = 3_599_999;
  budget.reserve();
  now = 3_600_000;
  budget.reserve();
  assert.throws(() => budget.reserve(), code('REQUEST_BUDGET_EXHAUSTED'));
  now = 86_400_001;
  assert.throws(() => budget.reserve(), code('REQUEST_BUDGET_EXHAUSTED'));
  assert.equal(budget.usage.total, 3);
});
test('HTTP final-content schema preserves language, separates memory and enforces pre-fetch hard budget', async (t) => {
  const f = fixture(t);
  f.ready();
  await f.send('capture');
  const request = f.requests[0]!;
  let fetches = 0,
    payload: any;
  const budget = new RequestBudget({ total: 1, hourly: 1, daily: 1 }),
    resources = new InteractionResources(budget);
  const provider = new HttpInteractionProvider(
    { transport: 'local_http', endpoint: 'http://127.0.0.1/test', model: 'synthetic' },
    resources,
    {
      fetch: async (_u, init) => {
        fetches++;
        payload = JSON.parse(init!.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(neutral),
                  reasoning_content: 'ignored synthetic hidden text',
                },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );
  assert.equal(
    (await provider.interact({ ...request, signal: new AbortController().signal })).responseText,
    neutral.responseText,
  );
  assert.equal(payload.response_format.type, 'json_object');
  assert.match(payload.messages[0].content, /original language/);
  await assert.rejects(
    provider.interact({ ...request, signal: new AbortController().signal }),
    code('REQUEST_BUDGET_EXHAUSTED'),
  );
  assert.equal(fetches, 1);
  assert.equal(budget.usage.total, 1);
});
test('HTTP cancelled hung cleanup retains transport permit and charges only actual fetch', async (t) => {
  const f = fixture(t);
  f.ready();
  await f.send('capture');
  const request = f.requests[0]!;
  const resources = new InteractionResources(new RequestBudget({ total: 5, hourly: 5, daily: 5 }));
  let fetches = 0;
  const provider = new HttpInteractionProvider(
    { transport: 'local_http', endpoint: 'http://127.0.0.1/test', model: 'synthetic', timeoutMs: 20 },
    resources,
    {
      fetch: async () => {
        fetches++;
        return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 500 });
      },
    },
  );
  await assert.rejects(provider.interact({ ...request, signal: new AbortController().signal }));
  assert.equal(resources.transport.active, true);
  await assert.rejects(
    provider.interact({ ...request, signal: new AbortController().signal }),
    code('INTERACTION_BACKPRESSURE'),
  );
  assert.equal(fetches, 1);
  assert.equal(resources.budget.usage.total, 1);
});
test('HTTP candidate schema matches validation and exposes only safe rejection stage/code', async (t) => {
  const f = fixture(t);
  f.ready();
  await f.send('capture');
  const request = f.requests[0]!;
  const diagnostics: unknown[] = [];
  const resources = new InteractionResources(new RequestBudget({ total: 1, hourly: 1, daily: 1 }));
  const invalid = {
    ...neutral,
    memoryProposal: {
      kind: 'status',
      basis: 'self_report',
      statement: 'synthetic private-looking data',
      validFrom: null,
      validTo: null,
    },
  };
  const provider = new HttpInteractionProvider(
    { transport: 'local_http', endpoint: 'http://127.0.0.1/test', model: 'synthetic' },
    resources,
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(invalid) } },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      onRejectedResponse: async (diagnostic) => {
        diagnostics.push(diagnostic);
        throw new Error('synthetic hook failure');
      },
    },
  );
  await assert.rejects(
    provider.interact({ ...request, signal: new AbortController().signal }),
    code('PROVIDER_RESPONSE_INVALID'),
  );
  assert.deepEqual(diagnostics, [{ stage: 'content', code: 'TTL_REQUIRED' }]);
  await tick();
  assert.equal(JSON.stringify(diagnostics).includes('private-looking'), false);
});

test('deterministic real BackgroundState crossing and explicit window are independent from 30s observed presence', async (t) => {
  const f = fixture(t, async () => ({ ...positive, appraisal: { ...positive.appraisal, confidence: 0.4 } }), {
    enableProactive: true,
  });
  f.ready();
  for (let i = 0; i < 5; i++) {
    f.clock.now = i * 20000;
    f.session.setHostContext({ quiet: false, available: true, ttlMs: 30000 });
    const result = await f.send(`natural-${i}`, 'synthetic topic friend');
    f.ack(result.deliveryId);
  }
  const before = f.session.background(),
    crossing = before.nextWakeAt!;
  assert.ok(crossing > 110000, 'unchanged dynamics cross after the observed 80s + 30s lease');
  const entries = f.session.status.entries;
  f.session.grantCompanionWindow('trusted-window', 180000, 'trusted-stdio');
  assert.deepEqual(f.session.background().latent, before.latent);
  assert.deepEqual(f.session.background().targets, before.targets);
  assert.equal(f.session.background().ledgerSize, before.ledgerSize);
  assert.equal(f.session.status.entries, entries);
  assert.equal(f.requests.length, 5);
  f.clock.now = 110001;
  const withoutPresence = f.session.background();
  assert.equal(withoutPresence.context.available, false);
  assert.equal(withoutPresence.context.proactiveAllowed, true);
  assert.equal(withoutPresence.context.quiet, false);
  assert.equal(f.session.considerShadow(), null);
  f.clock.now = crossing + 1;
  const ready = deferred<any>();
  f.session.startScheduler({
    recallQuery: '/companion-window must never be recall',
    refreshContext: () => ({ quiet: false, available: false, ttlMs: 1 }),
    onReady: ready.resolve,
    onError: (code) => ready.resolve({ error: code }),
  });
  const hold = setTimeout(() => ready.resolve(null), 1000);
  const result = await ready.promise;
  clearTimeout(hold);
  assert.ok(result);
  assert.equal(result.error, undefined);
  const delivery = f.session.takeDelivery(result.deliveryId);
  assert.equal(delivery.kind, 'proactive');
  assert.equal(delivery.expiresAtMonotonicMs, f.clock.now + 30000);
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests[5]!.selectedText, null);
  assert.ok(f.requests[5]!.recalled.some((x) => x.statement === 'synthetic topic friend'));
  assert.equal(f.session.status.companionWindow.expiresAtMonotonicMs, 260000);
  f.clock.now = 260000;
  assert.equal(f.session.status.companionWindow.active, false);
  await assert.rejects(f.session.considerProactive('synthetic'), code('HOST_CONTEXT_BLOCKED'));
});

test('window needs explicit enable and latest actual human ACK; replay and active renew cannot extend', async (t) => {
  const disabled = fixture(t);
  disabled.ready();
  assert.throws(() => disabled.session.grantCompanionWindow('no', 180000, 'trusted-stdio'), code('PROACTIVE_DISABLED'));
  const f = fixture(t, async () => positive, { enableProactive: true });
  f.ready();
  assert.throws(
    () => f.session.grantCompanionWindow('early', 180000, 'trusted-stdio'),
    code('COMPANION_WINDOW_REQUIRES_HUMAN_ACK'),
  );
  const result = await f.send('anchor');
  assert.throws(
    () => f.session.grantCompanionWindow('before-ack', 180000, 'trusted-stdio'),
    code('COMPANION_WINDOW_REQUIRES_HUMAN_ACK'),
  );
  f.ack(result.deliveryId);
  f.session.grantCompanionWindow('one', 1000, 'trusted-stdio');
  const original = f.session.status.companionWindow;
  f.clock.now = 500;
  assert.throws(() => f.session.grantCompanionWindow('two', 300000, 'trusted-stdio'), code('COMPANION_WINDOW_ACTIVE'));
  assert.throws(
    () => f.session.grantCompanionWindow('one', 300000, 'trusted-stdio'),
    code('COMPANION_WINDOW_ID_REUSED'),
  );
  assert.equal(f.session.status.companionWindow.expiresAtMonotonicMs, original.expiresAtMonotonicMs);
  f.clock.now = 1000;
  assert.throws(
    () => f.session.grantCompanionWindow('one', 300000, 'trusted-stdio'),
    code('COMPANION_WINDOW_ID_REUSED'),
  );
  f.session.grantCompanionWindow('two', 300000, 'trusted-stdio');
  f.session.pause();
  f.session.resume();
  assert.equal(f.session.status.companionWindow.active, false);
});

for (const action of ['off', 'pause', 'switch', 'quiet', 'reset', 'revoke'] as const)
  test(`window ${action} destroys permission and prepared output`, async (t) => {
    const f = fixture(t, async () => positive, { enableProactive: true });
    f.ready();
    let last!: Awaited<ReturnType<typeof f.send>>;
    for (let i = 0; i < 3; i++) {
      last = await f.send(`w-${i}`, 'synthetic topic friend');
      f.ack(last.deliveryId);
    }
    f.session.grantCompanionWindow('one', 300000, 'trusted-stdio');
    f.clock.now = f.session.background().nextWakeAt! + 1;
    const prepared = await f.session.considerProactive('topic');
    assert.ok(prepared);
    if (action === 'off') f.session.clearCompanionWindow();
    if (action === 'pause') f.session.pause();
    if (action === 'switch') await f.session.switchBackend('baseline');
    if (action === 'quiet') f.session.setHostContext({ quiet: true, available: true, ttlMs: 30000 });
    if (action === 'reset') f.session.reset();
    if (action === 'revoke') f.session.revoke(f.session.status.lastSourceRef!);
    assert.equal(f.session.status.companionWindow.active, false);
    assert.throws(() => f.session.takeDelivery(prepared.deliveryId));
  });

test('off preserves foreground appraisal and receipt, and old ACK cannot rearm; next fresh ACK may', async (t) => {
  const pending = deferred<InteractionResponse>();
  let hold = false;
  const f = fixture(t, async () => (hold ? pending.promise : positive), { enableProactive: true });
  f.ready();
  const anchor = await f.send('anchor');
  f.ack(anchor.deliveryId);
  f.session.grantCompanionWindow('one', 180000, 'trusted-stdio');
  hold = true;
  const human = f.send('fresh');
  await tick();
  assert.throws(() => f.session.grantCompanionWindow('busy', 180000, 'trusted-stdio'), code('COMPANION_WINDOW_BUSY'));
  f.session.clearCompanionWindow();
  pending.resolve(positive);
  const result = await human;
  assert.equal(result.appraisalStatus, 'applied');
  f.ack(result.deliveryId);
  assert.equal(f.session.status.proactiveAllowed, false);
  assert.equal(f.session.status.paused, false);
  hold = false;
  const next = await f.send('next');
  f.ack(next.deliveryId);
  assert.equal(f.session.status.proactiveAllowed, true);
});

test('window cannot extend a foreground original deadline', async (t) => {
  const delayed = deferred<InteractionResponse>();
  let hold = false;
  const f = fixture(t, async () => (hold ? delayed.promise : positive), { enableProactive: true });
  f.ready();
  for (let i = 0; i < 3; i++) {
    const result = await f.send(`a-${i}`);
    f.ack(result.deliveryId);
  }
  f.session.setHostContext({ quiet: false, available: true, ttlMs: 30000 });
  f.session.grantCompanionWindow('one', 300000, 'trusted-stdio');
  f.clock.now = 29000;
  hold = true;
  const human = f.send('late-human');
  await tick();
  f.clock.now = 30001;
  delayed.resolve(positive);
  await assert.rejects(human);
  assert.equal(f.session.status.companionWindow.active, true);
  assert.equal(f.session.background().context.available, false);
});

for (const bound of ['operation-30s', 'window-1s'] as const)
  test(`proactive response is refused at the fixed ${bound} boundary despite a longer observed or explicit permission`, async (t) => {
    const late = deferred<InteractionResponse>();
    const f = fixture(t, async (request) => (request.kind === 'proactive' ? late.promise : positive), {
      enableProactive: true,
    });
    f.ready();
    for (let i = 0; i < 3; i++) {
      const r = await f.send(`a-${i}`);
      f.ack(r.deliveryId);
    }
    f.clock.now = f.session.background().nextWakeAt! + 1;
    f.session.setHostContext({ quiet: false, available: true, ttlMs: 1 });
    f.session.grantCompanionWindow('one', bound === 'window-1s' ? 1000 : 300000, 'trusted-stdio');
    const pending = f.session.considerProactive('synthetic'),
      rejected = assert.rejects(pending);
    await tick();
    f.clock.now += bound === 'window-1s' ? 1000 : 30000;
    late.resolve(positive);
    await rejected;
    assert.equal(f.session.status.deliveries, 3);
  });
