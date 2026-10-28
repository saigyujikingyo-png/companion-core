# Bounded authority permanent-key cold routing (IF11)

Implementation candidate. Author checks, independent review, capacity observation and whole/CI acceptance are separate evidence layers. No production migration or training is authorized by this document.

## API and trust boundary

`LocalSqliteAuthority.create` still creates schema2. Explicitly apply `upgradeSchema`, `upgradeReceiptSchema`, then `upgradeColdSchema(config, 'operator-attested-stopped')` for 2→3→4→5. Schema5 adds a singleton route and a singleton current maintenance receipt. Original tables, authority identity, physical root file and current vault heads remain in place. Older handles fail their schema epoch check. No root replacement, VACUUM, automatic upgrade or file deletion is performed.

`archivePermanentKeys({operationId, expectedRouteEpoch})` accepts only two own data fields on a plain object; proxies, accessors, symbols and extra fields are refused. IDs match `^ac1-[A-Za-z0-9_-]{1,96}$`; expected epochs are integers 0–3. The normalized request is, in field order:

```json
{"version":1,"kind":"authority-permanent-index-archive","operationId":"ac1-example","expectedRouteEpoch":0,"policy":"closed-oldest-v1"}
```

Its operation namespace is separate from business `(vaultId, operationId)` and IF8 segment IDs. Under a healthy current closure, a committed maintenance ID returns its original frozen receipt for the same normalized request; a different request gives `ANCHOR_COLD_CONFLICT`. This precedes epoch, pending, capacity and staging checks at every publication relock. It does not relax any legacy admission head check: `admitLegacyImport` still asserts the supplied current head before returning an old admission receipt.

The cold files contain plaintext authority metadata, complete receipts and legacy declarations. They share the original independent authority custody domain; no vault DEK is used. Keep the authority directory and exported closure in equally confidential OS storage, independent of vault rollback. Requested mode0600 does not prove Windows ACL isolation. SHA256 binds integrity to the live root; it is neither encryption nor a separate anti-rollback authority. A compromised administrator or joint root/cold rollback remains outside this reference backend's protection.

## Physical format and limits

There are exactly four nonreusable slots, each `cold-slot-N.intent.json` (≤8192 bytes) plus `cold-slot-N.sqlite` (≤1048576 bytes), N=0…3. Schema5 permits only those eight names, `authority.sqlite` and optional `authority.sqlite-journal`: ten files maximum, no subdirectories, symlink/reparse directories or cold hard links. WAL/SHM are refused. Existing, retired, incomplete and stale files stay in place and consume their slots.

The current descriptor has fixed field order `{format,version,slot,epoch,intentBytes,intentDigest,payloadBytes,payloadDigest,counts}` and format `companion-authority-cold-route-v1`, version1. Counts are ordered `{receipts,segments,legacy,operations}`. Only that descriptor's payload contributes cold rows; older slots are retained evidence, never an additional union or fallback.

The cold SQLite format is `companion-authority-permanent-cold-sqlite-v1`, user_version1, application_id0x41433131, 4096-byte pages, UTF-8, auto_vacuum0, no freelist. It is created/imported in an unnamed RAM database with extensions disabled and verified MEMORY temporary/journal settings and spill disabled. Reading is defensive/query-only. Before any application-table query, bounded `sqlite_schema` metadata must describe exactly five physical tables and the two implicit legacy unique indexes; names are at most128 UTF-8 bytes and each SQL definition at most2048. Definitions, columns and indexes must match exactly; views, generated columns and extra objects are refused before expression evaluation. Header/page count, integrity and counts are checked too. This path neither invokes nor weakens the separate IF9 physical repack runtime gate.

Tables are `cold_meta(id,state)`, `cold_receipts(vault_id,operation_id,receipt_utf8,moved_epoch)`, `cold_segments(segment_id,request_utf8,digest,decoded_bytes,encoded_bytes,entry_count,json_bytes,payload,moved_epoch)`, `cold_legacy(lineage_id,migration_id,vault_id,state_utf8,moved_epoch)` and `cold_operations(operation_id,request_utf8,receipt_utf8,moved_epoch)`. All are STRICT; all except meta are WITHOUT ROWID, with the original primary and legacy unique keys. Original TEXT is stored as exact UTF-8 BLOB bytes, decoded fatally when needed. Original whitespace, property order, extra JSON fields and IF8 payload bytes are preserved. First `moved_epoch` is retained on later copies.

The exact `sqlite_schema.sql` strings are the following statements without their terminating semicolons. The two implicit indexes are `sqlite_autoindex_cold_legacy_2` and `sqlite_autoindex_cold_legacy_3`, with null SQL. No additional indexes or objects are accepted.

