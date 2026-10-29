// Emergency revocation imports only this fixed, checked transitive closure.
// It never imports production, QA, tokenization, Root evidence or provider code.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateAuthority } from '../../src/wf1-contract.ts';
import { canonical,digest,integer,stop } from '../../src/wf1-json.ts';

export const REVOKER_FILES=["runtime/teaching-cycle/Invoke-TeachingCycle.ps1","runtime/teaching-cycle/teaching-native-worker.mjs","runtime/teaching-cycle/teaching-revoker.mjs","src/wf1-contract.ts","src/wf1-json.ts","src/wf1-types.ts","src/wf1-verifier.ts","src/wf2-fixed-slots.ts","src/wf2-named-data.ts","src/wf2-response-diagnostic.ts","src/wf2-strict-data.ts","src/wf2-teacher-policy.ts","src/wf2-together-pilot.ts","src/wf2-unit-pilot.ts"];
function plain(file,cap){const a=fs.lstatSync(file,{bigint:true});if(!path.isAbsolute(file)||!a.isFile()||a.isSymbolicLink()||a.nlink!==1n||a.size>BigInt(cap)||fs.realpathSync.native(file).toLowerCase()!==path.resolve(file).toLowerCase())stop('TCH_AUTHORITY_PATH');return a;}
function authority(file,spec,jobId){plain(file,16384);const a=validateAuthority(JSON.parse(fs.readFileSync(file,'utf8')));if(a.campaignId!==jobId||a.runtimeId!==spec.runtimeId||a.expiresAt!==spec.expiresAt||a.revision!==spec.authorityRevision+(a.status==='REVOKED'?1:0))stop('TCH_AUTHORITY');return a;}
/** Fixed head CAS under the existing authority SQLite lock. No key is needed.
 * Matching REVOKED bytes are never rewritten. Child freezes use the same helper. */
export function finalizeTeachingAuthority(file,spec,jobId,expectedHead){
  if(expectedHead!==null)digest(expectedHead);authority(file,spec,jobId);const lock=file+'.owner.sqlite';
  try{const fd=fs.openSync(lock,'wx',0o600);fs.closeSync(fd);}catch(e){if(e.code!=='EEXIST')throw e;}plain(lock,4096);const db=new DatabaseSync(lock,{timeout:1000});
  try{db.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');const current=authority(file,spec,jobId);if(current.head!==expectedHead)stop('TCH_AUTHORITY_HEAD');if(current.status==='REVOKED')return;
    if(current.status!=='ACTIVE')stop('TCH_AUTHORITY_STATUS');const next={...current,status:'REVOKED',revision:current.revision+1},temporary=file+'.final-'+randomUUID(),fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,canonical(next)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);if(canonical(authority(file,spec,jobId))!==canonical(next))stop('TCH_REVOKE_UNKNOWN');
  }finally{db.close();}
}
export function revokeTeachingCycle(c){
  const spec=c.cycle.spec,file=c.cycle.authorityPath;integer(spec.authorityRevision,1);integer(spec.expiresAt,1);
  const relative=path.relative(c.controlRoot,file);if(!path.isAbsolute(c.controlRoot)||!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))stop('TCH_AUTHORITY_PATH');
  const a=authority(file,spec,spec.cycleId);finalizeTeachingAuthority(file,spec,spec.cycleId,a.head);
  return {version:'TeachingCycleRevoked/0.1',cycleId:spec.cycleId,head:a.head,providerCalls:0};
}
