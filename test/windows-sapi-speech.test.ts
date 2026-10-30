import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSilentSpeechTestBackend,
  WINDOWS_SPEECH_EXECUTABLE,
  WINDOWS_SPEECH_WORKER,
} from '../src/windows-sapi-speech.ts';
import type { SilentSpeechLaunch } from '../src/windows-sapi-speech.ts';
import { SpeechController } from '../src/speech-controller.ts';
import { claimSyntheticSpeechWindow } from '../scripts/verify-windows-speech.ts';
import { FakeAuthority, FakeGate, plan, profile, text } from './fixtures/speech-synthetic.ts';
const childPath = fileURLToPath(new URL('./fixtures/speech-silent-child.mjs', import.meta.url));
const token = {
  effectKey: 'effect',
  fingerprint: 'fingerprint',
  controllerGeneration: 1,
  workerInstanceId: 'worker',
  lease: { resourceKey: 'resource', ownerInstanceId: 'owner', leaseId: 'lease', fencingGeneration: 1 },
};
function reportOwnedChild(child: ReturnType<typeof spawn>) {
  const file = process.env.SPEECH_TEST_PID_FILE;
  if (file && child.pid)
    appendFileSync(file, JSON.stringify({ pid: child.pid, parentPid: process.pid, createdMs: Date.now() }) + '\n');
}
function nativeFixture(mode = 'normal', modify?: Parameters<typeof makeLaunch>[1]) {
  const backend = createSilentSpeechTestBackend(profile, makeLaunch(mode, modify));
  const controller = new SpeechController({
    backend,
    gate: new FakeGate(),
    authority: new FakeAuthority(),
    sink: { forward() {} },
    controllerBindingId: 'binding',
    mode: 'synthetic-test',
  });
  return { controller, backend };
}
function makeLaunch(mode: string, modify?: (child: ReturnType<typeof spawn>) => void): SilentSpeechLaunch {
  return (executable, args, options) => {
    assert.equal(executable, WINDOWS_SPEECH_EXECUTABLE);
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-STA', '-File', WINDOWS_SPEECH_WORKER]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(!args.join(' ').includes(text));
    const child = spawn(process.execPath, ['--max-old-space-size=128', childPath, mode], { ...options, stdio: 'pipe' });
    reportOwnedChild(child);
    modify?.(child);
    return child;
  };
}
test('F18 F26 fixed launch contains no text; real silent child protocol completes once', async () => {
  const f = nativeFixture(),
    op = f.controller.submit(plan(), text);
  const result = await op.result;
  assert.equal(result.outcome, 'backend_completed_reported');
  assert.equal(result.workerExited, true);
  assert.equal(result.forcedTermination, false);
  await f.controller.close();
  const helper = await readFile(WINDOWS_SPEECH_WORKER, 'utf8');
  assert.match(helper, /Speak\(\$request\.text,17\)/);
  assert.doesNotMatch(helper, /Invoke-Expression|Start-Process|Set-ExecutionPolicy/);
});
for (const mode of ['missing-profile', 'overflow', 'malformed', 'truncated', 'unknown'])
  test(`F15 F16 bounded silent protocol ${mode}`, async () => {
    const f = nativeFixture(mode),
      op = f.controller.submit(plan(), text);
    const result = await op.result;
    assert.equal(result.outcome, mode === 'missing-profile' ? 'cancelled_before_dispatch' : 'unknown_after_dispatch');
    assert.equal(result.workerExited, true);
    await f.controller.close();
  });
