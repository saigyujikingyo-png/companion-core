import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonical,hash } from '../src/wf1-json.ts';
import { validatePlan,validateSeal,validateSpec } from '../src/wf1-contract.ts';
import { computeFormal,verifyFormal } from '../src/wf1-verifier.ts';
import { providerBody,TeacherProvider } from '../src/wf1-provider.ts';
import { MODELS,WF1 } from '../src/wf1-types.ts';
import type { Authority,CampaignSpec,CampaignState,FormalSpec,Operation,Plan,Seal } from '../src/wf1-types.ts';
import { fixedSlotBinding,fixedSlotSchema,fixedSlotStopReason,projectFixedSlots,validateFixedSlotRequest,WF2_SLOTS_PROFILE_DIGEST } from '../src/wf2-fixed-slots.ts';
import { WF2_STRICT_PROFILE_DIGEST } from '../src/wf2-strict-data.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { bindTeacherCampaign,inspectTeacherCampaign,teacherWorkerBuildDigest } from '../src/wf2-teacher-worker.ts';
import { TeacherControlService } from '../src/wf2-teacher-service.ts';

// Independent public synthetic fixtures. No actual model material is read, regraded or repaired.
const marker='SYNTHETIC_SLOTS_06_e\u0301',capability='64'.repeat(32),key=Buffer.alloc(32,6);
const formal=(n:number):FormalSpec=>({verifier:'rational.evaluate.v1',input:{op:'value',numerator:String(n),denominator:'1'}});
const sealed=():Seal=>({version:'wf1-seal/1',rubric:marker,cases:Array.from({length:12},(_,i)=>({id:'seal'+i,roots:['seal-root'+i],formal:formal(100+i),target:computeFormal(formal(100+i))}))});
const plan=():Plan=>({version:'wf1-plan/1',plan:marker,families:Array.from({length:16},(_,i)=>({id:'family'+i,roots:['root'+i],split:(i+1)%4===0?'dev':'train',formal:formal(i)})),pairedFamilyIds:Array.from({length:8},(_,i)=>'family'+i)});
const table=(prefix:string,items:unknown[])=>Object.fromEntries(items.map((value,i)=>[prefix+String(i+1).padStart(2,'0'),value]));
const wireSeal=()=>{const s=sealed();return {version:'wf2-seal-slots/1',rubric:s.rubric,cases:table('case',s.cases)};};
const wirePlan=()=>{const p=plan();return {version:'wf2-plan-slots/1',plan:p.plan,families:table('family',p.families),pairedFamilyIds:table('pair',p.pairedFamilyIds)};};
const payload=(operation:Operation,data:unknown={fixture:marker})=>({protocol:'wf1-private-role/1',operation,role:'SyntheticRole',protocolInstruction:'inert',jsonProfile:{fixture:true},outputSchema:{unused:true},data});
function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-slots-'))),approvedTrainingRoot=join(base,'training'),runtimeRoot=join(approvedTrainingRoot,'run'),hostRoot=join(base,'host');mkdirSync(approvedTrainingRoot);mkdirSync(runtimeRoot);mkdirSync(hostRoot);
  const authorityPath=join(hostRoot,'authority.json'),now=1000,authority:Authority={schemaVersion:'wf1-host/1',campaignId:'synthetic-teacher06',revision:1,runtimeId:'owner',status:'ACTIVE',expiresAt:now+WF1.campaignMs,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}};writeFileSync(authorityPath,canonical(authority));
  const spec:CampaignSpec={schemaVersion:'wf1-campaign/0.6',id:authority.campaignId,createdAt:now,expiresAt:now+WF1.campaignMs,sourceDigest:teacherWorkerBuildDigest(),profileDigest:WF2_SLOTS_PROFILE_DIGEST,objectiveDigest:hash(marker),storageBindingDigest:bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest,prices:{deepseek:{snapshotId:'synthetic-ds',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000},together:{snapshotId:'synthetic-tg',inputMicroUsdPerMillion:150000,completionMicroUsdPerMillion:600000}}};
  const bootstrap={version:'wf2-teacher-bind/2',approvedTrainingRoot,runtimeRoot,authorityPath,expectedHead:null,spec,custodyKeyBase64:key.toString('base64'),objective:marker,credentials:{deepseek:'synthetic-only',together:'synthetic-only'},capability};return {base,approvedTrainingRoot,runtimeRoot,authorityPath,now,spec,bootstrap};
}
function inspection(f:ReturnType<typeof fixture>){return {version:'wf2-teacher-inspect/2',approvedTrainingRoot:f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,authorityPath:f.authorityPath,expectedHead:JSON.parse(readFileSync(f.authorityPath,'utf8')).head,spec:f.spec,custodyKeyBase64:key.toString('base64')};}
function state(f:ReturnType<typeof fixture>):CampaignState {const db=new DatabaseSync(join(f.runtimeRoot,'wf1-ledger.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT body FROM events ORDER BY sequence DESC LIMIT 1').get()!.body as string);}finally{db.close();}}
function files(root:string){return readdirSync(root).sort().map(name=>[name,hash(readFileSync(join(root,name)))]);}
type Failure='wire'|'roots'|'sealOracle'|'source'|'nonRational'|'firstOracle'|'candidateProtocol'|'review'|'usage';
function mock(f:ReturnType<typeof fixture>,failure?:Failure){const operations:string[]=[];let consumed=0;const provider=new TeacherProvider({deepseek:'synthetic-only',together:'synthetic-only'},{fetch:async(url,init)=>{
  const raw=String(init!.body),body=JSON.parse(raw),p=JSON.parse(body.messages[1].content),last=state(f).attempts.at(-1)!;operations.push(p.operation);assert.equal(last.requestCommitment,hash(raw));assert.equal(last.outcome,null);assert.deepEqual(last.requestBinding,fixedSlotBinding(last.provider,last.operation));assert.equal(url,last.requestBinding!.endpoint);consumed++;assert.ok(!raw.includes('json.pointer.v1'));
  let content:unknown;
  if(p.operation==='seal'){const w=wireSeal();if(failure==='wire')delete w.cases.case12;if(failure==='roots')(w.cases.case01 as any).roots=[];if(failure==='sealOracle')(w.cases.case01 as any).target={numerator:'-7',denominator:'1'};if(failure==='source')(w.cases.case02 as any).roots=(w.cases.case01 as any).roots;if(failure==='nonRational'){(w.cases.case01 as any).formal={verifier:'json.pointer.v1',input:{document:{x:1},pointer:'/x'}};(w.cases.case01 as any).target=1;}content=w;}
  else if(p.operation==='plan')content=wirePlan();else if(p.operation==='rubric')content={version:'wf1-rubric/1',rubric:marker};
  else if(p.operation==='review'||p.operation==='comparison_review')content={version:'wf1-review/1',disposition:failure==='review'?'FLAG':'CLEAR',notes:marker};
  else content={version:'wf1-candidate/1',target:failure==='firstOracle'?{numerator:'-77',denominator:'1'}:computeFormal(p.data.formalInput)};
  const deepseek=body.model===MODELS.deepseek,message=deepseek?{role:'assistant',content:'',tool_calls:[{id:'synthetic-call',index:0,type:'function',function:{name:body.tool_choice.function.name,arguments:JSON.stringify(content)}}]}:{role:'assistant',content:JSON.stringify(content)};
  if(!deepseek){assert.equal(body.tools,undefined);assert.equal(last.requestBinding!.payloadCodec,'WF2_CANONICAL_V1');}
  return new Response(JSON.stringify({model:body.model,choices:[{index:0,finish_reason:failure==='candidateProtocol'&&p.operation==='candidate'?'length':deepseek?'tool_calls':'stop',message}],...(failure==='usage'?{}:{usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}})}),{status:200,headers:{'content-type':'application/json'}});
}});return {provider,operations,get consumed(){return consumed;}};}

