import type { Epoch, MemoryRecord, SourceRef } from './contracts.ts';
import type { Frozen } from './curation-types.ts';

export const RETRIEVAL_LIMITS = Object.freeze({ selected:32, nodes:128, edges:512, bytes:262_144 });
export const RETRIEVAL_PROJECTION_LIMITS = Object.freeze({ nodes:128, edges:512, bytes:262_144 });
export type RetrievalAuthority = Epoch & { runtimeEpoch:number };
export type RetrievalSnapshot = Frozen<{
  version:1; authority:RetrievalAuthority; asOf:number;
  selected:Array<{ memory:MemoryRecord; rootEventRefs:SourceRef[] }>;
  counts:{ selected:number; nodes:number; edges:number; bytes:number };
}>;
export type RetrievalBinding = Readonly<{ version:1 }>;
export type RetrievalCandidate = Readonly<{ version:1 }>;
export type RetrievalHitKind = 'direct_lexical'|'shared_root';
export type RetrievalResult = Frozen<{
  version:1; projectionRevision:number; asOf:number;
  hits:Array<{ memory:MemoryRecord; rootEventRefs:SourceRef[]; kind:RetrievalHitKind }>;
}>;
