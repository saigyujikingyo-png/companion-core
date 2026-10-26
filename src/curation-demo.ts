import assert from 'node:assert/strict';
import { MemoryStore } from './store.ts';
import { CurationService } from './curation.ts';
import type { CurationRequest } from './curation-rules.ts';

// Fresh RAM database only. This deterministic declaration fixture never calls a
// model, reads a user database, creates a training job or prints private manifests.
const store = new MemoryStore(':memory:', { clock:{ wall:() => 100_000, monotonic:() => 0 } });
try {
  const identity = { tenantId:'demo', subjectId:'synthetic-user', personaId:'test', relationshipId:'demo' };
  const scope = store.setLearningConsent(store.ensureScope(identity), true);
  const memories = [1000,3000].map((occurredAt,index) => {
    const event = store.acceptEvent(scope, { source:'synthetic', eventKey:'demo-' + index, evidence:{
      speakerId:identity.subjectId, speakerRole:'subject', mode:'self_report', selectedText:'SYNTHETIC selected text ' + index, occurredAt } });
    const job = store.beginJob(scope,[event]), lease = store.claimLease(scope,job.id);
    store.propose(scope,job.id,lease.token,{ kind:'claim', statement:'SYNTHETIC derived statement ' + index,
      basis:'self_report', validFrom:null, validTo:null });
    return { id:store.publish(scope,job.id,lease.token).id, revision:1 };
  });
  const service = new CurationService(store,{ version:1, curationVersion:'l1a-1', annotationVersion:'declared-1', selectionVersion:'synthetic-1', cutoff:2000 });
  const binding = service.bind({ epoch:scope, publishedRefs:memories });
  const original:CurationRequest['rows'][number] = { memoryIndex:0, rootIndex:0, variant:'original', language:'unknown', split:'train',
    annotation:{ origin:'synthetic', claimKey:null, polarity:'unspecified', condition:'', quotation:'direct', quotationSubject:null, uncertain:false } };
  const result = service.lint(binding,JSON.stringify({ version:1, rows:[original,
    { ...original, variant:'translation', language:'en', derivedText:'SYNTHETIC unverified translation' },
    { ...original, memoryIndex:1, split:'eval' }, original] }));
  assert.deepEqual(result.report.counts,{ selected:2, roots:2, groups:2, inputRows:4, admitted:3, train:2, eval:1, quarantined:0, duplicates:1 });
  assert.deepEqual(service.revalidate(binding,result.candidate).report,result.report);
  console.log(JSON.stringify({ status:result.report.status, counts:result.report.counts, codes:result.report.codes,
    quality:result.report.quality, trainingQuality:result.report.trainingQuality, evaluationQuality:result.report.evaluationQuality,
    realModelCalls:0, productionData:false },null,2));
} finally { store.close(); }
