import { fail } from './validation.ts';
import { canonicalTeachingJson, freezeTeaching, ownTeachingJson, teachingDigest } from './teaching-json.ts';
import { TEACHING_LIMITS as L } from './teaching-types.ts';
import type {
  CandidateRecord,
  FamilySplitRegistry,
  QuestionPolicy,
  SourceLicenseRecord,
  TeacherCapabilityRecord,
  TeachingAdmissionReport,
  TeachingAuthority,
  TeachingBundle,
  TeachingDeclaration,
  TeachingRef,
  TeachingTrustSnapshot,
  TeachingUse,
} from './teaching-types.ts';

type ObjectValue = Record<string, unknown>;
const shape = (value: unknown, keys: string[]): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WF0_INVALID_SHAPE');
  const o = value as ObjectValue;
  if (Object.keys(o).length !== keys.length || keys.some((k) => !Object.hasOwn(o, k))) fail('WF0_INVALID_FIELD');
  return o;
};
const id = (value: unknown): void => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) fail('WF0_INVALID_ID');
};
const externalToken = (value: unknown): void => {
  if (typeof value !== 'string' || !/^[!-~]{1,256}$/.test(value)) fail('WF0_INVALID_MODEL_TOKEN');
};
const digest = (value: unknown): void => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('WF0_INVALID_DIGEST');
};
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < min || (value as number) > max)
    fail('WF0_INVALID_NUMBER');
  return value as number;
};
const choice = (value: unknown, values: readonly string[]): void => {
  if (typeof value !== 'string' || !values.includes(value)) fail('WF0_INVALID_ENUM');
};
const array = (value: unknown, max: number, min = 0): unknown[] => {
  if (!Array.isArray(value)) fail('WF0_INVALID_SHAPE');
  if (value.length > max || value.length < min) fail('WF0_LIMIT');
  return value;
};
const unique = (values: string[]): void => {
  if (new Set(values).size !== values.length) fail('WF0_DUPLICATE_ID');
};
const ids = (value: unknown, max: number, min = 0): string[] => {
  const a = array(value, max, min);
  a.forEach(id);
  unique(a as string[]);
  return a as string[];
};
const ref = (value: unknown): void => {
  const r = shape(value, ['id', 'sha256']);
  id(r.id);
  digest(r.sha256);
};
const sameRef = (a: TeachingRef, b: TeachingRef): boolean => a.id === b.id && a.sha256 === b.sha256;
const pointsTo = (r: TeachingRef, o: { id: string }): boolean => r.id === o.id && r.sha256 === teachingDigest(o);
const authority = (value: unknown): void => {
  const a = shape(value, ['authorityId', 'revision', 'runtimeId']);
  id(a.authorityId);
  id(a.runtimeId);
  integer(a.revision, 1);
};
const sameAuthority = (a: TeachingAuthority, b: TeachingAuthority): boolean =>
  a.authorityId === b.authorityId && a.revision === b.revision && a.runtimeId === b.runtimeId;
