import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical,hash } from '../src/wf1-json.ts';
import { MODELS } from '../src/wf1-types.ts';
import { productionResponseDiagnostics } from '../src/corpus-production-diagnostic.ts';
import { createProductionTransport,productionSummary,runCorpusProduction,verifyProduction } from '../src/corpus-production-runner.ts';
import { openProductionJob } from '../src/corpus-production-store.ts';
import type { Attempt } from '../src/corpus-production-types.ts';
import { fixture,mock } from './corpus-production-fixture.ts';
import { validateSelection } from '../src/corpus-harvest.ts';
import { corpusFixture } from './fixtures/corpus-fixture.ts';

test('CP0 strict selection reader accepts new and absent usage diagnostics without rewriting either',async()=>{
  const f=await corpusFixture();try{
    const current=structuredClone(f.selection);assert.equal(current.generation.result!.usageParseCode,'VALID');assert.equal(current.review.result!.usageParseCode,'VALID');
    const legacy=structuredClone(current);delete legacy.generation.result!.usageParseCode;delete legacy.review.result!.usageParseCode;
    for(const selection of [current,legacy]){const before=canonical(selection);assert.equal(canonical(validateSelection(selection)),before);assert.equal(canonical(selection),before);}
    const malicious=structuredClone(current);Object.assign(malicious.generation.result!,{usageParseCode:'SYNTHETIC_PRIVATE'});assert.throws(()=>validateSelection(malicious),{code:'WF1_ENUM'});
  }finally{f.close();}
});

test('diagnostic groups count each attempt once, coalesce equal tuples and have deterministic order',()=>{
  const result={httpStatus:200,outcome:'COMPLETED',responseFailureCode:'NONE',usageParseCode:'VALID'};
  const rows=[{operation:'plan',result},{operation:'candidate',result},{operation:'candidate',result},{operation:'review',result:null},{operation:'review',result:{httpStatus:429,outcome:'FAILED',responseFailureCode:'HTTP_STATUS',usageParseCode:'NOT_REACHED'}}] as Attempt[];
  const before=canonical(rows),groups=productionResponseDiagnostics(rows);
  assert.equal(groups.length,4);assert.equal(groups.reduce((n,g)=>n+g.count,0),rows.length);assert.equal(groups.find(g=>g.operation==='candidate')!.count,2);
  assert.deepEqual(groups,productionResponseDiagnostics([...rows].reverse()));assert.equal(canonical(rows),before);
  assert.deepEqual(groups.find(g=>g.outcome==='NO_RESULT'),{operation:'review',httpStatus:null,outcome:'NO_RESULT',responseFailureCode:'NOT_RECORDED',usageParseCode:'NOT_RECORDED',count:1});
});

test('malicious arbitrary response fields cannot become diagnostic labels or keys',()=>{
  const secret='SYNTHETIC_PRIVATE_PROMPT_REQUEST_PATH';
  const rows=[{operation:secret,result:{outcome:secret,httpStatus:secret,responseFailureCode:secret,usageParseCode:secret,prompt:secret,requestId:secret,rawRef:{path:secret}}},
    ...[0,99,600,1.5,NaN,Infinity,{},[],null].map(httpStatus=>({operation:'candidate',result:{httpStatus,outcome:'FAILED',responseFailureCode:'__proto__',usageParseCode:'constructor'}})),
    {operation:'review',result:{httpStatus:200,outcome:'COMPLETED'}}] as unknown as Attempt[];
  const groups=productionResponseDiagnostics(rows),text=canonical(groups);
  assert.ok(!text.includes(secret));assert.ok(!text.includes('__proto__'));assert.ok(!text.includes('constructor'));assert.equal(groups.reduce((n,g)=>n+g.count,0),rows.length);
  for(const g of groups)assert.deepEqual(Object.keys(g),['operation','httpStatus','outcome','responseFailureCode','usageParseCode','count']);
  assert.deepEqual(groups.find(g=>g.operation==='UNKNOWN'),{operation:'UNKNOWN',httpStatus:null,outcome:'UNKNOWN',responseFailureCode:'UNKNOWN',usageParseCode:'UNKNOWN',count:1});
  assert.equal(groups.find(g=>g.operation==='review')!.usageParseCode,'NOT_RECORDED');
});

