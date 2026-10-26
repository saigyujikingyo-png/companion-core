import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthJournalService, parseGrowthArchive, renderGrowthArchive } from '../src/growth-journal.ts';
import { GROWTH_SCENARIOS } from '../src/growth-journal-synthetic.ts';
import { CurationService } from '../src/curation.ts';
import { MemoryStore } from '../src/store.ts';
import type { CurationRequest } from '../src/curation-rules.ts';
import { fixture, graph, claim, publish, code } from './retrieval-fixtures.ts';

const policy=JSON.stringify({version:1,curationVersion:'synthetic',annotationVersion:'synthetic',selectionVersion:'synthetic',cutoff:2000});
const raw=(...rows:CurationRequest['rows'])=>JSON.stringify({version:1,rows});
const row=():CurationRequest['rows'][number]=>({memoryIndex:0,rootIndex:0,variant:'original',language:'unknown',split:'train',
  annotation:{origin:'synthetic',claimKey:null,polarity:'unspecified',condition:'PRIVATE_ANNOTATION',quotation:'direct',quotationSubject:null,uncertain:false}});
function ready(t:TestContext,learning=true,expires:number|null=null) {
  const f=fixture(t),scope=learning?f.store.setLearningConsent(f.scope,true):f.scope;
  const epoch={id:scope.id,generation:scope.generation,consentRevision:scope.consentRevision};
  const root=f.store.acceptEvent(epoch,{source:'synthetic',eventKey:'journal-root',evidence:{speakerId:'alice',speakerRole:'subject',
    mode:'self_report',selectedText:'PRIVATE_SOURCE_BODY',occurredAt:1000}});
  const memory=publish(f.store,epoch,[root],{...claim,statement:'PRIVATE_MEMORY_BODY',validTo:expires}),service=new GrowthJournalService(f.store,policy);
  const journal=service.bind({epoch,publishedRefs:[memory]}),view=service.bindView(journal,{epoch});
  return {...f,scope,epoch,root,memory,service,journal,view};
}
test('plans cannot claim actual training and archive data cannot mint trusted capabilities',t=>{
  const f=fixture(t),root=f.event('one'),memory=f.memory([root]),service=new GrowthJournalService(f.store,policy);
  const epoch={id:f.scope.id,generation:f.scope.generation,consentRevision:f.scope.consentRevision};
  const journal=service.bind({epoch,publishedRefs:[memory]});service.plan(journal,{id:'plan-one',kind:'curation_lint'});
  const view=service.bindView(journal,{epoch}),data=service.read(view);
  assert.equal(data.entries[0]!.attempt,'NOT_STARTED');assert.equal(data.entries[0]!.actual.parametricTrainingPerformed,false);
  assert.equal(parseGrowthArchive(service.exportJson(view)).assurance,'NOT_AUTHENTICATED');
  assert.throws(()=>service.read({...view}));
});

test('actual wrapper performs lint and revalidation without model calls, semantic PASS, source bodies or DB writes',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'actual',kind:'curation_lint'}),before=f.store.snapshot(),persisted=f.persisted();
  const result=f.service.runCuration(f.journal,entry,raw(row()));
  assert.equal(result.attempt,'COMPLETED');assert.equal(result.actual.lintCompleted,true);assert.equal(result.actual.revalidationCompleted,true);
  assert.equal(result.actual.counts!.admitted,1);assert.equal(result.actual.semanticQuality,'NOT_EVALUATED');
  assert.equal(result.actual.parametricTrainingPerformed,false);assert.equal(result.actual.modelCalls,0);
  assert.equal(result.actual.artifactProduction,'NOT_RUN');assert.equal(result.actual.modelActivation,'NOT_RUN');assert.equal(result.simulation,null);
  assert.deepEqual(result.receipts.map(r=>r.phase),['PLANNED','STARTED','LINT_CALLED','LINT_COMPLETED','REVALIDATE_CALLED','REVALIDATE_COMPLETED','COMPLETED']);
  assert.ok(result.receipts.slice(2).every(r=>r.source==='CORE_OPERATION_OBSERVED'));
  const json=f.service.exportJson(f.view),md=f.service.exportMarkdown(f.view);
  assert.doesNotMatch(json+md,/PRIVATE_|alice|speakerId|selectedText|statement|annotation|manifestDigest/);
  assert.match(md,/NOT_AUTHENTICATED/);assert.match(md,/not a semantic evaluation PASS/);
  assert.deepEqual(f.store.snapshot(),before);assert.equal(f.persisted(),persisted);
  assert.equal(Reflect.set(result.actual,'lintCompleted',false),false);assert.equal(Reflect.set(result.receipts[0]!,'phase','COMPLETED'),false);
  assert.equal(f.service.read(f.view).entries[0]!.actual.lintCompleted,true);
});

