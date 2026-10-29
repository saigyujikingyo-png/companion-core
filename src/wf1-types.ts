/** WF1 is teacher calibration. No Student inference, training or public data publication. */
import type { FailureDiagnostic } from './wf2-failure-diagnostic.ts';
import type { ResponseFailureCode } from './wf2-response-diagnostic.ts';
import type { UsageParseCode } from './wf1-usage-diagnostic.ts';
export type Json = null|boolean|number|string|Json[]|{[key:string]:Json};
export type Provider = 'deepseek'|'together';
export type Operation = 'seal'|'plan'|'rubric'|'candidate'|'review'|'comparison_candidate'|'comparison_review';
export type Phase = 'pilot'|'comparison';
export type Outcome = 'COMPLETED'|'INCOMPLETE_OUTPUT'|'FAILED'|'SUBMIT_UNKNOWN';
export type Authority = { schemaVersion:'wf1-host/1'; campaignId:string; revision:number; runtimeId:string;
  status:'ACTIVE'|'PAUSED'|'REVOKED'; expiresAt:number; head:string|null;
  rights:{seal:boolean;coordinate:boolean;generate:boolean;review:boolean;retain:boolean} };
export type Price = { snapshotId:string; inputMicroUsdPerMillion:number; completionMicroUsdPerMillion:number };
export type CampaignVersion='wf1-campaign/0.3'|'wf1-campaign/0.4'|'wf1-campaign/0.5'|'wf1-campaign/0.6'|'wf1-campaign/0.7'|'wf1-campaign/0.8';
export type CampaignSpec = { id:string; createdAt:number; expiresAt:number;
  sourceDigest:string; profileDigest:string; objectiveDigest:string; prices:Record<Provider,Price> } &
  ({schemaVersion:'wf1-campaign/0.3'|'wf1-campaign/0.4';storageBindingDigest?:never}|{schemaVersion:'wf1-campaign/0.5'|'wf1-campaign/0.6'|'wf1-campaign/0.7'|'wf1-campaign/0.8';storageBindingDigest:string});
export type ArtifactRef = { id:string; kind:string; partition:'custody'|'train'; bytes:number; digest:string };
export type Usage = { input:number; completion:number; reasoning:number|null };
export type ProviderResult = { outcome:Outcome; requestedModel:string; returnedModel:string|null; requestId:string|null;
  transportLane:'SYNTHETIC_FIXTURE'|'NATIVE_FETCH';
  httpStatus:number|null; failure:'TRANSPORT_UNKNOWN'|'HTTP_STATUS'|'RESPONSE_LIMIT'|'RESPONSE_PROTOCOL'|'MODEL_IDENTITY'|'INCOMPLETE_FINAL'|null;
  finishReason:string|null; reasoningPresent:boolean; contentPresent:boolean; usage:Usage|null;
  rawRef:ArtifactRef|null; reasoningRef:ArtifactRef|null; finalRef:ArtifactRef|null; elapsedMs:number;
  payloadOrigin?:'STRICT_TOOL_ARGUMENTS'|'NAMED_TOOL_ARGUMENTS'|'NATIVE_FINAL';argumentsRef?:ArtifactRef|null;responseFailureCode?:ResponseFailureCode;usageParseCode?:UsageParseCode;retryAfterMs?:number|null;retryAfterStatus?:'MISSING'|'VALID'|'INVALID' };
export type RequestBinding={protocol:'DEEPSEEK_STRICT_DATA_ARGS_V1'|'DEEPSEEK_NAMED_DATA_ARGS_V1'|'NATIVE_JSON_FINAL_V1'|'TOGETHER_SCHEMA_FINAL_V1'|'UNIT_TOGETHER_SCHEMA_FINAL_V1'|'UNIT_DEEPSEEK_JSON_FINAL_V1'|'CORPUS_TOGETHER_SCHEMA_V1'|'CORPUS_DEEPSEEK_JSON_V1'|'CORPUS_PRODUCTION_DEEPSEEK_V1'|'CORPUS_PRODUCTION_DEEPSEEK_V2'|'CORPUS_QUALITY_AUDIT_NATIVE_V1'|'CORPUS_QUALITY_AUDIT_NATIVE_V2';endpoint:string;toolName:string|null;schemaDigest:string;payloadCodec?:'WF2_FIXED_SLOTS_V1'|'WF2_CANONICAL_V1'|'WF2_UNIT_V1'|'CORPUS_TEACHER_V1'|'CORPUS_PRODUCTION_V1'|'CORPUS_PRODUCTION_V2'|'CORPUS_QUALITY_AUDIT_V1'|'CORPUS_QUALITY_AUDIT_V2';profileDigest?:string;unitIndex?:number|null};
export type Attempt = { id:string; operation:Operation; provider:Provider; phase:Phase; requestCommitment:string;
  requestRef:ArtifactRef;requestBinding?:RequestBinding;unitIndex?:number|null;
  familyId:string|null; startedAt:number; deadline:number; inputReserved:number; completionReserved:number;
  estimatedMicroUsdReserved:number; outcome:Outcome|null; result:ProviderResult|null };
