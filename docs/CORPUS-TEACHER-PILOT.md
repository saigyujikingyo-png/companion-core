# CorpusTeacherPilot/0.1

Slice `cp0q-20261028`, based on `e03e28b`. This contributes to G4 (useful, evidence-calibrated conversation), G5 (qualified incremental learning material), and G6 (shared provider/Student contracts). It implements one bounded six-unit teacher pilot. Synthetic tests establish the controller contract; real provider yield, linguistic quality, Student training, and product acceptance require their own receipts. Existing `.8` and CP0 harvest formats and historical failures remain unchanged.

## Frozen scope

- Together `openai/gpt-oss-120b`, medium: one independent coordinator plus six candidates, at most seven consumed calls. DeepSeek `deepseek-flash`, thinking enabled/high: at most six independent reviews. No repair, retries, replacement units, Student calls, or old-body harvesting.
- Each call reserves 18,432 input tokens; Together reserves 4,096 completion and DeepSeek 8,192. The launcher freezes current prices; all thirteen worst-case reservations must fit 200,000 microUSD before the first call. Reservations are conservative engineering bounds, not exact input token counts; missing or excessive provider usage globally fences new dispatch. Actual invoices remain UNKNOWN.
- TC settles first. Units 0–1 use T1/DS1/global2. Only after both settle do units 2–5 use T2/DS2/global3. Candidate and review queues are separate; reviews get the first opportunity to drain. There is no adaptive expansion.
- Requests are at most 16,384 bytes, responses 262,144 bytes, and the narrow natural-language candidate contract 12,288 bytes (within the parent 65,536-byte limit). Prompt/response limits are 2,048/8,192 bytes. Calls are bounded to 120 seconds and the run to 30 minutes by a monotonic clock.
- The host freezes source, family, roots, rights digest and train/dev split. TC authors only six task/rubric pairs against the host-approved synthesis of the current human goal and echoes ordinal/unitId. New candidate/review requests project each unit to ordinal, unitId, task and rubric; source, roots, family, split and rights stay in local provenance. TC/reviewer receive no sealed examples, answers, blocked-root list or old artifacts.

## Durability and failure behavior

The controller reuses the existing encrypted artifact broker, bounded JSON parser, training-root binding, independent `HostAuthority`, conservative budget calculation, and native transport. A new narrow SQLite index records immutable encrypted state references and a hash chain; the existing external authority anchors its head. One owner holds the SQLite lock. There is no generic job system or offline worker lease framework in this slice.

Every external request has a stable operation/ordinal ID, frozen request body hash/profile and a durable consumed event **before** the send boundary. Unit transitions use expected-state comparisons. A process crash after consume leaves an unknown consumption, even if no successful response was recorded. A cold open is inspect-only and cannot dispatch, retry, resume a plan, or upgrade a read authority. With a valid complete chain and matching external head, an incomplete cold state is reported `CPQ_RESTART_READ_ONLY` with unknown consumption; it is not silently marked complete. A new run requires an empty independent root and a fresh external head.

Strict JSON, length, exact content duplicate and reviewer rejection are unit failures. They quarantine that unit and let other frozen units proceed. Authority, source, storage integrity, unknown submission and unbounded usage stop new dispatch globally. Already in-flight results may settle while authority still permits accounting; late results cannot become accepted after a fence. A revoked authority is never bypassed just to write a convenient terminal record. The returned safe summary then identifies the last state available to the controller; an on-disk consumed attempt without a trusted result remains unknown. `SUBMIT_UNKNOWN` is conservative accounting, not evidence that a provider received a request. A transport throw before its send grant still consumes once, fences, retains its reservation and cannot be retried or replaced.

Every accepted row commits a new immutable manifest and cumulative encrypted JSONL. Earlier versions are readable only while current source/retention authority permits and the complete ledger chain matches its external head. Cold verification checks every state object, external head, registry/objective hashes, request binding, candidate/review artifacts, source slot, row provenance, manifest lineage, shard content and counts. A SQLite commit followed by an external-head failure produces `CPQ_COMMIT_UNKNOWN`; cold inspection rejects the unanchored tail with `CPQ_HEAD`, including access through this API to previously accepted rows. There is no crash-tail reconciliation, automatic head advance, ledger truncation or automatic acceptance of an anchored prefix: an anchor rollback must not be mistaken for an innocent crash. Files and orphaned artifacts remain preserved. This cooperative same-user authority design does not claim protection against a malicious host or power-loss/network-volume durability beyond the inherited storage contract.

## Evidence and measurement

