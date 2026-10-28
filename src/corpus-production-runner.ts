import { setTimeout as delay } from 'node:timers/promises';
import { bounded } from './runtime.ts';
import { canonical,copyJson,hash,integer,list,shape,stop,Wf1Error } from './wf1-json.ts';
import { MODELS } from './wf1-types.ts';
import type { ProviderResult } from './wf1-types.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import { TeacherProvider } from './wf1-provider.ts';
import { attemptReservation,FACTORY_BASELINE,FACTORY_BASELINE_DIGEST,parseProductionJson,PRODUCTION,productionBinding,productionBody,validateProductionCandidate,validateProductionRegistry,validateProductionRequest,validateProductionReview,validateProductionSpec,validateTask } from './corpus-production-types.ts';
import type { Attempt,Candidate,Item,ProductionEvent,ProductionOperation,ProductionRegistry,ProductionSpec,ProductionState,ScopedRef,Task } from './corpus-production-types.ts';
import { candidateFingerprints,duplicateMatches } from './corpus-production-quality.ts';
import type { ProductionStore } from './corpus-production-store.ts';

export type ProductionTransport=(request:{operation:ProductionOperation;index:number;body:string;output:ArtifactPort;signal:AbortSignal;authorizeSend:<T>(send:()=>T)=>T})=>Promise<ProviderResult>;
export function createProductionTransport(credentials:{deepseek:string|null},dependencies:{fetch?:typeof fetch;now?:()=>number;wallNow?:()=>number}={}):ProductionTransport{return r=>new TeacherProvider({deepseek:credentials.deepseek,together:null},dependencies).submit('deepseek',r.body,r.output,r.signal,r.authorizeSend,{operation:r.operation,binding:productionBinding(r.operation,r.index)});}
export type ProductionRunPorts={store:ProductionStore;objective:string;registry:ProductionRegistry;transport:ProductionTransport;signal?:AbortSignal};
const baseline={factoryBaseline:FACTORY_BASELINE,factoryBaselineDigest:FACTORY_BASELINE_DIGEST};
const terminal=(item:Item)=>item.status==='ACCEPTED'||item.status==='QUARANTINED';
const failure=(error:unknown)=>error instanceof Wf1Error&&/^(CPR_|WF1_AUTHORITY|WF1_REVOKED)/.test(error.code)?error.code.startsWith('CPR_')?error.code:'CPR_AUTHORITY':'CPR_INTEGRITY';
function object(store:ProductionStore,ref:ScopedRef){return parseProductionJson(store.read(ref).toString('utf8'));}
function taskMap(store:ProductionStore,state:ProductionState):Map<string,Task>{const tasks=new Map<string,Task>();for(const p of state.plans)if(p.ref){const plan=shape(object(store,p.ref),['version','items']);if(plan.version!=='CorpusProductionPlan/0.1')stop('CPR_INTEGRITY');for(const value of list(plan.items,16)){const task=validateTask(value);if(!p.itemIds.includes(task.unitId)||tasks.has(task.unitId))stop('CPR_INTEGRITY');tasks.set(task.unitId,task);}}return tasks;}
const candidate=(store:ProductionStore,item:Item)=>validateProductionCandidate(object(store,item.candidateRef!),item.unitId);
function responseItems(store:ProductionStore,attempt:Attempt):unknown[]{const result=attempt.result;if(!result?.finalRef||result.outcome!=='COMPLETED')stop('CPR_OUTPUT');const body=shape(parseProductionJson(store.port(attempt.bucket).read(result.finalRef).toString('utf8')),['version','items']);if(body.version!=='CorpusProductionResponse/0.1')stop('CPR_JSON');return list(body.items,attempt.itemIds.length);}
function selected(items:unknown[],unitId:string):unknown{const matches=items.filter(v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&(v as {unitId?:unknown}).unitId===unitId);if(matches.length!==1)stop('CPR_ITEM');return matches[0];}
function provenance(a:Attempt){const r=a.result;if(!r||r.outcome!=='COMPLETED'||r.finishReason!=='stop'||r.requestedModel!==MODELS.deepseek||r.returnedModel!==MODELS.deepseek||!r.usage)stop('CPR_INTEGRITY');return {provider:'deepseek',requestedModel:r.requestedModel,returnedModel:r.returnedModel,revision:null,effort:'high',usage:r.usage,usageSource:'PROVIDER_REPORTED',transportLane:r.transportLane};}
function resultFence(result:ProviderResult|null):string|null{
  if(!result||result.outcome==='SUBMIT_UNKNOWN')return 'CPR_SUBMIT_UNKNOWN';
  if(result.httpStatus===429)return result.retryAfterStatus==='INVALID'||(result.retryAfterMs??0)>30000?'CPR_RATE_LIMIT_WAIT':null;
  if(!result.usage)return 'CPR_USAGE_UNKNOWN';
  if(result.usage.input>PRODUCTION.inputReserve||result.usage.completion>PRODUCTION.completionReserve)return 'CPR_BUDGET';
  if(result.requestedModel!==MODELS.deepseek||result.returnedModel!==MODELS.deepseek||result.responseFailureCode==='ARTIFACT_WRITE_FAILED')return 'CPR_INTEGRITY';
  return null;
}
export function productionSummary(state:ProductionState,registry:ProductionRegistry,extraFence:string|null=null){
  const eligible=state.items.filter(i=>i.status==='ACCEPTED'&&!state.heldFamilies.includes(registry.slots[i.ordinal]!.familyId)),calls=state.attempts,codes:Record<string,number>={};for(const code of [...state.items.map(i=>i.code),state.code,extraFence])if(code)codes[code]=(codes[code]??0)+1;
  const pools=state.spec.pools.map(p=>({poolId:p.poolId,capability:p.capability,model:p.generator.model,generated:state.items.filter(i=>i.poolId===p.poolId&&i.candidateRef).length,uniqueAccepted:eligible.filter(i=>i.poolId===p.poolId).length,partitions:['train','dev'].map(split=>({split,uniqueAccepted:eligible.filter(i=>i.poolId===p.poolId&&registry.slots[i.ordinal]!.split===split).length})),reviewerCorrelation:'SAME_MODEL_SEPARATE_REQUEST'}));const lanes=(['plan','candidate','review'] as const).map(operation=>{const rows=calls.filter(a=>a.operation===operation);return {operation,calls:rows.length,queueMs:rows.reduce((n,a)=>n+a.queueMs,0),serviceMs:rows.reduce((n,a)=>n+(a.serviceMs??0),0),inputTokens:rows.reduce((n,a)=>n+(a.result?.usage?.input??0),0),completionTokens:rows.reduce((n,a)=>n+(a.result?.usage?.completion??0),0),usageUnknown:rows.filter(a=>!a.result?.usage).length,reservedMicroUsd:rows.reduce((n,a)=>n+a.reservedMicroUsd,0)};});
  return {version:'CorpusProductionSummary/0.1',status:extraFence?'FENCED':state.status,verification:extraFence?'LAST_AVAILABLE_STATE':'COMMITTED_STATE',counts:{planned:state.items.length,generated:state.items.filter(i=>i.candidateRef).length,modelReviewedAccepted:state.items.filter(i=>i.status==='ACCEPTED').length,uniqueEligible:eligible.length,heldFamilies:state.heldFamilies.length,quarantined:state.items.filter(i=>i.status==='QUARANTINED').length,pending:state.items.filter(i=>!terminal(i)).length},calls:{total: calls.length,plans:calls.filter(a=>a.operation==='plan').length,generations:calls.filter(a=>a.operation==='candidate').length,reviews:calls.filter(a=>a.operation==='review').length,known429:calls.filter(a=>a.result?.httpStatus===429).length,submitUnknown:calls.filter(a=>!a.result||a.result.outcome==='SUBMIT_UNKNOWN').length,usageUnknown:calls.filter(a=>!a.result?.usage).length,inputTokens:calls.reduce((n,a)=>n+(a.result?.usage?.input??0),0),completionTokens:calls.reduce((n,a)=>n+(a.result?.usage?.completion??0),0)},time:{wallMs:state.wallMs,queueMs:calls.map(a=>a.queueMs),serviceMs:calls.map(a=>a.serviceMs)},resources:{cpuMicros:state.cpuMicros,peakRss:state.peakRss},cost:{reservedWorstCaseMicroUsd:calls.reduce((n,a)=>n+a.reservedMicroUsd,0),invoice:'UNKNOWN'},pools,lanes,failureCodes:codes,shards:state.shards.length,tokenReceipts:state.tokenRefs.length,measurementStatus:state.tokenRefs.length?'COMMITTED_RECEIPTS':'NOT_MEASURED',studentLossTokens:null,uniqueAcceptedLossTokensPerMinute:null,evidenceClass:'MODEL_REVIEWED',reviewerCorrelation:'SAME_MODEL_SEPARATE_REQUEST',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'};
}

export function verifyProduction(store:ProductionStore):ProductionState{
  const s=store.snapshot();if(!s)stop('CPR_STATE');const registry=validateProductionRegistry(object(store,s.registryRef),s.spec);if(hash(canonical(registry))!==s.spec.registryDigest||hash(store.read(s.objectiveRef))!==s.spec.objectiveDigest)stop('CPR_SOURCE');const tasks=taskMap(store,s),ids=new Set<string>();
  for(const a of s.attempts){if(ids.has(a.id)||a.reservedMicroUsd!==attemptReservation(s.spec))stop('CPR_INTEGRITY');ids.add(a.id);const body=store.port(a.bucket).read(a.requestRef).toString('utf8');if(hash(body)!==a.bodyHash)stop('CPR_INTEGRITY');validateProductionRequest('deepseek',a.operation,body,productionBinding(a.operation,a.index));
    if(a.result)for(const ref of [a.result.rawRef,a.result.reasoningRef,a.result.finalRef])if(ref)store.port(a.bucket).read(ref);
    const payload=JSON.parse(JSON.parse(body).messages[1].content);
    const expected=a.operation==='plan'?{...baseline,currentApprovedObjective:store.read(s.objectiveRef).toString('utf8'),slots:a.itemIds.map(unitId=>{const slot=registry.slots.find(v=>v.unitId===unitId)!;return {ordinal:slot.ordinal,unitId,poolId:slot.poolId,capability:s.spec.pools.find(p=>p.poolId===slot.poolId)!.capability};})}:a.operation==='candidate'?{...baseline,tasks:a.itemIds.map(id=>tasks.get(id))}:{...baseline,items:a.itemIds.map(id=>{const item=s.items.find(i=>i.unitId===id)!;return {task:tasks.get(id),candidate:candidate(store,item),candidateDigest:item.candidateDigest};})};
    if(canonical(payload.data)!==canonical(expected))stop('CPR_INTEGRITY');
  }
  for(const p of s.plans)if(p.ref){const a=s.attempts.find(a=>a.id===p.id);if(!a)stop('CPR_INTEGRITY');const native=responseItems(store,a);for(const value of (object(store,p.ref) as unknown as {items:Task[]}).items)if(canonical(validateTask(selected(native,value.unitId)))!==canonical(value))stop('CPR_INTEGRITY');}
  for(const item of s.items){if(item.candidateRef){const c=candidate(store,item),fp=candidateFingerprints(c);if(Object.entries(fp).some(([key,value])=>(item as unknown as Record<string,unknown>)[key]!==value))stop('CPR_INTEGRITY');const a=s.attempts.find(a=>a.operation==='candidate'&&a.itemIds.includes(item.unitId));if(!a||canonical(validateProductionCandidate(selected(responseItems(store,a),item.unitId),item.unitId))!==canonical(c))stop('CPR_INTEGRITY');}
    if(item.reviewRef){const review=validateProductionReview(object(store,item.reviewRef),item.unitId,item.candidateDigest!),a=s.attempts.find(a=>a.operation==='review'&&a.itemIds.includes(item.unitId));if(!a||canonical(validateProductionReview(selected(responseItems(store,a),item.unitId),item.unitId,item.candidateDigest!))!==canonical(review))stop('CPR_INTEGRITY');}
    if(item.status==='ACCEPTED'){if(!item.rowRef||!item.reviewRef)stop('CPR_INTEGRITY');const row=object(store,item.rowRef) as unknown as {version:string;jobId:string;unit:unknown;candidate:unknown;candidateDigest:string;factoryBaselineDigest:string;studentTargetDigest:string;purposeDigest:string;evidenceClass:string;exactVerified:boolean;manualChecked:boolean;trainingReady:boolean;trainingJobPolicy:string;reviewerCorrelation:string;planRef:unknown;candidateRef:unknown;reviewRef:unknown;teacher:unknown;reviewer:unknown};if(row.version!=='QualifiedProductionItem/0.1'||row.jobId!==s.spec.jobId||row.purposeDigest!==s.spec.purposeDigest||row.exactVerified!==false||row.manualChecked!==false||row.trainingJobPolicy!=='NOT_AUTHORIZED'||row.reviewerCorrelation!=='SAME_MODEL_SEPARATE_REQUEST'||canonical(row.planRef)!==canonical(s.plans.find(p=>p.itemIds.includes(item.unitId))!.ref)||canonical(row.candidateRef)!==canonical(item.candidateRef)||canonical(row.reviewRef)!==canonical(item.reviewRef)||canonical(row.unit)!==canonical(registry.slots[item.ordinal])||canonical(row.candidate)!==canonical(candidate(store,item))||row.candidateDigest!==item.candidateDigest||row.factoryBaselineDigest!==FACTORY_BASELINE_DIGEST||row.studentTargetDigest!==s.spec.studentTargetDigest||row.evidenceClass!=='MODEL_REVIEWED'||row.trainingReady!==false)stop('CPR_INTEGRITY');const g=s.attempts.find(a=>a.operation==='candidate'&&a.itemIds.includes(item.unitId))!,r=s.attempts.find(a=>a.operation==='review'&&a.itemIds.includes(item.unitId))!;if(canonical(row.teacher)!==canonical(provenance(g))||canonical(row.reviewer)!==canonical(provenance(r))||(object(store,item.reviewRef) as unknown as {disposition:string}).disposition!=='ACCEPT')stop('CPR_INTEGRITY');}
  }
  for(const ref of [...s.shards,...s.tokenRefs,...(s.exportRef?[s.exportRef]:[])])store.read(ref);return s;
}

export async function runCorpusProduction(specInput:unknown,ports:ProductionRunPorts){
  const spec=validateProductionSpec(specInput),{store}=ports;if(canonical(spec)!==canonical(store.spec))stop('CPR_BINDING');const registry=validateProductionRegistry(ports.registry,spec);if(hash(canonical(registry))!==spec.registryDigest||hash(ports.objective)!==spec.objectiveDigest)stop('CPR_SOURCE');let shadow=store.snapshot();if(!shadow){store.initialize(ports.objective,registry);shadow=store.snapshot()!;}else shadow=verifyProduction(store);
  if(store.mode==='inspect'||shadow.status!=='ACTIVE')return productionSummary(shadow,registry,shadow.status==='ACTIVE'?'CPR_INSPECT_ONLY':null);
  let fence:string|null=null,peak=process.memoryUsage().rss;const cpu=process.cpuUsage(),baseCpu=shadow.cpuMicros;const elapsed=()=>Math.max(shadow!.wallMs,Math.max(0,Date.now()-spec.createdAt));
  const commit=(kind:ProductionEvent['kind'],data:unknown)=>{store.apply(kind,data);shadow=store.snapshot()!;peak=Math.max(peak,process.memoryUsage().rss);};
  const finish=(status:'COMPLETED'|'FENCED',code:string|null)=>{const used=process.cpuUsage(cpu);commit('FINISH',{status,code,wallMs:elapsed(),cpuMicros:baseCpu+used.user+used.system,peakRss:peak});};
  const halt=(code:string)=>{fence??=code;try{finish('FENCED',fence);}catch{/* Loss of authority never manufactures permission to record a fence. */}};
  const guard=()=>{if(fence)stop(fence);store.check();if(ports.signal?.aborted)stop('CPR_ABORTED');if(Date.now()>=spec.expiresAt)stop('CPR_DEADLINE');};
  const quarantine=(item:Item,code:string)=>{if(!terminal(item))commit('ITEM',{expected:item.status,item:{...item,status:'QUARANTINED',code}});};
  const holdConnected=()=>{const parents=new Map<string,string>();for(const s of registry.slots)parents.set(s.familyId,s.familyId);const root=(f:string):string=>parents.get(f)===f?f:root(parents.get(f)!);for(const [a,b]of shadow!.duplicateLinks){const x=registry.slots.find(s=>s.unitId===a)!.familyId,y=registry.slots.find(s=>s.unitId===b)!.familyId;parents.set(root(x),root(y));}const groups=new Map<string,typeof registry.slots>();for(const s of registry.slots){const key=root(s.familyId),group=groups.get(key)??[];group.push(s);groups.set(key,group);}for(const group of groups.values())if(new Set(group.map(s=>s.split)).size>1)for(const familyId of new Set(group.map(s=>s.familyId)))if(!shadow!.heldFamilies.includes(familyId))commit('HOLD',{familyId});};
  const processResult=(attempt:Attempt)=>{
    let values:unknown[];try{values=responseItems(store,attempt);}catch{values=[];}
    if(attempt.operation==='plan'){
      const plan=shadow!.plans.find(p=>p.id===attempt.id)!;if(plan.ref||plan.code)return;const tasks:Task[]=[];
      for(const id of attempt.itemIds){const item=shadow!.items.find(i=>i.unitId===id)!;if(terminal(item))continue;try{const task=validateTask(selected(values,id));if(task.ordinal!==item.ordinal)stop('CPR_ITEM');tasks.push(task);}catch{quarantine(item,attempt.result?.httpStatus===429?'CPR_RATE_LIMIT':'CPR_PLAN_ITEM');}}
      const ref=tasks.length?store.put(attempt.bucket,'corpus-production-plan',canonical({version:'CorpusProductionPlan/0.1',items:tasks})):null;commit('PLAN',{id:plan.id,ref,code:tasks.length===attempt.itemIds.length?null:'CPR_PARTIAL_PLAN'});return;
    }
    for(const id of attempt.itemIds){let item=shadow!.items.find(i=>i.unitId===id)!;if(terminal(item)||attempt.operation==='candidate'&&item.status!=='PLANNED'||attempt.operation==='review'&&item.status!=='CANDIDATE')continue;
      if(fence||shadow!.heldFamilies.includes(registry.slots[item.ordinal]!.familyId)){quarantine(item,fence?'CPR_LATE_AFTER_FENCE':'CPR_SPLIT_HOLD');continue;}
      if(attempt.operation==='candidate'){
        let c:Candidate;try{c=validateProductionCandidate(selected(values,id),id);}catch{quarantine(item,attempt.result?.httpStatus===429?'CPR_RATE_LIMIT':'CPR_ITEM_FORMAT');continue;}
        const fp=candidateFingerprints(c),ref=store.put(attempt.bucket,'corpus-production-candidate',canonical(c));commit('ITEM',{expected:'PLANNED',item:{...item,...fp,candidateRef:ref,status:'CANDIDATE'}});item=shadow!.items[item.ordinal]!;
        const matches=duplicateMatches(c,shadow!.items,old=>candidate(store,old));if(matches.length){commit('LINKS',{unitId:id,matches:matches.map(i=>i.unitId)});holdConnected();quarantine(shadow!.items[item.ordinal]!,'CPR_DUPLICATE');}
      }else{
        let review;try{review=validateProductionReview(selected(values,id),id,item.candidateDigest!);}catch{quarantine(item,attempt.result?.httpStatus===429?'CPR_RATE_LIMIT':'CPR_REVIEW_FORMAT');continue;}
        const reviewRef=store.put(attempt.bucket,'corpus-production-review',canonical(review));if(review.disposition!=='ACCEPT'){quarantine({...item,reviewRef},'CPR_MODEL_REJECTED');continue;}
        guard();const generation=shadow!.attempts.find(a=>a.operation==='candidate'&&a.itemIds.includes(id))!;
        const row={version:'QualifiedProductionItem/0.1',jobId:spec.jobId,unit:registry.slots[item.ordinal],candidate:candidate(store,item),candidateDigest:item.candidateDigest,planRef:shadow!.plans.find(p=>p.itemIds.includes(id))!.ref,candidateRef:item.candidateRef,reviewRef,purposeDigest:spec.purposeDigest,factoryBaselineDigest:spec.factoryBaselineDigest,studentTargetDigest:spec.studentTargetDigest,evidenceClass:'MODEL_REVIEWED',reviewerCorrelation:'SAME_MODEL_SEPARATE_REQUEST',exactVerified:false,manualChecked:false,trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED',teacher:provenance(generation),reviewer:provenance(attempt)};
        const rowRef=store.put(attempt.bucket,'corpus-production-row',canonical(row));guard();commit('ITEM',{expected:'CANDIDATE',item:{...item,reviewRef,rowRef,status:'ACCEPTED'}});
      }
    }
  };
  if(shadow.attempts.some(a=>a.serviceMs===null)){halt('CPR_SUBMIT_UNKNOWN');return productionSummary(shadow,registry,fence);}
  const recoveredFence=shadow.attempts.map(a=>resultFence(a.result)).find(c=>c!==null);if(recoveredFence){halt(recoveredFence);return productionSummary(shadow,registry,fence);}
  try{
    for(const a of [...shadow.attempts])processResult(a);
    // Resume incomplete candidate -> links -> family hold transactions before any send.
    for(const item of [...shadow.items])if(item.candidateRef){const matches=duplicateMatches(candidate(store,item),shadow.items,old=>candidate(store,old));const missing=matches.filter(old=>!shadow!.duplicateLinks.some(pair=>pair.includes(item.unitId)&&pair.includes(old.unitId)));if(missing.length)commit('LINKS',{unitId:item.unitId,matches:missing.map(i=>i.unitId)});}
    holdConnected();
    for(const item of [...shadow.items])if(item.status==='CANDIDATE'){const matches=duplicateMatches(candidate(store,item),shadow.items,old=>candidate(store,old));if(matches.some(old=>old.status==='ACCEPTED'||old.ordinal<item.ordinal))quarantine(item,'CPR_DUPLICATE');}
  }catch(error){halt(failure(error));}
  const submit=async(operation:ProductionOperation,index:number,id:string,itemIds:string[],data:unknown,queuedAt:number)=>{
    try{guard();const body=productionBody(operation,index,data),bucket='attempt-'+shadow!.attempts.length,requestRef=store.port(bucket).put('corpus-production-request',body),at=elapsed();const a:Attempt={id,index,operation,poolId:operation==='plan'?null:shadow!.items.find(i=>i.unitId===itemIds[0])!.poolId,itemIds,bucket,requestRef,bodyHash:hash(body),consumedAtMs:at,queueMs:Math.max(0,at-queuedAt),serviceMs:null,settledAtMs:null,reservedMicroUsd:attemptReservation(spec),result:null};commit('CONSUME',a);
      const start=performance.now(),signal=AbortSignal.timeout(Math.max(1,Math.min(PRODUCTION.requestMs,spec.expiresAt-Date.now())));let result:ProviderResult|null=null,sent=false;
      try{result=await bounded(ports.signal?AbortSignal.any([signal,ports.signal]):signal,PRODUCTION.requestMs,inner=>ports.transport({operation,index,body,output:store.port(bucket),signal:inner,authorizeSend:send=>{guard();inner.throwIfAborted();if(sent)stop('CPR_ONCE');sent=true;return store.authorizeSend(send);}}));copyJson(result);if(!sent)stop('CPR_ONCE');if(result.usage){integer(result.usage.input);integer(result.usage.completion);if(result.usage.reasoning!==null)integer(result.usage.reasoning,0,result.usage.completion);}}catch{result=null;}
      commit('SETTLE',{id,result,serviceMs:Math.ceil(performance.now()-start),settledAtMs:elapsed()});
      const code=resultFence(result);if(code)halt(code);
      if(!fence)processResult(shadow!.attempts.find(a=>a.id===id)!);else for(const unitId of itemIds)quarantine(shadow!.items.find(i=>i.unitId===unitId)!,'CPR_LATE_AFTER_FENCE');
    }catch(error){halt(failure(error));}
  };
  const running=new Map<string,{operation:ProductionOperation;promise:Promise<void>}>();
  const start=(operation:ProductionOperation,index:number,id:string,itemIds:string[],data:unknown,queuedAt=0)=>{const promise=submit(operation,index,id,itemIds,data,queuedAt).finally(()=>running.delete(id));running.set(id,{operation,promise});};
  const count=(op:ProductionOperation)=>[...running.values()].filter(v=>v.operation===op).length;
  while(true){
    if(!fence)try{guard();}catch(error){halt(failure(error));}
    const cooldown=Math.max(0,...shadow!.attempts.filter(a=>a.result?.httpStatus===429).map(a=>(a.settledAtMs??a.consumedAtMs)+(a.result?.retryAfterMs??1000)))-elapsed();
    if(!fence&&cooldown<=0){try{
      const tasks=taskMap(store,shadow!);
      for(const item of [...shadow!.items])if(!terminal(item)&&shadow!.heldFamilies.includes(registry.slots[item.ordinal]!.familyId))quarantine(item,'CPR_SPLIT_HOLD');
      while(running.size<PRODUCTION.totalConcurrency&&count('review')<PRODUCTION.reviewConcurrency){
        const ready=shadow!.items.filter(i=>i.status==='CANDIDATE'&&!shadow!.attempts.some(a=>a.operation==='review'&&a.itemIds.includes(i.unitId)));if(!ready.length)break;const pool=ready[0]!.poolId,items=ready.filter(i=>i.poolId===pool).slice(0,4),index=shadow!.attempts.filter(a=>a.operation==='review').length;let data:unknown;
        while(items.length){data={...baseline,items:items.map(i=>({task:tasks.get(i.unitId),candidate:candidate(store,i),candidateDigest:i.candidateDigest}))};try{productionBody('review',index,data);break;}catch(error){if(!(error instanceof Wf1Error)||error.code!=='CPR_LENGTH')throw error;items.pop();}}
        if(!items.length){quarantine(ready[0]!,'CPR_LENGTH');continue;}const itemIds=items.map(i=>i.unitId),id='review:'+hash(canonical(itemIds));const queued=Math.max(...itemIds.map(id=>{const a=shadow!.attempts.find(a=>a.operation==='candidate'&&a.itemIds.includes(id))!;return a.consumedAtMs+(a.serviceMs??0);}));start('review',index,id,itemIds,data,queued);
      }
      for(let offset=0;offset<spec.unitCount;offset+=4){if(running.size>=PRODUCTION.totalConcurrency||count('candidate')>=PRODUCTION.generationConcurrency||shadow!.items.filter(i=>i.status==='CANDIDATE').length+count('candidate')*4+4>PRODUCTION.reviewQueueItems)break;const group=shadow!.items.slice(offset,offset+4),id='generation:'+offset/4;if(shadow!.attempts.some(a=>a.id===id))continue;if(group.some(i=>i.status!=='PLANNED')){for(const item of group)quarantine(item,'CPR_FROZEN_GROUP_INCOMPLETE');continue;}if(group.some(i=>!tasks.has(i.unitId)))continue;const plan=shadow!.attempts.find(a=>a.operation==='plan'&&a.itemIds.includes(group[0]!.unitId))!;start('candidate',offset/4,id,group.map(i=>i.unitId),{...baseline,tasks:group.map(i=>tasks.get(i.unitId))},plan.consumedAtMs+(plan.serviceMs??0));}
      if(running.size<PRODUCTION.totalConcurrency&&count('plan')<PRODUCTION.planConcurrency){const p=shadow!.plans.find(p=>!p.ref&&!p.code&&!shadow!.attempts.some(a=>a.id===p.id));if(p){const index=shadow!.plans.indexOf(p);start('plan',index,p.id,p.itemIds,{...baseline,currentApprovedObjective:ports.objective,slots:p.itemIds.map(id=>{const slot=registry.slots.find(s=>s.unitId===id)!;return {ordinal:slot.ordinal,unitId:id,poolId:slot.poolId,capability:spec.pools.find(p=>p.poolId===slot.poolId)!.capability};})});}}
    }catch(error){halt(failure(error));}}
    if(running.size){await Promise.race([...running.values()].map(v=>v.promise));continue;}
    if(!fence&&cooldown>0){await delay(Math.min(1000,cooldown));continue;}break;
  }
  if(!fence)try{finish('COMPLETED',null);}catch(error){halt(failure(error));}else try{finish('FENCED',fence);}catch{}
  try{return productionSummary(verifyProduction(store),registry,fence);}catch(error){return productionSummary(shadow!,registry,fence??failure(error));}
}
