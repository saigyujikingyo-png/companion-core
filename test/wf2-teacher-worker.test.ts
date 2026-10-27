import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync,readFileSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveTeacherControl } from '../src/wf2-teacher-worker.ts';
import { runTeacherBridge } from '../src/wf2-teacher-bridge.ts';
import { FIXED_SLOT_STOP_REASONS } from '../src/wf2-fixed-slots.ts';
import type { BoundTeachingRun,TeacherSafeMetadata } from '../src/wf2-teacher-service.ts';
const capability='f6'.repeat(32);
function fixture(){let complete=false,close=0,revocations=0;const run:BoundTeachingRun={run:async()=>{complete=true;},metadata:():TeacherSafeMetadata=>({campaignStatus:complete?'COMPLETED':'ACTIVE',countCompleteness:'CURRENT_AUTHORITY',calls:{deepseek:0,together:0},candidates:{deepseek:0,together:0,qualified:0,quarantined:0},sealed:false,planned:false,manifestFrozen:false,usage:{input:0,completion:0,unknown:0},estimatedReserveMicroUsd:0}),close:()=>{close++;},withdraw:()=>{revocations++;}};
  return {run,get close(){return close;},get revocations(){return revocations;}};
}
function channels(){const input=new PassThrough(),output=new PassThrough();let buffer='',queue:unknown[]=[];const waiters:Array<(v:unknown)=>void>=[];output.setEncoding('utf8');output.on('data',(part:string)=>{buffer+=part;for(let i;(i=buffer.indexOf('\n'))>=0;){const value=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(waiters.length)waiters.shift()!(value);else queue.push(value);}});
  return {input,output,next:()=>queue.length?Promise.resolve(queue.shift()):new Promise<unknown>(resolve=>waiters.push(resolve)),send:(v:unknown)=>input.write(JSON.stringify(v)+'\n')};
}
test('private worker refuses malformed production bootstrap before READY without exposing it',async()=>{
  const c=channels(),session=serveTeacherControl(c.input,c.output);c.send({privateBootstrap:'synthetic-only'});const event=await c.next() as Record<string,unknown>;await session.closed;
  assert.equal(event.type,'refused');assert.equal(event.code,'WF1_FIELDS');assert.ok(!JSON.stringify(event).includes('synthetic-only'));
});
test('worker closed metadata protocol binds completion digest and owner EOF lifecycle',async()=>{
  const c=channels(),f=fixture(),session=serveTeacherControl(c.input,c.output,()=>({run:f.run,capability}));c.send({synthetic:true});assert.deepEqual(await c.next(),{type:'ready',version:'wf2-worker-event/1'});
  c.send({version:1,requestId:'start',operation:'start',capability});assert.equal((await c.next() as {type:string}).type,'reply');const settled=await c.next() as {completion:{digest:string}};
  c.send({version:'wf2-worker-control/1',action:'acknowledge-completed',completionDigest:settled.completion.digest});assert.equal((await c.next() as {type:string}).type,'completion-acknowledged');c.input.end();await session.closed;assert.equal(f.close,1);assert.equal(f.revocations,0);
});
test('worker rejects partial EOF, excessive bytes and capability errors without exposing input',async()=>{
  for(const payload of ['{"private":"unfinished', 'x'.repeat(131073)]){const c=channels(),f=fixture(),session=serveTeacherControl(c.input,c.output,()=>({run:f.run,capability}));c.input.end(payload);const event=await c.next() as Record<string,unknown>;await session.closed;assert.equal(event.type,'refused');assert.ok(!JSON.stringify(event).includes('unfinished'));assert.equal(f.close,0);}
  const c=channels(),f=fixture(),session=serveTeacherControl(c.input,c.output,()=>({run:f.run,capability}));c.send({synthetic:true});await c.next();c.send({version:1,requestId:'a',operation:'start',capability:'0'.repeat(64)});await c.next();await session.closed;assert.equal(f.close,1);assert.equal(f.revocations,1);
});

