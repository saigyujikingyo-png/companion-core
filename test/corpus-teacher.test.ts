import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,realpathSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical,hash } from '../src/wf1-json.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { MODELS } from '../src/wf1-types.ts';
import { openTeacherPilotRun } from '../src/corpus-teacher-store.ts';
import { createPilotTransport,runTeacherPilot,verifyTeacherPilot } from '../src/corpus-teacher-pilot.ts';
import type { PilotTransport } from '../src/corpus-teacher-pilot.ts';
import { STUDENT_TARGET,STUDENT_TARGET_DIGEST,TEACHER_PILOT_DIGEST,validateRegistry } from '../src/corpus-teacher-types.ts';
import type { PilotRegistry,PilotSpec } from '../src/corpus-teacher-types.ts';
import { measureTeacherPilotTokens,verifyTeacherPilotTokens } from '../src/corpus-teacher-tokenizer.ts';
import type { CorpusTokenizerProfile } from '../src/corpus-tokenizer.ts';

function fixture(){
  const base=realpathSync.native(mkdtempSync(join(tmpdir(),'cpq-synthetic-'))),approvedTrainingRoot=join(base,'training'),runtimeRoot=join(approvedTrainingRoot,'pilot');mkdirSync(runtimeRoot,{recursive:true});
  const now=Date.now(),objective='SYNTHETIC current human goal: evidence calibration and useful tool choice.';
  const registry:PilotRegistry={version:'CorpusTeacherRegistry/0.1',slots:Array.from({length:6},(_,i)=>({ordinal:i,unitId:'unit'+i,familyId:'family'+i,sourceId:'synthetic-source',roots:['root'+i],split:i===5?'dev':'train',rightsDigest:hash('synthetic rights')})),blockedRoots:['sealed-root'],blockedFamilyIds:['sealed-family'],priorContentDigests:[]};
  const spec:PilotSpec={version:'CorpusTeacherPilot/0.1',runId:'synthetic-pilot',profileDigest:TEACHER_PILOT_DIGEST,buildDigest:hash('synthetic build'),objectiveDigest:hash(objective),registryDigest:hash(canonical(registry)),studentTargetDigest:STUDENT_TARGET_DIGEST,storageBindingDigest:bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest,authorityRevision:1,runtimeId:'synthetic-runtime',createdAt:now,expiresAt:now+1800000,prices:{together:{snapshotId:'synthetic-price',inputMicroUsdPerMillion:150000,completionMicroUsdPerMillion:600000},deepseek:{snapshotId:'synthetic-price',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000}}};
  const authorityPath=join(base,'authority.json');writeFileSync(authorityPath,canonical({schemaVersion:'wf1-host/1',campaignId:spec.runId,revision:1,runtimeId:spec.runtimeId,status:'ACTIVE',expiresAt:spec.expiresAt,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}}));
  let allowed=true;const options={approvedTrainingRoot,runtimeRoot,authorityPath,spec,key:Buffer.alloc(32,61),sourceCheck:()=>({registryDigest:spec.registryDigest,allowed}),now:()=>now};
  const store=openTeacherPilotRun({...options,mode:'create'});
  return {base,store,spec,registry,objective,options,revokeSource:()=>{allowed=false;}};
}
type Fixture=ReturnType<typeof fixture>;
function mock(f:Fixture,options:{bad?:number;reject?:number;duplicate?:number;unknown?:number;missingUsage?:number;overUsage?:number;pause?:number;revoke?:number;source?:number;requestOverflow?:number;slow?:boolean}={}){
  const calls:string[]=[],occupancy={together:0,deepseek:0,total:0},peaks={together:0,deepseek:0,total:0},phase1:{together:number;deepseek:number;total:number}={together:0,deepseek:0,total:0};
  const transport:PilotTransport=async r=>{
    const op=r.operation,i=r.ordinal;calls.push(op+':'+i);assert.ok(f.store.snapshot()!.attempts.some(a=>a.operation===op&&a.ordinal===i&&a.result===null),'consume must precede external dispatch');
    const envelope=JSON.parse(r.body),payload=JSON.parse(envelope.messages[1].content);assert.ok(!r.body.includes('sealed-root'));assert.ok(!r.body.includes('sealed-family'));
    occupancy[r.provider]++;occupancy.total++;for(const p of ['together','deepseek','total'] as const){peaks[p]=Math.max(peaks[p],occupancy[p]);if(i!==null&&i<2)phase1[p]=Math.max(phase1[p],occupancy[p]);}
    await r.authorizeSend(()=>delay(options.slow?15:1));
    let body:unknown;if(op==='plan')body={version:'CorpusTeacherPlan/0.1',units:f.registry.slots.map(s=>({ordinal:s.ordinal,unitId:s.unitId,task:options.requestOverflow===s.ordinal?'\\'.repeat(768):'SYNTHETIC task '+s.ordinal,rubric:options.requestOverflow===s.ordinal?'\\'.repeat(768):'SYNTHETIC evidence and no fabricated tool effects.'}))};
    else if(op==='candidate')body={version:'CorpusTeacherCandidate/0.1',unitId:'unit'+i,prompt:options.requestOverflow===i?'p'.repeat(2048):'SYNTHETIC question '+(options.duplicate===i?0:i),response:options.requestOverflow===i?'r'.repeat(8192):'SYNTHETIC answer '+(options.duplicate===i?0:i)};
    else body={version:'CorpusTeacherReview/0.1',unitId:'unit'+i,candidateDigest:payload.data.candidateDigest,disposition:options.reject===i?'REJECT':'ACCEPT',notes:'SYNTHETIC review'};
    const raw=op==='candidate'&&options.bad===i?'```invalid JSON```':canonical(body),ref=r.output.put('native-final',raw);
    if(op==='candidate'&&options.pause===i)f.store.control('PAUSED');
    if(op==='candidate'&&options.revoke===i)f.store.control('REVOKED');
    if(op==='candidate'&&options.source===i)f.revokeSource();
    occupancy[r.provider]--;occupancy.total--;
    return {outcome:op==='candidate'&&options.unknown===i?'SUBMIT_UNKNOWN':'COMPLETED',requestedModel:MODELS[r.provider],returnedModel:MODELS[r.provider],requestId:'synthetic-id',transportLane:'SYNTHETIC_FIXTURE',httpStatus:200,failure:null,finishReason:'stop',reasoningPresent:false,contentPresent:true,usage:op==='candidate'&&options.missingUsage===i?null:{input:op==='candidate'&&options.overUsage===i?18433:100,completion:80,reasoning:20},rawRef:ref,reasoningRef:null,finalRef:ref,elapsedMs:1};
  };
  return {transport,calls,peaks,phase1};
}
async function run(f:Fixture,m:ReturnType<typeof mock>){return runTeacherPilot(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:m.transport});}

