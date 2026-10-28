import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {createCipheriv,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,readFileSync,readdirSync,existsSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {brotliCompressSync} from 'node:zlib';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { freezeFrame,directoryReader,reconstruct,parseFrozenV3 } from '../src/incremental-storage.ts';
import { INCREMENTAL_FORMAT, generateKeySet,identityOf } from '../src/anchored-codec.ts';
import type {VaultIdentity,VaultHead,StorageProfile} from '../src/anchored-codec.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {MemoryStore} from '../src/store.ts';
import {configureRepackRuntime,fingerprintMemoryDatabase,repackMemoryImage,inspectMemoryImage} from '../src/memory-image.ts';
import {encodeSafetyCarrier,decodeSafetyCarrier,validateSafetyCarrier,PACKED_SAFETY_PROFILE,MAX_SAFETY_BYTES} from '../src/safety-carrier.ts';
import type {SafetyCarrier} from '../src/safety-carrier.ts';
import {MAX_IMAGE,sha} from '../src/durable-codec.ts';
import type {Safety,Terminal} from '../src/durable-codec.ts';
import {MAX_PATCH,MAX_REPLAY_BYTES} from '../src/incremental-codec.ts';
import {DurableMemory} from '../src/durable-memory.ts';
import {inspectLegacyM2} from '../src/legacy-m2-import.ts';

const clock={wall:()=>100,monotonic:()=>0},who={tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test'};
const input=(key:string,body='Synthetic violet memory')=>({source:'synthetic',eventKey:key,evidence:{speakerId:'subject',speakerRole:'subject' as const,
  mode:'self_report' as const,selectedText:body,occurredAt:null}});
const identity:VaultIdentity={format:INCREMENTAL_FORMAT,authorityId:'a',vaultId:'v',identity:'synthetic',instanceId:'i',ownerEpoch:1,keyEpoch:1,
  directory:resolve('synthetic'),storageDomain:'payload',storageProfile:PACKED_SAFETY_PROFILE};
const emptySafety=():Safety=>({version:1,identity:'synthetic',maxCalls:4,reserved:0,ingress:[],lastSourceRef:null,lastAcknowledgedDeliveryId:null,lastWall:0});
function database<T>(image:Uint8Array,body:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(':memory:');try{db.deserialize(image);return body(db);}finally{db.close();}}
const fingerprint=(image:Uint8Array,schema:1|2)=>database(image,db=>fingerprintMemoryDatabase(db,schema));
const pages=(image:Uint8Array)=>database(image,db=>({bytes:image.length,pages:db.prepare('PRAGMA page_count').get()!.page_count,free:db.prepare('PRAGMA freelist_count').get()!.freelist_count}));
const files=(path:string)=>readdirSync(path).sort().map(name=>[name,sha(readFileSync(join(path,name)))]);
function fixture(t:TestContext,schemaVersion:1|2=2,storageProfile:StorageProfile='blocks-br4-v1'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'if9-'))),authorityConfig={directory:join(root,'a'),authorityId:'a',custodyDomain:'independent'},authority=LocalSqliteAuthority.create(authorityConfig);
  const config={directory:join(root,'v'),vaultId:'v',identity:'synthetic',storageDomain:'payload',schemaVersion,storageProfile,keys:generateKeySet(),authority};
  const v=AnchoredVault.create(config,4,{clock});t.after(()=>{v.close();authority.close();});return{root,authorityConfig,authority,config,v};
}
function fillAndRevoke(store:MemoryStore,count=12){
  let scope=store.ensureScope(who);const first=input('old-0','x'.repeat(4000)),refs=[];
  for(let i=0;i<count;i++)refs.push(store.acceptEvent(scope,i===0?first:input(`old-${i}`,'x'.repeat(4000))));
  const job=store.beginJob(scope,[refs[0]!]),lease=store.claimLease(scope,job.id);
  store.propose(scope,job.id,lease.token,{kind:'claim',statement:'violet historical result',basis:'self_report',validFrom:null,validTo:null});store.publish(scope,job.id,lease.token);
  scope=store.purge(scope);
  const current=store.acceptEvent(scope,input('current')),liveJob=store.beginJob(scope,[current]),liveLease=store.claimLease(scope,liveJob.id);
  store.propose(scope,liveJob.id,liveLease.token,{kind:'claim',statement:'violet active result',basis:'self_report',validFrom:null,validTo:null});
  const memory=store.publish(scope,liveJob.id,liveLease.token);
  return{scope,refs,first,current,memory,job,liveJob};
}
const request=(f:ReturnType<typeof fixture>,operationId='repack')=>({authority:f.authority,vaultId:'v',keys:f.config.keys,maxCalls:4,
  targetDirectory:join(f.root,operationId),storageDomain:'payload',operationId});

