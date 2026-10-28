import { randomUUID } from 'node:crypto';
import { isPromise } from 'node:util/types';
import { fail } from './validation.ts';

/** E1a is a trusted, process-local scheduling port, not an evidence/model/action API. */
export type EndogenousRequest = Readonly<{
  ownerEpoch: string; decisionId: string; sequence: number; session: number;
  trigger: 'boot' | 'resume' | 'wake'; signal: AbortSignal;
}>;
/** A stable ordinary native Promise containing JSON; no thenables/subclasses/species hooks. */
export type EndogenousDecisionPort = (request: EndogenousRequest) => Promise<string>;
export type EndogenousChoice = { version: 1; choice: 'REST' | 'NOOP'; nextWakeInMs?: number };
export type EndogenousState = 'created' | 'deciding' | 'waiting' | 'resting' | 'paused' | 'closed' | 'exhausted' | 'faulted';
type Code = 'JOURNAL' | 'PAUSED' | 'CLOSED' | 'TIMEOUT' | 'DURATION' | 'CAPACITY' | 'CLOCK' | 'PORT_THROW'
  | 'PORT_REJECT' | 'UNSUPPORTED_PROMISE' | 'INVALID_DECISION';
export type EndogenousEntry = Readonly<{
  decisionId: string; session: number; sequence: number;
  outcome: 'PENDING' | 'UNKNOWN' | 'REST' | 'NOOP'; code: Code | null;
}>;
export type EndogenousLimits = Readonly<{ maxCalls: number; maxDurationMs: number; callTimeoutMs: number; maxResultBytes: number }>;
export type EndogenousSnapshot = Readonly<{
  ownerEpoch: string; session: number | null; state: EndogenousState; code: Code | null;
  actualPending: boolean; timerPending: boolean; callsConsumed: number; resultBytesReserved: number;
  limits: EndogenousLimits; entries: readonly EndogenousEntry[];
}>;
export interface EndogenousSession {
  start(): void;
  resume(): void;
  pause(): void;
  close(): void;
  read(): EndogenousSnapshot;
}
/** Trusted synchronous checkpoint hooks. No hook may return before its commit finishes. */
export interface EndogenousJournal {
  withReservedDispatch(entry: EndogenousEntry, invoke: () => void): 'DISPATCHED' | 'STOPPED_UNRESERVED' | 'STOPPED_RESERVED';
  terminal(entry: EndogenousEntry): void;
  stop(entries: readonly EndogenousEntry[], state: EndogenousState): void;
  observeActualSettled(entry: EndogenousEntry): void;
}

const RESULT_BYTES = 256;
const MIN_WAKE_MS = 10;
const MAX_TIME_MS = 300_000;
const nativeThen = Promise.prototype.then;
type Entry = { -readonly [K in keyof EndogenousEntry]: EndogenousEntry[K] };
type Binding = { id: number; state: EndogenousState; code: Code | null; port: EndogenousDecisionPort; fence: object };
type Raw = { binding: Binding; fence: object; entry: Entry; controller: AbortController; deadline: number };

function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function decision(input: unknown): EndogenousChoice {
  // Check code units before UTF-8 length or parsing; no property access on port objects.
  if (typeof input !== 'string' || input.length > RESULT_BYTES || Buffer.byteLength(input, 'utf8') > RESULT_BYTES)
    fail('E1_INVALID_DECISION');
  let value: unknown;
  try { value = JSON.parse(input); } catch { fail('E1_INVALID_DECISION'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('E1_INVALID_DECISION');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['version', 'choice', 'nextWakeInMs'].includes(key)) || v.version !== 1
    || (v.choice !== 'REST' && v.choice !== 'NOOP')) fail('E1_INVALID_DECISION');
  if (Object.hasOwn(v, 'nextWakeInMs')) {
    if (typeof v.nextWakeInMs !== 'number' || !integer(v.nextWakeInMs, MIN_WAKE_MS, MAX_TIME_MS)) fail('E1_INVALID_DECISION');
    return { version: 1, choice: v.choice, nextWakeInMs: v.nextWakeInMs };
  }
  return { version: 1, choice: v.choice };
}

/** One host-owned lane for its complete lifetime. Close/rebind never reset budget or raw work.
 * Use a single owner per controlled lane; constructing another owner is a new host authority,
 * not a session reset. No global registry, persistence, communication, or evidence is provided.
 */
