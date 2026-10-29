import { canonical, copyJson, digest, hash, id, integer, oneOf, shape, stop } from './wf1-json.ts';
import type { ArtifactRef, Attempt, Candidate, FormalEvidence, Json } from './wf1-types.ts';

/** CP0 is a bounded selected-row harvest, not the CP1 importer or a training grant. */
export const CORPUS_PROFILE = Object.freeze({
  version: 'CorpusPipeline/0.1',
  source: 'wf1-campaign/0.8',
  maxRows: 1,
  maxArtifactBytes: 262144,
  evidenceClass: 'EXACT_VERIFIED',
  selectedTarget: 'EXACT_RATIONAL_TYPED_TARGET_ONLY',
  trainingJobPolicy: 'NOT_AUTHORIZED',
  trainingReady: false,
});
export const CORPUS_PROFILE_DIGEST = hash(canonical(CORPUS_PROFILE));
export type CorpusSelection = {
  version: 'CorpusSelection/0.1';
  sourceCampaignId: string;
  sourceLedgerHead: string;
  sourceProfileDigest: string;
  sourceBuildDigest: string;
  sourceArchiveDigest: string;
  sourceTerminal: 'STOPPED' | 'COMPLETED';
  transportLane: 'SYNTHETIC_FIXTURE' | 'NATIVE_FETCH';
  candidate: Candidate;
  unitIndex: number;
  planRef: ArtifactRef;
  validatedAggregatePlanRef: ArtifactRef;
  planUnitRefs: ArtifactRef[];
  rubricRef: ArtifactRef;
  sealRef: ArtifactRef;
  exclusion: { candidateId: string; commitment: string; result: 'CLEAR' };
  generation: Attempt;
  review: Attempt;
};
export type CorpusAdmission = {
  version: 'CorpusAdmission/0.1';
  authorityId: string;
  revision: number;
  runtimeId: string;
  expiresAt: number;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  runId: string;
  selectionDigest: string;
  storageBindingDigest: string;
  rights: { retain: boolean; harvest: boolean; verify: boolean };
  sourceUse: 'ALLOW' | 'DENY' | 'UNKNOWN';
  trustClass: 'TRUSTED_HOST_WF1_LEDGER' | 'SYNTHETIC_FIXTURE';
};
/** Must read a fresh independent host authority on every call. It is never supplied by a model. */
export type AdmissionPort = () => CorpusAdmission;
export type CorpusHarvestSpec = {
  version: 'CorpusHarvest/0.1';
  runId: string;
  profileDigest: string;
  selectionDigest: string;
  storageBindingDigest: string;
  authorityId: string;
  authorityRevision: number;
  runtimeId: string;
};
export type SelectedReader = Readonly<{ read: (ref: ArtifactRef) => Buffer }>;
export type CorpusEvidence = {
  version: 'CorpusEvidence/0.1';
  selection: CorpusSelection;
  artifacts: Array<{ sourceRef: ArtifactRef; plaintextDigest: string; content: string }>;
};
export type CorpusRow = {
  version: 'QualifiedItem/0.1';
  id: string;
  kind: 'SFT';
  origin: 'TEACHER' | 'SYNTHETIC_FIXTURE';
  familyId: string;
  roots: string[];
  split: 'train' | 'dev';
  privacy: 'private';
  parentItemIds: string[];
  sourceCampaignId: string;
  sourceLedgerHead: string;
  originalCampaignTerminal: 'STOPPED' | 'COMPLETED';
  evidenceClass: 'EXACT_VERIFIED' | 'MODEL_REVIEWED';
  selectedTargetScope: 'EXACT_RATIONAL_TYPED_TARGET_ONLY';
  formalEvidence: FormalEvidence;
  projection: { tool: 'rational.evaluate.v1'; input: Json; typedTarget: Json };
  generated: true;
  structurallyValid: true;
  modelReviewAccepted: true;
  exactVerified: true;
  dataGateAccepted: true;
  manualChecked: false;
  trainingReady: false;
  sourceRefs: ArtifactRef[];
  evidenceRef: ArtifactRef;
  logicalDigest: string;
  teacher: CorpusModelProvenance;
  reviewer: CorpusModelProvenance;
};
export type CorpusModelProvenance = {
  provider: 'together' | 'deepseek';
  requestedModel: string;
  returnedModel: string;
  revision: null;
  protocol: string;
  effort: 'medium' | 'high';
  finishReason: 'stop';
  usage: { input: number; completion: number; reasoning: number | null };
  usageSource: 'PROVIDER_REPORTED';
};
export type CorpusManifest = {
  version: 'CorpusManifest/0.1';
  runId: string;
  profileDigest: string;
  spec: CorpusHarvestSpec;
  evidenceRef: ArtifactRef;
  shardRef: ArtifactRef;
  logicalRowsDigest: string;
  rows: '1';
  splitCounts: { train: '0' | '1'; dev: '0' | '1' };
  reusedQualified: '1';
  generatedNew: '0';
  dataGateAccepted: true;
  trainingJobPolicy: 'NOT_AUTHORIZED';
  trainingReady: false;
  status: 'HARVESTED_TOKENIZATION_PENDING';
  tokenizerProfileDigest: null;
  studentInputTokens: null;
  studentLossTokens: null;
  measurementStatus: 'TOKENIZER_NOT_PINNED';
  trustClass: CorpusAdmission['trustClass'];
};

