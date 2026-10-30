import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import { rankBm25, bm25WorkingReservation } from '../research/retrieval-baseline/bm25.ts';
import {
  createSyntheticFixture,
  syntheticEvidence,
  syntheticIdentity,
  publishSynthetic,
} from '../research/retrieval-baseline/fixture.ts';
import { compareSyntheticQuery } from '../research/retrieval-baseline/driver.ts';
import { evaluateOrdinals, summarize } from '../research/retrieval-baseline/evaluate.ts';
import { RetrievalService } from '../src/retrieval.ts';
import type { RetrievalCandidate } from '../src/retrieval-types.ts';

// Mechanism examples are deliberately independent of the sealed formal cohort.
function fixture(t: TestContext, statements = ['oak needle', 'pine cone'], learning = false, validTo?: number) {
  const f = createSyntheticFixture(
    statements.map((statement, root) => ({ statement, root, ...(validTo === undefined ? {} : { validTo }) })),
    learning,
  );
  t.after(() => f.close());
  return f;
}
test('known BM25 values retain TF, length, empty-doc N and unique query terms', () => {
  const hits = rankBm25(['oak oak', 'oak ash', ''], 'oak');
  const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5)),
    avgdl = 4 / 3;
  assert.ok(Math.abs(hits[0]!.score - (idf * 2 * 2.2) / (2 + 1.2 * (0.25 + (0.75 * 2) / avgdl))) < 1e-12);
  assert.ok(Math.abs(hits[1]!.score - (idf * 2.2) / (1 + 1.2 * (0.25 + (0.75 * 2) / avgdl))) < 1e-12);
  assert.deepEqual(
    hits.map((h) => h.ordinal),
    [0, 1],
  );
  assert.deepEqual(rankBm25(['oak oak', 'oak ash', ''], 'oak oak'), hits);
});
test('stable ties, NFKC lowercase, positive-only and zero-token input', () => {
  assert.deepEqual(
    rankBm25(['OAK', 'ｏａｋ', 'ash'], 'oak').map((h) => h.ordinal),
    [0, 1],
  );
  assert.deepEqual(rankBm25(['', '--', '🌲'], 'oak'), []);
  assert.deepEqual(rankBm25([], 'oak'), []);
  assert.deepEqual(rankBm25(['oak'], 'unknown'), []);
  assert.deepEqual(rankBm25(['🌲'], '🌲'), []);
  assert.deepEqual(rankBm25(['a'.repeat(4096)], 'a'.repeat(256)), []);
  assert.ok(Object.isFrozen(rankBm25(['oak'], 'oak')));
});
test('input limits and +1, including AR0 UTF-16 query length semantics', () => {
  assert.equal(rankBm25(Array(32).fill('oak'), 'oak', 32).length, 32);
  assert.throws(() => rankBm25(Array(33).fill('oak'), 'oak'), /RETRIEVAL_LIMIT/);
  for (const q of ['', ' ', '\0', 'a'.repeat(257), '🌲'.repeat(129)])
    assert.throws(() => rankBm25(['oak'], q), /INVALID_INPUT/);
  assert.deepEqual(rankBm25(['oak'], '🌲'.repeat(128)), []);
  for (const limit of [0, 33, 1.5, NaN, Infinity])
    assert.throws(() => rankBm25(['oak'], 'oak', limit), /INVALID_INPUT/);
  assert.throws(() => rankBm25(['x'.repeat(4097)], 'x'), /INVALID_INPUT/);
});
test('bounded preflight rejects expansion and exact reservation threshold +1 unit', () => {
  const units = Math.floor((262144 - 4352) / 28) - 1;
  const split = (length: number) => ['x'.repeat(4096), 'x'.repeat(4096), 'x'.repeat(length - 8192)];
  assert.ok(bm25WorkingReservation(split(units), 'q') <= 262144);
  assert.throws(() => bm25WorkingReservation(split(units + 1), 'q'), /BM25_WORKING_LIMIT/);
  assert.throws(() => rankBm25(['\uFDFA'.repeat(4096)], 'x'), /BM25_WORKING_LIMIT/);
});
test('invalid array accessors, proxies, holes and extra properties never execute', () => {
  let calls = 0;
  const getter = ['oak'];
  Object.defineProperty(getter, '0', {
    get() {
      calls++;
      return 'oak';
    },
  });
  const proxy = new Proxy(['oak'], {
    get() {
      calls++;
      return 'oak';
    },
  });
  for (const value of [getter, proxy, new Array<string>(1), Object.assign(['oak'], { extra: 1 })])
    assert.throws(() => rankBm25(value, 'oak'), /INVALID_INPUT/);
  assert.equal(calls, 0);
});
test('actual schema2 complete pool, deterministic fixed refs and unchanged Store content', (t) => {
  const f = fixture(t, ['oak', 'oak', 'ash']);
  const before = f.store.snapshot();
  const result = compareSyntheticQuery(f, 'oak');
  assert.deepEqual(
    result.ar0.map((h) => h.ordinal),
    [0, 1],
  );
  assert.deepEqual(
    result.bm25.map((h) => h.ordinal),
    [0, 1],
  );
  assert.ok(result.budget.totalBytes <= 262144);
  assert.deepEqual(f.store.snapshot(), before);
});
test('snapshot plus preflight work rejects whole comparison even when ranker alone fits', (t) => {
  const f = fixture(t, Array(3).fill('x'.repeat(3000)));
  assert.doesNotThrow(() => rankBm25(Array(3).fill('x'.repeat(3000)), 'x'));
  assert.throws(() => compareSyntheticQuery(f, 'x'), /BM25_WORKING_LIMIT/);
});
test('timestamp growth boundary is reserved before ranking even with zero hits', (t) => {
  const statements = [3000, 3000, 2464].map((length) => 'x'.repeat(length)),
    query = 'q'.repeat(8),
    f = fixture(t, statements);
  const initialBytes = Buffer.byteLength(JSON.stringify(f.store.consumerRetrievalSnapshot(f.handle)), 'utf8');
  assert.equal(2 * initialBytes + bm25WorkingReservation(statements, query), 262144);
  let afterRankingCalled = false;
  assert.throws(
    () =>
      compareSyntheticQuery(f, query, () => {
        afterRankingCalled = true;
        f.setWall(Number.MAX_SAFE_INTEGER);
      }),
    /BM25_WORKING_LIMIT/,
  );
  assert.equal(afterRankingCalled, false);
});
test('timestamp growth near boundary reports the actual two snapshot sizes', (t) => {
  const f = fixture(
    t,
    [3000, 3000, 2463].map((length) => 'x'.repeat(length)),
  );
  const initialBytes = Buffer.byteLength(JSON.stringify(f.store.consumerRetrievalSnapshot(f.handle)), 'utf8');
  const result = compareSyntheticQuery(f, 'q'.repeat(8), () => f.setWall(Number.MAX_SAFE_INTEGER));
  const currentBytes = Buffer.byteLength(JSON.stringify(f.store.consumerRetrievalSnapshot(f.handle)), 'utf8');
  assert.deepEqual(result.bm25, []);
  assert.ok(currentBytes > initialBytes);
  assert.equal(result.budget.snapshotBytes, initialBytes);
  assert.equal(result.budget.currentSnapshotBytes, currentBytes);
  assert.ok(result.budget.currentSnapshotReservedBytes >= currentBytes);
  assert.equal(result.budget.totalBytes, initialBytes + currentBytes + result.budget.workingBytes);
  assert.ok(result.budget.totalBytes <= 262144);
});
test('new selection is not silently truncated or filtered', (t) => {
  const f = fixture(t);
  publishSynthetic(f.store, f.scope, [f.roots.get(0)!], 'extra');
  f.store.applyConsumers([f.handle]);
  assert.throws(() => compareSyntheticQuery(f, 'oak'), /RESEARCH_SELECTION_CHANGED/);
  const large = fixture(t, Array(33).fill('oak'));
  assert.throws(() => compareSyntheticQuery(large, 'oak'), /RETRIEVAL_LIMIT/);
});
for (const emptyHits of [false, true])
  for (const action of ['revoke', 'revise', 'ttl', 'consent', 'runtime', 'consumer-progress', 'clock'] as const)
    test(`post-ranking ${action} rejects the entire ${emptyHits ? 'zero-hit' : 'hit'} comparison`, (t) => {
      const f = fixture(t, ['oak needle'], action === 'runtime', 100_010);
      assert.throws(
        () =>
          compareSyntheticQuery(f, emptyHits ? 'missing' : 'oak', () => {
            if (action === 'revoke') f.store.revoke(f.scope, f.roots.get(0)!);
            if (action === 'revise')
              f.store.reviseEvent(f.scope, f.roots.get(0)!, syntheticEvidence('same-text-revision'));
            if (action === 'ttl') f.setWall(100_010);
            if (action === 'consent') f.store.setLearningConsent(f.scope, true);
            if (action === 'runtime') {
              // Metadata-only activation exercises the runtime fence; no trainer exists here.
              const job = f.store.beginJob(f.scope, [f.roots.get(0)!], 'training'),
                lease = f.store.claimLease(f.scope, job.id);
              const artifact = f.store.registerArtifact(f.scope, job.id, lease.token, {
                sha256: 'b'.repeat(64),
                implementation: 'synthetic-metadata-only',
              });
              f.store.activateArtifact(f.scope, artifact.id);
            }
            if (action === 'consumer-progress') {
              const before = f.store.consumerRetrievalSnapshot(f.handle);
              const other = f.store.ensureScope({ ...syntheticIdentity, relationshipId: 'other' });
              f.store.acceptEvent(other, {
                source: 'synthetic',
                eventKey: 'advance',
                evidence: syntheticEvidence('advance'),
              });
              f.store.applyConsumers([f.handle]);
              const after = f.store.consumerRetrievalSnapshot(f.handle);
              assert.deepEqual(after.selected, before.selected);
              assert.ok(after.consumer.applied > before.consumer.applied);
            }
            if (action === 'clock') f.setWall(99_999);
          }),
        /STALE_SOURCE|STALE_CONSENT|RETRIEVAL_AUTHORITY_CHANGED|FANOUT_STALE_HANDLE|FANOUT_STALE_PROJECTION|RESEARCH_CURRENTNESS_CHANGED|CLOCK_ROLLBACK/,
      );
    });
