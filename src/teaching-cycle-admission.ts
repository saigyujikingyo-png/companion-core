import { types } from 'node:util';
import { stop } from './wf1-json.ts';
import type { TeachingCycleSpec } from './teaching-cycle-types.ts';

/** Trusted host closure authenticates the frozen plan's real completion receipts,
 * final assistant identities, non-refusal outputs and common MentorView binding.
 * It separately checks current project use, objective, child specs, source and
 * retention permissions. Model output is never an authority. active=false asks
 * for current inspection/retention rights, not renewed execution permission.
 * The closure has the plan before INIT decryption; spec.planDigest must match it.
 * Requested max is recorded separately from an optional provider effort echo. */
export type RealPlanAdmission=(context:{spec:TeachingCycleSpec;active:boolean})=>void;
export function synchronousCheck(check:()=>void,code:string){
  const result=check();
  if(result!==undefined){if(types.isPromise(result))void Promise.prototype.then.call(result,()=>undefined,()=>undefined);stop(code);}
}
export function requireRealPlanAdmission(spec:TeachingCycleSpec,active:boolean,check:RealPlanAdmission|undefined){
  if(spec.version!=='TeachingCycle/0.2')return;
  if(typeof check!=='function')stop('TC_REAL_ADMISSION');
  synchronousCheck(()=>check({spec:structuredClone(spec),active}),'TC_REAL_ADMISSION');
}
