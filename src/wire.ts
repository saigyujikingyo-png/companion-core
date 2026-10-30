import type { Proposal } from './contracts.ts';
import { createHash } from 'node:crypto';
import * as v from './validation.ts';

export const MAX_WIRE_BYTES = 65_536;
export function parseJson(raw: string, maxBytes = MAX_WIRE_BYTES): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) v.fail('MESSAGE_TOO_LARGE');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    v.fail('INVALID_JSON');
  }
}
export function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  v.object(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    v.fail('INVALID_WIRE_SHAPE');
  return value;
}
export function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) v.fail('INVALID_WIRE_SHAPE');
}
export function literal(value: unknown, expected: unknown): void {
  if (value !== expected) v.fail('INVALID_WIRE_SHAPE');
}
export function wireProposal(value: unknown): Proposal {
  const p = fields(value, ['kind', 'statement', 'basis', 'validFrom', 'validTo']);
  return v.proposal(p as Proposal);
}
export function proposalResponse(raw: string): Proposal {
  const body = fields(parseJson(raw), ['version', 'proposal']);
  if (body.version !== 1) v.fail('UNSUPPORTED_PROTOCOL');
  return wireProposal(body.proposal);
}

export type HostKind = 'dsh' | 'codex-app-server';
export type SelectedMessage = { eventKey: string; selectedText: string; occurredAt: number | null };
function eventKey(session: string, id: string): string {
  return createHash('sha256')
    .update(JSON.stringify([session, id]))
    .digest('hex');
}
function textParts(value: unknown, codex: boolean): string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) v.fail('UNSUPPORTED_CONTENT');
  const parts = value.map((part) => {
    const p = fields(part, ['type', 'text'], codex ? ['text_elements'] : []);
    literal(p.type, 'text');
    v.text(p.text);
    // Text-element references may refer to other payloads; only the empty form
    // is accepted by this selected-text profile.
    if (p.text_elements !== undefined && (!Array.isArray(p.text_elements) || p.text_elements.length !== 0))
      v.fail('UNSUPPORTED_CONTENT');
    return p.text;
  });
  const text = parts.join('\n');
  v.text(text);
  return text;
}

/** Native-event *subset*, selected by a trusted host bridge. No identity claims
 * or authority commands are inferred from message contents. */
export function mapEvent(host: HostKind, sessionId: string, value: unknown): SelectedMessage {
  if (host === 'dsh') {
    const payload = fields(value, ['sessionId', 'event']);
    literal(payload.sessionId, sessionId);
    const e = fields(payload.event, ['type', 'seq', 'time', 'data', 'surfaceOp']);
    literal(e.type, 'user/message');
    literal(e.surfaceOp, 'append');
    integer(e.seq);
    integer(e.time);
    const message = fields(e.data, ['id', 'role', 'content', 'source']);
    v.text(message.id, 256);
    literal(message.role, 'user');
    const source = fields(message.source, ['kind', 'rpcId'], ['clientTimeZone', 'principal']);
    literal(source.kind, 'user');
    v.text(source.rpcId, 256);
    // Native identity metadata is not read or promoted to a core identity.
    if (source.clientTimeZone !== undefined) v.text(source.clientTimeZone, 128);
    // Session append time is not the time the person made this statement.
    return {
      eventKey: eventKey(sessionId, message.id),
      selectedText: textParts(message.content, false),
      occurredAt: null,
    };
  }
  const event = fields(value, ['method', 'params']);
  literal(event.method, 'item/completed');
  const p = fields(event.params, ['threadId', 'turnId', 'completedAtMs', 'item']);
  literal(p.threadId, sessionId);
  v.text(p.turnId, 256);
  integer(p.completedAtMs);
  const item = fields(p.item, ['type', 'id', 'content'], ['clientId']);
  literal(item.type, 'userMessage');
  v.text(item.id, 256);
  if (item.clientId !== undefined && item.clientId !== null) v.text(item.clientId, 256);
  return { eventKey: eventKey(sessionId, item.id), selectedText: textParts(item.content, true), occurredAt: null };
}
