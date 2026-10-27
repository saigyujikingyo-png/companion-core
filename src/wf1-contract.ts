import { canonical,copyJson,digest,hash,id,integer,list,oneOf,shape,stop,text,unique } from './wf1-json.ts';
import { WF1 } from './wf1-types.ts';
import type { ArtifactRef,Authority,CampaignSpec,Family,Plan,Seal } from './wf1-types.ts';
import { validateFormal } from './wf1-verifier.ts';
import { WF2_TEACHER_PROFILE_DIGEST } from './wf2-teacher-policy.ts';
import { WF2_STRICT_PROFILE_DIGEST } from './wf2-strict-data.ts';
import { WF2_SLOTS_PROFILE_DIGEST } from './wf2-fixed-slots.ts';
import { slotProfile } from './wf2-named-data.ts';
import { WF2_PILOT_PROFILE_DIGEST } from './wf2-together-pilot.ts';

export const PROFILE_DIGEST=hash(canonical(WF1));
export function validateSpec(input:unknown):CampaignSpec {
  const own=copyJson(input),version=own!==null&&typeof own==='object'&&!Array.isArray(own)?own.schemaVersion:undefined;
  const s=shape(own,['schemaVersion','id','createdAt','expiresAt','sourceDigest','profileDigest','objectiveDigest','prices',...(version==='wf1-campaign/0.5'||version==='wf1-campaign/0.6'||version==='wf1-campaign/0.7'?['storageBindingDigest']:[])]);
  oneOf(s.schemaVersion,['wf1-campaign/0.3','wf1-campaign/0.4','wf1-campaign/0.5','wf1-campaign/0.6','wf1-campaign/0.7']);id(s.id);integer(s.createdAt);integer(s.expiresAt);if(s.schemaVersion==='wf1-campaign/0.5'||s.schemaVersion==='wf1-campaign/0.6'||s.schemaVersion==='wf1-campaign/0.7')digest(s.storageBindingDigest);
  if(Number(s.expiresAt)<=Number(s.createdAt)||Number(s.expiresAt)-Number(s.createdAt)>WF1.campaignMs)stop('WF1_TIME');
  digest(s.sourceDigest);digest(s.objectiveDigest);if(s.schemaVersion==='wf1-campaign/0.7'){if(s.profileDigest!==WF2_PILOT_PROFILE_DIGEST)stop('WF1_PROFILE');}else if(s.schemaVersion==='wf1-campaign/0.6')slotProfile(digest(s.profileDigest));else if(s.profileDigest!==(s.schemaVersion==='wf1-campaign/0.5'?WF2_STRICT_PROFILE_DIGEST:s.schemaVersion==='wf1-campaign/0.4'?WF2_TEACHER_PROFILE_DIGEST:PROFILE_DIGEST))stop('WF1_PROFILE');
  const prices=shape(s.prices,['deepseek','together']);for(const provider of ['deepseek','together']){const p=shape(prices[provider],['snapshotId','inputMicroUsdPerMillion','completionMicroUsdPerMillion']);id(p.snapshotId);integer(p.inputMicroUsdPerMillion,1,1_000_000_000);integer(p.completionMicroUsdPerMillion,1,1_000_000_000);}
  return s as CampaignSpec;
}
export function validateAuthority(input:unknown):Authority {
  const a=shape(copyJson(input),['schemaVersion','campaignId','revision','runtimeId','status','expiresAt','head','rights']);
  if(a.schemaVersion!=='wf1-host/1')stop('WF1_VERSION');id(a.campaignId);integer(a.revision,1);id(a.runtimeId);integer(a.expiresAt,1);
  oneOf(a.status,['ACTIVE','PAUSED','REVOKED']);if(a.head!==null)digest(a.head);
  const rights=shape(a.rights,['seal','coordinate','generate','review','retain']);for(const right of Object.values(rights))if(typeof right!=='boolean')stop('WF1_AUTHORITY');return a as Authority;
}
export function artifactRef(input:unknown):ArtifactRef {
  const a=shape(input,['id','kind','partition','bytes','digest']);if(typeof a.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.id))stop('WF1_ARTIFACT_ID');id(a.kind);oneOf(a.partition,['custody','train']);integer(a.bytes,28,WF1.artifactBytes+28);digest(a.digest);return a as ArtifactRef;
}
function family(input:unknown):Family {
  const f=shape(input,['id','roots','split','formal']);id(f.id);const roots=list(f.roots,16,1).map(id);unique(roots);oneOf(f.split,['train','dev']);validateFormal(f.formal);return f as Family;
}
export function validatePlan(input:unknown):Plan {
  const p=shape(copyJson(input),['version','plan','families','pairedFamilyIds']);if(p.version!=='wf1-plan/1')stop('WF1_VERSION');text(p.plan,4096);
  const families=list(p.families,16,16).map(family);unique(families.map(f=>f.id));
  if(families.slice(0,4).filter(f=>f.split==='train').length!==3||families.slice(4).filter(f=>f.split==='train').length!==9)stop('WF1_SPLIT');
  const pairs=list(p.pairedFamilyIds,8,8).map(id);unique(pairs);if(pairs.some(p=>!families.some(f=>f.id===p)))stop('WF1_PAIR_BINDING');return p as Plan;
}
export function validateSeal(input:unknown):Seal {
  const s=shape(copyJson(input),['version','rubric','cases']);if(s.version!=='wf1-seal/1')stop('WF1_VERSION');text(s.rubric,4096);
  const cases=list(s.cases,12,12).map(value=>{const c=shape(value,['id','roots','formal','target']);id(c.id);const roots=list(c.roots,16,1).map(id);unique(roots);validateFormal(c.formal);return c;});
  unique(cases.map(c=>c.id as string));return s as Seal;
}
export function estimateMicroUsd(input:number,completion:number,price:CampaignSpec['prices']['deepseek']):number {
  integer(input);integer(completion);const total=BigInt(input)*BigInt(price.inputMicroUsdPerMillion)+BigInt(completion)*BigInt(price.completionMicroUsdPerMillion);
  const rounded=(total+999999n)/1000000n;if(rounded>BigInt(Number.MAX_SAFE_INTEGER))stop('WF1_BUDGET');return Number(rounded);
}
