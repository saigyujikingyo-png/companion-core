import type { Epoch, InferenceAdapter, Receipt, ScopeIdentity } from './contracts.ts';
import { createHash } from 'node:crypto';
import { MemoryStore } from './store.ts';
import { extractMemoryJob } from './pipeline.ts';
import { BoundedInferenceAdapter, timeoutMs } from './runtime.ts';
import { fields, mapEvent, parseJson } from './wire.ts';
import type { HostKind } from './wire.ts';
import { CoreError, fail, text } from './validation.ts';

// Object identity is the capability. A JSON copy, guessed id or foreign service
// handle cannot authenticate. Transport/session authentication belongs to host.
export type HostBinding = Readonly<{ version: 1 }>;
type Bound = {
  epoch: Epoch;
  subjectId: string;
  host: HostKind;
  source: string;
  sessionId: string;
  controller: AbortController;
};
export class HostMemoryService {
  #store: MemoryStore;
  #provider: BoundedInferenceAdapter;
  #bindings = new WeakMap<HostBinding, Bound>();
  #timeoutMs: number;
  constructor(
    store: MemoryStore,
    provider: InferenceAdapter,
    options: { concurrency?: number; maxQueued?: number; timeoutMs?: number } = {},
  ) {
    this.#store = store;
    this.#provider = new BoundedInferenceAdapter(provider, options);
    this.#timeoutMs = timeoutMs(options.timeoutMs ?? 30_000);
  }
  get occupancy(): Readonly<{ active: number; queued: number }> {
    return this.#provider.occupancy;
  }

  /** Trusted control plane only: called after host authentication and evidence
   * permission. Never call in response to a self-asserted JSON identity. */
  bind(input: { identity: ScopeIdentity; host: HostKind; hostInstanceId: string; sessionId: string }): HostBinding {
    text(input.sessionId, 128);
    text(input.hostInstanceId, 128);
    if (!['dsh', 'codex-app-server'].includes(input.host)) fail('UNSUPPORTED_HOST');
    const scope = this.#store.ensureScope(input.identity);
    const handle: HostBinding = Object.freeze({ version: 1 });
    this.#bindings.set(handle, {
      epoch: { id: scope.id, generation: scope.generation, consentRevision: scope.consentRevision },
      subjectId: scope.subjectId,
      host: input.host,
      source: `${input.host}:${createHash('sha256').update(input.hostInstanceId).digest('hex')}:selected-user-v1`,
      sessionId: input.sessionId,
      controller: new AbortController(),
    });
    return handle;
  }
  #bound(binding: HostBinding): Bound {
    const bound = this.#bindings.get(binding);
    if (!bound) fail('UNAUTHENTICATED');
    return bound;
  }
  unbind(binding: HostBinding): void {
    const bound = this.#bound(binding);
    this.#bindings.delete(binding);
    bound.controller.abort();
  }
  negotiate(
    binding: HostBinding,
    raw: string,
  ): { version: 1; capabilities: string[]; hostCancellation: 'not_integrated' } {
    this.#bound(binding);
    const value = fields(parseJson(raw), ['version', 'requiredCapabilities']);
    if (value.version !== 1) fail('UNSUPPORTED_PROTOCOL');
    const capabilities = ['selected_text', 'local_cancel', 'bounded_queue'];
    if (
      !Array.isArray(value.requiredCapabilities) ||
      value.requiredCapabilities.length > 8 ||
      !value.requiredCapabilities.every((item) => typeof item === 'string' && capabilities.includes(item))
    )
      fail('UNSUPPORTED_CAPABILITY');
    return { version: 1, capabilities, hostCancellation: 'not_integrated' };
  }
  async extract(binding: HostBinding, raw: string, signal = new AbortController().signal): Promise<Receipt> {
    const bound = this.#bound(binding);
    const combined = AbortSignal.any([signal, bound.controller.signal]);
    combined.throwIfAborted();
    const request = fields(parseJson(raw), ['version', 'operation', 'event']);
    if (request.version !== 1) fail('UNSUPPORTED_PROTOCOL');
    if (request.operation !== 'extract_memory') fail('UNSUPPORTED_OPERATION');
    const event = mapEvent(bound.host, bound.sessionId, request.event);
    const source = this.#store.acceptEvent(bound.epoch, {
      source: bound.source,
      eventKey: event.eventKey,
      evidence: {
        speakerId: bound.subjectId,
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: event.selectedText,
        occurredAt: event.occurredAt,
      },
    });
    if (source.currentStatus !== 'active') fail('STALE_SOURCE');
    const operation = this.#store.beginSelectedExtraction(bound.epoch, source);
    if ('receipt' in operation) return operation.receipt;
    return extractMemoryJob(this.#store, operation.job, this.#provider, combined, { timeoutMs: this.#timeoutMs });
  }
}

/** Public errors contain only enumerated categories, never provider/SQLite text. */
export function publicError(error: unknown): { version: 1; error: string } {
  const allowed = new Set([
    'UNAUTHENTICATED',
    'MESSAGE_TOO_LARGE',
    'INVALID_JSON',
    'INVALID_WIRE_SHAPE',
    'INVALID_INPUT',
    'UNSUPPORTED_PROTOCOL',
    'UNSUPPORTED_OPERATION',
    'UNSUPPORTED_CAPABILITY',
    'UNSUPPORTED_CONTENT',
    'STALE_SCOPE',
    'STALE_CONSENT',
    'STALE_SOURCE',
    'IDEMPOTENCY_CONFLICT',
    'BACKPRESSURE',
    'INFERENCE_TIMEOUT',
    'EXTRACTION_IN_PROGRESS',
    'EXTRACTION_TERMINATED',
    'PROVIDER_HTTP_STATUS',
    'PROVIDER_NETWORK',
    'PROVIDER_CONTENT_TYPE',
    'PROVIDER_RESPONSE_TOO_LARGE',
    'PROVIDER_RESPONSE_INVALID',
  ]);
  if (error instanceof DOMException && error.name === 'AbortError') return { version: 1, error: 'CANCELLED' };
  return { version: 1, error: error instanceof CoreError && allowed.has(error.code) ? error.code : 'INTERNAL_ERROR' };
}
