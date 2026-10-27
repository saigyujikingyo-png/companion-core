# Anchored v3: bounded incremental hot storage

The [final combined IF3/IF4 evidence](AEMC-INFRA-EVIDENCE-IF4.md) records the independent 822/822 whole suite, typecheck, two final read-only reviews and complete-vault measurement on the frozen final source. Historical author measurements below retain their original snapshot scope.

This implementation persists exact committed SQLite RAM images as immutable encrypted base/delta frames. It preserves the Store transaction and FTS commit boundary. Serialization and block comparison still scan the full image; the change reduces repeated persistent payload bytes, not the asymptotic RAM/CPU work.

## Explicit format and profiles

```ts
const vault = AnchoredVault.create({
  ...config, schemaVersion: 2, storageProfile: 'blocks-br4-v1',
}, 4);
```

The `AnchoredVault.v3` marker, `companion-anchored-vault-v3` identity, profile, schema, owner epoch, key epoch and instance are authenticated by the v3 frame/record AAD. Opening requires the same explicit profile. Omitting `storageProfile` creates/opens the existing v2 format. Existing M2 and v2 ciphertext, AAD and receipt contracts remain separate; there is no silent format upgrade.

`blocks-br4-v1` splits exact serialized bytes into fixed 4096-byte blocks. Changed-block replacement and XOR candidates are compared with a complete-image candidate using the same standard Brotli quality 4 and actual encoded descriptor/payload sizes. Compression is used only when its output is smaller than raw bytes. `full-br4-v1` is an authenticated forced-full profile used by the comparison control and usable by explicit production configuration. It also permits raw fallback. Neither profile introduces an entropy codec or a learned dictionary.

The first frame is a complete base. At most fifteen deltas follow any base; a full frame is selected earlier if its encoding is smaller or replay budgets would be exceeded. Truncation is explicit. Growth, partial final blocks and newly allocated zero bytes require exact patches. Indices must be strictly increasing and unique, with exact block lengths. Every delta authenticates the previous head and previous-image SHA256; every frame authenticates the target image length/hash, complete Safety state, stable ingress-key digest and revocation high water.

## Durable order and recovery

Each large frame ciphertext is written and fsynced once into a content-addressed immutable `blob-<ciphertext-sha>.bin`. A small immutable stage names that blob, its size/digest and the exact encrypted record. The stage never duplicates the large ciphertext as base64. Blob and stage are frozen before external PREPARED. Publishing verifies the blob and writes the fixed record; authority finalize makes the new head ACTIVE. The RAM durable baseline changes only after successful finalize. Any uncertain persistence poisons the live writer.

Startup reads and verifies only the required nearest-base-to-current-head chain, with every previous-head link, frame digest, image digest and final schema/FTS/highwater check. This is **required-chain validation**, not an audit of all retained historical files or orphan stages. A missing, altered or reordered required frame fails closed.

Explicit `AnchoredVault.reconcile` completes the originally frozen operation. A pending delta reconstructs its original predecessor chain from `pending.oldHead`; it does not boot a Store or rerun an application/provider callback. Missing or conflicting dependencies retain PREPARED/UNRESOLVED. Compaction/recovery stages contain a complete base and bind their old head as parent. No old-head rollback or quota refund is available.

## Self-contained current-state backup and cutovers

`exportBackup` copies the original required frame blobs and records, plus a bounded manifest and receipt. The exact head continues to bind the original ciphertext chain. Backup verification requires the independently held authority's current exact head. This package covers current state; it is not a complete historical archive and does not flatten/reseal an image under the original head.

Existing restore, rekey, schema migration and fanout-maintenance APIs accept a verified v3 chain, materialize its exact image, and write a fresh base in a new target. Storage key rekey retains ingress HMAC and Store ledger keys; source epochs, consumed quota, terminal states, feedback and fanout progress preserve their existing contracts. The actual target boot still terminalizes unfinished work and advances runtime fences.

