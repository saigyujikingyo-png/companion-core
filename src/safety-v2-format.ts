import {createHash} from 'node:crypto';
import {plainJsonBytes} from './authority-cold-format.ts';
import {canonicalSafetyJSON} from './safety-format.ts';
import type {SafetyEntry,OrderedSafetyEntry} from './safety-format.ts';
import type {Safety} from './durable-codec.ts';
import {record,validateIdentityBudget} from './durable-codec.ts';
import {fail} from './validation.ts';

export const SAFETY_V2_PROFILE='blocks-br4-safety-ledger-v2' as const;
export const SAFETY_V2_LIMITS=Object.freeze({hot:256,total:16384,entry:8192,globals:65536,hotBytes:4194304,cold:8388608,cipher:8388636,workspace:134217728,fixed:16777216});
export type SafetyGlobals=Omit<Safety,'ingress'>;
export type SafetyHotV2={version:2;globals:SafetyGlobals;nextOrdinal:number;ingress:OrderedSafetyEntry[]};
export type SafetyColdV2={version:2;format:'aemc-safety-sqlite-v2';file:string;cipherDigest:string;cipherBytes:number;plainDigest:string;plainBytes:number;entryDigest:string;entryCount:number;reservedCount:number;unknownCount:number};
export type Release=()=>void;

/** Per synchronous operation, including the existing 12 MiB authority allowance.
 * This is accounted live representation, not an RSS or GC bound. */
