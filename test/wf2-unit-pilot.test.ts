import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { canonical,hash,Wf1Error } from '../src/wf1-json.ts';
import { estimateMicroUsd,unitRecordedCounts,validateSpec } from '../src/wf1-contract.ts';
import { TeachingCampaign } from '../src/wf1-campaign.ts';
import { HostAuthority,createArtifactBroker } from '../src/wf1-storage.ts';
import { TeacherProvider } from '../src/wf1-provider.ts';
import { bindTeacherCampaign,inspectTeacherCampaign } from '../src/wf2-teacher-worker.ts';
import { validateTeacherMetadata } from '../src/wf2-teacher-service.ts';
import { verifyTeacherManifest } from '../src/wf2-teacher-inspect.ts';
import { runTeacherBridge } from '../src/wf2-teacher-bridge.ts';
import { WF2_PILOT_PROFILE_DIGEST,pilotBody,pilotPayload } from '../src/wf2-together-pilot.ts';
import { unknownFailureDiagnostic,validateFailureDiagnostic } from '../src/wf2-failure-diagnostic.ts';
import { preflightUnitBootstrap,UNIT_CURRICULUM,UNIT_SCHEDULE,unitBinding,unitBody,unitCompletion,unitMetadataProfile,unitPayload,unitProvider,unitSchema,validatePlanUnit,validateSealedUnit,validateUnitAttempt,validateUnitDistinct,validateUnitPlan,validateUnitSeal,WF2_UNIT_LIMITS,WF2_UNIT_PROFILE_DIGEST } from '../src/wf2-unit-pilot.ts';
import { planUnit,sealUnit,unitFixture,unitInspection,unitKey,unitMock,unitState } from './fixtures/wf2-unit-fixture.ts';
import type { UnitFault } from './fixtures/wf2-unit-fixture.ts';
const files=(root:string)=>readdirSync(root).sort().map(name=>[name,hash(readFileSync(join(root,name)))]);

test('unit profile freezes cross-model schedule, curricula, finite schemas, exact caps and prices with no old-profile upgrade',async()=>{
  const f=unitFixture();validateSpec(f.spec);assert.equal(UNIT_SCHEDULE.length,17);assert.equal(UNIT_SCHEDULE.filter(s=>unitProvider(s.operation)==='together').length,13);assert.equal(UNIT_SCHEDULE.filter(s=>unitProvider(s.operation)==='deepseek').length,4);
  const reserve=UNIT_SCHEDULE.reduce((n,s)=>n+estimateMicroUsd(18432,unitCompletion(s.operation),f.spec.prices[unitProvider(s.operation)]),0);assert.equal(reserve,129339);assert.equal(WF2_UNIT_LIMITS.totalMicroUsd,150000);
  for(const {operation,unitIndex} of UNIT_SCHEDULE){const body=JSON.parse(unitBody(unitProvider(operation),unitPayload(operation,{}),operation,unitIndex));assert.equal(body.max_tokens,operation==='review'?8192:4096);assert.equal(body.reasoning_effort,operation==='review'?'high':'medium');assert.equal(body.tools,undefined);if(operation==='review'){assert.deepEqual(body.thinking,{type:'enabled'});assert.deepEqual(body.response_format,{type:'json_object'});}
    const schema:any=unitSchema(operation,unitIndex);function walk(node:any,active:string[]=[]):void {if(!node||typeof node!=='object')return;if(node.$ref){const name=node.$ref.slice('#/$defs/'.length);assert.ok(schema.$defs[name]);assert.ok(!active.includes(name));walk(schema.$defs[name],[...active,name]);}for(const [key,value]of Object.entries(node))if(key!=='$ref'&&key!=='$defs')Array.isArray(value)?value.forEach(v=>walk(v,active)):walk(value,active);}walk(schema);
  }
  assert.equal(preflightUnitBootstrap('x'.repeat(2048)).requests.length,9);assert.ok(preflightUnitBootstrap('x'.repeat(2048)).requests.every(r=>r.bytes<16384));
  assert.throws(()=>validateSpec({...f.spec,schemaVersion:'wf1-campaign/0.7'}));assert.throws(()=>validateSpec({...f.spec,profileDigest:WF2_PILOT_PROFILE_DIGEST}));assert.throws(()=>validateSpec({...f.spec,prices:{...f.spec.prices,together:{...f.spec.prices.together,inputMicroUsdPerMillion:1}}}));
  let sends=0,authorized=0;const provider=new TeacherProvider({deepseek:'synthetic',together:'synthetic'},{fetch:async()=>{sends++;throw Error('not sent');}});
  const binding=unitBinding('deepseek','review',0),body=JSON.parse(unitBody('deepseek',unitPayload('review',{}),'review',0));body.max_tokens=8191;
  for(const raw of [canonical(body),pilotBody('together',pilotPayload('review',{}),'review')])await assert.rejects(provider.submit('deepseek',raw,{} as never,new AbortController().signal,send=>{authorized++;return send();},{operation:'review',binding}));
  assert.equal(sends,0);assert.equal(authorized,0);assert.deepEqual(readdirSync(f.runtimeRoot),[]);
});

