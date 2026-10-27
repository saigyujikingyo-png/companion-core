import type { Epoch, MemoryRecord, SourceRef } from './contracts.ts';
import type { Frozen } from './curation-types.ts';
import type { ConsumerHandle } from './fanout-types.ts';
import { types } from 'node:util';
import { fail, object, text } from './validation.ts';

export const RETRIEVAL_LIMITS = Object.freeze({ selected:32, nodes:128, edges:512, bytes:262_144 });
export const RETRIEVAL_PROJECTION_LIMITS = Object.freeze({ nodes:128, edges:512, bytes:262_144 });
export type RetrievalAuthority = Epoch & { runtimeEpoch:number };
export type RetrievalSnapshot = Frozen<{
  version:1; authority:RetrievalAuthority; asOf:number;
  selected:Array<{ memory:MemoryRecord; rootEventRefs:SourceRef[] }>;
  counts:{ selected:number; nodes:number; edges:number; bytes:number };
}>;
/** Local read receipt, never a portable authority or a service capability. */
export type RetrievalConsumerStamp = Frozen<{
  version:1; id:string; profile:'retrieval-refs-v1'; generation:number; scopeId:string; bootId:string;
  authority:RetrievalAuthority; applied:number; head:number; baseline:number; floor:number;
  projectionAsOf:number; readAsOf:number;
}>;
export type ConsumerRetrievalSnapshot = RetrievalSnapshot & Frozen<{ consumer:RetrievalConsumerStamp }>;

/** Copy before entering an access guard: no caller getters, proxies or callbacks. */
export function copyRetrievalConsumerHandle(value:ConsumerHandle):ConsumerHandle {
  const closed=(value:unknown,keys:string[]):Record<string,unknown>=>{
    if(types.isProxy(value))fail('INVALID_INPUT');object(value);
    if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('INVALID_INPUT');
    const descriptors=Object.getOwnPropertyDescriptors(value);
    if(Reflect.ownKeys(value).length!==keys.length || keys.some(k=>!Object.hasOwn(descriptors,k)) ||
      Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')))fail('INVALID_INPUT');
    return Object.fromEntries(keys.map(k=>[k,descriptors[k]!.value]));
  };
  const h=closed(value,['id','generation','profile','scopeId','bootId','authority']);
  const a=closed(h.authority,['generation','consentRevision','runtimeEpoch']);
  for(const k of ['id','scopeId','bootId'] as const)text(h[k],128);
  if(!Number.isSafeInteger(h.generation)||(h.generation as number)<1)fail('INVALID_INPUT');
  for(const k of ['generation','consentRevision','runtimeEpoch'] as const)
    if(!Number.isSafeInteger(a[k])||(a[k] as number)<0)fail('INVALID_INPUT');
  if(h.profile!=='retrieval-refs-v1')fail('FANOUT_PROFILE');
  return {id:h.id as string,generation:h.generation as number,profile:h.profile,scopeId:h.scopeId as string,bootId:h.bootId as string,
    authority:{generation:a.generation as number,consentRevision:a.consentRevision as number,runtimeEpoch:a.runtimeEpoch as number}};
}
export type RetrievalBinding = Readonly<{ version:1 }>;
export type RetrievalCandidate = Readonly<{ version:1 }>;
export type RetrievalHitKind = 'direct_lexical'|'shared_root';
export type RetrievalResult = Frozen<{
  version:1; projectionRevision:number; asOf:number;
  consumer?:RetrievalConsumerStamp;
  hits:Array<{ memory:MemoryRecord; rootEventRefs:SourceRef[]; kind:RetrievalHitKind }>;
}>;
