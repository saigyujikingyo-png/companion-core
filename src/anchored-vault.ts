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
import type { DurableEndogenousSession, EndogenousControl } from './endogenous-durable.ts';
import type { EndogenousDecisionPort, EndogenousLimits, EndogenousOwner } from './endogenous-lifecycle.ts';
import { MAX_COMMITS, MAX_DISK, MAX_IMAGE, sha, validateIdentityBudget } from './durable-codec.ts';
import type { Safety, Terminal } from './durable-codec.ts';
import { CoreError, fail, text } from './validation.ts';
import { ANCHORED_FORMAT, INCREMENTAL_FORMAT, INCREMENTAL_MARKER, VAULT_MARKER, boundSqlite, canonicalDirectory, copyKeys, decodeStage, disjoint, id,
  encodeVaultMarker, identityOf, readBounded, same, sealV2, validateHead, validateIdentity, writeNew,canUpgradeStorage } from './anchored-codec.ts';
import type { FrozenStage, KeySet, StorageProfile, VaultHead, VaultIdentity, VaultRecord, VaultState } from './anchored-codec.ts';
import { directoryReader, freezeFrame, parseFrozenV3, reconstruct, MANIFEST_LIMIT } from './incremental-storage.ts';
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
type Decoded = ReturnType<typeof decodeStage> | Reconstructed;
type Frozen = { bytes:Buffer;stage:FrozenStage|FrozenV3;blob?:Buffer;baseline?:Baseline };
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
function readMarker(directory: string): VaultIdentity {
  let value: VaultIdentity;
  try {
    const old=existsSync(join(directory,VAULT_MARKER)),next=existsSync(join(directory,INCREMENTAL_MARKER));
    if(old===next)fail('ANCHOR_INCOMPLETE');value=JSON.parse(readBounded(join(directory,next?INCREMENTAL_MARKER:VAULT_MARKER),8192).toString('utf8'));
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
function stageBytes(identity: VaultIdentity, sequence: number, operationId: string, image: Uint8Array, safety: Safety,
  revocationHighWater: number, keys: KeySet, oldHead: VaultHead | null, parentHead: VaultHead | null,
  maintenance?: PendingCommit['maintenance'], baseline:Baseline|null=null,legacyImport?:LegacyImportProof,hot?:HotSafetyEnvelope): Frozen {
  if (image.length > MAX_IMAGE || sequence > MAX_COMMITS) fail('ANCHOR_LIMIT');
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
  assertColdClosure(stage.head);
  if(stage.format===INCREMENTAL_FORMAT){
    if(sha(readBounded(join(stage.head.directory,stage.blob),stage.blobLength))!==stage.blobDigest)fail('ANCHOR_PUBLISH_CONFLICT');
    fault?.('checkpoint-published');const path=join(stage.head.directory,`record-${stage.head.sequence}.bin`),bytes=Buffer.from(stage.record,'base64');
    if(existsSync(path)){if(!readBounded(path).equals(bytes))fail('ANCHOR_PUBLISH_CONFLICT');}else writeNew(path,bytes);
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
  assertColdClosure(pending.newHead);return tx.finalize(pending);
}
function disposeDecoded(decoded:Decoded|undefined):void{if(decoded){decoded.image.fill(0);if('ledger' in decoded)decoded.ledger.close();}}
/** Every generation builder binds the new context before sealing the cold root. */
function freezeGeneration(identity:VaultIdentity,operationId:string,image:Uint8Array,safety:Safety,highWater:number,keys:KeySet,parent:VaultHead|null,
  source?:Decoded,archive=false,maintenance?:PendingCommit['maintenance'],legacyImport?:LegacyImportProof):{identity:VaultIdentity;frozen:Frozen;marker:Buffer;cold?:Buffer}{
  let hot:HotSafetyEnvelope|undefined,cold:Buffer|undefined;
  if(identity.storageProfile===COLD_SAFETY_PROFILE){
    const ledger=source&&'ledger' in source?source.ledger:undefined;
    const partition=archive?(ledger??fail('SAFETY_COLD_PROFILE')).archivePartition():{hot:ledger?.hotEnvelope()??allHotSafety(safety),cold:ledger?.coldRows()??[]};
    hot=partition.hot;identity={...identity,safetyCold:null};
    if(partition.cold.length){const sealed=sealSafetySegment(partition.cold,identity,keys.storageDEK);identity.safetyCold=sealed.descriptor;cold=sealed.bytes;}
    validateHotSnapshot(safety,hot,identity);
    if(source&&canonicalSafetyJSON(source.state.safety)!==canonicalSafetyJSON(safety))fail('SAFETY_LOGICAL_MISMATCH');
  }
  const encodedMarker=marker(identity),frozen=stageBytes(identity,1,operationId,image,safety,highWater,keys,null,parent,maintenance,null,legacyImport,hot);
  if(encodedMarker.length+frozen.bytes.length*2+(frozen.blob?.length??0)+(cold?.length??0)>MAX_DISK)fail('ANCHOR_LIMIT');
  return{identity,frozen,marker:encodedMarker,...(cold?{cold}:{})};
}
function writeGeneration(generation:ReturnType<typeof freezeGeneration>,operationId:string,fault?:Options['fault']):string{
  const {identity,frozen}=generation;createDirectory(identity.directory);writeNew(join(identity.directory,markerName(identity)),generation.marker);
  if(generation.cold){writeNew(join(identity.directory,identity.safetyCold!.file),generation.cold);fault?.('safety-cold-written');}
  const stagePath=writeStage(identity.directory,operationId,frozen.bytes,frozen);assertColdClosure(identity);fault?.('stage-written');return stagePath;
}
function readCurrent(head: VaultHead, keys: KeySet, maxCalls: number): Decoded {
  if (!same(readMarker(head.directory), identityOf(head))) fail('ANCHOR_IDENTITY');
  if(head.format===INCREMENTAL_FORMAT)return reconstruct(head,directoryReader(head.directory),keys,maxCalls);
  return decodeStage(Buffer.from(JSON.stringify({ format: ANCHORED_FORMAT, head,
    checkpoint: readBounded(join(head.directory, `checkpoint-${head.sequence}.bin`)).toString('base64'),
    record: readBounded(join(head.directory, `record-${head.sequence}.bin`)).toString('base64') })), keys, maxCalls);
}
function validateImage(image: Uint8Array, highWater: number, schema: MemorySchema = 1): void {
  if (inspectMemoryImage(image, schema).revocationHighWater !== highWater) fail('ANCHOR_CORRUPT');
}
function readBackup(directory: string, keys: KeySet, maxCalls: number): Decoded & { bytes: Buffer } {
  const path = canonicalDirectory(directory);let receipt:BackupReceipt;
  try{receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBounded(join(path,'backup.json'),16384)));}catch{fail('ANCHOR_BACKUP');}
  if(!receipt||![ANCHORED_FORMAT,INCREMENTAL_FORMAT].includes(receipt.format)||receipt.coverage!=='current-state')fail('ANCHOR_BACKUP');
  const bytes=receipt.format===INCREMENTAL_FORMAT?readBounded(join(path,'current-state.json'),MANIFEST_LIMIT):readBounded(join(path,'current-state.json'));
  let decoded:Decoded;
  if(receipt.format===INCREMENTAL_FORMAT){
    let candidate:any;try{candidate=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('ANCHOR_BACKUP');}
    if(candidate?.format!==INCREMENTAL_FORMAT)fail('ANCHOR_BACKUP');
    validateHead(candidate.head);const coldProfile=candidate.head.storageProfile===COLD_SAFETY_PROFILE;
    if(bytes.length>MANIFEST_LIMIT||Object.keys(candidate).sort().join(',')!=='files,format,head'||!Array.isArray(candidate.files)
      ||candidate.files.length>(coldProfile?(candidate.head.safetyCold?31:30):32))fail('ANCHOR_BACKUP');
    const files=new Map<string,{size:number;digest:string}>();let total=0;
    for(const file of candidate.files){if(!file||Object.keys(file).sort().join(',')!=='digest,name,size'||typeof file.name!=='string'
      ||!(coldProfile?/^(blob-[a-f0-9]{64}|record-[1-9][0-9]*|safety-[a-f0-9]{64})\.bin$/:/^(blob-[a-f0-9]{64}|record-[1-9][0-9]*)\.bin$/).test(file.name)||files.has(file.name)||!Number.isSafeInteger(file.size)||file.size<1||! /^[a-f0-9]{64}$/.test(file.digest))fail('ANCHOR_BACKUP');
      total+=file.size;if(total>64*1024*1024)fail('ANCHOR_BACKUP');files.set(file.name,file);}
    decoded=reconstruct(candidate.head,(name,max)=>{const file=files.get(name);if(!file||file.size>max)fail('ANCHOR_BACKUP');const data=readBounded(join(path,name),file.size);
      if(data.length!==file.size||sha(data)!==file.digest)fail('ANCHOR_BACKUP');return data;},keys,maxCalls);
    if(files.size!==decoded.files.size){disposeDecoded(decoded);fail('ANCHOR_BACKUP');}
    if(coldProfile){try{const actual=readdirSync(path).sort(),expected=[...files.keys(),'backup.json','current-state.json'].sort();
      if(!same(actual,expected))fail('ANCHOR_BACKUP');}catch(error){disposeDecoded(decoded);throw error;}}
  }else decoded=decodeStage(bytes,keys,maxCalls);
  try {
    if (receipt.format !== decoded.stage.head.format || receipt.coverage !== 'current-state' || receipt.stageDigest !== sha(bytes) || !same(receipt.head, decoded.stage.head)) fail('ANCHOR_BACKUP');
    validateImage(decoded.image, decoded.state.revocationHighWater, decoded.stage.head.schemaVersion ?? 1);
    return { ...decoded, bytes };
  } catch (error) { disposeDecoded(decoded); throw error; }
}

/** A separate mandatory-anchor format. Never opens/upgrades an M2.v1 directory. */
export class AnchoredVault {
  /** Static metadata inspection, including ACTIVE sources whose live handle is poisoned. */
  static inspectCapacity(request:InspectCapacityRequest):VaultCapacity{
    const {authority,vaultId,keys,maxCalls,directoryEntryLimit}=capacityRequest(request);
    let decoded:Decoded|undefined;
    try{return authority.transaction(tx=>{
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
      const image=inspectMemoryImageCapacity(current.image,head.schemaVersion??1);
      if(image.revocationHighWater!==current.state.revocationHighWater)fail('ANCHOR_CORRUPT');
      const directory=capacityDirectory(head.directory,directoryEntryLimit);
      const generation:GenerationCapacity={sequence:head.sequence,commitLimit:MAX_COMMITS,directory,
        requiredChain:'baseline' in current?{frames:current.baseline.depth,files:current.files.size,encodedBytes:current.baseline.readBytes,frameLimit:chainLimit(head.storageProfile),replayByteLimit:MAX_REPLAY_BYTES}
          :{frames:1,files:2,encodedBytes:Buffer.byteLength(current.stage.checkpoint,'base64')+Buffer.byteLength(current.stage.record,'base64'),frameLimit:null,replayByteLimit:null},
        diskLimitBytes:MAX_DISK,otherGenerationsAndBackups:'unmeasured'};
      const state=current.state.safety,safety={ingressCount:state.ingress.length,ingressLimit:8192,unknownCount:state.ingress.filter(entry=>entry.state==='unknown').length,reserved:state.reserved,maxCalls:state.maxCalls,
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
  #ledger: SafetyLedger;
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
      ...(config.storageProfile===COLD_SAFETY_PROFILE?{safetyCold:null}:{}) } : readMarker(directory);
    validateIdentity(this.#identity);
    if (this.#identity.authorityId !== config.authority.authorityId || this.#identity.vaultId !== config.vaultId
      || this.#identity.identity !== config.identity || this.#identity.keyEpoch !== config.keys.keyEpoch || this.#identity.storageDomain !== config.storageDomain
      || (this.#identity.schemaVersion ?? 1) !== (config.schemaVersion ?? 1)||this.#identity.storageProfile!==config.storageProfile) fail('ANCHOR_IDENTITY');
    this.#ledger = new SafetyLedger({ version: 1, identity: config.identity, maxCalls, reserved: 0, ingress: [], lastSourceRef: null, lastAcknowledgedDeliveryId: null, lastWall: 0 },
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
      this.#authority.transaction(tx => {
        this.#depth = 1; this.#tx = tx;
        let image: Buffer | undefined;
        try {
          const row = tx.row(config.vaultId);
          if (creating) { if (row) fail('ANCHOR_ALREADY_REGISTERED'); }
          else {
            if (!row) fail('ANCHOR_UNREGISTERED'); if (row.status !== 'ACTIVE') fail('ANCHOR_PENDING');
            this.#head = row.head!;
            if (!same(identityOf(this.#head), this.#identity)) fail('ANCHOR_FENCED');
            tx.assertActive(this.#head); // Includes mandatory imported-lineage registry validation before boot or staging.
            const decoded = readCurrent(this.#head, this.#keys, maxCalls); image = decoded.image;this.#ledger.close();
            this.#ledger = 'ledger' in decoded?decoded.ledger:new SafetyLedger(decoded.state.safety,this.#identity,maxCalls);
            if('baseline' in decoded)this.#baseline={...decoded.baseline,image:Buffer.from(decoded.image)};
          }
          this.#ledger.boot();
          this.#wallNow();
          store = new MemoryStore(':memory:', { ...(image ? { image } : {}), clock: { wall: () => this.#wallNow(), monotonic: this.#clock.monotonic },
            schemaVersion: this.#identity.schemaVersion ?? 1, ...(options.fanoutFault ? { fanoutFault: options.fanoutFault } : {}),
            aroundAccess: body => this.#storeAccess(body), assertHealthy: () => this.#healthy(), onPoison: () => { this.#poisoned = true; },
            endogenousBoot: (encoded, scope) => {
              try { return bootControl(encoded, scope, this.#identity); }
              catch (error) {
                // Preserve the exact cell and let ordinary Store boot continue. Only expected
                // extension-validation failures are isolated; SQL/AEAD/authority failures escape.
                if (!(error instanceof CoreError) || !['E1_CONTROL_INVALID','E1_CONTROL_LIMIT','E1_CONTROL_IDENTITY',
                  'E1_CONTROL_SCOPE','E1_INVALID_LIMITS','SCOPE_NOT_FOUND'].includes(error.code)) throw error;
                this.#endogenousBootBlocked = error.code === 'SCOPE_NOT_FOUND' ? 'E1_CONTROL_SCOPE' : error.code;
                return encoded;
              }
            },
            endogenousMutation: (encoded, scope) => this.#endogenousBootBlocked ? encoded : fenceControl(encoded, scope),
            onEndogenousInvalidated: () => this.#endogenousOwner?.invalidate(),
            bindEndogenousWriter: write => { this.#writeEndogenous = write; },
            persist: (bytes, highWater) => this.#commit(bytes, highWater), assertCloseAllowed: () => { if (this.#depth) fail('ANCHOR_ACCESS_BUSY'); } });
          this.#store = store;
          if (image) validateImage(image, this.#withStore(() => store!.revocationHighWater()), this.#identity.schemaVersion ?? 1);
          this.#save();
        } finally { image?.fill(0); this.#depth = 0; this.#tx = undefined; }
      });
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
    return this.#authority.transaction(tx => {
      tx.assertActive(this.#head!);this.#ledger.assertColdClosure(); this.#depth = 1; this.#tx = tx;
      try { return body(); } finally { this.#depth = 0; this.#tx = undefined; }
    });
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
  #commit(image: Uint8Array, highWater: number): void {
    if (!this.#depth || !this.#tx) fail('ANCHOR_TRANSACTION');
    try {
      this.#ledger.assertColdClosure();this.#wallNow(); const operationId = randomUUID(), sequence = (this.#head?.sequence ?? 0) + 1;
      const frozen = stageBytes(this.#identity, sequence, operationId, image, this.#ledger.completeSafety(), highWater, this.#keys, this.#head, null,undefined,this.#baseline,undefined,
        this.#identity.storageProfile===COLD_SAFETY_PROFILE?this.#ledger.hotEnvelope():undefined);
      const stagePath = writeStage(this.#identity.directory, operationId, frozen.bytes,frozen); this.#fault?.('stage-written');
      const pending: PendingCommit = { version: 2, kind: this.#head ? 'write' : 'create', operationId, requestDigest: sha(frozen.bytes),
        oldHead: this.#head, newHead: frozen.stage.head, stagePath, stageDigest: sha(frozen.bytes) };
      this.#tx.prepare(pending); this.#fault?.('prepared');
      publish(frozen.stage, this.#fault); finalizeFrozen(this.#tx,pending); this.#head = frozen.stage.head;
      if(frozen.baseline){this.#baseline?.image.fill(0);this.#baseline={...frozen.baseline,image:Buffer.from(image)};}this.#fault?.('finalized');
    } catch (error) { this.#poisoned = true; if (error instanceof CoreError) throw error; fail('ANCHOR_WRITE_FAILED'); }
  }
  #save(): void {
    let image:Uint8Array|undefined;
    try { image=this.#withStore(() => this.store.snapshot()); this.#commit(image, this.#withStore(() => this.store.revocationHighWater())); }
    catch(error) { this.#poisoned=true; if(error instanceof CoreError)throw error; fail('ANCHOR_WRITE_FAILED'); }
    finally { image?.fill(0); }
  }
  #digest(value: unknown): string { return createHmac('sha256', this.#keys.ingressKey).update(JSON.stringify(value)).digest('hex'); }
  /** Explicit management authorization. Existing controls are never reset or replenished. */
  createEndogenousControl(scope: Scope, limits?: Partial<EndogenousLimits>): EndogenousControl {
    return this.#access(() => {
      this.#tx!.assertAdmitted(this.#head!);
      if (this.#endogenousBootBlocked) fail(this.#endogenousBootBlocked);
      if (this.#withStore(() => this.store.endogenousControl()) !== null) fail('E1_CONTROL_EXISTS');
      const current = this.#withStore(() => this.store.scope(scope.id));
      if (!same(scope, current)) fail('E1_CONTROL_SCOPE');
      const record = newControl(this.#identity, current, this.#wallNow(), limits);
      this.#withStore(() => this.#writeEndogenous(null, encodeControl(record)));
      return structuredClone(record);
    });
  }
  /** One lane per live vault; opening never creates a missing record or starts a call. */
  openEndogenousControl(port: EndogenousDecisionPort): DurableEndogenousSession {
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
      }, this.#identity, port, this.#clock.monotonic);
      this.#endogenousOwner = bound.owner;
      return bound.session;
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
  source(ref: SourceRef): void { this.#access(() => { this.#ledger.globals.lastSourceRef = structuredClone(ref); this.#save(); }); }
  get head(): VaultHead { return this.#access(() => structuredClone(this.#head!)); }
  get reserved(): number { return this.#access(() => this.#ledger.globals.reserved); }
  get status() {
    return this.#access(() => ({ format: this.#identity.format, head: structuredClone(this.#head!), restored: this.restored,
      consumedRequests: this.#ledger.globals.reserved, unknownRequests: this.#ledger.completeSafety().ingress.filter(e => e.state === 'unknown').length,
      ingressCount: this.#ledger.count, lastSourceRef: structuredClone(this.#ledger.globals.lastSourceRef),
      ...(this.#identity.storageProfile===COLD_SAFETY_PROFILE?{hotIngressCount:this.#ledger.hotCount,coldIngressCount:this.#ledger.coldCount}:{}),
      lastAcknowledgedDeliveryId: this.#ledger.globals.lastAcknowledgedDeliveryId, manualResumeRequired: true, coverage: 'current-state' as const }));
  }
  exportBackup(target: string): BackupReceipt {
    return this.#access(() => {
      const directory = storagePath(target, this.#identity.storageDomain, this.#authority, false);
      disjoint(directory, this.#identity.directory);
      const decoded = readCurrent(this.#head!, this.#keys, this.#ledger.globals.maxCalls);
      try {
        validateImage(decoded.image, decoded.state.revocationHighWater, this.#identity.schemaVersion ?? 1);
        const files='files' in decoded?decoded.files:undefined;
        const bytes = Buffer.from(JSON.stringify(files?{format:INCREMENTAL_FORMAT,head:this.#head!,files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,data])=>({name,size:data.length,digest:sha(data)}))}:decoded.stage));
        const receipt: BackupReceipt = { format: this.#identity.format, coverage: 'current-state', head: this.#head!, stageDigest: sha(bytes) };
        createDirectory(directory);if(files)for(const[name,data]of files)writeNew(join(directory,name),data);
        writeNew(join(directory, 'current-state.json'), bytes); writeNew(join(directory, 'backup.json'), Buffer.from(JSON.stringify(receipt)));
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
    const decoded = readBackup(request.backupDirectory, request.keys, request.maxCalls);
    try {
      disjoint(canonicalDirectory(request.backupDirectory), request.authority.directory);
      return request.authority.transaction(tx => { tx.assertActive(decoded.stage.head); return { format: decoded.stage.head.format,
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
      return request.authority.transaction(tx=>{
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
    if(!['blocks-br4-v1','full-br4-v1','blocks-br4-safety-br4-v1',COLD_SAFETY_PROFILE].includes(request.storageProfile))fail('ANCHOR_STORAGE_PROFILE');
    return AnchoredVault.#rewriteCurrent(request,request.storageProfile);
  }
  static #rewriteCurrent(request:CompactRequest,profile?:StorageProfile,imageTransform?:'lossless-repack-v1',archive=false):AnchorReceipt{
    id(request.vaultId);id(request.operationId);const keys=copyKeys(request.keys);
    const target=storagePath(request.targetDirectory,request.storageDomain,request.authority,false),kind=profile?'storage-upgrade':'compaction';
    try{return request.authority.transaction(tx=>{
      const digest=(oldHead:VaultHead)=>sha(JSON.stringify(archive?{kind:'compaction',action:'archive-terminal-safety-v1',oldHead,target,storageDomain:request.storageDomain,
        profile:COLD_SAFETY_PROFILE,selectionPolicy:'all-terminal-v1',maxCalls:request.maxCalls,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey)}:
        {kind,oldHead,target,storageDomain:request.storageDomain,profile:profile??oldHead.storageProfile,
        maxCalls:request.maxCalls,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey),...(imageTransform?{imageTransform}:{})}));
      const prior=tx.receipt(request.vaultId,request.operationId);if(prior){if(!prior.oldHead||prior.requestDigest!==digest(prior.oldHead))fail('ANCHOR_OPERATION_CONFLICT');return prior;}
      const row=tx.row(request.vaultId);if(!row?.head)fail('ANCHOR_UNREGISTERED');tx.assertActive(row.head);const oldHead=row.head;
      if(profile?!canUpgradeStorage(oldHead,profile):oldHead.format!==INCREMENTAL_FORMAT)fail('ANCHOR_STORAGE_PROFILE');
      if(archive&&oldHead.storageProfile!==COLD_SAFETY_PROFILE)fail('ANCHOR_STORAGE_PROFILE');disjoint(oldHead.directory,target);
      const decoded=readCurrent(oldHead,keys,request.maxCalls);let repacked:Uint8Array|undefined;
      try{
        if(imageTransform){
          repacked=repackMemoryImage(decoded.image,oldHead.schemaVersion??1,decoded.state.revocationHighWater);
        }else validateImage(decoded.image,decoded.state.revocationHighWater,oldHead.schemaVersion??1);
        const identity:VaultIdentity={...identityOf(oldHead),format:INCREMENTAL_FORMAT,storageProfile:profile??oldHead.storageProfile!,
          instanceId:randomUUID(),ownerEpoch:oldHead.ownerEpoch+1,directory:target,storageDomain:request.storageDomain};
        const generation=freezeGeneration(identity,request.operationId,repacked??decoded.image,decoded.state.safety,decoded.state.revocationHighWater,keys,oldHead,decoded,archive),frozen=generation.frozen;
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
      return request.authority.transaction(tx => {
        const digest = (oldHead: VaultHead) => sha(JSON.stringify({kind:'fanout-maintenance',oldHead,target,storageDomain:request.storageDomain,
          retainBatches:request.retainBatches,resetConsumerIds:selected,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey)}));
        const prior = tx.receipt(request.vaultId,request.operationId);
        if (prior) { if (!prior.oldHead || prior.requestDigest !== digest(prior.oldHead)) fail('ANCHOR_OPERATION_CONFLICT'); return prior; }
        const row = tx.row(request.vaultId); if (!row?.head) fail('ANCHOR_UNREGISTERED'); tx.assertActive(row.head);
        const oldHead = row.head; if (oldHead.schemaVersion !== 2) fail('FANOUT_SCHEMA_REQUIRED');
        disjoint(target,oldHead.directory);
        const decoded = readCurrent(oldHead,keys,request.maxCalls); let image:Uint8Array|undefined;
        try {
          validateImage(decoded.image,decoded.state.revocationHighWater,2);
          const result = maintainFanoutImage(decoded.image,request.retainBatches,selected,decoded.state.safety.lastWall); image=result.image;
          const maintenance = {floor:result.floor,resetConsumerIds:result.resetConsumers};
          const identity:VaultIdentity = {...identityOf(oldHead),instanceId:randomUUID(),ownerEpoch:oldHead.ownerEpoch+1,directory:target,storageDomain:request.storageDomain};
          const generation=freezeGeneration(identity,request.operationId,image,decoded.state.safety,decoded.state.revocationHighWater,keys,oldHead,decoded,false,maintenance),frozen=generation.frozen;
          const stagePath=writeGeneration(generation,request.operationId,request.fault);
          const pending:PendingCommit={version:2,kind:'fanout-maintenance',operationId:request.operationId,requestDigest:digest(oldHead),
            oldHead,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes),maintenance};
          tx.prepare(pending);request.fault?.('prepared');publish(frozen.stage,request.fault);const receipt=finalizeFrozen(tx,pending);request.fault?.('finalized');return receipt;
        }finally{image?.fill(0);disposeDecoded(decoded);}
      });
    }finally{keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  static #cutover(request: RestoreRequest, newStorageDEK?: Uint8Array, targetSchema?: 2): AnchorReceipt {
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
      return request.authority.transaction(tx => {
        const prior = tx.receipt(oldHead.vaultId, request.operationId);
        if (prior) { if (prior.requestDigest !== requestDigest) fail('ANCHOR_OPERATION_CONFLICT'); return prior; }
        tx.assertActive(oldHead); // Exact fresh head is taken from independently held authority, never package trust alone.
        if (targetSchema) migrated = migrateMemoryImage(decoded.image, oldHead.schemaVersion ?? 1, targetSchema, decoded.state.safety.lastWall);
        const identity: VaultIdentity = { ...identityOf(oldHead), instanceId: randomUUID(), ownerEpoch: oldHead.ownerEpoch + 1,
          keyEpoch: keys.keyEpoch, directory: target, storageDomain: request.storageDomain, ...(targetSchema ? { schemaVersion: targetSchema } : {}) };
        const generation=freezeGeneration(identity,request.operationId,migrated??decoded.image,decoded.state.safety,decoded.state.revocationHighWater,keys,oldHead,decoded),frozen=generation.frozen;
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
    return request.authority.transaction(tx => {
      const prior = tx.receipt(request.vaultId, request.operationId); if (prior) return prior;
      const row = tx.row(request.vaultId), pending = row?.pending;
      if (row?.status !== 'PREPARED' || !pending || pending.operationId !== request.operationId) fail('ANCHOR_UNRESOLVED');
      try {
        const bytes = pending.newHead.format===INCREMENTAL_FORMAT?readBounded(pending.stagePath,MANIFEST_LIMIT):readBounded(pending.stagePath);
        if (sha(bytes) !== pending.stageDigest || pending.stagePath !== join(pending.newHead.directory, `stage-${pending.operationId}.json`)) fail('ANCHOR_UNRESOLVED');
        const decoded = pending.newHead.format===INCREMENTAL_FORMAT
          ?reconstruct(pending.newHead,directoryReader(pending.newHead.directory),request.keys,request.maxCalls,parseFrozenV3(bytes))
          :decodeStage(bytes, request.keys, request.maxCalls);
        try {
          if (!same(decoded.stage.head, pending.newHead) || decoded.record.operationId !== pending.operationId
            || !same(readMarker(pending.newHead.directory), identityOf(pending.newHead))) fail('ANCHOR_UNRESOLVED');
          if (['restore','rekey','schema-migration','fanout-maintenance','compaction','storage-upgrade'].includes(pending.kind) && !same(decoded.record.parentHead, pending.oldHead)) fail('ANCHOR_UNRESOLVED');
          if(pending.kind==='write'&&decoded.record.version===3&&!same(decoded.record.previousHead,pending.oldHead))fail('ANCHOR_UNRESOLVED');
          if (!same(decoded.record.maintenance, pending.maintenance)) fail('ANCHOR_UNRESOLVED');
          if(!same(decoded.record.legacyImport,pending.legacyImport))fail('ANCHOR_UNRESOLVED');
          validateImage(decoded.image, decoded.state.revocationHighWater, pending.newHead.schemaVersion ?? 1); publish(decoded.stage); return finalizeFrozen(tx,pending);
        } finally { disposeDecoded(decoded); }
      } catch { fail('ANCHOR_UNRESOLVED'); }
    });
  }
}
