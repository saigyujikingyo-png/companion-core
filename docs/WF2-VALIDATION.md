# WF2 validation record

The [closed failure diagnostics](WF2-FAILURE-DIAGNOSTICS.md) and [cross-model unit pilot](WF2-UNIT-PILOT.md) have completed source review and one real, separately admitted `.8` run. Authenticated metadata-only inspection identified the retained medium terminal code as `WF1_PAIR_BINDING`; no old payload was read or repaired.

## Current .8 result — stopped, no frozen dataset

The run completed four sealed units and four plan units, then stopped on the second candidate: `FIRST_FOUR_GATE / WF2_FIRST_EXACT_ORACLE / unitIndex=1`, response failure `NONE`. It consumed Together 11 and DeepSeek 1 calls, with one qualified candidate and one quarantined candidate. **No four-row manifest was frozen; delivered dataset rows remain zero.** The qualified candidate is retained evidence, not automatic training admission or completion of the older experiment.

All 12 calls had known usage: input 13,242, completion 12,390 (including reported reasoning); estimated usage 9,793 micro-USD and reservation 72,813 micro-USD at frozen declared prices. Actual invoice is unknown. The wrapper measured 125.842 seconds including startup, checks and shutdown. Per-call latency and account RPM/TPM limits were not measured; this run cannot establish production capacity.

Fresh cold inspection `/6` agreed with the live failure and counts, with authority `REVOKED`, `RECORDED_CLAIMS_ONLY`, and manifest `NOT_READ`. Duplicate execution was refused before any new worker, provider request or provider-key read. Both actual children closed (worker exit 0, DSH exit 1), without force or completion ACK. The original 26 source files, 31 carrier files and 22 archived runtime modules were preserved at run closure. Safe receipt SHA256: `3aa87b462fdaac6be0fe39e5b612174154287074f1b17da3197c5ca7a7f10dc3`.

One combined local suite passed 978/978 plus strict TypeScript; independent Astra review accepted the source, carrier and actual negative result. Cross-platform acceptance belongs to the new PR checks, not the older CI receipts below. Subsequent work must use a separate admission to harvest already-qualified material or dispatch new units; this consumed run is not resumed, repaired or regraded. Four symbolic cases are a pipeline canary, not the large first-training corpus or a general language/emotion evaluation.

## Retained .7 validation snapshot

**Engineering delivery is `PARTIAL`; qualified real teaching items are0.** The bounded-depth6 low-effort pilot stopped at `EXACT_ORACLE`; HIGH2 stopped with response code `INCOMPLETE_FINAL`; the final medium-effort comparison stopped after two Together calls with stop reason `UNKNOWN` and response code `NONE`. The medium record reports sealed=true and planned=false; its specific plan-stage rejection cause is unverified. No first qualified dataset or completed teaching workflow has been established. The earlier expired high preparation did not run and is separate from HIGH2.

This record separates source checks, local test evidence, Windows native scheduling, public probes, actual private campaigns and commit-specific CI. Failed attempts remain consumed and are not repaired, replayed or regraded.

## Current pilot boundary

The accepted Together-only first-four design uses one fixed GPT-OSS model, `json_schema` and a finite depth6 schema. The successive high- and medium-effort profiles changed only effort across five operations; schema, completion caps, source checks and exact oracle stayed unchanged. Neither effort selection nor source acceptance established better correctness or stable quality. The medium profile's independently accepted actual result is negative.

DeepSeek calls are zero. The maximum is 11 Together calls: three bootstrap, four candidate and four fresh-context review calls. Seal and plan completion caps are 8192; other caps are 4096. The declared reservation estimate is 62,367 micro-USD against a 100,000 micro-USD cap. These are admission ceilings and estimates, not observed usage or an invoice.

If every gate passes, the maximum result is **four unique items, three train and one dev, `PILOT_ONLY`**. The unused 12 families and eight comparison pairs remain `NOT_RUN`; this does not complete the earlier 16-family DeepSeek plus eight-Together design. Generation and review use the same model in fresh contexts, **not independent-model validation**. Local exact checks and model review are separate evidence and do not establish general language, reasoning, emotional or Unicode quality.

