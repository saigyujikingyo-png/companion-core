import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fields,hash,integer,stop } from '../src/wf1-json.ts';
import { nativeUsage,TeacherProvider } from '../src/wf1-provider.ts';
import { parseNativeUsage,usageParseCode } from '../src/wf1-usage-diagnostic.ts';
import type { UsageParseCode } from '../src/wf1-usage-diagnostic.ts';
import type { ArtifactPort } from '../src/wf1-storage.ts';
import { MODELS,WF1 } from '../src/wf1-types.ts';
import type { Usage } from '../src/wf1-types.ts';
import { BUILD_FILES,workerBuildDigest } from '../src/wf1-worker.ts';
import { FORMAT_BUILD_FILES,formatBuildDigest } from '../src/wf2-format-worker.ts';
import { TEACHER_WORKER_FILES,teacherWorkerBuildDigest } from '../src/wf2-teacher-build.ts';

test('each worker build pin covers the extracted usage parser bytes',()=>{
  const parser='wf1-usage-diagnostic.ts';
  for(const [files,digest] of [[BUILD_FILES,workerBuildDigest],[FORMAT_BUILD_FILES,formatBuildDigest],[TEACHER_WORKER_FILES,teacherWorkerBuildDigest]] as const){
    const fingerprint=(mutate:boolean)=>hash(Buffer.concat(files.flatMap(name=>[Buffer.from(name+'\0'),Buffer.concat([readFileSync(new URL('../src/'+name,import.meta.url)),Buffer.from(mutate&&name===parser?'\n// synthetic changed usage parser':'')])])));
    assert.equal(digest(),fingerprint(false));assert.notEqual(digest(),fingerprint(true),'parser-only changes must invalidate the worker source pin');
  }
});

// Frozen pre-diagnostic parser from 5b9339a; test acceptance separately from classifications.
function legacyNativeUsage(value:unknown):Usage|null {
  if(value===undefined||value===null)return null;
  try{
    const u=fields(value,['prompt_tokens','completion_tokens'],['total_tokens','prompt_tokens_details','completion_tokens_details','prompt_cache_hit_tokens','prompt_cache_miss_tokens']);
    const input=integer(u.prompt_tokens),completion=integer(u.completion_tokens);
    if(u.total_tokens!==undefined&&integer(u.total_tokens)!==input+completion)stop('WF1_USAGE');let reasoning:number|null=null;
    if(u.completion_tokens_details!==undefined&&u.completion_tokens_details!==null){const d=fields(u.completion_tokens_details,[],['reasoning_tokens','accepted_prediction_tokens','rejected_prediction_tokens']);if(d.reasoning_tokens!==undefined)reasoning=integer(d.reasoning_tokens,0,completion);}
    return {input,completion,reasoning};
  }catch{return null;}
}

test('usage diagnostic preserves the frozen native parser acceptance set and ignored details',()=>{
  const values:unknown[]=[undefined,null,0,-0,-1,1,3,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,0.5,NaN,Infinity,'private marker',true,[],{},new Date()];
  for(const input of values)for(const completion of values)for(const total of [undefined,0,4,'bad']){
    const value={prompt_tokens:input,completion_tokens:completion,total_tokens:total};
    assert.deepEqual(nativeUsage(value),legacyNativeUsage(value));assert.deepEqual(parseNativeUsage(value).usage,legacyNativeUsage(value));
  }
  for(const detail of values){
    const value={prompt_tokens:1,completion_tokens:3,prompt_tokens_details:detail,prompt_cache_hit_tokens:detail,prompt_cache_miss_tokens:detail,completion_tokens_details:{accepted_prediction_tokens:detail,rejected_prediction_tokens:detail}};
    assert.deepEqual(nativeUsage(value),{input:1,completion:3,reasoning:null});assert.deepEqual(nativeUsage(value),legacyNativeUsage(value));
    for(const nested of [detail,{reasoning_tokens:detail}])assert.deepEqual(nativeUsage({...value,completion_tokens_details:nested}),legacyNativeUsage({...value,completion_tokens_details:nested}));
  }
  for(const value of [undefined,null,[],Object.create({prompt_tokens:1}),new Proxy({prompt_tokens:1,completion_tokens:3},{get(){throw Error('must not invoke');}}),Object.defineProperty({completion_tokens:3},'prompt_tokens',{get(){throw Error('must not invoke');},enumerable:true})])assert.deepEqual(nativeUsage(value),legacyNativeUsage(value));
});

const good={prompt_tokens:2,completion_tokens:4,total_tokens:6};
for(const [name,value,code] of [
  ['missing',undefined,'MISSING_OR_NULL'],['null',null,'MISSING_OR_NULL'],['valid',good,'VALID'],['array',[],'INVALID_FIELDS'],['missing field',{prompt_tokens:2},'INVALID_FIELDS'],
  ['extra field',{...good,secret:'SYNTHETIC_PRIVATE'},'INVALID_FIELDS'],['bad details',{...good,completion_tokens_details:{secret:'SYNTHETIC_PRIVATE'}},'INVALID_FIELDS'],
  ['string count',{...good,prompt_tokens:'2'},'INVALID_NUMBER'],['negative count',{...good,prompt_tokens:-1},'INVALID_NUMBER'],['fraction',{...good,completion_tokens:0.5},'INVALID_NUMBER'],
  ['negative zero',{...good,prompt_tokens:-0},'INVALID_NUMBER'],['total string',{...good,total_tokens:'6'},'INVALID_NUMBER'],['total mismatch',{...good,total_tokens:7},'TOTAL_MISMATCH'],
  ['reasoning overflow',{...good,completion_tokens_details:{reasoning_tokens:5}},'REASONING_RANGE'],['reasoning negative',{...good,completion_tokens_details:{reasoning_tokens:-1}},'REASONING_RANGE'],
  ['reasoning string',{...good,completion_tokens_details:{reasoning_tokens:'5'}},'INVALID_NUMBER'],['reasoning fraction',{...good,completion_tokens_details:{reasoning_tokens:1.5}},'INVALID_NUMBER'],
  ['reasoning zero',{...good,completion_tokens_details:{reasoning_tokens:0}},'VALID'],['reasoning full',{...good,completion_tokens_details:{reasoning_tokens:4}},'VALID'],
] as const)test('usage classification: '+name,()=>{const parsed=parseNativeUsage(value);assert.equal(parsed.usageParseCode,code);assert.deepEqual(parsed.usage,legacyNativeUsage(value));assert.ok(!JSON.stringify(parsed).includes('SYNTHETIC_PRIVATE'));});

