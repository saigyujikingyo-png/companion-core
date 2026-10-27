import { artifactRef } from './wf1-contract.ts';
import { canonical,copyJson,digest,hash,id,integer,oneOf,parseJson,shape,stop,text,unique } from './wf1-json.ts';
import { verifyFormal } from './wf1-verifier.ts';
import { UNIT_SCHEDULE,unitBinding,unitBody,unitCompletion,unitPayload,unitProvider,validatePlanUnit,WF2_UNIT_POLICY,WF2_UNIT_PROFILE_DIGEST } from './wf2-unit-pilot.ts';
import type { CampaignLedger,ArtifactPort } from './wf1-storage.ts';
import type { ArtifactRef,Attempt,Json } from './wf1-types.ts';
import type { CorpusEvidence,CorpusModelProvenance,CorpusRow,CorpusSelection,SelectedReader } from './corpus-types.ts';

function ref(input:unknown,kind:string):ArtifactRef {const r=artifactRef(copyJson(input));if(r.partition!=='train'||r.kind!==kind)stop('CP0_READ_SCOPE');return r;}
function same(a:unknown,b:unknown):void {if(canonical(a)!==canonical(b))stop('CP0_EVIDENCE_BINDING');}
function attempt(input:unknown,operation:'candidate'|'review'):Attempt {
  const a=shape(input,['id','operation','provider','phase','requestCommitment','requestRef','familyId','startedAt','requestBinding','unitIndex','deadline','inputReserved','completionReserved','estimatedMicroUsdReserved','outcome','result']);
  id(a.id);id(a.familyId);integer(a.startedAt);integer(a.deadline);digest(a.requestCommitment);ref(a.requestRef,'provider-request');
  if(a.operation!==operation||a.outcome!=='COMPLETED'||!a.result)stop('CP0_QUALIFICATION');
  const r=shape(a.result,['outcome','requestedModel','returnedModel','requestId','transportLane','httpStatus','failure','finishReason','reasoningPresent','contentPresent','usage','rawRef','reasoningRef','finalRef','elapsedMs','payloadOrigin','responseFailureCode','argumentsRef']);
  const model=operation==='candidate'?WF2_UNIT_POLICY.teacher.model:WF2_UNIT_POLICY.reviewer.model;
  if(r.outcome!=='COMPLETED'||r.requestedModel!==model||r.returnedModel!==model||r.failure!==null||r.httpStatus!==200||r.finishReason!=='stop'||r.contentPresent!==true||r.payloadOrigin!=='NATIVE_FINAL')stop('CP0_QUALIFICATION');
  ref(r.finalRef,'native-final');oneOf(r.transportLane,['NATIVE_FETCH','SYNTHETIC_FIXTURE']);const usage=shape(r.usage,['input','completion','reasoning']);integer(usage.input);integer(usage.completion);if(usage.reasoning!==null)integer(usage.reasoning);
  return a as Attempt;
}
export function validateSelection(input:unknown):CorpusSelection {
  const s=shape(copyJson(input),['version','sourceCampaignId','sourceLedgerHead','sourceProfileDigest','sourceBuildDigest','sourceArchiveDigest','sourceTerminal','transportLane','candidate','unitIndex','planRef','validatedAggregatePlanRef','planUnitRefs','rubricRef','sealRef','exclusion','generation','review']);
  if(s.version!=='CorpusSelection/0.1'||s.sourceProfileDigest!==WF2_UNIT_PROFILE_DIGEST)stop('CP0_SOURCE');id(s.sourceCampaignId);digest(s.sourceLedgerHead);digest(s.sourceBuildDigest);digest(s.sourceArchiveDigest);
  oneOf(s.sourceTerminal,['STOPPED','COMPLETED']);oneOf(s.transportLane,['SYNTHETIC_FIXTURE','NATIVE_FETCH']);integer(s.unitIndex,0,3);
  ref(s.planRef,'coordinator-plan-unit');ref(s.validatedAggregatePlanRef,'coordinator-unit-plan');
  if(!Array.isArray(s.planUnitRefs)||s.planUnitRefs.length!==4)stop('CP0_SOURCE');const units=s.planUnitRefs.map(r=>ref(r,'coordinator-plan-unit'));unique(units.map(r=>r.id));same(units[s.unitIndex as number],s.planRef);
  ref(s.rubricRef,'independent-review-rubric');const seal=artifactRef(s.sealRef);if(seal.partition!=='custody'||seal.kind!=='sealed-unit-aggregate')stop('CP0_SOURCE');
  const c=shape(s.candidate,['id','provider','familyId','targetRef','exclusion','evidence','review','reviewBinding','disposition']);id(c.id);id(c.familyId);ref(c.targetRef,'candidate-typed-target');
  if(c.provider!=='together'||c.id!=='together:'+c.familyId||c.exclusion!=='CLEAR'||c.review!=='CLEAR'||c.disposition!=='DETERMINISTICALLY_VERIFIED')stop('CP0_QUALIFICATION');
  same(c.reviewBinding,{provider:'deepseek',model:WF2_UNIT_POLICY.reviewer.model});
  const e=shape(c.evidence,['status','claimScope','selectedTargetCoverage','inputCommitment','targetCommitment','verifierBuild']);
  if(e.status!=='VERIFIED'||e.claimScope!=='EXACT_RATIONAL'||e.selectedTargetCoverage!=='COMPLETE')stop('CP0_QUALIFICATION');digest(e.inputCommitment);digest(e.targetCommitment);digest(e.verifierBuild);
  const exclusion=shape(s.exclusion,['candidateId','commitment','result']);if(exclusion.candidateId!==c.id||exclusion.result!=='CLEAR')stop('CP0_EXCLUSION');digest(exclusion.commitment);
  attempt(s.generation,'candidate');attempt(s.review,'review');return s as CorpusSelection;
}
export function selectedRefs(selection:CorpusSelection):ArtifactRef[] {
  const s=validateSelection(selection),refs=[s.planRef,s.rubricRef,s.candidate.targetRef!,s.generation.requestRef,s.generation.result!.finalRef!,s.review.requestRef,s.review.result!.finalRef!];
  unique(refs.map(r=>r.id));return refs;
}
/** Host-only narrowing: accepts a freshly authenticated read-only WF1 ledger, never a q1 summary.
 * No key, custody port, put method, directory scan or arbitrary decrypt is returned to the worker. */
