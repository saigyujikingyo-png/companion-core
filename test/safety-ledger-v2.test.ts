import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,realpathSync,readdirSync,readFileSync,renameSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {AnchoredVault} from '../src/anchored-vault.ts';
import type {AnchoredConfig,CompactRequest} from '../src/anchored-vault.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {generateKeySet,INCREMENTAL_MARKER} from '../src/anchored-codec.ts';
import type {VaultHead,StorageProfile} from '../src/anchored-codec.ts';
import {directoryReader,reconstruct} from '../src/incremental-storage.ts';
import {reconstructSafetyV2} from '../src/incremental-safety-v2.ts';
import {SAFETY_V2_PROFILE,safetyOperation,safetyWorkspace,safetyWorkspacePeak,SafetyWorkspace,validateV2Entry} from '../src/safety-v2-format.ts';
import {COLD_SAFETY_PROFILE,canonicalSafetyJSON} from '../src/safety-format.ts';
import {sha} from '../src/durable-codec.ts';
import {CoreError} from '../src/validation.ts';

const clock={wall:()=>100,monotonic:()=>0};
function fixture(t:TestContext,profile:StorageProfile=SAFETY_V2_PROFILE,maxCalls=2,schemaVersion:1|2=1){
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'safety-v2-'))),authorityConfig={directory:join(root,'authority'),authorityId:'a',custodyDomain:'authority'};
 const authority=LocalSqliteAuthority.create(authorityConfig),config:AnchoredConfig={authority,directory:join(root,'vault'),vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:profile,schemaVersion,keys:generateKeySet()};
 const f={root,authorityConfig,authority,config,v:AnchoredVault.create(config,maxCalls,{clock}),maxCalls};t.after(()=>{f.v.close();f.authority.close();});return f;
}
const request=(f:ReturnType<typeof fixture>,operationId:string):CompactRequest=>({authority:f.authority,vaultId:'v',keys:f.config.keys,maxCalls:f.maxCalls,targetDirectory:join(f.root,operationId),storageDomain:'payload',operationId});
function open(f:ReturnType<typeof fixture>,head:VaultHead){f.v.close();f.config={...f.config,directory:head.directory,storageProfile:head.storageProfile!,schemaVersion:head.schemaVersion??1};f.v=AnchoredVault.open(f.config,f.maxCalls,{clock});return f.v;}
function snapshot(head:VaultHead,keys:AnchoredConfig['keys'],maxCalls=2){return safetyOperation(()=>{const d=reconstructSafetyV2(head,directoryReader(head.directory),keys,maxCalls);try{return{rows:[...d.view.iterateEntries()],globals:structuredClone(d.view.globals),fingerprint:d.view.logicalFingerprint(),image:sha(d.image),hot:d.view.hotCount,cold:d.view.coldCount,stats:d.view.stats(),highWater:d.state.revocationHighWater};}finally{d.close();}});}
const hashes=(p:string)=>readdirSync(p).sort().map(n=>[n,sha(readFileSync(join(p,n)))]);

test('v2 create, ordinary commit and inspect use the new closed profile',t=>{
 const f=fixture(t);f.v.claim('one','payload');f.v.reserve('one');f.v.terminal('one','failed');
 const s=snapshot(f.v.head,f.config.keys);assert.equal(s.stats.count,1);assert.equal(s.stats.reserved,1);assert.equal(s.stats.unknown,1);
 const capacity=AnchoredVault.inspectCapacity({authority:f.authority,vaultId:'v',keys:f.config.keys,maxCalls:2});assert.equal(capacity.status,'ACTIVE');if(capacity.status!=='ACTIVE')throw Error('active');
 assert.equal(capacity.safety.hotLimit,256);assert.equal(capacity.safety.ingressLimit,16384);assert.equal(capacity.safety.workspaceLimitBytes,134217728);assert.ok(capacity.safety.workspacePeakBytes!<=134217728);
 const head=f.v.head;open(f,head);assert.throws(()=>f.v.claim('one','payload'),/INTERACTION_TERMINATED/);assert.equal(f.v.reserved,1);
});

