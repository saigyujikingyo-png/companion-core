import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical,hash,stop } from '../src/wf1-json.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { cycleAuditId } from '../src/teaching-cycle-types.ts';
import { openTeachingCycleHost,deterministicTeachingAuditBinding,sealTeachingQaArchive } from '../src/teaching-cycle-host.ts';
import type { TeachingChildHostBinding,TeachingCycleHostOptions } from '../src/teaching-cycle-host.ts';
import type { TeachingAuditTemplate } from '../src/teaching-cycle-host-bindings.ts';
import { QA_V2_PROFILE_DIGEST,QA_TARGET_BASELINE_DIGEST } from '../src/corpus-qa-types.ts';
import type { AuditAdmission,AuditSelection,QaPurposeManifest,QaRoute } from '../src/corpus-qa-types.ts';
import { QA_INDEX_ARCHIVE_SCOPE } from '../src/corpus-qa-index-archive.ts';
import type { QaIndexArchiveDescriptor,QaIndexArchiveAdmission } from '../src/corpus-qa-index-archive.ts';
import { prepareProductionFixture } from './corpus-production-fixture.ts';
import { cycleFixture,syntheticOwner,syntheticTokenizerProfile } from './teaching-cycle-fixture.ts';
import { nativeProduction,nativeQa } from './corpus-policy-v2-fixture.ts';

/** Only synthetic data and keys. The saved object is a fixture, not a production
 * grant, mentor receipt, credential file or deployable native configuration. */
