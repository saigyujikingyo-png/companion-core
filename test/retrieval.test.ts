import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RetrievalService } from '../src/retrieval.ts';
import { DurableMemory } from '../src/durable-memory.ts';
import { MemoryStore } from '../src/store.ts';
import type { Epoch, SourceRef } from '../src/contracts.ts';
import { fixture, graph, code, identity, claim, publish } from './retrieval-fixtures.ts';

const epoch = ({ id, generation, consentRevision }: Epoch): Epoch => ({ id, generation, consentRevision });
function ready(t: TestContext) {
  const f = fixture(t),
    root = f.event('one'),
    memory = f.memory([root]),
    service = new RetrievalService(f.store);
  const binding = service.bind({ epoch: epoch(f.scope), publishedRefs: [memory] });
  service.refresh(binding);
  return { ...f, root, memory, service, binding };
}
function outbox(store: MemoryStore) {
  const clone = new DatabaseSync(':memory:');
  try {
    clone.deserialize(store.snapshot());
    return clone.prepare('SELECT * FROM outbox ORDER BY id').all();
  } finally {
    clone.close();
  }
}

test('an observed expiry failure terminates the old binding before a clock rollback could revive it', (t) => {
  const f = fixture(t),
    root = f.event('one'),
    memory = f.memory([root], { ...claim, validTo: 200_000 }),
    service = new RetrievalService(f.store);
  const binding = service.bind({ epoch: epoch(f.scope), publishedRefs: [memory] });
  service.refresh(binding);
  f.setWall(200_001);
  assert.throws(() => service.query(binding, { text: 'blue' }), code('STALE_SOURCE'));
  f.setWall(150_000);
  assert.throws(() => service.refresh(binding), code('UNAUTHENTICATED'));
});

test('two views select only bound memories, direct before shared roots, with stable ordinals and no zero-hit fallback', (t) => {
  const f = fixture(t),
    r1 = f.event('one'),
    r2 = f.event('two'),
    a = f.memory([r1], { ...claim, statement: 'BLUE cafe' }),
    b = f.memory([r1], { ...claim, statement: 'related red' }),
    c = f.memory([r2], { ...claim, statement: 'blue elsewhere' });
  const outsider = f.memory([r1], { ...claim, statement: 'blue unbound' }),
    service = new RetrievalService(f.store);
  const binding = service.bind({ epoch: epoch(f.scope), publishedRefs: [b, c, a] });
  assert.throws(() => service.query(binding, { text: 'blue' }), code('RETRIEVAL_NOT_READY'));
  const refreshed = service.refresh(binding);
  assert.equal(refreshed.counts.memories, 3);
  assert.equal(refreshed.counts.roots, 2);
  assert.equal(refreshed.counts.edges, 3);
  const before = f.store.snapshot(),
    pending = outbox(f.store),
    persisted = f.persisted(),
    reads = f.reads();
  const result = service.query(binding, { text: 'ＢＬＵＥ' });
  assert.equal(f.reads(), reads + 1);
  assert.doesNotMatch(JSON.stringify(result), /BLUE|blue|related|ANCESTOR|alice|statement|sha256|scope/);
  const resolved = service.resolve(binding, result.candidate);
  assert.equal(f.reads(), reads + 2);
  assert.deepEqual(
    resolved.hits.map((hit) => [hit.memory.id, hit.kind]),
    [
      [c.id, 'direct_lexical'],
      [a.id, 'direct_lexical'],
      [b.id, 'shared_root'],
    ],
  );
  assert.ok(resolved.hits.every((hit) => hit.memory.id !== outsider.id));
  assert.doesNotMatch(JSON.stringify(resolved), /ANCESTOR_ONLY|selectedText|occurredAt/);
  assert.equal(Reflect.set(resolved.hits[0]!.memory, 'statement', 'changed'), false);
  const limited = service.query(binding, { text: 'blue', limit: 1 });
  assert.equal(service.resolve(binding, limited.candidate).hits.length, 1);
  const none = service.query(binding, { text: 'absent' });
  assert.equal(none.report.hits, 0);
  assert.deepEqual(service.resolve(binding, none.candidate).hits, []);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(outbox(f.store), pending);
  assert.equal(f.persisted(), persisted);
});

