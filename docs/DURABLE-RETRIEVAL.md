# IF5 / AR0b1: durable consumer retrieval bridge

2026-10-27. Actual local implementation of the [frozen plan](DURABLE-RETRIEVAL-PLAN.md), extending [durable metadata fanout](DURABLE-FANOUT.md) and [AR0 retrieval](AR0-RETRIEVAL.md). The two entry points are `MemoryStore.consumerRetrievalSnapshot(handle)` and `RetrievalService.bindConsumer(handle)`. No schema, dependency, storage format, ranking algorithm or provider was added.

## Trusted local API

```ts
// Existing schema2 Store; registration/progress remain explicit trusted controls.
const handle = store.registerConsumer('recall', scope, 'retrieval-refs-v1');
// After later source publications:
store.applyConsumers([handle]);
const retrieval = new RetrievalService(store);
const binding = retrieval.bindConsumer(handle);
retrieval.refresh(binding);
const { candidate } = retrieval.query(binding, { text: 'blue', limit: 8 });
const result = retrieval.resolve(binding, candidate);
// Re-resolve after an await and immediately before delivery to an external caller.
```

Only an existing `retrieval-refs-v1` consumer is accepted. There are no caller refs, offsets, scope overrides, implicit registration, apply, reset or resume. Registration may already include a current baseline. A stale projection is refused until the trusted caller explicitly applies the complete pending prefix. A scene consumer remains independent. This API does not connect a runtime or call a model.

The Store copies the closed handle before entering authority access. Proxies (including revoked proxies), accessors, inherited or extra fields, invalid counters and the wrong profile fail before any access guard or caller callback. This is structural input validation, not host authentication: Store consumer handles are trusted local data. Retrieval bindings/candidates are separate frozen, per-service WeakMap capabilities; copying their visible `{version:1}` shape does not transfer authority.

## Atomic read and receipt

One external access guard covers two sequential transactions. The first sweeps a crossed TTL boundary and persists its journal barrier. The second reads at that same frozen `asOf`: verifies the consumer's active generation and complete applied prefix, reads its entire current projection, and hydrates all selected memory bodies plus every source ancestor. Every metadata row is compared with the current node revision, generation, node consent revision, recorded time, validity, parents and root event refs. Ancestor text is validated and budgeted internally, but is not returned.

The returned `ConsumerRetrievalSnapshot` preserves the ordinary version-1 retrieval envelope and adds a frozen `consumer` receipt:

| Field | Meaning |
|---|---|
| `version`, `id`, `profile`, `generation`, `scopeId`, `bootId` | Consumer identity and process/generation fence |
| `authority` | Current scope id, scope generation, consent revision and runtime epoch |
| `applied`, `head` | Equal at a successful read; the consumer covers the complete current journal prefix, including other scopes |
| `baseline`, `floor` | Baseline and retained-prefix positions for auditing |
| `projectionAsOf` | Time the durable projection was last constructed |
| `readAsOf` | Current frozen read time; equals snapshot `asOf` |

`resolve` also includes this receipt for consumer-bound results. Manual-ref results retain their old shape. The receipt is local audit data, not a portable capability, cryptographic proof, permission grant, semantic truth or authorization to deliver an old copied result.

No-change reads add no durable commits. A TTL barrier remains persisted even if the following projection read or delivery is refused. The service also refuses an observed clock rollback, including an empty selection. This does not turn wall-clock time into a trusted external clock.

## Bounds and lifecycle

The complete selection must fit the original AR0 limits: 32 selected memories, 128 source closure nodes, 512 source edges and 262144 charged UTF-8 bytes. The new path additionally charges the serialized full projection metadata and consumer receipt into that same source byte allowance. The old manual snapshot's byte formula is unchanged. The distinct RAM projection limits remain 128 nodes, 512 derived association edges and 262144 charged bytes, including the retained snapshot/receipt, normalized text, terms and mappings. These are bounded serialization costs, not a measured heap maximum.

Durable fanout retains its separate 512-node scope/metadata and 1 MiB projection limits; it is not truncated to 32. Thus a valid durable projection with 33 memories can be read as metadata, while the whole retrieval read fails. There is no partial result, older pair fallback, automatic subset or silent pagination.

Each bind/refresh/query/resolve uses the new Store seam. Pair identity contains the selected memory representation, authority and consumer progress receipt, excluding only the changing `readAsOf`. A journal advance can invalidate an old candidate even when the selected text is unchanged. Explicit `refresh` can replace a pair after apply if no invalid read has already terminated the binding. A new query or refresh invalidates the previous candidate. If query/resolve observes changed pair identity, or the Store observes stale/inactive/reset/expired/fenced/over-budget source state, the service clears the pair/candidate and terminates the binding; a fresh bind is required. A RAM projection construction limit retains the existing AR0 behavior: the old pair/candidate is cleared and the otherwise current binding stays `RETRIEVAL_NOT_READY`, so an explicit successful refresh can rebuild it.

Pause, reset, retention-forced reset, source revision/revocation, consent/purge, runtime changes, Store boot and anchored cutover fence old handles, including empty selections. New boot/cutover requires a fresh trusted consumer handle, explicit catch-up and a new service binding. RAM pairs/candidates are never persisted or restored. Already returned plaintext copies cannot be recalled physically.

## Author evidence and remaining acceptance

- Missing-feature check failed as expected with `TypeError: f.service.bindConsumer is not a function`: native TEMP `aemc-if5-gap-20261027T080744207Z/focused.log`.
- First implemented slice plus legacy retrieval: 31/31 and typecheck exit 0, `aemc-if5-slice-20261027T080853633Z`.
- Expanded first focused suite: 33/33, `aemc-if5-focused-20261027T081244336Z`. Typecheck exit 2 exposed a test-only SQLite output value with possible `undefined`; its known-string restore argument was explicitly typed. This was not a runtime failure. Later evidence is recorded in the handoff/final integrated evidence.
- Final author affected set: **159/159**, 0 failed/cancelled/skipped/todo, 3.951 s; typecheck exit 0. This contains the final 35 IF5 cases plus the existing retrieval, retrieval-snapshot, curation and scene-authority suites. Native TEMP `aemc-if5-affected-20261027T081636909Z`; fresh available RAM 2.886 GiB and disk 320.134 GiB. A later independent read confirmed the log remained present. No whole suite or measurement campaign was run by this author.
- All execution uses synthetic data, a fresh native TEMP directory, Node 24.16.0 and one test worker. New fixture directories are retained. Tests include actual source publication, independent consumers, metadata/body mismatch, source and RAM budgets, unchanged commits, TTL/rollback, empty scopes, closed input/reentrancy, forged/copied/cross-binding capabilities, anchored-v3 compaction with unchanged old source hashes, and an actual child-process reopen/catch-up/query/resolve. Artifact activation in a lifecycle test registers synthetic metadata only; no training is run.

Independent final review and whole-suite evidence belong to the final frozen integrated source. Historical IF4 822 does not cover IF5. This slice does not accept AR1 semantic ranking quality, actual embeddings/BM25/PPR, scene retrieval, a production runtime, remote/hardware authority, physical power loss, cross-platform behavior, ten-year scale, cold-history GC, private migration, merge, deployment or training.

最终冻结组合的独立执行、审查和成本结果见 [IF5–IF6证据](AEMC-INFRA-EVIDENCE-IF6.md)：874/874、typecheck与固定协议测量均通过；作者历史记录保持原结论。
