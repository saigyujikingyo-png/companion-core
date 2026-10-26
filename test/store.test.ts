import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import type { Clock } from '../src/store.ts';
import { CoreError } from '../src/validation.ts';
import type { Epoch, EventInput, InferenceAdapter, Proposal, SourceRef } from '../src/contracts.ts';
import { extractMemory } from '../src/pipeline.ts';

const who = { tenantId:'test', subjectId:'alice', personaId:'cheng', relationshipId:'private-alice' };
const claim: Proposal = { kind:'claim', statement:'我喜欢蓝色', basis:'self_report', validFrom:null, validTo:null };
const input = (eventKey = 'first', selectedText = '我喜欢蓝色'): EventInput => ({
  source:'synthetic', eventKey, evidence:{ speakerId:'alice', speakerRole:'subject', mode:'self_report', selectedText, occurredAt:null }
});
function fixture(t: TestContext) {
  const path = join(mkdtempSync(join(tmpdir(), 'companion-core-中文 path-')), 'test.sqlite');
  let wall = 1_000_000, mono = 0;
  const clock: Clock = { wall:() => wall, monotonic:() => mono };
  const store = new MemoryStore(path, { clock });
  t.after(() => store.close());
  const scope = store.ensureScope(who);
  return { store, scope, path, clock, advance(ms: number) { wall += ms; mono += ms; }, rollbackWall(ms: number) { wall -= ms; } };
}
function code(expected: string) { return (error: unknown) => error instanceof CoreError && error.code === expected; }
function publish(store: MemoryStore, scope: Epoch, sources: SourceRef[], proposal = claim): SourceRef {
  const job = store.beginJob(scope, sources); const lease = store.claimLease(scope, job.id);
  store.propose(scope, job.id, lease.token, proposal);
  return { ...store.publish(scope, job.id, lease.token), revision:1 };
}

test('every persisted memory image includes committed FTS inserts and deletions', () => {
  let persisted: Uint8Array | undefined, highWater = -1;
  const store = new MemoryStore(':memory:', { persist(image, revocations) {
    const copy = new DatabaseSync(':memory:');
    try {
      copy.deserialize(image);
      assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(), []);
      const rows = copy.prepare('SELECT count(*) AS n FROM memory_fts').get()!.n;
      const matches = copy.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'violet'").get()!.n;
      assert.equal(matches, rows);
      persisted = image; highWater = revocations;
    } finally { copy.close(); }
  } });
  try {
    const scope = store.ensureScope(who), sources: SourceRef[] = [];
    for (let i = 0; i < 4; i++) {
      const event = store.acceptEvent(scope, input(`image-${i}`, `SYNTHETIC violet ${i}`)); sources.push(event);
      publish(store, scope, [event], { ...claim, statement:`SYNTHETIC violet ${i}` });
    }
    store.revoke(scope, sources[0]!);
    assert.equal(highWater, 1);
    const restored = new MemoryStore(':memory:', { image:persisted! });
    try { assert.equal(restored.search(scope, 'violet').length, 3); assert.equal(restored.revocationHighWater(), 1); }
    finally { restored.close(); }
  } finally { store.close(); }
});

test('SQL body failure rolls back memory and FTS without checkpointing or poisoning a healthy writer',()=>{
  let checkpoints=0;const store=new MemoryStore(':memory:',{persist(){checkpoints++;}});
  const prepare=DatabaseSync.prototype.prepare;
  try {
    const scope=store.ensureScope(who),source=store.acceptEvent(scope,input('body-failure','SYNTHETIC violet'));
    const job=store.beginJob(scope,[source]),lease=store.claimLease(scope,job.id);
    store.propose(scope,job.id,lease.token,{...claim,statement:'SYNTHETIC violet'});const before=checkpoints;
    DatabaseSync.prototype.prepare=function(sql){
      if(sql.startsWith('INSERT INTO outbox'))throw new Error('SYNTHETIC_BODY_SQL_FAULT');
      return prepare.call(this,sql);
    };
    assert.throws(()=>store.publish(scope,job.id,lease.token),/SYNTHETIC_BODY_SQL_FAULT/);
    DatabaseSync.prototype.prepare=prepare;
    assert.equal(checkpoints,before);assert.equal(store.search(scope,'violet').length,0);
    assert.deepEqual(store.projectionBatch(scope),[]);assert.equal(store.diagnostics().integrity,true);
    store.publish(scope,job.id,lease.token);assert.equal(store.search(scope,'violet').length,1);assert.equal(checkpoints,before+1);
  } finally {DatabaseSync.prototype.prepare=prepare;store.close();}
});

