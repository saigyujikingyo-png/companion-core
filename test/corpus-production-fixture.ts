import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,realpathSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical,hash } from '../src/wf1-json.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { MODELS } from '../src/wf1-types.ts';
import { openProductionJob } from '../src/corpus-production-store.ts';
import { runCorpusProduction } from '../src/corpus-production-runner.ts';
import type { ProductionTransport } from '../src/corpus-production-runner.ts';
import { FACTORY_BASELINE,FACTORY_BASELINE_DIGEST,PRODUCTION_DIGEST,STUDENT_TARGET_DIGEST } from '../src/corpus-production-types.ts';
import type { ProductionRegistry,ProductionSpec,PurposeManifest,Route } from '../src/corpus-production-types.ts';
export function fixture(count=8,change?:(r:ProductionRegistry)=>void){
  const base=realpathSync.native(mkdtempSync(join(tmpdir(),'cpr-synthetic-'))),approvedTrainingRoot=join(base,'training'),runtimeRoot=join(approvedTrainingRoot,'production');mkdirSync(runtimeRoot,{recursive:true});const now=Date.now(),objective='SYNTHETIC approved objective; no real project samples.';
  const route:Route={provider:'deepseek',model:'deepseek-flash',service:'deepseek-official-api',accountType:'api',accountRef:'synthetic-account'};
  const purposes:PurposeManifest={version:'CorpusPurposes/0.1',revision:'synthetic-v1',grants:(['curriculum','generate','review','training'] as const).map(purpose=>({grantId:purpose,route,purpose,decision:'ALLOW',termsEvidence:{ref:'https://example.invalid/synthetic-terms',version:'synthetic',digest:hash('fixture terms')},parentGrantIds:[]}))};
  const registry:ProductionRegistry={version:'CorpusProductionRegistry/0.1',slots:Array.from({length:count},(_,i)=>({ordinal:i,unitId:['Z','a','A_','a-'][i%4]!+i,poolId:'synthetic-pool',familyId:'family-'+Math.floor(i/4),sourceId:'synthetic-source',roots:['root-'+Math.floor(i/4)],split:Math.floor(i/4)%2?'dev':'train',rightsDigest:hash('synthetic rights')})),blockedRoots:['sealed-root'],blockedFamilyIds:['sealed-family'],parentGrantIds:[]};change?.(registry);
  const spec:ProductionSpec={version:'CorpusProduction/0.1',jobId:'synthetic-production',profileDigest:PRODUCTION_DIGEST,buildDigest:hash('synthetic build'),objectiveDigest:hash(objective),registryDigest:hash(canonical(registry)),purposeDigest:hash(canonical(purposes)),studentTargetDigest:STUDENT_TARGET_DIGEST,factoryBaselineDigest:FACTORY_BASELINE_DIGEST,storageBindingDigest:bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest,authorityRevision:1,runtimeId:'synthetic-runtime',createdAt:now,expiresAt:now+3600000,unitCount:count,coordinator:route,pools:[{poolId:'synthetic-pool',capability:'science',generator:route,reviewer:route}],price:{snapshotId:'synthetic-price',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000},budgetMicroUsd:10000000};
  const authorityPath=join(base,'authority.json');writeFileSync(authorityPath,canonical({schemaVersion:'wf1-host/1',campaignId:spec.jobId,revision:1,runtimeId:spec.runtimeId,status:'ACTIVE',expiresAt:spec.expiresAt,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}}));
  let source=true;const options={approvedTrainingRoot,runtimeRoot,authorityPath,spec,key:Buffer.alloc(32,73),admission:()=>({registryDigest:spec.registryDigest,sourceAllowed:source,retainAllowed:true,purposes})};const store=openProductionJob({...options,mode:'create'});return {base,store,spec,registry,objective,purposes,options,revokeSource:()=>{source=false;}};
}
export type Fixture=ReturnType<typeof fixture>;
export function mock(f:Fixture,o:{bad?:number;badPlan?:number;reject?:number;duplicate?:number;unknown?:number;missingUsage?:number;overUsage?:number;rateLimit?:number;retryAfter?:number;pause?:number;revoke?:number;source?:number;slow?:boolean;transform?:(operation:string,items:any[])=>any[]}={}){
  const calls:{operation:string;index:number;at:number}[]=[],occupancy={plan:0,candidate:0,review:0,total:0},peaks={...occupancy};let sends=0;
  const transport:ProductionTransport=async r=>{
    calls.push({operation:r.operation,index:r.index,at:Date.now()});const payload=JSON.parse(JSON.parse(r.body).messages[1].content),data=payload.data;assert.equal(data.factoryBaselineDigest,FACTORY_BASELINE_DIGEST);assert.deepEqual(data.factoryBaseline,FACTORY_BASELINE);assert.ok(!r.body.includes('sealed-root'));assert.ok(!r.body.includes('synthetic rights'));
    assert.ok(f.store.snapshot()!.attempts.some(a=>a.operation===r.operation&&a.index===r.index&&a.serviceMs===null),'consume precedes send');occupancy[r.operation]++;occupancy.total++;for(const k of ['plan','candidate','review','total'] as const)peaks[k]=Math.max(peaks[k],occupancy[k]);
    await r.authorizeSend(()=>{sends++;return delay(o.slow?10:1);});
    let items:any[]=r.operation==='plan'?data.slots.filter((s:any)=>s.ordinal!==o.badPlan).map((s:any)=>({ordinal:s.ordinal,unitId:s.unitId,task:'SYNTHETIC task '+hash(String(s.ordinal)),rubric:'SYNTHETIC test criterion'})):r.operation==='candidate'?data.tasks.map((t:any)=>{const i=o.duplicate===t.ordinal?0:t.ordinal;return {version:'CorpusProductionItem/0.1',unitId:t.unitId,prompt:'Question '+hash('prompt'+i),response:'Answer '+hash('answer'+i),...(t.ordinal===o.bad?{unexpected:true}:{})};}):data.items.map((v:any)=>({unitId:v.candidate.unitId,candidateDigest:v.candidateDigest,disposition:v.task.ordinal===o.reject?'REJECT':'ACCEPT',notes:'SYNTHETIC review'}));if(o.transform)items=o.transform(r.operation,items);
    const ref=r.output.put('native-final',canonical({version:'CorpusProductionResponse/0.1',items}));if(r.operation==='candidate'&&o.pause===r.index)f.store.control('PAUSED');if(r.operation==='candidate'&&o.revoke===r.index)f.store.control('REVOKED');if(r.operation==='candidate'&&o.source===r.index)f.revokeSource();occupancy[r.operation]--;occupancy.total--;
    const rate=r.operation==='candidate'&&o.rateLimit===r.index;return {outcome:r.operation==='candidate'&&o.unknown===r.index?'SUBMIT_UNKNOWN':rate?'FAILED':'COMPLETED',requestedModel:MODELS.deepseek,returnedModel:MODELS.deepseek,requestId:'synthetic-request',transportLane:'SYNTHETIC_FIXTURE',httpStatus:rate?429:200,failure:rate?'HTTP_STATUS':null,finishReason:'stop',reasoningPresent:false,contentPresent:true,usage:rate||r.operation==='candidate'&&o.missingUsage===r.index?null:{input:r.operation==='candidate'&&o.overUsage===r.index?66049:100,completion:80,reasoning:20},rawRef:ref,reasoningRef:null,finalRef:ref,elapsedMs:1,...(rate?{retryAfterMs:o.retryAfter??10,retryAfterStatus:'VALID' as const}:{})};
  };return {transport,calls,peaks,get sends(){return sends;}};
}
export const run=(f:Fixture,m:ReturnType<typeof mock>)=>runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:m.transport});
