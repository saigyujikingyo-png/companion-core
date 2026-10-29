# IF8 bounded receipt segment rollover

This local API compresses committed authority receipts inside the same `authority.sqlite`. It preserves the authority identity, every committed receipt composite key, and the complete original receipt JSON. It does not replace the authority file, discard history, shrink the file, run a Store, or grant training admission.

The [original frozen plan](RECEIPT-ROLLOVER-PLAN.md) and [atomic repack addendum](RECEIPT-ROLLOVER-REPACK-ADDENDUM.md) jointly define this slice. The addendum supersedes the original UPDATE-only physical restriction: ordinary approximately 1 KiB receipts did not free whole pages when merely shortened. The original failed run remains evidence of that limitation. The implementation deletes and reinserts a bounded selected batch privately inside one transaction; every committed state retains the complete composite-key set. Internal SQLite rowid is not receipt identity.

## Explicit upgrade and API

Stop old writers before upgrading. Schema 2 must first use the existing explicit `upgradeSchema(config, 'operator-attested-stopped')` path to schema 3. Then:

```ts
LocalSqliteAuthority.upgradeReceiptSchema(config, 'operator-attested-stopped');
const authority = LocalSqliteAuthority.open(config);
const receipt = authority.rolloverReceipts({
  operationId: 'receipt-maintenance-001',
  maxReceipts: 128,
  maxJsonBytes: 1048576,
});
```

`upgradeReceiptSchema` is explicit 3→4 and idempotent on 4. It preserves the original table definitions and rows, checks the exact layout and integrity, and retains the pending/capacity gates. Existing handles fail their schema epoch check and must reopen. Calling the older schema-3 upgrade on schema 4 refuses with `ANCHOR_SCHEMA_ALREADY_NEWER`; it never downgrades. Upgrade may itself need free pages and can refuse near the soft limit, so it must be planned before exhausting capacity.

The rollover request accepts only ordinary own data properties. Proxies, accessors, unsupported fields and invalid limits are refused before entering the transaction. `maxReceipts` defaults to 128 and accepts integers 1–256. `maxJsonBytes` defaults to 1,048,576 and accepts integers 1,024–1,048,576. The byte limit covers the complete decoded frame, including both keys, JSON string escaping and framing, rather than only original receipt payload bytes. The compressed BLOB has a separate fixed 1 MiB ceiling. An authority retains at most 128 segments. Brotli quality is fixed at 4.

The returned recursively frozen metadata records operation ID, normalized request digest, receipt count, original JSON byte total, full decoded/encoded byte counts, segment digest and selected limits. The maintenance ID is authority-wide. Repeating the same ID and normalized request validates the segment and all its corresponding PK/pointers, then returns the original metadata without mutation, including while another vault is PREPARED or the segment ceiling is full. Different parameters with that ID refuse. Missing segments with surviving pointers are corruption, not unused IDs.

Requests that cannot select an eligible receipt, exceed a single receipt/frame bound, lack actual page benefit, or fail a capacity gate produce no durable success record. The API does not retry or perform automatic maintenance. A failure around COMMIT may have committed: reopen and resolve the same operation ID and exact request, rather than assuming rollback or choosing a new ID.

## Transaction and exact lookup

The original `receipts(vault_id, operation_id, receipt TEXT)` table, primary key and business finalize SQL remain unchanged. Schema 4 adds only `receipt_segments`. Selected TEXT becomes a canonical `@companion-receipt-segment-v1:` pointer. The entire original UTF-8 JSON string and its two keys remain inside the bounded frame.

Under the existing IMMEDIATE guard, the implementation first materializes bounded candidates and reads SQL byte lengths before allocating raw receipt bytes or stored BLOBs. It validates raw UTF-8 and JSON, builds every pointer and compresses the frame in RAM. Candidate rowid order is only a local layout heuristic, with no public ordering or identity guarantee.

It then deletes the complete selected batch using exact PK plus original TEXT equality and requires one changed row each. It reinserts all pointers with plain INSERT under the same PKs, inserts the segment, and checks selected pointer/entry/original-text closure and unchanged total receipt count. There is no callback, await, transaction release or receipt/legacy lookup while keys are absent. Any precommit failure rolls back the outer transaction. Segments are never updated or deleted by this backend.

Commit requires both `final page_count <= initial page_count` and a strict reduction of `page_count - freelist_count`. Unchanged soft admission and 64 MiB database-plus-worst-case-journal checks still apply. DELETE journal, EXTRA synchronous, no spill, MEMORY temp storage, no auto-vacuum, file identity and schema epoch checks remain in force. A cooperating process cannot consume the selected state while the guard is held. Raw SQLite administration, mixed obsolete writers and physical power-loss qualification remain outside this reference protocol.

Unified receipt lookup enforces encoded/decoded bounds, complete compressed-input consumption, decoded length/hash, fatal UTF-8, closed format/version, segment ID, entry index/count, JSON byte count and exact key binding. Missing, truncated, trailing, overexpanded, malformed or mismatched data fails closed. There is no raw fallback and no permanent decoded-history cache. Temporary byte buffers are cleared; this does not promise erasure of immutable JavaScript strings or all runtime allocations.

