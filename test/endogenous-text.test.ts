import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredFault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { COLD_SAFETY_PROFILE } from '../src/safety-format.ts';
import { AnchoredTextHost } from '../src/anchored-text-host.ts';
import { EndogenousOwner } from '../src/endogenous-lifecycle.ts';
import { CoupledSession } from '../src/coupled-runtime.ts';
import { parseControl } from '../src/endogenous-durable.ts';
import type { DurableAcceptedEndogenousText } from '../src/endogenous-durable.ts';
import { InteractionResources, RequestBudget } from '../src/interaction.ts';
import { createRawTextHttpPort } from '../src/raw-text-http.ts';
import type { RawTextPort } from '../src/raw-text-http.ts';
import type { HybridProfile } from '../src/hybrid-profile.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'text' };
const response = JSON.stringify({ version: 1, choice: 'TEXT', text: '合成短文本。' });
const rest = '{"version":1,"choice":"REST"}';
const hash = 'a'.repeat(64);
const profile: HybridProfile = { version: 1, profileId: 'synthetic/text',
  model: { id: 'synthetic/model', revision: hash, sha256: hash, precision: 'synthetic' },
  tokenizer: { id: 'synthetic/tokenizer', revision: hash, sha256: hash }, processor: { id: 'synthetic/processor', revision: hash, sha256: hash },
  chatTemplateSha256: hash, adapterSha256: null, routerAuxSha256: null,
  runtime: { id: 'synthetic/runtime', buildSha256: hash, kernelSha256: hash, cacheLayoutSha256: hash, topologySha256: hash },
  modelModalities: ['text'], stateFamilies: ['attention-kv', 'ssm', 'convolution', 'position-prefix'], protocol: 'companion-hybrid-json-v1' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(t: TestContext, maxCalls = 4) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'companion-e2-text-')));
  let wall = 100_000, mono = 0, fault: (p: AnchoredFault) => void = () => {};
  const clock = { wall: () => wall, monotonic: () => mono };
  const authority = LocalSqliteAuthority.create({ directory: join(root, 'authority'), authorityId: 'synthetic-authority', custodyDomain: 'independent' });
  const config = { directory: join(root, 'vault'), authority, keys: generateKeySet(), vaultId: 'synthetic-vault', identity: 'synthetic',
    storageDomain: 'payload', schemaVersion: 2 as const, storageProfile: COLD_SAFETY_PROFILE };
  const options = { clock, fault: (p: AnchoredFault) => fault(p) };
  let vault = AnchoredVault.create(config, 16, options);
  const scope = vault.store.ensureScope(who);
  const control = vault.createEndogenousTextControl(scope, { maxCalls, maxResultBytes: maxCalls * 256, maxDurationMs: 60_000, callTimeoutMs: 5000 });
  const hosts: AnchoredTextHost[] = [];
  const host = (raw: RawTextPort, onReady?: ConstructorParameters<typeof AnchoredTextHost>[0]['onReady']) => {
    const h = new AnchoredTextHost({ vault, scope: vault.store.scope(scope.id), raw, profile, clock: clock.monotonic,
      resources: new InteractionResources(new RequestBudget({ total: 16, hourly: 16, daily: 16 }, clock.monotonic)),
      ...(onReady ? { onReady } : {}) });
    hosts.push(h); return h;
  };
  t.after(() => { fault = () => {}; for (const h of hosts) { try { h.close(); } catch {} } vault.close(); authority.close(); });
  t.diagnostic(`retained P4/schema2 fixture: ${root}`);
  return { root, scope, control, host, get vault() { return vault; }, clock,
    advance: (ms: number) => { mono += ms; wall += ms; }, slow: (fn: (p: AnchoredFault) => void) => { fault = fn; },
    reopen: () => { vault.close(); vault = AnchoredVault.open(config, 16, options); return vault; } };
}
function record(f: ReturnType<typeof fixture>) { return parseControl(f.vault.store.endogenousControl()!); }
function noHumanWrites(f: ReturnType<typeof fixture>) {
  const image = f.vault.store.snapshot(), db = new DatabaseSync(':memory:');
  try { db.deserialize(image); for (const table of ['nodes', 'jobs', 'ingress', 'dependencies'])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0, table); }
  finally { db.close(); image.fill(0); }
}
function coreUsable(f: ReturnType<typeof fixture>, label: string) {
  const s = f.vault.store.scope(f.scope.id);
  f.vault.store.acceptEvent(s, { source: 'synthetic', eventKey: label, evidence: { speakerId: 'subject', speakerRole: 'subject',
    mode: 'self_report', selectedText: 'Synthetic post-refusal core check.', occurredAt: null } });
  f.vault.exportBackup(join(f.root, label));
}

