import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { COLD_SAFETY_PROFILE } from '../src/safety-format.ts';
import { HybridBackendLane, HybridInferenceSession } from '../src/hybrid-inference.ts';
import type { HybridBackendPort } from '../src/hybrid-inference.ts';
import { HYBRID_PROTOCOL } from '../src/hybrid-profile.ts';
import type { HybridBinding, HybridProfile } from '../src/hybrid-profile.ts';
import type { HybridReply } from '../src/hybrid-wire.ts';
import { extractMemoryJob } from '../src/pipeline.ts';
import { compareSyntheticQuery } from '../research/retrieval-baseline/driver.ts';
import { publishSynthetic } from '../research/retrieval-baseline/fixture.ts';
import type { SyntheticFixture } from '../research/retrieval-baseline/fixture.ts';

// Mechanism-only examples: deliberately never import the frozen formal cohort/runner.
const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'test', relationshipId: 'bcd' };
const event = (key: string) => ({
  source: 'synthetic',
  eventKey: key,
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: `synthetic ${key}`,
    occurredAt: null,
  },
});
const hash = 'a'.repeat(64);
const asset = { id: 'synthetic/asset', revision: hash, sha256: hash };
const profile: HybridProfile = {
  version: 1,
  profileId: 'synthetic/bcd',
  model: { ...asset, precision: 'synthetic' },
  tokenizer: asset,
  processor: asset,
  chatTemplateSha256: hash,
  adapterSha256: null,
  routerAuxSha256: null,
  runtime: {
    id: 'synthetic/runtime',
    buildSha256: hash,
    kernelSha256: hash,
    cacheLayoutSha256: hash,
    topologySha256: hash,
  },
  modelModalities: ['text'],
  stateFamilies: ['attention-kv', 'ssm', 'convolution', 'position-prefix'],
  protocol: HYBRID_PROTOCOL,
};
type PortInput = Parameters<HybridBackendPort['generate']>[0];
function reply(input: PortInput): HybridReply {
  const request = JSON.parse(new TextDecoder().decode(input.requestBytes));
  return {
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'final-proposal',
        requestId: request.requestId,
        lease: request.lease,
        profileDigest: request.profileDigest,
        proposal: {
          kind: 'claim',
          statement: 'oak integrated result',
          basis: 'self_report',
          validFrom: null,
          validTo: null,
        },
      }),
    ),
  };
}

for (const change of ['none', 'purge', 'ttl'] as const)
  test(`P4 frozen Hybrid adapter pipeline ${change}, permanent Safety and reopen`, async (t) => {
    let wall = 100;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bcd-main-')));
    const authority = LocalSqliteAuthority.create({
      directory: join(root, 'authority'),
      authorityId: 'synthetic-authority',
      custodyDomain: 'independent',
    });
    const config = {
      directory: join(root, 'vault'),
      vaultId: 'synthetic-vault',
      identity: 'synthetic',
      storageDomain: 'payload',
      authority,
      keys: generateKeySet(),
      schemaVersion: 2 as const,
      storageProfile: COLD_SAFETY_PROFILE,
    };
    const options = { clock: { wall: () => wall, monotonic: () => 0 } };
    let vault = AnchoredVault.create(config, 4, options);
    t.after(() => {
      vault.close();
      authority.close();
    });
    const store = vault.store,
      scope = store.ensureScope(who),
      source = store.acceptEvent(scope, event('root'));
    const selected = publishSynthetic(store, scope, [source], 'oak source', 200);
    const frozen = store.beginSelectedExtraction(scope, source);
    assert.ok('job' in frozen);
    // Bind a published TTL source as well as the selected event to the actual frozen job.
    const job = change === 'none' ? frozen.job : store.beginJob(scope, [selected]);
    const binding: HybridBinding = {
      namespace: who,
      scopeId: scope.id,
      generation: scope.generation,
      consentRevision: scope.consentRevision,
      runtimeEpoch: scope.runtimeEpoch,
      permissionEpoch: 0,
      sessionId: 'synthetic/session',
      purpose: 'memory-proposal',
      evaluationGroup: 'synthetic/mechanism',
      sourceRefs: job.sourceRefs,
    };
    let calls = 0,
      captured!: PortInput,
      resolve!: (value: HybridReply) => void;
    const pending = new Promise<HybridReply>((yes) => {
      resolve = yes;
    });
    const session = new HybridInferenceSession({
      profile,
      binding,
      lane: new HybridBackendLane({
        generate: (input) => {
          calls++;
          captured = input;
          return pending;
        },
      }),
      // Trusted owner gate uses actual public source closure/epoch, never a test boolean.
      validateCurrent: ({ binding: b }) => {
        const current = store.scope(b.scopeId);
        if (
          current.generation !== b.generation ||
          current.consentRevision !== b.consentRevision ||
          current.runtimeEpoch !== b.runtimeEpoch
        )
          return false;
        store.sceneSourceSnapshot(scope, [selected]);
        return true;
      },
    });
    t.after(() => session.close());
    vault.claim('synthetic-request', 'frozen-job');
    vault.reserve('synthetic-request');
    const work = extractMemoryJob(store, job, session.asInferenceAdapter('synthetic-request'));
    // Attach both outcomes before fault injection/settlement to avoid unhandled rejection.
    const outcome = work.then(
      (value) => ({ value }),
      (error) => ({ error: error as Error }),
    );
    assert.equal(calls, 1);
    const sent = JSON.parse(new TextDecoder().decode(captured.requestBytes));
    assert.deepEqual(sent.binding.sourceRefs, job.sourceRefs);
    assert.deepEqual(sent.selectedEvidence, [event('root').evidence]);
    if (change === 'purge') store.purge(scope);
    if (change === 'ttl') wall = 200;
    resolve(reply(captured));
    const result = await outcome;
    if (change === 'none') {
      assert.ok('value' in result);
      const handle = store.registerConsumer('recall', scope, 'retrieval-refs-v1');
      assert.ok(store.readConsumer(handle).refs.some((ref) => ref.id === result.value.id));
      // Synthetic caller bookkeeping only; this is no real delivery/Host acceptance.
      vault.terminal('synthetic-request', 'ready', 'synthetic-delivery');
      vault.terminal('synthetic-request', 'taken', 'synthetic-delivery');
      vault.terminal('synthetic-request', 'acknowledged', 'synthetic-delivery');
      vault.close();
      vault = AnchoredVault.open(config, 4, options);
      const rebound = vault.store.bindConsumer('recall', vault.store.scope(scope.id));
      vault.store.applyConsumers([rebound]);
      assert.ok(vault.store.readConsumer(rebound).refs.some((ref) => ref.id === result.value.id));
      assert.deepEqual(vault.store.beginSelectedExtraction(scope, source), { receipt: result.value });
    } else {
      assert.ok('error' in result);
      assert.match(result.error.message, /HYBRID_CURRENTNESS_DENIED/);
      assert.equal(session.status('synthetic-request')?.state, 'unknown_after_dispatch');
      vault.terminal('synthetic-request', 'unknown');
      const current = store.scope(scope.id),
        handle = store.registerConsumer('recall', current, 'retrieval-refs-v1');
      assert.deepEqual(store.readConsumer(handle).refs, []);
      vault.close();
      vault = AnchoredVault.open(config, 4, options);
      const rebound = vault.store.bindConsumer('recall', vault.store.scope(scope.id));
      vault.store.applyConsumers([rebound]);
      assert.deepEqual(vault.store.readConsumer(rebound).refs, []);
    }
    assert.throws(() => vault.claim('synthetic-request', 'frozen-job'), /INTERACTION_TERMINATED/);
    assert.equal(vault.reserved, 1);
    assert.equal(calls, 1);
    t.diagnostic(`retained synthetic P4 root ${root}`);
  });

