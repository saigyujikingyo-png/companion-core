import { types } from 'node:util';
import { canonical,copyJson,digest,hash,id,integer,shape,stop,unique } from './wf1-json.ts';
import { scopedQa } from './corpus-qa-types.ts';
import { validateScopedDedupIndex } from './corpus-qa-index.ts';
import { computeScopedIndexRows } from './corpus-qa-index-graph.ts';
import type { ScopedDedupIndex } from './corpus-qa-index.ts';
import type { ScopedRef } from './corpus-production-types.ts';
import type { CorpusTokenMeasurement } from './corpus-tokenizer.ts';

export const SYNTHETIC_QA_CATALOG_LIMITS=Object.freeze({sources:64,nodes:12288,appendSources:8,rowsPerSource:192,sourceBytes:1048576,generationBytes:67108864});
export const SYNTHETIC_QA_CATALOG_POLICY_DIGEST=hash(canonical({version:'SyntheticQaCatalogModel/0.1',...SYNTHETIC_QA_CATALOG_LIMITS,scope:'FULL_ADMITTED_INDEX_GRAPH',ordering:'SOURCE_ORDINAL_THEN_INDEX_ORDER',supersession:'UNSUPPORTED',retentionLoss:'COVERAGE_GAP_BLOCKED'}));
const boundary={mode:'SYNTHETIC_PURE_MODEL',authentication:'NOT_AUTHENTICATED',productionUse:'NOT_SUPPORTED',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'} as const;
export type SyntheticCatalogCompatibility={purposeDigest:string;studentTargetDigest:string;tokenizerProfileDigest:string;generationTargetDigest:string;auditTargetDigest:string};
export type SyntheticCatalogMetadata={unitId:string;caseId:string;verdictRef:ScopedRef|null;tokenReceiptRef:ScopedRef;measurement:CorpusTokenMeasurement};
export type SyntheticCatalogSource={version:'SyntheticQaCatalogSource/0.1';kind:'FULL_INDEX';ordinal:number;descriptorDigest:string;auditId:string;indexDigest:string;index:ScopedDedupIndex;metadata:SyntheticCatalogMetadata[];rubricRef:ScopedRef|null;rubricCipherDigest:string|null;compatibility:SyntheticCatalogCompatibility};
export type SyntheticCatalogUpdate={version:'SyntheticQaCatalogUpdate/0.1';expectedParent:string|null;append:SyntheticCatalogSource[];withdrawEligibility:string[];withdrawRetention:string[]};
export type SyntheticCatalogAck={version:'SyntheticQaCatalogAck/0.1';status:'SYNTHETIC_SUCCESS';catalogId:string;candidateDigest:string;expectedParent:string|null};

// Inspect bounded data arrays without invoking accessors, proxies or toJSON.
function array(value:unknown,max:number,min=0):unknown[]{
  if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<min||value.length>max)stop('CQA_CATALOG_LIMIT');
  const keys=Reflect.ownKeys(value);if(keys.length!==value.length+1)stop('CQA_CATALOG_SHAPE');
  const result:unknown[]=[];
  for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))stop('CQA_CATALOG_SHAPE');result.push(d.value);}
  return result;
}
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
function compatible(value:unknown):SyntheticCatalogCompatibility{
  const c=shape(copyJson(value),['purposeDigest','studentTargetDigest','tokenizerProfileDigest','generationTargetDigest','auditTargetDigest']);
  Object.values(c).forEach(digest);return c as SyntheticCatalogCompatibility;
}
function metadata(value:unknown,entry:ScopedDedupIndex['entries'][number],tokenizer:string):SyntheticCatalogMetadata{
  const m=shape(copyJson(value),['unitId','caseId','verdictRef','tokenReceiptRef','measurement']);
  if(id(m.unitId)!==entry.unitId)stop('CQA_CATALOG_MEMBERSHIP');id(m.caseId);scopedQa(m.tokenReceiptRef);if(m.verdictRef!==null)scopedQa(m.verdictRef);
  const t=shape(m.measurement,['version','status','rowDigest','tokenizerProfileDigest','studentInputTokens','studentLossTokens','fullTokens','inputIdsDigest','fullIdsDigest','lossMaskDigest','lossPolicy','officialPipelineParity','actualTrainerParity','trainingReady']);
  if(t.version!=='CorpusTokenMeasurement/0.1'||t.status!=='LOCAL_PINNED_EXACT'||t.rowDigest!==entry.rowDigest||t.tokenizerProfileDigest!==tokenizer||t.lossPolicy!=='ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR'||t.officialPipelineParity!=='NOT_VALIDATED'||t.actualTrainerParity!=='NOT_RUN'||t.trainingReady!==false)stop('CQA_CATALOG_MEASUREMENT');
  for(const k of ['inputIdsDigest','fullIdsDigest','lossMaskDigest'])digest(t[k]);
  const count=(n:unknown)=>{if(typeof n!=='string'||!/^[1-9][0-9]{0,5}$/.test(n)||Number(n)>65536)stop('CQA_CATALOG_MEASUREMENT');return Number(n);};
  if(count(t.studentInputTokens)+count(t.studentLossTokens)!==count(t.fullTokens))stop('CQA_CATALOG_MEASUREMENT');
  return m as SyntheticCatalogMetadata;
}
function source(value:unknown,compatibility:SyntheticCatalogCompatibility):SyntheticCatalogSource{
  const s=shape(value,['version','kind','ordinal','descriptorDigest','auditId','indexDigest','index','metadata','rubricRef','rubricCipherDigest','compatibility']);
  if(s.version!=='SyntheticQaCatalogSource/0.1'||s.kind!=='FULL_INDEX')stop('CQA_CATALOG_FULL_INDEX_REQUIRED');
  integer(s.ordinal,0,63);id(s.auditId);digest(s.descriptorDigest);digest(s.indexDigest);
  const c=compatible(s.compatibility);if(canonical(c)!==canonical(compatibility))stop('CQA_CATALOG_INCOMPATIBLE');
  const raw=shape(s.index,['version','scope','entries']);
  const index=validateScopedDedupIndex({version:raw.version,scope:copyJson(raw.scope),entries:array(raw.entries,192,1).map(copyJson)});
  if(hash(canonical(index))!==s.indexDigest)stop('CQA_CATALOG_INDEX_DIGEST');
  const data=array(s.metadata,192,1);if(data.length!==index.entries.length)stop('CQA_CATALOG_MEMBERSHIP');
  const rows=data.map((m,i)=>metadata(m,index.entries[i]!,compatibility.tokenizerProfileDigest));unique(rows.map(m=>m.caseId));
  const rubricRef=s.rubricRef===null?null:scopedQa(copyJson(s.rubricRef));
  const rubricCipherDigest=s.rubricCipherDigest===null?null:digest(s.rubricCipherDigest);
  if((rubricRef===null)!==(rubricCipherDigest===null)||rubricRef&&rubricRef.ref.digest!==rubricCipherDigest)stop('CQA_CATALOG_RUBRIC');
  const result={version:'SyntheticQaCatalogSource/0.1' as const,kind:'FULL_INDEX' as const,ordinal:Number(s.ordinal),descriptorDigest:String(s.descriptorDigest),auditId:String(s.auditId),indexDigest:String(s.indexDigest),index,metadata:rows,rubricRef,rubricCipherDigest,compatibility:c};
  if(Buffer.byteLength(canonical(result))>SYNTHETIC_QA_CATALOG_LIMITS.sourceBytes)stop('CQA_CATALOG_LIMIT');
  return frozen(result);
}
type RetainedSource={value:SyntheticCatalogSource;exportEligible:boolean;metadataRetained:boolean;nodeIdentityDigest:string};
const nodeKey=(row:{sourceJobId:string;unitId:string})=>canonical({jobId:row.sourceJobId,unitId:row.unitId});
function compute(sources:RetainedSource[]){
  const nodes=sources.flatMap(s=>s.value.index.entries.map((entry,i)=>({...entry,sourceOrdinal:s.value.ordinal,descriptorDigest:s.value.descriptorDigest,auditId:s.value.auditId,metadata:s.value.metadata[i]!})));
  const graphRows=computeScopedIndexRows(nodes);
  const byNode=new Map(nodes.map(node=>[nodeKey(node),node]));
  const eligible=new Set(sources.filter(s=>s.exportEligible).map(s=>s.value.index.scope.sourceJobId));
  const selectedRows=graphRows.filter(r=>r.eligibleForNextExport&&eligible.has(r.sourceJobId)&&byNode.get(nodeKey(r))!.metadata.verdictRef!==null).map(r=>{
    const node=byNode.get(nodeKey(r))!,m=node.metadata;
    return {...r,caseId:m.caseId,verdictRef:m.verdictRef!,descriptorDigest:node.descriptorDigest,auditId:node.auditId,tokenReceiptRef:m.tokenReceiptRef,measurement:m.measurement};
  });
  const tokens=(split:'train'|'dev')=>{const rows=selectedRows.filter(r=>r.split===split);return {rows:rows.length,studentInputTokens:rows.reduce((n,r)=>n+Number(r.measurement.studentInputTokens),0),studentLossTokens:rows.reduce((n,r)=>n+Number(r.measurement.studentLossTokens),0),fullTokens:rows.reduce((n,r)=>n+Number(r.measurement.fullTokens),0)};};
  return {nodes,graphRows,selectedRows,totals:{train:tokens('train'),dev:tokens('dev')},graphDigest:hash(canonical({indexDigests:sources.map(s=>s.value.indexDigest),graphRows})),membershipContentDigest:hash(canonical(selectedRows))};
}
function generation(catalogId:string,compatibility:SyntheticCatalogCompatibility,number:number,parent:string|null,sources:RetainedSource[],events:{withdrawEligibility:string[];withdrawRetention:string[]}){
  const sourceRegistry=sources.map(s=>({ordinal:s.value.ordinal,sourceJobId:s.value.index.scope.sourceJobId,auditId:s.value.auditId,descriptorDigest:s.value.descriptorDigest,indexDigest:s.value.indexDigest,selectionDigest:s.value.index.scope.selectionDigest,populationDigest:s.value.index.scope.populationDigest,nodeIdentityDigest:s.nodeIdentityDigest,rubricRef:s.value.rubricRef,rubricCipherDigest:s.value.rubricCipherDigest,exportEligible:s.exportEligible,metadataRetained:s.metadataRetained}));
  const blocked=sources.some(s=>!s.metadataRetained);
  // No graph computation or full-node projection is performed after declared retention loss.
  const result=blocked?{nodes:[],graphRows:[],selectedRows:[],totals:null,graphDigest:null,membershipContentDigest:null}:compute(sources);
  const fields={version:'SyntheticQaCatalogGeneration/0.1' as const,...boundary,catalogId,generation:number,parentDigest:parent,policyDigest:SYNTHETIC_QA_CATALOG_POLICY_DIGEST,compatibility,status:blocked?'COVERAGE_GAP_BLOCKED' as const:'MODEL_READY' as const,sourceRegistry,events,...result};
  const bytes=canonical(fields);if(Buffer.byteLength(bytes)>SYNTHETIC_QA_CATALOG_LIMITS.generationBytes)stop('CQA_CATALOG_LIMIT');
  return frozen({...fields,digest:hash(bytes)});
}
export type SyntheticCatalogGeneration=ReturnType<typeof generation>;
type ModelMember=ReturnType<typeof compute>['selectedRows'][number];
export type SyntheticDatasetSnapshot={version:'DatasetSnapshot/0.1';type:'MEMBERSHIP_SNAPSHOT';mode:'SYNTHETIC_PURE_MODEL';authentication:'NOT_AUTHENTICATED';productionUse:'NOT_SUPPORTED';trainingReady:false;trainingJobPolicy:'NOT_AUTHORIZED';catalogId:string;generationDigest:string;graphDigest:string;policyDigest:string;members:(ModelMember&{generationDigest:string})[];totals:NonNullable<SyntheticCatalogGeneration['totals']>;digest:string};