test('zero admitted is actual checking, never a successful semantic evaluation or training',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'empty',kind:'curation_lint'}),result=f.service.runCuration(f.journal,entry,raw());
  assert.equal(result.attempt,'COMPLETED');assert.equal(result.actual.counts!.admitted,0);assert.equal(result.actual.revalidationCompleted,true);
  assert.equal(result.actual.semanticQuality,'NOT_EVALUATED');assert.equal(result.actual.parametricTrainingPerformed,false);
});

test('learning false permits authorized history but refuses curation without enabling consent',t=>{
  const f=ready(t,false),before=f.store.snapshot(),entry=f.service.plan(f.journal,{id:'refused',kind:'curation_lint'});
  const result=f.service.runCuration(f.journal,entry,raw());assert.equal(result.attempt,'REFUSED');assert.equal(result.actual.lintCalled,false);
  assert.ok(result.receipts.every(receipt=>receipt.source==='CONTROL_OBSERVED'));
  assert.equal(result.actual.lintCompleted,false);assert.equal(f.service.read(f.view).entries.length,1);assert.deepEqual(f.store.snapshot(),before);
});

test('selection failure and revalidation exceptions retain only observed effects, not raw exception text',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'bad-selection',kind:'curation_lint'});
  const result=f.service.runCuration(f.journal,entry,raw({...row(),memoryIndex:1}));
  assert.equal(result.attempt,'FAILED');assert.equal(result.actual.lintCalled,true);assert.equal(result.actual.lintCompleted,false);
  const second=f.service.plan(f.journal,{id:'revalidate-failure',kind:'curation_lint'}),original=CurationService.prototype.revalidate;
  try {
    CurationService.prototype.revalidate=()=>{throw Error('PRIVATE_EXCEPTION_HTML_<img src=https://example.invalid>');};
    const failed=f.service.runCuration(f.journal,second,raw(row()));
    assert.equal(failed.attempt,'FAILED');assert.equal(failed.actual.lintCompleted,true);assert.equal(failed.actual.revalidationCalled,true);
    assert.equal(failed.actual.revalidationCompleted,false);assert.equal(failed.actual.counts!.admitted,1);
    assert.doesNotMatch(f.service.exportJson(f.view)+f.service.exportMarkdown(f.view),/PRIVATE_EXCEPTION|<img|example.invalid/);
  } finally {CurationService.prototype.revalidate=original;}
});

test('canonical duplicate actual attempts cannot repeat work, change input, or bypass a fresh source gate',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'once',kind:'curation_lint'});let calls=0;
  const original=f.store.curationSnapshot.bind(f.store);f.store.curationSnapshot=(...args)=>{calls++;return original(...args);};
  const first=f.service.runCuration(f.journal,entry,raw()),count=calls;
  assert.deepEqual(f.service.runCuration(f.journal,entry,'{ "rows": [], "version": 1 }'),first);assert.equal(calls,count);
  assert.throws(()=>f.service.runCuration(f.journal,entry,raw(row())),code('GROWTH_ATTEMPT_CONFLICT'));
  f.store.revoke(f.epoch,f.root);assert.throws(()=>f.service.runCuration(f.journal,entry,raw()),code('STALE_SOURCE'));
  assert.equal(calls,count);assert.throws(()=>f.service.exportJson(f.view),code('GROWTH_SOURCE_INVALID'));
});

