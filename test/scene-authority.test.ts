import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SceneAuthorityService } from '../src/scene-authority.ts';
import { SceneContract } from '../src/scene.ts';
import { MemoryStore } from '../src/store.ts';
import { fixture, graph, code, claim, identity } from './retrieval-fixtures.ts';
import { ready, scene, epoch, reset, replace } from './scene-authority-fixtures.ts';

test('actual source assurance is separate from claim truth and contains no original source text', (t) => {
  const f = ready(t),
    before = f.store.snapshot(),
    persisted = f.persisted(),
    reads = f.reads();
  const consumer = f.service.register(f.binding);
  reset(f.service, f.binding, consumer);
  const frame = replace(f.service, f.binding, consumer);
  assert.doesNotMatch(JSON.stringify(frame), /cup|alice|statement|selectedText|scope|sha256|digest/);
  const result = f.service.resolve(f.binding, consumer, frame.frame);
  assert.ok('data' in result);
  assert.equal(result.data.sourceAssurance, 'CURRENT_STORE_SOURCE_BOUND');
  assert.equal(result.data.claimAssurance, 'NOT_VERIFIED');
  assert.equal(result.data.view.assurance, 'NOT_AUTHENTICATED');
  assert.equal(result.data.sources[0]!.mode, 'self_report');
  assert.equal(result.data.authority.generation, 0);
  assert.equal(result.data.authority.consentRevision, 0);
  assert.doesNotMatch(JSON.stringify(result), /ANCESTOR|derived blue|statement|selectedText|speakerId|alice/);
  assert.ok(Object.isFrozen(result.data.view.packet.claims[0]!.value));
  assert.ok(f.reads() > reads);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.persisted(), persisted);
});

for (const mode of ['observation', 'self_report', 'quotation'] as const)
  test(`actual ${mode} origin retains its mode`, (t) => {
    const f = ready(t, mode);
    assert.equal(f.service.read(f.binding).sources[0]!.mode, mode);
    const forged = structuredClone(f.catalog);
    forged.declaredSources[0]!.kind = mode === 'observation' ? 'report' : 'observation';
    assert.throws(
      () => f.service.bind({ ...f.input, catalogJson: JSON.stringify(forged) }),
      code('SCENE_SOURCE_MISMATCH'),
    );
  });

test('catalog checks unused sources and profile lineage; inference and derived memory are not direct observations', (t) => {
  const f = ready(t),
    other = f.event('outside'),
    inferred = f.event('inference', { mode: 'inference' }),
    derived = f.publish([inferred], { ...claim, kind: 'belief', basis: 'inference', validTo: 200_000 });
  const extra = structuredClone(f.catalog);
  extra.declaredSources.push({ ...extra.declaredSources[0]!, ref: { id: other.id, revision: 1 } });
  assert.throws(
    () => f.service.bind({ ...f.input, catalogJson: JSON.stringify(extra) }),
    code('SCENE_SOURCE_MISMATCH'),
  );
  extra.mappingProfiles[0]!.calibrationLineage = [{ id: other.id, revision: 1 }];
  assert.throws(
    () => f.service.bind({ ...f.input, catalogJson: JSON.stringify(extra) }),
    code('SCENE_SOURCE_MISMATCH'),
  );
  const inferredScene = scene(f.scope, inferred, 'inference');
  assert.throws(
    () =>
      f.service.bind({
        epoch: epoch(f.scope),
        publishedRefs: [derived],
        catalogJson: JSON.stringify(inferredScene.catalog),
      }),
    code('SCENE_SOURCE_ORIGIN_UNSUPPORTED'),
  );
  const memoryScene = scene(f.scope, f.memory);
  assert.throws(
    () => f.service.bind({ ...f.input, catalogJson: JSON.stringify(memoryScene.catalog) }),
    code('SCENE_SOURCE_MISMATCH'),
  );
  // Inference roots not claimed by the catalog remain valid members of the full gated pool.
  const mixed = f.service.bind({ ...f.input, publishedRefs: [f.memory, derived] });
  f.service.stage(mixed, JSON.stringify(f.packet));
  f.store.revoke(f.scope, inferred);
  assert.throws(() => f.service.read(mixed), code('STALE_SOURCE'));
});