export class SafetyWorkspace{
 readonly limit=SAFETY_V2_LIMITS.workspace;#used=0;#peak=0;#tickets=new Set<Release>();
 get used():number{return this.#used;}get peak():number{return this.#peak;}get available():number{return this.limit-this.#used;}
 reserve(bytes:number,label:string):Release{if(!Number.isSafeInteger(bytes)||bytes<0||this.#used+bytes>this.limit)fail('SAFETY_V2_WORKSPACE');this.#used+=bytes;this.#peak=Math.max(this.#peak,this.#used);let live=true;const release=()=>{if(live){live=false;this.#used-=bytes;this.#tickets.delete(release);}};this.#tickets.add(release);void label;return release;}
 finish():void{for(const release of this.#tickets)release();}
}
let active:SafetyWorkspace|undefined,lastPeak=0;
export function safetyWorkspace():SafetyWorkspace{if(!active)fail('SAFETY_V2_WORKSPACE_SCOPE');return active;}
export function safetyOperation<T>(body:()=>T,resident=0):T{
 if(active){const release=active.reserve(resident,'existing operation residents');try{return body();}finally{release();}}
 const pool=new SafetyWorkspace();active=pool;try{pool.reserve(SAFETY_V2_LIMITS.fixed,'authority 12 MiB and metadata 4 MiB');pool.reserve(resident,'existing operation residents');return body();}finally{lastPeak=pool.peak;pool.finish();active=undefined;}
}
export function safetyWorkspacePeak():number{return active?.peak??lastPeak;}
export function safetyPhase<T>(bytes:number,label:string,body:()=>T):T{const release=safetyWorkspace().reserve(bytes,label);try{return body();}finally{release();}}
export function boundedSafetyJSON(value:unknown,maximum:number):string{const n=plainJsonBytes(value);if(n>maximum)fail('SAFETY_V2_BOUND');return safetyPhase(n*6+1024,'canonical JSON input/output/parsed copies',()=>{const s=canonicalSafetyJSON(value);if(Buffer.byteLength(s)>maximum)fail('SAFETY_V2_BOUND');return s;});}
export function v2Integer(v:unknown,min:number,max:number):asserts v is number{if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>max)fail('SAFETY_V2_FORMAT');}
export function v2Closed(v:unknown,keys:string[]):asserts v is Record<string,any>{if(!record(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))fail('SAFETY_V2_FORMAT');}
export function validateV2Entry(e:unknown):asserts e is SafetyEntry{
 if(!record(e)||typeof e.key!=='string'||typeof e.fingerprint!=='string'||! /^[a-f0-9]{64}$/.test(e.key)||! /^[a-f0-9]{64}$/.test(e.fingerprint)||!['pending','ready','taken','acknowledged','failed','unknown'].includes(e.state)
  ||typeof e.reserved!=='boolean'||typeof e.feedbackConsumed!=='boolean'||(e.deliveryId!==null&&(typeof e.deliveryId!=='string'||e.deliveryId.length>128))||(['ready','taken','acknowledged'].includes(e.state)&&e.deliveryId===null))fail('SAFETY_V2_ENTRY');
 boundedSafetyJSON(e,SAFETY_V2_LIMITS.entry);
}
export function validateV2Globals(g:unknown,identity:string,maxCalls:number):asserts g is SafetyGlobals{
 validateIdentityBudget(identity,maxCalls);if(!record(g)||Object.hasOwn(g,'ingress')||g.version!==1||g.identity!==identity||g.maxCalls!==maxCalls)fail('SAFETY_V2_GLOBALS');v2Integer(g.reserved,0,maxCalls);v2Integer(g.lastWall,0,Number.MAX_SAFE_INTEGER);boundedSafetyJSON(g,SAFETY_V2_LIMITS.globals);
}
export function validateV2Hot(h:unknown,identity:string,maxCalls:number):asserts h is SafetyHotV2{
 v2Closed(h,['version','globals','nextOrdinal','ingress']);if(h.version!==2||!Array.isArray(h.ingress)||h.ingress.length>256)fail('SAFETY_V2_HOT');validateV2Globals(h.globals,identity,maxCalls);v2Integer(h.nextOrdinal,0,16384);let last=-1;const keys=new Set<string>(),deliveries=new Set<string>();
 for(const row of h.ingress){v2Closed(row,['ordinal','entry']);v2Integer(row.ordinal,0,16383);if(row.ordinal<=last||row.ordinal>=h.nextOrdinal)fail('SAFETY_V2_ORDINAL');last=row.ordinal;validateV2Entry(row.entry);if(keys.has(row.entry.key)||(row.entry.deliveryId!==null&&deliveries.has(row.entry.deliveryId)))fail('SAFETY_V2_DUPLICATE');keys.add(row.entry.key);if(row.entry.deliveryId!==null)deliveries.add(row.entry.deliveryId);}
 boundedSafetyJSON(h,4194304);
}
/** Descriptor validation does not decode or allocate the cold image. */
export function validateV2Cold(d:unknown):asserts d is SafetyColdV2{
 v2Closed(d,['version','format','file','cipherDigest','cipherBytes','plainDigest','plainBytes','entryDigest','entryCount','reservedCount','unknownCount']);
 if(d.version!==2||d.format!=='aemc-safety-sqlite-v2'||!['cipherDigest','plainDigest','entryDigest'].every(k=>typeof d[k]==='string'&&/^[a-f0-9]{64}$/.test(d[k]))||d.file!==`safety-${d.cipherDigest}.bin`)fail('SAFETY_V2_DESCRIPTOR');
 v2Integer(d.plainBytes,4096,8388608);if(d.plainBytes%4096||d.cipherBytes!==d.plainBytes+28)fail('SAFETY_V2_DESCRIPTOR');v2Integer(d.entryCount,1,16384);v2Integer(d.reservedCount,0,32);v2Integer(d.unknownCount,0,d.entryCount);if(d.reservedCount>d.entryCount)fail('SAFETY_V2_DESCRIPTOR');
}
export function safetyFingerprint(){const h=createHash('sha256');h.update('companion-safety-logical-v2\0');const cell=(kind:string,text:string)=>{h.update(kind);h.update(String(Buffer.byteLength(text)));h.update(':');h.update(text);};return{globals:(g:SafetyGlobals)=>cell('G',boundedSafetyJSON(g,65536)),row:(r:OrderedSafetyEntry)=>{cell('O',String(r.ordinal));cell('J',boundedSafetyJSON(r.entry,8192));},finish:()=>h.digest('hex')};}
