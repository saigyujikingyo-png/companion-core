import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical,hash,Wf1Error } from '../src/wf1-json.ts';
import { HostAuthority } from '../src/wf1-storage.ts';
import { TeacherProvider } from '../src/wf1-provider.ts';
import { MODELS,ENDPOINTS } from '../src/wf1-types.ts';
import type { Authority } from '../src/wf1-types.ts';
import { checkFormat,FORMAT_PROFILE_DIGEST,FORMAT_RESERVE_MICRO_USD,FormatProbe,formatRequest,WF2_FORMAT } from '../src/wf2-format.ts';
import type { FormatSpec } from '../src/wf2-format.ts';
import { describeFormatWorker,formatBuildDigest,formatWorkerMain } from '../src/wf2-format-worker.ts';

const code=(expected:string)=>(error:unknown)=>error instanceof Wf1Error&&error.code===expected&&error.message===expected;
function fixture(realClock=false){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-synthetic-'))),root=join(base,'run'),hostRoot=join(base,'host');mkdirSync(root);mkdirSync(hostRoot);
  const authorityPath=join(hostRoot,'authority.json'),clock={value:realClock?Date.now():1000},key=Buffer.alloc(32,23);
  const authority:Authority={schemaVersion:'wf1-host/1',campaignId:'synthetic-format',revision:1,runtimeId:'synthetic-runtime',status:'ACTIVE',expiresAt:clock.value+WF2_FORMAT.campaignMs,head:null,
    rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}};
  writeFileSync(authorityPath,canonical(authority));
  const spec:FormatSpec={schemaVersion:'wf2-format/1',id:authority.campaignId,createdAt:clock.value,expiresAt:clock.value+WF2_FORMAT.campaignMs,sourceDigest:formatBuildDigest(),profileDigest:FORMAT_PROFILE_DIGEST};
  return {base,root,authorityPath,clock,key,spec,now:()=>clock.value};
}
type Fixture=ReturnType<typeof fixture>;
type Mock={mutate?:(index:number,target:unknown)=>string;usage?:(index:number)=>unknown;onSend?:(index:number)=>void;fetcher?:typeof fetch};
function mock(options:Mock={}){
  const ids:string[]=[],bodies:string[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    assert.equal(String(url),ENDPOINTS.deepseek);assert.equal(init!.redirect,'error');assert.equal(init!.method,'POST');
    const raw=String(init!.body),b=JSON.parse(raw) as {model:string;stream:boolean;max_tokens:number;response_format:{type:string};thinking:{type:string};messages:Array<{role:string;content:string}>};
    assert.deepEqual(b.messages.map(m=>m.role),['system','user']);assert.match(b.messages[0]!.content,/JSON/);assert.equal(b.model,MODELS.deepseek);assert.equal(b.stream,false);assert.equal(b.max_tokens,4096);assert.equal(b.response_format.type,'json_object');assert.equal(b.thinking.type,'disabled');
    const target=JSON.parse(b.messages[1]!.content) as unknown,index=ids.length;ids.push(['flat-1','flat-2','unicode-1','unicode-2','nested-1','nested-2'][index]!);bodies.push(raw);options.onSend?.(index);
    if(options.fetcher)return options.fetcher(url,init);
    const usage=options.usage?options.usage(index):{prompt_tokens:100,completion_tokens:200,total_tokens:300};
    return new Response(JSON.stringify({id:'synthetic-private-provider-id',model:MODELS.deepseek,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:options.mutate?options.mutate(index,target):JSON.stringify(target)}}],...(usage===undefined?{}:{usage})}),{status:200,headers:{'content-type':'application/json'}});
  };
  return {provider:new TeacherProvider({deepseek:'synthetic-key',together:null},{fetch:fetcher}),ids,bodies};
}
function probe(f:Fixture,m:ReturnType<typeof mock>){return FormatProbe.admit({...f,provider:m.provider});}
function payload(f:Fixture,action:string){return {version:1,action,runtimeRoot:f.root,authorityPath:f.authorityPath,expectedHead:JSON.parse(readFileSync(f.authorityPath,'utf8')).head,
  spec:f.spec,custodyKeyBase64:f.key.toString('base64'),credentials:{deepseek:null}};}
function files(root:string){return Object.fromEntries(readdirSync(root).map(n=>[n,hash(readFileSync(join(root,n)))]));}

