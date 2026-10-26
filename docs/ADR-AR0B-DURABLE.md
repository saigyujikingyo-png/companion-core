# ADR: durable fanout requires a separate numbered migration

Status: **DESIGN_ONLY / MIGRATION_NOT_IMPLEMENTED**, 2026-10-26.

The current schema-1 outbox has one global pending/acked/revoked status. `projectionBatch` resolves a row against current payload/visibility; it is not an immutable event history. One consumer's ACK can hide work from another. Delayed upserts can observe newer content or become removals. The [RAM scene consumers](SCENE-AUTHORITY.md) deliberately do not use this outbox and do not persist their frames, ACKs or baselines.

## Decision and correctness boundaries

A future durable dispatcher needs an explicit numbered, transactional schema migration. Preserve the schema-1 SQL/hash/layout contract, reject unsupported formats, retain original source/checkpoint evidence and validate offline copies before cutover. Do not add tables while claiming the unchanged schema is still schema 1. M2 encrypted checkpoint/independent authority-ledger compatibility needs its own failure and recovery tests.

The source mutation and immutable journal entry must commit together. Each record needs a source authority/epoch, precise revision, operation, transaction/batch identity and versioned payload or a deliberately version-pinned reference. A current-payload lookup does not recover a historical payload. Duplicate notifications and transaction rollback remain explicit cases; the consumer must make replay idempotent. These choices follow the general [transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), not a claim that the present table already implements durable fanout.

Before migration, choose between a historical event journal and a smaller metadata-only invalidation journal with current authorized refetch. The latter cannot reconstruct past bodies; version-pinned references do not guarantee old payload availability. Neither design defaults to permanent retention of versioned private payloads, and metadata is also subject to privacy, retention and revocation policy. Offline consumers beyond the retained prefix must reset and obtain a fresh baseline. ACKs do not prove erasure of external copies or adapter unlearning.

Each consumer needs its own generation, durable applied checkpoint, reset/tombstone barrier and recovery state. A checkpoint describes a completely processed journal prefix or a proved complete batch range. It must not assume every integer sequence exists after scope filtering or rollback. Committing offsets strictly in order is valid; taking the maximum seen offset under out-of-order processing without a prefix-completeness proof can skip unseen records. Per-key tombstones prevent older values from resurrecting a deleted key, but do not by themselves make a multi-key source transaction atomically visible: transaction/batch boundaries and a read fence are still required.

An index hit and a complete current index are separate claims. Fresh authoritative validation can reject a stale hit, but cannot discover an omitted new item or prove that a baseline contains everything. A bounded baseline must be built from a consistent snapshot with a matching journal watermark, followed by all required changes beyond that watermark before activation. [SQLite read transactions](https://www.sqlite.org/isolation.html) provide a stable database snapshot; consumers still need a later fresh read for later authorization, and same-connection caller callbacks must not mutate during snapshot collection.

Retention must account for every required consumer and rebuild policy. A consumer that falls behind a retained prefix must receive a new baseline/reset rather than silently skipping gaps. Tombstone/barrier retention cannot be pruned solely because one fast consumer ACKed. External stores must persist their application and checkpoint atomically or use an explicit idempotent recovery protocol; an API ACK alone is not evidence of durable application or exactly-once external effects.

## External blob and crash matrix to freeze before implementation

| Failure point | Required behavior |
|---|---|
| Blob preparation fails before authoritative commit | No visible journal reference or consumer activation; preserve bounded failure evidence |
| Blob prepared, source transaction rolls back | No delivery; orphan cleanup is bounded and cannot delete a committed asset |
| Source/journal commits, dispatch crashes before send | Replay the committed record without inventing a second source mutation |
| Consumer applies, ACK/checkpoint fails or is lost | Re-delivery is harmless; do not infer the first application failed |
| Deletion commits while an older upsert/blob download is in flight | Authority generation and tombstone barrier reject stale activation; allow cleanup |
| Baseline completes across concurrent source transactions | Snapshot plus watermark and complete batch replay must produce one valid baseline |
| Consumer restore loads an obsolete checkpoint, or journal retention passed it | Fail closed and explicitly rebuild; do not reuse a stale baseline as current |
| Content-addressed blob is missing, hash-mismatched or partly written | Reject the whole activation, never silently substitute newer content |

The exact migration, manifest/blob ownership, garbage-collection protocol, multi-device permissions and retained-prefix bounds remain unfrozen. SP0A/AR0b0 implements only current-source validation, RAM full replacements and explicit restaging after M2 source recovery. No migration, persistent dispatcher, journal, external blob operation or durable consumer is implemented here.
