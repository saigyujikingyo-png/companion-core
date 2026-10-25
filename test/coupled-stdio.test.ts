import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTrustedStdio } from '../src/coupled-stdio.ts';
import type { TrustedStdioOptions } from '../src/coupled-stdio.ts';
import type { InteractionRequest, InteractionResponse } from '../src/interaction.ts';
const response:InteractionResponse={version:1,responseText:'SYNTHETIC_REPLY_ONLY_ON_TAKE',appraisal:{kind:'appraisal-hypothesis',confidence:0,
  valence:0,arousal:0,uncertainty:0,fatigue:0},memoryProposal:null};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const neuralConfig={pythonPath:'C:\\synthetic\\python.exe',workerPath:'C:\\synthetic\\worker.py',workerSha256:'a'.repeat(64),
  graphPath:'C:\\synthetic\\graph.npz',graphSha256:'b'.repeat(64),structuralSha256:'c'.repeat(64)};
function fakePrior(onClose=()=>{},graceful=true){return {manifest:{implementation:'synthetic',sourceHash:'d'.repeat(64),biologicalClaim:'none' as const},
  step:async()=>({social:.2,novelty:.1,disengagement:0}),reset:async()=>{},close:async()=>{onClose();return {
    closed:true as const,graceful,exitCode:graceful?0:1,signal:null,forced:false,residualBytes:0};}};}
