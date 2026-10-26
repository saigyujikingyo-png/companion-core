import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SceneContract } from '../src/scene.ts';
import { sceneFixture } from '../src/scene-fixtures.ts';
import { fixture, graph, code, identity, claim } from './retrieval-fixtures.ts';

test('scene source snapshots are current, metadata only, read-only and independent of learning consent',t=>{
  const f=fixture(t),root=f.event('one'),memory=f.memory([root]);
  const before=f.store.snapshot(),persisted=f.persisted(),reads=f.reads();
  const snapshot=f.store.sceneSourceSnapshot(f.scope,[memory]);
  assert.equal(f.scope.learningAllowed,false);assert.equal(snapshot.authority.generation,0);
  assert.equal(snapshot.authority.consentRevision,0);assert.equal(snapshot.asOf,100_000);
  assert.equal(f.reads(),reads+1);assert.equal(snapshot.roots[0]!.mode,'self_report');
  assert.deepEqual(snapshot.selected[0]!.rootEventRefs,[{id:root.id,revision:root.revision}]);
  assert.doesNotMatch(JSON.stringify(snapshot),/ANCESTOR|derived blue|selectedText|statement|body|speakerId|alice/);
  assert.deepEqual(f.store.snapshot(),before);assert.equal(f.persisted(),persisted);
  assert.ok(Object.isFrozen(snapshot.roots[0]));
});

test('logical v1 golden bytes were recorded from the unchanged 17d4adc implementation',()=>{
  const f=sceneFixture(),contract=new SceneContract(JSON.stringify(f.catalog));
  const encoded=contract.export(JSON.stringify(f.packet));
  assert.equal(Buffer.byteLength(encoded),6305);
  assert.equal(createHash('sha256').update(encoded).digest('hex'),'06e5304a5f81ccc353a0c774d62d5ea3e6fd397767b60b769db6e706cbff0439');
  assert.equal(contract.export(JSON.stringify(contract.import(encoded).packet)),encoded);
  f.packet.epoch.generation=0;f.catalog.declaredSources[0]!.epoch.generation=0;
  assert.throws(()=>new SceneContract(JSON.stringify(f.catalog)),code('SCENE_INVALID_INPUT'));
});

test('scene v2 explicitly accepts actual epoch zero while default v1 and mixed versions reject',()=>{
  const f=sceneFixture();f.catalog.version=2;f.packet.version=2;
  f.packet.epoch={generation:0,consentRevision:0};f.catalog.declaredSources[0]!.epoch={...f.packet.epoch};
  assert.throws(()=>new SceneContract(JSON.stringify(f.catalog)),code('SCENE_UNSUPPORTED_VERSION'));
  const contract=new SceneContract(JSON.stringify(f.catalog),2),encoded=contract.export(JSON.stringify(f.packet));
  const result=contract.import(encoded);assert.equal(result.packet.epoch.generation,0);
  assert.equal(JSON.parse(encoded).manifest.logicalSchemaVersion,2);
  f.packet.version=1;assert.throws(()=>contract.read(JSON.stringify(f.packet)),code('SCENE_UNSUPPORTED_VERSION'));
});

test('v2 catalog, packet and manifest must agree, without changing container or codec profiles',()=>{
  const f=sceneFixture();f.catalog.version=2;f.packet.version=2;
  const contract=new SceneContract(JSON.stringify(f.catalog),2),encoded=contract.export(JSON.stringify(f.packet));
  const original=JSON.parse(encoded);
  for(const field of ['containerProfile','codecProfile','canonicalization'])assert.match(original.manifest[field],/v1$/);
  for(const part of ['catalog','packet','manifest'] as const) {
    const envelope=JSON.parse(encoded);
    if(part==='manifest')envelope.manifest.logicalSchemaVersion=1;
    else {
      envelope.payload[part].version=1;
      // Integrity checks may precede semantic version checks, but no mismatch is accepted.
    }
    assert.throws(()=>contract.import(JSON.stringify(envelope)));
  }
  const old=sceneFixture();assert.throws(()=>new SceneContract(JSON.stringify(old.catalog),2),code('SCENE_UNSUPPORTED_VERSION'));
  f.catalog.declaredSources[0]!.epoch.generation=-1;
  assert.throws(()=>new SceneContract(JSON.stringify(f.catalog),2),code('SCENE_INVALID_INPUT'));
});

