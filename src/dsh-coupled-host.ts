import { open } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { DshStdioBackend } from './dsh-coupled-backend.ts';
import type { DshBackendConfig, DshCoupledBackend } from './dsh-coupled-backend.ts';
import { DshCoupledBridge } from './dsh-coupled.ts';
import { fail } from './validation.ts';

export type DshPluginConfig={auditId:string;sessionId:string;model?:'coupled';cwd:string;enableProactive?:boolean;parentControl?:boolean;
  initialBackend?:'baseline'|'no-state'|'flywire';auditFile?:boolean;
  launcher:DshBackendConfig;acceptanceInput?:{text:string;rpcId:string}};
const plain=(value:unknown):value is Record<string,any>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const absolute=(value:unknown)=>typeof value==='string'&&value.length<=4096&&isAbsolute(value);
export function validateDshConfig(value:unknown):DshPluginConfig{
  if(!plain(value)||Object.keys(value).some(key=>!['auditId','sessionId','model','cwd','enableProactive','parentControl','initialBackend','auditFile','launcher','acceptanceInput'].includes(key))
    ||!uuid(value.auditId)||!uuid(value.sessionId)||!absolute(value.cwd)||!plain(value.launcher))fail('DSH_CONFIG_INVALID');
  const launcher=value.launcher;
  if(Object.keys(launcher).some(key=>!['mode','pythonPath','scriptPath','corePath','nodePath','runtimeRoot','maxCalls','allowExistingDpapi','neuralRuntime','credentialRoot'].includes(key))
    ||!['resident','synthetic'].includes(launcher.mode)||![launcher.corePath,launcher.nodePath,launcher.runtimeRoot].every(absolute)
    ||!Number.isSafeInteger(launcher.maxCalls)||launcher.maxCalls<0||launcher.maxCalls>32)fail('DSH_CONFIG_INVALID');
  if(launcher.mode==='resident'&&(!absolute(launcher.pythonPath)||!absolute(launcher.scriptPath)
    ||(launcher.maxCalls>0&&launcher.allowExistingDpapi!==true)))fail('DSH_CONFIG_INVALID');
  if(launcher.mode==='synthetic'&&(launcher.allowExistingDpapi||launcher.neuralRuntime||launcher.credentialRoot!==undefined))fail('DSH_CONFIG_INVALID');
  if(launcher.neuralRuntime!==undefined&&!absolute(launcher.neuralRuntime))fail('DSH_CONFIG_INVALID');
  if(launcher.credentialRoot!==undefined){
    if(!absolute(launcher.credentialRoot))fail('DSH_CONFIG_INVALID');
    try{if(!statSync(launcher.credentialRoot).isDirectory())fail('DSH_CONFIG_INVALID');}catch{fail('DSH_CONFIG_INVALID');}
  }
  if(value.model!==undefined&&value.model!=='coupled')fail('DSH_CONFIG_INVALID');
  if(value.initialBackend!==undefined&&!['baseline','no-state','flywire'].includes(value.initialBackend))fail('DSH_CONFIG_INVALID');
  for(const key of ['enableProactive','parentControl','auditFile'])
    if(value[key]!==undefined&&typeof value[key]!=='boolean')fail('DSH_CONFIG_INVALID');
  if(value.acceptanceInput!==undefined){const input=value.acceptanceInput;
    if(!plain(input)||Object.keys(input).some(k=>!['text','rpcId'].includes(k))||typeof input.text!=='string'||!input.text.trim()||input.text.length>4096
      ||typeof input.rpcId!=='string'||!input.rpcId.trim()||input.rpcId.length>128)fail('DSH_CONFIG_INVALID');}
  return structuredClone(value) as DshPluginConfig;
}
async function claimAcceptance(config:DshPluginConfig):Promise<boolean>{
  let file;try{file=await open(join(config.cwd,`acceptance-${config.auditId}.claimed`),'wx');}
  catch(error){if(plain(error)&&error.code==='EEXIST')return false;throw new Error('DSH_ACCEPTANCE_CLAIM_FAILED');}
  try{await file.writeFile(JSON.stringify({auditId:config.auditId,sessionId:config.sessionId,rpcId:config.acceptanceInput!.rpcId,
    textHash:createHash('sha256').update(config.acceptanceInput!.text).digest('hex')})+'\n');await file.sync();}
  finally{await file.close();}return true;
}
/** Public metadata only. Consumption precedes spawn/key access and is never refunded. */
async function claimResidentBoot(config:DshPluginConfig):Promise<void>{
  let file;try{file=await open(join(config.launcher.runtimeRoot,`session-${config.sessionId}.boot-claimed`),'wx');}
  catch(error){if(plain(error)&&error.code==='EEXIST')fail('DSH_BOOT_ALREADY_CLAIMED');fail('DSH_BOOT_CLAIM_FAILED');}
  try{await file.writeFile(JSON.stringify({sessionId:config.sessionId,auditId:config.auditId,maxCalls:config.launcher.maxCalls,
    configSha256:createHash('sha256').update(JSON.stringify(config)).digest('hex')})+'\n');await file.sync();}
  catch{fail('DSH_BOOT_CLAIM_FAILED');}finally{await file.close();}
}
type Sdk={LlmAdapter:new()=>any;createUserMessage:(options:any)=>any};
type Dependencies={startBackend?:(config:DshBackendConfig)=>Promise<DshCoupledBackend>;input?:Readable;output?:Writable;
  onCleanupReady?:(cleanup:()=>Promise<boolean>)=>void;interruptHost?:(graceful:boolean)=>void};
