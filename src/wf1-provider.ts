import { bounded } from './runtime.ts';
import { canonical,fields,integer,parseJson,stop,text,Wf1Error } from './wf1-json.ts';
import { completionCap,ENDPOINTS,MODELS,WF1 } from './wf1-types.ts';
import type { Operation,Provider,ProviderResult,Usage } from './wf1-types.ts';
import type { ArtifactPort } from './wf1-storage.ts';

export function providerBody(provider:Provider,payload:unknown,operation:Operation='candidate'):string {
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
/** Fixed non-streaming text transport. Native reasoning/final are retained separately in private custody.
 * No env discovery, SDK retries, redirects, tools or generic endpoints. */
export class TeacherProvider {
  #keys:Record<Provider,string|null>;#fetch:typeof fetch;#busy=false;#now:()=>number;#lane:'SYNTHETIC_FIXTURE'|'NATIVE_FETCH';
  constructor(credentials:Record<Provider,string|null>,dependencies:{fetch?:typeof fetch;now?:()=>number}={}){
    this.#keys={...credentials};for(const key of Object.values(this.#keys))if(key!==null&&(typeof key!=='string'||key.length===0||key.length>4096||/[\r\n]/.test(key)))stop('WF1_CREDENTIAL');
    this.#fetch=dependencies.fetch??fetch;this.#lane=dependencies.fetch?'SYNTHETIC_FIXTURE':'NATIVE_FETCH';this.#now=dependencies.now??(()=>performance.now());
  }
  get transportLane(){return this.#lane;}
  async submit(provider:Provider,body:string,port:ArtifactPort,signal:AbortSignal,authorizeSend:<T>(send:()=>T)=>T=send=>send()):Promise<ProviderResult>{
    if(this.#busy)stop('WF1_IN_FLIGHT');if(!this.#keys[provider])stop('WF1_CREDENTIAL_UNAVAILABLE');if(Buffer.byteLength(body)>WF1.requestBytes)stop('WF1_REQUEST_BYTES');
    const start=this.#now();this.#busy=true;
    const empty:ProviderResult={outcome:'SUBMIT_UNKNOWN',httpStatus:null,failure:'TRANSPORT_UNKNOWN',transportLane:this.#lane,requestedModel:MODELS[provider],returnedModel:null,requestId:null,finishReason:null,
      reasoningPresent:false,contentPresent:false,usage:null,rawRef:null,reasoningRef:null,finalRef:null,elapsedMs:0};
    let rawOperation:Promise<ProviderResult>|undefined;
    try{return await bounded(signal,WF1.requestMs,inner=>{
      rawOperation=this.#request(provider,body,port,inner,empty,authorizeSend).finally(()=>{this.#busy=false;});return rawOperation;
    });}catch{return {...empty,elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};}
    finally{if(!rawOperation)this.#busy=false;}
  }
  async #request(provider:Provider,body:string,port:ArtifactPort,signal:AbortSignal,base:ProviderResult,authorizeSend:<T>(send:()=>T)=>T):Promise<ProviderResult>{
    const start=this.#now();let response:Response;
    try{signal.throwIfAborted();response=await authorizeSend(()=>this.#fetch(ENDPOINTS[provider],{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json',authorization:'Bearer '+this.#keys[provider]},body,signal}));}
    catch{return {...base,elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};}
    base.httpStatus=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
    let raw:Uint8Array|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try{
      const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>WF1.responseBytes))stop('WF1_RESPONSE_BYTES');
      if(!response.body)stop('WF1_RESPONSE');reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      const abort=()=>{void reader?.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
      try{while(true){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;bytes+=part.value.byteLength;if(bytes>WF1.responseBytes)stop('WF1_RESPONSE_BYTES');chunks.push(part.value);}raw=Buffer.concat(chunks);}
      finally{signal.removeEventListener('abort',abort);}
      if(raw.length)base.rawRef=port.put('provider-raw',raw);
      if(response.status!==200)return {...base,outcome:'FAILED',failure:'HTTP_STATUS',elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};
      if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))stop('WF1_RESPONSE');
      const envelope=fields(parseJson(new TextDecoder('utf-8',{fatal:true}).decode(raw)),['choices'],['id','object','created','model','usage','system_fingerprint','service_tier']);
      base.usage=nativeUsage(envelope.usage);if(envelope.model!==undefined)base.returnedModel=text(envelope.model,256);if(envelope.id!==undefined)base.requestId=text(envelope.id,256);
      if(base.returnedModel!==MODELS[provider])stop('WF1_RETURNED_MODEL');
      if(!Array.isArray(envelope.choices)||envelope.choices.length!==1)stop('WF1_RESPONSE');
      const choice=fields(envelope.choices[0],['index','message','finish_reason'],['logprobs']);if(choice.index!==0)stop('WF1_RESPONSE');
      const message=fields(choice.message,['role','content'],['reasoning','reasoning_content','refusal','tool_calls','annotations','function_call']);if(message.role!=='assistant')stop('WF1_RESPONSE');
      const reasoning=message[provider==='deepseek'?'reasoning_content':'reasoning'];
      if(reasoning!==undefined&&reasoning!==null){text(reasoning,WF1.responseBytes,0);if(reasoning!==''){base.reasoningPresent=true;base.reasoningRef=port.put('native-reasoning',reasoning as string);}}
      if(message.content!==null){text(message.content,WF1.responseBytes,0);if((message.content as string).trim()!==''){base.contentPresent=true;base.finalRef=port.put('native-final',message.content as string);}}
      base.finishReason=choice.finish_reason===null?null:text(choice.finish_reason,64);
      const pending=message.tool_calls!==undefined&&message.tool_calls!==null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length>0)||message.function_call!==undefined&&message.function_call!==null;
      base.outcome=base.finishReason==='stop'&&base.contentPresent&&!pending&&!signal.aborted?'COMPLETED':'INCOMPLETE_OUTPUT';
      base.failure=base.outcome==='COMPLETED'?null:'INCOMPLETE_FINAL';
      return {...base,elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};
    }catch(e){return {...base,outcome:signal.aborted?'SUBMIT_UNKNOWN':'FAILED',failure:signal.aborted?'TRANSPORT_UNKNOWN':e instanceof Wf1Error&&e.code==='WF1_RETURNED_MODEL'?'MODEL_IDENTITY':e instanceof Wf1Error&&e.code==='WF1_RESPONSE_BYTES'?'RESPONSE_LIMIT':'RESPONSE_PROTOCOL',elapsedMs:Math.max(0,Math.ceil(this.#now()-start))};}
    finally{if(reader)try{await reader.cancel();}catch{/* Transport occupancy remains held until cancellation settles. */}}
  }
}
