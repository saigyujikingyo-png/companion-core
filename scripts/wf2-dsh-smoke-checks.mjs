import path from 'node:path';
import crypto from 'node:crypto';

export function nativeSmokeEnvironment(parent, platform, slot, home) {
  const env = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
  ]) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  // The pinned runtime treats an empty OFFICE override as an invalid directory.
  // Omit it entirely, including any parent value; PRIMARY explicitly supports empty.
  return Object.assign(env, {
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PRIMARY_RUNTIME: '',
    USERPROFILE: slot,
    HOME: slot,
    PATH: platform === 'win32' ? path.win32.join(parent.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin',
  });
}

export function checkNativeVersionProbe(result) {
  const expectedVersion = '0.2.1-rc.2';
  const output = (value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
    return {
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      prefix: bytes.subarray(0, 1024).toString('utf8'),
      truncated: bytes.length > 1024,
    };
  };
  return {
    version: 'wf2-native-dsh-version-probe/1',
    expectedVersion,
    ok:
      result.status === 0 &&
      result.signal === null &&
      result.error == null &&
      [expectedVersion, expectedVersion + '\n', expectedVersion + '\r\n'].includes(result.stdout),
    exitStatus: Number.isInteger(result.status) ? result.status : null,
    signal: typeof result.signal === 'string' ? result.signal.slice(0, 32) : null,
    errorCode:
      result.error == null ? null : typeof result.error.code === 'string' ? result.error.code.slice(0, 64) : 'UNKNOWN',
    stdout: output(result.stdout),
    stderr: output(result.stderr),
  };
}
