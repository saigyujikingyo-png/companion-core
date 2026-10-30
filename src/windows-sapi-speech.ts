import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SPEECH_LIMITS,
  SpeechError,
  canonicalSpeech,
  speechFail,
  speechObject,
  validateSpeechProfile,
} from './speech-contract.ts';
import type {
  BackendSettlement,
  ExecutionToken,
  SpeechBackendOperation,
  SpeechBackendPort,
  SpeechPlan,
  SpeechProfile,
} from './speech-contract.ts';

export const WINDOWS_SPEECH_EXECUTABLE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const WINDOWS_SPEECH_WORKER = fileURLToPath(
  new URL('../scripts/windows-sapi-speech-worker.ps1', import.meta.url),
);
export type SilentSpeechLaunch = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
const nativeLaunch: SilentSpeechLaunch = (executable, args, options) =>
  spawn(executable, [...args], { ...options, stdio: 'pipe' });

function operation(
  plan: SpeechPlan,
  token: ExecutionToken,
  receive: (event: unknown) => void,
  launch: SilentSpeechLaunch,
): SpeechBackendOperation {
  let child: ChildProcessWithoutNullStreams;
  let readyResolve!: () => void, readyReject!: (reason: unknown) => void, settle!: (s: BackendSettlement) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Attach the rejection handler before any synchronous process-factory callback can fail.
  void ready.catch(() => {});
  const settled = new Promise<BackendSettlement>((resolve) => {
    settle = resolve;
  });
  let readySeen = false,
    dispatched = false,
    stopping = false,
    closed = false,
    resolved = false,
    protocolFault = false,
    forced = false;
  let buffer = Buffer.alloc(0),
    totalBytes = 0,
    stderrBytes = 0;
  let startup: ReturnType<typeof setTimeout> | null = null,
    lifetime: ReturnType<typeof setTimeout> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null,
    exitTimer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    for (const timer of [startup, lifetime, stopTimer, exitTimer]) if (timer) clearTimeout(timer);
  };
  const finish = (workerExited: boolean, exitCode: number | null) => {
    if (resolved) return;
    resolved = true;
    clear();
    buffer = Buffer.alloc(0);
    if (!readySeen) readyReject(new SpeechError('WORKER_NOT_READY'));
    settle(Object.freeze({ workerExited, exitCode, forcedTermination: forced, protocolFault }));
  };
  const write = (request: unknown) => {
    const line = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(line) > SPEECH_LIMITS.wireBytes) speechFail('STDIN_LIMIT');
    // False means bytes may already be queued. Never retry or append another speak.
    if (
      !child.stdin.write(line, 'utf8', (error) => {
        if (error) fail();
      })
    )
      speechFail('STDIN_BACKPRESSURE');
  };
  const stop = () => {
    if (stopping || closed || resolved) return;
    stopping = true;
    try {
      write({ action: 'stop' });
    } catch {
      protocolFault = true;
    }
    stopTimer = setTimeout(() => {
      if (closed) return;
      try {
        child.stdin.end();
      } catch {
        /* owned child only */
      }
      forced = true;
      try {
        child.kill();
      } catch {
        /* actual close still required */
      }
      exitTimer = setTimeout(() => finish(false, null), SPEECH_LIMITS.exitMs);
    }, SPEECH_LIMITS.stopMs);
  };
  const fail = () => {
    protocolFault = true;
    readyReject(new SpeechError('WORKER_PROTOCOL'));
    stop();
  };
  child = launch(WINDOWS_SPEECH_EXECUTABLE, ['-NoProfile', '-NonInteractive', '-STA', '-File', WINDOWS_SPEECH_WORKER], {
    shell: false,
    windowsHide: true,
  });
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    if (closed || resolved) return;
    totalBytes += chunk.length;
    if (totalBytes > SPEECH_LIMITS.wireBytes * 4 || buffer.length + chunk.length > SPEECH_LIMITS.wireBytes) {
      fail();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
        const value: unknown = JSON.parse(decoded);
        if (!readySeen) {
          const r = speechObject(value, ['version', 'kind', 'token', 'profile']);
          if (
            r.version !== 1 ||
            r.kind !== 'ready' ||
            canonicalSpeech(r.token) !== canonicalSpeech(token) ||
            canonicalSpeech(r.profile) !== canonicalSpeech(plan.profile) ||
            stopping
          )
            speechFail('READY_MISMATCH');
          readySeen = true;
          if (startup) clearTimeout(startup);
          readyResolve();
        } else {
          const r = speechObject(value, ['version', 'kind', 'token', 'sequence', 'streamId', 'code']);
          if (r.version !== 1) speechFail('WIRE_VERSION');
          receive({ token: r.token, sequence: r.sequence, kind: r.kind, streamId: r.streamId, code: r.code });
        }
      } catch {
        fail();
        return;
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 4096) fail();
  });
  child.on('close', (code: number | null) => {
    closed = true;
    if (buffer.length !== 0) protocolFault = true;
    finish(true, code);
  });
  startup = setTimeout(() => {
    readyReject(new SpeechError('WORKER_STARTUP_TIMEOUT'));
    stop();
  }, SPEECH_LIMITS.startupMs);
  lifetime = setTimeout(stop, SPEECH_LIMITS.startupMs + SPEECH_LIMITS.utteranceMs);
  try {
    write({
      action: 'initialize',
      version: 1,
      parentPid: process.pid,
      token,
      profile: plan.profile,
      expression: plan.expression,
      maxUtteranceMs: plan.maxUtteranceMs,
    });
  } catch {
    fail();
  }
  return Object.freeze({
    ready,
    settled,
    stop,
    dispatch(text: string) {
      if (!readySeen || dispatched || stopping || closed || resolved) speechFail('WORKER_DISPATCH_REFUSED');
      if (Buffer.byteLength(text) > SPEECH_LIMITS.textBytes) speechFail('STDIN_TEXT_LIMIT');
      dispatched = true;
      write({ action: 'speak', text });
    },
  });
}

/** The profile must come from an explicit, separately accepted inventory. No enumeration occurs here. */
export function createWindowsSapiSpeechBackend(profileInput: SpeechProfile): SpeechBackendPort {
  if (process.platform !== 'win32') speechFail('WINDOWS_SAPI_UNSUPPORTED');
  const profile = validateSpeechProfile(profileInput);
  if (profile.voiceBackendId !== 'windows-sapi' || profile.backendVersion !== 'au1-v1')
    speechFail('UNSUPPORTED_PROFILE');
  return Object.freeze({
    capabilities: Object.freeze({
      backendId: 'windows-sapi',
      backendVersion: 'au1-v1',
      kind: 'windows-sapi' as const,
      profiles: Object.freeze([profile]),
    }),
    start: (plan: SpeechPlan, token: ExecutionToken, receive: (event: unknown) => void) =>
      operation(plan, token, receive, nativeLaunch),
  });
}

/** Explicit synthetic seam; the returned capability cannot pass the controller's native/business default. */
export function createSilentSpeechTestBackend(
  profileInput: SpeechProfile,
  launch: SilentSpeechLaunch,
): SpeechBackendPort {
  const profile = validateSpeechProfile(profileInput);
  return Object.freeze({
    capabilities: Object.freeze({
      backendId: profile.voiceBackendId,
      backendVersion: profile.backendVersion,
      kind: 'synthetic' as const,
      profiles: Object.freeze([profile]),
    }),
    start: (plan: SpeechPlan, token: ExecutionToken, receive: (event: unknown) => void) =>
      operation(plan, token, receive, launch),
  });
}
