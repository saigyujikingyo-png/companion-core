import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { Evidence, InferenceAdapter, Proposal } from './contracts.ts';
import { CoreError, fail } from './validation.ts';
import {
  HYBRID_LIMITS,
  HYBRID_QUALIFICATION,
  bindingDigest,
  hybridDigest,
  hybridFields,
  hybridId,
  hybridJson,
  profileDigest,
  validateHybridBinding,
  validateHybridProfile,
} from './hybrid-profile.ts';
import type { HybridBinding, HybridLease, HybridProfile } from './hybrid-profile.ts';
import { copyHybridProposal, decodeHybridReply, encodeHybridRequest } from './hybrid-wire.ts';
import type { HybridReply } from './hybrid-wire.ts';

export type HybridPhase = 'dispatch' | 'deliver' | 'replay';
export type HybridValidator = (
  input: Readonly<{ profileDigest: string; binding: HybridBinding; phase: HybridPhase }>,
) => unknown;
/** Trusted in-process port, not an arbitrary-JavaScript sandbox. Return an ordinary
 * native Promise with stable native constructor/species, established before return,
 * and own the underlying work's rejection cleanup. An own `then` decoration is OK.
 * Normal late rejection is consumed by the coordinator. A constructor/species
 * violation may prevent installing any handler: UNKNOWN/permit retention alone
 * does not make that violation's late rejection safe; cleanup remains with the port. */
export type HybridBackendPort = {
  generate(
    input: Readonly<{ lease: HybridLease; requestBytes: Uint8Array; signal: AbortSignal }>,
  ): Promise<HybridReply>;
};
export type HybridRequestState = 'in_flight' | 'completed' | 'unknown_after_dispatch';
export type HybridStatus = Readonly<{
  requestId: string;
  state: HybridRequestState;
  transportSettled: boolean;
  reason: string | null;
}>;
export const HYBRID_STATE_CAPABILITIES = Object.freeze({
  reset: 'logical-fence-only',
  prefixReuse: 'unsupported',
  checkpoint: 'unsupported',
  fork: 'unsupported',
  rollback: 'unsupported',
  transfer: 'unsupported',
  tensorExport: 'unsupported',
} as const);
export type HybridStateAction = keyof typeof HYBRID_STATE_CAPABILITIES;
export type HybridFenceReceipt = Readonly<{ logicalFenced: true; backendStopConfirmed: false; epoch: number }>;

type Entry = {
  owner: object;
  namespaceDigest: string;
  requestId: string;
  lease: HybridLease;
  requestDigest: string;
  state: HybridRequestState;
  transportSettled: boolean;
  reason: string | null;
  proposal: Proposal | null;
};
type LaneData = {
  generate: HybridBackendPort['generate'];
  records: Map<string, Entry>;
  reservedBytes: number;
  physical: Entry | null;
  inCallback: boolean;
};
const lanes = new WeakMap<HybridBackendLane, LaneData>();

/** One stable lane per actual worker. Creating another lane is NOT a retry/reset authority. */
export class HybridBackendLane {
  constructor(port: HybridBackendPort) {
    const p = hybridFields(port, ['generate']);
    if (typeof p.generate !== 'function' || types.isProxy(p.generate)) fail('HYBRID_WIRE_SHAPE');
    const generate = p.generate as HybridBackendPort['generate'];
    lanes.set(this, {
      generate: (input) => generate.call(port, input),
      records: new Map(),
      reservedBytes: 0,
      physical: null,
      inCallback: false,
    });
    Object.freeze(this);
  }
}
function noReentry(lane: LaneData): void {
  if (lane.inCallback) fail('HYBRID_REENTRY');
}
function callback<T>(lane: LaneData, fn: () => T): T {
  noReentry(lane);
  lane.inCallback = true;
  try {
    return fn();
  } finally {
    lane.inCallback = false;
  }
}
function consumeDeniedThenable(value: unknown): void {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    // Execute foreign then synchronously inside the callback guard. Promise.resolve
    // would invoke it in a later microtask, permitting synchronous callback reentry.
    if (types.isPromise(value)) {
      void Promise.prototype.then.call(
        value,
        () => undefined,
        () => undefined,
      );
      return;
    }
    const then = Reflect.get(value, 'then') as unknown;
    if (typeof then === 'function') {
      const returned: unknown = then.call(
        value,
        () => undefined,
        () => undefined,
      );
      if (types.isPromise(returned))
        void Promise.prototype.then.call(
          returned,
          () => undefined,
          () => undefined,
        );
    }
  }
}
function signalValue(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype
  )
    fail('HYBRID_WIRE_SHAPE');
  try {
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(value);
  } catch {
    fail('HYBRID_WIRE_SHAPE');
  }
  return value as AbortSignal;
}
function aborted(signal: AbortSignal | undefined): boolean {
  return (
    signal !== undefined &&
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(signal) === true
  );
}
function addAbort(signal: AbortSignal, listener: () => void): void {
  EventTarget.prototype.addEventListener.call(signal, 'abort', listener, { once: true });
}
function removeAbort(signal: AbortSignal, listener: () => void): void {
  EventTarget.prototype.removeEventListener.call(signal, 'abort', listener);
}

