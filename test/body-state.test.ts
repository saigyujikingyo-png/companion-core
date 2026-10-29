import assert from 'node:assert/strict';
import test from 'node:test';
import { BodyStateOwner, BODY_STATE_LIMITS } from '../src/body-state.ts';
import type { BodyChannel, BodyFrame, BodyReading, BodySnapshot, BodyStateConfig } from '../src/body-state.ts';

const channel = (id = 'load', overrides: Partial<BodyChannel> = {}): BodyChannel => ({ id, unit: 'synthetic-gauge', calibrationVersion: 'fixture-v1',
  low: 0, high: 10, fastTauMs: 10, slowTauMs: 100, maxAgeMs: 1000, ...overrides });
const value = (n: number, channelId = 'load'): BodyReading => ({ channelId, kind: 'value', value: n });
const frame = (sequence: number, observedAtMs: number, readings: readonly BodyReading[] = [value(0)], bootId = 'boot-one'): BodyFrame =>
  ({ sourceId: 'host-source', bootId, sequence, observedAtMs, readings });
function fixture(channels = [channel()], initial = 0) {
  let now = initial, reads = 0, throwing = false;
  const owner = new BodyStateOwner({ deviceId: 'synthetic-device', clockDomain: 'local-monotonic', channels,
    clock: () => { reads++; if (throwing) throw Error('synthetic clock failed'); return now; } });
  const publisher = owner.bindSource({ sourceId: 'host-source', bootId: 'boot-one' });
  return { owner, publisher, set: (v: number) => { now = v; }, throwClock: () => { throwing = true; }, reads: () => reads };
}
const state = (snapshot: BodySnapshot, i = 0) => {
  const s = snapshot.channels[i]!; assert.equal(s.validity, 'VALID_AT_AS_OF');
  if (s.validity !== 'VALID_AT_AS_OF') throw Error('not valid at asOf'); return s;
};
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('host-driven step and irregular intervals use causal held input and physical-time fast/slow solutions', () => {
  const f = fixture(); f.publisher.ingest(frame(1, 0));
  f.set(10); f.publisher.ingest(frame(2, 10, [value(10)]));
  assert.equal(state(f.owner.snapshot()).fast, 0, 'new value must not fill the preceding interval');
  f.set(13); f.owner.advance(); const a = state(f.owner.snapshot());
  near(a.fast, 10 * (1 - Math.exp(-3 / 10))); near(a.slow, 10 * (1 - Math.exp(-3 / 100)));
  f.set(22); f.publisher.ingest(frame(7, 19, [value(-4)])); // Sequence gaps do not imply time intervals.
  const b = state(f.owner.snapshot());
  near(b.fast, -4 + (10 * (1 - Math.exp(-9 / 10)) + 4) * Math.exp(-3 / 10));
  near(b.slow, -4 + (10 * (1 - Math.exp(-9 / 100)) + 4) * Math.exp(-3 / 100));
  assert.equal(b.raw, -4); assert.equal(b.outOfRange, true); assert.equal(b.normalized!.raw, 0);
  assert.equal(b.observedAtMs, 19); assert.equal(b.receivedAtMs, 22); assert.equal(b.expiresAtMs, 1019);
});

test('advance partition and snapshot polling do not change dynamics, sequences or original expiry', () => {
  const a = fixture(), b = fixture();
  for (const f of [a, b]) { f.publisher.ingest(frame(1, 0)); f.set(10); f.publisher.ingest(frame(2, 10, [value(10)])); }
  const frozen = a.owner.snapshot(), reads = a.reads(); a.set(2000);
  for (let i = 0; i < 10_000; i++) assert.deepEqual(a.owner.snapshot(), frozen);
  assert.equal(a.reads(), reads); assert.equal(frozen.semantics, 'AS_OF_ONLY_NOT_CURRENT_PERMISSION');
  assert.equal(frozen.channels[0]!.expiresAtMs, 1010); assert.equal(frozen.asOfMonotonicMs, 10);
  // External host time is now beyond that immutable expiry; no current-fresh claim exists.
  assert.ok(2000 >= frozen.channels[0]!.expiresAtMs!);
  a.set(37); a.owner.advance();
  for (const now of [11, 13, 17, 23, 37]) { b.set(now); b.owner.advance(); }
  near(state(a.owner.snapshot()).fast, state(b.owner.snapshot()).fast);
  near(state(a.owner.snapshot()).slow, state(b.owner.snapshot()).slow);
  assert.equal(a.owner.snapshot().sequence, 2); assert.equal(state(a.owner.snapshot()).expiresAtMs, 1010);
  const equal = a.owner.snapshot(); a.owner.advance(); assert.deepEqual(a.owner.snapshot(), equal);
});

