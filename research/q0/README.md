# Q0 public-package integration notes

One independently committed blind evaluation has completed. No tested method met both the frozen quality conditions and 15% complete-archive saving. See [RESULTS.md](RESULTS.md) and the byte-exact [FORMAL-RESULTS.json](FORMAL-RESULTS.json). This document does not change the frozen algorithms, assets or thresholds. Core remained read-only to this author; the integration writer combines the allowlisted author components with the independently frozen evaluator/replay bundle.

## What the package measures

Given an exact object/event address, can a representation reconstruct the recorded value, time and source? Six methods use real Zstd: complete typed JSON, complete object-bound template text, four announced task attributes, complete prototype/delta, fixed numeric quantization, and that same quantization with three exact rare anchors. The complete template is a reversible first-party grammar, not a generated language-model summary.

This is finite synthetic representation recall. There are no LLM calls, perception pipelines, natural-language retrieval, GPU workloads, training or user memories. A supplied event/object address removes event-location retrieval from the test. Three anchor names were announced in advance; preserving them says nothing about arbitrary unforeseen rare attributes.

Input grammar, status semantics, quantization, rare-detail definitions and independent commitment order are in `INTERFACE.md` and `protocol.json`. The pre-run `stage` label in the frozen protocol is historical and must not be edited to make a new status claim. Actual execution status belongs in the separate run receipt/result.

## Evaluation contract that must remain visible

- Development observations alone fit the 309-byte frozen prototype. Independent evaluator commits its sampler/oracle and private-seed hash before encoder freeze, then generates the heldout observations/questions after freeze. Shared-host isolation is procedural, not cryptographic secrecy.
- All methods use the same independently written oracle/interpreter. Known tasks, unannounced fields, new temporal/relational combinations, intrinsic unknowns and rare attributes are reported separately. Questions are clustered by scene family; three data seeds are not hundreds of independent seed replications.
- Primary answer metric is scalar/object/event/time/source joint exactness with zero numeric tolerance. Unknown, codec omission, unsupported and interval-induced indeterminate stay in the denominators. Secondary tolerance scores cannot substitute for exactness.
- Primary rare metric is **detail** joint-exact precision/recall; presence-only detection is secondary. No positive predictions means undefined precision. Fewer than 30 positive families in a rare category is inconclusive. Observed-unknown is never a true negative or fabricated value.
- Complete active archive bytes include frames, headers, index/manifest, profile/prototype and retained reader source. Cold original observations, audit tooling and runtime dependencies are separately measured and included in a standalone footprint. Archive saving cannot be called the same standalone saving. OS/filesystem-allocation/backup costs and ten-year retention are unmeasured.
- Family-count amortization points are 8/32/128/512; archive budgets are 128/256/512 bytes per object-observation. Over-budget groups keep all their results and provenance; they are not discarded.
- Advancement rule is at least 15% smaller complete archive versus the best full standard baseline and a 95% seed-stratified family-bootstrap lower bound above -1 percentage point for both known and unannounced exactness and supported rare precision/recall (2,000 resamples). Exact anchors and source binding are mandatory. Otherwise retain the standard complete representation; a small synthetic pass is not general semantic acceptance.

One formal attempt is allowed for the frozen version after fresh resource admission. Failures are kept; a repaired version needs a separate new run. The formal runner and sampler/seed specification were supplied by the independent evaluator, not authored by this encoder author. Any public manual full-run command must use its actual audited interface rather than an invented wrapper.

## Portable small package

Copy only the allowlisted `.mjs` sources, public contract/parameters, frozen `development/prototypes.json`, concise sanitized evidence summaries and manifests. Include the independently frozen evaluator/seed specification, portable replay wrapper and compact final results supplied for reproduction. Do not copy development observations, frame archives, stdout logs containing absolute local paths, caches, private draft manuscripts or prior research output trees.

No external npm dependency is required for the encoder/reader. Node v24.16.0 with built-in Zstd 1.5.7 was the development environment; another runtime must be recorded as such. An existing output directory is refused. Runtime artifacts default to a unique system temporary directory for the development checker; archive CLI always requires an explicit new directory. The source tree is not a runtime-output default.

```text
node --max-old-space-size=256 smoke.mjs
node --max-old-space-size=256 dev-check.mjs [NEW_OUTPUT_DIRECTORY]
node --max-old-space-size=256 archive.mjs OBSERVATIONS_JSON METHOD NEW_OUTPUT_DIRECTORY
```

CI runs only `smoke.mjs` (one public development family, six methods, no filesystem writes or heldout evaluation) and `replay.mjs --prepare` (fresh TEMP layout restoration and exact hashes, no encoder/evaluator or heldout computation). Full quality evaluation is manual and must not be added to every production whole-suite run. The archive reader assumes trusted generated research assets; its hashes are consistency checks, not authorization or a security review for arbitrary archives.

The original coordination `PLAN.md` is retained byte-exactly as `protocol-plan.txt`, a non-navigation historical record. Its SHA still matches the frozen original; its old relative references are not package links. A public replay wrapper must create a new TEMP canonical source layout, map `protocol-plan.txt` back to `PLAN.md`, preserve the other eight frozen paths, and restore the independent capsule files before invoking the unchanged formal runner. The runner reads an explicit JSON config with `sourceRoot`, `capsuleRoot` and `outputDirectory` and still verifies its original source/capsule hashes. The exact runner file/command and capsule manifest come from the independent evaluator. Public replay is labeled PUBLIC_REPLAY, never the original blind evaluation, and is not automatically run during package copying. `ENCODER-FREEZE.json` remains historical source evidence; local development receipts not copied into this package are represented by the sanitized summary and their original hashes.
