import { dirname,isAbsolute,relative,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Readable,Writable } from 'node:stream';
import { canonical,copyJson,hash,parseJson,shape,stop,text,Wf1Error } from './wf1-json.ts';
import { validateSpec } from './wf1-contract.ts';
import { HostAuthority,privateRoot } from './wf1-storage.ts';
import { TeachingCampaign } from './wf1-campaign.ts';
import { TeacherProvider } from './wf1-provider.ts';
import { WF2_TEACHER_PROFILE_DIGEST } from './wf2-teacher-policy.ts';
import { WF2_STRICT_PROFILE_DIGEST } from './wf2-strict-data.ts';
import { FIXED_SLOT_STOP_REASONS,fixedSlotStopReason,WF2_SLOTS_PROFILE_DIGEST } from './wf2-fixed-slots.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import { teacherWorkerBuildDigest } from './wf2-teacher-build.ts';
import { inspectTeacherCampaign } from './wf2-teacher-inspect.ts';
import { pilotMetadataProfile,WF2_PILOT_PROFILE_DIGEST,WF2_PILOT_LIMITS } from './wf2-together-pilot.ts';
import { WF2_NAMED_PROFILE_DIGEST } from './wf2-named-data.ts';
import { RESPONSE_FAILURE_CODES,responseFailureCode } from './wf2-response-diagnostic.ts';
import type { ResponseFailureCode } from './wf2-response-diagnostic.ts';
export { teacherWorkerBuildDigest,TEACHER_WORKER_FILES } from './wf2-teacher-build.ts';
export { inspectTeacherCampaign } from './wf2-teacher-inspect.ts';
import { TeacherControlService,validateTeacherMetadata } from './wf2-teacher-service.ts';
import type { BoundTeachingRun,TeacherSafeMetadata } from './wf2-teacher-service.ts';

