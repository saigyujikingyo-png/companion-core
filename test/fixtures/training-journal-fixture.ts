import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tjHash } from '../../src/training-journal-format.ts';
import type { TrainingAuthority } from '../../src/training-journal.ts';

export const DIGEST=tjHash('SYNTHETIC_ARTIFACT');
export const OTHER_DIGEST=tjHash('SYNTHETIC_OTHER_ARTIFACT');
export function authority(runtimeId='fixture-runtime'):TrainingAuthority {
  return {scopeId:'synthetic-scope',generation:'0',consentRevision:'1',runtimeId,now:1_000,expiresAt:2_000,
    read:true,write:true,export:true};
}
export const freshDirectory=()=>realpathSync(mkdtempSync(join(tmpdir(),'companion-tj0-')));
export function event(kind:string,sequence:number,data:unknown={},override:Record<string,unknown>={}):string {
  if(kind==='INTENT'&&Object.keys(data as object).length===0)data={purpose:'SYNTHETIC 训练履历 🧪 e\u0301',requestDigest:DIGEST,datasetDigest:DIGEST,
    modelDigest:null,parentAttemptId:null,seed:'18446744073709551615',plannedSteps:'9007199254740993'};
  return JSON.stringify({version:1,executionMode:'SYNTHETIC_FIXTURE',datasetOrigin:'SYNTHETIC',runId:'run-1',attemptId:'attempt-1',
    runnerId:'fixture-runner',jobId:'fixture-job',eventId:'event-'+sequence,sequence:String(sequence),kind,data,...override});
}
export function trace():string[] {
  return [event('INTENT',1),event('STARTED',2),event('STEP',3,{optimizerSteps:'9007199254740993',batches:null,metrics:[
    {name:'loss',unit:'ratio',value:{dtype:'f64',shape:[5],bits:'80000000000000007ff0000000000000fff00000000000007ff80000000000ab0000000000000001'}},
    {name:'unknown',unit:'count',value:null}]}),event('ARTIFACT',4,{artifactDigest:DIGEST,artifactKind:'ADAPTER'}),
    event('TERMINAL',5,{outcome:'COMPLETED'}),event('RELOAD',6,{artifactDigest:DIGEST,result:'PASS'}),
    event('EVALUATION',7,{artifactDigest:DIGEST,policyDigest:DIGEST,result:'PASS',metrics:[]}),
    event('ACTIVATION',8,{artifactDigest:DIGEST,state:'ACTIVE'}),event('ACTIVATION',9,{artifactDigest:DIGEST,state:'ROLLED_BACK'})];
}
