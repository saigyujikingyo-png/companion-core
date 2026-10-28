# IF9 runtime capability contract — 2026-10-28

Physical Store repack remains restricted to the exact SQLite source and runtime settings in the frozen [IF9 plan](CAPACITY-REPACK-PLAN.md). This correction changes tests and their CI expectations, not production admission. `src/memory-image.ts` and the original plan remain byte-identical to commit `37afc0a808cb9ed9824f58b001f655f49431c133`. Existing [IF9 evidence](AEMC-INFRA-EVIDENCE-IF9.md) remains a historical record of its original source and runtime.

## Support matrix

| Runtime lane | Test expectation | Physical repack evidence |
|---|---|---|
| Windows, Ubuntu and macOS fixed Node 24.16.0 | `required-supported` | Audited metadata must match; execute all positive schema1/2, shrink, logical identity, no-benefit, target boot, fencing, three real child crash/reconcile and authority competition cases. A metadata regression fails and cannot select refusal tests. |
| Ubuntu floating Node 24.x | `metadata-policy` | Independently inspect SQLite version/source and compile options. Exact audited metadata executes positive cases. Any other well-formed metadata executes explicit real rejection cases. Probe errors fail instead of selecting rejection. |
| Node 24.21.0 / SQLite 3.53.4 observed in original CI | Unsupported for physical repack | Real RAM images, public API and a child process must throw exact `CoreError/REPACK_RUNTIME` before VACUUM or any fault hook. Positive shrink/crash/fencing/competition scenarios are `NOT_EXECUTED_UNSUPPORTED`, not successful repacks. |

The independent test metadata policy admits only SQLite 3.53.0 with source ID `2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b`, FTS5, explicit TEMP_STORE=1/2/3 and no TEMP_STORE=0. It never catches a production-gate failure to infer capability. Production separately verifies the actual connection, including temp_store=MEMORY, main journal_mode=MEMORY, cache_spill=OFF, no transaction and only an unnamed main database. No Node version range grants repack admission.

The default local expectation is `metadata-policy`, matching the floating CI lane. To verify an audited baseline, explicitly set `IF9_REPACK_EXPECTATION=required-supported` and run `node --test --test-concurrency=1 test/capacity-repack.test.ts`. Unknown expectation strings fail. All four original CI matrix entries, commands, action pins and timeouts remain; only the explicit per-lane test expectation is added.

Every unsupported public-source test retains and exactly compares the complete decoded image and state, encrypted source files, all three business tables of its authority schema v2 (`metadata`, `vaults`, `receipts`) and authority files. It verifies ACTIVE/head/pending/receipt and absent target, with zero observed VACUUM SQL calls and zero fault hooks. Only after these assertions, ordinary compact succeeds with the same operation ID, proving the rejected repack did not consume it. These assertions concern the synthetic fixture and the instrumented API path; they are not OS-level disk-write tracing.

Mock source/configuration/transaction refusals, typed fingerprints, another vault's pending guard, Safety packing/corruption/bounds, both profile upgrades, all three upgrade child crash/reconcile points, backup/rekey/normal compaction and legacy import run in both lanes. Mixed tests were split so a repack refusal cannot prevent those independent assertions. TAP names and the capability diagnostic distinguish supported positive execution from unsupported rejection; there are no skip/todo tests. Counts from the two runtime suites are separate and must not be added as unique coverage.

## Original CI failure and causal mapping

At the original head `37afc0a`, the natural push and pull-request runs each reported 1,018/1,028 passing tests and ten failures on floating Ubuntu 24.x, then Node 24.21.0 / SQLite 3.53.4. Overall jobs were 12 successful and 2 failed. The original failures remain failed evidence; this correction does not reclassify or rerun those jobs.

| Original failing test | Cause and corrected evidence boundary |
|---|---|
| schema1 repack shrink | The strict source gate refused before VACUUM; positive shrink belongs to the audited lane, legal schema1 refusal to the unsupported lane. |
| schema2 repack shrink | Same cause; schema2 public image/state refusal is checked independently. |
| Combined runtime gate | The initial real configure call threw before mock cases; native capability and unconditional mock refusals are now separate. |
| No-benefit/schema/transform | Expected later errors or success were unreachable behind REPACK_RUNTIME; the audited lane retains the full original checks. |
| Fingerprint plus mismatch | Pure fingerprint assertions ran, but the injected post-VACUUM mismatch expected a later error; fingerprints now run independently on both lanes. |
| Public repack/boot/fencing | Production refused before target creation; unsupported public tests prove no mutation instead of claiming new-generation success. |
| Child repack at prepared | The child exited from gate rejection before its requested exit 42; audited lane retains actual exit 42, unsupported lane verifies a real child refusal. |
| Child repack at record-published | Same cause; no crash-point success is claimed on unsupported runtime. |
| Child repack at finalized | Same cause; no finalization or reconciliation success is claimed on unsupported runtime. |
| Competition plus other-vault pending | Repack refused before competition and later pending assertions; positive competition remains audited-only, other-vault pending is unconditional. |

Original runs: [push core-contracts](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40613873642), [pull-request core-contracts](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40613911308). Their immutable failed logs and local source snapshots are retained in the native evidence directory recorded in the ignored handoff.

## Why SQLite 3.53.4 is not admitted here

Root's independent source review confirmed the newer runtime identity but did not close the pager/btree/sorter/memdb/deserialize change audit or its behavioral evidence. Identity and a successful metadata probe do not establish the plaintext temporary-storage guarantee. SQLite states that temporary-file behavior can change across versions, and compile-time TEMP_STORE affects the meaning of the runtime pragma. See the primary [temporary-file documentation](https://sqlite.org/tempfiles.html) and [temp_store pragma](https://sqlite.org/pragma.html#pragma_temp_store). A later version requires its own reviewed admission decision; this test correction grants none.

## Author verification of this correction

Fresh native Windows runs on 2026-10-28 used canonical native TEMP, one worker and synthetic data. Each admission exceeded the unchanged 1 GiB free RAM and disk minimums; baseline RAM was 6,015,602,688 bytes and floating-runtime RAM was 5,994,254,336 bytes. The installed baseline and checksum-verified official portable Node executables were invoked explicitly without installation or PATH changes.

| Check | Actual result | Scope |
|---|---|---|
| Node 24.16.0, `required-supported` | 28/28; fail/cancel/skip/todo 0; Node 6.491 s | Full positive repack and all independent non-repack checks |
| Node 24.21.0, `metadata-policy` | 22/22; fail/cancel/skip/todo 0; Node 6.088 s | Actual unsupported refusal and all independent non-repack checks; positive repack scenarios not executed |
| Strict TypeScript | Exit 0 | Entire configured TypeScript project |

All 221 tracked execution files were copied in full before each command and hashed before/after, with zero drift across the runs. The production gate and frozen plan match their original commit bytes. Raw TAP logs, source snapshots and runner results remain in native TEMP; the ignored handoff records their exact paths. Baseline log SHA256 is `78d5ce122700e84cad72de2bd497f64bb5e8a6766a6fb43ad602fb728816d468`; floating log SHA256 is `abc44421c1ace68dac140261b13528de8bc88667d19c445e1245815ed08d3203`. No whole suite was repeated for this correction. Independent review and the next natural CI are separate acceptance steps, not claimed by these local runs.

This patch does not change source/authority capacity, deletion, receipts, UNKNOWN states, training admission or deployment. New source acceptance and natural CI results must be recorded separately from the historical 1,028-test baseline.
