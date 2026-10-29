import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, opendirSync, readdirSync } from 'node:fs';
import {isProxy,isSharedArrayBuffer,isUint8Array} from 'node:util/types';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './store.ts';
import type { Clock } from './store.ts';
import { inspectMemoryImage, inspectMemoryImageCapacity, maintainFanoutImage, migrateMemoryImage, repackMemoryImage } from './memory-image.ts';
import type { MemorySchema } from './memory-image.ts';
import type { FanoutFault } from './fanout-types.ts';
import type { SourceRef, Scope } from './contracts.ts';
import { bindControl, bootControl, encodeControl, fenceControl, newControl } from './endogenous-durable.ts';
import type { DurableEndogenousSession, EndogenousControl, DurableTextAcceptance, DurableMessageSession, MessageBinding } from './endogenous-durable.ts';
import type { EndogenousDecisionPort, EndogenousLimits, EndogenousOwner, EndogenousProfile, EndogenousTextPort, EndogenousSettlement } from './endogenous-lifecycle.ts';
import { MAX_COMMITS, MAX_DISK, MAX_IMAGE, sha, validateIdentityBudget } from './durable-codec.ts';
import type { Safety, Terminal } from './durable-codec.ts';
import { CoreError, fail, text } from './validation.ts';
import { ANCHORED_FORMAT, INCREMENTAL_FORMAT, INCREMENTAL_MARKER, VAULT_MARKER, boundSqlite, canonicalDirectory, copyKeys, decodeStage, disjoint, id,
  encodeVaultMarker, identityOf, readBounded, same, sealV2, validateHead, validateIdentity, writeNew,canUpgradeStorage } from './anchored-codec.ts';
import type { FrozenStage, KeySet, StorageProfile, VaultHead, VaultIdentity, VaultRecord, VaultState } from './anchored-codec.ts';
import { directoryReader, freezeFrame, parseFrozenV3, reconstruct, MANIFEST_LIMIT,FRAME_LIMIT,RECORD_LIMIT } from './incremental-storage.ts';
import type { Baseline, FrozenV3, Reconstructed } from './incremental-storage.ts';
import { LocalSqliteAuthority } from './local-sqlite-authority.ts';
import type { AnchorReceipt, AuthorityTransaction, PendingCommit } from './local-sqlite-authority.ts';
import {captureLegacyM2,inspectLegacyM2,normalizeLegacyFreeze,rejectLegacyNamespace} from './legacy-m2-import.ts';
import type {InspectLegacyRequest,LegacyInspection} from './legacy-m2-import.ts';
import type {LegacyImportProof,LegacySourceFreeze} from './legacy-import-types.ts';
import {chainLimit,MAX_REPLAY_BYTES} from './incremental-codec.ts';
import {CAPACITY_DIRECTORY_ENTRY_LIMIT,freezeCapacity} from './capacity-types.ts';
import type {GenerationCapacity,VaultCapacity} from './capacity-types.ts';
import {COLD_SAFETY_PROFILE,canonicalSafetyJSON} from './safety-format.ts';
import type {HotSafetyEnvelope} from './safety-format.ts';
import {SafetyLedger,allHotSafety,validateHotSnapshot} from './safety-ledger.ts';
import {sealSafetySegment,assertColdClosure} from './safety-segment.ts';
import {SAFETY_V2_PROFILE,SAFETY_V2_LIMITS,safetyOperation,safetyPhase,safetyWorkspace,safetyWorkspacePeak,safetyFingerprint,boundedSafetyJSON} from './safety-v2-format.ts';
import {SafetyView,legacyHotV2} from './safety-v2-view.ts';
import {SafetySegmentV2,sealSafetyV2,assertSafetyV2Closure} from './safety-v2-segment.ts';
import {freezeSafetyV2Frame,reconstructSafetyV2} from './incremental-safety-v2.ts';
import type {SafetyReconstructed} from './incremental-safety-v2.ts';
import {readLegacyForV2} from './legacy-safety-v2.ts';
import {readSafetyV2File} from './safety-v2-file.ts';

export type AnchoredConfig = { directory: string; vaultId: string; identity: string; storageDomain: string;
  authority: LocalSqliteAuthority; keys: KeySet; schemaVersion?: MemorySchema; storageProfile?: StorageProfile };
export type AnchoredFault = 'safety-cold-written' | 'stage-written' | 'prepared' | 'checkpoint-published' | 'record-published' | 'finalized';
type Options = { clock?: Clock; fault?: (point: AnchoredFault) => void; fanoutFault?: (point: FanoutFault) => void };
export type RestoreRequest = { backupDirectory: string; targetDirectory: string; storageDomain: string;
  authority: LocalSqliteAuthority; keys: KeySet; maxCalls: number; operationId: string; fault?: (point: AnchoredFault) => void };
export type CompactRequest = Omit<RestoreRequest,'backupDirectory'> & {vaultId:string};
export type LegacyImportRequest=InspectLegacyRequest & {sourceFreeze:LegacySourceFreeze;authority:LocalSqliteAuthority;vaultId:string;targetDirectory:string;
  storageDomain:string;storageProfile:StorageProfile;newStorageDEK:Uint8Array;operationId:string;targetSchema?:2;fault?:(point:AnchoredFault)=>void};
export type BackupReceipt = { format: VaultIdentity['format']; coverage: 'current-state'; head: VaultHead; stageDigest: string };
export type InspectCapacityRequest={authority:LocalSqliteAuthority;vaultId:string;keys:KeySet;maxCalls:number;directoryEntryLimit?:number};
type Decoded = (ReturnType<typeof decodeStage> | Reconstructed | SafetyReconstructed)&{releaseV2Resources?:()=>void};
type Frozen = { bytes:Buffer;stage:FrozenStage|FrozenV3;blob?:Buffer;baseline?:Baseline;safetyFingerprint?:string;release?:()=>void };
// Before Store access: bounded DB, old baseline, serialization, temporary SQL,
// worst RAM rollback journal, and one bounded hot/global mutation.
const LIVE_V2_STORE=4*MAX_IMAGE+4096*4104+131072+1048576;
const v2=(identity:VaultIdentity)=>identity.storageProfile===SAFETY_V2_PROFILE;
const decodedSafety=(decoded:Decoded):Safety|SafetyView=>'view' in decoded?decoded.view:decoded.state.safety;
const decodedGlobals=(decoded:Decoded)=>'view' in decoded?decoded.view.globals:decoded.state.safety;
function vaultTransaction<T>(authority:LocalSqliteAuthority,body:(tx:AuthorityTransaction)=>T,resident=0):T{return safetyOperation(()=>authority.transaction(body),resident);}
function currentClosure(identity:VaultIdentity):void{if(v2(identity))assertSafetyV2Closure(identity);else assertColdClosure(identity);}
function reconstructCurrent(head:VaultHead,reader:Parameters<typeof reconstruct>[1],keys:KeySet,maxCalls:number,overlay?:FrozenV3):Reconstructed|SafetyReconstructed{return v2(head)?reconstructSafetyV2(head,reader,keys,maxCalls,overlay):reconstruct(head,reader,keys,maxCalls,overlay);}
const markerName=(identity:VaultIdentity)=>identity.format===INCREMENTAL_FORMAT?INCREMENTAL_MARKER:VAULT_MARKER;

// Inspection inputs are data, not callbacks: do not evaluate accessors or proxy traps.
function capacityFields(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
  if(value===null||typeof value!=='object'||isProxy(value))fail('INVALID_INPUT');
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)fail('INVALID_INPUT');
  const descriptors=Object.getOwnPropertyDescriptors(value),fields=Reflect.ownKeys(descriptors);
  if(fields.some(key=>typeof key!=='string'||(!required.includes(key)&&!optional.includes(key)))||required.some(key=>!Object.hasOwn(descriptors,key)))fail('INVALID_INPUT');
  const copy:Record<string,unknown>=Object.create(null);
  for(const key of fields as string[]){const descriptor=descriptors[key]!;if(!Object.hasOwn(descriptor,'value'))fail('INVALID_INPUT');copy[key]=descriptor.value;}
  return copy;
}
function capacityKey(value:unknown):Buffer{
  if(isProxy(value)||!isUint8Array(value))fail('ANCHOR_KEYSET');
  if(![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(value)))fail('ANCHOR_KEYSET');
  const prototype=Object.getPrototypeOf(Uint8Array.prototype);
  const get=(name:string)=>Reflect.apply(Object.getOwnPropertyDescriptor(prototype,name)!.get!,value,[]);
  const length=get('byteLength') as number,buffer=get('buffer') as ArrayBuffer,offset=get('byteOffset') as number;
  if(length!==32||isSharedArrayBuffer(buffer))fail('ANCHOR_KEYSET');
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||! /^(0|[1-9][0-9]*)$/.test(key)))fail('ANCHOR_KEYSET');
  return Buffer.from(new Uint8Array(buffer,offset,length));
}
function capacityRequest(request:InspectCapacityRequest):Required<InspectCapacityRequest>{
  const values=capacityFields(request,['authority','vaultId','keys','maxCalls'],['directoryEntryLimit']);
  const {authority,vaultId,maxCalls}=values,directoryEntryLimit=values.directoryEntryLimit===undefined?CAPACITY_DIRECTORY_ENTRY_LIMIT:values.directoryEntryLimit;
  if(isProxy(authority)||!(authority instanceof LocalSqliteAuthority))fail('INVALID_INPUT');
  text(vaultId,128);id(vaultId);
  if(typeof maxCalls!=='number'||!Number.isSafeInteger(maxCalls)||maxCalls<0||maxCalls>32
    ||typeof directoryEntryLimit!=='number'||!Number.isSafeInteger(directoryEntryLimit)||directoryEntryLimit<1||directoryEntryLimit>CAPACITY_DIRECTORY_ENTRY_LIMIT)fail('INVALID_INPUT');
  const key=capacityFields(values.keys,['version','keyEpoch','storageDEK','ingressKey']);
  if(key.version!==2||typeof key.keyEpoch!=='number'||!Number.isSafeInteger(key.keyEpoch)||key.keyEpoch<1)fail('ANCHOR_KEYSET');
  const storageDEK=capacityKey(key.storageDEK);let ingressKey:Buffer|undefined;
  try{
    ingressKey=capacityKey(key.ingressKey);if(storageDEK.equals(ingressKey))fail('ANCHOR_KEYSET');
    return{authority,vaultId,keys:{version:2,keyEpoch:key.keyEpoch,storageDEK,ingressKey},maxCalls,directoryEntryLimit};
  }catch(error){storageDEK.fill(0);ingressKey?.fill(0);throw error;}
}
function capacityDirectory(directory:string,entryLimit:number):GenerationCapacity['directory']{
  const stream=opendirSync(directory,{bufferSize:1});let entriesObserved=0,observedBytes=0,complete=false;
  try{
    while(entriesObserved<entryLimit){
      const entry=stream.readSync();if(entry===null){complete=true;break;}
      const stat=lstatSync(join(directory,entry.name));if(!stat.isFile()||stat.isSymbolicLink())fail('ANCHOR_FILE');
      entriesObserved++;observedBytes+=stat.size;if(!Number.isSafeInteger(observedBytes))fail('ANCHOR_LIMIT');
    }
  }finally{stream.closeSync();}
  return{entryLimit,entriesObserved,complete,observedBytes,totalEntries:complete?entriesObserved:null,totalBytes:complete?observedBytes:null};
}
// Select known audit fields even if a stored JSON object contains extra properties.
function capacityHead(head:VaultHead):VaultHead{
  return{format:head.format,authorityId:head.authorityId,vaultId:head.vaultId,identity:head.identity,instanceId:head.instanceId,ownerEpoch:head.ownerEpoch,
    keyEpoch:head.keyEpoch,directory:head.directory,storageDomain:head.storageDomain,sequence:head.sequence,digest:head.digest,
    ...(head.schemaVersion===undefined?{}:{schemaVersion:head.schemaVersion}),...(head.storageProfile===undefined?{}:{storageProfile:head.storageProfile}),
    ...(head.safetyCold===undefined?{}:{safetyCold:structuredClone(head.safetyCold)}),
    ...(head.legacyImport===undefined?{}:{legacyImport:{lineageId:head.legacyImport.lineageId,migrationId:head.legacyImport.migrationId}})};
}

