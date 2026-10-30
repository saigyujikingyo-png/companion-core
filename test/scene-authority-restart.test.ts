import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableMemory } from '../src/durable-memory.ts';
import { SceneAuthorityService } from '../src/scene-authority.ts';
import { SceneContract } from '../src/scene.ts';
import type { SceneBinding, SceneConsumer, SceneFrame } from '../src/scene-authority-types.ts';
import type { SourceRef } from '../src/contracts.ts';
import { identity, publish, code } from './retrieval-fixtures.ts';
import { epoch, scene, reset, replace } from './scene-authority-fixtures.ts';

test('synthetic M2 restores sources twice; explicit restaging and new reset baseline cannot revive revoked JSON or old handles', () => {
  const config = {
    directory: mkdtempSync(join(tmpdir(), 'companion-scene-authority-m2-')),
    identity: 'synthetic-scene-authority',
    keyBase64: randomBytes(32).toString('base64'),
  };
  const options = { clock: { wall: () => 100_000, monotonic: () => 0 } };
  let vault = new DurableMemory(config, 0, options);
  let scopeId = '',
    rootA: SourceRef,
    memoryA: SourceRef,
    memoryB: SourceRef,
    catalogA = '',
    catalogB = '',
    exportA = '',
    exportB = '';
  let oldBinding: SceneBinding,
    oldConsumer: SceneConsumer,
    oldFrame: SceneFrame,
    secondBinding: SceneBinding,
    secondFrame: SceneFrame;
  try {
    const scope = vault.store.ensureScope(identity);
    scopeId = scope.id;
    const event = (eventKey: string) =>
      vault.store.acceptEvent(scope, {
        source: 'synthetic',
        eventKey,
        evidence: {
          speakerId: 'alice',
          speakerRole: 'subject',
          mode: 'self_report',
          selectedText: 'SYNTHETIC_PRIVATE_SOURCE',
          occurredAt: null,
        },
      });
    rootA = event('a');
    const rootB = event('b');
    memoryA = publish(vault.store, scope, [rootA]);
    memoryB = publish(vault.store, scope, [rootB]);
    // Global ACK state is deliberately consumed before the new RAM protocol starts.
    for (const change of vault.store.projectionBatch(scope)) vault.store.acknowledgeProjection(scope, change);
    const a = scene(scope, rootA),
      b = scene(scope, rootB);
    catalogA = JSON.stringify(a.catalog);
    catalogB = JSON.stringify(b.catalog);
    const service = new SceneAuthorityService(vault.store);
    oldBinding = service.bind({ epoch: epoch(scope), publishedRefs: [memoryA], catalogJson: catalogA });
    oldConsumer = service.register(oldBinding);
    reset(service, oldBinding, oldConsumer);
    service.stage(oldBinding, JSON.stringify(a.packet));
    oldFrame = replace(service, oldBinding, oldConsumer).frame;
    exportA = service.export(oldBinding);
    const bindingB = service.bind({ epoch: epoch(scope), publishedRefs: [memoryB], catalogJson: catalogB });
    service.stage(bindingB, JSON.stringify(b.packet));
    exportB = service.export(bindingB);
  } finally {
    vault.close();
  }
  vault = new DurableMemory(config, 0, options);
  try {
    assert.equal(vault.restored, true);
    const scope = vault.store.scope(scopeId),
      service = new SceneAuthorityService(vault.store);
    assert.throws(() => service.read(oldBinding!), code('UNAUTHENTICATED'));
    const before = vault.store.snapshot(),
      sequence = vault.status.sequence;
    secondBinding = service.bind({ epoch: epoch(scope), publishedRefs: [memoryA!], catalogJson: catalogA });
    const consumer = service.register(secondBinding);
    assert.throws(() => service.pull(secondBinding, oldConsumer!), code('UNAUTHENTICATED'));
    assert.throws(() => service.resolve(secondBinding, consumer, oldFrame!), code('SCENE_FRAME_STALE'));
    const initial = service.pull(secondBinding, consumer)!;
    assert.equal(initial.info.operation, 'reset');
    service.import(secondBinding, exportA);
    assert.equal(service.pull(secondBinding, consumer)!.frame, initial.frame);
    reset(service, secondBinding, consumer);
    secondFrame = replace(service, secondBinding, consumer).frame;
    const result = service.resolve(secondBinding, consumer, secondFrame);
    assert.ok('data' in result);
    assert.equal(result.data.authority.runtimeEpoch, scope.runtimeEpoch);
    assert.ok(scope.runtimeEpoch > 0);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_SOURCE|selectedText|speakerId/);
    assert.deepEqual(vault.store.snapshot(), before);
    assert.equal(vault.status.sequence, sequence);
    vault.store.revoke(scope, rootA!);
    assert.throws(() => service.resolve(secondBinding, consumer, secondFrame), code('STALE_SOURCE'));
    reset(service, secondBinding, consumer);
  } finally {
    vault.close();
  }
  vault = new DurableMemory(config, 0, options);
  try {
    assert.equal(vault.restored, true);
    const scope = vault.store.scope(scopeId),
      service = new SceneAuthorityService(vault.store);
    assert.equal(new SceneContract(catalogA, 2).import(exportA).assurance, 'NOT_AUTHENTICATED');
    assert.throws(() => service.read(secondBinding!), code('UNAUTHENTICATED'));
    assert.throws(
      () => service.bind({ epoch: epoch(scope), publishedRefs: [memoryA!], catalogJson: catalogA }),
      code('STALE_SOURCE'),
    );
    const before = vault.store.snapshot(),
      sequence = vault.status.sequence;
    const binding = service.bind({ epoch: epoch(scope), publishedRefs: [memoryB!], catalogJson: catalogB }),
      consumer = service.register(binding);
    assert.throws(() => service.resolve(binding, consumer, secondFrame!), code('SCENE_FRAME_STALE'));
    reset(service, binding, consumer);
    service.import(binding, exportB);
    assert.ok('data' in service.resolve(binding, consumer, replace(service, binding, consumer).frame));
    assert.deepEqual(vault.store.snapshot(), before);
    assert.equal(vault.status.sequence, sequence);
  } finally {
    vault.close();
  }
});
