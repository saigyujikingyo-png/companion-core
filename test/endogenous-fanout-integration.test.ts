import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { COLD_SAFETY_PROFILE } from '../src/safety-format.ts';
import { parseControl } from '../src/endogenous-durable.ts';
import type { MemoryStore } from '../src/store.ts';
import type { Epoch, Proposal, SourceRef } from '../src/contracts.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'integration' };
const event = (key: string) => ({
  source: 'synthetic',
  eventKey: key,
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: `synthetic integration ${key}`,
    occurredAt: null,
  },
});
const rest = '{"version":1,"choice":"REST"}';
const limits = { maxCalls: 4, maxResultBytes: 1024, maxDurationMs: 60_000, callTimeoutMs: 5000 };
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function publish(store: MemoryStore, scope: Epoch, refs: SourceRef[], validTo: number | null = null): SourceRef {
  const proposal: Proposal = {
    kind: 'claim',
    statement: 'synthetic integration memory',
    basis: 'self_report',
    validFrom: null,
    validTo,
  };
  const job = store.beginJob(scope, refs),
    lease = store.claimLease(scope, job.id);
  store.propose(scope, job.id, lease.token, proposal);
  return { ...store.publish(scope, job.id, lease.token), revision: 1 };
}
/** Public snapshot inspection only. Fixture mutations all use the public Store/Vault APIs. */
function history(store: MemoryStore, scopeId: string, beforeGeneration: number) {
  const image = store.snapshot(),
    db = new DatabaseSync(':memory:');
  try {
    db.deserialize(image);
    return {
      nodes: db
        .prepare('SELECT * FROM nodes WHERE scope_id=? AND generation<? ORDER BY id')
        .all(scopeId, beforeGeneration),
      ingress: db
        .prepare(
          'SELECT i.* FROM ingress i JOIN nodes n ON n.id=i.node_id WHERE n.scope_id=? AND n.generation<? ORDER BY i.scope_id,i.key_hash',
        )
        .all(scopeId, beforeGeneration),
      dependencies: db
        .prepare(
          'SELECT d.* FROM dependencies d JOIN nodes n ON n.id=d.child_id WHERE n.scope_id=? AND n.generation<? ORDER BY d.child_id,d.parent_id',
        )
        .all(scopeId, beforeGeneration),
    };
  } finally {
    image.fill(0);
    db.close();
  }
}

