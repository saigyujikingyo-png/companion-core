import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync,ftruncateSync,openSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { canonical,hash,Wf1Error } from '../src/wf1-json.ts';
import { validatePlan } from '../src/wf1-contract.ts';
import { computeFormal } from '../src/wf1-verifier.ts';
import { TeachingCampaign } from '../src/wf1-campaign.ts';
import { TeacherProvider } from '../src/wf1-provider.ts';
import { HostAuthority } from '../src/wf1-storage.ts';
import { MODELS,WF1 } from '../src/wf1-types.ts';
import type { Authority,CampaignSpec,CampaignState,FormalSpec,Operation,Plan } from '../src/wf1-types.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { fixedSlotStopReason } from '../src/wf2-fixed-slots.ts';
import { bindTeacherCampaign,inspectTeacherCampaign,teacherWorkerBuildDigest,TEACHER_WORKER_FILES } from '../src/wf2-teacher-worker.ts';
import { validateTeacherMetadata } from '../src/wf2-teacher-service.ts';
import { WF2_PILOT_PROFILE_DIGEST } from '../src/wf2-together-pilot.ts';
import { captureFailureDiagnostic,FAILURE_CODES,projectFailureDiagnostic,unknownFailureDiagnostic,validateFailureDiagnostic } from '../src/wf2-failure-diagnostic.ts';

const marker='SYNTHETIC_PRIVATE_DIAGNOSTIC_PAYLOAD',key=Buffer.alloc(32,6),capability='64'.repeat(32);
const formal=(n:number):FormalSpec=>({verifier:'rational.evaluate.v1',input:{op:'value',numerator:String(n),denominator:'1'}});
const plan=():Plan=>({version:'wf1-plan/1',plan:marker,families:Array.from({length:16},(_,i)=>({id:'family'+i,roots:['root'+i],split:(i+1)%4===0?'dev':'train',formal:formal(i)})),pairedFamilyIds:Array.from({length:8},(_,i)=>'family'+i)});
const table=(prefix:string,items:unknown[])=>Object.fromEntries(items.map((value,i)=>[prefix+String(i+1).padStart(2,'0'),value]));
function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-failure-'))),approvedTrainingRoot=join(base,'training'),runtimeRoot=join(approvedTrainingRoot,'run'),hostRoot=join(base,'host');mkdirSync(approvedTrainingRoot);mkdirSync(runtimeRoot);mkdirSync(hostRoot);
  const authorityPath=join(hostRoot,'authority.json'),now=1000,authority:Authority={schemaVersion:'wf1-host/1',campaignId:'synthetic-diagnostic',revision:1,runtimeId:'owner',status:'ACTIVE',expiresAt:now+WF1.campaignMs,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}};writeFileSync(authorityPath,canonical(authority));
  const spec:CampaignSpec={schemaVersion:'wf1-campaign/0.7',id:authority.campaignId,createdAt:now,expiresAt:now+WF1.campaignMs,sourceDigest:teacherWorkerBuildDigest(),profileDigest:WF2_PILOT_PROFILE_DIGEST,objectiveDigest:hash(marker),storageBindingDigest:bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest,prices:{deepseek:{snapshotId:'synthetic-ds',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000},together:{snapshotId:'synthetic-tg',inputMicroUsdPerMillion:150000,completionMicroUsdPerMillion:600000}}};
  const bootstrap={version:'wf2-teacher-bind/2',approvedTrainingRoot,runtimeRoot,authorityPath,expectedHead:null,spec,custodyKeyBase64:key.toString('base64'),objective:marker,credentials:{deepseek:null,together:'synthetic-only'},capability};return {base,approvedTrainingRoot,runtimeRoot,authorityPath,now,spec,bootstrap};
}
function inspection(f:ReturnType<typeof fixture>){return {version:'wf2-teacher-inspect/2',approvedTrainingRoot:f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,authorityPath:f.authorityPath,expectedHead:JSON.parse(readFileSync(f.authorityPath,'utf8')).head,spec:f.spec,custodyKeyBase64:key.toString('base64')};}
function states(f:ReturnType<typeof fixture>):CampaignState[] {const db=new DatabaseSync(join(f.runtimeRoot,'wf1-ledger.sqlite'),{readOnly:true});try{return db.prepare('SELECT body FROM events ORDER BY sequence').all().map(r=>JSON.parse(r.body as string));}finally{db.close();}}
function files(root:string){return readdirSync(root).sort().map(name=>[name,hash(readFileSync(join(root,name)))]);}
type Failure='pair'|'split'|'enum'|'candidate'|'review'|'rubric';
function mock(failure:Failure='pair'){
  const operations:Operation[]=[];
  const provider=new TeacherProvider({deepseek:null,together:'synthetic-only'},{fetch:async(_url,init)=>{
    const body=JSON.parse(String(init!.body)),p=JSON.parse(body.messages[1].content),operation=p.operation as Operation;operations.push(operation);
    let content:unknown;
    if(operation==='seal')content={version:'wf2-seal-slots/1',rubric:marker,cases:table('case',Array.from({length:12},(_,i)=>({id:'seal'+i,roots:['sealed-root'+i],formal:formal(100+i),target:computeFormal(formal(100+i))})))};
    else if(operation==='plan'){
      const data=plan();if(failure==='pair')data.pairedFamilyIds[0]='absent-family';if(failure==='split')data.families[0]!.split='dev';if(failure==='enum')data.families[0]!.formal={verifier:'rational.evaluate.v1',input:{op:'unsupported',left:formal(0).input,right:formal(1).input}};
      content={version:'wf2-plan-slots/1',plan:data.plan,families:table('family',data.families),pairedFamilyIds:table('pair',data.pairedFamilyIds)};
    }else if(operation==='rubric')content={version:failure==='rubric'?'bad':'wf1-rubric/1',rubric:marker};
    else if(operation==='candidate')content={version:failure==='candidate'?'bad':'wf1-candidate/1',target:computeFormal(p.data.formalInput)};
    else content={version:failure==='review'?'bad':'wf1-review/1',disposition:'CLEAR',notes:marker};
    return new Response(JSON.stringify({model:MODELS.together,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(content),reasoning:marker}}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}}),{headers:{'content-type':'application/json'}});
  }});return {provider,operations};
}