Teaching material remains private. This public record contains no raw outputs, corpus rows, manifest contents, sealed material, credentials, keys or private runtime locations. Student inference and training remain `NOT_RUN`; a formal pilot does not authorize public data release. See the [Together pilot](WF2-TOGETHER-PILOT.md) and [control service](WF2-TEACHER-SERVICE.md).

## Actual private campaigns

Each row records a separate admitted campaign or preparation. HIGH2 and medium actual negative results remain retained; expired unexecuted preparation is listed separately.

| Campaign | Recorded result | Limit of the observation |
|---|---|---|
| Format profile/1 | `NOT_PASSED`; native and strict JSON 6/6, exact echo 0/6 | Serialization probe only |
| Format profile/2 | `NOT_PASSED`; native and strict JSON 6/6, exact echo 5/6 | One Unicode value matched the expected NFC form with a one-code-unit length difference; no repair or third probe |
| Teacher 0.4 | `STOPPED`, DeepSeek1 / Together0, qualified0 | First seal response rejected as `WF1_JSON` |
| Teacher 0.5 initial | `STOPPED`, DeepSeek1 / Together0, qualified0 | Extra tool-call `index: 0` rejected as `WF1_FIELDS` before arguments parsing; arguments and oracle were not validated |
| Teacher 0.5 compatibility/2 | `STOPPED`, qualified0 | Extraction succeeded, then local seal validation rejected `CASES_CARDINALITY`; arguments were not repaired or re-evaluated |
| Beta fixed-slot 0.6 | `STOPPED`, DeepSeek1 / Together0, qualified0 | Bounded diagnosis: native JSON invalid, strict `WF1_JSON`, invalid root; slot projection and oracle were not reached |
| Stable named 0.6 | `STOPPED`, DeepSeek1 / Together0, qualified0 | `ARGUMENTS_NATIVE_JSON_INVALID`; no seal, plan, candidate or manifest accepted |
| First Together-only 0.7 | HTTP400, Together1 / DeepSeek0, qualified0 | Usage unknown; follow-up diagnostics established no cause beyond a generic invalid-request error |
| Bounded-depth6 low-effort pilot | `EXACT_ORACLE`, Together1 / DeepSeek0, qualified0 | Response-failure code `NONE`; sealed, planned and manifest counts all0 |
| Earlier expired high preparation | **`NOT_RUN`** | No worker, provider-key read, API dispatch or consumption; not a model failure |
| HIGH2 actual | `STOPPED`, Together1 / DeepSeek0, qualified0 | Response code `INCOMPLETE_FINAL`; overall stop reason remains `UNKNOWN`; no manifest recorded |
| Medium-effort comparison | `STOPPED`, Together2 / DeepSeek0, qualified0 | Stop reason `UNKNOWN`, response code `NONE`; recorded sealed=true, planned=false; specific rejection cause unverified |

The Unicode value relationship does not establish provider-internal normalization. None of these negative campaigns establishes a completed teaching workflow. All old private diagnostics are closed. Transport variants and their origins remain separately bound; there is no automatic fallback. See [format probes](WF2-FORMAT.md), [strict transport history](WF2-STRICT-DATA.md), [fixed slots](WF2-FIXED-SLOTS.md) and [stable named data](WF2-NAMED-DATA.md).

Known safe usage summaries are below; omitted usage is not inferred. Invoices remain `UNKNOWN`. Cost estimates and retained reservations are different facts.

| Campaign | Input / completion tokens | Usage | Estimated cost, micro-USD | Retained reservation, micro-USD |
|---|---|---|---|---|
| Teacher 0.4 | 1492 / 1277 | Known | 1980 | Not stated here |
| Teacher 0.5 initial | 1676 / 1610 | Known1 / unknown0 | 2435 | Not stated here |
| Beta fixed-slot 0.6 | 2076 / 2372 | Known | 3470 | 10445 |
| Stable named 0.6 | 2072 / 1770 | Known1 / unknown0 | 2746 | 10445 |
| First Together-only 0.7 | Unknown / unknown | Unknown | Unknown | 7680 |
| Bounded-depth6 low-effort pilot | 1878 / 1887, including97 reasoning | Known / unknown0 | 1414 | 7680 |
| HIGH2 actual | 1878 / 8192, including8190 reasoning | Known1 / unknown0 | 5197 | 7680 |
| Medium-effort comparison | 4088 / 8166, including4237 reasoning | Known2 / unknown0 | 5514 | 15360 |

