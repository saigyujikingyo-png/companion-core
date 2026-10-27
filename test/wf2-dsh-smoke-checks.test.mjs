import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { nativeSmokeEnvironment, checkNativeVersionProbe } from '../scripts/wf2-dsh-smoke-checks.mjs';

test('native smoke omits every parent office override while retaining the isolated environment', () => {
  for (const office of ['', 'relative', 'C:\\synthetic-office']) {
    const parent = Object.freeze({ DSH_OFFICE_SIDECAR: office, DSH_PRIMARY_RUNTIME: 'parent-primary',
      DSH_HOME: 'parent-home', HOME: 'parent-home', PATH: 'parent-path', SYNTHETIC_SECRET: 'not-inherited',
      SystemRoot: 'C:\\Windows', TEMP: 'synthetic-temp' });
    for (const platform of ['win32', 'linux', 'darwin']) {
      const env = nativeSmokeEnvironment(parent, platform, 'isolated-slot', 'isolated-home');
      assert.equal(Object.hasOwn(env, 'DSH_OFFICE_SIDECAR'), false);
      assert.equal(Object.hasOwn(env, 'SYNTHETIC_SECRET'), false);
      assert.equal(env.DSH_PRIMARY_RUNTIME, '');
      assert.equal(env.DSH_HOME, 'isolated-home');
      assert.equal(env.HOME, 'isolated-slot');
      assert.equal(env.USERPROFILE, 'isolated-slot');
      assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
      assert.equal(env.TEMP, 'synthetic-temp');
      assert.equal(env.PATH, platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin');
    }
  }
});

const probe = changes => ({ status: 0, signal: null, stdout: '0.2.1-rc.2\n', stderr: '', ...changes });
test('native smoke accepts only the pinned reported version with optional standard line ending', () => {
  for (const stdout of ['0.2.1-rc.2', '0.2.1-rc.2\n', '0.2.1-rc.2\r\n']) {
    assert.equal(checkNativeVersionProbe(probe({ stdout })).ok, true);
  }
  for (const stdout of ['', null, '0.2.10', '0.2.1-rc.3', '0.2.1rc2', 'prefix 0.2.1-rc.2', ' 0.2.1-rc.2', '0.2.1-rc.2\n\n']) {
    assert.equal(checkNativeVersionProbe(probe({ stdout })).ok, false);
  }
});

test('native smoke rejects nonzero, signal, spawn error, timeout and output overflow even with matching text', () => {
  for (const change of [{ status: 1 }, { status: null }, { signal: 'SIGTERM' },
    { error: { code: 'ENOENT' } }, { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } },
    { error: { code: 'ENOBUFS' } }]) {
    assert.equal(checkNativeVersionProbe(probe(change)).ok, false);
  }
  const failed = checkNativeVersionProbe(probe({ status: 1, stdout: '', stderr: 'Error: DSH_OFFICE_SIDECAR must be an absolute directory' }));
  assert.equal(failed.exitStatus, 1);
  assert.equal(failed.stderr.prefix, 'Error: DSH_OFFICE_SIDECAR must be an absolute directory');
});

test('native smoke diagnostics retain bounded prefixes, byte counts, hashes and failure facts', () => {
  const stderr = 'x'.repeat(8192), result = checkNativeVersionProbe(probe({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr }));
  assert.equal(result.ok, false);
  assert.equal(result.exitStatus, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.errorCode, 'ETIMEDOUT');
  assert.equal(result.stderr.bytes, 8192);
  assert.equal(result.stderr.prefix, 'x'.repeat(1024));
  assert.equal(result.stderr.truncated, true);
  assert.equal(result.stderr.sha256, crypto.createHash('sha256').update(stderr).digest('hex'));
  assert.equal(result.stdout.truncated, false);
});
