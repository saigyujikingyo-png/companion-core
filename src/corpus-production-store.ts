import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artifactRef } from './wf1-contract.ts';
import { canonical, copyJson, hash, id, integer, shape, stop } from './wf1-json.ts';
import { createArtifactBroker, HostAuthority } from './wf1-storage.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import {
  attemptReservation,
  productionAttemptPending,
  parseProductionJson,
  PRODUCTION,
  requirePurposes,
  validateProductionRegistry,
  validateProductionSpec,
  validatePurposes,
  worstCalls,
} from './corpus-production-types.ts';
import type {
  Attempt,
  Item,
  ProductionAdmission,
  ProductionEvent,
  ProductionRegistry,
  ProductionSpec,
  ProductionState,
  ScopedRef,
} from './corpus-production-types.ts';

export type ProductionStoreOptions = {
  approvedTrainingRoot: string;
  runtimeRoot: string;
  authorityPath: string;
  spec: ProductionSpec;
  key: Uint8Array;
  mode: 'create' | 'resume' | 'inspect';
  admission: () => ProductionAdmission;
  now?: () => number;
};
const SCHEMA = [
  'CREATE TABLE events(sequence INTEGER PRIMARY KEY, previous TEXT NOT NULL, ref TEXT NOT NULL, digest TEXT NOT NULL)',
  'CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
  'CREATE TABLE attempts(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE items(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE shards(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
];
function plain(path: string, max = 67108864) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) stop('CPR_INTEGRITY');
  return s;
}
function newFile(path: string, bytes: string) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function scoped(input: ScopedRef) {
  shape(input, ['bucket', 'ref']);
  if (!/^(meta|event-\d+|attempt-\d+|shard-\d+|tokens-\d+)$/.test(input.bucket)) stop('CPR_BUCKET');
  artifactRef(input.ref);
  if (input.ref.partition !== 'train') stop('CPR_INTEGRITY');
  return input;
}
const meta = (s: ProductionState) => {
  const { attempts: _, items: __, shards: ___, ...value } = s;
  return value;
};
function reduce(current: ProductionState | null, event: ProductionEvent, spec: ProductionSpec): ProductionState {
  shape(event, ['version', 'kind', 'data']);
  if (event.version !== 'CorpusProductionEvent/0.1') stop('CPR_EVENT');
  if (event.kind === 'INIT') {
    if (current) stop('CPR_EXISTS');
    const s = copyJson(event.data) as unknown as ProductionState;
    if (
      s.version !== 'CorpusProductionState/0.1' ||
      canonical(s.spec) !== canonical(spec) ||
      s.status !== 'ACTIVE' ||
      s.items.length !== spec.unitCount ||
      s.attempts.length ||
      s.shards.length ||
      s.tokenRefs.length ||
      s.heldFamilies.length
    )
      stop('CPR_STATE');
    return s;
  }
  if (!current) stop('CPR_STATE');
  const s = structuredClone(current),
    d = event.data as Record<string, unknown>;
  if (event.kind === 'PLAN') {
    shape(d, ['id', 'ref', 'code']);
    const p = s.plans.find((p) => p.id === d.id);
    if (!p || p.ref || p.code) stop('CPR_CAS');
    p.ref = d.ref as ScopedRef | null;
    p.code = d.code as string | null;
    if (p.ref) scoped(p.ref);
  } else if (event.kind === 'CONSUME') {
    const a = d as unknown as Attempt;
    if (
      s.status !== 'ACTIVE' ||
      s.attempts.some((v) => v.id === a.id) ||
      a.result !== null ||
      a.serviceMs !== null ||
      a.settledAtMs !== null ||
      a.reservedMicroUsd !== attemptReservation(spec) ||
      (spec.version === 'CorpusProduction/0.1' &&
        (s.attempts.length >= worstCalls(spec) ||
          s.attempts.reduce((n, v) => n + v.reservedMicroUsd!, 0) + a.reservedMicroUsd! > spec.budgetMicroUsd!))
    )
      stop('CPR_ONCE');
    if (
      !['plan', 'candidate', 'review'].includes(a.operation) ||
      a.itemIds.length === 0 ||
      new Set(a.itemIds).size !== a.itemIds.length ||
      a.itemIds.some(
        (unit) =>
          !s.items.some((i) => i.unitId === unit) ||
          s.attempts.some((old) => old.operation === a.operation && old.itemIds.includes(unit)),
      )
    )
      stop('CPR_ONCE');
    const cap = a.operation === 'plan' ? 16 : 4;
    if (a.itemIds.length > cap || (a.operation === 'candidate' && a.itemIds.length !== 4)) stop('CPR_BATCH');
    if (
      a.operation !== 'plan' &&
      a.itemIds.some(
        (unit) =>
          s.items.find((i) => i.unitId === unit)!.status !== (a.operation === 'candidate' ? 'PLANNED' : 'CANDIDATE'),
      )
    )
      stop('CPR_CAS');
    artifactRef(a.requestRef);
    id(a.id);
    s.attempts.push(a);
  } else if (event.kind === 'RECOVER_UNKNOWN') {
    shape(d, ['id', 'decidedAtMs']);
    const a = s.attempts.find((a) => a.id === d.id);
    if (spec.version !== 'CorpusProduction/0.2' || !a || !productionAttemptPending(spec, a) || a.result !== null)
      stop('CPR_CAS');
    a.settledAtMs = integer(d.decidedAtMs, a.consumedAtMs);
    a.serviceMs = null;
    a.settlementSource = 'RECOVERY_UNKNOWN';
  } else if (event.kind === 'SETTLE') {
    shape(d, ['id', 'result', 'serviceMs', 'settledAtMs']);
    const a = s.attempts.find((a) => a.id === d.id);
    if (!a || !productionAttemptPending(spec, a)) stop('CPR_CAS');
    integer(d.serviceMs);
    integer(d.settledAtMs, a.consumedAtMs);
    a.settledAtMs = Number(d.settledAtMs);
    a.result = d.result as Attempt['result'];
    a.serviceMs = Number(d.serviceMs);
  } else if (event.kind === 'ITEM') {
    shape(d, ['expected', 'item']);
    const next = d.item as Item,
      old = s.items[next.ordinal];
    if (
      !old ||
      old.unitId !== next.unitId ||
      old.poolId !== next.poolId ||
      old.status !== d.expected ||
      !['PLANNED', 'CANDIDATE'].includes(old.status) ||
      !['CANDIDATE', 'ACCEPTED', 'QUARANTINED'].includes(next.status)
    )
      stop('CPR_CAS');
    if (
      next.status === 'ACCEPTED' &&
      (s.status !== 'ACTIVE' ||
        old.status !== 'CANDIDATE' ||
        !next.rowRef ||
        !next.reviewRef ||
        s.items.some(
          (i) =>
            i.status === 'ACCEPTED' &&
            (i.exactDigest === next.exactDigest ||
              i.normalizedDigest === next.normalizedDigest ||
              i.promptDigest === next.promptDigest),
        ))
    )
      stop('CPR_DUPLICATE');
    s.items[next.ordinal] = next;
  } else if (event.kind === 'LINKS') {
    shape(d, ['unitId', 'matches']);
    const unit = String(d.unitId),
      matches = d.matches as string[];
    if (
      !s.items.some((i) => i.unitId === unit && i.candidateRef) ||
      !Array.isArray(matches) ||
      matches.length > spec.unitCount
    )
      stop('CPR_CAS');
    for (const other of matches) {
      if (other === unit || !s.items.some((i) => i.unitId === other && i.candidateRef)) stop('CPR_CAS');
      const pair = [unit, other].sort() as [string, string];
      if (!s.duplicateLinks.some((p) => p[0] === pair[0] && p[1] === pair[1])) s.duplicateLinks.push(pair);
    }
  } else if (event.kind === 'HOLD') {
    shape(d, ['familyId']);
    id(d.familyId);
    if (!s.heldFamilies.includes(String(d.familyId))) s.heldFamilies.push(String(d.familyId));
  } else if (event.kind === 'SHARD') {
    shape(d, ['ref']);
    const ref = scoped(d.ref as ScopedRef);
    if (s.shards.some((v) => v.ref.id === ref.ref.id)) stop('CPR_CAS');
    s.shards.push(ref);
  } else if (event.kind === 'TOKENS') {
    shape(d, ['ref']);
    const ref = scoped(d.ref as ScopedRef);
    if (s.tokenRefs.some((v) => v.ref.id === ref.ref.id)) stop('CPR_CAS');
    s.tokenRefs.push(ref);
  } else if (event.kind === 'EXPORT') {
    shape(d, ['ref']);
    if (s.exportRef) stop('CPR_CAS');
    s.exportRef = scoped(d.ref as ScopedRef);
  } else if (event.kind === 'FINISH') {
    shape(d, ['status', 'code', 'wallMs', 'cpuMicros', 'peakRss']);
    if (!['COMPLETED', 'FENCED'].includes(String(d.status)) || (s.status === 'FENCED' && d.status !== 'FENCED'))
      stop('CPR_CAS');
    if (
      d.status === 'COMPLETED' &&
      (s.items.some((i) => !['ACCEPTED', 'QUARANTINED'].includes(i.status)) ||
        s.attempts.some((a) => productionAttemptPending(spec, a)))
    )
      stop('CPR_PENDING');
    s.status = d.status as ProductionState['status'];
    s.code = d.code as string | null;
    for (const key of ['wallMs', 'cpuMicros', 'peakRss'] as const) {
      integer(d[key]);
      s[key] = Number(d[key]);
    }
  } else stop('CPR_EVENT');
  return s;
}

