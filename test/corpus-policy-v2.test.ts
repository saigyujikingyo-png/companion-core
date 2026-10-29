import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash } from '../src/wf1-json.ts';
import { fixture, mock, run } from './corpus-production-fixture.ts';
import { qaFixture } from './corpus-qa-fixture.ts';
import { nativeProduction, nativeQa } from './corpus-policy-v2-fixture.ts';
import { runCorpusProduction, verifyProduction } from '../src/corpus-production-runner.ts';
import { openProductionJob } from '../src/corpus-production-store.ts';
import {
  validateProductionSpec,
  PRODUCTION_DIGEST,
  PRODUCTION_V2_DIGEST,
  worstCalls,
  attemptReservation,
} from '../src/corpus-production-types.ts';
import { runQualityAudit, verifyQualityAudit, exportQualityAudit, readQualityIndex } from '../src/corpus-qa-runner.ts';
import { openQualityAudit } from '../src/corpus-qa-store.ts';
import { openQualityArchive } from '../src/corpus-qa-source.ts';
import { QA_V2_PROFILE_DIGEST, validateAuditSpec } from '../src/corpus-qa-types.ts';

const runV2 = (f: ReturnType<typeof fixture>, m: ReturnType<typeof nativeProduction>) =>
  runCorpusProduction(f.spec, { store: f.store, objective: f.objective, registry: f.registry, transport: m.transport });
test('explicit v2 profile/config; no missing field defaults or v1 admission changes', () => {
  const f = fixture(8, undefined, true);
  try {
    assert.equal(validateProductionSpec(f.spec).budgetMicroUsd, null);
    assert.equal(attemptReservation(f.spec), null);
    assert.equal(worstCalls(f.spec), 11);
    for (const patch of [
      { version: 'CorpusProduction/0.1' },
      { version: undefined },
      { profileDigest: PRODUCTION_DIGEST },
      { budgetMicroUsd: 1 },
      { execution: undefined },
      { execution: { ...f.spec.execution, totalConcurrency: 0 } },
      { unitCount: 196 },
    ])
      assert.throws(() => validateProductionSpec({ ...f.spec, ...patch }));
    const high = {
      ...f.spec,
      price: { snapshotId: 'high', inputMicroUsdPerMillion: 1000000000, completionMicroUsdPerMillion: 1000000000 },
    };
    assert.ok(attemptReservation(validateProductionSpec(high))! > 10000000);
    const { execution: _, ...old } = high;
    assert.throws(() =>
      validateProductionSpec({
        ...old,
        version: 'CorpusProduction/0.1',
        profileDigest: PRODUCTION_DIGEST,
        budgetMicroUsd: 10000000,
      }),
    );
    assert.notEqual(PRODUCTION_V2_DIGEST, PRODUCTION_DIGEST);
  } finally {
    f.store.close();
  }
});
for (const usage of ['known', 'missing', 'null'] as const)
  test('v2 ' + usage + ' native usage production/self-review is durable and cold-verifiable', async () => {
    const f = fixture(8, undefined, true),
      m = nativeProduction({ usage });
    try {
      const s = await runV2(f, m);
      assert.equal(s.status, 'COMPLETED', JSON.stringify(s));
      assert.equal(s.counts.uniqueEligible, 8);
      assert.equal(s.cost.reservedWorstCaseMicroUsd, null);
      assert.equal(s.calls.usageUnknown, usage === 'known' ? 0 : 5);
      const state = verifyProduction(f.store),
        row = JSON.parse(f.store.read(state.items[0]!.rowRef!).toString());
      assert.equal(row.version, 'QualifiedProductionItem/0.2');
      assert.equal(row.teacher.usageStatus, usage === 'known' ? 'PROVIDER_REPORTED' : 'UNREPORTED');
      assert.equal(row.reviewer.usageStatus, row.teacher.usageStatus);
      if (usage !== 'known') assert.equal(row.teacher.usage, null);
      const frozen = canonical(state),
        ledger = hash(readFileSync(join(f.options.runtimeRoot, 'corpus-production.sqlite')));
      f.store.close();
      const cold = openProductionJob({ ...f.options, mode: 'inspect' });
      try {
        assert.equal(canonical(verifyProduction(cold)), frozen);
      } finally {
        cold.close();
      }
      assert.equal(hash(readFileSync(join(f.options.runtimeRoot, 'corpus-production.sqlite'))), ledger);
    } finally {
      f.store.close();
    }
  });
