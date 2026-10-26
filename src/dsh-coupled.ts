import { createHash } from 'node:crypto';
import { CoreError, fail, text } from './validation.ts';
import { mapEvent } from './wire.ts';
import { bounded } from './runtime.ts';
import type { DshCoupledBackend, DshBackendClose, PreparedAuthorization } from './dsh-coupled-backend.ts';

import { CompanionWindowPolicy } from './presence-policy.ts';

export type DshNativeChunk={type:'block-start';index:0;blockType:'text'}|{type:'text-delta';index:0;text:string}
  |{type:'block-end';index:0;block:{type:'text';text:string}}|{type:'finish';reason:{kind:'stop'}};
export type DshGenerateOptions={provider:string;model:string;sessionId?:string;signal?:AbortSignal;messages:unknown[]};
export type DshCoupledEvent={kind:string;status:string;sessionId:string;turn?:number;requests?:number;messageId?:string;deliveryId?:string;
  replySha256?:string;replyCharacters?:number;realModelCalls?:number;appraisalStatus?:'applied'|'not-applied';recallCount?:number;sourceRefCount?:number;
  code?:string;elapsedMs?:number;usageSnapshotKnown?:boolean};
type Selected={id:string;key:string;text:string;hash:string;arrivedAt:number};
type Prepared={messageId:string;deliveryId:string;generation:number;permissionVersion:number;expiresAt:number;consumed:boolean;cancelled:boolean};
type PreparedOffer={deliveryId:string;generation:number;permissionVersion:number;expiresAt:number};
type Turn={number:number;claims:Set<string>;started:boolean;stopping:boolean;ended:boolean;cancelled:boolean;streamStarted:boolean;
  streamComplete:boolean;deliveryId:string|null;reply:string|null;assistantId:string|null;prepared:boolean;acknowledged:boolean;
  generation:number;permissionVersion:number;expiresAt:number;scheduleQuery:string|null;humanId:string|null;controller:AbortController;offAbort:()=>void};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const safeFailureCodes=new Set(['INFERENCE_TIMEOUT','PROVIDER_NETWORK','PROVIDER_HTTP_STATUS','PROVIDER_CONTENT_TYPE','PROVIDER_RESPONSE_TOO_LARGE',
  'PROVIDER_RESPONSE_INVALID','ABORTED','BUDGET_DISABLED','REQUEST_BUDGET_EXHAUSTED','INTERACTION_TERMINATED','INTERACTION_STALE',
  'HOST_CONTEXT_BLOCKED','SESSION_PAUSED','DSH_BACKEND_PROTOCOL','DSH_BACKEND_COMMAND_TIMEOUT','DSH_BACKEND_CLOSED','DSH_CANCELLED','FOREGROUND_DRAIN_REFUSED']);
function contentText(value:unknown):string{
  if(!Array.isArray(value)||value.length<1||value.length>32)fail('DSH_UNSUPPORTED_CONTENT');
  const parts=value.map(part=>{if(!object(part)||part.type!=='text')fail('DSH_UNSUPPORTED_CONTENT');text(part.text,4096);return part.text;});
  const result=parts.join('\n');text(result,4096);return result;
}

/** Selected-session adapter state machine. Only the native SDK owns turns and
 * assistant commits; this class yields its documented four text frame types. */
