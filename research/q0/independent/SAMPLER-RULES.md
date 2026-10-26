# Q0 independent evaluator precommit

This capsule is committed before encoder freeze and before held-out data/query generation.
It contains independent query sampling, raw-observation oracle, decoded-response scoring and family-cluster statistics. No author answer function or codec implementation was inspected.

Generation after freeze: concatenate makeFamilies(seed_i,200) for three ordered private uint32 seeds. Do not refit prototypes. Encode only observations, never queries, seeds, expected answers, group labels or evaluation feedback. Private seeds are procedure-isolated on a shared host, not cryptographically inaccessible.

The sampler fixes 24 queries per family: 8 announced point/change questions, 8 unannounced field points, 8 temporal/relation/property compositions. Exact expression construction and RNG are frozen in evaluator.mjs. Sampling is independent of codec outcomes. No result-dependent deletion, reseeding or denominator changes are allowed. Point addresses are provided; this is finite-schema given-address representation recall, not retrieval or open-world understanding.

Expected answers are computed directly from raw observations by this independent interpreter. Decoded answers use the same frozen query grammar, explicit observed_unknown/omitted/missing/unsupported/indeterminate diagnostics and conservative intervals. All required atom witnesses are retained even for logically decisive Boolean branches. Intrinsic observed_unknown can be exactly preserved; omission, unsupported and interval indeterminate never count exact. Scalar comparisons have no tolerance. Quantized outputs remain separately marked.

All three announced rare fields are evaluated across every object/event, not only sampled questions. Main rare detail true positives require exact scalar and full binding; presence-only detection is secondary. Unknown truth is not a true negative. Any prediction on unknown is reported as unsupported; unknown positive predictions remain in supported-detail precision's prediction denominator. Rare precision without positives is undefined. Hard-anchor exact retention also requires exact fidelity for observed values; equal quantized centers are separately counted as anchorValueExact. Source/identity bindings and unknown fabrication are checked across all attribute/relation cells.

Report paired point estimates and 2,000 seed-stratified family percentile bootstrap replicates. 95% percentile endpoints are 0.025/0.975. Undefined bootstrap denominators produce inconclusive intervals. Zero-width empirical distributions are explicitly marked degenerate, not future zero risk. Minimum 30 positive families is only the predeclared descriptive support gate, not a power guarantee. Report each field and all groups, including failures.

Utility decisions use frozen protocol thresholds against the best complete standard archive baseline; no retrospective method or threshold selection. All cost regimes and over-budget results remain visible. If formal results become public, this heldout becomes a regression set; a codec tuned using these results requires a new independent heldout.

Precommit selfchecks use only a handcrafted SELFTEST_ONLY family and toy seeds. They do not import the author generator/codec or estimate experimental quality. Formal run needs separate Root admission. Current status: FORMAL_RUN_NOT_STARTED.