test('v2 real 256 hot bound rejects only new claim; archive permits the same request and retains exact old keys',t=>{
 const f=fixture(t,SAFETY_V2_PROFILE,2);
 for(let i=0;i<256;i++){f.v.claim(`request-${i}`,'payload');if(i===0)f.v.reserve('request-0');if(i===1){f.v.reserve('request-1');f.v.terminal('request-1','ready','delivery');f.v.terminal('request-1','taken','delivery');f.v.terminal('request-1','acknowledged','delivery');}else if(i<255)f.v.terminal(`request-${i}`,'failed');}
 const full=f.v.head;assert.throws(()=>f.v.claim('request-256','payload'),/SAFETY_V2_CAPACITY/);assert.deepEqual(f.v.head,full);
 assert.throws(()=>f.v.claim('request-0','different'),/INTERACTION_IDEMPOTENCY_CONFLICT/);assert.throws(()=>f.v.claim('request-0','payload'),/INTERACTION_TERMINATED/);
 assert.throws(()=>f.v.reserve(undefined),/REQUEST_BUDGET_EXHAUSTED/);f.v.terminal('request-255','failed');f.v.consumeFeedback('delivery');const before=snapshot(f.v.head,f.config.keys),old=f.v.head,files=hashes(old.directory);
 const req=request(f,'archive'),a=AnchoredVault.archiveTerminalSafetyV2(req),archivePeak=safetyWorkspacePeak(),after=snapshot(a.newHead,f.config.keys);assert.equal(after.fingerprint,before.fingerprint);assert.equal(after.image,before.image);assert.equal(after.hot,0);assert.equal(after.cold,256);assert.equal(after.stats.reserved,2);assert.equal(after.stats.unknown,1);assert.deepEqual(hashes(old.directory),files);
 assert.throws(()=>f.v.claim('fenced','payload'),/ANCHOR_FENCED/);open(f,a.newHead);const openPeak=safetyWorkspacePeak();f.v.claim('request-256','payload');const writePeak=safetyWorkspacePeak();assert.equal(f.v.status.ingressCount,257);assert.equal(f.v.status.hotIngressCount,1);assert.deepEqual(AnchoredVault.archiveTerminalSafetyV2(req),a);assert.throws(()=>AnchoredVault.compact(req),/ANCHOR_OPERATION_CONFLICT/);
 console.log('SAFETY_V2_HOT_BENEFIT',JSON.stringify({publicHistory:257,archived:256,beforeRefusal:'SAFETY_V2_CAPACITY',sameRequestAfterArchive:'PASS',archivePeak,openPeak,writePeak,workspaceLimitBytes:134217728,long8193:'NOT_RUN'}));
});

