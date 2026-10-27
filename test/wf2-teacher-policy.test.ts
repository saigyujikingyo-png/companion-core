import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical,hash,Wf1Error } from '../src/wf1-json.ts';
import { PROFILE_DIGEST,validateSpec } from '../src/wf1-contract.ts';
import { providerBody,TeacherProvider } from '../src/wf1-provider.ts';
import { CampaignLedger,createArtifactBroker,HostAuthority } from '../src/wf1-storage.ts';
import { TeachingCampaign } from '../src/wf1-campaign.ts';
import { workerMain } from '../src/wf1-worker.ts';
import { WF1 } from '../src/wf1-types.ts';
import type { Authority,CampaignSpec,FormalSpec,Plan,Seal } from '../src/wf1-types.ts';
import { WF2_TEACHER_PROFILE_DIGEST } from '../src/wf2-teacher-policy.ts';
import { bindTeacherCampaign,inspectTeacherCampaign,teacherWorkerBuildDigest } from '../src/wf2-teacher-worker.ts';
import { TeacherControlService } from '../src/wf2-teacher-service.ts';
import { verifyTeacherManifest } from '../src/wf2-teacher-inspect.ts';

// Only inert synthetic arithmetic/serialization fixtures; never real teacher content or quality evidence.
const capability='35'.repeat(32),marker='SYNTHETIC_ONLY_FORMAL_TEACHER_04';
const error=(code:string)=>(e:unknown)=>e instanceof Wf1Error&&e.code===code;
const formal=(n:number):FormalSpec=>({verifier:'json.pointer.v1',input:{document:{fixture:n},pointer:'/fixture'}});
const sealed=():Seal=>({version:'wf1-seal/1',rubric:marker,cases:Array.from({length:12},(_,i)=>({id:'sealed'+i,roots:['sealed-root'+i],formal:formal(100+i),target:100+i}))});
const plan=():Plan=>({version:'wf1-plan/1',plan:marker,families:Array.from({length:16},(_,i)=>({id:'family'+i,roots:['root'+i],split:[3,7,11,15].includes(i)?'dev':'train',formal:formal(i)})),pairedFamilyIds:Array.from({length:8},(_,i)=>'family'+i)});
function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-teacher-policy-'))),runtimeRoot=join(base,'run'),hostRoot=join(base,'host');mkdirSync(runtimeRoot);mkdirSync(hostRoot);
  const authorityPath=join(hostRoot,'authority.json'),now=1000,objective=marker;
  const authority:Authority={schemaVersion:'wf1-host/1',campaignId:'synthetic-teacher04',revision:1,runtimeId:'synthetic-owner',status:'ACTIVE',expiresAt:now+WF1.campaignMs,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}};
  writeFileSync(authorityPath,canonical(authority));
  const spec:CampaignSpec={schemaVersion:'wf1-campaign/0.4',id:authority.campaignId,createdAt:now,expiresAt:now+WF1.campaignMs,sourceDigest:teacherWorkerBuildDigest(),profileDigest:WF2_TEACHER_PROFILE_DIGEST,objectiveDigest:hash(objective),prices:{deepseek:{snapshotId:'synthetic-ds',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000},together:{snapshotId:'synthetic-tg',inputMicroUsdPerMillion:150000,completionMicroUsdPerMillion:600000}}};
  const bootstrap={version:'wf2-teacher-bind/1',runtimeRoot,authorityPath,expectedHead:null,spec,custodyKeyBase64:Buffer.alloc(32,9).toString('base64'),objective,credentials:{deepseek:'synthetic-key',together:'synthetic-key'},capability};
  return {base,runtimeRoot,authorityPath,now,spec,bootstrap};
}
function inspection(f:ReturnType<typeof fixture>){return {version:'wf2-teacher-inspect/1',runtimeRoot:f.runtimeRoot,authorityPath:f.authorityPath,expectedHead:JSON.parse(readFileSync(f.authorityPath,'utf8')).head,spec:f.spec,custodyKeyBase64:f.bootstrap.custodyKeyBase64};}
function files(root:string){return readdirSync(root).sort().map(name=>[name,hash(readFileSync(join(root,name)))]);}
function mock(options:{wrongFirst?:boolean;unknownUsage?:boolean;onSend?:(raw:string)=>void}={}){
  const operations:string[]=[];const provider=new TeacherProvider({deepseek:'synthetic-key',together:'synthetic-key'},{fetch:async(_url,init)=>{
    const raw=String(init!.body),body=JSON.parse(raw),p=JSON.parse(body.messages[1].content);operations.push(p.operation);options.onSend?.(raw);
    assert.equal(body.messages.length,2);assert.equal(body.messages[0].role,'system');assert.match(body.messages[0].content,/Required output JSON schema:/);
    assert.equal(body.max_tokens,p.operation==='seal'||p.operation==='plan'||p.operation==='comparison_candidate'?4096:2048);
    let content:unknown;
    if(p.operation==='seal')content=sealed();else if(p.operation==='plan')content=plan();else if(p.operation==='rubric')content={version:'wf1-rubric/1',rubric:marker};
    else if(p.operation==='review'||p.operation==='comparison_review')content={version:'wf1-review/1',disposition:'CLEAR',notes:marker};
    else{const n=p.data.formalInput.input.document.fixture;content={version:'wf1-candidate/1',target:options.wrongFirst&&n===0?-99:n};}
    return new Response(JSON.stringify({model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(content)}}],...(options.unknownUsage?{}:{usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}})}),{status:200,headers:{'content-type':'application/json'}});
  }});return {provider,operations};
}
test('legacy default request bytes and version-specific profile admission remain separate',()=>{
  const goldens=[['deepseek','seal','baa50416416489d0a7afd0354c848b9ef090698fe56da1914429feb4e258718d'],['deepseek','candidate','b78d6d74a93fb4973fc1c3337cdc3035512c2c7bfd9b81ec020fcfd6ce94c21c'],['together','seal','513965b9623fca9fd115ce6c992929780f6eeced4549b65d60d91745f6b16fae'],['together','candidate','f41775ecc0e55e5f61d4925e599ca84341e0be221f1866e78bb266812a066e40']] as const;
  for(const [provider,operation,digest] of goldens)assert.equal(hash(providerBody(provider,{operation,data:{fixture:'public-synthetic'}},operation)),digest);
  const f=fixture();assert.equal(validateSpec(f.spec).schemaVersion,'wf1-campaign/0.4');assert.throws(()=>validateSpec({...f.spec,profileDigest:PROFILE_DIGEST}),error('WF1_PROFILE'));
  assert.equal(validateSpec({...f.spec,schemaVersion:'wf1-campaign/0.3',profileDigest:PROFILE_DIGEST}).schemaVersion,'wf1-campaign/0.3');
  assert.throws(()=>validateSpec({...f.spec,schemaVersion:'wf1-campaign/0.3'}),error('WF1_PROFILE'));
});
test('production binder rejects legacy, source mismatch and arbitrary fields before any durable admission',async()=>{
  const f=fixture();for(const input of [{...f.bootstrap,spec:{...f.spec,schemaVersion:'wf1-campaign/0.3',profileDigest:PROFILE_DIGEST}},{...f.bootstrap,spec:{...f.spec,sourceDigest:'0'.repeat(64)}},{...f.bootstrap,workerPath:'forbidden'}])assert.throws(()=>bindTeacherCampaign(input));
  assert.deepEqual(readdirSync(f.runtimeRoot),[]);assert.equal(JSON.parse(readFileSync(f.authorityPath,'utf8')).head,null);
  await assert.rejects(workerMain(canonical({version:1,action:'prepare',runtimeRoot:f.runtimeRoot,authorityPath:f.authorityPath,expectedHead:null,spec:f.spec,custodyKeyBase64:f.bootstrap.custodyKeyBase64,objective:marker,credentials:f.bootstrap.credentials})),error('WF1_VERSION'));
});
test('new production binder durably admits once, freezes full policy before fetch and completes strict synthetic formal loop',async()=>{
  const f=fixture();let checked=false;const m=mock({onSend:raw=>{if(checked)return;checked=true;const db=new DatabaseSync(join(f.runtimeRoot,'wf1-ledger.sqlite'),{readOnly:true});try{const state=JSON.parse(db.prepare('SELECT body FROM events ORDER BY sequence DESC LIMIT 1').get()!.body as string);assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].requestCommitment,hash(raw));assert.equal(state.attempts[0].outcome,null);}finally{db.close();}}});
  const b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),service=new TeacherControlService(b.run,capability);
  assert.notEqual(JSON.parse(readFileSync(f.authorityPath,'utf8')).head,null);assert.throws(()=>bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),error('WF1_HEAD_MISMATCH'));
  service.dispatch({version:1,requestId:'start',operation:'start',capability});await service.settled();const receipt=service.completionReceipt();
  assert.equal(receipt.metadata.campaignStatus,'COMPLETED');assert.equal(receipt.metadata.calls.deepseek,43);assert.equal(receipt.metadata.calls.together,8);assert.equal(receipt.metadata.candidates.qualified,24);assert.equal(receipt.metadata.usage.unknown,0);assert.equal(receipt.metadata.manifestFrozen,true);assert.equal(checked,true);
  service.acknowledgeCompleted(receipt.digest);service.ownerLost();assert.equal(JSON.parse(readFileSync(f.authorityPath,'utf8')).status,'ACTIVE');assert.equal(b.run.metadata().countCompleteness,'STALE_OR_UNKNOWN');
  // Make only our synthetic custody artifacts unavailable: cold verification must read train manifest alone.
  for(const name of readdirSync(f.runtimeRoot).filter(name=>name.startsWith('custody-')))renameSync(join(f.runtimeRoot,name),join(f.runtimeRoot,name+'.unavailable'));
  const before=files(f.runtimeRoot),beforeHost=files(join(f.base,'host'));
  const inspectSource=`import {inspectTeacherCampaign} from ${JSON.stringify(new URL('../src/wf2-teacher-inspect.ts',import.meta.url).href)};let raw='';for await(const part of process.stdin)raw+=part;process.stdout.write(JSON.stringify(inspectTeacherCampaign(JSON.parse(raw),()=>1000)));`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',inspectSource],{input:canonical(inspection(f)),encoding:'utf8',timeout:5000,maxBuffer:32768,windowsHide:true});assert.equal(child.status,0,child.stderr);
  const cold=JSON.parse(child.stdout);assert.equal(cold.status,'RECORDED_CLAIMS_ONLY');assert.equal(cold.providers.deepseek.calls,43);assert.equal(cold.providers.together.knownUsageCalls,8);assert.equal(cold.candidates.qualified,24);assert.equal(cold.uniqueManifestRows,16);assert.deepEqual(cold.manifestVerification,{status:'VERIFIED',rows:16,uniqueRows:16,splitCounts:{train:12,dev:4}});assert.equal(cold.actualInvoice,'UNKNOWN');assert.equal(cold.automaticResume,false);
  assert.deepEqual(files(f.runtimeRoot),before);assert.deepEqual(files(join(f.base,'host')),beforeHost);assert.ok(!child.stdout.includes(marker));assert.ok(!child.stdout.includes('targetRef'));
  const db=new DatabaseSync(join(f.runtimeRoot,'wf1-ledger.sqlite'),{readOnly:true});let state;try{state=JSON.parse(db.prepare('SELECT body FROM events ORDER BY sequence DESC LIMIT 1').get()!.body as string);}finally{db.close();}
  const manifest=JSON.parse(createArtifactBroker(f.runtimeRoot,f.spec.id,Buffer.alloc(32,9)).train.read(state.manifestRef).toString('utf8'));
  const wrongSplit=structuredClone(manifest);wrongSplit.rows[0].split='dev';assert.throws(()=>verifyTeacherManifest(state,plan(),wrongSplit),error('WF2_MANIFEST_PLAN'));
  const wrongRoots=structuredClone(manifest);wrongRoots.rows[0].roots=['invented-synthetic-root'];assert.throws(()=>verifyTeacherManifest(state,plan(),wrongRoots),error('WF2_MANIFEST_PLAN'));
});
test('0.4 first-four gate stops immediately on first wrong target without substitute or repair',async()=>{
  const f=fixture(),m=mock({wrongFirst:true}),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});
  try{await b.run.run();assert.deepEqual(m.operations,['seal','plan','rubric','candidate']);const metadata=b.run.metadata();assert.equal(metadata.campaignStatus,'STOPPED');assert.equal(metadata.candidates.deepseek,1);assert.equal(metadata.candidates.qualified,0);assert.equal(b.stopReason!(),'FIRST_FOUR_GATE');}finally{b.run.withdraw('REVOKED');}
});
test('unknown usage remains consumed and blocks every subsequent teacher call',async()=>{
  const f=fixture(),m=mock({unknownUsage:true}),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});
  try{await b.run.run();const metadata=b.run.metadata();assert.equal(metadata.campaignStatus,'STOPPED');assert.equal(metadata.calls.deepseek,1);assert.equal(metadata.usage.unknown,1);assert.equal(metadata.estimatedReserveMicroUsd,10445);assert.equal(b.stopReason!(),'USAGE_OR_TRANSPORT_UNKNOWN');assert.equal(m.operations.length,1);}finally{b.run.withdraw('REVOKED');}
  const before=files(f.runtimeRoot),beforeHost=files(join(f.base,'host')),cold=inspectTeacherCampaign(inspection(f),()=>f.now);assert.equal(cold.authorityStatus,'REVOKED');assert.equal(cold.providers.deepseek!.unknownUsageCalls,1);assert.equal(cold.providers.deepseek!.estimatedReserveMicroUsd,10445);assert.equal(cold.manifestVerification.status,'NOT_READ');assert.deepEqual(files(f.runtimeRoot),before);assert.deepEqual(files(join(f.base,'host')),beforeHost);
});
test('cold inspection rejects credentials and missing owner without creating any runtime file',()=>{
  const f=fixture();assert.throws(()=>inspectTeacherCampaign({...inspection(f),credentials:{deepseek:'synthetic-only'}},()=>f.now));
  assert.throws(()=>CampaignLedger.inspect(f.runtimeRoot,f.authorityPath,f.spec.id,Buffer.alloc(32,9),()=>f.now));assert.deepEqual(readdirSync(f.runtimeRoot),[]);
});
test('production withdrawal changes fresh external authority before local close and upgrades after pause',()=>{
  const f=fixture(),m=mock(),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),service=new TeacherControlService(b.run,capability),original=TeachingCampaign.prototype.close;let closes=0;
  TeachingCampaign.prototype.close=function(){closes++;assert.equal(JSON.parse(readFileSync(f.authorityPath,'utf8')).status,'PAUSED');return original.call(this);};
  try{service.dispatch({version:1,requestId:'pause',operation:'pause',capability});assert.equal(closes,1);service.dispatch({version:1,requestId:'cancel',operation:'cancel',capability});assert.equal(closes,1);assert.equal(JSON.parse(readFileSync(f.authorityPath,'utf8')).status,'REVOKED');assert.equal(m.operations.length,0);}finally{TeachingCampaign.prototype.close=original;b.run.close();}
});
test('production half commit exposes unknown totals rather than stale zeros and never fetches',async()=>{
  const f=fixture(),m=mock(),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),original=HostAuthority.prototype.commitHead;
  HostAuthority.prototype.commitHead=function(){throw new Wf1Error('SYNTHETIC_HALF_COMMIT');};
  try{await b.run.run();const metadata=b.run.metadata();assert.equal(metadata.countCompleteness,'STALE_OR_UNKNOWN');assert.equal(metadata.calls.deepseek,null);assert.equal(metadata.usage.unknown,null);assert.equal(metadata.estimatedReserveMicroUsd,null);assert.equal(m.operations.length,0);
    const db=new DatabaseSync(join(f.runtimeRoot,'wf1-ledger.sqlite'),{readOnly:true});try{const state=JSON.parse(db.prepare('SELECT body FROM events ORDER BY sequence DESC LIMIT 1').get()!.body as string);assert.equal(state.attempts.length,1);}finally{db.close();}
    assert.throws(()=>bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}));
  }finally{HostAuthority.prototype.commitHead=original;b.run.withdraw('REVOKED');}
});
