/** Explicit synthetic experiment. Never imported by npm check or ordinary tests. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { ANCHORED_FORMAT, decodeStage, generateKeySet } from '../src/anchored-codec.ts';
import type { StorageProfile } from '../src/anchored-codec.ts';
import { directoryReader, reconstruct } from '../src/incremental-storage.ts';
import { decodeBlocks, encodeBlocks } from '../src/incremental-codec.ts';
import { inspectMemoryImage } from '../src/memory-image.ts';
import { sha } from '../src/durable-codec.ts';
import type { Safety } from '../src/durable-codec.ts';
import type { SourceRef } from '../src/contracts.ts';
import type { ConsumerHandle } from '../src/fanout-types.ts';

export const MEASUREMENT_PROTOCOL = Object.freeze({
  version: 1,
  events: 12,
  clockStart: 10000,
  compression: 'Brotli quality 4, raw fallback',
  blockBytes: 4096,
  maxChain: 16,
  entropyControl: { seed: 19088743, previousSeed: 124076833, bytes: 262144 },
  arms: ['v2-raw', 'v3-full-br4', 'v3-blocks-br4'],
  workloads: ['append', 'revision-revoke', 'dual-consumer', 'high-entropy'],
  gate: { incrementalVsFull: 0.15, incrementalVsV2: 0.5 },
  primaryCoverage: 'hot vault + independent authority main/current sidecars; end minus setup; no backup operations',
  extensions: 'current-state backup and new-target compaction, separately accounted; retain all originals',
  peakCoverage:
    'observed after-step/final extension logical-size lower bound; transient SQLite journals are not sampled',
  correctness:
    'each committed image byte-exact from disk; FTS/schema/highwater; own stable ledger/HMAC/Safety; cross-arm aliased source/consumer semantics',
});
type Workload = (typeof MEASUREMENT_PROTOCOL.workloads)[number];
type Arm = (typeof MEASUREMENT_PROTOCOL.arms)[number];
export function directoryBytes(directory: string): number {
  return readdirSync(directory).reduce((sum, name) => {
    const path = join(directory, name),
      s = statSync(path);
    return sum + (s.isDirectory() ? directoryBytes(path) : s.size);
  }, 0);
}
function normalize(value: any, aliases: Map<string, string>): any {
  if (typeof value === 'string') {
    if (aliases.has(value)) return aliases.get(value);
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)) throw new Error('Unmapped random identifier');
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return normalize(JSON.parse(value), aliases);
      } catch (error) {
        if (error instanceof SyntaxError) return value;
        throw error;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, aliases));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v, aliases)]),
    );
  return value;
}
export function gateSavings(raw: number, full: number, incremental: number) {
  assert.ok(raw > 0 && full > 0);
  return {
    vsFull: 1 - incremental / full,
    vsV2: 1 - incremental / raw,
    pass:
      1 - incremental / full >= MEASUREMENT_PROTOCOL.gate.incrementalVsFull &&
      1 - incremental / raw >= MEASUREMENT_PROTOCOL.gate.incrementalVsV2,
  };
}
const hmac = (key: string | Uint8Array, value: unknown) =>
  createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'measurement' };
// Reproducible high entropy text; not encryption or a production random source.
function seededBytes(seed: number, length: number): Buffer {
  let x = seed | 0;
  const b = Buffer.alloc(length);
  for (let i = 0; i < b.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 255;
  }
  return b;
}
function entropy(seed: number): string {
  return seededBytes(seed, 3072).toString('base64');
}
function runArm(root: string, workload: Workload, arm: Arm) {
  const dir = join(root, `${workload}-arm${MEASUREMENT_PROTOCOL.arms.indexOf(arm)}`);
  mkdirSync(dir);
  const authority = LocalSqliteAuthority.create({
    directory: join(dir, 'authority'),
    authorityId: 'synthetic-authority',
    custodyDomain: 'independent',
  });
  const profile: StorageProfile | undefined =
    arm === 'v2-raw' ? undefined : arm === 'v3-full-br4' ? 'full-br4-v1' : 'blocks-br4-v1';
  const config = {
    directory: join(dir, 'vault'),
    vaultId: 'synthetic-vault',
    identity: 'synthetic',
    storageDomain: 'payload',
    authority,
    keys: generateKeySet(),
    schemaVersion: 2 as const,
    ...(profile ? { storageProfile: profile } : {}),
  };
  let wall: number = MEASUREMENT_PROTOCOL.clockStart;
  const options = { clock: { wall: () => wall, monotonic: () => 0 } };
  let v = AnchoredVault.create(config, 4, options);
  const initial = directoryBytes(dir),
    aliases = new Map<string, string>(),
    events: SourceRef[] = [],
    eventInputs = new Map<string, any>();
  const traces: {
    step: string;
    imageHash: string;
    semanticHash: string;
    sequence: number;
    replayCount: number;
    patchDecodedBytes: number;
    readBytes: number;
  }[] = [];
  const latencies: number[] = [];
  let peak = initial,
    commits = 0,
    ledger: string | undefined,
    mutableRewriteObservations = 0;
  let priorFiles = new Map<string, string>();
  const observed = () => {
    const files = new Map<string, string>();
    for (const directory of [config.directory, authority.directory])
      for (const name of readdirSync(directory)) {
        const path = join(directory, name),
          stat = statSync(path);
        if (stat.isFile()) {
          const digest = sha(readFileSync(path));
          files.set(path, digest);
          if (priorFiles.has(path) && priorFiles.get(path) !== digest) mutableRewriteObservations++;
        }
      }
    priorFiles = files;
    peak = Math.max(peak, directoryBytes(dir));
  };
  observed();
  const expectedIngress: Safety['ingress'] = [];
  let expectedReserved = 0,
    expectedDelivery: string | null = null;
  const expectedNodes = new Map<
    string,
    {
      type: string;
      revision: number;
      status: string;
      body: any;
      search: string;
      created: number;
      parent: string | null;
    }
  >();
  let expectedHighWater = 0,
    leaseOwner: string | undefined;
  const alias = (id: string, name: string) => {
    assert.ok(!aliases.has(id));
    assert.ok(![...aliases.values()].includes(name));
    aliases.set(id, name);
  };
  const read = () => {
    const head = v.head;
    return head.format === ANCHORED_FORMAT
      ? decodeStage(
          Buffer.from(
            JSON.stringify({
              format: ANCHORED_FORMAT,
              head,
              checkpoint: readFileSync(join(config.directory, `checkpoint-${head.sequence}.bin`)).toString('base64'),
              record: readFileSync(join(config.directory, `record-${head.sequence}.bin`)).toString('base64'),
            }),
          ),
          config.keys,
          4,
        )
      : reconstruct(head, directoryReader(config.directory), config.keys, 4);
  };
  const capture = (label: string) => {
    const d = read(),
      image = v.store.snapshot(),
      db = new DatabaseSync(':memory:');
    try {
      assert.ok(d.image.equals(image));
      assert.equal(inspectMemoryImage(d.image, 2).revocationHighWater, d.state.revocationHighWater);
      db.deserialize(image);
      const ownLedger = db.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()!.value as string;
      if (ledger === undefined) ledger = ownLedger;
      else assert.equal(ownLedger, ledger);
      const scopes = db.prepare('SELECT * FROM scopes').all();
      assert.equal(scopes.length, aliases.size ? 1 : 0);
      if (scopes.length) {
        assert.equal(scopes[0]!.generation, 0);
        assert.equal(scopes[0]!.consent_revision, 0);
        assert.equal(scopes[0]!.learning_allowed, 0);
        assert.equal(scopes[0]!.runtime_epoch, expectedHighWater);
      }
      assert.equal(db.prepare('SELECT count(*) AS n FROM ingress').get()!.n, eventInputs.size);
      assert.equal(db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n, 0);
      for (const [nodeId, input] of eventInputs) {
        const row = db.prepare('SELECT * FROM ingress WHERE node_id=?').get(nodeId)!;
        assert.equal(row.scope_id, scopes[0]!.id);
        assert.equal(row.key_hash, hmac(ownLedger, [input.source, input.eventKey]));
        assert.equal(row.payload_hash, hmac(ownLedger, input.evidence));
      }
      assert.equal(d.state.revocationHighWater, expectedHighWater);
      assert.equal(db.prepare('SELECT count(*) AS n FROM revocations').get()!.n, expectedHighWater);
      assert.equal(db.prepare('SELECT count(*) AS n FROM nodes').get()!.n, expectedNodes.size);
      const expectedFTS: unknown[] = [];
      let dependencyCount = 0;
      for (const [id, e] of expectedNodes) {
        const n = db.prepare('SELECT * FROM nodes WHERE id=?').get(id)!;
        assert.equal(n.type, e.type);
        assert.equal(n.scope_id, scopes[0]!.id);
        assert.equal(n.revision, e.revision);
        assert.equal(n.status, e.status);
        assert.equal(n.generation, 0);
        assert.equal(n.consent_revision, 0);
        assert.deepEqual(n.body === null ? null : JSON.parse(n.body as string), e.body);
        assert.equal(n.search_text, e.search);
        assert.equal(n.created_at, e.created);
        assert.equal(n.valid_from, null);
        assert.equal(n.valid_to, null);
        assert.equal(n.projection_visible, Number(e.type === 'memory' && e.status === 'active'));
        if (e.parent) {
          dependencyCount++;
          assert.deepEqual(
            { ...db.prepare('SELECT parent_id,parent_revision FROM dependencies WHERE child_id=?').get(id) },
            { parent_id: e.parent, parent_revision: 1 },
          );
        }
        if (e.type === 'memory' && e.status === 'active') expectedFTS.push({ node_id: id, statement: e.search });
      }
      assert.equal(db.prepare('SELECT count(*) AS n FROM dependencies').get()!.n, dependencyCount);
      const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
      assert.deepEqual(sorted(db.prepare('SELECT node_id,statement FROM memory_fts').all()), sorted(expectedFTS));
      const owners = db.prepare('SELECT DISTINCT lease_owner FROM jobs WHERE lease_owner IS NOT NULL').all();
      if (owners.length) {
        assert.equal(owners.length, 1);
        const owner = owners[0]!.lease_owner as string;
        if (leaseOwner === undefined) leaseOwner = owner;
        else assert.equal(owner, leaseOwner);
      }
      assert.deepEqual(d.state.safety.ingress, expectedIngress);
      assert.equal(d.state.safety.reserved, expectedReserved);
      assert.equal(d.state.safety.maxCalls, 4);
      assert.equal(d.state.safety.lastSourceRef, null);
      assert.equal(d.state.safety.lastAcknowledgedDeliveryId, expectedDelivery);
      assert.equal(d.state.safety.lastWall, wall);
      const queries = {
        scopes: 'SELECT * FROM scopes',
        nodes: 'SELECT * FROM nodes',
        dependencies: 'SELECT * FROM dependencies',
        outbox: 'SELECT * FROM outbox',
        revocations: 'SELECT * FROM revocations',
        jobs: 'SELECT id,scope_id,kind,generation,consent_revision,refs,status,draft,lease_owner IS NOT NULL AS leased,lease_token,lease_deadline,result_id FROM jobs',
        fts: 'SELECT node_id,statement FROM memory_fts',
        journal: 'SELECT seq,phase,as_of,revocation_high_water,item_count,complete FROM fanout_batches',
        items: 'SELECT * FROM fanout_items',
        fanout: 'SELECT * FROM fanout_state',
        consumers: 'SELECT * FROM fanout_consumers',
        projection: 'SELECT * FROM fanout_projection',
      };
      const semantic = Object.fromEntries(
        Object.entries(queries).map(([name, query]) => [
          name,
          (normalize(db.prepare(query).all(), aliases) as unknown[]).sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
          ),
        ]),
      );
      const stats = 'baseline' in d ? d.baseline : { depth: 1, decodedBytes: d.image.length, readBytes: 0 };
      traces.push({
        step: label,
        imageHash: sha(image),
        semanticHash: sha(
          JSON.stringify({
            ...semantic,
            safety: {
              reserved: expectedReserved,
              ingress: expectedIngress.map(({ key, fingerprint, ...e }) => e),
              lastWall: d.state.safety.lastWall,
              lastAcknowledgedDeliveryId: expectedDelivery,
            },
          }),
        ),
        sequence: d.stage.head.sequence,
        replayCount: stats.depth,
        patchDecodedBytes: stats.decodedBytes,
        readBytes: stats.readBytes,
      });
    } finally {
      d.image.fill(0);
      image.fill(0);
      db.close();
    }
  };
  const step = <T>(label: string, body: () => T): T => {
    if (label !== 'unchanged-poll') wall++;
    const before = v.head.sequence,
      start = performance.now();
    const result = body();
    latencies.push(performance.now() - start);
    assert.equal(v.head.sequence, before + (label === 'unchanged-poll' ? 0 : 1));
    commits += v.head.sequence - before;
    capture(label);
    observed();
    return result;
  };
  try {
    capture('setup');
    const scope = step('scope', () => {
      const s = v.store.ensureScope(who);
      alias(s.id, 'scope');
      return s;
    });
    step('claim-delivered', () => {
      v.claim('delivered', 'payload');
      expectedIngress.push({
        key: hmac(config.keys.ingressKey, ['ingress', 'delivered']),
        fingerprint: hmac(config.keys.ingressKey, ['payload', 'payload']),
        state: 'pending',
        deliveryId: null,
        reserved: false,
        feedbackConsumed: false,
      });
    });
    step('reserve-delivered', () => {
      v.reserve('delivered');
      expectedIngress[0]!.reserved = true;
      expectedReserved++;
    });
    for (const state of ['ready', 'taken', 'acknowledged'] as const)
      step(state, () => {
        v.terminal('delivered', state, 'delivery-one');
        expectedIngress[0]!.state = state;
        expectedIngress[0]!.deliveryId = 'delivery-one';
        if (state === 'acknowledged') expectedDelivery = 'delivery-one';
      });
    step('feedback', () => {
      v.consumeFeedback('delivery-one');
      expectedIngress[0]!.feedbackConsumed = true;
    });
    step('claim-unknown', () => {
      v.claim('unfinished', 'payload2');
      expectedIngress.push({
        key: hmac(config.keys.ingressKey, ['ingress', 'unfinished']),
        fingerprint: hmac(config.keys.ingressKey, ['payload', 'payload2']),
        state: 'pending',
        deliveryId: null,
        reserved: false,
        feedbackConsumed: false,
      });
    });
    step('reserve-unknown', () => {
      v.reserve('unfinished');
      expectedIngress[1]!.reserved = true;
      expectedReserved++;
    });
    const handles: ConsumerHandle[] = [];
    if (workload === 'dual-consumer')
      for (const [id, profile] of [
        ['retrieval', 'retrieval-refs-v1'],
        ['scene', 'scene-source-refs-v1'],
      ] as const)
        handles.push(step(`register-${id}`, () => v.store.registerConsumer(id, scope, profile)));
    for (let i = 0; i < MEASUREMENT_PROTOCOL.events; i++) {
      const selectedText =
        workload === 'high-entropy'
          ? entropy(0x1234567 + i)
          : `Synthetic violet preference ${i}. ` + 'A bounded source with stable repeated context. '.repeat(12);
      const input = {
        source: 'synthetic',
        eventKey: `event-${i}`,
        evidence: {
          speakerId: 'subject',
          speakerRole: 'subject' as const,
          mode: 'self_report' as const,
          selectedText,
          occurredAt: null,
        },
      };
      const event = step(`event-${i}`, () => {
        const ref = v.store.acceptEvent(scope, input);
        alias(ref.id, `event-${i}`);
        eventInputs.set(ref.id, input);
        expectedNodes.set(ref.id, {
          type: 'event',
          revision: 1,
          status: 'active',
          body: input.evidence,
          search: '',
          created: wall,
          parent: null,
        });
        return ref;
      });
      events.push(event);
      const job = step(`job-${i}`, () => {
        const j = v.store.beginJob(scope, [event]);
        alias(j.id, `job-${i}`);
        return j;
      });
      const lease = step(`lease-${i}`, () => {
        const l = v.store.claimLease(scope, job.id);
        alias(l.token, `lease-${i}`);
        return l;
      });
      const proposal = {
        kind: 'claim' as const,
        statement: workload === 'high-entropy' ? entropy(0x7654321 + i) : `Synthetic violet claim ${i}`,
        basis: 'self_report' as const,
        validFrom: null,
        validTo: null,
      };
      step(`propose-${i}`, () => v.store.propose(scope, job.id, lease.token, proposal));
      step(`publish-${i}`, () => {
        const ref = v.store.publish(scope, job.id, lease.token);
        alias(ref.id, `memory-${i}`);
        expectedNodes.set(ref.id, {
          type: 'memory',
          revision: 1,
          status: 'active',
          body: proposal,
          search: proposal.statement,
          created: wall,
          parent: event.id,
        });
      });
      const invalidate = (id: string) => {
        for (const [n, e] of expectedNodes)
          if (n === id || e.parent === id) {
            e.status = 'revoked';
            e.body = null;
            e.search = '';
          }
        expectedHighWater++;
      };
      if (workload === 'revision-revoke' && i % 3 === 2) {
        const ref = events[i - 1]!,
          evidence = { ...input.evidence, selectedText: `Corrected synthetic violet ${i}` };
        step(`revision-${i}`, () => {
          v.store.reviseEvent(scope, ref, evidence);
          invalidate(ref.id);
          const e = expectedNodes.get(ref.id)!;
          e.status = 'active';
          e.revision++;
          e.body = evidence;
        });
        step(`revoke-${i}`, () => {
          v.store.revoke(scope, event);
          invalidate(event.id);
        });
      }
      if (handles.length) {
        step(`apply-a-${i}`, () => v.store.applyConsumers([handles[0]!]));
        step(`apply-b-${i}`, () => v.store.applyConsumers([handles[1]!]));
      }
    }
    const beforePoll = v.head.sequence;
    step('unchanged-poll', () => {
      v.store.scope(scope.id);
      v.store.sweepConsumers();
      if (handles.length) {
        v.store.applyConsumers(handles);
        v.store.readConsumer(handles[0]!);
      }
    });
    assert.equal(v.head.sequence, beforePoll);
    const end = directoryBytes(dir),
      primary = {
        initialBytes: initial,
        finalBytes: end,
        growthBytes: end - initial,
        observedPeakBytes: peak,
        commits,
        noChangePollCommits: 0,
        mutableRewriteObservations,
        files: readdirSync(config.directory).reduce(
          (acc, name) => {
            const category = name.startsWith('blob-')
              ? 'blob'
              : name.startsWith('stage-')
                ? 'stage'
                : name.startsWith('record-')
                  ? 'record'
                  : name.startsWith('checkpoint-')
                    ? 'checkpoint'
                    : 'other';
            acc[category] = (acc[category] ?? 0) + statSync(join(config.directory, name)).size;
            return acc;
          },
          {} as Record<string, number>,
        ),
        authorityBytes: directoryBytes(authority.directory),
        latencyMs: { mean: latencies.reduce((a, b) => a + b, 0) / latencies.length, max: Math.max(...latencies) },
        maxReplayCount: Math.max(...traces.map((t) => t.replayCount)),
        maxPatchDecodedBytes: Math.max(...traces.map((t) => t.patchDecodedBytes)),
      };
    const backup = join(dir, 'backup'),
      backupStart = performance.now();
    v.exportBackup(backup);
    AnchoredVault.verifyBackup({ backupDirectory: backup, authority, keys: config.keys, maxCalls: 4 });
    const backupMs = performance.now() - backupStart,
      withBackup = directoryBytes(dir);
    let extension: any = {
      backupBytes: directoryBytes(backup),
      backupMs,
      retainedSourceBytes: directoryBytes(config.directory),
      totalAfterBackup: withBackup,
    };
    if (profile) {
      const target = join(dir, 'compacted'),
        sourceHash = sha(JSON.stringify(sizesForReport(config.directory))),
        snapshot = v.store.snapshot(),
        start = performance.now();
      const receipt = AnchoredVault.compact({
        authority,
        vaultId: config.vaultId,
        keys: config.keys,
        maxCalls: 4,
        targetDirectory: target,
        storageDomain: config.storageDomain,
        operationId: 'measure-compaction',
      });
      const compactMs = performance.now() - start,
        d = reconstruct(receipt.newHead, directoryReader(target), config.keys, 4);
      assert.ok(d.image.equals(snapshot));
      assert.equal(d.baseline.depth, 1);
      d.image.fill(0);
      snapshot.fill(0);
      assert.equal(sha(JSON.stringify(sizesForReport(config.directory))), sourceHash);
      assert.throws(() => v.status, /ANCHOR_FENCED/);
      v.close();
      const bootStart = performance.now();
      v = AnchoredVault.open({ ...config, directory: target }, 4, options);
      const startupMs = performance.now() - bootStart;
      assert.equal(v.reserved, 2);
      assert.equal(v.status.unknownRequests, 1);
      assert.throws(() => v.claim('delivered', 'payload'), /INTERACTION_TERMINATED/);
      const bootImage = v.store.snapshot(),
        bootFrame = reconstruct(v.head, directoryReader(target), config.keys, 4);
      try {
        assert.ok(bootFrame.image.equals(bootImage));
        assert.equal(inspectMemoryImage(bootFrame.image, 2).revocationHighWater, expectedHighWater);
      } finally {
        bootImage.fill(0);
        bootFrame.image.fill(0);
      }
      const keyDB = new DatabaseSync(':memory:');
      try {
        keyDB.deserialize(v.store.snapshot());
        assert.equal(keyDB.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()!.value, ledger);
      } finally {
        keyDB.close();
      }
      extension = {
        ...extension,
        compactionMs: compactMs,
        startupMs,
        activeBytes: directoryBytes(target),
        totalAfterCompactionAndBoot: directoryBytes(dir),
        observedPeakBytes: Math.max(peak, withBackup, directoryBytes(dir)),
      };
    }
    return { workload, arm, primary, extension, traces };
  } finally {
    v.close();
    authority.close();
  }
}
function sizesForReport(directory: string) {
  return readdirSync(directory)
    .sort()
    .map((name) => ({
      name,
      size: statSync(join(directory, name)).size,
      hash: sha(readFileSync(join(directory, name))),
    }));
}
export function runMeasurement(root: string) {
  const sources = [
    'src/anchored-codec.ts',
    'src/anchored-vault.ts',
    'src/local-sqlite-authority.ts',
    'src/incremental-codec.ts',
    'src/incremental-storage.ts',
    'src/store.ts',
    'src/memory-image.ts',
    'src/durable-codec.ts',
    'src/durable-backup.ts',
    'src/legacy-m2-import.ts',
    'src/legacy-import-types.ts',
    'src/schema.ts',
    'src/schema-v2.ts',
    'src/durable-fanout.ts',
    'src/fanout-types.ts',
    'src/contracts.ts',
    'src/validation.ts',
    'scripts/incremental-storage-measure.ts',
  ];
  const sourceHashes = Object.fromEntries(sources.map((path) => [path, sha(readFileSync(path))]));
  const results: Array<ReturnType<typeof runArm>> = [];
  for (const workload of MEASUREMENT_PROTOCOL.workloads)
    for (const arm of MEASUREMENT_PROTOCOL.arms) results.push(runArm(root, workload, arm));
  const comparisons = [];
  for (const workload of MEASUREMENT_PROTOCOL.workloads) {
    const arms = results.filter((r) => r.workload === workload),
      reference = arms[0]!;
    for (const other of arms.slice(1))
      assert.deepEqual(
        other.traces.map((t) => [t.step, t.sequence, t.semanticHash]),
        reference.traces.map((t) => [t.step, t.sequence, t.semanticHash]),
      );
    const savings = gateSavings(
      arms[0]!.primary.growthBytes,
      arms[1]!.primary.growthBytes,
      arms[2]!.primary.growthBytes,
    );
    comparisons.push({ workload, ...savings, gateRequired: workload !== 'high-entropy' });
  }
  const control = MEASUREMENT_PROTOCOL.entropyControl,
    random = seededBytes(control.seed, control.bytes),
    previous = seededBytes(control.previousSeed, control.bytes),
    encoded = encodeBlocks(random, previous, 'blocks-br4-v1');
  assert.equal(encoded.descriptor.mode, 'base');
  assert.equal(encoded.descriptor.codec, 'raw');
  assert.ok(decodeBlocks(encoded.descriptor, encoded.payload, null).equals(random));
  assert.deepEqual(Object.fromEntries(sources.map((path) => [path, sha(readFileSync(path))])), sourceHashes);
  const report = {
    protocol: MEASUREMENT_PROTOCOL,
    protocolDigest: sha(JSON.stringify(MEASUREMENT_PROTOCOL)),
    sourceHashes,
    node: process.version,
    results,
    comparisons,
    entropyControl: {
      mode: encoded.descriptor.mode,
      codec: encoded.descriptor.codec,
      inputBytes: random.length,
      encodedBytes: encoded.payload.length,
      inputHash: sha(random),
      previousHash: sha(previous),
    },
    maxRSSKiB: process.resourceUsage().maxRSS,
  };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = mkdtempSync(join(tmpdir(), 'aemc-if3-measure-'));
  console.log(JSON.stringify({ root, protocolDigest: sha(JSON.stringify(MEASUREMENT_PROTOCOL)) }));
  const report = runMeasurement(root);
  console.log(
    JSON.stringify({
      root,
      comparisons: report.comparisons,
      entropyControl: report.entropyControl,
      maxRSSKiB: report.maxRSSKiB,
    }),
  );
  if (report.comparisons.some((c) => c.gateRequired && !c.pass)) process.exitCode = 1;
}
