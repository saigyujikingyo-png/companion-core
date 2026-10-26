# Q0 public encoder / reader / query interface — candidate v1

2026-10-26. Development only. Public schema and operations can be shared before the independent evaluator commits its private sampler. No held-out seed, query instance or outcome is in this document.

## Roles and ordering

1. Author publishes this schema, `protocol.json`, method names and fixed numeric/rare definitions. Independent evaluator may inspect those contracts, not tune against codec outcomes.
2. Evaluator independently commits sampler/oracle source and private seed commitment in its own location **before the encoder freeze**. It does not reveal seeds or specific combinations to the author. This prevents choosing a test after seeing which codec wins.
3. Author freezes `codec.mjs`, `scene.mjs`, development-only prototype asset, protocol, CLI and dependency versions with SHA-256. Root checks both commitments.
4. Only then evaluator generates held-out families and exact query instances. Root separately authorizes the formal run. Encoder sees observations; it never receives seed, query, expected answer, known/heldout label, evaluator metrics or budget feedback.
5. One formal run per frozen version. No replacing failures, changing denominators or choosing a different codec/threshold afterward. Any necessary bug fix creates a new version/run, retaining the first result. Shared-host process separation is procedural, not a cryptographic access barrier.

## SceneFamily input (JSON-compatible)

```text
SceneFamily = {
  logicalSchema: "q0-scene-1", namespace: "q0-synthetic",
  familyId: opaque string, domain: "desk" | "workbench" | "room",
  events: [4 × {
    eventId: opaque string, timeTick: integer synthetic_tick,
    objects: [3 × {
      objectId: opaque string, trackId: opaque string,
      conceptId: "vessel" | "tool" | "container", sourceRef: opaque string,
      attrs: {each of the 12 attribute names: Cell}
    }],
    relations: [{subjectId, predicate: "left_of" | "near", objectId,
                 sourceRef, ...Cell}]
  }]
}
Cell = {status: "observed_value", value: string | finite number | null | boolean,
        fidelity: "exact", maxAbsError: 0}
     | {status: "observed_unknown"}
```

Attributes in fixed order: `color, material, location, mass_g, temperature_c, orientation_deg, capacity_ml, texture, label, crack_mm, serial_tag, dose_mg`. Categorical/text fields are strings; `serial_tag` is string or null; the six numeric attributes and their units/quantization steps are fixed in `protocol.json`. Relations explicitly store true, false or observed_unknown; absence is never false. A relation has its own sourceRef. There is no hidden physical ground truth beyond the observations.

ObjectId, trackId, eventId, familyId and sourceRef do not encode attribute values or expected answers. Concept denotes class, not unique object identity. Objects persist across the four event times. The generator is public and deterministic; private seed values and task compositions are not. This tests unannounced tasks within a finite public schema, not arbitrary unknown future schemas or ten-year continuity.

Generator entry point: `makeFamilies(seed, count)` exported by `scene.mjs`, where seed is uint32 (0..4294967295) and count is an integer 1..1000. It returns `SceneFamily[]` in index order. Family index j has domain `[desk,workbench,room][j % 3]`; each family has all three concepts above, event ticks 0/10/20/30 and exactly three persistent objects. Heldout input is the ordered concatenation of `makeFamilies(seed_i,200)` for three independently committed seeds. No label argument or hidden query input exists. Relation truth varies by family/event, using freshly sampled distinct scalar positions: left_of is antisymmetric, near (distance <=25) symmetric. Positions themselves are not an observed attribute or query API. Observed relation-unknowns can hide either direction.

Queries supply exact event/object addresses. Scores therefore measure **given-address representation recall**, not retrieval of the right event from vague natural-language clues, nor AR1/RAG performance. The three hard-anchor names are announced before encoding; their preservation does not establish preservation of arbitrary future rare details. Hidden field selections/combinations are a separate test.

## Encoder and decoder

```javascript
encodeFamily(sceneFamily, methodName, frozenDevelopmentPrototypes)
  // -> {header: plain object, bytes: Buffer}; no query argument or mutable fit step
decodeFamily(header, bytes, frozenDevelopmentPrototypes)
  // -> SceneFamily with the same binding metadata and decoded Cells
```

Decoded Cell adds `{status:"omitted"}` for information intentionally not retained. `observed_unknown` must remain distinct. Numeric quantization retains `status:"observed_value"` to describe its source, but uses `fidelity:"quantized", maxAbsError:q/2`; this is a reconstruction interval, never a verified exact observation. Categorical values, identity/source/time bindings and all relations remain exact in every method. Lossless prototype equality is only encoded for an explicitly observed retained attribute, never used to fill unknown or omitted values.

