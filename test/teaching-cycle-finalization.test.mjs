import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash,canonical } from '../src/wf1-json.ts';
import { runTeachingCycle } from '../src/teaching-cycle-runner.ts';
import { syntheticOwner } from './teaching-cycle-fixture.ts';
import { installSyntheticTokenizer } from './teaching-tokenizer-fixture.ts';
import { teachingNativeFixture,syntheticCredentials,syntheticTeachingFetch } from './teaching-native-fixture.mjs';
import { initializeTeachingCustody,openTrustedTeachingHost,executeTeachingWorker,finalizeTeachingAuthority,checkRootAdmission,revokeTeachingCycle,verifyTeachingPython } from '../runtime/teaching-cycle/teaching-host-bindings.mjs';
import { REVOKER_FILES } from '../runtime/teaching-cycle/teaching-revoker.mjs';

const worker=fileURLToPath(new URL('./fixtures/teaching-finalization-worker.mjs',import.meta.url));
test('trusted bindings run four capability pools, freeze child authorities and match a fresh cold report',async()=>{
  const f=teachingNativeFixture(),native=syntheticTeachingFetch(),restore=installSyntheticTokenizer();
  try{initializeTeachingCustody(f.config);const result=await executeTeachingWorker(f.config,f.key,syntheticCredentials,syntheticOwner(),'run',{fetch:native.fetch});assert.equal(result.report.status,'COMPLETE_INDEX_CANDIDATE',JSON.stringify(result));assert.equal(result.report.qualified.train.rows,12);assert.equal(result.report.qualified.dev.rows,4);assert.equal(native.calls.length,20);assert.equal(result.report.usage.total.unreported,20);
    const files=f.config.children.flatMap(b=>[b.production.authorityPath,b.audit.authorityPath]),before=files.map(p=>fs.readFileSync(p));for(const p of files)assert.equal(JSON.parse(fs.readFileSync(p)).status,'REVOKED');revokeTeachingCycle(f.config);assert.deepEqual(files.map(p=>fs.readFileSync(p)),before);
    const cold=spawnSync(process.execPath,[worker,'cold',f.configPath],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(cold.status,0,cold.stderr);const actual=JSON.parse(cold.stdout);assert.deepEqual(actual.report,result.report);assert.equal(actual.action,'verify-report');assert.ok(Number.isFinite(actual.report.timing.qualifiedTrainLossTokensPerMinute));
    const prior=fs.readFileSync(f.config.children[0].archive.grantPath);fs.writeFileSync(f.config.children[0].archive.grantPath,canonical({...JSON.parse(prior),readAllowed:false}));await assert.rejects(()=>executeTeachingWorker(f.config,f.key,null,syntheticOwner(),'verify-report'),{code:'TCH_GRANT_CHANGED'});
  }finally{restore();f.key.fill(0);}
});

for(const target of ['production','qa'])test('crash after '+target+' authority freeze resumes the same artifacts without replay',async()=>{
  const child=spawnSync(process.execPath,[worker,'crash',target],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(child.status,17,child.stderr);const saved=JSON.parse(child.stdout),c=JSON.parse(fs.readFileSync(saved.configPath)),native=syntheticTeachingFetch();let tokenCalls=0;
  const undo=installSyntheticTokenizer(()=>tokenCalls++);
  try{const host=openTrustedTeachingHost(c,Buffer.alloc(32,61),syntheticCredentials,syntheticOwner('new-real-process-'+process.pid),'resume',{fetch:native.fetch});try{
    const safeErrors=[],closedStates=[],safeCode=e=>typeof e?.code==='string'&&/^(TC|TCH|CPR|CQA|WF1|CP0)_[A-Z0-9_]{1,80}$/.test(e.code)?e.code:'UNCLASSIFIED';
    for(const phase of ['openProduction','openAudit','finalizeProductionSource','archiveAudit']){const original=host.ports[phase];host.ports[phase]=async(...args)=>{try{const value=await original(...args);if(phase==='openProduction'||phase==='openAudit'){const store=value.store,close=store.close.bind(store);let closed=false;store.close=()=>{if(!closed){closed=true;try{const state=store.snapshot();closedStates.push({phase,childId:args[0].childId,status:state?.status??null,code:state?.code??null,attempts:state?.attempts.map(a=>({operation:a.operation,index:a.index,result:a.result?{outcome:a.result.outcome,httpStatus:a.result.httpStatus,responseFailureCode:a.result.responseFailureCode,usageParseCode:a.result.usageParseCode}:null}))??[]});}catch(error){safeErrors.push({phase:phase+':close',code:safeCode(error)});}}close();};}return value;}catch(error){safeErrors.push({phase,childId:args[0]?.childId,code:safeCode(error)});throw error;}};}
    const child0=host.ports.store.snapshot().children[0];assert.equal(child0.stage,target==='production'?'TOKENS':'INDEX');const prior=host.ports.store.snapshot().leases.map(l=>l.request.jobId+':'+l.request.attemptId);
    const summary=await runTeachingCycle(host.ports),after=host.ports.store.snapshot(),diagnostic={summary,safeErrors,closedStates,calls:native.calls.length,tokenCalls,children:after.children.map(({childId,stage,code})=>({childId,stage,code})),leases:after.leases.map(({childId,local,remote,request})=>({childId,local,remote,jobId:request.jobId,attemptId:request.attemptId,expiresAt:request.expiresAt})),timing:after.timing};assert.equal(summary.status,'COMPLETE',JSON.stringify(diagnostic));for(const id of prior)assert.equal(after.leases.filter(l=>l.request.jobId+':'+l.request.attemptId===id).length,1);assert.equal(after.timing.startedAt,saved.state.timing.startedAt);assert.equal(native.calls.length,target==='production'?17:15);assert.equal(tokenCalls,3);
    assert.equal(hash(fs.readFileSync(c.children[0].production.authorityPath)),saved.authorities[0].production);if(target==='qa')assert.equal(hash(fs.readFileSync(c.children[0].audit.authorityPath)),saved.authorities[0].qa);
  }finally{host.close();}}finally{undo();}
});

for(const target of ['production-missing-export','qa-missing-index'])test('revoked '+target+' cannot use inspect as permission to create missing output',async()=>{
  const child=spawnSync(process.execPath,[worker,'crash',target],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(child.status,17,child.stderr);const saved=JSON.parse(child.stdout),c=JSON.parse(fs.readFileSync(saved.configPath)),native=syntheticTeachingFetch(),host=openTrustedTeachingHost(c,Buffer.alloc(32,61),syntheticCredentials,syntheticOwner('negative-resume'),'resume',{fetch:native.fetch});
  const open=host.ports.openProduction;host.ports.openProduction=child=>{if(child.childId!=='child-0')throw Error('synthetic other children deliberately not run');return open(child);};
  try{const summary=await runTeachingCycle(host.ports);assert.equal(summary.status,'ACTIVE');assert.equal(summary.children[0].stage,'FAILED');assert.equal(native.calls.length,0);assert.equal(hash(fs.readFileSync(c.children[0].production.authorityPath)),saved.authorities[0].production);assert.equal(hash(fs.readFileSync(c.children[0].audit.authorityPath)),saved.authorities[0].qa);}finally{host.close();}
});

test('fixed authority finalization rejects wrong identity/head/PAUSED and repeat finalize preserves exact bytes',()=>{
  const f=teachingNativeFixture();initializeTeachingCustody(f.config);const b=f.config.children[0].production,original=JSON.parse(fs.readFileSync(b.authorityPath));
  assert.throws(()=>finalizeTeachingAuthority(b.authorityPath,b.spec,'wrong-job',null),{code:'TCH_AUTHORITY'});assert.throws(()=>finalizeTeachingAuthority(b.authorityPath,b.spec,b.spec.jobId,hash('wrong-head')),{code:'TCH_AUTHORITY_HEAD'});
  fs.writeFileSync(b.authorityPath,canonical({...original,status:'PAUSED'}));assert.throws(()=>finalizeTeachingAuthority(b.authorityPath,b.spec,b.spec.jobId,null),{code:'TCH_AUTHORITY_STATUS'});
  fs.writeFileSync(b.authorityPath,canonical(original));finalizeTeachingAuthority(b.authorityPath,b.spec,b.spec.jobId,null);const bytes=fs.readFileSync(b.authorityPath),stamp=fs.statSync(b.authorityPath,{bigint:true}).mtimeNs;finalizeTeachingAuthority(b.authorityPath,b.spec,b.spec.jobId,null);assert.deepEqual(fs.readFileSync(b.authorityPath),bytes);assert.equal(fs.statSync(b.authorityPath,{bigint:true}).mtimeNs,stamp);
});

test('Root evidence binds canonical completion JSON independently of raw file hashes and current approval',()=>{
  const f=teachingNativeFixture();assert.doesNotThrow(()=>checkRootAdmission(f.config,true,'RESUME'));const e=f.config.admission.mentorEvidence[0];assert.notEqual(e.completionEvidenceDigest,e.files[0].sha256);const old=e.files[0].sha256;e.files[0].sha256=e.completionEvidenceDigest;assert.throws(()=>checkRootAdmission(f.config,true),{code:'TCH_PIN'});e.files[0].sha256=old;
  const root=f.config.admission.rootRecord.path;fs.writeFileSync(root,canonical({...JSON.parse(fs.readFileSync(root)),approvedActions:[]}));assert.throws(()=>checkRootAdmission(f.config,true),{code:'TCH_PIN'});
});

test('private worker refuses an oversized anonymous bootstrap without config/key/provider access',()=>{
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../runtime/teaching-cycle/teaching-native-worker.mjs',import.meta.url)),'--private-worker'],{input:'x'.repeat(65537),encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(child.status,1);const safe=JSON.parse(child.stdout);assert.equal(safe.code,'TCH_STDIN_LIMIT');assert.equal(safe.rawErrorPrinted,false);assert.equal(safe.automaticRetry,false);
});

test('approved Python byte manifest rejects same-version library drift before host opening',()=>{
  const f=teachingNativeFixture();initializeTeachingCustody(f.config);assert.doesNotThrow(()=>verifyTeachingPython(f.config));
  const pin=JSON.parse(fs.readFileSync(f.config.tokenizer.runtimePin.path)),file=pin.runtimeFiles[1].path,old=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,canonical({...old,syntheticOnly:false}));assert.equal(JSON.parse(fs.readFileSync(file)).version,old.version);
  assert.throws(()=>verifyTeachingPython(f.config),{code:'TCH_PYTHON_DRIFT'});assert.throws(()=>openTrustedTeachingHost(f.config,f.key,syntheticCredentials,syntheticOwner(),'create'),{code:'TCH_PYTHON_DRIFT'});f.key.fill(0);
});

test('emergency revoker declaration covers its entire project import closure without execution modules',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),seen=new Set();
  function walk(name){if(seen.has(name))return;seen.add(name);const source=fs.readFileSync(path.join(root,name),'utf8').replace(/^import\s+type\b[^;]*;/gm,'');for(const m of source.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g))walk(path.posix.normalize(path.posix.join(path.posix.dirname(name),m[1])));}
  walk('runtime/teaching-cycle/teaching-revoker.mjs');for(const name of seen)assert.ok(REVOKER_FILES.includes(name),name);for(const name of REVOKER_FILES)assert.ok(seen.has(name)||name==='runtime/teaching-cycle/teaching-native-worker.mjs'||name==='runtime/teaching-cycle/Invoke-TeachingCycle.ps1',name);
  assert.equal(REVOKER_FILES.includes('src/corpus-production-runner.ts'),false);assert.equal(REVOKER_FILES.includes('runtime/teaching-cycle/teaching-host-bindings.mjs'),false);assert.equal(REVOKER_FILES.includes('src/wf1-usage-diagnostic.ts'),false);
});
