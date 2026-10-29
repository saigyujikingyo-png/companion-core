# Explicit real-plan teaching cycle

`TeachingCycle/0.2` adds real-plan admission, a portable host composition and a
qualified-yield report to the bounded [teaching cycle](TEACHING-CYCLE.md). It runs
one fixed cycle through the existing production/QA v2 stores and shared scheduler.
It does not provide an autonomous cross-cycle planner or authorize Student training.
The older `/0.1` profile, synthetic qualification and stored event bytes remain
unchanged. Frozen jobs still require their matching source/build closure; this is
not a migration or a way to relabel earlier synthetic output.

The subsequent [S4 trusted host](TEACHING-CYCLE-HOST.md) adds the explicit native
worker/controller and fixed-authority finalization/recovery seam. Its configuration,
synthetic and actual-run acceptance are separate from this S3 implementation.

## Real-plan admission

`TeachingCurriculumPlan/0.2` freezes `REAL_MENTOR_PLAN`, the ordered child production
spec digests, `approvedObjectiveDigest`, `curriculumDigest`, `projectUseRecordDigest`,
`mentorViewVersion`, `mentorViewDigest` and exactly two distinct mentor bindings.
Each binding contains `model`, `requestedEffort`, `effectiveEffort`, `effortEvidence`
and `completionEvidenceDigest`. A provider echo must match the requested effort;
when no echo is available the effective value is null and the evidence is
`REQUEST_PARAMETER_ONLY`. The protocol does not force one model pair or silently
substitute a different model or effort.

These fields are commitments, not proof of permission or execution. The trusted
launcher must authenticate the two original completed, non-refusal responses,
their final assistant identities, the actual invocation arguments and their
binding to the same approved MentorView. It must validate the coordinator's
objective/curriculum/child mapping and the separate current project-use and service
permissions. A request parameter, aggregate model-usage field, model self-report,
or model-authored approval cannot substitute for those checks. Missing either
actual completion is a refusal to admit the real plan, including on resume.

The required synchronous `realPlanAdmission({spec, active})` hook supplies that
host boundary. It must finish with an undefined return; missing hooks, Promises,
thenables and other return values are rejected. It runs before INIT is decrypted
and during subsequent store checks. The host closure therefore already holds the
frozen plan and verifies its digest against the spec. Decrypted INIT is then checked
against that same digest. `active: false` requests current inspect/retain rights;
revoked execution need not prevent separately permitted metadata inspection.

The [MentorView](MENTOR-BLINDED-VIEW.md) remains the generic architecture and
methodology brief. The coordinator keeps real downstream uses and permissions in
the separate ProjectUseRecord. View separation does not prove service eligibility,
permit refusal retries, or let mentor output grant permission.

## Portable host entry points

The callable command entry point is
`runTeachingCycleCommand({version: 'TeachingCycleCommand/0.2', command, spec}, ports)`
from `src/teaching-cycle-cli.ts`. It does not load configuration or credentials from
the environment. `openTeachingCycleHost(options)` in `src/teaching-cycle-host.ts`
constructs the existing `TeachingCyclePorts` and returns `{ports, close,
automaticLocalReclaim: 'DISABLED'}`. Close it in a finally block.

| Command | Required input | Return |
| --- | --- | --- |
| `describe` | `spec: null`; no ports | Profile, commands and evidence boundaries |
| `run` | Exact real spec and bound host ports | Existing bounded-cycle progress summary |
| `inspect` | Exact real spec and bound host ports | Current progress summary |
| `verify-report` | Exact real spec; store opened in `inspect` mode | Current-process report candidate |

The options contain the cycle store options, frozen plan, exact owner identity,
one `TeachingChildHostBinding` per child, current `checkChildMetadata`, and an
optional abort signal. Each child binds fixed production options/objective/registry,
native transport and tokenizer; fixed audit root/authority/key/transport and audit
binding; and the archive reader build, current grant resolver and seal operation.
Production digests and objective, child count, deterministic audit IDs and disjoint
custody paths are checked. All custody is under the explicit approved training
root; independent authorities remain outside it. Host-owned key copies are cleared
on close and on every construction failure, without changing the caller's buffers.

The implementation includes these reusable helpers, so audit identity and seal
verification do not depend on ad hoc launcher code:

- `deterministicTeachingAuditBinding(frozenTemplate, currentAdmission)` returns
  `audit.bind(selection) -> {spec, admission}`. It derives only the selection,
  population, grant/purpose digests and row count; identities, creation time and
  expiry remain frozen. The host creates the QA store and persists that exact INIT
  before returning. Resume reuses the same custody and validates the original INIT.
  Partial or mismatched creation is rejected, never reset under a new identity.
