import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { CoupledSession } from './coupled-runtime.ts';
import type { UserInteraction } from './coupled-runtime.ts';
import { HttpInteractionProvider } from './http-interaction.ts';
import { InteractionResources, RequestBudget } from './interaction.ts';
import type { InteractionProvider, PriorAdapter } from './interaction.ts';
import { JsonlPriorAdapter } from './jsonl-prior.ts';
import type { JsonlPriorConfig, PriorCloseResult } from './jsonl-prior.ts';
import { MemoryStore } from './store.ts';
import { DurableMemory } from './durable-memory.ts';
import { CoreError, fail, text } from './validation.ts';
import { fields } from './wire.ts';

const MAX_LINE=32_768,MAX_BUFFER=131_072,MAX_OUTPUT_PENDING=262_144,MAX_COMMANDS=4096;
const safeCodes=new Set(['INVALID_INPUT','INVALID_WIRE_SHAPE','INVALID_JSON','BOOT_REQUIRED','ALREADY_BOOTED','BOOT_FAILED',
  'SESSION_TOKEN_MISMATCH','SESSION_PAUSED','HOST_CONTEXT_BLOCKED','SESSION_REBIND_REQUIRED','SESSION_CAPACITY_REACHED',
  'INTERACTION_IN_PROGRESS','INTERACTION_TERMINATED','INTERACTION_IDEMPOTENCY_CONFLICT','INTERACTION_BACKPRESSURE','INTERACTION_STALE',
  'DELIVERY_STALE','DELIVERY_EXPIRED','DELIVERY_ALREADY_CONSUMED','DELIVERY_NOT_TAKEN','FEEDBACK_REQUIRES_DELIVERED_RECEIPT',
  'DELIVERY_FEEDBACK_ALREADY_CONSUMED','REQUEST_BUDGET_EXHAUSTED','BUDGET_DISABLED','INFERENCE_TIMEOUT','PROVIDER_NETWORK',
  'PROVIDER_HTTP_STATUS','PROVIDER_CONTENT_TYPE','PROVIDER_RESPONSE_TOO_LARGE','PROVIDER_RESPONSE_INVALID','ABORTED',
  'SUBMIT_IN_PROGRESS','MANAGEMENT_IN_PROGRESS','COMMAND_ID_REUSED','COMMAND_CAPACITY','UNKNOWN_COMMAND','INPUT_LIMIT',
  'TRUNCATED_INPUT','STOPPING','NEURAL_NOT_CONFIGURED','NEURAL_SWITCH_LIMIT','NEURAL_SWITCH_CANCELLED','NEURAL_CLOSE_PARTIAL',
  'NEURAL_BINDING_REUSE_FORBIDDEN','NEURAL_PROCESS_CLOSED','NEURAL_RESIDENT_LIMIT','NEURAL_READY_FAILED','NEURAL_READY_TIMEOUT',
  'NEURAL_READY_INVALID','NEURAL_SOURCE_MISMATCH','NEURAL_ABORTED','NEURAL_DEADLINE','BACKEND_UNAVAILABLE',
  'DURABLE_CONFIG','DURABLE_UNSUPPORTED','DURABLE_KEY_INVALID','DURABLE_INCOMPLETE','DURABLE_CORRUPT','DURABLE_LOCKED',
  'DURABLE_IDENTITY_MISMATCH','DURABLE_BUDGET_MISMATCH','DURABLE_LIMIT','DURABLE_WRITE_FAILED','DURABLE_UNAVAILABLE',
  'DURABLE_CLOCK_ROLLBACK','DURABLE_REQUEST_REQUIRED','DURABLE_DELIVERY_CONFLICT','DURABLE_MEMORY_ONLY',
  'UNSUPPORTED_SCHEMA','UNKNOWN_DATABASE','SCHEMA_MISMATCH','FOREGROUND_DRAIN_REFUSED']);
function safeError(error:unknown):string {
  if(error instanceof CoreError&&safeCodes.has(error.code))return error.code;
  if(error instanceof Error&&error.name==='AbortError')return 'ABORTED';
  return 'INTERNAL_ERROR';
}
type OwnedPrior=PriorAdapter&{close():Promise<PriorCloseResult>};
export type StdioExit={status:'closed'|'partial';reason:string;workerCloses:PriorCloseResult[];
  rawCallsActive:boolean;rawTransportActive:boolean;rawNeuralActive:boolean;outputFlushed:boolean};