```ts
const receipt = AnchoredVault.compact({
  authority, vaultId, keys, maxCalls: 4,
  targetDirectory: newDirectory, storageDomain: 'payload',
  operationId: 'stable-compaction-operation-id',
});
```

Compaction statically reads the authority's current exact head without constructing the source Store. It writes a new complete base, retains the schema/profile/key epoch, changes instance and owner epoch, and fences the old source through PREPARED/ACTIVE. It returns one immutable idempotent receipt. Source files remain byte-for-byte intact. The active directory becomes smaller; **total retained disk is not reclaimed**. No automatic GC, cold archive or history deletion is included.

`AnchoredVault.upgradeStorage({...request, storageProfile: 'blocks-br4-v1'})` performs an explicit anchored-v2 to anchored-v3 transition using the same current-head/new-target protocol. Authority rejects implicit format/profile changes through ordinary writes, restore or compaction. This does not import an unanchored legacy M2 vault.

## Bounds

- Maximum image: 16 MiB; local generation: 4096 commits and 256 MiB.
- Required chain: 16 frames; cumulative encrypted frame/record reads: 64 MiB; cumulative decoded base/patch bytes: 64 MiB. The latter counts decoded patch streams, not repeated materialized images. Reconstructed image work is separately bounded by 16 × 16 MiB.
- Frame header: 4 MiB; patch stream: image limit plus eight bytes per block. Compressed input and exact output are both bounded before use. Brotli output length, target hash and consumed input length are checked, rejecting extra bytes and concatenated streams.
- v3 backup/stage manifest: 64 KiB before JSON parsing; encrypted record: 32 KiB; marker: 8 KiB. Writer-side record/stage/UTF-8 marker size checks run before PREPARED, so a long identity cannot acknowledge a head that its bounded reader cannot reopen. Backup receipts are read under a 16 KiB bound before selecting the v2/v3 manifest path. v2 retains its existing larger package contract.

The authority still has its existing bounded receipt database. Repeated compaction does not promise unbounded authority growth, unlimited source retention or ten-year storage qualification.

## Verification and measurement contract

`test/incremental-storage.test.ts` exercises block bounds, entropy fallback, every required backup dependency, profile/key mismatch, bounded bases, five injected commit faults, three actual child-process exits, pending compaction, source fencing, explicit v2 upgrade, restore/rekey/schema migration and fanout maintenance. Related v2/fanout regression and typecheck remain required after integration.

The explicit `scripts/incremental-storage-measure.ts` command is not added to npm check or ordinary tests. It fixes twelve-event append, revision/revocation, dual-consumer and high-entropy workloads; normal API calls select v2 raw, v3 full Brotli4 or v3 blocks Brotli4. Each persisted image is reconstructed from real files and compared byte-for-byte to its own Store snapshot. Independent schema/FTS/highwater, stable Store ledger/HMAC and complete Safety checks accompany cross-arm source/consumer semantic checks using bijective entity aliases. Ordered nested values remain ordered; only SQL rowsets are normalized for comparison. Step and durable sequence counts must also match.

The primary cost gate counts actual end-minus-setup logical bytes in the entire hot vault and independent authority, including blob/record/stage/marker, database and present sidecars. Receipts already in the authority database are not counted twice. Backups and compaction are separate extensions. Each sparse workload must save at least 15% against v3 full Brotli4 and 50% against v2 raw. High-entropy results are reported without a savings requirement. Parameters are not tuned after observing results.

Observed peaks sample after API steps and final extensions; they are lower bounds and exclude transient SQLite journals between samples. Net file growth is not physical device writes. Reports separately retain original-source bytes, backup, active compacted target, total retained bytes, commit/startup/compaction latency, replay counts and process peak RSS. These bounded local synthetic measurements are not production SLA, cross-platform, physical-power-loss or ten-year evidence.

## Author evidence, 2026-10-27