function storagePath(directory: string, domain: string, authority: LocalSqliteAuthority, mustExist: boolean): string {
  id(domain);
  if (!(authority instanceof LocalSqliteAuthority) || domain === authority.custodyDomain) fail('ANCHOR_CUSTODY_OVERLAP');
  const path = mustExist ? canonicalDirectory(directory) : join(canonicalDirectory(dirname(resolve(directory))), resolve(directory).slice(dirname(resolve(directory)).length + 1));
  rejectLegacyNamespace(path);disjoint(path, authority.directory); return path;
}
function createDirectory(path: string): void { if (existsSync(path)) fail('ANCHOR_TARGET_EXISTS'); mkdirSync(path); }
const marker=encodeVaultMarker;
/** Narrow required metadata is read before the profile can be trusted. The
 * shared fixed metadata allowance retains returned values; this ticket covers
 * the bounded read/UTF8/parse boundary even before constructor admission. */
function readNarrowMetadata(path:string,maximum:number):Buffer{
  return safetyOperation(()=>safetyPhase(maximum*8+1024,'required bounded metadata',()=>readSafetyV2File(path,maximum)));
}
function readMarker(directory: string): VaultIdentity {
  let value: VaultIdentity;
  try {
    const old=existsSync(join(directory,VAULT_MARKER)),next=existsSync(join(directory,INCREMENTAL_MARKER));
    if(old===next)fail('ANCHOR_INCOMPLETE');value=JSON.parse(readNarrowMetadata(join(directory,next?INCREMENTAL_MARKER:VAULT_MARKER),8192).toString('utf8'));
    if(markerName(value)!==(next?INCREMENTAL_MARKER:VAULT_MARKER))fail('ANCHOR_INCOMPLETE');
  }
  catch { fail('ANCHOR_INCOMPLETE'); }
  validateIdentity(value); if (value.directory !== directory) fail('ANCHOR_INSTANCE_PATH'); return value;
}
function diskBytes(directory: string): number {
  let total = 0;
  for (const file of readdirSync(directory)) {
    const stat = lstatSync(join(directory, file));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('ANCHOR_FILE'); total += stat.size;
  }
  if (total > MAX_DISK) fail('ANCHOR_LIMIT'); return total;
}
function stageBytes(identity: VaultIdentity, sequence: number, operationId: string, image: Uint8Array, safety: Safety|SafetyView,
  revocationHighWater: number, keys: KeySet, oldHead: VaultHead | null, parentHead: VaultHead | null,
  maintenance?: PendingCommit['maintenance'], baseline:Baseline|null=null,legacyImport?:LegacyImportProof,hot?:HotSafetyEnvelope): Frozen {
  if (image.length > MAX_IMAGE || sequence > MAX_COMMITS) fail('ANCHOR_LIMIT');
  if(v2(identity)){if(!(safety instanceof SafetyView))fail('SAFETY_V2_PROFILE');return{...freezeSafetyV2Frame(identity,sequence,operationId,image,safety,revocationHighWater,keys,oldHead,parentHead,baseline,maintenance,legacyImport),safetyFingerprint:safety.storageFingerprint()};}
  if(safety instanceof SafetyView)fail('SAFETY_V2_PROFILE');
  if(identity.format===INCREMENTAL_FORMAT)return freezeFrame(identity,sequence,operationId,image,safety,revocationHighWater,keys,oldHead,parentHead,baseline,maintenance,legacyImport,hot);
  const state: VaultState = { version: 2, identity, sequence, image: Buffer.from(image).toString('base64'), safety,
    revocationHighWater, ingressKeyDigest: sha(keys.ingressKey) };
  const checkpoint = sealV2(state, 'checkpoint', identity, keys.storageDEK);
  const row: VaultRecord = { version: 2, identity, sequence, operationId, previous: oldHead?.digest ?? null,
    parentHead, checkpointDigest: sha(checkpoint), revocationHighWater, ...(maintenance ? { maintenance } : {}) };
  const record = sealV2(row, 'record', identity, keys.storageDEK);
  const stage: FrozenStage = { format: ANCHORED_FORMAT, head: { ...identity, sequence, digest: sha(record) },
    checkpoint: checkpoint.toString('base64'), record: record.toString('base64') };
  return { bytes: Buffer.from(JSON.stringify(stage)), stage };
}
function writeStage(directory: string, operationId: string, bytes: Buffer, frozen:Frozen): string {
  if (diskBytes(directory) + bytes.length * 2 + (frozen.blob?.length??0) > MAX_DISK) fail('ANCHOR_LIMIT');
  if(frozen.stage.format===INCREMENTAL_FORMAT){if(!frozen.blob)fail('INCREMENTAL_CORRUPT');writeNew(join(directory,frozen.stage.blob),frozen.blob);}
  const path = join(directory, `stage-${operationId}.json`); writeNew(path, bytes); return path;
}
function publish(stage: FrozenStage|FrozenV3, fault?: (point: AnchoredFault) => void): void {
  if(v2(stage.head))return safetyPhase((stage.format===INCREMENTAL_FORMAT?stage.blobLength:0)+131072,'publication readback and record decoding',()=>publishScoped(stage,fault));
  return publishScoped(stage,fault);
}
function publishScoped(stage: FrozenStage|FrozenV3, fault?: (point: AnchoredFault) => void): void {
  currentClosure(stage.head);
  if(stage.format===INCREMENTAL_FORMAT){
    if(sha((v2(stage.head)?readSafetyV2File:readBounded)(join(stage.head.directory,stage.blob),stage.blobLength))!==stage.blobDigest)fail('ANCHOR_PUBLISH_CONFLICT');
    fault?.('checkpoint-published');const path=join(stage.head.directory,`record-${stage.head.sequence}.bin`),bytes=Buffer.from(stage.record,'base64');
    if(existsSync(path)){if(!(v2(stage.head)?readSafetyV2File(path,bytes.length):readBounded(path)).equals(bytes))fail('ANCHOR_PUBLISH_CONFLICT');}else writeNew(path,bytes);
    fault?.('record-published');return;
  }
  for (const [name, data, point] of [
    [`checkpoint-${stage.head.sequence}.bin`, stage.checkpoint, 'checkpoint-published'],
    [`record-${stage.head.sequence}.bin`, stage.record, 'record-published'],
  ] as const) {
    const path = join(stage.head.directory, name), bytes = Buffer.from(data, 'base64');
    if (existsSync(path)) { if (!readBounded(path).equals(bytes)) fail('ANCHOR_PUBLISH_CONFLICT'); }
    else writeNew(path, bytes);
    fault?.(point);
  }
}
function finalizeFrozen(tx:AuthorityTransaction,pending:PendingCommit):AnchorReceipt{
  currentClosure(pending.newHead);return tx.finalize(pending);
}
function disposeDecoded(decoded:Decoded|undefined):void{if(decoded){if('view' in decoded)decoded.close();else{decoded.image.fill(0);if('ledger' in decoded)decoded.ledger.close();}decoded.releaseV2Resources?.();}}
function previewV2(frozen:Frozen,keys:KeySet,maxCalls:number,cold?:Buffer,view?:SafetyView,inspect=false):void{
  if(!v2(frozen.stage.head))return;if(frozen.stage.format!==INCREMENTAL_FORMAT||!frozen.blob)fail('SAFETY_V2_PROFILE');const stage=frozen.stage;
  // Reusing the authenticated live index does not waive a fresh process's
  // cold decrypt peak. Its DB is already in resident bytes; charge the same
  // transient decrypt copies while rereading the complete required ciphertext.
  if(view?.verifiedCold()&&stage.head.safetyCold)safetyPhase(stage.head.safetyCold.plainBytes*3+65536,'fresh cold recovery peak preview',()=>view.assertColdClosure());
  const decoded=reconstructSafetyV2(stage.head,(name,max)=>{
    const value=name===stage.blob?frozen.blob:name===stage.head.safetyCold?.file?cold:undefined;
    if(value){if(value.length>max)fail('INCREMENTAL_REPLAY_LIMIT');return value;}
    const path=join(stage.head.directory,name),size=lstatSync(path).size,limit=name===stage.head.safetyCold?.file?stage.head.safetyCold.cipherBytes:name.startsWith('blob-')?FRAME_LIMIT:RECORD_LIMIT;
    if(size>limit)fail('ANCHOR_FILE');if(size>max)fail('SAFETY_V2_WORKSPACE');return readSafetyV2File(path,max);
  },keys,maxCalls,stage,view?.verifiedCold());
  try{if(decoded.view.storageFingerprint()!==frozen.safetyFingerprint)fail('SAFETY_LOGICAL_MISMATCH');if(inspect)validateImage(decoded.image,decoded.state.revocationHighWater,stage.head.schemaVersion??1,true);}finally{decoded.close();}
}
function bootMemoryControl(encoded:string,scope:(id:string)=>Scope,identity:VaultIdentity,blocked?:(reason:string)=>void):string{
  try{return bootControl(encoded,scope,identity);}catch(error){
    if(!(error instanceof CoreError)||!['E1_CONTROL_INVALID','E1_CONTROL_LIMIT','E1_CONTROL_IDENTITY','E1_CONTROL_SCOPE','E1_INVALID_LIMITS','SCOPE_NOT_FOUND'].includes(error.code))throw error;
    blocked?.(error.code==='SCOPE_NOT_FOUND'?'E1_CONTROL_SCOPE':error.code);return encoded;
  }
}
function freshV2Floor<T>(ledgerBytes:number,body:()=>T):T{
  // Both the real maintenance residents and the hypothetical fresh constructor
  // must fit. They are different lifetimes: take their maximum, not their sum.
  const pool=safetyWorkspace(),floor=SAFETY_V2_LIMITS.fixed+LIVE_V2_STORE+131072+ledgerBytes;
  const release=pool.reserve(Math.max(0,floor-pool.used),'fresh constructor resident floor');try{return body();}finally{release();}
}
function admitBootedV2Save(imageBytesUpperBound:number,view:SafetyView):void{
  // The caller supplies either the future output bound or the already-real
  // output length. Do not add future variance again to a realized boot.
  const i=imageBytesUpperBound;
  if(i>MAX_IMAGE)fail('SAFETY_V2_WORKSPACE');
  const h=Buffer.byteLength(boundedSafetyJSON(view.hotSnapshot(),SAFETY_V2_LIMITS.hotBytes)),c=view.identity.safetyCold?.plainBytes??0,m=1048576;
  // Content-independent raw/base bounds, including retained frozen/file/hot
  // copies. A compressed payload is no larger than raw; do not extrapolate
  // from the particular preview's wall, UUID, digest or Brotli output.
  const peak=Math.max(10*i+24*h+2*m,5*i+24*h+2*c+17*m,7*i+10*h+2*c+m,i+5*h+5*c+m);
  safetyPhase(peak,'fresh first-save encoder frame decode block decode and cold bounds',()=>{});
}
function previewFreshV2Generation(frozen:Frozen,image:Uint8Array,view:SafetyView,highWater:number,keys:KeySet,cold?:Buffer):void{
  freshV2Floor(0,()=>previewV2(frozen,keys,view.globals.maxCalls,cold,undefined,true));
  const bootView=new SafetyView(view.hotSnapshot(),view.identity,view.globals.maxCalls,view.verifiedCold(),false);let bootImage:Uint8Array|undefined,outputRelease=()=>{};
  try{
    // Same Safety and MemoryStore boot implementation as public open. The
    // greatest legal wall value conservatively covers timestamp byte widths;
    // no booted value is persisted into the proposed generation.
    bootView.boot();bootView.globals.lastWall=Number.MAX_SAFE_INTEGER;
    // A disposable boot gets a smaller optional cap so its real DB does not
    // duplicate another entire 16 MiB allowance beside an existing live Store.
    // Hitting it is a prepublication refusal, never an assumption of success.
    const pages=Math.min(4096,Math.ceil(image.length/4096)+256);
    bootImage=safetyPhase(3*pages*4096+pages*4104+131072,'private fresh Store DB journal SQL and serialization',()=>{
      const store=new MemoryStore(':memory:',{image,boundedMemoryImage:pages,schemaVersion:view.identity.schemaVersion??1,
        clock:{wall:()=>Number.MAX_SAFE_INTEGER,monotonic:()=>0},endogenousBoot:(encoded,scope)=>bootMemoryControl(encoded,scope,view.identity)});
      try{if(store.revocationHighWater()!==highWater)fail('ANCHOR_CORRUPT');const result=store.snapshot();outputRelease=safetyWorkspace().reserve(result.length,'retained private boot image');return result;}finally{store.close();}
    });
    freshV2Floor(bootView.residentBytes(),()=>{
      // Only this future preview needs variance: one bounded schema2 batch
      // index path plus the singleton next_due INTEGER instead of NULL.
      const variance=(view.identity.schemaVersion??1)===2?32*4096:0;
      admitBootedV2Save(bootImage!.length+variance,bootView);
      // A base is the guaranteed fallback of the ordinary write path. Its
      // encoder reserves the same candidate workspace as a delta-capable save.
      const firstSave=stageBytes(view.identity,frozen.stage.head.sequence+1,randomUUID(),bootImage!,bootView,highWater,keys,frozen.stage.head,null);
      try{previewV2(firstSave,keys,bootView.globals.maxCalls,cold);}finally{firstSave.release?.();}
    });
  }finally{bootImage?.fill(0);outputRelease();bootView.close();}
}
function freezeV2Generation(identity:VaultIdentity,operationId:string,image:Uint8Array,safety:Safety|SafetyView,highWater:number,keys:KeySet,parent:VaultHead|null,
  source?:Decoded,archive=false,maintenance?:PendingCommit['maintenance'],legacyImport?:LegacyImportProof):ReturnType<typeof freezeGeneration>{
  let partition:{hot:ReturnType<SafetyView['hotSnapshot']>;cold:Iterable<import('./safety-format.ts').OrderedSafetyEntry>},before:string;
  if(safety instanceof SafetyView){before=safety.logicalFingerprint();partition=archive?safety.archivePartition():{hot:safety.hotSnapshot(),cold:safety.coldRows()};}
  else{if(!source||!('ledger' in source)||source.stage.head.storageProfile!==COLD_SAFETY_PROFILE||archive)fail('SAFETY_V2_UPGRADE');const hot=source.ledger.hotEnvelope();partition={hot:legacyHotV2(safety,hot.ingress),cold:source.ledger.coldRows()};const h=safetyFingerprint(),{ingress,...globals}=safety;h.globals(globals);for(const [ordinal,entry] of ingress.entries())h.row({ordinal,entry});before=h.finish();}
  identity={...identity,safetyCold:null};const iterator=partition.cold[Symbol.iterator]();let cold:Buffer|undefined,segment:SafetySegmentV2|undefined,target:SafetyView|undefined;
  try{const first=iterator.next();if(!first.done){function* all(){try{yield first.value!;for(let next=iterator.next();!next.done;next=iterator.next())yield next.value;}finally{iterator.return?.();}}const sealed=sealSafetyV2(all(),identity,keys.storageDEK);identity.safetyCold=sealed.descriptor;cold=sealed.bytes;segment=SafetySegmentV2.open(cold,identity,keys.storageDEK);}
    target=new SafetyView(partition.hot,identity,partition.hot.globals.maxCalls,segment);segment=undefined;if(target.logicalFingerprint()!==before)fail('SAFETY_LOGICAL_MISMATCH');
    const encodedMarker=marker(identity),frozen=stageBytes(identity,1,operationId,image,target,highWater,keys,null,parent,maintenance,null,legacyImport);previewFreshV2Generation(frozen,image,target,highWater,keys,cold);target.close();target=undefined;
    if(encodedMarker.length+frozen.bytes.length*2+(frozen.blob?.length??0)+(cold?.length??0)>MAX_DISK)fail('ANCHOR_LIMIT');return{identity,frozen,marker:encodedMarker,...(cold?{cold}:{})};
  }finally{iterator.return?.();target?.close();segment?.close();}
}
/** Every generation builder binds the new context before sealing the cold root. */
function freezeGeneration(identity:VaultIdentity,operationId:string,image:Uint8Array,safety:Safety|SafetyView,highWater:number,keys:KeySet,parent:VaultHead|null,
  source?:Decoded,archive=false,maintenance?:PendingCommit['maintenance'],legacyImport?:LegacyImportProof):{identity:VaultIdentity;frozen:Frozen;marker:Buffer;cold?:Buffer}{
  if(v2(identity))return freezeV2Generation(identity,operationId,image,safety,highWater,keys,parent,source,archive,maintenance,legacyImport);
  if(safety instanceof SafetyView)fail('SAFETY_V2_PROFILE');
  let hot:HotSafetyEnvelope|undefined,cold:Buffer|undefined;
  if(identity.storageProfile===COLD_SAFETY_PROFILE){
    const ledger=source&&'ledger' in source?source.ledger:undefined;
    const partition=archive?(ledger??fail('SAFETY_COLD_PROFILE')).archivePartition():{hot:ledger?.hotEnvelope()??allHotSafety(safety),cold:ledger?.coldRows()??[]};
    hot=partition.hot;identity={...identity,safetyCold:null};
    if(partition.cold.length){const sealed=sealSafetySegment(partition.cold,identity,keys.storageDEK);identity.safetyCold=sealed.descriptor;cold=sealed.bytes;}
    validateHotSnapshot(safety,hot,identity);
    if(source&&canonicalSafetyJSON(decodedSafety(source))!==canonicalSafetyJSON(safety))fail('SAFETY_LOGICAL_MISMATCH');
  }
  const encodedMarker=marker(identity),frozen=stageBytes(identity,1,operationId,image,safety,highWater,keys,null,parent,maintenance,null,legacyImport,hot);
  if(encodedMarker.length+frozen.bytes.length*2+(frozen.blob?.length??0)+(cold?.length??0)>MAX_DISK)fail('ANCHOR_LIMIT');
  return{identity,frozen,marker:encodedMarker,...(cold?{cold}:{})};
}
function writeGeneration(generation:ReturnType<typeof freezeGeneration>,operationId:string,fault?:Options['fault']):string{
  const {identity,frozen}=generation;createDirectory(identity.directory);writeNew(join(identity.directory,markerName(identity)),generation.marker);
  if(generation.cold){writeNew(join(identity.directory,identity.safetyCold!.file),generation.cold);fault?.('safety-cold-written');}
  const stagePath=writeStage(identity.directory,operationId,frozen.bytes,frozen);currentClosure(identity);fault?.('stage-written');return stagePath;
}
function readCurrent(head: VaultHead, keys: KeySet, maxCalls: number,upgradeV2=false): Decoded {
  if (!same(readMarker(head.directory), identityOf(head))) fail('ANCHOR_IDENTITY');
  if(upgradeV2)return readLegacyForV2(head,keys,maxCalls);
  if(head.format===INCREMENTAL_FORMAT)return reconstructCurrent(head,v2(head)?(name,max)=>readSafetyV2File(join(head.directory,name),max):directoryReader(head.directory),keys,maxCalls);
  return decodeStage(Buffer.from(JSON.stringify({ format: ANCHORED_FORMAT, head,
    checkpoint: readBounded(join(head.directory, `checkpoint-${head.sequence}.bin`)).toString('base64'),
    record: readBounded(join(head.directory, `record-${head.sequence}.bin`)).toString('base64') })), keys, maxCalls);
}
function validateImage(image: Uint8Array, highWater: number, schema: MemorySchema = 1,accounted=false): void {
  const run=()=>{if(inspectMemoryImage(image,schema).revocationHighWater!==highWater)fail('ANCHOR_CORRUPT');};
  if(accounted)safetyPhase(image.length*4+1048576,'private image inspector DB journal and FTS',run);else run();
}
function transformImage<T extends Uint8Array|{image:Uint8Array}>(accounted:boolean,body:()=>T):T{
  if(!accounted)return body();return safetyPhase(4*MAX_IMAGE+4096*4104+131072,'private transform DB temporary SQL journal and serialization',()=>{
    const result=body(),image=result instanceof Uint8Array?result:result.image;if(image.length>MAX_IMAGE)fail('DURABLE_LIMIT');safetyWorkspace().reserve(image.length,'retained transformed image');return result;
  });
}
function readBackup(directory: string, keys: KeySet, maxCalls: number): Decoded & { bytes: Buffer } {
  const path = canonicalDirectory(directory);let receipt:BackupReceipt;
  try{receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readNarrowMetadata(join(path,'backup.json'),16384)));}catch{fail('ANCHOR_BACKUP');}
  if(!receipt||![ANCHORED_FORMAT,INCREMENTAL_FORMAT].includes(receipt.format)||receipt.coverage!=='current-state')fail('ANCHOR_BACKUP');
  const bytes=receipt.format===INCREMENTAL_FORMAT?readNarrowMetadata(join(path,'current-state.json'),MANIFEST_LIMIT):readBounded(join(path,'current-state.json'));
  let decoded:Decoded;
  if(receipt.format===INCREMENTAL_FORMAT){
    let candidate:any;try{candidate=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('ANCHOR_BACKUP');}
    if(candidate?.format!==INCREMENTAL_FORMAT)fail('ANCHOR_BACKUP');
    validateHead(candidate.head);const coldProfile=candidate.head.storageProfile===COLD_SAFETY_PROFILE||v2(candidate.head);
    if(bytes.length>MANIFEST_LIMIT||Object.keys(candidate).sort().join(',')!=='files,format,head'||!Array.isArray(candidate.files)
      ||candidate.files.length>(coldProfile?(candidate.head.safetyCold?31:30):32))fail('ANCHOR_BACKUP');
    const files=new Map<string,{size:number;digest:string}>();let total=0;
    for(const file of candidate.files){if(!file||Object.keys(file).sort().join(',')!=='digest,name,size'||typeof file.name!=='string'
      ||!(coldProfile?/^(blob-[a-f0-9]{64}|record-[1-9][0-9]*|safety-[a-f0-9]{64})\.bin$/:/^(blob-[a-f0-9]{64}|record-[1-9][0-9]*)\.bin$/).test(file.name)||files.has(file.name)||!Number.isSafeInteger(file.size)||file.size<1||! /^[a-f0-9]{64}$/.test(file.digest))fail('ANCHOR_BACKUP');
      total+=file.size;if(total>64*1024*1024)fail('ANCHOR_BACKUP');files.set(file.name,file);}
    decoded=reconstructCurrent(candidate.head,(name,max)=>{const file=files.get(name);if(!file||file.size>max)fail('ANCHOR_BACKUP');const data=(v2(candidate.head)?readSafetyV2File:readBounded)(join(path,name),file.size);
      if(data.length!==file.size||sha(data)!==file.digest)fail('ANCHOR_BACKUP');return data;},keys,maxCalls);
    if(files.size!==decoded.files.size){disposeDecoded(decoded);fail('ANCHOR_BACKUP');}
    if(coldProfile){try{const actual=readdirSync(path).sort(),expected=[...files.keys(),'backup.json','current-state.json'].sort();
      if(!same(actual,expected))fail('ANCHOR_BACKUP');}catch(error){disposeDecoded(decoded);throw error;}}
  }else decoded=decodeStage(bytes,keys,maxCalls);
  try {
    if (receipt.format !== decoded.stage.head.format || receipt.coverage !== 'current-state' || receipt.stageDigest !== sha(bytes) || !same(receipt.head, decoded.stage.head)) fail('ANCHOR_BACKUP');
    validateImage(decoded.image, decoded.state.revocationHighWater, decoded.stage.head.schemaVersion ?? 1,v2(decoded.stage.head));
    return { ...decoded, bytes };
  } catch (error) { disposeDecoded(decoded); throw error; }
}

