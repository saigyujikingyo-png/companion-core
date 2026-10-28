import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { EndogenousOwner } from './endogenous-lifecycle.ts';
import type { EndogenousDecisionPort, EndogenousEntry, EndogenousLimits, EndogenousSession, EndogenousProfile,
  EndogenousTextPort, AcceptedEndogenousText, EndogenousSettlement, EndogenousMessageSession } from './endogenous-lifecycle.ts';
import type { Scope } from './contracts.ts';
import { fail } from './validation.ts';

export const ENDOGENOUS_CONTROL_KEY = 'endogenous_control_v1';
const MAX_BYTES = 16_384;
type Stop = 'PAUSED' | 'RUNNING' | 'CLOSED' | 'EXHAUSTED' | 'FAULTED' | 'RECONCILE_REQUIRED' | 'FENCED';
export type EndogenousControl = {
  version: 1; revision: number; authorityId: string; vaultId: string; identity: string;
  scopeId: string; generation: number; consentRevision: number; runtimeEpoch: number;
  controlId: string; profile: EndogenousProfile; limits: EndogenousLimits;
  expiresAt: number; runFence: number; stop: Stop; permitHeld: boolean; entries: EndogenousEntry[];
  /** Present only on the explicitly selected single-message profile. Never contains text. */
  inbound?: { keyDigest: string; fingerprint: string; expiresAt: number; sequence: null | 1 } | null;
};
export type MessageBinding = Readonly<{ origin: string; route: string }>;
export type MessageInput = Readonly<{ messageId: string; text: string; expiresAt: number }>;
export type MessageReceipt = Readonly<{ kind: 'MESSAGE_RECEIVED'; prototype: 'SINGLE_MESSAGE_CONTROL_PROTOTYPE';
  controlId: string; metadata: 'durable'; body: 'volatile'; expiresAt: number; decisionId: string | null;
  consideration: 'NOT_CONSIDERED' | 'NOT_CONSIDERED_UNAVAILABLE' | EndogenousEntry['outcome'] }>;
export type DurableMessageSession = Pick<DurableEndogenousSession, 'pause' | 'close' | 'read' | 'readControl'> & {
  receive(input: MessageInput): { receipt: MessageReceipt; fresh: boolean };
  consider(): void;
  receipt(): MessageReceipt | null;
};
export type EndogenousIdentity = Pick<EndogenousControl, 'authorityId' | 'vaultId' | 'identity'>;
export type DurableEndogenousSession = EndogenousSession & { readControl(): EndogenousControl };
/** Ephemeral local capability; neither text nor the validator is serialized. */
export type DurableAcceptedEndogenousText = AcceptedEndogenousText & Readonly<{ validateDelivery(): true }>;
export type DurableTextAcceptance = (accepted: DurableAcceptedEndogenousText) => unknown;
const safe = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const keys = (value: unknown, expected: string): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected.split(',').sort().join(',');
const codes = [null, 'JOURNAL', 'PAUSED', 'CLOSED', 'TIMEOUT', 'DURATION', 'CAPACITY', 'CLOCK',
  'PORT_THROW', 'PORT_REJECT', 'UNSUPPORTED_PROMISE', 'INVALID_DECISION'];
export function messageString(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxBytes || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maxBytes || Buffer.from(value, 'utf8').toString('utf8') !== value) fail('E3_INVALID_MESSAGE');
}
export function copyMessageInput(input: unknown): MessageInput {
  if (input === null || typeof input !== 'object' || isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('E3_INVALID_MESSAGE');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== 3 || !['messageId','text','expiresAt'].every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key]!, 'value'))) fail('E3_INVALID_MESSAGE');
  const messageId: unknown = descriptors.messageId!.value, text: unknown = descriptors.text!.value, expiresAt: unknown = descriptors.expiresAt!.value;
  messageString(messageId, 128); messageString(text, 4096);
  if (!safe(expiresAt, 1)) fail('E3_INVALID_MESSAGE');
  return Object.freeze({ messageId, text, expiresAt });
}

