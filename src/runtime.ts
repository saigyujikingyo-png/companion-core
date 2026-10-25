import { CoreError, fail } from './validation.ts';
import type { Evidence, InferenceAdapter, InferenceCapabilities, Proposal } from './contracts.ts';

export function timeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) fail('INVALID_TIMEOUT');
  return value;
}
export function abortError(): DOMException { return new DOMException('Operation aborted', 'AbortError'); }

/** Reject promptly even when the operation ignores AbortSignal; consume late failures. */
export function bounded<T>(signal: AbortSignal, duration: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  timeoutMs(duration);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const deadline = performance.now() + duration;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      if (ok && performance.now() >= deadline) { ok = false; value = new CoreError('INFERENCE_TIMEOUT'); }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (!ok) { controller.abort(); reject(value); }
      else resolve(value as T);
    };
    const cancel = () => finish(false, abortError());
    const timer = setTimeout(() => finish(false, new CoreError('INFERENCE_TIMEOUT')), duration);
    signal.addEventListener('abort', cancel, { once:true });
    try { Promise.resolve(operation(controller.signal)).then(value => finish(true, value), error => finish(false, error)); }
    catch (error) { finish(false, error); }
  });
}

type Entry = { run: () => void; cancel: () => void };
/** Retain running permits until underlying operations really settle, including
 * after cancellation. Ignored cancellation cannot create unlimited orphans. */
export class BoundedInferenceAdapter implements InferenceAdapter {
  readonly capabilities: InferenceCapabilities;
  #provider: InferenceAdapter;
  #active = 0;
  #queue: Entry[] = [];
  #concurrency: number;
  #maxQueued: number;
  constructor(provider: InferenceAdapter, options: { concurrency?: number; maxQueued?: number } = {}) {
    this.#provider = provider;
    this.capabilities = { ...provider.capabilities, input:[...provider.capabilities.input], cancellation:'local_drop_only' };
    this.#concurrency = options.concurrency ?? 2;
    this.#maxQueued = options.maxQueued ?? 8;
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 32 ||
      !Number.isSafeInteger(this.#maxQueued) || this.#maxQueued < 0 || this.#maxQueued > 256) fail('INVALID_QUEUE_LIMIT');
  }
  get occupancy(): Readonly<{ active: number; queued: number }> { return { active:this.#active, queued:this.#queue.length }; }
  proposeMemory(input: { selectedEvidence: Evidence[]; signal: AbortSignal }): Promise<Proposal> {
    if (input.signal.aborted) return Promise.reject(abortError());
    if (this.#active >= this.#concurrency && this.#queue.length >= this.#maxQueued) return Promise.reject(new CoreError('BACKPRESSURE'));
    return new Promise<Proposal>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, value: unknown) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', entry.cancel);
        if (!ok) reject(value); else resolve(value as Proposal);
      };
      const entry: Entry = {
        cancel: () => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) this.#queue.splice(index, 1);
          finish(false, abortError());
        },
        run: () => {
          if (settled) return;
          this.#active++;
          let operation: Promise<Proposal>;
          try { operation = Promise.resolve(this.#provider.proposeMemory(input)); }
          catch (error) { operation = Promise.reject(error); }
          operation.then(value => finish(true, value), error => finish(false, error)).finally(() => {
            this.#active--;
            while (this.#active < this.#concurrency && this.#queue.length) this.#queue.shift()!.run();
          });
        }
      };
      input.signal.addEventListener('abort', entry.cancel, { once:true });
      if (this.#active < this.#concurrency) entry.run(); else this.#queue.push(entry);
    });
  }
}
