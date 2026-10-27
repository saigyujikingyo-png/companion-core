import { timingSafeEqual } from 'node:crypto';
import { pilotMetadataProfile,WF2_PILOT_PROFILE_DIGEST } from './wf2-together-pilot.ts';
import { canonical,copyJson,hash,integer,oneOf,shape,stop,text } from './wf1-json.ts';

/** A trusted launcher has already durably admitted exactly one new campaign.
 * DSH receives no bootstrap, provider credential, custody key, path or artifact capability.
 * The launcher adds this service capability only after validating its dedicated child pipe. */
export type TeacherOperation='status'|'start'|'pause'|'cancel';
export type TeacherServiceState='READY'|'RUNNING'|'COMPLETED'|'STOPPED'|'PAUSED'|'CANCELLED'|'OWNER_LOST'|'UNKNOWN';
export type TeacherSafeMetadata={
  profile?:ReturnType<typeof pilotMetadataProfile>;
  campaignStatus:'ACTIVE'|'PAUSED'|'REVOKED'|'STOPPED'|'COMPLETED'|'RECONCILE_REQUIRED';
  countCompleteness:'CURRENT_AUTHORITY'|'STALE_OR_UNKNOWN';
  calls:{deepseek:number|null;together:number|null};
  candidates:{deepseek:number|null;together:number|null;qualified:number|null;quarantined:number|null};
  sealed:boolean|null;planned:boolean|null;manifestFrozen:boolean;
  usage:{input:number|null;completion:number|null;unknown:number|null};
  estimatedReserveMicroUsd:number|null;
};
export interface BoundTeachingRun {
  readonly metadataProfileDigest?:string;
  /** No constructor/open/resume callback: the single run exists before READY. */
  run():Promise<void>;
  metadata():TeacherSafeMetadata;
  /** Must invalidate current external host authority before aborting local work. */
  withdraw(mode:'PAUSED'|'REVOKED'):void;
  close():void;
}
export type TeacherReply={version:'wf2-teacher-service/1';requestId:string;operation:TeacherOperation;duplicate:boolean;
  state:TeacherServiceState;startConsumed:boolean;metadata:TeacherSafeMetadata;
  remoteCancellation:'UNKNOWN';rawWorkClosure:'NOT_ESTABLISHED';studentInference:'NOT_RUN';studentTraining:'NOT_RUN';publication:'NOT_AUTHORIZED'};
const OPERATIONS=['status','start','pause','cancel'] as const;
const STATES=['READY','RUNNING','COMPLETED','STOPPED','PAUSED','CANCELLED','OWNER_LOST','UNKNOWN'] as const;
function requestId(value:unknown):string {const s=text(value,64);if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(s))stop('WF2_SERVICE_REQUEST_ID');return s;}
function nullableInteger(value:unknown,max:number):void {if(value!==null)integer(value,0,max);}
function nullableBoolean(value:unknown):void {if(value!==null&&typeof value!=='boolean')stop('WF2_SERVICE_METADATA');}
export function validateTeacherMetadata(input:unknown,expectedProfileDigest?:string):TeacherSafeMetadata {
  const pilot=expectedProfileDigest!==undefined;if(pilot&&expectedProfileDigest!==WF2_PILOT_PROFILE_DIGEST)stop('WF2_METADATA_PROFILE');
  const m=shape(copyJson(input),['campaignStatus','countCompleteness','calls','candidates','sealed','planned','manifestFrozen','usage','estimatedReserveMicroUsd',...(pilot?['profile']:[])]);
  if(pilot&&canonical(m.profile)!==canonical(pilotMetadataProfile()))stop('WF2_METADATA_PROFILE');
  oneOf(m.campaignStatus,['ACTIVE','PAUSED','REVOKED','STOPPED','COMPLETED','RECONCILE_REQUIRED']);oneOf(m.countCompleteness,['CURRENT_AUTHORITY','STALE_OR_UNKNOWN']);
  const calls=shape(m.calls,['deepseek','together']),candidates=shape(m.candidates,['deepseek','together','qualified','quarantined']),usage=shape(m.usage,['input','completion','unknown']);
  nullableInteger(calls.deepseek,pilot?0:44);nullableInteger(calls.together,pilot?11:8);nullableInteger(candidates.deepseek,pilot?0:16);nullableInteger(candidates.together,pilot?4:8);nullableInteger(candidates.qualified,pilot?4:24);nullableInteger(candidates.quarantined,pilot?4:24);
  nullableInteger(usage.input,100000000);nullableInteger(usage.completion,100000000);nullableInteger(usage.unknown,pilot?11:52);nullableInteger(m.estimatedReserveMicroUsd,pilot?100000:500000);
  nullableBoolean(m.sealed);nullableBoolean(m.planned);if(typeof m.manifestFrozen!=='boolean')stop('WF2_SERVICE_METADATA');
  const totals=[...Object.values(calls),...Object.values(candidates),...Object.values(usage),m.estimatedReserveMicroUsd];
  if(m.countCompleteness==='STALE_OR_UNKNOWN'){
    if(m.campaignStatus!=='RECONCILE_REQUIRED'||totals.some(v=>v!==null)||m.sealed!==null||m.planned!==null||m.manifestFrozen)stop('WF2_SERVICE_METADATA');
  }else if(m.campaignStatus==='RECONCILE_REQUIRED'||totals.some(v=>v===null)||m.sealed===null||m.planned===null)stop('WF2_SERVICE_METADATA');
  if(m.manifestFrozen&&m.campaignStatus!=='COMPLETED')stop('WF2_SERVICE_METADATA');return m as TeacherSafeMetadata;
}
function unknownMetadata(profileDigest?:string):TeacherSafeMetadata {return {...(profileDigest?{profile:pilotMetadataProfile()}:{}),campaignStatus:'RECONCILE_REQUIRED',countCompleteness:'STALE_OR_UNKNOWN',calls:{deepseek:null,together:null},
  candidates:{deepseek:null,together:null,qualified:null,quarantined:null},sealed:null,planned:null,manifestFrozen:false,usage:{input:null,completion:null,unknown:null},estimatedReserveMicroUsd:null};}
