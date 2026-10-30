import { canonical, hash } from './wf1-json.ts';
import type { Candidate, Item, ProductionSlot } from './corpus-production-types.ts';

const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
function grams(text: string): Set<string> {
  const chars = Array.from(normalized(text));
  if (chars.length < 5) return new Set([chars.join('')]);
  const result = new Set<string>();
  for (let i = 0; i <= chars.length - 5; i++) result.add(chars.slice(i, i + 5).join(''));
  return result;
}
function simhash(values: Set<string>): string {
  const weights = new Int32Array(64);
  for (const value of values) {
    let bits = BigInt('0x' + hash(value).slice(0, 16));
    for (let i = 0; i < 64; i++) {
      weights[i]! += bits & 1n ? 1 : -1;
      bits >>= 1n;
    }
  }
  let value = 0n;
  for (let i = 0; i < 64; i++) if (weights[i]! >= 0) value |= 1n << BigInt(i);
  return value.toString(16).padStart(16, '0');
}
const distance = (a: string, b: string) => {
  let value = BigInt('0x' + a) ^ BigInt('0x' + b),
    count = 0;
  while (value) {
    value &= value - 1n;
    count++;
  }
  return count;
};
export function candidateFingerprints(candidate: Candidate) {
  return {
    candidateDigest: hash(canonical(candidate)),
    exactDigest: hash(canonical({ prompt: candidate.prompt, response: candidate.response })),
    normalizedDigest: hash(
      canonical({ prompt: normalized(candidate.prompt), response: normalized(candidate.response) }),
    ),
    promptDigest: hash(normalized(candidate.prompt)),
    sketch: simhash(grams(candidate.prompt + '\n' + candidate.response)),
  };
}
/** Lexical near-duplicate gate only. No semantic novelty or factual accuracy claim. */
export function duplicateMatches(candidate: Candidate, rows: Item[], read: (item: Item) => Candidate): Item[] {
  const current = candidateFingerprints(candidate),
    matches: Item[] = [];
  let currentGrams: Set<string> | null = null;
  for (const row of rows) {
    if (row.unitId === candidate.unitId || !row.candidateRef) continue;
    if (
      row.exactDigest === current.exactDigest ||
      row.normalizedDigest === current.normalizedDigest ||
      row.promptDigest === current.promptDigest
    ) {
      matches.push(row);
      continue;
    }
    if (row.sketch && distance(row.sketch, current.sketch) <= 8) {
      const old = read(row),
        a = (currentGrams ??= grams(candidate.prompt + '\n' + candidate.response)),
        b = grams(old.prompt + '\n' + old.response);
      let intersection = 0;
      for (const g of a) if (b.has(g)) intersection++;
      if (intersection / (a.size + b.size - intersection) >= 0.85) matches.push(row);
    }
  }
  return matches;
}
export function splitConflict(a: ProductionSlot, b: ProductionSlot) {
  return a.split !== b.split;
}
