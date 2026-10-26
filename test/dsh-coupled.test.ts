import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { DshCoupledBridge } from '../src/dsh-coupled.ts';
import { CoreError } from '../src/validation.ts';
import { DshStdioBackend } from '../src/dsh-coupled-backend.ts';
import type { DshCoupledBackend, DshBackendClose } from '../src/dsh-coupled-backend.ts';
import { mountDshCoupled, validateDshConfig } from '../src/dsh-coupled-host.ts';
import type { DshPluginConfig } from '../src/dsh-coupled-host.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const closeResult:DshBackendClose={closed:true,graceful:true,exitCode:0,signal:null,forced:false,residualBytes:0,coreStatus:'closed'};
class FakeBackend implements DshCoupledBackend{
  sessionId=randomUUID();calls:Array<{command:string;fields:Record<string,unknown>}>=[];callback:((id:string)=>void)|undefined;
  deliveries=new Map<string,{text:string;taken:boolean;acked:boolean}>();closed=0;requests=0;paused=true;
  pending:Promise<void>|undefined;started=deferred<void>();
  onPrepared(callback:(id:string)=>void){this.callback=callback;return()=>{this.callback=undefined;};}
  async command(command:string,fields:Record<string,unknown>={},signal?:AbortSignal):Promise<any>{
    this.calls.push({command,fields});if(signal?.aborted)throw new Error('aborted');
    if(command==='status')return {paused:this.paused,available:!this.paused,workerResident:false,requests:{total:this.requests}};
    if(command==='pause'){this.paused=true;return {};}
    if(command==='resume'){this.paused=false;return {};}
    if(command==='submit'){
      this.requests++;this.started.resolve();if(this.pending)await Promise.race([this.pending,new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))]);
      const deliveryId=randomUUID();this.deliveries.set(deliveryId,{text:'SYNTHETIC_REPLY',taken:false,acked:false});return {deliveryId,appraisalStatus:'applied'};
    }
    if(command==='take'){const delivery=this.deliveries.get(fields.deliveryId as string);assert.ok(delivery&&!delivery.taken);delivery.taken=true;
      return {deliveryId:fields.deliveryId,text:delivery.text,recall:[],sourceRefs:[{id:'synthetic-anchor',revision:1}]};}
    if(command==='ack'){const delivery=this.deliveries.get(fields.deliveryId as string);assert.ok(delivery?.taken&&!delivery.acked);delivery.acked=true;return {};}
    if(command==='feedback-check'){const delivery=this.deliveries.get(fields.deliveryId as string);if(!delivery?.acked)throw new Error('FEEDBACK_REQUIRES_DELIVERED_RECEIPT');return {valid:true};}
    return {};
  }
  prepared(){const id=randomUUID();this.deliveries.set(id,{text:'PREPARED_SYNTHETIC_REPLY',taken:false,acked:false});this.requests++;this.callback?.(id);return id;}
  async close(){this.closed++;return closeResult;}
}
const human=(text='Synthetic violet preference')=>({id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'user',rpcId:randomUUID()}});
function fixture(t:TestContext,extra:Partial<ConstructorParameters<typeof DshCoupledBridge>[1]>={}){
  const backend=new FakeBackend(),sessionId=randomUUID();let now=1000;
  const bridge=new DshCoupledBridge(backend,{sessionId,provider:'companion-core',model:'coupled',clock:()=>now,...extra});
  t.after(()=>bridge.dispose());
  const options=(messages:any[],signal=new AbortController().signal)=>({sessionId,provider:'companion-core',model:'coupled',messages,signal});
  return {backend,bridge,sessionId,options,advance:(amount:number)=>{now+=amount;}};
}
async function begin(h:{bridge:DshCoupledBridge;sessionId:string},message:any,turn=1){
  h.bridge.inboxInserted(message);await h.bridge.nativeEvent(h.sessionId,{type:'turn/start',data:{turn}});
  h.bridge.inboxClaimed(message,turn);await h.bridge.nativeEvent(h.sessionId,{type:'user/message',seq:turn,time:Date.now(),surfaceOp:'append',data:message});
}
async function finish(h:{bridge:DshCoupledBridge;sessionId:string},reply:string,turn=1,reason='completed'){
  await h.bridge.nativeEvent(h.sessionId,{type:'assistant/message',surfaceOp:'append',data:{turn,step:1,message:{id:randomUUID(),role:'assistant',content:[{type:'text',text:reply}]}}});
  h.bridge.turnStopping(turn,new AbortController().signal);
  await h.bridge.nativeEvent(h.sessionId,{type:'turn/end',data:{turn,reason:{kind:reason}}});
}
async function collect(iter:AsyncIterable<any>){const frames=[];for await(const frame of iter)frames.push(frame);return frames;}