export function controlLimits(input: Partial<EndogenousLimits> = {}): EndogenousLimits {
  const limits = { maxCalls: 16, maxDurationMs: 60_000, callTimeoutMs: 5_000, maxResultBytes: 4096, ...input };
  if (!keys(limits, 'maxCalls,maxDurationMs,callTimeoutMs,maxResultBytes') || !safe(limits.maxCalls, 1, 64)
    || !safe(limits.maxDurationMs, 10, 300_000) || !safe(limits.callTimeoutMs, 1, 30_000)
    || limits.callTimeoutMs > limits.maxDurationMs || !safe(limits.maxResultBytes, 256, 16_384)) fail('E1_INVALID_LIMITS');
  return limits;
}
export function parseControl(encoded: string): EndogenousControl {
  if (typeof encoded !== 'string' || encoded.length > MAX_BYTES || Buffer.byteLength(encoded) > MAX_BYTES) fail('E1_CONTROL_LIMIT');
  let r: any;
  try { r = JSON.parse(encoded); } catch { fail('E1_CONTROL_INVALID'); }
  if (!keys(r, 'version,revision,authorityId,vaultId,identity,scopeId,generation,consentRevision,runtimeEpoch,controlId,profile,limits,expiresAt,runFence,stop,permitHeld,entries'
      + (r?.profile === 'message-choice-v1' ? ',inbound' : ''))
    || r.version !== 1 || !['rest-noop-v1','text-choice-v1','message-choice-v1'].includes(r.profile as string) || !safe(r.revision, 1) || !safe(r.generation)
    || !safe(r.consentRevision) || !safe(r.runtimeEpoch) || !safe(r.expiresAt, 1) || !safe(r.runFence, 0, 1024)
    || typeof r.permitHeld !== 'boolean' || !['PAUSED','RUNNING','CLOSED','EXHAUSTED','FAULTED','RECONCILE_REQUIRED','FENCED'].includes(r.stop as string)
    || !Array.isArray(r.entries) || r.entries.length > 64) fail('E1_CONTROL_INVALID');
  for (const name of ['authorityId','vaultId','identity','scopeId','controlId']) {
    if (typeof r[name] !== 'string' || !r[name].length || Buffer.byteLength(r[name]) > 512) fail('E1_CONTROL_INVALID');
  }
  if ((r.scopeId as string).length > 128 || (r.scopeId as string).includes('\0')) fail('E1_CONTROL_INVALID');
  if (!/^[0-9a-f-]{36}$/.test(r.controlId as string)) fail('E1_CONTROL_INVALID');
  const limits = controlLimits(r.limits as EndogenousLimits);
  if (!keys(r.limits, 'maxCalls,maxDurationMs,callTimeoutMs,maxResultBytes')
    || r.entries.length > limits.maxCalls || r.entries.length * 256 > limits.maxResultBytes) fail('E1_CONTROL_INVALID');
  for (const [i, e] of r.entries.entries()) {
    if (!keys(e, 'decisionId,session,sequence,outcome,code') || e.decisionId !== `${r.controlId}:${i + 1}`
      || e.sequence !== i + 1 || !safe(e.session, 1, r.runFence as number)
      || !['PENDING','UNKNOWN','REST','NOOP',...(r.profile !== 'rest-noop-v1' ? ['TEXT'] : [])].includes(e.outcome as string) || !codes.includes(e.code as any)
      || ((e.outcome === 'PENDING' || e.outcome === 'REST' || e.outcome === 'NOOP' || e.outcome === 'TEXT') && e.code !== null)
      || (e.outcome === 'UNKNOWN' && e.code === null) || (e.outcome === 'PENDING' && i !== r.entries.length - 1)) fail('E1_CONTROL_INVALID');
  }
  if (r.profile === 'message-choice-v1') {
    if (limits.maxCalls !== 1 || r.entries.length > 1) fail('E1_CONTROL_INVALID');
    const m = r.inbound;
    if (m !== null && (!keys(m, 'keyDigest,fingerprint,expiresAt,sequence')
      || typeof m.keyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(m.keyDigest)
      || typeof m.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(m.fingerprint)
      || !safe(m.expiresAt, 1) || (m.sequence !== null && m.sequence !== 1))) fail('E1_CONTROL_INVALID');
    if ((m?.sequence === 1) !== (r.entries.length === 1)) fail('E1_CONTROL_INVALID');
  }
  if (r.permitHeld && !r.entries.length) fail('E1_CONTROL_INVALID');
  return r as EndogenousControl;
}
export function encodeControl(record: EndogenousControl): string {
  const encoded = JSON.stringify(record); parseControl(encoded); return encoded;
}
export function assertControlIdentity(r: EndogenousControl, identity: EndogenousIdentity): void {
  if (r.authorityId !== identity.authorityId || r.vaultId !== identity.vaultId || r.identity !== identity.identity) fail('E1_CONTROL_IDENTITY');
}
export function scopeMatches(r: EndogenousControl, s: Scope): boolean {
  return r.scopeId === s.id && r.generation === s.generation && r.consentRevision === s.consentRevision && r.runtimeEpoch === s.runtimeEpoch;
}
function unknown(r: EndogenousControl): void {
  r.entries = r.entries.map(e => e.outcome === 'PENDING' ? { ...e, outcome: 'UNKNOWN', code: 'JOURNAL' } : e);
}
/** Called only by AnchoredVault, before MemoryStore increments every scope runtime. */
export function bootControl(encoded: string, scope: (id: string) => Scope, identity: EndogenousIdentity): string {
  const r = parseControl(encoded); assertControlIdentity(r, identity);
  if (!scopeMatches(r, scope(r.scopeId))) fail('E1_CONTROL_SCOPE');
  if (r.entries.some(e => e.outcome === 'PENDING')) { unknown(r); r.permitHeld = true; }
  r.stop = r.permitHeld ? 'RECONCILE_REQUIRED' : ['FAULTED','FENCED','EXHAUSTED'].includes(r.stop) ? r.stop : 'PAUSED';
  r.runtimeEpoch++; r.revision++; r.runFence++;
  return encodeControl(r);
}
/** Revocations retain the original binding and all consumed resources. No implicit reauthorization. */
export function fenceControl(encoded: string, scope: (id: string) => Scope): string {
  const r = parseControl(encoded);
  if (scopeMatches(r, scope(r.scopeId)) || r.stop === 'FENCED') return encoded;
  unknown(r); r.stop = 'FENCED'; r.revision++;
  return encodeControl(r);
}
export function newControl(identity: EndogenousIdentity, scope: Scope, now: number, limits?: Partial<EndogenousLimits>, profile: EndogenousProfile = 'rest-noop-v1'): EndogenousControl {
  const bounded = controlLimits(profile === 'message-choice-v1' ? { maxCalls: 1, maxResultBytes: 256, ...limits } : limits);
  return parseControl(encodeControl({ version: 1, revision: 1, authorityId: identity.authorityId, vaultId: identity.vaultId,
    identity: identity.identity, scopeId: scope.id, generation: scope.generation,
    consentRevision: scope.consentRevision, runtimeEpoch: scope.runtimeEpoch, controlId: randomUUID(), profile,
    limits: bounded, expiresAt: now + bounded.maxDurationMs, runFence: 0, stop: 'PAUSED', permitHeld: false, entries: [],
    ...(profile === 'message-choice-v1' ? { inbound: null } : {}) }));
}

