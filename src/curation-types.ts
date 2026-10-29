import type { Epoch, Evidence, MemoryRecord, SourceRef } from './contracts.ts';

export type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export const CURATION_LIMITS = Object.freeze({ selected: 32, nodes: 128, edges: 512, bytes: 262_144, rows: 128 });
export type CurationAuthority = Epoch & { runtimeEpoch: number; learningAllowed: true };
export type CurationNode = SourceRef & {
  type: 'event' | 'memory';
  generation: number;
  consentRevision: number;
  recordedAt: number;
  validFrom: number | null;
  validTo: number | null;
};
export type CurationEdge = { child: SourceRef; parent: SourceRef };
export type CurationSnapshot = Frozen<{
  version: 1;
  authority: CurationAuthority;
  asOf: number;
  selected: Array<{ memory: MemoryRecord; contentKind: 'derived_memory'; rootEventRefs: SourceRef[] }>;
  events: Array<{ ref: SourceRef; evidence: Evidence }>;
  closure: { nodes: CurationNode[]; edges: CurationEdge[] };
  counts: { selected: number; nodes: number; edges: number; bytes: number };
}>;

/** New detached copies only: never freeze a caller-owned policy, ref or evidence. */
export function frozenCopy<T>(input: T): Frozen<T> {
  const copy = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy as Frozen<T>;
}
/** All callers supply validated finite JSON values. Hashes stay inside RAM manifests. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