test('readAsOf may advance without invalidating complete currentness', (t) => {
  const f = fixture(t);
  assert.equal(compareSyntheticQuery(f, 'oak', () => f.setWall(100_001)).bm25.length, 1);
});
test('empty selected pool still rechecks authority after ranking', (t) => {
  const f = fixture(t, []);
  assert.deepEqual(compareSyntheticQuery(f, 'oak').bm25, []);
  assert.throws(
    () => compareSyntheticQuery(f, 'oak', () => f.store.setLearningConsent(f.scope, true)),
    /STALE_CONSENT/,
  );
});
test('BM25 ordinals cannot be AR0 candidates; original candidates still expire', (t) => {
  const f = fixture(t),
    service = new RetrievalService(f.store),
    epoch = { id: f.scope.id, generation: f.scope.generation, consentRevision: f.scope.consentRevision };
  const binding = service.bind({ epoch, publishedRefs: f.refs });
  service.refresh(binding);
  const old = service.query(binding, { text: 'oak' }).candidate,
    result = compareSyntheticQuery(f, 'oak');
  assert.throws(() => service.resolve(binding, result.bm25[0] as unknown as RetrievalCandidate), /UNAUTHENTICATED/);
  f.store.revoke(f.scope, f.roots.get(0)!);
  assert.throws(() => service.resolve(binding, old), /STALE_SOURCE/);
});
test('evaluation labels never enter scorer; unknown denominator, conflicts and shared roots remain explicit', () => {
  const family = {
    id: 'mechanism-only',
    documents: [
      { statement: 'oak', root: 0 },
      { statement: 'not oak', root: 0 },
    ],
    queries: [],
  };
  const gold = {
    id: 'unit',
    text: 'oak',
    status: 'conflict' as const,
    relevantOrdinals: [0, 1],
    conflictSides: [0, 1] as const,
    exactLiteral: 'oak',
  };
  const row = evaluateOrdinals(family, gold, [0, 1]);
  assert.equal(row.recallAt1, 0.5);
  assert.equal(row.conflictBothAt3, true);
  assert.equal(row.distinctRootGroupsAt8, 1);
  const unknown = evaluateOrdinals(
    family,
    { id: 'u', text: 'oak missing', status: 'unknown', relevantOrdinals: [] },
    [0],
  );
  assert.equal(unknown.recallAt8, null);
  assert.equal(unknown.unknownNonempty, true);
  assert.deepEqual(summarize([row, unknown]).unknownNonempty, { numerator: 1, denominator: 1 });
});
after(() => {
  const maxRssKiB = process.resourceUsage().maxRSS;
  console.log(JSON.stringify({ mechanismTestsOnly: true, maxRssKiB, formalCohort: 'NOT_RUN' }));
  if (process.execArgv.includes('--max-old-space-size=128'))
    assert.ok(maxRssKiB <= 256 * 1024, 'runtime RSS exceeds 256 MiB');
});