test('native four frames, commit and completed ACK; normal stopping retains original short lease',async t=>{
  const events:any[]=[];const h=fixture(t,{onEvent:event=>events.push(event)}),message=human();await begin(h,message);
  const frames=await collect(h.bridge.stream(h.options([message])));
  assert.deepEqual(frames.map(f=>f.type),['block-start','text-delta','block-end','finish']);
  assert.equal(h.backend.calls.filter(c=>c.command==='ack').length,0);
  h.bridge.turnStopping(1);assert.equal(h.backend.paused,false);const lease=h.bridge.status.leaseRemainingMs;
  await finish(h,'SYNTHETIC_REPLY');assert.equal(h.bridge.status.ackCount,1);assert.equal(h.backend.paused,false);
  assert.equal(h.bridge.status.leaseRemainingMs,lease);assert.equal(h.backend.calls.some(c=>'feedback' in c.fields),false);
  assert.equal(events.find(e=>e.kind==='core-interaction')?.appraisalStatus,'applied');
  const recall=events.find(e=>e.kind==='core-recall');assert.equal(recall?.recallCount,0);assert.equal(recall?.sourceRefCount,1);
  assert.equal('recall' in recall,false);assert.equal('sourceRefs' in recall,false);
});
test('authority/current-content/claim checks precede any submit',async t=>{
  const h=fixture(t),message=human();await begin(h,message);
  for(const change of [{sessionId:randomUUID()},{provider:'other'},{model:'other'},{messages:[human()]}])
    await assert.rejects(collect(h.bridge.stream({...h.options([message]),...change})));
  await assert.rejects(collect(h.bridge.stream(h.options([{...message,content:[{type:'text',text:'changed'}]}]))));
  assert.equal(h.backend.requests,0);
});

