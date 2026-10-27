import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { canonical,copyJson,hash,parseJson,Wf1Error } from '../src/wf1-json.ts';
import { computeFormal,VERIFIER_CATALOG,verifyFormal } from '../src/wf1-verifier.ts';
import { estimateMicroUsd,PROFILE_DIGEST,validatePlan } from '../src/wf1-contract.ts';
import { CampaignLedger,createArtifactBroker,HostAuthority } from '../src/wf1-storage.ts';
import { providerBody,TeacherProvider } from '../src/wf1-provider.ts';
import { TeachingCampaign } from '../src/wf1-campaign.ts';
import { workerBuildDigest,workerMain } from '../src/wf1-worker.ts';
import { ENDPOINTS,MODELS,WF1 } from '../src/wf1-types.ts';
import type { Authority,CampaignSpec,FormalSpec,Json,Plan,Seal } from '../src/wf1-types.ts';

// Inert synthetic protocol fixtures, permanently labelled SYNTHETIC_FIXTURE.
// They are not actual curricula, sealed evaluation, or source-independence evidence.
const marker='SYNTHETIC_PRIVATE_MARKER_DO_NOT_PROJECT_70a069bd';
const error=(code:string)=>(e:unknown)=>e instanceof Wf1Error&&e.code===code&&e.message===code;
const formal=(n:number):FormalSpec=>({verifier:'json.pointer.v1',input:{document:{fixture:n},pointer:'/fixture'}});
function fixture(){
  const base=mkdtempSync(join(tmpdir(),'companion-wf1-fixture-')),root=join(base,'run'),hostRoot=join(base,'host');mkdirSync(root);mkdirSync(hostRoot);
  const authorityPath=join(hostRoot,'authority.json'),key=Buffer.alloc(32,7),now=1000,objective=marker;
  const authority:Authority={schemaVersion:'wf1-host/1',campaignId:'fixture-campaign',revision:1,runtimeId:'fixture-runtime',status:'ACTIVE',expiresAt:3_601_000,head:null,
    rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}};
  writeFileSync(authorityPath,canonical(authority));
  const spec:CampaignSpec={schemaVersion:'wf1-campaign/0.3',id:authority.campaignId,createdAt:now,expiresAt:now+WF1.campaignMs,
    sourceDigest:workerBuildDigest(),profileDigest:PROFILE_DIGEST,objectiveDigest:hash(objective),prices:{
      deepseek:{snapshotId:'fixture-ds',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000},
      together:{snapshotId:'fixture-gpt',inputMicroUsdPerMillion:150000,completionMicroUsdPerMillion:600000}}};
  return {base,root,authorityPath,key,now,objective,spec,authority};
}
const sealed=():Seal=>({version:'wf1-seal/1',rubric:marker,cases:Array.from({length:12},(_,i)=>({id:'sealed'+i,roots:['sealed-root'+i],formal:formal(100+i),target:100+i}))});
const plan=():Plan=>({version:'wf1-plan/1',plan:marker,families:Array.from({length:16},(_,i)=>({id:'family'+i,roots:['root'+i],split:[3,7,11,15].includes(i)?'dev':'train',formal:formal(i)})),pairedFamilyIds:Array.from({length:8},(_,i)=>'family'+i)});
type MockOptions={wrongFirst?:boolean;wrongLater?:boolean;unknownUsageAt?:number;overUsageAt?:number;onSend?:(operation:string,init:RequestInit)=>void};
function mockProvider(options:MockOptions={}){
  const operations:string[]=[];const fetcher:typeof fetch=async(url,init)=>{
    const body=JSON.parse(String(init!.body)) as {model:string;messages:Array<{content:string}>;stream:boolean;max_tokens:number};
    const p=JSON.parse(body.messages[0]!.content) as {operation:string;data:Record<string,unknown>};operations.push(p.operation);options.onSend?.(p.operation,init!);
    assert.ok(Buffer.byteLength(String(init!.body))<=WF1.requestBytes);assert.equal(init!.redirect,'error');assert.equal(body.stream,false);
    assert.equal(body.max_tokens,body.model===MODELS.together||p.operation==='seal'||p.operation==='plan'?4096:2048);
    assert.equal(String(url),body.model===MODELS.deepseek?ENDPOINTS.deepseek:ENDPOINTS.together);
    let content:unknown;
    if(p.operation==='seal')content=sealed();else if(p.operation==='plan')content=plan();else if(p.operation==='rubric')content={version:'wf1-rubric/1',rubric:marker};
    else if(p.operation==='review'||p.operation==='comparison_review')content={version:'wf1-review/1',disposition:'CLEAR',notes:marker};
    else{const n=(((p.data.formalInput as {input:{document:{fixture:number}}}).input).document).fixture;
      content={version:'wf1-candidate/1',target:p.operation==='candidate'&&(options.wrongFirst&&n===0||options.wrongLater&&n===7)?-99:n};}
    return new Response(JSON.stringify({id:'fixture-response-'+operations.length,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(content),
      ...(body.model===MODELS.together?{reasoning:marker}:{reasoning_content:null})}}],
      ...(options.unknownUsageAt===operations.length?{}:{usage:{prompt_tokens:options.overUsageAt===operations.length?18433:20,completion_tokens:30,total_tokens:options.overUsageAt===operations.length?18463:50}})}),{status:200,headers:{'content-type':'application/json'}});
  };
  return {provider:new TeacherProvider({deepseek:'synthetic-key',together:'synthetic-key'},{fetch:fetcher}),operations};
}
function campaign(f:ReturnType<typeof fixture>,provider:TeacherProvider){return TeachingCampaign.admitCampaign({...f,provider,now:()=>f.now});}