for(const scenario of GROWTH_SCENARIOS)test(`fixed synthetic ${scenario} never reports real training`,t=>{
  const f=ready(t,false),entry=f.service.plan(f.journal,{id:scenario,kind:'synthetic_replay'}),result=f.service.runSynthetic(f.journal,entry,scenario);
  assert.equal(result.actual.parametricTrainingPerformed,false);assert.equal(result.actual.modelCalls,0);assert.equal(result.actual.lintCalled,false);
  assert.ok(result.receipts.slice(1).every(r=>r.source==='SYNTHETIC_REPLAY'));
  assert.deepEqual(f.service.runSynthetic(f.journal,entry,scenario),result);
  const other=scenario==='refused'?'failed_after_step':'refused';
  assert.throws(()=>f.service.runSynthetic(f.journal,entry,other),code('GROWTH_ATTEMPT_CONFLICT'));
  const s=result.simulation!;
  if(scenario==='unknown_after_start'){assert.equal(result.attempt,'UNKNOWN');assert.equal(s.trainingOccurred,null);assert.equal(s.artifactProduced,null);assert.equal(s.everActivated,null);}
  else if(scenario==='refused'){assert.equal(result.attempt,'REFUSED');assert.equal(s.trainingOccurred,false);assert.equal(s.stepsLowerBound,0);}
  else {assert.equal(s.trainingOccurred,true);assert.equal(s.stepsLowerBound,1);}
  if(scenario==='aborted_after_step'||scenario==='failed_after_step'){assert.equal(s.artifactProduced,false);assert.equal(s.evaluation,'NOT_RUN');assert.equal(s.everActivated,false);}
  if(scenario==='artifact_without_evaluation'){assert.equal(s.artifactProduced,true);assert.equal(s.evaluation,'NOT_RUN');assert.equal(s.activation,'NOT_ACTIVE');}
  if(scenario==='evaluation_unknown'){assert.equal(s.artifactProduced,true);assert.equal(s.evaluation,'UNKNOWN');assert.equal(s.everActivated,false);}
  if(scenario==='activated_then_rolled_back'){assert.equal(s.evaluation,'PASS');assert.equal(s.everActivated,true);assert.equal(s.activation,'ROLLED_BACK');}
  assert.match(f.service.exportMarkdown(f.view),/SYNTHETIC_REPLAY ONLY/);
});

test('registry runtime change permanently fences writes but a new current view can read the same authorized history',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'before-activation',kind:'curation_lint'});
  f.service.runCuration(f.journal,entry,raw());const history=f.service.read(f.view).entries;
  const job=f.store.beginJob(f.epoch,[f.root],'training'),lease=f.store.claimLease(f.epoch,job.id);
  const artifact=f.store.registerArtifact(f.epoch,job.id,lease.token,{sha256:'a'.repeat(64),implementation:'synthetic-registry-only'});
  f.store.activateArtifact(f.epoch,artifact.id);
  assert.throws(()=>f.service.read(f.view),code('GROWTH_VIEW_REBIND_REQUIRED'));
  assert.throws(()=>f.service.runCuration(f.journal,entry,raw()),code('STALE_RUN'));
  assert.throws(()=>f.service.plan(f.journal,{id:'later',kind:'curation_lint'}),code('GROWTH_WRITE_FENCED'));
  const current=f.service.bindView(f.journal,{epoch:f.epoch});assert.deepEqual(f.service.read(current).entries,history);
  assert.equal(f.service.read(current).entries[0]!.actual.modelActivation,'NOT_RUN');
});