test('failed real submit audits only fixed stage/code and marks stale usage unknown',async t=>{
  for(const error of [new CoreError('PROVIDER_NETWORK'),new Error('SYNTHETIC_PRIVATE_ERROR_NOT_RETAINED')]){
    const events:any[]=[];const h=fixture(t,{realProvider:true,onEvent:event=>events.push(event)}),message=human();await begin(h,message);
    const command=h.backend.command.bind(h.backend);h.backend.command=async(name,fields,signal)=>{
      if(name==='submit')throw error;return command(name,fields,signal);};
    await assert.rejects(collect(h.bridge.stream(h.options([message]))));
    const failure=events.find(e=>e.kind==='core-failure');assert.equal(failure?.status,'submit');
    assert.equal(failure?.code,error instanceof CoreError?'PROVIDER_NETWORK':'UNCLASSIFIED');
    assert.equal(failure?.usageSnapshotKnown,false);assert.ok(Number.isSafeInteger(failure?.elapsedMs));
    assert.equal(JSON.stringify(events).includes('SYNTHETIC_PRIVATE_ERROR_NOT_RETAINED'),false);
  }
});
test('same native message ID with new seq and turn never causes second request',async t=>{
  const h=fixture(t),message=human();await begin(h,message);await collect(h.bridge.stream(h.options([message])));await finish(h,'SYNTHETIC_REPLY');
  await begin(h,message,2);await assert.rejects(collect(h.bridge.stream(h.options([message]))),/DSH_MESSAGE_ALREADY_HANDLED/);assert.equal(h.backend.requests,1);
});
test('signal cancellation during pending provider pauses and rejects late delivery',async t=>{
  const h=fixture(t),message=human(),late=deferred<void>(),abort=new AbortController();h.backend.pending=late.promise;await begin(h,message);
  const result=collect(h.bridge.stream(h.options([message],abort.signal)));await h.backend.started.promise;abort.abort();await assert.rejects(result);
  late.resolve();await tick();assert.equal(h.backend.paused,true);assert.equal(h.backend.calls.some(c=>c.command==='take'||c.command==='ack'),false);
});
test('consumer early return and non-completed host turn do not ACK',async t=>{
  const h=fixture(t),message=human();await begin(h,message);const iterator=h.bridge.stream(h.options([message]));await iterator.next();await iterator.return(undefined);
  await finish(h,'SYNTHETIC_REPLY',1,'aborted');assert.equal(h.bridge.status.ackCount,0);assert.equal(h.backend.paused,true);
});
test('native completed without matching assistant commit cannot ACK',async t=>{
  const h=fixture(t),message=human();await begin(h,message);await collect(h.bridge.stream(h.options([message])));
  await h.bridge.nativeEvent(h.sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});assert.equal(h.bridge.status.ackCount,0);
});
test('multiple claimed human inputs are rejected together before provider work and cannot be split-replayed',async t=>{
  const h=fixture(t),one=human('Synthetic one'),two=human('Synthetic two');
  h.bridge.inboxInserted(one);h.bridge.inboxInserted(two);await h.bridge.nativeEvent(h.sessionId,{type:'turn/start',data:{turn:1}});
  h.bridge.inboxClaimed(one,1);h.bridge.inboxClaimed(two,1);
  for(const [index,message] of [one,two].entries())await h.bridge.nativeEvent(h.sessionId,{type:'user/message',surfaceOp:'append',seq:index+1,time:Date.now(),data:message});
  await assert.rejects(collect(h.bridge.stream(h.options([one,two]))),/DSH_MULTIPLE_HUMAN_INPUTS/);
  assert.equal(h.backend.requests,0);assert.equal(h.backend.calls.some(c=>['submit','take','ack','resume'].includes(c.command)),false);
  assert.equal(h.backend.calls.some(c=>c.command==='context'&&c.fields.available===true),false);
  await h.bridge.nativeEvent(h.sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'error'}}});
  await begin(h,two,2);await assert.rejects(collect(h.bridge.stream(h.options([two]))),/DSH_MESSAGE_ALREADY_HANDLED/);assert.equal(h.backend.requests,0);
});
test('owned machine notification consumes prepared reply with no submit, memory or lease renewal',async t=>{
  let notification:any;const h=fixture(t,{publishPrepared:async(id,attach)=>{notification={id:randomUUID(),role:'user',source:{kind:'companion-prepared-delivery'},
    content:[{type:'text',text:h.bridge.preparedNotice(id)}]};return attach(notification.id);}});
  const message=human();await begin(h,message);await collect(h.bridge.stream(h.options([message])));await finish(h,'SYNTHETIC_REPLY');
  h.advance(1000);const lease=h.bridge.status.leaseRemainingMs;h.backend.prepared();await tick();assert.ok(notification);
  await begin(h,notification,2);const frames=await collect(h.bridge.stream(h.options([message,notification])));await finish(h,'PREPARED_SYNTHETIC_REPLY',2);
  assert.equal(frames[1].text,'PREPARED_SYNTHETIC_REPLY');assert.equal(h.backend.calls.filter(c=>c.command==='submit').length,1);
  assert.equal(h.bridge.status.sourceCount,1);assert.equal(h.bridge.status.leaseRemainingMs,lease);assert.equal(h.bridge.status.ackCount,2);
});
test('unknown machine notification and matching user text cannot steal prepared delivery',async t=>{
  let notice:any;const h=fixture(t,{publishPrepared:async(id,attach)=>{notice={id:randomUUID(),role:'user',source:{kind:'companion-prepared-delivery'},
    content:[{type:'text',text:h.bridge.preparedNotice(id)}]};return attach(notice.id);}});
  const first=human();await begin(h,first);await collect(h.bridge.stream(h.options([first])));await finish(h,'SYNTHETIC_REPLY');h.backend.prepared();await tick();
  await assert.rejects(h.bridge.nativeEvent(h.sessionId,{type:'user/message',surfaceOp:'append',data:{...notice,id:randomUUID()}}),/UNOWNED/);
  const mimic=human(notice.content[0].text);await begin(h,mimic,2);const frames=await collect(h.bridge.stream(h.options([first,mimic])));
  assert.equal(frames[1].text,'SYNTHETIC_REPLY');assert.equal(h.backend.calls.filter(c=>c.command==='submit').length,2);
});
test('human claimed in same turn preempts machine notification; expired lease cannot deliver',async t=>{
  let notice:any;const h=fixture(t,{publishPrepared:async(id,attach)=>{notice={id:randomUUID(),role:'user',source:{kind:'companion-prepared-delivery'},
    content:[{type:'text',text:h.bridge.preparedNotice(id)}]};return attach(notice.id);}});
  const first=human();await begin(h,first);await collect(h.bridge.stream(h.options([first])));await finish(h,'SYNTHETIC_REPLY');h.backend.prepared();await tick();
  const second=human();h.bridge.inboxInserted(second);await h.bridge.nativeEvent(h.sessionId,{type:'turn/start',data:{turn:2}});
  h.bridge.inboxClaimed(notice,2);h.bridge.inboxClaimed(second,2);
  await h.bridge.nativeEvent(h.sessionId,{type:'user/message',seq:2,time:Date.now(),surfaceOp:'append',data:notice});
  await h.bridge.nativeEvent(h.sessionId,{type:'user/message',seq:3,time:Date.now(),surfaceOp:'append',data:second});
  const frames=await collect(h.bridge.stream(h.options([first,second,notice])));assert.equal(frames[1].text,'SYNTHETIC_REPLY');await finish(h,'SYNTHETIC_REPLY',2);
  h.backend.prepared();await tick();await begin(h,notice,3);h.advance(30001);await assert.rejects(collect(h.bridge.stream(h.options([notice]))));
});
test('publication in flight is invalidated by a new human input',async t=>{
  const ready=deferred<void>(),go=deferred<void>();let accepted=true;
  const h=fixture(t,{publishPrepared:async(_id,attach)=>{ready.resolve();await go.promise;accepted=attach(randomUUID());return accepted;}});
  const first=human();await begin(h,first);await collect(h.bridge.stream(h.options([first])));await finish(h,'SYNTHETIC_REPLY');h.backend.prepared();await ready.promise;
  h.bridge.inboxInserted(human());go.resolve();await tick();assert.equal(accepted,false);assert.equal(h.bridge.status.preparedCount,0);
});
test('manual pause blocks fresh native input until explicit resume and switch remains paused',async t=>{
  const h=fixture(t),message=human();await h.bridge.manualPause();await begin(h,message);
  await assert.rejects(collect(h.bridge.stream(h.options([message]))),/DSH_MANUALLY_PAUSED/);assert.equal(h.backend.requests,0);
  await h.bridge.manualResume();assert.equal(h.bridge.status.leaseRemainingMs,0);await collect(h.bridge.stream(h.options([message])));await finish(h,'SYNTHETIC_REPLY');
  for(const backend of ['baseline','no-state','flywire'] as const){await h.bridge.switchBackend(backend);assert.equal(h.bridge.status.manualPaused,true);
    assert.equal(h.backend.paused,true);assert.equal(h.backend.calls.at(-1)?.fields.backend,backend);await h.bridge.manualResume();}
  assert.equal(h.backend.requests,1);assert.equal(h.bridge.status.sourceCount,1);
});
test('later manual pause wins an in-flight explicit resume',async t=>{
  const h=fixture(t),resume=deferred<void>(),started=deferred<void>(),original=h.backend.command.bind(h.backend);
  h.backend.command=async(command,fields,signal)=>{if(command==='resume'){started.resolve();await resume.promise;}return original(command,fields,signal);};
  const resuming=h.bridge.manualResume();await started.promise;await h.bridge.manualPause();resume.resolve();await assert.rejects(resuming);
  assert.equal(h.bridge.status.manualPaused,true);assert.equal(h.backend.paused,true);
});
test('queued native input uses remaining arrival lease; replay cannot renew it and old input is rejected',async t=>{
  const h=fixture(t),message=human();h.bridge.inboxInserted(message);h.advance(10000);await begin(h,message);
  await collect(h.bridge.stream(h.options([message])));const context=h.backend.calls.find(c=>c.command==='context');assert.equal(context?.fields.ttlMs,20000);
  await finish(h,'SYNTHETIC_REPLY');const old=human();h.bridge.inboxInserted(old);h.advance(30001);await begin(h,old,2);
  await assert.rejects(collect(h.bridge.stream(h.options([old]))),/DSH_INPUT_EXPIRED/);assert.equal(h.backend.requests,1);
});

