import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { CoreError } from '../src/validation.ts';
import type { Epoch, Proposal, SourceRef } from '../src/contracts.ts';
import { CURATION_LIMITS } from '../src/curation-types.ts';

const identity = { tenantId:'synthetic', subjectId:'alice', personaId:'test', relationshipId:'test' };
const claim: Proposal = { kind:'claim', statement:'derived summary', basis:'self_report', validFrom:null, validTo:null };
const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
function fixture(t: TestContext) {
  let wall = 100_000, reads = 0, persisted = 0;
  const store = new MemoryStore(':memory:', { clock:{ wall:() => { reads++; return wall; }, monotonic:() => 0 }, persist:() => { persisted++; } });
  t.after(() => store.close());
  const scope = store.setLearningConsent(store.ensureScope(identity), true);
  const event = (key: string, text = '原文 original 原文', occurredAt: number | null = 1000) => store.acceptEvent(scope, {
    source:'synthetic', eventKey:key, evidence:{ speakerId:'alice', speakerRole:'subject', mode:'self_report', selectedText:text, occurredAt }
  });
  return { store, scope, event, reads:() => reads, persisted:() => persisted, advance:(ms: number) => { wall += ms; } };
}
function publish(store: MemoryStore, epoch: Epoch, refs: SourceRef[], proposal = claim): SourceRef {
  const job = store.beginJob(epoch, refs), lease = store.claimLease(epoch, job.id);
  store.propose(epoch, job.id, lease.token, proposal);
  return { id:store.publish(epoch, job.id, lease.token).id, revision:1 };
}

test('curation snapshot is read-only, captures one asOf and separates original evidence from derived memory', t => {
  const f = fixture(t), root = f.event('one'), memory = publish(f.store, f.scope, [root]);
  const before = f.store.snapshot(), reads = f.reads(), persisted = f.persisted();
  const snapshot = f.store.curationSnapshot(f.scope, [memory]);
  assert.equal(snapshot.asOf, 100_000); assert.equal(f.reads(), reads + 1);
  assert.equal(snapshot.selected[0]!.memory.statement, 'derived summary');
  assert.equal(snapshot.events[0]!.evidence.selectedText, '原文 original 原文');
  assert.deepEqual(snapshot.selected[0]!.rootEventRefs, [{ id:root.id, revision:1 }]);
  assert.deepEqual(f.store.snapshot(), before); assert.equal(f.persisted(), persisted);
  assert.ok(Object.isFrozen(snapshot.events[0]!.evidence)); assert.ok(Object.isFrozen(snapshot.selected[0]!.rootEventRefs));
});

test('empty curation snapshots still enforce consent and epoch, including empty-scope purge', t => {
  const f = fixture(t), empty = f.store.curationSnapshot(f.scope, []);
  assert.equal(empty.counts.nodes, 0);
  const next = f.store.purge(f.scope);
  assert.throws(() => f.store.curationSnapshot(f.scope, []), code('STALE_SCOPE'));
  const off = f.store.setLearningConsent(next, false);
  assert.throws(() => f.store.curationSnapshot(off, []), code('LEARNING_NOT_ALLOWED'));
});

test('curation rejects raw event refs and pending jobs rather than treating them as published memories', t => {
  const f = fixture(t), root = f.event('one'), job = f.store.beginJob(f.scope, [root]);
  assert.throws(() => f.store.curationSnapshot(f.scope, [root]), code('SOURCE_NOT_PUBLISHED'));
  assert.throws(() => f.store.curationSnapshot(f.scope, [{ id:job.id, revision:1 }]), code('SOURCE_NOT_FOUND'));
});

test('a legal diamond shares roots without becoming a cycle', t => {
  const f = fixture(t), root = f.event('one'), a = publish(f.store, f.scope, [root]), b = publish(f.store, f.scope, [root]);
  const top = publish(f.store, f.scope, [a, b]);
  const snapshot = f.store.curationSnapshot(f.scope, [top, a]);
  assert.equal(snapshot.counts.nodes, 4); assert.equal(snapshot.counts.edges, 4); assert.equal(snapshot.events.length, 1);
  assert.deepEqual(snapshot.selected.map(item => item.rootEventRefs), [[{ id:root.id, revision:1 }], [{ id:root.id, revision:1 }]]);
});

test('32 selected refs pass, 33 reject before body reads; a mixed valid/invalid selection returns no partial result', t => {
  const f = fixture(t), event = f.event('root'), refs = Array.from({ length:33 }, () => publish(f.store, f.scope, [event]));
  assert.equal(f.store.curationSnapshot(f.scope, refs.slice(0,32)).selected.length, 32);
  const prepare = DatabaseSync.prototype.prepare; let bodyReads = 0;
  try {
    DatabaseSync.prototype.prepare = function(sql) { if (sql.startsWith('SELECT body FROM nodes')) bodyReads++; return prepare.call(this, sql); };
    assert.throws(() => f.store.curationSnapshot(f.scope, refs), code('CURATION_LIMIT'));
    assert.equal(bodyReads, 0);
    assert.throws(() => f.store.curationSnapshot(f.scope, [refs[0]!, { id:'missing', revision:1 }]), code('SOURCE_NOT_FOUND'));
  } finally { DatabaseSync.prototype.prepare = prepare; }
});

