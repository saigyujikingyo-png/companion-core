import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hash, Wf1Error } from '../src/wf1-json.ts';
import { validateSeal, validatePlan, validateSpec } from '../src/wf1-contract.ts';
import { computeFormal, verifyFormal } from '../src/wf1-verifier.ts';
import { providerBody, TeacherProvider } from '../src/wf1-provider.ts';
import { createArtifactBroker } from '../src/wf1-storage.ts';
import type { ArtifactPort } from '../src/wf1-storage.ts';
import { TeachingCampaign } from '../src/wf1-campaign.ts';
import { MODELS, WF1 } from '../src/wf1-types.ts';
import type { Authority, CampaignSpec, CampaignState, FormalSpec, Operation, Plan, Seal } from '../src/wf1-types.ts';
import {
  WF2_STRICT_PROFILE_DIGEST,
  decodeStrictDataArguments,
  strictDataBinding,
  strictDataSchema,
  validateStrictDataRequest,
} from '../src/wf2-strict-data.ts';
import { bindTrainingRoot, requireTrainingBinding } from '../src/wf2-training-root.ts';
import { bindTeacherCampaign, inspectTeacherCampaign, teacherWorkerBuildDigest } from '../src/wf2-teacher-worker.ts';
import { TeacherControlService } from '../src/wf2-teacher-service.ts';

// Public inert arithmetic only. These fixtures are never teaching content or model-quality evidence.
const marker = 'SYNTHETIC_ONLY_RATIONAL_05',
  capability = '53'.repeat(32),
  key = Buffer.alloc(32, 5);
