# Observed presence and explicit companionship permission

This is a source implementation with synthetic verification. Native SDK control acceptance, natural model triggering and production deployment remain separate and pending for this source. It neither changes the earlier natural `NO_TRIGGER` result nor lowers background thresholds to obtain a trigger.

## Independent authority

`available` means the trusted host has an unexpired observation of human presence. `available:false` means no such unexpired trusted signal exists; it does not prove that the user left or is absent. A true explicit window is communication permission and supplies no evidence of physical presence. DSH observes an actual native human input and retains its original arrival deadline, at most 30 seconds. Processing, model output, a timer, prepared notification and ACK cannot extend it. Quiet is a separate user/host restriction; the ordinary expiry of observed presence does not set quiet to true.

An explicit companion window grants permission to initiate communication for a finite interval. It does **not** assert that the user is present, listening, reading, engaged or consenting to learning. `BackgroundState.context.available` remains observed presence; `context.proactiveAllowed` separately reports the effective proactive gate. Changing this permission does not observe a source, appraise text, retarget drives, consume pending feedback, reward the system or create memory. Analytical state evolution with elapsed time continues independently.

Effective proactive authority is the OR of an unexpired observed-presence lease and an unexpired explicit window, subject to pause, quiet and explicit suppression. A one-second window therefore does not shorten an existing 30-second observed-presence lease. The default 180-second window normally outlasts that lease. Expiration of one source is not an assertion that the other source expired. `off` is stronger: it revokes the explicit window, cancels all existing proactive work and suppresses reuse of the old observed lease until a fresh human ACK or a new explicit grant. It preserves an ordinary foreground operation; a human ACK already in flight across `off` cannot rearm scheduling.

All permissions are runtime-only, use monotonic absolute expiry and reset on process restart. Pause, quiet, reset, revoke, purge, backend switch and disposal destroy the window. Resume supplies no new window. Fresh human input preempts old proactive work and stops scheduling; it does not extend the original explicit window. Only the latest successfully acknowledged human input can supply the next recall query.

## Trusted commands

The official DSH agent-scoped command is:

```text
/companion-window             # 180 seconds
/companion-window 60          # integer seconds, 1 through 300
/companion-window off
```

It requires the exact owned agent, the official invocation's `commandId`, a non-aborted invocation and no attachments, and uses `recordInput:false`. Ordinary chat containing identical text has no control authority. It never resumes automatically. Disabled proactive configuration, quiet/paused state, fresh human work, an unsettled native ACK, active prepared turn, or core raw work refuses a grant; no request is queued to grant later. A grant requires a successfully completed actual human delivery ACK. The grant command creates no provider request; the separately armed scheduler may subsequently consume an independently valid background intent within its permission and budget.

Same `commandId`/grant ID cannot grant twice, including after expiry or revocation. Any grant while a window is still active is refused with `COMPANION_WINDOW_ACTIVE`, including a new official execute ID. To open another window, explicitly use `off`, wait for settlement, then issue a new grant. Thus a repeated execute cannot silently extend an active window. Current installed SDK `commands.execute` generates a new `commandId` for each execute; its public wire supplies no stable client request nonce. This implementation does not claim deduplication across independent execute calls after the prior window expired. A future client nonce contract would be needed for that stronger guarantee. Native human message/RPC idempotency remains separate.

The private parent-owned stdio command is:

```json
{"id":"control-1","command":"companion-window","sessionId":"current-token","grantId":"trusted-command-id","durationMs":180000,"source":"trusted-stdio"}
{"id":"control-2","command":"schedule","sessionId":"current-token","recallQuery":"host-placeholder"}
{"id":"control-off","command":"companion-window","sessionId":"current-token","durationMs":0}
```

