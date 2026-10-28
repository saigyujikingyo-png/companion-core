import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredFault } from '../src/anchored-vault.ts';
import { AnchoredMessageHost } from '../src/anchored-message-host.ts';
import { AnchoredTextHost } from '../src/anchored-text-host.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { COLD_SAFETY_PROFILE } from '../src/safety-format.ts';
import { assertMessageCapacity, encodeControl, newControl, parseControl } from '../src/endogenous-durable.ts';
import type { MessageInput } from '../src/endogenous-durable.ts';
import { InteractionResources, RequestBudget } from '../src/interaction.ts';
import type { RawTextPort } from '../src/raw-text-http.ts';
import type { HybridProfile } from '../src/hybrid-profile.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'message' };
const binding = { origin: 'synthetic-authenticated-peer', route: 'synthetic-explicit-mental-route' };
const hash = 'a'.repeat(64);
const profile: HybridProfile = { version: 1, profileId: 'synthetic/message',
  model: { id: 'synthetic/model', revision: hash, sha256: hash, precision: 'synthetic' },
  tokenizer: { id: 'synthetic/tokenizer', revision: hash, sha256: hash }, processor: { id: 'synthetic/processor', revision: hash, sha256: hash },
  chatTemplateSha256: hash, adapterSha256: null, routerAuxSha256: null,
  runtime: { id: 'synthetic/runtime', buildSha256: hash, kernelSha256: hash, cacheLayoutSha256: hash, topologySha256: hash },
  modelModalities: ['text'], stateFamilies: ['attention-kv', 'ssm', 'convolution', 'position-prefix'], protocol: 'companion-hybrid-json-v1' };
const response = JSON.stringify({ version: 1, choice: 'TEXT', text: 'I decline this synthetic request.' });
const incoming: MessageInput = { messageId: 'original-message', text: 'Synthetic external quotation, not a subject self-report.', expiresAt: 110_000 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(t: TestContext, mode: 'message' | 'text' = 'message') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'companion-e3-message-')));
  let wall = 100_000, mono = 0, fault: (p: AnchoredFault) => void = () => {};
  const clock = { wall: () => wall, monotonic: () => mono };
  const authority = LocalSqliteAuthority.create({ directory: join(root, 'authority'), authorityId: 'synthetic-authority', custodyDomain: 'independent' });
  const config = { directory: join(root, 'vault'), authority, keys: generateKeySet(), vaultId: 'synthetic-vault', identity: 'synthetic',
    storageDomain: 'payload', schemaVersion: 2 as const, storageProfile: COLD_SAFETY_PROFILE };
  const options = { clock, fault: (p: AnchoredFault) => fault(p) };
  let vault = AnchoredVault.create(config, 16, options);
  const scope = vault.store.ensureScope(who), limits = { maxCalls: 1, maxResultBytes: 256, maxDurationMs: 60_000, callTimeoutMs: 5000 };
  const control = mode === 'message' ? vault.createEndogenousMessageControl(scope, limits) : vault.createEndogenousTextControl(scope, limits);
  const hosts: AnchoredMessageHost[] = [];
  const host = (raw: RawTextPort, onReady?: (ready: { deliveryId: string }) => void) => {
    const h = new AnchoredMessageHost({ vault, scope: vault.store.scope(scope.id), binding, raw, profile, clock: clock.monotonic,
      resources: new InteractionResources(new RequestBudget({ total: 16, hourly: 16, daily: 16 }, clock.monotonic)),
      ...(onReady ? { onReady } : {}) });
    hosts.push(h); return h;
  };
  t.after(() => { fault = () => {}; for (const h of hosts) { try { h.close(); } catch {} } vault.close(); authority.close(); });
  t.diagnostic(`retained SINGLE_MESSAGE_CONTROL_PROTOTYPE P4/schema2 fixture: ${root}`);
  return { root, scope, control, host, config, get vault() { return vault; }, clock,
    advance: (ms: number) => { mono += ms; wall += ms; },
    slow: (nth: number, ms: number) => { let writes = 0; fault = p => { if (p === 'finalized' && ++writes === nth) { mono += ms; wall += ms; } }; },
    reopen: () => { vault.close(); vault = AnchoredVault.open(config, 16, options); return vault; } };
}
const record = (f: ReturnType<typeof fixture>) => parseControl(f.vault.store.endogenousControl()!);
function noMemory(f: ReturnType<typeof fixture>) {
  const image = f.vault.store.snapshot(), db = new DatabaseSync(':memory:');
  try { db.deserialize(image); for (const table of ['nodes', 'jobs', 'ingress', 'dependencies'])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0, table); }
  finally { db.close(); image.fill(0); }
}
function coreUsable(f: ReturnType<typeof fixture>, label: string) {
  f.vault.store.acceptEvent(f.vault.store.scope(f.scope.id), { source: 'synthetic-health-check', eventKey: label,
    evidence: { speakerId: 'synthetic-peer', speakerRole: 'third_party', mode: 'quotation', selectedText: 'Synthetic core health fixture.', occurredAt: null } });
  f.vault.exportBackup(join(f.root, label));
}

