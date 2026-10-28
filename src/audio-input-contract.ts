import { speechInteger, speechObject, speechString } from './speech-contract.ts';

/** SP06 declaration-only boundary. No microphone, ASR, diarization or Host event implementation. */
export type AudioInputCandidate = Readonly<{ version:1; inputId:string; kind:'hypothesis'|'final';
  source:'human_candidate'|'self_tts'|'echo'|'replay'|'unknown'; sourceRef:Readonly<{id:string;revision:number}>;
  speakerAttribution:'unverified'|'host-verified'; text:string }>;
export type AudioInputDecision = Readonly<{ admitted:false; code:'NOT_FINAL'|'SELF_AUDIO'|'UNAUTHENTICATED_SPEAKER'|'HOST_SOURCE_POLICY_REQUIRED';
  nextRoute:readonly ['R01','R04','R05','appraisal-candidate','state-admission','R03']; microphoneRead:false }>;
export function inspectAudioInputCandidate(value:unknown):AudioInputDecision {
  const c=speechObject(value,['version','inputId','kind','source','sourceRef','speakerAttribution','text']);
  speechString(c.inputId);speechString(c.text,4096);
  const source=speechObject(c.sourceRef,['id','revision']);speechString(source.id);speechInteger(source.revision);
  if(c.version!==1||!['hypothesis','final'].includes(c.kind as string)||
    !['human_candidate','self_tts','echo','replay','unknown'].includes(c.source as string)||
    !['unverified','host-verified'].includes(c.speakerAttribution as string)) throw new TypeError('INVALID_AUDIO_CANDIDATE');
  const code=c.kind!=='final'?'NOT_FINAL':['self_tts','echo','replay'].includes(c.source as string)?'SELF_AUDIO':
    c.speakerAttribution!=='host-verified'||c.source==='unknown'?'UNAUTHENTICATED_SPEAKER':'HOST_SOURCE_POLICY_REQUIRED';
  return Object.freeze({admitted:false,code,nextRoute:Object.freeze(['R01','R04','R05','appraisal-candidate','state-admission','R03'] as const),microphoneRead:false});
}
