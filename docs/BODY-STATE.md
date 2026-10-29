# B0 body state: trusted host RAM prototype

**B0_STATE_PROTOTYPE** is an independent, host-driven numerical module. It accepts trusted synthetic/host declarations and maintains one device's bounded latest state. It does not authenticate a sensor, implement a collector, or establish Spark sampling, cross-machine timing, emotional quality or subjective experience. No model call or training is required for this module's synthetic contract tests.

The public implementation is `src/body-state.ts`; its focused checks are `test/body-state.test.ts`. It imports no Store, background state, scheduler, inference or hardware-control module. Hardware samples do not become published Store sources, self-report outcomes or rewards. Existing cognitive pause, communication permissions, request quotas, UNKNOWN and settlement semantics are unchanged.

## API and identity

Construct `BodyStateOwner({deviceId, clockDomain, clock, channels})` with one explicit trusted monotonic clock in milliseconds. All source observations must already use that same local clock domain. Wall-clock timestamps, remote monotonic values, clock correction and historical replay are outside B0.

- `bindSource({sourceId, bootId})` returns a frozen publisher with `ingest(frame)`. Each successful explicit bind creates a fresh source epoch/token, fences every older publisher, clears all values and latest sequence, and sets `asOf` to that host clock reading. No implicit rebind occurs.
- `publisher.ingest({sourceId, bootId, sequence, observedAtMs, readings})` returns `accepted` or `duplicate`. Every frame supplies its own source/boot identity and exactly one reading for every configured channel. A new publisher rejects old-boot frames; it does not automatically relabel buffered data. The trusted host must not attach new identities to old observations. These declarations are not proof of physical provenance.
- `advance()` consumes host time without requiring a sample, message or LLM invocation. The owner has no timer; its host must arrange ingestion and advancement.
- `snapshot()` returns an immutable as-of value; `close()` clears values and permanently closes that owner. Source rebinding cannot reopen a closed or clock-faulted owner.

Reading forms are `{channelId, kind:'value', value}` and `{channelId, kind:'unknown', reason}`, where reason is `missing`, `unsupported`, `permission-denied` or `sensor-error`. Values are gauges; cumulative counters must not be passed as if they were rates. Missing readings must be explicit, not omitted or replaced with zero.

```ts
// Deterministic synthetic example, not a hardware collector or calibrated profile.
let hostNow = 0;
const owner = new BodyStateOwner({
  deviceId: 'synthetic-device', clockDomain: 'fixture-monotonic', clock: () => hostNow,
  channels: [{ id: 'load', unit: 'fixture-units', calibrationVersion: 'fixture-v1',
    low: 0, high: 10, fastTauMs: 10, slowTauMs: 100, maxAgeMs: 1000 }],
});
const publisher = owner.bindSource({ sourceId: 'fixture-source', bootId: 'fixture-boot' });
publisher.ingest({ sourceId: 'fixture-source', bootId: 'fixture-boot', sequence: 1, observedAtMs: 0,
  readings: [{ channelId: 'load', kind: 'value', value: 4 }] });
hostNow = 10;
owner.advance();
const historicalValue = owner.snapshot();
owner.close();
```

## Causal time and expiry

New sequence numbers are positive safe integers and strictly exceed the latest accepted sequence; gaps are allowed. Their observation times must strictly increase and satisfy `asOf <= observedAt <= receivedAt`, where `receivedAt` comes only from the host clock. A sample earlier than the already-advanced horizon is rejected, even if it would otherwise be young enough. There is no reorder buffer, time interpolation or retroactive correction.

For an accepted frame, first evolve the **previous** held input up to the new observation time, respecting its original expiry. Install each new input at `observedAt`, then evolve to `receivedAt`. The fast and slow filters solve the first-order sample-and-hold equation with `alpha = 1 - exp(-elapsedMs / tauMs)`. New values never fill the time interval before they were observed. The implementation computes alpha with `expm1` and decay independently with `exp`, chooses the stable endpoint or an opposite-sign convex sum, and splits long decay products to avoid losing a representable tail when the decay factor alone underflows. Advance partitioning agrees within floating-point tolerance, including ordinary rounding/underflow limits. Sample count and snapshot frequency do not determine elapsed time.

