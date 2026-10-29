import { types } from 'node:util';
import { CoreError, fail } from './validation.ts';

export type RawTextMessage = Readonly<{ role: 'system' | 'user'; content: string }>;
export interface RawTextPort {
  generate(
    input: Readonly<{
      requestId: string;
      messages: readonly RawTextMessage[];
      signal: AbortSignal;
      validateBeforeSend: () => unknown;
    }>,
  ): Promise<string>;
}
export type RawTextHttpConfig = Readonly<{
  endpoint: string;
  model: string;
  protocol: 'openai-chat-completions';
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxFinalBytes?: number;
  maxTokens?: number;
}>;
export const RAW_TEXT_HTTP_LIMITS = Object.freeze({
  requestBytes: 131072,
  responseBytes: 65536,
  finalBytes: 16384,
  messages: 64,
});

// Dependencies and JavaScript intrinsics are trusted in-process code. No environment,
// endpoint discovery, logger, retry, streaming, tools, media or physical-stop claim.
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('RAW_TEXT_SHAPE');
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length || required.some((key) => !Object.hasOwn(value, key)))
    fail('RAW_TEXT_SHAPE');
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) fail('RAW_TEXT_SHAPE');
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('RAW_TEXT_SHAPE');
    out[key] = d.value as unknown;
  }
  return out;
}
function string(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    /[\ud800-\udfff\u0000]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > max
  )
    fail('RAW_TEXT_STRING');
  return value;
}
function limit(value: unknown, hard: number): number {
  if (value === undefined) return hard;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > hard) fail('RAW_TEXT_LIMIT');
  return value;
}
function signalValue(value: unknown): AbortSignal {
  if (
    typeof value !== 'object' ||
    value === null ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype
  )
    fail('RAW_TEXT_SIGNAL');
  try {
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(value);
  } catch {
    fail('RAW_TEXT_SIGNAL');
  }
  return value as AbortSignal;
}
function aborted(signal: AbortSignal): boolean {
  return Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(signal) === true;
}
function requireActive(signal: AbortSignal): void {
  if (aborted(signal)) fail('RAW_TEXT_ABORTED');
}
function consumeDenied(value: unknown): void {
  if (types.isPromise(value)) {
    void Promise.prototype.then.call(
      value,
      () => undefined,
      () => undefined,
    );
    return;
  }
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const then = Reflect.get(value, 'then') as unknown;
    if (typeof then === 'function') {
      const returned: unknown = then.call(
        value,
        () => undefined,
        () => undefined,
      );
      if (types.isPromise(returned))
        void Promise.prototype.then.call(
          returned,
          () => undefined,
          () => undefined,
        );
    }
  }
}
function gate(validate: () => unknown): void {
  let allowed = false;
  try {
    const result = validate();
    allowed = result === true;
    if (!allowed) consumeDenied(result);
  } catch {
    allowed = false;
  }
  if (!allowed) fail('RAW_TEXT_SEND_DENIED');
}
function messages(value: unknown, maxBytes: number): RawTextMessage[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > RAW_TEXT_HTTP_LIMITS.messages ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail('RAW_TEXT_SHAPE');
  const result: RawTextMessage[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('RAW_TEXT_SHAPE');
    const item = record(descriptor.value, ['role', 'content']);
    if (item.role !== 'system' && item.role !== 'user') fail('RAW_TEXT_SHAPE');
    result.push({ role: item.role, content: string(item.content, maxBytes) });
  }
  return result;
}
function finalText(raw: string, maxBytes: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('RAW_TEXT_RESPONSE_INVALID');
  }
  const envelope = record(
    parsed,
    ['choices'],
    ['id', 'object', 'created', 'model', 'usage', 'system_fingerprint', 'service_tier'],
  );
  if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1) fail('RAW_TEXT_RESPONSE_INVALID');
  const choice = record(envelope.choices[0], ['index', 'message', 'finish_reason'], ['logprobs']);
  if (choice.index !== 0 || choice.finish_reason !== 'stop') fail('RAW_TEXT_RESPONSE_INVALID');
  const message = record(
    choice.message,
    ['role', 'content'],
    ['refusal', 'annotations', 'tool_calls', 'function_call', 'audio', 'reasoning', 'reasoning_content'],
  );
  if (
    message.role !== 'assistant' ||
    (message.refusal !== undefined && message.refusal !== null) ||
    (message.function_call !== undefined && message.function_call !== null) ||
    (message.audio !== undefined && message.audio !== null) ||
    (message.tool_calls !== undefined &&
      message.tool_calls !== null &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) ||
    (message.annotations !== undefined && (!Array.isArray(message.annotations) || message.annotations.length !== 0))
  )
    fail('RAW_TEXT_RESPONSE_INVALID');
  for (const name of ['reasoning', 'reasoning_content']) {
    if (message[name] !== undefined && message[name] !== null && typeof message[name] !== 'string')
      fail('RAW_TEXT_RESPONSE_INVALID');
  }
  // Provider model/usage/reasoning are untrusted, bounded envelope data. They are
  // neither returned nor used as authority or as evidence of loaded assets.
  return string(message.content, maxBytes);
}

