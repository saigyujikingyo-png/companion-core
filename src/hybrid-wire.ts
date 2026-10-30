import { types } from 'node:util';
import type { Evidence, Proposal } from './contracts.ts';
import { evidence, fail } from './validation.ts';
import { wireProposal } from './wire.ts';
import {
  HYBRID_LIMITS,
  bindingDigest,
  hybridArray,
  hybridFields,
  hybridId,
  hybridJson,
  hybridSha,
  validateHybridBinding,
  validateHybridLease,
} from './hybrid-profile.ts';
import type { HybridBinding, HybridLease } from './hybrid-profile.ts';

export type HybridRequest = {
  requestId: string;
  lease: HybridLease;
  profileDigest: string;
  binding: HybridBinding;
  selectedEvidence: readonly Evidence[];
};
export type HybridReply = { contentType: string; body: Uint8Array };
export type HybridReplyIdentity = Pick<HybridRequest, 'requestId' | 'lease' | 'profileDigest'>;

export function copyHybridEvidence(value: unknown, binding: HybridBinding): readonly Evidence[] {
  const values = hybridArray(value, HYBRID_LIMITS.evidenceCount);
  if (values.length !== binding.sourceRefs.length) fail('HYBRID_SOURCE_MISMATCH');
  return Object.freeze(
    values.map((value) => {
      const e = hybridFields(value, ['speakerId', 'speakerRole', 'mode', 'selectedText', 'occurredAt']);
      // Evidence has no source ID: its positional association is supplied by the trusted caller.
      return Object.freeze(evidence(e as Evidence, binding.namespace.subjectId));
    }),
  );
}
export function encodeHybridRequest(value: unknown): Uint8Array {
  const r = hybridFields(value, ['requestId', 'lease', 'profileDigest', 'binding', 'selectedEvidence']);
  const binding = validateHybridBinding(r.binding),
    lease = validateHybridLease(r.lease);
  const digest = hybridSha(r.profileDigest);
  if (lease.profileDigest !== digest || lease.bindingDigest !== bindingDigest(binding))
    fail('HYBRID_IDENTITY_MISMATCH');
  const request = {
    version: 1,
    kind: 'memory-proposal',
    requestId: hybridId(r.requestId),
    lease,
    profileDigest: digest,
    binding,
    selectedEvidence: copyHybridEvidence(r.selectedEvidence, binding),
  };
  return new TextEncoder().encode(hybridJson(request, HYBRID_LIMITS.requestBytes));
}

export function copyHybridProposal(value: unknown): Proposal {
  const p = hybridFields(value, ['kind', 'statement', 'basis', 'validFrom', 'validTo']);
  const proposal = wireProposal(p);
  hybridJson(proposal, HYBRID_LIMITS.resultBytesPerRequest);
  return proposal;
}
/** Normalized project wire protocol; not a NVIDIA/vLLM native HTTP API. */
export function decodeHybridReply(value: unknown, expected: HybridReplyIdentity): Proposal {
  const reply = hybridFields(value, ['contentType', 'body']);
  if (reply.contentType !== 'application/json') fail('HYBRID_CONTENT_TYPE');
  if (
    typeof reply.body !== 'object' ||
    reply.body === null ||
    types.isProxy(reply.body) ||
    !types.isUint8Array(reply.body)
  )
    fail('HYBRID_WIRE_SHAPE');
  let bytes: Uint8Array;
  try {
    // Intrinsic length/copy ignores overridden instance accessors and slice methods.
    const proto = Object.getPrototypeOf(Uint8Array.prototype) as object;
    const length = Object.getOwnPropertyDescriptor(proto, 'byteLength')!.get!.call(reply.body) as number;
    const buffer = Object.getOwnPropertyDescriptor(proto, 'buffer')!.get!.call(reply.body) as ArrayBufferLike;
    if (length > HYBRID_LIMITS.responseBytes || types.isSharedArrayBuffer(buffer)) fail('HYBRID_BYTE_LIMIT');
    bytes = new Uint8Array(length);
    Uint8Array.prototype.set.call(bytes, reply.body);
  } catch {
    fail('HYBRID_WIRE_SHAPE');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    fail('HYBRID_INVALID_JSON');
  }
  const r = hybridFields(parsed, ['version', 'kind', 'requestId', 'lease', 'profileDigest', 'proposal']);
  if (r.version !== 1 || r.kind !== 'final-proposal') fail('HYBRID_PROTOCOL_UNSUPPORTED');
  const lease = validateHybridLease(r.lease),
    wanted = validateHybridLease(expected.lease);
  if (
    hybridId(r.requestId) !== hybridId(expected.requestId) ||
    hybridSha(r.profileDigest) !== hybridSha(expected.profileDigest) ||
    wanted.profileDigest !== expected.profileDigest ||
    hybridJson(lease, 1024) !== hybridJson(wanted, 1024)
  )
    fail('HYBRID_IDENTITY_MISMATCH');
  return copyHybridProposal(r.proposal);
}
