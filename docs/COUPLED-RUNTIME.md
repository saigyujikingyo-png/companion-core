# Session-only coupled interaction prototype

`CoupledSession` connects selected user text, legal memory recall, engineered background state, a structured interaction provider and a local delivery receipt. It defaults to paused and quiet/unavailable. There is no personal database migration, global configuration, credential discovery, social-message transport, startup installation or model call in its constructor.

M2 encrypted persistence/revocation recovery is still absent. A resident development host must use a new in-memory `MemoryStore` and random session on every boot, keep personal text off disk, and disclose that process exit loses its memory/state. The session ID is required on submitted messages and receipts are scoped to the issuing session. This is session deduplication, not durable cross-restart exactly-once continuity. Old sessions/worker states cannot be restored or silently relabelled.

## Host entry points

```ts
const resources = new InteractionResources(new RequestBudget({ total: 8, hourly: 8, daily: 8 }));
const provider = new HttpInteractionProvider({ transport: 'cloud_https', endpoint, model }, resources, { apiKey });
const session = new CoupledSession(store, epoch, { provider, resources });
session.setHostContext({ quiet: false, available: true, ttlMs: 60_000 });
session.resume();
const receipt = await session.submit({ sessionId: session.sessionId, id: nativeId, selectedText, recallQuery });
const output = session.takeDelivery(receipt.deliveryId);
// Write to the authorized local sink. ACK only after that sink confirms delivery.
session.acknowledgeDelivery(output.deliveryId);
```

The values in the example are an explicitly finite test budget, not authorization to call a provider. The trusted host owns one `InteractionResources` and provider for its lifetime, including backend changes and new sessions. The budget counts actual `fetch` attempts immediately before send, has a non-resetting total and rolling one-hour/24-hour caps, and never retries/refunds failures. Paused/revoked calls do not imply a remote model stopped. Caller cancellation returns promptly while ignored raw requests and hung HTTP body cleanup retain their permit until settlement.

`setHostContext` requires a bounded availability lease from the real host; an internal loop must not manufacture availability merely because it is running. New requests and final delivery both require current availability. Expiry, quiet/availability changes, pause, reset and backend switching invalidate outstanding delivery reservations. Revoke/purge/consent controls remain available while paused. Every access validates the original frozen `RunTicket` before `read/search`; the runtime never obtains a new ticket to legitimize old state.

## Evidence, hypotheses and feedback

Each selected input is admitted once under its session and native ID. It publishes a literal original-language self-report episode as a source anchor; an observation of that source uses zero engineered salience increments. ID conflicts, concurrent duplicates, terminal failures and capacity overflow cannot launch a second provider call. Successful duplicates return the existing receipt. Ledgers are bounded and reject instead of evicting old identities; reset/backend switching retain ingress consumption.

The provider returns four separate fields: `version:1`, `responseText`, a bounded `appraisal-hypothesis`, and nullable `memoryProposal`. An appraisal may alter state, but is never actual user engagement. The optional memory proposal remains an **uncommitted candidate**, returned as `memoryCandidate`; `memoryRef` is null. This prototype only permits `claim`/`episode`, `self_report` and null validity endpoints; prompt/schema/validator agree. A coupled response has seen remembered facts and prior history, so a system prompt cannot establish that its memory proposal was extracted solely from the new text. There is no automatic publication of this candidate as self-report evidence. An optional rejected-response diagnostic reports only a fixed stage and allowlisted validation code, without text/hidden reasoning/exception details; consumer errors are contained.

The appraisal has a frozen 15-second maximum age. The interaction/delivery reservation has a separate deadline (default 30 seconds): a reply received after 15 seconds can still be delivered within its own window while its appraisal is dropped. `conditioningRefs` separates fresh triggering roots from already consumed recall/history roots. Fresh roots are consumed once; every conditioning dependency remains revocable and counts toward bounded source/root capacity. Appraisal failures consume fresh IDs/roots and are reported as `not-applied`, never silently retried.

Actual feedback is an explicit new subject self-report input carrying `feedback:{ deliveryId, outcome:'engaged'|'declined'|'neutral' }`. The referenced local receipt must have been taken and acknowledged; one delivered interaction accepts at most one feedback source. ACK itself changes no latent state. Taking a payload is one-shot; an ambiguous local delivery is not regenerated or re-sent automatically. The host must not synthesize an engaged feedback field from model text, a timer, an ACK or a guessed user emotion.

## Recall and proactive scheduling

