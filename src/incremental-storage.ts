import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { MAX_COMMITS, record, sha } from './durable-codec.ts';
import type { Safety } from './durable-codec.ts';
import { INCREMENTAL_FORMAT, id, identityOf, integer, readBounded, same, validateHead, validateSafetyState } from './anchored-codec.ts';
import type { KeySet, VaultHead, VaultIdentity, VaultRecord } from './anchored-codec.ts';
import { decodeBlocks, encodeBlocks, chainLimit, MAX_PATCH, MAX_REPLAY_BYTES, validateBlocks } from './incremental-codec.ts';
import type { BlockEncoding } from './incremental-codec.ts';
import { fail } from './validation.ts';
import type {LegacyImportProof} from './legacy-import-types.ts';
import {decodeSafetyCarrier,encodeSafetyCarrier,PACKED_SAFETY_PROFILE,validateSafetyCarrier,encodeHotSafetyCarrier,decodeHotSafetyCarrier,validateHotSafetyCarrier} from './safety-carrier.ts';
import type {SafetyCarrier} from './safety-carrier.ts';
import {COLD_SAFETY_PROFILE} from './safety-format.ts';
import type {HotSafetyEnvelope,HotSafetyCarrier,OrderedSafetyEntry} from './safety-format.ts';
import {SafetyLedger,allHotSafety,completeHotSafety,validateHotSnapshot} from './safety-ledger.ts';
import {SafetySegment} from './safety-segment.ts';

export const FRAME_LIMIT=MAX_PATCH+4*1024*1024+32, RECORD_LIMIT=32768, MANIFEST_LIMIT=65536;
export type FrozenV3={format:typeof INCREMENTAL_FORMAT;head:VaultHead;blob:string;blobDigest:string;blobLength:number;record:string};
export type FrameRecord=Omit<VaultRecord,'version'> & {version:3;previousHead:VaultHead|null};
type Header={version:3;identity:VaultIdentity;sequence:number;safety:Safety;revocationHighWater:number;ingressKeyDigest:string;
  blocks:BlockEncoding;depth:number};