test('v1 missing usage retains old global fence and canonical cold bytes', async () => {
  const f = fixture(8),
    m = mock(f, { missingUsage: 0 });
  try {
    const s = await run(f, m);
    assert.equal(s.status, 'FENCED');
    assert.ok(s.failureCodes.CPR_USAGE_UNKNOWN);
    const frozen = canonical(f.store.snapshot());
    f.store.close();
    const cold = openProductionJob({ ...f.options, mode: 'inspect' });
    try {
      assert.equal(canonical(cold.snapshot()), frozen);
      assert.ok(!canonical(cold.snapshot()).includes('settlementSource'));
      assert.ok(!canonical(cold.snapshot()).includes('execution'));
    } finally {
      cold.close();
    }
  } finally {
    f.store.close();
  }
});
for (const fault of ['unknown', 'http', 'usage', 'format', '429'] as const)
  test('v2 ' + fault + ' isolates one generation without replay and finishes independent units', async () => {
    const f = fixture(8, undefined, true),
      m = nativeProduction({
        change: (r) => {
          if (r.operation !== 'candidate' || r.index !== 0) return;
          if (fault === 'unknown') throw Error('SYNTHETIC uncertain submission');
          if (fault === 'http') r.status = 503;
          if (fault === 'usage') r.envelope.usage = { prompt_tokens: 100, completion_tokens: -1 };
          if (fault === 'format') r.body = { invalid: true };
          if (fault === '429') {
            r.status = 429;
            r.headers['retry-after'] = '0';
          }
        },
      });
    try {
      const s = await runV2(f, m);
      assert.equal(s.status, 'COMPLETED', JSON.stringify(s));
      assert.equal(s.counts.uniqueEligible, 4);
      assert.equal(s.counts.quarantined, 4);
      assert.equal(m.calls.filter((c) => c.operation === 'candidate' && c.index === 0).length, 1);
      verifyProduction(f.store);
      const before = m.calls.length;
      f.store.close();
      const cold = openProductionJob({ ...f.options, mode: 'resume' });
      try {
        await runCorpusProduction(f.spec, {
          store: cold,
          objective: f.objective,
          registry: f.registry,
          transport: m.transport,
        });
        assert.equal(m.calls.length, before);
      } finally {
        cold.close();
      }
    } finally {
      f.store.close();
    }
  });
test('v2 mismatched model fences instead of accepting valid missing usage', async () => {
  const f = fixture(8, undefined, true),
    m = nativeProduction({
      change: (r) => {
        if (r.operation === 'candidate') r.envelope.model = 'wrong-model';
      },
    });
  try {
    const s = await runV2(f, m);
    assert.equal(s.status, 'FENCED');
    assert.equal(s.counts.uniqueEligible, 0);
    assert.ok(s.failureCodes.CPR_MODEL_IDENTITY);
  } finally {
    f.store.close();
  }
});
for (const control of ['PAUSED', 'REVOKED'] as const)
  test('v2 ' + control + ' still stops new sends', async () => {
    const f = fixture(8, undefined, true),
      m = nativeProduction({
        change: async (r) => {
          if (r.operation === 'candidate') {
            await Promise.resolve();
            f.store.control(control);
          }
        },
      });
    try {
      const s = await runV2(f, m);
      assert.equal(JSON.parse(readFileSync(f.options.authorityPath, 'utf8')).status, control);
      assert.equal(s.status, 'FENCED');
      assert.equal(m.calls.filter((c) => c.operation === 'candidate').length, 1);
      assert.equal(m.calls.filter((c) => c.operation === 'review').length, 0);
    } finally {
      f.store.close();
    }
  });
