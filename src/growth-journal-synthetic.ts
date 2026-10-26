import type { AttemptState, ReceiptPhase, SimulationState } from './growth-journal-types.ts';
import { fail } from './validation.ts';

export const GROWTH_SCENARIOS=Object.freeze(['refused','aborted_after_step','failed_after_step','unknown_after_start',
  'artifact_without_evaluation','evaluation_unknown','activated_then_rolled_back'] as const);
export type GrowthScenario=typeof GROWTH_SCENARIOS[number];
const traces:Record<GrowthScenario,ReceiptPhase[]>={
  refused:['REFUSED'],aborted_after_step:['STARTED','SIM_STEP','ABORTED'],failed_after_step:['STARTED','SIM_STEP','FAILED'],
  unknown_after_start:['STARTED','UNKNOWN'],artifact_without_evaluation:['STARTED','SIM_STEP','SIM_ARTIFACT','COMPLETED'],
  evaluation_unknown:['STARTED','SIM_STEP','SIM_ARTIFACT','SIM_EVAL_UNKNOWN','UNKNOWN'],
  activated_then_rolled_back:['STARTED','SIM_STEP','SIM_ARTIFACT','SIM_EVALUATED','SIM_ACTIVATED','SIM_ROLLED_BACK','COMPLETED'],
};
/** The reducer only sees these fixed synthetic traces. It is not a receipt-ingestion API. */
function reduce(phases:ReceiptPhase[]):{terminal:AttemptState;state:SimulationState} {
  let terminal:AttemptState='NOT_STARTED';
  const state:SimulationState={trainingOccurred:false,stepsLowerBound:0,artifactProduced:false,evaluation:'NOT_RUN',
    everActivated:false,activation:'NOT_ACTIVE'};
  for(const phase of phases) {
    if(terminal!=='NOT_STARTED'&&terminal!=='RUNNING')fail('GROWTH_TRACE_TERMINAL');
    if(phase==='REFUSED'){if(terminal!=='NOT_STARTED')fail('GROWTH_TRACE_ORDER');terminal='REFUSED';continue;}
    if(phase==='STARTED'){if(terminal!=='NOT_STARTED')fail('GROWTH_TRACE_ORDER');terminal='RUNNING';continue;}
    if(terminal!=='RUNNING')fail('GROWTH_TRACE_ORDER');
    switch(phase) {
      case 'SIM_STEP':
        if(state.trainingOccurred!==false)fail('GROWTH_TRACE_ORDER');state.trainingOccurred=true;state.stepsLowerBound=1;break;
      case 'SIM_ARTIFACT':
        if(state.trainingOccurred!==true||state.artifactProduced!==false)fail('GROWTH_TRACE_ORDER');state.artifactProduced=true;break;
      case 'SIM_EVALUATED':case 'SIM_EVAL_UNKNOWN':
        if(state.artifactProduced!==true||state.evaluation!=='NOT_RUN')fail('GROWTH_TRACE_ORDER');
        state.evaluation=phase==='SIM_EVALUATED'?'PASS':'UNKNOWN';break;
      case 'SIM_ACTIVATED':
        if(state.evaluation!=='PASS'||state.everActivated!==false)fail('GROWTH_TRACE_ORDER');state.everActivated=true;state.activation='ACTIVE';break;
      case 'SIM_ROLLED_BACK':
        if(state.activation!=='ACTIVE')fail('GROWTH_TRACE_ORDER');state.activation='ROLLED_BACK';break;
      case 'COMPLETED':case 'FAILED':case 'ABORTED':terminal=phase;break;
      case 'UNKNOWN':
        // No positive or negative execution evidence after STARTED. An unknown
        // evaluation cannot erase a previously observed step or artifact.
        if(state.trainingOccurred===false){state.trainingOccurred=null;state.artifactProduced=null;
          state.evaluation='UNKNOWN';state.everActivated=null;state.activation='UNKNOWN';}
        terminal='UNKNOWN';break;
      default:fail('GROWTH_TRACE_ORDER');
    }
  }
  if(terminal==='NOT_STARTED'||terminal==='RUNNING')fail('GROWTH_TRACE_INCOMPLETE');
  return {terminal,state};
}
/** Fixed fixtures only: no optimizer, artifact writer, evaluator or loader is called. */
export function syntheticGrowthTrace(value:GrowthScenario):{phases:ReceiptPhase[];terminal:AttemptState;state:SimulationState} {
  if(typeof value!=='string'||!GROWTH_SCENARIOS.includes(value))fail('GROWTH_SCENARIO_INVALID');
  const phases=[...traces[value]];return {phases,...reduce(phases)};
}
