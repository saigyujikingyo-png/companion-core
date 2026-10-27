# IF8 receipt lossless segment rollover — frozen implementation contract

2026-10-27. Scope: capacity governance for committed authority receipts. The user authorizes implementation, synthetic verification and independent review after IF7 publication; no training, real provider, private migration or deployment. This slice is logical receipt-segment rollover inside the same authority database. It is not physical authority-generation replacement, remote custody, infinite capacity, GC or deletion of historical evidence.

## Decision and compatibility

Keep the stable authority.sqlite and logical authorityId/custodyDomain. Keep the original receipts(vault_id, operation_id, receipt TEXT) schema and primary keys. Add a schema4 receipt_segments table containing immutable bounded Brotli4 BLOBs plus digest/size/count/operation metadata. A versioned, unmistakable pointer replaces selected raw receipt TEXT; the complete original UTF-8 JSON string and both keys remain inside the segment. No receipt PK is removed. Existing finalize SQL and schema2/3 formats remain unchanged.

Add explicit upgradeReceiptSchema(config, 'operator-attested-stopped', fault?) for 3→4, idempotent on4; schema2 requires the existing explicit2→3 path. Preserve existing upgradeSchema semantics, never downgrade4. Validate exact schema layout/integrity/identity, block any PREPARED, retain the existing admission and journal budget, and preserve original table content. Old handles must fail via schema epoch; stopping old binaries remains an operator requirement. Upgrade itself can be refused near capacity and must happen proactively.

## Minimum public seam

Add authority.rolloverReceipts({operationId,maxReceipts?,maxJsonBytes?}) returning detached frozen metadata. Accept only ordinary copied own data fields, validate before mutation, no path/head/key override. Optional limits only lower fixed defaults/hard bounds: at most256 receipts, at most1MiB total decoded segment bytes, at most128 committed segments; Brotli quality4 only. Default maxReceipts128; default maxJsonBytes1MiB. Author may choose a conservative minimum byte limit and a small fixed pointer format, documenting it without changing these hard bounds.

The maintenance operation ID is authority-wide and persisted with its segment. Same ID + exact same normalized request returns the original receipt without mutation after verifying referenced segment state; a different request with that ID fails. No candidate, overbound single receipt, no actual net page benefit, or capacity refusal produce no success receipt. A rejected operation is not silently replayed. Do not recursively compress pointers or change existing segments.

## One transaction, one authority

Use the existing IMMEDIATE guard and transaction poison behavior. Global PREPARED blocks new rollover; no new durable PREPARED state is needed. Verify the complete selected data and compress it in bounded RAM before changing SQL rows. Inside the same transaction: replace selected large raw TEXT with small pointers first, thereby freeing pages; then insert the immutable BLOB and maintenance receipt. This order avoids irreversible page_count high-water growth from inserting first. Keep cache_spill=OFF, DELETE journal, EXTRA sync, MEMORY temp, auto_vacuum=0, file identity, schema epoch and existing hard recovery proof.

Require final page_count <= initial page_count and a strict reduction in allocated pages (page_count-freelist_count); otherwise roll back with an explicit no-benefit error. Apply unchanged soft admission and64MiB database+worst-case journal checks. Do not special-case lower budgets, run VACUUM or replace/delete database files. SQL faults, swallowed mutation errors, commit ambiguity and process death must fail closed. Across a crash the database is either the old raw set or the complete pointer+segment set; a lost successful response is recovered by the same operation ID.

## Exact lookup and invariants

#receipt must transparently decode the exact original receipt. Bound stored BLOB bytes before allocation where practical; use maxOutputLength, complete compressed-input consumption, exact decoded length/hash, fatal UTF-8, closed format/version, segment ID, entry index, row count, original JSON byte count and exact (vaultId,operationId) checks. Pointers with absent/corrupt/mismatching segments refuse, never become a miss or fall back to raw. Do not cache decoded history permanently. The primary-key presence remains permanent consumption evidence.

