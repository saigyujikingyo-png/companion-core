# Schema6 bounded authority sharding

This slice adds a real authority publication path after the schema5 four-slot limit. It keeps the original `authority.sqlite`, authority identity, current vault heads and exact historical R/S/L/M values. Its author checks are separate from independent review, integrated CI and production acceptance. It does not authorize real data migration, providers or training.

## Public contract

New authorities still start at schema2. After the existing explicit 2→3→4→5 migrations, call `LocalSqliteAuthority.upgradeShardedColdSchema(config, 'operator-attested-stopped')`. The schema5 handle must reopen. The upgrade validates its actual DDL, root extent, rollback headroom and unchanged business rows; it may refuse. It does not promise that a future maintenance request will fit. The synthetic fault hook accepts only the existing `after-table` and `after-version` points.

```ts
const c = authority.inspectCapacity().shardedColdRouting!;
const receipt = authority.archivePermanentKeysV2({
  operationId: 'ac2-next',
  expectedRouteEpoch: c.generation,
  expectedManifestDigest: c.manifestDigest,
});
```

The input is exactly three own data fields on an ordinary object. The normalized field order is `{version:2,kind:'authority-permanent-index-archive',operationId,expectedRouteEpoch,expectedManifestDigest,policy:'closed-two-shards-v2'}`. Operation IDs match `^ac2-[A-Za-z0-9_-]{1,96}$`; expected epochs are safe integers 0–13; the manifest digest is lowercase SHA256 of the root's canonical manifest JSON. Source rows are separately frozen inside the operation. Different business, IF8 and maintenance namespaces remain independent.

Under a healthy current closure, each relock looks up a committed M before pending, fresh epoch, stage or admission checks. Exact retries return the original receipt; a changed normalized request is `ANCHOR_COLD_CONFLICT`. The old `archivePermanentKeys` API still accepts only original ac1 requests and epochs0–3, and returns original M1–4 in schema6. It cannot initiate another v1 archive after upgrade. Its validators, four slots and original payload/receipt bytes have not been widened.

The v2 receipt field order is `{version:2,kind,operationId,requestDigest,fromEpoch,toEpoch,sourceSnapshotDigest,selectionDigest,moved,manifest}`. The newest M remains hot, and moves cold on the next publication with its original bytes and first moved epoch. This avoids a digest cycle. Legacy admission continues to check the supplied current head before returning an old admission receipt.

## One current root

Schema6 adds only this table; original tables and their schemas remain:

```sql
CREATE TABLE authority_shard_root (id INTEGER PRIMARY KEY CHECK(id=1), manifest TEXT NOT NULL, reservation TEXT) STRICT;
```

There is exactly one row. The canonical manifest's ordered fields are `{format:'companion-authority-manifest-v2',version:2,profile:'two-shards-1MiB-v2',authorityId,custodyDomain,epoch,parentManifestDigest,sourceSnapshotDigest,selectionDigest,current}`. Generation is the manifest's `epoch`, bounded at14. On upgrade, `parentManifestDigest` and `selectionDigest` are null, and `current` is null at epoch0 or `{format:'legacy-v1',descriptor:<original exact v1 descriptor>}`. No new cold files are required for upgrade. The source digest records the original v1 full source snapshot.

After a v2 publication, `current` has ordered fields `{format:'two-shards-v2',codec:'companion-authority-shard-sqlite-v2',partition:'sha256-full-key-bit0',attemptId,intent,parts,counts}`. Every file reference is `{name,bytes,sha256}`; `parts` is exactly `[part0,part1]`, including an empty part. Parent, source and selection digests are mandatory. `counts` is ordered `{receipts,segments,legacy,operations}` and equals the sum of both part counts. The old `authority_cold_route` remains historical schema5 metadata; schema6 readers select only `authority_shard_root`. It is not a second current route or a fallback.

Files are exclusively created as `cold-v2-<UUID>.intent.json`, `cold-v2-<UUID>-0.sqlite` and `cold-v2-<UUID>-1.sqlite`. The intent is canonical `{format:'companion-authority-shard-intent-v2',version:2,attemptId,request,authorityId,custodyDomain,sourceSnapshotDigest,selectionDigest,moved,parts,counts}`. Names alone or a self-described intent never establish authority.