test('literal and all-term rules are fixed, independent of word order or language claims', (t) => {
  const f = fixture(t),
    root = f.event('one'),
    memory = f.memory([root], { ...claim, statement: 'café BLUE 中文原文 日本語 ***' }),
    service = new RetrievalService(f.store);
  const binding = service.bind({ epoch: epoch(f.scope), publishedRefs: [memory] });
  service.refresh(binding);
  for (const query of ['BLUE café', 'ＣＡＦÉ', '中文', '日本', '***'])
    assert.equal(service.query(binding, { text: query }).report.directMatches, 1);
  for (const query of ['blue absent', 'cafe']) assert.equal(service.query(binding, { text: query }).report.hits, 0);
});

test('opaque capabilities reject copied, foreign and sibling handles; input mutation cannot widen access', (t) => {
  const f = fixture(t),
    memory = f.memory([f.event('one')]),
    service = new RetrievalService(f.store),
    other = new RetrievalService(f.store);
  const input = { epoch: epoch(f.scope), publishedRefs: [{ ...memory }] },
    binding = service.bind(input);
  input.epoch.generation = 999;
  input.publishedRefs[0]!.revision = 999;
  service.refresh(binding);
  const candidate = service.query(binding, { text: 'blue' }).candidate,
    sibling = service.bind({ epoch: epoch(f.scope), publishedRefs: [memory] });
  service.refresh(sibling);
  assert.throws(() => service.query({ ...binding }, { text: 'blue' }), code('UNAUTHENTICATED'));
  assert.throws(() => other.refresh(binding), code('UNAUTHENTICATED'));
  assert.throws(() => service.resolve(binding, { ...candidate }), code('UNAUTHENTICATED'));
  assert.throws(() => service.resolve(sibling, candidate), code('UNAUTHENTICATED'));
  const foreign = other.bind({ epoch: epoch(f.scope), publishedRefs: [memory] });
  other.refresh(foreign);
  assert.throws(() => other.resolve(foreign, candidate), code('UNAUTHENTICATED'));
  assert.equal(service.resolve(binding, candidate).hits.length, 1);
  service.unbind(binding);
  assert.throws(() => service.resolve(binding, candidate), code('UNAUTHENTICATED'));
});

test('closed bind/query inputs cannot assert authority or install getters; explicit invalid limits reject', (t) => {
  const f = ready(t),
    base = { epoch: epoch(f.scope), publishedRefs: [f.memory] };
  for (const bad of [
    { ...base, scope: 'other' },
    { ...base, epoch: { ...base.epoch, runtimeEpoch: 0 } },
    { ...base, epoch: { ...base.epoch, learningAllowed: true } },
    { ...base, publishedRefs: [{ ...f.memory, sources: [] }] },
    { ...base, epoch: { ...base.epoch, generation: -1 } },
  ])
    assert.throws(() => f.service.bind(bad), code('INVALID_INPUT'));
  let getterCalled = false;
  const accessor = Object.defineProperty({ publishedRefs: [f.memory] }, 'epoch', {
    get() {
      getterCalled = true;
      return base.epoch;
    },
  });
  assert.throws(() => f.service.bind(accessor as typeof base), code('INVALID_INPUT'));
  assert.equal(getterCalled, false);
  for (const bad of [
    { text: 'blue', scope: 'other' },
    { text: 'blue', sources: [] },
    { text: 'blue', runtimeEpoch: 0 },
    { text: 'blue', limit: 0 },
    { text: 'blue', limit: 33 },
    { text: 'blue', limit: 1.5 },
    { text: 'blue', limit: null },
    { text: 'blue', limit: undefined },
    { text: ' '.repeat(2) },
    { text: 'x'.repeat(257) },
  ])
    assert.throws(() => f.service.query(f.binding, bad as { text: string; limit?: number }), code('INVALID_INPUT'));
});

