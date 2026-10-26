# M2a encrypted local restart boundary

**Current evidence, 2026-10-26:** source freeze
`25cb0f8c6073dc91167c2507d9444a5500b560a7` passed strict TypeScript,
241/241 synthetic tests and the seven-step replay, plus eight independent
Astra max focused checks. The 241 include the explicitly known-negative
`KNOWN_UNPROTECTED_LEDGER_ROLLBACK` fixture, not a protective PASS.
The repaired source passed a separate native run with no API credentials loaded
and zero model calls; its vault still uses an independent memory key. It had
clean inner/outer exit and no remaining owned process; see
[修复后零请求摘要](evidence/NATIVE-ACCEPTANCE.md#m2-repaired-three-call).
The original real cohort retains four ACKs and a failed second restore after
revocation, with E unsent. A repaired independent three-request vault passed
[修复后三请求摘要](evidence/NATIVE-ACCEPTANCE.md#m2-repaired-three-call):
three real native ACKs/appraisals, two paused restores preserving consumed quota,
B recalling A and C excluding revoked A event/memory refs from recall,
conditioning and background state. Three inner/outer exits were clean with no
force, remaining owned process or undrained output. A retained
`lastErrorCode:UNCLASSIFIED` on one exit is not presented as an error-free run.
Old four plus new three consume seven of aggregate8; no refund or retry occurred.
It does not complete the original vault's A→E chain. The bounded personal-trial
desktop deployment is
[PASS_M2_DESKTOP_RESIDENT_READY_UI_CONTROL_PENDING](evidence/NATIVE-ACCEPTANCE.md#m2-desktop):
bootstrap create+flush then clean unload, followed by native resume-only READY
with the same vault/identity, baseline, paused/unavailable and 0/32 calls.
Old/bootstrap children exited and the DSH main process was not restarted.
No production prompt was sent. New menu-click/composer binding remains pending;
old UI receipts do not qualify this SID. Direct `inspect.restored` was not
collected and a complete desktop restart was not tested. Open the new dedicated
session and explicitly `/companion-resume`; resume itself grants no presence
lease. The M2+flywire native combination is untested in this batch. This release
still depends on fixed external launcher/config scripts; see
[deployment and usage](evidence/NATIVE-ACCEPTANCE.md#m2-desktop),
[current validation](VALIDATION.md) and the
[coordinator record](evidence/NATIVE-ACCEPTANCE.md#m2-repaired-three-call).

This bounded opt-in slice preserves selected sources, derived memories/FTS,
revocations, ingress deduplication and consumed quota on the same machine. It is
not ten years of operational evidence, a backup product, old-database migration,
multi-device key recovery, training or evidence of subjective emotion. The old
deployed RAM snapshot remains a historical deployment, not proof of a current
M2 resident. Native DSH, DPAPI and real API receipts are separate acceptance
layers from synthetic source tests. Synthetic selected text reaching a real
model and native ACK establishes a bounded mechanism, not conversational
quality, a human-read receipt or an emotional effect. This native acceptance
uses `enableProactive:false`; it does not establish proactive delivery.
The core vault's encryption does not establish encryption of the host DSH
transcript or other host-managed storage.

## Contracts

Private anonymous stdin boot adds
`persistence:{directory,identity,keyBase64}`. Directory is an existing absolute
private runtime path outside the source/OneDrive tree; identity is stable, at most
128 characters; keyBase64 is canonical base64 for an independent random 32-byte
memory key. The memory key is separate from apiKey and never enters argv,
environment, public configuration, status or audit. The cross-platform core
accepts key bytes; the Windows launcher owns DPAPI and credential discovery.
Neither user configuration nor existing data is modified by the core.

Public DSH configuration adds `launcher.persistence:{directory,identity}` and
top-level `nativeSessionMode:'create'|'resume'` (default create). Resume requires
persistence and calls public SDK
`agents.resume({resumeSessionId,agentOptions:{provider,model}})` for exactly the
configured SID. There is no history scan or create-on-resume-failure fallback.
Launcher arguments are `--memory-directory` and `--memory-identity`; only the
private boot contains the key. The new provider ID is `companion-core-` followed
by the first 12 lowercase SHA256(identity) hex digits. RAM retains the historical
provider and one-shot boot claim. Only M2 replaces that claim with vault
ownership and a nonrefundable durable budget. No old claim is removed.

Core first initialization permits an empty directory and two launcher-owned
auxiliary filenames, `memory-key.dpapi` and `memory-key.init-claimed`, without
reading either. The launcher must refuse missing keys for existing state rather
than generate replacements. Existing M2 state with a missing marker, authority
database or latest checkpoint is an error, never an empty replacement.

Status adds `personalPersistence`, `sessionOnly`, `stateResetOnRestore` and
`persistence:{version,identity,sequence,restored,consumedRequests,unknownRequests,
ingressCount,manualResumeRequired,checkpointBytes,maxCheckpointHistoryBytes,
authorityBytes,maxAuthorityBytes,maxCheckpointBytes,maxCommits}`.
Private owned native `/companion-inspect` returns bounded JSON (32 KiB) with last source/memory/ACK IDs, pending
feedback and numeric background state. `requestAudit` records the actual HTTP
JSON body SHA256, request ID, recalled memory refs/ranks/scores, attention prior
and conditioning source IDs immediately before fetch. It contains no source or
reply body or key. This proves local payload preparation, not independent remote
receipt. Safe JSONL audit remains limited to its fixed counts/status/hash fields.
`/companion-status` retains its short human-readable text for the existing native
status client. Inspect is read-only and grants no resume, presence or model work.
Its `runtimeBindingHash` is SHA256 of the private current core session token,
allowing restart comparisons without exposing the token itself.

## Persistence and recovery

The original SQLite schema v1 is unchanged; M2 runs it exclusively in RAM, with
temporary storage restricted to memory. Both `DatabaseSync.serialize` and
`deserialize` are feature-gated; absent APIs fail closed without plaintext
fallback. Observed test runtime: Node v24.16.0, SQLite 3.53.0,
`<NODE_EXECUTABLE>`. An engines range is not proof that every
Node build provides these APIs.

`writer.sqlite` contains only an empty lock table and holds an exclusive
transaction for the process lifetime. A second owner is refused; process death
releases the OS lock. No stale-lock deletion, PID guessing or timed takeover is
performed. `M2.v1.claimed` marks initialization. `authority.sqlite` stores only
AEAD-encrypted safety records in an append-only table with FULL synchronous
SQLite commits. Its disk journals contain ciphertext, not private data. Each
record binds format/identity/sequence, previous entry hash, immutable checkpoint
name/hash, revocation high-water and the complete ingress/quota/terminal state.

For a changed memory transaction: first commit RAM SQLite so FTS5 has synchronized
its pending index changes, then serialize that complete image. Encrypt image plus
safety state with AES-256-GCM and a fresh nonce, exclusively create
`checkpoint-<sequence>-<UUID>.bin`, fsync it, and commit the encrypted authority row
before returning. Metadata transitions use the same durable boundary. The
authority commit remains the durable commit point; the earlier RAM commit is not
an acknowledgement. Any uncertain RAM commit, serialization or persistence error
poisons both the memory store and durable authority; neither may continue serving
reads, success, HTTP or replies. Ordinary SQL body errors roll back before this
boundary. Unchanged reads/status do not
checkpoint. Orphan higher-numbered checkpoints are never automatically selected.

The original M2 writer serialized before RAM COMMIT, which could omit FTS5's
pending inverted-index changes. A synthetic multi-turn/restart/revoke sequence
reproduced a fast `DURABLE_CORRUPT` on the following boot. The corrected writer
only creates complete future checkpoints. Existing inconsistent images still
fail integrity validation; no automatic repair, migration or fallback is added.
The original failed native vault remains sealed and was not decrypted; its
original fixed error code was not retained. This independent red/green
reproduction is not a direct diagnosis of that native vault.
Startup rejection forwards an explicit allowlist of fixed durable/schema error
codes through the stdio backend to the private `plugin-start` audit. Arbitrary
codes, exception messages and paths are never forwarded. This diagnostic does
not change startup/cleanup deadlines or retry a rejected boot.

Startup verifies the bounded complete authority chain and only its exact latest
checkpoint: hash, AEAD, identity, safety state, schema/layout hash, integrity and
foreign keys. Replacing a checkpoint with an old one while preserving the latest
independent safety ledger fails closed. No old-snapshot overlay or backup restore
command is implemented. **The independent safety ledger must remain latest and
must not be externally rolled back.** A valid-prefix rollback of only
`authority.sqlite` is currently unprotected: deleting its last valid reserve
record while keeping all keys/checkpoints unchanged permits reopening the prior
checkpoint with the older quota. This is the explicit
`KNOWN_UNPROTECTED_LEDGER_ROLLBACK` negative fixture, not a passing rollback
defense. Whole-directory rollback is also outside the boundary. Hash chaining
detects breaks and corruption, not a valid truncated prefix without an external
trusted head. External monotonic anchors and independent backup reconciliation
remain future work; do not claim arbitrary ledger tampering fails closed or
ten-year recoverability. Losing the ledger entirely is still an unavailable
vault, never permission to open an older image.

Restore bumps runtime epochs, clears job leases and active artifact bindings,
creates a fresh session token, changes pending/ready/taken output records to
unknown, and persists that recovery before readiness. Old output bodies and
delivery permissions are not restored. Run tickets, monotonic deadlines,
presence leases, timers, shadow intents, pending feedback and neural/background
state reset. M2 always starts paused, quiet, unavailable and behind a manual
resume gate. Ordinary input cannot clear it. Explicit resume provides no presence
lease; only a fresh native input supplies its finite arrival-based lease. There
is no automatic restart, replay, retry or budget refill.

## Request and feedback safety

Stable ingress HMACs use the memory key/vault and a stable source namespace,
not a random runtime token. Claim precedes source publication. Crashes can lose
unacknowledged work but cannot execute the same native ID again; changed payloads
conflict and historical IDs stay terminal. SDK prompt deduplication is separate
evidence from core ingress deduplication.

Each HTTP reserve binds its exact request ID, commits before fetch and cannot be
reserved twice. Timeout, cancellation, failed provider work, process death or
storage delay never refunds quota. The original maxCalls cannot change on open.
Old monotonic timestamps are not restored: all prior spend is conservatively
charged to the new hour/day windows; offline time releases no rolling quota.
Committed wall-clock high-water rejects observed rollback on reopen. A read-only
TTL observation followed by crash is not durably recorded; arbitrary clock
manipulation is not solved. Coupled selected-text anchors have no TTL and old
background state is reset.

Pending -> ready -> taken -> acknowledged is monotonic. Failed reserved work
becomes unknown. Taken commits before text leaves the core; acknowledged commits
before its receipt. The original fixed monotonic deadline, source authority and
host context are checked after synchronous reserve and take persistence. Missing
timer dispatch cannot extend permission. A consumed fence stays consumed when
these checks fail. ACK and generated text are never engagement.

`/companion-feedback <deliveryId> engaged|declined|neutral` selects feedback for a
current-binding native completed ACK. The command alone creates no source,
reward or model call. The next real native input supplies its own source and the
existing submit.feedback contract consumes feedback durably once before state
application. Identical pending selections are idempotent; conflicting ones are
rejected. Pause/switch/revoke/unload/restart clears selection. Historic ACKs are
audit metadata only and cannot reward a new binding.
`/companion-revoke <sourceId> <revision>` works while paused, commits revocation
and invalidates this binding. Both commands require the exact owned agent and
recordInput:false; ordinary text is never management authority.
Current revoke/purge invalidates the binding and leaves it paused. Acceptance
proves that revocation survives a fresh mount/restart of that same repaired
vault; it does not prove automatic conversation continuation in the invalidated
binding. Public controls have no automatic create/reset fallback; improving that
control surface remains future work.

## Limits and evidence

Maximum RAM image: 16 MiB; accumulated checkpoint ciphertext: 256 MiB; authority
history: 4096 commits. The independent authority database plus recovery sidecars
is capped at 64 MiB, with a 4 MiB limit per encrypted record, verified before
opening/materializing them. Writes reserve conservative rollback-journal space;
status reports checkpoint and authority bytes separately. These are separate
bounds, not a claim that the whole directory has a 256 MiB bound. Reaching a
bound refuses further writes. Full-image
retention grows inefficiently; compaction, rotation, export, tiered backup and
restore remain future work. No garbage collector deletes historical files.
Revocation means exclusion from current authority; retained encrypted history,
RAM, process dumps, swap, SSD media and provider-received input are not claimed
physically erased.

Synthetic tests cover image roundtrip/features; source/derived-memory/FTS
restart; fresh tokens/reset state; real second-process lock refusal and owner
termination; four persistence fault boundaries; reserve-before-fetch and
take-before-output; stale image/missing ledger/wrong key/identity/budget; deadline
overrun without timer dispatch; current-binding feedback; explicit native resume;
and unchanged RAM boot claims. This is process-crash evidence on the observed
host, not power-loss qualification, multi-year reliability or native deployment
acceptance. DPAPI launcher fixtures and actual native runs are separate records.
The separately labeled valid-prefix ledger rollback test records a known
unprotected boundary. Ordinary crash, deduplication, quota and revocation claims
require the complete latest independent ledger to remain intact.

`NODE_EXECUTABLE` is an explicit local executable path; `LOCAL_LAB` denotes a separately configured absolute runtime root outside the source checkout/OneDrive. A fresh clone does not discover the original machine runtime or credentials.