test('failure vocabulary covers every literal Wf1Error throw in the worker closure without prefix acceptance',()=>{
  for(const name of TEACHER_WORKER_FILES){
    const source=ts.createSourceFile(name,readFileSync(new URL('../src/'+name,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
    function leaf(node:ts.Node):void {if(ts.isStringLiteral(node))assert.ok((FAILURE_CODES as readonly string[]).includes(node.text),name+': '+node.text);else if(ts.isConditionalExpression(node)){leaf(node.whenTrue);leaf(node.whenFalse);}else assert.ok(name==='wf1-json.ts'&&ts.isIdentifier(node)&&node.text==='code','unclassified dynamic error in '+name);}
    function visit(node:ts.Node):void {if((ts.isCallExpression(node)&&node.expression.getText(source)==='stop')||(ts.isNewExpression(node)&&node.expression.getText(source)==='Wf1Error'))leaf(node.arguments![0]!);ts.forEachChild(node,visit);}
    visit(source);
  }
  for(const code of ['WF1_SPLIT','WF1_PAIR_BINDING','WF1_ENUM','WF1_UNICODE','WF1_JSON_LIMIT','WF1_POINTER'])assert.equal(fixedSlotStopReason(code),'LOCAL_SCHEMA');
  for(const [mutate,code] of [[(p:Plan)=>{p.families[0]!.split='dev';},'WF1_SPLIT'],[(p:Plan)=>{p.pairedFamilyIds[0]='absent';},'WF1_PAIR_BINDING']] as const){const p=plan();mutate(p);assert.throws(()=>validatePlan(p),e=>e instanceof Wf1Error&&e.code===code);}
  assert.equal(captureFailureDiagnostic(new Wf1Error('WF1_PRIVATE_'+marker),'PLAN_VALIDATION').code,'UNKNOWN');
});

test('diagnostics are closed data, do not execute accessors, preserve known legacy code without inventing stage, and erase stale claims',()=>{
  const d=captureFailureDiagnostic(new Wf1Error('WF1_PAIR_BINDING'),'PLAN_VALIDATION');assert.deepEqual(validateFailureDiagnostic(d),d);
  for(const bad of [{...d,private:marker},{...d,version:'new'},{...d,stage:marker},{...d,code:marker}])assert.throws(()=>validateFailureDiagnostic(bad));
  const trap={get version(){throw Error(marker);}};assert.deepEqual(projectFailureDiagnostic(trap,true),unknownFailureDiagnostic());
  const error=new Wf1Error('WF1_FIELDS');Object.defineProperty(error,'code',{get(){throw Error(marker);}});assert.equal(captureFailureDiagnostic(error,'PLAN_VALIDATION').code,'UNKNOWN');
  assert.equal(captureFailureDiagnostic(new Error('WF1_PAIR_BINDING '+marker),'PLAN_VALIDATION').code,'UNKNOWN');
  assert.deepEqual(projectFailureDiagnostic(undefined,true,'WF1_PAIR_BINDING'),{...unknownFailureDiagnostic(),code:'WF1_PAIR_BINDING'});
  assert.deepEqual(projectFailureDiagnostic(undefined,true,marker),unknownFailureDiagnostic());assert.deepEqual(projectFailureDiagnostic(d,false,'WF1_PAIR_BINDING'),unknownFailureDiagnostic());
});

test('actual plan and swallowed candidate/review errors persist one source-bound diagnostic with STOPPED and retain response NONE',async()=>{
  const expected={pair:['PLAN_VALIDATION','WF1_PAIR_BINDING',2],split:['PLAN_VALIDATION','WF2_SLOT_WIRE_REJECTED',2],enum:['PLAN_VALIDATION','WF1_ENUM',2],rubric:['RUBRIC_VALIDATION','WF1_PROTOCOL',3],candidate:['CANDIDATE_VALIDATION','WF1_PROTOCOL',4],review:['REVIEW_VALIDATION','WF1_PROTOCOL',5]} as const;
  for(const failure of Object.keys(expected) as Failure[]){const f=fixture(),m=mock(failure),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});
    try{await b.run.run();const terminal=b.terminal!(),[stage,code,count]=expected[failure];assert.deepEqual(terminal.failureDiagnostic,{version:'wf2-failure-diagnostic/1',stage,code});assert.equal(terminal.responseFailureCode,'NONE');assert.equal(terminal.metadata.campaignStatus,'STOPPED');assert.equal(terminal.metadata.candidates.qualified,0);assert.equal(m.operations.length,count);assert.equal(terminal.metadata.manifestFrozen,false);
      const journal=states(f),last=journal.at(-1)!;assert.deepEqual(last.failureDiagnostic,terminal.failureDiagnostic);assert.ok(journal.slice(0,-1).every(s=>s.failureDiagnostic===undefined));assert.equal(last.status,'STOPPED');if(failure==='candidate')assert.equal(last.code,'WF2_FIRST_UNKNOWN');if(failure==='review')assert.equal(last.code,'WF2_FIRST_REVIEW');
      assert.throws(()=>validateTeacherMetadata({...terminal.metadata,failureDiagnostic:terminal.failureDiagnostic},WF2_PILOT_PROFILE_DIGEST));assert.ok(!canonical(terminal).includes(marker));
    }finally{b.run.withdraw('REVOKED');}
    assert.deepEqual(b.terminal!().failureDiagnostic,unknownFailureDiagnostic());const before=files(f.runtimeRoot),cold=inspectTeacherCampaign(inspection(f),()=>f.now);assert.deepEqual(cold.failureDiagnostic,{version:'wf2-failure-diagnostic/1',stage:expected[failure][0],code:expected[failure][1]});assert.equal(cold.status,'RECORDED_CLAIMS_ONLY');assert.equal(cold.authorityStatus,'REVOKED');assert.equal(cold.manifestVerification.status,'NOT_READ');assert.equal(cold.automaticResume,false);assert.deepEqual(files(f.runtimeRoot),before);
  }
});

test('pre-dispatch failure uses the actual new boundary, never the latest older attempt',async()=>{
  const original=TeachingCampaign.prototype.reserveAttempt;
  TeachingCampaign.prototype.reserveAttempt=function(operation,body,familyId){if(operation==='plan')throw new Wf1Error('WF1_REQUEST_BYTES');return original.call(this,operation,body,familyId);};
  const f=fixture(),m=mock(),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});
  try{await b.run.run();assert.deepEqual(m.operations,['seal']);assert.equal(states(f).at(-1)!.attempts.at(-1)!.operation,'seal');assert.deepEqual(b.terminal!().failureDiagnostic,{version:'wf2-failure-diagnostic/1',stage:'PLAN_REQUEST',code:'WF1_REQUEST_BYTES'});}finally{TeachingCampaign.prototype.reserveAttempt=original;b.run.withdraw('REVOKED');}
});