const safeKeys=new Set(['auditId','kind','status','code','sessionId','provider','model','turn','messageId','deliveryId','requests','corePaused',
  'available','workerResident','backend','replySha256','replyCharacters','completed','cancelled','duplicate','disposed','realModelCalls','providerCalls','syntheticCalls',
  'appraisalStatus','recallCount','sourceRefCount','elapsedMs','usageSnapshotKnown']);

/** Exact SDK entrypoints are supplied by the installed plugin; tests inject synthetic objects. */
export async function mountDshCoupled(ctx:any,inputConfig:unknown,sdk:Sdk,dependencies:Dependencies={}){
  const config=validateDshConfig(inputConfig),provider='companion-core',model='coupled';
  if(ctx.agents.get(config.sessionId)||ctx.sessions.get(config.sessionId))fail('DSH_DEDICATED_ID_ALREADY_LIVE');
  const input=dependencies.input??process.stdin,output=dependencies.output??process.stdout;
  let backend:DshCoupledBackend|undefined,bridge:DshCoupledBridge|undefined,handle:any;
  let startup:Promise<DshCoupledBackend>|undefined,creating:Promise<any>|undefined;
  let disposed=false,finalSealed=false,outputFailed=false,pendingBytes=0,controlPending=0,parentClosing=false,manualRequested=false,controlBuffer=Buffer.alloc(0);
  let cleanupTask:Promise<boolean>|null=null;const offs:Array<()=>void>=[],flushWaiters:Array<()=>void>=[];
  const emit=(event:Record<string,unknown>)=>{
    if(outputFailed||finalSealed)return;
    const safe=Object.fromEntries(Object.entries({auditId:config.auditId,sessionId:config.sessionId,...event}).filter(([key])=>safeKeys.has(key)));
    const line='COMPANION_COUPLED_EVENT:'+JSON.stringify(safe)+'\n',bytes=Buffer.byteLength(line);
    if(bytes>4096||pendingBytes+bytes>65536){outputFailed=true;void cleanup();return;}
    pendingBytes+=bytes;try{output.write(line,error=>{pendingBytes-=bytes;if(error){outputFailed=true;void cleanup();}
      if(pendingBytes===0)for(const resolve of flushWaiters.splice(0))resolve();});}
    catch{pendingBytes-=bytes;outputFailed=true;void cleanup();}
  };
  const flush=async()=>{if(pendingBytes){let timer:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([new Promise<void>(resolve=>flushWaiters.push(resolve)),new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]);
    if(timer)clearTimeout(timer);}return pendingBytes===0&&!outputFailed;};
  const status=async(kind='status')=>{if(!backend)return;try{const state=await backend.command('status');
    emit({kind,status:'ready',provider,model,backend:state.backend,corePaused:state.paused===true,available:state.available===true,workerResident:state.workerResident===true,
      requests:state.requests.total,providerCalls:state.requests.total,syntheticCalls:config.launcher.mode==='synthetic'?state.requests.total:0,
      realModelCalls:config.launcher.mode==='resident'?state.requests.total:0,usageSnapshotKnown:true});return state;}catch{emit({kind,status:'unavailable',usageSnapshotKnown:false});return null;}};
  const cancel=async()=>{try{await handle?.agent.cancel({kind:'user'},{keepInbox:true});}catch{}};
  function cleanup():Promise<boolean>{
    if(cleanupTask)return cleanupTask;disposed=true;
    cleanupTask=(async()=>{
      for(const off of offs.splice(0))try{off();}catch{}
      // Startup is owned even before the child or native handle becomes ready.
      try{backend??=await startup;}catch{}
      try{handle??=await creating;}catch{}
      const cancelling=cancel();let graceful=true;
      try{if(bridge)await bridge.pause();await cancelling;const result=bridge?await bridge.dispose():await backend?.close();graceful=result?.graceful??true;}
      catch{graceful=false;try{await backend?.close();}catch{}}
      try{await handle?.dispose();}catch{graceful=false;}
      emit({kind:'disposed',status:graceful&&!outputFailed?'closed':'partial',disposed:true,corePaused:true,available:false,
        workerResident:false,realModelCalls:bridge?.status.realModelCalls??0,usageSnapshotKnown:bridge?.status.usageSnapshotKnown??false});
      finalSealed=true;
      const flushed=await flush();await new Promise<void>(resolve=>setImmediate(resolve));
      output.off('error',onOutputFailure);output.off('close',onOutputFailure);
      return flushed&&graceful&&!outputFailed;
    })();return cleanupTask;
  }
  const shutdown=async()=>{if(parentClosing)return;parentClosing=true;const closed=await cleanup();
    // DSH's official SIGTERM handler exits 0; SIGINT exits 130 for partial cleanup.
    (dependencies.interruptHost??(graceful=>process.emit(graceful?'SIGTERM':'SIGINT')))(closed);};
  const safeFailure=()=>{emit({kind:'host-event',status:'rejected'});void bridge?.pause();};
  const onControl=(chunk:Buffer|string)=>{
    if(disposed)return;const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    if(controlBuffer.length+data.length>16384){void shutdown();return;}controlBuffer=Buffer.concat([controlBuffer,data]);
    for(;;){const at=controlBuffer.indexOf(10);if(at<0)break;const line=controlBuffer.subarray(0,at).toString('utf8');controlBuffer=controlBuffer.subarray(at+1);
      if(line.length>4096){void shutdown();return;}if(!line.startsWith('COMPANION_CONTROL:'))continue;
      let control;try{control=JSON.parse(line.slice('COMPANION_CONTROL:'.length));}catch{continue;}
      if(!plain(control)||control.auditId!==config.auditId||Object.keys(control).some(key=>!['auditId','action'].includes(key)))continue;
      if(control.action==='shutdown'){void shutdown();return;}
      if(!['status','pause','resume','switch-baseline','switch-no-state','switch-flywire'].includes(control.action)||controlPending>=4)continue;controlPending++;
      void (async()=>{try{
        if(control.action==='pause'){manualRequested=true;const pausing=bridge?.manualPause();await cancel();await pausing;}
        if(control.action==='resume'){if(!bridge)fail('DSH_NOT_READY');await bridge.manualResume();manualRequested=false;}
        if(control.action.startsWith('switch-')){if(!bridge)fail('DSH_NOT_READY');const stopping=cancel();await bridge.switchBackend(control.action.slice(7));await stopping;}
        await status(control.action);}
        finally{controlPending--;}})().catch(()=>{emit({kind:control.action,status:'rejected',code:'DSH_CONTROL_REJECTED'});void bridge?.pause();});
    }
    if(controlBuffer.length>4096)void shutdown();
  };
  const onParentEnd=()=>{if(!disposed)void shutdown();};
  const onOutputFailure=()=>{outputFailed=true;void cleanup();};
  output.on('error',onOutputFailure);output.on('close',onOutputFailure);
  try{
    // Register ownership before any async startup or native handle creation.
    ctx.effect(()=>async()=>{await cleanup();});
    dependencies.onCleanupReady?.(cleanup);
    // Assign ownership before activating any input callback.
    startup=(async()=>{
      if(config.launcher.mode==='resident')await claimResidentBoot(config);
      if(disposed)fail('DSH_START_CANCELLED');
      return (dependencies.startBackend??DshStdioBackend.start)(config.launcher);
    })();
    if(config.parentControl){
      if((input as any).isTTY)fail('DSH_PARENT_PIPE_REQUIRED');
      input.on('data',onControl);input.once('end',onParentEnd);input.once('close',onParentEnd);input.once('error',onParentEnd);
      offs.push(()=>{input.off('data',onControl);input.off('end',onParentEnd);input.off('close',onParentEnd);input.off('error',onParentEnd);});input.resume();
      if(input.readableEnded||input.destroyed)void shutdown();
    }
    backend=await startup;if(disposed){await cleanup();return {cleanup,bridge,backend};}
    class CompanionAdapter extends sdk.LlmAdapter{
      providerInfo(id:string){if(id!==provider)fail('DSH_AUTHORITY_MISMATCH');return {id,name:'Companion Core (session-only)'};}
      async listModels(id:string){if(id!==provider)fail('DSH_AUTHORITY_MISMATCH');return [{provider:id,id:model,name:'Companion coupled session'}];}
      async resolveModel(id:string,selected:string,signal?:AbortSignal){signal?.throwIfAborted();if(id!==provider||selected!==model)fail('DSH_AUTHORITY_MISMATCH');
        return {provider:id,id:model,name:'Companion coupled session'};}
      async *stream(options:any){if(disposed||!bridge)fail('DSH_NOT_READY');yield* bridge.stream(options);}
    }
    offs.push(ctx.llm.registerAdapter([provider],new CompanionAdapter()));
    creating=ctx.agents.create({sessionId:config.sessionId,agentOptions:{provider,model},meta:{cwd:config.cwd}});
    handle=await creating;if(disposed){await cleanup();return {cleanup,bridge,backend};}
    const agent=handle.agent;
    bridge=new DshCoupledBridge(backend,{sessionId:config.sessionId,provider,model,onEvent:emit,realProvider:config.launcher.mode==='resident',
      ...(config.enableProactive?{publishPrepared:async(deliveryId:string,attach:(id:string)=>boolean)=>{
        if(disposed)return false;try{return await agent.runMaintenance((signal:AbortSignal)=>{
          if(signal.aborted||disposed)return false;const message=sdk.createUserMessage({content:[{type:'text',text:bridge!.preparedNotice(deliveryId)}],
            source:{kind:'companion-prepared-delivery'}});
          if(!attach(message.id))return false;agent.followup(message);return true;});}catch{return false;}
      },cancelNativePrepared:()=>{void cancel();}}:{})});
    offs.push(agent.ctx.on('agent/inbox/inserted',({message}:any)=>{try{bridge!.inboxInserted(message);}catch{safeFailure();}}));
    offs.push(agent.ctx.on('agent/inbox/claimed',({message,turn}:any)=>{try{bridge!.inboxClaimed(message,turn);}catch{safeFailure();}}));
    offs.push(agent.ctx.on('agent/turn-stopping',({turn,signal}:any)=>{try{bridge!.turnStopping(turn,signal);}catch{safeFailure();}}));
    offs.push(ctx.on('session/event',(session:any,event:any)=>{
      if(session!==agent.session||disposed)return;return bridge!.nativeEvent(config.sessionId,event).catch(safeFailure);
    },{global:true}));
    // Official interactive slash commands are agent-scoped; ordinary chat text
    // is never parsed as management authority. This adds no frontend bundle.
    agent.ctx.inject(['commands'],(commandCtx:any)=>{
      if(disposed)return;
      for(const action of ['pause','resume','status','switch']){
        const off=commandCtx.commands.register({name:`companion-${action}`,description:`Companion Core ${action}`,recordInput:false,
          ...(action==='switch'?{input:{hint:'baseline|no-state|flywire'}}:{}),
          handler:async(invocation:any)=>{
            if(disposed||invocation?.agent!==agent||typeof invocation.rawInput!=='string'||invocation.rawInput.length>128
              ||!invocation.signal||invocation.signal.aborted||(invocation.attachments?.length??0)>0)
              return {kind:'error',text:'Companion control rejected.'};
            const argument=invocation.rawInput.trim();
            if(action==='switch'?!['baseline','no-state','flywire'].includes(argument):argument!=='')
              return {kind:'error',text:'Companion control argument rejected.'};
            if(controlPending>=(action==='pause'?8:4))return {kind:'error',text:'Companion control is busy.'};
            controlPending++;const onAbort=()=>{void bridge!.manualPause();};invocation.signal.addEventListener('abort',onAbort,{once:true});
            try{
              if(action==='pause'){manualRequested=true;const pausing=bridge!.manualPause();await cancel();await pausing;}
              if(action==='resume'){await bridge!.manualResume();manualRequested=false;}
              if(action==='switch'){manualRequested=true;const switching=bridge!.switchBackend(argument as 'baseline'|'no-state'|'flywire');await cancel();await switching;}
              if(disposed||invocation.signal.aborted)throw new Error('DSH_CONTROL_CANCELLED');
              const state=await status(`command-${action}`);
              if(!state||disposed||invocation.signal.aborted)throw new Error('DSH_CONTROL_UNAVAILABLE');
              const backendName=['baseline','no-state','flywire'].includes(state.backend)?state.backend:'unknown';
              const calls=Number.isSafeInteger(state.requests?.total)&&state.requests.total>=0?state.requests.total:'unknown';
              return {kind:'success',text:`Companion: ${backendName}; paused=${state.paused===true}; available=${state.available===true}; calls=${calls}/${config.launcher.maxCalls}.`};
            }catch{emit({kind:`command-${action}`,status:'rejected',code:'DSH_CONTROL_REJECTED'});await bridge!.pause();
              return {kind:'error',text:'Companion control failed; output is paused.'};}
            finally{controlPending--;invocation.signal.removeEventListener('abort',onAbort);}
          }});
        if(typeof off==='function')offs.push(off);
      }
    });
    if(manualRequested)await bridge.manualPause();
    if(config.initialBackend&&config.initialBackend!=='baseline')await bridge.switchBackend(config.initialBackend);
    if(disposed){await cleanup();return {cleanup,bridge,backend};}
    emit({kind:'plugin-ready',status:config.launcher.mode,provider,model,backend:config.initialBackend??'baseline',requests:0,corePaused:true,available:false,realModelCalls:0});
    if(config.acceptanceInput){
      const claimed=await claimAcceptance(config);
      if(claimed&&!disposed){const message=sdk.createUserMessage({content:[{type:'text',text:config.acceptanceInput.text}],
        source:{kind:'user',rpcId:config.acceptanceInput.rpcId}});agent.followup(message);await ctx.sessions.flush(agent.session);
        emit({kind:'acceptance-trigger',status:'claimed',messageId:message.id});}
      else if(!disposed)emit({kind:'acceptance-trigger',status:'already-claimed'});
    }
    return {cleanup,bridge,backend};
  }catch(error){const code=plain(error)&&['DSH_BOOT_ALREADY_CLAIMED','DSH_BOOT_CLAIM_FAILED'].includes(error.code)?error.code:'DSH_PLUGIN_START_FAILED';
    emit({kind:'plugin-start',status:'failed',code});await cleanup();throw new Error('COMPANION_PLUGIN_START_FAILED');}
}
