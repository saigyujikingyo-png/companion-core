# CPU background-state shadow experiment

`src/background-state.ts` is a trusted in-process experiment: continuous non-language state influences attention priors and competition between affiliation and withdrawal. The resulting object is a **shadow intent**, never an actual message, model request, or statement about the user's feelings. The module owns no timer, provider, GPU context, database schema, or persistent personal-state file.

This implements a narrow engineering question: can different valid interaction histories lead to different motivation under identical present input and context, while idle computation stays event driven? It does not establish subjective experience, biological emotion, or better interaction quality. The existing female FlyWire mushroom-body ALPN/KC/MBON/DAN/APL experiment is not a male-fly P1/pCd circuit. This layer borrows the general ideas of persistence and context gating, and does not reproduce either circuit. Future ODE, SSM, CfC, or real-connectome variants should be compared behind the same authority and shadow-output boundary; none is silently substituted here.

## State and idle dynamics

Six bounded values are maintained: affiliative tone in `[-1,1]`, activation, uncertainty and fatigue in `[0,1]`, plus affiliation and withdrawal drives in `[0,1]`. They are engineered internal priors, not observations of a person's emotional state. Activation/uncertainty decay toward neutral with a 20-second time constant; tone/fatigue use 300 seconds.

At an admitted event, bounded drive targets are derived from the latent state. Between events, each drive follows `target + (previous - target)*exp(-elapsed/60000)`. The target is piecewise constant for at most five minutes, then switches analytically to neutral targets. A long sleep is handled in at most two exponential intervals; no missed tick is replayed. The TTL prevents one positive or negative event from establishing permanent social or withdrawal drive. It is an explicit engineering approximation, not a learned dynamical law.

Affiliation can therefore accumulate during a period with no new input. `nextWakeAt` predicts the earliest relevant monotonic threshold/cooldown crossing. A future host may arm at most one one-shot check, re-read actual context and revalidate authority when it fires, and then use the newly returned deadline. Quiet, unavailable, paused and no-state conditions return `null`, including when a previous deadline is already past. The module itself never schedules this timer. `read()` frequency does not define the trajectory.

Two motives compete at threshold 0.60. A selected motive remains latched until its drive falls to 0.35, and a shared 120-second cooldown prevents adjacent intents. Issuing an intent changes scheduling state only; it is not treated as successful interaction or rewarded by a positive state update. Resume emits no intent automatically. A host may make one fresh `consider()` decision after resume, and must not replay a queue of missed decisions.

## Entry contract

```ts
const background = new BackgroundState(store, trustedEpoch);
background.setContext({ quiet: false, available: true }); // defaults are quiet/unavailable
background.observe({ id: nativeEventId, refs: publishedMemoryRefs,
  novelty: 0.2, socialRelevance: 0.3, demand: 0.1 });
const decision = background.consider();
if (decision.intent) background.validateIntent(decision.intent); // immediately before a consumer uses it
```

`observe` accepts bounded structured salience inputs grounded in published memories. `appraise` takes an explicit caller-supplied asynchronous evaluator and returns only a bounded hypothesis contribution. Its response is tagged `appraisal-hypothesis`, with confidence and signed numeric appraisal values. The module does not call an LLM on its own. Real provider use requires a separately authorized host/runtime invocation; background state is not standing authorization for online or long-term operation.

Appraisal context is checked before invocation. The request freezes its source revisions, local generation, state revision, context revision, and a 15-second maximum age. All are checked again before applying a result. A result that arrives an hour later is rejected even if nothing else happened. No default timeout timer is installed: age is checked at invocation/completion, and explicit reset/pause/context change can locally cancel a waiter. A provider that ignores abort continues to occupy the sole underlying-evaluation permit until its raw promise settles. Cancellation is not evidence that an external model has stopped.

`recordOutcome` is separate from appraisal. In this minimum slice it accepts only **published subject self-report** sources: `MemoryStore` already checks their raw-event ancestry. It rejects inference and observation-only memories, because an assistant's own output can have an observation basis. The payload's `origin` string alone never proves external provenance. Sensor/other external-observation admission awaits a proper host provenance API. Calling `consider`, producing text elsewhere, or obtaining a favorable appraisal never automatically records an engaged outcome.

