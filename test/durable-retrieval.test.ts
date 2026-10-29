import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { MemoryStore } from '../src/store.ts';
import { RetrievalService } from '../src/retrieval.ts';
import type { Epoch, Proposal, SourceRef } from '../src/contracts.ts';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'retrieval' };
const event = (key: string) => ({
  source: 'synthetic',
  eventKey: key,
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: `ANCESTOR_ONLY_${key}`,
    occurredAt: null,
  },
});
const claim: Proposal = {
  kind: 'claim',
  statement: 'blue violet',
  basis: 'self_report',
  validFrom: null,
  validTo: null,
};
function publish(s: MemoryStore, scope: Epoch, refs: SourceRef[], body: Proposal = claim): SourceRef {
  const job = s.beginJob(scope, refs),
    lease = s.claimLease(scope, job.id);
  s.propose(scope, job.id, lease.token, body);
  return { id: s.publish(scope, job.id, lease.token).id, revision: 1 };
}
function fixture(t: TestContext) {
  let wall = 100,
    commits = 0,
    accesses = 0;
  const s = new MemoryStore(':memory:', {
    schemaVersion: 2,
    clock: { wall: () => wall, monotonic: () => 0 },
    persist: () => {
      commits++;
    },
    aroundAccess: (run) => {
      accesses++;
      return run();
    },
  });
  t.after(() => s.close());
  const scope = s.ensureScope(who);
  return {
    s,
    scope,
    service: new RetrievalService(s),
    setWall: (n: number) => {
      wall = n;
    },
    commits: () => commits,
    accesses: () => accesses,
  };
}

test('durable complete selection drives the actual bind refresh query resolve path and independent scene progress', (t) => {
  const f = fixture(t),
    a = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
    b = f.s.registerConsumer('scene', f.scope, 'scene-source-refs-v1');
  const root = f.s.acceptEvent(f.scope, event('one')),
    memory = publish(f.s, f.scope, [root]);
  f.s.applyConsumers([a]);
  const binding = f.service.bindConsumer(a);
  assert.equal(f.service.refresh(binding).counts.memories, 1);
  const candidate = f.service.query(binding, { text: 'blue' }).candidate,
    result = f.service.resolve(binding, candidate);
  assert.deepEqual(
    result.hits.map((h) => h.memory.id),
    [memory.id],
  );
  assert.doesNotMatch(JSON.stringify(result), /ANCESTOR_ONLY|selectedText/);
  assert.throws(() => f.s.readConsumer(b), /FANOUT_STALE_PROJECTION/);
  const snapshot = f.s.consumerRetrievalSnapshot(a);
  assert.equal(snapshot.consumer.applied, snapshot.consumer.head);
  assert.equal(snapshot.consumer.id, a.id);
  assert.equal(snapshot.consumer.readAsOf, 100);
  assert.deepEqual(
    snapshot.selected.map((i) => i.memory.id),
    [memory.id],
  );
  assert.deepEqual(result.consumer, snapshot.consumer);
});

test('one guard and one wall read cover the TTL sweep, complete metadata and full body closure', (t) => {
  let wall = 100,
    reads = 0,
    guards = 0;
  const s = new MemoryStore(':memory:', {
    schemaVersion: 2,
    clock: {
      wall: () => {
        reads++;
        return wall++;
      },
      monotonic: () => 0,
    },
    aroundAccess: (run) => {
      guards++;
      return run();
    },
  });
  t.after(() => s.close());
  const scope = s.ensureScope(who),
    root = s.acceptEvent(scope, event('one')),
    memory = publish(s, scope, [root], { ...claim, validTo: 200 });
  const h = s.registerConsumer('recall', scope, 'retrieval-refs-v1');
  wall = 199;
  reads = 0;
  guards = 0;
  const snapshot = s.consumerRetrievalSnapshot(h);
  assert.equal(reads, 1);
  assert.equal(guards, 1);
  assert.equal(snapshot.asOf, 199);
  assert.equal(snapshot.consumer.readAsOf, 199);
  assert.ok(snapshot.consumer.projectionAsOf < 199);
  assert.deepEqual(
    snapshot.selected.map((i) => i.memory.id),
    [memory.id],
  );
  assert.throws(() => s.consumerRetrievalSnapshot(h), /FANOUT_STALE_PROJECTION/);
});

