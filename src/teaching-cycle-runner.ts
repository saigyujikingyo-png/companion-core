import { canonical, digest, hash, integer, list, parseJson, shape, stop, Wf1Error } from './wf1-json.ts';
import { runCorpusProduction, verifyProduction } from './corpus-production-runner.ts';
import type { ProductionRunPorts } from './corpus-production-runner.ts';
import { measureProductionTokens } from './corpus-production-tokenizer.ts';
import { exportProduction, verifyProductionExport } from './corpus-production-artifacts.ts';
import { prepareQualitySelection } from './corpus-qa-source.ts';
import { validateAuditSelection } from './corpus-qa-types.ts';
import type { AuditSelection } from './corpus-qa-types.ts';
import { exportQualityAudit, readQualityIndex, runQualityAudit, verifyQualityAudit } from './corpus-qa-runner.ts';
import type { QaRunPorts } from './corpus-qa-runner.ts';
import { archiveCapability } from './corpus-qa-index-archive.ts';
import type { QaIndexArchiveDescriptor, QualityIndexArchive } from './corpus-qa-index-archive.ts';
import { assembleCycleIndexes } from './corpus-qa-index.ts';
import type { ScopedDedupIndex } from './corpus-qa-index.ts';
import type { ScopedRef } from './corpus-production-types.ts';
import { CorpusResourceScheduler } from './corpus-resource-scheduler.ts';
import type { TeachingCycleStore } from './teaching-cycle-store.ts';
import { cycleActiveChildren, cycleAuditId, validateCurriculumPlan } from './teaching-cycle-types.ts';
import type { ChildState, ChildStage, CurriculumPlan, CycleOwner, TeachingCycleState } from './teaching-cycle-types.ts';
import { teachingCycleBuildDigest } from './teaching-cycle-build.ts';
import { types } from 'node:util';

export type CycleProductionPorts = ProductionRunPorts & {
  runtimeRoot: string;
  authorityPath: string;
  tokenizer: { profile: unknown; pythonPath: string };
  authorizeSelection: () => void;
};
/** These are custody/worker factories, not stage result callbacks. Every stage
 * below executes the existing production, tokenizer, QA and full-index code. */