test('mid-observation runtime fence rejects delivery but preserves earlier lint history for a new current view',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'interleaved',kind:'curation_lint'});
  const job=f.store.beginJob(f.epoch,[f.root],'training'),lease=f.store.claimLease(f.epoch,job.id);
  const artifact=f.store.registerArtifact(f.epoch,job.id,lease.token,{sha256:'b'.repeat(64),implementation:'synthetic-registry-only'});
  const original=f.store.curationSnapshot.bind(f.store);let calls=0;
  f.store.curationSnapshot=(...args)=>{const snapshot=original(...args);if(++calls===2)f.store.activateArtifact(f.epoch,artifact.id);return snapshot;};
  assert.throws(()=>f.service.runCuration(f.journal,entry,raw()),code('GROWTH_WRITE_FENCED'));
  const current=f.service.bindView(f.journal,{epoch:f.epoch}),record=f.service.read(current).entries[0]!;
  assert.equal(record.attempt,'FAILED');assert.equal(record.actual.lintCompleted,true);assert.equal(record.actual.revalidationCalled,false);
  assert.throws(()=>f.service.runCuration(f.journal,entry,raw()),code('GROWTH_WRITE_FENCED'));
});

for(const mutation of ['consent-aba','purge','revoke','revise'] as const)test(`${mutation} cannot reauthorize a journal through current view binding`,t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'historical',kind:'curation_lint'});f.service.runCuration(f.journal,entry,raw());
  let current=f.scope;
  if(mutation==='consent-aba'){current=f.store.setLearningConsent(f.scope,false);current=f.store.setLearningConsent(current,true);}
  else if(mutation==='purge')current=f.store.purge(f.scope);
  else if(mutation==='revoke')f.store.revoke(f.scope,f.root);
  else f.store.reviseEvent(f.scope,f.root,{speakerId:'alice',speakerRole:'subject',mode:'self_report',selectedText:'different synthetic source',occurredAt:1000});
  const currentEpoch={id:current.id,generation:current.generation,consentRevision:current.consentRevision};
  assert.throws(()=>f.service.bindView(f.journal,{epoch:currentEpoch}));
  assert.throws(()=>f.service.read(f.view));assert.throws(()=>f.service.bindView(f.journal,{epoch:f.epoch}),code('GROWTH_SOURCE_INVALID'));
});

test('whole source pool includes unused memories and all ancestors even with no entries or empty rows',t=>{
  const f=ready(t),ancestor=publish(f.store,f.epoch,[f.root],{...claim,validTo:100010}),child=publish(f.store,f.epoch,[ancestor]);
  const journal=f.service.bind({epoch:f.epoch,publishedRefs:[f.memory,child]}),view=f.service.bindView(journal,{epoch:f.epoch});
  assert.equal(f.service.read(view).entries.length,0);f.setWall(100010);
  assert.throws(()=>f.service.read(view),code('STALE_SOURCE'));f.setWall(100000);
  assert.throws(()=>f.service.bindView(journal,{epoch:f.epoch}),code('GROWTH_SOURCE_INVALID'));
});

test('new views share monotone clock watermarks and cannot revive observed expiration or rollback',t=>{
  const f=ready(t),first=f.service.bindView(f.journal,{epoch:f.epoch});f.setWall(100100);f.service.read(first);f.setWall(100099);
  assert.throws(()=>f.service.bindView(f.journal,{epoch:f.epoch}),code('GROWTH_CLOCK_ROLLBACK'));f.setWall(100101);
  assert.throws(()=>f.service.read(first),code('GROWTH_SOURCE_INVALID'));
});

test('empty pool still gates authority and clock',t=>{
  const f=fixture(t),epoch={id:f.scope.id,generation:0,consentRevision:0},service=new GrowthJournalService(f.store,policy);
  const journal=service.bind({epoch,publishedRefs:[]}),view=service.bindView(journal,{epoch});assert.deepEqual(service.read(view).entries,[]);
  f.store.purge(f.scope);assert.throws(()=>service.exportJson(view),code('STALE_SCOPE'));assert.throws(()=>service.bindView(journal,{epoch}),code('GROWTH_SOURCE_INVALID'));
});

