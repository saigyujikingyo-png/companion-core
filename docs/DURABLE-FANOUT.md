# Durable metadata fanout — schema 2

[IF5 durable retrieval](DURABLE-RETRIEVAL.md) now consumes the complete retrieval projection through an atomic current-source snapshot and the real query/resolve path. [IF6 authority capacity](AUTHORITY-CAPACITY.md) can refuse writes needed for a TTL barrier; such reads fail closed. These extensions do not implement semantic ranking or an external index.

S2 implements two independently checkpointed metadata consumers over the authoritative MemoryStore: `retrieval-refs-v1` and `scene-source-refs-v1`. These are usable reference projections of IDs, revisions, source ancestry and authority metadata. They do not implement vector search, a scene inference engine, a new memory representation, or ten-year incremental storage.

Schema 2 is explicit opt-in. `src/schema.ts` and its schema-1 SQL/hash remain unchanged. Default `MemoryStore` and M2.v1 still require schema 1; schema-1 backup validation does not accept schema 2. New schema-2 stores use `new MemoryStore(':memory:', { schemaVersion: 2 })` or `AnchoredVault.create({ ...config, schemaVersion: 2 }, budget)`. Opening schema-2 vaults also requires `schemaVersion: 2` in the config.

## Source journal and complete transactions

`schema-v2.ts` appends the journal, consumer and projection tables plus triggers. All source changes are captured in the same SQLite transaction as their authoritative mutation. An internal transaction context supplies only transaction ID, phase and a frozen timestamp through scalar functions. The first actual source change lazily creates a batch; unchanged operations do not create an empty batch or checkpoint.

The triggers cover:

- Nodes: insert/delete and changes to ID, scope, type, revision, generation, consent revision, status, body, search text, creation/validity times and projection visibility. ID/scope/type updates are explicitly refused.
- Dependencies: insert/delete and parent-revision updates. Child/parent identity updates are refused.
- Scopes: insert/delete and generation, consent, learning permission or runtime epoch updates. Scope ID/identity updates are refused.

Journal items contain object IDs, scope IDs, affected edge endpoints and operation names. They contain no selected text, generated statements, embeddings or hashes of source text. One publication's node, edges and visibility updates form one batch. Correction may invalidate and replace a source inside a transaction, but no consumer sees or authorizes that intermediate state.

Before the source transaction commits, the controller freezes the batch's final revocation high water, item count and digest. Batch sequence uses SQLite `AUTOINCREMENT`. Complete batches and items cannot be edited; only scoped retention may delete whole batches. Image validation checks complete batches, their item count/digest, head/floor ordering and the SQLite allocation sequence. Sequence gaps are legal; a consumer's checkpoint must still reference the actual floor or a retained complete batch.

Job, lease and draft changes can still cause a durable commit without creating a source journal batch. v2 writes a complete image; an explicitly selected [v3 profile](INCREMENTAL-STORAGE.md) may persist a bounded block delta. Journal/consumer table writes do not recursively generate source batches. The schema-1 compatibility outbox is retained, but `projectionBatch` and `acknowledgeProjection` reject schema-2 calls; the old global ACK is never used as a consumer checkpoint.

## Consumer lifecycle

```ts
const scope = vault.store.ensureScope(identity);
const retrieval = vault.store.registerConsumer(
  'retrieval', scope, 'retrieval-refs-v1', true, // required retention consumer
);
const scene = vault.store.registerConsumer(
  'scene', scope, 'scene-source-refs-v1', false, // can be reset by retention
);

// Advance one independently, or both atomically in one durable commit.
vault.store.applyConsumers([retrieval]);
vault.store.applyConsumers([scene]);
const refs = vault.store.readConsumer(retrieval).refs;
```

Registration writes a bounded, complete baseline from one current source snapshot and its journal watermark. No partial baseline is accepted. Each consumer persists profile, scope, generation, required/resettable policy, status, applied prefix, baseline watermark, source authority stamp, timestamp and next validity boundary. The projection rows and checkpoint advance together in one SQLite transaction and one outer vault commit. There is no public arbitrary-offset setter, detached ACK or caller-supplied projection callback.

`applyConsumers` verifies complete batches from each selected consumer's checkpoint through the current **global** journal head, then rebuilds that consumer's current authorized metadata projection. A batch in another scope is a legitimate gap in relevant items but still advances the complete global prefix. Retrieval projects visible memory references and root-event references. Scene source projects the same visible memories plus their valid ancestor metadata, including event mode/role/time, without bodies. A current projection requires `applied == head`; filtering a few stale hits is insufficient.

