import { canonical,hash,integer,stop } from './wf1-json.ts';
import { assembleCycleIndexes } from './corpus-qa-index.ts';
import { validateAuditSelection } from './corpus-qa-types.ts';
import type { AuditSelection } from './corpus-qa-types.ts';
import { sumCycleUsage } from './teaching-cycle-accounting.ts';
import { withVerifiedTeachingCycle } from './teaching-cycle-runner.ts';
import type { TeachingCyclePorts } from './teaching-cycle-runner.ts';
import type { TeachingCycleStore } from './teaching-cycle-store.ts';

type Assembly=ReturnType<typeof assembleCycleIndexes>;
type Tokens={rows:number;studentInputTokens:number;studentLossTokens:number;fullTokens:number};
const empty=():Tokens=>({rows:0,studentInputTokens:0,studentLossTokens:0,fullTokens:0});
/** Pure join only. The caller must obtain both sides through current verified
 * archive capabilities; this function cannot grant source or training rights. */
export function joinQualifiedMeasurements(assembly:Assembly,selections:AuditSelection[]){
  const entries=new Map<string,{sourceJobId:string;entry:AuditSelection['entries'][number]}>(),key=(job:string,unit:string)=>canonical([job,unit]);
  let tokenizerProfileDigest:string|null=null;
  for(const input of selections){const selection=validateAuditSelection(input);if(tokenizerProfileDigest!==null&&selection.source.tokenizerProfileDigest!==tokenizerProfileDigest)stop('TC_REPORT_TOKENIZER');tokenizerProfileDigest=selection.source.tokenizerProfileDigest;for(const entry of selection.entries){const k=key(selection.source.jobId,entry.unit.unitId);if(entries.has(k))stop('TC_REPORT_JOIN');entries.set(k,{sourceJobId:selection.source.jobId,entry});}}
  if(entries.size!==assembly.rows.length)stop('TC_REPORT_JOIN');const train=empty(),dev=empty(),allSelected=empty(),joined:unknown[]=[];
  const add=(target:Tokens,e:AuditSelection['entries'][number])=>{target.rows++;for(const k of ['studentInputTokens','studentLossTokens','fullTokens'] as const)target[k]=integer(target[k]+integer(Number(e.measurement[k])));};
  const seen=new Set<string>();
  for(const row of assembly.rows){const k=key(row.sourceJobId,row.unitId),match=entries.get(k);if(!match||seen.has(k))stop('TC_REPORT_JOIN');seen.add(k);const {entry:e}=match;
    if(canonical({poolId:row.poolId,familyId:row.familyId,split:row.split,rowRef:row.rowRef,rowDigest:row.rowDigest})!==canonical({poolId:e.unit.poolId,familyId:e.unit.familyId,split:e.unit.split,rowRef:e.sourceRowRef,rowDigest:e.rowDigest}))stop('TC_REPORT_JOIN');
    add(allSelected,e);if(row.eligibleForNextExport)add(row.split==='train'?train:dev,e);joined.push({sourceJobId:row.sourceJobId,unitId:row.unitId,rowDigest:row.rowDigest,measurement:e.measurement,eligibleForNextExport:row.eligibleForNextExport,split:row.split});
  }
  return {tokenizerProfileDigest,train,dev,allSelected,joinedMeasurementDigest:hash(canonical(joined)),excluded:{rows:assembly.rows.filter(r=>!r.eligibleForNextExport).length,qaRejected:assembly.rows.filter(r=>r.qaDisposition==='REJECT').length,qaHeldOrUncertain:assembly.rows.filter(r=>['HOLD','UNCERTAIN','NOT_AUDITED'].includes(r.qaDisposition)).length,duplicateRows:assembly.rows.filter(r=>r.duplicateOf!==null).length,crossSplitFamilyHoldRows:assembly.rows.filter(r=>r.familyHold).length,reasonCountsMayOverlap:true}};
}

