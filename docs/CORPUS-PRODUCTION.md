# CorpusProduction/0.1

2026-10-28. New bounded text production protocol, independent of the consumed six-unit pilot. One actual 128-candidate calibration has settled, passed fresh cold verification and received independent safe-metadata consistency acceptance. Its yield is 127 eligible model-reviewed rows and one local rejection. Student training has not run. CI qualification is revision-specific and reported by the pull request checks. There is no four-hour deadline and no promise of 2,000–5,000 accepted rows. The 256 GB corpus allocation is a ceiling, not a fill target.

The normative shared identity and current goal index are [FACTORY-BASELINE](FACTORY-BASELINE.md). Capability target remains `CompanionTrainingTarget/2026-10-27.2`; source/scientific/tool truth and rights remain independent regression gates under [TARGET-DECISIONS D2/D3](TARGET-DECISIONS.md). This implementation supplies corpus production infrastructure, not acceptance of personality, emotion, long-term memory or training quality.

## Frozen jobs and host ABI

`corpus-production-types.ts` defines the closed spec/registry/purpose contracts. A job binds exact build, profile, Student, baseline, objective, registry, purpose and storage digests plus runtime/authority revision. Every profile change requires a new job; no widening or replacement IDs within a consumed batch.

- Plan groups contain at most 16 frozen slots. Generation groups contain exactly four same-pool, same-family, same-split slots. Reviews contain one to four items, fitted to actual encoded bytes. Missing/malformed plan items quarantine their incomplete frozen generation group; other full groups continue.
- Fixed plan/generation/review/global concurrency is 1/4/4/8, with at most 32 queued review items. The new API codec alone permits 64 KiB requests and 256 KiB responses. Old WF1 and pilot bounds remain unchanged.
- DeepSeek official API `deepseek-flash`, high thinking, 16,384 completion reserve and 66,048 input reserve per request. At 128 candidates the worst bound is 168 calls; exact frozen peak prices must fit the 10,000,000 microUSD job ceiling. Reservation is not an invoice. No SDK retry, redirect, repair, replacement or consumed-call replay.
- `openProductionJob({approvedTrainingRoot,runtimeRoot,authorityPath,spec,key,mode,admission,now?})` supports create/resume/inspect. Key and credentials are in trusted host memory, never command JSON. Private files are `corpus-production.sqlite`, `corpus-production-owner.sqlite` and encrypted bounded `objects/` buckets.
- `runCorpusProductionCommand({version:'CorpusProductionCommand/0.1',command,spec},ports)` accepts describe/run/inspect/verify/measure-tokens/verify-tokens/export. Describe requires null spec; other commands require full canonical equality with the store spec. Ports are store, objective, registry, transport, optional signal and optional tokenizer `{profile,pythonPath}`.
- The lifecycle is create → run → measure-tokens → export → fresh inspect/verify/verify-tokens. Zero eligible rows have a valid empty report. Export is frozen after complete measurement; later receipt replacement/append is refused. A host may create another pre-frozen job after inspecting current gates; ordinary data batches do not require whole-repository CI. Source/profile changes require review and validation.

## Roles, sources and purposes

[Workflow v2](MENTOR-TEACHER-STUDENT-WORKFLOW.md) remains authoritative. ResearchMentor sees architecture and operational metadata, not samples or item-level scoring/remediation. Admitted TeachingCoordinator derives concrete tasks/rubrics from host-selected approved objective material and the exact current human baseline. Engineering summaries are not described as verbatim human text. All three stages carry and validate the same baseline content/digest; science answers need no irrelevant self-introduction.

Purpose manifests bind provider, model, service, account type/reference, purpose, terms evidence/version/digest and parent grants. Only ALLOW passes training-related dispatch and private training export. UNKNOWN/DENY or a restricted ancestor blocks that purpose; paraphrase, human rewrite, relabeling or keeping text outside loss cannot erase lineage. The source gate must also currently permit reading/retention. Terms applicability and actual account identity are supplied by the trusted host, not authenticated by the JSON validator.

Initial native support is DeepSeek-only. [Official DeepSeek terms §4.2](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html) are the recorded admission source; current source/account/purpose checks still apply. Together-hosted GPT-OSS training use remains UNKNOWN; Qwen and separate MiniMax M3/M2-her routes remain future qualification targets. Weight licenses and hosted service contracts are distinct. Provider identity is provenance, not quality.

