import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './store.ts';
import { GrowthJournalService, parseGrowthArchive, renderGrowthArchive } from './growth-journal.ts';
import { GROWTH_SCENARIOS } from './growth-journal-synthetic.ts';

const store = new MemoryStore(':memory:', { clock: { wall: () => 100000, monotonic: () => 0 } });
try {
  const scope = store.setLearningConsent(
    store.ensureScope({
      tenantId: 'synthetic',
      subjectId: 'subject',
      personaId: 'journal-demo',
      relationshipId: 'demo',
    }),
    true,
  );
  const epoch = { id: scope.id, generation: scope.generation, consentRevision: scope.consentRevision };
  const root = store.acceptEvent(epoch, {
    source: 'synthetic',
    eventKey: 'journal-demo',
    evidence: {
      speakerId: 'subject',
      speakerRole: 'subject',
      mode: 'self_report',
      selectedText: 'SYNTHETIC_PRIVATE_SELECTED_TEXT',
      occurredAt: 1000,
    },
  });
  const job = store.beginJob(epoch, [root]),
    lease = store.claimLease(epoch, job.id);
  store.propose(epoch, job.id, lease.token, {
    kind: 'claim',
    basis: 'self_report',
    statement: 'SYNTHETIC_PRIVATE_STATEMENT',
    validFrom: null,
    validTo: null,
  });
  const memory = { id: store.publish(epoch, job.id, lease.token).id, revision: 1 };
  const policy = JSON.stringify({
    version: 1,
    curationVersion: 'synthetic',
    annotationVersion: 'synthetic',
    selectionVersion: 'synthetic',
    cutoff: 2000,
  });
  const service = new GrowthJournalService(store, policy),
    journal = service.bind({ epoch, publishedRefs: [memory] });
  const entry = service.plan(journal, { id: 'actual-curation-check', kind: 'curation_lint' });
  const result = service.runCuration(
    journal,
    entry,
    JSON.stringify({
      version: 1,
      rows: [
        {
          memoryIndex: 0,
          rootIndex: 0,
          variant: 'original',
          language: 'unknown',
          split: 'train',
          annotation: {
            origin: 'synthetic',
            claimKey: null,
            polarity: 'unspecified',
            condition: '',
            quotation: 'direct',
            quotationSubject: null,
            uncertain: false,
          },
        },
      ],
    }),
  );
  assert.equal(result.attempt, 'COMPLETED');
  assert.equal(result.actual.lintCompleted, true);
  assert.equal(result.actual.revalidationCompleted, true);
  for (const scenario of GROWTH_SCENARIOS) {
    const synthetic = service.plan(journal, { id: `simulation-${scenario}`, kind: 'synthetic_replay' });
    service.runSynthetic(journal, synthetic, scenario);
  }
  const view = service.bindView(journal, { epoch }),
    json = service.exportJson(view),
    md = service.exportMarkdown(view);
  assert.doesNotMatch(json + md, /SYNTHETIC_PRIVATE_|speakerId|selectedText|statement/);
  // New synthetic runtime artifacts only, outside the source/OneDrive tree; retained for inspection.
  const directory = mkdtempSync(join(tmpdir(), 'companion-growth-journal-')),
    jsonPath = join(directory, 'journal.json'),
    markdownPath = join(directory, 'journal.md');
  writeFileSync(jsonPath, json + '\n', { flag: 'wx' });
  writeFileSync(markdownPath, md + '\n', { flag: 'wx' });
  const reopened = readFileSync(jsonPath, 'utf8');
  assert.equal(parseGrowthArchive(reopened).assurance, 'NOT_AUTHENTICATED');
  assert.equal(renderGrowthArchive(reopened), md);
  store.revoke(epoch, root);
  assert.throws(() => service.read(view));
  assert.equal(parseGrowthArchive(reopened).assurance, 'NOT_AUTHENTICATED');
  console.log(
    JSON.stringify({
      status: 'GROWTH_JOURNAL_PASS',
      actualCoreOperations: ['curation_lint', 'curation_revalidate'],
      actualParametricTraining: 0,
      realModelCalls: 0,
      semanticQuality: 'NOT_EVALUATED',
      syntheticScenarios: GROWTH_SCENARIOS.length,
      entries: 8,
      archiveAssurance: 'NOT_AUTHENTICATED',
      sourceRevocationRejected: true,
      journalState: 'RAM_ONLY',
      trustedJournalRecovery: 'NOT_IMPLEMENTED',
      productionData: false,
      jsonPath,
      markdownPath,
    }),
  );
} finally {
  store.close();
}
