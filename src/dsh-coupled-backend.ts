import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { CoreError, fail, text } from './validation.ts';

export type DshBackendConfig={mode:'resident'|'synthetic';pythonPath?:string;scriptPath?:string;corePath:string;nodePath:string;
  runtimeRoot:string;maxCalls:number;allowExistingDpapi?:boolean;neuralRuntime?:string;credentialRoot?:string};
export type DshBackendClose={closed:true;graceful:boolean;exitCode:number|null;signal:string|null;forced:boolean;residualBytes:number;coreStatus:string|null};
export interface DshCoupledBackend {
  readonly sessionId:string;
  command(command:string,fields?:Record<string,unknown>,signal?:AbortSignal):Promise<any>;
  onPrepared?(callback:(deliveryId:string)=>void):()=>void;
  close():Promise<DshBackendClose>;
}
type Pending={resolve:(value:unknown)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>;
  signal:AbortSignal|undefined;abort:()=>void;cancelled:boolean};
const allowedEnv=new Set(['SYSTEMROOT','WINDIR','PATH','PATHEXT','COMSPEC','TEMP','TMP','LOCALAPPDATA']);

/** Owns one private launcher and consumes only its bounded v1 JSON protocol.
 * The approved launcher, not this plugin/client, owns any DPAPI key access. */