function mockHost(sessionId:string){
  const hooks=new Map<string,Function>(),commands=new Map<string,any>(),effects:Array<()=>Promise<void>>=[],queue:any[]=[];let adapter:any,cancelled=0,disposed=0;
  const on=(name:string,fn:Function)=>{hooks.set(name,fn);return()=>{hooks.delete(name);};};
  const agent={session:{id:sessionId},ctx:{on,inject:(_services:any,fn:Function)=>fn({commands:{register:(definition:any)=>{commands.set(definition.name,definition);return()=>commands.delete(definition.name);}}})},
    cancel:async()=>{cancelled++;},followup:(message:any)=>queue.push(message),runMaintenance:async(fn:Function)=>fn(new AbortController().signal)};
  const ctx={llm:{registerAdapter:(_ids:any,value:any)=>{adapter=value;return()=>{};}},agents:{get:()=>null,create:async()=>({agent,dispose:async()=>{disposed++;}})},
    sessions:{get:()=>null,flush:async()=>{}},on,effect:(fn:Function)=>{effects.push(fn());}};
  return {ctx,agent,queue,effects,hooks,commands,get adapter(){return adapter;},get cancelled(){return cancelled;},get disposed(){return disposed;}};
}
const sdk={LlmAdapter:class{},createUserMessage:(options:any)=>({id:randomUUID(),role:'user',...options})};
async function hostConfig():Promise<DshPluginConfig>{const path=await mkdtemp(join(tmpdir(),'companion-dsh-test-'));return {auditId:randomUUID(),sessionId:randomUUID(),cwd:path,
  parentControl:true,launcher:{mode:'synthetic',corePath:resolve('.'),nodePath:process.execPath,runtimeRoot:path,maxCalls:2}};}
function outputFrames(output:PassThrough){const frames:any[]=[];let buffer='';output.on('data',chunk=>{buffer+=chunk.toString();let at;
  while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);assert.ok(line.startsWith('COMPANION_COUPLED_EVENT:'));frames.push(JSON.parse(line.slice(24)));}});return frames;}

