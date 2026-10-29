import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { fail } from './validation.ts';

/** Engineering input bounds, not sensor calibration or physiological constants. */
export const BODY_STATE_LIMITS = Object.freeze({ channels: 16, labelBytes: 128, minTimeMs: 1, maxTimeMs: 86_400_000 });
export type BodyChannel = Readonly<{ id: string; unit: string; calibrationVersion: string; low: number; high: number;
  fastTauMs: number; slowTauMs: number; maxAgeMs: number }>;
export type BodyStateConfig = Readonly<{ deviceId: string; clockDomain: string; clock: () => number; channels: readonly BodyChannel[] }>;
export type BodySource = Readonly<{ sourceId: string; bootId: string }>;
export type BodyMissingReason = 'missing' | 'unsupported' | 'permission-denied' | 'sensor-error';
export type BodyReading = Readonly<{ channelId: string; kind: 'value'; value: number }>
  | Readonly<{ channelId: string; kind: 'unknown'; reason: BodyMissingReason }>;
export type BodyFrame = Readonly<{ sourceId: string; bootId: string; sequence: number; observedAtMs: number; readings: readonly BodyReading[] }>;
export type BodyPublisher = Readonly<{ ingest(frame: BodyFrame): 'accepted' | 'duplicate' }>;
type UnknownReason = BodyMissingReason | 'unbound' | 'no-sample' | 'expired' | 'closed' | 'clock-fault';
type Times = { observedAtMs: number | null; receivedAtMs: number | null; expiresAtMs: number | null };
type State = (Times & { validity: 'UNKNOWN'; reason: UnknownReason; raw: null; fast: null; slow: null })
  | { validity: 'VALID_AT_AS_OF'; reason: null; raw: number; fast: number; slow: number;
      observedAtMs: number; receivedAtMs: number; expiresAtMs: number };
export type BodyChannelSnapshot = Readonly<State & { channel: BodyChannel;
  normalized: Readonly<{ raw: number; fast: number; slow: number }> | null; outOfRange: boolean | null }>;
export type BodySnapshot = Readonly<{ prototype: 'B0_STATE_PROTOTYPE'; semantics: 'AS_OF_ONLY_NOT_CURRENT_PERMISSION';
  ownerEpoch: string; deviceId: string; clockDomain: string; status: 'ACTIVE' | 'CLOSED' | 'CLOCK_FAULT';
  asOfMonotonicMs: number; source: Readonly<BodySource & { epoch: string }> | null;
  sequence: number | null; channels: readonly BodyChannelSnapshot[] }>;

