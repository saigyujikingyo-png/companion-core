import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreError } from '../src/validation.ts';
import { canonicalTeachingJson, parseTeachingJson, teachingDigest } from '../src/teaching-json.ts';
import { TEACHING_LIMITS as L } from '../src/teaching-types.ts';
import type { CandidateRecord, TeachingBundle, TeachingRef, TeachingTrustSnapshot } from '../src/teaching-types.ts';
import { checkTeachingAdmission, checkTeachingRoleAccess, exportTeachingManifest, validateCandidate, validateFamilySplit,
  validateQuestionPolicy, validateSourceLicense, validateTeacherCapability, validateTeachingPlan } from '../src/teaching-validation.ts';

// Original structural fixtures: opaque IDs/digests only, no questions, answers or teaching content.
const ref=(id:string):TeachingRef=>({ id,sha256:'a'.repeat(64) });
const objectRef=(o:{ id:string }):TeachingRef=>({ id:o.id,sha256:teachingDigest(o) });
const allowed=()=>({ coordinate:'ALLOW',generate:'ALLOW',train:'ALLOW',publish:'ALLOW' } as const);
const error=(code:string)=>(e:unknown)=>e instanceof CoreError && e.code===code && e.message===code;
function fixture() {
  const authority={ authorityId:'authority-a',revision:1,runtimeId:'runtime-a' };
  const b:TeachingBundle={ schemaVersion:'TeachingBundle/0.1',id:'bundle-a',authority:{...authority},createdAt:40,dataClass:'public',
    teacher:{ schemaVersion:'TeacherCapabilityRecord/0.1',id:'teacher-a',createdAt:1,expiresAt:200,provider:'fixture-provider',
      region:'fixture-region',product:'fixture-product',requestedModelId:'requested-alias',returnedModelId:'returned-alias',
      immutableRevision:null,modelVersionEvidence:null,modalities:['text'],capabilities:{ text:'ACCEPTED',json:'UNKNOWN',cancel:'UNKNOWN',usage:'DOCUMENTED' } },
    policy:{ schemaVersion:'QuestionPolicy/0.1',id:'policy-a',authority:{...authority},mode:'directExam',policyContentRef:ref('policy-content-a'),
      maxDepth:8,maxNodes:16,maxBranches:2,maxActualAnswers:8,maxInputTokens:1024,maxOutputTokens:1024 },
    plan:{ schemaVersion:'TeachingPlan/0.1',id:'plan-a',authority:{...authority},createdAt:1,expiresAt:200,coordinatorId:'coordinator-a',
      coordinatorRole:'TeachingCoordinator',coordinatorInstructionVersion:'instructions-v1',coordinatorContractDecisionRef:ref('coordinator-rights-a'),
      questionPolicyRef:ref('policy-a'),teacherCapabilityRef:ref('teacher-a'),studentSnapshotRef:ref('student-a'),
      sourceFamilyPolicyRef:ref('split-policy-a'),contentPolicyRef:ref('content-policy-a'),dataClass:'public',split:'train',maxCandidates:128,maxCalls:40 },
    licenses:['root-a','derived-a'].map((sourceNodeId,index)=>({ schemaVersion:'SourceLicenseRecord/0.1',id:'license-'+index,
      sourceNodeId,dataClass:'public',contractRef:ref('contract-'+index),decisionRef:ref('decision-'+index),declaredUses:allowed() })),
    registry:{ schemaVersion:'FamilySplitRegistry/0.1',id:'registry-a',authority:{...authority},revision:1,frozenAt:30,
      splitPolicyRef:ref('split-policy-a'),nodes:[
        { id:'root-a',familyId:'family-a',parentIds:[],candidateId:null,contentDigest:null,split:'train',dataClass:'public',disposition:'retained',licenseRef:ref('license-0') },
        { id:'derived-a',familyId:'family-a',parentIds:['root-a'],candidateId:'candidate-a',contentDigest:'a'.repeat(64),split:'train',dataClass:'public',disposition:'retained',licenseRef:ref('license-1') }] },
    candidates:[{ schemaVersion:'CandidateRecord/0.1',id:'candidate-a',createdAt:20,planRef:ref('plan-a'),policyRef:ref('policy-a'),
      teacherCapabilityRef:ref('teacher-a'),studentSnapshotRef:ref('student-a'),lineageNodeId:'derived-a',parentCandidateIds:[],sourceFamilyIds:['family-a'],
      dataClass:'public',split:'train',contentRef:ref('content-a'),declaredContentBytes:64,declaredTokens:16,origin:'synthetic',disposition:'candidate',
      quality:'NOT_EVALUATED',questionNodes:[{ id:'question-node-a',parentId:null,questionRef:ref('question-a'),answerRef:ref('answer-a'),
        answerOrigin:'synthetic',actualReceiptRef:null }] }] };
  const t:TeachingTrustSnapshot={ schemaVersion:'TeachingTrustSnapshot/0.1',authority:{...authority},asOf:100,expiresAt:200,
    roles:[{ principalId:'coordinator-a',role:'TeachingCoordinator' },{ principalId:'runner-a',role:'StudentRunner' }],
    decisions:[{ ref:ref('coordinator-rights-a'),subjectId:'coordinator-a',dataClass:'public',uses:allowed(),validFrom:0,expiresAt:200 },
      ...b.licenses.map(l=>({ ref:{...l.decisionRef},subjectId:l.sourceNodeId,dataClass:'public' as const,uses:allowed(),validFrom:0,expiresAt:200 }))],inferenceReceipts:[] };
  refresh(b); return { b,t };
}
function refresh(b:TeachingBundle):void {
  b.plan.questionPolicyRef=objectRef(b.policy); b.plan.teacherCapabilityRef=objectRef(b.teacher);
  for (const n of b.registry.nodes) { const license=b.licenses.find(l=>l.id===n.licenseRef.id); if (license) n.licenseRef=objectRef(license); }
  for (const c of b.candidates) { c.planRef=objectRef(b.plan); c.policyRef=objectRef(b.policy); c.teacherCapabilityRef=objectRef(b.teacher); }
}
function actual(f:ReturnType<typeof fixture>):void {
  const c=f.b.candidates[0]!, n=c.questionNodes[0]!; n.answerOrigin='actual'; n.actualReceiptRef=ref('receipt-a');
  f.t.inferenceReceipts.push({ ref:ref('receipt-a'),authority:{...f.t.authority},runnerId:'runner-a',candidateId:c.id,nodeId:n.id,
    questionRef:{...n.questionRef},answerRef:{...n.answerRef!},studentSnapshotRef:{...c.studentSnapshotRef},observedAt:15,kind:'observed_student_inference' });
}
const refused=(f:ReturnType<typeof fixture>,code:string):void=>{
  const report=checkTeachingAdmission(f.b,f.t); assert.equal(report.decision,'REFUSED'); assert.ok(report.codes.includes(code));
  assert.equal(report.execution,'NOT_AUTHORIZED'); assert.equal(report.counts.eligible,0);
};

