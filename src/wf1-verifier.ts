import { canonical, copyJson, digest, hash, list, oneOf, parseJson, shape, stop, text, Wf1Error } from './wf1-json.ts';
import type { FormalEvidence, FormalSpec, Json } from './wf1-types.ts';
import { readFileSync } from 'node:fs';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const VERIFIER_CATALOG = freeze({
  version: 'wf1-verifiers/1',
  operations: [
    {
      id: 'rational.evaluate.v1',
      input:
        'Closed AST: {op:"value",numerator:decimalIntegerString,denominator:positiveDecimalIntegerString} or {op:"add"|"sub"|"mul"|"div",left:AST,right:AST}',
      target: '{numerator:canonicalDecimalIntegerString,denominator:canonicalPositiveDecimalIntegerString}',
      maxNodes: 31,
      maxDepth: 6,
      inputBits: 128,
      intermediateBits: 4096,
    },
    {
      id: 'json.pointer.v1',
      input: '{document:strictJSON,pointer:RFC6901String}',
      target: 'canonical selected JSON subtree',
      maxBytes: 16384,
      maxDepth: 16,
      maxNodes: 2048,
      maxPointerBytes: 256,
    },
  ],
});
const BUILD = hash(
  Buffer.concat(
    ['wf1-verifier.ts', 'wf1-json.ts', 'wf1-types.ts'].map((name) => readFileSync(new URL(name, import.meta.url))),
  ),
);
function bits(n: bigint, max: number): void {
  if ((n < 0n ? -n : n).toString(2).length > max) stop('WF1_FORMAL_LIMIT');
}
function big(value: unknown, positive = false): bigint {
  const s = text(value, 42);
  if (!/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(s)) stop('WF1_FORMAL_NUMBER');
  const n = BigInt(s);
  bits(n, 128);
  if (positive && n <= 0n) stop('WF1_FORMAL_NUMBER');
  return n;
}
function normalize(n: bigint, d: bigint): [bigint, bigint] {
  if (d === 0n) stop('WF1_FORMAL_DIV_ZERO');
  bits(n, 4096);
  bits(d, 4096);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return [n / a, d / a];
}
function rational(input: unknown): Json {
  let nodes = 0;
  function run(value: unknown, depth: number): [bigint, bigint] {
    if (++nodes > 31 || depth > 6) stop('WF1_FORMAL_LIMIT');
    if (!value || typeof value !== 'object') stop('WF1_FORMAL_SHAPE');
    const op = (value as Record<string, unknown>).op;
    if (op === 'value') {
      const a = shape(value, ['op', 'numerator', 'denominator']);
      return normalize(big(a.numerator), big(a.denominator, true));
    }
    const a = shape(value, ['op', 'left', 'right']);
    oneOf(a.op, ['add', 'sub', 'mul', 'div']);
    const [n, d] = run(a.left, depth + 1),
      [m, e] = run(a.right, depth + 1);
    return op === 'add'
      ? normalize(n * e + m * d, d * e)
      : op === 'sub'
        ? normalize(n * e - m * d, d * e)
        : op === 'mul'
          ? normalize(n * m, d * e)
          : normalize(n * e, d * m);
  }
  const [n, d] = run(input, 1);
  return { numerator: n.toString(), denominator: d.toString() };
}
function pointer(input: unknown): Json {
  const p = shape(input, ['document', 'pointer']);
  const raw = canonical(p.document),
    document = parseJson(raw, { bytes: 16384, depth: 16, nodes: 2048, stringBytes: 16384 });
  const path = text(p.pointer, 256, 0);
  if (path !== '' && !path.startsWith('/')) stop('WF1_POINTER');
  let selected: Json = document;
  for (const token of path === '' ? [] : path.slice(1).split('/')) {
    if (/~(?![01])/u.test(token)) stop('WF1_POINTER');
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(selected)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !Object.hasOwn(selected, key)) stop('WF1_POINTER');
      selected = selected[Number(key)]!;
    } else if (selected !== null && typeof selected === 'object' && Object.hasOwn(selected, key))
      selected = selected[key]!;
    else stop('WF1_POINTER');
  }
  return selected;
}
export function validateFormal(value: unknown): FormalSpec {
  const own = copyJson(value),
    f = shape(own, ['verifier', 'input']);
  oneOf(f.verifier, ['rational.evaluate.v1', 'json.pointer.v1']);
  // Recompute also validates the complete supported formal input.
  if (f.verifier === 'rational.evaluate.v1') rational(f.input);
  else pointer(f.input);
  return f as FormalSpec;
}
export function computeFormal(value: unknown): Json {
  const f = validateFormal(value);
  return f.verifier === 'rational.evaluate.v1' ? rational(f.input) : pointer(f.input);
}
/** No natural-language mapping, explanation or reasoning is a selected loss target. */
export function verifyFormal(value: unknown, target: unknown): FormalEvidence {
  let inputCommitment = hash('unsupported-input'),
    targetCommitment = hash('unsupported-target');
  try {
    const f = validateFormal(value),
      t = copyJson(target);
    inputCommitment = hash(canonical(f));
    targetCommitment = hash(canonical(t));
    const expected = computeFormal(f);
    return {
      status: canonical(expected) === canonical(t) ? 'VERIFIED' : 'CONTRADICTED',
      claimScope: f.verifier === 'rational.evaluate.v1' ? 'EXACT_RATIONAL' : 'JSON_SELECTED_SUBTREE',
      selectedTargetCoverage: 'COMPLETE',
      inputCommitment,
      targetCommitment,
      verifierBuild: BUILD,
    };
  } catch (e) {
    if (!(e instanceof Wf1Error)) throw e;
    return {
      status: 'UNSUPPORTED',
      claimScope: 'NONE',
      selectedTargetCoverage: 'NONE',
      inputCommitment,
      targetCommitment,
      verifierBuild: BUILD,
    };
  }
}
/** Exact formal representation fingerprint. Shared operation/catalog is not ancestry evidence.
 * Template derivation must be supplied in complete roots; hidden semantic copies stay unproved. */
export function formalFingerprint(value: unknown): string {
  return hash(canonical(validateFormal(value)));
}
export function formalCommitment(value: unknown): string {
  return hash(canonical(validateFormal(value)));
}
