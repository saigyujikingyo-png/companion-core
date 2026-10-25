import { createHash } from 'node:crypto';

export const NEURAL_DEFAULTS = { preference: 'prefer-local', circuit: 'small-circuit' } as const;
export type NeuralMode = 'inference' | 'local-plasticity' | 'readout-training' | 'bptt';
export type NeuralBackend = 'cpu' | 'cuda' | 'directml' | 'qnn-htp' | 'openvino-npu' | 'rocm' | 'metal' | 'coreml-ane';
export type ProbeStatus = 'passed' | 'failed' | 'unsupported' | 'not-run';
export type NeuralWorkload = {
  mode: NeuralMode; circuit?: 'small-circuit' | 'full-connectome';
  graphHash: string; modelHash: string; checkpointHash: string; parentCheckpointHash: string | null;
  dtype: string; layout: string; batch: number; unrollSteps: number;
  /** Exact approved CPU partition; empty by default. Included in the workload hash. */
  declaredCpuFallbackOps?: readonly string[];
};
export type RuntimeIdentity = {
  backend: NeuralBackend; deviceId: string; deviceArchitecture: string;
  runtimeVersion: string; providerVersion: string; driverVersion: string;
};
export type NeuralProbe = {
  identity: RuntimeIdentity; workloadHash: string; checkedAtMs: number; expiresAtMs: number;
  forward: ProbeStatus; residency: ProbeStatus; benchmark: ProbeStatus;
  /** Complete parameter-update step for this exact workload, including optimizer if any. */
  update?: ProbeStatus; backward?: ProbeStatus;
  actualDeviceId: string; cpuFallbackOps: readonly string[];
  /** End-to-end values, including every CPU partition, transfer and synchronization. */
  peakHostBytes: number; peakDeviceBytes: number; p95Ms: number;
};
export type NeuralCandidate = { id: string; identity: RuntimeIdentity; probe?: NeuralProbe };
export type NeuralRequest = {
  workload: NeuralWorkload; fullConnectomeOptIn?: boolean;
  budget: { hostBytes: number; deviceBytes: number; p95Ms: number };
};
/** Trusted core context, never populated from model/provider/user authorization claims. */
export type NeuralAuthority = { nowMs: number; learningAllowed: boolean; parentLineageValid: boolean };
export type NeuralDecision = {
  status: 'selected' | 'needs_probe' | 'blocked'; selectedId: string | null;
  reasons: string[]; candidates: Array<{ id: string; reasons: string[] }>;
};

const finite = (n: number) => Number.isFinite(n) && n >= 0;
const text = (s: string) => typeof s === 'string' && s.trim().length > 0;
const hash = (s: string) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const modes: readonly string[] = ['inference', 'local-plasticity', 'readout-training', 'bptt'];
const backends: readonly string[] = ['cpu', 'cuda', 'directml', 'qnn-htp', 'openvino-npu', 'rocm', 'metal', 'coreml-ane'];
const probeStatuses: readonly unknown[] = ['passed', 'failed', 'unsupported', 'not-run'];
const opsKey = (ops: readonly string[]) => JSON.stringify([...ops].sort());
const validOps = (ops: readonly string[]) => ops.every(text) && new Set(ops).size === ops.length;
const identityKey = (i: RuntimeIdentity) => JSON.stringify([
  i.backend, i.deviceId, i.deviceArchitecture, i.runtimeVersion, i.providerVersion, i.driverVersion,
]);
const validIdentity = (i: RuntimeIdentity) => backends.includes(i.backend)
  && [i.deviceId, i.deviceArchitecture, i.runtimeVersion, i.providerVersion, i.driverVersion].every(text)
  && !/^\d+$/.test(i.deviceId);

/** Caller must hash all dynamics/configuration into graphHash, including dt and operator versions. */
export function neuralWorkloadHash(w: NeuralWorkload): string {
  return createHash('sha256').update(JSON.stringify([
    1, w.mode, w.circuit ?? NEURAL_DEFAULTS.circuit, w.graphHash, w.modelHash,
    w.checkpointHash, w.parentCheckpointHash, w.dtype, w.layout, w.batch, w.unrollSteps,
    opsKey(w.declaredCpuFallbackOps ?? []),
  ])).digest('hex');
}

/** Capability decision only: no execution, device discovery, consent grant or artifact activation.
 * Evidence is supplied by a trusted runtime. MemoryStore.validateRun is still mandatory
 * immediately before actual execution and output delivery, with current artifact lineage.
 */
