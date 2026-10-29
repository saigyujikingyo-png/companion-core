import { randomUUID } from 'node:crypto';
import type { MediaAdapter } from './contracts.ts';
import {
  SPEECH_LIMITS,
  SpeechError,
  canonicalSpeech,
  prepareSpeechPlan,
  speechEffectKey,
  speechFail,
  speechHash,
  speechInteger,
  speechObject,
  speechResourceKey,
  speechString,
  validateOutputLease,
} from './speech-contract.ts';
import type {
  BackendSettlement,
  CurrentSpeechGate,
  DetailedSpeechStop,
  ExecutionToken,
  ForwardingOutcome,
  OutputLease,
  SpeechAuthority,
  SpeechBackendOperation,
  SpeechBackendPort,
  SpeechOperation,
  SpeechOutcome,
  SpeechPlan,
  SpeechSnapshot,
  TechnicalReceiptSink,
  TechnicalSpeechReceipt,
} from './speech-contract.ts';

type RecordState = {
  plan: SpeechPlan;
  text: string;
  key: string;
  fingerprint: string;
  generation: number;
  phase: SpeechSnapshot['phase'];
  outcome: SpeechOutcome | null;
  code: string;
  forwarding: ForwardingOutcome;
  receipts: TechnicalSpeechReceipt[];
  rejected: number;
  firstRejected: string | null;
  lease: OutputLease | null;
  token: ExecutionToken | null;
  backend: SpeechBackendOperation | null;
  dispatched: boolean;
  fenced: boolean;
  engineCompleted: boolean;
  engineStopped: boolean;
  sequence: number;
  stream: number | null;
  settlement: BackendSettlement | null;
  resolve: (value: SpeechSnapshot) => void;
  operation: SpeechOperation;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  drained: Promise<void>;
  resolveDrained: () => void;
  stopTimer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
  released: boolean;
  running: boolean;
};
export type SpeechControllerOptions = Readonly<{
  backend: SpeechBackendPort;
  gate: CurrentSpeechGate;
  authority: SpeechAuthority;
  sink: TechnicalReceiptSink;
  controllerBindingId: string;
  ownerInstanceId?: string;
  now?: () => number;
  /** Default business requires a real, injected durable authority. No such implementation ships here. */
  mode?: 'business' | 'synthetic-test' | 'synthetic-native-verification';
}>;

export class SpeechController {
  readonly #options: SpeechControllerOptions;
  readonly #owner: string;
  readonly #records = new Map<string, RecordState>();
  #binding: string;
  #generation = 1;
  #active: RecordState | null = null;
  #queued: RecordState | null = null;
  #closed = false;
  #invalidated = false;
  #locked = false;
  #entry = false;
  #checking = false;
  #lastNow = -Infinity;
  #unsubscribe: () => void = () => {};

  constructor(options: SpeechControllerOptions) {
    this.#options = Object.freeze({ ...options });
    this.#binding = speechString(options.controllerBindingId);
    this.#owner = speechString(options.ownerInstanceId ?? randomUUID());
    const mode = options.mode ?? 'business';
    if (mode === 'business' && options.authority?.assurance !== 'host-durable')
      speechFail('HOST_DURABLE_AUTHORITY_REQUIRED');
    if (mode === 'business' && options.backend.capabilities.kind === 'synthetic')
      speechFail('BUSINESS_BACKEND_REQUIRED');
    if (mode === 'synthetic-test' && options.backend.capabilities.kind !== 'synthetic')
      speechFail('SYNTHETIC_BACKEND_REQUIRED');
    if (
      !options.gate ||
      typeof options.gate.check !== 'function' ||
      typeof options.gate.subscribeInvalidation !== 'function' ||
      !options.authority?.claims ||
      !options.authority.output ||
      typeof options.sink?.forward !== 'function'
    )
      speechFail('TRUSTED_PORTS_REQUIRED');
    const unsubscribe = options.gate.subscribeInvalidation(() => {
      this.#invalidated = true;
      this.#fence('GATE_INVALIDATED');
    });
    if (typeof unsubscribe !== 'function') speechFail('INVALIDATION_SUBSCRIPTION_REQUIRED');
    this.#unsubscribe = unsubscribe;
  }