test('host private parent control binds auditId, shutdown closes backend then interrupts official host',async()=>{
  const config=await hostConfig(),host=mockHost(config.sessionId),backend=new FakeBackend(),input=new PassThrough(),output=new PassThrough(),frames=outputFrames(output);let interrupted=0;
  const mounted=await mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input,output,interruptHost:()=>{assert.equal(backend.closed,1);interrupted++;}});
  input.write('COMPANION_CONTROL:'+JSON.stringify({auditId:randomUUID(),action:'shutdown'})+'\n');await tick();assert.equal(backend.closed,0);
  input.write('COMPANION_CONTROL:'+JSON.stringify({auditId:config.auditId,action:'shutdown'})+'\n');await tick();await mounted.cleanup();
  assert.equal(interrupted,1);assert.equal(host.disposed,1);assert.ok(frames.every(f=>f.auditId===config.auditId));assert.ok(frames.some(f=>f.kind==='disposed'&&f.status==='closed'));
});
test('EOF during backend startup harvests and closes late backend without creating session',async()=>{
  const config=await hostConfig(),host=mockHost(config.sessionId),backend=new FakeBackend(),input=new PassThrough(),output=new PassThrough(),start=deferred<DshCoupledBackend>();output.resume();let interrupted=0;
  const mounting=mountDshCoupled(host.ctx,config,sdk,{startBackend:()=>start.promise,input,output,interruptHost:()=>{interrupted++;}});
  input.end();await tick();assert.equal(interrupted,0);start.resolve(backend);const mounted=await mounting;await mounted.cleanup();await tick();
  assert.equal(backend.closed,1);assert.equal(interrupted,1);assert.equal(host.adapter,undefined);
});
test('SDK unload is registered before startup and harvests late backend without creating native handle',async()=>{
  const config=await hostConfig(),host=mockHost(config.sessionId),backend=new FakeBackend(),input=new PassThrough(),output=new PassThrough(),start=deferred<DshCoupledBackend>();output.resume();
  const mounting=mountDshCoupled(host.ctx,config,sdk,{startBackend:()=>start.promise,input,output,interruptHost:()=>assert.fail('unload must not stop host')});
  assert.equal(host.effects.length,1);const unmounting=host.effects[0]!();start.resolve(backend);await mounting;await unmounting;
  assert.equal(backend.closed,1);assert.equal(host.adapter,undefined);assert.equal(host.disposed,0);
});
test('ordinary SDK unload closes own session without shutting entire host; acceptance wx claim prevents remount replay',async()=>{
  const config=await hostConfig();config.acceptanceInput={text:'SYNTHETIC_ONE_SHOT_SECRET_TEXT',rpcId:randomUUID()};let interrupted=0;
  for(let run=0;run<2;run++){
    const host=mockHost(config.sessionId),backend=new FakeBackend(),input=new PassThrough(),output=new PassThrough(),frames=outputFrames(output);
    const mounted=await mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input,output,interruptHost:()=>{interrupted++;}});
    assert.equal(host.queue.length,run===0?1:0);assert.equal(JSON.stringify(frames).includes(config.acceptanceInput.text),false);
    await host.effects[0]!();await mounted.cleanup();assert.equal(backend.closed,1);
  }
  const claim=await readFile(join(config.cwd,`acceptance-${config.auditId}.claimed`),'utf8');assert.equal(claim.includes(config.acceptanceInput.text),false);assert.equal(interrupted,0);
});
test('resident boot claim is durable before spawn and same session with a new audit never replenishes budget',async()=>{
  const config=await hostConfig();config.launcher={...config.launcher,mode:'resident',pythonPath:process.execPath,scriptPath:process.execPath,maxCalls:0};
  let starts=0;const backend=new FakeBackend();const start=async()=>{
    const saved=JSON.parse(await readFile(join(config.launcher.runtimeRoot,`session-${config.sessionId}.boot-claimed`),'utf8'));
    assert.equal(saved.sessionId,config.sessionId);assert.equal(saved.maxCalls,0);assert.match(saved.configSha256,/^[a-f0-9]{64}$/);starts++;return backend;};
  const output=new PassThrough();output.resume();const mounted=await mountDshCoupled(mockHost(config.sessionId).ctx,config,sdk,{startBackend:start,input:new PassThrough(),output});await mounted.cleanup();
  const retryOutput=new PassThrough(),frames=outputFrames(retryOutput);
  await assert.rejects(mountDshCoupled(mockHost(config.sessionId).ctx,{...config,auditId:randomUUID()},sdk,{startBackend:start,input:new PassThrough(),output:retryOutput}));
  assert.equal(starts,1);assert.ok(frames.some(f=>f.code==='DSH_BOOT_ALREADY_CLAIMED'));
});
test('concurrent resident mounts consume one session claim and failed startup never refunds it',async()=>{
  for(const failStart of [false,true]){
    const config=await hostConfig();config.launcher={...config.launcher,mode:'resident',pythonPath:process.execPath,scriptPath:process.execPath,maxCalls:0};let starts=0;
    const run=()=>{const output=new PassThrough();output.resume();return mountDshCoupled(mockHost(config.sessionId).ctx,{...config,auditId:randomUUID()},sdk,
      {input:new PassThrough(),output,startBackend:async()=>{starts++;if(failStart)throw new Error('synthetic spawn failed');return new FakeBackend();}});};
    const outcomes=await Promise.allSettled([run(),run()]);assert.equal(starts,1);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,failStart?0:1);
    for(const result of outcomes)if(result.status==='fulfilled')await result.value.cleanup();
    await assert.rejects(run());assert.equal(starts,1);
  }
});
test('configuration rejects secret fields, relative paths, and implicit positive-budget credentials',async()=>{
  const config=await hostConfig();assert.throws(()=>validateDshConfig({...config,apiKey:'NO_READ'}));assert.throws(()=>validateDshConfig({...config,cwd:'relative'}));
  assert.throws(()=>validateDshConfig({...config,launcher:{...config.launcher,mode:'resident',pythonPath:process.execPath,scriptPath:process.execPath}}));
});

