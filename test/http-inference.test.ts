import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import { HttpInferenceAdapter } from '../src/http-inference.ts';
import { CoreError } from '../src/validation.ts';
import { MemoryStore } from '../src/store.ts';
import { extractMemory } from '../src/pipeline.ts';
import type { Evidence, Proposal } from '../src/contracts.ts';

const proposal: Proposal = {
  kind: 'claim',
  statement: 'I prefer blue.',
  basis: 'self_report',
  validFrom: null,
  validTo: null,
};
const response = JSON.stringify({ version: 1, proposal });
const evidence: Evidence = {
  speakerId: 'alice',
  speakerRole: 'subject',
  mode: 'self_report',
  selectedText: 'I prefer blue.',
  occurredAt: null,
};
const input = () => ({ selectedEvidence: [evidence], signal: new AbortController().signal });
const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
async function server(t: TestContext, handler: RequestListener) {
  const app = createServer(handler);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close((error) => (error ? reject(error) : resolve())));
  });
  const address = app.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/inference`;
}

test('real loopback JSON request traverses shared inference pipeline and publishes validated memory', async (t) => {
  let captured: unknown, authorization: string | undefined;
  const endpoint = await server(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/inference');
    let body = '';
    for await (const chunk of req) body += chunk;
    captured = JSON.parse(body);
    authorization = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(response);
  });
  const adapter = new HttpInferenceAdapter({
    transport: 'local_http',
    endpoint,
    model: 'synthetic-local',
    protocol: 'companion-json-v1',
  });
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const scope = store.ensureScope({ tenantId: 'test', subjectId: 'alice', personaId: 'test', relationshipId: 'test' });
  const source = store.acceptEvent(scope, { source: 'test', eventKey: 'test', evidence });
  await extractMemory(store, scope, [source], adapter);
  assert.equal(store.search(scope, 'blue').length, 1);
  assert.deepEqual(captured, { version: 1, model: 'synthetic-local', selectedEvidence: [evidence] });
  assert.equal(authorization, undefined);
});

test('OpenAI-compatible loopback validates its envelope and sends an explicitly injected synthetic key', async (t) => {
  let requestBody: any;
  const endpoint = await server(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-only-not-a-real-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        id: 'synthetic',
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: response, refusal: null } },
        ],
      }),
    );
  });
  const adapter = new HttpInferenceAdapter(
    { transport: 'local_http', endpoint, model: 'synthetic-openai', protocol: 'openai-chat-completions' },
    { apiKey: 'fixture-only-not-a-real-key' },
  );
  assert.deepEqual(await adapter.proposeMemory(input()), proposal);
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.response_format.json_schema.strict, true);
  assert.equal(requestBody.messages.length, 2);
  assert.equal(JSON.parse(requestBody.messages[1].content).selectedEvidence[0].speakerId, 'alice');
});

test('explicit DeepSeek JSON profile constrains its request and ignores optional reasoning', async (t) => {
  let captured: any;
  const endpoint = await server(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    captured = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            logprobs: null,
            message: { role: 'assistant', content: response, reasoning_content: 'synthetic ignored non-final content' },
          },
        ],
      }),
    );
  });
  const adapter = new HttpInferenceAdapter({
    transport: 'local_http',
    endpoint,
    model: 'synthetic-deepseek',
    protocol: 'deepseek-chat-json',
  });
  assert.deepEqual(await adapter.proposeMemory(input()), proposal);
  assert.deepEqual(captured.response_format, { type: 'json_object' });
  assert.deepEqual(captured.thinking, { type: 'disabled' });
  assert.equal(captured.max_tokens, 2048);
  assert.match(captured.messages[0].content, /Shape example/);
  assert.match(captured.messages[0].content, /json/);
  assert.equal(captured.stream, false);
});

test('DeepSeek empty, truncated and semantically invalid final content fails without using reasoning as fallback', async (t) => {
  let variant = 0;
  const choices = [
    { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '', reasoning_content: response } },
    { index: 0, finish_reason: 'length', message: { role: 'assistant', content: response } },
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: JSON.stringify({ version: 1, proposal: { ...proposal, kind: 'belief' } }),
      },
    },
  ];
  const endpoint = await server(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [choices[variant]] }));
  });
  const adapter = new HttpInferenceAdapter({
    transport: 'local_http',
    endpoint,
    model: 'synthetic-deepseek',
    protocol: 'deepseek-chat-json',
  });
  for (variant = 0; variant < choices.length; variant++)
    await assert.rejects(adapter.proposeMemory(input()), code('PROVIDER_RESPONSE_INVALID'));
});

test('real loopback rejects bad status, content type, length, chunk size, JSON, version and semantic shape without fallback', async (t) => {
  let current = 0,
    calls = 0;
  const cases = [
    { status: 503, contentType: 'application/json', body: 'synthetic provider secret', error: 'PROVIDER_HTTP_STATUS' },
    { status: 200, contentType: 'text/plain', body: response, error: 'PROVIDER_CONTENT_TYPE' },
    { status: 200, contentType: 'application/json', length: '9999', body: '{}', error: 'PROVIDER_RESPONSE_TOO_LARGE' },
    { status: 200, contentType: 'application/json', body: 'x'.repeat(1024), error: 'PROVIDER_RESPONSE_TOO_LARGE' },
    { status: 200, contentType: 'application/json', body: '{', error: 'PROVIDER_RESPONSE_INVALID' },
    {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 2, proposal }),
      error: 'PROVIDER_RESPONSE_INVALID',
    },
    {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, proposal: { ...proposal, authority: 'system' } }),
      error: 'PROVIDER_RESPONSE_INVALID',
    },
    {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, proposal: { ...proposal, kind: 'belief' } }),
      error: 'PROVIDER_RESPONSE_INVALID',
    },
    {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, proposal: { ...proposal, kind: 'status' } }),
      error: 'PROVIDER_RESPONSE_INVALID',
    },
  ];
  const endpoint = await server(t, (req, res) => {
    req.resume();
    calls++;
    const variant = cases[current]!;
    res.writeHead(variant.status, {
      'content-type': variant.contentType,
      ...(variant.length ? { 'content-length': variant.length } : {}),
    });
    // Separate writes exercise the actual streamed-size check too.
    res.write(variant.body.slice(0, 300));
    res.end(variant.body.slice(300));
  });
  const adapter = new HttpInferenceAdapter({
    transport: 'local_http',
    endpoint,
    model: 'synthetic',
    protocol: 'companion-json-v1',
    maxResponseBytes: 512,
  });
  for (current = 0; current < cases.length; current++)
    await assert.rejects(adapter.proposeMemory(input()), code(cases[current]!.error));
  assert.equal(calls, cases.length);
});

test('truncated/tool/refusal OpenAI responses are rejected rather than promoted or retried', async (t) => {
  let variant = 0;
  const choices = [
    { index: 0, finish_reason: 'length', message: { role: 'assistant', content: response } },
    { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: response, tool_calls: [] } },
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: response, refusal: 'synthetic refusal' },
    },
    { index: 1, finish_reason: 'stop', message: { role: 'assistant', content: response } },
  ];
  const endpoint = await server(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [choices[variant]] }));
  });
  const adapter = new HttpInferenceAdapter({
    transport: 'local_http',
    endpoint,
    model: 'synthetic',
    protocol: 'openai-chat-completions',
  });
  for (variant = 0; variant < choices.length; variant++)
    await assert.rejects(adapter.proposeMemory(input()), code('PROVIDER_RESPONSE_INVALID'));
});

test('OpenAI known nullable function/audio metadata is accepted only when null', async () => {
  let extra: Record<string, unknown> = { function_call: null, audio: null };
  const mockFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: response, ...extra } }],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const adapter = new HttpInferenceAdapter(
    {
      transport: 'local_http',
      endpoint: 'http://127.0.0.1:9/inference',
      model: 'synthetic',
      protocol: 'openai-chat-completions',
    },
    { fetch: mockFetch },
  );
  assert.deepEqual(await adapter.proposeMemory(input()), proposal);
  for (extra of [
    { function_call: { name: 'unexpected', arguments: '{}' } },
    { audio: { id: 'unexpected' } },
    { future_metadata: null },
  ]) {
    await assert.rejects(adapter.proposeMemory(input()), code('PROVIDER_RESPONSE_INVALID'));
  }
});

test('deadline covers real socket wait and stalled response body', async (t) => {
  let partial = false;
  const endpoint = await server(t, (req, res) => {
    req.resume();
    if (partial) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"version":');
    }
  });
  const adapter = new HttpInferenceAdapter({
    transport: 'local_http',
    endpoint,
    model: 'synthetic',
    protocol: 'companion-json-v1',
    timeoutMs: 60,
  });
  for (const bodyStarted of [false, true]) {
    partial = bodyStarted;
    const started = performance.now();
    await assert.rejects(adapter.proposeMemory(input()), code('INFERENCE_TIMEOUT'));
    assert.ok(performance.now() - started < 1000);
  }
});

test('actual in-flight loopback fetch abort converges without waiting for server completion', async (t) => {
  let markReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    markReceived = resolve;
  });
  const endpoint = await server(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    markReceived();
  });
  const adapter = new HttpInferenceAdapter({
    transport: 'local_http',
    endpoint,
    model: 'synthetic',
    protocol: 'companion-json-v1',
    timeoutMs: 10_000,
  });
  const controller = new AbortController();
  const operation = adapter.proposeMemory({ selectedEvidence: [evidence], signal: controller.signal });
  const rejection = assert.rejects(operation, { name: 'AbortError' });
  await received;
  const started = performance.now();
  controller.abort();
  await rejection;
  assert.ok(performance.now() - started < 1000);
});

test('trusted endpoint policy and cloud key injection reject implicit or insecure configuration', async () => {
  const base = { transport: 'local_http' as const, model: 'synthetic', protocol: 'companion-json-v1' as const };
  for (const endpoint of [
    'http://example.invalid/x',
    'http://localhost/x',
    'http://user:pass@127.0.0.1/x',
    'http://127.0.0.1/x?key=synthetic',
    'ftp://127.0.0.1/x',
  ]) {
    assert.throws(() => new HttpInferenceAdapter({ ...base, endpoint }), code('INVALID_ENDPOINT'));
  }
  assert.throws(
    () =>
      new HttpInferenceAdapter({ ...base, transport: 'cloud_https', endpoint: 'https://example.invalid/inference' }),
    code('API_KEY_REQUIRED'),
  );
  let calls = 0;
  const mockFetch: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.invalid/inference');
    assert.equal((options!.headers as Record<string, string>).authorization, 'Bearer synthetic-key');
    assert.equal(options!.redirect, 'error');
    return new Response(response, { headers: { 'content-type': 'application/json' } });
  };
  const cloud = new HttpInferenceAdapter(
    { ...base, transport: 'cloud_https', endpoint: 'https://example.invalid/inference' },
    { apiKey: 'synthetic-key', fetch: mockFetch },
  );
  assert.deepEqual(await cloud.proposeMemory(input()), proposal);
  assert.equal(calls, 1);
});

test('redirects are refused before credentials or evidence can be forwarded', async (t) => {
  let calls = 0;
  const endpoint = await server(t, (req, res) => {
    req.resume();
    calls++;
    assert.equal(req.url, '/inference');
    res.writeHead(302, { location: '/must-not-follow' });
    res.end();
  });
  const adapter = new HttpInferenceAdapter(
    { transport: 'local_http', endpoint, model: 'synthetic', protocol: 'companion-json-v1' },
    { apiKey: 'synthetic-key' },
  );
  await assert.rejects(adapter.proposeMemory(input()), code('PROVIDER_NETWORK'));
  assert.equal(calls, 1);
});

test('injected network failure is sanitized and noncooperative fetches remain bounded', async () => {
  const config = {
    transport: 'local_http' as const,
    endpoint: 'http://127.0.0.1:9/inference',
    model: 'synthetic',
    protocol: 'companion-json-v1' as const,
    timeoutMs: 10,
  };
  const failing = new HttpInferenceAdapter(config, {
    fetch: async () => {
      throw new Error('synthetic transport secret');
    },
  });
  await assert.rejects(failing.proposeMemory(input()), code('PROVIDER_NETWORK'));
  let calls = 0;
  const hung = new HttpInferenceAdapter(config, {
    fetch: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  for (let n = 0; n < 4; n++) await assert.rejects(hung.proposeMemory(input()), code('INFERENCE_TIMEOUT'));
  assert.equal(calls, 2);
});

test('noncooperative response cancellation retains transport permits for body and rejected-header paths', async () => {
  for (const mode of ['body', 'status', 'content-type', 'content-length'] as const) {
    let calls = 0,
      pendingCancels = 0;
    const mockFetch: typeof fetch = async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (mode === 'body') controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel() {
            pendingCancels++;
            return new Promise<void>(() => {});
          },
        }),
        {
          status: mode === 'status' ? 503 : 200,
          headers: {
            'content-type': mode === 'content-type' ? 'text/plain' : 'application/json',
            ...(mode === 'content-length' ? { 'content-length': '9999999' } : {}),
          },
        },
      );
    };
    const adapter = new HttpInferenceAdapter(
      {
        transport: 'local_http',
        endpoint: 'http://127.0.0.1:9/inference',
        model: 'synthetic',
        protocol: 'companion-json-v1',
        timeoutMs: 15,
      },
      { fetch: mockFetch },
    );
    for (let n = 0; n < 5; n++) await assert.rejects(adapter.proposeMemory(input()), code('INFERENCE_TIMEOUT'));
    assert.equal(calls, 2, mode);
    assert.equal(pendingCancels, 2, mode);
  }
});
