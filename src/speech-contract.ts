import { createHash } from 'node:crypto';

export const SPEECH_LIMITS = Object.freeze({
  textBytes: 240,
  sourceRefs: 16,
  effects: 64,
  receipts: 8,
  utteranceMs: 5000,
  startupMs: 3000,
  stopMs: 500,
  exitMs: 1000,
  wireBytes: 16384,
});
export class SpeechError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'SpeechError';
    this.code = code;
  }
}
export type SpeechProfile = Readonly<{
  cognitiveBundleId: string;
  voiceBackendId: string;
  backendVersion: string;
  voiceProfileId: string;
  voiceTokenId: string;
  voiceRevision: number;
  locale: string;
  rate: number;
  volume: number;
  style: 'neutral';
  deviceTokenId: string;
  transportProfileId: string;
}>;
export type SpeechPlan = Readonly<{
  version: 1;
  effectNamespaceId: string;
  speechIntentId: string;
  utteranceId: string;
  hostId: string;
  sessionId: string;
  turnId: string;
  binding: Readonly<{
    scopeId: string;
    generation: number;
    consentRevision: number;
    runtimeEpoch: number;
    hostGeneration: number;
    permissionId: string;
    permissionEpoch: number;
    contextRevision: number;
    controllerBindingId: string;
  }>;
  sourceRefs: readonly Readonly<{ id: string; revision: number }>[];
  expression: Readonly<{
    kind: 'committed-expression';
    origin: 'host-committed' | 'synthetic-fixture';
    sha256: string;
    utf8Bytes: number;
  }>;
  profile: SpeechProfile;
  dispatchDeadlineMonotonicMs: number;
  maxUtteranceMs: number;
  chunk: Readonly<{ mode: 'whole-utterance'; index: 0; final: true }>;
}>;
export type SpeechCapabilities = Readonly<{
  backendId: string;
  backendVersion: string;
  kind: 'synthetic' | 'windows-sapi';
  profiles: readonly SpeechProfile[];
}>;
export type OutputLease = Readonly<{
  resourceKey: string;
  ownerInstanceId: string;
  leaseId: string;
  fencingGeneration: number;
}>;
export type ExecutionToken = Readonly<{
  effectKey: string;
  fingerprint: string;
  controllerGeneration: number;
  workerInstanceId: string;
  lease: OutputLease;
}>;
export type BackendEvent = Readonly<{
  token: ExecutionToken;
  sequence: number;
  kind: 'queued' | 'completed' | 'stopped' | 'fault';
  streamId: number;
  code: string;
}>;
export type BackendSettlement = Readonly<{
  workerExited: boolean;
  exitCode: number | null;
  forcedTermination: boolean;
  protocolFault: boolean;
}>;
export interface SpeechBackendOperation {
  readonly ready: Promise<void>;
  readonly settled: Promise<BackendSettlement>;
  /** Synchronous: after entry the command may have been written, even if this throws. */
  dispatch(text: string): void;
  /** Cleanup never needs current business permission. */
  stop(): void;
}
export interface SpeechBackendPort {
  readonly capabilities: SpeechCapabilities;
  start(plan: SpeechPlan, token: ExecutionToken, receive: (event: unknown) => void): SpeechBackendOperation;
}
export interface CurrentSpeechGate {
  /** Only literal true succeeds; promises, truthy objects and reentry fail closed. */
  check(plan: SpeechPlan): unknown;
  subscribeInvalidation(invalidate: () => void): () => void;
}
export interface SpeechClaimPort {
  claim(
    input: Readonly<{ effectKey: string; fingerprint: string; lease: OutputLease }>,
  ): Promise<Readonly<{ status: 'claimed' | 'existing' | 'conflict' | 'unknown' }>>;
}
export interface SpeechOutputLeasePort {
  acquire(input: Readonly<{ resourceKey: string; ownerInstanceId: string }>): Promise<OutputLease | null>;
  isCurrent(lease: OutputLease): unknown;
  /** Host must compare exact owner/fence and refuse releasing a newer lease. */
  release(
    lease: OutputLease,
    evidence: Readonly<{ bodyNeverDispatched: boolean; engineTerminalReported: boolean; workerExited: boolean }>,
  ): Promise<void>;
  /** UNKNOWN must persist until an independent host reconciliation; expiry is not reconciliation. */
  block(lease: OutputLease): void;
}
export type SpeechAuthority = Readonly<{
  assurance: 'synthetic-only' | 'host-durable';
  claims: SpeechClaimPort;
  output: SpeechOutputLeasePort;
}>;
export type SpeechOutcome =
  | 'failed_before_dispatch'
  | 'cancelled_before_dispatch'
  | 'backend_completed_reported'
  | 'stopped_reported'
  | 'unknown_after_dispatch';