test('selected evidence persists; source key is idempotent and conflicting input fails', t => {
  const { store, scope, path } = fixture(t);
  const event = store.acceptEvent(scope, input());
  assert.deepEqual(store.acceptEvent(scope, input()), event);
  assert.throws(() => store.acceptEvent(scope, input('first','different')), code('IDEMPOTENCY_CONFLICT'));
  const record = publish(store, scope, [event]);
  assert.equal(store.search(scope, '蓝色')[0]!.id, record.id);
  const reopened = new MemoryStore(path);
  try { assert.equal(reopened.read(scope, record)!.statement, claim.statement); assert.equal(reopened.diagnostics().integrity, true); }
  finally { reopened.close(); }
});

test('purge rejects late worker, old epochs and offline replay across reopen without generation reset', t => {
  const { store, scope, path } = fixture(t);
  const event = store.acceptEvent(scope, input()); const memory = publish(store, scope, [event]);
  const job = store.beginJob(scope, [event]); const lease = store.claimLease(scope, job.id);
  store.propose(scope, job.id, lease.token, claim);
  const next = store.purge(scope);
  assert.throws(() => store.publish(scope, job.id, lease.token), code('STALE_SCOPE'));
  assert.throws(() => store.acceptEvent(scope, input('new-wrapper')), code('STALE_SCOPE'));
  assert.deepEqual(store.search(next, '蓝色'), []);
  assert.equal(store.read(next, memory), null);
  const reopened = new MemoryStore(path);
  try {
    assert.equal(reopened.ensureScope(who).generation, 1);
    assert.equal(reopened.acceptEvent(next, input()).currentStatus, 'revoked');
    assert.equal(reopened.acceptEvent(next, input('genuinely-new','我喜欢绿色')).currentStatus, 'active');
  } finally { reopened.close(); }
});

test('lease expiry is exclusive; takeover token fences prior worker and clears its draft', t => {
  const { store, scope, advance } = fixture(t);
  const event = store.acceptEvent(scope, input()); const job = store.beginJob(scope, [event]);
  const a = store.claimLease(scope, job.id, 10); store.propose(scope, job.id, a.token, claim);
  advance(10);
  assert.throws(() => store.publish(scope, job.id, a.token), code('LEASE_EXPIRED'));
  assert.deepEqual(store.projectionBatch(scope), []);
  const b = store.claimLease(scope, job.id, 10);
  assert.notEqual(a.token, b.token);
  assert.throws(() => store.publish(scope, job.id, a.token), code('LEASE_LOST'));
  assert.throws(() => store.publish(scope, job.id, b.token), code('NO_DRAFT'));
  store.propose(scope, job.id, b.token, claim); store.publish(scope, job.id, b.token);
  assert.equal(store.projectionBatch(scope).length, 1);
});

test('wall clock rollback does not extend monotonic lease; reopening invalidates lease owner', t => {
  const { store, scope, path, advance, rollbackWall, clock } = fixture(t);
  const event = store.acceptEvent(scope, input()); const job = store.beginJob(scope, [event]);
  const lease = store.claimLease(scope, job.id, 10); store.propose(scope, job.id, lease.token, claim);
  advance(10); rollbackWall(500);
  assert.throws(() => store.publish(scope, job.id, lease.token), code('LEASE_EXPIRED'));
  const reopened = new MemoryStore(path, { clock });
  try {
    assert.throws(() => reopened.publish(scope, job.id, lease.token), code('LEASE_LOST'));
    const b = reopened.claimLease(scope, job.id); reopened.propose(scope, job.id, b.token, claim);
    assert.throws(() => store.publish(scope, job.id, lease.token), code('LEASE_LOST'));
    reopened.publish(scope, job.id, b.token);
  } finally { reopened.close(); }
});

