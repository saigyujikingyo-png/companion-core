import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createRawTextHttpPort, RAW_TEXT_HTTP_LIMITS } from '../src/raw-text-http.ts';
import type { RawTextHttpConfig, RawTextPort } from '../src/raw-text-http.ts';

const config:RawTextHttpConfig = { endpoint:'http://127.0.0.1:1/v1/chat/completions', model:'fixture/model', protocol:'openai-chat-completions' };
function input(extra:Partial<Parameters<RawTextPort['generate']>[0]> = {}):Parameters<RawTextPort['generate']>[0] {
  return { requestId:'fixture/request', messages:[{ role:'user', content:'Synthetic input.' }],
    signal:new AbortController().signal, validateBeforeSend:() => true, ...extra };
}
function envelope(content = 'Synthetic final.') {
  return { model:'unverified/provider-label', choices:[{ index:0, finish_reason:'stop', message:{ role:'assistant', content,
    reasoning_content:'Synthetic hidden field; never returned.' } }] };
}
function reply(content = 'Synthetic final.'):Response { return new Response(JSON.stringify(envelope(content)), { headers:{ 'content-type':'application/json' } }); }
function deferred<T>() {
  let resolve!:(value:T) => void, reject!:(error:Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }
async function server(handler:RequestListener) {
  const owned = createServer(handler);
  await new Promise<void>((resolve, reject) => { owned.once('error', reject); owned.listen(0, '127.0.0.1', resolve); });
  return { endpoint:`http://127.0.0.1:${(owned.address() as AddressInfo).port}/v1/chat/completions`,
    async close() { owned.closeAllConnections(); await new Promise<void>((resolve, reject) => owned.close(error => error ? reject(error) : resolve())); } };
}

test('raw HTTP rejects unsafe endpoints, unknown protocols and raised byte/token limits', () => {
  for (const endpoint of ['http://example.com/a','http://localhost/a','file:///a','https://u:p@example.com/a',
    'https://example.com/a?x=1','https://example.com/a?','https://example.com/a#','https://example.com/a#b'])
    assert.throws(() => createRawTextHttpPort({ ...config, endpoint }), /RAW_TEXT_ENDPOINT/u);
  assert.throws(() => createRawTextHttpPort({ ...config, protocol:'auto' } as unknown as RawTextHttpConfig), /RAW_TEXT_PROTOCOL/u);
  for (const [key, hard] of [['maxRequestBytes',131072],['maxResponseBytes',65536],['maxFinalBytes',16384],['maxTokens',4096]] as const)
    for (const value of [0, -1, 1.1, NaN, hard + 1]) assert.throws(() => createRawTextHttpPort({ ...config, [key]:value }), /RAW_TEXT_LIMIT/u);
  assert.throws(() => createRawTextHttpPort(config, { apiKey:'fixture\r\nsecret' }), /RAW_TEXT_API_KEY/u);
  assert.doesNotThrow(() => createRawTextHttpPort({ ...config, endpoint:'https://example.invalid/v1/chat/completions' }));
  assert.doesNotThrow(() => createRawTextHttpPort({ ...config, endpoint:'http://[::1]:1/chat' }));
});

test('raw HTTP performs a real loopback POST, sends bounded fixed config and returns only final text', async () => {
  let requests = 0, payload:unknown, contentType:unknown, authorization:unknown;
  const owned = await server((req, res) => {
    requests++; contentType = req.headers['content-type']; authorization = req.headers.authorization;
    const chunks:Buffer[] = []; req.on('data', (chunk:Buffer) => chunks.push(chunk));
    req.on('end', () => { payload = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type':'application/json; charset=UTF-8' }); res.end(JSON.stringify(envelope('合成 final 😀'))); });
  });
  try {
    const mutable = { ...config, endpoint:owned.endpoint, maxTokens:123 };
    const port = createRawTextHttpPort(mutable, { apiKey:'fixture-only-key' });
    mutable.model = 'fixture/mutated'; mutable.maxTokens = 4096;
    const raw = port.generate(input());
    assert.equal(raw.constructor, Promise); assert.equal(Object.getPrototypeOf(raw), Promise.prototype); assert(Object.isFrozen(raw));
    assert.equal(await raw, '合成 final 😀'); assert.equal(requests, 1);
    assert.deepEqual(payload, { model:'fixture/model', stream:false, max_tokens:123, messages:[{ role:'user', content:'Synthetic input.' }] });
    assert.equal(contentType, 'application/json'); assert.equal(authorization, 'Bearer fixture-only-key');
  } finally { await owned.close(); }
});

test('raw HTTP real sockets reject malformed UTF-8/JSON, redirects, truncation and oversized bodies without retries', async () => {
  let scenario = '', requests = 0, redirectTarget = 0;
  const owned = await server((req, res) => {
    requests++; req.resume();
    if (req.url === '/redirect-target') { redirectTarget++; res.end('{}'); return; }
    if (scenario === 'redirect') { res.writeHead(302, { location:'/redirect-target' }); res.end(); return; }
    if (scenario === 'type') { res.writeHead(200, { 'content-type':'text/plain' }); res.end('{}'); return; }
    if (scenario === 'declared') { res.writeHead(200, { 'content-type':'application/json', 'content-length':'65537' }); res.end(); return; }
    if (scenario === 'truncated') { res.writeHead(200, { 'content-type':'application/json', 'content-length':'1000', connection:'close' }); res.end('{'); return; }
    res.writeHead(200, { 'content-type':'application/json' });
    if (scenario === 'utf8') res.end(Buffer.from([0xff,0xfe]));
    else if (scenario === 'bom') res.end(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from(JSON.stringify(envelope()))]));
    else if (scenario === 'large') { res.write(' '.repeat(32768)); res.end(' '.repeat(32769)); }
    else res.end('{broken');
  });
  try {
    const port = createRawTextHttpPort({ ...config, endpoint:owned.endpoint });
    for (const name of ['json','utf8','bom','redirect','type','declared','truncated','large']) {
      scenario = name; const before = requests;
      await assert.rejects(port.generate(input()), /RAW_TEXT_/u, name);
      assert.equal(requests, before + 1, name);
    }
    assert.equal(redirectTarget, 0);
  } finally { await owned.close(); }
});

test('raw HTTP gate rejects every nonliteral true and consumes ordinary rejected promises/thenables with zero fetch', async () => {
  let fetched = 0, gateCalls = 0;
  const port = createRawTextHttpPort(config, { fetch:async () => { fetched++; return reply(); } });
  const denied:Array<() => unknown> = [() => false, () => undefined, () => null, () => 1, () => 'true', () => ({}),
    () => Promise.resolve(true), () => Promise.reject(new Error('fixture/secret-denied')),
    () => ({ then(_yes:unknown, no:(error:Error) => void) { no(new Error('fixture/then')); return Promise.reject(new Error('fixture/returned')); } }),
    () => { throw new Error('fixture/secret-throw'); }];
  for (const deny of denied) await assert.rejects(port.generate(input({ validateBeforeSend:() => { gateCalls++; return deny(); } })), error => {
    assert.equal((error as Error).message, 'RAW_TEXT_SEND_DENIED'); return true;
  });
  await tick(); assert.equal(fetched, 0); assert.equal(gateCalls, denied.length);
  assert.equal(await port.generate(input()), 'Synthetic final.'); assert.equal(fetched, 1);
});

test('raw HTTP constructs and snapshots the payload before the last synchronous gate', async () => {
  const order:string[] = []; let body = '';
  const port = createRawTextHttpPort(config, { fetch:async (_url, init) => { order.push('fetch'); body = String(init?.body); return reply(); } });
  const selected = [{ role:'user' as const, content:'Original synthetic data.' }];
  await port.generate(input({ messages:selected, validateBeforeSend:() => {
    order.push('gate'); selected[0]!.content = 'Changed inside gate'; queueMicrotask(() => order.push('microtask')); return true;
  } }));
  assert.deepEqual(order, ['gate','fetch','microtask']); assert(body.includes('Original synthetic data.')); assert(!body.includes('Changed inside gate'));
  const abort = new AbortController(); let gates = 0;
  await assert.rejects(port.generate(input({ signal:abort.signal, validateBeforeSend:() => { gates++; abort.abort(new Error('fixture/private')); return true; } })), /RAW_TEXT_ABORTED/u);
  await assert.rejects(port.generate(input({ signal:abort.signal, validateBeforeSend:() => { gates++; return true; } })), /RAW_TEXT_ABORTED/u);
  assert.equal(gates, 1); assert.equal(order.filter(x => x === 'fetch').length, 1);
});

test('raw HTTP enforces UTF-8 request/final and full JSON payload limits before dispatch', async () => {
  let fetched = 0, gates = 0;
  const port = createRawTextHttpPort({ ...config, maxRequestBytes:180 }, { fetch:async () => { fetched++; return reply(); } });
  await assert.rejects(port.generate(input({ messages:[{ role:'user', content:'汉'.repeat(50) }], validateBeforeSend:() => { gates++; return true; } })), /RAW_TEXT_REQUEST_TOO_LARGE/u);
  await assert.rejects(port.generate(input({ messages:[{ role:'user', content:'\ud800' }] })), /RAW_TEXT_STRING/u);
  await assert.rejects(port.generate(input({ messages:[{ role:'assistant', content:'x' }] } as never)), /RAW_TEXT_SHAPE/u);
  assert.equal(fetched, 0); assert.equal(gates, 0);
  const final = createRawTextHttpPort({ ...config, maxFinalBytes:6 }, { fetch:async () => reply('汉汉') });
  assert.equal(await final.generate(input()), '汉汉');
  const excessive = createRawTextHttpPort({ ...config, maxFinalBytes:5 }, { fetch:async () => reply('汉汉') });
  await assert.rejects(excessive.generate(input()), /RAW_TEXT_STRING/u);
  const hard = createRawTextHttpPort(config, { fetch:async () => reply('a'.repeat(RAW_TEXT_HTTP_LIMITS.finalBytes + 1)) });
  await assert.rejects(hard.generate(input()), /RAW_TEXT_STRING/u);
});

test('raw HTTP validates Content-Length exactly, encoding, closed chat shape and final-only semantics', async () => {
  const valid = JSON.stringify(envelope('ok')), bytes = Buffer.byteLength(valid);
  for (const headers of [
    { 'content-length':String(bytes - 1) }, { 'content-length':String(bytes + 1) }, { 'content-length':'1.5' },
    { 'content-length':'-1' }, { 'content-length':'01' }, { 'content-length':'9007199254740992' },
    { 'content-encoding':'gzip' }, { 'content-type':'application/json; charset=latin1' },
  ]) {
    const port = createRawTextHttpPort(config, { fetch:async () => new Response(valid, { headers:{ 'content-type':'application/json', ...headers } }) });
    await assert.rejects(port.generate(input()), /RAW_TEXT_/u);
  }
  const exact = createRawTextHttpPort({ ...config, maxResponseBytes:bytes }, { fetch:async () => new Response(valid, {
    headers:{ 'content-type':'application/json', 'content-length':String(bytes) } }) });
  assert.equal(await exact.generate(input()), 'ok');
  const envelopes = [ { ...envelope(), extra:'forbidden' }, { choices:[] },
    { choices:[{ ...envelope().choices[0], finish_reason:'length' }] },
    ...[{ tool_calls:[{}] }, { audio:{} }, { function_call:{} }, { refusal:'denied' }, { content:[{ type:'text', text:'x' }] },
      { content:'\ud800' }, { reasoning_content:{} }, { role:'tool' }].map(change => ({ choices:[{ ...envelope().choices[0],
        message:{ ...envelope().choices[0]!.message, ...change } }] })) ];
  for (const value of envelopes) {
    const port = createRawTextHttpPort(config, { fetch:async () => new Response(JSON.stringify(value), { headers:{ 'content-type':'application/json' } }) });
    await assert.rejects(port.generate(input()), /RAW_TEXT_/u);
  }
});

test('raw HTTP abort while fetch ignores signal holds the slot through late rejection and observes it', async () => {
  const pending = deferred<Response>(); let fetched = 0, settled = false;
  const port = createRawTextHttpPort(config, { fetch:() => { fetched++; return pending.promise; } });
  const abort = new AbortController(), raw = port.generate(input({ signal:abort.signal }));
  const outcome = assert.rejects(raw, error => { assert.equal((error as Error).message, 'RAW_TEXT_ABORTED'); return true; });
  void raw.then(() => { settled = true; }, () => { settled = true; });
  abort.abort(new Error('fixture/private-abort')); await tick();
  assert.equal(settled, false); await assert.rejects(port.generate(input({ requestId:'fixture/other' })), /RAW_TEXT_BUSY/u);
  assert.equal(fetched, 1); pending.reject(new Error('fixture/private-late-network')); await outcome; await tick();
  assert.equal(settled, true); assert.equal(fetched, 1);
});

test('raw HTTP abort before headers waits for late response cancellation to actually settle', async () => {
  const pending = deferred<Response>(), cleanup = deferred<void>(); let canceled = 0, settled = false, fetched = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { canceled++; return cleanup.promise; } }), { headers:{ 'content-type':'application/json' } });
  const port = createRawTextHttpPort(config, { fetch:() => { fetched++; return pending.promise; } });
  const abort = new AbortController(), raw = port.generate(input({ signal:abort.signal }));
  const outcome = assert.rejects(raw, /RAW_TEXT_ABORTED/u); void raw.then(() => { settled = true; }, () => { settled = true; });
  try {
    abort.abort(); pending.resolve(response); await tick();
    assert.equal(canceled, 1); assert.equal(settled, false);
    await assert.rejects(port.generate(input()), /RAW_TEXT_BUSY/u); assert.equal(fetched, 1);
  } finally { cleanup.resolve(); }
  await outcome; assert.equal(settled, true);
});