test('unit validators enforce exact root/depth and model-declared split while preserving four authored plan texts',()=>{
  const plan=validateUnitPlan({version:'wf2-unit-plan/1',units:Array.from({length:4},(_,i)=>planUnit(i))}),seal=validateUnitSeal({version:'wf2-unit-seal/1',cases:Array.from({length:4},(_,i)=>sealUnit(i).case)});assert.deepEqual(plan.units.map(u=>u.plan),Array.from({length:4},(_,i)=>planUnit(i).plan));assert.equal(seal.cases.length,4);
  for(let i=0;i<4;i++){assert.equal((plan.units[i]!.family.formal.input as any).op,UNIT_CURRICULUM.rootOperations[i]);const wrong=planUnit(i);wrong.family.split=i===3?'train':'dev';assert.throws(()=>validatePlanUnit(wrong,i),e=>e instanceof Wf1Error&&e.code==='WF1_SPLIT');assert.throws(()=>validateSealedUnit(sealUnit(i),(i+1)%4),e=>e instanceof Wf1Error&&e.code==='WF2_UNIT_CURRICULUM');}
  const shallow=planUnit(0);shallow.family.formal=sealUnit(0).case.formal;assert.throws(()=>validatePlanUnit(shallow,0),e=>e instanceof Wf1Error&&e.code==='WF2_UNIT_CURRICULUM');
  const a=planUnit(0).family,b={...planUnit(1).family,formal:a.formal};assert.throws(()=>validateUnitDistinct([a,b]),e=>e instanceof Wf1Error&&e.code==='WF1_FAMILY_COLLISION');
  assert.throws(()=>validateUnitPlan({...plan,pairedFamilyIds:[]}));assert.throws(()=>validateFailureDiagnostic({version:'wf2-failure-diagnostic/2',stage:'PLAN_VALIDATION',code:'WF1_SPLIT',unitIndex:4}));
});

test('unit consume schedule rejects caller-selected slots and old bodies before any attempt or provider call',()=>{
  const f=unitFixture(),m=unitMock(f.runtimeRoot),campaign=TeachingCampaign.admitCampaign({root:f.runtimeRoot,authorityPath:f.authorityPath,spec:f.spec,key:unitKey,objective:f.bootstrap.objective,provider:m.provider,approvedTrainingRoot:f.approvedTrainingRoot,now:()=>f.now});
  try{for(const [operation,index]of [['seal',1],['plan',0],['review',0],['rubric',null]] as const)assert.throws(()=>campaign.reserveAttempt(operation,unitBody(unitProvider(operation),unitPayload(operation,{}),operation,index),null,index));assert.throws(()=>campaign.reserveAttempt('seal',pilotBody('together',pilotPayload('seal',{}),'seal'),null,0));assert.equal(campaign.ledger.snapshot().attempts.length,0);assert.equal(m.operations.length,0);}finally{campaign.close();}
});