/** Preflight the complete future record before admitting a message or consuming its call. */
export function assertMessageCapacity(record: EndogenousControl): void {
  if (record.profile !== 'message-choice-v1' || !record.inbound) fail('E3_MESSAGE_REQUIRED');
  const future = structuredClone(record);
  future.revision = Number.MAX_SAFE_INTEGER; future.runtimeEpoch = Number.MAX_SAFE_INTEGER; future.runFence = 1024;
  future.generation = Number.MAX_SAFE_INTEGER; future.consentRevision = Number.MAX_SAFE_INTEGER;
  future.expiresAt = Number.MAX_SAFE_INTEGER; future.inbound!.expiresAt = Number.MAX_SAFE_INTEGER; future.inbound!.sequence = 1;
  future.stop = 'RECONCILE_REQUIRED'; future.permitHeld = true;
  future.entries = [{ decisionId: `${future.controlId}:1`, session: 1024, sequence: 1, outcome: 'UNKNOWN', code: 'UNSUPPORTED_PROMISE' }];
  encodeControl(future);
}

/** Capability supplied solely by the live AnchoredVault; methods are synchronous and guarded. */
export type ControlAccess = {
  guard<T>(body: () => T): T;
  read(): string | null;
  write(expected: string | null, next: string): void;
  scope(id: string): Scope;
  now(): number;
  assertCurrent(): void;
  poison(): void;
};
export function bindControl(access: ControlAccess, identity: EndogenousIdentity, port: EndogenousDecisionPort | EndogenousTextPort,
  monotonic: () => number, profile: EndogenousProfile = 'rest-noop-v1', acceptText?: DurableTextAcceptance,
  settled?: EndogenousSettlement, message?: MessageBinding & { digest(value: unknown): string; onRevoke?: () => void }, expectedScope?: Scope):
  { session: DurableEndogenousSession; owner: EndogenousOwner; messageSession?: DurableMessageSession } {
  let encoded = access.read() ?? fail('E1_CONTROL_MISSING'), record = parseControl(encoded);
  assertControlIdentity(record, identity);
  if (record.profile !== profile) fail('E1_CONTROL_PROFILE');
  // Host delivery and control consumption must name the same scope/epoch. This
  // check runs in the Vault guard, before runFence/write or owner occupation.
  if (expectedScope && !scopeMatches(record, expectedScope)) fail('E1_CONTROL_SCOPE');
  if (!scopeMatches(record, access.scope(record.scopeId))) fail('E1_CONTROL_SCOPE');
  const messageReadOnly = profile === 'message-choice-v1' && (record.permitHeld || ['RECONCILE_REQUIRED','EXHAUSTED'].includes(record.stop));
  if (!messageReadOnly && (record.permitHeld || record.stop === 'RECONCILE_REQUIRED')) fail('E1_RECONCILE_REQUIRED');
  if (['FENCED','FAULTED'].includes(record.stop) || (!messageReadOnly && record.stop === 'EXHAUSTED')) fail('E1_CONTROL_STOPPED');
  if (profile === 'message-choice-v1') { if (!message) fail('E3_BINDING_REQUIRED'); messageString(message.origin, 128); messageString(message.route, 128); }
  if (record.runFence >= 1024) fail('E1_BINDING_CAPACITY');
  record.runFence++; record.revision++; if (!messageReadOnly) record.stop = 'PAUSED';
  let next = encodeControl(record); access.write(encoded, next); encoded = next;
  const sessionNumber = record.runFence;
  // A private sentinel distinguishes our normal deadline refusal from any failed persistence
  // callback (including one that happens to throw an identically named external error).
  const expired = new Error('E1_CONTROL_EXPIRED');
  let lastMonotonic = monotonic();
  let liveAdmission = false, messageDeadline: number | null = null;
  const messageNow = () => {
    const now = monotonic();
    if (!Number.isFinite(now) || now < lastMonotonic || now < 0) { access.poison(); fail('E1_CLOCK'); }
    lastMonotonic = now; return now;
  };
  const retireAdmission = (now: number) => {
    if (liveAdmission && (now >= record.expiresAt || now >= record.inbound!.expiresAt || messageNow() >= messageDeadline!)) {
      liveAdmission = false; message?.onRevoke?.();
    }
  };
  const checkDeadline = (deadline: number | undefined) => {
    if (deadline === undefined) return;
    const now = monotonic();
    if (!Number.isFinite(now) || now < lastMonotonic || now < 0) { access.poison(); fail('E1_CLOCK'); }
    lastMonotonic = now;
    if (now >= deadline) throw expired;
  };
  const validate = (scopeRequired = true, live = false) => {
    access.assertCurrent();
    const actual = access.read();
    if (actual !== encoded) {
      // The Store's only permitted external transition retains identity, run fence and consumption.
      // Its synchronous revocation already cancelled this owner. Only its raw observer may adopt it.
      const fenced = structuredClone(record); unknown(fenced); fenced.stop = 'FENCED'; fenced.revision++;
      if (scopeRequired || actual !== encodeControl(fenced)) fail('E1_CONTROL_CAS');
      record = fenced; encoded = actual;
    }
    if (scopeRequired && !scopeMatches(record, access.scope(record.scopeId))) fail('E1_CONTROL_SCOPE');
    const now = access.now();
    if (live && (now >= record.expiresAt || (profile === 'message-choice-v1' && record.inbound && now >= record.inbound.expiresAt))) throw expired;
    return now;
  };
  const save = () => {
    record.revision++;
    const next = encodeControl(record); access.write(encoded, next); encoded = next;
  };
  const guarded = (body: () => void) => {
    try { access.guard(body); }
    catch (error) {
      if (error === expired) {
        try {
          // The reservation, if any, is already committed. Stop in a fresh exact-head guard;
          // retain held and all consumption. An uncertain stop write still poisons the vault.
          access.guard(() => { validate(false); unknown(record); record.stop = 'EXHAUSTED'; save(); });
        } catch (stopError) { access.poison(); throw stopError; }
      } else access.poison();
      throw error;
    }
  };
  const owner = new EndogenousOwner({ limits: record.limits, clock: monotonic, profile,
    ...(profile === 'message-choice-v1' ? { stopped: () => { liveAdmission = false; message?.onRevoke?.(); } } : {}),
    ...(settled ? { settled } : {}),
    ...(acceptText ? { acceptText: (accepted: AcceptedEndogenousText) => acceptText(Object.freeze({ ...accepted,
      validateDelivery: (): true => {
        accepted.validateAcceptance();
        return access.guard(() => {
        // Read-only acceptance proof. Expired/revoked delivery is not uncertain storage.
        validate(true, true); checkDeadline(accepted.deadlineMonotonicMs);
        const entry = record.entries[accepted.sequence - 1];
        if (entry?.decisionId !== accepted.decisionId || entry.outcome !== 'TEXT' || entry.session !== sessionNumber) fail('E2_STALE');
        accepted.validateAcceptance();
        return true;
        });
      } })) } : {}),
    recovered: { controlId: record.controlId, entries: record.entries, session: sessionNumber,
      remainingMs: Math.max(0, record.expiresAt - access.now()) }, journal: {
      withReservedDispatch(entry, invoke, originalDeadline) {
        let reserved = false;
        try {
          guarded(() => {
            const deadline = Math.min(validate(true, true) + record.limits.callTimeoutMs, record.expiresAt,
              profile === 'message-choice-v1' ? record.inbound?.expiresAt ?? 0 : Infinity);
            if (profile === 'message-choice-v1') {
              checkDeadline(originalDeadline);
              if (!liveAdmission || !record.inbound || record.inbound.sequence !== null || entry.sequence !== 1) fail('E3_CONSIDER_UNAVAILABLE');
              assertMessageCapacity(record);
            }
            if (record.permitHeld || !['PAUSED','RUNNING'].includes(record.stop) || entry.sequence !== record.entries.length + 1
              || record.entries.length >= record.limits.maxCalls || (record.entries.length + 1) * 256 > record.limits.maxResultBytes) fail('E1_CONTROL_RESERVATION');
            if (profile === 'message-choice-v1') record.inbound!.sequence = 1;
            record.entries.push({ ...entry }); record.permitHeld = true; record.stop = 'RUNNING'; save(); reserved = true;
            // write() has returned through RAM COMMIT -> encrypted checkpoint -> authority finalize.
            if (validate(true, true) >= deadline) throw expired;
            if (profile === 'message-choice-v1') checkDeadline(originalDeadline);
            invoke();
          });
          return 'DISPATCHED';
        } catch (error) {
          if (error === expired) return reserved ? 'STOPPED_RESERVED' : 'STOPPED_UNRESERVED';
          throw error;
        }
      },
      observeActualSettled(entry) {
        guarded(() => {
          // Only this original live observer can release a permit. Scope changes still fence results.
          validate(false);
          if (record.entries.at(-1)?.decisionId !== entry.decisionId || !record.permitHeld) fail('E1_CONTROL_SETTLEMENT');
          record.permitHeld = false; save();
        });
      },
      validateCurrent(deadline) {
        guarded(() => { validate(true, true); checkDeadline(deadline); });
      },
      terminal(entry, deadline) {
        guarded(() => {
          validate(true, true); checkDeadline(deadline);
          const current = record.entries.at(-1);
          if (!current || current.decisionId !== entry.decisionId || current.outcome !== 'PENDING' || record.permitHeld
            || record.stop !== 'RUNNING') fail('E1_CONTROL_TERMINAL');
          record.entries[record.entries.length - 1] = { ...entry }; save();
          try { validate(true, true); checkDeadline(deadline); }
          catch (error) {
            // The result is not accepted until this hook returns. If its commit used the
            // remaining time, the durable stop must retain UNKNOWN, not an accepted result.
            if (error === expired) record.entries[record.entries.length - 1] = { ...current, outcome: 'UNKNOWN', code: 'JOURNAL' };
            throw error;
          }
        });
      },
      stop(entries, state) {
        guarded(() => {
          validate(false);
          if (entries.length !== record.entries.length) fail('E1_CONTROL_CAS');
          if (messageReadOnly || ['FENCED','FAULTED','EXHAUSTED'].includes(record.stop)) return;
          record.entries = entries.map(e => ({ ...e }));
          record.stop = state === 'faulted' ? 'FAULTED' : state === 'exhausted' ? 'EXHAUSTED' : state === 'closed' ? 'CLOSED' : 'PAUSED';
          save();
        });
      },
    } });
  if (profile === 'message-choice-v1') {
    const bound: EndogenousMessageSession = owner.bindMessage(port as EndogenousTextPort);
    const receipt = (): MessageReceipt | null => {
      const inbound = record.inbound;
      if (!inbound) return null;
      return Object.freeze({ kind: 'MESSAGE_RECEIVED', prototype: 'SINGLE_MESSAGE_CONTROL_PROTOTYPE', controlId: record.controlId,
        metadata: 'durable', body: 'volatile', expiresAt: inbound.expiresAt,
        decisionId: inbound.sequence === null ? null : `${record.controlId}:1`,
        consideration: inbound.sequence === null ? liveAdmission ? 'NOT_CONSIDERED' : 'NOT_CONSIDERED_UNAVAILABLE'
          : record.entries[0]!.outcome });
    };
    const readControl = () => access.guard(() => { validate(false); return structuredClone(record); });
    const messageSession: DurableMessageSession = Object.freeze({ read: bound.read, readControl,
      receipt: () => access.guard(() => { retireAdmission(validate(false)); return receipt(); }),
      receive: (input: MessageInput) => {
        input = copyMessageInput(input);
        // Runtime changes cannot change an old message's fingerprint or refill its RAM body.
        const binding = [record.authorityId, record.vaultId, record.identity, record.scopeId,
          record.generation, record.consentRevision, record.controlId, message!.origin, message!.route];
        const keyDigest = message!.digest(['message-key-v1', message!.origin, message!.route, input.messageId]);
        const fingerprint = message!.digest(['message-payload-v1', binding, input.text, input.expiresAt]);
        // Sample monotonic BEFORE the guarded wall/currentness reads: elapsed guard
        // time must never be added to the absolute message expiry.
        const before = messageNow();
        return access.guard(() => {
          const now = validate(false);
          retireAdmission(now);
          if (record.inbound) {
            if (record.inbound.keyDigest !== keyDigest) fail('E3_MESSAGE_SLOT_OCCUPIED');
            if (record.inbound.fingerprint !== fingerprint) fail('E3_IDEMPOTENCY_CONFLICT');
            return { receipt: receipt()!, fresh: false };
          }
          validate(true, true);
          if (messageReadOnly || record.stop !== 'PAUSED' || !['created','paused'].includes(bound.read().state)) fail('E3_RECEIVE_UNAVAILABLE');
          if (now >= input.expiresAt) fail('E3_MESSAGE_EXPIRED');
          const deadline = before + (Math.min(input.expiresAt, record.expiresAt) - now);
          const candidate = { ...record, inbound: { keyDigest, fingerprint, expiresAt: input.expiresAt, sequence: null } };
          assertMessageCapacity(candidate);
          record = candidate;
          try { save(); } catch (error) { access.poison(); throw error; }
          validate(true, true); checkDeadline(deadline);
          messageDeadline = deadline; liveAdmission = true;
          return { receipt: receipt()!, fresh: true };
        });
      },
      consider: () => {
        const started = messageNow();
        access.guard(() => {
          retireAdmission(validate(false)); validate(true, true);
          if (!liveAdmission || messageDeadline === null || record.inbound?.sequence !== null || record.entries.length || messageReadOnly)
            fail('E3_CONSIDER_UNAVAILABLE');
          checkDeadline(messageDeadline);
        });
        try { bound.consider(Math.min(messageDeadline!, started + record.limits.callTimeoutMs)); } finally { liveAdmission = false; }
      },
      pause: () => { liveAdmission = false; bound.pause(); },
      close: () => { liveAdmission = false; bound.close(); },
    });
    return { owner, messageSession, session: Object.freeze({ ...bound, readControl,
      start: () => fail('E3_EXPLICIT_CONSIDER_REQUIRED'), resume: () => fail('E3_EXPLICIT_CONSIDER_REQUIRED') }) };
  }
  const bound = profile === 'text-choice-v1' ? owner.bindText(port as EndogenousTextPort) : owner.bind(port as EndogenousDecisionPort);
  return { owner, session: Object.freeze({ ...bound, readControl: () => access.guard(() => {
    validate(false); return structuredClone(record);
  }) }) };
}