export type FormalSpec = { verifier:'rational.evaluate.v1'|'json.pointer.v1'; input:Json };
export type FormalEvidence = { status:'VERIFIED'|'CONTRADICTED'|'UNSUPPORTED';
  claimScope:'EXACT_RATIONAL'|'JSON_SELECTED_SUBTREE'|'NONE'; selectedTargetCoverage:'COMPLETE'|'NONE';
  inputCommitment:string; targetCommitment:string; verifierBuild:string };
export type Family = { id:string; roots:string[]; split:'train'|'dev'; formal:FormalSpec };
export type Plan = { version:'wf1-plan/1'; plan:string; families:Family[]; pairedFamilyIds:string[] };
export type Seal = { version:'wf1-seal/1'; rubric:string; cases:Array<{id:string;roots:string[];formal:FormalSpec;target:Json}> };
export type Candidate = { id:string; provider:Provider; familyId:string; targetRef:ArtifactRef|null;
  exclusion:'CLEAR'|'BLOCKED'; evidence:FormalEvidence; review:'CLEAR'|'FLAG'|'UNKNOWN';
  disposition:'DETERMINISTICALLY_VERIFIED'|'QUARANTINE';reviewBinding?:{provider:'deepseek';model:string} };
export type CampaignState = { spec:CampaignSpec; authorityRevision:number; runtimeId:string; createdAt:number;
  transportLane:'UNBOUND'|'SYNTHETIC_FIXTURE'|'NATIVE_FETCH';manifestRows:number|null;
  status:'ACTIVE'|'PAUSED'|'REVOKED'|'STOPPED'|'COMPLETED'; phase:Phase;
  sealRef:ArtifactRef|null; objectiveRef:ArtifactRef|null; planRef:ArtifactRef|null; rubricRef:ArtifactRef|null;
  attempts:Attempt[]; candidates:Candidate[]; exclusions:Array<{candidateId:string;commitment:string;result:'CLEAR'|'BLOCKED'}>;
  sealUnits?:ArtifactRef[];planUnits?:ArtifactRef[];manifestRef:ArtifactRef|null; code:string|null; phaseStartedAt:number; failureDiagnostic?:FailureDiagnostic };
export const WF1 = Object.freeze({ profileVersion:'wf1-profile/0.3',requestBytes:16_384,responseBytes:262_144,artifactBytes:262_144,runBytes:67_108_864,
  inputReserve:18_432,deepseekCompletion:2_048,deepseekBootstrapCompletion:4_096,togetherCompletion:4_096,deepseekCalls:44,togetherCalls:8,
  pilotCalls:36,comparisonCalls:16,deepseekMicroUsd:400_000,togetherMicroUsd:100_000,totalMicroUsd:500_000,
  campaignMs:3_600_000,pilotMs:1_800_000,comparisonMs:1_200_000,requestMs:120_000,sealFamilies:12,pilotFamilies:16,pairedFamilies:8 });
export const MODELS:Readonly<Record<Provider,string>>=Object.freeze({deepseek:'deepseek-flash',together:'openai/gpt-oss-120b'});
export const ENDPOINTS:Readonly<Record<Provider,string>>=Object.freeze({deepseek:'https://api.deepseek.com/chat/completions',together:'https://api.together.ai/v1/chat/completions'});
export function completionCap(provider:Provider,operation:Operation):number {return provider==='together'?WF1.togetherCompletion:operation==='seal'||operation==='plan'?WF1.deepseekBootstrapCompletion:WF1.deepseekCompletion;}
