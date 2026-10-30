import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { MemoryStore } from './store.ts';
import { CurationService } from './curation.ts';
import { curationPolicy, curationRequest, type CurationPolicy } from './curation-rules.ts';
import { canonical, frozenCopy, type Frozen } from './curation-types.ts';
import { parseJson } from './wire.ts';
import { normalizeSceneJson, parseSceneJson } from './scene-json.ts';
import type { Epoch, RunTicket, SourceRef } from './contracts.ts';
import { fail, object, text, refs } from './validation.ts';
import { GROWTH_LIMITS } from './growth-journal-types.ts';
import type {
  GrowthJournal,
  GrowthEntry,
  GrowthView,
  GrowthKind,
  GrowthRecord,
  GrowthEntryRecord,
  GrowthReceipt,
  ReceiptPhase,
} from './growth-journal-types.ts';
import { syntheticGrowthTrace, type GrowthScenario } from './growth-journal-synthetic.ts';

type Entry = { journal: Journal; record: GrowthEntryRecord; requestDigest: string | null };
type Journal = {
  epoch: Frozen<Epoch>;
  refs: Frozen<SourceRef[]>;
  roots: Frozen<SourceRef[]>;
  identity: string;
  lastAsOf: number;
  ticket: RunTicket;
  writeFenced: boolean;
  invalid: boolean;
  entries: Entry[];
};
type View = { journal: Journal; epoch: Epoch; runtimeEpoch: number };
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
function closed(value: unknown, names: string[]): Record<string, unknown> {
  if (types.isProxy(value)) fail('INVALID_INPUT');
  object(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== 'string' || !names.includes(key)) ||
    names.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))
  )
    fail('INVALID_INPUT');
  return Object.fromEntries(names.map((key) => [key, descriptors[key]!.value]));
}
function copiedEpoch(raw: unknown): Epoch {
  const e = closed(raw, ['id', 'generation', 'consentRevision']);
  text(e.id, 128);
  for (const key of ['generation', 'consentRevision'])
    if (!Number.isSafeInteger(e[key]) || (e[key] as number) < 0) fail('INVALID_INPUT');
  return { id: e.id, generation: e.generation as number, consentRevision: e.consentRevision as number };
}
function copiedRefs(raw: unknown): SourceRef[] {
  if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    fail('INVALID_INPUT');
  const length = Object.getOwnPropertyDescriptor(raw, 'length')!.value as number;
  if (length > 32) fail('GROWTH_LIMIT');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== length + 1) fail('INVALID_INPUT');
  const result: SourceRef[] = [];
  for (let i = 0; i < length; i++) {
    const d = descriptors[String(i)];
    if (!d || !Object.hasOwn(d, 'value')) fail('INVALID_INPUT');
    const r = closed(d.value, ['id', 'revision']);
    text(r.id, 128);
    if (!Number.isSafeInteger(r.revision) || (r.revision as number) < 1) fail('INVALID_INPUT');
    result.push({ id: r.id, revision: r.revision as number });
  }
  return result.length ? refs(result) : [];
}
const actual = (): GrowthEntryRecord['actual'] => ({
  parametricTrainingPerformed: false,
  modelCalls: 0,
  lintCalled: false,
  lintCompleted: false,
  revalidationCalled: false,
  revalidationCompleted: false,
  semanticQuality: 'NOT_EVALUATED',
  artifactProduction: 'NOT_RUN',
  modelActivation: 'NOT_RUN',
  counts: null,
});
const envelope = (record: GrowthRecord) => ({ format: 'growth-journal-v1', assurance: 'DECLARATION_ARCHIVE', record });
const encoded = (record: GrowthRecord) => normalizeSceneJson(JSON.stringify(envelope(record)));
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.:-]/g, '_');
function markdown(record: GrowthRecord): string {
  const lines = [
    '# Growth journal declaration archive',
    '',
    'Assurance: NOT_AUTHENTICATED. Exported receipts are historical declarations, not live capabilities.',
    'Actual parametric training: 0. Model calls: 0. Semantic quality: NOT_EVALUATED.',
    '',
    `Source references: ${record.sourceRefs.length}. Unique roots: ${record.rootRefs.length}.`,
    '',
  ];
  for (const entry of record.entries) {
    lines.push(
      `## ${safe(entry.id)}`,
      `Plan: ${entry.kind}. Attempt: ${entry.attempt}.`,
      `Archive declares local curation: lint called=${entry.actual.lintCalled}; lint completed=${entry.actual.lintCompleted}; revalidation completed=${entry.actual.revalidationCompleted}.`,
    );
    if (entry.actual.counts)
      lines.push(
        `Declaration rows: ${entry.actual.counts.inputRows}; admitted: ${entry.actual.counts.admitted}. This is not a semantic evaluation PASS.`,
      );
    if (entry.simulation)
      lines.push(
        'SYNTHETIC_REPLAY ONLY; the following values do not describe real training or model activation.',
        `Simulated training occurred: ${entry.simulation.trainingOccurred === null ? 'UNKNOWN' : entry.simulation.trainingOccurred}; steps lower bound: ${entry.simulation.stepsLowerBound}; artifact produced: ${entry.simulation.artifactProduced === null ? 'UNKNOWN' : entry.simulation.artifactProduced}.`,
        `Simulated evaluation: ${entry.simulation.evaluation}; ever activated: ${entry.simulation.everActivated === null ? 'UNKNOWN' : entry.simulation.everActivated}; activation: ${entry.simulation.activation}.`,
      );
    for (const receipt of entry.receipts)
      lines.push(`- Receipt ${receipt.sequence}: ${receipt.source} / ${receipt.phase}`);
    lines.push('');
  }
  const output = lines.join('\n');
  if (Buffer.byteLength(output) > GROWTH_LIMITS.bytes) fail('GROWTH_LIMIT');
  return output;
}