test('IF9 explicit Store repack API exists',()=>{
  assert.equal(typeof (AnchoredVault as any).repackStore,'function');
});

test('IF9 explicit Safety packed profile writes a bounded frame',()=>{
  const frame=freezeFrame(identity,1,'create',Buffer.alloc(4096),emptySafety(),0,generateKeySet(),null,null,null);
  assert.equal(frame.baseline.depth,1);
});

for(const schema of [1,2] as const)test(`schema${schema} repack preserves every logical value and shrinks ordinary freed pages`,()=>{
  const store=new MemoryStore(':memory:',{schemaVersion:schema,clock});
  try{
    const data=fillAndRevoke(store);
    if(schema===2){store.registerConsumer('scene',data.scope,'scene-source-refs-v1');store.pruneJournal(1);}
    const original=store.snapshot(),hash=sha(original),before=pages(original),logical=fingerprint(original,schema);
    const packed=repackMemoryImage(original,schema,store.revocationHighWater());
    assert.equal(sha(original),hash);assert.ok(packed.length<original.length);assert.equal(fingerprint(packed,schema),logical);
    assert.equal(inspectMemoryImage(packed,schema).revocationHighWater,store.revocationHighWater());
    console.log('STORE_COST',JSON.stringify({schema,history:'public MemoryStore operations',before,after:pages(packed)}));
    const reopened=new MemoryStore(':memory:',{image:packed,schemaVersion:schema,clock});
    try{const scope=reopened.scope(data.scope.id);assert.equal(reopened.acceptEvent(scope,data.first).id,data.refs[0]!.id);
      assert.equal(reopened.acceptEvent(scope,data.first).currentStatus,'revoked');assert.throws(()=>reopened.acceptEvent(scope,input('old-0','different')),/IDEMPOTENCY_CONFLICT/);
      assert.equal(reopened.read(scope,data.refs[0]!),null);assert.equal(reopened.search(scope,'violet').length,1);reopened.acceptEvent(scope,input('after'));}
    finally{reopened.close();}
  }finally{store.close();}
});

test('runtime gate precedes inspection, rejects source/config/file/transaction and admits only configured unnamed RAM',()=>{
  const db=new DatabaseSync(':memory:');try{configureRepackRuntime(db);assert.equal(db.prepare('PRAGMA temp_store').get()!.temp_store,2);
    db.exec('BEGIN');assert.throws(()=>configureRepackRuntime(db),/REPACK_RUNTIME/);db.exec('ROLLBACK');}finally{db.close();}
  for(const change of ['source','version','temp0','missing-temp','fts','filename']){
    let writes=0;const fake={isTransaction:false,exec:()=>{writes++;},prepare:(sql:string)=>({
      get:()=>sql.startsWith('SELECT')?{version:change==='version'?'3.52.0':'3.53.0',source:change==='source'?'unknown':'2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b'}:
        sql.includes('temp_store')?{temp_store:2}:sql.includes('journal_mode')?{journal_mode:'memory'}:{cache_spill:0},
      all:()=>sql.includes('compile_options')?[...(change==='fts'?[]:[{compile_options:'ENABLE_FTS5'}]),...(change==='missing-temp'?[]:[{compile_options:change==='temp0'?'TEMP_STORE=0':'TEMP_STORE=1'}])]:[{name:'main',file:change==='filename'?'file.sqlite':''}]
    })};
    assert.throws(()=>configureRepackRuntime(fake as any),/REPACK_RUNTIME/);assert.equal(writes,change==='filename'?1:0);
  }
});

