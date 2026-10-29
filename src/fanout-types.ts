export const FANOUT_LIMITS = Object.freeze({
  batches: 512,
  batchItems: 4096,
  totalItems: 16384,
  consumers: 32,
  scopes: 64,
  scopeNodes: 512,
  scopeEdges: 2048,
  projectionBytes: 1024 * 1024,
});
export const FANOUT_PROFILES = ['retrieval-refs-v1', 'scene-source-refs-v1'] as const;
export type FanoutProfile = (typeof FANOUT_PROFILES)[number];
export type ConsumerHandle = {
  id: string;
  generation: number;
  profile: FanoutProfile;
  scopeId: string;
  bootId: string;
  authority: { generation: number; consentRevision: number; runtimeEpoch: number };
};
export type ConsumerStatus = {
  id: string;
  scopeId: string;
  profile: FanoutProfile;
  generation: number;
  required: boolean;
  status: 'active' | 'paused' | 'reset_required';
  applied: number;
  baseline: number;
  head: number;
  floor: number;
};
export type MetadataRef = {
  id: string;
  revision: number;
  type: 'event' | 'memory';
  generation: number;
  consentRevision: number;
  recordedAt: number;
  validFrom: number | null;
  validTo: number | null;
  parents: Array<{ id: string; revision: number }>;
  rootEventRefs: Array<{ id: string; revision: number }>;
  origin?: { mode: string; speakerRole: string; occurredAt: number | null };
};
export type ConsumerProjection = {
  version: 1;
  profile: FanoutProfile;
  scopeId: string;
  generation: number;
  applied: number;
  asOf: number;
  refs: MetadataRef[];
};
export type JournalItem = {
  scopeId: string;
  kind: string;
  entityId: string;
  relatedId: string | null;
  operation: string;
};
export type JournalBatch = {
  sequence: number;
  phase: string;
  asOf: number;
  revocationHighWater: number;
  digest: string;
  items: JournalItem[];
};
export type FanoutFault = 'before-journal-finalize' | 'after-projection-write' | 'before-consumer-checkpoint';