test('receive is durable metadata only; exact duplicates never replenish, conflicts preserve Core', async t => {
  const f = fixture(t); let calls = 0;
  const h = f.host({ generate: async () => { calls++; return response; } });
  const input = { ...incoming }, receipt = h.receive(input), head = f.vault.head;
  input.text = 'Caller mutation';
  assert.equal(receipt.kind, 'MESSAGE_RECEIVED'); assert.equal(receipt.metadata, 'durable'); assert.equal(receipt.body, 'volatile');
  assert.equal(receipt.consideration, 'NOT_CONSIDERED'); assert.equal(receipt.decisionId, null);
  assert.equal(h.read().bodyAvailable, true); assert.equal(record(f).entries.length, 0); assert.equal(f.vault.reserved, 0);
  assert.deepEqual(h.receive(incoming), receipt); assert.deepEqual(f.vault.head, head);
  assert.throws(() => h.receive({ ...incoming, text: 'Changed' }), { code: 'E3_IDEMPOTENCY_CONFLICT' });
  assert.throws(() => h.receive({ ...incoming, expiresAt: 111_000 }), { code: 'E3_IDEMPOTENCY_CONFLICT' });
  assert.throws(() => h.receive({ ...incoming, messageId: 'other' }), { code: 'E3_MESSAGE_SLOT_OCCUPIED' });
  h.withdraw(); assert.equal(h.read().bodyAvailable, false);
  assert.equal(h.receive(incoming).consideration, 'NOT_CONSIDERED_UNAVAILABLE'); assert.equal(h.read().bodyAvailable, false);
  assert.throws(() => h.consider(), { code: 'E3_BODY_UNAVAILABLE' }); await tick();
  assert.equal(calls, 0); assert.equal(h.read().lastReady, null); noMemory(f); coreUsable(f, 'after-duplicates');
});

