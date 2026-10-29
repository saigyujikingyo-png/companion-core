# Static capacity inspection (IF7)

`LocalSqliteAuthority.inspectCapacity()` and `AnchoredVault.inspectCapacity(request)` inspect retained storage without opening a live vault. They do not boot a Store, sweep TTL, change runtime epochs or leases, convert requests to UNKNOWN, admit a legacy import, reconcile a pending operation, or write an inspected image. The frozen [implementation contract](CAPACITY-INSPECTION-PLAN.md) defines this slice; existing [authority capacity admission](AUTHORITY-CAPACITY.md) remains unchanged.

Release candidate, 2026-10-27: the original IF7 freeze at `06fc8b2` passed 893/893 and typecheck. It is now integrated with WF2 main `87eab00`; the new combination passed one single-worker 984/984 run and typecheck, with 162 code files unchanged before/after execution. Exact-head cross-platform CI, independent review release and merge status belong to its separate PR and are not predicted here. This work did not deploy or start training.

```ts
const authorityReport = authority.inspectCapacity();
const report = AnchoredVault.inspectCapacity({
  authority,
  vaultId,
  keys,
  maxCalls: 4,
  directoryEntryLimit: 1024, // optional; only lowers the 16,384-entry default
});
```

The request accepts exactly these fields. Plain own data properties are copied before entering the authority guard. Accessors, proxies, path/head overrides, invalid limits, and invalid key sets are refused. Keys must be ordinary 32-byte Uint8Array/Buffer views with distinct storage and ingress contents; shared-memory views and customized subclasses/properties are refused. Inspection clears its copied keys and decoded image buffers in `finally`; caller-owned keys remain unchanged. This is not a claim that immutable JavaScript strings or all runtime allocations can be securely erased.

Both reports are detached, recursively frozen JSON-safe data. They contain counts, bytes, limits, statuses, and an allowlisted current audit head; they do not return memory bodies, source references, ingress identifiers/HMACs, receipt content, arbitrary stored extra properties, or a new write/retrieval capability. Counters include retained, revoked, and expired storage. They do not establish a currently valid retrieval selection.

## Status and guard

| Status | Payload details | Meaning |
| --- | --- | --- |
| ACTIVE | `detailsRead: true`; `currentHead` is the exact authority head | Existing marker, required chain, Safety, image layout/integrity/FTS, and schema2 fanout checks passed for this observation. An unadmitted legacy import stays unadmitted. |
| PREPARED | `detailsRead: false`; `currentHead: null`; bounded pending kind and sequence scalars | No old/new payload or stage is read. This does not assert that a stage exists or that reconciliation will succeed. |
| UNREGISTERED | `detailsRead: false`; `currentHead: null` | No source directory is inferred or created. |

`AuthorityTransaction.capacity()` supplies authority measurements inside the same existing guard as the head and source inspection. It rejects expired capabilities and a transaction poisoned by a caught mutation failure. A nested inspection still fails with the existing transaction error. A cooperating writer cannot acquire the guard during inspection; after return, the report is a historical observation, not a reservation or authorization.

The static API does not depend on the health of a live AnchoredVault handle. A legal ACTIVE source can therefore remain inspectable after a capacity failure poisons its live handle or when its authority exceeds a configured write soft limit. Existing corruption, key, fencing, hard-read, durability, and file-type refusals remain in force. Opening an authority may independently perform SQLite's existing hot-journal recovery; that is not a new inspection write.

## Report fields

Authority fields include the authority schema version, physical database bytes, page size/count/bytes, freelist pages, known journal/WAL/SHM sizes, their combined file size, actual configured write limit and fixed read limit, ACTIVE/PREPARED/total vault counts, receipt count and stored UTF-8 JSON bytes, and legacy-registry applicability/count. Schema2 authority reports legacy registry as not applicable with `count: null`.

Receipt JSON bytes are `length(CAST(receipt AS BLOB))`, not character count or table physical allocation. Counts and byte totals do not imply semantic validation of every historical receipt or registry row. Freelist pages are internal SQLite allocation metadata, not reclaimable disk space. `GLOBAL_PENDING` and `CURRENT_EXTENT_OVER_WRITE_LIMIT` describe observed facts; an empty blocker list does not mean READY or predict remaining writable operations.

