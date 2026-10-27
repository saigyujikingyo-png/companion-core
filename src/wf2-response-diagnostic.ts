import { Wf1Error } from './wf1-json.ts';
import type { Attempt } from './wf1-types.ts';

/** Source-owned codes only. WF1_JSON is the strict parser's code, not proof of native JSON invalidity. */
export const RESPONSE_FAILURE_CODES=['NONE','UNKNOWN','TRANSPORT_UNKNOWN','HTTP_STATUS','RESPONSE_LIMIT','MODEL_IDENTITY','INCOMPLETE_FINAL',
  'ENVELOPE_REJECTED','ENVELOPE_WF1_JSON','ENVELOPE_WF1_NUMBER','ENVELOPE_WF1_DUPLICATE_KEY','ENVELOPE_WF1_JSON_LIMIT','ENVELOPE_WF1_UNICODE',
  'TOOL_ENVELOPE_REJECTED','ARGUMENTS_NATIVE_JSON_INVALID','ARGUMENTS_WF1_JSON','ARGUMENTS_WF1_NUMBER','ARGUMENTS_WF1_DUPLICATE_KEY','ARGUMENTS_WF1_JSON_LIMIT','ARGUMENTS_WF1_UNICODE',
  'ARGUMENTS_ROOT_NOT_OBJECT','ARTIFACT_WRITE_FAILED','FINAL_NATIVE_JSON_INVALID','FINAL_WF1_JSON','FINAL_WF1_NUMBER','FINAL_WF1_DUPLICATE_KEY','FINAL_WF1_JSON_LIMIT','FINAL_WF1_UNICODE','FINAL_ROOT_NOT_OBJECT'] as const;
export type ResponseFailureCode=typeof RESPONSE_FAILURE_CODES[number];
export type ResponseDiagnostic={code:ResponseFailureCode};
export function responseFailureCode(value:unknown):ResponseFailureCode {return typeof value==='string'&&(RESPONSE_FAILURE_CODES as readonly string[]).includes(value)?value as ResponseFailureCode:'UNKNOWN';}
export function parseFailureCode(error:unknown,part:'ENVELOPE'|'ARGUMENTS'|'FINAL'):ResponseFailureCode {
  if(!(error instanceof Wf1Error))return 'UNKNOWN';
  return responseFailureCode(part+'_'+error.code);
}
/** Diagnostic only: discard native output and never use it to repair or accept a rejected payload. */
export function argumentsFailureCode(error:unknown,raw:string,part:'ARGUMENTS'|'FINAL'='ARGUMENTS'):ResponseFailureCode {
  if(!(error instanceof Wf1Error))return 'UNKNOWN';
  try{JSON.parse(raw);}catch(nativeError){return nativeError instanceof SyntaxError?responseFailureCode(part+'_NATIVE_JSON_INVALID'):'UNKNOWN';}
  return parseFailureCode(error,part);
}
/** Latest attempt only. A pending response must not inherit an older failure or imply zero work. */
export function latestResponseFailure(attempts:readonly Attempt[],current:boolean):ResponseFailureCode {
  if(!current)return 'UNKNOWN';const last=attempts.at(-1);
  if(!last||last.outcome===null||last.outcome==='SUBMIT_UNKNOWN'||!last.result||last.outcome!==last.result.outcome)return 'UNKNOWN';
  const code=responseFailureCode(last.result.responseFailureCode);
  if(last.outcome==='COMPLETED')return code==='NONE'?'NONE':'UNKNOWN';
  return code==='NONE'?'UNKNOWN':code;
}