test('historical source consent is not current scope permission and ordinary reads do not require learning', (t) => {
  const f = ready(t),
    on = f.store.setLearningConsent(f.scope, true),
    off = f.store.setLearningConsent(on, false),
    d = scene(off, f.root);
  assert.equal(off.learningAllowed, false);
  const binding = f.service.bind({
    epoch: epoch(off),
    publishedRefs: [f.memory],
    catalogJson: JSON.stringify(d.catalog),
  });
  f.service.stage(binding, JSON.stringify(d.packet));
  assert.equal(f.service.read(binding).authority.consentRevision, 2);
  assert.throws(() => f.service.read(f.binding), code('STALE_CONSENT'));
});

test('content dedup, monotone packet revisions and fixed packet id are bounded to this binding', (t) => {
  const f = ready(t),
    consumer = f.service.register(f.binding);
  reset(f.service, f.binding, consumer);
  const first = replace(f.service, f.binding, consumer),
    reads = f.reads();
  assert.deepEqual(f.service.stage(f.binding, JSON.stringify(f.packet, null, 2)), { revision: 1, duplicate: true });
  assert.equal(f.reads(), reads + 1);
  assert.equal(f.service.pull(f.binding, consumer)!.frame, first.frame);
  const changed = structuredClone(f.packet);
  changed.claims[2]!.value = { kind: 'text', text: 'green' };
  assert.throws(() => f.service.stage(f.binding, JSON.stringify(changed)), code('SCENE_PACKET_REVISION_CONFLICT'));
  changed.ref.revision = 2;
  assert.deepEqual(f.service.stage(f.binding, JSON.stringify(changed)), { revision: 2, duplicate: false });
  assert.throws(() => f.service.acknowledge(f.binding, consumer, first.frame), code('SCENE_FRAME_STALE'));
  assert.throws(() => f.service.stage(f.binding, JSON.stringify(f.packet)), code('SCENE_PACKET_REVISION_STALE'));
  changed.ref.id = 'other';
  assert.throws(() => f.service.stage(f.binding, JSON.stringify(changed)), code('SCENE_PACKET_ID_MISMATCH'));
  assert.equal(f.service.read(f.binding).view.packet.ref.revision, 2);
});

test('bad JSON and invalid candidate time do not replace a still-valid current packet', (t) => {
  const f = ready(t),
    old = f.service.export(f.binding);
  assert.throws(() => f.service.stage(f.binding, '{"broken":'), code('SCENE_INVALID_JSON'));
  for (const applicability of [
    { from: 100_001, to: null },
    { from: null, to: 100_000 },
  ]) {
    const packet = structuredClone(f.packet);
    packet.ref.revision++;
    packet.applicability = applicability;
    assert.throws(() => f.service.stage(f.binding, JSON.stringify(packet)), code('SCENE_PACKET_NOT_CURRENT'));
    assert.equal(f.service.export(f.binding), old);
  }
});

test('two consumers synchronize independently; stages preserve an unacknowledged reset and coalesce intermediate versions', (t) => {
  const f = ready(t),
    fast = f.service.register(f.binding),
    slow = f.service.register(f.binding);
  reset(f.service, f.binding, fast);
  const slowReset = f.service.pull(f.binding, slow)!;
  const a = replace(f.service, f.binding, fast);
  f.service.acknowledge(f.binding, fast, a.frame);
  assert.equal(f.service.pull(f.binding, fast), null);
  for (const revision of [2, 3]) {
    const packet = structuredClone(f.packet);
    packet.ref.revision = revision;
    f.service.stage(f.binding, JSON.stringify(packet));
  }
  assert.equal(f.service.pull(f.binding, slow)!.frame, slowReset.frame);
  assert.deepEqual(Object.keys(f.service.resolve(f.binding, slow, slowReset.frame)), ['info']);
  f.service.acknowledge(f.binding, slow, slowReset.frame);
  const slowLatest = replace(f.service, f.binding, slow),
    fastLatest = replace(f.service, f.binding, fast);
  assert.equal(slowLatest.info.revision, 3);
  assert.equal(fastLatest.info.revision, 3);
  assert.equal(f.service.pull(f.binding, slow)!.frame, slowLatest.frame);
  assert.throws(() => f.service.acknowledge(f.binding, slow, fastLatest.frame), code('SCENE_FRAME_STALE'));
  f.service.acknowledge(f.binding, fast, fastLatest.frame);
  assert.equal(f.service.pull(f.binding, fast), null);
  assert.equal(f.service.pull(f.binding, slow)!.frame, slowLatest.frame);
  f.service.acknowledge(f.binding, slow, slowLatest.frame);
  assert.equal(f.service.pull(f.binding, slow), null);
});