test('current consent admits still-legal older node consent revisions, but old scope authority stays stale', t => {
  const store = new MemoryStore(':memory:'); t.after(() => store.close());
  const old = store.ensureScope(identity);
  const root = store.acceptEvent(old, { source:'synthetic', eventKey:'old-consent', evidence:{ speakerId:'alice', speakerRole:'subject',
    mode:'self_report', selectedText:'original', occurredAt:1000 } });
  const memory = publish(store, old, [root]), current = store.setLearningConsent(old, true);
  const result = store.curationSnapshot(current, [memory]);
  assert.equal(result.authority.consentRevision, 1); assert.equal(result.selected[0]!.memory.consentRevision, 0);
  assert.throws(() => store.curationSnapshot(old, [memory]), code('STALE_CONSENT'));
});

test('foreign scope, future memory and exact exclusive TTL are rejected', t => {
  const f = fixture(t), root = f.event('root'), memory = publish(f.store, f.scope, [root]);
  const other = f.store.setLearningConsent(f.store.ensureScope({ ...identity, tenantId:'other' }), true);
  assert.throws(() => f.store.curationSnapshot(other, [memory]), code('SOURCE_NOT_FOUND'));
  const future = publish(f.store, f.scope, [root], { ...claim, validFrom:100_001 });
  assert.throws(() => f.store.curationSnapshot(f.scope, [future]), code('STALE_SOURCE'));
  const expiring = publish(f.store, f.scope, [root], { ...claim, validTo:100_010 });
  assert.equal(f.store.curationSnapshot(f.scope, [expiring]).selected.length, 1);
  f.advance(10); assert.throws(() => f.store.curationSnapshot(f.scope, [expiring]), code('STALE_SOURCE'));
});

test('snapshot copies do not freeze caller refs and every returned nested object is immutable', t => {
  const f = fixture(t), root = f.event('root'), memory = publish(f.store, f.scope, [root]), refs = [{ ...memory }];
  const snapshot = f.store.curationSnapshot(f.scope, refs);
  assert.equal(Reflect.set(snapshot.events[0]!.evidence, 'selectedText', 'changed'), false);
  assert.equal(Reflect.set(snapshot.selected[0]!.memory.sourceRefs[0]!, 'revision', 900), false);
  refs[0]!.revision = 9; assert.equal(snapshot.selected[0]!.memory.revision, 1); assert.equal(Object.isFrozen(refs[0]), false);
  assert.equal(f.store.curationSnapshot(f.scope, [memory]).events[0]!.evidence.selectedText, '原文 original 原文');
});

test('an empty snapshot still checks a poisoned persistent store', () => {
  let broken = false;
  const store = new MemoryStore(':memory:', { persist:() => { if (broken) throw Error('synthetic failure'); } });
  try {
    const scope = store.setLearningConsent(store.ensureScope(identity), true); broken = true;
    assert.throws(() => store.ensureScope({ ...identity, tenantId:'new' }), /synthetic failure/);
    assert.throws(() => store.curationSnapshot(scope, []), code('DURABLE_UNAVAILABLE'));
  } finally { store.close(); }
});

/** Deliberately malformed DAGs live only in a new synthetic temporary database.
 * The second connection is a fault injector; curation itself remains read-only. */
function graph(t:TestContext) {
  const path = join(mkdtempSync(join(tmpdir(), 'curation-graph-')), 'synthetic.sqlite');
  const store = new MemoryStore(path, { clock:{ wall:() => 100_000, monotonic:() => 0 } });
  const scope = store.setLearningConsent(store.ensureScope(identity), true);
  const injector = new DatabaseSync(path, { enableForeignKeyConstraints:false });
  t.after(() => { injector.close(); store.close(); });
  const ref = (id:string):SourceRef => ({ id, revision:1 });
  const node = (id:string, type:'event'|'memory', parents:string[] = [], text = 'synthetic') => {
    const body = type === 'event' ? { speakerId:'alice', speakerRole:'subject', mode:'self_report', selectedText:text, occurredAt:1000 } : { ...claim, statement:text };
    injector.prepare(`INSERT INTO nodes(id,scope_id,type,revision,generation,consent_revision,status,body,created_at) VALUES (?,?,?,1,?,?,'active',?,100000)`)
      .run(id, scope.id, type, scope.generation, scope.consentRevision, JSON.stringify(body));
    for (const parent of parents) injector.prepare('INSERT INTO dependencies VALUES (?,?,1)').run(id, parent);
    return ref(id);
  };
  return { store, scope, injector, ref, node };
}

for (const count of [128,129]) test(`closure ${count} nodes uses a bounded nonrecursive SQL path`, t => {
  const f = graph(t); f.node('n0','event');
  for (let i = 1; i < count; i++) f.node('n'+i, 'memory', ['n'+(i-1)]);
  const before = f.store.snapshot(), prepare = DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare = function(sql) { assert.doesNotMatch(sql, /WITH RECURSIVE/); return prepare.call(this, sql); };
    if (count === 128) assert.equal(f.store.curationSnapshot(f.scope, [f.ref('n127')]).counts.nodes, 128);
    else assert.throws(() => f.store.curationSnapshot(f.scope, [f.ref('n128')]), code('CURATION_LIMIT'));
  } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.deepEqual(f.store.snapshot(), before);
});