```sql
CREATE TABLE cold_meta (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL) STRICT;
CREATE TABLE cold_receipts (vault_id TEXT NOT NULL, operation_id TEXT NOT NULL, receipt_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL, PRIMARY KEY(vault_id,operation_id)) STRICT, WITHOUT ROWID;
CREATE TABLE cold_segments (segment_id TEXT PRIMARY KEY, request_utf8 BLOB NOT NULL, digest TEXT NOT NULL, decoded_bytes INTEGER NOT NULL, encoded_bytes INTEGER NOT NULL, entry_count INTEGER NOT NULL, json_bytes INTEGER NOT NULL, payload BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE cold_legacy (lineage_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, vault_id TEXT NOT NULL UNIQUE, state_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE cold_operations (operation_id TEXT PRIMARY KEY, request_utf8 BLOB NOT NULL, receipt_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID;
```

The schema5 root adds these exact definitions to the unchanged schema4 tables:

```sql
CREATE TABLE authority_cold_route (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL CHECK(epoch>=0 AND epoch<=4), descriptor TEXT) STRICT;
CREATE TABLE authority_cold_operation (id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, receipt TEXT NOT NULL) STRICT;
```

The meta record, in order, is `{format,version,authorityId,custodyDomain,operationId,requestDigest,fromEpoch,toEpoch,parentPayloadDigest,sourceSnapshotDigest,selectionDigest,counts}`. It contains neither its own payload digest nor the new receipt. Intent order is `{format,version,slot,authorityId,custodyDomain,request,requestDigest,fromEpoch,toEpoch,parentPayloadDigest,sourceSnapshotDigest,selectionDigest,counts,moved,payloadBytes,payloadDigest}`, format `companion-authority-cold-intent-v1`. The normalized new receipt is `{version,kind,operationId,requestDigest,fromEpoch,toEpoch,sourceSnapshotDigest,selectionDigest,moved,descriptor}`. `moved` is counts followed by `framedBytes` and `skipped:{receipts,segments,legacy}`. This receipt stays hot until the next archive; earlier maintenance IDs move into `cold_operations`. This avoids a self-referential digest and an unbounded hot maintenance table.

## Logical framing and selection

All SQL key order is BINARY/UTF-8 order. Logical rows have kinds V (vault), R (receipt), S (IF8 segment), L (legacy), M (maintenance). Fields are the table columns above excluding moved_epoch, using original hot column names and excluding singleton id. A row frame is one ASCII kind byte, one unsigned arity byte, the arity again as uint64 big endian, then each cell: one tag (`T` text, `N` number, `B` bytes), uint64 big-endian byte length, and content. Text is UTF-8; numbers are canonical decimal ASCII; BLOBs are unchanged. SHA256 is updated incrementally without concatenating a complete snapshot.

Snapshot order is V,R,S,L,M, each in primary-key BINARY order; it then appends a V frame with text `@route` and BLOB `JSON.stringify(currentDescriptorOrNull)`. This terminal frame is a separately positioned route record. Selection digest order is L,M,R,S then primary key. The source snapshot includes all current logical rows and the current descriptor; a route epoch alone is insufficient concurrency protection.

Each archive copies the complete old cold database and previous hot maintenance record. It selects, in order, complete hot IF8 groups by segment ID, remaining hot raw receipts by `(vault_id,operation_id)`, then ACTIVE/admitted legacy by lineage ID. A group that cannot fit is skipped intact. Framed size and remaining count limits are checked before retaining selected copies; oversize rows do not acquire a redundant copy ticket. Every IF8 group is fully validated before the size decision. Limits are 256 business receipt rows, four IF8 segments, 16 legacy rows and 262144 framed business bytes per batch. Missing/extra pointers are corruption, not oversized groups. PREPARED vault/legacy rows and required legacy admission stay hot. At least one business record must move; root page_count must not grow and used pages must strictly decrease.

Root-approved selection revision, 2026-10-28: the first fixed T10 remained `CAPACITY_BENEFIT_NOT_DEMONSTRATED` after 320 successful writes and an archive `SQLITE_FULL`; 261212 framed bytes expanded past the 1MiB image through WITHOUT ROWID overflow pages. The original frozen contract and negative result remain unchanged. New candidates first freeze the same bounded logical batch, then physically admit complete groups in that batch's fixed order outside the root transaction; previously excluded rows are not reconsidered. All old cold rows and the previous M commit first and are mandatory. Each subsequent group and its complete updated metadata uses one top-level RAM transaction; only SQLite errcode 13 may skip it, after explicit or automatic rollback and exact prior-image SHA, count and physical-format verification. Journals and before/after serialization tickets share the existing W; the same final image is published. Publication/recovery validates an exact, complete, bounded subset of the frozen batch, mandatory copies, original values, epochs, full source snapshot, digest and all moved/skipped counts; it does not re-prove that every physical skip was maximal. This accepts original complete v1 stages unchanged, preserves old committed receipts, and does not treat partial IF8 groups or other errors as capacity skips. The separately authorized, same-parameter revised-source observation is recorded below.

