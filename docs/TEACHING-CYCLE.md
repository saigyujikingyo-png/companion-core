# Durable synthetic teaching cycle

`TeachingCycle/0.1` composes the existing explicit production and QA v2 jobs. Its
plan is qualified `SYNTHETIC_PLAN`; it does not claim that two mentors produced or
approved a curriculum. Model reviews remain `MODEL_OPINION`, factual truth remains
unknown, and Student training remains unauthorized.

The separate [explicit real-plan cycle](TEACHING-CYCLE-REAL.md) describes `/0.2`
admission, portable host bindings, qualified-yield accounting and independent-cold
publication. It does not alter this `/0.1` synthetic profile or historical records.

Each child has a durable stage: production, token measurement/export, QA, full
index, complete or failed. Children may overlap; a child advances sequentially.
A micro round advances only after every required child is complete and a barrier
commits an assembly digest over all indexes through that round. A failed child
prevents the barrier. Logical planned units may exceed 192; the existing physical
production/QA limits remain 192. The frozen cycle resource configuration bounds
active children, local native calls, buffered request/response reservations,
children, journal events/bytes, and indexed nodes/bytes. These are resource limits,
not money or API-total quotas.

`runTeachingCycle` executes the existing production, measurement, export, source
selection, QA and full-index functions. The trusted host supplies independent
child stores, transport credentials and current source grants. The host factories
open or resume the same deterministic child custody locations: the production spec
is pinned in the plan, and `cycleAuditId(cycleId, childId)` fixes the audit identity.
Selection is committed before audit creation; the resulting audit spec is bound
before any audit send. An existing mismatched job must be rejected. Index archives
retain that audit's committed index/manifest and current metadata grant. Factories
cannot substitute an eligible manifest or a newly named audit after a crash.

The shared scheduler covers **all children of one TeachingCycle**. Independent
cycles do not share a host-wide account ledger in this slice. A provider/account
permit is acquired before the child's `CONSUME`. After waiting, parent and child
authority, source and expiry are checked again. The final synchronous send window
locks parent then child authority; no lock spans an await. The existing synchronous
native-completion probe is unchanged. A permit's reserved request/response bytes
stay charged until both transport and native completion are proven released.

Business journal commits use a separate synchronous `authorizeCommit` through the
same parent→child lock order. A parent pause/revoke acknowledged before that gate
prevents subsequent production ACCEPTED or QA PASS transitions. A concurrent
controller cannot acknowledge its change inside the protected commit window; it
must receive busy or complete after that commit. Rechecking a guard without the
lock would not provide this ordering.

Local ownership and remote observations are separate. `UNKNOWN` remains consumed
and is never retried. A live owner's pending resources cannot expire by TTL or
heartbeat. In exclusive resume mode, a trusted host may attest the exact owner
epoch, process birth identity, associated worker exits and resource reclamation;
`LOCAL_RECLAIM` then frees only the local reservation. It does not prove server
cancellation. Default capacity tracks local resources, so such reclamation permits
other unconsumed jobs to continue; no permanent account lock is inferred solely
from `UNKNOWN`. The host evidence interface is not a deployed Windows/Linux
process-identification service.

Observed 429 `notBefore` is persisted per account before the child `SETTLE`, with no
await between the two commits. An invalid RetryAfter blocks that account rather
than inventing a deadline. A crash after parent settlement but before child
settlement leaves the child's result unknown; recovery never copies parent
observations into business success or QA eligibility. Parent resource `SETTLED`
and child business `SETTLE` are distinct records. Cold recovery preserves the
account cooldown, once records, local holdings and interrupted stages.
Resource reservation counts are not API consumption counts. In particular, an
abandoned reservation may never have reached child `CONSUME`; actual consumption
must be counted from the child journals, not inferred from parent lease status.

Each child commits its complete QA index, including HOLD and REJECT bridge nodes,
and its original descriptor/digest. Current registered metadata-only archive
capabilities recheck every shard at barriers and cold verification; they do not
read source raw responses, reasoning or training text. The same union algorithm
serves legacy F2 (still at most eight sources) and the explicitly resource-bounded
cycle entry point. Iterative path compression avoids recursive chain overflow.
This is exact, normalized and prompt fingerprint comparison; semantic similarity
and all-history contamination guarantees are not claimed.

Cycle plan admission is not a grant to read a child's derived metadata. The host
must supply `checkChildMetadata(child)` with a current grant bound to that fixed
child and production/audit identity, covering retention and reads of its selection,
measurement receipts, descriptor and index. There is no default approval. This
synchronous hook runs before each derived artifact read, including incomplete QA
recovery, and before writing/readback of new derived metadata. Only an undefined
return indicates completion of the check; a Promise, thenable or any other return
is rejected before reading. Rejected native Promises are consumed without waiting
or granting access. The separate current archive capability check still applies
to complete children; neither grant replaces the other.

The cycle build identity pins its full local import closure, type contracts and
Python worker bytes. Frozen older jobs require their matching source; S1/v1
records are not rewritten. Synthetic tests distinguish intercepted tokenizer
process receipts from the separate test that actually executes the official
pinned Python worker. Native model traffic is injected synthetic HTTP, with
separate assertions for overlapping requests from distinct children. Cross-process
tests reopen real SQLite/artifact journals and interrupt audit creation, archive
creation and the parent/child settlement boundary. Test and platform results are
reported against an exact freeze, not implied by this design document.

The [mentor view](MENTOR-BLINDED-VIEW.md) defines the separate architecture and
methodology brief. Actual uses and service/source permissions stay in coordinator
records. The view does not authorize a service, prove improved capability or
permit retrying a refusal.