test('Store no benefit and malformed schema refuse without target or consumed operation; different transform conflicts',t=>{
  const f=fixture(t,1),r=request(f),before=f.v.head;
  assert.throws(()=>AnchoredVault.repackStore(r),/REPACK_NO_BENEFIT/);assert.equal(existsSync(r.targetDirectory),false);assert.deepEqual(f.v.head,before);
  assert.equal(f.authority.transaction(tx=>tx.receipt('v',r.operationId)),null);
  fillAndRevoke(f.v.store,8);const receipt=AnchoredVault.repackStore(r);assert.deepEqual(AnchoredVault.repackStore(r),receipt);
  assert.throws(()=>AnchoredVault.compact(r),/ANCHOR_OPERATION_CONFLICT/);
  const s=new MemoryStore(':memory:',{clock});try{const image=s.snapshot();database(image,db=>{db.exec('CREATE TABLE extra (id INTEGER)');assert.throws(()=>repackMemoryImage(db.serialize(),1),/SCHEMA_MISMATCH/);});}finally{s.close();}
});

test('typed fingerprint catches changed values even when counts/highwater match; mismatch refuses packing',()=>{
  const s=new MemoryStore(':memory:',{clock});try{fillAndRevoke(s,6);const image=s.snapshot(),before=fingerprint(image,1);
    database(image,db=>{db.exec("UPDATE revocations SET reason='changed'");assert.notEqual(fingerprintMemoryDatabase(db,1),before);});
    database(image,db=>{db.exec("INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',0)");assert.notEqual(fingerprintMemoryDatabase(db,1),before);});
    database(image,db=>{db.exec("INSERT INTO meta VALUES ('opaque',CAST(x'FF' AS TEXT))");const first=fingerprintMemoryDatabase(db,1);
      db.exec("UPDATE meta SET value=CAST(x'FE' AS TEXT) WHERE key='opaque'");assert.notEqual(fingerprintMemoryDatabase(db,1),first);});
    const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='VACUUM')exec.call(this,"UPDATE revocations SET recorded_at=101");return result;};
    try{assert.throws(()=>repackMemoryImage(image,1),/REPACK_LOGICAL_MISMATCH/);}finally{DatabaseSync.prototype.exec=exec;}
    assert.equal(fingerprint(image,1),before);
  }finally{s.close();}
});

test('public Store repack retains source, Safety, jobs, ledger and all fanout state; new generation boots and accepts writes',t=>{
  const f=fixture(t),data=fillAndRevoke(f.v.store),handle=f.v.store.registerConsumer('scene',data.scope,'scene-source-refs-v1');f.v.store.pruneJournal(2);
  f.v.claim('pending','p');f.v.reserve('pending');f.v.source(data.current);
  const old=f.v.head,decoded=reconstruct(old,directoryReader(old.directory),f.config.keys,4),before=files(old.directory),r=request(f);
  const receipt=AnchoredVault.repackStore(r),next=reconstruct(receipt.newHead,directoryReader(r.targetDirectory),f.config.keys,4);
  assert.equal(receipt.kind,'compaction');assert.equal(receipt.newHead.sequence,1);assert.equal(receipt.newHead.ownerEpoch,old.ownerEpoch+1);assert.notEqual(receipt.newHead.instanceId,old.instanceId);
  assert.equal(receipt.newHead.keyEpoch,old.keyEpoch);assert.equal(receipt.newHead.storageProfile,old.storageProfile);assert.deepEqual(next.state.safety,decoded.state.safety);
  assert.ok(next.image.length<decoded.image.length);assert.equal(fingerprint(next.image,2),fingerprint(decoded.image,2));assert.deepEqual(files(old.directory),before);
  assert.throws(()=>f.v.store.readConsumer(handle),/ANCHOR_FENCED/);assert.throws(()=>f.v.claim('new','p'),/ANCHOR_FENCED/);f.v.close();
  assert.throws(()=>AnchoredVault.open(f.config,4,{clock}),/ANCHOR_FENCED/);
  const opened=AnchoredVault.open({...f.config,directory:r.targetDirectory},4,{clock});t.after(()=>opened.close());
  assert.equal(opened.status.unknownRequests,1);assert.equal(opened.reserved,1);const scope=opened.store.scope(data.scope.id);
  const resumed=opened.store.resumeConsumer('scene',scope);assert.ok(opened.store.readConsumer(resumed).refs.some(ref=>ref.id===data.current.id));
  assert.equal(opened.store.acceptEvent(scope,data.first).id,data.refs[0]!.id);assert.equal(opened.store.read(scope,data.refs[0]!),null);
  opened.store.acceptEvent(scope,input('new-after-repack'));opened.claim('after','p');opened.reserve('after');assert.equal(opened.reserved,2);
  decoded.image.fill(0);next.image.fill(0);
});

