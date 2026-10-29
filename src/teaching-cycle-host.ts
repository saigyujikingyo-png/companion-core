import { existsSync,readdirSync } from 'node:fs';
import { isAbsolute,join,relative,sep } from 'node:path';
import { canonical,hash,stop } from './wf1-json.ts';
import { bindTrainingRoot,requireTrainingBinding } from './wf2-training-root.ts';
import { openTeachingCycle } from './teaching-cycle-store.ts';
import type { TeachingCycleStore,TeachingCycleStoreOptions } from './teaching-cycle-store.ts';
import { cycleAuditId,validateCurriculumPlan,validateCycleOwner } from './teaching-cycle-types.ts';
import type { ChildState,CurriculumPlan,CycleOwner } from './teaching-cycle-types.ts';
import { requireRealPlanAdmission,synchronousCheck } from './teaching-cycle-admission.ts';
import { openProductionJob } from './corpus-production-store.ts';
import type { ProductionStoreOptions } from './corpus-production-store.ts';
import type { ProductionRegistry } from './corpus-production-types.ts';
import type { ProductionTransport } from './corpus-production-runner.ts';
import { openQualityArchive } from './corpus-qa-source.ts';
import { openQualityAudit } from './corpus-qa-store.ts';
import type { AuditAdmission,AuditSelection,AuditSpec } from './corpus-qa-types.ts';
import { readQualityIndex,verifyQualityAudit } from './corpus-qa-runner.ts';
import type { QaTransport } from './corpus-qa-runner.ts';
import { openQualityIndexArchive } from './corpus-qa-index-archive.ts';
import type { QaIndexArchiveAdmission,QaIndexArchiveDescriptor } from './corpus-qa-index-archive.ts';
import type { TeachingCyclePorts } from './teaching-cycle-runner.ts';
import { teachingCycleBuildDigest } from './teaching-cycle-build.ts';
import { HostAuthority } from './wf1-storage.ts';
export { deterministicTeachingAuditBinding,sealTeachingQaArchive } from './teaching-cycle-host-bindings.ts';

export type TeachingChildHostBinding={childId:string;
  production:Omit<ProductionStoreOptions,'mode'|'approvedTrainingRoot'> & {objective:string;registry:ProductionRegistry;transport:ProductionTransport;tokenizer:{profile:unknown;pythonPath:string};authorizeSelection:()=>void;finalizeAuthority?:(binding:{specDigest:string;committedHead:string})=>Promise<void>};
  audit:{runtimeRoot:string;authorityPath:string;key:Uint8Array;transport:QaTransport;now?:()=>number;
    /** Load or durably create the SAME fixed audit binding for this selection.
     * Never replace an existing spec after a failed or unknown create. */
    bind:(selection:AuditSelection)=>{spec:AuditSpec;admission:()=>AuditAdmission}};
  archive:{readerBuildDigest:string;admission:(descriptor:QaIndexArchiveDescriptor)=>QaIndexArchiveAdmission;
    /** Called after both QA/source handles close. Freeze a descriptor from an
     * actual current-process metadata reopen; final independent cold is separate. */
    seal:(context:{child:ChildState;spec:AuditSpec;selection:AuditSelection;index:ReturnType<typeof readQualityIndex>;state:ReturnType<typeof verifyQualityAudit>['state'];committedHead:string})=>Promise<QaIndexArchiveDescriptor>};
};
export type TeachingCycleHostOptions={cycle:TeachingCycleStoreOptions;plan:CurriculumPlan;owner:CycleOwner;children:TeachingChildHostBinding[];checkChildMetadata:TeachingCyclePorts['checkChildMetadata'];signal?:AbortSignal};
function custodyMode(root:string,file:string):'create'|'resume'{if(existsSync(join(root,file)))return 'resume';if(readdirSync(root).length)stop('TC_CUSTODY_INCOMPLETE');return 'create';}
const same=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))stop('TC_HOST_BINDING');};
function overlaps(a:string,b:string){const r=relative(a,b);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);}
function fixedAuthority(path:string,spec:{runtimeId:string;authorityRevision:number;expiresAt:number},jobId:string,now=Date.now){const a=new HostAuthority(path,jobId,now).read(now(),false);if(a.runtimeId!==spec.runtimeId||a.expiresAt!==spec.expiresAt||a.revision!==spec.authorityRevision+(a.status==='REVOKED'?1:0))stop('TC_HOST_AUTHORITY');return a;}

/** Portable composition, not a credential manager or permission issuer. All
 * custody paths, original grants and private keys come from the trusted launcher.
 * It must supply the approved deployment root and bind real Windows ownership.
 * No environment lookup, default root, fresh-ID fallback or local reclaim exists. */
