import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { fail } from './validation.ts';

export const HYBRID_PROTOCOL = 'companion-hybrid-json-v1' as const;
export const HYBRID_LIMITS = Object.freeze({
  profileBytes: 8192,
  bindingBytes: 8192,
  requestBytes: 65536,
  responseBytes: 65536,
  evidenceCount: 16,
  sourceRefCount: 16,
  lifetimeRequestIds: 64,
  resultBytesPerRequest: 16384,
  ledgerBytes: 2097152,
  laneConcurrency: 1,
  queue: 0,
  defaultTimeoutMs: 10000,
  maxTimeoutMs: 30000,
});
export const HYBRID_QUALIFICATION = Object.freeze({
  identity: 'DECLARATION_ONLY',
  loadedModel: 'NOT_AUTHENTICATED',
  durableDedupe: 'NOT_SUPPORTED',
  coreWiring: 'PENDING_OWNER',
  tensorState: 'NOT_SUPPORTED',
  hardware: 'NOT_VALIDATED',
});

type Asset = Readonly<{ id: string; revision: string; sha256: string }>;
export type HybridModality = 'text' | 'image' | 'video' | 'audio';
export type HybridStateFamily = 'attention-kv' | 'ssm' | 'convolution' | 'position-prefix' | 'vision' | 'speculative';
export type HybridProfile = Readonly<{
  version: 1;
  profileId: string;
  model: Asset & Readonly<{ precision: string }>;
  tokenizer: Asset;
  processor: Asset;
  chatTemplateSha256: string;
  adapterSha256: string | null;
  routerAuxSha256: string | null;
  runtime: Readonly<{
    id: string;
    buildSha256: string;
    kernelSha256: string;
    cacheLayoutSha256: string;
    topologySha256: string;
  }>;
  modelModalities: readonly HybridModality[];
  stateFamilies: readonly HybridStateFamily[];
  protocol: typeof HYBRID_PROTOCOL;
}>;
export type HybridBinding = Readonly<{
  namespace: Readonly<{ tenantId: string; subjectId: string; personaId: string; relationshipId: string }>;
  scopeId: string;
  generation: number;
  consentRevision: number;
  runtimeEpoch: number;
  permissionEpoch: number;
  sessionId: string;
  purpose: 'memory-proposal';
  evaluationGroup: string;
  sourceRefs: readonly Readonly<{ id: string; revision: number }>[];
}>;
export type HybridLease = Readonly<{
  controllerId: string;
  leaseId: string;
  epoch: number;
  profileDigest: string;
  bindingDigest: string;
}>;

/** Reject proxies before reflection; never invoke user accessors or toJSON. */
export function hybridFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || types.isProxy(value) || Array.isArray(value))
    fail('HYBRID_WIRE_SHAPE');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail('HYBRID_WIRE_SHAPE');
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length || required.some((key) => !Object.hasOwn(value, key)))
    fail('HYBRID_WIRE_SHAPE');
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) fail('HYBRID_WIRE_SHAPE');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('HYBRID_WIRE_SHAPE');
    copy[key] = descriptor.value as unknown;
  }
  return copy;
}

export function hybridArray(value: unknown, max: number): unknown[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    fail('HYBRID_WIRE_SHAPE');
  const size = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (size < 1 || size > max || Reflect.ownKeys(value).length !== size + 1) fail('HYBRID_WIRE_SHAPE');
  const copy: unknown[] = [];
  for (let i = 0; i < size; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('HYBRID_WIRE_SHAPE');
    copy.push(descriptor.value as unknown);
  }
  return copy;
}

