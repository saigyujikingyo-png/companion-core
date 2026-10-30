import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence, Proposal } from '../src/contracts.ts';
import { HybridBackendLane, HybridInferenceSession } from '../src/hybrid-inference.ts';
import type { HybridBackendPort, HybridPhase, HybridValidator } from '../src/hybrid-inference.ts';
import { HYBRID_LIMITS, HYBRID_PROTOCOL } from '../src/hybrid-profile.ts';
import type { HybridBinding, HybridLease, HybridProfile } from '../src/hybrid-profile.ts';
import type { HybridReply } from '../src/hybrid-wire.ts';

const hash = 'a'.repeat(64);
function profile(): HybridProfile {
  return {
    version: 1,
    profileId: 'fixture/hybrid',
    model: { id: 'fixture/model', revision: 'a'.repeat(40), sha256: hash, precision: 'fixture/fp32' },
    tokenizer: { id: 'fixture/tokenizer', revision: hash, sha256: hash },
    processor: { id: 'fixture/processor', revision: hash, sha256: hash },
    chatTemplateSha256: hash,
    adapterSha256: null,
    routerAuxSha256: null,
    runtime: {
      id: 'fixture/runtime',
      buildSha256: hash,
      kernelSha256: hash,
      cacheLayoutSha256: hash,
      topologySha256: hash,
    },
    modelModalities: ['text', 'image', 'video'],
    stateFamilies: ['attention-kv', 'ssm', 'convolution', 'position-prefix'],
    protocol: HYBRID_PROTOCOL,
  };
}
function binding(): HybridBinding {
  return {
    namespace: {
      tenantId: 'fixture/tenant',
      subjectId: 'fixture/subject',
      personaId: 'fixture/persona',
      relationshipId: 'fixture/relation',
    },
    scopeId: 'fixture/scope',
    generation: 0,
    consentRevision: 0,
    runtimeEpoch: 0,
    permissionEpoch: 0,
    sessionId: 'fixture/session',
    purpose: 'memory-proposal',
    evaluationGroup: 'fixture/eval',
    sourceRefs: [{ id: 'fixture/source', revision: 1 }],
  };
}
function evidence(): Evidence[] {
  return [
    {
      speakerId: 'fixture/subject',
      speakerRole: 'subject',
      mode: 'self_report',
      selectedText: 'Synthetic selected evidence.',
      occurredAt: null,
    },
  ];
}
const proposal: Proposal = {
  kind: 'claim',
  statement: 'Synthetic candidate.',
  basis: 'self_report',
  validFrom: null,
  validTo: null,
};
type PortInput = Parameters<HybridBackendPort['generate']>[0];
function final(input: PortInput): HybridReply {
  const request = JSON.parse(new TextDecoder().decode(input.requestBytes)) as {
    requestId: string;
    lease: HybridLease;
    profileDigest: string;
  };
  return {
    contentType: 'application/json',
    body: new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        kind: 'final-proposal',
        requestId: request.requestId,
        lease: request.lease,
        profileDigest: request.profileDigest,
        proposal,
      }),
    ),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function immediate() {
  const calls: PortInput[] = [];
  const lane = new HybridBackendLane({
    generate: async (input) => {
      calls.push(input);
      return final(input);
    },
  });
  return { lane, calls };
}
function create(
  lane: HybridBackendLane,
  validateCurrent: HybridValidator = () => true,
  extra: Partial<{ profile: HybridProfile; binding: HybridBinding; timeoutMs: number }> = {},
) {
  return new HybridInferenceSession({ lane, profile: profile(), binding: binding(), validateCurrent, ...extra });
}
function request(requestId = 'fixture/request') {
  return { requestId, selectedEvidence: evidence() };
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('F08 each currentness phase accepts only literal true, denied dispatch never consumes', async () => {
  const denied: Array<[string, () => unknown]> = [
    ['false', () => false],
    ['undefined', () => undefined],
    ['null', () => null],
    ['zero', () => 0],
    ['one', () => 1],
    ['string', () => 'true'],
    ['object', () => ({})],
    ['promise true', () => Promise.resolve(true)],
    ['rejected promise', () => Promise.reject(new Error('fixture/denied'))],
    [
      'thenable',
      () => ({
        then(_yes: unknown, no: (e: Error) => void) {
          no(new Error('fixture/denied'));
          return Promise.reject(new Error('fixture/returned'));
        },
      }),
    ],
    [
      'throw',
      () => {
        throw new Error('fixture/denied');
      },
    ],
  ];
  for (const phase of ['dispatch', 'deliver', 'replay'] as const)
    for (const [name, deny] of denied) {
      const fake = immediate();
      let denying = phase !== 'replay';
      const phases: HybridPhase[] = [];
      const s = create(fake.lane, (input) => {
        phases.push(input.phase);
        return input.phase === phase && denying ? deny() : true;
      });
      if (phase === 'replay') {
        await s.propose(request());
        denying = true;
      }
      await assert.rejects(async () => s.propose(request()), /HYBRID_CURRENTNESS_DENIED/u, `${phase}/${name}`);
      if (phase === 'dispatch') {
        assert.equal(fake.calls.length, 0);
        assert.equal(s.status('fixture/request'), null);
        denying = false;
        assert.deepEqual(await s.propose(request()), proposal);
        assert.equal(fake.calls.length, 1);
      } else {
        assert.equal(fake.calls.length, 1);
        assert.equal(s.status('fixture/request')?.state, phase === 'deliver' ? 'unknown_after_dispatch' : 'completed');
      }
      assert(phases.includes(phase));
      s.close();
    }
  await tick(); // Rejection handlers for denied promises/foreign thenables have run.
  const pending = deferred<HybridReply>();
  let captured!: PortInput;
  let current = true;
  const s = create(
    new HybridBackendLane({
      generate: (input) => {
        captured = input;
        return pending.promise;
      },
    }),
    () => current,
  );
  const work = s.propose(request());
  current = false;
  pending.resolve(final(captured));
  await assert.rejects(work, /HYBRID_CURRENTNESS_DENIED/u);
  assert.equal(s.status('fixture/request')?.state, 'unknown_after_dispatch');
  s.close();
  const fake = immediate();
  const wrongNamespace = create(fake.lane, ({ binding: b }) => b.namespace.tenantId === 'fixture/allowed');
  assert.throws(() => wrongNamespace.propose(request()), /HYBRID_CURRENTNESS_DENIED/u);
  assert.equal(fake.calls.length, 0);
});

test('F09 abort drops publicly but retains the raw physical lane until true settlement', async () => {
  const pending = deferred<HybridReply>();
  let captured!: PortInput;
  let count = 0;
  const lane = new HybridBackendLane({
    generate: (input) => {
      count++;
      captured = input;
      return pending.promise;
    },
  });
  const s = create(lane),
    other = create(lane),
    abort = new AbortController();
  const work = s.propose({ ...request(), signal: abort.signal });
  abort.abort();
  await assert.rejects(work, /HYBRID_ABORTED/u);
  assert.equal(captured.signal.aborted, true);
  assert.deepEqual(s.status('fixture/request'), {
    requestId: 'fixture/request',
    state: 'unknown_after_dispatch',
    transportSettled: false,
    reason: 'HYBRID_ABORTED',
  });
  assert.throws(() => other.propose(request('fixture/other')), /HYBRID_LANE_BUSY/u);
  assert.throws(() => s.propose(request()), /HYBRID_UNKNOWN/u);
  assert.equal(count, 1);
  pending.resolve(final(captured));
  await tick();
  assert.equal(s.status('fixture/request')?.transportSettled, true);
  assert.equal(s.status('fixture/request')?.state, 'unknown_after_dispatch');
  s.close();
  other.close();
});

test('F10 rebind/profile changes fence old replies and preserve old request consumption', async () => {
  const pending = deferred<HybridReply>();
  let captured!: PortInput;
  const lane = new HybridBackendLane({
    generate: (input) => {
      captured = input;
      return pending.promise;
    },
  });
  const s = create(lane),
    work = s.propose(request());
  s.rebind({
    profile: { ...profile(), processor: { ...profile().processor, sha256: 'b'.repeat(64) } },
    binding: { ...binding(), permissionEpoch: 1 },
  });
  await assert.rejects(work, /HYBRID_FENCED/u);
  assert.throws(() => s.propose(request()), /HYBRID_REQUEST_CONFLICT/u);
  assert.throws(() => s.propose(request('fixture/new')), /HYBRID_LANE_BUSY/u);
  pending.resolve(final(captured));
  await tick();
  assert.equal(s.status('fixture/request')?.state, 'unknown_after_dispatch');
  const fake = immediate(),
    stable = create(fake.lane);
  assert.throws(() => stable.rebind({ profile: { ...profile(), profileId: '' }, binding: binding() }));
  assert.deepEqual(await stable.propose(request()), proposal);
  stable.rebind({ profile: profile(), binding: binding() });
  assert.throws(() => stable.propose(request()), /HYBRID_REQUEST_CONFLICT/u);
  s.close();
  stable.close();
});

test('F11 invalidate/close fence busy work; close is irreversible and never confirms backend stop', async () => {
  const pending = deferred<HybridReply>();
  let captured!: PortInput;
  const lane = new HybridBackendLane({
    generate: (input) => {
      captured = input;
      return pending.promise;
    },
  });
  const s = create(lane),
    work = s.propose(request());
  const receipt = s.invalidate('fixture/revoked');
  assert.deepEqual(receipt, { logicalFenced: true, backendStopConfirmed: false, epoch: 1 });
  await assert.rejects(work, /HYBRID_FENCED/u);
  assert.throws(() => s.propose(request('fixture/new')), /HYBRID_FENCED/u);
  assert.equal(s.close().backendStopConfirmed, false);
  assert(s.status('fixture/request'));
  assert.throws(() => s.rebind({ profile: profile(), binding: binding() }), /HYBRID_CLOSED/u);
  assert.throws(() => s.propose(request('fixture/new')), /HYBRID_CLOSED/u);
  pending.resolve(final(captured));
  await tick();
  assert.equal(s.status('fixture/request')?.state, 'unknown_after_dispatch');
});

test('F12 completed replay is an independent copy; conflicting/inflight/UNKNOWN never redispatch', async () => {
  const fake = immediate(),
    s = create(fake.lane);
  const first = await s.propose(request());
  first.statement = 'Mutated caller copy';
  assert.deepEqual(await s.propose(request()), proposal);
  assert.equal(fake.calls.length, 1);
  assert.throws(
    () => s.propose({ ...request(), selectedEvidence: [{ ...evidence()[0]!, selectedText: 'Different' }] }),
    /HYBRID_REQUEST_CONFLICT/u,
  );
  const pending = deferred<HybridReply>();
  let count = 0;
  const other = create(
    new HybridBackendLane({
      generate: () => {
        count++;
        return pending.promise;
      },
    }),
  );
  const work = other.propose(request());
  assert.throws(() => other.propose(request()), /HYBRID_IN_FLIGHT/u);
  pending.reject(new Error('fixture/backend'));
  await assert.rejects(work, /HYBRID_BACKEND_FAILED/u);
  assert.throws(() => other.propose(request()), /HYBRID_UNKNOWN/u);
  assert.equal(count, 1);
  let syncCount = 0;
  const sync = create(
    new HybridBackendLane({
      generate: () => {
        syncCount++;
        throw new Error('fixture/sync');
      },
    }),
  );
  await assert.rejects(sync.propose(request()), /HYBRID_BACKEND_FAILED/u);
  assert.throws(() => sync.propose(request()), /HYBRID_UNKNOWN/u);
  assert.equal(syncCount, 1);
  const invalid = create(
    new HybridBackendLane({ generate: async () => ({ contentType: 'application/json', body: new Uint8Array([0]) }) }),
  );
  await assert.rejects(invalid.propose(request()));
  assert.equal(invalid.status('fixture/request')?.state, 'unknown_after_dispatch');
  s.close();
  other.close();
  sync.close();
  invalid.close();
});

test('F13 timeout preserves shared physical permit and UNKNOWN across new sessions and namespaces', async () => {
  const pending = deferred<HybridReply>();
  let count = 0;
  let ignoredAbort!: AbortSignal;
  const lane = new HybridBackendLane({
    generate: (input) => {
      count++;
      ignoredAbort = input.signal;
      return pending.promise;
    },
  });
  const s = create(lane, () => true, { timeoutMs: 1 }),
    other = create(lane);
  await assert.rejects(s.propose(request()), /HYBRID_TIMEOUT/u);
  assert.equal(ignoredAbort.aborted, true);
  assert.equal(s.status('fixture/request')?.transportSettled, false);
  assert.throws(() => other.propose(request('fixture/other')), /HYBRID_LANE_BUSY/u);
  pending.reject(new Error('fixture/late'));
  await tick();
  assert.equal(s.status('fixture/request')?.transportSettled, true);
  assert.equal(s.status('fixture/request')?.state, 'unknown_after_dispatch');
  s.close();
  const fresh = create(lane, () => true, {
    binding: { ...binding(), namespace: { ...binding().namespace, tenantId: 'fixture/other-tenant' } },
  });
  for (const session of [other, fresh]) {
    assert.equal(session.status('fixture/request'), null);
    assert.throws(
      () => session.propose(request()),
      (error) => {
        assert.equal((error as Error).message, 'HYBRID_REQUEST_CONFLICT');
        assert.deepEqual(Object.keys(error as object).sort(), ['code', 'name']);
        return true;
      },
    );
  }
  assert.equal(count, 1);
  other.close();
  fresh.close();

  // An own `then` must not bypass the raw permit. The intrinsic observer still
  // consumes its real late settlement without reviving the cancelled request.
  const overridden = deferred<HybridReply>();
  let saved!: PortInput;
  let overrideCalls = 0,
    ownThenCalls = 0;
  Object.defineProperty(overridden.promise, 'then', {
    value() {
      ownThenCalls++;
      throw new Error('fixture/own-then');
    },
  });
  const overrideLane = new HybridBackendLane({
    generate: (input) => {
      overrideCalls++;
      saved = input;
      return overrideCalls === 1 ? overridden.promise : Promise.resolve(final(input));
    },
  });
  const owner = create(overrideLane),
    peer = create(overrideLane),
    abort = new AbortController();
  const work = owner.propose({ ...request(), signal: abort.signal });
  assert.throws(() => peer.propose(request('fixture/next')), /HYBRID_LANE_BUSY/u);
  abort.abort();
  await assert.rejects(work, /HYBRID_ABORTED/u);
  assert.equal(owner.status('fixture/request')?.transportSettled, false);
  assert.throws(() => peer.propose(request('fixture/next')), /HYBRID_LANE_BUSY/u);
  assert.equal(overrideCalls, 1);
  assert.equal(ownThenCalls, 0);
  overridden.resolve(final(saved));
  await tick();
  assert.equal(owner.status('fixture/request')?.transportSettled, true);
  assert.equal(owner.status('fixture/request')?.state, 'unknown_after_dispatch');
  assert.throws(() => owner.propose(request()), /HYBRID_UNKNOWN/u);
  assert.deepEqual(await peer.propose(request('fixture/next')), proposal);
  assert.equal(overrideCalls, 2);
  owner.close();
  peer.close();

  // A genuine hook-installation failure is UNKNOWN, not a transport rejection.
  // Even later native fulfillment is not observable proof that permits reuse.
  const unobservable = deferred<HybridReply>();
  let unobservedInput!: PortInput;
  let unobservedCalls = 0;
  Object.defineProperty(unobservable.promise, 'constructor', {
    get() {
      throw new Error('fixture/constructor');
    },
  });
  const failedLane = new HybridBackendLane({
    generate: (input) => {
      unobservedCalls++;
      unobservedInput = input;
      return unobservable.promise;
    },
  });
  const failed = create(failedLane),
    waiting = create(failedLane);
  await assert.rejects(failed.propose(request()), /HYBRID_BACKEND_UNOBSERVABLE/u);
  assert.deepEqual(failed.status('fixture/request'), {
    requestId: 'fixture/request',
    state: 'unknown_after_dispatch',
    transportSettled: false,
    reason: 'HYBRID_BACKEND_UNOBSERVABLE',
  });
  assert.throws(() => failed.propose(request()), /HYBRID_UNKNOWN/u);
  assert.throws(() => waiting.propose(request('fixture/next')), /HYBRID_LANE_BUSY/u);
  unobservable.resolve(final(unobservedInput));
  await tick();
  assert.equal(failed.status('fixture/request')?.transportSettled, false);
  assert.equal(failed.status('fixture/request')?.state, 'unknown_after_dispatch');
  failed.close();
  waiting.rebind({ profile: profile(), binding: binding() });
  assert.throws(() => waiting.propose(request('fixture/next')), /HYBRID_LANE_BUSY/u);
  assert.throws(() => waiting.propose(request()), /HYBRID_REQUEST_CONFLICT/u);
  assert.equal(unobservedCalls, 1);
  waiting.close();

  // Deliberate protocol violation: this fixture PORT installs rejection cleanup
  // before poisoning its Promise. The coordinator cannot claim that protection.
  const lateRejected = deferred<HybridReply>();
  let portCleanupCount = 0,
    portAbortCount = 0;
  let violatingSignal!: AbortSignal;
  const violatingLane = new HybridBackendLane({
    generate: (input) => {
      violatingSignal = input.signal;
      void lateRejected.promise.then(undefined, () => {
        portCleanupCount++;
      });
      Object.defineProperty(lateRejected.promise, 'constructor', {
        get() {
          throw new Error('fixture/late-constructor');
        },
      });
      input.signal.addEventListener(
        'abort',
        () => {
          portAbortCount++;
          lateRejected.reject(new Error('fixture/abort'));
        },
        { once: true },
      );
      return lateRejected.promise;
    },
  });
  const violating = create(violatingLane),
    blocked = create(violatingLane);
  await assert.rejects(violating.propose(request()), /HYBRID_BACKEND_UNOBSERVABLE/u);
  assert.equal(violatingSignal.aborted, false);
  assert.equal(portAbortCount, 0);
  assert.equal(portCleanupCount, 0);
  assert.throws(() => blocked.propose(request('fixture/next')), /HYBRID_LANE_BUSY/u);
  lateRejected.reject(new Error('fixture/independent-late-rejection'));
  await tick();
  assert.equal(portCleanupCount, 1); // Port-owned handler, installed before the violation.
  assert.equal(violating.status('fixture/request')?.transportSettled, false); // No coordinator observation.
  assert.equal(violating.status('fixture/request')?.state, 'unknown_after_dispatch');
  assert.throws(() => violating.propose(request()), /HYBRID_UNKNOWN/u);
  assert.throws(() => blocked.propose(request('fixture/next')), /HYBRID_LANE_BUSY/u);
  violating.close();
  blocked.close();
  assert.equal(portAbortCount, 0);
});

test('F14 shared lifetime bounds survive close/rebind; old-ID lookup and stop work when full', async () => {
  const fake = immediate(),
    first = create(fake.lane),
    second = create(fake.lane);
  for (let i = 0; i < 64; i++) await (i % 2 === 0 ? first : second).propose(request(`fixture/${i}`));
  assert.equal(fake.calls.length, 64);
  assert.deepEqual(await first.propose(request('fixture/0')), proposal);
  assert.equal(second.status('fixture/0'), null);
  assert.throws(() => second.propose(request('fixture/0')), /HYBRID_REQUEST_CONFLICT/u);
  assert.throws(() => first.propose(request('fixture/full')), /HYBRID_LEDGER_FULL/u);
  assert.equal(first.invalidate('fixture/revoked').logicalFenced, true);
  first.rebind({ profile: profile(), binding: binding() });
  first.close();
  const fresh = create(fake.lane);
  assert.throws(() => fresh.propose(request('fixture/new')), /HYBRID_LEDGER_FULL/u);
  assert.throws(() => fresh.propose(request('fixture/0')), /HYBRID_REQUEST_CONFLICT/u);
  assert.equal(second.close().backendStopConfirmed, false);
  assert(second.status('fixture/1'));
  assert.equal(fake.calls.length, 64);
  fresh.close();
  const isolated = immediate(),
    rebinding = create(isolated.lane);
  await rebinding.propose(request());
  rebinding.rebind({
    profile: profile(),
    binding: { ...binding(), namespace: { ...binding().namespace, subjectId: 'fixture/other-subject' } },
  });
  assert.equal(rebinding.status('fixture/request'), null);
  assert.throws(() => rebinding.propose(request()), /HYBRID_REQUEST_CONFLICT/u);
  rebinding.close();
  // Each admitted entry bounds metadata at 8192 and reserves the full result limit;
  // even the aggregate worst representation remains below the independent byte cap.
  assert(HYBRID_LIMITS.lifetimeRequestIds * (8192 + HYBRID_LIMITS.resultBytesPerRequest) <= HYBRID_LIMITS.ledgerBytes);
});

test('F15 tensor operations refuse and reset acknowledges only a logical fence', () => {
  const fake = immediate(),
    s = create(fake.lane);
  for (const action of ['checkpoint', 'fork', 'rollback', 'transfer', 'prefixReuse', 'tensorExport'] as const)
    assert.throws(() => s.requireStateCapability(action), /HYBRID_STATE_UNSUPPORTED/u);
  assert.equal(s.stateCapabilities.reset, 'logical-fence-only');
  assert.deepEqual(s.requireStateCapability('reset'), { logicalFenced: true, backendStopConfirmed: false, epoch: 1 });
  assert.equal(fake.calls.length, 0);
  s.close();
});

test('F16 adapter prebinds stable requestId, text-only capabilities and original lease', async () => {
  const fake = immediate(),
    s = create(fake.lane),
    adapter = s.asInferenceAdapter('fixture/adapter');
  assert.deepEqual(adapter.capabilities.input, ['text']);
  assert.equal(adapter.capabilities.structuredOutput, 'validated');
  assert.equal(adapter.capabilities.cancellation, 'local_drop_only');
  const input = { selectedEvidence: evidence(), signal: new AbortController().signal };
  assert.deepEqual(await adapter.proposeMemory(input), proposal);
  await adapter.proposeMemory(input);
  assert.equal(fake.calls.length, 1);
  s.rebind({ profile: profile(), binding: binding() });
  await assert.rejects(adapter.proposeMemory(input), /HYBRID_FENCED/u);
  const refs = [
    { id: 'fixture/a', revision: 1 },
    { id: 'fixture/b', revision: 2 },
  ];
  const ordered = create(fake.lane, () => true, { binding: { ...binding(), sourceRefs: refs } });
  assert.throws(() => ordered.propose(request('fixture/count')), /HYBRID_SOURCE_MISMATCH/u);
  await ordered.propose({
    requestId: 'fixture/ordered',
    selectedEvidence: [...evidence(), { ...evidence()[0]!, selectedText: 'Second synthetic evidence.' }],
  });
  const sent = JSON.parse(new TextDecoder().decode(fake.calls.at(-1)!.requestBytes)) as {
    binding: HybridBinding;
    selectedEvidence: Evidence[];
  };
  assert.deepEqual(sent.binding.sourceRefs, refs);
  assert.equal(sent.selectedEvidence[1]?.selectedText, 'Second synthetic evidence.');
  for (const key of ['image', 'audio', 'video', 'attachments']) {
    const bad = [{ ...evidence()[0]!, [key]: 'fixture/media' }];
    assert.throws(() => s.propose({ requestId: `fixture/${key}`, selectedEvidence: bad }), /HYBRID_WIRE_SHAPE/u);
  }
  assert.equal(fake.calls.length, 2);
  s.close();
  ordered.close();
});

test('F17 copies inputs/results and rejects synchronous validator, thenable and port reentry', async () => {
  const p = structuredClone(profile()),
    b = structuredClone(binding()),
    e = evidence();
  const pending = deferred<HybridReply>();
  let captured!: PortInput;
  const lane = new HybridBackendLane({
    generate: (input) => {
      captured = input;
      return pending.promise;
    },
  });
  const s = new HybridInferenceSession({ lane, profile: p, binding: b, validateCurrent: () => true });
  const work = s.propose({ requestId: 'fixture/copy', selectedEvidence: e });
  (p.model as { id: string }).id = 'fixture/mutated';
  (b.namespace as { subjectId: string }).subjectId = 'fixture/mutated';
  e[0]!.selectedText = 'Mutated';
  const sent = JSON.parse(new TextDecoder().decode(captured.requestBytes)) as {
    binding: HybridBinding;
    selectedEvidence: Evidence[];
  };
  assert.equal(sent.binding.namespace.subjectId, 'fixture/subject');
  assert.equal(sent.selectedEvidence[0]?.selectedText, 'Synthetic selected evidence.');
  const response = final(captured);
  pending.resolve(response);
  const output = await work;
  response.body.fill(0);
  output.statement = 'Mutated';
  assert.deepEqual(await s.propose({ requestId: 'fixture/copy', selectedEvidence: evidence() }), proposal);
  s.close();
  for (const phase of ['dispatch', 'deliver', 'replay'] as const) {
    const fake = immediate();
    let target!: HybridInferenceSession;
    let visits = 0;
    target = create(fake.lane, ({ phase: actual }) => {
      if (actual === phase) {
        visits++;
        assert.throws(() => target.rebind({ profile: profile(), binding: binding() }), /HYBRID_REENTRY/u);
        assert.throws(() => target.propose(request('fixture/reenter')), /HYBRID_REENTRY/u);
        assert.throws(() => target.close(), /HYBRID_REENTRY/u);
      }
      return true;
    });
    await target.propose(request());
    await target.propose(request());
    assert.equal(visits, 1);
    target.close();
    let thenTarget!: HybridInferenceSession;
    let thenVisits = 0;
    let denying = phase !== 'replay';
    thenTarget = create(fake.lane, ({ phase: actual }) =>
      actual === phase && denying
        ? {
            then(_yes: unknown, no: (error: Error) => void) {
              thenVisits++;
              assert.throws(() => thenTarget.rebind({ profile: profile(), binding: binding() }), /HYBRID_REENTRY/u);
              no(new Error('fixture/denied'));
            },
          }
        : true,
    );
    if (phase === 'replay') {
      await thenTarget.propose(request(`fixture/then-${phase}`));
      denying = true;
    }
    await assert.rejects(
      async () => thenTarget.propose(request(`fixture/then-${phase}`)),
      /HYBRID_CURRENTNESS_DENIED/u,
    );
    assert.equal(thenVisits, 1);
    thenTarget.close();
  }
  let portSession!: HybridInferenceSession;
  const portLane = new HybridBackendLane({
    generate: async (input) => {
      assert.throws(() => portSession.propose(request('fixture/port-reentry')), /HYBRID_REENTRY/u);
      assert.throws(() => portSession.close(), /HYBRID_REENTRY/u);
      return final(input);
    },
  });
  portSession = create(portLane);
  await portSession.propose(request());
  portSession.close();
  await tick();
});

test('F18 qualification stays declaration-only without durable, loaded-model or hardware acceptance', () => {
  const fake = immediate(),
    s = create(fake.lane);
  assert(profile().profileId.startsWith('fixture/'));
  assert.deepEqual(s.qualification, {
    identity: 'DECLARATION_ONLY',
    loadedModel: 'NOT_AUTHENTICATED',
    durableDedupe: 'NOT_SUPPORTED',
    coreWiring: 'PENDING_OWNER',
    tensorState: 'NOT_SUPPORTED',
    hardware: 'NOT_VALIDATED',
  });
  assert(Object.isFrozen(s.qualification));
  assert.equal(fake.calls.length, 0);
  s.close();
  for (const timeoutMs of [0, 30001, NaN, 1.5])
    assert.throws(() => create(fake.lane, () => true, { timeoutMs }), /HYBRID_TIMEOUT_INVALID/u);
});
