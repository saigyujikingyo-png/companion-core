# Store physical repack and packed Safety snapshots

IF9 adds two explicit, bounded capacity operations under the [frozen contract](CAPACITY-REPACK-PLAN.md). Both preserve permanent exact identity, UNKNOWN, consumed quota, delivery IDs, consumed feedback and revocations. They do not delete history, raise limits, resolve uncertainty or admit training.

## Store repack

```ts
const receipt = AnchoredVault.repackStore({
  authority, vaultId, keys, maxCalls,
  targetDirectory, storageDomain, operationId,
});
```

The current source must use v3 storage and application schema 1 or 2. Under the existing authority guard, the method reads the exact current encrypted generation and validates an owned disposable RAM image. It does not construct a MemoryStore or boot/reset the source. It performs `VACUUM` only on that unnamed RAM connection; there is no plaintext output path, `VACUUM INTO`, user-path attachment or live database vacuum.

Admission requires SQLite 3.53.0 with source ID `2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b`, FTS5 and an explicit compile option `TEMP_STORE=1`, `2` or `3`. `TEMP_STORE=0`, absent/unknown configuration or any other source refuses this API with `REPACK_RUNTIME`. The connection must actually report `temp_store=MEMORY`, `journal_mode=MEMORY`, cache spill disabled, an empty main filename and no open transaction. These settings precede integrity checking, FTS work, sorting and fingerprinting. Other existing APIs retain their original runtime admission.

Before and after packing, validation checks the exact known schema, SQLite integrity, foreign keys, FTS integrity and schema-2 fanout closure. A streaming SHA-256 fingerprint covers every application column ordered by explicit logical keys, with type and byte-length framing. It includes ingress bindings, dependency edges, jobs/results, outbox, artifacts, original revocation reasons/times, scope/runtime values, complete fanout journals/consumers/projections, `sqlite_sequence`, FTS rowid/content and every FTS configuration row. TEXT is hashed as its exact SQLite bytes. Ordinary tables' implicit rowids are not application identity.

The result must be strictly smaller and remain within 16 MiB. `REPACK_NO_BENEFIT` and logical mismatch refuse before target creation or successful operation-ID consumption. A successful result uses the existing `compaction` receipt kind with the distinct request-digest field `imageTransform: lossless-repack-v1`. The old compact digest is unchanged. Reusing the same repack request returns its original receipt; invoking normal compact with that ID conflicts.

The new generation retains profile, DEK, ingress/Store ledger keys, Safety and revocation high-water; it increments owner epoch, creates a new instance and starts at sequence 1. Source files remain, and the source is fenced by the new authority head. Original operation IDs and rows remain permanent. A later normal open retains its existing conservative pending-to-UNKNOWN/runtime boot behavior; that later behavior is separate from maintenance's exact preservation.

## Packed Safety profile

```ts
const receipt = AnchoredVault.upgradeStorage({
  authority, vaultId, keys, maxCalls,
  targetDirectory, storageDomain, operationId,
  storageProfile: 'blocks-br4-safety-br4-v1',
});
```

The new profile can be selected for a new vault, legacy import or explicit upgrade. Upgrade accepts v2 to v3 as before and additionally permits either original v3 profile to this new profile. It refuses same-profile re-upgrade and downgrade. Normal compaction/repack preserves the profile. Marker, head, identity, AEAD associated data and authority transitions bind the profile; readers do not reinterpret old frames.

The header carries a closed `{version, codec, decodedBytes, digest, data}` descriptor. Version 1 uses either complete inline Safety JSON (`raw`) or canonical base64 Brotli quality 4 (`br4`). The encoder compares the entire serialized carrier, including base64 and descriptor overhead. Empty/tiny snapshots can therefore use inline JSON. Safety itself remains v1: no field/array reordering, omission, normalization or new business semantics.

Every decoded Safety snapshot is bounded at 4 MiB, and the original 4 MiB frame-header bound remains. The reader validates descriptors and cumulative image-patch plus Safety decoded bytes before expanding that frame's Safety stream. The writer accounts the same bytes and emits an earlier base when needed. Existing profile replay accounting and wire behavior are unchanged. The 16-frame, 64-MiB replay, 16-MiB image, 256-MiB disk, 8192 ingress and maxCalls ≤ 32 limits remain.

Malformed shapes/codecs, noncanonical base64, invalid UTF-8 or JSON/BOM, incorrect lengths/hash, truncated/trailing/concatenated compressed input, excessive expansion, wrong identity and invalid original Safety state all refuse. There is no fallback to prior or empty Safety. Business code receives the original validated Safety v1 shape. Backup, restore, rekey, normal compaction, pending reconciliation and legacy import use the same normalized decoder and remain self-contained.

## Recovery and verification scope

Both operations retain the existing exact-head CAS and durable PREPARED/publish/finalize protocol. A PREPARED or ambiguous result requires reconciliation of the original frozen target. Missing or corrupt required files refuse; no success is reported before durable finalization. A finalized response loss returns the original receipt on exact retry. Source/partial files are retained, with no automatic orphan cleanup.

The synthetic test suite covers schema 1/2 ordinary freed pages, no-benefit refusal, complete logical preservation, real new-target open and legal new writes, Safety roundtrips and corruption, explicit profile transitions, real child exits at PREPARED/during publish/after finalize, a real competing authority process, other-vault pending state, backup/restore/rekey and legacy admission. Cost output labels actual public API history separately from RAM structure-injected 8192-entry stress. Random keys/fingerprints and short identifiers are used; structural stress does not claim a legal 8192-operation durable history. Source hashes, raw attempts and exact final candidate evidence are retained separately by the author and integrated by Root after independent review.

Physical repack reclaims fragmentation and freed extent. Safety packing reduces repeated representation overhead. Neither yields unbounded exact history, garbage collection, authority-file replacement, a hot/cold router, ten-year reliability or production performance. Future archival work still needs authenticated immutable segments, exact permanent request/delivery/Store/legacy indices, shared transaction/fencing, complete backup/rekey/cutover closure and explicit retention/capacity policy. Missing history must remain corruption rather than absence. I17 remains design only.
