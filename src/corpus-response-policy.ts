import { fields, integer, parseJson } from './wf1-json.ts';
import { MODELS } from './wf1-types.ts';
import type { Provider, ProviderResult } from './wf1-types.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import { validatePilotEnvelopeExtras } from './wf2-together-pilot.ts';

export const CORPUS_RESPONSE_POLICY_V2 = Object.freeze({
  version: 'CorpusResponsePolicy/0.2',
  moneyPolicy: 'ACCOUNTING_ONLY',
  missingUsage: 'RAW_PROVEN_ABSENT_OR_NULL',
  unknownSubmission: 'ISOLATE_CONSUMED_ATTEMPT_NO_RETRY',
});
export type UsageStatus = 'PROVIDER_REPORTED' | 'UNREPORTED';
export type CorpusResponseDisposition =
  | { kind: 'CONTENT'; usageStatus: UsageStatus }
  | { kind: 'ISOLATE'; code: 'SUBMIT_UNKNOWN' | 'OUTPUT_INVALID' | 'USAGE_INVALID' }
  | { kind: 'FENCE'; code: 'MODEL_IDENTITY' | 'ARTIFACT_INTEGRITY' }
  | { kind: 'RATE_LIMIT' };

/** Current controlled artifact reads only. A diagnostic label is not evidence of missing usage.
 * Callers separately validate their operation's business schema before accepting any row. */
export function corpusResponseDisposition(
  result: ProviderResult | null,
  provider: Provider,
  port: Pick<ArtifactPort, 'read'>,
): CorpusResponseDisposition {
  if (!result) return { kind: 'ISOLATE', code: 'SUBMIT_UNKNOWN' };
  if (result.responseFailureCode === 'ARTIFACT_WRITE_FAILED') return { kind: 'FENCE', code: 'ARTIFACT_INTEGRITY' };
  if (
    result.requestedModel !== MODELS[provider] ||
    (result.returnedModel !== null && result.returnedModel !== MODELS[provider]) ||
    result.responseFailureCode === 'MODEL_IDENTITY' ||
    result.failure === 'MODEL_IDENTITY'
  )
    return { kind: 'FENCE', code: 'MODEL_IDENTITY' };
  // A partial/failed response may already carry persisted artifacts. Check every
  // observed reference before permitting more independent work to dispatch.
  let raw: Buffer | undefined, final: Buffer | undefined;
  for (const [ref, kind] of [
    [result.rawRef, 'provider-raw'],
    [result.reasoningRef, 'native-reasoning'],
    [result.finalRef, 'native-final'],
  ] as const) {
    if (!ref) continue;
    if (ref.kind !== kind || ref.partition !== 'train') return { kind: 'FENCE', code: 'ARTIFACT_INTEGRITY' };
    const bytes = port.read(ref);
    if (kind === 'provider-raw') raw = bytes;
    if (kind === 'native-final') final = bytes;
  }
  if (result.outcome === 'SUBMIT_UNKNOWN') return { kind: 'ISOLATE', code: 'SUBMIT_UNKNOWN' };
  if (result.httpStatus === 429) return { kind: 'RATE_LIMIT' };
  if (
    result.httpStatus !== 200 ||
    result.outcome !== 'COMPLETED' ||
    result.finishReason !== 'stop' ||
    result.failure !== null ||
    result.responseFailureCode !== 'NONE' ||
    !result.contentPresent
  )
    return { kind: 'ISOLATE', code: 'OUTPUT_INVALID' };
  if (result.returnedModel !== MODELS[provider]) return { kind: 'FENCE', code: 'MODEL_IDENTITY' };
  if (!final) return { kind: 'FENCE', code: 'ARTIFACT_INTEGRITY' };
  if (result.usage !== null) {
    if (result.usageParseCode !== 'VALID') return { kind: 'ISOLATE', code: 'USAGE_INVALID' };
    try {
      integer(result.usage.input, 0, 66048);
      integer(result.usage.completion, 0, 16384);
      if (result.usage.reasoning !== null) integer(result.usage.reasoning, 0, result.usage.completion);
    } catch {
      return { kind: 'ISOLATE', code: 'USAGE_INVALID' };
    }
    return { kind: 'CONTENT', usageStatus: 'PROVIDER_REPORTED' };
  }
  if (result.usageParseCode !== 'MISSING_OR_NULL') return { kind: 'ISOLATE', code: 'USAGE_INVALID' };
  if (!raw) return { kind: 'FENCE', code: 'ARTIFACT_INTEGRITY' };
  try {
    const e = fields(
      parseJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
      ['choices'],
      [
        'id',
        'object',
        'created',
        'model',
        'usage',
        'system_fingerprint',
        'service_tier',
        ...(provider === 'together' ? ['prompt', 'warnings'] : []),
      ],
    );
    if (e.model !== MODELS[provider]) return { kind: 'FENCE', code: 'MODEL_IDENTITY' };
    if ((e.usage !== undefined && e.usage !== null) || !Array.isArray(e.choices) || e.choices.length !== 1)
      return { kind: 'ISOLATE', code: 'USAGE_INVALID' };
    const c = fields(
      e.choices[0],
      ['index', 'message', 'finish_reason'],
      ['logprobs', ...(provider === 'together' ? ['text', 'seed', 'top_logprobs'] : [])],
    );
    if (provider === 'together') validatePilotEnvelopeExtras(e, c);
    const m = fields(
      c.message,
      ['role', 'content'],
      ['reasoning', 'reasoning_content', 'refusal', 'tool_calls', 'annotations', 'function_call'],
    );
    if (
      c.index !== 0 ||
      c.finish_reason !== 'stop' ||
      m.role !== 'assistant' ||
      typeof m.content !== 'string' ||
      !m.content.trim() ||
      (m.refusal !== undefined && m.refusal !== null && m.refusal !== '') ||
      (m.tool_calls !== undefined &&
        m.tool_calls !== null &&
        (!Array.isArray(m.tool_calls) || m.tool_calls.length > 0)) ||
      (m.function_call !== undefined && m.function_call !== null)
    )
      return { kind: 'ISOLATE', code: 'OUTPUT_INVALID' };
    if (!final.equals(Buffer.from(m.content, 'utf8'))) return { kind: 'FENCE', code: 'ARTIFACT_INTEGRITY' };
    return { kind: 'CONTENT', usageStatus: 'UNREPORTED' };
  } catch {
    return { kind: 'ISOLATE', code: 'USAGE_INVALID' };
  }
}