test('metadata drift is terminal even when the selected ref and current epoch do not change',t=>{
  const f=graph(t),root=f.node('root','event'),memory=f.node('memory','memory',['root']),service=new GrowthJournalService(f.store,policy);
  const epoch={id:f.scope.id,generation:0,consentRevision:0},journal=service.bind({epoch,publishedRefs:[memory]}),view=service.bindView(journal,{epoch});
  f.injector.prepare('UPDATE nodes SET created_at=created_at+1 WHERE id=?').run(root.id);
  assert.throws(()=>service.read(view),code('GROWTH_SOURCE_CHANGED'));
  f.injector.prepare('UPDATE nodes SET created_at=created_at-1 WHERE id=?').run(root.id);
  assert.throws(()=>service.bindView(journal,{epoch}),code('GROWTH_SOURCE_INVALID'));
});

test('opaque handles reject copies, other services, sibling journals and declaration archives',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'opaque',kind:'curation_lint'}),other=new GrowthJournalService(f.store,policy);
  const sibling=f.service.bind({epoch:f.epoch,publishedRefs:[f.memory]}),archive=parseGrowthArchive(f.service.exportJson(f.view));
  assert.throws(()=>f.service.runCuration({...f.journal},entry,raw()),code('UNAUTHENTICATED'));
  assert.throws(()=>other.read(f.view),code('UNAUTHENTICATED'));assert.throws(()=>f.service.runCuration(sibling,entry,raw()),code('UNAUTHENTICATED'));
  assert.throws(()=>f.service.runCuration(f.journal,{...entry},raw()),code('UNAUTHENTICATED'));
  assert.throws(()=>f.service.read(archive as never),code('UNAUTHENTICATED'));
});

test('closed data rejects proxies, accessors, iterators, sparse and oversized arrays without executing caller hooks',t=>{
  const f=ready(t);let calls=0;const hook=()=>{calls++;throw Error('PRIVATE_HOOK');};
  const input={epoch:f.epoch,publishedRefs:[f.memory]};
  assert.throws(()=>f.service.bind(new Proxy(input,{get:hook,ownKeys:hook})),code('INVALID_INPUT'));
  assert.throws(()=>f.service.bind({get epoch(){return hook();},publishedRefs:[f.memory]}),code('INVALID_INPUT'));
  assert.throws(()=>f.service.bind({epoch:new Proxy(f.epoch,{get:hook}),publishedRefs:[]}),code('INVALID_INPUT'));
  const iterator=[f.memory];Object.defineProperty(iterator,Symbol.iterator,{get:hook});
  assert.throws(()=>f.service.bind({epoch:f.epoch,publishedRefs:iterator}),code('INVALID_INPUT'));
  assert.throws(()=>f.service.bind({epoch:f.epoch,publishedRefs:new Array(1)}),code('INVALID_INPUT'));
  const huge=new Array(33);Object.defineProperty(huge,0,{get:hook});
  assert.throws(()=>f.service.bind({epoch:f.epoch,publishedRefs:huge}),code('GROWTH_LIMIT'));
  assert.throws(()=>f.service.plan(f.journal,{id:'forged',get kind(){return hook();}}),code('INVALID_INPUT'));
  const entry=f.service.plan(f.journal,{id:'valid',kind:'curation_lint'});
  assert.throws(()=>f.service.runCuration(f.journal,entry,{toString:hook} as never),code('INVALID_INPUT'));assert.equal(calls,0);
});

