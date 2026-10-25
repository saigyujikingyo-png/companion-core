import { CoreError, fail, text } from './validation.ts';
import { bounded, timeoutMs } from './runtime.ts';

export type CodexTerminal = Readonly<{ threadId: string; turnId: string; status: 'completed' | 'interrupted' | 'failed' }>;
type Waiter = { resolve: (terminal: CodexTerminal) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; deadline: number };

/** Acceptance counters cover the entire stream independently of any bounded
 * display/evidence trace. Text-only probes allow no other item kinds. */
export class CodexNotificationAudit {
  #observedNotifications = 0;
  #forbiddenToolItems = 0;
  observe(notification: unknown): void {
    this.#observedNotifications++;
    if (typeof notification !== 'object' || notification === null) return;
    const n = notification as { method?: unknown; params?: { item?: { type?: unknown } } };
    const type = n.params?.item?.type;
    if (type !== undefined && !['userMessage','agentMessage','reasoning'].includes(type as string)) this.#forbiddenToolItems++;
  }
  get metrics(): Readonly<{ observedNotifications: number; forbiddenToolItems: number }> {
    return { observedNotifications:this.#observedNotifications, forbiddenToolItems:this.#forbiddenToolItems };
  }
}

export type CodexProbePlan = Readonly<{ mode: 'initialize-only' | 'completion-only' | 'interrupt-only' | 'complete-and-interrupt';
  runCompletion: boolean; runInterrupt: boolean; maxRealTurns: number }>;
export function codexProbePlan(args: readonly string[]): CodexProbePlan {
  const modes = args.filter(arg => ['--initialize-only','--completion-only','--interrupt-only'].includes(arg));
  if (modes.length > 1) fail('CODEX_CONFLICTING_PROBE_MODES');
  const mode = modes[0]?.slice(2) as Exclude<CodexProbePlan['mode'], 'complete-and-interrupt'> | undefined;
  const runCompletion = mode === undefined || mode === 'completion-only';
  const runInterrupt = mode === undefined || mode === 'interrupt-only';
  return Object.freeze({ mode:mode ?? 'complete-and-interrupt', runCompletion, runInterrupt,
    maxRealTurns:Number(runCompletion) + Number(runInterrupt) });
}
/** Applied at the actual send boundary, not merely to displayed request counts. */
export function reserveCodexProbeRequest(plan: CodexProbePlan, issuedTurns: number, method: string): number {
  if (!Number.isSafeInteger(issuedTurns) || issuedTurns < 0) fail('CODEX_INVALID_TURN_COUNT');
  if (method === 'turn/interrupt' && !plan.runInterrupt) fail('CODEX_INTERRUPT_DISABLED_BY_MODE');
  if (method !== 'turn/start') return issuedTurns;
  if (issuedTurns >= plan.maxRealTurns) fail('CODEX_TURN_BUDGET_EXHAUSTED');
  return issuedTurns + 1;
}

export type CodexTransportAuditInput = {
  processExited: boolean; processClosed: boolean; processExitCode: number | null; forcedTermination: boolean;
  unparsedStdoutBytes: number; transportFailureCode: string | null; serverRequestsRejected: number;
};
export function codexTransportAudit(input: CodexTransportAuditInput) {
  const complete = input.processExited === true && input.processClosed === true && input.processExitCode === 0 &&
    input.forcedTermination === false && input.unparsedStdoutBytes === 0 && input.serverRequestsRejected === 0 &&
    (input.transportFailureCode === null || input.transportFailureCode === 'CODEX_PROCESS_EXIT');
  return Object.freeze({ ...input, transportAuditVersion:1 as const, transportAuditComplete:complete });
}

/** A short/zero-tool retained trace is not proof of a complete stream. Accept
 * full-stream claims only from a pinned implementation with consistent close,
 * parse, exit, counter and final-status evidence. Positive turn/memory evidence
 * is evaluated separately by the postflight and can survive an incomplete audit. */
export function qualifyCodexAudit(value: unknown, expectedSourceHashes: Readonly<Record<string, string>>) {
  const report = typeof value === 'object' && value !== null ? value as Record<string, any> : {};
  const reasons: string[] = [];
  const entries = Object.entries(expectedSourceHashes);
  if (entries.length < 2 || entries.some(([path, hash]) => !/^[a-f0-9]{64}$/.test(hash) || report.sourceHashes?.[path] !== hash)) reasons.push('UNPINNED_IMPLEMENTATION');
  if (report.transportAuditVersion !== 1 || report.transportAuditComplete !== true) reasons.push('MISSING_COMPLETE_TRANSPORT_AUDIT');
  if (!codexTransportAudit(report as CodexTransportAuditInput).transportAuditComplete) reasons.push('INCOMPLETE_CLOSE_OR_TRANSPORT');
  const statuses = ['PASS_NATIVE_CODEX_COMPLETION_ONLY','PASS_NATIVE_CODEX_SYNTHETIC_MEMORY','PASS_NATIVE_CODEX_INTERRUPT_ONLY','PASS_INITIALIZE_ONLY'];
  if (!statuses.includes(report.status) && !(report.status === 'FAIL' && ['PROBE_ERROR','ACCEPTANCE_ASSERTION'].includes(report.failure))) {
    reasons.push('TRANSPORT_OR_UNRECOGNIZED_FAILURE_STATUS');
  }
  if (statuses.includes(report.status) && report.failure != null) reasons.push('CONTRADICTORY_FAILURE_STATUS');
  if (!Number.isSafeInteger(report.observedNotifications) || report.observedNotifications <= 0 ||
    !Number.isSafeInteger(report.forbiddenToolItems) || report.forbiddenToolItems < 0 ||
    report.forbiddenToolItems > report.observedNotifications || typeof report.traceTruncated !== 'boolean') reasons.push('INVALID_STREAM_COUNTERS');
  const transportComplete = reasons.length === 0;
  if (report.forbiddenToolItems !== 0) reasons.push('ZERO_TOOL_COUNT_NOT_ESTABLISHED');
  const retained = Array.isArray(report.trace) ? report.trace : [];
  return { transportAuditStatus:transportComplete ? 'COMPLETE' as const : 'NOT_ACCEPTED' as const,
    zeroToolStatus:transportComplete && report.forbiddenToolItems === 0 ? 'PASS' as const : 'NOT_ACCEPTED' as const,
    noApprovalRequestsStatus:transportComplete ? 'PASS' as const : 'NOT_ACCEPTED' as const,
    retainedTraceToolItems:retained.filter((entry: any) => entry?.itemType !== undefined && !['userMessage','agentMessage','reasoning'].includes(entry.itemType)).length,
    reasons };
}

/** A small lifecycle observer for an authenticated app-server connection.
 * Subscribe before turn/start: a terminal notification may precede its response.
 * No reasoning, text, tool output, or raw provider error is retained here. */
export class CodexTurnTracker {
  #threadId: string;
  #terminals = new Map<string, CodexTerminal>();
  #waiters = new Map<string, Waiter>();
  #closed = false;
  constructor(threadId: string) { text(threadId, 128); this.#threadId = threadId; }
  receive(notification: unknown): void {
    if (this.#closed || typeof notification !== 'object' || notification === null) return;
    const n = notification as Record<string, unknown>;
    if (n.method !== 'turn/completed' || typeof n.params !== 'object' || n.params === null) return;
    const p = n.params as Record<string, unknown>;
    if (p.threadId !== this.#threadId || typeof p.turn !== 'object' || p.turn === null) return;
    const turn = p.turn as Record<string, unknown>;
    text(turn.id, 256);
    if (turn.status !== 'completed' && turn.status !== 'interrupted' && turn.status !== 'failed') fail('INVALID_CODEX_TERMINAL');
    const old = this.#terminals.get(turn.id);
    if (old) { if (old.status !== turn.status) fail('CONFLICTING_CODEX_TERMINAL'); return; }
    if (this.#terminals.size >= 16) fail('CODEX_TRACKER_CAPACITY');
    const terminal: CodexTerminal = Object.freeze({ threadId:this.#threadId, turnId:turn.id, status:turn.status });
    this.#terminals.set(turn.id, terminal);
    const waiter = this.#waiters.get(turn.id);
    if (waiter) {
      clearTimeout(waiter.timer); this.#waiters.delete(turn.id);
      if (performance.now() >= waiter.deadline) waiter.reject(new Error('CODEX_TERMINAL_TIMEOUT'));
      else waiter.resolve(terminal);
    }
  }
  wait(turnId: string, deadlineMs = 30_000): Promise<CodexTerminal> {
    text(turnId, 256); timeoutMs(deadlineMs);
    if (this.#closed) return Promise.reject(new Error('CODEX_TRACKER_CLOSED'));
    const terminal = this.#terminals.get(turnId);
    if (terminal) return Promise.resolve(terminal);
    if (this.#waiters.has(turnId) || this.#waiters.size >= 16) return Promise.reject(new Error('CODEX_TRACKER_CAPACITY'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiters.delete(turnId); reject(new Error('CODEX_TERMINAL_TIMEOUT')); }, deadlineMs);
      this.#waiters.set(turnId, { resolve, reject, timer, deadline:performance.now() + deadlineMs });
    });
  }
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('CODEX_TRACKER_CLOSED')); }
    this.#waiters.clear(); this.#terminals.clear();
  }
}

/** RPC acknowledgement alone never qualifies native cancellation. A completed
 * race and a failed turn remain distinct from an interrupted turn. */
export async function interruptCodexTurn(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  tracker: CodexTurnTracker, threadId: string, turnId: string, deadlineMs = 30_000
): Promise<CodexTerminal> {
  text(threadId, 128); text(turnId, 256); timeoutMs(deadlineMs);
  const deadline = performance.now() + deadlineMs;
  try {
    return await bounded(new AbortController().signal, deadlineMs, async () => {
      await request('turn/interrupt', { threadId, turnId });
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) fail('CODEX_INTERRUPT_TIMEOUT');
      const terminal = await tracker.wait(turnId, remaining);
      if (terminal.threadId !== threadId) fail('CODEX_THREAD_MISMATCH');
      if (terminal.status !== 'interrupted') fail('CODEX_INTERRUPT_NOT_CONFIRMED');
      return terminal;
    });
  } catch (error) {
    if (error instanceof CoreError && error.code === 'INFERENCE_TIMEOUT') fail('CODEX_INTERRUPT_TIMEOUT');
    throw error;
  }
}
