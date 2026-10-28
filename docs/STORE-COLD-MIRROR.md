# IF12 Store persistent mirror

P5 `blocks-br4-safety-store-cold-v1` keeps the original schema 1/2 MemoryStore in RAM. Only its encrypted persistent representation separates immutable purged rows from the hot image. The fixed experiment did not demonstrate a write benefit: P5 remains an experimental, explicit opt-in candidate; P4 remains the existing route and the default is unchanged. This does not increase logical capacity, reduce runtime RAM, reclaim retained generations, or authorize training.

`AnchoredVault.archiveStoreTerminals(CompactRequest)` reads exact CURRENT P4/P5 and writes a new P5 generation, retaining the source. Existing receipts take precedence. The fixed `one-purged-generation-v1` policy selects the first previously unarchived complete eligible old generation by scope_id BINARY, then generation. Every node must be revoked, body NULL, search_text empty, projection_visible 0, and absent from FTS. Move these nodes, their ingress, and dependencies whose child is selected. Every incident dependency must have both endpoints in that group; a crossing edge refuses the first candidate. All other tables remain hot, including jobs, outbox, fanout, scopes, artifacts, revocations, FTS configuration and sqlite_sequence. Existing cold rows are mandatory. A first candidate exceeding the single 1 MiB decoded cold segment refuses the operation without trying another candidate. P4 to P5 uses the existing authority storage-upgrade transition; later P5 archives use compaction.

Hot carriers are internal partial images, never standalone MemoryStores. Reconstruction in configured unnamed RAM SQLite restores the original schema and exact values, then checks integrity, foreign keys, FTS, fanout, high water, and the original 16 MiB full-image bound. Raw TEXT bytes, SQLite integers, REAL values, explicit FTS rowids and sqlite_sequence survive copying. Every P5 authenticated frame and record binds a complete logical fingerprint independent of the hot block hash. Normal writes verify every cold row is unchanged and split/join has the same complete fingerprint.

Owned copy targets use verified 4096-byte pages and a read-back `max_page_count` of 4096 for hot/full copies or 256 for the cold segment before schema/row copying. Page count and page size are checked again before serialization, with the final byte-length check retained. SQLite FULL refuses the whole operation without selecting another generation or creating a target/receipt. These are image extent and serialization allocation bounds, not total SQLite working-memory or process-RSS limits.

Both cold descriptors bind to the full frame identity. Segment AAD binds the generation context while excluding descriptors to avoid cycles. Cold files are mandatory on current access, backup, cutover, rekey, migration and reconciliation. Missing, extra, changed, duplicated or wrong-generation data fails closed. New generations reseal both segments; ordinary writes retain their bytes.

P5 limits are 14 frames, at most 30 required data files and two backup manifests; P4 retains 15 frames. The original 64 MiB encoded read and decoded replay, 256 MiB generation directory, and 4096 commits stay unchanged. P5 decoded accounting includes Store cold bytes and a fixed 16 MiB full-reconstruction reserve. This is a decoding bound, not a heap/RSS claim. Original consumer limits and P1–P4 formats remain unchanged. Capacity, targeted synthetic validation, independent review, whole-suite/CI and measured write costs are separate acceptance layers.

## Local validation and fixed negative cost result (2026-10-28)

Strict TypeScript exited0; the final IF12 synthetic suites passed30/30. The earlier112 affected compatibility tests are reused TOOL_OUTPUT_ONLY evidence, not rerun or reconstructed logs. Independent actual Astra max review closed the pre-allocation-bound P2 with no remaining reproducible P1/P2. The final complete local suite passed1182/1182 with no failed, cancelled, skipped or todo tests; the frozen12 execution files were unchanged. Natural submission CI is pending.

The once-only fixed experiment returned `MEASURED / NEGATIVE_BENEFIT`. Its equivalent synthetic public workloads use independent identities and keys, not byte-identical histories. Each arm preserved its own complete logical fingerprint across maintenance; old-key idempotency/conflicts, UNKNOWN and consumed quota, revocation and both consumers passed their checks. Original generations, artifacts, raw result and exclusive once claim are retained. No parameters were tuned or experiment repeated.

| Successful JavaScript write-call bytes | P4 compact | P5 archive |
|---|---:|---:|
| Maintenance | 46747 | 88353 |
| Boot | 8053 | 11049 |
| 64 following events | 703095 | 1191296 |
| Verification | 24464 | 46958 |
| Backup | 99996 | 255077 |
| Comparison total | 882355 | 1592733 |
| Retained-byte increment | 1169075 | 1879453 |

P5 added710378B to both the comparison write total and retained increment. Setup is reported separately (P4/P5 successful write bytes1121705/1121581) and excluded from that comparison. Fsync calls are counted separately, never doubled as writes. Partial failed writes, SQLite physical writes/fsync, device IO and SQLite-owned memory were not measured. A smaller hot carrier does not establish lower total writes; this result does not demonstrate capacity, runtime RAM or retained-disk reclamation gains and does not solve write amplification. P5 is not promoted by this experiment; its existing finite limits and explicit opt-in remain.