test('credential root is an explicit existing absolute directory, with only fixed CLI directory forwarding',async()=>{
  const config=await hostConfig();config.launcher={...config.launcher,mode:'resident',pythonPath:process.execPath,
    scriptPath:process.execPath,allowExistingDpapi:true,credentialRoot:config.cwd};
  assert.equal(validateDshConfig(config).launcher.credentialRoot,config.cwd);
  for(const credentialRoot of ['relative',process.execPath,join(config.cwd,'missing')]){
    const invalid={...config,launcher:{...config.launcher,credentialRoot}};
    assert.throws(()=>validateDshConfig(invalid),/DSH_CONFIG_INVALID/);
    await assert.rejects(DshStdioBackend.start(invalid.launcher,{spawn:(()=>assert.fail('invalid root must not spawn')) as typeof spawn}),/DSH_BACKEND_CONFIG/);
  }
  assert.throws(()=>validateDshConfig({...config,launcher:{...config.launcher,credentialFile:process.execPath}}));
  assert.throws(()=>validateDshConfig({...config,launcher:{...config.launcher,mode:'synthetic'}}));
  for(const maxCalls of [0,2]){
    let captured:any;
    const launch=(...args:any[])=>{captured=args;throw new Error('synthetic spawn refused');};
    await assert.rejects(DshStdioBackend.start({...config.launcher,maxCalls},{spawn:launch as typeof spawn}),/DSH_BACKEND_PROCESS_ERROR/);
    assert.deepEqual(captured[1].slice(-2),['--credential-root',config.cwd]);
    assert.equal(captured[1].includes('--allow-existing-dpapi'),maxCalls>0);
    assert.equal(captured[2].env.LOCALAPPDATA,process.env.LOCALAPPDATA);
    assert.equal(captured[1].some((arg:string)=>arg.endsWith('.dpapi')),false);
  }
});
test('official slash controls require exact owned agent, fixed arguments and never create input/provider work',async()=>{
  const config=await hostConfig(),host=mockHost(config.sessionId),backend=new FakeBackend(),input=new PassThrough(),output=new PassThrough();output.resume();
  const mounted=await mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input,output});
  const invoke=(name:string,rawInput='',agent:any=host.agent)=>host.commands.get(`companion-${name}`).handler({agent,rawInput,attachments:[],signal:new AbortController().signal});
  assert.deepEqual([...host.commands.keys()],['companion-pause','companion-resume','companion-status','companion-switch','companion-feedback','companion-revoke','companion-inspect']);
  assert.ok([...host.commands.values()].every(def=>def.recordInput===false));
  assert.equal((await invoke('pause','',{})).kind,'error');assert.equal((await invoke('switch','arbitrary')).kind,'error');
  assert.equal((await invoke('pause','extra')).kind,'error');assert.equal(backend.calls.length,0);
  assert.equal((await invoke('pause')).kind,'success');assert.equal(mounted.bridge!.status.manualPaused,true);
  assert.equal((await invoke('resume')).kind,'success');assert.equal(mounted.bridge!.status.manualPaused,false);assert.equal(mounted.bridge!.status.leaseRemainingMs,0);
  for(const value of ['baseline','no-state','flywire']){assert.equal((await invoke('switch',` ${value} `)).kind,'success');assert.equal(mounted.bridge!.status.manualPaused,true);}
  const status=await invoke('status');assert.equal(status.kind,'success');assert.match(status.text,/calls=0\/2/);
  assert.ok(status.text.length<=1024);const inspect=await invoke('inspect');assert.equal(inspect.kind,'success');assert.equal(JSON.parse(inspect.text).calls,0);
  assert.equal(backend.requests,0);assert.equal(host.queue.length,0);assert.equal(mounted.bridge!.status.sourceCount,0);
  const stale=host.commands.get('companion-resume');await mounted.cleanup();assert.equal(host.commands.size,0);
  assert.equal((await stale.handler({agent:host.agent,rawInput:'',signal:new AbortController().signal})).kind,'error');
});
test('actual synthetic stdio process drives native-shaped turn and closes gracefully without HTTP',async t=>{
  const config=await hostConfig(),backend=await DshStdioBackend.start(config.launcher);const bridge=new DshCoupledBridge(backend,{sessionId:config.sessionId,provider:'companion-core',model:'coupled'});
  t.after(()=>bridge.dispose());const message=human(),h={bridge,sessionId:config.sessionId};await begin(h,message);
  const frames=await collect(bridge.stream({sessionId:config.sessionId,provider:'companion-core',model:'coupled',messages:[message],signal:new AbortController().signal}));
  assert.equal(frames[1].text,'SYNTHETIC_COUPLED_REPLY');await finish(h,frames[1].text);assert.equal(bridge.status.ackCount,1);
  assert.equal((await backend.command('status')).requests.total,1);const closed=await bridge.dispose();assert.equal(closed.graceful,true);assert.equal(closed.exitCode,0);
});

test('durable bridge requires explicit resume; feedback selection waits for native ACK and next real input',async t=>{
  const h=fixture(t,{requireManualResume:true}),message=human();await begin(h,message);
  await assert.rejects(collect(h.bridge.stream(h.options([message]))),/DSH_MANUALLY_PAUSED/);assert.equal(h.backend.requests,0);
  await h.bridge.manualResume();assert.equal(h.bridge.status.leaseRemainingMs,0);
  await collect(h.bridge.stream(h.options([message])));
  const id=[...h.backend.deliveries.keys()][0]!;
  await assert.rejects(h.bridge.selectFeedback(id,'engaged'));await finish(h,'SYNTHETIC_REPLY');
  await h.bridge.selectFeedback(id,'engaged');await h.bridge.selectFeedback(id,'engaged');
  await assert.rejects(h.bridge.selectFeedback(id,'declined'),/DSH_FEEDBACK_CONFLICT/);
  assert.equal(h.backend.requests,1);assert.deepEqual(h.bridge.status.pendingFeedback,{deliveryId:id,outcome:'engaged'});
  const next=human('Synthetic explicit feedback source');await begin(h,next,2);await collect(h.bridge.stream(h.options([message,next])));
  assert.deepEqual(h.backend.calls.filter(c=>c.command==='submit').at(-1)!.fields.feedback,{deliveryId:id,outcome:'engaged'});
  assert.equal(h.bridge.status.pendingFeedback,null);await finish(h,'SYNTHETIC_REPLY',2);
  await h.bridge.selectFeedback([...h.backend.deliveries.keys()][1]!,'neutral');await h.bridge.manualPause();assert.equal(h.bridge.status.pendingFeedback,null);
  await h.bridge.revoke({id:randomUUID(),revision:1});assert.equal(h.backend.calls.at(-1)!.command,'revoke');assert.equal(h.bridge.status.manualPaused,true);
});

