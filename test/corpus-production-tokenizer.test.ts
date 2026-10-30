import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { canonical, hash } from '../src/wf1-json.ts';
import { measureBoundCorpusText } from '../src/corpus-tokenizer.ts';
import { TEACHER_TOKENIZER_ASSETS } from '../src/corpus-teacher-tokenizer.ts';
import { STUDENT_TARGET } from '../src/corpus-production-types.ts';
import type { CorpusTokenizerProfile } from '../src/corpus-tokenizer.ts';
import {
  measureProductionTextBatch,
  measureProductionTokens,
  pinProductionTokenizerWorker,
  verifyProductionTokens,
} from '../src/corpus-production-tokenizer.ts';
import { exportProduction, verifyProductionExport } from '../src/corpus-production-artifacts.ts';
import { openProductionJob } from '../src/corpus-production-store.ts';
import { fixture, mock, run } from './corpus-production-fixture.ts';
const python = process.env.CP0_TOKENIZER_PYTHON,
  assets = process.env.CPQ_TOKENIZER_ASSET_ROOT;
function profile(): CorpusTokenizerProfile {
  const p = spawnSync(python!, ['-I', '-B', '-c', 'import platform; print(platform.python_version())'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(p.status, 0);
  return {
    version: 'CorpusTokenizer/0.1',
    model: STUDENT_TARGET.repo,
    revision: STUDENT_TARGET.revision,
    assetRoot: realpathSync.native(assets!),
    ...TEACHER_TOKENIZER_ASSETS,
    runtime: { python: p.stdout.trim(), tokenizers: '0.23.3', jinja2: '3.1.6', markupsafe: '3.0.4' },
    templatePolicy: 'SFT_USER_ASSISTANT_NO_THINKING/1',
    addSpecialTokens: false,
    maxInputBytes: 65536,
    maxTokens: 65536,
    officialPipelineParity: 'NOT_VALIDATED',
  };
}
test('batch worker pin rejects mutated public source bytes', () => {
  const source = readFileSync(new URL('../workers/corpus/tokenizer-batch.py', import.meta.url), 'utf8');
  assert.equal(pinProductionTokenizerWorker(source), source);
  assert.throws(() => pinProductionTokenizerWorker(source + '\n# mutation'), { code: 'CPR_TOKENIZER_WORKER' });
});
test(
  '32 maximum legal text pairs including JSON control escaping fit local batch bound',
  { skip: !python || !assets },
  () => {
    const p = profile(),
      pairs = Array.from({ length: 32 }, (_, i) => ({
        rowDigest: hash('long' + i),
        user: '\u0001'.repeat(2048),
        assistant: '\u0002'.repeat(8192),
      }));
    assert.ok(Buffer.byteLength(canonical(pairs)) > 524288);
    const values = measureProductionTextBatch(pairs, p, python!);
    assert.equal(values.length, 32);
    assert.ok(values.every((v) => Number(v.studentLossTokens) > 0));
  },
);
test(
  'official batch loads once, matches single IDs/masks, exports separate pool/split shards and cold recomputes',
  { skip: !python || !assets },
  async () => {
    const p = profile(),
      pairs = [
        {
          rowDigest: hash('a'),
          user: 'SYNTHETIC: 说明温度单位。',
          assistant: 'SYNTHETIC: 摄氏度与开尔文是两种温度单位。',
        },
        { rowDigest: hash('b'), user: 'SYNTHETIC: What is 2 plus 3?', assistant: 'SYNTHETIC: 5.' },
      ];
    const batch = measureProductionTextBatch(pairs, p, python!);
    assert.deepEqual(
      batch,
      pairs.map((pair) => measureBoundCorpusText(pair, p, python!)),
    );
    assert.throws(() => measureProductionTextBatch(pairs, { ...p, tokenizerSha256: hash('synthetic fake') }, python!), {
      code: 'CPR_TOKENIZER_PROFILE',
    });
    const f = fixture(8);
    try {
      await run(f, mock(f));
      assert.throws(() => exportProduction(f.store), { code: 'CPR_TOKENS_REQUIRED' });
      const summary = measureProductionTokens(f.store, p, python!);
      assert.equal(summary.rows, 8);
      assert.equal(summary.partitions.filter((v) => v.split === 'train')[0]!.rows, 4);
      assert.equal(summary.partitions.filter((v) => v.split === 'dev')[0]!.rows, 4);
      assert.ok(summary.studentLossTokens > 0);
      const refs = canonical(f.store.snapshot()!.tokenRefs);
      assert.deepEqual(measureProductionTokens(f.store, p, python!), summary);
      assert.equal(canonical(f.store.snapshot()!.tokenRefs), refs);
      const output = exportProduction(f.store);
      assert.equal(output.shards, 2);
      assert.deepEqual(
        output.partitions.map((v) => v.split),
        ['train', 'dev'],
      );
      assert.equal(verifyProductionExport(f.store).rows, 8);
      assert.deepEqual(exportProduction(f.store), output);
      f.store.close();
      const cold = openProductionJob({ ...f.options, mode: 'inspect' });
      try {
        assert.deepEqual(verifyProductionTokens(cold, p, python!), summary);
        assert.equal(verifyProductionExport(cold).rows, 8);
      } finally {
        cold.close();
      }
    } finally {
      f.store.close();
    }
  },
);
