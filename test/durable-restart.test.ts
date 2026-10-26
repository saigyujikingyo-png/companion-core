import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

type Frame={id?:string;ok?:boolean;result?:any;error?:{code:string};event?:string};
const DEADLINE_MS=2000;
function childHost(){
  const child:ChildProcessWithoutNullStreams=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/durable-stdio-synthetic.ts',import.meta.url))],
    {stdio:'pipe',windowsHide:true});
  let buffer='',serial=0,stderrBytes=0;
  const frames:Frame[]=[],pending=new Map<string,{resolve:(value:Frame)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const closed=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;});
  child.stdout.on('data',(chunk:Buffer)=>{
    buffer+=chunk.toString('utf8');for(;;){const at=buffer.indexOf('\n');if(at<0)break;
      const frame=JSON.parse(buffer.slice(0,at)) as Frame;buffer=buffer.slice(at+1);frames.push(frame);
      if(frame.id){const entry=pending.get(frame.id);if(entry){pending.delete(frame.id);clearTimeout(entry.timer);entry.resolve(frame);}}
    }
  });
  const send=(command:string,extra:Record<string,unknown>={})=>{
    const id=`offline-${++serial}`;
    return new Promise<Frame>((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`OFFLINE_COMMAND_TIMEOUT:${command}`));},DEADLINE_MS);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,command,...extra})+'\n');
    });
  };
  return {child,closed,frames,send,get stderrBytes(){return stderrBytes;},async stop(){
    const frame=await send('stop');assert.equal(frame.ok,true);assert.equal(frame.result.status,'closed');
    const exit=await Promise.race([closed,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('OFFLINE_EXIT_TIMEOUT')),DEADLINE_MS);timer.unref();})]);
    assert.equal(exit.code,0);assert.equal(exit.signal,null);assert.equal(buffer.length,0);
  },async force(){child.kill();
    await Promise.race([closed,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('OFFLINE_CLEANUP_TIMEOUT')),DEADLINE_MS);timer.unref();})]);
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('OFFLINE_CLEANUP'));}pending.clear();}};
}

test('offline real stdin child: A/B, pause/C, restore/D, revoke A, second restore preserves quota and revocation',{timeout:15000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'companion-revoke-restart-'));
  const persistence={directory,identity:'SYNTHETIC_REVOKE_RESTART',keyBase64:randomBytes(32).toString('base64')};
  const evidence:Array<Record<string,unknown>>=[];let host:ReturnType<typeof childHost>|undefined;
  const boot=async(expected:number)=>{
    host=childHost();const started=performance.now();
    const frame=await host.send('boot',{maxCalls:8,apiKey:'SYNTHETIC_OFFLINE_NOT_A_CREDENTIAL',persistence});
    evidence.push({phase:'boot',ok:frame.ok,code:frame.error?.code,elapsedMs:performance.now()-started,expected,stderrBytes:host.stderrBytes});
    assert.equal(frame.ok,true);assert.equal(frame.result.requests.total,expected);assert.equal(frame.result.paused,true);assert.equal(frame.result.available,false);
    return frame.result.sessionId as string;
  };
  const activate=async(sessionId:string)=>{
    assert.equal((await host!.send('resume',{sessionId})).ok,true);
    assert.equal((await host!.send('context',{sessionId,quiet:false,available:true,ttlMs:30000})).ok,true);
  };
  const turn=async(sessionId:string,messageId:string,selectedText:string,feedback?:{deliveryId:string;outcome:'engaged'})=>{
    const submit=await host!.send('submit',{sessionId,messageId,selectedText,recallQuery:'violet',...(feedback?{feedback}:{})});assert.equal(submit.ok,true);
    const taken=await host!.send('take',{sessionId,deliveryId:submit.result.deliveryId});assert.equal(taken.ok,true);
    assert.equal((await host!.send('ack',{sessionId,deliveryId:submit.result.deliveryId})).ok,true);
    const status=await host!.send('status');assert.equal(status.ok,true);
    evidence.push({phase:messageId,calls:status.result.requests.total,source:status.result.lastSourceRef,memory:status.result.lastMemoryRef,
      recalled:taken.result.recall.map((r:any)=>r.ref),state:status.result.background?.attentionPrior});
    return {deliveryId:submit.result.deliveryId as string,source:status.result.lastSourceRef,memory:status.result.lastMemoryRef,taken:taken.result};
  };
  try {
    let token=await boot(0);await activate(token);const a=await turn(token,'A','SYNTHETIC violet preference A');
    const b=await turn(token,'B','SYNTHETIC violet feedback B',{deliveryId:a.deliveryId,outcome:'engaged'});
    assert.equal((await host!.send('pause')).ok,true);
    const blocked=await host!.send('submit',{sessionId:token,messageId:'paused-attempt',selectedText:'SYNTHETIC should not call'});
    assert.equal(blocked.error?.code,'SESSION_PAUSED');await activate(token);const c=await turn(token,'C','SYNTHETIC violet source C');
    await host!.stop();host=undefined;
    const old=token;token=await boot(3);assert.notEqual(token,old);await activate(token);
    const d=await turn(token,'D','SYNTHETIC violet restored D');assert.ok(d.taken.recall.some((r:any)=>r.ref.id===a.memory.id));
    assert.equal((await host!.send('pause')).ok,true);
    const revoked=await host!.send('revoke',{sessionId:token,ref:a.source});assert.equal(revoked.ok,true);assert.equal(revoked.result.status.invalidated,true);
    await host!.stop();host=undefined;
    const previous=token;token=await boot(4);assert.notEqual(token,previous);await activate(token);
    const e=await turn(token,'E-offline-only','SYNTHETIC violet post-revoke E');
    assert.equal(e.taken.recall.some((r:any)=>[a.memory.id,a.source.id].includes(r.ref.id)),false);
    assert.equal(e.taken.sourceRefs.some((r:any)=>[a.memory.id,a.source.id].includes(r.id)),false);
    for(const sibling of [b,c,d])assert.ok(e.taken.recall.some((r:any)=>r.ref.id===sibling.memory.id));
    await host!.stop();host=undefined;
  } finally {
    if(host)await host.force();writeFileSync(join(directory,'offline-reproduction.json'),JSON.stringify({version:1,deadlineMs:DEADLINE_MS,realModelCalls:0,evidence},null,2));
    t.diagnostic(JSON.stringify({syntheticEvidence:join(directory,'offline-reproduction.json'),deadlineMs:DEADLINE_MS,realModelCalls:0,
      phases:evidence.map(({phase,ok,code,elapsedMs,calls})=>({phase,ok,code,elapsedMs,calls}))}));
  }
});
