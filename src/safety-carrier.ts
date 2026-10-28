import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { record, sha, validateIdentityBudget } from './durable-codec.ts';
import type { Safety } from './durable-codec.ts';
import { validateSafetyState } from './anchored-codec.ts';
import type { VaultIdentity } from './anchored-codec.ts';
import { fail } from './validation.ts';

export const MAX_SAFETY_BYTES=4*1024*1024;
export const PACKED_SAFETY_PROFILE='blocks-br4-safety-br4-v1' as const;
export type SafetyCarrier={version:1;codec:'raw'|'br4';decodedBytes:number;digest:string;data:Safety|string};

/** Complete carrier cost includes JSON descriptor, inline JSON or base64 overhead. */
export function encodeSafetyCarrier(safety:Safety,identity:VaultIdentity,maxCalls:number):SafetyCarrier{
  validateIdentityBudget(identity.identity,maxCalls);
  validateSafetyState(safety,identity,maxCalls);
  const raw=Buffer.from(JSON.stringify(safety));
  if(raw.length>MAX_SAFETY_BYTES){raw.fill(0);fail('SAFETY_CARRIER_LIMIT');}
  let packed:Buffer|undefined;
  try{
    const common={version:1 as const,decodedBytes:raw.length,digest:sha(raw)};
    const inline:SafetyCarrier={...common,codec:'raw',data:safety};
    packed=brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4}});
    const compressed:SafetyCarrier={...common,codec:'br4',data:packed.toString('base64')};
    const result=Buffer.byteLength(JSON.stringify(compressed))<Buffer.byteLength(JSON.stringify(inline))?compressed:inline;
    validateSafetyCarrier(result);return result;
  }finally{raw.fill(0);packed?.fill(0);}
}

/** Descriptor-only admission; callers account decodedBytes before unpacking. */
export function validateSafetyCarrier(value:unknown):asserts value is SafetyCarrier{
  if(!record(value)||Object.keys(value).sort().join(',')!=='codec,data,decodedBytes,digest,version'||value.version!==1
    ||!['raw','br4'].includes(value.codec)||!Number.isSafeInteger(value.decodedBytes)||value.decodedBytes<1||value.decodedBytes>MAX_SAFETY_BYTES
    ||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)
    ||Buffer.byteLength(JSON.stringify(value))>MAX_SAFETY_BYTES)fail('SAFETY_CARRIER_DESCRIPTOR');
  if(value.codec==='raw'){
    if(!record(value.data)||Buffer.byteLength(JSON.stringify(value.data))!==value.decodedBytes)fail('SAFETY_CARRIER_DESCRIPTOR');
  }else if(typeof value.data!=='string'||value.data.length===0||value.data.length%4!==0
    ||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))fail('SAFETY_CARRIER_DESCRIPTOR');
}

export function decodeSafetyCarrier(value:SafetyCarrier,identity:VaultIdentity,maxCalls:number):Safety{
  validateIdentityBudget(identity.identity,maxCalls);
  validateSafetyCarrier(value);
  let raw:Buffer|undefined,encoded:Buffer|undefined;
  try{
    if(value.codec==='raw')raw=Buffer.from(JSON.stringify(value.data));
    else{
      encoded=Buffer.from(value.data as string,'base64');
      if(encoded.toString('base64')!==value.data)fail('SAFETY_CARRIER_DESCRIPTOR');
      try{
        const result=brotliDecompressSync(encoded,{maxOutputLength:value.decodedBytes,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
        raw=result.buffer;if(result.engine.bytesWritten!==encoded.length)fail('SAFETY_CARRIER_DECODE');
      }catch{fail('SAFETY_CARRIER_DECODE');}
    }
    if(raw.length!==value.decodedBytes||sha(raw)!==value.digest)fail('SAFETY_CARRIER_DECODE');
    let safety:Safety;
    try{safety=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw));}catch{fail('SAFETY_CARRIER_DECODE');}
    validateSafetyState(safety,identity,maxCalls);return safety;
  }finally{raw?.fill(0);encoded?.fill(0);}
}