for (const extra of [false,true]) test(`closure ${extra ? 513 : 512} edges counts real diamond edges and bounds each query`, t => {
  const f = graph(t);
  for (let i = 0; i < 17; i++) f.node('r'+i,'event');
  const refs = Array.from({ length:32 }, (_,i) => f.node('m'+i,'memory', Array.from({ length:16 + Number(extra && i === 31) }, (_,j) => 'r'+j)));
  const prepare = DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql.includes('FROM dependencies WHERE child_id=')) assert.match(sql, /LIMIT \?/);
      return prepare.call(this,sql);
    };
    if (extra) assert.throws(() => f.store.curationSnapshot(f.scope, refs), code('CURATION_LIMIT'));
    else { const snapshot = f.store.curationSnapshot(f.scope, refs); assert.equal(snapshot.counts.edges, 512); assert.equal(snapshot.counts.nodes, 48); }
  } finally { DatabaseSync.prototype.prepare = prepare; }
});

for (const kind of ['cycle','self','missing','revision-conflict','stale-edge','no-root','event-parent'] as const) {
  test(`curation fails closed on synthetic graph ${kind}`, t => {
    const f = graph(t); let selected:SourceRef, expected:string;
    if (kind === 'cycle') { f.node('a','memory',['b']); selected=f.node('b','memory',['a']); expected='CURATION_CYCLE'; }
    else if (kind === 'self') { selected=f.node('a','memory',['a']); expected='CURATION_CYCLE'; }
    else if (kind === 'missing') { selected=f.node('a','memory',['missing']); expected='SOURCE_NOT_FOUND'; }
    else if (kind === 'no-root') { selected=f.node('a','memory'); expected='EVENT_PROVENANCE_REQUIRED'; }
    else if (kind === 'event-parent') { f.node('root','event'); f.node('event','event',['root']); selected=f.node('a','memory',['event']); expected='CURATION_GRAPH_INVALID'; }
    else {
      f.node('root','event'); f.node('a','memory',['root']); f.node('b','memory',['root']);
      f.injector.prepare('UPDATE dependencies SET parent_revision=2 WHERE child_id=?').run(kind === 'stale-edge' ? 'a' : 'b');
      selected = kind === 'stale-edge' ? f.ref('a') : f.node('top','memory',['a','b']);
      expected = kind === 'stale-edge' ? 'STALE_SOURCE' : 'CURATION_VERSION_CONFLICT';
    }
    const before=f.store.snapshot(); assert.throws(() => f.store.curationSnapshot(f.scope,[selected]),code(expected));
    assert.deepEqual(f.store.snapshot(),before);
  });
}

test('an oversized UTF-8 body is rejected before it is materialized', t => {
  const f=graph(t); f.node('huge','event',[], '界'.repeat(100_000)); const memory=f.node('top','memory',['huge']);
  const prepare=DatabaseSync.prototype.prepare; let bodyReads=0;
  try {
    DatabaseSync.prototype.prepare=function(sql) { if (sql.startsWith('SELECT body FROM nodes')) bodyReads++; return prepare.call(this,sql); };
    assert.throws(() => f.store.curationSnapshot(f.scope,[memory]),code('CURATION_LIMIT')); assert.equal(bodyReads,1);
  } finally { DatabaseSync.prototype.prepare=prepare; }
});

test('the 262144-byte budget includes metadata, UTF-8 bodies and repeated output mappings; one more byte fails', t => {
  const f=graph(t), roots=Array.from({length:32},(_,i)=>'r'+i);
  for(const id of roots) f.node(id,'event',[],'界'+'a'.repeat(2500));
  const selected=f.node('top','memory',roots), start=f.store.curationSnapshot(f.scope,[selected]);
  assert.ok(start.counts.bytes >= Buffer.byteLength(JSON.stringify(start)));
  let remaining=CURATION_LIMITS.bytes-start.counts.bytes;
  const update=f.injector.prepare('UPDATE nodes SET body=? WHERE id=?');
  for(const id of roots) {
    const body=JSON.parse(f.injector.prepare('SELECT body FROM nodes WHERE id=?').get(id)!.body as string);
    const add=Math.min(4096-body.selectedText.length,Math.floor(remaining/2));
    body.selectedText+='a'.repeat(add); remaining-=add*2; update.run(JSON.stringify(body),id);
  }
  assert.ok(remaining<=1);
  if(remaining) f.injector.prepare("UPDATE nodes SET body=' '||body WHERE id='r0'").run();
  const exact=f.store.curationSnapshot(f.scope,[selected]); assert.equal(exact.counts.bytes,262144);
  f.injector.prepare("UPDATE nodes SET body=' '||body WHERE id='r0'").run();
  assert.throws(()=>f.store.curationSnapshot(f.scope,[selected]),code('CURATION_LIMIT'));
});
