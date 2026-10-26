import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { RETRIEVAL_LIMITS } from '../src/retrieval-types.ts';
import { fixture, graph, code, identity, claim } from './retrieval-fixtures.ts';

test('ordinary retrieval works with learning off, returns memory only and performs one read-only current snapshot',t=>{
  const f=fixture(t),root=f.event('one'),memory=f.memory([root]);
  assert.equal(f.scope.learningAllowed,false);
  assert.throws(()=>f.store.curationSnapshot(f.scope,[memory]),code('LEARNING_NOT_ALLOWED'));
  const before=f.store.snapshot(),persisted=f.persisted(),reads=f.reads();
  const snapshot=f.store.retrievalSnapshot(f.scope,[memory]);
  assert.equal(f.reads(),reads+1);assert.equal(snapshot.asOf,100_000);
  assert.equal(snapshot.selected[0]!.memory.statement,'derived blue memory');
  assert.deepEqual(snapshot.selected[0]!.rootEventRefs,[{id:root.id,revision:1}]);
  assert.doesNotMatch(JSON.stringify(snapshot),/ANCESTOR_ONLY|selectedText|occurredAt|learningAllowed/);
  assert.deepEqual(f.store.snapshot(),before);assert.equal(f.persisted(),persisted);
  assert.ok(Object.isFrozen(snapshot.selected[0]!.memory.sourceRefs[0]));
});

test('empty retrieval still validates current authority and wall clock',t=>{
  const f=fixture(t);assert.equal(f.store.retrievalSnapshot(f.scope,[]).counts.selected,0);
  f.store.purge(f.scope);assert.throws(()=>f.store.retrievalSnapshot(f.scope,[]),code('STALE_SCOPE'));
});

test('current retrieval accepts unknown/future event occurrence but refuses future memory applicability',t=>{
  const f=fixture(t),a=f.memory([f.event('unknown',{occurredAt:null})]),b=f.memory([f.event('future',{occurredAt:999_999})]);
  assert.equal(f.store.retrievalSnapshot(f.scope,[a,b]).selected.length,2);
  const future=f.memory([f.event('future-validity')],{kind:'claim',statement:'future blue',basis:'self_report',validFrom:100_001,validTo:null});
  assert.throws(()=>f.store.retrievalSnapshot(f.scope,[future]),code('STALE_SOURCE'));
});

test('raw events, pending work, foreign scopes and a mixed selection cannot produce a partial snapshot',t=>{
  const f=fixture(t),root=f.event('one'),memory=f.memory([root]),job=f.store.beginJob(f.scope,[root]);
  const other=f.store.ensureScope({...identity,tenantId:'other'}),before=f.store.snapshot(),persisted=f.persisted();
  for(const [epoch,selected,expected] of [[f.scope,[root],'SOURCE_NOT_PUBLISHED'],[f.scope,[{id:job.id,revision:1}],'SOURCE_NOT_FOUND'],
    [other,[memory],'SOURCE_NOT_FOUND'],[f.scope,[memory,{id:'missing',revision:1}],'SOURCE_NOT_FOUND']] as const)
    assert.throws(()=>f.store.retrievalSnapshot(epoch,[...selected]),code(expected));
  assert.deepEqual(f.store.snapshot(),before);assert.equal(f.persisted(),persisted);
});

test('exact exclusive TTL, source revision and consent changes use current authority',t=>{
  const f=fixture(t),root=f.event('one'),memory=f.memory([root],{...claim,validTo:100_010});
  assert.equal(f.store.retrievalSnapshot(f.scope,[memory]).selected.length,1);
  f.setWall(100_010);assert.throws(()=>f.store.retrievalSnapshot(f.scope,[memory]),code('STALE_SOURCE'));
  f.setWall(100_000);const on=f.store.setLearningConsent(f.scope,true),off=f.store.setLearningConsent(on,false);
  assert.throws(()=>f.store.retrievalSnapshot(f.scope,[]),code('STALE_CONSENT'));
  assert.equal(f.store.retrievalSnapshot(off,[memory]).selected.length,1);
  f.store.reviseEvent(off,root,{speakerId:'alice',speakerRole:'subject',mode:'self_report',selectedText:'new original',occurredAt:null});
  assert.throws(()=>f.store.retrievalSnapshot(off,[memory]),code('STALE_SOURCE'));
});