test('WF0 valid metadata stays a declaration with no authority, quality or leakage claim',()=>{
  const { b,t }=fixture();
  for (const [value,validate] of [[b.teacher,validateTeacherCapability],[b.licenses[0],validateSourceLicense],[b.plan,validateTeachingPlan],
    [b.policy,validateQuestionPolicy],[b.candidates[0],validateCandidate],[b.registry,validateFamilySplit]] as const) {
    assert.equal(validate(value).status,'DECLARATION_VALID_ONLY');
  }
  const r=checkTeachingAdmission(JSON.stringify(b),JSON.stringify(t)); assert.equal(r.decision,'ELIGIBLE_METADATA');
  assert.equal(r.quality,'NOT_EVALUATED'); assert.equal(r.rightsAuthenticity,'NOT_AUTHENTICATED'); assert.equal(r.semanticLeakage,'NOT_EVALUATED');
  assert.equal(r.execution,'NOT_AUTHORIZED'); assert.deepEqual(r.counts,{ input:1,unique:1,duplicates:0,eligible:1,excluded:0 });
});
test('unknown versions and fields, including embedded teaching content, are rejected',()=>{
  const { b }=fixture(); assert.throws(()=>validateCandidate({...b.candidates[0],schemaVersion:'CandidateRecord/0.2'}),error('WF0_UNSUPPORTED_VERSION'));
  for (const key of ['question','answer','rubric','reward','mentorContent']) assert.throws(()=>validateTeachingPlan({...b.plan,[key]:'forbidden'}),error('WF0_INVALID_FIELD'));
});
test('raw parser rejects duplicate decoded keys and prototype names',()=>{
  assert.throws(()=>parseTeachingJson('{"id":"a","\\u0069d":"b"}'),error('WF0_DUPLICATE_KEY'));
  for (const key of ['__proto__','constructor','prototype']) assert.throws(()=>parseTeachingJson('{"'+key+'":1}'),error('WF0_INVALID_FIELD'));
});
test('unsafe, nonfinite, fractional and negative numeric values are rejected',()=>{
  const { b }=fixture();
  for (const number of [NaN,Infinity,-Infinity,-1,-0,1.25,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>validateTeachingPlan({...b.plan,maxCalls:number}),error('WF0_INVALID_NUMBER'));
  for (const raw of ['1e999','1.2','-0','9007199254740992']) assert.throws(()=>parseTeachingJson(raw),error('WF0_INVALID_NUMBER'));
  assert.equal(parseTeachingJson(String(Number.MAX_SAFE_INTEGER)),Number.MAX_SAFE_INTEGER);
});
test('integer lexical profile rejects underflow and rounded fractions before numeric conversion',()=>{
  for (const raw of ['1e-324','1e-400','1e-1000','1.00000000000000001','1.0000000000000001',
    '9007199254740990.1','0.000000000000000000000000001','1e0','1E+0','1.0','0.0','-0','-1','-1e-400']) {
    assert.throws(()=>parseTeachingJson(raw),error('WF0_INVALID_NUMBER'));
    assert.throws(()=>parseTeachingJson('{"count":'+raw+'}'),error('WF0_INVALID_NUMBER'));
  }
  for (const [raw,expected] of [['0',0],['1',1],['9007199254740991',Number.MAX_SAFE_INTEGER]] as const) assert.equal(parseTeachingJson(raw),expected);
  assert.throws(()=>parseTeachingJson('9007199254740992'),error('WF0_INVALID_NUMBER'));
  for (const raw of ['01','00','+1']) assert.throws(()=>parseTeachingJson(raw),error('WF0_INVALID_JSON'));
});
test('public JSON validator paths preserve numeric lexical rejection instead of pre-parsing and rounding',()=>{
  const { b,t }=fixture();
  const planRaw=JSON.stringify(b.plan).replace('"maxCalls":40','"maxCalls":1.00000000000000001');
  assert.throws(()=>validateTeachingPlan(planRaw),error('WF0_INVALID_NUMBER'));
  const trustRaw=JSON.stringify(t).replace('"asOf":100','"asOf":1e2');
  assert.throws(()=>checkTeachingAdmission(JSON.stringify(b),trustRaw),error('WF0_INVALID_NUMBER'));
});
test('JSON byte/depth/string bounds and invalid Unicode are checked',()=>{
  assert.throws(()=>parseTeachingJson(' '.repeat(L.jsonBytes+1)),error('WF0_LIMIT'));
  assert.equal(parseTeachingJson('"'+'x'.repeat(L.stringUnits)+'"'),'x'.repeat(L.stringUnits));
  assert.throws(()=>parseTeachingJson('"'+'x'.repeat(L.stringUnits+1)+'"'),error('WF0_LIMIT'));
  assert.throws(()=>parseTeachingJson('['.repeat(L.jsonDepth+1)+'0'+']'.repeat(L.jsonDepth+1)),error('WF0_LIMIT'));
  assert.throws(()=>parseTeachingJson('"\\ud800"'),error('WF0_INVALID_JSON'));
});
test('object snapshots reject accessors without invoking them, cycles and non-data objects',()=>{
  const { b }=fixture(); let called=0; const c={...b.candidates[0]}; Object.defineProperty(c,'id',{enumerable:true,get(){called++;return 'a';}});
  assert.throws(()=>validateCandidate(c),error('WF0_INVALID_JSON')); assert.equal(called,0);
  const cycle:Record<string,unknown>={}; cycle.x=cycle; assert.throws(()=>validateCandidate(cycle),error('WF0_INVALID_JSON'));
  assert.throws(()=>validateCandidate(new Date()),error('WF0_INVALID_JSON'));
  const sparse=Array(2); sparse[1]=1; assert.throws(()=>teachingDigest(sparse),error('WF0_INVALID_JSON'));
});
test('validators own and deeply freeze snapshots without freezing caller objects',()=>{
  const { b }=fixture(), out=validateCandidate(b.candidates[0]); b.candidates[0]!.questionNodes[0]!.questionRef.id='changed';
  assert.equal(out.value.questionNodes[0]!.questionRef.id,'question-a'); assert.ok(Object.isFrozen(out.value.questionNodes[0]!.questionRef));
  assert.ok(!Object.isFrozen(b.candidates[0])); assert.throws(()=>{ (out.value as CandidateRecord).id='mutation'; },TypeError);
});
test('requested and returned aliases do not manufacture an immutable revision',()=>{
  const { b }=fixture(), result=validateTeacherCapability(b.teacher).value;
  assert.equal(result.immutableRevision,null); assert.equal(result.requestedModelId,'requested-alias'); assert.equal(result.returnedModelId,'returned-alias');
  assert.throws(()=>validateTeacherCapability({...b.teacher,immutableRevision:'revision-a'}),error('WF0_VERSION_EVIDENCE_REQUIRED'));
});
test('external model tokens retain slash identifiers and revisions starting with digits',()=>{
  const { b }=fixture(); b.teacher.requestedModelId='openai/gpt-oss-120b'; b.teacher.returnedModelId='provider:alias-v1';
  b.teacher.immutableRevision='259ac6b5eb6a6d23710e0c6a07f8793835362d5e'; b.teacher.modelVersionEvidence=ref('version-evidence');
  const out=validateTeacherCapability(b.teacher).value; assert.equal(out.requestedModelId,b.teacher.requestedModelId); assert.equal(out.immutableRevision,b.teacher.immutableRevision);
});
test('ResearchMentor is metadata only and renaming in the plan does not change trusted role',()=>{
  for (const material of ['teaching_content','student_answer','per_item_feedback','sealed_content']) assert.equal(checkTeachingRoleAccess('ResearchMentor',material),false);
  assert.equal(checkTeachingRoleAccess('ResearchMentor','operational_metadata'),true);
  assert.equal(checkTeachingRoleAccess('TeachingCoordinator','sealed_content'),false);
  const f=fixture(); assert.throws(()=>validateTeachingPlan({...f.b.plan,coordinatorRole:'ResearchMentor'}),error('WF0_COORDINATOR_ROLE_REQUIRED'));
  f.t.roles[0]!.role='ResearchMentor'; refused(f,'WF0_COORDINATOR_ROLE_REQUIRED');
});
test('declared ALLOW cannot replace a separate current use-specific decision',()=>{
  for (const value of ['UNKNOWN','DENY'] as const) { const f=fixture(); f.t.decisions[1]!.uses.train=value; refused(f,'WF0_RIGHTS_NOT_ALLOWED'); }
  const f=fixture(); f.t.decisions=[]; refused(f,'WF0_RIGHTS_BINDING');
});
test('coordinator permission covers content generation, training and public publication',()=>{
  for (const use of ['coordinate','generate','train','publish'] as const) { const f=fixture(); f.t.decisions[0]!.uses[use]='UNKNOWN'; refused(f,'WF0_RIGHTS_NOT_ALLOWED'); }
});
test('source declared restrictions and decision subject/digest mismatches fail closed',()=>{
  const f=fixture(); f.b.licenses[0]!.declaredUses.publish='DENY'; refresh(f.b); refused(f,'WF0_RIGHTS_NOT_ALLOWED');
  const g=fixture(); g.t.decisions[1]!.subjectId='other-source'; refused(g,'WF0_RIGHTS_BINDING');
  const h=fixture(); h.t.decisions[1]!.ref.sha256='b'.repeat(64); refused(h,'WF0_RIGHTS_BINDING');
});
test('epochs, runtime restart, expiry and backwards time reject the old declaration',()=>{
  const f=fixture(); f.t.authority.revision++; refused(f,'WF0_STALE_AUTHORITY');
  const g=fixture(); g.t.authority.runtimeId='runtime-b'; refused(g,'WF0_STALE_AUTHORITY');
  const h=fixture(); h.t.asOf=200; h.t.expiresAt=300; refused(h,'WF0_EXPIRED');
  const j=fixture(); j.t.asOf=9; refused(j,'WF0_INVALID_TIME');
  const k=fixture(); k.t.decisions[1]!.expiresAt=100; refused(k,'WF0_EXPIRED_RIGHTS');
});
test('family ancestry rejects missing parents and cycles',()=>{
  const f=fixture(); f.b.registry.nodes[1]!.parentIds=['missing']; assert.throws(()=>validateFamilySplit(f.b.registry),error('WF0_MISSING_ANCESTOR'));
  const g=fixture(); g.b.registry.nodes[0]!.parentIds=['derived-a']; assert.throws(()=>validateFamilySplit(g.b.registry),error('WF0_LINEAGE_CYCLE'));
});
test('discarded bridge connects transitive families before any row is removed',()=>{
  const { b }=fixture(), sample=b.registry.nodes[0]!;
  b.registry.nodes=[{...sample,id:'a',familyId:'family-a',parentIds:[],split:'train'},
    {...sample,id:'b',familyId:'family-a',parentIds:['a','c'],split:'quarantine',disposition:'discarded'},
    {...sample,id:'c',familyId:'family-a',parentIds:[],split:'sealedEval'}];
  b.candidates=[]; assert.throws(()=>checkTeachingAdmission(b,fixture().t),error('WF0_FAMILY_SPLIT_CONFLICT'));
});
test('same family labels and derivative edges cannot cross train/dev/calibration boundaries',()=>{
  for (const split of ['dev','calibration','sealedEval'] as const) {
    const { b }=fixture(); b.registry.nodes[1]!.split=split; assert.throws(()=>validateFamilySplit(b.registry),error('WF0_FAMILY_SPLIT_CONFLICT'));
  }
  const { b }=fixture(); b.registry.nodes[1]!.parentIds=[]; b.registry.nodes[1]!.split='dev';
  assert.throws(()=>validateFamilySplit(b.registry),error('WF0_FAMILY_SPLIT_CONFLICT'));
});
test('private derivation cannot be relabelled public, even without an admitted row',()=>{
  const { b }=fixture(); b.registry.nodes[0]!.dataClass='private'; b.candidates=[];
  assert.throws(()=>validateFamilySplit(b.registry),error('WF0_PRIVATE_DERIVATION'));
});
test('full private metadata can be checked but cannot use the public exporter',()=>{
  const f=fixture(); f.b.dataClass=f.b.plan.dataClass='private';
  for (const n of f.b.registry.nodes) n.dataClass='private'; for (const c of f.b.candidates) c.dataClass='private';
  for (const l of f.b.licenses) l.dataClass='private'; for (const d of f.t.decisions) d.dataClass='private'; refresh(f.b);
  assert.equal(checkTeachingAdmission(f.b,f.t).decision,'ELIGIBLE_METADATA');
  assert.throws(()=>exportTeachingManifest(f.b,f.t),error('WF0_PRIVATE_EXPORT_REFUSED'));
});
test('candidate sealed references are rejected; unrelated sealed registry entries are not exported',()=>{
  const { b,t }=fixture(); assert.throws(()=>validateCandidate({...b.candidates[0],split:'sealedEval'}),error('WF0_SEALED_BOUNDARY'));
  b.registry.nodes.push({...b.registry.nodes[0]!,id:'sealed-sensitive-node',familyId:'sealed-sensitive-family',split:'sealedEval',licenseRef:ref('sealed-sensitive-license')});
  const output=exportTeachingManifest(b,t); assert.ok(!output.json.includes('sealed-sensitive')); assert.ok(!output.json.includes('question-a'));
  b.registry.nodes[2]!.id='different-hidden-node'; b.registry.nodes[2]!.licenseRef=ref('different-hidden-license');
  assert.deepEqual(exportTeachingManifest(b,t),output);
  b.registry.nodes[2]!.dataClass='private'; assert.deepEqual(exportTeachingManifest(b,t),output);
});
test('known content fingerprints connect existing sealed/source registry nodes across candidate pages',()=>{
  const f=fixture(); f.b.registry.nodes.push({...f.b.registry.nodes[0]!,id:'old-sealed-node',familyId:'old-sealed-family',
    contentDigest:'a'.repeat(64),split:'sealedEval',disposition:'discarded'});
  assert.throws(()=>checkTeachingAdmission(f.b,f.t),error('WF0_FAMILY_SPLIT_CONFLICT'));
  f.b.registry.nodes[2]!.split='train'; f.b.registry.nodes[2]!.dataClass='private';
  assert.throws(()=>checkTeachingAdmission(f.b,f.t),error('WF0_CONTENT_DATA_CLASS_CONFLICT'));
});
test('synthetic answers cannot carry an actual receipt assertion',()=>{
  const { b }=fixture(); b.candidates[0]!.questionNodes[0]!.actualReceiptRef=ref('invented');
  assert.throws(()=>validateCandidate(b.candidates[0]),error('WF0_ANSWER_BINDING'));
});
test('actual answer requires the separately supplied bound inference receipt',()=>{
  const f=fixture(); actual(f); assert.equal(checkTeachingAdmission(f.b,f.t).decision,'ELIGIBLE_METADATA');
  f.t.inferenceReceipts=[]; refused(f,'WF0_ACTUAL_RECEIPT_REQUIRED');
});
test('actual receipt checks runner, candidate, question, answer, model, epoch and observed time',()=>{
  const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>{f.t.roles[1]!.role='Teacher';}, f=>{f.t.inferenceReceipts[0]!.candidateId='other';},
    f=>{f.t.inferenceReceipts[0]!.questionRef=ref('other');}, f=>{f.t.inferenceReceipts[0]!.answerRef=ref('other');},
    f=>{f.t.inferenceReceipts[0]!.studentSnapshotRef=ref('other');}, f=>{f.t.inferenceReceipts[0]!.authority.runtimeId='old';},
    f=>{f.t.inferenceReceipts[0]!.observedAt=101;}, f=>{f.t.inferenceReceipts[0]!.observedAt=0;},
    f=>{f.t.inferenceReceipts[0]!.observedAt=21;} ];
  for (const mutate of mutations) { const f=fixture(); actual(f); mutate(f); refused(f,'WF0_ACTUAL_RECEIPT_REQUIRED'); }
});
test('same identity/content is idempotent; a changed identity body is never overwritten',()=>{
  const f=fixture(); f.b.candidates.push(structuredClone(f.b.candidates[0]!));
  assert.deepEqual(checkTeachingAdmission(f.b,f.t).counts,{ input:2,unique:1,duplicates:1,eligible:1,excluded:0 });
  f.b.candidates[1]!.declaredTokens++; assert.throws(()=>checkTeachingAdmission(f.b,f.t),error('WF0_CANDIDATE_ID_CONFLICT'));
});
test('same content digest under new source/candidate IDs cannot evade split or privacy checks',()=>{
  for (const split of ['train','dev'] as const) {
    const f=fixture(); f.b.candidates.push({...structuredClone(f.b.candidates[0]!),id:'candidate-b',split,dataClass:'private',lineageNodeId:'other'});
    assert.throws(()=>checkTeachingAdmission(f.b,f.t),error(split==='dev'?'WF0_CONTENT_SPLIT_CONFLICT':'WF0_CONTENT_IDENTITY_CONFLICT'));
  }
});
test('reference digests, lineage candidate identity and explicit ancestor IDs must match',()=>{
  const f=fixture(); f.b.candidates[0]!.planRef.sha256='b'.repeat(64); refused(f,'WF0_REFERENCE_MISMATCH');
  const g=fixture(); g.b.registry.nodes[1]!.candidateId='other'; refused(g,'WF0_LINEAGE_BINDING');
  const h=fixture(); h.b.candidates[0]!.parentCandidateIds=['absent']; refused(h,'WF0_PARENT_CANDIDATE_BINDING');
});
test('question graph cycles, unknown parents, depth and branch boundaries fail closed',()=>{
  const f=fixture(), c=f.b.candidates[0]!, node=c.questionNodes[0]!;
  c.questionNodes=[{...node,parentId:node.id}]; assert.throws(()=>validateCandidate(c),error('WF0_QUESTION_CYCLE'));
  c.questionNodes=[{...node,parentId:'missing'}]; assert.throws(()=>validateCandidate(c),error('WF0_QUESTION_PARENT'));
  c.questionNodes=Array.from({length:8},(_,i)=>({...node,id:'n'+i,parentId:i?'n'+(i-1):null})); validateCandidate(c);
  c.questionNodes.push({...node,id:'n8',parentId:'n7'}); assert.throws(()=>validateCandidate(c),error('WF0_LIMIT'));
  c.questionNodes=[node,...Array.from({length:3},(_,i)=>({...node,id:'branch'+i,parentId:node.id}))]; assert.throws(()=>validateCandidate(c),error('WF0_LIMIT'));
});
test('configured policy bounds are checked separately from global structural bounds',()=>{
  const f=fixture(); f.b.policy.maxActualAnswers=0; actual(f); refresh(f.b); refused(f,'WF0_PLAN_LIMIT');
  const g=fixture(); g.b.policy.maxDepth=1; const n=g.b.candidates[0]!.questionNodes[0]!;
  g.b.candidates[0]!.questionNodes.push({...n,id:'second',parentId:n.id}); refresh(g.b); refused(g,'WF0_PLAN_LIMIT');
});
test('record and batch count limits accept the boundary and reject plus one',()=>{
  const f=fixture(); f.b.candidates[0]!.declaredContentBytes=L.declaredContentBytes; f.b.candidates[0]!.declaredTokens=L.declaredTokens;
  validateCandidate(f.b.candidates[0]); f.b.candidates[0]!.declaredContentBytes++; assert.throws(()=>validateCandidate(f.b.candidates[0]),error('WF0_INVALID_NUMBER'));
  const g=fixture(); g.b.candidates=Array.from({length:L.candidates},()=>structuredClone(g.b.candidates[0]!));
  assert.equal(checkTeachingAdmission(g.b,g.t).counts.duplicates,127); g.b.candidates.push(structuredClone(g.b.candidates[0]!));
  assert.throws(()=>checkTeachingAdmission(g.b,g.t),error('WF0_LIMIT'));
});
test('registry node boundary and duplicate node identities are enforced',()=>{
  const f=fixture(), root=f.b.registry.nodes[0]!;
  f.b.registry.nodes=Array.from({length:L.registryNodes},(_,i)=>({...root,id:'root'+i,familyId:'family'+i})); validateFamilySplit(f.b.registry);
  f.b.registry.nodes.push({...root,id:'extra'}); assert.throws(()=>validateFamilySplit(f.b.registry),error('WF0_LIMIT'));
  const g=fixture(); g.b.registry.nodes.push(structuredClone(g.b.registry.nodes[0]!)); assert.throws(()=>validateFamilySplit(g.b.registry),error('WF0_DUPLICATE_ID'));
});
test('actual observation precedes candidate finalization, registry freeze and bundle creation',()=>{
  const f=fixture(); actual(f); assert.equal(checkTeachingAdmission(f.b,f.t).decision,'ELIGIBLE_METADATA');
  assert.ok(f.t.inferenceReceipts[0]!.observedAt<f.b.candidates[0]!.createdAt);
  assert.ok(f.b.candidates[0]!.createdAt<f.b.registry.frozenAt); assert.ok(f.b.registry.frozenAt<f.b.createdAt);
  f.b.registry.frozenAt=19; refused(f,'WF0_INVALID_TIME');
});
test('unknown candidate fingerprints cannot be hidden among historical registry nodes',()=>{
  const { b }=fixture(); b.registry.nodes[1]!.contentDigest=null;
  assert.throws(()=>validateFamilySplit(b.registry),error('WF0_CONTENT_DIGEST_REQUIRED'));
});
test('quarantine propagates through a supplied family even from a discarded sibling',()=>{
  const f=fixture(); f.b.registry.nodes.push({...f.b.registry.nodes[0]!,id:'quarantined-sibling',split:'quarantine',disposition:'discarded'});
  refused(f,'WF0_FAMILY_QUARANTINED');
});
test('question node and actual-answer bounds accept exact maxima then reject plus one',()=>{
  const { b }=fixture(), c=b.candidates[0]!, n=c.questionNodes[0]!;
  c.questionNodes=Array.from({length:L.questionNodes},(_,i)=>({...n,id:'node'+i,parentId:i?'node'+Math.floor((i-1)/2):null,
    answerOrigin:i<L.actualAnswers?'actual':'synthetic',actualReceiptRef:i<L.actualAnswers?ref('receipt'+i):null}));
  validateCandidate(c); c.questionNodes[L.actualAnswers]!.answerOrigin='actual'; c.questionNodes[L.actualAnswers]!.actualReceiptRef=ref('one-too-many');
  assert.throws(()=>validateCandidate(c),error('WF0_LIMIT'));
  c.questionNodes[L.actualAnswers]!.answerOrigin='synthetic'; c.questionNodes[L.actualAnswers]!.actualReceiptRef=null;
  c.questionNodes.push({...n,id:'extra-node',parentId:'node7'}); assert.throws(()=>validateCandidate(c),error('WF0_LIMIT'));
});
test('registry edge budget rejects plus one independently of node count',()=>{
  const { b }=fixture(), root=b.registry.nodes[0]!;
  b.registry.nodes=Array.from({length:129},(_,i)=>({...root,id:'edge-node'+i,parentIds:Array.from({length:i},(_,j)=>'edge-node'+j)}));
  // Sum(0..128)=8256; remove 64 edges to hit the exact 8192 bound.
  b.registry.nodes[128]!.parentIds.splice(0,64); validateFamilySplit(b.registry);
  b.registry.nodes[128]!.parentIds.push('edge-node0'); assert.throws(()=>validateFamilySplit(b.registry),error('WF0_LIMIT'));
});
test('empty/rejected datasets retain NOT_EVALUATED and no execution authority',()=>{
  const f=fixture(); f.b.candidates=[]; const empty=checkTeachingAdmission(f.b,f.t); assert.equal(empty.counts.eligible,0); assert.equal(empty.quality,'NOT_EVALUATED');
  const g=fixture(); g.b.candidates[0]!.disposition='rejected'; const rejected=checkTeachingAdmission(g.b,g.t); assert.equal(rejected.counts.eligible,0);
  assert.equal(JSON.parse(exportTeachingManifest(g.b,g.t).json).execution,'NOT_AUTHORIZED');
});
test('canonical public metadata export is repeatable, bounded, revalidated and content-free',()=>{
  const { b,t }=fixture(), before=JSON.stringify(b), first=exportTeachingManifest(b,t), second=exportTeachingManifest(JSON.stringify(b),JSON.stringify(t));
  assert.deepEqual(first,second); assert.equal(JSON.stringify(b),before); assert.ok(first.bytes<L.exportBytes);
  const manifest=JSON.parse(first.json) as Record<string,unknown>; assert.equal(first.sha256,teachingDigest(manifest));
  assert.equal(first.json,canonicalTeachingJson(manifest)); assert.ok(!first.json.includes('coordinator-rights-a')); assert.ok(!first.json.includes('answer-a'));
  t.authority.revision++; assert.throws(()=>exportTeachingManifest(b,t),error('WF0_EXPORT_REFUSED'));
});
