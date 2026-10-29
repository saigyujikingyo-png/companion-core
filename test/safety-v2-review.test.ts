import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve,join,basename} from 'node:path';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {randomBytes} from 'node:crypto';
import {generateKeySet,INCREMENTAL_FORMAT} from '../src/anchored-codec.ts';
import type {VaultIdentity} from '../src/anchored-codec.ts';
import {SafetyView} from '../src/safety-v2-view.ts';
import {SAFETY_V2_PROFILE,SafetyWorkspace,safetyOperation,safetyWorkspace,safetyWorkspacePeak} from '../src/safety-v2-format.ts';
import {freezeSafetyV2Frame,reconstructSafetyV2} from '../src/incremental-safety-v2.ts';
import {readSafetyV2File} from '../src/safety-v2-file.ts';
import {AnchoredVault} from '../src/anchored-vault.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {COLD_SAFETY_PROFILE} from '../src/safety-format.ts';
import {parseControl,bootControl} from '../src/endogenous-durable.ts';
import {directoryReader} from '../src/incremental-storage.ts';
import {sha} from '../src/durable-codec.ts';
import {MemoryStore} from '../src/store.ts';

const identity:VaultIdentity={format:INCREMENTAL_FORMAT,authorityId:'a',vaultId:'v',identity:'synthetic',instanceId:'i',ownerEpoch:1,keyEpoch:1,directory:resolve('codec-only'),storageDomain:'payload',storageProfile:SAFETY_V2_PROFILE,safetyCold:null};
function measureSaveAdmission<T>(body:()=>T):{value:T;images:number[];raw:number[]}{
 const snapshot=MemoryStore.prototype.snapshot,reserve=SafetyWorkspace.prototype.reserve,images:number[]=[],raw:number[]=[];
 MemoryStore.prototype.snapshot=function(){const result=Reflect.apply(snapshot,this,[]);images.push(result.length);return result;};
 SafetyWorkspace.prototype.reserve=function(bytes,label){if(label==='fresh first-save encoder frame decode block decode and cold bounds')raw.push(bytes);return Reflect.apply(reserve,this,[bytes,label]);};
 try{return{value:body(),images,raw};}finally{MemoryStore.prototype.snapshot=snapshot;SafetyWorkspace.prototype.reserve=reserve;}
}
test('private boot subcap is finite and cannot disable or exceed the public RAM page bound',()=>{
 for(const pages of [0,-1,1.5,4097,NaN])assert.throws(()=>new MemoryStore(':memory:',{boundedMemoryImage:pages}),/DURABLE_LIMIT/);
 const store=new MemoryStore(':memory:',{boundedMemoryImage:256});try{assert.ok(store.snapshot().length<=256*4096);}finally{store.close();}
});
test('v2 decoded close owns original view and image despite replaced fields, getters and fill',()=>safetyOperation(()=>{
 const keys=generateKeySet(),view=SafetyView.empty(identity,0),frozen=freezeSafetyV2Frame(identity,1,'one',randomBytes(4096),view,0,keys,null,null,null),before=safetyWorkspace().used;
 const decoded=reconstructSafetyV2(frozen.stage.head,()=>frozen.blob,keys,0,frozen.stage),originalImage=decoded.image,originalView=decoded.view;
 Object.defineProperty(decoded,'image',{get(){throw Error('public image getter');}});Object.defineProperty(decoded,'view',{get(){throw Error('public view getter');}});
 originalImage.fill=(()=>{throw Error('own fill');}) as typeof originalImage.fill;originalView.close=()=>{throw Error('own close');};
 assert.doesNotThrow(()=>decoded.close());assert.equal(originalImage.every(n=>n===0),true);assert.throws(()=>originalView.validate(),/SAFETY_V2_CLOSED/);assert.equal(safetyWorkspace().used,before);assert.doesNotThrow(()=>decoded.close());
 const release=safetyWorkspace().reserve(safetyWorkspace().available,'scope still usable');release();frozen.release();view.close();
}));