/** Accounting remains exact or explicitly unknown; a sum overflow is a technical error. */
export function accountingSum(values: readonly (number | null)[]): number | null {
  let total = 0,
    unknown = false;
  for (const value of values) {
    if (value === null) {
      unknown = true;
      continue;
    }
    integer(value);
    total = integer(total + value);
  }
  return unknown ? null : total;
}

export type RegisterNativeCompletion = (probe: () => boolean) => void;
/** Local resource evidence only; never serialized as a provider observation. */
export function corpusTransportCompletion() {
  let settled = false,
    registrationOpen = false,
    registered = false,
    invalid = false,
    probe: (() => boolean) | undefined;
  const register: RegisterNativeCompletion = (value) => {
    if (!registrationOpen || registered || typeof value !== 'function') {
      invalid = true;
      return;
    }
    registered = true;
    probe = value;
  };
  return {
    observe<T>(operation: (register: RegisterNativeCompletion) => Promise<T>): Promise<T> {
      registrationOpen = true;
      try {
        return Promise.resolve(operation(register)).then(
          (value) => {
            settled = true;
            return value;
          },
          (error) => {
            settled = true;
            throw error;
          },
        );
      } catch (error) {
        settled = true;
        return Promise.reject(error);
      } finally {
        registrationOpen = false;
      }
    },
    released(sent: boolean): boolean {
      if (!settled || invalid || (sent && !registered)) return false;
      if (!probe) return true;
      try {
        return probe() === true;
      } catch {
        return false;
      }
    },
  };
}