export type ExpectedCorpusSource={campaignId:string;ledgerHead:string;buildDigest:string;profileDigest:string;archiveDigest:string};
export function prepareWf2Harvest(ledger:Pick<CampaignLedger,'snapshot'|'head'>,train:Pick<ArtifactPort,'read'>,candidateId:string,expected:ExpectedCorpusSource){
  id(candidateId);const state=ledger.snapshot();
  const source=shape(copyJson(expected),['campaignId','ledgerHead','buildDigest','profileDigest','archiveDigest']);id(source.campaignId);for(const k of ['ledgerHead','buildDigest','profileDigest','archiveDigest'])digest(source[k]);
  if(state.spec.id!==source.campaignId||ledger.head!==source.ledgerHead||state.spec.sourceDigest!==source.buildDigest||state.spec.profileDigest!==source.profileDigest)stop('CP0_SOURCE_BINDING');
  if(state.spec.schemaVersion!=='wf1-campaign/0.8'||!['STOPPED','COMPLETED'].includes(state.status)||!state.planRef||!state.rubricRef||!state.sealRef)stop('CP0_SOURCE');
  const candidates=state.candidates.filter(c=>c.id===candidateId);if(candidates.length!==1)stop('CP0_QUALIFICATION');const candidate=candidates[0]!;
  // Reject quarantine before deriving or invoking any content capability.
  if(candidate.disposition!=='DETERMINISTICALLY_VERIFIED'||!candidate.targetRef||candidate.review!=='CLEAR'||candidate.exclusion!=='CLEAR')stop('CP0_QUALIFICATION');
  const generation=state.attempts.filter(a=>a.operation==='candidate'&&a.familyId===candidate.familyId),review=state.attempts.filter(a=>a.operation==='review'&&a.familyId===candidate.familyId),exclusions=state.exclusions.filter(e=>e.candidateId===candidate.id);
  if(generation.length!==1||review.length!==1||exclusions.length!==1)stop('CP0_QUALIFICATION');
  const index=integer(generation[0]!.unitIndex,0,3);
  const selection=validateSelection({version:'CorpusSelection/0.1',sourceCampaignId:state.spec.id,sourceLedgerHead:ledger.head,sourceProfileDigest:state.spec.profileDigest,sourceBuildDigest:state.spec.sourceDigest,sourceArchiveDigest:source.archiveDigest,
    sourceTerminal:state.status,transportLane:state.transportLane,candidate,unitIndex:index,planRef:state.planUnits?.[index],validatedAggregatePlanRef:state.planRef,planUnitRefs:state.planUnits,rubricRef:state.rubricRef,sealRef:state.sealRef,exclusion:exclusions[0],generation:generation[0],review:review[0]});
  const expectedSnapshot=hash(canonical(state));
  const check=()=>{if(ledger.head!==selection.sourceLedgerHead||hash(canonical(ledger.snapshot()))!==expectedSnapshot)stop('CP0_SOURCE_CHANGED');};
  const reader=restrictSelectedReader(selection,{read:r=>{check();const bytes=train.read(r);check();return bytes;}});
  return {selection,selectionDigest:hash(canonical(selection)),reader};
}
export function restrictSelectedReader(selection:CorpusSelection,reader:SelectedReader):SelectedReader {
  const allowlist=new Set(selectedRefs(selection).map(canonical));
  return Object.freeze({read(input:ArtifactRef):Buffer {const r=artifactRef(copyJson(input));if(!allowlist.has(canonical(r)))stop('CP0_READ_SCOPE');
    const bytes=reader.read(r);if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>262144)stop('CP0_BYTES');return Buffer.from(bytes);}});
}
export function collectEvidence(selection:CorpusSelection,reader:SelectedReader):CorpusEvidence {
  const narrow=restrictSelectedReader(selection,reader);
  return {version:'CorpusEvidence/0.1',selection:validateSelection(selection),artifacts:selectedRefs(selection).map(sourceRef=>{
    const bytes=narrow.read(sourceRef),content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);parseJson(content);
    return {sourceRef,plaintextDigest:hash(bytes),content};})};
}
function provenance(a:Attempt):CorpusModelProvenance {return {provider:a.provider,requestedModel:a.result!.requestedModel,returnedModel:a.result!.returnedModel!,revision:null,
  protocol:a.requestBinding!.protocol,effort:a.provider==='together'?'medium':'high',finishReason:'stop',usage:a.result!.usage!,usageSource:'PROVIDER_REPORTED'};}
