import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonical,hash,Wf1Error } from '../src/wf1-json.ts';
import { validatePlan,validateSeal,validateSpec } from '../src/wf1-contract.ts';
import { computeFormal,verifyFormal } from '../src/wf1-verifier.ts';
import { providerBody,TeacherProvider } from '../src/wf1-provider.ts';
import { MODELS,WF1 } from '../src/wf1-types.ts';
import type { Authority,CampaignSpec,CampaignState,FormalSpec,Operation,Plan,Seal } from '../src/wf1-types.ts';
import { fixedSlotBinding,fixedSlotSchema,fixedSlotStopReason,projectFixedSlots,validateFixedSlotRequest,WF2_SLOTS_PROFILE_DIGEST } from '../src/wf2-fixed-slots.ts';
import { WF2_STRICT_PROFILE_DIGEST } from '../src/wf2-strict-data.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { bindTeacherCampaign,inspectTeacherCampaign,teacherWorkerBuildDigest } from '../src/wf2-teacher-worker.ts';
import { TeacherControlService } from '../src/wf2-teacher-service.ts';

// Independent public synthetic fixtures. No actual model material is read, regraded or repaired.
const marker='SYNTHETIC_NAMED_06_e\u0301',capability='64'.repeat(32),key=Buffer.alloc(32,6);
const formal=(n:number):FormalSpec=>({verifier:'rational.evaluate.v1',input:{op:'value',numerator:String(n),denominator:'1'}});
const sealed=():Seal=>({version:'wf1-seal/1',rubric:marker,cases:Array.from({length:12},(_,i)=>({id:'seal'+i,roots:['seal-root'+i],formal:formal(100+i),target:computeFormal(formal(100+i))}))});
const plan=():Plan=>({version:'wf1-plan/1',plan:marker,families:Array.from({length:16},(_,i)=>({id:'family'+i,roots:['root'+i],split:(i+1)%4===0?'dev':'train',formal:formal(i)})),pairedFamilyIds:Array.from({length:8},(_,i)=>'family'+i)});
const table=(prefix:string,items:unknown[])=>Object.fromEntries(items.map((value,i)=>[prefix+String(i+1).padStart(2,'0'),value]));
const wireSeal=()=>{const s=sealed();return {version:'wf2-seal-slots/1',rubric:s.rubric,cases:table('case',s.cases)};};
const wirePlan=()=>{const p=plan();return {version:'wf2-plan-slots/1',plan:p.plan,families:table('family',p.families),pairedFamilyIds:table('pair',p.pairedFamilyIds)};};
const payload=(operation:Operation,data:unknown={fixture:marker})=>({protocol:'wf1-private-role/1',operation,role:'SyntheticRole',protocolInstruction:'inert',jsonProfile:{fixture:true},outputSchema:{unused:true},data});
function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'companion-wf2-slots-'))),approvedTrainingRoot=join(base,'training'),runtimeRoot=join(approvedTrainingRoot,'run'),hostRoot=join(base,'host');mkdirSync(approvedTrainingRoot);mkdirSync(runtimeRoot);mkdirSync(hostRoot);
  const authorityPath=join(hostRoot,'authority.json'),now=1000,authority:Authority={schemaVersion:'wf1-host/1',campaignId:'synthetic-teacher06',revision:1,runtimeId:'owner',status:'ACTIVE',expiresAt:now+WF1.campaignMs,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}};writeFileSync(authorityPath,canonical(authority));
  const spec:CampaignSpec={schemaVersion:'wf1-campaign/0.6',id:authority.campaignId,createdAt:now,expiresAt:now+WF1.campaignMs,sourceDigest:teacherWorkerBuildDigest(),profileDigest:WF2_NAMED_PROFILE_DIGEST,objectiveDigest:hash(marker),storageBindingDigest:bindTrainingRoot(approvedTrainingRoot,runtimeRoot).storageBindingDigest,prices:{deepseek:{snapshotId:'synthetic-ds',inputMicroUsdPerMillion:300000,completionMicroUsdPerMillion:1200000},together:{snapshotId:'synthetic-tg',inputMicroUsdPerMillion:150000,completionMicroUsdPerMillion:600000}}};
  const bootstrap={version:'wf2-teacher-bind/2',approvedTrainingRoot,runtimeRoot,authorityPath,expectedHead:null,spec,custodyKeyBase64:key.toString('base64'),objective:marker,credentials:{deepseek:'synthetic-only',together:'synthetic-only'},capability};return {base,approvedTrainingRoot,runtimeRoot,authorityPath,now,spec,bootstrap};
}
function inspection(f:ReturnType<typeof fixture>){return {version:'wf2-teacher-inspect/2',approvedTrainingRoot:f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,authorityPath:f.authorityPath,expectedHead:JSON.parse(readFileSync(f.authorityPath,'utf8')).head,spec:f.spec,custodyKeyBase64:key.toString('base64')};}
function state(f:ReturnType<typeof fixture>):CampaignState {const db=new DatabaseSync(join(f.runtimeRoot,'wf1-ledger.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT body FROM events ORDER BY sequence DESC LIMIT 1').get()!.body as string);}finally{db.close();}}
function files(root:string){return readdirSync(root).sort().map(name=>[name,hash(readFileSync(join(root,name)))]);}
type Failure='argsJson'|'wire'|'roots'|'sealOracle'|'source'|'nonRational'|'firstOracle'|'candidateProtocol'|'review'|'usage';
function mock(f:ReturnType<typeof fixture>,failure?:Failure){const operations:string[]=[];let consumed=0;const provider=new TeacherProvider({deepseek:'synthetic-only',together:'synthetic-only'},{fetch:async(url,init)=>{
  const raw=String(init!.body),body=JSON.parse(raw),p=JSON.parse(body.messages[1].content),last=state(f).attempts.at(-1)!;operations.push(p.operation);assert.equal(last.requestCommitment,hash(raw));assert.equal(last.outcome,null);assert.deepEqual(last.requestBinding,slotRequestBinding(last.provider,last.operation,WF2_NAMED_PROFILE_DIGEST));assert.equal(url,last.requestBinding!.endpoint);consumed++;assert.ok(!raw.includes('json.pointer.v1'));
  let content:unknown;
  if(p.operation==='seal'){const w=wireSeal();if(failure==='wire')delete w.cases.case12;if(failure==='roots')(w.cases.case01 as any).roots=[];if(failure==='sealOracle')(w.cases.case01 as any).target={numerator:'-7',denominator:'1'};if(failure==='source')(w.cases.case02 as any).roots=(w.cases.case01 as any).roots;if(failure==='nonRational'){(w.cases.case01 as any).formal={verifier:'json.pointer.v1',input:{document:{x:1},pointer:'/x'}};(w.cases.case01 as any).target=1;}content=w;}
  else if(p.operation==='plan')content=wirePlan();else if(p.operation==='rubric')content={version:'wf1-rubric/1',rubric:marker};
  else if(p.operation==='review'||p.operation==='comparison_review')content={version:'wf1-review/1',disposition:failure==='review'?'FLAG':'CLEAR',notes:marker};
  else content={version:'wf1-candidate/1',target:failure==='firstOracle'?{numerator:'-77',denominator:'1'}:computeFormal(p.data.formalInput)};
  const deepseek=body.model===MODELS.deepseek,message=deepseek?{role:'assistant',content:'',tool_calls:[{id:'synthetic-call',index:0,type:'function',function:{name:body.tool_choice.function.name,arguments:failure==='argsJson'?'{bad json':JSON.stringify(content)}}]}:{role:'assistant',content:JSON.stringify(content)};
  if(deepseek)assert.equal(Object.hasOwn(body.tools[0].function,'strict'),false);if(!deepseek){assert.equal(body.tools,undefined);assert.equal(last.requestBinding!.payloadCodec,'WF2_CANONICAL_V1');}
  return new Response(JSON.stringify({model:body.model,choices:[{index:0,finish_reason:failure==='candidateProtocol'&&p.operation==='candidate'?'length':deepseek?'tool_calls':'stop',message}],...(failure==='usage'?{}:{usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}})}),{status:200,headers:{'content-type':'application/json'}});
}});return {provider,operations,get consumed(){return consumed;}};}


