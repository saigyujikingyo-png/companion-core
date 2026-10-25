/** Explicitly opt-in native inference acceptance. Never run from npm test/check.
 * Uses installed Codex's normal login without opening/copying auth material. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore } from '../src/store.ts';
import { HostMemoryService } from '../src/host.ts';
import { mountCodexHost } from '../src/host-mounts.ts';
import { CodexNotificationAudit, CodexTurnTracker, codexProbePlan, codexTransportAudit,
  interruptCodexTurn, reserveCodexProbeRequest } from '../src/codex-turns.ts';
import { CoreError } from '../src/validation.ts';
import type { InferenceAdapter } from '../src/contracts.ts';

const args = process.argv.slice(2), binary = args[args.indexOf('--codex') + 1];
const plan = codexProbePlan(args);
const initializeOnly = plan.mode === 'initialize-only';
const isolatedNoAuth = args.includes('--isolated-no-auth');
const disabledMcp = args.flatMap((arg, index) => arg === '--disable-mcp' ? [args[index + 1]] : []);
if (disabledMcp.some(name => !name || !/^[A-Za-z0-9_-]{1,80}$/.test(name))) throw new Error('Invalid MCP server name');
if (isolatedNoAuth && !initializeOnly) throw new Error('Isolated no-auth mode is initialize-only');
if ((!args.includes('--allow-real-model') && !initializeOnly) || !args.includes('--codex') || !binary || !isAbsolute(binary)) {
  throw new Error('Usage: node scripts/codex-native-probe.ts (--allow-real-model | --initialize-only) --codex <absolute installed binary>');
}
const root = mkdtempSync(join(tmpdir(), 'companion-codex-native-'));
const cwd = join(root, 'empty-workspace'); mkdirSync(cwd);
const logs = join(root, 'native-runtime'); mkdirSync(logs);
const reportPath = join(root, 'result.json');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const model = 'gpt-6.1-sol';
const report: Record<string, unknown> = { version:1, status:'NOT_STARTED', startedAt:new Date().toISOString(), model,
  realModelTurnRequests:0, completedModelTurns:0, productionData:false, memoryExtractionProvider:'deterministic-synthetic',
  nativeAuthentication:'existing-login-managed-by-native-codex', credentialsReadByProbe:false,
  ephemeral:true, cwd, reportPath, mode:plan.mode, maxRealTurns:plan.maxRealTurns,
  rawProtocolOrReasoningSavedByProbe:false, checks:{}, commands:[], sourceHashes:{} };
const checks = report.checks as Record<string, unknown>;
const sourceHashes = report.sourceHashes as Record<string, string>;
for (const path of ['src/host-mounts.ts','src/codex-turns.ts','src/host.ts','src/wire.ts','src/store.ts','scripts/codex-native-probe.ts']) {
  const source = readFileSync(new URL('../' + path, import.meta.url));
  sourceHashes[path] = sha(source);
  const snapshot = join(root, 'source-snapshots', path); mkdirSync(dirname(snapshot), { recursive:true });
  writeFileSync(snapshot, source);
}
const persist = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
persist(); console.log(JSON.stringify({ reportPath, status:'PREPARING', realModelTurnRequests:0 }));

// Child-only overrides; no user-level config or credential file is modified.
const disabled = ['apps','plugins','hooks','memories','shell_tool','unified_exec','shell_snapshot','browser_use',
  'browser_use_external','computer_use','image_generation','view_image','multi_agent','skill_search','goals','sleep_tool'];
const overrides = ['analytics.enabled=false','history.persistence="none"','project_doc_max_bytes=0','web_search="disabled"',
  'model_reasoning_effort="low"','model_reasoning_summary="none"','features.skip_host_skill_discovery=true',
  'windows.sandbox="unelevated"',`log_dir=${JSON.stringify(logs)}`,
  ...disabledMcp.map(name => `mcp_servers.${name}.enabled=false`),
  ...disabled.map(name => `features.${name}=false`)];
const commandArgs = ['app-server','--stdio', ...overrides.flatMap(value => ['-c', value])];
report.commands = [[binary, '--version'], [binary, ...commandArgs]];
let processExit: number | null = null, processExited = false, processClosed = false, exitSignal: string | null = null, forcedTermination = false, serverRequests = 0;
let buffer = '', stderrBytes = 0, fatal: Error | null = null, nextId = 1;
const subscribers = new Set<(value: unknown) => void>();
const pending = new Map<number, { resolve:(value:any) => void; reject:(reason:Error) => void; timer:ReturnType<typeof setTimeout> }>();
const transcript: Record<string, unknown>[] = [];
const audit = new CodexNotificationAudit();
let traceTruncated = false;
const note = (record: Record<string, unknown>) => {
  if (transcript.length < 512) transcript.push({ atMs:Math.round(performance.now()), ...record });
  else traceTruncated = true;
};
const classifyError = (error: any) => {
  const message = typeof error?.message === 'string' ? error.message : '';
  return /unauthori|authenticat|sign.in|log.in|401/i.test(message) ? 'AUTHENTICATION' :
    /quota|rate.limit|usage.limit|429/i.test(message) ? 'QUOTA_OR_RATE_LIMIT' :
    /network|connect|dns|tls|timed.out|timeout/i.test(message) ? 'NETWORK_OR_TIMEOUT' : 'OTHER_NATIVE_ERROR';
};
const env = { ...process.env, RUST_LOG:'off', ...(isolatedNoAuth ? { CODEX_HOME:join(root, 'isolated-codex-home') } : {}) }; // Passed through, never enumerated or saved.
if (isolatedNoAuth) { mkdirSync(join(root, 'isolated-codex-home')); report.nativeAuthentication = 'isolated-no-auth-diagnostic'; }
report.nativeRuntimeState = isolatedNoAuth ? 'isolated-temp-home' : 'native-default-explicitly-authorized';
report.codexVersion = execFileSync(binary, ['--version'], { cwd, env, encoding:'utf8', timeout:10_000, windowsHide:true, stdio:['ignore','pipe','ignore'] }).trim();
const child = spawn(binary, commandArgs, { cwd, env, windowsHide:true, stdio:['pipe','pipe','pipe'] });
report.childPid = child.pid;
const failTransport = (code: string) => {
  if (fatal && !(fatal.message === 'CODEX_PROCESS_EXIT' && code !== 'CODEX_PROCESS_EXIT')) return;
  fatal = new Error(code);
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(fatal); }
  pending.clear();
};
child.on('error', () => failTransport('CODEX_PROCESS_ERROR'));
child.on('exit', (code, signal) => { processExit = code; processExited = true; exitSignal = signal; failTransport('CODEX_PROCESS_EXIT'); });
child.on('close', () => { processClosed = true; });
child.stdin.on('error', () => failTransport('CODEX_STDIN_ERROR'));
child.stderr.on('data', (chunk: Buffer) => {
  stderrBytes += chunk.length;
  if (/error loading configuration|missing field|invalid.{0,30}(config|toml|type)|failed to parse/i.test(chunk.toString('utf8'))) report.nativeStartupCategory = 'CONFIGURATION';
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  // Node exit can precede the final stdout drain; keep auditing until close.
  if (fatal && fatal.message !== 'CODEX_PROCESS_EXIT') return;
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 1_048_576) { failTransport('CODEX_PROTOCOL_TOO_LARGE'); return; }
  let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let value: any; try { value = JSON.parse(line); } catch { failTransport('CODEX_PROTOCOL_INVALID'); return; }
    if (!value || typeof value !== 'object') { failTransport('CODEX_PROTOCOL_INVALID'); return; }
    if (value.id !== undefined && typeof value.method === 'string') {
      serverRequests++;
      // Do not approve tools, authentication changes, or elicitation. Never log payloads.
      child.stdin.write(JSON.stringify({ id:value.id, error:{ code:-32601, message:'Unsupported in synthetic probe' } }) + '\n');
      failTransport('CODEX_UNEXPECTED_SERVER_REQUEST'); return;
    }
    if (typeof value.id === 'number') {
      const entry = pending.get(value.id); if (!entry) continue;
      clearTimeout(entry.timer); pending.delete(value.id);
      if (value.error) { report.rpcErrorCode = typeof value.error.code === 'number' ? value.error.code : null; report.nativeErrorCategory = classifyError(value.error); entry.reject(new Error('CODEX_RPC_ERROR')); }
      else entry.resolve(value.result);
    } else if (typeof value.method === 'string') {
      audit.observe(value);
      const p = value.params, item = p?.item;
      if (value.method === 'error' || p?.turn?.error) report.nativeErrorCategory = classifyError(p?.turn?.error ?? p?.error ?? p);
      note({ method:value.method, ...(typeof p?.threadId === 'string' ? { threadId:p.threadId } : {}),
        ...(typeof p?.turnId === 'string' ? { turnId:p.turnId } : {}),
        ...(typeof p?.turn?.status === 'string' ? { status:p.turn.status, turnId:p.turn.id } : {}),
        ...(typeof item?.type === 'string' ? { itemType:item.type, itemId:item.id } : {}) });
      try { for (const subscriber of subscribers) subscriber(value); }
      catch { failTransport('CODEX_NOTIFICATION_REJECTED'); }
    }
  }
});
async function request(method: string, params: Record<string, unknown>, deadlineMs = 20_000): Promise<any> {
  if (fatal) throw fatal;
  report.realModelTurnRequests = reserveCodexProbeRequest(plan, report.realModelTurnRequests as number, method);
  if (method === 'turn/start') persist();
  const id = nextId++;
  note({ request:method, id });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CODEX_RPC_TIMEOUT')); }, deadlineMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const context = { onNotification(callback: (value: unknown) => void) { subscribers.add(callback); return () => { subscribers.delete(callback); }; } };
const store = new MemoryStore(join(root, 'synthetic.sqlite'));
let unmount: (() => void) | undefined, tracker: CodexTurnTracker | undefined;
try {
  report.status = 'RUNNING';
  report.phase = 'initialize';
  await request('initialize', { clientInfo:{ name:'companion_core_native_probe', title:'Companion synthetic native probe', version:'0.1.0' }, capabilities:{ experimentalApi:false } }, 60_000);
  checks.initialize = true;
  child.stdin.write(JSON.stringify({ method:'initialized' }) + '\n'); checks.initializedNotificationSent = true;
  if (initializeOnly) { report.status = 'PASS_INITIALIZE_ONLY'; report.phase = 'complete'; }
  else {
  report.phase = 'thread_start';
  const started = await request('thread/start', { model, cwd, ephemeral:true, approvalPolicy:'never', sandbox:'read-only',
    baseInstructions:'You are a text-only synthetic protocol test assistant. Obey the requested output format. Never call any tool, read files, search, delegate, or take an external action.',
    developerInstructions:'Use only the synthetic input. No tools. Do not access memory, files, configuration, credentials, or other conversations.' });
  assert.equal(started.model, model); assert.equal(started.thread.ephemeral, true); assert.equal(started.approvalPolicy, 'never');
  assert.equal(started.sandbox.type, 'readOnly');
  const threadId = started.thread.id as string; report.threadId = threadId; checks.threadStart = true;
  report.phase = 'mcp_isolation';
  const mcp = await request('mcpServerStatus/list', { threadId, detail:'toolsAndAuthOnly', limit:100 });
  report.mcpServerSummary = Array.isArray(mcp.data) ? mcp.data.map((server: any) => ({ name:server.name,
    toolCount:Object.keys(server.tools ?? {}).length, runtimeStatus:typeof server.runtimeStatus === 'string' ? server.runtimeStatus : null })) : null;
  // This native version lists disabled configured servers too. Require each
  // retained entry to be explicitly disabled in this child and expose no tools.
  if (!Array.isArray(mcp.data) || mcp.nextCursor != null || mcp.data.some((server: any) =>
    !disabledMcp.includes(server.name) || Object.keys(server.tools ?? {}).length !== 0 || server.runtimeStatus !== 'disabled')) {
    throw new Error('CODEX_MCP_NOT_ISOLATED');
  }
  checks.mcpServersExplicitlyDisabledAndNoTools = true;
  tracker = new CodexTurnTracker(threadId); context.onNotification(n => tracker!.receive(n));
  const identity = { tenantId:'synthetic-native-probe', subjectId:'synthetic-alice', personaId:'fixture', relationshipId:randomUUID() };
  const scope = store.ensureScope(identity); let memoryCalls = 0, receipts = 0;
  const provider: InferenceAdapter = { capabilities:{ providerId:'synthetic-native-fixture', modelVersion:'1', input:['text'], structuredOutput:'validated', cancellation:'local_drop_only' },
    async proposeMemory({ selectedEvidence }) { memoryCalls++; assert.match(selectedEvidence[0]!.selectedText, /cobalt blue/);
      return { kind:'claim', basis:'self_report', statement:'Synthetic Alice prefers cobalt blue.', validFrom:null, validTo:null }; } };
  const service = new HostMemoryService(store, provider);
  const binding = service.bind({ identity, host:'codex-app-server', hostInstanceId:randomUUID(), sessionId:threadId });
  const memoryErrors: string[] = [];
  unmount = mountCodexHost(context, service, binding, { threadId, onReceipt() { receipts++; }, onError(error) { memoryErrors.push(error.error); } });
  let finalText = '', userEvent: unknown;
  const offCapture = context.onNotification((value: any) => {
    if (value.params?.threadId !== threadId || value.method !== 'item/completed') return;
    if (value.params.item?.type === 'userMessage') userEvent = value;
    if (value.params.item?.type === 'agentMessage') {
      const text = value.params.item.text;
      if (typeof text !== 'string' || text.length > 4096) throw new Error('CODEX_FINAL_TOO_LARGE');
      finalText = text;
    }
  });
  if (plan.runCompletion) {
  const prompt = 'Synthetic fixture only: I prefer cobalt blue. What is 17 + 25? Reply with only the number, no tools or other text.';
  report.phase = 'completed_turn';
  const first = await request('turn/start', { threadId, model, effort:'low', summary:'none', input:[{ type:'text', text:prompt }],
    sandboxPolicy:{ type:'readOnly', networkAccess:false }, approvalPolicy:'never', serviceTierForTurn:'default' });
  const firstTerminal = await tracker.wait(first.turn.id, 60_000);
  report.completion = firstTerminal;
  assert.equal(firstTerminal.status, 'completed'); assert.equal(finalText.trim(), '42');
  report.completedModelTurns = 1; checks.realModelFinal = { exactMatch:true, sha256:sha(finalText) };
  for (let i = 0; receipts === 0 && memoryErrors.length === 0 && i < 100; i++) await delay(10);
  assert.deepEqual(memoryErrors, []); assert.equal(receipts, 1); assert.equal(memoryCalls, 1);
  assert.equal(store.search(scope, 'cobalt blue').length, 1); assert.ok(userEvent);
  checks.nativeItemToStoreRecall = true;
  // Replay the actual selected native event through the same service; no second model request.
  // Native envelopes contain additional metadata; use the same selected profile as the mount.
  const p = (userEvent as any).params, item = p.item;
  const selected = { method:'item/completed', params:{ threadId:p.threadId, turnId:p.turnId, completedAtMs:p.completedAtMs,
    item:{ type:item.type, id:item.id, content:item.content, ...(item.clientId === undefined ? {} : { clientId:item.clientId }) } } };
  await service.extract(binding, JSON.stringify({ version:1, operation:'extract_memory', event:selected }));
  assert.equal(memoryCalls, 1); checks.nativeEventReplayIdempotent = true;
  }
  offCapture(); unmount(); unmount = undefined;
  if (plan.runInterrupt) {
  const before = store.search(scope, 'cobalt blue').length;
  report.phase = 'interrupted_turn';
  const second = await request('turn/start', { threadId, model, effort:'low', summary:'none',
    input:[{ type:'text', text:'Synthetic cancellation test. Write the integers 1 through 5000, one per line. Do not use any tools.' }],
    sandboxPolicy:{ type:'readOnly', networkAccess:false }, approvalPolicy:'never', serviceTierForTurn:'default' });
  // Native start returned inProgress; immediately request bounded interruption.
  report.interruption = await interruptCodexTurn(request, tracker, threadId, second.turn.id, 15_000);
  checks.nativeInterruptConfirmed = true; assert.equal(store.search(scope, 'cobalt blue').length, before);
  checks.unmountedSecondTurnNotStored = true;
  }
  if (fatal) throw fatal;
  assert.equal(serverRequests, 0);
  assert.equal(audit.metrics.forbiddenToolItems, 0); checks.noToolItems = true;
  report.status = plan.mode === 'interrupt-only' ? 'PASS_NATIVE_CODEX_INTERRUPT_ONLY' :
    plan.mode === 'completion-only' ? 'PASS_NATIVE_CODEX_COMPLETION_ONLY' : 'PASS_NATIVE_CODEX_SYNTHETIC_MEMORY';
  report.phase = 'complete';
  }
} catch (error) {
  // Fixed local categories only. Native error strings can carry account details.
  report.status = 'FAIL'; report.failure = error instanceof assert.AssertionError ? 'ACCEPTANCE_ASSERTION' :
    error instanceof Error && /^(CODEX_|INVALID_CODEX_|CONFLICTING_CODEX_)[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_ERROR';
  if (error instanceof CoreError) report.coreErrorCode = error.code;
  process.exitCode = 1;
} finally {
  unmount?.(); tracker?.close(); subscribers.clear(); store.close();
  child.stdin.end();
  for (let i = 0; !processClosed && i < 50; i++) await delay(100);
  if (!processClosed) { forcedTermination = true; child.kill(); for (let i = 0; !processClosed && i < 50; i++) await delay(100); }
  const finalFailure = (fatal as Error | null)?.message ?? null;
  const transportAudit = codexTransportAudit({ processExited, processClosed, processExitCode:processExit, forcedTermination,
    unparsedStdoutBytes:Buffer.byteLength(buffer, 'utf8'), transportFailureCode:finalFailure, serverRequestsRejected:serverRequests });
  Object.assign(report, transportAudit);
  report.exitSignal = exitSignal; report.stderrBytesDiscarded = stderrBytes;
  Object.assign(report, audit.metrics, { traceTruncated });
  report.zeroToolStatus = transportAudit.transportAuditComplete && audit.metrics.forbiddenToolItems === 0 ? 'PASS' : 'NOT_ACCEPTED';
  if ('noToolItems' in checks) checks.noToolItems = report.zeroToolStatus === 'PASS';
  if (String(report.status).startsWith('PASS_') && audit.metrics.forbiddenToolItems !== 0) { report.status = 'FAIL_FORBIDDEN_TOOL_ITEM'; process.exitCode = 1; }
  if (String(report.status).startsWith('PASS_') && !transportAudit.transportAuditComplete) {
    report.status = 'FAIL_FINAL_TRANSPORT_AUDIT'; process.exitCode = 1;
  }
  report.trace = transcript; report.completedAt = new Date().toISOString();
  report.database = join(root, 'synthetic.sqlite');
  if (String(report.status).startsWith('PASS_') && (forcedTermination || processExit !== 0)) { report.status = 'FAIL_NATIVE_DISPOSAL'; process.exitCode = 1; }
  persist(); console.log(JSON.stringify({ status:report.status, failure:report.failure, reportPath, checks,
    mcpServerSummary:report.mcpServerSummary, realModelTurnRequests:report.realModelTurnRequests, processExitCode:processExit, forcedTermination }, null, 2));
}
