import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BackgroundState } from '../src/background-state.ts';
import type { AppraisalHypothesis } from '../src/background-state.ts';
import type { Scope, SourceRef } from '../src/contracts.ts';
import { MemoryStore } from '../src/store.ts';
import { CoreError } from '../src/validation.ts';

// Default: a fast, logical-clock synthetic replay. A real-duration comparison
// runs only if explicitly requested. It measures process work, not electrical power.
let durationSeconds = 0;
let mode: 'event' | 'tick' = 'event';
let readiness = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--duration-seconds') durationSeconds = Number(args[++i]);
  else if (arg === '--mode') {
    const value = args[++i];
    if (value !== 'event' && value !== 'tick') throw Error('mode must be event or tick');
    mode = value;
  } else if (arg === '--readiness') readiness = true;
  else throw Error(`Unknown argument: ${arg}`);
}
if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 600)
  throw Error('duration-seconds must be finite in [0,600]');

const directory = mkdtempSync(join(tmpdir(), 'companion-background-state-'));
const sourceDirectory = join(directory, 'source'); mkdirSync(sourceDirectory);
const sources: Record<string, string> = {};
for (const relative of ['src/background-state.ts', 'src/store.ts', 'scripts/background-state-probe.ts']) {
  const bytes = readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)));
  sources[relative] = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(sourceDirectory, relative.replaceAll('/', '__')), bytes, { flag: 'wx' });
}
let serial = 0;
function publish(store: MemoryStore, scope: Scope): SourceRef {
  const event = store.acceptEvent(scope, { source: 'synthetic-background-probe', eventKey: String(++serial), evidence: {
    speakerId: scope.subjectId, speakerRole: 'subject', mode: 'self_report',
    selectedText: `Synthetic explicit interaction feedback ${serial}`, occurredAt: null,
  } });
  const job = store.beginJob(scope, [event]), lease = store.claimLease(scope, job.id);
  store.propose(scope, job.id, lease.token, { kind: 'episode', basis: 'self_report',
    statement: `Synthetic feedback fixture ${serial}`, validFrom: null, validTo: null });
  return { id: store.publish(scope, job.id, lease.token).id, revision: 1 };
}
function makeScope(store: MemoryStore, relationshipId: string): Scope {
  return store.ensureScope({ tenantId: 'synthetic-background-lab', subjectId: 'synthetic-user',
    personaId: 'engineered-state', relationshipId });
}
function friendly(store: MemoryStore, scope: Scope, state: BackgroundState) {
  for (let i = 0; i < 3; i++) state.recordOutcome({ id: `friendly-${i}`, ref: publish(store, scope),
    origin: 'external-observation', outcome: 'engaged' });
}

async function simulation() {
  let now = 0;
  const database = join(directory, 'simulation.sqlite');
  const store = new MemoryStore(database, { clock: { wall: () => 1_000_000 + Math.floor(now), monotonic: () => now } });
  try {
    const scope = makeScope(store, 'counterfactual');
    const warm = new BackgroundState(store, scope, { clock: () => now });
    const cold = new BackgroundState(store, scope, { clock: () => now });
    const ablated = new BackgroundState(store, scope, { clock: () => now, ablation: 'no-state' });
    friendly(store, scope, warm); friendly(store, scope, ablated);
    const present = publish(store, scope);
    for (const state of [warm, cold, ablated]) {
      state.setContext({ quiet: false, available: true });
      state.observe({ id: 'same-present', refs: [present], novelty: 0, socialRelevance: 0, demand: 0 });
    }
    const predictedWake = warm.read().nextWakeAt;
    assert.ok(predictedWake !== null && predictedWake > now);
    now = predictedWake + 1;
    const counterfactual = { warm: warm.consider(), cold: cold.consider(), noState: ablated.consider(),
      attentionWarm: warm.read().attentionPrior, attentionCold: cold.read().attentionPrior, predictedWake };
    assert.equal(counterfactual.warm.intent?.motive, 'affiliation');
    assert.equal(counterfactual.cold.intent, null); assert.equal(counterfactual.noState.intent, null);
    warm.setContext({ quiet: true, available: true });
    const quiet = warm.consider(); assert.equal(quiet.reason, 'quiet'); assert.equal(quiet.nextWakeAt, null);
    warm.setContext({ quiet: false, available: true });
    const cooldown = warm.consider(); assert.equal(cooldown.reason, 'cooldown');
    let release!: (value: AppraisalHypothesis) => void;
    const raw = new Promise<AppraisalHypothesis>(resolve => { release = resolve; });
    const pending = warm.appraise({ id: 'delayed-synthetic', refs: [publish(store, scope)] }, async () => raw)
      .then(() => 'unexpected-applied', (error: unknown) => error instanceof CoreError ? error.code : 'unexpected-error');
    await Promise.resolve();
    const reset = warm.reset();
    release({ kind: 'appraisal-hypothesis', confidence: 1, valence: 1, arousal: 1, uncertainty: 0, fatigue: 0 });
    assert.equal(await pending, 'BACKGROUND_APPRAISAL_STALE');
    assert.equal(reset.latent.affiliativeTone, 0);
    const revokeRef = publish(store, scope);
    warm.observe({ id: 'revoke-demo', refs: [revokeRef], novelty: 1, socialRelevance: 0, demand: 0 });
    store.revoke(scope, revokeRef);
    let revoke = '';
    try { warm.read(); } catch (error) { revoke = error instanceof CoreError ? error.code : 'unexpected-error'; }
    assert.equal(revoke, 'STALE_RUN');
    const sleepScope = makeScope(store, 'sleep');
    const sleep = new BackgroundState(store, sleepScope, { clock: () => now });
    friendly(store, sleepScope, sleep);
    sleep.setContext({ quiet: false, available: true }); sleep.pause();
    now += 120_000;
    const resumed = sleep.resume();
    const afterSleep = sleep.consider(), repeatedAfterSleep = sleep.consider();
    assert.equal(afterSleep.intent?.motive, 'affiliation'); assert.equal(repeatedAfterSleep.intent, null);
    sleep.pause(); now += 3_600_000;
    const longIdle = sleep.resume();
    assert.equal(longIdle.targetValidUntil, null); assert.equal(sleep.consider().intent, null);
    return { status: 'PASS_SYNTHETIC_BACKGROUND_REPLAY', database, counterfactual, quiet, cooldown,
      resetLatent: reset.latent, resetRejectedLateAppraisal: true, revokedReadError: revoke,
      resumedLatent: resumed.latent, afterSleep, repeatedAfterSleep, longIdleLatent: longIdle.latent,
      realModelCalls: 0, messagesSent: 0, runtime: store.diagnostics() };
  } finally { store.close(); }
}

