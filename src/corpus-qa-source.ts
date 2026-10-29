import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, shape, stop } from './wf1-json.ts';
import { createArtifactBroker } from './wf1-storage.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import { validateTokenizerProfile } from './corpus-tokenizer.ts';
import { TEACHER_TOKENIZER_ASSETS } from './corpus-teacher-tokenizer.ts';
import {
  STUDENT_TARGET,
  productionAttemptPending,
  validateProductionCandidate,
  validateProductionRegistry,
  validateProductionSpec,
} from './corpus-production-types.ts';
import type { ProductionSpec, ScopedRef } from './corpus-production-types.ts';
import type { ProductionStore } from './corpus-production-store.ts';
import {
  FACTORY_BASELINE_DIGEST,
  parseAudit,
  requireAuditAdmission,
  requireQaPurpose,
  validateAuditSelection,
  validateAuditSpec,
} from './corpus-qa-types.ts';
import type { AuditAdmission, AuditSelection, AuditSpec, SelectionEntry } from './corpus-qa-types.ts';

export type QaSelectedReader = {
  selectionDigest: string;
  check: () => void;
  read: (caseId: string) => { rowDigest: string; prompt: string; response: string };
  close: () => void;
};
function plain(path: string, max: number) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size < 1 || s.size > max) stop('CQA_SOURCE_FILE');
  return s;
}
function fileDigest(path: string, max: number) {
  plain(path, max);
  return hash(readFileSync(path));
}
function stamp(path: string, max: number) {
  plain(path, max);
  const s = statSync(path, { bigint: true });
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
/** Capture only eligible row/candidate/token bytes while the original inspect
 * authority is still valid. No requests, raw, reasoning, plan or rejected body. */
export function prepareQualitySelection(options: {
  store: ProductionStore;
  sourceRuntimeRoot: string;
  sourceAuthorityPath: string;
  seed: string;
  authorize: () => void;
}): AuditSelection {
  const { store } = options;
  options.authorize();
  const authority = store.check(false),
    state = store.snapshot();
  if (
    !state ||
    state.status === 'ACTIVE' ||
    !state.exportRef ||
    state.attempts.some((a) => productionAttemptPending(state.spec, a)) ||
    !authority.head
  )
    stop('CQA_SOURCE_STATE');
  const sourceHead = authority.head,
    registry = validateProductionRegistry(parseAudit(store.read(state.registryRef).toString('utf8')), state.spec),
    items = state.items.filter(
      (i) => i.status === 'ACCEPTED' && !state.heldFamilies.includes(registry.slots[i.ordinal]!.familyId),
    ),
    exportBytes = store.read(state.exportRef),
    exported = parseAudit(exportBytes.toString('utf8')) as unknown as {
      version: string;
      jobId: string;
      rows: number;
      tokenRefs: ScopedRef[];
      shards: ScopedRef[];
    };
  if (
    exported.version !==
      (state.spec.version === 'CorpusProduction/0.2' ? 'CorpusProductionExport/0.2' : 'CorpusProductionExport/0.1') ||
    exported.jobId !== state.spec.jobId ||
    exported.rows !== items.length ||
    canonical(exported.tokenRefs) !== canonical(state.tokenRefs) ||
    canonical(exported.shards) !== canonical(state.shards)
  )
    stop('CQA_SOURCE_EXPORT');
  const measurements = new Map<string, { ref: ScopedRef; value: SelectionEntry['measurement'] }>();
  let tokenizerProfileDigest: string | null = null;
  for (const ref of state.tokenRefs) {
    options.authorize();
    const receipt = parseAudit(store.read(ref).toString('utf8')) as unknown as {
      version: string;
      profile: unknown;
      measurements: SelectionEntry['measurement'][];
      rowRefs: ScopedRef[];
      unitIds: string[];
      studentTargetDigest: string;
      factoryBaselineDigest: string;
      purposeDigest: string;
    };
    if (
      receipt.version !== 'CorpusProductionTokenReceipt/0.1' ||
      receipt.studentTargetDigest !== state.spec.studentTargetDigest ||
      receipt.factoryBaselineDigest !== state.spec.factoryBaselineDigest ||
      receipt.purposeDigest !== state.spec.purposeDigest
    )
      stop('CQA_SOURCE_TOKEN');
    const profile = validateTokenizerProfile(receipt.profile);
    if (
      profile.model !== STUDENT_TARGET.repo ||
      profile.revision !== STUDENT_TARGET.revision ||
      profile.tokenizerSha256 !== TEACHER_TOKENIZER_ASSETS.tokenizerSha256 ||
      profile.templateSha256 !== TEACHER_TOKENIZER_ASSETS.templateSha256
    )
      stop('CQA_SOURCE_TOKEN');
    const d = hash(canonical(profile));
    if (tokenizerProfileDigest && tokenizerProfileDigest !== d) stop('CQA_SOURCE_TOKEN');
    tokenizerProfileDigest = d;
    if (
      !Array.isArray(receipt.measurements) ||
      receipt.measurements.length !== receipt.rowRefs.length ||
      receipt.measurements.length !== receipt.unitIds.length
    )
      stop('CQA_SOURCE_TOKEN');
    for (const [index, m] of receipt.measurements.entries()) {
      const item = items.find((i) => i.unitId === receipt.unitIds[index]);
      if (
        !item ||
        canonical(item.rowRef) !== canonical(receipt.rowRefs[index]) ||
        measurements.has(item.unitId) ||
        m.tokenizerProfileDigest !== d
      )
        stop('CQA_SOURCE_TOKEN');
      measurements.set(item.unitId, { ref, value: m });
    }
  }
  if (!tokenizerProfileDigest || measurements.size !== items.length) stop('CQA_SOURCE_TOKEN');
  const entries = items.map((item) => {
    options.authorize();
    const bytes = store.read(item.rowRef!),
      rowDigest = hash(bytes),
      measurement = measurements.get(item.unitId)!;
    const entry: SelectionEntry = {
      caseId: 'case-' + hash(options.seed + '\n' + rowDigest).slice(0, 32),
      sourceRowRef: item.rowRef!,
      rowDigest,
      candidateRef: item.candidateRef!,
      candidateDigest: item.candidateDigest!,
      unit: registry.slots[item.ordinal]!,
      tokenReceiptRef: measurement.ref,
      measurement: measurement.value,
    };
    validateSelectedRow(entry, bytes, store.read(entry.candidateRef), state.spec);
    return entry;
  });
  const populationDigest = hash(
    canonical(
      entries
        .map((e) => ({ unitId: e.unit.unitId, rowDigest: e.rowDigest }))
        .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)),
    ),
  );
  entries.sort((a, b) => {
    const x = hash(options.seed + '\n' + populationDigest + '\n' + a.rowDigest),
      y = hash(options.seed + '\n' + populationDigest + '\n' + b.rowDigest);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const selection = validateAuditSelection({
    version: 'CorpusQualitySelection/0.1',
    source: {
      jobId: state.spec.jobId,
      specDigest: hash(canonical(state.spec)),
      buildDigest: state.spec.buildDigest,
      profileDigest: state.spec.profileDigest,
      committedHead: sourceHead,
      ledgerFileDigest: fileDigest(join(options.sourceRuntimeRoot, 'corpus-production.sqlite'), 67108864),
      authorityFileDigest: fileDigest(options.sourceAuthorityPath, 16384),
      exportRef: state.exportRef,
      exportDigest: hash(exportBytes),
      registryDigest: state.spec.registryDigest,
      purposeDigest: state.spec.purposeDigest,
      tokenizerProfileDigest,
      parentGrantIds: registry.parentGrantIds,
    },
    entries,
    scope: 'SELECTED_ELIGIBLE_ONLY',
    providerReaudit: 'NOT_PERFORMED',
    excludedContentRead: false,
    ordering: { algorithm: 'SHA256_SEED_POPULATION_ROW', seed: options.seed },
    populationDigest,
  });
  options.authorize();
  if (store.check(false).head !== sourceHead) stop('CQA_SOURCE_CHANGED');
  return selection;
}
function validateSelectedRow(entry: SelectionEntry, bytes: Buffer, candidateBytes: Buffer, spec: ProductionSpec) {
  if (hash(bytes) !== entry.rowDigest) stop('CQA_SOURCE_ROW');
  const row = parseAudit(bytes.toString('utf8')) as unknown as {
    version: string;
    jobId: string;
    unit: unknown;
    candidate: unknown;
    candidateDigest: string;
    candidateRef: unknown;
    purposeDigest: string;
    factoryBaselineDigest: string;
    studentTargetDigest: string;
    evidenceClass: string;
    exactVerified: boolean;
    manualChecked: boolean;
    trainingReady: boolean;
    trainingJobPolicy: string;
  };
  const candidate = validateProductionCandidate(parseAudit(candidateBytes.toString('utf8')), entry.unit.unitId);
  if (
    row.version !==
      (spec.version === 'CorpusProduction/0.2' ? 'QualifiedProductionItem/0.2' : 'QualifiedProductionItem/0.1') ||
    row.jobId !== spec.jobId ||
    canonical(row.unit) !== canonical(entry.unit) ||
    canonical(row.candidate) !== canonical(candidate) ||
    row.candidateDigest !== entry.candidateDigest ||
    hash(canonical(candidate)) !== entry.candidateDigest ||
    canonical(row.candidateRef) !== canonical(entry.candidateRef) ||
    row.purposeDigest !== spec.purposeDigest ||
    row.factoryBaselineDigest !== FACTORY_BASELINE_DIGEST ||
    row.studentTargetDigest !== spec.studentTargetDigest ||
    row.evidenceClass !== 'MODEL_REVIEWED' ||
    row.exactVerified !== false ||
    row.manualChecked !== false ||
    row.trainingReady !== false ||
    row.trainingJobPolicy !== 'NOT_AUTHORIZED'
  )
    stop('CQA_SOURCE_ROW');
  return { rowDigest: entry.rowDigest, prompt: candidate.prompt, response: candidate.response };
}
/** Historical bytes are authorized by a NEW selection grant, never by old time
 * or revived sender rights. This reader exposes case IDs only, no arbitrary ref. */
export function openQualityArchive(options: {
  approvedTrainingRoot: string;
  sourceRuntimeRoot: string;
  sourceAuthorityPath: string;
  sourceSpec: ProductionSpec;
  selection: AuditSelection;
  spec: AuditSpec;
  key: Uint8Array;
  admission: () => AuditAdmission;
  now?: () => number;
}): QaSelectedReader {
  options = { ...options, sourceSpec: validateProductionSpec(options.sourceSpec) };
  const selection = validateAuditSelection(options.selection),
    spec = validateAuditSpec(options.spec),
    selectionDigest = hash(canonical(selection));
  if (
    selectionDigest !== spec.selectionDigest ||
    selection.populationDigest !== spec.populationDigest ||
    selection.entries.length !== spec.rowCount ||
    hash(canonical(options.sourceSpec)) !== selection.source.specDigest
  )
    stop('CQA_SOURCE_BINDING');
  requireTrainingBinding(
    options.approvedTrainingRoot,
    options.sourceRuntimeRoot,
    options.sourceSpec.storageBindingDigest,
    options.sourceAuthorityPath,
  );
  if (options.key.length !== 32) stop('CQA_KEY');
  const key = Buffer.from(options.key),
    ledger = join(options.sourceRuntimeRoot, 'corpus-production.sqlite'),
    authority = options.sourceAuthorityPath;
  let closed = false;
  const brokers = new Map<string, ReturnType<typeof createArtifactBroker>['train']>();
  try {
    if (
      fileDigest(ledger, 67108864) !== selection.source.ledgerFileDigest ||
      fileDigest(authority, 16384) !== selection.source.authorityFileDigest
    )
      stop('CQA_SOURCE_CHANGED');
  } catch (error) {
    key.fill(0);
    throw error;
  }
  const ledgerStamp = stamp(ledger, 67108864),
    authorityStamp = stamp(authority, 16384);
  const check = () => {
    if (closed) stop('CQA_CLOSED');
    const admission = requireAuditAdmission(spec, options.admission(), options.now?.() ?? Date.now());
    requireQaPurpose(admission.purposes, options.sourceSpec.coordinator, 'curriculum', selection.source.parentGrantIds);
    requireQaPurpose(admission.purposes, options.sourceSpec.coordinator, 'training', selection.source.parentGrantIds);
    for (const pool of options.sourceSpec.pools) {
      requireQaPurpose(admission.purposes, pool.generator, 'generate', selection.source.parentGrantIds);
      requireQaPurpose(admission.purposes, pool.generator, 'training', selection.source.parentGrantIds);
      requireQaPurpose(admission.purposes, pool.reviewer, 'review', selection.source.parentGrantIds);
      requireQaPurpose(admission.purposes, pool.reviewer, 'training', selection.source.parentGrantIds);
    }
    if (
      admission.grant.sourcePurposeDigest !== selection.source.purposeDigest ||
      stamp(ledger, 67108864) !== ledgerStamp ||
      stamp(authority, 16384) !== authorityStamp
    )
      stop('CQA_SOURCE_CHANGED');
  };
  const allowed = new Set(
    selection.entries.flatMap((e) => [
      canonical(e.sourceRowRef),
      canonical(e.candidateRef),
      canonical(e.tokenReceiptRef),
    ]),
  );
  allowed.add(canonical(selection.source.exportRef));
  const read = (ref: ScopedRef) => {
    check();
    if (!allowed.has(canonical(ref))) stop('CQA_READ_SCOPE');
    let broker = brokers.get(ref.bucket);
    if (!broker) {
      broker = createArtifactBroker(
        join(options.sourceRuntimeRoot, 'objects', ref.bucket),
        selection.source.jobId + ':' + ref.bucket,
        key,
        check,
      ).train;
      brokers.set(ref.bucket, broker);
    }
    const bytes = broker.read(ref.ref);
    check();
    return bytes;
  };
  try {
    check();
    if (hash(read(selection.source.exportRef)) !== selection.source.exportDigest) stop('CQA_SOURCE_EXPORT');
  } catch (error) {
    key.fill(0);
    throw error;
  }
  return Object.freeze({
    selectionDigest,
    check,
    read(caseId: string) {
      check();
      const entry = selection.entries.find((e) => e.caseId === caseId);
      if (!entry) stop('CQA_READ_SCOPE');
      const result = validateSelectedRow(entry, read(entry.sourceRowRef), read(entry.candidateRef), options.sourceSpec);
      const receipt = parseAudit(read(entry.tokenReceiptRef).toString('utf8')) as unknown as {
        measurements: unknown[];
      };
      if (
        !Array.isArray(receipt.measurements) ||
        !receipt.measurements.some((m) => canonical(m) === canonical(entry.measurement))
      )
        stop('CQA_SOURCE_TOKEN');
      return result;
    },
    close() {
      closed = true;
      key.fill(0);
      brokers.clear();
    },
  });
}
