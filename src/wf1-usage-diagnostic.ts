import { fields, integer, stop, Wf1Error } from './wf1-json.ts';
import type { Usage } from './wf1-types.ts';

/** Fixed diagnostics only; no provider keys, values or exception text escape this parser. */
export const USAGE_PARSE_CODES = [
  'NOT_REACHED',
  'MISSING_OR_NULL',
  'VALID',
  'INVALID_FIELDS',
  'INVALID_NUMBER',
  'TOTAL_MISMATCH',
  'REASONING_RANGE',
  'UNKNOWN',
] as const;
export type UsageParseCode = (typeof USAGE_PARSE_CODES)[number];
export function usageParseCode(value: unknown): UsageParseCode {
  return typeof value === 'string' && (USAGE_PARSE_CODES as readonly string[]).includes(value)
    ? (value as UsageParseCode)
    : 'UNKNOWN';
}

/** Keep nativeUsage's validation order and accepted set, including ignored optional details. */
export function parseNativeUsage(value: unknown): { usage: Usage | null; usageParseCode: UsageParseCode } {
  if (value === undefined || value === null) return { usage: null, usageParseCode: 'MISSING_OR_NULL' };
  let reasoningValue: unknown,
    reasoningStage = false;
  try {
    const u = fields(
      value,
      ['prompt_tokens', 'completion_tokens'],
      [
        'total_tokens',
        'prompt_tokens_details',
        'completion_tokens_details',
        'prompt_cache_hit_tokens',
        'prompt_cache_miss_tokens',
      ],
    );
    const input = integer(u.prompt_tokens),
      completion = integer(u.completion_tokens);
    if (u.total_tokens !== undefined && integer(u.total_tokens) !== input + completion) stop('WF1_USAGE');
    let reasoning: number | null = null;
    if (u.completion_tokens_details !== undefined && u.completion_tokens_details !== null) {
      const d = fields(
        u.completion_tokens_details,
        [],
        ['reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'],
      );
      if (d.reasoning_tokens !== undefined) {
        reasoningValue = d.reasoning_tokens;
        reasoningStage = true;
        reasoning = integer(reasoningValue, 0, completion);
      }
    }
    return { usage: { input, completion, reasoning }, usageParseCode: 'VALID' };
  } catch (error) {
    const code: UsageParseCode = !(error instanceof Wf1Error)
      ? 'UNKNOWN'
      : error.code === 'WF1_SHAPE' || error.code === 'WF1_FIELDS'
        ? 'INVALID_FIELDS'
        : error.code === 'WF1_USAGE'
          ? 'TOTAL_MISMATCH'
          : error.code === 'WF1_NUMBER'
            ? reasoningStage && Number.isSafeInteger(reasoningValue) && !Object.is(reasoningValue, -0)
              ? 'REASONING_RANGE'
              : 'INVALID_NUMBER'
            : 'UNKNOWN';
    return { usage: null, usageParseCode: code };
  }
}