ACTIVE generation fields include current sequence and the existing 4,096-commit bound, disk limit, directory statistics, and actually verified required-chain frame/file/encoded-byte counts. V3 reports the existing 16-frame and 64 MiB replay bounds; v2 reads one checkpoint/record pair and marks those v3 bounds inapplicable with null. Other generations and backups are explicitly `unmeasured`.

The new generation scanner uses streaming enumeration with buffer size 1 and at most `directoryEntryLimit` inspected entries, between 1 and 16,384. It does not recurse. Every inspected entry must satisfy the existing regular-file/no-symlink rule. If EOF is observed within the budget, total entries/bytes are exact for that scan; otherwise `complete: false`, `totalEntries: null`, and `totalBytes: null`, with only observed count/bytes reported as lower bounds. Reaching the budget exactly is conservatively incomplete, even if the next read would find EOF. Required-chain verification is separate and remains bounded by existing decoding rules; lowering the directory budget does not waive chain verification. Files outside the required chain are retained files, not identified deletion candidates.

The **existing authority guard still calls `boundSqlite`, which uses `readdirSync`**. Only the new generation scanner has the new enumeration cap. This slice does not claim the entire inspection call avoids all unbounded directory enumeration or alter the shared guard's errors/order.

Image fields include exact decoded bytes and the existing 16 MiB bound, schema and revocation high-water, and fixed row counts for meta/scopes/nodes/Store ingress/dependencies/jobs/outbox/artifacts/revocations/FTS. The inspector opens only a disposable RAM database. The existing FTS integrity command executes there; there is no serialization or source writeback.

Safety counts separately report its ingress count/8,192 bound, UNKNOWN count, reserved count, and configured maxCalls. Store ingress rows and Safety ingress entries have different meanings. Schema2 reports fanout batches/items/consumers/projection rows and stored projection JSON UTF-8 bytes, head/floor sequences, and the existing `FANOUT_LIMITS`. These are structural counters; per-scope retrieval closure, current eligibility and quality are outside this slice. Schema1 returns an explicitly inapplicable fanout section.

## Explicit retained roots

`inspectRetainedRoots({roots, entryLimit?})` from `src/retained-capacity.ts` is an independent, synchronous metadata API. It accepts 1–8 explicitly listed absolute leaf-directory paths in a plain dense string array; the plain request permits only own data fields. Getters, proxies, customized arrays, sparse arrays and invalid limits are rejected before path I/O. It needs no keys, authority, current head or live Store. `AnchoredVault.inspectCapacity` is unchanged, including its PREPARED/UNREGISTERED no-payload-read contract and `otherGenerationsAndBackups: 'unmeasured'`. The two reports must not be automatically summed into a complete vault total: this API does not prove root ownership, enumerate omitted backups or distinguish current/authority roots on the caller's behalf.

