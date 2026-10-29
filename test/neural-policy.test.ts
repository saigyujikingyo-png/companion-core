import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEURAL_DEFAULTS, neuralWorkloadHash, selectNeuralBackend } from '../src/neural-policy.ts';
import type {
  NeuralAuthority,
  NeuralBackend,
  NeuralCandidate,
  NeuralMode,
  NeuralProbe,
  NeuralRequest,
  ProbeStatus,
} from '../src/neural-policy.ts';

// Synthetic claims only: these fixtures are not hardware probes or neural execution evidence.
function fixture(mode: NeuralMode = 'inference', backend: NeuralBackend = 'cuda') {
  const request: NeuralRequest = {
    workload: {
      mode,
      graphHash: 'a'.repeat(64),
      modelHash: 'b'.repeat(64),
      checkpointHash: 'c'.repeat(64),
      parentCheckpointHash: null,
      dtype: 'float32',
      layout: 'csr',
      batch: 1,
      unrollSteps: mode === 'bptt' ? 8 : 0,
    },
    budget: { hostBytes: 4096, deviceBytes: 4096, p95Ms: 10 },
  };
  const candidate: NeuralCandidate = {
    id: backend,
    identity: {
      backend,
      deviceId: `synthetic-${backend}`,
      deviceArchitecture: 'synthetic-architecture',
      runtimeVersion: 'synthetic-runtime@1',
      providerVersion: 'synthetic-provider-sdk-compiler@1',
      driverVersion: 'synthetic-driver@1',
    },
  };
  const authority: NeuralAuthority = { nowMs: 10_000, learningAllowed: true, parentLineageValid: true };
  candidate.probe = passedProbe(candidate, request);
  return { request, candidate, authority };
}
function passedProbe(c: NeuralCandidate, r: NeuralRequest): NeuralProbe {
  return {
    identity: { ...c.identity },
    workloadHash: neuralWorkloadHash(r.workload),
    checkedAtMs: 9000,
    expiresAtMs: 20_000,
    forward: 'passed',
    residency: 'passed',
    benchmark: 'passed',
    update: 'passed',
    backward: 'passed',
    actualDeviceId: c.identity.deviceId,
    cpuFallbackOps: [],
    peakHostBytes: 1024,
    peakDeviceBytes: c.identity.backend === 'cpu' ? 0 : 2048,
    p95Ms: 2,
  };
}
function reasons(f: ReturnType<typeof fixture>) {
  return selectNeuralBackend(f.request, [f.candidate], f.authority).candidates[0]!.reasons;
}

test('defaults prefer local small circuits; enumeration or memory hints never qualify an untested device', () => {
  assert.deepEqual(NEURAL_DEFAULTS, { preference: 'prefer-local', circuit: 'small-circuit' });
  const f = fixture();
  delete f.candidate.probe;
  Object.assign(f.candidate, { enumerated: true, freeDeviceBytes: 128 * 2 ** 30 });
  assert.equal(selectNeuralBackend(f.request, [f.candidate], f.authority).status, 'needs_probe');
  assert.deepEqual(reasons(f), ['PROBE_MISSING']);
  assert.equal(selectNeuralBackend(f.request, [], f.authority).status, 'needs_probe');
});

test('a verified CPU candidate remains selectable when an accelerator lacks evidence', () => {
  const f = fixture(),
    cpu = fixture('inference', 'cpu').candidate;
  delete f.candidate.probe;
  const decision = selectNeuralBackend(f.request, [f.candidate, cpu], f.authority);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedId, 'cpu');
  assert.deepEqual(decision.reasons, ['VERIFIED_CPU_FALLBACK']);
  assert.deepEqual(decision.candidates[0]!.reasons, ['PROBE_MISSING']);
  assert.deepEqual(decision.candidates[1]!.reasons, []);
});

test('workload hashing binds mode, model, graph, checkpoint, parent and execution configuration', () => {
  const f = fixture(),
    original = neuralWorkloadHash(f.request.workload);
  const variants = [
    { mode: 'local-plasticity' as const },
    { graphHash: 'd'.repeat(64) },
    { modelHash: 'd'.repeat(64) },
    { checkpointHash: 'd'.repeat(64) },
    { parentCheckpointHash: 'd'.repeat(64) },
    { dtype: 'float16' },
    { layout: 'coo' },
    { batch: 2 },
    { unrollSteps: 8 },
    { circuit: 'full-connectome' as const },
    { declaredCpuFallbackOps: ['Readout:MatMul'] },
  ];
  for (const change of variants) assert.notEqual(neuralWorkloadHash({ ...f.request.workload, ...change }), original);
  f.request.workload.checkpointHash = 'd'.repeat(64);
  assert.ok(reasons(f).includes('WORKLOAD_MISMATCH'));
  f.request.workload.checkpointHash = 'c'.repeat(64);
  f.request.workload.parentCheckpointHash = 'e'.repeat(64);
  assert.ok(reasons(f).includes('WORKLOAD_MISMATCH'));
  assert.equal(neuralWorkloadHash({ ...fixture().request.workload, circuit: 'small-circuit' }), original);
});