All existing retry/conflict/prepare/reconcile/restore/compaction paths must use that same lookup. In particular legacy.importReceipt remains unchanged and equals the archived original via #receipt; lineage uniqueness, admission receipts and source fencing remain enforced. Explicitly audit all schema===3/!==3 branches for4 compatibility.

No Store image or schema, ledger_key, ingressKey, Safety ingress/reserved/maxCalls/feedbackConsumed/UNKNOWN/terminal, revocation high-water, vault head, owner/key/runtime epoch, pending state or consumer progress changes. Static rollover never boots a Store, sweeps TTL, refunds quota, reactivates a source, changes a historical head or starts a job. No training scripts or real Harness/provider execution.

## Capacity reporting and honest limits

Extend IF7 schema reporting to4. Keep receipts.count as the total original PK count and receipts.jsonUtf8Bytes as original receipt JSON bytes (raw TEXT plus archived original lengths); never count short pointer bytes as original receipt bytes. Add a separate explicit schema4 segment-storage subsection with hot/raw, pointer and encoded/decoded archive counts/bytes and segment limits. Existing schema2/3 report semantics remain unchanged; no need to alter their existing output shape. Structural capacity counters do not claim every historical record has been semantically authenticated.

Segments and index rows remain in the same database and count toward unchanged physical limits. Freelist is reusable internal space, not disk reclamation. Demonstrate relief only when the existing extent is <= configured soft cap but the next legal write needs more pages and is refused; after rollover that same cap must admit a new legal write. An already-over-soft legacy authority and image16MiB/Safety8192 growth remain outside this recovery promise. Every original receipt remains retained, so this is bounded compression and reuse, not removal of long-term growth.

## Required executable evidence

First reproduce the absent public API/required behavior, not a broken fixture. Use only canonical new native TEMP synthetic stores, Node24.16.0, one local test worker, and fresh RAM/disk checks. Do not kill other jobs. Preserve failures/refusals and separate stages.

Cover: schema3→4 and old handle fencing; unchanged old schema2/3; full raw receipt roundtrip including UTF-8 and legacy import/admission; repeated maintenance ID and parameter conflict; old business operation replay/conflict after archiving; successful writes across multiple segments; malformed/missing/truncated/trailing/overexpanded/hash/row-pointer mismatch; max rows/bytes/segments; no-benefit/no-candidate refusal with DB preservation; global pending; caught mutation failure; real process death before COMMIT and reopen; lost post-COMMIT response retry; real competing writers. Verify no source payload/keys/heads/Safety UNKNOWN/reserved/feedback consumption/revocations/consumer checkpoints change. Test actual existing retrieval/legacy/new-write seams, not just raw inserted receipt fixtures.

The material capacity acceptance must reach a real legal write's unchanged ANCHOR_CAPACITY under a lowered cap, preserve its failure, rollover, then show new writing and old dedupe/revocation/UNKNOWN behavior under that identical cap. Record actual page/freelist/receipt/encoded byte observations; do not turn this into a broad performance benchmark. Run focused and affected suites + TS, then freeze source for independent full validation and two read-only reviews. Tests/author docs are owned by one implementation agent; Root integrates entrypoint/evidence docs after freeze. Do not commit/push/merge IF8 automatically.

## Primary references and interpretation

SQLite documents that auto_vacuum=NONE keeps file size while freed pages are reused by later inserts: https://sqlite.org/pragma.html#pragma_auto_vacuum . Therefore the design aims to reuse pages, not shrink the authority file.

SQLite's single-file rollback-journal commit model and hardware assumptions: https://sqlite.org/atomiccommit.html . Savepoint RELEASE is not an independent durable commit: https://sqlite.org/lang_savepoint.html . The implementation must use the outer authority transaction; these references do not replace crash tests or establish physical power-loss qualification.