const dataClass = (v: unknown): void => choice(v, ['public', 'private']);
const split = (v: unknown): void => choice(v, ['train', 'dev', 'calibration', 'sealedEval', 'quarantine']);
const uses = (value: unknown): void => {
  const u = shape(value, ['coordinate', 'generate', 'train', 'publish']);
  Object.values(u).forEach((x) => choice(x, ['ALLOW', 'DENY', 'UNKNOWN']));
};
function document(value: unknown, version: string, keys: string[], bounded = true): ObjectValue {
  if (!value || typeof value !== 'object' || (value as ObjectValue).schemaVersion !== version)
    fail('WF0_UNSUPPORTED_VERSION');
  const o = shape(value, ['schemaVersion', ...keys]);
  if (bounded && Buffer.byteLength(canonicalTeachingJson(o), 'utf8') > L.documentBytes) fail('WF0_LIMIT');
  return o;
}
function teacher(value: unknown): TeacherCapabilityRecord {
  const t = document(value, 'TeacherCapabilityRecord/0.1', [
    'id',
    'createdAt',
    'expiresAt',
    'provider',
    'region',
    'product',
    'requestedModelId',
    'returnedModelId',
    'immutableRevision',
    'modelVersionEvidence',
    'modalities',
    'capabilities',
  ]);
  id(t.id);
  for (const k of ['provider', 'region', 'product', 'requestedModelId']) externalToken(t[k]);
  integer(t.createdAt);
  if (integer(t.expiresAt) <= Number(t.createdAt)) fail('WF0_INVALID_TIME');
  if (t.returnedModelId !== null) externalToken(t.returnedModelId);
  if (t.immutableRevision !== null) externalToken(t.immutableRevision);
  if (t.modelVersionEvidence !== null) ref(t.modelVersionEvidence);
  if (t.immutableRevision !== null && t.modelVersionEvidence === null) fail('WF0_VERSION_EVIDENCE_REQUIRED');
  const modalities = ids(t.modalities, 3, 1);
  modalities.forEach((x) => choice(x, ['text', 'image', 'video']));
  const caps = shape(t.capabilities, ['text', 'json', 'cancel', 'usage']);
  Object.values(caps).forEach((x) => choice(x, ['UNKNOWN', 'DOCUMENTED', 'PROBED', 'ACCEPTED']));
  return t as TeacherCapabilityRecord;
}
function license(value: unknown): SourceLicenseRecord {
  const s = document(value, 'SourceLicenseRecord/0.1', [
    'id',
    'sourceNodeId',
    'dataClass',
    'contractRef',
    'decisionRef',
    'declaredUses',
  ]);
  id(s.id);
  id(s.sourceNodeId);
  dataClass(s.dataClass);
  ref(s.contractRef);
  ref(s.decisionRef);
  uses(s.declaredUses);
  return s as SourceLicenseRecord;
}
function policy(value: unknown): QuestionPolicy {
  const p = document(value, 'QuestionPolicy/0.1', [
    'id',
    'authority',
    'mode',
    'policyContentRef',
    'maxDepth',
    'maxNodes',
    'maxBranches',
    'maxActualAnswers',
    'maxInputTokens',
    'maxOutputTokens',
  ]);
  id(p.id);
  authority(p.authority);
  choice(p.mode, ['directExam', 'simulatedUserScenario', 'critique']);
  ref(p.policyContentRef);
  integer(p.maxDepth, 1, L.questionDepth);
  integer(p.maxNodes, 1, L.questionNodes);
  integer(p.maxBranches, 1, L.questionBranches);
  integer(p.maxActualAnswers, 0, L.actualAnswers);
  integer(p.maxInputTokens, 1, L.declaredTokens);
  integer(p.maxOutputTokens, 1, L.declaredTokens);
  return p as QuestionPolicy;
}
function plan(value: unknown): TeachingBundle['plan'] {
  const p = document(value, 'TeachingPlan/0.1', [
    'id',
    'authority',
    'createdAt',
    'expiresAt',
    'coordinatorId',
    'coordinatorRole',
    'coordinatorInstructionVersion',
    'coordinatorContractDecisionRef',
    'questionPolicyRef',
    'teacherCapabilityRef',
    'studentSnapshotRef',
    'sourceFamilyPolicyRef',
    'contentPolicyRef',
    'dataClass',
    'split',
    'maxCandidates',
    'maxCalls',
  ]);
  id(p.id);
  authority(p.authority);
  integer(p.createdAt);
  if (integer(p.expiresAt) <= Number(p.createdAt)) fail('WF0_INVALID_TIME');
  id(p.coordinatorId);
  id(p.coordinatorInstructionVersion);
  if (p.coordinatorRole !== 'TeachingCoordinator') fail('WF0_COORDINATOR_ROLE_REQUIRED');
  for (const k of [
    'coordinatorContractDecisionRef',
    'questionPolicyRef',
    'teacherCapabilityRef',
    'studentSnapshotRef',
    'sourceFamilyPolicyRef',
    'contentPolicyRef',
  ])
    ref(p[k]);
  dataClass(p.dataClass);
  choice(p.split, ['train', 'dev']);
  integer(p.maxCandidates, 1, L.candidates);
  integer(p.maxCalls, 1, L.calls);
  return p as TeachingBundle['plan'];
}
function family(value: unknown): FamilySplitRegistry {
  const r = document(
    value,
    'FamilySplitRegistry/0.1',
    ['id', 'authority', 'revision', 'frozenAt', 'splitPolicyRef', 'nodes'],
    false,
  );
  id(r.id);
  authority(r.authority);
  integer(r.revision, 1);
  integer(r.frozenAt);
  ref(r.splitPolicyRef);
  const nodes = array(r.nodes, L.registryNodes, 1).map((value) => {
    const n = shape(value, [
      'id',
      'familyId',
      'parentIds',
      'candidateId',
      'contentDigest',
      'split',
      'dataClass',
      'disposition',
      'licenseRef',
    ]);
    id(n.id);
    id(n.familyId);
    ids(n.parentIds, L.registryNodes);
    if (n.candidateId !== null) id(n.candidateId);
    if (n.contentDigest !== null) digest(n.contentDigest);
    if (n.candidateId !== null && n.contentDigest === null) fail('WF0_CONTENT_DIGEST_REQUIRED');
    split(n.split);
    dataClass(n.dataClass);
    choice(n.disposition, ['retained', 'discarded']);
    ref(n.licenseRef);
    return n as FamilySplitRegistry['nodes'][number];
  });
  unique(nodes.map((n) => n.id));
  unique(nodes.flatMap((n) => (n.candidateId === null ? [] : [n.candidateId])));
  if (nodes.reduce((sum, n) => sum + n.parentIds.length, 0) > L.registryEdges) fail('WF0_LIMIT');
  const byId = new Map(nodes.map((n) => [n.id, n])),
    children = new Map(nodes.map((n) => [n.id, [] as string[]]));
  const degree = new Map(nodes.map((n) => [n.id, n.parentIds.length]));
  const owner = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (key: string): string => {
    let current = key;
    while (owner.get(current) !== current) current = owner.get(current)!;
    return current;
  };
  const join = (a: string, b: string): void => {
    owner.set(find(a), find(b));
  };
  const familyOwner = new Map<string, string>(),
    digestOwner = new Map<string, (typeof nodes)[number]>();
  for (const n of nodes) {
    const previous = familyOwner.get(n.familyId);
    if (previous) join(n.id, previous);
    else familyOwner.set(n.familyId, n.id);
    if (n.contentDigest !== null) {
      const same = digestOwner.get(n.contentDigest);
      if (same) {
        if (same.dataClass !== n.dataClass) fail('WF0_CONTENT_DATA_CLASS_CONFLICT');
        join(n.id, same.id);
      } else digestOwner.set(n.contentDigest, n);
    }
    for (const p of n.parentIds) {
      const parent = byId.get(p);
      if (!parent) fail('WF0_MISSING_ANCESTOR');
      if (parent.dataClass === 'private' && n.dataClass !== 'private') fail('WF0_PRIVATE_DERIVATION');
      children.get(p)!.push(n.id);
      join(n.id, p);
    }
  }
  const ready = nodes.filter((n) => n.parentIds.length === 0).map((n) => n.id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const next = ready[cursor]!;
    visited++;
    for (const child of children.get(next)!) {
      const d = degree.get(child)! - 1;
      degree.set(child, d);
      if (d === 0) ready.push(child);
    }
  }
  if (visited !== nodes.length) fail('WF0_LINEAGE_CYCLE');
  const groups = new Map<string, { splits: Set<string>; families: Set<string> }>();
  for (const n of nodes) {
    const key = find(n.id),
      group = groups.get(key) ?? { splits: new Set<string>(), families: new Set<string>() };
    if (n.split !== 'quarantine') group.splits.add(n.split);
    group.families.add(n.familyId);
    groups.set(key, group);
  }
  if ([...groups.values()].some((g) => g.splits.size > 1)) fail('WF0_FAMILY_SPLIT_CONFLICT');
  if ([...groups.values()].some((g) => g.families.size > 1)) fail('WF0_FAMILY_ID_CONFLICT');
  return r as FamilySplitRegistry;
}
function questionNodes(value: unknown): CandidateRecord['questionNodes'] {
  const nodes = array(value, L.questionNodes).map((value) => {
    const n = shape(value, ['id', 'parentId', 'questionRef', 'answerRef', 'answerOrigin', 'actualReceiptRef']);
    id(n.id);
    if (n.parentId !== null) id(n.parentId);
    ref(n.questionRef);
    if (n.answerRef !== null) ref(n.answerRef);
    if (n.actualReceiptRef !== null) ref(n.actualReceiptRef);
    choice(n.answerOrigin, ['none', 'synthetic', 'actual']);
    if (
      (n.answerOrigin === 'none') !== (n.answerRef === null) ||
      (n.answerOrigin === 'actual') !== (n.actualReceiptRef !== null)
    )
      fail('WF0_ANSWER_BINDING');
    return n as CandidateRecord['questionNodes'][number];
  });
  unique(nodes.map((n) => n.id));
  const map = new Map(nodes.map((n) => [n.id, n]));
  let actual = 0;
  for (const n of nodes) {
    if (n.answerOrigin === 'actual') actual++;
    const seen = new Set<string>();
    let at: typeof n | undefined = n,
      depth = 0;
    while (at) {
      if (seen.has(at.id)) fail('WF0_QUESTION_CYCLE');
      seen.add(at.id);
      if (++depth > L.questionDepth) fail('WF0_LIMIT');
      if (at.parentId === null) break;
      const parent = map.get(at.parentId);
      if (!parent) fail('WF0_QUESTION_PARENT');
      at = parent;
    }
    if (nodes.filter((child) => child.parentId === n.id).length > L.questionBranches) fail('WF0_LIMIT');
  }
  if (actual > L.actualAnswers) fail('WF0_LIMIT');
  if (nodes.length && nodes.filter((n) => n.parentId === null).length !== 1) fail('WF0_QUESTION_ROOT');
  return nodes;
}
function candidate(value: unknown): CandidateRecord {
  const c = document(value, 'CandidateRecord/0.1', [
    'id',
    'createdAt',
    'planRef',
    'policyRef',
    'teacherCapabilityRef',
    'studentSnapshotRef',
    'lineageNodeId',
    'parentCandidateIds',
    'sourceFamilyIds',
    'dataClass',
    'split',
    'contentRef',
    'declaredContentBytes',
    'declaredTokens',
    'origin',
    'disposition',
    'quality',
    'questionNodes',
  ]);
  id(c.id);
  integer(c.createdAt);
  id(c.lineageNodeId);
  ids(c.parentCandidateIds, L.candidates);
  ids(c.sourceFamilyIds, L.registryNodes, 1);
  for (const k of ['planRef', 'policyRef', 'teacherCapabilityRef', 'studentSnapshotRef', 'contentRef']) ref(c[k]);
  dataClass(c.dataClass);
  split(c.split);
  if (c.split === 'sealedEval') fail('WF0_SEALED_BOUNDARY');
  integer(c.declaredContentBytes, 1, L.declaredContentBytes);
  integer(c.declaredTokens, 1, L.declaredTokens);
  choice(c.origin, ['synthetic', 'licensed_external']);
  choice(c.disposition, ['candidate', 'rejected', 'unknown']);
  if (c.quality !== 'NOT_EVALUATED') fail('WF0_QUALITY_CLAIM');
  questionNodes(c.questionNodes);
  return c as CandidateRecord;
}
function trust(value: unknown): TeachingTrustSnapshot {
  const t = document(
    value,
    'TeachingTrustSnapshot/0.1',
    ['authority', 'asOf', 'expiresAt', 'roles', 'decisions', 'inferenceReceipts'],
    false,
  );
  authority(t.authority);
  integer(t.asOf);
  if (integer(t.expiresAt) <= Number(t.asOf)) fail('WF0_INVALID_TIME');
  const roles = array(t.roles, 32).map((value) => {
    const r = shape(value, ['principalId', 'role']);
    id(r.principalId);
    choice(r.role, ['ResearchMentor', 'TeachingCoordinator', 'Teacher', 'StudentRunner', 'EvalCustodian']);
    return r;
  });
  unique(roles.map((r) => r.principalId as string));
  const decisions = array(t.decisions, L.decisions).map((value) => {
    const d = shape(value, ['ref', 'subjectId', 'dataClass', 'uses', 'validFrom', 'expiresAt']);
    ref(d.ref);
    id(d.subjectId);
    dataClass(d.dataClass);
    uses(d.uses);
    integer(d.validFrom);
    if (integer(d.expiresAt) <= Number(d.validFrom)) fail('WF0_INVALID_TIME');
    return d as TeachingTrustSnapshot['decisions'][number];
  });
  unique(decisions.map((d) => d.ref.id));
  const receipts = array(t.inferenceReceipts, L.candidates * L.actualAnswers).map((value) => {
    const r = shape(value, [
      'ref',
      'authority',
      'runnerId',
      'candidateId',
      'nodeId',
      'questionRef',
      'answerRef',
      'studentSnapshotRef',
      'observedAt',
      'kind',
    ]);
    for (const k of ['ref', 'questionRef', 'answerRef', 'studentSnapshotRef']) ref(r[k]);
    authority(r.authority);
    for (const k of ['runnerId', 'candidateId', 'nodeId']) id(r[k]);
    integer(r.observedAt);
    if (r.kind !== 'observed_student_inference') fail('WF0_ANSWER_BINDING');
    return r as TeachingTrustSnapshot['inferenceReceipts'][number];
  });
  unique(receipts.map((r) => r.ref.id));
  return t as TeachingTrustSnapshot;
}
function bundle(value: unknown): TeachingBundle {
  const b = document(
    value,
    'TeachingBundle/0.1',
    ['id', 'authority', 'createdAt', 'dataClass', 'plan', 'policy', 'teacher', 'licenses', 'registry', 'candidates'],
    false,
  );
  id(b.id);
  authority(b.authority);
  integer(b.createdAt);
  dataClass(b.dataClass);
  plan(b.plan);
  policy(b.policy);
  teacher(b.teacher);
  family(b.registry);
  const licenses = array(b.licenses, L.licenses).map(license);
  unique(licenses.map((l) => l.id));
  unique(licenses.map((l) => l.sourceNodeId));
  array(b.candidates, L.candidates).forEach(candidate);
  return b as TeachingBundle;
}
function declared<T>(input: unknown, validate: (value: unknown) => T): TeachingDeclaration<T> {
  return freezeTeaching({ status: 'DECLARATION_VALID_ONLY' as const, value: validate(ownTeachingJson(input)) });
}
export const validateTeacherCapability = (input: unknown) => declared(input, teacher);
export const validateSourceLicense = (input: unknown) => declared(input, license);
export const validateTeachingPlan = (input: unknown) => declared(input, plan);
export const validateQuestionPolicy = (input: unknown) => declared(input, policy);
export const validateCandidate = (input: unknown) => declared(input, candidate);
export const validateFamilySplit = (input: unknown) => declared(input, family);

