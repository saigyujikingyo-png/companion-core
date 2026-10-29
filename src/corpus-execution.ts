import type { Provider } from './wf1-types.ts';
/** Host resource admission happens before the child's durable CONSUME. It must
 * never introduce an await inside the synchronous native-completion observer. */
export type CorpusExecutionRequest={jobId:string;attemptId:string;provider:Provider;accountRef:string;requestBytes:number;responseBytes:number;expiresAt:number};
export type CorpusExecutionLease={id:string;check:()=>void;consumed:()=>void;settle:(result:{localReleased:boolean;remoteUnknown:boolean;httpStatus:number|null;retryAfterMs:number|null;retryAfterInvalid:boolean})=>void;abandon:(localReleased:boolean)=>void};
export type CorpusExecution={check:()=>void;authorizeSend:<T>(send:()=>T)=>T;authorizeCommit:<T>(commit:()=>T)=>T;acquire:(request:CorpusExecutionRequest,signal?:AbortSignal)=>Promise<CorpusExecutionLease>};
