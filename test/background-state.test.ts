import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { BackgroundState, BACKGROUND_DEFAULTS } from '../src/background-state.ts';
import type { AppraisalHypothesis, BackgroundLatent } from '../src/background-state.ts';
import { MemoryStore } from '../src/store.ts';
import { CoreError } from '../src/validation.ts';
import type { SourceRef } from '../src/contracts.ts';

const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
const positive: AppraisalHypothesis = { kind: 'appraisal-hypothesis', confidence: 1,
  valence: 1, arousal: 0, uncertainty: -0.2, fatigue: 0 };
function fixture(t: TestContext, options: { maxEvents?: number; maxSources?: number } = {}) {
  const clock = { now: 0 };
  const store = new MemoryStore(':memory:', { clock: { wall: () => 1_000_000 + Math.floor(clock.now), monotonic: () => clock.now } });
  t.after(() => store.close());
  const scope = store.ensureScope({ tenantId: 'test', subjectId: 'synthetic-user', personaId: 'test', relationshipId: 'test' });
  let serial = 0;
  function source(kind: 'subject' | 'assistant' | 'inference' = 'subject', validTo: number | null = null): SourceRef {
    const event = store.acceptEvent(scope, { source: 'synthetic', eventKey: String(++serial), evidence: {
      speakerId: kind === 'assistant' ? 'synthetic-assistant' : scope.subjectId,
      speakerRole: kind === 'assistant' ? 'assistant' : 'subject',
      mode: kind === 'assistant' ? 'observation' : 'self_report', selectedText: `synthetic evidence ${serial}`, occurredAt: null,
    } });
    const job = store.beginJob(scope, [event]), lease = store.claimLease(scope, job.id);
    store.propose(scope, job.id, lease.token, { kind: kind === 'inference' ? 'belief' : 'episode',
      basis: kind === 'inference' ? 'inference' : kind === 'assistant' ? 'observation' : 'self_report',
      statement: `synthetic memory ${serial}`, validFrom: null, validTo: kind === 'inference' ? 2_000_000 : validTo });
    return { id: store.publish(scope, job.id, lease.token).id, revision: 1 };
  }
  function bind(ablation: 'none' | 'no-state' = 'none') {
    return new BackgroundState(store, scope, { clock: () => clock.now, ablation, ...options });
  }
  function republish(refs: SourceRef[], validTo: number | null = null): SourceRef {
    const job = store.beginJob(scope, refs), lease = store.claimLease(scope, job.id);
    store.propose(scope, job.id, lease.token, { kind: 'episode', basis: 'self_report',
      statement: 'synthetic derived publication', validFrom: null, validTo });
    return { id: store.publish(scope, job.id, lease.token).id, revision: 1 };
  }
  function friendly(state: BackgroundState) {
    for (let i = 0; i < 3; i++) state.recordOutcome({ id: `friendly-${i}`, ref: source(), origin: 'external-observation', outcome: 'engaged' });
  }
  return { clock, store, scope, source, republish, bind, friendly };
}
function near(a: BackgroundLatent, b: BackgroundLatent) {
  for (const field of Object.keys(a) as Array<keyof BackgroundLatent>) assert.ok(Math.abs(a[field] - b[field]) < 1e-11, field);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('same present input/context differs with prior history; no-state ablation removes the effect', t => {
  const f = fixture(t), warm = f.bind(), cold = f.bind(), noState = f.bind('no-state');
  f.friendly(warm); f.friendly(noState);
  const current = f.source();
  for (const state of [warm, cold, noState]) {
    state.setContext({ quiet: false, available: true });
    state.observe({ id: 'same-present-input', refs: [current], novelty: 0, socialRelevance: 0, demand: 0 });
  }
  const wake = warm.read().nextWakeAt;
  assert.ok(wake !== null && wake > 0 && wake < BACKGROUND_DEFAULTS.targetValidityMs);
  assert.equal(cold.read().nextWakeAt, null);
  assert.equal(noState.read().nextWakeAt, null);
  f.clock.now = wake + 1;
  assert.equal(warm.consider().intent?.motive, 'affiliation');
  assert.equal(cold.consider().intent, null);
  assert.equal(noState.consider().intent, null);
  assert.ok(warm.read().attentionPrior.social > cold.read().attentionPrior.social);
});

test('idle motive accumulates analytically; past positive target expires and cannot create permanent drive', t => {
  const f = fixture(t), state = f.bind(); f.friendly(state);
  state.setContext({ quiet: false, available: true });
  const first = state.read();
  f.clock.now = 60_000;
  assert.ok(state.read().latent.affiliation > first.latent.affiliation);
  f.clock.now = 3_600_000;
  const late = state.read();
  assert.equal(late.targetValidUntil, null);
  assert.deepEqual(late.targets, { affiliation: 0.13, withdrawal: 0.21 });
  assert.ok(late.latent.affiliation < BACKGROUND_DEFAULTS.low);
  assert.equal(late.nextWakeAt, null);
  assert.equal(state.consider().intent, null);
});

test('quiet/unavailable suppress deadlines and intents even after a threshold; no repeating latch storm', t => {
  const f = fixture(t), state = f.bind(); f.friendly(state);
  f.clock.now = 120_000;
  assert.equal(state.consider().reason, 'quiet');
  assert.equal(state.read().nextWakeAt, null);
  state.setContext({ quiet: false, available: false });
  assert.equal(state.consider().reason, 'unavailable');
  assert.equal(state.read().nextWakeAt, null);
  state.setContext({ quiet: false, available: true });
  const intent = state.consider().intent;
  assert.ok(intent); state.validateIntent(intent);
  assert.equal(state.consider().reason, 'cooldown');
  f.clock.now += BACKGROUND_DEFAULTS.cooldownMs + 1;
  assert.equal(state.consider().intent, null);
  assert.equal(state.read().nextWakeAt, null);
  assert.throws(() => state.validateIntent(intent), code('BACKGROUND_INTENT_STALE'));
});

test('withdrawal competes after actual declined feedback and respects the shared cooldown', t => {
  const f = fixture(t), state = f.bind(); f.friendly(state);
  state.setContext({ quiet: false, available: true });
  f.clock.now = state.read().nextWakeAt! + 1;
  const social = state.consider().intent!;
  for (let i = 0; i < 4; i++) state.recordOutcome({ id: `declined-${i}`, ref: f.source(), origin: 'external-observation', outcome: 'declined' });
  f.clock.now += 60_000;
  assert.equal(state.consider().reason, 'cooldown');
  const wake = state.read().nextWakeAt;
  assert.ok(wake !== null && wake >= social.createdAtMonotonicMs + BACKGROUND_DEFAULTS.cooldownMs);
  f.clock.now = wake + 1;
  assert.equal(state.consider().intent?.motive, 'withdrawal');
});

test('pause/resume handles elapsed sleep without replaying ticks or issuing intent automatically', t => {
  const f = fixture(t), paused = f.bind(), active = f.bind();
  f.friendly(paused); f.friendly(active);
  for (const s of [paused, active]) s.setContext({ quiet: false, available: true });
  paused.pause();
  f.clock.now = 120_000;
  assert.equal(paused.consider().reason, 'paused');
  assert.equal(paused.read().nextWakeAt, null);
  const resumed = paused.resume();
  assert.equal('intent' in resumed, false);
  near(resumed.latent, active.read().latent);
  assert.equal(paused.consider().intent?.motive, 'affiliation');
  assert.equal(paused.consider().intent, null);
});

test('one analytical advance matches frequent reads across the target expiry boundary', t => {
  const f = fixture(t), event = f.bind(), polled = f.bind();
  f.friendly(event); f.friendly(polled);
  for (let i = 1; i <= 100; i++) { f.clock.now = i * 3_600; polled.read(); }
  near(event.read().latent, polled.read().latent);
  assert.deepEqual(event.read().targets, polled.read().targets);
});

test('reset retains consumed keys and per-source guards; capacity is rejected without eviction', t => {
  const f = fixture(t, { maxEvents: 1 }), state = f.bind(), ref = f.source();
  const input = { id: 'once', refs: [ref], novelty: 1, socialRelevance: 1, demand: 0 };
  assert.equal(state.observe(input).status, 'applied');
  state.reset();
  assert.equal(state.observe(input).status, 'duplicate');
  assert.equal(state.read().latent.activation, 0.2);
  assert.throws(() => state.observe({ ...input, id: 'different-key' }), code('BACKGROUND_OBSERVATION_SOURCE_REPLAY'));
  assert.throws(() => state.observe({ ...input, refs: [f.source()], id: 'new-source' }), code('BACKGROUND_CAPACITY_REACHED'));
  assert.equal(state.read().ledgerSize, 1);
  assert.throws(() => state.observe({ ...input, demand: 1 }), code('BACKGROUND_IDEMPOTENCY_CONFLICT'));
});

test('source budget rejects a new source without dropping older influence guards', t => {
  const f = fixture(t, { maxSources: 1 }), state = f.bind(), ref = f.source();
  state.observe({ id: 'one', refs: [ref], novelty: 1, socialRelevance: 0, demand: 0 });
  assert.throws(() => state.observe({ id: 'two', refs: [f.source()], novelty: 0, socialRelevance: 0, demand: 0 }), code('BACKGROUND_CAPACITY_REACHED'));
  f.store.revoke(f.scope, ref);
  assert.throws(() => state.read(), code('STALE_RUN'));
  assert.throws(() => state.read(), code('BACKGROUND_REBIND_REQUIRED'));
});

test('outcomes require published subject self-report, not assistant observations or model hypotheses', t => {
  const f = fixture(t);
  for (const kind of ['assistant', 'inference'] as const) {
    const state = f.bind();
    assert.throws(() => state.recordOutcome({ id: kind, ref: f.source(kind), origin: 'external-observation', outcome: 'engaged' }),
      code('BACKGROUND_OUTCOME_REQUIRES_SELF_REPORT'));
  }
  const state = f.bind(), ref = f.source();
  state.recordOutcome({ id: 'external', ref, origin: 'external-observation', outcome: 'engaged' });
  assert.equal(state.recordOutcome({ id: 'external', ref, origin: 'external-observation', outcome: 'engaged' }).status, 'duplicate');
  assert.throws(() => state.recordOutcome({ id: 'fake-new-key', ref, origin: 'external-observation', outcome: 'engaged' }), code('BACKGROUND_OUTCOME_SOURCE_REPLAY'));
});

test('published source expiry, foreign scope, purge and consent/runtime changes invalidate the whole binding', t => {
  const f = fixture(t), expired = f.bind(), expiring = f.source('subject', 1_001_000);
  expired.observe({ id: 'ttl', refs: [expiring], novelty: 1, socialRelevance: 1, demand: 0 });
  f.clock.now = 1_001;
  assert.throws(() => expired.read(), code('BACKGROUND_SOURCE_INVALID'));
  assert.throws(() => expired.read(), code('BACKGROUND_REBIND_REQUIRED'));
  const other = f.store.ensureScope({ tenantId: 'test', subjectId: 'other', personaId: 'test', relationshipId: 'test' });
  const foreign = new BackgroundState(f.store, other, { clock: () => f.clock.now });
  assert.throws(() => foreign.observe({ id: 'foreign', refs: [f.source()], novelty: 0, socialRelevance: 0, demand: 0 }), code('BACKGROUND_SOURCE_INVALID'));
  const beforeConsent = f.bind();
  const current = f.store.setLearningConsent(f.scope, true);
  assert.throws(() => beforeConsent.read(), code('STALE_CONSENT'));
  const beforePurge = new BackgroundState(f.store, current, { clock: () => f.clock.now });
  f.store.purge(current);
  assert.throws(() => beforePurge.read(), code('STALE_SCOPE'));
});

test('intent identity, context, local generation and authority are checked at delivery', t => {
  const f = fixture(t), state = f.bind(); f.friendly(state);
  state.setContext({ quiet: false, available: true });
  f.clock.now = 120_000;
  const intent = state.consider().intent!;
  state.validateIntent(intent);
  assert.throws(() => state.validateIntent({ ...intent }), code('BACKGROUND_INTENT_STALE'));
  state.setContext({ quiet: true, available: true });
  assert.throws(() => state.validateIntent(intent), code('BACKGROUND_INTENT_STALE'));
  state.setContext({ quiet: false, available: true });
  state.reset();
  assert.throws(() => state.validateIntent(intent), code('BACKGROUND_INTENT_STALE'));
  const existing = state.read().sourceRefs;
  assert.equal(existing.length, 0);
  f.store.revoke(f.scope, f.source()); // Even an unrelated revoke changes this scope's runtime epoch.
  assert.throws(() => state.validateIntent(intent), code('STALE_RUN'));
});

test('reset cancels local appraisal promptly but noncooperative raw evaluation retains the permit', async t => {
  const f = fixture(t), state = f.bind(), first = f.source(), second = f.source();
  state.setContext({ quiet: false, available: true });
  const raw = deferred<AppraisalHypothesis>(); let calls = 0;
  const pending = state.appraise({ id: 'first', refs: [first] }, async () => { calls++; return raw.promise; });
  await Promise.resolve();
  const rejected = assert.rejects(pending, code('BACKGROUND_APPRAISAL_STALE'));
  state.reset(); await rejected;
  await assert.rejects(state.appraise({ id: 'second', refs: [second] }, async () => { calls++; return positive; }), code('BACKGROUND_APPRAISAL_BUSY'));
  assert.equal(calls, 1);
  raw.resolve(positive);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(state.read().latent.affiliativeTone, 0);
  await assert.rejects(state.appraise({ id: 'first', refs: [first] }, async () => positive), code('BACKGROUND_APPRAISAL_TERMINAL'));
  await assert.rejects(state.appraise({ id: 'replacement-key', refs: [first] }, async () => positive), code('BACKGROUND_APPRAISAL_SOURCE_REPLAY'));
  assert.equal((await state.appraise({ id: 'second', refs: [second] }, async () => positive)).status, 'applied');
});

test('appraisal cannot self-amplify via new IDs or overlapping source sets', async t => {
  const f = fixture(t), state = f.bind(), first = f.source(), second = f.source();
  state.setContext({ quiet: false, available: true });
  await state.appraise({ id: 'hypothesis', refs: [first] }, async () => positive);
  const tone = state.read().latent.affiliativeTone;
  await assert.rejects(state.appraise({ id: 'new-id', refs: [first, second] }, async () => positive), code('BACKGROUND_APPRAISAL_SOURCE_REPLAY'));
  assert.equal(state.read().latent.affiliativeTone, tone);
  assert.equal((await state.appraise({ id: 'hypothesis', refs: [first] }, async () => { throw Error('must not run twice'); })).status, 'duplicate');
});

test('late appraisal is rejected on new event, source revoke and quiet context; blocked context calls no evaluator', async t => {
  const f = fixture(t), blocked = f.bind(); let calls = 0;
  await assert.rejects(blocked.appraise({ id: 'blocked', refs: [f.source()] }, async () => { calls++; return positive; }), code('BACKGROUND_APPRAISAL_CONTEXT_BLOCKED'));
  assert.equal(calls, 0);
  for (const reason of ['event', 'quiet', 'revoke'] as const) {
    const currentScope = f.store.scope(f.scope.id);
    const state = new BackgroundState(f.store, currentScope, { clock: () => f.clock.now });
    const ref = f.source();
    state.setContext({ quiet: false, available: true });
    const raw = deferred<AppraisalHypothesis>();
    const pending = state.appraise({ id: reason, refs: [ref] }, async () => raw.promise);
    await Promise.resolve();
    const rejected = assert.rejects(pending, code('BACKGROUND_APPRAISAL_STALE'));
    if (reason === 'event') state.observe({ id: 'newer', refs: [f.source()], novelty: 1, socialRelevance: 0, demand: 0 });
    else if (reason === 'quiet') state.setContext({ quiet: true, available: true });
    else { f.store.revoke(currentScope, ref); assert.throws(() => state.read(), code('STALE_RUN')); }
    await rejected;
    raw.resolve(positive);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (reason !== 'revoke') assert.equal(state.read().latent.affiliativeTone, 0);
  }
});

test('nonfinite input/clock, backward clock and serialized restoration fail closed', t => {
  const f = fixture(t), state = f.bind(), ref = f.source();
  assert.throws(() => state.observe({ id: 'nan', refs: [ref], novelty: NaN, socialRelevance: 0, demand: 0 }), code('BACKGROUND_INVALID_INPUT'));
  assert.equal(state.read().ledgerSize, 0);
  const snapshot = state.snapshot();
  assert.equal(snapshot.restorable, false);
  assert.throws(() => state.restore(snapshot), code('BACKGROUND_RESTORE_UNSUPPORTED'));
  assert.throws(() => state.restore(JSON.parse(JSON.stringify(snapshot))), code('BACKGROUND_RESTORE_UNSUPPORTED'));
  f.clock.now = 10; state.read(); f.clock.now = 9;
  assert.throws(() => state.read(), code('BACKGROUND_CLOCK_INVALID'));
  assert.throws(() => state.read(), code('BACKGROUND_REBIND_REQUIRED'));
  const nanClock = { now: 0 };
  const other = new BackgroundState(f.store, f.scope, { clock: () => nanClock.now });
  nanClock.now = Infinity;
  assert.throws(() => other.read(), code('BACKGROUND_CLOCK_INVALID'));
});

test('provenance deduplicates multiple publications and derived memories to their original interaction event', async t => {
  const f = fixture(t), first = f.source();
  const roots = f.store.publishedEventSources(f.scope, [first]);
  assert.equal(roots.length, 1);
  assert.deepEqual(Object.keys(roots[0]!).sort(), ['id', 'revision']);
  const second = f.republish(roots), derived = f.republish([first]);
  assert.deepEqual(f.store.publishedEventSources(f.scope, [first, second, derived]), roots);
  const observe = f.bind();
  observe.observe({ id: 'one', refs: [first], novelty: 1, socialRelevance: 1, demand: 0 });
  for (const ref of [second, derived]) assert.throws(() => observe.observe({ id: ref.id, refs: [ref], novelty: 1, socialRelevance: 1, demand: 0 }), code('BACKGROUND_OBSERVATION_SOURCE_REPLAY'));
  const outcome = f.bind();
  outcome.recordOutcome({ id: 'one', ref: first, origin: 'external-observation', outcome: 'engaged' });
  for (const ref of [second, derived]) assert.throws(() => outcome.recordOutcome({ id: ref.id, ref, origin: 'external-observation', outcome: 'engaged' }), code('BACKGROUND_OUTCOME_SOURCE_REPLAY'));
  const appraisal = f.bind(); appraisal.setContext({ quiet: false, available: true });
  await appraisal.appraise({ id: 'one', refs: [first] }, async () => positive);
  for (const ref of [second, derived]) await assert.rejects(appraisal.appraise({ id: ref.id, refs: [ref] }, async () => positive), code('BACKGROUND_APPRAISAL_SOURCE_REPLAY'));
  appraisal.reset();
  await assert.rejects(appraisal.appraise({ id: 'after-reset', refs: [derived] }, async () => positive), code('BACKGROUND_APPRAISAL_SOURCE_REPLAY'));
});

test('provenance rejects raw events, foreign scope, revoked and expired ancestors; root capacity is bounded', t => {
  const f = fixture(t, { maxSources: 2 }), a = f.source(), b = f.source(), c = f.source();
  const roots = f.store.publishedEventSources(f.scope, [a]);
  assert.throws(() => f.store.publishedEventSources(f.scope, roots), code('SOURCE_NOT_PUBLISHED'));
  const other = f.store.ensureScope({ tenantId: 'test', subjectId: 'other', personaId: 'test', relationshipId: 'test' });
  assert.throws(() => f.store.publishedEventSources(other, [a]), code('SOURCE_NOT_PUBLISHED'));
  const joint = f.republish([a, b, c]), bounded = f.bind();
  assert.throws(() => bounded.observe({ id: 'too-many-roots', refs: [joint], novelty: 1, socialRelevance: 0, demand: 0 }), code('BACKGROUND_CAPACITY_REACHED'));
  assert.equal(bounded.read().ledgerSize, 0);
  const expiring = f.source('subject', 1_001_000), derived = f.republish([expiring]);
  f.clock.now = 1_001;
  assert.throws(() => f.store.publishedEventSources(f.scope, [derived]), code('SOURCE_NOT_PUBLISHED'));
  f.store.revoke(f.scope, a);
  assert.throws(() => f.store.publishedEventSources(f.scope, [joint]), code('SOURCE_NOT_PUBLISHED'));
});

test('frozen appraisal maximum age rejects a late result even without another input', async t => {
  const f = fixture(t), state = f.bind(), ref = f.source();
  state.setContext({ quiet: false, available: true });
  const raw = deferred<AppraisalHypothesis>(); let deadline = -1;
  const pending = state.appraise({ id: 'slow', refs: [ref] }, async input => {
    deadline = input.deadlineAtMonotonicMs; return raw.promise;
  });
  await Promise.resolve();
  const rejected = assert.rejects(pending, code('BACKGROUND_APPRAISAL_EXPIRED'));
  assert.equal(deadline, BACKGROUND_DEFAULTS.appraisalMaxAgeMs);
  f.clock.now = 3_600_000;
  raw.resolve(positive); await rejected;
  assert.equal(state.read().latent.affiliativeTone, 0);
  await assert.rejects(state.appraise({ id: 'another-id', refs: [ref] }, async () => positive), code('BACKGROUND_APPRAISAL_SOURCE_REPLAY'));
});
