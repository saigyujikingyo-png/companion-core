import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { CorpusResourceScheduler } from '../src/corpus-resource-scheduler.ts';
import { openTeachingCycle } from '../src/teaching-cycle-store.ts';
import { HostAuthority } from '../src/wf1-storage.ts';
import { cycleFixture, startChild, syntheticOwner } from './teaching-cycle-fixture.ts';
import { fixture } from './corpus-production-fixture.ts';
import { nativeProduction, nativeQa } from './corpus-policy-v2-fixture.ts';
import { createProductionTransport, runCorpusProduction } from '../src/corpus-production-runner.ts';
import { qaFixture } from './corpus-qa-fixture.ts';
import { runQualityAudit } from '../src/corpus-qa-runner.ts';
import { openProductionJob } from '../src/corpus-production-store.ts';
import { openQualityAudit } from '../src/corpus-qa-store.ts';
import { openQualityArchive } from '../src/corpus-qa-source.ts';
import { teachingCycleSummary } from '../src/teaching-cycle-runner.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const request = (jobId: string, expiresAt = Date.now() + 5000) => ({
  jobId,
  attemptId: 'plan:0',
  provider: 'deepseek' as const,
  accountRef: 'synthetic-account',
  requestBytes: 100,
  responseBytes: 200,
  expiresAt,
});
const settle = {
  localReleased: true,
  remoteUnknown: false,
  httpStatus: 200,
  retryAfterMs: null,
  retryAfterInvalid: false,
};
test('shared capacity waits before consume, rechecks authority, and never expires a live held lease', async () => {
  const f = cycleFixture(undefined, { localSlots: 1 });
  f.store.initialize(f.plan);
  startChild(f);
  startChild(f, 'child-1');
  const scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
    a = scheduler.execution('child-0', () => {}),
    b = scheduler.execution('child-1', () => {});
  try {
    const lease = await a.acquire(request('job-a'));
    lease.consumed();
    lease.settle({ ...settle, localReleased: false, remoteUnknown: true, httpStatus: null });
    const controller = new AbortController();
    let acquired = false;
    const wait = b.acquire(request('job-b'), controller.signal).then(
      () => {
        acquired = true;
      },
      (e) => {
        assert.equal(e.name, 'AbortError');
      },
    );
    await delay(65);
    assert.equal(acquired, false);
    assert.equal(f.store.snapshot()!.leases.length, 1);
    assert.equal(f.store.snapshot()!.leases[0]!.local, 'HELD');
    controller.abort();
    await wait;
    assert.equal(f.store.snapshot()!.leases[0]!.remote, 'UNKNOWN');
  } finally {
    f.store.close();
  }
});

test('post-wait source revoke denies the next lease and leaves its child attempt unconsumed', async () => {
  const f = cycleFixture(undefined, { localSlots: 1 });
  f.store.initialize(f.plan);
  startChild(f);
  startChild(f, 'child-1');
  let allowed = true;
  const scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
    a = scheduler.execution('child-0', () => {}),
    b = scheduler.execution('child-1', () => {
      if (!allowed) throw new Error('synthetic source revoked');
    });
  try {
    const lease = await a.acquire(request('job-a'));
    const waiting = b.acquire(request('job-b'));
    const rejected = assert.rejects(waiting, /source revoked/);
    allowed = false;
    lease.abandon(true);
    await rejected;
    assert.equal(f.store.snapshot()!.leases.length, 1);
  } finally {
    f.store.close();
  }
});

test('durable RetryAfter applies to another job after reopen; original operation remains once-only', async () => {
  const f = cycleFixture();
  f.store.initialize(f.plan);
  startChild(f);
  startChild(f, 'child-1');
  const scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
    lease = await scheduler.execution('child-0', () => {}).acquire(request('job-a'));
  lease.consumed();
  lease.settle({ ...settle, httpStatus: 429, retryAfterMs: 100 });
  const notBefore = f.store.snapshot()!.cooldowns[0]!.until!;
  f.store.close();
  const store = openTeachingCycle({ ...f.options, mode: 'resume' }),
    next = new CorpusResourceScheduler(store, syntheticOwner('next-owner'));
  try {
    await assert.rejects(next.execution('child-0', () => {}).acquire(request('job-a')), { code: 'TC_ONCE' });
    const b = await next.execution('child-1', () => {}).acquire(request('job-b'));
    assert.ok(store.snapshot()!.leases.find((l) => l.id === b.id)!.acquiredAt >= notBefore);
    b.abandon(true);
  } finally {
    store.close();
  }
});