test('six fixed requests bind explicit system JSON, shapes, replicates, model and worst-case reservation',()=>{
  assert.equal(FORMAT_RESERVE_MICRO_USD,10445);assert.equal(6*FORMAT_RESERVE_MICRO_USD,62670);assert.ok(62670<WF2_FORMAT.totalMicroUsd);
  const bodies=Array.from({length:6},(_,i)=>formatRequest(i));assert.equal(new Set(bodies).size,6);
  const targets=bodies.map(raw=>JSON.parse(JSON.parse(raw).messages[1].content));
  assert.equal(WF2_FORMAT.version,'wf2-format-profile/2');for(const target of targets){assert.equal(Object.hasOwn(target,'protocol'),false);assert.equal(Object.hasOwn(target,'caseId'),false);assert.equal(Object.hasOwn(target,'target'),false);}
  assert.equal(targets[4].items.length,12);assert.equal(targets[5].items.length,12);
  for(let i=0;i<6;i++)assert.deepEqual(checkFormat(i,JSON.stringify(targets[i])),{nativeJson:'PASS',strictProfile:'PASS',expectedEcho:'PASS'});
  assert.throws(()=>formatRequest(6));assert.throws(()=>checkFormat(-1,'{}'));
});
test('native JSON, strict profile and exact echo are independent checks with no repair',()=>{
  assert.deepEqual(checkFormat(0,'{"x":1,"x":2}'),{nativeJson:'PASS',strictProfile:'FAIL',expectedEcho:'NOT_EVALUATED'});
  for(const raw of ['{"x":-0}','{"x":1e1}','{"x":1.0}'])assert.equal(checkFormat(0,raw).strictProfile,'FAIL');
  assert.deepEqual(checkFormat(0,'{}'),{nativeJson:'PASS',strictProfile:'PASS',expectedEcho:'FAIL'});
  for(const raw of ['```json\n{}\n```','{"x":}'])assert.deepEqual(checkFormat(0,raw),{nativeJson:'FAIL',strictProfile:'FAIL',expectedEcho:'NOT_EVALUATED'});
});
test('six synthetic completions consume before send, preserve case order and expose safe counts only',async()=>{
  const f=fixture();const m=mock({onSend:()=>{const cold=FormatProbe.inspect(f.root,f.authorityPath,f.spec,f.key,f.now);assert.equal(cold.calls,m.ids.length);assert.equal(cold.cases.at(-1)!.outcome,'UNSETTLED');assert.equal(cold.verdict,'NOT_PASSED');}}),p=probe(f,m);
  try{const r=await p.run();assert.equal(r.status,'COMPLETED');assert.equal(r.verdict,'FORMAT_CASES_PASS');assert.equal(r.calls,6);assert.equal(r.estimatedReserveMicroUsd,62670);assert.equal(r.usage.input,600);assert.equal(r.usage.completion,1200);assert.equal(r.transportLane,'SYNTHETIC_FIXTURE');
    assert.deepEqual(m.ids,['flat-1','flat-2','unicode-1','unicode-2','nested-1','nested-2']);assert.deepEqual(m.bodies,Array.from({length:6},(_,i)=>formatRequest(i)));
    const text=JSON.stringify(r);for(const marker of ['synthetic-key','synthetic-private-provider-id','requestRef','finalRef','requestCommitment','public-probe-A',f.root])assert.ok(!text.includes(marker));
    await assert.rejects(p.run(),code('WF2_ALREADY_CONSUMED'));assert.equal(m.ids.length,6);
  }finally{p.close();}
});
test('known-use format failures continue only remaining preselected cases and never pass the batch',async()=>{
  const f=fixture(),m=mock({mutate:(i,t)=>i===0?'{"broken":}':i===1?'{"duplicate":1,"duplicate":2}':i===2?'{}':JSON.stringify(t)}),p=probe(f,m);
  try{const r=await p.run();assert.equal(r.status,'COMPLETED');assert.equal(r.calls,6);assert.equal(r.verdict,'NOT_PASSED');assert.equal(r.cases[0]!.format!.nativeJson,'FAIL');assert.equal(r.cases[1]!.format!.strictProfile,'FAIL');assert.equal(r.cases[2]!.format!.expectedEcho,'FAIL');assert.equal(r.cases[5]!.format!.expectedEcho,'PASS');}finally{p.close();}
});
test('missing or inconsistent usage stops permanently after first consumed call without a refund',async()=>{
  for(const usage of [undefined,{prompt_tokens:1,completion_tokens:2,total_tokens:4}]){
    const f=fixture(),m=mock({usage:()=>usage}),p=probe(f,m);try{const r=await p.run();assert.equal(r.status,'STOPPED');assert.equal(r.code,'WF2_UNRECONCILED');assert.equal(r.calls,1);assert.equal(r.usage.unknownCalls,1);assert.equal(r.usage.input,0);assert.equal(r.estimatedReserveMicroUsd,10445);assert.equal(r.verdict,'NOT_PASSED');}finally{p.close();}
    assert.throws(()=>probe(f,m),code('WF2_ALREADY_CONSUMED'));assert.equal(m.ids.length,1);
  }
});
test('over-reservation usage stops before another call',async()=>{
  const f=fixture(),m=mock({usage:()=>({prompt_tokens:18433,completion_tokens:4096,total_tokens:22529})}),p=probe(f,m);
  try{const r=await p.run();assert.equal(r.code,'WF2_USAGE_OVER_RESERVE');assert.equal(r.calls,1);assert.equal(r.verdict,'NOT_PASSED');}finally{p.close();}
});
test('transport failure stays UNKNOWN and cannot be retried by the same or a new owner',async()=>{
  const f=fixture(),m=mock({fetcher:async()=>{throw new Error('private failure body');}}),p=probe(f,m);
  try{const r=await p.run();assert.equal(r.calls,1);assert.equal(r.cases[0]!.outcome,'SUBMIT_UNKNOWN');assert.equal(r.usage.unknownCalls,1);assert.equal(r.verdict,'NOT_PASSED');await assert.rejects(p.run(),code('WF2_ALREADY_CONSUMED'));}finally{p.close();}
  assert.throws(()=>probe(f,m),code('WF2_ALREADY_CONSUMED'));assert.equal(m.ids.length,1);
});
test('current authority is checked after durable consume and before actual fetch',async()=>{
  const f=fixture(),m=mock(),original=m.provider.submit.bind(m.provider);let entered=false;
  m.provider.submit=async(...args)=>{entered=true;new HostAuthority(f.authorityPath,f.spec.id,f.now).control('REVOKED');return original(...args);};
  const p=probe(f,m);try{const r=await p.run();assert.equal(entered,true);assert.equal(r.calls,null);assert.equal(m.ids.length,0);assert.equal(r.status,'RECONCILE_REQUIRED');assert.equal(r.countCompleteness,'STALE_OR_UNKNOWN');assert.equal(r.cases[0]!.outcome,'UNSETTLED');assert.equal(r.verdict,'NOT_PASSED');}finally{p.close();}
});
test('pause and cancel abort locally and reject a late output without settling or continuing',async()=>{
  for(const action of ['pause','cancel'] as const){
    const f=fixture();let release!:(response:Response)=>void;let sent!:()=>void;const sentPromise=new Promise<void>(resolve=>{sent=resolve;});
    const m=mock({fetcher:async()=>{sent();return new Promise<Response>(resolve=>{release=resolve;});}}),p=probe(f,m),running=p.run();await sentPromise;p[action]();const r=await running;
    assert.equal(r.calls,null);assert.equal(r.status,'RECONCILE_REQUIRED');assert.equal(r.verdict,'NOT_PASSED');assert.equal(r.cases[0]!.outcome,'UNSETTLED');const before=files(f.root);
    release(new Response('{}',{status:200,headers:{'content-type':'application/json'}}));await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(files(f.root),before);assert.equal(m.ids.length,1);p.close();
  }
});
test('external withdrawal watcher aborts an in-flight request without polling the provider again',async()=>{
  const f=fixture();let sent!:()=>void;const ready=new Promise<void>(resolve=>{sent=resolve;});
  const m=mock({fetcher:async(_url,init)=>{sent();return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}}),p=probe(f,m),running=p.run();await ready;
  new HostAuthority(f.authorityPath,f.spec.id,f.now).control('REVOKED');try{const r=await running;assert.equal(r.calls,null);assert.equal(r.status,'RECONCILE_REQUIRED');assert.equal(r.verdict,'NOT_PASSED');assert.equal(m.ids.length,1);}finally{p.close();}
});
test('clock rollback or deadline advancement cannot settle a successful-looking response',async()=>{
  for(const value of [999,122000]){const f=fixture(),m=mock({onSend:()=>{f.clock.value=value;}}),p=probe(f,m);try{const r=await p.run();assert.equal(r.calls,value===999?null:1);assert.equal(r.verdict,'NOT_PASSED');assert.equal(r.cases[0]!.outcome,'UNSETTLED');assert.equal(m.ids.length,1);}finally{p.close();}}
});
test('cold inspection is byte-preserving, does not decrypt artifacts and never authenticates a PASS',async()=>{
  const f=fixture(),m=mock(),p=probe(f,m);await p.run();p.close();
  // Corrupt only a private payload. Inspection reads the authenticated ledger, never this payload.
  const artifact=readdirSync(f.root).find(n=>n.endsWith('.bin'))!;writeFileSync(join(f.root,artifact),'inert broken ciphertext');const before=files(f.root),host=files(join(f.base,'host'));
  const r=FormatProbe.inspect(f.root,f.authorityPath,f.spec,f.key,f.now);assert.equal(r.status,'RECORDED_CLAIMS_ONLY');assert.equal(r.verdict,'NOT_PASSED');assert.equal(r.automaticResume,false);assert.equal(r.calls,6);assert.deepEqual(files(f.root),before);assert.deepEqual(files(join(f.base,'host')),host);
  assert.throws(()=>FormatProbe.inspect(f.root,f.authorityPath,f.spec,Buffer.alloc(32,24),f.now),code('WF2_LEDGER_CORRUPT'));
});
test('half commit cannot misreport a stale zero as an authoritative unconsumed run',async()=>{
  const f=fixture(),m=mock(),original=HostAuthority.prototype.commitHead;let writes=0;
  HostAuthority.prototype.commitHead=function(expected:string|null,next:string){if(++writes===2)throw new Wf1Error('WF2_SYNTHETIC_HALF_COMMIT');return original.call(this,expected,next);};
  let p:FormatProbe|undefined;
  try{p=probe(f,m);const r=await p.run();assert.equal(r.status,'RECONCILE_REQUIRED');assert.equal(r.code,'WF2_COMMIT_UNKNOWN');assert.equal(r.countCompleteness,'STALE_OR_UNKNOWN');
    assert.equal(r.calls,null);assert.equal(r.estimatedReserveMicroUsd,null);assert.equal(r.estimatedUsageMicroUsd,null);for(const field of ['knownCalls','unknownCalls','input','completion'] as const)assert.equal(r.usage[field],null);
    assert.equal(r.verdict,'NOT_PASSED');assert.equal(m.ids.length,0);assert.throws(()=>probe(f,m),code('WF2_ALREADY_CONSUMED'));
  }finally{HostAuthority.prototype.commitHead=original;p?.close();}
});
test('consumed owner cannot be recreated even if the external head is improperly reset',async()=>{
  const f=fixture(),m=mock(),p=probe(f,m);await p.run();p.close();const a=JSON.parse(readFileSync(f.authorityPath,'utf8'));a.head=null;writeFileSync(f.authorityPath,canonical(a));
  const before=files(f.root);assert.throws(()=>probe(f,m),code('WF2_ALREADY_CONSUMED'));assert.deepEqual(files(f.root),before);assert.equal(m.ids.length,6);
});
test('concurrent or repeated run cannot obtain a second provider intent',async()=>{
  const f=fixture();let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});const m=mock({onSend:()=>release()}),p=probe(f,m),first=p.run();await ready;
  await assert.rejects(p.run(),code('WF2_ALREADY_CONSUMED'));await first;p.close();assert.equal(m.ids.length,6);
});
test('worker prepare is read-only and enforces closed payload, source and profile bindings',async()=>{
  const f=fixture(true),before=files(f.root),host=files(join(f.base,'host')),b=payload(f,'prepare');
  const r=await formatWorkerMain(canonical(b)) as {status:string};assert.equal(r.status,'PREPARED_NOT_STARTED');assert.deepEqual(files(f.root),before);assert.deepEqual(files(join(f.base,'host')),host);
  await assert.rejects(formatWorkerMain(canonical({...b,callerPath:'extra'})),code('WF1_FIELDS'));
  await assert.rejects(formatWorkerMain(canonical({...b,spec:{...f.spec,sourceDigest:'0'.repeat(64)}})),code('WF2_BUILD_MISMATCH'));
  await assert.rejects(formatWorkerMain(canonical({...b,spec:{...f.spec,profileDigest:'0'.repeat(64)}})),code('WF2_PROFILE'));
  await assert.rejects(formatWorkerMain(canonical({...b,action:'run'})),code('WF2_CREDENTIAL_UNAVAILABLE'));assert.deepEqual(files(f.root),before);
});
test('separate trusted worker control changes authority and prevents start',async()=>{
  const f=fixture(true);const r=await formatWorkerMain(canonical(payload(f,'pause'))) as {status:string};assert.equal(r.status,'PAUSED');assert.equal(readdirSync(f.root).length,0);
  await assert.rejects(formatWorkerMain(canonical(payload(f,'run'))),code('WF1_AUTHORITY'));
});
test('native CLI description is public; malformed command inputs are closed and redacted',()=>{
  const worker=fileURLToPath(new URL('../src/wf2-format-worker.ts',import.meta.url)),description=spawnSync(process.execPath,[worker,'--describe'],{encoding:'utf8'});
  assert.equal(description.status,0,description.stderr);assert.equal(JSON.parse(description.stdout).buildDigest,formatBuildDigest());
  const malformed=spawnSync(process.execPath,[worker],{encoding:'utf8',input:'{"credential":"synthetic-secret-marker",BROKEN'});
  assert.equal(malformed.status,1);assert.equal(JSON.parse(malformed.stdout).status,'REFUSED_OR_STOPPED');assert.ok(!malformed.stdout.includes('synthetic-secret-marker'));assert.ok(!malformed.stderr.includes('synthetic-secret-marker'));
  const d=describeFormatWorker();assert.equal(d.profileDigest,FORMAT_PROFILE_DIGEST);assert.equal(d.reservationMicroUsdAllCalls,62670);assert.equal(d.actions.includes('resume'),false);
});