test('no-change bind refresh query resolve reads have no durable commits and advancing read time keeps the pair valid', (t) => {
  const f = fixture(t),
    root = f.s.acceptEvent(f.scope, event('one'));
  publish(f.s, f.scope, [root]);
  const h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
    before = f.commits();
  const b = f.service.bindConsumer(h);
  f.service.refresh(b);
  const candidate = f.service.query(b, { text: 'blue' }).candidate;
  f.setWall(101);
  assert.equal(f.service.resolve(b, candidate).consumer!.readAsOf, 101);
  assert.equal(f.service.query(b, { text: 'absent' }).report.hits, 0);
  assert.equal(f.commits(), before);
});

for (const refreshFirst of [false, true])
  test(`new publications require apply and ${refreshFirst ? 'explicit refresh can rebuild' : 'observed stale state terminates the binding'}`, (t) => {
    const f = fixture(t),
      root = f.s.acceptEvent(f.scope, event('one')),
      first = publish(f.s, f.scope, [root]);
    const h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
      b = f.service.bindConsumer(h);
    f.service.refresh(b);
    const old = f.service.query(b, { text: 'blue' }).candidate,
      second = publish(f.s, f.scope, [root], { ...claim, statement: 'red associated' });
    if (!refreshFirst) assert.throws(() => f.service.resolve(b, old), /FANOUT_STALE_PROJECTION/);
    f.s.applyConsumers([h]);
    if (!refreshFirst) assert.throws(() => f.service.refresh(b), /UNAUTHENTICATED/);
    const current = refreshFirst ? b : f.service.bindConsumer(h);
    assert.equal(f.service.refresh(current).counts.memories, 2);
    assert.throws(() => f.service.resolve(current, old), /UNAUTHENTICATED/);
    const result = f.service.resolve(current, f.service.query(current, { text: 'blue' }).candidate);
    assert.deepEqual(
      result.hits.map((h) => [h.memory.id, h.kind]),
      [
        [first.id, 'direct_lexical'],
        [second.id, 'shared_root'],
      ],
    );
  });

test('another scope advances the required prefix even when every selected memory remains equal', (t) => {
  const f = fixture(t),
    root = f.s.acceptEvent(f.scope, event('one'));
  publish(f.s, f.scope, [root]);
  const other = f.s.ensureScope({ ...who, relationshipId: 'other' }),
    h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1');
  const b = f.service.bindConsumer(h);
  f.service.refresh(b);
  const old = f.service.query(b, { text: 'blue' }).candidate;
  const before = f.s.consumerRetrievalSnapshot(h);
  f.s.acceptEvent(other, event('other'));
  f.s.applyConsumers([h]);
  const after = f.s.consumerRetrievalSnapshot(h);
  assert.deepEqual(after.selected, before.selected);
  assert.ok(after.consumer.applied > before.consumer.applied);
  assert.throws(() => f.service.resolve(b, old), /RETRIEVAL_SOURCE_CHANGED/);
  assert.throws(() => f.service.refresh(b), /UNAUTHENTICATED/);
});