test('32 selected pass; 33 reject before body fetch; input and frozen outputs are detached',t=>{
  const f=fixture(t),root=f.event('one'),selected=Array.from({length:33},()=>f.memory([root]));
  const refs=selected.slice(0,32).map(ref=>({...ref})),snapshot=f.store.retrievalSnapshot(f.scope,refs);
  assert.equal(snapshot.counts.selected,32);refs[0]!.revision=9;assert.equal(snapshot.selected[0]!.memory.revision,1);
  assert.equal(Reflect.set(snapshot.selected[0]!.memory,'statement','forged'),false);
  const prepare=DatabaseSync.prototype.prepare;let bodyReads=0;
  try {
    DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('SELECT body FROM nodes'))bodyReads++;return prepare.call(this,sql);};
    assert.throws(()=>f.store.retrievalSnapshot(f.scope,selected),code('RETRIEVAL_LIMIT'));assert.equal(bodyReads,0);
  } finally {DatabaseSync.prototype.prepare=prepare;}
});

for(const count of [128,129])test(`retrieval closure ${count} nodes is bounded without recursive SQL`,t=>{
  const f=graph(t);f.node('n0','event');for(let i=1;i<count;i++)f.node('n'+i,'memory',['n'+(i-1)]);
  const before=f.store.snapshot(),prepare=DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare=function(sql){assert.doesNotMatch(sql,/WITH RECURSIVE/);return prepare.call(this,sql);};
    if(count===128)assert.equal(f.store.retrievalSnapshot(f.scope,[f.ref('n127')]).counts.nodes,128);
    else assert.throws(()=>f.store.retrievalSnapshot(f.scope,[f.ref('n128')]),code('RETRIEVAL_LIMIT'));
  } finally {DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(f.store.snapshot(),before);
});

for(const extra of [false,true])test(`retrieval closure ${extra?513:512} edges is independently bounded`,t=>{
  const f=graph(t);for(let i=0;i<17;i++)f.node('r'+i,'event');
  const selected=Array.from({length:32},(_,i)=>f.node('m'+i,'memory',Array.from({length:16+Number(extra&&i===31)},(_,j)=>'r'+j)));
  const before=f.store.snapshot(),prepare=DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare=function(sql){if(sql.includes('FROM dependencies WHERE child_id='))assert.match(sql,/LIMIT \?/);return prepare.call(this,sql);};
    if(extra)assert.throws(()=>f.store.retrievalSnapshot(f.scope,selected),code('RETRIEVAL_LIMIT'));
    else assert.equal(f.store.retrievalSnapshot(f.scope,selected).counts.edges,512);
  } finally {DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(f.store.snapshot(),before);
});

for(const kind of ['cycle','self','missing','revision-conflict','stale-edge','no-root','event-parent','foreign-parent'] as const)
test(`retrieval fails closed on synthetic graph ${kind}`,t=>{
  const f=graph(t);let selected,expected:string;
  if(kind==='cycle'){f.node('a','memory',['b']);selected=f.node('b','memory',['a']);expected='RETRIEVAL_CYCLE';}
  else if(kind==='self'){selected=f.node('a','memory',['a']);expected='RETRIEVAL_CYCLE';}
  else if(kind==='missing'){selected=f.node('a','memory',['missing']);expected='SOURCE_NOT_FOUND';}
  else if(kind==='no-root'){selected=f.node('a','memory');expected='EVENT_PROVENANCE_REQUIRED';}
  else if(kind==='event-parent'){f.node('root','event');f.node('event','event',['root']);selected=f.node('a','memory',['event']);expected='RETRIEVAL_GRAPH_INVALID';}
  else if(kind==='foreign-parent'){
    const other=f.store.ensureScope({...identity,tenantId:'other'});f.node('root','event');selected=f.node('a','memory',['root']);
    f.injector.prepare('UPDATE nodes SET scope_id=? WHERE id=?').run(other.id,'root');expected='SOURCE_NOT_FOUND';
  } else {
    f.node('root','event');f.node('a','memory',['root']);f.node('b','memory',['root']);
    f.injector.prepare('UPDATE dependencies SET parent_revision=2 WHERE child_id=?').run(kind==='stale-edge'?'a':'b');
    selected=kind==='stale-edge'?f.ref('a'):f.node('top','memory',['a','b']);expected=kind==='stale-edge'?'STALE_SOURCE':'RETRIEVAL_VERSION_CONFLICT';
  }
  const before=f.store.snapshot();assert.throws(()=>f.store.retrievalSnapshot(f.scope,[selected]),code(expected));assert.deepEqual(f.store.snapshot(),before);
});

