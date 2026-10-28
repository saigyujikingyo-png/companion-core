// Read-only legacy pure-graph oracle, copied verbatim from 5b9339a.
// Original corpus-qa-index.ts SHA256: 07eb2817cf120da95363e9897f1ca3cfd941aa10e3b0f1b354c0c0c385184ee8
import { canonical,stop } from '../src/wf1-json.ts';
import type { ScopedIndexEntry } from '../src/corpus-qa-index.ts';
export function legacyScopedAssemblyOracle(entries:ScopedIndexEntry[],expectedDigests:string[]){
  const key=(e:ScopedIndexEntry)=>canonical({jobId:e.sourceJobId,unitId:e.unitId}),family=(e:ScopedIndexEntry)=>canonical({jobId:e.sourceJobId,familyId:e.familyId});if(new Set(entries.map(key)).size!==entries.length)stop('CQA_INDEX_CONFLICT');
  const parents=new Map<string,string>(),first=new Map<string,ScopedIndexEntry>(),duplicates=new Map<string,string>();for(const e of entries)parents.set(family(e),family(e));const root=(v:string):string=>parents.get(v)===v?v:root(parents.get(v)!);
  for(const e of entries)for(const field of ['exactDigest','normalizedDigest','promptDigest'] as const){const k=field+':'+e[field],prior=first.get(k);if(prior){parents.set(root(family(e)),root(family(prior)));if(!duplicates.has(key(e)))duplicates.set(key(e),key(prior));}else first.set(k,e);}
  const splits=new Map<string,Set<string>>();for(const e of entries){const r=root(family(e)),set=splits.get(r)??new Set<string>();set.add(e.split);splits.set(r,set);}
  return {version:'CorpusScopedAssembly/0.1',indexDigests:expectedDigests,comparison:'EXACT_NORMALIZED_PROMPT_ONLY',rows:entries.map(e=>({sourceJobId:e.sourceJobId,unitId:e.unitId,poolId:e.poolId,familyId:e.familyId,split:e.split,rowRef:e.rowRef,rowDigest:e.rowDigest,duplicateOf:duplicates.get(key(e))??null,familyHold:splits.get(root(family(e)))!.size>1,qaDisposition:e.qaDisposition,eligibleForNextExport:e.qaDisposition==='PASS'&&!duplicates.has(key(e))&&splits.get(root(family(e)))!.size===1})),trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'};
}