All listed roots receive path metadata validation before any enumeration. Original `..` path components are refused before normalization or filesystem I/O (POSIX `/`; Windows `/` and `\` separators); parent traversal cannot erase a linked component from the checks. Normalized/canonical duplicate or ancestor/descendant paths and known same-directory inode aliases are refused; root paths and their ancestors must not be symlinks/junctions. Missing/unreadable roots remain `UNKNOWN` with `canonicalRoot: null` when canonicalization failed. Initial unsafe root paths throw `ANCHOR_PATH`, overlaps throw `ANCHOR_CUSTODY_OVERLAP`, and malformed data throws `INVALID_INPUT`; these do not touch authority state. Metadata checks/canonicalization are filesystem reads and are not charged as enumerated entries.

The shared `entryLimit` defaults to the existing 16,384 maximum and may only be lowered. Streaming enumeration uses buffer size 1, never recurses and charges every yielded entry, including an unreadable or unsafe one. Only regular-file `lstat.size` values contribute to `observedBytes`; directories and links stop that root with `UNKNOWN / UNSAFE_ENTRY`. Reports preserve input order and include the input root, canonical root if established, observed entry count/bytes, and `EOF`, `TRUNCATED`, `NOT_SCANNED` or `UNKNOWN` with an explicit reason. Reaching the budget exactly remains truncated; later roots are not scanned. Encountered I/O failures and detectable root changes preserve partial observations without retry or a manufactured zero-size total. Only observed bytes are aggregated; unknown or unscanned zero observations do not mean empty directories.

EOF means only that this enumeration reached its end. No lock freezes external roots; identity/time checks cannot catch every concurrent deletion, replacement, content rewrite or filesystem race. The report is neither an atomic snapshot nor proof of physical uniqueness. Hard-linked paths can be counted more than once; sparse/compressed files still contribute their logical file size. There is no physical allocation, reclaimable-space, GC, key-validity, backup-restorability or retention decision in this API.

## Author evidence

The missing-feature red test is retained at `%LOCALAPPDATA%\Temp\aemc-if7-red-20261027T121533107`: the actual API call failed because `AnchoredVault.inspectCapacity` did not exist. The initial single v2 inspection and TypeScript check passed at `aemc-if7-first-green-20261027T121814959`; six initial TypeScript narrowing errors were corrected before that run and remain recorded as tool-output-only history.

The first expanded-suite admission on 2026-10-27 observed 1.022 GiB available RAM and refused before starting tests or typecheck. Its 1.5 GiB threshold was the author's conservative per-run choice, not a new project policy. That refusal is not a test-case failure or a completed expanded-suite result. The draft was frozen for two independent read-only reviews while memory remained low; its initial manifest covered 132 selected files, not the complete 136-file final manifest.

Both reviews identified the test stage filename mismatch; review also identified that key length must be checked before enumerating view indices. The stage fixture now reaches the actual preview SQL failure, and key views receive intrinsic byte-length/shared-buffer checks before index enumeration. A 33-byte view and a shared 32-byte view prove early rejection with a narrow observer; an ordinary 32-byte view at a nonzero offset passes and keeps its caller bytes intact.

After resources recovered, `aemc-if7-reviewed-focused-20261027T123640689` recorded 18/19 and TypeScript PASS. The remaining fixture captured the old generation before closing its live writer; normal close removed `writer.sqlite-journal`. The baseline was moved after close, preserving the exact full-file comparison for the subsequent compaction/inspection interval. The original failure remains retained; no production behavior or assertion was relaxed. Final author and independent results are recorded separately below; no unchanged IF6 benchmark or training campaign is replayed.

Final author verification on Windows/Node 24.16.0 used a fresh native TEMP namespace, canonical fixture roots and one test worker; admission observed 3.267 GiB available RAM. Logs: `%LOCALAPPDATA%\Temp\aemc-if7-author-verified-20261027T123736527`.

| Layer | Result | Log SHA-256 |
| --- | --- | --- |
| IF7 focused suite | 19/19 PASS; 0 failed/cancelled/skipped/todo | `46cb74a711f9bd1f730cc4138bbf9c11ac2f2fc54c638318596180f9c192c6ab` |
| Six affected suites | 161/161 PASS; 0 failed/cancelled/skipped/todo | `9b046c231ac242d9b4df7db6780a22ef8dd283e52a5c973c4e528a18ebf24402` |
| Strict TypeScript | exit 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The affected files are anchored-vault, authority-capacity, durable-fanout, durable-retrieval, incremental-storage and legacy-m2-import tests. These two suites are separate execution layers, not a whole-suite run. Source and test files were frozen afterward in a new 136-file manifest including the four paths omitted from the earlier draft manifest. Independent whole validation and exact-commit cross-platform CI remain separate; no claim of macOS/Linux IF7 execution or production acceptance follows from these Windows author results.

## Original IF7 freeze: independent closure

Two independent Astra max reviewers verified both P2 fixes and the compaction fixture interval, with no remaining actionable P1/P2. Each matched all 136 frozen source/test/package files by bytes and SHA-256. Their final reviews were static; they did not execute tests.

GPT-6.1 Sol separately ran one independent Windows/Node24.16.0 validation: `npm run typecheck` exited 0 and the actual single-worker `npm test` passed **893/893**, with zero failed/cancelled/skipped/todo. Node duration was 51.772s. All 136 files matched the author manifest before execution and were unchanged afterward; a separate read verified the persisted logs. These results do not add to the author counts. See [IF7 evidence and prior PR delivery](AEMC-INFRA-EVIDENCE-IF7.md) for hashes, failures retained and CI boundaries.

The original `06fc8b2` freeze was local, uncommitted and unmerged at that historical checkpoint. The current WF2 integration is a separate PR candidate with the 984/984 evidence above; its exact-head CI and merge results are recorded by the PR. Earlier merge-point CI covers IF0–IF6. Production custody, authority rollover, retention/GC, full retrieval diagnosis and AR1 quality remain separate work. This API grants no training, provider, private migration or deployment permission.
