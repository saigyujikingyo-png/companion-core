import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {createHmac,randomBytes} from 'node:crypto';
import {mkdtempSync,realpathSync,readFileSync,readdirSync,existsSync,writeFileSync,renameSync,mkdirSync,cpSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {AnchoredVault} from '../src/anchored-vault.ts';
import type {AnchoredConfig,CompactRequest} from '../src/anchored-vault.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {generateKeySet,identityOf,writeNew,encodeVaultMarker,INCREMENTAL_MARKER} from '../src/anchored-codec.ts';
import type {StorageProfile,VaultHead} from '../src/anchored-codec.ts';
import {reconstruct,directoryReader,freezeFrame} from '../src/incremental-storage.ts';
import {COLD_SAFETY_PROFILE,canonicalSafetyJSON} from '../src/safety-format.ts';
import {allHotSafety} from '../src/safety-ledger.ts';
import {sealSafetySegment} from '../src/safety-segment.ts';
import {sha} from '../src/durable-codec.ts';
import type {Safety} from '../src/durable-codec.ts';
import {DurableMemory} from '../src/durable-memory.ts';
import {inspectLegacyM2} from '../src/legacy-m2-import.ts';
import {configureRepackRuntime} from '../src/memory-image.ts';
import {CoreError} from '../src/validation.ts';

const clock={wall:()=>100,monotonic:()=>0},P3='blocks-br4-safety-br4-v1' as const;
const who={tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test'};
function fixture(t:TestContext,profile:StorageProfile=COLD_SAFETY_PROFILE,schema:1|2=1,maxCalls=4){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'if10-'))),authorityConfig={directory:join(root,'authority'),authorityId:'a',custodyDomain:'independent'},authority=LocalSqliteAuthority.create(authorityConfig);
  const config:AnchoredConfig={directory:join(root,'vault'),vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:profile,schemaVersion:schema,keys:generateKeySet(),authority};
  const v=AnchoredVault.create(config,maxCalls,{clock});t.after(()=>{v.close();authority.close();});return{root,authorityConfig,authority,config,v,maxCalls};
}
const req=(f:ReturnType<typeof fixture>,operationId:string):CompactRequest=>({authority:f.authority,vaultId:'v',keys:f.config.keys,maxCalls:f.maxCalls,targetDirectory:join(f.root,operationId),storageDomain:'payload',operationId});
const hashes=(path:string)=>readdirSync(path).sort().map(name=>[name,sha(readFileSync(join(path,name)))]);
function snapshot(head:VaultHead,keys:AnchoredConfig['keys'],maxCalls=4){const d=reconstruct(head,directoryReader(head.directory),keys,maxCalls);try{return{safety:structuredClone(d.state.safety),image:sha(d.image),highWater:d.state.revocationHighWater,hot:d.ledger.hotEnvelope().ingress.map(r=>r.ordinal),cold:d.ledger.coldRows(),baseline:{...d.baseline,image:undefined}};}finally{d.image.fill(0);d.ledger.close();}}
function history(v:AnchoredVault,mixed=false){
  v.claim('failed','p');v.terminal('failed','failed');v.claim('unknown','p');v.reserve('unknown');v.terminal('unknown','failed');
  v.claim('ack','p');v.reserve('ack');v.terminal('ack','ready','d-ack');v.terminal('ack','taken','d-ack');v.terminal('ack','acknowledged','d-ack');v.consumeFeedback('d-ack');
  v.claim('hot-ack','p');v.reserve('hot-ack');v.terminal('hot-ack','ready','d-hot');v.terminal('hot-ack','taken','d-hot');v.terminal('hot-ack','acknowledged','d-hot');
  if(mixed){v.claim('pending','p');v.claim('ready','p');v.terminal('ready','ready','d-ready');v.claim('taken','p');v.terminal('taken','ready','d-taken');v.terminal('taken','taken','d-taken');}
}
function storeHistory(v:AnchoredVault){
  let scope=v.store.ensureScope(who);const refs=[];
  for(let i=0;i<8;i++)refs.push(v.store.acceptEvent(scope,{source:'synthetic',eventKey:`event-${i}`,evidence:{speakerId:'subject',speakerRole:'subject',mode:'self_report',selectedText:'x'.repeat(4000),occurredAt:null}}));
  scope=v.store.purge(scope);return{scope,refs};
}
function openReceipt(f:ReturnType<typeof fixture>,head:VaultHead){return AnchoredVault.open({...f.config,directory:head.directory,storageProfile:head.storageProfile!,schemaVersion:head.schemaVersion??1},f.maxCalls,{clock});}
function repackAdmitted():boolean{const db=new DatabaseSync(':memory:',{allowExtension:false});try{configureRepackRuntime(db);return true;}catch(error){if(error instanceof CoreError&&error.code==='REPACK_RUNTIME')return false;throw error;}finally{db.close();}}