/** A current-process candidate. A trusted launcher publishes FINAL_COLD_VERIFIED
 * only after a separate process reopens inspect and matches these commitments.
 * No caller-provided boolean or cold JSON upgrades this evidence class. */
export function teachingCycleReport(store:TeachingCycleStore,openIndex:TeachingCyclePorts['openIndex'],checkChildMetadata:TeachingCyclePorts['checkChildMetadata']){
  if(store.spec.version!=='TeachingCycle/0.2')stop('TC_REPORT_PROFILE');
  return withVerifiedTeachingCycle(store,openIndex,checkChildMetadata,verified=>{
  const {state}=verified,complete=state.status==='COMPLETE';
  const bindings={buildDigest:store.spec.buildDigest,specDigest:hash(canonical(store.spec)),planDigest:store.spec.planDigest,stateDigest:hash(canonical(state)),...store.commitment(),indexDigests:verified.digests,measurementDigest:verified.measurementDigest,accountingDigest:hash(canonical(verified.accounting))};
  let qualified:ReturnType<typeof joinQualifiedMeasurements>|null=null,assemblyDigest:string|null=null;
  if(complete){
    if(state.children.some(c=>c.stage!=='COMPLETE')||verified.indexes.length!==state.children.length||verified.accounting.length!==2*state.children.length||state.barriers.length!==new Set(state.children.map(c=>c.microRound)).size)stop('TC_REPORT_INCOMPLETE');
    const assembly=assembleCycleIndexes(verified.indexes,verified.digests,{maxInputs:state.spec.resources.maxChildren,maxRows:state.spec.resources.maxIndexedRows,maxBytes:state.spec.resources.maxIndexBytes});assemblyDigest=hash(canonical(assembly));
    const last=state.barriers.at(-1);if(!last||last.assemblyDigest!==assemblyDigest||canonical(last.indexDigests)!==canonical(verified.digests))stop('TC_REPORT_BARRIER');
    qualified=joinQualifiedMeasurements(assembly,verified.selections.map(s=>s.selection));
  }
  const startedAt=state.timing?.startedAt??null,completedAt=state.timing?.completedAt??null,elapsedMs=complete&&startedAt!==null&&completedAt!==null&&completedAt>startedAt?completedAt-startedAt:null;
  const production=verified.accounting.filter(a=>a.kind==='PRODUCTION'),qa=verified.accounting.filter(a=>a.kind==='QA');
  const report={version:'TeachingCycleReport/0.2',cycleId:store.spec.cycleId,status:complete?'COMPLETE_INDEX_CANDIDATE':'INCOMPLETE',verification:'CURRENT_PROCESS_VERIFIED',publication:'INDEPENDENT_COLD_REQUIRED',bindings:{...bindings,assemblyDigest},qualified,
    usage:{scope:'FROZEN_DERIVATION_OF_VERIFIED_CHILD_STATE',complete,production:sumCycleUsage(production.map(a=>a.usage)),qa:sumCycleUsage(qa.map(a=>a.usage)),total:sumCycleUsage(verified.accounting.map(a=>a.usage))},
    generation:{childrenAccounted:production.length,quarantined:production.reduce((n,a)=>integer(n+a.items.rejected),0)},
    timing:{boundary:'CYCLE_START_TO_FINAL_INDEX_BARRIER',evidence:'TRUSTED_HOST_CLOCK_OBSERVATIONS',startedAt,completedAt,elapsedMs,qualifiedTrainLossTokensPerMinute:qualified&&elapsedMs!==null?qualified.train.studentLossTokens*60000/elapsedMs:null,independentColdVerificationMs:null},
    observedNativePeakConcurrency:null,observedHostPeakRss:null,evidenceClass:'MODEL_OPINION',factualTruth:'UNKNOWN',comparison:'EXACT_NORMALIZED_PROMPT_ONLY',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'};
  return {...report,reportDigest:hash(canonical(report))};
  });
}