test('fixed-slot schema uses only supported keywords, exact required keys and explicit split values',()=>{
  const allowed=new Set(['type','properties','required','additionalProperties','items','enum','anyOf','$ref','$def','pattern']);
  function check(schema:any,root:any):void {for(const k of Object.keys(schema))assert.ok(allowed.has(k),k);if(schema.type==='object'){assert.equal(schema.additionalProperties,false);assert.deepEqual([...schema.required].sort(),Object.keys(schema.properties).sort());Object.values(schema.properties).forEach(v=>check(v,root));}if(schema.items)check(schema.items,root);if(schema.anyOf)schema.anyOf.forEach((v:any)=>check(v,root));if(schema.$def)Object.values(schema.$def).forEach(v=>check(v,root));if(schema.$ref)assert.ok(root.$def[schema.$ref.slice('#/$def/'.length)]);}
  for(const operation of ['seal','plan'] as const){const schema:any=fixedSlotSchema(operation);check(schema,schema);const raw=providerBody('deepseek',payload(operation,{verbatimCurrentUserInstruction:'a'.repeat(8192)}),operation,'wf1-campaign/0.6');assert.ok(Buffer.byteLength(raw)<=16384);const body=JSON.parse(raw);assert.equal(canonical(body.tools[0].function.parameters),canonical(schema));validateFixedSlotRequest('deepseek',operation,raw,fixedSlotBinding('deepseek',operation));}
  const ps:any=fixedSlotSchema('plan');assert.equal(ps.properties.families.required.length,16);assert.equal(ps.properties.pairedFamilyIds.required.length,8);assert.deepEqual(ps.$def.trainFamily.properties.split.enum,['train']);assert.deepEqual(ps.$def.devFamily.properties.split.enum,['dev']);assert.equal((fixedSlotSchema('seal') as any).properties.cases.required.length,12);
  const f=fixture();assert.equal(validateSpec(f.spec).schemaVersion,'wf1-campaign/0.6');assert.throws(()=>validateSpec({...f.spec,profileDigest:WF2_STRICT_PROFILE_DIGEST}));assert.equal(WF2_STRICT_PROFILE_DIGEST,'c6c8e10b08940d6517b5cd8b8ba9e6459f9d1b016ef1dda220816c7c5e4da8e6');
  const missing:Record<string,unknown>={...f.bootstrap};delete missing.approvedTrainingRoot;
  for(const invalid of [missing,{...f.bootstrap,approvedTrainingRoot:join(f.base,'host')},{...f.bootstrap,spec:{...f.spec,storageBindingDigest:'0'.repeat(64)}}])assert.throws(()=>bindTeacherCampaign(invalid));
  assert.deepEqual(readdirSync(f.runtimeRoot),[]);assert.equal(JSON.parse(readFileSync(f.authorityPath,'utf8')).head,null);
});

