import {
  canonical,
  copyJson,
  digest,
  hash,
  id,
  integer,
  list,
  oneOf,
  parseJson,
  shape,
  stop,
  text,
  unique,
} from './wf1-json.ts';
import type { AuditSelection, AuditSpec, SelectionEntry } from './corpus-qa-types.ts';
import type { ScopedRef } from './corpus-production-types.ts';

// Frozen f1 wire profile. Do not import evolving target/model/tokenizer constants.
export const QA_LEGACY_F1 = Object.freeze({
  buildDigest: 'f1b8d25398fc287bc665a2faea38ef00f69a236815057e799b3591fca6e0e9c9',
  profileDigest: '68e28a598ac3f07af29fd07a25e72455c9efa545f494622883d2348648dc1475',
  baselineDigest: '62bb556b5b2cb61091897af74ba043cef9b7b65535c657339338575114ae6fb8',
  auditTargetBaselineDigest: 'c91efe1677d0875258c11366b3ce2f743188e8abbfef5f57d53b17e0c7a455cf',
  studentTargetDigest: '8640154a795e1ecfdcec0a8e335b1bdc20b2d051352a907d32ab29a6e3965e84',
});
// Separately reviewed F2 writer: output contract and safe failure-code changes
// only. Storage, source, targets, tokenizer and crypto retain the F1 wire rules.
export const QA_LEGACY_F2 = Object.freeze({
  ...QA_LEGACY_F1,
  buildDigest: '6f3fdad98aeeb67c9daddb7c05f5b972d7ce0c1f437939e9850967542bd8ba1c',
  profileDigest: 'a782b492ab39749bf6cf627d824d2a8d89a4d1627fb8bf204d30e0fba810699f',
});
export const QA_LEGACY_SCHEMA = Object.freeze([
  'CREATE TABLE events(sequence INTEGER PRIMARY KEY, previous TEXT NOT NULL, ref TEXT NOT NULL, digest TEXT NOT NULL)',
  'CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
  'CREATE TABLE attempts(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE cases(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
]);
export const legacyJson = (raw: string) =>
  parseJson(raw, { bytes: 262144, depth: 24, nodes: 16384, stringBytes: 65536 });
