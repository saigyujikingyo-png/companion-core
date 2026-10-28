import { bounded } from './runtime.ts';
import { canonical,fields,integer,parseJson,stop,text,Wf1Error } from './wf1-json.ts';
import { completionCap,ENDPOINTS,MODELS,WF1 } from './wf1-types.ts';
import type { CampaignVersion,Operation,Provider,ProviderResult,RequestBinding,Usage } from './wf1-types.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import { teacherSystemJsonBody } from './wf2-teacher-policy.ts';
import { decodeStrictDataArguments,strictDataBody,validateStrictDataRequest } from './wf2-strict-data.ts';
import { fixedSlotBody,validateFixedSlotRequest } from './wf2-fixed-slots.ts';
import { slotRequestBody,validateNamedDataRequest } from './wf2-named-data.ts';
import { argumentsFailureCode,parseFailureCode } from './wf2-response-diagnostic.ts';
import { pilotBody,validatePilotRequest,validatePilotEnvelopeExtras,WF2_PILOT_PROFILE_DIGEST } from './wf2-together-pilot.ts';
import { unitBody,validateUnitRequest,WF2_UNIT_PROFILE_DIGEST } from './wf2-unit-pilot.ts';
import type { ResponseDiagnostic } from './wf2-response-diagnostic.ts';
import { validatePilotRequest as validateCorpusRequest } from './corpus-teacher-types.ts';
import { PRODUCTION,validateProductionRequest } from './corpus-production-types.ts';

export function providerBody(provider:Provider,payload:unknown,operation:Operation='candidate',policy:CampaignVersion='wf1-campaign/0.3',profileDigest?:string,unitIndex?:number|null):string {
  if(policy==='wf1-campaign/0.8'){if(profileDigest!==WF2_UNIT_PROFILE_DIGEST||unitIndex===undefined)stop('WF2_UNIT_BINDING');return unitBody(provider,payload,operation,unitIndex);}
  if(policy==='wf1-campaign/0.7'){if(profileDigest!==undefined&&profileDigest!==WF2_PILOT_PROFILE_DIGEST)stop('WF2_PILOT_BINDING');return pilotBody(provider,payload,operation);}
  if(policy==='wf1-campaign/0.6')return profileDigest===undefined?fixedSlotBody(provider,payload,operation):slotRequestBody(provider,payload,operation,profileDigest);
  if(policy==='wf1-campaign/0.5')return strictDataBody(provider,payload,operation);
  if(policy==='wf1-campaign/0.4')return teacherSystemJsonBody(provider,payload,operation);
  if(policy!=='wf1-campaign/0.3')stop('WF1_VERSION');
  const body=canonical({model:MODELS[provider],stream:false,messages:[{role:'user',content:canonical(payload)}],response_format:{type:'json_object'},
    max_tokens:completionCap(provider,operation),
    ...(provider==='deepseek'?{thinking:{type:'disabled'}}:{reasoning_effort:'low'})});
  if(Buffer.byteLength(body,'utf8')>WF1.requestBytes)stop('WF1_REQUEST_BYTES');return body;
}
export function nativeUsage(value:unknown):Usage|null {
  if(value===undefined||value===null)return null;
  try{
    const u=fields(value,['prompt_tokens','completion_tokens'],['total_tokens','prompt_tokens_details','completion_tokens_details','prompt_cache_hit_tokens','prompt_cache_miss_tokens']);
    const input=integer(u.prompt_tokens),completion=integer(u.completion_tokens);
    if(u.total_tokens!==undefined&&integer(u.total_tokens)!==input+completion)stop('WF1_USAGE');let reasoning:number|null=null;
    if(u.completion_tokens_details!==undefined&&u.completion_tokens_details!==null){const d=fields(u.completion_tokens_details,[],['reasoning_tokens','accepted_prediction_tokens','rejected_prediction_tokens']);if(d.reasoning_tokens!==undefined)reasoning=integer(d.reasoning_tokens,0,completion);}
    return {input,completion,reasoning};
  }catch{return null;}
}
/** Production-only Retry-After parsing; wall time is independent of elapsed timing. */
export function productionRetryAfter(value:string|null,wallNow:number):{retryAfterMs:number|null;retryAfterStatus:'MISSING'|'VALID'|'INVALID'}{
  if(value===null)return {retryAfterMs:null,retryAfterStatus:'MISSING'};
  let ms:number;
  if(/^\d+$/.test(value)){const seconds=Number(value);ms=seconds*1000;if(!Number.isSafeInteger(seconds)||!Number.isSafeInteger(ms))return {retryAfterMs:null,retryAfterStatus:'INVALID'};}
  else{if(!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))return {retryAfterMs:null,retryAfterStatus:'INVALID'};const at=Date.parse(value);if(!Number.isSafeInteger(at)||!Number.isSafeInteger(wallNow))return {retryAfterMs:null,retryAfterStatus:'INVALID'};ms=Math.max(0,at-wallNow);}
  return Number.isSafeInteger(ms)?{retryAfterMs:ms,retryAfterStatus:'VALID'}:{retryAfterMs:null,retryAfterStatus:'INVALID'};
}
/** Fixed non-streaming transport. Reasoning, native final and inert strict arguments have separate custody kinds.
 * No env discovery, SDK retries, redirects, tool execution or caller-selected endpoints. */