test('projection rejects every missing slot, compensating extra slots, old arrays, null and wrong versions',()=>{
  for(const [operation,original,field] of [['seal',wireSeal(),'cases'],['plan',wirePlan(),'families'],['plan',wirePlan(),'pairedFamilyIds']] as const){
    for(const name of Object.keys((original as any)[field])){const missing:any=structuredClone(original);delete missing[field][name];assert.throws(()=>projectFixedSlots(operation,missing,'STRICT_TOOL_ARGUMENTS'));missing[field].extra={};assert.throws(()=>projectFixedSlots(operation,missing,'STRICT_TOOL_ARGUMENTS'));}
    for(const value of [null,[],{...original,version:'wrong'},original===null?null:{...original,[field]:null}])assert.throws(()=>projectFixedSlots(operation,value,'STRICT_TOOL_ARGUMENTS'));
  }
  assert.throws(()=>projectFixedSlots('seal',sealed(),'STRICT_TOOL_ARGUMENTS'));assert.throws(()=>projectFixedSlots('plan',plan(),'STRICT_TOOL_ARGUMENTS'));assert.throws(()=>projectFixedSlots('seal',wireSeal(),'NATIVE_FINAL'));
  const extra:any=wireSeal();extra.cases.case01.extra='unselected';assert.throws(()=>projectFixedSlots('seal',extra,'STRICT_TOOL_ARGUMENTS'));const swapped:any=wirePlan();swapped.families.family01.split='dev';swapped.families.family04.split='train';assert.throws(()=>projectFixedSlots('plan',swapped,'STRICT_TOOL_ARGUMENTS'));
});