test('source correction invalidates frozen job and old memory, allows new revision', t => {
  const { store, scope } = fixture(t);
  const event = store.acceptEvent(scope, input()); const old = publish(store, scope, [event]);
  const job = store.beginJob(scope, [event]); const lease = store.claimLease(scope, job.id);
  const updated = store.reviseEvent(scope, event, input('first','我喜欢绿色').evidence);
  assert.equal(store.read(scope, old), null);
  assert.throws(() => store.publish(scope, job.id, lease.token), code('JOB_NOT_PENDING'));
  assert.throws(() => store.beginJob(scope, [event]), code('STALE_SOURCE'));
  publish(store, scope, [updated], { ...claim, statement:'我喜欢绿色' });
  assert.equal(store.search(scope, '绿色').length, 1);
});

test('assistant and quoted third-party statements cannot masquerade as subject self-report', t => {
  const { store, scope } = fixture(t);
  for (const speakerRole of ['assistant','third_party'] as const) {
    const source = store.acceptEvent(scope, { source:'synthetic', eventKey:speakerRole, evidence:{
      speakerId:'someone-else', speakerRole, mode:'quotation', selectedText:'我喜欢蓝色', occurredAt:null
    } });
    const job = store.beginJob(scope, [source]); const lease = store.claimLease(scope, job.id);
    assert.throws(() => store.propose(scope, job.id, lease.token, claim), code('SPEAKER_MISMATCH'));
    store.propose(scope, job.id, lease.token, { kind:'belief', statement:'可能偏好蓝色，未确认', basis:'inference', validFrom:null, validTo:1_000_010 });
    store.publish(scope, job.id, lease.token);
  }
  assert.throws(() => store.acceptEvent(scope, { ...input('wrong'), evidence:{ ...input().evidence, speakerId:'bob' } }), code('SPEAKER_MISMATCH'));
});

test('scope separation applies to source, query, job and artifact boundaries', t => {
  const { store, scope } = fixture(t);
  const other = store.ensureScope({ ...who, tenantId:'other' });
  const event = store.acceptEvent(scope, input()); const memory = publish(store, scope, [event]);
  assert.equal(store.read(other, memory), null);
  assert.deepEqual(store.search(other, '蓝色'), []);
  assert.throws(() => store.beginJob(other, [event]), code('SOURCE_NOT_FOUND'));
  const job = store.beginJob(scope, [event]);
  assert.throws(() => store.claimLease(other, job.id), code('JOB_NOT_FOUND'));
});

test('diamond DAG revocation invalidates transitive children and projection while independent branch survives', t => {
  const { store, scope } = fixture(t);
  const e1 = store.acceptEvent(scope, input()); const e2 = store.acceptEvent(scope, input('second','我喜欢绿色'));
  const m1 = publish(store, scope, [e1]); const m2 = publish(store, scope, [e2], { ...claim, statement:'我喜欢绿色' });
  const m3 = publish(store, scope, [m1,m2], { ...claim, statement:'我喜欢蓝色和绿色' });
  const cached = store.read(scope, m3)!;
  assert.equal(store.projectionBatch(scope).length, 3);
  store.revoke(scope, e1);
  assert.equal(store.read(scope, cached), null);
  assert.equal(store.read(scope, m1), null);
  assert.notEqual(store.read(scope, m2), null);
  assert.deepEqual(store.projectionBatch(scope).filter(item => item.operation === 'upsert').map(item => item.record.id), [m2.id]);
  assert.equal(store.projectionBatch(scope).filter(item => item.operation === 'remove').length, 2);
});

test('commit retry returns one receipt and one outbox; revoked receipt never says active', t => {
  const { store, scope } = fixture(t);
  const event = store.acceptEvent(scope, input()); const job = store.beginJob(scope, [event]);
  const lease = store.claimLease(scope, job.id); store.propose(scope, job.id, lease.token, claim);
  const receipt = store.publish(scope, job.id, lease.token);
  assert.deepEqual(store.publish(scope, job.id, lease.token), receipt);
  assert.equal(store.projectionBatch(scope).length, 1);
  store.revoke(scope, event);
  assert.deepEqual(store.publish(scope, job.id, lease.token), { id:receipt.id, currentStatus:'revoked' });
});

