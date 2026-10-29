import { createHash } from 'node:crypto';
import { parseSceneJson } from './scene-json.ts';

/** TJ0 is an offline declaration format. No value in this format authenticates a trainer. */
export const TJ_LIMITS = Object.freeze({
  events: 256,
  attempts: 64,
  eventBytes: 16_384,
  decodedBytes: 4_194_304,
  archiveBytes: 8_388_608,
  encodedBytes: 65_536,
  depth: 8,
  textBytes: 1_024,
  metrics: 16,
  elements: 128,
  counterDigits: 78,
});
export type TrainingJournalCode =
  | 'TJ_INVALID'
  | 'TJ_LIMIT'
  | 'TJ_ORDER'
  | 'TJ_CONFLICT'
  | 'TJ_TERMINAL'
  | 'TJ_AUTHORITY'
  | 'TJ_FENCED'
  | 'TJ_REENTRANT'
  | 'TJ_LOCKED'
  | 'TJ_IO'
  | 'TJ_COMMIT_UNKNOWN'
  | 'TJ_CORRUPT'
  | 'TJ_UNSUPPORTED'
  | 'TJ_INCOMPLETE'
  | 'TJ_CHANGED'
  | 'TJ_NOT_FOUND'
  | 'TJ_PATH';
export class TrainingJournalError extends Error {
  readonly code: TrainingJournalCode;
  constructor(code: TrainingJournalCode) {
    super(code);
    this.name = 'TrainingJournalError';
    this.code = code;
  }
}
export function tjFail(code: TrainingJournalCode): never {
  throw new TrainingJournalError(code);
}
export const tjHash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export type ExactMetric = {
  name: string;
  unit: string;
  value: null | { dtype: 'f32' | 'f64'; shape: number[]; bits: string };
};
export type TrainingEvent = {
  version: 1;
  executionMode: 'SYNTHETIC_FIXTURE';
  datasetOrigin: 'SYNTHETIC';
  runId: string;
  attemptId: string;
  runnerId: string;
  jobId: string;
  eventId: string;
  sequence: string;
} & (
  | {
      kind: 'INTENT';
      data: {
        purpose: string;
        requestDigest: string;
        datasetDigest: string;
        modelDigest: string | null;
        parentAttemptId: string | null;
        seed: string | null;
        plannedSteps: string | null;
      };
    }
  | { kind: 'STARTED'; data: Record<string, never> }
  | { kind: 'STEP'; data: { optimizerSteps: string; batches: string | null; metrics: ExactMetric[] } }
  | { kind: 'TERMINAL'; data: { outcome: 'COMPLETED' | 'FAILED' | 'ABORTED' | 'UNKNOWN' | 'REFUSED' } }
  | { kind: 'ARTIFACT'; data: { artifactDigest: string; artifactKind: 'CHECKPOINT' | 'ADAPTER' | 'EXPORT' } }
  | { kind: 'RELOAD'; data: { artifactDigest: string; result: 'PASS' | 'FAIL' | 'UNKNOWN' } }
  | {
      kind: 'EVALUATION';
      data: {
        artifactDigest: string;
        policyDigest: string;
        result: 'PASS' | 'FAIL' | 'UNKNOWN';
        metrics: ExactMetric[];
      };
    }
  | { kind: 'ACTIVATION'; data: { artifactDigest: string; state: 'ACTIVE' | 'ROLLED_BACK' | 'UNKNOWN' } }
  | { kind: 'NOTE'; data: { relatedEventId: string; code: 'CORRECTION_DECLARED' | 'LATE_EVIDENCE'; text: string } }
);
type ObjectValue = Record<string, unknown>;
function object(value: unknown, keys: string[]): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) tjFail('TJ_INVALID');
  const obj = value as ObjectValue,
    actual = Object.keys(obj);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(obj, key))) tjFail('TJ_INVALID');
  return obj;
}
function text(value: unknown, max: number = TJ_LIMITS.textBytes): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) tjFail('TJ_INVALID');
  return value;
}
export function tjId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value)) tjFail('TJ_INVALID');
  return value;
}
export function tjCounter(value: unknown): string {
  if (typeof value !== 'string' || value.length > TJ_LIMITS.counterDigits || !/^(0|[1-9][0-9]*)$/.test(value))
    tjFail('TJ_INVALID');
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) tjFail('TJ_INVALID');
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) tjFail('TJ_INVALID');
  return value as T;
}
function nullable<T>(value: unknown, check: (v: unknown) => T): T | null {
  return value === null ? null : check(value);
}
function metrics(value: unknown): ExactMetric[] {
  if (!Array.isArray(value) || value.length > TJ_LIMITS.metrics) tjFail('TJ_LIMIT');
  const result = value.map((raw) => {
    const m = object(raw, ['name', 'unit', 'value']),
      name = tjId(m.name),
      unit = text(m.unit, 32);
    if (m.value === null) return { name, unit, value: null };
    const v = object(m.value, ['dtype', 'shape', 'bits']),
      dtype = choice(v.dtype, ['f32', 'f64']);
    if (!Array.isArray(v.shape) || v.shape.length > 4) tjFail('TJ_INVALID');
    let elements = 1;
    const shape = v.shape.map((size) => {
      if (!Number.isSafeInteger(size) || size < 1 || size > TJ_LIMITS.elements) tjFail('TJ_INVALID');
      elements *= size;
      if (elements > TJ_LIMITS.elements) tjFail('TJ_LIMIT');
      return size as number;
    });
    const bits = text(v.bits, 2_048);
    if (bits.length !== elements * (dtype === 'f32' ? 8 : 16) || !/^[a-f0-9]+$/.test(bits)) tjFail('TJ_INVALID');
    return { name, unit, value: { dtype, shape, bits } };
  });
  if (new Set(result.map((m) => m.name)).size !== result.length) tjFail('TJ_INVALID');
  return result;
}
/** Byte and depth gates run before the existing bounded, duplicate-key rejecting JSON parser. */
function parse(raw: string): unknown {
  if (typeof raw !== 'string') tjFail('TJ_INVALID');
  if (Buffer.byteLength(raw) > TJ_LIMITS.eventBytes) tjFail('TJ_LIMIT');
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const c of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      if (++depth > TJ_LIMITS.depth) tjFail('TJ_LIMIT');
    } else if (c === '}' || c === ']') depth--;
  }
  try {
    return parseSceneJson(raw);
  } catch {
    return tjFail('TJ_INVALID');
  }
}
/** Fixed field order, JSON escaping, no Unicode normalization; floats never pass through Number. */
export function canonicalTrainingEvent(raw: string): string {
  const e = object(parse(raw), [
    'version',
    'executionMode',
    'datasetOrigin',
    'runId',
    'attemptId',
    'runnerId',
    'jobId',
    'eventId',
    'sequence',
    'kind',
    'data',
  ]);
  if (e.version !== 1 || e.executionMode !== 'SYNTHETIC_FIXTURE' || e.datasetOrigin !== 'SYNTHETIC')
    tjFail('TJ_INVALID');
  const base = {
    version: 1,
    executionMode: 'SYNTHETIC_FIXTURE',
    datasetOrigin: 'SYNTHETIC',
    runId: tjId(e.runId),
    attemptId: tjId(e.attemptId),
    runnerId: tjId(e.runnerId),
    jobId: tjId(e.jobId),
    eventId: tjId(e.eventId),
    sequence: tjCounter(e.sequence),
  };
  let data: unknown;
  switch (e.kind) {
    case 'INTENT': {
      const d = object(e.data, [
        'purpose',
        'requestDigest',
        'datasetDigest',
        'modelDigest',
        'parentAttemptId',
        'seed',
        'plannedSteps',
      ]);
      data = {
        purpose: text(d.purpose),
        requestDigest: digest(d.requestDigest),
        datasetDigest: digest(d.datasetDigest),
        modelDigest: nullable(d.modelDigest, digest),
        parentAttemptId: nullable(d.parentAttemptId, tjId),
        seed: nullable(d.seed, tjCounter),
        plannedSteps: nullable(d.plannedSteps, tjCounter),
      };
      break;
    }
    case 'STARTED':
      object(e.data, []);
      data = {};
      break;
    case 'STEP': {
      const d = object(e.data, ['optimizerSteps', 'batches', 'metrics']);
      data = {
        optimizerSteps: tjCounter(d.optimizerSteps),
        batches: nullable(d.batches, tjCounter),
        metrics: metrics(d.metrics),
      };
      break;
    }
    case 'TERMINAL': {
      const d = object(e.data, ['outcome']);
      data = { outcome: choice(d.outcome, ['COMPLETED', 'FAILED', 'ABORTED', 'UNKNOWN', 'REFUSED']) };
      break;
    }
    case 'ARTIFACT': {
      const d = object(e.data, ['artifactDigest', 'artifactKind']);
      data = {
        artifactDigest: digest(d.artifactDigest),
        artifactKind: choice(d.artifactKind, ['CHECKPOINT', 'ADAPTER', 'EXPORT']),
      };
      break;
    }
    case 'RELOAD': {
      const d = object(e.data, ['artifactDigest', 'result']);
      data = { artifactDigest: digest(d.artifactDigest), result: choice(d.result, ['PASS', 'FAIL', 'UNKNOWN']) };
      break;
    }
    case 'EVALUATION': {
      const d = object(e.data, ['artifactDigest', 'policyDigest', 'result', 'metrics']);
      data = {
        artifactDigest: digest(d.artifactDigest),
        policyDigest: digest(d.policyDigest),
        result: choice(d.result, ['PASS', 'FAIL', 'UNKNOWN']),
        metrics: metrics(d.metrics),
      };
      break;
    }
    case 'ACTIVATION': {
      const d = object(e.data, ['artifactDigest', 'state']);
      data = { artifactDigest: digest(d.artifactDigest), state: choice(d.state, ['ACTIVE', 'ROLLED_BACK', 'UNKNOWN']) };
      break;
    }
    case 'NOTE': {
      const d = object(e.data, ['relatedEventId', 'code', 'text']);
      data = {
        relatedEventId: tjId(d.relatedEventId),
        code: choice(d.code, ['CORRECTION_DECLARED', 'LATE_EVIDENCE']),
        text: text(d.text),
      };
      break;
    }
    default:
      return tjFail('TJ_INVALID');
  }
  const encoded = JSON.stringify({ ...base, kind: e.kind, data });
  if (Buffer.byteLength(encoded) > TJ_LIMITS.eventBytes) tjFail('TJ_LIMIT');
  return encoded;
}
/** Imported records have declaration assurance only, including correctly hashed bytes. */
export function parseTrainingEvent(raw: string): { assurance: 'NOT_AUTHENTICATED'; event: TrainingEvent } {
  return { assurance: 'NOT_AUTHENTICATED', event: JSON.parse(canonicalTrainingEvent(raw)) as TrainingEvent };
}
export const tjAttemptKey = (e: Pick<TrainingEvent, 'runId' | 'attemptId'>): string =>
  JSON.stringify([e.runId, e.attemptId]);
