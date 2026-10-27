import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { DurableFanout } from '../src/durable-fanout.ts';
import { FANOUT_LIMITS } from '../src/fanout-types.ts';
import type { FanoutFault } from '../src/fanout-types.ts';
import type { Epoch, Proposal, SourceRef } from '../src/contracts.ts';
import { actualLayoutHash, expectedLayoutHash, inspectMemoryImage, maintainFanoutImage, migrateMemoryImage, schemaHash, schemaSQL } from '../src/memory-image.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { ANCHORED_FORMAT, decodeStage, generateKeySet, identityOf, sealV2, writeNew } from '../src/anchored-codec.ts';

const who={tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test'};
const input=(key='one')=>({source:'synthetic',eventKey:key,evidence:{speakerId:'subject',speakerRole:'subject' as const,
  mode:'self_report' as const,selectedText:`SYNTHETIC_PRIVATE_BODY_${key}`,occurredAt:null}});
const proposal:Proposal={kind:'claim',statement:'SYNTHETIC_PRIVATE_DERIVED_VIOLET',basis:'self_report',validFrom:null,validTo:null};
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function publish(store:MemoryStore,scope:Epoch,refs:SourceRef[],p:Proposal=proposal):SourceRef{
  const job=store.beginJob(scope,refs),lease=store.claimLease(scope,job.id);store.propose(scope,job.id,lease.token,p);
  return{...store.publish(scope,job.id,lease.token),revision:1};
}
function fixture(t:TestContext,fault?: (point:FanoutFault)=>void){
  let wall=100,persists=0,image:Uint8Array|undefined;
  const s=new MemoryStore(':memory:',{schemaVersion:2,clock:{wall:()=>wall,monotonic:()=>0},persist:bytes=>{persists++;image=bytes;},...(fault?{fanoutFault:fault}:{})});
  t.after(()=>s.close());const scope=s.ensureScope(who);
  return{s,scope,setWall:(n:number)=>{wall=n;},commits:()=>persists,image:()=>image!};
}
function snapshotDB(store:MemoryStore):DatabaseSync{const db=new DatabaseSync(':memory:',{enableForeignKeyConstraints:true});db.deserialize(store.snapshot());return db;}
function anchored(t:TestContext,schemaVersion:1|2=2){
  const root=mkdtempSync(join(tmpdir(),'companion-fanout-v2-')),authority=LocalSqliteAuthority.create({directory:join(root,'authority'),authorityId:'synthetic-authority',custodyDomain:'independent'});
  const config={directory:join(root,'vault'),vaultId:'synthetic-vault',identity:'synthetic',storageDomain:'payload',keys:generateKeySet(),authority,schemaVersion};
  const options={clock:{wall:()=>100,monotonic:()=>0}},v=AnchoredVault.create(config,4,options);t.after(()=>{v.close();authority.close();});return{root,authority,config,options,v};
}
/** Test-only frozen fixture installation. Uses real v2 sealing and lawful
 * prepare/publish/finalize, avoiding hundreds of full-image disk commits. */
function installSyntheticImage(f:ReturnType<typeof anchored>,image:Uint8Array,highWater=0){
  const head=f.v.head,identity=identityOf(head),decoded=decodeStage(Buffer.from(JSON.stringify({format:ANCHORED_FORMAT,head,
    checkpoint:readFileSync(join(head.directory,`checkpoint-${head.sequence}.bin`)).toString('base64'),record:readFileSync(join(head.directory,`record-${head.sequence}.bin`)).toString('base64')})),f.config.keys,4);
  f.v.close();const operationId=randomUUID(),sequence=head.sequence+1;
  const checkpoint=sealV2({...decoded.state,sequence,image:Buffer.from(image).toString('base64'),revocationHighWater:highWater},'checkpoint',identity,f.config.keys.storageDEK);
  decoded.image.fill(0);
  const record=sealV2({version:2,identity,sequence,operationId,previous:head.digest,parentHead:null,checkpointDigest:sha(checkpoint),revocationHighWater:highWater},'record',identity,f.config.keys.storageDEK);
  const next={...identity,sequence,digest:sha(record)},bytes=Buffer.from(JSON.stringify({format:ANCHORED_FORMAT,head:next,checkpoint:checkpoint.toString('base64'),record:record.toString('base64')})),stagePath=join(head.directory,`stage-${operationId}.json`);
  writeNew(stagePath,bytes);
  f.authority.transaction(tx=>{const pending={version:2 as const,kind:'write' as const,operationId,requestDigest:sha(bytes),oldHead:head,newHead:next,stagePath,stageDigest:sha(bytes)};tx.prepare(pending);
    writeNew(join(head.directory,`checkpoint-${sequence}.bin`),checkpoint);writeNew(join(head.directory,`record-${sequence}.bin`),record);tx.finalize(pending);});
  return next;
}

test('schema2 is explicit, old schema1 hash stays fixed and all inspectors reject unknown versions',t=>{
  const f=fixture(t);assert.equal(schemaHash(1),sha(SCHEMA_SQL));assert.equal(f.s.diagnostics().schema,2);
  const image=f.s.snapshot();assert.throws(()=>MemoryStore.validateImage(image),/UNSUPPORTED_SCHEMA/);
  assert.throws(()=>new MemoryStore(':memory:',{image}),/UNSUPPORTED_SCHEMA/);
  assert.equal(inspectMemoryImage(image,2).schema,2);
  assert.throws(()=>inspectMemoryImage(image,3 as any),/UNSUPPORTED_SCHEMA/);assert.throws(()=>schemaSQL(3 as any),/UNSUPPORTED_SCHEMA/);
  assert.throws(()=>expectedLayoutHash(3 as any),/UNSUPPORTED_SCHEMA/);
  assert.throws(()=>f.s.projectionBatch(f.scope),/FANOUT_LEGACY_ACK_DISABLED/);
  assert.throws(()=>f.s.acknowledgeProjection(f.scope,{} as any),/FANOUT_LEGACY_ACK_DISABLED/);
});

test('fixed expected layouts reject a forged self-consistent metadata layout hash for both versions',()=>{
  for(const version of [1,2] as const){const s=new MemoryStore(':memory:',{schemaVersion:version});const db=snapshotDB(s);s.close();
    try{db.exec('CREATE TABLE unexpected (id INTEGER)');db.prepare("UPDATE meta SET value=? WHERE key='layout_hash'").run(actualLayoutHash(db));
      assert.throws(()=>inspectMemoryImage(db.serialize(),version),/SCHEMA_MISMATCH/);
    }finally{db.close();}}
});

test('no-boot inspectors and migration reject missing or malformed stable Store ledger keys',()=>{
  for(const version of [1,2] as const)for(const defect of ['missing','invalid']){
    const s=new MemoryStore(':memory:',{schemaVersion:version}),db=snapshotDB(s);s.close();
    try{
      if(defect==='missing')db.exec("DELETE FROM meta WHERE key='ledger_key'");else db.exec("UPDATE meta SET value='invalid' WHERE key='ledger_key'");
      const image=db.serialize(),before=sha(image);assert.throws(()=>inspectMemoryImage(image,version),/DURABLE_LEDGER_KEY/);
      if(version===1)assert.throws(()=>migrateMemoryImage(image,1,2),/DURABLE_LEDGER_KEY/);assert.equal(sha(image),before);
    }finally{db.close();}
  }
});

test('two actual metadata consumers progress independently and scope gaps still require a complete prefix',t=>{
  const f=fixture(t),a=f.s.registerConsumer('retrieval',f.scope,'retrieval-refs-v1'),b=f.s.registerConsumer('scene',f.scope,'scene-source-refs-v1');
  const e=f.s.acceptEvent(f.scope,input()),memory=publish(f.s,f.scope,[e]);
  const beforeB=f.s.consumerStatus(b.id).applied;f.s.applyConsumers([a]);
  assert.equal(f.s.consumerStatus(b.id).applied,beforeB);assert.throws(()=>f.s.readConsumer(b),/FANOUT_STALE_PROJECTION/);
  assert.deepEqual(f.s.readConsumer(a).refs.map(r=>r.id),[memory.id]);f.s.applyConsumers([b]);
  assert.deepEqual(new Set(f.s.readConsumer(b).refs.map(r=>r.id)),new Set([e.id,memory.id]));
  assert.equal(JSON.stringify(f.s.readConsumer(b)).includes('SYNTHETIC_PRIVATE'),false);
  assert.equal(JSON.stringify(f.s.invalidationJournal()).includes('SYNTHETIC_PRIVATE'),false);
  const other=f.s.ensureScope({...who,relationshipId:'other'});f.s.acceptEvent(other,input('other'));
  assert.throws(()=>f.s.readConsumer(a),/FANOUT_STALE_PROJECTION/);f.s.applyConsumers([a]);
  assert.deepEqual(f.s.readConsumer(a).refs.map(r=>r.id),[memory.id]);assert.equal(f.s.consumerStatus(a.id).applied,f.s.consumerStatus(a.id).head);
});

test('source publication and correction emit complete final batches with highwater, never text or usable intermediate state',t=>{
  const f=fixture(t),e=f.s.acceptEvent(f.scope,input()),before=f.s.invalidationJournal().length,memory=publish(f.s,f.scope,[e]);
  const batch=f.s.invalidationJournal().at(-1)!;assert.equal(f.s.invalidationJournal().length,before+1);
  assert.ok(batch.items.some(i=>i.kind==='edge'&&i.entityId===memory.id&&i.relatedId===e.id));assert.ok(batch.items.some(i=>i.kind==='node'&&i.entityId===memory.id));
  const a=f.s.registerConsumer('retrieval',f.scope,'retrieval-refs-v1');
  f.s.reviseEvent(f.scope,e,{...input('corrected').evidence});const corrected=f.s.invalidationJournal().at(-1)!;
  assert.equal(corrected.revocationHighWater,1);assert.ok(corrected.items.some(i=>i.entityId===e.id));assert.ok(corrected.items.some(i=>i.entityId===memory.id));
  assert.throws(()=>f.s.applyConsumers([a]),/FANOUT_STALE_HANDLE/);
  const current=f.s.bindConsumer(a.id,f.s.scope(f.scope.id));f.s.applyConsumers([current]);assert.deepEqual(f.s.readConsumer(current).refs,[]);
  assert.equal(inspectMemoryImage(f.s.snapshot(),2).revocationHighWater,1);
});

test('journal finalization failure rolls source, FTS, batch and sequence back atomically',t=>{
  let armed=false;const f=fixture(t,p=>{if(armed&&p==='before-journal-finalize')throw new Error('SYNTHETIC_JOURNAL_FAULT');});
  const e=f.s.acceptEvent(f.scope,input()),job=f.s.beginJob(f.scope,[e]),lease=f.s.claimLease(f.scope,job.id);f.s.propose(f.scope,job.id,lease.token,proposal);
  const before=f.s.invalidationJournal(),commits=f.commits();armed=true;assert.throws(()=>f.s.publish(f.scope,job.id,lease.token),/SYNTHETIC_JOURNAL_FAULT/);armed=false;
  assert.deepEqual(f.s.invalidationJournal(),before);assert.equal(f.s.search(f.scope,'VIOLET').length,0);assert.equal(f.commits(),commits);
  f.s.publish(f.scope,job.id,lease.token);assert.equal(f.s.search(f.scope,'VIOLET').length,1);
});

for(const point of ['after-projection-write','before-consumer-checkpoint'] as FanoutFault[]){
  test(`consumer ${point} failure leaves projection and cursor together at the prior prefix`,t=>{
    let armed=false;const f=fixture(t,p=>{if(armed&&p===point)throw new Error('SYNTHETIC_CONSUMER_FAULT');});
    const a=f.s.registerConsumer('a',f.scope,'retrieval-refs-v1'),b=f.s.registerConsumer('b',f.scope,'scene-source-refs-v1');
    const e=f.s.acceptEvent(f.scope,input());publish(f.s,f.scope,[e]);const before=f.s.consumerStatus(a.id),commits=f.commits();
    armed=true;assert.throws(()=>f.s.applyConsumers([a,b]),/SYNTHETIC_CONSUMER_FAULT/);armed=false;
    assert.deepEqual(f.s.consumerStatus(a.id),before);assert.equal(f.commits(),commits);
    const db=snapshotDB(f.s);try{assert.equal(db.prepare('SELECT count(*) AS n FROM fanout_projection').get()!.n,0);}finally{db.close();}
    f.s.applyConsumers([a,b]);assert.equal(f.s.readConsumer(a).refs.length,1);assert.equal(f.s.readConsumer(b).refs.length,2);
  });
}

test('unchanged polls and identical consent do not create journal batches or durable checkpoints',t=>{
  const f=fixture(t),a=f.s.registerConsumer('a',f.scope,'retrieval-refs-v1');const commits=f.commits(),journal=f.s.invalidationJournal();
  f.setWall(105);for(let i=0;i<5;i++){f.s.readConsumer(a);f.s.applyConsumers([a]);f.s.sweepConsumers();f.s.bindConsumer(a.id,f.scope);f.s.setLearningConsent(f.scope,false);}
  assert.equal(f.commits(),commits);assert.deepEqual(f.s.invalidationJournal(),journal);
});

test('future validity, ancestor expiry and stale read persist a TTL barrier before returning refusal',t=>{
  const f=fixture(t),e=f.s.acceptEvent(f.scope,input()),parent=publish(f.s,f.scope,[e],{...proposal,validTo:200}),child=publish(f.s,f.scope,[parent]);
  const future=publish(f.s,f.scope,[e],{...proposal,validFrom:150,validTo:250});const a=f.s.registerConsumer('a',f.scope,'retrieval-refs-v1');
  assert.deepEqual(new Set(f.s.readConsumer(a).refs.map(r=>r.id)),new Set([parent.id,child.id]));
  const before=f.commits();f.setWall(150);assert.throws(()=>f.s.readConsumer(a),/FANOUT_STALE_PROJECTION/);assert.equal(f.commits(),before+1);
  assert.equal(f.s.invalidationJournal().at(-1)!.phase,'sweep');f.s.applyConsumers([a]);assert.equal(f.s.readConsumer(a).refs.length,3);
  f.setWall(200);f.s.sweepConsumers();f.s.applyConsumers([a]);assert.deepEqual(f.s.readConsumer(a).refs.map(r=>r.id),[future.id]);
  f.setWall(250);f.s.applyConsumers([a]);assert.deepEqual(f.s.readConsumer(a).refs,[]);
  const image=f.s.snapshot();f.setWall(249);assert.throws(()=>f.s.readConsumer(a),/FANOUT_CLOCK_ROLLBACK/);
  assert.throws(()=>new MemoryStore(':memory:',{schemaVersion:2,image,clock:{wall:()=>249,monotonic:()=>0}}),/FANOUT_CLOCK_ROLLBACK/);
});

test('a consumer read freezes one asOf across its sweep and readonly transaction',t=>{
  let wall=100,calls=0;const s=new MemoryStore(':memory:',{schemaVersion:2,clock:{wall:()=>{calls++;return wall++;},monotonic:()=>0}});t.after(()=>s.close());
  const scope=s.ensureScope(who),e=s.acceptEvent(scope,input()),memory=publish(s,scope,[e],{...proposal,validTo:200});const a=s.registerConsumer('a',scope,'retrieval-refs-v1');
  wall=199;calls=0;assert.deepEqual(s.readConsumer(a).refs.map(r=>r.id),[memory.id]);assert.equal(calls,1);
  assert.throws(()=>s.readConsumer(a),/FANOUT_STALE_PROJECTION/);assert.equal(s.invalidationJournal().at(-1)!.phase,'sweep');
});

test('pause clears usable projection and resume/reset creates a new generation and baseline',t=>{
  const f=fixture(t),e=f.s.acceptEvent(f.scope,input());publish(f.s,f.scope,[e]);const old=f.s.registerConsumer('a',f.scope,'retrieval-refs-v1');
  f.s.pauseConsumer(old);assert.equal(f.s.consumerStatus(old.id).status,'paused');assert.throws(()=>f.s.applyConsumers([old]),/FANOUT_STALE_HANDLE/);
  const paused=f.s.bindConsumer(old.id,f.scope);assert.throws(()=>f.s.readConsumer(paused),/FANOUT_CONSUMER_INACTIVE/);
  const resumed=f.s.resumeConsumer(old.id,f.scope);assert.ok(resumed.generation>old.generation);assert.equal(f.s.readConsumer(resumed).refs.length,1);
  const reset=f.s.resetConsumer(old.id,f.scope);assert.throws(()=>f.s.readConsumer(resumed),/FANOUT_STALE_HANDLE/);assert.equal(f.s.readConsumer(reset).refs.length,1);
});

test('scope purge, consent change and artifact activation fence previously issued handles',t=>{
  const f=fixture(t);let scope=f.scope;let h=f.s.registerConsumer('a',scope,'retrieval-refs-v1');
  scope=f.s.purge(scope);assert.throws(()=>f.s.applyConsumers([h]),/FANOUT_STALE_HANDLE/);assert.throws(()=>f.s.readConsumer(h),/FANOUT_STALE_HANDLE/);
  h=f.s.bindConsumer('a',scope);f.s.applyConsumers([h]);scope=f.s.setLearningConsent(scope,true);assert.throws(()=>f.s.applyConsumers([h]),/FANOUT_STALE_HANDLE/);
  h=f.s.bindConsumer('a',scope);f.s.applyConsumers([h]);const e=f.s.acceptEvent(scope,input());publish(f.s,scope,[e]);
  const job=f.s.beginJob(scope,[e],'training'),lease=f.s.claimLease(scope,job.id),artifact=f.s.registerArtifact(scope,job.id,lease.token,{sha256:'a'.repeat(64),implementation:'synthetic'});
  f.s.activateArtifact(scope,artifact.id);assert.throws(()=>f.s.applyConsumers([h]),/FANOUT_STALE_HANDLE/);
  h=f.s.bindConsumer('a',scope);f.s.applyConsumers([h]);assert.equal(f.s.readConsumer(h).refs.length,1);
  scope=f.s.setLearningConsent(scope,false);h=f.s.bindConsumer('a',scope);f.s.applyConsumers([h]);assert.equal(f.s.readConsumer(h).refs.length,1);
});

test('required consumer blocks retention; resettable laggards atomically lose old handles and require baseline',t=>{
  const f=fixture(t),required=f.s.registerConsumer('required',f.scope,'retrieval-refs-v1',true),lag=f.s.registerConsumer('lag',f.scope,'scene-source-refs-v1');
  const e=f.s.acceptEvent(f.scope,input());publish(f.s,f.scope,[e]);assert.throws(()=>f.s.pruneJournal(0),/FANOUT_RETENTION_BLOCKED/);
  f.s.applyConsumers([required]);const result=f.s.pruneJournal(0);assert.deepEqual(result.resetConsumers,['lag']);assert.equal(f.s.invalidationJournal().length,0);
  assert.equal(f.s.consumerStatus(lag.id).status,'reset_required');assert.throws(()=>f.s.applyConsumers([lag]),/FANOUT_STALE_HANDLE/);
  const reset=f.s.resumeConsumer(lag.id,f.scope);assert.equal(f.s.readConsumer(reset).refs.length,2);
  const previous=f.s.consumerStatus(reset.id).head;f.s.acceptEvent(f.scope,input('after-prune'));assert.ok(f.s.invalidationJournal()[0]!.sequence>previous);
  assert.equal(inspectMemoryImage(f.s.snapshot(),2).schema,2);
});

test('oversized complete baseline refuses registration without exposing a partial projection',t=>{
  const legacy=new MemoryStore(':memory:',{clock:{wall:()=>100,monotonic:()=>0}});const scope=legacy.ensureScope(who);
  for(let i=0;i<=FANOUT_LIMITS.scopeNodes;i++)legacy.acceptEvent(scope,input(`bounded-${i}`));
  const image=migrateMemoryImage(legacy.snapshot(),1,2,100);legacy.close();const s=new MemoryStore(':memory:',{schemaVersion:2,image,clock:{wall:()=>100,monotonic:()=>0}});t.after(()=>s.close());
  assert.throws(()=>s.registerConsumer('too-large',s.scope(scope.id),'retrieval-refs-v1'),/FANOUT_BASELINE_LIMIT/);
  assert.throws(()=>s.consumerStatus('too-large'),/FANOUT_CONSUMER_NOT_FOUND/);
});

test('scope admission rejects the 65th scope inside the source transaction, preserving a reopenable image',t=>{
  const f=fixture(t);for(let i=1;i<FANOUT_LIMITS.scopes;i++)f.s.ensureScope({...who,relationshipId:`scope-${i}`});
  const before=f.s.invalidationJournal(),commits=f.commits();assert.throws(()=>f.s.ensureScope({...who,relationshipId:'too-many'}),/FANOUT_LIMIT/);
  assert.deepEqual(f.s.invalidationJournal(),before);assert.equal(f.commits(),commits);assert.equal(inspectMemoryImage(f.s.snapshot(),2).schema,2);
});

test('restart preserves each durable prefix, invalidates old boot handles and journals a complete multi-scope boot fence',t=>{
  const f=anchored(t),s=f.v.store,scope=s.ensureScope(who),other=s.ensureScope({...who,relationshipId:'other'});
  const a=s.registerConsumer('a',scope,'retrieval-refs-v1'),b=s.registerConsumer('b',other,'scene-source-refs-v1');
  const e=s.acceptEvent(scope,input());publish(s,scope,[e]);s.applyConsumers([a]);const pa=s.consumerStatus('a').applied,pb=s.consumerStatus('b').applied;
  f.v.close();const reopened=AnchoredVault.open(f.config,4,f.options);t.after(()=>reopened.close());const r=reopened.store;
  assert.equal(r.consumerStatus('a').applied,pa);assert.equal(r.consumerStatus('b').applied,pb);assert.throws(()=>r.applyConsumers([a]),/FANOUT_STALE_HANDLE/);
  const boot=r.invalidationJournal().at(-1)!;assert.equal(boot.phase,'boot');assert.deepEqual(new Set(boot.items.filter(i=>i.kind==='scope').map(i=>i.scopeId)),new Set([scope.id,other.id]));
  const current=r.bindConsumer('a',r.scope(scope.id));assert.throws(()=>r.readConsumer(current),/FANOUT_STALE_PROJECTION/);r.applyConsumers([current]);assert.equal(r.readConsumer(current).refs.length,1);
});

test('offline migration preserves source bytes, ledger and runtime epoch until boot; activated schema migration fences source',t=>{
  const f=anchored(t,1),scope=f.v.store.ensureScope(who),e=f.v.store.acceptEvent(scope,input());f.v.store.revoke(scope,e);f.v.claim('native','payload');f.v.reserve('native');
  const original=f.v.store.snapshot(),before=sha(original),raw=new DatabaseSync(':memory:');raw.deserialize(original);
  const ledger=raw.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()!.value,epoch=raw.prepare('SELECT runtime_epoch FROM scopes').get()!.runtime_epoch;raw.close();
  const migrated=migrateMemoryImage(original,1,2,100);assert.equal(sha(original),before);
  const after=new DatabaseSync(':memory:');after.deserialize(migrated);
  try{assert.equal(after.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()!.value,ledger);assert.equal(after.prepare('SELECT runtime_epoch FROM scopes').get()!.runtime_epoch,epoch);
    assert.equal(after.prepare('SELECT count(*) AS n FROM fanout_batches').get()!.n,0);}finally{after.close();}
  const backup=join(f.root,'schema1-backup'),target=join(f.root,'schema2-target');f.v.exportBackup(backup);
  const packageHash=sha(readFileSync(join(backup,'current-state.json'))),request={backupDirectory:backup,targetDirectory:target,storageDomain:'payload',authority:f.authority,keys:f.config.keys,maxCalls:4,operationId:'schema-migration-once',targetSchema:2 as const};
  const receipt=AnchoredVault.migrateBackup(request);assert.equal(receipt.kind,'schema-migration');assert.equal(receipt.newHead.schemaVersion,2);
  assert.deepEqual(AnchoredVault.migrateBackup(request),receipt);assert.equal(sha(readFileSync(join(backup,'current-state.json'))),packageHash);
  assert.throws(()=>f.v.store.snapshot(),/ANCHOR_FENCED/);assert.throws(()=>AnchoredVault.open({...f.config,directory:target},4,f.options),/ANCHOR_IDENTITY/);
  const opened=AnchoredVault.open({...f.config,directory:target,schemaVersion:2},4,f.options);t.after(()=>opened.close());
  assert.equal(opened.reserved,1);assert.equal(opened.status.unknownRequests,1);assert.equal(opened.store.revocationHighWater(),1);
  assert.throws(()=>opened.claim('native','payload'),/INTERACTION_TERMINATED/);
  assert.equal(opened.store.scope(scope.id).runtimeEpoch,(epoch as number)+1);
  const db=snapshotDB(opened.store);try{assert.equal(db.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()!.value,ledger);}finally{db.close();}
  const h=opened.store.registerConsumer('retrieval',opened.store.scope(scope.id),'retrieval-refs-v1');assert.deepEqual(opened.store.readConsumer(h).refs,[]);
});

test('schema migration interruption remains pending; explicit reconcile completes only its frozen migrated image',t=>{
  const f=anchored(t,1),scope=f.v.store.ensureScope(who);f.v.store.acceptEvent(scope,input());const backup=join(f.root,'backup'),target=join(f.root,'target');f.v.exportBackup(backup);
  const original=sha(readFileSync(join(backup,'current-state.json')));
  assert.throws(()=>AnchoredVault.migrateBackup({backupDirectory:backup,targetDirectory:target,storageDomain:'payload',authority:f.authority,keys:f.config.keys,maxCalls:4,operationId:'interrupted-schema',targetSchema:2,
    fault:p=>{if(p==='prepared')throw new Error('SYNTHETIC_MIGRATION_FAULT');}}),/SYNTHETIC_MIGRATION_FAULT/);
  assert.equal(f.authority.inspect(f.config.vaultId)!.status,'PREPARED');assert.throws(()=>f.v.status,/ANCHOR_PENDING/);
  AnchoredVault.reconcile({authority:f.authority,vaultId:f.config.vaultId,operationId:'interrupted-schema',keys:f.config.keys,maxCalls:4});
  assert.equal(sha(readFileSync(join(backup,'current-state.json'))),original);
  const v=AnchoredVault.open({...f.config,directory:target,schemaVersion:2},4,f.options);t.after(()=>v.close());assert.equal(v.store.diagnostics().schema,2);
});

test('schema1 restore retains the original S1 receipt request-digest contract',t=>{
  const f=anchored(t,1),backup=join(f.root,'backup'),target=join(f.root,'target');f.v.exportBackup(backup);
  const request={backupDirectory:backup,targetDirectory:target,storageDomain:'payload',authority:f.authority,keys:f.config.keys,maxCalls:4,operationId:'compatible-restore'};
  const receipt=AnchoredVault.restoreBackup(request);
  assert.equal(receipt.requestDigest,sha(JSON.stringify({kind:'restore',backupDigest:sha(readFileSync(join(backup,'current-state.json'))),target,storageDomain:'payload',
    keyEpoch:1,storageKeyDigest:sha(f.config.keys.storageDEK),ingressKeyDigest:sha(f.config.keys.ingressKey)})));
});

test('safety-state serialization failure poisons the writer before any reservation can be acknowledged',t=>{
  const f=anchored(t);f.v.claim('native','payload');const original=DatabaseSync.prototype.serialize;
  try{DatabaseSync.prototype.serialize=function(){throw new Error('SYNTHETIC_SERIALIZE_FAULT');};assert.throws(()=>f.v.reserve('native'),/ANCHOR_WRITE_FAILED/);}
  finally{DatabaseSync.prototype.serialize=original;}
  assert.throws(()=>f.v.status,/ANCHOR_UNAVAILABLE/);f.v.close();
  const v=AnchoredVault.open(f.config,4,f.options);t.after(()=>v.close());assert.equal(v.reserved,0);assert.throws(()=>v.claim('native','payload'),/INTERACTION_TERMINATED/);
});

test('v2 restore fences old consumer handles and retains independent durable checkpoints',t=>{
  const f=anchored(t),scope=f.v.store.ensureScope(who),a=f.v.store.registerConsumer('a',scope,'retrieval-refs-v1'),b=f.v.store.registerConsumer('b',scope,'scene-source-refs-v1');
  const e=f.v.store.acceptEvent(scope,input());publish(f.v.store,scope,[e]);f.v.store.applyConsumers([a]);
  const pa=f.v.store.consumerStatus(a.id).applied,pb=f.v.store.consumerStatus(b.id).applied,backup=join(f.root,'backup'),target=join(f.root,'target');f.v.exportBackup(backup);
  AnchoredVault.restoreBackup({backupDirectory:backup,targetDirectory:target,storageDomain:'payload',authority:f.authority,keys:f.config.keys,maxCalls:4,operationId:'restore-v2'});
  const v=AnchoredVault.open({...f.config,directory:target},4,f.options);t.after(()=>v.close());
  assert.equal(v.store.consumerStatus(a.id).applied,pa);assert.equal(v.store.consumerStatus(b.id).applied,pb);assert.throws(()=>v.store.applyConsumers([a]),/FANOUT_STALE_HANDLE/);
  const current=v.store.bindConsumer(a.id,v.store.scope(scope.id));v.store.applyConsumers([current]);assert.equal(v.store.readConsumer(current).refs.length,1);
});

test('all mutable node fields and dependency/scopes mutations trigger metadata invalidations; identities are immutable',t=>{
  const f=fixture(t),e=f.s.acceptEvent(f.scope,input()),m=publish(f.s,f.scope,[e]),db=snapshotDB(f.s),controller=new DurableFanout(db,()=>100);
  const run=(sql:string)=>{db.exec('BEGIN IMMEDIATE');controller.begin();try{db.exec(sql);controller.finish(true);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}finally{controller.end();}};
  try{
    const columns={revision:'revision+1',generation:'generation+1',consent_revision:'consent_revision+1',status:"'revoked'",body:"'{\"metadata\":true}'",search_text:"'synthetic'",created_at:'created_at+1',valid_from:'10',valid_to:'200',projection_visible:'1-projection_visible'};
    for(const [column,value] of Object.entries(columns)){
      const before=db.prepare('SELECT head_seq FROM fanout_state').get()!.head_seq as number;
      run(`UPDATE nodes SET ${column}=${value} WHERE id='${m.id}'`);const head=db.prepare('SELECT head_seq FROM fanout_state').get()!.head_seq as number;assert.ok(head>before,column);
    }
    for(const column of ['id','scope_id','type'])assert.throws(()=>run(`UPDATE nodes SET ${column}='different' WHERE id='${m.id}'`),/FANOUT_IMMUTABLE_IDENTITY/);
    run(`UPDATE dependencies SET parent_revision=parent_revision+1 WHERE child_id='${m.id}'`);
    assert.equal(db.prepare('SELECT kind FROM fanout_items ORDER BY id DESC LIMIT 1').get()!.kind,'edge');
    run(`DELETE FROM dependencies WHERE child_id='${m.id}'`);assert.equal(db.prepare('SELECT operation FROM fanout_items ORDER BY id DESC LIMIT 1').get()!.operation,'delete');
    for(const column of ['generation','consent_revision','learning_allowed','runtime_epoch'])run(`UPDATE scopes SET ${column}=${column}+1 WHERE id='${f.scope.id}'`);
    assert.throws(()=>run(`UPDATE scopes SET identity='changed' WHERE id='${f.scope.id}'`),/FANOUT_IMMUTABLE_IDENTITY/);
    run(`DELETE FROM outbox WHERE node_id='${m.id}'; DELETE FROM nodes WHERE id='${m.id}'`);assert.equal(db.prepare('SELECT operation FROM fanout_items ORDER BY id DESC LIMIT 1').get()!.operation,'delete');
  }finally{db.close();}
});

test('journal content and batches are immutable outside scoped pruning, and sequence rollback is rejected',t=>{
  const f=fixture(t),db=snapshotDB(f.s);try{
    db.function('fanout_phase',()=> 'none');assert.throws(()=>db.exec('DELETE FROM fanout_batches'),/FANOUT_IMMUTABLE_BATCH/);
    assert.throws(()=>db.exec("UPDATE fanout_batches SET digest='changed'"),/FANOUT_IMMUTABLE_BATCH/);
    assert.throws(()=>db.exec("UPDATE fanout_items SET entity_id='changed'"),/FANOUT_IMMUTABLE_ITEM/);
    db.exec("UPDATE sqlite_sequence SET seq=0 WHERE name='fanout_batches'");assert.throws(()=>inspectMemoryImage(db.serialize(),2),/FANOUT_CORRUPT/);
  }finally{db.close();}
});

test('malformed schema2 consumer authority, projection shape and phantom prefix fail validation',t=>{
  const f=fixture(t),e=f.s.acceptEvent(f.scope,input());publish(f.s,f.scope,[e]);f.s.registerConsumer('a',f.scope,'retrieval-refs-v1');
  const image=f.s.snapshot();
  const defects=[
    (db:DatabaseSync)=>db.exec("UPDATE fanout_consumers SET authority='{\"id\":\"wrong\",\"generation\":0,\"consentRevision\":0,\"runtimeEpoch\":0}'"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_consumers SET authority=json_set(authority,'$.runtimeEpoch',999)"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_consumers SET as_of=999"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_projection SET revision=revision+1"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_projection SET metadata=json_set(metadata,'$.body','SYNTHETIC_FORBIDDEN_TEXT')"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_projection SET metadata=json_set(metadata,'$.revision',0)"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_projection SET metadata=json_set(metadata,'$.validFrom',-1)"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_projection SET metadata=json_set(metadata,'$.parents',json('[{\"id\":\"same\",\"revision\":1},{\"id\":\"same\",\"revision\":1}]'))"),
    (db:DatabaseSync)=>db.exec("UPDATE fanout_consumers SET status='paused'"),
  ];
  for(const defect of defects){const db=new DatabaseSync(':memory:');try{db.deserialize(image);defect(db);assert.throws(()=>inspectMemoryImage(db.serialize(),2),/FANOUT_CORRUPT/);}finally{db.close();}}
  const db=snapshotDB(f.s),controller=new DurableFanout(db,()=>100);
  try{db.exec("UPDATE sqlite_sequence SET seq=100 WHERE name='fanout_batches'");db.exec('BEGIN');controller.begin();db.exec('UPDATE scopes SET runtime_epoch=runtime_epoch+1');controller.finish(true);db.exec('COMMIT');controller.end();
    db.exec('UPDATE fanout_consumers SET applied_seq=50');assert.throws(()=>inspectMemoryImage(db.serialize(),2),/FANOUT_CORRUPT/);
  }finally{db.close();}
});

test('full journal can recover through explicit current-head maintenance without booting or resetting required consumers silently',t=>{
  const f=anchored(t),scope=f.v.store.ensureScope(who);
  f.v.store.registerConsumer('检索 consumer',scope,'retrieval-refs-v1',true);f.v.store.registerConsumer('scene:refs',scope,'scene-source-refs-v1');
  const db=snapshotDB(f.v.store),controller=new DurableFanout(db,()=>100);
  try{
    for(let i=1;i<FANOUT_LIMITS.batches;i++){db.exec('BEGIN');controller.begin();db.exec('UPDATE scopes SET runtime_epoch=runtime_epoch+1');controller.finish(true);db.exec('COMMIT');controller.end();}
    const full=db.serialize();assert.equal(inspectMemoryImage(full,2).schema,2);assert.throws(()=>new MemoryStore(':memory:',{schemaVersion:2,image:full,clock:f.options.clock}),/FANOUT_LIMIT/);
    assert.throws(()=>maintainFanoutImage(full,8,[],100),/FANOUT_RETENTION_BLOCKED/);
    assert.throws(()=>maintainFanoutImage(full,512,[],100),/FANOUT_MAINTENANCE_CAPACITY/);
    const next=installSyntheticImage(f,full),sourceFile=join(next.directory,`checkpoint-${next.sequence}.bin`),sourceHash=sha(readFileSync(sourceFile));
    assert.throws(()=>AnchoredVault.open(f.config,4,f.options),/FANOUT_LIMIT/);
    const request={authority:f.authority,vaultId:f.config.vaultId,keys:f.config.keys,maxCalls:4,targetDirectory:join(f.root,'maintained'),storageDomain:'payload',operationId:'maintain-full',retainBatches:8,resetConsumerIds:[] as string[]};
    assert.throws(()=>AnchoredVault.maintainFanout({...request,retainBatches:512}),/FANOUT_MAINTENANCE_CAPACITY/);
    assert.equal(existsSync(request.targetDirectory),false);assert.deepEqual(f.authority.inspect(f.config.vaultId)!.head,next);
    assert.throws(()=>AnchoredVault.maintainFanout(request),/FANOUT_RETENTION_BLOCKED/);
    const selected={...request,resetConsumerIds:['检索 consumer']};const receipt=AnchoredVault.maintainFanout(selected);
    assert.equal(receipt.kind,'fanout-maintenance');assert.equal(receipt.maintenance!.floor,504);assert.deepEqual(receipt.maintenance!.resetConsumerIds,['scene:refs','检索 consumer']);
    assert.deepEqual(AnchoredVault.maintainFanout(selected),receipt);assert.throws(()=>AnchoredVault.maintainFanout({...selected,resetConsumerIds:[]}),/ANCHOR_OPERATION_CONFLICT/);
    assert.equal(sha(readFileSync(sourceFile)),sourceHash);
    const v=AnchoredVault.open({...f.config,directory:request.targetDirectory},4,f.options);t.after(()=>v.close());
    assert.equal(v.store.consumerStatus('检索 consumer').status,'reset_required');assert.equal(v.store.invalidationJournal().length,9);
    const h=v.store.resumeConsumer('检索 consumer',v.store.scope(scope.id));assert.deepEqual(v.store.readConsumer(h).refs,[]);
  }finally{db.close();}
});

test('collector and image inspector use the same normalized metadata byte budget near the projection limit',t=>{
  const legacy=new MemoryStore(':memory:',{clock:{wall:()=>100,monotonic:()=>0}}),scope=legacy.ensureScope(who),db=snapshotDB(legacy);legacy.close();
  try{
    const insert=db.prepare("INSERT INTO nodes(id,scope_id,type,revision,generation,consent_revision,status,body,created_at,projection_visible) VALUES (?,?,?,1,0,0,'active',?,100,1)");
    db.exec('BEGIN');
    const roots=Array.from({length:64},(_,i)=>`synthetic-\"quoted-root-${String(i).padStart(3,'0')}-abcdefghijklmnop`);
    for(const id of roots)insert.run(id,scope.id,'event',JSON.stringify(input().evidence));
    for(let i=0;i<210;i++){
      const id=`memory-${String(i).padStart(3,'0')}`;insert.run(id,scope.id,'memory',JSON.stringify(proposal));
      for(const parent of i===0?roots:[`memory-${String(i-1).padStart(3,'0')}`])db.prepare('INSERT INTO dependencies VALUES (?,?,1)').run(id,parent);
      db.prepare('INSERT INTO memory_fts(node_id,statement) VALUES (?,?)').run(id,proposal.statement);
    }
    db.exec('COMMIT');
    const image=migrateMemoryImage(db.serialize(),1,2,100),s=new MemoryStore(':memory:',{schemaVersion:2,image,clock:{wall:()=>100,monotonic:()=>0}});t.after(()=>s.close());
    const h=s.registerConsumer('near-limit',s.scope(scope.id),'scene-source-refs-v1'),refs=s.readConsumer(h).refs,bytes=Buffer.byteLength(JSON.stringify(refs));
    assert.ok(bytes>900000&&bytes<=FANOUT_LIMITS.projectionBytes,`${bytes}`);assert.equal(inspectMemoryImage(s.snapshot(),2).schema,2);
  }finally{db.close();}
});

test('maintenance pending receipt reconciles explicit Unicode/colon consumer resets and validates source watermarks before activation',t=>{
  const f=anchored(t),scope=f.v.store.ensureScope(who);f.v.store.registerConsumer('检索:consumer',scope,'retrieval-refs-v1',true);f.v.store.acceptEvent(scope,input());
  const request={authority:f.authority,vaultId:f.config.vaultId,keys:f.config.keys,maxCalls:4,targetDirectory:join(f.root,'maintenance'),storageDomain:'payload',operationId:'maintain-pending',retainBatches:0,resetConsumerIds:['检索:consumer']};
  assert.throws(()=>AnchoredVault.maintainFanout({...request,fault:p=>{if(p==='prepared')throw new Error('SYNTHETIC_MAINTENANCE_FAULT');}}),/SYNTHETIC_MAINTENANCE_FAULT/);
  const receipt=AnchoredVault.reconcile({authority:f.authority,vaultId:f.config.vaultId,operationId:request.operationId,keys:f.config.keys,maxCalls:4});
  assert.deepEqual(receipt.maintenance!.resetConsumerIds,['检索:consumer']);assert.deepEqual(AnchoredVault.maintainFanout(request),receipt);
  const v=AnchoredVault.open({...f.config,directory:request.targetDirectory},4,f.options);t.after(()=>v.close());assert.equal(v.store.consumerStatus('检索:consumer').status,'reset_required');
});

test('maintenance refuses an authenticated current checkpoint whose declared highwater disagrees with its image',t=>{
  const f=anchored(t);f.v.store.ensureScope(who);const image=f.v.store.snapshot(),next=installSyntheticImage(f,image,1);
  assert.throws(()=>AnchoredVault.maintainFanout({authority:f.authority,vaultId:f.config.vaultId,keys:f.config.keys,maxCalls:4,targetDirectory:join(f.root,'bad-target'),storageDomain:'payload',operationId:'bad-maintenance',retainBatches:0,resetConsumerIds:[]}),/ANCHOR_CORRUPT/);
  assert.deepEqual(f.authority.inspect(f.config.vaultId)!.head,next);
});

test('bounded full-image fanout cost fixture reports real source/consumer commits, ciphertext growth and latency',t=>{
  const f=anchored(t),scope=f.v.store.ensureScope(who),a=f.v.store.registerConsumer('a',scope,'retrieval-refs-v1'),b=f.v.store.registerConsumer('b',scope,'scene-source-refs-v1');
  const initial=f.v.head.sequence,start=f.v.head.sequence,sourceMs:number[]=[],consumerMs:number[]=[];let sourceCommits=0,consumerCommits=0;
  const inventory=()=>readdirSync(f.config.directory).map(name=>({name,bytes:statSync(join(f.config.directory,name)).size}));
  const initialFiles=inventory(),initialLocalBytes=initialFiles.reduce((n,file)=>n+file.bytes,0),initialCipherBytes=initialFiles.filter(file=>/^(checkpoint|record)-/.test(file.name)).reduce((n,file)=>n+file.bytes,0);
  for(let i=0;i<8;i++){
    let head=f.v.head.sequence,now=performance.now();const e=f.v.store.acceptEvent(scope,input(`cost-${i}`));publish(f.v.store,scope,[e]);sourceMs.push(performance.now()-now);sourceCommits+=f.v.head.sequence-head;
    head=f.v.head.sequence;now=performance.now();f.v.store.applyConsumers([a,b]);consumerMs.push(performance.now()-now);consumerCommits+=f.v.head.sequence-head;
  }
  const beforePoll=f.v.head.sequence;for(let i=0;i<3;i++){f.v.store.applyConsumers([a,b]);f.v.store.readConsumer(a);f.v.store.sweepConsumers();}assert.equal(f.v.head.sequence,beforePoll);
  assert.equal(sourceCommits,40);assert.equal(consumerCommits,8);assert.equal(f.v.head.sequence-start,48);
  const files=inventory();
  const checkpoints=files.filter(file=>file.name.startsWith('checkpoint-'));
  const peakCheckpointBytes=Math.max(...checkpoints.map(file=>file.bytes)),peakLocalBytes=files.reduce((n,file)=>n+file.bytes,0);
  t.diagnostic(JSON.stringify({fixture:'8 synthetic events + 2 metadata consumers',node:process.version,initialCommits:initial,sourceCommits,consumerCommits,
    sourceBatches:f.v.store.invalidationJournal().length,noChangePollCommits:0,peakCheckpointBytes,peakLocalBytes,
    ciphertextCheckpointRecordGrowthBytes:files.filter(file=>/^(checkpoint|record)-/.test(file.name)).reduce((n,file)=>n+file.bytes,0)-initialCipherBytes,
    localDirectoryGrowthBytes:peakLocalBytes-initialLocalBytes,
    sourcePipelineMs:{mean:sourceMs.reduce((a,b)=>a+b,0)/sourceMs.length,max:Math.max(...sourceMs)},consumerGroupMs:{mean:consumerMs.reduce((a,b)=>a+b,0)/consumerMs.length,max:Math.max(...consumerMs)}}));
});
