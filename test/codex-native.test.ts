import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { MemoryStore } from '../src/store.ts';
import { HostMemoryService } from '../src/host.ts';
import { mountCodexHost } from '../src/host-mounts.ts';
import {
  CodexNotificationAudit,
  CodexTurnTracker,
  codexProbePlan,
  codexTransportAudit,
  interruptCodexTurn,
  qualifyCodexAudit,
  reserveCodexProbeRequest,
} from '../src/codex-turns.ts';
import type { InferenceAdapter, Proposal } from '../src/contracts.ts';

const terminal = (status: string, turnId = 'turn', threadId = 'thread') => ({
  method: 'turn/completed',
  params: { threadId, turn: { id: turnId, status } },
});
test('completion-only allows one actual turn reservation and never permits native interrupt', () => {
  const plan = codexProbePlan(['--allow-real-model', '--completion-only']);
  assert.deepEqual(plan, { mode: 'completion-only', runCompletion: true, runInterrupt: false, maxRealTurns: 1 });
  const count = reserveCodexProbeRequest(plan, 0, 'turn/start');
  assert.equal(count, 1);
  assert.throws(() => reserveCodexProbeRequest(plan, count, 'turn/start'), { code: 'CODEX_TURN_BUDGET_EXHAUSTED' });
  assert.throws(() => reserveCodexProbeRequest(plan, count, 'turn/interrupt'), {
    code: 'CODEX_INTERRUPT_DISABLED_BY_MODE',
  });
  assert.throws(() => codexProbePlan(['--completion-only', '--interrupt-only']), {
    code: 'CODEX_CONFLICTING_PROBE_MODES',
  });
  assert.equal(codexProbePlan(['--initialize-only']).maxRealTurns, 0);
});
test('zero-tool acceptance requires pinned implementation, full drain, clean transport, and consistent status', () => {
  const hashes = { 'scripts/codex-native-probe.ts': 'a'.repeat(64), 'src/codex-turns.ts': 'b'.repeat(64) };
  const clean = {
    processExited: true,
    processClosed: true,
    processExitCode: 0,
    forcedTermination: false,
    unparsedStdoutBytes: 0,
    transportFailureCode: 'CODEX_PROCESS_EXIT',
    serverRequestsRejected: 0,
  };
  const report = {
    ...codexTransportAudit(clean),
    status: 'PASS_NATIVE_CODEX_COMPLETION_ONLY',
    sourceHashes: hashes,
    observedNotifications: 18,
    forbiddenToolItems: 0,
    traceTruncated: false,
    trace: [],
  };
  assert.equal(qualifyCodexAudit(report, hashes).zeroToolStatus, 'PASS');
  for (const change of [
    { status: 'FAIL_FINAL_TRANSPORT_AUDIT' },
    { status: 'FAIL_FINAL_TRANSPORT_AUDIT', transportFailureCode: 'CODEX_PROTOCOL_INVALID' },
    { status: 'FAIL', failure: 'CODEX_PROTOCOL_INVALID', processClosed: false },
    { status: 'FAIL_NATIVE_DISPOSAL' },
    { processClosed: false },
    { processExited: false },
    { processExitCode: 1 },
    { forcedTermination: true },
    { unparsedStdoutBytes: 1 },
    { transportFailureCode: 'CODEX_PROTOCOL_INVALID' },
    { transportFailureCode: 'CODEX_NOTIFICATION_REJECTED' },
    { serverRequestsRejected: 1 },
    { transportAuditComplete: false },
    { transportAuditVersion: 2 },
    { observedNotifications: 0 },
    { observedNotifications: NaN },
    { forbiddenToolItems: 1 },
    { traceTruncated: undefined },
    { sourceHashes: { ...hashes, 'scripts/codex-native-probe.ts': 'c'.repeat(64) } },
    { failure: 'CODEX_PROTOCOL_INVALID' },
  ]) {
    assert.equal(
      qualifyCodexAudit({ ...report, ...change }, hashes).zeroToolStatus,
      'NOT_ACCEPTED',
      JSON.stringify(change),
    );
  }
  assert.equal(qualifyCodexAudit(report, {}).zeroToolStatus, 'NOT_ACCEPTED');
  // A bounded trace may truncate while the separately counted, fully drained
  // transport remains complete; its trace length cannot decide this claim.
  assert.equal(
    qualifyCodexAudit({ ...report, traceTruncated: true, observedNotifications: 700 }, hashes).zeroToolStatus,
    'PASS',
  );
  const incomplete = codexTransportAudit({ ...clean, processClosed: false });
  assert.equal(incomplete.transportAuditComplete, false);
});
test('legacy short traces retain positive observations without granting a full-stream zero-tool claim', () => {
  const legacy = {
    status: 'FAIL',
    failure: 'PROBE_ERROR',
    processExitCode: 0,
    processExited: true,
    observedNotifications: 18,
    forbiddenToolItems: 0,
    traceTruncated: false,
    trace: [{ itemType: 'userMessage' }, { itemType: 'agentMessage' }],
    sourceHashes: {},
  };
  const result = qualifyCodexAudit(legacy, {});
  assert.equal(result.zeroToolStatus, 'NOT_ACCEPTED');
  assert.equal(result.noApprovalRequestsStatus, 'NOT_ACCEPTED');
  assert.equal(result.retainedTraceToolItems, 0);
  assert.equal(result.transportAuditStatus, 'NOT_ACCEPTED');
});
test('tool events after a 512-entry trace remain visible to full-stream acceptance counters', () => {
  const audit = new CodexNotificationAudit();
  const boundedTrace: unknown[] = [];
  for (let index = 0; index < 600; index++) {
    const event = { method: 'item/agentMessage/delta', params: { delta: 'synthetic' } };
    audit.observe(event);
    if (boundedTrace.length < 512) boundedTrace.push(event);
  }
  audit.observe({ method: 'item/completed', params: { item: { type: 'commandExecution' } } });
  assert.equal(boundedTrace.length, 512);
  assert.deepEqual(audit.metrics, { observedNotifications: 601, forbiddenToolItems: 1 });
  audit.observe({ method: 'item/completed', params: { item: { type: 'futureUnknownTool' } } });
  assert.equal(audit.metrics.forbiddenToolItems, 2);
});
test('native interrupt needs the matching terminal event, not an RPC acknowledgement', async () => {
  const tracker = new CodexTurnTracker('thread');
  let settled = false;
  const stop = interruptCodexTurn(async () => ({}), tracker, 'thread', 'turn', 1000).then((result) => {
    settled = true;
    return result;
  });
  await tick();
  tracker.receive(terminal('interrupted', 'other'));
  tracker.receive(terminal('interrupted', 'turn', 'other'));
  await tick();
  assert.equal(settled, false);
  tracker.receive(terminal('interrupted'));
  assert.equal((await stop).status, 'interrupted');
  tracker.close();
});
test('terminal before the start/interrupt response is retained, completed/failed are not cancellation', async () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const tracker = new CodexTurnTracker('thread');
    tracker.receive(terminal(status));
    const result = interruptCodexTurn(async () => ({}), tracker, 'thread', 'turn');
    if (status === 'interrupted') assert.equal((await result).status, status);
    else await assert.rejects(result, { code: 'CODEX_INTERRUPT_NOT_CONFIRMED' });
    tracker.close();
  }
});
test('native lifecycle timeout, invalid/conflicting terminal and close fail closed', async () => {
  const tracker = new CodexTurnTracker('thread');
  await assert.rejects(
    interruptCodexTurn(async () => ({}), tracker, 'thread', 'turn', 5),
    /CODEX_(TERMINAL|INTERRUPT)_TIMEOUT/,
  );
  assert.throws(() => tracker.receive(terminal('inProgress')), { code: 'INVALID_CODEX_TERMINAL' });
  tracker.receive(terminal('completed'));
  tracker.receive(terminal('completed'));
  assert.throws(() => tracker.receive(terminal('interrupted')), { code: 'CONFLICTING_CODEX_TERMINAL' });
  const waiting = tracker.wait('pending');
  const rejected = assert.rejects(waiting, /CODEX_TRACKER_CLOSED/);
  tracker.close();
  await rejected;
});
test('native interrupt bounds a hung acknowledgement and consumes a late rejection', async () => {
  const tracker = new CodexTurnTracker('thread');
  let reject!: (error: Error) => void;
  const request = new Promise<unknown>((_, no) => {
    reject = no;
  });
  await assert.rejects(
    interruptCodexTurn(() => request, tracker, 'thread', 'turn', 5),
    { code: 'CODEX_INTERRUPT_TIMEOUT' },
  );
  reject(new Error('late synthetic failure'));
  await tick();
  tracker.close();
});
test('Codex mount selects completed user text, persists recall and rejects replay after unmount', async () => {
  const store = new MemoryStore(':memory:');
  const identity = { tenantId: 'synthetic', subjectId: 'alice', personaId: 'fixture', relationshipId: 'probe' };
  const scope = store.ensureScope(identity);
  let calls = 0;
  const provider: InferenceAdapter = {
    capabilities: {
      providerId: 'synthetic',
      modelVersion: '1',
      input: ['text'],
      structuredOutput: 'validated',
      cancellation: 'local_drop_only',
    },
    async proposeMemory({ selectedEvidence }) {
      calls++;
      return {
        kind: 'claim',
        basis: 'self_report',
        statement: selectedEvidence[0]!.selectedText,
        validFrom: null,
        validTo: null,
      };
    },
  };
  const service = new HostMemoryService(store, provider);
  const binding = service.bind({
    identity,
    host: 'codex-app-server',
    hostInstanceId: 'synthetic',
    sessionId: 'thread',
  });
  let callback!: (n: unknown) => void,
    receipts = 0;
  const errors: unknown[] = [];
  const off = mountCodexHost(
    {
      onNotification(cb) {
        callback = cb;
        return () => {};
      },
    },
    service,
    binding,
    {
      threadId: 'thread',
      onReceipt() {
        receipts++;
      },
      onError(error) {
        errors.push(error);
      },
    },
  );
  const event = {
    method: 'item/completed',
    nativeExtension: 'synthetic metadata',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      completedAtMs: 10,
      nativeExtension: true,
      item: {
        id: 'message',
        type: 'userMessage',
        clientId: null,
        content: [{ type: 'text', text: 'synthetic blue', text_elements: [] }],
      },
    },
  };
  callback({ ...event, method: 'item/started' });
  callback({ ...event, params: { ...event.params, threadId: 'foreign' } });
  callback({ ...event, params: { ...event.params, item: { ...event.params.item, type: 'agentMessage' } } });
  await tick();
  assert.equal(calls, 0);
  callback(event);
  await tick();
  assert.equal(store.search(scope, 'blue').length, 1);
  await assert.rejects(service.extract(binding, JSON.stringify({ version: 1, operation: 'extract_memory', event })), {
    code: 'INVALID_WIRE_SHAPE',
  });
  callback({ ...event, params: { ...event.params, completedAtMs: 20 } });
  await tick();
  assert.equal(calls, 1);
  assert.equal(receipts, 2);
  assert.deepEqual(errors, []);
  off();
  off();
  callback(event);
  await tick();
  assert.equal(receipts, 2);
  store.close();
});
test('unmount aborts a pending Codex extraction and discards its late provider output', async () => {
  const store = new MemoryStore(':memory:');
  const identity = { tenantId: 'synthetic', subjectId: 'alice', personaId: 'fixture', relationshipId: 'late' };
  const scope = store.ensureScope(identity);
  let finish!: (v: Proposal) => void;
  const provider: InferenceAdapter = {
    capabilities: {
      providerId: 'synthetic',
      modelVersion: '1',
      input: ['text'],
      structuredOutput: 'validated',
      cancellation: 'local_drop_only',
    },
    proposeMemory() {
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const service = new HostMemoryService(store, provider);
  const binding = service.bind({
    identity,
    host: 'codex-app-server',
    hostInstanceId: 'synthetic',
    sessionId: 'thread',
  });
  let callback!: (n: unknown) => void;
  let callbacks = 0;
  const off = mountCodexHost(
    {
      onNotification(cb) {
        callback = cb;
        return () => {};
      },
    },
    service,
    binding,
    {
      threadId: 'thread',
      onReceipt() {
        callbacks++;
      },
      onError() {
        callbacks++;
      },
    },
  );
  callback({
    method: 'item/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      completedAtMs: 10,
      item: { id: 'message', type: 'userMessage', content: [{ type: 'text', text: 'synthetic blue' }] },
    },
  });
  await tick();
  off();
  finish({ kind: 'claim', basis: 'self_report', statement: 'synthetic blue', validFrom: null, validTo: null });
  await tick();
  assert.equal(store.search(scope, 'blue').length, 0);
  assert.equal(callbacks, 0);
  store.close();
});