export const tjEventKey = (e: TrainingEvent): string =>
  JSON.stringify([e.runId, e.attemptId, e.runnerId, e.jobId, e.eventId]);
export type AttemptProjection = {
  runId: string;
  attemptId: string;
  runnerId: string;
  jobId: string;
  sequence: string;
  state: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABORTED' | 'UNKNOWN' | 'REFUSED';
  optimizerStepsLowerBound: string | null;
  batchesLowerBound: string | null;
  artifacts: string[];
  reloads: Record<string, 'PASS' | 'FAIL' | 'UNKNOWN'>;
  evaluations: Record<string, 'PASS' | 'FAIL' | 'UNKNOWN'>;
  activation: 'NOT_ACTIVE' | 'ACTIVE' | 'ROLLED_BACK' | 'UNKNOWN';
  activeArtifact: string | null;
  everActivated: boolean;
  eventIds: string[];
};
/** Pure reducer; caller commits the returned copy only after a verified disk commit. */
export function reduceTrainingEvent(previous: AttemptProjection | undefined, e: TrainingEvent): AttemptProjection {
  if (!previous) {
    if (e.kind !== 'INTENT' || e.sequence !== '1' || e.data.parentAttemptId === e.attemptId) tjFail('TJ_ORDER');
    return {
      runId: e.runId,
      attemptId: e.attemptId,
      runnerId: e.runnerId,
      jobId: e.jobId,
      sequence: '1',
      state: 'NOT_STARTED',
      optimizerStepsLowerBound: null,
      batchesLowerBound: null,
      artifacts: [],
      reloads: {},
      evaluations: {},
      activation: 'NOT_ACTIVE',
      activeArtifact: null,
      everActivated: false,
      eventIds: [e.eventId],
    };
  }
  const p = structuredClone(previous);
  if (
    e.runId !== p.runId ||
    e.attemptId !== p.attemptId ||
    e.runnerId !== p.runnerId ||
    e.jobId !== p.jobId ||
    e.sequence !== (BigInt(p.sequence) + 1n).toString() ||
    p.eventIds.includes(e.eventId)
  )
    tjFail('TJ_ORDER');
  const ended = !['NOT_STARTED', 'RUNNING'].includes(p.state);
  switch (e.kind) {
    case 'INTENT':
      return tjFail('TJ_ORDER');
    case 'STARTED':
      if (ended) tjFail('TJ_TERMINAL');
      if (p.state !== 'NOT_STARTED') tjFail('TJ_ORDER');
      p.state = 'RUNNING';
      break;
    case 'STEP':
      if (ended) tjFail('TJ_TERMINAL');
      if (p.state !== 'RUNNING') tjFail('TJ_ORDER');
      if (BigInt(e.data.optimizerSteps) <= BigInt(p.optimizerStepsLowerBound ?? '0')) tjFail('TJ_ORDER');
      if (
        e.data.batches !== null &&
        p.batchesLowerBound !== null &&
        BigInt(e.data.batches) < BigInt(p.batchesLowerBound)
      )
        tjFail('TJ_ORDER');
      p.optimizerStepsLowerBound = e.data.optimizerSteps;
      if (e.data.batches !== null) p.batchesLowerBound = e.data.batches;
      break;
    case 'TERMINAL':
      if (ended) tjFail('TJ_TERMINAL');
      if (p.state === 'NOT_STARTED' && !['REFUSED', 'UNKNOWN'].includes(e.data.outcome)) tjFail('TJ_ORDER');
      if (p.state === 'RUNNING' && e.data.outcome === 'REFUSED') tjFail('TJ_ORDER');
      p.state = e.data.outcome;
      break;
    case 'ARTIFACT':
      if (p.state === 'NOT_STARTED' || p.state === 'REFUSED' || p.artifacts.includes(e.data.artifactDigest))
        tjFail('TJ_ORDER');
      p.artifacts.push(e.data.artifactDigest);
      break;
    case 'RELOAD':
      if (!p.artifacts.includes(e.data.artifactDigest)) tjFail('TJ_ORDER');
      p.reloads[e.data.artifactDigest] = e.data.result;
      break;
    case 'EVALUATION':
      if (!p.artifacts.includes(e.data.artifactDigest)) tjFail('TJ_ORDER');
      p.evaluations[e.data.artifactDigest] = e.data.result;
      break;
    case 'ACTIVATION':
      if (!p.artifacts.includes(e.data.artifactDigest)) tjFail('TJ_ORDER');
      if (e.data.state === 'ACTIVE') {
        if (
          p.state !== 'COMPLETED' ||
          p.activation === 'ACTIVE' ||
          p.activation === 'UNKNOWN' ||
          p.evaluations[e.data.artifactDigest] !== 'PASS' ||
          p.reloads[e.data.artifactDigest] !== 'PASS'
        )
          tjFail('TJ_ORDER');
        p.everActivated = true;
        p.activeArtifact = e.data.artifactDigest;
      } else {
        if (p.activation !== 'ACTIVE' || p.activeArtifact !== e.data.artifactDigest) tjFail('TJ_ORDER');
        p.activeArtifact = null;
      }
      p.activation = e.data.state;
      break;
    case 'NOTE':
      if (!p.eventIds.includes(e.data.relatedEventId)) tjFail('TJ_ORDER');
      break;
  }
  p.sequence = e.sequence;
  p.eventIds.push(e.eventId);
  return p;
}