test('real exited owner reclamation rejects epoch/PID birth/worker mismatch and releases only LOCAL after RetryAfter', async () => {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/teaching-resource-worker.mjs', import.meta.url))],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  assert.equal(child.status, 23, child.stderr);
  const saved = JSON.parse(readFileSync(child.stdout.trim(), 'utf8')),
    options = {
      ...saved.options,
      key: Buffer.alloc(32, 71),
      admission: () => ({ planDigest: saved.options.spec.planDigest, sourceAllowed: true, retainAllowed: true }),
    },
    store = openTeachingCycle({ ...options, mode: 'resume' }),
    scheduler = new CorpusResourceScheduler(store, syntheticOwner('surviving-owner')),
    old = store.snapshot()!.leases[0]!;
  const proof = (owner: any) => ({
    version: 'TeachingLocalReclaim/0.1' as const,
    owner,
    processExited: true as const,
    workersExited: true as const,
    resourcesReclaimed: true as const,
    observedAt: Date.now(),
  });
  try {
    for (const mutate of [
      (o: any) => {
        o.epoch = 'wrong-epoch';
      },
      (o: any) => {
        o.process.birthId = 'reused-pid-birth';
      },
      (o: any) => {
        o.workers = [];
      },
    ])
      await assert.rejects(
        scheduler.reclaim(old.id, async (owner) => {
          mutate(owner);
          return proof(owner);
        }),
        { code: 'TC_RECLAIM_PROOF' },
      );
    await assert.rejects(
      scheduler.reclaim(old.id, async (owner) => ({ ...proof(owner), resourcesReclaimed: false as true })),
      { code: 'TC_RECLAIM_PROOF' },
    );
    await scheduler.reclaim(old.id, async (owner) => {
      assert.equal(owner.process.pid, saved.pid);
      assert.equal(child.status, 23);
      assert.equal(owner.workers[0]!.pid, saved.workerPid);
      assert.equal(saved.workerExit, 0);
      return proof(owner);
    });
    assert.equal(store.snapshot()!.leases[0]!.local, 'RECLAIMED');
    assert.equal(store.snapshot()!.leases[0]!.remote, 'UNKNOWN');
    await assert.rejects(scheduler.execution('child-0', () => {}).acquire(request('job-a')), { code: 'TC_ONCE' });
    const b = await scheduler.execution('child-1', () => {}).acquire(request('job-b'));
    assert.ok(
      store.snapshot()!.leases.find((l) => l.id === b.id)!.acquiredAt >= store.snapshot()!.cooldowns[0]!.until!,
    );
    b.abandon(true);
  } finally {
    store.close();
  }
});

for (const kind of ['production', 'qa'] as const)
  test(
    kind + ' final parent send gate rejects a separately committed pause after check with zero native fetch',
    async () => {
      const f = cycleFixture();
      f.store.initialize(f.plan);
      startChild(f);
      const scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
        base = scheduler.execution('child-0', () => {}),
        other = new HostAuthority(f.options.authorityPath, f.spec.cycleId),
        native = kind === 'production' ? nativeProduction() : nativeQa();
      const execution = {
        ...base,
        authorizeSend: <T>(send: () => T) => {
          other.control('PAUSED');
          return base.authorizeSend(send);
        },
      };
      if (kind === 'production') {
        const p = fixture(4, undefined, true);
        try {
          const result = await runCorpusProduction(p.spec, {
            store: p.store,
            objective: p.objective,
            registry: p.registry,
            transport: native.transport as ReturnType<typeof nativeProduction>['transport'],
            execution,
          });
          assert.equal(result.status, 'FENCED');
          assert.equal(native.calls.length, 0);
        } finally {
          p.store.close();
          f.store.close();
        }
      } else {
        const q = await qaFixture(4, undefined, false, undefined, true);
        try {
          const result = await runQualityAudit(q.spec, {
            store: q.store,
            source: q.source,
            selection: q.selection,
            objective: q.objective,
            transport: native.transport as ReturnType<typeof nativeQa>['transport'],
            execution,
          });
          assert.equal(result.status, 'FENCED');
          assert.equal(native.calls.length, 0);
        } finally {
          q.store.close();
          q.source.close();
          f.store.close();
        }
      }
    },
  );

for (const status of ['PAUSED', 'REVOKED'] as const)
  test('cycle ' + status + ' prevents resource admission', async () => {
    const f = cycleFixture();
    f.store.initialize(f.plan);
    startChild(f);
    f.store.control(status);
    try {
      await assert.rejects(
        new CorpusResourceScheduler(f.store, syntheticOwner()).execution('child-0', () => {}).acquire(request('job-a')),
      );
    } finally {
      f.store.close();
    }
  });