test('empty snapshots validate current clock and authority; event, job and cross-scope refs cannot authorize a scene',t=>{
  const f=fixture(t),root=f.event('one'),memory=f.memory([root]),job=f.store.beginJob(f.scope,[root]);
  const foreign=f.store.ensureScope({...identity,tenantId:'other'}),before=f.store.snapshot();
  assert.equal(f.store.sceneSourceSnapshot(f.scope,[]).counts.nodes,0);
  assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[root]),code('SOURCE_NOT_PUBLISHED'));
  assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[{id:job.id,revision:1}]),code('SOURCE_NOT_FOUND'));
  assert.throws(()=>f.store.sceneSourceSnapshot(foreign,[memory]),code('SOURCE_NOT_FOUND'));
  assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[memory,{id:'absent',revision:1}]),code('SOURCE_NOT_FOUND'));
  assert.deepEqual(f.store.snapshot(),before);
  for(const now of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1]){f.setWall(now);assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[]),code('INVALID_INPUT'));}
  f.setWall(100_000);f.store.purge(f.scope);assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[]),code('STALE_SCOPE'));
});

test('source snapshot checks current applicability, preserves unknown/future occurrence and deduplicates diamonds',t=>{
  const f=fixture(t),root=f.event('one',{occurredAt:null}),a=f.memory([root]),b=f.memory([root]),top=f.memory([a,b]);
  const snapshot=f.store.sceneSourceSnapshot(f.scope,[top,a]);assert.equal(snapshot.counts.nodes,4);assert.equal(snapshot.counts.edges,4);
  assert.equal(snapshot.roots.length,1);assert.equal(snapshot.roots[0]!.occurredAt,null);
  const futureOccurrence=f.memory([f.event('future',{occurredAt:999_999})]);
  assert.equal(f.store.sceneSourceSnapshot(f.scope,[futureOccurrence]).roots[0]!.occurredAt,999_999);
  const future=f.memory([root],{...claim,validFrom:100_001}),expired=f.memory([root],{...claim,validTo:100_001});
  assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[future]),code('STALE_SOURCE'));
  f.setWall(100_001);assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[expired]),code('STALE_SOURCE'));
});

test('32 selections pass; 33 fail before bodies are materialized',t=>{
  const f=fixture(t),root=f.event('one'),selected=Array.from({length:33},()=>f.memory([root]));
  assert.equal(f.store.sceneSourceSnapshot(f.scope,selected.slice(0,32)).counts.selected,32);
  const prepare=DatabaseSync.prototype.prepare;let bodyReads=0;
  try {
    DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('SELECT body FROM nodes'))bodyReads++;return prepare.call(this,sql);};
    assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,selected),code('SCENE_SOURCE_LIMIT'));assert.equal(bodyReads,0);
  } finally {DatabaseSync.prototype.prepare=prepare;}
});

for(const count of [128,129])test(`scene closure nodes ${count} use the bounded collector`,t=>{
  const f=graph(t);f.node('n0','event');for(let i=1;i<count;i++)f.node('n'+i,'memory',['n'+(i-1)]);
  const before=f.store.snapshot(),prepare=DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare=function(sql){assert.doesNotMatch(sql,/WITH RECURSIVE/);return prepare.call(this,sql);};
    if(count===128)assert.equal(f.store.sceneSourceSnapshot(f.scope,[f.ref('n127')]).counts.nodes,128);
    else assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[f.ref('n128')]),code('SCENE_SOURCE_LIMIT'));
  } finally {DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(f.store.snapshot(),before);
});

