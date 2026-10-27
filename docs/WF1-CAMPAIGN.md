# WF1 bounded private teacher calibration

WF1 adds an isolated worker for a new, empty local campaign. It does not change Store, TJ0, TJ1 or the frozen WF0 metadata contracts. Its outputs are teacher candidates. Formal computation, model review, source declarations, host authorization and actual Student results are separate evidence classes. Student inference and training remain `NOT_RUN`; publication remains `NOT_AUTHORIZED`.

The worker implements the complete bounded sequence: admit a new campaign, obtain and encrypt an independently authored sealed artifact, obtain a coordinator plan and separate review rubric, consume each attempt durably, dispatch it at most once, perform private custody exclusion, recompute the complete formal target, review train/dev material, and freeze a private dataset manifest. Only operational metadata reaches stdout. No model-generated code is executed.

## Roles and private material

The bootstrap contains the current human request verbatim, the protocol schemas, generic verifier catalog and operational limits. It contains no agent-authored lessons, answers or concrete evaluation rubric. DeepSeek independently authors the sealed cases, plan and rubric in separate fresh requests. The coordinator, candidate teachers and train/dev reviewer never receive sealed cases, sealed answers, rubric or per-item evaluation feedback. The custodian's one-time exclusion query returns only a routing result inside the worker; it is not sent back to a teacher for adaptation. A collision stops the campaign.

Sealed generation must finish, parse, pass formal custody sanity checks, encrypt and read back before plan generation. These sanity checks establish supported custody material, not Student evaluation or teacher quality. The seal contains twelve cases. The plan contains sixteen declared content families, twelve train and four dev; the first four are three train and one dev. Eight comparison family IDs are frozen in that plan before any candidate outcomes.

Each artifact uses fresh AES-256-GCM nonce and immutable file identity, authenticated campaign/partition/kind binding, and separately derived custody/train keys. A train capability cannot read a custody reference. Sol's private wrapper provisions a random 32-byte key, wraps it with current-user Windows DPAPI and restores it on the same host; only its unwrapped value enters anonymous stdin. Core never reads a DPAPI file or discovers credentials. The trusted worker holds both scoped capabilities to orchestrate custody checks. This is cooperative same-host capability routing, not OS-account isolation or protection against a malicious same-user process. Loss of key or failed readback prevents custody recovery.

Runtime and independent authority directories must be outside OneDrive and the source checkout. Raw responses, final text, native reasoning, plans, requests and rubric remain encrypted private artifacts. The private ledger contains references and operational records, not public artifacts. No general-purpose decryption CLI is provided.

## Gates and provenance

All first four candidates must have complete formal verification, clear exclusion and clear model review before the later twelve. A later wrong or unsupported target is quarantined individually. All sixteen must settle without unknown transport/usage or hard authority/isolation/source failure before comparison. The prespecified eight pairs are not excluded because DeepSeek was wrong; synthetic tests cover that scenario, but an actual campaign is not guaranteed to contain a wrong DeepSeek answer. Results are never used to cherry-pick the comparison set. Together produces its own answer to the identical formal input, then a fresh DeepSeek call reviews that train/dev answer. Both source receipts remain diagnostic records.

Known content roots must represent real derivation. Copying or numeric/template variation inherits ancestry; shared provider, model, schema, verifier, build or control instruction alone does not join content families. Shared supplied roots or exact formal input across declared independent families are rejected before deduplication. Paired provider variants share the same registered family. Export fingerprints cover canonical `{tool,input,typedTarget}`, excluding provider, claimed IDs and other control metadata; equal answers to different inputs are not automatically duplicates. Exact duplicate effects appear only once in the selected private manifest while both provider diagnostics remain recorded.

These checks cover this supplied campaign only. Cross-campaign historical registry injection is `NOT_IMPLEMENTED`. Hidden semantic ancestry, omitted roots and semantic near-duplicates cannot be discovered. Declared family independence and license/right assertions are not authenticated truth. This slice must not be described as preventing all historical leakage or proving global family independence. Its new runtime is initially empty and isolated from earlier private datasets.

## Formal verification and JSON profile

The catalog contains only data operations, no shell, network, arbitrary code or model-generated execution:

- `rational.evaluate.v1`: closed binary add/subtract/multiply/divide AST, at most 31 nodes and depth 6. Leaf numerator and positive denominator are canonical decimal integer strings, magnitude at most 128 bits; bounded exact BigInt intermediates are at most 4096 bits. The target is a GCD-normalized numerator/positive-denominator object. Division by zero and unsupported nodes refuse.
- `json.pointer.v1`: strict RFC6901 selection, document at most 16 KiB, depth 16, 2048 nodes and pointer at most 256 UTF-8 bytes. Escaping and array indices are checked; target equality is the canonical selected subtree.