import { slotRequestBinding,slotRequestBody,WF2_NAMED_PROFILE_DIGEST,validateNamedDataRequest } from '../src/wf2-named-data.ts';
import { argumentsFailureCode,latestResponseFailure,responseFailureCode,RESPONSE_FAILURE_CODES } from '../src/wf2-response-diagnostic.ts';
import { HostAuthority,createArtifactBroker } from '../src/wf1-storage.ts';
import { TeachingCampaign } from '../src/wf1-campaign.ts';
import type { Attempt,Provider,ProviderResult } from '../src/wf1-types.ts';

test('named profile keeps all old profile digests and beta request bytes; every new DS operation only omits strict',()=>{
  assert.equal(WF2_SLOTS_PROFILE_DIGEST,'50a62d005dc05d8e97c06f30afe501a4279ca14f4d264a23b3a4852f5e71a6bc');assert.equal(WF2_STRICT_PROFILE_DIGEST,'c6c8e10b08940d6517b5cd8b8ba9e6459f9d1b016ef1dda220816c7c5e4da8e6');
  const goldens=['0a7d1a047a88572de211834a5e0b5e5c3bc96feab70a49063ceab214fa23ec43','ad9ed1e451b1dfa5e75cf67ae3323c7d0b926c449bbbebc577f8ba8c1aefadd9','1432b9e8a008b151a175ae63b878db3c120be1aa559fdd3e5b3eb549b3d2831d','10505b2b40e1465c3f3a000300926909a82f4769238e590e3afdf0369802d51d','021eb66ec005c1f8da13ae11e8b17ad243e3fa52461f95f8372b205689d28315','a54b312876903655853efbda94a056dd1a8c273dfd00bedda9b7d3538018eacb','98f6366b11701863fcc9964599c8d012dfb5ccdec4dfae6e2260b446556d27f5'];
  const operations:Operation[]=['seal','plan','rubric','candidate','review','comparison_candidate','comparison_review'];
  for(const [i,operation] of operations.entries()){
    const provider:Provider=operation.startsWith('comparison_')?'together':'deepseek',p=payload(operation,{fixture:'SYNTHETIC_STABLE_ROUTE'}),old=providerBody(provider,p,operation,'wf1-campaign/0.6');assert.equal(hash(old),goldens[i]);
    assert.equal(providerBody(provider,p,operation,'wf1-campaign/0.6',WF2_SLOTS_PROFILE_DIGEST),old);assert.deepEqual(slotRequestBinding(provider,operation,WF2_SLOTS_PROFILE_DIGEST),fixedSlotBinding(provider,operation));
    const next=providerBody(provider,p,operation,'wf1-campaign/0.6',WF2_NAMED_PROFILE_DIGEST),expected=JSON.parse(old),binding=slotRequestBinding(provider,operation,WF2_NAMED_PROFILE_DIGEST);
    if(provider==='deepseek'){delete expected.tools[0].function.strict;assert.equal(binding.endpoint,'https://api.deepseek.com/chat/completions');assert.equal(binding.protocol,'DEEPSEEK_NAMED_DATA_ARGS_V1');}else assert.equal(next,old);
    assert.equal(next,canonical(expected));validateNamedDataRequest(provider,operation,next,binding);assert.ok(Buffer.byteLength(next)<=WF1.requestBytes);
  }
  const f=fixture();validateSpec(f.spec);assert.throws(()=>validateSpec({...f.spec,profileDigest:'0'.repeat(64)}));
});