test('late replace ACK/resolve cannot clear a newer reset; cleanup remains possible after unbind', (t) => {
  const f = ready(t),
    consumer = f.service.register(f.binding);
  reset(f.service, f.binding, consumer);
  const old = replace(f.service, f.binding, consumer);
  f.service.resolve(f.binding, consumer, old.frame);
  f.service.pause(f.binding);
  const clearing = f.service.pull(f.binding, consumer)!;
  for (const run of [
    () => f.service.resolve(f.binding, consumer, old.frame),
    () => f.service.acknowledge(f.binding, consumer, old.frame),
  ])
    assert.throws(run, code('SCENE_FRAME_STALE'));
  f.service.pause(f.binding);
  f.service.unbind(f.binding);
  f.service.unbind(f.binding);
  assert.equal(f.service.pull(f.binding, consumer)!.frame, clearing.frame);
  assert.deepEqual(Object.keys(f.service.resolve(f.binding, consumer, clearing.frame)), ['info']);
  f.service.acknowledge(f.binding, consumer, clearing.frame);
  f.service.acknowledge(f.binding, consumer, clearing.frame);
  assert.throws(() => f.service.read(f.binding), code('SCENE_REBIND_REQUIRED'));
  assert.throws(() => f.service.resume(f.binding), code('SCENE_REBIND_REQUIRED'));
});

test('resume does not restore data; explicit identical restage uses the new barrier and cannot be hidden by old ACK', (t) => {
  const f = ready(t),
    consumer = f.service.register(f.binding);
  reset(f.service, f.binding, consumer);
  const old = replace(f.service, f.binding, consumer);
  f.service.acknowledge(f.binding, consumer, old.frame);
  f.service.pause(f.binding);
  const clear = reset(f.service, f.binding, consumer);
  assert.throws(() => f.service.stage(f.binding, JSON.stringify(f.packet)), code('SCENE_PAUSED'));
  f.service.resume(f.binding);
  assert.throws(() => f.service.read(f.binding), code('SCENE_NOT_READY'));
  assert.equal(f.service.pull(f.binding, consumer), null);
  assert.deepEqual(f.service.stage(f.binding, JSON.stringify(f.packet)), { revision: 1, duplicate: true });
  const fresh = replace(f.service, f.binding, consumer);
  assert.ok(fresh.info.barrier > old.info.barrier);
  assert.notEqual(fresh.frame, old.frame);
  assert.throws(() => f.service.acknowledge(f.binding, consumer, old.frame), code('SCENE_FRAME_STALE'));
  assert.equal(f.service.pull(f.binding, consumer)!.frame, fresh.frame);
  f.service.acknowledge(f.binding, consumer, fresh.frame);
  assert.throws(() => f.service.acknowledge(f.binding, consumer, clear.frame), code('SCENE_FRAME_STALE'));
});

test('paused to unbound after reset ACK does not create another cleanup generation', (t) => {
  const f = ready(t),
    consumer = f.service.register(f.binding);
  reset(f.service, f.binding, consumer);
  f.service.pause(f.binding);
  const clear = reset(f.service, f.binding, consumer);
  f.service.unbind(f.binding);
  assert.deepEqual(f.service.acknowledge(f.binding, consumer, clear.frame), clear.info);
  assert.throws(() => f.service.pull(f.binding, consumer), code('SCENE_REBIND_REQUIRED'));
});