function selectedAttempt(a:Attempt,index:number,familyId:string):void {
  // Same closed schedule fields as validateUnitAttempt, using the original shared policy constants.
  // This variant requires only the selected family, never other units' plan text.
  const expected=UNIT_SCHEDULE[index];if(!expected||a.id!==expected.operation+(expected.unitIndex===null?'':':unit'+expected.unitIndex)||a.estimatedMicroUsdReserved!==(expected.operation==='review'?15360:5223)||a.operation!==expected.operation||a.unitIndex!==expected.unitIndex||a.provider!==unitProvider(expected.operation)||a.phase!=='pilot'||a.inputReserved!==18432||a.completionReserved!==unitCompletion(expected.operation)||canonical(a.requestBinding)!==canonical(unitBinding(a.provider,a.operation,expected.unitIndex))||a.familyId!==familyId)stop('CP0_ATTEMPT_BINDING');
}
/** Re-verifies the selected row and existing review; never evaluates a failed or sealed sample. */
export function verifySelectedEvidence(input:unknown):Omit<CorpusRow,'evidenceRef'> {
  const e=shape(copyJson(input),['version','selection','artifacts']);if(e.version!=='CorpusEvidence/0.1'||!Array.isArray(e.artifacts))stop('CP0_EVIDENCE');
  const selection=validateSelection(e.selection),refs=selectedRefs(selection);if(e.artifacts.length!==refs.length)stop('CP0_READ_SCOPE');
  const contents=new Map<string,string>();for(const [i,value]of e.artifacts.entries()){
    const a=shape(value,['sourceRef','plaintextDigest','content']);same(a.sourceRef,refs[i]);text(a.content,262144);if(hash(a.content as string)!==digest(a.plaintextDigest))stop('CP0_BYTES');contents.set(canonical(a.sourceRef),a.content as string);
  }
  const read=(r:ArtifactRef):Json=>parseJson(contents.get(canonical(r))??stop('CP0_READ_SCOPE'));
  const unit=validatePlanUnit(read(selection.planRef),selection.unitIndex);if(unit.family.id!==selection.candidate.familyId)stop('CP0_EVIDENCE_BINDING');
  selectedAttempt(selection.generation,9+selection.unitIndex*2,unit.family.id);selectedAttempt(selection.review,10+selection.unitIndex*2,unit.family.id);
  const target=read(selection.candidate.targetRef!),formalEvidence=verifyFormal(unit.family.formal,target);same(formalEvidence,selection.candidate.evidence);
  if(formalEvidence.status!=='VERIFIED'||unit.family.formal.verifier!=='rational.evaluate.v1')stop('CP0_ORACLE');
  const projection={tool:'rational.evaluate.v1' as const,input:unit.family.formal.input,typedTarget:target},logicalDigest=hash(canonical(projection));if(logicalDigest!==selection.exclusion.commitment)stop('CP0_EXCLUSION');
  const rubric=shape(read(selection.rubricRef),['version','rubric']);if(rubric.version!=='wf1-rubric/1')stop('CP0_REVIEW');text(rubric.rubric,4096);
  const final=shape(read(selection.generation.result!.finalRef!),['version','target']);if(final.version!=='wf1-candidate/1')stop('CP0_QUALIFICATION');same(final.target,target);
  const review=shape(read(selection.review.result!.finalRef!),['version','disposition','notes']);if(review.version!=='wf1-review/1'||review.disposition!=='CLEAR')stop('CP0_REVIEW');text(review.notes,8192,0);
  const data=[{coordinatorPlan:unit.plan,formalInput:unit.family.formal,selectedTarget:'typed target only; no explanations or Student claims'},
    {rubric,formalInput:unit.family.formal,typedTarget:target,reviewClass:'MODEL_REVIEW_ONLY'}];
  for(const [i,a]of [selection.generation,selection.review].entries()){
    if(a.result!.transportLane!==selection.transportLane)stop('CP0_SOURCE');const raw=contents.get(canonical(a.requestRef))!,expected=unitBody(a.provider,unitPayload(a.operation,data[i]),a.operation,selection.unitIndex);
    if(raw!==expected||hash(raw)!==a.requestCommitment)stop('CP0_REQUEST_BINDING');
  }
  return {version:'QualifiedItem/0.1',id:hash(canonical({campaign:selection.sourceCampaignId,head:selection.sourceLedgerHead,candidate:selection.candidate.id})),kind:'SFT',origin:selection.transportLane==='SYNTHETIC_FIXTURE'?'SYNTHETIC_FIXTURE':'TEACHER',familyId:unit.family.id,roots:unit.family.roots,split:unit.family.split,privacy:'private',parentItemIds:[selection.candidate.id],sourceCampaignId:selection.sourceCampaignId,sourceLedgerHead:selection.sourceLedgerHead,originalCampaignTerminal:selection.sourceTerminal,evidenceClass:'EXACT_VERIFIED',selectedTargetScope:'EXACT_RATIONAL_TYPED_TARGET_ONLY',formalEvidence,projection,
    generated:true,structurallyValid:true,modelReviewAccepted:true,exactVerified:true,dataGateAccepted:true,manualChecked:false,trainingReady:false,sourceRefs:refs,logicalDigest,teacher:provenance(selection.generation),reviewer:provenance(selection.review)};
}
