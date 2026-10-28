import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical,copyJson,hash } from '../src/wf1-json.ts';
import { assembleScopedIndexes } from '../src/corpus-qa-index.ts';
import { createSyntheticQaCatalogModel,SYNTHETIC_QA_CATALOG_LIMITS } from '../src/corpus-qa-catalog-model.ts';
import type { SyntheticCatalogCompatibility,SyntheticCatalogSource,SyntheticCatalogGeneration,SyntheticCatalogAck,SyntheticCatalogUpdate } from '../src/corpus-qa-catalog-model.ts';
import type { ScopedIndexEntry } from '../src/corpus-qa-index.ts';
import type { ScopedRef } from '../src/corpus-production-types.ts';
import { legacyScopedAssemblyOracle } from './corpus-qa-catalog-legacy-oracle.ts';

const compatibility:SyntheticCatalogCompatibility={purposeDigest:hash('synthetic purposes'),studentTargetDigest:hash('synthetic student'),tokenizerProfileDigest:hash('synthetic tokenizer'),generationTargetDigest:hash('synthetic generation target'),auditTargetDigest:hash('synthetic audit target')};
const ref=(label:string,kind='corpus-qa-verdict'):ScopedRef=>({bucket:'meta',ref:{id:'00000000-0000-4000-8000-'+hash(label).slice(0,12),kind,partition:'train',bytes:32,digest:hash(label)}});
function source(ordinal:number,count=3):SyntheticCatalogSource{
  const job='synthetic-source-'+ordinal;
  const entries:ScopedIndexEntry[]=Array.from({length:count},(_,i)=>({sourceJobId:job,unitId:'unit-'+i,poolId:'pool',familyId:'family-'+i,split:'train',rowRef:ref(job+' row '+i,'corpus-production-row'),rowDigest:hash(job+' row '+i),exactDigest:hash(job+' exact '+i),normalizedDigest:hash(job+' normalized '+i),promptDigest:hash(job+' prompt '+i),qaDisposition:'PASS'}));
  const index={version:'CorpusScopedDedupIndex/0.1' as const,scope:{selectionDigest:hash(job+' selection'),populationDigest:hash(job+' population'),sourceJobId:job,included:'SELECTED_ELIGIBLE_ONLY' as const,excludedOriginalRejected:'NOT_READ' as const,comparison:'EXACT_NORMALIZED_PROMPT_ONLY' as const},entries};
  return {version:'SyntheticQaCatalogSource/0.1',kind:'FULL_INDEX',ordinal,descriptorDigest:hash(job+' descriptor'),auditId:'audit-'+job,indexDigest:hash(canonical(index)),index,metadata:entries.map((e,i)=>({unitId:e.unitId,caseId:'case-'+i,verdictRef:ref(job+' verdict '+i),tokenReceiptRef:ref(job+' token '+i,'corpus-token-receipt'),measurement:{version:'CorpusTokenMeasurement/0.1',status:'LOCAL_PINNED_EXACT',rowDigest:e.rowDigest,tokenizerProfileDigest:compatibility.tokenizerProfileDigest,studentInputTokens:'2',studentLossTokens:'3',fullTokens:'5',inputIdsDigest:hash(job+' inputids '+i),fullIdsDigest:hash(job+' fullids '+i),lossMaskDigest:hash(job+' loss '+i),lossPolicy:'ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR',officialPipelineParity:'NOT_VALIDATED',actualTrainerParity:'NOT_RUN',trainingReady:false}})),rubricRef:null,rubricCipherDigest:null,compatibility:{...compatibility}};
}
const repin=(s:SyntheticCatalogSource)=>{s.indexDigest=hash(canonical(s.index));return s;};
const model=()=>createSyntheticQaCatalogModel({catalogId:'synthetic-catalog',compatibility});
type Model=ReturnType<typeof model>;
const update=(m:Model,append:SyntheticCatalogSource[]=[],withdrawEligibility:string[]=[],withdrawRetention:string[]=[]):SyntheticCatalogUpdate=>({version:'SyntheticQaCatalogUpdate/0.1',expectedParent:m.current()?.digest??null,append,withdrawEligibility,withdrawRetention});
const ack=(g:SyntheticCatalogGeneration):SyntheticCatalogAck=>({version:'SyntheticQaCatalogAck/0.1',status:'SYNTHETIC_SUCCESS',catalogId:g.catalogId,candidateDigest:g.digest,expectedParent:g.parentDigest});
const advance=(m:Model,s:SyntheticCatalogSource[]=[],eligible:string[]=[],retained:string[]=[])=>{const g=m.prepare(update(m,s,eligible,retained));m.commit(g,ack(g));return g;};
function expected(sources:SyntheticCatalogSource[]){
  // Match the pre-existing validator's null-prototype data copy, independently
  // of the graph kernel being tested. The oracle graph body is unchanged.
  const oracle=legacyScopedAssemblyOracle(sources.flatMap(s=>s.index.entries.map(e=>copyJson(e) as ScopedIndexEntry)),sources.map(s=>s.indexDigest));
  const metadata=new Map(sources.flatMap(s=>s.index.entries.map((e,i)=>[canonical({jobId:e.sourceJobId,unitId:e.unitId}),{s,m:copyJson(s.metadata[i]!) as typeof s.metadata[number]}] as const)));
  const rows=oracle.rows.filter(r=>r.eligibleForNextExport&&metadata.get(canonical({jobId:r.sourceJobId,unitId:r.unitId}))!.m.verdictRef).map(r=>{const {s,m}=metadata.get(canonical({jobId:r.sourceJobId,unitId:r.unitId}))!;return {...r,caseId:m.caseId,verdictRef:m.verdictRef!,descriptorDigest:s.descriptorDigest,auditId:s.auditId,tokenReceiptRef:m.tokenReceiptRef,measurement:m.measurement};});
  const tokens=(split:'train'|'dev')=>{const subset=rows.filter(r=>r.split===split);return {rows:subset.length,studentInputTokens:subset.reduce((n,r)=>n+Number(r.measurement.studentInputTokens),0),studentLossTokens:subset.reduce((n,r)=>n+Number(r.measurement.studentLossTokens),0),fullTokens:subset.reduce((n,r)=>n+Number(r.measurement.fullTokens),0)};};
  return {oracle,rows,totals:{train:tokens('train'),dev:tokens('dev')}};
}

