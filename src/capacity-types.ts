import type {VaultHead} from './anchored-codec.ts';
import type {FANOUT_LIMITS} from './fanout-types.ts';
import type {SafetyColdDescriptor} from './safety-format.ts';
import type {Counts} from './authority-cold-format.ts';

export type FrozenData<T> = T extends object ? {readonly [K in keyof T]:FrozenData<T[K]>} : T;
/** Only call on newly assembled metadata, never caller-owned objects or buffers. */
export function freezeCapacity<T>(value:T):FrozenData<T>{
  if(value!==null&&typeof value==='object'){
    for(const child of Object.values(value))freezeCapacity(child);
    Object.freeze(value);
  }
  return value as FrozenData<T>;
}
export const CAPACITY_DIRECTORY_ENTRY_LIMIT=16384;
export type RetainedRootObservation={
  root:string;canonicalRoot:string|null;entriesObserved:number;observedBytes:number;
  status:'EOF'|'TRUNCATED'|'NOT_SCANNED'|'UNKNOWN';
  reason:null|'ENTRY_LIMIT'|'ROOT_UNAVAILABLE'|'ROOT_CHANGED'|'ENTRY_UNAVAILABLE'|'IO_ERROR'|'UNSAFE_ENTRY';
};
export type RetainedRootsCapacity=FrozenData<{
  version:1;entryLimit:number;entriesObserved:number;observedBytes:number;roots:RetainedRootObservation[];
}>;
export type AuthorityCapacity=FrozenData<{
  version:1;schemaVersion:2|3|4|5|6;
  database:{fileBytes:number;pageSize:number;pageCount:number;pageBytes:number;freelistPages:number};
  sidecars:{journalBytes:number;walBytes:number;shmBytes:number;totalBytes:number};
  totalFileBytes:number;
  limits:{writeLimitBytes:number;readLimitBytes:number};
  vaults:{count:number;active:number;pending:number};
  receipts:{count:number;jsonUtf8Bytes:number};
  receiptStorage?:{
    hot:{count:number;jsonUtf8Bytes:number};pointers:{count:number;storedUtf8Bytes:number};
    segments:{count:number;encodedBytes:number;decodedBytes:number;jsonUtf8Bytes:number};
    limits:{receipts:number;decodedBytes:number;encodedBytes:number;segments:number};
  };
  legacyRegistry:{applicable:false;count:null}|{applicable:true;count:number};
  coldRouting?:{epoch:number;slot:number|null;hot:Counts;cold:Counts;currentBytes:number;retainedBytes:number;retiredBytes:number;stagingBytes:number;otherSlotBytes:number;occupiedSlots:number;files:number;
    slots:{slot:number;intentBytes:number;payloadBytes:number}[];limits:{slotReserveBytes:number;workspaceBytes:number;sharedBytes:number;payloadBytes:number;slots:number};
    workspacePeakBytes:number;usedPages:number;blockers:Array<'SLOTS_FULL'>};
  shardedColdRouting?:{generation:number;manifestDigest:string;currentBytes:number;retainedBytes:number;obligationBytes:number;missingObligationBytes:number;files:number;reservedFiles:number;usedPages:number;hot:Counts;cold:Counts;pending:null|{operationId:string;activeAttempt:number};workspacePeakBytes:number;limits:{retainedBytes:number;files:number;partBytes:number;parts:2;workspaceBytes:number;sharedBytes:number;generation:number}};
  blockers:Array<'GLOBAL_PENDING'|'CURRENT_EXTENT_OVER_WRITE_LIMIT'|'PUBLICATION_PENDING'>;
}>;
export type MemoryImageCapacity=FrozenData<{
  schema:1|2;bytes:number;limitBytes:number;revocationHighWater:number;
  rows:{meta:number;scopes:number;nodes:number;ingress:number;dependencies:number;jobs:number;outbox:number;artifacts:number;revocations:number;memory_fts:number};
  fanout:{applicable:false;counts:null;limits:null}|{applicable:true;
    counts:{batches:number;items:number;consumers:number;projectionRows:number;projectionJsonUtf8Bytes:number;headSequence:number;floorSequence:number};
    limits:typeof FANOUT_LIMITS};
}>;
export type GenerationCapacity=FrozenData<{
  sequence:number;commitLimit:number;
  directory:{entryLimit:number;entriesObserved:number;complete:boolean;observedBytes:number;totalEntries:number|null;totalBytes:number|null};
  requiredChain:{frames:number;files:number;encodedBytes:number;frameLimit:number|null;replayByteLimit:number|null};
  diskLimitBytes:number;otherGenerationsAndBackups:'unmeasured';
}>;
export type SafetyCapacity=FrozenData<{ingressCount:number;ingressLimit:number;unknownCount:number;reserved:number;maxCalls:number;
  hotCount?:number;coldCount?:number;coldEncodedBytes?:number;coldDecodedBytes?:number;coldDescriptor?:SafetyColdDescriptor|null}>;
type VaultCapacityBase={version:1;authority:AuthorityCapacity;blockers:Array<'VAULT_PREPARED'|'VAULT_UNREGISTERED'|'LEGACY_ADMISSION_REQUIRED'|'DIRECTORY_OVER_DISK_LIMIT'|'COMMIT_LIMIT_REACHED'>};
export type VaultCapacity=FrozenData<VaultCapacityBase&(
  {status:'ACTIVE';detailsRead:true;currentHead:VaultHead;pending:null;legacyAdmission:'not-applicable'|'required'|'admitted';
    generation:GenerationCapacity;image:MemoryImageCapacity;safety:SafetyCapacity}|
  {status:'PREPARED';detailsRead:false;currentHead:null;pending:{kind:string;previousSequence:number|null;proposedSequence:number};legacyAdmission:'not-read';
    generation:null;image:null;safety:null}|
  {status:'UNREGISTERED';detailsRead:false;currentHead:null;pending:null;legacyAdmission:'not-read';generation:null;image:null;safety:null}
)>;