export function parseDshTeacherOperation(input:unknown):{version:1;requestId:string;operation:TeacherOperation} {
  const r=shape(copyJson(input),['version','requestId','operation']);if(r.version!==1)stop('WF2_SERVICE_VERSION');return {version:1,requestId:requestId(r.requestId),operation:oneOf(r.operation,OPERATIONS)};
}
export function validateTeacherReply(input:unknown,expectedProfileDigest?:string):TeacherReply {
  const r=shape(copyJson(input),['version','requestId','operation','duplicate','state','startConsumed','metadata','remoteCancellation','rawWorkClosure','studentInference','studentTraining','publication']);
  if(r.version!=='wf2-teacher-service/1'||typeof r.duplicate!=='boolean'||typeof r.startConsumed!=='boolean'||r.remoteCancellation!=='UNKNOWN'||r.rawWorkClosure!=='NOT_ESTABLISHED'||r.studentInference!=='NOT_RUN'||r.studentTraining!=='NOT_RUN'||r.publication!=='NOT_AUTHORIZED')stop('WF2_SERVICE_REPLY');
  requestId(r.requestId);oneOf(r.operation,OPERATIONS);oneOf(r.state,STATES);validateTeacherMetadata(r.metadata,expectedProfileDigest);return r as TeacherReply;
}
export class TeacherControlService {
  #run:BoundTeachingRun;#profile:string|undefined;#capability:Buffer;#state:TeacherServiceState='READY';#consumed=false;#closed=false;
  #withdrawn:'PAUSED'|'REVOKED'|null=null;
  #completionAcknowledged=false;
  #completionDigest:string|null=null;
  #requests=new Map<string,TeacherOperation>();#work:Promise<void>|null=null;#terminalMetadata:TeacherSafeMetadata|null=null;
  constructor(run:BoundTeachingRun,capability:string){
    if(!/^[a-f0-9]{64}$/.test(capability))stop('WF2_SERVICE_CAPABILITY');this.#run=run;this.#profile=run.metadataProfileDigest;this.#capability=Buffer.from(capability,'hex');
    const initial=validateTeacherMetadata(run.metadata(),this.#profile);if(initial.campaignStatus!=='ACTIVE'||[...Object.values(initial.calls),...Object.values(initial.candidates),...Object.values(initial.usage),initial.estimatedReserveMicroUsd].some(v=>v!==0)||initial.sealed!==false||initial.planned!==false||initial.manifestFrozen)stop('WF2_SERVICE_ADMISSION');
  }
  #metadata():TeacherSafeMetadata {
    if(this.#terminalMetadata)return structuredClone(this.#terminalMetadata);
    try{return validateTeacherMetadata(this.#run.metadata(),this.#profile);}catch{return unknownMetadata(this.#profile);}
  }
  #terminal(state:TeacherServiceState,mode:'PAUSED'|'REVOKED'):void {
    // Once a terminal decision is made, no later completion can restore an executable state.
    this.#state=state;
    if(this.#withdrawn!=='REVOKED'&&this.#withdrawn!==mode)try{this.#run.withdraw(mode);this.#withdrawn=mode;}catch{this.#state='UNKNOWN';}
    if(!this.#closed)try{this.#run.close();}catch{this.#state='UNKNOWN';}
    this.#closed=true;this.#terminalMetadata=unknownMetadata(this.#profile);
  }
  dispatch(input:unknown):TeacherReply {
    const r=shape(copyJson(input),['version','requestId','operation','capability']);
    if(typeof r.capability!=='string'||!/^[a-f0-9]{64}$/.test(r.capability)||!timingSafeEqual(this.#capability,Buffer.from(r.capability,'hex')))stop('WF2_SERVICE_CAPABILITY');
    const request=parseDshTeacherOperation({version:r.version,requestId:r.requestId,operation:r.operation});
    const previous=this.#requests.get(request.requestId),duplicate=previous!==undefined;
    if(previous!==undefined&&previous!==request.operation)stop('WF2_SERVICE_REQUEST_CONFLICT');
    if(!duplicate){
      // Exhausting the status/idempotency table must never prevent terminal control.
      const terminalControl=request.operation==='pause'||request.operation==='cancel';
      if(this.#requests.size>=64&&!terminalControl)stop('WF2_SERVICE_REQUEST_LIMIT');
      if(request.operation==='start'&&(this.#consumed||this.#state!=='READY'||this.#closed))stop('WF2_SERVICE_ALREADY_CONSUMED');
      if(this.#requests.size<64)this.#requests.set(request.requestId,request.operation);
      if(request.operation==='start'){
        // This flag is synchronous, before even invoking the trusted already-admitted run.
        this.#consumed=true;this.#state='RUNNING';
        this.#work=Promise.resolve().then(()=>{
          if(this.#state!=='RUNNING')return;return this.#run.run();
        }).then(()=>{
          if(this.#state!=='RUNNING')return;
          const metadata=this.#metadata();
          // Keep the authority/ledger live until the parent records and acknowledges completion.
          // A completed status request therefore revalidates current authority, not a cached claim.
          if(metadata.campaignStatus==='COMPLETED')this.#state='COMPLETED';
          else if(metadata.campaignStatus==='STOPPED')this.#state='STOPPED';
          else this.#terminal('UNKNOWN','REVOKED');
        },()=>{if(this.#state==='RUNNING')this.#terminal('UNKNOWN','REVOKED');});
      }else if(request.operation==='pause'||request.operation==='cancel'){
        if(request.operation==='cancel'&&this.#withdrawn!=='REVOKED')this.#terminal('CANCELLED','REVOKED');
        else if(request.operation==='pause'&&!this.#closed)this.#terminal('PAUSED','PAUSED');
      }
    }
    return validateTeacherReply({...request,version:'wf2-teacher-service/1',duplicate,state:this.#state,startConsumed:this.#consumed,
      metadata:this.#metadata(),remoteCancellation:'UNKNOWN',rawWorkClosure:'NOT_ESTABLISHED',studentInference:'NOT_RUN',studentTraining:'NOT_RUN',publication:'NOT_AUTHORIZED'},this.#profile);
  }
  /** Trusted parent only, after persisting the validated COMPLETED receipt. Never a DSH operation. */
  completionReceipt():{digest:string;metadata:TeacherSafeMetadata} {
    const metadata=this.#metadata();if(this.#state!=='COMPLETED'||this.#closed||metadata.campaignStatus!=='COMPLETED')stop('WF2_SERVICE_COMPLETION_ACK');
    this.#completionDigest=hash(canonical(metadata));return {digest:this.#completionDigest,metadata};
  }
  acknowledgeCompleted(expectedDigest:string):void {
    if(typeof expectedDigest!=='string'||expectedDigest!==this.#completionDigest)stop('WF2_SERVICE_COMPLETION_ACK');
    if(this.#completionAcknowledged)return;
    const metadata=this.#metadata();
    if(this.#state!=='COMPLETED'||this.#closed||metadata.campaignStatus!=='COMPLETED'||hash(canonical(metadata))!==expectedDigest){this.#terminal('UNKNOWN','REVOKED');stop('WF2_SERVICE_COMPLETION_ACK');}
    this.#closed=true;
    try{this.#run.close();}catch{this.#terminal('UNKNOWN','REVOKED');stop('WF2_SERVICE_COMPLETION_ACK');}
    this.#completionAcknowledged=true;this.#terminalMetadata=unknownMetadata(this.#profile);
  }
  ownerLost():void {if(!this.#completionAcknowledged&&this.#withdrawn!=='REVOKED')this.#terminal('OWNER_LOST','REVOKED');this.#capability.fill(0);}
  /** Logical work completion only. The launcher must separately observe real child close. */
  async settled():Promise<void> {await this.#work;}
}