The ordinary-recall authority check uses current scope generation, revisions, source status, validity and ancestor dependencies. Learning permission is not ordinary-recall permission, and a historical node's consent revision need not equal today's scope consent revision. Changing learning permission still invalidates previously issued handles and forces a fresh bind to the current authority.

Handles carry consumer generation, process boot ID and issuance scope generation/consent/runtime epoch. Purge, consent changes, artifact activation or revocation can invalidate old handles. `bindConsumer(id, currentScope)` issues a current handle without silently moving its durable checkpoint; call `applyConsumers` before reading a stale projection. Restart invalidates old process handles, preserves each durable prefix, and emits a complete boot batch for source runtime-epoch changes. Old leases and active artifacts are reset as before. Rebinding after restart does not skip the boot batch.

`pauseConsumer(handle)` increments generation and clears its usable projection. `resumeConsumer(id, currentScope)` and `resetConsumer(...)` take a new complete baseline and issue a new generation/handle. Old handles cannot insert, ACK or revive an old upsert.

## Time and no-change polling

`sweepConsumers()` records future activation and expiration barriers, including validity inherited from ancestors. At a crossed boundary it computes current visibility, writes changes into a complete sweep batch, and updates the next boundary. A crossed boundary with no visible memories still creates a metadata-only TTL barrier.

`readConsumer` holds one outer authority guard and freezes one timestamp for its whole operation. It commits a needed sweep first; only then does a read-only transaction check the projection. Thus refusing a stale read cannot roll back the observed expiry barrier. Both stages use the same timestamp, avoiding a second clock read that could cross a boundary inside the read-only transaction. Applying a consumer also finalizes any sweep before reading the complete journal prefix. Clock rollback below the in-process observation or durable wall floor fails closed.

Polling unchanged consumers, reading status, binding an unchanged consumer, applying an already-current consumer, sweeping before the next boundary, and setting identical consent do not create source batches or full-image checkpoints. Active deadlines still require a host to call sweep/read/apply; this module does not start a timer or background service.

## Retention and capacity recovery

`pruneJournal(retainBatches)` chooses a floor from actual complete batches. A lagging required consumer blocks ordinary pruning. A lagging resettable consumer is changed atomically to `reset_required`, receives a new generation, loses its projection, and moves to the new floor; it cannot serve again until a full baseline succeeds. Consumer authority is never inferred from arbitrary numeric offsets.

The journal is intentionally bounded. When full, ordinary source commits or the next boot batch may be refused. An actual recovery path exists even when normal Store construction cannot emit its boot batch:

```ts
const receipt = AnchoredVault.maintainFanout({
  authority, vaultId, keys, maxCalls: 8,
  targetDirectory: newMaintenanceDirectory, storageDomain: 'vault-and-backups',
  operationId: 'caller-stable-maintenance-id', retainBatches: 64,
  resetConsumerIds: ['explicitly-chosen-required-consumer'],
});
const recovered = AnchoredVault.open({
  ...config, directory: newMaintenanceDirectory, schemaVersion: 2,
}, 8);
```

This static API reads the independent authority's **current exact head** and current checkpoint files under its lock. It does not construct the source Store, reset source leases/epochs, or depend on a possibly stale backup. It validates source image schema, metadata and revocation high water, then prunes a private RAM copy. Lagging required consumers are refused unless individually named in `resetConsumerIds`; other lagging resettable consumers follow the usual retention reset rule. Empty/irrelevant/duplicate selections are not an authorization to reset arbitrary consumers.

The resulting current-state image must leave space for its next boot batch and scope items. A maintenance request that retains a full journal is rejected before creating a target or PREPARED operation. The new target uses the same strict staging/PREPARED/publish/ACTIVE fencing protocol as recovery, with kind `fanout-maintenance`. The request digest binds the old head, chosen IDs and retention request; the encrypted record and durable receipt include the resulting floor and actual reset IDs. Pending maintenance is completed only by explicit `reconcile` of its frozen bytes. Source files and their hashes remain unchanged. Correct maintenance permits normal open and fresh consumer baselines; required flags are preserved.

This is explicit retention/metadata recovery. It does not erase historical ciphertext, drop source records, relax required consumers silently, or provide infinite retention. An unreadable/missing latest checkpoint remains an unresolved storage failure.

## Offline schema migration and validation