test('QA rechecks its own source grant inside the composed final send window', async () => {
  const f = cycleFixture();
  f.store.initialize(f.plan);
  startChild(f);
  const q = await qaFixture(4, undefined, false, undefined, true),
    scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
    base = scheduler.execution('child-0', () => {}),
    native = nativeQa(),
    execution = {
      ...base,
      authorizeSend: <T>(send: () => T) => {
        q.admission.sourceAllowed = false;
        return base.authorizeSend(send);
      },
    };
  try {
    const result = await runQualityAudit(q.spec, {
      store: q.store,
      source: q.source,
      selection: q.selection,
      objective: q.objective,
      transport: native.transport,
      execution,
    });
    assert.equal(result.status, 'FENCED');
    assert.equal(native.calls.length, 0);
  } finally {
    q.store.close();
    q.source.close();
    f.store.close();
  }
});

test('native fetch ignoring abort retains LOCAL occupancy; late completion cannot change UNKNOWN or resend', async () => {
  const f = cycleFixture(undefined, { localSlots: 1 });
  f.store.initialize(f.plan);
  startChild(f);
  const p = fixture(4, undefined, true),
    scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
    controller = new AbortController(),
    pending = deferred<Response>(),
    entered = deferred<void>();
  let sends = 0;
  const transport = createProductionTransport(
    { deepseek: 'SYNTHETIC_NOT_A_CREDENTIAL' },
    {
      fetch: async () => {
        sends++;
        entered.resolve(undefined);
        return pending.promise;
      },
    },
  );
  try {
    const operation = runCorpusProduction(p.spec, {
      store: p.store,
      objective: p.objective,
      registry: p.registry,
      transport,
      signal: controller.signal,
      execution: scheduler.execution('child-0', () => {}),
    });
    await entered.promise;
    controller.abort();
    const result = await operation;
    assert.equal(result.status, 'FENCED');
    const settled = f.store.snapshot()!.leases[0]!;
    assert.equal(settled.local, 'HELD');
    assert.equal(settled.remote, 'UNKNOWN');
    pending.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    await delay(20);
    assert.deepEqual(f.store.snapshot()!.leases[0], settled);
    await runCorpusProduction(p.spec, {
      store: p.store,
      objective: p.objective,
      registry: p.registry,
      transport,
      execution: scheduler.execution('child-0', () => {}),
    });
    assert.equal(sends, 1);
  } finally {
    p.store.close();
    f.store.close();
  }
});

for (const kind of ['production', 'qa'] as const)
  for (const status of [200, 429])
    test(
      kind +
        ' process exit between parent resource settlement and child ' +
        status +
        ' commit preserves once and shared backpressure',
      async () => {
        const child = spawnSync(
          process.execPath,
          [fileURLToPath(new URL('./fixtures/teaching-settle-worker.mjs', import.meta.url)), kind, String(status)],
          { encoding: 'utf8', windowsHide: true, timeout: 30000 },
        );
        assert.equal(child.status, 29, child.stderr);
        const saved = JSON.parse(readFileSync(child.stdout.trim(), 'utf8')),
          options = {
            ...saved.cycleOptions,
            key: Buffer.alloc(32, 71),
            admission: () => ({
              planDigest: saved.cycleOptions.spec.planDigest,
              sourceAllowed: true,
              retainAllowed: true,
            }),
          },
          store = openTeachingCycle({ ...options, mode: 'resume' }),
          scheduler = new CorpusResourceScheduler(store, syntheticOwner('settle-recovery')),
          execution = scheduler.execution('child-0', () => {});
        try {
          const parent = store.snapshot()!.leases[0]!;
          assert.equal(parent.remote, 'SETTLED');
          assert.equal(parent.local, 'RELEASED');
          if (status === 429) assert.ok(store.snapshot()!.cooldowns[0]!.until);
          if (kind === 'production') {
            const c = saved.child,
              p = openProductionJob({
                ...c.options,
                key: Buffer.alloc(32, 73),
                mode: 'resume',
                admission: () => ({
                  registryDigest: c.options.spec.registryDigest,
                  sourceAllowed: true,
                  retainAllowed: true,
                  purposes: c.purposes,
                }),
              }),
              native = nativeProduction();
            try {
              await runCorpusProduction(p.spec, {
                store: p,
                registry: c.registry,
                objective: c.objective,
                transport: native.transport,
                execution,
              });
              assert.equal(native.calls.length, 0);
              const a = p.snapshot()!.attempts[0]!;
              assert.equal(a.settlementSource, 'RECOVERY_UNKNOWN');
              assert.equal(a.result, null);
              assert.equal(p.snapshot()!.items.filter((i) => i.status === 'ACCEPTED').length, 0);
            } finally {
              p.close();
            }
          } else {
            const c = saved.child,
              source = openQualityArchive({
                ...c.archiveOptions,
                key: Buffer.alloc(32, 73),
                admission: () => c.admission,
              }),
              q = openQualityAudit({
                ...c.options,
                key: Buffer.alloc(32, 87),
                mode: 'resume',
                admission: () => c.admission,
                sourceCheck: source.check,
              }),
              native = nativeQa();
            try {
              await runQualityAudit(q.spec, {
                store: q,
                source,
                selection: c.selection,
                objective: c.objective,
                transport: native.transport,
                execution,
              });
              assert.equal(native.calls.length, 0);
              assert.equal(q.snapshot()!.attempts[0]!.settlementSource, 'RECOVERY_UNKNOWN');
              assert.equal(q.snapshot()!.attempts[0]!.result, null);
              assert.equal(q.snapshot()!.items.filter((i) => i.status === 'PASS').length, 0);
            } finally {
              q.close();
              source.close();
            }
          }
          const b = await scheduler.execution('child-1', () => {}).acquire(request('independent-next-job'));
          if (status === 429)
            assert.ok(
              store.snapshot()!.leases.find((l) => l.id === b.id)!.acquiredAt >= store.snapshot()!.cooldowns[0]!.until!,
            );
          b.abandon(true);
        } finally {
          store.close();
        }
      },
    );