for (const empty of [false, true])
  for (const action of ['revise', 'revoke', 'consent', 'purge', 'pause', 'reset', 'retention', 'runtime'] as const)
    test(`${action} fences old ${empty ? 'empty' : 'populated'} bindings and candidates`, (t) => {
      const f = fixture(t);
      let scope = f.scope;
      if (action === 'runtime') scope = f.s.setLearningConsent(scope, true);
      const root = f.s.acceptEvent(scope, event('one'));
      if (!empty) publish(f.s, scope, [root]);
      const h = f.s.registerConsumer('recall', scope, 'retrieval-refs-v1'),
        b = f.service.bindConsumer(h);
      f.service.refresh(b);
      const candidate = f.service.query(b, { text: 'blue' }).candidate;
      if (action === 'revise') f.s.reviseEvent(scope, root, event('changed').evidence);
      if (action === 'revoke') f.s.revoke(scope, root);
      if (action === 'consent') f.s.setLearningConsent(scope, true);
      if (action === 'purge') f.s.purge(scope);
      if (action === 'pause') f.s.pauseConsumer(h);
      if (action === 'reset') f.s.resetConsumer(h.id, scope);
      if (action === 'retention') {
        f.s.acceptEvent(scope, event('newer'));
        f.s.pruneJournal(0);
      }
      if (action === 'runtime') {
        const job = f.s.beginJob(scope, [root], 'training'),
          lease = f.s.claimLease(scope, job.id);
        const artifact = f.s.registerArtifact(scope, job.id, lease.token, {
          sha256: 'a'.repeat(64),
          implementation: 'synthetic-metadata-only',
        });
        f.s.activateArtifact(scope, artifact.id);
      }
      assert.throws(() => f.service.resolve(b, candidate), /FANOUT_STALE_HANDLE/);
      assert.throws(() => f.service.refresh(b), /UNAUTHENTICATED/);
      const now = f.s.scope(scope.id),
        fresh = f.s.resetConsumer(h.id, now),
        rebound = f.service.bindConsumer(fresh);
      f.service.refresh(rebound);
      assert.doesNotThrow(() => f.service.resolve(rebound, f.service.query(rebound, { text: 'blue' }).candidate));
    });

test('future start and ancestor expiry persist TTL barriers, then explicit apply allows a new complete selection', (t) => {
  const f = fixture(t),
    root = f.s.acceptEvent(f.scope, event('one')),
    parent = publish(f.s, f.scope, [root], { ...claim, validTo: 200 });
  publish(f.s, f.scope, [parent]);
  const future = publish(f.s, f.scope, [root], { ...claim, validFrom: 150, validTo: 250 });
  const h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
    b = f.service.bindConsumer(h);
  f.service.refresh(b);
  const candidate = f.service.query(b, { text: 'blue' }).candidate,
    before = f.commits();
  f.setWall(150);
  assert.throws(() => f.service.resolve(b, candidate), /FANOUT_STALE_PROJECTION/);
  assert.equal(f.commits(), before + 1);
  assert.equal(f.s.invalidationJournal().at(-1)!.phase, 'sweep');
  f.s.applyConsumers([h]);
  assert.equal(f.s.consumerRetrievalSnapshot(h).selected.length, 3);
  f.setWall(200);
  assert.throws(() => f.s.consumerRetrievalSnapshot(h), /FANOUT_STALE_PROJECTION/);
  f.s.applyConsumers([h]);
  assert.deepEqual(
    f.s.consumerRetrievalSnapshot(h).selected.map((i) => i.memory.id),
    [future.id],
  );
  f.setWall(250);
  assert.throws(() => f.s.consumerRetrievalSnapshot(h), /FANOUT_STALE_PROJECTION/);
  f.s.applyConsumers([h]);
  assert.equal(f.s.consumerRetrievalSnapshot(h).selected.length, 0);
  f.setWall(249);
  assert.throws(() => f.s.consumerRetrievalSnapshot(h), /FANOUT_CLOCK_ROLLBACK/);
  assert.throws(() => f.service.refresh(b), /UNAUTHENTICATED/);
});

test('even an empty projection observes clock rollback and cannot revive its binding', (t) => {
  const f = fixture(t),
    h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
    b = f.service.bindConsumer(h);
  f.service.refresh(b);
  f.setWall(101);
  const c = f.service.query(b, { text: 'none' }).candidate;
  f.setWall(100);
  assert.throws(() => f.service.resolve(b, c), /FANOUT_CLOCK_ROLLBACK/);
  f.setWall(102);
  assert.throws(() => f.service.refresh(b), /UNAUTHENTICATED/);
});

