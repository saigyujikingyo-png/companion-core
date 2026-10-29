import { canonical,copyJson,digest,hash,id,integer,list,oneOf,shape,stop } from './wf1-json.ts';
import type { ScopedRef } from './corpus-production-types.ts';
import type { CorpusExecutionRequest } from './corpus-execution.ts';
export const TEACHING_CYCLE_PROFILE=hash(canonical({version:'TeachingCycle/0.1',plan:'SYNTHETIC_PLAN',childPolicy:'EXPLICIT_V2',index:'FULL_QA_DISPOSITIONS',money:'ACCOUNTING_ONLY',replay:'NEVER',localReclaim:'TRUSTED_EXACT_OWNER_EXIT',remoteUnknown:'RETAINED'}));
export type CycleChild={childId:string;microRound:number;shard:number;plannedUnits:number;productionSpecDigest:string};
export type CurriculumPlan={version:'TeachingCurriculumPlan/0.1';qualification:'SYNTHETIC_PLAN';children:CycleChild[]};
export type CycleResources={activeChildren:number;maxChildren:number;maxEvents:number;maxLedgerBytes:number;maxIndexedRows:number;maxIndexBytes:number;localSlots:number;bufferBytes:number;accounts:{provider:'deepseek'|'together';accountRef:string;localSlots:number}[]};
export type TeachingCycleSpec={version:'TeachingCycle/0.1';cycleId:string;profileDigest:string;buildDigest:string;planDigest:string;storageBindingDigest:string;authorityRevision:number;runtimeId:string;createdAt:number;expiresAt:number;resources:CycleResources};
export type ProcessIdentity={pid:number;birthId:string};
export type CycleOwner={epoch:string;process:ProcessIdentity;workers:ProcessIdentity[]};
export type ResourceLease={id:string;childId:string;request:CorpusExecutionRequest;owner:CycleOwner;acquiredAt:number;local:'HELD'|'RELEASED'|'RECLAIMED';remote:'RESERVED'|'CONSUMED'|'SETTLED'|'UNKNOWN'};
export type ChildStage='PENDING'|'PRODUCTION'|'TOKENS'|'QA'|'INDEX'|'COMPLETE'|'FAILED';
export type ChildState=CycleChild & {stage:ChildStage;selectionRef:ScopedRef|null;auditSpecDigest:string|null;indexRef:ScopedRef|null;descriptorRef:ScopedRef|null;indexDigest:string|null;code:string|null};
export type TeachingCycleState={version:'TeachingCycleState/0.1';spec:TeachingCycleSpec;plan:CurriculumPlan;status:'ACTIVE'|'COMPLETE';microRound:number;children:ChildState[];leases:ResourceLease[];cooldowns:{provider:string;accountRef:string;until:number|null}[];barriers:{microRound:number;assemblyDigest:string;indexDigests:string[]}[]};
export type CycleEvent={version:'TeachingCycleEvent/0.1';kind:'INIT'|'STAGE'|'BIND_AUDIT'|'LEASE'|'CONSUMED'|'SETTLED'|'ABANDON'|'LOCAL_RECLAIM'|'BARRIER';data:unknown};
export const cycleAuditId=(cycleId:string,childId:string)=>'tc-qa-'+hash(canonical({cycleId:id(cycleId),childId:id(childId)}));
export function validateCycleSpec(input:unknown):TeachingCycleSpec{
  const s=shape(copyJson(input),['version','cycleId','profileDigest','buildDigest','planDigest','storageBindingDigest','authorityRevision','runtimeId','createdAt','expiresAt','resources']);
  if(s.version!=='TeachingCycle/0.1'||s.profileDigest!==TEACHING_CYCLE_PROFILE)stop('TC_PROFILE');id(s.cycleId);id(s.runtimeId);for(const k of ['buildDigest','planDigest','storageBindingDigest'])digest(s[k]);integer(s.authorityRevision,1);integer(s.createdAt);integer(s.expiresAt,Number(s.createdAt)+1);
  const r=shape(s.resources,['activeChildren','maxChildren','maxEvents','maxLedgerBytes','maxIndexedRows','maxIndexBytes','localSlots','bufferBytes','accounts']);for(const k of ['activeChildren','maxChildren','maxEvents','maxLedgerBytes','maxIndexedRows','maxIndexBytes','localSlots','bufferBytes'])integer(r[k],1);if(Number(r.activeChildren)>Number(r.maxChildren))stop('TC_RESOURCES');
  const accounts=list(r.accounts,64,1).map(v=>{const a=shape(v,['provider','accountRef','localSlots']);oneOf(a.provider,['deepseek','together']);id(a.accountRef);integer(a.localSlots,1);return a;});if(new Set(accounts.map(a=>canonical([a.provider,a.accountRef]))).size!==accounts.length)stop('TC_RESOURCES');return s as TeachingCycleSpec;
}
export function validateCurriculumPlan(input:unknown,spec:TeachingCycleSpec):CurriculumPlan{
  const p=shape(copyJson(input),['version','qualification','children']);if(p.version!=='TeachingCurriculumPlan/0.1'||p.qualification!=='SYNTHETIC_PLAN'||hash(canonical(p))!==spec.planDigest)stop('TC_PLAN');
  const children=list(p.children,spec.resources.maxChildren,1).map(v=>{const c=shape(v,['childId','microRound','shard','plannedUnits','productionSpecDigest']);id(c.childId);integer(c.microRound);integer(c.shard);integer(c.plannedUnits,4,192);if(Number(c.plannedUnits)%4)stop('TC_PLAN');digest(c.productionSpecDigest);return c as CycleChild;});
  if(new Set(children.map(c=>c.childId)).size!==children.length||new Set(children.map(c=>c.microRound+':'+c.shard)).size!==children.length||children.some((c,i)=>i>0&&(children[i-1]!.microRound>c.microRound||children[i-1]!.microRound===c.microRound&&children[i-1]!.shard>c.shard)))stop('TC_PLAN');const rounds=[...new Set(children.map(c=>c.microRound))].sort((a,b)=>a-b);if(rounds.some((r,i)=>r!==i))stop('TC_PLAN');integer(children.reduce((n,c)=>n+c.plannedUnits,0));return p as CurriculumPlan;
}
export function validateCycleOwner(input:unknown):CycleOwner{const o=shape(copyJson(input),['epoch','process','workers']);id(o.epoch);const process=(v:unknown)=>{const p=shape(v,['pid','birthId']);integer(p.pid,1);id(p.birthId);return p as ProcessIdentity;};process(o.process);const workers=list(o.workers,64).map(process);if(new Set([o.process,...workers].map(canonical)).size!==workers.length+1)stop('TC_OWNER');return o as CycleOwner;}
export const cycleActiveChildren=(s:TeachingCycleState)=>s.children.filter(c=>!['PENDING','COMPLETE','FAILED'].includes(c.stage));