test('Safety carrier preserves all terminal states, scalar fields, Unicode IDs and exact field/array order',()=>{
  const s=emptySafety();s.lastWall=123;s.lastSourceRef={id:'源💾',revision:7};s.lastAcknowledgedDeliveryId='送达-3';s.reserved=4;
  s.ingress=(['pending','ready','taken','acknowledged','failed','unknown'] as Terminal[]).map((state,i)=>({key:randomBytes(32).toString('hex'),fingerprint:randomBytes(32).toString('hex'),
    state,deliveryId:i>=1&&i<=3?`送达-${i}`:null,reserved:i<4,feedbackConsumed:i===3}));
  const packed=encodeSafetyCarrier(s,identity,4),decoded=decodeSafetyCarrier(packed,identity,4);assert.equal(JSON.stringify(decoded),JSON.stringify(s));
  assert.throws(()=>decodeSafetyCarrier(packed,{...identity,identity:'other'},4),/ANCHOR_CORRUPT/);
  assert.throws(()=>decodeSafetyCarrier(packed,identity,3),/ANCHOR_CORRUPT/);
  assert.throws(()=>encodeSafetyCarrier({...s,maxCalls:33},identity,33),/DURABLE_CONFIG/);
});

test('Safety codec chooses by full carrier bytes and rejects bounded corruption without fallback',()=>{
  const s=emptySafety(),valid=encodeSafetyCarrier(s,identity,4),raw=Buffer.from(JSON.stringify(s));
  const br:SafetyCarrier={version:1,codec:'br4',decodedBytes:raw.length,digest:sha(raw),data:brotliCompressSync(raw).toString('base64')};
  assert.deepEqual(decodeSafetyCarrier({...br,codec:'raw',data:s},identity,4),s);
  const cases:any[]=[{...br,extra:1},{...br,version:2},{...br,codec:'zstd'},{...br,decodedBytes:0},{...br,decodedBytes:MAX_SAFETY_BYTES+1},
    {...br,decodedBytes:String(raw.length)},{...br,digest:'0'.repeat(64)},{...br,data:'Zh=='},{...br,data:'not base64'},{...br,data:(br.data as string).slice(4)},
    {...br,data:Buffer.concat([Buffer.from(br.data as string,'base64'),Buffer.from([0])]).toString('base64')},
    {...br,data:Buffer.concat([Buffer.from(br.data as string,'base64'),Buffer.from(br.data as string,'base64')]).toString('base64')},
    {...br,data:brotliCompressSync(Buffer.alloc(100000)).toString('base64')},
    {...br,codec:'raw',data:{...s,reserved:'0'}},
    {...br,data:'A'.repeat(MAX_SAFETY_BYTES)}];
  for(const c of cases)assert.throws(()=>decodeSafetyCarrier(c,identity,4),/SAFETY_CARRIER|ANCHOR_CORRUPT/);
  for(const bytes of [Buffer.from([0xff]),Buffer.from('{bad json'),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),raw])])assert.throws(()=>decodeSafetyCarrier({...br,decodedBytes:bytes.length,digest:sha(bytes),data:brotliCompressSync(bytes).toString('base64')},identity,4),/SAFETY_CARRIER_DECODE/);
  const inline={...valid,codec:'raw',data:s};assert.ok(Buffer.byteLength(JSON.stringify(valid))<=Buffer.byteLength(JSON.stringify(inline)));
});

