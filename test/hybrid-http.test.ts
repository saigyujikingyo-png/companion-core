import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Evidence, Proposal } from '../src/contracts.ts';
import { createHybridHttpBackend } from '../src/hybrid-http.ts';
import type { HybridHttpSendContext } from '../src/hybrid-http.ts';
import { HybridBackendLane, HybridInferenceSession } from '../src/hybrid-inference.ts';
import type { HybridBackendPort, HybridValidator } from '../src/hybrid-inference.ts';
import { HYBRID_PROTOCOL, bindingDigest, profileDigest } from '../src/hybrid-profile.ts';
import type { HybridBinding, HybridLease, HybridProfile } from '../src/hybrid-profile.ts';
import { decodeHybridReply, encodeHybridRequest } from '../src/hybrid-wire.ts';
import { createRawTextHttpPort } from '../src/raw-text-http.ts';
import type { RawTextPort } from '../src/raw-text-http.ts';

const hash = 'a'.repeat(64);
function profile():HybridProfile { return { version:1, profileId:'fixture/hybrid',
  model:{ id:'fixture/model', revision:'a'.repeat(40), sha256:hash, precision:'fixture/fp32' },
  tokenizer:{ id:'fixture/tokenizer', revision:hash, sha256:hash }, processor:{ id:'fixture/processor', revision:hash, sha256:hash },
  chatTemplateSha256:hash, adapterSha256:null, routerAuxSha256:null,
  runtime:{ id:'fixture/runtime', buildSha256:hash, kernelSha256:hash, cacheLayoutSha256:hash, topologySha256:hash },
  modelModalities:['text'], stateFamilies:['attention-kv','ssm','convolution','position-prefix'], protocol:HYBRID_PROTOCOL }; }
function binding():HybridBinding { return { namespace:{ tenantId:'fixture/tenant', subjectId:'fixture/subject', personaId:'fixture/persona', relationshipId:'fixture/relation' },
  scopeId:'fixture/scope', generation:0, consentRevision:0, runtimeEpoch:0, permissionEpoch:0,
  sessionId:'fixture/session', purpose:'memory-proposal', evaluationGroup:'fixture/eval', sourceRefs:[{ id:'fixture/source', revision:1 }] }; }
const evidence:Evidence[] = [{ speakerId:'fixture/subject', speakerRole:'subject', mode:'self_report', selectedText:'合成候选 evidence.', occurredAt:null }];
const proposal:Proposal = { kind:'claim', statement:'合成 final.', basis:'self_report', validFrom:null, validTo:null };
const config = { endpoint:'http://127.0.0.1:1/chat', model:'fixture/model', protocol:'openai-chat-completions' as const };
function response(final = JSON.stringify(proposal)):Response { return new Response(JSON.stringify({ model:'provider/self-declared-wrong-model',
  choices:[{ index:0, finish_reason:'stop', message:{ role:'assistant', content:final, reasoning_content:'Synthetic discarded field.' } }] }),
  { headers:{ 'content-type':'application/json' } }); }
