import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrainingJournal } from './training-journal.ts';
import { tjHash } from './training-journal-format.ts';

// Offline fixture only: no trainer, model, provider, source store or credential access.
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'companion-tj0-demo-'))),
  hash = tjHash('SYNTHETIC');
const current = {
  scopeId: 'demo-scope',
  generation: '0',
  consentRevision: '1',
  runtimeId: 'demo-first',
  now: 1_000,
  expiresAt: 2_000,
  read: true,
  write: true,
  export: true,
};
const options = { directory, journalId: 'synthetic-demo', authority: () => current };
const event = (sequence: number, kind: string, data: unknown) =>
  JSON.stringify({
    version: 1,
    executionMode: 'SYNTHETIC_FIXTURE',
    datasetOrigin: 'SYNTHETIC',
    runId: 'demo-run',
    attemptId: 'demo-attempt',
    runnerId: 'fixture',
    jobId: 'fixture',
    eventId: 'event-' + sequence,
    sequence: String(sequence),
    kind,
    data,
  });
const intent = event(1, 'INTENT', {
  purpose: 'SYNTHETIC offline disk demonstration',
  requestDigest: hash,
  datasetDigest: hash,
  modelDigest: null,
  parentAttemptId: null,
  seed: '1',
  plannedSteps: '2',
});
const j = TrainingJournal.create(options);
try {
  j.append(intent);
  j.append(event(2, 'STARTED', {}), { codec: 'zstd' });
  j.append(
    event(3, 'STEP', {
      optimizerSteps: '1',
      batches: null,
      metrics: [{ name: 'loss', unit: 'ratio', value: { dtype: 'f32', shape: [], bits: '80000000' } }],
    }),
  );
  j.append(event(4, 'TERMINAL', { outcome: 'FAILED' }));
} finally {
  j.close();
}
current.runtimeId = 'demo-reopened';
const restored = TrainingJournal.open(options);
try {
  if (!restored.append(intent).duplicate || restored.status().events !== 4) throw Error('TJ_DEMO_CHECK_FAILED');
  writeFileSync(join(directory, 'declaration.jsonl'), restored.exportCanonical(), { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      result: 'TJ0_SYNTHETIC_DISK_PASS',
      events: restored.status().events,
      recovery: restored.status().recovery,
      assurance: 'NOT_AUTHENTICATED',
      realTrainingPerformed: false,
      modelCalls: 0,
      freshProcessProbe: 'SEPARATE_TEST',
      directory,
    }),
  );
} finally {
  restored.close();
}