test('purged 513-node history with small current complete pool rejects post-ranking changes even for zero hits', (t) => {
  let wall = 100;
  const seed = new MemoryStore(':memory:', { schemaVersion: 2, clock: { wall: () => wall, monotonic: () => 0 } });
  const old = seed.ensureScope(who);
  for (let i = 0; i < 513; i++) {
    seed.acceptEvent(old, event(`old-${i}`));
    if ((i + 1) % 128 === 0) seed.pruneJournal(0);
  }
  const scope = seed.purge(old),
    source = seed.acceptEvent(scope, event('current'));
  const memory = publishSynthetic(seed, scope, [source], 'oak current', 200);
  seed.registerConsumer('research', scope, 'retrieval-refs-v1');
  const image = seed.snapshot();
  seed.close();
  for (const zero of [false, true])
    for (const change of ['generation', 'ttl', 'prefix'] as const) {
      wall = 100;
      const store = new MemoryStore(':memory:', {
        schemaVersion: 2,
        image,
        clock: { wall: () => wall, monotonic: () => 0 },
      });
      try {
        const current = store.scope(scope.id),
          handle = store.bindConsumer('research', current);
        store.applyConsumers([handle]);
        const fixture: SyntheticFixture = {
          store,
          scope: current,
          refs: [memory],
          roots: new Map([[0, source]]),
          handle,
          setWall: (value) => {
            wall = value;
          },
          close: () => store.close(),
        };
        const query = zero ? 'missing' : 'oak',
          result = compareSyntheticQuery(fixture, query);
        assert.equal(result.bm25.length, zero ? 0 : 1);
        assert.equal(result.ar0.length, zero ? 0 : 1);
        assert.throws(() => compareSyntheticQuery({ ...fixture, refs: [] }, query), /RESEARCH_SELECTION_CHANGED/);
        assert.throws(
          () =>
            compareSyntheticQuery(fixture, query, () => {
              if (change === 'generation') store.purge(current);
              if (change === 'ttl') wall = 200;
              if (change === 'prefix') {
                const before = store.consumerRetrievalSnapshot(handle);
                const other = store.ensureScope({ ...who, relationshipId: 'other' });
                store.acceptEvent(other, event('prefix'));
                store.applyConsumers([handle]);
                const after = store.consumerRetrievalSnapshot(handle);
                assert.deepEqual(after.selected, before.selected);
                assert.ok(after.consumer.applied > before.consumer.applied);
              }
            }),
          change === 'generation'
            ? /STALE_SCOPE/
            : change === 'ttl'
              ? /STALE_SOURCE|FANOUT_STALE_PROJECTION/
              : /RESEARCH_CURRENTNESS_CHANGED/,
        );
        const db = new DatabaseSync(':memory:');
        try {
          db.deserialize(store.snapshot());
          assert.equal(
            db.prepare('SELECT count(*) n FROM nodes WHERE scope_id=? AND generation=?').get(old.id, old.generation)!.n,
            513,
          );
        } finally {
          db.close();
        }
      } finally {
        store.close();
      }
    }
  t.diagnostic('one public RAM history build, six snapshot copies; no formal cohort execution');
});

after(() => console.log(JSON.stringify({ bcdTestMaxRSSKiB: process.resourceUsage().maxRSS })));
