import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash, parseJson, shape, stop, text, oneOf, Wf1Error } from './wf1-json.ts';
import { PROFILE_DIGEST, validateSpec } from './wf1-contract.ts';
import { CampaignLedger, createArtifactBroker, HostAuthority, privateRoot } from './wf1-storage.ts';
import { TeachingCampaign } from './wf1-campaign.ts';
import { TeacherProvider } from './wf1-provider.ts';
import { validateSeal } from './wf1-contract.ts';

export const BUILD_FILES = [
  'wf1-types.ts',
  'wf1-json.ts',
  'wf1-contract.ts',
  'wf1-verifier.ts',
  'wf1-storage.ts',
  'wf1-provider.ts',
  'wf1-usage-diagnostic.ts',
  'corpus-response-policy.ts',
  'wf1-campaign.ts',
  'wf1-worker.ts',
  'wf2-teacher-policy.ts',
  'wf2-strict-data.ts',
  'wf2-fixed-slots.ts',
  'wf2-named-data.ts',
  'wf2-together-pilot.ts',
  'wf2-unit-pilot.ts',
  'wf2-response-diagnostic.ts',
  'wf2-failure-diagnostic.ts',
  'wf2-training-root.ts',
  'runtime.ts',
  'validation.ts',
] as const;
export function workerBuildDigest(): string {
  return hash(
    Buffer.concat(
      BUILD_FILES.flatMap((name) => [Buffer.from(name + '\0'), readFileSync(new URL(name, import.meta.url))]),
    ),
  );
}
export function describeWorker() {
  return {
    version: 'wf1-worker-description/1',
    buildDigest: workerBuildDigest(),
    profileDigest: PROFILE_DIGEST,
    command: 'node src/wf1-worker.ts',
    stdinFields: [
      'version',
      'action',
      'runtimeRoot',
      'authorityPath',
      'expectedHead',
      'spec',
      'custodyKeyBase64',
      'objective',
      'credentials',
    ],
    actions: ['prepare', 'run', 'inspect', 'pause', 'revoke'],
    credentialsFields: ['deepseek', 'together'],
    custodyKey: '32 random bytes as canonical base64, injected in anonymous stdin; no DPAPI file access',
    prepare: 'READ_ONLY_NO_LEDGER_NO_API',
    run: 'NEW_CAMPAIGN_ONLY',
    inspect: 'READ_ONLY_RECONCILE_NO_AUTOMATIC_RESUME',
    authoritySchema: {
      schemaVersion: 'wf1-host/1',
      fields: ['campaignId', 'revision', 'runtimeId', 'status', 'expiresAt', 'head', 'rights'],
      statuses: ['ACTIVE', 'PAUSED', 'REVOKED'],
      rights: ['seal', 'coordinate', 'generate', 'review', 'retain'],
    },
    specSchema: {
      schemaVersion: 'wf1-campaign/0.3',
      fields: ['id', 'createdAt', 'expiresAt', 'sourceDigest', 'profileDigest', 'objectiveDigest', 'prices'],
      priceFields: ['snapshotId', 'inputMicroUsdPerMillion', 'completionMicroUsdPerMillion'],
    },
    stdout: 'ONE_ALLOWLISTED_OPERATIONAL_JSON_NO_CONTENT_OR_CREDENTIALS',
    studentInference: 'NOT_RUN',
    studentTraining: 'NOT_RUN',
  };
}
export async function workerMain(raw: string): Promise<unknown> {
  const b = shape(parseJson(raw), [
    'version',
    'action',
    'runtimeRoot',
    'authorityPath',
    'expectedHead',
    'spec',
    'custodyKeyBase64',
    'objective',
    'credentials',
  ]);
  if (b.version !== 1) stop('WF1_VERSION');
  const action = oneOf(b.action, ['prepare', 'run', 'inspect', 'pause', 'revoke']),
    spec = validateSpec(b.spec);
  if (spec.schemaVersion !== 'wf1-campaign/0.3') stop('WF1_VERSION');
  if (spec.sourceDigest !== workerBuildDigest()) stop('WF1_BUILD_MISMATCH');
  const root = privateRoot(text(b.runtimeRoot, 4096)),
    authorityPath = text(b.authorityPath, 4096);
  privateRoot(dirname(authorityPath));
  const rel = relative(root, authorityPath);
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) stop('WF1_AUTHORITY_PATH');
  const host = new HostAuthority(authorityPath, spec.id),
    a = host.read(Date.now(), action === 'prepare' || action === 'run');
  if (b.expectedHead !== a.head) stop('WF1_HEAD_MISMATCH');
  const credentials = shape(b.credentials, ['deepseek', 'together']);
  for (const key of Object.values(credentials)) if (key !== null) text(key, 4096);
  const encoded = text(b.custodyKeyBase64, 64),
    key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) stop('WF1_KEY');
  let campaign: TeachingCampaign | undefined, ledger: CampaignLedger | undefined;
  try {
    if (action === 'pause' || action === 'revoke') {
      host.control(action === 'pause' ? 'PAUSED' : 'REVOKED');
      return { version: 'wf1-operational/1', status: action === 'pause' ? 'PAUSED' : 'REVOKED', apiCalls: 0 };
    }
    if (action === 'inspect') {
      ledger = CampaignLedger.inspect(root, authorityPath, spec.id, key);
      const state = ledger.snapshot();
      let sealedRecovery = 'NOT_CREATED';
      if (state.sealRef)
        try {
          const broker = createArtifactBroker(root, spec.id, key);
          validateSeal(parseJson(broker.custody.read(state.sealRef).toString('utf8')));
          sealedRecovery = 'CUSTODY_READBACK_ONLY';
        } catch {
          sealedRecovery = 'SEALED_UNAVAILABLE';
        }
      return {
        version: 'wf1-operational/1',
        status: 'RECORDED_CLAIMS_ONLY',
        recovery: 'RECONCILE_REQUIRED',
        sealedRecovery,
        attempts: state.attempts.length,
        unsettled: state.attempts.filter(
          (x) => x.outcome === null || x.outcome === 'SUBMIT_UNKNOWN' || x.result?.usage === null,
        ).length,
        automaticResume: false,
        studentInference: 'NOT_RUN',
        studentTraining: 'NOT_RUN',
      };
    }
    if (a.head !== null) stop('WF1_ALREADY_CONSUMED');
    const objective = text(b.objective, 8192);
    if (hash(objective) !== spec.objectiveDigest) stop('WF1_OBJECTIVE_BINDING');
    if (action === 'prepare')
      return {
        version: 'wf1-operational/1',
        status: 'PREPARED_NOT_STARTED',
        apiCalls: 0,
        sourceBound: true,
        profileBound: true,
      };
    if (!credentials.deepseek || !credentials.together) stop('WF1_CREDENTIAL_UNAVAILABLE');
    campaign = TeachingCampaign.admitCampaign({
      root,
      authorityPath,
      spec,
      key,
      objective,
      provider: new TeacherProvider(credentials as { deepseek: string; together: string }),
    });
    return await campaign.run();
  } finally {
    campaign?.close();
    ledger?.close();
    key.fill(0);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--describe')
    process.stdout.write(JSON.stringify(describeWorker()) + '\n');
  else if (process.argv.length !== 2) {
    process.stdout.write(
      JSON.stringify({ version: 'wf1-operational/1', status: 'REFUSED', code: 'WF1_ARGUMENTS' }) + '\n',
    );
    process.exitCode = 1;
  } else {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const part of process.stdin) {
        const chunk = Buffer.from(part);
        bytes += chunk.length;
        if (bytes > 262144) stop('WF1_STDIN_LIMIT');
        chunks.push(chunk);
      }
      const result = await workerMain(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (e) {
      process.stdout.write(
        JSON.stringify({
          version: 'wf1-operational/1',
          status: 'REFUSED_OR_STOPPED',
          code: e instanceof Wf1Error ? e.code : 'WF1_INTERNAL',
          studentInference: 'NOT_RUN',
          studentTraining: 'NOT_RUN',
        }) + '\n',
      );
      process.exitCode = 1;
    }
  }
}