export function createRawTextHttpPort(
  config: RawTextHttpConfig,
  dependencies: { apiKey?: string; fetch?: typeof fetch } = {},
): RawTextPort {
  const c = record(
    config,
    ['endpoint', 'model', 'protocol'],
    ['maxRequestBytes', 'maxResponseBytes', 'maxFinalBytes', 'maxTokens'],
  );
  const d = record(dependencies, [], ['apiKey', 'fetch']);
  const endpointText = string(c.endpoint, 4096);
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch {
    fail('RAW_TEXT_ENDPOINT');
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpointText.includes('?') ||
    endpointText.includes('#') ||
    (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)))
  )
    fail('RAW_TEXT_ENDPOINT');
  if (c.protocol !== 'openai-chat-completions') fail('RAW_TEXT_PROTOCOL');
  const model = string(c.model, 128),
    requestLimit = limit(c.maxRequestBytes, RAW_TEXT_HTTP_LIMITS.requestBytes),
    responseLimit = limit(c.maxResponseBytes, RAW_TEXT_HTTP_LIMITS.responseBytes),
    finalLimit = limit(c.maxFinalBytes, RAW_TEXT_HTTP_LIMITS.finalBytes),
    maxTokens = c.maxTokens === undefined ? 1024 : limit(c.maxTokens, 4096);
  const fetcher = d.fetch === undefined ? fetch : d.fetch;
  if (typeof fetcher !== 'function' || types.isProxy(fetcher)) fail('RAW_TEXT_DEPENDENCY');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'identity',
  };
  if (d.apiKey !== undefined) {
    const key = string(d.apiKey, 4096);
    if (!/^[\x21-\x7e]+$/u.test(key)) fail('RAW_TEXT_API_KEY');
    headers.authorization = `Bearer ${key}`;
  }
  let busy = false;
  async function request(input: Parameters<RawTextPort['generate']>[0]): Promise<string> {
    if (busy) fail('RAW_TEXT_BUSY');
    busy = true;
    try {
      const i = record(input, ['requestId', 'messages', 'signal', 'validateBeforeSend']);
      const requestId = string(i.requestId, 128);
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(requestId)) fail('RAW_TEXT_STRING');
      const signal = signalValue(i.signal);
      if (typeof i.validateBeforeSend !== 'function' || types.isProxy(i.validateBeforeSend)) fail('RAW_TEXT_SHAPE');
      const body = JSON.stringify({
        model,
        stream: false,
        max_tokens: maxTokens,
        messages: messages(i.messages, requestLimit),
      });
      if (Buffer.byteLength(body, 'utf8') > requestLimit) fail('RAW_TEXT_REQUEST_TOO_LARGE');
      const init: RequestInit = { method: 'POST', headers: { ...headers }, body, signal, redirect: 'error' };
      requireActive(signal);
      // No await, external code or deferred authorization between this gate and
      // the fetch invocation. The final signal read also catches gate-side abort.
      gate(i.validateBeforeSend as () => unknown);
      requireActive(signal);
      let response: Response;
      try {
        response = await (fetcher as typeof fetch)(endpoint.href, init);
      } catch {
        fail(aborted(signal) ? 'RAW_TEXT_ABORTED' : 'RAW_TEXT_NETWORK');
      }
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cleanup: Promise<void> | undefined;
      const cancel = (): Promise<void> =>
        (cleanup ??= (async () => {
          try {
            if (reader) await reader.cancel();
            else await response.body?.cancel();
          } catch {
            /* observed settlement */
          }
        })());
      const onAbort = (): void => {
        void cancel();
      };
      EventTarget.prototype.addEventListener.call(signal, 'abort', onAbort, { once: true });
      try {
        requireActive(signal);
        if (response.status !== 200 || response.redirected) fail('RAW_TEXT_HTTP_STATUS');
        if (
          !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(
            response.headers.get('content-type') ?? '',
          )
        )
          fail('RAW_TEXT_CONTENT_TYPE');
        const encoding = response.headers.get('content-encoding');
        if (encoding !== null && encoding.toLowerCase() !== 'identity') fail('RAW_TEXT_CONTENT_ENCODING');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || !Number.isSafeInteger(Number(declared))))
          fail('RAW_TEXT_CONTENT_LENGTH');
        if (declared !== null && Number(declared) > responseLimit) fail('RAW_TEXT_RESPONSE_TOO_LARGE');
        if (!response.body) fail('RAW_TEXT_RESPONSE_INVALID');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const part = await reader.read();
          requireActive(signal);
          if (part.done) break;
          length += part.value.byteLength;
          if (length > responseLimit) fail('RAW_TEXT_RESPONSE_TOO_LARGE');
          chunks.push(new Uint8Array(part.value));
        }
        if (declared !== null && Number(declared) !== length) fail('RAW_TEXT_CONTENT_LENGTH');
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks, length),
        );
        return finalText(decoded, finalLimit);
      } catch (error) {
        await cancel();
        if (aborted(signal)) fail('RAW_TEXT_ABORTED');
        // No provider body, injected rejection, abort reason or credential enters errors.
        if (
          error instanceof CoreError &&
          [
            'RAW_TEXT_HTTP_STATUS',
            'RAW_TEXT_CONTENT_TYPE',
            'RAW_TEXT_CONTENT_ENCODING',
            'RAW_TEXT_CONTENT_LENGTH',
            'RAW_TEXT_RESPONSE_TOO_LARGE',
            'RAW_TEXT_RESPONSE_INVALID',
            'RAW_TEXT_SHAPE',
            'RAW_TEXT_STRING',
          ].includes(error.code)
        )
          throw new CoreError(error.code);
        throw new CoreError('RAW_TEXT_RESPONSE_INVALID');
      } finally {
        if (cleanup) await cleanup;
        EventTarget.prototype.removeEventListener.call(signal, 'abort', onAbort);
        reader?.releaseLock();
      }
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    generate(input: Parameters<RawTextPort['generate']>[0]): Promise<string> {
      const raw = request(input);
      // Freeze before exposing; own the rejection observer even if the consumer
      // abandons its public timeout. No race/bounded wrapper may release this slot.
      Object.freeze(raw);
      void Promise.prototype.then.call(
        raw,
        () => undefined,
        () => undefined,
      );
      return raw;
    },
  });
}
