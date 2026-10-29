import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,realpathSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical,hash } from '../../src/wf1-json.ts';
import { computeFormal } from '../../src/wf1-verifier.ts';
import { TeacherProvider } from '../../src/wf1-provider.ts';
import { MODELS,WF1 } from '../../src/wf1-types.ts';
import type { Authority,CampaignSpec,CampaignState,FormalSpec,Operation } from '../../src/wf1-types.ts';
import { bindTrainingRoot } from '../../src/wf2-training-root.ts';
import { teacherWorkerBuildDigest } from '../../src/wf2-teacher-build.ts';
import { UNIT_CURRICULUM,unitBinding,unitCompletion,unitProvider,WF2_UNIT_PROFILE_DIGEST } from '../../src/wf2-unit-pilot.ts';
import type { PlanUnit,SealedUnit } from '../../src/wf2-unit-pilot.ts';

export const unitMarker='SYNTHETIC_UNIT_OBJECTIVE',unitKey=Buffer.alloc(32,8),unitCapability='68'.repeat(32);
const leaf=(n:number)=>({op:'value',numerator:String(n),denominator:'1'});
export function unitFormal(index:number,kind:'seal'|'plan'):FormalSpec {const n=(kind==='seal'?100:10)+index;return {verifier:'rational.evaluate.v1',input:{op:UNIT_CURRICULUM.rootOperations[index]!,left:kind==='seal'?leaf(n):{op:'add',left:leaf(n),right:leaf(2)},right:kind==='seal'?leaf(3):{op:'add',left:leaf(3),right:leaf(1)}}};}
export function sealUnit(index:number):SealedUnit {const formal=unitFormal(index,'seal');return {version:'wf2-seal-unit/1',case:{id:'seal-private-'+index,roots:['SEALED_CONTENT_ROOT_'+index],formal,target:computeFormal(formal)}};}
export function planUnit(index:number):PlanUnit {return {version:'wf2-plan-unit/1',plan:'PRIVATE_MODEL_PLAN_TEXT_'+index,family:{id:'family'+index,roots:['PLAN_CONTENT_ROOT_'+index],split:index===3?'dev':'train',formal:unitFormal(index,'plan')}};}
export function unitFixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-unit-'))),approvedTrainingRoot=join(base,'training'),runtimeRoot=join(approvedTrainingRoot,'run'),hostRoot=join(base,'host');mkdirSync(approvedTrainingRoot);mkdirSync(runtimeRoot);mkdirSync(hostRoot);
  const authorityPath=join(hostRoot,'authority.json'),now=1000,authority:Authority={schemaVersion:'wf1-host/1',campaignId:'synthetic-unit08',revision:1,runtimeId:'owner',status:'ACTIVE',expiresAt:now+WF1.campaignMs,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}};writeFileSync(authorityPath,canonical(authority));
  const spec:CampaignSpec={schemaVersion:'wf1-campaign/0.8',id:authority.campaignId,createdAt:now,expiresAt:now+WF1.campaignMs,sourceDigest:teacherWorkerBuildDigest(),profileDigest:WF2_UNIT_PROFILE_DIGEST,objectiveDigest:hash(unitMarker),storageBindingDigest:bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest,prices:{deepseek:{snapshotId:'synthetic-ds',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000},together:{snapshotId:'synthetic-tg',inputMicroUsdPerMillion:150000,completionMicroUsdPerMillion:600000}}};
  const bootstrap={version:'wf2-teacher-bind/2',approvedTrainingRoot,runtimeRoot,authorityPath,expectedHead:null,spec,custodyKeyBase64:unitKey.toString('base64'),objective:unitMarker,credentials:{deepseek:'synthetic-ds',together:'synthetic-tg'},capability:unitCapability};return {base,approvedTrainingRoot,runtimeRoot,authorityPath,now,spec,bootstrap};
}
export function unitInspection(f:ReturnType<typeof unitFixture>){return {version:'wf2-teacher-inspect/2',approvedTrainingRoot:f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,authorityPath:f.authorityPath,expectedHead:JSON.parse(readFileSync(f.authorityPath,'utf8')).head,spec:f.spec,custodyKeyBase64:unitKey.toString('base64')};}
export function unitState(runtimeRoot:string):CampaignState {const db=new DatabaseSync(join(runtimeRoot,'wf1-ledger.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT body FROM events ORDER BY sequence DESC LIMIT 1').get()!.body as string);}finally{db.close();}}
export type UnitFault={operation:Operation;index:number|null;kind:'version'|'split'|'root'|'depth'|'duplicateId'|'rootsCollision'|'source'|'target'|'flag'|'usage'|'syntax'};
export function unitMock(runtimeRoot:string,fault?:UnitFault,beforeResponse?:(operation:Operation,index:number|null)=>Promise<void>){
  const operations:Array<{operation:Operation;unitIndex:number|null;provider:string}>=[];
  const provider=new TeacherProvider({deepseek:'synthetic-ds',together:'synthetic-tg'},{fetch:async(url,init)=>{
    const raw=String(init!.body),body=JSON.parse(raw),request=JSON.parse(body.messages[1].content),operation=request.operation as Operation,index=request.unit?.index??null,expectedProvider=unitProvider(operation),record=unitState(runtimeRoot).attempts.at(-1)!;
    operations.push({operation,unitIndex:index,provider:expectedProvider});assert.equal(record.outcome,null);assert.equal(record.requestCommitment,hash(raw));assert.equal(record.unitIndex,index);assert.deepEqual(record.requestBinding,unitBinding(expectedProvider,operation,index));assert.equal(url,record.requestBinding!.endpoint);assert.equal(body.model,MODELS[expectedProvider]);assert.equal(body.max_tokens,unitCompletion(operation));assert.equal(body.tools,undefined);assert.equal(body.messages.length,2);
    if(expectedProvider==='deepseek'){assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'high');assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.messages[0].role,'system');assert.deepEqual(Object.keys(request.data).sort(),['formalInput','reviewClass','rubric','typedTarget']);assert.ok(!raw.includes(unitMarker));assert.ok(!raw.includes('PRIVATE_MODEL_PLAN_TEXT_'));}
    else {assert.equal(body.reasoning_effort,'medium');assert.equal(body.response_format.type,'json_schema');assert.equal(body.messages[0].role,'developer');assert.ok(body.messages[0].content.endsWith(canonical(body.response_format.json_schema.schema)));}
    if(operation!=='seal'){assert.ok(!raw.includes('SEALED_CONTENT_ROOT_'));assert.ok(!raw.includes('seal-private-'));}
    if(operation==='candidate'){assert.equal(request.data.coordinatorPlan,planUnit(index!).plan);for(let i=0;i<4;i++)if(i!==index)assert.ok(!raw.includes(planUnit(i).plan));}
    if(operation==='rubric'||operation==='plan')assert.ok(!raw.includes('PRIVATE_MODEL_PLAN_TEXT_'));
    let content:any=operation==='seal'?sealUnit(index!):operation==='plan'?planUnit(index!):operation==='rubric'?{version:'wf1-rubric/1',rubric:'SYNTHETIC_UNTRUSTED_RUBRIC'}:operation==='candidate'?{version:'wf1-candidate/1',target:computeFormal(request.data.formalInput)}:{version:'wf1-review/1',disposition:'CLEAR',notes:'SYNTHETIC_REVIEW'};
    const active=fault?.operation===operation&&fault.index===index;
    if(active){if(fault.kind==='version')content.version='wrong';if(fault.kind==='split')content.family.split='dev';if(fault.kind==='root')content.family.formal.input.op='div';if(fault.kind==='depth')content.family.formal=unitFormal(index!,'seal');if(fault.kind==='duplicateId')(operation==='seal'?content.case:content.family).id=operation==='seal'?sealUnit(0).case.id:planUnit(0).family.id;if(fault.kind==='rootsCollision')(operation==='seal'?content.case:content.family).roots=operation==='seal'?sealUnit(0).case.roots:planUnit(0).family.roots;if(fault.kind==='source')content.family.roots=sealUnit(index!).case.roots;if(fault.kind==='target')content.target={numerator:'9999',denominator:'1'};if(fault.kind==='flag')content.disposition='FLAG';}
    await beforeResponse?.(operation,index);
    return new Response(JSON.stringify({model:MODELS[expectedProvider],choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:active&&fault.kind==='syntax'?'{broken':JSON.stringify(content),...(expectedProvider==='together'?{reasoning:'PRIVATE_REASONING'}:{reasoning_content:'PRIVATE_REASONING'})}}],...(active&&fault.kind==='usage'?{}:{usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50,completion_tokens_details:{reasoning_tokens:10}}})}),{headers:{'content-type':'application/json'}});
  }});return {provider,operations};
}
