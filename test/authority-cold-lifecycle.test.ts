import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,readdirSync,renameSync,existsSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {AnchoredVault} from '../src/anchored-vault.ts';
import {generateKeySet} from '../src/anchored-codec.ts';
import {sha} from '../src/durable-codec.ts';
import type {PendingCommit} from '../src/local-sqlite-authority.ts';
import {DurableMemory} from '../src/durable-memory.ts';
import {inspectLegacyM2} from '../src/legacy-m2-import.ts';
import {ColdWorkspace,loadCurrent} from '../src/authority-cold-storage.ts';
import {ColdDatabase,copyRow,descriptorOf,metaOf,hashRows,frameBytes,utf8} from '../src/authority-cold-format.ts';
import type {Intent} from '../src/authority-cold-format.ts';
import {parseReceiptPointer} from '../src/receipt-segments.ts';

function fixture(t:TestContext){const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-if11-life-'))),ac={directory:join(root,'authority'),authorityId:'synthetic',custodyDomain:'independent',writeLimitBytes:524288};
 LocalSqliteAuthority.create(ac).close();LocalSqliteAuthority.upgradeSchema(ac,'operator-attested-stopped');LocalSqliteAuthority.upgradeReceiptSchema(ac,'operator-attested-stopped');LocalSqliteAuthority.upgradeColdSchema(ac,'operator-attested-stopped');
 const authority=LocalSqliteAuthority.open(ac),config={directory:join(root,'vault'),vaultId:'vault',identity:'synthetic',storageDomain:'payload',storageProfile:'blocks-br4-v1' as const,schemaVersion:2 as const,keys:generateKeySet(),authority},vault=AnchoredVault.create(config,8,{clock:{wall:()=>100,monotonic:()=>0}});
 for(let i=0;i<35;i++)vault.claim('fill-'+i,'synthetic');t.after(()=>{vault.close();authority.close();});return{root,ac,authority,config,vault};}