test('late, future, out-of-order and malformed complete frames reject atomically', () => {
  const f = fixture([channel(), channel('other')]); f.publisher.ingest(frame(1, 0, [value(2), value(3, 'other')]));
  f.set(20); f.owner.advance(); const before = f.owner.snapshot(); f.set(30);
  assert.throws(() => f.publisher.ingest(frame(2, 10, [value(9), value(8, 'other')])), /BODY_SAMPLE_LATE/);
  assert.throws(() => f.publisher.ingest(frame(2, 31, [value(9), value(8, 'other')])), /BODY_SAMPLE_FUTURE/);
  assert.throws(() => f.publisher.ingest(frame(2, 0, [value(9), value(8, 'other')])), /BODY_OBSERVATION_ORDER/);
  for (const readings of [[value(9)], [value(9), value(NaN, 'other')], [value(9), value(8)], [value(9), value(8, 'alien')]])
    assert.throws(() => f.publisher.ingest(frame(2, 30, readings)), /BODY_INVALID_INPUT/);
  assert.deepEqual(f.owner.snapshot(), before);
  f.publisher.ingest(frame(2, 30, [value(9), value(8, 'other')])); assert.equal(f.owner.snapshot().sequence, 2);
});

test('expiry is anchored to observedAt; missing and long gaps reinitialize without integrating stale input', () => {
  const f = fixture([channel('load', { maxAgeMs: 10 })]); f.publisher.ingest(frame(1, 0, [value(5)]));
  f.set(9.5); f.owner.advance(); assert.equal(state(f.owner.snapshot()).raw, 5);
  f.set(10); f.owner.advance(); let s = f.owner.snapshot().channels[0]!;
  assert.equal(s.validity, 'UNKNOWN'); assert.equal(s.reason, 'expired'); assert.equal(s.fast, null); assert.equal(s.raw, null);
  f.set(200); f.publisher.ingest(frame(2, 200, [value(9)]));
  assert.equal(state(f.owner.snapshot()).fast, 9); assert.equal(state(f.owner.snapshot()).slow, 9);
  f.set(201); f.publisher.ingest(frame(3, 201, [{ channelId: 'load', kind: 'unknown', reason: 'permission-denied' }]));
  s = f.owner.snapshot().channels[0]!; assert.equal(s.validity, 'UNKNOWN'); assert.equal(s.raw, null); assert.equal(s.reason, 'permission-denied');
  f.set(202); f.publisher.ingest(frame(4, 202, [value(3)])); assert.equal(state(f.owner.snapshot()).fast, 3);
  f.set(300); assert.equal(f.publisher.ingest(frame(5, 220, [value(8)])), 'accepted');
  s = f.owner.snapshot().channels[0]!; assert.equal(s.reason, 'expired'); assert.equal(s.expiresAtMs, 230); assert.equal(s.receivedAtMs, 300);
  assert.equal(f.owner.snapshot().sequence, 5); assert.equal(s.raw, null);
});