Natural-language examples are `MODEL_REVIEWED`. They independently record generated, structurally valid, model accepted, exact verified (false), data gate accepted, manual checked (false), and training ready (false). The manifest always says `trainingJobPolicy=NOT_AUTHORIZED`. The historical CP0 reused row is not included in this run's new production yield.

Metadata summaries contain actual consumed call counts, known usage plus unknown count, conservative reservations, accepted-per-100-consumed-call ratios, each lane's queue/service durations, total makespan, measured controller RSS/CPU/disk and explicit unknown resource fields. Six-unit throughput is a small-sample observation; per-day numbers are labeled extrapolation. Student token counts initially remain null.

`measureTeacherPilotTokens` uses the existing pinned, offline Python token-ID worker through a separate verified natural-language text-pair gate. New measurements require a terminal `COMPLETED` or `FENCED` run with every consumed attempt settled; settled unknown results do not prevent measuring an accepted prefix. The official tokenizer and template SHA-256 values are fixed independently of the caller's profile and checked before measurement or receipt reuse. Its encrypted receipt binds the latest manifest, row digests, exact tokenizer profile, ID/mask digests and counts. Successful receipts are reused rather than recomputed by the write API; `verifyTeacherPilotTokens` independently recomputes them in fresh Python processes. It does not use CP0's exact-rational row gate or change content evidence. The original manifests are never backfilled. Official VLM/trainer parity remains `NOT_VALIDATED`/`NOT_RUN`.

The Student target is the [official NVFP4 checkpoint at revision da5b2650a835292c678994a1fa3fb653250fb508](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4/tree/da5b2650a835292c678994a1fa3fb653250fb508), with the official mixed precision release semantics; the user does not require every weight, gradient or optimizer value to be four bits. The [pinned configuration](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4/blob/da5b2650a835292c678994a1fa3fb653250fb508/config.json) binds the hybrid Mamba/attention/MoE/VLM identity; tokenizer identity and actual training compute/backend capability remain separate, with no claim that NF4 QLoRA is native NVFP4 training. Packing remains OFF: future training needs distinct attention-segment, Mamba convolution/SSM reset, shifted loss-mask, visual-length and auxiliary-objective validation, and none is a prerequisite for this untrained six-unit corpus pilot.

The user reports that two Spark systems have been purchased. Their arrival, resources and exact training backend capability still require actual verification; this corpus slice starts no training.

### Official precision and training route

