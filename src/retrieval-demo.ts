import assert from 'node:assert/strict';
import { MemoryStore } from './store.ts';
import { RetrievalService } from './retrieval.ts';
import { CoreError } from './validation.ts';

// Fresh synthetic RAM only. Do not log text, IDs, private hashes or credentials.
const store = new MemoryStore(':memory:', { clock: { wall: () => 100_000, monotonic: () => 0 } });
try {
  const scope = store.ensureScope({
    tenantId: 'demo',
    subjectId: 'synthetic-user',
    personaId: 'test',
    relationshipId: 'ar0',
  });
  const root = store.acceptEvent(scope, {
    source: 'synthetic',
    eventKey: 'one',
    evidence: {
      speakerId: 'synthetic-user',
      speakerRole: 'subject',
      mode: 'self_report',
      selectedText: 'SYNTHETIC original retained only by Store',
      occurredAt: null,
    },
  });
  const memories = ['SYNTHETIC blue memory', 'SYNTHETIC associated memory'].map((statement) => {
    const job = store.beginJob(scope, [root]),
      lease = store.claimLease(scope, job.id);
    store.propose(scope, job.id, lease.token, {
      kind: 'claim',
      statement,
      basis: 'self_report',
      validFrom: null,
      validTo: null,
    });
    return { id: store.publish(scope, job.id, lease.token).id, revision: 1 };
  });
  const service = new RetrievalService(store),
    binding = service.bind({
      epoch: { id: scope.id, generation: scope.generation, consentRevision: scope.consentRevision },
      publishedRefs: memories,
    });
  const before = store.snapshot();
  service.refresh(binding);
  const query = service.query(binding, { text: 'blue' }),
    result = service.resolve(binding, query.candidate);
  assert.deepEqual(
    result.hits.map((hit) => hit.kind),
    ['direct_lexical', 'shared_root'],
  );
  assert.deepEqual(store.snapshot(), before);
  assert.equal(scope.learningAllowed, false);
  store.revoke(scope, root);
  assert.throws(
    () => service.resolve(binding, query.candidate),
    (error: unknown) => error instanceof CoreError && error.code === 'STALE_SOURCE',
  );
  assert.throws(
    () => service.refresh(binding),
    (error: unknown) => error instanceof CoreError && error.code === 'UNAUTHENTICATED',
  );
  console.log(
    JSON.stringify(
      {
        status: 'AR0_CONTRACT_PASS',
        counts: { selected: 2, roots: 1, direct: 1, shared: 1, hits: 2 },
        codes: ['STALE_SOURCE', 'UNAUTHENTICATED'],
        quality: 'NOT_EVALUATED',
        durableFanout: 'NOT_IMPLEMENTED',
        realModelCalls: 0,
        productionData: false,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