test('8192 ingress structural stress stays bounded, 8193 refuses, with random fingerprints and separate byte/cost measurements',()=>{
  for(const count of [0,32,512,8192]){
    const s=emptySafety();s.ingress=Array.from({length:count},(_,i)=>({key:randomBytes(32).toString('hex'),fingerprint:randomBytes(32).toString('hex'),state:'unknown' as const,deliveryId:null,feedbackConsumed:false,reserved:i<4}));s.reserved=Math.min(4,count);
    const start=performance.now(),carrier=encodeSafetyCarrier(s,identity,4),encoded=performance.now(),decoded=decodeSafetyCarrier(carrier,identity,4),end=performance.now();
    assert.equal(JSON.stringify(decoded),JSON.stringify(s));const keys=generateKeySet(),frame=freezeFrame(identity,1,'stress',Buffer.alloc(4096),s,0,keys,null,null,null);
    console.log('SAFETY_STRUCTURE_COST',JSON.stringify({count,history:'structure injection, not legal complete API history',rawSafetyBytes:Buffer.byteLength(JSON.stringify(s)),carrierBytes:Buffer.byteLength(JSON.stringify(carrier)),frameBytes:frame.blob.length,manifestBytes:frame.bytes.length,encodeMs:encoded-start,decodeMs:end-encoded,codec:carrier.codec}));
    if(count===8192){s.ingress.push({...s.ingress[0]!,key:randomBytes(32).toString('hex'),reserved:false});assert.throws(()=>encodeSafetyCarrier(s,identity,4),/ANCHOR_CORRUPT/);}
  }
});

test('packed writer accounts Safety decoded bytes and emits an earlier base',()=>{
  const image=Buffer.alloc(4096),s=emptySafety(),keys=generateKeySet(),base=freezeFrame(identity,1,'base',image,s,0,keys,null,null,null),n=Buffer.byteLength(JSON.stringify(s));
  const next=freezeFrame(identity,2,'next',image,s,0,keys,base.stage.head,null,{...base.baseline,decodedBytes:MAX_REPLAY_BYTES-n+1});
  assert.equal(next.baseline.depth,1);assert.equal(next.baseline.decodedBytes,image.length+n);
  const oldIdentity={...identity,storageProfile:'blocks-br4-v1' as const},old=freezeFrame(oldIdentity,1,'old',image,s,0,keys,null,null,null);
  assert.equal(old.baseline.decodedBytes,image.length);
});

test('replay rejects combined cumulative descriptors before expanding the offending Safety stream',()=>{
  const keys=generateKeySet(),map=new Map<string,Buffer>(),s=emptySafety(),carrier=encodeSafetyCarrier(s,identity,4);let previous:VaultHead|null=null;
  const seal=(plain:Buffer,purpose:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',keys.storageDEK,iv);c.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,purpose,identity])));const encrypted=Buffer.concat([c.update(plain),c.final()]);return Buffer.concat([iv,c.getAuthTag(),encrypted]);};
  for(let seq=1;seq<=4;seq++){
    const safety=seq===1?{...carrier,codec:'br4',data:'AAAA'}:carrier;
    const header=Buffer.from(JSON.stringify({version:3,identity,sequence:seq,safety,revocationHighWater:0,ingressKeyDigest:sha(keys.ingressKey),depth:seq,
      blocks:{mode:seq===1?'base':'replace',codec:'br4',rawLength:seq===1?MAX_IMAGE:MAX_PATCH,targetLength:MAX_IMAGE,targetHash:'0'.repeat(64),baseHash:seq===1?null:'0'.repeat(64),blockSize:4096}}));
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);const blob=seal(Buffer.concat([prefix,header,Buffer.from([0])]),'frame'),digest=sha(blob);
    const record=seal(Buffer.from(JSON.stringify({version:3,identity,sequence:seq,operationId:`op-${seq}`,previous:previous?.digest??null,previousHead:previous,parentHead:null,checkpointDigest:digest,revocationHighWater:0})),'record');
    previous={...identity,sequence:seq,digest:sha(record)};map.set(`record-${seq}.bin`,record);map.set(`blob-${digest}.bin`,blob);
  }
  assert.throws(()=>reconstruct(previous!,(name)=>map.get(name)!,keys,4),/INCREMENTAL_REPLAY_LIMIT/);
});

