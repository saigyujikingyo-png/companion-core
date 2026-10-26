import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalTrainingEvent, parseTrainingEvent, reduceTrainingEvent, TJ_LIMITS, TrainingJournalError } from '../src/training-journal-format.ts';
import type { AttemptProjection } from '../src/training-journal-format.ts';
import { DIGEST, OTHER_DIGEST, event, trace } from './fixtures/training-journal-fixture.ts';

const rejects=(fn:()=>unknown,code?:string)=>assert.throws(fn,(e:unknown)=>e instanceof TrainingJournalError&&(!code||e.code===code));
const reduce=(p:AttemptProjection|undefined,raw:string)=>reduceTrainingEvent(p,parseTrainingEvent(raw).event);
test('TJ0 canonical bytes retain Unicode, 78-digit counters and exact negative zero/NaN/infinity/subnormal bits',()=>{
  const raw=trace()[2]!,canonical=canonicalTrainingEvent(raw),value=parseTrainingEvent(canonical);
  assert.equal(value.assurance,'NOT_AUTHENTICATED');assert.equal(canonicalTrainingEvent(canonical),canonical);
  assert.equal(value.event.kind,'STEP');if(value.event.kind!=='STEP')return;
  assert.equal(value.event.data.optimizerSteps,'9007199254740993');
  assert.equal(value.event.data.metrics[0]!.value!.bits,'80000000000000007ff0000000000000fff00000000000007ff80000000000ab0000000000000001');
  const e=JSON.parse(event('INTENT',1));e.data.seed='9'.repeat(78);assert.match(canonicalTrainingEvent(JSON.stringify(e)),/9{78}/);
  assert.ok(canonicalTrainingEvent(event('INTENT',1)).includes('e\u0301'));
});
test('TJ0 format keeps planned budget independent of observed effects and all imported claims unauthenticated',()=>{
  let p=reduce(undefined,event('INTENT',1));assert.equal(p.optimizerStepsLowerBound,null);assert.equal(p.state,'NOT_STARTED');
  for(const raw of trace().slice(1))p=reduce(p,raw);
  assert.equal(p.state,'COMPLETED');assert.equal(p.optimizerStepsLowerBound,'9007199254740993');
  assert.equal(p.activation,'ROLLED_BACK');assert.equal(p.everActivated,true);assert.equal(p.batchesLowerBound,null);
  rejects(()=>canonicalTrainingEvent(event('INTENT',1,{}, {executionMode:'REAL'})));
  rejects(()=>canonicalTrainingEvent(event('INTENT',1,{}, {assurance:'RUNNER_OBSERVED'})));
  rejects(()=>canonicalTrainingEvent(event('INTENT',1,{}, {datasetOrigin:'PRIVATE_CHAT'})));
});
for(const [name,mutate] of [
  ['duplicate key',(s:string)=>s.replace('"version":1','"version":1,"version":1')],
  ['unpaired surrogate',(s:string)=>s.replace('SYNTHETIC 训练履历 🧪 e\\u0301','\\ud800')],
  ['leading zero count',(s:string)=>s.replace('"sequence":"1"','"sequence":"01"')],
  ['numeric count',(s:string)=>s.replace('"sequence":"1"','"sequence":1')],
  ['BOM',(s:string)=>'\ufeff'+s],
  ['unknown field',(s:string)=>s.replace('"version":1','"extra":null,"version":1')],
] as const)test(`TJ0 rejects ${name}`,()=>{
  let raw=event('INTENT',1);if(name==='unpaired surrogate'){const obj=JSON.parse(raw);obj.data.purpose='\ud800';raw=JSON.stringify(obj);}else raw=mutate(raw);
  rejects(()=>canonicalTrainingEvent(raw));
});
test('TJ0 exact metric shape, bits, dtype and field budgets reject before uncontrolled expansion',()=>{
  for(const value of [
    {dtype:'f64',shape:[129],bits:'00'}, {dtype:'f64',shape:[128,128],bits:'00'},
    {dtype:'f64',shape:[],bits:'7FF8000000000000'}, {dtype:'f16',shape:[],bits:'0000'},
    {dtype:'f32',shape:[0],bits:''}, {dtype:'f32',shape:[],bits:'000000000'},
  ])rejects(()=>canonicalTrainingEvent(event('STEP',3,{optimizerSteps:'1',batches:null,metrics:[{name:'m',unit:'x',value}]})));
  const allowed={name:'m',unit:'ratio',value:{dtype:'f64',shape:[128],bits:'7ff80000000000ab'.repeat(128)}};
  assert.equal(parseTrainingEvent(event('STEP',3,{optimizerSteps:'1',batches:null,metrics:[allowed]})).event.kind,'STEP');
  rejects(()=>canonicalTrainingEvent(event('STEP',3,{optimizerSteps:'1',batches:null,metrics:Array.from({length:17},(_,i)=>({...allowed,name:'m'+i}))})));
  const obj=JSON.parse(event('INTENT',1));obj.data.purpose='a'.repeat(1_025);rejects(()=>canonicalTrainingEvent(JSON.stringify(obj)));
  obj.data.purpose='a'.repeat(TJ_LIMITS.eventBytes);rejects(()=>canonicalTrainingEvent(JSON.stringify(obj)),'TJ_LIMIT');
  rejects(()=>canonicalTrainingEvent('['.repeat(9)+']'.repeat(9)),'TJ_LIMIT');
});
test('TJ0 order, causal identities, terminal fence and independent late observations',()=>{
  rejects(()=>reduce(undefined,event('STARTED',1)),'TJ_ORDER');let p=reduce(undefined,event('INTENT',1));
  rejects(()=>reduce(p,event('STEP',2,{optimizerSteps:'1',batches:'1',metrics:[]})),'TJ_ORDER');
  rejects(()=>reduce(p,event('STARTED',2,{}, {runnerId:'other'})),'TJ_ORDER');
  p=reduce(p,event('STARTED',2));p=reduce(p,event('STEP',3,{optimizerSteps:'12',batches:'24',metrics:[]}));
  rejects(()=>reduce(p,event('STEP',4,{optimizerSteps:'11',batches:null,metrics:[]})),'TJ_ORDER');
  p=reduce(p,event('TERMINAL',4,{outcome:'FAILED'}));
  for(const [kind,data] of [['STARTED',{}],['STEP',{optimizerSteps:'13',batches:null,metrics:[]}],['TERMINAL',{outcome:'COMPLETED'}]] as const)
    rejects(()=>reduce(p,event(kind,5,data)),'TJ_TERMINAL');
  p=reduce(p,event('ARTIFACT',5,{artifactDigest:DIGEST,artifactKind:'CHECKPOINT'}));
  p=reduce(p,event('EVALUATION',6,{artifactDigest:DIGEST,policyDigest:DIGEST,result:'UNKNOWN',metrics:[]}));
  p=reduce(p,event('NOTE',7,{relatedEventId:'event-3',code:'CORRECTION_DECLARED',text:'synthetic clarification'}));
  assert.equal(p.state,'FAILED');assert.equal(p.optimizerStepsLowerBound,'12');assert.equal(p.evaluations[DIGEST],'UNKNOWN');
});
test('TJ0 cannot activate from loss or terminal alone, nor rollback the wrong or historical target',()=>{
  let p:AttemptProjection|undefined;for(const raw of trace().slice(0,5))p=reduce(p,raw);
  rejects(()=>reduce(p,event('ACTIVATION',6,{artifactDigest:DIGEST,state:'ACTIVE'})),'TJ_ORDER');
  for(const raw of trace().slice(5,8))p=reduce(p,raw);
  p=reduce(p,event('ARTIFACT',9,{artifactDigest:OTHER_DIGEST,artifactKind:'EXPORT'}));
  for(const state of ['ROLLED_BACK','UNKNOWN'])rejects(()=>reduce(p,event('ACTIVATION',10,{artifactDigest:OTHER_DIGEST,state})),'TJ_ORDER');
  p=reduce(p,event('ACTIVATION',10,{artifactDigest:DIGEST,state:'ROLLED_BACK'}));
  rejects(()=>reduce(p,event('ACTIVATION',11,{artifactDigest:DIGEST,state:'ROLLED_BACK'})),'TJ_ORDER');
});