Prototype-relative numeric residuals use nearest fixed grid, `Math.round` (half ties toward positive infinity), no clipping. Exact modes are supplied by development observations only and serialized as a frozen asset. The profile and prototype hash must match before decode. Hashes establish consistency, not authorization or semantic truth. No production permission or Core integration is claimed.

## Public query algebra; evaluator owns instances, sampler and implementation

The evaluator writes its own query interpreter and expected-answer calculation. It does not import an author-provided answer/oracle function. The same interpreter is applied to raw observations and every decoded method.

```text
ValueAtom = {op:"value", eventId, objectId, attribute}
RelationAtom = {op:"relation", eventId, subjectId, predicate, objectId}
Expr = ValueAtom | RelationAtom
     | {op:"compare", cmp:"eq"|"ne"|"lt"|"le"|"gt"|"ge", left:ValueAtom, right:{literal:scalar}|ValueAtom}
     | {op:"changed", before:ValueAtom, after:ValueAtom}
     | {op:"delta", before:ValueAtom, after:ValueAtom}
     | {op:"and"|"or", args:[2..3 boolean Expr]}
     | {op:"not", arg:boolean Expr}
```

Maximum expression depth 4 and 15 nodes. Temporal atoms can target different observations of the same object; relation and property atoms can be composed to test role/target binding. Literal values and combinations are selected by the independent sampler, not the encoder. No arithmetic inference beyond delta is required. Public development tasks are point values and changes on `color, material, location, mass_g`; all other field selections and composed task distributions are unannounced to the writer, though the grammar/schema is public.

Each result retains the atom witnesses: family/object or relation subject+target, attribute/predicate, eventId, timeTick, sourceRef and underlying status. Correct value with a wrong witness is wrong. Unknown input, codec omission, unsupported query and interval-induced indeterminate remain distinct diagnostics. Unknown is not false. Threshold comparisons use intervals conservatively; if both true and false are possible the result is indeterminate, retained in the scoring denominator. Delta interval is derived from both operands; exact arithmetic on quarter-integer source values avoids hidden tolerance changes.

Point value exact score compares actual scalar and complete binding with no numeric tolerance. Fidelity and bounds are separately retained; a numeric tolerance score, if reported, is secondary and cannot replace exact accuracy. Composed results require the exact answer and required witness bindings. Missing/indeterminate answers count as non-exact, not removed cases. The evaluator freezes how it reports intrinsic observed_unknown versus codec-induced omission before running.

Rare truth: observed `crack_mm>0`, observed `dose_mg>0`, observed `serial_tag!=null`. Primary rare-detail precision/recall requires the exact scalar plus object/event/time/source, not merely a positive value. Presence-only detection precision/recall is secondary. Report per field and pooled with denominators; no positive predictions gives precision `undefined`, not 1. Predictions crossing the zero threshold are indeterminate, not positives. Unknown source cells are not true negatives. Report false positives on observed negatives, and affected families; fewer than 30 positive families in a rare category means inconclusive for that category. Adversarial wrong-source/wrong-time interventions, if any, are separate from random quality denominators.

## Archive/cost interface

One independent Zstd frame per family, a JSON header per frame, index, manifest, profile, optional prototype asset, and retained `codec.mjs` + `scene.mjs` reader source. All six methods use the same frame granularity and compression settings. Directory layout uses standard files; this is not a new binary container. No whole-corpus compressor gives one method an undisclosed advantage.

Costs report actual bytes for payload, headers, index/manifest, profile/prototype and decoder source. `archiveBytes` sums them all, without charging six competing methods to one method. Also report original synthetic input bytes, encoder/evaluator/protocol retention, Node executable bytes/hash and platform dependency, and full standalone footprint (archive + runtime + cold originals + audit tooling). These dependencies do not silently become zero; percentage claims must name the cost regime. A result that saves archive bytes does not establish the same standalone saving. Filesystem allocation, OS installation, backups and ten-year reader availability are unmeasured, explicitly excluded rather than implied free.

Fixed archive budgets: 128 / 256 / 512 bytes per object-observation (12 per family). Over-budget methods remain reported with their full quality scores; no source deletion or data-dependent cutoff is allowed. The CLI counts index/manifest overhead and supports N=8/32/128/512 family-prefix recomputation with identical deterministic ordering, not cherry-picked subsets. Runtime/memory are bounded by `protocol.json` and checked freshly immediately before the authorized formal run.