export class TeacherProvider {
  #keys:Record<Provider,string|null>;#fetch:typeof fetch;#busy=false;#now:()=>number;#wallNow:()=>number;#lane:'SYNTHETIC_FIXTURE'|'NATIVE_FETCH';
  constructor(credentials:Record<Provider,string|null>,dependencies:{fetch?:typeof fetch;now?:()=>number;wallNow?:()=>number}={}){
    this.#keys={...credentials};for(const key of Object.values(this.#keys))if(key!==null&&(typeof key!=='string'||key.length===0||key.length>4096||/[\r\n]/.test(key)))stop('WF1_CREDENTIAL');
    this.#fetch=dependencies.fetch??fetch;this.#lane=dependencies.fetch?'SYNTHETIC_FIXTURE':'NATIVE_FETCH';this.#now=dependencies.now??(()=>performance.now());this.#wallNow=dependencies.wallNow??Date.now;
  }
  get transportLane(){return this.#lane;}
  async submit(provider:Provider,body:string,port:ArtifactPort,signal:AbortSignal,authorizeSend:<T>(send:()=>T)=>T=send=>send(),contract?:{operation:Operation;binding:RequestBinding}):Promise<ProviderResult>{
    if(contract)(contract.binding.payloadCodec==='CORPUS_PRODUCTION_V1'?validateProductionRequest:contract.binding.payloadCodec==='CORPUS_TEACHER_V1'?validateCorpusRequest:contract.binding.protocol==='UNIT_TOGETHER_SCHEMA_FINAL_V1'||contract.binding.protocol==='UNIT_DEEPSEEK_JSON_FINAL_V1'?validateUnitRequest:contract.binding.protocol==='TOGETHER_SCHEMA_FINAL_V1'?validatePilotRequest:contract.binding.profileDigest!==undefined?validateNamedDataRequest:contract.binding.payloadCodec===undefined?validateStrictDataRequest:validateFixedSlotRequest)(provider,contract.operation,body,contract.binding);
    if(this.#busy)stop('WF1_IN_FLIGHT');if(!this.#keys[provider])stop('WF1_CREDENTIAL_UNAVAILABLE');if(Buffer.byteLength(body)>(contract?.binding.payloadCodec==='CORPUS_PRODUCTION_V1'?PRODUCTION.requestBytes:WF1.requestBytes))stop('WF1_REQUEST_BYTES');
    const start=this.#now();this.#busy=true;
    const empty:ProviderResult={outcome:'SUBMIT_UNKNOWN',httpStatus:null,failure:'TRANSPORT_UNKNOWN',transportLane:this.#lane,requestedModel:MODELS[provider],returnedModel:null,requestId:null,finishReason:null,
      reasoningPresent:false,contentPresent:false,usage:null,rawRef:null,reasoningRef:null,finalRef:null,elapsedMs:0,responseFailureCode:'TRANSPORT_UNKNOWN',
      ...(contract?{payloadOrigin:contract.binding.protocol==='DEEPSEEK_STRICT_DATA_ARGS_V1'?'STRICT_TOOL_ARGUMENTS' as const:contract.binding.protocol==='DEEPSEEK_NAMED_DATA_ARGS_V1'?'NAMED_TOOL_ARGUMENTS' as const:'NATIVE_FINAL' as const,argumentsRef:null}:{})};
    let rawOperation:Promise<ProviderResult>|undefined;
    try{return await bounded(signal,contract?.binding.payloadCodec==='CORPUS_PRODUCTION_V1'?PRODUCTION.requestMs:WF1.requestMs,inner=>{
      rawOperation=this.#request(provider,body,port,inner,empty,authorizeSend,contract).finally(()=>{this.#busy=false;});return rawOperation;
    });}catch{return {...empty,responseFailureCode:'UNKNOWN',elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};}
    finally{if(!rawOperation)this.#busy=false;}
  }
  async #request(provider:Provider,body:string,port:ArtifactPort,signal:AbortSignal,base:ProviderResult,authorizeSend:<T>(send:()=>T)=>T,contract?:{operation:Operation;binding:RequestBinding}):Promise<ProviderResult>{
    const start=this.#now();let response:Response;
    try{signal.throwIfAborted();response=await authorizeSend(()=>this.#fetch(contract?.binding.endpoint??ENDPOINTS[provider],{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json',authorization:'Bearer '+this.#keys[provider]},body,signal}));}
    catch{return {...base,elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};}
    base.httpStatus=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
    if(contract?.binding.payloadCodec==='CORPUS_PRODUCTION_V1'&&response.status===429)Object.assign(base,productionRetryAfter(response.headers.get('retry-after'),this.#wallNow()));
    let raw:Uint8Array|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;const diagnostic:ResponseDiagnostic={code:'UNKNOWN'};
    const put:ArtifactPort['put']=(kind,bytes)=>{try{return port.put(kind,bytes);}catch(error){diagnostic.code='ARTIFACT_WRITE_FAILED';throw error;}};
    try{
      const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>WF1.responseBytes))stop('WF1_RESPONSE_BYTES');
      if(!response.body)stop('WF1_RESPONSE');reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      const abort=()=>{void reader?.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
      try{while(true){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;bytes+=part.value.byteLength;if(bytes>WF1.responseBytes)stop('WF1_RESPONSE_BYTES');chunks.push(part.value);}raw=Buffer.concat(chunks);}
      finally{signal.removeEventListener('abort',abort);}
      if(raw.length)base.rawRef=put('provider-raw',raw);
      if(response.status!==200)return {...base,outcome:'FAILED',failure:'HTTP_STATUS',responseFailureCode:'HTTP_STATUS',elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};
      diagnostic.code='ENVELOPE_REJECTED';
      if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))stop('WF1_RESPONSE');
      let parsedEnvelope;try{parsedEnvelope=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch(error){diagnostic.code=parseFailureCode(error,'ENVELOPE');throw error;}
      const envelope=fields(parsedEnvelope,['choices'],['id','object','created','model','usage','system_fingerprint','service_tier',...((contract?.binding.protocol==='TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='UNIT_TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='CORPUS_TOGETHER_SCHEMA_V1')?['prompt','warnings']:[])]);
      if((contract?.binding.protocol==='TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='UNIT_TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='CORPUS_TOGETHER_SCHEMA_V1'))validatePilotEnvelopeExtras(envelope);
      base.usage=nativeUsage(envelope.usage);if(envelope.model!==undefined)base.returnedModel=text(envelope.model,256);if(envelope.id!==undefined)base.requestId=text(envelope.id,256);
      if(base.returnedModel!==MODELS[provider])stop('WF1_RETURNED_MODEL');
      if(!Array.isArray(envelope.choices)||envelope.choices.length!==1)stop('WF1_RESPONSE');
      const choice=fields(envelope.choices[0],['index','message','finish_reason'],['logprobs',...((contract?.binding.protocol==='TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='UNIT_TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='CORPUS_TOGETHER_SCHEMA_V1')?['text','seed','top_logprobs']:[])]);if((contract?.binding.protocol==='TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='UNIT_TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='CORPUS_TOGETHER_SCHEMA_V1'))validatePilotEnvelopeExtras({},choice);if(choice.index!==0)stop('WF1_RESPONSE');
      const message=fields(choice.message,['role','content'],['reasoning','reasoning_content','refusal','tool_calls','annotations','function_call']);if(message.role!=='assistant')stop('WF1_RESPONSE');
      const reasoning=message[provider==='deepseek'?'reasoning_content':'reasoning'];
      if(reasoning!==undefined&&reasoning!==null){text(reasoning,WF1.responseBytes,0);if(reasoning!==''){base.reasoningPresent=true;base.reasoningRef=put('native-reasoning',reasoning as string);}}
      if(contract?.binding.protocol==='DEEPSEEK_STRICT_DATA_ARGS_V1'||contract?.binding.protocol==='DEEPSEEK_NAMED_DATA_ARGS_V1'){
        base.finishReason=choice.finish_reason===null?null:text(choice.finish_reason,64);
        decodeStrictDataArguments(message,base.finishReason,contract.binding.toolName!,raw=>{base.argumentsRef=put(contract.binding.protocol==='DEEPSEEK_NAMED_DATA_ARGS_V1'?'named-tool-arguments':'strict-tool-arguments',raw);},diagnostic);
        if(signal.aborted)stop('WF2_STRICT_ABORTED');return {...base,outcome:'COMPLETED',failure:null,responseFailureCode:'NONE',elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};
      }
      if(message.content!==null){text(message.content,WF1.responseBytes,0);if((message.content as string).trim()!==''){base.contentPresent=true;base.finalRef=put('native-final',message.content as string);}}
      base.finishReason=choice.finish_reason===null?null:text(choice.finish_reason,64);
      const pending=message.tool_calls!==undefined&&message.tool_calls!==null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length>0)||message.function_call!==undefined&&message.function_call!==null;
      base.outcome=base.finishReason==='stop'&&base.contentPresent&&!pending&&!signal.aborted?'COMPLETED':'INCOMPLETE_OUTPUT';
      base.failure=base.outcome==='COMPLETED'?null:'INCOMPLETE_FINAL';
      base.responseFailureCode=base.outcome==='COMPLETED'?'NONE':'INCOMPLETE_FINAL';
      if((contract?.binding.protocol==='TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='UNIT_TOGETHER_SCHEMA_FINAL_V1'||contract?.binding.protocol==='CORPUS_TOGETHER_SCHEMA_V1'||contract?.binding.protocol==='UNIT_DEEPSEEK_JSON_FINAL_V1'||contract?.binding.protocol==='CORPUS_PRODUCTION_DEEPSEEK_V1')&&base.outcome==='COMPLETED'){
        let value;try{value=parseJson(message.content as string);}catch(error){diagnostic.code=argumentsFailureCode(error,message.content as string,'FINAL');throw error;}
        if(value===null||typeof value!=='object'||Array.isArray(value)){diagnostic.code='FINAL_ROOT_NOT_OBJECT';stop('WF2_PILOT_FINAL_ROOT');}
      }
      return {...base,elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};
    }catch(e){const code=signal.aborted?'UNKNOWN':diagnostic.code==='ARTIFACT_WRITE_FAILED'?diagnostic.code:e instanceof Wf1Error&&e.code==='WF1_RETURNED_MODEL'?'MODEL_IDENTITY':e instanceof Wf1Error&&e.code==='WF1_RESPONSE_BYTES'?'RESPONSE_LIMIT':e instanceof Wf1Error?diagnostic.code:'UNKNOWN';
      return {...base,outcome:signal.aborted?'SUBMIT_UNKNOWN':'FAILED',failure:signal.aborted?'TRANSPORT_UNKNOWN':e instanceof Wf1Error&&e.code==='WF1_RETURNED_MODEL'?'MODEL_IDENTITY':e instanceof Wf1Error&&e.code==='WF1_RESPONSE_BYTES'?'RESPONSE_LIMIT':'RESPONSE_PROTOCOL',responseFailureCode:code,elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};}
    finally{if(reader)try{await reader.cancel();}catch{/* Transport occupancy remains held until cancellation settles. */}}
  }
}
