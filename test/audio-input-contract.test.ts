import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectAudioInputCandidate } from '../src/audio-input-contract.ts';
const input={version:1,inputId:'synthetic',kind:'final',source:'human_candidate',sourceRef:{id:'synthetic-source',revision:0},speakerAttribution:'host-verified',text:'original synthetic input'};
test('F23 audio candidates never become admitted user evidence or direct R03 state',()=>{
  for(const source of ['self_tts','echo','replay'])assert.equal(inspectAudioInputCandidate({...input,source}).code,'SELF_AUDIO');
  assert.equal(inspectAudioInputCandidate({...input,kind:'hypothesis'}).code,'NOT_FINAL');
  assert.equal(inspectAudioInputCandidate({...input,speakerAttribution:'unverified'}).code,'UNAUTHENTICATED_SPEAKER');
  const result=inspectAudioInputCandidate(input);assert.equal(result.code,'HOST_SOURCE_POLICY_REQUIRED');assert.equal(result.admitted,false);
  assert.deepEqual(result.nextRoute,['R01','R04','R05','appraisal-candidate','state-admission','R03']);assert.equal(result.microphoneRead,false);
  assert.throws(()=>inspectAudioInputCandidate({...input,userAcknowledged:true}),/INVALID_SHAPE/);
});
