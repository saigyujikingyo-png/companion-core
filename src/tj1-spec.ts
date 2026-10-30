import { createHash } from 'node:crypto';
import { parseSceneJson } from './scene-json.ts';

export class CanaryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CanaryError';
    this.code = code;
  }
}
export function canaryFail(code: string): never {
  throw new CanaryError(code);
}
export const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
export const CANARY_LIMITS = Object.freeze({
  ledgerBytes: 4_194_304,
  events: 256,
  eventBytes: 8_192,
  stdoutBytes: 524_288,
  lineBytes: 8_192,
  stderrBytes: 32_768,
  artifactBytes: 1_048_576,
  totalArtifactBytes: 4_194_304,
  startupMs: 30_000,
  trainMs: 60_000,
  evalMs: 30_000,
  cleanupMs: 5_000,
  preRamBytes: 2_147_483_648,
  postImportRamBytes: 1_073_741_824,
  observedRssLimit: 1_610_612_736,
});
export const CANARY_CONFIG = Object.freeze({
  version: 1,
  task: 'TJ1_MINI_READOUT_V1',
  model: 'Linear6x2',
  dtype: 'float64',
  device: 'cpu',
  seed: 103,
  threads: 1,
  steps: 64,
  batchSize: 64,
  torchVersion: '2.11.0+cu128',
  loss: 'mean_128_scalar_squared_errors',
  learningRateBits: '3fb999999999999a',
  momentumBits: '3fe0000000000000',
  dampening: 0,
  weightDecay: 0,
  nesterov: false,
  trainFamily: 'train-corners',
  evalFamily: 'eval-interior',
  evalRows: 128,
});
export const TARGET_WEIGHTS = Object.freeze([0.75, -0.5, 0.25, 0, 0.5, -0.25, -0.25, 0.5, 0, 0.75, -0.5, 0.25]);
export const TARGET_BIAS = Object.freeze([0.125, -0.25]);
export const HEX64 = /^[0-9a-f]{64}$/;
export function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) canaryFail('TJ1_INVALID');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) canaryFail('TJ1_INVALID');
  return v;
}
export function boundedJson(raw: string, max: number = CANARY_LIMITS.eventBytes): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > max) canaryFail('TJ1_LIMIT');
  try {
    return parseSceneJson(raw);
  } catch {
    return canaryFail('TJ1_INVALID');
  }
}
/** Identity JSON codec v1: recursive UTF-16 key order, exact string/array values, no normalization. */
export function canonical(value: unknown): string {
  const render = (v: any): string =>
    Array.isArray(v)
      ? '[' + v.map(render).join(',') + ']'
      : v !== null && typeof v === 'object'
        ? '{' +
          Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) + ':' + render(v[k]))
            .join(',') +
          '}'
        : JSON.stringify(v);
  return render(value);
}
export function f64Bits(value: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value);
  return b.toString('hex');
}
export function bitsF64(bits: string): number {
  if (!/^[0-9a-f]{16}$/.test(bits)) canaryFail('TJ1_INVALID');
  const value = Buffer.from(bits, 'hex').readDoubleBE();
  if (!Number.isFinite(value)) canaryFail('TJ1_NONFINITE');
  return value;
}
export type Tensors = {
  weight: { dtype: 'f64'; shape: [2, 6]; bits: string };
  bias: { dtype: 'f64'; shape: [2]; bits: string };
};
export function makeTensors(weights: number[], bias: number[]): Tensors {
  return {
    weight: { dtype: 'f64', shape: [2, 6], bits: weights.map(f64Bits).join('') },
    bias: { dtype: 'f64', shape: [2], bits: bias.map(f64Bits).join('') },
  };
}
export function tensorValues(raw: unknown): number[] {
  const t = closed(raw, ['weight', 'bias']),
    values: number[] = [];
  for (const [name, size, shape] of [
    ['weight', 12, [2, 6]],
    ['bias', 2, [2]],
  ] as const) {
    const v = closed(t[name], ['dtype', 'shape', 'bits']);
    if (
      v.dtype !== 'f64' ||
      canonical(v.shape) !== canonical(shape) ||
      typeof v.bits !== 'string' ||
      v.bits.length !== size * 16
    )
      canaryFail('TJ1_INVALID');
    for (let i = 0; i < size; i++) values.push(bitsF64(v.bits.slice(i * 16, (i + 1) * 16)));
  }
  return values;
}
export function initialCheckpoint() {
  return {
    format: 'tj1-zero-state-v1',
    initialization: 'FROM_SCRATCH_NOT_PRETRAINED',
    configDigest: sha256(canonical(CANARY_CONFIG)),
    tensors: makeTensors(Array(12).fill(0), Array(2).fill(0)),
    optimizer: { momentum: null, completedSteps: '0' },
    seed: 103,
    dataPosition: '0',
  };
}
type Row = { id: string; family: string; x: string[]; y: string[] };
function row(id: string, family: string, x: number[]): Row {
  const y = [0, 1].map((j) => x.reduce((sum, value, k) => sum + TARGET_WEIGHTS[j * 6 + k]! * value, TARGET_BIAS[j]!));
  return { id, family, x: x.map(f64Bits), y: y.map(f64Bits) };
}
export function canaryDatasets(): { train: string; eval: string } {
  const train = Array.from({ length: 64 }, (_, i) =>
    row(
      'train-' + i,
      'train-corners',
      Array.from({ length: 6 }, (_, k) => ((i >> k) & 1 ? 1 : -1)),
    ),
  );
  const evaluation: Row[] = [],
    seen = new Set<string>(),
    values = [-7, -5, -3, -1, 1, 3, 5, 7];
  for (let n = 0; n < 4_096 && evaluation.length < 128; n++) {
    const x = Array.from(
      { length: 6 },
      (_, k) =>
        values[createHash('sha256').update(`TJ1_MINI_READOUT_V1|eval-interior|103|${n}|${k}`).digest()[0]! % 8]! / 8,
    );
    const key = x.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    evaluation.push(row('eval-' + evaluation.length, 'eval-interior', x));
  }
  if (evaluation.length !== 128) canaryFail('TJ1_PREPARE_REFUSED');
  return {
    train: train.map((r) => JSON.stringify(r) + '\n').join(''),
    eval: evaluation.map((r) => JSON.stringify(r) + '\n').join(''),
  };
}
export function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12 + 1e-12 * Math.abs(b);
}
export function verifyFirstStep(gradient: unknown, after: unknown): void {
  const g = tensorValues(gradient),
    a = tensorValues(after),
    target = [...TARGET_WEIGHTS, ...TARGET_BIAS];
  if (!g.every((v, i) => near(v, -target[i]!)) || !a.every((v, i) => near(v, 0.1 * target[i]!)))
    canaryFail('TJ1_FIRST_STEP_MISMATCH');
}
/** Independent arithmetic, not a replay of autograd/optimizer or evidence that a trainer ran. */
export function independentEvaluation(tensors: unknown): {
  mse: number;
  baselineMse: number;
  deltaL2: number;
  changed: number;
  predictions: string[];
} {
  const values = tensorValues(tensors),
    rows = canaryDatasets()
      .eval.trimEnd()
      .split('\n')
      .map((s) => JSON.parse(s) as Row);
  let squared = 0,
    baseline = 0;
  const predictions: string[] = [];
  for (const r of rows)
    for (let j = 0; j < 2; j++) {
      const prediction = r.x.reduce((sum, x, k) => sum + bitsF64(x) * values[j * 6 + k]!, values[12 + j]!);
      const y = bitsF64(r.y[j]!);
      squared += (prediction - y) ** 2;
      baseline += y * y;
      predictions.push(f64Bits(prediction));
    }
  return {
    mse: squared / 256,
    baselineMse: baseline / 256,
    deltaL2: Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)),
    changed: values.filter((v) => v !== 0).length,
    predictions,
  };
}
