# C0: a synthetic full-index catalog model

`createSyntheticQaCatalogModel` is a pure RAM prototype. Every generation, snapshot, commit and eligibility check carries `SYNTHETIC_PURE_MODEL`, `NOT_AUTHENTICATED`, `NOT_SUPPORTED` for production use, `trainingReady=false` and `trainingJobPolicy=NOT_AUTHORIZED`. It does not read an archive, grant permission, persist a receipt, decrypt metadata, or prepare training data. A synthetic ACK is a test declaration, never an externally authenticated successful write receipt.

The existing `QaArchiveAssembly/0.2` reader/writer profiles and their eight-input limit are unchanged. Its full-node graph calculation shares an iterative union-find kernel with this model. No real production path now accepts a ninth source. Current generation/QA work and previously frozen snapshots do not depend on C0.

## Complete inputs and precedence

The model accepts only `SyntheticQaCatalogSource/0.1` records with `kind=FULL_INDEX`. Each supplies a complete `CorpusScopedDedupIndex/0.1`, its expected digest, descriptor/audit references, matching per-node case/verdict/token metadata, optional rubric references and explicit compatibility digests. Source records have no prompt, response, rubric text, notes or reasoning fields. Shapes, refs, hashes and inherited token counts are validated as declarations; those checks cannot authenticate an external source.

“Complete” means every node of the admitted QA index, including REJECT, HOLD, UNCERTAIN and NOT_AUDITED. The legacy index's `SELECTED_ELIGIBLE_ONLY` scope refers to the original production selection, not a filter that removes QA-rejected nodes. This model does not cover original production rejects or unadmitted historical content. A selected-member manifest is not a complete index and is refused as an input.

Source slots have permanent explicit ordinals. New slots must fill the next consecutive range; append input order may vary within that range. Sorting by source ordinal and then preserving original index order gives stable duplicate precedence. Node keys remain `(sourceJobId, unitId)` and family keys `(sourceJobId, familyId)`. Exact, normalized and prompt fingerprints connect families. Every disposition contributes edges; cross-split components hold all connected source families. This is exact fingerprint matching, not semantic deduplication or factual review.

The node-identity digest covers immutable index fields, including row/family/split/reference/fingerprint fields, and excludes QA disposition. C0 accepts at most one audit/selection for each distinct source job. Every same-source reimport, including a full replacement, partial overlap or disjoint selection, returns `CQA_CATALOG_SUPERSESSION_UNSUPPORTED`. This is an explicit C0 admission restriction: graph/member/token equivalence to the older assembly applies to the common accepted domain of distinct source jobs with the same fixed order, compatibility and member metadata. It is not a claim that all old admission combinations are supported by C0.

## Candidate, head and fixed membership

Create a model with a catalog ID and fixed compatibility digests. `prepare` takes an exact expected parent, up to eight new complete sources, and optional whole-source eligibility/retention withdrawals. It validates and copies input, recomputes the graph, and returns a deeply frozen candidate without advancing the head. Source/header/member mutation after preparation cannot change that candidate.

`commit` accepts only a candidate created by that model instance and an explicit matching `SyntheticQaCatalogAck/0.1`. It compares the candidate's parent with the current RAM head before advancing. A missing/lost synthetic reply leaves the head unchanged. Invalid ACKs, foreign/cloned candidates, stale competing candidates and rollback parents refuse. This models a compare-and-swap boundary; it does not implement a durable transaction, recover from a crash, or authenticate an external success receipt. The returned commit says `SYNTHETIC_ACK_ONLY`.

`snapshot` returns fixed `DatasetSnapshot/0.1` membership with type `MEMBERSHIP_SNAPSHOT`, exact catalog-generation/graph/policy digests, ordered members, active audit/descriptor/evidence refs, inherited measurements and train/dev token totals. Each member binds the same generation digest. Snapshots are frozen, never accepted as full indexes, and cannot be reconstructed or concatenated into a registered snapshot handle. C0 intentionally has no serialized-snapshot importer.

`checkSnapshotAgainstCurrent` accepts only a snapshot created by the same RAM model and checks every member against current modeled selection. An unrelated append can leave an old snapshot eligible. New cross-split evidence or an eligibility withdrawal can refuse its future use without changing its old bytes. The returned status is only `CURRENT_MODEL_ELIGIBILITY_ONLY`; it is not a current-permission or training admission result.

## Withdrawal and coverage gaps

Eligibility withdrawal is sticky and does not remove any node, fingerprint or family edge. It filters export membership after graph computation. It cannot silently promote a later duplicate or release a family from HOLD.

Declared metadata-retention withdrawal produces `COVERAGE_GAP_BLOCKED`, with no graph computation, full-node projection, selected members or totals in that new generation. Once committed, further preparation, snapshot creation and snapshot eligibility checks are blocked. The model does not drop a lineage and pretend the remaining graph covers history. Existing returned RAM objects cannot be recalled or erased; no actual retention enforcement is claimed.

## Bounds and verification

Bounds are 64 source slots, 192 nodes per source, 12,288 distinct nodes, at most eight appended sources per update, 1 MiB canonical metadata per source and 64 MiB canonical generation bytes. One audit per slot also limits audit versions to 64. Excess is a refusal. These are tested prototype bounds, not production capacity or performance commitments. There is no persistent mutable union-find state; each ready generation recomputes from all retained nodes using iterative path compression.

The focused suite contains 23 tests, including subtests. It independently compares one through eight inputs with the verbatim pre-extraction pure graph body from commit `5b9339aeac071f94007bb9581a995c76e176be5a`, preserved in `test/corpus-qa-catalog-legacy-oracle.ts`. The oracle does not call the new kernel. Comparisons cover every graph field, order, members and inherited token totals. Additional cases cover a ninth REJECT/HOLD bridge through earlier non-PASS evidence, page grouping, immutable candidates/snapshots, modeled CAS/lost reply, sticky withdrawal, retention gaps, source conflicts, malformed data, mixed snapshots and the full 64-source/12,288-node bound. Existing QA/archive focused checks and strict types are reported separately in the author freeze; no whole-suite, cross-platform or actual archive claim is made here.

## Deferred C1 work

C1 must add authenticated reader admission and fresh read/retain checks, including expiry after the final callback; immutable encrypted bounded segments; complete same-source audit supersession with all identity/selection/population checks and audit-version history; persistent ordered generations and withdrawal events; external successful receipt custody and durable expected-parent publication; independent-process cold recomputation, corruption/resource checks and explicit recovery/refusal behavior. The host must keep all such private metadata in the approved encrypted location, independently of source code. C0's caller-supplied hashes and synthetic ACKs cannot substitute for any of those controls.

Old snapshots retain exact bytes. New contamination evidence cannot undo prior training or restore an evaluation set that was already used. Teacher quality, tokenizer/trainer parity, actual execution and permission to train remain separate decisions.
