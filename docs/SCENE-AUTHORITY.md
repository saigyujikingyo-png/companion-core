# SP0A / AR0b0: current sources and bounded RAM consumers

Status: **AUTHOR_FOCUSED_PASS / INDEPENDENT_REVIEW_PENDING**, 2026-10-26. Root froze this slice before implementation. All validation uses synthetic sources; deployment, semantic quality and durable fanout are not accepted by this document.

## Frozen contract

- Scene logical v1 retains its positive epoch rules and exact exchange bytes. Explicit logical v2 uses nonnegative Store epochs; catalog, packet and manifest must agree. Container, codec and canonicalization profiles stay v1. Database schema 1, its layout hash and M2 format do not change.
- `MemoryStore.sceneSourceSnapshot(epoch, publishedRefs)` checks the whole published-memory pool and ancestor DAG in one read-only current transaction. Limits: 32 selections, 128 nodes, 512 edges and 262144 charged UTF-8 bytes. Return only current authority, asOf, selected refs/root mappings and root event mode/time/role metadata. Never return statement, selectedText, body or speakerId; no learning grant, scope creation, persistence or outbox ACK.
- `SceneAuthorityService` binds a fixed v2 catalog to actual Store sources. Every declared source, including unused entries and profile lineage, must match an authorized event root, current scope/epoch and actual origin. Observation stays observation; self-report/quotation map to report while retaining their original mode. Inference is never upgraded to observation/report. Claims remain declarations, not verified facts.
- Opaque binding, consumer and frame handles are local to one service. Every data operation checks the whole source pool, current authority/runtime epoch, metadata identity, monotone wall clock and packet applicability. Actual authority/source/time failure permanently ends that data capability and clears payloads/frames. JSON import/export confers no capability.
- Each binding retains only its current packet; canonical duplicates are idempotent. Packet identity is fixed after first stage; revisions increase, same revision with different content conflicts, older revisions reject. Deduplication is only within this binding's lifetime.
- At most eight consumers per binding; each has one pending frame and one last ACK. Registration begins with a body-free reset barrier. Pull returns an opaque frame and metadata; replace resolve freshly validates before returning a full baseline. Repeated pull returns the same pending token. A new stage invalidates old replace frames. ACK reports trusted local application; it does not prove durable external application or exactly-once effects.
- Pause is this service's trusted local control, not a DSH/CoupledRuntime hook. It clears payload and delivery frames and requires a new reset. Resume freshly checks sources and restores staging only. Terminated, paused or unbound control handles can finish body-free reset cleanup; they cannot return old data. Already returned copies cannot be physically recalled.
- M2 restores sources only. A new service requires new binding/consumer/reset ACK and explicit restaging of separately supplied synthetic JSON. Old handles cannot cross restart. Scene packets and consumer state are not persisted.

## Validation and acceptance

Author focused validation passed **226/226 tests, zero failures/skips**, strict TypeScript and `SCENE_AUTHORITY_PASS` demo. This comprises 54 new source/service/restart cases, 33 existing scene/parser cases and 139 existing retrieval/curation/Store cases. A separate read-only review, Sol's subsequent single whole check and release/CI remain pending; these layers must not be added together. [The durable follow-up](ADR-AR0B-DURABLE.md) requires its own numbered migration and crash/recovery gates.

Initial missing-snapshot/v2 RED evidence, an intermediate fixture comparison failure, four first service-fixture failures and the corresponding TypeScript diagnostics are retained in excluded author logs. The fixture failures were corrected by using valid source-specific proposal bases, separating the publishing helper from a memory ref and comparing ref-only fields. Final focused logs reflect the tested source; earlier failures are not rewritten as success. The unchanged v1 fixture's 6305-byte exchange and SHA-256 were captured from baseline `17d4adc` before the implementation and are now fixed assertions.

## Implemented API

```ts
const service = new SceneAuthorityService(store);
const binding = service.bind({epoch, publishedRefs, catalogJson}); // explicit logical v2 catalog
const consumer = service.register(binding);
const reset = service.pull(binding, consumer); // metadata + opaque frame, no body
service.acknowledge(binding, consumer, reset.frame); // trusted caller says reset was applied
service.stage(binding, packetJson);
const offered = service.pull(binding, consumer);
const current = service.resolve(binding, consumer, offered.frame); // fresh Store gate
// After any await, resolve again immediately before external use.
service.acknowledge(binding, consumer, offered.frame);
```

The example omits nullable `pull` checks and consumer application code. `pull` returns null after the current revision is ACKed or when active with no packet; both paths still validate the current source pool. `read(binding)` directly returns a current authorized view without a consumer. `export(binding)` freshly validates then returns the ordinary declaration envelope. `import(binding, exchangeJson)` validates the fixed catalog/integrity and performs the same fresh staging checks; it does not restore a serialized binding.

