import { canonical, copyJson, digest, hash, id, integer, list, oneOf, shape, stop } from './wf1-json.ts';
import { scopedQa } from './corpus-qa-types.ts';
import type { AuditSelection, AuditState } from './corpus-qa-types.ts';
import type { QaSelectedReader } from './corpus-qa-source.ts';
import type { ScopedRef } from './corpus-production-types.ts';
export type ScopedIndexEntry = {
  sourceJobId: string;
  unitId: string;
  poolId: string;
  familyId: string;
  split: 'train' | 'dev';
  rowRef: ScopedRef;
  rowDigest: string;
  exactDigest: string;
  normalizedDigest: string;
  promptDigest: string;
  qaDisposition: 'PASS' | 'HOLD' | 'REJECT' | 'UNCERTAIN' | 'NOT_AUDITED';
};
export type ScopedDedupIndex = {
  version: 'CorpusScopedDedupIndex/0.1';
  scope: {
    selectionDigest: string;
    populationDigest: string;
    sourceJobId: string;
    included: 'SELECTED_ELIGIBLE_ONLY';
    excludedOriginalRejected: 'NOT_READ';
    comparison: 'EXACT_NORMALIZED_PROMPT_ONLY';
  };
  entries: ScopedIndexEntry[];
};
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
/** Content-only fingerprints deliberately exclude job/unit identifiers. */
export function qaExactFingerprints(pair: { prompt: string; response: string }) {
  return {
    exactDigest: hash(canonical(pair)),
    normalizedDigest: hash(canonical({ prompt: normalize(pair.prompt), response: normalize(pair.response) })),
    promptDigest: hash(normalize(pair.prompt)),
  };
}
export function buildScopedIndex(
  selection: AuditSelection,
  source: QaSelectedReader,
  state?: AuditState,
): ScopedDedupIndex {
  const selectionDigest = hash(canonical(selection));
  if (source.selectionDigest !== selectionDigest || (state && state.spec.selectionDigest !== selectionDigest))
    stop('CQA_INDEX_BINDING');
  return {
    version: 'CorpusScopedDedupIndex/0.1',
    scope: {
      selectionDigest,
      populationDigest: selection.populationDigest,
      sourceJobId: selection.source.jobId,
      included: 'SELECTED_ELIGIBLE_ONLY',
      excludedOriginalRejected: 'NOT_READ',
      comparison: 'EXACT_NORMALIZED_PROMPT_ONLY',
    },
    entries: selection.entries.map((e) => {
      source.check();
      const { prompt, response, rowDigest } = source.read(e.caseId);
      if (rowDigest !== e.rowDigest) stop('CQA_SOURCE_ROW');
      const status = state?.items.find((i) => i.caseId === e.caseId)?.status;
      return {
        sourceJobId: selection.source.jobId,
        unitId: e.unit.unitId,
        poolId: e.unit.poolId,
        familyId: e.unit.familyId,
        split: e.unit.split,
        rowRef: e.sourceRowRef,
        rowDigest: e.rowDigest,
        ...qaExactFingerprints({ prompt, response }),
        qaDisposition: !state ? 'NOT_AUDITED' : !status || status === 'PENDING' ? 'HOLD' : status,
      };
    }),
  };
}
function validateIndex(input: unknown): ScopedDedupIndex {
  const index = shape(input, ['version', 'scope', 'entries']);
  if (index.version !== 'CorpusScopedDedupIndex/0.1') stop('CQA_INDEX');
  const scope = shape(copyJson(index.scope), [
    'selectionDigest',
    'populationDigest',
    'sourceJobId',
    'included',
    'excludedOriginalRejected',
    'comparison',
  ]);
  digest(scope.selectionDigest);
  digest(scope.populationDigest);
  id(scope.sourceJobId);
  if (
    scope.included !== 'SELECTED_ELIGIBLE_ONLY' ||
    scope.excludedOriginalRejected !== 'NOT_READ' ||
    scope.comparison !== 'EXACT_NORMALIZED_PROMPT_ONLY'
  )
    stop('CQA_INDEX');
  const entries = list(index.entries, 192, 1).map((value) => {
    const e = shape(copyJson(value), [
      'sourceJobId',
      'unitId',
      'poolId',
      'familyId',
      'split',
      'rowRef',
      'rowDigest',
      'exactDigest',
      'normalizedDigest',
      'promptDigest',
      'qaDisposition',
    ]);
    for (const k of ['sourceJobId', 'unitId', 'poolId', 'familyId']) id(e[k]);
    if (e.sourceJobId !== scope.sourceJobId) stop('CQA_INDEX');
    for (const k of ['rowDigest', 'exactDigest', 'normalizedDigest', 'promptDigest']) digest(e[k]);
    scopedQa(e.rowRef);
    oneOf(e.split, ['train', 'dev']);
    oneOf(e.qaDisposition, ['PASS', 'HOLD', 'REJECT', 'UNCERTAIN', 'NOT_AUDITED']);
    return e as ScopedIndexEntry;
  });
  if (new Set(entries.map((e) => e.unitId)).size !== entries.length) stop('CQA_INDEX');
  return { version: 'CorpusScopedDedupIndex/0.1', scope, entries } as ScopedDedupIndex;
}
/** Bounded private assembly view. Earlier index order wins same-split duplicates.
 * Cross-split links hold entire connected source families, including rejected QA
 * nodes. This is neither semantic ANN nor an all-history contamination guarantee. */
