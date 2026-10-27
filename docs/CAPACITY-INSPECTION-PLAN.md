# IF7: no-boot capacity inspection contract

Root decision, 2026-10-27. Implement only after IF0-IF6 PR #1 has merged and the isolated capacity-inspection worktree is handed to its sole writer. This is a new local implementation slice; no training, provider, private migration, deployment, garbage collection, automatic maintenance, or additional merge is authorized by this contract.

## Observable outcome

A trusted local operator can inspect bounded storage metadata even when opening a vault would require a capacity-blocked boot write. Inspection is not admission, current retrieval authorization, or a capability to perform a later write.

Public seams: LocalSqliteAuthority.inspectCapacity() and AnchoredVault.inspectCapacity({authority,vaultId,keys,maxCalls,...optional lower directory enumeration budget}). Add a transaction capacity() seam so authority and source measurements share one existing guard; no nested authority transaction.

## Invariants

- Preserve all existing writer limits, schema/format, transaction ordering, public errors and admission rules. No automatic compact/reconcile/admit/resume/sweep/GC/rollover or weakening of fencing.
- Never construct MemoryStore, invoke a clock, boot, reset epochs/leases, convert ingress to UNKNOWN, or serialize/write the inspected source. A disposable RAM image inspector may perform existing FTS integrity commands only in its private RAM database.
- ACTIVE reads only the authority exact-current head, verifies the existing marker/chain/Safety/image/fanout invariants and binds the report to that head. No caller path/ref/head override. An unadmitted legacy source remains unadmitted.
- PREPARED and UNREGISTERED are useful discriminated metadata-only reports: currentHead=null, detailsRead=false. No old/new payload or stage read, no availability claim. Pending summaries must select bounded known fields, never copy arbitrary receipt/state plaintext as report payload.
- Return detached frozen JSON-safe metadata. No memory bodies, source refs, ingress HMAC/IDs, receipt content, or new credentials/capabilities. Clean copied keys and decoded image buffers in finally blocks. Transaction-capability expiry and caught-mutation failure remain enforced.
- Ordinary healthy inspection must leave persistent file names/bytes, authority head/receipts, Safety, runtime epochs and journal unchanged. Opening an authority may independently perform existing SQLite hot-journal recovery; do not mislabel that old open behavior as inspection writing.

## Measurements and limits

Authority: schema, physical DB and known recovery-sidecar bytes, page size/count/freelist, actual configured write soft limit and fixed read hard limit, vault/pending count, receipt count and UTF-8 JSON bytes, legacy registry applicability/count. JSON payload bytes are not table physical allocation. Freelist is not reclaimable disk space. Blockers describe observed conditions only (e.g. pending globally prevents new mutation or current extent exceeds soft limit); no READY or predicted remaining writes, no promise to complete every old pending.

Generation: current sequence and fixed commit limit; streaming directory enumeration with a fixed maximum and optional validated lower per-call budget. Report enumeration completeness, observed lower-bound bytes and null exact total when incomplete. Required-frame count/encoded bytes come from the actually verified current chain. Chain-external files are not deletable garbage. Other generations/backups are unmeasured, not zero. Invalid inspected file types keep existing refusal semantics. Do not replace the existing authority boundSqlite helper in this slice: its pre-existing readdirSync enumeration remains a documented whole-call limitation; the new generation scanner alone gains a strict cap.

Image/Safety: exact decoded image bytes and existing 16 MiB bound, fixed core table row counts, separate Store ingress row count versus Safety ingress count/8192, unknown requests, reserved/maxCalls. Schema2 adds persistent fanout journal/consumer/projection structural counts and applicable fixed bounds; schema1 explicitly not applicable. These include retained/revoked/expired state and do not establish a currently valid retrieval selection. Complete scope/ancestor retrieval-budget diagnosis is deferred.

## Required evidence

1. Real v2/schema1 and v3/schema2 reports agree with independent byte/SQL counts; Unicode receipt bytes measured in UTF-8.
2. Repeated inspection preserves source/authority file bytes and names, head, receipt, Safety, epochs and journal; no wall/boot/sweep effects, including TTL crossing.
3. A legal ACTIVE source remains inspectable after capacity failure poisons its live handle; above-soft-limit authority read remains possible under the unchanged hard bound. This does not prove new admission.
4. PREPARED with missing/corrupt stage or inaccessible old payload remains metadata-only; UNREGISTERED creates nothing; another vault's pending does not trigger mutation.
5. Wrong keys, missing/tampered required frame, bad image or authority replacement refuse without source mutation. After actual compaction, inspection selects the new authority head and preserves image/Safety counts.
6. Real bounded directory scanning proves exact and incomplete branches without classifying unknown remainder as zero; report mutation cannot affect a later report.
7. Same guard prevents a cooperating writer from changing authority during measurement; test with real storage/process behavior or a narrow observer around real I/O, not a fake transaction.
8. Expired/reentrant/failed transaction capabilities refuse. No source quota/schema/admission changes.

Demonstrate the missing API, implement the narrow slice, run focused plus affected tests and typecheck, then freeze for independent review and independent integrated whole verification. Native TEMP, canonical fixture roots, portable absolute paths, one local test worker and fresh resource check. Reuse passed unchanged cost evidence as historical IF6 evidence; no unnecessary benchmark or old campaign replay.

## Sources and next work

SQLite page/freelist semantics: https://www.sqlite.org/pragma.html#pragma_page_count and https://www.sqlite.org/pragma.html#pragma_freelist_count . Optional per-table physical dbstat is deliberately not required: https://www.sqlite.org/dbstat.html .

Rollover needs stable authority epoch/root, cross-generation receipt/lineage lookup and old-handle fencing. GC needs retention/backup coverage and deletion authorization. Production custody and AR1 quality remain separate acceptance layers.
