import { artifactRef } from './wf1-contract.ts';
import { canonical,copyJson,hash,parseJson,shape,stop } from './wf1-json.ts';
import type { ArtifactRef } from './wf1-types.ts';
import { measureBoundCorpusText,validateTokenizerProfile } from './corpus-tokenizer.ts';
import type { CorpusTokenMeasurement,CorpusTokenizerProfile } from './corpus-tokenizer.ts';
import { STUDENT_TARGET } from './corpus-teacher-types.ts';
import type { PilotManifest,PilotRow } from './corpus-teacher-types.ts';
import { verifyTeacherPilot } from './corpus-teacher-pilot.ts';
import type { TeacherPilotStore } from './corpus-teacher-store.ts';

type Receipt={version:'CorpusTeacherTokenReceipt/0.1';manifestRef:ArtifactRef;studentTargetDigest:string;profile:CorpusTokenizerProfile;evidenceClass:'MODEL_REVIEWED';measurements:CorpusTokenMeasurement[];trainingReady:false;trainingJobPolicy:'NOT_AUTHORIZED';packing:'OFF';trainingComputePrecision:null;actualTrainerParity:'NOT_RUN'};
/** Only a verified current pilot manifest enters this text-pair path. The reused worker
 * measures token IDs/masks; it does not promote MODEL_REVIEWED content to exact evidence. */
function compute(store:TeacherPilotStore,profileInput:unknown,pythonPath:string):Receipt {
  const state=verifyTeacherPilot(store),profile=validateTokenizerProfile(profileInput),manifestRef=state.manifestRefs.at(-1);if(!manifestRef)stop('CPQ_NO_ACCEPTED_ROWS');
  if(profile.model!==STUDENT_TARGET.repo||profile.revision!==STUDENT_TARGET.revision)stop('CPQ_TOKENIZER_IDENTITY');
  const manifest=parseJson(store.output.read(manifestRef).toString('utf8')) as unknown as PilotManifest;
  const measurements=manifest.rowRefs.map(ref=>{
    store.check(false);const row=parseJson(store.output.read(ref).toString('utf8')) as unknown as PilotRow;
    if(row.evidenceClass!=='MODEL_REVIEWED'||row.exactVerified!==false||row.trainingReady!==false||!row.dataGateAccepted)stop('CPQ_TOKENIZER_ROW');
    const result=measureBoundCorpusText({rowDigest:hash(canonical(row)),user:row.candidate.prompt,assistant:row.candidate.response},profile,pythonPath);store.check(false);return result;
  });
  return {version:'CorpusTeacherTokenReceipt/0.1',manifestRef,studentTargetDigest:state.spec.studentTargetDigest,profile,evidenceClass:'MODEL_REVIEWED',measurements,trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED',packing:'OFF',trainingComputePrecision:null,actualTrainerParity:'NOT_RUN'};
}
function summary(r:Receipt){return {version:'CorpusTeacherTokenSummary/0.1',rows:r.measurements.length,evidenceClass:r.evidenceClass,studentInputTokens:r.measurements.reduce((n,m)=>n+Number(m.studentInputTokens),0),studentLossTokens:r.measurements.reduce((n,m)=>n+Number(m.studentLossTokens),0),fullTokens:r.measurements.reduce((n,m)=>n+Number(m.fullTokens),0),tokenizerProfileDigest:hash(canonical(r.profile)),measurementStatus:'LOCAL_PINNED_EXACT',officialPipelineParity:'NOT_VALIDATED',actualTrainerParity:'NOT_RUN',packing:'OFF',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'};}
export function measureTeacherPilotTokens(store:TeacherPilotStore,profile:unknown,pythonPath:string){
  store.check();const state=verifyTeacherPilot(store);if(state.tokenMeasurementRef){const receipt=parseJson(store.output.read(state.tokenMeasurementRef).toString('utf8')) as unknown as Receipt;if(canonical(receipt.profile)!==canonical(validateTokenizerProfile(profile))||canonical(receipt.manifestRef)!==canonical(state.manifestRefs.at(-1)))stop('CPQ_TOKENIZER_CONFLICT');return {measurementRef:state.tokenMeasurementRef,summary:summary(receipt)};}
  const receipt=compute(store,profile,pythonPath);store.check();const bytes=canonical(receipt),measurementRef=store.output.put('corpus-teacher-token-measurement',bytes);if(!store.output.read(measurementRef).equals(Buffer.from(bytes)))stop('CPQ_INTEGRITY');store.check();store.update(s=>{if(s.tokenMeasurementRef)stop('CPQ_TOKENIZER_CONFLICT');s.tokenMeasurementRef=measurementRef;});return {measurementRef,summary:summary(receipt)};
}
export function verifyTeacherPilotTokens(store:TeacherPilotStore,refInput:ArtifactRef,profile:unknown,pythonPath:string){
  const ref=artifactRef(copyJson(refInput));if(ref.kind!=='corpus-teacher-token-measurement'||ref.partition!=='train')stop('CPQ_TOKENIZER_RECEIPT');
  if(canonical(store.snapshot()?.tokenMeasurementRef)!==canonical(ref))stop('CPQ_TOKENIZER_RECEIPT');
  const saved=shape(parseJson(store.output.read(ref).toString('utf8')),['version','manifestRef','studentTargetDigest','profile','evidenceClass','measurements','trainingReady','trainingJobPolicy','packing','trainingComputePrecision','actualTrainerParity']);
  const actual=compute(store,profile,pythonPath);if(canonical(saved)!==canonical(actual))stop('CPQ_TOKENIZER_RECEIPT');return summary(actual);
}