/** This policy only classifies access. It neither reads content nor authenticates a principal. */
export function checkTeachingRoleAccess(role: unknown, material: unknown): boolean {
  choice(role, ['ResearchMentor', 'TeachingCoordinator', 'Teacher', 'StudentRunner', 'EvalCustodian']);
  choice(material, [
    'operational_metadata',
    'teaching_content',
    'student_answer',
    'per_item_feedback',
    'sealed_content',
  ]);
  if (material === 'operational_metadata') return true;
  if (role === 'ResearchMentor') return false;
  if (material === 'sealed_content') return role === 'EvalCustodian';
  return role !== 'EvalCustodian';
}

function inspect(input: unknown, current: unknown) {
  const b = bundle(ownTeachingJson(input)),
    t = trust(ownTeachingJson(current)),
    codes = new Set<string>();
  const deny = (code: string): void => {
      codes.add(code);
    },
    now = t.asOf;
  const { plan: p, policy: q, teacher: tc, registry: g } = b;
  if (![b.authority, p.authority, q.authority, g.authority].every((a) => sameAuthority(a, t.authority)))
    deny('WF0_STALE_AUTHORITY');
  if (b.createdAt > now || p.createdAt > now || tc.createdAt > now || g.frozenAt > now || b.createdAt < g.frozenAt)
    deny('WF0_INVALID_TIME');
  if (now >= p.expiresAt || now >= tc.expiresAt) deny('WF0_EXPIRED');
  if (t.roles.find((r) => r.principalId === p.coordinatorId)?.role !== 'TeachingCoordinator')
    deny('WF0_COORDINATOR_ROLE_REQUIRED');
  const decisions = new Map(t.decisions.map((d) => [d.ref.id, d]));
  const permission = (r: TeachingRef, subject: string, dc: string, requested: TeachingUse[]): void => {
    const d = decisions.get(r.id);
    if (!d || !sameRef(d.ref, r) || d.subjectId !== subject || d.dataClass !== dc) {
      deny('WF0_RIGHTS_BINDING');
      return;
    }
    if (now < d.validFrom || now >= d.expiresAt) deny('WF0_EXPIRED_RIGHTS');
    if (requested.some((use) => d.uses[use] !== 'ALLOW')) deny('WF0_RIGHTS_NOT_ALLOWED');
  };
  permission(p.coordinatorContractDecisionRef, p.coordinatorId, p.dataClass, [
    'coordinate',
    'generate',
    'train',
    ...(p.dataClass === 'public' ? ['publish' as const] : []),
  ]);
  if (
    !pointsTo(p.questionPolicyRef, q) ||
    !pointsTo(p.teacherCapabilityRef, tc) ||
    !sameRef(p.sourceFamilyPolicyRef, g.splitPolicyRef)
  )
    deny('WF0_REFERENCE_MISMATCH');
  if (p.dataClass !== b.dataClass) deny('WF0_DATA_CLASS_MISMATCH');
  if (tc.capabilities.text !== 'ACCEPTED' || !tc.modalities.includes('text')) deny('WF0_TEACHER_NOT_ACCEPTED');
  const nodes = new Map(g.nodes.map((n) => [n.id, n])),
    candidateNodes = new Map(g.nodes.filter((n) => n.candidateId !== null).map((n) => [n.candidateId!, n]));
  const quarantinedFamilies = new Set(g.nodes.filter((n) => n.split === 'quarantine').map((n) => n.familyId));
  const licenses = new Map(b.licenses.map((l) => [l.id, l]));
  const ancestors = (start: string): Set<string> => {
    const seen = new Set<string>(),
      todo = [start];
    for (let i = 0; i < todo.length; i++) {
      const key = todo[i]!;
      if (seen.has(key)) continue;
      seen.add(key);
      todo.push(...nodes.get(key)!.parentIds);
    }
    return seen;
  };
  const all = new Map<string, CandidateRecord>(),
    content = new Map<string, CandidateRecord>();
  let duplicates = 0;
  // Validate every declared graph before this dedup step, including discarded bridge nodes.
  for (const c of b.candidates) {
    const previous = all.get(c.id);
    if (previous) {
      if (canonicalTeachingJson(previous) !== canonicalTeachingJson(c)) fail('WF0_CANDIDATE_ID_CONFLICT');
      duplicates++;
      continue;
    }
    const sameContent = content.get(c.contentRef.sha256);
    if (sameContent)
      fail(sameContent.split !== c.split ? 'WF0_CONTENT_SPLIT_CONFLICT' : 'WF0_CONTENT_IDENTITY_CONFLICT');
    all.set(c.id, c);
    content.set(c.contentRef.sha256, c);
  }
  if (all.size > p.maxCandidates) deny('WF0_PLAN_LIMIT');
  const eligible: CandidateRecord[] = [];
  const usedReceipts = new Set<string>();
  for (const c of all.values()) {
    if (c.createdAt < p.createdAt || c.createdAt > g.frozenAt || c.createdAt > now) deny('WF0_INVALID_TIME');
    if (
      !pointsTo(c.planRef, p) ||
      !pointsTo(c.policyRef, q) ||
      !pointsTo(c.teacherCapabilityRef, tc) ||
      !sameRef(c.studentSnapshotRef, p.studentSnapshotRef)
    )
      deny('WF0_REFERENCE_MISMATCH');
    const node = nodes.get(c.lineageNodeId);
    if (!node || node.candidateId !== c.id || node.contentDigest !== c.contentRef.sha256) {
      deny('WF0_LINEAGE_BINDING');
      continue;
    }
    const lineage = ancestors(node.id),
      families = [...new Set([...lineage].map((key) => nodes.get(key)!.familyId))].sort();
    if (canonicalTeachingJson([...c.sourceFamilyIds].sort()) !== canonicalTeachingJson(families))
      deny('WF0_LINEAGE_BINDING');
    for (const parent of c.parentCandidateIds) {
      const n = candidateNodes.get(parent);
      if (!n || n.id === node.id || !lineage.has(n.id)) deny('WF0_PARENT_CANDIDATE_BINDING');
    }
    const declaredParents = [...lineage]
      .filter((key) => key !== node.id)
      .map((key) => nodes.get(key)!.candidateId)
      .filter((x) => x !== null)
      .sort();
    if (canonicalTeachingJson([...c.parentCandidateIds].sort()) !== canonicalTeachingJson(declaredParents))
      deny('WF0_PARENT_CANDIDATE_BINDING');
    if (node.split !== c.split || c.split !== p.split) deny('WF0_SPLIT_MISMATCH');
    if (node.dataClass !== c.dataClass || c.dataClass !== b.dataClass) deny('WF0_DATA_CLASS_MISMATCH');
    if (node.disposition !== 'retained' || c.disposition !== 'candidate' || c.split === 'quarantine') continue;
    if (families.some((f) => quarantinedFamilies.has(f))) deny('WF0_FAMILY_QUARANTINED');
    for (const key of lineage) {
      const n = nodes.get(key)!;
      if (n.split === 'sealedEval') deny('WF0_SEALED_BOUNDARY');
      if (n.split === 'quarantine') deny('WF0_FAMILY_QUARANTINED');
      if (c.dataClass === 'public' && n.dataClass === 'private') deny('WF0_PRIVATE_DERIVATION');
      const l = licenses.get(n.licenseRef.id);
      if (!l || !pointsTo(n.licenseRef, l) || l.sourceNodeId !== n.id || l.dataClass !== n.dataClass) {
        deny('WF0_LICENSE_BINDING');
        continue;
      }
      const required: TeachingUse[] = ['generate', 'train', ...(c.dataClass === 'public' ? ['publish' as const] : [])];
      if (required.some((use) => l.declaredUses[use] !== 'ALLOW')) deny('WF0_RIGHTS_NOT_ALLOWED');
      permission(l.decisionRef, n.id, n.dataClass, required);
    }
    if (
      c.questionNodes.length > q.maxNodes ||
      c.questionNodes.filter((n) => n.answerOrigin === 'actual').length > q.maxActualAnswers
    )
      deny('WF0_PLAN_LIMIT');
    const questionMap = new Map(c.questionNodes.map((n) => [n.id, n]));
    for (const n of c.questionNodes) {
      let depth = 1,
        at = n;
      while (at.parentId !== null) {
        depth++;
        at = questionMap.get(at.parentId)!;
      }
      if (depth > q.maxDepth || c.questionNodes.filter((child) => child.parentId === n.id).length > q.maxBranches)
        deny('WF0_PLAN_LIMIT');
      if (n.answerOrigin !== 'actual') continue;
      const receipt = t.inferenceReceipts.find((r) => sameRef(r.ref, n.actualReceiptRef!));
      if (
        !receipt ||
        receipt.candidateId !== c.id ||
        receipt.nodeId !== n.id ||
        !sameRef(receipt.questionRef, n.questionRef) ||
        !sameRef(receipt.answerRef, n.answerRef!) ||
        !sameRef(receipt.studentSnapshotRef, c.studentSnapshotRef) ||
        !sameAuthority(receipt.authority, t.authority) ||
        receipt.observedAt < p.createdAt ||
        receipt.observedAt > c.createdAt ||
        receipt.observedAt > now ||
        t.roles.find((r) => r.principalId === receipt.runnerId)?.role !== 'StudentRunner'
      )
        deny('WF0_ACTUAL_RECEIPT_REQUIRED');
      else {
        if (usedReceipts.has(receipt.ref.id)) deny('WF0_RECEIPT_REUSE');
        usedReceipts.add(receipt.ref.id);
      }
    }
    eligible.push(c);
  }
  const report: TeachingAdmissionReport = freezeTeaching({
    status: 'DECLARATION_VALID_ONLY',
    decision: codes.size ? 'REFUSED' : 'ELIGIBLE_METADATA',
    execution: 'NOT_AUTHORIZED',
    quality: 'NOT_EVALUATED',
    rightsAuthenticity: 'NOT_AUTHENTICATED',
    semanticLeakage: 'NOT_EVALUATED',
    codes: [...codes].sort(),
    counts: {
      input: b.candidates.length,
      unique: all.size,
      duplicates,
      eligible: codes.size ? 0 : eligible.length,
      excluded: all.size - eligible.length,
    },
  });
  return { b, t, eligible, report };
}
/** The second argument is a current, separate host input; no JSON can authenticate it. */
export function checkTeachingAdmission(input: unknown, current: unknown): TeachingAdmissionReport {
  return inspect(input, current).report;
}

