import { canonical, copyJson, oneOf, shape, stop } from './wf1-json.ts';
import {
  FACTORY_BASELINE_DIGEST,
  PRODUCTION,
  PRODUCTION_DIGEST,
  STUDENT_TARGET,
  parseProductionJson,
  validateProductionRegistry,
  validateProductionSpec,
} from './corpus-production-types.ts';
import type { ProductionRegistry } from './corpus-production-types.ts';
import type { ProductionStore } from './corpus-production-store.ts';
import { productionSummary, runCorpusProduction, verifyProduction } from './corpus-production-runner.ts';
import type { ProductionTransport } from './corpus-production-runner.ts';
import { exportProduction, verifyProductionExport } from './corpus-production-artifacts.ts';
import { measureProductionTokens, verifyProductionTokens } from './corpus-production-tokenizer.ts';

export type ProductionCommandPorts = {
  store?: ProductionStore;
  objective?: string;
  registry?: ProductionRegistry;
  transport?: ProductionTransport;
  signal?: AbortSignal;
  tokenizer?: { profile: unknown; pythonPath: string };
};
/** Trusted host owns paths, custody and fresh authority. Exact command inputs contain no keys. */
export async function runCorpusProductionCommand(raw: unknown, ports: ProductionCommandPorts = {}) {
  const c = shape(copyJson(raw), ['version', 'command', 'spec']);
  if (c.version !== 'CorpusProductionCommand/0.1') stop('CPR_COMMAND');
  const command = oneOf(c.command, [
    'describe',
    'run',
    'inspect',
    'verify',
    'measure-tokens',
    'verify-tokens',
    'export',
  ]);
  if (command === 'describe') {
    if (c.spec !== null) stop('CPR_COMMAND');
    return {
      version: 'CorpusProductionDescription/0.1',
      profile: PRODUCTION,
      profileDigest: PRODUCTION_DIGEST,
      studentTarget: STUDENT_TARGET,
      factoryBaselineDigest: FACTORY_BASELINE_DIGEST,
      commands: ['run', 'inspect', 'verify', 'measure-tokens', 'verify-tokens', 'export'],
      transport: 'DEEPSEEK_OFFICIAL_API_ONLY',
      trainingReady: false,
    };
  }
  const spec = validateProductionSpec(c.spec),
    store = ports.store;
  if (!store || canonical(spec) !== canonical(store.spec)) stop('CPR_BINDING');
  if (command === 'run') {
    if (ports.objective === undefined || !ports.registry || !ports.transport) stop('CPR_PORT');
    return runCorpusProduction(spec, {
      store,
      objective: ports.objective,
      registry: ports.registry,
      transport: ports.transport,
      ...(ports.signal ? { signal: ports.signal } : {}),
    });
  }
  if (command === 'measure-tokens' || command === 'verify-tokens') {
    if (!ports.tokenizer) stop('CPR_PORT');
    return (command === 'measure-tokens' ? measureProductionTokens : verifyProductionTokens)(
      store,
      ports.tokenizer.profile,
      ports.tokenizer.pythonPath,
    );
  }
  if (command === 'export') return exportProduction(store);
  const state = verifyProduction(store);
  if (command === 'verify' && state.exportRef) verifyProductionExport(store);
  const registry = validateProductionRegistry(
    parseProductionJson(store.read(state.registryRef).toString('utf8')),
    spec,
  );
  return productionSummary(state, registry);
}
