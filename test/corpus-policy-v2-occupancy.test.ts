import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { canonical,hash } from '../src/wf1-json.ts';
import { corpusTransportCompletion } from '../src/corpus-response-policy.ts';
import { fixture } from './corpus-production-fixture.ts';
import { qaFixture } from './corpus-qa-fixture.ts';
import { createProductionTransport,runCorpusProduction } from '../src/corpus-production-runner.ts';
import { createQaTransport,runQualityAudit } from '../src/corpus-qa-runner.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
test('completion evidence requires settled Promise and one synchronous boolean probe after send',async()=>{
  for(const fault of ['missing','late','double','throw','nonboolean','pending'] as const){const o=corpusTransportCompletion();await o.observe(async register=>{if(fault==='missing')return;if(fault==='late')await Promise.resolve();register(fault==='throw'?()=>{throw Error('synthetic probe');}:fault==='nonboolean'?(()=>1) as unknown as ()=>boolean:fault==='pending'?()=>false:()=>true);if(fault==='double')register(()=>true);});assert.equal(o.released(true),false,fault);}
  const good=corpusTransportCompletion();await good.observe(async register=>{register(()=>true);});assert.equal(good.released(true),true);
  const before=corpusTransportCompletion();await assert.rejects(before.observe(async()=>{throw Error('synthetic pre-send');}));assert.equal(before.released(false),true);assert.equal(before.released(true),false);
  const outstanding=corpusTransportCompletion(),hold=deferred(),pending=outstanding.observe(async register=>{register(()=>true);await hold.promise;});assert.equal(outstanding.released(true),false);hold.resolve();await pending;assert.equal(outstanding.released(true),true);
});
async function job(kind:'production'|'qa'){
  if(kind==='production'){const f=fixture(8,undefined,true);return {store:f.store,run:(transport:any,signal?:AbortSignal)=>runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport,...(signal?{signal}:{})}),close:()=>f.store.close()};}
  const f=await qaFixture(8,undefined,false,hash('qa occupancy synthetic'),true);return {store:f.store,run:(transport:any,signal?:AbortSignal)=>runQualityAudit(f.spec,{store:f.store,source:f.source,selection:f.selection,objective:f.objective,transport,...(signal?{signal}:{})}),close:()=>{f.store.close();f.source.close();}};
}
for(const kind of ['production','qa'] as const)for(const stalled of ['fetch','reader'] as const)test(kind+' native factory proves underlying '+stalled+' is still occupied after internal abort',async()=>{
  const f=await job(kind),started=deferred(),hold=deferred(),abort=new AbortController();let calls=0,registered=0,cancelled=false,probe:(()=>boolean)|undefined;
  const fetcher:typeof fetch=async()=>{
    if(stalled==='fetch'){started.resolve();await hold.promise;throw Error('SYNTHETIC late fetch rejection');}
    let first=true;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(first){first=false;controller.enqueue(Buffer.from('{'));}else started.resolve();},cancel(){cancelled=true;return hold.promise;}}),{headers:{'content-type':'application/json'}});
  };
  const native=kind==='production'?createProductionTransport({deepseek:'SYNTHETIC_NOT_A_CREDENTIAL'},{fetch:fetcher}):createQaTransport({deepseek:'SYNTHETIC_NOT_A_CREDENTIAL',together:'SYNTHETIC_NOT_A_CREDENTIAL'},{fetch:fetcher});
  try{const running=f.run((request:any)=>{calls++;return native({...request,signal:abort.signal,registerNativeCompletion:(value:()=>boolean)=>{registered++;probe=value;request.registerNativeCompletion(value);}});});await started.promise;abort.abort();const s=await running;
    assert.equal(s.status,'FENCED');assert.ok(s.failureCodes[kind==='production'?'CPR_TRANSPORT_IN_FLIGHT':'CQA_TRANSPORT_IN_FLIGHT']);assert.equal(calls,1);assert.equal(registered,1,'actual native factory registers synchronously');assert.equal(probe!(),false);if(stalled==='reader')assert.ok(cancelled);
    const state=f.store.snapshot()!,attempt=state.attempts[0]!;assert.notEqual(attempt.settledAtMs,null);assert.equal(attempt.result?.outcome,'SUBMIT_UNKNOWN');const frozen=canonical(state);hold.resolve();await immediate();assert.equal(probe!(),true);assert.equal(canonical(f.store.snapshot()),frozen);assert.equal(calls,1);
  }finally{hold.resolve();await immediate();f.close();}
});
for(const kind of ['production','qa'] as const)test(kind+' outer deadline never releases a transport Promise that ignores abort',async()=>{
  const f=await job(kind),started=deferred(),hold=deferred(),abort=new AbortController();let calls=0;
  try{const running=f.run(async(request:any)=>{calls++;request.registerNativeCompletion(()=>true);await request.authorizeSend(()=>{started.resolve();return hold.promise;});throw Error('SYNTHETIC late outer transport rejection');},abort.signal);await started.promise;abort.abort();const s=await running;assert.equal(s.status,'FENCED');assert.ok(s.failureCodes[kind==='production'?'CPR_TRANSPORT_IN_FLIGHT':'CQA_TRANSPORT_IN_FLIGHT']);assert.equal(calls,1);const state=f.store.snapshot()!,attempt=state.attempts[0]!;assert.notEqual(attempt.settledAtMs,null);assert.equal(attempt.result,null);const frozen=canonical(state);hold.resolve();await immediate();assert.equal(canonical(f.store.snapshot()),frozen);assert.equal(calls,1);
  }finally{hold.resolve();await immediate();f.close();}
});
for(const kind of ['production','qa'] as const)for(const declared of ['999999999','invalid'] as const)test(kind+' rejected Content-Length '+declared+' retains its unread body until cancellation settles',async()=>{
  const f=await job(kind),started=deferred(),hold=deferred(),abort=new AbortController();let calls=0,cancelled=false,probe:(()=>boolean)|undefined;
  const fetcher:typeof fetch=async()=>{started.resolve();return new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;return hold.promise;}}),{headers:{'content-type':'application/json','content-length':declared}});};
  const native=kind==='production'?createProductionTransport({deepseek:'SYNTHETIC_NOT_A_CREDENTIAL'},{fetch:fetcher}):createQaTransport({deepseek:'SYNTHETIC_NOT_A_CREDENTIAL',together:'SYNTHETIC_NOT_A_CREDENTIAL'},{fetch:fetcher});
  try{const running=f.run((request:any)=>{calls++;return native({...request,signal:abort.signal,registerNativeCompletion:(value:()=>boolean)=>{probe=value;request.registerNativeCompletion(value);}});});await started.promise;await immediate();assert.ok(cancelled,'header rejection must initiate body cleanup');assert.equal(probe!(),false,'header rejection is not resource release');abort.abort();const s=await running;assert.equal(s.status,'FENCED');assert.ok(s.failureCodes[kind==='production'?'CPR_TRANSPORT_IN_FLIGHT':'CQA_TRANSPORT_IN_FLIGHT']);assert.equal(calls,1);const state=f.store.snapshot()!,attempt=state.attempts[0]!;assert.notEqual(attempt.settledAtMs,null);assert.equal(attempt.result?.outcome,'SUBMIT_UNKNOWN');const frozen=canonical(state);hold.resolve();await immediate();assert.equal(probe!(),true);assert.equal(canonical(f.store.snapshot()),frozen);assert.equal(calls,1);
  }finally{abort.abort();hold.resolve();await immediate();f.close();}
});