test('one to eight full sources exactly match frozen pre-extraction oracle, members and inherited tokens',async t=>{
  for(let n=1;n<=8;n++)await t.test(String(n),()=>{
    const sources=Array.from({length:n},(_,i)=>source(i,12));
    for(const [i,s] of sources.entries()){
      s.index.entries[1]!.qaDisposition='REJECT';s.index.entries[2]!.qaDisposition='HOLD';s.index.entries[3]!.qaDisposition='UNCERTAIN';s.index.entries[4]!.qaDisposition='NOT_AUDITED';
      s.index.entries[5]!.split='dev';s.index.entries[5]!.promptDigest=hash('cross split prompt');s.index.entries[6]!.promptDigest=hash('cross split prompt');
      s.index.entries[7]!.normalizedDigest=hash('same split duplicate');s.index.entries[8]!.exactDigest=hash('exact duplicate');
      s.index.entries[9]!.familyId=s.index.entries[5]!.familyId;
      s.index.entries[10]!.split='dev';s.metadata[11]!.verdictRef=null;
      if(i)s.index.entries[0]!.exactDigest=sources[0]!.index.entries[1]!.exactDigest;
      repin(s);
    }
    const wanted=expected(sources),actual=advance(model(),sources);
    assert.deepEqual(assembleScopedIndexes(sources.map(s=>s.index),sources.map(s=>s.indexDigest)),wanted.oracle);
    assert.deepEqual(actual.graphRows,wanted.oracle.rows);assert.deepEqual(actual.selectedRows,wanted.rows);assert.deepEqual(actual.totals,wanted.totals);
    assert.equal(actual.nodes.length,n*12);assert.equal(actual.authentication,'NOT_AUTHENTICATED');assert.equal(actual.productionUse,'NOT_SUPPORTED');
  });
});