  prepare(input: unknown, text: string): SpeechPlan {
    return prepareSpeechPlan(input, text, this.#options.backend.capabilities);
  }

  submit(input: unknown, text: string, signal?: AbortSignal): SpeechOperation {
    if (this.#entry || this.#checking) {
      this.#invalidated = true;
      this.#fence('REENTRANT_PORT');
      speechFail('REENTRANT_PORT');
    }
    this.#entry = true;
    try {
      const plan = prepareSpeechPlan(input, text, this.#options.backend.capabilities);
      const key = speechEffectKey(plan),
        fingerprint = speechHash(canonicalSpeech(plan));
      const existing = this.#records.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) speechFail('EFFECT_CONFLICT');
        return existing.operation;
      }
      if (this.#closed || this.#invalidated || this.#locked) speechFail('CONTROLLER_UNAVAILABLE');
      if (plan.binding.controllerBindingId !== this.#binding) speechFail('BINDING_MISMATCH');
      if ((this.#options.mode ?? 'business') !== 'business' && plan.expression.origin !== 'synthetic-fixture')
        speechFail('SYNTHETIC_ORIGIN_REQUIRED');
      if (this.#records.size >= SPEECH_LIMITS.effects) speechFail('EFFECT_LIMIT');
      if (this.#active && this.#queued) speechFail('BACKPRESSURE');
      if (!this.#current(plan, this.#generation, null)) speechFail('CURRENT_GATE_REJECTED');
      let resolve!: (value: SpeechSnapshot) => void;
      const result = new Promise<SpeechSnapshot>((r) => {
        resolve = r;
      });
      let resolveDrained!: () => void;
      const drained = new Promise<void>((r) => {
        resolveDrained = r;
      });
      const record: RecordState = {
        plan,
        text,
        key,
        fingerprint,
        generation: this.#generation,
        phase: 'planned',
        outcome: null,
        code: 'PENDING',
        forwarding: 'not_attempted',
        receipts: [],
        rejected: 0,
        firstRejected: null,
        lease: null,
        token: null,
        backend: null,
        dispatched: false,
        fenced: false,
        engineCompleted: false,
        engineStopped: false,
        sequence: 0,
        stream: null,
        settlement: null,
        resolve,
        drained,
        resolveDrained,
        operation: null as unknown as SpeechOperation,
        deadlineTimer: null,
        stopTimer: null,
        detachAbort: null,
        released: false,
        running: false,
      };
      record.operation = Object.freeze({ result, snapshot: () => this.#snapshot(record) });
      this.#records.set(key, record);
      if (signal) {
        const abort = () => this.#cancel(record, 'ABORTED');
        signal.addEventListener('abort', abort, { once: true });
        record.detachAbort = () => signal.removeEventListener('abort', abort);
      }
      if (signal?.aborted) {
        this.#finish(record, 'cancelled_before_dispatch', 'ABORTED');
        return record.operation;
      }
      record.deadlineTimer = setTimeout(
        () => this.#cancel(record, 'DEADLINE'),
        Math.max(1, Math.min(2147483647, plan.dispatchDeadlineMonotonicMs - this.#clock())),
      );
      if (this.#active) {
        record.phase = 'queued';
        this.#queued = record;
      } else {
        this.#active = record;
        void this.#run(record);
      }
      return record.operation;
    } finally {
      this.#entry = false;
    }
  }

  async stopDetailed(sessionId?: string): Promise<DetailedSpeechStop> {
    if (
      sessionId !== undefined &&
      this.#active?.plan.sessionId !== sessionId &&
      this.#queued?.plan.sessionId !== sessionId
    )
      return Object.freeze({
        requestAccepted: false,
        engineStoppedReported: false,
        workerExited: false,
        deviceSilenceObserved: false,
      });
    const active = this.#active;
    this.#fence('STOP_REQUESTED');
    if (active) await active.operation.result;
    return Object.freeze({
      requestAccepted: true,
      engineStoppedReported: active?.engineStopped === true,
      workerExited: active?.settlement?.workerExited === true,
      deviceSilenceObserved: false,
    });
  }

  async close(): Promise<DetailedSpeechStop> {
    this.#closed = true;
    try {
      this.#unsubscribe();
    } catch {
      /* cleanup must remain available */
    }
    return this.stopDetailed();
  }

  /** No automatic recovery. A clean, settled worker can change binding; UNKNOWN cannot. */
  async rebind(controllerBindingId: string): Promise<void> {
    if (this.#entry || this.#checking) speechFail('REENTRANT_PORT');
    speechString(controllerBindingId);
    const active = this.#active;
    this.#fence('REBIND');
    if (active) await active.operation.result;
    if (this.#closed || this.#locked) speechFail('REBIND_REQUIRES_SETTLEMENT');
    if (active) await active.drained;
    if (this.#closed || this.#locked || this.#active || this.#queued) speechFail('REBIND_REQUIRES_SETTLEMENT');
    this.#binding = speechString(controllerBindingId);
    this.#generation++;
    this.#invalidated = false;
  }

  #clock(): number {
    let value: number;
    try {
      value = (this.#options.now ?? (() => performance.now()))();
    } catch {
      value = NaN;
    }
    if (!Number.isFinite(value) || value < 0 || value < this.#lastNow) {
      this.#invalidated = true;
      this.#fence('CLOCK_INVALID');
      return NaN;
    }
    this.#lastNow = value;
    return value;
  }

  #current(plan: SpeechPlan, generation: number, lease: OutputLease | null): boolean {
    if (this.#checking || this.#closed || this.#invalidated || this.#locked || generation !== this.#generation)
      return false;
    const now = this.#clock();
    if (!Number.isFinite(now) || now >= plan.dispatchDeadlineMonotonicMs) return false;
    this.#checking = true;
    try {
      const gateResult = this.#options.gate.check(plan);
      if (gateResult !== true) {
        if (gateResult instanceof Promise) void gateResult.catch(() => {});
        return false;
      }
      const afterGate = this.#clock();
      if (
        !Number.isFinite(afterGate) ||
        afterGate >= plan.dispatchDeadlineMonotonicMs ||
        generation !== this.#generation ||
        this.#invalidated ||
        this.#closed ||
        this.#locked
      )
        return false;
      if (lease) {
        const leaseResult = this.#options.authority.output.isCurrent(lease);
        if (leaseResult !== true) {
          if (leaseResult instanceof Promise) void leaseResult.catch(() => {});
          return false;
        }
        const afterLease = this.#clock();
        if (!Number.isFinite(afterLease) || afterLease >= plan.dispatchDeadlineMonotonicMs) return false;
      }
      return generation === this.#generation && !this.#invalidated && !this.#closed && !this.#locked;
    } catch {
      return false;
    } finally {
      this.#checking = false;
    }
  }

  async #bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SpeechError('PORT_TIMEOUT')), Math.max(1, milliseconds));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #run(record: RecordState): Promise<void> {
    record.running = true;
    try {
      if (!this.#eligible(record)) return this.#finish(record, 'cancelled_before_dispatch', 'STALE_BEFORE_LEASE');
      const resourceKey = speechResourceKey(record.plan);
      let acquisitionExpired = false;
      const acquisition = Promise.resolve(
        this.#options.authority.output.acquire(Object.freeze({ resourceKey, ownerInstanceId: this.#owner })),
      );
      void acquisition.then(
        (lease) => {
          if (acquisitionExpired && lease) {
            try {
              const exact = validateOutputLease(lease, resourceKey, this.#owner);
              void this.#options.authority.output
                .release(
                  exact,
                  Object.freeze({ bodyNeverDispatched: true, engineTerminalReported: false, workerExited: true }),
                )
                .catch(() => {
                  this.#locked = true;
                });
            } catch {
              this.#locked = true;
            }
          }
        },
        () => {},
      );
      let lease: OutputLease | null;
      try {
        lease = await this.#bounded(acquisition, this.#remaining(record));
      } catch (error) {
        acquisitionExpired = true;
        throw error;
      }
      if (!lease) return this.#finish(record, 'failed_before_dispatch', 'OUTPUT_LEASE_UNAVAILABLE');
      record.lease = validateOutputLease(lease, resourceKey, this.#owner);
      if (!this.#eligible(record)) return this.#finish(record, 'cancelled_before_dispatch', 'STALE_AFTER_LEASE');
      const claim = await this.#bounded(
        Promise.resolve(
          this.#options.authority.claims.claim(
            Object.freeze({
              effectKey: record.key,
              fingerprint: record.fingerprint,
              lease: record.lease,
            }),
          ),
        ),
        this.#remaining(record),
      );
      const status = speechObject(claim, ['status']).status;
      if (status !== 'claimed')
        return this.#finish(
          record,
          'failed_before_dispatch',
          status === 'conflict' ? 'EFFECT_CONFLICT' : status === 'existing' ? 'ALREADY_CONSUMED' : 'CLAIM_UNKNOWN',
        );
      record.phase = 'claimed';
      if (!this.#eligible(record)) return this.#finish(record, 'cancelled_before_dispatch', 'STALE_AFTER_CLAIM');
      record.token = Object.freeze({
        effectKey: record.key,
        fingerprint: record.fingerprint,
        controllerGeneration: record.generation,
        workerInstanceId: randomUUID(),
        lease: record.lease,
      });
      const backend = this.#options.backend.start(record.plan, record.token, (event) => this.#receive(record, event));
      record.backend = backend;
      void backend.settled.then(
        (settlement) => this.#settled(record, settlement),
        () =>
          this.#settled(record, { workerExited: false, exitCode: null, forcedTermination: false, protocolFault: true }),
      );
      if (record.fenced || record.outcome) {
        this.#stopBackend(record);
        return;
      }
      await this.#bounded(backend.ready, this.#remaining(record));
      if (!this.#eligible(record) || record.settlement) {
        this.#cancel(record, 'STALE_AFTER_READY');
        return;
      }
      record.phase = 'dispatching';
      record.dispatched = true;
      // Set possible-dispatch before entering untrusted/reentrant transport code.
      backend.dispatch(record.text);
      record.text = '';
      if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
      record.deadlineTimer = setTimeout(
        () => this.#cancel(record, 'UTTERANCE_DEADLINE'),
        Math.max(1, Math.min(record.plan.maxUtteranceMs, record.plan.dispatchDeadlineMonotonicMs - this.#clock())),
      );
    } catch (error) {
      const code = error instanceof SpeechError ? error.code : 'PORT_FAILED';
      if (record.backend) {
        record.code = code;
        record.fenced = true;
        this.#stopBackend(record);
      } else this.#finish(record, record.fenced ? 'cancelled_before_dispatch' : 'failed_before_dispatch', code);
    } finally {
      record.running = false;
      this.#drain(record);
    }
  }

  #remaining(record: RecordState): number {
    return Math.min(SPEECH_LIMITS.startupMs, record.plan.dispatchDeadlineMonotonicMs - this.#clock());
  }
  #eligible(record: RecordState): boolean {
    return (
      !record.outcome &&
      !record.fenced &&
      this.#current(record.plan, record.generation, record.lease) &&
      !record.outcome &&
      !record.fenced
    );
  }

  #receive(record: RecordState, input: unknown): void {
    if (record.outcome) {
      this.#rejectEvent(record, 'AFTER_TERMINAL', false);
      return;
    }
    try {
      const event = speechObject(input, ['token', 'sequence', 'kind', 'streamId', 'code']);
      // Comparison is against an internal immutable token, never caller-selected identity.
      const token = speechObject(event.token, [
        'effectKey',
        'fingerprint',
        'controllerGeneration',
        'workerInstanceId',
        'lease',
      ]);
      speechObject(token.lease, ['resourceKey', 'ownerInstanceId', 'leaseId', 'fencingGeneration']);
      if (canonicalSpeech(token) !== canonicalSpeech(record.token)) speechFail('EVENT_IDENTITY');
      const sequence = speechInteger(event.sequence, 1, 8),
        stream = speechInteger(event.streamId);
      speechString(event.code, 64);
      if (
        sequence !== record.sequence + 1 ||
        !['queued', 'completed', 'stopped', 'fault'].includes(event.kind as string)
      )
        speechFail('EVENT_ORDER');
      if (record.stream !== null && stream !== record.stream) speechFail('STREAM_IDENTITY');
      if (event.kind === 'queued' && (record.sequence !== 0 || stream === 0 || !record.dispatched))
        speechFail('EVENT_ORDER');
      if (
        event.kind === 'completed' &&
        (record.stream === null || !record.dispatched || record.engineCompleted || record.engineStopped)
      )
        speechFail('EVENT_ORDER');
      if (event.kind === 'stopped' && !record.fenced) speechFail('UNREQUESTED_STOP_EVENT');
      record.sequence = sequence;
      if (event.kind === 'queued') record.stream = stream;
      if (record.fenced && event.kind !== 'stopped' && event.kind !== 'fault') {
        this.#rejectEvent(record, 'FENCED_EVENT', false);
        return;
      }
      if (event.kind === 'stopped') {
        record.engineStopped = true;
        return;
      }
      if (event.kind === 'fault') {
        record.code = 'BACKEND_FAULT';
        record.fenced = true;
        this.#stopBackend(record);
        return;
      }
      if (!this.#eligible(record)) {
        this.#cancel(record, 'STALE_RECEIPT');
        return;
      }
      if (event.kind === 'queued') record.phase = 'backend_queued';
      if (event.kind === 'completed') record.engineCompleted = true;
    } catch (error) {
      this.#rejectEvent(record, error instanceof SpeechError ? error.code : 'INVALID_EVENT', true);
    }
  }

  #rejectEvent(record: RecordState, code: string, stop: boolean): void {
    record.rejected = Math.min(Number.MAX_SAFE_INTEGER, record.rejected + 1);
    record.firstRejected ??= code;
    if (stop && !record.outcome) {
      record.code = code;
      record.fenced = true;
      this.#stopBackend(record);
    }
  }

  #settled(record: RecordState, input: BackendSettlement): void {
    try {
      const s = speechObject(input, ['workerExited', 'exitCode', 'forcedTermination', 'protocolFault']);
      if (
        typeof s.workerExited !== 'boolean' ||
        typeof s.forcedTermination !== 'boolean' ||
        typeof s.protocolFault !== 'boolean' ||
        !(s.exitCode === null || Number.isSafeInteger(s.exitCode))
      )
        speechFail('INVALID_SETTLEMENT');
      record.settlement = Object.freeze({ ...s }) as BackendSettlement;
    } catch {
      record.settlement = { workerExited: false, exitCode: null, forcedTermination: false, protocolFault: true };
    }
    if (record.stopTimer) {
      clearTimeout(record.stopTimer);
      record.stopTimer = null;
    }
    if (record.outcome) {
      this.#drain(record);
      return;
    }
    const clean =
      record.settlement.workerExited &&
      record.settlement.exitCode === 0 &&
      !record.settlement.forcedTermination &&
      !record.settlement.protocolFault;
    if (!record.dispatched)
      this.#finish(
        record,
        record.fenced ? 'cancelled_before_dispatch' : 'failed_before_dispatch',
        record.code === 'PENDING' ? 'WORKER_ENDED_BEFORE_DISPATCH' : record.code,
      );
    else if (clean && record.engineStopped) this.#finish(record, 'stopped_reported', 'ENGINE_STOPPED_REPORTED');
    else if (clean && record.engineCompleted && this.#eligible(record))
      this.#finish(record, 'backend_completed_reported', 'ENGINE_COMPLETED_REPORTED');
    else
      this.#finish(record, 'unknown_after_dispatch', record.code === 'PENDING' ? 'UNCONFIRMED_DISPATCH' : record.code);
  }

  #cancel(record: RecordState, code: string): void {
    if (record.outcome) return;
    if (record === this.#queued) {
      this.#queued = null;
      record.fenced = true;
      this.#finish(record, 'cancelled_before_dispatch', code);
      return;
    }
    if (record === this.#active) this.#fence(code);
    else {
      record.fenced = true;
      this.#finish(record, 'cancelled_before_dispatch', code);
    }
  }

  #fence(code: string): void {
    this.#generation++;
    const queued = this.#queued;
    this.#queued = null;
    if (queued && !queued.outcome) {
      queued.fenced = true;
      this.#finish(queued, 'cancelled_before_dispatch', code);
    }
    const active = this.#active;
    if (active && !active.outcome) {
      active.fenced = true;
      active.code = code;
      active.text = '';
      if (active.backend) this.#stopBackend(active);
      else this.#finish(active, 'cancelled_before_dispatch', code);
    }
  }

  #stopBackend(record: RecordState): void {
    if (!record.backend || record.settlement || record.stopTimer) return;
    record.stopTimer = setTimeout(() => {
      record.stopTimer = null;
      if (!record.outcome)
        this.#finish(
          record,
          record.dispatched ? 'unknown_after_dispatch' : 'cancelled_before_dispatch',
          'WORKER_SETTLEMENT_TIMEOUT',
        );
      // Do not release raw ownership on timeout. Even a non-speaking worker must really settle.
      if (!record.settlement?.workerExited) {
        this.#locked = true;
        this.#block(record);
      }
    }, SPEECH_LIMITS.stopMs + SPEECH_LIMITS.exitMs);
    try {
      record.backend.stop();
    } catch {
      record.code = 'STOP_REQUEST_FAILED';
    }
  }

  #block(record: RecordState): void {
    if (record.lease)
      try {
        this.#options.authority.output.block(record.lease);
      } catch {
        /* local lock survives */
      }
  }

  #finish(record: RecordState, outcome: SpeechOutcome, code: string): void {
    if (record.outcome) return;
    record.outcome = outcome;
    record.code = code;
    record.phase = 'terminal';
    record.text = '';
    if (record.deadlineTimer) {
      clearTimeout(record.deadlineTimer);
      record.deadlineTimer = null;
    }
    record.detachAbort?.();
    record.detachAbort = null;
    if (outcome === 'unknown_after_dispatch') {
      this.#locked = true;
      this.#block(record);
    }
    const receipt: TechnicalSpeechReceipt = Object.freeze({
      eventClass: 'technical-delivery',
      receiptId: speechHash(record.key + ':1'),
      effectKey: record.key,
      sequence: 1,
      outcome,
      code,
      deviceEvidence: 'not_observed',
      userAudibility: 'NOT_EVALUATED',
      userIntelligibility: 'NOT_EVALUATED',
      naturalness: 'NOT_EVALUATED',
    });
    record.receipts.push(receipt);
    if (this.#current(record.plan, record.generation, record.lease)) {
      record.forwarding = 'pending';
      // Sink work is independent of worker cleanup; no user ACK/feedback APIs are accessible here.
      let forwarding: Promise<void>;
      try {
        forwarding = Promise.resolve(this.#options.sink.forward(receipt));
      } catch {
        forwarding = Promise.reject(new SpeechError('SINK_FAILED'));
      }
      void this.#bounded(forwarding, SPEECH_LIMITS.stopMs).then(
        () => {
          record.forwarding = 'forwarded';
        },
        (error) => {
          record.forwarding = error instanceof SpeechError && error.code === 'PORT_TIMEOUT' ? 'timed_out' : 'failed';
        },
      );
    } else record.forwarding = 'stale';
    record.resolve(this.#snapshot(record));
    this.#drain(record);
  }

  #drain(record: RecordState): void {
    if (
      !record.outcome ||
      record.released ||
      (record.running && !record.backend) ||
      (record.backend && !record.settlement?.workerExited)
    )
      return;
    record.released = true;
    const release = async () => {
      if (record.lease && record.outcome !== 'unknown_after_dispatch') {
        try {
          await this.#bounded(
            Promise.resolve(
              this.#options.authority.output.release(
                record.lease,
                Object.freeze({
                  bodyNeverDispatched: !record.dispatched,
                  engineTerminalReported: record.engineCompleted || record.engineStopped,
                  workerExited: !record.backend || record.settlement?.workerExited === true,
                }),
              ),
            ),
            SPEECH_LIMITS.startupMs,
          );
        } catch {
          this.#locked = true;
          this.#block(record);
        }
      }
      if (this.#active === record) {
        this.#active = null;
        const queued = this.#queued;
        this.#queued = null;
        if (queued) {
          if (this.#closed || this.#invalidated || this.#locked || queued.generation !== this.#generation)
            this.#finish(queued, 'cancelled_before_dispatch', 'CONTROLLER_UNAVAILABLE');
          else {
            this.#active = queued;
            void this.#run(queued);
          }
        }
      }
      record.resolveDrained();
    };
    void release();
  }

  #snapshot(r: RecordState): SpeechSnapshot {
    return Object.freeze({
      effectKey: r.key,
      fingerprint: r.fingerprint,
      phase: r.phase,
      outcome: r.outcome,
      code: r.code,
      forwarding: r.forwarding,
      workerExited: r.settlement?.workerExited === true,
      engineStoppedReported: r.engineStopped,
      forcedTermination: r.settlement?.forcedTermination === true,
      deviceSilenceObserved: false,
      rejectedEvents: r.rejected,
      firstRejectedEventCode: r.firstRejected,
      receipts: Object.freeze([...r.receipts]),
    });
  }
}

/** Lossy compatibility only. The first accepted signal owns the prepared intent lifecycle. */
export function createLegacyMediaFacade(
  controller: SpeechController,
  preparedIntent?: Readonly<{ plan: SpeechPlan; text: string }>,
): MediaAdapter {
  const prepared = preparedIntent
    ? Object.freeze({ plan: controller.prepare(preparedIntent.plan, preparedIntent.text), text: preparedIntent.text })
    : null;
  return Object.freeze({
    async speak(input: { sessionId: string; text: string; signal: AbortSignal }) {
      if (!prepared || input.sessionId !== prepared.plan.sessionId || input.text !== prepared.text)
        return { status: 'failed' as const };
      try {
        const result = await controller.submit(prepared.plan, input.text, input.signal).result;
        return {
          status:
            result.outcome === 'backend_completed_reported'
              ? ('completed' as const)
              : result.outcome === 'cancelled_before_dispatch' || result.outcome === 'stopped_reported'
                ? ('cancelled' as const)
                : ('failed' as const),
        };
      } catch {
        return { status: 'failed' as const };
      }
    },
    async stop(sessionId: string) {
      return { acknowledged: (await controller.stopDetailed(sessionId)).requestAccepted };
    },
  });
}
