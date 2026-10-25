import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import { MemoryStore } from '../src/store.ts';
import { extractMemory } from '../src/pipeline.ts';
import { BoundedInferenceAdapter, bounded } from '../src/runtime.ts';
import { HostMemoryService, publicError } from '../src/host.ts';
import { mountDshHost } from '../src/host-mounts.ts';
import { CoreError } from '../src/validation.ts';
import type { InferenceAdapter, Proposal, Evidence } from '../src/contracts.ts';

const who = { tenantId:'synthetic', subjectId:'alice', personaId:'companion', relationshipId:'test' };
const claim: Proposal = { kind:'claim', statement:'I prefer blue.', basis:'self_report', validFrom:null, validTo:null };
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/hosts-v1.json', import.meta.url), 'utf8'));
const dshBind = { identity:who, host:'dsh' as const, hostInstanceId:'synthetic-host', sessionId:'dsh-synthetic-session' };
const codexBind = { ...dshBind, host:'codex-app-server' as const, sessionId:'codex-synthetic-thread' };
const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function provider(run: InferenceAdapter['proposeMemory'] = async () => claim): InferenceAdapter {
  return { capabilities:{ providerId:'synthetic', modelVersion:'1', input:['text'], structuredOutput:'validated', cancellation:'local_drop_only' }, proposeMemory:run };
}
function setup(t: TestContext) {
  const path = join(mkdtempSync(join(tmpdir(), 'companion-m1-')), 'synthetic.sqlite');
  const store = new MemoryStore(path); t.after(() => store.close());
  const scope = store.ensureScope(who);
  const source = () => store.acceptEvent(scope, { source:'synthetic', eventKey:'one', evidence:{ speakerId:'alice', speakerRole:'subject', mode:'self_report', selectedText:claim.statement, occurredAt:null } });
  const jobs = () => { const db = new DatabaseSync(path, { readOnly:true }); try { return db.prepare('SELECT * FROM jobs').all(); } finally { db.close(); } };
  return { store, scope, path, source, jobs };
}

test('hung provider cancellation settles immediately, terminalizes job, and drops late result', async t => {
  const { store, scope, source, jobs } = setup(t); const pending = deferred<Proposal>(); const controller = new AbortController();
  const operation = extractMemory(store, scope, [source()], provider(() => pending.promise), controller.signal, { timeoutMs:10_000 });
  const rejected = assert.rejects(operation, { name:'AbortError' }); controller.abort();
  const start = performance.now(); await rejected; assert.ok(performance.now() - start < 1000);
  assert.equal(jobs()[0]!.status, 'revoked'); assert.equal(jobs()[0]!.draft, null);
  assert.throws(() => store.claimLease(scope, jobs()[0]!.id as string), code('JOB_NOT_PENDING'));
  pending.resolve(claim); await tick(); assert.deepEqual(store.search(scope, 'blue'), []);
});

test('deadline handles a provider that never settles and consumed late rejection', async t => {
  const { store, scope, source, jobs } = setup(t); const pending = deferred<Proposal>();
  await assert.rejects(extractMemory(store, scope, [source()], provider(() => pending.promise), undefined, { timeoutMs:15 }), code('INFERENCE_TIMEOUT'));
  assert.equal(jobs()[0]!.status, 'revoked'); pending.reject(new Error('late synthetic failure')); await tick();
});

test('synchronous late resolution cannot beat a starved deadline timer', async () => {
  await assert.rejects(bounded(new AbortController().signal, 5, async () => {
    const end = performance.now() + 12; while (performance.now() < end) { /* synthetic blocking provider */ }
    return claim;
  }), code('INFERENCE_TIMEOUT'));
});

test('invalid output, provider throw, and falsy rejection all terminate without drafts', async t => {
  const { store, scope, source, jobs } = setup(t);
  for (const run of [async () => null as unknown as Proposal, async () => { throw new Error('synthetic secret'); }, async () => Promise.reject(null)]) {
    await assert.rejects(extractMemory(store, scope, [source()], provider(run)));
  }
  assert.equal(jobs().length, 3);
  assert.ok(jobs().every(row => row.status === 'revoked' && row.draft === null));
});

test('abandoned old lease cannot revoke a replacement lease or a published job', t => {
  const { store, scope, source } = setup(t);
  const job = store.beginJob(scope, [source()]); const lease = store.claimLease(scope, job.id);
  assert.equal(store.abandonJob(job, 'wrong'), false);
  store.propose(scope, job.id, lease.token, claim); store.publish(scope, job.id, lease.token);
  assert.equal(store.abandonJob(job, lease.token), false);
  assert.equal(store.search(scope, 'blue').length, 1);
});

