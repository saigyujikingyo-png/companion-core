import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hash,stop } from '../src/wf1-json.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { fixture } from './corpus-production-fixture.ts';
import { qaFixture } from './corpus-qa-fixture.ts';
import { nativeProduction,nativeQa } from './corpus-policy-v2-fixture.ts';
import { runCorpusProduction,verifyProduction } from '../src/corpus-production-runner.ts';
import { openProductionJob } from '../src/corpus-production-store.ts';
import { runQualityAudit,verifyQualityAudit,exportQualityAudit } from '../src/corpus-qa-runner.ts';
import { openQualityAudit } from '../src/corpus-qa-store.ts';

test('v2 spend above the old 10 USD ceiling is accounting, while duplicate planned-stage consumption is refused',async()=>{
  const f=fixture(8,undefined,true);f.store.close();const runtimeRoot=join(f.options.approvedTrainingRoot,'high-price-v2');mkdirSync(runtimeRoot);const spec={...f.spec,price:{snapshotId:'synthetic-high-price',inputMicroUsdPerMillion:1000000000,completionMicroUsdPerMillion:1000000000},storageBindingDigest:bindTrainingRoot(f.options.approvedTrainingRoot,runtimeRoot).storageBindingDigest},store=openProductionJob({...f.options,runtimeRoot,spec,mode:'create'}),native=nativeProduction({usage:'known',change:r=>{r.envelope.usage={prompt_tokens:60000,completion_tokens:15000,total_tokens:75000};}});let duplicateChecked=false;
  try{const s=await runCorpusProduction(spec,{store,objective:f.objective,registry:f.registry,transport:async r=>{if(r.operation==='candidate'&&!duplicateChecked){duplicateChecked=true;const a=store.snapshot()!.attempts.at(-1)!;assert.throws(()=>store.apply('CONSUME',{...a,id:'different-id-same-stage-items'}),{code:'CPR_ONCE'});}return native.transport(r);}});assert.equal(s.status,'COMPLETED',JSON.stringify(s));assert.equal(s.counts.uniqueEligible,8);assert.ok(s.cost.reservedWorstCaseMicroUsd!>10000000);assert.ok(s.cost.estimatedUsageMicroUsd!>10000000);assert.equal(s.calls.total,5);assert.ok(duplicateChecked);verifyProduction(store);}finally{store.close();}
});
for(const window of ['before-settle','after-settle'] as const)test('QA v2 '+window+' recovery never resends a consumed review and keeps local recovery distinct',async()=>{
  const f=await qaFixture(8,undefined,false,hash('qa recovery synthetic'),true),native=nativeQa(),apply=f.store.apply.bind(f.store);let crashed=false;
  f.store.apply=(kind,data)=>{if(crashed)throw Error('SYNTHETIC crashed owner');const review=kind==='SETTLE'&&String((data as any).id).startsWith('review:');if(review&&window==='before-settle'){crashed=true;throw Error('SYNTHETIC crash before SETTLE');}apply(kind,data);if(review){crashed=true;throw Error('SYNTHETIC crash after SETTLE');}};
  try{await runQualityAudit(f.spec,{store:f.store,source:f.source,selection:f.selection,objective:f.objective,transport:native.transport});const original=f.store.snapshot()!.attempts.find(a=>a.operation==='review')!;assert.equal(f.store.snapshot()!.status,'ACTIVE');if(window==='before-settle')assert.equal(original.settledAtMs,null);else assert.notEqual(original.settledAtMs,null);f.store.close();
    const store=openQualityAudit({...f.storeOptions,mode:'resume'}),next=nativeQa();try{const s=await runQualityAudit(f.spec,{store,source:f.source,selection:f.selection,objective:f.objective,transport:next.transport});assert.equal(s.status,'COMPLETED',JSON.stringify(s));assert.equal(s.counts.PASS,window==='before-settle'?4:8);assert.equal(s.counts.HOLD,window==='before-settle'?4:0);assert.ok(next.calls.every(c=>c.operation!=='review'||c.index!==0));const recovered=store.snapshot()!.attempts.find(a=>a.id===original.id)!;if(window==='before-settle'){assert.equal(recovered.settlementSource,'RECOVERY_UNKNOWN');assert.equal(recovered.serviceMs,null);assert.equal(s.timing.serviceMs,null);assert.equal(recovered.result,null);}else{assert.equal(recovered.settlementSource,undefined);assert.deepEqual(recovered.result,original.result);}assert.throws(()=>store.apply('SETTLE',{id:original.id,result:original.result,serviceMs:1,settledAtMs:recovered.settledAtMs}),{code:'CQA_CAS'});verifyQualityAudit(store,f.source);exportQualityAudit(store,f.source);}finally{store.close();}
  }finally{f.store.close();f.source.close();}
});
test('QA v2 malformed rubric isolates dependent rows with fixed safe categories and never retries on cold inspect',async()=>{
  const valid={version:'CorpusQualityRubric/0.1',instructions:'SYNTHETIC policy',criteria:[{id:'c',criterion:'SYNTHETIC criterion'}]},cases=[
    {code:'CQA_RUBRIC_COUNT',body:{...valid,criteria:Array.from({length:13},(_,i)=>({id:'c'+i,criterion:'SYNTHETIC criterion'}))}},
    {code:'CQA_RUBRIC_TEXT',body:{...valid,criteria:[{id:'c',criterion:'界'.repeat(171)}]}},
    {code:'CQA_RUBRIC_ID',body:{...valid,criteria:[{id:'bad id',criterion:'SYNTHETIC criterion'}]}},
    {code:'CQA_RUBRIC_DUPLICATE_ID',body:{...valid,criteria:[...valid.criteria,...valid.criteria]}},
    {code:'CQA_RUBRIC_FIELDS',body:{wrong:'SYNTHETIC shape'}},
    {code:'CQA_RUBRIC_FORMAT',body:{...valid,version:'SYNTHETIC unknown version'}},
  ];
  for(const entry of cases){
    const f=await qaFixture(4,undefined,false,hash('qa format synthetic '+entry.code),true),m=nativeQa({change:r=>{if(r.operation==='rubric')r.body=entry.body;}});
    try{const ports={source:f.source,selection:f.selection,objective:f.objective,transport:m.transport},s=await runQualityAudit(f.spec,{store:f.store,...ports});assert.equal(s.status,'COMPLETED',entry.code);assert.equal(s.counts.HOLD,4);assert.equal(s.counts.PASS,0);assert.deepEqual(s.failureCodes,{[entry.code]:4});assert.deepEqual(m.calls,[{operation:'rubric',index:0}]);assert.equal(f.store.snapshot()!.rubricRef,null);assert.equal(exportQualityAudit(f.store,f.source).export.eligibleRows,0);f.store.close();
      const cold=openQualityAudit({...f.storeOptions,mode:'inspect'});try{verifyQualityAudit(cold,f.source);const result=await runQualityAudit(f.spec,{store:cold,...ports});assert.deepEqual(result.failureCodes,s.failureCodes);assert.equal(result.counts.HOLD,4);assert.deepEqual(m.calls,[{operation:'rubric',index:0}]);}finally{cold.close();}
    }finally{f.store.close();f.source.close();}
  }
});