Entire selected input and target must be this formal protocol projection. Natural-language correspondence, explanations, style and native reasoning receive no deterministic truth claim. Model review is `MODEL_REVIEWED`, not ground truth. Unknown/unsupported coverage is quarantined. `verifierBuild` hashes the actual verifier, JSON and type source bytes; worker source identity additionally covers its runtime dependency closure. The catalog is deeply immutable.

Closed schemas and bounded JSON parsing reject unknown fields, duplicate decoded keys, unsafe numbers, malformed Unicode and executable/accessor objects. JSON numeric spellings are signed safe decimal integers only: `0` or `-?[1-9][0-9]*`; `-0`, fractions and exponents are rejected before conversion. Strings are bounded in UTF-8 bytes. IDs/roots are 1–96 ASCII characters matching `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`; roots have 1–16 unique entries. The same constraints are included in protocol metadata sent to the teacher. Ordinary text fields allow Unicode. Raw response is at most 256 KiB; parsed depth 32, nodes 16384, individual string 64 KiB; typed candidate object at most 64 KiB. Object cloning charges cumulative serialized bytes before canonical allocation.

## Consumption, concurrency and interruption

Each attempt is durably inserted into the bounded SQLite ledger before submission; its request hash, encrypted request reference, operation/family identity, deadline, token reservation and estimated spend are fixed. A separate authority high-water head must then acknowledge the ledger commit. A live in-memory capability may dispatch that attempt once. Unknown outcomes, a lost capability or a process restart never recreate dispatch permission. No SDK retries or redirects are allowed.

The ledger uses FULL synchronous commits, a keyed chain and a cooperative exclusive process-owner lock. Host head commits, operator controls and dispatch initiation use the same independent SQLite lock. Inside that lock the current campaign, revision, runtime, active status, rights, fresh clock and expected head are checked. Dispatch linearizes at synchronous native fetch initiation while holding that lock. Operator pause/revoke must use this protocol/CLI, not overwrite the authority file directly. A pause that wins first prevents dispatch; a request initiated first may already have reached the provider.

During an in-flight request the worker checks current authority every 100 ms, locally aborts once on withdrawal, and requires a fresh gate before admitting the response. A local abort does not prove remote cancellation or refund. Late private bytes may remain evidence but are not candidate admission; unknown reservations remain consumed. Half commits, changed files, restored ledger prefixes, stale authority and mismatches fence the worker. The two stores are not a distributed transaction and are never automatically reconciled by advancing a host head.

Cold `inspect` opens the ledger genuinely read-only, refuses a nonempty rollback journal and never applies writable recovery PRAGMAs. It returns `RECORDED_CLAIMS_ONLY` / `RECONCILE_REQUIRED`; its cooperative owner lock may create/use an owner sidecar. Execution resume and replay are `NOT_IMPLEMENTED`, including after pause. A new campaign is a new explicit admission, not a continuation of an unknown attempt. This does not defend against rollback of the entire trusted host and its independent authority together.

## Frozen profile 0.3 and estimates

`wf1-campaign/0.3` and `wf1-profile/0.3` supersede the design draft's 0.2 completion settings. Only DeepSeek seal and plan have 4096 completion tokens; its other operations remain 2048. Together remains 4096 total completion tokens, including reasoning. The request JSON body is at most 16384 UTF-8 bytes. Each call reserves 18432 input tokens as a conservative estimate, not a proven tokenizer bound. Reported usage above that reservation is recorded and immediately stops dependent work. Missing usage keeps the full reservation and stops.

| Limit | DeepSeek | Together |
| --- | ---: | ---: |
| Calls | 44 | 8 |
| Maximum input reservation | 811008 | 147456 |
| Maximum completion reservation | 94208 | 32768 |
| Estimated budget, micro-USD | 400000 | 100000 |

Pilot allows 36 calls and comparison 16; total calls at most 52 and global concurrency is one. Campaign, pilot, comparison and per-call limits are respectively 60 minutes, 30 minutes, 20 minutes and 120 seconds. Worst-case reservations are retained rather than refunded. The normal complete path makes 43 DeepSeek and 8 Together calls. One format-repair call is reserved by the cap but actual repair/retry is disabled (`NOT_IMPLEMENTED`); malformed or truncated generation is retained and stops or quarantines according to its stage, never repaired by agents.

Price inputs are frozen host declarations in integer micro-USD per million tokens. At DeepSeek 300000 input / 1200000 completion and Together 150000 / 600000, the upper estimate is USD 0.3981312 before per-call upward rounding, or 398170 micro-USD after rounding (`2*10445 + 42*7988 + 8*5223`). Total estimated admission cap is 500000 micro-USD. These are estimates, not invoice guarantees. `actualInvoice: UNKNOWN` is allowed. Provider-grouped reports include known input/completion/reasoning usage, unknown usage/reasoning counts, estimated spend from known usage, worst-case reservation, HTTP status counts and fixed failure categories. Unknown reasoning is not reported as a measured zero. Completion already includes native reasoning; reasoning is not billed a second time.