- `sealTeachingQaArchive(context, options) -> descriptor` reads the closed child's
  actual ledger and authority, binds terminal head/sequence, spec, selection,
  index, raw file hashes and reader build, then opens the metadata archive and
  successfully reads its verified view under current grants. Only after success
  does it return the descriptor. Its `coldReceiptRawDigest` binds a
  `CURRENT_PROCESS_METADATA_REOPEN` receipt; it does not claim a separate process.
  There is no descriptor/receipt hash cycle. The child authority's final intended
  state must be set before sealing: changing its hashed bytes afterwards, including
  revoking it, invalidates that descriptor. Current metadata read grants remain
  independently revocable.

`checkChildMetadata(child)` must cover the fixed child's selection, measurements,
accounting derivations, index and descriptor under current retain/read permission.
Every derived read/write checks it. Reporting retains all registered archive
handles through assembly and report derivation, then rechecks every child's
metadata permission and every archive capability immediately before returning.
This catches revocation of an earlier child while reading a later one. No plaintext
body reread or extra child cold process is needed for that final check.

## Usage and qualified yield

V2 commits `productionAccountingRef` with the production-to-QA stage, after
production verification, export and selection. It binds the selection's source
spec/head/ledger digest. It commits `qaAccountingRef` with COMPLETE and binds the
final audit descriptor's spec/head/ledger digest. Both summaries derive from the
verified child's original attempt records and controlled response artifacts.
They distinguish reported, raw-proven unreported, invalid and unavailable usage,
pending/remote UNKNOWN and known 429 observations. Valid subtotals remain available;
the full total is null if any attempt's usage is not reported. Correctly shaped
usage outside policy bounds remains INVALID rather than failing aggregation.
Parent resource leases are never counted as actual provider consumption.

Cold inspection authenticates the frozen summary and its bindings. The evidence
label is `FROZEN_DERIVATION_OF_VERIFIED_CHILD_STATE`; it does not claim that the cold
process re-audited all original provider plaintext.

`teachingCycleReport` returns `INCOMPLETE` with null qualified counts and throughput
until all required children and barriers are complete. For a complete cycle it
reassembles all full indexes and requires the final barrier to match. It joins
measurements one-to-one by `(sourceJobId, unitId)` and checks row digest/reference,
split, pool and family. Missing, duplicated or conflicting joins fail closed. Every
selection must use one identical `tokenizerProfileDigest`; unlike units are not
summed. REJECT and HOLD bridge nodes remain in the full assembly. Only final
`eligibleForNextExport` rows contribute to train/dev counts, with splits reported
separately. Exclusion reason counts can overlap.

`verifyTeachingCycle.tokens` retains its older meaning: all selected rows. It is
not the qualified train yield. The report separately returns all-selected totals,
qualified train/dev input/loss/full tokens, quarantine counts and actual usage
derivations. Native concurrency and memory peaks stay null unless a future host
report supplies actual observations; configured slots are not measurements.

## Timing and independent publication

Every v2 event carries a store-generated `at`. Replay maintains persistent
`lastObservedAt`; writes and cross-process resume reject a clock observation below
it. A single START is committed before the first child dispatch attempt. The final
index BARRIER records completion in the same commit. Resume never resets either
boundary. The interval is `CYCLE_START_TO_FINAL_INDEX_BARRIER`, including pauses and
resume waiting; it is not a sum of parallel child times. START can exist without an
actual provider send. Missing boundaries, incomplete cycles or nonpositive elapsed
time produce null throughput. This is evidence of trusted host clock observations,
not physical-time or NTP authentication. Independent cold-verification duration is
not measured by this clock and remains null.

Even a complete report is labeled `CURRENT_PROCESS_VERIFIED`,
`COMPLETE_INDEX_CANDIDATE` and `INDEPENDENT_COLD_REQUIRED`. The trusted launcher must
close the execution handles, start an actual fresh process, reopen the same cycle
in inspect mode with current grants, and call `verify-report`. It must compare the
frozen build/spec/plan/state/head/sequence, all index, assembly, measurement,
accounting and report digests. Only that launcher may publish a
`FINAL_COLD_VERIFIED` wrapper after matching the two results. Core has no callback
or supplied boolean that upgrades the evidence class.

The public composition and command function are implemented; a deployable Windows
bootstrap is not shipped by this slice. The trusted host still needs local frozen
configuration, actual mentor-receipt authentication, current permission resolvers,
DPAPI/key and credential injection, native transport/process ownership bindings,
and the real new-process comparison/publication wrapper. Configuration and secrets
stay outside Git. Until those bindings and actual dual-mentor admission are
validated, synthetic passes do not mean the real runtime is connected. UNKNOWN is
never resent, and this host provides no automatic local reclamation without exact
owned-process exit evidence.

All included tests use synthetic inputs, injected HTTP, temporary custody and
clearly synthetic mentor bindings. Tokenizer interception is separate from the
existing official-worker test. The new-process fixtures prove the composition's
reopen path, not real provider completion, actual service eligibility, or Student
training. Native, cross-platform and actual-host results are recorded against their
exact source freeze.