test('v2 frozen release captures original erase views and always returns its ticket',()=>safetyOperation(()=>{
 const keys=generateKeySet(),view=SafetyView.empty(identity,0),frozen=freezeSafetyV2Frame(identity,1,'one',randomBytes(4096),view,0,keys,null,null,null),blob=frozen.blob,bytes=frozen.bytes,before=safetyWorkspace().used,charge=bytes.length*3+blob.length;
 blob.fill=(()=>{throw Error('own blob fill');}) as typeof blob.fill;bytes.fill=(()=>{throw Error('own stage fill');}) as typeof bytes.fill;
 Object.defineProperty(frozen,'blob',{get(){throw Error('public blob getter');}});Object.defineProperty(frozen,'bytes',{get(){throw Error('public stage getter');}});
 assert.doesNotThrow(()=>frozen.release());assert.equal(blob.every(n=>n===0),true);assert.equal(bytes.every(n=>n===0),true);assert.equal(safetyWorkspace().used,before-charge);assert.doesNotThrow(()=>frozen.release());view.close();
}));

test('v2 required marker, backup metadata and PREPARED stage never use unbounded whole-file reads',()=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),'safety-v2-metadata-'))),authority=LocalSqliteAuthority.create({directory:join(root,'authority'),authorityId:'a',custodyDomain:'authority'}),keys=generateKeySet(),clock={wall:()=>100,monotonic:()=>0};
 const config={authority,keys,directory:join(root,'vault'),vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:SAFETY_V2_PROFILE};let v=AnchoredVault.create(config,0,{clock}),blocked=0;const original=fs.readFileSync;
 fs.readFileSync=((path:any,...args:any[])=>{const name=typeof path==='string'?basename(path):'';if(['AnchoredVault.v3','backup.json','current-state.json'].includes(name)||/^stage-.*\.json$/.test(name)){blocked++;throw Error('UNBOUNDED_METADATA_READ');}return Reflect.apply(original,fs,[path,...args]);}) as typeof fs.readFileSync;syncBuiltinESMExports();
 try{
  v.claim('one','p');v.terminal('one','failed');const request={authority,keys,vaultId:'v',maxCalls:0,storageDomain:'payload',operationId:'archive',targetDirectory:join(root,'archive')},archived=AnchoredVault.archiveTerminalSafetyV2(request);v.close();v=AnchoredVault.open({...config,directory:archived.newHead.directory},0,{clock});
  const backup=join(root,'backup');v.exportBackup(backup);AnchoredVault.verifyBackup({authority,keys,maxCalls:0,backupDirectory:backup});v.close();
  const pending={...request,operationId:'pending',targetDirectory:join(root,'pending'),fault:(point:string)=>{if(point==='prepared')throw Error('synthetic-stop');}};assert.throws(()=>AnchoredVault.compact(pending),/synthetic-stop/);assert.equal(authority.inspect('v')!.status,'PREPARED');const completed=AnchoredVault.reconcile(pending);v=AnchoredVault.open({...config,directory:completed.newHead.directory},0,{clock});assert.equal(v.status.ingressCount,1);assert.equal(blocked,0);
 }finally{fs.readFileSync=original;syncBuiltinESMExports();v.close();authority.close();}
});

test('fixed FD read detects growth without enlarging its admitted allocation',()=>safetyOperation(()=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),'safety-v2-fixed-read-'))),file=join(root,'current-state.json');fs.writeFileSync(file,Buffer.alloc(32,1),{flag:'wx'});const original=fs.readSync,sizes:number[]=[];let grew=false;
 fs.readSync=((...args:any[])=>{sizes.push(args[1].byteLength);const result=Reflect.apply(original,fs,args);if(!grew){grew=true;fs.appendFileSync(file,Buffer.from([2,3]));}return result;}) as typeof fs.readSync;syncBuiltinESMExports();
 const baseline=safetyWorkspace().used,release=safetyWorkspace().reserve(32,'test admitted file');try{assert.throws(()=>readSafetyV2File(file,32),/ANCHOR_FILE/);assert.ok(sizes.length>0);assert.ok(sizes.every(n=>n<=32));}finally{fs.readSync=original;syncBuiltinESMExports();release();}assert.equal(safetyWorkspace().used,baseline);assert.equal(fs.statSync(file).size,34);
}));