for(const legacy of [true,false])test((legacy?'legacy':'new')+' results cold reopen without canonical/hash backfill; fresh-process summary agrees',async()=>{
  const f=fixture(4),m=mock(f);
  try{
    const summary=await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:async r=>{const result=await m.transport(r);return legacy?result:{...result,responseFailureCode:'NONE',usageParseCode:'VALID'};}});
    assert.equal(summary.status,'COMPLETED');const state=verifyProduction(f.store),stateDigest=hash(canonical(state)),beforeResult=state.attempts.map(a=>canonical(a.result));
    assert.equal(summary.responseDiagnostics.reduce((n,g)=>n+g.count,0),summary.calls.total);
    assert.ok(summary.responseDiagnostics.every(g=>g.usageParseCode===(legacy?'NOT_RECORDED':'VALID')));
    assert.equal(summary.calls.usageUnknown,0);const sends=m.sends;
    f.store.close();const dbPath=join(f.options.runtimeRoot,'corpus-production.sqlite'),dbBefore=hash(readFileSync(dbPath)),authorityBefore=hash(readFileSync(f.options.authorityPath));
    const cold=openProductionJob({...f.options,mode:'inspect'});
    try{const reopened=verifyProduction(cold);assert.equal(hash(canonical(reopened)),stateDigest);assert.deepEqual(reopened.attempts.map(a=>canonical(a.result)),beforeResult);assert.equal(canonical(productionSummary(reopened,f.registry)),canonical(summary));}finally{cold.close();}
    const modules={store:new URL('../src/corpus-production-store.ts',import.meta.url).href,runner:new URL('../src/corpus-production-runner.ts',import.meta.url).href,json:new URL('../src/wf1-json.ts',import.meta.url).href};
    const options={approvedTrainingRoot:f.options.approvedTrainingRoot,runtimeRoot:f.options.runtimeRoot,authorityPath:f.options.authorityPath,spec:f.spec,mode:'inspect'};
    const source=`import {openProductionJob} from ${JSON.stringify(modules.store)};import {productionSummary,verifyProduction} from ${JSON.stringify(modules.runner)};import {hash,canonical} from ${JSON.stringify(modules.json)};const spec=${canonical(f.spec)},registry=${canonical(f.registry)},purposes=${canonical(f.purposes)};const store=openProductionJob({...${canonical(options)},key:Buffer.alloc(32,73),admission:()=>({registryDigest:spec.registryDigest,sourceAllowed:true,retainAllowed:true,purposes})});try{const state=verifyProduction(store);process.stdout.write(JSON.stringify({digest:hash(canonical(state)),summary:productionSummary(state,registry)}));}finally{store.close();}`;
    const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:20000,maxBuffer:65536,windowsHide:true});
    assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),JSON.parse(canonical({digest:stateDigest,summary})));
    assert.equal(hash(readFileSync(dbPath)),dbBefore);assert.equal(hash(readFileSync(f.options.authorityPath)),authorityBefore);assert.equal(m.sends,sends);
  }finally{f.store.close();}
});

const validEnvelope=(usage:unknown)=>({id:'SYNTHETIC_PRIVATE_REQUEST',model:MODELS.deepseek,usage,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"version":"CorpusProductionResponse/0.1","items":[]}'}}]});
const validUsage={prompt_tokens:2,completion_tokens:4,total_tokens:6};
const jsonResponse=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...(status===429?{'retry-after':'0'}:{})}});
for(const [name,response,code,responseCode,httpStatus,outcome] of [
  ['missing',()=>jsonResponse(validEnvelope(null)),'MISSING_OR_NULL','NONE',200,'COMPLETED'],
  ['fields',()=>jsonResponse(validEnvelope({...validUsage,private:'SYNTHETIC_PRIVATE'})),'INVALID_FIELDS','NONE',200,'COMPLETED'],
  ['number',()=>jsonResponse(validEnvelope({...validUsage,prompt_tokens:'2'})),'INVALID_NUMBER','NONE',200,'COMPLETED'],
  ['total',()=>jsonResponse(validEnvelope({...validUsage,total_tokens:7})),'TOTAL_MISMATCH','NONE',200,'COMPLETED'],
  ['reasoning',()=>jsonResponse(validEnvelope({...validUsage,completion_tokens_details:{reasoning_tokens:5}})),'REASONING_RANGE','NONE',200,'COMPLETED'],
  ['envelope',()=>jsonResponse({...validEnvelope(validUsage),private:'SYNTHETIC_PRIVATE'}),'NOT_REACHED','ENVELOPE_REJECTED',200,'FAILED'],
  ['http',()=>jsonResponse(validEnvelope(validUsage),503),'NOT_REACHED','HTTP_STATUS',503,'FAILED'],
  ['429',()=>jsonResponse(validEnvelope(validUsage),429),'NOT_REACHED','HTTP_STATUS',429,'FAILED'],
  ['transport',async()=>{throw Error('SYNTHETIC_PRIVATE');},'NOT_REACHED','TRANSPORT_UNKNOWN',null,'SUBMIT_UNKNOWN'],
] as const)test('production persists native '+name+' diagnosis before existing fence, never resends',async()=>{
  const f=fixture(4);let sends=0;
  const transport=createProductionTransport({deepseek:'synthetic-only'},{fetch:async()=>{sends++;return response();}});
  try{
    const summary=await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport});
    assert.equal(summary.calls.total,1);assert.equal(summary.calls.usageUnknown,1);assert.equal(summary.status,name==='429'?'COMPLETED':'FENCED');
    assert.deepEqual(summary.responseDiagnostics,[{operation:'plan',httpStatus,outcome,responseFailureCode:responseCode,usageParseCode:code,count:1}]);
    if(name!=='429')assert.ok(summary.failureCodes[name==='transport'?'CPR_SUBMIT_UNKNOWN':'CPR_USAGE_UNKNOWN']);
    assert.ok(!canonical(summary).includes('SYNTHETIC_PRIVATE'));assert.equal(summary.calls.submitUnknown,name==='transport'?1:0);
    const state=f.store.snapshot()!;assert.equal(state.attempts[0]!.result!.usageParseCode,code);f.store.close();
    const cold=openProductionJob({...f.options,mode:'resume'});try{const again=await runCorpusProduction(f.spec,{store:cold,objective:f.objective,registry:f.registry,transport});assert.equal(sends,1);assert.deepEqual(again.responseDiagnostics,summary.responseDiagnostics);}finally{cold.close();}
  }finally{f.store.close();}
});