test('routes and strict presence are mutually rejected before transport or consume',async()=>{
  const p=payload('seal'),beta=providerBody('deepseek',p,'seal','wf1-campaign/0.6'),named=slotRequestBody('deepseek',p,'seal',WF2_NAMED_PROFILE_DIGEST),oldBinding=fixedSlotBinding('deepseek','seal'),binding=slotRequestBinding('deepseek','seal',WF2_NAMED_PROFILE_DIGEST);let sends=0;
  const provider=new TeacherProvider({deepseek:'synthetic',together:null},{fetch:async()=>{sends++;throw Error('never');}});
  const falseBody=JSON.parse(named);falseBody.tools[0].function.strict=false;
  for(const [body,contract] of [[beta,binding],[named,oldBinding],[canonical(falseBody),binding],[named,{...binding,endpoint:oldBinding.endpoint}],[named,{...binding,profileDigest:WF2_SLOTS_PROFILE_DIGEST}]] as const)await assert.rejects(provider.submit('deepseek',body,{} as never,new AbortController().signal,send=>send(),{operation:'seal',binding:contract}));
  assert.equal(sends,0);const f=fixture(),campaign=TeachingCampaign.admitCampaign({root:f.runtimeRoot,authorityPath:f.authorityPath,spec:f.spec,key,objective:marker,provider,now:()=>f.now,approvedTrainingRoot:f.approvedTrainingRoot});
  try{for(const wrong of [beta,canonical(falseBody)])assert.throws(()=>campaign.reserveAttempt('seal',wrong));assert.equal(state(f).attempts.length,0);assert.equal(sends,0);}finally{campaign.close();}
  assert.throws(()=>projectFixedSlots('seal',wireSeal(),'NAMED_TOOL_ARGUMENTS'));assert.throws(()=>projectFixedSlots('seal',wireSeal(),'STRICT_TOOL_ARGUMENTS','NAMED_TOOL_ARGUMENTS'));
  assert.equal(canonical(projectFixedSlots('seal',wireSeal(),'NAMED_TOOL_ARGUMENTS','NAMED_TOOL_ARGUMENTS')),canonical(sealed()));
});

