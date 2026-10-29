# IF8 atomic receipt repack addendum

2026-10-27. This narrow amendment supersedes only the original plan's physical requirement to UPDATE rows without any DELETE. The original RECEIPT-ROLLOVER-PLAN.md and its SHA61a0ccad4bbcab35dff22629dfea69ae335843a5deb890033a2eab8c12651d78 remain immutable history. All public outcome, bound, capacity, no-training and preservation requirements remain in force. Root selected this correction after executable ordinary-receipt failures and independent architecture review.

## Evidence driving the change

The UPDATE-only implementation correctly refused NO_BENEFIT for ordinary approximately1KiB receipts: shortening cells need not free SQLite leaf pages. The original3/6 core run remains a failed ordinary-capacity acceptance. A long-path fixture was refused by Windows SQLite before exercising rollover and does not justify changing path rules. A later6/6 special overflow-receipt mechanism run remains limited evidence, not acceptance for ordinary receipts. Do not tune the core test to huge paths/consumer IDs to avoid the ordinary failure.

## Committed-state preservation and private repack

The permanent invariant is: every COMMITTED state has exactly the same receipt composite-key set, and every original receipt JSON byte sequence remains recoverable under that key. No consumed ID, UNKNOWN, quota, feedback, revocation, legacy registration or source head is removed, reset or rewritten. Internal rowid is not a public identity and need not be preserved. The receipt table and business finalize SQL remain unchanged.

Within the existing single BEGIN IMMEDIATE authority guard, after bounded selection and complete raw-byte validation/compression in RAM:

1. Freeze at most256 unique selected(vault_id,operation_id)keys and exact original UTF-8 JSON strings; fully prepare corresponding pointers and segment data before any SQL mutation.
2. DELETE the entire selected batch with exact composite key AND original receipt equality conditions. Every statement must report changes===1. Do not touch unselected rows.
3. INSERT the entire batch of pointer rows under those exact same keys. Use ordinary INSERT with changes===1, never REPLACE, IGNORE, UPSERT or overwrite-on-conflict.
4. INSERT the bounded compressed segment and its durable maintenance receipt.
5. Before the one outer COMMIT, verify the selected keys one-for-one, exact pointer/segment/entry-key/original-byte binding and unchanged total receipt count. The validated schema has no receipt FK or triggers; together with exact-key SQL this establishes the global key-set invariant. Tests must independently compare the complete sorted key set and unselected row bytes, not just row count.
6. Retain page_count non-growth, strict reduction of allocated pages(page_count-freelist_count), unchanged soft/hard/journal budgets and the global PREPARED fence. If the actual layout has no benefit, roll back; static reasoning does not guarantee all batches benefit.

Delete all selected rows before reinserting all pointers, rather than interleaving one-by-one, so B-tree rebalancing can operate. Selecting raw rows by internal rowid is allowed solely as a local bounded physical-layout heuristic; it is not a stable identity, public ordering guarantee, cross-version address or input authority. All matching/lookup remains by composite key.

The intermediate missing-key state is private to the transaction. Do not COMMIT, RELEASE the outer transaction, await, relinquish the authority guard, invoke arbitrary user callbacks, or expose a transaction capability during that state. Keep ordinary non-shared-cache isolation; dirty-read/shared-cache operation is unsupported. Fail closed if key matching, insertion, segment validation or capacity checks fail. Any error before COMMIT must poison the operation and trigger outer ROLLBACK, even if a lower layer catches an error; SQLite's default ABORT only undoes its failing statement and is not sufficient.

COMMIT failure/response loss is different: do not assert rollback when durability is uncertain. A fresh connection must determine the old complete state or new complete state by the same maintenance operationId and exact normalized request. A successful operation's retry validates segment and corresponding PK/pointers before returning the stored result, even when the new-operation segment limit is reached or another vault is PREPARED. Never return an intermediate or partially missing-key state as success.

## Added executable acceptance

The ordinary core fixture must use normal short canonical paths and ordinary receipt history. Reach a real unchanged soft-cap write refusal with existing extent<=cap; preserve that failure; rollover; then under the identical cap allow fresh-open boot costs and a subsequent genuine business write. Show actual page/freelist metrics, complete key/receipt retention and the existing UNKNOWN/consumption/revocation oracles. Keep special overflow evidence separately labeled.

Add real process deaths after the full DELETE batch, after a partial pointer INSERT batch, and before segment insertion; reopening must show all original keys/JSON and no committed new segment. After successful COMMIT, verify all pointers+segment+original JSON and the old-operation/legacy conflict checks. Add a lost response after COMMIT test using the same maintenance ID. Fault injection belongs in isolated synthetic test instrumentation, not arbitrary production callbacks exposed in the missing-key interval.

This remains a bounded same-file logical rollover, not physical DB replacement, GC, erase, cold-storage migration or infinite capacity. No real user store is mutated in this engineering task; only synthetic native TEMP fixtures exercise the new API.

## Primary references

SQLite isolation for ordinary connections: https://sqlite.org/isolation.html . Default ABORT preserves earlier transaction statements, so the outer rollback remains mandatory: https://sqlite.org/lang_conflict.html . Rowid is distinct from the declared composite business key and is not guaranteed persistent: https://sqlite.org/rowidtable.html . These justify the transaction design but do not replace process-crash and ordinary-capacity tests or establish power-loss qualification.
