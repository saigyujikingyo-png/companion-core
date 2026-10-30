import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bitsF64,
  canaryDatasets,
  CANARY_CONFIG,
  canonical,
  CanaryError,
  f64Bits,
  independentEvaluation,
  initialCheckpoint,
  makeTensors,
  sha256,
  TARGET_BIAS,
  TARGET_WEIGHTS,
  tensorValues,
  verifyFirstStep,
} from '../src/tj1-spec.ts';
import { parseCanaryWorkerFrame } from '../src/tj1-observer.ts';

const rejects = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof CanaryError);
test('TJ1 original dataset bytes match independently supplied frozen SHA and family split', () => {
  const d = canaryDatasets();
  assert.equal(Buffer.byteLength(d.train), 13238);
  assert.equal(sha256(d.train), 'd24ee7488dd5204faabdd9e74ccbca09a67993e6071426df4e817eab5caaa73e');
  assert.equal(Buffer.byteLength(d.eval), 26386);
  assert.equal(sha256(d.eval), '99853e550fa4b95346fd66f58183a409d0e15ff61c991582dcd526469c0f882e');
  const train = d.train
      .trimEnd()
      .split('\n')
      .map((s) => JSON.parse(s)),
    evaluation = d.eval
      .trimEnd()
      .split('\n')
      .map((s) => JSON.parse(s));
  assert.equal(new Set(train.map((r) => JSON.stringify(r.x))).size, 64);
  assert.equal(new Set(evaluation.map((r) => JSON.stringify(r.x))).size, 128);
  assert.ok(train.every((r) => r.family === 'train-corners' && r.x.every((x: string) => Math.abs(bitsF64(x)) === 1)));
  assert.ok(
    evaluation.every((r) => r.family === 'eval-interior' && r.x.every((x: string) => Math.abs(bitsF64(x)) < 1)),
  );
});
test('TJ1 Node checkpoint is exact zero state, never pretrained or native torch save', () => {
  const checkpoint = initialCheckpoint();
  assert.equal(checkpoint.initialization, 'FROM_SCRATCH_NOT_PRETRAINED');
  assert.equal(checkpoint.format, 'tj1-zero-state-v1');
  assert.equal(checkpoint.optimizer.completedSteps, '0');
  assert.equal(checkpoint.optimizer.momentum, null);
  assert.deepEqual(tensorValues(checkpoint.tensors), Array(14).fill(0));
  assert.equal(checkpoint.configDigest, sha256(canonical(CANARY_CONFIG)));
  const baseline = independentEvaluation(checkpoint.tensors);
  assert.equal(baseline.baselineMse, 0.37451171875);
  assert.equal(baseline.mse, 0.37451171875);
  assert.equal(baseline.changed, 0);
});
test('TJ1 frozen oracle cannot be modified; independent gradient and first step detect plausible wrong scales', () => {
  assert.equal(Reflect.set(TARGET_WEIGHTS, 0, 10), false);
  assert.equal(Reflect.set(TARGET_BIAS, 0, 10), false);
  const gradient = makeTensors(
      TARGET_WEIGHTS.map((x) => -x),
      TARGET_BIAS.map((x) => -x),
    ),
    after = makeTensors(
      TARGET_WEIGHTS.map((x) => 0.1 * x),
      TARGET_BIAS.map((x) => 0.1 * x),
    );
  verifyFirstStep(gradient, after);
  rejects(() =>
    verifyFirstStep(
      makeTensors(
        TARGET_WEIGHTS.map((x) => -2 * x),
        TARGET_BIAS.map((x) => -2 * x),
      ),
      after,
    ),
  );
  rejects(() =>
    verifyFirstStep(
      gradient,
      makeTensors(
        TARGET_WEIGHTS.map((x) => 0.05 * x),
        TARGET_BIAS.map((x) => 0.05 * x),
      ),
    ),
  );
  const metric = independentEvaluation(makeTensors([...TARGET_WEIGHTS], [...TARGET_BIAS]));
  assert.equal(metric.mse, 0);
  assert.ok(metric.deltaL2 > 1e-6);
  assert.equal(metric.changed, 12);
});
test('TJ1 canonical f64 identities preserve signed zero and reject nonfinite model parameters', () => {
  assert.equal(f64Bits(-0), '8000000000000000');
  assert.equal(Object.is(bitsF64('8000000000000000'), -0), true);
  for (const bad of ['7ff0000000000000', '7ff80000000000ab', 'FFF0000000000000', '0']) rejects(() => bitsF64(bad));
  const t = initialCheckpoint().tensors;
  t.weight.shape = [2, 5] as unknown as [2, 6];
  rejects(() => tensorValues(t));
});
test('TJ1 parsed fixture worker frames cannot themselves mint observed evidence', () => {
  const raw = canonical({
    protocol: 'TJ1_WORKER_V1',
    stage: 'trainer',
    launchId: 'fixture-launch',
    manifestDigest: 'a'.repeat(64),
    sequence: '1',
    kind: 'READY',
    data: { runtime: 'torch:2.11.0+cu128', rssBytes: '1000000', availableBytes: '2147483648' },
  });
  assert.equal(parseCanaryWorkerFrame(raw).assurance, 'UNTRUSTED_PROCESS_FRAME');
  for (const changed of [
    raw.replace('"sequence":"1"', '"sequence":1'),
    raw.replace('"protocol":', '"extra":true,"protocol":'),
    raw.replace('1000000', '9999999999999999'),
    raw.replace('2147483648', '999999999999999999999999'),
    raw + 'x',
  ])
    rejects(() => parseCanaryWorkerFrame(changed));
  rejects(() => parseCanaryWorkerFrame(' '.repeat(8193)));
});
