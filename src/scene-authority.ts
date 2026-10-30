import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { Epoch, SourceRef } from './contracts.ts';
import { canonical, frozenCopy, type Frozen } from './curation-types.ts';
import { SceneContract, type SceneRead } from './scene.ts';
import { normalizeSceneJson } from './scene-json.ts';
import { SCENE_SOURCE_LIMITS, SCENE_CONSUMER_LIMIT } from './scene-authority-types.ts';
import type {
  SceneSourceSnapshot,
  SceneBinding,
  SceneConsumer,
  SceneFrame,
  SceneFrameInfo,
  SceneAuthorizedRead,
} from './scene-authority-types.ts';
import { MemoryStore } from './store.ts';
import { fail, object, text, refs } from './validation.ts';

type Input = { epoch: Epoch; publishedRefs: SourceRef[]; catalogJson: string };
type FrameState = { client: Client; info: SceneFrameInfo };
type Client = {
  bound: Bound;
  resetAck: number;
  appliedRevision: number;
  pending: SceneFrame | null;
  lastAck: SceneFrame | null;
};
type Bound = {
  epoch: Frozen<Epoch>;
  refs: Frozen<SourceRef[]>;
  contract: SceneContract;
  identity: string;
  authority: SceneSourceSnapshot['authority'];
  lastAsOf: number;
  status: 'active' | 'paused' | 'terminated' | 'unbound';
  barrier: number;
  needsClear: boolean;
  revision: number;
  packetId: string | null;
  packetRevision: number;
  digest: string | null;
  payload: SceneRead | null;
  clients: Set<Client>;
};
const sourceKey = (ref: Frozen<SourceRef>) => canonical(ref);

/** Trusted control inputs are copied before any current-authority read. */
function closed(value: unknown, names: string[]): Record<string, unknown> {
  if (types.isProxy(value)) fail('INVALID_INPUT');
  object(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== 'string' || !names.includes(key)) ||
    names.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))
  )
    fail('INVALID_INPUT');
  return Object.fromEntries(names.map((key) => [key, descriptors[key]!.value]));
}
function copiedInput(value: Input) {
  const input = closed(value, ['epoch', 'publishedRefs', 'catalogJson']),
    epoch = closed(input.epoch, ['id', 'generation', 'consentRevision']);
  text(epoch.id, 128);
  for (const key of ['generation', 'consentRevision'])
    if (!Number.isSafeInteger(epoch[key]) || (epoch[key] as number) < 0) fail('INVALID_INPUT');
  const raw = input.publishedRefs;
  if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    fail('INVALID_INPUT');
  const length = Object.getOwnPropertyDescriptor(raw, 'length')!.value as number;
  if (length > SCENE_SOURCE_LIMITS.selected) fail('SCENE_SOURCE_LIMIT');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== length + 1) fail('INVALID_INPUT');
  const selected: SourceRef[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
    const ref = closed(descriptor.value, ['id', 'revision']);
    text(ref.id, 128);
    if (!Number.isSafeInteger(ref.revision) || (ref.revision as number) < 1) fail('INVALID_INPUT');
    selected.push({ id: ref.id, revision: ref.revision as number });
  }
  if (typeof input.catalogJson !== 'string') fail('SCENE_INVALID_JSON');
  return {
    epoch: frozenCopy({
      id: epoch.id,
      generation: epoch.generation as number,
      consentRevision: epoch.consentRevision as number,
    }),
    refs: frozenCopy(selected.length ? refs(selected) : []),
    contract: new SceneContract(input.catalogJson, 2),
  };
}
function validateCatalog(contract: SceneContract, snapshot: SceneSourceSnapshot): void {
  const roots = new Map(snapshot.roots.map((root) => [sourceKey(root.ref), root]));
  for (const source of contract.catalog.declaredSources) {
    const root = roots.get(sourceKey(source.ref));
    if (
      !root ||
      source.scopeRef !== snapshot.authority.id ||
      source.epoch.generation !== snapshot.authority.generation ||
      source.epoch.consentRevision !== snapshot.authority.consentRevision
    )
      fail('SCENE_SOURCE_MISMATCH');
    if (root.mode === 'inference') fail('SCENE_SOURCE_ORIGIN_UNSUPPORTED');
    const kind = root.mode === 'observation' ? 'observation' : 'report';
    if (source.kind !== kind) fail('SCENE_SOURCE_MISMATCH');
  }
}

