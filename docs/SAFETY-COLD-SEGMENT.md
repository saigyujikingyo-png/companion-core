# IF10 immutable terminal Safety segment

This slice implements the frozen [IF10 contract](IF10-SAFETY-COLD-SEGMENT-PLAN.md). It does not delete historical generations, release consumed quota, resolve UNKNOWN, enlarge the 8192-request bound, train a model, or migrate private data.

`blocks-br4-safety-cold-v1` (P4) is an explicit v3 storage profile. Create/import starts with `safetyCold: null` and all entries hot. Only P3 (`blocks-br4-safety-br4-v1`) can upgrade directly to P4. Upgrade and `AnchoredVault.archiveTerminalSafety(request)` are two separate, idempotent effects. The latter reuses `CompactRequest` and authority kind `compaction`, with action `archive-terminal-safety-v1` in its independent request digest. A retry uses the original receipt's old head. Reusing its operation ID for compact/repack/upgrade conflicts.

Archive selects all newly eligible hot `failed`, `unknown`, and acknowledged/feedback-consumed entries, retaining every existing cold entry. No new eligible entries yields `SAFETY_ARCHIVE_NO_TERMINALS` before target creation. It preserves the complete canonical Safety value, Store image, revocation high water, keys and legacy binding. It reads exact CURRENT without opening a `MemoryStore`, booting, or reading the wall clock. A later normal open performs the separate existing boot transitions.

## Representation and access

`safety-format.ts` defines the closed descriptor, ordered hot envelope and lossless canonical JSON boundary. Arrays keep order; other JSON fields in globals and entries are retained. Unsupported values, getters, holes and cycles are refused. `safety-carrier.ts` keeps P3's original complete-Safety encoder/decoder and adds separate P4 hot-carrier entrypoints. Raw or Brotli4 is selected using the whole carrier size, with raw winning a tie.

`safety-segment.ts` uses one owned unnamed `:memory:` SQLite connection, with extensions disabled. Its ordinary-SQL RAM capability gate verifies TEMP_STORE support and the actual MEMORY temp/journal settings, disabled spill, no transaction, and only an unnamed main database before DDL/import, then again after deserialize. It does not invoke VACUUM or depend on FTS5 or a particular SQLite source ID. IF9's separate physical-repack runtime gate is unchanged.

The fixed STRICT/WITHOUT ROWID table, automatic indices, table/index metadata, SQLite integrity, UTF-8 JSON bytes, key/delivery/ordinal columns, counts and entry digest are checked before lookups. Cold plaintext is bounded at 8 MiB and encrypted once with AES-256-GCM. AAD binds the new generation context without the cold descriptor, head digest or sequence. Frame/record AAD includes the complete identity and descriptor. Plain buffers are cleared and connections closed; this does not promise zeroization of SQLite-owned or JavaScript-managed memory.

`SafetyLedger` provides one hot/cold view for request and delivery lookup, aggregate statistics, boot, append, archive selection and full-state validation. Ordinals remain the exact original sequence. Immutable cold no-ops do not save, change the head or update lastWall. Every live access and commit checks the required cold file's ordinary-file status, exact size and hash; a cached RAM database cannot conceal a missing or replaced file.

## Persistence and recovery

All new-generation maintenance uses the same `freezeGeneration` path: fix context, rebuild/reseal cold entries, install the descriptor, then freeze the base and record. Compact, repack, fanout maintenance, schema migration, restore and rekey preserve the existing partition. Ordinary writes and automatic early bases keep the same root/ciphertext. Each new target is self-contained; source files remain and old handles are fenced.

P4 has at most 15 required frames, 31 data files with a cold root or 30 with a null root, and separate 64 MiB limits for encoded reads and cumulative decoded material. Cold encoded/plain bytes are explicit baseline constants, counted once per recovery chain and retained when rebasing. Complete Safety JSON, hot JSON, carrier and frame header each keep the 4 MiB bound. Store 16 MiB, directory 256 MiB, 4096 commits and the prior marker/record/stage limits remain.

The target marker, cold file, base blob and stage are frozen before authority `prepare`, which retains its existing completion-space admission. RAM-determinable byte refusals happen before target creation. A later I/O/capacity refusal preserves an orphan without a successful receipt; retries do not silently reuse it. `safety-cold-written` is the additional fault point. Publish and finalize recheck the cold closure. Reconcile only completes the original frozen operation; missing or corrupt dependencies leave PREPARED unresolved.