/** Untrusted archives are closed, bounded declaration records, never receipt issuers. */
export function parseGrowthArchive(raw: string): Frozen<{ assurance: 'NOT_AUTHENTICATED'; record: GrowthRecord }> {
  const outer = closed(parseSceneJson(raw), ['format', 'assurance', 'record']);
  if (outer.format !== 'growth-journal-v1' || outer.assurance !== 'DECLARATION_ARCHIVE') fail('GROWTH_ARCHIVE_INVALID');
  const r = closed(outer.record, ['version', 'scope', 'sourceRefs', 'rootRefs', 'entries']);
  if (r.version !== 1) fail('GROWTH_ARCHIVE_INVALID');
  const scope = copiedEpoch(r.scope),
    sourceRefs = copiedRefs(r.sourceRefs);
  // Root refs can be larger than the selected pool, but never exceed the closure budget.
  if (!Array.isArray(r.rootRefs) || r.rootRefs.length > 128) fail('GROWTH_ARCHIVE_INVALID');
  const rootRefs = (r.rootRefs as unknown[]).map((ref) => copiedRefs([ref])[0]!);
  if (new Set(rootRefs.map((ref) => ref.id)).size !== rootRefs.length) fail('GROWTH_ARCHIVE_INVALID');
  if (!Array.isArray(r.entries) || r.entries.length > GROWTH_LIMITS.entries) fail('GROWTH_LIMIT');
  const entries: GrowthEntryRecord[] = [];
  let total = 0;
  const phases: ReceiptPhase[] = [
    'PLANNED',
    'STARTED',
    'LINT_CALLED',
    'LINT_COMPLETED',
    'REVALIDATE_CALLED',
    'REVALIDATE_COMPLETED',
    'COMPLETED',
    'FAILED',
    'ABORTED',
    'UNKNOWN',
    'REFUSED',
    'SIM_STEP',
    'SIM_ARTIFACT',
    'SIM_EVALUATED',
    'SIM_EVAL_UNKNOWN',
    'SIM_ACTIVATED',
    'SIM_ROLLED_BACK',
  ];
  for (const input of r.entries) {
    const e = closed(input, ['id', 'kind', 'attempt', 'actual', 'simulation', 'receipts']);
    if (
      typeof e.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(e.id) ||
      !['curation_lint', 'synthetic_replay'].includes(e.kind as string) ||
      !['NOT_STARTED', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED', 'UNKNOWN', 'REFUSED'].includes(e.attempt as string)
    )
      fail('GROWTH_ARCHIVE_INVALID');
    const a = closed(e.actual, Object.keys(actual()));
    if (
      a.parametricTrainingPerformed !== false ||
      a.modelCalls !== 0 ||
      a.semanticQuality !== 'NOT_EVALUATED' ||
      a.artifactProduction !== 'NOT_RUN' ||
      a.modelActivation !== 'NOT_RUN'
    )
      fail('GROWTH_ARCHIVE_INVALID');
    for (const key of ['lintCalled', 'lintCompleted', 'revalidationCalled', 'revalidationCompleted'])
      if (typeof a[key] !== 'boolean') fail('GROWTH_ARCHIVE_INVALID');
    if (a.counts !== null) {
      const counts = closed(a.counts, [
        'selected',
        'roots',
        'groups',
        'inputRows',
        'admitted',
        'train',
        'eval',
        'quarantined',
        'duplicates',
      ]);
      for (const value of Object.values(counts))
        if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 128)
          fail('GROWTH_ARCHIVE_INVALID');
    }
    if (e.simulation !== null) {
      const s = closed(e.simulation, [
        'trainingOccurred',
        'stepsLowerBound',
        'artifactProduced',
        'evaluation',
        'everActivated',
        'activation',
      ]);
      for (const key of ['trainingOccurred', 'artifactProduced', 'everActivated'])
        if (s[key] !== null && typeof s[key] !== 'boolean') fail('GROWTH_ARCHIVE_INVALID');
      if (
        !Number.isSafeInteger(s.stepsLowerBound) ||
        (s.stepsLowerBound as number) < 0 ||
        (s.stepsLowerBound as number) > 1 ||
        !['NOT_RUN', 'PASS', 'FAIL', 'UNKNOWN'].includes(s.evaluation as string) ||
        !['NOT_ACTIVE', 'ACTIVE', 'ROLLED_BACK', 'UNKNOWN'].includes(s.activation as string)
      )
        fail('GROWTH_ARCHIVE_INVALID');
    }
    if (
      !Array.isArray(e.receipts) ||
      e.receipts.length > GROWTH_LIMITS.receiptsPerEntry ||
      (total += e.receipts.length) > GROWTH_LIMITS.receipts
    )
      fail('GROWTH_LIMIT');
    for (const [index, item] of e.receipts.entries()) {
      const receipt = closed(item, ['sequence', 'source', 'phase']);
      if (
        receipt.sequence !== index + 1 ||
        !['CONTROL_OBSERVED', 'CORE_OPERATION_OBSERVED', 'SYNTHETIC_REPLAY'].includes(receipt.source as string) ||
        !phases.includes(receipt.phase as ReceiptPhase)
      )
        fail('GROWTH_ARCHIVE_INVALID');
    }
    entries.push(e as GrowthEntryRecord);
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) fail('GROWTH_ARCHIVE_INVALID');
  return frozenCopy({
    assurance: 'NOT_AUTHENTICATED' as const,
    record: { version: 1 as const, scope, sourceRefs, rootRefs, entries },
  });
}
export function renderGrowthArchive(raw: string): string {
  return markdown(parseGrowthArchive(raw).record as GrowthRecord);
}

