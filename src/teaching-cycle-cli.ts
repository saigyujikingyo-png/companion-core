import { canonical,copyJson,oneOf,shape,stop } from './wf1-json.ts';
import { runTeachingCycle,teachingCycleSummary } from './teaching-cycle-runner.ts';
import type { TeachingCyclePorts } from './teaching-cycle-runner.ts';
import { teachingCycleReport } from './teaching-cycle-report.ts';
import { TEACHING_CYCLE_REAL_PROFILE,validateCycleSpec } from './teaching-cycle-types.ts';

/** Host-bound entry point. The launcher supplies paths, keys, credentials and
 * current grants privately. A fresh child uses inspect + verify-report; stdout
 * contains only this safe aggregate result, never the full state or selections. */
export async function runTeachingCycleCommand(raw:unknown,ports?:TeachingCyclePorts){
  const c=shape(copyJson(raw),['version','command','spec']);if(c.version!=='TeachingCycleCommand/0.2')stop('TC_COMMAND');const command=oneOf(c.command,['describe','run','inspect','verify-report']);
  if(command==='describe'){if(c.spec!==null)stop('TC_COMMAND');return {version:'TeachingCycleDescription/0.2',profileDigest:TEACHING_CYCLE_REAL_PROFILE,commands:['run','inspect','verify-report'],independentCold:'TRUSTED_LAUNCHER_FRESH_PROCESS_REQUIRED',automaticLocalReclaim:'DISABLED',trainingReady:false};}
  const spec=validateCycleSpec(c.spec);if(spec.version!=='TeachingCycle/0.2'||!ports||canonical(spec)!==canonical(ports.store.spec))stop('TC_BINDING');
  if(command==='run')return runTeachingCycle(ports);
  if(command==='verify-report'){if(ports.store.mode!=='inspect')stop('TC_COLD_INSPECT_REQUIRED');return teachingCycleReport(ports.store,ports.openIndex,ports.checkChildMetadata);}
  const state=ports.store.snapshot();if(!state)stop('TC_STATE');return teachingCycleSummary(state);
}