test('P4/schema2: no-input TEXT, independent permission, durable delivery, normal reopen and no automatic revival', async t => {
  const f = fixture(t); let calls = 0;
  const raw: RawTextPort = { generate: async input => {
    assert.equal(input.validateBeforeSend(), true); calls++;
    const task = JSON.parse(input.messages[1]!.content);
    assert.equal(task.purpose, 'endogenous-text-choice'); assert.equal(task.modelProfile.identity, 'DECLARATION_ONLY');
    assert.equal(Object.hasOwn(task, 'selectedEvidence'), false); return response;
  } };
  const h = f.host(raw); h.resume(); await tick();
  assert.equal(calls, 1); assert.equal(h.read().lastReady, null); noHumanWrites(f);
  assert.equal(record(f).entries[0]!.outcome, 'TEXT'); assert.equal(f.vault.reserved, 1); assert.equal(f.vault.status.unknownRequests, 1);
  h.grantCommunicationWindow('after-first', 10_000, 'trusted-stdio'); await tick();
  assert.equal(h.read().lastReady, null); assert.equal(calls, 1);
  h.pause(); h.grantCommunicationWindow('second', 10_000, 'trusted-stdio'); h.resume(); await tick();
  const ready = h.read().lastReady!; assert.ok(ready); assert.equal(calls, 2);
  f.vault.terminal(ready.requestId, 'ready', ready.deliveryId); // Read-like idempotent transition proves persisted ready.
  const delivery = h.takeDelivery(ready.deliveryId);
  assert.equal(delivery.kind, 'endogenous'); assert.equal(delivery.memoryCandidate, null); assert.deepEqual(delivery.sourceRefs, []);
  assert.throws(() => h.takeDelivery(ready.deliveryId), /DELIVERY_ALREADY_CONSUMED/);
  await tick(); // Synthetic native consumer completes before the trusted ACK call.
  assert.equal(h.acknowledgeNativeCompletion(ready.deliveryId).status, 'acknowledged');
  f.vault.terminal(ready.requestId, 'acknowledged', ready.deliveryId); noHumanWrites(f);
  h.close(); f.reopen();
  const reopened = f.host(raw); await tick();
  assert.equal(reopened.read().lifecycle.state, 'paused'); assert.equal(reopened.read().lastReady, null); assert.equal(calls, 2);
  assert.equal(record(f).controlId, f.control.controlId); assert.equal(record(f).expiresAt, f.control.expiresAt);
  assert.deepEqual(record(f).limits, f.control.limits); assert.equal(record(f).entries.length, 2); assert.equal(f.vault.reserved, 2);
  assert.throws(() => f.vault.createEndogenousControl(f.vault.store.scope(f.scope.id)), /E1_CONTROL_EXISTS/);
  noHumanWrites(f);
});

test('real loopback raw HTTP composition: final budget TEXT can take/native-complete/ACK once without human evidence', async t => {
  const f = fixture(t, 1); let posts = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST'); posts++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.stream, false);
    assert.equal(JSON.parse(body.messages[1].content).purpose, 'endogenous-text-choice');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: response } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const raw = createRawTextHttpPort({ endpoint: `http://127.0.0.1:${address.port}/chat/completions`, model: 'synthetic', protocol: 'openai-chat-completions' });
  const h = f.host({ generate: input => raw.generate(input).catch(error => {
    t.diagnostic(`raw loopback rejection code: ${String(error.code)}`); throw error;
  }) }); h.grantCommunicationWindow('explicit-no-human-window', 10_000, 'trusted-stdio'); h.resume();
  for (let i = 0; i < 100 && !h.read().lastReady; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const ready = h.read().lastReady!; assert.ok(ready, JSON.stringify({ posts, state: h.read() })); assert.equal(h.read().lifecycle.state, 'exhausted');
  f.vault.terminal(ready.requestId, 'ready', ready.deliveryId);
  assert.equal(h.takeDelivery(ready.deliveryId).text, '合成短文本。'); await tick();
  assert.equal(h.acknowledgeNativeCompletion(ready.deliveryId).status, 'acknowledged');
  f.vault.terminal(ready.requestId, 'acknowledged', ready.deliveryId);
  h.pause(); assert.throws(() => h.takeDelivery(ready.deliveryId));
  assert.equal(posts, 1); assert.equal(f.vault.reserved, 1); assert.equal(record(f).entries.length, 1); noHumanWrites(f);
});