test('NPU inference evidence cannot grant any learning mode, even when it contains backward claims', () => {
  for (const mode of ['local-plasticity', 'readout-training', 'bptt'] as const) {
    const f = fixture('inference', 'qnn-htp');
    f.request.workload.mode = mode;
    if (mode === 'bptt') f.request.workload.unrollSteps = 8;
    assert.ok(reasons(f).includes('WORKLOAD_MISMATCH'));
    assert.equal(selectNeuralBackend(f.request, [f.candidate], f.authority).status, 'needs_probe');
  }
});

test('local plasticity needs update; readout training and BPTT each need backward', () => {
  for (const mode of ['local-plasticity', 'readout-training', 'bptt'] as const) {
    const f = fixture(mode),
      key = mode === 'local-plasticity' ? 'update' : 'backward';
    delete f.candidate.probe![key];
    assert.ok(reasons(f).includes(`${key.toUpperCase()}_NOT_RUN`));
    f.candidate.probe![key] = 'failed';
    assert.equal(selectNeuralBackend(f.request, [f.candidate], f.authority).status, 'blocked');
    f.candidate.probe![key] = 'passed';
    assert.equal(selectNeuralBackend(f.request, [f.candidate], f.authority).status, 'selected');
  }
});

test('readout training and BPTT reject all non-passed update states despite passed backward', () => {
  for (const mode of ['readout-training', 'bptt'] as const) {
    const f = fixture(mode);
    assert.equal(selectNeuralBackend(f.request, [f.candidate], f.authority).status, 'selected');
    for (const status of ['failed', 'unsupported', 'not-run', undefined] as const) {
      if (status === undefined) delete f.candidate.probe!.update;
      else f.candidate.probe!.update = status;
      const decision = selectNeuralBackend(f.request, [f.candidate], f.authority);
      assert.equal(decision.selectedId, null);
      assert.equal(decision.status, status === undefined || status === 'not-run' ? 'needs_probe' : 'blocked');
      assert.deepEqual(decision.candidates[0]!.reasons, [
        `UPDATE_${(status ?? 'not-run').toUpperCase().replace('-', '_')}`,
      ]);
    }
    f.candidate.probe!.update = 'passed';
    assert.equal(selectNeuralBackend(f.request, [f.candidate], f.authority).status, 'selected');
  }
});

test('backend, device, architecture, provider, runtime and driver changes invalidate passed probes', () => {
  for (const field of [
    'backend',
    'deviceId',
    'deviceArchitecture',
    'providerVersion',
    'runtimeVersion',
    'driverVersion',
  ] as const) {
    const f = fixture();
    if (field === 'backend') f.candidate.identity.backend = 'directml';
    else f.candidate.identity[field] += '-changed';
    assert.ok(reasons(f).includes('RUNTIME_IDENTITY_MISMATCH'));
  }
  const f = fixture();
  f.candidate.probe!.actualDeviceId = 'synthetic-cpu';
  assert.ok(reasons(f).includes('DEVICE_RESIDENCY_MISMATCH'));
  f.candidate.identity.deviceId = '0';
  assert.ok(reasons(f).includes('INVALID_RUNTIME_IDENTITY'));
});

test('expired, future and malformed probe times never qualify', () => {
  const f = fixture(),
    p = f.candidate.probe!;
  p.expiresAtMs = f.authority.nowMs;
  assert.ok(reasons(f).includes('PROBE_EXPIRED'));
  p.expiresAtMs = 20_000;
  p.checkedAtMs = 10_001;
  assert.ok(reasons(f).includes('PROBE_IN_FUTURE'));
  for (const time of [NaN, Infinity, -1, p.expiresAtMs]) {
    p.checkedAtMs = time;
    assert.ok(reasons(f).includes('INVALID_PROBE_TIME'));
  }
});

