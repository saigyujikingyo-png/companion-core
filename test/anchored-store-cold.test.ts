import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {randomBytes,createCipheriv} from 'node:crypto';
import {mkdtempSync,realpathSync,readFileSync,readdirSync,existsSync,writeFileSync,renameSync,cpSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AnchoredVault} from '../src/anchored-vault.ts';
import type {AnchoredConfig,CompactRequest,AnchoredFault} from '../src/anchored-vault.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {generateKeySet,identityOf,writeNew} from '../src/anchored-codec.ts';
import type {StorageProfile,VaultHead,KeySet} from '../src/anchored-codec.ts';
import {reconstruct,directoryReader,freezeFrame} from '../src/incremental-storage.ts';
import {COLD_SAFETY_PROFILE,canonicalSafetyJSON} from '../src/safety-format.ts';
import {STORE_COLD_PROFILE} from '../src/store-cold-format.ts';
import {storeLogicalFingerprint} from '../src/store-cold.ts';
import {sha,MAX_IMAGE} from '../src/durable-codec.ts';
import {chainLimit,MAX_REPLAY_BYTES} from '../src/incremental-codec.ts';
import {DurableMemory} from '../src/durable-memory.ts';
import {inspectLegacyM2} from '../src/legacy-m2-import.ts';
import {encodeHotSafetyCarrier} from '../src/safety-carrier.ts';
import {MemoryStore} from '../src/store.ts';
import {DatabaseSync} from 'node:sqlite';
const clock={wall:()=>100,monotonic:()=>0};
const who={tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test'};
const input=(eventKey:string)=>({source:'synthetic',eventKey,evidence:{speakerId:'subject',speakerRole:'subject' as const,mode:'self_report' as const,selectedText:`Synthetic event ${eventKey}`,occurredAt:null}});
function fixture(t:TestContext,schema:1|2=2,profile:StorageProfile=COLD_SAFETY_PROFILE){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'if12-'))),authority=LocalSqliteAuthority.create({directory:join(root,'authority'),authorityId:'a',custodyDomain:'independent'});
  const config:AnchoredConfig={directory:join(root,'vault'),vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:profile,schemaVersion:schema,keys:generateKeySet(),authority};
  const v=AnchoredVault.create(config,4,{clock}),opened=[v];t.after(()=>{for(const item of opened)item.close();authority.close();});
  const open=(head:VaultHead,keys=config.keys)=>{const item=AnchoredVault.open({...config,directory:head.directory,storageProfile:head.storageProfile!,schemaVersion:head.schemaVersion??1,keys},4,{clock});opened.push(item);return item;};
  return{root,authority,config,v,open};
}
const req=(f:ReturnType<typeof fixture>,operationId:string):CompactRequest=>({authority:f.authority,vaultId:'v',keys:f.config.keys,maxCalls:4,targetDirectory:join(f.root,operationId),storageDomain:'payload',operationId});
const hashes=(path:string)=>readdirSync(path).sort().map(name=>[name,sha(readFileSync(join(path,name)))]);
function snapshot(head:VaultHead,keys:KeySet){const d=reconstruct(head,directoryReader(head.directory),keys,4);try{return{fingerprint:storeLogicalFingerprint(d.image,head.schemaVersion??1),safety:canonicalSafetyJSON(d.state.safety),highWater:d.state.revocationHighWater,
  full:d.image.length,hot:d.baseline.image.length,files:d.files.size,depth:d.baseline.depth,decodedBytes:d.baseline.decodedBytes};}finally{d.image.fill(0);d.baseline.image.fill(0);d.ledger.close();d.storeCold?.close();}}
function history(v:AnchoredVault){let scope=v.store.ensureScope(who);const event=v.store.acceptEvent(scope,input('old')),job=v.store.beginJob(scope,[event]),lease=v.store.claimLease(scope,job.id);
  v.store.propose(scope,job.id,lease.token,{kind:'claim',statement:'Synthetic historical memory',basis:'self_report',validFrom:null,validTo:null});const memory=v.store.publish(scope,job.id,lease.token);
  scope=v.store.purge(scope);return{scope,event,memory,job,lease};}
function safety(v:AnchoredVault){v.claim('unknown','payload');v.reserve('unknown');v.terminal('unknown','unknown');v.claim('ack','payload');v.reserve('ack');v.terminal('ack','ready','delivery');v.terminal('ack','taken','delivery');v.terminal('ack','acknowledged','delivery');v.consumeFeedback('delivery');}