test('projection uses fixed slot order, preserves NFD and every substantive field, then original local gates still apply',()=>{
  const s=wireSeal(),p=wirePlan();s.cases=Object.fromEntries(Object.entries(s.cases).reverse());p.families=Object.fromEntries(Object.entries(p.families).reverse());p.pairedFamilyIds=Object.fromEntries(Object.entries(p.pairedFamilyIds).reverse());
  const projectedSeal=projectFixedSlots('seal',s,'STRICT_TOOL_ARGUMENTS'),projectedPlan=projectFixedSlots('plan',p,'STRICT_TOOL_ARGUMENTS');assert.equal(canonical(projectedSeal),canonical(sealed()));assert.equal(canonical(projectedPlan),canonical(plan()));assert.notEqual(marker,marker.normalize('NFC'));validateSeal(projectedSeal);validatePlan(projectedPlan);
  const duplicate:any=wireSeal();duplicate.cases.case02.id=duplicate.cases.case01.id;assert.throws(()=>validateSeal(projectFixedSlots('seal',duplicate,'STRICT_TOOL_ARGUMENTS')));
  const roots:any=wireSeal();roots.cases.case01.roots=Array.from({length:17},(_,i)=>'root'+i);assert.throws(()=>validateSeal(projectFixedSlots('seal',roots,'STRICT_TOOL_ARGUMENTS')));roots.cases.case01.roots=['x','x'];assert.throws(()=>validateSeal(projectFixedSlots('seal',roots,'STRICT_TOOL_ARGUMENTS')));
  const badFormal:any=wireSeal();badFormal.cases.case01.formal.input.numerator='01';assert.throws(()=>validateSeal(projectFixedSlots('seal',badFormal,'STRICT_TOOL_ARGUMENTS')));
  const pairs:any=wirePlan();pairs.pairedFamilyIds.pair02=pairs.pairedFamilyIds.pair01;assert.throws(()=>validatePlan(projectFixedSlots('plan',pairs,'STRICT_TOOL_ARGUMENTS')));pairs.pairedFamilyIds.pair02='not-in-plan';assert.throws(()=>validatePlan(projectFixedSlots('plan',pairs,'STRICT_TOOL_ARGUMENTS')));
  const target:any=wireSeal();target.cases.case01.target={numerator:'-1',denominator:'1'};const accepted=validateSeal(projectFixedSlots('seal',target,'STRICT_TOOL_ARGUMENTS'));assert.equal(verifyFormal(accepted.cases[0]!.formal,accepted.cases[0]!.target).status,'CONTRADICTED');
});

test('explicit binding rejects codec/operation mismatch before fetch, without response-based fallback',async()=>{
  const body=providerBody('deepseek',payload('seal'),'seal','wf1-campaign/0.6'),binding=fixedSlotBinding('deepseek','seal');let sends=0;const provider=new TeacherProvider({deepseek:'synthetic-only',together:null},{fetch:async()=>{sends++;throw Error('must not send');}});
  assert.throws(()=>validateFixedSlotRequest('deepseek','seal',body,{...binding,payloadCodec:'WF2_CANONICAL_V1'}));assert.throws(()=>validateFixedSlotRequest('deepseek','plan',body,binding));
  await assert.rejects(provider.submit('deepseek',body,{} as never,new AbortController().signal,send=>send(),{operation:'seal',binding:{...binding,payloadCodec:'WF2_CANONICAL_V1'}}));assert.equal(sends,0);
});

