import { isDeepStrictEqual } from 'node:util';
import { RetrievalService } from '../../src/retrieval.ts';
import { RETRIEVAL_LIMITS } from '../../src/retrieval-types.ts';
import type { ConsumerRetrievalSnapshot } from '../../src/retrieval-types.ts';
import { fail } from '../../src/validation.ts';
import { bm25WorkingReservation, rankBm25 } from './bm25.ts';
import type { SyntheticFixture } from './fixture.ts';

const identity=(snapshot:ConsumerRetrievalSnapshot)=>{
  const {readAsOf:_,...consumer}=snapshot.consumer;
  return {authority:snapshot.authority,selected:snapshot.selected,consumer};
};

/** Research driver only. afterRanking is a synchronous fault-injection seam used
 * by mechanism tests; never supplied by the formal runner or the pure scorer.
 */
export function compareSyntheticQuery(fixture:SyntheticFixture,query:string,afterRanking?:()=>void) {
  const {store,handle,refs,scope}=fixture,before=store.consumerRetrievalSnapshot(handle);
  // Freeze publication order, not random UUID order, for BOTH algorithms.
  // Require exactly the complete current consumer pool, never a filtered subset.
  if(before.selected.length!==refs.length)fail('RESEARCH_SELECTION_CHANGED');
  const selected=refs.map(ref=>{
    const item=before.selected.find(item=>item.memory.id===ref.id&&item.memory.revision===ref.revision);
    if(!item)fail('RESEARCH_SELECTION_CHANGED');return item;
  });
  if(new Set(refs.map(ref=>ref.id)).size!==refs.length)fail('RESEARCH_SELECTION_CHANGED');
  const statements=selected.map(item=>item.memory.statement);
  const workingBytes=bm25WorkingReservation(statements,query);
  // Store already enforces its full source closure/node/edge budget. Retained
  // consumer snapshot serialization is separately charged with BM25 work.
  const snapshotBytes=Buffer.byteLength(JSON.stringify(before),'utf8');
  // Store/fanout accept only nonnegative safe-integer times. Reserve their
  // longest legal decimal forms; counts.bytes can also grow with those fields.
  const maxClockBytes=String(Number.MAX_SAFE_INTEGER).length;
  const currentSnapshotReservedBytes=snapshotBytes+maxClockBytes-String(before.asOf).length
    +maxClockBytes-String(before.consumer.readAsOf).length
    +String(RETRIEVAL_LIMITS.bytes).length-String(before.counts.bytes).length;
  if(workingBytes>RETRIEVAL_LIMITS.bytes-snapshotBytes-currentSnapshotReservedBytes)fail('BM25_WORKING_LIMIT');
  const epoch={id:scope.id,generation:scope.generation,consentRevision:scope.consentRevision};
  const service=new RetrievalService(store),binding=service.bind({epoch,publishedRefs:refs});
  service.refresh(binding);
  const candidate=service.query(binding,{text:query,limit:8}).candidate;
  const ranked=rankBm25(statements,query,8);
  afterRanking?.();
  const resolved=service.resolve(binding,candidate);
  const current=store.consumerRetrievalSnapshot(handle);
  if(current.asOf<before.asOf||current.consumer.readAsOf<before.consumer.readAsOf)fail('RESEARCH_CLOCK_ROLLBACK');
  if(!isDeepStrictEqual(identity(before),identity(current)))fail('RESEARCH_CURRENTNESS_CHANGED');
  const currentSnapshotBytes=Buffer.byteLength(JSON.stringify(current),'utf8');
  const totalBytes=snapshotBytes+currentSnapshotBytes+workingBytes;
  if(currentSnapshotBytes>currentSnapshotReservedBytes||totalBytes>RETRIEVAL_LIMITS.bytes)fail('BM25_WORKING_LIMIT');
  // No async/caller code between the complete currentness check and mapping.
  const ar0=resolved.hits.map(hit=>{
    const ordinal=refs.findIndex(ref=>ref.id===hit.memory.id&&ref.revision===hit.memory.revision);
    if(ordinal<0)fail('RESEARCH_SELECTION_CHANGED');return {ordinal,kind:hit.kind};
  });
  const bm25=ranked.map(hit=>({ordinal:hit.ordinal,score:hit.score}));
  return {ar0,bm25,budget:{snapshotBytes,currentSnapshotReservedBytes,currentSnapshotBytes,retainedSnapshotCopies:2,workingBytes,totalBytes}};
}