const request={operationId:'ac1-lifecycle',expectedRouteEpoch:0};
function rootHash(f:ReturnType<typeof fixture>){return sha(readFileSync(join(f.ac.directory,'authority.sqlite')));}
function child(f:ReturnType<typeof fixture>,body:string){return spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {DatabaseSync} from 'node:sqlite';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const config=JSON.parse(fs.readFileSync(0,'utf8'));${body}`],{cwd:process.cwd(),input:JSON.stringify(f.ac),encoding:'utf8',windowsHide:true,timeout:30000});}
function legacyStageFixture(f:ReturnType<typeof fixture>,partial:boolean){
 const result=child(f,`const paths=new Map(),open=fs.openSync,flush=fs.fsyncSync;fs.openSync=function(path,...args){const fd=open.call(this,path,...args);paths.set(fd,String(path));return fd;};fs.fsyncSync=function(fd){flush.call(this,fd);if((paths.get(fd)||'').endsWith('cold-slot-0.sqlite'))process.exit(42);};syncBuiltinESMExports();LocalSqliteAuthority.open(config).archivePermanentKeys(${JSON.stringify(request)});`);assert.equal(result.status,42,result.stderr);
 const ip=join(f.ac.directory,'cold-slot-0.intent.json'),pp=join(f.ac.directory,'cold-slot-0.sqlite'),bytes=readFileSync(ip),intent=JSON.parse(bytes.toString()) as Intent,w=new ColdWorkspace(),loaded=loadCurrent(f.ac.directory,descriptorOf(intent,bytes),w),owned:ReturnType<typeof copyRow>[]=[];
 let legacy:ColdDatabase|undefined,serialized:ReturnType<ColdDatabase['serialize']>|undefined;
 try{for(const kind of ['L','M','R','S'] as const)for(const row of loaded.db.rows(kind))owned.push(copyRow(row,w));let rows=owned.map(x=>x.row);
  if(partial){const missing=rows.find(r=>r.kind==='R'&&parseReceiptPointer(utf8(r.values[2] as Uint8Array)));assert.ok(missing);rows=rows.filter(r=>r!==missing);intent.counts.receipts--;intent.moved.receipts--;intent.moved.framedBytes-=frameBytes(missing);intent.moved.skipped.receipts++;const hash=hashRows();for(const row of rows)hash.add(row);intent.selectionDigest=hash.finish();}
  // Original v1 builder order: the complete frozen rows sorted L/M/R/S, without physical-fit filtering.
  legacy=ColdDatabase.build(metaOf(intent),rows,w);serialized=legacy.serialize();intent.payloadBytes=serialized.bytes.length;intent.payloadDigest=sha(serialized.bytes);
  renameSync(ip,join(f.root,'retained-original-stage.intent.json'));renameSync(pp,join(f.root,'retained-original-stage.sqlite'));writeFileSync(ip,JSON.stringify(intent),{flag:'wx'});writeFileSync(pp,serialized.bytes,{flag:'wx'});return{intent:sha(readFileSync(ip)),payload:sha(readFileSync(pp))};
 }finally{serialized?.close();legacy?.close();loaded.close();for(const x of owned)x.close();assert.equal(w.used,0);}
}
for(const point of ['intent','payload','delete','route','commit'] as const)test(`T07 real child exit at ${point} preserves original or completely published mapping`,t=>{
 const f=fixture(t),before=f.authority.inspectCapacity().receipts;f.vault.close();
 const script=`const a=LocalSqliteAuthority.open(config),paths=new Map(),open=fs.openSync,flush=fs.fsyncSync,prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let published=false;
 fs.openSync=function(path,...args){const fd=open.call(this,path,...args);paths.set(fd,String(path));return fd;};
 fs.fsyncSync=function(fd){flush.call(this,fd);const p=paths.get(fd)||'';if((${JSON.stringify(point)}==='intent'&&p.endsWith('.intent.json'))||(${JSON.stringify(point)}==='payload'&&p.endsWith('.sqlite')&&!p.endsWith('authority.sqlite')))process.exit(42);};syncBuiltinESMExports();
 DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql),run=statement.run;statement.run=function(...args){const result=run.apply(this,args);if(sql.startsWith('UPDATE authority_cold_route'))published=true;if((${JSON.stringify(point)}==='delete'&&sql.startsWith('DELETE FROM receipts'))||(${JSON.stringify(point)}==='route'&&published))process.exit(42);return result;};return statement;};
 DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(${JSON.stringify(point)}==='commit'&&published&&sql==='COMMIT')process.exit(42);return result;};a.archivePermanentKeys(${JSON.stringify(request)});`;
 const result=child(f,script);assert.equal(result.status,42,result.stderr);const current=LocalSqliteAuthority.open(f.ac);t.after(()=>current.close());assert.deepEqual(current.inspectCapacity().receipts,before);
 if(point==='intent'){assert.throws(()=>current.archivePermanentKeys(request),/ANCHOR_COLD_STAGE_INCOMPLETE/);assert.equal(current.inspectCapacity().coldRouting!.epoch,0);}
 else{const receipt=current.archivePermanentKeys(request);assert.equal(receipt.toEpoch,1);assert.equal(current.inspectCapacity().coldRouting!.occupiedSlots,1);}
 assert.ok(existsSync(join(f.ac.directory,'cold-slot-0.intent.json')));
});
test('T09 current closure repairs only absent exact bound files, including a PREPARED dependency',t=>{
 const f=fixture(t);f.authority.archivePermanentKeys(request);const backup=join(f.root,'closure');f.authority.exportColdClosure(backup);
 const payload=join(f.ac.directory,'cold-slot-0.sqlite'),retained=join(f.root,'retained-current-payload.sqlite');renameSync(payload,retained);const before=rootHash(f);
 assert.throws(()=>f.authority.inspectCapacity());assert.throws(()=>f.authority.verifyColdClosure(backup));f.authority.repairMissingColdClosure(backup);assert.equal(rootHash(f),before);assert.ok(readFileSync(payload).equals(readFileSync(retained)));
 f.vault.close();let armed=false;const live=AnchoredVault.open(f.config,8,{clock:{wall:()=>100,monotonic:()=>0},fault:p=>{if(armed&&p==='prepared')throw Error('SYNTHETIC_PENDING');}});t.after(()=>live.close());armed=true;assert.throws(()=>live.claim('pending','p'));
 const pending=f.authority.inspect('vault')!.pending!;renameSync(payload,join(f.root,'retained-pending-payload.sqlite'));const pendingBefore=rootHash(f);f.authority.repairMissingColdClosure(backup);assert.equal(rootHash(f),pendingBefore);
 AnchoredVault.reconcile({authority:f.authority,vaultId:'vault',operationId:pending.operationId,keys:f.config.keys,maxCalls:8});assert.equal(f.authority.inspect('vault')!.status,'ACTIVE');
 const corrupt=Buffer.from(readFileSync(payload));corrupt[100]=corrupt[100]!^1;writeFileSync(payload,corrupt);assert.throws(()=>f.authority.repairMissingColdClosure(backup));assert.ok(readFileSync(payload).equals(corrupt));
});
test('T05 duplicate hot/cold keys, corruption and caught mutation errors fail closed',t=>{
 const f=fixture(t),db=new DatabaseSync(join(f.ac.directory,'authority.sqlite'));let original:any;try{original=db.prepare('SELECT * FROM receipts LIMIT 1').get();}finally{db.close();}
 f.authority.archivePermanentKeys(request);const mutate=new DatabaseSync(join(f.ac.directory,'authority.sqlite'));try{mutate.prepare('INSERT INTO receipts VALUES (?,?,?)').run(original.vault_id,original.operation_id,original.receipt);}finally{mutate.close();}
 assert.throws(()=>f.authority.transaction(tx=>tx.receipt('unused','absent')),/ANCHOR_COLD_DUPLICATE/);assert.throws(()=>f.authority.inspectCapacity(),/ANCHOR_COLD_DUPLICATE/);
});
test('T04/T09 old closure is stale and four immutable slots remain retained',t=>{
 const f=fixture(t);f.authority.archivePermanentKeys(request);const old=join(f.root,'old-closure');f.authority.exportColdClosure(old);
 for(let epoch=1;epoch<4;epoch++){for(let i=0;i<35;i++)f.vault.claim(`epoch-${epoch}-${i}`,'p');f.authority.archivePermanentKeys({operationId:`ac1-epoch-${epoch}`,expectedRouteEpoch:epoch});}
 assert.throws(()=>f.authority.verifyColdClosure(old),/ANCHOR_COLD_PACKAGE_STALE/);const cap=f.authority.inspectCapacity();assert.equal(cap.coldRouting!.occupiedSlots,4);assert.equal(cap.coldRouting!.cold.operations,3);assert.equal(cap.coldRouting!.hot.operations,1);assert.equal(readdirSync(f.ac.directory).length,9);
 assert.equal(f.authority.archivePermanentKeys(request).toEpoch,1);assert.throws(()=>f.authority.archivePermanentKeys({operationId:'ac1-new',expectedRouteEpoch:3}),/ANCHOR_COLD_STALE_SNAPSHOT/);
});
test('T04 an original full-batch v1 stage is reused byte-for-byte and its committed M remains idempotent',t=>{
 const f=fixture(t),roll=f.authority.rolloverReceipts({operationId:'old-stage-if8',maxReceipts:16}),hashes=legacyStageFixture(f,false),receipt=f.authority.archivePermanentKeys(request);
 assert.equal(sha(readFileSync(join(f.ac.directory,'cold-slot-0.intent.json'))),hashes.intent);assert.equal(sha(readFileSync(join(f.ac.directory,'cold-slot-0.sqlite'))),hashes.payload);assert.deepEqual(f.authority.archivePermanentKeys(request),receipt);assert.deepEqual(f.authority.rolloverReceipts({operationId:'old-stage-if8',maxReceipts:16}),roll);
});
test('T05 a self-bound staged subset missing one IF8 pointer is rejected before changing the root',t=>{
 const f=fixture(t);f.authority.rolloverReceipts({operationId:'partial-stage-if8',maxReceipts:16});const hashes=legacyStageFixture(f,true),before=rootHash(f);
 assert.throws(()=>f.authority.archivePermanentKeys(request),/ANCHOR_COLD_SELECTION/);assert.equal(rootHash(f),before);assert.equal(sha(readFileSync(join(f.ac.directory,'cold-slot-0.intent.json'))),hashes.intent);assert.equal(sha(readFileSync(join(f.ac.directory,'cold-slot-0.sqlite'))),hashes.payload);assert.equal(f.authority.inspectCapacity().coldRouting!.epoch,0);
});
function scheduled(f:ReturnType<typeof fixture>,name:string,point:'before-intent'|'after-payload'|'two-stage',operationId=request.operationId):{process:ChildProcess;ready:string;release:string;stageReady:string;stageRelease:string;done:Promise<{code:number|null;stdout:string;stderr:string}>}{
 const ready=join(f.root,name+'.ready'),release=join(f.root,name+'.release'),stageReady=join(f.root,name+'.stage-ready'),stageRelease=join(f.root,name+'.stage-release');
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const x=JSON.parse(fs.readFileSync(0,'utf8')),a=LocalSqliteAuthority.open(x.config),open=fs.openSync,flush=fs.fsyncSync,paths=new Map(),waited=new Set();
 function wait(ready,release){if(waited.has(ready))return;waited.add(ready);fs.writeFileSync(ready,'READY',{flag:'wx'});const deadline=Date.now()+20000;while(!fs.existsSync(release)){if(Date.now()>deadline)throw Error('SCHEDULE_TIMEOUT');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
 fs.openSync=function(path,...args){if((x.point==='before-intent'||x.point==='two-stage')&&String(path).endsWith('.intent.json')&&args[0]==='wx')wait(x.ready,x.release);const fd=open.call(this,path,...args);paths.set(fd,String(path));return fd;};
 fs.fsyncSync=function(fd){flush.call(this,fd);const path=paths.get(fd)||'';if(/cold-slot-[0-3]\\.sqlite$/.test(path)){if(x.point==='after-payload')wait(x.ready,x.release);if(x.point==='two-stage')wait(x.stageReady,x.stageRelease);}};syncBuiltinESMExports();try{console.log(JSON.stringify(a.archivePermanentKeys({operationId:x.operationId,expectedRouteEpoch:0})));}catch(e){console.log(e.code||e.message);}finally{a.close();}`;
 const process=spawn(globalThis.process.execPath,['--input-type=module','-e',script],{cwd:globalThis.process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';process.stdout!.on('data',d=>stdout+=d);process.stderr!.on('data',d=>stderr+=d);process.stdin!.end(JSON.stringify({config:f.ac,ready,release,stageReady,stageRelease,point,operationId}));
 const done=new Promise<{code:number|null;stdout:string;stderr:string}>(resolve=>process.on('exit',code=>resolve({code,stdout,stderr})));return{process,ready,release,stageReady,stageRelease,done};
}
async function ready(path:string){const end=Date.now()+15000;while(!existsSync(path)){if(Date.now()>end)throw Error('PARENT_SCHEDULE_TIMEOUT');await new Promise(r=>setTimeout(r,10));}}
test('T08 same-ID two uncommitted complete stages refuse ambiguity and preserve both',async t=>{
 const f=fixture(t);f.vault.close();const a=scheduled(f,'a','two-stage');t.after(()=>a.process.kill());await ready(a.ready);const b=scheduled(f,'b','two-stage');t.after(()=>b.process.kill());await ready(b.ready);
 writeFileSync(a.release,'GO',{flag:'wx'});writeFileSync(b.release,'GO',{flag:'wx'});await Promise.all([ready(a.stageReady),ready(b.stageReady)]);writeFileSync(a.stageRelease,'GO',{flag:'wx'});const ar=await a.done;writeFileSync(b.stageRelease,'GO',{flag:'wx'});const results=[ar,await b.done];for(const r of results){assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/ANCHOR_COLD_STAGE_AMBIGUOUS/);}assert.equal(f.authority.inspectCapacity().coldRouting!.epoch,0);assert.equal(f.authority.inspectCapacity().coldRouting!.occupiedSlots,2);
});
test('T08 competing same-ID commit returns original M before stale snapshot or duplicate stages',async t=>{
 const f=fixture(t);f.vault.close();const b=scheduled(f,'late','before-intent');t.after(()=>b.process.kill());await ready(b.ready);
 const receipt=f.authority.archivePermanentKeys(request);writeFileSync(b.release,'GO',{flag:'wx'});const result=await b.done;assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),receipt);assert.equal(f.authority.inspectCapacity().coldRouting!.occupiedSlots,2);
});
for(const change of ['write','rollover'] as const)test(`T08 frozen archive refuses full snapshot drift after actual ${change}`,async t=>{
 const f=fixture(t),b=scheduled(f,'stale','after-payload');t.after(()=>b.process.kill());await ready(b.ready);
 if(change==='write')f.vault.claim('during-freeze','p');else f.authority.rolloverReceipts({operationId:'during-freeze'});
 writeFileSync(b.release,'GO',{flag:'wx'});const result=await b.done;assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/ANCHOR_COLD_STALE_SNAPSHOT/);assert.equal(f.authority.inspectCapacity().coldRouting!.epoch,0);assert.equal(f.authority.inspectCapacity().coldRouting!.occupiedSlots,1);
});
test('T08 global pending blocks new archives while an original maintenance receipt remains readable',t=>{
 const f=fixture(t),receipt=f.authority.archivePermanentKeys(request);f.vault.close();let armed=false;const v=AnchoredVault.open(f.config,8,{clock:{wall:()=>100,monotonic:()=>0},fault:p=>{if(armed&&p==='prepared')throw Error('SYNTHETIC_PENDING');}});t.after(()=>v.close());armed=true;assert.throws(()=>v.claim('pending','p'));
 const before=rootHash(f);assert.deepEqual(f.authority.archivePermanentKeys(request),receipt);assert.throws(()=>f.authority.archivePermanentKeys({operationId:'ac1-blocked',expectedRouteEpoch:1}),/ANCHOR_CAPACITY_PENDING/);assert.equal(rootHash(f),before);assert.equal(f.authority.inspectCapacity().coldRouting!.occupiedSlots,1);
});
test('T05 caught preview mutation failure remains poisoned under a real cold route',t=>{
 const f=fixture(t);f.authority.archivePermanentKeys(request);const old=f.authority.inspect('vault')!.head!,bytes=Buffer.from('SYNTHETIC_AUTHORITY_ONLY_STAGE'),stagePath=join(f.config.directory,'stage-poison.json');writeFileSync(stagePath,bytes,{flag:'wx'});
 const p:PendingCommit={version:2,kind:'write',operationId:'poison',requestDigest:sha('poison'),oldHead:old,newHead:{...old,sequence:old.sequence+1,digest:sha(bytes)},stagePath,stageDigest:sha(bytes)},before=rootHash(f),prepare=DatabaseSync.prototype.prepare;
 try{DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipts VALUES (?,?,?)')throw Error('SYNTHETIC_PREVIEW');return prepare.call(this,sql);};assert.throws(()=>f.authority.transaction(tx=>{assert.throws(()=>tx.prepare(p),/SYNTHETIC_PREVIEW/);}),/ANCHOR_TRANSACTION_FAILED/);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(rootHash(f),before);assert.deepEqual(f.authority.inspect('vault')!.head,old);
});
for(const commit of [1,2])test(`T08 internal commit ${commit} expires the previous cold context before relock`,t=>{
 const f=fixture(t);f.authority.archivePermanentKeys(request);const backup=join(f.root,'closure');f.authority.exportColdClosure(backup);const payload=join(f.ac.directory,'cold-slot-0.sqlite'),exec=DatabaseSync.prototype.exec;let commits=0;
 try{DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql==='COMMIT'&&++commits===commit)renameSync(payload,join(f.root,'retained-during-relock.sqlite'));return result;};assert.throws(()=>f.vault.claim('relock','p'));}finally{DatabaseSync.prototype.exec=exec;}
 assert.ok(!existsSync(payload));assert.throws(()=>f.authority.inspect('vault'));f.authority.repairMissingColdClosure(backup);const row=f.authority.inspect('vault')!;
 if(commit===1){assert.equal(row.status,'PREPARED');AnchoredVault.reconcile({authority:f.authority,vaultId:'vault',operationId:row.pending!.operationId,keys:f.config.keys,maxCalls:8});}else assert.equal(row.status,'ACTIVE');
});
test('T04 incomplete unrelated intent blocks only new maintenance, with M priority preserved',t=>{
 const f=fixture(t),receipt=f.authority.archivePermanentKeys(request);writeFileSync(join(f.ac.directory,'cold-slot-1.intent.json'),'{',{flag:'wx'});f.vault.claim('ordinary-after-partial','p');const before=rootHash(f);
 assert.deepEqual(f.authority.archivePermanentKeys(request),receipt);assert.throws(()=>f.authority.archivePermanentKeys({operationId:'ac1-new',expectedRouteEpoch:1}),/ANCHOR_COLD_STAGE_INCOMPLETE/);assert.equal(rootHash(f),before);assert.equal(f.authority.inspectCapacity().coldRouting!.stagingBytes,1);
});
test('T08 a real legacy admission between freeze and publish invalidates the full source snapshot',async t=>{
 const f=fixture(t),source=join(f.root,'legacy');mkdirSync(source);const key=randomBytes(32),legacy=new DurableMemory({directory:source,identity:'synthetic-legacy',keyBase64:key.toString('base64')},8);t.after(()=>legacy.close());const backup=join(f.root,'legacy-backup');legacy.exportBackup(backup);
 const inspect={backupDirectory:backup,legacyKey:key,identity:'synthetic-legacy',expectedMaxCalls:8,declaredHead:legacy.head,trust:{policy:'trusted-lower-bound' as const,minimumHead:legacy.head}},inspection=inspectLegacyM2(inspect),storageDEK=randomBytes(32);
 AnchoredVault.importLegacyM2({...inspect,sourceFreeze:inspection.sourceFreeze,authority:f.authority,vaultId:'imported',targetDirectory:join(f.root,'imported'),storageDomain:'payload',storageProfile:'blocks-br4-v1',newStorageDEK:storageDEK,operationId:inspection.migrationId});
 const b=scheduled(f,'legacy-stale','after-payload');t.after(()=>b.process.kill());await ready(b.ready);f.authority.admitLegacyImport({migrationId:inspection.migrationId,head:f.authority.inspect('imported')!.head!,operationId:'admit',operatorId:'synthetic',attestation:'operator-attested-stopped'});
 writeFileSync(b.release,'GO',{flag:'wx'});const result=await b.done;assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/ANCHOR_COLD_STALE_SNAPSHOT/);assert.equal(f.authority.inspectCapacity().coldRouting!.epoch,0);
});
test('T04 an orphan payload without intent retains its slot and blocks only new maintenance',t=>{
 const f=fixture(t),receipt=f.authority.archivePermanentKeys(request);writeFileSync(join(f.ac.directory,'cold-slot-1.sqlite'),'orphan',{flag:'wx'});f.vault.claim('ordinary-after-orphan','p');assert.deepEqual(f.authority.archivePermanentKeys(request),receipt);assert.throws(()=>f.authority.archivePermanentKeys({operationId:'ac1-orphan',expectedRouteEpoch:1}),/ANCHOR_COLD_STAGE_INCOMPLETE/);assert.equal(f.authority.inspectCapacity().coldRouting!.stagingBytes,6);
});
test('T06 cold IF8 decode, export and missing repair share W and release every refused representation',t=>{
 const f=fixture(t);f.authority.rolloverReceipts({operationId:'if8-budget'});f.authority.archivePermanentKeys(request);const backup=join(f.root,'closure-budget');f.authority.exportColdClosure(backup);const before=rootHash(f),payload=join(f.ac.directory,'cold-slot-0.sqlite');
 for(const label of ['IF8 output buffer, UTF8 JSON and entries','closure output files and manifest','repair output files']){
  if(label==='repair output files')renameSync(payload,join(f.root,'retained-budget-payload.sqlite'));
  const reserve=ColdWorkspace.prototype.reserve;let hold:(()=>void)|undefined,workspace:ColdWorkspace|undefined,hits=0;
  try{ColdWorkspace.prototype.reserve=function(bytes,name){workspace=this;if(name===label&&!hits++){hold=reserve.call(this,this.limit-this.used-bytes+1,'synthetic shared W occupancy');}return reserve.call(this,bytes,name);};
   assert.throws(()=>label==='IF8 output buffer, UTF8 JSON and entries'?f.authority.inspectCapacity():label==='closure output files and manifest'?f.authority.exportColdClosure(join(f.root,'refused-export')):f.authority.repairMissingColdClosure(backup),/ANCHOR_COLD_WORKSPACE/);
  }finally{hold?.();ColdWorkspace.prototype.reserve=reserve;}
  assert.equal(hits,1);assert.equal(workspace!.used,0);assert.equal(rootHash(f),before);
 }
 assert.equal(existsSync(join(f.root,'refused-export')),false);assert.equal(existsSync(payload),false);f.authority.repairMissingColdClosure(backup);assert.equal(rootHash(f),before);
});
test('T05/T09 wrong or absent root and altered current cold bytes never become a missing key or activate a package',t=>{
 const f=fixture(t),other=fixture(t);f.authority.archivePermanentKeys(request);other.authority.archivePermanentKeys(request);const backup=join(f.root,'closure-identity');f.authority.exportColdClosure(backup);
 assert.throws(()=>other.authority.verifyColdClosure(backup),/ANCHOR_COLD_PACKAGE_STALE/);assert.throws(()=>other.authority.repairMissingColdClosure(backup),/ANCHOR_COLD_PACKAGE_STALE/);
 const payload=join(f.ac.directory,'cold-slot-0.sqlite'),bytes=readFileSync(payload);renameSync(payload,join(f.root,'retained-original-cold.sqlite'));bytes[bytes.length-1]=bytes[bytes.length-1]!^1;writeFileSync(payload,bytes,{flag:'wx'});
 assert.throws(()=>f.authority.transaction(tx=>tx.receipt('unused','absent')),/ANCHOR_COLD_DIGEST/);assert.throws(()=>f.authority.repairMissingColdClosure(backup),/ANCHOR_COLD_DIGEST/);
 f.vault.close();f.authority.close();renameSync(join(f.ac.directory,'authority.sqlite'),join(f.root,'retained-original-authority.sqlite'));assert.throws(()=>LocalSqliteAuthority.open(f.ac),/ANCHOR_MISSING/);assert.ok(existsSync(join(backup,'payload.sqlite')));
});
