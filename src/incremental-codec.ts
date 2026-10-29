import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { MAX_IMAGE, record, sha } from './durable-codec.ts';
import { fail } from './validation.ts';
import type { StorageProfile } from './anchored-codec.ts';
import {COLD_SAFETY_PROFILE} from './safety-format.ts';

export const BLOCK_SIZE = 4096, MAX_CHAIN = 16, MAX_REPLAY_BYTES = 64 * 1024 * 1024;
export const chainLimit=(profile:StorageProfile|undefined):number=>profile===COLD_SAFETY_PROFILE?15:MAX_CHAIN;
export const MAX_PATCH = MAX_IMAGE + Math.ceil(MAX_IMAGE / BLOCK_SIZE) * 8;
export type BlockEncoding = { mode: 'base' | 'replace' | 'xor'; codec: 'raw' | 'br4'; rawLength: number;
  targetLength: number; targetHash: string; baseHash: string | null; blockSize: 4096 };
export type EncodedBlocks = { descriptor: BlockEncoding; payload: Buffer };
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function compressed(raw: Buffer): { codec: 'raw' | 'br4'; payload: Buffer } {
  const packed = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  return packed.length < raw.length ? { codec: 'br4', payload: packed } : { codec: 'raw', payload: Buffer.from(raw) };
}
function patches(image: Uint8Array, previous: Uint8Array, xor: boolean): Buffer {
  const chunks: Buffer[] = [];
  for (let start = 0, index = 0; start < image.length; start += BLOCK_SIZE, index++) {
    const now = Buffer.from(image.subarray(start, start + BLOCK_SIZE)), old = previous.subarray(start, start + now.length);
    if (old.length === now.length && now.equals(old)) continue;
    const header = Buffer.alloc(8); header.writeUInt32BE(index); header.writeUInt32BE(now.length,4);
    if (xor) for (let j=0;j<now.length;j++) now[j] = now[j]! ^ (old[j] ?? 0);
    chunks.push(header,now);
  }
  return Buffer.concat(chunks);
}
/** Exact serialized bytes, including partial final blocks. No SQL or FTS replay. */
export function encodeBlocks(image: Uint8Array, previous: Uint8Array | null, profile: StorageProfile, allowDelta = true): EncodedBlocks {
  if (!(image instanceof Uint8Array) || image.length > MAX_IMAGE || (previous && previous.length > MAX_IMAGE)
    || !['blocks-br4-v1','full-br4-v1','blocks-br4-safety-br4-v1',COLD_SAFETY_PROFILE].includes(profile)) fail('INCREMENTAL_LIMIT');
  const full = compressed(Buffer.from(image));
  let best: EncodedBlocks = { descriptor: { mode:'base', codec:full.codec, rawLength:image.length,
    targetLength:image.length,targetHash:sha(image),baseHash:null,blockSize:BLOCK_SIZE },payload:full.payload };
  if (previous && profile !== 'full-br4-v1' && allowDelta) for (const mode of ['replace','xor'] as const) {
    const raw = patches(image,previous,mode === 'xor'), packed=compressed(raw);
    const candidate: EncodedBlocks = {descriptor:{...best.descriptor,mode,codec:packed.codec,rawLength:raw.length,baseHash:sha(previous)},payload:packed.payload};
    // Include descriptor bytes: comparing only compressed payload biases tiny deltas.
    if (candidate.payload.length+Buffer.byteLength(JSON.stringify(candidate.descriptor)) < best.payload.length+Buffer.byteLength(JSON.stringify(best.descriptor))) best=candidate;
    raw.fill(0);
  }
  return best;
}
export function validateBlocks(d: BlockEncoding, payloadLength: number): void {
  if (!record(d) || Object.keys(d).sort().join(',') !== 'baseHash,blockSize,codec,mode,rawLength,targetHash,targetLength'
    || !['base','replace','xor'].includes(d.mode) || !['raw','br4'].includes(d.codec) || d.blockSize !== BLOCK_SIZE
    || !Number.isSafeInteger(d.targetLength) || d.targetLength < 0 || d.targetLength > MAX_IMAGE
    || !Number.isSafeInteger(d.rawLength) || d.rawLength < 0 || d.rawLength > MAX_PATCH || payloadLength > MAX_PATCH
    || !hash(d.targetHash) || (d.mode === 'base' ? d.baseHash !== null || d.rawLength !== d.targetLength : !hash(d.baseHash))
    || (d.codec === 'raw' ? payloadLength !== d.rawLength : d.rawLength === 0 || payloadLength >= d.rawLength)) fail('INCREMENTAL_DESCRIPTOR');
}
export function decodeBlocks(descriptor: BlockEncoding, payload: Uint8Array, previous: Uint8Array | null): Buffer {
  validateBlocks(descriptor,payload.length);
  if (descriptor.mode !== 'base' && (!previous || sha(previous) !== descriptor.baseHash)) fail('INCREMENTAL_BASE');
  let raw: Buffer;
  try {
    if(descriptor.codec==='raw')raw=Buffer.from(payload);
    else {
      const result=brotliDecompressSync(payload,{maxOutputLength:descriptor.rawLength,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
      raw=result.buffer;
      if(result.engine.bytesWritten!==payload.length){raw.fill(0);fail('INCREMENTAL_DECODE');}
    }
  }
  catch { fail('INCREMENTAL_DECODE'); }
  if (raw.length !== descriptor.rawLength) {raw.fill(0);fail('INCREMENTAL_DECODE');}
  let image: Buffer | undefined;
  try {
    if (descriptor.mode === 'base') image=Buffer.from(raw);
    else {
      image=Buffer.alloc(descriptor.targetLength);image.set(previous!.subarray(0,image.length));
      let offset=0,last=-1;
      const seen=new Set<number>();
      while(offset<raw.length){
        if(offset+8>raw.length)fail('INCREMENTAL_PATCH');
        const index=raw.readUInt32BE(offset),size=raw.readUInt32BE(offset+4);offset+=8;
        const start=index*BLOCK_SIZE,expected=Math.min(BLOCK_SIZE,image.length-start);
        if(index<=last||start>=image.length||size!==expected||size<=0||offset+size>raw.length)fail('INCREMENTAL_PATCH');
        if(descriptor.mode==='replace')image.set(raw.subarray(offset,offset+size),start);
        else for(let j=0;j<size;j++)image[start+j]=raw[offset+j]! ^ (previous![start+j]??0);
        last=index;seen.add(index);offset+=size;
      }
      // All newly allocated bytes must be explicitly represented, including a
      // formerly partial block that grows and new blocks containing only zeroes.
      if(image.length>previous!.length)for(let index=Math.floor(previous!.length/BLOCK_SIZE);index<Math.ceil(image.length/BLOCK_SIZE);index++)if(!seen.has(index))fail('INCREMENTAL_PATCH');
    }
    if(sha(image)!==descriptor.targetHash)fail('INCREMENTAL_HASH');
    const result=image;image=undefined;return result;
  }finally{raw.fill(0);image?.fill(0);}
}