test('invalid declarations cannot inject actual status, execute markup, or damage a valid unstarted entry',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'safe',kind:'curation_lint'});
  for(const id of ['<script>','![image](https://example.invalid)','[link](https://example.invalid)','line\n# Actual','x`code`'])
    assert.throws(()=>f.service.plan(f.journal,{id,kind:'curation_lint'}),code('INVALID_INPUT'));
  assert.throws(()=>f.service.plan(f.journal,{id:'forged',kind:'curation_lint',actual:true} as never),code('INVALID_INPUT'));
  assert.throws(()=>f.service.runCuration(f.journal,entry,'{'));assert.equal(f.service.read(f.view).entries[0]!.attempt,'NOT_STARTED');
  assert.equal(f.service.runCuration(f.journal,entry,raw()).attempt,'COMPLETED');
  const archive=JSON.parse(f.service.exportJson(f.view));archive.record.entries[0].actual.parametricTrainingPerformed=true;
  assert.throws(()=>parseGrowthArchive(JSON.stringify(archive)),code('GROWTH_ARCHIVE_INVALID'));
});

test('entry and total receipt capacity are reserved before the next actual operation starts',t=>{
  const f=ready(t);for(let i=0;i<15;i++){
    const entry=f.service.plan(f.journal,{id:`sim-${i}`,kind:'synthetic_replay'});f.service.runSynthetic(f.journal,entry,'activated_then_rolled_back');
  }
  const entry=f.service.plan(f.journal,{id:'over-budget',kind:'curation_lint'});let calls=0;
  const original=f.store.curationSnapshot.bind(f.store);f.store.curationSnapshot=(...args)=>{calls++;return original(...args);};
  assert.throws(()=>f.service.runCuration(f.journal,entry,raw()),code('GROWTH_LIMIT'));assert.equal(calls,0);
  assert.equal(f.service.read(f.view).entries[15]!.attempt,'NOT_STARTED');
  assert.throws(()=>f.service.plan(f.journal,{id:'seventeenth',kind:'curation_lint'}),code('GROWTH_LIMIT'));
  assert.equal(parseGrowthArchive(f.service.exportJson(f.view)).record.entries.length,16);
  assert.ok(Buffer.byteLength(f.service.exportJson(f.view))<=65536);assert.ok(Buffer.byteLength(f.service.exportMarkdown(f.view))<=65536);
});

test('archive reopen is untrusted rendering, not RAM receipt recovery or current access',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'archive',kind:'curation_lint'});f.service.runCuration(f.journal,entry,raw());
  const path=join(mkdtempSync(join(tmpdir(),'companion-journal-archive-')),'synthetic.json');writeFileSync(path,f.service.exportJson(f.view));
  const json=readFileSync(path,'utf8'),parsed=parseGrowthArchive(json),md=renderGrowthArchive(json);
  assert.equal(parsed.assurance,'NOT_AUTHENTICATED');assert.match(md,/Archive declares local curation/);assert.match(md,/NOT_AUTHENTICATED/);
  const reopenedStore=new MemoryStore(':memory:',{image:f.store.snapshot(),clock:{wall:()=>100000,monotonic:()=>0}});
  try {
    const other=new GrowthJournalService(reopenedStore,policy);assert.throws(()=>other.read(f.view),code('UNAUTHENTICATED'));
    const fresh=other.bind({epoch:f.epoch,publishedRefs:[f.memory]}),view=other.bindView(fresh,{epoch:f.epoch});assert.deepEqual(other.read(view).entries,[]);
  } finally {reopenedStore.close();}
  f.store.revoke(f.epoch,f.root);assert.throws(()=>f.service.exportJson(f.view));
  assert.equal(parseGrowthArchive(json).assurance,'NOT_AUTHENTICATED');assert.throws(()=>f.service.bind({epoch:f.epoch,publishedRefs:parsed.record.sourceRefs.map(ref=>({...ref}))}));
});