for (const choice of ['REST', 'NOOP', 'TEXT'] as const) test(`explicit ${choice}: one consideration, no task/executor/wake, native TEXT completion is separate`, async t => {
  const f = fixture(t); let calls = 0;
  const h = f.host({ generate: async input => {
    assert.equal(input.validateBeforeSend(), true); calls++;
    const task = JSON.parse(input.messages[1]!.content);
    assert.equal(task.purpose, 'external-message-choice'); assert.deepEqual(task.externalMessage.source, binding);
    assert.equal(task.externalMessage.text, incoming.text); assert.equal(task.decisionId, `${f.control.controlId}:1`);
    assert.equal(task.modelProfile.identity, 'DECLARATION_ONLY'); assert.equal(Object.hasOwn(task, 'selectedEvidence'), false);
    return choice === 'TEXT' ? response : JSON.stringify({ version: 1, choice });
  } });
  h.receive(incoming); h.grantCommunicationWindow('explicit', 10_000, 'trusted-stdio'); h.consider();
  assert.equal(record(f).inbound!.sequence, 1); assert.equal(record(f).entries[0]!.decisionId, `${f.control.controlId}:1`);
  await tick(); assert.equal(h.read().receipt!.consideration, choice); assert.equal(h.read().bodyAvailable, false);
  assert.equal(h.read().lifecycle.timerPending, false); assert.equal(record(f).stop, 'EXHAUSTED');
  if (choice === 'TEXT') {
    const ready = h.read().lastReady!; assert.ok(ready);
    const delivery = h.takeDelivery(ready.deliveryId); assert.equal(delivery.text, 'I decline this synthetic request.');
    assert.deepEqual(delivery.sourceRefs, []); assert.equal(delivery.memoryRef, null);
    const native = deferred<void>(); let completed = false;
    const completion = native.promise.then(() => { completed = true; return h.acknowledgeNativeCompletion(ready.deliveryId); });
    assert.equal(completed, false); native.resolve(); assert.equal((await completion).status, 'acknowledged');
    f.vault.terminal(ready.requestId, 'acknowledged', ready.deliveryId); // Exact original durable fact; no feedback reward.
    assert.throws(() => h.takeDelivery(ready.deliveryId));
  } else { assert.equal(h.read().lastReady, null); assert.equal(f.vault.status.unknownRequests, 1); }
  assert.equal(calls, 1); assert.equal(f.vault.reserved, 1); assert.equal(record(f).permitHeld, false);
  assert.throws(() => h.consider()); assert.equal(h.receive(incoming).consideration, choice); noMemory(f);
  h.close(); const before = record(f); f.reopen(); const reopened = f.host({ generate: async () => { calls++; return response; } });
  assert.equal(reopened.receive(incoming).consideration, choice); assert.equal(reopened.read().bodyAvailable, false);
  assert.throws(() => reopened.consider()); assert.equal(record(f).controlId, before.controlId);
  assert.equal(record(f).expiresAt, before.expiresAt); assert.equal(record(f).stop, 'EXHAUSTED'); assert.equal(calls, 1);
});

test('TEXT without original communication permission cannot be revived by a later grant', async t => {
  const f = fixture(t); let calls = 0;
  const h = f.host({ generate: async () => { calls++; return response; } }); h.receive(incoming); h.consider(); await tick();
  assert.equal(record(f).entries[0]!.outcome, 'TEXT'); assert.equal(h.read().lastReady, null);
  h.grantCommunicationWindow('too-late', 10_000, 'trusted-stdio'); await tick();
  assert.equal(h.read().lastReady, null); assert.equal(calls, 1); assert.equal(f.vault.status.unknownRequests, 1); noMemory(f);
});

test('shared delivery lane captures its original Vault and notification callback', async t => {
  const f = fixture(t); let original = 0, replacement = 0;
  const options = { vault: f.vault, scope: f.scope, binding, raw: { generate: async () => response }, profile,
    resources: new InteractionResources(new RequestBudget({ total: 16, hourly: 16, daily: 16 }, f.clock.monotonic)),
    clock: f.clock.monotonic, onReady: () => { original++; } };
  const h = new AnchoredMessageHost(options); t.after(() => h.close());
  options.vault = { claim: () => { throw new Error('WRONG_VAULT'); } } as unknown as AnchoredVault;
  options.onReady = () => { replacement++; };
  h.receive(incoming); h.grantCommunicationWindow('original', 10_000, 'trusted-stdio'); h.consider(); await tick();
  assert.equal(original, 1); assert.equal(replacement, 0); assert.equal(f.vault.reserved, 1);
  assert.equal(record(f).entries[0]!.outcome, 'TEXT'); assert.ok(h.read().lastReady); h.close();
});

