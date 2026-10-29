import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SceneContract, type SceneCatalog, type ScenePacket, type SceneClaim } from '../src/scene.ts';
import { sceneFixture } from '../src/scene-fixtures.ts';
import { normalizeSceneJson, parseSceneJson } from '../src/scene-json.ts';

const json = JSON.stringify;
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
function ready() {
  const f = sceneFixture();
  return { ...f, contract: new SceneContract(json(f.catalog)) };
}
function packetReject(change: (packet: ScenePacket) => void, expected: string) {
  const f = ready();
  change(f.packet);
  assert.throws(() => f.contract.read(json(f.packet)), code(expected));
}
function catalogReject(change: (catalog: SceneCatalog) => void, expected: string) {
  const f = sceneFixture();
  change(f.catalog);
  assert.throws(() => new SceneContract(json(f.catalog)), code(expected));
}
function minimal() {
  const f = sceneFixture();
  f.packet.objects = [];
  f.packet.claims = [];
  f.packet.tracks = [];
  f.packet.relations = [];
  f.packet.anchors = [];
  f.packet.residuals = [];
  f.packet.geometry = { kind: 'unknown' };
  return f;
}
function typedClaim(id: string, subject: string): SceneClaim {
  return {
    id,
    revision: 1,
    kind: 'classification',
    subject,
    predicate: null,
    value: { kind: 'unknown', reason: 'not_observed' },
    origin: 'observation',
    verification: 'not_verified',
    sourceRefs: [{ id: 'observation', revision: 1 }],
    occurredAt: null,
  };
}

