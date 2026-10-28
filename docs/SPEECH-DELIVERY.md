# AU0 / AU1 bounded speech delivery

This independent candidate implements a whole-utterance controller, closed immutable
SpeechPlan, replaceable backend, fixed Windows SAPI worker, and synthetic audio-input
rejection boundary. It has no connection to CoupledSession, runtime, stdin/DSH, Store,
authority, training, microphone or ASR. Production integration is
`PENDING_OWNER_INTEGRATION`; durable host claim/output lease/reconciliation are
`NOT_IMPLEMENTED` in this package. Native inventory, audible speech, device silence,
user intelligibility and naturalness need their own receipts. Synthetic tests cannot
accept those properties.

`SpeechController` defaults to business mode and refuses a synthetic authority.
The trusted Host must inject CurrentSpeechGate (literal synchronous `true` plus a
reliable invalidation subscription), SpeechClaimPort, SpeechOutputLeasePort and a
TechnicalReceiptSink. These are trusted code capabilities; declaring
`assurance: 'host-durable'` does not implement or authenticate an authority.
The Host remains responsible for current scope/source/purpose/permission/profile
checks and for durable, atomic claim consumption under the exact current output lease.
JSON alone never grants permission.

The stable effect key hashes the fixed host effect namespace and speech intent ID.
Utterance/turn, all bindings, ordered source refs, final text hash and byte count,
complete voice/device profile and budgets enter the canonical fingerprint. Same key
and fingerprint returns the local existing operation; a changed fingerprint conflicts.
The Host's permanent existing/UNKNOWN record prevents replay across controllers and
restarts. No code here repairs a consumed effect, refunds it, changes its namespace or
retries a speak command.

Output ownership is a separate prerequisite. The resource key covers the host and
exact output device, including different transport profiles on that device. The Host
lease must bind owner instance and monotonic fencing generation. Claim consumption
must atomically check that lease. Expiry, disconnection, local abort or a new process
does not free unresolved audio. The Host must persist UNKNOWN and block that resource
until an independent reconciliation accepts the old worker/output risk. A late old
owner must never release a newer lease. The RAM authority in the fixtures tests these
calls only; it is not crash-safe production infrastructure.

The controller allows one active operation and one queued operation globally, retains
up to 64 lifetime effect records, and emits one metadata-only terminal receipt per
effect (below the eight-receipt cap). Rejected native events retain a saturated count
and first error code. Text is limited to 240 UTF-8 bytes and stays in RAM; plans retain
only its hash/length. At most 16 sources, one final chunk, 5 seconds per utterance,
3 seconds startup, 500 ms stop wait and 1 second forced-exit wait are accepted.
Queueing never extends a deadline. Invalid clocks and asynchronous/reentrant gates
fail closed. Cancellation fences old callbacks immediately; raw worker occupancy is
released only after actual settlement. UNKNOWN permanently locks this controller.
Clean rebind fences old work and waits for its settlement and lease release.

Backend completion means the engine reported completion and its owned worker exited
cleanly. It never means the user heard the phrase or the physical device is silent.
The technical sink receives `eventClass: technical-delivery` metadata only after a
fresh gate check. It has no user ACK, feedback, engagement, appraisal, reward or Host
event API. A thrown/hanging sink has its own forwarding outcome and cannot block stop
or cause replay. Stale receipts remain bounded local forensic metadata.

`createLegacyMediaFacade` requires one prepared immutable intent. Its lossy `completed`,
`cancelled`, `failed` values retain detailed outcomes in the operation. In particular,
`failed` may mean UNKNOWN and must not trigger retry. `stop().acknowledged` means the
request was accepted/attempted; it does not assert silence. New callers should use
`stopDetailed` and operation snapshots. The first submitted signal owns the lifecycle.

Windows uses the fixed repository helper with the absolute Windows PowerShell
executable, `-NoProfile -NonInteractive -STA -File`, `shell:false` and `windowsHide:true`.
Exact voice/output tokens are selected and read back; missing profiles refuse without
fallback or installation. Text travels through bounded stdin JSON, with literal-text
SAPI flags (`Async | IsNotXML`), never command-line text, XML, filenames, logs or files.
The worker checks parent-process loss, EOF and its own watchdog, attempting purge and
exit; absent evidence remains UNKNOWN. Only the retained child-process object is
terminated. This backend is Windows-only and does not claim PCM/WAV synthesis,
chunk streaming, SSML, voice cloning or physical tail-silence observation.

The explicit verifier's default mode is static and opens no device:

```powershell
node --max-old-space-size=128 scripts/verify-windows-speech.ts
```

After code review, a separately allocated `--inventory` window can write bounded
metadata in native TEMP. `--audible-once --allocation <file> --profile <file>` requires
an exact profile, worker/profile hashes, Root run allocation, confirmed reconciliation
and absence of unresolved workers, plus an externally attached combined RSS monitor.
The allocation fixes 5000 ms maximum and stop 1000 ms after dispatch. These booleans
are trusted launcher assertions, not evidence generated by this CLI. The launcher
must actually monitor Node plus its worker at <=256 MiB, terminate only its own
processes when required, and retain the monitor receipt. The CLI checks fresh available
RAM >=1 GiB and native TEMP disk >=64 MiB. The fixed original phrase is not customizable.

A permanent create-new/fsync metadata guard under the single native-TEMP launcher
directory is consumed before any speech. Pending/UNKNOWN/completed guard files all
refuse another window, including a different run ID. Never delete or replace the guard
to retry. This is a synthetic experiment guard, not rollback-resistant authority.
The final engine receipt is written to a new file; the original claim remains.
No native inventory or speech is implied by the presence of this script.

The four speech test files cover C001 F01–F28 and C002 F29 with manual fake authority
and silent Node children. Run only the allocated synthetic tests under fresh resource
gates; do not infer whole-suite, cross-platform, device or business acceptance. The
SP06 input interface always refuses admission, including nominally host-verified
final candidates, until real Host source/policy integration exists. Its route remains
R01 → R04 → R05 → appraisal candidate → state admission → R03.

## Local validation (2026-10-28)

Candidate 005 passed 40/40 synthetic tests; the later clock-callback delta passed 26/26 controller tests and affected strict TypeScript. An independent complete-project TypeScript check exited 0, and the independent max review closed the remaining P2. These results belong to separate source snapshots and are not added together. Silent native inventory enumerated metadata successfully. The sole allocated synthetic speech window reported stopped_reported, worker exited, no forced termination, and technical forwarding stale. User audibility/quality, physical silence and precise dispatch-to-stop timing remain unverified. Host durable authority, reconciliation and production integration are not connected. The permanent one-shot guard is retained; no replay is authorized. CI for the published head is pending.