const error = (code: string) => (e: unknown) => e instanceof Wf1Error && e.code === code;
const formal = (n: number): FormalSpec => ({
  verifier: 'rational.evaluate.v1',
  input: { op: 'value', numerator: String(n), denominator: '1' },
});
const sealed = (): Seal => ({
  version: 'wf1-seal/1',
  rubric: marker,
  cases: Array.from({ length: 12 }, (_, i) => ({
    id: 'sealed' + i,
    roots: ['sealed-root' + i],
    formal: formal(100 + i),
    target: computeFormal(formal(100 + i)),
  })),
});
const plan = (): Plan => ({
  version: 'wf1-plan/1',
  plan: marker,
  families: Array.from({ length: 16 }, (_, i) => ({
    id: 'family' + i,
    roots: ['root' + i],
    split: [3, 7, 11, 15].includes(i) ? 'dev' : 'train',
    formal: formal(i),
  })),
  pairedFamilyIds: Array.from({ length: 8 }, (_, i) => 'family' + i),
});
const payload = (operation: Operation, data: unknown = { fixture: marker }) => ({
  protocol: 'wf1-private-role/1',
  operation,
  role: 'SyntheticRole',
  protocolInstruction: 'unused legacy instruction',
  jsonProfile: { fixture: true },
  outputSchema: { legacy: 'must not be sent' },
  data,
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'companion-wf2-strict-'))),
    approvedTrainingRoot = join(base, 'training'),
    runtimeRoot = join(approvedTrainingRoot, 'run'),
    hostRoot = join(base, 'host');
  mkdirSync(approvedTrainingRoot);
  mkdirSync(runtimeRoot);
  mkdirSync(hostRoot);
  const authorityPath = join(hostRoot, 'authority.json'),
    now = 1000;
  const authority: Authority = {
    schemaVersion: 'wf1-host/1',
    campaignId: 'synthetic-teacher05',
    revision: 1,
    runtimeId: 'synthetic-owner',
    status: 'ACTIVE',
    expiresAt: now + WF1.campaignMs,
    head: null,
    rights: { seal: true, coordinate: true, generate: true, review: true, retain: true },
  };
  writeFileSync(authorityPath, canonical(authority));
  const spec: CampaignSpec = {
    schemaVersion: 'wf1-campaign/0.5',
    id: authority.campaignId,
    createdAt: now,
    expiresAt: now + WF1.campaignMs,
    sourceDigest: teacherWorkerBuildDigest(),
    profileDigest: WF2_STRICT_PROFILE_DIGEST,
    objectiveDigest: hash(marker),
    storageBindingDigest: bindTrainingRoot(approvedTrainingRoot, runtimeRoot).storageBindingDigest,
    prices: {
      deepseek: { snapshotId: 'synthetic-ds', inputMicroUsdPerMillion: 300000, completionMicroUsdPerMillion: 1200000 },
      together: { snapshotId: 'synthetic-tg', inputMicroUsdPerMillion: 150000, completionMicroUsdPerMillion: 600000 },
    },
  };
  const bootstrap = {
    version: 'wf2-teacher-bind/2',
    approvedTrainingRoot,
    runtimeRoot,
    authorityPath,
    expectedHead: null,
    spec,
    custodyKeyBase64: key.toString('base64'),
    objective: marker,
    credentials: { deepseek: 'synthetic-only', together: 'synthetic-only' },
    capability,
  };
  return { base, approvedTrainingRoot, runtimeRoot, authorityPath, now, spec, bootstrap };
}
function inspection(f: ReturnType<typeof fixture>) {
  return {
    version: 'wf2-teacher-inspect/2',
    approvedTrainingRoot: f.approvedTrainingRoot,
    runtimeRoot: f.runtimeRoot,
    authorityPath: f.authorityPath,
    expectedHead: JSON.parse(readFileSync(f.authorityPath, 'utf8')).head,
    spec: f.spec,
    custodyKeyBase64: key.toString('base64'),
  };
}
function state(f: ReturnType<typeof fixture>): CampaignState {
  const db = new DatabaseSync(join(f.runtimeRoot, 'wf1-ledger.sqlite'), { readOnly: true });
  try {
    return JSON.parse(db.prepare('SELECT body FROM events ORDER BY sequence DESC LIMIT 1').get()!.body as string);
  } finally {
    db.close();
  }
}
function files(root: string) {
  return readdirSync(root)
    .sort()
    .map((name) => [name, hash(readFileSync(join(root, name)))]);
}
function toolMessage(name: string, raw: unknown) {
  return {
    role: 'assistant',
    content: null as string | null,
    tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name, arguments: raw } }],
  };
}
function response(message: unknown, finish = 'tool_calls', model: string = MODELS.deepseek, known = true) {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ index: 0, message, finish_reason: finish }],
      ...(known ? { usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function mock(
  options: {
    wrongFirst?: boolean;
    unknownUsage?: boolean;
    pointerStage?: 'seal' | 'plan';
    onSend?: (raw: string, url: string) => void;
  } = {},
) {
  const operations: string[] = [];
  const provider = new TeacherProvider(
    { deepseek: 'synthetic-only', together: 'synthetic-only' },
    {
      fetch: async (url, init) => {
        const raw = String(init!.body),
          body = JSON.parse(raw),
          p = JSON.parse(body.messages[1].content);
        operations.push(p.operation);
        options.onSend?.(raw, String(url));
        assert.equal(body.messages.length, 2);
        assert.equal(p.outputSchema, undefined);
        assert.ok(!raw.includes('json.pointer.v1'));
        assert.equal(Buffer.byteLength(raw) <= WF1.requestBytes, true);
        let content: unknown;
        if (p.operation === 'seal') {
          const s = sealed();
          if (options.pointerStage === 'seal') {
            s.cases[0]!.formal = { verifier: 'json.pointer.v1', input: { document: { x: 1 }, pointer: '/x' } };
            s.cases[0]!.target = 1;
          }
          content = s;
        } else if (p.operation === 'plan') {
          const value = plan();
          if (options.pointerStage === 'plan')
            value.families[0]!.formal = { verifier: 'json.pointer.v1', input: { document: { x: 1 }, pointer: '/x' } };
          content = value;
        } else if (p.operation === 'rubric') content = { version: 'wf1-rubric/1', rubric: marker };
        else if (p.operation === 'review' || p.operation === 'comparison_review')
          content = { version: 'wf1-review/1', disposition: 'CLEAR', notes: marker };
        else
          content = {
            version: 'wf1-candidate/1',
            target:
              options.wrongFirst && p.data.formalInput.input.numerator === '0'
                ? { numerator: '-99', denominator: '1' }
                : computeFormal(p.data.formalInput),
          };
        if (body.model === MODELS.deepseek) {
          assert.equal(body.thinking.type, 'disabled');
          assert.equal(body.tools.length, 1);
          assert.equal(body.tools[0].function.strict, true);
          const message = toolMessage(body.tool_choice.function.name, JSON.stringify(content));
          return response(
            { ...message, tool_calls: message.tool_calls.map((call) => ({ ...call, index: 0 })) },
            'tool_calls',
            body.model,
            !options.unknownUsage,
          );
        }
        assert.equal(body.tools, undefined);
        assert.equal(body.response_format.type, 'json_object');
        return response(
          { role: 'assistant', content: JSON.stringify(content) },
          'stop',
          body.model,
          !options.unknownUsage,
        );
      },
    },
  );
  return { provider, operations };
}

test('strict schema uses supported closed objects and canonical strings; local oracle retains larger result range', () => {
  const allowed = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'anyOf',
    '$ref',
    '$def',
    'pattern',
  ]);
  function check(value: any): void {
    for (const k of Object.keys(value)) assert.ok(allowed.has(k), k);
    if (value.type === 'object') {
      assert.equal(value.additionalProperties, false);
      assert.deepEqual(value.required, Object.keys(value.properties));
      Object.values(value.properties).forEach(check);
    }
    if (value.items) check(value.items);
    if (value.anyOf) value.anyOf.forEach(check);
    if (value.$def) Object.values(value.$def).forEach(check);
    if (value.$ref) assert.equal(value.$ref, '#/$def/expression');
  }
  for (const op of [
    'seal',
    'plan',
    'rubric',
    'candidate',
    'review',
    'comparison_candidate',
    'comparison_review',
  ] as const) {
    check(strictDataSchema(op));
    const raw = providerBody('deepseek', payload(op), op, 'wf1-campaign/0.5'),
      body = JSON.parse(raw);
    assert.equal(body.messages[0].content.includes('legacy'), false);
    assert.equal(raw.includes('must not be sent'), false);
    assert.equal(raw.split('"$def"').length - 1, op === 'seal' || op === 'plan' ? 1 : 0);
    assert.equal(body.response_format, undefined);
    validateStrictDataRequest('deepseek', op, raw, strictDataBinding('deepseek', op));
  }
  validateSeal(sealed());
  validatePlan(plan());
  const large = {
    verifier: 'rational.evaluate.v1',
    input: {
      op: 'mul',
      left: { op: 'value', numerator: (2n ** 127n).toString(), denominator: '1' },
      right: { op: 'value', numerator: (2n ** 127n).toString(), denominator: '1' },
    },
  };
  const target = computeFormal(large);
  assert.equal(verifyFormal(large, target).status, 'VERIFIED');
  assert.ok(canonical(target).length > 42);
  assert.equal(verifyFormal(formal(1), { numerator: '01', denominator: '1' }).status, 'CONTRADICTED');
  const candidate: any = strictDataSchema('candidate');
  assert.equal(new RegExp(candidate.properties.target.properties.numerator.pattern).test('01'), false);
  assert.equal(candidate.properties.target.properties.numerator.maxLength, undefined);
  assert.throws(() => validateSeal({ ...sealed(), cases: sealed().cases.slice(1) }));
  assert.throws(() => validatePlan({ ...plan(), pairedFamilyIds: ['family0'] }));
});

