import type {VaultHead} from './anchored-codec.ts';
import type {FANOUT_LIMITS} from './fanout-types.ts';

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
export type AuthorityCapacity=FrozenData<{
  version:1;schemaVersion:2|3|4;
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
  blockers:Array<'GLOBAL_PENDING'|'CURRENT_EXTENT_OVER_WRITE_LIMIT'>;
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
export type SafetyCapacity=FrozenData<{ingressCount:number;ingressLimit:number;unknownCount:number;reserved:number;maxCalls:number}>;
type VaultCapacityBase={version:1;authority:AuthorityCapacity;blockers:Array<'VAULT_PREPARED'|'VAULT_UNREGISTERED'|'LEGACY_ADMISSION_REQUIRED'|'DIRECTORY_OVER_DISK_LIMIT'|'COMMIT_LIMIT_REACHED'>};
export type VaultCapacity=FrozenData<VaultCapacityBase&(
  {status:'ACTIVE';detailsRead:true;currentHead:VaultHead;pending:null;legacyAdmission:'not-applicable'|'required'|'admitted';
    generation:GenerationCapacity;image:MemoryImageCapacity;safety:SafetyCapacity}|
  {status:'PREPARED';detailsRead:false;currentHead:null;pending:{kind:string;previousSequence:number|null;proposedSequence:number};legacyAdmission:'not-read';
    generation:null;image:null;safety:null}|
  {status:'UNREGISTERED';detailsRead:false;currentHead:null;pending:null;legacyAdmission:'not-read';generation:null;image:null;safety:null}
)>;