test('wrong profiles and closed invalid handles cannot enter the authority guard or execute caller code', (t) => {
  const f = fixture(t),
    h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
    scene = f.s.registerConsumer('scene', f.scope, 'scene-source-refs-v1');
  let calls = 0;
  const getter = Object.defineProperty({ ...h }, 'id', {
    get() {
      calls++;
      f.s.purge(f.scope);
      return h.id;
    },
  });
  const nested = Object.defineProperty({ ...h.authority }, 'generation', {
    get() {
      calls++;
      return h.authority.generation;
    },
  });
  const proxy = new Proxy(h, {
    ownKeys() {
      calls++;
      return Reflect.ownKeys(h);
    },
  });
  const revoked = Proxy.revocable(h, {});
  revoked.revoke();
  const before = f.accesses(),
    commits = f.commits();
  for (const input of [
    getter,
    { ...h, authority: nested },
    proxy,
    revoked.proxy,
    { ...h, refs: [] },
    { ...h, offset: 0 },
    { ...h, authority: { ...h.authority, extra: true } },
    Object.create(h),
    { ...h, generation: -1 },
  ]) {
    assert.throws(() => f.s.consumerRetrievalSnapshot(input), /INVALID_INPUT/);
    assert.throws(() => f.service.bindConsumer(input), /INVALID_INPUT/);
  }
  assert.throws(() => f.service.bindConsumer(scene), /FANOUT_PROFILE/);
  assert.throws(() => f.s.consumerRetrievalSnapshot(scene), /FANOUT_PROFILE/);
  assert.equal(calls, 0);
  assert.equal(f.accesses(), before);
  assert.equal(f.commits(), commits);
});

test('consumer binding copies the handle and rejects forged copied foreign and sibling service capabilities', (t) => {
  const f = fixture(t),
    root = f.s.acceptEvent(f.scope, event('one'));
  publish(f.s, f.scope, [root]);
  const h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
    original = structuredClone(h),
    b = f.service.bindConsumer(h);
  h.authority.runtimeEpoch = 999;
  h.id = 'other';
  f.service.refresh(b);
  const c = f.service.query(b, { text: 'blue' }).candidate;
  const sibling = f.service.bindConsumer(original);
  f.service.refresh(sibling);
  const foreign = new RetrievalService(f.s);
  assert.throws(() => f.service.refresh({ ...b }), /UNAUTHENTICATED/);
  assert.throws(() => foreign.refresh(b), /UNAUTHENTICATED/);
  assert.throws(() => f.service.resolve(b, { ...c }), /UNAUTHENTICATED/);
  assert.throws(() => f.service.resolve(sibling, c), /UNAUTHENTICATED/);
  assert.equal(f.service.resolve(b, c).hits.length, 1);
  f.service.unbind(b);
  assert.throws(() => f.service.resolve(b, c), /UNAUTHENTICATED/);
});

test('empty selection still checks health and schema1 has no consumer registration fallback', (t) => {
  let healthy = true;
  const s = new MemoryStore(':memory:', {
    schemaVersion: 2,
    assertHealthy: () => {
      if (!healthy) throw Error('SYNTHETIC_UNHEALTHY');
    },
  });
  t.after(() => s.close());
  const scope = s.ensureScope(who),
    h = s.registerConsumer('recall', scope, 'retrieval-refs-v1'),
    service = new RetrievalService(s);
  const b = service.bindConsumer(h);
  service.refresh(b);
  const candidate = service.query(b, { text: 'none' }).candidate;
  healthy = false;
  assert.throws(() => service.resolve(b, candidate), /SYNTHETIC_UNHEALTHY/);
  healthy = true;
  assert.throws(() => service.refresh(b), /UNAUTHENTICATED/);
  const legacy = new MemoryStore(':memory:');
  t.after(() => legacy.close());
  const before = legacy.snapshot();
  assert.throws(() => legacy.consumerRetrievalSnapshot(h), /FANOUT_SCHEMA_REQUIRED/);
  assert.deepEqual(legacy.snapshot(), before);
});

