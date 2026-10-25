import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Epoch, RunTicket, SourceRef } from './contracts.ts';
import { MemoryStore } from './store.ts';
import { CoreError } from './validation.ts';

/** Engineered latent priors, never statements about the user's actual emotions. */
export type BackgroundLatent = {
  affiliativeTone: number; activation: number; uncertainty: number; fatigue: number;
  affiliation: number; withdrawal: number;
};
export type BackgroundContext = { quiet: boolean; available: boolean };
export type Motive = 'affiliation' | 'withdrawal';
export type BackgroundView = {
  kind: 'engineered-background-prior'; bindingId: string; generation: number;
  atMonotonicMs: number; paused: boolean; ablation: 'none' | 'no-state';
  latent: BackgroundLatent; targets: Record<Motive, number>; targetValidUntil: number | null;
  context: BackgroundContext; sourceRefs: SourceRef[];
  attentionPrior: { social: number; novelty: number; disengagement: number };
  ledgerSize: number; nextWakeAt: number | null;
};
export type ShadowIntent = Readonly<{
  kind: 'shadow-intent'; id: string; bindingId: string; motive: Motive;
  suggestedWork: 'consider-appraisal' | 'reduce-engagement';
  createdAtMonotonicMs: number; expiresAtMonotonicMs: number;
  /** No speaking, model invocation, scheduling or authorization is performed. */
  delivery: 'shadow-only';
}>;
export type ShadowDecision = { intent: ShadowIntent | null; nextWakeAt: number | null;
  reason: 'shadow-intent' | 'quiet' | 'unavailable' | 'paused' | 'below-threshold-or-latched' | 'cooldown' };
export type Observation = { id: string; refs: SourceRef[]; novelty: number; socialRelevance: number; demand: number };
export type InteractionOutcome = {
  id: string; ref: SourceRef; origin: 'external-observation';
  outcome: 'engaged' | 'declined' | 'tiring' | 'neutral';
};
export type AppraisalHypothesis = {
  kind: 'appraisal-hypothesis'; confidence: number;
  valence: number; arousal: number; uncertainty: number; fatigue: number;
};
export type AppraisalRequest = { id: string; refs: SourceRef[]; conditioningRefs?: SourceRef[] };
export type AppraisalEvaluator = (input: Readonly<{
  kind: 'background-hypothesis-request'; snapshot: BackgroundView;
  refs: readonly Readonly<SourceRef>[]; deadlineAtMonotonicMs: number; signal: AbortSignal;
}>) => Promise<AppraisalHypothesis>;
export type BackgroundReceipt = { status: 'applied' | 'duplicate'; view: BackgroundView };

export const BACKGROUND_DEFAULTS = Object.freeze({ fastTauMs: 20_000, slowTauMs: 300_000,
  driveTauMs: 60_000, high: 0.60, low: 0.35, cooldownMs: 120_000, intentTtlMs: 5_000,
  targetValidityMs: 300_000, appraisalMaxAgeMs: 15_000, maxEvents: 256, maxSources: 128 });
const initial = (): BackgroundLatent => ({ affiliativeTone: 0, activation: 0.2,
  uncertainty: 0.1, fatigue: 0.1, affiliation: 0.1, withdrawal: 0.1 });
const neutralTargets = (): Record<Motive, number> => ({ affiliation: 0.13, withdrawal: 0.21 });
const clip = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
function fail(code: string): never { throw new CoreError(code); }
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const key = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 128 && !value.includes('\0');
const refKey = (ref: SourceRef) => JSON.stringify([ref.id, ref.revision]);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type LedgerEntry = { hash: string; status: 'pending' | 'applied' | 'failed' };
type IntentSeal = { generation: number; revision: number; contextRevision: number };