for(const extra of [false,true])test(`scene closure edges ${extra?513:512} are capped before expansion`,t=>{
  const f=graph(t);for(let i=0;i<17;i++)f.node('r'+i,'event');
  const selected=Array.from({length:32},(_,i)=>f.node('m'+i,'memory',Array.from({length:16+Number(extra&&i===0)},(_,j)=>'r'+j)));
  const before=f.store.snapshot(),prepare=DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare=function(sql){if(sql.includes('FROM dependencies WHERE child_id='))assert.match(sql,/LIMIT \?/);return prepare.call(this,sql);};
    if(extra)assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,selected),code('SCENE_SOURCE_LIMIT'));
    else assert.equal(f.store.sceneSourceSnapshot(f.scope,selected).counts.edges,512);
  } finally {DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(f.store.snapshot(),before);
});

for(const kind of ['cycle','self','missing','revision-conflict','stale-edge','no-root','event-parent','foreign-parent'] as const)
test(`scene source closure rejects ${kind} without a partial result or mutation`,t=>{
  const f=graph(t);let selected,expected:string;
  if(kind==='cycle'){f.node('a','memory',['b']);selected=f.node('b','memory',['a']);expected='SCENE_SOURCE_CYCLE';}
  else if(kind==='self'){selected=f.node('a','memory',['a']);expected='SCENE_SOURCE_CYCLE';}
  else if(kind==='missing'){selected=f.node('a','memory',['missing']);expected='SOURCE_NOT_FOUND';}
  else if(kind==='no-root'){selected=f.node('a','memory');expected='EVENT_PROVENANCE_REQUIRED';}
  else if(kind==='event-parent'){f.node('root','event');f.node('event','event',['root']);selected=f.node('a','memory',['event']);expected='SCENE_SOURCE_GRAPH_INVALID';}
  else if(kind==='foreign-parent'){
    const other=f.store.ensureScope({...identity,tenantId:'other'});f.node('root','event');selected=f.node('a','memory',['root']);
    f.injector.prepare('UPDATE nodes SET scope_id=? WHERE id=?').run(other.id,'root');expected='SOURCE_NOT_FOUND';
  } else {
    f.node('root','event');f.node('a','memory',['root']);f.node('b','memory',['root']);
    f.injector.prepare('UPDATE dependencies SET parent_revision=2 WHERE child_id=?').run(kind==='stale-edge'?'a':'b');
    selected=kind==='stale-edge'?f.ref('a'):f.node('top','memory',['a','b']);expected=kind==='stale-edge'?'STALE_SOURCE':'SCENE_SOURCE_VERSION_CONFLICT';
  }
  const before=f.store.snapshot();assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[selected]),code(expected));assert.deepEqual(f.store.snapshot(),before);
});

test('scene source budget admits 262144 bytes and rejects plus one; oversized bodies are not materialized',t=>{
  const f=graph(t),roots=Array.from({length:32},(_,i)=>'r'+i);for(const id of roots)f.node(id,'event',[],'界'+'x'.repeat(4000));
  const selected=f.node('top','memory',roots),initial=f.store.sceneSourceSnapshot(f.scope,[selected]);
  assert.ok(initial.counts.bytes>=Buffer.byteLength(JSON.stringify(initial)));
  f.injector.prepare("UPDATE nodes SET body=?||body WHERE id='r0'").run(' '.repeat(262_144-initial.counts.bytes));
  assert.equal(f.store.sceneSourceSnapshot(f.scope,[selected]).counts.bytes,262_144);
  f.injector.prepare("UPDATE nodes SET body=' '||body WHERE id='r0'").run();
  assert.throws(()=>f.store.sceneSourceSnapshot(f.scope,[selected]),code('SCENE_SOURCE_LIMIT'));
  const g=graph(t);g.node('huge','event',[],'界'.repeat(100_000));const top=g.node('top','memory',['huge']);
  const prepare=DatabaseSync.prototype.prepare;let reads=0;
  try {
    DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('SELECT body FROM nodes'))reads++;return prepare.call(this,sql);};
    assert.throws(()=>g.store.sceneSourceSnapshot(g.scope,[top]),code('SCENE_SOURCE_LIMIT'));assert.equal(reads,1);
  } finally {DatabaseSync.prototype.prepare=prepare;}
});