test('input detachment precedes the guard and nested Store reads are refused', (t) => {
  let callback: (() => void) | undefined;
  const s = new MemoryStore(':memory:', {
    schemaVersion: 2,
    clock: { wall: () => 100, monotonic: () => 0 },
    aroundAccess: (run) => {
      callback?.();
      return run();
    },
  });
  t.after(() => s.close());
  const scope = s.ensureScope(who),
    h = s.registerConsumer('recall', scope, 'retrieval-refs-v1');
  const id = h.id;
  callback = () => {
    h.id = 'caller-mutated';
    h.authority.runtimeEpoch = 999;
  };
  assert.equal(s.consumerRetrievalSnapshot(h).consumer.id, id);
  callback = undefined;
  let nested = false;
  const nestedStore = new MemoryStore(':memory:', {
    schemaVersion: 2,
    clock: {
      wall: () => {
        if (nested) assert.throws(() => nestedStore.consumerRetrievalSnapshot(current), /DURABLE_ACCESS_BUSY/);
        return 100;
      },
      monotonic: () => 0,
    },
  });
  t.after(() => nestedStore.close());
  const other = nestedStore.ensureScope(who),
    current = nestedStore.registerConsumer('recall', other, 'retrieval-refs-v1');
  nested = true;
  assert.equal(nestedStore.consumerRetrievalSnapshot(current).selected.length, 0);
});

test('metadata still supports 33 selections while retrieval refuses the entire over-32 projection', (t) => {
  const f = fixture(t),
    root = f.s.acceptEvent(f.scope, event('one'));
  for (let i = 0; i < 32; i++) publish(f.s, f.scope, [root], { ...claim, statement: `blue ${i}` });
  const h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1');
  assert.equal(f.s.consumerRetrievalSnapshot(h).selected.length, 32);
  const b = f.service.bindConsumer(h);
  f.service.refresh(b);
  const c = f.service.query(b, { text: 'blue' }).candidate;
  publish(f.s, f.scope, [root]);
  f.s.applyConsumers([h]);
  assert.equal(f.s.readConsumer(h).refs.length, 33);
  assert.throws(() => f.s.consumerRetrievalSnapshot(h), /RETRIEVAL_LIMIT/);
  assert.throws(() => f.service.resolve(b, c), /RETRIEVAL_LIMIT/);
  assert.throws(() => f.service.refresh(b), /UNAUTHENTICATED/);
});

test('consumer selection enforces the unchanged 128 source-node and 512 source-edge budgets', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    const roots = Array.from({ length: 31 }, (_, j) => f.s.acceptEvent(f.scope, event(`${i}-${j}`)));
    publish(f.s, f.scope, roots);
  }
  const h = f.s.registerConsumer('nodes', f.scope, 'retrieval-refs-v1');
  assert.equal(f.s.consumerRetrievalSnapshot(h).counts.nodes, 128);
  publish(f.s, f.scope, [f.s.acceptEvent(f.scope, event('overflow'))]);
  f.s.applyConsumers([h]);
  assert.throws(() => f.s.consumerRetrievalSnapshot(h), /RETRIEVAL_LIMIT/);
  const other = f.s.ensureScope({ ...who, relationshipId: 'edges' }),
    roots = Array.from({ length: 32 }, (_, j) => f.s.acceptEvent(other, event(`edge-${j}`)));
  for (let i = 0; i < 16; i++) publish(f.s, other, roots);
  const e = f.s.registerConsumer('edges', other, 'retrieval-refs-v1');
  assert.equal(f.s.consumerRetrievalSnapshot(e).counts.edges, 512);
  publish(f.s, other, roots);
  f.s.applyConsumers([e]);
  assert.throws(() => f.s.consumerRetrievalSnapshot(e), /RETRIEVAL_LIMIT/);
});

test('source UTF-8 and independent RAM normalization budgets reject whole results', (t) => {
  const f = fixture(t),
    roots = Array.from({ length: 32 }, (_, i) =>
      f.s.acceptEvent(f.scope, {
        ...event(`large-${i}`),
        evidence: { ...event(`large-${i}`).evidence, selectedText: '界'.repeat(4096) },
      }),
    );
  publish(f.s, f.scope, roots);
  const h = f.s.registerConsumer('source', f.scope, 'retrieval-refs-v1');
  assert.throws(() => f.s.consumerRetrievalSnapshot(h), /RETRIEVAL_LIMIT/);
  const other = f.s.ensureScope({ ...who, relationshipId: 'normalization' }),
    root = f.s.acceptEvent(other, event('normalization'));
  for (let i = 0; i < 8; i++) publish(f.s, other, [root], { ...claim, statement: '\uFDFA'.repeat(4000) });
  const p = f.s.registerConsumer('ram', other, 'retrieval-refs-v1');
  assert.ok(f.s.consumerRetrievalSnapshot(p).counts.bytes < 262144);
  const b = f.service.bindConsumer(p);
  assert.throws(() => f.service.refresh(b), /RETRIEVAL_PROJECTION_LIMIT/);
  assert.throws(() => f.service.query(b, { text: 'blue' }), /RETRIEVAL_NOT_READY/);
});