`resolve` of a replace frame returns `{info,data}`; a reset returns only `{info}`. Metadata is `{operation,barrier,revision}`. Reset revision is always zero; replace revision is the binding's content revision, independent of the caller's positive packet revision. Repeated pending pulls return the identical opaque frame; cloned, foreign-service, foreign-binding and cross-consumer handles reject. A replace frame can be resolved only while pending. Only the last ACK is retained for duplicate ACKs; an ACK does not create ongoing data permission. Stage invalidates pending/last-ACK replace tokens but preserves pending reset tokens. Slow consumers receive the latest complete packet, not an event log of intermediate versions.

`pause` clears the current payload and delivery frames, and creates a new reset barrier when a packet has been staged since the last clear. Repeated pause, paused-to-unbound and terminated-to-unbound transitions without intervening staging do not advance that barrier or replace outstanding reset tokens. A completed reset ACK remains idempotent. `resume` checks current sources and only restores staging permission. A deliberate identical restage after pause is permitted under the new barrier: `{duplicate:true}` means duplicate canonical content, not that explicit restaging was ignored. It restores the payload with new replace tokens without incrementing the content revision. The previous packet id/revision/digest high-water record prevents conflicting or older content from replacing it. This is bounded local deduplication, not durable idempotency.

If an already-current packet expires, the next data operation terminates the binding before accepting a newer stage. Source failures, metadata changes, runtime changes and clock rollback also terminate it. New candidate JSON/format/time errors reject that candidate without corrupting a still-current payload. After termination, resume fails and a new trusted binding is required. Paused/terminated/unbound handles may only finish body-free reset cleanup; they cannot read or restore the old payload. `unbind` deliberately leaves these limited control handles available for cleanup.

## What the authority label means

The Store is an internal trusted-local authority, not a public authentication API. The host must authenticate its caller and choose the allowed published-memory pool before `bind`. This service checks current scope generation/consent revision/runtime epoch and current sources; it does not invent a new `readAllowed` permission or modify learning consent. `learningAllowed:false` can coexist with authorized ordinary reading. It grants no learning, upload, training, media or external-send permission.

All fixed catalog declarations are checked, including unused declarations and every profile-lineage source. Every referenced catalog source must be one of the actual event roots of the selected published memories. The entire selected pool and DAG are rechecked even when a root is absent from the catalog or packet. Event inference roots may exist in that pool, but cannot be declared as observation/report sources. The returned metadata preserves `self_report` versus `quotation`, speaker role and nullable occurrence time; it never returns the historical speaker identity or source text. Historical node consent revisions do not replace current scope authority.

`CURRENT_STORE_SOURCE_BOUND` describes this current source/permission check. The nested Scene view remains `NOT_AUTHENTICATED`, and claim assurance is `NOT_VERIFIED`: semantic entailment, real-world identity, independently verified observation, profile asset existence, decoder availability and human emotion are not established. The metadata identity fingerprint covers bounded ancestor metadata, edges and origin fields; it is not a hash of source plaintext and is not returned by consumer metadata reports.

The service keeps one current packet and no history. Frame maps hold only client and scalar frame metadata, never old packet snapshots. A caller retaining a stale opaque frame cannot use it to recover old data. Returned packet copies and exported JSON cannot be physically recalled. Callers must apply cleanup to their own cached copies and freshly resolve again before use after an asynchronous gap.

## Source recovery and execution boundaries

The synthetic M2 test creates a fresh encrypted vault in the operating-system temporary directory, closes/reopens it twice, and explicitly supplies separately held synthetic JSON. A new service/binding/consumer must ACK a reset and restage the packet. The test consumes the old global outbox beforehand, checks unchanged DB image/persistence sequence during data operations, then revokes a source and confirms another reopen cannot reauthorize its old export. Another still-current source can bind normally. This establishes source recovery and explicit RAM rebuild, not automatic scene or consumer-state recovery.

Implementation: [bounded Store snapshot](../src/store.ts), [service](../src/scene-authority.ts), [types and limits](../src/scene-authority-types.ts). Tests cover [snapshot and v1/v2 compatibility](../test/scene-authority-snapshot.test.ts), [service/consumer lifecycle](../test/scene-authority.test.ts) and [two M2 reopens](../test/scene-authority-restart.test.ts). `npm run demo:scene-authority` runs a new RAM Store and prints only fixed status, counts and assurance labels, with zero model calls and no production data.

This slice does not connect DSH pause, a host/network route, persistent dispatcher, external consumer, automatic timer, perception, model, training, real user data or deployment. [Scene v1](SCENE-PACKET.md), [AR0 retrieval](AR0-RETRIEVAL.md) and [M2 format](M2-DURABLE.md) keep their existing separate boundaries.