`durationMs` for a grant is an integer multiple of 1000 from 1000 through 300000. `source` is exactly `trusted-stdio` or `dsh-command`; it describes provenance, not authentication. The private inherited pipe and authenticated owning host are the trust boundary. The core chooses the last successfully acknowledged human query when a window is active, ignoring the scheduler placeholder/command text. Grant and scheduling are separate so DSH can install its own fixed permission before scheduling starts. Off is idempotent and remains admitted when the command identity ledger is full. The grant ledger has 128 IDs per runtime and fails closed without eviction.

Boot requires explicit `enableProactive:true` for this new window feature; omitted/false refuses grants with `PROACTIVE_DISABLED`. Core/stdio `companionWindowEnabled` names that feature flag. For compatibility it does not remove the existing trusted `context`/`schedule` API. The DSH top-level `enableProactive` still controls **all** native proactive publication and defaults false. The host injects only that top-level value into its backend; a launcher config cannot independently enable it.

The backend forwards `--enable-proactive` to the resident launcher only when true. A window-enabled resident configuration must explicitly select the separately versioned `run-coupled-durable-resident-window-v1.py`, which adds `enableProactive:true` to boot JSON. Existing launchers and frozen production sources are not modified; default false passes no new CLI argument. Selecting an old launcher with the new true flag is a compatibility error, not permission to bypass boot policy. Synthetic child mode forwards the boolean directly and never constructs an HTTP provider.

## Deadlines and concurrency

Foreground admission, provider work and delivery retain the original human arrival/context deadline and never benefit from a window. Every proactive operation captures its original permission source/ID, generation and `min(start + 30000 ms, selected authority expiry)`. A shorter configured operation timeout still applies. A five-second intent seal, a 15-second appraisal age limit, the operation deadline and the outer companionship window remain distinct. Granting a new window cannot reauthorize an old prepared result.

Ready metadata includes `{permissionId,remainingMs}`. `permissionId:null` denotes the original observed lease. New window notifications must match the bridge's current window ID. Before retaining an offer, DSH makes a read-only `prepared-check` request. It anchors the returned remaining duration to the bridge time **before sending that request**, then caps it by the original local authority expiry. Anchoring to receipt would incorrectly add transport delay. Monotonic timestamps from different processes are not compared directly. Missing metadata is supported only for legacy notifications within the original short human lease.

The resulting fixed offer deadline follows the result through the ready queue, SDK `whenIdle()`, maintenance, attach, native streaming and ACK. Every await and attach rechecks generation, expiry and revocation. A late SDK idle promise or delayed `prepared-check` response cannot extend or revive it. Off/pause during a grant uses ordered revocation on the same private command stream plus version checks: cancelling a host Promise does not mean an already-written backend command was cancelled. A new grant cannot overtake an unsettled earlier grant. No late grant response starts scheduling after off, pause or a newer human input.

## Safe status and validation

DSH status displays permission source and remaining milliseconds separately from `available`. Inspect includes:

```text
available                                  observed presence
background.context.available               observed presence
background.context.proactiveAllowed         effective proactive gate
companionWindow.active
companionWindow.source                      dsh-command | trusted-stdio | null
companionWindow.remainingMs
companionWindow.expiresAtMonotonicMs         local runtime clock, or null
companionWindow.generation                  local authorization generation, or null
```

No command text, new feedback, claim of presence or reward is included. Expired/off metadata reports inactive, null source/expiry/generation and zero remaining duration.

Synthetic tests exercise original 30-second behavior, explicit enable/ACK admission, replay/active-window refusal, source separation, pause/quiet/reset/revoke/switch/restart, grant/off/ACK races, old prepared output and delayed check/SDK results, fresh human preemption, and foreground raw settlement. The real `BackgroundState` implementation also receives five fixed synthetic positive appraisals at 0/20/40/60/80 seconds, confidence 0.4: unchanged dynamics cross at approximately 119.579 seconds, after observed presence expires at 110 seconds. An independent 180-second grant at 80 seconds permits the synthetic scheduler at that crossing without changing latent values, targets or the source ledger at grant time. This is a deterministic clock test, not a replay of the real model's appraisals or new natural elapsed-time/model acceptance.
