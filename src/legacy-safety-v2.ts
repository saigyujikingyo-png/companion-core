import {createDecipheriv} from 'node:crypto';
import {join} from 'node:path';
import {lstatSync} from 'node:fs';
import {INCREMENTAL_FORMAT,identityOf,readBounded} from './anchored-codec.ts';
import type {VaultHead,KeySet} from './anchored-codec.ts';
import {reconstruct} from './incremental-storage.ts';
import type {Reconstructed} from './incremental-storage.ts';
import {COLD_SAFETY_PROFILE} from './safety-format.ts';
import {safetyWorkspace,safetyPhase,v2Integer} from './safety-v2-format.ts';
import type {Release} from './safety-v2-format.ts';
import {fail} from './validation.ts';
import {readSafetyV2File} from './safety-v2-file.ts';

/** Migration-only accounting around the unchanged P4 reader. The authenticated
 * header supplies each hot size before that reader expands it. Its retained
 * complete-Safety arrays are charged here; v2 itself never constructs them. */
export function readLegacyForV2(head:VaultHead,keys:KeySet,maxCalls:number):Reconstructed&{releaseV2Resources:Release}{
 if(head.storageProfile!==COLD_SAFETY_PROFILE)fail('SAFETY_V2_UPGRADE');const tickets:Release[]=[],release=()=>{for(const t of tickets)t();};
 try{
  const decodeScratch=safetyWorkspace().reserve(3*16777216+1048576,'legacy Store decode old raw and next image');tickets.push(decodeScratch);
  const cold=head.safetyCold?.plainBytes??0;tickets.push(safetyWorkspace().reserve(cold*8+1048576,'legacy cold DB decrypt rows and canonical copies'));
  const result=reconstruct(head,(name,max)=>{
   const path=join(head.directory,name),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)fail('ANCHOR_FILE');
   tickets.push(safetyWorkspace().reserve(stat.size,'legacy retained required file'));const bytes=readSafetyV2File(path,stat.size);
   if(name.startsWith('blob-')){
    const n=safetyPhase(bytes.length*3+4194304*4+65536,'legacy authenticated header preflight',()=>{
     let plain:Buffer|undefined;try{const c=createDecipheriv('aes-256-gcm',keys.storageDEK,bytes.subarray(0,12));c.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,'frame',identityOf(head)])));c.setAuthTag(bytes.subarray(12,28));plain=Buffer.concat([c.update(bytes.subarray(28)),c.final()]);const size=plain.readUInt32BE();if(size>4194304||size+4>plain.length)fail('INCREMENTAL_CORRUPT');const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain.subarray(4,size+4)));v2Integer(header.safety?.decodedBytes,1,4194304);return{hot:header.safety.decodedBytes as number,payload:plain.length-4-size};}finally{plain?.fill(0);}
    });
    tickets.push(safetyWorkspace().reserve(n.hot*12+cold*6+n.payload*2+262144,'legacy retained frame complete Safety and decoder copies'));
   }
   return bytes;
  },keys,maxCalls);
  // The decoder's raw/old/next images no longer coexist. Transfer only its
  // returned image to the migration owner before any further allocation.
  decodeScratch();tickets.push(safetyWorkspace().reserve(result.image.length,'retained legacy Store image'));
  return{...result,releaseV2Resources:release};
 }catch(error){release();throw error;}
}