export class EndogenousOwner {
  readonly #epoch: string;
  readonly #limits: EndogenousLimits;
  readonly #clock: () => number;
  #last: number | null = null;
  #expires: number | null = null;
  #binding: Binding | null = null;
  #bindings = 0;
  #entries: Entry[] = [];
  #raw: Raw | null = null;
  #timer: { handle: ReturnType<typeof setTimeout>; token: object } | null = null;
  #busy = false;
  #closed = false;
  #faulted = false;
  readonly #journal: EndogenousJournal | undefined;
  readonly #restored: boolean;

  constructor(options: { limits?: Partial<EndogenousLimits>; clock?: () => number; journal?: EndogenousJournal;
    recovered?: { controlId: string; entries: readonly EndogenousEntry[]; session: number; remainingMs: number } } = {}) {
    const limits = { maxCalls: 16, maxDurationMs: 60_000, callTimeoutMs: 5_000, maxResultBytes: 4_096, ...options.limits };
    if (!integer(limits.maxCalls, 1, 64) || !integer(limits.maxDurationMs, 10, MAX_TIME_MS)
      || !integer(limits.callTimeoutMs, 1, 30_000) || limits.callTimeoutMs > limits.maxDurationMs
      || !integer(limits.maxResultBytes, RESULT_BYTES, 16_384)) fail('E1_INVALID_LIMITS');
    this.#limits = Object.freeze(limits);
    this.#clock = options.clock ?? (() => performance.now());
    this.#journal = options.journal;
    this.#epoch = options.recovered?.controlId ?? randomUUID();
    this.#restored = options.recovered !== undefined;
    if (options.recovered) {
      this.#entries = options.recovered.entries.map(entry => ({ ...entry }));
      this.#bindings = options.recovered.session - 1;
      this.#expires = this.#clock() + options.recovered.remainingMs;
    }
  }