export function legacyRef(input: unknown): ScopedRef {
  const s = shape(input, ['bucket', 'ref']),
    r = shape(s.ref, ['id', 'kind', 'partition', 'bytes', 'digest']);
  if (
    !/^(meta|event-\d+|attempt-\d+|shard-\d+|tokens-\d+)$/.test(text(s.bucket, 64)) ||
    typeof r.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.id) ||
    r.partition !== 'train'
  )
    stop('CQA_ARCHIVE_REF');
  id(r.kind);
  integer(r.bytes, 28, 262172);
  digest(r.digest);
  return s as unknown as ScopedRef;
}
export function legacySpec(input: unknown, profile: 'QA_F1' | 'QA_F2' = 'QA_F1'): AuditSpec {
  const s = shape(copyJson(input), [
    'version',
    'auditId',
    'buildDigest',
    'profileDigest',
    'selectionDigest',
    'populationDigest',
    'readGrantDigest',
    'purposeDigest',
    'objectiveDigest',
    'baselineDigest',
    'auditTargetBaselineDigest',
    'studentTargetDigest',
    'storageBindingDigest',
    'authorityRevision',
    'runtimeId',
    'createdAt',
    'expiresAt',
    'rowCount',
    'coordinator',
    'reviewer',
    'prices',
  ]);
  const frozen = profile === 'QA_F1' ? QA_LEGACY_F1 : profile === 'QA_F2' ? QA_LEGACY_F2 : stop('CQA_ARCHIVE_PROFILE');
  if (s.version !== 'CorpusQualityAudit/0.1' || Object.entries(frozen).some(([k, v]) => s[k] !== v))
    stop('CQA_ARCHIVE_PROFILE');
  for (const k of [
    'selectionDigest',
    'populationDigest',
    'readGrantDigest',
    'purposeDigest',
    'objectiveDigest',
    'storageBindingDigest',
  ])
    digest(s[k]);
  id(s.auditId);
  id(s.runtimeId);
  integer(s.authorityRevision, 1);
  integer(s.createdAt);
  integer(s.expiresAt, Number(s.createdAt) + 1, Number(s.createdAt) + 86400000);
  integer(s.rowCount, 1, 192);
  for (const [field, provider, model, service] of [
    ['coordinator', 'deepseek', 'deepseek-flash', 'deepseek-official-api'],
    ['reviewer', 'together', 'openai/gpt-oss-120b', 'together-serverless-api'],
  ]) {
    const r = shape(s[field!], ['provider', 'model', 'service', 'accountType', 'accountRef']);
    if (r.provider !== provider || r.model !== model || r.service !== service || r.accountType !== 'api')
      stop('CQA_ARCHIVE_PROFILE');
    id(r.accountRef);
  }
  for (const value of Object.values(shape(s.prices, ['deepseek', 'together'])))
    if (value !== null) {
      const p = shape(value, ['snapshotId', 'inputMicroUsdPerMillion', 'completionMicroUsdPerMillion']);
      id(p.snapshotId);
      integer(p.inputMicroUsdPerMillion, 1, 1e9);
      integer(p.completionMicroUsdPerMillion, 1, 1e9);
    }
  return s as AuditSpec;
}
export function legacySelection(input: unknown): AuditSelection {
  const s = shape(input, [
    'version',
    'source',
    'entries',
    'scope',
    'providerReaudit',
    'excludedContentRead',
    'ordering',
    'populationDigest',
  ]);
  if (
    s.version !== 'CorpusQualitySelection/0.1' ||
    s.scope !== 'SELECTED_ELIGIBLE_ONLY' ||
    s.providerReaudit !== 'NOT_PERFORMED' ||
    s.excludedContentRead !== false
  )
    stop('CQA_ARCHIVE_SELECTION');
  const source = shape(copyJson(s.source), [
    'jobId',
    'specDigest',
    'buildDigest',
    'profileDigest',
    'committedHead',
    'ledgerFileDigest',
    'authorityFileDigest',
    'exportRef',
    'exportDigest',
    'registryDigest',
    'purposeDigest',
    'tokenizerProfileDigest',
    'parentGrantIds',
  ]);
  id(source.jobId);
  for (const [k, v] of Object.entries(source)) if (!['jobId', 'exportRef', 'parentGrantIds'].includes(k)) digest(v);
  list(source.parentGrantIds, 32).forEach(id);
  legacyRef(source.exportRef);
  const order = shape(copyJson(s.ordering), ['algorithm', 'seed']);
  if (order.algorithm !== 'SHA256_SEED_POPULATION_ROW') stop('CQA_ARCHIVE_SELECTION');
  digest(order.seed);
  const entries = list(s.entries, 192, 1).map((value) => {
    const e = shape(copyJson(value), [
      'caseId',
      'sourceRowRef',
      'rowDigest',
      'candidateRef',
      'candidateDigest',
      'unit',
      'tokenReceiptRef',
      'measurement',
    ]);
    id(e.caseId);
    for (const k of ['sourceRowRef', 'candidateRef', 'tokenReceiptRef']) legacyRef(e[k]);
    digest(e.rowDigest);
    digest(e.candidateDigest);
    const u = shape(e.unit, ['ordinal', 'unitId', 'poolId', 'familyId', 'sourceId', 'roots', 'split', 'rightsDigest']);
    integer(u.ordinal, 0, 191);
    for (const k of ['unitId', 'poolId', 'familyId', 'sourceId']) id(u[k]);
    oneOf(u.split, ['train', 'dev']);
    list(u.roots, 8, 1).forEach(id);
    digest(u.rightsDigest);
    const m = shape(e.measurement, [
      'version',
      'status',
      'rowDigest',
      'tokenizerProfileDigest',
      'studentInputTokens',
      'studentLossTokens',
      'fullTokens',
      'inputIdsDigest',
      'fullIdsDigest',
      'lossMaskDigest',
      'lossPolicy',
      'officialPipelineParity',
      'actualTrainerParity',
      'trainingReady',
    ]);
    if (
      m.version !== 'CorpusTokenMeasurement/0.1' ||
      m.status !== 'LOCAL_PINNED_EXACT' ||
      m.rowDigest !== e.rowDigest ||
      m.tokenizerProfileDigest !== source.tokenizerProfileDigest ||
      m.lossPolicy !== 'ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR' ||
      m.officialPipelineParity !== 'NOT_VALIDATED' ||
      m.actualTrainerParity !== 'NOT_RUN' ||
      m.trainingReady !== false
    )
      stop('CQA_ARCHIVE_MEASUREMENT');
    for (const k of ['inputIdsDigest', 'fullIdsDigest', 'lossMaskDigest']) digest(m[k]);
    const count = (v: unknown) => {
      if (typeof v !== 'string' || !/^[1-9][0-9]{0,5}$/.test(v) || Number(v) > 65536) stop('CQA_ARCHIVE_MEASUREMENT');
      return Number(v);
    };
    if (count(m.studentInputTokens) + count(m.studentLossTokens) !== count(m.fullTokens))
      stop('CQA_ARCHIVE_MEASUREMENT');
    return e as SelectionEntry;
  });
  unique(entries.map((e) => e.caseId));
  unique(entries.map((e) => e.unit.unitId));
  unique(entries.map((e) => e.rowDigest));
  const population = hash(
    canonical(
      entries
        .map((e) => ({ unitId: e.unit.unitId, rowDigest: e.rowDigest }))
        .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)),
    ),
  );
  if (s.populationDigest !== population) stop('CQA_ARCHIVE_SELECTION');
  const keys = entries.map((e) => hash(order.seed + '\n' + population + '\n' + e.rowDigest));
  if (canonical(keys) !== canonical([...keys].sort())) stop('CQA_ARCHIVE_SELECTION');
  return { ...s, source, entries, ordering: order } as AuditSelection;
}