test('schema2/P4 retained history, E1 fencing and two durable consumers survive one longitudinal lifecycle', async (t) => {
  const started = performance.now(),
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'companion-e1-fanout-integration-')));
  t.diagnostic(`Retained synthetic integration fixture: ${root}`);
  // History construction uses fixed clocks: its real elapsed time cannot consume the later E1 permission.
  let wall = 100_000;
  const options = { clock: { wall: () => wall, monotonic: () => 0 } };
  const authority = LocalSqliteAuthority.create({
    directory: join(root, 'authority'),
    authorityId: 'synthetic-authority',
    custodyDomain: 'independent',
  });
  const config = {
    directory: join(root, 'vault'),
    authority,
    keys: generateKeySet(),
    vaultId: 'synthetic-vault',
    identity: 'synthetic',
    storageDomain: 'payload',
    schemaVersion: 2 as const,
    storageProfile: COLD_SAFETY_PROFILE,
  };
  let vault = AnchoredVault.create(config, 4, options),
    decisionCalls = 0;
  t.after(() => {
    try {
      vault.close();
    } finally {
      authority.close();
    }
    t.diagnostic(
      JSON.stringify({
        evidence: 'E1_FANOUT_SYNTHETIC_INTEGRATION',
        decisionCalls,
        elapsedMs: Math.round(performance.now() - started),
        maxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  });

  // Build the shared old history once, including nonempty dependency history; do not enlarge any limit.
  const originalScope = vault.store.ensureScope(who),
    oldEvents: SourceRef[] = [];
  for (let i = 0; i < 513; i++) {
    oldEvents.push(vault.store.acceptEvent(originalScope, event(`old-${i}`)));
    if (i === 1) publish(vault.store, originalScope, [oldEvents[0]!, oldEvents[1]!]);
    if ((i + 1) % 128 === 0) vault.store.pruneJournal(0);
  }
  const firstScope = vault.store.purge(originalScope),
    firstHistory = history(vault.store, firstScope.id, firstScope.generation);
  assert.equal(firstHistory.nodes.length, 514);
  assert.equal(firstHistory.ingress.length, 513);
  assert.equal(firstHistory.dependencies.length, 2);
  const firstEvent = vault.store.acceptEvent(firstScope, event('generation-one'));
  const firstMemory = publish(vault.store, firstScope, [firstEvent]);
  const initialHandles = [
    vault.store.registerConsumer('retrieval', firstScope, 'retrieval-refs-v1'),
    vault.store.registerConsumer('scene', firstScope, 'scene-source-refs-v1'),
  ];
  assert.deepEqual(
    vault.store.readConsumer(initialHandles[0]!).refs.map((r) => r.id),
    [firstMemory.id],
  );
  assert.deepEqual(
    new Set(vault.store.readConsumer(initialHandles[1]!).refs.map((r) => r.id)),
    new Set([firstEvent.id, firstMemory.id]),
  );

  const created = vault.createEndogenousControl(firstScope, limits);
  const initialSession = vault.openEndogenousControl(async () => {
    decisionCalls++;
    return rest;
  });
  initialSession.resume();
  await flush();
  assert.equal(initialSession.read().entries[0]!.outcome, 'REST');
  initialSession.pause();
  initialSession.close();
  const beforeClose = parseControl(vault.store.endogenousControl()!);
  assert.equal(beforeClose.entries.length, 1);
  assert.equal(beforeClose.permitHeld, false);
  vault.close();
  vault = AnchoredVault.open(config, 4, options);
  assert.equal(vault.head.storageProfile, COLD_SAFETY_PROFILE);
  for (const handle of initialHandles) assert.throws(() => vault.store.readConsumer(handle), /FANOUT_STALE_HANDLE/);
  const reopenedScope = vault.store.scope(firstScope.id);
  const rebound = initialHandles.map((h) => vault.store.bindConsumer(h.id, reopenedScope));
  vault.store.applyConsumers(rebound);
  assert.deepEqual(
    vault.store.readConsumer(rebound[0]!).refs.map((r) => r.id),
    [firstMemory.id],
  );
  assert.equal(vault.store.readConsumer(rebound[1]!).refs.length, 2);
  const recovered = parseControl(vault.store.endogenousControl()!);
  assert.equal(recovered.controlId, created.controlId);
  assert.deepEqual(recovered.limits, limits);
  assert.equal(recovered.expiresAt, created.expiresAt);
  assert.deepEqual(recovered.entries, beforeClose.entries);
  assert.equal(recovered.stop, 'PAUSED');
  assert.equal(recovered.permitHeld, false);

  let settle!: (value: string) => void, signal: AbortSignal | undefined;
  const pending = new Promise<string>((resolve) => {
    settle = resolve;
  });
  const session = vault.openEndogenousControl((request) => {
    decisionCalls++;
    signal = request.signal;
    assert.equal(request.decisionId, `${created.controlId}:2`);
    return pending;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.read().state, 'paused');
  assert.equal(decisionCalls, 1); // zero automatic calls after reopen
  session.resume();
  assert.equal(decisionCalls, 2);
  assert.equal(parseControl(vault.store.endogenousControl()!).permitHeld, true);
  const currentScope = vault.store.purge(reopenedScope);
  assert.equal(signal!.aborted, true);
  assert.equal(session.read().timerPending, false);
  assert.equal(session.read().actualPending, true);
  const fencedBytes = vault.store.endogenousControl()!,
    fenced = parseControl(fencedBytes);
  assert.equal(fenced.stop, 'FENCED');
  assert.equal(fenced.permitHeld, true);
  assert.deepEqual(
    fenced.entries.map((e) => e.outcome),
    ['REST', 'UNKNOWN'],
  );
  assert.equal(fenced.entries[1]!.decisionId, `${created.controlId}:2`);
  for (const handle of rebound) assert.throws(() => vault.store.readConsumer(handle), /FANOUT_STALE_HANDLE/);
  assert.throws(() => session.resume(), /E1_OWNER_CLOSED/);
  const purgedHistory = history(vault.store, currentScope.id, currentScope.generation);
  assert.equal(purgedHistory.nodes.length, 516);
  assert.equal(purgedHistory.ingress.length, 514);
  assert.equal(purgedHistory.dependencies.length, 3);

  // A small new graph remains usable while the independent E1 control remains fenced and held.
  const currentEvent = vault.store.acceptEvent(currentScope, event('generation-two'));
  const currentMemory = publish(vault.store, currentScope, [currentEvent], wall + 100);
  const currentHandles = rebound.map((h) => vault.store.resetConsumer(h.id, currentScope));
  vault.store.applyConsumers(currentHandles);
  assert.deepEqual(
    vault.store.readConsumer(currentHandles[0]!).refs.map((r) => r.id),
    [currentMemory.id],
  );
  assert.deepEqual(
    new Set(vault.store.readConsumer(currentHandles[1]!).refs.map((r) => r.id)),
    new Set([currentEvent.id, currentMemory.id]),
  );
  assert.deepEqual(vault.store.acceptEvent(currentScope, event('old-0')), {
    ...oldEvents[0],
    currentStatus: 'revoked',
  });
  assert.throws(
    () =>
      vault.store.acceptEvent(currentScope, {
        ...event('old-0'),
        evidence: {
          ...event('old-0').evidence,
          selectedText: 'synthetic conflicting payload',
        },
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.deepEqual(history(vault.store, currentScope.id, firstScope.generation), firstHistory);
  assert.deepEqual(history(vault.store, currentScope.id, currentScope.generation), purgedHistory);
  assert.equal(vault.store.endogenousControl(), fencedBytes);

  settle(rest);
  await flush();
  const afterSettlement = parseControl(vault.store.endogenousControl()!);
  assert.equal(afterSettlement.permitHeld, false);
  assert.equal(afterSettlement.stop, 'FENCED');
  assert.deepEqual(afterSettlement.entries, fenced.entries);
  assert.deepEqual(afterSettlement.limits, limits);
  assert.equal(afterSettlement.controlId, created.controlId);
  assert.equal(afterSettlement.expiresAt, created.expiresAt);
  assert.equal(session.read().actualPending, false);
  assert.equal(session.read().callsConsumed, 2);
  assert.equal(session.read().resultBytesReserved, 512);
  assert.equal(decisionCalls, 2);
  assert.equal(session.read().timerPending, false);
  assert.throws(() => session.resume(), /E1_OWNER_CLOSED/);
  const stoppedBytes = vault.store.endogenousControl();

  // Exactly one TTL stale read: its sweep must be durably committed before projection refusal.
  const headBeforeSweep = vault.head,
    journalBefore = vault.store.invalidationJournal().at(-1)!.sequence;
  wall += 100;
  assert.throws(() => vault.store.readConsumer(currentHandles[0]!), /FANOUT_STALE_PROJECTION/);
  const sweptHead = vault.head,
    barrier = vault.store.invalidationJournal().at(-1)!;
  assert.equal(sweptHead.sequence, headBeforeSweep.sequence + 1);
  assert.ok(barrier.sequence > journalBefore);
  assert.equal(barrier.phase, 'sweep');
  assert.equal(barrier.asOf, wall);
  assert.equal(vault.store.sweepConsumers().changed, false);
  assert.deepEqual(vault.head, sweptHead);
  vault.store.applyConsumers(currentHandles);
  for (const handle of currentHandles) assert.deepEqual(vault.store.readConsumer(handle).refs, []);
  assert.equal(vault.store.endogenousControl(), stoppedBytes);
  assert.deepEqual(history(vault.store, currentScope.id, currentScope.generation), purgedHistory);

  vault.close();
  vault = AnchoredVault.open(config, 4, options);
  const finalScope = vault.store.scope(currentScope.id);
  assert.equal(vault.store.endogenousControl(), stoppedBytes);
  assert.throws(
    () =>
      vault.openEndogenousControl(async () => {
        decisionCalls++;
        return rest;
      }),
    /E1_CONTROL_SCOPE/,
  );
  assert.throws(() => vault.createEndogenousControl(finalScope, limits), /E1_CONTROL_SCOPE/);
  for (const handle of currentHandles) assert.throws(() => vault.store.readConsumer(handle), /FANOUT_STALE_HANDLE/);
  const finalHandles = currentHandles.map((h) => vault.store.bindConsumer(h.id, finalScope));
  vault.store.applyConsumers(finalHandles);
  for (const handle of finalHandles) assert.deepEqual(vault.store.readConsumer(handle).refs, []);
  // Prove ordinary source writes and both current projections remain useful after the second reopen.
  const finalEvent = vault.store.acceptEvent(finalScope, event('after-final-reopen'));
  const finalMemory = publish(vault.store, finalScope, [finalEvent]);
  vault.store.applyConsumers(finalHandles);
  assert.deepEqual(
    vault.store.readConsumer(finalHandles[0]!).refs.map((r) => r.id),
    [finalMemory.id],
  );
  assert.deepEqual(
    new Set(vault.store.readConsumer(finalHandles[1]!).refs.map((r) => r.id)),
    new Set([finalEvent.id, finalMemory.id]),
  );
  assert.deepEqual(history(vault.store, finalScope.id, currentScope.generation), purgedHistory);
  const backup = join(root, 'final-backup'),
    receipt = vault.exportBackup(backup);
  assert.deepEqual(
    AnchoredVault.verifyBackup({ backupDirectory: backup, authority, keys: config.keys, maxCalls: 4 }),
    receipt,
  );
  assert.equal(vault.store.endogenousControl(), stoppedBytes);
  assert.equal(decisionCalls, 2);
  t.diagnostic(
    '514 old nodes / 513 ingress / 2 dependencies built once; two reopens; two profiles; E1 REST + UNKNOWN; one durable TTL refusal; verified backup.',
  );
});