test('six units use independent bounded lanes, increment manifests, cold verify and never redispatch',async()=>{
  const f=fixture(),m=mock(f,{slow:true});try{const summary=await run(f,m);assert.equal(summary.status,'COMPLETED');assert.equal(summary.counts.dataGateAcceptedNew,6);assert.equal(summary.calls.coordinatorConsumed,1);assert.equal(m.calls.length,13);assert.deepEqual(m.phase1,{together:1,deepseek:1,total:2});assert.ok(m.peaks.together<=2&&m.peaks.deepseek<=2&&m.peaks.total<=3);assert.equal(m.peaks.total,3);assert.equal(summary.counts.exactVerifiedNew,0);assert.equal(summary.trainingReady,false);assert.equal(summary.tokens.studentInputTokens,null);assert.equal(summary.yield.dataGateAcceptedNewPer100AllConsumedCalls,600/13);assert.equal(summary.time.generationServiceMs.length,6);assert.equal(summary.time.reviewQueueWaitMs.length,6);assert.equal(f.store.snapshot()!.manifestRefs.length,6);
    const again=await run(f,m);assert.equal(again.counts.dataGateAcceptedNew,6);assert.equal(m.calls.length,13);
    f.store.close();const cold=openTeacherPilotRun({...f.options,mode:'inspect'});try{assert.equal(verifyTeacherPilot(cold).units.filter(u=>u.status==='ACCEPTED').length,6);assert.throws(()=>cold.output.put('forbidden','no'));assert.throws(()=>cold.authorizeSend(()=>{}));}finally{cold.close();}
    const source=`import {openTeacherPilotRun} from ${JSON.stringify(new URL('../src/corpus-teacher-store.ts',import.meta.url).href)};import {verifyTeacherPilot} from ${JSON.stringify(new URL('../src/corpus-teacher-pilot.ts',import.meta.url).href)};let raw='';for await(const chunk of process.stdin)raw+=chunk;const c=JSON.parse(raw),s=openTeacherPilotRun({...c,key:Buffer.alloc(32,61),mode:'inspect',sourceCheck:()=>({registryDigest:c.spec.registryDigest,allowed:true})});try{process.stdout.write(JSON.stringify({accepted:verifyTeacherPilot(s).units.filter(u=>u.status==='ACCEPTED').length}));}finally{s.close();}`;
    const fresh=spawnSync(process.execPath,['--input-type=module','--eval',source],{input:canonical({approvedTrainingRoot:f.options.approvedTrainingRoot,runtimeRoot:f.options.runtimeRoot,authorityPath:f.options.authorityPath,spec:f.spec}),encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16384});assert.equal(fresh.status,0,fresh.stderr);assert.equal(JSON.parse(fresh.stdout).accepted,6);
  }finally{f.store.close();}
});
for(const [name,options]of [['JSON',{bad:0}],['review rejection',{reject:0}],['duplicate',{duplicate:1}]] as const)test(name+' quarantines one unit and later frozen unit succeeds',async()=>{
  const f=fixture(),m=mock(f,options);try{const s=await run(f,m);assert.equal(s.status,'COMPLETED');assert.equal(s.counts.quarantined,1);assert.equal(s.counts.dataGateAcceptedNew,5);assert.equal(f.store.snapshot()!.units[5]!.status,'ACCEPTED');assert.equal(m.calls.length,'reject' in options?13:12);assert.equal(verifyTeacherPilot(f.store).manifestRefs.length,5);}finally{f.store.close();}
});
for(const [name,options,code]of [['unknown',{unknown:2},'CPQ_SUBMIT_UNKNOWN'],['usage missing',{missingUsage:2},'CPQ_USAGE_UNKNOWN'],['usage overflow',{overUsage:2},'CPQ_BUDGET']] as const)test(name+' fences new work, preserves accepted prefix and worst-case reserve',async()=>{
  const f=fixture(),m=mock(f,{...options,slow:true});try{const s=await run(f,m);assert.equal(s.status,'FENCED');assert.equal(s.counts.dataGateAcceptedNew,2);assert.ok(s.failure.fixedCodeCounts[code]);assert.ok(!m.calls.includes('candidate:4'));assert.ok(!m.calls.includes('candidate:5'));assert.equal(s.cost.actualInvoice,'UNKNOWN');assert.ok(s.cost.reservedWorstCaseMicroUsd>0);assert.equal(verifyTeacherPilot(f.store).manifestRefs.length,2);}finally{f.store.close();}
});
for(const [name,options]of [['pause',{pause:0}],['revoke',{revoke:0}],['source',{source:0}]] as const)test(name+' stops new dispatch without manufacturing a write permission',async()=>{
  const f=fixture(),m=mock(f,options);try{const s=await run(f,m);assert.equal(s.status,'FENCED');assert.equal(m.calls.length,2);assert.equal(s.counts.dataGateAcceptedNew,0);assert.equal(s.calls.unknownUsageCount,1);}finally{f.store.close();}
});
test('source registry rejects sealed overlap before a provider call',async()=>{const f=fixture();try{const registry=structuredClone(f.registry);registry.slots[0]!.roots=['sealed-root'];assert.throws(()=>validateRegistry(registry),/CPQ_SOURCE/);const m=mock(f);await assert.rejects(()=>runTeacherPilot(f.spec,{store:f.store,objective:f.objective,registry,transport:m.transport}));assert.equal(m.calls.length,0);}finally{f.store.close();}});
test('authority head tampering is fenced and cold open cannot turn a consumed call into a retry',async()=>{
  const f=fixture(),m=mock(f,{pause:0});try{await run(f,m);f.store.close();const a=JSON.parse(readFileSync(f.options.authorityPath,'utf8'));writeFileSync(f.options.authorityPath,canonical({...a,status:'ACTIVE',revision:2}));const cold=openTeacherPilotRun({...f.options,mode:'inspect'});try{const s=await runTeacherPilot(f.spec,{store:cold,objective:f.objective,registry:f.registry,transport:m.transport});assert.equal(s.status,'FENCED');assert.equal(m.calls.length,2);assert.equal(s.calls.unknownUsageCount,1);}finally{cold.close();}
    const current=JSON.parse(readFileSync(f.options.authorityPath,'utf8'));writeFileSync(f.options.authorityPath,canonical({...current,head:hash('tampered')}));assert.throws(()=>openTeacherPilotRun({...f.options,mode:'inspect'}),/CPQ_HEAD/);
  }finally{f.store.close();}
});

