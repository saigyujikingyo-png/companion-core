/** Independent fake bound service for the real DSH native scheduler smoke. No provider import. */
import { canonical,parseJson,shape,stop } from '../src/wf1-json.ts';
import { TeacherControlService } from '../src/wf2-teacher-service.ts';
import type { BoundTeachingRun,TeacherSafeMetadata } from '../src/wf2-teacher-service.ts';
let service:TeacherControlService|undefined,buffer=Buffer.alloc(0),bytes=0,lines=0,started=false;
const metadata=():TeacherSafeMetadata=>({campaignStatus:started?'COMPLETED':'ACTIVE',countCompleteness:'CURRENT_AUTHORITY',calls:{deepseek:0,together:0},candidates:{deepseek:0,together:0,qualified:0,quarantined:0},sealed:false,planned:false,manifestFrozen:false,usage:{input:0,completion:0,unknown:0},estimatedReserveMicroUsd:0});
const send=(value:unknown)=>process.stdout.write(canonical(value)+'\n');
const run:BoundTeachingRun={run:async()=>{if(started)stop('WF2_SYNTHETIC_DUPLICATE');started=true;},metadata,withdraw:()=>{},close:()=>{}};
function fail(){service?.ownerLost();process.exitCode=1;process.stdin.destroy();}
process.stdin.on('data',(part:Buffer)=>{try{
  bytes+=part.length;if(bytes>32768)stop('WF2_PIPE_BYTES');buffer=Buffer.concat([buffer,part]);if(buffer.length>8192)stop('WF2_PIPE_LINE');
  for(let index;(index=buffer.indexOf(10))>=0;){if(++lines>66)stop('WF2_PIPE_LIMIT');const raw=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,index));buffer=buffer.subarray(index+1);
    if(!service){const b=shape(parseJson(raw),['version','capability']);if(b.version!=='wf2-synthetic-bind/1'||typeof b.capability!=='string')stop('WF2_SYNTHETIC_BOOTSTRAP');service=new TeacherControlService(run,b.capability);send({version:'wf2-worker-event/1',type:'ready'});}
    else {const request=parseJson(raw);if(request!==null&&typeof request==='object'&&!Array.isArray(request)&&request.version==='wf2-worker-control/1'){
      const control=shape(request,['version','action','completionDigest']);if(control.action!=='acknowledge-completed'||typeof control.completionDigest!=='string')stop('WF2_SYNTHETIC_CONTROL');service.acknowledgeCompleted(control.completionDigest);send({version:'wf2-worker-event/1',type:'completion-acknowledged'});continue;
    }
      const reply=service.dispatch(request);send({version:'wf2-worker-event/1',type:'reply',reply});
      if(reply.operation==='start'&&!reply.duplicate)void service.settled().then(()=>{send({version:'wf2-worker-event/1',type:'settled',state:'COMPLETED',completion:service!.completionReceipt()});}).catch(fail);}
  }
}catch{fail();}});
process.stdin.on('end',()=>{service?.ownerLost();if(buffer.length)process.exitCode=1;});process.stdin.on('error',fail);