test('unit failures stop at each stage, keep partial units private and never repair or dispatch the next slot',async()=>{
  const cases:Array<{fault:UnitFault;calls:number;stage:string;code:string;units:{sealed:number;planned:number}}>=[
    {fault:{operation:'seal',index:2,kind:'version'},calls:3,stage:'SEAL_VALIDATION',code:'WF1_VERSION',units:{sealed:2,planned:0}},
    {fault:{operation:'plan',index:2,kind:'split'},calls:7,stage:'PLAN_VALIDATION',code:'WF1_SPLIT',units:{sealed:4,planned:2}},
    {fault:{operation:'rubric',index:null,kind:'version'},calls:9,stage:'RUBRIC_VALIDATION',code:'WF1_PROTOCOL',units:{sealed:4,planned:4}},
    {fault:{operation:'candidate',index:0,kind:'target'},calls:10,stage:'FIRST_FOUR_GATE',code:'WF2_FIRST_EXACT_ORACLE',units:{sealed:4,planned:4}},
    {fault:{operation:'review',index:0,kind:'flag'},calls:11,stage:'FIRST_FOUR_GATE',code:'WF2_FIRST_REVIEW',units:{sealed:4,planned:4}},
    {fault:{operation:'seal',index:1,kind:'duplicateId'},calls:2,stage:'SEAL_VALIDATION',code:'WF1_DUPLICATE',units:{sealed:1,planned:0}},
    {fault:{operation:'plan',index:1,kind:'rootsCollision'},calls:6,stage:'PLAN_VALIDATION',code:'WF1_FAMILY_COLLISION',units:{sealed:4,planned:1}},
    {fault:{operation:'plan',index:0,kind:'root'},calls:5,stage:'PLAN_VALIDATION',code:'WF2_UNIT_CURRICULUM',units:{sealed:4,planned:0}},
    {fault:{operation:'plan',index:0,kind:'depth'},calls:5,stage:'PLAN_VALIDATION',code:'WF2_UNIT_CURRICULUM',units:{sealed:4,planned:0}},
    {fault:{operation:'plan',index:0,kind:'source'},calls:10,stage:'SOURCE_EXCLUSION',code:'WF1_SOURCE_EXCLUSION',units:{sealed:4,planned:4}},
    {fault:{operation:'review',index:0,kind:'usage'},calls:11,stage:'REVIEW_REQUEST',code:'WF1_UNRECONCILED',units:{sealed:4,planned:4}}
  ];
  for(const c of cases){const f=unitFixture(),m=unitMock(f.runtimeRoot,c.fault),bound=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});try{await bound.run.run();const terminal=bound.terminal!();assert.equal(m.operations.length,c.calls,JSON.stringify(c.fault));assert.equal(terminal.metadata.campaignStatus,'STOPPED');assert.equal(terminal.metadata.candidates.qualified,0);assert.equal(terminal.metadata.manifestFrozen,false);assert.deepEqual({...terminal.metadata.units},c.units);assert.deepEqual(terminal.failureDiagnostic,{version:'wf2-failure-diagnostic/2',stage:c.stage,code:c.code,unitIndex:c.fault.operation==='plan'&&c.fault.kind==='source'?0:c.fault.index});assert.ok(!canonical(terminal).includes('PRIVATE_MODEL_PLAN'));}finally{bound.run.withdraw('REVOKED');}
    assert.deepEqual(bound.run.metadata().units,{sealed:null,planned:null});assert.deepEqual(bound.terminal!().failureDiagnostic,unknownFailureDiagnostic());const before=files(f.runtimeRoot),cold=inspectTeacherCampaign(unitInspection(f),()=>f.now);assert.equal(cold.version,'wf2-teacher-inspection/6');assert.deepEqual(cold.units,c.units);assert.equal(cold.manifestVerification.status,'NOT_READ');assert.equal(cold.authorityStatus,'REVOKED');assert.deepEqual(files(f.runtimeRoot),before);assert.throws(()=>bindTeacherCampaign(f.bootstrap));
  }
});

test('unit pause or revoke while a consumed plan request is pending prevents late material and all subsequent dispatch',async()=>{
  for(const mode of ['PAUSED','REVOKED'] as const){const f=unitFixture();let reached!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{reached=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});const m=unitMock(f.runtimeRoot,undefined,async(op,index)=>{if(op==='plan'&&index===0){reached();await gate;}}),bound=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),running=bound.run.run();await ready;new HostAuthority(f.authorityPath,f.spec.id,()=>f.now).control(mode);release();await running;
    assert.equal(m.operations.length,5);assert.equal(bound.run.metadata().countCompleteness,'STALE_OR_UNKNOWN');assert.deepEqual(bound.run.metadata().units,{sealed:null,planned:null});assert.deepEqual(bound.terminal!().failureDiagnostic,unknownFailureDiagnostic());bound.run.close();const cold=inspectTeacherCampaign(unitInspection(f),()=>f.now);assert.equal(cold.authorityStatus,mode);assert.deepEqual(cold.units,{sealed:4,planned:0});assert.equal(cold.responseFailureCode,'UNKNOWN');assert.equal(cold.manifestVerification.status,'NOT_READ');assert.throws(()=>bindTeacherCampaign(f.bootstrap));
  }
});