test('new native contract uses fixed endpoints, exact models and separate concurrent transports',async()=>{
  const f=fixture(),calls:string[]=[],response=(body:string,model:string)=>new Response(canonical({id:'synthetic-http-id',model,choices:[{index:0,message:{role:'assistant',content:body},finish_reason:'stop'}],usage:{prompt_tokens:123,completion_tokens:45,total_tokens:168,completion_tokens_details:{reasoning_tokens:11}},...(model===MODELS.together?{prompt:[],warnings:[]}: {})}),{headers:{'content-type':'application/json'}});
  const transport=createPilotTransport({together:'synthetic-together',deepseek:'synthetic-deepseek'},{fetch:async(url,init)=>{
    assert.ok(['https://api.together.ai/v1/chat/completions','https://api.deepseek.com/chat/completions'].includes(String(url)));assert.equal(init!.redirect,'error');const b=JSON.parse(init!.body as string),p=JSON.parse(b.messages[1].content),i=p.ordinal;calls.push(p.operation+':'+i);await delay(5);
    const value=p.operation==='plan'?{version:'CorpusTeacherPlan/0.1',units:p.data.slots.map((s:{ordinal:number;unitId:string})=>({...s,task:'Synthetic '+s.ordinal,rubric:'Synthetic rubric'}))}:p.operation==='candidate'?{version:'CorpusTeacherCandidate/0.1',unitId:'unit'+i,prompt:'Synthetic '+i,response:'Synthetic answer '+i}:{version:'CorpusTeacherReview/0.1',unitId:'unit'+i,candidateDigest:p.data.candidateDigest,disposition:'ACCEPT',notes:''};
    return response(canonical(value),b.model);
  }});
  try{const s=await runTeacherPilot(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport});assert.equal(s.status,'COMPLETED');assert.equal(s.counts.dataGateAcceptedNew,6);assert.equal(calls.length,13);assert.equal(s.calls.knownInput,13*123);}finally{f.store.close();}
});

