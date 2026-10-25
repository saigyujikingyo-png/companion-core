/** Versioned process boundary; no provider-specific prompts or hidden reasoning. */
export const PROTOCOL_VERSION = 1 as const;
export type ScopeIdentity = {
  tenantId: string; subjectId: string; personaId: string; relationshipId: string;
};
export type Scope = ScopeIdentity & {
  id: string; generation: number; consentRevision: number;
  learningAllowed: boolean; runtimeEpoch: number;
};
export type Epoch = Pick<Scope, 'id' | 'generation' | 'consentRevision'>;
export type SourceRef = { id: string; revision: number };
export type SpeakerRole = 'subject' | 'assistant' | 'third_party' | 'sensor';
export type Evidence = {
  speakerId: string; speakerRole: SpeakerRole;
  mode: 'self_report' | 'observation' | 'quotation' | 'inference';
  selectedText: string;
  occurredAt: number | null;
};
export type EventInput = { source: string; eventKey: string; evidence: Evidence };
export type MemoryKind = 'claim' | 'status' | 'belief' | 'commitment' | 'episode';
export type Proposal = {
  kind: MemoryKind; statement: string;
  basis: 'self_report' | 'observation' | 'inference';
  validFrom: number | null; validTo: number | null;
};
export type MemoryRecord = SourceRef & Proposal & {
  scopeId: string; generation: number; consentRevision: number;
  sourceRefs: SourceRef[]; recordedAt: number;
};
export type Lease = { token: string; expiresAt: number };
export type Job = { id: string; epoch: Epoch; sourceRefs: SourceRef[] };
export type Receipt = { id: string; currentStatus: 'active' | 'revoked' };
export type RunTicket = Epoch & { runtimeEpoch: number; artifactId: string | null };
export type ProjectionChange = { outboxId: number; operation: 'upsert'; record: MemoryRecord }
  | { outboxId: number; operation: 'remove'; ref: SourceRef };

export type InferenceCapabilities = {
  providerId: string; modelVersion: string;
  input: Array<'text' | 'image' | 'audio'>;
  structuredOutput: 'validated' | 'best_effort' | 'none';
  cancellation: 'acknowledged' | 'local_drop_only';
};
export interface InferenceAdapter {
  capabilities: InferenceCapabilities;
  proposeMemory(input: { selectedEvidence: Evidence[]; signal: AbortSignal }): Promise<Proposal>;
}
export interface HostAdapter {
  hostId: string;
  capabilities: { cancelTurn: boolean; permissionEvents: boolean };
  onEvent(callback: (event: EventInput, epoch: Epoch) => void): () => void;
}
export type AffectState = {
  arousal: number; valence: number; uncertainty: number; observedAt: number;
};
export interface NeuralAdapter {
  /** Experimental outputs are priors, never factual evidence. */
  manifest: { implementation: string; dataVersion: string; biologicalClaim: string };
  step(input: { dtMs: number; features: number[]; appraisal: number[] }): Promise<{
    attention: number[]; actionPrior: number[]; state: AffectState;
  }>;
  reset(): Promise<void>;
}
export interface MediaAdapter {
  stop(sessionId: string): Promise<{ acknowledged: boolean }>;
  speak(input: { sessionId: string; text: string; signal: AbortSignal }): Promise<{
    status: 'completed' | 'cancelled' | 'failed';
  }>;
}
export interface ActionProvider {
  /** Device controller must independently enforce motion/stop constraints. */
  propose(input: { skill: string; parameters: Record<string, number>; run: RunTicket }): Promise<{
    status: 'accepted' | 'rejected'; actionId: string;
  }>;
  stop(): Promise<void>;
}
