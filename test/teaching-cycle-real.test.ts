import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical,hash } from '../src/wf1-json.ts';
import { validateCurriculumPlan,validateCycleSpec } from '../src/teaching-cycle-types.ts';
import { cycleFixture,pipelineFixture } from './teaching-cycle-fixture.ts';
import { openTeachingCycle } from '../src/teaching-cycle-store.ts';
import { runTeachingCycle,verifyTeachingCycle } from '../src/teaching-cycle-runner.ts';
import { teachingCycleReport,joinQualifiedMeasurements } from '../src/teaching-cycle-report.ts';
import { assembleCycleIndexes } from '../src/corpus-qa-index.ts';
import { installSyntheticTokenizer } from './teaching-tokenizer-fixture.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('real plans require an explicit version and cannot relabel a synthetic cycle',()=>{
  const f=cycleFixture();try{
    const plan={...f.plan,qualification:'REAL_MENTOR_PLAN'};
    assert.throws(()=>validateCurriculumPlan(plan,{...f.spec,planDigest:hash(canonical(plan))}));
    assert.doesNotThrow(()=>validateCycleSpec({...f.spec,version:'TeachingCycle/0.2',profileDigest:hash(canonical({version:'TeachingCycle/0.2',plan:'REAL_MENTOR_PLAN',childPolicy:'EXPLICIT_V2',index:'FULL_QA_DISPOSITIONS',money:'ACCOUNTING_ONLY',replay:'NEVER',localReclaim:'TRUSTED_EXACT_OWNER_EXIT',remoteUnknown:'RETAINED',clock:'PERSISTED_EVENT_OBSERVATIONS',accounting:'VERIFIED_CHILD_DERIVATION',report:'FINAL_FULL_INDEX_JOIN'}))}));
  }finally{f.store.close();}
});

test('real admission is required before replay and inspection has separate current rights',()=>{
  const f=cycleFixture(undefined,{},true);f.store.initialize(f.plan);f.store.close();
  const {realPlanAdmission:_,...options}=f.options;
  for(const check of [undefined,async()=>{},()=>true,()=>({then(){throw Error('not called');}})])assert.throws(()=>openTeachingCycle({...options,mode:'inspect',...(check?{realPlanAdmission:check as ()=>void}:{})}),{code:'TC_REAL_ADMISSION'});
  const active:boolean[]=[];const reader=openTeachingCycle({...f.options,mode:'inspect',realPlanAdmission:context=>{active.push(context.active);if(context.active)throw Error('execution permission revoked');}});
  try{assert.equal(reader.snapshot()!.plan.qualification,'REAL_MENTOR_PLAN');assert.ok(active.length>1);assert.ok(active.every(v=>v===false));}finally{reader.close();}
});

test('two distinct receipts and effort evidence are declarations checked against the approved host configuration',()=>{
  const f=cycleFixture(undefined,{},true);try{
    assert.equal(validateCurriculumPlan(f.plan,f.spec).qualification,'REAL_MENTOR_PLAN');if(f.plan.version!=='TeachingCurriculumPlan/0.2')throw Error('fixture');
    for(const change of [(p:typeof f.plan)=>{if(p.version==='TeachingCurriculumPlan/0.2')p.mentors.pop();},(p:typeof f.plan)=>{if(p.version==='TeachingCurriculumPlan/0.2')p.mentors[1]!.model=p.mentors[0]!.model;},(p:typeof f.plan)=>{if(p.version==='TeachingCurriculumPlan/0.2')p.mentors[0]!.effortEvidence='PROVIDER_ECHO';}]){const plan=structuredClone(f.plan);change(plan);assert.throws(()=>validateCurriculumPlan(plan,{...f.spec,planDigest:hash(canonical(plan))}));}
    const another=structuredClone(f.plan);another.mentors[1]!.model='provider/example-model';another.mentors[1]!.requestedEffort='high';assert.doesNotThrow(()=>validateCurriculumPlan(another,{...f.spec,planDigest:hash(canonical(another))}));
    another.mentors[1]!.effectiveEffort='high';another.mentors[1]!.effortEvidence='PROVIDER_ECHO';assert.doesNotThrow(()=>validateCurriculumPlan(another,{...f.spec,planDigest:hash(canonical(another))}));
    another.mentors[1]!.effectiveEffort='max';assert.throws(()=>validateCurriculumPlan(another,{...f.spec,planDigest:hash(canonical(another))}),{code:'TC_MENTOR'});
    f.store.initialize(f.plan);f.revokeSource();assert.throws(()=>f.store.snapshot(),{code:'SYNTHETIC_REAL_ADMISSION_DENIED'});
  }finally{f.store.close();}
});

test('v2 event clock refuses cross-process rollback and start is immutable on resume',()=>{
  const f=cycleFixture(undefined,{},true);f.store.initialize(f.plan);f.store.apply('START',{});const before=f.store.snapshot()!;f.store.close();
  assert.throws(()=>openTeachingCycle({...f.options,mode:'resume',now:()=>before.timing!.lastObservedAt-1}),{code:'TC_CLOCK'});
  const resumed=openTeachingCycle({...f.options,mode:'resume'});try{assert.deepEqual(resumed.snapshot()!.timing,before.timing);assert.throws(()=>resumed.apply('START',{}),{code:'TC_START'});}finally{resumed.close();}
});

