import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical,hash } from '../src/wf1-json.ts';
import { PRODUCTION,PRODUCTION_DIGEST } from '../src/corpus-production-types.ts';
import { QA,QA_PROFILE_DIGEST } from '../src/corpus-qa-types.ts';
import { BUILD_FILES,workerBuildDigest } from '../src/wf1-worker.ts';
import { FORMAT_BUILD_FILES,formatBuildDigest } from '../src/wf2-format-worker.ts';
import { TEACHER_WORKER_FILES,teacherWorkerBuildDigest } from '../src/wf2-teacher-build.ts';

test('all three existing worker pins cover the new response-policy module',()=>{
  for(const [files,digest] of [[BUILD_FILES,workerBuildDigest],[FORMAT_BUILD_FILES,formatBuildDigest],[TEACHER_WORKER_FILES,teacherWorkerBuildDigest]] as const){
    const fingerprint=(mutate:boolean)=>hash(Buffer.concat(files.flatMap(name=>[Buffer.from(name+'\0'),Buffer.concat([readFileSync(new URL('../src/'+name,import.meta.url)),Buffer.from(mutate&&name==='corpus-response-policy.ts'?'\n// SYNTHETIC policy mutation':'')])])));
    assert.equal(digest(),fingerprint(false));assert.notEqual(digest(),fingerprint(true));
  }
});
test('v1 production and QA profile bytes remain the published constants',()=>{
  assert.equal(canonical(PRODUCTION),canonical({version:'CorpusProduction/0.1',maxUnits:192,calibrationUnits:128,planUnits:16,generationUnits:4,reviewUnits:4,generationConcurrency:4,reviewConcurrency:4,planConcurrency:1,totalConcurrency:8,reviewQueueItems:32,inputReserve:66048,completionReserve:16384,requestBytes:65536,responseBytes:262144,requestMs:180000,maxWallMs:86400000,maxMicroUsd:10000000,shardRows:64,shardBytes:196608,tokenBatchRows:32,tokenBatchRequestBytes:2097152,trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'}));
  assert.equal(canonical(QA),canonical({version:'CorpusQualityAudit/0.1',maxRows:192,reviewRows:4,concurrency:4,requestBytes:65536,responseBytes:262144,inputReserve:66048,completionReserve:16384,requestMs:180000,maxWallMs:86400000,maxCooldownMs:30000,moneyPolicy:'ACCOUNTING_ONLY_NO_PROJECT_CEILING',trainingReady:false}));
  assert.equal(PRODUCTION_DIGEST,hash(canonical(PRODUCTION)));assert.equal(QA_PROFILE_DIGEST,hash(canonical(QA)));
});