test('persistent native mount explicitly resumes fixed SID, restores usage and does not consume legacy boot claim',async()=>{
  const config=await hostConfig();config.nativeSessionMode='resume';config.launcher={...config.launcher,mode:'resident',pythonPath:process.execPath,
    scriptPath:process.execPath,allowExistingDpapi:true,persistence:{directory:config.cwd,identity:'SYNTHETIC_VAULT'}};
  const host=mockHost(config.sessionId),backend=new FakeBackend(),output=new PassThrough();const frames=outputFrames(output);let resumed:any;
  host.ctx.agents.create=async()=>assert.fail('resume must not fall back to create');
  (host.ctx.agents as any).resume=async(options:any)=>{resumed=options;return {agent:host.agent,dispose:async()=>{}};};
  const command=backend.command.bind(backend);backend.command=async(name,fields,signal)=>name==='status'
    ?{paused:true,available:false,personalPersistence:true,requests:{total:1},persistence:{manualResumeRequired:true,identity:'SYNTHETIC_VAULT'}}
    :command(name,fields,signal);
  const mounted=await mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input:new PassThrough(),output});
  assert.equal(resumed.resumeSessionId,config.sessionId);assert.match(resumed.agentOptions.provider,/^companion-core-[a-f0-9]{12}$/);
  assert.equal(mounted.bridge!.status.manualPaused,true);assert.equal(mounted.bridge!.status.realModelCalls,1);
  assert.equal(frames.find(f=>f.kind==='plugin-ready').requests,1);
  await assert.rejects(readFile(join(config.cwd,`session-${config.sessionId}.boot-claimed`)),/ENOENT/);await mounted.cleanup();
});

test('read-only native status/inspect abort or failure never pauses or changes host context',async()=>{
  for(const action of ['status','inspect'])for(const failure of ['abort','reject','oversize']){
    if(action==='status'&&failure==='oversize')continue;
    const config=await hostConfig(),host=mockHost(config.sessionId),backend=new FakeBackend(),output=new PassThrough();output.resume();
    const mounted=await mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input:new PassThrough(),output});
    const entered=deferred<void>(),release=deferred<void>();const original=backend.command.bind(backend);
    backend.command=async(name,fields,signal)=>{
      if(name==='status'){
        backend.calls.push({command:name,fields:fields??{}});entered.resolve();
        if(failure==='abort')await release.promise;
        if(failure==='reject')throw new Error('synthetic status error');
        return {paused:false,available:false,requests:{total:0},requestAudit:failure==='oversize'?{synthetic:'x'.repeat(33000)}:null};
      }
      return original(name,fields,signal);
    };
    const abort=new AbortController();const pending=host.commands.get(`companion-${action}`).handler({agent:host.agent,rawInput:'',attachments:[],signal:abort.signal});
    await entered.promise;if(failure==='abort'){abort.abort();release.resolve();}
    const result=await pending;assert.equal(result.kind,'error');assert.equal(mounted.bridge!.status.manualPaused,false);
    assert.deepEqual(backend.calls.map(c=>c.command),['status']);assert.equal(mounted.bridge!.status.leaseRemainingMs,0);
    await mounted.cleanup();
  }
});

test('persistent launcher handshake and native mount both reject wrong or missing observed vault identity',async()=>{
  for(const observed of ['wrong',undefined]){
    const config=await hostConfig();config.launcher={...config.launcher,mode:'resident',pythonPath:process.execPath,scriptPath:process.execPath,
      maxCalls:0,persistence:{directory:config.cwd,identity:'expected'}};
    const boot={sessionId:randomUUID(),paused:true,available:false,maxCalls:0,personalPersistence:true,requests:{total:0},
      persistence:{manualResumeRequired:true,...(observed?{identity:observed}:{})}};
    const launch=()=>{const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
      child.stdin.write=()=>{};child.kill=()=>{queueMicrotask(()=>child.emit('close',1,null));return true;};
      queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({version:1,id:'host-boot',ok:true,result:boot})+'\n')));return child;};
    await assert.rejects(DshStdioBackend.start(config.launcher,{spawn:launch as typeof spawn}));
    const host=mockHost(config.sessionId),backend=new FakeBackend(),output=new PassThrough();output.resume();
    backend.command=async()=>boot;host.ctx.agents.create=async()=>assert.fail('wrong identity must not create native session');
    await assert.rejects(mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input:new PassThrough(),output}),/COMPANION_PLUGIN_START_FAILED/);
    assert.equal(backend.closed,1);assert.equal(host.adapter,undefined);
  }
});