test('incomplete cycles do not publish provisional qualified train yield',()=>{
  const f=cycleFixture(undefined,{},true);try{f.store.initialize(f.plan);const report=teachingCycleReport(f.store,()=>{throw Error('no index expected');},()=>{});assert.equal(report.status,'INCOMPLETE');assert.equal(report.qualified,null);assert.equal(report.timing.qualifiedTrainLossTokensPerMinute,null);assert.equal(report.publication,'INDEPENDENT_COLD_REQUIRED');}finally{f.store.close();}
});

test('real-profile synthetic cycle counts only full-index eligible train and cold process matches all commitments',async()=>{
  const f=pipelineFixture(undefined,undefined,{},true),restore=installSyntheticTokenizer();try{
    const summary=await runTeachingCycle(f.ports);assert.equal(summary.status,'COMPLETE',JSON.stringify(summary));assert.equal(f.distinctChildPeak,2);
    const report=teachingCycleReport(f.store,f.ports.openIndex,f.ports.checkChildMetadata);assert.equal(report.status,'COMPLETE_INDEX_CANDIDATE');assert.deepEqual(report.qualified!.train,{rows:8,studentInputTokens:24,studentLossTokens:40,fullTokens:64});assert.deepEqual(report.qualified!.dev,report.qualified!.train);assert.equal(report.qualified!.allSelected.rows,32);assert.equal(report.qualified!.excluded.crossSplitFamilyHoldRows,16);assert.equal(report.qualified!.excluded.qaRejected,1);assert.equal(report.usage.total.total,32);assert.equal(report.usage.total.reported,10);assert.equal(report.usage.total.unreported,22);assert.equal(report.usage.total.inputTokens,null);assert.ok(report.usage.total.knownInputTokens>0);assert.equal(report.timing.boundary,'CYCLE_START_TO_FINAL_INDEX_BARRIER');assert.ok(report.timing.elapsedMs!>0);assert.equal(report.trainingReady,false);
    const v=verifyTeachingCycle(f.store,f.ports.openIndex,f.ports.checkChildMetadata),assembly=assembleCycleIndexes(v.indexes,v.digests,{maxInputs:512,maxRows:100000,maxBytes:100000000}),selections=v.selections.map(s=>s.selection);
    assert.throws(()=>joinQualifiedMeasurements(assembly,selections.slice(1)),{code:'TC_REPORT_JOIN'});assert.throws(()=>joinQualifiedMeasurements(assembly,[...selections,selections[0]!]),{code:'TC_REPORT_JOIN'});const swapped=structuredClone(assembly);swapped.rows[0]!.rowDigest=hash('different row');assert.throws(()=>joinQualifiedMeasurements(swapped,selections),{code:'TC_REPORT_JOIN'});
    const mixed=structuredClone(selections);mixed[1]!.source.tokenizerProfileDigest=hash('SYNTHETIC different token units');for(const e of mixed[1]!.entries)e.measurement.tokenizerProfileDigest=mixed[1]!.source.tokenizerProfileDigest;assert.throws(()=>joinQualifiedMeasurements(assembly,mixed),{code:'TC_REPORT_TOKENIZER'});
    assert.equal(report.qualified!.tokenizerProfileDigest,selections[0]!.source.tokenizerProfileDigest);
    for(const kind of ['metadata','archive'] as const){
      const metadata=f.metadataGrants.get('child-0')!,archive=f.archives.get('child-0')!.admission().grant;let revoked=false;const readers:ReturnType<typeof f.ports.openIndex>[]=[];
      try{assert.throws(()=>teachingCycleReport(f.store,(child,descriptor)=>{const reader=f.ports.openIndex(child,descriptor);readers.push(reader);if(child.childId==='child-1'){(kind==='metadata'?metadata:archive).readAllowed=false;revoked=true;}return reader;},f.ports.checkChildMetadata),{code:kind==='metadata'?'TC_CHILD_METADATA_REVOKED':'CQA_ARCHIVE_ADMISSION'});assert.equal(revoked,true);for(const reader of readers)assert.throws(()=>reader.check(),{code:'CQA_ARCHIVE_CLOSED'});}
      finally{metadata.readAllowed=true;archive.readAllowed=true;}
    }
    const sends=f.sends;await runTeachingCycle(f.ports);assert.equal(f.sends,sends);const file=f.persist();f.store.close();
    const cold=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/teaching-cycle-real-worker.mjs',import.meta.url)),'verify',file],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(cold.status,0,cold.stderr);assert.deepEqual(JSON.parse(cold.stdout),report);
  }finally{restore();f.store.close();}
});

for(const window of ['audit-created','archive-created'] as const)test('v2 resumes fixed '+window+' custody without resetting timing or replaying',async()=>{
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/teaching-cycle-real-worker.mjs',import.meta.url)),'crash',window],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(child.status,17,child.stderr);const f=pipelineFixture(undefined,child.stdout.trim(),{},true),restore=installSyntheticTokenizer();
  try{const before=f.store.snapshot()!,ids=before.leases.map(l=>l.request.jobId+':'+l.request.attemptId),start=before.timing!.startedAt;assert.equal((await runTeachingCycle(f.ports)).status,'COMPLETE');const after=f.store.snapshot()!;assert.equal(after.timing!.startedAt,start);for(const id of ids)assert.equal(after.leases.filter(l=>l.request.jobId+':'+l.request.attemptId===id).length,1);assert.equal(f.sends,window==='audit-created'?27:24);assert.equal(teachingCycleReport(f.store,f.ports.openIndex,f.ports.checkChildMetadata).qualified!.train.rows,8);}finally{restore();f.store.close();}
});