for (const action of ['pause', 'close', 'purge', 'consent', 'revoke-runtime', 'timeout', 'off', 'new-window'] as const) {
  test(`pending ${action}: late raw completion cannot accept/revive or refund`, async t => {
    const f = fixture(t), pending = deferred<string>(); let calls = 0, signal!: AbortSignal;
    const source = action === 'revoke-runtime' ? f.vault.store.acceptEvent(f.scope, { source: 'synthetic', eventKey: 'runtime-source',
      evidence: { speakerId: 'subject', speakerRole: 'subject', mode: 'self_report', selectedText: 'Synthetic runtime fixture.', occurredAt: null } }) : null;
    const h = f.host({ generate: input => { calls++; signal = input.signal; return pending.promise; } });
    if (action !== 'new-window') h.grantCommunicationWindow('original', 10_000, 'trusted-stdio');
    if (action === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    h.resume(); await tick(); assert.equal(record(f).permitHeld, true);
    if (action === 'pause') h.pause();
    if (action === 'close') h.close();
    if (action === 'purge') f.vault.store.purge(f.scope);
    if (action === 'consent') f.vault.store.setLearningConsent(f.scope, !f.scope.learningAllowed);
    if (source) {
      f.vault.store.revoke(f.scope, source);
      const current = f.vault.store.scope(f.scope.id);
      assert.equal(current.generation, f.scope.generation); assert.equal(current.consentRevision, f.scope.consentRevision);
      assert.ok(current.runtimeEpoch > f.scope.runtimeEpoch);
    }
    if (action === 'timeout') { f.advance(5000); t.mock.timers.tick(5000); }
    if (action === 'off') h.clearCommunicationWindow();
    if (action === 'new-window') h.grantCommunicationWindow('too-late', 10_000, 'trusted-stdio');
    if (!['off', 'new-window'].includes(action)) { assert.equal(signal.aborted, true); assert.equal(record(f).entries[0]!.outcome, 'UNKNOWN'); }
    assert.equal(record(f).permitHeld, true); pending.resolve(response); await tick();
    assert.equal(record(f).permitHeld, false); assert.equal(record(f).entries.length, 1); assert.equal(calls, 1);
    assert.equal(h.read().lastReady, null); assert.equal(f.vault.reserved, 1); assert.equal(f.vault.status.unknownRequests, 1);
    if (!['off', 'new-window'].includes(action)) assert.equal(record(f).entries[0]!.outcome, 'UNKNOWN');
    if (['purge', 'consent', 'revoke-runtime'].includes(action)) assert.equal(record(f).stop, 'FENCED');
    coreUsable(f, 'core-after-refusal');
  });
}

test('actual raw HTTP body cleanup stays held after pause until original cancel settles', async t => {
  const f = fixture(t), cleanup = deferred<void>(); let cancellations = 0;
  const raw = createRawTextHttpPort({ endpoint: 'http://127.0.0.1:1/synthetic', model: 'synthetic', protocol: 'openai-chat-completions' },
    { fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancellations++; return cleanup.promise; } }),
      { status: 503, headers: { 'content-type': 'application/json' } }) });
  const h = f.host(raw); h.resume(); await tick(); assert.equal(cancellations, 1);
  h.pause(); await tick(); assert.equal(record(f).permitHeld, true);
  assert.throws(() => h.resume(), /E1_RAW_BUSY/); cleanup.resolve(); await tick();
  assert.equal(record(f).permitHeld, false); assert.equal(record(f).entries[0]!.outcome, 'UNKNOWN');
  assert.equal(h.read().lastReady, null); assert.equal(f.vault.reserved, 1); coreUsable(f, 'cleanup-core');
});