export function selectNeuralBackend(
  request: NeuralRequest, candidates: readonly NeuralCandidate[], authority: NeuralAuthority,
): NeuralDecision {
  const { workload: w, budget: b } = request;
  const blocked = (reason: string): NeuralDecision => ({ status: 'blocked', selectedId: null,
    reasons: [reason], candidates: candidates.map(c => ({ id: c.id, reasons: [reason] })) });
  if (!modes.includes(w.mode) || !['small-circuit', 'full-connectome'].includes(w.circuit ?? NEURAL_DEFAULTS.circuit)
    || ![w.graphHash, w.modelHash, w.checkpointHash].every(hash)
    || !(w.parentCheckpointHash === null || hash(w.parentCheckpointHash))
    || !text(w.dtype) || !text(w.layout) || !Number.isSafeInteger(w.batch) || w.batch < 1
    || !Number.isSafeInteger(w.unrollSteps) || w.unrollSteps < 0 || (w.mode === 'bptt' && w.unrollSteps < 1)
    || !validOps(w.declaredCpuFallbackOps ?? []) || !finite(authority.nowMs)
    || ![b.hostBytes, b.deviceBytes, b.p95Ms].every(finite)
    || candidates.some(c => !text(c.id)) || new Set(candidates.map(c => c.id)).size !== candidates.length)
    return blocked('INVALID_REQUEST');
  if (w.circuit === 'full-connectome' && request.fullConnectomeOptIn !== true)
    return blocked('FULL_CONNECTOME_OPT_IN_REQUIRED');
  if (authority.parentLineageValid !== true) return blocked('CHECKPOINT_LINEAGE_INVALID');
  if (w.mode !== 'inference' && authority.learningAllowed !== true) return blocked('LEARNING_NOT_ALLOWED');

  const workloadHash = neuralWorkloadHash(w);
  let needsProbe = candidates.length === 0;
  const eligible: Array<{ candidate: NeuralCandidate; p95Ms: number }> = [];
  const reports = candidates.map(c => {
    const reasons: string[] = [];
    const reject = (reason: string, probeNeeded = false) => {
      reasons.push(reason); needsProbe ||= probeNeeded;
    };
    if (!validIdentity(c.identity)) reject('INVALID_RUNTIME_IDENTITY');
    const p = c.probe;
    if (!p) reject('PROBE_MISSING', true);
    else {
      if (!validIdentity(p.identity)) reject('INVALID_PROBE_IDENTITY');
      if (identityKey(c.identity) !== identityKey(p.identity)) reject('RUNTIME_IDENTITY_MISMATCH', true);
      if (p.workloadHash !== workloadHash) reject('WORKLOAD_MISMATCH', true);
      if (![p.checkedAtMs, p.expiresAtMs].every(finite) || p.expiresAtMs <= p.checkedAtMs)
        reject('INVALID_PROBE_TIME');
      else if (p.checkedAtMs > authority.nowMs) reject('PROBE_IN_FUTURE', true);
      else if (p.expiresAtMs <= authority.nowMs) reject('PROBE_EXPIRED', true);
      const checks = ['forward', 'residency', 'benchmark'] as const;
      for (const name of [...checks, 'update', 'backward'] as const) {
        if (p[name] !== undefined && !probeStatuses.includes(p[name])) reject(`${name.toUpperCase()}_INVALID`);
      }
      const requirePass = (name: keyof Pick<NeuralProbe, 'forward' | 'residency' | 'benchmark' | 'update' | 'backward'>) => {
        const status = p[name] === undefined ? 'not-run' : p[name];
        if (!probeStatuses.includes(status)) return;
        if (status !== 'passed') reject(`${name.toUpperCase()}_${status.toUpperCase().replace('-', '_')}`, status === 'not-run');
      };
      checks.forEach(requirePass);
      if (w.mode !== 'inference') requirePass('update');
      if (w.mode === 'readout-training' || w.mode === 'bptt') requirePass('backward');
      if (p.actualDeviceId !== c.identity.deviceId) reject('DEVICE_RESIDENCY_MISMATCH');
      if (!validOps(p.cpuFallbackOps) || opsKey(p.cpuFallbackOps) !== opsKey(w.declaredCpuFallbackOps ?? []))
        reject('CPU_FALLBACK_MISMATCH');
      if (![p.peakHostBytes, p.peakDeviceBytes, p.p95Ms].every(finite)) reject('INVALID_PROBE_METRICS');
      else {
        if (p.peakHostBytes > b.hostBytes) reject('HOST_MEMORY_BUDGET_EXCEEDED');
        if (p.peakDeviceBytes > b.deviceBytes) reject('DEVICE_MEMORY_BUDGET_EXCEEDED');
        if (p.p95Ms > b.p95Ms) reject('LATENCY_BUDGET_EXCEEDED');
      }
      if (reasons.length === 0) eligible.push({ candidate: c, p95Ms: p.p95Ms });
    }
    return { id: c.id, reasons };
  });
  // All candidates are local; prefer measured latency. Equal results preserve caller order.
  eligible.sort((a, z) => a.p95Ms - z.p95Ms);
  const selected = eligible[0]?.candidate;
  return selected
    ? { status: 'selected', selectedId: selected.id, candidates: reports,
      reasons: [selected.identity.backend === 'cpu' && candidates.some(c => c.identity.backend !== 'cpu')
        ? 'VERIFIED_CPU_FALLBACK' : 'VERIFIED_LOCAL'] }
    : { status: needsProbe ? 'needs_probe' : 'blocked', selectedId: null, candidates: reports,
      reasons: [candidates.length === 0 ? 'NO_CANDIDATES' : 'NO_ELIGIBLE_BACKEND'] };
}
