# Trusted-parent resident stdio entrypoint

`node src/coupled-stdio.ts` runs the session-only core behind a private JSONL stdin/stdout connection owned by its parent process. It opens no socket or named pipe, reads no credentials/configuration/chat files, writes no database or logs, and changes no DSH configuration. This is a shared backend entrypoint, not a GUI or a completed DSH integration.

The process creates a new `MemoryStore(':memory:')` and random session on boot. It starts paused and quiet/unavailable, with no scheduler, worker or model request. M2 encrypted persistence is still absent: process exit loses its memory/state, and there is no replay, automatic reboot, automatic rebind, cross-restart deduplication or budget restoration.

## Zero-call boot

The first complete line must be a boot command. Each input line has an `id` of at most 128 characters and a `command`. Optional `version` must equal 1. Responses contain `{version:1,id,ok:true,result}` or `{version:1,id,ok:false,error:{code}}`; errors are allowlisted codes without raw exception details. Command IDs for stateful operations are consumed once in a bounded ledger.

```json
{"id":"boot-1","command":"boot","maxCalls":0}
{"id":"status-1","command":"status"}
```

`maxCalls` defaults to zero and is fixed for this process, from 0 through 32. **Zero mode requires no API key and constructs no HTTP provider.** `submit` fails with `BUDGET_DISABLED` even after resume/context. No later command can increase the budget. This is the mode for a paused resident process after the separate real-call acceptance budget has been consumed.

Positive-budget boot requires an in-memory `apiKey` supplied only in that first stdin line by an explicitly authorized trusted launcher; optional `model` defaults to `deepseek-flash`. The endpoint is fixed to the official DeepSeek chat/completions endpoint. The key is never echoed or read from environment/files by this entrypoint. The process total is `maxCalls`, rolling hourly cap is `min(8,maxCalls)`, and rolling daily cap is `maxCalls`. HTTP attempts are charged by the existing provider immediately before fetch, without retries/refunds. A new authorized process is required for any later budget; this entrypoint never replenishes its own allowance.

## Commands

The boot response returns `sessionId`. Except `status`, `pause` and `stop`, every subsequent command below includes that exact `sessionId`. Old boot/session IDs cannot address a new process.

| Command | Additional fields | Result/behavior |
|---|---|---|
| `status` | none | Sanitized status, request counts, local concurrency/worker flags; no text, keys or paths |
| `pause` | none | Immediately cancels local output, including while submit/switch is awaiting a provider |
| `resume` | `sessionId` | Explicitly resumes; does not grant availability or auto-ACK anything |
| `context` | `sessionId`, `quiet`, `available`, `ttlMs` | Trusted parent availability lease, `1..30000` ms |
| `submit` | `sessionId`, `messageId`, `selectedText`; optional `recallQuery`, `feedback` | One native user message; returns only delivery/request metadata and appraisal status |
| `take` | `sessionId`, `deliveryId` | One-shot local payload consumption; this is the only command that returns response text and recall statements |
| `ack` | `sessionId`, `deliveryId` | Parent confirms actual delivery after a successful `take`; ACK is not engagement |
| `reset` | `sessionId` | Clears state influence while retaining consumed message identities |
| `revoke` | `sessionId`, `ref:{id,revision}` | Revokes a source, invalidates the current binding and closes its worker |
| `purge` | `sessionId` | Clears the scope, invalidates the binding and closes its worker |
| `switch` | `sessionId`, `backend:'baseline'|'no-state'|'flywire'` | One management operation at a time; finishes paused |
| `stop` | none | Stops admission, pauses/cancels locally, closes owned worker/store, flushes terminal response and exits |

`feedback` is exactly `{deliveryId,outcome:'engaged'|'declined'|'neutral'}` and accompanies a new explicit user self-report in `selectedText`. It must reference an already taken/acknowledged delivery. The host must not manufacture feedback from an ACK, elapsed time or model-generated text. Repeating the same `messageId` with a fresh command ID returns the existing receipt; changed content conflicts. The command ledger, memory ledger and provider budget are independent bounds.

`submit` does not block the reader: `status`, `pause`, `stop` and source-control commands remain serviceable during inference. Only one submit and one management operation can be in flight. Concurrent management/resume attempts fail closed; there is no queued series of worker starts or provider retries.

## Optional proactive scheduling

`context` may additionally contain `recallQuery:"..."` to enable the existing one-shot scheduler, or `recallQuery:null` to stop it. Omitting the field preserves the current scheduler setting. The parent must derive `available` from actual current host/user context; a resident process alone is not proof of availability.

The scheduler's refresh callback only reads the parent's still-valid lease and remaining duration. It does not renew that lease internally. Expired availability prevents proactive work until a new explicit context command arrives. A proactive completion emits only `{version:1,event:'delivery-ready',sessionId,deliveryId}`. The parent must explicitly take the payload and separately ACK actual delivery. There is no automatic local display, social delivery, reward or positive feedback.

## Optional CPU worker ownership

Boot may include `neuralConfig` with the explicit fields accepted by `JsonlPriorAdapter`: absolute `pythonPath`, `workerPath`, `graphPath`, the three expected SHA256s, and optional condition/deadlines. Boot only retains this trusted configuration in memory; the worker is launched only by `switch` to `flywire`.

Switching away first detaches/reset-fences the old core binding, closes the old worker, and checks its complete close result before creating a replacement. At most one worker can be resident, with at most 16 explicit starts in the host process. Startup itself belongs to the management operation: EOF/stop during startup waits for the late adapter, closes it, and only then finishes cleanup. A failed/aborted worker that cannot satisfy the frozen core reset contract can leave the session paused and require a fresh explicit process; the entrypoint reports failure rather than silently rebinding old state.

Worker close results include `closed`, `graceful`, `exitCode`, `signal`, `forced` and `residualBytes`. Non-graceful close is retained as partial evidence and cannot pass as clean shutdown. No physical CPU/GPU compatibility claim follows from protocol fixtures; see the separately accepted native worker evidence.

## Shutdown and bounds

EOF, either pipe closing without an end/error event, malformed/truncated initial input, oversized input, stdout failure/backpressure and explicit stop all stop new work and trigger cleanup. EOF is treated as loss of the trusted parent. A consumer close during cleanup is recorded as partial; a close after completed shutdown does not change its result. Input lines are capped at 32 KiB, input buffer at 128 KiB, pending output at 256 KiB, and the stateful command ledger at 4,096 IDs. Stop/pause/status and revocation controls remain available at ledger capacity. Output flush waits at most one second.

The final `stopped` event and explicit stop response distinguish `closed` from `partial` and expose remaining raw call/transport/neural permits plus each worker close result. The exported `runTrustedStdio` result also records whether output flush completed. A locally cancelled HTTP operation may still occupy its raw permit; that produces partial shutdown evidence and never a claim that the remote model acknowledged cancellation. The CLI exits only after its local store/owned-worker cleanup; it uses exit code 0 for closed and 1 for partial.

`test/coupled-stdio.test.ts` uses only synthetic in-memory providers/worker fixtures, plus an actual zero-key/zero-call Node CLI roundtrip. It checks zero-budget enforcement, text/secret non-echo, explicit delivery/ACK, duplicate messages, concurrent pause/status, heartbeat expiry, EOF cancellation, late startup harvest, partial worker close, paused purge, input bounds and output backpressure. It does not send real model requests or change any real host configuration.