test('v2 archive and fresh backup/rekey/restore retain UNKNOWN, quota and terminal priorities',t=>{
 const f=fixture(t);f.v.claim('unknown','p');f.v.reserve('unknown');f.v.terminal('unknown','failed');f.v.claim('ack','p');f.v.reserve('ack');f.v.terminal('ack','ready','delivery');f.v.terminal('ack','taken','delivery');f.v.terminal('ack','acknowledged','delivery');f.v.consumeFeedback('delivery');
 const a=AnchoredVault.archiveTerminalSafetyV2(request(f,'archive'));open(f,a.newHead);const before=f.v.head;f.v.terminal('unknown','failed');f.v.terminal('ack','acknowledged','delivery');assert.deepEqual(f.v.head,before);
 assert.throws(()=>f.v.consumeFeedback('delivery'),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);assert.throws(()=>f.v.terminal('unknown','failed','delivery'),/DURABLE_DELIVERY_CONFLICT/);assert.throws(()=>f.v.reserve('unknown'),/REQUEST_BUDGET_EXHAUSTED/);
 const backup=join(f.root,'backup');f.v.exportBackup(backup);assert.deepEqual(AnchoredVault.verifyBackup({backupDirectory:backup,authority:f.authority,keys:f.config.keys,maxCalls:2}).head,f.v.head);
 const key=randomBytes(32),a2=AnchoredVault.rekeyBackup({...request(f,'rekey'),backupDirectory:backup,newStorageDEK:key});f.v.close();f.config={...f.config,keys:{...f.config.keys,storageDEK:key,keyEpoch:2}};open(f,a2.newHead);
 const fresh=join(f.root,'fresh');f.v.exportBackup(fresh);const restored=AnchoredVault.restoreBackup({...request(f,'restore'),backupDirectory:fresh});open(f,restored.newHead);assert.equal(f.v.reserved,2);assert.equal(f.v.status.unknownRequests,1);assert.throws(()=>f.v.claim('ack','p'),/INTERACTION_TERMINATED/);assert.throws(()=>f.v.consumeFeedback('delivery'),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
});

test('P4 migration preserves globals, exact entries and source files without boot',t=>{
 const f=fixture(t,COLD_SAFETY_PROFILE);f.v.claim('old','p');f.v.reserve('old');f.v.terminal('old','failed');f.v.claim('pending','p');f.v.source({id:'source',revision:1});
 const archived=AnchoredVault.archiveTerminalSafety(request(f,'p4-archive'));f.v.close();const old=reconstruct(archived.newHead,directoryReader(archived.newHead.directory),f.config.keys,2);let expected:string,image:string;
 try{expected=canonicalSafetyJSON(old.state.safety);image=sha(old.image);}finally{old.image.fill(0);old.ledger.close();}
 const files=hashes(archived.newHead.directory),up=AnchoredVault.upgradeStorage({...request(f,'upgrade'),storageProfile:SAFETY_V2_PROFILE}),after=snapshot(up.newHead,f.config.keys);
 assert.equal(canonicalSafetyJSON({...after.globals,ingress:after.rows.map(r=>r.entry)}),expected!);assert.equal(after.image,image!);assert.equal(after.hot,1);assert.equal(after.cold,1);assert.deepEqual(hashes(archived.newHead.directory),files);assert.equal(after.globals.lastWall,100);
 assert.throws(()=>AnchoredVault.archiveTerminalSafety(request(f,'wrong-api')),/ANCHOR_STORAGE_PROFILE/);
});

for(const mode of ['missing','changed','truncated','larger'] as const)test(`v2 current cold ${mode} invalidates cached query, exact retry and backup`,t=>{
 const f=fixture(t);f.v.claim('old','p');f.v.terminal('old','failed');const a=AnchoredVault.archiveTerminalSafetyV2(request(f,'archive'));open(f,a.newHead);const original=f.v.head,file=join(original.directory,original.safetyCold!.file);renameSync(file,file+'.retained');if(mode!=='missing')writeFileSync(file,Buffer.alloc(original.safetyCold!.cipherBytes+(mode==='truncated'?-1:mode==='larger'?1:0),7),{flag:'wx'});
 for(const op of [()=>f.v.status,()=>f.v.claim('old','p'),()=>f.v.terminal('old','failed'),()=>f.v.exportBackup(join(f.root,'invalid-backup'))])assert.throws(op);
 assert.deepEqual(f.authority.inspect('v')!.head,original);assert.equal(existsSync(join(f.root,'invalid-backup')),false);
});

test('workspace refusal, exact ticket release, and entry bound precede allocation paths',()=>{
 const w=new SafetyWorkspace(),a=w.reserve(w.limit-1,'test');assert.throws(()=>w.reserve(2,'overflow'),/SAFETY_V2_WORKSPACE/);a();a();assert.equal(w.used,0);
 safetyOperation(()=>{const baseline=safetyWorkspace().used;assert.throws(()=>validateV2Entry({key:'a'.repeat(64),fingerprint:'b'.repeat(64),state:'failed',reserved:false,feedbackConsumed:false,deliveryId:null,extra:'x'.repeat(8192)}),/SAFETY_V2_BOUND/);assert.equal(safetyWorkspace().used,baseline);});
});

for(const point of ['safety-cold-written','prepared','record-published','finalized'] as const)test(`v2 real child death at ${point} retains exact frozen recovery and prior receipt`,t=>{
 const f=fixture(t);f.v.claim('old','p');f.v.reserve('old');f.v.terminal('old','failed');const old=f.v.head;f.v.close();const req=request(f,'archive'),source=hashes(old.directory);
 const script=`import {AnchoredVault} from './src/anchored-vault.ts';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const chunks=[];for await(const c of process.stdin)chunks.push(c);const x=JSON.parse(Buffer.concat(chunks));const authority=LocalSqliteAuthority.open(x.authority),keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')};AnchoredVault.archiveTerminalSafetyV2({...x.request,authority,keys,fault:p=>{if(p===x.point)process.exit(42);}});`;
 const child=spawnSync(process.execPath,['--max-old-space-size=256','--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,timeout:20000,encoding:'utf8',input:JSON.stringify({point,authority:f.authorityConfig,request:{vaultId:'v',maxCalls:2,targetDirectory:req.targetDirectory,storageDomain:'payload',operationId:'archive'},keys:{version:2,keyEpoch:1,storageDEK:Buffer.from(f.config.keys.storageDEK).toString('base64'),ingressKey:Buffer.from(f.config.keys.ingressKey).toString('base64')}})});
 assert.equal(child.status,42,child.stderr);assert.deepEqual(hashes(old.directory),source);
 if(point==='safety-cold-written'){assert.deepEqual(f.authority.inspect('v')!.head,old);assert.equal(f.authority.transaction(tx=>tx.receipt('v','archive')),null);assert.throws(()=>AnchoredVault.reconcile(req),/ANCHOR_UNRESOLVED/);assert.throws(()=>AnchoredVault.archiveTerminalSafetyV2(req),/ANCHOR_TARGET_EXISTS/);return;}
 if(point!=='finalized'){
  const row=f.authority.inspect('v')!;assert.equal(row.status,'PREPARED');const pending=row.pending!,stage=JSON.parse(readFileSync(pending.stagePath,'utf8'));
  for(const path of [join(req.targetDirectory,pending.newHead.safetyCold!.file),join(req.targetDirectory,stage.blob),pending.stagePath,join(req.targetDirectory,INCREMENTAL_MARKER)]){renameSync(path,path+'.retained');assert.throws(()=>AnchoredVault.reconcile(req),/ANCHOR_UNRESOLVED/);assert.equal(f.authority.inspect('v')!.status,'PREPARED');renameSync(path+'.retained',path);}
  if(point==='prepared'){const path=join(req.targetDirectory,pending.newHead.safetyCold!.file);renameSync(path,path+'.original');writeFileSync(path,Buffer.from('partial'),{flag:'wx'});assert.throws(()=>AnchoredVault.reconcile(req),/ANCHOR_UNRESOLVED/);assert.equal(readFileSync(path,'utf8'),'partial');assert.equal(f.authority.inspect('v')!.status,'PREPARED');renameSync(path,path+'.partial-retained');renameSync(path+'.original',path);}
 }
 const receipt=AnchoredVault.reconcile(req);assert.deepEqual(AnchoredVault.archiveTerminalSafetyV2(req),receipt);const s=snapshot(receipt.newHead,f.config.keys);assert.equal(s.stats.unknown,1);assert.equal(s.stats.reserved,1);assert.equal(s.cold,1);
});

test('v2 new generation compact and schema migration preserve cold identity and revocation',t=>{
 const f=fixture(t);const scope=f.v.store.ensureScope({tenantId:'t',subjectId:'s',personaId:'p',relationshipId:'r'});f.v.store.purge(scope);f.v.claim('old','p');f.v.terminal('old','failed');const a=AnchoredVault.archiveTerminalSafetyV2(request(f,'archive')),before=snapshot(a.newHead,f.config.keys);
 const c=AnchoredVault.compact(request(f,'compact')),after=snapshot(c.newHead,f.config.keys);assert.equal(after.fingerprint,before.fingerprint);assert.equal(after.highWater,before.highWater);assert.notEqual(c.newHead.safetyCold!.cipherDigest,a.newHead.safetyCold!.cipherDigest);
 open(f,c.newHead);const backup=join(f.root,'backup');f.v.exportBackup(backup);const m=AnchoredVault.migrateBackup({...request(f,'migrate'),backupDirectory:backup,targetSchema:2});assert.equal(m.newHead.schemaVersion,2);assert.equal(snapshot(m.newHead,f.config.keys).highWater,before.highWater);assert.equal(snapshot(m.newHead,f.config.keys).stats.count,1);
});

test('P4 globals over new bound refuse whole upgrade before target or receipt',t=>{
 const f=fixture(t,COLD_SAFETY_PROFILE);f.v.source({id:'source',revision:1,extra:'x'.repeat(65536)} as any);const old=f.v.head,source=hashes(old.directory),req=request(f,'over-bound');assert.throws(()=>AnchoredVault.upgradeStorage({...req,storageProfile:SAFETY_V2_PROFILE}),/SAFETY_V2_BOUND/);assert.equal(existsSync(req.targetDirectory),false);assert.deepEqual(f.authority.inspect('v')!.head,old);assert.equal(f.authority.transaction(tx=>tx.receipt('v',req.operationId)),null);assert.deepEqual(hashes(old.directory),source);
});

test('v2 12 MiB pressure retains an admissible delta chain and fresh reopen',t=>{
 const f=fixture(t);for(let i=0;i<12;i++)f.v.source({id:`source-${i}`,revision:1});
 const read=()=>safetyOperation(()=>{const d=reconstructSafetyV2(f.v.head,directoryReader(f.config.directory),f.config.keys,2);try{return d.baseline.depth;}finally{d.close();}});
 // This separate input fits both gates; it does not exercise W fallback.
 assert.ok(read()>10);safetyOperation(()=>{const release=safetyWorkspace().reserve(12*1024*1024,'already-live synthetic operation resources');try{f.v.source({id:'after-pressure',revision:1});}finally{release();}});
 assert.equal(read(),14);assert.equal(f.v.status.lastSourceRef!.id,'after-pressure');const head=f.v.head;open(f,head);assert.equal(f.v.status.lastSourceRef!.id,'after-pressure');
});

test('v2 stricter fresh-boot admission refuses the former 14 MiB pressure case before staging',t=>{
 const f=fixture(t);for(let i=0;i<12;i++)f.v.source({id:`source-${i}`,revision:1});const before=f.v.head,files=hashes(before.directory);
 assert.throws(()=>safetyOperation(()=>{const release=safetyWorkspace().reserve(14*1024*1024,'already-live synthetic operation resources');try{f.v.source({id:'refused',revision:1});}finally{release();}}),/SAFETY_V2_WORKSPACE/);
 assert.deepEqual(f.authority.inspect('v')!.head,before);assert.equal(f.authority.inspect('v')!.status,'ACTIVE');assert.deepEqual(hashes(before.directory),files);open(f,before);assert.equal(f.v.status.lastSourceRef!.id,'source-11');
});

test('v2 base recovery workspace refusal leaves exact CURRENT and no staged file',t=>{
 const f=fixture(t),before=f.v.head,files=hashes(before.directory);assert.throws(()=>safetyOperation(()=>{const release=safetyWorkspace().reserve(20*1024*1024,'already-live synthetic resources');try{f.v.source({id:'refused',revision:1});}finally{release();}}),/SAFETY_V2_WORKSPACE/);
 assert.deepEqual(f.authority.inspect('v')!.head,before);assert.equal(f.authority.inspect('v')!.status,'ACTIVE');assert.deepEqual(hashes(before.directory),files);assert.throws(()=>f.v.status,/ANCHOR_UNAVAILABLE/);
});

for(const action of ['repack','fanout'] as const)test(`v2 ${action} keeps complete Safety while maintaining the Store image`,t=>{
 const f=fixture(t,SAFETY_V2_PROFILE,2,action==='fanout'?2:1),scope=f.v.store.ensureScope({tenantId:'t',subjectId:'s',personaId:'p',relationshipId:'r'});
 for(let i=0;i<8;i++)f.v.store.acceptEvent(scope,{source:'synthetic',eventKey:`event-${i}`,evidence:{speakerId:'s',speakerRole:'subject',mode:'self_report',selectedText:'x'.repeat(4000),occurredAt:null}});
 f.v.store.purge(scope);f.v.claim('old','p');f.v.terminal('old','failed');const a=AnchoredVault.archiveTerminalSafetyV2(request(f,'archive')),before=snapshot(a.newHead,f.config.keys);
 let next;try{next=action==='repack'?AnchoredVault.repackStore(request(f,'repack')):AnchoredVault.maintainFanout({...request(f,'fanout'),retainBatches:1,resetConsumerIds:[]});}catch(error){if(action!=='repack'||!(error instanceof CoreError)||error.code!=='REPACK_RUNTIME')throw error;assert.notEqual(process.version,'v24.16.0','audited runtime must exercise positive repack');assert.equal(existsSync(join(f.root,'repack')),false);assert.deepEqual(f.authority.inspect('v')!.head,a.newHead);console.log('SAFETY_V2_REPACK_CAPABILITY',JSON.stringify({node:process.version,physicalRepack:'RUNTIME_REFUSAL_VERIFIED'}));return;}
 const after=snapshot(next.newHead,f.config.keys);assert.equal(after.fingerprint,before.fingerprint);assert.equal(after.highWater,before.highWater);assert.equal(after.cold,1);open(f,next.newHead);assert.throws(()=>f.v.claim('old','p'),/INTERACTION_TERMINATED/);
});

test('v2 backup exact dependency closure rejects missing and extra files',t=>{
 const f=fixture(t);f.v.claim('old','p');f.v.terminal('old','failed');const a=AnchoredVault.archiveTerminalSafetyV2(request(f,'archive'));open(f,a.newHead);const backup=join(f.root,'backup');f.v.exportBackup(backup);const file=join(backup,a.newHead.safetyCold!.file),kept=join(f.root,'retained-cold.bin'),args={backupDirectory:backup,authority:f.authority,keys:f.config.keys,maxCalls:2};
 renameSync(file,kept);assert.throws(()=>AnchoredVault.verifyBackup(args));renameSync(kept,file);AnchoredVault.verifyBackup(args);writeFileSync(join(backup,'extra.bin'),'extra',{flag:'wx'});assert.throws(()=>AnchoredVault.verifyBackup(args),/ANCHOR_BACKUP/);
});

test('v2 fresh process reopen validates both parts of the ledger and boot keeps quota',t=>{
 const f=fixture(t);f.v.claim('old','p');f.v.reserve('old');f.v.terminal('old','failed');f.v.claim('pending','p');const a=AnchoredVault.archiveTerminalSafetyV2(request(f,'archive'));f.v.close();
 const script=`import {AnchoredVault} from './src/anchored-vault.ts';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const chunks=[];for await(const c of process.stdin)chunks.push(c);const x=JSON.parse(Buffer.concat(chunks)),authority=LocalSqliteAuthority.open(x.authority),keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')};const v=AnchoredVault.open({...x.config,keys,authority},2,{clock:{wall:()=>100,monotonic:()=>0}});console.log(JSON.stringify(v.status));v.close();authority.close();`;
 const child=spawnSync(process.execPath,['--max-old-space-size=256','--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,timeout:20000,encoding:'utf8',input:JSON.stringify({authority:f.authorityConfig,config:{directory:a.newHead.directory,vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:SAFETY_V2_PROFILE},keys:{version:2,keyEpoch:1,storageDEK:Buffer.from(f.config.keys.storageDEK).toString('base64'),ingressKey:Buffer.from(f.config.keys.ingressKey).toString('base64')}})});
 assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout.trim());assert.equal(result.ingressCount,2);assert.equal(result.hotIngressCount,1);assert.equal(result.coldIngressCount,1);assert.equal(result.consumedRequests,1);assert.equal(result.unknownRequests,2);
});