test('unit private worker and bridge complete exactly T13 DS4, then cold verify four unique rows and reject review family drift',{timeout:30000},async()=>{
  const f=unitFixture(),evidenceRoot=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-unit-bridge-'))),workerUrl=new URL('../src/wf2-teacher-worker.ts',import.meta.url).href,fixtureUrl=new URL('./fixtures/wf2-unit-fixture.ts',import.meta.url).href,pluginUrl=new URL('../integrations/dsh-teacher-control/index.mjs',import.meta.url).href;
  const workerSource=`import {serveTeacherControl,bindTeacherCampaign} from ${JSON.stringify(workerUrl)};import {unitMock} from ${JSON.stringify(fixtureUrl)};const session=serveTeacherControl(process.stdin,process.stdout,b=>bindTeacherCampaign(b,{provider:unitMock(b.runtimeRoot).provider,now:()=>1000}));await session.closed;process.stdin.destroy();`;
  const dshSource=`import {apply} from ${JSON.stringify(pluginUrl)};const disposers=[];const values={cmdlineArgs:{get:()=>['--teacher-control']},appExit:n=>{for(const d of disposers)d();process.exitCode=n},appReady:{onReady:f=>{const p=setImmediate(f);return ()=>clearImmediate(p);}}};apply({get:n=>values[n],effect:f=>{const d=f();disposers.push(d);}});`;
  const result=await runTeacherBridge({evidenceRoot,deadlineMs:15000,metadataProfileDigest:WF2_UNIT_PROFILE_DIGEST,startWorker:capability=>{const child=spawn(process.execPath,['--input-type=module','--eval',workerSource],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdin.write(JSON.stringify({...f.bootstrap,capability})+'\n');return child;},startDsh:()=>spawn(process.execPath,['--input-type=module','--eval',dshSource],{stdio:['pipe','pipe','pipe'],windowsHide:true}),forceClose:async children=>{for(const child of children)child.kill();}});
  assert.equal(result.status,'COMPLETED');assert.equal(result.version,'wf2-teacher-bridge/3');assert.equal(result.workerClosed,true);assert.equal(result.dshClosed,true);assert.equal(result.forced,false);assert.equal(result.completionAcknowledged,true);assert.deepEqual({...result.metadata!.calls},{deepseek:4,together:13});assert.deepEqual({...result.metadata!.units},{sealed:4,planned:4});assert.equal(result.metadata!.candidates.qualified,4);assert.equal(result.metadata!.estimatedReserveMicroUsd,129339);assert.deepEqual(result.failureDiagnostic,unknownFailureDiagnostic());assert.deepEqual({...result.metadata!.profile},unitMetadataProfile());
  assert.throws(()=>validateTeacherMetadata(result.metadata));assert.throws(()=>validateTeacherMetadata(result.metadata,WF2_PILOT_PROFILE_DIGEST));assert.throws(()=>validateTeacherMetadata({...result.metadata,units:{sealed:3,planned:4}},WF2_UNIT_PROFILE_DIGEST));assert.throws(()=>validateTeacherMetadata({...result.metadata,usage:{...result.metadata!.usage,unknown:1}},WF2_UNIT_PROFILE_DIGEST));
  const state=unitState(f.runtimeRoot),train=createArtifactBroker(f.runtimeRoot,f.spec.id,unitKey).train,plan=validateUnitPlan(JSON.parse(train.read(state.planRef!).toString())),manifest=JSON.parse(train.read(state.manifestRef!).toString());assert.equal(state.attempts.length,17);assert.deepEqual(unitRecordedCounts(state),{sealed:4,planned:4});assert.deepEqual(verifyTeacherManifest(state,plan,manifest),{status:'VERIFIED',rows:4,uniqueRows:4,splitCounts:{train:3,dev:1}});
  const drift=structuredClone(state);drift.attempts[10]!.familyId=plan.units[1]!.family.id;assert.throws(()=>verifyTeacherManifest(drift,plan,manifest),e=>e instanceof Wf1Error&&e.code==='WF2_UNIT_FAMILY_BINDING');const wrongId=structuredClone(state.attempts[10]!);wrongId.id='review:caller-selected';assert.throws(()=>validateUnitAttempt(wrongId,10,plan));assert.throws(()=>verifyTeacherManifest(state,plan,{...manifest,reviewer:{provider:'together',model:'wrong'}}));
  for(const name of readdirSync(f.runtimeRoot).filter(n=>n.startsWith('custody-')))renameSync(join(f.runtimeRoot,name),join(f.runtimeRoot,name+'.unavailable'));const before=files(f.runtimeRoot),hostBefore=files(join(f.base,'host'));
  const source=`import {inspectTeacherCampaign} from ${JSON.stringify(workerUrl)};let raw='';for await(const part of process.stdin)raw+=part;process.stdout.write(JSON.stringify(inspectTeacherCampaign(JSON.parse(raw),()=>1000)));`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{input:canonical(unitInspection(f)),encoding:'utf8',timeout:5000,maxBuffer:32768,windowsHide:true});assert.equal(child.status,0,child.stderr);const cold=JSON.parse(child.stdout);assert.equal(cold.version,'wf2-teacher-inspection/6');assert.equal(cold.authorityStatus,'ACTIVE');assert.deepEqual(cold.units,{sealed:4,planned:4});assert.deepEqual(cold.manifestVerification,{status:'VERIFIED',rows:4,uniqueRows:4,splitCounts:{train:3,dev:1}});assert.equal(cold.providers.deepseek.calls,4);assert.equal(cold.providers.together.calls,13);assert.ok(!child.stdout.includes('PRIVATE_MODEL_PLAN'));assert.deepEqual(files(f.runtimeRoot),before);assert.deepEqual(files(join(f.base,'host')),hostBefore);
});