for (const operation of ['read', 'export', 'stage', 'pull', 'resolve', 'ack', 'duplicate-ack'] as const)
  test(`source revocation terminates ${operation}, while reset cleanup reveals no payload`, (t) => {
    const f = ready(t),
      consumer = f.service.register(f.binding);
    reset(f.service, f.binding, consumer);
    const offered = replace(f.service, f.binding, consumer);
    if (operation === 'duplicate-ack') f.service.acknowledge(f.binding, consumer, offered.frame);
    f.store.revoke(f.scope, f.root);
    const action = () => {
      if (operation === 'read') return f.service.read(f.binding);
      if (operation === 'export') return f.service.export(f.binding);
      if (operation === 'stage') return f.service.stage(f.binding, JSON.stringify(f.packet));
      if (operation === 'pull') return f.service.pull(f.binding, consumer);
      if (operation === 'resolve') return f.service.resolve(f.binding, consumer, offered.frame);
      return f.service.acknowledge(f.binding, consumer, offered.frame);
    };
    assert.throws(action, code('STALE_SOURCE'));
    const clear = f.service.pull(f.binding, consumer)!;
    assert.equal(clear.info.operation, 'reset');
    f.service.unbind(f.binding);
    assert.equal(f.service.pull(f.binding, consumer)!.frame, clear.frame);
    assert.deepEqual(Object.keys(f.service.resolve(f.binding, consumer, clear.frame)), ['info']);
    f.service.acknowledge(f.binding, consumer, clear.frame);
    assert.throws(() => f.service.resume(f.binding), code('SCENE_REBIND_REQUIRED'));
  });

test('all-pool TTL is checked even when the expired memory is absent from the catalog and packet', (t) => {
  const f = ready(t),
    extra = f.publish([f.event('extra')], { ...claim, validTo: 100_010 });
  const binding = f.service.bind({ ...f.input, publishedRefs: [f.memory, extra] });
  f.service.stage(binding, JSON.stringify(f.packet));
  f.setWall(100_010);
  assert.throws(() => f.service.read(binding), code('STALE_SOURCE'));
  f.setWall(100_000);
  assert.throws(() => f.service.read(binding), code('SCENE_REBIND_REQUIRED'));
});

test('observed packet expiry cannot be bypassed by newer stage or wall-clock rollback', (t) => {
  const f = ready(t),
    expiring = structuredClone(f.packet);
  expiring.ref.revision = 2;
  expiring.applicability.to = 100_001;
  f.service.stage(f.binding, JSON.stringify(expiring));
  f.setWall(100_001);
  const next = structuredClone(f.packet);
  next.ref.revision = 3;
  assert.throws(() => f.service.stage(f.binding, JSON.stringify(next)), code('SCENE_PACKET_NOT_CURRENT'));
  f.setWall(100_000);
  assert.throws(() => f.service.resume(f.binding), code('SCENE_REBIND_REQUIRED'));
});

test('clock rollback and source metadata changes terminate previously valid bindings', (t) => {
  const f = ready(t);
  f.setWall(99_999);
  assert.throws(() => f.service.read(f.binding), code('SCENE_CLOCK_ROLLBACK'));
  f.setWall(100_000);
  assert.throws(() => f.service.read(f.binding), code('SCENE_REBIND_REQUIRED'));
  const g = graph(t);
  g.node('root', 'event');
  const memory = g.node('m', 'memory', ['root']),
    d = scene(g.scope, g.ref('root'));
  const service = new SceneAuthorityService(g.store),
    binding = service.bind({ epoch: epoch(g.scope), publishedRefs: [memory], catalogJson: JSON.stringify(d.catalog) });
  service.stage(binding, JSON.stringify(d.packet));
  g.injector.prepare("UPDATE nodes SET created_at=created_at+1 WHERE id='root'").run();
  assert.throws(() => service.read(binding), code('SCENE_SOURCE_CHANGED'));
});

