# IF5 / AR0b1: durable consumer to current retrieval

2026-10-27. Frozen implementation plan before source edits. This extends the local synthetic IF0–IF4 worktree; it does not grant training, provider execution, production migration, deletion or merge permission.

## Observable outcome

A trusted local caller can bind RetrievalService to an existing schema2 `retrieval-refs-v1` consumer, refresh its RAM views, query and resolve current published memories without manually supplying refs. The consumer's entire current projection defines the selection. A stale, paused, reset, fenced, expired or over-budget projection cannot be delivered as complete.

## Contract

- Add a Store entry point that copies/validates the closed consumer handle before reading authority. One external access guard covers a durable TTL sweep and a subsequent consistent read transaction. The read validates the current complete projection, then collects its memory bodies and full source closure at the same frozen read time. Do not compose separate public Store calls or expose callbacks/database handles.
- Return a versioned consumer stamp (identity/profile, consumer generation, applied/current journal sequence, scope/runtime authority and read time) together with the ordinary bounded memory-only retrieval snapshot. The stamp proves local completeness at that read; it is neither a portable capability nor semantic truth.
- Accept only the retrieval profile. No caller-provided refs, offsets, scope overrides, registration, implicit catch-up, reset or resume. Existing trusted Store controls remain responsible for consumer progress.
- Keep all existing AR0 bounds: 32 selected, 128 closure nodes, 512 edges and 262144 charged UTF-8 bytes, plus separate projection limits. If the complete durable selection exceeds any bound, reject the whole read; never truncate or silently fall back.
- Preserve the existing manual-ref AR0 API and ranking semantics. A new consumer binding copies inputs and uses the atomic Store seam for bind/refresh/query/resolve. Consumer progress participates in pair identity even when selected content happens to remain equal. No stale pair/candidate fallback. Observed invalidity terminates the binding; explicit refresh can build a new pair while a binding remains valid.
- New source publications require explicit consumer apply, then fresh refresh/rebind according to the documented invalidation contract. Pause/reset, boot, consent/runtime, source revision/revocation and cutover invalidate old capabilities. Empty projections still perform all authority checks. No-change reads must not add commits; a crossed TTL barrier must persist even if delivery is refused.
- No schema, ciphertext, key, receipt, model, provider or dependency change is planned. RAM indexes remain rebuildable; only source metadata/progress is durable. This is infrastructure correctness, not BM25/vector/PPR or AR1 quality acceptance.

## Acceptance before closure

1. Demonstrate the missing public seam, then implement actual Store and service behavior.
2. Test end-to-end publish/apply/bind/refresh/query/resolve, independent retrieval/scene consumers, new memory completeness, source revision/revocation, consent/purge, empty scope and profile mismatch.
3. Test TTL future/expiry and rollback, budget refusal without partial output, pause/reset/retention, immutable input and forged/copied/cross-binding service capabilities, no-change commit count, candidate invalidation when only journal position changes.
4. Use fresh synthetic native TEMP for anchored-v3 reopen/boot/cutover and a real child-process reopen where it adds evidence; demonstrate old handles rejected and fresh catch-up/rebind works. No private data or existing runtime.
5. Author focused and affected tests/typecheck, independent read-only review, then one independent final whole suite on frozen integrated source. Keep failed attempts and do not reclassify historical822 as evidence for modified code.

## Selection rationale

The persistent metadata consumers and current retrieval already exist, but are disconnected. Connecting their consistency boundary is a smaller prerequisite with direct product behavior than adding ranking algorithms before a durable complete selection can be consumed. Capacity/cold-storage and AR1 quality protocols continue as separate research; no automatic historical GC is added.

Primary references consulted on this date: [SQLite isolation](https://www.sqlite.org/isolation.html), [Node24.16 DatabaseSync](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html), and [transactional outbox ordering/idempotency](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html). These motivate transaction/progress boundaries, not an exactly-once or production qualification claim.