The independent v2 SQLite codec has `user_version=2`, `application_id=0x41433132`, 4096-byte pages, UTF-8, no freelist, auto_vacuum0, strict known tables/indexes, defensive/query-only readers and unnamed RAM databases with MEMORY temporary/journal settings and no spill. The R/S/L/M physical column definitions follow the v1 codec, preserving raw UTF-8 BLOBs, IF8 payloads and moved epochs. Its metadata order is `{format:'companion-authority-shard-sqlite-v2',version:2,authorityId,custodyDomain,operationId,requestDigest,fromEpoch,toEpoch,partition,sourceSnapshotDigest,selectionDigest,counts}`. v1 images do not pass this codec.

Partition is bit0 of the first SHA256 byte over the existing typed, length-prefixed `hashRows` frame of kind and the **complete primary key**, including both R keys. Final comparisons use complete keys. Both images are loaded and verified, then merged with the hot root in binary primary-key order. Every guard checks duplicates, both directions of IF8 pointers, global128 IF8 segments, all three legacy identities, admitted/current-head relationships, and every maintenance epoch without gaps. Missing or corrupt current parts cannot become absent keys. No decoded context survives a COMMIT/relock.

The v2 full source snapshot hashes V/R/S/L/M in existing key order, adding each row's moved epoch as its final framed cell, then hashes the canonical current manifest as the final `@route` frame. The reservation itself is excluded. The business-preservation digest excludes M, route and moved epochs so tier movement can be checked without changing logical business values.

## Selection, reservation and recovery

Selection retains the original business batch limits:256 R rows,4 complete IF8 groups,16 admitted L rows and262144 framed business bytes. The complete old cold union and previous hot M are mandatory. The same full-key partition can split IF8 pointers from their S row. Both builders must succeed for the complete frozen batch; any full partition or other builder failure refuses before a reservation or file is created. This is more conservative than v1's physical group skipping and does not claim maximal packing.

After RAM construction, a relock verifies the unchanged full source/current manifest and absence of another publication or vault PREPARED. It previews the actual reservation insertion, the initial→rebuild reservation update, exact original-value row deletes, final manifest, newest M and reservation clearing inside rolled-back SAVEPOINTs. Intermediate/final page layouts, next-transaction starting pages and worst rollback journals are checked. Final used pages must be strictly below the pre-reservation used pages. Each rollback must restore page count, freelist count, source digest and root metadata. Only then is the original reservation committed.

The reservation's ordered fields are `{format:'companion-authority-publication-v2',version:2,request,sourceSnapshotDigest,baseManifest,selectionDigest,moved,rootPageCount,rootUsedPages,activeAttempt,plans}`. `plans` contains exactly two complete current-descriptor plans with distinct UUIDs and exact initial/rebuild file sizes/digests/counts. Both plans use the same payload bytes; their intents bind their distinct names. Remaining byte and entry obligations are derived from these exact plans and actual files, avoiding a second mutable budget ledger. `activeAttempt` is only0 or1.

The durable reservation freezes every new cooperating business mutation. Old read/retry paths retain their priority. There cannot be a vault PREPARED simultaneously. Recovery of the same reservation is completion, so lowering the configured soft admission limit does not revoke its already previewed completion; hard recovery bounds still apply.

Stage creation and publication hold BEGIN IMMEDIATE throughout synchronous exclusive writes, fsync, readback and final SQL. A second process cannot concurrently switch the active attempt. A dead process releases the SQLite lock. A complete active attempt is fully verified and reused. An absent attempt may be written from the unchanged source. A partial attempt is never appended to or overwritten: the root atomically selects the second preplanned attempt, commits that switch, then creates its files under a fresh lock. Unknown files already occupying a rebuild name refuse. A second partial attempt gives `ANCHOR_SHARD_ATTEMPTS_EXHAUSTED`; the current root and all files remain, and the pending fence stays. There is no automatic third attempt, cancellation, GC or quota refund.

Publication is one root COMMIT after complete file and union verification. A crash before it retains the old mapping plus its reservation. A lost reply after it is an ordinary M retry. All original v1 slots, retired v2 files and partial files remain charged and unchanged.

## Bounds and capacity evidence

Each part≤1048576 bytes (256 pages); two current parts≤2097152. Intent, inline root manifest, reservation and receipt each≤8192; normalized request≤1024. W remains12582912, B67108864, default soft22369621 and the existing optional lower soft limit remain unchanged. A maximum attempt is2105344 bytes; both attempts are4210688. Four full original slots plus two maximum attempts total8437760 bytes, subject to the actual root/journal proof.