test('committed ciphertext tamper refuses cold verification and cannot reset a run',async()=>{
  const f=fixture(),m=mock(f);try{await run(f,m);const ref=f.store.snapshot()!.manifestRefs[0]!,path=join(f.options.runtimeRoot,'train-'+ref.id+'.bin'),bytes=readFileSync(path);bytes[14]=bytes[14]!^1;writeFileSync(path,bytes);assert.throws(()=>verifyTeacherPilot(f.store),/WF1_ARTIFACT_CHANGED/);f.store.close();assert.throws(()=>openTeacherPilotRun({...f.options,mode:'create'}));assert.equal(m.calls.length,13);}finally{f.store.close();}
});

test('a consumed attempt has only one send grant even if its transport calls twice',async()=>{
  const f=fixture();let sends=0;const transport:PilotTransport=async r=>{r.authorizeSend(()=>{sends++;});r.authorizeSend(()=>{sends++;});throw Error('unreachable');};
  try{const s=await runTeacherPilot(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport});assert.equal(s.status,'FENCED');assert.equal(sends,1);assert.equal(s.calls.coordinatorConsumed,1);assert.equal(s.calls.unknownUsageCount,1);assert.equal(s.transportLane,'UNKNOWN');}finally{f.store.close();}
});

test('valid text whose second JSON escaping exceeds review request bounds is isolated before review consumption',async()=>{
  const f=fixture(),m=mock(f,{requestOverflow:0});try{const s=await run(f,m);assert.equal(s.status,'COMPLETED');assert.equal(s.counts.dataGateAcceptedNew,5);assert.equal(s.counts.quarantined,1);assert.equal(s.failure.fixedCodeCounts.CPQ_LENGTH,1);assert.ok(!m.calls.includes('review:0'));assert.equal(s.calls.reviewerConsumed,5);assert.equal(m.calls.length,12);}finally{f.store.close();}
});