export function validateHarvestSpec(input: unknown): CorpusHarvestSpec {
  const s = shape(copyJson(input), [
    'version',
    'runId',
    'profileDigest',
    'selectionDigest',
    'storageBindingDigest',
    'authorityId',
    'authorityRevision',
    'runtimeId',
  ]);
  if (s.version !== 'CorpusHarvest/0.1' || s.profileDigest !== CORPUS_PROFILE_DIGEST) stop('CP0_PROFILE');
  id(s.runId);
  digest(s.selectionDigest);
  digest(s.storageBindingDigest);
  id(s.authorityId);
  integer(s.authorityRevision, 1);
  id(s.runtimeId);
  return s as CorpusHarvestSpec;
}
export function validateAdmission(input: unknown): CorpusAdmission {
  const a = shape(copyJson(input), [
    'version',
    'authorityId',
    'revision',
    'runtimeId',
    'expiresAt',
    'status',
    'runId',
    'selectionDigest',
    'storageBindingDigest',
    'rights',
    'sourceUse',
    'trustClass',
  ]);
  if (a.version !== 'CorpusAdmission/0.1') stop('CP0_AUTHORITY');
  id(a.authorityId);
  integer(a.revision, 1);
  id(a.runtimeId);
  integer(a.expiresAt, 1);
  id(a.runId);
  digest(a.selectionDigest);
  digest(a.storageBindingDigest);
  oneOf(a.status, ['ACTIVE', 'PAUSED', 'REVOKED']);
  oneOf(a.sourceUse, ['ALLOW', 'DENY', 'UNKNOWN']);
  oneOf(a.trustClass, ['TRUSTED_HOST_WF1_LEDGER', 'SYNTHETIC_FIXTURE']);
  const rights = shape(a.rights, ['retain', 'harvest', 'verify']);
  for (const value of Object.values(rights)) if (typeof value !== 'boolean') stop('CP0_AUTHORITY');
  return a as CorpusAdmission;
}
export function requireAdmission(
  spec: CorpusHarvestSpec,
  port: AdmissionPort,
  purpose: 'harvest' | 'verify',
  now = Date.now(),
): CorpusAdmission {
  const a = validateAdmission(port());
  integer(now);
  if (
    a.authorityId !== spec.authorityId ||
    a.revision !== spec.authorityRevision ||
    a.runtimeId !== spec.runtimeId ||
    a.runId !== spec.runId ||
    a.selectionDigest !== spec.selectionDigest ||
    a.storageBindingDigest !== spec.storageBindingDigest ||
    a.status !== 'ACTIVE' ||
    now >= a.expiresAt ||
    !a.rights.retain ||
    !a.rights[purpose] ||
    a.sourceUse !== 'ALLOW'
  )
    stop('CP0_AUTHORITY');
  return a;
}
