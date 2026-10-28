import type { Attempt,ProductionOperation } from './corpus-production-types.ts';
import type { Outcome } from './wf1-types.ts';
import { responseFailureCode } from './wf2-response-diagnostic.ts';
import type { ResponseFailureCode } from './wf2-response-diagnostic.ts';
import { usageParseCode } from './wf1-usage-diagnostic.ts';
import type { UsageParseCode } from './wf1-usage-diagnostic.ts';

export type ProductionResponseDiagnostic={operation:ProductionOperation|'UNKNOWN';httpStatus:number|null;outcome:Outcome|'UNKNOWN'|'NO_RESULT';responseFailureCode:ResponseFailureCode|'NOT_RECORDED';usageParseCode:UsageParseCode|'NOT_RECORDED';count:number};

/** One contribution per consumed attempt, never per item/ref/event. Project only bounded fields.
 * Missing legacy fields are observations, not inferred causes; never backfill persisted results. */
export function productionResponseDiagnostics(attempts:readonly Attempt[]):ProductionResponseDiagnostic[]{
  const groups=new Map<string,ProductionResponseDiagnostic>();
  for(const attempt of attempts){
    const result=attempt.result,operation:ProductionResponseDiagnostic['operation']=['plan','candidate','review'].includes(attempt.operation)?attempt.operation:'UNKNOWN',status=result?.httpStatus;
    const row:ProductionResponseDiagnostic={operation,httpStatus:typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:null,
      outcome:!result?'NO_RESULT':['COMPLETED','INCOMPLETE_OUTPUT','FAILED','SUBMIT_UNKNOWN'].includes(result.outcome)?result.outcome:'UNKNOWN',
      responseFailureCode:result?.responseFailureCode===undefined?'NOT_RECORDED':responseFailureCode(result.responseFailureCode),
      usageParseCode:result?.usageParseCode===undefined?'NOT_RECORDED':usageParseCode(result.usageParseCode),count:1};
    const key=JSON.stringify([row.operation,row.httpStatus,row.outcome,row.responseFailureCode,row.usageParseCode]),old=groups.get(key);
    if(old)old.count++;else groups.set(key,row);
  }
  return [...groups.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,row])=>row);
}