test('ninth REJECT or HOLD bridge reaches an earlier rejected node and holds train/dev families',async t=>{
  for(const disposition of ['REJECT','HOLD'] as const)await t.test(disposition,()=>{
    const sources=Array.from({length:9},(_,i)=>source(i,2));
    sources[0]!.index.entries[0]!.qaDisposition=disposition;
    sources[0]!.index.entries[1]!.familyId=sources[0]!.index.entries[0]!.familyId;
    sources[1]!.index.entries[0]!.split='dev';
    const bridge=sources[8]!.index.entries[0]!;bridge.qaDisposition=disposition;bridge.exactDigest=sources[0]!.index.entries[0]!.exactDigest;bridge.promptDigest=sources[1]!.index.entries[0]!.promptDigest;
    sources.forEach(repin);const m=model(),first=advance(m,sources.slice(0,8)),snapshot=m.snapshot(),before=canonical(snapshot);
    assert.equal(first.graphRows.filter(r=>r.familyHold).length,0);const ninth=advance(m,[sources[8]!]);
    assert.equal(ninth.nodes.length,18);assert.ok(ninth.graphRows.find(r=>r.sourceJobId===sources[0]!.index.scope.sourceJobId&&r.unitId==='unit-1')!.familyHold);
    assert.ok(ninth.graphRows.find(r=>r.sourceJobId===sources[1]!.index.scope.sourceJobId&&r.unitId==='unit-0')!.familyHold);
    assert.throws(()=>m.checkSnapshotAgainstCurrent(snapshot),{code:'CQA_CATALOG_SNAPSHOT_INELIGIBLE'});assert.equal(canonical(snapshot),before);
    assert.throws(()=>assembleScopedIndexes(sources.map(s=>s.index),sources.map(s=>s.indexDigest)),{code:'CQA_INDEX'});
  });
});

test('declared ordinal and original index order survive different append/page grouping',()=>{
  const sources=Array.from({length:8},(_,i)=>source(i));for(const s of sources){s.index.entries[0]!.exactDigest=hash('shared');repin(s);}
  const one=model(),paged=model();const a=advance(one,[...sources].reverse());advance(paged,sources.slice(0,3).reverse());advance(paged,sources.slice(3,5));const b=advance(paged,sources.slice(5).reverse());
  assert.notEqual(a.digest,b.digest);assert.equal(a.graphDigest,b.graphDigest);assert.equal(a.membershipContentDigest,b.membershipContentDigest);
  assert.deepEqual(a.graphRows,b.graphRows);assert.deepEqual(a.selectedRows,b.selectedRows);assert.deepEqual(a.totals,b.totals);
  assert.equal(a.selectedRows[0]!.sourceJobId,sources[0]!.index.scope.sourceJobId);
});

test('eligibility withdrawal keeps all bridge evidence and never promotes a later duplicate',()=>{
  const a=source(0,1),b=source(1,1);b.index.entries[0]!.exactDigest=a.index.entries[0]!.exactDigest;repin(b);
  const m=model(),first=advance(m,[a,b]),snapshot=m.snapshot();assert.equal(first.selectedRows.length,1);
  const withdrawn=advance(m,[],[a.index.scope.sourceJobId]);assert.equal(withdrawn.nodes.length,2);assert.equal(withdrawn.graphDigest,first.graphDigest);assert.deepEqual(withdrawn.graphRows,first.graphRows);assert.equal(withdrawn.selectedRows.length,0);
  assert.throws(()=>m.checkSnapshotAgainstCurrent(snapshot),{code:'CQA_CATALOG_SNAPSHOT_INELIGIBLE'});
  const c=source(2,1);c.index.entries[0]!.split='dev';c.index.entries[0]!.promptDigest=a.index.entries[0]!.promptDigest;repin(c);
  const next=advance(m,[c]);assert.ok(next.graphRows.every(r=>r.familyHold));assert.equal(next.selectedRows.length,0);assert.equal(next.nodes.length,3);
});

test('declared retention loss blocks coverage, computation and old snapshot use; old bytes stay fixed',()=>{
  const m=model(),s=source(0);advance(m,[s]);const old=m.snapshot(),bytes=canonical(old);
  const pending=m.prepare(update(m,[],[],[s.index.scope.sourceJobId]));assert.equal(pending.status,'COVERAGE_GAP_BLOCKED');assert.equal(pending.graphDigest,null);assert.equal(pending.totals,null);assert.deepEqual(pending.nodes,[]);
  m.checkSnapshotAgainstCurrent(old);m.commit(pending,ack(pending));
  assert.throws(m.snapshot,{code:'CQA_CATALOG_COVERAGE_GAP_BLOCKED'});assert.throws(()=>m.checkSnapshotAgainstCurrent(old),{code:'CQA_CATALOG_COVERAGE_GAP_BLOCKED'});assert.throws(()=>m.prepare(update(m,[source(1)])),{code:'CQA_CATALOG_COVERAGE_GAP_BLOCKED'});
  assert.equal(canonical(old),bytes);
});