export type ForwardingOutcome = 'not_attempted' | 'pending' | 'forwarded' | 'failed' | 'timed_out' | 'stale';
export type TechnicalSpeechReceipt = Readonly<{
  eventClass: 'technical-delivery';
  receiptId: string;
  effectKey: string;
  sequence: number;
  outcome: SpeechOutcome;
  code: string;
  deviceEvidence: 'not_observed';
  userAudibility: 'NOT_EVALUATED';
  userIntelligibility: 'NOT_EVALUATED';
  naturalness: 'NOT_EVALUATED';
}>;
export interface TechnicalReceiptSink {
  forward(receipt: TechnicalSpeechReceipt): void | Promise<void>;
}
export type SpeechSnapshot = Readonly<{
  effectKey: string;
  fingerprint: string;
  phase: 'planned' | 'queued' | 'claimed' | 'dispatching' | 'backend_queued' | 'terminal';
  outcome: SpeechOutcome | null;
  code: string;
  forwarding: ForwardingOutcome;
  workerExited: boolean;
  engineStoppedReported: boolean;
  forcedTermination: boolean;
  deviceSilenceObserved: false;
  rejectedEvents: number;
  firstRejectedEventCode: string | null;
  receipts: readonly TechnicalSpeechReceipt[];
}>;
export type SpeechOperation = Readonly<{ result: Promise<SpeechSnapshot>; snapshot(): SpeechSnapshot }>;
export type DetailedSpeechStop = Readonly<{
  requestAccepted: boolean;
  engineStoppedReported: boolean;
  workerExited: boolean;
  deviceSilenceObserved: false;
}>;