The target follows the official release, not a project-defined all-four-bit variant. The pinned configuration and [NVIDIA release explanation](https://developer.nvidia.com/blog/nvidia-nemotron-3-5-super-vl-powers-specialized-agents-with-multimodal-reasoning/) describe a mixed precision model:

| Component | Official release precision |
| --- | --- |
| MoE expert GEMMs | NVFP4 weights and activations |
| Attention projections, Mamba input/output projections, language head | FP8 |
| Latent projections, embeddings, Mamba convolution, vision encoder and connector | BF16 |
| Router computation | FP32 |

The model combines 40 Mamba-2, 40 MoE and 8 attention blocks with a C-RADIO vision encoder. The release does not provide an audio encoder. Recurrent SSM/convolution state, attention KV cache and the authoritative long-term memory store are separate objects; none substitutes for another.

The initial training investigation follows the [pinned official Megatron Bridge recipe](https://github.com/NVIDIA-NeMo/Megatron-Bridge/blob/cb493d3589be719f2b854ce07d5564a09328b2ed/src/megatron/bridge/recipes/nemotronh_multimodal/h100/nemotron_35_super_vl.py) and [Model Optimizer QAD/export tutorial](https://github.com/NVIDIA/Model-Optimizer/blob/580ffff1cddb9b20a38b7434e6290654ebf96a8f/examples/megatron_bridge/tutorials/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16/README.md): adapt the supported source model, then validate the official NVFP4 quantization-aware distillation/export path. Directly fine-tuning the packed release is not assumed supported. Higher precision master weights, gradients or optimizer states are compatible with the user's target. Native NVFP4 backward-kernel support is a separate optional backend capability, not an extra requirement imposed on this target.

Before the first Student job, verify the exact backend, memory admission and a small reload/loss-mask regression. Cloud rental and the two purchased Spark systems are resource options; purchase and budget availability do not establish a working distributed training backend. The official recipe's example resource consumption is not a universal minimum. This six-unit teacher pilot measures none of those training capabilities.

## Trusted launcher interface

`runTeacherPilotCommand(raw, ports)` is a host-bound command handler, not a credential-discovering CLI. `raw` has exactly `{version:'CorpusTeacherCommand/0.1', command, spec}`. `describe` uses `spec:null` and no ports. `run` takes `{store, run:{objective, registry, transport}}`; `inspect` and `verify-manifest` take only `{store}`. The returned value is safe aggregate metadata; the launcher must not print the private store, exceptions, request/response bodies or credentials.

`measure-tokens` and `verify-tokens` take `{store, tokenizer:{profile,pythonPath}}` in trusted ports, with the same metadata-only command shape. The former stores the encrypted measurement ref in the ledger; the latter reads that committed ref and recomputes. Both return only their safe token summary, with no private row or path.

`openTeacherPilotRun({approvedTrainingRoot,runtimeRoot,authorityPath,spec,key,mode,sourceCheck})` creates a fresh run with `mode:'create'`, or opens only for verification with `mode:'inspect'`. The trusted launcher privately binds the approved training root, local resource floors, source rights and authority; keys and authority remain outside the corpus tree. `sourceCheck()` must freshly return `{registryDigest,allowed:true}` from an independent host decision. The reused `wf1-host/1` shape retains its historical `seal` boolean for compatibility; **this pilot has no sealed-data capability or operation**.

`createPilotTransport({together,deepseek})` supplies a separate single-flight native transport for each occupied scheduler slot. Requests use fixed official endpoints, `redirect:error`, bounded non-streaming bodies, exact requested/returned model checks, and no SDK retries. The new `CORPUS_*` binding is validated independently; it does not impersonate `.8`. Actual DSH control integration is outside this slice and remains NOT_RUN.

After generation, while the current authority remains valid, call `measureTeacherPilotTokens(store, profile, pythonPath)` and retain its returned encrypted `measurementRef`. A cold process opens the same store in inspect mode and calls `verifyTeacherPilotTokens`. The new profile must identify the exact official NVFP4 repo/revision; a previous BF16 measurement retains its original identity even if public tokenizer bytes match.

## Acceptance and remaining work

Targeted synthetic fixtures cover consumption before dispatch, bounded overlapping lanes, unit failure isolation, global fences and retained accepted prefixes, pause/revoke, source/sealed-root separation, duplicate/restart, altered external head/ciphertext, native envelope handling, immutable token receipts and exact independent token recomputation. The author and independent reviewer must record their actual checks against frozen source hashes before a trusted one-shot real run. Resource preflight, actual six-unit yield and linguistic quality belong to that runtime receipt. CP1 import, semantic cross-batch deduplication, manual/sealed product gates, trainer admission and activation remain separate work.

### Local validation, 2026-10-28

The frozen 31-file runtime has build digest `1226c1eb5e57a2b2e8cefe9592c1d4a11f71dbdaab3c2cdce59f29fe03cce0aa`. On base `e03e28b`, the author ran the complete synthetic suite: **1,022 passed, zero failed, zero skipped**, including real offline Python tokenization; strict TypeScript and whitespace checks passed. An independent Astra review accepted the source and ran six targeted risk groups. These numbers belong to this source, not the earlier PR #3 virtual merge with a different main-branch test inventory.

The dedicated pinned-Python CI job includes the teacher test file on Windows, Linux and macOS. Development preparation fetches only the official tokenizer JSON and chat template at the pinned revision, without authentication, with bounded HTTPS redirects, byte limits and fixed SHA-256 checks. It passes their explicit local directory to the pilot's positive test; artificial WordLevel assets remain in the generic worker tests and are rejected by the official pilot gate. CI results must be recorded from the actual published commit. Ordinary Core jobs can skip optional Python checks; that is not a substitute for the dedicated tokenizer jobs.

The local Windows carrier is separately hosted and is not part of the portable Core runtime. Its first initialization stopped at `DIRECTORY_CREATE`: the shell selected by the execution tool did not support the .NET Framework ACL methods. Only an empty control directory was created; no custody key, request-consumption marker or model call was reached. The failed attempt and its original source/configuration were preserved. A fresh carrier attempt pins the Windows PowerShell 5.1 executable, explicitly decodes UTF-8 configuration, verifies protected per-user directory access and preserves the original owner. Its ten PowerShell compatibility checks and eleven public preflight checks passed before execution. These host checks do not establish Linux/macOS carrier deployment or model quality.

That second initialization reached `INITIALIZE_NEW_AUTHORITY` but stopped before any request consumption or provider credential read. A public-spec reproduction found that Core returns JSON records with a null prototype, while the carrier serializer accepted only ordinary object prototypes. The attempted public state file was empty; the newly created authority was explicitly revoked. The partial files and failure remain preserved. This is a carrier serialization defect, not a rejected model sample; no API call occurred in either initialization attempt.

The corrected carrier accepts ordinary or null-prototype JSON records recursively and serializes before creating a file. A separate synthetic copy then completed the positive path using the real Core/native response parser and pinned Python worker: 13 fake responses, six accepted fixture rows, and 144 input / 96 loss / 240 full tokens. A fresh process reproduced every row's token measurement after automatic dispatch revocation. Duplicate invocation created zero workers or provider requests; expiry refused reads, while revocation remained possible without extending expiry. No real provider key or API was used by this fixture. The measured run took 54.613 seconds, with 209,666,048 bytes of controller RSS sampled at commits; unchanged resource gates passed. Repeated source hashing contributes to this controller cost, so these fixture timings are not model production throughput.

The fixture's Node-to-PowerShell driver initially failed because its child could not resolve `Get-FileHash`; its failed records are preserved. The successful chain used the same direct-host, absolute Windows PowerShell 5.1 invocation planned for the real run. Its initialization diagnostic copy added only exception reporting; fixture-only root, credential and fake-fetch substitutions are recorded separately and do not exist in the production carrier. This is a bounded host-path validation, not proof that arbitrary parent-shell environments work.

### Real provider pilot, 2026-10-28

One new run used the official native Together and DeepSeek APIs. The local carrier initialized successfully and the controller completed the frozen six-unit plan. DSH control was not used. Existing private histories, earlier failed/sealed samples and the old CP0 row were not inputs. Requests contained the approved goal synthesis, newly generated synthetic material and the full units' frozen source/family/root/split/rights metadata. Review hardening removes that unnecessary metadata from future provider requests; it does not rewrite what this earlier run sent.

| Observed result | Value |
| --- | --- |
| Consumed calls | 1 coordinator + 6 generators on Together; 6 DeepSeek reviews |
| Generated / structurally valid | 6 / 6 |
| Accepted new candidates | 5, all `MODEL_REVIEWED` |
| Quarantined | 1 `CPQ_MODEL_REJECTED`; no replacement or retry |
| Global fences / unknown usage / pending | 0 / 0 / 0 |
| Exact verified / manually checked | 0 / 0 |
| Student tokenizer measurement | 344 input + 1,256 loss = 1,600 full tokens, across five accepted rows |
| Provider-reported input / completion tokens | 8,276 / 11,292 |
| Estimated known cost | 12,382 microUSD; actual invoice unverified |
| Worst-case reservation / ceiling | 128,721 / 200,000 microUSD |
| Run wall time / controller CPU time | 114.801 s / 59.204 s |
| Controller RSS sampled at commits | 170,475,520 bytes |
| Data bytes at generation end / after token receipt | 1,021,220 / 1,054,474 bytes |

The rejected unit did not erase the five accepted rows or prevent the other frozen units from completing. Automatic cleanup revoked further dispatch. The original manifest's token fields remain unchanged; the five-row exact local measurement is a separate immutable receipt bound to the official NVFP4 tokenizer profile. Six-unit observations and any per-day extrapolation do not establish sustained production capacity. Model review is not independent factual or companion-quality validation; Student training, packing and activation remain unstarted.

A fresh Node/Python process then verified the committed artifacts and independently reproduced all five rows' exact token measurements: 344 / 1,256 / 1,600, with zero provider calls. The extra disk bytes are the separately committed measurement and state, not a rewritten original manifest. The actual duplicate invocation was refused before any new worker, custody-key read, credential read or provider request. Independent review of these safe receipts is separate from private content review; no manual review of the sample bodies is claimed.

### Review hardening after bd6afb9

The five-row real experiment above belongs to commit `bd6afb9a18f058539f7b8abd4fe8dbbcfd932e13` and runtime build `1226c1eb5e57a2b2e8cefe9592c1d4a11f71dbdaab3c2cdce59f29fe03cce0aa`. Review hardening adds minimal provider projections, official tokenizer asset binding, the measurement terminal gate, and focused synthetic regressions. It does not replay that experiment or change its immutable receipts or Student target digest. Historical full-unit request bodies remain accepted only by a strict read-only matcher that reconstructs the exact validated frozen host metadata; the native send validator rejects that legacy shape. This hardening has its own source freeze and validation evidence.

The hardening author ran one final whole suite on parent `bd6afb9`: **1,033 passed, zero failed, zero skipped**, in 133.688 seconds, with official public tokenizer assets processing only synthetic rows. Strict TypeScript and whitespace checks passed. Independent review passed nine focused cases and accepted the source and documentation. No real provider calls, private corpus reads or Student training occurred in this hardening; its new remote CI results remain pending publication.