test('snapshot charges the complete stamp and projection metadata without changing manual snapshot accounting', (t) => {
  const f = fixture(t),
    root = f.s.acceptEvent(f.scope, event('one')),
    m = publish(f.s, f.scope, [root]);
  const h = f.s.registerConsumer('recall', f.scope, 'retrieval-refs-v1'),
    manual = f.s.retrievalSnapshot(f.scope, [m]);
  const snapshot = f.s.consumerRetrievalSnapshot(h),
    metadata = f.s.readConsumer(h).refs;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.equal(snapshot.counts.bytes - manual.counts.bytes, bytes({ consumer: snapshot.consumer }) + bytes(metadata));
  assert.equal(Reflect.set(snapshot.consumer, 'applied', 0), false);
  assert.equal(Reflect.set(snapshot.selected[0]!.memory, 'statement', 'changed'), false);
});

test('projection row metadata must match current source metadata before body delivery', (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'aemc-if5-metadata-')), 'synthetic.sqlite');
  const s = new MemoryStore(path, { schemaVersion: 2, clock: { wall: () => 100, monotonic: () => 0 } }),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    s.close();
  });
  const scope = s.ensureScope(who),
    root = s.acceptEvent(scope, event('one'));
  publish(s, scope, [root]);
  const h = s.registerConsumer('recall', scope, 'retrieval-refs-v1');
  const row = db.prepare('SELECT metadata FROM fanout_projection WHERE consumer_id=?').get(h.id)!;
  const original = JSON.parse(row.metadata as string),
    update = db.prepare('UPDATE fanout_projection SET metadata=? WHERE consumer_id=?');
  for (const patch of [
    { generation: 999 },
    { consentRevision: 999 },
    { recordedAt: 101 },
    { validFrom: 99 },
    { validTo: 101 },
    { parents: [] },
    { rootEventRefs: [] },
    { origin: {} },
  ]) {
    update.run(JSON.stringify({ ...original, ...patch }), h.id);
    assert.throws(() => s.consumerRetrievalSnapshot(h), /RETRIEVAL_PROJECTION_MISMATCH/);
  }
  update.run(JSON.stringify({ ...original, revision: 2 }), h.id);
  assert.throws(() => s.consumerRetrievalSnapshot(h), /STALE_SOURCE/);
  update.run(row.metadata as string, h.id);
  assert.equal(s.consumerRetrievalSnapshot(h).selected.length, 1);
});

function anchored(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'aemc-if5-v3-')),
    authorityConfig = {
      directory: join(root, 'authority'),
      authorityId: 'synthetic-authority',
      custodyDomain: 'independent',
    };
  const authority = LocalSqliteAuthority.create(authorityConfig),
    config = {
      directory: join(root, 'vault'),
      vaultId: 'synthetic-vault',
      identity: 'synthetic',
      storageDomain: 'payload',
      keys: generateKeySet(),
      authority,
      schemaVersion: 2 as const,
      storageProfile: 'blocks-br4-v1' as const,
    };
  const options = { clock: { wall: () => 100, monotonic: () => 0 } },
    v = AnchoredVault.create(config, 4, options);
  t.after(() => {
    v.close();
    authority.close();
  });
  return { root, authorityConfig, authority, config, options, v };
}