export class HybridInferenceSession {
  readonly #lane: LaneData;
  readonly #owner = Object.freeze({});
  readonly #controllerId = randomUUID();
  readonly #validate: HybridValidator;
  readonly #timeoutMs: number;
  #profile: HybridProfile;
  #binding: HybridBinding;
  #lease: HybridLease;
  #epoch = 0;
  #active = new AbortController();
  #valid = true;
  #closed = false;

  constructor(options: {
    lane: HybridBackendLane;
    profile: HybridProfile;
    binding: HybridBinding;
    validateCurrent: HybridValidator;
    timeoutMs?: number;
  }) {
    const o = hybridFields(options, ['lane', 'profile', 'binding', 'validateCurrent'], ['timeoutMs']);
    const lane = lanes.get(o.lane as HybridBackendLane);
    if (!lane) fail('HYBRID_WIRE_SHAPE');
    noReentry(lane);
    if (typeof o.validateCurrent !== 'function' || types.isProxy(o.validateCurrent)) fail('HYBRID_WIRE_SHAPE');
    const timeout = o.timeoutMs === undefined ? HYBRID_LIMITS.defaultTimeoutMs : o.timeoutMs;
    if (
      typeof timeout !== 'number' ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > HYBRID_LIMITS.maxTimeoutMs
    )
      fail('HYBRID_TIMEOUT_INVALID');
    this.#profile = validateHybridProfile(o.profile);
    this.#binding = validateHybridBinding(o.binding);
    this.#lane = lane;
    this.#validate = o.validateCurrent as HybridValidator;
    this.#timeoutMs = timeout;
    this.#lease = this.#makeLease();
    Object.freeze(this);
  }
  #makeLease(): HybridLease {
    return Object.freeze({
      controllerId: this.#controllerId,
      leaseId: randomUUID(),
      epoch: this.#epoch,
      profileDigest: profileDigest(this.#profile),
      bindingDigest: bindingDigest(this.#binding),
    });
  }
  #current(lease: HybridLease): boolean {
    return !this.#closed && this.#valid && this.#lease === lease;
  }
  #namespaceDigest(): string {
    return hybridDigest(hybridJson(this.#binding.namespace, HYBRID_LIMITS.bindingBytes));
  }
  #requireCurrent(lease: HybridLease): void {
    if (this.#closed) fail('HYBRID_CLOSED');
    if (!this.#current(lease)) fail('HYBRID_FENCED');
  }
  #gate(phase: HybridPhase, lease: HybridLease): void {
    let allowed = false;
    try {
      callback(this.#lane, () => {
        const result = this.#validate(
          Object.freeze({ profileDigest: lease.profileDigest, binding: this.#binding, phase }),
        );
        allowed = result === true;
        if (!allowed) consumeDeniedThenable(result);
      });
    } catch {
      allowed = false;
    }
    if (!allowed) fail('HYBRID_CURRENTNESS_DENIED');
    this.#requireCurrent(lease);
  }

  /** Failures before dispatch may throw synchronously; no ID is consumed at that stage. */
  propose(input: {
    requestId: string;
    selectedEvidence: readonly Evidence[];
    signal?: AbortSignal;
  }): Promise<Proposal> {
    noReentry(this.#lane);
    const i = hybridFields(input, ['requestId', 'selectedEvidence'], ['signal']);
    const requestId = hybridId(i.requestId);
    const existing = this.#lane.records.get(requestId);
    // Ownership is checked before payload/currentness/capacity: collisions reveal nothing.
    if (existing && (existing.owner !== this.#owner || existing.namespaceDigest !== this.#namespaceDigest()))
      fail('HYBRID_REQUEST_CONFLICT');
    const lease = this.#lease;
    const signal = signalValue(i.signal);
    const requestBytes = encodeHybridRequest({
      requestId,
      lease,
      profileDigest: lease.profileDigest,
      binding: this.#binding,
      selectedEvidence: i.selectedEvidence,
    });
    const requestDigest = hybridDigest(requestBytes);
    if (existing) {
      if (existing.requestDigest !== requestDigest) fail('HYBRID_REQUEST_CONFLICT');
      if (existing.state === 'in_flight') fail('HYBRID_IN_FLIGHT');
      if (existing.state === 'unknown_after_dispatch') fail('HYBRID_UNKNOWN');
      this.#requireCurrent(lease);
      if (aborted(signal)) fail('HYBRID_ABORTED');
      this.#gate('replay', lease);
      if (aborted(signal)) fail('HYBRID_ABORTED');
      return Promise.resolve(copyHybridProposal(existing.proposal));
    }
    this.#requireCurrent(lease);
    if (aborted(signal)) fail('HYBRID_ABORTED');
    if (this.#lane.records.size >= HYBRID_LIMITS.lifetimeRequestIds) fail('HYBRID_LEDGER_FULL');
    if (this.#lane.physical !== null) fail('HYBRID_LANE_BUSY');
    // Reserve the worst result and metadata before calling ANY backend code. Requests
    // are represented by their full-byte digest, not retained plaintext prompt bytes.
    const namespaceDigest = this.#namespaceDigest();
    const metadata = {
      namespaceDigest,
      requestId,
      lease,
      requestDigest,
      state: 'unknown_after_dispatch',
      transportSettled: false,
      reason: 'x'.repeat(64),
      proposal: null,
    };
    const reserved = Buffer.byteLength(hybridJson(metadata, 8192), 'utf8') + HYBRID_LIMITS.resultBytesPerRequest;
    if (this.#lane.reservedBytes + reserved > HYBRID_LIMITS.ledgerBytes) fail('HYBRID_LEDGER_FULL');
    this.#gate('dispatch', lease);
    if (aborted(signal)) fail('HYBRID_ABORTED');
    this.#requireCurrent(lease);
    const record: Entry = {
      owner: this.#owner,
      namespaceDigest,
      requestId,
      lease,
      requestDigest,
      state: 'in_flight',
      transportSettled: false,
      reason: null,
      proposal: null,
    };
    this.#lane.records.set(requestId, record);
    this.#lane.reservedBytes += reserved;
    this.#lane.physical = record;
    return this.#dispatch(record, requestBytes, signal);
  }

  #dispatch(record: Entry, requestBytes: Uint8Array, callerSignal: AbortSignal | undefined): Promise<Proposal> {
    const local = new AbortController(),
      leaseSignal = this.#active.signal;
    let done = false;
    let resolvePublic!: (proposal: Proposal) => void, rejectPublic!: (error: Error) => void;
    const result = new Promise<Proposal>((resolve, reject) => {
      resolvePublic = resolve;
      rejectPublic = reject;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (callerSignal) removeAbort(callerSignal, callerAbort);
      removeAbort(leaseSignal, leaseAbort);
    };
    const stop = (reason: string, abortBackend = true): void => {
      if (done) return;
      done = true;
      record.state = 'unknown_after_dispatch';
      record.reason = reason;
      cleanup();
      rejectPublic(new CoreError(reason));
      if (!abortBackend) return;
      // Both our own abort callbacks and backend callbacks see the fence first.
      // This may run inside invalidate's existing callback guard.
      const previous = this.#lane.inCallback;
      this.#lane.inCallback = true;
      try {
        local.abort();
      } finally {
        this.#lane.inCallback = previous;
      }
    };
    const callerAbort = (): void => stop('HYBRID_ABORTED');
    const leaseAbort = (): void => stop('HYBRID_FENCED');
    if (callerSignal) addAbort(callerSignal, callerAbort);
    addAbort(leaseSignal, leaseAbort);
    timer = setTimeout(() => stop('HYBRID_TIMEOUT'), this.#timeoutMs);
    const settled = (): void => {
      record.transportSettled = true;
      if (this.#lane.physical === record) this.#lane.physical = null;
    };
    const rejected = (): void => {
      settled();
      stop('HYBRID_BACKEND_FAILED');
    };
    const delivered = (reply: HybridReply): void => {
      settled();
      if (done) return; // UNKNOWN never becomes completed, even after a valid late reply.
      try {
        this.#requireCurrent(record.lease);
        const proposal = decodeHybridReply(reply, {
          requestId: record.requestId,
          lease: record.lease,
          profileDigest: record.lease.profileDigest,
        });
        this.#gate('deliver', record.lease);
        if (done || aborted(callerSignal)) {
          stop('HYBRID_ABORTED');
          return;
        }
        this.#requireCurrent(record.lease);
        record.proposal = Object.freeze(copyHybridProposal(proposal));
        record.state = 'completed';
        done = true;
        cleanup();
        resolvePublic(copyHybridProposal(proposal));
      } catch (error) {
        stop(error instanceof CoreError ? error.code : 'HYBRID_REPLY_REJECTED');
      }
    };
    let raw: Promise<HybridReply>;
    try {
      raw = callback(this.#lane, () =>
        this.#lane.generate(
          Object.freeze({ lease: record.lease, requestBytes: new Uint8Array(requestBytes), signal: local.signal }),
        ),
      );
    } catch {
      rejected();
      return result;
    } // A synchronous port throw returned no raw Promise.
    try {
      // Bypass an own `then` override. Installing the intrinsic hook may still throw
      // (for example a poisoned constructor/species); that is not raw settlement.
      callback(this.#lane, () => {
        void Promise.prototype.then.call(raw, delivered, rejected);
      });
    } catch {
      // No handler may have been installed. Do not actively trigger an abort
      // rejection; the violating port still owns any independent late rejection.
      stop('HYBRID_BACKEND_UNOBSERVABLE', false);
    }
    // If observation failed, UNKNOWN and the physical permit remain held. Neither
    // cancellation nor an unobserved late result provides evidence of settlement.
    return result;
  }

  asInferenceAdapter(requestId: string): InferenceAdapter {
    noReentry(this.#lane);
    hybridId(requestId);
    this.#requireCurrent(this.#lease);
    const lease = this.#lease;
    const capabilities: InferenceAdapter['capabilities'] = {
      providerId: 'companion-hybrid-json-v1',
      modelVersion: `${this.#profile.profileId}@${lease.profileDigest}`,
      input: ['text'],
      structuredOutput: 'validated',
      cancellation: 'local_drop_only',
    };
    Object.freeze(capabilities.input);
    Object.freeze(capabilities);
    return Object.freeze({
      capabilities,
      proposeMemory: async (input: { selectedEvidence: Evidence[]; signal: AbortSignal }) => {
        this.#requireCurrent(lease);
        const i = hybridFields(input, ['selectedEvidence', 'signal']);
        return this.propose({
          requestId,
          selectedEvidence: i.selectedEvidence as Evidence[],
          signal: i.signal as AbortSignal,
        });
      },
    });
  }
  status(requestId: string): HybridStatus | null {
    noReentry(this.#lane);
    hybridId(requestId);
    const record = this.#lane.records.get(requestId);
    if (!record || record.owner !== this.#owner || record.namespaceDigest !== this.#namespaceDigest()) return null;
    return Object.freeze({
      requestId,
      state: record.state,
      transportSettled: record.transportSettled,
      reason: record.reason,
    });
  }
  #fence(): HybridFenceReceipt {
    this.#valid = false;
    if (this.#epoch < Number.MAX_SAFE_INTEGER) this.#epoch++;
    else this.#closed = true;
    callback(this.#lane, () => this.#active.abort());
    return Object.freeze({ logicalFenced: true, backendStopConfirmed: false, epoch: this.#epoch });
  }
  invalidate(reason: string): HybridFenceReceipt {
    noReentry(this.#lane);
    hybridId(reason);
    return this.#fence();
  }
  close(): HybridFenceReceipt {
    noReentry(this.#lane);
    this.#closed = true;
    return this.#fence();
  }
  rebind(input: { profile: HybridProfile; binding: HybridBinding }): void {
    noReentry(this.#lane);
    if (this.#closed) fail('HYBRID_CLOSED');
    const i = hybridFields(input, ['profile', 'binding']);
    const profile = validateHybridProfile(i.profile),
      binding = validateHybridBinding(i.binding);
    if (this.#epoch >= Number.MAX_SAFE_INTEGER) fail('HYBRID_EPOCH_EXHAUSTED');
    this.#fence();
    this.#profile = profile;
    this.#binding = binding;
    this.#active = new AbortController();
    this.#lease = this.#makeLease();
    this.#valid = true;
  }
  requireStateCapability(action: HybridStateAction): HybridFenceReceipt {
    noReentry(this.#lane);
    if (action === 'reset') return this.invalidate('reset');
    fail('HYBRID_STATE_UNSUPPORTED');
  }
  get qualification(): typeof HYBRID_QUALIFICATION {
    return HYBRID_QUALIFICATION;
  }
  get stateCapabilities(): typeof HYBRID_STATE_CAPABILITIES {
    return HYBRID_STATE_CAPABILITIES;
  }
}