test('prepare/lost synthetic reply do not publish; CAS, foreign candidates, rollback and invalid ACK refuse',()=>{
  const m=model(),first=m.prepare(update(m,[source(0)])),competing=m.prepare(update(m,[source(0)]));assert.equal(m.current(),null);
  assert.throws(()=>m.commit(first,{...ack(first),candidateDigest:hash('wrong')}),{code:'CQA_CATALOG_SYNTHETIC_ACK'});assert.equal(m.current(),null);
  assert.throws(()=>m.commit(structuredClone(first),ack(first)),{code:'CQA_CATALOG_CANDIDATE'});
  const other=model();assert.throws(()=>other.commit(first,ack(first)),{code:'CQA_CATALOG_CANDIDATE'});
  const receipt=m.commit(first,ack(first));assert.equal(receipt.receiptStatus,'SYNTHETIC_ACK_ONLY');assert.equal(receipt.authentication,'NOT_AUTHENTICATED');
  assert.throws(()=>m.commit(competing,ack(competing)),{code:'CQA_CATALOG_PARENT'});assert.throws(()=>m.commit(first,ack(first)),{code:'CQA_CATALOG_CANDIDATE'});
  assert.throws(()=>m.prepare({...update(m,[source(1)]),expectedParent:null}),{code:'CQA_CATALOG_PARENT'});
});

test('source and candidate mutations cannot change a prepared or committed generation',()=>{
  const m=model(),s=source(0),p=m.prepare(update(m,[s])),bytes=canonical(p);
  s.index.entries[0]!.promptDigest=hash('mutation');s.metadata[0]!.measurement.studentInputTokens='100';
  assert.equal(canonical(p),bytes);assert.throws(()=>{p.nodes[0]!.promptDigest=hash('blocked');},TypeError);assert.throws(()=>{p.nodes[0]!.metadata.measurement.fullTokens='123';},TypeError);
  m.commit(p,ack(p));const snap=m.snapshot();assert.throws(()=>snap.members.push(snap.members[0]!),TypeError);assert.equal(canonical(p),bytes);
});

test('membership snapshots cannot import as full indexes or concatenate members across generations',()=>{
  const m=model();advance(m,[source(0)]);const a=m.snapshot();advance(m,[source(1)]);const b=m.snapshot();m.checkSnapshotAgainstCurrent(a);
  const mixed={...b,members:[...a.members,...b.members]};assert.throws(()=>m.checkSnapshotAgainstCurrent(mixed),{code:'CQA_CATALOG_SNAPSHOT_BINDING'});
  assert.throws(()=>m.prepare({...update(m),append:[b as unknown as SyntheticCatalogSource]}));
  const fake={...source(2),kind:'MEMBERSHIP_SNAPSHOT'} as unknown as SyntheticCatalogSource;assert.throws(()=>m.prepare(update(m,[fake])),{code:'CQA_CATALOG_FULL_INDEX_REQUIRED'});
});

test('source compatibility, ordinal, audit conflicts and any same-source supersession refuse',()=>{
  const m=model(),s=source(0);advance(m,[s]);
  assert.throws(()=>m.prepare(update(m,[{...s,ordinal:1,auditId:'replacement'}])),{code:'CQA_CATALOG_SUPERSESSION_UNSUPPORTED'});
  const partial=structuredClone(s);partial.ordinal=1;partial.index.entries.pop();partial.metadata.pop();repin(partial);assert.throws(()=>m.prepare(update(m,[partial])),{code:'CQA_CATALOG_SUPERSESSION_UNSUPPORTED'});
  assert.throws(()=>m.prepare(update(m,[source(2)])),{code:'CQA_CATALOG_SOURCE_ORDER'});
  const bad=source(1);bad.compatibility.studentTargetDigest=hash('other target');assert.throws(()=>m.prepare(update(m,[bad])),{code:'CQA_CATALOG_INCOMPATIBLE'});
  assert.throws(()=>m.prepare(update(m,[{...source(1),auditId:s.auditId}])),{code:'CQA_CATALOG_SOURCE_CONFLICT'});
  assert.throws(()=>m.prepare(update(m,[],['unknown'])),{code:'CQA_CATALOG_SOURCE_CONFLICT'});
});

