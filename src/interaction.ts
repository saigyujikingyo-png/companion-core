import type { MemoryRecord, Proposal, SourceRef } from './contracts.ts';
import type { AppraisalHypothesis, BackgroundView, Motive } from './background-state.ts';
import { abortError } from './runtime.ts';
import { CoreError, fail, proposal, text } from './validation.ts';
import { fields, parseJson } from './wire.ts';

export type Prior = { social: number; novelty: number; disengagement: number };
export type RecallAudit = { ref: SourceRef; statement: string; basis: MemoryRecord['basis'];
  beforeRank: number; afterRank: number; beforeScore: number; afterScore: number; features: Prior };
export type InteractionRequest = {
  sessionId: string; requestId: string; kind: 'user' | 'proactive'; selectedText: string | null;
  recalled: RecallAudit[]; engineeredPrior: { background: BackgroundView | null; neural: Prior | null; backend: BackendMode };
  motive: Motive | null; signal: AbortSignal;
  /** Trusted local fence, never serialized into the provider payload. */
  validateBeforeSend?: () => void;
};
export type InteractionResponse = { version: 1; responseText: string; appraisal: AppraisalHypothesis; memoryProposal: Proposal | null };
export interface InteractionProvider { interact(input: InteractionRequest): Promise<InteractionResponse> }
export type BackendMode = 'baseline' | 'no-state' | 'flywire';
/** A bounded experimental codec. Its outputs can only reorder already-authorized candidates. */
export interface PriorAdapter {
  manifest: { implementation: string; sourceHash: string; biologicalClaim: 'none' };
  step(input: { dtMs: number; features: Prior; signal: AbortSignal }): Promise<Prior>;
  reset(): Promise<void>;
}
export function validatePrior(value: Prior): Prior {
  if (!value || ![value.social, value.novelty, value.disengagement].every(x => Number.isFinite(x) && x >= 0 && x <= 1))
    fail('INVALID_NEURAL_PRIOR');
  return { social:value.social, novelty:value.novelty, disengagement:value.disengagement };
}
export function interactionResponse(input: unknown): InteractionResponse {
  const value = fields(typeof input === 'string' ? parseJson(input, 65_536) : input,
    ['version','responseText','appraisal','memoryProposal']);
  if (value.version !== 1) fail('UNSUPPORTED_PROTOCOL');
  text(value.responseText, 4096);
  const a = fields(value.appraisal, ['kind','confidence','valence','arousal','uncertainty','fatigue']);
  if (a.kind !== 'appraisal-hypothesis' || typeof a.confidence !== 'number' || !Number.isFinite(a.confidence)
    || a.confidence < 0 || a.confidence > 1 || ![a.valence,a.arousal,a.uncertainty,a.fatigue]
      .every(x => typeof x === 'number' && Number.isFinite(x) && x >= -1 && x <= 1)) fail('INVALID_APPRAISAL');
  const p = value.memoryProposal === null ? null : proposal(fields(value.memoryProposal,
    ['kind','statement','basis','validFrom','validTo']) as Proposal);
  if (p && (!['claim','episode'].includes(p.kind) || p.basis !== 'self_report' || p.validFrom !== null || p.validTo !== null))
    fail('INVALID_MEMORY_CANDIDATE');
  return { version:1, responseText:value.responseText,
    appraisal:{ kind:'appraisal-hypothesis', confidence:a.confidence, valence:a.valence as number,
      arousal:a.arousal as number, uncertainty:a.uncertainty as number, fatigue:a.fatigue as number }, memoryProposal:p };
}

/** Caller cancellation is prompt; the sole raw permit survives until actual settlement. */
export class RawOperationPermit {
  #active = false;
  get active(): boolean { return this.#active; }
  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.#active) return Promise.reject(new CoreError('INTERACTION_BACKPRESSURE'));
    this.#active = true;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (ok: boolean, value: unknown) => {
        if (done) return;
        done = true; signal.removeEventListener('abort', cancel);
        if (ok) resolve(value as T); else reject(value);
      };
      const cancel = () => finish(false, abortError());
      signal.addEventListener('abort', cancel, { once:true });
      let raw: Promise<T>;
      try { raw = Promise.resolve(operation()); } catch (error) { raw = Promise.reject(error); }
      void raw.then(value => { this.#active = false; finish(true, value); }, error => { this.#active = false; finish(false, error); });
    });
  }
}

/** Process-lifetime budget, reserved immediately before fetch. No retries or refunds. */
export class RequestBudget {
  #clock: () => number; #last = 0; #total = 0; #sent: number[] = [];
  readonly #limits: { total: number; hourly: number; daily: number };
  readonly #durable: { initialTotal: number; reserve(requestId?: string): void } | undefined;
  constructor(limits: { total: number; hourly: number; daily: number }, clock = () => performance.now(),
    durable?: { initialTotal: number; reserve(requestId?: string): void }) {
    if (![limits.total,limits.hourly,limits.daily].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000)) fail('INVALID_REQUEST_BUDGET');
    this.#limits = { ...limits }; this.#clock = clock;
    this.#last = this.#now();
    this.#durable = durable;
    if (durable) {
      if (!Number.isSafeInteger(durable.initialTotal) || durable.initialTotal < 0 || durable.initialTotal > limits.total) fail('INVALID_REQUEST_BUDGET');
      this.#total = durable.initialTotal;
      // Old monotonic timestamps are meaningless after a process restart. All
      // historic spend is conservatively charged again to the current windows.
      this.#sent = Array(this.#total).fill(this.#last) as number[];
    }
  }
  #now(): number { const now = this.#clock(); if (!Number.isFinite(now) || now < this.#last) fail('BUDGET_CLOCK_INVALID'); this.#last = now; return now; }
  reserve(requestId?: string): void {
    const now = this.#now();
    this.#sent = this.#sent.filter(at => now-at < 86_400_000);
    if (this.#total >= this.#limits.total || this.#sent.filter(at => now-at < 3_600_000).length >= this.#limits.hourly
      || this.#sent.length >= this.#limits.daily) fail('REQUEST_BUDGET_EXHAUSTED');
    this.#durable?.reserve(requestId); this.#total++; this.#sent.push(now);
  }
  get usage() { return { total:this.#total, hour:this.#sent.filter(at => this.#last-at < 3_600_000).length,
    day:this.#sent.length, limits:{ ...this.#limits } }; }
}
/** Host creates one for its lifetime; sessions/rebinds/backend switches reuse it. */
export class InteractionResources {
  lastRequestAudit: { requestId:string;payloadSha256:string;recalled:Array<Pick<RecallAudit,'ref'|'beforeScore'|'afterScore'|'beforeRank'|'afterRank'>>;
    attentionPrior:Prior|null;conditioningSourceRefs:SourceRef[] } | null = null;
  readonly calls = new RawOperationPermit();
  readonly transport = new RawOperationPermit();
  readonly neural = new RawOperationPermit();
  readonly budget: RequestBudget;
  constructor(budget: RequestBudget) { this.budget = budget; }
}