function reply(raw:string,extra:Record<string,unknown>={}){return {model:MODELS.deepseek,choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:'',tool_calls:[{id:'fixture',index:0,type:'function',function:{name:'wf2_data_candidate',arguments:raw}}],...extra}}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}};}
test('actual rejection boundaries retain safe response codes without error text or native fallback',async()=>{
  const cases:[string,string][]=[['{bad json','ARGUMENTS_NATIVE_JSON_INVALID'],['{"x":1,"x":2}','ARGUMENTS_WF1_DUPLICATE_KEY'],['{"x":-0}','ARGUMENTS_WF1_NUMBER'],['{"x":"\\ud800"}','ARGUMENTS_WF1_UNICODE'],['{"x":'+ '1'.repeat(33)+'}','ARGUMENTS_WF1_JSON'],['['.repeat(34)+'0'+']'.repeat(34),'ARGUMENTS_WF1_JSON_LIMIT'],['[]','ARGUMENTS_ROOT_NOT_OBJECT'],['null','ARGUMENTS_ROOT_NOT_OBJECT'],['"value"','ARGUMENTS_ROOT_NOT_OBJECT'],['{}','NONE']];
  const body=slotRequestBody('deepseek',payload('candidate'),'candidate',WF2_NAMED_PROFILE_DIGEST),contract={operation:'candidate' as const,binding:slotRequestBinding('deepseek','candidate',WF2_NAMED_PROFILE_DIGEST)};
  for(const [raw,code] of cases){const f=fixture(),port=createArtifactBroker(f.runtimeRoot,f.spec.id,key).train,provider=new TeacherProvider({deepseek:'synthetic',together:null},{fetch:async()=>new Response(JSON.stringify(reply(raw)),{headers:{'content-type':'application/json'}})}),result=await provider.submit('deepseek',body,port,new AbortController().signal,send=>send(),contract);
    assert.equal(result.responseFailureCode,code);assert.equal(result.outcome,code==='NONE'?'COMPLETED':'FAILED');assert.equal(result.argumentsRef!.kind,'named-tool-arguments');assert.equal(result.payloadOrigin,'NAMED_TOOL_ARGUMENTS');assert.equal(port.read(result.argumentsRef!).toString(),raw);assert.equal(result.finalRef,null);
  }
  for(const kind of ['provider-raw','native-reasoning','named-tool-arguments']){const f=fixture(),real=createArtifactBroker(f.runtimeRoot,f.spec.id,key).train,port={...real,put:(k:string,bytes:string|Uint8Array)=>{if(k===kind)throw kind==='named-tool-arguments'?new Wf1Error('WF1_JSON'):Error('PRIVATE_PATH_AND_EXCEPTION');return real.put(k,bytes);}},provider=new TeacherProvider({deepseek:'synthetic',together:null},{fetch:async()=>new Response(JSON.stringify(reply('{}',{reasoning_content:'synthetic reasoning'})),{headers:{'content-type':'application/json'}})});
    const result=await provider.submit('deepseek',body,port,new AbortController().signal,send=>send(),contract);assert.equal(result.responseFailureCode,'ARTIFACT_WRITE_FAILED');assert.ok(!canonical(result).includes('PRIVATE_PATH_AND_EXCEPTION'));
  }
  for(const [raw,code] of [['{bad envelope','ENVELOPE_WF1_JSON'],['{}','ENVELOPE_REJECTED'],[JSON.stringify(reply('{}',{content:'mixed'})),'TOOL_ENVELOPE_REJECTED']]){const f=fixture(),provider=new TeacherProvider({deepseek:'synthetic',together:null},{fetch:async()=>new Response(raw,{headers:{'content-type':'application/json'}})}),result=await provider.submit('deepseek',body,createArtifactBroker(f.runtimeRoot,f.spec.id,key).train,new AbortController().signal,send=>send(),contract);assert.equal(result.responseFailureCode,code);}
  assert.equal(argumentsFailureCode(new Error('PRIVATE'),'{bad'),'UNKNOWN');assert.equal(responseFailureCode({toString(){throw Error('PRIVATE');}}),'UNKNOWN');assert.ok(!RESPONSE_FAILURE_CODES.includes('PRIVATE' as never));
});

