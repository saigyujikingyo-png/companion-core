import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemoryStore} from '../src/store.ts';
import {DurableFanout} from '../src/durable-fanout.ts';
import {AnchoredVault} from '../src/anchored-vault.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {generateKeySet} from '../src/anchored-codec.ts';
import {COLD_SAFETY_PROFILE} from '../src/safety-format.ts';
import {inspectMemoryImage} from '../src/memory-image.ts';
import type {Epoch,Proposal,SourceRef} from '../src/contracts.ts';

const who={tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test'};
const input=(key:string)=>({source:'synthetic',eventKey:key,evidence:{speakerId:'subject',speakerRole:'subject' as const,
  mode:'self_report' as const,selectedText:`generation-capacity-${key}`,occurredAt:null}});
const proposal:Proposal={kind:'claim',statement:'synthetic current memory',basis:'self_report',validFrom:null,validTo:null};
function publish(s:MemoryStore,scope:Epoch,refs:SourceRef[],p=proposal):SourceRef{
  const job=s.beginJob(scope,refs),lease=s.claimLease(scope,job.id);s.propose(scope,job.id,lease.token,p);
  return{...s.publish(scope,job.id,lease.token),revision:1};
}
function inspect<T>(s:MemoryStore,body:(db:DatabaseSync)=>T):T{
  const db=new DatabaseSync(':memory:');try{db.deserialize(s.snapshot());return body(db);}finally{db.close();}
}
function history(s:MemoryStore,scope:Epoch){return inspect(s,db=>({
  nodes:db.prepare('SELECT * FROM nodes WHERE scope_id=? AND generation<? ORDER BY id').all(scope.id,scope.generation),
  ingress:db.prepare('SELECT i.* FROM ingress i JOIN nodes n ON n.id=i.node_id WHERE n.scope_id=? AND n.generation<? ORDER BY i.scope_id,i.key_hash').all(scope.id,scope.generation),
  edges:db.prepare('SELECT d.* FROM dependencies d JOIN nodes n ON n.id=d.child_id WHERE n.scope_id=? AND n.generation<? ORDER BY d.child_id,d.parent_id').all(scope.id,scope.generation),
}));}
function fanoutState(s:MemoryStore){return inspect(s,db=>({
  consumers:db.prepare('SELECT * FROM fanout_consumers ORDER BY id').all(),
  projection:db.prepare('SELECT * FROM fanout_projection ORDER BY consumer_id,node_id').all(),
  state:db.prepare('SELECT * FROM fanout_state').all(),
}));}
function events(s:MemoryStore,scope:Epoch,count:number,prefix='old'):SourceRef[]{
  const refs:SourceRef[]=[];
  for(let i=0;i<count;i++){
    refs.push(s.acceptEvent(scope,input(`${prefix}-${i}`)));
    // Existing public retention only: keep the unrelated 512-batch cap out of this fixture.
    if((i+1)%128===0)s.pruneJournal(0);
  }
  return refs;
}

test('purged generations no longer consume the node budget across consumer lifecycle and TTL',t=>{
  let wall=100;const s=new MemoryStore(':memory:',{schemaVersion:2,clock:{wall:()=>wall,monotonic:()=>0}});t.after(()=>s.close());
  const oldScope=s.ensureScope(who);s.registerConsumer('retrieval',oldScope,'retrieval-refs-v1');
  const old=events(s,oldScope,513),oldHandle=s.bindConsumer('retrieval',oldScope),scope=s.purge(oldScope),saved=history(s,scope);
  assert.equal(saved.nodes.length,513);assert.equal(saved.ingress.length,513);
  assert.throws(()=>s.readConsumer(oldHandle),/FANOUT_STALE_HANDLE/);
  const e=s.acceptEvent(scope,input('current')),m=publish(s,scope,[e],{...proposal,validTo:200});
  let retrieval=s.resumeConsumer('retrieval',scope),scene=s.registerConsumer('scene',scope,'scene-source-refs-v1');
  assert.deepEqual(s.readConsumer(retrieval).refs.map(r=>r.id),[m.id]);
  assert.deepEqual(new Set(s.readConsumer(scene).refs.map(r=>r.id)),new Set([e.id,m.id]));
  const extra=s.acceptEvent(scope,input('unprojected'));s.applyConsumers([retrieval,scene]);
  assert.ok(!s.readConsumer(scene).refs.some(r=>r.id===extra.id));
  const previous=retrieval;retrieval=s.resetConsumer('retrieval',scope);assert.throws(()=>s.readConsumer(previous),/FANOUT_STALE_HANDLE/);
  s.pauseConsumer(scene);assert.throws(()=>s.readConsumer(scene),/FANOUT_STALE_HANDLE/);scene=s.resumeConsumer('scene',scope);
  const before=s.invalidationJournal().at(-1)!.sequence;wall=200;
  assert.throws(()=>s.readConsumer(retrieval),/FANOUT_STALE_PROJECTION/);
  assert.ok(s.invalidationJournal().at(-1)!.sequence>before);assert.equal(s.invalidationJournal().at(-1)!.phase,'sweep');
  assert.equal(s.sweepConsumers().changed,false);s.applyConsumers([retrieval,scene]);
  assert.deepEqual(s.readConsumer(retrieval).refs,[]);assert.deepEqual(s.readConsumer(scene).refs,[]);
  assert.deepEqual(s.acceptEvent(scope,input('old-0')),{...old[0],currentStatus:'revoked'});
  assert.throws(()=>s.acceptEvent(scope,{...input('old-0'),evidence:{...input('old-0').evidence,selectedText:'conflicting payload'}}),/IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(history(s,scope),saved);assert.equal(inspectMemoryImage(s.snapshot(),2).schema,2);
});

test('current 2080 edges refuse atomically, while the same complete purged edge history permits a new graph',t=>{
  const s=new MemoryStore(':memory:',{schemaVersion:2,clock:{wall:()=>100,monotonic:()=>0}});t.after(()=>s.close());
  const oldScope=s.ensureScope(who),roots=events(s,oldScope,32);
  for(let i=0;i<64;i++)publish(s,oldScope,roots);
  const a=s.registerConsumer('retrieval',oldScope,'retrieval-refs-v1'),b=s.registerConsumer('scene',oldScope,'scene-source-refs-v1');
  assert.equal(s.readConsumer(a).refs.length,64);assert.equal(s.readConsumer(b).refs.length,96);
  publish(s,oldScope,roots);const before=fanoutState(s);
  assert.equal(inspect(s,db=>db.prepare('SELECT count(*) AS n FROM dependencies').get()!.n),2080);
  assert.throws(()=>s.applyConsumers([a,b]),/FANOUT_BASELINE_LIMIT/);
  assert.throws(()=>s.resetConsumer(a.id,oldScope),/FANOUT_BASELINE_LIMIT/);
  assert.throws(()=>s.registerConsumer('overflow',oldScope,'retrieval-refs-v1'),/FANOUT_BASELINE_LIMIT/);
  assert.deepEqual(fanoutState(s),before);
  const scope=s.purge(oldScope),saved=history(s,scope);assert.equal(saved.edges.length,2080);assert.equal(saved.nodes.length,97);
  assert.throws(()=>s.applyConsumers([a,b]),/FANOUT_STALE_HANDLE/);
  const e=s.acceptEvent(scope,input('new')),m=publish(s,scope,[e]),current=[s.resetConsumer(a.id,scope),s.resetConsumer(b.id,scope)];
  s.applyConsumers(current);assert.deepEqual(s.readConsumer(current[0]!).refs.map(r=>r.id),[m.id]);
  assert.equal(s.readConsumer(current[1]!).refs.length,2);assert.deepEqual(history(s,scope),saved);
});

test('current 513 nodes still count revoked and expired rows and cannot partially replace projections',t=>{
  let wall=100;const s=new MemoryStore(':memory:',{schemaVersion:2,clock:{wall:()=>wall,monotonic:()=>0}});t.after(()=>s.close());
  const scope=s.ensureScope(who),roots=events(s,scope,512,'current');
  s.registerConsumer('retrieval',scope,'retrieval-refs-v1');s.registerConsumer('scene',scope,'scene-source-refs-v1');
  publish(s,scope,[roots[0]!],{...proposal,validTo:200});s.revoke(scope,roots[1]!);
  const current=s.scope(scope.id),a=s.bindConsumer('retrieval',current),b=s.bindConsumer('scene',current),before=fanoutState(s);
  assert.equal(inspect(s,db=>db.prepare('SELECT count(*) AS n FROM nodes WHERE generation=?').get(current.generation)!.n),513);
  assert.throws(()=>s.applyConsumers([a,b]),/FANOUT_BASELINE_LIMIT/);
  assert.throws(()=>s.registerConsumer('overflow',current,'retrieval-refs-v1'),/FANOUT_BASELINE_LIMIT/);
  wall=200;assert.throws(()=>s.sweepConsumers(),/FANOUT_BASELINE_LIMIT/);
  assert.throws(()=>s.readConsumer(a),/FANOUT_BASELINE_LIMIT/);
  assert.throws(()=>s.resumeConsumer(a.id,current),/FANOUT_BASELINE_LIMIT/);
  assert.deepEqual(fanoutState(s),before);
});

test('structural cross-generation dependency fixture keeps current child and descendants invisible without deleting the edge',t=>{
  let wall=100;const clock={wall:()=>wall,monotonic:()=>0},source=new MemoryStore(':memory:',{schemaVersion:2,clock});t.after(()=>source.close());
  const oldScope=source.ensureScope(who),old=source.acceptEvent(oldScope,input('old')),scope=source.purge(oldScope);
  const e=source.acceptEvent(scope,input('current')),bad=publish(source,scope,[e],{...proposal,validTo:200}),child=publish(source,scope,[bad]),good=publish(source,scope,[e]);
  const db=new DatabaseSync(':memory:');let image:Uint8Array;
  try{
    db.deserialize(source.snapshot());const controller=new DurableFanout(db,()=>100);
    // Deliberate structural injection: the public API correctly refuses old source refs.
    db.exec('BEGIN');controller.begin();
    db.prepare('INSERT INTO dependencies VALUES (?,?,?)').run(bad.id,old.id,old.revision);
    controller.finish(true);db.exec('COMMIT');controller.end();image=db.serialize();
  }finally{db.close();}
  const s=new MemoryStore(':memory:',{schemaVersion:2,image,clock});t.after(()=>s.close());const current=s.scope(scope.id);
  const a=s.registerConsumer('retrieval',current,'retrieval-refs-v1'),b=s.registerConsumer('scene',current,'scene-source-refs-v1');
  assert.deepEqual(s.readConsumer(a).refs.map(r=>r.id),[good.id]);
  assert.deepEqual(new Set(s.readConsumer(b).refs.map(r=>r.id)),new Set([e.id,good.id]));
  const edges=()=>inspect(s,d=>d.prepare('SELECT * FROM dependencies ORDER BY child_id,parent_id').all()),before=edges();
  assert.equal(before.length,4);assert.ok(before.some(r=>r.child_id===bad.id&&r.parent_id===old.id));
  wall=200;assert.throws(()=>s.readConsumer(a),/FANOUT_STALE_PROJECTION/);s.applyConsumers([a,b]);
  assert.deepEqual(s.readConsumer(a).refs.map(r=>r.id),[good.id]);assert.deepEqual(edges(),before);
  assert.equal(inspect(s,d=>d.prepare('SELECT count(*) AS n FROM nodes WHERE id IN (?,?) AND projection_visible!=0').get(bad.id,child.id)!.n),0);
  assert.equal(inspectMemoryImage(s.snapshot(),2).schema,2);
});

test('P4 public history beyond 512 nodes survives one persistent reopen with fresh consumer handles',t=>{
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'companion-generation-capacity-')));
  const authority=LocalSqliteAuthority.create({directory:join(root,'authority'),authorityId:'synthetic-authority',custodyDomain:'independent'});
  const config={directory:join(root,'vault'),vaultId:'synthetic-vault',identity:'synthetic',storageDomain:'payload',keys:generateKeySet(),authority,schemaVersion:2 as const,storageProfile:COLD_SAFETY_PROFILE};
  const options={clock:{wall:()=>100,monotonic:()=>0}};let v=AnchoredVault.create(config,4,options);t.after(()=>{v.close();authority.close();});
  const oldScope=v.store.ensureScope(who);events(v.store,oldScope,513);const scope=v.store.purge(oldScope),saved=history(v.store,scope);
  const e=v.store.acceptEvent(scope,input('current')),m=publish(v.store,scope,[e]);
  const a=v.store.registerConsumer('retrieval',scope,'retrieval-refs-v1'),b=v.store.registerConsumer('scene',scope,'scene-source-refs-v1');
  v.claim('unknown','synthetic');v.reserve('unknown');v.terminal('unknown','unknown');v.close();
  v=AnchoredVault.open(config,4,options);assert.throws(()=>v.store.readConsumer(a),/FANOUT_STALE_HANDLE/);
  const current=v.store.scope(scope.id),handles=[v.store.bindConsumer(a.id,current),v.store.bindConsumer(b.id,current)];v.store.applyConsumers(handles);
  assert.deepEqual(v.store.readConsumer(handles[0]!).refs.map(r=>r.id),[m.id]);assert.equal(v.store.readConsumer(handles[1]!).refs.length,2);
  assert.equal(v.store.acceptEvent(current,input('old-0')).currentStatus,'revoked');
  assert.throws(()=>v.store.acceptEvent(current,{...input('old-0'),evidence:{...input('old-0').evidence,selectedText:'conflict'}}),/IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(history(v.store,current),saved);assert.equal(v.reserved,1);assert.equal(v.status.unknownRequests,1);
  assert.throws(()=>v.claim('unknown','synthetic'),/INTERACTION_TERMINATED/);
  t.diagnostic(`Retained synthetic P4 fixture: ${root}`);
});
