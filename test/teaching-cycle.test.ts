import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonical, hash } from '../src/wf1-json.ts';
import { runTeachingCycle, verifyTeachingCycle } from '../src/teaching-cycle-runner.ts';
import { assembleCycleIndexes } from '../src/corpus-qa-index.ts';
import { openTeachingCycle } from '../src/teaching-cycle-store.ts';
import { validateCurriculumPlan } from '../src/teaching-cycle-types.ts';
import { cycleFixture, pipelineFixture } from './teaching-cycle-fixture.ts';
import { installSyntheticTokenizer } from './teaching-tokenizer-fixture.ts';
import { STUDENT_TARGET } from '../src/corpus-production-types.ts';
import { TEACHER_TOKENIZER_ASSETS } from '../src/corpus-teacher-tokenizer.ts';

test('two micro rounds x two shards execute native production, measurement, QA and full indexes with two requests in flight', async () => {
  const f = pipelineFixture(),
    restore = installSyntheticTokenizer(f.recordTokenizerCall);
  try {
    const summary = await runTeachingCycle(f.ports);
    assert.equal(summary.status, 'COMPLETE', JSON.stringify(summary));
    assert.equal(summary.microBarriers, 2);
    assert.equal(summary.indexesCommitted, 4);
    assert.equal(f.tokenizerCalls, 4);
    assert.equal(f.peak, 2);
    assert.equal(f.distinctChildPeak, 2);
    assert.ok(f.events.every((e) => e.priorRoundComplete));
    assert.equal(f.sends, 32);
    assert.equal(summary.resources.localHeld, 0);
    assert.ok(f.events.every((e) => (Number(e.childId.slice(6)) < 2 ? e.microRound === 0 : e.microRound === 1)));
    const { state, indexes, digests } = verifyTeachingCycle(f.store, f.ports.openIndex, f.ports.checkChildMetadata),
      assembly = assembleCycleIndexes(indexes, digests, { maxInputs: 512, maxRows: 100000, maxBytes: 100000000 });
    assert.equal(assembly.rows.length, 32);
    assert.equal(assembly.rows.filter((r) => r.familyHold).length, 16);
    assert.equal(assembly.rows.filter((r) => r.qaDisposition === 'REJECT').length, 1);
    assert.equal(assembly.rows.filter((r) => r.qaDisposition === 'HOLD').length, 1);
    assert.equal(assembly.rows.filter((r) => r.eligibleForNextExport).length, 16);
    const sends = f.sends;
    assert.deepEqual(await runTeachingCycle(f.ports), summary);
    assert.equal(f.sends, sends);
    const verified = verifyTeachingCycle(f.store, f.ports.openIndex, f.ports.checkChildMetadata),
      frozen = canonical(state),
      path = f.persist();
    f.store.close();
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/teaching-cycle-worker.mjs', import.meta.url)), 'verify', path],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const cold = JSON.parse(child.stdout);
    assert.deepEqual(cold.summary, summary);
    assert.equal(cold.stateDigest, hash(frozen));
    assert.deepEqual(cold.indexDigests, verified.digests);
    assert.equal(cold.measurementDigest, verified.measurementDigest);
    assert.deepEqual(cold.tokens, verified.tokens);
    assert.deepEqual(cold.tokens, { rows: 32, studentInputTokens: 96, studentLossTokens: 160, fullTokens: 256 });
  } finally {
    restore();
    f.store.close();
  }
});

test('logical plans may exceed 192; explicit ordering and resource configuration are frozen', () => {
  const f = cycleFixture(
    Array.from({ length: 10 }, (_, i) => ({
      childId: 'child-' + i,
      microRound: Math.floor(i / 2),
      shard: i % 2,
      plannedUnits: 192,
      productionSpecDigest: hash('spec' + i),
    })),
  );
  try {
    assert.equal(
      validateCurriculumPlan(f.plan, f.spec).children.reduce((n, c) => n + c.plannedUnits, 0),
      1920,
    );
    const reversed = { ...f.plan, children: [...f.plan.children].reverse() },
      spec = { ...f.spec, planDigest: hash(canonical(reversed)) };
    assert.throws(() => validateCurriculumPlan(reversed, spec), { code: 'TC_PLAN' });
    f.store.initialize(f.plan);
    assert.throws(() => f.store.apply('BARRIER', { microRound: 0, assemblyDigest: hash('fake'), indexDigests: [] }), {
      code: 'TC_BARRIER',
    });
  } finally {
    f.store.close();
  }
});

