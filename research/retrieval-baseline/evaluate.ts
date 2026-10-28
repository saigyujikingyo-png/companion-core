import type { GoldQuery, SyntheticFamily } from './cohort.ts';

export function evaluateOrdinals(family:SyntheticFamily,gold:GoldQuery,ordinals:readonly number[]) {
  const at=(k:number)=>ordinals.slice(0,k);
  const recall=(k:number)=>gold.relevantOrdinals.length
    ?gold.relevantOrdinals.filter(i=>at(k).includes(i)).length/gold.relevantOrdinals.length:null;
  const exactEligible=gold.exactLiteral!==undefined&&family.documents.some(d=>d.statement.includes(gold.exactLiteral!));
  const exact=(k:number)=>gold.exactLiteral===undefined?null:{eligible:exactEligible,
    hits:at(k).filter(i=>family.documents[i]!.statement.includes(gold.exactLiteral!)).length};
  const conflict=(k:number)=>gold.conflictSides?gold.conflictSides.every(i=>at(k).includes(i)):null;
  return {recallAt1:recall(1),recallAt3:recall(3),recallAt8:recall(8),
    unknownNonempty:gold.status==='unknown'?ordinals.length>0:null,
    exactAt1:exact(1),exactAt3:exact(3),exactAt8:exact(8),
    conflictBothAt1:conflict(1),conflictBothAt3:conflict(3),conflictBothAt8:conflict(8),
    distinctRootGroupsAt8:new Set(at(8).map(i=>family.documents[i]!.root)).size};
}

export function summarize(rows:readonly ReturnType<typeof evaluateOrdinals>[]) {
  const fraction=(values:readonly (boolean|null)[])=>{
    const eligible=values.filter(v=>v!==null);return {numerator:eligible.filter(Boolean).length,denominator:eligible.length};
  };
  const mean=(values:readonly (number|null)[])=>{
    const eligible=values.filter(v=>v!==null);return {mean:eligible.length?eligible.reduce((a,b)=>a+b,0)/eligible.length:null,denominator:eligible.length};
  };
  return {recallAt1:mean(rows.map(r=>r.recallAt1)),recallAt3:mean(rows.map(r=>r.recallAt3)),recallAt8:mean(rows.map(r=>r.recallAt8)),
    unknownNonempty:fraction(rows.map(r=>r.unknownNonempty)),
    exactRetentionAt1:fraction(rows.map(r=>r.exactAt1?.eligible?(r.exactAt1.hits>0):null)),
    exactRetentionAt3:fraction(rows.map(r=>r.exactAt3?.eligible?(r.exactAt3.hits>0):null)),
    exactRetentionAt8:fraction(rows.map(r=>r.exactAt8?.eligible?(r.exactAt8.hits>0):null)),
    conflictBothAt1:fraction(rows.map(r=>r.conflictBothAt1)),conflictBothAt3:fraction(rows.map(r=>r.conflictBothAt3)),
    conflictBothAt8:fraction(rows.map(r=>r.conflictBothAt8))};
}