test('fresh terminal and revoked cold claims retain the last recorded code; half commit and pending stay unknown',async()=>{
  const f=fixture(),m=mock(f,'argsJson'),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});await b.run.run();const terminal=b.terminal!();assert.equal(terminal.metadata.calls.deepseek,1);assert.equal(terminal.responseFailureCode,'ARGUMENTS_NATIVE_JSON_INVALID');assert.equal(terminal.metadata.countCompleteness,'CURRENT_AUTHORITY');assert.equal(m.consumed,1);
  const last=state(f).attempts.at(-1)!;assert.equal(latestResponseFailure([last,{...last,outcome:null,result:null}],true),'UNKNOWN');assert.equal(latestResponseFailure([last],false),'UNKNOWN');assert.equal(latestResponseFailure([{...last,result:{...last.result!,responseFailureCode:'untrusted' as never}}],true),'UNKNOWN');const oldResult={...last.result!};delete oldResult.responseFailureCode;assert.equal(latestResponseFailure([{...last,result:oldResult}],true),'UNKNOWN');
  b.run.withdraw('REVOKED');assert.equal(b.terminal!().responseFailureCode,'UNKNOWN');assert.equal(b.terminal!().metadata.calls.deepseek,null);const before=files(f.runtimeRoot),cold=inspectTeacherCampaign(inspection(f),()=>f.now);assert.equal(cold.responseFailureCode,'ARGUMENTS_NATIVE_JSON_INVALID');assert.equal(cold.authorityStatus,'REVOKED');assert.equal(cold.status,'RECORDED_CLAIMS_ONLY');assert.deepEqual(files(f.runtimeRoot),before);
  const g=fixture(),n=mock(g),bound=bindTeacherCampaign(g.bootstrap,{provider:n.provider,now:()=>g.now}),original=HostAuthority.prototype.commitHead;
  HostAuthority.prototype.commitHead=function(){throw new Wf1Error('SYNTHETIC_HALF_COMMIT');};try{await bound.run.run();const t=bound.terminal!();assert.equal(t.metadata.countCompleteness,'STALE_OR_UNKNOWN');assert.equal(t.metadata.calls.deepseek,null);assert.equal(t.responseFailureCode,'UNKNOWN');assert.equal(state(g).attempts.length,1);assert.equal(n.consumed,0);}finally{HostAuthority.prototype.commitHead=original;bound.run.withdraw('REVOKED');}
});

