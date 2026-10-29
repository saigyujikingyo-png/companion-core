import { canonical,hash } from '../src/wf1-json.ts';
import { MODELS } from '../src/wf1-types.ts';
import { createProductionTransport } from '../src/corpus-production-runner.ts';
import { createQaTransport } from '../src/corpus-qa-runner.ts';

export type SyntheticReply={operation:string;index:number;body:any;envelope:any;status:number;headers:Record<string,string>};
type Options={usage?:'known'|'missing'|'null';change?:(r:SyntheticReply)=>void|Promise<void>};
const fixtureFetch=(qa:boolean,o:Options)=>{
  const calls:{operation:string;index:number}[]=[];
  const fetcher:typeof fetch=async(_url,init)=>{
    const outer=JSON.parse(String(init!.body)),request=JSON.parse(outer.messages[1].content),{operation,index,data}=request;calls.push({operation,index});
    const body=qa?(operation==='rubric'?{version:'CorpusQualityRubric/0.1',instructions:'SYNTHETIC review policy',criteria:[{id:'synthetic-criterion',criterion:'SYNTHETIC criterion'}]}:{version:'CorpusQualityVerdicts/0.1',items:data.items.map((i:any)=>({caseId:i.caseId,inputDigest:i.inputDigest,disposition:'PASS',criterionCodes:['synthetic-criterion'],notes:'SYNTHETIC opinion'}))}):{version:'CorpusProductionResponse/0.1',items:operation==='plan'?data.slots.map((s:any)=>({ordinal:s.ordinal,unitId:s.unitId,task:'SYNTHETIC task '+hash(String(s.ordinal)),rubric:'SYNTHETIC criterion'})):operation==='candidate'?data.tasks.map((t:any)=>({version:'CorpusProductionItem/0.1',unitId:t.unitId,prompt:'Question '+hash('prompt'+t.ordinal),response:'Answer '+hash('answer'+t.ordinal)})):data.items.map((v:any)=>({unitId:v.candidate.unitId,candidateDigest:v.candidateDigest,disposition:'ACCEPT',notes:'SYNTHETIC review'}))};
    const envelope:any={model:qa&&operation==='review'?MODELS.together:MODELS.deepseek,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:canonical(body)}}]};
    if(o.usage==='known')envelope.usage={prompt_tokens:100,completion_tokens:80,total_tokens:180,completion_tokens_details:{reasoning_tokens:20}};else if(o.usage==='null')envelope.usage=null;
    const reply:SyntheticReply={operation,index,body,envelope,status:200,headers:{'content-type':'application/json'}};await o.change?.(reply);reply.envelope.choices[0].message.content=canonical(reply.body);
    return new Response(canonical(reply.envelope),{status:reply.status,headers:reply.headers});
  };return {calls,fetcher};
};
/** Real provider codecs and encrypted ports, injected in-memory HTTP only. */
export function nativeProduction(o:Options={}){const f=fixtureFetch(false,o);return {calls:f.calls,transport:createProductionTransport({deepseek:'SYNTHETIC_NOT_A_CREDENTIAL'},{fetch:f.fetcher})};}
export function nativeQa(o:Options={}){const f=fixtureFetch(true,o);return {calls:f.calls,transport:createQaTransport({deepseek:'SYNTHETIC_NOT_A_CREDENTIAL',together:'SYNTHETIC_NOT_A_CREDENTIAL'},{fetch:f.fetcher})};}
