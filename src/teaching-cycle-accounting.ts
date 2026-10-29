import { canonical,copyJson,digest,hash,id,integer,oneOf,shape,stop } from './wf1-json.ts';
import { corpusResponseDisposition } from './corpus-response-policy.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import type { Provider,ProviderResult } from './wf1-types.ts';
import type { ProductionState } from './corpus-production-types.ts';
import type { AuditState } from './corpus-qa-types.ts';

export type CycleUsage={total:number;reported:number;unreported:number;invalid:number;unavailable:number;remoteUnknown:number;pending:number;known429:number;knownInputTokens:number;knownCompletionTokens:number;inputTokens:number|null;completionTokens:number|null};
export type ChildAccounting={version:'TeachingChildAccounting/0.1';kind:'PRODUCTION'|'QA';childId:string;jobId:string;specDigest:string;stateDigest:string;committedHead:string;ledgerDigest:string;attemptsDigest:string;usage:CycleUsage;items:{total:number;accepted:number;rejected:number;held:number;pending:number};evidence:'FROZEN_DERIVATION_OF_VERIFIED_CHILD_STATE'};
type AttemptView={id:string;operation:string;provider:Provider;bucket:string;settledAtMs:number|null;result:ProviderResult|null};
function usage(attempts:AttemptView[],port:(bucket:string)=>ArtifactPort){
  const out:CycleUsage={total:attempts.length,reported:0,unreported:0,invalid:0,unavailable:0,remoteUnknown:0,pending:0,known429:0,knownInputTokens:0,knownCompletionTokens:0,inputTokens:null,completionTokens:null};
  const rows=attempts.map(a=>{
    const r=a.result,d=corpusResponseDisposition(r,a.provider,port(a.bucket));if(d.kind==='FENCE')stop('TC_ACCOUNTING_SOURCE');
    if(a.settledAtMs===null)out.pending++;
    if(!r||r.outcome==='SUBMIT_UNKNOWN')out.remoteUnknown++;
    if(r?.httpStatus===429)out.known429++;
    let status:'REPORTED'|'UNREPORTED'|'INVALID'|'UNAVAILABLE';
    const u=r?.usage,range=(n:number,max:number)=>Number.isSafeInteger(n)&&n>=0&&n<=max,validUsage=u!==null&&u!==undefined&&range(u.input,66048)&&range(u.completion,16384)&&(u.reasoning===null||range(u.reasoning,u.completion));
    // Parsing can succeed while policy rejects a correctly shaped but oversized
    // count. Preserve that isolation rather than throwing during aggregation.
    if(d.kind==='ISOLATE'&&d.code==='USAGE_INVALID'||u!==null&&u!==undefined&&!validUsage||r&&['INVALID_FIELDS','INVALID_NUMBER','TOTAL_MISMATCH','REASONING_RANGE'].includes(r.usageParseCode??'')){status='INVALID';out.invalid++;}
    else if(u!==null&&u!==undefined&&validUsage&&r!.usageParseCode==='VALID'){
      status='REPORTED';out.reported++;out.knownInputTokens=integer(out.knownInputTokens+u.input);out.knownCompletionTokens=integer(out.knownCompletionTokens+u.completion);
    }else if(d.kind==='CONTENT'&&d.usageStatus==='UNREPORTED'){status='UNREPORTED';out.unreported++;}
    else{status='UNAVAILABLE';out.unavailable++;}
    return {id:a.id,operation:a.operation,provider:a.provider,settledAtMs:a.settledAtMs,status,result:r};
  });
  if(out.reported===out.total){out.inputTokens=out.knownInputTokens;out.completionTokens=out.knownCompletionTokens;}
  return {usage:out,attemptsDigest:hash(canonical(rows))};
}
export function deriveChildAccounting(childId:string,state:ProductionState|AuditState,binding:{committedHead:string;ledgerDigest:string},port:(bucket:string)=>ArtifactPort):ChildAccounting{
  const production='jobId' in state.spec,attempts:AttemptView[]=state.attempts.map(a=>({...a,provider:production?'deepseek':a.operation==='rubric'?'deepseek':'together'}));
  const items=production?(state as ProductionState).items:(state as AuditState).items;
  return validateChildAccounting({version:'TeachingChildAccounting/0.1',kind:production?'PRODUCTION':'QA',childId,jobId:production?(state as ProductionState).spec.jobId:(state as AuditState).spec.auditId,specDigest:hash(canonical(state.spec)),stateDigest:hash(canonical(state)),...binding,...usage(attempts,port),items:{total:items.length,accepted:items.filter(i=>['ACCEPTED','PASS'].includes(i.status)).length,rejected:items.filter(i=>['QUARANTINED','REJECT'].includes(i.status)).length,held:items.filter(i=>['HOLD','UNCERTAIN'].includes(i.status)).length,pending:items.filter(i=>['PLANNED','CANDIDATE','PENDING'].includes(i.status)).length},evidence:'FROZEN_DERIVATION_OF_VERIFIED_CHILD_STATE'});
}
export function validateChildAccounting(input:unknown):ChildAccounting{
  const a=shape(copyJson(input),['version','kind','childId','jobId','specDigest','stateDigest','committedHead','ledgerDigest','attemptsDigest','usage','items','evidence']);
  if(a.version!=='TeachingChildAccounting/0.1'||a.evidence!=='FROZEN_DERIVATION_OF_VERIFIED_CHILD_STATE')stop('TC_ACCOUNTING');oneOf(a.kind,['PRODUCTION','QA']);id(a.childId);id(a.jobId);for(const k of ['specDigest','stateDigest','committedHead','ledgerDigest','attemptsDigest'])digest(a[k]);
  const u=shape(a.usage,['total','reported','unreported','invalid','unavailable','remoteUnknown','pending','known429','knownInputTokens','knownCompletionTokens','inputTokens','completionTokens']);for(const [k,v]of Object.entries(u))if(!['inputTokens','completionTokens'].includes(k))integer(v);
  if(Number(u.reported)+Number(u.unreported)+Number(u.invalid)+Number(u.unavailable)!==u.total||['remoteUnknown','pending','known429'].some(k=>Number(u[k])>Number(u.total)))stop('TC_ACCOUNTING');
  for(const [total,known]of [['inputTokens','knownInputTokens'],['completionTokens','knownCompletionTokens']] as const)if(u.reported===u.total?u[total]!==u[known]:u[total]!==null)stop('TC_ACCOUNTING');
  const items=shape(a.items,['total','accepted','rejected','held','pending']);for(const v of Object.values(items))integer(v);if(Number(items.accepted)+Number(items.rejected)+Number(items.held)+Number(items.pending)!==items.total)stop('TC_ACCOUNTING');return a as ChildAccounting;
}
export function sumCycleUsage(values:CycleUsage[]):CycleUsage{
  const out:CycleUsage={total:0,reported:0,unreported:0,invalid:0,unavailable:0,remoteUnknown:0,pending:0,known429:0,knownInputTokens:0,knownCompletionTokens:0,inputTokens:null,completionTokens:null};
  for(const v of values)for(const k of ['total','reported','unreported','invalid','unavailable','remoteUnknown','pending','known429','knownInputTokens','knownCompletionTokens'] as const)out[k]=integer(out[k]+v[k]);
  if(out.reported===out.total){out.inputTokens=out.knownInputTokens;out.completionTokens=out.knownCompletionTokens;}return out;
}