Schema5 IF8 rollover only selects hot raw receipts. Old cold raw receipts remain unchanged. IF8 retries, the global128-segment ceiling, business/legacy uniqueness and original receipt counts use the complete hot/cold union. Each guard verifies disjoint sets, all pointer links in both directions and current vault/legacy relationships before it can return absent. No cross-guard decoded cache exists; prepare/finalize's internal COMMIT/BEGIN also rebuilds the context.

## Shared budget and publication

The root default soft write limit remains22369621 bytes (config may only lower it to≥65536). B=67108864, K=4227072 for all four slots, W=12582912 for controlled workspace. Every schema5 write and exact completion preview reserves K+W even with empty slots. If P is page size, S starting pages, F final pages and E starting file bytes, admission requires:

```text
max(E,F*P) + S*(P+8) + 131072 + K + W <= B
```

New work additionally requires starting extent and final page bytes within the configured soft limit. Completion retains its original absence of a new soft-limit gate. Before SQLite recovery, actual root+sidecars+K+W must fit B. A fixed100-byte header read replaces the unnecessary whole-root temporary buffer; a legal root larger than W can still open.

W is one shared ticket pool per operation, including nested guards: file/read/serialize buffers, RAM images, preserved selections, UTF-8/parse/comparison representations, IF8 decompression, fixed metadata and closure output files. Public transaction row/receipt/legacy results are charged before parsing, and their tickets remain through the entire outer callback, including internal prepare/finalize relocks; repeated results can therefore exhaust W. Bounded capacity results are charged too. Internal streaming validation releases each segment before continuing. Tickets are obtained before bounded allocations; some reserve conservative maximum sizes. Reported workspace peak is the peak charged reservation, not exact RSS. The root pager, JS object/GC overhead and concurrent processes' total RSS are not disguised as this byte ledger. Actual RSS and physical disk use require separate measurements.

Schema5 stage hashing uses one charged65536-byte chunk plus1024 bytes of digest/metadata allowance, preserving the existing v2 stage length limit and v3 limit. Owned file reads reserve the observed length plus one EOF probe byte before allocation, bind the descriptor to the inspected identity, read only that length, and recheck descriptor/path identity and size. Growth during open/read refuses without allocating the grown file. The old schema2/3/4 stage verification path remains unchanged.

Freeze and candidate construction occur outside the publication SQL transaction. Intent and payload are exclusive-created and fsynced, then read back. Publication obtains BEGIN IMMEDIATE, validates root/current closure, checks committed M first, rescans all four stages, checks epoch/pending/new admission and compares the full frozen snapshot. A changed snapshot gives `ANCHOR_COLD_STALE_SNAPSHOT` and retains its orphan. No re-selection/rebuild retries it. Exact original-value deletes, route replacement and the new singleton receipt then happen synchronously in one transaction. Final union, page benefit and capacity checks precede COMMIT, the only publication point. A separate guard reads the committed receipt afterward.

Unreferenced partial intent blocks new archives with `ANCHOR_COLD_STAGE_INCOMPLETE`, while ordinary business still uses the healthy current closure. A unique complete same-ID stage is reused; two complete same-ID stages yield `ANCHOR_COLD_STAGE_AMBIGUOUS`. Current missing or altered files always refuse normal access. Old committed M remains higher priority than residual stages, capacity or pending state. No stage is deleted or assigned a new operation ID automatically.

## Closure custody and diagnostics

`exportColdClosure(newDirectory)`, `verifyColdClosure(directory)` and `repairMissingColdClosure(directory)` use a three-file package: `closure.json`, `intent.json`, `payload.sqlite`, ≤1122304 bytes total. Export requires a new directory disjoint from authority and live vault paths; it copies no root, keys or vault chain. Manifest format is `companion-authority-cold-closure-v1`, ordered `{format,version,authorityId,custodyDomain,descriptor,files}` with exact name/byte/hash entries. Results state `COLD_CLOSURE_ONLY / ORIGINAL_AUTHORITY_REQUIRED`.