test('P3 explicit upgrade leaves all hot; archive preserves exact current without boot, clock or source writes',t=>{
  const f=fixture(t,P3);history(f.v,true);f.v.source({id:'source',revision:1});const before=snapshot(f.v.head,f.config.keys),old=f.v.head;
  const upgraded=AnchoredVault.upgradeStorage({...req(f,'upgrade'),storageProfile:COLD_SAFETY_PROFILE});
  assert.equal(upgraded.newHead.safetyCold,null);assert.deepEqual(snapshot(upgraded.newHead,f.config.keys).safety,before.safety);
  assert.throws(()=>f.v.claim('new','p'),/ANCHOR_FENCED/);f.v.close();const files=hashes(upgraded.newHead.directory);
  const archived=AnchoredVault.archiveTerminalSafety(req(f,'archive')),after=snapshot(archived.newHead,f.config.keys);
  assert.equal(canonicalSafetyJSON(after.safety),canonicalSafetyJSON(before.safety));assert.equal(after.image,before.image);assert.equal(after.highWater,before.highWater);
  assert.equal(after.safety.lastAcknowledgedDeliveryId,'d-hot');assert.equal(after.safety.lastWall,100);assert.deepEqual(after.hot,[3,4,5,6]);assert.equal(after.cold.length,3);
  assert.equal(archived.newHead.sequence,1);assert.equal(archived.newHead.ownerEpoch,old.ownerEpoch+2);assert.deepEqual(hashes(upgraded.newHead.directory),files);
  const opened=openReceipt(f,archived.newHead);t.after(()=>opened.close());assert.equal(opened.status.unknownRequests,4);assert.equal(opened.status.lastAcknowledgedDeliveryId,null);assert.equal(opened.status.coldIngressCount,3);
});

test('cold keys/deliveries preserve duplicate priority, UNKNOWN, consumed feedback, immutable no-op and quota',t=>{
  const f=fixture(t);history(f.v);const a=AnchoredVault.archiveTerminalSafety(req(f,'archive'));f.v.close();const v=openReceipt(f,a.newHead);t.after(()=>v.close());
  for(const key of ['failed','unknown','ack']){assert.throws(()=>v.claim(key,'p'),/INTERACTION_TERMINATED/);assert.throws(()=>v.claim(key,'different'),/INTERACTION_IDEMPOTENCY_CONFLICT/);}
  assert.throws(()=>v.consumeFeedback('d-ack'),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);assert.throws(()=>v.consumeFeedback('none'),/FEEDBACK_REQUIRES_DELIVERED_RECEIPT/);
  const before=v.head,last=snapshot(before,f.config.keys).safety.lastWall;
  v.terminal('failed','failed');v.terminal('unknown','failed');v.terminal('ack','acknowledged','d-ack');assert.deepEqual(v.head,before);assert.equal(snapshot(v.head,f.config.keys).safety.lastWall,last);
  assert.throws(()=>v.terminal('ack','unknown','d-ack'),/INTERACTION_TERMINATED/);assert.throws(()=>v.terminal('failed','failed','d-ack'),/DURABLE_DELIVERY_CONFLICT/);
  v.claim('new','p');assert.throws(()=>v.terminal('new','ready','d-ack'),/DURABLE_DELIVERY_CONFLICT/);v.reserve('new');assert.equal(v.reserved,4);
  assert.throws(()=>v.reserve(undefined),/REQUEST_BUDGET_EXHAUSTED/);v.consumeFeedback('d-hot');assert.equal(v.status.coldIngressCount,3);
  const second=AnchoredVault.archiveTerminalSafety(req(f,'archive-two'));assert.equal(second.newHead.safetyCold!.entryCount,4);
});

