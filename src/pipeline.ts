import type { Epoch, InferenceAdapter, Job, Receipt, SourceRef } from './contracts.ts';
import { MemoryStore } from './store.ts';
import { bounded, timeoutMs } from './runtime.ts';

/** Provider-neutral extraction. The authority freezes sources before the async call. */
export async function extractMemory(
  store: MemoryStore,
  epoch: Epoch,
  refs: SourceRef[],
  provider: InferenceAdapter,
  signal = new AbortController().signal,
  options: { timeoutMs?: number } = {},
): Promise<Receipt> {
  const duration = timeoutMs(options.timeoutMs ?? 30_000);
  signal.throwIfAborted();
  const job = store.beginJob(epoch, refs);
  return extractMemoryJob(store, job, provider, signal, { timeoutMs: duration });
}

export async function extractMemoryJob(
  store: MemoryStore,
  job: Job,
  provider: InferenceAdapter,
  signal = new AbortController().signal,
  options: { timeoutMs?: number } = {},
): Promise<Receipt> {
  const epoch = job.epoch;
  let token: string | undefined;
  try {
    const duration = timeoutMs(options.timeoutMs ?? 30_000);
    signal.throwIfAborted();
    const lease = store.claimLease(epoch, job.id, Math.min(duration + 1000, 300_000));
    token = lease.token;
    const selectedEvidence = store.jobEvidence(epoch, job.id, token);
    const proposal = await bounded(signal, duration, (inner) =>
      provider.proposeMemory({ selectedEvidence, signal: inner }),
    );
    signal.throwIfAborted();
    store.propose(epoch, job.id, token, proposal);
    return store.publish(epoch, job.id, token);
  } catch (error) {
    store.abandonJob(job, token);
    throw error;
  }
}
