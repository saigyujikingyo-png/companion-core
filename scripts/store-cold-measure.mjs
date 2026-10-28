// Fixed synthetic IF12 measurement. Root reviews this source before one execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
export const protocol=Object.freeze({version:1,schema:2,historyEvents:32,memoriesPerEvent:1,consumers:2,followingEvents:64,
  selector:'one-purged-generation-v1',arms:['P4 compact','P5 archive'],api:'public MemoryStore and AnchoredVault only',
  historyComparison:'Equivalent public workloads with independent random identities and keys, not byte-identical histories. Each arm checks its own exact full logical fingerprint across maintenance.',
  comparisonTotal:'maintenance + boot + 64 following events + verification + backup; setup reported separately',
  originalSources:'retained',partialFailedWrites:'NOT_MEASURED',sqlitePhysicalIO:'NOT_MEASURED',deviceIO:'NOT_MEASURED',parameters:'fixed; no search or retry'});
if(process.argv[2]!=='--run-once'){console.log(JSON.stringify(protocol,null,2));process.exit(0);}
const root=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),'if12-cost-fixed-'))),original={open:fs.openSync,close:fs.closeSync,write:fs.writeFileSync,fsync:fs.fsyncSync},handles=new Map();let meter;
const kind=path=>{const n=basename(String(path));return n.startsWith('blob-')?'frame':n.startsWith('stage-')?'stage':n.startsWith('record-')?'record':n.startsWith('store-')?'storeCold':n.startsWith('safety-')?'safetyCold':n.startsWith('AnchoredVault.')?'marker':'other';};
fs.openSync=function(path,...args){const fd=original.open(path,...args);handles.set(fd,String(path));return fd;};
fs.closeSync=function(fd){try{return original.close(fd);}finally{handles.delete(fd);}};
fs.writeFileSync=function(path,data,...args){const result=original.write(path,data,...args);if(meter){const size=typeof data==='string'?Buffer.byteLength(data):data.byteLength,k=kind(typeof path==='number'?handles.get(path):path);meter.applicationWriteBytes+=size;meter.applicationWriteCalls++;meter.byKind[k]=(meter.byKind[k]??0)+size;}return result;};
fs.fsyncSync=function(fd){const start=performance.now(),result=original.fsync(fd);if(meter){meter.applicationFsyncCalls++;meter.applicationFsyncMs+=performance.now()-start;}return result;};
syncBuiltinESMExports();
const {AnchoredVault}=await import('../src/anchored-vault.ts'),{LocalSqliteAuthority}=await import('../src/local-sqlite-authority.ts'),{generateKeySet}=await import('../src/anchored-codec.ts');
const {reconstruct,directoryReader}=await import('../src/incremental-storage.ts'),{storeLogicalFingerprint}=await import('../src/store-cold.ts');
const {COLD_SAFETY_PROFILE}=await import('../src/safety-format.ts');
const bytes=path=>fs.readdirSync(path,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?bytes(join(path,e.name)):fs.statSync(join(path,e.name)).size),0);
const who={tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test'},clock={wall:()=>100,monotonic:()=>0};
const input=key=>({source:'synthetic',eventKey:key,evidence:{speakerId:'subject',speakerRole:'subject',mode:'self_report',selectedText:`IF12 fixed public event ${key}`,occurredAt:null}});
function measure(authority,body){meter={applicationWriteBytes:0,applicationWriteCalls:0,applicationFsyncCalls:0,applicationFsyncMs:0,byKind:{}};const before=bytes(authority.directory),started=performance.now();
  try{const value=body();return{value,...meter,wallMs:performance.now()-started,authorityExtentDeltaBytes:bytes(authority.directory)-before,authorityExtentBytes:bytes(authority.directory)};}finally{meter=undefined;}}
const compact=({value,...rest})=>rest;
function snapshot(head,keys){const start=performance.now(),d=reconstruct(head,directoryReader(head.directory),keys,4);try{return{logicalFingerprint:storeLogicalFingerprint(d.image,2),fullImageBytes:d.image.length,hotCarrierBytes:d.baseline.image.length,
  storeColdPlainBytes:head.storeCold?.plainBytes??0,storeColdCipherBytes:head.storeCold?.cipherBytes??0,safetyColdPlainBytes:head.safetyCold?.plainBytes??0,safetyColdCipherBytes:head.safetyCold?.cipherBytes??0,
  requiredFiles:d.files.size,requiredEncodedBytes:d.baseline.readBytes,requiredDecodedBytes:d.baseline.decodedBytes,restoreMs:performance.now()-start,processMemory:process.memoryUsage(),processMaxRSSKiB:process.resourceUsage().maxRSS};
  }finally{d.image.fill(0);d.baseline.image.fill(0);d.ledger.close();d.storeCold?.close();}}
function runArm(label){const arm=join(root,label);fs.mkdirSync(arm);const authority=LocalSqliteAuthority.create({directory:join(arm,'authority'),authorityId:'a',custodyDomain:'independent'}),keys=generateKeySet();
  let config={directory:join(arm,'source'),vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:COLD_SAFETY_PROFILE,schemaVersion:2,authority,keys},vault,scope;
  const request=name=>({authority,keys,vaultId:'v',maxCalls:4,targetDirectory:join(arm,name),storageDomain:'payload',operationId:name});
  try{
    const setup=measure(authority,()=>{vault=AnchoredVault.create(config,4,{clock});scope=vault.store.ensureScope(who);
      vault.store.registerConsumer('retrieval',scope,'retrieval-refs-v1');vault.store.registerConsumer('scene',scope,'scene-source-refs-v1');
      for(let i=0;i<protocol.historyEvents;i++){const e=vault.store.acceptEvent(scope,input(`old-${i}`)),j=vault.store.beginJob(scope,[e]),lease=vault.store.claimLease(scope,j.id);
        vault.store.propose(scope,j.id,lease.token,{kind:'claim',statement:`IF12 fixed memory ${i}`,basis:'self_report',validFrom:null,validTo:null});vault.store.publish(scope,j.id,lease.token);}
      scope=vault.store.purge(scope);vault.store.applyConsumers(['retrieval','scene'].map(id=>vault.store.bindConsumer(id,scope)));
      vault.claim('unknown','synthetic');vault.reserve('unknown');vault.terminal('unknown','unknown');
      const safety=AnchoredVault.archiveTerminalSafety(request('safety'));vault.close();config={...config,directory:safety.newHead.directory};vault=AnchoredVault.open(config,4,{clock});
      scope=vault.store.scope(scope.id);vault.store.applyConsumers(['retrieval','scene'].map(id=>vault.store.bindConsumer(id,scope)));
    });
    const initial=snapshot(vault.head,keys),initialRetainedBytes=bytes(arm);vault.close();
    const maintenance=measure(authority,()=>label==='p5'?AnchoredVault.archiveStoreTerminals(request('maintenance')):AnchoredVault.compact(request('maintenance'))),head=maintenance.value.newHead;
    const maintained=snapshot(head,keys);assert.equal(maintained.logicalFingerprint,initial.logicalFingerprint);
    config={...config,directory:head.directory,storageProfile:head.storageProfile};
    const boot=measure(authority,()=>{vault=AnchoredVault.open(config,4,{clock});scope=vault.store.scope(scope.id);});
    const following=measure(authority,()=>{for(let i=0;i<protocol.followingEvents;i++)vault.store.acceptEvent(scope,input(`new-${i}`));});
    const verification=measure(authority,()=>{assert.equal(vault.store.acceptEvent(scope,input('old-0')).currentStatus,'revoked');assert.throws(()=>vault.store.acceptEvent(scope,{...input('old-0'),evidence:{...input('old-0').evidence,selectedText:'conflict'}}),/IDEMPOTENCY_CONFLICT/);
      const last=vault.store.acceptEvent(scope,input('new-63'));vault.store.revoke(scope,last);assert.equal(vault.store.acceptEvent(scope,input('new-63')).currentStatus,'revoked');assert.throws(()=>vault.claim('unknown','synthetic'),/INTERACTION_TERMINATED/);assert.equal(vault.reserved,1);
      for(const id of ['retrieval','scene']){const handle=vault.store.bindConsumer(id,scope);vault.store.applyConsumers([handle]);assert.deepEqual(vault.store.readConsumer(handle).refs,[]);}
    });
    const backupDirectory=join(arm,'backup'),backup=measure(authority,()=>vault.exportBackup(backupDirectory)),end=snapshot(vault.head,keys);
    const costs={setup:compact(setup),maintenance:compact(maintenance),boot:compact(boot),following:compact(following),verification:compact(verification),backup:compact(backup)};
    return{costs,snapshots:{initial,maintained,end},disk:{initialRetainedBytes,finalRetainedBytes:bytes(arm),retainedIncrementBytes:bytes(arm)-initialRetainedBytes,backupBytes:bytes(backupDirectory)},
      comparisonWriteBytes:[maintenance,boot,following,verification,backup].reduce((n,c)=>n+c.applicationWriteBytes,0)};
  }finally{vault?.close();authority.close();}}
let result;
try{const p4=runArm('p4'),p5=runArm('p5');result={status:'MEASURED',protocol,node:process.version,root,p4,p5,
  comparison:{netP5MinusP4ApplicationWriteBytes:p5.comparisonWriteBytes-p4.comparisonWriteBytes,netP5MinusP4RetainedIncrementBytes:p5.disk.retainedIncrementBytes-p4.disk.retainedIncrementBytes},
  memory:{processPeakRSSKiB:process.resourceUsage().maxRSS,sqliteOwnedMemoryBytes:'NOT_MEASURED',note:'One-process peak includes both sequential arms and SQLite; not a per-arm memory-saving claim.'},
  boundary:{applicationWrites:'Successful Node writeFileSync calls only; fsync counted separately, never doubled as writes.',partialFailedWrites:'NOT_MEASURED',sqlitePhysicalWrites:'NOT_MEASURED',sqlitePhysicalFsyncs:'NOT_MEASURED',deviceIO:'NOT_MEASURED',retained:'Both original generations, maintenance generations, stages, authority extents and backups retained.',
    acceptance:'Hot-carrier shrink alone does not establish lower total writes; report the complete comparison total and retained increment, including negative results.'}};
}catch(error){result={status:'FAILED',protocol,node:process.version,root,error:String(error),stack:error.stack};process.exitCode=1;}
const output=join(root,'result.json');original.write(output,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({output,...result}));