test('expired worker cleanup cannot terminate a newer lease; pre-aborted extraction creates no job', async t => {
  let mono = 0;
  const store = new MemoryStore(':memory:', { clock:{ wall:() => 1000, monotonic:() => mono } }); t.after(() => store.close());
  const scope = store.ensureScope(who);
  const source = store.acceptEvent(scope, { source:'test', eventKey:'test', evidence:{ speakerId:who.subjectId, speakerRole:'subject', mode:'self_report', selectedText:claim.statement, occurredAt:null } });
  const job = store.beginJob(scope, [source]); const old = store.claimLease(scope, job.id, 1); mono = 2;
  const replacement = store.claimLease(scope, job.id);
  assert.equal(store.abandonJob(job, old.token), false);
  store.propose(scope, job.id, replacement.token, claim); store.publish(scope, job.id, replacement.token);
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(extractMemory(store, scope, [source], provider(async () => { called = true; return claim; }), controller.signal), { name:'AbortError' });
  assert.equal(called, false); assert.equal(store.search(scope, 'blue').length, 1);
});

test('bounded queue applies backpressure and keeps a cancelled noncooperative operation in its slot', async () => {
  const pending = deferred<Proposal>(); let calls = 0;
  const queue = new BoundedInferenceAdapter(provider(() => { calls++; return pending.promise; }), { concurrency:1, maxQueued:1 });
  const firstCancel = new AbortController(), secondCancel = new AbortController();
  const first = queue.proposeMemory({ selectedEvidence:[], signal:firstCancel.signal });
  const firstRejected = assert.rejects(first, { name:'AbortError' });
  const second = queue.proposeMemory({ selectedEvidence:[], signal:secondCancel.signal });
  const secondRejected = assert.rejects(second, { name:'AbortError' });
  await assert.rejects(queue.proposeMemory({ selectedEvidence:[], signal:new AbortController().signal }), code('BACKPRESSURE'));
  firstCancel.abort(); secondCancel.abort(); await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(queue.occupancy, { active:1, queued:0 }); assert.equal(calls, 1);
  pending.resolve(claim); await tick(); assert.deepEqual(queue.occupancy, { active:0, queued:0 });
});

test('two native protocol golden fixtures use the same evidence, provider and memory chain', async t => {
  const { store, scope } = setup(t); const seen: Evidence[][] = [];
  const service = new HostMemoryService(store, provider(async input => { seen.push(input.selectedEvidence); return claim; }));
  const dsh = service.bind(dshBind), codex = service.bind(codexBind);
  assert.equal(service.negotiate(dsh, JSON.stringify({ version:1, requiredCapabilities:['selected_text','local_cancel'] })).hostCancellation, 'not_integrated');
  await service.extract(dsh, JSON.stringify(fixtures.dsh)); await service.extract(codex, JSON.stringify(fixtures.codex));
  assert.deepEqual(seen[0], seen[1]); assert.equal(store.search(scope, 'blue').length, 2);
  assert.equal(seen[0]![0]!.speakerId, who.subjectId);
});

test('versioned JSON rejects identity injection, wrong session, non-user input, replacements and oversized input', async t => {
  const { store } = setup(t); let calls = 0;
  const service = new HostMemoryService(store, provider(async () => { calls++; return claim; }));
  const binding = service.bind(dshBind);
  const mutate = (change: (value: any) => void) => { const copy = structuredClone(fixtures.dsh); change(copy); return JSON.stringify(copy); };
  for (const raw of [
    mutate(x => x.scope = who), mutate(x => x.speakerId = 'bob'), mutate(x => x.version = 2),
    mutate(x => x.event.sessionId = 'other'), mutate(x => x.event.event.data.role = 'assistant'),
    mutate(x => x.event.event.data.source.kind = 'runtime-context'), mutate(x => x.event.event.surfaceOp = 'replace'),
    mutate(x => x.event.event.type = 'inbox/inserted'), mutate(x => x.event.event.data.content[0].type = 'image'),
    mutate(x => x.event.event.seq = -1), 'null', '{', ' '.repeat(65_537)
  ]) await assert.rejects(service.extract(binding, raw));
  await assert.rejects(service.extract({ version:1 }, JSON.stringify(fixtures.dsh)), code('UNAUTHENTICATED'));
  assert.equal(calls, 0);
});

test('Codex agent messages, deltas and unsupported text references cannot become subject self-report', async t => {
  const { store } = setup(t); const service = new HostMemoryService(store, provider()); const binding = service.bind(codexBind);
  for (const change of [(x: any) => x.event.params.item.type = 'agentMessage', (x: any) => x.event.method = 'item/agentMessage/delta',
    (x: any) => x.event.params.item.content[0].text_elements = [{ text:'hidden reference' }]]) {
    const copy = structuredClone(fixtures.codex); change(copy); await assert.rejects(service.extract(binding, JSON.stringify(copy)));
  }
});