for (const mutation of ['purge', 'consent-aba', 'unrelated-revoke', 'revise', 'artifact'] as const)
  test(`current authority detects ${mutation}`, (t) => {
    const f = ready(t);
    if (mutation === 'purge') f.store.purge(f.scope);
    else if (mutation === 'consent-aba') {
      const on = f.store.setLearningConsent(f.scope, true);
      f.store.setLearningConsent(on, false);
    } else if (mutation === 'unrelated-revoke') f.store.revoke(f.scope, f.event('outside'));
    else if (mutation === 'revise')
      f.store.reviseEvent(f.scope, f.root, {
        speakerId: 'alice',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'new synthetic',
        occurredAt: null,
      });
    else {
      const on = f.store.setLearningConsent(f.scope, true),
        d = scene(on, f.root),
        service = new SceneAuthorityService(f.store);
      const binding = service.bind({
        epoch: epoch(on),
        publishedRefs: [f.memory],
        catalogJson: JSON.stringify(d.catalog),
      });
      service.stage(binding, JSON.stringify(d.packet));
      const job = f.store.beginJob(on, [f.root], 'training'),
        lease = f.store.claimLease(on, job.id);
      const artifact = f.store.registerArtifact(on, job.id, lease.token, {
        sha256: 'a'.repeat(64),
        implementation: 'synthetic',
      });
      f.store.activateArtifact(on, artifact.id);
      assert.throws(() => service.read(binding), code('SCENE_AUTHORITY_CHANGED'));
      return;
    }
    assert.throws(
      () => f.service.read(f.binding),
      code(
        mutation === 'purge'
          ? 'STALE_SCOPE'
          : mutation === 'consent-aba'
            ? 'STALE_CONSENT'
            : mutation === 'unrelated-revoke'
              ? 'SCENE_AUTHORITY_CHANGED'
              : 'STALE_SOURCE',
      ),
    );
  });

test('empty pool and no-current packet still perform the authority gate', (t) => {
  const f = fixture(t),
    d = scene(f.scope, { id: 'unused', revision: 1 });
  d.catalog = { version: 2, concepts: [], mappingProfiles: [], prototypes: [], declaredSources: [] };
  const service = new SceneAuthorityService(f.store),
    binding = service.bind({ epoch: epoch(f.scope), publishedRefs: [], catalogJson: JSON.stringify(d.catalog) });
  const consumer = service.register(binding);
  reset(service, binding, consumer);
  const reads = f.reads();
  assert.equal(service.pull(binding, consumer), null);
  assert.equal(f.reads(), reads + 1);
  f.store.purge(f.scope);
  assert.throws(() => service.read(binding), code('STALE_SCOPE'));
});

test('closed inputs reject proxies, getters, iterators and huge arrays before caller code can run', (t) => {
  const f = ready(t);
  let calls = 0;
  const proxy = new Proxy(f.input, {
    get() {
      calls++;
      throw Error('private');
    },
    ownKeys() {
      calls++;
      throw Error('private');
    },
  });
  assert.throws(() => f.service.bind(proxy), code('INVALID_INPUT'));
  const getter = Object.defineProperty({ ...f.input }, 'epoch', {
    get() {
      calls++;
      return f.input.epoch;
    },
  });
  assert.throws(() => f.service.bind(getter), code('INVALID_INPUT'));
  for (const kind of ['proxy', 'iterator', 'accessor', 'sparse', 'extra'] as const) {
    let selected = [f.memory];
    if (kind === 'proxy')
      selected = new Proxy(selected, {
        get() {
          calls++;
          throw Error('private');
        },
      });
    else if (kind === 'iterator')
      Object.defineProperty(selected, Symbol.iterator, {
        value: function* () {
          calls++;
          yield f.memory;
        },
      });
    else if (kind === 'accessor')
      Object.defineProperty(selected, '0', {
        get() {
          calls++;
          return f.memory;
        },
      });
    else if (kind === 'sparse') selected = new Array(1);
    else Object.assign(selected, { extra: true });
    assert.throws(() => f.service.bind({ ...f.input, publishedRefs: selected }), code('INVALID_INPUT'));
  }
  const huge = new Array(33);
  Object.defineProperty(huge, '0', {
    get() {
      calls++;
      return f.memory;
    },
  });
  assert.throws(() => f.service.bind({ ...f.input, publishedRefs: huge }), code('SCENE_SOURCE_LIMIT'));
  for (const value of [proxy, getter]) {
    assert.throws(() => f.service.stage(f.binding, value as never), code('SCENE_INVALID_JSON'));
    assert.throws(() => f.service.import(f.binding, value as never), code('SCENE_INVALID_JSON'));
  }
  assert.equal(calls, 0);
  for (const bad of [
    { ...f.input, authorized: true },
    { ...f.input, epoch: { ...f.input.epoch, runtimeEpoch: 0 } },
    { ...f.input, publishedRefs: [{ ...f.memory, source: 'forged' }] },
  ])
    assert.throws(() => f.service.bind(bad), code('INVALID_INPUT'));
});

