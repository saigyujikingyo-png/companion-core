// Synthetic, bounded IF10 cost experiment. Run once per cohort in its own process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const cohort=process.argv[2],sizes={small:2,mixed:12,'high-terminal':64,'amortization-256':256};
if(!Object.hasOwn(sizes,cohort))throw Error('expected small, mixed, high-terminal, or amortization-256');
const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),`if10-cost-${cohort}-`))),N=cohort==='amortization-256'?64:24;
const original={open:fs.openSync,close:fs.closeSync,write:fs.writeFileSync,fsync:fs.fsyncSync},handles=new Map();
let meter;
const fresh=()=>({applicationWriteBytes:0,applicationWriteCalls:0,applicationFsyncCalls:0,applicationFsyncMs:0,byKind:{}});
const kind=path=>{const n=basename(String(path));return n.startsWith('blob-')?'frame':n.startsWith('stage-')?'stage':n.startsWith('record-')?'record':n.startsWith('safety-')?'cold':n.startsWith('AnchoredVault.')?'marker':'other';};
fs.openSync=function(path,...args){const fd=original.open(path,...args);handles.set(fd,String(path));return fd;};
fs.closeSync=function(fd){try{return original.close(fd);}finally{handles.delete(fd);}};
fs.writeFileSync=function(path,data,...args){const result=original.write(path,data,...args);if(meter){const n=typeof data==='string'?Buffer.byteLength(data):data.byteLength,k=kind(typeof path==='number'?handles.get(path):path);meter.applicationWriteBytes+=n;meter.applicationWriteCalls++;meter.byKind[k]=(meter.byKind[k]??0)+n;}return result;};
fs.fsyncSync=function(fd){const started=performance.now();const result=original.fsync(fd);if(meter){meter.applicationFsyncCalls++;meter.applicationFsyncMs+=performance.now()-started;}return result;};
syncBuiltinESMExports();
const {AnchoredVault}=await import('../src/anchored-vault.ts');
const {LocalSqliteAuthority}=await import('../src/local-sqlite-authority.ts');
const {generateKeySet}=await import('../src/anchored-codec.ts');
const {reconstruct,directoryReader}=await import('../src/incremental-storage.ts');
const {canonicalSafetyJSON,COLD_SAFETY_PROFILE}=await import('../src/safety-format.ts');
const {sha}=await import('../src/durable-codec.ts');
const authority=LocalSqliteAuthority.create({directory:join(root,'authority'),authorityId:'a',custodyDomain:'independent'}),keys=generateKeySet(),clock={wall:()=>100,monotonic:()=>0};
let config={directory:join(root,'p3'),vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:'blocks-br4-safety-br4-v1',authority,keys},vault;
const bytes=path=>fs.readdirSync(path,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?bytes(join(path,e.name)):fs.statSync(join(path,e.name)).size),0),authorityBytes=()=>bytes(authority.directory);
function measure(fn){meter=fresh();const a=authorityBytes(),start=performance.now(),value=fn(),result={...meter,wallMs:performance.now()-start,authorityExtentDeltaBytes:authorityBytes()-a,authorityExtentBytes:authorityBytes()};meter=undefined;return{value,...result};}
function snapshot(head){const start=performance.now(),d=reconstruct(head,directoryReader(head.directory),keys,32);try{return{
  safetyJSON:canonicalSafetyJSON(d.state.safety),safetyBytes:Buffer.byteLength(canonicalSafetyJSON(d.state.safety)),imageHash:sha(d.image),imageBytes:d.image.length,
  coldCount:d.ledger.coldCount,hotCount:d.ledger.hotCount,coldCipherBufferBytes:head.safetyCold?.cipherBytes??0,coldSQLitePlainBufferBytes:head.safetyCold?.plainBytes??0,
  sqliteOwnedMemoryBytes:'NOT_MEASURED',hotJSONBytes:Buffer.byteLength(canonicalSafetyJSON(d.ledger.hotEnvelope())),requiredChainEncodedBytes:d.baseline.readBytes,
  requiredChainDecodedBytes:d.baseline.decodedBytes,requiredFiles:d.files.size,headFrameBytes:d.stage.blobLength,restoreMs:performance.now()-start,
  processMemory:process.memoryUsage(),processMaxRSSKiB:process.resourceUsage().maxRSS};}finally{d.image.fill(0);d.ledger.close();}}