export type Baseline={image:Uint8Array;depth:number;readBytes:number;decodedBytes:number;coldEncodedBytes?:number;coldDecodedBytes?:number};
type WireHeader=Omit<Header,'safety'> & {safety:Safety|SafetyCarrier|HotSafetyCarrier};
type Loaded={stage:FrozenV3;state:Header;hot?:HotSafetyEnvelope;decodedBytes:number;record:FrameRecord;payload:Buffer;recordBytes:Buffer;blobBytes:Buffer};
export type Reconstructed={stage:FrozenV3;state:Header;record:FrameRecord;image:Buffer;baseline:Baseline;files:Map<string,Buffer>;ledger:SafetyLedger};
export type FrameReader=(name:string,maximum:number)=>Buffer;
function seal(plain:Uint8Array,purpose:string,identity:VaultIdentity,key:Uint8Array):Buffer{
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,purpose,identity])));
  const result=Buffer.concat([cipher.update(plain),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),result]);
}
function unseal(bytes:Uint8Array,purpose:string,identity:VaultIdentity,key:Uint8Array):Buffer{
  if(bytes.length<28||bytes.length>FRAME_LIMIT)fail('INCREMENTAL_CORRUPT');
  try{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,purpose,identity])));
    cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]);}catch{fail('INCREMENTAL_CORRUPT');}
}
export function freezeFrame(identity:VaultIdentity,sequence:number,operationId:string,image:Uint8Array,safety:Safety,revocationHighWater:number,
  keys:KeySet,oldHead:VaultHead|null,parentHead:VaultHead|null,baseline:Baseline|null,maintenance?:VaultRecord['maintenance'],legacyImport?:LegacyImportProof,hot?:HotSafetyEnvelope):{
    bytes:Buffer;stage:FrozenV3;blob:Buffer;baseline:Baseline;
  }{
  if(identity.format!==INCREMENTAL_FORMAT||!identity.storageProfile||sequence>MAX_COMMITS)fail('INCREMENTAL_PROFILE');
  const coldProfile=identity.storageProfile===COLD_SAFETY_PROFILE;
  if(coldProfile)validateHotSnapshot(safety,hot??allHotSafety(safety),identity);
  const packedSafety=coldProfile?encodeHotSafetyCarrier(hot??allHotSafety(safety)):identity.storageProfile===PACKED_SAFETY_PROFILE?encodeSafetyCarrier(safety,identity,safety.maxCalls):null;
  const coldEncodedBytes=coldProfile?(identity.safetyCold?.cipherBytes??0):0,coldDecodedBytes=coldProfile?(identity.safetyCold?.plainBytes??0):0;
  if(baseline&&coldProfile&&(baseline.coldEncodedBytes!==coldEncodedBytes||baseline.coldDecodedBytes!==coldDecodedBytes))fail('SAFETY_COLD_BASELINE');
  const build=(allow:boolean)=>{
    const encoded=encodeBlocks(image,baseline?.image??null,identity.storageProfile!,allow),base=encoded.descriptor.mode==='base';
    const state:WireHeader={version:3,identity,sequence,safety:packedSafety??safety,revocationHighWater,ingressKeyDigest:sha(keys.ingressKey),blocks:encoded.descriptor,depth:base?1:baseline!.depth+1};
    const header=Buffer.from(JSON.stringify(state));if(header.length>4*1024*1024)fail('INCREMENTAL_LIMIT');
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);const plain=Buffer.concat([prefix,header,encoded.payload]);
    let blob:Buffer;try{blob=seal(plain,'frame',identity,keys.storageDEK);}finally{plain.fill(0);header.fill(0);encoded.payload.fill(0);}
    const row:FrameRecord={version:3,identity,sequence,operationId,previous:oldHead?.digest??null,previousHead:oldHead,parentHead,
      checkpointDigest:sha(blob),revocationHighWater,...(maintenance?{maintenance}:{}),...(legacyImport?{legacyImport}:{})};
    const rowPlain=Buffer.from(JSON.stringify(row));let bytes:Buffer;try{bytes=seal(rowPlain,'record',identity,keys.storageDEK);}finally{rowPlain.fill(0);}
    if(bytes.length>RECORD_LIMIT)fail('INCREMENTAL_LIMIT');
    const stage:FrozenV3={format:INCREMENTAL_FORMAT,head:{...identity,sequence,digest:sha(bytes)},blob:`blob-${sha(blob)}.bin`,blobDigest:sha(blob),blobLength:blob.length,record:bytes.toString('base64')};
    const stageBytes=Buffer.from(JSON.stringify(stage));if(stageBytes.length>MANIFEST_LIMIT)fail('INCREMENTAL_LIMIT');
    return{bytes:stageBytes,stage,blob,baseline:{image,depth:state.depth,
      coldEncodedBytes,coldDecodedBytes,readBytes:(base?coldEncodedBytes:baseline!.readBytes)+blob.length+bytes.length,
      decodedBytes:(base?coldDecodedBytes:baseline!.decodedBytes)+state.blocks.rawLength+(packedSafety?.decodedBytes??0)}};
  };
  let result=build(!!baseline&&baseline.depth<chainLimit(identity.storageProfile));
  if(result.baseline.readBytes>MAX_REPLAY_BYTES||result.baseline.decodedBytes>MAX_REPLAY_BYTES){result.blob.fill(0);result.bytes.fill(0);result=build(false);}
  if(result.baseline.readBytes>MAX_REPLAY_BYTES||result.baseline.decodedBytes>MAX_REPLAY_BYTES){result.blob.fill(0);result.bytes.fill(0);fail('INCREMENTAL_REPLAY_LIMIT');}return result;
}
export function parseFrozenV3(bytes:Uint8Array):FrozenV3{
  if(bytes.length>MANIFEST_LIMIT)fail('INCREMENTAL_LIMIT');let stage:FrozenV3;
  try{stage=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INCREMENTAL_CORRUPT');}
  if(!record(stage)||Object.keys(stage).sort().join(',')!=='blob,blobDigest,blobLength,format,head,record'||stage.format!==INCREMENTAL_FORMAT
    ||typeof stage.record!=='string'||!integer(stage.blobLength,28)||stage.blobLength>FRAME_LIMIT||!/^[a-f0-9]{64}$/.test(stage.blobDigest)
    ||stage.blob!==`blob-${stage.blobDigest}.bin`)fail('INCREMENTAL_CORRUPT');validateHead(stage.head);return stage;
}
function load(head:VaultHead,reader:FrameReader,keys:KeySet,maxCalls:number,remainingDecoded:number,cold:OrderedSafetyEntry[],overlay?:FrozenV3):Loaded{
  validateHead(head);if(head.format!==INCREMENTAL_FORMAT||head.keyEpoch!==keys.keyEpoch)fail('INCREMENTAL_PROFILE');
  const identity=identityOf(head),rowBytes=overlay?Buffer.from(overlay.record,'base64'):reader(`record-${head.sequence}.bin`,RECORD_LIMIT);
  if(rowBytes.length>RECORD_LIMIT||sha(rowBytes)!==head.digest||(overlay&&(!same(overlay.head,head)||rowBytes.toString('base64')!==overlay.record)))fail('INCREMENTAL_CORRUPT');
  const plain=unseal(rowBytes,'record',identity,keys.storageDEK);let row:FrameRecord;
  try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}finally{plain.fill(0);}
  if(!record(row)||row.version!==3||!same(row.identity,identity)||row.sequence!==head.sequence||!integer(row.revocationHighWater)
    ||!/^[a-f0-9]{64}$/.test(row.checkpointDigest))fail('INCREMENTAL_CORRUPT');id(row.operationId);
  if(head.sequence===1){if(row.previousHead!==null||row.previous!==null)fail('INCREMENTAL_CHAIN');if(row.parentHead!==null)validateHead(row.parentHead);}
  else{validateHead(row.previousHead);if(!same(identityOf(row.previousHead),identity)||row.previousHead.sequence!==head.sequence-1||row.previous!==row.previousHead.digest||row.parentHead!==null)fail('INCREMENTAL_CHAIN');}
  const blobName=`blob-${row.checkpointDigest}.bin`,blob=reader(blobName,FRAME_LIMIT);
  if(sha(blob)!==row.checkpointDigest)fail('INCREMENTAL_CORRUPT');
  const stage:FrozenV3={format:INCREMENTAL_FORMAT,head,blob:blobName,blobDigest:row.checkpointDigest,blobLength:blob.length,record:rowBytes.toString('base64')};
  if(overlay&&!same(stage,overlay))fail('INCREMENTAL_CORRUPT');
  const decoded=unseal(blob,'frame',identity,keys.storageDEK);let wire:WireHeader,payload:Buffer;
  try{const n=decoded.readUInt32BE();if(n>4*1024*1024||n+4>decoded.length)fail('INCREMENTAL_CORRUPT');
    wire=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded.subarray(4,4+n)));payload=Buffer.from(decoded.subarray(4+n));}finally{decoded.fill(0);}
  const state=wire as Header;
  try{
  if(!record(state)||state.version!==3||!same(state.identity,identity)||state.sequence!==head.sequence||state.revocationHighWater!==row.revocationHighWater
    ||!integer(state.depth,1)||state.depth>chainLimit(identity.storageProfile))fail('INCREMENTAL_CORRUPT');
  if(state.ingressKeyDigest!==sha(keys.ingressKey))fail('ANCHOR_INGRESS_KEY');validateBlocks(state.blocks,payload.length);
  const packed=identity.storageProfile===PACKED_SAFETY_PROFILE,coldProfile=identity.storageProfile===COLD_SAFETY_PROFILE;
  if(packed)validateSafetyCarrier(wire.safety);
  if(coldProfile)validateHotSafetyCarrier(wire.safety);
  const decodedBytes=state.blocks.rawLength+(packed||coldProfile?(wire.safety as SafetyCarrier).decodedBytes:0);
  if(decodedBytes>remainingDecoded)fail('INCREMENTAL_REPLAY_LIMIT');
  let hot:HotSafetyEnvelope|undefined;
  if(coldProfile){hot=decodeHotSafetyCarrier(wire.safety as HotSafetyCarrier);state.safety=completeHotSafety(hot,cold,identity,maxCalls);}
  else if(packed)state.safety=decodeSafetyCarrier(wire.safety as SafetyCarrier,identity,maxCalls);
  else validateSafetyState(state.safety,identity,maxCalls);
  if(state.blocks.mode==='base'?state.depth!==1:head.sequence===1||identity.storageProfile==='full-br4-v1')fail('INCREMENTAL_CHAIN');
  return{stage,state,...(hot?{hot}:{}),decodedBytes,record:row,payload,recordBytes:rowBytes,blobBytes:blob};
  }catch(error){payload.fill(0);throw error;}
}
/** Only the required base-to-head chain is read/verified. This is NOT an audit
 * of every retained historical blob, record or orphan stage in the directory. */
