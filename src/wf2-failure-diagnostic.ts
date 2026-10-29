import { types } from 'node:util';
import { copyJson, integer, oneOf, shape, stop, Wf1Error } from './wf1-json.ts';

/** Fixed source vocabulary, never a prefix match or an exception-message projection. */
export const FAILURE_CODES = [
  'UNKNOWN',
  'WF1_ADMISSION',
  'WF1_ALREADY_CONSUMED',
  'WF1_ARTIFACT_CHANGED',
  'WF1_ARTIFACT_ID',
  'WF1_ARTIFACT_LIMIT',
  'WF1_ATTEMPT_CONFLICT',
  'WF1_AUTHORITY',
  'WF1_AUTHORITY_PATH',
  'WF1_BUDGET',
  'WF1_CAMPAIGN_STOPPED',
  'WF1_CANDIDATE_LIMIT',
  'WF1_COMMIT_UNKNOWN',
  'WF1_COMPARISON_GATE',
  'WF1_CREDENTIAL',
  'WF1_CREDENTIAL_UNAVAILABLE',
  'WF1_DEADLINE',
  'WF1_DIGEST',
  'WF1_DISK_LIMIT',
  'WF1_DUPLICATE',
  'WF1_DUPLICATE_KEY',
  'WF1_ENUM',
  'WF1_EVIDENCE',
  'WF1_EXCLUSION_CONSUMED',
  'WF1_FAMILY_COLLISION',
  'WF1_FENCED',
  'WF1_FIELDS',
  'WF1_FIRST_FOUR_GATE',
  'WF1_FORMAL_DIV_ZERO',
  'WF1_FORMAL_LIMIT',
  'WF1_FORMAL_NUMBER',
  'WF1_FORMAL_SHAPE',
  'WF1_FREEZE_GATE',
  'WF1_HEAD_MISMATCH',
  'WF1_HOST_BUSY',
  'WF1_HOT_JOURNAL_RECONCILE',
  'WF1_ID',
  'WF1_INCOMPLETE_OUTPUT',
  'WF1_INTENT_CAPABILITY',
  'WF1_IN_FLIGHT',
  'WF1_JSON',
  'WF1_JSON_LIMIT',
  'WF1_KEY',
  'WF1_LEDGER_CHANGED',
  'WF1_LEDGER_CORRUPT',
  'WF1_LEDGER_IO',
  'WF1_LEDGER_LIMIT',
  'WF1_LEDGER_SCHEMA',
  'WF1_LEDGER_VERSION',
  'WF1_LIMIT',
  'WF1_LINEAGE',
  'WF1_MODEL_IDENTITY',
  'WF1_NUMBER',
  'WF1_OBJECTIVE_BINDING',
  'WF1_OWNER_BUSY',
  'WF1_PAIR_BINDING',
  'WF1_PATH',
  'WF1_PHASE',
  'WF1_PLAN_REQUIRED',
  'WF1_POINTER',
  'WF1_PROFILE',
  'WF1_PROTOCOL',
  'WF1_READ_ONLY_RECONCILE',
  'WF1_REQUEST_BYTES',
  'WF1_REQUEST_CHANGED',
  'WF1_RESPONSE',
  'WF1_RESPONSE_BYTES',
  'WF1_RETURNED_MODEL',
  'WF1_REVOKED',
  'WF1_ROLE_ACCESS',
  'WF1_RUBRIC_REQUIRED',
  'WF1_SEALED_UNAVAILABLE',
  'WF1_SEAL_FORMAL_FAIL',
  'WF1_SEAL_REQUIRED',
  'WF1_SHAPE',
  'WF1_SOURCE_EXCLUSION',
  'WF1_SPLIT',
  'WF1_TEXT',
  'WF1_TIME',
  'WF1_UNICODE',
  'WF1_UNRECONCILED',
  'WF1_USAGE',
  'WF1_USAGE_OVER_RESERVE',
  'WF1_VERSION',
  'WF2_AUTHORITY_IN_TRAINING_ROOT',
  'WF2_BUILD_MISMATCH',
  'WF2_FAILURE_DIAGNOSTIC',
  'WF2_FIRST_EXACT_ORACLE',
  'WF2_FIRST_REVIEW',
  'WF2_FIRST_UNKNOWN',
  'WF2_INSPECT_SPEC',
  'WF2_INSPECT_VERSION',
  'WF2_MANIFEST_COUNT',
  'WF2_MANIFEST_COVERAGE',
  'WF2_MANIFEST_DUPLICATE',
  'WF2_MANIFEST_ORACLE',
  'WF2_MANIFEST_PARTITION',
  'WF2_MANIFEST_PLAN',
  'WF2_MANIFEST_PROTOCOL',
  'WF2_MANIFEST_SOURCE',
  'WF2_METADATA_PROFILE',
  'WF2_NAMED_BINDING',
  'WF2_PILOT_BINDING',
  'WF2_PILOT_CREDENTIAL',
  'WF2_PILOT_DUPLICATE',
  'WF2_PILOT_FINAL_ROOT',
  'WF2_PILOT_FREEZE',
  'WF2_PILOT_MANIFEST',
  'WF2_PILOT_OPERATION',
  'WF2_PILOT_PROVIDER',
  'WF2_PILOT_REQUEST',
  'WF2_RATIONAL_ONLY',
  'WF2_SERVICE_ADMISSION',
  'WF2_SERVICE_ALREADY_CONSUMED',
  'WF2_SERVICE_CAPABILITY',
  'WF2_SERVICE_COMPLETION_ACK',
  'WF2_SERVICE_METADATA',
  'WF2_SERVICE_REPLY',
  'WF2_SERVICE_REQUEST_CONFLICT',
  'WF2_SERVICE_REQUEST_ID',
  'WF2_SERVICE_REQUEST_LIMIT',
  'WF2_SERVICE_VERSION',
  'WF2_SLOT_BINDING',
  'WF2_SLOT_OPERATION',
  'WF2_SLOT_ORIGIN',
  'WF2_SLOT_ROUNDTRIP',
  'WF2_SLOT_ROUTE',
  'WF2_SLOT_SPLIT',
  'WF2_SLOT_VERSION',
  'WF2_SLOT_WIRE_REJECTED',
  'WF2_STORAGE_BINDING',
  'WF2_STRICT_ABORTED',
  'WF2_STRICT_BINDING',
  'WF2_STRICT_ORIGIN',
  'WF2_STRICT_REQUEST',
  'WF2_STRICT_RESPONSE',
  'WF2_TEACHER_PROFILE_NOT_ADMITTED',
  'WF2_TEACHER_REQUEST_BINDING',
  'WF2_TRAINING_ROOT',
  'WF2_UNIT_BINDING',
  'WF2_UNIT_CURRICULUM',
  'WF2_UNIT_FAMILY_BINDING',
  'WF2_UNIT_FREEZE',
  'WF2_UNIT_INDEX',
  'WF2_UNIT_MANIFEST',
  'WF2_UNIT_OPERATION',
  'WF2_UNIT_PRICES',
  'WF2_UNIT_PROVIDER',
  'WF2_UNIT_REQUEST',
  'WF2_UNIT_SCHEDULE',
  'WF2_UNIT_STATE',
  'WF2_WORKER_CONTROL',
  'WF2_WORKER_INPUT',
  'WF2_WORKER_OUTPUT',
  'WF2_WORKER_TRUNCATED',
  'WF2_WORKER_VERSION',
] as const;
export const FAILURE_STAGES = [
  'UNKNOWN',
  'SEAL_REQUEST',
  'SEAL_VALIDATION',
  'SEAL_COMMIT',
  'PLAN_REQUEST',
  'PLAN_VALIDATION',
  'PLAN_COMMIT',
  'RUBRIC_REQUEST',
  'RUBRIC_VALIDATION',
  'RUBRIC_COMMIT',
  'CANDIDATE_REQUEST',
  'CANDIDATE_VALIDATION',
  'CANDIDATE_STORE',
  'CANDIDATE_COMMIT',
  'SOURCE_EXCLUSION',
  'REVIEW_REQUEST',
  'REVIEW_VALIDATION',
  'FIRST_FOUR_GATE',
  'COMPARISON_GATE',
  'DATASET_FREEZE',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export type FailureStage = (typeof FAILURE_STAGES)[number];
export type FailureDiagnostic =
  | { version: 'wf2-failure-diagnostic/1'; stage: FailureStage; code: FailureCode }
  | { version: 'wf2-failure-diagnostic/2'; stage: FailureStage; code: FailureCode; unitIndex: number | null };
export function unknownFailureDiagnostic(): FailureDiagnostic {
  return { version: 'wf2-failure-diagnostic/1', stage: 'UNKNOWN', code: 'UNKNOWN' };
}
function safeCode(value: unknown): FailureCode {
  return typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value)
    ? (value as FailureCode)
    : 'UNKNOWN';
}
export function captureFailureDiagnostic(
  error: unknown,
  stage: FailureStage,
  unitIndex?: number | null,
): FailureDiagnostic {
  const code =
    !types.isProxy(error) && error instanceof Wf1Error
      ? safeCode(Object.getOwnPropertyDescriptor(error, 'code')?.value)
      : 'UNKNOWN';
  return unitIndex === undefined
    ? { version: 'wf2-failure-diagnostic/1', stage, code }
    : { version: 'wf2-failure-diagnostic/2', stage, code, unitIndex };
}
/** Transport inputs stay closed: reject unknown fields, versions, stages and codes. */
export function validateFailureDiagnostic(input: unknown): FailureDiagnostic {
  const own = copyJson(input),
    v2 = own !== null && typeof own === 'object' && !Array.isArray(own) && own.version === 'wf2-failure-diagnostic/2',
    d = shape(own, ['version', 'stage', 'code', ...(v2 ? ['unitIndex'] : [])]);
  if (!v2 && d.version !== 'wf2-failure-diagnostic/1') stop('WF2_FAILURE_DIAGNOSTIC');
  const stage = oneOf(d.stage, FAILURE_STAGES),
    code = oneOf(d.code, FAILURE_CODES);
  return v2
    ? {
        version: 'wf2-failure-diagnostic/2',
        stage,
        code,
        unitIndex: d.unitIndex === null ? null : integer(d.unitIndex, 0, 3),
      }
    : { version: 'wf2-failure-diagnostic/1', stage, code };
}
/** Legacy/missing records and stale observations carry no invented failure attribution. */
export function projectFailureDiagnostic(value: unknown, current: boolean, legacyCode?: unknown): FailureDiagnostic {
  if (!current) return unknownFailureDiagnostic();
  if (value === undefined) return { ...unknownFailureDiagnostic(), code: safeCode(legacyCode) };
  try {
    return validateFailureDiagnostic(value);
  } catch {
    return unknownFailureDiagnostic();
  }
}