for(const profile of ['blocks-br4-v1','full-br4-v1'] as const)test(`${profile} explicit upgrade preserves real Safety history, then reopen keeps all refusals`,t=>{
  const f=fixture(t,2,profile);f.v.claim('unknown','p');f.v.reserve('unknown');f.v.terminal('unknown','failed');
  f.v.claim('delivered','p');f.v.reserve('delivered');for(const state of ['ready','taken','acknowledged'] as const)f.v.terminal('delivered',state,'送达');f.v.consumeFeedback('送达');
  f.v.claim('pending','p');const old=f.v.head,d=reconstruct(old,directoryReader(old.directory),f.config.keys,4),source=files(old.directory),r={...request(f,'upgrade'),storageProfile:PACKED_SAFETY_PROFILE};
  const receipt=AnchoredVault.upgradeStorage(r);assert.deepEqual(AnchoredVault.upgradeStorage(r),receipt);assert.throws(()=>AnchoredVault.compact(r),/ANCHOR_OPERATION_CONFLICT/);
  const after=reconstruct(receipt.newHead,directoryReader(r.targetDirectory),f.config.keys,4);assert.deepEqual(after.state.safety,d.state.safety);assert.equal(sha(after.image),sha(d.image));assert.deepEqual(files(old.directory),source);
  f.v.close();const v=AnchoredVault.open({...f.config,directory:r.targetDirectory,storageProfile:PACKED_SAFETY_PROFILE},4,{clock});t.after(()=>v.close());
  assert.equal(v.reserved,2);assert.equal(v.status.unknownRequests,2);assert.throws(()=>v.claim('unknown','p'),/INTERACTION_TERMINATED/);assert.throws(()=>v.claim('unknown','different'),/INTERACTION_IDEMPOTENCY_CONFLICT/);
  assert.throws(()=>v.consumeFeedback('送达'),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);v.claim('reuse','p');assert.throws(()=>v.terminal('reuse','ready','送达'),/DURABLE_DELIVERY_CONFLICT/);
  v.reserve('reuse');v.claim('fourth','p');v.reserve('fourth');v.claim('fifth','p');assert.throws(()=>v.reserve('fifth'),/REQUEST_BUDGET_EXHAUSTED/);
  assert.throws(()=>AnchoredVault.upgradeStorage({...request(f,'downgrade'),storageProfile:profile}),/ANCHOR_STORAGE_PROFILE/);
  assert.throws(()=>AnchoredVault.upgradeStorage({...request(f,'same'),storageProfile:PACKED_SAFETY_PROFILE}),/ANCHOR_STORAGE_PROFILE/);
  const backup=join(f.root,'backup');v.exportBackup(backup);assert.deepEqual(AnchoredVault.verifyBackup({backupDirectory:backup,authority:f.authority,keys:f.config.keys,maxCalls:4}).head,v.head);
  const current=reconstruct(v.head,directoryReader(r.targetDirectory),f.config.keys,4);
  console.log('PUBLIC_HISTORY_COST',JSON.stringify({sourceProfile:profile,requests:current.state.safety.ingress.length,reserved:current.state.safety.reserved,
    backupBytes:readdirSync(backup).reduce((n,name)=>n+readFileSync(join(backup,name)).length,0),rawSafetyBytes:Buffer.byteLength(JSON.stringify(current.state.safety)),
    carrierBytes:Buffer.byteLength(JSON.stringify(encodeSafetyCarrier(current.state.safety,identity,4))),headFrameBytes:current.stage.blobLength,requiredChainBytes:current.baseline.readBytes}));current.image.fill(0);
  d.image.fill(0);after.image.fill(0);
});