export function reconstruct(head:VaultHead,reader:FrameReader,keys:KeySet,maxCalls:number,overlay?:FrozenV3):Reconstructed{
  const frames:Loaded[]=[],files=new Map<string,Buffer>();let cursor=head,readBytes=0,decodedBytes=0,image:Buffer|undefined;
  validateHead(head);let actualRead=overlay?Buffer.byteLength(overlay.record,'base64'):0,segment:SafetySegment|undefined;
  const coldEncodedBytes=head.safetyCold?.cipherBytes??0,coldDecodedBytes=head.safetyCold?.plainBytes??0;let cold:OrderedSafetyEntry[]=[];
  const boundedReader:FrameReader=(name,maximum)=>{const remaining=MAX_REPLAY_BYTES-actualRead;if(remaining<=0)fail('INCREMENTAL_REPLAY_LIMIT');
    const data=reader(name,Math.min(maximum,remaining));actualRead+=data.length;if(data.length>maximum||actualRead>MAX_REPLAY_BYTES)fail('INCREMENTAL_REPLAY_LIMIT');return data;};
  try{
    if(head.safetyCold){
      if(coldDecodedBytes>MAX_REPLAY_BYTES||coldEncodedBytes>MAX_REPLAY_BYTES-actualRead)fail('INCREMENTAL_REPLAY_LIMIT');
      const bytes=boundedReader(head.safetyCold.file,coldEncodedBytes);segment=SafetySegment.open(bytes,identityOf(head),keys.storageDEK);cold=segment.rows();
      files.set(head.safetyCold.file,bytes);readBytes=coldEncodedBytes;decodedBytes=coldDecodedBytes;
    }
    for(;;){if(frames.length>=chainLimit(head.storageProfile))fail('INCREMENTAL_CHAIN_LIMIT');const frame=load(cursor,boundedReader,keys,maxCalls,MAX_REPLAY_BYTES-decodedBytes,cold,frames.length===0?overlay:undefined);
      frames.push(frame);readBytes+=frame.blobBytes.length+frame.recordBytes.length;decodedBytes+=frame.decodedBytes;
      if(readBytes>MAX_REPLAY_BYTES||decodedBytes>MAX_REPLAY_BYTES)fail('INCREMENTAL_REPLAY_LIMIT');
      files.set(frame.stage.blob,frame.blobBytes);files.set(`record-${cursor.sequence}.bin`,frame.recordBytes);
      if(frame.state.blocks.mode==='base')break;cursor=frame.record.previousHead!;
    }
    let depth=0;
    for(const frame of [...frames].reverse()){
      if(frame.state.depth!==++depth)fail('INCREMENTAL_CHAIN');const next=decodeBlocks(frame.state.blocks,frame.payload,image??null);image?.fill(0);image=next;
    }
    const current=frames[0]!,ledger=new SafetyLedger(current.state.safety,identityOf(head),maxCalls,current.hot,segment);
    const result={stage:current.stage,state:current.state,record:current.record,image:image!,baseline:{image:image!,depth,readBytes,decodedBytes,coldEncodedBytes,coldDecodedBytes},files,ledger};
    image=undefined;segment=undefined;return result;
  }finally{image?.fill(0);segment?.close();for(const frame of frames)frame.payload.fill(0);}
}
export const directoryReader=(directory:string):FrameReader=>(name,maximum)=>readBounded(join(directory,name),maximum);