export type TeachingCyclePorts = {
  store: TeachingCycleStore;
  plan: CurriculumPlan;
  owner: CycleOwner;
  signal?: AbortSignal;
  checkChildMetadata: (child: ChildState) => void;
  openProduction: (child: ChildState) => Promise<CycleProductionPorts>;
  openAudit: (child: ChildState, selection: AuditSelection) => Promise<QaRunPorts>;
  archiveAudit: (child: ChildState, qa: QaRunPorts) => Promise<QualityIndexArchive>;
  openIndex: (child: ChildState, descriptor: QaIndexArchiveDescriptor) => QualityIndexArchive;
};
const same = (a: unknown, b: unknown) => {
  if (canonical(a) !== canonical(b)) stop('TC_CHILD_BINDING');
};
function childMetadata(check: TeachingCyclePorts['checkChildMetadata'], child: ChildState) {
  if (typeof check !== 'function') stop('TC_METADATA_CHECK');
  const result = check(structuredClone(child));
  // TypeScript permits async functions in a void callback. Never read while an
  // asynchronous check is pending, even if its Promise is already resolved.
  if (result !== undefined) {
    if (types.isPromise(result))
      void Promise.prototype.then.call(
        result,
        () => undefined,
        () => undefined,
      );
    stop('TC_METADATA_CHECK');
  }
}
const value = (
  store: TeachingCycleStore,
  ref: ScopedRef,
  child: ChildState,
  check: TeachingCyclePorts['checkChildMetadata'],
) => {
  childMetadata(check, child);
  return parseJson(store.read(ref).toString('utf8'));
};
function saveSelection(
  store: TeachingCycleStore,
  selection: AuditSelection,
  child: ChildState,
  check: TeachingCyclePorts['checkChildMetadata'],
) {
  const { entries, ...header } = selection,
    refs = [];
  for (let i = 0; i < entries.length; i += 32) {
    childMetadata(check, child);
    refs.push(store.put('meta', 'teaching-selection-chunk', canonical(entries.slice(i, i + 32))));
  }
  childMetadata(check, child);
  return store.put(
    'meta',
    'teaching-selection',
    canonical({ version: 'TeachingSelection/0.1', header, entries: refs }),
  );
}
function loadSelection(
  store: TeachingCycleStore,
  ref: ScopedRef,
  child: ChildState,
  check: TeachingCyclePorts['checkChildMetadata'],
) {
  const s = shape(value(store, ref, child, check), ['version', 'header', 'entries']);
  if (s.version !== 'TeachingSelection/0.1') stop('TC_SELECTION');
  const entries = list(s.entries, 6, 1).flatMap((r) => list(value(store, r as ScopedRef, child, check), 32, 1));
  return validateAuditSelection({ ...(s.header as object), entries });
}
function stage(store: TeachingCycleStore, child: ChildState, next: ChildStage, changes: Partial<ChildState> = {}) {
  const c = { ...child, ...changes };
  store.apply('STAGE', {
    childId: child.childId,
    expected: child.stage,
    stage: next,
    selectionRef: c.selectionRef,
    auditSpecDigest: c.auditSpecDigest,
    indexRef: c.indexRef,
    descriptorRef: c.descriptorRef,
    indexDigest: c.indexDigest,
    code: c.code,
  });
}
export function teachingCycleSummary(state: TeachingCycleState) {
  return {
    version: 'TeachingCycleSummary/0.1',
    status: state.status,
    qualification: state.plan.qualification,
    microRound: state.microRound,
    plannedUnits: state.children.reduce((n, c) => n + c.plannedUnits, 0),
    children: state.children.map((c) => ({
      childId: c.childId,
      microRound: c.microRound,
      shard: c.shard,
      stage: c.stage,
      code: c.code,
    })),
    activeChildren: cycleActiveChildren(state).length,
    indexesCommitted: state.children.filter((c) => c.indexRef).length,
    microBarriers: state.barriers.length,
    resources: {
      localHeld: state.leases.filter((l) => l.local === 'HELD').length,
      localReclaimed: state.leases.filter((l) => l.local === 'RECLAIMED').length,
      remoteUnknown: state.leases.filter((l) => l.remote === 'UNKNOWN').length,
      leases: state.leases.length,
    },
    evidenceClass: 'MODEL_OPINION',
    factualTruth: 'UNKNOWN',
    trainingReady: false,
    trainingJobPolicy: 'NOT_AUTHORIZED',
  };
}

