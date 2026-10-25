import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { CoreError, fail } from './validation.ts';
import { validatePrior } from './interaction.ts';
import type { Prior, PriorAdapter } from './interaction.ts';

export type JsonlPriorConfig = { pythonPath:string; workerPath:string; workerSha256:string; graphPath:string;
  graphSha256:string; structuralSha256:string; condition?:'real'|'no-circuit'; startupTimeoutMs?:number; eventTimeoutMs?:number };
export type PriorCloseResult = {closed:true;graceful:boolean;exitCode:number|null;signal:string|null;forced:boolean;residualBytes:number};
type Waiter = {id:string; resolve:(value:Record<string,unknown>)=>void;reject:(error:unknown)=>void;
  timer:ReturnType<typeof setTimeout>;signal:AbortSignal;cancel:()=>void};

/** Event-driven child transport. Abort/deadline kills this owned worker; its
 * promise settles only on child close, preserving the shared raw neural permit. */
export class JsonlPriorAdapter implements PriorAdapter {
  static #resident = false;
  readonly manifest: PriorAdapter['manifest'];
  readonly details: Readonly<Record<string,unknown>>;
  readonly #process: ChildProcessWithoutNullStreams; readonly #duration: number;
  #buffer = Buffer.alloc(0); #stderr = 0; #count = 0; #closed = false; #fatal: CoreError | null = null;
  #pending: Waiter | null = null; #closedPromise: Promise<void>; #closeResolve!:()=>void;
  #exitCode:number|null=null; #exitSignal:string|null=null; #forced=false; #stopAck=false;
  private constructor(child:ChildProcessWithoutNullStreams, manifest:Record<string,unknown>, duration:number) {
    this.#process=child;this.#duration=duration;
    this.manifest=Object.freeze({implementation:manifest.implementation as string,sourceHash:manifest.sourceHash as string,biologicalClaim:'none'});
    this.details=Object.freeze(structuredClone(manifest));
    this.#closedPromise=new Promise(resolve=>{this.#closeResolve=resolve;});
    child.stdout.on('data',(chunk:Buffer)=>this.#onData(chunk));
    child.stderr.on('data',(chunk:Buffer)=>{this.#stderr+=chunk.length;if(this.#stderr>8192)this.#terminate('NEURAL_STDERR_LIMIT');});
    child.on('error',()=>this.#terminate('NEURAL_PROCESS_ERROR'));
    child.on('close',(code:number|null,signal:string|null)=>{this.#closed=true;this.#exitCode=code;this.#exitSignal=signal;
      if(this.#buffer.length)this.#fatal??=new CoreError('NEURAL_PARTIAL_OUTPUT');
      if(this.#pending)this.#finish(false,this.#fatal??new CoreError('NEURAL_PROCESS_CLOSED'));
      this.#closeResolve();});
  }
  static async start(config:JsonlPriorConfig, dependencies: {spawn?:typeof spawn} = {}):Promise<JsonlPriorAdapter> {
    if(![config.pythonPath,config.workerPath,config.graphPath].every(isAbsolute)
      || ![config.workerSha256,config.graphSha256,config.structuralSha256].every(x=>/^[a-f0-9]{64}$/.test(x)))fail('INVALID_NEURAL_CONFIG');
    const duration=config.eventTimeoutMs??5_000,startup=config.startupTimeoutMs??60_000;
    if(!Number.isSafeInteger(duration)||duration<1||duration>5_000||!Number.isSafeInteger(startup)||startup<1||startup>120_000)fail('INVALID_NEURAL_CONFIG');
    if(createHash('sha256').update(await readFile(config.workerPath)).digest('hex')!==config.workerSha256)fail('NEURAL_SOURCE_MISMATCH');
    const condition=config.condition??'real';if(!['real','no-circuit'].includes(condition))fail('INVALID_NEURAL_CONFIG');
    if(JsonlPriorAdapter.#resident)fail('NEURAL_RESIDENT_LIMIT');JsonlPriorAdapter.#resident=true;
    let child:ChildProcessWithoutNullStreams;
    try { child=(dependencies.spawn??spawn)(config.pythonPath,['-B','-u',config.workerPath,'--graph',config.graphPath,'--graph-sha256',config.graphSha256,
      '--structural-sha256',config.structuralSha256,'--condition',condition],{windowsHide:true,stdio:'pipe'}); }
    catch(error){JsonlPriorAdapter.#resident=false;throw error;}
    child.once('close',()=>{JsonlPriorAdapter.#resident=false;});
    const ready=await new Promise<JsonlPriorAdapter>((resolve,reject)=>{
      let buffer=Buffer.alloc(0),stderr=0,done=false,error:CoreError|null=null;
      const terminate=(code:string)=>{if(done)return;error=new CoreError(code);child.kill();};
      const timer=setTimeout(()=>terminate('NEURAL_READY_TIMEOUT'),startup);
      const cleanup=()=>{clearTimeout(timer);child.stdout.removeListener('data',data);child.stderr.removeListener('data',err);
        child.removeListener('error',failed);child.removeListener('close',closed);};
      const failed=()=>terminate('NEURAL_PROCESS_ERROR');
      const closed=()=>{if(done)return;done=true;cleanup();reject(error??new CoreError('NEURAL_READY_FAILED'));};
      const err=(part:Buffer)=>{stderr+=part.length;if(stderr>8192)terminate('NEURAL_STDERR_LIMIT');};
      const data=(part:Buffer)=>{
        if(done||error)return;buffer=Buffer.concat([buffer,part]);if(buffer.length>16384){terminate('NEURAL_STDOUT_LIMIT');return;}
        const newline=buffer.indexOf(10);if(newline<0)return;
        try{
          if(newline!==buffer.length-1)fail('NEURAL_UNEXPECTED_OUTPUT');
          const record=JSON.parse(buffer.subarray(0,newline).toString('utf8'));
          const m=record.manifest;
          if(record.version!==1||record.event!=='ready'||!m||m.implementation!=='flywire-prior-jsonl-v1'||m.sourceHash!==config.workerSha256
            ||m.biologicalClaim!=='none'||m.device!=='cpu'||m.nodes!==3136||m.condition!==condition
            ||m.graphSha256!==config.graphSha256||m.structuralSha256!==config.structuralSha256)fail('NEURAL_READY_INVALID');
          // Install the lasting owner synchronously BEFORE detaching handshake
          // listeners. There is no await/ownerless ready-to-close interval.
          const adapter=new JsonlPriorAdapter(child,m,duration);
          done=true;cleanup();resolve(adapter);
        }catch{terminate('NEURAL_READY_INVALID');}
      };
      child.stdout.on('data',data);child.stderr.on('data',err);child.on('error',failed);child.on('close',closed);
    });
    if(ready.#closed||ready.#fatal){
      // A failed start never hands ownership to its caller. Keep ownership until
      // actual close even if post-ready output triggered a delayed termination.
      await ready.#closedPromise;throw ready.#fatal??new CoreError('NEURAL_READY_CLOSED');
    }
    return ready;
  }
  #terminate(code:string):void {
    if(this.#closed)return;this.#fatal??=new CoreError(code);if(this.#process.kill())this.#forced=true;
  }
  #finish(ok:boolean,value:unknown):void {
    const pending=this.#pending;if(!pending)return;this.#pending=null;
    clearTimeout(pending.timer);pending.signal.removeEventListener('abort',pending.cancel);
    if(ok)pending.resolve(value as Record<string,unknown>);else pending.reject(value);
  }
  #onData(chunk:Buffer):void {
    if(this.#fatal)return;this.#buffer=Buffer.concat([this.#buffer,chunk]);
    if(this.#buffer.length>16384){this.#terminate('NEURAL_STDOUT_LIMIT');return;}
    const newline=this.#buffer.indexOf(10);if(newline<0)return;
    try{
      if(newline!==this.#buffer.length-1)fail('NEURAL_UNEXPECTED_OUTPUT');
      const record=JSON.parse(this.#buffer.subarray(0,newline).toString('utf8'));this.#buffer=Buffer.alloc(0);
      if(!this.#pending||record.version!==1||record.id!==this.#pending.id||!['result','reset','stopped'].includes(record.event))fail('NEURAL_PROTOCOL');
      this.#finish(true,record);
    }catch{this.#terminate('NEURAL_PROTOCOL');}
  }
  #request(command:'step'|'reset'|'stop',signal:AbortSignal,extra:Record<string,unknown>={}):Promise<Record<string,unknown>> {
    if(this.#closed||this.#fatal)return Promise.reject(this.#fatal??new CoreError('NEURAL_PROCESS_CLOSED'));
    if(this.#pending)return Promise.reject(new CoreError('NEURAL_BUSY'));
    if(signal.aborted)return Promise.reject(new CoreError('NEURAL_ABORTED'));
    if(this.#count>=255)return Promise.reject(new CoreError('NEURAL_SESSION_CAPACITY'));this.#count++;
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),cancel=()=>this.#terminate('NEURAL_ABORTED');
      const timer=setTimeout(()=>this.#terminate('NEURAL_DEADLINE'),this.#duration);
      this.#pending={id,resolve,reject,timer,signal,cancel};signal.addEventListener('abort',cancel,{once:true});
      const payload=JSON.stringify({version:1,id,command,maxMs:this.#duration,...extra})+'\n';
      if(Buffer.byteLength(payload)>4096){this.#terminate('NEURAL_INPUT_LIMIT');return;}
      this.#process.stdin.write(payload,error=>{if(error)this.#terminate('NEURAL_STDIN_ERROR');});
    });
  }
  async step(input:{dtMs:number;features:Prior;signal:AbortSignal}):Promise<Prior> {
    if(!Number.isFinite(input.dtMs)||input.dtMs<0||input.dtMs>300_000)fail('INVALID_NEURAL_DT');
    const result=await this.#request('step',input.signal,{dtMs:input.dtMs,features:validatePrior(input.features)});
    if(result.event!=='result'){this.#terminate('NEURAL_PROTOCOL');await this.#closedPromise;fail('NEURAL_PROTOCOL');}
    try{return validatePrior(result.prior as Prior);}catch(error){this.#terminate('NEURAL_PROTOCOL');await this.#closedPromise;throw error;}
  }
  async reset():Promise<void> {
    const result=await this.#request('reset',new AbortController().signal);
    if(result.event!=='reset'){this.#terminate('NEURAL_PROTOCOL');await this.#closedPromise;fail('NEURAL_PROTOCOL');}
  }
  async close():Promise<PriorCloseResult> {
    if(!this.#closed){
      if(this.#fatal||this.#pending)this.#terminate('NEURAL_STOP_REQUESTED');
      else try {
        const response=await this.#request('stop',new AbortController().signal);
        if(response.event==='stopped')this.#stopAck=true;else this.#terminate('NEURAL_STOP_ACK_INVALID');
      } catch { /* Closed/failed request is cleanup, not graceful-stop proof. */ }
      const timer=setTimeout(()=>this.#terminate('NEURAL_STOP_TIMEOUT'),this.#duration);
      await this.#closedPromise;clearTimeout(timer);
    }
    return {closed:true,graceful:this.#stopAck&&!this.#fatal&&!this.#forced&&this.#exitCode===0&&this.#exitSignal===null&&this.#buffer.length===0,
      exitCode:this.#exitCode,signal:this.#exitSignal,forced:this.#forced,residualBytes:this.#buffer.length};
  }
}
