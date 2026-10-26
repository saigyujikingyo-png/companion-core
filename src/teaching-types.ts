/** WF0 contains metadata only. No type in this module grants execution authority. */
export const TEACHING_LIMITS = Object.freeze({ jsonBytes:1_048_576, jsonDepth:24, jsonNodes:65_536,
  stringUnits:256, objectKeys:32, arrayItems:8_192, documentBytes:65_536, exportBytes:2_097_152,
  candidates:128, registryNodes:2_048, registryEdges:8_192, licenses:2_048, decisions:2_048,
  questionNodes:16, questionDepth:8, questionBranches:2, actualAnswers:8,
  declaredContentBytes:65_536, declaredTokens:32_768, calls:512 });
export type TeachingFrozen<T> = T extends object ? { readonly [K in keyof T]:TeachingFrozen<T[K]> } : T;
export type TeachingRef = { id:string; sha256:string };
export type TeachingAuthority = { authorityId:string; revision:number; runtimeId:string };
export type TeachingDataClass = 'public'|'private';
export type TeachingSplit = 'train'|'dev'|'calibration'|'sealedEval'|'quarantine';
export type TeachingRole = 'ResearchMentor'|'TeachingCoordinator'|'Teacher'|'StudentRunner'|'EvalCustodian';
export type TeachingUse = 'coordinate'|'generate'|'train'|'publish';
export type TeachingUses = Record<TeachingUse,'ALLOW'|'DENY'|'UNKNOWN'>;
export type TeachingDeclaration<T> = TeachingFrozen<{ status:'DECLARATION_VALID_ONLY'; value:T }>;

export type TeacherCapabilityRecord = {
  schemaVersion:'TeacherCapabilityRecord/0.1'; id:string; createdAt:number; expiresAt:number;
  provider:string; region:string; product:string; requestedModelId:string; returnedModelId:string|null;
  immutableRevision:string|null; modelVersionEvidence:TeachingRef|null;
  modalities:Array<'text'|'image'|'video'>;
  capabilities:Record<'text'|'json'|'cancel'|'usage','UNKNOWN'|'DOCUMENTED'|'PROBED'|'ACCEPTED'>;
};
export type SourceLicenseRecord = {
  schemaVersion:'SourceLicenseRecord/0.1'; id:string; sourceNodeId:string; dataClass:TeachingDataClass;
  contractRef:TeachingRef; decisionRef:TeachingRef; declaredUses:TeachingUses;
};
export type QuestionPolicy = {
  schemaVersion:'QuestionPolicy/0.1'; id:string; authority:TeachingAuthority;
  mode:'directExam'|'simulatedUserScenario'|'critique'; policyContentRef:TeachingRef;
  maxDepth:number; maxNodes:number; maxBranches:number; maxActualAnswers:number;
  maxInputTokens:number; maxOutputTokens:number;
};
export type TeachingPlan = {
  schemaVersion:'TeachingPlan/0.1'; id:string; authority:TeachingAuthority; createdAt:number; expiresAt:number;
  coordinatorId:string; coordinatorRole:'TeachingCoordinator'; coordinatorInstructionVersion:string;
  coordinatorContractDecisionRef:TeachingRef; questionPolicyRef:TeachingRef; teacherCapabilityRef:TeachingRef;
  studentSnapshotRef:TeachingRef; sourceFamilyPolicyRef:TeachingRef; contentPolicyRef:TeachingRef;
  dataClass:TeachingDataClass; split:'train'|'dev'; maxCandidates:number; maxCalls:number;
};
export type FamilyNode = {
  id:string; familyId:string; parentIds:string[]; candidateId:string|null; contentDigest:string|null;
  split:TeachingSplit; dataClass:TeachingDataClass; disposition:'retained'|'discarded'; licenseRef:TeachingRef;
};
export type FamilySplitRegistry = {
  schemaVersion:'FamilySplitRegistry/0.1'; id:string; authority:TeachingAuthority; revision:number;
  frozenAt:number; splitPolicyRef:TeachingRef; nodes:FamilyNode[];
};
export type TeachingQuestionNode = {
  id:string; parentId:string|null; questionRef:TeachingRef; answerRef:TeachingRef|null;
  answerOrigin:'none'|'synthetic'|'actual'; actualReceiptRef:TeachingRef|null;
};
export type CandidateRecord = {
  schemaVersion:'CandidateRecord/0.1'; id:string; createdAt:number; planRef:TeachingRef;
  policyRef:TeachingRef; teacherCapabilityRef:TeachingRef; studentSnapshotRef:TeachingRef;
  lineageNodeId:string; parentCandidateIds:string[]; sourceFamilyIds:string[];
  dataClass:TeachingDataClass; split:TeachingSplit; contentRef:TeachingRef;
  declaredContentBytes:number; declaredTokens:number; origin:'synthetic'|'licensed_external';
  disposition:'candidate'|'rejected'|'unknown'; quality:'NOT_EVALUATED'; questionNodes:TeachingQuestionNode[];
};
/** Supplied separately by the trusted host. These are still unauthenticated declarations here. */
export type TeachingRightsDecision = {
  ref:TeachingRef; subjectId:string; dataClass:TeachingDataClass; uses:TeachingUses;
  validFrom:number; expiresAt:number;
};
export type TeachingInferenceReceipt = {
  ref:TeachingRef; authority:TeachingAuthority; runnerId:string; candidateId:string; nodeId:string;
  questionRef:TeachingRef; answerRef:TeachingRef; studentSnapshotRef:TeachingRef;
  observedAt:number; kind:'observed_student_inference';
};
export type TeachingTrustSnapshot = {
  schemaVersion:'TeachingTrustSnapshot/0.1'; authority:TeachingAuthority; asOf:number; expiresAt:number;
  roles:Array<{ principalId:string; role:TeachingRole }>;
  decisions:TeachingRightsDecision[]; inferenceReceipts:TeachingInferenceReceipt[];
};
export type TeachingBundle = {
  schemaVersion:'TeachingBundle/0.1'; id:string; authority:TeachingAuthority; createdAt:number;
  dataClass:TeachingDataClass; plan:TeachingPlan; policy:QuestionPolicy; teacher:TeacherCapabilityRecord;
  licenses:SourceLicenseRecord[]; registry:FamilySplitRegistry; candidates:CandidateRecord[];
};
export type TeachingAdmissionReport = TeachingFrozen<{
  status:'DECLARATION_VALID_ONLY'; decision:'ELIGIBLE_METADATA'|'REFUSED'; execution:'NOT_AUTHORIZED';
  quality:'NOT_EVALUATED'; rightsAuthenticity:'NOT_AUTHENTICATED'; semanticLeakage:'NOT_EVALUATED';
  codes:string[]; counts:{ input:number; unique:number; duplicates:number; eligible:number; excluded:number };
}>;
