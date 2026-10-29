import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cycleFixture, startChild, syntheticOwner } from '../teaching-cycle-fixture.ts';
import { fixture } from '../corpus-production-fixture.ts';
import { qaFixture } from '../corpus-qa-fixture.ts';
import { nativeProduction, nativeQa } from '../corpus-policy-v2-fixture.ts';
import { runCorpusProduction } from '../../src/corpus-production-runner.ts';
import { runQualityAudit } from '../../src/corpus-qa-runner.ts';
import { CorpusResourceScheduler } from '../../src/corpus-resource-scheduler.ts';
const kind = process.argv[2],
  status = Number(process.argv[3]),
  f = cycleFixture();
f.store.initialize(f.plan);
startChild(f);
startChild(f, 'child-1');
const scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
  execution = scheduler.execution('child-0', () => {}),
  child = kind === 'production' ? fixture(4, undefined, true) : await qaFixture(4, undefined, false, undefined, true);
const apply = child.store.apply.bind(child.store);
child.store.apply = (event, data) => {
  if (event === 'SETTLE') {
    const lease = f.store.snapshot().leases[0];
    if (
      lease.remote !== 'SETTLED' ||
      lease.local !== 'RELEASED' ||
      (status === 429 && !f.store.snapshot().cooldowns.length)
    )
      throw new Error('parent settlement must precede child commit');
    const path = join(f.base, 'settle-reopen.json'),
      saved = {
        kind,
        status,
        cycleOptions: { ...f.options, key: undefined, admission: undefined },
        child:
          kind === 'production'
            ? {
                options: { ...child.options, key: undefined, admission: undefined },
                registry: child.registry,
                objective: child.objective,
                purposes: child.purposes,
              }
            : {
                options: { ...child.storeOptions, key: undefined, admission: undefined, sourceCheck: undefined },
                archiveOptions: { ...child.archiveOptions, key: undefined, admission: undefined },
                selection: child.selection,
                objective: child.objective,
                admission: child.admission,
              },
      };
    writeFileSync(path, JSON.stringify(saved));
    process.stdout.write(path);
    process.exit(29);
  }
  return apply(event, data);
};
const native = (kind === 'production' ? nativeProduction : nativeQa)({
  usage: 'known',
  change: (r) => {
    if (status === 429) {
      r.status = 429;
      r.headers['retry-after'] = '1';
    }
  },
});
if (kind === 'production')
  await runCorpusProduction(child.spec, {
    store: child.store,
    objective: child.objective,
    registry: child.registry,
    transport: native.transport,
    execution,
  });
else
  await runQualityAudit(child.spec, {
    store: child.store,
    source: child.source,
    selection: child.selection,
    objective: child.objective,
    transport: native.transport,
    execution,
  });
throw new Error('settle window not reached');