export function openTeachingCycleHost(input:TeachingCycleHostOptions){
  const spec=input.cycle.spec,plan=validateCurriculumPlan(input.plan,spec),owner=validateCycleOwner(input.owner);
  if(spec.version!=='TeachingCycle/0.2'||spec.buildDigest!==teachingCycleBuildDigest())stop('TC_HOST_PROFILE');
  requireRealPlanAdmission(spec,input.cycle.mode!=='inspect',input.cycle.realPlanAdmission);
  if(input.children.length!==plan.children.length||new Set(input.children.map(c=>c.childId)).size!==input.children.length)stop('TC_HOST_CHILDREN');
  const approvedTrainingRoot=input.cycle.approvedTrainingRoot,paths=[requireTrainingBinding(approvedTrainingRoot,input.cycle.runtimeRoot,spec.storageBindingDigest,input.cycle.authorityPath).runtimeRoot];
  const ownedKeys:Buffer[]=[],copyKey=(key:Uint8Array)=>{const copy=Buffer.from(key);ownedKeys.push(copy);return copy;},wipe=()=>{for(const key of ownedKeys)key.fill(0);ownedKeys.length=0;};let opened:TeachingCycleStore|undefined;
  try{
  const children=new Map(input.children.map(binding=>{
    const child=plan.children.find(c=>c.childId===binding.childId),p=binding.production;
    if(!child||p.spec.version!=='CorpusProduction/0.2'||hash(canonical(p.spec))!==child.productionSpecDigest||p.spec.unitCount!==child.plannedUnits||plan.version!=='TeachingCurriculumPlan/0.2'||p.spec.objectiveDigest!==plan.approvedObjectiveDigest||hash(p.objective)!==p.spec.objectiveDigest||hash(canonical(p.registry))!==p.spec.registryDigest)stop('TC_HOST_CHILDREN');
    paths.push(requireTrainingBinding(approvedTrainingRoot,p.runtimeRoot,p.spec.storageBindingDigest,p.authorityPath).runtimeRoot);
    // The QA spec is selection-dependent. Its fixed root is checked again when
    // bind returns that spec; this initial check canonicalizes the custody path.
    const auditRoot=requireTrainingBinding(approvedTrainingRoot,binding.audit.runtimeRoot,bindTrainingRoot(approvedTrainingRoot,binding.audit.runtimeRoot).storageBindingDigest,binding.audit.authorityPath).runtimeRoot;
    paths.push(auditRoot);
    return [binding.childId,{...binding,production:{...p,spec:structuredClone(p.spec),registry:structuredClone(p.registry),key:copyKey(p.key)},audit:{...binding.audit,key:copyKey(binding.audit.key)},archive:{...binding.archive}}] as const;
  }));
  if(paths.some((a,i)=>paths.some((b,j)=>i!==j&&overlaps(a,b))))stop('TC_HOST_CUSTODY');
  const store=openTeachingCycle({...input.cycle,spec});opened=store;const metadata:TeachingCyclePorts['checkChildMetadata']=child=>{store.check(false);synchronousCheck(()=>input.checkChildMetadata(structuredClone(child)),'TC_METADATA_CHECK');};
  const get=(child:ChildState)=>{const binding=children.get(child.childId);if(!binding||binding.production.spec&&hash(canonical(binding.production.spec))!==child.productionSpecDigest)stop('TC_HOST_BINDING');metadata(child);return binding;};
  const index=(child:ChildState,descriptor:QaIndexArchiveDescriptor)=>{const b=get(child);if(descriptor.spec.auditId!==cycleAuditId(spec.cycleId,child.childId)||descriptor.source.specDigest!==child.productionSpecDigest)stop('TC_HOST_BINDING');return openQualityIndexArchive({approvedTrainingRoot,runtimeRoot:b.audit.runtimeRoot,authorityPath:b.audit.authorityPath,key:b.audit.key,descriptor,descriptorDigest:hash(canonical(descriptor)),readerBuildDigest:b.archive.readerBuildDigest,admission:()=>b.archive.admission(structuredClone(descriptor)),...(b.audit.now?{now:b.audit.now}:{})});};
  const finalizers=[...children.values()].filter(b=>b.production.finalizeAuthority);if(finalizers.length&&finalizers.length!==children.size)stop('TC_HOST_FINALIZERS');
  const finalizeProductionSource:NonNullable<TeachingCyclePorts['finalizeProductionSource']>=async(child,production)=>{const p=get(child).production;if(!p.finalizeAuthority)return production.store;const specDigest=hash(canonical(production.store.spec)),committedHead=production.store.check(false).head;if(child.stage!=='TOKENS'||!committedHead||specDigest!==child.productionSpecDigest)stop('TC_FINALIZED_SOURCE');production.store.close();const result=await p.finalizeAuthority({specDigest,committedHead});if(result!==undefined)stop('TC_FINALIZED_SOURCE');store.check();const a=fixedAuthority(p.authorityPath,p.spec,p.spec.jobId,p.now);if(a.status!=='REVOKED'||a.head!==committedHead)stop('TC_FINALIZED_SOURCE');const reopened=openProductionJob({...p,approvedTrainingRoot,mode:'inspect'});try{same(reopened.spec,p.spec);same(reopened.check(false).head,committedHead);return reopened;}catch(error){reopened.close();throw error;}};
  const ports:TeachingCyclePorts={store,plan,owner,...(finalizers.length?{finalizeProductionSource}:{}),checkChildMetadata:metadata,...(input.signal?{signal:input.signal}:{}),
    openProduction:async child=>{const b=get(child),p=b.production;store.check();const a=fixedAuthority(p.authorityPath,p.spec,p.spec.jobId,p.now),mode=child.stage==='TOKENS'&&p.finalizeAuthority&&a.status==='REVOKED'?'inspect':custodyMode(p.runtimeRoot,'corpus-production.sqlite');const production=openProductionJob({...p,approvedTrainingRoot,mode});return {store:production,objective:p.objective,registry:p.registry,transport:p.transport,runtimeRoot:p.runtimeRoot,authorityPath:p.authorityPath,tokenizer:p.tokenizer,authorizeSelection:()=>{metadata(child);synchronousCheck(p.authorizeSelection,'TC_SELECTION_CHECK');}};},
    openAudit:async(child,selection)=>{
      const b=get(child),bound=b.audit.bind(structuredClone(selection));store.check();const audit=bound.spec;
      if(audit.version!=='CorpusQualityAudit/0.2'||audit.auditId!==cycleAuditId(spec.cycleId,child.childId)||audit.selectionDigest!==hash(canonical(selection))||audit.objectiveDigest!==b.production.spec.objectiveDigest||child.auditSpecDigest!==null&&hash(canonical(audit))!==child.auditSpecDigest)stop('TC_HOST_BINDING');
      requireTrainingBinding(approvedTrainingRoot,b.audit.runtimeRoot,audit.storageBindingDigest,b.audit.authorityPath);
      const source=openQualityArchive({approvedTrainingRoot,sourceRuntimeRoot:b.production.runtimeRoot,sourceAuthorityPath:b.production.authorityPath,sourceSpec:b.production.spec,selection,spec:audit,key:b.production.key,admission:bound.admission,...(b.audit.now?{now:b.audit.now}:{})});
      try{const a=fixedAuthority(b.audit.authorityPath,audit,audit.auditId,b.audit.now),mode=child.stage==='INDEX'&&a.status==='REVOKED'?'inspect':custodyMode(b.audit.runtimeRoot,'corpus-qa.sqlite');const qa=openQualityAudit({approvedTrainingRoot,runtimeRoot:b.audit.runtimeRoot,authorityPath:b.audit.authorityPath,key:b.audit.key,spec:audit,admission:bound.admission,sourceCheck:source.check,mode,...(b.audit.now?{now:b.audit.now}:{})});try{if(qa.mode==='create')qa.initialize(selection,b.production.objective);return {store:qa,source,selection,objective:b.production.objective,transport:b.audit.transport};}catch(error){qa.close();throw error;}}catch(error){source.close();throw error;}
    },
    archiveAudit:async(child,qa)=>{const b=get(child),verified=verifyQualityAudit(qa.store,qa.source),fullIndex=readQualityIndex(qa.store,verified.state.indexRef!),committedHead=qa.store.check(false).head;if(!committedHead)stop('TC_HOST_BINDING');qa.store.close();qa.source.close();const descriptor=await b.archive.seal({child:structuredClone(child),spec:qa.store.spec,selection:qa.selection,index:fullIndex,state:verified.state,committedHead});store.check();same(descriptor.spec,qa.store.spec);same(descriptor.committedHead,committedHead);same(descriptor.source,qa.selection.source);same(descriptor.indexRef,verified.state.indexRef);same(descriptor.manifestRef,verified.state.manifestRef);same(descriptor.indexDigest,hash(canonical(fullIndex)));return index(child,descriptor);},
    openIndex:index};
  let closed=false;return {ports,automaticLocalReclaim:'DISABLED' as const,close(){if(closed)return;closed=true;try{store.close();}finally{wipe();children.clear();}}};
  }catch(error){try{opened?.close();}finally{wipe();}throw error;}
}
