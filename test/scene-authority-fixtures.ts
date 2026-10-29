import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Epoch, Evidence, SourceRef } from '../src/contracts.ts';
import { SceneAuthorityService } from '../src/scene-authority.ts';
import type { SceneBinding, SceneConsumer } from '../src/scene-authority-types.ts';
import { sceneFixture } from '../src/scene-fixtures.ts';
import type { SceneCatalog, ScenePacket } from '../src/scene.ts';
import { fixture, claim } from './retrieval-fixtures.ts';

export const epoch = ({ id, generation, consentRevision }: Epoch): Epoch => ({ id, generation, consentRevision });
export function scene(scope: Epoch, root: SourceRef, mode: Evidence['mode'] = 'self_report') {
  const f = JSON.parse(
    JSON.stringify(sceneFixture()).replaceAll('"id":"observation"', '"id":' + JSON.stringify(root.id)),
  ) as { catalog: SceneCatalog; packet: ScenePacket };
  f.catalog.version = 2;
  f.packet.version = 2;
  f.packet.scopeRef = scope.id;
  f.packet.epoch = { generation: scope.generation, consentRevision: scope.consentRevision };
  for (const source of f.catalog.declaredSources) {
    source.scopeRef = scope.id;
    source.epoch = { ...f.packet.epoch };
    source.ref.revision = root.revision;
    source.kind = mode === 'observation' ? 'observation' : 'report';
  }
  for (const claim of f.packet.claims) claim.origin = mode === 'observation' ? 'observation' : 'report';
  return f;
}
export function ready(t: TestContext, mode: Evidence['mode'] = 'self_report') {
  const f = fixture(t),
    root = f.event('one', { mode }),
    memory = f.memory(
      [root],
      mode === 'self_report'
        ? claim
        : mode === 'observation'
          ? { ...claim, basis: 'observation' }
          : { ...claim, kind: 'belief', basis: 'inference', validTo: 200_000 },
    ),
    declarations = scene(f.scope, root, mode);
  const service = new SceneAuthorityService(f.store),
    input = { epoch: epoch(f.scope), publishedRefs: [memory], catalogJson: JSON.stringify(declarations.catalog) };
  const binding = service.bind(input);
  service.stage(binding, JSON.stringify(declarations.packet));
  return { ...f, ...declarations, publish: f.memory, root, memory, service, binding, input };
}
export function reset(service: SceneAuthorityService, binding: SceneBinding, consumer: SceneConsumer) {
  const offered = service.pull(binding, consumer);
  assert.ok(offered);
  assert.equal(offered.info.operation, 'reset');
  assert.deepEqual(Object.keys(service.resolve(binding, consumer, offered.frame)), ['info']);
  service.acknowledge(binding, consumer, offered.frame);
  return offered;
}
export function replace(service: SceneAuthorityService, binding: SceneBinding, consumer: SceneConsumer) {
  const offered = service.pull(binding, consumer);
  assert.ok(offered);
  assert.equal(offered.info.operation, 'replace');
  return offered;
}
