import type {VaultIdentity} from './anchored-codec.ts';
import type {Safety} from './durable-codec.ts';
import type {SafetyEntry,OrderedSafetyEntry} from './safety-format.ts';
import {terminalEligible} from './safety-format.ts';
import {plainJsonBytes} from './authority-cold-format.ts';
import {fail} from './validation.ts';
import {SAFETY_V2_PROFILE,validateV2Hot,validateV2Entry,safetyFingerprint,safetyWorkspace,safetyPhase,boundedSafetyJSON} from './safety-v2-format.ts';
import type {SafetyHotV2,SafetyGlobals,Release} from './safety-v2-format.ts';
import {SafetySegmentV2,assertSafetyV2Closure} from './safety-v2-segment.ts';
import {sha} from './durable-codec.ts';
const closeOwnedCold=SafetySegmentV2.prototype.close;

export class SafetyView{
 readonly identity:VaultIdentity;readonly #maxCalls:number;readonly #hot:SafetyHotV2;readonly #cold:SafetySegmentV2|undefined;readonly #ownsCold:boolean;#closed=false;#hotRelease:Release;
 constructor(hot:SafetyHotV2,identity:VaultIdentity,maxCalls:number,cold?:SafetySegmentV2,ownsCold=true){
  this.#ownsCold=ownsCold;
  this.identity=identity;this.#maxCalls=maxCalls;this.#hot=hot;this.#cold=cold;if(identity.storageProfile!==SAFETY_V2_PROFILE||(identity.safetyCold===null)!==!cold)fail('SAFETY_V2_PROFILE');
  this.#hotRelease=safetyWorkspace().reserve(plainJsonBytes(hot)*4+65536,'retained hot value');try{this.validate(true);}catch(e){this.#hotRelease();throw e;}
 }
 static empty(identity:VaultIdentity,maxCalls:number):SafetyView{return new SafetyView({version:2,globals:{version:1,identity:identity.identity,maxCalls,reserved:0,lastSourceRef:null,lastAcknowledgedDeliveryId:null,lastWall:0},nextOrdinal:0,ingress:[]},identity,maxCalls);}
 get globals():SafetyGlobals{return this.#hot.globals;}
 get count():number{return this.#hot.nextOrdinal;}
 get hotCount():number{return this.#hot.ingress.length;}
 get coldCount():number{return this.#cold?.descriptor.entryCount??0;}
 residentBytes():number{return plainJsonBytes(this.#hot)*4+(this.#cold?.descriptor.plainBytes??0)+131072;}
 stats():{count:number;reserved:number;unknown:number}{return{count:this.count,reserved:(this.#cold?.descriptor.reservedCount??0)+this.#hot.ingress.reduce((n,r)=>n+Number(r.entry.reserved),0),unknown:(this.#cold?.descriptor.unknownCount??0)+this.#hot.ingress.reduce((n,r)=>n+Number(r.entry.state==='unknown'),0)};}
 validate(full=false):void{
  if(this.#closed)fail('SAFETY_V2_CLOSED');validateV2Hot(this.#hot,this.identity.identity,this.#maxCalls);if(this.hotCount+this.coldCount!==this.count||this.stats().reserved!==this.globals.reserved)fail('SAFETY_V2_COUNTS');
  for(const r of this.#hot.ingress)if(this.#cold?.lookupRequest(r.entry.key)||(r.entry.deliveryId!==null&&this.#cold?.lookupDelivery(r.entry.deliveryId))||this.#cold?.hasOrdinal(r.ordinal))fail('SAFETY_V2_DUPLICATE');
  // Cold validation proves distinct nonnegative ordinals and exact row count.
  // N distinct union ordinals in [0,N) prove continuity without rebuilding N rows.
  if(this.#cold&&this.#cold.maxOrdinal>=this.count)fail('SAFETY_V2_ORDINAL');void full;
 }
 *iterateEntries():Generator<OrderedSafetyEntry>{const cold=this.#cold?.rows(),hot=this.#hot.ingress;let i=0,next=cold?.next();try{while(i<hot.length||(next&&!next.done)){if(next&&!next.done&&(i===hot.length||next.value.ordinal<hot[i]!.ordinal)){yield next.value;next=cold!.next();}else{if(next&&!next.done&&next.value.ordinal===hot[i]!.ordinal)fail('SAFETY_V2_ORDINAL');yield hot[i++]!;}}}finally{cold?.return(undefined);}}
 coldRows():Iterable<OrderedSafetyEntry>{return this.#cold?.rows()??[];}
 lookupRequest(key:string):SafetyEntry|undefined{return this.#hot.ingress.find(r=>r.entry.key===key)?.entry??this.#cold?.lookupRequest(key)?.entry;}
 lookupDelivery(id:string):SafetyEntry|undefined{return this.#hot.ingress.find(r=>r.entry.deliveryId===id)?.entry??this.#cold?.lookupDelivery(id)?.entry;}
 append(entry:SafetyEntry):void{if(this.hotCount>=256||this.count>=16384)fail('SAFETY_V2_CAPACITY');validateV2Entry(entry);this.#hot.ingress.push({ordinal:this.#hot.nextOrdinal++,entry});}
 boot():void{for(const r of this.#hot.ingress)if(['pending','ready','taken'].includes(r.entry.state))r.entry.state='unknown';this.globals.lastAcknowledgedDeliveryId=null;}
 hotSnapshot():SafetyHotV2{this.validate();const release=safetyWorkspace().reserve(plainJsonBytes(this.#hot)*4+1024,'retained hot snapshot clone');try{return structuredClone(this.#hot);}catch(e){release();throw e;}}
 logicalFingerprint():string{this.validate();const h=safetyFingerprint();h.globals(this.globals);for(const r of this.iterateEntries())h.row(r);return h.finish();}
 storageFingerprint():string{this.validate();return sha(boundedSafetyJSON(this.#hot,4194304)+'\0'+(this.#cold?.descriptor.entryDigest??''));}
 verifiedCold():SafetySegmentV2|undefined{if(this.#closed)fail('SAFETY_V2_CLOSED');return this.#cold;}
 archivePartition():{hot:SafetyHotV2;cold:Iterable<OrderedSafetyEntry>}{
  const snapshot=this.hotSnapshot(),selected=snapshot.ingress.filter(r=>terminalEligible(r.entry));if(!selected.length)fail('SAFETY_ARCHIVE_NO_TERMINALS');snapshot.ingress=snapshot.ingress.filter(r=>!terminalEligible(r.entry));const source=this;
  function* rows(){const old=source.#cold?.rows();let next=old?.next(),i=0;try{while(i<selected.length||(next&&!next.done)){if(next&&!next.done&&(i===selected.length||next.value.ordinal<selected[i]!.ordinal)){yield next.value;next=old!.next();}else yield selected[i++]!;}}finally{old?.return(undefined);}}
  return{hot:snapshot,cold:{[Symbol.iterator]:rows}};
 }
 assertColdClosure():void{assertSafetyV2Closure(this.identity);}
 close(keepCold=false):void{if(!this.#closed){this.#closed=true;try{if(!keepCold&&this.#ownsCold&&this.#cold)Reflect.apply(closeOwnedCold,this.#cold,[]);}finally{this.#hotRelease();}}}
}
export function legacyHotV2(safety:Safety,hot:readonly OrderedSafetyEntry[]):SafetyHotV2{
 // No slicing or normalization of legacy values. New per-row/global limits may refuse.
 const {ingress,...globals}=safety;for(const e of ingress)validateV2Entry(e);boundedSafetyJSON(globals,65536);if(hot.length>256)fail('SAFETY_V2_CAPACITY');
 const release=safetyWorkspace().reserve(plainJsonBytes(hot)*4+plainJsonBytes(globals)*4+1024,'retained legacy hot copy');try{return{version:2,globals:structuredClone(globals),nextOrdinal:ingress.length,ingress:structuredClone(hot) as OrderedSafetyEntry[]};}catch(e){release();throw e;}
}