/** Trusted in-process experiment. It owns no timer, GPU, provider or persistent state. */
export class BackgroundState {
  readonly #store: MemoryStore;
  readonly #ticket: RunTicket;
  readonly #clock: () => number;
  readonly #bindingId = randomUUID();
  readonly #ablation: 'none' | 'no-state';
  readonly #maxEvents: number;
  readonly #maxSources: number;
  #lastTime: number;
  #latent = initial();
  #targets = neutralTargets();
  #targetValidUntil: number | null = null;
  #context: BackgroundContext = { quiet: true, available: false };
  #generation = 1;
  #revision = 0;
  #contextRevision = 0;
  #paused = false;
  #invalidated = false;
  #cooldownUntil = 0;
  #armed: Record<Motive, boolean> = { affiliation: true, withdrawal: true };
  #sources = new Map<string, SourceRef>();
  #ledger = new Map<string, LedgerEntry>();
  #outcomeSources = new Set<string>();
  #observedSources = new Set<string>();
  #appraisedSources = new Set<string>();
  #rootIdentities = new Set<string>();
  #pending = new Map<string, AbortController>();
  #intents = new WeakMap<ShadowIntent, IntentSeal>();

  constructor(store: MemoryStore, epoch: Epoch, options: {
    clock?: () => number; ablation?: 'none' | 'no-state'; maxEvents?: number; maxSources?: number;
  } = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => performance.now());
    this.#ablation = options.ablation ?? 'none';
    this.#maxEvents = options.maxEvents ?? BACKGROUND_DEFAULTS.maxEvents;
    this.#maxSources = options.maxSources ?? BACKGROUND_DEFAULTS.maxSources;
    if (!['none', 'no-state'].includes(this.#ablation)
      || !Number.isSafeInteger(this.#maxEvents) || this.#maxEvents < 1 || this.#maxEvents > 1024
      || !Number.isSafeInteger(this.#maxSources) || this.#maxSources < 1 || this.#maxSources > 256)
      fail('BACKGROUND_INVALID_INPUT');
    this.#lastTime = this.#clock();
    if (!finite(this.#lastTime, 0, Number.MAX_SAFE_INTEGER)) fail('BACKGROUND_CLOCK_INVALID');
    this.#ticket = Object.freeze({ ...store.beginRun({ ...epoch }) });
    store.validateRun(this.#ticket);
  }

  #cancelPending(): void {
    for (const [id, controller] of this.#pending) {
      const entry = this.#ledger.get(id);
      if (entry) entry.status = 'failed';
      controller.abort();
    }
    // Aborting does not mean a noncooperative evaluator has stopped. Its raw
    // promise retains the sole permit until it settles, including across reset.
  }
  #clearInfluence(): void {
    this.#latent = initial();
    this.#targets = neutralTargets();
    this.#targetValidUntil = null;
    this.#sources.clear();
    this.#armed = { affiliation: true, withdrawal: true };
    this.#cooldownUntil = 0;
    this.#revision++;
  }
  #invalidate(): void {
    this.#invalidated = true;
    this.#generation++;
    this.#cancelPending();
    this.#clearInfluence();
    this.#ledger.clear();
    this.#outcomeSources.clear();
    this.#observedSources.clear();
    this.#appraisedSources.clear();
    this.#rootIdentities.clear();
    this.#intents = new WeakMap();
  }
  #advance(now: number): void {
    const elapsed = now - this.#lastTime;
    const activeElapsed = this.#targetValidUntil === null ? elapsed
      : Math.max(0, Math.min(now, this.#targetValidUntil) - this.#lastTime);
    this.#lastTime = now;
    if (this.#ablation === 'no-state') return;
    const fast = Math.exp(-elapsed / BACKGROUND_DEFAULTS.fastTauMs);
    const slow = Math.exp(-elapsed / BACKGROUND_DEFAULTS.slowTauMs);
    const drive = Math.exp(-activeElapsed / BACKGROUND_DEFAULTS.driveTauMs);
    const x = this.#latent;
    x.affiliativeTone *= slow;
    x.activation = 0.2 + (x.activation - 0.2) * fast;
    x.uncertainty = 0.1 + (x.uncertainty - 0.1) * fast;
    x.fatigue = 0.1 + (x.fatigue - 0.1) * slow;
    for (const motive of ['affiliation', 'withdrawal'] as const) {
      x[motive] = this.#targets[motive] + (x[motive] - this.#targets[motive]) * drive;
      if (elapsed > activeElapsed) x[motive] = neutralTargets()[motive]
        + (x[motive] - neutralTargets()[motive]) * Math.exp(-(elapsed - activeElapsed) / BACKGROUND_DEFAULTS.driveTauMs);
      if (x[motive] <= BACKGROUND_DEFAULTS.low + 1e-12) this.#armed[motive] = true;
    }
    if (this.#targetValidUntil !== null && now >= this.#targetValidUntil) {
      this.#targets = neutralTargets(); this.#targetValidUntil = null;
    }
  }
  #guard(): number {
    if (this.#invalidated) fail('BACKGROUND_REBIND_REQUIRED');
    let now: number;
    try { now = this.#clock(); }
    catch { this.#invalidate(); return fail('BACKGROUND_CLOCK_INVALID'); }
    if (!finite(now, 0, Number.MAX_SAFE_INTEGER) || now < this.#lastTime) {
      this.#invalidate(); return fail('BACKGROUND_CLOCK_INVALID');
    }
    try {
      // Validate the original ticket BEFORE obtaining a fresh ticket. Never relabel old state.
      this.#store.validateRun(this.#ticket);
      this.#store.validateRun(this.#store.beginRun(this.#ticket));
      for (const ref of this.#sources.values()) {
        if (!this.#store.read(this.#ticket, ref)) fail('BACKGROUND_SOURCE_INVALID');
      }
    } catch (error) { this.#invalidate(); throw error; }
    this.#advance(now);
    return now;
  }
  #refs(value: unknown, maximum = 8): SourceRef[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > maximum) fail('BACKGROUND_INVALID_INPUT');
    const seen = new Set<string>();
    const refs = value.map((ref: unknown) => {
      if (!object(ref) || !key(ref.id) || !Number.isSafeInteger(ref.revision)
        || (ref.revision as number) < 1 || seen.has(ref.id)) fail('BACKGROUND_INVALID_INPUT');
      seen.add(ref.id);
      return { id: ref.id, revision: ref.revision as number };
    });
    refs.sort((a, b) => a.id.localeCompare(b.id));
    return refs;
  }
  #checkRefs(refs: SourceRef[], outcome = false): SourceRef[] {
    try {
      for (const ref of refs) {
        const record = this.#store.read(this.#ticket, ref);
        if (!record) fail('BACKGROUND_SOURCE_INVALID');
        // MemoryStore.stage verifies every ancestor of self_report is the bound
        // subject's self-report. Observation alone can include assistant output.
        if (outcome && record.basis !== 'self_report') fail('BACKGROUND_OUTCOME_REQUIRES_SELF_REPORT');
      }
      const roots = new Map<string,SourceRef>();
      for (let i = 0; i < refs.length; i += 32) {
        for (const root of this.#store.publishedEventSources(this.#ticket, refs.slice(i,i+32))) roots.set(refKey(root),root);
      }
      return [...roots.values()];
    } catch (error) { this.#invalidate(); throw error; }
  }
  #reserve(id: string, refs: SourceRef[], roots: SourceRef[], payload: unknown, status: LedgerEntry['status']): boolean {
    if (!key(id)) fail('BACKGROUND_INVALID_INPUT');
    const hash = fingerprint(payload), previous = this.#ledger.get(id);
    if (previous) {
      if (previous.hash !== hash) fail('BACKGROUND_IDEMPOTENCY_CONFLICT');
      if (previous.status === 'pending') fail('BACKGROUND_APPRAISAL_PENDING');
      if (previous.status === 'failed') fail('BACKGROUND_APPRAISAL_TERMINAL');
      return false;
    }
    const newRefs = refs.filter(ref => !this.#sources.has(refKey(ref)));
    const newRoots = roots.filter(ref => !this.#rootIdentities.has(refKey(ref)));
    if (this.#ledger.size >= this.#maxEvents || this.#sources.size + newRefs.length > this.#maxSources
      || this.#rootIdentities.size + newRoots.length > this.#maxSources)
      fail('BACKGROUND_CAPACITY_REACHED');
    this.#ledger.set(id, { hash, status });
    for (const ref of newRefs) this.#sources.set(refKey(ref), Object.freeze({ ...ref }));
    for (const ref of newRoots) this.#rootIdentities.add(refKey(ref));
    return true;
  }
  #retarget(): void {
    if (this.#ablation === 'no-state') return;
    const x = this.#latent;
    this.#targets = {
      affiliation: clip(0.2 + 0.65 * Math.max(x.affiliativeTone, 0) + 0.1 * x.activation - 0.6 * x.uncertainty - 0.3 * x.fatigue),
      withdrawal: clip(0.1 + 0.6 * Math.max(-x.affiliativeTone, 0) + 0.6 * x.uncertainty + 0.5 * x.fatigue),
    };
    this.#targetValidUntil = this.#lastTime + BACKGROUND_DEFAULTS.targetValidityMs;
  }
  #nextWake(now: number): number | null {
    if (this.#paused || this.#context.quiet || !this.#context.available || this.#ablation === 'no-state') return null;
    const deadlines: number[] = [];
    for (const motive of ['affiliation', 'withdrawal'] as const) {
      if (!this.#armed[motive]) continue;
      const current = this.#latent[motive], target = this.#targets[motive];
      let crossing: number;
      if (current >= BACKGROUND_DEFAULTS.high - 1e-12) crossing = now;
      else if (target > BACKGROUND_DEFAULTS.high) {
        crossing = now + BACKGROUND_DEFAULTS.driveTauMs * Math.log((target - current) / (target - BACKGROUND_DEFAULTS.high));
      } else continue;
      // A drive that decays below threshold before cooldown ends must not cause a useless wake loop.
      if (this.#targetValidUntil !== null && crossing > this.#targetValidUntil) continue;
      const candidate = Math.max(crossing, this.#cooldownUntil);
      const active = this.#targetValidUntil === null ? candidate - now : Math.min(candidate, this.#targetValidUntil) - now;
      let atCandidate = target + (current - target) * Math.exp(-active / BACKGROUND_DEFAULTS.driveTauMs);
      if (candidate - now > active) atCandidate = neutralTargets()[motive]
        + (atCandidate - neutralTargets()[motive]) * Math.exp(-(candidate - now - active) / BACKGROUND_DEFAULTS.driveTauMs);
      if (Number.isFinite(candidate) && candidate <= Number.MAX_SAFE_INTEGER && atCandidate >= BACKGROUND_DEFAULTS.high - 1e-12)
        deadlines.push(candidate);
    }
    return deadlines.length ? Math.min(...deadlines) : null;
  }
  #view(now: number): BackgroundView {
    const x = this.#latent;
    return { kind: 'engineered-background-prior', bindingId: this.#bindingId, generation: this.#generation,
      atMonotonicMs: now, paused: this.#paused, ablation: this.#ablation,
      latent: { ...x }, targets: { ...this.#targets }, targetValidUntil: this.#targetValidUntil, context: { ...this.#context },
      sourceRefs: [...this.#sources.values()].map(ref => ({ ...ref })),
      attentionPrior: { social: clip(0.2 + 0.5 * Math.max(x.affiliativeTone, 0) + 0.3 * x.affiliation - 0.3 * x.withdrawal),
        novelty: clip(0.2 + 0.5 * x.activation + 0.3 * x.uncertainty), disengagement: clip(0.6 * x.withdrawal + 0.4 * x.fatigue) },
      ledgerSize: this.#ledger.size, nextWakeAt: this.#nextWake(now) };
  }
  #receipt(status: BackgroundReceipt['status']): BackgroundReceipt {
    return { status, view: this.#view(this.#guard()) };
  }

  read(): BackgroundView { return this.#view(this.#guard()); }
  setContext(context: BackgroundContext): BackgroundView {
    this.#guard();
    if (!object(context) || typeof context.quiet !== 'boolean' || typeof context.available !== 'boolean') fail('BACKGROUND_INVALID_INPUT');
    if (context.quiet !== this.#context.quiet || context.available !== this.#context.available) {
      this.#context = { quiet: context.quiet, available: context.available };
      this.#contextRevision++;
      this.#cancelPending();
    }
    return this.read();
  }
  observe(input: Observation): BackgroundReceipt {
    this.#guard();
    if (this.#paused) fail('BACKGROUND_PAUSED');
    if (!object(input) || !key(input.id) || ![input.novelty, input.socialRelevance, input.demand].every(v => finite(v, 0, 1)))
      fail('BACKGROUND_INVALID_INPUT');
    const refs = this.#refs(input.refs);
    const roots = this.#checkRefs(refs);
    if (!this.#ledger.has(input.id) && roots.some(ref => this.#observedSources.has(refKey(ref)))) fail('BACKGROUND_OBSERVATION_SOURCE_REPLAY');
    if (!this.#reserve(input.id, refs, roots, ['observation', refs, input.novelty, input.socialRelevance, input.demand], 'applied')) return this.#receipt('duplicate');
    for (const ref of roots) this.#observedSources.add(refKey(ref));
    if (this.#ablation === 'none') {
      this.#latent.activation = clip(this.#latent.activation + 0.2 * input.novelty);
      this.#latent.uncertainty = clip(this.#latent.uncertainty + 0.15 * input.novelty);
      this.#latent.fatigue = clip(this.#latent.fatigue + 0.15 * input.demand);
      this.#latent.affiliation = clip(this.#latent.affiliation + 0.1 * input.socialRelevance);
    }
    this.#revision++;
    this.#cancelPending();
    this.#retarget();
    return this.#receipt('applied');
  }
  recordOutcome(input: InteractionOutcome): BackgroundReceipt {
    this.#guard();
    if (this.#paused) fail('BACKGROUND_PAUSED');
    if (!object(input) || !key(input.id) || input.origin !== 'external-observation'
      || !['engaged', 'declined', 'tiring', 'neutral'].includes(input.outcome)) fail('BACKGROUND_INVALID_INPUT');
    const refs = this.#refs([input.ref]);
    const roots = this.#checkRefs(refs, true);
    // A different event ID cannot reward the same published interaction source twice.
    const existing = this.#ledger.has(input.id);
    if (!existing && roots.some(ref => this.#outcomeSources.has(refKey(ref)))) fail('BACKGROUND_OUTCOME_SOURCE_REPLAY');
    if (!this.#reserve(input.id, refs, roots, ['outcome', refs, input.origin, input.outcome], 'applied')) return this.#receipt('duplicate');
    for (const ref of roots) this.#outcomeSources.add(refKey(ref));
    if (this.#ablation === 'none') {
      const x = this.#latent;
      if (input.outcome === 'engaged') {
        x.affiliativeTone = clip(x.affiliativeTone + 0.3, -1, 1);
        x.uncertainty = clip(x.uncertainty - 0.1); x.affiliation = clip(x.affiliation - 0.25);
      } else if (input.outcome === 'declined') {
        x.affiliativeTone = clip(x.affiliativeTone - 0.3, -1, 1);
        x.uncertainty = clip(x.uncertainty + 0.2); x.affiliation = clip(x.affiliation - 0.25);
      } else if (input.outcome === 'tiring') x.fatigue = clip(x.fatigue + 0.3);
    }
    this.#revision++;
    this.#cancelPending();
    this.#retarget();
    return this.#receipt('applied');
  }

  async appraise(input: AppraisalRequest, evaluate: AppraisalEvaluator): Promise<BackgroundReceipt> {
    const startedAt = this.#guard();
    if (this.#paused || this.#context.quiet || !this.#context.available) fail('BACKGROUND_APPRAISAL_CONTEXT_BLOCKED');
    if (!object(input) || !key(input.id) || typeof evaluate !== 'function') fail('BACKGROUND_INVALID_INPUT');
    const refs = this.#refs(input.refs);
    const roots = this.#checkRefs(refs);
    // Conditioning memories are dependencies, not new stimuli/rewards. They
    // remain revocable without consuming their roots again on every new turn.
    const conditioning = input.conditioningRefs === undefined || (Array.isArray(input.conditioningRefs) && input.conditioningRefs.length === 0)
      ? [] : this.#refs(input.conditioningRefs,this.#maxSources);
    const allRefs = this.#refs([...new Map([...refs, ...conditioning].map(ref => [ref.id, ref])).values()],this.#maxSources);
    for (const ref of refs) if (conditioning.some(other => other.id === ref.id && other.revision !== ref.revision)) fail('BACKGROUND_INVALID_INPUT');
    const allRoots = this.#checkRefs(allRefs);
    const id = input.id;
    if (this.#pending.size > 0 && !this.#ledger.has(id)) fail('BACKGROUND_APPRAISAL_BUSY');
    if (!this.#ledger.has(id) && roots.some(ref => this.#appraisedSources.has(refKey(ref)))) fail('BACKGROUND_APPRAISAL_SOURCE_REPLAY');
    if (!this.#reserve(id, allRefs, allRoots, ['appraisal', refs, conditioning], 'pending')) return this.#receipt('duplicate');
    for (const ref of roots) this.#appraisedSources.add(refKey(ref));
    const deadline = startedAt + BACKGROUND_DEFAULTS.appraisalMaxAgeMs;
    const generation = this.#generation, revision = this.#revision, contextRevision = this.#contextRevision;
    const controller = new AbortController();
    this.#pending.set(id, controller);
    try {
      const before = this.read();
      let onAbort: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new CoreError('BACKGROUND_APPRAISAL_STALE'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const raw = Promise.resolve().then(() => {
        const atInvocation = this.#guard();
        if (atInvocation >= deadline) fail('BACKGROUND_APPRAISAL_EXPIRED');
        if (controller.signal.aborted || generation !== this.#generation || revision !== this.#revision) fail('BACKGROUND_APPRAISAL_STALE');
        return evaluate(Object.freeze({ kind: 'background-hypothesis-request' as const,
          snapshot: structuredClone(before), refs: Object.freeze(allRefs.map(ref => Object.freeze({ ...ref }))),
          deadlineAtMonotonicMs: deadline, signal: controller.signal }));
      });
      const release = () => {
        controller.signal.removeEventListener('abort', onAbort);
        if (this.#pending.get(id) === controller) this.#pending.delete(id);
      };
      void raw.then(release, release);
      const hypothesis = await Promise.race([raw, aborted]);
      const completedAt = this.#guard();
      if (completedAt >= deadline) fail('BACKGROUND_APPRAISAL_EXPIRED');
      if (controller.signal.aborted || generation !== this.#generation || revision !== this.#revision || contextRevision !== this.#contextRevision)
        fail('BACKGROUND_APPRAISAL_STALE');
      this.#checkRefs(allRefs);
      if (!object(hypothesis) || hypothesis.kind !== 'appraisal-hypothesis' || !finite(hypothesis.confidence, 0, 1)
        || ![hypothesis.valence, hypothesis.arousal, hypothesis.uncertainty, hypothesis.fatigue].every(v => finite(v, -1, 1)))
        fail('BACKGROUND_INVALID_HYPOTHESIS');
      if (this.#ablation === 'none') {
        const c = hypothesis.confidence, x = this.#latent;
        x.affiliativeTone = clip(x.affiliativeTone + 0.6 * c * hypothesis.valence, -1, 1);
        x.activation = clip(x.activation + 0.25 * c * hypothesis.arousal);
        x.uncertainty = clip(x.uncertainty + 0.25 * c * hypothesis.uncertainty);
        x.fatigue = clip(x.fatigue + 0.25 * c * hypothesis.fatigue);
      }
      this.#revision++;
      this.#retarget();
      this.#ledger.get(id)!.status = 'applied';
      return this.#receipt('applied');
    } catch (error) {
      const entry = this.#ledger.get(id);
      if (entry) entry.status = 'failed';
      throw error;
    }
  }

  consider(): ShadowDecision {
    const now = this.#guard();
    if (this.#paused) return { intent: null, nextWakeAt: null, reason: 'paused' };
    if (this.#context.quiet) return { intent: null, nextWakeAt: null, reason: 'quiet' };
    if (!this.#context.available) return { intent: null, nextWakeAt: null, reason: 'unavailable' };
    if (this.#ablation === 'no-state') return { intent: null, nextWakeAt: null, reason: 'below-threshold-or-latched' };
    if (now < this.#cooldownUntil) return { intent: null, nextWakeAt: this.#nextWake(now), reason: 'cooldown' };
    const candidates = (['withdrawal', 'affiliation'] as const).filter(m => this.#armed[m] && this.#latent[m] >= BACKGROUND_DEFAULTS.high - 1e-12);
    candidates.sort((a, b) => this.#latent[b] - this.#latent[a]);
    const motive = candidates[0];
    if (!motive) return { intent: null, nextWakeAt: this.#nextWake(now), reason: 'below-threshold-or-latched' };
    this.#armed[motive] = false;
    this.#cooldownUntil = now + BACKGROUND_DEFAULTS.cooldownMs;
    const intent: ShadowIntent = Object.freeze({ kind: 'shadow-intent', id: randomUUID(), bindingId: this.#bindingId,
      motive, suggestedWork: motive === 'affiliation' ? 'consider-appraisal' : 'reduce-engagement',
      createdAtMonotonicMs: now, expiresAtMonotonicMs: now + BACKGROUND_DEFAULTS.intentTtlMs, delivery: 'shadow-only' });
    this.#intents.set(intent, { generation: this.#generation, revision: this.#revision, contextRevision: this.#contextRevision });
    this.validateIntent(intent);
    return { intent, nextWakeAt: this.#nextWake(this.#lastTime), reason: 'shadow-intent' };
  }
  validateIntent(intent: ShadowIntent): void {
    const now = this.#guard(), seal = this.#intents.get(intent);
    if (!seal || intent.bindingId !== this.#bindingId || seal.generation !== this.#generation
      || seal.revision !== this.#revision || seal.contextRevision !== this.#contextRevision
      || now >= intent.expiresAtMonotonicMs || this.#paused || this.#context.quiet || !this.#context.available)
      fail('BACKGROUND_INTENT_STALE');
  }
  pause(): BackgroundView {
    this.#guard();
    if (!this.#paused) { this.#paused = true; this.#generation++; this.#cancelPending(); }
    return this.read();
  }
  resume(): BackgroundView {
    this.#guard();
    if (this.#paused) { this.#paused = false; this.#generation++; }
    // No intent is issued and no missed tick is replayed here.
    return this.read();
  }
  reset(): BackgroundView {
    this.#guard();
    this.#generation++;
    this.#cancelPending();
    this.#clearInfluence();
    // Keep consumed keys and outcome-source identities for this binding, including across resets.
    return this.read();
  }
  snapshot(): { kind: 'diagnostic-only-not-a-checkpoint'; restorable: false; view: BackgroundView } {
    return { kind: 'diagnostic-only-not-a-checkpoint', restorable: false, view: this.read() };
  }
  restore(_serializedOrSnapshot: unknown): never {
    this.#guard();
    return fail('BACKGROUND_RESTORE_UNSUPPORTED');
  }
}