test('raw HTTP body abort keeps the actual reader cancellation promise and raw slot pending', async () => {
  const cleanup = deferred<void>(), reading = deferred<void>(); let canceled = 0, settled = false;
  const port = createRawTextHttpPort(config, { fetch:async () => new Response(new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); }, cancel() { canceled++; return cleanup.promise; },
  }), { headers:{ 'content-type':'application/json' } }) });
  const abort = new AbortController(), raw = port.generate(input({ signal:abort.signal }));
  const outcome = assert.rejects(raw, /RAW_TEXT_ABORTED/u); void raw.then(() => { settled = true; }, () => { settled = true; });
  try {
    await reading.promise; await tick(); abort.abort(); await tick();
    assert.equal(canceled, 1); assert.equal(settled, false); await assert.rejects(port.generate(input()), /RAW_TEXT_BUSY/u);
  } finally { cleanup.resolve(); }
  await outcome; assert.equal(settled, true);
});

test('raw HTTP byte overflow and HTTP failure await hanging cleanup; rejection is sanitized and no retry occurs', async () => {
  for (const failure of ['oversize','status'] as const) {
    const cleanup = deferred<void>(); let canceled = 0, settled = false, fetched = 0;
    const port = createRawTextHttpPort({ ...config, maxResponseBytes:10 }, { fetch:async () => {
      fetched++; return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { canceled++; return cleanup.promise; },
      }), { status:failure === 'status' ? 429 : 200, headers:{ 'content-type':'application/json' } });
    } });
    const raw = port.generate(input()), outcome = assert.rejects(raw, failure === 'status' ? /RAW_TEXT_HTTP_STATUS/u : /RAW_TEXT_RESPONSE_TOO_LARGE/u);
    void raw.then(() => { settled = true; }, () => { settled = true; });
    try { await tick(); assert.equal(canceled, 1); assert.equal(settled, false);
      await assert.rejects(port.generate(input()), /RAW_TEXT_BUSY/u); assert.equal(fetched, 1);
    } finally { cleanup.reject(new Error('fixture/private-cleanup')); }
    await outcome; assert.equal(settled, true); assert.equal(fetched, 1);
  }
});

test('raw HTTP observes ordinary body read rejection and rejects reentrant dispatch without clearing the old slot', async () => {
  let controller!:ReadableStreamDefaultController<Uint8Array>, fetched = 0, reentrant:Promise<string> | undefined;
  const port = createRawTextHttpPort(config, { fetch:async () => { fetched++; return new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
  }), { headers:{ 'content-type':'application/json' } }); } });
  const raw = port.generate(input({ validateBeforeSend:() => { reentrant = port.generate(input()); return true; } }));
  const outcome = assert.rejects(raw, error => { assert.equal((error as Error).message, 'RAW_TEXT_RESPONSE_INVALID'); return true; });
  await assert.rejects(reentrant!, /RAW_TEXT_BUSY/u); await tick(); await assert.rejects(port.generate(input()), /RAW_TEXT_BUSY/u);
  controller.error(new Error('fixture/private-read')); await outcome; assert.equal(fetched, 1);
});