for(const schema of [1,2] as const)test(`P4 -> P5 schema${schema} exact graph, no source writes, old keys and mutable hot rows`,t=>{
  const f=fixture(t,schema),h=history(f.v);safety(f.v);const before=snapshot(f.v.head,f.config.keys),source=hashes(f.config.directory),r=req(f,'archive');
  const a=AnchoredVault.archiveStoreTerminals(r);assert.equal(a.newHead.storageProfile,STORE_COLD_PROFILE);assert.equal(a.newHead.storeCold!.counts.nodes,2);assert.equal(a.newHead.storeCold!.counts.dependencies,1);
  const after=snapshot(a.newHead,f.config.keys);assert.equal(after.fingerprint,before.fingerprint);assert.equal(after.safety,before.safety);assert.equal(after.highWater,before.highWater);assert.deepEqual(hashes(f.config.directory),source);
  assert.throws(()=>f.v.status,/ANCHOR_FENCED/);f.v.close();const v=f.open(a.newHead),scope=v.store.scope(h.scope.id);
  assert.equal(v.store.acceptEvent(scope,input('old')).currentStatus,'revoked');assert.throws(()=>v.store.acceptEvent(scope,{...input('old'),evidence:{...input('old').evidence,selectedText:'conflict'}}),/IDEMPOTENCY_CONFLICT/);
  assert.throws(()=>v.claim('unknown','payload'),/INTERACTION_TERMINATED/);assert.throws(()=>v.claim('unknown','other'),/INTERACTION_IDEMPOTENCY_CONFLICT/);assert.throws(()=>v.consumeFeedback('delivery'),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
  const consent=v.store.setLearningConsent(scope,true);if(schema===1)for(const change of v.store.projectionBatch(consent))v.store.acknowledgeProjection(consent,change);
  assert.equal(v.reserved,2);assert.deepEqual(AnchoredVault.archiveStoreTerminals(r),a);assert.throws(()=>AnchoredVault.compact(r),/ANCHOR_OPERATION_CONFLICT/);
});
test('both cold roots survive normal writes, early bases and consumer rebind without archive prerequisites',t=>{
  const f=fixture(t),scope=f.v.store.ensureScope(who),consumer=f.v.store.registerConsumer('scene',scope,'scene-source-refs-v1');history(f.v);safety(f.v);
  const sa=AnchoredVault.archiveTerminalSafety(req(f,'safety')),a=AnchoredVault.archiveStoreTerminals(req(f,'store'));f.v.close();assert.ok(sa.newHead.safetyCold);assert.ok(a.newHead.safetyCold);
  const v=f.open(a.newHead),cold=hashes(a.newHead.directory).filter(([name])=>String(name).startsWith('store-')||String(name).startsWith('safety-'));
  assert.throws(()=>v.store.readConsumer(consumer),/FANOUT_/);const current=v.store.scope(scope.id),handle=v.store.resumeConsumer('scene',current);
  for(let i=0;i<16;i++)v.store.acceptEvent(current,input(`new-${i}`));v.store.applyConsumers([handle]);assert.equal(v.store.readConsumer(handle).refs.length,0);
  assert.deepEqual(hashes(a.newHead.directory).filter(([name])=>String(name).startsWith('store-')||String(name).startsWith('safety-')),cold);
  const state=snapshot(v.head,f.config.keys);assert.ok(state.depth<=14);assert.ok(state.files<=30);assert.ok(state.decodedBytes>=MAX_IMAGE+a.newHead.storeCold!.plainBytes+a.newHead.safetyCold!.plainBytes);
  const c=AnchoredVault.inspectCapacity({authority:f.authority,vaultId:'v',keys:f.config.keys,maxCalls:4});assert.equal(c.status,'ACTIVE');if(c.status==='ACTIVE'){assert.equal(c.generation.requiredChain.frameLimit,14);assert.equal(c.image.rows.nodes,18);assert.equal(c.image.fanout.applicable,true);}
});
test('create and explicit upgrade permit empty P5; no generation refuses before target or receipt',t=>{
  const f=fixture(t,1,STORE_COLD_PROFILE);assert.equal(f.v.head.storeCold,null);f.v.close();const reopened=f.open(f.authority.inspect('v')!.head!);assert.equal(reopened.head.storeCold,null);
  const r=req(f,'empty');assert.throws(()=>AnchoredVault.archiveStoreTerminals(r),/STORE_ARCHIVE_NO_GENERATION/);assert.equal(existsSync(r.targetDirectory),false);assert.equal(f.authority.transaction(tx=>tx.receipt('v','empty')),null);
  assert.equal(chainLimit(STORE_COLD_PROFILE),14);assert.equal(chainLimit(COLD_SAFETY_PROFILE),15);
});
test('backup -> rekey -> fresh backup -> restore preserves complete graph and both independent cold segments',t=>{
  const f=fixture(t);history(f.v);safety(f.v);AnchoredVault.archiveTerminalSafety(req(f,'safety'));const a=AnchoredVault.archiveStoreTerminals(req(f,'store'));f.v.close();let v=f.open(a.newHead);
  const b1=join(f.root,'backup1');v.exportBackup(b1);const before=snapshot(v.head,f.config.keys),r={...req(f,'rekey'),backupDirectory:b1,newStorageDEK:randomBytes(32)},rekey=AnchoredVault.rekeyBackup(r);assert.deepEqual(AnchoredVault.rekeyBackup(r),rekey);v.close();
  const keys={...f.config.keys,keyEpoch:2,storageDEK:r.newStorageDEK};v=f.open(rekey.newHead,keys);assert.equal(v.reserved,2);assert.throws(()=>v.claim('unknown','payload'),/INTERACTION_TERMINATED/);
  const b2=join(f.root,'backup2');v.exportBackup(b2);const fresh=snapshot(v.head,keys),restored=AnchoredVault.restoreBackup({...req(f,'restore'),keys,backupDirectory:b2});v.close();
  assert.equal(snapshot(restored.newHead,keys).fingerprint,fresh.fingerprint);assert.equal(snapshot(restored.newHead,keys).highWater,before.highWater);
  assert.notEqual(restored.newHead.storeCold!.cipherDigest,rekey.newHead.storeCold!.cipherDigest);assert.notEqual(restored.newHead.safetyCold!.cipherDigest,rekey.newHead.safetyCold!.cipherDigest);
  assert.throws(()=>AnchoredVault.restoreBackup({...req(f,'old-backup'),backupDirectory:b1}),/ANCHOR_FENCED/);v=f.open(restored.newHead,keys);assert.equal(v.reserved,2);
});
for(const operation of ['compact','fanout','migrate'] as const)test(`${operation} rebuilds cold context and keeps exact logical data`,t=>{
  const f=fixture(t,operation==='migrate'?1:2);history(f.v);const a=AnchoredVault.archiveStoreTerminals(req(f,'store'));f.v.close();const before=snapshot(a.newHead,f.config.keys);
  let next:VaultHead;
  if(operation==='compact')next=AnchoredVault.compact(req(f,'compact')).newHead;
  else if(operation==='fanout')next=AnchoredVault.maintainFanout({...req(f,'fanout'),retainBatches:1,resetConsumerIds:[]}).newHead;
  else{const v=f.open(a.newHead),backupDirectory=join(f.root,'backup');v.exportBackup(backupDirectory);v.close();next=AnchoredVault.migrateBackup({...req(f,'migrate'),backupDirectory,targetSchema:2}).newHead;}
  assert.notEqual(next.storeCold!.cipherDigest,a.newHead.storeCold!.cipherDigest);assert.equal(next.storeCold!.counts.nodes,2);assert.equal(snapshot(next,f.config.keys).highWater,before.highWater);
  if(operation==='compact')assert.equal(snapshot(next,f.config.keys).fingerprint,before.fingerprint);f.open(next);
});
for(const mode of ['missing','tampered'] as const)test(`current Store cold ${mode} rejects reads, no-ops, writes and export`,t=>{
  const f=fixture(t);history(f.v);const a=AnchoredVault.archiveStoreTerminals(req(f,'store'));f.v.close();const v=f.open(a.newHead),head=v.head,path=join(head.directory,head.storeCold!.file),saved=readFileSync(path);
  writeFileSync(path+'.original',saved,{flag:'wx'});if(mode==='missing')renameSync(path,path+'.retained');else writeFileSync(path,Buffer.alloc(saved.length));
  for(const body of [()=>v.status,()=>v.store.ensureScope(who),()=>v.claim('x','p'),()=>v.exportBackup(join(f.root,'bad'))])assert.throws(body);assert.deepEqual(f.authority.inspect('v')!.head,head);
});
test('backup exact file set rejects unlisted, missing and changed cold data',t=>{
  const f=fixture(t);history(f.v);const a=AnchoredVault.archiveStoreTerminals(req(f,'store'));f.v.close();const v=f.open(a.newHead),original=join(f.root,'backup');v.exportBackup(original);assert.ok(readdirSync(original).length<=32);
  for(const mode of ['extra','missing','changed']){const copy=join(f.root,mode);cpSync(original,copy,{recursive:true});const file=join(copy,a.newHead.storeCold!.file);
    if(mode==='extra')writeFileSync(join(copy,'unlisted.bin'),'synthetic');else if(mode==='missing')renameSync(file,file+'.retained');else writeFileSync(file,'bad');
    assert.throws(()=>AnchoredVault.verifyBackup({backupDirectory:copy,authority:f.authority,keys:f.config.keys,maxCalls:4}));}
});
for(const point of ['store-cold-written','prepared','record-published'] as AnchoredFault[])test(`${point} fault retains source and exact reconciliation rules`,t=>{
  const f=fixture(t);history(f.v);const before=f.v.head,r=req(f,'fault');assert.throws(()=>AnchoredVault.archiveStoreTerminals({...r,fault:p=>{if(p===point)throw Error('synthetic fault');}}),/synthetic fault/);f.v.close();
  if(point==='store-cold-written'){assert.deepEqual(f.authority.inspect('v')!.head,before);assert.throws(()=>AnchoredVault.reconcile({authority:f.authority,vaultId:'v',operationId:'fault',keys:f.config.keys,maxCalls:4}),/ANCHOR_UNRESOLVED/);}
  else{const receipt=AnchoredVault.reconcile({authority:f.authority,vaultId:'v',operationId:'fault',keys:f.config.keys,maxCalls:4});assert.deepEqual(AnchoredVault.archiveStoreTerminals(r),receipt);f.open(receipt.newHead);}
});
test('P5 write/read decoded budget includes full reconstruction and cold data',t=>{
  const f=fixture(t,1,STORE_COLD_PROFILE),d=reconstruct(f.v.head,directoryReader(f.v.head.directory),f.config.keys,4);
  try{const frame=freezeFrame(identityOf(f.v.head),f.v.head.sequence+1,'budget',d.image,d.state.safety,d.state.revocationHighWater,f.config.keys,f.v.head,null,
    {...d.baseline,decodedBytes:MAX_REPLAY_BYTES},undefined,undefined,d.ledger.hotEnvelope());assert.equal(frame.baseline.depth,1);assert.ok(frame.baseline.decodedBytes>=MAX_IMAGE);frame.baseline.image.fill(0);
  }finally{d.image.fill(0);d.baseline.image.fill(0);d.ledger.close();d.storeCold?.close();}
});
test('P4 explicit P5 upgrade preserves all hot and later archive uses the same admitted profile',t=>{
  const f=fixture(t);history(f.v);const before=snapshot(f.v.head,f.config.keys),u=AnchoredVault.upgradeStorage({...req(f,'upgrade'),storageProfile:STORE_COLD_PROFILE});
  assert.equal(u.newHead.storeCold,null);assert.equal(snapshot(u.newHead,f.config.keys).fingerprint,before.fingerprint);f.v.close();
  const a=AnchoredVault.archiveStoreTerminals(req(f,'archive'));assert.ok(a.newHead.storeCold);assert.equal(a.kind,'compaction');f.open(a.newHead);
});
test('P5 repack retains its original no-benefit/runtime refusal and creates no target',t=>{
  const f=fixture(t);history(f.v);const a=AnchoredVault.archiveStoreTerminals(req(f,'archive'));f.v.close();const r=req(f,'repack'),before=hashes(a.newHead.directory);
  assert.throws(()=>AnchoredVault.repackStore(r),/REPACK_NO_BENEFIT|REPACK_RUNTIME/);assert.equal(existsSync(r.targetDirectory),false);assert.deepEqual(hashes(a.newHead.directory),before);
  assert.deepEqual(f.authority.inspect('v')!.head,a.newHead);assert.equal(f.authority.transaction(tx=>tx.receipt('v','repack')),null);
});
test('P5 legacy import remains closed, then preserves lineage through Store archive',t=>{
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'if12-legacy-'))),source=join(root,'legacy');mkdirSync(source);const legacyKey=randomBytes(32),legacy=new DurableMemory({directory:source,identity:'synthetic',keyBase64:legacyKey.toString('base64')},4,{clock});
  t.after(()=>legacy.close());const scope=legacy.store.ensureScope(who);legacy.store.acceptEvent(scope,input('old'));legacy.store.purge(scope);legacy.claim('old','p');legacy.reserve('old');legacy.terminal('old','unknown');
  const backup=join(root,'m2-backup');legacy.exportBackup(backup);const ac={directory:join(root,'authority'),authorityId:'a',custodyDomain:'independent'};LocalSqliteAuthority.create(ac).close();LocalSqliteAuthority.upgradeSchema(ac,'operator-attested-stopped');const authority=LocalSqliteAuthority.open(ac);t.after(()=>authority.close());
  const inspect={backupDirectory:backup,legacyKey,identity:'synthetic',expectedMaxCalls:4,declaredHead:legacy.head,trust:{policy:'trusted-lower-bound' as const,minimumHead:legacy.head}},checked=inspectLegacyM2(inspect),storageDEK=randomBytes(32);
  const imported=AnchoredVault.importLegacyM2({...inspect,sourceFreeze:checked.sourceFreeze,authority,vaultId:'v',targetDirectory:join(root,'imported'),storageDomain:'payload',storageProfile:STORE_COLD_PROFILE,newStorageDEK:storageDEK,operationId:checked.migrationId,targetSchema:2});
  assert.equal(imported.newHead.storeCold,null);const keys={version:2 as const,keyEpoch:1,storageDEK,ingressKey:legacyKey},config={directory:imported.newHead.directory,vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:STORE_COLD_PROFILE,schemaVersion:2 as const,authority,keys};
  let v=AnchoredVault.open(config,4,{clock});t.after(()=>v.close());assert.throws(()=>v.claim('new','p'),/LEGACY_ADMISSION_REQUIRED/);
  authority.admitLegacyImport({migrationId:checked.migrationId,head:v.head,operationId:'admit',operatorId:'synthetic',attestation:'operator-attested-stopped'});
  const a=AnchoredVault.archiveStoreTerminals({authority,keys,vaultId:'v',maxCalls:4,targetDirectory:join(root,'archive'),storageDomain:'payload',operationId:'archive'});v.close();v=AnchoredVault.open({...config,directory:a.newHead.directory},4,{clock});
  assert.equal(v.reserved,1);assert.throws(()=>v.claim('old','p'),/INTERACTION_TERMINATED/);assert.equal(v.store.acceptEvent(v.store.scope(scope.id),input('old')).currentStatus,'revoked');assert.ok(v.head.legacyImport);
});
test('P5 reconstruction reserve rejects 48 MiB malformed replay before any block decoding',t=>{
  const f=fixture(t,1,STORE_COLD_PROFILE),d=reconstruct(f.v.head,directoryReader(f.v.head.directory),f.config.keys,4),id=identityOf(f.v.head),files=new Map<string,Buffer>();
  try{const carrier=encodeHotSafetyCarrier(d.ledger.hotEnvelope()),fingerprint=storeLogicalFingerprint(d.image,1);let head:VaultHead|null=null;
    const encrypt=(plain:Buffer,purpose:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',f.config.keys.storageDEK,iv);c.setAAD(Buffer.from(JSON.stringify([id.format,purpose,id])));const body=Buffer.concat([c.update(plain),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);};
    for(let sequence=1;sequence<=4;sequence++){
      const header=Buffer.from(JSON.stringify({version:3,identity:id,sequence,safety:carrier,revocationHighWater:0,ingressKeyDigest:sha(f.config.keys.ingressKey),depth:sequence,logicalFingerprint:fingerprint,
        blocks:{mode:sequence===1?'base':'replace',codec:'br4',rawLength:12*1024*1024,targetLength:(sequence===1?12:16)*1024*1024,targetHash:sha('invalid'),baseHash:sequence===1?null:sha('invalid'),blockSize:4096}})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);
      const blob=encrypt(Buffer.concat([prefix,header,Buffer.from([1])]),'frame'),row=encrypt(Buffer.from(JSON.stringify({version:3,identity:id,sequence,operationId:`budget-${sequence}`,previous:head?.digest??null,previousHead:head,parentHead:null,checkpointDigest:sha(blob),revocationHighWater:0,logicalFingerprint:fingerprint})),'record');
      head={...id,sequence,digest:sha(row)};files.set(`blob-${sha(blob)}.bin`,blob);files.set(`record-${sequence}.bin`,row);
    }
    assert.throws(()=>reconstruct(head!,name=>files.get(name)!,f.config.keys,4),/INCREMENTAL_REPLAY_LIMIT/);
  }finally{d.image.fill(0);d.baseline.image.fill(0);d.ledger.close();for(const value of files.values())value.fill(0);}
});
test('3000 public RAM events refuse oversized cold allocation before serialize and preserve current mandatory cold',t=>{
  const f=fixture(t,1),scope=f.v.store.ensureScope(who);f.v.store.acceptEvent(scope,input('mandatory-old'));f.v.store.purge(scope);
  const archived=AnchoredVault.archiveStoreTerminals(req(f,'initial-cold'));f.v.close();const d=reconstruct(archived.newHead,directoryReader(archived.newHead.directory),f.config.keys,4);
  let source:Uint8Array|undefined;
  try{
    const store=new MemoryStore(':memory:',{image:d.image,schemaVersion:1,clock});
    try{const current=store.scope(scope.id);for(let i=0;i<3000;i++)store.acceptEvent(current,input(`overflow-${i}`));store.purge(current);source=store.snapshot();}finally{store.close();}
    assert.ok(source.length<MAX_IMAGE);const fingerprint=storeLogicalFingerprint(source,1),old=archived.newHead;
    // Publish this bounded public-RAM history once as a synthetic authenticated
    // current fixture; no 3000-commit disk experiment is hidden in this regression.
    const frozen=freezeFrame(identityOf(old),old.sequence+1,'synthetic-current',source,d.state.safety,2,f.config.keys,old,null,null,undefined,undefined,d.ledger.hotEnvelope(),d.storeCold),stagePath=join(old.directory,'stage-synthetic-current.json');
    writeNew(join(old.directory,frozen.stage.blob),frozen.blob);writeNew(stagePath,frozen.bytes);
    const pending={version:2 as const,kind:'write' as const,operationId:'synthetic-current',requestDigest:sha(frozen.bytes),oldHead:old,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes)};
    f.authority.transaction(tx=>{tx.prepare(pending);writeNew(join(old.directory,`record-${frozen.stage.head.sequence}.bin`),Buffer.from(frozen.stage.record,'base64'));tx.finalize(pending);});frozen.baseline.image.fill(0);
    const current=frozen.stage.head,before=hashes(current.directory),coldHash=sha(readFileSync(join(current.directory,current.storeCold!.file))),r=req(f,'overflow-cold');
    const serialize=DatabaseSync.prototype.serialize,exec=DatabaseSync.prototype.exec;let coldSerializations=0,capped=0;
    DatabaseSync.prototype.serialize=function(...args){const size=this.prepare('PRAGMA page_size').get()!.page_size as number,pages=this.prepare('PRAGMA page_count').get()!.page_count as number,
      cold=this.prepare('PRAGMA application_id').get()!.application_id===0x41454d54;
      assert.ok(size*pages<=(cold?1024*1024:MAX_IMAGE),'serialize must never see an oversized target');if(cold)coldSerializations++;return serialize.apply(this,args);};
    DatabaseSync.prototype.exec=function(sql){if(sql==='PRAGMA max_page_count=256')capped++;return exec.call(this,sql);};
    try{assert.throws(()=>AnchoredVault.archiveStoreTerminals(r),/STORE_COLD_LIMIT/);assert.equal(coldSerializations,0);assert.ok(capped>=1);}
    finally{DatabaseSync.prototype.serialize=serialize;DatabaseSync.prototype.exec=exec;}
    assert.equal(existsSync(r.targetDirectory),false);assert.deepEqual(f.authority.inspect('v')!.head,current);assert.equal(f.authority.transaction(tx=>tx.receipt('v',r.operationId)),null);
    assert.deepEqual(hashes(current.directory),before);assert.equal(sha(readFileSync(join(current.directory,current.storeCold!.file))),coldHash);assert.equal(storeLogicalFingerprint(source,1),fingerprint);
    assert.equal(snapshot(current,f.config.keys).fingerprint,fingerprint);
    t.diagnostic(JSON.stringify({publicRAMEvents:3000,sourceBytes:source.length,coldMaxPages:256,coldSerializeCallsBeforeRefusal:coldSerializations,currentUnchanged:true,mandatoryColdUnchanged:true,targetCreated:false,receiptConsumed:false}));
  }finally{source?.fill(0);d.image.fill(0);d.baseline.image.fill(0);d.ledger.close();d.storeCold?.close();}
});
