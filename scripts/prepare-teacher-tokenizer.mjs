// Development/CI only: two public files, no credentials, model weights or runtime downloads.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUDENT_TARGET } from '../src/corpus-teacher-types.ts';
import { TEACHER_TOKENIZER_ASSETS } from '../src/corpus-teacher-tokenizer.ts';

const assets = [
  { name: 'tokenizer.json', limit: 32 * 1024 * 1024, digest: TEACHER_TOKENIZER_ASSETS.tokenizerSha256 },
  { name: 'chat_template.jinja', limit: 65536, digest: TEACHER_TOKENIZER_ASSETS.templateSha256 },
];
function allowed(url) {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === '443') &&
    (url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co') || url.hostname.endsWith('.hf.co'))
  );
}
async function download(asset, fetchImpl) {
  let url = new URL(`https://huggingface.co/${STUDENT_TARGET.repo}/resolve/${STUDENT_TARGET.revision}/${asset.name}`);
  const signal = AbortSignal.timeout(60000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!allowed(url)) throw Error('CPQ_PUBLIC_ASSET_REDIRECT');
    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { accept: 'application/octet-stream' },
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 4) throw Error('CPQ_PUBLIC_ASSET_REDIRECT');
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw Error('CPQ_PUBLIC_ASSET_HTTP');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > asset.limit)) {
      await response.body.cancel();
      throw Error('CPQ_PUBLIC_ASSET_SIZE');
    }
    const reader = response.body.getReader(),
      chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > asset.limit) {
          await reader.cancel();
          throw Error('CPQ_PUBLIC_ASSET_SIZE');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks);
    if (createHash('sha256').update(body).digest('hex') !== asset.digest) throw Error('CPQ_PUBLIC_ASSET_HASH');
    return body;
  }
  throw Error('CPQ_PUBLIC_ASSET_REDIRECT');
}
export async function prepareTeacherTokenizer(directory, fetchImpl = fetch) {
  const bodies = [];
  for (const asset of assets) bodies.push(await download(asset, fetchImpl));
  const root = resolve(directory);
  mkdirSync(root);
  for (const [i, asset] of assets.entries()) writeFileSync(join(root, asset.name), bodies[i], { flag: 'wx' });
  return { files: assets.length, model: STUDENT_TARGET.repo, revision: STUDENT_TARGET.revision };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('CPQ_PUBLIC_ASSET_ARGUMENTS');
  process.stdout.write(JSON.stringify(await prepareTeacherTokenizer(process.argv[2])) + '\n');
}
