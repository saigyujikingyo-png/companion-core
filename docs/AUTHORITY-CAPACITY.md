# IF6 authority capacity admission

2026-10-27. Implemented by `LocalSqliteAuthority` according to the [frozen capacity plan](AUTHORITY-CAPACITY-PLAN.md). Schema 2/3 and receipt formats are unchanged. The existing combined reader ceiling remains **67108864 bytes (64 MiB)**. New write admission defaults to **22369621 bytes**, with `writeLimitBytes` optionally lowering it to an integer of at least 65536 bytes. It cannot raise the default or the reader ceiling.

## Behavior

Before committing a new PREPARED intent, the backend checks the proposed database, executes the same finalization SQL inside a rolled-back SAVEPOINT, and proves room for its completed state and rollback journal. New prepare/admit/schema-upgrade mutations are refused while any vault is PREPARED. That authority-wide write fence reserves the completion layout for the one newly admitted pending operation. Other cooperating processes cannot consume its space. Finalize/reconcile and nonmutating authority reads remain available, subject to their existing identity/health checks and the hard recovery budget. Existing multiple pending from old software can complete individually when that proof fits.

Every BEGIN/relock checks the schema epoch, physical file identity and bound, DELETE journal, EXTRA synchronous, no cache spill, MEMORY temp storage and supported page geometry. New admissions additionally require `auto_vacuum=0`, so commit cannot rearrange the layout after its preview. Each mutating commit checks `max(startBytes, finalPages*pageSize) + startPages*(pageSize+8) + 131072 <= 67108864`. The preview also checks the next transaction with the prepared image's page count as its starting size. The [plan](AUTHORITY-CAPACITY-PLAN.md#recovery-budget-argument) records the runtime-specific journal assumptions and fixed Node source reference.

`ANCHOR_CAPACITY` means admission or recovery headroom was refused; `ANCHOR_CAPACITY_PENDING` means another unfinished intent holds the global write fence. A caught prepare/finalize mutation failure marks the current authority transaction failed: subsequent mutation attempts and its outer commit refuse with `ANCHOR_TRANSACTION_FAILED`, so catching an exception cannot make partial PREPARED/registration/receipt SQL durable. A fresh transaction can inspect the last committed state. Immutable vault stages/blobs already written before admission may remain; this change does not delete them or claim they are committed.

An old ACTIVE authority above the soft limit remains usable for `inspect`, `assertActive` and receipt reads within the unchanged hard reader limit. This is not a guarantee for `AnchoredVault.open`, which performs boot persistence, or for a retrieval call crossing a TTL boundary, which must durably write a sweep barrier. Such writes fail closed if capacity or another pending intent prevents admission; stale text is not returned. After the pending operation is reconciled, a poisoned vault/service needs a fresh open, explicit consumer catch-up and fresh binding.

The reservation is software admission/isolation, not OS disk preallocation. ENOSPC and I/O failures remain possible. A historical unreserved pending with insufficient worst-case journal headroom remains preserved and unresolved. No rollover/GC, general recovery of such old pending, physical power-loss qualification, cross-platform qualification, deployment, training or merge is claimed. Operators must stop old writers while updating: old same-schema binaries and direct SQLite writes do not implement the new fence. One stuck pending can block new writes across this local authority; that is the deliberate availability tradeoff.

## Author verification

All author logs below are retained under `%LOCALAPPDATA%\Temp\`. Node 24.16.0 reports SQLite 3.53.0 and source id `2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b`, matching the [fixed bundled source](https://raw.githubusercontent.com/nodejs/node/v24.16.0/deps/sqlite/sqlite3.c). Tests use one worker and new synthetic native TEMP fixtures; no private keys/data/provider or model execution.

| Run | Result |
|---|---|
| `aemc-if6-red-20261027T083735833Z` | Expected missing-gate red: acknowledged database exceeded a 64 KiB lowered admission budget |
| `aemc-if6-slice-20261027T083952196Z` | 21/22, typecheck 0; sole failure was the old upgrade-while-PREPARED expectation, deliberately superseded by reconcile-before-upgrade with unchanged pending bytes |
| `aemc-if6-focused-20261027T084604409Z` | 29/29, typecheck 0; real future-finalization capacity refusal reached, swallowed failure could not commit partial state |
| `aemc-if6-associated-20261027T085014288Z` | 126/127, typecheck 0, 21.367 s; only failure was sandbox `EPERM` creating a TEMP junction before the tested authority call |
| `aemc-if6-junction-20261027T085109291Z` | That one blocked case rechecked through an approved native command: 1/1, no other test repeated |
| `aemc-if6-final-focused-20261027T085808906Z` | Actual hot-journal recovery case passed; the then-new legacy boundary fixture still failed to reach its intended capacity branch |
| `aemc-if6-legacy-preview-20261027T085919041Z` | Fixed legacy import boundary: 1/1; registry insertion and future receipt insertion both reached, capacity refused, original authority bytes and empty registration restored |
| `aemc-if6-final-seams-20261027T090103284Z` | 2/2 and final typecheck 0: caught real-finalize failure preserves PREPARED; another pending vault blocks TTL persistence/delivery until reconcile and fresh catch-up |

The 127-case affected selection was `authority-capacity`, `legacy-m2-import`, `anchored-vault`, `incremental-storage` and `durable-retrieval`. Later additive cases were run only by `--test-name-pattern`; their results are not mislabeled as one unified 131-case run. The standard commands were `node --test --test-concurrency=1 ...` and `node node_modules/typescript/bin/tsc --noEmit`, with explicit native `TEMP`/`TMP`. Root's independent final whole suite and measurement belong to the later frozen integrated source.

The extra legacy fixture's earlier nonpassing runs are also retained: `aemc-if6-legacy-boundary-20261027T085305429Z`, `aemc-if6-legacy-boundary2-20261027T085420337Z`, `aemc-if6-legacy-rollback-20261027T085543659Z` and `aemc-if6-legacy-page-boundary-20261027T085900717Z`, plus the table's `final-focused` run. These were test-layout misses, not hidden product errors: shorter rows fit the chosen limit; the first long-path fixture was refused before the preview. Direct inspection established the page sizes, then a legal long target and 69632-byte lowered admission limit hit the intended future-growth branch. The production cap and implementation were not weakened.

The new tests distinguish three evidence layers: real API/process PREPARED exit and reconcile; an actual nonzero-header hot journal intentionally generated by a raw SQLite spill controller then recovered by the real opener; and manually padded 24/34 MiB synthetic authorities used to exercise high-water read/recovery bounds. The latter two are fault/size fixtures, not legal business history, the new writer's physical power-loss behavior, or ten-year capacity measurements. IF5 source/tests stayed unchanged throughout IF6.

最终冻结组合的独立执行、审查和成本结果见 [IF5–IF6证据](AEMC-INFRA-EVIDENCE-IF6.md)：874/874、typecheck与固定协议测量均通过；作者历史记录保持原结论。