for(const operation of ['repack','upgrade'] as const)for(const point of ['prepared','record-published','finalized'] as const)test(`actual child ${operation} exit ${point} preserves source and exact retry/reconcile`,t=>{
  const f=fixture(t,1);if(operation==='repack')fillAndRevoke(f.v.store,6);f.v.claim('held','p');f.v.reserve('held');const r=request(f);f.v.close();const source=files(f.config.directory);
  const script=`import {AnchoredVault} from './src/anchored-vault.ts';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';let chunks=[];for await(const c of process.stdin)chunks.push(c);const x=JSON.parse(Buffer.concat(chunks).toString());const authority=LocalSqliteAuthority.open(x.authority),keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')};const request={...x.request,authority,keys,fault:p=>{if(p===x.point)process.exit(42);}};if(x.operation==='repack')AnchoredVault.repackStore(request);else AnchoredVault.upgradeStorage({...request,storageProfile:'blocks-br4-safety-br4-v1'});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,timeout:20000,encoding:'utf8',input:JSON.stringify({authority:f.authorityConfig,operation,point,
    request:{vaultId:'v',maxCalls:4,targetDirectory:r.targetDirectory,storageDomain:'payload',operationId:r.operationId},keys:{version:2,keyEpoch:1,storageDEK:Buffer.from(f.config.keys.storageDEK).toString('base64'),ingressKey:Buffer.from(f.config.keys.ingressKey).toString('base64')}})});
  assert.equal(child.status,42,child.stderr);assert.deepEqual(files(f.config.directory),source);
  const row=f.authority.inspect('v')!;
  if(point!=='finalized'){
    assert.equal(row.status,'PREPARED');assert.throws(()=>operation==='repack'?AnchoredVault.repackStore(r):AnchoredVault.upgradeStorage({...r,storageProfile:PACKED_SAFETY_PROFILE}),/ANCHOR_PENDING/);
    const pending=row.pending!,stage=parseFrozenV3(readFileSync(pending.stagePath)),path=join(r.targetDirectory,stage.blob),original=readFileSync(path);
    renameSync(path,path+'.retained');assert.throws(()=>AnchoredVault.reconcile(r),/ANCHOR_UNRESOLVED/);renameSync(path+'.retained',path);
    writeFileSync(path,Buffer.from('corrupt'));assert.throws(()=>AnchoredVault.reconcile(r),/ANCHOR_UNRESOLVED/);writeFileSync(path,original);
  }
  const reconciled=AnchoredVault.reconcile(r),retried=operation==='repack'?AnchoredVault.repackStore(r):AnchoredVault.upgradeStorage({...r,storageProfile:PACKED_SAFETY_PROFILE});assert.deepEqual(reconciled,retried);
  const d=reconstruct(reconciled.newHead,directoryReader(r.targetDirectory),f.config.keys,4);assert.equal(d.state.safety.ingress[0]!.state,'pending');assert.equal(d.state.safety.reserved,1);d.image.fill(0);
});

test('packed profile backup/restore/rekey/compaction remain self-contained and profile-bound',t=>{
  const f=fixture(t,1,PACKED_SAFETY_PROFILE);f.v.claim('old','p');f.v.reserve('old');f.v.terminal('old','unknown');
  let backup=join(f.root,'b1');f.v.exportBackup(backup);const entries=JSON.parse(readFileSync(join(backup,'current-state.json'),'utf8')).files;
  const dependency=join(backup,entries[0].name);renameSync(dependency,dependency+'.retained');
  assert.throws(()=>AnchoredVault.verifyBackup({backupDirectory:backup,authority:f.authority,keys:f.config.keys,maxCalls:4}));renameSync(dependency+'.retained',dependency);
  const restored=join(f.root,'restored');AnchoredVault.restoreBackup({backupDirectory:backup,...request(f,'restore'),targetDirectory:restored});f.v.close();
  let config={...f.config,directory:restored},v=AnchoredVault.open(config,4,{clock});t.after(()=>v.close());
  assert.equal(v.reserved,1);assert.throws(()=>v.claim('old','p'),/INTERACTION_TERMINATED/);backup=join(f.root,'b2');v.exportBackup(backup);
  const newStorageDEK=randomBytes(32),rekeyed=join(f.root,'rekeyed');const receipt=AnchoredVault.rekeyBackup({backupDirectory:backup,...request(f,'rekey'),targetDirectory:rekeyed,newStorageDEK});v.close();
  assert.equal(receipt.newHead.storageProfile,PACKED_SAFETY_PROFILE);assert.throws(()=>reconstruct(receipt.newHead,directoryReader(rekeyed),{...config.keys,keyEpoch:2},4),/INCREMENTAL_CORRUPT/);
  config={...config,directory:rekeyed,keys:{...config.keys,keyEpoch:2,storageDEK:newStorageDEK}};v=AnchoredVault.open(config,4,{clock});
  const compacted=join(f.root,'compact');const c=AnchoredVault.compact({...request(f,'compact'),keys:config.keys,targetDirectory:compacted});v.close();
  assert.equal(c.newHead.storageProfile,PACKED_SAFETY_PROFILE);v=AnchoredVault.open({...config,directory:compacted},4,{clock});v.claim('new','p');v.reserve('new');assert.equal(v.reserved,2);
  assert.throws(()=>AnchoredVault.open({...config,directory:compacted,storageProfile:'blocks-br4-v1'},4,{clock}),/ANCHOR_IDENTITY/);
});

test('legacy import into packed profile keeps lineage, admission, Safety and backup closure',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'if9-legacy-'))),source=join(root,'legacy');mkdirSync(source);const legacyKey=randomBytes(32);
  const legacy=new DurableMemory({directory:source,identity:'synthetic',keyBase64:legacyKey.toString('base64')},4,{clock});t.after(()=>legacy.close());
  legacy.claim('legacy','p');legacy.reserve('legacy');legacy.terminal('legacy','unknown');const backup=join(root,'old-backup');legacy.exportBackup(backup);
  const authorityConfig={directory:join(root,'a'),authorityId:'a',custodyDomain:'independent'};LocalSqliteAuthority.create(authorityConfig).close();LocalSqliteAuthority.upgradeSchema(authorityConfig,'operator-attested-stopped');
  const authority=LocalSqliteAuthority.open(authorityConfig);t.after(()=>authority.close());const inspect={backupDirectory:backup,legacyKey,identity:'synthetic',expectedMaxCalls:4,declaredHead:legacy.head,trust:{policy:'trusted-lower-bound' as const,minimumHead:legacy.head}};
  const checked=inspectLegacyM2(inspect),newStorageDEK=randomBytes(32),target=join(root,'imported'),original=files(source),originalBackup=files(backup);
  const importRequest={...inspect,sourceFreeze:checked.sourceFreeze,authority,vaultId:'v',targetDirectory:target,storageDomain:'payload',storageProfile:PACKED_SAFETY_PROFILE,newStorageDEK,operationId:checked.migrationId};
  const receipt=AnchoredVault.importLegacyM2(importRequest);assert.deepEqual(AnchoredVault.importLegacyM2(importRequest),receipt);assert.deepEqual(files(source),original);assert.deepEqual(files(backup),originalBackup);
  const keys={version:2 as const,keyEpoch:1,storageDEK:newStorageDEK,ingressKey:legacyKey},config={directory:target,authority,keys,vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:PACKED_SAFETY_PROFILE};
  const v=AnchoredVault.open(config,4,{clock});t.after(()=>v.close());assert.throws(()=>v.claim('new','p'),/LEGACY_ADMISSION_REQUIRED/);
  authority.admitLegacyImport({migrationId:checked.migrationId,head:v.head,operationId:'admit',operatorId:'synthetic',attestation:'operator-attested-stopped'});
  assert.throws(()=>v.claim('legacy','p'),/INTERACTION_TERMINATED/);assert.equal(v.reserved,1);const newBackup=join(root,'new-backup');v.exportBackup(newBackup);
  assert.equal(AnchoredVault.verifyBackup({backupDirectory:newBackup,authority,keys,maxCalls:4}).head.legacyImport!.lineageId,checked.lineageId);
});

test('authority guard fences a real competitor during repack and another vault pending refuses new maintenance',t=>{
  const f=fixture(t,1);fillAndRevoke(f.v.store,4);let attempts=0;const r=request(f);
  AnchoredVault.repackStore({...r,fault:point=>{if(point==='stage-written'){
    attempts++;const script=`import assert from 'node:assert/strict';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const a=LocalSqliteAuthority.open(${JSON.stringify(f.authorityConfig)});assert.throws(()=>a.inspect('v'),/ANCHOR_BUSY/);a.close();`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,timeout:15000,encoding:'utf8'});assert.equal(child.status,0,child.stderr);
  }}});assert.equal(attempts,1);f.v.close();
  const other=AnchoredVault.create({...f.config,directory:join(f.root,'other'),vaultId:'other'},4,{clock});t.after(()=>other.close());
  const pending={...request(f,'other-upgrade'),vaultId:'other',storageProfile:PACKED_SAFETY_PROFILE};
  assert.throws(()=>AnchoredVault.upgradeStorage({...pending,fault:p=>{if(p==='prepared')throw Error('STOP');}}),/STOP/);
  const source=files(r.targetDirectory),head=f.authority.inspect('v')!.head;
  assert.throws(()=>AnchoredVault.upgradeStorage({...request(f,'blocked'),storageProfile:PACKED_SAFETY_PROFILE}),/ANCHOR_.*PENDING/);
  assert.deepEqual(f.authority.inspect('v')!.head,head);assert.deepEqual(files(r.targetDirectory),source);assert.equal(f.authority.transaction(tx=>tx.receipt('v','blocked')),null);
  AnchoredVault.reconcile(pending);
});