test('stable named full 51-call mock chain freezes 16 unique rows and cold reads without sealed artifacts',async()=>{
  const f=fixture(),m=mock(f),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now}),service=new TeacherControlService(b.run,capability);service.dispatch({version:1,requestId:'start',operation:'start',capability});await service.settled();const receipt=service.completionReceipt();assert.equal(receipt.metadata.calls.deepseek,43);assert.equal(receipt.metadata.calls.together,8);assert.equal(receipt.metadata.candidates.qualified,24);assert.equal(m.consumed,51);assert.equal(b.terminal!().responseFailureCode,'NONE');service.acknowledgeCompleted(receipt.digest);service.ownerLost();
  const recorded=state(f);for(const a of recorded.attempts){assert.equal(a.requestBinding!.profileDigest,WF2_NAMED_PROFILE_DIGEST);assert.equal(a.result!.payloadOrigin,a.provider==='deepseek'?'NAMED_TOOL_ARGUMENTS':'NATIVE_FINAL');if(a.provider==='deepseek')assert.equal(a.result!.argumentsRef!.kind,'named-tool-arguments');}
  for(const name of readdirSync(f.runtimeRoot).filter(n=>n.startsWith('custody-')))renameSync(join(f.runtimeRoot,name),join(f.runtimeRoot,name+'.unavailable'));const before=files(f.runtimeRoot),hostBefore=files(join(f.base,'host'));
  const source=`import {inspectTeacherCampaign} from ${JSON.stringify(new URL('../src/wf2-teacher-inspect.ts',import.meta.url).href)};let raw='';for await(const p of process.stdin)raw+=p;process.stdout.write(JSON.stringify(inspectTeacherCampaign(JSON.parse(raw),()=>1000)));`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{input:canonical(inspection(f)),encoding:'utf8',timeout:5000,maxBuffer:32768,windowsHide:true});assert.equal(child.status,0,child.stderr);const cold=JSON.parse(child.stdout);assert.equal(cold.version,'wf2-teacher-inspection/4');assert.equal(cold.responseFailureCode,'NONE');assert.deepEqual(cold.manifestVerification,{status:'VERIFIED',rows:16,uniqueRows:16,splitCounts:{train:12,dev:4}});assert.ok(!child.stdout.includes(marker));assert.deepEqual(files(f.runtimeRoot),before);assert.deepEqual(files(join(f.base,'host')),hostBefore);
});

test('new profile preserves first-four exact-oracle and unknown-usage stops without second-lane dispatch',async()=>{
  for(const failure of ['firstOracle','usage','wire'] as const){const f=fixture(),m=mock(f,failure),b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});try{await b.run.run();const t=b.terminal!();assert.equal(t.metadata.campaignStatus,'STOPPED');assert.equal(t.metadata.candidates.qualified,0);assert.equal(m.consumed,failure==='firstOracle'?4:1);assert.equal(t.metadata.calls.together,0);assert.equal(t.reason,failure==='firstOracle'?'EXACT_ORACLE':failure==='usage'?'USAGE_OR_TRANSPORT_UNKNOWN':'WIRE_DECODE');}finally{b.run.withdraw('REVOKED');}}
});

test('cold refusal uses inspection version four and never echoes bootstrap or exception contents',()=>{
  const child=spawnSync(process.execPath,['src/wf2-teacher-worker.ts','--inspect'],{input:'{"private":"SYNTHETIC_SECRET_NOT_FOR_OUTPUT"}',encoding:'utf8',timeout:5000,maxBuffer:32768,windowsHide:true});assert.equal(child.status,1);const value=JSON.parse(child.stdout);assert.deepEqual(Object.keys(value).sort(),['automaticResume','code','failureDiagnostic','responseFailureCode','status','version']);assert.equal(value.version,'wf2-teacher-inspection/4');assert.equal(value.status,'REFUSED');assert.equal(value.responseFailureCode,'UNKNOWN');assert.ok(!child.stdout.includes('SYNTHETIC_SECRET'));
});

test('admitted stable profile refuses beta origin or wrong argument artifact kind after one consumed response',async()=>{
  for(const wrong of ['origin','kind']){const f=fixture(),m=mock(f),original=m.provider.submit.bind(m.provider);m.provider.submit=async(...args)=>{const result=await original(...args);return wrong==='origin'?{...result,payloadOrigin:'STRICT_TOOL_ARGUMENTS'}:{...result,argumentsRef:{...result.argumentsRef!,kind:'strict-tool-arguments'}};};const b=bindTeacherCampaign(f.bootstrap,{provider:m.provider,now:()=>f.now});try{await b.run.run();assert.equal(b.run.metadata().campaignStatus,'STOPPED');assert.equal(m.consumed,1);assert.equal(b.run.metadata().sealed,false);assert.equal(state(f).code,'WF2_STRICT_ORIGIN');}finally{b.run.withdraw('REVOKED');}}
});