test('archive idempotency is action bound after newer writes; no eligible hot refuses before target/receipt',t=>{
  const f=fixture(t),none=req(f,'none');assert.throws(()=>AnchoredVault.archiveTerminalSafety(none),/SAFETY_ARCHIVE_NO_TERMINALS/);assert.equal(existsSync(none.targetDirectory),false);
  f.v.claim('old','p');f.v.terminal('old','failed');const r=req(f,'archive'),a=AnchoredVault.archiveTerminalSafety(r);f.v.close();const v=openReceipt(f,a.newHead);t.after(()=>v.close());v.claim('new','p');
  assert.deepEqual(AnchoredVault.archiveTerminalSafety(r),a);assert.throws(()=>AnchoredVault.archiveTerminalSafety({...r,maxCalls:3}),/ANCHOR_OPERATION_CONFLICT/);
  assert.throws(()=>AnchoredVault.compact(r),/ANCHOR_OPERATION_CONFLICT/);assert.throws(()=>AnchoredVault.repackStore(r),/ANCHOR_OPERATION_CONFLICT/);
  assert.throws(()=>AnchoredVault.upgradeStorage({...r,storageProfile:COLD_SAFETY_PROFILE}),/ANCHOR_OPERATION_CONFLICT/);
  const next=req(f,'no-new-terminals');assert.throws(()=>AnchoredVault.archiveTerminalSafety(next),/SAFETY_ARCHIVE_NO_TERMINALS/);assert.equal(existsSync(next.targetDirectory),false);
  assert.equal(f.authority.transaction(tx=>tx.receipt('v',next.operationId)),null);
});

test('only P3 to P4 upgrade is admitted and archive never implicitly upgrades',t=>{
  const f=fixture(t,'blocks-br4-v1');f.v.claim('old','p');f.v.terminal('old','failed');
  assert.throws(()=>AnchoredVault.archiveTerminalSafety(req(f,'bad-archive')),/ANCHOR_STORAGE_PROFILE/);
  assert.throws(()=>AnchoredVault.upgradeStorage({...req(f,'bad-upgrade'),storageProfile:COLD_SAFETY_PROFILE}),/ANCHOR_STORAGE_PROFILE/);
  const p3=AnchoredVault.upgradeStorage({...req(f,'to-p3'),storageProfile:P3});f.v.close();assert.equal(p3.newHead.storageProfile,P3);
  AnchoredVault.upgradeStorage({...req(f,'to-p4'),storageProfile:COLD_SAFETY_PROFILE});
  for(const p of [COLD_SAFETY_PROFILE,P3,'blocks-br4-v1','full-br4-v1'] as StorageProfile[])assert.throws(()=>AnchoredVault.upgradeStorage({...req(f,`deny-${p}`),storageProfile:p}),/ANCHOR_STORAGE_PROFILE/);
});

test('ordinary writes and early bases retain root and cold bytes; capacity reports the complete ledger',t=>{
  const f=fixture(t);history(f.v);const a=AnchoredVault.archiveTerminalSafety(req(f,'archive'));f.v.close();const v=openReceipt(f,a.newHead);t.after(()=>v.close());
  const descriptor=a.newHead.safetyCold!,path=join(a.newHead.directory,descriptor.file),hash=sha(readFileSync(path));
  for(let i=0;i<20;i++)v.source({id:`source-${i}`,revision:1});
  assert.deepEqual(v.head.safetyCold,descriptor);assert.equal(sha(readFileSync(path)),hash);
  const c=AnchoredVault.inspectCapacity({authority:f.authority,vaultId:'v',keys:f.config.keys,maxCalls:4});assert.equal(c.status,'ACTIVE');if(c.status!=='ACTIVE')throw Error('not active');
  assert.equal(c.safety.ingressCount,4);assert.equal(c.safety.coldCount,3);assert.equal(c.safety.hotCount,1);assert.equal(c.safety.reserved,3);assert.equal(c.safety.unknownCount,1);
  assert.deepEqual(c.currentHead.safetyCold,descriptor);assert.equal(c.generation.requiredChain.frameLimit,15);assert.ok(c.generation.requiredChain.files<=31);
});