export class GrowthJournalService {
  #store: MemoryStore;
  #policy: Frozen<CurationPolicy>;
  #journals = new WeakMap<GrowthJournal, Journal>();
  #entries = new WeakMap<GrowthEntry, Entry>();
  #views = new WeakMap<GrowthView, View>();
  constructor(store: MemoryStore, curationPolicyJson: string) {
    if (typeof curationPolicyJson !== 'string') fail('INVALID_INPUT');
    this.#policy = curationPolicy(parseJson(curationPolicyJson) as CurationPolicy);
    this.#store = store;
  }
  bind(value: { epoch: Epoch; publishedRefs: SourceRef[] }): GrowthJournal {
    const input = closed(value, ['epoch', 'publishedRefs']),
      epoch = copiedEpoch(input.epoch),
      selected = copiedRefs(input.publishedRefs);
    const snapshot = this.#store.sceneSourceSnapshot(epoch, selected),
      ticket = this.#store.beginRun(epoch);
    if (snapshot.authority.runtimeEpoch !== ticket.runtimeEpoch) fail('GROWTH_WRITE_FENCED');
    const handle: GrowthJournal = Object.freeze({ version: 1 });
    this.#journals.set(handle, {
      epoch: frozenCopy(epoch),
      refs: frozenCopy(selected),
      roots: frozenCopy(snapshot.roots.map((root) => root.ref)),
      identity: snapshot.metadataIdentity,
      lastAsOf: snapshot.asOf,
      ticket,
      writeFenced: false,
      invalid: false,
      entries: [],
    });
    return handle;
  }
  #journal(handle: GrowthJournal): Journal {
    const j = this.#journals.get(handle);
    if (!j) fail('UNAUTHENTICATED');
    return j;
  }
  #entry(j: Journal, handle: GrowthEntry): Entry {
    const e = this.#entries.get(handle);
    if (!e || e.journal !== j) fail('UNAUTHENTICATED');
    return e;
  }
  #source(j: Journal, epoch: Epoch) {
    if (j.invalid) fail('GROWTH_SOURCE_INVALID');
    if (canonical(epoch) !== canonical(j.epoch)) fail('GROWTH_AUTHORITY_MISMATCH');
    try {
      const snapshot = this.#store.sceneSourceSnapshot(
        epoch,
        j.refs.map((ref) => ({ ...ref })),
      );
      if (snapshot.asOf < j.lastAsOf) fail('GROWTH_CLOCK_ROLLBACK');
      if (snapshot.metadataIdentity !== j.identity) fail('GROWTH_SOURCE_CHANGED');
      j.lastAsOf = snapshot.asOf;
      return snapshot;
    } catch (error) {
      j.invalid = true;
      j.writeFenced = true;
      throw error;
    }
  }
  #write(j: Journal) {
    if (j.writeFenced) fail('GROWTH_WRITE_FENCED');
    const snapshot = this.#source(j, { ...j.epoch });
    try {
      this.#store.validateRun(j.ticket);
    } catch (error) {
      j.writeFenced = true;
      throw error;
    }
    return snapshot;
  }
  #record(j: Journal, entries = j.entries.map((entry) => entry.record)): GrowthRecord {
    return {
      version: 1,
      scope: { ...j.epoch },
      sourceRefs: j.refs.map((ref) => ({ ...ref })),
      rootRefs: j.roots.map((ref) => ({ ...ref })),
      entries,
    };
  }
  #capacity(j: Journal, entries: GrowthEntryRecord[]): void {
    if (
      entries.length > GROWTH_LIMITS.entries ||
      entries.some((e) => e.receipts.length > GROWTH_LIMITS.receiptsPerEntry) ||
      entries.reduce((sum, e) => sum + e.receipts.length, 0) > GROWTH_LIMITS.receipts
    )
      fail('GROWTH_LIMIT');
    const record = this.#record(j, entries);
    encoded(record);
    markdown(record);
  }
  #reserve(j: Journal, e: Entry): void {
    const preview = structuredClone(e.record);
    preview.attempt = 'COMPLETED';
    preview.actual.counts = {
      selected: 128,
      roots: 128,
      groups: 128,
      inputRows: 128,
      admitted: 128,
      train: 128,
      eval: 128,
      quarantined: 128,
      duplicates: 128,
    };
    preview.simulation = {
      trainingOccurred: false,
      stepsLowerBound: 1,
      artifactProduced: false,
      evaluation: 'UNKNOWN',
      everActivated: false,
      activation: 'ROLLED_BACK',
    };
    for (let i = 0; i < GROWTH_LIMITS.reserveReceipts; i++)
      preview.receipts.push({
        sequence: preview.receipts.length + 1,
        source: 'CORE_OPERATION_OBSERVED',
        phase: 'REVALIDATE_COMPLETED',
      });
    this.#capacity(
      j,
      j.entries.map((entry) => (entry === e ? preview : entry.record)),
    );
  }
  #append(e: Entry, source: GrowthReceipt['source'], phase: ReceiptPhase): void {
    e.record.receipts.push({ sequence: e.record.receipts.length + 1, source, phase });
  }
  plan(handle: GrowthJournal, value: { id: string; kind: GrowthKind }): GrowthEntry {
    const input = closed(value, ['id', 'kind']);
    if (
      typeof input.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(input.id) ||
      !['curation_lint', 'synthetic_replay'].includes(input.kind as string)
    )
      fail('INVALID_INPUT');
    const j = this.#journal(handle);
    this.#write(j);
    if (j.entries.some((e) => e.record.id === input.id)) fail('GROWTH_ENTRY_CONFLICT');
    const record: GrowthEntryRecord = {
      id: input.id,
      kind: input.kind as GrowthKind,
      attempt: 'NOT_STARTED',
      actual: actual(),
      simulation: null,
      receipts: [{ sequence: 1, source: 'CONTROL_OBSERVED', phase: 'PLANNED' }],
    };
    this.#capacity(j, [...j.entries.map((e) => e.record), record]);
    const entry: GrowthEntry = Object.freeze({ version: 1 }),
      saved = { journal: j, record, requestDigest: null };
    j.entries.push(saved);
    this.#entries.set(entry, saved);
    return entry;
  }
  runCuration(handle: GrowthJournal, entry: GrowthEntry, raw: string) {
    // Parse/copy all untrusted declarations before entering the authority gate.
    if (typeof raw !== 'string') fail('INVALID_INPUT');
    const normalized = canonical(curationRequest(raw)),
      requestDigest = digest(normalized);
    const j = this.#journal(handle),
      e = this.#entry(j, entry);
    if (e.record.kind !== 'curation_lint') fail('GROWTH_KIND_MISMATCH');
    this.#write(j);
    if (e.requestDigest !== null) {
      if (e.requestDigest !== requestDigest) fail('GROWTH_ATTEMPT_CONFLICT');
      return frozenCopy(e.record);
    }
    this.#reserve(j, e);
    e.requestDigest = requestDigest;
    e.record.attempt = 'RUNNING';
    this.#append(e, 'CONTROL_OBSERVED', 'STARTED');
    const curation = new CurationService(this.#store, this.#policy as CurationPolicy);
    let binding;
    try {
      binding = curation.bind({ epoch: { ...j.epoch }, publishedRefs: j.refs.map((ref) => ({ ...ref })) });
      e.record.actual.lintCalled = true;
      this.#append(e, 'CORE_OPERATION_OBSERVED', 'LINT_CALLED');
      const result = curation.lint(binding, normalized);
      e.record.actual.lintCompleted = true;
      e.record.actual.counts = { ...result.report.counts };
      this.#append(e, 'CORE_OPERATION_OBSERVED', 'LINT_COMPLETED');
      this.#write(j);
      e.record.actual.revalidationCalled = true;
      this.#append(e, 'CORE_OPERATION_OBSERVED', 'REVALIDATE_CALLED');
      curation.revalidate(binding, result.candidate);
      e.record.actual.revalidationCompleted = true;
      this.#append(e, 'CORE_OPERATION_OBSERVED', 'REVALIDATE_COMPLETED');
      this.#write(j);
      e.record.attempt = 'COMPLETED';
      this.#append(e, 'CORE_OPERATION_OBSERVED', 'COMPLETED');
    } catch {
      // Never retain arbitrary exception messages, annotations, private manifests or their hashes.
      e.record.attempt = e.record.actual.lintCalled ? 'FAILED' : 'REFUSED';
      this.#append(e, e.record.actual.lintCalled ? 'CORE_OPERATION_OBSERVED' : 'CONTROL_OBSERVED', e.record.attempt);
    } finally {
      if (binding) curation.unbind(binding);
    }
    // A failed call is still an authorized data delivery. Keep observations internally,
    // but never turn catch into a route around source invalidation or the write fence.
    this.#write(j);
    return frozenCopy(e.record);
  }
  runSynthetic(handle: GrowthJournal, entry: GrowthEntry, scenario: GrowthScenario) {
    const trace = syntheticGrowthTrace(scenario),
      j = this.#journal(handle),
      e = this.#entry(j, entry);
    if (e.record.kind !== 'synthetic_replay') fail('GROWTH_KIND_MISMATCH');
    this.#write(j);
    const requestDigest = digest(scenario);
    if (e.requestDigest !== null) {
      if (e.requestDigest !== requestDigest) fail('GROWTH_ATTEMPT_CONFLICT');
      return frozenCopy(e.record);
    }
    this.#reserve(j, e);
    e.requestDigest = requestDigest;
    for (const phase of trace.phases) this.#append(e, 'SYNTHETIC_REPLAY', phase);
    e.record.simulation = trace.state;
    e.record.attempt = trace.terminal;
    return frozenCopy(e.record);
  }
  bindView(handle: GrowthJournal, value: { epoch: Epoch }): GrowthView {
    const input = closed(value, ['epoch']),
      epoch = copiedEpoch(input.epoch),
      j = this.#journal(handle),
      snapshot = this.#source(j, epoch);
    const view: GrowthView = Object.freeze({ version: 1 });
    this.#views.set(view, { journal: j, epoch, runtimeEpoch: snapshot.authority.runtimeEpoch });
    return view;
  }
  read(handle: GrowthView) {
    const view = this.#views.get(handle);
    if (!view) fail('UNAUTHENTICATED');
    const snapshot = this.#source(view.journal, view.epoch);
    if (snapshot.authority.runtimeEpoch !== view.runtimeEpoch) {
      this.#views.delete(handle);
      fail('GROWTH_VIEW_REBIND_REQUIRED');
    }
    return frozenCopy({
      ...this.#record(view.journal),
      assurance: 'CURRENT_AUTHORIZED_LOCAL_VIEW' as const,
      asOf: snapshot.asOf,
    });
  }
  exportJson(handle: GrowthView): string {
    const { assurance: _, asOf: __, ...record } = this.read(handle);
    return encoded(record as GrowthRecord);
  }
  exportMarkdown(handle: GrowthView): string {
    return renderGrowthArchive(this.exportJson(handle));
  }
}
