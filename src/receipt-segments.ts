import {brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {isProxy} from 'node:util/types';
import {id} from './anchored-codec.ts';
import {record,sha} from './durable-codec.ts';
import {fail} from './validation.ts';

export const RECEIPT_SEGMENT_LIMITS=Object.freeze({receipts:256,decodedBytes:1048576,encodedBytes:1048576,segments:128});
export const RECEIPT_POINTER_PREFIX='@companion-receipt-segment-v1:';
export const RECEIPT_POINTER_LIMIT=256;
const FORMAT='companion-authority-receipts-v1';
export type RolloverRequest={operationId:string;maxReceipts?:number;maxJsonBytes?:number};
export type NormalizedRollover=Required<RolloverRequest>;
export type RolloverReceipt={version:1;operationId:string;requestDigest:string;receiptCount:number;jsonUtf8Bytes:number;
  decodedBytes:number;encodedBytes:number;digest:string;limits:{maxReceipts:number;maxJsonBytes:number}};
export type ReceiptEntry={vaultId:string;operationId:string;json:string};
export type ReceiptPointer={segmentId:string;index:number;jsonBytes:number};
export function normalizeRollover(value:unknown):NormalizedRollover{
  if(!value||typeof value!=='object'||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('ANCHOR_ROLLOVER_REQUEST');
  const fields=Reflect.ownKeys(value);
  if(fields.length>3||fields.some(k=>typeof k!=='string'||!['operationId','maxReceipts','maxJsonBytes'].includes(k)))fail('ANCHOR_ROLLOVER_REQUEST');
  const copy:Record<string,unknown>=Object.create(null);
  for(const key of fields as string[]){const d=Object.getOwnPropertyDescriptor(value,key)!;if(!Object.hasOwn(d,'value'))fail('ANCHOR_ROLLOVER_REQUEST');copy[key]=d.value;}
  const {operationId}=copy,maxReceipts=copy.maxReceipts===undefined?128:copy.maxReceipts,maxJsonBytes=copy.maxJsonBytes===undefined?1048576:copy.maxJsonBytes;
  if(typeof operationId!=='string'||!Number.isSafeInteger(maxReceipts)||(maxReceipts as number)<1||(maxReceipts as number)>256
    ||!Number.isSafeInteger(maxJsonBytes)||(maxJsonBytes as number)<1024||(maxJsonBytes as number)>1048576)fail('ANCHOR_ROLLOVER_REQUEST');
  id(operationId);return{operationId,maxReceipts:maxReceipts as number,maxJsonBytes:maxJsonBytes as number};
}
function closed(value:unknown,fields:string[]):value is Record<string,unknown>{
  return record(value)&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k));
}
export function receiptPointer(segmentId:string,index:number,jsonBytes:number):string{
  return RECEIPT_POINTER_PREFIX+JSON.stringify([segmentId,index,jsonBytes]);
}
export function parseReceiptPointer(value:string):ReceiptPointer|null{
  if(!value.startsWith(RECEIPT_POINTER_PREFIX))return null;
  try{
    if(Buffer.byteLength(value)>RECEIPT_POINTER_LIMIT)fail('ANCHOR_RECEIPT_SEGMENT');
    const p:unknown=JSON.parse(value.slice(RECEIPT_POINTER_PREFIX.length));
    if(!Array.isArray(p)||p.length!==3||typeof p[0]!=='string'||!Number.isSafeInteger(p[1])||p[1]<0||p[1]>=256
      ||!Number.isSafeInteger(p[2])||p[2]<1||p[2]>1048576)fail('ANCHOR_RECEIPT_SEGMENT');
    id(p[0]);if(receiptPointer(p[0],p[1],p[2])!==value)fail('ANCHOR_RECEIPT_SEGMENT');
    return{segmentId:p[0],index:p[1],jsonBytes:p[2]};
  }catch{fail('ANCHOR_RECEIPT_SEGMENT');}
}
export function validateReceiptEntry(entry:ReceiptEntry):void{
  try{
    id(entry.vaultId);id(entry.operationId);
    const value:unknown=JSON.parse(entry.json);
    if(!record(value)||value.version!==2||value.operationId!==entry.operationId||!record(value.newHead)||value.newHead.vaultId!==entry.vaultId)fail('ANCHOR_RECEIPT_SEGMENT');
  }catch{fail('ANCHOR_RECEIPT_SEGMENT');}
}
export function segmentFrame(segmentId:string,entries:ReceiptEntry[]):string{return JSON.stringify({format:FORMAT,segmentId,entries});}
export function encodeReceiptSegment(segmentId:string,entries:ReceiptEntry[],limit:number){
  if(entries.length<1||entries.length>256)fail('ANCHOR_RECEIPT_SEGMENT');
  const raw=Buffer.from(segmentFrame(segmentId,entries));
  try{
    if(raw.length>limit||raw.length>1048576)fail('ANCHOR_ROLLOVER_BOUND');
    const payload=brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4}});
    if(payload.length>1048576){payload.fill(0);fail('ANCHOR_ROLLOVER_BOUND');}
    return{payload,decodedBytes:raw.length,digest:sha(raw),jsonBytes:entries.reduce((n,e)=>n+Buffer.byteLength(e.json),0)};
  }finally{raw.fill(0);}
}
export function decodeReceiptSegment(payload:Uint8Array,segmentId:string,decodedBytes:number,digest:string,count:number,jsonBytes:number):ReceiptEntry[]{
  let raw:Buffer|undefined;
  try{
    if(payload.byteLength<1||payload.byteLength>1048576||!Number.isSafeInteger(decodedBytes)||decodedBytes<1||decodedBytes>1048576
      ||!Number.isSafeInteger(count)||count<1||count>256||!Number.isSafeInteger(jsonBytes)||jsonBytes<1||jsonBytes>decodedBytes||!/^[a-f0-9]{64}$/.test(digest))fail('ANCHOR_RECEIPT_SEGMENT');
    const result=brotliDecompressSync(payload,{maxOutputLength:decodedBytes,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
    raw=result.buffer;
    if(result.engine.bytesWritten!==payload.byteLength||raw.length!==decodedBytes||sha(raw)!==digest)fail('ANCHOR_RECEIPT_SEGMENT');
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw));
    if(!closed(value,['format','segmentId','entries'])||value.format!==FORMAT||value.segmentId!==segmentId||!Array.isArray(value.entries)||value.entries.length!==count)fail('ANCHOR_RECEIPT_SEGMENT');
    const seen=new Set<string>();let total=0;
    const entries=value.entries.map((e:unknown)=>{
      if(!closed(e,['vaultId','operationId','json'])||typeof e.vaultId!=='string'||typeof e.operationId!=='string'||typeof e.json!=='string')fail('ANCHOR_RECEIPT_SEGMENT');
      const entry:ReceiptEntry={vaultId:e.vaultId,operationId:e.operationId,json:e.json};validateReceiptEntry(entry);
      const key=JSON.stringify([entry.vaultId,entry.operationId]);if(seen.has(key))fail('ANCHOR_RECEIPT_SEGMENT');seen.add(key);total+=Buffer.byteLength(entry.json);return entry;
    });
    if(total!==jsonBytes)fail('ANCHOR_RECEIPT_SEGMENT');return entries;
  }catch{return fail('ANCHOR_RECEIPT_SEGMENT');}finally{raw?.fill(0);}
}
