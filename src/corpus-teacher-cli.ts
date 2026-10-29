import { canonical,parseJson,shape,stop } from './wf1-json.ts';
import { ENDPOINTS,MODELS } from './wf1-types.ts';
import { STUDENT_TARGET,STUDENT_TARGET_DIGEST,TEACHER_PILOT,TEACHER_PILOT_DIGEST,validatePilotSpec } from './corpus-teacher-types.ts';
import { runTeacherPilot,teacherPilotSummary,verifyTeacherPilot } from './corpus-teacher-pilot.ts';
import type { PilotRunPorts } from './corpus-teacher-pilot.ts';
import type { TeacherPilotStore } from './corpus-teacher-store.ts';
import { measureTeacherPilotTokens,verifyTeacherPilotTokens } from './corpus-teacher-tokenizer.ts';

/** Host-bound command only: no CLI credential/environment discovery and no old-run readers.
 * The trusted launcher emits only this return value on stdout. */
export async function runTeacherPilotCommand(raw:string,ports:{store?:TeacherPilotStore;run?:Omit<PilotRunPorts,'store'>;tokenizer?:{profile:unknown;pythonPath:string}}={}){
  const c=shape(parseJson(raw,{bytes:16384,depth:8,nodes:128,stringBytes:4096}),['version','command','spec']);
  if(c.version!=='CorpusTeacherCommand/0.1')stop('CPQ_COMMAND');
  if(c.command==='describe'){if(c.spec!==null)stop('CPQ_COMMAND');return {version:'CorpusTeacherDescription/0.1',profile:TEACHER_PILOT,profileDigest:TEACHER_PILOT_DIGEST,studentTarget:STUDENT_TARGET,studentTargetDigest:STUDENT_TARGET_DIGEST,models:MODELS,endpoints:ENDPOINTS,commands:['describe','run','inspect','verify-manifest','measure-tokens','verify-tokens'],trainingReady:false};}
  const spec=validatePilotSpec(c.spec);if(!ports.store)stop('CPQ_COMMAND');if(canonical(spec)!==canonical(ports.store.spec))stop('CPQ_BINDING');
  if(c.command==='run'){if(!ports.run)stop('CPQ_COMMAND');return runTeacherPilot(spec,{...ports.run,store:ports.store});}
  if(c.command==='measure-tokens'||c.command==='verify-tokens'){
    if(!ports.tokenizer||ports.store.spec.runId!==spec.runId||ports.store.spec.buildDigest!==spec.buildDigest)stop('CPQ_BINDING');
    if(c.command==='measure-tokens')return measureTeacherPilotTokens(ports.store,ports.tokenizer.profile,ports.tokenizer.pythonPath).summary;
    const ref=ports.store.snapshot()?.tokenMeasurementRef;if(!ref)stop('CPQ_TOKENIZER_RECEIPT');return verifyTeacherPilotTokens(ports.store,ref,ports.tokenizer.profile,ports.tokenizer.pythonPath);
  }
  if(c.command==='inspect'||c.command==='verify-manifest'){const state=verifyTeacherPilot(ports.store);if(state.spec.runId!==spec.runId||state.spec.buildDigest!==spec.buildDigest)stop('CPQ_BINDING');return teacherPilotSummary(state,state.status==='COMPLETED'||state.status==='FENCED'?null:'CPQ_RESTART_READ_ONLY',ports.store.metrics().diskFinalBytes);}
  stop('CPQ_COMMAND');
}
