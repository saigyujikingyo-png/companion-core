# Codex native acceptance — 2026-10-25

This is a synthetic, local acceptance slice of installed `codex-cli 0.164.0-alpha.11.1`, using `gpt-6.1-sol`. The native program used the existing login; the probe never opened or copied credentials or read real conversations. The user explicitly authorized the native program to use its existing runtime after being informed that its indexes may update. Every test thread was new and ephemeral, with a fresh system-TEMP cwd and read-only tool sandbox. No production scope was used.

## What is accepted

- Native `initialize` / `initialized`, `thread/start`, and `turn/start`; the final reviewed completion-only run completed and returned exactly `42` for the synthetic arithmetic prompt.
- Its actual `item/completed` user message reached `mountCodexHost`, the trusted binding, deterministic synthetic extraction, transactional memory publication, and core recall. The memory extractor was a fixture, not a second real model.
- One separate native interruption received a matching `turn/completed` with `status: interrupted`. The RPC acknowledgement alone is never accepted as stopping.
- The final completion-only run accepts native duplicate replay and full-stream zero-tool/no-approval checks, with pinned source snapshots, 17 parsed notifications, clean close/exit 0, empty buffer and no forced termination. These stronger checks do not retrospectively qualify the old completed or interrupted records. Three inherited MCP servers were explicitly disabled by child-only overrides; their observed thread inventory reported `disabled` and zero tools. Empty `mcp_servers={}` does not clear inherited server configuration on this installation.

Exactly three real `turn/start` requests were issued across all attempts: the initial completed turn, a separate interrupt-only turn, and one final completion-only turn. The user explicitly granted the extra one-turn budget after the original two-turn allowance was exhausted and the audit repair was independently reviewed. The interrupted turn is not claimed as completed inference. Initial startup/isolation diagnostics issued no model requests.

## Evidence and retained failure

All paths below are under `C:\Users\saigy\AppData\Local\Temp`:

| Evidence | Status and scope |
|---|---|
| `companion-codex-native-AQT9vg/result.json` | **PASS_NATIVE_CODEX_COMPLETION_ONLY**. One request/one completed turn, exact 42, native source publication/recall, selected-event duplicate replay, full transport and zero-tool audit; source report SHA256 `fa1ec9bfb55529344b0d7588b3d9a7d263aefdd5ab3671fa218c9a5a766dd1e1`. |
| `companion-codex-verified-lhSQQr/result.json` | **PASS_COMPLETED_NATIVE_TURN_AND_PERSISTED_SYNTHETIC_MEMORY**. New read-only postflight verifies fixed implementation snapshots, complete transport and source/memory/recall on a SQLite backup. Original report/DB unchanged; zero additional model calls. SHA256 `9f2380e569dcc69aa5869596f14b84f11ff8821ff94b2ee37d66222170d2fd27`. |
| `companion-codex-native-nopDbZ/result.json` | Original overall **FAIL** retained. Native turn completed, exact final output passed, and the source/memory were published; the subsequent harness replay of the unprojected native envelope failed. The original exception category was not retained beyond `PROBE_ERROR`. |
| `companion-codex-verified-0UgdqN/result.json` and earlier `MFRdML` | Historical postflights retained unchanged. Their completed-turn and synthetic-memory publication/recall facts remain supported. Their full-stream zero-tool/no-approval conclusions are withdrawn: the short trace did not prove stdout completeness. See the new correction result below. |
| `companion-codex-verified-2hhMjP/result.json` | **PARTIAL_COMPLETED_NATIVE_TURN_AND_PERSISTED_SYNTHETIC_MEMORY** correction. Positive completed-turn/source/publication/core-recall checks pass against a new backup; `zeroToolStatus`, transport-audit and no-approval status are **NOT_ACCEPTED**. Retained trace has zero tool items. Original report/DB hashes remain unchanged; no new model call. |
| `companion-codex-native-GYeptI/result.json` | Historical status **PASS_NATIVE_CODEX_INTERRUPT_ONLY** retained. The matching `interrupted` terminal and process exit 0 without forced termination were observed. Full-stream zero-tool/no-approval claims are **NOT_ACCEPTED**; stdout close was not recorded. |
| `companion-codex-native-XGeGI7/result.json` | No-auth isolated-home initialize-only control PASS, exit 0, zero model calls. |
| `companion-codex-native-HmIUxV/result.json`, `companion-codex-native-BJJCoz/result.json` | Normal login with a new child SQLite home timed out during initialize (20 s / 60 s). No turns. These were not authentication or quota refusals. |

Additional pre-turn isolation/configuration failures remain in separate TEMP probe directories. They are not silently replaced by the later results. The first attempt to use the existing runtime was automatically rejected; the user then explicitly authorized it and the subsequent narrow escalation was accepted.