All existing business retries, conflicts and legacy `importReceipt` comparisons use this lookup. Rollover does not modify vault heads, Store images, ledger/ingress keys, Safety UNKNOWN/terminal state, reserved quota, feedback consumption, revocations, epochs, pending state or consumer progress. A later ordinary fresh open still performs its existing boot persistence and pending-to-UNKNOWN conversion; that is measured separately from rollover.

## Capacity observations and limits

Schema 2/3 capacity output is unchanged. Schema 4 retains `receipts.count` as the original PK count and `receipts.jsonUtf8Bytes` as raw plus archived original JSON bytes. Its added `receiptStorage` section separates hot raw rows, pointer count/stored bytes, segment count, actual stored BLOB byte lengths, declared decoded/archive JSON sizes and fixed limits. Structural reporting does not semantically authenticate every historical segment. Freelist pages are reusable internal allocation, not reclaimed disk space.

Every segment and index row still counts toward the same physical limits. The demonstrated case starts with extent at or below the configured soft cap and a new legal write that needs more pages and is refused. Already-over-soft authorities, the Store image 16 MiB bound, Safety's 8,192 entries, long-term growth, retention/GC and physical authority-generation replacement are not resolved by this slice. Some small batches still have no whole-page benefit and are explicitly refused.

## Author verification

Tests use Node 24.16.0, one worker and canonical fresh native TEMP synthetic fixtures. No real provider, Harness, training, private migration or deployment ran. All failed attempts below are retained under `%LOCALAPPDATA%\Temp\`.

| Stage | Evidence |
| --- | --- |
| Missing-feature red | `aemc-if8-red-20261027T134336775Z`: actual call failed because `upgradeReceiptSchema` did not exist. |
| First API green | `aemc-if8-first-green-20261027T134651235Z`: 1/1; initial TypeScript catch/finally return error retained. |
| Ordinary UPDATE-only failure | `aemc-if8-core-green-20261027T134849453Z`: 3/6, TS passed; ordinary receipt shortening did not release pages. |
| Rejected long-path fixture | `aemc-if8-overflow-green-20261027T135005367Z`: Windows SQLite refused before rollover. No product path gate changed. |
| Special overflow mechanism | `aemc-if8-maintenance-green-20261027T135148255Z` failed because the fixture had not advanced consumer progress; corrected `aemc-if8-maintenance-fixed-20261027T135228513Z` passed 6/6 and TS. This is limited overflow evidence, not ordinary-capacity acceptance. |
| Decoder/upgrade seam | `aemc-if8-decoder-20261027T135357712Z`: 4/4 and TS. |
| First repack core | `aemc-if8-repack-core-20261027T140035129Z`: 2/3 and TS; the remaining test expected the wrong existing error name for reserving UNKNOWN. |
| Expanded repack | `aemc-if8-repack-focused-20261027T140230257Z`: 18/19 and TS; revealed missing-segment maintenance-ID handling. The correction passed the targeted case at `aemc-if8-corruption-fix-20261027T140348434Z`. |
| Upgrade refusal | `aemc-if8-upgrade-refusal-20261027T140510923Z`: 1/1 and TS; pending and near-capacity schema 3 stayed unchanged. |
| Final author focused | `aemc-if8-author-focused-20261027T140623470Z`: 20/20, no failed/cancelled/skipped/todo; TS exit 0. |
| Author affected suites | `aemc-if8-author-affected-20261027T140810176Z`: 180/180, no failed/cancelled/skipped/todo; 22.923 s. Fresh admission recorded 4,768,380 KiB available RAM and 335,659,659,264 bytes free on C:. |

The final ordinary capacity test reached exact `ANCHOR_CAPACITY` with a 131,072-byte cap and 61 normal receipts. It retained 63,847 original JSON bytes in a 77,112-byte decoded frame / 7,072-byte BLOB. Database extent stayed 32 × 4,096 bytes; freelist increased 0→17 pages. Under the identical cap, fresh boot and subsequent claims/reservations succeeded, while UNKNOWN, payload conflicts, exhausted quota, consumed feedback and revoked Store ingress retained their original refusals. Final business checks left 15 free pages. These figures are a single bounded synthetic observation, not a throughput benchmark or predicted remaining-write count.

The focused suite separately verifies full sorted composite-key sets, unchanged unselected rows, real compaction retry/conflict, legacy import/admission, live durable retrieval, two segments, no-benefit rollback, persisted corruption, a real competing process, death after the DELETE batch, after partial pointer insertion, before BLOB and before COMMIT, and post-COMMIT response loss. The 128-segment ceiling test uses an explicitly labeled structural injection; it does not claim 128 legal historical rollovers. Byte/hash fault fixtures are likewise distinct from the ordinary legal capacity history.

The affected selection was anchored-vault, authority-capacity, capacity-inspection, durable-fanout, durable-retrieval, incremental-storage and legacy-m2-import. It is separate from the 20-case focused run; the counts are not combined into a whole-suite result. Initial sandbox CIM access was refused; subsequent native read-only resource checks succeeded. The author's 1.5 GiB RAM / 2 GiB disk admission floor was a conservative run choice, not a new project policy. No test execution was admitted below that observed floor.

Independent whole, two independent reviews, exact-commit CI and production acceptance remain separate layers. Author results do not predeclare those results or authorize training.

The later [IF8 independent closure and IF7 publication evidence](AEMC-INFRA-EVIDENCE-IF8.md) records those layers separately. The frozen plan and repack addendum remain unchanged; later documentation does not alter the execution manifest.
