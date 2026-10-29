import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test(
  'TJ1 Node-only fixture kill preserves consumed intent; fresh process cannot infer real execution',
  { timeout: 30_000 },
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'companion-tj1-offline-restart-'))),
      script = fileURLToPath(new URL('./fixtures/tj1-ledger-child.ts', import.meta.url));
    const child = spawn(process.execPath, [script, 'hold', directory], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let closed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const exit = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => {
        closed = true;
        resolve();
      });
    });
    try {
      const ready = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(Error('FIXTURE_BOOT_TIMEOUT')), 10_000);
        let raw = '';
        child.stdout.on('data', (b) => {
          raw += b.toString();
          if (raw.length > 4096) reject(Error('FIXTURE_OUTPUT_LIMIT'));
          else if (raw.includes('\n')) resolve(raw.trim());
        });
        child.once('error', reject);
      });
      clearTimeout(timer);
      assert.equal(JSON.parse(ready).lane, 'OFFLINE_FIXTURE');
      child.kill('SIGKILL');
      await Promise.race([
        exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('FIXTURE_KILL_TIMEOUT')), 5000);
        }),
      ]);
      clearTimeout(timer);
      const result = spawnSync(process.execPath, [script, 'read', directory], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4096,
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        lane: 'OFFLINE_FIXTURE',
        consumed: true,
        assurance: 'RECORDED_CLAIMS_ONLY',
        recovery: 'RECONCILE_REQUIRED',
        steps: 0,
      });
    } finally {
      clearTimeout(timer);
      if (!closed) {
        child.kill('SIGKILL');
        await Promise.race([
          exit,
          new Promise<void>((r) => {
            timer = setTimeout(r, 5000);
          }),
        ]);
        clearTimeout(timer);
      }
    }
  },
);