/** Job-local append-only encrypted events with narrow indexed projections. No retry lease. */
export class ProductionStore {
  readonly spec: ProductionSpec;
  readonly mode: ProductionStoreOptions['mode'];
  #o: ProductionStoreOptions;
  #key: Buffer;
  #host: HostAuthority;
  #db!: DatabaseSync;
  #owner: DatabaseSync;
  #brokers = new Map<string, ArtifactPort>();
  #state: ProductionState | null = null;
  #sequence = 0;
  #head = '0'.repeat(64);
  #stamp = '';
  #closed = false;
  #broken = false;
  #loading = true;
  #recoverable = new Set<string>();
  #parents: string[] = [];
  constructor(options: ProductionStoreOptions) {
    if (!(options.key instanceof Uint8Array) || options.key.length !== 32) stop('CPR_KEY');
    this.#key = Buffer.from(options.key);
    try {
      this.#o = { ...options, key: this.#key };
      this.mode = options.mode;
      this.spec = validateProductionSpec(options.spec);
      requireTrainingBinding(
        options.approvedTrainingRoot,
        options.runtimeRoot,
        this.spec.storageBindingDigest,
        options.authorityPath,
      );
      const now = options.now ?? Date.now;
      this.#host = new HostAuthority(options.authorityPath, this.spec.jobId, now);
      const authority = this.#host.read(now(), options.mode !== 'inspect');
      if (
        options.mode !== 'inspect' &&
        (authority.runtimeId !== this.spec.runtimeId ||
          authority.revision !== this.spec.authorityRevision ||
          now() < this.spec.createdAt ||
          now() >= this.spec.expiresAt)
      )
        stop('CPR_AUTHORITY');
      this.#admission(options.mode !== 'inspect');
      const root = options.runtimeRoot,
        path = join(root, 'corpus-production.sqlite'),
        owner = join(root, 'corpus-production-owner.sqlite');
      if (options.mode === 'create') {
        if (authority.head !== null || readdirSync(root).length) stop('CPR_EXISTS');
        mkdirSync(join(root, 'objects'));
        newFile(owner, '');
        newFile(path, '');
      }
      plain(owner, 4096);
      plain(path);
      this.#owner = new DatabaseSync(owner, { timeout: 0 });
      try {
        this.#owner.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
      } catch {
        this.#owner.close();
        stop('CPR_OWNER');
      }
      try {
        for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) stop('CPR_INTEGRITY');
        if (existsSync(path + '-journal') && statSync(path + '-journal').size > 0) stop('CPR_COMMIT_UNKNOWN');
        this.#db = new DatabaseSync(path, { timeout: 0, readOnly: options.mode === 'inspect' });
        this.#db.exec('PRAGMA trusted_schema=OFF');
        if (options.mode === 'create')
          this.#db.exec(
            'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; PRAGMA application_id=1129337393; PRAGMA user_version=1; ' +
              SCHEMA.join(';') +
              '; COMMIT;',
          );
        else {
          if (
            this.#db.prepare('PRAGMA application_id').get()!.application_id !== 1129337393 ||
            this.#db.prepare('PRAGMA user_version').get()!.user_version !== 1
          )
            stop('CPR_INTEGRITY');
          const tables = this.#db
            .prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
            .all()
            .map((r) => r.sql);
          if (
            canonical(tables) !==
            canonical(
              [...SCHEMA].sort((a, b) =>
                a.split(' ')[2]! < b.split(' ')[2]! ? -1 : a.split(' ')[2]! > b.split(' ')[2]! ? 1 : 0,
              ),
            )
          )
            stop('CPR_INTEGRITY');
        }
        this.#stamp = this.#fileStamp();
        const count = this.#db.prepare('SELECT count(*) AS n FROM events').get()!.n;
        integer(count, 0, 4096);
        for (const [i, row] of this.#db.prepare('SELECT * FROM events ORDER BY sequence').all().entries()) {
          if (
            row.sequence !== i + 1 ||
            row.previous !== this.#head ||
            typeof row.ref !== 'string' ||
            row.ref.length > 2048 ||
            row.digest !== hash(this.#head + '\n' + row.ref)
          )
            stop('CPR_INTEGRITY');
          const ref = scoped(parseProductionJson(row.ref) as unknown as ScopedRef);
          if (canonical(ref) !== row.ref || ref.ref.kind !== 'corpus-production-event') stop('CPR_INTEGRITY');
          const event = parseProductionJson(this.read(ref).toString('utf8')) as unknown as ProductionEvent;
          this.#state = reduce(this.#state, event, this.spec);
          this.#head = String(row.digest);
          this.#sequence = i + 1;
        }
        if (options.mode !== 'create' && (!this.#state || authority.head !== this.#head)) stop('CPR_HEAD');
        if (this.#state) {
          const registry = validateProductionRegistry(
            parseProductionJson(this.read(this.#state.registryRef).toString('utf8')),
            this.spec,
          );
          this.#parents = registry.parentGrantIds;
          this.#verifyProjection();
        }
        if (options.mode === 'resume' && this.spec.version === 'CorpusProduction/0.2')
          for (const a of this.#state?.attempts ?? [])
            if (productionAttemptPending(this.spec, a)) this.#recoverable.add(a.id);
        this.#loading = false;
        this.check(options.mode !== 'inspect');
      } catch (error) {
        try {
          this.#db?.close();
        } catch {}
        this.#owner.close();
        throw error;
      }
    } catch (error) {
      this.#key.fill(0);
      throw error;
    }
  }
  #fileStamp() {
    const path = join(this.#o.runtimeRoot, 'corpus-production.sqlite');
    plain(path);
    const s = statSync(path, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  }
  #admission(active: boolean) {
    const a = this.#o.admission();
    shape(copyJson(a), ['registryDigest', 'sourceAllowed', 'retainAllowed', 'purposes']);
    if (a.registryDigest !== this.spec.registryDigest || a.sourceAllowed !== true || a.retainAllowed !== true)
      stop('CPR_SOURCE');
    const purposes = validatePurposes(a.purposes);
    if (active) {
      if (hash(canonical(purposes)) !== this.spec.purposeDigest) stop('CPR_PURPOSE');
      requirePurposes(purposes, this.spec.coordinator, 'curriculum', this.#parents);
      requirePurposes(purposes, this.spec.coordinator, 'training', this.#parents);
      for (const pool of this.spec.pools) {
        requirePurposes(purposes, pool.generator, 'generate', this.#parents);
        requirePurposes(purposes, pool.reviewer, 'review', this.#parents);
        requirePurposes(purposes, pool.generator, 'training', this.#parents);
        requirePurposes(purposes, pool.reviewer, 'training', this.#parents);
      }
    }
    return purposes;
  }
  check(active = true) {
    if (this.#closed || this.#broken) stop('CPR_CLOSED');
    requireTrainingBinding(
      this.#o.approvedTrainingRoot,
      this.#o.runtimeRoot,
      this.spec.storageBindingDigest,
      this.#o.authorityPath,
    );
    this.#admission(active);
    const now = (this.#o.now ?? Date.now)(),
      a = this.#host.read(now, active);
    if (this.#stamp && this.#stamp !== this.#fileStamp()) stop('CPR_INTEGRITY');
    if (!this.#loading && a.head !== (this.#sequence ? this.#head : null)) stop('CPR_HEAD');
    if (
      active &&
      (this.mode === 'inspect' ||
        a.runtimeId !== this.spec.runtimeId ||
        a.revision !== this.spec.authorityRevision ||
        now >= this.spec.expiresAt)
    )
      stop('CPR_AUTHORITY');
    return a;
  }
  purposes() {
    this.check();
    return this.#admission(true);
  }
  port(bucket: string): ArtifactPort {
    if (!/^(meta|event-\d+|attempt-\d+|shard-\d+|tokens-\d+)$/.test(bucket)) stop('CPR_BUCKET');
    const prior = this.#brokers.get(bucket);
    if (prior) return prior;
    const path = join(this.#o.runtimeRoot, 'objects', bucket);
    if (!existsSync(path)) {
      this.check();
      mkdirSync(path);
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) stop('CPR_INTEGRITY');
    const raw = createArtifactBroker(path, this.spec.jobId + ':' + bucket, this.#o.key, () => this.check(false)).train;
    const port = {
      read: raw.read,
      put: (kind: string, bytes: string | Uint8Array) => {
        this.check();
        return raw.put(kind, bytes);
      },
    };
    this.#brokers.set(bucket, port);
    return port;
  }
  put(bucket: string, kind: string, bytes: string | Uint8Array): ScopedRef {
    const ref = { bucket, ref: this.port(bucket).put(kind, bytes) };
    const read = this.read(ref);
    if (!read.equals(Buffer.from(bytes))) stop('CPR_INTEGRITY');
    return ref;
  }
  read(input: ScopedRef) {
    const ref = scoped(input);
    return this.port(ref.bucket).read(ref.ref);
  }
  snapshot() {
    this.check(false);
    return this.#state ? structuredClone(this.#state) : null;
  }
  initialize(objective: string, registry: ProductionRegistry) {
    this.check();
    if (this.#state) stop('CPR_EXISTS');
    const validated = validateProductionRegistry(registry, this.spec);
    if (hash(canonical(validated)) !== this.spec.registryDigest || hash(objective) !== this.spec.objectiveDigest)
      stop('CPR_SOURCE');
    this.#parents = validated.parentGrantIds;
    this.check();
    const objectiveRef = this.put('meta', 'corpus-production-objective', objective),
      registryRef = this.put('meta', 'corpus-production-registry', canonical(validated));
    const plans = [];
    for (let i = 0; i < registry.slots.length; i += 16)
      plans.push({
        id: 'plan:' + i / 16,
        itemIds: registry.slots.slice(i, i + 16).map((s) => s.unitId),
        ref: null,
        code: null,
      });
    const state: ProductionState = {
      version: 'CorpusProductionState/0.1',
      spec: this.spec,
      status: 'ACTIVE',
      code: null,
      objectiveRef,
      registryRef,
      plans,
      attempts: [],
      items: registry.slots.map((s) => ({
        ordinal: s.ordinal,
        unitId: s.unitId,
        poolId: s.poolId,
        status: 'PLANNED',
        code: null,
        candidateRef: null,
        candidateDigest: null,
        reviewRef: null,
        rowRef: null,
        exactDigest: null,
        normalizedDigest: null,
        promptDigest: null,
        sketch: null,
      })),
      heldFamilies: [],
      duplicateLinks: [],
      shards: [],
      tokenRefs: [],
      exportRef: null,
      wallMs: 0,
      cpuMicros: 0,
      peakRss: process.memoryUsage().rss,
    };
    this.apply('INIT', state);
  }
  apply(kind: ProductionEvent['kind'], data: unknown) {
    this.check();
    if (kind === 'RECOVER_UNKNOWN') {
      const id = (data as { id: string }).id;
      if (this.mode !== 'resume' || !this.#recoverable.delete(id)) stop('CPR_RECOVERY_OWNER');
    }
    if (this.#sequence >= 4096) stop('CPR_LIMIT');
    const event = { version: 'CorpusProductionEvent/0.1' as const, kind, data: copyJson(data) },
      next = reduce(this.#state, event, this.spec),
      ref = this.put('event-' + Math.floor(this.#sequence / 128), 'corpus-production-event', canonical(event)),
      body = canonical(ref),
      head = hash(this.#head + '\n' + body);
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      this.#db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(this.#sequence + 1, this.#head, body, head);
      this.#db.prepare('INSERT OR REPLACE INTO metadata VALUES (1,?)').run(canonical(meta(next)));
      if (kind === 'INIT')
        for (const item of next.items)
          this.#db.prepare('INSERT INTO items VALUES (?,?)').run(item.unitId, canonical(item));
      if (kind === 'CONSUME' || kind === 'SETTLE' || kind === 'RECOVER_UNKNOWN') {
        const id = (data as { id: string }).id,
          a = next.attempts.find((a) => a.id === id)!;
        this.#db.prepare('INSERT OR REPLACE INTO attempts VALUES (?,?)').run(id, canonical(a));
      }
      if (kind === 'ITEM') {
        const item = (data as { item: Item }).item;
        this.#db.prepare('UPDATE items SET data=? WHERE id=?').run(canonical(item), item.unitId);
      }
      if (kind === 'SHARD') {
        const r = (data as { ref: ScopedRef }).ref;
        this.#db.prepare('INSERT INTO shards VALUES (?,?)').run(r.ref.id, canonical(r));
      }
      this.#db.exec('COMMIT');
      this.#host.commitHead(this.#sequence ? this.#head : null, head);
      this.#head = head;
      this.#sequence++;
      this.#state = next;
      this.#stamp = this.#fileStamp();
      this.check();
    } catch {
      this.#broken = true;
      stop('CPR_COMMIT_UNKNOWN');
    }
  }
  #verifyProjection() {
    const s = this.#state!;
    if (
      this.#db.prepare('SELECT count(*) AS n FROM metadata').get()!.n !== 1 ||
      this.#db.prepare('SELECT data FROM metadata WHERE id=1').get()?.data !== canonical(meta(s))
    )
      stop('CPR_INTEGRITY');
    for (const [table, expected] of [
      ['items', s.items.map((v) => [v.unitId, canonical(v)])],
      ['attempts', s.attempts.map((v) => [v.id, canonical(v)])],
      ['shards', s.shards.map((v) => [v.ref.id, canonical(v)])],
    ] as const) {
      const actual = this.#db
        .prepare('SELECT id,data FROM ' + table + ' ORDER BY id')
        .all()
        .map((r) => [r.id, r.data]);
      if (canonical(actual) !== canonical([...expected].sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))))
        stop('CPR_INTEGRITY');
    }
  }
  authorizeSend<T>(send: () => T): T {
    this.check();
    return this.#host.dispatch(this.#head, () => {
      this.check();
      return send();
    });
  }
  control(status: 'PAUSED' | 'REVOKED') {
    this.check();
    this.#host.control(status);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } finally {
      try {
        this.#owner.close();
      } finally {
        this.#key.fill(0);
        this.#brokers.clear();
      }
    }
  }
}
export const openProductionJob = (options: ProductionStoreOptions) => new ProductionStore(options);
