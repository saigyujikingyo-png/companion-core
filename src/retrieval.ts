import { MemoryStore } from './store.ts';
import { types } from 'node:util';
import type { Epoch, SourceRef } from './contracts.ts';
import type { ConsumerHandle } from './fanout-types.ts';
import { canonical, frozenCopy } from './curation-types.ts';
import type { Frozen } from './curation-types.ts';
import { RETRIEVAL_LIMITS, RETRIEVAL_PROJECTION_LIMITS, copyRetrievalConsumerHandle } from './retrieval-types.ts';
import type {
  RetrievalAuthority,
  RetrievalBinding,
  RetrievalCandidate,
  RetrievalHitKind,
  ConsumerRetrievalSnapshot,
  RetrievalResult,
  RetrievalSnapshot,
} from './retrieval-types.ts';
import { fail, object, text, refs } from './validation.ts';

type Lexical = { normalized: string; terms: string[] };
type Association = { root: Frozen<SourceRef>; members: number[] };
type ProjectionCounts = { memories: number; roots: number; nodes: number; edges: number; bytes: number };
type Snapshot = RetrievalSnapshot | ConsumerRetrievalSnapshot;
type Pair = {
  revision: number;
  snapshot: Snapshot;
  lexical: Lexical[];
  association: Association[];
  counts: ProjectionCounts;
};
type Selection =
  | { epoch: Frozen<Epoch>; refs: Frozen<SourceRef[]>; consumer?: never }
  | { consumer: Frozen<ConsumerHandle>; epoch?: never; refs?: never };
type Bound = Selection & {
  authority: Frozen<RetrievalAuthority>;
  lastAsOf: number;
  revision: number;
  pair: Pair | null;
  candidate: RetrievalCandidate | null;
};
type Hit = { ordinal: number; kind: RetrievalHitKind };
type Candidate = { bound: Bound; revision: number; hits: Hit[] };
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const terms = (value: string) => [...new Set(value.match(/[\p{L}\p{N}]+/gu) ?? [])];
const sourceIdentity = (snapshot: Snapshot) => {
  if ('consumer' in snapshot) {
    const { readAsOf: _, ...consumer } = snapshot.consumer;
    return canonical({ authority: snapshot.authority, selected: snapshot.selected, consumer });
  }
  return canonical({ authority: snapshot.authority, selected: snapshot.selected });
};