test('WF1 parser rejects duplicate keys, rounding/underflow, accessors and cumulative object bytes',()=>{
  assert.throws(()=>parseJson('{"x":0,"\\u0078":1}'),error('WF1_DUPLICATE_KEY'));
  for(const raw of ['1e-400','1.0000000000000001','-0','9007199254740992'])assert.throws(()=>parseJson(raw),error('WF1_NUMBER'));
  assert.equal(parseJson('-9007199254740991'),-Number.MAX_SAFE_INTEGER);
  assert.throws(()=>copyJson(Array(1000).fill('x'.repeat(65536))),error('WF1_JSON_LIMIT'));
  assert.throws(()=>copyJson({['x'.repeat(65537)]:0}),error('WF1_TEXT'));
  let accessed=false;const input={get x(){accessed=true;return 1;}};assert.throws(()=>copyJson(input),error('WF1_FIELDS'));assert.equal(accessed,false);
});
test('exact rational computation normalizes signs and GCD without trusting teacher expectations',()=>{
  const value=(numerator:string,denominator='1')=>({op:'value',numerator,denominator});
  const spec={verifier:'rational.evaluate.v1',input:{op:'mul',left:{op:'add',left:value('1','2'),right:value('1','3')},right:value('-3')}};
  assert.deepEqual(computeFormal(spec),{numerator:'-5',denominator:'2'});
  assert.equal(verifyFormal(spec,{numerator:'-5',denominator:'2'}).status,'VERIFIED');
  assert.equal(verifyFormal(spec,{numerator:'-10',denominator:'4'}).status,'CONTRADICTED');
  assert.equal(verifyFormal(spec,{numerator:'-5',denominator:'2',explanation:marker}).status,'CONTRADICTED');
  assert.equal(verifyFormal({verifier:'rational.evaluate.v1',input:{op:'div',left:value('1'),right:value('0')}},null).status,'UNSUPPORTED');
  assert.equal(verifyFormal({verifier:'rational.evaluate.v1',input:value('-0')},null).status,'UNSUPPORTED');
});
test('formal size/depth/precision and unknown executable nodes fail closed',()=>{
  const value=(n:string)=>({op:'value',numerator:n,denominator:'1'});
  assert.deepEqual(computeFormal({verifier:'rational.evaluate.v1',input:value(((1n<<128n)-1n).toString())}),{numerator:((1n<<128n)-1n).toString(),denominator:'1'});
  assert.equal(verifyFormal({verifier:'rational.evaluate.v1',input:value((1n<<128n).toString())},null).status,'UNSUPPORTED');
  let tree:unknown=value('1');for(let i=0;i<6;i++)tree={op:'add',left:tree,right:value('1')};
  assert.equal(verifyFormal({verifier:'rational.evaluate.v1',input:tree},null).status,'UNSUPPORTED');
  assert.equal(verifyFormal({verifier:'rational.evaluate.v1',input:{op:'eval',code:'process.exit()'}},null).status,'UNSUPPORTED');
});
test('RFC6901 escaping, exact subtree and array index grammar are independently checked',()=>{
  const document={'a/b':{'~key':[3,{constructor:'opaque'}]}};
  assert.deepEqual(computeFormal({verifier:'json.pointer.v1',input:{document,pointer:'/a~1b/~0key/1'}}),Object.assign(Object.create(null),{constructor:'opaque'}));
  for(const pointer of ['/a~2b','/a~1b/~0key/01','/a~1b/~0key/-','/missing'])assert.equal(verifyFormal({verifier:'json.pointer.v1',input:{document,pointer}},null).status,'UNSUPPORTED');
  assert.equal(verifyFormal(formal(3),4).status,'CONTRADICTED');
});
test('catalog is deeply immutable and code build evidence is stable for the same source',()=>{
  assert.ok(Object.isFrozen(VERIFIER_CATALOG.operations));assert.ok(Object.isFrozen(VERIFIER_CATALOG.operations[0]));
  assert.throws(()=>{VERIFIER_CATALOG.operations[0]!.id='changed';},TypeError);
  assert.equal(verifyFormal(formal(1),1).verifierBuild,verifyFormal(formal(2),2).verifierBuild);
});
test('custody encrypts exact bytes, denies train capability reads and refuses a lost key',()=>{
  const f=fixture(),ports=createArtifactBroker(f.root,f.spec.id,f.key),ref=ports.custody.put('sealed-test',marker);
  assert.equal(ports.custody.read(ref).toString('utf8'),marker);assert.throws(()=>ports.train.read(ref),error('WF1_ROLE_ACCESS'));
  const path=join(f.root,'custody-'+ref.id+'.bin'),before=readFileSync(path);assert.ok(!before.includes(Buffer.from(marker)));
  const wrong=createArtifactBroker(f.root,f.spec.id,Buffer.alloc(32,8));assert.throws(()=>wrong.custody.read(ref),error('WF1_SEALED_UNAVAILABLE'));assert.deepEqual(readFileSync(path),before);
});
test('seal prerequisite and request caps refuse before any teacher send',()=>{
  const f=fixture(),m=mockProvider(),c=campaign(f,m.provider);try{
    assert.throws(()=>c.reserveAttempt('candidate',providerBody('deepseek',{}),'family0'),error('WF1_SEAL_REQUIRED'));
    assert.throws(()=>providerBody('deepseek',{data:'x'.repeat(WF1.requestBytes)}),error('WF1_REQUEST_BYTES'));assert.equal(m.operations.length,0);
  }finally{c.close();}
});
test('consumption and both durable heads precede fetch; copied or repeated handles cannot dispatch',async()=>{
  const f=fixture();let c:TeachingCampaign;
  const m=mockProvider({onSend:()=>{const s=c.ledger.snapshot(),host=JSON.parse(readFileSync(f.authorityPath,'utf8')) as Authority;assert.equal(s.attempts.length,1);assert.equal(s.attempts[0]!.outcome,null);assert.equal(host.head,c.ledger.head);}});c=campaign(f,m.provider);
  try{const intent=c.reserveAttempt('seal',providerBody('deepseek',{operation:'seal',data:{}},'seal'));
    await assert.rejects(c.dispatchOnce({...intent}),error('WF1_INTENT_CAPABILITY'));await c.dispatchOnce(intent);
    await assert.rejects(c.dispatchOnce(intent),error('WF1_INTENT_CAPABILITY'));assert.equal(m.operations.length,1);
  }finally{c.close();}
});
test('crash after consume is retained on cold read and cannot be replayed or resumed',()=>{
  const f=fixture(),m=mockProvider(),c=campaign(f,m.provider);c.reserveAttempt('seal',providerBody('deepseek',{}));c.close();
  const cold=CampaignLedger.inspect(f.root,f.authorityPath,f.spec.id,f.key,()=>f.now);try{assert.equal(cold.snapshot().attempts.length,1);assert.equal(cold.snapshot().attempts[0]!.outcome,null);
    assert.throws(()=>cold.update('retry',()=>{}),error('WF1_READ_ONLY_RECONCILE'));assert.equal(m.operations.length,0);
  }finally{cold.close();}
});
test('valid-prefix ledger rollback is refused against the independent host high-water',()=>{
  const f=fixture(),m=mockProvider(),c=campaign(f,m.provider),old=readFileSync(join(f.root,'wf1-ledger.sqlite'));
  c.reserveAttempt('seal',providerBody('deepseek',{}));c.close();const restored=join(f.base,'restored');mkdirSync(restored);writeFileSync(join(restored,'wf1-ledger.sqlite'),old);
  assert.throws(()=>CampaignLedger.inspect(restored,f.authorityPath,f.spec.id,f.key,()=>f.now),error('WF1_HEAD_MISMATCH'));
});
test('half commit fences without automatically advancing the external head',()=>{
  const f=fixture(),ledger=CampaignLedger.create(f.root,f.authorityPath,f.spec,f.key,()=>f.now),head=ledger.head;
  ledger.host.commitHead=()=>{throw new Wf1Error('WF1_FIXTURE_HOST_FAILURE');};
  assert.throws(()=>ledger.update('fixture',s=>{s.code='WF1_FIXTURE';}),error('WF1_COMMIT_UNKNOWN'));
  assert.equal((JSON.parse(readFileSync(f.authorityPath,'utf8')) as Authority).head,head);
  assert.throws(()=>CampaignLedger.inspect(f.root,f.authorityPath,f.spec.id,f.key,()=>f.now),error('WF1_HEAD_MISMATCH'));
});
test('cold inspect refuses hot journal without writing/recovering original ledger bytes',()=>{
  const f=fixture(),ledger=CampaignLedger.create(f.root,f.authorityPath,f.spec,f.key,()=>f.now);ledger.close();
  const path=join(f.root,'wf1-ledger.sqlite'),before=readFileSync(path);writeFileSync(path+'-journal',Buffer.from('synthetic-hot-journal'));
  assert.throws(()=>CampaignLedger.inspect(f.root,f.authorityPath,f.spec.id,f.key,()=>f.now),error('WF1_HOT_JOURNAL_RECONCILE'));
  assert.deepEqual(readFileSync(path),before);assert.equal(readFileSync(path+'-journal','utf8'),'synthetic-hot-journal');
});
test('cooperative owner lock refuses concurrent campaign writers',()=>{
  const f=fixture(),ledger=CampaignLedger.create(f.root,f.authorityPath,f.spec,f.key,()=>f.now);
  try{assert.throws(()=>CampaignLedger.inspect(f.root,f.authorityPath,f.spec.id,f.key,()=>f.now),error('WF1_OWNER_BUSY'));}finally{ledger.close();}
});
test('real second process shares the authority lock; pause cannot be overwritten by stale head CAS',async()=>{
  const f=fixture(),ledger=CampaignLedger.create(f.root,f.authorityPath,f.spec,f.key,()=>f.now),head=ledger.head;
  const moduleUrl=new URL('../src/wf1-storage.ts',import.meta.url).href;
  const source=`import {HostAuthority} from ${JSON.stringify(moduleUrl)}; const h=new HostAuthority(process.argv[1],process.argv[2],()=>Number(process.argv[4])); h.dispatch(process.argv[3],()=>{process.stdout.write('LOCKED\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,f.authorityPath,f.spec.id,head,String(f.now)],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const completed=once(child,'close');let stdout='';for await(const chunk of child.stdout){stdout+=String(chunk);if(stdout.includes('LOCKED'))break;}
  const host=new HostAuthority(f.authorityPath,f.spec.id,()=>f.now);host.control('PAUSED');const [code]=await completed;assert.equal(code,0);
  assert.throws(()=>ledger.host.commitHead(head,'f'.repeat(64)),error('WF1_AUTHORITY'));
  assert.equal((JSON.parse(readFileSync(f.authorityPath,'utf8')) as Authority).status,'PAUSED');ledger.close();
});
test('external pause aborts in-flight local transport once and does not admit late material',async()=>{
  const f=fixture();let sent!:()=>void,aborts=0;const started=new Promise<void>(r=>{sent=r;});
  const fetcher:typeof fetch=async(_url,init)=>{sent();return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>{aborts++;reject(new Error('synthetic abort'));},{once:true});});};
  const c=campaign(f,new TeacherProvider({deepseek:'synthetic',together:'synthetic'},{fetch:fetcher}));
  const running=c.run();await started;new HostAuthority(f.authorityPath,f.spec.id,()=>f.now).control('PAUSED');
  const summary=await running;assert.equal(aborts,1);assert.equal(summary.status,'RECONCILE_REQUIRED');assert.equal(summary.candidates.qualified,0);c.close();
  const cold=CampaignLedger.inspect(f.root,f.authorityPath,f.spec.id,f.key,()=>f.now);assert.equal(cold.snapshot().attempts[0]!.outcome,null);cold.close();
});
test('native reasoning is separate; missing final/length/tool calls never complete a candidate',async()=>{
  for(const variant of ['reasoning','length','tools']){
    const f=fixture(),ports=createArtifactBroker(f.root,f.spec.id,f.key);
    const fetcher:typeof fetch=async()=>new Response(JSON.stringify({model:MODELS.together,choices:[{index:0,finish_reason:variant==='length'?'length':'stop',message:{role:'assistant',reasoning:marker,content:variant==='reasoning'?null:'{}',...(variant==='tools'?{tool_calls:[{id:'fixture'}]}:{})}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,completion_tokens_details:{reasoning_tokens:15}}}),{headers:{'content-type':'application/json'}});
    const provider=new TeacherProvider({deepseek:null,together:'synthetic'},{fetch:fetcher});const result=await provider.submit('together',providerBody('together',{}),ports.train,new AbortController().signal);
    assert.equal(result.outcome,'INCOMPLETE_OUTPUT');assert.equal(result.usage!.completion,20);assert.equal(result.usage!.reasoning,15);assert.ok(result.reasoningRef);assert.equal(result.transportLane,'SYNTHETIC_FIXTURE');
  }
});
test('unknown native usage holds the maximum reservation and stops dependent phases',async()=>{
  const f=fixture(),m=mockProvider({unknownUsageAt:1}),c=campaign(f,m.provider);try{const summary=await c.run();assert.equal(summary.code,'WF1_UNRECONCILED');assert.equal(m.operations.length,1);assert.equal(summary.usage.unknown,1);assert.ok(summary.estimatedReserveMicroUsd>0);}finally{c.close();}
});
test('usage exceeding the conservative reservation records actual usage then stops',async()=>{
  const f=fixture(),m=mockProvider({overUsageAt:1}),c=campaign(f,m.provider);try{const summary=await c.run();assert.equal(summary.code,'WF1_USAGE_OVER_RESERVE');assert.equal(summary.usage.input,18433);assert.equal(m.operations.length,1);}finally{c.close();}
});
test('amounts use upward integer micro-USD rounding and remain separate from invoice status',()=>{
  const f=fixture();assert.equal(estimateMicroUsd(18432,2048,f.spec.prices.deepseek),7988);assert.equal(estimateMicroUsd(18432,4096,f.spec.prices.together),5223);
  f.spec.prices.deepseek.inputMicroUsdPerMillion=1_000_000_000;const m=mockProvider(),c=campaign(f,m.provider);
  try{assert.throws(()=>c.reserveAttempt('seal',providerBody('deepseek',{})),error('WF1_BUDGET'));assert.equal(m.operations.length,0);}finally{c.close();}
});
test('first four require four complete formal verifications before later families',async()=>{
  const f=fixture(),m=mockProvider({wrongFirst:true}),c=campaign(f,m.provider);try{const result=await c.run();assert.equal(result.code,'WF1_FIRST_FOUR_GATE');assert.equal(result.candidates.deepseek,4);assert.equal(result.candidates.qualified,3);assert.equal(result.calls.together,0);}finally{c.close();}
});
test('full synthetic 4+12+8 loop preserves both teacher sources but exports one canonical target effect',async()=>{
  const f=fixture(),m=mockProvider(),c=campaign(f,m.provider);try{
    const result=await c.run();assert.equal(result.status,'COMPLETED');assert.equal(result.transportLane,'SYNTHETIC_FIXTURE');assert.deepEqual(result.calls,{deepseek:43,together:8});
    assert.equal(result.candidates.formalVerified,24);assert.equal(result.uniqueManifestRows,16);assert.equal(result.studentInference,'NOT_RUN');assert.equal(result.studentTraining,'NOT_RUN');assert.equal(result.quality,'NOT_EVALUATED');
    const projected=JSON.stringify(result);for(const forbidden of [marker,'root0','family0','sealed0',f.root,f.authorityPath,'synthetic-key'])assert.ok(!projected.includes(forbidden));
    assert.ok(result.estimatedReserveMicroUsd<=500000);assert.equal(result.actualInvoice,'UNKNOWN');
    const s=c.ledger.snapshot();assert.equal(s.candidates.length,24);assert.equal(s.exclusions.length,24);assert.ok(s.sealRef);assert.ok(s.manifestRef);
    const ciphertexts=readdirSync(f.root).filter(x=>x.endsWith('.bin')).map(x=>readFileSync(join(f.root,x)));assert.ok(ciphertexts.every(bytes=>!bytes.includes(Buffer.from(marker))));
  }finally{c.close();}
});
test('later wrong DS target stays quarantined but does not cherry-pick or block its prespecified GPT pair',async()=>{
  const f=fixture(),m=mockProvider({wrongLater:true}),c=campaign(f,m.provider);try{const result=await c.run();assert.equal(result.status,'COMPLETED');assert.equal(result.candidates.deepseek,16);assert.equal(result.candidates.together,8);
    const s=c.ledger.snapshot(),ds=s.candidates.find(c=>c.id==='deepseek:family7')!,gpt=s.candidates.find(c=>c.id==='together:family7')!;
    assert.equal(ds.disposition,'QUARANTINE');assert.equal(gpt.disposition,'DETERMINISTICALLY_VERIFIED');assert.equal(result.uniqueManifestRows,16);
  }finally{c.close();}
});
test('protocol plan cannot move paired families after outcomes or bypass split bounds',()=>{
  const p=plan();validatePlan(p);p.pairedFamilyIds[0]='not-present';assert.throws(()=>validatePlan(p),error('WF1_PAIR_BINDING'));
  const q=plan();q.families[0]!.split='dev';assert.throws(()=>validatePlan(q),error('WF1_SPLIT'));
});
test('prepare CLI API is read-only, checks exact build/objective and makes no ledger or network request',async()=>{
  const f=fixture(),now=Date.now();f.spec.createdAt=now;f.spec.expiresAt=now+WF1.campaignMs;f.authority.expiresAt=now+WF1.campaignMs;writeFileSync(f.authorityPath,canonical(f.authority));
  const raw={version:1,action:'prepare',runtimeRoot:f.root,authorityPath:f.authorityPath,expectedHead:null,spec:f.spec,custodyKeyBase64:f.key.toString('base64'),objective:f.objective,credentials:{deepseek:null,together:null}};
  const result=await workerMain(JSON.stringify(raw)) as {status:string;apiCalls:number};assert.equal(result.status,'PREPARED_NOT_STARTED');assert.equal(result.apiCalls,0);assert.deepEqual(readdirSync(f.root),[]);
  raw.spec.sourceDigest='f'.repeat(64);await assert.rejects(workerMain(JSON.stringify(raw)),error('WF1_BUILD_MISMATCH'));
});

test('authority clock is sampled inside the acquired lock before dispatch and CAS',()=>{
  const f=fixture();let clock=f.now;const host=new HostAuthority(f.authorityPath,f.spec.id,()=>clock);
  host.read(clock);clock=f.authority.expiresAt;let dispatched=false;
  assert.throws(()=>host.dispatch('f'.repeat(64),()=>{dispatched=true;}),error('WF1_AUTHORITY'));
  assert.throws(()=>host.commitHead(null,'f'.repeat(64)),error('WF1_AUTHORITY'));assert.equal(dispatched,false);
  assert.equal((JSON.parse(readFileSync(f.authorityPath,'utf8')) as Authority).head,null);
});

test('HTTP and protocol failures report only fixed metadata without response content',async()=>{
  for(const status of [401,402,429,200]){
    const f=fixture(),ports=createArtifactBroker(f.root,f.spec.id,f.key);
    const provider=new TeacherProvider({deepseek:'synthetic',together:null},{fetch:async()=>new Response(status===200?'{"unknown":0}':marker,{status,headers:{'content-type':'application/json'}})});
    const r=await provider.submit('deepseek',providerBody('deepseek',{}),ports.train,new AbortController().signal);
    assert.equal(r.httpStatus,status);assert.equal(r.outcome,'FAILED');assert.equal(r.failure,status===200?'RESPONSE_PROTOCOL':'HTTP_STATUS');assert.ok(!JSON.stringify(r).includes(marker));
  }
});

test('provider grouped usage, unknown reasoning and upward estimated spend are explicit',async()=>{
  const f=fixture(),m=mockProvider(),c=campaign(f,m.provider);
  try{await c.dispatchOnce(c.reserveAttempt('seal',providerBody('deepseek',{operation:'seal',data:{}},'seal')));
    const summary=c.metadata(),group=summary.usage.providers.deepseek!;
    assert.equal(group.input,20);assert.equal(group.completion,30);assert.equal(group.reasoning,0);assert.equal(group.reasoningUnknown,1);assert.equal(group.unknownUsage,0);
    assert.equal(group.estimatedUsageMicroUsd,42);assert.equal(group.estimatedReserveMicroUsd,10445);assert.deepEqual(group.httpStatusCounts,{'200':1});assert.deepEqual(group.failureCounts,{});
    assert.equal(2*10445+42*7988+8*5223,398170);assert.equal(summary.actualInvoice,'UNKNOWN');
  }finally{c.close();}
});

test('missing or changed returned model identity is retained but cannot enter a teacher arm',async()=>{
  for(const model of [null,'unapproved-model']){
    const f=fixture(),provider=new TeacherProvider({deepseek:'synthetic',together:'synthetic'},{fetch:async()=>new Response(JSON.stringify({...(model===null?{}:{model}),choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(sealed())}}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}}),{headers:{'content-type':'application/json'}})});
    const c=campaign(f,provider);try{const summary=await c.run();assert.equal(summary.code,'WF1_MODEL_IDENTITY');assert.equal(summary.calls.deepseek,1);assert.equal(summary.candidates.qualified,0);assert.equal(summary.usage.providers.deepseek!.failureCounts.MODEL_IDENTITY,1);}finally{c.close();}
  }
});