The registry fixes scenario/source-family roots, rights and train/dev split. Shared project objectives bind objectiveDigest, not a fictitious shared scenario family or invented unique roots. Known blocked roots/families never enter a provider payload. Original host metadata stays in private lineage; provider inputs contain only task IDs/content and required baseline. Public redistribution is not performed by the private export API and requires separate permission.

## Persistence, failure and quality

Encrypted delta events and indexed SQLite attempt/item/shard projections commit before an external authority-head CAS. Consume commits before the single native send grant. A committed but unsettled attempt is UNKNOWN on cold resume and cannot resend. Settled unknown/usage/identity/budget/rate-limit failures are reclassified before any resumed dispatch, including a crash between SETTLE and FINISH. SUBMIT_UNKNOWN means no trusted result, not proof the provider received a request.

Known 429 is still consumed. Missing usage keeps full reservation. Safe numeric or HTTP-date Retry-After is preserved; all operations on the initial DeepSeek account share cooldown. Missing delay uses a bounded local default. Invalid or more than 30 seconds stops new dispatch rather than shortening server delay. Inflight work may settle accounting after a fence, but cannot activate late accepted rows. Pause/revoke/source loss never manufactures write authority.

JSON/item/length/model rejection and duplicates isolate items; authority, source, integrity, unknown submission or unbounded usage globally stop new work. Already accepted rows remain recorded. SQLite/external-anchor mismatch fails closed, including earlier prefixes: no automatic head advancement, truncation or crash-tail reconciliation.

Exact normalized text/prompt fingerprints and 64-bit lexical SimHash plus character-gram Jaccard are persistent within this bounded job (maximum 192 items). Structurally valid rejected candidates remain graph nodes. Cross-split linked families are held, including A~B~C bridges; resume repairs candidate/link/hold windows before any new send. The method does not claim complete semantic deduplication. Collection-wide cross-job deduplication is explicitly later work.

Each immutable shard belongs to one pool and one split, with at most 64 rows and 196,608 JSONL bytes. Lines are constructed once per export pass and grouped by byte/row counts. Held families are omitted from eligible exports without rewriting their original accepted evidence. Separate pool/split counts support later evaluation and a separately frozen training mixture.

Coordinator/generator/reviewer use separate requests of the same initial model. Accepted evidence is `MODEL_REVIEWED`, correlated, not exact truth, manual acceptance or independent factual quality. `trainingReady=false`, `trainingJobPolicy=NOT_AUTHORIZED`, packing OFF.

## Tokenizer and observability

The Student remains the official [NVFP4 mixed release](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4/tree/da5b2650a835292c678994a1fa3fb653250fb508), with unchanged StudentTarget digest. Official tokenizer/template SHA pins are checked independently of weights. Mamba-2 convolution/SSM boundaries, attention/MoE/visual behavior and trainer parity remain future gates; this text-only corpus does not establish native four-bit training support.

The local worker loads tokenizer/template once for at most 32 pairs of prompt ≤2,048 UTF-8 bytes and response ≤8,192 bytes. Its separate 2 MiB stdin bound covers worst legal JSON escaping; native API limits are unchanged. Node validates the worker's independent fixed SHA and executes the same cached source bytes with Python `-I -B -c`. Exact text remains anonymous stdin. Per-row IDs/masks/counts and original row/profile bindings are recomputed during cold verification; measurement does not upgrade evidence class.

Metadata reports per-lane queue/service duration, provider token usage or UNKNOWN, full reservation, job wall time, sampled parent RSS/CPU, pool/split counts and measured input/loss/full tokens. The measured generationReviewTrainLossTokensPerMinute uses only the persisted generation/review wall window; the Core's full-pipeline uniqueAcceptedTrainLossTokensPerMinute remains null with HOST_REQUIRED, and the host records complete-run timing separately. Dev tokens are reported separately and excluded from train throughput. Parent RSS is not process-tree, Python-child or native-service memory. The actual calibration below measures operational throughput; production quality and semantic duplicate recall still need independent sampling. Synthetic throughput is not an SLA.

Tests cover normal queue/cold paths, malformed items/partial plans, global fences, purpose/source/pause/revoke, once/no-send unknown, SETTLE/FINISH and candidate/LINKS/HOLD crash windows, rejected near-duplicate bridges, mixed-ID SQLite ordering, official batch/single parity and split export. The dedicated three-OS tokenizer workflow explicitly runs the new production tokenizer tests using pinned public assets; local success does not substitute for new-head CI.

