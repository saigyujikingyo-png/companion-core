import { dirname,isAbsolute,relative,sep } from 'node:path';
import { canonical,copyJson,hash,id,integer,list,oneOf,parseJson,shape,stop,text,unique } from './wf1-json.ts';
import { estimateMicroUsd,validatePlan,validateSpec } from './wf1-contract.ts';
import { CampaignLedger,createArtifactBroker,HostAuthority,privateRoot } from './wf1-storage.ts';
import { verifyFormal } from './wf1-verifier.ts';
import { teacherWorkerBuildDigest } from './wf2-teacher-build.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import { latestResponseFailure } from './wf2-response-diagnostic.ts';
import { pilotMetadataProfile,validatePilotPlan } from './wf2-together-pilot.ts';
import type { CampaignState,Plan,Provider } from './wf1-types.ts';

export function verifyTeacherManifest(state:CampaignState,plan:Plan,raw:unknown){
  const pilot=state.spec.schemaVersion==='wf1-campaign/0.7';if(pilot)validatePilotPlan(plan);
  const manifest=shape(raw,['version','publication','studentInference','studentTraining','rows',...(pilot?['scope','remainingFamilies','pairedComparison','reviewClass']:[])]);
  if(manifest.version!==(pilot?'wf2-private-pilot-manifest/1':'wf1-private-manifest/1')||manifest.publication!=='NOT_AUTHORIZED'||manifest.studentInference!=='NOT_RUN'||manifest.studentTraining!=='NOT_RUN')stop('WF2_MANIFEST_PROTOCOL');
  if(pilot&&(manifest.scope!=='PILOT_ONLY'||manifest.remainingFamilies!=='NOT_RUN'||manifest.pairedComparison!=='NOT_RUN'||manifest.reviewClass!=='MODEL_REVIEW_ONLY'||state.manifestRows!==4||state.candidates.length!==4))stop('WF2_PILOT_MANIFEST');
  const rows=list(manifest.rows,24),seen=new Set<string>(),splits={train:0,dev:0};if(rows.length!==state.manifestRows)stop('WF2_MANIFEST_COUNT');
  for(const value of rows){
    const row=shape(value,['familyId','roots','split','provider','projection','selectedTargetCoverage']),familyId=id(row.familyId),roots=list(row.roots,16,1).map(id);unique(roots);
    const split=oneOf(row.split,['train','dev']),provider=oneOf(row.provider,['deepseek','together']),projection=shape(row.projection,['tool','input','typedTarget']);
    if(['wf1-campaign/0.5','wf1-campaign/0.6','wf1-campaign/0.7'].includes(state.spec.schemaVersion)&&projection.tool!=='rational.evaluate.v1')stop('WF2_RATIONAL_ONLY');
    if(pilot&&provider!=='together')stop('WF2_PILOT_PROVIDER');
    const family=plan.families.find(f=>f.id===familyId);if(!family||split!==family.split||canonical(roots)!==canonical(family.roots)||canonical({verifier:projection.tool,input:projection.input})!==canonical(family.formal))stop('WF2_MANIFEST_PLAN');
    if(row.selectedTargetCoverage!=='COMPLETE')stop('WF2_MANIFEST_COVERAGE');const evidence=verifyFormal({verifier:projection.tool,input:projection.input},projection.typedTarget);if(evidence.status!=='VERIFIED')stop('WF2_MANIFEST_ORACLE');
    const candidate=state.candidates.find(c=>c.provider===provider&&c.familyId===familyId);
    if(!candidate||candidate.disposition!=='DETERMINISTICALLY_VERIFIED'||candidate.review!=='CLEAR'||candidate.exclusion!=='CLEAR'||candidate.evidence.inputCommitment!==evidence.inputCommitment||candidate.evidence.targetCommitment!==evidence.targetCommitment||!state.exclusions.some(e=>e.candidateId===candidate.id&&e.result==='CLEAR'&&e.commitment===hash(canonical(projection))))stop('WF2_MANIFEST_SOURCE');
    const fingerprint=hash(canonical(projection));if(seen.has(fingerprint))stop('WF2_MANIFEST_DUPLICATE');seen.add(fingerprint);splits[split]++;
  }
  if(pilot&&(rows.length!==4||seen.size!==4||splits.train!==3||splits.dev!==1||canonical(rows.map(r=>id((r as Record<string,unknown>).familyId)).sort())!==canonical(plan.families.slice(0,4).map(f=>f.id).sort())))stop('WF2_PILOT_MANIFEST');
  return {status:'VERIFIED' as const,rows:rows.length,uniqueRows:seen.size,splitCounts:splits};
}
/** Trusted admin only. No provider credentials, execution constructor, sealed read or automatic recovery. */
export function inspectTeacherCampaign(bootstrap:unknown,now=()=>Date.now()){
  const own=copyJson(bootstrap),v2=own!==null&&typeof own==='object'&&!Array.isArray(own)&&own.version==='wf2-teacher-inspect/2';
  const b=shape(own,['version','runtimeRoot','authorityPath','expectedHead','spec','custodyKeyBase64',...(v2?['approvedTrainingRoot']:[])]);if(b.version!=='wf2-teacher-inspect/1'&&!v2)stop('WF2_INSPECT_VERSION');
  const spec=validateSpec(b.spec);if(v2?!['wf1-campaign/0.5','wf1-campaign/0.6','wf1-campaign/0.7'].includes(spec.schemaVersion):spec.schemaVersion!=='wf1-campaign/0.4')stop('WF2_TEACHER_PROFILE_NOT_ADMITTED');if(spec.sourceDigest!==teacherWorkerBuildDigest())stop('WF2_BUILD_MISMATCH');
  const root=privateRoot(text(b.runtimeRoot,4096)),authorityPath=text(b.authorityPath,4096);privateRoot(dirname(authorityPath));const rel=relative(root,authorityPath);if(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))stop('WF1_AUTHORITY_PATH');
  const storageGuard=v2?()=>{requireTrainingBinding(b.approvedTrainingRoot,root,spec.storageBindingDigest,authorityPath);}:undefined;storageGuard?.();
  const host=new HostAuthority(authorityPath,spec.id,now),authority=host.read(now(),false);if(b.expectedHead!==authority.head||authority.head===null)stop('WF1_HEAD_MISMATCH');
  const encoded=text(b.custodyKeyBase64,64),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)stop('WF1_KEY');let ledger:CampaignLedger|undefined;
  try{
    ledger=CampaignLedger.inspect(root,authorityPath,spec.id,key,now);const state=ledger.snapshot();if(canonical(state.spec)!==canonical(spec))stop('WF2_INSPECT_SPEC');
    const providers=Object.fromEntries((['deepseek','together'] as const).map((provider:Provider)=>{
      const attempts=state.attempts.filter(a=>a.provider===provider),known=attempts.filter(a=>a.result?.usage!==null&&a.result?.usage!==undefined);
      const usage=known.reduce((out,a)=>{const u=a.result!.usage!;out.input+=u.input;out.completion+=u.completion;out.estimatedUsageMicroUsd+=estimateMicroUsd(u.input,u.completion,state.spec.prices[provider]);if(u.reasoning===null)out.reasoningUnknown++;else out.reasoning+=u.reasoning;return out;},{input:0,completion:0,reasoning:0,reasoningUnknown:0,estimatedUsageMicroUsd:0});
      return [provider,{calls:attempts.length,knownUsageCalls:known.length,unknownUsageCalls:attempts.length-known.length,...usage,estimatedReserveMicroUsd:attempts.reduce((n,a)=>n+a.estimatedMicroUsdReserved,0)}];
    }));
    let manifestVerification:{status:'NOT_READ'|'VERIFIED'|'INVALID_OR_UNAVAILABLE';rows:number|null;uniqueRows:number|null;splitCounts:{train:number;dev:number}|null}={status:'NOT_READ',rows:null,uniqueRows:null,splitCounts:null};
    if(state.status==='COMPLETED'&&authority.status==='ACTIVE'&&state.manifestRef){
      try{if(state.manifestRef.kind!==(spec.schemaVersion==='wf1-campaign/0.7'?'private-pilot-manifest':'private-dataset-manifest')||state.manifestRef.partition!=='train'||!state.planRef||state.planRef.partition!=='train')stop('WF2_MANIFEST_PARTITION');
        const train=createArtifactBroker(root,spec.id,key,storageGuard).train,decode=(bytes:Buffer)=>parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),plan=validatePlan(decode(train.read(state.planRef)));
        if(v2&&plan.families.some(f=>f.formal.verifier!=='rational.evaluate.v1'))stop('WF2_RATIONAL_ONLY');
        manifestVerification=verifyTeacherManifest(state,plan,decode(train.read(state.manifestRef)));
      }catch{manifestVerification={status:'INVALID_OR_UNAVAILABLE',rows:null,uniqueRows:null,splitCounts:null};}
    }
    // A changed head or revoked authority during readback invalidates this entire observation.
    storageGuard?.();ledger.snapshot();host.read(now(),false);if(state.manifestRows!==null)integer(state.manifestRows,0,24);
    return {version:spec.schemaVersion==='wf1-campaign/0.7'?'wf2-teacher-inspection/3':'wf2-teacher-inspection/2',...(spec.schemaVersion==='wf1-campaign/0.7'?{profile:pilotMetadataProfile()}:{}),status:'RECORDED_CLAIMS_ONLY',countCompleteness:'RECORDED_CLAIMS_ONLY',recordedCampaignStatus:state.status,authorityStatus:authority.status,responseFailureCode:latestResponseFailure(state.attempts,true),
      providers,candidates:{deepseek:state.candidates.filter(c=>c.provider==='deepseek').length,together:state.candidates.filter(c=>c.provider==='together').length,qualified:state.candidates.filter(c=>c.disposition==='DETERMINISTICALLY_VERIFIED').length,quarantined:state.candidates.filter(c=>c.disposition==='QUARANTINE').length},
      uniqueManifestRows:state.manifestRows,manifestRecorded:state.manifestRef!==null,manifestVerification,actualInvoice:'UNKNOWN',estimatedCostBasis:'FROZEN_DECLARED_PROVIDER_PRICES',automaticResume:false,studentInference:'NOT_RUN',studentTraining:'NOT_RUN',publication:'NOT_AUTHORIZED'};
  }finally{ledger?.close();key.fill(0);}
}
