import {isProxy} from 'node:util/types';
import {record} from './durable-codec.ts';
import type {Safety} from './durable-codec.ts';
import {fail} from './validation.ts';

export const COLD_SAFETY_PROFILE='blocks-br4-safety-cold-v1' as const;
export const MAX_COLD_PLAIN=8*1024*1024,MAX_COLD_CIPHER=MAX_COLD_PLAIN+28,MAX_COMPLETE_SAFETY=4*1024*1024;
export type SafetyEntry=Safety['ingress'][number];
export type OrderedSafetyEntry={ordinal:number;entry:SafetyEntry};
export type HotSafetyEnvelope={version:1;globals:Omit<Safety,'ingress'>;ingress:OrderedSafetyEntry[]};
export type HotSafetyCarrier={version:1;codec:'raw'|'br4';decodedBytes:number;digest:string;data:HotSafetyEnvelope|string};
export type SafetyColdDescriptor={version:1;format:'aemc-safety-sqlite-v1';file:string;cipherDigest:string;cipherBytes:number;
  plainDigest:string;plainBytes:number;entryDigest:string;entryCount:number;reservedCount:number;unknownCount:number};
export const terminalEligible=(entry:SafetyEntry):boolean=>entry.state==='failed'||entry.state==='unknown'||(entry.state==='acknowledged'&&entry.feedbackConsumed);

/** Exact JSON values only; reject conversions, accessors, holes and cycles. */
export function canonicalSafetyJSON(value:unknown):string{
  const ancestors=new Set<object>();
  const walk=(v:unknown,depth:number):unknown=>{
    if(depth>128)fail('SAFETY_JSON');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0))fail('SAFETY_JSON');return v;}
    if(typeof v!=='object'||isProxy(v)||ancestors.has(v))fail('SAFETY_JSON');
    const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
    if(keys.some(k=>typeof k!=='string'||!Object.hasOwn(descriptors[k]!,'value')))fail('SAFETY_JSON');
    ancestors.add(v);
    try{
      if(Array.isArray(v)){
        if(keys.length!==v.length+1||keys.some(k=>k!=='length'&&(!/^(0|[1-9][0-9]*)$/.test(k as string)||Number(k)>=v.length)))fail('SAFETY_JSON');
        return Array.from({length:v.length},(_,i)=>{if(!Object.hasOwn(descriptors,String(i)))fail('SAFETY_JSON');return walk(descriptors[String(i)]!.value,depth+1);});
      }
      if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('SAFETY_JSON');
      const result:Record<string,unknown>=Object.create(null);
      for(const k of (keys as string[]).sort()){if(!descriptors[k]!.enumerable)fail('SAFETY_JSON');result[k]=walk(descriptors[k]!.value,depth+1);}
      return result;
    }finally{ancestors.delete(v);}
  };
  return JSON.stringify(walk(value,0));
}
export function validateColdDescriptor(value:unknown):asserts value is SafetyColdDescriptor{
  if(!record(value)||Object.keys(value).sort().join(',')!=='cipherBytes,cipherDigest,entryCount,entryDigest,file,format,plainBytes,plainDigest,reservedCount,unknownCount,version'
    ||value.version!==1||value.format!=='aemc-safety-sqlite-v1'
    ||!['cipherDigest','plainDigest','entryDigest'].every(k=>typeof value[k]==='string'&&/^[a-f0-9]{64}$/.test(value[k]))
    ||value.file!==`safety-${value.cipherDigest}.bin`||!Number.isSafeInteger(value.plainBytes)||value.plainBytes<4096||value.plainBytes>MAX_COLD_PLAIN
    ||value.plainBytes%4096!==0||value.cipherBytes!==value.plainBytes+28
    ||!Number.isSafeInteger(value.entryCount)||value.entryCount<1||value.entryCount>8192
    ||!['reservedCount','unknownCount'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=value.entryCount))fail('SAFETY_COLD_DESCRIPTOR');
}
export function validateHotEnvelope(value:unknown):asserts value is HotSafetyEnvelope{
  if(!record(value)||Object.keys(value).sort().join(',')!=='globals,ingress,version'||value.version!==1||!record(value.globals)
    ||Object.hasOwn(value.globals,'ingress')||!Array.isArray(value.ingress)||value.ingress.length>8192)fail('SAFETY_HOT_ENVELOPE');
  let last=-1;
  for(const row of value.ingress){
    if(!record(row)||Object.keys(row).sort().join(',')!=='entry,ordinal'||!Number.isSafeInteger(row.ordinal)||row.ordinal<=last||row.ordinal>=8192||!record(row.entry))fail('SAFETY_HOT_ORDINAL');
    last=row.ordinal;
  }
  if(Buffer.byteLength(canonicalSafetyJSON(value))>MAX_COMPLETE_SAFETY)fail('SAFETY_HOT_LIMIT');
}
