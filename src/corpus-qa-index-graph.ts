import { canonical,stop } from './wf1-json.ts';
import type { ScopedIndexEntry } from './corpus-qa-index.ts';

/** Internal pure graph kernel. Callers validate and bound complete indexes first.
 * All dispositions participate; only the final export flag consults PASS. */
export function computeScopedIndexRows(entries:readonly ScopedIndexEntry[]){
  const key=(e:ScopedIndexEntry)=>canonical({jobId:e.sourceJobId,unitId:e.unitId});
  const family=(e:ScopedIndexEntry)=>canonical({jobId:e.sourceJobId,familyId:e.familyId});
  if(new Set(entries.map(key)).size!==entries.length)stop('CQA_INDEX_CONFLICT');
  const parents=new Map<string,string>(),first=new Map<string,ScopedIndexEntry>(),duplicates=new Map<string,string>();
  for(const e of entries)parents.set(family(e),family(e));
  const root=(value:string)=>{
    let top=value;
    while(parents.get(top)!==top)top=parents.get(top)!;
    while(value!==top){const next=parents.get(value)!;parents.set(value,top);value=next;}
    return top;
  };
  for(const e of entries)for(const field of ['exactDigest','normalizedDigest','promptDigest'] as const){
    const fingerprint=field+':'+e[field],prior=first.get(fingerprint);
    if(prior){parents.set(root(family(e)),root(family(prior)));if(!duplicates.has(key(e)))duplicates.set(key(e),key(prior));}
    else first.set(fingerprint,e);
  }
  const splits=new Map<string,Set<string>>();
  for(const e of entries){const r=root(family(e)),set=splits.get(r)??new Set<string>();set.add(e.split);splits.set(r,set);}
  return entries.map(e=>({sourceJobId:e.sourceJobId,unitId:e.unitId,poolId:e.poolId,familyId:e.familyId,split:e.split,rowRef:e.rowRef,rowDigest:e.rowDigest,duplicateOf:duplicates.get(key(e))??null,familyHold:splits.get(root(family(e)))!.size>1,qaDisposition:e.qaDisposition,eligibleForNextExport:e.qaDisposition==='PASS'&&!duplicates.has(key(e))&&splits.get(root(family(e)))!.size===1}));
}