Retained file bytes have a16777216 hard ceiling; directory entries have a32 ceiling including root, optional journal, original slots, current/retired/partial v2 files and reserved future names. The journal entry is reserved even when absent. A request must reserve both complete attempts. For every distinct bound name, accounting uses `max(actual bytes, required bytes)`. Missing current files retain their full obligations. Unwritten initial/rebuild bytes are reserved while pending; partial existing bytes remain charged. This is dynamic actual-plus-obligation accounting, not a permanent16MiB subtraction.

Before SQLite recovery, actual root, journal, retained files and W must fit B. After opening, canonical root obligations must also fit the physical hard bound. Before any root mutation or stage write, the worst-case bound is checked:

```text
max(startExtent, finalPages * pageSize)
  + startPages * (pageSize + 8) + 131072
  + retainedAndMissingAndReservedObligations + W <= B
```

Fresh admission also requires starting extent and final page bytes within soft. Read-only committed retries do not acquire a new write/journal admission test. Normal transactions keep their exact finalization preview and pending completion fence. Root extent can grow for admissible schema/reservation pages; this slice measures freed used pages and reusable freelist, not a shrinking file. It does not rescue a root whose existing extent is already above soft.

The author capacity acceptance uses public `claim` history at a fixed196608-byte soft limit: the new workload first fails capacity with the current head unchanged, the fifth archive lowers used pages, and the same request ID/fingerprint then succeeds within the same limit. A separate20MiB freelist structural fixture checks dynamic B accounting and missing-file obligations; it is not that business acceptance. Continuous v2 operations are supported until file/byte/epoch/admission bounds refuse, rather than one special fifth slot. No finite bound promises unlimited history.

`inspectCapacity().shardedColdRouting` reports generation, canonical manifest digest, current/retained/obligation/missing bytes, actual/reserved entries, hot/cold counts, used pages, bounded pending ID/attempt, W peak and limits. Existing schema2–5 output shapes remain. W reports charged live workspace, not measured RSS, GC overhead, OS physical allocation or total concurrent-process memory. Both cold parts are eagerly loaded; no RAM/I/O saving is claimed.

Every v2 builder also reserves a worst-case RAM statement journal of `256 * 4104 + 131072` bytes until construction finishes. Serialization, candidate validation, closure buffers and IF8 decoding use the same W pool. Candidate images are released before reloading the committed current; closure verification releases package buffers before reopening its images, and repair releases them before final current validation. Package-open failures release the already read package. These phase boundaries do not raise W or promise every input at the independent maxima is jointly admissible.

The final author synthetic size check used a 1,213,528-byte current (two parts plus intent) with an 829,040-byte decoded IF8 segment. Export, verification and missing-only repair completed with a charged peak of 10,675,376 bytes and zero remaining workspace tickets. A separate real fixed-key skew check accumulates mandatory old cold data until one part reports SQLite full, and confirms that root bytes, accepted files and the absent reservation remain unchanged. These are bounded local checks; raw evidence and exact source hashes are recorded in the ignored handoff and author freeze, not a claim of cross-platform or production acceptance.

## Closure compatibility

The existing `exportColdClosure`, `verifyColdClosure` and missing-only `repairMissingColdClosure` dispatch on the authoritative current format. Their `descriptor` result is the original v1 descriptor or the v2 manifest, discriminated by `format`. An upgraded bootstrap still accepts its exact old v1 closure. Once current is v2, a v1 package is stale.

A v2 package has exactly `closure.json`, `intent.json`, `part-0.sqlite`, `part-1.sqlite`, total≤2170880 bytes. Closure metadata≤65536 bytes, ordered `{format:'companion-authority-closure-v2',version:2,manifest,files}`; it binds the current canonical root manifest and exact package file sizes/hashes. Export requires a new disjoint directory. Verify requires the original live root. Repair checks every existing file before creating any absent one, validates the complete package/business closure, and uses obligations already retained for missing current files. It remains valid with a business PREPARED or publication reservation, but cannot exceed directory/budget constraints. Existing corrupt or partial files are never replaced, and root loss cannot activate a package.

All cold files remain plaintext metadata in the independently managed authority custody domain. SHA256 binds them to the root; it is not encryption or protection from an administrator rolling back both root and files.