export class DshStdioBackend implements DshCoupledBackend {
  static #resident=false;
  readonly #child:ChildProcessWithoutNullStreams;readonly #expectedBudget:number;
  #sessionId='';#buffer=Buffer.alloc(0);#stderrBytes=0;#pending=new Map<string,Pending>();#writes=0;
  #closed=false;#closing=false;#fatal:CoreError|null=null;#forced=false;#exitCode:number|null=null;#exitSignal:string|null=null;
  #coreStatus:string|null=null;#coreStopped=false;#closePromise:Promise<DshBackendClose>|null=null;
  #prepared=new Set<(deliveryId:string)=>void>();
  #boot:Promise<void>;#bootResolve!:()=>void;#bootReject!:(error:unknown)=>void;#bootTimer:ReturnType<typeof setTimeout>;
  #closedPromise:Promise<void>;#closedResolve!:()=>void;
  private constructor(child:ChildProcessWithoutNullStreams,budget:number){
    this.#child=child;this.#expectedBudget=budget;
    this.#boot=new Promise((resolve,reject)=>{this.#bootResolve=resolve;this.#bootReject=reject;});
    this.#closedPromise=new Promise(resolve=>{this.#closedResolve=resolve;});
    this.#bootTimer=setTimeout(()=>this.#terminate('DSH_BACKEND_BOOT_TIMEOUT'),30000);
    child.stdout.on('data',(chunk:Buffer)=>this.#data(chunk));
    child.stderr.on('data',(chunk:Buffer)=>{this.#stderrBytes+=chunk.length;if(this.#stderrBytes>16384)this.#terminate('DSH_BACKEND_STDERR_LIMIT');});
    child.stdin.on('error',()=>this.#terminate('DSH_BACKEND_STDIN_ERROR'));
    child.stdout.on('error',()=>this.#terminate('DSH_BACKEND_STDOUT_ERROR'));
    child.stderr.on('error',()=>this.#terminate('DSH_BACKEND_STDERR_ERROR'));
    const pipeClosed=()=>{if(!this.#closed&&!(this.#closing&&this.#coreStopped))this.#terminate('DSH_BACKEND_PIPE_CLOSED');};
    child.stdout.on('close',pipeClosed);
    // Child exit may close stdin before the final stdout frame is dispatched.
    // During an explicit close the pending command/close deadlines still own it.
    child.stdin.on('close',()=>{if(!this.#closed&&!this.#closing)this.#terminate('DSH_BACKEND_PIPE_CLOSED');});
    child.on('error',()=>this.#terminate('DSH_BACKEND_PROCESS_ERROR'));
    child.on('close',(code:number|null,signal:string|null)=>{
      this.#closed=true;this.#exitCode=code;this.#exitSignal=signal;DshStdioBackend.#resident=false;clearTimeout(this.#bootTimer);
      if(this.#buffer.length)this.#fatal??=new CoreError('DSH_BACKEND_PARTIAL_OUTPUT');
      if(!this.#sessionId)this.#bootReject(this.#fatal??new CoreError('DSH_BACKEND_BOOT_FAILED'));
      for(const id of [...this.#pending.keys()])this.#settle(id,false,this.#fatal??new CoreError('DSH_BACKEND_CLOSED'));
      this.#closedResolve();
    });
  }
  get sessionId():string{return this.#sessionId;}
  onPrepared(callback:(deliveryId:string)=>void):()=>void{this.#prepared.add(callback);return()=>{this.#prepared.delete(callback);};}
  static async start(config:DshBackendConfig,dependencies:{spawn?:typeof spawn}={}):Promise<DshStdioBackend>{
    if(!config||!['resident','synthetic'].includes(config.mode)||!Number.isSafeInteger(config.maxCalls)||config.maxCalls<0||config.maxCalls>32)fail('DSH_BACKEND_CONFIG');
    for(const path of [config.corePath,config.nodePath,config.runtimeRoot]){text(path,4096);if(!isAbsolute(path))fail('DSH_BACKEND_CONFIG');}
    if(config.neuralRuntime!==undefined&&!isAbsolute(config.neuralRuntime))fail('DSH_BACKEND_CONFIG');
    if(config.credentialRoot!==undefined){
      text(config.credentialRoot,4096);if(!isAbsolute(config.credentialRoot))fail('DSH_BACKEND_CONFIG');
      try{if(!(await stat(config.credentialRoot)).isDirectory())fail('DSH_BACKEND_CONFIG');}catch{fail('DSH_BACKEND_CONFIG');}
    }
    let executable:string,args:string[];
    if(config.mode==='synthetic'){
      if(config.allowExistingDpapi||config.credentialRoot!==undefined)fail('DSH_BACKEND_CONFIG');
      executable=config.nodePath;args=[join(config.corePath,'src','dsh-coupled-synthetic.ts')];
    }else{
      if(!config.pythonPath||!config.scriptPath||!isAbsolute(config.pythonPath)||!isAbsolute(config.scriptPath))fail('DSH_BACKEND_CONFIG');
      if(config.maxCalls>0&&config.allowExistingDpapi!==true)fail('DSH_BACKEND_CREDENTIAL_FLAG_REQUIRED');
      executable=config.pythonPath;args=[config.scriptPath,'--core',config.corePath,'--node',config.nodePath,
        '--runtime-root',config.runtimeRoot,'--max-calls',String(config.maxCalls)];
      if(config.maxCalls>0)args.push('--allow-existing-dpapi');if(config.neuralRuntime)args.push('--neural-runtime',config.neuralRuntime);
      if(config.credentialRoot!==undefined)args.push('--credential-root',config.credentialRoot);
    }
    if(DshStdioBackend.#resident)fail('DSH_BACKEND_RESIDENT_LIMIT');DshStdioBackend.#resident=true;
    let child:ChildProcessWithoutNullStreams;
    try{child=(dependencies.spawn??spawn)(executable,args,{cwd:config.runtimeRoot,stdio:'pipe',windowsHide:true,
      env:Object.fromEntries(Object.entries(process.env).filter(([key])=>allowedEnv.has(key.toUpperCase())))});}
    catch(error){DshStdioBackend.#resident=false;throw new CoreError('DSH_BACKEND_PROCESS_ERROR');}
    const backend=new DshStdioBackend(child,config.maxCalls);
    if(config.mode==='synthetic')backend.#write({id:'host-boot',command:'boot',maxCalls:config.maxCalls,apiKey:'synthetic-fixture-not-a-credential'});
    await backend.#boot;
    if(backend.#closed||backend.#fatal){await backend.#closedPromise;throw backend.#fatal??new CoreError('DSH_BACKEND_CLOSED');}
    return backend;
  }
  #terminate(code:string):void{
    if(this.#closed)return;this.#fatal??=new CoreError(code);this.#closing=true;
    // This is the owned launcher only. Its Windows Job closes its owned tree.
    if(this.#child.kill())this.#forced=true;
  }
  #write(frame:unknown):void{
    const line=JSON.stringify(frame)+'\n',bytes=Buffer.byteLength(line);
    if(bytes>32768||this.#writes+bytes>65536){this.#terminate('DSH_BACKEND_WRITE_LIMIT');return;}
    this.#writes+=bytes;
    try{this.#child.stdin.write(line,error=>{this.#writes-=bytes;if(error)this.#terminate('DSH_BACKEND_STDIN_ERROR');});}
    catch{this.#writes-=bytes;this.#terminate('DSH_BACKEND_STDIN_ERROR');}
  }
  #settle(id:string,ok:boolean,value:unknown):void{
    const entry=this.#pending.get(id);if(!entry)return;this.#pending.delete(id);clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort',entry.abort);
    if(entry.cancelled)return;if(ok)entry.resolve(value);else entry.reject(value);
  }
  #data(chunk:Buffer):void{
    if(this.#fatal)return;
    if(this.#buffer.length+chunk.length>262144){this.#terminate('DSH_BACKEND_OUTPUT_LIMIT');return;}
    this.#buffer=Buffer.concat([this.#buffer,chunk]);
    for(;;){const at=this.#buffer.indexOf(10);if(at<0)break;
      if(at>131072){this.#terminate('DSH_BACKEND_OUTPUT_LIMIT');return;}
      const line=this.#buffer.subarray(0,at);this.#buffer=this.#buffer.subarray(at+1);
      try{
        const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));
        if(!frame||typeof frame!=='object'||frame.version!==1)fail('DSH_BACKEND_PROTOCOL');
        if(frame.host!==undefined){if(frame.host!=='launcher'||frame.error!==undefined||!['STARTED_WAITING_BOOT','STOP_REQUESTED'].includes(frame.phase))fail('DSH_BACKEND_PROTOCOL');continue;}
        if(frame.id==='host-boot'&&!this.#sessionId){
          const status=frame.result;
          if(frame.ok!==true||!status||typeof status.sessionId!=='string'||status.paused!==true||status.available!==false
            ||status.maxCalls!==this.#expectedBudget||status.requests?.total!==0)fail('DSH_BACKEND_BOOT_FAILED');
          this.#sessionId=status.sessionId;clearTimeout(this.#bootTimer);this.#bootResolve();continue;
        }
        if(frame.event==='stopped'){
          this.#coreStopped=true;this.#coreStatus=frame.status==='closed'&&!frame.rawCallsActive&&!frame.rawTransportActive&&!frame.rawNeuralActive?'closed':'partial';continue;
        }
        if(frame.event==='delivery-ready'){
          if(frame.sessionId!==this.#sessionId||typeof frame.deliveryId!=='string')fail('DSH_BACKEND_PROTOCOL');
          for(const callback of this.#prepared)try{callback(frame.deliveryId);}catch{/* isolated native consumer */}continue;
        }
        if(frame.event==='scheduler-error')continue;
        if(typeof frame.id!=='string'||!this.#pending.has(frame.id)||typeof frame.ok!=='boolean')fail('DSH_BACKEND_PROTOCOL');
        if(frame.ok)this.#settle(frame.id,true,frame.result);
        else{
          const code=frame.error?.code;
          this.#settle(frame.id,false,new CoreError(typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?code:'DSH_BACKEND_REJECTED'));
        }
      }catch{this.#terminate('DSH_BACKEND_PROTOCOL');return;}
    }
    if(this.#buffer.length>131072)this.#terminate('DSH_BACKEND_OUTPUT_LIMIT');
  }
  command(command:string,fields:Record<string,unknown>={},signal?:AbortSignal):Promise<any>{
    if(this.#closed||this.#fatal||!this.#sessionId)return Promise.reject(this.#fatal??new CoreError('DSH_BACKEND_CLOSED'));
    const control=['pause','stop','status'].includes(command);
    if(this.#closing&&!control)return Promise.reject(new CoreError('DSH_BACKEND_CLOSING'));
    if(signal?.aborted)return Promise.reject(new CoreError('DSH_CANCELLED'));
    if(this.#pending.size>=(control?8:6))return Promise.reject(new CoreError('DSH_BACKEND_BACKPRESSURE'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#terminate('DSH_BACKEND_COMMAND_TIMEOUT');},command==='submit'?35000:command==='switch'?70000:5000);
      const entry:Pending={resolve,reject,timer,signal,cancelled:false,abort:()=>{entry.cancelled=true;reject(new CoreError('DSH_CANCELLED'));}};
      this.#pending.set(id,entry);signal?.addEventListener('abort',entry.abort,{once:true});
      this.#write({...fields,id,command,...(control?{}:{sessionId:this.#sessionId})});
    });
  }
  close():Promise<DshBackendClose>{
    if(this.#closePromise)return this.#closePromise;this.#closing=true;
    this.#closePromise=(async()=>{
      if(!this.#closed){
        try{await this.command('pause');await this.command('stop');}catch{this.#child.stdin.end();}
        this.#child.stdin.end();const timer=setTimeout(()=>this.#terminate('DSH_BACKEND_CLOSE_TIMEOUT'),25000);
        await this.#closedPromise;clearTimeout(timer);
      }
      return {closed:true,graceful:this.#coreStopped&&this.#coreStatus==='closed'&&!this.#fatal&&!this.#forced
        &&this.#exitCode===0&&this.#exitSignal===null&&this.#buffer.length===0,
        exitCode:this.#exitCode,signal:this.#exitSignal,forced:this.#forced,residualBytes:this.#buffer.length,coreStatus:this.#coreStatus};
    })();return this.#closePromise;
  }
}