/** A separate mandatory-anchor format. Never opens/upgrades an M2.v1 directory. */
export class AnchoredVault {
  /** Static metadata inspection, including ACTIVE sources whose live handle is poisoned. */
  static inspectCapacity(request:InspectCapacityRequest):VaultCapacity{
    const {authority,vaultId,keys,maxCalls,directoryEntryLimit}=capacityRequest(request);
    let decoded:Decoded|undefined;
    try{return vaultTransaction(authority,tx=>{
      const capacity=tx.capacity(),row=tx.row(vaultId);
      if(!row)return freezeCapacity({version:1,status:'UNREGISTERED',detailsRead:false,currentHead:null,pending:null,legacyAdmission:'not-read',
        authority:capacity,generation:null,image:null,safety:null,blockers:['VAULT_UNREGISTERED']});
      if(row.status==='PREPARED'){
        const pending=row.pending!;
        if(pending.version!==2||!['create','write','restore','rekey','schema-migration','fanout-maintenance','compaction','storage-upgrade','legacy-m2-import'].includes(pending.kind))fail('ANCHOR_CORRUPT');
        validateHead(pending.newHead);
        if(pending.newHead.vaultId!==vaultId||pending.newHead.authorityId!==authority.authorityId||pending.newHead.sequence>MAX_COMMITS||!same(pending.oldHead,row.head))fail('ANCHOR_CORRUPT');
        return freezeCapacity({version:1,status:'PREPARED',detailsRead:false,currentHead:null,pending:{kind:pending.kind,previousSequence:row.head?.sequence??null,proposedSequence:pending.newHead.sequence},
          legacyAdmission:'not-read',authority:capacity,generation:null,image:null,safety:null,blockers:['VAULT_PREPARED']});
      }
      const head=row.head!;tx.assertActive(head);validateIdentityBudget(head.identity,maxCalls);
      if(storagePath(head.directory,head.storageDomain,authority,true)!==head.directory)fail('ANCHOR_INSTANCE_PATH');
      const current=readCurrent(head,keys,maxCalls);decoded=current;
      const image=v2(head)?safetyPhase(current.image.length*4+1048576,'capacity private inspector',()=>inspectMemoryImageCapacity(current.image,head.schemaVersion??1)):inspectMemoryImageCapacity(current.image,head.schemaVersion??1);
      if(image.revocationHighWater!==current.state.revocationHighWater)fail('ANCHOR_CORRUPT');
      const directory=capacityDirectory(head.directory,directoryEntryLimit);
      const generation:GenerationCapacity={sequence:head.sequence,commitLimit:MAX_COMMITS,directory,
        requiredChain:'baseline' in current?{frames:current.baseline.depth,files:current.files.size,encodedBytes:current.baseline.readBytes,frameLimit:chainLimit(head.storageProfile),replayByteLimit:MAX_REPLAY_BYTES}
          :{frames:1,files:2,encodedBytes:Buffer.byteLength(current.stage.checkpoint,'base64')+Buffer.byteLength(current.stage.record,'base64'),frameLimit:null,replayByteLimit:null},
        diskLimitBytes:MAX_DISK,otherGenerationsAndBackups:'unmeasured'};
      const safety='view' in current?{ingressCount:current.view.count,ingressLimit:16384,unknownCount:current.view.stats().unknown,reserved:current.view.globals.reserved,maxCalls:current.view.globals.maxCalls,
        hotCount:current.view.hotCount,coldCount:current.view.coldCount,coldEncodedBytes:head.safetyCold?.cipherBytes??0,coldDecodedBytes:head.safetyCold?.plainBytes??0,coldDescriptor:structuredClone(head.safetyCold!),
        hotLimit:256,entryLimitBytes:8192,globalsLimitBytes:65536,workspaceLimitBytes:134217728,workspacePeakBytes:safetyWorkspacePeak()}:{ingressCount:current.state.safety.ingress.length,ingressLimit:8192,unknownCount:current.state.safety.ingress.filter(entry=>entry.state==='unknown').length,reserved:current.state.safety.reserved,maxCalls:current.state.safety.maxCalls,
        ...(head.storageProfile===COLD_SAFETY_PROFILE&&'ledger' in current?{hotCount:current.ledger.hotCount,coldCount:current.ledger.coldCount,
          coldEncodedBytes:head.safetyCold?.cipherBytes??0,coldDecodedBytes:head.safetyCold?.plainBytes??0,coldDescriptor:structuredClone(head.safetyCold!)}:{})};
      const legacyAdmission=head.legacyImport?tx.legacy(head.legacyImport.lineageId)!.admission:'not-applicable';
      const blockers:('LEGACY_ADMISSION_REQUIRED'|'DIRECTORY_OVER_DISK_LIMIT'|'COMMIT_LIMIT_REACHED')[]=[];
      if(legacyAdmission==='required')blockers.push('LEGACY_ADMISSION_REQUIRED');
      if(directory.observedBytes>MAX_DISK)blockers.push('DIRECTORY_OVER_DISK_LIMIT');
      if(head.sequence>=MAX_COMMITS)blockers.push('COMMIT_LIMIT_REACHED');
      return freezeCapacity({version:1,status:'ACTIVE',detailsRead:true,currentHead:capacityHead(head),pending:null,legacyAdmission,authority:capacity,generation,image,safety,blockers});
    });}finally{disposeDecoded(decoded);keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  #store!: MemoryStore;
  get store(): MemoryStore { return this.#store; }
  readonly restored: boolean;
  readonly #authority: LocalSqliteAuthority;
  readonly #identity: VaultIdentity;
  readonly #keys: KeySet;
  readonly #clock: Clock;
  readonly #fault: Options['fault'];
  #head: VaultHead | null = null;
  #baseline: Baseline | null = null;
  #ledger: SafetyLedger|SafetyView;
  #writer: DatabaseSync | undefined;
  #tx: AuthorityTransaction | undefined;
  #depth = 0;
  #storePermit = false;
  #closed = false;
  #poisoned = false;
  #endogenousOwner: EndogenousOwner | undefined;
  #writeEndogenous!: (expected: string | null, next: string) => void;
  // A rejected extension is not a corrupt Store. This boot decision never becomes permission.
  #endogenousBootBlocked: string | null = null;
  private constructor(config: AnchoredConfig, maxCalls: number, options: Options, creating: boolean) {
    id(config.vaultId); text(config.identity,128); validateIdentityBudget(config.identity, maxCalls);
    this.#authority = config.authority; this.#keys = copyKeys(config.keys); this.#fault = options.fault;
    this.#clock = options.clock ?? { wall: Date.now, monotonic: () => performance.now() };
    const directory = storagePath(config.directory, config.storageDomain, config.authority, !creating);
    this.#identity = creating ? { format: config.storageProfile?INCREMENTAL_FORMAT:ANCHORED_FORMAT, authorityId: config.authority.authorityId, vaultId: config.vaultId,
      identity: config.identity, instanceId: randomUUID(), ownerEpoch: 1, keyEpoch: config.keys.keyEpoch, directory, storageDomain: config.storageDomain,
      ...(config.schemaVersion === 2 ? { schemaVersion: 2 } : {}),...(config.storageProfile?{storageProfile:config.storageProfile}:{}),
      ...(config.storageProfile===COLD_SAFETY_PROFILE||config.storageProfile===SAFETY_V2_PROFILE?{safetyCold:null}:{}) } : readMarker(directory);
    validateIdentity(this.#identity);
    if (this.#identity.authorityId !== config.authority.authorityId || this.#identity.vaultId !== config.vaultId
      || this.#identity.identity !== config.identity || this.#identity.keyEpoch !== config.keys.keyEpoch || this.#identity.storageDomain !== config.storageDomain
      || (this.#identity.schemaVersion ?? 1) !== (config.schemaVersion ?? 1)||this.#identity.storageProfile!==config.storageProfile) fail('ANCHOR_IDENTITY');
    this.#ledger = v2(this.#identity)?safetyOperation(()=>SafetyView.empty({...this.#identity,safetyCold:null},maxCalls)):new SafetyLedger({ version: 1, identity: config.identity, maxCalls, reserved: 0, ingress: [], lastSourceRef: null, lastAcknowledgedDeliveryId: null, lastWall: 0 },
      {...this.#identity,...(this.#identity.storageProfile===COLD_SAFETY_PROFILE?{safetyCold:null}:{})},maxCalls);
    let store: MemoryStore | undefined;
    this.restored = !creating;
    try {
      if (creating) { createDirectory(directory); writeNew(join(directory, markerName(this.#identity)), marker(this.#identity)); }
      const writerPath = join(directory, 'writer.sqlite');
      boundSqlite(directory, 'writer.sqlite', 65536);
      this.#writer = new DatabaseSync(writerPath, { timeout: 0, allowExtension: false });
      try {
        if (this.#writer.prepare('PRAGMA user_version').get()!.user_version !== 0
          || this.#writer.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length !== 0) fail('ANCHOR_WRITER_LAYOUT');
        this.#writer.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
      } catch (error) { if (error instanceof CoreError) throw error; fail('ANCHOR_WRITER_BUSY'); }
      vaultTransaction(this.#authority,tx => {
        this.#depth = 1; this.#tx = tx;
        let image: Buffer | undefined,loaded:Decoded|undefined;
        // The empty ledger exists before recovery. Once the recovered owner
        // is adopted, its own hot/cold tickets replace this provisional one.
        let initialLedgerRelease=v2(this.#identity)?safetyWorkspace().reserve((this.#ledger as SafetyView).residentBytes(),'initial constructor ledger'):()=>{};
        try {
          const row = tx.row(config.vaultId);
          if (creating) { if (row) fail('ANCHOR_ALREADY_REGISTERED'); }
          else {
            if (!row) fail('ANCHOR_UNREGISTERED'); if (row.status !== 'ACTIVE') fail('ANCHOR_PENDING');
            this.#head = row.head!;
            if (!same(identityOf(this.#head), this.#identity)) fail('ANCHOR_FENCED');
            tx.assertActive(this.#head); // Includes mandatory imported-lineage registry validation before boot or staging.
            const decoded = readCurrent(this.#head, this.#keys, maxCalls);loaded=decoded;image = decoded.image;this.#ledger.close();initialLedgerRelease();initialLedgerRelease=()=>{};
            this.#ledger = 'view' in decoded?decoded.view:'ledger' in decoded?decoded.ledger:new SafetyLedger(decoded.state.safety,this.#identity,maxCalls);
            if('baseline' in decoded)this.#baseline={...decoded.baseline,image:Buffer.from(decoded.image)};
          }
          this.#ledger.boot();
          this.#wallNow();
          store = new MemoryStore(':memory:', { ...(image ? { image } : {}), clock: { wall: () => this.#wallNow(), monotonic: this.#clock.monotonic },
            ...(v2(this.#identity)?{boundedMemoryImage:true}:{}),
            schemaVersion: this.#identity.schemaVersion ?? 1, ...(options.fanoutFault ? { fanoutFault: options.fanoutFault } : {}),
            aroundAccess: body => this.#storeAccess(body), assertHealthy: () => this.#healthy(), onPoison: () => { this.#poisoned = true; },
            endogenousBoot: (encoded,scope)=>bootMemoryControl(encoded,scope,this.#identity,reason=>{this.#endogenousBootBlocked=reason;}),
            endogenousMutation: (encoded, scope) => this.#endogenousBootBlocked ? encoded : fenceControl(encoded, scope),
            onEndogenousInvalidated: () => this.#endogenousOwner?.invalidate(),
            bindEndogenousWriter: write => { this.#writeEndogenous = write; },
            persist: (bytes, highWater) => this.#commit(bytes, highWater), assertCloseAllowed: () => { if (this.#depth) fail('ANCHOR_ACCESS_BUSY'); } });
          this.#store = store;
          if (image) validateImage(image, this.#withStore(() => store!.revocationHighWater()), this.#identity.schemaVersion ?? 1,v2(this.#identity));
          if(loaded&&'view' in loaded){loaded.close(true);loaded=undefined;image=undefined;}
          this.#save(creating?'business':'boot');
        } finally { if(loaded&&'view' in loaded)loaded.close(true);image?.fill(0);initialLedgerRelease(); this.#depth = 0; this.#tx = undefined; }
      },v2(this.#identity)?LIVE_V2_STORE:0);
      this.#store = store!;
    } catch (error) {
      this.#depth = 0; try { store?.close(); } catch {} try { this.#writer?.close(); } catch {}
      this.#ledger.close();this.#baseline?.image.fill(0);this.#keys.storageDEK.fill(0); this.#keys.ingressKey.fill(0); throw error;
    }
  }
  static create(config: AnchoredConfig, maxCalls: number, options: Options = {}): AnchoredVault { return new AnchoredVault(config, maxCalls, options, true); }
  static open(config: AnchoredConfig, maxCalls: number, options: Options = {}): AnchoredVault { return new AnchoredVault(config, maxCalls, options, false); }
  #healthy(): void { if (this.#closed || this.#poisoned) fail('ANCHOR_UNAVAILABLE'); }
  #access<T>(body: () => T): T {
    this.#healthy(); if (this.#depth) fail('ANCHOR_ACCESS_BUSY');
    return vaultTransaction(this.#authority,tx => {
      tx.assertActive(this.#head!);this.#ledger.assertColdClosure(); this.#depth = 1; this.#tx = tx;
      try { return body(); } finally { this.#depth = 0; this.#tx = undefined; }
    },this.#ledger instanceof SafetyView?LIVE_V2_STORE+this.#ledger.residentBytes():0);
  }
  #storeAccess<T>(body: () => T): T {
    if (!this.#depth) return this.#access(body);
    if (!this.#storePermit) fail('ANCHOR_ACCESS_BUSY');
    this.#storePermit = false;
    try { return body(); } finally { this.#storePermit = true; }
  }
  #withStore<T>(body: () => T): T {
    this.#storePermit = true; try { return body(); } finally { this.#storePermit = false; }
  }
  #wallNow(): number {
    const now = this.#clock.wall();
    if (!Number.isSafeInteger(now) || now < this.#ledger.globals.lastWall) { this.#poisoned = true; fail('ANCHOR_CLOCK_ROLLBACK'); }
    this.#ledger.globals.lastWall = now; return now;
  }
  #commit(image: Uint8Array, highWater: number,mode:'business'|'boot'='business'): void {
    if (!this.#depth || !this.#tx) fail('ANCHOR_TRANSACTION');
    try {
      this.#ledger.assertColdClosure();this.#wallNow(); const operationId = randomUUID(), sequence = (this.#head?.sequence ?? 0) + 1;
      // A real open's mandatory first save admits this actual boot output; it
      // must not recursively predict another open. Only the constructor uses
      // this mode; all business persistence retains the one-open lookahead.
      if(mode==='boot'&&this.#ledger instanceof SafetyView)admitBootedV2Save(image.length,this.#ledger);
      let frozen = stageBytes(this.#identity, sequence, operationId, image, this.#ledger instanceof SafetyView?this.#ledger:this.#ledger.completeSafety(), highWater, this.#keys, this.#head, null,undefined,this.#baseline,undefined,
        this.#ledger instanceof SafetyLedger&&this.#identity.storageProfile===COLD_SAFETY_PROFILE?this.#ledger.hotEnvelope():undefined);
      try{previewV2(frozen,this.#keys,this.#ledger.globals.maxCalls,undefined,this.#ledger instanceof SafetyView?this.#ledger:undefined);}catch(error){
        if(!(error instanceof CoreError)||error.code!=='SAFETY_V2_WORKSPACE'||!this.#baseline||!(this.#ledger instanceof SafetyView))throw error;
        frozen.release?.();frozen=stageBytes(this.#identity,sequence,operationId,image,this.#ledger,highWater,this.#keys,this.#head,null,undefined,null);
        previewV2(frozen,this.#keys,this.#ledger.globals.maxCalls,undefined,this.#ledger);
      }
      if(mode==='business'&&this.#ledger instanceof SafetyView)previewFreshV2Generation(frozen,image,this.#ledger,highWater,this.#keys);
      const stagePath = writeStage(this.#identity.directory, operationId, frozen.bytes,frozen); this.#fault?.('stage-written');
      const pending: PendingCommit = { version: 2, kind: this.#head ? 'write' : 'create', operationId, requestDigest: sha(frozen.bytes),
        oldHead: this.#head, newHead: frozen.stage.head, stagePath, stageDigest: sha(frozen.bytes) };
      this.#tx.prepare(pending); this.#fault?.('prepared');
      publish(frozen.stage, this.#fault); finalizeFrozen(this.#tx,pending); this.#head = frozen.stage.head;
      if(frozen.baseline){this.#baseline?.image.fill(0);this.#baseline={...frozen.baseline,image:Buffer.from(image)};}this.#fault?.('finalized');
    } catch (error) { this.#poisoned = true; if (error instanceof CoreError) throw error; fail('ANCHOR_WRITE_FAILED'); }
  }
  #save(mode:'business'|'boot'='business'): void {
    let image:Uint8Array|undefined;
    try { image=this.#withStore(() => this.store.snapshot()); this.#commit(image, this.#withStore(() => this.store.revocationHighWater()),mode); }
    catch(error) { this.#poisoned=true; if(error instanceof CoreError)throw error; fail('ANCHOR_WRITE_FAILED'); }
    finally { image?.fill(0); }
  }
  #digest(value: unknown): string { return createHmac('sha256', this.#keys.ingressKey).update(JSON.stringify(value)).digest('hex'); }
  /** Explicit management authorization. Existing controls are never reset or replenished. */
  createEndogenousControl(scope: Scope, limits?: Partial<EndogenousLimits>): EndogenousControl {
    return this.#createEndogenous(scope, limits, 'rest-noop-v1');
  }
  createEndogenousTextControl(scope: Scope, limits?: Partial<EndogenousLimits>): EndogenousControl {
    return this.#createEndogenous(scope, limits, 'text-choice-v1');
  }
  createEndogenousMessageControl(scope: Scope, limits?: Partial<EndogenousLimits>): EndogenousControl {
    return this.#createEndogenous(scope, limits, 'message-choice-v1');
  }
  #createEndogenous(scope: Scope, limits: Partial<EndogenousLimits> | undefined, profile: EndogenousProfile): EndogenousControl {
    return this.#access(() => {
      this.#tx!.assertAdmitted(this.#head!);
      if (this.#endogenousBootBlocked) fail(this.#endogenousBootBlocked);
      if (this.#withStore(() => this.store.endogenousControl()) !== null) fail('E1_CONTROL_EXISTS');
      const current = this.#withStore(() => this.store.scope(scope.id));
      if (!same(scope, current)) fail('E1_CONTROL_SCOPE');
      const record = newControl(this.#identity, current, this.#wallNow(), limits, profile);
      this.#withStore(() => this.#writeEndogenous(null, encodeControl(record)));
      return structuredClone(record);
    });
  }
  /** One lane per live vault; opening never creates a missing record or starts a call. */
  openEndogenousControl(port: EndogenousDecisionPort): DurableEndogenousSession {
    return this.#openEndogenous(port, 'rest-noop-v1');
  }
  /** Without expectedScope this is a trusted control-only API, not a Host binding. */
  openEndogenousTextControl(port: EndogenousTextPort, acceptText: DurableTextAcceptance, settled?: EndogenousSettlement,
    expectedScope?: Scope): DurableEndogenousSession {
    if (typeof acceptText !== 'function') fail('E1_INVALID_PORT');
    return this.#openEndogenous(port, 'text-choice-v1', acceptText, settled, undefined, expectedScope);
  }
  /** Trusted origin/route binding; payloads cannot choose their sender or route. */
  openEndogenousMessageControl(binding: MessageBinding, port: EndogenousTextPort, acceptText: DurableTextAcceptance,
    settled?: EndogenousSettlement, onRevoke?: () => void, expectedScope?: Scope): DurableMessageSession {
    if (typeof acceptText !== 'function') fail('E1_INVALID_PORT');
    return this.#openEndogenous(port, 'message-choice-v1', acceptText, settled, { ...binding, ...(onRevoke ? { onRevoke } : {}) }, expectedScope);
  }
  #openEndogenous(port: EndogenousDecisionPort | EndogenousTextPort, profile: 'message-choice-v1',
    acceptText: DurableTextAcceptance, settled: EndogenousSettlement | undefined, message: MessageBinding & { onRevoke?: () => void }, expectedScope?: Scope): DurableMessageSession;
  #openEndogenous(port: EndogenousDecisionPort | EndogenousTextPort, profile: 'rest-noop-v1' | 'text-choice-v1',
    acceptText?: DurableTextAcceptance, settled?: EndogenousSettlement, message?: undefined, expectedScope?: Scope): DurableEndogenousSession;
  #openEndogenous(port: EndogenousDecisionPort | EndogenousTextPort, profile: EndogenousProfile,
    acceptText?: DurableTextAcceptance, settled?: EndogenousSettlement, message?: MessageBinding & { onRevoke?: () => void }, expectedScope?: Scope): DurableEndogenousSession | DurableMessageSession {
    return this.#access(() => {
      this.#tx!.assertAdmitted(this.#head!);
      if (this.#endogenousBootBlocked) fail(this.#endogenousBootBlocked);
      if (this.#endogenousOwner) fail('E1_SESSION_ACTIVE');
      const bound = bindControl({
        guard: body => this.#access(body),
        read: () => this.#withStore(() => this.store.endogenousControl()),
        write: (expected, next) => this.#withStore(() => this.#writeEndogenous(expected, next)),
        scope: id => this.#withStore(() => this.store.scope(id)), now: () => this.#wallNow(),
        assertCurrent: () => { this.#healthy(); this.#tx!.assertAdmitted(this.#head!); },
        poison: () => { this.#poisoned = true; },
      }, this.#identity, port, this.#clock.monotonic, profile, acceptText, settled,
      message ? { ...message, digest: value => this.#digest(value) } : undefined, expectedScope);
      this.#endogenousOwner = bound.owner;
      return bound.messageSession ?? bound.session;
    });
  }
  claim(requestId: string, fingerprint: string): void {
    this.#access(() => {
      this.#tx!.assertAdmitted(this.#head!);
      text(requestId, 256); text(fingerprint, 4096);
      const key = this.#digest(['ingress', requestId]), fp = this.#digest(['payload', fingerprint]), prior = this.#ledger.lookupRequest(key);
      if (prior) { if (prior.fingerprint !== fp) fail('INTERACTION_IDEMPOTENCY_CONFLICT'); fail('INTERACTION_TERMINATED'); }
      this.#ledger.append({ key, fingerprint: fp, state: 'pending', deliveryId: null, feedbackConsumed: false, reserved: false }); this.#save();
    });
  }
  reserve(requestId?: string): void {
    this.#access(() => {
      this.#tx!.assertAdmitted(this.#head!);
      if (this.#ledger.globals.reserved >= this.#ledger.globals.maxCalls) fail('REQUEST_BUDGET_EXHAUSTED');
      if (typeof requestId !== 'string') fail('DURABLE_REQUEST_REQUIRED');
      const entry = this.#ledger.lookupRequest(this.#digest(['ingress', requestId]));
      if (!entry||entry.state!=='pending'||entry.reserved) fail('DURABLE_REQUEST_REQUIRED'); entry.reserved = true; this.#ledger.globals.reserved++; this.#save();
    });
  }
  terminal(requestId: string, state: Terminal, deliveryId: string | null = null): void {
    this.#access(() => {
      const entry = this.#ledger.lookupRequest(this.#digest(['ingress', requestId])); if (!entry) fail('ANCHOR_CORRUPT');
      const next = state === 'failed' && entry.reserved ? 'unknown' : state;
      const allowed: Record<Terminal, Terminal[]> = { pending: ['ready','failed','unknown'], ready: ['taken','failed','unknown'], taken: ['acknowledged','unknown'], acknowledged: [], failed: [], unknown: [] };
      if (!(next in allowed)) fail('INVALID_INPUT');
      if ((entry.deliveryId !== null && deliveryId !== null && entry.deliveryId !== deliveryId)
        || (['ready','taken','acknowledged'].includes(next) && deliveryId === null)) fail('DURABLE_DELIVERY_CONFLICT');
      if (deliveryId !== null) { text(deliveryId, 128);const other=this.#ledger.lookupDelivery(deliveryId);if(other&&other.key!==entry.key) fail('DURABLE_DELIVERY_CONFLICT'); }
      if (entry.state === next) { if (entry.deliveryId !== deliveryId) fail('DURABLE_DELIVERY_CONFLICT'); return; }
      if (!allowed[entry.state].includes(next)) fail('INTERACTION_TERMINATED');
      entry.state = next; if (deliveryId) entry.deliveryId = deliveryId;
      if (state === 'acknowledged') this.#ledger.globals.lastAcknowledgedDeliveryId = deliveryId; this.#save();
    });
  }
  consumeFeedback(deliveryId: string): void {
    this.#access(() => {
      const entry = this.#ledger.lookupDelivery(deliveryId);
      if (!entry || entry.state !== 'acknowledged') fail('FEEDBACK_REQUIRES_DELIVERED_RECEIPT');
      if (entry.feedbackConsumed) fail('DELIVERY_FEEDBACK_ALREADY_CONSUMED'); entry.feedbackConsumed = true; this.#save();
    });
  }
  source(ref: SourceRef): void { this.#access(() => { if(this.#ledger instanceof SafetyView)boundedSafetyJSON({...this.#ledger.globals,lastSourceRef:ref},65536);this.#ledger.globals.lastSourceRef = structuredClone(ref); this.#save(); }); }
  get head(): VaultHead { return this.#access(() => structuredClone(this.#head!)); }
  get reserved(): number { return this.#access(() => this.#ledger.globals.reserved); }
  get status() {
    return this.#access(() => ({ format: this.#identity.format, head: structuredClone(this.#head!), restored: this.restored,
      consumedRequests: this.#ledger.globals.reserved, unknownRequests: this.#ledger instanceof SafetyView?this.#ledger.stats().unknown:this.#ledger.completeSafety().ingress.filter(e => e.state === 'unknown').length,
      ingressCount: this.#ledger.count, lastSourceRef: structuredClone(this.#ledger.globals.lastSourceRef),
      ...((this.#identity.storageProfile===COLD_SAFETY_PROFILE||v2(this.#identity))?{hotIngressCount:this.#ledger.hotCount,coldIngressCount:this.#ledger.coldCount}:{}),
      lastAcknowledgedDeliveryId: this.#ledger.globals.lastAcknowledgedDeliveryId, manualResumeRequired: true, coverage: 'current-state' as const }));
  }
  exportBackup(target: string, maxOutputBytes?: number): BackupReceipt {
    return this.#access(() => {
      const directory = storagePath(target, this.#identity.storageDomain, this.#authority, false);
      disjoint(directory, this.#identity.directory);
      const decoded = readCurrent(this.#head!, this.#keys, this.#ledger.globals.maxCalls);
      try {
        validateImage(decoded.image, decoded.state.revocationHighWater, this.#identity.schemaVersion ?? 1,v2(this.#identity));
        const files='files' in decoded?decoded.files:undefined;
        const bytes = Buffer.from(JSON.stringify(files?{format:INCREMENTAL_FORMAT,head:this.#head!,files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,data])=>({name,size:data.length,digest:sha(data)}))}:decoded.stage));
        const receipt: BackupReceipt = { format: this.#identity.format, coverage: 'current-state', head: this.#head!, stageDigest: sha(bytes) };
        const output: [string, Buffer][] = [...(files ?? []), ['current-state.json', bytes], ['backup.json', Buffer.from(JSON.stringify(receipt))]];
        if (maxOutputBytes !== undefined) {
          // Keep the existing target gate ahead of budget refusal; createDirectory
          // still rechecks at publication. This check reserves no filesystem space.
          if (existsSync(directory)) fail('ANCHOR_TARGET_EXISTS');
          if (typeof maxOutputBytes !== 'number' || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) fail('INVALID_INPUT');
          let outputBytes = 0;
          for (const [, data] of output) {
            outputBytes += data.length;
            if (!Number.isSafeInteger(outputBytes)) fail('ANCHOR_BACKUP_OUTPUT_LIMIT');
          }
          if (outputBytes > maxOutputBytes) fail('ANCHOR_BACKUP_OUTPUT_LIMIT');
        }
        createDirectory(directory);
        for (const [name, data] of output) writeNew(join(directory, name), data);
        return structuredClone(receipt);
      } finally { disposeDecoded(decoded); }
    });
  }
  close(): void {
    if (this.#depth) fail('ANCHOR_ACCESS_BUSY'); if (this.#closed) return;
    this.#endogenousOwner?.close(); this.#closed = true;
    try { this.store.close(); } finally { this.#writer?.close();this.#ledger.close(); this.#baseline?.image.fill(0);this.#keys.storageDEK.fill(0); this.#keys.ingressKey.fill(0); }
  }

  static verifyBackup(request: Pick<RestoreRequest, 'backupDirectory' | 'authority' | 'keys' | 'maxCalls'>): BackupReceipt {
    return safetyOperation(()=>AnchoredVault.#verifyBackupScoped(request));
  }
  static #verifyBackupScoped(request: Pick<RestoreRequest, 'backupDirectory' | 'authority' | 'keys' | 'maxCalls'>): BackupReceipt {
    const decoded = readBackup(request.backupDirectory, request.keys, request.maxCalls);
    try {
      disjoint(canonicalDirectory(request.backupDirectory), request.authority.directory);
      return vaultTransaction(request.authority,tx => { tx.assertActive(decoded.stage.head); return { format: decoded.stage.head.format,
        coverage: 'current-state', head: decoded.stage.head, stageDigest: sha(decoded.bytes) }; });
    } finally { disposeDecoded(decoded); }
  }
  static restoreBackup(request: RestoreRequest): AnchorReceipt { return AnchoredVault.#cutover(request); }
  static rekeyBackup(request: RestoreRequest & { newStorageDEK: Uint8Array }): AnchorReceipt { return AnchoredVault.#cutover(request, request.newStorageDEK); }
  static migrateBackup(request: RestoreRequest & { targetSchema: 2 }): AnchorReceipt {
    if (request.targetSchema !== 2) fail('UNSUPPORTED_MIGRATION'); return AnchoredVault.#cutover(request, undefined, 2);
  }
  static inspectLegacyM2(request:InspectLegacyRequest):LegacyInspection{return inspectLegacyM2(request);}
  /** One captured verified legacy snapshot -> one new anchored genesis. The
   * independent authority's lineage registry prevents second quota admissions. */
  static importLegacyM2(request:LegacyImportRequest):AnchorReceipt{
    if(request.storageProfile===SAFETY_V2_PROFILE)fail('ANCHOR_STORAGE_PROFILE');
    id(request.vaultId);id(request.operationId);if(request.targetSchema!==undefined&&request.targetSchema!==2)fail('UNSUPPORTED_MIGRATION');
    if(!(request.newStorageDEK instanceof Uint8Array)||request.newStorageDEK.length!==32||Buffer.from(request.newStorageDEK).equals(request.legacyKey))fail('LEGACY_KEY_SEPARATION');
    const captured=captureLegacyM2(request),keys=copyKeys({version:2,keyEpoch:1,storageDEK:request.newStorageDEK,ingressKey:request.legacyKey});let migrated:Uint8Array|undefined;
    try{
      if(!same(captured.inspection.sourceFreeze,normalizeLegacyFreeze(request.sourceFreeze,request.identity)))fail('LEGACY_SOURCE_CHANGED');
      if(request.operationId!==captured.inspection.migrationId)fail('LEGACY_OPERATION');
      const target=storagePath(request.targetDirectory,request.storageDomain,request.authority,false);disjoint(target,captured.directory);disjoint(captured.directory,request.authority.directory);
      const proof:LegacyImportProof={version:1,lineageId:captured.inspection.lineageId,migrationId:captured.inspection.migrationId,genesisAuthorityDigest:captured.inspection.genesisAuthorityDigest,
        sourceFreeze:captured.inspection.sourceFreeze,latestProven:false,legacyCopiesFenced:false,quotaScope:'this-authority-only',sourceRetirement:'not-established',admissionAtImport:'required'};
      const requestDigest=sha(JSON.stringify({kind:'legacy-m2-import',proof,target,vaultId:request.vaultId,storageDomain:request.storageDomain,storageProfile:request.storageProfile,
        targetSchema:request.targetSchema??1,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey),maxCalls:request.expectedMaxCalls}));
      return vaultTransaction(request.authority,tx=>{
        const registered=tx.legacy(proof.lineageId);
        if(registered){if(registered.requestDigest!==requestDigest||registered.vaultId!==request.vaultId)fail('LEGACY_LINEAGE_CONSUMED');
          if(registered.status==='PREPARED')fail('ANCHOR_PENDING');if(!registered.importReceipt)fail('LEGACY_REGISTRY');return registered.importReceipt;}
        if(tx.row(request.vaultId))fail('ANCHOR_ALREADY_REGISTERED');
        const identity:VaultIdentity={format:INCREMENTAL_FORMAT,authorityId:request.authority.authorityId,vaultId:request.vaultId,identity:request.identity,instanceId:randomUUID(),ownerEpoch:1,keyEpoch:1,
          directory:target,storageDomain:request.storageDomain,storageProfile:request.storageProfile,...(request.targetSchema?{schemaVersion:request.targetSchema}:{}),legacyImport:{lineageId:proof.lineageId,migrationId:proof.migrationId},
          ...(request.storageProfile===COLD_SAFETY_PROFILE?{safetyCold:null}:{})};
        if(request.targetSchema)migrated=migrateMemoryImage(captured.image,1,2,captured.safety.lastWall);
        for(const entry of captured.safety.ingress)if(['pending','ready','taken'].includes(entry.state))entry.state='unknown';captured.safety.lastAcknowledgedDeliveryId=null;
        const generation=freezeGeneration(identity,request.operationId,migrated??captured.image,captured.safety,captured.inspection.revocationHighWater,keys,null,undefined,false,undefined,proof),frozen=generation.frozen;
        const stagePath=writeGeneration(generation,request.operationId,request.fault);
        const pending:PendingCommit={version:2,kind:'legacy-m2-import',operationId:request.operationId,requestDigest,oldHead:null,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes),legacyImport:proof};
        tx.prepare(pending);request.fault?.('prepared');publish(frozen.stage,request.fault);const receipt=finalizeFrozen(tx,pending);request.fault?.('finalized');return receipt;
      });
    }finally{captured.image.fill(0);migrated?.fill(0);keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  /** New active generation; retains the source directory and does not boot it. */
  static compact(request:CompactRequest):AnchorReceipt{return AnchoredVault.#rewriteCurrent(request);}
  /** Explicit lossless RAM repack into a new generation; source retained. */
  static repackStore(request:CompactRequest):AnchorReceipt{return AnchoredVault.#rewriteCurrent(request,undefined,'lossless-repack-v1');}
  static archiveTerminalSafety(request:CompactRequest):AnchorReceipt{return AnchoredVault.#rewriteCurrent(request,undefined,undefined,true);}
  /** Explicit v2 -> v3 or old v3 -> packed Safety profile transition. */
  static upgradeStorage(request:CompactRequest & {storageProfile:StorageProfile}):AnchorReceipt{
    if(!['blocks-br4-v1','full-br4-v1','blocks-br4-safety-br4-v1',COLD_SAFETY_PROFILE,SAFETY_V2_PROFILE].includes(request.storageProfile))fail('ANCHOR_STORAGE_PROFILE');
    return AnchoredVault.#rewriteCurrent(request,request.storageProfile);
  }
  static archiveTerminalSafetyV2(request:CompactRequest):AnchorReceipt{return AnchoredVault.#rewriteCurrent(request,undefined,undefined,'v2');}
  static #rewriteCurrent(request:CompactRequest,profile?:StorageProfile,imageTransform?:'lossless-repack-v1',archive:false|true|'v2'=false):AnchorReceipt{return safetyOperation(()=>AnchoredVault.#rewriteCurrentScoped(request,profile,imageTransform,archive));}
  static #rewriteCurrentScoped(request:CompactRequest,profile?:StorageProfile,imageTransform?:'lossless-repack-v1',archive:false|true|'v2'=false):AnchorReceipt{
    id(request.vaultId);id(request.operationId);const keys=copyKeys(request.keys);
    const target=storagePath(request.targetDirectory,request.storageDomain,request.authority,false),kind=profile?'storage-upgrade':'compaction';
    try{return vaultTransaction(request.authority,tx=>{
      const digest=(oldHead:VaultHead)=>sha(JSON.stringify(archive?{kind:'compaction',action:archive==='v2'?'archive-terminal-safety-v2':'archive-terminal-safety-v1',oldHead,target,storageDomain:request.storageDomain,
        profile:archive==='v2'?SAFETY_V2_PROFILE:COLD_SAFETY_PROFILE,selectionPolicy:archive==='v2'?'all-terminal-v2':'all-terminal-v1',maxCalls:request.maxCalls,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey)}:
        {kind,oldHead,target,storageDomain:request.storageDomain,profile:profile??oldHead.storageProfile,
        maxCalls:request.maxCalls,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey),...(imageTransform?{imageTransform}:{})}));
      const prior=tx.receipt(request.vaultId,request.operationId);if(prior){if(!prior.oldHead||prior.requestDigest!==digest(prior.oldHead))fail('ANCHOR_OPERATION_CONFLICT');return prior;}
      const row=tx.row(request.vaultId);if(!row?.head)fail('ANCHOR_UNREGISTERED');tx.assertActive(row.head);const oldHead=row.head;
      if(profile?!canUpgradeStorage(oldHead,profile):oldHead.format!==INCREMENTAL_FORMAT)fail('ANCHOR_STORAGE_PROFILE');
      if(archive&&oldHead.storageProfile!==(archive==='v2'?SAFETY_V2_PROFILE:COLD_SAFETY_PROFILE))fail('ANCHOR_STORAGE_PROFILE');disjoint(oldHead.directory,target);
      const accounted=v2(oldHead)||profile===SAFETY_V2_PROFILE,decoded=readCurrent(oldHead,keys,request.maxCalls,profile===SAFETY_V2_PROFILE);let repacked:Uint8Array|undefined;
      try{
        if(imageTransform){
          repacked=transformImage(accounted,()=>repackMemoryImage(decoded.image,oldHead.schemaVersion??1,decoded.state.revocationHighWater,accounted));
        }else validateImage(decoded.image,decoded.state.revocationHighWater,oldHead.schemaVersion??1,accounted);
        const identity:VaultIdentity={...identityOf(oldHead),format:INCREMENTAL_FORMAT,storageProfile:profile??oldHead.storageProfile!,
          instanceId:randomUUID(),ownerEpoch:oldHead.ownerEpoch+1,directory:target,storageDomain:request.storageDomain};
        const generation=freezeGeneration(identity,request.operationId,repacked??decoded.image,decodedSafety(decoded),decoded.state.revocationHighWater,keys,oldHead,decoded,Boolean(archive)),frozen=generation.frozen;
        const stagePath=writeGeneration(generation,request.operationId,request.fault);
        const pending:PendingCommit={version:2,kind,operationId:request.operationId,requestDigest:digest(oldHead),oldHead,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes)};
        tx.prepare(pending);request.fault?.('prepared');publish(frozen.stage,request.fault);const receipt=finalizeFrozen(tx,pending);request.fault?.('finalized');return receipt;
      }finally{disposeDecoded(decoded);repacked?.fill(0);}
    });}finally{keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  /** Capacity recovery reads the authority's exact CURRENT files, without booting
   * the source or requiring a possibly stale backup. Required reset IDs are explicit. */
  static maintainFanout(request: { authority: LocalSqliteAuthority; vaultId: string; keys: KeySet; maxCalls: number;
    targetDirectory: string; storageDomain: string; operationId: string; retainBatches: number; resetConsumerIds: string[];
    fault?: (point: AnchoredFault) => void }): AnchorReceipt {
    id(request.operationId); id(request.vaultId);
    if (!Array.isArray(request.resetConsumerIds)) fail('FANOUT_RESET_SELECTION');
    const selected = [...request.resetConsumerIds].sort(); for (const consumerId of selected) text(consumerId,128);
    const target = storagePath(request.targetDirectory, request.storageDomain, request.authority, false), keys = copyKeys(request.keys);
    try {
      return vaultTransaction(request.authority,tx => {
        const digest = (oldHead: VaultHead) => sha(JSON.stringify({kind:'fanout-maintenance',oldHead,target,storageDomain:request.storageDomain,
          retainBatches:request.retainBatches,resetConsumerIds:selected,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey)}));
        const prior = tx.receipt(request.vaultId,request.operationId);
        if (prior) { if (!prior.oldHead || prior.requestDigest !== digest(prior.oldHead)) fail('ANCHOR_OPERATION_CONFLICT'); return prior; }
        const row = tx.row(request.vaultId); if (!row?.head) fail('ANCHOR_UNREGISTERED'); tx.assertActive(row.head);
        const oldHead = row.head; if (oldHead.schemaVersion !== 2) fail('FANOUT_SCHEMA_REQUIRED');
        disjoint(target,oldHead.directory);
        const decoded = readCurrent(oldHead,keys,request.maxCalls); let image:Uint8Array|undefined;
        try {
          validateImage(decoded.image,decoded.state.revocationHighWater,2,v2(oldHead));
          const result = transformImage(v2(oldHead),()=>maintainFanoutImage(decoded.image,request.retainBatches,selected,decodedGlobals(decoded).lastWall,v2(oldHead))); image=result.image;
          const maintenance = {floor:result.floor,resetConsumerIds:result.resetConsumers};
          const identity:VaultIdentity = {...identityOf(oldHead),instanceId:randomUUID(),ownerEpoch:oldHead.ownerEpoch+1,directory:target,storageDomain:request.storageDomain};
          const generation=freezeGeneration(identity,request.operationId,image,decodedSafety(decoded),decoded.state.revocationHighWater,keys,oldHead,decoded,false,maintenance),frozen=generation.frozen;
          const stagePath=writeGeneration(generation,request.operationId,request.fault);
          const pending:PendingCommit={version:2,kind:'fanout-maintenance',operationId:request.operationId,requestDigest:digest(oldHead),
            oldHead,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes),maintenance};
          tx.prepare(pending);request.fault?.('prepared');publish(frozen.stage,request.fault);const receipt=finalizeFrozen(tx,pending);request.fault?.('finalized');return receipt;
        }finally{image?.fill(0);disposeDecoded(decoded);}
      });
    }finally{keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  static #cutover(request: RestoreRequest, newStorageDEK?: Uint8Array, targetSchema?: 2): AnchorReceipt {return safetyOperation(()=>AnchoredVault.#cutoverScoped(request,newStorageDEK,targetSchema));}
  static #cutoverScoped(request: RestoreRequest, newStorageDEK?: Uint8Array, targetSchema?: 2): AnchorReceipt {
    id(request.operationId); validateIdentityBudget('synthetic-validation', request.maxCalls);
    const keys = copyKeys(request.keys);
    if (newStorageDEK) {
      if (newStorageDEK.length !== 32 || Buffer.from(newStorageDEK).equals(keys.storageDEK) || Buffer.from(newStorageDEK).equals(keys.ingressKey)) fail('ANCHOR_KEYSET');
      keys.storageDEK.fill(0); keys.storageDEK = Buffer.from(newStorageDEK); keys.keyEpoch++;
    }
    const decoded = readBackup(request.backupDirectory, request.keys, request.maxCalls);
    let migrated: Uint8Array | undefined;
    try {
      disjoint(canonicalDirectory(request.backupDirectory), request.authority.directory);
      const target = storagePath(request.targetDirectory, request.storageDomain, request.authority, false), oldHead = decoded.stage.head;
      disjoint(target, canonicalDirectory(request.backupDirectory)); disjoint(target, oldHead.directory);
      const kind = targetSchema ? 'schema-migration' : newStorageDEK ? 'rekey' : 'restore';
      const requestDigest = sha(JSON.stringify({ kind, backupDigest: sha(decoded.bytes), target, storageDomain: request.storageDomain,
        keyEpoch: keys.keyEpoch, ...(targetSchema ? { targetSchema } : {}), storageKeyDigest: sha(keys.storageDEK), ingressKeyDigest: sha(keys.ingressKey) }));
      return vaultTransaction(request.authority,tx => {
        const prior = tx.receipt(oldHead.vaultId, request.operationId);
        if (prior) { if (prior.requestDigest !== requestDigest) fail('ANCHOR_OPERATION_CONFLICT'); return prior; }
        tx.assertActive(oldHead); // Exact fresh head is taken from independently held authority, never package trust alone.
        if (targetSchema) migrated = transformImage(v2(oldHead),()=>migrateMemoryImage(decoded.image, oldHead.schemaVersion ?? 1, targetSchema, decodedGlobals(decoded).lastWall,v2(oldHead)));
        const identity: VaultIdentity = { ...identityOf(oldHead), instanceId: randomUUID(), ownerEpoch: oldHead.ownerEpoch + 1,
          keyEpoch: keys.keyEpoch, directory: target, storageDomain: request.storageDomain, ...(targetSchema ? { schemaVersion: targetSchema } : {}) };
        const generation=freezeGeneration(identity,request.operationId,migrated??decoded.image,decodedSafety(decoded),decoded.state.revocationHighWater,keys,oldHead,decoded),frozen=generation.frozen;
        const stagePath=writeGeneration(generation,request.operationId,request.fault);
        const pending: PendingCommit = { version: 2, kind, operationId: request.operationId, requestDigest, oldHead,
          newHead: frozen.stage.head, stagePath, stageDigest: sha(frozen.bytes) };
        tx.prepare(pending); request.fault?.('prepared'); publish(frozen.stage, request.fault);
        const receipt = finalizeFrozen(tx,pending); request.fault?.('finalized'); return receipt;
      });
    } finally { migrated?.fill(0); disposeDecoded(decoded); keys.storageDEK.fill(0); keys.ingressKey.fill(0); }
  }
  /** Explicit completion of the exact frozen operation. No business/provider
   * callback is replayed, and a missing/conflicting stage leaves PREPARED intact. */
  static reconcile(request: { authority: LocalSqliteAuthority; vaultId: string; operationId: string; keys: KeySet; maxCalls: number }): AnchorReceipt {
    return vaultTransaction(request.authority,tx => {
      const prior = tx.receipt(request.vaultId, request.operationId); if (prior) return prior;
      const row = tx.row(request.vaultId), pending = row?.pending;
      if (row?.status !== 'PREPARED' || !pending || pending.operationId !== request.operationId) fail('ANCHOR_UNRESOLVED');
      try {
        const bytes = pending.newHead.format===INCREMENTAL_FORMAT?readNarrowMetadata(pending.stagePath,MANIFEST_LIMIT):readBounded(pending.stagePath);
        if (sha(bytes) !== pending.stageDigest || pending.stagePath !== join(pending.newHead.directory, `stage-${pending.operationId}.json`)) fail('ANCHOR_UNRESOLVED');
        const decoded = pending.newHead.format===INCREMENTAL_FORMAT
          ?reconstructCurrent(pending.newHead,v2(pending.newHead)?(name,max)=>readSafetyV2File(join(pending.newHead.directory,name),max):directoryReader(pending.newHead.directory),request.keys,request.maxCalls,parseFrozenV3(bytes))
          :decodeStage(bytes, request.keys, request.maxCalls);
        try {
          if (!same(decoded.stage.head, pending.newHead) || decoded.record.operationId !== pending.operationId
            || !same(readMarker(pending.newHead.directory), identityOf(pending.newHead))) fail('ANCHOR_UNRESOLVED');
          if (['restore','rekey','schema-migration','fanout-maintenance','compaction','storage-upgrade'].includes(pending.kind) && !same(decoded.record.parentHead, pending.oldHead)) fail('ANCHOR_UNRESOLVED');
          if(pending.kind==='write'&&decoded.record.version===3&&!same(decoded.record.previousHead,pending.oldHead))fail('ANCHOR_UNRESOLVED');
          if (!same(decoded.record.maintenance, pending.maintenance)) fail('ANCHOR_UNRESOLVED');
          if(!same(decoded.record.legacyImport,pending.legacyImport))fail('ANCHOR_UNRESOLVED');
          validateImage(decoded.image, decoded.state.revocationHighWater, pending.newHead.schemaVersion ?? 1,v2(pending.newHead)); publish(decoded.stage); return finalizeFrozen(tx,pending);
        } finally { disposeDecoded(decoded); }
      } catch { fail('ANCHOR_UNRESOLVED'); }
    });
  }
}