test('anchored-v3 compact fences a live retrieval candidate and new active boot requires explicit catch-up and rebind', (t) => {
  const f = anchored(t),
    s = f.v.store,
    scope = s.ensureScope(who),
    root = s.acceptEvent(scope, event('one')),
    m = publish(s, scope, [root]);
  const h = s.registerConsumer('recall', scope, 'retrieval-refs-v1'),
    service = new RetrievalService(s),
    b = service.bindConsumer(h);
  service.refresh(b);
  const candidate = service.query(b, { text: 'blue' }).candidate,
    head = f.v.head.sequence;
  service.resolve(b, candidate);
  assert.equal(f.v.head.sequence, head);
  const hashes = () =>
    Object.fromEntries(
      readdirSync(f.config.directory).map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(f.config.directory, name)))
          .digest('hex'),
      ]),
    );
  const before = hashes(),
    target = join(f.root, 'compacted');
  AnchoredVault.compact({
    authority: f.authority,
    vaultId: f.config.vaultId,
    keys: f.config.keys,
    maxCalls: 4,
    targetDirectory: target,
    storageDomain: 'payload',
    operationId: 'retrieval-compact',
  });
  assert.throws(() => service.resolve(b, candidate), /ANCHOR_FENCED/);
  assert.throws(() => service.refresh(b), /UNAUTHENTICATED/);
  assert.deepEqual(hashes(), before);
  f.v.close();
  const next = AnchoredVault.open({ ...f.config, directory: target }, 4, f.options);
  t.after(() => next.close());
  assert.throws(() => next.store.consumerRetrievalSnapshot(h), /FANOUT_STALE_HANDLE/);
  const current = next.store.bindConsumer(h.id, next.store.scope(scope.id));
  assert.throws(() => next.store.consumerRetrievalSnapshot(current), /FANOUT_STALE_PROJECTION/);
  next.store.applyConsumers([current]);
  const fresh = new RetrievalService(next.store),
    binding = fresh.bindConsumer(current);
  fresh.refresh(binding);
  assert.deepEqual(
    fresh.resolve(binding, fresh.query(binding, { text: 'blue' }).candidate).hits.map((h) => h.memory.id),
    [m.id],
  );
});

test('a real child reopens v3, rejects the prior boot handle, catches up and resolves without portable capabilities', (t) => {
  const f = anchored(t),
    s = f.v.store,
    scope = s.ensureScope(who),
    root = s.acceptEvent(scope, event('one'));
  publish(s, scope, [root]);
  const h = s.registerConsumer('recall', scope, 'retrieval-refs-v1');
  f.v.close();
  const script = `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
    import {AnchoredVault} from './src/anchored-vault.ts';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';
    import {RetrievalService} from './src/retrieval.ts';const x=JSON.parse(readFileSync(0,'utf8'));
    const authority=LocalSqliteAuthority.open(x.authority);const keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')};
    const v=AnchoredVault.open({...x.config,keys,authority},4,{clock:{wall:()=>101,monotonic:()=>0}});
    try{assert.throws(()=>v.store.consumerRetrievalSnapshot(x.handle),/FANOUT_STALE_HANDLE/);
      const h=v.store.bindConsumer(x.handle.id,v.store.scope(x.handle.scopeId));assert.throws(()=>v.store.consumerRetrievalSnapshot(h),/FANOUT_STALE_PROJECTION/);
      v.store.applyConsumers([h]);const service=new RetrievalService(v.store),b=service.bindConsumer(h);service.refresh(b);
      assert.throws(()=>service.refresh({version:1}),/UNAUTHENTICATED/);const r=service.resolve(b,service.query(b,{text:'blue'}).candidate);
      assert.equal(r.hits.length,1);assert.equal(r.consumer.applied,r.consumer.head);console.log('IF5_CHILD_REOPEN_PASS');
    }finally{v.close();authority.close();}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    windowsHide: true,
    timeout: 15000,
    encoding: 'utf8',
    input: JSON.stringify({
      authority: f.authorityConfig,
      config: {
        directory: f.config.directory,
        vaultId: f.config.vaultId,
        identity: f.config.identity,
        storageDomain: f.config.storageDomain,
        schemaVersion: 2,
        storageProfile: 'blocks-br4-v1',
      },
      handle: h,
      keys: {
        version: 2,
        keyEpoch: 1,
        storageDEK: Buffer.from(f.config.keys.storageDEK).toString('base64'),
        ingressKey: Buffer.from(f.config.keys.ingressKey).toString('base64'),
      },
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /IF5_CHILD_REOPEN_PASS/);
});
