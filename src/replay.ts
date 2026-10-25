import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './store.ts';
import { extractMemory } from './pipeline.ts';
import type { InferenceAdapter } from './contracts.ts';
import { CoreError } from './validation.ts';

// A deterministic fixture, explicitly not a real model or semantic-extraction benchmark.
const provider: InferenceAdapter = {
  capabilities: { providerId:'synthetic', modelVersion:'fixture-1', input:['text'], structuredOutput:'validated', cancellation:'local_drop_only' },
  async proposeMemory({ selectedEvidence }) {
    return { kind:'claim', statement:selectedEvidence[0]!.selectedText, basis:'self_report', validFrom:null, validTo:null };
  }
};
const directory = mkdtempSync(join(tmpdir(), 'companion-core-replay-'));
const path = join(directory, 'synthetic.sqlite');
const store = new MemoryStore(path);
try {
  const scope = store.ensureScope({ tenantId:'demo', subjectId:'synthetic-user', personaId:'cheng', relationshipId:'demo-only' });
  const event = store.acceptEvent(scope, { source:'synthetic-desktop', eventKey:'one', evidence:{
    speakerId:scope.subjectId, speakerRole:'subject', mode:'self_report', selectedText:'我喜欢蓝色', occurredAt:null
  } });
  const saved = await extractMemory(store, scope, [event], provider);
  assert.equal(store.search(scope, '蓝色').length, 1);
  const delayed = store.beginJob(scope, [event]);
  const lease = store.claimLease(scope, delayed.id);
  store.propose(scope, delayed.id, lease.token, { kind:'claim', statement:'旧任务不应复活', basis:'self_report', validFrom:null, validTo:null });
  const next = store.purge(scope);
  assert.throws(() => store.publish(scope, delayed.id, lease.token), (error: unknown) => error instanceof CoreError && error.code === 'STALE_SCOPE');
  assert.equal(store.search(next, '蓝色').length, 0);
  assert.equal(store.read(next, { id:saved.id, revision:1 }), null);
  assert.equal(store.acceptEvent(next, { source:'synthetic-desktop', eventKey:'one', evidence:{
    speakerId:scope.subjectId, speakerRole:'subject', mode:'self_report', selectedText:'我喜欢蓝色', occurredAt:null
  } }).currentStatus, 'revoked');
  console.log(JSON.stringify({ status:'PASS_SYNTHETIC_REPLAY', steps:['accept','extract','publish','recall','purge','reject-late-worker','reject-ingress-replay'],
    runtime:store.diagnostics(), database:path, realModelCalls:0, productionData:false }, null, 2));
} finally { store.close(); }