test('F16 stdin backpressure is possibly dispatched, never retried', async () => {
  let writes = 0;
  const f = nativeFixture('hold', (child) => {
    const stdin = child.stdin!,
      original = stdin.write.bind(stdin);
    stdin.write = ((...args: Parameters<typeof stdin.write>) => {
      writes++;
      const accepted = original(...args);
      return writes === 2 ? false : accepted;
    }) as typeof stdin.write;
  });
  const result = await f.controller.submit(plan(), text).result;
  assert.notEqual(result.outcome, 'backend_completed_reported');
  assert.equal(writes, 3);
  await f.controller.close();
});
test('F12 silent child EOF clears synthetic active state; effect file remains consumed', async () => {
  let child: ReturnType<typeof spawn> | undefined;
  const backend = createSilentSpeechTestBackend(
    profile,
    makeLaunch('hold', (value) => {
      child = value;
    }),
  );
  const events: unknown[] = [];
  const op = backend.start(plan(), token, (event) => events.push(event));
  await op.ready;
  op.dispatch(text);
  child!.stdin!.end();
  const result = await op.settled;
  assert.equal(result.workerExited, true);
  assert.equal(result.forcedTermination, false);
  assert.ok(events.some((e) => (e as { code: string }).code === 'EOF_PURGED'));
});
test('F20 native TEMP create-new/fsync guard rejects another process and another run ID', async () => {
  const keys = ['TEMP', 'TMP', 'TMPDIR'] as const,
    previous = keys.map((key) => [key, process.env[key]] as const);
  const container = realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()), 'speech-temp-fixture-')));
  const nativeRoot = join(container, 'native'),
    alias = join(container, 'alias');
  await mkdir(nativeRoot);
  await symlink(nativeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    // Reproduce an aliased OS TEMP without weakening the production canonical-path gate.
    for (const key of keys) process.env[key] = alias;
    const rejected = await mkdtemp(join(tmpdir(), 'aliased-once-'));
    await assert.rejects(claimSyntheticSpeechWindow(rejected, 'alias-run', {}), /NATIVE_TEMP_CANONICAL_REQUIRED/);
    await assert.rejects(readFile(join(rejected, 'audible-owner.claim')), { code: 'ENOENT' });
    // Normalize both os.tmpdir() and its child, so the lexical containment check agrees too.
    const canonicalNative = realpathSync.native(tmpdir());
    for (const key of keys) process.env[key] = canonicalNative;
    await assert.rejects(
      claimSyntheticSpeechWindow(join(canonicalNative, '..', 'escape'), 'escape-run', {}),
      /NATIVE_TEMP_REQUIRED/,
    );
    const directory = await mkdtemp(join(tmpdir(), 'speech-once-fixture-'));
    await claimSyntheticSpeechWindow(directory, 'run-1', { synthetic: true });
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=128',
        '--input-type=module',
        '-e',
        `import {existsSync} from 'node:fs';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';const ackDir=process.env.SPEECH_TEST_MONITOR_ACK_DIR;if(ackDir){const end=Date.now()+2000;while(!existsSync(join(ackDir,process.pid+'.ack'))){if(Date.now()>=end)process.exit(71);await delay(5);}}import {claimSyntheticSpeechWindow} from ${JSON.stringify(new URL('../scripts/verify-windows-speech.ts', import.meta.url).href)};try{await claimSyntheticSpeechWindow(process.argv[1],'run-2',{});process.exitCode=9;}catch(e){process.exitCode=e.code==='EEXIST'?0:8;}`,
        directory,
      ],
      { stdio: 'pipe', windowsHide: true, shell: false },
    );
    reportOwnedChild(child);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    const original = await readFile(join(directory, 'audible-owner.claim'), 'utf8');
    assert.match(original, /CONSUMED_UNKNOWN/);
    assert.match(original, /run-1/);
    assert.doesNotMatch(original, /run-2/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(
    keys.map((key) => [key, process.env[key]]),
    previous,
  );
});
test('F26 stop timeout terminates only the exact owned fake child and reports forced exit', async () => {
  const f = nativeFixture('ignore-stop'),
    op = f.controller.submit(plan('forced', { maxUtteranceMs: 25 }), text);
  const result = await op.result;
  assert.equal(result.outcome, 'unknown_after_dispatch');
  assert.equal(result.forcedTermination, true);
  assert.equal(result.workerExited, true);
  await f.controller.close();
});