test('duplicate frame semantics are bounded to latest only and never call the clock or renew validity', () => {
  const f = fixture([channel(), channel('other')]), first = frame(1, 0, [value(-0), value(3, 'other')]);
  f.publisher.ingest(first); const before = f.owner.snapshot(), reads = f.reads(); f.set(900);
  assert.equal(f.publisher.ingest(frame(1, -0, [value(3, 'other'), value(0)])), 'duplicate');
  assert.deepEqual(f.owner.snapshot(), before); assert.equal(f.reads(), reads); assert.equal(Object.is(state(before).raw, -0), false);
  assert.throws(() => f.publisher.ingest(frame(1, 0, [value(7), value(3, 'other')])), /BODY_SEQUENCE_CONFLICT/);
  assert.deepEqual(f.owner.snapshot(), before);
  f.publisher.ingest(frame(2, 900, [value(1), value(2, 'other')])); const next = f.owner.snapshot();
  assert.throws(() => f.publisher.ingest(first), /BODY_SEQUENCE_OLD/); assert.deepEqual(f.owner.snapshot(), next);
  f.set(1900); f.owner.advance(); const expired = f.owner.snapshot();
  assert.equal(f.publisher.ingest(frame(2, 900, [value(1), value(2, 'other')])), 'duplicate'); assert.deepEqual(f.owner.snapshot(), expired);
});

test('source rebind fences the old publisher and new publishers reject explicitly old-boot frames', () => {
  const f = fixture(); f.publisher.ingest(frame(1, 0, [value(7)])); const old = f.owner.snapshot(); f.set(10);
  const next = f.owner.bindSource({ sourceId: 'host-source', bootId: 'boot-two' });
  assert.notEqual(f.owner.snapshot().source!.epoch, old.source!.epoch); assert.equal(f.owner.snapshot().sequence, null);
  assert.equal(f.owner.snapshot().channels[0]!.raw, null); assert.equal(f.owner.snapshot().asOfMonotonicMs, 10);
  assert.throws(() => f.publisher.ingest(frame(2, 10)), /BODY_SOURCE_FENCED/);
  assert.throws(() => next.ingest(frame(1, 10)), /BODY_SOURCE_IDENTITY/);
  assert.throws(() => next.ingest({ ...frame(1, 10, [value(1)], 'boot-two'), sourceId: 'alien' }), /BODY_SOURCE_IDENTITY/);
  assert.throws(() => next.ingest(frame(1, 9, [value(1)], 'boot-two')), /BODY_SAMPLE_LATE/);
  next.ingest(frame(1, 10, [value(1)], 'boot-two')); assert.equal(state(f.owner.snapshot()).fast, 1);
  const rebound = f.owner.bindSource({ sourceId: 'host-source', bootId: 'boot-two' });
  assert.throws(() => next.ingest(frame(2, 10, [value(2)], 'boot-two')), /BODY_SOURCE_FENCED/);
  assert.equal(f.owner.snapshot().channels[0]!.raw, null); assert.ok(Object.isFrozen(rebound));
});

for (const kind of ['rollback', 'NaN', 'infinity', 'negative', 'throw'] as const) test(`host clock ${kind} permanently faults owner without rebind revival`, () => {
  const f = fixture(); f.publisher.ingest(frame(1, 0)); f.set(20); f.owner.advance();
  if (kind === 'throw') f.throwClock(); else f.set(kind === 'rollback' ? 19 : kind === 'NaN' ? NaN : kind === 'infinity' ? Infinity : -1);
  assert.throws(() => f.owner.advance(), /BODY_CLOCK/); const fault = f.owner.snapshot();
  assert.equal(fault.status, 'CLOCK_FAULT'); assert.equal(fault.source, null); assert.equal(fault.channels[0]!.raw, null);
  f.set(100); assert.throws(() => f.owner.bindSource({ sourceId: 'host-source', bootId: 'new' }), /BODY_UNAVAILABLE/);
  assert.throws(() => f.publisher.ingest(frame(2, 100)), /BODY_UNAVAILABLE/); assert.throws(() => f.owner.advance(), /BODY_UNAVAILABLE/);
  f.owner.close(); assert.deepEqual(f.owner.snapshot(), fault);
});

test('rejected data cannot erase a previously observed host clock high-water mark', () => {
  const f = fixture(); f.publisher.ingest(frame(1, 0)); f.set(20);
  assert.throws(() => f.publisher.ingest(frame(2, 21)), /BODY_SAMPLE_FUTURE/); assert.equal(f.owner.snapshot().asOfMonotonicMs, 0);
  f.set(19); assert.throws(() => f.owner.advance(), /BODY_CLOCK/);
});