Backup manifests include the exact required cold ciphertext. Rekey reseals it under the new DEK/key epoch. Restore still requires exact CURRENT: after rekey and any boot, export a fresh backup B before restoring B. Earlier backup A remains stale and cannot revive old quota or control state.

## Validation and measurement boundaries

The author tests are `safety-cold-segment.test.ts`, `anchored-safety-cold.test.ts`, and `safety-cold-runtime.test.ts`. They use fresh synthetic TEMP fixtures, real SQLite, real child exits, and independent authority contention. The 8192 fixtures are structural injection, explicitly not 8192 successful public durable operations. Author focused tests, affected regressions, independent review/whole and later exact-commit CI are separate evidence layers.

`scripts/safety-cold-measure.mjs` compares small, mixed and high-terminal histories. It uses cyclic public source updates on the same vault so the full logical Safety and exact Store image match at both arm boundaries, with no new business-content denominator for those updates. Upgrade, archive, boot, backup and preserved historical files are included separately. Application writes and fsync calls are measured at the Node filesystem boundary; SQLite-internal writes/fsyncs and physical device I/O are NOT_MEASURED. Authority full-file/sidecar extents and growth are reported as storage, never relabeled as write traffic. Process peak RSS includes overlapping SQLite, JSON, image, ciphertext/plaintext and staging allocations; component peaks are not independently measured and must not be summed.

Current author evidence and any pending reviews are recorded in the ignored project handoff and immutable native TEMP manifests. A contract acceptance or local test pass does not establish production deployment, long-term capacity, improved total I/O, or cognitive/learning acceptance.

### Author observation, 2026-10-28

The frozen author source passed 66/66 IF10 tests on Node 24.16.0 and 24.21.0. The final backup exception cleanup and runtime-policy assertion were then verified by the 22/22 affected lifecycle tests on each runtime; the unchanged pure-format tests were not repeated. Strict TypeScript and the 228/228 affected regression set passed. The original restricted-sandbox run remains 226/228 with two junction EPERM failures; the successful affected run used the authorized native environment. These counts describe separate layers and are not added. On 24.21.0, cold creation/read/write and other maintenance ran positively; physical Store repack was explicitly verified to refuse `REPACK_RUNTIME` with no target, receipt or state change. Node 24.16.0 required the positive repack path.

The final cost run used the same cyclic 24-change tail for each profile. Values below are actual successful Node application write bytes, including the full current backup; the P4 column additionally includes upgrade, archive and boot. Authority SQLite-internal I/O remains separately unmeasured. Fsync counts/time, full authority extents, full retained disk, recovery timings and process RSS are in the raw results.

| Public history | New ingress canonical JSON bytes | P3 tail + backup | P4 maintenance + tail + backup | P4 minus P3 |
| --- | ---: | ---: | ---: | ---: |
| Small, 2 requests | 465 | 162318 | 294211 | +131893 |
| Mixed, 12 requests | 2872 | 171216 | 307829 | +136613 |
| High terminal fraction, 64 requests | 14911 | 256589 | 373025 | +116436 |

All three observed sequences cost more with P4. Even the 64-terminal tail alone did not reduce application write bytes in this run. This is a preserved negative result, not a failure to preserve Safety. N=24 is an experimental bound, not a quota limit; unreserved failed histories and longer source-only tails can be studied under the unchanged limits in a separate bounded experiment. No 8192 structural fixture is counted as durable-history savings. The first cost attempt failed to parse before running any experiment; its original source/logs remain retained.

After those three negative observations, Root fixed one additional scenario before execution: `node scripts/safety-cold-measure.mjs amortization-256`, with 256 legal unreserved claim-to-failed requests and a 64-change source tail. It ran exactly once under the same resource/capacity gates, with no automatic limit change, rollover or parameter search. Only the declared scenario size, tail length and accepted CLI name changed; the original three scenarios were not rerun.

That additional sequence recorded 59647 normalized new ingress JSON bytes and zero reservations. P3 tail plus backup wrote 1138223 application bytes; P4 upgrade/archive/boot/tail plus backup wrote 881730, a difference of **-256493 application bytes**. Tail-only writes were 1090548 versus 512891, and P4 one-time maintenance was 188603 bytes. The current backup grew from 47675 to 180236 bytes. Actual serial-workflow retained disk grew from 7647368 to 8803530 bytes because originals, comparison history, generations and backups were retained. Process peak RSS was 159592 KiB. This one bounded result supports a conditional application-write tradeoff; it does not establish lower total disk I/O, lower RAM/CPU, or universal savings. The three earlier negative results remain valid separate observations.