Historical CP0Q actual five-row evidence belongs to `bd6afb9` and runtime `1226c1eb…`. This slice never reads, rewrites, repairs or replays those consumed originals. Later hardening and the present producer have independent synthetic/CI/actual records.

## Local validation at source freeze

Author targeted production suite: 33/33 PASS, zero skipped, 29,793.721 ms, including the pinned official Python tokenizer. Strict TypeScript and git diff --check passed. One final local whole-repository regression passed 1,066/1,066 with zero failures or skips in 166,200.6854 ms. The exact-source 128-item synthetic host fixture, including the true repeated Run guard, tokenizer/export/cold checks and revocation, passed independently of actual production. Source/host review accepted Core build `e395390530816334ae6488094444e4ba3910c79b737de23b6f6b7c515ea2807d` and host snapshot `de11ea3b7e598778dfb206493b3c0fd555a7f86af8df9c015ee7d9d2770f5977`. Documentation and CI-trigger overlays reuse these unchanged-runtime results; they do not repeat the whole suite. Exact-head three-OS tokenizer/native-smoke and four-job Core CI are separate qualification evidence, reported by the pull request checks.

## Actual 128-candidate calibration

The fixed DeepSeek-only calibration used separate coordinator/generator/reviewer requests of the same `deepseek-flash` high-thinking model. All 72 native calls settled: 8 plan, 32 generation and 32 review; retries, unknown submissions, unknown usage and known 429 responses were all zero. The frozen experimental range was 128 candidates, at most 168 calls and a 10 USD reservation ceiling. This historical range is not a project-wide authorization limit; the [maintenance rules](MAINTENANCE.md) record the newer project authorization, while this version's existing code boundaries remain unchanged.

| Result | Measured value |
| --- | --- |
| Generated / eligible / locally rejected | 128 / 127 `MODEL_REVIEWED` / 1 `CPR_MODEL_REJECTED` |
| Eligible train / dev rows | 111 / 16 |
| Immutable exports | 8 pool/split shards, 205,012 JSONL bytes |
| Official pinned local tokenizer | 9,427 input + 36,844 loss = 46,271 full tokens |
| Train / dev loss tokens | 32,353 / 4,491 |
| Initialize through run, token measurement, export and revoke | 277,233.3487 ms; 7,001.9715 train loss tokens/min |
| Initialize through fresh cold verification | 292,241.9157 ms; 6,642.3736 train loss tokens/min |
| Provider-reported usage | 121,657 input / 208,556 completion tokens; invoice UNKNOWN |

Host throughput starts before the native Initialize wrapper and excludes dev loss tokens. It includes the stated delivery or cold-verification phases, rather than substituting the narrower generation/review window. The Core token summary retains its separate HOST_REQUIRED/null full-pipeline field; the host timing above does not overwrite it. Resource evidence consists of Node samples only, with no process-tree or Python peak measurement.

Fresh-process cold measurement matched the committed receipts. Authority finished REVOKED at revision 2. A direct repeat of the true Run entrypoint refused as already consumed before worker startup, credential reads, custody reads or provider calls; all four safe counters were zero and the once record was unchanged. This is fixed-source guard and closed-metadata evidence, not an OS syscall audit. The rejected item and historical failures remain preserved; old private samples were not read or replayed.

The accepted evidence class remains correlated same-model `MODEL_REVIEWED`, not independent factual truth or manual quality acceptance. `trainingReady=false`, `trainingJobPolicy=NOT_AUTHORIZED`, Student training NOT_RUN, packing OFF, actual trainer parity NOT_RUN and official pipeline parity NOT_VALIDATED. Official NVFP4 mixed precision does not establish all-four-bit or generic NF4 training support. Raw samples, private logs, credentials and runtime artifacts are not published; data redistribution is a separate decision.

The retained safe post-actual summary has SHA256 `7fea5b2cc2af2adcbe09f6ee85ab77afa3360fd8dcd75b849bbace4a5b674213`; its controller summary has SHA256 `81aa082101d32d2822a30af25109647f478be608f2ba17346dea64918b1d09fb`. Independent review accepted safe-metadata consistency, including phase receipts, allowed promotion fields, counts, token/timing/usage arithmetic and revoked/duplicate evidence. CI qualification is revision-specific and reported by the pull request checks; local and actual receipts alone do not establish cross-platform qualification.