async function measurement() {
  const database = join(directory, 'measurement.sqlite');
  const store = new MemoryStore(database);
  let interval: ReturnType<typeof setInterval> | undefined;
  let wake: ReturnType<typeof setTimeout> | undefined;
  try {
    const scope = makeScope(store, 'bounded-comparison');
    const state = new BackgroundState(store, scope);
    friendly(store, scope, state);
    state.setContext({ quiet: false, available: true });
    let schedulerActivations = 0, shadowIntents = 0, stopped = false;
    const reasons: Record<string, number> = {};
    const before = state.read();
    const start = performance.now(), cpuStart = process.cpuUsage();
    if (readiness) console.log(JSON.stringify({ event: 'ready', pid: process.pid, directory, mode,
      durationSeconds, syntheticOnly: true, realModelCalls: 0, gpuUsed: false }));
    function check() {
      if (stopped) return;
      schedulerActivations++;
      const decision = state.consider();
      reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
      if (decision.intent) { state.validateIntent(decision.intent); shadowIntents++; }
      if (mode === 'event') schedule(decision.nextWakeAt);
    }
    function schedule(deadline: number | null) {
      if (wake !== undefined) clearTimeout(wake);
      wake = undefined;
      if (!stopped && deadline !== null) wake = setTimeout(check, Math.max(1, Math.ceil(deadline - performance.now())));
    }
    if (mode === 'tick') interval = setInterval(check, 100);
    else schedule(before.nextWakeAt);
    await new Promise<void>(resolve => setTimeout(() => { stopped = true; resolve(); }, durationSeconds * 1000));
    if (interval !== undefined) clearInterval(interval);
    if (wake !== undefined) clearTimeout(wake);
    const cpu = process.cpuUsage(cpuStart), wallElapsedMs = performance.now() - start;
    return { mode, durationSeconds, wallElapsedMs, cpuMicroseconds: cpu, schedulerActivations, shadowIntents,
      decisionReasons: reasons, before, after: state.read(), rssBytes: process.memoryUsage().rss, database,
      interpretation: 'bounded process CPU and scheduler callback counts; not hardware wakeups, system energy or battery-life evidence' };
  } finally {
    if (interval !== undefined) clearInterval(interval);
    if (wake !== undefined) clearTimeout(wake);
    store.close();
  }
}

try {
  const replay = await simulation();
  const measured = durationSeconds > 0 ? await measurement() : null;
  if (readiness && measured === null) console.log(JSON.stringify({ event: 'ready', pid: process.pid,
    directory, mode, durationSeconds, syntheticOnly: true, realModelCalls: 0, gpuUsed: false }));
  const result = { status: 'PASS_OFFLINE_BACKGROUND_STATE', directory, sources, replay, measurement: measured,
    fullPowerMeasurement: false, realModelCalls: 0, actualMessagesSent: 0, gpuUsed: false };
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ event: 'complete', status: result.status, result: join(directory, 'result.json'),
    measurement: measured === null ? 'NOT_RUN' : { schedulerActivations: measured.schedulerActivations,
      cpuMicroseconds: measured.cpuMicroseconds, wallElapsedMs: measured.wallElapsedMs } }));
} catch (error) {
  writeFileSync(join(directory, 'failure.json'), JSON.stringify({ status: 'FAILED', message: String(error), sources }, null, 2), { flag: 'wx' });
  throw error;
}