for(const operation of ['compact','repack','fanout'] as const)test(`${operation} uses a self-contained new cold context and preserves the partition`,t=>{
  const f=fixture(t,COLD_SAFETY_PROFILE,operation==='fanout'?2:1);storeHistory(f.v);history(f.v);
  const a=AnchoredVault.archiveTerminalSafety(req(f,'archive'));f.v.close();const before=snapshot(a.newHead,f.config.keys),r=req(f,operation);
  const admitted=operation==='repack'?repackAdmitted():true;
  if(operation==='repack'&&process.version==='v24.16.0')assert.equal(admitted,true,'audited 24.16.0 repack must retain the full positive path');
  if(operation==='repack'&&process.version==='v24.21.0')assert.equal(admitted,false,'24.21.0 physical repack is not admitted by the frozen gate');
  if(operation==='repack'&&!admitted){
    const original=hashes(a.newHead.directory),head=f.authority.inspect('v')!.head;
    assert.throws(()=>AnchoredVault.repackStore(r),/REPACK_RUNTIME/);assert.equal(existsSync(r.targetDirectory),false);assert.deepEqual(f.authority.inspect('v')!.head,head);
    assert.equal(f.authority.transaction(tx=>tx.receipt('v',r.operationId)),null);assert.deepEqual(hashes(a.newHead.directory),original);
    console.log('IF10_REPACK_CAPABILITY',JSON.stringify({node:process.version,coldReadWrite:'PASS',physicalRepack:'RUNTIME_REFUSAL_VERIFIED',targetCreated:false,receiptConsumed:false}));return;
  }
  const next=operation==='compact'?AnchoredVault.compact(r):operation==='repack'?AnchoredVault.repackStore(r):AnchoredVault.maintainFanout({...r,retainBatches:1,resetConsumerIds:[]});
  const after=snapshot(next.newHead,f.config.keys);assert.notEqual(next.newHead.safetyCold!.cipherDigest,a.newHead.safetyCold!.cipherDigest);
  assert.deepEqual(after.hot,before.hot);assert.deepEqual(after.cold,before.cold);assert.equal(canonicalSafetyJSON(after.safety),canonicalSafetyJSON(before.safety));assert.equal(after.highWater,before.highWater);
  const v=openReceipt(f,next.newHead);t.after(()=>v.close());assert.throws(()=>v.claim('unknown','p'),/INTERACTION_TERMINATED/);v.claim('later','p');assert.equal(v.reserved,3);
});