for (const stage of ['e1-reserve', 'claim', 'safety-reserve', 'terminal', 'ready', 'taken', 'ack'] as const) {
  test(`slow ${stage} commit cannot extend the original deadline`, async t => {
    const f = fixture(t); let calls = 0, commits = 0, armed = false;
    const h = f.host({ generate: async () => { calls++; return response; } });
    h.grantCommunicationWindow('original', 10_000, 'trusted-stdio');
    const dispatchCommit = { 'e1-reserve': 1, claim: 2, 'safety-reserve': 3, terminal: 5, ready: 6, taken: 0, ack: 0 }[stage];
    f.slow(p => { if (armed && p === 'finalized' && ++commits === dispatchCommit) f.advance(6000); });
    armed = true; h.resume(); await tick();
    if (stage === 'taken' || stage === 'ack') {
      const ready = h.read().lastReady!; assert.ok(ready);
      if (stage === 'ack') h.takeDelivery(ready.deliveryId);
      f.slow(p => { if (p === 'finalized') { f.slow(() => {}); f.advance(6000); } });
      assert.throws(() => stage === 'taken' ? h.takeDelivery(ready.deliveryId) : h.acknowledgeNativeCompletion(ready.deliveryId));
      if (stage === 'ack') f.vault.terminal(ready.requestId, 'acknowledged', ready.deliveryId); // Irreversible actual native-completion fact.
      assert.throws(() => h.takeDelivery(ready.deliveryId));
    } else assert.equal(h.read().lastReady, null);
    assert.equal(calls, ['e1-reserve', 'claim', 'safety-reserve'].includes(stage) ? 0 : 1);
    assert.equal(record(f).entries.length, 1); assert.equal(record(f).permitHeld, stage === 'e1-reserve');
    if (stage === 'terminal') assert.equal(record(f).entries[0]!.outcome, 'UNKNOWN');
    coreUsable(f, 'slow-core');
  });
}

test('ready text loses old permission permanently; restored pending retains held and never acquires new IDs', async t => {
  const f = fixture(t), h = f.host({ generate: async () => response });
  h.grantCommunicationWindow('first', 10_000, 'trusted-stdio'); h.resume(); await tick();
  const id = h.read().lastReady!.deliveryId; h.clearCommunicationWindow();
  h.grantCommunicationWindow('replacement', 10_000, 'trusted-stdio'); assert.throws(() => h.takeDelivery(id));
  h.close(); f.reopen();
  const pending = deferred<string>(), fresh = f.host({ generate: () => pending.promise });
  fresh.resume(); await tick(); fresh.close(); const consumed = record(f).entries.length;
  f.reopen();
  assert.equal(record(f).permitHeld, true); assert.equal(record(f).stop, 'RECONCILE_REQUIRED');
  assert.equal(record(f).controlId, f.control.controlId); assert.equal(record(f).entries.length, consumed);
  assert.throws(() => f.host({ generate: async () => response }), /E1_RECONCILE_REQUIRED/);
  pending.resolve(response); await tick(); assert.equal(record(f).permitHeld, true);
  coreUsable(f, 'reopen-core');
});

test('strict TEXT profile keeps old REST/NOOP behavior and rejects alternate payloads', async t => {
  const f = fixture(t); assert.throws(() => f.vault.openEndogenousControl(async () => rest), /E1_CONTROL_PROFILE/);
  const old = new EndogenousOwner(), oldSession = old.bind(async () => response); t.after(() => old.close());
  oldSession.start(); await tick(); assert.equal(oldSession.read().entries[0]!.outcome, 'UNKNOWN');
  for (const value of [JSON.stringify({ version: 1, choice: 'TEXT', text: 'x'.repeat(161) }),
    '{"version":1,"choice":"TEXT","text":"ok","nextWakeInMs":10}',
    '{"version":1,"choice":"TEXT","text":"ok","memoryProposal":null}',
    '{"version":1,"choice":"TEXT","text":"\\ud800"}']) {
    let accepted = 0; const owner = new EndogenousOwner({ profile: 'text-choice-v1', acceptText: () => { accepted++; } });
    const s = owner.bindText(async () => value); s.start(); await tick(); assert.equal(accepted, 0); assert.equal(s.read().entries[0]!.outcome, 'UNKNOWN'); owner.close();
  }
  const h = f.host({ generate: async () => rest }); h.resume(); await tick();
  assert.equal(record(f).entries[0]!.outcome, 'REST'); assert.equal(f.vault.status.unknownRequests, 1); assert.equal(h.read().lastReady, null);
});

test('acceptance hook failures/async returns cannot become permissions or poison Core', async t => {
  for (const hook of [() => false, () => Promise.resolve(true), () => Promise.reject(new Error('synthetic-hook-rejection')),
    () => { throw new Error('synthetic-hook-throw'); }, () => ({ then() { throw new Error('must-not-assimilate'); } })]) {
    const f = fixture(t, 1); let attempts = 0;
    const s = f.vault.openEndogenousTextControl(async () => response, () => { attempts++; return hook(); });
    s.resume(); await tick();
    assert.equal(attempts, 1); assert.equal(record(f).entries[0]!.outcome, 'TEXT'); assert.equal(record(f).permitHeld, false);
    assert.equal(s.read().state, 'exhausted'); coreUsable(f, 'hook-core'); s.close();
  }
});