`pause`, `resume`, and `reset` are explicit. Pause rejects new events and cancels local appraisal waiters; real elapsed time still contributes to analytical decay. Reset clears influence and increments the local generation, but keeps consumed identities for the binding, so replaying an old event after reset cannot reapply it. An explicit newly constructed binding is required after authority invalidation; no automatic rebind/replay is provided.

## Authority, provenance, and bounded replay protection

The instance freezes `MemoryStore.beginRun` at binding. Every event/read/decision/intent-validation boundary first validates that original ticket, then obtains and validates a current ticket. It never relabels old state with a new runtime epoch. Every retained published source is checked with `store.read`, including its temporal and ancestor validity. New source admission also uses the new read-only `publishedEventSources` API, which checks visible published memories and their ancestry in one read transaction and returns only deduplicated original event IDs/revisions, without source text. The schema and previous storage behavior are unchanged.

Per-channel observation, appraisal and outcome consumption is keyed by those original events, not merely by leaf memory IDs. Publishing the same interaction twice, or deriving another memory from it, cannot produce another reward or hypothesis under a different event ID. Overlapping source sets are also rejected. A root event can inform the three explicitly distinct channels at most once each; this fixed engineering combination is not evidence that independent observations occurred.

The in-memory ledger defaults to 256 event IDs, 128 active published references, and 128 retained root identities. Input batches contain at most eight published references. Limits reject new work; no key is silently evicted or reset to make old input replayable. Failed/cancelled appraisal IDs and their root identities remain consumed. Keys and roots survive local reset. Reaching a limit requires an explicit new binding/host decision, not automatic rollover. This is a session ledger, not durable cross-process exactly-once delivery.

Any scope/purge/consent/runtime mismatch, expired/revoked source, or invalid/backward monotonic clock conservatively clears the entire instance and requires a new binding. This also invalidates all earlier shadow tokens and rejects late async commits. Unrelated source revocation in the same scope also changes the runtime epoch and invalidates the binding; selective recomputation is deferred.

Shadow tokens are accepted only by the issuing instance, retain private identity seals, expire after five seconds, and are invalidated by new state events, context changes, reset or pause. A copied/JSON-reconstructed token is invalid. Previously returned diagnostics are historical data, not a continuously valid permission; a consumer must call `validateIntent` immediately before using a token. No actual delivery path is implemented.

The clock must be finite, monotonic elapsed time. Hosts should supply a clock whose elapsed time advances through suspend if that behavior is required on their platform; the tests use an injected logical clock. Physical suspend and power behavior are separate host validations.

`snapshot()` produces a diagnostic object explicitly marked non-restorable and not a learning checkpoint. `restore()` rejects both an original snapshot and serialized input. There is no personal-state persistence or recovery path before M2 encryption and revocation-ledger recovery are accepted. The synthetic probe may write diagnostic artifacts; this does not authorize personal-state logging.

## Offline validation and optional measurement harness

```powershell
npm run typecheck
node --test test/background-state.test.ts
node scripts/background-state-probe.ts
```

The default probe creates a new synthetic SQLite database and source snapshot in system TEMP, runs logical-time counterfactual/no-state, quiet/cooldown, reset/late-appraisal, revoke, sleep and long-idle demonstrations, writes a new result, and exits. It neither imports PyTorch nor runs a real API/Codex call, sends messages, modifies power settings, or installs a service.

The separate bounded harness is available only through an explicit positive duration:

```powershell
node scripts/background-state-probe.ts --mode event --duration-seconds 120 --readiness
node scripts/background-state-probe.ts --mode tick --duration-seconds 120 --readiness
```

`event` uses at most one deadline timer plus the common experiment-stop timer. `tick` explicitly polls at 10 Hz as a comparison condition. `--readiness` emits a JSON ready record after preparation, followed by a complete record and `result.json`. The result reports process CPU time, elapsed wall time, RSS and **scheduler activations**, not hardware wakeups, electrical energy, or battery life. Setup and final artifact serialization are outside the measured interval. Timing these callbacks does not establish system-wide power savings. No positive-duration comparison is automatically launched by the test suite or by the module.

Acceptance remains a shadow-layer correctness result. Natural interaction quality, a production host one-shot scheduler, physical suspend, personal persistence, more complete external-outcome provenance, learned dynamics and measured system energy remain separate work.
