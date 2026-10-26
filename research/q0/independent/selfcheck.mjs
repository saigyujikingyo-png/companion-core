import assert from 'node:assert/strict';
import {answer,makeQueries,scoreFamily,aggregate,pairedIntervals} from './evaluator.mjs';
const attrs=['color','material','location','mass_g','temperature_c','orientation_deg','capacity_ml','texture','label','crack_mm','serial_tag','dose_mg'];
const numeric=new Set(['mass_g','temperature_c','orientation_deg','capacity_ml','crack_mm','dose_mg']);
const cell=value=>({status:'observed_value',value,fidelity:'exact',maxAbsError:0});
const family={logicalSchema:'q0-scene-1',namespace:'q0-synthetic',familyId:'SELFTEST_ONLY',domain:'desk',events:[]};
for(let e=0;e<4;e++){const objects=[];for(let o=0;o<3;o++){
const a=Object.fromEntries(attrs.map(k=>[k,cell(numeric.has(k)?(k==='crack_mm'||k==='dose_mg'?0:100+e+o/4):k==='serial_tag'?null:k+'-'+o)]));
if(o===0){a.crack_mm=cell(1.25);a.dose_mg=cell(.5);a.serial_tag=cell('rare-selftest');}
if(o===1&&e===1)a.label={status:'observed_unknown'};
objects.push({objectId:'o'+o,trackId:'t'+o,conceptId:['vessel','tool','container'][o],sourceRef:'s'+e+o,attrs:a});}
family.events.push({eventId:'e'+e,timeTick:e*10,objects,relations:[{subjectId:'o0',predicate:'left_of',objectId:'o1',sourceRef:'r'+e,...cell(e%2===0)},{subjectId:'o1',predicate:'near',objectId:'o2',sourceRef:'u'+e,status:'observed_unknown'}]});}
const v=(eventId,objectId,attribute)=>({op:'value',eventId,objectId,attribute});
const tests=[];function check(name,run){run();tests.push(name);console.log('PASS '+name);}
check('point scalar and exact source binding',()=>{const r=answer(family,v('e2','o1','mass_g'));assert.equal(r.value,102.25);assert.equal(r.witnesses[0].sourceRef,'s21');assert.equal(r.witnesses[0].timeTick,20);});
check('changed and delta use separate event versions',()=>{const before=v('e0','o1','mass_g'),after=v('e3','o1','mass_g');assert.equal(answer(family,{op:'changed',before,after}).value,true);assert.equal(answer(family,{op:'delta',before,after}).value,3);});
check('unknown and omission remain distinct',()=>{const q=v('e1','o1','label'),changed=structuredClone(family);changed.events[1].objects[1].attrs.label={status:'omitted'};assert.equal(answer(family,q).status,'observed_unknown');assert.equal(answer(changed,q).status,'omitted');const s=scoreFamily(family,changed,[{id:'x',group:'unannounced_fields',expr:q}]);assert.equal(s.groups.all.exact,0);});
check('interval threshold is indeterminate and endpoints are conservative',()=>{const f=structuredClone(family);f.events[0].objects[0].attrs.mass_g={status:'observed_value',value:100,fidelity:'quantized',maxAbsError:2};
const q=cmp=>({op:'compare',cmp,left:v('e0','o0','mass_g'),right:{literal:100}});assert.equal(answer(f,q('gt')).status,'indeterminate');assert.equal(answer(f,{...q('lt'),right:{literal:103}}).value,true);assert.equal(answer(f,{...q('ge'),right:{literal:98}}).value,true);});
check('quantized equality is not asserted from matching centers',()=>{const f=structuredClone(family);f.events[0].objects[0].attrs.mass_g={status:'observed_value',value:100,fidelity:'quantized',maxAbsError:2};assert.equal(answer(f,{op:'compare',cmp:'eq',left:v('e0','o0','mass_g'),right:{literal:100}}).status,'indeterminate');});
check('Kleene Boolean answer retains both atom witnesses',()=>{const q={op:'and',args:[{op:'relation',eventId:'e1',subjectId:'o0',predicate:'left_of',objectId:'o1'},{op:'relation',eventId:'e1',subjectId:'o1',predicate:'near',objectId:'o2'}]},a=answer(family,q);assert.equal(a.value,false);assert.equal(a.witnesses.length,2);});
check('wrong source or time cannot pass point exact',()=>{const q=[{id:'x',group:'announced',expr:v('e0','o0','mass_g')}];for(const field of ['source','time']){const f=structuredClone(family);if(field==='source')f.events[0].objects[0].sourceRef='WRONG';else f.events[0].timeTick=999;assert.equal(scoreFamily(family,f,q).groups.all.exact,0);}});
check('rare detail and presence metrics differ on wrong magnitude',()=>{const f=structuredClone(family);f.events[0].objects[0].attrs.crack_mm=cell(1.5);const s=scoreFamily(family,f,[]);assert.equal(s.rare.crack_mm.truthPositive,4);assert.equal(s.rare.crack_mm.detailTP,3);assert.equal(s.rare.crack_mm.presenceTP,4);assert.equal(s.detail.anchorExact,s.detail.anchorCells-1);});
check('unsupported value from intrinsic unknown is counted',()=>{const f=structuredClone(family);f.events[1].objects[1].attrs.label=cell('invented');const s=scoreFamily(family,f,[]);assert.equal(s.detail.fabricatedUnknown,1);});
check('seeded sampler repeats exactly and obeys expression bounds',()=>{const a=makeQueries(family,0,0,123),b=makeQueries(family,0,0,123);assert.deepEqual(a,b);assert.equal(a.length,24);
const measure=(q)=>{const kids=q.op==='compare'?[q.left,...(q.right.op?[q.right]:[])]:q.op==='changed'||q.op==='delta'?[q.before,q.after]:q.op==='and'||q.op==='or'?q.args:q.op==='not'?[q.arg]:[];const parts=kids.map(measure);return{nodes:1+parts.reduce((n,x)=>n+x.nodes,0),depth:1+Math.max(0,...parts.map(x=>x.depth))};};
for(const q of a){const m=measure(q.expr);assert(m.nodes<=15&&m.depth<=4);}
const score=scoreFamily(family,family,a);assert.equal(score.groups.all.exact,24);assert.equal(score.groups.announced.total,8);});
check('undefined rare precision remains null',()=>{const f=structuredClone(family);for(const e of f.events)for(const o of e.objects)for(const a of ['crack_mm','dose_mg','serial_tag'])o.attrs[a]={status:'omitted'};assert.equal(aggregate([scoreFamily(family,f,[])]).rare.crack_mm.detailPrecision,null);});
check('family bootstrap reports degenerate empirical interval honestly',()=>{const score=scoreFamily(family,family,makeQueries(family,0,0,123));const rows=[0,1,2].map(seedIndex=>({seedIndex,methods:{BASE:score,IDENTICAL:score}}));const r=pairedIntervals(rows,'BASE',456,20);assert.equal(r.IDENTICAL['exact:announced'].lower95,0);assert.equal(r.IDENTICAL['exact:announced'].degenerate,true);assert.match(r.IDENTICAL['exact:announced'].interpretation,/NOT_ZERO_FUTURE_RISK/);});
console.log(JSON.stringify({stage:'EVALUATOR_PRECOMMIT_SELFCHECK_ONLY',passed:tests.length,failed:0,formalRun:'NOT_STARTED',authorCodecImported:false,heldoutGenerated:false}));