test('aborted admission consumes no call, while the immutable new-run boundary remains closed',async()=>{
  const f=fixture(),m=mock(f),controller=new AbortController();controller.abort();try{const s=await runTeacherPilot(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:m.transport,signal:controller.signal});assert.equal(s.status,'FENCED');assert.equal(s.calls.coordinatorConsumed,0);assert.equal(s.yield.dataGateAcceptedNewPer100AllConsumedCalls,null);assert.equal(m.calls.length,0);assert.equal(s.failure.fixedCodeCounts.CPQ_ABORTED,1);}finally{f.store.close();}
});

test('natural-language token receipt is separately measured, reused, cold recomputed, and never exact content evidence',{skip:!process.env.CP0_TOKENIZER_PYTHON,timeout:60000},async()=>{
  const f=fixture(),m=mock(f),python=process.env.CP0_TOKENIZER_PYTHON!;try{
    await run(f,m);const root=join(f.base,'artificial-tokenizer');mkdirSync(root);const tokenizer=canonical({version:'1.0',truncation:null,padding:null,added_tokens:[],normalizer:null,pre_tokenizer:{type:'WhitespaceSplit'},post_processor:null,decoder:null,model:{type:'WordLevel',vocab:{'[UNK]':0,user:1,assistant:2,end:3},unk_token:'[UNK]'}}),template='user {{ messages[0].content }} assistant {% if not add_generation_prompt %}{{ messages[1].content }} end{% endif %}';writeFileSync(join(root,'tokenizer.json'),tokenizer);writeFileSync(join(root,'chat_template.jinja'),template);
    const v=spawnSync(python,['-I','-B','-c','import platform;print(platform.python_version())'],{encoding:'utf8',windowsHide:true});assert.equal(v.status,0);
    // Synthetic asset hashes deliberately differ from public weights; only worker mechanics are under test.
    const profile:CorpusTokenizerProfile={version:'CorpusTokenizer/0.1',model:STUDENT_TARGET.repo,revision:STUDENT_TARGET.revision,assetRoot:realpathSync.native(root),tokenizerSha256:hash(tokenizer),templateSha256:hash(template),runtime:{python:v.stdout.trim(),tokenizers:'0.23.3',jinja2:'3.1.6',markupsafe:'3.0.4'},templatePolicy:'SFT_USER_ASSISTANT_NO_THINKING/1',addSpecialTokens:false,maxInputBytes:65536,maxTokens:65536,officialPipelineParity:'NOT_VALIDATED'};
    assert.throws(()=>measureTeacherPilotTokens(f.store,{...profile,model:'old/BF16'},python),/CPQ_TOKENIZER_IDENTITY/);
    const before=f.store.snapshot()!.manifestRefs.map(r=>f.store.output.read(r)),result=measureTeacherPilotTokens(f.store,profile,python);assert.equal(result.summary.evidenceClass,'MODEL_REVIEWED');assert.equal(result.summary.trainingReady,false);assert.equal(result.summary.rows,6);assert.equal(result.summary.studentInputTokens,30);assert.equal(result.summary.studentLossTokens,24);assert.equal(m.calls.length,13);
    const reused=measureTeacherPilotTokens(f.store,profile,'not-an-executable');assert.deepEqual(reused,result);assert.deepEqual(f.store.snapshot()!.manifestRefs.map(r=>f.store.output.read(r)),before);
    f.store.close();const cold=openTeacherPilotRun({...f.options,mode:'inspect'});try{assert.deepEqual(verifyTeacherPilotTokens(cold,result.measurementRef,profile,python),result.summary);assert.throws(()=>verifyTeacherPilotTokens(cold,result.measurementRef,{...profile,revision:'a'.repeat(40)},python),/CPQ_TOKENIZER_IDENTITY/);}finally{cold.close();}
  }finally{f.store.close();}
});
