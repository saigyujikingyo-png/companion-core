import { randomUUID } from 'node:crypto';
import { EndogenousOwner } from './endogenous-lifecycle.ts';
import type { EndogenousDecisionPort, EndogenousEntry, EndogenousLimits, EndogenousSession } from './endogenous-lifecycle.ts';
import type { Scope } from './contracts.ts';
import { fail } from './validation.ts';

export const ENDOGENOUS_CONTROL_KEY = 'endogenous_control_v1';
const MAX_BYTES = 16_384;
type Stop = 'PAUSED' | 'RUNNING' | 'CLOSED' | 'EXHAUSTED' | 'FAULTED' | 'RECONCILE_REQUIRED' | 'FENCED';
export type EndogenousControl = {
  version: 1; revision: number; authorityId: string; vaultId: string; identity: string;
  scopeId: string; generation: number; consentRevision: number; runtimeEpoch: number;
  controlId: string; profile: 'rest-noop-v1'; limits: EndogenousLimits;
  expiresAt: number; runFence: number; stop: Stop; permitHeld: boolean; entries: EndogenousEntry[];
};
export type EndogenousIdentity = Pick<EndogenousControl, 'authorityId' | 'vaultId' | 'identity'>;
export type DurableEndogenousSession = EndogenousSession & { readControl(): EndogenousControl };
const safe = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const keys = (value: unknown, expected: string): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected.split(',').sort().join(',');
const codes = [null, 'JOURNAL', 'PAUSED', 'CLOSED', 'TIMEOUT', 'DURATION', 'CAPACITY', 'CLOCK',
  'PORT_THROW', 'PORT_REJECT', 'UNSUPPORTED_PROMISE', 'INVALID_DECISION'];

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
  if (!keys(r, 'version,revision,authorityId,vaultId,identity,scopeId,generation,consentRevision,runtimeEpoch,controlId,profile,limits,expiresAt,runFence,stop,permitHeld,entries')
    || r.version !== 1 || r.profile !== 'rest-noop-v1' || !safe(r.revision, 1) || !safe(r.generation)
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
      || !['PENDING','UNKNOWN','REST','NOOP'].includes(e.outcome as string) || !codes.includes(e.code as any)
      || ((e.outcome === 'PENDING' || e.outcome === 'REST' || e.outcome === 'NOOP') && e.code !== null)
      || (e.outcome === 'UNKNOWN' && e.code === null) || (e.outcome === 'PENDING' && i !== r.entries.length - 1)) fail('E1_CONTROL_INVALID');
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
export function newControl(identity: EndogenousIdentity, scope: Scope, now: number, limits?: Partial<EndogenousLimits>): EndogenousControl {
  const bounded = controlLimits(limits);
  return parseControl(encodeControl({ version: 1, revision: 1, authorityId: identity.authorityId, vaultId: identity.vaultId,
    identity: identity.identity, scopeId: scope.id, generation: scope.generation,
    consentRevision: scope.consentRevision, runtimeEpoch: scope.runtimeEpoch, controlId: randomUUID(), profile: 'rest-noop-v1',
    limits: bounded, expiresAt: now + bounded.maxDurationMs, runFence: 0, stop: 'PAUSED', permitHeld: false, entries: [] }));
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
export function bindControl(access: ControlAccess, identity: EndogenousIdentity, port: EndogenousDecisionPort,
  monotonic: () => number): { session: DurableEndogenousSession; owner: EndogenousOwner } {
  let encoded = access.read() ?? fail('E1_CONTROL_MISSING'), record = parseControl(encoded);
  assertControlIdentity(record, identity);
  if (!scopeMatches(record, access.scope(record.scopeId))) fail('E1_CONTROL_SCOPE');
  if (record.permitHeld || record.stop === 'RECONCILE_REQUIRED') fail('E1_RECONCILE_REQUIRED');
  if (['FENCED','FAULTED','EXHAUSTED'].includes(record.stop)) fail('E1_CONTROL_STOPPED');
  if (record.runFence >= 1024) fail('E1_BINDING_CAPACITY');
  record.runFence++; record.revision++; record.stop = 'PAUSED';
  let next = encodeControl(record); access.write(encoded, next); encoded = next;
  const sessionNumber = record.runFence;
  // A private sentinel distinguishes our normal deadline refusal from any failed persistence
  // callback (including one that happens to throw an identically named external error).
  const expired = new Error('E1_CONTROL_EXPIRED');
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
    if (live && now >= record.expiresAt) throw expired;
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
  const owner = new EndogenousOwner({ limits: record.limits, clock: monotonic,
    recovered: { controlId: record.controlId, entries: record.entries, session: sessionNumber,
      remainingMs: Math.max(0, record.expiresAt - access.now()) }, journal: {
      withReservedDispatch(entry, invoke) {
        let reserved = false;
        try {
          guarded(() => {
            const deadline = Math.min(validate(true, true) + record.limits.callTimeoutMs, record.expiresAt);
            if (record.permitHeld || !['PAUSED','RUNNING'].includes(record.stop) || entry.sequence !== record.entries.length + 1
              || record.entries.length >= record.limits.maxCalls || (record.entries.length + 1) * 256 > record.limits.maxResultBytes) fail('E1_CONTROL_RESERVATION');
            record.entries.push({ ...entry }); record.permitHeld = true; record.stop = 'RUNNING'; save(); reserved = true;
            // write() has returned through RAM COMMIT -> encrypted checkpoint -> authority finalize.
            if (validate(true, true) >= deadline) throw expired;
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
      terminal(entry) {
        guarded(() => {
          validate(true, true);
          const current = record.entries.at(-1);
          if (!current || current.decisionId !== entry.decisionId || current.outcome !== 'PENDING' || record.permitHeld
            || record.stop !== 'RUNNING') fail('E1_CONTROL_TERMINAL');
          record.entries[record.entries.length - 1] = { ...entry }; save();
          try { validate(true, true); }
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
          if (['FENCED','FAULTED','EXHAUSTED'].includes(record.stop)) return;
          record.entries = entries.map(e => ({ ...e }));
          record.stop = state === 'faulted' ? 'FAULTED' : state === 'exhausted' ? 'EXHAUSTED' : state === 'closed' ? 'CLOSED' : 'PAUSED';
          save();
        });
      },
    } });
  const bound = owner.bind(port);
  return { owner, session: Object.freeze({ ...bound, readControl: () => access.guard(() => {
    validate(false); return structuredClone(record);
  }) }) };
}