test('TEXT window is independent from old human-ACK/presence gates; explicit quiet always revokes it', t => {
  const f = fixture(t), resources = new InteractionResources(new RequestBudget({ total: 1, hourly: 1, daily: 1 }, f.clock.monotonic));
  const s = new CoupledSession(f.vault.store, f.scope, { resources, clock: f.clock.monotonic, enableProactive: true,
    provider: { interact: async () => { throw new Error('no-model-call'); } } });
  s.resume();
  assert.throws(() => s.grantCompanionWindow('old', 1000, 'trusted-stdio'));
  const before = s.status;
  s.grantEndogenousTextWindow('explicit', 1000, 'trusted-stdio');
  assert.equal(s.status.proactiveAllowed, false); assert.deepEqual(s.status.companionWindow, before.companionWindow);
  const initialPermission = s.captureEndogenousTextPermission(); assert.ok(initialPermission.window);
  s.setHostContext({ quiet: false, available: false, ttlMs: 1000 });
  const permission = s.captureEndogenousTextPermission();
  assert.equal(permission.window!.id, initialPermission.window.id); assert.notEqual(permission.epoch, initialPermission.epoch);
  assert.equal(s.status.proactiveAllowed, false);
  s.setHostContext({ quiet: true, available: false, ttlMs: 1000 });
  s.grantEndogenousTextWindow('while-old-quiet', 1000, 'trusted-stdio');
  // Old quiet was already true; this new explicit quiet command must still revoke TEXT.
  s.setHostContext({ quiet: true, available: false, ttlMs: 1000 });
  assert.equal(s.captureEndogenousTextPermission().window, null);
  assert.throws(() => s.prepareEndogenousText({ decisionId: 'synthetic:1', text: 'short', scope: f.scope,
    deadlineMonotonicMs: 500, permission, validate: () => true }), /E2_COMMUNICATION_DENIED/);
  s.grantEndogenousTextWindow('later', 1000, 'trusted-stdio');
  assert.throws(() => s.prepareEndogenousText({ decisionId: 'synthetic:1', text: 'short', scope: f.scope,
    deadlineMonotonicMs: 500, permission: s.captureEndogenousTextPermission(), validate: () => true }), /INTENT_ALREADY_CONSUMED/);
  s.pause();
});

for (const action of ['pause', 'close'] as const) for (const maxCalls of [4, 1]) {
  test(`ready notification can synchronously ${action} at capacity ${maxCalls} without E1 reentry`, async t => {
    const f = fixture(t, maxCalls); let calls = 0, notices = 0, completed = false, callbackError: unknown;
    let h!: AnchoredTextHost;
    h = f.host({ generate: async () => { calls++; return response; } }, () => {
      notices++;
      try { h[action](); completed = true; } catch (error) { callbackError = error; throw error; }
    });
    h.grantCommunicationWindow('callback-stop', 10_000, 'trusted-stdio'); h.resume(); await tick();
    assert.equal(notices, 1); assert.equal(completed, true, String(callbackError));
    const state = h.read();
    assert.equal(state.lifecycle.timerPending, false); assert.equal(state.lifecycle.actualPending, false);
    assert.equal(state.control.stop, maxCalls === 1 ? 'EXHAUSTED' : action === 'close' ? 'CLOSED' : 'PAUSED');
    assert.equal(state.lifecycle.state, action === 'close' ? 'closed' : maxCalls === 1 ? 'exhausted' : 'paused');
    assert.equal(state.control.entries.length, 1); assert.equal(state.control.entries[0]!.decisionId, `${f.control.controlId}:1`);
    assert.equal(state.control.entries[0]!.outcome, 'TEXT'); assert.equal(state.lastReady, null);
    assert.equal(f.vault.reserved, 1); assert.equal(f.vault.status.unknownRequests, 1);
    await tick(); assert.equal(calls, 1); assert.equal(notices, 1);
    if (maxCalls === 1 && action === 'close') {
      f.reopen(); assert.equal(record(f).stop, 'EXHAUSTED');
      assert.throws(() => f.vault.openEndogenousTextControl(async () => response, () => true), /E1_CONTROL_STOPPED/);
    }
  });
}