/** Current metadata grants are checked for every shard. No old source/raw read. */
export function verifyTeachingCycle(
  store: TeachingCycleStore,
  openIndex: TeachingCyclePorts['openIndex'],
  checkChildMetadata: TeachingCyclePorts['checkChildMetadata'],
) {
  if (store.spec.buildDigest !== teachingCycleBuildDigest()) stop('TC_BUILD');
  const state = store.snapshot();
  if (!state) stop('TC_STATE');
  validateCurriculumPlan(state.plan, state.spec);
  const indexes: ScopedDedupIndex[] = [],
    digests: string[] = [],
    measurements: { childId: string; caseId: string; measurement: AuditSelection['entries'][number]['measurement'] }[] =
      [];
  for (const child of state.children) {
    const selection = child.selectionRef ? loadSelection(store, child.selectionRef, child, checkChildMetadata) : null;
    if (child.stage !== 'COMPLETE') continue;
    if (!child.descriptorRef || !child.indexRef || !child.indexDigest) stop('TC_INDEX');
    const descriptor = value(
        store,
        child.descriptorRef,
        child,
        checkChildMetadata,
      ) as unknown as QaIndexArchiveDescriptor,
      reader = openIndex(child, descriptor);
    try {
      const cap = archiveCapability(reader);
      cap.check();
      const view = cap.read();
      same(view.descriptor, descriptor);
      same(view.descriptor.specDigest, child.auditSpecDigest);
      same(view.selection, selection);
      same(view.index, value(store, child.indexRef, child, checkChildMetadata));
      if (hash(canonical(view.index)) !== child.indexDigest || descriptor.indexDigest !== child.indexDigest)
        stop('TC_INDEX');
      indexes.push(view.index);
      digests.push(child.indexDigest);
      for (const entry of selection!.entries)
        measurements.push({ childId: child.childId, caseId: entry.caseId, measurement: entry.measurement });
    } finally {
      reader.close();
    }
  }
  for (const barrier of state.barriers) {
    const count = state.children.filter((c) => c.microRound <= barrier.microRound).length,
      assembly = assembleCycleIndexes(indexes.slice(0, count), digests.slice(0, count), {
        maxInputs: state.spec.resources.maxChildren,
        maxRows: state.spec.resources.maxIndexedRows,
        maxBytes: state.spec.resources.maxIndexBytes,
      });
    same(barrier.indexDigests, assembly.indexDigests);
    if (hash(canonical(assembly)) !== barrier.assemblyDigest) stop('TC_BARRIER');
  }
  const sum = (key: 'studentInputTokens' | 'studentLossTokens' | 'fullTokens') =>
    measurements.reduce((n, e) => integer(n + integer(Number(e.measurement[key]))), 0);
  return {
    state,
    indexes,
    digests,
    measurementDigest: hash(canonical(measurements)),
    tokens: {
      rows: measurements.length,
      studentInputTokens: sum('studentInputTokens'),
      studentLossTokens: sum('studentLossTokens'),
      fullTokens: sum('fullTokens'),
    },
  };
}
const runningCycles = new WeakSet<object>();
export async function runTeachingCycle(ports: TeachingCyclePorts) {
  const { store } = ports;
  if (runningCycles.has(store)) stop('TC_OWNER');
  runningCycles.add(store);
  const controller = new AbortController(),
    signal = ports.signal ? AbortSignal.any([ports.signal, controller.signal]) : controller.signal,
    active = new Map<string, Promise<void>>();
  try {
    if (store.spec.buildDigest !== teachingCycleBuildDigest()) stop('TC_BUILD');
    const plan = validateCurriculumPlan(ports.plan, store.spec);
    if (!store.snapshot()) store.initialize(plan);
    const check = () => {
      store.check();
      signal.throwIfAborted();
    };
    let state = verifyTeachingCycle(store, ports.openIndex, ports.checkChildMetadata).state;
    if (store.mode === 'inspect' || state.status === 'COMPLETE') return teachingCycleSummary(state);
    const scheduler = new CorpusResourceScheduler(store, ports.owner, () => signal.throwIfAborted());
    const childNow = (id: string) => store.snapshot()!.children.find((c) => c.childId === id)!;
    const runChild = async (id: string) => {
      let production: CycleProductionPorts | undefined, qa: QaRunPorts | undefined;
      try {
        check();
        let child = childNow(id);
        if (child.stage === 'PENDING') {
          stage(store, child, 'PRODUCTION');
          child = childNow(id);
        }
        if (child.stage === 'PRODUCTION' || child.stage === 'TOKENS') {
          production = await ports.openProduction(child);
          check();
          const spec = production.store.spec;
          if (
            spec.version !== 'CorpusProduction/0.2' ||
            hash(canonical(spec)) !== child.productionSpecDigest ||
            spec.unitCount !== child.plannedUnits
          )
            stop('TC_CHILD_BINDING');
          if (child.stage === 'PRODUCTION') {
            const execution = scheduler.execution(id, () => production!.store.check());
            const result = await runCorpusProduction(spec, { ...production, ...(signal ? { signal } : {}), execution });
            check();
            if (result.status !== 'COMPLETED') stop('TC_PRODUCTION_FENCED');
            verifyProduction(production.store);
            stage(store, child, 'TOKENS');
            child = childNow(id);
          }
          check();
          measureProductionTokens(production.store, production.tokenizer.profile, production.tokenizer.pythonPath);
          check();
          exportProduction(production.store);
          verifyProductionExport(production.store);
          const selection = prepareQualitySelection({
              store: production.store,
              sourceRuntimeRoot: production.runtimeRoot,
              sourceAuthorityPath: production.authorityPath,
              seed: hash(canonical({ cycle: store.spec.cycleId, child: id })),
              authorize: () => {
                check();
                production!.authorizeSelection();
              },
            }),
            selectionRef = saveSelection(store, selection, child, ports.checkChildMetadata);
          production.store.close();
          production = undefined;
          stage(store, child, 'QA', { selectionRef });
          child = childNow(id);
        }
        if (child.stage === 'QA' || child.stage === 'INDEX') {
          if (!qa)
            qa = await ports.openAudit(
              child,
              loadSelection(store, child.selectionRef!, child, ports.checkChildMetadata),
            );
          check();
          if (
            qa.store.spec.version !== 'CorpusQualityAudit/0.2' ||
            qa.store.spec.auditId !== cycleAuditId(store.spec.cycleId, id)
          )
            stop('TC_CHILD_POLICY');
          const auditDigest = hash(canonical(qa.store.spec));
          if (child.auditSpecDigest === null) {
            store.apply('BIND_AUDIT', { childId: id, specDigest: auditDigest });
            child = childNow(id);
          }
          same(auditDigest, child.auditSpecDigest);
          same(hash(canonical(qa.selection)), qa.store.spec.selectionDigest);
          if (child.stage === 'QA') {
            const execution = scheduler.execution(id, () => {
                qa!.store.check();
                qa!.source.check();
              }),
              result = await runQualityAudit(qa.store.spec, { ...qa, ...(signal ? { signal } : {}), execution });
            check();
            if (result.status !== 'COMPLETED') stop('TC_QA_FENCED');
            verifyQualityAudit(qa.store, qa.source);
            stage(store, child, 'INDEX');
            child = childNow(id);
          }
          exportQualityAudit(qa.store, qa.source);
          const verified = verifyQualityAudit(qa.store, qa.source),
            index = readQualityIndex(qa.store, verified.state.indexRef!),
            reader = await ports.archiveAudit(child, qa);
          check();
          try {
            const cap = archiveCapability(reader);
            cap.check();
            const view = cap.read();
            if (view.descriptor.legacyProfile !== 'QA_POLICY_V2') stop('TC_INDEX_PROFILE');
            same(view.index, index);
            same(view.descriptor.specDigest, child.auditSpecDigest);
            same(view.descriptor.source, qa.selection.source);
            same(view.descriptor.indexRef, verified.state.indexRef);
            same(view.descriptor.manifestRef, verified.state.manifestRef);
            childMetadata(ports.checkChildMetadata, child);
            const indexRef = store.put(
              'index-' + store.snapshot()!.children.findIndex((c) => c.childId === id),
              'teaching-full-index',
              canonical(index),
            );
            childMetadata(ports.checkChildMetadata, child);
            const descriptorRef = store.put('meta', 'teaching-index-descriptor', canonical(view.descriptor));
            digest(view.descriptor.indexDigest);
            stage(store, child, 'COMPLETE', { indexRef, descriptorRef, indexDigest: view.descriptor.indexDigest });
          } finally {
            reader.close();
          }
        }
      } catch (error) {
        try {
          const child = childNow(id);
          if (!['COMPLETE', 'FAILED'].includes(child.stage))
            stage(store, child, 'FAILED', {
              code: error instanceof Wf1Error && error.code.startsWith('TC_') ? error.code : 'TC_CHILD_FAILED',
            });
        } catch {
          throw error;
        }
      } finally {
        production?.store.close();
        qa?.store.close();
        qa?.source.close();
      }
    };
    while (true) {
      check();
      state = store.snapshot()!;
      if (state.status === 'COMPLETE') break;
      const children = state.children.filter((c) => c.microRound === state.microRound);
      for (const child of children) {
        if (active.size >= store.spec.resources.activeChildren) break;
        if (active.has(child.childId) || ['COMPLETE', 'FAILED'].includes(child.stage)) continue;
        const task = runChild(child.childId).finally(() => active.delete(child.childId));
        active.set(child.childId, task);
      }
      if (active.size) {
        await Promise.race(active.values());
        continue;
      }
      if (children.some((c) => c.stage !== 'COMPLETE')) break;
      const verified = verifyTeachingCycle(store, ports.openIndex, ports.checkChildMetadata),
        assembly = assembleCycleIndexes(verified.indexes, verified.digests, {
          maxInputs: store.spec.resources.maxChildren,
          maxRows: store.spec.resources.maxIndexedRows,
          maxBytes: store.spec.resources.maxIndexBytes,
        });
      check();
      store.apply('BARRIER', {
        microRound: state.microRound,
        assemblyDigest: hash(canonical(assembly)),
        indexDigests: assembly.indexDigests,
      });
    }
    return teachingCycleSummary(verifyTeachingCycle(store, ports.openIndex, ports.checkChildMetadata).state);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(active.values());
    throw error;
  } finally {
    runningCycles.delete(store);
  }
}
