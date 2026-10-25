import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { JsonlPriorAdapter } from '../src/jsonl-prior.ts';
import { InteractionResources,RequestBudget } from '../src/interaction.ts';
import { bounded } from '../src/runtime.ts';
import { CoreError } from '../src/validation.ts';
const code=(expected:string)=>(error:unknown)=>error instanceof CoreError&&error.code===expected;
let failedStartActuallyClosed=false;
async function fixture(mode='normal') {
  const directory=await mkdtemp(join(tmpdir(),'companion-prior-fixture-'));
  const worker=join(directory,'synthetic-worker.txt'),source='synthetic worker source; no graph';await writeFile(worker,source);
  const workerSha256=createHash('sha256').update(source).digest('hex');
  const manifest={implementation:'flywire-prior-jsonl-v1',sourceHash:workerSha256,biologicalClaim:'none',device:'cpu',nodes:3136,
    condition:'real',graphSha256:'a'.repeat(64),structuralSha256:'b'.repeat(64)};
  const program=`
    const readline=require('node:readline');
    const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
    send({version:1,event:'ready',manifest:${JSON.stringify(manifest)}});
    let state=0;
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line);
      if(${JSON.stringify(mode)}==='hang' && r.command==='step')return;
      if(${JSON.stringify(mode)}==='overflow' && r.command==='step'){process.stdout.write('x'.repeat(20000));return;}
      if(${JSON.stringify(mode)}==='wrong-id' && r.command==='step'){send({version:1,id:'incorrect',event:'result'});return;}
      if(${JSON.stringify(mode)}==='bad-stop' && r.command==='stop'){send({version:1,id:r.id,event:'result'});process.exit(1);}
      if(${JSON.stringify(mode)}==='stop-nonzero' && r.command==='stop'){send({version:1,id:r.id,event:'stopped'});process.exit(1);}
      if(${JSON.stringify(mode)}==='stop-partial' && r.command==='stop'){send({version:1,id:r.id,event:'stopped'});process.stdout.write('partial');process.exit(0);}
      if(r.command==='stop'){send({version:1,id:r.id,event:'stopped'});process.exit(0);}
      else if(r.command==='reset'){state=0;send({version:1,id:r.id,event:'reset'});}
      else {state+=.1;send({version:1,id:r.id,event:'result',prior:{social:state,novelty:0,disengagement:0}});}
    });`;
  const config={pythonPath:process.execPath,workerPath:worker,workerSha256,graphPath:worker,graphSha256:manifest.graphSha256,
    structuralSha256:manifest.structuralSha256,startupTimeoutMs:5000,eventTimeoutMs:100};
  const launch=(..._args:unknown[])=>{
    if(mode==='ready-close-sync'||mode==='ready-fatal-delayed-close'){
      const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
      child.stdin={write:()=>{throw new Error('closed stdin must not be used');}};child.kill=()=>false;
      if(mode==='ready-fatal-delayed-close')child.kill=()=>{setTimeout(()=>{failedStartActuallyClosed=true;child.emit('close',null,'SIGTERM');},20);return true;};
      queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({version:1,event:'ready',manifest})+'\n'));
        if(mode==='ready-close-sync')child.emit('close',0,null);else child.stderr.emit('data',Buffer.alloc(8193));});
      return child;
    }
    return spawn(process.execPath,['-e',program],{stdio:'pipe',windowsHide:true});
  };
  const adapter=await JsonlPriorAdapter.start(config,{spawn:launch as typeof spawn});
  return {adapter,config};
}
test('JSONL child ready, event state carry, reset and stop roundtrip',async()=>{
  const {adapter}=await fixture();const input={dtMs:100,features:{social:.5,novelty:.1,disengagement:0},signal:new AbortController().signal};
  assert.equal((await adapter.step(input)).social,.1);assert.equal((await adapter.step(input)).social,.2);
  await adapter.reset();assert.equal((await adapter.step(input)).social,.1);assert.equal((await adapter.close()).graceful,true);
  await assert.rejects(adapter.step(input),code('NEURAL_PROCESS_CLOSED'));
});
test('synchronous ready then close has no ownership gap and cannot return a live adapter',async()=>{
  await assert.rejects(fixture('ready-close-sync'),code('NEURAL_READY_CLOSED'));
});
test('post-ready fatal start retains ownership until delayed actual close',async()=>{
  failedStartActuallyClosed=false;await assert.rejects(fixture('ready-fatal-delayed-close'),code('NEURAL_STDERR_LIMIT'));
  assert.equal(failedStartActuallyClosed,true);
});
for(const mode of ['bad-stop','stop-nonzero','stop-partial'])test(`${mode} closes but cannot report graceful acceptance`,async()=>{
  const {adapter}=await fixture(mode);const result=await adapter.close();assert.equal(result.closed,true);assert.equal(result.graceful,false);
});
test('one resident worker lease persists until child close',async()=>{
  const {adapter}=await fixture();await assert.rejects(fixture(),code('NEURAL_RESIDENT_LIMIT'));
  assert.equal((await adapter.close()).graceful,true);const next=await fixture();await next.adapter.close();
});
for(const mode of ['overflow','wrong-id','hang'])test(`JSONL ${mode} closes the owned worker and rejects`,async()=>{
  const {adapter}=await fixture(mode);
  await assert.rejects(adapter.step({dtMs:0,features:{social:0,novelty:0,disengagement:0},signal:new AbortController().signal}));
  await adapter.close();
});
test('local cancellation retains raw neural permit until owned child close',async()=>{
  const {adapter}=await fixture('hang');const resources=new InteractionResources(new RequestBudget({total:1,hourly:1,daily:1}));
  const controller=new AbortController();
  const call=bounded(controller.signal,1000,signal=>resources.neural.run(signal,()=>adapter.step({dtMs:0,
    features:{social:0,novelty:0,disengagement:0},signal})));
  controller.abort();await assert.rejects(call);assert.equal(resources.neural.active,true);
  await adapter.close();await new Promise<void>(r=>setImmediate(r));assert.equal(resources.neural.active,false);
});