test('authenticated INIT rejects changed resources/spec even if the SQLite projection is edited to match', () => {
  const f = cycleFixture();
  f.store.initialize(f.plan);
  const state = f.store.snapshot()!;
  f.store.close();
  const spec = structuredClone(f.spec);
  spec.resources.localSlots++;
  state.spec = spec;
  const db = new DatabaseSync(join(f.options.runtimeRoot, 'teaching-cycle.sqlite'));
  try {
    db.prepare('UPDATE metadata SET data=? WHERE id=1').run(canonical(state));
  } finally {
    db.close();
  }
  assert.throws(() => openTeachingCycle({ ...f.options, spec, mode: 'resume' }), { code: 'TC_BINDING' });
});

for (const window of ['audit-created', 'archive-created'] as const)
  test('real process exit at ' + window + ' reopens the same child and never replays consumed work', async () => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/teaching-cycle-worker.mjs', import.meta.url)), 'crash', window],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    );
    assert.equal(child.status, 17, child.stderr);
    const path = child.stdout.trim(),
      saved = JSON.parse(readFileSync(path, 'utf8')),
      f = pipelineFixture(undefined, path),
      restore = installSyntheticTokenizer();
    try {
      const before = f.store.snapshot()!,
        ids = before.leases.map((l) => l.request.jobId + ':' + l.request.attemptId);
      assert.equal(before.children[0]!.stage, window === 'audit-created' ? 'QA' : 'INDEX');
      assert.equal(saved.audits.length, 1);
      const result = await runTeachingCycle(f.ports);
      assert.equal(result.status, 'COMPLETE', JSON.stringify(result));
      const after = f.store.snapshot()!,
        all = after.leases.map((l) => l.request.jobId + ':' + l.request.attemptId);
      assert.equal(new Set(all).size, all.length);
      for (const id of ids) assert.equal(all.filter((v) => v === id).length, 1);
      assert.equal(after.children[0]!.auditSpecDigest, hash(canonical(f.audits.get('child-0')!.spec)));
      assert.equal(f.sends, window === 'audit-created' ? 27 : 24);
    } finally {
      restore();
      f.store.close();
    }
  });

test(
  'official pinned Python worker executes the complete synthetic two-round teaching cycle',
  { skip: !process.env.CP0_TOKENIZER_PYTHON || !process.env.CPQ_TOKENIZER_ASSET_ROOT },
  async () => {
    const pythonPath = process.env.CP0_TOKENIZER_PYTHON!,
      version = spawnSync(pythonPath, ['-I', '-B', '-c', 'import platform; print(platform.python_version())'], {
        encoding: 'utf8',
        windowsHide: true,
      });
    assert.equal(version.status, 0);
    const profile = {
        version: 'CorpusTokenizer/0.1',
        model: STUDENT_TARGET.repo,
        revision: STUDENT_TARGET.revision,
        assetRoot: realpathSync.native(process.env.CPQ_TOKENIZER_ASSET_ROOT!),
        ...TEACHER_TOKENIZER_ASSETS,
        runtime: { python: version.stdout.trim(), tokenizers: '0.23.3', jinja2: '3.1.6', markupsafe: '3.0.4' },
        templatePolicy: 'SFT_USER_ASSISTANT_NO_THINKING/1',
        addSpecialTokens: false,
        maxInputBytes: 65536,
        maxTokens: 65536,
        officialPipelineParity: 'NOT_VALIDATED',
      },
      f = pipelineFixture({ profile, pythonPath });
    try {
      const result = await runTeachingCycle(f.ports);
      assert.equal(result.status, 'COMPLETE', JSON.stringify(result));
      assert.equal(result.microBarriers, 2);
      assert.equal(result.indexesCommitted, 4);
      assert.equal(f.peak, 2);
      assert.equal(f.distinctChildPeak, 2);
      assert.ok(f.events.every((e) => e.priorRoundComplete));
      assert.equal(f.tokenizerCalls, 0, 'synthetic tokenizer interceptor is absent');
      const verified = verifyTeachingCycle(f.store, f.ports.openIndex, f.ports.checkChildMetadata),
        path = f.persist();
      f.store.close();
      const cold = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/teaching-cycle-worker.mjs', import.meta.url)), 'verify', path],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 },
      );
      assert.equal(cold.status, 0, cold.stderr);
      const receipt = JSON.parse(cold.stdout);
      assert.deepEqual(receipt.summary, result);
      assert.deepEqual(receipt.indexDigests, verified.digests);
      assert.equal(receipt.measurementDigest, verified.measurementDigest);
      assert.deepEqual(receipt.tokens, verified.tokens);
      assert.ok(receipt.tokens.studentLossTokens > 0);
    } finally {
      f.store.close();
    }
  },
);