test('half commit cannot publish cached local failure or reuse its diagnostic as current evidence',async()=>{
  const f=fixture(),m=mock(),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),original=HostAuthority.prototype.commitHead;
  HostAuthority.prototype.commitHead=function(){throw new Wf1Error('WF1_HEAD_MISMATCH');};
  try{await b.run.run();assert.equal(m.operations.length,0);const terminal=b.terminal!();assert.equal(terminal.metadata.countCompleteness,'STALE_OR_UNKNOWN');assert.equal(terminal.metadata.calls.together,null);assert.deepEqual(terminal.failureDiagnostic,unknownFailureDiagnostic());assert.equal(terminal.responseFailureCode,'UNKNOWN');}finally{HostAuthority.prototype.commitHead=original;b.run.withdraw('REVOKED');}
});

test('cold separate process reads only authenticated diagnostic claims even when every payload artifact is unavailable',async()=>{
  const f=fixture(),m=mock(),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});await b.run.run();const live=b.terminal!();b.run.withdraw('REVOKED');
  for(const name of readdirSync(f.runtimeRoot).filter(n=>n.endsWith('.bin')))renameSync(join(f.runtimeRoot,name),join(f.runtimeRoot,name+'.unavailable'));
  const before=files(f.runtimeRoot),hostBefore=files(join(f.base,'host')),source=`import {inspectTeacherCampaign} from ${JSON.stringify(new URL('../src/wf2-teacher-inspect.ts',import.meta.url).href)};let raw='';for await(const part of process.stdin)raw+=part;process.stdout.write(JSON.stringify(inspectTeacherCampaign(JSON.parse(raw),()=>1000)));`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{input:canonical(inspection(f)),encoding:'utf8',timeout:5000,maxBuffer:32768,windowsHide:true});assert.equal(child.status,0,child.stderr);const cold=JSON.parse(child.stdout);assert.equal(cold.version,'wf2-teacher-inspection/5');assert.deepEqual(cold.failureDiagnostic,live.failureDiagnostic);assert.equal(cold.manifestVerification.status,'NOT_READ');assert.equal(cold.authorityStatus,'REVOKED');assert.ok(!child.stdout.includes(marker));assert.deepEqual(files(f.runtimeRoot),before);assert.deepEqual(files(join(f.base,'host')),hostBefore);
});


test('candidate storage failure publishes neither target nor qualified row and stops before review with its original cause',async()=>{
  const f=fixture(),m=mock('review'),original=m.provider.submit.bind(m.provider);
  m.provider.submit=async(...args)=>{const result=await original(...args);if(args[5]?.operation==='candidate'){const fd=openSync(join(f.runtimeRoot,'synthetic-capacity-pressure.bin'),'wx');try{ftruncateSync(fd,WF1.runBytes);}finally{closeSync(fd);}}return result;};
  const b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});
  try{await b.run.run();assert.deepEqual(m.operations,['seal','plan','rubric','candidate']);const terminal=b.terminal!(),recorded=states(f).at(-1)!;assert.deepEqual(terminal.failureDiagnostic,{version:'wf2-failure-diagnostic/1',stage:'CANDIDATE_STORE',code:'WF1_DISK_LIMIT'});assert.equal(terminal.metadata.candidates.qualified,0);assert.equal(recorded.candidates[0]!.targetRef,null);assert.equal(recorded.candidates[0]!.review,'UNKNOWN');assert.equal(recorded.code,'WF2_FIRST_UNKNOWN');assert.equal(terminal.metadata.manifestFrozen,false);}finally{b.run.withdraw('REVOKED');}
});