test('response compatibility version changes no request bytes for either provider or any existing policy', () => {
  const requests = [];
  for (const policy of ['wf1-campaign/0.3', 'wf1-campaign/0.4', 'wf1-campaign/0.5'] as const)
    for (const provider of ['deepseek', 'together'] as const)
      for (const operation of [
        'seal',
        'plan',
        'rubric',
        'candidate',
        'review',
        'comparison_candidate',
        'comparison_review',
      ] as const)
        requests.push({
          policy,
          provider,
          operation,
          bodyDigest: hash(providerBody(provider, payload(operation), operation, policy)),
        });
  // Captured from the exact archived pre-fix source before any compatibility edit: 42 complete request bodies.
  assert.equal(hash(canonical(requests)), '1b02907bb8e84a8636db7af9f09ceb8cac44e2f34f3abc836b7fd5eed82407cc');
  assert.notEqual(WF2_STRICT_PROFILE_DIGEST, 'ef8d70f02eda614bb1229ebb536003a2e343eb8303a9575c5fe1dd64784ce9be');
});

test('single data call permits only absent index or integer zero before reaching the argument sink', () => {
  const name = 'wf2_data_candidate',
    raw = '{"version":"wf1-candidate/1","target":{"numerator":"1","denominator":"1"}}',
    base = toolMessage(name, raw),
    call = base.tool_calls[0]!;
  for (const candidate of [call, { ...call, index: 0 }]) {
    let callbacks = 0;
    assert.equal(
      decodeStrictDataArguments({ ...base, tool_calls: [candidate] }, 'tool_calls', name, (bytes) => {
        callbacks++;
        assert.equal(bytes, raw);
      }),
      raw,
    );
    assert.equal(callbacks, 1);
  }
  const invalidCalls: unknown[] = [
    ...[1, -1, null, '0', false, 0.5, -0, undefined].map((index) => ({ ...call, index })),
    { ...call, index: 0, unknown: true },
  ];
  for (const candidate of invalidCalls) {
    let callbacks = 0;
    assert.throws(() =>
      decodeStrictDataArguments({ ...base, tool_calls: [candidate] }, 'tool_calls', name, () => {
        callbacks++;
      }),
    );
    assert.equal(callbacks, 0);
  }
});

