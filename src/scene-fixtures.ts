import type { ConceptRef, MappingProfile, SceneCatalog, SceneClaim, ScenePacket, SceneRef } from './scene.ts';

/** Entirely synthetic, fresh mutable fixture copies; no paths, model assets or real source authority. */
export function sceneFixture(): { catalog: SceneCatalog; packet: ScenePacket } {
  const ref = (id: string, revision = 1): SceneRef => ({ id, revision });
  const concept = (id: string, revision = 1): ConceptRef => ({ namespace: 'synthetic', id, revision });
  const source = ref('observation'),
    scopeRef = 'synthetic-scope',
    epoch = { generation: 1, consentRevision: 1 };
  const profile: MappingProfile = {
    ref: ref('profile'),
    modelRef: ref('model'),
    checkpointRef: ref('checkpoint'),
    layer: 'synthetic-layer',
    activationKind: 'synthetic-activation',
    preprocessRef: ref('preprocess'),
    tokenizerRef: ref('tokenizer'),
    pooling: 'none',
    dtype: 'float32',
    normalization: 'none',
    encoderRef: ref('encoder'),
    saeDictionaryRef: null,
    prototypeDictionaryRef: ref('dictionary'),
    decoderRef: ref('decoder'),
    quantizerRef: ref('quantizer'),
    latentSpace: 'synthetic-space',
    dimension: 4,
    alignmentRef: null,
    trainingLineage: [source],
    calibrationLineage: [],
  };
  const catalog: SceneCatalog = {
    version: 1,
    concepts: [
      {
        ref: concept('cup'),
        kind: 'object_type',
        definition: 'Synthetic cup definition revision one.',
        labels: [
          { language: 'en', text: 'cup' },
          { language: 'zh', text: '杯' },
        ],
        status: 'retired',
      },
      {
        ref: concept('cup', 2),
        kind: 'object_type',
        definition: 'Different revision retained alongside the original.',
        labels: [{ language: 'en', text: 'new cup label' }],
        status: 'active',
      },
      {
        ref: concept('plate'),
        kind: 'object_type',
        definition: 'Synthetic plate.',
        labels: [{ language: 'en', text: 'plate' }],
        status: 'active',
      },
      {
        ref: concept('color'),
        kind: 'attribute',
        definition: 'Declared visible color.',
        labels: [{ language: 'en', text: 'color' }],
        status: 'active',
      },
      {
        ref: concept('box'),
        kind: 'attribute',
        definition: 'Declared image bounding box.',
        labels: [{ language: 'en', text: 'box' }],
        status: 'active',
      },
      {
        ref: concept('left-of'),
        kind: 'relation',
        definition: 'Directed subject to object relation.',
        labels: [{ language: 'en', text: 'left of' }],
        status: 'active',
      },
    ],
    mappingProfiles: [profile],
    prototypes: [
      {
        ref: ref('prototype'),
        conceptRef: concept('cup'),
        profileRef: profile.ref,
        dictionaryRef: profile.prototypeDictionaryRef,
        decoderRef: profile.decoderRef,
        quantizerRef: profile.quantizerRef,
      },
    ],
    declaredSources: [{ ref: source, scopeRef, epoch, kind: 'observation' }],
  };
  const claim = (
    id: string,
    subject: string,
    kind: SceneClaim['kind'],
    value: SceneClaim['value'],
    predicate: ConceptRef | null = null,
  ): SceneClaim => ({
    id,
    revision: 1,
    subject,
    kind,
    value,
    predicate,
    origin: 'observation',
    verification: 'not_verified',
    sourceRefs: [source],
    occurredAt: null,
  });
  const track = { device: 'synthetic-camera', streamEpoch: 1, localTrackId: 'track-1', rev: 1 };
  const packet: ScenePacket = {
    version: 1,
    ref: ref('scene'),
    scopeRef,
    epoch,
    occurredAt: null,
    recordedAt: 10,
    applicability: { from: null, to: null },
    sourceRefs: [source],
    tracks: [{ ...track, sourceRef: source }],
    objects: [
      {
        id: 'cup-A',
        typeClaim: ref('type-A'),
        trackRef: track,
        identityClaim: ref('identity-A'),
        attributeClaims: [ref('color-A'), ref('box-A')],
      },
      {
        id: 'plate-B',
        typeClaim: ref('type-B'),
        trackRef: null,
        identityClaim: null,
        attributeClaims: [ref('color-B')],
      },
    ],
    claims: [
      claim('type-A', 'cup-A', 'classification', { kind: 'concept', conceptRef: concept('cup') }),
      claim('type-B', 'plate-B', 'classification', { kind: 'concept', conceptRef: concept('plate') }),
      claim('color-A', 'cup-A', 'attribute', { kind: 'text', text: 'red' }, concept('color')),
      claim('color-B', 'plate-B', 'attribute', { kind: 'text', text: 'blue' }, concept('color')),
      claim('identity-A', 'cup-A', 'identity', { kind: 'unknown', reason: 'not_observed' }),
      claim('box-A', 'cup-A', 'attribute', { kind: 'pixel2D', x: 12, y: 24, width: 20, height: 30 }, concept('box')),
      claim('relation-A', 'cup-A', 'relation', { kind: 'object', objectId: 'plate-B' }, concept('left-of')),
    ],
    relations: [{ id: 'left-relation', claimRef: ref('relation-A') }],
    anchors: [
      {
        id: 'anchor-color',
        claimRef: ref('color-A'),
        sourceRef: source,
        selector: { kind: 'opaque', ref: 'synthetic-fragment' },
      },
    ],
    geometry: {
      kind: 'pixel2D',
      frameRef: source,
      width: 640,
      height: 480,
      units: 'pixel',
      origin: 'top_left',
      xAxis: 'right',
      yAxis: 'down',
    },
    residuals: [
      {
        id: 'residual-A',
        objectId: 'cup-A',
        claimRefs: [ref('color-A')],
        profileRef: profile.ref,
        prototypeRef: ref('prototype'),
        decoderRef: profile.decoderRef,
        quantizerRef: profile.quantizerRef,
        opaqueRef: 'synthetic-residual',
      },
    ],
  };
  return { catalog, packet };
}
