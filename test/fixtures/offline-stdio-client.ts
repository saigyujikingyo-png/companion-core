import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type Frame={id?:string;ok?:boolean;result?:any;error?:{code:string};event?:string};
// Functional-test watchdogs mirror the existing host RPC allowance. They do not
// alter provider deadlines, permission leases or durable-operation ordering.
export const OFFLINE_WATCHDOGS=Object.freeze({boot:30_000,submit:35_000,other:5_000,exit:5_000,cleanup:5_000});
export const OFFLINE_CASE_WATCHDOG_MS=240_000;
type Watchdogs={ [K in keyof typeof OFFLINE_WATCHDOGS]:number };
export type OfflineDiagnostic={event:string;id?:string;command?:string;elapsedMs?:number;watchdogMs?:number;ok?:boolean;
  stdoutBytes:number;stderrBytes:number;pending:number;exitCode?:number|null;signal?:string|null};
export class OfflineClientError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.name='OfflineClientError';this.code=code;}
}
type Pending={id:string;command:string;started:number;watchdogMs:number;timer:ReturnType<typeof setTimeout>;
  resolve:(frame:Frame)=>void;reject:(error:Error)=>void};
const MAX_BUFFER=262_144,MAX_DIAGNOSTICS=256;

/** Small parent-owned test client. A terminal failure never permits another send
 * or accepts a late reply. Diagnostics contain transport metadata, never bodies. */