/** Closed data objects only: no accessors, inherited fields, symbols or caller callbacks. */
function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (types.isProxy(value)) fail('INVALID_INPUT');
  object(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    allowed = new Set([...required, ...optional]);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value')) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  )
    fail('INVALID_INPUT');
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function denseRefs(value: unknown): SourceRef[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail('INVALID_INPUT');
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (length > RETRIEVAL_LIMITS.selected) fail('RETRIEVAL_LIMIT');
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  if (Reflect.ownKeys(value).length !== length + 1) fail('INVALID_INPUT');
  const copied: SourceRef[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
    const ref = closed(descriptor.value, ['id', 'revision']);
    text(ref.id, 128);
    if (!Number.isSafeInteger(ref.revision) || (ref.revision as number) < 1) fail('INVALID_INPUT');
    copied.push({ id: ref.id, revision: ref.revision as number });
  }
  return copied.length ? refs(copied) : [];
}
function bindInput(value: { epoch: Epoch; publishedRefs: SourceRef[] }) {
  const input = closed(value, ['epoch', 'publishedRefs']),
    authority = closed(input.epoch, ['id', 'generation', 'consentRevision']);
  text(authority.id, 128);
  for (const key of ['generation', 'consentRevision'] as const)
    if (!Number.isSafeInteger(authority[key]) || (authority[key] as number) < 0) fail('INVALID_INPUT');
  return {
    epoch: frozenCopy({
      id: authority.id,
      generation: authority.generation as number,
      consentRevision: authority.consentRevision as number,
    }),
    refs: frozenCopy(denseRefs(input.publishedRefs)),
  };
}

/** Trusted local memory-only recall. No timers, persistence, outbox ACK or host route. */
export class RetrievalService {
  #store: MemoryStore;
  #bindings = new WeakMap<RetrievalBinding, Bound>();
  #candidates = new WeakMap<RetrievalCandidate, Candidate>();
  constructor(store: MemoryStore) {
    this.#store = store;
  }
  bind(input: { epoch: Epoch; publishedRefs: SourceRef[] }): RetrievalBinding {
    const copied = bindInput(input),
      snapshot = this.#store.retrievalSnapshot(
        { ...copied.epoch },
        copied.refs.map((ref) => ({ ...ref })),
      );
    const handle: RetrievalBinding = Object.freeze({ version: 1 });
    this.#bindings.set(handle, {
      ...copied,
      authority: snapshot.authority,
      lastAsOf: snapshot.asOf,
      revision: 0,
      pair: null,
      candidate: null,
    });
    return handle;
  }
  bindConsumer(input: ConsumerHandle): RetrievalBinding {
    const consumer = frozenCopy(copyRetrievalConsumerHandle(input)),
      snapshot = this.#store.consumerRetrievalSnapshot(consumer);
    const handle: RetrievalBinding = Object.freeze({ version: 1 });
    this.#bindings.set(handle, {
      consumer,
      authority: snapshot.authority,
      lastAsOf: snapshot.asOf,
      revision: 0,
      pair: null,
      candidate: null,
    });
    return handle;
  }
  #bound(binding: RetrievalBinding): Bound {
    const bound = this.#bindings.get(binding);
    if (!bound) fail('UNAUTHENTICATED');
    return bound;
  }
  #clearCandidate(bound: Bound): void {
    if (bound.candidate) this.#candidates.delete(bound.candidate);
    bound.candidate = null;
  }
  #clearPair(bound: Bound): void {
    this.#clearCandidate(bound);
    bound.pair = null;
  }
  #snapshot(binding: RetrievalBinding, bound: Bound): Snapshot {
    try {
      const snapshot = bound.consumer
        ? this.#store.consumerRetrievalSnapshot(bound.consumer)
        : this.#store.retrievalSnapshot(
            { ...bound.epoch },
            bound.refs.map((ref) => ({ ...ref })),
          );
      if (snapshot.asOf < bound.lastAsOf) {
        this.#bindings.delete(binding);
        fail('RETRIEVAL_CLOCK_ROLLBACK');
      }
      if (canonical(snapshot.authority) !== canonical(bound.authority)) fail('RETRIEVAL_AUTHORITY_CHANGED');
      bound.lastAsOf = snapshot.asOf;
      return snapshot;
    } catch (error) {
      // Remember observed invalidity by terminating the capability, including a
      // TTL failure followed by a wall-clock rollback. A fresh trusted bind is required.
      this.#clearPair(bound);
      this.#bindings.delete(binding);
      throw error;
    }
  }
  #currentPair(binding: RetrievalBinding, bound: Bound): { pair: Pair; snapshot: Snapshot } {
    // Even an empty pair performs the full source/authority/TTL read before ranking or delivery.
    const snapshot = this.#snapshot(binding, bound),
      pair = bound.pair;
    if (!pair) fail('RETRIEVAL_NOT_READY');
    if (sourceIdentity(snapshot) !== sourceIdentity(pair.snapshot)) {
      this.#clearPair(bound);
      this.#bindings.delete(binding);
      fail('RETRIEVAL_SOURCE_CHANGED');
    }
    return { pair, snapshot };
  }
  refresh(binding: RetrievalBinding) {
    const bound = this.#bound(binding);
    this.#clearPair(bound);
    const snapshot = this.#snapshot(binding, bound),
      lexical: Lexical[] = [],
      association: Association[] = [];
    const rootIndices = new Map<string, number>();
    let edges = 0,
      bytes = 0;
    const charge = (value: unknown): void => {
      const amount = size(value);
      if (amount > RETRIEVAL_PROJECTION_LIMITS.bytes - bytes) fail('RETRIEVAL_PROJECTION_LIMIT');
      bytes += amount;
    };
    // Charge the retained snapshot, normalized strings, unique term lists and root/member mappings.
    // Fixed envelopes are reserved once; these are serialized UTF-8 costs, not heap measurements.
    charge({
      snapshot,
      lexical: [],
      association: [],
      revision: Number.MAX_SAFE_INTEGER,
      counts: { memories: 32, roots: 128, nodes: 128, edges: 512, bytes: RETRIEVAL_PROJECTION_LIMITS.bytes },
    });
    for (const [ordinal, item] of snapshot.selected.entries()) {
      const normalized = normalize(item.memory.statement),
        entry = { normalized, terms: terms(normalized) };
      charge(entry);
      lexical.push(entry);
      for (const root of item.rootEventRefs) {
        if (++edges > RETRIEVAL_PROJECTION_LIMITS.edges) fail('RETRIEVAL_PROJECTION_LIMIT');
        const key = canonical(root);
        let index = rootIndices.get(key);
        if (index === undefined) {
          if (snapshot.selected.length + association.length >= RETRIEVAL_PROJECTION_LIMITS.nodes)
            fail('RETRIEVAL_PROJECTION_LIMIT');
          index = association.length;
          rootIndices.set(key, index);
          association.push({ root, members: [] });
          charge({ root, members: [] });
        }
        association[index]!.members.push(ordinal);
        charge(ordinal);
        // Conservatively charge separators for each list member and lexical entry.
        bytes++;
        if (bytes > RETRIEVAL_PROJECTION_LIMITS.bytes) fail('RETRIEVAL_PROJECTION_LIMIT');
      }
      bytes++;
      if (bytes > RETRIEVAL_PROJECTION_LIMITS.bytes) fail('RETRIEVAL_PROJECTION_LIMIT');
    }
    if (!Number.isSafeInteger(bound.revision + 1)) fail('RETRIEVAL_PROJECTION_LIMIT');
    const revision = bound.revision + 1,
      counts = {
        memories: snapshot.selected.length,
        roots: association.length,
        nodes: snapshot.selected.length + association.length,
        edges,
        bytes,
      };
    // No caller code or async work occurs between construction and this single publication.
    bound.pair = { revision, snapshot, lexical, association, counts };
    bound.revision = revision;
    return frozenCopy({ projectionRevision: revision, counts });
  }
  query(binding: RetrievalBinding, input: { text: string; limit?: number }) {
    const bound = this.#bound(binding);
    this.#clearCandidate(bound);
    const fields = closed(input, ['text'], ['limit']);
    text(fields.text, 256);
    const requestedLimit = Object.hasOwn(fields, 'limit') ? fields.limit : 8;
    if (!Number.isSafeInteger(requestedLimit) || (requestedLimit as number) < 1 || (requestedLimit as number) > 32)
      fail('INVALID_INPUT');
    const limit = requestedLimit as number,
      normalized = normalize(fields.text),
      queryTerms = terms(normalized);
    if (!normalized.trim()) fail('INVALID_INPUT');
    const { pair } = this.#currentPair(binding, bound);
    const direct: number[] = [];
    for (const [ordinal, entry] of pair.lexical.entries())
      if (
        entry.normalized.includes(normalized) ||
        (queryTerms.length > 0 && queryTerms.every((term) => entry.terms.includes(term)))
      )
        direct.push(ordinal);
    const directSet = new Set(direct),
      shared = new Set<number>();
    if (direct.length)
      for (const entry of pair.association)
        if (entry.members.some((ordinal) => directSet.has(ordinal)))
          for (const ordinal of entry.members) if (!directSet.has(ordinal)) shared.add(ordinal);
    const hits: Hit[] = [
      ...direct.map((ordinal) => ({ ordinal, kind: 'direct_lexical' as const })),
      ...[...shared].sort((a, b) => a - b).map((ordinal) => ({ ordinal, kind: 'shared_root' as const })),
    ].slice(0, limit);
    const candidate: RetrievalCandidate = Object.freeze({ version: 1 });
    bound.candidate = candidate;
    this.#candidates.set(candidate, { bound, revision: pair.revision, hits });
    return Object.freeze({
      candidate,
      report: frozenCopy({
        version: 1,
        projectionRevision: pair.revision,
        counts: pair.counts,
        directMatches: direct.length,
        sharedMatches: shared.size,
        hits: hits.length,
        kinds: hits.map((hit) => hit.kind),
      }),
    });
  }
  resolve(binding: RetrievalBinding, candidate: RetrievalCandidate): RetrievalResult {
    const bound = this.#bound(binding),
      { pair, snapshot } = this.#currentPair(binding, bound);
    const saved = this.#candidates.get(candidate);
    if (!saved || saved.bound !== bound || bound.candidate !== candidate || saved.revision !== pair.revision)
      fail('UNAUTHENTICATED');
    return frozenCopy({
      version: 1,
      projectionRevision: pair.revision,
      asOf: snapshot.asOf,
      ...('consumer' in snapshot ? { consumer: snapshot.consumer } : {}),
      hits: saved.hits.map((hit) => ({ ...snapshot.selected[hit.ordinal]!, kind: hit.kind })),
    });
  }
  unbind(binding: RetrievalBinding): void {
    const bound = this.#bound(binding);
    this.#clearPair(bound);
    this.#bindings.delete(binding);
  }
}