test('current child metadata grant, mandatory synchronous hook and archive grant remain separate read gates', async () => {
  const f = pipelineFixture(),
    restore = installSyntheticTokenizer();
  try {
    assert.equal((await runTeachingCycle(f.ports)).status, 'COMPLETE');
    const read = f.store.read.bind(f.store);
    let reads = 0;
    f.store.read = (ref) => {
      reads++;
      return read(ref);
    };
    const denied = () => {
      assert.throws(() => verifyTeachingCycle(f.store, f.ports.openIndex, f.ports.checkChildMetadata), {
        code: 'TC_CHILD_METADATA_REVOKED',
      });
      assert.equal(reads, 0);
    };
    const grant = f.metadataGrants.get('child-0')!;
    grant.readAllowed = false;
    denied();
    grant.readAllowed = true;
    grant.retainAllowed = false;
    denied();
    grant.retainAllowed = true;
    for (const hook of [
      undefined,
      async () => {},
      () => ({
        then: () => {
          throw new Error('must not invoke thenable');
        },
      }),
      () => true,
    ]) {
      assert.throws(() => verifyTeachingCycle(f.store, f.ports.openIndex, hook as typeof f.ports.checkChildMetadata), {
        code: 'TC_METADATA_CHECK',
      });
      assert.equal(reads, 0);
    }
    // A derived metadata grant cannot substitute for the archive's current grant.
    f.archives.get('child-0')!.admission().grant.status = 'REVOKED';
    assert.throws(() => verifyTeachingCycle(f.store, f.ports.openIndex, f.ports.checkChildMetadata));
    assert.ok(reads > 0, 'authorized cycle metadata was readable, but the archive independently refused');
  } finally {
    restore();
    f.store.close();
  }
});

test('QA recovery checks its current derived metadata grant before selection decryption or reopening the audit', async () => {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/teaching-cycle-worker.mjs', import.meta.url)), 'crash', 'audit-created'],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  assert.equal(child.status, 17, child.stderr);
  const f = pipelineFixture(undefined, child.stdout.trim());
  try {
    assert.equal(f.store.snapshot()!.children[0]!.stage, 'QA');
    f.metadataGrants.get('child-0')!.readAllowed = false;
    let reads = 0,
      opened = 0;
    const read = f.store.read.bind(f.store),
      open = f.ports.openAudit;
    f.store.read = (ref) => {
      reads++;
      return read(ref);
    };
    f.ports.openAudit = async (...args) => {
      opened++;
      return open(...args);
    };
    await assert.rejects(runTeachingCycle(f.ports), { code: 'TC_CHILD_METADATA_REVOKED' });
    assert.equal(reads, 0);
    assert.equal(opened, 0);
    assert.equal(f.sends, 0);
    assert.equal(f.store.snapshot()!.children[0]!.stage, 'QA');
  } finally {
    f.store.close();
  }
});
