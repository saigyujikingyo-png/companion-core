import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonical, hash } from '../src/wf1-json.ts';
import { openQualityArchive } from '../src/corpus-qa-source.ts';
import { openQualityAudit } from '../src/corpus-qa-store.ts';
import {
  createQaTransport,
  exportQualityAudit,
  readQualityIndex,
  runQualityAudit,
  verifyQualityAudit,
} from '../src/corpus-qa-runner.ts';
import { assembleScopedIndexes, buildScopedIndex, qaExactFingerprints } from '../src/corpus-qa-index.ts';
import {
  auditBody,
  auditReservation,
  FACTORY_BASELINE,
  FACTORY_BASELINE_DIGEST,
  QA,
  QA_TARGET_BASELINE,
  QA_TARGET_BASELINE_DIGEST,
  requireQaPurpose,
  validateAuditSpec,
} from '../src/corpus-qa-types.ts';
import { ENDPOINTS, MODELS } from '../src/wf1-types.ts';
import type { ArtifactRef } from '../src/wf1-types.ts';
import { runQualityAuditCommand } from '../src/corpus-qa-cli.ts';
import { openProductionJob } from '../src/corpus-production-store.ts';
import { qaFixture, qaMock, runQa } from './corpus-qa-fixture.ts';

test('QA selected census completes blind DS policy/Together review and cold export without changing the source', async () => {
  const f = await qaFixture(8, 0),
    m = qaMock(f);
  try {
    const summary = await runQa(f, m);
    assert.equal(summary.status, 'COMPLETED');
    assert.equal(summary.counts.PASS, 7);
    assert.equal(m.sends, 3);
    assert.ok(m.peak <= QA.concurrency);
    const out = exportQualityAudit(f.store, f.source);
    assert.equal(out.export.eligibleRows, 7);
    assert.equal(out.factualTruth, 'UNKNOWN');
    assert.equal(out.trainingReady, false);
    assert.equal(out.independence, 'SAME_MODEL_OR_ROUTING_UNKNOWN');
    for (const raw of f.readRefs) {
      const ref = JSON.parse(raw);
      assert.ok(
        !['corpus-production-request', 'provider-raw', 'native-reasoning', 'corpus-production-plan'].includes(
          ref.ref.kind,
        ),
      );
    }
    assert.ok(!f.selection.entries.some((e) => e.unit.ordinal === 0));
    assert.throws(() => f.source.read('case-outside-selection'), { code: 'CQA_READ_SCOPE' });
    const before = f.store.snapshot()!,
      index = readQualityIndex(f.store, before.indexRef!);
    assert.equal(index.entries.length, 7);
    f.store.close();
    const cold = openQualityAudit({ ...f.storeOptions, mode: 'inspect' });
    try {
      assert.equal(verifyQualityAudit(cold, f.source).state.status, 'COMPLETED');
      assert.equal(
        (
          await runQualityAudit(f.spec, {
            store: cold,
            source: f.source,
            selection: f.selection,
            objective: f.objective,
            transport: m.transport,
          })
        ).counts.PASS,
        7,
      );
    } finally {
      cold.close();
    }
    assert.equal(m.sends, 3);
    assert.equal(
      hash(readFileSync(join(f.old.options.runtimeRoot, 'corpus-production.sqlite'))),
      f.oldFileHashes.ledger,
    );
    assert.equal(hash(readFileSync(f.old.options.authorityPath)), f.oldFileHashes.authority);
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA new selection grant reads selected archive after old authority expires without restoring old dispatch', async () => {
  const f = await qaFixture(4);
  try {
    f.source.close();
    const later = f.old.spec.expiresAt + 1;
    assert.ok(later < f.admission.readGrant.expiresAt);
    assert.throws(() => openProductionJob({ ...f.old.options, mode: 'inspect', now: () => later }));
    const source = openQualityArchive({ ...f.archiveOptions, now: () => later });
    try {
      assert.equal(source.read(f.selection.entries[0]!.caseId).rowDigest, f.selection.entries[0]!.rowDigest);
      assert.throws(() => source.read('unselected'), { code: 'CQA_READ_SCOPE' });
    } finally {
      source.close();
    }
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA malformed per-case verdict cannot claim verification; rejected and held opinions leave old acceptance intact', async () => {
  const f = await qaFixture(8),
    m = qaMock(f, { bad: f.selection.entries[0]!.caseId, reject: f.selection.entries[1]!.caseId });
  try {
    const s = await runQa(f, m);
    assert.equal(s.status, 'COMPLETED');
    assert.equal(s.counts.HOLD, 1);
    assert.equal(s.counts.REJECT, 1);
    assert.equal(s.counts.PASS, 6);
    assert.equal(exportQualityAudit(f.store, f.source).export.eligibleRows, 6);
    assert.equal(
      hash(readFileSync(join(f.old.options.runtimeRoot, 'corpus-production.sqlite'))),
      f.oldFileHashes.ledger,
    );
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA consumed UNKNOWN and pre-send transport exception never retry on cold resume', async () => {
  for (const beforeSend of [false, true]) {
    const f = await qaFixture(4),
      m = qaMock(f, { unknown: 0 });
    try {
      let invocations = 0;
      const transport = beforeSend
        ? async () => {
            invocations++;
            throw new Error('synthetic pre-grant');
          }
        : m.transport;
      const s = await runQualityAudit(f.spec, {
        store: f.store,
        source: f.source,
        selection: f.selection,
        objective: f.objective,
        transport,
      });
      assert.equal(s.status, 'FENCED');
      assert.equal(s.calls.submitUnknown, 1);
      assert.equal(m.sends, beforeSend ? 0 : 2);
      const consumed = s.calls.total;
      f.store.close();
      const cold = openQualityAudit({ ...f.storeOptions, mode: 'resume' });
      try {
        const result = await runQualityAudit(f.spec, {
          store: cold,
          source: f.source,
          selection: f.selection,
          objective: f.objective,
          transport: async () => {
            throw new Error('must not dispatch');
          },
        });
        assert.equal(result.calls.total, consumed);
        assert.equal(result.status, 'FENCED');
      } finally {
        cold.close();
      }
      if (beforeSend) assert.equal(invocations, 1);
    } finally {
      f.store.close();
      f.source.close();
    }
  }
});

test('QA settled unknown crash window fences fresh resume before new dispatch', async () => {
  const f = await qaFixture(8),
    m = qaMock(f);
  try {
    f.store.initialize(f.selection, f.objective);
    const body = auditBody('rubric', 0, {
        factoryBaseline: FACTORY_BASELINE,
        baselineDigest: FACTORY_BASELINE_DIGEST,
        auditTargetBaseline: QA_TARGET_BASELINE,
        auditTargetBaselineDigest: QA_TARGET_BASELINE_DIGEST,
        currentApprovedObjective: f.objective,
      }),
      requestRef = f.store.port('attempt-0').put('corpus-qa-request', body);
    f.store.apply('CONSUME', {
      id: 'rubric:0',
      operation: 'rubric',
      index: 0,
      caseIds: [],
      bucket: 'attempt-0',
      requestRef,
      bodyHash: hash(body),
      consumedAtMs: 0,
      settledAtMs: null,
      serviceMs: null,
      result: null,
      estimatedMicroUsd: auditReservation(f.spec, 'rubric'),
    });
    f.store.apply('SETTLE', { id: 'rubric:0', result: null, serviceMs: 1, settledAtMs: 1 });
    f.store.close();
    const cold = openQualityAudit({ ...f.storeOptions, mode: 'resume' });
    try {
      const s = await runQualityAudit(f.spec, {
        store: cold,
        source: f.source,
        selection: f.selection,
        objective: f.objective,
        transport: m.transport,
      });
      assert.equal(s.status, 'FENCED');
      assert.ok(s.failureCodes.CQA_SUBMIT_UNKNOWN);
      assert.equal(m.sends, 0);
    } finally {
      cold.close();
    }
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA fresh source revoke and pause prevent late opinions becoming PASS', async () => {
  for (const kind of ['source', 'pause'] as const) {
    const f = await qaFixture(8),
      m = qaMock(f, kind === 'source' ? { sourceRevoke: 0 } : { pause: 0 });
    try {
      const s = await runQa(f, m);
      assert.equal(s.status, 'FENCED');
      assert.equal(s.counts.PASS, 0);
      assert.throws(() => exportQualityAudit(f.store, f.source));
    } finally {
      f.store.close();
      f.source.close();
    }
  }
});

test('QA cash accounting above ten dollars remains allowed; command binds complete spec', async () => {
  const f = await qaFixture(4, undefined, true),
    m = qaMock(f);
  try {
    assert.ok(auditReservation(f.spec, 'rubric')! > 10000000);
    assert.equal(validateAuditSpec(f.spec).profileDigest, f.spec.profileDigest);
    const s = await runQa(f, m);
    assert.equal(s.status, 'COMPLETED');
    assert.ok(s.cost.reservedWorstCaseMicroUsd! > 10000000);
    await assert.rejects(
      runQualityAuditCommand(
        {
          version: 'CorpusQualityAuditCommand/0.1',
          command: 'inspect',
          spec: { ...f.spec, objectiveDigest: hash('changed') },
        },
        { store: f.store, source: f.source },
      ),
      { code: 'CQA_BINDING' },
    );
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA private cross-job index uses content fingerprints, namespaced IDs and cross-split family holds', async () => {
  const f = await qaFixture(4);
  try {
    const original = buildScopedIndex(f.selection, f.source),
      a = structuredClone(original),
      b = structuredClone(original);
    a.entries = a.entries.slice(0, 2).map((e) => ({ ...e, split: 'train', qaDisposition: 'PASS' }));
    b.scope.sourceJobId = 'new-job';
    b.entries = b.entries
      .slice(0, 2)
      .map((e, i) => ({
        ...e,
        sourceJobId: 'new-job',
        unitId: i ? 'new-id' : a.entries[0]!.unitId,
        familyId: 'new-family',
        split: 'dev',
        qaDisposition: i ? 'PASS' : 'REJECT',
      }));
    b.entries[0] = { ...b.entries[0]!, ...qaExactFingerprints({ prompt: ' Same   prompt ', response: ' answer ' }) };
    a.entries[0] = { ...a.entries[0]!, ...qaExactFingerprints({ prompt: 'same prompt', response: 'ANSWER' }) };
    const before = canonical([a, b]),
      result = assembleScopedIndexes([a, b], [hash(canonical(a)), hash(canonical(b))]);
    assert.ok(
      result.rows.filter((r) => r.sourceJobId === 'new-job').every((r) => r.familyHold && !r.eligibleForNextExport),
    );
    assert.equal(result.rows[0]!.familyHold, true);
    assert.equal(result.rows[2]!.duplicateOf, canonical({ jobId: a.scope.sourceJobId, unitId: a.entries[0]!.unitId }));
    assert.equal(canonical([a, b]), before);
    assert.ok(
      assembleScopedIndexes([original], [hash(canonical(original))]).rows.every((r) => !r.eligibleForNextExport),
    );
    assert.throws(() => assembleScopedIndexes([a, b], [hash('wrong'), hash(canonical(b))]), {
      code: 'CQA_INDEX_BINDING',
    });
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA every wire binds new human-target addendum separately from immutable generation baseline', () => {
  const base = {
      factoryBaseline: FACTORY_BASELINE,
      baselineDigest: FACTORY_BASELINE_DIGEST,
      auditTargetBaseline: QA_TARGET_BASELINE,
      auditTargetBaselineDigest: QA_TARGET_BASELINE_DIGEST,
    },
    rubric = {
      version: 'CorpusQualityRubric/0.1',
      instructions: 'synthetic',
      criteria: [{ id: 'c', criterion: 'synthetic' }],
    },
    pair = { prompt: 'synthetic question', response: 'synthetic response' };
  assert.ok(Object.isFrozen(QA_TARGET_BASELINE.requirements));
  assert.ok(Object.isFrozen(QA_TARGET_BASELINE.provenance));
  assert.notEqual(QA_TARGET_BASELINE_DIGEST, FACTORY_BASELINE_DIGEST);
  assert.equal(QA_TARGET_BASELINE.generationBaselineDigest, FACTORY_BASELINE_DIGEST);
  assert.equal(QA_TARGET_BASELINE.provenance.verbatim, false);
  for (const operation of ['rubric', 'review'] as const) {
    const data =
        operation === 'rubric'
          ? { ...base, currentApprovedObjective: 'synthetic objective' }
          : {
              ...base,
              rubric,
              rubricDigest: hash(canonical(rubric)),
              items: [{ caseId: 'case-test', inputDigest: hash(canonical(pair)), ...pair }],
            },
      wire = JSON.parse(JSON.parse(auditBody(operation, 0, data)).messages[1].content).data;
    assert.equal(wire.auditTargetBaselineDigest, QA_TARGET_BASELINE_DIGEST);
    assert.deepEqual(wire.auditTargetBaseline, QA_TARGET_BASELINE);
    assert.equal(wire.baselineDigest, FACTORY_BASELINE_DIGEST);
    assert.throws(() => auditBody(operation, 0, { ...data, auditTargetBaselineDigest: hash('wrong') }), {
      code: 'CQA_BASELINE',
    });
  }
});

test('QA native codec uses both fixed endpoints and strict Together envelope, preserving full server delay', async () => {
  const memory = new Map<string, Buffer>(),
    output = {
      put(kind: string, value: string | Uint8Array): ArtifactRef {
        const b = Buffer.from(value),
          id = randomUUID();
        memory.set(id, b);
        return { id, kind, partition: 'train', bytes: b.length + 28, digest: hash(b) };
      },
      read(ref: ArtifactRef) {
        return memory.get(ref.id)!;
      },
    },
    base = {
      factoryBaseline: FACTORY_BASELINE,
      baselineDigest: FACTORY_BASELINE_DIGEST,
      auditTargetBaseline: QA_TARGET_BASELINE,
      auditTargetBaselineDigest: QA_TARGET_BASELINE_DIGEST,
    },
    rubric = {
      version: 'CorpusQualityRubric/0.1',
      instructions: 'synthetic',
      criteria: [{ id: 'c', criterion: 'synthetic' }],
    },
    pair = { prompt: 'q'.repeat(2048), response: 'r'.repeat(8192) },
    calls: string[] = [];
  for (const operation of ['rubric', 'review'] as const) {
    const provider = operation === 'rubric' ? 'deepseek' : 'together',
      body = auditBody(
        operation,
        0,
        operation === 'rubric'
          ? { ...base, currentApprovedObjective: 'synthetic objective' }
          : {
              ...base,
              rubric,
              rubricDigest: hash(canonical(rubric)),
              items: Array.from({ length: 4 }, (_, i) => ({
                caseId: 'case-' + i,
                inputDigest: hash(canonical(pair)),
                ...pair,
              })),
            },
      );
    if (operation === 'review') assert.ok(Buffer.byteLength(body) > 16384);
    const transport = createQaTransport(
      { deepseek: 'synthetic-key-ds', together: 'synthetic-key-together' },
      {
        fetch: async (url, init) => {
          calls.push(String(url));
          assert.equal(url, ENDPOINTS[provider]);
          assert.equal(init?.redirect, 'error');
          assert.equal(init?.method, 'POST');
          assert.equal(
            (init?.headers as Record<string, string>).authorization,
            'Bearer ' + (provider === 'deepseek' ? 'synthetic-key-ds' : 'synthetic-key-together'),
          );
          return new Response(
            canonical({
              id: 'synthetic',
              model: MODELS[provider],
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: canonical(
                      operation === 'rubric' ? rubric : { version: 'CorpusQualityVerdicts/0.1', items: [] },
                    ),
                  },
                  finish_reason: 'stop',
                  ...(provider === 'together' ? { text: '', seed: 42, top_logprobs: null } : {}),
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              ...(provider === 'together' ? { prompt: [], warnings: [] } : {}),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    );
    let sends = 0;
    const result = await transport({
      operation,
      index: 0,
      body,
      output,
      signal: AbortSignal.timeout(1000),
      authorizeSend: (send) => {
        sends++;
        return send();
      },
    });
    assert.equal(result.outcome, 'COMPLETED');
    assert.equal(result.returnedModel, MODELS[provider]);
    assert.equal(sends, 1);
  }
  assert.deepEqual(calls, [ENDPOINTS.deepseek, ENDPOINTS.together]);
  const body = auditBody('rubric', 0, { ...base, currentApprovedObjective: 'synthetic objective' }),
    transport = createQaTransport(
      { deepseek: 'synthetic', together: 'synthetic' },
      { fetch: async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) },
    );
  const result = await transport({
    operation: 'rubric',
    index: 0,
    body,
    output,
    signal: AbortSignal.timeout(1000),
    authorizeSend: (send) => send(),
  });
  assert.equal(result.retryAfterMs, 120000);
  assert.equal(result.usage, null);
});

test('QA purpose ancestry and fresh grant denial stop before send', async () => {
  const f = await qaFixture(4),
    m = qaMock(f);
  try {
    f.admission.purposes.grants.find((g) => g.grantId === 'training')!.decision = 'UNKNOWN';
    assert.throws(() => requireQaPurpose(f.admission.purposes, f.spec.reviewer, 'review'), { code: 'CQA_PURPOSE' });
    await assert.rejects(runQa(f, m));
    assert.equal(m.sends, 0);
    f.admission.purposes.grants.find((g) => g.grantId === 'training')!.decision = 'ALLOW';
    f.admission.readGrant.readAllowed = false;
    assert.throws(() => f.source.read(f.selection.entries[0]!.caseId), { code: 'CQA_ADMISSION' });
    assert.equal(m.sends, 0);
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA known 429 consumes once and delays future account sends; long wait fences without retry', async () => {
  for (const long of [false, true]) {
    const f = await qaFixture(24),
      m = qaMock(f, { rateLimit: 0, retryAfterMs: long ? 120000 : 80 });
    try {
      const s = await runQa(f, m);
      assert.equal(s.status, long ? 'FENCED' : 'COMPLETED');
      assert.equal(s.calls.known429, 1);
      assert.equal(s.calls.usageUnknown, 1);
      assert.equal(s.cost.estimatedUsageMicroUsd, null);
      assert.ok(s.cost.reservedWorstCaseMicroUsd! > 0);
      assert.equal(m.calls.filter((c) => c.operation === 'review' && c.index === 0).length, 1);
      const rate = f.store.snapshot()!.attempts.find((a) => a.result?.httpStatus === 429)!,
        settledAt = f.spec.createdAt + rate.settledAtMs!;
      if (!long) {
        const future = m.calls.filter((c) => c.at > settledAt);
        assert.ok(future.length > 0);
        assert.ok(future.every((c) => c.at >= settledAt + 80));
      } else assert.ok(s.failureCodes.CQA_RATE_LIMIT_WAIT);
    } finally {
      f.store.close();
      f.source.close();
    }
  }
});

test('QA cold verification rejects an authenticated but false append-only PASS manifest', async () => {
  const f = await qaFixture(4),
    m = qaMock(f);
  try {
    await runQa(f, m);
    const index = buildScopedIndex(f.selection, f.source, f.store.snapshot()!),
      chunk = f.store.put('meta', 'corpus-qa-index-chunk', canonical(index.entries)),
      indexRef = f.store.put(
        'meta',
        'corpus-qa-dedup-index',
        canonical({ version: 'CorpusScopedDedupIndexChunks/0.1', scope: index.scope, entries: [chunk] }),
      );
    f.store.apply('INDEX', { ref: indexRef });
    const ref = f.store.put(
      'meta',
      'corpus-qa-selection-manifest',
      canonical({ version: 'CorpusQualitySelectionManifest/0.1', rows: [] }),
    );
    f.store.apply('MANIFEST', { ref });
    f.store.close();
    const cold = openQualityAudit({ ...f.storeOptions, mode: 'inspect' });
    try {
      assert.throws(() => verifyQualityAudit(cold, f.source), { code: 'CQA_MANIFEST_CONFLICT' });
    } finally {
      cold.close();
    }
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('QA stores own keys, snapshots source identity, and permits strictly read-only cold verification after revoke', async () => {
  const f = await qaFixture(4),
    m = qaMock(f);
  try {
    f.archiveOptions.key.fill(0);
    f.storeOptions.key.fill(0);
    f.archiveOptions.sourceSpec.pools = [];
    assert.equal(f.source.read(f.selection.entries[0]!.caseId).rowDigest, f.selection.entries[0]!.rowDigest);
    assert.equal((await runQa(f, m)).status, 'COMPLETED');
    exportQualityAudit(f.store, f.source);
    f.store.control('REVOKED');
    f.store.close();
    const cold = openQualityAudit({ ...f.storeOptions, key: Buffer.alloc(32, 87), mode: 'inspect' });
    try {
      assert.equal(verifyQualityAudit(cold, f.source).state.items.filter((i) => i.status === 'PASS').length, 4);
      assert.throws(() => exportQualityAudit(cold, f.source));
    } finally {
      cold.close();
    }
    assert.throws(() => openQualityAudit({ ...f.storeOptions, key: Buffer.alloc(32, 87), mode: 'resume' }));
  } finally {
    f.store.close();
    f.source.close();
  }
});