test('SQLite fault at outbox insertion rolls back memory, FTS and job receipt; retry after repair succeeds', t => {
  const { store, scope, path } = fixture(t);
  const event = store.acceptEvent(scope, input()); const job = store.beginJob(scope, [event]);
  const lease = store.claimLease(scope, job.id); store.propose(scope, job.id, lease.token, claim);
  const injector = new DatabaseSync(path);
  try {
    injector.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected disk boundary'); END;");
    assert.throws(() => store.publish(scope, job.id, lease.token), /injected disk boundary/);
    assert.deepEqual(store.search(scope, '蓝色'), []);
    assert.deepEqual(store.projectionBatch(scope), []);
    assert.equal(injector.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type='memory'").get()!.n, 0);
    injector.exec('DROP TRIGGER fail_outbox');
    store.publish(scope, job.id, lease.token);
    assert.equal(store.search(scope, '蓝色').length, 1);
  } finally { injector.close(); }
});

test('expired status is excluded before limit and old memories are not cut off by 500 newer events', t => {
  const { store, scope, advance } = fixture(t);
  const event = store.acceptEvent(scope, input());
  publish(store, scope, [event], { ...claim, kind:'status', validTo:1_000_001 });
  const enduring = publish(store, scope, [event]);
  advance(1);
  for (let n = 0; n < 510; n++) store.acceptEvent(scope, input(`noise-${n}`, `noise ${n}`));
  assert.equal(store.search(scope, '蓝色', 1)[0]!.id, enduring.id);
  assert.throws(() => publish(store, scope, [event], { ...claim, kind:'belief', basis:'inference' }), code('TTL_REQUIRED'));
});

test('inference result returning after purge is rejected by actual async pipeline', async t => {
  const { store, scope } = fixture(t); const event = store.acceptEvent(scope, input());
  let resolve!: (value: Proposal) => void;
  const waiting = new Promise<Proposal>(done => { resolve = done; });
  const provider: InferenceAdapter = {
    capabilities:{ providerId:'test', modelVersion:'deferred', input:['text'], structuredOutput:'best_effort', cancellation:'local_drop_only' },
    async proposeMemory() { return waiting; }
  };
  const result = extractMemory(store, scope, [event], provider);
  const rejection = assert.rejects(result, code('STALE_SCOPE'));
  const next = store.purge(scope); resolve(claim); await rejection;
  assert.deepEqual(store.search(next, '蓝色'), []);
});

test('abort does not publish even when provider ignores cancellation', async t => {
  const { store, scope } = fixture(t); const event = store.acceptEvent(scope, input());
  const controller = new AbortController();
  const provider: InferenceAdapter = {
    capabilities:{ providerId:'test', modelVersion:'cancel', input:['text'], structuredOutput:'best_effort', cancellation:'local_drop_only' },
    async proposeMemory() { controller.abort(); return claim; }
  };
  await assert.rejects(extractMemory(store, scope, [event], provider, controller.signal), { name:'AbortError' });
  assert.deepEqual(store.search(scope, '蓝色'), []);
});

test('training consent ABA invalidates prior jobs; parent-checkpoint lineage follows descendants', t => {
  const { store, scope:original } = fixture(t);
  let scope = store.setLearningConsent(original, true);
  const e1 = store.acceptEvent(scope, input()); const e2 = store.acceptEvent(scope, input('second','green'));
  const first = store.beginJob(scope, [e1], 'training'); const firstLease = store.claimLease(scope, first.id);
  const artifact = store.registerArtifact(scope, first.id, firstLease.token, { sha256:'a'.repeat(64), implementation:'synthetic-only' });
  const run = store.activateArtifact(scope, artifact.id); store.validateRun(run);
  const child = store.beginJob(scope, [e2], 'training', artifact.id);
  assert.equal(child.sourceRefs.length, 2);
  const childLease = store.claimLease(scope, child.id);
  store.revoke(scope, e1);
  assert.throws(() => store.registerArtifact(scope, child.id, childLease.token, { sha256:'b'.repeat(64), implementation:'synthetic-only' }), code('JOB_NOT_PENDING'));
  assert.throws(() => store.validateRun(run), code('STALE_RUN'));
  assert.throws(() => store.activateArtifact(scope, artifact.id), code('ARTIFACT_REVOKED'));
  const clean = store.beginJob(scope, [e2], 'training'); const cleanLease = store.claimLease(scope, clean.id);
  const staleScope = scope;
  scope = store.setLearningConsent(scope, false); scope = store.setLearningConsent(scope, true);
  assert.throws(() => store.registerArtifact(staleScope, clean.id, cleanLease.token, { sha256:'c'.repeat(64), implementation:'synthetic-only' }), code('STALE_CONSENT'));
  assert.throws(() => store.registerArtifact(scope, clean.id, cleanLease.token, { sha256:'c'.repeat(64), implementation:'synthetic-only' }), code('STALE_CONSENT'));
});

test('registered child artifact and runtime output fence survive database reopen', t => {
  const { store, scope:original, path } = fixture(t);
  const scope = store.setLearningConsent(original, true); const source = store.acceptEvent(scope, input());
  const job = store.beginJob(scope, [source], 'training'); const lease = store.claimLease(scope, job.id);
  const artifact = store.registerArtifact(scope, job.id, lease.token, { sha256:'a'.repeat(64), implementation:'fixture' });
  const ticket = store.beginRun(scope);
  store.validateRun(ticket); store.revoke(scope, source);
  assert.throws(() => store.validateRun(ticket), code('STALE_RUN'));
  const reopened = new MemoryStore(path);
  try { assert.throws(() => reopened.activateArtifact(scope, artifact.id), code('ARTIFACT_REVOKED')); }
  finally { reopened.close(); }
});

test('newer or unknown database schemas fail closed without resetting user_version', t => {
  const path = join(mkdtempSync(join(tmpdir(), 'companion-core-schema-')), 'future.sqlite');
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new MemoryStore(path), code('UNSUPPORTED_SCHEMA'));
  const recheck = new DatabaseSync(path);
  try { assert.equal(recheck.prepare('PRAGMA user_version').get()!.user_version, 99); }
  finally { recheck.close(); }
});