export function hybridId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    /[\ud800-\udfff]/u.test(value) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > 128
  )
    fail('HYBRID_INVALID_ID');
  return value;
}
export function hybridSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) fail('HYBRID_INVALID_SHA');
  return value;
}
export function hybridInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('HYBRID_INVALID_INTEGER');
  return value;
}
function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) fail('HYBRID_INVALID_REVISION');
  return value;
}
function nullableSha(value: unknown): string | null {
  return value === null ? null : hybridSha(value);
}
function asset(value: unknown): Asset {
  const a = hybridFields(value, ['id', 'revision', 'sha256']);
  return Object.freeze({ id: hybridId(a.id), revision: revision(a.revision), sha256: hybridSha(a.sha256) });
}
function orderedSet<T extends string>(value: unknown, order: readonly T[], required: readonly T[] = []): readonly T[] {
  const items = hybridArray(value, order.length);
  if (
    new Set(items).size !== items.length ||
    items.some((item) => !order.includes(item as T)) ||
    required.some((item) => !items.includes(item))
  )
    fail('HYBRID_WIRE_SHAPE');
  return Object.freeze(order.filter((item) => items.includes(item)));
}
/** Only call with module-built data whose descriptors have already been checked. */
export function hybridJson(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maxBytes) fail('HYBRID_BYTE_LIMIT');
  return json;
}
export function hybridDigest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateHybridProfile(value: unknown): HybridProfile {
  const p = hybridFields(value, [
    'version',
    'profileId',
    'model',
    'tokenizer',
    'processor',
    'chatTemplateSha256',
    'adapterSha256',
    'routerAuxSha256',
    'runtime',
    'modelModalities',
    'stateFamilies',
    'protocol',
  ]);
  if (p.version !== 1 || p.protocol !== HYBRID_PROTOCOL) fail('HYBRID_PROTOCOL_UNSUPPORTED');
  const m = hybridFields(p.model, ['id', 'revision', 'sha256', 'precision']);
  const r = hybridFields(p.runtime, ['id', 'buildSha256', 'kernelSha256', 'cacheLayoutSha256', 'topologySha256']);
  const result: HybridProfile = Object.freeze({
    version: 1,
    profileId: hybridId(p.profileId),
    model: Object.freeze({
      id: hybridId(m.id),
      revision: revision(m.revision),
      sha256: hybridSha(m.sha256),
      precision: hybridId(m.precision),
    }),
    tokenizer: asset(p.tokenizer),
    processor: asset(p.processor),
    chatTemplateSha256: hybridSha(p.chatTemplateSha256),
    adapterSha256: nullableSha(p.adapterSha256),
    routerAuxSha256: nullableSha(p.routerAuxSha256),
    runtime: Object.freeze({
      id: hybridId(r.id),
      buildSha256: hybridSha(r.buildSha256),
      kernelSha256: hybridSha(r.kernelSha256),
      cacheLayoutSha256: hybridSha(r.cacheLayoutSha256),
      topologySha256: hybridSha(r.topologySha256),
    }),
    modelModalities: orderedSet(p.modelModalities, ['text', 'image', 'video', 'audio']),
    stateFamilies: orderedSet(
      p.stateFamilies,
      ['attention-kv', 'ssm', 'convolution', 'position-prefix', 'vision', 'speculative'],
      ['attention-kv', 'ssm', 'convolution', 'position-prefix'],
    ),
    protocol: HYBRID_PROTOCOL,
  });
  hybridJson(result, HYBRID_LIMITS.profileBytes);
  return result;
}
export function validateHybridBinding(value: unknown): HybridBinding {
  const b = hybridFields(value, [
    'namespace',
    'scopeId',
    'generation',
    'consentRevision',
    'runtimeEpoch',
    'permissionEpoch',
    'sessionId',
    'purpose',
    'evaluationGroup',
    'sourceRefs',
  ]);
  const n = hybridFields(b.namespace, ['tenantId', 'subjectId', 'personaId', 'relationshipId']);
  if (b.purpose !== 'memory-proposal') fail('HYBRID_WIRE_SHAPE');
  const seen = new Set<string>();
  const sourceRefs = hybridArray(b.sourceRefs, HYBRID_LIMITS.sourceRefCount).map((value) => {
    const ref = hybridFields(value, ['id', 'revision']);
    const id = hybridId(ref.id);
    if (seen.has(id)) fail('HYBRID_DUPLICATE_SOURCE');
    seen.add(id);
    return Object.freeze({ id, revision: hybridInteger(ref.revision, 1) });
  });
  const result: HybridBinding = Object.freeze({
    namespace: Object.freeze({
      tenantId: hybridId(n.tenantId),
      subjectId: hybridId(n.subjectId),
      personaId: hybridId(n.personaId),
      relationshipId: hybridId(n.relationshipId),
    }),
    scopeId: hybridId(b.scopeId),
    generation: hybridInteger(b.generation),
    consentRevision: hybridInteger(b.consentRevision),
    runtimeEpoch: hybridInteger(b.runtimeEpoch),
    permissionEpoch: hybridInteger(b.permissionEpoch),
    sessionId: hybridId(b.sessionId),
    purpose: 'memory-proposal',
    evaluationGroup: hybridId(b.evaluationGroup),
    sourceRefs: Object.freeze(sourceRefs),
  });
  hybridJson(result, HYBRID_LIMITS.bindingBytes);
  return result;
}
export function profileDigest(profile: unknown): string {
  return hybridDigest(hybridJson(validateHybridProfile(profile), HYBRID_LIMITS.profileBytes));
}
export function bindingDigest(binding: unknown): string {
  return hybridDigest(hybridJson(validateHybridBinding(binding), HYBRID_LIMITS.bindingBytes));
}
export function validateHybridLease(value: unknown): HybridLease {
  const l = hybridFields(value, ['controllerId', 'leaseId', 'epoch', 'profileDigest', 'bindingDigest']);
  return Object.freeze({
    controllerId: hybridId(l.controllerId),
    leaseId: hybridId(l.leaseId),
    epoch: hybridInteger(l.epoch),
    profileDigest: hybridSha(l.profileDigest),
    bindingDigest: hybridSha(l.bindingDigest),
  });
}