export class DshCoupledBridge {
  readonly #backend:DshCoupledBackend;readonly #sessionId:string;readonly #provider:string;readonly #model:string;
  readonly #clock:()=>number;readonly #event:(event:DshCoupledEvent)=>void;
  readonly #publish:((deliveryId:string,attach:(messageId:string)=>boolean,signal:AbortSignal)=>Promise<boolean>)|undefined;
  readonly #cancelNativePrepared:(()=>void)|undefined;readonly #offPrepared:(()=>void)|undefined;
  readonly #realProvider:boolean;
  #mounted=true;#generation=1;#lastTime=0;#leaseExpires=0;#latestTurn=0;#requests=0;#acks=0;#realCalls=0;
  #selected=new Map<string,Selected>();#handled=new Set<string>();#turns=new Map<number,Turn>();
  #arrivals=new Map<string,{time:number;hash:string}>();
  #prepared=new Map<string,Prepared>();#preparedDeliveries=new Set<string>();#publishing=false;
  #waitingPrepared=new Map<string,PreparedOffer>();#activePrepared:string|null=null;
  #publicationAbort:AbortController|null=null;#latestHumanId:string|null=null;#schedulerStopping:Promise<void>|null=null;
  #pausing:Promise<void>|null=null;#close:Promise<DshBackendClose>|null=null;
  #manualPaused=false;#switching=false;#manualVersion=0;
  #pendingFeedback:{deliveryId:string;outcome:'engaged'|'declined'|'neutral'}|null=null;
  #usageKnown=true;readonly #window=new CompanionWindowPolicy();#windowVersion=0;#windowChanging=false;
  #lastAcceptedHumanQuery:string|null=null;#proactiveSuppressed=false;
  constructor(backend:DshCoupledBackend,options:{sessionId:string;provider:string;model:string;clock?:()=>number;
    onEvent?:(event:DshCoupledEvent)=>void;publishPrepared?:(deliveryId:string,attach:(messageId:string)=>boolean,signal:AbortSignal)=>Promise<boolean>;
    cancelNativePrepared?:()=>void;realProvider?:boolean;requireManualResume?:boolean;initialConsumedRequests?:number}){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.sessionId))fail('DSH_DEDICATED_SESSION_REQUIRED');
    text(options.provider,128);text(options.model,128);this.#backend=backend;this.#sessionId=options.sessionId;
    this.#provider=options.provider;this.#model=options.model;this.#clock=options.clock??(()=>performance.now());
    this.#event=options.onEvent??(()=>{});this.#publish=options.publishPrepared;this.#cancelNativePrepared=options.cancelNativePrepared;
    this.#realProvider=options.realProvider??false;
    this.#manualPaused=options.requireManualResume??false;
    this.#realCalls=options.initialConsumedRequests??0;
    this.#lastTime=this.#now();this.#offPrepared=backend.onPrepared?.((id,authorization)=>{void this.#offerPrepared(id,authorization).catch(()=>{this.#log('prepared-notification','rejected');void this.pause();});});
    this.#log('ready','paused-unavailable');
  }
  #now():number{const now=this.#clock();if(!Number.isFinite(now)||now<this.#lastTime)fail('DSH_CLOCK_INVALID');this.#lastTime=now;return now;}
  #log(kind:string,status:string,turn?:number,extra:Partial<DshCoupledEvent>={}):void{
    try{const event:DshCoupledEvent={kind,status,sessionId:this.#sessionId,requests:this.#requests,realModelCalls:this.#realCalls,usageSnapshotKnown:this.#usageKnown,
      ...(turn===undefined?{}:{turn}),...extra};void Promise.resolve(this.#event(event)).catch(()=>{});}catch{/* safe log consumer */}
  }
  async #refreshUsage():Promise<void>{
    this.#usageKnown=!this.#realProvider;
    try{const status=await this.#backend.command('status');if(Number.isSafeInteger(status?.requests?.total)&&status.requests.total>=0)
      {this.#realCalls=this.#realProvider?status.requests.total:0;this.#usageKnown=true;}}catch{/* Unknown usage is not substituted with a model success. */}
  }
  #turn(number:unknown):Turn{
    if(!Number.isSafeInteger(number)||(number as number)<1)fail('DSH_TURN_INVALID');
    const n=number as number;let turn=this.#turns.get(n);
    if(!turn){if(this.#turns.size>=128)fail('DSH_SESSION_CAPACITY');turn={number:n,claims:new Set(),started:false,stopping:false,ended:false,
      cancelled:false,streamStarted:false,streamComplete:false,deliveryId:null,reply:null,assistantId:null,prepared:false,acknowledged:false,generation:0,permissionVersion:0,expiresAt:0,scheduleQuery:null,humanId:null,
      controller:new AbortController(),offAbort:()=>{}};this.#turns.set(n,turn);}return turn;
  }
  #invalidatePrepared():void{
    this.#generation++;this.#discardPrepared();
  }
  #discardPrepared():void {
    this.#waitingPrepared.clear();this.#activePrepared=null;this.#publicationAbort?.abort();
    for(const prepared of this.#prepared.values())prepared.cancelled=true;
    const active=this.#turns.get(this.#latestTurn);
    if(active?.prepared&&!active.ended){active.cancelled=true;active.controller.abort();active.offAbort();try{this.#cancelNativePrepared?.();}catch{}}
  }
  inboxInserted(message:unknown):void{
    if(!this.#mounted||!object(message)||!object(message.source))return;
    if(message.source.kind==='user'){
      text(message.id,256);const hash=digest(contentText(message.content)),old=this.#arrivals.get(message.id);
      if(old&&old.hash!==hash)fail('DSH_IDEMPOTENCY_CONFLICT');
      if(!old){if(this.#arrivals.size>=128)fail('DSH_SESSION_CAPACITY');this.#arrivals.set(message.id,{time:this.#now(),hash});this.#latestHumanId=message.id;this.#lastAcceptedHumanQuery=null;
        if(this.#publish&&!this.#schedulerStopping){
          const stopping=this.#backend.command('schedule',{recallQuery:null}).then(()=>{},()=>{void this.pause();});this.#schedulerStopping=stopping;
          void stopping.then(()=>{if(this.#schedulerStopping===stopping)this.#schedulerStopping=null;});
        }
      }
      this.#invalidatePrepared();
    }
  }
  inboxClaimed(message:unknown,number:unknown):void{
    if(!this.#mounted||!object(message))return;text(message.id,256);const turn=this.#turn(number);
    if(turn.claims.size>=32&&!turn.claims.has(message.id))fail('DSH_CLAIM_CAPACITY');turn.claims.add(message.id);
    if(object(message.source)&&message.source.kind==='user')this.#invalidatePrepared();
  }
  async nativeEvent(sessionId:string,event:unknown):Promise<void>{
    if(!this.#mounted||sessionId!==this.#sessionId||!object(event))return;
    if((event.type==='user/message'||event.type==='assistant/message')&&event.surfaceOp!=='append')return;
    if(event.type==='user/message'){
      if(!object(event.data)||!object(event.data.source))return;
      const message=event.data,source=message.source as Record<string,unknown>;
      if(source.kind==='companion-prepared-delivery'){
        const entry=typeof message.id==='string'?this.#prepared.get(message.id):undefined;
        // The SDK appends all claimed messages after emitting all claim events.
        // A human in that batch may already have cancelled this owned notice.
        // Recognize its provenance here; stream still refuses cancelled notices.
        if(!entry||contentText(message.content)!==this.preparedNotice(entry.deliveryId))fail('DSH_UNOWNED_NOTIFICATION');return;
      }
      if(source.kind!=='user')return;
      const mapped=mapEvent('dsh',this.#sessionId,{sessionId:this.#sessionId,event:{type:event.type,seq:event.seq,time:event.time,surfaceOp:event.surfaceOp,
        data:{id:message.id,role:message.role,content:message.content,source:{kind:source.kind,rpcId:source.rpcId,
          ...(source.clientTimeZone===undefined?{}:{clientTimeZone:source.clientTimeZone}),...(source.principal===undefined?{}:{principal:source.principal})}}}});
      const id=message.id as string,hash=digest(mapped.selectedText),old=this.#selected.get(id);
      const arrival=this.#arrivals.get(id);if(!arrival||arrival.hash!==hash)fail('DSH_INPUT_NOT_OBSERVED');
      if(old&&old.hash!==hash)fail('DSH_IDEMPOTENCY_CONFLICT');
      if(!old){if(this.#selected.size>=128)fail('DSH_SESSION_CAPACITY');this.#selected.set(id,{id,key:mapped.eventKey,text:mapped.selectedText,hash,arrivedAt:arrival.time});}
      this.#invalidatePrepared();this.#log('native-user',old?'duplicate':'selected',undefined,{messageId:id});return;
    }
    if(!object(event.data))return;const data=event.data;
    if(event.type==='turn/start'){
      const turn=this.#turn(data.turn);if(turn.started||turn.ended)fail('DSH_TURN_REPLAY');turn.started=true;
      this.#latestTurn=turn.number;this.#log('turn-start','started',turn.number);return;
    }
    const turn=this.#turns.get(data.turn as number);if(!turn)return;
    if(event.type==='assistant/message'){
      if(!turn.streamComplete||turn.cancelled||!object(data.message)||data.message.role!=='assistant')return;
      const value=contentText(data.message.content);text(data.message.id,256);
      if(value!==turn.reply||(turn.assistantId!==null&&turn.assistantId!==data.message.id)){this.#cancel(turn,'commit-mismatch');return;}
      turn.assistantId=data.message.id;this.#log('assistant-commit','native-committed',turn.number,{messageId:turn.assistantId,
        replySha256:digest(value),replyCharacters:value.length});return;
    }
    if(event.type==='turn/end'){
      if(turn.ended)return;turn.ended=true;turn.offAbort();
      // A terminal native turn also consumes inputs rejected before stream
      // admission. They cannot block later fresh input or gain a replay lease.
      for(const id of turn.claims)if(this.#arrivals.has(id))this.#handled.add(id);
      const completed=object(data.reason)&&data.reason.kind==='completed';
      if(!completed||turn.cancelled||!turn.streamComplete||!turn.assistantId||!turn.deliveryId){this.#cancel(turn,'native-not-completed');this.#log('turn-end','not-acknowledged',turn.number);return;}
      const generation=turn.generation;
      try{this.#check(turn);await this.#backend.command('ack',{deliveryId:turn.deliveryId});if(!this.#mounted||turn.cancelled||generation!==this.#generation)return;this.#check(turn);
        turn.acknowledged=true;this.#acks++;this.#log('delivery-ack','native-commit-and-completed',turn.number,{deliveryId:turn.deliveryId});this.#log('turn-end','completed',turn.number);
        if(turn.prepared&&this.#activePrepared&&this.#prepared.get(this.#activePrepared)?.deliveryId===turn.deliveryId)this.#activePrepared=null;
        if(!turn.prepared&&turn.humanId===this.#latestHumanId){this.#lastAcceptedHumanQuery=turn.scheduleQuery;
          if(turn.permissionVersion===this.#windowVersion)this.#proactiveSuppressed=false;}
        if(!this.#proactiveSuppressed&&turn.permissionVersion===this.#windowVersion&&this.#publish&&!turn.prepared&&turn.scheduleQuery&&turn.humanId===this.#latestHumanId&&!this.#foregroundWaiting()&&this.#now()<this.#proactiveExpiry()){
          await this.#backend.command('schedule',{recallQuery:turn.scheduleQuery});
          if(!this.#mounted||turn.cancelled||generation!==this.#generation)return;
        }
        // Do not await native maintenance from its own turn-end callback.
        void this.#drainPrepared().catch(()=>{void this.pause();});
      }catch{this.#log('delivery-ack','rejected',turn.number);await this.pause();}
    }
  }
  turnStopping(number:unknown,signal?:AbortSignal):void{
    if(!this.#mounted)return;const turn=this.#turn(number);turn.stopping=true;
    if(signal?.aborted)this.#cancel(turn,'native-aborted');else this.#log('turn-stopping','awaiting-native-end',turn.number);
  }
  #check(turn:Turn,signal?:AbortSignal):void{
    if(!this.#mounted||turn.cancelled||turn.controller.signal.aborted||signal?.aborted||this.#now()>=turn.expiresAt||(turn.prepared&&turn.permissionVersion!==this.#windowVersion))fail('DSH_CANCELLED');
  }
  async *stream(options:DshGenerateOptions):AsyncGenerator<DshNativeChunk>{
    if(!this.#mounted||options.sessionId!==this.#sessionId||options.provider!==this.#provider||options.model!==this.#model)fail('DSH_AUTHORITY_MISMATCH');
    if(this.#manualPaused||this.#switching)fail('DSH_MANUALLY_PAUSED');
    if(!options.signal||options.signal.aborted||!Array.isArray(options.messages)||options.messages.length>512)fail('DSH_INVALID_REQUEST');
    const turn=this.#turns.get(this.#latestTurn);
    if(!turn?.started||turn.ended||turn.stopping||turn.streamStarted)fail('DSH_TURN_UNAVAILABLE');
    const humanIds=[...turn.claims].filter(id=>this.#selected.has(id));
    if(humanIds.length>1){
      for(const id of humanIds)this.#handled.add(id);
      this.#cancel(turn,'multiple-human-inputs');fail('DSH_MULTIPLE_HUMAN_INPUTS');
    }
    const human=humanIds.length===1;
    let lastUser:Record<string,unknown>|undefined;
    for(let i=options.messages.length-1;i>=0;i--){const candidate=options.messages[i];if(object(candidate)&&candidate.role==='user'
      &&(!human||(typeof candidate.id==='string'&&this.#selected.has(candidate.id)&&turn.claims.has(candidate.id)))){lastUser=candidate;break;}}
    if(!lastUser||typeof lastUser.id!=='string'||!turn.claims.has(lastUser.id)||!object(lastUser.source))fail('DSH_UNCLAIMED_INPUT');
    const selected=this.#selected.get(lastUser.id),prepared=this.#prepared.get(lastUser.id);
    if(human){
      if(!selected||lastUser.source.kind!=='user'||contentText(lastUser.content)!==selected.text)fail('DSH_SOURCE_MISMATCH');
      if(this.#handled.has(selected.id))fail('DSH_MESSAGE_ALREADY_HANDLED');this.#handled.add(selected.id);
    }else{
      if(!prepared||prepared.cancelled||prepared.consumed||prepared.generation!==this.#generation||prepared.permissionVersion!==this.#windowVersion||this.#now()>=prepared.expiresAt
        ||lastUser.source.kind!=='companion-prepared-delivery'||contentText(lastUser.content)!==this.preparedNotice(prepared.deliveryId))fail('DSH_UNOWNED_NOTIFICATION');
      prepared.consumed=true;turn.prepared=true;
    }
    turn.streamStarted=true;turn.generation=this.#generation;turn.permissionVersion=this.#windowVersion;
    if(prepared)turn.expiresAt=prepared.expiresAt;
    const abort=()=>this.#cancel(turn,'native-signal');options.signal.addEventListener('abort',abort,{once:true});
    turn.offAbort=()=>options.signal!.removeEventListener('abort',abort);
    let stage='context';const startedAt=this.#now();
    try{
      await this.#pausing;
      if(human){
        await this.#schedulerStopping;
        if(options.signal.aborted||!this.#mounted||this.#manualPaused||this.#switching||turn.cancelled||turn.controller.signal.aborted)fail('DSH_CANCELLED');
        this.#leaseExpires=selected!.arrivedAt+30000;turn.expiresAt=this.#leaseExpires;turn.humanId=selected!.id;
        const ttlMs=Math.floor(this.#leaseExpires-this.#now());if(ttlMs<1)fail('DSH_INPUT_EXPIRED');
        turn.scheduleQuery=this.#publish?selected!.text.slice(0,256):null;
        await this.#backend.command('context',{quiet:false,available:true,ttlMs,recallQuery:null},turn.controller.signal);
        stage='resume';await this.#backend.command('resume',{},turn.controller.signal);this.#check(turn,options.signal);
        this.#usageKnown=!this.#realProvider;
        this.#requests++;this.#log('provider-request','selected-native-user',turn.number,{messageId:selected!.id});
        stage='submit';
        const feedback=this.#pendingFeedback;this.#pendingFeedback=null;
        const receipt=await this.#backend.command('submit',{messageId:selected!.key,selectedText:selected!.text,recallQuery:selected!.text.slice(0,256),
          ...(feedback?{feedback}:{})},turn.controller.signal);
        this.#check(turn,options.signal);if(!receipt||typeof receipt.deliveryId!=='string')fail('DSH_BACKEND_PROTOCOL');turn.deliveryId=receipt.deliveryId;
        if(receipt.appraisalStatus==='applied'||receipt.appraisalStatus==='not-applied')
          this.#log('core-interaction','receipt',turn.number,{appraisalStatus:receipt.appraisalStatus});
        stage='usage';await this.#refreshUsage();this.#check(turn,options.signal);
      }else{this.#check(turn,options.signal);turn.deliveryId=prepared!.deliveryId;this.#log('prepared-consume','no-new-model-request',turn.number);}
      stage='take';
      const delivery=await this.#backend.command('take',{deliveryId:turn.deliveryId},turn.controller.signal);this.#check(turn,options.signal);
      text(delivery?.text,4096);if(delivery.deliveryId!==turn.deliveryId)fail('DSH_BACKEND_PROTOCOL');const reply=delivery.text as string;turn.reply=reply;
      if(Array.isArray(delivery.recall)&&Array.isArray(delivery.sourceRefs))
        this.#log('core-recall','taken',turn.number,{recallCount:delivery.recall.length,sourceRefCount:delivery.sourceRefs.length});
      stage='stream';yield {type:'block-start',index:0,blockType:'text'};this.#check(turn,options.signal);
      yield {type:'text-delta',index:0,text:reply};this.#check(turn,options.signal);
      yield {type:'block-end',index:0,block:{type:'text',text:reply}};this.#check(turn,options.signal);
      turn.streamComplete=true;yield {type:'finish',reason:{kind:'stop'}};
      this.#log('stream-finished','awaiting-native-commit',turn.number,{deliveryId:turn.deliveryId!,replySha256:digest(reply),replyCharacters:reply.length});
    }catch(error){this.#log('core-failure',stage,turn.number,{code:error instanceof CoreError&&safeFailureCodes.has(error.code)?error.code:'UNCLASSIFIED',
      elapsedMs:Math.max(0,Math.floor(this.#now()-startedAt))});this.#cancel(turn,'stream-failed');throw error;}
    finally{if(!turn.streamComplete)this.#cancel(turn,'consumer-interrupted');}
  }
  preparedNotice(deliveryId:string):string{return `Machine notification: companion prepared delivery ${deliveryId}. This is not a human message or feedback.`;}
  #proactiveExpiry():number {return this.#proactiveSuppressed?0:Math.max(this.#leaseExpires,this.#window.current(this.#now())?.expiresAt??0);}
  async #offerPrepared(deliveryId:string,authorization?:PreparedAuthorization):Promise<void>{
    text(deliveryId,128);
    if(!this.#mounted||this.#manualPaused||this.#switching||!this.#publish||this.#foregroundWaiting()||this.#now()>=this.#proactiveExpiry()||this.#preparedDeliveries.has(deliveryId))return;
    if(this.#preparedDeliveries.size>=128)return;this.#preparedDeliveries.add(deliveryId);
    const generation=this.#generation,permissionVersion=this.#windowVersion;
    let expiresAt=this.#leaseExpires;
    if(authorization){
      const window=this.#window.current(this.#now());
      if(authorization.permissionId!==null&&authorization.permissionId!==window?.id)return;
      // Anchor remaining validity to BEFORE this read-only request. Adding a
      // delayed event's TTL at receipt would extend the core's fixed deadline.
      const startedAt=this.#now();let checked:PreparedAuthorization;
      try{checked=await this.#backend.command('prepared-check',{deliveryId});}catch{return;}
      if(!checked||checked.permissionId!==authorization.permissionId||!Number.isFinite(checked.remainingMs)||checked.remainingMs<=0||checked.remainingMs>30000)return;
      expiresAt=Math.min(authorization.permissionId===null?this.#leaseExpires:window!.expiresAt,startedAt+Math.floor(checked.remainingMs));
    }else if(this.#now()>=this.#leaseExpires)return; // Legacy notifications can only use the original short input lease.
    const offer={deliveryId,generation,permissionVersion,expiresAt};if(!this.#offerValid(offer))return;
    this.#waitingPrepared.set(deliveryId,offer);await this.#drainPrepared();
  }
  #offerValid(offer:PreparedOffer):boolean{
    return this.#mounted&&!this.#manualPaused&&!this.#switching&&!this.#foregroundWaiting()&&offer.generation===this.#generation&&offer.permissionVersion===this.#windowVersion
      &&this.#now()<offer.expiresAt&&this.#now()<this.#proactiveExpiry();
  }
  #foregroundWaiting():boolean{const now=this.#now();return [...this.#arrivals].some(([id,arrival])=>!this.#handled.has(id)&&now<arrival.time+30000);}
  #nativeSettled():boolean{
    const turn=this.#turns.get(this.#latestTurn);return this.#activePrepared===null&&!!turn&&turn.ended&&turn.acknowledged&&!turn.cancelled;
  }
  async #drainPrepared():Promise<void>{
    if(this.#publishing||!this.#publish)return;this.#publishing=true;
    try{
      while(this.#waitingPrepared.size){
        const offer=this.#waitingPrepared.values().next().value!;
        if(!this.#offerValid(offer)){this.#waitingPrepared.delete(offer.deliveryId);continue;}
        if(!this.#nativeSettled())return;
        await this.#refreshUsage();
        if(!this.#offerValid(offer)){this.#waitingPrepared.delete(offer.deliveryId);continue;}
        if(!this.#nativeSettled())return;
        this.#waitingPrepared.delete(offer.deliveryId);
        const publication=new AbortController();this.#publicationAbort=publication;
        try{
          const accepted=await bounded(publication.signal,Math.max(1,Math.ceil(offer.expiresAt-this.#now())),signal=>this.#publish!(offer.deliveryId,messageId=>{
            if(signal.aborted||!this.#offerValid(offer)||!this.#nativeSettled()||this.#prepared.has(messageId))return false;text(messageId,256);
            this.#prepared.set(messageId,{messageId,deliveryId:offer.deliveryId,generation:offer.generation,permissionVersion:offer.permissionVersion,expiresAt:offer.expiresAt,consumed:false,cancelled:false});this.#activePrepared=messageId;return true;
          },signal));
          if(!accepted)for(const item of this.#prepared.values())if(item.deliveryId===offer.deliveryId){item.cancelled=true;if(this.#activePrepared===item.messageId)this.#activePrepared=null;}
          this.#log('prepared-notification',accepted?'machine-followup-queued':'not-queued');
        }catch{for(const item of this.#prepared.values())if(item.deliveryId===offer.deliveryId){item.cancelled=true;if(this.#activePrepared===item.messageId)this.#activePrepared=null;}
          this.#log('prepared-notification','rejected');}
        finally{publication.abort();if(this.#publicationAbort===publication)this.#publicationAbort=null;}
      }
    }finally{this.#publishing=false;}
  }
  #cancel(turn:Turn,reason:string):void{
    if(turn.cancelled)return;turn.cancelled=true;turn.controller.abort();turn.offAbort();this.#log('cancelled',reason,turn.number);void this.pause();
  }
  pause():Promise<void>{
    this.#pendingFeedback=null;this.#window.clear();this.#windowVersion++;this.#lastAcceptedHumanQuery=null;
    this.#generation++;this.#leaseExpires=0;this.#waitingPrepared.clear();this.#activePrepared=null;this.#publicationAbort?.abort();for(const item of this.#prepared.values())item.cancelled=true;
    for(const turn of this.#turns.values())if(!turn.ended){turn.cancelled=true;turn.controller.abort();turn.offAbort();}
    if(this.#pausing)return this.#pausing;
    const task=this.#backend.command('pause').then(async()=>{
      // Drop the host lease as well as the local stream. Resume cannot revive a stale scheduler context.
      await this.#backend.command('context',{quiet:true,available:false,ttlMs:1,recallQuery:null});
    }).then(()=>{},()=>{});this.#pausing=task;
    void task.then(()=>{if(this.#pausing===task)this.#pausing=null;});return task;
  }
  async companionWindow(grantId:string,durationMs:number):Promise<void>{
    if(durationMs===0){
      this.#windowVersion++;this.#window.clear();this.#proactiveSuppressed=true;this.#discardPrepared();
      await this.#backend.command('companion-window',{durationMs:0});return;
    }
    if(!this.#publish)fail('PROACTIVE_DISABLED');
    if(!this.#mounted||this.#manualPaused||this.#switching)fail('DSH_MANAGEMENT_UNAVAILABLE');
    if(this.#windowChanging||this.#foregroundWaiting()||!this.#nativeSettled())fail('COMPANION_WINDOW_BUSY');
    if(!this.#lastAcceptedHumanQuery)fail('COMPANION_WINDOW_REQUIRES_HUMAN_ACK');
    const query=this.#lastAcceptedHumanQuery,generation=this.#generation;
    const grant=this.#window.grant(grantId,durationMs,'dsh-command',this.#now()),version=++this.#windowVersion;
    this.#windowChanging=true;this.#discardPrepared();
    const authorized=()=>{const current=this.#window.current(this.#now());
      return this.#mounted&&generation===this.#generation&&version===this.#windowVersion&&!this.#manualPaused&&!this.#switching
        &&current?.id===grant.id&&current.generation===grant.generation&&current.expiresAt===grant.expiresAt;};
    try{
      if(!authorized())fail('DSH_MANAGEMENT_UNAVAILABLE');
      await this.#backend.command('companion-window',{grantId,durationMs,source:'dsh-command'});
      if(!authorized())fail('DSH_MANAGEMENT_UNAVAILABLE');
      this.#proactiveSuppressed=false;
      await this.#backend.command('schedule',{recallQuery:query});
      if(!authorized())fail('DSH_MANAGEMENT_UNAVAILABLE');
    }catch(error){
      // Expiry or a fresh human can race an already-written grant/schedule.
      // Revoke in pipe order; an aborted host promise is not a backend ACK.
      if(version===this.#windowVersion){this.#window.clear();this.#proactiveSuppressed=true;this.#discardPrepared();
        await this.#backend.command('companion-window',{durationMs:0}).catch(()=>{});}
      throw error;
    }finally{this.#windowChanging=false;}
  }
  async manualPause():Promise<void>{this.#manualVersion++;this.#manualPaused=true;await this.pause();}
  async manualResume():Promise<void>{
    if(!this.#mounted||this.#switching)fail('DSH_MANAGEMENT_UNAVAILABLE');const version=++this.#manualVersion;await this.#pausing;
    if(!this.#mounted||this.#switching||version!==this.#manualVersion)fail('DSH_MANAGEMENT_UNAVAILABLE');
    await this.#backend.command('resume');if(!this.#mounted||this.#switching||version!==this.#manualVersion){await this.pause();fail('DSH_MANAGEMENT_UNAVAILABLE');}this.#manualPaused=false;
  }
  async selectFeedback(deliveryId:string,outcome:'engaged'|'declined'|'neutral'):Promise<void>{
    text(deliveryId,128);if(!['engaged','declined','neutral'].includes(outcome)||!this.#mounted||this.#switching||this.#manualPaused)fail('DSH_MANAGEMENT_UNAVAILABLE');
    const turn=this.#turns.get(this.#latestTurn);if(turn&&!turn.ended)fail('DSH_MANAGEMENT_UNAVAILABLE');
    if(this.#pendingFeedback){
      if(this.#pendingFeedback.deliveryId!==deliveryId||this.#pendingFeedback.outcome!==outcome)fail('DSH_FEEDBACK_CONFLICT');
      return;
    }
    const version=this.#manualVersion,generation=this.#generation;
    await this.#backend.command('feedback-check',{deliveryId});
    if(!this.#mounted||this.#switching||this.#manualPaused||version!==this.#manualVersion||generation!==this.#generation)fail('DSH_MANAGEMENT_UNAVAILABLE');
    const active=this.#turns.get(this.#latestTurn);if(active&&!active.ended)fail('DSH_MANAGEMENT_UNAVAILABLE');
    const selected=this.status.pendingFeedback;
    if(selected){if(selected.deliveryId===deliveryId&&selected.outcome===outcome)return;fail('DSH_FEEDBACK_CONFLICT');}
    this.#pendingFeedback={deliveryId,outcome};
  }
  async revoke(ref:{id:string;revision:number}):Promise<void>{
    text(ref.id,128);if(!Number.isSafeInteger(ref.revision)||ref.revision<1||!this.#mounted)fail('DSH_MANAGEMENT_UNAVAILABLE');
    await this.manualPause();await this.#backend.command('revoke',{ref});
  }
  async switchBackend(backend:'baseline'|'no-state'|'flywire'):Promise<void>{
    if(!this.#mounted||this.#switching)fail('DSH_MANAGEMENT_UNAVAILABLE');this.#manualVersion++;this.#switching=true;this.#manualPaused=true;
    try{await this.pause();await this.#backend.command('switch',{backend});}
    finally{this.#switching=false;}
  }
  get status(){return {mounted:this.#mounted,sessionId:this.#sessionId,turn:this.#latestTurn,requestCount:this.#requests,
    ackCount:this.#acks,realModelCalls:this.#realCalls,usageSnapshotKnown:this.#usageKnown,manualPaused:this.#manualPaused,switching:this.#switching,sourceCount:this.#selected.size,preparedCount:this.#prepared.size,proactiveEnabled:!!this.#publish,
    leaseRemainingMs:Math.max(0,this.#leaseExpires-this.#now()),companionWindow:this.#window.status(this.#now()),pendingFeedback:this.#pendingFeedback?{...this.#pendingFeedback}:null};}
  dispose():Promise<DshBackendClose>{
    if(this.#close)return this.#close;this.#mounted=false;this.#offPrepared?.();
    this.#close=(async()=>{await this.pause();await this.#refreshUsage();const result=await this.#backend.close();this.#log('backend-closed',result.graceful?'closed':'partial');return result;})();return this.#close;
  }
}