export type TeacherStopReason='CAMPAIGN_STOPPED'|'FIRST_FOUR_GATE'|'STRUCTURE_OR_FORMAL_REJECTED'|'USAGE_OR_TRANSPORT_UNKNOWN'|'AUTHORITY_OR_COMMIT_UNKNOWN'|'BUDGET_OR_TIME'|typeof FIXED_SLOT_STOP_REASONS[number];
type TeacherTerminal={metadata:TeacherSafeMetadata;reason:TeacherStopReason;responseFailureCode:ResponseFailureCode};
export type TeacherWorkerBinding=(bootstrap:unknown)=>{run:BoundTeachingRun;capability:string;stopReason?:()=>TeacherStopReason;terminal?:()=>TeacherTerminal};
export function describeTeacherWorker(){return {version:'wf2-teacher-worker-description/3',buildDigest:teacherWorkerBuildDigest(),
  transport:'PRIVATE_JSON_LINES_OVER_ANONYMOUS_PIPES',bootstrap:'TRUSTED_PARENT_ONLY_BEFORE_READY',operations:['status','start','pause','cancel'],
  acceptedProductionProfiles:['wf1-campaign/0.4','wf1-campaign/0.5','wf1-campaign/0.6','wf1-campaign/0.7'],profileDigest:WF2_PILOT_PROFILE_DIGEST,pilotProfileDigest:WF2_PILOT_PROFILE_DIGEST,pilotLimits:WF2_PILOT_LIMITS,pilotMetadata:pilotMetadataProfile(),pilotInspectOutputVersion:'wf2-teacher-inspection/3',pilotInspectCommand:'--inspect-pilot',profiles:{'wf1-campaign/0.4':WF2_TEACHER_PROFILE_DIGEST,'wf1-campaign/0.5':WF2_STRICT_PROFILE_DIGEST,'wf1-campaign/0.6':WF2_SLOTS_PROFILE_DIGEST,'wf1-campaign/0.7':WF2_PILOT_PROFILE_DIGEST},namedSlotProfileDigest:WF2_NAMED_PROFILE_DIGEST,productionAdmission:'NEW_FORMAL_RESEARCH_CAMPAIGN_ONLY',sourceAndProfileRequired:true,bodyFrozenBeforeConsume:true,
  stoppedEventVersion:'wf2-worker-event/2',bridgeVersion:'wf2-teacher-bridge/2',inspectionOutputVersion:'wf2-teacher-inspection/2',responseFailureCodes:RESPONSE_FAILURE_CODES,
  bootstrapVersion:'wf2-teacher-bind/2',runtime:'Node >=24.16 <25; native TypeScript stripping; no install or loader',
  bootstrapFields:['version','approvedTrainingRoot','runtimeRoot','authorityPath','expectedHead','spec','custodyKeyBase64','objective','credentials','capability'],
  legacy04:'bind/1 and inspect/1 without approvedTrainingRoot; never implicitly upgraded; archived runs require archived build',
  inspectCommand:'--inspect',inspectFields:['version','approvedTrainingRoot','runtimeRoot','authorityPath','expectedHead','spec','custodyKeyBase64'],inspectVersion:'wf2-teacher-inspect/2',inspect:'READ_ONLY_AUTHENTICATED_CLAIMS; COMPLETED_ACTIVE_TRAIN_MANIFEST_ONLY; NEVER_SEALED_OR_RESUME',
  storageBinding:'SHA256 canonical({version: wf2-training-root/1, approvedTrainingRoot: realpath, runtimeRoot: realpath}); strict child; no default or fallback',domain05:'RATIONAL_ONLY',domain06:'RATIONAL_ONLY_FIXED_SLOTS',
  stopReasons:['CAMPAIGN_STOPPED','FIRST_FOUR_GATE','STRUCTURE_OR_FORMAL_REJECTED','USAGE_OR_TRANSPORT_UNKNOWN','AUTHORITY_OR_COMMIT_UNKNOWN','BUDGET_OR_TIME',...FIXED_SLOT_STOP_REASONS],
  acceptance:'FORMAL_PROTOCOL_INPUT_AND_TYPED_TARGET_ONLY',formatCompatibility:'NOT_ESTABLISHED',losslessUnicodeEcho:'NOT_PASSED',
  limits:{deepseekCalls:44,togetherCalls:8,totalMicroUsd:500000,deepseekMicroUsd:400000,togetherMicroUsd:100000,campaignMs:3600000,requestMs:120000,deepseekBootstrapCompletion:4096,deepseekOtherCompletion:2048,togetherCompletion:4096},
  stdinEof:'REVOKE_UNACKNOWLEDGED_OWNER; ACKNOWLEDGED_COMPLETION_CLOSE_ONLY',stdout:'CLOSED_METADATA_EVENTS_ONLY',providerRetry:false,studentTraining:'NOT_RUN'};}