test('all required forward, residency and benchmark failures are reported for each candidate', () => {
  const f = fixture(),
    p = f.candidate.probe!;
  p.forward = 'failed';
  p.residency = 'unsupported';
  p.benchmark = 'not-run';
  const decision = selectNeuralBackend(f.request, [f.candidate], f.authority);
  assert.equal(decision.selectedId, null);
  assert.deepEqual(decision.candidates[0]!.reasons, ['FORWARD_FAILED', 'RESIDENCY_UNSUPPORTED', 'BENCHMARK_NOT_RUN']);
  for (const key of ['forward', 'residency', 'benchmark', 'update', 'backward'] as const) {
    const malformed = fixture();
    malformed.candidate.probe![key] = 123 as unknown as ProbeStatus;
    assert.ok(reasons(malformed).includes(`${key.toUpperCase()}_INVALID`));
    assert.equal(selectNeuralBackend(malformed.request, [malformed.candidate], malformed.authority).status, 'blocked');
  }
});

test('budgets and observed metrics reject NaN, infinity and negative values; every excess is reported', () => {
  for (const invalid of [NaN, Infinity, -1]) {
    for (const field of ['hostBytes', 'deviceBytes', 'p95Ms'] as const) {
      const f = fixture();
      f.request.budget[field] = invalid;
      assert.deepEqual(selectNeuralBackend(f.request, [f.candidate], f.authority).reasons, ['INVALID_REQUEST']);
    }
    for (const field of ['peakHostBytes', 'peakDeviceBytes', 'p95Ms'] as const) {
      const f = fixture();
      f.candidate.probe![field] = invalid;
      assert.ok(reasons(f).includes('INVALID_PROBE_METRICS'));
    }
  }
  const f = fixture();
  f.request.budget = { hostBytes: 0, deviceBytes: 0, p95Ms: 0 };
  assert.deepEqual(reasons(f), [
    'HOST_MEMORY_BUDGET_EXCEEDED',
    'DEVICE_MEMORY_BUDGET_EXCEEDED',
    'LATENCY_BUDGET_EXCEEDED',
  ]);
});

test('CPU partitions must exactly match the declared plan and remain in end-to-end budgets', () => {
  const f = fixture();
  f.candidate.probe!.cpuFallbackOps = ['Readout:MatMul'];
  assert.ok(reasons(f).includes('CPU_FALLBACK_MISMATCH'));
  f.request.workload.declaredCpuFallbackOps = ['Readout:MatMul'];
  assert.ok(reasons(f).includes('WORKLOAD_MISMATCH'));
  f.candidate.probe!.workloadHash = neuralWorkloadHash(f.request.workload);
  assert.equal(selectNeuralBackend(f.request, [f.candidate], f.authority).status, 'selected');
  f.request.budget.hostBytes = 512;
  assert.ok(reasons(f).includes('HOST_MEMORY_BUDGET_EXCEEDED'));
});

test('learning permission and parent-lineage validity are independent trusted authority checks', () => {
  const f = fixture('readout-training');
  f.authority.learningAllowed = false;
  Object.assign(f.candidate.probe!, { learningAllowed: true });
  assert.deepEqual(selectNeuralBackend(f.request, [f.candidate], f.authority).reasons, ['LEARNING_NOT_ALLOWED']);
  const inference = fixture();
  inference.authority.learningAllowed = false;
  assert.equal(selectNeuralBackend(inference.request, [inference.candidate], inference.authority).status, 'selected');
  inference.authority.parentLineageValid = false;
  assert.deepEqual(selectNeuralBackend(inference.request, [inference.candidate], inference.authority).reasons, [
    'CHECKPOINT_LINEAGE_INVALID',
  ]);
});

test('full connectomes require explicit opt-in; fresh valid evidence competes on measured latency', () => {
  const f = fixture();
  f.request.workload.circuit = 'full-connectome';
  f.candidate.probe = passedProbe(f.candidate, f.request);
  assert.deepEqual(selectNeuralBackend(f.request, [f.candidate], f.authority).reasons, [
    'FULL_CONNECTOME_OPT_IN_REQUIRED',
  ]);
  f.request.fullConnectomeOptIn = true;
  const cpu = fixture('inference', 'cpu').candidate;
  cpu.probe = passedProbe(cpu, f.request);
  cpu.probe.p95Ms = 3;
  assert.equal(selectNeuralBackend(f.request, [cpu, f.candidate], f.authority).selectedId, 'cuda');
  cpu.probe.p95Ms = 2;
  assert.equal(selectNeuralBackend(f.request, [cpu, f.candidate], f.authority).selectedId, 'cpu');
  f.request.workload.batch = 0;
  assert.deepEqual(selectNeuralBackend(f.request, [f.candidate], f.authority).reasons, ['INVALID_REQUEST']);
});