export type TrustedStdioOptions={input:Readable;output:Writable;clock?:()=>number;wallClock?:()=>number;
  /** Injection is an in-process test seam; the CLI exposes no provider override. */
  providerFactory?:(config:{apiKey:string;model:string},resources:InteractionResources)=>InteractionProvider;
  priorFactory?:(config:JsonlPriorConfig)=>Promise<OwnedPrior>};

/** Private parent-owned stdio only. Optional encrypted vault; no listening socket or credentials discovery. */
export function runTrustedStdio(options:TrustedStdioOptions):Promise<StdioExit> {
  return new StdioHost(options).run();
}

class StdioHost {
  readonly #options:TrustedStdioOptions;readonly #clock:()=>number;
  #store:MemoryStore|null=null;#session:CoupledSession|null=null;#resources:InteractionResources|null=null;
  #durable:DurableMemory|null=null;
  #maxCalls=0;#booted=false;#stopping=false;#finished=false;#outputFailed=false;#partial=false;#controlVersion=0;
  #buffer=Buffer.alloc(0);#seen=new Set<string>();#pendingBytes=0;#flushWaiters:Array<()=>void>=[];
  #submitting:Promise<void>|null=null;#management:Promise<unknown>|null=null;
  #worker:OwnedPrior|null=null;#workerClosing:Promise<PriorCloseResult|null>|null=null;#workerStarts=0;
  #workerCloses:PriorCloseResult[]=[];#neuralConfig:JsonlPriorConfig|undefined;
  #hostContext={quiet:true,available:false,expiresAt:0};#scheduleQuery:string|null=null;
  #foregroundWait:AbortController|null=null;
  #shutdown:Promise<StdioExit>|null=null;#done:Promise<StdioExit>;#resolveDone!:(result:StdioExit)=>void;
  constructor(options:TrustedStdioOptions){this.#options=options;this.#clock=options.clock??(()=>performance.now());
    this.#done=new Promise(resolve=>{this.#resolveDone=resolve;});}
  run():Promise<StdioExit>{
    this.#options.input.on('data',this.#onData);this.#options.input.once('end',this.#onEnd);this.#options.input.once('error',this.#onInputError);
    this.#options.input.once('close',this.#onInputClose);this.#options.output.once('close',this.#onOutputClose);
    this.#options.output.on('error',this.#onOutputError);this.#options.input.resume();return this.#done;
  }
  #onInputError=()=>{this.#partial=true;void this.#stop('stdin-error');};
  #onOutputError=()=>{this.#outputFailed=true;this.#partial=true;void this.#stop('stdout-error');};
  #onInputClose=()=>{if(!this.#stopping){this.#partial=true;void this.#stop('stdin-close');}};
  #onOutputClose=()=>{if(!this.#finished){this.#outputFailed=true;this.#partial=true;void this.#stop('stdout-close');}};
  #onEnd=()=>{if(this.#buffer.length){this.#partial=true;this.#reply(null,false,'TRUNCATED_INPUT');}void this.#stop('stdin-eof');};
  #emit(frame:unknown):void{
    if(this.#outputFailed)return;
    const line=JSON.stringify(frame)+'\n',bytes=Buffer.byteLength(line);
    if(bytes>MAX_BUFFER||this.#pendingBytes+bytes>MAX_OUTPUT_PENDING){this.#outputFailed=true;this.#partial=true;void this.#stop('stdout-backpressure');return;}
    this.#pendingBytes+=bytes;
    try{this.#options.output.write(line,error=>{
      this.#pendingBytes-=bytes;
      if(error)this.#onOutputError();
      if(this.#pendingBytes===0){for(const done of this.#flushWaiters)done();this.#flushWaiters=[];}
    });}catch{this.#pendingBytes-=bytes;this.#onOutputError();}
  }
  #reply(id:string|null,ok:boolean,value:unknown):void{
    this.#emit(ok?{version:1,id,ok:true,result:value}:{version:1,id,ok:false,error:{code:value}});
  }
  #onData=(chunk:Buffer|string)=>{
    if(this.#stopping)return;
    const incoming=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    if(incoming.length>MAX_BUFFER||this.#buffer.length+incoming.length>MAX_BUFFER){this.#partial=true;this.#reply(null,false,'INPUT_LIMIT');void this.#stop('stdin-limit');return;}
    this.#buffer=Buffer.concat([this.#buffer,incoming]);
    for(;;){
      const newline=this.#buffer.indexOf(10);if(newline<0)break;
      const line=this.#buffer.subarray(0,newline);this.#buffer=this.#buffer.subarray(newline+1);
      if(line.length>MAX_LINE){this.#partial=true;this.#reply(null,false,'INPUT_LIMIT');void this.#stop('stdin-limit');return;}
      this.#line(line);if(this.#stopping)return;
    }
    if(this.#buffer.length>MAX_LINE){this.#partial=true;this.#reply(null,false,'INPUT_LIMIT');void this.#stop('stdin-limit');}
  };
  #line(line:Buffer):void{
    let id:string|null=null;
    try{
      let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}catch{fail('INVALID_JSON');}
      if(typeof parsed!=='object'||parsed===null||Array.isArray(parsed))fail('INVALID_WIRE_SHAPE');
      const request=parsed as Record<string,unknown>;text(request.id,128);id=request.id;text(request.command,32);
      if(request.version!==undefined&&request.version!==1)fail('INVALID_WIRE_SHAPE');
      if(this.#stopping)fail('STOPPING');
      if(!this.#booted){
        if(request.command!=='boot')fail('BOOT_REQUIRED');
        this.#boot(request);this.#seen.add(id);this.#reply(id,true,this.#status());return;
      }
      if(request.command==='boot')fail('ALREADY_BOOTED');
      // Stop/pause/status remain available when a bounded command ledger is full.
      if(!['stop','pause','status','revoke','purge'].includes(request.command)){
        if(this.#seen.has(id))fail('COMMAND_ID_REUSED');if(this.#seen.size>=MAX_COMMANDS)fail('COMMAND_CAPACITY');this.#seen.add(id);
      }
      const result=this.#dispatch(request);
      if(request.command==='stop')return; // The stop ACK is flushed before the run promise resolves.
      if(result instanceof Promise){void result.then(value=>this.#reply(id,true,value),error=>this.#reply(id,false,safeError(error)));}
      else this.#reply(id,true,result);
    }catch(error){this.#reply(id,false,safeError(error));if(!this.#booted){this.#partial=true;void this.#stop('boot-failed');}}
  }
  #shape(request:Record<string,unknown>,required:string[],optional:string[]=[]):Record<string,unknown>{
    return fields(request,['id','command',...required],['version',...optional]);
  }
  #boot(request:Record<string,unknown>):void{
    this.#shape(request,[],['apiKey','model','maxCalls','neuralConfig','persistence']);
    const maxCalls=request.maxCalls??0,model=request.model??'deepseek-flash';
    if(!Number.isSafeInteger(maxCalls)||(maxCalls as number)<0||(maxCalls as number)>32)fail('INVALID_INPUT');
    text(model,128);if(!/^[a-zA-Z0-9._-]+$/.test(model))fail('INVALID_INPUT');
    if(request.apiKey!==undefined){text(request.apiKey,4096);if(/[\r\n]/.test(request.apiKey))fail('INVALID_INPUT');}
    if((maxCalls as number)>0&&typeof request.apiKey!=='string')fail('INVALID_INPUT');
    if(request.neuralConfig!==undefined){
      const n=fields(request.neuralConfig,['pythonPath','workerPath','workerSha256','graphPath','graphSha256','structuralSha256'],
        ['condition','startupTimeoutMs','eventTimeoutMs']);
      for(const key of ['pythonPath','workerPath','graphPath'] as const)text(n[key],4096);
      for(const key of ['workerSha256','graphSha256','structuralSha256'] as const)if(typeof n[key]!=='string'||!/^[a-f0-9]{64}$/.test(n[key]))fail('INVALID_INPUT');
      if(n.condition!==undefined&&!['real','no-circuit'].includes(n.condition as string))fail('INVALID_INPUT');
      this.#neuralConfig=structuredClone(n) as JsonlPriorConfig;
    }
    this.#maxCalls=maxCalls as number;
    if(request.persistence!==undefined){
      const p=fields(request.persistence,['directory','identity','keyBase64']);
      text(p.directory,4096);text(p.identity,128);text(p.keyBase64,128);
      if(p.keyBase64===request.apiKey)fail('DURABLE_KEY_INVALID');
      this.#durable=new DurableMemory({directory:p.directory,identity:p.identity,keyBase64:p.keyBase64},this.#maxCalls,
        {clock:{wall:this.#options.wallClock??Date.now,monotonic:this.#clock}});
      this.#store=this.#durable.store;
    }
    const budget=new RequestBudget({total:Math.max(1,this.#maxCalls),hourly:Math.max(1,Math.min(8,this.#maxCalls)),daily:Math.max(1,this.#maxCalls)},this.#clock,
      this.#durable?{initialTotal:this.#durable.reserved,reserve:id=>this.#durable!.reserve(id)}:undefined);
    const resources=new InteractionResources(budget);this.#resources=resources;
    // Zero-call boot neither loads a key nor constructs an HTTP provider.
    const provider:InteractionProvider=this.#maxCalls===0?{interact:async()=>fail('BUDGET_DISABLED')}:
      (this.#options.providerFactory??((config,shared)=>new HttpInteractionProvider({transport:'cloud_https',
        endpoint:'https://api.deepseek.com/chat/completions',model:config.model},shared,{apiKey:config.apiKey})))
        ({apiKey:request.apiKey as string,model},resources);
    this.#store??=new MemoryStore(':memory:',{clock:{wall:this.#options.wallClock??(()=>Date.now()),monotonic:this.#clock}});
    const scope=this.#store.ensureScope({tenantId:'trusted-stdio-local',subjectId:'local-user',personaId:'companion',relationshipId:'local-session'});
    this.#session=new CoupledSession(this.#store,scope,{provider,resources,clock:this.#clock,...(this.#durable?{durable:this.#durable}:{})});this.#booted=true;
  }
  #status(){
    const status=this.#session?.status,usage=this.#resources?.budget.usage;
    return {booted:this.#booted,sessionId:status?.sessionId??null,backend:status?.backend??'baseline',paused:status?.paused??true,
      invalidated:status?.invalidated??false,available:this.#hostContext.available&&this.#clock()<this.#hostContext.expiresAt,
      quiet:this.#hostContext.quiet,maxCalls:this.#maxCalls,requestsEnabled:this.#maxCalls>0,
      requests:{total:usage?.total??0,hour:usage?.hour??0,day:usage?.day??0},submitting:this.#submitting!==null,
      managementBusy:this.#management!==null,workerResident:this.#worker!==null,workerStarts:this.#workerStarts,
      rawCallsActive:status?.rawActive??false,rawTransportActive:status?.transportActive??false,
      scheduled:this.#scheduleQuery!==null,stopping:this.#stopping,sessionOnly:!this.#durable,personalPersistence:!!this.#durable,
      stateResetOnRestore:!!this.#durable,persistence:this.#durable?.status??null,
      lastSourceRef:status?.lastSourceRef??null,lastAcknowledgedDeliveryId:status?.lastAcknowledgedDeliveryId??null,
      lastMemoryRef:status?.lastMemoryRef??null,requestAudit:status?.requestAudit??null,
      background:status&&!status.paused&&!status.invalidated?this.#session!.background():null};
  }
  #requireSession(request:Record<string,unknown>):void{
    if(request.sessionId!==this.#session!.sessionId)fail('SESSION_TOKEN_MISMATCH');
  }
  #dispatch(request:Record<string,unknown>):unknown{
    const session=this.#session!;
    switch(request.command){
      case 'status':this.#shape(request,[]);return this.#status();
      case 'pause':this.#shape(request,[]);this.#controlVersion++;this.#foregroundWait?.abort();session.pause();return this.#status();
      case 'resume':this.#shape(request,['sessionId']);this.#requireSession(request);if(this.#management)fail('MANAGEMENT_IN_PROGRESS');session.resume();return this.#status();
      case 'context':{
        this.#shape(request,['sessionId','quiet','available','ttlMs'],['recallQuery']);this.#requireSession(request);
        if(typeof request.quiet!=='boolean'||typeof request.available!=='boolean'||!Number.isSafeInteger(request.ttlMs)
          ||(request.ttlMs as number)<1||(request.ttlMs as number)>30000)fail('INVALID_INPUT');
        if(request.recallQuery!==undefined&&request.recallQuery!==null)text(request.recallQuery,256);
        this.#foregroundWait?.abort();
        const context={quiet:request.quiet,available:request.available,ttlMs:request.ttlMs as number};
        this.#hostContext={quiet:context.quiet,available:context.available,expiresAt:this.#clock()+context.ttlMs};session.setHostContext(context);
        if(request.recallQuery!==undefined&&request.recallQuery!==this.#scheduleQuery){
          this.#scheduleQuery=request.recallQuery as string|null;session.stopScheduler();
          if(this.#scheduleQuery!==null)session.startScheduler({recallQuery:this.#scheduleQuery,
            refreshContext:()=>({quiet:this.#hostContext.quiet,available:this.#hostContext.available&&this.#clock()<this.#hostContext.expiresAt,
              ttlMs:Math.max(1,Math.min(30000,Math.floor(this.#hostContext.expiresAt-this.#clock())))}),
            onReady:result=>{if(!this.#stopping)this.#emit({version:1,event:'delivery-ready',sessionId:result.sessionId,deliveryId:result.deliveryId});},
            onError:code=>{if(!this.#stopping)this.#emit({version:1,event:'scheduler-error',code:safeCodes.has(code)?code:'INTERNAL_ERROR'});}});
        }
        return this.#status();
      }
      case 'schedule':{
        this.#shape(request,['sessionId','recallQuery']);this.#requireSession(request);
        if(request.recallQuery===null){session.stopScheduler();this.#scheduleQuery=null;return {scheduled:false};}
        text(request.recallQuery,256);
        if(this.#management||this.#submitting)fail('MANAGEMENT_IN_PROGRESS');
        session.stopScheduler();this.#scheduleQuery=null;
        if(session.status.paused||session.status.invalidated||this.#hostContext.quiet||!this.#hostContext.available
          ||this.#clock()>=this.#hostContext.expiresAt)return {scheduled:false};
        // Scheduling owns no presence grant: retain the existing absolute expiry.
        this.#scheduleQuery=request.recallQuery;
        session.startScheduler({recallQuery:this.#scheduleQuery,
          refreshContext:()=>({quiet:this.#hostContext.quiet,available:this.#hostContext.available&&this.#clock()<this.#hostContext.expiresAt,
            ttlMs:Math.max(1,Math.min(30000,Math.floor(this.#hostContext.expiresAt-this.#clock())))}),
          onReady:result=>{if(!this.#stopping)this.#emit({version:1,event:'delivery-ready',sessionId:result.sessionId,deliveryId:result.deliveryId});},
          onError:code=>{if(!this.#stopping)this.#emit({version:1,event:'scheduler-error',code:safeCodes.has(code)?code:'INTERNAL_ERROR'});}});
        return {scheduled:true};
      }
      case 'submit':{
        this.#shape(request,['sessionId','messageId','selectedText'],['recallQuery','feedback']);this.#requireSession(request);
        if(this.#management)fail('MANAGEMENT_IN_PROGRESS');if(this.#submitting)fail('SUBMIT_IN_PROGRESS');
        if(this.#maxCalls===0)fail('BUDGET_DISABLED');text(request.messageId,128);text(request.selectedText,4096);
        if(request.recallQuery!==undefined)text(request.recallQuery,256);
        let feedback:{deliveryId:string;outcome:'engaged'|'declined'|'neutral'}|undefined;
        if(request.feedback!==undefined){const f=fields(request.feedback,['deliveryId','outcome']);text(f.deliveryId,128);
          if(!['engaged','declined','neutral'].includes(f.outcome as string))fail('INVALID_INPUT');feedback=f as typeof feedback;}
        const operation=this.#submitWhenIdle({sessionId:session.sessionId,id:request.messageId,selectedText:request.selectedText,
          ...(request.recallQuery===undefined?{}:{recallQuery:request.recallQuery}),...(feedback===undefined?{}:{feedback})});
        const task=operation.then(()=>{},()=>{});this.#submitting=task;
        void task.then(()=>{if(this.#submitting===task)this.#submitting=null;});
        return operation.then(result=>({sessionId:result.sessionId,requestId:result.requestId,deliveryId:result.deliveryId,
          status:result.status,appraisalStatus:result.appraisalStatus}));
      }
      case 'take':this.#shape(request,['sessionId','deliveryId']);this.#requireSession(request);text(request.deliveryId,128);return session.takeDelivery(request.deliveryId);
      case 'ack':this.#shape(request,['sessionId','deliveryId']);this.#requireSession(request);text(request.deliveryId,128);return session.acknowledgeDelivery(request.deliveryId);
      case 'feedback-check':this.#shape(request,['sessionId','deliveryId']);this.#requireSession(request);text(request.deliveryId,128);session.validateFeedback(request.deliveryId);return {valid:true};
      case 'reset':this.#shape(request,['sessionId']);this.#requireSession(request);this.#controlVersion++;this.#foregroundWait?.abort();session.reset();return this.#status();
      case 'revoke':
      case 'purge':{
        this.#shape(request,['sessionId',...(request.command==='revoke'?['ref']:[])]);this.#requireSession(request);this.#controlVersion++;this.#foregroundWait?.abort();
        if(request.command==='revoke'){const ref=fields(request.ref,['id','revision']);text(ref.id,128);
          if(!Number.isSafeInteger(ref.revision)||(ref.revision as number)<1)fail('INVALID_INPUT');session.revoke({id:ref.id,revision:ref.revision as number});}
        else session.purge();
        session.stopScheduler();this.#scheduleQuery=null;
        return (async()=>{await this.#management?.catch(()=>{});const close=await this.#closeWorker();return {status:this.#status(),workerClose:close};})();
      }
      case 'switch':{
        this.#shape(request,['sessionId','backend']);this.#requireSession(request);
        if(!['baseline','no-state','flywire'].includes(request.backend as string))fail('BACKEND_UNAVAILABLE');
        if(this.#management)fail('MANAGEMENT_IN_PROGRESS');const backend=request.backend as 'baseline'|'no-state'|'flywire';
        if(backend==='flywire'&&!this.#neuralConfig)fail('NEURAL_NOT_CONFIGURED');
        const version=++this.#controlVersion;this.#foregroundWait?.abort();session.pause();session.stopScheduler();this.#scheduleQuery=null;
        const task=this.#switch(backend,version);this.#management=task;
        void task.then(()=>{if(this.#management===task)this.#management=null;},()=>{if(this.#management===task)this.#management=null;});return task;
      }
      case 'stop':this.#shape(request,[]);return this.#stop('parent-stop',request.id as string);
      default:fail('UNKNOWN_COMMAND');
    }
  }
  async #submitWhenIdle(input:UserInteraction){
    const session=this.#session!,version=this.#controlVersion,deadline=Math.min(this.#hostContext.expiresAt,this.#clock()+30000);
    if(session.status.invalidated)fail('SESSION_REBIND_REQUIRED');if(session.status.paused)fail('SESSION_PAUSED');
    if(this.#hostContext.quiet||!this.#hostContext.available||this.#clock()>=deadline)fail('HOST_CONTEXT_BLOCKED');
    // Stop only background ownership. Cancellation never frees any raw permit.
    session.stopScheduler();this.#scheduleQuery=null;
    const controller=new AbortController();this.#foregroundWait=controller;
    const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.ceil(deadline-this.#clock())));
    try{
      await session.waitForIdle(controller.signal);
      if(controller.signal.aborted||this.#stopping||version!==this.#controlVersion||session!==this.#session
        ||this.#clock()>=deadline||session.status.paused||session.status.invalidated)fail('FOREGROUND_DRAIN_REFUSED');
    }catch{fail('FOREGROUND_DRAIN_REFUSED');}
    finally{clearTimeout(timer);controller.abort();if(this.#foregroundWait===controller)this.#foregroundWait=null;}
    // No ingress, memory or quota mutation occurs until this single admission.
    return session.submit(input);
  }
  async #switch(backend:'baseline'|'no-state'|'flywire',version:number):Promise<unknown>{
    const session=this.#session!;await this.#submitting;
    if(this.#stopping||version!==this.#controlVersion)fail('NEURAL_SWITCH_CANCELLED');
    if(this.#worker){
      try{await session.switchBackend('baseline');}catch(error){await this.#closeWorker();throw error;}
      const close=await this.#closeWorker();if(!close?.graceful)fail('NEURAL_CLOSE_PARTIAL');
    }
    if(this.#stopping||version!==this.#controlVersion)fail('NEURAL_SWITCH_CANCELLED');
    if(backend==='flywire'){
      if(this.#workerStarts>=16)fail('NEURAL_SWITCH_LIMIT');this.#workerStarts++;
      const worker=await (this.#options.priorFactory??(config=>JsonlPriorAdapter.start(config)))(this.#neuralConfig!);this.#worker=worker;
      if(this.#stopping||version!==this.#controlVersion){await this.#closeWorker();fail('NEURAL_SWITCH_CANCELLED');}
      try{await session.switchBackend('flywire',worker);}catch(error){await this.#closeWorker();throw error;}
    }else await session.switchBackend(backend);
    if(this.#stopping||version!==this.#controlVersion)fail('NEURAL_SWITCH_CANCELLED');
    return this.#status();
  }
  #closeWorker():Promise<PriorCloseResult|null>{
    if(this.#workerClosing)return this.#workerClosing;const worker=this.#worker;if(!worker)return Promise.resolve(null);
    const closing=(async()=>{
      try{
        const result=await worker.close();
        if(result.closed!==true||typeof result.graceful!=='boolean'||typeof result.forced!=='boolean'
          ||!Number.isSafeInteger(result.residualBytes)||result.residualBytes<0||!(result.exitCode===null||Number.isSafeInteger(result.exitCode)))fail('NEURAL_CLOSE_PARTIAL');
        const safe:PriorCloseResult={closed:true,graceful:result.graceful&&result.exitCode===0&&result.signal===null&&!result.forced&&result.residualBytes===0,exitCode:result.exitCode,
          signal:result.signal===null?null:/^[A-Z0-9]{1,32}$/.test(result.signal)?result.signal:'UNKNOWN',forced:result.forced,residualBytes:result.residualBytes};
        this.#workerCloses.push(safe);if(!safe.graceful)this.#partial=true;if(this.#worker===worker)this.#worker=null;return safe;
      }catch{this.#partial=true;return null;}
      finally{this.#workerClosing=null;}
    })();this.#workerClosing=closing;return closing;
  }
  #stop(reason:string,stopId?:string):Promise<StdioExit>{
    if(this.#shutdown)return this.#shutdown;this.#stopping=true;this.#controlVersion++;
    this.#foregroundWait?.abort();
    this.#options.input.pause();this.#options.input.removeListener('data',this.#onData);this.#buffer=Buffer.alloc(0);
    try{this.#session?.pause();}catch{this.#partial=true;}this.#session?.stopScheduler();this.#scheduleQuery=null;
    this.#shutdown=(async()=>{
      await this.#submitting;await this.#management?.catch(()=>{});await this.#closeWorker();
      try{if(this.#durable)this.#durable.close();else this.#store?.close();this.#store=null;}catch{this.#partial=true;}
      const rawCallsActive=this.#resources?.calls.active??false,rawTransportActive=this.#resources?.transport.active??false,
        rawNeuralActive=this.#resources?.neural.active??false;
      const result:StdioExit={status:this.#partial||this.#worker!==null||rawCallsActive||rawTransportActive||rawNeuralActive?'partial':'closed',
        reason,workerCloses:structuredClone(this.#workerCloses),rawCallsActive,rawTransportActive,rawNeuralActive,outputFlushed:false};
      const {outputFlushed:_pendingFlush,...audit}=result;
      if(stopId!==undefined)this.#reply(stopId,true,audit);
      this.#emit({version:1,event:'stopped',...audit});
      const flushed=await this.#flush();
      // A stream error can arrive after the write callback resolves the waiter
      // but before this continuation. Reconcile that final transport state.
      result.outputFlushed=flushed&&!this.#outputFailed;if(this.#partial||!result.outputFlushed)result.status='partial';
      this.#options.input.removeListener('end',this.#onEnd);this.#options.input.removeListener('error',this.#onInputError);
      this.#options.input.removeListener('close',this.#onInputClose);this.#finished=true;this.#resolveDone(result);return result;
    })();return this.#shutdown;
  }
  #flush():Promise<boolean>{
    if(this.#outputFailed)return Promise.resolve(false);if(this.#pendingBytes===0)return Promise.resolve(true);
    return new Promise(resolve=>{let done=false;const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(timer);resolve(ok);};
      const timer=setTimeout(()=>finish(false),1000);this.#flushWaiters.push(()=>finish(!this.#outputFailed));});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  void runTrustedStdio({input:process.stdin,output:process.stdout}).then(result=>{
    // Exit closes this entrypoint after local cleanup; it is not a remote-model cancellation ACK.
    process.exit(result.status==='closed'?0:1);
  },()=>{process.stdout.write('{"version":1,"event":"fatal","code":"INTERNAL_ERROR"}\n',()=>process.exit(1));});
}