test('handles are service and binding specific, copied handles reject, and consumer count is bounded', (t) => {
  const f = ready(t),
    other = new SceneAuthorityService(f.store),
    sibling = f.service.bind(f.input),
    consumer = f.service.register(f.binding);
  const offered = f.service.pull(f.binding, consumer)!;
  assert.throws(() => other.read(f.binding), code('UNAUTHENTICATED'));
  assert.throws(() => f.service.read({ ...f.binding }), code('UNAUTHENTICATED'));
  assert.throws(() => f.service.pull(sibling, consumer), code('UNAUTHENTICATED'));
  assert.throws(() => f.service.pull(f.binding, { ...consumer }), code('UNAUTHENTICATED'));
  assert.throws(() => f.service.resolve(f.binding, consumer, { ...offered.frame }), code('SCENE_FRAME_STALE'));
  for (let i = 1; i < 8; i++) f.service.register(f.binding);
  assert.throws(() => f.service.register(f.binding), code('SCENE_CONSUMER_LIMIT'));
  f.input.epoch.generation = 999;
  f.input.publishedRefs[0]!.revision = 999;
  assert.equal(f.service.read(f.binding).authority.generation, 0);
});

test('JSON exchange conveys declarations only and restaging imports freshly checks source permission', (t) => {
  const f = ready(t),
    exported = f.service.export(f.binding),
    pure = new SceneContract(JSON.stringify(f.catalog), 2);
  assert.equal(pure.import(exported).assurance, 'NOT_AUTHENTICATED');
  assert.doesNotMatch(exported, /CURRENT_STORE_SOURCE_BOUND|runtimeEpoch|metadataIdentity|consumer|barrier/);
  const binding = f.service.bind(f.input);
  assert.deepEqual(f.service.import(binding, exported), { revision: 1, duplicate: false });
  f.store.revoke(f.scope, f.root);
  assert.throws(() => f.service.import(binding, exported), code('STALE_SOURCE'));
  assert.throws(() => f.service.bind(f.input), code('STALE_SOURCE'));
  assert.equal(pure.import(exported).assurance, 'NOT_AUTHENTICATED');
});

test('poisoned Store ends data access but cannot block the body-free reset cleanup', (t) => {
  let broken = false;
  const store = new MemoryStore(':memory:', {
    persist: () => {
      if (broken) throw Error('synthetic persistence failure');
    },
  });
  t.after(() => store.close());
  const scope = store.ensureScope(identity),
    service = new SceneAuthorityService(store);
  const catalogJson = JSON.stringify({
    version: 2,
    concepts: [],
    mappingProfiles: [],
    prototypes: [],
    declaredSources: [],
  });
  const binding = service.bind({ epoch: epoch(scope), publishedRefs: [], catalogJson }),
    consumer = service.register(binding),
    pending = service.pull(binding, consumer)!;
  broken = true;
  assert.throws(() => store.ensureScope({ ...identity, tenantId: 'other' }), /synthetic persistence failure/);
  assert.throws(() => service.read(binding), code('DURABLE_UNAVAILABLE'));
  assert.equal(service.pull(binding, consumer)!.frame, pending.frame);
  reset(service, binding, consumer);
  assert.throws(() => service.resume(binding), code('SCENE_REBIND_REQUIRED'));
});

test('source service calls never acknowledge the global outbox', (t) => {
  const f = ready(t),
    clone = new DatabaseSync(':memory:');
  t.after(() => clone.close());
  clone.deserialize(f.store.snapshot());
  const before = clone.prepare('SELECT * FROM outbox ORDER BY id').all();
  const consumer = f.service.register(f.binding);
  reset(f.service, f.binding, consumer);
  const offered = replace(f.service, f.binding, consumer);
  f.service.acknowledge(f.binding, consumer, offered.frame);
  f.service.pause(f.binding);
  reset(f.service, f.binding, consumer);
  f.service.resume(f.binding);
  f.service.unbind(f.binding);
  clone.deserialize(f.store.snapshot());
  assert.deepEqual(clone.prepare('SELECT * FROM outbox ORDER BY id').all(), before);
});