test('strict codec retains only the one named data-argument artifact and rejects protocol variants without fallback', async () => {
  const good = toolMessage(
    'wf2_data_candidate',
    '{"version":"wf1-candidate/1","target":{"numerator":"1","denominator":"1"}}',
  );
  const variants: Array<{ message: unknown; finish?: string; valid?: boolean; rawArgs?: boolean }> = [
    { message: good, valid: true, rawArgs: true },
    { message: { ...good, content: '' }, valid: true, rawArgs: true },
    { message: { ...good, content: 'mixed' } },
    { message: { ...good, tool_calls: [...good.tool_calls, ...good.tool_calls] } },
    { message: toolMessage('other', good.tool_calls[0]!.function.arguments) },
    { message: toolMessage('wf2_data_candidate', {}) },
    { message: toolMessage('wf2_data_candidate', '{"broken":'), rawArgs: true },
    { message: toolMessage('wf2_data_candidate', '{"x":1,"x":1}'), rawArgs: true },
    { message: good, finish: 'stop' },
    { message: good, finish: 'length' },
    { message: { ...good, refusal: 'refused' } },
    { message: { role: 'assistant', content: '{}' } },
  ];
  const body = providerBody('deepseek', payload('candidate'), 'candidate', 'wf1-campaign/0.5');
  let calls = 0;
  for (const v of variants) {
    const f = fixture(),
      broker = createArtifactBroker(f.runtimeRoot, f.spec.id, key),
      provider = new TeacherProvider(
        { deepseek: 'synthetic-only', together: null },
        {
          fetch: async (url) => {
            calls++;
            assert.equal(String(url), 'https://api.deepseek.com/beta/chat/completions');
            return response(v.message, v.finish);
          },
        },
      );
    const result = await provider.submit(
      'deepseek',
      body,
      broker.train,
      new AbortController().signal,
      (send) => send(),
      { operation: 'candidate', binding: strictDataBinding('deepseek', 'candidate') },
    );
    assert.equal(result.outcome, v.valid ? 'COMPLETED' : 'FAILED');
    assert.equal(result.payloadOrigin, 'STRICT_TOOL_ARGUMENTS');
    assert.equal(result.finalRef, null);
    assert.equal(result.contentPresent, false);
    assert.equal(result.usage?.input, 20);
    assert.equal(Boolean(result.argumentsRef), Boolean(v.rawArgs));
    if (result.argumentsRef) assert.equal(result.argumentsRef.kind, 'strict-tool-arguments');
  }
  assert.equal(calls, variants.length);
  const f = fixture(),
    provider = new TeacherProvider(
      { deepseek: 'synthetic-only', together: null },
      { fetch: async () => response(good) },
    ),
    legacy = await provider.submit(
      'deepseek',
      providerBody('deepseek', { fixture: marker }),
      createArtifactBroker(f.runtimeRoot, f.spec.id, key).train,
      new AbortController().signal,
    );
  assert.equal(legacy.outcome, 'INCOMPLETE_OUTPUT');
  assert.equal(legacy.argumentsRef, undefined);
  let sends = 0;
  const noSend = new TeacherProvider(
    { deepseek: 'synthetic-only', together: null },
    {
      fetch: async () => {
        sends++;
        return response(good);
      },
    },
  );
  await assert.rejects(
    noSend.submit('deepseek', body, {} as ArtifactPort, new AbortController().signal, (send) => send(), {
      operation: 'candidate',
      binding: { ...strictDataBinding('deepseek', 'candidate'), endpoint: 'https://invalid.example' },
    }),
    error('WF2_STRICT_BINDING'),
  );
  assert.equal(sends, 0);
  assert.throws(() => decodeStrictDataArguments(good, 'tool_calls', 'different'), error('WF2_STRICT_RESPONSE'));
});