The beta and stable named 0.6 negatives each observed teacher exit0 and DSH exit1, with both children closed and no forced cleanup. The historical first0.7 negative also observed both closes at0/1 without force. A fresh cold inspection (version3) reported recorded revoked claims and manifest `NOT_READ`; duplicate checks observed no new provider-key read, worker or API dispatch.

The bounded-depth6 low-effort negative was independently accepted. Its single actual call ended with both children closed at0/1, no forced cleanup and no completion acknowledgement. Fresh version3 inspection returned recorded revoked claims and manifest `NOT_READ`; the duplicate check observed no new worker, API dispatch or provider-key read. Source, carrier and archive identities were preserved. These observed process outcomes do not convert a failed campaign into acceptance.

HIGH2 was also independently accepted as a negative result. Both children closed with teacher exit0 and DSH exit1, no forced cleanup and no completion acknowledgement. Cold evidence is recorded revoked claims; manifest verification is `NOT_READ`. Qualified and quarantined candidate counts are0. A duplicate attempt was refused before launch, with no new worker, provider request or provider-key read. All42 source files,28 carrier files and20 archived modules stayed exact. The8192 completion tokens include8190 reasoning tokens; these counts and `INCOMPLETE_FINAL` do not establish a more specific model-internal cause. Student inference/training remain unexecuted.

The medium negative result was independently accepted. Both children closed at teacher0/DSH1 without forced cleanup. Fresh cold inspection (version3) returned `RECORDED_CLAIMS_ONLY` with revoked authority and manifest `NOT_READ`; no manifest was recorded. The duplicate check observed no new worker, provider request or provider-key read. Its42 source files,28 carrier files and20 archived modules stayed exact through the actual run. No private sealed content was reopened, and the unknown plan-stage cause is not inferred to be schema, collision or another specific defect.

## Public engineering probes and mathematical diagnosis

These probes use public engineering material, not training data. They do not qualify private teaching items or change an earlier campaign result.

| Probe | Recorded outcome | Separate observation |
|---|---|---|
| Original A batch | `NOT_PASSED`; HTTP200 and model identity passed; client rejected the envelope before finish, native/strict JSON and exact checks | Known99 input /28 completion, including12 reasoning; estimated32 micro-USD, reservation7680; original batchB was not sent |
| A local diagnosis | Zero-API diagnosis found `choice.seed: null` triggered `WF1_NUMBER` | Observed finish `STOP`; 15-byte public content passed native JSON, strict JSON and exact comparison. Original batch fields remain `NOT_CHECKED` and are not regraded. |
| Separate B-only | One Together call, HTTP400 with circular-reference error | Usage unknown, reservation7680, qualified0; no resumption of the old batch |
| Separate C-only | `PUBLIC_CHECKS_PASS` for HTTP, model identity, usage, finish, native/strict JSON, slots, local contract and formal validity | Finite depth6 DAG;1815 input /2355 completion including465 reasoning; estimated1686 micro-USD;52.45 seconds; target correctness originally `NOT_CHECKED`, qualified0 |
| C mathematical diagnosis | Separate12/12 exact canonical checks, with an independent BigInt computation agreeing | No private sealed material read and no training data generated; the original C receipt remains unchanged |

All probe invoices remain `UNKNOWN`. Public compatibility and mathematical diagnostics are distinct from a private dataset's source, oracle and review gates.

## Next development order

The next batch should first define fixed, content-free stage and rejection-reason diagnostics, then study smaller generation units and explicit task decomposition. Evaluation questions may separately research deterministic oracle labels, with label provenance and a new protocol stated explicitly. These are future work, not implemented in this batch, and do not repair or regrade retained failures.

## Source and local verification