test('archive -> conflicts -> hot feedback -> backup A -> rekey/boot -> backup B -> restore B; A rejected',t=>{
  const f=fixture(t);history(f.v);const archived=AnchoredVault.archiveTerminalSafety(req(f,'archive'));f.v.close();let config={...f.config,directory:archived.newHead.directory},v=AnchoredVault.open(config,4,{clock});t.after(()=>v.close());
  assert.throws(()=>v.claim('unknown','p'),/INTERACTION_TERMINATED/);v.terminal('unknown','unknown');v.consumeFeedback('d-hot');
  const backupA=join(f.root,'backup-A');v.exportBackup(backupA);const before=snapshot(v.head,config.keys),newDEK=randomBytes(32),rr={...req(f,'rekey'),backupDirectory:backupA,newStorageDEK:newDEK};
  const rekey=AnchoredVault.rekeyBackup(rr);assert.deepEqual(AnchoredVault.rekeyBackup(rr),rekey);v.close();
  assert.throws(()=>reconstruct(rekey.newHead,directoryReader(rekey.newHead.directory),{...config.keys,keyEpoch:2},4),/SAFETY_COLD_AUTH/);
  config={...config,directory:rekey.newHead.directory,keys:{...config.keys,keyEpoch:2,storageDEK:newDEK}};v=AnchoredVault.open(config,4,{clock});
  const backupB=join(f.root,'backup-B');v.exportBackup(backupB);const restore=AnchoredVault.restoreBackup({...req(f,'restore'),keys:config.keys,backupDirectory:backupB});v.close();
  assert.notEqual(restore.newHead.safetyCold!.cipherDigest,rekey.newHead.safetyCold!.cipherDigest);
  assert.throws(()=>AnchoredVault.restoreBackup({...req(f,'reject-A'),backupDirectory:backupA}),/ANCHOR_FENCED/);
  config={...config,directory:restore.newHead.directory};v=AnchoredVault.open(config,4,{clock});
  assert.equal(v.reserved,before.safety.reserved);assert.equal(v.status.unknownRequests,1);assert.throws(()=>v.claim('failed','p'),/INTERACTION_TERMINATED/);assert.throws(()=>v.consumeFeedback('d-hot'),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
  v.claim('fourth','p');v.reserve('fourth');assert.equal(v.reserved,4);assert.throws(()=>v.reserve('unknown'),/REQUEST_BUDGET_EXHAUSTED/);
});

test('schema migration reseals cold root while preserving safety and revocation high water',t=>{
  const f=fixture(t);storeHistory(f.v);history(f.v);const a=AnchoredVault.archiveTerminalSafety(req(f,'archive'));f.v.close();const v=openReceipt(f,a.newHead);t.after(()=>v.close());
  const backup=join(f.root,'backup');v.exportBackup(backup);const before=snapshot(v.head,f.config.keys),m=AnchoredVault.migrateBackup({...req(f,'migrate'),backupDirectory:backup,targetSchema:2});v.close();
  const after=snapshot(m.newHead,f.config.keys);assert.equal(m.newHead.schemaVersion,2);assert.notEqual(m.newHead.safetyCold!.cipherDigest,a.newHead.safetyCold!.cipherDigest);assert.equal(canonicalSafetyJSON(after.safety),canonicalSafetyJSON(before.safety));assert.equal(after.highWater,before.highWater);
  const next=openReceipt(f,m.newHead);t.after(()=>next.close());assert.throws(()=>next.claim('unknown','p'),/INTERACTION_TERMINATED/);
});

for(const mutation of ['missing','replace'] as const)test(`opened cold closure ${mutation} rejects cached query, no-op, write and export`,t=>{
  const f=fixture(t);history(f.v);const a=AnchoredVault.archiveTerminalSafety(req(f,'archive'));f.v.close();const v=openReceipt(f,a.newHead);t.after(()=>v.close());
  const before=v.head,file=join(a.newHead.directory,a.newHead.safetyCold!.file),protectedCopy=join(f.root,'successful-cold-original.bin');writeFileSync(protectedCopy,readFileSync(file),{flag:'wx'});
  if(mutation==='missing')renameSync(file,file+'.retained');else writeFileSync(file,Buffer.alloc(statSync(file).size,1));
  for(const operation of [()=>v.status,()=>v.claim('unknown','p'),()=>v.claim('new','p'),()=>v.terminal('failed','failed'),()=>v.source({id:'x',revision:1}),()=>v.store.ensureScope(who),()=>v.exportBackup(join(f.root,'bad-backup'))])assert.throws(operation);
  assert.deepEqual(f.authority.inspect('v')!.head,before);
  assert.equal(sha(readFileSync(protectedCopy)),a.newHead.safetyCold!.cipherDigest);
});

test('backup closure has exact cold filename and rejects missing, extra, replaced or unlisted files',t=>{
  const f=fixture(t);history(f.v);const a=AnchoredVault.archiveTerminalSafety(req(f,'archive'));f.v.close();const v=openReceipt(f,a.newHead);t.after(()=>v.close());
  const original=join(f.root,'backup-original');v.exportBackup(original);const manifest=JSON.parse(readFileSync(join(original,'current-state.json'),'utf8'));
  assert.ok(manifest.files.length<=31);assert.equal(manifest.files.filter((x:any)=>x.name.startsWith('safety-')).length,1);
  for(const mode of ['missing','extra','replace','wrong-name']){
    const copy=join(f.root,`backup-${mode}`);cpSync(original,copy,{recursive:true});const cold=join(copy,a.newHead.safetyCold!.file);
    if(mode==='missing')renameSync(cold,join(f.root,`cold-${mode}.retained`));
    if(mode==='extra')writeFileSync(join(copy,'extra.bin'),'synthetic');
    if(mode==='replace')writeFileSync(cold,Buffer.alloc(statSync(cold).size,2));
    if(mode==='wrong-name'){
      const m=structuredClone(manifest);m.files.find((x:any)=>x.name.startsWith('safety-')).name='../escape.bin';writeFileSync(join(copy,'current-state.json'),JSON.stringify(m));
    }
    assert.throws(()=>AnchoredVault.verifyBackup({backupDirectory:copy,authority:f.authority,keys:f.config.keys,maxCalls:4}));
  }
  assert.deepEqual(AnchoredVault.verifyBackup({backupDirectory:original,authority:f.authority,keys:f.config.keys,maxCalls:4}).head,v.head);
});

test('P4 31-file and legacy P3 32-file complete backups are both readable',t=>{
  for(const profile of [P3,COLD_SAFETY_PROFILE]){
    const f=fixture(t,profile);f.v.claim('old','p');f.v.terminal('old','failed');let v=f.v;
    if(profile===COLD_SAFETY_PROFILE){const a=AnchoredVault.archiveTerminalSafety(req(f,'archive'));v.close();v=openReceipt(f,a.newHead);t.after(()=>v.close());}
    const limit=profile===P3?16:15;let depth=0;
    for(let i=0;i<limit;i++){const d=reconstruct(v.head,directoryReader(v.head.directory),f.config.keys,4);depth=d.baseline.depth;d.image.fill(0);d.ledger.close();if(depth===limit)break;v.source({id:`file-limit-${i}`,revision:1});}
    assert.equal(depth,limit);const backup=join(f.root,'maximum-backup');v.exportBackup(backup);const manifest=JSON.parse(readFileSync(join(backup,'current-state.json'),'utf8'));
    assert.equal(manifest.files.length,profile===P3?32:31);assert.deepEqual(AnchoredVault.verifyBackup({authority:f.authority,keys:f.config.keys,maxCalls:4,backupDirectory:backup}).head,v.head);
    const noted=join(f.root,'backup-with-note');cpSync(backup,noted,{recursive:true});writeFileSync(join(noted,'operator-note.txt'),'synthetic retained operator note');
    if(profile===P3){assert.deepEqual(AnchoredVault.verifyBackup({authority:f.authority,keys:f.config.keys,maxCalls:4,backupDirectory:noted}).head,v.head);
      const restored=AnchoredVault.restoreBackup({...req(f,'note-restore'),backupDirectory:noted});v.close();const opened=openReceipt(f,restored.newHead);t.after(()=>opened.close());assert.throws(()=>opened.claim('old','p'),/INTERACTION_TERMINATED/);
    }else assert.throws(()=>AnchoredVault.verifyBackup({authority:f.authority,keys:f.config.keys,maxCalls:4,backupDirectory:noted}),/ANCHOR_BACKUP/);
  }
});

for(const point of ['safety-cold-written','prepared','record-published','finalized'] as const)test(`real child exit at ${point}: exact archive retry/reconcile and missing frozen dependencies`,t=>{
  const f=fixture(t);history(f.v);f.v.close();const r=req(f,'archive'),source=hashes(f.config.directory),before=f.authority.inspect('v')!.head!;
  const script=`import {AnchoredVault} from './src/anchored-vault.ts';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';let chunks=[];for await(const c of process.stdin)chunks.push(c);const x=JSON.parse(Buffer.concat(chunks));const authority=LocalSqliteAuthority.open(x.authority),keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')};AnchoredVault.archiveTerminalSafety({...x.request,authority,keys,fault:p=>{if(p===x.point)process.exit(42);}});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,timeout:20000,encoding:'utf8',input:JSON.stringify({authority:f.authorityConfig,point,
    request:{vaultId:'v',maxCalls:4,targetDirectory:r.targetDirectory,storageDomain:'payload',operationId:r.operationId},keys:{version:2,keyEpoch:1,storageDEK:Buffer.from(f.config.keys.storageDEK).toString('base64'),ingressKey:Buffer.from(f.config.keys.ingressKey).toString('base64')}})});
  assert.equal(child.status,42,child.stderr);assert.deepEqual(hashes(f.config.directory),source);
  if(point==='safety-cold-written'){
    assert.deepEqual(f.authority.inspect('v')!.head,before);assert.equal(f.authority.transaction(tx=>tx.receipt('v',r.operationId)),null);
    assert.throws(()=>AnchoredVault.reconcile(r),/ANCHOR_UNRESOLVED/);assert.throws(()=>AnchoredVault.archiveTerminalSafety(r),/ANCHOR_TARGET_EXISTS/);assert.ok(readdirSync(r.targetDirectory).some(x=>x.startsWith('safety-')));return;
  }
  if(point!=='finalized'){
    const row=f.authority.inspect('v')!;assert.equal(row.status,'PREPARED');assert.throws(()=>AnchoredVault.archiveTerminalSafety(r),/ANCHOR_PENDING/);
    const pending=row.pending!,stage=JSON.parse(readFileSync(pending.stagePath,'utf8'));
    for(const path of [join(r.targetDirectory,pending.newHead.safetyCold!.file),join(r.targetDirectory,stage.blob),pending.stagePath,join(r.targetDirectory,INCREMENTAL_MARKER)]){
      renameSync(path,path+'.retained');assert.throws(()=>AnchoredVault.reconcile(r),/ANCHOR_UNRESOLVED/);assert.equal(f.authority.inspect('v')!.status,'PREPARED');renameSync(path+'.retained',path);
    }
  }
  const receipt=AnchoredVault.reconcile(r);assert.deepEqual(AnchoredVault.archiveTerminalSafety(r),receipt);assert.equal(snapshot(receipt.newHead,f.config.keys).cold.length,3);
});

test('real competing process maintenance/old writer loses authority guard; cross-vault pending cannot be bypassed',t=>{
  const f=fixture(t);history(f.v);let contenders=0;const r=req(f,'archive');
  const a=AnchoredVault.archiveTerminalSafety({...r,fault:p=>{if(p!=='stage-written')return;contenders++;
    const script=`import assert from 'node:assert/strict';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';import {AnchoredVault} from './src/anchored-vault.ts';let chunks=[];for await(const c of process.stdin)chunks.push(c);const x=JSON.parse(Buffer.concat(chunks)),authority=LocalSqliteAuthority.open(x.authority),keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')};assert.throws(()=>AnchoredVault.archiveTerminalSafety({...x.request,authority,keys}),/ANCHOR_BUSY/);assert.throws(()=>AnchoredVault.open({...x.config,authority,keys},4),/ANCHOR_BUSY|ANCHOR_WRITER_BUSY/);authority.close();`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,timeout:15000,encoding:'utf8',input:JSON.stringify({authority:f.authorityConfig,config:{directory:f.config.directory,vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:COLD_SAFETY_PROFILE},
      request:{vaultId:'v',maxCalls:4,targetDirectory:join(f.root,'competitor'),storageDomain:'payload',operationId:'competitor'},keys:{version:2,keyEpoch:1,storageDEK:Buffer.from(f.config.keys.storageDEK).toString('base64'),ingressKey:Buffer.from(f.config.keys.ingressKey).toString('base64')}})});
    assert.equal(child.status,0,child.stderr);
  }});assert.equal(contenders,1);assert.throws(()=>f.v.claim('late','p'),/ANCHOR_FENCED/);f.v.close();
  const other=AnchoredVault.create({...f.config,directory:join(f.root,'other'),vaultId:'other'},4,{clock});t.after(()=>other.close());other.claim('x','p');other.terminal('x','failed');
  const pending={...req(f,'other-archive'),vaultId:'other'};assert.throws(()=>AnchoredVault.archiveTerminalSafety({...pending,fault:p=>{if(p==='prepared')throw Error('STOP');}}),/STOP/);
  const head=f.authority.inspect('v')!.head;assert.throws(()=>AnchoredVault.compact(req(f,'blocked')),/ANCHOR_.*PENDING/);assert.deepEqual(f.authority.inspect('v')!.head,head);AnchoredVault.reconcile(pending);
  assert.equal(f.authority.inspect('v')!.head!.digest,a.newHead.digest);
});

test('actual authority capacity refusal preserves frozen orphan, no receipt, and refuses implicit target reuse',t=>{
  const f=fixture(t);history(f.v);f.v.close();const db=new DatabaseSync(join(f.authority.directory,'authority.sqlite'));
  try{db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('historical-fixture','padding',JSON.stringify({synthetic:true,padding:'x'.repeat(100000)}));}finally{db.close();}
  const low=LocalSqliteAuthority.open({...f.authorityConfig,writeLimitBytes:65536});t.after(()=>low.close());const r={...req(f,'refused'),authority:low},before=low.inspect('v');
  assert.throws(()=>AnchoredVault.archiveTerminalSafety(r),/ANCHOR_CAPACITY/);assert.deepEqual(low.inspect('v'),before);
  assert.equal(low.transaction(tx=>tx.receipt('v',r.operationId)),null);assert.ok(readdirSync(r.targetDirectory).some(x=>x.startsWith('safety-')));assert.ok(existsSync(join(r.targetDirectory,'stage-refused.json')));
  assert.throws(()=>AnchoredVault.archiveTerminalSafety(r),/ANCHOR_TARGET_EXISTS/);
});

test('legacy P4 import all-hot -> maintenance keeps admission closed -> actual admit -> archive/rekey/restore',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'if10-legacy-'))),source=join(root,'legacy');mkdirSync(source);const legacyKey=randomBytes(32),legacy=new DurableMemory({directory:source,identity:'synthetic',keyBase64:legacyKey.toString('base64')},4,{clock});t.after(()=>legacy.close());
  legacy.claim('legacy','p');legacy.reserve('legacy');legacy.terminal('legacy','unknown');const backup=join(root,'legacy-backup');legacy.exportBackup(backup);
  const authorityConfig={directory:join(root,'authority'),authorityId:'a',custodyDomain:'independent'};LocalSqliteAuthority.create(authorityConfig).close();LocalSqliteAuthority.upgradeSchema(authorityConfig,'operator-attested-stopped');const authority=LocalSqliteAuthority.open(authorityConfig);t.after(()=>authority.close());
  const inspect={backupDirectory:backup,legacyKey,identity:'synthetic',expectedMaxCalls:4,declaredHead:legacy.head,trust:{policy:'trusted-lower-bound' as const,minimumHead:legacy.head}},checked=inspectLegacyM2(inspect),newStorageDEK=randomBytes(32);
  const imported=AnchoredVault.importLegacyM2({...inspect,sourceFreeze:checked.sourceFreeze,authority,vaultId:'v',targetDirectory:join(root,'imported'),storageDomain:'payload',storageProfile:COLD_SAFETY_PROFILE,newStorageDEK,operationId:checked.migrationId});assert.equal(imported.newHead.safetyCold,null);
  const keys={version:2 as const,keyEpoch:1,storageDEK:newStorageDEK,ingressKey:legacyKey},request=(name:string)=>({authority,vaultId:'v',keys,maxCalls:4,targetDirectory:join(root,name),storageDomain:'payload',operationId:name});
  const compact=AnchoredVault.compact(request('before-admission'));let config={authority,keys,directory:compact.newHead.directory,vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:COLD_SAFETY_PROFILE},v=AnchoredVault.open(config,4,{clock});t.after(()=>v.close());
  assert.throws(()=>v.claim('new','p'),/LEGACY_ADMISSION_REQUIRED/);authority.admitLegacyImport({migrationId:checked.migrationId,head:v.head,operationId:'admit',operatorId:'synthetic',attestation:'operator-attested-stopped'});
  const archived=AnchoredVault.archiveTerminalSafety(request('archive'));v.close();config={...config,directory:archived.newHead.directory};v=AnchoredVault.open(config,4,{clock});assert.throws(()=>v.claim('legacy','p'),/INTERACTION_TERMINATED/);
  const a=join(root,'backup-A');v.exportBackup(a);const nextKey=randomBytes(32),rekey=AnchoredVault.rekeyBackup({...request('rekey'),backupDirectory:a,newStorageDEK:nextKey});v.close();config={...config,directory:rekey.newHead.directory,keys:{...keys,keyEpoch:2,storageDEK:nextKey}};v=AnchoredVault.open(config,4,{clock});
  const b=join(root,'backup-B');v.exportBackup(b);const restored=AnchoredVault.restoreBackup({...request('restore'),keys:config.keys,backupDirectory:b});v.close();config={...config,directory:restored.newHead.directory};v=AnchoredVault.open(config,4,{clock});assert.equal(v.reserved,1);assert.throws(()=>v.claim('legacy','p'),/INTERACTION_TERMINATED/);v.claim('new','p');v.reserve('new');assert.equal(v.reserved,2);
  assert.equal(authority.transaction(tx=>tx.legacy(checked.lineageId))!.proof.legacyCopiesFenced,false);
});

test('8192 structural cold current preserves public duplicate/conflict priority before full rejection',t=>{
  const f=fixture(t,COLD_SAFETY_PROFILE,1,0);const initial=reconstruct(f.v.head,directoryReader(f.config.directory),f.config.keys,0),old=f.v.head;f.v.close();
  const digest=(value:unknown)=>createHmac('sha256',f.config.keys.ingressKey).update(JSON.stringify(value)).digest('hex');
  const safety:Safety={...initial.state.safety,ingress:Array.from({length:8192},(_,i)=>({key:digest(['ingress',`request-${i}`]),fingerprint:digest(['payload','p']),state:'failed',deliveryId:null,feedbackConsumed:false,reserved:false}))};
  const target=join(f.root,'structural-generation'),id={...identityOf(old),directory:target,ownerEpoch:old.ownerEpoch+1,instanceId:'structural-only'},ordered=safety.ingress.map((entry,ordinal)=>({ordinal,entry})),sealed=sealSafetySegment(ordered,id,f.config.keys.storageDEK);id.safetyCold=sealed.descriptor;
  const hot=allHotSafety(safety);hot.ingress=[];const frozen=freezeFrame(id,1,'structural-only',initial.image,safety,initial.state.revocationHighWater,f.config.keys,null,old,null,undefined,undefined,hot);initial.image.fill(0);initial.ledger.close();
  mkdirSync(target);writeNew(join(target,INCREMENTAL_MARKER),encodeVaultMarker(id));writeNew(join(target,sealed.descriptor.file),sealed.bytes);writeNew(join(target,frozen.stage.blob),frozen.blob);writeNew(join(target,'record-1.bin'),Buffer.from(frozen.stage.record,'base64'));
  const stagePath=join(target,'stage-structural-only.json');writeNew(stagePath,frozen.bytes);const pending={version:2 as const,kind:'compaction' as const,operationId:'structural-only',requestDigest:sha('structural-only'),oldHead:old,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes)};
  f.authority.transaction(tx=>{tx.prepare(pending);tx.finalize(pending);});const v=openReceipt(f,frozen.stage.head);t.after(()=>v.close());
  assert.equal(v.status.ingressCount,8192);assert.throws(()=>v.claim('request-0','p'),/INTERACTION_TERMINATED/);assert.throws(()=>v.claim('request-0','different'),/INTERACTION_IDEMPOTENCY_CONFLICT/);assert.throws(()=>v.claim('new','p'),/ANCHOR_LIMIT/);
  console.log('IF10_PUBLIC_BOUND_ON_STRUCTURAL_FIXTURE',JSON.stringify({structuralIngress:8192,publicHistoryCreation:false,publicRefusalChecks:3}));
});