test('expired ancestor cannot be laundered into enduring claim but historical retrieval remains possible', t => {
  const { store, scope, advance } = fixture(t); const event = store.acceptEvent(scope, input());
  const status = publish(store, scope, [event], { ...claim, kind:'status', validTo:1_000_010 });
  const derived = publish(store, scope, [status]);
  const job = store.beginJob(scope, [status]); const lease = store.claimLease(scope, job.id);
  store.propose(scope, job.id, lease.token, claim); advance(10);
  assert.equal(store.read(scope, derived), null);
  assert.notEqual(store.read(scope, derived, 1_000_005), null);
  assert.throws(() => store.publish(scope, job.id, lease.token), code('STALE_SOURCE'));
});

test('derived inference cannot be promoted into self-report through an innocent source', t => {
  const { store, scope } = fixture(t); const event = store.acceptEvent(scope, input());
  const inference = publish(store, scope, [event], { kind:'belief', statement:'可能喜欢绿色', basis:'inference', validFrom:null, validTo:1_000_010 });
  assert.throws(() => publish(store, scope, [inference]), code('SPEAKER_MISMATCH'));
});

test('projection queue progresses past 100 expired items and rejects late upsert acknowledgement', t => {
  const { store, scope, advance } = fixture(t); const event = store.acceptEvent(scope, input());
  for (let n = 0; n < 101; n++) publish(store, scope, [event], { ...claim, kind:'status', validTo:1_000_001 });
  const enduring = publish(store, scope, [event]);
  const stale = store.projectionBatch(scope)[0]!; advance(1);
  assert.throws(() => store.acknowledgeProjection(scope, stale), code('STALE_PROJECTION'));
  const first = store.projectionBatch(scope); assert.equal(first.length, 100);
  for (const change of first) store.acknowledgeProjection(scope, change);
  const second = store.projectionBatch(scope);
  assert.equal(second.length, 2);
  const total = [...first,...second];
  assert.equal(total.filter(c => c.operation === 'remove').length, 101);
  assert.deepEqual(total.filter(c => c.operation === 'upsert').map(c => c.record.id), [enduring.id]);
  for (const change of second) { store.acknowledgeProjection(scope, change); store.acknowledgeProjection(scope, change); }
  assert.deepEqual(store.projectionBatch(scope), []);
});