test('typed facts preserve directed roles and attribute ownership independently of array order', () => {
  const f = ready();
  f.packet.objects.reverse();
  const result = f.contract.read(json(f.packet));
  assert.equal(result.assurance, 'NOT_AUTHENTICATED');
  assert.equal(result.packet.claims.find((q) => q.id === 'color-A')!.subject, 'cup-A');
  assert.deepEqual(result.packet.claims.find((q) => q.id === 'color-A')!.value, { kind: 'text', text: 'red' });
  assert.equal(result.packet.claims.find((q) => q.id === 'relation-A')!.subject, 'cup-A');
  assert.deepEqual(result.packet.claims.find((q) => q.id === 'relation-A')!.value, {
    kind: 'object',
    objectId: 'plate-B',
  });
  packetReject((p) => {
    p.objects[0]!.attributeClaims[0] = { id: 'color-B', revision: 1 };
  }, 'SCENE_BINDING_MISMATCH');
  packetReject((p) => {
    p.objects[0]!.typeClaim = { id: 'type-B', revision: 1 };
  }, 'SCENE_BINDING_MISMATCH');
  packetReject((p) => {
    p.relations[0]!.claimRef = { id: 'color-A', revision: 1 };
  }, 'SCENE_BINDING_MISMATCH');
  packetReject((p) => {
    p.claims[6]!.value = { kind: 'object', objectId: 'missing' };
  }, 'SCENE_REF_MISMATCH');
});
test('stable concept revisions retain old definitions and labels, with no label-based resolution', () => {
  const f = ready(),
    result = f.contract.read(json(f.packet));
  const old = result.catalog.concepts.find((c) => c.ref.id === 'cup' && c.ref.revision === 1)!;
  assert.equal(old.status, 'retired');
  assert.equal(old.labels[0]!.text, 'cup');
  assert.deepEqual(result.packet.claims[0]!.value, {
    kind: 'concept',
    conceptRef: { namespace: 'synthetic', id: 'cup', revision: 1 },
  });
  packetReject((p) => {
    p.claims[0]!.value = { kind: 'concept', conceptRef: { namespace: 'synthetic', id: 'cup', revision: 3 } };
  }, 'SCENE_REF_MISMATCH');
  catalogReject((c) => {
    c.concepts.push(structuredClone(c.concepts[0]!));
  }, 'SCENE_DUPLICATE_REF');
  catalogReject((c) => {
    c.concepts[0]!.labels.push({ language: 'en', text: 'alias' });
  }, 'SCENE_DUPLICATE_REF');
});
test('catalog is fixed at construction and output copies cannot mutate later reads', () => {
  const f = ready();
  f.catalog.concepts[0]!.labels[0]!.text = 'mutated';
  const first = f.contract.read(json(f.packet));
  assert.equal(first.catalog.concepts[0]!.labels[0]!.text, 'cup');
  for (const value of [
    first,
    first.packet,
    first.packet.claims,
    first.packet.claims[0],
    first.packet.claims[0]!.value,
    first.catalog.concepts[0]!.labels,
  ])
    assert.equal(Object.isFrozen(value), true);
  assert.equal(Reflect.set(first.packet.claims[0]!.value, 'kind', 'unknown'), false);
  const second = f.contract.read(json(f.packet));
  assert.deepEqual(second, first);
  assert.notEqual(second.packet, first.packet);
});
test('all public entrypoints reject objects and proxies without invoking caller hooks', () => {
  const f = ready();
  let calls = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        calls++;
        throw new Error('CALLER_SECRET');
      },
      ownKeys() {
        calls++;
        throw new Error('CALLER_SECRET');
      },
    },
  );
  for (const run of [
    () => new SceneContract(proxy as never),
    () => f.contract.read(proxy as never),
    () => f.contract.export(proxy as never),
    () => f.contract.import(proxy as never),
  ])
    assert.throws(run, code('SCENE_INVALID_JSON'));
  assert.equal(calls, 0);
});
test('source scope, epoch, exact revision and origin are consistency declarations only', () => {
  packetReject((p) => {
    p.scopeRef = 'another-scope';
  }, 'SCENE_SOURCE_MISMATCH');
  packetReject((p) => {
    p.epoch.generation++;
  }, 'SCENE_SOURCE_MISMATCH');
  packetReject((p) => {
    p.epoch.consentRevision++;
  }, 'SCENE_SOURCE_MISMATCH');
  packetReject((p) => {
    p.sourceRefs[0]!.revision++;
  }, 'SCENE_REF_MISMATCH');
  packetReject((p) => {
    p.claims[0]!.sourceRefs = [];
  }, 'SCENE_INVALID_INPUT');
  packetReject((p) => {
    p.claims[0]!.origin = 'report';
  }, 'SCENE_SOURCE_MISMATCH');
  packetReject((p) => {
    p.anchors[0]!.sourceRef = { id: 'unsupported', revision: 1 };
  }, 'SCENE_SOURCE_MISMATCH');
  const f = ready();
  f.packet.claims[0]!.origin = 'inference';
  f.packet.recordedAt = 1;
  f.packet.occurredAt = 999_999;
  f.packet.applicability = { from: 999_999, to: 1_000_000 };
  assert.equal(f.contract.read(json(f.packet)).assurance, 'NOT_AUTHENTICATED');
});
test('self-declared verification, source permissions, unknown fields and hidden facts are rejected', () => {
  packetReject((p) => {
    (p.claims[0] as unknown as Record<string, unknown>).verification = 'independently_verified';
  }, 'SCENE_INVALID_INPUT');
  packetReject((p) => {
    (p as unknown as Record<string, unknown>).authorized = true;
  }, 'SCENE_INVALID_INPUT');
  packetReject((p) => {
    (p.objects[0] as unknown as Record<string, unknown>).color = 'secret';
  }, 'SCENE_INVALID_INPUT');
  packetReject((p) => {
    p.claims.push({ ...p.claims[2]!, id: 'unbound' });
  }, 'SCENE_BINDING_MISMATCH');
  packetReject((p) => {
    p.objects[0]!.attributeClaims.push({ id: 'color-A', revision: 1 });
  }, 'SCENE_DUPLICATE_REF');
  catalogReject((c) => {
    (c.declaredSources[0] as unknown as Record<string, unknown>).authorized = true;
  }, 'SCENE_INVALID_INPUT');
  const f = ready();
  f.packet.claims[2]!.value = { kind: 'text', text: 'possibly false declaration' };
  assert.equal(f.contract.read(json(f.packet)).assurance, 'NOT_AUTHENTICATED');
});
test('track identity includes device and stream epoch, and never fills real entity identity', () => {
  packetReject((p) => {
    p.objects[0]!.trackRef!.streamEpoch++;
  }, 'SCENE_REF_MISMATCH');
  packetReject((p) => {
    p.objects[0]!.trackRef!.device = 'another-device';
  }, 'SCENE_REF_MISMATCH');
  packetReject((p) => {
    p.objects[0]!.trackRef!.rev++;
  }, 'SCENE_REF_MISMATCH');
  packetReject((p) => {
    p.claims[4]!.value = { kind: 'entity', scopeRef: 'other', ref: { id: 'entity', revision: 1 } };
  }, 'SCENE_SOURCE_MISMATCH');
  const f = ready(),
    result = f.contract.read(json(f.packet));
  assert.deepEqual(result.packet.claims[4]!.value, { kind: 'unknown', reason: 'not_observed' });
});
test('unknown attributes and times stay unknown, with no prototype or geometry zero-fill', () => {
  const f = ready();
  f.packet.claims[2]!.value = { kind: 'unknown', reason: 'withheld' };
  f.packet.claims[5]!.value = { kind: 'unknown', reason: 'not_observed' };
  f.packet.geometry = { kind: 'unknown' };
  const result = f.contract.read(json(f.packet));
  assert.equal(result.packet.occurredAt, null);
  assert.deepEqual(result.packet.claims[2]!.value, { kind: 'unknown', reason: 'withheld' });
  assert.deepEqual(result.packet.geometry, { kind: 'unknown' });
  packetReject((p) => {
    p.claims[2]!.value = { kind: 'unknown', reason: 'withheld', number: 0 } as never;
  }, 'SCENE_INVALID_INPUT');
  packetReject((p) => {
    p.claims[2]!.value = { kind: 'number', number: 3, unit: '' };
  }, 'SCENE_INVALID_INPUT');
});
test('pixel2D requires explicit image frame, units and bounds; 3D is unsupported', () => {
  packetReject((p) => {
    p.geometry = { kind: 'unknown' };
  }, 'SCENE_GEOMETRY_MISMATCH');
  packetReject((p) => {
    p.geometry = { kind: 'calibrated3D' } as never;
  }, 'SCENE_UNSUPPORTED_GEOMETRY');
  packetReject((p) => {
    (p.geometry as unknown as Record<string, unknown>).units = 'metre';
  }, 'SCENE_INVALID_INPUT');
  packetReject((p) => {
    (p.geometry as unknown as Record<string, unknown>).rotation = [0, 0, 0];
  }, 'SCENE_INVALID_INPUT');
  packetReject((p) => {
    p.claims[5]!.value = { kind: 'pixel2D', x: 639, y: 0, width: 2, height: 1 };
  }, 'SCENE_GEOMETRY_MISMATCH');
  packetReject((p) => {
    p.claims[5]!.value = { kind: 'pixel2D', x: -1, y: 0, width: 1, height: 1 };
  }, 'SCENE_INVALID_INPUT');
});
test('opaque residuals bind exact profile, prototype, concept, decoder and quantizer revisions', () => {
  packetReject((p) => {
    p.residuals[0]!.profileRef = { id: 'profile', revision: 2 };
  }, 'SCENE_REF_MISMATCH');
  packetReject((p) => {
    p.residuals[0]!.decoderRef = { id: 'decoder', revision: 2 };
  }, 'SCENE_PROFILE_MISMATCH');
  packetReject((p) => {
    p.residuals[0]!.quantizerRef = { id: 'quantizer', revision: 2 };
  }, 'SCENE_PROFILE_MISMATCH');
  packetReject((p) => {
    p.residuals[0]!.objectId = 'plate-B';
    p.residuals[0]!.claimRefs = [{ id: 'color-B', revision: 1 }];
  }, 'SCENE_PROFILE_MISMATCH');
  packetReject((p) => {
    p.residuals[0]!.claimRefs = [{ id: 'color-B', revision: 1 }];
  }, 'SCENE_BINDING_MISMATCH');
  packetReject((p) => {
    (p.residuals[0] as unknown as Record<string, unknown>).codes = [0, 1];
  }, 'SCENE_INVALID_INPUT');
  catalogReject((c) => {
    c.prototypes[0]!.dictionaryRef = { id: 'dictionary', revision: 2 };
  }, 'SCENE_PROFILE_MISMATCH');
  catalogReject((c) => {
    c.prototypes[0]!.decoderRef = { id: 'decoder', revision: 2 };
  }, 'SCENE_PROFILE_MISMATCH');
  catalogReject((c) => {
    delete (c.mappingProfiles[0] as unknown as Record<string, unknown>).checkpointRef;
  }, 'SCENE_INVALID_INPUT');
  catalogReject((c) => {
    c.mappingProfiles[0]!.dimension = 0;
  }, 'SCENE_INVALID_INPUT');
});
test('used residual profile lineage must belong to packet sources with the same declared scope and epoch', () => {
  for (const lineage of ['trainingLineage', 'calibrationLineage'] as const) {
    for (const mismatch of ['scope', 'epoch', 'omitted'] as const) {
      const f = sceneFixture(),
        source = {
          ref: { id: 'other-source', revision: 1 },
          scopeRef: f.packet.scopeRef,
          epoch: { ...f.packet.epoch },
          kind: 'observation' as const,
        };
      if (mismatch === 'scope') source.scopeRef = 'other-scope';
      if (mismatch === 'epoch') source.epoch.generation++;
      f.catalog.declaredSources.push(source);
      f.catalog.mappingProfiles[0]![lineage] = [source.ref];
      const contract = new SceneContract(json(f.catalog));
      assert.throws(() => contract.read(json(f.packet)), code('SCENE_SOURCE_MISMATCH'));
      // An unused catalog profile does not silently become this packet's source.
      f.packet.residuals = [];
      assert.equal(contract.read(json(f.packet)).assurance, 'NOT_AUTHENTICATED');
    }
    const f = sceneFixture(),
      source = {
        ref: { id: 'same-source', revision: 1 },
        scopeRef: f.packet.scopeRef,
        epoch: { ...f.packet.epoch },
        kind: 'observation' as const,
      };
    f.catalog.declaredSources.push(source);
    f.catalog.mappingProfiles[0]![lineage] = [source.ref];
    f.packet.sourceRefs.push(source.ref);
    assert.equal(new SceneContract(json(f.catalog)).read(json(f.packet)).assurance, 'NOT_AUTHENTICATED');
    source.epoch.consentRevision++;
    assert.throws(() => new SceneContract(json(f.catalog)).read(json(f.packet)), code('SCENE_SOURCE_MISMATCH'));
  }
});
test('pixel2D claims bind their own frame source, without implicit same-scope cross-frame transforms', () => {
  for (const origin of ['observation', 'report', 'inference'] as const) {
    const f = sceneFixture(),
      kind = origin === 'report' ? 'report' : 'observation';
    f.catalog.declaredSources[0]!.kind = kind;
    for (const q of f.packet.claims) q.origin = origin;
    const other: SceneCatalog['declaredSources'][number] = {
      ref: { id: 'frame-B', revision: 1 },
      scopeRef: f.packet.scopeRef,
      epoch: { ...f.packet.epoch },
      kind,
    };
    f.catalog.declaredSources.push(other);
    f.packet.sourceRefs.push(other.ref);
    if (f.packet.geometry.kind !== 'pixel2D') assert.fail('fixture');
    f.packet.geometry.frameRef = other.ref;
    const contract = new SceneContract(json(f.catalog));
    assert.throws(() => contract.read(json(f.packet)), code('SCENE_SOURCE_MISMATCH'));
    f.packet.claims[5]!.sourceRefs.push(other.ref);
    assert.doesNotThrow(() => contract.read(json(f.packet)));
    f.packet.claims[5]!.sourceRefs = [{ id: 'observation', revision: 1 }];
    f.packet.claims[5]!.value = { kind: 'unknown', reason: 'not_observed' };
    assert.doesNotThrow(() => contract.read(json(f.packet)));
  }
});
test('pixel bounds cannot hide a positive subnormal overrun in either operand or axis', () => {
  for (const value of [
    { x: 640, y: 0, width: 5e-324, height: 1 },
    { x: 5e-324, y: 0, width: 640, height: 1 },
    { x: 0, y: 480, width: 1, height: 5e-324 },
    { x: 0, y: 5e-324, width: 1, height: 480 },
  ])
    packetReject((p) => {
      p.claims[5]!.value = { kind: 'pixel2D', ...value };
    }, 'SCENE_GEOMETRY_MISMATCH');
  const f = ready();
  f.packet.claims[5]!.value = { kind: 'pixel2D', x: 640, y: 480, width: 0, height: 0 };
  assert.doesNotThrow(() => f.contract.read(json(f.packet)));
});
test('object 32/33 and anchor 32/33 bounds are distinct from aggregate JSON limits', () => {
  const f = minimal();
  for (let i = 0; i < 32; i++) {
    const id = 'o' + i;
    f.packet.claims.push(typedClaim('c' + i, id));
    f.packet.objects.push({
      id,
      typeClaim: { id: 'c' + i, revision: 1 },
      trackRef: null,
      identityClaim: null,
      attributeClaims: [],
    });
  }
  const contract = new SceneContract(json(f.catalog));
  assert.equal(contract.read(json(f.packet)).packet.objects.length, 32);
  f.packet.objects.push({ ...f.packet.objects[0]!, id: 'extra' });
  assert.throws(() => contract.read(json(f.packet)), code('SCENE_LIMIT'));
  const a = ready();
  a.packet.anchors = Array.from({ length: 32 }, (_, i) => ({ ...a.packet.anchors[0]!, id: 'a' + i }));
  assert.equal(a.contract.read(json(a.packet)).packet.anchors.length, 32);
  a.packet.anchors.push({ ...a.packet.anchors[0]!, id: 'extra' });
  assert.throws(() => a.contract.read(json(a.packet)), code('SCENE_LIMIT'));
});
test('relation 64/65 bound allows directed cycles, independent of provenance DAG rules', () => {
  const f = minimal();
  f.catalog.mappingProfiles = [];
  f.catalog.prototypes = [];
  f.packet.objects = [
    { id: 'o', typeClaim: { id: 'c', revision: 1 }, trackRef: null, identityClaim: null, attributeClaims: [] },
  ];
  f.packet.claims = [typedClaim('c', 'o')];
  for (let i = 0; i < 64; i++) {
    f.packet.claims.push({
      ...typedClaim('r' + i, 'o'),
      kind: 'relation',
      predicate: { namespace: 'synthetic', id: 'left-of', revision: 1 },
      value: { kind: 'object', objectId: 'o' },
    });
    f.packet.relations.push({ id: 'relation' + i, claimRef: { id: 'r' + i, revision: 1 } });
  }
  const contract = new SceneContract(json(f.catalog));
  assert.equal(contract.read(json(f.packet)).packet.relations.length, 64);
  f.packet.relations.push({ id: 'extra', claimRef: { id: 'r0', revision: 1 } });
  assert.throws(() => contract.read(json(f.packet)), code('SCENE_LIMIT'));
});
test('empty scenes are valid declarations but still require versions, catalog consistency and closed fields', () => {
  const f = minimal();
  f.packet.sourceRefs = [];
  const contract = new SceneContract(json(f.catalog));
  assert.equal(contract.read(json(f.packet)).assurance, 'NOT_AUTHENTICATED');
  f.packet.version = 2 as never;
  assert.throws(() => contract.read(json(f.packet)), code('SCENE_UNSUPPORTED_VERSION'));
  catalogReject((c) => {
    c.version = 2 as never;
  }, 'SCENE_UNSUPPORTED_VERSION');
});
test('read budgets the full export envelope rather than accepting separately small catalog and packet', () => {
  const f = ready();
  // Each independently bounded input fits, but combined decoded strings exceed 32768.
  for (let i = 0; i < 12; i++)
    f.catalog.concepts.push({
      ref: { namespace: 'padding', id: 'c' + i, revision: 1 },
      kind: 'value',
      definition: 'x'.repeat(2048),
      labels: [{ language: 'en', text: 'x' }],
      status: 'active',
    });
  const contract = new SceneContract(json(f.catalog));
  f.packet.claims[2]!.value = { kind: 'text', text: 'x'.repeat(2048) };
  f.packet.claims[3]!.value = { kind: 'text', text: 'x'.repeat(2048) };
  assert.doesNotThrow(() => parseSceneJson(json(f.packet)));
  assert.throws(() => contract.read(json(f.packet)), code('SCENE_LIMIT'));
  assert.throws(() => contract.export(json(f.packet)), code('SCENE_LIMIT'));
});
test('full SF0 envelope accepts exactly 65536 UTF-8 bytes and rejects one more, including manifest cost', () => {
  const f = minimal();
  f.packet.sourceRefs = [];
  f.catalog = {
    version: 1,
    concepts: Array.from({ length: 20 }, (_, i) => ({
      ref: { namespace: 'synthetic', id: 'c' + i, revision: 1 },
      kind: 'value',
      definition: '杯'.repeat(1000),
      labels: [{ language: 'en', text: 'x' }],
      status: 'active',
    })),
    mappingProfiles: [],
    prototypes: [],
    declaredSources: [],
  };
  const base = new SceneContract(json(f.catalog)).export(json(f.packet));
  const remaining = 65_536 - Buffer.byteLength(base);
  f.catalog.concepts[0]!.definition += '杯'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  const contract = new SceneContract(json(f.catalog)),
    encoded = contract.export(json(f.packet));
  assert.equal(Buffer.byteLength(encoded), 65_536);
  assert.deepEqual(contract.import(encoded), contract.read(json(f.packet)));
  f.catalog.concepts[0]!.definition += 'x';
  assert.doesNotThrow(() => parseSceneJson(json(f.catalog)));
  const over = new SceneContract(json(f.catalog));
  assert.throws(() => over.read(json(f.packet)), code('SCENE_LIMIT'));
});
test('combined catalog and packet node budget is enforced even when both inputs and their bytes fit', () => {
  const f = minimal();
  while (f.catalog.concepts.length < 128)
    f.catalog.concepts.push({
      ref: { namespace: 'padding', id: 'c' + f.catalog.concepts.length, revision: 1 },
      kind: 'value',
      definition: 'x',
      labels: [{ language: 'en', text: 'x' }],
      status: 'active',
    });
  for (let i = 0; i < 32; i++) {
    const id = 'o' + i;
    f.packet.claims.push(typedClaim('c' + i, id));
    f.packet.objects.push({
      id,
      typeClaim: { id: 'c' + i, revision: 1 },
      trackRef: null,
      identityClaim: null,
      attributeClaims: [],
    });
  }
  assert.doesNotThrow(() => parseSceneJson(json(f.catalog)));
  assert.doesNotThrow(() => parseSceneJson(json(f.packet)));
  assert.ok(Buffer.byteLength(json({ catalog: f.catalog, packet: f.packet })) + 500 < 65_536);
  const contract = new SceneContract(json(f.catalog));
  assert.throws(() => contract.read(json(f.packet)), code('SCENE_LIMIT'));
});
test('self-contained exchange preserves every field and recomputes canonical payload integrity', () => {
  const f = ready(),
    input = json(f.packet),
    expected = f.contract.read(input),
    encoded = f.contract.export(input);
  assert.deepEqual(f.contract.import(encoded), expected);
  const envelope = JSON.parse(encoded) as {
    manifest: { payloadBytes: number; payloadSha256: string };
    payload: unknown;
  };
  const payload = normalizeSceneJson(json(envelope.payload));
  assert.equal(Buffer.byteLength(payload), envelope.manifest.payloadBytes);
  assert.equal(createHash('sha256').update(payload).digest('hex'), envelope.manifest.payloadSha256);
  assert.deepEqual(f.contract.import(JSON.stringify(envelope, null, 2)), expected);
  assert.equal(f.contract.export(json(f.contract.import(encoded).packet)), encoded);
});
test('exchange rejects corruption, missing dependencies, length/hash tampering and every unsupported version', () => {
  const f = ready(),
    encoded = f.contract.export(json(f.packet));
  const envelope = () =>
    JSON.parse(encoded) as {
      manifest: Record<string, unknown>;
      payload: { catalog: SceneCatalog; packet: ScenePacket };
    };
  let e = envelope();
  e.payload.packet.claims[2]!.value = { kind: 'text', text: 'tampered' };
  assert.throws(() => f.contract.import(json(e)), code('SCENE_INTEGRITY_MISMATCH'));
  e = envelope();
  e.manifest.payloadBytes = 1;
  assert.throws(() => f.contract.import(json(e)), code('SCENE_INTEGRITY_MISMATCH'));
  e = envelope();
  e.manifest.payloadSha256 = '0'.repeat(64);
  assert.throws(() => f.contract.import(json(e)), code('SCENE_INTEGRITY_MISMATCH'));
  for (const field of ['logicalSchemaVersion', 'containerProfile', 'codecProfile', 'canonicalization', 'integrity']) {
    e = envelope();
    e.manifest[field] = 'unsupported';
    assert.throws(() => f.contract.import(json(e)), code('SCENE_UNSUPPORTED_VERSION'));
  }
  e = envelope();
  e.manifest.path = 'file:///not-read';
  assert.throws(() => f.contract.import(json(e)), code('SCENE_INVALID_INPUT'));
  assert.throws(() => f.contract.import(encoded.slice(0, -1)), code('SCENE_INVALID_JSON'));
});
test('valid integrity does not authorize a changed embedded catalog under an existing instance', () => {
  const f = ready();
  f.catalog.concepts[0]!.labels[0]!.text = 'same revision changed definition';
  const other = new SceneContract(json(f.catalog)),
    encoded = other.export(json(f.packet));
  assert.throws(() => f.contract.import(encoded), code('SCENE_CATALOG_MISMATCH'));
  assert.equal(other.import(encoded).assurance, 'NOT_AUTHENTICATED');
});
test('a recomputed valid digest never bypasses packet binding validation during import', () => {
  const f = ready(),
    envelope = JSON.parse(f.contract.export(json(f.packet))) as {
      manifest: { payloadBytes: number; payloadSha256: string };
      payload: { catalog: SceneCatalog; packet: ScenePacket };
    };
  envelope.payload.packet.claims[2]!.subject = 'plate-B';
  const payload = normalizeSceneJson(json(envelope.payload));
  envelope.manifest.payloadBytes = Buffer.byteLength(payload);
  envelope.manifest.payloadSha256 = createHash('sha256').update(payload).digest('hex');
  assert.throws(() => f.contract.import(json(envelope)), code('SCENE_BINDING_MISMATCH'));
});
test('all failure diagnostics are fixed codes without user text or opaque source references', () => {
  const f = ready();
  const text = '{ "secret-private-fragment": "😀", "version": 1 }';
  try {
    f.contract.read(text);
    assert.fail('expected failure');
  } catch (error) {
    assert.equal((error as Error).message, 'SCENE_INVALID_INPUT');
  }
  assert.throws(() => f.contract.read('{"version":1,"\\u0076ersion":1}'), code('SCENE_DUPLICATE_KEY'));
});
