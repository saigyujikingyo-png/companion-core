import { canonical, copyJson, hash, parseJson, shape, stop } from './wf1-json.ts';
import { ENDPOINTS, WF1 } from './wf1-types.ts';
import type { Operation, Provider, RequestBinding } from './wf1-types.ts';
import { fixedSlotBinding, fixedSlotBody, WF2_SLOTS_PROFILE_DIGEST } from './wf2-fixed-slots.ts';

/** This is a distinct prespecified transport experiment, never a fallback after beta failure. */
export const WF2_NAMED_POLICY = Object.freeze({
  version: 'wf2-named-slots/1',
  campaignSchema: 'wf1-campaign/0.6',
  baseProfile: WF2_SLOTS_PROFILE_DIGEST,
  deepseekEndpoint: ENDPOINTS.deepseek,
  protocol: 'DEEPSEEK_NAMED_DATA_ARGS_V1',
  strict: 'OMITTED',
  origin: 'NAMED_TOOL_ARGUMENTS',
  artifactKind: 'named-tool-arguments',
  responseDiagnostics: 'wf2-response-diagnostic/1',
  retry: false,
  repair: false,
  auxiliaryCalls: 0,
});
export const WF2_NAMED_PROFILE_DIGEST = hash(canonical({ limits: WF1, policy: WF2_NAMED_POLICY }));
const beta = Object.freeze({
  profileDigest: WF2_SLOTS_PROFILE_DIGEST,
  origin: 'STRICT_TOOL_ARGUMENTS' as const,
  artifactKind: 'strict-tool-arguments',
});
const named = Object.freeze({
  profileDigest: WF2_NAMED_PROFILE_DIGEST,
  origin: 'NAMED_TOOL_ARGUMENTS' as const,
  artifactKind: 'named-tool-arguments',
});
export function slotProfile(profileDigest: string) {
  if (profileDigest === WF2_SLOTS_PROFILE_DIGEST) return beta;
  if (profileDigest === WF2_NAMED_PROFILE_DIGEST) return named;
  return stop('WF1_PROFILE');
}
export function slotRequestBinding(provider: Provider, operation: Operation, profileDigest: string): RequestBinding {
  const profile = slotProfile(profileDigest),
    base = fixedSlotBinding(provider, operation);
  if (profile === beta) return base;
  return {
    ...base,
    ...(provider === 'deepseek'
      ? { endpoint: ENDPOINTS.deepseek, protocol: 'DEEPSEEK_NAMED_DATA_ARGS_V1' as const }
      : {}),
    profileDigest,
  };
}
export function slotRequestBody(
  provider: Provider,
  payload: unknown,
  operation: Operation,
  profileDigest: string,
): string {
  const profile = slotProfile(profileDigest),
    raw = fixedSlotBody(provider, payload, operation);
  if (profile === beta || provider === 'together') return raw;
  const body = JSON.parse(raw);
  delete body.tools[0].function.strict;
  const encoded = canonical(body);
  if (Buffer.byteLength(encoded) > WF1.requestBytes) stop('WF1_REQUEST_BYTES');
  return encoded;
}
export function validateNamedDataRequest(
  provider: Provider,
  operation: Operation,
  body: string,
  binding: RequestBinding,
): void {
  if (
    binding.profileDigest !== WF2_NAMED_PROFILE_DIGEST ||
    canonical(binding) !== canonical(slotRequestBinding(provider, operation, WF2_NAMED_PROFILE_DIGEST))
  )
    stop('WF2_NAMED_BINDING');
  const b = shape(
    parseJson(body),
    provider === 'deepseek'
      ? ['model', 'stream', 'messages', 'max_tokens', 'thinking', 'tools', 'tool_choice']
      : ['model', 'stream', 'messages', 'max_tokens', 'response_format', 'reasoning_effort'],
  );
  if (!Array.isArray(b.messages) || b.messages.length !== 2) stop('WF2_NAMED_BINDING');
  const u = shape(b.messages[1], ['role', 'content']);
  if (typeof u.content !== 'string') stop('WF2_NAMED_BINDING');
  const p = shape(parseJson(u.content), ['protocol', 'operation', 'role', 'jsonProfile', 'data']);
  if (p.protocol !== 'wf2-private-rational-role/1' || p.operation !== operation) stop('WF2_NAMED_BINDING');
  const payload = copyJson({
    protocol: 'wf1-private-role/1',
    operation,
    role: p.role,
    protocolInstruction: '',
    jsonProfile: p.jsonProfile,
    outputSchema: null,
    data: p.data,
  });
  if (body !== slotRequestBody(provider, payload, operation, WF2_NAMED_PROFILE_DIGEST)) stop('WF2_NAMED_BINDING');
}