test('new ingest and source rebind also observe clock failure; duplicates and snapshots do not poll it', () => {
  for (const operation of ['ingest', 'bind'] as const) {
    const f = fixture(); f.publisher.ingest(frame(1, 0)); const before = f.owner.snapshot(), reads = f.reads(); f.throwClock();
    assert.equal(f.publisher.ingest(frame(1, 0)), 'duplicate'); assert.deepEqual(f.owner.snapshot(), before); assert.equal(f.reads(), reads);
    assert.throws(() => operation === 'ingest' ? f.publisher.ingest(frame(2, 1)) : f.owner.bindSource({ sourceId: 'new', bootId: 'new' }), /BODY_CLOCK/);
    assert.equal(f.owner.snapshot().status, 'CLOCK_FAULT'); assert.equal(f.owner.snapshot().channels[0]!.raw, null);
  }
});

test('owners are isolated; close is idempotent and immediately invalidates its publisher', () => {
  const a = fixture(), b = fixture(); a.publisher.ingest(frame(1, 0, [value(8)])); b.publisher.ingest(frame(1, 0, [value(2)]));
  assert.notEqual(a.owner.snapshot().ownerEpoch, b.owner.snapshot().ownerEpoch); const originalB = b.owner.snapshot();
  a.owner.close(); a.owner.close(); assert.equal(a.owner.snapshot().status, 'CLOSED'); assert.equal(a.owner.snapshot().channels[0]!.raw, null);
  assert.throws(() => a.publisher.ingest(frame(2, 1)), /BODY_UNAVAILABLE/); assert.deepEqual(b.owner.snapshot(), originalB);
});

test('configuration, source, frame and nested snapshots cannot be mutated into owner state', () => {
  let now = 0; const c = { ...channel() }, channels = [c], config = { deviceId: 'device', clockDomain: 'clock', clock: () => now, channels };
  const owner = new BodyStateOwner(config), source = { sourceId: 'host-source', bootId: 'boot-one' }, publisher = owner.bindSource(source);
  c.high = 100; channels.push(channel('extra')); config.deviceId = 'changed'; source.bootId = 'changed';
  const r = { channelId: 'load', kind: 'value' as const, value: 4 }, input = { ...frame(1, 0), readings: [r] }; publisher.ingest(input);
  input.observedAtMs = 999; r.value = 10;
  const s = owner.snapshot(); assert.equal(s.deviceId, 'device'); assert.equal(s.channels.length, 1);
  assert.equal(state(s).normalized!.raw, 0.4); assert.equal(s.source!.bootId, 'boot-one');
  for (const mutate of [() => { (s as any).sequence = 99; }, () => { (s.channels as any).push({}); },
    () => { (s.channels[0]!.channel as any).high = 999; }, () => { (state(s).normalized as any).raw = 9; }, () => { (s.source as any).bootId = 'x'; }]) assert.throws(mutate, TypeError);
  assert.deepEqual(owner.snapshot(), s); now = 1; owner.advance(); assert.equal(state(owner.snapshot()).raw, 4);
});

