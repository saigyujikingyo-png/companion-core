import { canonical, hash, shape, stop } from './wf1-json.ts';
import {
  parseProductionJson,
  productionAttemptPending,
  PRODUCTION,
  validateProductionCandidate,
  validateProductionRegistry,
} from './corpus-production-types.ts';
import type { Item, ProductionState, ScopedRef } from './corpus-production-types.ts';
import type { ProductionStore } from './corpus-production-store.ts';
import { verifyProduction } from './corpus-production-runner.ts';

export function settledProduction(store: ProductionStore) {
  const state = verifyProduction(store);
  if (state.status === 'ACTIVE' || state.attempts.some((a) => productionAttemptPending(state.spec, a)))
    stop('CPR_ACTIVE');
  return state;
}
export function eligibleItems(store: ProductionStore, state: ProductionState) {
  const registry = validateProductionRegistry(
    parseProductionJson(store.read(state.registryRef).toString('utf8')),
    state.spec,
  );
  return state.items.filter(
    (i) => i.status === 'ACCEPTED' && !state.heldFamilies.includes(registry.slots[i.ordinal]!.familyId),
  );
}
export function productionTextPair(store: ProductionStore, item: Item) {
  if (!item.rowRef) stop('CPR_ROW');
  const bytes = store.read(item.rowRef),
    row = parseProductionJson(bytes.toString('utf8')) as unknown as { candidate: unknown };
  const candidate = validateProductionCandidate(row.candidate, item.unitId);
  return { rowDigest: hash(bytes), user: candidate.prompt, assistant: candidate.response };
}
type Shard = {
  version: 'CorpusProductionShard/0.1';
  index: number;
  poolId: string;
  split: 'train' | 'dev';
  rowRefs: ScopedRef[];
  unitIds: string[];
  jsonlRef: ScopedRef;
  jsonlDigest: string;
  bytes: number;
  studentTargetDigest: string;
  factoryBaselineDigest: string;
  purposeDigest: string;
  trainingReady: false;
};
function shardLine(store: ProductionStore, item: Item) {
  const bytes = store.read(item.rowRef!),
    row = parseProductionJson(bytes.toString('utf8')) as unknown as { unit: unknown; candidate: unknown },
    candidate = validateProductionCandidate(row.candidate, item.unitId);
  return (
    canonical({
      version: 'CorpusProductionTextPair/0.1',
      unitId: item.unitId,
      unit: row.unit,
      rowDigest: hash(bytes),
      prompt: candidate.prompt,
      response: candidate.response,
      evidenceClass: 'MODEL_REVIEWED',
      exactVerified: false,
      trainingReady: false,
    }) + '\n'
  );
}
function groupRows(store: ProductionStore, state: ProductionState) {
  const registry = validateProductionRegistry(
      parseProductionJson(store.read(state.registryRef).toString('utf8')),
      state.spec,
    ),
    items = eligibleItems(store, state),
    groups: { poolId: string; split: 'train' | 'dev'; rows: Item[]; lines: string[]; bytes: number }[] = [];
  for (const pool of state.spec.pools)
    for (const split of ['train', 'dev'] as const) {
      let group = { poolId: pool.poolId, split, rows: [] as Item[], lines: [] as string[], bytes: 0 };
      for (const item of items.filter((i) => i.poolId === pool.poolId && registry.slots[i.ordinal]!.split === split)) {
        const line = shardLine(store, item),
          bytes = Buffer.byteLength(line);
        if (bytes > PRODUCTION.shardBytes) stop('CPR_LENGTH');
        if (group.rows.length === PRODUCTION.shardRows || group.bytes + bytes > PRODUCTION.shardBytes) {
          groups.push(group);
          group = { poolId: pool.poolId, split, rows: [], lines: [], bytes: 0 };
        }
        group.rows.push(item);
        group.lines.push(line);
        group.bytes += bytes;
      }
      if (group.rows.length) groups.push(group);
    }
  return { items, groups };
}
function exportManifest(state: ProductionState, rows: number) {
  return {
    version:
      state.spec.version === 'CorpusProduction/0.2' ? 'CorpusProductionExport/0.2' : 'CorpusProductionExport/0.1',
    jobId: state.spec.jobId,
    shards: state.shards,
    tokenRefs: state.tokenRefs,
    rows,
    studentTargetDigest: state.spec.studentTargetDigest,
    factoryBaselineDigest: state.spec.factoryBaselineDigest,
    purposeDigest: state.spec.purposeDigest,
    evidenceClass: 'MODEL_REVIEWED',
    packing: 'OFF',
    trainingReady: false,
    trainingJobPolicy: 'NOT_AUTHORIZED',
  };
}
/** Immutable row/byte bounded shards, each belonging to exactly one pool and split. */
export function exportProduction(store: ProductionStore) {
  store.check();
  const state = settledProduction(store),
    { items, groups } = groupRows(store, state);
  if (state.tokenRefs.length !== Math.ceil(items.length / PRODUCTION.tokenBatchRows)) stop('CPR_TOKENS_REQUIRED');
  for (const [index, group] of groups.entries()) {
    const rows = group.rows,
      data = group.lines.join(''),
      existing = store.snapshot()!.shards[index];
    if (existing) {
      verifyShard(store, existing, index, group);
      continue;
    }
    store.check();
    const bucket = 'shard-' + index,
      jsonlRef = store.put(bucket, 'corpus-production-jsonl', data),
      manifest: Shard = {
        version: 'CorpusProductionShard/0.1',
        index,
        poolId: group.poolId,
        split: group.split,
        rowRefs: rows.map((i) => i.rowRef!),
        unitIds: rows.map((i) => i.unitId),
        jsonlRef,
        jsonlDigest: hash(data),
        bytes: group.bytes,
        studentTargetDigest: state.spec.studentTargetDigest,
        factoryBaselineDigest: state.spec.factoryBaselineDigest,
        purposeDigest: state.spec.purposeDigest,
        trainingReady: false,
      };
    const ref = store.put(bucket, 'corpus-production-shard', canonical(manifest));
    store.apply('SHARD', { ref });
  }
  const current = store.snapshot()!;
  if (current.shards.length !== groups.length) stop('CPR_SHARD');
  const manifest = exportManifest(current, items.length);
  if (current.exportRef) {
    if (canonical(parseProductionJson(store.read(current.exportRef).toString('utf8'))) !== canonical(manifest))
      stop('CPR_EXPORT_CONFLICT');
  } else {
    const ref = store.put('meta', 'corpus-production-export', canonical(manifest));
    store.apply('EXPORT', { ref });
  }
  return {
    version: 'CorpusProductionExportSummary/0.1',
    rows: items.length,
    shards: groups.length,
    bytes: groups.reduce((n, g) => n + g.bytes, 0),
    partitions: groups.map((g) => ({ poolId: g.poolId, split: g.split, rows: g.rows.length, bytes: g.bytes })),
    trainingReady: false,
    trainingJobPolicy: 'NOT_AUTHORIZED',
  };
}
function verifyShard(
  store: ProductionStore,
  ref: ScopedRef,
  index: number,
  group: ReturnType<typeof groupRows>['groups'][number],
) {
  const items = group.rows,
    data = group.lines.join(''),
    m = shape(parseProductionJson(store.read(ref).toString('utf8')), [
      'version',
      'index',
      'poolId',
      'split',
      'rowRefs',
      'unitIds',
      'jsonlRef',
      'jsonlDigest',
      'bytes',
      'studentTargetDigest',
      'factoryBaselineDigest',
      'purposeDigest',
      'trainingReady',
    ]) as unknown as Shard;
  const expected = {
    ...m,
    version: 'CorpusProductionShard/0.1',
    index,
    poolId: group.poolId,
    split: group.split,
    rowRefs: items.map((i) => i.rowRef!),
    unitIds: items.map((i) => i.unitId),
    jsonlDigest: hash(data),
    bytes: group.bytes,
    studentTargetDigest: store.spec.studentTargetDigest,
    factoryBaselineDigest: store.spec.factoryBaselineDigest,
    purposeDigest: store.spec.purposeDigest,
    trainingReady: false,
  };
  if (
    canonical(m) !== canonical(expected) ||
    m.bytes > PRODUCTION.shardBytes ||
    items.length > PRODUCTION.shardRows ||
    !store.read(m.jsonlRef).equals(Buffer.from(data))
  )
    stop('CPR_SHARD');
}
export function verifyProductionExport(store: ProductionStore) {
  const s = settledProduction(store);
  if (!s.exportRef) stop('CPR_EXPORT');
  const { items, groups } = groupRows(store, s);
  if (s.shards.length !== groups.length || s.tokenRefs.length !== Math.ceil(items.length / 32)) stop('CPR_EXPORT');
  for (const [index, group] of groups.entries()) verifyShard(store, s.shards[index]!, index, group);
  if (
    canonical(parseProductionJson(store.read(s.exportRef).toString('utf8'))) !==
    canonical(exportManifest(s, items.length))
  )
    stop('CPR_EXPORT');
  return {
    rows: items.length,
    shards: s.shards.length,
    bytes: groups.reduce((n, g) => n + g.bytes, 0),
    trainingReady: false,
  };
}