test('a legal diamond deduplicates root identity without exposing ancestor bodies',t=>{
  const f=fixture(t),root=f.event('one'),a=f.memory([root]),b=f.memory([root]),top=f.memory([a,b]);
  const snapshot=f.store.retrievalSnapshot(f.scope,[top,a]);assert.equal(snapshot.counts.nodes,4);assert.equal(snapshot.counts.edges,4);
  assert.deepEqual(snapshot.selected.map(item=>item.rootEventRefs),[[{id:root.id,revision:1}],[{id:root.id,revision:1}]]);
});

test('retrieval charges exactly 262144 UTF-8 bytes and rejects one more before returning anything',t=>{
  const f=graph(t),roots=Array.from({length:32},(_,i)=>'r'+i);for(const id of roots)f.node(id,'event',[],'界'+'a'.repeat(4000));
  const selected=f.node('top','memory',roots),initial=f.store.retrievalSnapshot(f.scope,[selected]);
  assert.ok(initial.counts.bytes>=Buffer.byteLength(JSON.stringify(initial)));
  // Whitespace fault injection grows persisted body bytes without changing the valid parsed Evidence.
  const remaining=RETRIEVAL_LIMITS.bytes-initial.counts.bytes;
  f.injector.prepare("UPDATE nodes SET body=?||body WHERE id='r0'").run(' '.repeat(remaining));
  assert.equal(f.store.retrievalSnapshot(f.scope,[selected]).counts.bytes,RETRIEVAL_LIMITS.bytes);
  f.injector.prepare("UPDATE nodes SET body=' '||body WHERE id='r0'").run();
  assert.throws(()=>f.store.retrievalSnapshot(f.scope,[selected]),code('RETRIEVAL_LIMIT'));
});

test('oversized ancestor body is checked before materialization',t=>{
  const f=graph(t);f.node('huge','event',[],'界'.repeat(100_000));const selected=f.node('top','memory',['huge']);
  const prepare=DatabaseSync.prototype.prepare;let reads=0;
  try {
    DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('SELECT body FROM nodes'))reads++;return prepare.call(this,sql);};
    assert.throws(()=>f.store.retrievalSnapshot(f.scope,[selected]),code('RETRIEVAL_LIMIT'));assert.equal(reads,1);
  } finally {DatabaseSync.prototype.prepare=prepare;}
});

test('empty snapshots reject invalid clocks and poisoned durable state',t=>{
  const f=fixture(t);for(const time of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1]) {
    f.setWall(time);assert.throws(()=>f.store.retrievalSnapshot(f.scope,[]),code('INVALID_INPUT'));
  }
  let broken=false;const store=new MemoryStore(':memory:',{persist:()=>{if(broken)throw Error('synthetic failure');}});t.after(()=>store.close());
  const scope=store.ensureScope(identity);broken=true;assert.throws(()=>store.ensureScope({...identity,tenantId:'new'}),/synthetic failure/);
  assert.throws(()=>store.retrievalSnapshot(scope,[]),code('DURABLE_UNAVAILABLE'));
});