test('closed shapes, gauge/channel/time bounds and nonfinite values fail before acceptance without invoking accessors', () => {
  const base = { deviceId: 'device', clockDomain: 'clock', clock: () => 0, channels: [channel()] };
  for (const overrides of [{ low: 10 }, { high: Infinity }, { low: -Number.MAX_VALUE, high: Number.MAX_VALUE }, { fastTauMs: 0 },
    { fastTauMs: 101 }, { slowTauMs: BODY_STATE_LIMITS.maxTimeMs + 1 }, { maxAgeMs: -0 }, { unit: '' }])
    assert.throws(() => new BodyStateOwner({ ...base, channels: [channel('load', overrides)] }), /BODY_INVALID_INPUT/);
  for (const channels of [[], [channel(), channel()], Array.from({ length: 17 }, (_, i) => channel(String(i)))])
    assert.throws(() => new BodyStateOwner({ ...base, channels }), /BODY_INVALID_INPUT/);
  const boundary = new BodyStateOwner({ ...base, channels: Array.from({ length: 16 }, (_, i) => channel(String(i), { fastTauMs: 1, slowTauMs: 86_400_000, maxAgeMs: 86_400_000 })) });
  assert.equal(boundary.snapshot().channels.length, 16); boundary.close();
  let invoked = 0; const hostile = new Proxy({}, { get() { invoked++; throw Error('trap'); } });
  const f = fixture(), original = f.owner.snapshot();
  const getter = { ...frame(1, 0), get observedAtMs() { invoked++; return 0; } };
  const nestedGetter = { channelId: 'load', kind: 'value' as const, get value() { invoked++; return 0; } };
  for (const input of [hostile, getter, frame(1, 0, [nestedGetter]), { ...frame(1, 0), extra: 1 }, frame(1, 0, [value(Infinity)]), frame(1, NaN), frame(0, 0), frame(1.5, 0),
    frame(1, 0, [{ channelId: 'load', kind: 'unknown', reason: 'invented' } as any])])
    assert.throws(() => f.publisher.ingest(input as BodyFrame), /BODY_INVALID_INPUT/);
  assert.equal(invoked, 0); assert.deepEqual(f.owner.snapshot(), original);
  assert.throws(() => f.owner.bindSource({ sourceId: 'host-source', get bootId() { invoked++; return 'new'; } }), /BODY_INVALID_INPUT/);
  assert.deepEqual(f.owner.snapshot(), original); assert.equal(invoked, 0);
  assert.throws(() => new BodyStateOwner(hostile as BodyStateConfig), /BODY_INVALID_INPUT/); assert.equal(invoked, 0);
});

test('expiry overflow is atomic; finite extremes remain finite and normalized with raw out-of-range retained', () => {
  const nearEnd = fixture([channel('load', { maxAgeMs: 10 })], Number.MAX_SAFE_INTEGER - 5), before = nearEnd.owner.snapshot();
  assert.throws(() => nearEnd.publisher.ingest(frame(1, Number.MAX_SAFE_INTEGER - 5)), /BODY_TIME_RANGE/);
  assert.deepEqual(nearEnd.owner.snapshot(), before);
  const f = fixture(); f.publisher.ingest(frame(1, 0, [value(Number.MAX_VALUE)]));
  f.set(1); f.publisher.ingest(frame(2, 1, [value(-Number.MAX_VALUE)])); f.set(2); f.owner.advance(); const s = state(f.owner.snapshot());
  assert.equal(s.raw, -Number.MAX_VALUE); assert.ok(Number.isFinite(s.fast)); assert.ok(Number.isFinite(s.slow));
  assert.equal(s.normalized!.raw, 0); assert.equal(s.outOfRange, true);
});

test('trusted clock callbacks cannot reenter an operation or close/snapshot intermediate state', () => {
  let armed = false, now = 0, owner: BodyStateOwner;
  owner = new BodyStateOwner({ deviceId: 'device', clockDomain: 'clock', channels: [channel()], clock: () => {
    if (armed) for (const action of [() => owner.advance(), () => owner.close(), () => owner.snapshot(), () => owner.bindSource({ sourceId: 'x', bootId: 'x' })])
      assert.throws(action, /BODY_ACCESS_BUSY/);
    return now;
  } });
  const publisher = owner.bindSource({ sourceId: 'host-source', bootId: 'boot-one' }); armed = true; publisher.ingest(frame(1, 0));
  now = 2; owner.advance(); assert.equal(owner.snapshot().asOfMonotonicMs, 2); owner.close();
});