test('review usage failure is separately counted while prior valid attempts remain known',async()=>{
  const f=fixture(4),m=mock(f),native=createProductionTransport({deepseek:'synthetic-only'},{fetch:async()=>jsonResponse(validEnvelope({...validUsage,total_tokens:7}))});let reviewSends=0;
  try{const summary=await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:async r=>{if(r.operation==='review'){reviewSends++;return native(r);}return {...await m.transport(r),responseFailureCode:'NONE',usageParseCode:'VALID'};}});
    assert.equal(summary.status,'FENCED');assert.equal(summary.calls.usageUnknown,1);assert.equal(summary.calls.total,3);assert.equal(reviewSends,1);
    assert.deepEqual(summary.responseDiagnostics.find(g=>g.operation==='review'),{operation:'review',httpStatus:200,outcome:'COMPLETED',responseFailureCode:'NONE',usageParseCode:'TOTAL_MISMATCH',count:1});
    assert.equal(summary.responseDiagnostics.reduce((n,g)=>n+g.count,0),summary.calls.total);assert.equal(summary.lanes.find(l=>l.operation==='review')!.usageUnknown,1);
  }finally{f.store.close();}
});

test('non-submission unknown and unsettled attempts do not claim a provider response',async()=>{
  const f=fixture(4);try{let invocations=0;const summary=await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:async()=>{invocations++;throw Error('SYNTHETIC_PRIVATE_PRE_SEND');}});
    assert.equal(invocations,1);assert.equal(summary.calls.submitUnknown,1);assert.equal(summary.calls.usageUnknown,1);assert.deepEqual(summary.responseDiagnostics,[{operation:'plan',httpStatus:null,outcome:'NO_RESULT',responseFailureCode:'NOT_RECORDED',usageParseCode:'NOT_RECORDED',count:1}]);
    const snapshot=f.store.snapshot()!,before=canonical(snapshot);snapshot.attempts[0]!.serviceMs=null;assert.deepEqual(productionSummary(snapshot,f.registry).responseDiagnostics,summary.responseDiagnostics);assert.equal(canonical(f.store.snapshot()),before);
  }finally{f.store.close();}
});

test('new diagnostic survives SETTLE-to-FINISH crash and keeps original restart fence',async()=>{
  const f=fixture(4),m=mock(f),apply=f.store.apply.bind(f.store);let crashed=false;
  f.store.apply=(kind,data)=>{if(crashed)throw Error('synthetic stopped writer');apply(kind,data);if(kind==='SETTLE'){crashed=true;throw Error('synthetic crash after settle');}};
  try{await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:async r=>({...await m.transport(r),usage:null,usageParseCode:'TOTAL_MISMATCH',responseFailureCode:'NONE'})});
    const saved=f.store.snapshot()!;assert.equal(saved.status,'ACTIVE');assert.equal(saved.attempts[0]!.result!.usageParseCode,'TOTAL_MISMATCH');const diagnostics=productionResponseDiagnostics(saved.attempts);f.store.close();
    const resumed=openProductionJob({...f.options,mode:'resume'});let sends=0;
    try{const summary=await runCorpusProduction(f.spec,{store:resumed,objective:f.objective,registry:f.registry,transport:async()=>{sends++;throw Error('must never send');}});assert.equal(summary.status,'FENCED');assert.ok(summary.failureCodes.CPR_USAGE_UNKNOWN);assert.equal(sends,0);assert.deepEqual(summary.responseDiagnostics,diagnostics);}finally{resumed.close();}
  }finally{f.store.close();}
});