/** Public metadata export only. Private manifests need a future separately bound storage API.
 * Errors contain fixed codes, and neither sealed registry entries nor private refs are returned. */
export function exportTeachingManifest(input: unknown, current: unknown) {
  const { b, t, eligible, report } = inspect(input, current);
  if (report.decision !== 'ELIGIBLE_METADATA') fail('WF0_EXPORT_REFUSED');
  if (b.dataClass !== 'public') fail('WF0_PRIVATE_EXPORT_REFUSED');
  const manifest = {
    schemaVersion: 'TeachingManifest/0.1',
    status: 'DECLARATION_VALID_ONLY',
    execution: 'NOT_AUTHORIZED',
    quality: 'NOT_EVALUATED',
    rightsAuthenticity: 'NOT_AUTHENTICATED',
    semanticLeakage: 'NOT_EVALUATED',
    dataClass: 'public',
    asOf: t.asOf,
    counts: report.counts,
    candidates: eligible
      .map((c) => ({
        id: c.id,
        contentRef: c.contentRef,
        split: c.split,
        declaredContentBytes: c.declaredContentBytes,
        declaredTokens: c.declaredTokens,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  const json = canonicalTeachingJson(manifest);
  if (Buffer.byteLength(json, 'utf8') > L.exportBytes) fail('WF0_LIMIT');
  return freezeTeaching({ json, sha256: teachingDigest(manifest), bytes: Buffer.byteLength(json, 'utf8') });
}