function request() {
  const lease:HybridLease = { controllerId:'fixture/controller', leaseId:'fixture/lease', epoch:0,
    profileDigest:profileDigest(profile()), bindingDigest:bindingDigest(binding()) };
  return { lease, requestBytes:encodeHybridRequest({ requestId:'fixture/request', lease, profileDigest:lease.profileDigest,
    binding:binding(), selectedEvidence:evidence }), signal:new AbortController().signal };
}
function deferred<T>() { let resolve!:(value:T) => void, reject!:(error:Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }
function session(lane:HybridBackendLane, extra:{ timeoutMs?:number; validateCurrent?:HybridValidator } = {}) {
  return new HybridInferenceSession({ lane, profile:profile(), binding:binding(), validateCurrent:() => true, ...extra });
}

test('Hybrid HTTP maps real loopback final Proposal and wraps only the original request identity', async () => {
  let fetched = 0, payload:unknown, context:HybridHttpSendContext | undefined;
  const owned = createServer((req, res) => {
    fetched++; const chunks:Buffer[] = []; req.on('data', (chunk:Buffer) => chunks.push(chunk));
    req.on('end', () => { payload = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type':'application/json' });
      res.end(JSON.stringify({ model:'unverified/different-label', choices:[{ index:0, finish_reason:'stop',
        message:{ role:'assistant', content:JSON.stringify(proposal), reasoning_content:'Synthetic hidden.' } }] })); });
  });
  await new Promise<void>(resolve => owned.listen(0, '127.0.0.1', resolve));
  try {
    const rawText = createRawTextHttpPort({ ...config, endpoint:`http://127.0.0.1:${(owned.address() as AddressInfo).port}/chat` });
    const backend = createHybridHttpBackend({ rawText, profile:profile(), validateBeforeSend:value => { context = value; return true; } });
    const original = request(), raw = backend.generate(original);
    assert.equal(raw.constructor, Promise); assert(Object.isFrozen(raw));
    const reply = await raw;
    assert.deepEqual(decodeHybridReply(reply, { requestId:'fixture/request', lease:original.lease, profileDigest:original.lease.profileDigest }), proposal);
    assert.deepEqual(context, { requestId:'fixture/request', lease:original.lease, profileDigest:original.lease.profileDigest, binding:binding() });
    assert(Object.isFrozen(context)); assert(Object.isFrozen(context!.binding.sourceRefs)); assert(Object.isFrozen(context!.lease));
    const serialized = JSON.stringify(payload); assert(serialized.includes('selectedEvidence'));
    for (const forbidden of ['controllerId','bindingDigest','permissionEpoch','fixture/tenant']) assert(!serialized.includes(forbidden));
    assert.equal(fetched, 1);
  } finally { owned.closeAllConnections(); await new Promise<void>(resolve => owned.close(() => resolve())); }
});

test('Hybrid mapper rejects wrong request/profile/lease/binding/purpose and malformed bytes before raw dispatch', async () => {
  let calls = 0;
  const backend = createHybridHttpBackend({ profile:profile(), rawText:{ generate:async () => { calls++; return JSON.stringify(proposal); } }, validateBeforeSend:() => true });
  const original = request();
  const mutations:Array<(r:Record<string, any>) => void> = [r => { r.version = 2; }, r => { r.kind = 'interaction'; },
    r => { r.requestId = ''; }, r => { r.requestId = 'x'.repeat(129); }, r => { r.profileDigest = 'b'.repeat(64); },
    r => { r.lease.leaseId = 'fixture/wrong'; }, r => { r.lease.epoch = 1; }, r => { r.lease.bindingDigest = 'b'.repeat(64); },
    r => { r.binding.permissionEpoch = 1; }, r => { r.binding.purpose = 'interaction'; },
    r => { r.selectedEvidence = []; }, r => { r.selectedEvidence[0].speakerId = 'fixture/wrong'; },
    r => { r.selectedEvidence[0].audio = 'forbidden'; }, r => { r.extra = true; }];
  for (const mutate of mutations) {
    const body = JSON.parse(new TextDecoder().decode(original.requestBytes)) as Record<string, any>; mutate(body);
    await assert.rejects(backend.generate({ ...original, requestBytes:new TextEncoder().encode(JSON.stringify(body)) }));
  }
  for (const bytes of [new Uint8Array([255]), new Uint8Array(65537), new TextEncoder().encode('{'),
    new Uint8Array(new SharedArrayBuffer(10))]) await assert.rejects(backend.generate({ ...original, requestBytes:bytes }));
  await assert.rejects(backend.generate({ ...original, lease:{ ...original.lease, leaseId:'fixture/wrong' } }), /HYBRID_IDENTITY_MISMATCH/u);
  const otherProfile = { ...profile(), profileId:'fixture/other-profile' };
  const other = createHybridHttpBackend({ profile:otherProfile, rawText:{ generate:async () => { calls++; return JSON.stringify(proposal); } }, validateBeforeSend:() => true });
  await assert.rejects(other.generate(original), /HYBRID_IDENTITY_MISMATCH/u); assert.equal(calls, 0);
});

test('Hybrid mapper rejects non-Proposal/E2/identity claims and invalid Proposal semantics', async () => {
  for (const final of ['An E2 conversational answer.', '{broken', JSON.stringify({ version:1, proposal }),
    JSON.stringify({ ...proposal, lease:'model-cannot-attest' }), JSON.stringify({ ...proposal, reasoning:'hidden' }),
    JSON.stringify({ ...proposal, kind:'belief', basis:'inference', validTo:null }),
    JSON.stringify({ ...proposal, basis:'inference' }), JSON.stringify({ ...proposal, validFrom:2, validTo:1 }),
    JSON.stringify({ ...proposal, statement:'a'.repeat(4097) }), JSON.stringify({ ...proposal, statement:'😀'.repeat(8192) })]) {
    const rawText = createRawTextHttpPort(config, { fetch:async () => response(final) });
    const backend = createHybridHttpBackend({ rawText, profile:profile(), validateBeforeSend:() => true });
    await assert.rejects(backend.generate(request()));
  }
});

test('Hybrid final send gate receives original binding and rejects stale/truthy/asynchronous permission with zero fetch', async () => {
  let fetched = 0, checked = 0;
  const rawText = createRawTextHttpPort(config, { fetch:async () => { fetched++; return response(); } });
  for (const deny of [() => false, () => 'true', () => Promise.resolve(true), () => Promise.reject(new Error('fixture/private')), () => { throw new Error('fixture/private'); }]) {
    const backend = createHybridHttpBackend({ rawText, profile:profile(), validateBeforeSend:context => {
      checked++; assert.deepEqual(context.binding, binding()); assert.equal(context.requestId, 'fixture/request'); return deny();
    } });
    await assert.rejects(backend.generate(request()), /RAW_TEXT_SEND_DENIED/u);
  }
  await tick(); assert.equal(checked, 5); assert.equal(fetched, 0);
});

test('Hybrid session dispatch/send/delivery/replay currentness remains authoritative and replay never fetches twice', async () => {
  let fetched = 0; const phases:string[] = [];
  const rawText = createRawTextHttpPort(config, { fetch:async () => { fetched++; return response(); } });
  const backend = createHybridHttpBackend({ rawText, profile:profile(), validateBeforeSend:() => { phases.push('send'); return true; } });
  const lane = new HybridBackendLane(backend), owner = session(lane, { validateCurrent:({ phase }) => { phases.push(phase); return true; } });
  const work = { requestId:'fixture/session', selectedEvidence:evidence };
  try { assert.deepEqual(await owner.propose(work), proposal); assert.deepEqual(await owner.propose(work), proposal);
    assert.deepEqual(phases, ['dispatch','send','deliver','replay']); assert.equal(fetched, 1);
  } finally { owner.close(); }
  let allowed = true;
  const revoked = session(lane, { validateCurrent:({ phase }) => phase !== 'deliver' || allowed });
  allowed = false;
  try { await assert.rejects(revoked.propose({ ...work, requestId:'fixture/revoked' }), /HYBRID_CURRENTNESS_DENIED/u);
    assert.equal(revoked.status('fixture/revoked')?.state, 'unknown_after_dispatch'); assert.equal(fetched, 2);
  } finally { revoked.close(); }
});

test('Hybrid public timeout holds HTTP raw slot and lane until ignored-abort fetch really rejects; UNKNOWN never retries', async () => {
  const pending = deferred<Response>(); let fetched = 0, signal:AbortSignal | null | undefined;
  const rawText = createRawTextHttpPort(config, { fetch:(_url, init) => { fetched++; signal = init?.signal; return pending.promise; } });
  const backend = createHybridHttpBackend({ rawText, profile:profile(), validateBeforeSend:() => true });
  const lane = new HybridBackendLane(backend), owner = session(lane, { timeoutMs:10 }), peer = session(lane);
  try {
    await assert.rejects(owner.propose({ requestId:'fixture/timeout', selectedEvidence:evidence }), /HYBRID_TIMEOUT/u);
    assert.equal(signal?.aborted, true); assert.equal(owner.status('fixture/timeout')?.transportSettled, false);
    assert.throws(() => peer.propose({ requestId:'fixture/peer', selectedEvidence:evidence }), /HYBRID_LANE_BUSY/u);
    await assert.rejects(rawText.generate({ requestId:'fixture/raw-peer', signal:new AbortController().signal,
      messages:[{ role:'user', content:'synthetic' }], validateBeforeSend:() => true }), /RAW_TEXT_BUSY/u);
    assert.equal(fetched, 1); pending.reject(new Error('fixture/private-late-error')); await tick();
    assert.equal(owner.status('fixture/timeout')?.transportSettled, true);
    assert.equal(owner.status('fixture/timeout')?.state, 'unknown_after_dispatch');
    assert.throws(() => owner.propose({ requestId:'fixture/timeout', selectedEvidence:evidence }), /HYBRID_UNKNOWN/u);
    assert.equal(fetched, 1);
  } finally { owner.close(); peer.close(); }
});

test('Hybrid public abort retains lane through hanging HTTP cleanup and late success cannot complete UNKNOWN', async () => {
  const pending = deferred<Response>(), cleanup = deferred<void>(); let canceled = 0, fetched = 0;
  const rawText = createRawTextHttpPort(config, { fetch:() => { fetched++; return pending.promise; } });
  const backend = createHybridHttpBackend({ rawText, profile:profile(), validateBeforeSend:() => true });
  const lane = new HybridBackendLane(backend), owner = session(lane), peer = session(lane), abort = new AbortController();
  const work = owner.propose({ requestId:'fixture/abort', selectedEvidence:evidence, signal:abort.signal });
  abort.abort(); await assert.rejects(work, /HYBRID_ABORTED/u);
  try {
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled++; return cleanup.promise; } }), { headers:{ 'content-type':'application/json' } }));
    await tick(); assert.equal(canceled, 1); assert.equal(owner.status('fixture/abort')?.transportSettled, false);
    assert.throws(() => peer.propose({ requestId:'fixture/peer', selectedEvidence:evidence }), /HYBRID_LANE_BUSY/u); assert.equal(fetched, 1);
  } finally { cleanup.resolve(); }
  await tick(); assert.equal(owner.status('fixture/abort')?.transportSettled, true);
  assert.equal(owner.status('fixture/abort')?.state, 'unknown_after_dispatch'); owner.close(); peer.close();
});

test('one shared raw port also prevents simultaneous fetch through two separate mapper/lane objects', async () => {
  const pending = deferred<Response>(); let fetched = 0;
  const rawText = createRawTextHttpPort(config, { fetch:() => { fetched++; return pending.promise; } });
  const create = () => session(new HybridBackendLane(createHybridHttpBackend({ rawText, profile:profile(), validateBeforeSend:() => true })));
  const first = create(), second = create(), work = first.propose({ requestId:'fixture/first', selectedEvidence:evidence });
  try { await assert.rejects(second.propose({ requestId:'fixture/second', selectedEvidence:evidence }), /HYBRID_BACKEND_FAILED/u);
    assert.equal(fetched, 1); pending.resolve(response()); assert.deepEqual(await work, proposal);
    assert.equal(second.status('fixture/second')?.state, 'unknown_after_dispatch');
  } finally { first.close(); second.close(); }
});