The experiment's accepted source freeze contained42 files, with teacher20, legacy17 and format16 dependency closures;200 protected tracked files remained unchanged through actual execution. The publication adds approved document and project-guidance edits, so that historical42/200 preservation claim is not a claim that every final committed byte still equals the experiment freeze. Runtime closure bytes remain unchanged; the final commit SHA identifies its CI. Independent reviews accepted the source/carriers and actual negative results. Review of author TypeScript evidence and actual dependency closures is not described as an independent TypeScript run.

The first0.7 author coverage comprised21 unique focused tests, strict TypeScript and diff checks. Initial six passes and one null-prototype assertion failure are retained; only that assertion was corrected, followed by its targeted rerun and previously unreached regressions. Its11-call mock and cold check produced four unique rows, three train and one dev. These are synthetic results, not real qualified data. Later groups remain separate: nullable maintenance three targeted checks plus TypeScript; bounded-depth6 eight targeted checks plus TypeScript and its single new-profile11-call mock/cold check; high-effort seven targeted checks plus TypeScript; medium six focused checks plus TypeScript and diff checks, reusing unchanged prior chain and closure-topology evidence. They are not summed into a whole-suite claim.

The sole earlier Windows whole run passed strict TypeScript and **721 of722 tests, with one failure**. Its rollback fixture copied the ledger without the closed owner, causing an earlier read-only guard rejection. A two-line fixture correction restored the genuinely closed owner and preserved the exact `HEAD_MISMATCH` assertion. Targeted author/independent checks passed2/2, and nine previously unreached tail commands subsequently passed. This is composite closure, **not one local722/722 all-green whole**. Earlier source groups and synthetic chains do not substitute for final CI or actual data acceptance.

## Windows native DSH scheduling

The third independent Windows Desktop rc3 synthetic scheduler attempt passed: two operations, completion acknowledgement, both real child exits0, no forced cleanup and zero model/provider API calls. The first attempt did not dispatch; the second timed out during closure. Both remain failures, and no successful portion was repeated for release preparation.

This covers the recorded synthetic control/lifecycle path for that Windows carrier. It does not establish provider data quality, complete teaching acceptance, rc2 portability or broader process-tree isolation. Logical completion, acknowledgement and child close remain separate facts.

## Commit-specific cross-platform CI

For any published revision, use its exact head SHA and original attempts in [GitHub Actions](https://github.com/saigyujikingyo-png/companion-core/actions). This document does not forecast workflow outcomes; earlier commits' results cannot validate later source.

The first validation commit `2e267a5` passed all four Core jobs but failed all three native rc2 jobs before worker or scheduler startup. The smoke supplied `DSH_OFFICE_SIDECAR` as an empty string; the pinned runtime rejected it with `DSH_OFFICE_SIDECAR must be an absolute directory`. A separate same-executable/environment control omitted only that variable and returned exit0 with `0.2.1-rc.2` on stdout. The correction omits this override, preserves the supported empty `DSH_PRIMARY_RUNTIME`, and keeps the package/hash pin, exact reported-version check and all native completion/close gates. Version refusal now records bounded diagnostics. The initial failures remain retained. One corrected-script Windows x64 rc2 native run then passed: exact version `0.2.1-rc.2`, two dispatches, completion acknowledgement, both real child closes with exit0, no forced cleanup, and zero model/provider API calls. Its source remained unchanged; `NOT_OS_ENFORCED` remains the network-verification limit. Cross-platform acceptance belongs to the new commit's Actions results.

The release sequence uses a new validation branch first. Its automatic Core workflow must pass four jobs: Windows, Ubuntu and macOS on Node24.16.0, plus Ubuntu on Node24.x. The separate native-scheduler workflow must pass Windows X64, Ubuntu X64 and macOS15 ARM64 with the pinned official rc2 runtime and synthetic service. All seven jobs, relevant steps and native receipts must succeed at the same reviewed SHA.

Only then, after confirming unchanged main, may that identical SHA be normally fast-forwarded to main. Main's own two automatic workflows and seven jobs must be observed separately. Failed, skipped, cancelled, missing or different-SHA results stop promotion and remain retained. No manual dispatch/retry, force push, reset or rebase is part of the plan. Source checks, Windowsrc3 smoke, public probes and actual teaching attempts do not replace commit-specific CI.
