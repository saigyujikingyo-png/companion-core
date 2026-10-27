# IF6: bounded authority writes and reserved completion

Frozen before source implementation, 2026-10-27. Root approved a conservative single global PREPARED admission rule for this local reference backend. This follows two synthetic scaled-threshold reproductions: an acknowledged ACTIVE write and an interrupted PREPARED compaction grew past the existing read ceiling. Their native report is `%LOCALAPPDATA%\Temp\aemc-authority-capacity-native-8c211f5784344303b1b185159a22af1b\report.json`. The experiment changed only the copied reader threshold to 64 KiB; it did not measure a 64 MiB production run.

## Fixed boundary

- Keep the 64 MiB (67108864 bytes) combined main SQLite database / journal / WAL / SHM read bound, current schema 2/3, old receipts, keys and references. No GC, rollover or migration.
- New mutation admission uses a database soft limit of floor(64 MiB / 3) = 22369621 bytes, rounded down implicitly to complete SQLite pages. An optional `writeLimitBytes` may only lower this admission limit, never raise the read/recovery bound; it is useful for bounded synthetic tests. Completion uses the unchanged hard proof, so reopening with a lower admission limit cannot consume or revoke a reservation.
- Existing ACTIVE databases above the new write soft limit but within the old hard read bound remain inspectable. New writes can be refused. Historical pending without a demonstrable recovery budget stays preserved/unresolved; no promise to recover every old pending.

## Admission and completion algorithm

1. Open with DELETE journal, EXTRA synchronous, MEMORY temporary storage and `cache_spill=OFF`; verify these settings. Under every BEGIN/relock, recheck schema epoch, physical file bounds and identity, current page count/page size and settings. Reads do not enter the write gate.
2. Before create/prepare/admit/upgrade changes, check the starting database against the new write limit. Except initial empty provisioning, refuse new mutations while **any** PREPARED row exists. Existing pending finalization/reconcile and reads remain available. New cooperating writers therefore admit at most one outstanding pending across the authority.
3. Prepare writes its proposed vault/legacy-registry rows in the IMMEDIATE transaction. Before its durable commit, create a SAVEPOINT and execute the exact shared finalization SQL with no COMMIT or relock. Check both the prepared image and the projected completed image against the new write limit, and check their worst-case combined database/journal cost. Roll back/release the preview, verify its original page count was restored, and only then commit PREPARED.
4. The same finalization SQL executes later. Other cooperating growth writes cannot change the B-tree layout or spend the reserved space while PREPARED exists. Finalize checks the hard database/journal proof before commit; it does not apply the new admission soft limit. A recovered historical set with multiple pending can be read and completed individually if each satisfies the hard proof; no new pending is admitted until all are completed.
5. Explicit mutation mode, not SQLite `total_changes`, controls commit checks: SAVEPOINT rollback does not undo `total_changes`. All source mutation routes (initial provisioning, prepare, finalize, admission, schema upgrade) use the same precommit budget calculation. Every lock reacquisition refreshes the starting page count and file checks.

## Recovery budget argument

Let P be page size, S the database page count at BEGIN, and F its proposed page count before COMMIT. Conservatively require:

`max(S, F) * P + S * (P + 8) + 131072 <= 67108864`.

The first term bounds the main file before, during and after the write. The second allows a rollback record for every original page, including pages touched only by the SAVEPOINT preview; new pages do not need original-page records. `cache_spill=OFF` prevents midtransaction spills and the extra journal segments they introduce. The 128 KiB allowance covers an initial maximum-size sector header and an additional alignment/header margin. No attached databases/super-journal are used. Temporary savepoint journals stay in memory. At the default soft limit even the pessimistic full original-image journal has substantial space under 64 MiB.

This argument relies on SQLite's documented rollback format and the bundled pager implementation's 64 KiB maximum sector size; this is a backend/runtime qualification, not a universal filesystem theorem. Verify supported page size, no-spill/delete/extra/temp pragmas and the runtime in tests. Raw SQLite writes, old binaries that ignore the fence, replaced files, or malicious administrators are outside the cooperating backend protocol. Operators must stop old writers during an update; read compatibility does not authorize mixed old/new writers.

Sources: [rollback journal format](https://www.sqlite.org/fileformat.html#the_rollback_journal), [cache-spill control](https://www.sqlite.org/pragma.html#pragma_cache_spill), [why cache spills add journal headers](https://www.sqlite.org/atomiccommit.html#_cache_spill_prior_to_commit), and the [fixed Node 24.16.0 bundled SQLite source](https://raw.githubusercontent.com/nodejs/node/v24.16.0/deps/sqlite/sqlite3.c). Root independently matched the local Node 24.16.0 runtime to SQLite 3.53.0, source id `2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b`, and that fixed source's `MAX_SECTOR_SIZE=0x10000`. Other runtime versions and platforms still need their own qualification.

The reservation is software capacity admission and isolation, not filesystem space preallocation. ENOSPC, I/O faults and physical power loss retain their existing fail-closed/reconciliation limitations. A callback that catches a failed prepare/finalize cannot commit its partial SQL: mutation failure poisons that transaction's subsequent mutations and outer commit. Read-only capability errors retain their existing handling.

## Acceptance

Focused red/green tests must exercise admission refusal before new PREPARED, unchanged authority/head/ledger at refusal, future completion preview, a real process exiting after PREPARED followed by reconcile, two new cooperating processes/handles, growth and recovery headroom, schema3 import/admit and upgrade fencing, old high-water ACTIVE read compatibility and preserved old pending without safe headroom. Immutable staging artifacts may remain after refusal; they must not be deleted or mislabeled as committed state. Keep failed attempts, run focused/affected suites and strict typecheck, obtain independent review, then freeze for Root's final whole/measurement. No production data, training, provider, commit/push/merge or rollout is authorized here.