export class OfflineStdioClient {
  readonly #child:ChildProcessWithoutNullStreams;readonly #watchdogs:Watchdogs;
  #buffer='';#decoder=new StringDecoder('utf8');#serial=0;#stdoutBytes=0;#stderrBytes=0;#pending=new Map<string,Pending>();
  #diagnostics:OfflineDiagnostic[]=[];#failure:OfflineClientError|null=null;#stopping=false;#killRequested=false;
  #exit:{code:number|null;signal:string|null}|null=null;
  #closed:Promise<{code:number|null;signal:string|null}>;
  constructor(child:ChildProcessWithoutNullStreams,watchdogs:Watchdogs=OFFLINE_WATCHDOGS) {
    for(const value of Object.values(watchdogs))if(!Number.isSafeInteger(value)||value<1||value>240_000)throw new OfflineClientError('OFFLINE_INVALID_WATCHDOG');
    this.#child=child;this.#watchdogs={...watchdogs};
    this.#closed=new Promise(resolve=>child.once('close',(code,signal)=>{
      this.#exit={code,signal};resolve(this.#exit);
      this.#buffer+=this.#decoder.end();
      if(this.#pending.size)this.#fail('OFFLINE_CHILD_CLOSED');
      else if(this.#buffer.length)this.#fail('OFFLINE_TRUNCATED_OUTPUT');
      else if(!this.#stopping||code!==0||signal!==null)this.#fail('OFFLINE_CHILD_EXIT');
      this.#record('close');
    }));
    child.once('error',()=>this.#fail('OFFLINE_CHILD_ERROR'));
    child.stdin.on('error',()=>this.#fail('OFFLINE_STDIN_ERROR'));
    child.stdout.on('error',()=>this.#fail('OFFLINE_STDOUT_ERROR'));
    child.stderr.on('error',()=>this.#fail('OFFLINE_STDERR_ERROR'));
    child.stderr.on('data',(chunk:Buffer)=>{this.#stderrBytes+=chunk.length;});
    child.stdout.on('data',(chunk:Buffer)=>this.#data(chunk));
  }
  get diagnostics():OfflineDiagnostic[] {return structuredClone(this.#diagnostics);}
  get pendingCount():number {return this.#pending.size;}
  get stderrBytes():number {return this.#stderrBytes;}
  #record(event:string,entry?:Pending,ok?:boolean):void {
    if(this.#diagnostics.length===MAX_DIAGNOSTICS)this.#diagnostics.shift();
    this.#diagnostics.push({event,...(entry?{id:entry.id,command:entry.command,elapsedMs:performance.now()-entry.started,watchdogMs:entry.watchdogMs}:{}),
      ...(ok===undefined?{}:{ok}),stdoutBytes:this.#stdoutBytes,stderrBytes:this.#stderrBytes,pending:this.#pending.size,
      ...(this.#exit?{exitCode:this.#exit.code,signal:this.#exit.signal}:{})});
  }
  #kill():void {
    if(this.#exit||this.#killRequested)return;this.#killRequested=true;
    try{this.#child.kill();}catch{/* The bounded cleanup waiter still reports an unclosed child. */}
  }
  #fail(code:string,entry?:Pending):void {
    if(this.#failure)return;this.#failure=new OfflineClientError(code);this.#record(code,entry);this.#buffer='';
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(this.#failure);}
    this.#pending.clear();this.#kill();
  }
  #data(chunk:Buffer):void {
    this.#stdoutBytes+=chunk.length;
    if(this.#failure){this.#record('discarded-output-after-failure');return;}
    this.#buffer+=this.#decoder.write(chunk);
    if(Buffer.byteLength(this.#buffer)>MAX_BUFFER){this.#fail('OFFLINE_OUTPUT_LIMIT');return;}
    for(;;){const at=this.#buffer.indexOf('\n');if(at<0)break;
      let frame:Frame;
      try{const parsed:unknown=JSON.parse(this.#buffer.slice(0,at));
        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();frame=parsed as Frame;
      }catch{this.#fail('OFFLINE_INVALID_FRAME');return;}
      this.#buffer=this.#buffer.slice(at+1);
      if(frame.id===undefined){this.#record('event');continue;}
      if(typeof frame.id!=='string'||typeof frame.ok!=='boolean'){this.#fail('OFFLINE_INVALID_FRAME');return;}
      const entry=this.#pending.get(frame.id);
      if(!entry){this.#record('unmatched-frame');continue;}
      this.#pending.delete(frame.id);clearTimeout(entry.timer);this.#record('reply',entry,frame.ok);entry.resolve(frame);
    }
  }
  send(command:string,extra:Record<string,unknown>={}):Promise<Frame> {
    if(this.#failure||this.#exit||this.#stopping)return Promise.reject(new OfflineClientError('OFFLINE_CLIENT_TERMINAL'));
    if(!/^[a-z][a-z-]{0,31}$/.test(command))return Promise.reject(new OfflineClientError('OFFLINE_INVALID_COMMAND'));
    const id=`offline-${++this.#serial}`,watchdogMs=command==='boot'?this.#watchdogs.boot:command==='submit'?this.#watchdogs.submit:this.#watchdogs.other;
    let line:string;try{line=JSON.stringify({...extra,id,command})+'\n';}catch{return Promise.reject(new OfflineClientError('OFFLINE_INVALID_INPUT'));}
    if(command==='stop')this.#stopping=true;
    return new Promise((resolve,reject)=>{
      const entry:Pending={id,command,started:performance.now(),watchdogMs,resolve,reject,
        timer:setTimeout(()=>this.#fail(`OFFLINE_COMMAND_TIMEOUT:${command}`,entry),watchdogMs)};
      this.#pending.set(id,entry);this.#record('send',entry);
      try{this.#child.stdin.write(line,error=>{if(error)this.#fail('OFFLINE_WRITE_ERROR',entry);});}
      catch{this.#fail('OFFLINE_WRITE_ERROR',entry);}
    });
  }
  async #waitClosed(ms:number,code:string) {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([this.#closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new OfflineClientError(code)),ms);})]);}
    finally{clearTimeout(timer);}
  }
  async stop():Promise<void> {
    const frame=await this.send('stop');
    if(frame.ok!==true||frame.result?.status!=='closed'){this.#fail('OFFLINE_STOP_REFUSED');throw this.#failure;}
    try{await this.#waitClosed(this.#watchdogs.exit,'OFFLINE_EXIT_TIMEOUT');}
    catch(error){this.#fail('OFFLINE_EXIT_TIMEOUT');throw error;}
    if(this.#failure)throw this.#failure;
  }
  async force():Promise<void> {
    if(!this.#exit)this.#fail('OFFLINE_FORCED_CLEANUP');
    try{await this.#waitClosed(this.#watchdogs.cleanup,'OFFLINE_CLEANUP_TIMEOUT');}
    catch(error){this.#record('OFFLINE_CLEANUP_TIMEOUT');throw error;}
  }
}
