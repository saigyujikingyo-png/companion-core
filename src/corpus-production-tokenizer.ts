import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, copyJson, digest, hash, list, parseJson, shape, stop, text } from './wf1-json.ts';
import { CorpusTokenizerFailure, tokenizerProcessFailure, validateTokenizerProfile } from './corpus-tokenizer.ts';
import type { CorpusTokenMeasurement, CorpusTokenizerProfile } from './corpus-tokenizer.ts';
import { TEACHER_TOKENIZER_ASSETS } from './corpus-teacher-tokenizer.ts';
import { PRODUCTION, STUDENT_TARGET, parseProductionJson } from './corpus-production-types.ts';
import type { Item, ProductionState, ScopedRef } from './corpus-production-types.ts';
import type { ProductionStore } from './corpus-production-store.ts';
import { eligibleItems, productionTextPair, settledProduction } from './corpus-production-artifacts.ts';

type Pair = { rowDigest: string; user: string; assistant: string };
// The trusted host pins this source in its startup closure. Execute these exact
// cached bytes, not a pathname which could change between verification and spawn.
export const PRODUCTION_TOKENIZER_WORKER_DIGEST = '53c7ceed1187fb49a14832d8db51b782bf991f763e83673ea8f2e1933154a77f';
export function pinProductionTokenizerWorker(source: string) {
  if (hash(source) !== PRODUCTION_TOKENIZER_WORKER_DIGEST) stop('CPR_TOKENIZER_WORKER');
  return source;
}
const WORKER_SOURCE = pinProductionTokenizerWorker(
  readFileSync(fileURLToPath(new URL('../workers/corpus/tokenizer-batch.py', import.meta.url)), 'utf8'),
);
function profileGate(input: unknown) {
  const p = validateTokenizerProfile(input);
  if (
    p.model !== STUDENT_TARGET.repo ||
    p.revision !== STUDENT_TARGET.revision ||
    p.tokenizerSha256 !== TEACHER_TOKENIZER_ASSETS.tokenizerSha256 ||
    p.templateSha256 !== TEACHER_TOKENIZER_ASSETS.templateSha256
  )
    stop('CPR_TOKENIZER_PROFILE');
  return p;
}
function measurement(input: unknown, rowDigest: string, profile: CorpusTokenizerProfile): CorpusTokenMeasurement {
  const m = shape(input, [
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
    m.rowDigest !== rowDigest ||
    m.tokenizerProfileDigest !== hash(canonical(profile)) ||
    m.lossPolicy !== 'ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR' ||
    m.officialPipelineParity !== 'NOT_VALIDATED' ||
    m.actualTrainerParity !== 'NOT_RUN' ||
    m.trainingReady !== false
  )
    stop('CPR_TOKENIZER_RECEIPT');
  const count = (v: unknown) => {
    if (typeof v !== 'string' || !/^[1-9][0-9]{0,5}$/.test(v) || Number(v) > profile.maxTokens)
      stop('CPR_TOKENIZER_RECEIPT');
    return Number(v);
  };
  if (count(m.studentInputTokens) + count(m.studentLossTokens) !== count(m.fullTokens)) stop('CPR_TOKENIZER_RECEIPT');
  for (const k of ['inputIdsDigest', 'fullIdsDigest', 'lossMaskDigest']) digest(m[k]);
  return m as CorpusTokenMeasurement;
}
/** Official public assets, one process and one tokenizer load for at most 32 pairs. */
export function measureProductionTextBatch(
  itemsInput: Pair[],
  profileInput: unknown,
  pythonPath: string,
): CorpusTokenMeasurement[] {
  const profile = profileGate(profileInput),
    items = list(itemsInput, PRODUCTION.tokenBatchRows, 1).map((v) => {
      const p = shape(copyJson(v), ['rowDigest', 'user', 'assistant']);
      digest(p.rowDigest);
      text(p.user, 2048);
      text(p.assistant, 8192);
      return p as Pair;
    });
  if (new Set(items.map((p) => p.rowDigest)).size !== items.length || !isAbsolute(text(pythonPath, 4096)))
    stop('CPR_TOKENIZER_INPUT');
  const input = canonical({
    version: 'CorpusProductionTokenizerBatchRequest/0.1',
    profile,
    tokenizerProfileDigest: hash(canonical(profile)),
    items,
  });
  if (Buffer.byteLength(input) > PRODUCTION.tokenBatchRequestBytes) stop('CPR_TOKENIZER_INPUT');
  const env: NodeJS.ProcessEnv = {
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    TOKENIZERS_PARALLELISM: 'false',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const r = spawnSync(pythonPath, ['-I', '-B', '-c', WORKER_SOURCE], {
    input,
    encoding: null,
    timeout: 60000,
    maxBuffer: 131072,
    windowsHide: true,
    env,
  });
  const diagnostic = tokenizerProcessFailure({
    status: r.status,
    signal: r.signal,
    ...(r.error ? { error: { code: (r.error as NodeJS.ErrnoException).code ?? 'UNKNOWN' } } : {}),
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? Buffer.alloc(0),
  });
  if (diagnostic) throw new CorpusTokenizerFailure(diagnostic);
  const value = shape(
    parseJson(new TextDecoder('utf-8', { fatal: true }).decode(r.stdout), {
      bytes: 131072,
      depth: 8,
      nodes: 2048,
      stringBytes: 4096,
    }),
    ['version', 'tokenizerProfileDigest', 'measurements'],
  );
  if (
    value.version !== 'CorpusProductionTokenizerBatchResult/0.1' ||
    value.tokenizerProfileDigest !== hash(canonical(profile))
  )
    stop('CPR_TOKENIZER_RECEIPT');
  const results = list(value.measurements, items.length, items.length);
  return results.map((m, i) => measurement(m, items[i]!.rowDigest, profile));
}
type Receipt = {
  version: 'CorpusProductionTokenReceipt/0.1';
  index: number;
  rowRefs: ScopedRef[];
  unitIds: string[];
  profile: CorpusTokenizerProfile;
  measurements: CorpusTokenMeasurement[];
  studentTargetDigest: string;
  factoryBaselineDigest: string;
  purposeDigest: string;
  evidenceClass: 'MODEL_REVIEWED';
  packing: 'OFF';
  trainingReady: false;
  trainingJobPolicy: 'NOT_AUTHORIZED';
};
function receipt(
  store: ProductionStore,
  state: ProductionState,
  items: Item[],
  index: number,
  profile: CorpusTokenizerProfile,
  measurements: CorpusTokenMeasurement[],
): Receipt {
  return {
    version: 'CorpusProductionTokenReceipt/0.1',
    index,
    rowRefs: items.map((i) => i.rowRef!),
    unitIds: items.map((i) => i.unitId),
    profile,
    measurements,
    studentTargetDigest: state.spec.studentTargetDigest,
    factoryBaselineDigest: state.spec.factoryBaselineDigest,
    purposeDigest: state.spec.purposeDigest,
    evidenceClass: 'MODEL_REVIEWED',
    packing: 'OFF',
    trainingReady: false,
    trainingJobPolicy: 'NOT_AUTHORIZED',
  };
}
function savedReceipt(
  store: ProductionStore,
  ref: ScopedRef,
  state: ProductionState,
  items: Item[],
  index: number,
  profile: CorpusTokenizerProfile,
): Receipt {
  const saved = shape(parseProductionJson(store.read(ref).toString('utf8')), [
    'version',
    'index',
    'rowRefs',
    'unitIds',
    'profile',
    'measurements',
    'studentTargetDigest',
    'factoryBaselineDigest',
    'purposeDigest',
    'evidenceClass',
    'packing',
    'trainingReady',
    'trainingJobPolicy',
  ]) as unknown as Receipt;
  const values = list(saved.measurements, items.length, items.length).map((v, i) =>
      measurement(v, productionTextPair(store, items[i]!).rowDigest, profile),
    ),
    expected = receipt(store, state, items, index, profile, values);
  if (canonical(saved) !== canonical(expected)) stop('CPR_TOKENIZER_RECEIPT');
  return saved;
}
function summary(store: ProductionStore, receipts: Receipt[], state: ProductionState) {
  const registry = parseProductionJson(store.read(state.registryRef).toString('utf8')) as unknown as {
      slots: { unitId: string; poolId: string; split: string }[];
    },
    m = receipts.flatMap((r) => r.measurements),
    byUnit = new Map(receipts.flatMap((r) => r.unitIds.map((id, i) => [id, r.measurements[i]!] as const)));
  const partitions = state.spec.pools.flatMap((pool) =>
    ['train', 'dev'].map((split) => {
      const rows = registry.slots.filter((s) => s.poolId === pool.poolId && s.split === split && byUnit.has(s.unitId)),
        values = rows.map((s) => byUnit.get(s.unitId)!);
      return {
        poolId: pool.poolId,
        split,
        rows: rows.length,
        studentInputTokens: values.reduce((n, v) => n + Number(v.studentInputTokens), 0),
        studentLossTokens: values.reduce((n, v) => n + Number(v.studentLossTokens), 0),
        fullTokens: values.reduce((n, v) => n + Number(v.fullTokens), 0),
      };
    }),
  );
  const trainLoss = partitions.filter((p) => p.split === 'train').reduce((n, p) => n + p.studentLossTokens, 0);
  return {
    version: 'CorpusProductionTokenSummary/0.1',
    rows: m.length,
    batches: receipts.length,
    partitions,
    studentInputTokens: m.reduce((n, v) => n + Number(v.studentInputTokens), 0),
    studentLossTokens: m.reduce((n, v) => n + Number(v.studentLossTokens), 0),
    fullTokens: m.reduce((n, v) => n + Number(v.fullTokens), 0),
    generationReviewTrainLossTokensPerMinute: state.wallMs > 0 ? (trainLoss * 60000) / state.wallMs : null,
    uniqueAcceptedTrainLossTokensPerMinute: null,
    totalPipelineTiming: 'HOST_REQUIRED',
    measurementStatus: 'LOCAL_PINNED_EXACT',
    evidenceClass: 'MODEL_REVIEWED',
    officialPipelineParity: 'NOT_VALIDATED',
    actualTrainerParity: 'NOT_RUN',
    packing: 'OFF',
    trainingReady: false,
    trainingJobPolicy: 'NOT_AUTHORIZED',
  };
}
export function measureProductionTokens(store: ProductionStore, profileInput: unknown, pythonPath: string) {
  store.check();
  const state = settledProduction(store),
    profile = profileGate(profileInput),
    items = eligibleItems(store, state),
    receipts: Receipt[] = [];
  if (state.exportRef && state.tokenRefs.length !== Math.ceil(items.length / 32)) stop('CPR_EXPORT_FROZEN');
  for (let offset = 0; offset < items.length; offset += 32) {
    const group = items.slice(offset, offset + 32),
      index = offset / 32,
      ref = state.tokenRefs[index];
    if (ref) {
      receipts.push(savedReceipt(store, ref, state, group, index, profile));
      continue;
    }
    store.check();
    const measurements = measureProductionTextBatch(
      group.map((i) => productionTextPair(store, i)),
      profile,
      pythonPath,
    );
    store.check();
    const value = receipt(store, state, group, index, profile, measurements),
      measurementRef = store.put('tokens-' + index, 'corpus-production-token-receipt', canonical(value));
    store.apply('TOKENS', { ref: measurementRef });
    receipts.push(value);
  }
  if (store.snapshot()!.tokenRefs.length !== receipts.length) stop('CPR_TOKENIZER_RECEIPT');
  return summary(store, receipts, state);
}
export function verifyProductionTokens(store: ProductionStore, profileInput: unknown, pythonPath: string) {
  const state = settledProduction(store),
    profile = profileGate(profileInput),
    items = eligibleItems(store, state),
    receipts: Receipt[] = [];
  if (state.tokenRefs.length !== Math.ceil(items.length / 32)) stop('CPR_TOKENIZER_RECEIPT');
  for (let offset = 0; offset < items.length; offset += 32) {
    const group = items.slice(offset, offset + 32),
      index = offset / 32,
      saved = savedReceipt(store, state.tokenRefs[index]!, state, group, index, profile);
    const actual = measureProductionTextBatch(
      group.map((i) => productionTextPair(store, i)),
      profile,
      pythonPath,
    );
    store.check(false);
    if (canonical(actual) !== canonical(saved.measurements)) stop('CPR_TOKENIZER_RECEIPT');
    receipts.push(saved);
  }
  return summary(store, receipts, state);
}
