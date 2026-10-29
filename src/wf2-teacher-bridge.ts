import { randomBytes } from 'node:crypto';
import { closeSync,fsyncSync,openSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { canonical,hash,oneOf,parseJson,shape,stop } from './wf1-json.ts';
import { privateRoot } from './wf1-storage.ts';
import { FIXED_SLOT_STOP_REASONS } from './wf2-fixed-slots.ts';
import { WF2_PILOT_PROFILE_DIGEST } from './wf2-together-pilot.ts';
import { WF2_UNIT_PROFILE_DIGEST } from './wf2-unit-pilot.ts';
import { RESPONSE_FAILURE_CODES } from './wf2-response-diagnostic.ts';
import type { ResponseFailureCode } from './wf2-response-diagnostic.ts';
import { unknownFailureDiagnostic,validateFailureDiagnostic } from './wf2-failure-diagnostic.ts';
import type { FailureDiagnostic } from './wf2-failure-diagnostic.ts';
import { parseDshTeacherOperation,validateTeacherMetadata,validateTeacherReply } from './wf2-teacher-service.ts';
import type { TeacherSafeMetadata } from './wf2-teacher-service.ts';

type Child=ChildProcessWithoutNullStreams;
/** These callbacks belong to the trusted launcher and are never DSH request arguments. */
export type TeacherBridgeLaunch={evidenceRoot:string;deadlineMs:number;metadataProfileDigest?:string;
  startWorker:(capability:string)=>Child;startDsh:()=>Child;
  /** Existing launcher-specific process-tree cleanup. Called once after the grace period. */
  forceClose:(children:readonly Child[])=>Promise<void>;
};
export type TeacherBridgeResult={version:'wf2-teacher-bridge/3';status:'COMPLETED'|'STOPPED'|'UNKNOWN_OR_STOPPED';workerClosed:boolean;dshClosed:boolean;
  workerExit:number|null;dshExit:number|null;forced:boolean;completionAcknowledged:boolean;controlRequests:number;metadata:TeacherSafeMetadata|null;
  metadataEvidence:'RECORDED_TERMINAL_SNAPSHOT_NOT_LIVE'|'NONE';stopReason:string|null;responseFailureCode:ResponseFailureCode;failureDiagnostic:FailureDiagnostic;
  automaticRetry:false;studentInference:'NOT_RUN';studentTraining:'NOT_RUN';publication:'NOT_AUTHORIZED'};
function fresh(path:string,value:unknown):void {const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,canonical(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
/** Only closed operations cross from the DSH child. Raw stdout and bootstrap are never logged. */
export async function runTeacherBridge(options:TeacherBridgeLaunch):Promise<TeacherBridgeResult>{
  const metadataProfile=options.metadataProfileDigest;if(metadataProfile!==undefined&&metadataProfile!==WF2_PILOT_PROFILE_DIGEST&&metadataProfile!==WF2_UNIT_PROFILE_DIGEST)stop('WF2_METADATA_PROFILE');
  const root=privateRoot(options.evidenceRoot);if(!Number.isSafeInteger(options.deadlineMs)||options.deadlineMs<1000||options.deadlineMs>3900000)stop('WF2_BRIDGE_TIME');
  fresh(join(root,'bridge.once.json'),{version:1,status:'CONSUMED_BEFORE_CHILD_START',automaticRetry:false});
  const capability=randomBytes(32).toString('hex');
  let worker:Child|undefined,dsh:Child|undefined,failed=false,forced=false,workerClosed=false,dshClosed=false,workerExit:number|null=null,dshExit:number|null=null;
  let calls=0,completion:TeacherSafeMetadata|null=null,stopped:TeacherSafeMetadata|null=null,stopReason:string|null=null,responseFailureCode:ResponseFailureCode='UNKNOWN',completionAcknowledged=false,phase:'BOOTSTRAP'|'READY'|'RUNNING'|'ACK'|'CLOSING'='BOOTSTRAP';
  let failureDiagnostic=unknownFailureDiagnostic();
  let resolve!:()=>void;const settled=new Promise<void>(yes=>{resolve=yes;});
  const children:Child[]=[];let grace:NodeJS.Timeout|undefined,hard:NodeJS.Timeout|undefined;
  const requests=new Map<string,string>();
  const finish=()=>{if(workerClosed&&(dshClosed||!dsh))resolve();};
  const stopBridge=()=>{
    if(failed)return;failed=true;for(const child of children)child.stdin.end();
    grace=setTimeout(()=>{forced=true;void options.forceClose(children).catch(()=>{});},1000);
    hard=setTimeout(resolve,6000);
  };
  const send=(child:Child,value:unknown)=>{if(child.stdin.destroyed){stopBridge();return;}child.stdin.write(canonical(value)+'\n',error=>{if(error)stopBridge();});};
  const hook=(child:Child,onLine:(value:unknown)=>void,onClose:(code:number|null)=>void)=>{
    let output=Buffer.alloc(0),total=0,lines=0,errors=0;
    child.stdout.on('data',(chunk:Buffer)=>{try{total+=chunk.length;if(total>262144)stop('WF2_BRIDGE_OUTPUT');output=Buffer.concat([output,chunk]);
      for(let index;(index=output.indexOf(10))>=0;){if(++lines>96||index>16384)stop('WF2_BRIDGE_OUTPUT');const raw=new TextDecoder('utf-8',{fatal:true}).decode(output.subarray(0,index));output=output.subarray(index+1);onLine(parseJson(raw));}
      if(output.length>16384)stop('WF2_BRIDGE_OUTPUT');
    }catch{stopBridge();}});
    child.stdout.on('end',()=>{if(output.length)stopBridge();});child.stderr.on('data',(chunk:Buffer)=>{errors+=chunk.length;if(errors>16384)stopBridge();});
    for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',stopBridge);child.on('error',stopBridge);child.on('close',code=>{onClose(code);finish();});
  };
  try{
    worker=options.startWorker(capability);children.push(worker);
    hook(worker,value=>{
      const event=value as Record<string,unknown>;
      if(event.type==='ready'){
        shape(event,['version','type']);if(event.version!=='wf2-worker-event/1'||phase!=='BOOTSTRAP')stop('WF2_BRIDGE_READY');phase='READY';dsh=options.startDsh();children.push(dsh);
        hook(dsh,request=>{const operation=parseDshTeacherOperation(request);if(++calls>80)stop('WF2_BRIDGE_LIMIT');
          const previous=requests.get(operation.requestId);if(previous!==undefined&&previous!==operation.operation)stop('WF2_BRIDGE_REQUEST_CONFLICT');
          if(previous===undefined){if(requests.size>=64)stop('WF2_BRIDGE_LIMIT');requests.set(operation.requestId,operation.operation);}
          if(operation.operation==='start'&&previous===undefined){if(phase!=='READY')stop('WF2_BRIDGE_START');phase='RUNNING';}
          send(worker!,{...operation,capability});
        },code=>{dshClosed=true;dshExit=code;worker!.stdin.end();if(code!==0||!completionAcknowledged)stopBridge();});
        send(dsh,{version:1,kind:'grant'});
      }else if(event.type==='reply'){
        shape(event,['version','type','reply']);if(event.version!=='wf2-worker-event/1'||!dsh)stop('WF2_BRIDGE_REPLY');const reply=validateTeacherReply(event.reply,metadataProfile);
        if(requests.get(reply.requestId)!==reply.operation)stop('WF2_BRIDGE_REPLY_BINDING');
        // DSH needs only the fixed operation/state acknowledgement, not the full teacher metadata.
        send(dsh,{version:1,kind:'reply',requestId:reply.requestId,operation:reply.operation,state:reply.state});
      }else if(event.type==='settled'){
        shape(event,['version','type','state','completion']);if(event.version!=='wf2-worker-event/1'||event.state!=='COMPLETED'||phase!=='RUNNING')stop('WF2_BRIDGE_SETTLED');
        const c=shape(event.completion,['digest','metadata']),metadata=validateTeacherMetadata(c.metadata,metadataProfile);if(metadata.campaignStatus!=='COMPLETED'||c.digest!==hash(canonical(metadata)))stop('WF2_BRIDGE_COMPLETION');
        fresh(join(root,'completed-metadata.json'),{version:1,metadata});completion=metadata;phase='ACK';send(worker!,{version:'wf2-worker-control/1',action:'acknowledge-completed',completionDigest:c.digest});
      }else if(event.type==='completion-acknowledged'){
        shape(event,['version','type']);if(event.version!=='wf2-worker-event/1'||phase!=='ACK'||!dsh)stop('WF2_BRIDGE_ACK');completionAcknowledged=true;phase='CLOSING';send(dsh,{version:1,kind:'settled',state:'COMPLETED'});dsh.stdin.end();worker!.stdin.end();
      }else if(event.type==='stopped'){
        shape(event,['version','type','reason','responseFailureCode','failureDiagnostic','metadata']);if(event.version!=='wf2-worker-event/3'||phase!=='RUNNING')stop('WF2_BRIDGE_STOPPED');
        const metadata=validateTeacherMetadata(event.metadata,metadataProfile);if(metadata.campaignStatus!=='STOPPED'&&metadata.campaignStatus!=='RECONCILE_REQUIRED')stop('WF2_BRIDGE_STOPPED');
        const reason=oneOf(event.reason,['CAMPAIGN_STOPPED','FIRST_FOUR_GATE','STRUCTURE_OR_FORMAL_REJECTED','USAGE_OR_TRANSPORT_UNKNOWN','AUTHORITY_OR_COMMIT_UNKNOWN','BUDGET_OR_TIME',...FIXED_SLOT_STOP_REASONS]);
        const code=oneOf(event.responseFailureCode,RESPONSE_FAILURE_CODES),diagnostic=validateFailureDiagnostic(event.failureDiagnostic);if(metadata.countCompleteness==='STALE_OR_UNKNOWN'&&(code!=='UNKNOWN'||canonical(diagnostic)!==canonical(unknownFailureDiagnostic())))stop('WF2_BRIDGE_STOPPED');
        fresh(join(root,'stopped-metadata.json'),{version:3,metadataEvidence:'RECORDED_TERMINAL_SNAPSHOT_NOT_LIVE',reason,responseFailureCode:code,failureDiagnostic:diagnostic,metadata});stopped=metadata;stopReason=reason;responseFailureCode=code;failureDiagnostic=diagnostic;phase='CLOSING';stopBridge();
      }else stop('WF2_BRIDGE_WORKER_REFUSED');
    },code=>{workerClosed=true;workerExit=code;if(!completionAcknowledged||code!==0)stopBridge();if(dsh&&!dshClosed)dsh.stdin.end();});
  }catch{stopBridge();if(!worker)workerClosed=true;finish();}
  const deadline=setTimeout(stopBridge,options.deadlineMs);await settled;clearTimeout(deadline);clearTimeout(grace);clearTimeout(hard);
  const result:TeacherBridgeResult={version:'wf2-teacher-bridge/3',status:!failed&&!forced&&workerClosed&&dshClosed&&workerExit===0&&dshExit===0&&completionAcknowledged?'COMPLETED':stopped&&!forced&&workerClosed&&dshClosed?'STOPPED':'UNKNOWN_OR_STOPPED',
    workerClosed,dshClosed,workerExit,dshExit,forced,completionAcknowledged,controlRequests:calls,metadata:stopped??completion,
    metadataEvidence:stopped||completion?'RECORDED_TERMINAL_SNAPSHOT_NOT_LIVE':'NONE',stopReason,responseFailureCode,failureDiagnostic,automaticRetry:false,studentInference:'NOT_RUN',studentTraining:'NOT_RUN',publication:'NOT_AUTHORIZED'};
  fresh(join(root,'bridge-receipt.json'),result);
  if(!workerClosed||!dshClosed)for(const child of children){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();}
  return result;
}