test('worker stopped v2 takes one terminal snapshot and forces stale diagnostics to unknown',async()=>{
  for(const stale of [false,true]){const c=channels(),f=fixture();let snapshots=0;const session=serveTeacherControl(c.input,c.output,()=>({run:{...f.run,run:async()=>{}},capability,terminal:()=>{snapshots++;return {reason:'UNKNOWN',responseFailureCode:'ARGUMENTS_NATIVE_JSON_INVALID',metadata:stale?{campaignStatus:'RECONCILE_REQUIRED',countCompleteness:'STALE_OR_UNKNOWN',calls:{deepseek:null,together:null},candidates:{deepseek:null,together:null,qualified:null,quarantined:null},sealed:null,planned:null,manifestFrozen:false,usage:{input:null,completion:null,unknown:null},estimatedReserveMicroUsd:null}:{...f.run.metadata(),campaignStatus:'STOPPED'}};}}));
    c.send({synthetic:true});await c.next();c.send({version:1,requestId:'start',operation:'start',capability});await c.next();const event=await c.next() as Record<string,unknown>;assert.equal(event.version,'wf2-worker-event/2');assert.equal(event.type,'stopped');assert.equal(event.responseFailureCode,stale?'UNKNOWN':'ARGUMENTS_NATIVE_JSON_INVALID');assert.equal(snapshots,1);c.input.end();await session.closed;
  }
});
test('actual trusted bridge function connects two synthetic children and records only safe completion',{timeout:10000},async()=>{
  const evidenceRoot=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-bridge-synthetic-'))),workerPath=fileURLToPath(new URL('../scripts/wf2-synthetic-teacher-worker.ts',import.meta.url)),pluginUrl=new URL('../integrations/dsh-teacher-control/index.mjs',import.meta.url).href;
  const fakeDsh=`import {apply} from ${JSON.stringify(pluginUrl)};const disposers=[];const values={cmdlineArgs:{get:()=>['--teacher-control']},appExit:n=>{for(const d of disposers)d();process.exitCode=n},appReady:{onReady:f=>{const p=setImmediate(f);return ()=>clearImmediate(p);}}};apply({get:n=>values[n],effect:f=>{const dispose=f();if(typeof dispose!=='function')throw Error('SYNTHETIC_EFFECT_DISPOSER_REQUIRED');disposers.push(dispose);}});`;
  const result=await runTeacherBridge({evidenceRoot,deadlineMs:3000,startWorker:cap=>{const child=spawn(process.execPath,[workerPath],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdin.write(JSON.stringify({version:'wf2-synthetic-bind/1',capability:cap})+'\n');return child;},startDsh:()=>spawn(process.execPath,['--input-type=module','--eval',fakeDsh],{stdio:['pipe','pipe','pipe'],windowsHide:true}),forceClose:async children=>{for(const child of children)child.kill();}});
  assert.equal(result.status,'COMPLETED');assert.equal(result.workerClosed,true);assert.equal(result.dshClosed,true);assert.equal(result.completionAcknowledged,true);assert.equal(result.forced,false);assert.equal(result.metadata!.calls.deepseek,0);assert.equal(result.version,'wf2-teacher-bridge/2');assert.equal(result.responseFailureCode,'UNKNOWN');
  const text=readFileSync(join(evidenceRoot,'bridge-receipt.json'),'utf8');assert.ok(!text.includes('capability'));assert.ok(!text.includes('custodyKey'));
});
test('negative logical outcome persists closed metadata and reason before owner withdrawal',{timeout:10000},async()=>{
  for(const reason of ['FIRST_FOUR_GATE',...FIXED_SLOT_STOP_REASONS,'UNTRUSTED_EXCEPTION_TEXT']){
  const evidenceRoot=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-bridge-stopped-'))),workerUrl=new URL('../src/wf2-teacher-worker.ts',import.meta.url).href,pluginUrl=new URL('../integrations/dsh-teacher-control/index.mjs',import.meta.url).href;
  const workerSource=`import {serveTeacherControl} from ${JSON.stringify(workerUrl)};let stopped=false;const metadata=()=>({campaignStatus:stopped?'STOPPED':'ACTIVE',countCompleteness:'CURRENT_AUTHORITY',calls:{deepseek:stopped?4:0,together:0},candidates:{deepseek:stopped?1:0,together:0,qualified:0,quarantined:stopped?1:0},sealed:stopped,planned:stopped,manifestFrozen:false,usage:{input:stopped?80:0,completion:stopped?120:0,unknown:0},estimatedReserveMicroUsd:stopped?36865:0});const session=serveTeacherControl(process.stdin,process.stdout,b=>({capability:b.capability,terminal:()=>({metadata:metadata(),reason:${JSON.stringify(reason)},responseFailureCode:'ARGUMENTS_NATIVE_JSON_INVALID'}),run:{run:async()=>{stopped=true},close:()=>{},withdraw:()=>{},metadata}}));await session.closed;process.stdin.destroy();`;
  const dshSource=`import {apply} from ${JSON.stringify(pluginUrl)};const disposers=[];const values={cmdlineArgs:{get:()=>['--teacher-control']},appExit:n=>{for(const d of disposers)d();process.exitCode=n},appReady:{onReady:f=>{const p=setImmediate(f);return ()=>clearImmediate(p)}}};apply({get:n=>values[n],effect:f=>{disposers.push(f())}});`;
  const result=await runTeacherBridge({evidenceRoot,deadlineMs:3000,startWorker:cap=>{const child=spawn(process.execPath,['--input-type=module','--eval',workerSource],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdin.write(JSON.stringify({capability:cap})+'\n');return child;},startDsh:()=>spawn(process.execPath,['--input-type=module','--eval',dshSource],{stdio:['pipe','pipe','pipe'],windowsHide:true}),forceClose:async children=>{for(const child of children)child.kill();}});
  if(reason==='UNTRUSTED_EXCEPTION_TEXT'){assert.equal(result.status,'UNKNOWN_OR_STOPPED');assert.equal(result.stopReason,null);assert.ok(!readFileSync(join(evidenceRoot,'bridge-receipt.json'),'utf8').includes(reason));continue;}
  assert.equal(result.status,'STOPPED');assert.equal(result.stopReason,reason);assert.equal(result.completionAcknowledged,false);assert.equal(result.workerClosed,true);assert.equal(result.dshClosed,true);assert.equal(result.forced,false);
  assert.equal(result.metadataEvidence,'RECORDED_TERMINAL_SNAPSHOT_NOT_LIVE');assert.equal(result.metadata!.calls.deepseek,4);assert.equal(result.metadata!.usage.unknown,0);
  assert.equal(result.responseFailureCode,'ARGUMENTS_NATIVE_JSON_INVALID');const receipt=JSON.parse(readFileSync(join(evidenceRoot,'stopped-metadata.json'),'utf8'));assert.equal(receipt.version,2);assert.equal(receipt.responseFailureCode,'ARGUMENTS_NATIVE_JSON_INVALID');assert.equal(receipt.reason,reason);assert.equal(receipt.metadata.candidates.quarantined,1);
  }
});
