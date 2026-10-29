import { canonical, copyJson, oneOf, shape, stop } from './wf1-json.ts';
import {
  FACTORY_BASELINE_DIGEST,
  QA,
  QA_PROFILE_DIGEST,
  QA_TARGET_BASELINE_DIGEST,
  validateAuditSpec,
} from './corpus-qa-types.ts';
import type { AuditSelection } from './corpus-qa-types.ts';
import type { QualityAuditStore } from './corpus-qa-store.ts';
import type { QaSelectedReader } from './corpus-qa-source.ts';
import { exportQualityAudit, qaSummary, runQualityAudit, verifyQualityAudit } from './corpus-qa-runner.ts';
import type { QaTransport } from './corpus-qa-runner.ts';
export type QaCommandPorts = {
  store?: QualityAuditStore;
  source?: QaSelectedReader;
  selection?: AuditSelection;
  objective?: string;
  transport?: QaTransport;
  signal?: AbortSignal;
};
export async function runQualityAuditCommand(raw: unknown, ports: QaCommandPorts = {}) {
  const c = shape(copyJson(raw), ['version', 'command', 'spec']);
  if (c.version !== 'CorpusQualityAuditCommand/0.1') stop('CQA_COMMAND');
  const command = oneOf(c.command, ['describe', 'run', 'inspect', 'verify', 'export-index']);
  if (command === 'describe') {
    if (c.spec !== null) stop('CQA_COMMAND');
    return {
      version: 'CorpusQualityAuditDescription/0.1',
      profile: QA,
      profileDigest: QA_PROFILE_DIGEST,
      baselineDigest: FACTORY_BASELINE_DIGEST,
      auditTargetBaselineDigest: QA_TARGET_BASELINE_DIGEST,
      coordinator: 'deepseek/deepseek-flash',
      reviewer: 'together/openai/gpt-oss-120b',
      trainingReady: false,
    };
  }
  const spec = validateAuditSpec(c.spec),
    store = ports.store,
    source = ports.source;
  if (!store || !source || canonical(spec) !== canonical(store.spec) || source.selectionDigest !== spec.selectionDigest)
    stop('CQA_BINDING');
  if (command === 'run') {
    if (!ports.selection || ports.objective === undefined || !ports.transport) stop('CQA_PORT');
    return runQualityAudit(spec, {
      store,
      source,
      selection: ports.selection,
      objective: ports.objective,
      transport: ports.transport,
      ...(ports.signal ? { signal: ports.signal } : {}),
    });
  }
  if (command === 'export-index') return exportQualityAudit(store, source);
  const result = verifyQualityAudit(store, source);
  return qaSummary(result.state, result.selection);
}
