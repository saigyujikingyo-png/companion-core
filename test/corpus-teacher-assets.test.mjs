import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTeacherTokenizer } from '../scripts/prepare-teacher-tokenizer.mjs';

for (const [name, response, code] of [
  [
    'foreign redirect',
    () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/private' } }),
    'CPQ_PUBLIC_ASSET_REDIRECT',
  ],
  [
    'oversized declared body',
    () => new Response('fixture', { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }),
    'CPQ_PUBLIC_ASSET_SIZE',
  ],
  ['different content', () => new Response('synthetic content'), 'CPQ_PUBLIC_ASSET_HASH'],
])
  test('public tokenizer preparation refuses ' + name + ' without writing assets', async () => {
    const root = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'cpq-public-fixture-'))), 'assets');
    let requests = 0;
    await assert.rejects(
      () =>
        prepareTeacherTokenizer(root, async (url, options) => {
          requests++;
          assert.equal(
            String(url),
            'https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4/resolve/da5b2650a835292c678994a1fa3fb653250fb508/tokenizer.json',
          );
          assert.equal(options.redirect, 'manual');
          assert.deepEqual(options.headers, { accept: 'application/octet-stream' });
          return response();
        }),
      { message: code },
    );
    assert.equal(requests, 1);
    assert.equal(existsSync(root), false);
  });