function fixture(t:TestContext,options:Partial<TrustedStdioOptions>={}){
  const input=new PassThrough(),output=new PassThrough();let buffer='',serial=0;
  const frames:any[]=[],waiting:Array<{predicate:(frame:any)=>boolean;resolve:(frame:any)=>void}>=[];
  output.on('data',(chunk:Buffer)=>{buffer+=chunk.toString('utf8');for(;;){const at=buffer.indexOf('\n');if(at<0)break;
    const frame=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);frames.push(frame);
    for(let i=waiting.length-1;i>=0;i--)if(waiting[i]!.predicate(frame)){waiting.splice(i,1)[0]!.resolve(frame);}
  }});
  const run=runTrustedStdio({input,output,...options});t.after(async()=>{input.end();await run;});
  const wait=(predicate:(frame:any)=>boolean)=>{const prior=frames.find(predicate);if(prior)return Promise.resolve(prior);
    return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('synthetic protocol wait timeout')),2000);
      waiting.push({predicate,resolve:frame=>{clearTimeout(timer);resolve(frame);}});});};
  const send=(command:string,extra:Record<string,unknown>={},id=`command-${++serial}`)=>{
    input.write(JSON.stringify({id,command,...extra})+'\n');return wait(frame=>frame.id===id);
  };
  return {input,output,frames,run,send,wait};
}
async function activate(h:ReturnType<typeof fixture>,maxCalls=4,extra:Record<string,unknown>={}){
  const boot=await h.send('boot',{maxCalls,...(maxCalls>0?{apiKey:'SYNTHETIC_KEY_DO_NOT_ECHO'}:{}),...extra});assert.equal(boot.ok,true);
  const sessionId=boot.result.sessionId;
  assert.equal((await h.send('context',{sessionId,quiet:false,available:true,ttlMs:30000})).ok,true);
  assert.equal((await h.send('resume',{sessionId})).ok,true);return sessionId;
}
test('zero-call boot needs no key/provider and cannot be upgraded by stdin commands',async t=>{
  let factories=0;const h=fixture(t,{providerFactory:()=>{factories++;throw new Error('must not construct HTTP');}});
  const sessionId=await activate(h,0);const status=await h.send('status');assert.equal(status.result.requestsEnabled,false);
  assert.equal((await h.send('submit',{sessionId,messageId:'one',selectedText:'synthetic'})).error.code,'BUDGET_DISABLED');
  assert.equal((await h.send('boot',{maxCalls:4,apiKey:'SYNTHETIC_KEY_DO_NOT_ECHO'})).error.code,'ALREADY_BOOTED');
  assert.equal(factories,0);assert.equal(JSON.stringify(h.frames).includes('SYNTHETIC_KEY'),false);
  const stopped=await h.send('stop');assert.equal(stopped.result.status,'closed');assert.equal((await h.run).outputFlushed,true);
});
test('submit metadata omits text; take and ACK are explicit; same message ID cannot call twice',async t=>{
  let calls=0;const h=fixture(t,{providerFactory:(_config,resources)=>({interact:async()=>{resources.budget.reserve();calls++;return response;}})});
  const sessionId=await activate(h);
  const one=await h.send('submit',{sessionId,messageId:'native-one',selectedText:'SYNTHETIC_SELECTED_PRIVATE'});
  assert.equal(one.ok,true);assert.equal(JSON.stringify(h.frames).includes('SYNTHETIC_SELECTED_PRIVATE'),false);
  assert.equal(JSON.stringify(h.frames).includes(response.responseText),false);
  const duplicate=await h.send('submit',{sessionId,messageId:'native-one',selectedText:'SYNTHETIC_SELECTED_PRIVATE'});
  assert.equal(duplicate.result.deliveryId,one.result.deliveryId);assert.equal(calls,1);
  assert.equal((await h.send('ack',{sessionId,deliveryId:one.result.deliveryId})).error.code,'DELIVERY_NOT_TAKEN');
  const taken=await h.send('take',{sessionId,deliveryId:one.result.deliveryId});assert.equal(taken.result.text,response.responseText);
  assert.equal((await h.send('take',{sessionId,deliveryId:one.result.deliveryId})).error.code,'DELIVERY_ALREADY_CONSUMED');
  assert.equal((await h.send('ack',{sessionId,deliveryId:one.result.deliveryId})).result.status,'acknowledged');
  assert.equal(JSON.stringify(h.frames).includes('SYNTHETIC_KEY'),false);
});
test('pause and status remain responsive while noncooperative provider is in flight',async t=>{
  const late=deferred<InteractionResponse>(),started=deferred<void>();let calls=0;
  const h=fixture(t,{providerFactory:(_config,resources)=>({interact:async()=>{resources.budget.reserve();calls++;started.resolve();return late.promise;}})});
  const sessionId=await activate(h);const pending=h.send('submit',{sessionId,messageId:'one',selectedText:'synthetic'});await started.promise;
  assert.equal((await h.send('status')).result.submitting,true);assert.equal((await h.send('pause')).result.paused,true);
  assert.equal((await pending).ok,false);assert.equal(calls,1);late.resolve(response);await tick();
  assert.equal(h.frames.filter(frame=>frame.event==='delivery-ready').length,0);
});
test('host heartbeat expiry blocks interaction and never manufactures another availability lease',async t=>{
  let now=0,calls=0;const h=fixture(t,{clock:()=>now,providerFactory:()=>({interact:async()=>{calls++;return response;}})});
  const sessionId=await activate(h);now=30000;
  assert.equal((await h.send('status')).result.available,false);
  assert.equal((await h.send('submit',{sessionId,messageId:'expired',selectedText:'synthetic'})).error.code,'HOST_CONTEXT_BLOCKED');assert.equal(calls,0);
  assert.equal((await h.send('context',{sessionId,quiet:false,available:true,ttlMs:30001})).error.code,'INVALID_INPUT');
});
test('EOF cancels local wait and reports unresolved raw provider honestly',async t=>{
  const late=deferred<InteractionResponse>(),started=deferred<void>();
  const h=fixture(t,{providerFactory:()=>({interact:async()=>{started.resolve();return late.promise;}})});
  const sessionId=await activate(h);const pending=h.send('submit',{sessionId,messageId:'one',selectedText:'synthetic'});await started.promise;
  h.input.end();const exit=await h.run;assert.equal(exit.status,'partial');assert.equal(exit.rawCallsActive,true);assert.equal((await pending).ok,false);
  late.resolve(response);await tick();
});
test('stop during asynchronous worker startup harvests and closes the late adapter before final exit',async t=>{
  const started=deferred<void>(),worker=deferred<ReturnType<typeof fakePrior>>();let closes=0;
  const h=fixture(t,{priorFactory:async()=>{started.resolve();return worker.promise;}});const sessionId=await activate(h,0,{neuralConfig});
  const switching=h.send('switch',{sessionId,backend:'flywire'});await started.promise;
  assert.equal((await h.send('status')).result.managementBusy,true);assert.equal((await h.send('pause')).result.paused,true);
  const stop=h.send('stop');let ended=false;void h.run.then(()=>{ended=true;});await tick();assert.equal(ended,false);
  worker.resolve(fakePrior(()=>{closes++;}));assert.equal((await switching).ok,false);assert.equal((await stop).result.status,'closed');
  assert.equal(closes,1);assert.equal((await h.run).workerCloses.length,1);
});
test('switch retires and closes the only worker; bad close remains partial and is not replaced automatically',async t=>{
  let starts=0,closes=0;const h=fixture(t,{priorFactory:async()=>{starts++;return fakePrior(()=>{closes++;},false);}});
  const sessionId=await activate(h,0,{neuralConfig});const switched=await h.send('switch',{sessionId,backend:'flywire'});
  assert.equal(switched.ok,true);assert.equal(switched.result.paused,true);
  const back=await h.send('switch',{sessionId,backend:'baseline'});assert.equal(back.error.code,'NEURAL_CLOSE_PARTIAL');
  assert.equal(starts,1);assert.equal(closes,1);const stop=await h.send('stop');assert.equal(stop.result.status,'partial');
});
test('purge works while paused and permanently invalidates this session without automatic rebind',async t=>{
  const h=fixture(t);const sessionId=await activate(h,0);await h.send('pause');assert.equal((await h.send('purge',{sessionId})).ok,true);
  assert.equal((await h.send('resume',{sessionId})).error.code,'SESSION_REBIND_REQUIRED');
});
for(const stream of ['input','output'] as const)test(`${stream} close without end/error still cleans up the owned worker`,async t=>{
  let closes=0;const h=fixture(t,{priorFactory:async()=>fakePrior(()=>{closes++;})});
  const sessionId=await activate(h,0,{neuralConfig});assert.equal((await h.send('switch',{sessionId,backend:'flywire'})).ok,true);
  h[stream].destroy();const exit=await h.run;assert.equal(exit.status,'partial');assert.equal(closes,1);
  assert.equal(exit.reason,stream==='input'?'stdin-close':'stdout-close');
});
test('oversized/truncated boot never echoes data and closes without creating a provider',async t=>{
  let factories=0;const h=fixture(t,{providerFactory:()=>{factories++;throw new Error('must not run');}});
  h.input.write('SYNTHETIC_SECRET'.repeat(3000));const exit=await h.run;assert.equal(exit.status,'partial');assert.equal(factories,0);
  assert.equal(JSON.stringify(h.frames).includes('SYNTHETIC_SECRET'),false);
});
test('stdout backpressure is bounded and ends the host instead of queuing unlimited replies',async()=>{
  const input=new PassThrough(),output=new Writable({write(_chunk,_encoding,_callback){/* deliberately blocked */}});
  const run=runTrustedStdio({input,output});input.write(JSON.stringify({id:'boot',command:'boot',maxCalls:0})+'\n');
  for(let i=0;i<1000;i++)input.write(JSON.stringify({id:`s${i}`,command:'status'})+'\n');
  const exit=await run;assert.equal(exit.status,'partial');assert.equal(exit.reason,'stdout-backpressure');assert.equal(exit.outputFlushed,false);input.destroy();output.destroy();
});
test('error after final write callback but before flush continuation makes shutdown partial',async()=>{
  const input=new PassThrough();let reported=false;
  const output=new Writable({write(chunk,_encoding,callback){const frame=JSON.parse(chunk.toString());callback();
    if(frame.event==='stopped')process.nextTick(()=>{reported=true;output.emit('error',new Error('synthetic final transport error'));});}});
  const run=runTrustedStdio({input,output});input.write(JSON.stringify({id:'boot',command:'boot',maxCalls:0})+'\n');
  input.write(JSON.stringify({id:'stop',command:'stop'})+'\n');const result=await run;
  assert.equal(reported,true);assert.equal(result.status,'partial');assert.equal(result.outputFlushed,false);input.destroy();output.destroy();
});
test('real stdio CLI supports zero-key zero-request boot/status/stop and exits zero',async()=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/coupled-stdio.ts',import.meta.url))],{stdio:'pipe',windowsHide:true});
  let output='';child.stdout.on('data',part=>{output+=part.toString();});child.stderr.resume();
  const closed=new Promise<number|null>(resolve=>child.on('close',code=>resolve(code)));
  child.stdin.end([{id:'b',command:'boot',maxCalls:0},{id:'s',command:'status'},{id:'x',command:'stop'}].map(v=>JSON.stringify(v)).join('\n')+'\n');
  assert.equal(await closed,0);const frames=output.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(frames.find(x=>x.id==='b').result.paused,true);assert.equal(frames.find(x=>x.id==='s').result.requests.total,0);
  assert.equal(frames.find(x=>x.id==='x').result.status,'closed');assert.ok(frames.some(x=>x.event==='stopped'));
});