test('old binding epoch cannot be washed by a new incoming event after purge or consent ABA', async t => {
  const { store, scope } = setup(t); const service = new HostMemoryService(store, provider()); const binding = service.bind(dshBind);
  const next = store.purge(scope);
  await assert.rejects(service.extract(binding, JSON.stringify(fixtures.dsh)), code('STALE_SCOPE'));
  const reauthenticated = service.bind(dshBind);
  const allowed = store.setLearningConsent(next, true); store.setLearningConsent(allowed, false);
  await assert.rejects(service.extract(reauthenticated, JSON.stringify(fixtures.dsh)), code('STALE_CONSENT'));
});

test('duplicate extraction is persistent across concurrency and database reopen', async t => {
  const { store, path, scope, jobs } = setup(t); const pending = deferred<Proposal>(); let calls = 0;
  const service = new HostMemoryService(store, provider(() => { calls++; return pending.promise; })); const binding = service.bind(dshBind);
  const first = service.extract(binding, JSON.stringify(fixtures.dsh));
  await assert.rejects(service.extract(binding, JSON.stringify(fixtures.dsh)), code('EXTRACTION_IN_PROGRESS'));
  pending.resolve(claim); const receipt = await first;
  assert.deepEqual(await service.extract(binding, JSON.stringify(fixtures.dsh)), receipt);
  const redelivered = structuredClone(fixtures.dsh); redelivered.event.event.seq++; redelivered.event.event.time += 10_000;
  assert.deepEqual(await service.extract(binding, JSON.stringify(redelivered)), receipt);
  const reopened = new MemoryStore(path);
  try {
    const next = new HostMemoryService(reopened, provider(async () => { calls++; return claim; }));
    assert.deepEqual(await next.extract(next.bind(dshBind), JSON.stringify(fixtures.dsh)), receipt);
  } finally { reopened.close(); }
  assert.equal(calls, 1); assert.equal(jobs().length, 1); assert.equal(store.search(scope, 'blue').length, 1);
});

test('failed selected operation is terminal across rebind; duplicate changed body conflicts', async t => {
  const { store, jobs, scope } = setup(t); let calls = 0;
  const service = new HostMemoryService(store, provider(async () => { calls++; throw new Error('synthetic provider failure'); })); const binding = service.bind(dshBind);
  await assert.rejects(service.extract(binding, JSON.stringify(fixtures.dsh)));
  await assert.rejects(service.extract(service.bind(dshBind), JSON.stringify(fixtures.dsh)), code('EXTRACTION_TERMINATED'));
  const changed = structuredClone(fixtures.dsh); changed.event.event.data.content[0].text = 'I prefer green.';
  await assert.rejects(service.extract(binding, JSON.stringify(changed)), code('IDEMPOTENCY_CONFLICT'));
  const allowed = store.setLearningConsent(scope, true); store.setLearningConsent(allowed, false);
  await assert.rejects(service.extract(service.bind(dshBind), JSON.stringify(fixtures.dsh)), code('EXTRACTION_TERMINATED'));
  assert.equal(calls, 1); assert.equal(jobs()[0]!.status, 'revoked');
});

test('unbinding cancels queued/active work and cannot be replayed with the old handle', async t => {
  const { store, jobs } = setup(t); const pending = deferred<Proposal>();
  const service = new HostMemoryService(store, provider(() => pending.promise)); const binding = service.bind(dshBind);
  const rejected = assert.rejects(service.extract(binding, JSON.stringify(fixtures.dsh)), { name:'AbortError' });
  service.unbind(binding); await rejected;
  await assert.rejects(service.extract(binding, JSON.stringify(fixtures.dsh)), code('UNAUTHENTICATED'));
  assert.equal(jobs()[0]!.status, 'revoked'); pending.resolve(claim); await tick();
});

test('DSH hook mount routes only the selected session and removes its hook', async t => {
  const { store } = setup(t); const service = new HostMemoryService(store, provider()); const binding = service.bind(dshBind);
  let callback!: (session: { id: string }, event: unknown) => void; let removed = false;
  const received = deferred<void>();
  const unmount = mountDshHost({ on(name, fn) { assert.equal(name, 'session/event'); callback = fn; return () => { removed = true; }; } }, service, binding,
    { sessionId:dshBind.sessionId, onReceipt:() => received.resolve(), onError:error => received.reject(error) });
  callback({ id:'other' }, fixtures.dsh.event.event); callback({ id:dshBind.sessionId }, fixtures.dsh.event.event);
  await received.promise; unmount(); unmount(); assert.equal(removed, true);
});

test('public failure mapping contains no raw provider or database message', () => {
  assert.deepEqual(publicError(new Error('synthetic-token-and-body')), { version:1, error:'INTERNAL_ERROR' });
  assert.deepEqual(publicError(new CoreError('SYNTHETIC_SECRET')), { version:1, error:'INTERNAL_ERROR' });
});