Verify requires the live root's exact current descriptor; a prior epoch package gives `ANCHOR_COLD_PACKAGE_STALE`. Repair is the sole management bypass for missing current dependencies: it validates the original root and complete package under BEGIN IMMEDIATE, verifies all existing files, exclusively writes only absent descriptor-bound files, then performs normal closure validation. Existing bad/partial files are never overwritten. PREPARED may be repaired because K/W were already reserved. No root-loss, root-replacement or snapshot rollback activation is supplied.

`inspectCapacity()` keeps total receipt count/original JSON byte and total legacy meanings. Its `coldRouting` adds epoch/slot, hot/cold R/S/L/M counts, current/retained/retired/staging bytes, slots/files, K/W/B, peak charged workspace, used pages and full-slot blockers. `retainedBytes` includes all slots; staging includes unreferenced or unclassifiable remnants. Existing `receiptStorage.hot` describes raw uncompressed receipts across the union; physical tier counts are the new coldRouting fields. Schema2/3/4 retain their original output shape.

The added metrics shape is:

```typescript
type Counts = {receipts:number;segments:number;legacy:number;operations:number};
type ColdRouting = {
  epoch:number; slot:number|null; hot:Counts; cold:Counts;
  currentBytes:number; retainedBytes:number; retiredBytes:number;
  stagingBytes:number; otherSlotBytes:number; occupiedSlots:number; files:number;
  slots:{slot:number;intentBytes:number;payloadBytes:number}[];
  limits:{slotReserveBytes:number;workspaceBytes:number;sharedBytes:number;payloadBytes:number;slots:number};
  workspacePeakBytes:number; usedPages:number; blockers:Array<'SLOTS_FULL'>;
};
```

Stable cold refusals include `ANCHOR_COLD_REQUEST`, `UPGRADE_REQUIRED`, `FORMAT`, `HEADER`, `LAYOUT`, `INTEGRITY`, `COUNTS`, `IDENTITY`, `DIGEST`, `DUPLICATE`, `BOUND`, `WORKSPACE`, `FILES`, `FILE`, `CONFLICT`, `STAGE_INCOMPLETE`, `STAGE_AMBIGUOUS`, `STALE_SNAPSHOT`, `SELECTION`, `NO_BENEFIT`, `SLOTS_FULL`, `EMPTY`, `PACKAGE`, `PACKAGE_STALE`, `TRANSACTION` and `ROLLBACK`, each with the `ANCHOR_COLD_` prefix. `ROLLBACK` rejects a failed or inexact physical-fit rollback; `TRANSACTION` rejects an invalid internal candidate transaction state. Native exclusive file/SQLite errors may also surface. Refusal is not a missing key, refunded quota or permission to replay UNKNOWN.

This finite profile permits at most four successful archives and at most1MiB current cold payload. Failed staging can exhaust it sooner. It does not demonstrate unlimited history, total IO savings, ten-year reliability, production custody or training readiness. The fixed T10 capacity observation uses writeLimit524288, maxCalls8, at most512 ordinary public writes of512 ASCII evidence bytes, stops at its first actual capacity refusal and preserves that namespace. Any later continuation uses a fresh equivalent business key; negative observations remain negative.

## Bounded local validation (2026-10-28)

The final physical-fit revision passed strict TypeScript checking, 52/52 focused tests and independent review with no remaining P1/P2 findings. The frozen final source then passed the complete local suite, 1152/1152, with no failed, cancelled or skipped tests. CI is pending; these are bounded local synthetic results.

The original fixed T10 negative result remains `CAPACITY_BENEFIT_NOT_DEMONSTRATED`. R2 used the identical script and fixed writeLimit524288, maxCalls8 and at most512 ordinary public writes with512 ASCII evidence bytes each. It stopped at the first `ANCHOR_CAPACITY` after320 successful writes. One archive moved233 receipts and one complete IF8 segment; root freelist pages increased from0 to64. Opening the legitimate current vault and committing a fresh equivalent key reused one page, leaving63 free. Root fileBytes524288 and page_count128 remained unchanged throughout. Checks preserved all old receipt values, UNKNOWN and consumed quota, feedback consumption, revocation, consumer progress, legacy declarations, IF8 and maintenance idempotency. Current closure export/verification and missing-file repair passed while retaining the original payload and original root.

Costs are separate from that admission result: the cold payload was1048576B plus888B intent,1049464B retained/current cold bytes in one slot, with no staging bytes; the exported current closure was1050185B and measured repair took32.92ms. Instrumented successful completed JavaScript writes totalled6325864B with1027 successful fsync calls. Partial writes on error and SQLite internal physical IO/fsync were not measured. These figures do not establish total IO savings, unlimited capacity, cross-platform or production custody acceptance; the four-slot and1MiB payload limits remain.