Only `https://api.deepseek.com/chat/completions` with `deepseek-flash` and `https://api.together.ai/v1/chat/completions` with `openai/gpt-oss-120b` are used. Responses must report the pinned model. DeepSeek thinking is disabled; Together reasoning effort is low. Native reasoning and final content have separate artifact references. Reasoning-only, length termination and tool requests never count as a complete answer. Native transport identity records an observation path, not provider truth or authenticated billing.

## Worker interface

Run `node src/wf1-worker.ts --describe` to obtain build/profile digests without network or runtime mutation. Normal invocation is `node src/wf1-worker.ts`, with exactly one bounded JSON document through anonymous stdin and one allowlisted operational JSON on stdout. Never put keys, objective or material in command-line arguments. The stdin fields are:

```text
version: 1
action: prepare | run | inspect | pause | revoke
runtimeRoot: absolute private runtime directory
authorityPath: absolute external authority JSON path
expectedHead: null | exact current head
spec: { schemaVersion: "wf1-campaign/0.3", id, createdAt, expiresAt,
        sourceDigest, profileDigest, objectiveDigest,
        prices: { deepseek: Price, together: Price } }
custodyKeyBase64: canonical base64 of 32 random bytes
objective: verbatim current user request for prepare/run; empty for controls/inspect
credentials: { deepseek: string | null, together: string | null }
Price: { snapshotId, inputMicroUsdPerMillion, completionMicroUsdPerMillion }
```

Authority is `{schemaVersion:"wf1-host/1",campaignId,revision,runtimeId,status,expiresAt,head,rights}`. Revision starts at one, status is ACTIVE/PAUSED/REVOKED, and rights has exactly boolean seal/coordinate/generate/review/retain. Spec and authority use nonnegative safe integer Unix milliseconds. `sourceDigest`, profile, objective and `expectedHead` must match. `prepare` is read-only with no ledger/API, `run` only admits an unconsumed null head, controls use the shared lock, and inspect never resumes. Credentials can be null for preparation, controls and inspection.

The actual CLI always constructs the native transport. Any injected test fetch permanently labels its provider/results/campaign `SYNTHETIC_FIXTURE`; it cannot produce actual teacher evidence. Synthetic full-loop tests do not establish provider quality, real model behavior, licensing or student improvement. Cold reads are always recorded claims. Stdout excludes private IDs, references, content digests, prompts, outputs, rubric, credentials, dynamic exception text and provider error bodies. HTTP status and fixed failure classes support diagnosis without reading private material.

Official price snapshots are taken from [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) and [Together GPT-OSS](https://docs.together.ai/docs/gpt-oss). Public USD estimates are not authenticated account charges; actual invoice remains `UNKNOWN`.

## Acceptance and stopped calibration — 2026-10-27

Evidence remains separate: author strict TypeScript and 28 focused synthetic tests passed; independent review passed five groups; the single normal-user whole passed 673/673 with no failures, cancellations, skips or todos. These validate the research infrastructure, not teacher-data quality. A portable synthetic fixture provisioning patch subsequently passed 29 focused tests and strict TypeScript; the previous single native whole result of 673/673 is retained, and new cross-platform CI is pending. The [earlier validation CI](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40423928497) remains a recorded macOS failure at the canonical-path gate; its log did not print the temporary path, so a platform alias is a diagnosis rather than a directly observed path.

The one admitted actual campaign is **NEGATIVE_CALIBRATION_STOPPED**. Native transport observed one DeepSeek HTTP 200 response and zero Together requests, then stopped with `WF1_JSON` before a sealed artifact, plan, candidate or manifest was completed. Provider-reported usage was 965 input and 1120 completion tokens; estimated usage was USD 0.001634 against USD 0.010445 reserved. Actual invoice remains `UNKNOWN`. A one-time read-only format diagnostic found both native JSON parsing and the frozen strict parser rejected the final text; this does not establish a parser defect. No teaching text or per-item semantic findings are published.

A fresh-process cold inspect retained `RECORDED_CLAIMS_ONLY / RECONCILE_REQUIRED`, with one settled attempt and no sealed artifact. The single duplicate-refusal check dispatched no new API request. The original `STOPPED` outcome is preserved: no retry, format repair, replacement campaign or expansion occurred. Together comparison was not reached; Student inference and formal training did not run. This slice delivers rerunnable research infrastructure, not a data-quality PASS.

Further work on teaching-side format stability or bounded repair requires a separately frozen design and admission. It must not automatically bypass the current parsing, usage, source or quality gates.