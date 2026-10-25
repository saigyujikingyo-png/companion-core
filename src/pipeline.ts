import type { Epoch, InferenceAdapter, Receipt, SourceRef } from './contracts.ts';
import { MemoryStore } from './store.ts';

/** Provider-neutral extraction. The authority freezes sources before the async call. */
export async function extractMemory(store: MemoryStore, epoch: Epoch, refs: SourceRef[], provider: InferenceAdapter,
  signal = new AbortController().signal): Promise<Receipt> {
  signal.throwIfAborted();
  const job = store.beginJob(epoch, refs);
  const lease = store.claimLease(epoch, job.id);
  const selectedEvidence = store.jobEvidence(epoch, job.id, lease.token);
  const proposal = await provider.proposeMemory({ selectedEvidence, signal });
  signal.throwIfAborted();
  store.propose(epoch, job.id, lease.token, proposal);
  return store.publish(epoch, job.id, lease.token);
}