const envelope=(usage:unknown=good)=>({model:MODELS.deepseek,id:'SYNTHETIC_PRIVATE_REQUEST_ID',usage,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'SYNTHETIC_PRIVATE_FINAL'}}]});
function port(fail?:string):ArtifactPort{return {put(kind,bytes){if(kind===fail)throw Error('SYNTHETIC_PRIVATE_PATH');return {id:'synthetic-'+kind,kind,partition:'train',bytes:Buffer.byteLength(bytes),digest:hash(bytes)};},read(){throw Error('not used');}};}
async function submit(response:()=>Response|Promise<Response>,fail?:string){return new TeacherProvider({deepseek:'synthetic-only',together:null},{fetch:async()=>response()}).submit('deepseek','{}',port(fail),new AbortController().signal);}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const cases:Array<{name:string;response:()=>Response|Promise<Response>;failure?:string;outcome:string;responseCode:string;usageCode:UsageParseCode}>=[
  {name:'valid',response:()=>json(envelope()),outcome:'COMPLETED',responseCode:'NONE',usageCode:'VALID'},
  {name:'null usage',response:()=>json(envelope(null)),outcome:'COMPLETED',responseCode:'NONE',usageCode:'MISSING_OR_NULL'},
  {name:'bad native fields',response:()=>json(envelope({...good,extra:'SYNTHETIC_PRIVATE'})),outcome:'COMPLETED',responseCode:'NONE',usageCode:'INVALID_FIELDS'},
  {name:'non-200',response:()=>json(envelope(),503),outcome:'FAILED',responseCode:'HTTP_STATUS',usageCode:'NOT_REACHED'},
  {name:'429',response:()=>json(envelope(),429),outcome:'FAILED',responseCode:'HTTP_STATUS',usageCode:'NOT_REACHED'},
  {name:'UTF-8',response:()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),outcome:'FAILED',responseCode:'UNKNOWN',usageCode:'NOT_REACHED'},
  {name:'JSON',response:()=>new Response('{',{headers:{'content-type':'application/json'}}),outcome:'FAILED',responseCode:'ENVELOPE_WF1_JSON',usageCode:'NOT_REACHED'},
  {name:'strict envelope number',response:()=>json(envelope({...good,prompt_tokens:0.5})),outcome:'FAILED',responseCode:'ENVELOPE_WF1_NUMBER',usageCode:'NOT_REACHED'},
  {name:'unknown envelope field',response:()=>json({...envelope(),secret:'SYNTHETIC_PRIVATE'}),outcome:'FAILED',responseCode:'ENVELOPE_REJECTED',usageCode:'NOT_REACHED'},
  {name:'content type',response:()=>new Response(JSON.stringify(envelope())),outcome:'FAILED',responseCode:'ENVELOPE_REJECTED',usageCode:'NOT_REACHED'},
  {name:'raw storage',response:()=>json(envelope()),failure:'provider-raw',outcome:'FAILED',responseCode:'ARTIFACT_WRITE_FAILED',usageCode:'NOT_REACHED'},
  {name:'final storage',response:()=>json(envelope()),failure:'native-final',outcome:'FAILED',responseCode:'ARTIFACT_WRITE_FAILED',usageCode:'VALID'},
  {name:'model identity',response:()=>json({...envelope(),model:'SYNTHETIC_PRIVATE_MODEL'}),outcome:'FAILED',responseCode:'MODEL_IDENTITY',usageCode:'VALID'},
  {name:'response limit',response:()=>new Response('x',{headers:{'content-length':String(WF1.responseBytes+1)}}),outcome:'FAILED',responseCode:'RESPONSE_LIMIT',usageCode:'NOT_REACHED'},
  {name:'transport unknown',response:async()=>{throw Error('SYNTHETIC_PRIVATE_TRANSPORT');},outcome:'SUBMIT_UNKNOWN',responseCode:'TRANSPORT_UNKNOWN',usageCode:'NOT_REACHED'},
];
for(const c of cases)test('TeacherProvider records diagnostic at original parsing stage: '+c.name,async()=>{const r=await submit(c.response,c.failure);assert.equal(r.outcome,c.outcome);assert.equal(r.responseFailureCode,c.responseCode);assert.equal(r.usageParseCode,c.usageCode);assert.equal(r.usage!==null,c.usageCode==='VALID');});
test('provider omitted usage is recorded without inferring tokens',async()=>{const {usage:_,...value}=envelope();const r=await submit(()=>json(value));assert.equal(r.usage,null);assert.equal(r.usageParseCode,'MISSING_OR_NULL');});
test('diagnostic projection accepts only closed codes',()=>{for(const v of ['SYNTHETIC_PRIVATE','__proto__',null,{},['VALID'],1])assert.equal(usageParseCode(v),'UNKNOWN');});