export function assembleScopedIndexes(inputs: ScopedDedupIndex[], expectedDigests: string[]) {
  return assemble(inputs, expectedDigests, { maxInputs: 8, maxRows: 8 * 192, maxBytes: Number.MAX_SAFE_INTEGER });
}
/** Explicit cycle resource bounds; the legacy F2 entry point retains eight inputs. */
export function assembleCycleIndexes(
  inputs: ScopedDedupIndex[],
  expectedDigests: string[],
  limits: { maxInputs: number; maxRows: number; maxBytes: number },
) {
  shape(limits, ['maxInputs', 'maxRows', 'maxBytes']);
  for (const value of Object.values(limits)) integer(value, 1);
  return assemble(inputs, expectedDigests, limits);
}
function assemble(
  inputs: ScopedDedupIndex[],
  expectedDigests: string[],
  limits: { maxInputs: number; maxRows: number; maxBytes: number },
) {
  if (inputs.length < 1 || inputs.length > limits.maxInputs || inputs.length !== expectedDigests.length)
    stop('CQA_INDEX');
  let rows = 0,
    bytes = 0;
  const indexes = inputs.map((v, i) => {
      const index = validateIndex(v),
        serialized = canonical(index);
      rows = integer(rows + index.entries.length);
      bytes = integer(bytes + Buffer.byteLength(serialized));
      if (rows > limits.maxRows || bytes > limits.maxBytes) stop('CQA_INDEX_RESOURCES');
      if (hash(serialized) !== expectedDigests[i]) stop('CQA_INDEX_BINDING');
      return index;
    }),
    entries = indexes.flatMap((i) => i.entries);
  const key = (e: ScopedIndexEntry) => canonical({ jobId: e.sourceJobId, unitId: e.unitId }),
    family = (e: ScopedIndexEntry) => canonical({ jobId: e.sourceJobId, familyId: e.familyId });
  if (new Set(entries.map(key)).size !== entries.length) stop('CQA_INDEX_CONFLICT');
  const parents = new Map<string, string>(),
    first = new Map<string, ScopedIndexEntry>(),
    duplicates = new Map<string, string>();
  for (const e of entries) parents.set(family(e), family(e));
  const root = (v: string): string => {
    let r = v;
    while (parents.get(r) !== r) r = parents.get(r)!;
    while (v !== r) {
      const next = parents.get(v)!;
      parents.set(v, r);
      v = next;
    }
    return r;
  };
  for (const e of entries)
    for (const field of ['exactDigest', 'normalizedDigest', 'promptDigest'] as const) {
      const k = field + ':' + e[field],
        prior = first.get(k);
      if (prior) {
        parents.set(root(family(e)), root(family(prior)));
        if (!duplicates.has(key(e))) duplicates.set(key(e), key(prior));
      } else first.set(k, e);
    }
  const splits = new Map<string, Set<string>>();
  for (const e of entries) {
    const r = root(family(e)),
      set = splits.get(r) ?? new Set<string>();
    set.add(e.split);
    splits.set(r, set);
  }
  return {
    version: 'CorpusScopedAssembly/0.1',
    indexDigests: expectedDigests,
    comparison: 'EXACT_NORMALIZED_PROMPT_ONLY',
    rows: entries.map((e) => ({
      sourceJobId: e.sourceJobId,
      unitId: e.unitId,
      poolId: e.poolId,
      familyId: e.familyId,
      split: e.split,
      rowRef: e.rowRef,
      rowDigest: e.rowDigest,
      duplicateOf: duplicates.get(key(e)) ?? null,
      familyHold: splits.get(root(family(e)))!.size > 1,
      qaDisposition: e.qaDisposition,
      eligibleForNextExport:
        e.qaDisposition === 'PASS' && !duplicates.has(key(e)) && splits.get(root(family(e)))!.size === 1,
    })),
    trainingReady: false,
    trainingJobPolicy: 'NOT_AUTHORIZED',
  };
}