/** C0 only: declarations and synthetic ACKs have no authority. No filesystem,
 * archive capability, permission callback, clock, encryption or recovery exists. */
export function createSyntheticQaCatalogModel(input:{catalogId:string;compatibility:SyntheticCatalogCompatibility}){
  const config=shape(input,['catalogId','compatibility']),catalogId=id(config.catalogId),compatibility=frozen(compatible(config.compatibility));
  let current:SyntheticCatalogGeneration|null=null,currentSources:RetainedSource[]=[];
  const candidates=new WeakMap<object,RetainedSource[]>(),snapshots=new WeakSet<object>();
  const prepare=(input:SyntheticCatalogUpdate):SyntheticCatalogGeneration=>{
    const update=shape(input,['version','expectedParent','append','withdrawEligibility','withdrawRetention']);
    if(update.version!=='SyntheticQaCatalogUpdate/0.1')stop('CQA_CATALOG_UPDATE');
    if(update.expectedParent!==null)digest(update.expectedParent);
    if(update.expectedParent!==(current?.digest??null))stop('CQA_CATALOG_PARENT');
    if(current?.status==='COVERAGE_GAP_BLOCKED')stop('CQA_CATALOG_COVERAGE_GAP_BLOCKED');
    const added=array(update.append,8).map(v=>source(v,compatibility));
    const withdrawals=array(update.withdrawEligibility,64).map(id),retention=array(update.withdrawRetention,64).map(id);unique(withdrawals);unique(retention);
    if(!added.length&&!withdrawals.length&&!retention.length)stop('CQA_CATALOG_EMPTY_UPDATE');
    if(currentSources.length+added.length>64)stop('CQA_CATALOG_LIMIT');
    const jobs=new Set(currentSources.map(s=>s.value.index.scope.sourceJobId)),audits=new Set(currentSources.map(s=>s.value.auditId));
    for(const s of added){if(jobs.has(s.index.scope.sourceJobId))stop('CQA_CATALOG_SUPERSESSION_UNSUPPORTED');if(audits.has(s.auditId))stop('CQA_CATALOG_SOURCE_CONFLICT');jobs.add(s.index.scope.sourceJobId);audits.add(s.auditId);}
    added.sort((a,b)=>a.ordinal-b.ordinal);
    if(added.some((s,i)=>s.ordinal!==currentSources.length+i))stop('CQA_CATALOG_SOURCE_ORDER');
    const sources=[...currentSources.map(s=>({...s})),...added.map(value=>({value,exportEligible:true,metadataRetained:true,nodeIdentityDigest:hash(canonical(value.index.entries.map(({qaDisposition,...identity})=>identity)))}))];
    if(sources.reduce((n,s)=>n+s.value.index.entries.length,0)>12288)stop('CQA_CATALOG_LIMIT');
    for(const job of [...withdrawals,...retention])if(!jobs.has(job))stop('CQA_CATALOG_SOURCE_CONFLICT');
    for(const s of sources){const job=s.value.index.scope.sourceJobId;if(withdrawals.includes(job))s.exportEligible=false;if(retention.includes(job))s.metadataRetained=false;}
    const next=generation(catalogId,compatibility,(current?.generation??0)+1,current?.digest??null,sources,{withdrawEligibility:withdrawals,withdrawRetention:retention});
    candidates.set(next,sources);return next;
  };
  const commit=(candidate:SyntheticCatalogGeneration,ack:SyntheticCatalogAck)=>{
    if(!candidate||typeof candidate!=='object'||!candidates.has(candidate))stop('CQA_CATALOG_CANDIDATE');
    const a=shape(copyJson(ack),['version','status','catalogId','candidateDigest','expectedParent']);
    if(a.version!=='SyntheticQaCatalogAck/0.1'||a.status!=='SYNTHETIC_SUCCESS'||a.catalogId!==catalogId||a.candidateDigest!==candidate.digest||a.expectedParent!==candidate.parentDigest)stop('CQA_CATALOG_SYNTHETIC_ACK');
    if(candidate.parentDigest!==(current?.digest??null))stop('CQA_CATALOG_PARENT');
    currentSources=candidates.get(candidate)!;current=candidate;candidates.delete(candidate);
    return frozen({version:'SyntheticQaCatalogCommit/0.1',...boundary,catalogId,generationDigest:candidate.digest,receiptStatus:'SYNTHETIC_ACK_ONLY'} as const);
  };
  const snapshot=():SyntheticDatasetSnapshot=>{
    if(!current)stop('CQA_CATALOG_EMPTY');if(current.status!=='MODEL_READY'||!current.graphDigest||!current.totals)stop('CQA_CATALOG_COVERAGE_GAP_BLOCKED');
    const fields={version:'DatasetSnapshot/0.1' as const,type:'MEMBERSHIP_SNAPSHOT' as const,...boundary,catalogId,generationDigest:current.digest,graphDigest:current.graphDigest,policyDigest:SYNTHETIC_QA_CATALOG_POLICY_DIGEST,members:current.selectedRows.map(row=>({...row,generationDigest:current!.digest})),totals:current.totals};
    const result=frozen({...fields,digest:hash(canonical(fields))});snapshots.add(result);return result;
  };
  const checkSnapshotAgainstCurrent=(snapshot:SyntheticDatasetSnapshot)=>{
    if(!snapshot||typeof snapshot!=='object'||!snapshots.has(snapshot))stop('CQA_CATALOG_SNAPSHOT_BINDING');
    if(!current||current.status!=='MODEL_READY')stop('CQA_CATALOG_COVERAGE_GAP_BLOCKED');
    const selected=new Map(current.selectedRows.map(row=>[nodeKey(row),canonical(row)]));
    for(const {generationDigest,...row} of snapshot.members){if(generationDigest!==snapshot.generationDigest||selected.get(nodeKey(row))!==canonical(row))stop('CQA_CATALOG_SNAPSHOT_INELIGIBLE');}
    return frozen({version:'SyntheticQaCatalogSnapshotCheck/0.1',...boundary,snapshotDigest:snapshot.digest,currentGenerationDigest:current.digest,status:'CURRENT_MODEL_ELIGIBILITY_ONLY'} as const);
  };
  return Object.freeze({prepare,commit,current:()=>current,snapshot,checkSnapshotAgainstCurrent});
}