test('archive byte, shape, sequence and fixed provenance bounds fail closed',t=>{
  const f=ready(t),entry=f.service.plan(f.journal,{id:'archive-bounds',kind:'curation_lint'});f.service.runCuration(f.journal,entry,raw());
  const json=f.service.exportJson(f.view);assert.equal(parseGrowthArchive(json+' '.repeat(65536-Buffer.byteLength(json))).assurance,'NOT_AUTHENTICATED');
  assert.throws(()=>parseGrowthArchive(json+' '.repeat(65537-Buffer.byteLength(json))));
  for(const mutate of [(a:Record<string,any>)=>{a.assurance='CURRENT_AUTHORIZED_LOCAL_VIEW';},
    (a:Record<string,any>)=>{a.record.entries[0].receipts[0].sequence=2;},
    (a:Record<string,any>)=>{a.record.entries[0].receipts[0].source='LLM_VERIFIED';},
    (a:Record<string,any>)=>{a.record.entries[0].id='<img src=https://example.invalid>';},
    (a:Record<string,any>)=>{a.record.entries[0].statement='PRIVATE';}]) {
    const input=JSON.parse(json);mutate(input);assert.throws(()=>renderGrowthArchive(JSON.stringify(input)));
  }
});

test('expiration observed after actual lint forbids returning the old entry record',t=>{
  const f=fixture(t),scope=f.store.setLearningConsent(f.scope,true),epoch={id:scope.id,generation:scope.generation,consentRevision:scope.consentRevision};
  const root=f.store.acceptEvent(epoch,{source:'synthetic',eventKey:'ttl',evidence:{speakerId:'alice',speakerRole:'subject',mode:'self_report',selectedText:'PRIVATE_SYNTHETIC_BODY',occurredAt:1000}});
  const memory=publish(f.store,epoch,[root],{...claim,validTo:100010}),service=new GrowthJournalService(f.store,policy);
  const journal=service.bind({epoch,publishedRefs:[memory]}),entry=service.plan(journal,{id:'private-plan-label',kind:'curation_lint'});
  const snapshot=f.store.curationSnapshot.bind(f.store);let calls=0;
  f.store.curationSnapshot=(...args)=>{const result=snapshot(...args);if(++calls===2)f.setWall(100010);return result;};
  assert.throws(()=>service.runCuration(journal,entry,JSON.stringify({version:1,rows:[]})),'EXPIRED_CURATION_RETURNED_RECORD');
  assert.throws(()=>service.bindView(journal,{epoch}));
});

for(const cutoff of [1,3])test(`expiry after curation snapshot ${cutoff} cannot escape through failure or completion`,t=>{
  const f=ready(t,true,100010),entry=f.service.plan(f.journal,{id:'expires',kind:'curation_lint'});
  const original=f.store.curationSnapshot.bind(f.store);let calls=0;
  f.store.curationSnapshot=(...args)=>{const result=original(...args);if(++calls===cutoff)f.setWall(100010);return result;};
  assert.throws(()=>f.service.runCuration(f.journal,entry,raw()));assert.throws(()=>f.service.read(f.view),code('GROWTH_SOURCE_INVALID'));
  f.setWall(100000);assert.throws(()=>f.service.runCuration(f.journal,entry,raw()),code('GROWTH_WRITE_FENCED'));
});

test('source inputs are detached copies and pure archived claims cannot become live receipts',t=>{
  const f=ready(t),epoch={...f.epoch},refs=[{...f.memory}],journal=f.service.bind({epoch,publishedRefs:refs});
  epoch.consentRevision=999;refs[0]!.revision=999;
  const entry=f.service.plan(journal,{id:'copied',kind:'curation_lint'}),view=f.service.bindView(journal,{epoch:f.epoch});
  const untrusted=JSON.parse(f.service.exportJson(view));untrusted.record.entries[0].actual.lintCompleted=true;
  const parsed=parseGrowthArchive(JSON.stringify(untrusted));assert.equal(parsed.assurance,'NOT_AUTHENTICATED');
  assert.equal(f.service.read(view).entries[0]!.actual.lintCompleted,false);
  assert.throws(()=>f.service.runCuration(journal,parsed.record.entries[0] as never,raw()),code('UNAUTHENTICATED'));
  assert.equal(f.service.runCuration(journal,entry,raw()).actual.lintCompleted,true);
});
