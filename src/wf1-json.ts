import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { Json } from './wf1-types.ts';

export class Wf1Error extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'Wf1Error';
  }
}
export function stop(code: string): never {
  throw new Wf1Error(code);
}
export function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) stop('WF1_SHAPE');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) stop('WF1_SHAPE');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((k) => !descriptors[k] || !Object.hasOwn(descriptors[k], 'value') || !descriptors[k].enumerable)
  )
    stop('WF1_FIELDS');
  return value as Record<string, unknown>;
}
export function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) stop('WF1_SHAPE');
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((k) => typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    stop('WF1_FIELDS');
  return shape(value, keys as string[]);
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || Number(value) < min || Number(value) > max)
    stop('WF1_NUMBER');
  return value as number;
}
export function text(value: unknown, max = 4096, min = 1): string {
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value, 'utf8') > max || value.includes('\0'))
    stop('WF1_TEXT');
  unicode(value);
  return value;
}
export function id(value: unknown): string {
  const s = text(value, 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(s)) stop('WF1_ID');
  return s;
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) stop('WF1_DIGEST');
  return value;
}
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) stop('WF1_ENUM');
  return value as T;
}
export function list(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) stop('WF1_LIMIT');
  return value;
}
export function unique(values: string[]): void {
  if (new Set(values).size !== values.length) stop('WF1_DUPLICATE');
}
function unicode(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) stop('WF1_UNICODE');
    } else if (c >= 0xdc00 && c <= 0xdfff) stop('WF1_UNICODE');
  }
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
export const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Content profile, independent from frozen WF0. Signed decimal safe integers only; no floats/exponents. */
export function parseJson(
  raw: string,
  limits = { bytes: 262_144, depth: 32, nodes: 16_384, stringBytes: 65_536 },
): Json {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > limits.bytes) stop('WF1_JSON_LIMIT');
  let pos = 0,
    nodes = 0;
  const ws = () => {
    while (pos < raw.length && /[\x20\x09\x0a\x0d]/.test(raw[pos]!)) pos++;
  };
  function string(): string {
    const start = pos++;
    while (pos < raw.length) {
      const c = raw.charCodeAt(pos++);
      if (c === 34) {
        let s: string;
        try {
          s = JSON.parse(raw.slice(start, pos)) as string;
        } catch {
          return stop('WF1_JSON');
        }
        if (Buffer.byteLength(s, 'utf8') > limits.stringBytes) stop('WF1_JSON_LIMIT');
        unicode(s);
        return s;
      }
      if (c < 32) stop('WF1_JSON');
      if (c === 92) {
        const e = raw[pos++];
        if (e === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(raw.slice(pos, pos + 4))) stop('WF1_JSON');
          pos += 4;
        } else if (!e || !'"\\/bfnrt'.includes(e)) stop('WF1_JSON');
      }
    }
    return stop('WF1_JSON');
  }
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function value(depth: number): Json {
    if (depth > limits.depth || ++nodes > limits.nodes) stop('WF1_JSON_LIMIT');
    ws();
    const c = raw[pos];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      pos++;
      ws();
      const isObject = c === '{',
        end = isObject ? '}' : ']';
      const obj: Record<string, Json> = Object.create(null) as Record<string, Json>,
        array: Json[] = [];
      if (raw[pos] === end) {
        pos++;
        return isObject ? obj : array;
      }
      let entries = 0;
      while (true) {
        if (++entries > 4096) stop('WF1_JSON_LIMIT');
        ws();
        let key = '';
        if (isObject) {
          if (raw[pos] !== '"') stop('WF1_JSON');
          key = string();
          if (Object.hasOwn(obj, key)) stop('WF1_DUPLICATE_KEY');
          ws();
          if (raw[pos++] !== ':') stop('WF1_JSON');
        }
        const child = value(depth + 1);
        if (isObject) obj[key] = child;
        else array.push(child);
        ws();
        const next = raw[pos++];
        if (next === end) break;
        if (next !== ',') stop('WF1_JSON');
      }
      return isObject ? obj : array;
    }
    for (const [token, result] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ] as const)
      if (raw.startsWith(token, pos)) {
        pos += token.length;
        return result;
      }
    number.lastIndex = pos;
    const m = number.exec(raw);
    if (!m || m[0].length > 32) stop('WF1_JSON');
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(m[0])) stop('WF1_NUMBER');
    const n = Number(m[0]);
    integer(n, -Number.MAX_SAFE_INTEGER);
    pos = number.lastIndex;
    return n;
  }
  const result = value(0);
  ws();
  if (pos !== raw.length) stop('WF1_JSON');
  return result;
}
export function copyJson(value: unknown): Json {
  // Public object inputs must be data-only; do not invoke accessors/toJSON/proxy traps.
  const active = new Set<object>();
  let count = 0,
    bytes = 0;
  const charge = (length: number): void => {
    bytes += length;
    if (bytes > 262144) stop('WF1_JSON_LIMIT');
  };
  const stringCost = (value: string): void => {
    text(value, 65536, 0);
    charge(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  };
  function visit(v: unknown, depth: number): Json {
    if (++count > 16384 || depth > 32) stop('WF1_JSON_LIMIT');
    if (v === null || typeof v === 'boolean') {
      charge(v === null ? 4 : v ? 4 : 5);
      return v;
    }
    if (typeof v === 'number') {
      integer(v, -Number.MAX_SAFE_INTEGER);
      charge(String(v).length);
      return v;
    }
    if (typeof v === 'string') {
      stringCost(v);
      return v;
    }
    if (!v || typeof v !== 'object' || types.isProxy(v) || active.has(v)) stop('WF1_SHAPE');
    const arr = Array.isArray(v);
    if (
      Object.getPrototypeOf(v) !== (arr ? Array.prototype : Object.prototype) &&
      !(Object.getPrototypeOf(v) === null && !arr)
    )
      stop('WF1_SHAPE');
    const keys = Reflect.ownKeys(v);
    if (keys.length > 4097) stop('WF1_JSON_LIMIT');
    active.add(v);
    charge(2 + Math.max(0, keys.length - (arr ? 1 : 0) - 1));
    const out: Record<string, Json> = Object.create(null) as Record<string, Json>,
      items: Json[] = [];
    for (const k of keys) {
      if (arr && k === 'length') continue;
      if (typeof k !== 'string') stop('WF1_FIELDS');
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!d.enumerable || !Object.hasOwn(d, 'value')) stop('WF1_FIELDS');
      if (arr) {
        if (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length) stop('WF1_FIELDS');
        items[Number(k)] = visit(d.value, depth + 1);
      } else {
        stringCost(k);
        charge(1);
        out[k] = visit(d.value, depth + 1);
      }
    }
    if (arr && (items.length !== v.length || keys.length !== v.length + 1)) stop('WF1_FIELDS');
    active.delete(v);
    return arr ? items : out;
  }
  return parseJson(canonical(visit(value, 0)));
}