/** Synchronous trusted-local service. No timers, external callbacks, host routes or durable ACKs. */
export class SceneAuthorityService {
  #store: MemoryStore;
  #bindings = new WeakMap<SceneBinding, Bound>();
  #consumers = new WeakMap<SceneConsumer, Client>();
  #frames = new WeakMap<SceneFrame, FrameState>();
  constructor(store: MemoryStore) {
    this.#store = store;
  }
  bind(input: Input): SceneBinding {
    const copied = copiedInput(input);
    const snapshot = this.#store.sceneSourceSnapshot(
      { ...copied.epoch },
      copied.refs.map((ref) => ({ ...ref })),
    );
    validateCatalog(copied.contract, snapshot);
    const binding: SceneBinding = Object.freeze({ version: 1 });
    this.#bindings.set(binding, {
      ...copied,
      authority: snapshot.authority,
      identity: snapshot.metadataIdentity,
      lastAsOf: snapshot.asOf,
      status: 'active',
      barrier: 1,
      needsClear: false,
      revision: 0,
      packetId: null,
      packetRevision: 0,
      digest: null,
      payload: null,
      clients: new Set(),
    });
    return binding;
  }
  #bound(binding: SceneBinding): Bound {
    const bound = this.#bindings.get(binding);
    if (!bound) fail('UNAUTHENTICATED');
    return bound;
  }
  #client(bound: Bound, consumer: SceneConsumer): Client {
    const client = this.#consumers.get(consumer);
    if (!client || client.bound !== bound) fail('UNAUTHENTICATED');
    return client;
  }
  #forget(client: Client, field: 'pending' | 'lastAck'): void {
    if (client[field]) this.#frames.delete(client[field]!);
    client[field] = null;
  }
  #reset(bound: Bound): void {
    bound.payload = null;
    // Repeated cleanup without intervening staging exposes no new generation.
    // Keep outstanding reset tokens (and completed reset receipts) stable.
    if (!bound.needsClear) return;
    bound.needsClear = false;
    // Counter exhaustion permanently ends data access; existing reset tokens are invalidated.
    if (bound.barrier === Number.MAX_SAFE_INTEGER) bound.status = 'terminated';
    else bound.barrier++;
    for (const client of bound.clients) {
      this.#forget(client, 'pending');
      this.#forget(client, 'lastAck');
      client.resetAck = 0;
      client.appliedRevision = 0;
    }
  }
  #terminate(bound: Bound): void {
    bound.status = 'terminated';
    this.#reset(bound);
  }
  #active(bound: Bound, allowPaused = false): void {
    if (bound.status === 'terminated' || bound.status === 'unbound') fail('SCENE_REBIND_REQUIRED');
    if (bound.status === 'paused' && !allowPaused) fail('SCENE_PAUSED');
  }
  #fresh(bound: Bound, allowPaused = false): SceneSourceSnapshot {
    this.#active(bound, allowPaused);
    try {
      const snapshot = this.#store.sceneSourceSnapshot(
        { ...bound.epoch },
        bound.refs.map((ref) => ({ ...ref })),
      );
      if (snapshot.asOf < bound.lastAsOf) fail('SCENE_CLOCK_ROLLBACK');
      if (canonical(snapshot.authority) !== canonical(bound.authority)) fail('SCENE_AUTHORITY_CHANGED');
      if (snapshot.metadataIdentity !== bound.identity) fail('SCENE_SOURCE_CHANGED');
      bound.lastAsOf = snapshot.asOf;
      if (bound.payload) this.#currentTime(bound.payload, snapshot.asOf);
      return snapshot;
    } catch (error) {
      this.#terminate(bound);
      throw error;
    }
  }
  #currentTime(view: SceneRead, asOf: number): void {
    const applies = view.packet.applicability;
    if ((applies.from !== null && applies.from > asOf) || (applies.to !== null && applies.to <= asOf))
      fail('SCENE_PACKET_NOT_CURRENT');
  }
  #stage(bound: Bound, view: SceneRead) {
    // Parse, canonicalization and all caller-derived processing finish before this gate.
    const normalized = normalizeSceneJson(JSON.stringify(view.packet)),
      digest = createHash('sha256').update(normalized).digest('hex');
    const snapshot = this.#fresh(bound),
      packet = view.packet;
    if (
      packet.scopeRef !== snapshot.authority.id ||
      packet.epoch.generation !== snapshot.authority.generation ||
      packet.epoch.consentRevision !== snapshot.authority.consentRevision
    )
      fail('SCENE_SOURCE_MISMATCH');
    this.#currentTime(view, snapshot.asOf);
    if (bound.packetId !== null && packet.ref.id !== bound.packetId) fail('SCENE_PACKET_ID_MISMATCH');
    if (packet.ref.revision < bound.packetRevision) fail('SCENE_PACKET_REVISION_STALE');
    const duplicate = packet.ref.revision === bound.packetRevision;
    if (duplicate && digest !== bound.digest) fail('SCENE_PACKET_REVISION_CONFLICT');
    if (!duplicate) {
      if (bound.revision === Number.MAX_SAFE_INTEGER) fail('SCENE_LIMIT');
      bound.revision++;
      bound.packetId = packet.ref.id;
      bound.packetRevision = packet.ref.revision;
      bound.digest = digest;
      for (const client of bound.clients)
        for (const field of ['pending', 'lastAck'] as const)
          if (client[field] && this.#frames.get(client[field]!)!.info.operation === 'replace')
            this.#forget(client, field);
    }
    bound.payload = view;
    bound.needsClear = true;
    return Object.freeze({ revision: bound.revision, duplicate });
  }
  stage(binding: SceneBinding, packetJson: string) {
    const bound = this.#bound(binding),
      view = bound.contract.read(packetJson);
    return this.#stage(bound, view);
  }
  import(binding: SceneBinding, exchangeJson: string) {
    const bound = this.#bound(binding),
      view = bound.contract.import(exchangeJson);
    return this.#stage(bound, view);
  }
  #read(bound: Bound, snapshot: SceneSourceSnapshot): SceneAuthorizedRead {
    if (!bound.payload) fail('SCENE_NOT_READY');
    const declared = new Set(bound.contract.catalog.declaredSources.map((source) => sourceKey(source.ref)));
    return frozenCopy({
      view: bound.payload,
      sourceAssurance: 'CURRENT_STORE_SOURCE_BOUND' as const,
      claimAssurance: 'NOT_VERIFIED' as const,
      authority: snapshot.authority,
      asOf: snapshot.asOf,
      sources: snapshot.roots.filter((root) => declared.has(sourceKey(root.ref))),
    });
  }
  read(binding: SceneBinding): SceneAuthorizedRead {
    const bound = this.#bound(binding);
    return this.#read(bound, this.#fresh(bound));
  }
  export(binding: SceneBinding): string {
    const bound = this.#bound(binding);
    this.#fresh(bound);
    if (!bound.payload) fail('SCENE_NOT_READY');
    return bound.contract.export(JSON.stringify(bound.payload.packet));
  }
  register(binding: SceneBinding): SceneConsumer {
    const bound = this.#bound(binding);
    this.#fresh(bound);
    if (bound.clients.size >= SCENE_CONSUMER_LIMIT) fail('SCENE_CONSUMER_LIMIT');
    const consumer: SceneConsumer = Object.freeze({ version: 1 });
    const client: Client = { bound, resetAck: 0, appliedRevision: 0, pending: null, lastAck: null };
    bound.clients.add(client);
    this.#consumers.set(consumer, client);
    return consumer;
  }
  #offer(client: Client, operation: 'reset' | 'replace') {
    if (!client.pending) {
      const frame: SceneFrame = Object.freeze({ version: 1 }),
        bound = client.bound;
      this.#frames.set(frame, {
        client,
        info: Object.freeze({
          operation,
          barrier: bound.barrier,
          revision: operation === 'reset' ? 0 : bound.revision,
        }),
      });
      client.pending = frame;
    }
    return Object.freeze({ frame: client.pending, info: this.#frames.get(client.pending)!.info });
  }
  pull(binding: SceneBinding, consumer: SceneConsumer): Readonly<{ frame: SceneFrame; info: SceneFrameInfo }> | null {
    const bound = this.#bound(binding),
      client = this.#client(bound, consumer);
    // The sole authorization exception: body-free reset cleanup, even after revocation/unbind.
    if (client.resetAck !== bound.barrier) return this.#offer(client, 'reset');
    this.#fresh(bound);
    if (!bound.payload || client.appliedRevision === bound.revision) return null;
    return this.#offer(client, 'replace');
  }
  #frame(client: Client, frame: SceneFrame): FrameState {
    const state = this.#frames.get(frame);
    if (!state || state.client !== client || state.info.barrier !== client.bound.barrier) fail('SCENE_FRAME_STALE');
    return state;
  }
  resolve(
    binding: SceneBinding,
    consumer: SceneConsumer,
    frame: SceneFrame,
  ): Readonly<{ info: SceneFrameInfo }> | Readonly<{ info: SceneFrameInfo; data: SceneAuthorizedRead }> {
    const bound = this.#bound(binding),
      client = this.#client(bound, consumer),
      state = this.#frame(client, frame);
    if (state.info.operation === 'reset') return Object.freeze({ info: state.info });
    const snapshot = this.#fresh(bound);
    if (client.pending !== frame || client.resetAck !== bound.barrier || state.info.revision !== bound.revision)
      fail('SCENE_FRAME_STALE');
    return Object.freeze({ info: state.info, data: this.#read(bound, snapshot) });
  }
  acknowledge(binding: SceneBinding, consumer: SceneConsumer, frame: SceneFrame): SceneFrameInfo {
    const bound = this.#bound(binding),
      client = this.#client(bound, consumer),
      state = this.#frame(client, frame);
    if (state.info.operation === 'replace') {
      // Duplicate ACKs also pass this gate; an old receipt is never ongoing permission.
      this.#fresh(bound);
      if (client.resetAck !== bound.barrier || state.info.revision !== bound.revision) fail('SCENE_FRAME_STALE');
    }
    if (client.lastAck === frame) return state.info;
    if (client.pending !== frame) fail('SCENE_FRAME_STALE');
    this.#forget(client, 'lastAck');
    client.lastAck = frame;
    client.pending = null;
    if (state.info.operation === 'reset') client.resetAck = bound.barrier;
    else client.appliedRevision = state.info.revision;
    return state.info;
  }
  pause(binding: SceneBinding): void {
    const bound = this.#bound(binding);
    if (bound.status !== 'active') return;
    bound.status = 'paused';
    this.#reset(bound);
  }
  resume(binding: SceneBinding): void {
    const bound = this.#bound(binding);
    this.#fresh(bound, true);
    bound.status = 'active';
  }
  unbind(binding: SceneBinding): void {
    const bound = this.#bound(binding);
    if (bound.status === 'unbound') return;
    bound.status = 'unbound';
    this.#reset(bound);
  }
}