test('exclusive resume records RECOVER_UNKNOWN with no fabricated service time or resend', async () => {
  const f = fixture(8, undefined, true),
    m = nativeProduction(),
    apply = f.store.apply.bind(f.store);
  let crash = false;
  f.store.apply = (kind, data) => {
    if (kind === 'SETTLE' && String((data as any).id).startsWith('generation:')) crash = true;
    if (crash) throw Error('SYNTHETIC crash before SETTLE');
    apply(kind, data);
  };
  try {
    await runV2(f, m);
    const pending = f.store.snapshot()!.attempts.find((a) => a.operation === 'candidate')!;
    assert.equal(pending.settledAtMs, null);
    assert.throws(() => apply('RECOVER_UNKNOWN', { id: pending.id, decidedAtMs: Date.now() - f.spec.createdAt }), {
      code: 'CPR_RECOVERY_OWNER',
    });
    f.store.close();
    const resumed = openProductionJob({ ...f.options, mode: 'resume' }),
      next = nativeProduction();
    try {
      const s = await runCorpusProduction(f.spec, {
        store: resumed,
        objective: f.objective,
        registry: f.registry,
        transport: next.transport,
      });
      assert.equal(s.status, 'COMPLETED', JSON.stringify(s));
      assert.equal(s.counts.uniqueEligible, 4);
      assert.ok(next.calls.every((c) => c.operation !== 'candidate' || c.index !== 0));
      const a = resumed.snapshot()!.attempts.find((a) => a.id === pending.id)!;
      assert.equal(a.result, null);
      assert.equal(a.serviceMs, null);
      assert.equal(s.lanes.find((l) => l.operation === 'candidate')!.serviceMs, null);
      assert.equal(a.settlementSource, 'RECOVERY_UNKNOWN');
      assert.ok(a.settledAtMs! >= a.consumedAtMs);
      assert.throws(
        () => resumed.apply('SETTLE', { id: a.id, result: null, serviceMs: 1, settledAtMs: a.settledAtMs }),
        { code: 'CPR_CAS' },
      );
      verifyProduction(resumed);
    } finally {
      resumed.close();
    }
  } finally {
    f.store.close();
  }
});
test('same-process second run cannot recover a live v2 attempt', async () => {
  const f = fixture(8, undefined, true);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve)),
    held = new Promise<void>((resolve) => (release = resolve)),
    m = nativeProduction({
      change: async (r) => {
        if (r.operation === 'plan') {
          entered();
          await held;
        }
      },
    });
  try {
    const running = runV2(f, m);
    await started;
    await assert.rejects(() => runV2(f, m), { code: 'CPR_OWNER' });
    assert.equal(f.store.snapshot()!.attempts[0]!.settledAtMs, null);
    release();
    assert.equal((await running).status, 'COMPLETED');
  } finally {
    release?.();
    f.store.close();
  }
});
for (const usage of ['known', 'missing'] as const)
  test(
    'production v2 ' +
      usage +
      ' usage flows through synthetic token receipts/export to independent QA and cold verification',
    async () => {
      const f = await qaFixture(8, undefined, false, hash('qa v2 synthetic'), usage === 'known' ? 'known' : true),
        m = nativeQa({ usage });
      try {
        assert.equal(f.old.spec.version, 'CorpusProduction/0.2');
        assert.equal(f.spec.profileDigest, QA_V2_PROFILE_DIGEST);
        assert.throws(() => validateAuditSpec({ ...f.spec, execution: undefined }));
        const s = await runQualityAudit(f.spec, {
          store: f.store,
          source: f.source,
          selection: f.selection,
          objective: f.objective,
          transport: m.transport,
        });
        assert.equal(s.status, 'COMPLETED', JSON.stringify(s));
        assert.equal(s.counts.PASS, 8);
        assert.equal(s.calls.usageUnknown, usage === 'known' ? 0 : 3);
        const exported = exportQualityAudit(f.store, f.source);
        assert.equal(exported.export.eligibleRows, 8);
        assert.equal(readQualityIndex(f.store, f.store.snapshot()!.indexRef!).entries.length, 8);
        const frozen = canonical(f.store.snapshot());
        f.store.close();
        f.source.close();
        const source = openQualityArchive(f.archiveOptions),
          cold = openQualityAudit({ ...f.storeOptions, sourceCheck: source.check, mode: 'inspect' });
        try {
          assert.equal(canonical(verifyQualityAudit(cold, source).state), frozen);
        } finally {
          cold.close();
          source.close();
        }
      } finally {
        f.store.close();
        f.source.close();
      }
    },
  );
for (const fault of ['unknown', 'invalid-usage', 'http'] as const)
  test('QA v2 ' + fault + ' holds only affected review batch', async () => {
    const f = await qaFixture(8, undefined, false, hash('qa v2 synthetic'), true),
      m = nativeQa({
        change: (r) => {
          if (r.operation === 'review' && r.index === 0) {
            if (fault === 'unknown') throw Error('SYNTHETIC uncertain');
            if (fault === 'http') r.status = 503;
            if (fault === 'invalid-usage') r.envelope.usage = { prompt_tokens: -1 };
          }
        },
      });
    try {
      const s = await runQualityAudit(f.spec, {
        store: f.store,
        source: f.source,
        selection: f.selection,
        objective: f.objective,
        transport: m.transport,
      });
      assert.equal(s.status, 'COMPLETED', JSON.stringify(s));
      assert.equal(s.counts.HOLD, 4);
      assert.equal(s.counts.PASS, 4);
      const e = exportQualityAudit(f.store, f.source);
      assert.equal(e.export.eligibleRows, 4);
      assert.equal(readQualityIndex(f.store, f.store.snapshot()!.indexRef!).entries.length, 8);
      verifyQualityAudit(f.store, f.source);
    } finally {
      f.store.close();
      f.source.close();
    }
  });