for (const kind of ['production', 'qa'] as const)
  for (const status of ['PAUSED', 'REVOKED'] as const)
    for (const window of ['before-gate', 'inside-lock'] as const)
      test(kind + ' ' + status + ' ' + window + ' is linearized with child acceptance', async () => {
        const f = cycleFixture();
        f.store.initialize(f.plan);
        startChild(f);
        const scheduler = new CorpusResourceScheduler(f.store, syntheticOwner()),
          base = scheduler.execution('child-0', () => {}),
          control = new HostAuthority(f.options.authorityPath, f.spec.cycleId),
          c =
            kind === 'production' ? fixture(4, undefined, true) : await qaFixture(4, undefined, false, undefined, true);
        let attempted = false,
          acknowledged = false,
          busy = false;
        const ready = () =>
          c.store.snapshot()!.attempts.some((a) => a.operation === 'review' && a.settledAtMs !== null);
        const execution = {
          ...base,
          authorizeCommit: <T>(commit: () => T) => {
            if (window === 'before-gate' && !attempted && ready()) {
              attempted = true;
              control.control(status);
              acknowledged = true;
            }
            return base.authorizeCommit(commit);
          },
        };
        const apply = c.store.apply.bind(c.store) as (kind: any, data: any) => void;
        (c.store as any).apply = (event: string, data: any) => {
          if (
            window === 'inside-lock' &&
            !attempted &&
            ((event === 'ITEM' && data.item.status === 'ACCEPTED') ||
              (event === 'VERDICT' && data.item.status === 'PASS'))
          ) {
            attempted = true;
            assert.throws(() => control.control(status), { code: 'WF1_HOST_BUSY' });
            busy = true;
          }
          return apply(event, data);
        };
        try {
          let result: { status: string };
          if (kind === 'production') {
            const p = c as ReturnType<typeof fixture>,
              native = nativeProduction();
            result = await runCorpusProduction(p.spec, {
              store: p.store,
              objective: p.objective,
              registry: p.registry,
              transport: native.transport,
              execution,
            });
          } else {
            const q = c as Awaited<ReturnType<typeof qaFixture>>,
              native = nativeQa();
            result = await runQualityAudit(q.spec, {
              store: q.store,
              source: q.source,
              selection: q.selection,
              objective: q.objective,
              transport: native.transport,
              execution,
            });
          }
          assert.equal(attempted, true);
          const accepted = c.store.snapshot()!.items.filter((i) => ['ACCEPTED', 'PASS'].includes(i.status)).length;
          if (window === 'before-gate') {
            assert.equal(acknowledged, true);
            assert.equal(accepted, 0, 'no child qualification after successful parent control ACK');
            assert.equal(result.status, 'FENCED');
          } else {
            assert.equal(busy, true);
            assert.equal(acknowledged, false);
            assert.equal(result.status, 'COMPLETED');
            assert.equal(accepted, 4);
            control.control(status);
            acknowledged = true;
            assert.equal(acknowledged, true, 'control can ACK after the authorized commit window closes');
          }
        } finally {
          c.store.close();
          if ('source' in c) c.source.close();
          f.store.close();
        }
      });

test('abandoned reservations are not presented as actual child API consumption', async () => {
  const f = cycleFixture();
  f.store.initialize(f.plan);
  startChild(f);
  try {
    const lease = await new CorpusResourceScheduler(f.store, syntheticOwner())
      .execution('child-0', () => {})
      .acquire(request('never-consumed'));
    lease.abandon(true);
    const summary = teachingCycleSummary(f.store.snapshot()!);
    assert.equal(summary.resources.leases, 1);
    assert.equal(summary.resources.localHeld, 0);
    assert.equal(Object.hasOwn(summary.resources, 'consumed'), false);
  } finally {
    f.store.close();
  }
});