for (const mode of ['E2', 'E3'] as const) test(`${mode} Host/control scope mismatch refuses before binding; exact scope can still bind and deliver`, async t => {
  const f = fixture(t, mode === 'E2' ? 'text' : 'message'); let calls = 0;
  const other = f.vault.store.ensureScope({ ...who, relationshipId: 'other-current-scope' });
  const options = { vault: f.vault, scope: other, binding, profile, clock: f.clock.monotonic,
    resources: new InteractionResources(new RequestBudget({ total: 16, hourly: 16, daily: 16 }, f.clock.monotonic)),
    raw: { generate: async (input: Parameters<RawTextPort['generate']>[0]) => { input.validateBeforeSend(); calls++; return response; } } };
  const before = f.vault.store.endogenousControl(), head = f.vault.head;
  const invalidScopes = [other, { ...f.scope, generation: f.scope.generation + 1 },
    { ...f.scope, consentRevision: f.scope.consentRevision + 1 }, { ...f.scope, runtimeEpoch: f.scope.runtimeEpoch + 1 }];
  for (const scope of invalidScopes) {
    assert.throws(() => mode === 'E2' ? new AnchoredTextHost({ ...options, scope }) : new AnchoredMessageHost({ ...options, scope }),
      { code: 'E1_CONTROL_SCOPE' });
    // Direct trusted callers can request the same atomic expected-scope check;
    // these probes specifically exercise bindControl, beyond Lane's current-scope guard.
    assert.throws(() => mode === 'E2'
      ? f.vault.openEndogenousTextControl(async () => response, () => true, undefined, scope)
      : f.vault.openEndogenousMessageControl(binding, async () => response, () => true, undefined, undefined, scope),
    { code: 'E1_CONTROL_SCOPE' });
    assert.equal(f.vault.store.endogenousControl(), before); assert.deepEqual(f.vault.head, head);
    assert.equal(record(f).runFence, 0); assert.equal(f.vault.status.ingressCount, 0); assert.equal(f.vault.reserved, 0); assert.equal(calls, 0);
  }
  const h = mode === 'E2' ? new AnchoredTextHost({ ...options, scope: f.scope }) : new AnchoredMessageHost({ ...options, scope: f.scope });
  t.after(() => h.close()); assert.equal(record(f).runFence, 1);
  h.grantCommunicationWindow('correct-scope', 10_000, 'trusted-stdio');
  if (h instanceof AnchoredMessageHost) { h.receive(incoming); h.consider(); } else h.resume();
  await tick(); const ready = h.read().lastReady!; assert.ok(ready); h.takeDelivery(ready.deliveryId);
  await tick(); assert.equal(h.acknowledgeNativeCompletion(ready.deliveryId).status, 'acknowledged');
  assert.equal(calls, 1); assert.equal(f.vault.reserved, 1); assert.equal(f.vault.status.ingressCount, 1); noMemory(f); h.close();
});

test('new profile is explicit and cannot add fields or replace an existing E1/E2 control', t => {
  const f = fixture(t);
  for (const name of ['rest-noop-v1', 'text-choice-v1'] as const) {
    const old = newControl({ authorityId: 'synthetic', vaultId: 'synthetic', identity: 'synthetic' }, f.scope, 100_000, undefined, name);
    assert.equal(Object.hasOwn(old, 'inbound'), false);
    assert.throws(() => parseControl(JSON.stringify({ ...old, inbound: null })), { code: 'E1_CONTROL_INVALID' });
  }
  assert.throws(() => f.vault.openEndogenousControl(async () => '{"version":1,"choice":"NOOP"}'), { code: 'E1_CONTROL_PROFILE' });
  assert.throws(() => f.vault.openEndogenousTextControl(async () => response, () => true), { code: 'E1_CONTROL_PROFILE' });
  assert.equal(record(f).profile, 'message-choice-v1'); assert.equal(record(f).entries.length, 0); coreUsable(f, 'after-profile-refusal');
});

test('invalid admission and worst future capacity are checked before durable consumption', t => {
  const f = fixture(t), h = f.host({ generate: async () => response }), before = f.vault.head;
  for (const text of ['x'.repeat(4097), '界'.repeat(1366), '\uD800', 'bad\0text']) assert.throws(() => h.receive({ ...incoming, text }));
  assert.throws(() => h.receive({ ...incoming, origin: 'spoofed' } as MessageInput));
  let getterCalls = 0; assert.throws(() => h.receive({ ...incoming, get text() { getterCalls++; return 'getter'; } }));
  assert.equal(getterCalls, 0); assert.deepEqual(f.vault.head, before); assert.equal(record(f).inbound, null);
  const extreme = newControl({ authorityId: '\u0001'.repeat(512), vaultId: '\u0002'.repeat(512), identity: '\u0003'.repeat(512) },
    { ...f.scope, id: '\u0004'.repeat(128) }, 1, undefined, 'message-choice-v1');
  extreme.inbound = { keyDigest: hash, fingerprint: hash, expiresAt: extreme.expiresAt, sequence: null };
  assert.doesNotThrow(() => assertMessageCapacity(extreme)); assert.ok(Buffer.byteLength(encodeControl(extreme)) < 16_384);
  assert.throws(() => assertMessageCapacity({ ...extreme, identity: 'x'.repeat(16_384) }));
  assert.throws(() => f.vault.createEndogenousMessageControl(f.scope), { code: 'E1_CONTROL_EXISTS' });
  assert.equal(f.vault.reserved, 0); noMemory(f); coreUsable(f, 'after-input-refusal');
});