test('artifact register and activation retries are idempotent; different manifest conflicts', t => {
  const { store, scope:original } = fixture(t); const scope = store.setLearningConsent(original, true);
  const source = store.acceptEvent(scope, input()); const job = store.beginJob(scope, [source], 'training');
  const lease = store.claimLease(scope, job.id); const manifest = { sha256:'a'.repeat(64), implementation:'fixture' };
  const artifact = store.registerArtifact(scope, job.id, lease.token, manifest);
  assert.deepEqual(store.registerArtifact(scope, job.id, lease.token, manifest), artifact);
  assert.throws(() => store.registerArtifact(scope, job.id, lease.token, { ...manifest, sha256:'b'.repeat(64) }), code('IDEMPOTENCY_CONFLICT'));
  const run = store.activateArtifact(scope, artifact.id);
  assert.deepEqual(store.activateArtifact(scope, artifact.id), run); store.validateRun(run);
  assert.throws(() => store.publish(scope, job.id, lease.token), code('WRONG_JOB_KIND'));
});

test('unknown table, view-only, forged version and modified schema databases are not adopted', () => {
  for (const setup of ['CREATE TABLE other (x TEXT)', 'CREATE VIEW other AS SELECT 1', 'PRAGMA user_version=1']) {
    const path = join(mkdtempSync(join(tmpdir(), 'companion-core-unknown-')), 'unknown.sqlite');
    const foreign = new DatabaseSync(path); foreign.exec(setup);
    const before = foreign.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(); foreign.close();
    assert.throws(() => new MemoryStore(path), code('UNKNOWN_DATABASE'));
    const after = new DatabaseSync(path);
    try {
      assert.deepEqual(after.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before);
      assert.equal(after.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
    } finally { after.close(); }
  }
  const path = join(mkdtempSync(join(tmpdir(), 'companion-core-layout-')), 'changed.sqlite');
  new MemoryStore(path).close();
  const edited = new DatabaseSync(path); edited.exec('ALTER TABLE nodes ADD COLUMN accidental TEXT'); edited.close();
  assert.throws(() => new MemoryStore(path), code('SCHEMA_MISMATCH'));
});

test('belief cannot claim observation as its basis and malformed adapter output fails with stable code', t => {
  const { store, scope } = fixture(t); const source = store.acceptEvent(scope, input());
  assert.throws(() => publish(store, scope, [source], { ...claim, kind:'belief', basis:'observation', validTo:1_000_010 }), code('BELIEF_REQUIRES_INFERENCE'));
  assert.throws(() => publish(store, scope, [source], null as unknown as Proposal), code('INVALID_INPUT'));
  assert.throws(() => store.acceptEvent(scope, null as unknown as EventInput), code('INVALID_INPUT'));
});

test('projection consumer observes future activation and expiry after earlier deltas were acknowledged', t => {
  const { store, scope, advance } = fixture(t); const source = store.acceptEvent(scope, input());
  const future = publish(store, scope, [source], { ...claim, validFrom:1_000_010 });
  const temporary = publish(store, scope, [source], { ...claim, kind:'status', validTo:1_000_010 });
  const dependent = publish(store, scope, [temporary]);
  for (const change of store.projectionBatch(scope)) store.acknowledgeProjection(scope, change);
  assert.deepEqual(store.projectionBatch(scope), []); advance(10);
  const changes = store.projectionBatch(scope);
  assert.equal(changes.find(c => c.operation === 'upsert' && c.record.id === future.id)?.operation, 'upsert');
  for (const ref of [temporary,dependent]) assert.equal(changes.find(c => c.operation === 'remove' && c.ref.id === ref.id)?.operation, 'remove');
  for (const change of changes) store.acknowledgeProjection(scope, change);
  assert.deepEqual(store.projectionBatch(scope), []);
});

test('revocation removes selected text from active rows and FTS5 shadow segments', t => {
  const { store, scope, path } = fixture(t); const marker = 'unrepeatablequartzsecret';
  const source = store.acceptEvent(scope, input('secret',marker));
  publish(store, scope, [source], { ...claim, statement:marker }); store.revoke(scope, source);
  const inspect = new DatabaseSync(path, { readOnly:true });
  try {
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM nodes WHERE body LIKE ?').get(`%${marker}%`)!.n, 0);
    for (const row of inspect.prepare('SELECT block FROM memory_fts_data').all()) {
      if (row.block instanceof Uint8Array) assert.equal(Buffer.from(row.block).includes(Buffer.from(marker)), false);
    }
    assert.equal(store.search(scope, marker).length, 0);
  } finally { inspect.close(); }
});
