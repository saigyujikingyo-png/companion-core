import type { Evidence, Proposal, ScopeIdentity, SourceRef } from './contracts.ts';

export class CoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'CoreError'; this.code = code; }
}
export function fail(code: string): never { throw new CoreError(code); }
export function object(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_INPUT');
}
export function text(value: unknown, max = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) fail('INVALID_INPUT');
}
export function timestamp(value: unknown): asserts value is number | null {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) fail('INVALID_INPUT');
}
export function identity(value: ScopeIdentity): string {
  object(value);
  for (const key of ['tenantId','subjectId','personaId','relationshipId'] as const) text(value[key], 128);
  return JSON.stringify([value.tenantId,value.subjectId,value.personaId,value.relationshipId]);
}
export function evidence(value: Evidence, subjectId: string): Evidence {
  object(value);
  text(value.speakerId, 128); text(value.selectedText);
  if (!['subject','assistant','third_party','sensor'].includes(value.speakerRole)) fail('INVALID_INPUT');
  if (!['self_report','observation','quotation','inference'].includes(value.mode)) fail('INVALID_INPUT');
  if (value.speakerRole === 'subject' && value.speakerId !== subjectId) fail('SPEAKER_MISMATCH');
  if (value.mode === 'self_report' && value.speakerRole !== 'subject') fail('SPEAKER_MISMATCH');
  timestamp(value.occurredAt);
  return { speakerId: value.speakerId, speakerRole: value.speakerRole, mode: value.mode,
    selectedText: value.selectedText, occurredAt: value.occurredAt };
}
export function proposal(value: Proposal): Proposal {
  object(value);
  if (!['claim','status','belief','commitment','episode'].includes(value.kind)) fail('INVALID_INPUT');
  if (!['self_report','observation','inference'].includes(value.basis)) fail('INVALID_INPUT');
  if (value.basis === 'inference' && value.kind !== 'belief') fail('INFERENCE_IS_NOT_FACT');
  if (value.kind === 'belief' && value.basis !== 'inference') fail('BELIEF_REQUIRES_INFERENCE');
  text(value.statement); timestamp(value.validFrom); timestamp(value.validTo);
  if (value.validFrom !== null && value.validTo !== null && value.validTo <= value.validFrom) fail('INVALID_INPUT');
  if ((value.kind === 'belief' || value.kind === 'status') && value.validTo === null) fail('TTL_REQUIRED');
  return { kind:value.kind, statement:value.statement, basis:value.basis, validFrom:value.validFrom, validTo:value.validTo };
}
export function refs(value: SourceRef[]): SourceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail('INVALID_INPUT');
  const seen = new Set<string>();
  return value.map(ref => {
    object(ref);
    text(ref.id, 128);
    if (!Number.isSafeInteger(ref.revision) || ref.revision < 1 || seen.has(ref.id)) fail('INVALID_INPUT');
    seen.add(ref.id); return { id:ref.id, revision:ref.revision };
  });
}