test('training binding rejects prefix siblings, root itself, aliases and authority inside training before writes', () => {
  const f = fixture(),
    sibling = join(f.base, 'training-other');
  mkdirSync(sibling);
  const alias = join(f.base, 'training-alias');
  symlinkSync(f.approvedTrainingRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [sibling, f.approvedTrainingRoot, join(alias, 'run')])
    assert.throws(() => bindTrainingRoot(f.approvedTrainingRoot, root));
  assert.throws(() => bindTrainingRoot(alias, f.runtimeRoot));
  assert.throws(
    () => requireTrainingBinding(f.approvedTrainingRoot, f.runtimeRoot, '0'.repeat(64)),
    error('WF2_STORAGE_BINDING'),
  );
  assert.throws(
    () =>
      requireTrainingBinding(
        f.approvedTrainingRoot,
        f.runtimeRoot,
        f.spec.storageBindingDigest,
        join(f.approvedTrainingRoot, 'authority.json'),
      ),
    error('WF2_AUTHORITY_IN_TRAINING_ROOT'),
  );
  for (const bootstrap of [
    { ...f.bootstrap, approvedTrainingRoot: sibling },
    { ...f.bootstrap, spec: { ...f.spec, storageBindingDigest: '0'.repeat(64) } },
    { ...f.bootstrap, version: 'wf2-teacher-bind/1' },
  ])
    assert.throws(() => bindTeacherCampaign(bootstrap));
  assert.throws(() => validateSpec({ ...f.spec, storageBindingDigest: undefined }));
  assert.deepEqual(readdirSync(f.runtimeRoot), []);
  assert.equal(JSON.parse(readFileSync(f.authorityPath, 'utf8')).head, null);
  const guard = () => {
      requireTrainingBinding(f.approvedTrainingRoot, f.runtimeRoot, f.spec.storageBindingDigest);
    },
    port = createArtifactBroker(f.runtimeRoot, f.spec.id, key, guard).train,
    ref = port.put('synthetic', marker),
    moved = join(f.approvedTrainingRoot, 'moved');
  renameSync(f.runtimeRoot, moved);
  symlinkSync(moved, f.runtimeRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => port.read(ref));
  assert.throws(() => port.put('synthetic', marker));
  assert.equal(readdirSync(moved).length, 1);
});

