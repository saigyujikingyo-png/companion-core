import { setImmediate as immediate } from 'node:timers/promises';
import { SpeechController } from '../../src/speech-controller.ts';
import { canonicalSpeech, speechHash } from '../../src/speech-contract.ts';
import type {
  BackendEvent,
  BackendSettlement,
  CurrentSpeechGate,
  ExecutionToken,
  OutputLease,
  SpeechAuthority,
  SpeechBackendOperation,
  SpeechBackendPort,
  SpeechCapabilities,
  SpeechPlan,
  SpeechProfile,
  TechnicalSpeechReceipt,
} from '../../src/speech-contract.ts';
export const tick = async () => {
  await immediate();
};
export const text = '原创合成测试。';
export const profile: SpeechProfile = Object.freeze({
  cognitiveBundleId: 'synthetic-bundle',
  voiceBackendId: 'windows-sapi',
  backendVersion: 'au1-v1',
  voiceProfileId: 'synthetic-voice',
  voiceTokenId: 'synthetic-token',
  voiceRevision: 0,
  locale: 'zh-CN',
  rate: 0,
  volume: 20,
  style: 'neutral',
  deviceTokenId: 'synthetic-output',
  transportProfileId: 'whole-utterance',
});
export const capabilities: SpeechCapabilities = Object.freeze({
  backendId: 'windows-sapi',
  backendVersion: 'au1-v1',
  kind: 'synthetic',
  profiles: [profile],
});
export function plan(id = 'intent-1', changes: Partial<SpeechPlan> = {}): SpeechPlan {
  return {
    version: 1,
    effectNamespaceId: 'fixed-synthetic-host-namespace',
    speechIntentId: id,
    utteranceId: 'utterance-1',
    hostId: 'host',
    sessionId: 'session',
    turnId: 'turn',
    binding: {
      scopeId: 'scope',
      generation: 0,
      consentRevision: 0,
      runtimeEpoch: 0,
      hostGeneration: 0,
      permissionId: 'permission',
      permissionEpoch: 0,
      contextRevision: 0,
      controllerBindingId: 'binding',
    },
    sourceRefs: [{ id: 'original-synthetic', revision: 0 }],
    expression: {
      kind: 'committed-expression',
      origin: 'synthetic-fixture',
      sha256: speechHash(text),
      utf8Bytes: Buffer.byteLength(text),
    },
    profile,
    dispatchDeadlineMonotonicMs: Math.ceil(performance.now() + 20000),
    maxUtteranceMs: 5000,
    chunk: { mode: 'whole-utterance', index: 0, final: true },
    ...changes,
  };
}
export class FakeGate implements CurrentSpeechGate {
  current: unknown = true;
  callbacks = new Set<() => void>();
  hook: (() => void) | null = null;
  check() {
    this.hook?.();
    return this.current;
  }
  subscribeInvalidation(callback: () => void) {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }
  invalidate() {
    this.current = false;
    for (const cb of this.callbacks) cb();
  }
}
/** Deliberately RAM-only fixture. It is never an implementation of durable host authority. */
export class FakeAuthority implements SpeechAuthority {
  readonly assurance = 'synthetic-only' as const;
  effects = new Map<string, string>();
  leases = new Map<string, { token: OutputLease; blocked: boolean }>();
  fence = 0;
  claimCalls = 0;
  releases = 0;
  claimHook:
    | ((input: {
        effectKey: string;
        fingerprint: string;
        lease: OutputLease;
      }) => Promise<{ status: 'claimed' | 'existing' | 'conflict' | 'unknown' }>)
    | null = null;
  claims = {
    claim: async (input: { effectKey: string; fingerprint: string; lease: OutputLease }) => {
      this.claimCalls++;
      if (this.claimHook) return this.claimHook(input);
      if (!this.output.isCurrent(input.lease)) return { status: 'unknown' as const };
      const prior = this.effects.get(input.effectKey);
      if (prior !== undefined)
        return { status: prior === input.fingerprint ? ('existing' as const) : ('conflict' as const) };
      this.effects.set(input.effectKey, input.fingerprint);
      return { status: 'claimed' as const };
    },
  };
  output = {
    acquire: async (input: { resourceKey: string; ownerInstanceId: string }) => {
      if (this.leases.has(input.resourceKey)) return null;
      const token = Object.freeze({ ...input, leaseId: 'lease-' + ++this.fence, fencingGeneration: this.fence });
      this.leases.set(input.resourceKey, { token, blocked: false });
      return token;
    },
    isCurrent: (token: OutputLease) => {
      const current = this.leases.get(token.resourceKey);
      return !!current && !current.blocked && canonicalSpeech(current.token) === canonicalSpeech(token);
    },
    release: async (
      token: OutputLease,
      evidence: { bodyNeverDispatched: boolean; engineTerminalReported: boolean; workerExited: boolean },
    ) => {
      const current = this.leases.get(token.resourceKey);
      if (
        !current ||
        current.blocked ||
        canonicalSpeech(current.token) !== canonicalSpeech(token) ||
        !evidence.workerExited ||
        (!evidence.bodyNeverDispatched && !evidence.engineTerminalReported)
      )
        throw new Error('LEASE_RELEASE_REFUSED');
      this.leases.delete(token.resourceKey);
      this.releases++;
    },
    block: (token: OutputLease) => {
      const current = this.leases.get(token.resourceKey);
      if (current && canonicalSpeech(current.token) === canonicalSpeech(token)) current.blocked = true;
    },
  };
  reconcile(resourceKey: string) {
    this.leases.delete(resourceKey);
  }
}
export class FakeWorker implements SpeechBackendOperation {
  ready: Promise<void>;
  settled: Promise<BackendSettlement>;
  makeReady!: () => void;
  settle!: (s: BackendSettlement) => void;
  token: ExecutionToken;
  receive: (event: unknown) => void;
  dispatches: string[] = [];
  stops = 0;
  sequence = 0;
  stream = 7;
  stopSettles = true;
  dispatchHook: (() => void) | null = null;
  constructor(token: ExecutionToken, receive: (event: unknown) => void, autoReady: boolean) {
    this.token = token;
    this.receive = receive;
    this.ready = new Promise((r) => {
      this.makeReady = r;
    });
    this.settled = new Promise((r) => {
      this.settle = r;
    });
    if (autoReady) this.makeReady();
  }
  event(kind: BackendEvent['kind'], changes: Partial<BackendEvent> = {}) {
    this.receive({
      token: this.token,
      sequence: ++this.sequence,
      kind,
      streamId: this.dispatches.length ? this.stream : 0,
      code: 'SYNTHETIC',
      ...changes,
    });
  }
  dispatch(value: string) {
    this.dispatches.push(value);
    this.dispatchHook?.();
    this.event('queued');
  }
  stop() {
    this.stops++;
    if (this.stopSettles)
      queueMicrotask(() => {
        this.event('stopped');
        this.exit();
      });
  }
  complete() {
    this.event('completed');
    this.exit();
  }
  exit(changes: Partial<BackendSettlement> = {}) {
    this.settle({ workerExited: true, exitCode: 0, forcedTermination: false, protocolFault: false, ...changes });
  }
}
export class FakeBackend implements SpeechBackendPort {
  capabilities = capabilities;
  workers: FakeWorker[] = [];
  autoReady = true;
  startHook: ((w: FakeWorker) => void) | null = null;
  start(_plan: SpeechPlan, token: ExecutionToken, receive: (event: unknown) => void) {
    const w = new FakeWorker(token, receive, this.autoReady);
    this.workers.push(w);
    this.startHook?.(w);
    return w;
  }
}
export function fixture(
  options: {
    authority?: FakeAuthority;
    backend?: FakeBackend;
    gate?: FakeGate;
    now?: () => number;
    sink?: (r: TechnicalSpeechReceipt) => void | Promise<void>;
  } = {},
) {
  const authority = options.authority ?? new FakeAuthority(),
    backend = options.backend ?? new FakeBackend(),
    gate = options.gate ?? new FakeGate();
  const receipts: TechnicalSpeechReceipt[] = [];
  const controller = new SpeechController({
    backend,
    gate,
    authority,
    sink: {
      forward:
        options.sink ??
        ((r) => {
          receipts.push(r);
        }),
    },
    controllerBindingId: 'binding',
    mode: 'synthetic-test',
    ...(options.now ? { now: options.now } : {}),
  });
  return { authority, backend, gate, receipts, controller };
}