// Only closed plain-data records are accepted. In-process intrinsics and the one
// explicitly injected host clock are trusted; input accessors/proxies are not.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('BODY_INVALID_INPUT');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) fail('BODY_INVALID_INPUT');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail('BODY_INVALID_INPUT');
    result[key] = d.value as unknown;
  }
  return result;
}
function array(value: unknown, count?: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > BODY_STATE_LIMITS.channels || (count !== undefined && value.length !== count)
    || Reflect.ownKeys(value).length !== value.length + 1) fail('BODY_INVALID_INPUT');
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail('BODY_INVALID_INPUT');
    result.push(d.value as unknown);
  }
  return result;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > BODY_STATE_LIMITS.labelBytes
    || /[\ud800-\udfff\u0000]/u.test(value) || Buffer.byteLength(value) > BODY_STATE_LIMITS.labelBytes) fail('BODY_INVALID_INPUT');
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('BODY_INVALID_INPUT');
  return value === 0 ? 0 : value; // -0 and +0 denote the same measurement/time.
}
function time(value: unknown): number {
  const n = finite(value); if (n < 0 || n > Number.MAX_SAFE_INTEGER) fail('BODY_INVALID_INPUT'); return n;
}
function duration(value: unknown): number {
  const n = finite(value);
  if (n < BODY_STATE_LIMITS.minTimeMs || n > BODY_STATE_LIMITS.maxTimeMs) fail('BODY_INVALID_INPUT'); return n;
}
function channel(value: unknown): BodyChannel {
  const r = record(value, ['id', 'unit', 'calibrationVersion', 'low', 'high', 'fastTauMs', 'slowTauMs', 'maxAgeMs']);
  const result = { id: label(r.id), unit: label(r.unit), calibrationVersion: label(r.calibrationVersion), low: finite(r.low), high: finite(r.high),
    fastTauMs: duration(r.fastTauMs), slowTauMs: duration(r.slowTauMs), maxAgeMs: duration(r.maxAgeMs) };
  if (result.low >= result.high || !Number.isFinite(result.high - result.low) || result.fastTauMs > result.slowTauMs) fail('BODY_INVALID_INPUT');
  return Object.freeze(result);
}
function source(value: unknown): BodySource {
  const r = record(value, ['sourceId', 'bootId']); return Object.freeze({ sourceId: label(r.sourceId), bootId: label(r.bootId) });
}
function frame(value: unknown, channels: readonly BodyChannel[]): BodyFrame {
  const r = record(value, ['sourceId', 'bootId', 'sequence', 'observedAtMs', 'readings']);
  const sequence = finite(r.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail('BODY_INVALID_INPUT');
  const readings = new Map<string, BodyReading>();
  for (const value of array(r.readings, channels.length)) {
    // Read the discriminant through its descriptor, never through an input getter.
    if (value === null || typeof value !== 'object' || isProxy(value)) fail('BODY_INVALID_INPUT');
    const d = Object.getOwnPropertyDescriptor(value, 'kind');
    if (!d || !Object.hasOwn(d, 'value')) fail('BODY_INVALID_INPUT');
    let reading: BodyReading;
    if (d.value === 'value') {
      const v = record(value, ['channelId', 'kind', 'value']); reading = { channelId: label(v.channelId), kind: 'value', value: finite(v.value) };
    } else if (d.value === 'unknown') {
      const v = record(value, ['channelId', 'kind', 'reason']);
      if (!['missing', 'unsupported', 'permission-denied', 'sensor-error'].includes(v.reason as string)) fail('BODY_INVALID_INPUT');
      reading = { channelId: label(v.channelId), kind: 'unknown', reason: v.reason as BodyMissingReason };
    } else fail('BODY_INVALID_INPUT');
    if (!channels.some(c => c.id === reading.channelId) || readings.has(reading.channelId)) fail('BODY_INVALID_INPUT');
    readings.set(reading.channelId, Object.freeze(reading));
  }
  return Object.freeze({ sourceId: label(r.sourceId), bootId: label(r.bootId), sequence, observedAtMs: time(r.observedAtMs),
    readings: Object.freeze(channels.map(c => readings.get(c.id)!)) });
}
function sameFrame(a: BodyFrame, b: BodyFrame): boolean {
  return a.sourceId === b.sourceId && a.bootId === b.bootId && a.sequence === b.sequence && a.observedAtMs === b.observedAtMs
    && a.readings.every((r, i) => { const s = b.readings[i]!; return r.channelId === s.channelId && r.kind === s.kind
      && (r.kind === 'value' && s.kind === 'value' ? r.value === s.value : r.kind === 'unknown' && s.kind === 'unknown' && r.reason === s.reason); });
}
function unknown(reason: UnknownReason, times: Times = { observedAtMs: null, receivedAtMs: null, expiresAtMs: null }): State {
  return { validity: 'UNKNOWN', reason, raw: null, fast: null, slow: null,
    observedAtMs: times.observedAtMs, receivedAtMs: times.receivedAtMs, expiresAtMs: times.expiresAtMs };
}
function decayed(value: number, ratio: number): number {
  if (ratio <= 512) return value * Math.exp(-ratio);
  // A tiny/underflowed exp(-ratio) can still have a representable product with
  // a large value. Four normal factors preserve such tails until the product
  // itself underflows; 512 is a numerical scaling boundary, not a time limit.
  const quarter = Math.exp(-ratio / 4);
  return ((value * quarter) * quarter) * quarter * quarter;
}
function filtered(previous: number, input: number, elapsed: number, tau: number): number {
  if (previous === input || elapsed === 0) return previous;
  const ratio = elapsed / tau, alpha = -Math.expm1(-ratio);
  // Choose the nearer endpoint to avoid subtracting the entire old value when
  // alpha rounds to one. Compute decay independently, never as 1 - alpha.
  // Opposite signs use a convex sum without an overflowing endpoint difference.
  const next = Math.sign(previous) === Math.sign(input)
    ? alpha <= 0.5 ? previous + alpha * (input - previous) : input + decayed(previous - input, ratio)
    : decayed(previous, ratio) + alpha * input;
  if (!Number.isFinite(next)) fail('BODY_NUMERIC'); return next === 0 ? 0 : next;
}
function normalized(value: number, c: BodyChannel): number {
  if (value <= c.low) return 0; if (value >= c.high) return 1;
  return Math.min(1, Math.max(0, (value - c.low) / (c.high - c.low)));
}

/** Host-driven, one-device RAM state. No collector, timer, Store, provider or permission. */
export class BodyStateOwner {
  readonly #ownerEpoch = randomUUID();
  readonly #deviceId: string;
  readonly #clockDomain: string;
  readonly #clock: () => number;
  readonly #channels: readonly BodyChannel[];
  #status: BodySnapshot['status'] = 'ACTIVE';
  #asOf: number;
  #lastClock: number | undefined;
  #source: (BodySource & { epoch: string; token: object }) | null = null;
  #latest: BodyFrame | null = null;
  #states: State[];
  #busy = true; // Includes the first clock callback; release only a complete owner.

  constructor(config: BodyStateConfig) {
    const r = record(config, ['deviceId', 'clockDomain', 'clock', 'channels']);
    this.#deviceId = label(r.deviceId); this.#clockDomain = label(r.clockDomain);
    if (typeof r.clock !== 'function' || isProxy(r.clock)) fail('BODY_INVALID_INPUT'); this.#clock = r.clock as () => number;
    const channels = array(r.channels).map(channel);
    if (new Set(channels.map(c => c.id)).size !== channels.length) fail('BODY_INVALID_INPUT');
    this.#channels = Object.freeze(channels); this.#states = channels.map(() => unknown('unbound'));
    this.#asOf = this.#now();
    this.#busy = false;
  }
  #exclusive<T>(body: () => T): T {
    if (this.#status !== 'ACTIVE') fail('BODY_UNAVAILABLE'); if (this.#busy) fail('BODY_ACCESS_BUSY');
    this.#busy = true; try { return body(); } finally { this.#busy = false; }
  }
  #now(): number {
    let value: unknown; try { value = this.#clock(); } catch { value = NaN; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
      || (this.#lastClock !== undefined && value < this.#lastClock)) {
      this.#status = 'CLOCK_FAULT'; this.#source = null; this.#latest = null;
      this.#states = this.#channels.map(() => unknown('clock-fault')); fail('BODY_CLOCK');
    }
    // Clock health is independent of frame acceptance. A rejected future/late
    // frame cannot erase an observed host-clock high water; asOf stays atomic.
    this.#lastClock = value === 0 ? 0 : value; return this.#lastClock;
  }
  #evolve(states: readonly State[], from: number, to: number): State[] {
    return states.map((s, i) => {
      if (s.validity === 'UNKNOWN') return { ...s };
      // Discard expired numerical state; no integration beyond its original expiry.
      if (to >= s.expiresAtMs) return unknown('expired', s);
      const c = this.#channels[i]!;
      return { ...s, fast: filtered(s.fast, s.raw, to - from, c.fastTauMs), slow: filtered(s.slow, s.raw, to - from, c.slowTauMs) };
    });
  }
  bindSource(input: BodySource): BodyPublisher {
    return this.#exclusive(() => {
      const binding = source(input), now = this.#now(), token = Object.freeze({}), epoch = randomUUID();
      this.#source = { ...binding, epoch, token }; this.#latest = null;
      this.#states = this.#channels.map(() => unknown('no-sample')); this.#asOf = now;
      return Object.freeze({ ingest: (value: BodyFrame) => this.#ingest(token, value) });
    });
  }
  #ingest(token: object, input: BodyFrame): 'accepted' | 'duplicate' {
    return this.#exclusive(() => {
      const binding = this.#source;
      if (!binding || binding.token !== token) fail('BODY_SOURCE_FENCED');
      const next = frame(input, this.#channels);
      if (next.sourceId !== binding.sourceId || next.bootId !== binding.bootId) fail('BODY_SOURCE_IDENTITY');
      if (this.#latest) {
        if (next.sequence < this.#latest.sequence) fail('BODY_SEQUENCE_OLD');
        if (next.sequence === this.#latest.sequence) {
          if (!sameFrame(next, this.#latest)) fail('BODY_SEQUENCE_CONFLICT');
          return 'duplicate'; // No clock call, age renewal, advancement or filter update.
        }
        if (next.observedAtMs <= this.#latest.observedAtMs) fail('BODY_OBSERVATION_ORDER');
      }
      const now = this.#now();
      if (next.observedAtMs < this.#asOf) fail('BODY_SAMPLE_LATE');
      if (next.observedAtMs > now) fail('BODY_SAMPLE_FUTURE');
      const expiries = this.#channels.map(c => {
        const expiry = next.observedAtMs + c.maxAgeMs;
        if (!Number.isFinite(expiry) || expiry > Number.MAX_SAFE_INTEGER || expiry <= next.observedAtMs) fail('BODY_TIME_RANGE'); return expiry;
      });
      const prior = this.#evolve(this.#states, this.#asOf, next.observedAtMs);
      const installed: State[] = next.readings.map((r, i) => {
        const times = { observedAtMs: next.observedAtMs, receivedAtMs: now, expiresAtMs: expiries[i]! };
        if (r.kind === 'unknown') return unknown(r.reason, times);
        const s = prior[i]!;
        return { ...times, validity: 'VALID_AT_AS_OF', reason: null, raw: r.value,
          fast: s.validity === 'VALID_AT_AS_OF' ? s.fast : r.value, slow: s.validity === 'VALID_AT_AS_OF' ? s.slow : r.value };
      });
      const states = this.#evolve(installed, next.observedAtMs, now);
      this.#states = states; this.#latest = next; this.#asOf = now; return 'accepted';
    });
  }
  advance(): void {
    this.#exclusive(() => {
      const now = this.#now(), states = this.#evolve(this.#states, this.#asOf, now);
      this.#states = states; this.#asOf = now;
    });
  }
  snapshot(): BodySnapshot {
    if (this.#busy) fail('BODY_ACCESS_BUSY');
    const channels = this.#states.map((s, i) => {
      const c = this.#channels[i]!;
      return Object.freeze({ ...s, channel: c,
        normalized: s.validity === 'VALID_AT_AS_OF' ? Object.freeze({ raw: normalized(s.raw, c), fast: normalized(s.fast, c), slow: normalized(s.slow, c) }) : null,
        outOfRange: s.validity === 'VALID_AT_AS_OF' ? s.raw < c.low || s.raw > c.high : null });
    });
    return Object.freeze({ prototype: 'B0_STATE_PROTOTYPE', semantics: 'AS_OF_ONLY_NOT_CURRENT_PERMISSION', ownerEpoch: this.#ownerEpoch,
      deviceId: this.#deviceId, clockDomain: this.#clockDomain, status: this.#status, asOfMonotonicMs: this.#asOf,
      source: this.#source ? Object.freeze({ sourceId: this.#source.sourceId, bootId: this.#source.bootId, epoch: this.#source.epoch }) : null,
      sequence: this.#latest?.sequence ?? null, channels: Object.freeze(channels) });
  }
  close(): void {
    if (this.#busy) fail('BODY_ACCESS_BUSY'); if (this.#status !== 'ACTIVE') return;
    this.#status = 'CLOSED'; this.#source = null; this.#latest = null;
    this.#states = this.#channels.map(() => unknown('closed'));
  }
}