test('new fixed-slot campaign completes 51 synthetic calls and cross-process manifest verification without sealed reads',async()=>{
  const f=fixture(),m=mock(f),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),service=new TeacherControlService(b.run,capability);service.dispatch({version:1,requestId:'start',operation:'start',capability});await service.settled();const receipt=service.completionReceipt();assert.equal(receipt.metadata.campaignStatus,'COMPLETED');assert.equal(receipt.metadata.calls.deepseek,43);assert.equal(receipt.metadata.calls.together,8);assert.equal(receipt.metadata.candidates.qualified,24);assert.equal(m.consumed,51);service.acknowledgeCompleted(receipt.digest);service.ownerLost();
  const recorded=state(f);assert.equal(recorded.attempts[0]!.requestBinding!.payloadCodec,'WF2_FIXED_SLOTS_V1');assert.equal(recorded.attempts[0]!.result!.argumentsRef!.kind,'strict-tool-arguments');assert.equal(recorded.attempts[0]!.result!.finalRef,null);
  for(const name of readdirSync(f.runtimeRoot).filter(n=>n.startsWith('custody-')))renameSync(join(f.runtimeRoot,name),join(f.runtimeRoot,name+'.unavailable'));const before=files(f.runtimeRoot),hostBefore=files(join(f.base,'host'));
  const source=`import {inspectTeacherCampaign} from ${JSON.stringify(new URL('../src/wf2-teacher-inspect.ts',import.meta.url).href)};let raw='';for await(const p of process.stdin)raw+=p;process.stdout.write(JSON.stringify(inspectTeacherCampaign(JSON.parse(raw),()=>1000)));`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{input:canonical(inspection(f)),encoding:'utf8',timeout:5000,maxBuffer:32768,windowsHide:true});assert.equal(child.status,0,child.stderr);const cold=JSON.parse(child.stdout);assert.deepEqual(cold.manifestVerification,{status:'VERIFIED',rows:16,uniqueRows:16,splitCounts:{train:12,dev:4}});assert.equal(cold.providers.deepseek.calls,43);assert.equal(cold.providers.together.calls,8);assert.equal(cold.actualInvoice,'UNKNOWN');assert.ok(!child.stdout.includes(marker));assert.deepEqual(files(f.runtimeRoot),before);assert.deepEqual(files(join(f.base,'host')),hostBefore);
});

test('wire/local/oracle/source/review reasons come from recorded failures; first-four and unknown usage never continue',async()=>{
  const expected={wire:['WIRE_DECODE',1],roots:['LOCAL_SCHEMA',1],sealOracle:['EXACT_ORACLE',1],source:['SOURCE',1],nonRational:['LOCAL_SCHEMA',1],firstOracle:['EXACT_ORACLE',4],candidateProtocol:['UNKNOWN',4],review:['REVIEW',5],usage:['USAGE_OR_TRANSPORT_UNKNOWN',1]} as const;
  for(const failure of Object.keys(expected) as Failure[]){const f=fixture(),m=mock(f,failure),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});try{await b.run.run();assert.equal(b.run.metadata().campaignStatus,'STOPPED',failure);assert.equal(b.stopReason!(),expected[failure][0],failure);assert.equal(m.operations.length,expected[failure][1],failure);assert.equal(b.run.metadata().candidates.qualified,0);}finally{b.run.withdraw('REVOKED');}const cold=inspectTeacherCampaign(inspection(f),()=>f.now);assert.equal(cold.manifestVerification.status,'NOT_READ');assert.equal(cold.providers.deepseek!.calls,expected[failure][1]);}
  assert.equal(fixedSlotStopReason('unexpected private message'),'UNKNOWN');assert.equal(fixedSlotStopReason({toString(){throw Error('must not invoke');}}),'UNKNOWN');
});