Recall starts from `MemoryStore.search` results after authority validation. A deliberately simple English/Chinese keyword codec computes social/novelty/disengagement features and adjusts only the ordering of those legal candidates. Returned `RecallAudit` includes original and adjusted scores/ranks, references, basis and exact stored statements. It does not change stored facts, grant permissions, perform semantic retrieval or demonstrate better recall quality. Recalling repeatedly changes no reward/state.

`baseline` uses the engineered state prior. `no-state` applies zero score bias, passes `background:null` to the provider, and emits no proactive intent. `flywire` additionally applies a bounded experimental neural prior to legal ranking; source dependencies of its carried hidden state also follow the output. The prototype does not claim that the neural prior causes stronger biological motivation or that these backends are equivalent learned models.

`considerProactive(query)` consumes at most one valid shadow intent. A five-second shadow token must be accepted while its private seal is valid; accepting it creates one independent fixed-deadline operation. Heartbeat refresh and repeated validation do not extend that operation. Withdrawal suppresses engagement without another generated message. Proactive responses do not create appraisals or reward from the same recalled roots. The resulting outbox entry validates original run, local generation, context, all prompt dependencies and deadline immediately before `takeDelivery` and ACK.

Optional `startScheduler({recallQuery,refreshContext,onReady,onError})` arms one timeout at the next analytical state deadline or host-availability expiry. It refreshes trusted host context when fired and never replays ticks. In-flight raw operations prevent a past deadline from creating a busy loop. `stopScheduler` invalidates its generation, cancels its pending proactive operation and suppresses obsolete consumers/outbox entries; ordinary user requests have separate ownership. Consumer throws/rejected promises are contained. The default has no timer.

## Optional CPU graph worker

`JsonlPriorAdapter.start` accepts explicit absolute Python/worker/archive paths and expected SHA256s. The worker pins the three original neural source hashes and verifies the saved 3,136-node graph archive and structural digest; it does not reload the 15-million-row source table. It checks at least 1.5 GiB available host RAM before Torch import, again after imports, and before each step; uses CPU with two threads; never trains, downloads or writes runtime data. GPU is not selected by this worker.

The fixed prototype codec maps three engineered features onto ALPN indices modulo three, retains `h` across events with analytical idle decay, and calls the frozen `RateCircuit.advance` eight times per event. MBON groups produce bounded outputs. `condition:'no-circuit'` receives the same inputs/elapsed time and omits recurrent graph propagation. Neither channel names nor hidden-state values are biological affect labels. There is no inference from the previous training checkpoints and no biological-superiority claim.

The child blocks on JSONL input when idle. Ready/message bytes, IDs, steps, command count and deadlines are bounded; reset/stop are explicit. Cancellation/deadline terminates only the owned child, and the raw neural permit remains occupied until process close. A module-level ownership seal prevents reusing the same adapter in another session. First use and use following reset/cancellation require a confirmed clean worker reset under that permit. Revocation poisons the binding permanently; a fresh explicit worker is needed. Failed reset never permits a step. Backend switch ends paused and requires explicit resume.

The native bridge admits at most one resident child in its process. Its resident lease is released only by child `close`, so creating replacement adapters cannot accumulate idle workers. The host must close a retired/revoked worker before creating a new one, and close every started adapter in `finally`. `close()` returns separate cleanup and graceful-stop evidence: `closed`, `graceful`, `exitCode`, `signal`, `forced` and `residualBytes`. Only matching stopped ACK, full stdout close, exit zero, no forced termination and no residual output produce `graceful:true`. A clean reset is not process-stop evidence. Startup transfers listener ownership synchronously before detaching handshake listeners. Archive validation bounds exact ZIP members and total uncompressed array bytes in addition to checking the fixed archive hash.

## Verification boundary

`test/coupled-runtime.test.ts` covers history-dependent legal ordering, zero-bias ablation, structured appraisal, source-bound delivered feedback, idempotency, original run/conditioning revocation, exact 5/15-second boundaries, pause/raw-permit retention, reset/rebind/switch, rolling request caps and scheduler cancellation/consumer failure. `test/jsonl-prior.test.ts` runs an actual synthetic Node child to check JSONL ready/step/reset/stop, malformed/oversized/hung output and cancellation through child close. These fixtures make zero real model calls and do not qualify the physical Python graph runtime. Real DeepSeek, physical CPU worker and resident host acceptance belong to separate Root-run evidence. No test here proves human-level emotion, long-term reliability or personal persistence.
