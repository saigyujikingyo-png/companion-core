import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cycleFixture, startChild } from '../teaching-cycle-fixture.ts';
import { CorpusResourceScheduler } from '../../src/corpus-resource-scheduler.ts';
const f = cycleFixture(undefined, { localSlots: 1 });
f.store.initialize(f.plan);
startChild(f);
startChild(f, 'child-1');
const worker = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
if (worker.status !== 0) throw new Error('synthetic worker exit failed');
const owner = {
    epoch: 'exited-owner',
    process: { pid: process.pid, birthId: 'synthetic-born-' + Date.now() },
    workers: [{ pid: worker.pid, birthId: 'synthetic-worker-born-' + Date.now() }],
  },
  scheduler = new CorpusResourceScheduler(f.store, owner),
  lease = await scheduler
    .execution('child-0', () => {})
    .acquire({
      jobId: 'job-a',
      attemptId: 'plan:0',
      provider: 'deepseek',
      accountRef: 'synthetic-account',
      requestBytes: 100,
      responseBytes: 200,
      expiresAt: Date.now() + 10000,
    });
lease.consumed();
lease.settle({
  localReleased: false,
  remoteUnknown: true,
  httpStatus: 429,
  retryAfterMs: 1000,
  retryAfterInvalid: false,
});
const path = join(f.base, 'reopen.json');
writeFileSync(
  path,
  JSON.stringify({
    options: { ...f.options, key: undefined, admission: undefined },
    pid: process.pid,
    workerPid: worker.pid,
    workerExit: worker.status,
  }),
);
process.stdout.write(path);
process.exit(23);
