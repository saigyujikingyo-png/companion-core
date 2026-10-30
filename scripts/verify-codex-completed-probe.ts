/** Local recovery of acceptance evidence after a post-completion harness error.
 * Reads only a named synthetic TEMP probe; never starts Codex or contacts a model.
 * Original evidence stays unchanged. Core recall runs against a SQLite backup. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { qualifyCodexAudit } from '../src/codex-turns.ts';

// Audit qualification is version-pinned. Updating either implementation requires
// a new review and replacing these hashes; a legacy short trace is never a substitute.
const AUDIT_IMPLEMENTATION_HASHES = {
  'scripts/codex-native-probe.ts': '8a35781cee72ad073e369eb5c6b387f9bae3e033ac36a9b45ac0deb5c652a923',
  'src/codex-turns.ts': '684452603b83b40ce6277bd48e900baa13794d3275616824feba6bbaf79ab133',
};

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/verify-codex-completed-probe.ts <synthetic TEMP result.json>');
const reportPath = resolve(input),
  root = dirname(reportPath);
const relativeRoot = relative(tmpdir(), root);
assert.ok(
  !relativeRoot.startsWith('..') && !relativeRoot.includes(sep) && relativeRoot.startsWith('companion-codex-native-'),
);
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceReportHash = sha(reportPath),
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.equal(report.version, 1);
assert.equal(report.productionData, false);
assert.equal(report.model, 'gpt-6.1-sol');
assert.equal(report.realModelTurnRequests, 1);
assert.equal(report.completedModelTurns, 1);
assert.equal(report.completion.status, 'completed');
assert.equal(report.checks.realModelFinal.exactMatch, true);
assert.equal(report.checks.mcpServersExplicitlyDisabledAndNoTools, true);
const snapshotsVerified = Object.entries(AUDIT_IMPLEMENTATION_HASHES).every(([file, hash]) => {
  const path = join(root, 'source-snapshots', file);
  return existsSync(path) && sha(path) === hash;
});
const auditQualification = qualifyCodexAudit(report, snapshotsVerified ? AUDIT_IMPLEMENTATION_HASHES : {});
assert.ok(Array.isArray(report.trace));
const userItems = report.trace.filter((e: any) => e.method === 'item/completed' && e.itemType === 'userMessage');
assert.equal(userItems.length, 1);
assert.equal(userItems[0].threadId, report.completion.threadId);
assert.equal(userItems[0].turnId, report.completion.turnId);
const directory = mkdtempSync(join(tmpdir(), 'companion-codex-verified-'));
const path = join(root, 'synthetic.sqlite'),
  originalDatabaseHash = sha(path);
const source = new DatabaseSync(path, { readOnly: true });
const identityRows = source.prepare('SELECT identity FROM scopes').all();
assert.equal(identityRows.length, 1);
const ids = JSON.parse(identityRows[0]!.identity as string) as string[];
assert.deepEqual(ids.slice(0, 3), ['synthetic-native-probe', 'synthetic-alice', 'fixture']);
assert.equal(ids.length, 4);
const nodes = source.prepare('SELECT type,status,body FROM nodes').all();
assert.equal(nodes.length, 2);
const event = nodes.find((row) => row.type === 'event')!,
  memory = nodes.find((row) => row.type === 'memory')!;
assert.equal(event.status, 'active');
assert.equal(memory.status, 'active');
const prompt =
  'Synthetic fixture only: I prefer cobalt blue. What is 17 + 25? Reply with only the number, no tools or other text.';
assert.deepEqual(JSON.parse(event.body as string), {
  speakerId: 'synthetic-alice',
  speakerRole: 'subject',
  mode: 'self_report',
  selectedText: prompt,
  occurredAt: null,
});
assert.equal(JSON.parse(memory.body as string).statement, 'Synthetic Alice prefers cobalt blue.');
const jobs = source.prepare('SELECT status FROM jobs').all();
assert.deepEqual(
  jobs.map((row) => row.status),
  ['published'],
);
const copyPath = join(directory, 'synthetic-copy.sqlite');
await backup(source, copyPath);
source.close();
const store = new MemoryStore(copyPath);
const scope = store.ensureScope({ tenantId: ids[0]!, subjectId: ids[1]!, personaId: ids[2]!, relationshipId: ids[3]! });
assert.equal(store.search(scope, 'cobalt blue').length, 1);
const runtime = store.diagnostics();
store.close();
assert.equal(sha(path), originalDatabaseHash);
assert.equal(sha(reportPath), sourceReportHash);
const result = {
  version: 1,
  status:
    auditQualification.zeroToolStatus === 'PASS'
      ? 'PASS_COMPLETED_NATIVE_TURN_AND_PERSISTED_SYNTHETIC_MEMORY'
      : 'PARTIAL_COMPLETED_NATIVE_TURN_AND_PERSISTED_SYNTHETIC_MEMORY',
  originalReport: reportPath,
  originalOverallStatus: report.status,
  originalFailure: report.failure,
  originalReportSha256: sourceReportHash,
  originalDatabaseSha256: originalDatabaseHash,
  completion: report.completion,
  realModelCallsThisVerification: 0,
  originalRealModelTurnRequests: 1,
  memoryProvider: 'deterministic-synthetic',
  nativeDuplicateReplay:
    snapshotsVerified && report.checks.nativeEventReplayIdempotent === true ? 'PASS' : 'NOT_ACCEPTED',
  checks: [
    'completed-model-turn',
    'expected-final-output',
    'matching-native-user-item',
    'one-active-source',
    'one-published-memory',
    'source-text-and-speaker',
    'core-recall-from-backup',
    'original-evidence-unchanged',
    ...(auditQualification.zeroToolStatus === 'PASS' ? ['zero-tool-items', 'no-approval-requests'] : []),
  ],
  runtime,
  copyPath,
  snapshotsVerified,
  ...auditQualification,
  zeroToolBasis:
    auditQualification.zeroToolStatus === 'PASS' ? 'pinned-complete-transport-and-stream-counter' : 'NOT_ACCEPTED',
  originalTraceEntries: report.trace.length,
  originalSourceHashes: report.sourceHashes,
};
const output = join(directory, 'result.json');
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      status: result.status,
      reportPath: output,
      runtime,
      zeroToolStatus: result.zeroToolStatus,
      retainedTraceToolItems: result.retainedTraceToolItems,
      originalOverallStatus: report.status,
      realModelCallsThisVerification: 0,
    },
    null,
    2,
  ),
);