test('64 sources and 12288 distinct nodes are accepted as a bounded synthetic model; excess refuses',()=>{
  assert.equal(SYNTHETIC_QA_CATALOG_LIMITS.nodes,64*192);
  const m=model();for(let start=0;start<64;start+=8)advance(m,Array.from({length:8},(_,i)=>source(start+i,192)));
  assert.equal(m.current()!.nodes.length,12288);assert.equal(m.current()!.selectedRows.length,12288);assert.equal(m.current()!.totals!.train.fullTokens,61440);
  const beyond=source(63,1);beyond.index.scope.sourceJobId='source-65';beyond.index.entries[0]!.sourceJobId='source-65';repin(beyond);
  assert.throws(()=>m.prepare(update(m,[beyond])),{code:'CQA_CATALOG_LIMIT'});
  assert.throws(()=>model().prepare(update(model(),Array.from({length:9},(_,i)=>source(i)))) ,{code:'CQA_CATALOG_LIMIT'});
  assert.throws(()=>model().prepare(update(model(),[source(0,193)])),{code:'CQA_CATALOG_LIMIT'});
});

test('malformed data, accessors, proxies, sparse arrays, tampered digests and measurement changes refuse',()=>{
  const m=model();let calls=0;
  const accessor=source(0);Object.defineProperty(accessor,'index',{get:()=>{calls++;throw Error('must not invoke');},enumerable:true});assert.throws(()=>m.prepare(update(m,[accessor])));assert.equal(calls,0);
  const proxy=source(0);proxy.index.entries=new Proxy(proxy.index.entries,{get(){calls++;throw Error('must not invoke');}});assert.throws(()=>m.prepare(update(m,[proxy])));assert.equal(calls,0);
  const sparse=source(0);delete sparse.metadata[1];assert.throws(()=>m.prepare(update(m,[sparse])),{code:'CQA_CATALOG_SHAPE'});
  assert.throws(()=>m.prepare(update(m,[{...source(0),indexDigest:hash('wrong')} ])),{code:'CQA_CATALOG_INDEX_DIGEST'});
  const measured=source(0);measured.metadata[0]!.measurement.fullTokens='7';assert.throws(()=>m.prepare(update(m,[measured])),{code:'CQA_CATALOG_MEASUREMENT'});
  const duplicate=source(0);duplicate.index.entries[1]!.unitId=duplicate.index.entries[0]!.unitId;repin(duplicate);assert.throws(()=>m.prepare(update(m,[duplicate])),{code:'CQA_INDEX'});
  assert.equal(m.current(),null);
});

test('empty eligible output retains REJECT/HOLD full nodes and gives an explicitly synthetic snapshot',()=>{
  const s=source(0,2);s.index.entries[0]!.qaDisposition='REJECT';s.index.entries[1]!.qaDisposition='HOLD';repin(s);
  const m=model(),g=advance(m,[s]);assert.equal(g.nodes.length,2);assert.equal(g.selectedRows.length,0);assert.equal(m.snapshot().type,'MEMBERSHIP_SNAPSHOT');assert.equal(m.snapshot().trainingReady,false);
});

test('immutable node identity excludes QA disposition while row/family/split/fingerprints remain bound',()=>{
  const s=source(0,1),before=advance(model(),[s]);s.index.entries[0]!.qaDisposition='REJECT';repin(s);
  const disposition=advance(model(),[s]);assert.equal(before.sourceRegistry[0]!.nodeIdentityDigest,disposition.sourceRegistry[0]!.nodeIdentityDigest);assert.notEqual(before.graphDigest,disposition.graphDigest);
  s.index.entries[0]!.promptDigest=hash('different immutable prompt');repin(s);const changed=advance(model(),[s]);assert.notEqual(changed.sourceRegistry[0]!.nodeIdentityDigest,disposition.sourceRegistry[0]!.nodeIdentityDigest);
});