export function speechHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function speechFail(code: string): never {
  throw new SpeechError(code);
}
/** Closed data records: no accessors, inherited fields, symbols or hidden payload. */
export function speechObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  )
    speechFail('INVALID_SHAPE');
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((k) => typeof k !== 'string' || !keys.includes(k)))
    speechFail('INVALID_SHAPE');
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || !('value' in d) || !d.enumerable) speechFail('INVALID_SHAPE');
  }
  return value as Record<string, unknown>;
}
export function speechString(value: unknown, max = 128): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    Buffer.byteLength(value, 'utf8') > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    speechFail('INVALID_STRING');
  return value;
}
export function speechInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    speechFail('INVALID_NUMBER');
  return value;
}
export function canonicalSpeech(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalSpeech).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalSpeech((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const profileKeys = [
  'cognitiveBundleId',
  'voiceBackendId',
  'backendVersion',
  'voiceProfileId',
  'voiceTokenId',
  'voiceRevision',
  'locale',
  'rate',
  'volume',
  'style',
  'deviceTokenId',
  'transportProfileId',
] as const;
export function validateSpeechProfile(value: unknown): SpeechProfile {
  const p = speechObject(value, profileKeys);
  for (const k of profileKeys)
    if (!['voiceRevision', 'rate', 'volume'].includes(k)) speechString(p[k], k.endsWith('TokenId') ? 2048 : 128);
  speechInteger(p.voiceRevision);
  speechInteger(p.rate, -10, 10);
  speechInteger(p.volume, 0, 100);
  if (p.style !== 'neutral') speechFail('UNSUPPORTED_STYLE');
  return Object.freeze({ ...p }) as SpeechProfile;
}
export function prepareSpeechPlan(value: unknown, text: string, capabilities: SpeechCapabilities): SpeechPlan {
  const p = speechObject(value, [
    'version',
    'effectNamespaceId',
    'speechIntentId',
    'utteranceId',
    'hostId',
    'sessionId',
    'turnId',
    'binding',
    'sourceRefs',
    'expression',
    'profile',
    'dispatchDeadlineMonotonicMs',
    'maxUtteranceMs',
    'chunk',
  ]);
  if (
    p.version !== 1 ||
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > SPEECH_LIMITS.textBytes ||
    text.includes('\0') ||
    Buffer.from(text, 'utf8').toString('utf8') !== text
  )
    speechFail('INVALID_EXPRESSION');
  for (const k of ['effectNamespaceId', 'speechIntentId', 'utteranceId', 'hostId', 'sessionId', 'turnId'])
    speechString(p[k]);
  const b = speechObject(p.binding, [
    'scopeId',
    'generation',
    'consentRevision',
    'runtimeEpoch',
    'hostGeneration',
    'permissionId',
    'permissionEpoch',
    'contextRevision',
    'controllerBindingId',
  ]);
  for (const k of ['scopeId', 'permissionId', 'controllerBindingId']) speechString(b[k]);
  for (const k of [
    'generation',
    'consentRevision',
    'runtimeEpoch',
    'hostGeneration',
    'permissionEpoch',
    'contextRevision',
  ])
    speechInteger(b[k]);
  if (!Array.isArray(p.sourceRefs) || p.sourceRefs.length < 1 || p.sourceRefs.length > SPEECH_LIMITS.sourceRefs)
    speechFail('SOURCE_LIMIT');
  if (
    Object.getPrototypeOf(p.sourceRefs) !== Array.prototype ||
    Reflect.ownKeys(p.sourceRefs).length !== p.sourceRefs.length + 1
  )
    speechFail('INVALID_SOURCE_ARRAY');
  for (let i = 0; i < p.sourceRefs.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(p.sourceRefs, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) speechFail('INVALID_SOURCE_ARRAY');
  }
  const ids = new Set<string>();
  const refs = p.sourceRefs.map((r: unknown) => {
    const ref = speechObject(r, ['id', 'revision']);
    const id = speechString(ref.id);
    if (ids.has(id)) speechFail('DUPLICATE_SOURCE');
    ids.add(id);
    return Object.freeze({ id, revision: speechInteger(ref.revision) });
  });
  const e = speechObject(p.expression, ['kind', 'origin', 'sha256', 'utf8Bytes']);
  const size = Buffer.byteLength(text, 'utf8');
  if (
    e.kind !== 'committed-expression' ||
    !['host-committed', 'synthetic-fixture'].includes(e.origin as string) ||
    size > SPEECH_LIMITS.textBytes ||
    e.utf8Bytes !== size ||
    e.sha256 !== speechHash(text)
  )
    speechFail('EXPRESSION_MISMATCH');
  const c = speechObject(p.chunk, ['mode', 'index', 'final']);
  if (c.mode !== 'whole-utterance' || c.index !== 0 || c.final !== true) speechFail('UNSUPPORTED_CHUNK');
  speechInteger(p.dispatchDeadlineMonotonicMs);
  speechInteger(p.maxUtteranceMs, 1, SPEECH_LIMITS.utteranceMs);
  const profile = validateSpeechProfile(p.profile);
  if (
    profile.voiceBackendId !== capabilities.backendId ||
    profile.backendVersion !== capabilities.backendVersion ||
    !capabilities.profiles.some((v) => canonicalSpeech(validateSpeechProfile(v)) === canonicalSpeech(profile))
  )
    speechFail('UNSUPPORTED_PROFILE');
  return Object.freeze({
    ...p,
    binding: Object.freeze({ ...b }),
    sourceRefs: Object.freeze(refs),
    expression: Object.freeze({ ...e }),
    profile,
    chunk: Object.freeze({ ...c }),
  }) as SpeechPlan;
}
/** C002: utterance, epoch and turn belong to the fingerprint, never to the stable key. */
export function speechEffectKey(plan: SpeechPlan): string {
  return speechHash(canonicalSpeech([plan.effectNamespaceId, plan.speechIntentId]));
}
export function speechResourceKey(plan: SpeechPlan): string {
  return speechHash(canonicalSpeech([plan.hostId, plan.profile.deviceTokenId]));
}
export function validateOutputLease(value: unknown, resourceKey: string, ownerInstanceId: string): OutputLease {
  const l = speechObject(value, ['resourceKey', 'ownerInstanceId', 'leaseId', 'fencingGeneration']);
  if (l.resourceKey !== resourceKey || l.ownerInstanceId !== ownerInstanceId) speechFail('LEASE_IDENTITY');
  speechString(l.leaseId);
  speechInteger(l.fencingGeneration);
  return Object.freeze({ ...l }) as OutputLease;
}
