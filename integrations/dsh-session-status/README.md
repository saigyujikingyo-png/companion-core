# Exact-session native status action

Current acceptance: **CONTROL_PASS**. The user-visible result was baseline/paused=true/available=false/calls=0/32 for the exact owned SID, with commandId `cmd-8e0637d9-2`. Independent own safe audit recorded two command-status events with matching SID/state and all model/provider counts0. The audit carries no commandId, so no one-to-one pairing is inferred. Older pending statements below are historical. Chat composer binding, a first production model reply and permanent core memory are not accepted by this read-only control result.


This separate client-only package appends **Companion Core 状态** to the existing session-row menu. It addresses only the build-time owned SID and calls official `remote.commands.list` followed by `remote.commands.execute` for `/companion-status`. It never routes through the current composer and never falls back to an ordinary message.

The frontend is authored by actual Claude Opus; receipt and immutable original version are recorded. Sol only supplies mechanical SDK packaging and tests. Server entry is an empty apply. The existing opener/backend packages and core snapshot must not be changed by this deployment.

Current gate: PREPARED_NOT_INSTALLED. The initial1081b63e version failed independent review because unary RPC has no default deadline. The separately authorized actualOpus e23a15a7 correction provides a click-driven10s local deadline, preserve one raw unsettled operation across menu instances, and suppress late-list execution after timeout/unmount. No remote cancellation signal is allowed: backend invocation abort can pause core. Local timeout means unknown, not remote termination. No automatic retry.

SDK schema fixtures were validated by actual installed Electron/Zod without a host boot or model call. Targeted UI tests remain synthetic and do not prove live rendering or a native command receipt. User reported opening remains preserved; current control is not verified until the actual fixed-SID execute receipt is observed.

Current corrected source has14/14 targeted tests, including never-settling list/execute and timeout/unmount races. Independent narrow re-review is pending; no status bundle is installed yet. The original source is retained as src/client.initial.opus.js.

The timer-only e23a15a7 revision was rejected by an independent absolute-clock counterexample. Current actualOpus source34a9523b keeps performance.now absolute deadline and validates pre-invoke/post-await/pre-publish even if timers are delayed.18/18 targeted tests passed; final narrow review pending. Prior versions remain immutable evidence. This is not native command receipt acceptance.

Current deployment: official distinct client-only install c50d3486 succeeded22:52Z; same backend PID/birth/claim/snapshot retained. Native receipt is PENDING_USER_CLICK, not proven by installation. Choose Companion Core 状态 in an existing session-row menu; no chat input is needed.