function staleMetadata(profileDigest?:string):TeacherSafeMetadata {return {...(profileDigest?{profile:pilotMetadataProfile()}:{}),campaignStatus:'RECONCILE_REQUIRED',countCompleteness:'STALE_OR_UNKNOWN',calls:{deepseek:null,together:null},candidates:{deepseek:null,together:null,qualified:null,quarantined:null},sealed:null,planned:null,manifestFrozen:false,usage:{input:null,completion:null,unknown:null},estimatedReserveMicroUsd:null};}
export function projectTeacherMetadata(m:ReturnType<TeachingCampaign['metadata']>):TeacherSafeMetadata {
  const pilot=m.campaignSchema==='wf1-campaign/0.7';if(pilot&&m.profileDigest!==WF2_PILOT_PROFILE_DIGEST)stop('WF2_METADATA_PROFILE');
  if(m.status==='RECONCILE_REQUIRED')return staleMetadata(pilot?m.profileDigest:undefined);
  return validateTeacherMetadata({...(pilot?{profile:pilotMetadataProfile()}:{}),campaignStatus:m.status,countCompleteness:'CURRENT_AUTHORITY',calls:m.calls,
    candidates:{deepseek:m.candidates.deepseek,together:m.candidates.together,qualified:m.candidates.qualified,quarantined:m.candidates.quarantined},
    sealed:m.sealed,planned:m.planned,manifestFrozen:m.manifestFrozen,usage:{input:m.usage.input,completion:m.usage.completion,unknown:m.usage.unknown},estimatedReserveMicroUsd:m.estimatedReserveMicroUsd},pilot?m.profileDigest:undefined);
}
/** Dependencies are trusted test injection, never supplied through bootstrap or a caller-selected path. */
export function bindTeacherCampaign(bootstrap:unknown,dependencies:{provider?:TeacherProvider;now?:()=>number}={}):ReturnType<TeacherWorkerBinding> {
  const own=copyJson(bootstrap),v2=own!==null&&typeof own==='object'&&!Array.isArray(own)&&own.version==='wf2-teacher-bind/2';
  const b=shape(own,['version','runtimeRoot','authorityPath','expectedHead','spec','custodyKeyBase64','objective','credentials','capability',...(v2?['approvedTrainingRoot']:[])]);
  if(b.version!=='wf2-teacher-bind/1'&&!v2)stop('WF2_WORKER_VERSION');const spec=validateSpec(b.spec);
  if(v2?!['wf1-campaign/0.5','wf1-campaign/0.6','wf1-campaign/0.7'].includes(spec.schemaVersion):spec.schemaVersion!=='wf1-campaign/0.4')stop('WF2_TEACHER_PROFILE_NOT_ADMITTED');if(spec.sourceDigest!==teacherWorkerBuildDigest())stop('WF2_BUILD_MISMATCH');
  const capability=text(b.capability,64);if(!/^[a-f0-9]{64}$/.test(capability))stop('WF2_SERVICE_CAPABILITY');
  const root=privateRoot(text(b.runtimeRoot,4096)),authorityPath=text(b.authorityPath,4096);privateRoot(dirname(authorityPath));
  const rel=relative(root,authorityPath);if(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))stop('WF1_AUTHORITY_PATH');
  const approvedTrainingRoot=v2?requireTrainingBinding(b.approvedTrainingRoot,root,spec.storageBindingDigest,authorityPath).approvedTrainingRoot:undefined;
  const now=dependencies.now??(()=>Date.now()),host=new HostAuthority(authorityPath,spec.id,now),authority=host.read(now());
  if(b.expectedHead!==authority.head)stop('WF1_HEAD_MISMATCH');if(authority.head!==null)stop('WF1_ALREADY_CONSUMED');
  const objective=text(b.objective,8192);if(hash(objective)!==spec.objectiveDigest)stop('WF1_OBJECTIVE_BINDING');
  const credentials=shape(b.credentials,['deepseek','together']);if(spec.schemaVersion==='wf1-campaign/0.7'&&credentials.deepseek!==null)stop('WF2_PILOT_CREDENTIAL');const keys={deepseek:spec.schemaVersion==='wf1-campaign/0.7'?null:text(credentials.deepseek,4096),together:text(credentials.together,4096)};
  const encoded=text(b.custodyKeyBase64,64),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)stop('WF1_KEY');
  let campaign:TeachingCampaign;try{campaign=TeachingCampaign.admitCampaign({root,authorityPath,spec,key,objective,provider:dependencies.provider??new TeacherProvider(keys),now,...(approvedTrainingRoot?{approvedTrainingRoot}:{})});}finally{key.fill(0);}
  let closed=false;const close=()=>{if(closed)return;closed=true;campaign.close();};
  const run:BoundTeachingRun={...(spec.schemaVersion==='wf1-campaign/0.7'?{metadataProfileDigest:WF2_PILOT_PROFILE_DIGEST}:{}),run:async()=>{await campaign.run();},metadata:()=>projectTeacherMetadata(campaign.metadata()),close,
    withdraw:mode=>{try{const fresh=new HostAuthority(authorityPath,spec.id,now),current=fresh.read(now(),false);if(current.status!=='REVOKED'&&current.status!==mode)fresh.control(mode);}finally{close();}}};
  const terminal=():TeacherTerminal=>{const m=campaign.metadata(),code=m.code,reason=():TeacherStopReason=>{if(m.status==='RECONCILE_REQUIRED')return 'AUTHORITY_OR_COMMIT_UNKNOWN';
    if(code==='WF1_FIRST_FOUR_GATE')return 'FIRST_FOUR_GATE';if(code==='WF1_UNRECONCILED'||code==='WF1_USAGE_OVER_RESERVE')return 'USAGE_OR_TRANSPORT_UNKNOWN';
    if(code==='WF1_BUDGET'||code==='WF1_CAMPAIGN_STOPPED'||code==='WF1_DEADLINE')return 'BUDGET_OR_TIME';
    if(spec.schemaVersion==='wf1-campaign/0.6'||spec.schemaVersion==='wf1-campaign/0.7')return fixedSlotStopReason(code);
    if(code&&['WF1_JSON','WF1_FIELDS','WF1_PROTOCOL','WF1_SEAL_FORMAL_FAIL','WF1_SOURCE_EXCLUSION','WF1_NUMBER','WF1_DUPLICATE_KEY','WF2_RATIONAL_ONLY','WF2_STRICT_ORIGIN'].includes(code))return 'STRUCTURE_OR_FORMAL_REJECTED';
    return 'CAMPAIGN_STOPPED';};
    return {metadata:projectTeacherMetadata(m),reason:reason(),responseFailureCode:responseFailureCode(m.responseFailureCode)};};
  return {run,capability,terminal,stopReason:()=>terminal().reason};
}
/** The binder is a trusted in-process dependency, never selected by caller input or a path. */
export function serveTeacherControl(input:Readable,output:Writable,bind:TeacherWorkerBinding=bindTeacherCampaign):{closed:Promise<void>;ownerLost:()=>void} {
  let service:TeacherControlService|undefined,binding:ReturnType<TeacherWorkerBinding>|undefined,buffer=Buffer.alloc(0),total=0,lines=0,ended=false,finished=false;
  let resolve!:()=>void;const closed=new Promise<void>(yes=>{resolve=yes;});
  const finish=()=>{if(finished)return;finished=true;input.off('data',data);input.off('end',end);input.off('close',end);input.off('error',fail);output.off('error',fail);resolve();};
  const ownerLost=()=>{if(ended)return;ended=true;try{service?.ownerLost();}finally{finish();}};
  function send(value:unknown):void {if(ended||output.destroyed)return;const raw=canonical(value)+'\n';if(Buffer.byteLength(raw)>16384)stop('WF2_WORKER_OUTPUT');output.write(raw,error=>{if(error)ownerLost();});}
  function fail(error?:unknown):void {
    if(!ended)try{send({version:'wf2-worker-event/1',type:'refused',code:error instanceof Wf1Error?error.code:'WF2_WORKER_INTERNAL'});}catch{/* Never forward arbitrary exception text. */}
    ownerLost();
  }
  function end():void {if(buffer.length)fail(new Wf1Error('WF2_WORKER_TRUNCATED'));else ownerLost();}
  function line(raw:string):void {
    const value=parseJson(raw);if(!service){const bound=bind(value);binding=bound;try{service=new TeacherControlService(bound.run,bound.capability);}catch(error){try{bound.run.withdraw('REVOKED');}finally{bound.run.close();}throw error;}send({version:'wf2-worker-event/1',type:'ready'});return;}
    if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&value.version==='wf2-worker-control/1'){
      const c=shape(value,['version','action','completionDigest']);if(c.action!=='acknowledge-completed'||typeof c.completionDigest!=='string')stop('WF2_WORKER_CONTROL');
      service.acknowledgeCompleted(c.completionDigest);send({version:'wf2-worker-event/1',type:'completion-acknowledged'});return;
    }
    const reply=service.dispatch(value);send({version:'wf2-worker-event/1',type:'reply',reply});
    if(reply.operation==='start'&&!reply.duplicate)void service.settled().then(()=>{
      if(ended)return;let completion;
      try{completion=service!.completionReceipt();}catch{
        let terminal:TeacherTerminal={metadata:staleMetadata(binding?.run.metadataProfileDigest),reason:'AUTHORITY_OR_COMMIT_UNKNOWN',responseFailureCode:'UNKNOWN'};
        try{if(binding!.terminal)terminal=binding!.terminal!();else terminal={metadata:validateTeacherMetadata(binding!.run.metadata(),binding!.run.metadataProfileDigest),reason:binding?.stopReason?.()??'CAMPAIGN_STOPPED',responseFailureCode:'UNKNOWN'};}catch{/* A stale observation is never a response diagnosis. */}
        const metadata=validateTeacherMetadata(terminal.metadata,binding?.run.metadataProfileDigest),code=metadata.countCompleteness==='STALE_OR_UNKNOWN'?'UNKNOWN':responseFailureCode(terminal.responseFailureCode);
        send({version:'wf2-worker-event/2',type:'stopped',reason:terminal.reason,responseFailureCode:code,metadata});return;}
      send({version:'wf2-worker-event/1',type:'settled',state:'COMPLETED',completion});
    }).catch(fail);
  }
  function data(part:Buffer|string):void {
    if(ended)return;try{const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);total+=chunk.length;if(total>262144)stop('WF2_WORKER_INPUT');buffer=Buffer.concat([buffer,chunk]);
      for(let index;(index=buffer.indexOf(10))>=0;){if(++lines>68||index>(service?8192:131072))stop('WF2_WORKER_INPUT');const raw=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,index));buffer=buffer.subarray(index+1);line(raw);if(ended)return;}
      if(buffer.length>(service?8192:131072))stop('WF2_WORKER_INPUT');
    }catch(error){fail(error);}
  }
  if(input.destroyed||input.readableEnded)ownerLost();else{input.on('data',data);input.once('end',end);input.once('close',end);input.once('error',fail);output.once('error',fail);}
  return {closed,ownerLost};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  if(process.argv.length===3&&process.argv[2]==='--describe')process.stdout.write(canonical(describeTeacherWorker())+'\n');
  else if(process.argv.length===3&&['--inspect','--inspect-pilot'].includes(process.argv[2]!)){
    const pilotInspect=process.argv[2]==='--inspect-pilot';
    try{const chunks:Buffer[]=[];let bytes=0;for await(const part of process.stdin){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>131072)stop('WF2_WORKER_INPUT');chunks.push(chunk);}
      const input=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),record=input as {spec?:{schemaVersion?:string}};if(pilotInspect!==(record?.spec?.schemaVersion==='wf1-campaign/0.7'))stop('WF2_TEACHER_PROFILE_NOT_ADMITTED');
      process.stdout.write(canonical(inspectTeacherCampaign(input))+'\n');
    }catch(error){process.stdout.write(canonical({version:pilotInspect?'wf2-teacher-inspection/3':'wf2-teacher-inspection/2',status:'REFUSED',code:error instanceof Wf1Error?error.code:'WF2_INSPECT_INTERNAL',responseFailureCode:'UNKNOWN',automaticResume:false})+'\n');process.exitCode=1;}
  }
  else if(process.argv.length!==2){process.stdout.write('{"version":"wf2-worker-event/1","type":"refused","code":"WF2_ARGUMENTS"}\n');process.exitCode=1;}
  else{const session=serveTeacherControl(process.stdin,process.stdout);const abort=()=>{session.ownerLost();process.stdin.destroy();process.exitCode=1;};process.once('SIGTERM',abort);process.once('SIGINT',abort);await session.closed;process.stdin.destroy();process.off('SIGTERM',abort);process.off('SIGINT',abort);}
}
