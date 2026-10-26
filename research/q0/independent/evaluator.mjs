import assert from 'node:assert/strict';
export const EVALUATOR_VERSION='q0-independent-evaluator-1';
const ATTRS=['color','material','location','mass_g','temperature_c','orientation_deg','capacity_ml','texture','label','crack_mm','serial_tag','dose_mg'];
const KNOWN=ATTRS.slice(0,4),HIDDEN=ATTRS.slice(4),NUMERIC=['mass_g','temperature_c','orientation_deg','capacity_ml','crack_mm','dose_mg'],RARE=['crack_mm','serial_tag','dose_mg'];
export const RULES=Object.freeze({version:EVALUATOR_VERSION,queriesPerFamily:24,groups:{announced:8,unannounced_fields:8,unannounced_composed:8},bootstrapReplicates:2000,confidence:0.95,minimumRarePositiveFamilies:30,mainRareMetric:'joint_exact_detail',addressing:'given_object_event_address; no retrieval or identity-discovery claim',unknown:'intrinsic observed_unknown can match; omission/unsupported/indeterminate always non-exact',comparison:'conservative intervals; all atom witnesses retained, no short-circuit witness removal',pointExact:'scalar and all binding/status witnesses, without tolerance; fidelity recorded separately',heldoutReuse:'after publication this becomes a regression set; tuned successors require new independent heldout',uncertainty:'seed-stratified family percentile bootstrap; zero-width distributions explicitly marked; minimum rare support is not a power proof'});
export function rng(seed){let x=seed>>>0;if(x===0)x=0x6d2b79f5;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
const pick=(random,list)=>list[Math.floor(random()*list.length)];
const stable=(v)=>JSON.stringify(v);
const atom=(event,object,attribute)=>({op:'value',eventId:event.eventId,objectId:object.objectId,attribute});
export function makeQueries(family,seedIndex,familyIndex,querySeed){
  assert.equal(family.events.length,4);assert.equal(family.events[0].objects.length,3);
  const random=rng((querySeed^Math.imul(seedIndex+1,0x9e3779b9)^Math.imul(familyIndex+1,0x85ebca6b))>>>0);
  const events=[...family.events].sort((a,b)=>a.timeTick-b.timeTick),out=[];
  const draw=(attr)=>{const event=pick(random,events);return atom(event,pick(random,event.objects),attr);};
  const temporal=(attr)=>{const a=Math.floor(random()*3),b=a+1+Math.floor(random()*(3-a)),object=pick(random,events[a].objects);
    assert(events[b].objects.some(x=>x.objectId===object.objectId));return{before:atom(events[a],object,attr),after:atom(events[b],object,attr)};};
  const relation=()=>{const event=pick(random,events);assert(event.relations.length>0);const r=pick(random,event.relations);
    return{op:'relation',eventId:event.eventId,subjectId:r.subjectId,predicate:r.predicate,objectId:r.objectId};};
  const comparison=()=>{const attr=pick(random,ATTRS),left=draw(attr),donor=draw(attr),numeric=NUMERIC.includes(attr);
    const event=events.find(e=>e.eventId===donor.eventId),object=event.objects.find(o=>o.objectId===donor.objectId),cell=object.attrs[attr];
    const literal=cell.status==='observed_value'?cell.value:(numeric?0:'q0-unmatched');
    return{op:'compare',cmp:pick(random,numeric?['eq','ne','lt','le','gt','ge']:['eq','ne']),left,right:{literal}};};
  const add=(group,expr)=>out.push({id:group+':'+out.length,group,expr});
  for(const attr of KNOWN){add('announced',draw(attr));add('announced',{op:'changed',...temporal(attr)});}
  for(const attr of HIDDEN)add('unannounced_fields',draw(attr));
  add('unannounced_composed',{op:'changed',...temporal(pick(random,HIDDEN))});
  add('unannounced_composed',{op:'delta',...temporal(pick(random,NUMERIC))});
  add('unannounced_composed',comparison());
  {const attr=pick(random,ATTRS);add('unannounced_composed',{op:'compare',cmp:pick(random,NUMERIC.includes(attr)?['eq','ne','lt','le','gt','ge']:['eq','ne']),left:draw(attr),right:draw(attr)});}
  add('unannounced_composed',relation());
  add('unannounced_composed',{op:'and',args:[relation(),comparison()]});
  add('unannounced_composed',{op:'or',args:[{op:'changed',...temporal(pick(random,HIDDEN))},relation()]});
  add('unannounced_composed',{op:'not',arg:{op:'and',args:[relation(),comparison()]}});
  assert.equal(out.length,24);return out;
}
function cellResult(cell,witness){
  const witnesses=[{...witness,status:cell?.status??'missing'}];
  if(!cell)return{status:'missing',witnesses};
  if(cell.status==='observed_unknown'||cell.status==='omitted')return{status:cell.status,witnesses};
  if(cell.status!=='observed_value')return{status:'unsupported',witnesses};
  const value=cell.value;
  if(!(value===null||['boolean','string','number'].includes(typeof value))||(typeof value==='number'&&!Number.isFinite(value)))return{status:'unsupported',witnesses};
  if(cell.fidelity==='exact'&&cell.maxAbsError===0)return{status:'value',value,witnesses,interval:typeof value==='number'?[value,value]:null,quantized:false};
  if(cell.fidelity==='quantized'&&typeof value==='number'&&Number.isFinite(cell.maxAbsError)&&cell.maxAbsError>0){
    const interval=[value-cell.maxAbsError,value+cell.maxAbsError];
    if(interval.every(Number.isFinite))return{status:'value',value,witnesses,interval,quantized:true};
  }return{status:'unsupported',witnesses};
}
function lookup(family,q){
  const event=family?.events?.find(e=>e.eventId===q.eventId);
  const base={logicalSchema:family?.logicalSchema??null,namespace:family?.namespace??null,familyId:family?.familyId??null,eventId:event?.eventId??null,timeTick:event?.timeTick??null};
  if(q.op==='value'){const object=event?.objects?.find(o=>o.objectId===q.objectId);
    return cellResult(object?.attrs?.[q.attribute],{...base,objectId:object?.objectId??null,trackId:object?.trackId??null,conceptId:object?.conceptId??null,attribute:q.attribute,sourceRef:object?.sourceRef??null});}
  const relation=event?.relations?.find(r=>r.subjectId===q.subjectId&&r.predicate===q.predicate&&r.objectId===q.objectId);
  return cellResult(relation,{...base,subjectId:relation?.subjectId??null,predicate:relation?.predicate??null,objectId:relation?.objectId??null,sourceRef:relation?.sourceRef??null});
}
const reasons=['unsupported','missing','omitted','observed_unknown','indeterminate'];
function unavailable(args,witnesses){return{status:reasons.find(s=>args.some(a=>a.status===s))??'indeterminate',witnesses};}
function compare(a,b,cmp,witnesses){
  if(a.status!=='value'||b.status!=='value')return unavailable([a,b],witnesses);
  const finish=(value)=>({status:'value',value,witnesses,quantized:a.quantized||b.quantized});
  const uncertain=()=>({status:'indeterminate',witnesses,quantized:a.quantized||b.quantized});
  if(cmp==='eq'||cmp==='ne'){
    let eq;
    if(a.interval&&b.interval){const [al,ah]=a.interval,[bl,bh]=b.interval;
      if(ah<bl||bh<al)eq=false;else if(al===ah&&bl===bh)eq=al===bl;else return uncertain();
    }else if(a.interval||b.interval){eq=false;}else eq=Object.is(a.value,b.value);
    return finish(cmp==='eq'?eq:!eq);
  }
  if(!a.interval||!b.interval)return{status:'unsupported',witnesses};
  const[al,ah]=a.interval,[bl,bh]=b.interval;let yes,no;
  if(cmp==='lt'){yes=ah<bl;no=al>=bh;}else if(cmp==='le'){yes=ah<=bl;no=al>bh;}
  else if(cmp==='gt'){yes=al>bh;no=ah<=bl;}else if(cmp==='ge'){yes=al>=bh;no=ah<bl;}
  else return{status:'unsupported',witnesses};
  return yes?finish(true):no?finish(false):uncertain();
}
export function answer(family,q){
  if(q.op==='value'||q.op==='relation')return lookup(family,q);
  if(q.op==='compare'){const a=answer(family,q.left),b=Object.hasOwn(q.right,'literal')?{status:'value',value:q.right.literal,witnesses:[],interval:typeof q.right.literal==='number'?[q.right.literal,q.right.literal]:null,quantized:false}:answer(family,q.right);
    return compare(a,b,q.cmp,[...a.witnesses,...b.witnesses]);}
  if(q.op==='changed'||q.op==='delta'){const a=answer(family,q.before),b=answer(family,q.after),witnesses=[...a.witnesses,...b.witnesses];
    if(q.op==='changed')return compare(a,b,'ne',witnesses);
    if(a.status!=='value'||b.status!=='value')return unavailable([a,b],witnesses);
    if(!a.interval||!b.interval)return{status:'unsupported',witnesses};
    return{status:'value',value:b.value-a.value,interval:[b.interval[0]-a.interval[1],b.interval[1]-a.interval[0]],quantized:a.quantized||b.quantized,witnesses};
  }
  if(q.op==='not'){const a=answer(family,q.arg);return a.status!=='value'?a:typeof a.value==='boolean'?{...a,value:!a.value}:{status:'unsupported',witnesses:a.witnesses};}
  if(q.op==='and'||q.op==='or'){const args=q.args.map(x=>answer(family,x)),witnesses=args.flatMap(x=>x.witnesses);
    if(args.some(a=>a.status==='value'&&typeof a.value!=='boolean'))return{status:'unsupported',witnesses};
    const decisive=q.op==='and'?false:true;
    if(args.some(a=>a.status==='value'&&a.value===decisive))return{status:'value',value:decisive,witnesses};
    if(args.every(a=>a.status==='value'))return{status:'value',value:!decisive,witnesses};
    return unavailable(args,witnesses);
  }return{status:'unsupported',witnesses:[]};
}
function jointExact(expected,got){
  if(stable(expected.witnesses)!==stable(got.witnesses))return false;
  if(expected.status==='observed_unknown')return got.status==='observed_unknown';
  return expected.status==='value'&&got.status==='value'&&Object.is(expected.value,got.value);
}
const counter=()=>({total:0,exact:0,answerable:0,answered:0,intrinsicUnknown:0,unsupportedAssertion:0,bindingWrong:0,omitted:0,observed_unknown:0,missing:0,unsupported:0,indeterminate:0,quantized:0});
const rareCounter=()=>({truthPositive:0,truthNegative:0,truthUnknown:0,predictedPositive:0,detailTP:0,presenceTP:0,negativeFP:0,unknownAsserted:0,positiveFamily:0});
function positive(a,attr){
  if(a.status!=='value')return null;
  if(attr==='serial_tag')return a.value!==null;
  if(!a.interval)return null;
  if(a.interval[0]>0)return true;if(a.interval[1]<=0)return false;return null;
}
export function scoreFamily(raw,decoded,queries){
  const groups={announced:counter(),unannounced_fields:counter(),unannounced_composed:counter(),unannounced_all:counter(),all:counter()},rare=Object.fromEntries(RARE.map(a=>[a,rareCounter()]));
  const detail={anchorCells:0,anchorExact:0,anchorValueExact:0,bindings:0,bindingErrors:0,unknownCells:0,fabricatedUnknown:0,unknownLost:0,quantizedNumeric:0,quantizedErrorBoundViolations:0};
  for(const query of queries){
    const e=answer(raw,query.expr),g=answer(decoded,query.expr);
    assert(!['missing','omitted','unsupported','indeterminate'].includes(e.status),'raw oracle encountered unsupported input/query');
    for(const group of [groups.all,groups[query.group],...(query.group.startsWith('unannounced')?[groups.unannounced_all]:[])]){
      group.total++;group.exact+=+jointExact(e,g);group.answerable+=+(e.status==='value');group.answered+=+(g.status==='value');
      group.intrinsicUnknown+=+(e.status==='observed_unknown');group.unsupportedAssertion+=+(e.status==='observed_unknown'&&g.status==='value');
      group.bindingWrong+=+(g.status==='value'&&stable(e.witnesses.map(({status,...w})=>w))!==stable(g.witnesses.map(({status,...w})=>w)));
      if(Object.hasOwn(group,g.status)&&!['total','exact'].includes(g.status))group[g.status]++;
      group.quantized+=+!!g.quantized;
    }
  }
  for(const event of raw.events){
    for(const object of event.objects)for(const attr of ATTRS){
      const q=atom(event,object,attr),e=answer(raw,q),g=answer(decoded,q);
      detail.bindings++;detail.bindingErrors+=+(stable(e.witnesses.map(({status,...w})=>w))!==stable(g.witnesses.map(({status,...w})=>w)));
      if(e.status==='observed_unknown'){detail.unknownCells++;detail.fabricatedUnknown+=+(g.status==='value');detail.unknownLost+=+(g.status!=='observed_unknown');}
      if(g.quantized&&e.status==='value'&&typeof e.value==='number'){
        detail.quantizedNumeric++;detail.quantizedErrorBoundViolations+=+(e.value<g.interval[0]||e.value>g.interval[1]);
      }
      if(RARE.includes(attr)){
        detail.anchorCells++;detail.anchorValueExact+=+jointExact(e,g);detail.anchorExact+=+(jointExact(e,g)&&!g.quantized);
        const c=rare[attr],ep=positive(e,attr),gp=positive(g,attr),bound=stable(e.witnesses)===stable(g.witnesses);
        if(ep===true){c.truthPositive++;c.positiveFamily=1;}else if(ep===false)c.truthNegative++;else c.truthUnknown++;
        if(gp===true){c.predictedPositive++;c.detailTP+=+(ep===true&&jointExact(e,g));c.presenceTP+=+(ep===true&&bound);c.negativeFP+=+(ep===false);c.unknownAsserted+=+(ep===null);}
      }
    }
    for(const relation of event.relations){
      const q={op:'relation',eventId:event.eventId,subjectId:relation.subjectId,predicate:relation.predicate,objectId:relation.objectId},e=answer(raw,q),g=answer(decoded,q);
      detail.bindings++;detail.bindingErrors+=+(stable(e.witnesses.map(({status,...w})=>w))!==stable(g.witnesses.map(({status,...w})=>w)));
      if(e.status==='observed_unknown'){detail.unknownCells++;detail.fabricatedUnknown+=+(g.status==='value');detail.unknownLost+=+(g.status!=='observed_unknown');}
    }
  }
  return{groups,rare,detail};
}
const ratio=(num,den)=>den===0?null:num/den;
function summed(values){const out={};for(const v of values)for(const[k,n]of Object.entries(v))out[k]=(out[k]??0)+n;return out;}
function deriveRare(c){return{...c,detailPrecision:ratio(c.detailTP,c.predictedPositive),detailRecall:ratio(c.detailTP,c.truthPositive),presencePrecision:ratio(c.presenceTP,c.predictedPositive),presenceRecall:ratio(c.presenceTP,c.truthPositive),minimumSupportMet:c.positiveFamily>=30};}
export function aggregate(scores){
  const groups=Object.fromEntries(Object.keys(scores[0].groups).map(k=>{const c=summed(scores.map(s=>s.groups[k]));return[k,{...c,exactRate:ratio(c.exact,c.total),coverage:ratio(c.answered,c.total)}];}));
  const rare=Object.fromEntries(RARE.map(k=>[k,deriveRare(summed(scores.map(s=>s.rare[k])))]));
  const pooled=summed(scores.flatMap(s=>RARE.map(k=>s.rare[k])));pooled.positiveFamily=scores.filter(s=>RARE.some(k=>s.rare[k].positiveFamily)).length;
  return{families:scores.length,groups,rare:{...rare,pooled:deriveRare(pooled)},detail:summed(scores.map(s=>s.detail))};
}
const percentile=(sorted,p)=>sorted[Math.min(sorted.length-1,Math.floor(p*(sorted.length-1)))];
export function pairedIntervals(rows,baselineMethod,bootstrapSeed,replicates=2000){
  const methods=Object.keys(rows[0].methods),strata=[...new Set(rows.map(r=>r.seedIndex))].map(seed=>rows.filter(r=>r.seedIndex===seed));
  const metrics=[...['announced','unannounced_fields','unannounced_composed','unannounced_all'].map(g=>({name:'exact:'+g,num:s=>s.groups[g].exact,den:s=>s.groups[g].total})),
    ...RARE.flatMap(a=>[{name:'rareDetailPrecision:'+a,num:s=>s.rare[a].detailTP,den:s=>s.rare[a].predictedPositive},{name:'rareDetailRecall:'+a,num:s=>s.rare[a].detailTP,den:s=>s.rare[a].truthPositive}])];
  const random=rng(bootstrapSeed),draws=Object.fromEntries(methods.map(m=>[m,Object.fromEntries(metrics.map(x=>[x.name,[]]))]));
  for(let b=0;b<replicates;b++){
    const indices=strata.flatMap(stratum=>Array.from({length:stratum.length},()=>stratum[Math.floor(random()*stratum.length)]));
    for(const method of methods)for(const metric of metrics){let n=0,d=0,bn=0,bd=0;
      for(const row of indices){const s=row.methods[method],ref=row.methods[baselineMethod];n+=metric.num(s);d+=metric.den(s);bn+=metric.num(ref);bd+=metric.den(ref);}
      if(d&&bd)draws[method][metric.name].push(n/d-bn/bd);
    }
  }
  return Object.fromEntries(methods.map(method=>[method,Object.fromEntries(metrics.map(metric=>{
    const values=draws[method][metric.name].sort((a,b)=>a-b),defined=values.length===replicates;
    return[metric.name,{replicates,definedReplicates:values.length,lower95:defined?percentile(values,.025):null,upper95:defined?percentile(values,.975):null,
      degenerate:defined&&values[0]===values.at(-1),interpretation:!defined?'INCONCLUSIVE_UNDEFINED_DENOMINATOR':values[0]===values.at(-1)?'DEGENERATE_EMPIRICAL_BOOTSTRAP_NOT_ZERO_FUTURE_RISK':'CONDITIONAL_FROZEN_SYNTHETIC_FAMILY_DISTRIBUTION'}];
  }))]));
}