for (const invalid of ['{"version":1,"choice":"REST","nextWakeInMs":10}', '{"version":1,"choice":"ACTION","skill":"execute"}'])
  test(`closed message choices reject ${invalid}`, async t => {
    const f = fixture(t), h = f.host({ generate: async () => invalid }); h.receive(incoming); h.consider(); await tick();
    assert.equal(record(f).entries[0]!.outcome, 'UNKNOWN'); assert.equal(record(f).entries[0]!.code, 'INVALID_DECISION');
    assert.equal(record(f).permitHeld, false); assert.equal(h.read().lifecycle.timerPending, false); assert.throws(() => h.consider());
    noMemory(f); coreUsable(f, 'after-choice-refusal');
  });

for (const action of ['pause', 'withdraw', 'close', 'purge', 'consent', 'runtime', 'expiry', 'off'] as const)
  test(`pending ${action}: revocation retains consumption/held until original native settlement`, async t => {
    const f = fixture(t), pending = deferred<string>(); let calls = 0, signal!: AbortSignal;
    const source = action === 'runtime' ? f.vault.store.acceptEvent(f.scope, { source: 'synthetic', eventKey: 'source',
      evidence: { speakerId: 'peer', speakerRole: 'third_party', mode: 'quotation', selectedText: 'Synthetic revocation fixture.', occurredAt: null } }) : null;
    const h = f.host({ generate: input => { calls++; signal = input.signal; return pending.promise; } });
    h.receive(incoming); h.grantCommunicationWindow('original', 10_000, 'trusted-stdio');
    if (action === 'expiry') t.mock.timers.enable({ apis: ['setTimeout'] });
    h.consider(); await tick(); assert.equal(record(f).permitHeld, true);
    if (action === 'pause') h.pause(); if (action === 'withdraw') h.withdraw(); if (action === 'close') h.close();
    if (action === 'purge') f.vault.store.purge(f.scope);
    if (action === 'consent') f.vault.store.setLearningConsent(f.scope, !f.scope.learningAllowed);
    if (source) f.vault.store.revoke(f.scope, source);
    if (action === 'expiry') { f.advance(5000); t.mock.timers.tick(5000); }
    if (action === 'off') h.clearCommunicationWindow();
    assert.equal(h.read().bodyAvailable, false); assert.equal(record(f).permitHeld, true);
    if (action !== 'off') { assert.equal(signal.aborted, true); assert.equal(record(f).entries[0]!.outcome, 'UNKNOWN'); }
    try { h.grantCommunicationWindow('new', 10_000, 'trusted-stdio'); } catch { /* A closed/fenced host cannot grant. */ }
    pending.resolve(response); await tick();
    assert.equal(record(f).permitHeld, false); assert.equal(record(f).entries.length, 1); assert.equal(calls, 1);
    assert.equal(h.read().lastReady, null); assert.equal(f.vault.status.unknownRequests, 1);
    assert.equal(record(f).entries[0]!.outcome, action === 'off' ? 'TEXT' : 'UNKNOWN');
    coreUsable(f, 'after-late-settlement');
  });