test('query rejects a Proxy before any trap can revoke sources after the fresh authority gate', (t) => {
  const f = ready(t);
  let textReads = 0,
    revoked = false;
  const input = new Proxy(
    { text: 'blue' },
    {
      get(target, key, receiver) {
        if (key === 'text' && ++textReads === 2) {
          f.store.revoke(f.scope, f.root);
          revoked = true;
        }
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const before = f.store.snapshot(),
    persisted = f.persisted();
  assert.throws(() => f.service.query(f.binding, input), code('INVALID_INPUT'));
  assert.equal(textReads, 0);
  assert.equal(revoked, false);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.persisted(), persisted);
});

for (const kind of ['iterator', 'accessor', 'proxy', 'extra-key', 'sparse'] as const)
  test(`bind rejects a ${kind} refs array before executing caller code`, (t) => {
    const f = fixture(t),
      memory = f.memory([f.event('one')]),
      service = new RetrievalService(f.store);
    let calls = 0;
    let selected: SourceRef[] = [memory];
    if (kind === 'iterator')
      Object.defineProperty(selected, Symbol.iterator, {
        value: function* () {
          calls++;
          yield memory;
        },
      });
    else if (kind === 'accessor')
      Object.defineProperty(selected, '0', {
        get() {
          calls++;
          return memory;
        },
      });
    else if (kind === 'proxy')
      selected = new Proxy(selected, {
        get(target, key, receiver) {
          calls++;
          return Reflect.get(target, key, receiver);
        },
      });
    else if (kind === 'extra-key') Object.assign(selected, { extra: true });
    else selected = new Array<SourceRef>(1);
    const before = f.store.snapshot();
    assert.throws(() => service.bind({ epoch: epoch(f.scope), publishedRefs: selected }), code('INVALID_INPUT'));
    assert.equal(calls, 0);
    assert.deepEqual(f.store.snapshot(), before);
  });

test('the refs array limit rejects before materializing the full property descriptor set', (t) => {
  const f = fixture(t),
    service = new RetrievalService(f.store),
    selected = Array.from({ length: 33 }, (_, i) => ({ id: 'm' + i, revision: 1 }));
  const descriptors = Object.getOwnPropertyDescriptors;
  let fullReads = 0;
  try {
    Object.getOwnPropertyDescriptors = function (value) {
      if (value === selected) fullReads++;
      return descriptors(value);
    };
    assert.throws(() => service.bind({ epoch: epoch(f.scope), publishedRefs: selected }), code('RETRIEVAL_LIMIT'));
    assert.equal(fullReads, 0);
  } finally {
    Object.getOwnPropertyDescriptors = descriptors;
  }
});

test('new queries and refresh revisions invalidate old candidates without retaining old output authority', (t) => {
  const f = ready(t),
    one = f.service.query(f.binding, { text: 'blue' }),
    two = f.service.query(f.binding, { text: 'blue' });
  assert.throws(() => f.service.resolve(f.binding, one.candidate), code('UNAUTHENTICATED'));
  assert.equal(f.service.resolve(f.binding, two.candidate).hits.length, 1);
  assert.equal(f.service.refresh(f.binding).projectionRevision, 2);
  assert.throws(() => f.service.resolve(f.binding, two.candidate), code('UNAUTHENTICATED'));
  const three = f.service.query(f.binding, { text: 'blue' });
  assert.equal(three.report.projectionRevision, 2);
});

for (const empty of [false, true])
  for (const operation of ['purge', 'consent', 'unrelated-revoke'] as const)
    test(`${operation} invalidates ${empty ? 'empty' : 'nonempty'} bindings and candidates`, (t) => {
      const f = fixture(t),
        root = f.event('one'),
        memory = f.memory([root]),
        unrelated = f.event('unrelated'),
        service = new RetrievalService(f.store);
      const binding = service.bind({ epoch: epoch(f.scope), publishedRefs: empty ? [] : [memory] });
      service.refresh(binding);
      const candidate = service.query(binding, { text: 'blue' }).candidate;
      const expected =
        operation === 'purge'
          ? 'STALE_SCOPE'
          : operation === 'consent'
            ? 'STALE_CONSENT'
            : 'RETRIEVAL_AUTHORITY_CHANGED';
      if (operation === 'purge') f.store.purge(f.scope);
      else if (operation === 'consent') f.store.setLearningConsent(f.scope, true);
      else f.store.revoke(f.scope, unrelated);
      const before = f.store.snapshot(),
        pending = outbox(f.store),
        persisted = f.persisted();
      assert.throws(() => service.resolve(binding, candidate), code(expected));
      assert.throws(() => service.refresh(binding), code('UNAUTHENTICATED'));
      assert.deepEqual(f.store.snapshot(), before);
      assert.deepEqual(outbox(f.store), pending);
      assert.equal(f.persisted(), persisted);
    });

for (const operation of ['revoke', 'revise', 'ttl'] as const)
  test(`${operation} of a non-hit still refuses the whole pair before query and resolve`, (t) => {
    const f = fixture(t),
      a = f.memory([f.event('one')]),
      root = f.event('two'),
      b = f.memory([root], { ...claim, statement: 'red', validTo: 100_010 });
    const service = new RetrievalService(f.store),
      binding = service.bind({ epoch: epoch(f.scope), publishedRefs: [a, b] });
    service.refresh(binding);
    const candidate = service.query(binding, { text: 'blue' }).candidate;
    assert.equal(service.resolve(binding, candidate).hits.length, 1);
    if (operation === 'revoke') f.store.revoke(f.scope, root);
    else if (operation === 'revise')
      f.store.reviseEvent(f.scope, root, {
        speakerId: 'alice',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'changed',
        occurredAt: null,
      });
    else f.setWall(100_010);
    const before = f.store.snapshot(),
      persisted = f.persisted();
    assert.throws(() => service.resolve(binding, candidate), code('STALE_SOURCE'));
    assert.throws(() => service.query(binding, { text: 'blue' }), code('UNAUTHENTICATED'));
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.persisted(), persisted);
  });

test('learning off remains readable; off-on creates a fresh consent epoch without reviving old handles', (t) => {
  const f = ready(t),
    candidate = f.service.query(f.binding, { text: 'blue' }).candidate;
  const on = f.store.setLearningConsent(f.scope, true),
    off = f.store.setLearningConsent(on, false);
  assert.throws(() => f.service.resolve(f.binding, candidate), code('STALE_CONSENT'));
  assert.throws(() => f.service.bind({ epoch: epoch(on), publishedRefs: [f.memory] }), code('STALE_CONSENT'));
  const fresh = f.service.bind({ epoch: epoch(off), publishedRefs: [f.memory] });
  f.service.refresh(fresh);
  assert.equal(f.service.resolve(fresh, f.service.query(fresh, { text: 'blue' }).candidate).hits.length, 1);
  assert.throws(() => f.store.curationSnapshot(off, [f.memory]), code('LEARNING_NOT_ALLOWED'));
});

test('monotonic binding time rejects rollback even with empty refs and cannot be restored by clock recovery', (t) => {
  const f = fixture(t),
    service = new RetrievalService(f.store),
    binding = service.bind({ epoch: epoch(f.scope), publishedRefs: [] });
  service.refresh(binding);
  f.setWall(100_100);
  const candidate = service.query(binding, { text: 'absent' }).candidate;
  f.setWall(100_099);
  assert.throws(() => service.resolve(binding, candidate), code('RETRIEVAL_CLOCK_ROLLBACK'));
  f.setWall(100_101);
  assert.throws(() => service.refresh(binding), code('UNAUTHENTICATED'));
});

test('empty-hit candidate still revalidates all sources, and empty refs still validate store health', (t) => {
  const f = ready(t),
    none = f.service.query(f.binding, { text: 'absent' }).candidate;
  f.store.revoke(f.scope, f.root);
  assert.throws(() => f.service.resolve(f.binding, none), code('STALE_SOURCE'));
  let broken = false;
  const store = new MemoryStore(':memory:', {
    persist: () => {
      if (broken) throw Error('synthetic failure');
    },
  });
  t.after(() => store.close());
  const scope = store.ensureScope(identity),
    service = new RetrievalService(store),
    binding = service.bind({ epoch: epoch(scope), publishedRefs: [] });
  service.refresh(binding);
  const candidate = service.query(binding, { text: 'absent' }).candidate;
  broken = true;
  assert.throws(() => store.ensureScope({ ...identity, tenantId: 'other' }), /synthetic failure/);
  assert.throws(() => service.resolve(binding, candidate), code('DURABLE_UNAVAILABLE'));
  assert.throws(() => service.refresh(binding), code('UNAUTHENTICATED'));
});

test('closure-edge bounds do not substitute for derived-edge bounds; failed refresh removes the entire old pair', (t) => {
  const f = graph(t);
  for (let i = 0; i < 17; i++) f.node('r' + i, 'event');
  f.node(
    'bridge',
    'memory',
    Array.from({ length: 16 }, (_, i) => 'r' + i),
  );
  const selected = Array.from({ length: 32 }, (_, i) => f.node('m' + i, 'memory', ['bridge']));
  const service = new RetrievalService(f.store),
    binding = service.bind({ epoch: epoch(f.scope), publishedRefs: selected });
  const initial = service.refresh(binding);
  assert.equal(initial.counts.edges, 512);
  const old = service.query(binding, { text: 'blue' }).candidate;
  f.injector.prepare('INSERT INTO dependencies VALUES (?,?,1)').run('bridge', 'r16');
  assert.equal(f.store.retrievalSnapshot(f.scope, selected).counts.edges, 49);
  const before = f.store.snapshot();
  assert.throws(() => service.refresh(binding), code('RETRIEVAL_PROJECTION_LIMIT'));
  assert.throws(() => service.query(binding, { text: 'blue' }), code('RETRIEVAL_NOT_READY'));
  assert.throws(() => service.resolve(binding, old), code('RETRIEVAL_NOT_READY'));
  assert.deepEqual(f.store.snapshot(), before);
  // Fixing only this disposable fault injection permits a new complete rebuild, never old-pair fallback.
  f.injector.prepare('DELETE FROM dependencies WHERE child_id=? AND parent_id=?').run('bridge', 'r16');
  assert.equal(service.refresh(binding).projectionRevision, 2);
  assert.throws(() => service.resolve(binding, old), code('UNAUTHENTICATED'));
});

test('projection UTF-8 budget independently rejects normalization expansion although the source snapshot fits', (t) => {
  const f = graph(t);
  f.node('root', 'event');
  const selected = Array.from({ length: 8 }, (_, i) => f.node('m' + i, 'memory', ['root'], '\uFDFA'.repeat(4000)));
  assert.ok(f.store.retrievalSnapshot(f.scope, selected).counts.bytes < 262_144);
  const service = new RetrievalService(f.store),
    binding = service.bind({ epoch: epoch(f.scope), publishedRefs: selected }),
    before = f.store.snapshot();
  assert.throws(() => service.refresh(binding), code('RETRIEVAL_PROJECTION_LIMIT'));
  assert.throws(() => service.query(binding, { text: 'blue' }), code('RETRIEVAL_NOT_READY'));
  assert.deepEqual(f.store.snapshot(), before);
});

test('projection charged bytes admit the exact cap and fail at cap plus one without restoring an old candidate', (t) => {
  const f = graph(t);
  f.node('root', 'event');
  const selected = Array.from({ length: 24 }, (_, i) => f.node('m' + i, 'memory', ['root'], 'x'.repeat(3000)));
  const service = new RetrievalService(f.store),
    binding = service.bind({ epoch: epoch(f.scope), publishedRefs: selected });
  let remaining = 262_144 - service.refresh(binding).counts.bytes;
  const statements = Array.from({ length: 24 }, () => 'x'.repeat(3000));
  for (let i = 0; i < statements.length; i++) {
    const add = Math.min(1094, Math.floor(remaining / 3));
    statements[i] += 'x'.repeat(add);
    remaining -= add * 3;
  }
  assert.ok(remaining <= 2);
  // Appending a space costs two serialized bytes; replacing the last term letter
  // with a space removes one byte from the unique term list, yielding a +1 step.
  if (remaining === 1) statements[0] = statements[0]!.slice(0, -1) + '  ';
  if (remaining === 2) statements[0] += ' ';
  const update = f.injector.prepare('UPDATE nodes SET body=? WHERE id=?');
  for (const [i, statement] of statements.entries()) update.run(JSON.stringify({ ...claim, statement }), 'm' + i);
  assert.equal(service.refresh(binding).counts.bytes, 262_144);
  const old = service.query(binding, { text: 'x' }).candidate;
  // A fresh one-character term after existing trailing whitespace adds one byte
  // to each text copy and one term byte, so use the reversible +1 transform again.
  const index = 1;
  statements[index] = statements[index]!.slice(0, -1) + '  ';
  update.run(JSON.stringify({ ...claim, statement: statements[index] }), 'm' + index);
  assert.ok(f.store.retrievalSnapshot(f.scope, selected).counts.bytes < 262_144);
  assert.throws(() => service.refresh(binding), code('RETRIEVAL_PROJECTION_LIMIT'));
  assert.throws(() => service.resolve(binding, old), code('RETRIEVAL_NOT_READY'));
});

test('a caller crossing an await must resolve again and cannot deliver a candidate revoked during that gap', async (t) => {
  const f = ready(t),
    candidate = f.service.query(f.binding, { text: 'blue' }).candidate;
  const previouslyReturned = f.service.resolve(f.binding, candidate);
  assert.equal(previouslyReturned.hits.length, 1);
  await Promise.resolve();
  f.store.revoke(f.scope, f.root);
  assert.throws(() => f.service.resolve(f.binding, candidate), code('STALE_SOURCE'));
  assert.equal(previouslyReturned.hits.length, 1); // Already returned copies cannot be physically recalled.
});

test('synthetic M2 restart loses RAM capabilities while a fresh binding rebuilds even after global outbox ACK', () => {
  const config = {
    directory: mkdtempSync(join(tmpdir(), 'companion-ar0-m2-')),
    identity: 'synthetic-ar0',
    keyBase64: randomBytes(32).toString('base64'),
  };
  let vault = new DurableMemory(config, 0, { clock: { wall: () => 100_000, monotonic: () => 0 } });
  let oldBinding, oldCandidate, memory: SourceRef, scopeId: string;
  try {
    const scope = vault.store.ensureScope(identity);
    scopeId = scope.id;
    const root = vault.store.acceptEvent(scope, {
      source: 'synthetic',
      eventKey: 'one',
      evidence: {
        speakerId: 'alice',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'original synthetic',
        occurredAt: null,
      },
    });
    memory = publish(vault.store, scope, [root]);
    for (const change of vault.store.projectionBatch(scope)) vault.store.acknowledgeProjection(scope, change);
    assert.ok(outbox(vault.store).every((row) => row.status === 'acked'));
    const service = new RetrievalService(vault.store);
    oldBinding = service.bind({ epoch: epoch(scope), publishedRefs: [memory] });
    service.refresh(oldBinding);
    oldCandidate = service.query(oldBinding, { text: 'blue' }).candidate;
  } finally {
    vault.close();
  }
  vault = new DurableMemory(config, 0, { clock: { wall: () => 100_000, monotonic: () => 0 } });
  try {
    assert.equal(vault.restored, true);
    const service = new RetrievalService(vault.store),
      scope = vault.store.scope(scopeId!);
    assert.throws(() => service.refresh(oldBinding!), code('UNAUTHENTICATED'));
    const before = vault.store.snapshot(),
      pending = outbox(vault.store),
      sequence = vault.status.sequence;
    const binding = service.bind({ epoch: epoch(scope), publishedRefs: [memory!] });
    service.refresh(binding);
    assert.throws(() => service.resolve(binding, oldCandidate!), code('UNAUTHENTICATED'));
    assert.equal(service.resolve(binding, service.query(binding, { text: 'blue' }).candidate).hits.length, 1);
    assert.deepEqual(vault.store.snapshot(), before);
    assert.deepEqual(outbox(vault.store), pending);
    assert.equal(vault.status.sequence, sequence);
  } finally {
    vault.close();
  }
});