export function teachingHostFixture(savedPath?:string,mode:'resume'|'inspect'='inspect'){
  let data:any;
  if(savedPath)data=JSON.parse(readFileSync(savedPath,'utf8'));
  else{
    const originals=Array.from({length:4},(_,i)=>prepareProductionFixture(8,r=>{if(i===1)for(const s of r.slots)s.split=s.split==='train'?'dev':'train';},true,'synthetic-host-production-'+i)),approvedTrainingRoot=originals[0]!.options.approvedTrainingRoot;
    for(const [i,o]of originals.entries())if(i){o.options.approvedTrainingRoot=approvedTrainingRoot;o.options.runtimeRoot=join(approvedTrainingRoot,'production-'+i);mkdirSync(o.options.runtimeRoot);o.spec.storageBindingDigest=bindTrainingRoot(approvedTrainingRoot,o.options.runtimeRoot).storageBindingDigest;}
    const f=cycleFixture(originals.map((o,i)=>({childId:'child-'+i,microRound:Math.floor(i/2),shard:i%2,plannedUnits:8,productionSpecDigest:hash(canonical(o.spec))})),{},true);f.store.close();const runtimeRoot=join(approvedTrainingRoot,'cycle-host');mkdirSync(runtimeRoot);f.spec.storageBindingDigest=bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest;
    const cycle={base:f.base,plan:f.plan,spec:f.spec,options:{...f.options,approvedTrainingRoot,runtimeRoot,key:undefined,admission:undefined,realPlanAdmission:undefined}},now=f.spec.createdAt;
    const audits=originals.map((o,i)=>{
      const runtimeRoot=join(approvedTrainingRoot,'qa-'+i);mkdirSync(runtimeRoot);const authorityPath=join(o.base,'host-qa-authority.json'),reviewer:QaRoute={provider:'together',model:'openai/gpt-oss-120b',service:'together-serverless-api',accountType:'api',accountRef:'synthetic-together'},purposes:QaPurposeManifest={version:'CorpusQualityPurposes/0.1',revision:'synthetic-host-purposes',grants:[...o.purposes.grants,...(['review','training'] as const).map(purpose=>({grantId:'qa-'+purpose,route:reviewer,purpose,decision:'ALLOW' as const,termsEvidence:{ref:'https://example.invalid/synthetic',version:'synthetic',digest:hash('synthetic')},parentGrantIds:['training']}))]};
      const template:TeachingAuditTemplate={version:'CorpusQualityAudit/0.2',auditId:cycleAuditId(f.spec.cycleId,'child-'+i),buildDigest:hash('synthetic-qa-loaded'),profileDigest:QA_V2_PROFILE_DIGEST,objectiveDigest:o.spec.objectiveDigest,baselineDigest:o.spec.factoryBaselineDigest,auditTargetBaselineDigest:QA_TARGET_BASELINE_DIGEST,studentTargetDigest:o.spec.studentTargetDigest,storageBindingDigest:bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest,authorityRevision:1,runtimeId:'synthetic-host-qa-'+i,createdAt:now,expiresAt:f.spec.expiresAt,coordinator:o.spec.coordinator,reviewer,prices:{deepseek:null,together:null},execution:{concurrency:2}};
      writeFileSync(authorityPath,canonical({schemaVersion:'wf1-host/1',campaignId:template.auditId,revision:1,runtimeId:template.runtimeId,status:'ACTIVE',expiresAt:template.expiresAt,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}}));return {runtimeRoot,authorityPath,template,purposes};
    });
    data={cycle,originals:originals.map(o=>({...o,options:{...o.options,key:undefined,admission:undefined},revokeSource:undefined})),audits};
  }
  let metadataAllowed=true,realAllowed=true,sends=0,peak=0;const active=new Set<string>(),metadata=(child:{childId:string;productionSpecDigest:string})=>{const c=data.cycle.plan.children.find((c:any)=>c.childId===child.childId);if(!metadataAllowed||!c||c.productionSpecDigest!==child.productionSpecDigest)stop('SYNTHETIC_METADATA_DENIED');};
  const enter=async(childId:string)=>{sends++;active.add(childId);peak=Math.max(peak,active.size);await delay(8);active.delete(childId);};
  const children:TeachingChildHostBinding[]=data.originals.map((o:any,i:number)=>{
    const childId='child-'+i,a=data.audits[i],admission=(selection:AuditSelection):AuditAdmission=>({readGrant:{version:'CorpusArchiveReadGrant/0.1',grantId:'synthetic-host-source-'+i,revision:1,selectionDigest:hash(canonical(selection)),purposeDigest:hash(canonical(a.purposes)),sourcePurposeDigest:o.spec.purposeDigest,readAllowed:metadataAllowed,retainAllowed:metadataAllowed,validFrom:data.cycle.spec.createdAt-1,expiresAt:data.cycle.spec.expiresAt,scope:'SELECTED_ELIGIBLE_ONLY'},purposes:a.purposes,sourceAllowed:metadataAllowed,retainAllowed:metadataAllowed});
    const archiveAdmission=(d:QaIndexArchiveDescriptor):QaIndexArchiveAdmission=>({grant:{version:'QaIndexReadGrant/0.1',grantId:'synthetic-host-index-'+i,revision:1,descriptorDigest:hash(canonical(d)),purposeDigest:d.spec.purposeDigest,status:'ACTIVE',readAllowed:metadataAllowed,retainAllowed:metadataAllowed,validFrom:data.cycle.spec.createdAt-1,expiresAt:data.cycle.spec.expiresAt,scope:QA_INDEX_ARCHIVE_SCOPE},sourceJobId:o.spec.jobId,sourcePurposeDigest:o.spec.purposeDigest,parentGrantIds:[],sourceAllowed:metadataAllowed,retainAllowed:metadataAllowed});
    const native=nativeProduction({usage:i%2?'missing':'known',change:async r=>{await enter(childId);if(r.operation==='candidate')for(const item of r.body.items){const ordinal=o.registry.slots.find((s:any)=>s.unitId===item.unitId).ordinal;item.prompt='SYNTHETIC '+(i<2?'shared-':'child-'+i+'-')+ordinal;item.response='SYNTHETIC response '+i+' '+ordinal;}}}),qa=nativeQa({usage:'missing',change:async r=>{await enter(childId);if(r.operation==='review'&&r.index===0&&i===1)r.body.items[0].disposition='REJECT';}}),readerBuildDigest=hash('synthetic-host-metadata-reader');
    return {childId,production:{...o.options,key:Buffer.alloc(32,73),admission:()=>({registryDigest:o.spec.registryDigest,sourceAllowed:metadataAllowed,retainAllowed:metadataAllowed,purposes:o.purposes}),objective:o.objective,registry:o.registry,transport:native.transport,tokenizer:{profile:syntheticTokenizerProfile(data.cycle.base),pythonPath:process.execPath},authorizeSelection:()=>metadata(data.cycle.plan.children[i])},audit:{runtimeRoot:a.runtimeRoot,authorityPath:a.authorityPath,key:Buffer.alloc(32,87),transport:qa.transport,bind:deterministicTeachingAuditBinding(a.template,admission)},archive:{readerBuildDigest,admission:archiveAdmission,seal:async (context:Parameters<TeachingChildHostBinding['archive']['seal']>[0])=>sealTeachingQaArchive(context,{approvedTrainingRoot:data.cycle.options.approvedTrainingRoot,runtimeRoot:a.runtimeRoot,authorityPath:a.authorityPath,key:Buffer.alloc(32,87),readerBuildDigest,checkMetadata:()=>metadata(context.child),admission:archiveAdmission})}};
  });
  const options:TeachingCycleHostOptions={cycle:{...data.cycle.options,key:Buffer.alloc(32,71),mode:savedPath?mode:'create',admission:()=>({planDigest:data.cycle.spec.planDigest,sourceAllowed:metadataAllowed,retainAllowed:metadataAllowed}),realPlanAdmission:()=>{if(!realAllowed)stop('SYNTHETIC_REAL_ADMISSION_DENIED');}},plan:data.cycle.plan,owner:syntheticOwner('synthetic-host-'+process.pid),children,checkChildMetadata:metadata},host=openTeachingCycleHost(options);
  return {host,options,data,get sends(){return sends;},get peak(){return peak;},denyMetadata(){metadataAllowed=false;},denyReal(){realAllowed=false;},persist(){const file=join(data.cycle.base,'host-reopen-synthetic.json');writeFileSync(file,JSON.stringify(data));return file;}};
}