const publicHistory={acceptedRequests:0,reservations:0,terminalChanges:0,feedbackChanges:0};
const setup=measure(()=>{
  vault=AnchoredVault.create(config,32,{clock});
  for(let i=0;i<sizes[cohort];i++){
    const key=`request-${i}`;vault.claim(key,'synthetic stable payload');publicHistory.acceptedRequests++;
    if(cohort!=='mixed'||i%4===0){vault.terminal(key,'failed');publicHistory.terminalChanges++;}
    else if(i%4===1){vault.reserve(key);publicHistory.reservations++;vault.terminal(key,'unknown');publicHistory.terminalChanges++;}
    else {vault.reserve(key);publicHistory.reservations++;for(const state of ['ready','taken','acknowledged']){vault.terminal(key,state,`delivery-${i}`);publicHistory.terminalChanges++;}
      if(i%4===2){vault.consumeFeedback(`delivery-${i}`);publicHistory.feedbackChanges++;}}
  }
  vault.close();vault=AnchoredVault.open(config,32,{clock});vault.source({id:'cycle-start',revision:1});
});
const start=snapshot(vault.head),initialRetainedBytes=bytes(root),sequence=()=>{for(let i=0;i<N;i++)vault.source({id:i===N-1?'cycle-start':`cycle-${i}`,revision:1});};
const p3=measure(sequence),p3End=snapshot(vault.head);assert.equal(start.safetyJSON,p3End.safetyJSON);assert.equal(start.imageHash,p3End.imageHash);
const p3Backup=join(root,'p3-backup'),p3BackupCost=measure(()=>vault.exportBackup(p3Backup)),p3RetainedBytes=bytes(root),request=name=>({authority,keys,vaultId:'v',maxCalls:32,targetDirectory:join(root,name),storageDomain:'payload',operationId:name});
vault.close();const upgrade=measure(()=>AnchoredVault.upgradeStorage({...request('p4-upgrade'),storageProfile:COLD_SAFETY_PROFILE})),archive=measure(()=>AnchoredVault.archiveTerminalSafety(request('p4-archive')));
const p4Maintenance=snapshot(archive.value.newHead);assert.equal(start.safetyJSON,p4Maintenance.safetyJSON);assert.equal(start.imageHash,p4Maintenance.imageHash);
config={...config,directory:archive.value.newHead.directory,storageProfile:COLD_SAFETY_PROFILE};const p4Boot=measure(()=>{vault=AnchoredVault.open(config,32,{clock});});
const p4Start=snapshot(vault.head);assert.equal(start.safetyJSON,p4Start.safetyJSON);assert.equal(start.imageHash,p4Start.imageHash);
const p4=measure(sequence),p4End=snapshot(vault.head),p4Backup=join(root,'p4-backup'),p4BackupCost=measure(()=>vault.exportBackup(p4Backup));
assert.equal(start.safetyJSON,p4End.safetyJSON);assert.equal(start.imageHash,p4End.imageHash);
const p4RetainedBytes=bytes(root),sum=(...rows)=>rows.reduce((n,r)=>n+r.applicationWriteBytes,0),withoutValue=({value,...rest})=>rest;
const result={version:1,cohort,root,method:'same-vault cyclic public source updates; exact logical Safety and Store image equality checked at each arm boundary',node:process.version,
  publicHistory,subsequentChangesPerArm:N,subsequentAddedBusinessContentBytes:0,maintenanceAddedBusinessContentBytes:0,
  normalizedInitialSafetyJSONBytes:start.safetyBytes,
  normalizedAddedIngressJSONBytes:Buffer.byteLength(canonicalSafetyJSON(JSON.parse(start.safetyJSON).ingress))-Buffer.byteLength('[]'),
  comparison:{p3SubsequentAppBytes:p3.applicationWriteBytes,p4SubsequentAppBytes:p4.applicationWriteBytes,
    p4UpgradeArchiveBootAppBytes:sum(upgrade,archive,p4Boot),p3FollowingPlusBackupAppBytes:sum(p3,p3BackupCost),p4MaintenanceFollowingPlusBackupAppBytes:sum(upgrade,archive,p4Boot,p4,p4BackupCost),
    netP4MinusP3AppBytes:sum(upgrade,archive,p4Boot,p4,p4BackupCost)-sum(p3,p3BackupCost)},
  measurements:{setup:withoutValue(setup),p3Following:withoutValue(p3),p3Backup:withoutValue(p3BackupCost),upgrade:withoutValue(upgrade),archive:withoutValue(archive),p4Boot:withoutValue(p4Boot),p4Following:withoutValue(p4),p4Backup:withoutValue(p4BackupCost)},
  disk:{initialRetainedBytes,p3RetainedBytes,p4RetainedBytes,extraRetainedP4WorkflowBytes:p4RetainedBytes-p3RetainedBytes,p3BackupBytes:bytes(p3Backup),p4BackupBytes:bytes(p4Backup),
    note:'Actual serial workflow retains initial generation, the P3 comparison writes/backup, P4 upgrade generation, archive generation, all stages and both backups; no deletion or derived device-write claim.'},
  snapshots:{initial:withoutPrivate(start),p3End:withoutPrivate(p3End),p4BeforeBoot:withoutPrivate(p4Maintenance),p4End:withoutPrivate(p4End)},
  memory:{processPeakRSSKiB:process.resourceUsage().maxRSS,sqliteOwnedMemoryBytes:'NOT_MEASURED',stagingPeakBytes:'NOT_MEASURED',note:'Peak process RSS includes SQLite-owned RAM, encrypted and plaintext buffers, hot/full JSON, Store image and staging allocations; component lifetimes overlap, do not sum snapshots.'},
  measurementBoundary:{applicationWrites:'Actual successful Node writeFileSync calls; fsync is counted separately, never as a second write.',authoritySQLiteInternalWriteBytes:'NOT_MEASURED',authoritySQLiteInternalFsyncs:'NOT_MEASURED',authority:'Measured full SQLite/sidecar extent and change separately; includes retained authority footprint, not an IO-byte estimate.',deviceIO:'NOT_MEASURED'}};
function withoutPrivate({safetyJSON,...rest}){return rest;}
vault.close();authority.close();const output=resolve(root,'result.json');original.write(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
