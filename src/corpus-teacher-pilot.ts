import { artifactRef,estimateMicroUsd } from './wf1-contract.ts';
import { canonical,copyJson,hash,integer,stop,text,Wf1Error } from './wf1-json.ts';
import { bounded } from './runtime.ts';
import { TeacherProvider } from './wf1-provider.ts';
import { MODELS } from './wf1-types.ts';
import type { ArtifactRef,Provider,ProviderResult } from './wf1-types.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import { completion,coordinatorSlots,planProjection,parsePilotJson,pilotBinding,pilotBody,reservation,TEACHER_PILOT,TEACHER_PILOT_DIGEST,validateCandidate,validatePilotSpec,validatePlan,validateRegistry,validateReview } from './corpus-teacher-types.ts';
import type { PilotAttempt,PilotCandidate,PilotManifest,PilotOperation,PilotPlan,PilotProvenance,PilotRegistry,PilotRow,PilotSpec,PilotState,UnitState,UnitStatus } from './corpus-teacher-types.ts';
import type { TeacherPilotStore } from './corpus-teacher-store.ts';

export type PilotTransport=(request:{provider:Provider;operation:PilotOperation;ordinal:number|null;body:string;output:ArtifactPort;signal:AbortSignal;authorizeSend:<T>(send:()=>T)=>T})=>Promise<ProviderResult>;
/** A new single-flight transport instance per occupied scheduler slot. No SDK retry. */
export function createPilotTransport(credentials:Record<Provider,string|null>,dependencies:{fetch?:typeof fetch;now?:()=>number}={}):PilotTransport {return r=>new TeacherProvider(credentials,dependencies).submit(r.provider,r.body,r.output,r.signal,r.authorizeSend,{operation:r.operation,binding:pilotBinding(r.operation,r.ordinal)});}
const TERMINAL:UnitStatus[]=['ACCEPTED','QUARANTINED','SUBMIT_UNKNOWN'];
const FAILURES=['CPQ_JSON','CPQ_LENGTH','CPQ_MODEL_REJECTED','CPQ_DUPLICATE','CPQ_OUTPUT','CPQ_PLAN_INVALID','CPQ_AUTHORITY','CPQ_SOURCE','CPQ_INTEGRITY','CPQ_BUDGET','CPQ_USAGE_UNKNOWN','CPQ_SUBMIT_UNKNOWN','CPQ_DEADLINE','CPQ_ABORTED','CPQ_RESTART_READ_ONLY','CPQ_LATE_AFTER_FENCE'] as const;
type Failure=typeof FAILURES[number];
function globalCode(error:unknown):Failure {const code=error instanceof Wf1Error?error.code:'';return code.includes('AUTHORITY')||code==='WF1_REVOKED'?'CPQ_AUTHORITY':code==='CPQ_SOURCE'?'CPQ_SOURCE':code.includes('BUDGET')?'CPQ_BUDGET':code==='CPQ_DEADLINE'?'CPQ_DEADLINE':code==='CPQ_ABORTED'?'CPQ_ABORTED':'CPQ_INTEGRITY';}
function localCode(error:unknown):Failure {const code=error instanceof Wf1Error?error.code:'';return code==='CPQ_LENGTH'||code==='WF1_TEXT'||code==='WF1_JSON_LIMIT'?'CPQ_LENGTH':'CPQ_JSON';}
function read(port:ArtifactPort,ref:ArtifactRef,kind:string){artifactRef(ref);if(ref.kind!==kind||ref.partition!=='train')stop('CPQ_INTEGRITY');return port.read(ref).toString('utf8');}
function provenance(attempt:PilotAttempt):PilotProvenance {const r=attempt.result;if(!r||r.outcome!=='COMPLETED'||r.finishReason!=='stop'||r.requestedModel!==MODELS[attempt.provider]||r.returnedModel!==MODELS[attempt.provider]||!r.usage||r.usage.input>attempt.inputReserved||r.usage.completion>attempt.completionReserved)stop('CPQ_INTEGRITY');return {provider:attempt.provider,requestedModel:r.requestedModel,returnedModel:r.returnedModel,revision:null,protocol:'CorpusTeacherPilot/0.1',effort:attempt.provider==='together'?'medium':'high',finishReason:'stop',usage:r.usage,usageSource:'PROVIDER_REPORTED'};}
const attemptId=(op:PilotOperation,i:number|null)=>op+(i===null?'':':'+i);
function contentDigest(candidate:PilotCandidate){return hash(canonical({prompt:candidate.prompt,response:candidate.response}));}
function rowManifest(spec:PilotSpec,planRef:ArtifactRef,rows:PilotRow[],rowRefs:ArtifactRef[],previous:ArtifactRef|null,sequence:number,shardRef:ArtifactRef):PilotManifest {
  return {version:'CorpusTeacherManifest/0.1',runId:spec.runId,sequence,previous,profileDigest:spec.profileDigest,buildDigest:spec.buildDigest,registryDigest:spec.registryDigest,studentTargetDigest:spec.studentTargetDigest,planRef,rowRefs,shardRef,logicalRowsDigest:hash(rows.map(r=>canonical(r)+'\n').join('')),rows:rows.length,splitCounts:{train:rows.filter(r=>r.unit.split==='train').length,dev:rows.filter(r=>r.unit.split==='dev').length},reusedQualified:0,generatedNew:rows.length,evidenceClass:'MODEL_REVIEWED',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED',studentInputTokens:null,studentLossTokens:null,tokenizerProfileDigest:null,measurementStatus:'NOT_MEASURED'};
}

/** Fresh-process verification reads only this run's immutable objects, never old corpus/sealed material. */
export function verifyTeacherPilot(store:TeacherPilotStore):PilotState {
  const state=store.snapshot();if(!state)stop('CPQ_STATE');
  const registry=validateRegistry(parsePilotJson(read(store.output,state.registryRef,'corpus-teacher-registry')));
  if(hash(canonical(registry))!==state.spec.registryDigest||hash(read(store.output,state.objectiveRef,'corpus-teacher-objective'))!==state.spec.objectiveDigest)stop('CPQ_INTEGRITY');
  const plan=state.planRef?validatePlan(parsePilotJson(read(store.output,state.planRef,'corpus-teacher-plan')),registry):null;
  const seen=new Set<string>(),bodies=new Set(registry.priorContentDigests);let together=0,deepseek=0;
  for(const a of state.attempts){if(seen.has(a.id)||a.id!==attemptId(a.operation,a.ordinal)||a.provider!==(a.operation==='review'?'deepseek':'together')||a.profileDigest!==TEACHER_PILOT_DIGEST||a.inputReserved!==TEACHER_PILOT.inputReserve||a.completionReserved!==completion(a.operation)||a.reservedMicroUsd!==reservation(state.spec,a.operation))stop('CPQ_INTEGRITY');seen.add(a.id);a.provider==='together'?together++:deepseek++;
    const body=read(store.output,a.requestRef,'corpus-teacher-request');if(hash(body)!==a.bodyHash)stop('CPQ_INTEGRITY');
    // The transport validator is also applied on cold read; a stored binding cannot drift.
    const expectedData=a.operation==='plan'?{currentApprovedObjective:read(store.output,state.objectiveRef,'corpus-teacher-objective'),slots:coordinatorSlots(registry)}:a.operation==='candidate'?{unit:plan?.units[a.ordinal!]}:null;
    if(expectedData&&body!==pilotBody(a.operation,a.ordinal,expectedData))stop('CPQ_INTEGRITY');
    if(a.result){for(const ref of [a.result.rawRef,a.result.reasoningRef,a.result.finalRef])if(ref){artifactRef(ref);(ref.partition==='train'?store.output:store.custody).read(ref);}}
  }
  if(together>7||deepseek>6||state.units.length!==(plan?6:0))stop('CPQ_INTEGRITY');
  if(plan){const a=state.attempts.find(a=>a.id==='plan');if(!a?.result?.finalRef||canonical(validatePlan(parsePilotJson(store.output.read(a.result.finalRef).toString('utf8')),registry))!==canonical(plan))stop('CPQ_INTEGRITY');provenance(a);}
  const accepted:PilotRow[]=[];const acceptedRefs:ArtifactRef[]=[];
  for(const [i,u] of state.units.entries()){
    if(u.ordinal!==i||u.unitId!==plan!.units[i]!.unitId||!['PLANNED','GENERATE_CONSUMED','CANDIDATE_COMMITTED','REVIEW_CONSUMED','REVIEW_COMMITTED',...TERMINAL].includes(u.status))stop('CPQ_INTEGRITY');
    let candidate:PilotCandidate|null=null;
    if(u.candidateRef){candidate=validateCandidate(read(store.output,u.candidateRef,'corpus-teacher-candidate'),plan!.units[i]!);if(contentDigest(candidate)!==u.candidateDigest)stop('CPQ_INTEGRITY');const generated=state.attempts.find(a=>a.id===attemptId('candidate',i));if(!generated?.result?.finalRef||canonical(validateCandidate(store.output.read(generated.result.finalRef).toString('utf8'),plan!.units[i]!))!==canonical(candidate))stop('CPQ_INTEGRITY');}
    const reviewAttempt=state.attempts.find(a=>a.id===attemptId('review',i));
    if(reviewAttempt&&(!candidate||read(store.output,reviewAttempt.requestRef,'corpus-teacher-request')!==pilotBody('review',i,{unit:plan!.units[i],candidate,candidateDigest:u.candidateDigest})))stop('CPQ_INTEGRITY');
    if(u.reviewRef){const review=validateReview(read(store.output,u.reviewRef,'corpus-teacher-review'),plan!.units[i]!,u.candidateDigest!);if(!reviewAttempt?.result?.finalRef||canonical(validateReview(store.output.read(reviewAttempt.result.finalRef).toString('utf8'),plan!.units[i]!,u.candidateDigest!))!==canonical(review))stop('CPQ_INTEGRITY');}
    if(u.status==='ACCEPTED'){
      if(!candidate||!u.rowRef||!u.reviewRef||!state.planRef||bodies.has(u.candidateDigest!))stop('CPQ_INTEGRITY');bodies.add(u.candidateDigest!);
      const review=validateReview(read(store.output,u.reviewRef,'corpus-teacher-review'),plan!.units[i]!,u.candidateDigest!);if(review.disposition!=='ACCEPT')stop('CPQ_INTEGRITY');
      const teacher=state.attempts.find(a=>a.id===attemptId('candidate',i));if(!teacher||!reviewAttempt)stop('CPQ_INTEGRITY');
      const expected: PilotRow={version:'QualifiedTeacherItem/0.1',runId:state.spec.runId,unit:registry.slots[i]!,candidate,candidateDigest:u.candidateDigest!,planRef:state.planRef,candidateRef:u.candidateRef!,reviewRef:u.reviewRef,evidenceClass:'MODEL_REVIEWED',generated:true,structurallyValid:true,modelReviewAccepted:true,exactVerified:false,dataGateAccepted:true,manualChecked:false,trainingReady:false,teacher:provenance(teacher),reviewer:provenance(reviewAttempt)};
      if(read(store.output,u.rowRef,'corpus-teacher-row')!==canonical(expected))stop('CPQ_INTEGRITY');accepted.push(expected);acceptedRefs.push(u.rowRef);
    }else if(u.rowRef)stop('CPQ_INTEGRITY');
  }
  if(state.manifestRefs.length!==accepted.length)stop('CPQ_INTEGRITY');
  let previous:ArtifactRef|null=null;const exported=new Set<string>();
  for(const [index,ref]of state.manifestRefs.entries()){
    const m=parsePilotJson(read(store.output,ref,'corpus-teacher-manifest')) as unknown as PilotManifest;
    if(!Array.isArray(m.rowRefs)||m.rowRefs.length!==index+1)stop('CPQ_INTEGRITY');
    const rows=m.rowRefs.map(r=>{const i=acceptedRefs.findIndex(a=>canonical(a)===canonical(r));if(i<0)stop('CPQ_INTEGRITY');return accepted[i]!;});
    if(new Set(m.rowRefs.map(r=>r.id)).size!==index+1||[...exported].some(id=>!m.rowRefs.some(r=>r.id===id)))stop('CPQ_INTEGRITY');
    m.rowRefs.forEach(r=>exported.add(r.id));
    if(read(store.output,m.shardRef,'corpus-teacher-jsonl')!==rows.map(r=>canonical(r)+'\n').join('')||canonical(m)!==canonical(rowManifest(state.spec,state.planRef!,rows,m.rowRefs,previous,index+1,m.shardRef)))stop('CPQ_INTEGRITY');previous=ref;
  }
  if(state.tokenMeasurementRef){const ref=artifactRef(state.tokenMeasurementRef);if(ref.kind!=='corpus-teacher-token-measurement'||ref.partition!=='train')stop('CPQ_INTEGRITY');store.output.read(ref);}
  return state;
}

export function teacherPilotSummary(state:PilotState,extraFence:Failure|null=null,diskFinalBytes:number|null=null){
  const attempts=state.attempts,units=state.units,accepted=units.filter(u=>u.status==='ACCEPTED').length,modelAccepted=units.filter(u=>u.modelReviewAccepted).length;
  const unknown=attempts.filter(a=>!a.result?.usage),known=attempts.filter(a=>a.result?.usage),codes:Record<string,number>={};
  for(const code of [...units.map(u=>u.code),state.code,extraFence===state.code?null:extraFence])if(code&&FAILURES.includes(code as Failure))codes[code]=(codes[code]??0)+1;
  const byLane=(op:PilotOperation,field:'queueWaitMs'|'serviceMs')=>attempts.filter(a=>a.operation===op).map(a=>a[field]);
  const rate=state.wallMs>0?accepted*3600000/state.wallMs:null;
  const lanes=new Set(attempts.map(a=>a.result?.transportLane).filter(Boolean));
  return {version:'CorpusTeacherSummary/0.1',status:extraFence?'FENCED':state.status,verification:extraFence?'LAST_COMMITTED_STATE_ONLY':'VERIFIED_IMMUTABLE_COMMITTED_ROWS',transportLane:attempts.every(a=>a.result)&&lanes.size===1?[...lanes][0]:'UNKNOWN',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED',evidenceClass:'MODEL_REVIEWED',
    counts:{reusedQualified:0,generatedNew:units.filter(u=>u.generated).length,structurallyValidNew:units.filter(u=>u.structurallyValid).length,modelReviewAcceptedNew:modelAccepted,exactVerifiedNew:0,dataGateAcceptedNew:accepted,manualChecked:0,quarantined:units.filter(u=>u.status==='QUARANTINED').length,submitUnknown:attempts.filter(a=>!a.result||a.result.outcome==='SUBMIT_UNKNOWN').length,pending:units.filter(u=>!TERMINAL.includes(u.status)).length},
    tokens:{studentInputTokens:null,studentLossTokens:null,tokenizerProfileDigest:null,measurementStatus:'NOT_MEASURED'},
    calls:{coordinatorConsumed:attempts.filter(a=>a.operation==='plan').length,teacherConsumed:attempts.filter(a=>a.operation==='candidate').length,reviewerConsumed:attempts.filter(a=>a.operation==='review').length,knownInput:known.reduce((n,a)=>n+a.result!.usage!.input,0),knownCompletion:known.reduce((n,a)=>n+a.result!.usage!.completion,0),knownReasoning:known.some(a=>a.result!.usage!.reasoning===null)?null:known.reduce((n,a)=>n+a.result!.usage!.reasoning!,0),unknownUsageCount:unknown.length},
    yield:{dataGateAcceptedNewPer100AllConsumedCalls:attempts.length?accepted*100/attempts.length:null,modelReviewAcceptedNewPer100AllConsumedCalls:attempts.length?modelAccepted*100/attempts.length:null},
    time:{wallMs:state.wallMs,makespanMs:state.wallMs,generationServiceMs:byLane('candidate','serviceMs'),reviewServiceMs:byLane('review','serviceMs'),generationQueueWaitMs:byLane('candidate','queueWaitMs'),reviewQueueWaitMs:byLane('review','queueWaitMs'),qualifiedPerHour:rate,tokensPerHour:null,extrapolatedPer24h:rate===null?null:rate*24,extrapolationOnly:true,sampleSize:6},
    failure:{fixedCodeCounts:codes,unitFailures:units.filter(u=>u.code!==null).length,globalFences:state.code||extraFence?1:0},recovery:{duplicateCommittedRows:0,duplicateExternalDispatches:0,offlineRecomputes:0,recomputeWastedMs:0},
    resources:{controllerPeakRss:state.controllerPeakRss,controllerPeakRssKind:'SAMPLED_AT_COMMITS',workerPeakRss:null,cpuSeconds:state.cpuMicros/1e6,diskFinalBytes,diskStagingPeakBytes:null,unknownMeasurements:['workerPeakRss','diskStagingPeakBytes']},
    cost:{estimatedKnownMicroUsd:known.reduce((n,a)=>n+estimateMicroUsd(a.result!.usage!.input,a.result!.usage!.completion,state.spec.prices[a.provider]),0),reservedWorstCaseMicroUsd:attempts.reduce((n,a)=>n+a.reservedMicroUsd,0),actualInvoice:'UNKNOWN'}};
}

export type PilotRunPorts={store:TeacherPilotStore;objective:string;registry:PilotRegistry;transport:PilotTransport;monotonic?:()=>number;signal?:AbortSignal};
export async function runTeacherPilot(specInput:unknown,ports:PilotRunPorts){
  const spec=validatePilotSpec(specInput),{store}=ports;if(canonical(spec)!==canonical(store.spec))stop('CPQ_BINDING');
  const existing=store.snapshot();if(existing){const verified=verifyTeacherPilot(store);return teacherPilotSummary(verified,verified.status==='COMPLETED'||verified.status==='FENCED'?null:'CPQ_RESTART_READ_ONLY',store.metrics().diskFinalBytes);}
  store.check();const registry=validateRegistry(ports.registry),objective=text(ports.objective,4096);if(hash(canonical(registry))!==spec.registryDigest||hash(objective)!==spec.objectiveDigest)stop('CPQ_SOURCE');
  const clock=ports.monotonic??(()=>performance.now()),start=clock(),cpuStart=process.cpuUsage();let previousTime=start,shadow:PilotState,fence:Failure|null=null;
  const elapsed=()=>{const now=clock();if(!Number.isFinite(now)||now<previousTime)stop('CPQ_INTEGRITY');previousTime=now;return Math.ceil(now-start);};
  const tick=(s:PilotState)=>{s.wallMs=elapsed();s.controllerPeakRss=Math.max(s.controllerPeakRss,process.memoryUsage().rss);const c=process.cpuUsage(cpuStart);s.cpuMicros=c.user+c.system;};
  const put=(kind:string,bytes:string)=>{store.check();const ref=store.output.put(kind,bytes);if(store.output.read(ref).toString('utf8')!==bytes)stop('CPQ_INTEGRITY');return ref;};
  shadow={version:'CorpusTeacherState/0.1',spec,status:'ACTIVE',code:null,objectiveRef:put('corpus-teacher-objective',objective),registryRef:put('corpus-teacher-registry',canonical(registry)),planRef:null,attempts:[],units:[],manifestRefs:[],tokenMeasurementRef:null,wallMs:0,controllerPeakRss:process.memoryUsage().rss,cpuMicros:0};store.initialize(shadow);
  const update=(fn:(s:PilotState)=>void)=>{store.update(s=>{fn(s);tick(s);});shadow=store.snapshot()!;};
  const halt=(code:Failure)=>{if(!fence)fence=code;try{update(s=>{s.status='FENCED';s.code=fence;});}catch{/* Authority/integrity failure cannot mint a replacement permission to record the fence. */}};
  const guard=()=>{if(fence)stop(fence);store.check();store.output.read(shadow.objectiveRef);store.output.read(shadow.registryRef);if(shadow.planRef)store.output.read(shadow.planRef);if(ports.signal?.aborted)stop('CPQ_ABORTED');if(elapsed()>=TEACHER_PILOT.runMs)stop('CPQ_DEADLINE');};
  const cas=(s:PilotState,i:number,expected:UnitStatus,next:UnitStatus,change?:(u:UnitState)=>void)=>{const u=s.units[i];if(!u||u.status!==expected||u.unitId!==registry.slots[i]!.unitId)stop('CPQ_INTEGRITY');u.status=next;change?.(u);};
  const quarantine=(i:number,code:Failure)=>update(s=>{const u=s.units[i]!;if(TERMINAL.includes(u.status))stop('CPQ_INTEGRITY');u.status='QUARANTINED';u.code=code;});
  const submit=async(op:PilotOperation,i:number|null,data:unknown,queuedAt:number):Promise<PilotAttempt>=>{
    guard();const body=pilotBody(op,i,data),provider=op==='review'?'deepseek':'together',id=attemptId(op,i),at=elapsed();
    const attempt:PilotAttempt={id,operation:op,ordinal:i,provider,requestRef:put('corpus-teacher-request',body),bodyHash:hash(body),profileDigest:TEACHER_PILOT_DIGEST,consumedAtMs:at,queueWaitMs:Math.max(0,at-queuedAt),serviceMs:null,inputReserved:TEACHER_PILOT.inputReserve,completionReserved:completion(op),reservedMicroUsd:reservation(spec,op),result:null};
    update(s=>{if(s.attempts.some(a=>a.id===id)||s.attempts.filter(a=>a.provider===provider).length>=(provider==='together'?7:6)||s.attempts.reduce((n,a)=>n+a.reservedMicroUsd,0)+attempt.reservedMicroUsd>TEACHER_PILOT.totalMicroUsd)stop('CPQ_BUDGET');if(i!==null)cas(s,i,op==='candidate'?'PLANNED':'CANDIDATE_COMMITTED',op==='candidate'?'GENERATE_CONSUMED':'REVIEW_CONSUMED');s.attempts.push(attempt);});
    const serviceStart=elapsed();let result:ProviderResult|null,sendGranted=false;const signal=AbortSignal.timeout(Math.min(TEACHER_PILOT.requestMs,Math.max(1,TEACHER_PILOT.runMs-elapsed())));
    try{result=await bounded(ports.signal?AbortSignal.any([signal,ports.signal]):signal,TEACHER_PILOT.requestMs,inner=>ports.transport({provider,operation:op,ordinal:i,body,output:store.output,signal:inner,authorizeSend:send=>{guard();inner.throwIfAborted();if(sendGranted)stop('CPQ_INTEGRITY');sendGranted=true;return store.authorizeSend(send);}}));copyJson(result);if(!sendGranted)stop('CPQ_INTEGRITY');if(result.usage){integer(result.usage.input);integer(result.usage.completion);if(result.usage.reasoning!==null)integer(result.usage.reasoning,0,result.usage.completion);}}catch{result=null;}
    // Settle consumed calls even after another lane fences; acceptance remains closed.
    update(s=>{const a=s.attempts.find(a=>a.id===id);if(!a||a.result||a.serviceMs!==null)stop('CPQ_INTEGRITY');a.result=result;a.serviceMs=Math.max(0,elapsed()-serviceStart);if(i!==null&&op==='candidate')s.units[i]!.generated=result?.contentPresent===true;});
    if(!result||result.outcome==='SUBMIT_UNKNOWN'){if(i!==null)update(s=>{s.units[i]!.status='SUBMIT_UNKNOWN';s.units[i]!.code='CPQ_SUBMIT_UNKNOWN';});halt('CPQ_SUBMIT_UNKNOWN');}
    else if(!result.usage)halt('CPQ_USAGE_UNKNOWN');
    else if(result.usage.input>attempt.inputReserved||result.usage.completion>attempt.completionReserved)halt('CPQ_BUDGET');
    else if(result.requestedModel!==MODELS[provider]||result.returnedModel!==MODELS[provider]||result.responseFailureCode==='ARTIFACT_WRITE_FAILED')halt('CPQ_INTEGRITY');
    return shadow.attempts.find(a=>a.id===id)!;
  };
  let plan:PilotPlan;
  try{
    const a=await submit('plan',null,{currentApprovedObjective:objective,slots:coordinatorSlots(registry)},0);
    if(fence)return teacherPilotSummary(shadow,fence);
    if(a.result?.outcome!=='COMPLETED'||!a.result.finalRef){halt('CPQ_PLAN_INVALID');return teacherPilotSummary(shadow,fence);}
    try{plan=validatePlan(parsePilotJson(store.output.read(a.result.finalRef).toString('utf8')),registry);}catch(e){halt(e instanceof Wf1Error&&e.code==='CPQ_SOURCE'?'CPQ_SOURCE':'CPQ_PLAN_INVALID');return teacherPilotSummary(shadow,fence);}
    const planRef=put('corpus-teacher-plan',canonical(planProjection(plan)));update(s=>{s.planRef=planRef;s.units=plan.units.map(u=>({ordinal:u.ordinal,unitId:u.unitId,status:'PLANNED',candidateRef:null,candidateDigest:null,reviewRef:null,rowRef:null,code:null,generated:false,structurallyValid:false,modelReviewAccepted:false,queuedAtMs:s.wallMs,reviewQueuedAtMs:null}));});
  }catch(e){halt(globalCode(e));return teacherPilotSummary(shadow,fence);}
  const processUnit=async(op:'candidate'|'review',i:number)=>{
    try{
      const unit=plan.units[i]!,u=shadow.units[i]!;
      const candidate=op==='review'?validateCandidate(read(store.output,u.candidateRef!,'corpus-teacher-candidate'),unit):null;
      const a=await submit(op,i,op==='candidate'?{unit}:{unit,candidate,candidateDigest:u.candidateDigest},op==='candidate'?u.queuedAtMs:u.reviewQueuedAtMs!);
      if(shadow.units[i]!.status==='SUBMIT_UNKNOWN')return;
      if(fence){quarantine(i,'CPQ_LATE_AFTER_FENCE');return;}
      if(a.result?.outcome!=='COMPLETED'||!a.result.finalRef){quarantine(i,'CPQ_OUTPUT');return;}
      const raw=store.output.read(a.result.finalRef).toString('utf8');
      if(op==='candidate'){
        let parsed:PilotCandidate;try{parsed=validateCandidate(raw,unit);}catch(e){quarantine(i,localCode(e));return;}
        const bodyDigest=contentDigest(parsed);
        if(registry.priorContentDigests.includes(bodyDigest)||shadow.units.some(other=>other.ordinal!==i&&other.candidateDigest===bodyDigest)){update(s=>{s.units[i]!.structurallyValid=true;});quarantine(i,'CPQ_DUPLICATE');return;}
        const candidateRef=put('corpus-teacher-candidate',canonical(parsed));update(s=>cas(s,i,'GENERATE_CONSUMED','CANDIDATE_COMMITTED',v=>{v.candidateRef=candidateRef;v.candidateDigest=bodyDigest;v.structurallyValid=true;v.reviewQueuedAtMs=elapsed();}));
      }else{
        let review;try{review=validateReview(raw,unit,u.candidateDigest!);}catch(e){quarantine(i,localCode(e));return;}
        const reviewRef=put('corpus-teacher-review',canonical(review));update(s=>cas(s,i,'REVIEW_CONSUMED','REVIEW_COMMITTED',v=>{v.reviewRef=reviewRef;v.modelReviewAccepted=review.disposition==='ACCEPT';}));
        if(review.disposition!=='ACCEPT'){quarantine(i,'CPQ_MODEL_REJECTED');return;}
        guard();const teacher=shadow.attempts.find(a=>a.id===attemptId('candidate',i))!;
        const row:PilotRow={version:'QualifiedTeacherItem/0.1',runId:spec.runId,unit:registry.slots[i]!,candidate:candidate!,candidateDigest:u.candidateDigest!,planRef:shadow.planRef!,candidateRef:u.candidateRef!,reviewRef,evidenceClass:'MODEL_REVIEWED',generated:true,structurallyValid:true,modelReviewAccepted:true,exactVerified:false,dataGateAccepted:true,manualChecked:false,trainingReady:false,teacher:provenance(teacher),reviewer:provenance(a)};
        const rowRef=put('corpus-teacher-row',canonical(row));const prior=shadow.manifestRefs.at(-1);const oldRefs=prior?(parsePilotJson(read(store.output,prior,'corpus-teacher-manifest')) as unknown as PilotManifest).rowRefs:[];
        const rowRefs=[...oldRefs,rowRef],rows=rowRefs.map(r=>parsePilotJson(read(store.output,r,'corpus-teacher-row')) as unknown as PilotRow),shardRef=put('corpus-teacher-jsonl',rows.map(r=>canonical(r)+'\n').join(''));
        const manifestRef=put('corpus-teacher-manifest',canonical(rowManifest(spec,shadow.planRef!,rows,rowRefs,prior??null,shadow.manifestRefs.length+1,shardRef)));
        guard();update(s=>{cas(s,i,'REVIEW_COMMITTED','ACCEPTED',v=>{v.rowRef=rowRef;});s.manifestRefs.push(manifestRef);});
      }
    }catch(e){if(e instanceof Wf1Error&&e.code==='CPQ_LENGTH'&&!TERMINAL.includes(shadow.units[i]!.status))try{quarantine(i,'CPQ_LENGTH');}catch(error){halt(globalCode(error));}else halt(globalCode(e));}
  };
  // Two independent bounded queues, fixed phases. Reviews have first opportunity to drain.
  for(const [indices,caps] of [[[0,1],{together:1,deepseek:1,total:2}],[[2,3,4,5],{together:2,deepseek:2,total:3}]] as const){
    const running=new Map<string,{provider:Provider;promise:Promise<void>}>();
    while(true){
      if(!fence)try{guard();}catch(e){halt(globalCode(e));}
      if(!fence)for(const op of ['review','candidate'] as const)for(const i of indices){
        const provider=op==='review'?'deepseek':'together',expected=op==='review'?'CANDIDATE_COMMITTED':'PLANNED';
        if(shadow.units[i]!.status!==expected||running.size>=caps.total||[...running.values()].filter(r=>r.provider===provider).length>=caps[provider])continue;
        const id=attemptId(op,i),promise=processUnit(op,i).finally(()=>{running.delete(id);});running.set(id,{provider,promise});
      }
      if(running.size===0)break;await Promise.race([...running.values()].map(r=>r.promise));
    }
    if(fence)break;
    if(indices.some(i=>!TERMINAL.includes(shadow.units[i]!.status))){halt('CPQ_INTEGRITY');break;}
  }
  if(!fence)try{update(s=>{s.status='COMPLETED';});}catch(e){halt(globalCode(e));}
  try{return teacherPilotSummary(verifyTeacherPilot(store),fence,store.metrics().diskFinalBytes);}catch(e){halt(globalCode(e));return teacherPilotSummary(shadow,fence);}
}