The related synthetic suite passed **174/174**, with typecheck exit 0 (single worker, fresh native TEMP, Node 24.16.0, free RAM 3.657 GiB). It includes 21 incremental-storage cases and one measurement-protocol check. No whole-suite or training command was run for this slice.

The final reviewed measurement driver hash was `c3e13f2a7e2aa7bfe72dce112357302fc84338545b68295398661f529902c1d6`; protocol hash `1ea52c00ee2e3114b20dc1cbda40e38aabec298d9fae212d24dec7c45cce22be`. The final run exited 0, asserted fifteen runtime source hashes unchanged before/after, and sampled free RAM 4.064 GiB. Its required per-workload gates passed:

| Twelve-event workload | Commits in each arm | v2 raw growth | v3 full br4 growth | v3 blocks br4 growth | Saving vs v3 full / v2 raw |
| --- | ---: | ---: | ---: | ---: | ---: |
| Append | 69 | 38,203,421 B | 981,996 B | 516,051 B | 47.45% / 98.65% |
| Revision and revocation | 77 | 42,616,532 B | 1,142,694 B | 581,178 B | 49.14% / 98.64% |
| Two consumers | 95 | 54,707,086 B | 1,429,919 B | 719,870 B | 49.66% / 98.68% |

The high-entropy-text SQLite workload still shares unchanged database pages: it measured 909,014 B for v3 blocks, versus 4,504,819 B for v3 full. This is not an incompressible-whole-input claim. The separate fixed-seed 256 KiB random-block control explicitly chose **base/raw**, encoded 262,144 B, and restored exactly; no compression savings are claimed for it.

For the three sparse v3-block arms, new active directories after compaction and actual boot measured 25,398 / 28,696 / 27,070 B. Their original directories remained 417,413 / 474,396 / 588,498 B; total retained directory sizes including authority, backup and target increased to 606,482 / 711,120 / 859,939 B. Compaction took 27.51 / 33.78 / 31.56 ms and target startup 21.82 / 19.72 / 20.13 ms. Process maximum RSS was 240,504 KiB for the whole measurement process. Timings are observations of this bounded run.

Evidence locations: `%LOCALAPPDATA%\Temp\aemc-if3-associated-20261027T033947Z` (associated/typecheck/resource logs), `aemc-if3-measure-final-20261027T034053Z` (measurement/resource logs), and `aemc-if3-measure-f11ACV\report.json` (full per-arm results, traces and source hashes). Report SHA256: `6fb8746b3d83cce1c9eea425d654978e4d39fc00cdcd64be6815e3c5ba6a5888`.

First results remain historical: the first focused run passed 11/14; three assertions compared Buffer and Uint8Array container types rather than equal bytes, and were fixed without changing the codec. An initial measurement ran successfully with a weaker checker (over-normalized nested arrays, incomplete clock/source oracles); its log/report are retained at `aemc-if3-measure-author-20261027T033148Z` and `aemc-if3-measure-8t4upE`. It is not the final gate evidence, and had no retained pre/post source manifest. The reviewed rerun strengthened correctness checks and equalized arm directory lengths without changing the twelve-event workloads, codecs or savings thresholds.

After that measurement, independent review identified a long-path writer/reader size mismatch. Writer-side marker/record/stage limits were added without changing the normal encoding profile. The new pure-RAM boundary fixture first had a too-small stage example and a TypeScript literal annotation error (58/59 and typecheck exit 2, retained under `aemc-if3-bounds-20261027T034527Z`). The corrected fixture and affected v3/v2 suites then passed **59/59**, typecheck exit 0, at `aemc-if3-freeze-20261027T034623Z` (7.956 seconds, fresh RAM 3.733 GiB). The measurement above remains evidence for its recorded pre-boundary-fix source hashes; the later final independent measurement will cover the combined final implementation. It is not relabeled as a measurement of a different source snapshot.