test('fresh admission uses real Safety, schema2 and E3 boot without persisting preview clock or control',t=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),'safety-v2-boot-'))),authority=LocalSqliteAuthority.create({directory:join(root,'authority'),authorityId:'a',custodyDomain:'authority'}),keys=generateKeySet();
 const config={authority,keys,directory:join(root,'source'),vaultId:'v',identity:'synthetic',storageDomain:'payload',storageProfile:COLD_SAFETY_PROFILE,schemaVersion:2 as const};let v=AnchoredVault.create(config,2,{clock:{wall:()=>100,monotonic:()=>0}});
 try{
  const scope=v.store.ensureScope({tenantId:'t',subjectId:'s',personaId:'p',relationshipId:'r'});v.createEndogenousControl(scope);v.claim('pending','p');v.reserve('pending');
  const encoded=v.store.endogenousControl()!,snapshot=v.store.snapshot(),digest=sha(snapshot);snapshot.fill(0);const old=v.head;
  const preview=measureSaveAdmission(()=>AnchoredVault.upgradeStorage({authority,keys,vaultId:'v',maxCalls:2,storageDomain:'payload',operationId:'upgrade',targetDirectory:join(root,'upgraded'),storageProfile:SAFETY_V2_PROFILE})),upgraded=preview.value,upgradePeak=safetyWorkspacePeak();
  safetyOperation(()=>{const d=reconstructSafetyV2(upgraded.newHead,directoryReader(upgraded.newHead.directory),keys,2);try{assert.equal(sha(d.image),digest);assert.equal(d.view.globals.lastWall,100);assert.equal(d.view.stats().unknown,0);assert.equal(d.view.stats().reserved,1);}finally{d.close();}});
  v.close();const actual=measureSaveAdmission(()=>AnchoredVault.open({...config,directory:upgraded.newHead.directory,storageProfile:SAFETY_V2_PROFILE},2,{clock:{wall:()=>Number.MAX_SAFE_INTEGER,monotonic:()=>0}}));v=actual.value;const openPeak=safetyWorkspacePeak();
  assert.equal(actual.images.length,1,'open performs its actual first save, not another private boot');assert.equal(preview.images.length,1);assert.equal(preview.raw.length,1);assert.equal(actual.raw.length,1);
  // This small public schema2 fixture has identical output extents and hot
  // globals at the same maximum wall. Future preview carries one variance;
  // actual admission must not carry it again. No production cap is changed.
  assert.equal(actual.images[0],preview.images[0]);assert.ok(preview.raw[0]!-actual.raw[0]!>=32*4096);
  assert.equal(v.store.endogenousControl(),bootControl(encoded,()=>scope,old));assert.equal(parseControl(v.store.endogenousControl()!).runtimeEpoch,scope.runtimeEpoch+1);assert.equal(v.store.scope(scope.id).runtimeEpoch,scope.runtimeEpoch+1);assert.equal(v.status.unknownRequests,1);assert.equal(v.reserved,1);
  const business=measureSaveAdmission(()=>v.source({id:'business',revision:1}));assert.equal(business.images.length,2,'business save still executes its private one-open preview');
  t.diagnostic(JSON.stringify({root,upgradePeak,openPeak,previewImage:preview.images[0],actualImage:actual.images[0],previewRaw:preview.raw[0],actualRaw:actual.raw[0],wall:Number.MAX_SAFE_INTEGER,profile:SAFETY_V2_PROFILE,schema:2}));
 }finally{v.close();authority.close();}
});