test('unconsidered expiry lazily revokes original body, and duplicate receive cannot renew it', t => {
  const f = fixture(t), h = f.host({ generate: async () => response }); h.receive({ ...incoming, expiresAt: 101_000 }); f.advance(1000);
  assert.equal(h.read().receipt!.consideration, 'NOT_CONSIDERED_UNAVAILABLE'); assert.equal(h.read().bodyAvailable, false);
  assert.equal(h.receive({ ...incoming, expiresAt: 101_000 }).consideration, 'NOT_CONSIDERED_UNAVAILABLE');
  assert.throws(() => h.consider()); assert.equal(record(f).entries.length, 0); assert.equal(f.vault.reserved, 0);
  coreUsable(f, 'after-unconsidered-expiry');
});

test('long sender expiry remains exact metadata while control expiry bounds the original permission', t => {
  const f = fixture(t), h = f.host({ generate: async () => response });
  const message = { ...incoming, expiresAt: Number.MAX_SAFE_INTEGER };
  assert.equal(h.receive(message).expiresAt, Number.MAX_SAFE_INTEGER);
  assert.equal(record(f).inbound!.expiresAt, Number.MAX_SAFE_INTEGER);
  f.advance(60_000);
  assert.equal(h.read().receipt!.consideration, 'NOT_CONSIDERED_UNAVAILABLE'); assert.equal(h.read().bodyAvailable, false);
  assert.equal(h.receive(message).expiresAt, Number.MAX_SAFE_INTEGER); assert.throws(() => h.consider());
  assert.equal(record(f).entries.length, 0); assert.equal(f.vault.reserved, 0); coreUsable(f, 'after-control-expiry');
});

test('slow receive commits metadata but grants no body after the original expiry', t => {
  const f = fixture(t), h = f.host({ generate: async () => response }); f.slow(1, 1000);
  assert.throws(() => h.receive({ ...incoming, expiresAt: 101_000 }));
  assert.ok(record(f).inbound); assert.equal(record(f).inbound!.sequence, null);
  assert.equal(h.read().bodyAvailable, false); assert.equal(h.read().receipt!.consideration, 'NOT_CONSIDERED_UNAVAILABLE');
  assert.throws(() => h.consider()); coreUsable(f, 'after-slow-receive');
});

for (const [phase, nth] of [['reservation', 1], ['claim', 2], ['Safety reserve', 3], ['terminal', 5], ['ready', 6]] as const)
  test(`slow ${phase} cannot extend original message deadline`, async t => {
    const f = fixture(t); let calls = 0;
    const h = f.host({ generate: async input => { input.validateBeforeSend(); calls++; return response; } });
    h.receive({ ...incoming, expiresAt: 101_000 }); h.grantCommunicationWindow('original', 10_000, 'trusted-stdio');
    f.slow(nth, 1000); h.consider(); await tick();
    assert.equal(calls, nth <= 3 ? 0 : 1); assert.equal(h.read().lastReady, null);
    assert.equal(record(f).entries.length, 1); assert.equal(record(f).permitHeld, nth === 1);
    assert.equal(record(f).entries[0]!.outcome, nth === 6 ? 'TEXT' : 'UNKNOWN');
    assert.equal(h.read().lifecycle.timerPending, false); coreUsable(f, `after-slow-${nth}`);
  });

for (const phase of ['take', 'ACK'] as const) test(`slow ${phase} rejects expired interface; actual ACK remains irreversible`, async t => {
  const f = fixture(t), h = f.host({ generate: async () => response });
  h.receive({ ...incoming, expiresAt: 101_000 }); h.grantCommunicationWindow('original', 10_000, 'trusted-stdio'); h.consider(); await tick();
  const ready = h.read().lastReady!; assert.ok(ready);
  if (phase === 'ACK') { h.takeDelivery(ready.deliveryId); await tick(); }
  f.slow(1, 1000);
  assert.throws(() => phase === 'take' ? h.takeDelivery(ready.deliveryId) : h.acknowledgeNativeCompletion(ready.deliveryId));
  f.vault.terminal(ready.requestId, phase === 'take' ? 'taken' : 'acknowledged', ready.deliveryId);
  h.clearCommunicationWindow(); h.grantCommunicationWindow('too-late', 10_000, 'trusted-stdio');
  assert.throws(() => h.takeDelivery(ready.deliveryId)); assert.equal(record(f).entries.length, 1); noMemory(f);
});