test('rational production campaign binds consumed route and body, completes without follow-ups and cold verifies only train data', async () => {
  const f = fixture();
  let checked = 0;
  const m = mock({
      onSend: (raw, url) => {
        const latest = state(f).attempts.at(-1)!;
        assert.equal(latest.requestCommitment, hash(raw));
        assert.equal(latest.outcome, null);
        assert.deepEqual(latest.requestBinding, strictDataBinding(latest.provider, latest.operation));
        assert.equal(url, latest.requestBinding!.endpoint);
        checked++;
      },
    }),
    bound = bindTeacherCampaign(f.bootstrap, { provider: m.provider, now: () => f.now }),
    service = new TeacherControlService(bound.run, capability);
  service.dispatch({ version: 1, requestId: 'start', operation: 'start', capability });
  await service.settled();
  const receipt = service.completionReceipt();
  assert.equal(receipt.metadata.campaignStatus, 'COMPLETED');
  assert.equal(receipt.metadata.calls.deepseek, 43);
  assert.equal(receipt.metadata.calls.together, 8);
  assert.equal(receipt.metadata.candidates.qualified, 24);
  assert.equal(checked, 51);
  service.acknowledgeCompleted(receipt.digest);
  service.ownerLost();
  const recorded = state(f);
  assert.equal(
    recorded.attempts.every((a) =>
      a.provider === 'deepseek'
        ? a.result!.payloadOrigin === 'STRICT_TOOL_ARGUMENTS' &&
          a.result!.argumentsRef?.kind === 'strict-tool-arguments' &&
          a.result!.finalRef === null
        : a.result!.payloadOrigin === 'NATIVE_FINAL' &&
          a.result!.argumentsRef === null &&
          a.result!.finalRef?.kind === 'native-final',
    ),
    true,
  );
  for (const name of readdirSync(f.runtimeRoot).filter((n) => n.startsWith('custody-')))
    renameSync(join(f.runtimeRoot, name), join(f.runtimeRoot, name + '.unavailable'));
  const before = files(f.runtimeRoot),
    hostBefore = files(join(f.base, 'host')),
    source = `import {inspectTeacherCampaign} from ${JSON.stringify(new URL('../src/wf2-teacher-inspect.ts', import.meta.url).href)};let raw='';for await(const part of process.stdin)raw+=part;process.stdout.write(JSON.stringify(inspectTeacherCampaign(JSON.parse(raw),()=>1000)));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    input: canonical(inspection(f)),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 32768,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const cold = JSON.parse(child.stdout);
  assert.equal(cold.status, 'RECORDED_CLAIMS_ONLY');
  assert.deepEqual(cold.manifestVerification, {
    status: 'VERIFIED',
    rows: 16,
    uniqueRows: 16,
    splitCounts: { train: 12, dev: 4 },
  });
  assert.equal(cold.providers.deepseek.calls, 43);
  assert.equal(cold.actualInvoice, 'UNKNOWN');
  assert.equal(child.stdout.includes(marker), false);
  assert.throws(() =>
    inspectTeacherCampaign({ ...inspection(f), approvedTrainingRoot: join(f.base, 'host') }, () => f.now),
  );
  assert.throws(() =>
    inspectTeacherCampaign(
      { ...inspection(f), spec: { ...f.spec, storageBindingDigest: '0'.repeat(64) } },
      () => f.now,
    ),
  );
  assert.deepEqual(files(f.runtimeRoot), before);
  assert.deepEqual(files(join(f.base, 'host')), hostBefore);
});

test('local rational-only admission rejects syntactically valid pointer seal or plan without another call', async () => {
  for (const pointerStage of ['seal', 'plan'] as const) {
    const f = fixture(),
      m = mock({ pointerStage }),
      b = bindTeacherCampaign(f.bootstrap, { provider: m.provider, now: () => f.now });
    try {
      await b.run.run();
      assert.equal(b.run.metadata().campaignStatus, 'STOPPED');
      assert.equal(state(f).code, 'WF2_RATIONAL_ONLY');
      assert.deepEqual(m.operations, pointerStage === 'seal' ? ['seal'] : ['seal', 'plan']);
      assert.equal(b.stopReason!(), 'STRUCTURE_OR_FORMAL_REJECTED');
    } finally {
      b.run.withdraw('REVOKED');
    }
  }
});

test('rational first-four failure and unknown usage remain consumed with no repair or fallback', async () => {
  for (const options of [{ wrongFirst: true }, { unknownUsage: true }]) {
    const f = fixture(),
      m = mock(options),
      b = bindTeacherCampaign(f.bootstrap, { provider: m.provider, now: () => f.now });
    try {
      await b.run.run();
      assert.equal(b.run.metadata().campaignStatus, 'STOPPED');
      assert.equal(b.run.metadata().candidates.qualified, 0);
      assert.deepEqual(m.operations, 'wrongFirst' in options ? ['seal', 'plan', 'rubric', 'candidate'] : ['seal']);
      if ('unknownUsage' in options) assert.equal(b.run.metadata().usage.unknown, 1);
    } finally {
      b.run.withdraw('REVOKED');
    }
    const before = files(f.runtimeRoot),
      cold = inspectTeacherCampaign(inspection(f), () => f.now);
    assert.equal(cold.authorityStatus, 'REVOKED');
    assert.equal(cold.manifestVerification.status, 'NOT_READ');
    assert.equal(cold.providers.deepseek!.calls, m.operations.length);
    assert.deepEqual(files(f.runtimeRoot), before);
    assert.throws(() => bindTeacherCampaign(f.bootstrap, { provider: m.provider, now: () => f.now }));
  }
});

test('route/body mismatch is rejected before consume and provider access', () => {
  const f = fixture(),
    m = mock(),
    campaign = TeachingCampaign.admitCampaign({
      root: f.runtimeRoot,
      approvedTrainingRoot: f.approvedTrainingRoot,
      authorityPath: f.authorityPath,
      spec: f.spec,
      key,
      objective: marker,
      provider: m.provider,
      now: () => f.now,
    });
  try {
    const body = JSON.parse(providerBody('deepseek', payload('seal'), 'seal', 'wf1-campaign/0.5'));
    body.tool_choice.function.name = 'other';
    assert.throws(() => campaign.reserveAttempt('seal', canonical(body)), error('WF2_STRICT_REQUEST'));
    assert.equal(state(f).attempts.length, 0);
    assert.equal(m.operations.length, 0);
  } finally {
    campaign.close();
  }
});
