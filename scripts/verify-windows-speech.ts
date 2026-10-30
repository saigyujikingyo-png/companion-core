import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, statfs } from 'node:fs/promises';
import { freemem, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SpeechController } from '../src/speech-controller.ts';
import {
  canonicalSpeech,
  speechHash,
  speechObject,
  speechString,
  validateSpeechProfile,
} from '../src/speech-contract.ts';
import type { OutputLease, SpeechAuthority, SpeechPlan } from '../src/speech-contract.ts';
import {
  createWindowsSapiSpeechBackend,
  WINDOWS_SPEECH_EXECUTABLE,
  WINDOWS_SPEECH_WORKER,
} from '../src/windows-sapi-speech.ts';

const FIXED_PHRASE = '你好，这是语音测试。';
export async function claimSyntheticSpeechWindow(
  directory: string,
  runId: string,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) throw new Error('INVALID_RUN_ID');
  const root = resolve(directory),
    native = resolve(tmpdir());
  const childPath = relative(native, root);
  if (childPath === '..' || childPath.startsWith('..\\') || childPath.startsWith('../') || isAbsolute(childPath))
    throw new Error('NATIVE_TEMP_REQUIRED');
  await mkdir(root, { recursive: true });
  const actual = await realpath(root),
    nativeActual = await realpath(native),
    actualRelative = relative(nativeActual, actual);
  if (
    actual.toLowerCase() !== root.toLowerCase() ||
    actualRelative === '..' ||
    actualRelative.startsWith('..\\') ||
    actualRelative.startsWith('../') ||
    isAbsolute(actualRelative)
  )
    throw new Error('NATIVE_TEMP_CANONICAL_REQUIRED');
  // Permanent launcher-wide guard: changing runId cannot open another audible window.
  const claim = await open(join(root, 'audible-owner.claim'), 'wx', 0o600);
  try {
    await claim.writeFile(
      JSON.stringify({ ...metadata, version: 1, runId, state: 'CONSUMED_UNKNOWN_UNTIL_INDEPENDENT_RECEIPT' }) + '\n',
    );
    await claim.sync();
  } finally {
    await claim.close();
  }
}
async function createNewJson(path: string, value: unknown): Promise<void> {
  const f = await open(path, 'wx', 0o600);
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}
async function inventory(): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_SAPI_UNSUPPORTED');
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      WINDOWS_SPEECH_EXECUTABLE,
      ['-NoProfile', '-NonInteractive', '-STA', '-File', WINDOWS_SPEECH_WORKER],
      { shell: false, windowsHide: true, stdio: 'pipe' },
    );
    let data = Buffer.alloc(0),
      failed = false;
    const fail = () => {
      failed = true;
      try {
        child.kill();
      } catch {}
    };
    const timer = setTimeout(fail, 3000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (data.length + chunk.length > 16384) {
        fail();
        return;
      }
      data = Buffer.concat([data, chunk]);
    });
    child.stderr.on('data', fail);
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        reject(new Error('INVENTORY_NOT_ACCEPTED'));
        return;
      }
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
        const r = speechObject(value, ['version', 'kind', 'voices', 'outputs']);
        if (r.version !== 1 || r.kind !== 'inventory') throw new Error();
        resolveResult(value);
      } catch {
        reject(new Error('INVENTORY_PROTOCOL'));
      }
    });
    child.stdin.on('error', fail);
    child.stdin.end('{"action":"inventory"}\n');
  });
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify({
        status: 'STATIC_ONLY',
        nativeInventory: 'NOT_RUN',
        audible: 'NOT_RUN',
        requirements:
          'Use --inventory explicitly. Audible requires a Root allocation, exact profile, and an external owner RSS monitor.',
      }),
    );
    return;
  }
  const disk = await statfs(tmpdir());
  if (freemem() < 1024 ** 3 || Number(disk.bavail) * Number(disk.bsize) < 64 * 1024 ** 2)
    throw new Error('RESOURCE_GATE_REFUSED');
  const root = join(tmpdir(), 'companion-au1-synthetic-verification');
  await mkdir(root, { recursive: true });
  if (args.length === 1 && args[0] === '--inventory') {
    const result = await inventory(),
      file = join(root, 'inventory-' + Date.now() + '.json');
    await createNewJson(file, {
      status: 'INVENTORY_ONLY',
      workerSha256: speechHash(await readFile(WINDOWS_SPEECH_WORKER, 'utf8')),
      node: process.version,
      result,
    });
    console.log(JSON.stringify({ status: 'INVENTORY_ONLY', file, audible: 'NOT_RUN' }));
    return;
  }
  if (args.length !== 5 || args[0] !== '--audible-once' || args[1] !== '--allocation' || args[3] !== '--profile')
    throw new Error('EXPLICIT_ARGUMENTS_REQUIRED');
  const allocation = speechObject(JSON.parse(await readFile(args[2]!, 'utf8')), [
    'version',
    'runId',
    'workerSha256',
    'profileSha256',
    'rootReconciled',
    'absenceOfUnresolvedWorkersConfirmed',
    'externalRssMonitorAttached',
    'maxMs',
    'stopAfterDispatchMs',
  ]);
  const profile = validateSpeechProfile(JSON.parse(await readFile(args[4]!, 'utf8')));
  const workerSha = createHash('sha256')
    .update(await readFile(WINDOWS_SPEECH_WORKER))
    .digest('hex');
  if (
    allocation.version !== 1 ||
    allocation.workerSha256 !== workerSha ||
    allocation.profileSha256 !== speechHash(canonicalSpeech(profile)) ||
    allocation.rootReconciled !== true ||
    allocation.absenceOfUnresolvedWorkersConfirmed !== true ||
    allocation.externalRssMonitorAttached !== true ||
    allocation.maxMs !== 5000 ||
    allocation.stopAfterDispatchMs !== 1000
  )
    throw new Error('ALLOCATION_NOT_ACCEPTED');
  const runId = speechString(allocation.runId, 64);
  await claimSyntheticSpeechWindow(root, runId, { workerSha256: workerSha, profileSha256: allocation.profileSha256 });
  // This one launcher owns the unique synthetic window. These RAM ports are not a production authority.
  let lease: OutputLease | null = null,
    claimed = false,
    blocked = false;
  const authority: SpeechAuthority = {
    assurance: 'synthetic-only',
    claims: {
      async claim() {
        if (claimed || blocked || !lease) return { status: 'unknown' };
        claimed = true;
        return { status: 'claimed' };
      },
    },
    output: {
      async acquire(input) {
        if (lease || blocked) return null;
        lease = Object.freeze({ ...input, leaseId: runId, fencingGeneration: 1 });
        return lease;
      },
      isCurrent: (token) => !blocked && canonicalSpeech(lease) === canonicalSpeech(token),
      async release(token) {
        if (canonicalSpeech(lease) !== canonicalSpeech(token) || blocked) throw new Error('LEASE_RELEASE_REFUSED');
        lease = null;
      },
      block() {
        blocked = true;
      },
    },
  };
  const base = createWindowsSapiSpeechBackend(profile);
  let controller: SpeechController;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const backend = {
    capabilities: base.capabilities,
    start(p: SpeechPlan, t: Parameters<typeof base.start>[1], receive: Parameters<typeof base.start>[2]) {
      const op = base.start(p, t, receive);
      return {
        ready: op.ready,
        settled: op.settled,
        stop: () => op.stop(),
        dispatch(value: string) {
          op.dispatch(value);
          timer = setTimeout(() => {
            void controller.stopDetailed();
          }, 1000);
        },
      };
    },
  };
  controller = new SpeechController({
    backend,
    authority,
    controllerBindingId: runId,
    ownerInstanceId: runId,
    mode: 'synthetic-native-verification',
    gate: { check: () => true, subscribeInvalidation: () => () => {} },
    sink: { forward() {} },
  });
  const p: SpeechPlan = {
    version: 1,
    effectNamespaceId: 'au1-single-synthetic-window',
    speechIntentId: runId,
    utteranceId: runId,
    hostId: 'single-native-launcher',
    sessionId: runId,
    turnId: runId,
    binding: {
      scopeId: runId,
      generation: 0,
      consentRevision: 0,
      runtimeEpoch: 0,
      hostGeneration: 0,
      permissionId: runId,
      permissionEpoch: 0,
      contextRevision: 0,
      controllerBindingId: runId,
    },
    sourceRefs: [{ id: 'original-fixed-synthetic-phrase', revision: 1 }],
    expression: {
      kind: 'committed-expression',
      origin: 'synthetic-fixture',
      sha256: speechHash(FIXED_PHRASE),
      utf8Bytes: Buffer.byteLength(FIXED_PHRASE),
    },
    profile,
    dispatchDeadlineMonotonicMs: Math.ceil(performance.now() + 5000),
    maxUtteranceMs: 5000,
    chunk: { mode: 'whole-utterance', index: 0, final: true },
  };
  const op = controller.submit(p, FIXED_PHRASE);
  await op.result;
  if (timer) clearTimeout(timer);
  await controller.close();
  const file = join(root, runId + '-terminal.json');
  await createNewJson(file, {
    status: 'SYNTHETIC_ENGINE_RECEIPT_ONLY',
    result: op.snapshot(),
    productionAuthority: 'NOT_IMPLEMENTED',
    deviceSilence: 'NOT_OBSERVED',
    userAcceptance: 'NOT_EVALUATED',
    resourceRss: 'EXTERNAL_MONITOR_RECEIPT_REQUIRED',
  });
  console.log(JSON.stringify({ status: op.snapshot().outcome, file }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    console.error('WINDOWS_SPEECH_NOT_ACCEPTED');
    process.exitCode = 1;
  });
}