  bind(port: EndogenousDecisionPort): EndogenousSession {
    return this.#exclusive(() => {
      if (this.#closed || this.#faulted) fail('E1_OWNER_CLOSED');
      if (this.#binding && this.#binding.state !== 'closed') fail('E1_SESSION_ACTIVE');
      if (typeof port !== 'function') fail('E1_INVALID_PORT');
      if (this.#bindings >= 1_024) fail('E1_BINDING_CAPACITY');
      const binding: Binding = { id: ++this.#bindings, state: this.#restored ? 'paused' : 'created', code: null, port, fence: {} };
      this.#binding = binding;
      return Object.freeze({
        start: () => this.#exclusive(() => this.#activate(binding, 'boot')),
        resume: () => this.#exclusive(() => this.#activate(binding, 'resume')),
        pause: () => this.#exclusive(() => { this.#current(binding); this.#stop(binding, 'paused', 'PAUSED'); }),
        close: () => this.#exclusive(() => { this.#current(binding); this.#stop(binding, 'closed', 'CLOSED'); }),
        read: () => { this.#current(binding); return this.read(); },
      });
    });
  }

  close(): void {
    this.#exclusive(() => {
      this.#closed = true;
      if (this.#binding) this.#stop(this.#binding, 'closed', 'CLOSED');
      else this.#clearTimer();
    });
  }

  /** Trusted authority revocation: local cancellation must not wait for persistence. */
  invalidate(): void {
    this.#exclusive(() => this.#journalFailed());
  }
  #journalFailed(): void {
    this.#faulted = true;
    if (this.#binding) this.#stop(this.#binding, 'faulted', 'JOURNAL', false);
    else this.#clearTimer();
  }

  /** Detached metadata only. Reads do not advance time, schedule work or expose port content. */
  read(): EndogenousSnapshot {
    return { ownerEpoch: this.#epoch, session: this.#binding?.id ?? null,
      state: this.#binding?.state ?? (this.#closed ? 'closed' : 'created'), code: this.#binding?.code ?? null,
      actualPending: this.#raw !== null, timerPending: this.#timer !== null,
      callsConsumed: this.#entries.length, resultBytesReserved: this.#entries.length * RESULT_BYTES,
      limits: { ...this.#limits }, entries: this.#entries.map(entry => ({ ...entry })) };
  }

  #exclusive<T>(operation: () => T): T {
    if (this.#busy) fail('E1_REENTRANT');
    this.#busy = true;
    try { return operation(); } finally { this.#busy = false; }
  }
  #current(binding: Binding): void {
    if (this.#binding !== binding) fail('E1_STALE_SESSION');
  }
  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer.handle);
    this.#timer = null;
  }
  #unknown(raw: Raw, code: Code): void {
    if (raw.entry.outcome === 'PENDING') { raw.entry.outcome = 'UNKNOWN'; raw.entry.code = code; }
  }
  #stop(binding: Binding, state: EndogenousState, code: Code, persist = true): void {
    this.#clearTimer();
    binding.fence = {};
    // Closed/faulted/exhausted sessions cannot be revived by pause.
    if (!['closed', 'faulted', 'exhausted'].includes(binding.state)) { binding.state = state; binding.code = code; }
    else if (state === 'closed') { binding.state = 'closed'; binding.code = code; }
    if (this.#raw?.binding === binding) {
      this.#unknown(this.#raw, code);
      this.#raw.controller.abort();
    }
    if (persist && this.#journal) {
      try { this.#journal.stop(this.#entries, binding.state); }
      catch { this.#journalFailed(); }
    }
  }
  #now(binding: Binding): number | null {
    let now: number;
    try { now = this.#clock(); } catch { now = NaN; }
    if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - MAX_TIME_MS
      || (this.#last !== null && now < this.#last)) {
      this.#faulted = true; this.#stop(binding, 'faulted', 'CLOCK'); return null;
    }
    this.#last = now;
    if (this.#expires !== null && now >= this.#expires) { this.#stop(binding, 'exhausted', 'DURATION'); return null; }
    return now;
  }
  #capacity(): boolean {
    return this.#entries.length < this.#limits.maxCalls && (this.#entries.length + 1) * RESULT_BYTES <= this.#limits.maxResultBytes;
  }
  #activate(binding: Binding, trigger: 'boot' | 'resume'): void {
    this.#current(binding);
    if (this.#closed || this.#faulted) fail('E1_OWNER_CLOSED');
    if (binding.state !== (trigger === 'boot' ? 'created' : 'paused')) fail('E1_STATE');
    // No waiter or auto-resume: the host must explicitly try again after actual settlement.
    if (this.#raw) fail('E1_RAW_BUSY');
    const now = this.#now(binding);
    if (now === null) return;
    if (this.#expires === null) this.#expires = now + this.#limits.maxDurationMs;
    this.#dispatch(binding, trigger, now);
  }
  #dispatch(binding: Binding, trigger: EndogenousRequest['trigger'], now: number): void {
    if (this.#raw) fail('E1_RAW_BUSY');
    if (!this.#capacity()) { this.#stop(binding, 'exhausted', 'CAPACITY'); return; }
    const sequence = this.#entries.length + 1;
    const entry: Entry = { decisionId: `${this.#epoch}:${sequence}`, session: binding.id, sequence, outcome: 'PENDING', code: null };
    this.#entries.push(entry); // Reserve call, retained entry and full response allowance before any callback.
    const raw: Raw = { binding, fence: binding.fence, entry, controller: new AbortController(),
      deadline: Math.min(now + this.#limits.callTimeoutMs, this.#expires!) };
    this.#raw = raw;
    binding.state = 'deciding'; binding.code = null;
    this.#arm(binding, raw.deadline, 'deadline', now);
    let promise!: Promise<string>, portThrew = false;
    try {
      const invoke = () => {
        try { promise = binding.port(Object.freeze({ ownerEpoch: this.#epoch, decisionId: entry.decisionId,
          sequence, session: binding.id, trigger, signal: raw.controller.signal })); }
        catch { portThrew = true; }
      };
      if (this.#journal) {
        const dispatched = this.#journal.withReservedDispatch(entry, invoke);
        if (dispatched !== 'DISPATCHED') {
          // Only an explicit, durably stopped pre-reservation refusal can discard the RAM
          // preview. This is not a refund; uncertain writes retain their conservative slot.
          if (dispatched === 'STOPPED_UNRESERVED') { this.#entries.pop(); this.#raw = null; }
          this.#journalFailed(); return;
        }
      } else invoke();
    } catch {
      this.#journalFailed();
      // A failure after invoke must still observe supported late rejections; the owner is fenced.
      try {
        if (isPromise(promise) && Object.getPrototypeOf(promise) === Promise.prototype
          && !Object.hasOwn(promise, 'constructor') && !Object.hasOwn(promise, 'then'))
          void nativeThen.call(promise, () => this.#settled(raw, false, undefined), () => this.#settled(raw, false, undefined));
      } catch { /* Unsupported port objects retain their permit. */ }
      return;
    }
    if (portThrew) {
      // A durable port may have started external work before throwing. Without a native
      // Promise there is no actual-settlement witness, so retain the durable permit.
      if (this.#journal) { this.#unknown(raw, 'PORT_THROW'); this.#stop(binding, 'paused', 'PORT_THROW'); return; }
      this.#raw = null; this.#unknown(raw, 'PORT_THROW'); this.#stop(binding, 'paused', 'PORT_THROW'); return;
    }
    try {
      // Never assimilate a thenable or invoke an instance .then. Unsupported promises poison
      // the owner with its raw slot held: their actual settlement cannot safely be certified.
      if (!isPromise(promise) || Object.getPrototypeOf(promise) !== Promise.prototype
        || Object.hasOwn(promise, 'constructor') || Object.hasOwn(promise, 'then')) fail('E1_UNSUPPORTED_PROMISE');
      void nativeThen.call(promise,
        value => this.#settled(raw, true, value),
        () => this.#settled(raw, false, undefined));
    } catch {
      this.#faulted = true; this.#unknown(raw, 'UNSUPPORTED_PROMISE'); this.#stop(binding, 'faulted', 'UNSUPPORTED_PROMISE');
    }
  }
  #settled(raw: Raw, ok: boolean, value: unknown): void {
    this.#exclusive(() => {
      if (this.#raw !== raw) return;
      try { this.#journal?.observeActualSettled(raw.entry); } catch { this.#journalFailed(); return; }
      const binding = raw.binding;
      if (raw.entry.outcome !== 'PENDING' || this.#binding !== binding || binding.fence !== raw.fence
        || binding.state !== 'deciding' || this.#closed || this.#faulted) { this.#raw = null; return; }
      this.#clearTimer();
      const now = this.#now(binding);
      // Keep the raw entry reachable through #now so its stop checkpoint includes UNKNOWN.
      this.#raw = null; // Only an actual native settlement releases this slot.
      if (now === null) { this.#unknown(raw, binding.code ?? 'CLOCK'); return; }
      if (now >= raw.deadline) { this.#unknown(raw, 'TIMEOUT'); this.#stop(binding, 'paused', 'TIMEOUT'); return; }
      if (!ok) { this.#unknown(raw, 'PORT_REJECT'); this.#stop(binding, 'paused', 'PORT_REJECT'); return; }
      let choice: EndogenousChoice;
      try { choice = decision(value); }
      catch { this.#unknown(raw, 'INVALID_DECISION'); this.#stop(binding, 'paused', 'INVALID_DECISION'); return; }
      try { this.#journal?.terminal({ ...raw.entry, outcome: choice.choice }); }
      catch { this.#unknown(raw, 'JOURNAL'); this.#journalFailed(); return; }
      raw.entry.outcome = choice.choice;
      if (!this.#capacity()) { this.#stop(binding, 'exhausted', 'CAPACITY'); return; }
      binding.state = choice.nextWakeInMs === undefined ? 'resting' : 'waiting';
      const next = choice.nextWakeInMs === undefined ? this.#expires! : Math.min(now + choice.nextWakeInMs, this.#expires!);
      this.#arm(binding, next, choice.nextWakeInMs === undefined ? 'expiry' : 'wake', now);
    });
  }
  #arm(binding: Binding, due: number, kind: 'deadline' | 'wake' | 'expiry', now: number): void {
    this.#clearTimer();
    const token = {}, fence = binding.fence;
    // Native timers remain referenced. The host owns this lifetime and must pause/close it.
    const handle = setTimeout(() => this.#exclusive(() => {
      if (this.#timer?.token !== token || this.#binding !== binding || binding.fence !== fence) return;
      this.#timer = null;
      const current = this.#now(binding);
      if (current === null) return;
      // Early callbacks do not poll/rearm; fail closed (including frozen injected clocks).
      if (current < due) { this.#faulted = true; this.#stop(binding, 'faulted', 'CLOCK'); return; }
      if (kind === 'deadline') this.#stop(binding, 'paused', 'TIMEOUT');
      else if (kind === 'wake') this.#dispatch(binding, 'wake', current);
      else this.#stop(binding, 'exhausted', 'DURATION');
    }), Math.max(1, Math.ceil(due - now)));
    this.#timer = { handle, token };
  }
}