The runner now projects the selected event fields before its replay call, matching the host mount. Offline coverage verifies that extra native metadata is projected at the host boundary while the core wire schema still rejects unprojected extra fields. The final completion-only run verifies the native duplicate replay. Interruption remains a separate older observation; the two-turn combined mode was not rerun and its full-lifecycle audit is not claimed.

Read-only review found two related P2s: the original tool check used only a 512-entry trace, and the subsequent verifier could accept zero counters despite a failed/incomplete transport audit. The old runner set its fatal state on `exit`, dropped later stdout chunks, and waited for `exit` rather than `close`. Its 21/16-entry traces establish only that the trace cap was not reached. No complete old source snapshot or runtime close/data ordering record was retained; a source hash does not supply the missing drainage evidence.

The corrected runner independently counts the whole parsed stream and records `traceTruncated`. It waits for process close and then emits versioned transport audit fields. `transportAuditComplete` requires exit and close, exit code 0, no forced termination, exactly zero unparsed stdout bytes, no unexpected server request, and no fatal code except normal process exit. Postflight zero-tool qualification requires the pinned runner/audit-module hashes, matching saved source snapshots, this complete audit, consistent final status and valid full-stream counters. `FAIL_FINAL_TRANSPORT_AUDIT`, protocol errors, disposal failures, unknown versions/hashes and contradictory records cannot qualify. Missing audit evidence yields **PARTIAL** positive-fact verification with `zeroToolStatus: NOT_ACCEPTED`; the retained trace's tool count is reported separately.

Ten focused tests cover late tools after 600 notifications, bad/missing close/exit/buffer/fatal evidence, misleading zero counters, and completion-only request budgeting. Astra max independently rejected 15 transport counterexamples and checked the actual request-send boundary before the final real call. Root's complete `npm run check` passed typecheck, 76/76 tests and seven-step replay. Original failed and partial records remain unchanged. All three explicitly authorized real turns are now consumed; future calls need a new stated budget.

## Reproduce only with authorization for new native calls

```powershell
node scripts/codex-native-probe.ts --allow-real-model --completion-only --codex 'C:\Users\saigy\AppData\Local\OpenAI\Codex\bin\2993767bd1dfb009\codex.exe' --disable-mcp matlab-companion --disable-mcp node_repl --disable-mcp origin-agent
```

This command was run once after the additional explicit authorization. Repeating it is a new real call, not an offline test. `--completion-only` performs the completed turn, native ingress/store/recall and selected-event duplicate replay, then closes and audits the transport. It cannot send `turn/interrupt` or a second `turn/start`, enforced at the actual request-send boundary. The previously confirmed interrupted terminal need not be reissued.

The binary path and MCP names are host-specific; inspect installed schema/metadata for a different host. `--initialize-only` makes no thread or model request. Adding `--isolated-no-auth` to that diagnostic uses a fresh TEMP Codex home. `--interrupt-only` uses one new interruption test turn. Omitting all mode flags retains the two-turn combined mode. Conflicting modes fail before launching Codex. Ordinary `npm test` / `npm run check` never invoke this runner.

For offline evidence recovery, use `node scripts/verify-codex-completed-probe.ts <synthetic-TEMP-result.json>`. It accepts only a named synthetic probe under the process's system TEMP root and checks the expected synthetic identity/text before creating a new backup. On this Windows host, the app sandbox and normal user process have different TEMP roots; run the verifier under the same normal-user route as the original probe.

The runner saves lifecycle metadata, hashes, fixed error categories, explicit synthetic results, and snapshots of its allowlisted source files. It discards native stdout reasoning and stderr contents; it does not save raw protocol transcripts. Native Codex manages its own runtime. No user configuration or credential file is directly changed.

## Remaining boundary

`mountCodexHost` only handles a trusted selected thread's completed user text. It is not network authentication. Unmount still cancels the local memory pipeline; automatic coupling from local cancellation to native interruption is not implemented. `HostMemoryService.negotiate().hostCancellation` therefore remains `not_integrated`. Call the separate bounded `interruptCodexTurn` helper and require the terminal status when native interruption is desired.

The lifecycle helper binds terminal events by thread/turn, tolerates terminal-before-RPC ordering, rejects invalid/conflicting statuses, bounds acknowledgement plus terminal wait, and discards late failures. No database schema change, production data migration, native memory-extraction model, background service, or cross-platform acceptance is claimed.

Protocol semantics were checked against [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server), then the installed binary's generated schemas. The installed schema uses string `runtimeStatus` values, including `disabled`; current web examples can differ from this build.

The real DeepSeek acceptance separately exposed unwanted translation of Chinese selected evidence. `http-inference.ts` now asks for the source language, entities and key terms to be preserved. Root independently verified the same hash (`714a34160a796ed89d15bb35f56246819e790aee5e0dcbead367629b8e94c320`) with a new real API call; details belong to the coordinator's `research/2026-10-25-native-acceptance/01-REAL-API.md`. This prompt improves observed behavior but is not a guarantee of multilingual semantic correctness.