test('close/reopen preserves unconsidered receipt/ID/expiry but never refills RAM or auto-considers', async t => {
  const f = fixture(t); let calls = 0;
  const raw: RawTextPort = { generate: async () => { calls++; return response; } };
  const h = f.host(raw); h.receive(incoming); h.close(); const before = record(f); f.reopen();
  const reopened = f.host(raw); assert.equal(reopened.read().receipt!.consideration, 'NOT_CONSIDERED_UNAVAILABLE');
  assert.equal(reopened.receive(incoming).controlId, before.controlId); assert.equal(reopened.read().bodyAvailable, false);
  assert.equal(record(f).expiresAt, before.expiresAt); assert.deepEqual(record(f).inbound, before.inbound);
  assert.throws(() => reopened.consider()); await tick(); assert.equal(calls, 0); noMemory(f); coreUsable(f, 'after-reopen');
});

test('actual synthetic child exits after dispatch; reopen retains linked UNKNOWN/held and forbids replay', t => {
  const f = fixture(t), base = new URL('../src/', import.meta.url).href;
  const dataPath = join(f.root, 'synthetic-child.json'), scriptPath = join(f.root, 'synthetic-child.mjs');
  writeFileSync(dataPath, JSON.stringify({ root: f.root, keys: Object.fromEntries(Object.entries(f.config.keys).map(([key, value]) => [key, typeof value === 'number' ? value : Buffer.from(value).toString('base64')])), profile, who, binding, incoming }));
  writeFileSync(scriptPath, `import fs from 'node:fs';import path from 'node:path';
import {AnchoredVault} from '${base}anchored-vault.ts';import {LocalSqliteAuthority} from '${base}local-sqlite-authority.ts';
import {AnchoredMessageHost} from '${base}anchored-message-host.ts';import {InteractionResources,RequestBudget} from '${base}interaction.ts';
import {COLD_SAFETY_PROFILE} from '${base}safety-format.ts';
const d=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const authority=LocalSqliteAuthority.open({directory:path.join(d.root,'authority'),authorityId:'synthetic-authority',custodyDomain:'independent'});
const keys=Object.fromEntries(Object.entries(d.keys).map(([k,v])=>[k,typeof v==='number'?v:Buffer.from(v,'base64')]));const clock={wall:()=>100000,monotonic:()=>0};
const vault=AnchoredVault.open({directory:path.join(d.root,'vault'),authority,keys,vaultId:'synthetic-vault',identity:'synthetic',storageDomain:'payload',schemaVersion:2,storageProfile:COLD_SAFETY_PROFILE},16,{clock});
const scope=vault.store.ensureScope(d.who);const h=new AnchoredMessageHost({vault,scope,binding:d.binding,profile:d.profile,clock:clock.monotonic,
resources:new InteractionResources(new RequestBudget({total:16,hourly:16,daily:16},clock.monotonic)),raw:{generate(input){input.validateBeforeSend();process.exit(71);}}});
h.receive(d.incoming);h.consider();`);
  f.vault.close();
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', scriptPath, dataPath], { encoding: 'utf8', timeout: 15_000 });
  writeFileSync(join(f.root, 'child.stdout.log'), child.stdout ?? ''); writeFileSync(join(f.root, 'child.stderr.log'), child.stderr ?? '');
  assert.equal(child.error, undefined); assert.equal(child.status, 71, child.stderr);
  f.reopen(); const recovered = record(f); assert.equal(recovered.inbound!.sequence, 1);
  assert.equal(recovered.entries[0]!.decisionId, `${f.control.controlId}:1`); assert.equal(recovered.entries[0]!.outcome, 'UNKNOWN');
  assert.equal(recovered.permitHeld, true); assert.equal(recovered.stop, 'RECONCILE_REQUIRED');
  let calls = 0; const h = f.host({ generate: async () => { calls++; return response; } });
  assert.equal(h.receive(incoming).consideration, 'UNKNOWN'); assert.throws(() => h.consider()); assert.equal(calls, 0);
  assert.equal(record(f).permitHeld, true); noMemory(f); coreUsable(f, 'after-crash');
});

after(() => { process.stderr.write(`E3 worker maxRSS KiB: ${process.resourceUsage().maxRSS}\n`); });
