import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonical,hash } from '../src/wf1-json.ts';
import { MODELS } from '../src/wf1-types.ts';
import type { ArtifactRef,ProviderResult } from '../src/wf1-types.ts';
import { accountingSum,corpusResponseDisposition } from '../src/corpus-response-policy.ts';
import { nativeProduction,nativeQa } from './corpus-policy-v2-fixture.ts';
import { productionBody,FACTORY_BASELINE,FACTORY_BASELINE_DIGEST } from '../src/corpus-production-types.ts';
import { auditBody,QA_TARGET_BASELINE,QA_TARGET_BASELINE_DIGEST } from '../src/corpus-qa-types.ts';

function response(){
  const blobs=new Map<string,Buffer>(),put=(kind:string,body:string):ArtifactRef=>{const ref={id:randomUUID(),kind,partition:'train' as const,bytes:Buffer.byteLength(body),digest:hash(body)};blobs.set(ref.id,Buffer.from(body));return ref;};
  const envelope:any={model:MODELS.deepseek,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"synthetic":true}'}}]},finalRef=put('native-final',envelope.choices[0].message.content);
  const result:ProviderResult={outcome:'COMPLETED',httpStatus:200,requestedModel:MODELS.deepseek,returnedModel:MODELS.deepseek,requestId:null,transportLane:'SYNTHETIC_FIXTURE',failure:null,finishReason:'stop',reasoningPresent:false,contentPresent:true,usage:null,usageParseCode:'MISSING_OR_NULL',responseFailureCode:'NONE',rawRef:put('provider-raw',canonical(envelope)),reasoningRef:null,finalRef,elapsedMs:1};
  const port={read:(ref:ArtifactRef)=>{assert.ok(blobs.has(ref.id),'same attempt port');return blobs.get(ref.id)!;}};
  return {result,envelope,put,port,refresh:()=>{result.rawRef=put('provider-raw',canonical(envelope));}};
}
test('only actual raw absent/null usage with exact native-final binding qualifies',()=>{
  for(const mode of ['absent','null'] as const){const f=response();if(mode==='null')f.envelope.usage=null;f.refresh();assert.deepEqual(corpusResponseDisposition(f.result,'deepseek',f.port),{kind:'CONTENT',usageStatus:'UNREPORTED'});}
  const f=response();f.result.usage={input:100,completion:80,reasoning:20};f.result.usageParseCode='VALID';assert.deepEqual(corpusResponseDisposition(f.result,'deepseek',f.port),{kind:'CONTENT',usageStatus:'PROVIDER_REPORTED'});
});
test('fake missing labels, malformed native usage and absent legacy diagnosis never exempt',()=>{
  for(const value of [{prompt_tokens:1,completion_tokens:2,total_tokens:3},{},{prompt_tokens:-1},false,'secret arbitrary payload']){const f=response();f.envelope.usage=value;f.refresh();assert.equal(corpusResponseDisposition(f.result,'deepseek',f.port).kind,'ISOLATE');}
  for(const code of ['NOT_REACHED','VALID','INVALID_FIELDS','INVALID_NUMBER','TOTAL_MISMATCH','REASONING_RANGE','UNKNOWN',undefined] as const){const f=response();if(code===undefined)delete f.result.usageParseCode;else f.result.usageParseCode=code;assert.equal(corpusResponseDisposition(f.result,'deepseek',f.port).kind,'ISOLATE');}
});
test('known integrity failures outrank unknown submission, and filled usage cannot erase bad diagnosis',()=>{
  for(const code of ['ARTIFACT_WRITE_FAILED','MODEL_IDENTITY'] as const){const f=response();f.result.outcome='SUBMIT_UNKNOWN';f.result.responseFailureCode=code;assert.equal(corpusResponseDisposition(f.result,'deepseek',f.port).kind,'FENCE');}
  const u=response();u.result.outcome='SUBMIT_UNKNOWN';u.result.returnedModel=null;assert.equal(corpusResponseDisposition(u.result,'deepseek',u.port).kind,'ISOLATE');
  for(const code of ['MISSING_OR_NULL','INVALID_FIELDS','INVALID_NUMBER','TOTAL_MISMATCH','REASONING_RANGE','UNKNOWN'] as const){const f=response();f.result.usage={input:100,completion:80,reasoning:20};f.result.usageParseCode=code;assert.equal(corpusResponseDisposition(f.result,'deepseek',f.port).kind,'ISOLATE');}
});
test('wrong model/raw-final binding/storage are integrity fences; HTTP/unknown remain isolated',()=>{
  const f=response();f.envelope.model='wrong';f.refresh();assert.deepEqual(corpusResponseDisposition(f.result,'deepseek',f.port),{kind:'FENCE',code:'MODEL_IDENTITY'});
  const g=response();g.result.finalRef=g.put('native-final','different');assert.deepEqual(corpusResponseDisposition(g.result,'deepseek',g.port),{kind:'FENCE',code:'ARTIFACT_INTEGRITY'});
  const h=response();assert.throws(()=>corpusResponseDisposition(h.result,'deepseek',{read:()=>{throw Error('synthetic storage loss');}}),/storage loss/);
  for(const status of [400,503]){const v=response();v.result.httpStatus=status;assert.equal(corpusResponseDisposition(v.result,'deepseek',v.port).kind,'ISOLATE');}
  const u=response();u.result.outcome='SUBMIT_UNKNOWN';assert.deepEqual(corpusResponseDisposition(u.result,'deepseek',u.port),{kind:'ISOLATE',code:'SUBMIT_UNKNOWN'});
  const r=response();r.result.httpStatus=429;assert.equal(corpusResponseDisposition(r.result,'deepseek',r.port).kind,'RATE_LIMIT');
});
test('unknown accounting stays null and safe-integer overflow is a technical rejection',()=>{
  assert.equal(accountingSum([null,10]),null);assert.equal(accountingSum([10,20]),30);assert.equal(accountingSum([]),0);assert.throws(()=>accountingSum([Number.MAX_SAFE_INTEGER,1]));assert.throws(()=>accountingSum([null,-1]));
});
test('raw missing proof rejects refusal even when forged outcome and business JSON claim completion',()=>{const f=response();f.envelope.choices[0].message.refusal='SYNTHETIC refusal';f.refresh();assert.deepEqual(corpusResponseDisposition(f.result,'deepseek',f.port),{kind:'ISOLATE',code:'OUTPUT_INVALID'});});
for(const kind of ['production','qa'] as const)for(const old of [false,true])for(const usage of ['known','missing'] as const)test(kind+' '+(old?'v1':'v2')+' '+usage+' native refusal preserves the version boundary',async()=>{
  const f=response(),output={...f.port,put:(kind:string,bytes:string|Uint8Array)=>f.put(kind,typeof bytes==='string'?bytes:Buffer.from(bytes).toString('utf8'))},options={usage,change:(r:any)=>{r.envelope.choices[0].message.refusal='SYNTHETIC refusal';}},signal=new AbortController().signal,authorizeSend=<T>(send:()=>T)=>send();
  const result=kind==='production'?await nativeProduction(options).transport({version:old?'CorpusProduction/0.1':'CorpusProduction/0.2',operation:'plan',index:0,body:productionBody('plan',0,{factoryBaseline:FACTORY_BASELINE,factoryBaselineDigest:FACTORY_BASELINE_DIGEST,currentApprovedObjective:'SYNTHETIC',slots:[{ordinal:0,unitId:'synthetic',poolId:'pool',capability:'science'}]},old?'CorpusProduction/0.1':'CorpusProduction/0.2'),output,signal,authorizeSend}):await nativeQa(options).transport({version:old?'CorpusQualityAudit/0.1':'CorpusQualityAudit/0.2',operation:'rubric',index:0,body:auditBody('rubric',0,{factoryBaseline:FACTORY_BASELINE,baselineDigest:FACTORY_BASELINE_DIGEST,auditTargetBaseline:QA_TARGET_BASELINE,auditTargetBaselineDigest:QA_TARGET_BASELINE_DIGEST,currentApprovedObjective:'SYNTHETIC'},old?'CorpusQualityAudit/0.1':'CorpusQualityAudit/0.2'),output,signal,authorizeSend});
  assert.equal(result.outcome,old?'COMPLETED':'INCOMPLETE_OUTPUT');assert.equal(result.responseFailureCode,old?'NONE':'INCOMPLETE_FINAL');assert.equal(result.usageParseCode,usage==='known'?'VALID':'MISSING_OR_NULL');
});