test('boot rejection preserves only fixed local codes through backend and plugin startup audit',async()=>{
  for(const supplied of ['DURABLE_CORRUPT','DURABLE_CLOCK_ROLLBACK','SCHEMA_MISMATCH','SYNTHETIC_PRIVATE_ERROR_NOT_RETAINED',undefined]){
    const config=await hostConfig();let closed=false;
    const launch=()=>{const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
      child.stdin.write=()=>{};child.kill=()=>{setTimeout(()=>{closed=true;child.emit('close',1,null);},10);return true;};
      queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({version:1,id:'host-boot',ok:false,
        error:{code:supplied,message:'SYNTHETIC_PRIVATE_DETAIL',path:'SYNTHETIC_PRIVATE_PATH'}})+'\n')));return child;};
    const expected=supplied&&['DURABLE_CORRUPT','DURABLE_CLOCK_ROLLBACK','SCHEMA_MISMATCH'].includes(supplied)?supplied:'DSH_BACKEND_BOOT_FAILED';
    const output=new PassThrough(),frames=outputFrames(output);
    await assert.rejects(mountDshCoupled(mockHost(config.sessionId).ctx,config,sdk,{input:new PassThrough(),output,
      startBackend:()=>DshStdioBackend.start(config.launcher,{spawn:launch as typeof spawn})}),/COMPANION_PLUGIN_START_FAILED/);
    assert.equal(closed,true);assert.equal(frames.find(f=>f.kind==='plugin-start')?.code,expected);
    assert.equal(JSON.stringify(frames).includes('SYNTHETIC_PRIVATE'),false);
  }
});

for(const mode of ['boot-close','boot-fatal','write-throws'])test(`client ${mode} startup rejects only after actual owned close`,async()=>{
  const config=await hostConfig();let closed=false;
  const launch=()=>{const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.write=()=>{if(mode==='write-throws')throw new Error('SYNTHETIC_RAW_ERROR_NOT_LOGGED');};
    child.kill=()=>{setTimeout(()=>{closed=true;child.emit('close',1,null);},10);return true;};
    if(mode!=='write-throws')queueMicrotask(()=>{
      child.stdout.emit('data',Buffer.from(JSON.stringify({version:1,id:'host-boot',ok:true,result:{sessionId:randomUUID(),paused:true,available:false,maxCalls:2,requests:{total:0}}})+'\n'));
      if(mode==='boot-close'){closed=true;child.emit('close',0,null);}else child.stderr.emit('data',Buffer.alloc(16385));
    });return child;};
  await assert.rejects(DshStdioBackend.start(config.launcher,{spawn:launch as typeof spawn}));assert.equal(closed,true);
});
test('input or output pipe close without error cleans owned backend',async()=>{
  for(const side of ['input','output']){
    const config=await hostConfig(),host=mockHost(config.sessionId),backend=new FakeBackend(),input=new PassThrough(),output=new PassThrough();output.resume();
    const mounted=await mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input,output,interruptHost:()=>{}});
    (side==='input'?input:output).destroy();await tick();await mounted.cleanup();assert.equal(backend.closed,1);
  }
});
test('final audit nextTick output error cannot select graceful host exit and unload removes owned listeners',async()=>{
  const config=await hostConfig(),host=mockHost(config.sessionId),backend=new FakeBackend(),input=new PassThrough();let interrupted:boolean|undefined;
  const output=new Writable({write(chunk,_encoding,done){done();if(chunk.toString().includes('"kind":"disposed"'))process.nextTick(()=>output.emit('error',new Error('synthetic')));}});
  const mounted=await mountDshCoupled(host.ctx,config,sdk,{startBackend:async()=>backend,input,output,interruptHost:value=>{interrupted=value;}});
  input.end();await tick();assert.equal(await mounted.cleanup(),false);await tick();assert.equal(interrupted,false);assert.equal(output.listenerCount('error'),0);assert.equal(output.listenerCount('close'),0);
});
for(const [pipe,event] of [['stdout','close'],['stdout','error'],['stderr','error'],['stdin','close']] as const)
  test(`client ${pipe}.${event} failure closes owned child without unhandled error and retains resident lease`,async()=>{
    const config=await hostConfig();let child:any,closed=false,kills=0;
    const launch=()=>{child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
      child.stdin.write=()=>{};child.stdin.end=()=>{};child.kill=()=>{kills++;setTimeout(()=>{closed=true;child.emit('close',1,null);},10);return true;};
      queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({version:1,id:'host-boot',ok:true,
        result:{sessionId:randomUUID(),paused:true,available:false,maxCalls:2,requests:{total:0}}})+'\n')));return child;};
    const adapter=await DshStdioBackend.start(config.launcher,{spawn:launch as typeof spawn});child[pipe].emit(event,new Error('SYNTHETIC_PIPE_FAILURE'));
    await assert.rejects(DshStdioBackend.start(config.launcher,{spawn:launch as typeof spawn}),/RESIDENT_LIMIT/);
    const result=await adapter.close();assert.equal(closed,true);assert.equal(kills,1);assert.equal(result.graceful,false);
  });