test('regression: the first constructor clock callback cannot expose or mutate a partial owner', () => {
  const actions = [(o: BodyStateOwner) => o.snapshot(), (o: BodyStateOwner) => o.close(),
    (o: BodyStateOwner) => o.bindSource({ sourceId: 'host-source', bootId: 'boot-one' }), (o: BodyStateOwner) => o.advance()];
  for (const action of actions) {
    let attempted = false, error: unknown, calls = 0;
    const owner = new BodyStateOwner({ deviceId: 'device', clockDomain: 'clock', channels: [channel()],
      clock: function (this: BodyStateOwner) {
        calls++;
        if (!attempted) { attempted = true; try { action(this); } catch (caught) { error = caught; } }
        return 0;
      } });
    assert.match(String(error), /BODY_ACCESS_BUSY/); assert.equal(calls, 1);
    const snapshot = owner.snapshot(); assert.equal(snapshot.status, 'ACTIVE'); assert.equal(snapshot.asOfMonotonicMs, 0);
    assert.equal(snapshot.source, null); assert.equal(snapshot.sequence, null); assert.equal(snapshot.channels[0]!.reason, 'unbound');
    const publisher = owner.bindSource({ sourceId: 'host-source', bootId: 'boot-one' });
    assert.equal(publisher.ingest(frame(1, 0)), 'accepted'); owner.close();
  }
  let failedOwner: BodyStateOwner | undefined;
  assert.throws(() => new BodyStateOwner({ deviceId: 'device', clockDomain: 'clock', channels: [channel()],
    clock: function (this: BodyStateOwner) { failedOwner = this; this.snapshot(); return 0; } }), /BODY_CLOCK/);
  assert.ok(failedOwner); assert.throws(() => failedOwner!.snapshot(), /BODY_ACCESS_BUSY/);
  assert.throws(() => failedOwner!.bindSource({ sourceId: 'host-source', bootId: 'boot-one' }), /BODY_UNAVAILABLE/);
});

const relativeNear = (actual: number, expected: number) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= Math.max(2 * Number.MIN_VALUE, 1e-12 * Math.abs(expected)), `${actual} != ${expected}`);
function filteredStep(initial: number, input: number, elapsed: number, partitions: number) {
  const f = fixture([channel('load', { fastTauMs: 1, slowTauMs: 1, maxAgeMs: 10_000 })]);
  f.publisher.ingest(frame(1, 0, [value(initial)])); f.set(1); f.publisher.ingest(frame(2, 1, [value(input)]));
  for (let i = 1; i <= partitions; i++) { f.set(1 + elapsed * i / partitions); f.owner.advance(); }
  const s = state(f.owner.snapshot()); assert.equal(s.raw, input); assert.equal(s.expiresAtMs, 10_001);
  assert.equal(s.fast, s.slow); return s.fast;
}

test('regression: large dynamic ranges retain endpoints and residuals under partitioned advance', () => {
  for (const sign of [1, -1]) for (const c of [
    { initial: 1e16, input: 1, elapsed: 100, expected: 1 },
    { initial: Number.MAX_VALUE, input: 1, elapsed: 40, expected: Number.MAX_VALUE * Math.exp(-40) },
    // This oracle never forms the overflowing difference between opposite endpoints.
    { initial: Number.MAX_VALUE, input: -Number.MAX_VALUE, elapsed: 1, expected: Number.MAX_VALUE * (2 * Math.exp(-1) - 1) },
  ]) {
    const jump = filteredStep(sign * c.initial, sign * c.input, c.elapsed, 1);
    const split = filteredStep(sign * c.initial, sign * c.input, c.elapsed, 100);
    relativeNear(jump, sign * c.expected); relativeNear(split, sign * c.expected); relativeNear(jump, split);
  }
});

test('regression: a decay factor underflow must not erase a representable finite product', () => {
  for (const sign of [1, -1]) for (const elapsed of [700, 744, 746, 1000, 1450, 1500]) {
    // Independent log-domain solution; unlike exp(-elapsed), its product can remain nonzero.
    const expected = sign * Math.exp(Math.log(Number.MAX_VALUE) - elapsed);
    const jump = filteredStep(sign * Number.MAX_VALUE, 0, elapsed, 1);
    const split = filteredStep(sign * Number.MAX_VALUE, 0, elapsed, 100);
    relativeNear(jump, expected); relativeNear(split, expected); relativeNear(jump, split);
    if (expected !== 0) { assert.notEqual(jump, 0); assert.notEqual(split, 0); }
  }
});