Each channel's expiry is always `observedAt + maxAgeMs`, not receipt time. At `time >= expiry`, numerical values become UNKNOWN/null and the old signal is no longer integrated. Explicit UNKNOWN also clears the channel immediately at its observation time. The first valid observation after either gap initializes both filters to that value, without bridging the unknown interval. A frame arriving after its own expiry can still be accepted/consume its sequence, but its current numerical output is UNKNOWN. First-sample initialization is an engineering convention, not evidence of an earlier steady state.

Only the latest complete frame is retained. Same-sequence/same-content repeats return `duplicate` without reading the clock or changing state, receipt time or expiry; channel ordering and signed zero are canonicalized. Same-sequence changes conflict; older sequences are refused rather than looked up in an unbounded ledger. A duplicate after expiry cannot restore values.

The host clock must return a finite value in `[0, Number.MAX_SAFE_INTEGER]` and never decrease. A failed/throwing/backward clock permanently faults the owner, invalidates its publisher and clears numerical values. The health check retains every successfully observed clock high-water mark even if a subsequent frame validity check fails; that checkpoint does not advance `asOf` or the filters. Otherwise rejected frames leave asOf, source, sequence, values and deadlines unchanged. Clock failure is the explicit terminal exception to ordinary data-refusal atomicity. Snapshots and exact duplicates do not poll the clock, so they cannot discover an unobserved clock failure.

## Snapshot meaning and calibration

Every snapshot declares `semantics: AS_OF_ONLY_NOT_CURRENT_PERMISSION`, `asOfMonotonicMs`, owner/source epochs, sequence and each channel's original observation/receipt/expiry timestamps. `VALID_AT_AS_OF` means exactly that. Snapshotting never reads the clock or advances any state. If the host stops advancing, an old snapshot can still say VALID_AT_AS_OF after its recorded expiry in real time; it never promises current freshness.

Before a future consumer treats a snapshot as current, it must independently check the authoritative live owner/source binding, a healthy same-domain host clock, `asOf <= now`, and `now < expiresAt` for every used channel. A copied snapshot's self-reported epoch or validity is not authority and cannot grant permission. B0 implements no consumer or arbitrary-snapshot freshness helper. Already returned immutable values remain historical copies after close, rebind or expiry.

All channel configuration is explicit and copied/frozen: id, unit, calibration version, increasing low/high calibration endpoints, fast/slow tau and maximum age. Raw gauges and filters retain original units. Snapshot normalization clips `(value-low)/(high-low)` to `[0,1]` separately for raw/fast/slow; raw outside the calibration interval remains present with `outOfRange:true`. This flag describes the raw reading, not a universal alarm/emotion threshold. No adaptive baseline quietly normalizes sustained load. A new calibration requires a new owner rather than mutating an active filter's meaning.

Finite numbers are required; `-0` is canonicalized to `+0`. Endpoints require `low < high` and a finite span. Time parameters require `1 <= fastTauMs <= slowTauMs <= 24 h` and `1 <= maxAgeMs <= 24 h`; fractions are allowed. Expiry exceeding the timestamp bound is refused. These are engineering input limits, not physiological facts or recommended sensor settings. All frame parsing and filter calculations finish on temporary state before one acceptance update.

## Bounds and acceptance

One owner has 1–16 fixed channels, bounded 128-byte labels, one current publisher binding, one latest complete frame and constant state per channel. It keeps no historical queue, timer, persistent ledger, telemetry database or automatic retry. Caller-retained snapshot/publisher objects and host-driven call frequency are outside the owner's retained-state bound. Parsing accepts closed plain-data shapes and rejects proxies/accessors without invoking them; the injected clock and JavaScript intrinsics are trusted in-process code. Clock callbacks cannot reenter or inspect intermediate owner state, including the first constructor callback. The construction guard releases only after successful initialization.

Focused synthetic acceptance covers causal irregular/step trajectories, partitioned advance, read-frequency independence, late/future/invalid atomic refusal, sequence identity, original expiry and gaps, old publisher/boot rejection, permanent clock faults, owner isolation, immutable input/output boundaries and numerical/configuration limits. Local checks do not establish real sensor overhead, physical provenance, platform timing, long-running behavior or Spark calibration.

B1 remains a separate integration of bodily state with background dynamics and internal rhythm under existing pause/currentness/permission controls. B2 still targets continuous numerical/vector or controlled adapter conditioning at verified inference boundaries; a textual prompt summary would only be a bridge/control and does not complete B2. Actual model-quality evidence, backend support and any weight-learning authorization remain separate. B0 implements neither B1 nor B2, and performs no hardware actuation.