`memory-image.ts` validates disposable RAM databases without constructing MemoryStore. It never performs a boot reset while inspecting or migrating. Both schema versions compare actual SQLite layout against a fixed expected layout derived from the known SQL, not only against the image's self-declared layout hash. Required Store ledger keys, integrity, foreign keys and FTS consistency are validated. Schema 2 additionally checks journal bounds/sequence/digests and consumer/projection shapes. Metadata fields have an exact allowlist; projection column IDs/revisions must match JSON, references are bounded and unique, authority stamps cannot be from the future, and nonactive consumers have no usable projection. Stale historical refs are allowed while their consumer awaits catch-up; they are not required to equal current source revisions during image validation.

`migrateMemoryImage(image, 1, 2, minimumWall)` uses the registered `memory-1-to-2` migration inside a transaction on a new RAM copy. It preserves source image bytes, Store `meta.ledger_key`, source runtime epochs, ingress/revocations and existing application state. It adds schema-2 tables/triggers and updates only the copied schema metadata. Unsupported versions and missing/malformed ledger keys are rejected before migration.

For an anchored schema-1 vault, use `AnchoredVault.migrateBackup({ ...restoreRequest, targetSchema: 2 })`. The package must still match the independent current exact head. The new target carries authenticated `schemaVersion: 2`, a new instance/owner epoch, and a parent-head migration receipt; the old source is fenced only through the same prepared cutover protocol. Existing keys, quota and native-request deduplication state remain intact. Opening the target then performs its actual boot reset and unknown-terminalization. The source package and files are preserved. This does not import an old unanchored M2.v1 vault or claim to fence legacy copies outside the v2 protocol.

## Bounds, cost and evidence

The IF2 figures below are the retained v2 full-image baseline. [IF3 v3 storage](INCREMENTAL-STORAGE.md) subsequently adds incremental disk writes, self-contained chain backups and new-generation compaction. It still serializes the full RAM image and does not change the consumer projection/rebuild contract.

The metadata journal permits 512 retained batches, 4096 items per batch, 16384 retained items, 32 consumers and 64 scopes. Source admission refuses a 65th scope before committing. A complete projection is limited to 512 source nodes, 2048 dependency edges and 1 MiB of normalized metadata JSON. Collection and image validation use the same byte accounting. These are explicit refusal bounds, not a claimed workload size or service-level target.

AnchoredVault still serializes a complete image per changed transaction: 16 MiB maximum image, 4096 commits and 256 MiB per local generation. The local directory retains both exact staging bytes and published ciphertext. `applyConsumers([a,b])` reduces two consumer checkpoint commits to one; it does not turn storage into an incremental journal. The cost fixture uses eight synthetic events, two consumers and no model calls. It measures actual checkpoint/record ciphertext growth separately from total directory growth including base64 stages.

The 2026-10-27 associated synthetic run used Node 24.16.0 on Windows with one test worker and fresh native TEMP directories (free RAM sampled at 2.816 GiB). Its bounded fixture recorded:

| Measurement | Observed |
| --- | ---: |
| Setup commits / subsequent source commits / grouped consumer commits | 4 / 40 / 8 |
| Complete source batches, including initial scope | 17 |
| No-change poll commits | 0 |
| Added checkpoint + record ciphertext | 11,123,934 bytes |
| Added local directory bytes, including staged base64 copies | 25,980,225 bytes |
| Largest checkpoint / peak local directory | 240,982 / 28,085,398 bytes |
| Source pipeline latency, mean / maximum for one event's five Store operations | 81.987 / 129.341 ms |
| Grouped consumer apply latency, mean / maximum | 15.269 / 21.293 ms |

These timings describe eight local synthetic operations, not an SLA, throughput benchmark or ten-year forecast. The measured ciphertext growth shows the remaining cost of full-image storage; the fanout feature does not claim incremental-storage efficiency.

The focused tests cover independent consumers, complete prefixes across scopes, atomic source/journal and projection/cursor rollback, source mutation coverage, time/ancestor expiry, pause/reset/boot/authority handle invalidation, pruning and full-journal maintenance, exact layout/metadata validation, schema migration preserving source/key/quota/revocation, and explicit maintenance interruption/reconciliation. All execution uses new synthetic RAM/native TEMP fixtures. Whole-suite validation is a separate independent step. Physical power loss, production migration, remote custody, cross-platform deployment, ten-year scale and real retrieval/scene quality remain outside this evidence.