test('observed request-binding faults stay global integrity failures instead of pure unknown',async()=>{const f=fixture(8,undefined,true);let calls=0;try{const s=await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:async()=>{calls++;stop('CPR_BINDING');}});assert.equal(s.status,'FENCED');assert.equal(calls,1);assert.ok(s.failureCodes.CPR_BINDING);}finally{f.store.close();}});
test('v2 source revocation stops dispatch and cannot be softened into per-output isolation',async()=>{const f=fixture(8,undefined,true),m=nativeProduction({change:r=>{if(r.operation==='candidate')f.revokeSource();}});try{const s=await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:m.transport});assert.equal(s.status,'FENCED');assert.equal(m.calls.filter(c=>c.operation==='candidate').length,1);assert.equal(m.calls.filter(c=>c.operation==='review').length,0);}finally{f.store.close();}});
test('same-process QA v2 run cannot reclaim live rubric work',async()=>{const f=await qaFixture(4,undefined,false,hash('qa same owner'),true);let release!:()=>void,entered!:()=>void;const begun=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r),m=nativeQa({change:async r=>{if(r.operation==='rubric'){entered();await held;}}}),ports={store:f.store,source:f.source,selection:f.selection,objective:f.objective,transport:m.transport};try{const running=runQualityAudit(f.spec,ports);await begun;await assert.rejects(()=>runQualityAudit(f.spec,ports),{code:'CQA_OWNER'});assert.equal(f.store.snapshot()!.attempts[0]!.settledAtMs,null);release();assert.equal((await running).status,'COMPLETED');}finally{release?.();f.store.close();f.source.close();}});