test('ready notification queued before off is dropped; ordinary async notification rejection is consumed', async t => {
  const f = fixture(t); let notices = 0, commits = 0, armed = false;
  const h = f.host({ generate: async () => response }, async () => { notices++; throw new Error('synthetic-notification-rejection'); });
  h.grantCommunicationWindow('queued', 10_000, 'trusted-stdio');
  f.slow(p => {
    // ready's sixth commit runs before the Host can queue its notification.
    if (armed && p === 'finalized' && ++commits === 6) queueMicrotask(() => h.clearCommunicationWindow());
  });
  armed = true; h.resume(); await tick();
  assert.equal(notices, 0); assert.equal(h.read().lastReady, null);
  f.slow(() => {}); h.pause(); h.grantCommunicationWindow('later', 10_000, 'trusted-stdio'); h.resume(); await tick();
  assert.equal(notices, 1); assert.ok(h.read().lastReady);
  h.close(); assert.equal(h.read().lifecycle.timerPending, false);
});

for (const action of ['false', 'promise', 'throw', 'pause', 'close', 'true', 'last-call'] as const) {
  test(`saved TEXT delivery proof obeys synchronous acceptance and revocation: ${action}`, async t => {
    const f = fixture(t, action === 'last-call' ? 1 : 4); let saved!: DurableAcceptedEndogenousText;
    const s = f.vault.openEndogenousTextControl(async () => response, accepted => {
      saved = accepted;
      assert.equal(accepted.validateDelivery(), true); // The synchronous preparation phase is authorized.
      if (action === 'false') return false;
      if (action === 'promise') return Promise.resolve(true);
      if (action === 'throw') throw new Error('synthetic-acceptance-rejection');
      return true;
    });
    s.resume(); await tick(); assert.ok(saved);
    if (action === 'pause') s.pause();
    if (action === 'close') s.close();
    if (action === 'true' || action === 'last-call') {
      assert.equal(saved.validateDelivery(), true);
      if (action === 'last-call') assert.equal(s.read().state, 'exhausted');
      s.pause(); assert.throws(() => saved.validateDelivery());
    } else assert.throws(() => saved.validateDelivery());
    assert.equal(record(f).entries.length, 1); assert.equal(record(f).entries[0]!.outcome, 'TEXT');
    assert.equal(record(f).permitHeld, false); coreUsable(f, 'saved-proof-core'); s.close();
  });
}

test('Host scope must match durable control before owner/fence consumption; valid owner can still deliver', async t => {
  const f = fixture(t, 1), other = f.vault.store.ensureScope({ ...who, relationshipId: 'other-current-scope' });
  const current = f.vault.store.scope(f.scope.id), encoded = f.vault.store.endogenousControl(), head = f.vault.head;
  let calls = 0;
  const raw: RawTextPort = { generate: async input => { assert.equal(input.validateBeforeSend(), true); calls++; return response; } };
  const resources = () => new InteractionResources(new RequestBudget({ total: 16, hourly: 16, daily: 16 }, f.clock.monotonic));
  for (const scope of [other, { ...current, generation: current.generation + 1 },
    { ...current, consentRevision: current.consentRevision + 1 }, { ...current, runtimeEpoch: current.runtimeEpoch + 1 }]) {
    assert.throws(() => new AnchoredTextHost({ vault: f.vault, scope, raw, profile, resources: resources(), clock: f.clock.monotonic }), { code: 'E1_CONTROL_SCOPE' });
    assert.equal(f.vault.store.endogenousControl(), encoded); assert.deepEqual(f.vault.head, head);
    assert.equal(record(f).runFence, f.control.runFence); assert.equal(record(f).entries.length, 0);
    assert.equal(f.vault.reserved, 0); assert.equal(f.vault.status.unknownRequests, 0); assert.equal(calls, 0);
  }
  const h = f.host(raw); h.grantCommunicationWindow('original', 10_000, 'trusted-stdio'); h.resume(); await tick();
  const ready = h.read().lastReady!; assert.ok(ready); assert.equal(calls, 1);
  assert.equal(h.takeDelivery(ready.deliveryId).text, '合成短文本。'); await tick();
  assert.equal(h.acknowledgeNativeCompletion(ready.deliveryId).status, 'acknowledged');
  assert.equal(f.vault.reserved, 1); noHumanWrites(f);
});

after(() => console.log(JSON.stringify({ evidence: 'E2_TEXT_SYNTHETIC', maxRssKiB: process.resourceUsage().maxRSS, realModels: 0, deployment: 'NOT_RUN' })));
