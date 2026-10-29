import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import {
  boundedJson,
  canonical,
  CanaryError,
  canaryFail,
  CANARY_LIMITS,
  closed,
  HEX64,
  sha256,
  tensorValues,
} from './tj1-spec.ts';

export type CanaryAuthority = {
  scopeId: string;
  generation: string;
  consentRevision: string;
  runtimeId: string;
  now: number;
  expiresAt: number;
  read: boolean;
  write: boolean;
  train: boolean;
  export: boolean;
};
export class CanaryGate {
  #callback: () => CanaryAuthority;
  #bound: CanaryAuthority | null = null;
  #now = 0;
  #checking = false;
  #invalid = false;
  constructor(callback: () => CanaryAuthority) {
    this.#callback = callback;
  }
  check(right: 'read' | 'write' | 'train' | 'export'): CanaryAuthority {
    if (this.#checking) {
      this.#invalid = true;
      canaryFail('TJ1_REENTRANT');
    }
    if (this.#invalid) canaryFail('TJ1_FENCED');
    this.#checking = true;
    try {
      const raw = this.#callback();
      if (
        raw === null ||
        typeof raw !== 'object' ||
        types.isProxy(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
      )
        canaryFail('TJ1_AUTHORITY');
      const keys = [
          'scopeId',
          'generation',
          'consentRevision',
          'runtimeId',
          'now',
          'expiresAt',
          'read',
          'write',
          'train',
          'export',
        ],
        d = Object.getOwnPropertyDescriptors(raw);
      if (Reflect.ownKeys(raw).length !== keys.length || keys.some((k) => !d[k] || !Object.hasOwn(d[k], 'value')))
        canaryFail('TJ1_AUTHORITY');
      const a = Object.fromEntries(keys.map((k) => [k, d[k]!.value])) as CanaryAuthority;
      for (const k of ['scopeId', 'runtimeId'] as const)
        if (typeof a[k] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(a[k])) canaryFail('TJ1_AUTHORITY');
      for (const k of ['generation', 'consentRevision'] as const) counter(a[k]);
      for (const k of ['read', 'write', 'train', 'export'] as const)
        if (typeof a[k] !== 'boolean') canaryFail('TJ1_AUTHORITY');
      if (
        !Number.isSafeInteger(a.now) ||
        a.now < this.#now ||
        !Number.isSafeInteger(a.expiresAt) ||
        a.expiresAt <= a.now ||
        !a.read ||
        !a[right] ||
        (right === 'train' && !a.write) ||
        this.#invalid ||
        (this.#bound && (scopeDigest(a) !== scopeDigest(this.#bound) || a.runtimeId !== this.#bound.runtimeId))
      )
        canaryFail('TJ1_AUTHORITY');
      this.#bound ??= Object.freeze({ ...a });
      this.#now = a.now;
      return { ...a };
    } catch {
      this.#invalid = true;
      return canaryFail('TJ1_AUTHORITY');
    } finally {
      this.#checking = false;
    }
  }
  fence(): void {
    this.#invalid = true;
  }
}
export const scopeDigest = (a: CanaryAuthority) =>
  sha256(canonical({ scopeId: a.scopeId, generation: a.generation, consentRevision: a.consentRevision }));
const counter = (v: unknown): string => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v)) canaryFail('TJ1_INVALID');
  return v;
};
const digest = (v: unknown): string => {
  if (typeof v !== 'string' || !HEX64.test(v)) canaryFail('TJ1_INVALID');
  return v;
};
const token = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.:+-]{1,96}$/.test(v)) canaryFail('TJ1_INVALID');
  return v;
};
const bits = (v: unknown): void => {
  if (typeof v !== 'string' || !/^[a-f0-9]{16}$/.test(v)) canaryFail('TJ1_INVALID');
};
const select = (v: unknown, allowed: string[]) => {
  if (typeof v !== 'string' || !allowed.includes(v)) canaryFail('TJ1_INVALID');
};
export type CanaryKind =
  | 'PREPARED'
  | 'LAUNCH_CONSUMED'
  | 'TRAINER_READY'
  | 'STEP'
  | 'PROCESS_OUTCOME'
  | 'TRAIN_TERMINAL'
  | 'ARTIFACT'
  | 'DELTA_CHECK'
  | 'RELOAD'
  | 'EVALUATION'
  | 'OBSERVATION_END';
export type CanaryRecord = {
  logical: 'tj1-local-canary-v1';
  container: 'sqlite-event-ledger-v1';
  codec: 'identity-json-v1';
  lane: 'ACTUAL_LOCAL' | 'OFFLINE_FIXTURE';
  sequence: string;
  eventId: string;
  kind: CanaryKind;
  source: 'HOST_CONTROL' | 'PINNED_TRAINER_OBSERVED' | 'PARENT_VERIFIED' | 'PINNED_EVALUATOR_OBSERVED';
  receiptDigest: string | null;
  data: Record<string, unknown>;
};
export type CanaryLedgerMeta = {
  logical: 'tj1-local-canary-v1';
  container: 'sqlite-event-ledger-v1';
  codec: 'identity-json-v1';
  lane: 'ACTUAL_LOCAL' | 'OFFLINE_FIXTURE';
  runId: string;
  attemptId: string;
  manifestDigest: string;
  scopeDigest: string;
};
const META_KEYS = ['logical', 'container', 'codec', 'lane', 'runId', 'attemptId', 'manifestDigest', 'scopeDigest'];
function validateMeta(raw: unknown): CanaryLedgerMeta {
  const m = closed(raw, META_KEYS);
  if (m.logical !== 'tj1-local-canary-v1' || m.container !== 'sqlite-event-ledger-v1' || m.codec !== 'identity-json-v1')
    canaryFail('TJ1_UNSUPPORTED');
  select(m.lane, ['ACTUAL_LOCAL', 'OFFLINE_FIXTURE']);
  token(m.runId);
  token(m.attemptId);
  digest(m.manifestDigest);
  digest(m.scopeDigest);
  return m as CanaryLedgerMeta;
}
export function validateCanaryRecord(raw: string): CanaryRecord {
  const e = closed(boundedJson(raw), [
    'logical',
    'container',
    'codec',
    'lane',
    'sequence',
    'eventId',
    'kind',
    'source',
    'receiptDigest',
    'data',
  ]);
  if (e.logical !== 'tj1-local-canary-v1' || e.container !== 'sqlite-event-ledger-v1' || e.codec !== 'identity-json-v1')
    canaryFail('TJ1_UNSUPPORTED');
  select(e.lane, ['ACTUAL_LOCAL', 'OFFLINE_FIXTURE']);
  counter(e.sequence);
  token(e.eventId);
  select(e.source, ['HOST_CONTROL', 'PINNED_TRAINER_OBSERVED', 'PARENT_VERIFIED', 'PINNED_EVALUATOR_OBSERVED']);
  if (e.receiptDigest !== null) digest(e.receiptDigest);
  switch (e.kind) {
    case 'PREPARED':
      digest(closed(e.data, ['manifestDigest']).manifestDigest);
      break;
    case 'LAUNCH_CONSUMED':
      token(closed(e.data, ['launchId']).launchId);
      break;
    case 'TRAINER_READY': {
      const d = closed(e.data, ['runtime', 'rssBytes', 'availableBytes']);
      token(d.runtime);
      counter(d.rssBytes);
      counter(d.availableBytes);
      break;
    }
    case 'STEP': {
      const d = closed(e.data, ['step', 'lossBits', 'gradient', 'tensors', 'rssBytes']);
      counter(d.step);
      bits(d.lossBits);
      tensorValues(d.gradient);
      tensorValues(d.tensors);
      counter(d.rssBytes);
      break;
    }
    case 'TRAIN_TERMINAL': {
      const d = closed(e.data, ['outcome', 'observedSteps', 'exitCode']);
      select(d.outcome, ['COMPLETED', 'FAILED', 'UNKNOWN']);
      counter(d.observedSteps);
      if (
        d.exitCode !== null &&
        (!Number.isSafeInteger(d.exitCode) ||
          (d.exitCode as number) < -2147483648 ||
          (d.exitCode as number) > 4294967295)
      )
        canaryFail('TJ1_INVALID');
      break;
    }
    case 'PROCESS_OUTCOME': {
      const d = closed(e.data, ['stage', 'bytes', 'sha256']);
      select(d.stage, ['trainer', 'evaluator']);
      counter(d.bytes);
      digest(d.sha256);
      break;
    }
    case 'ARTIFACT': {
      const d = closed(e.data, ['name', 'bytes', 'sha256']);
      token(d.name);
      counter(d.bytes);
      digest(d.sha256);
      break;
    }
    case 'DELTA_CHECK': {
      const d = closed(e.data, ['initialDigest', 'finalDigest', 'deltaBits', 'changed', 'firstStep']);
      digest(d.initialDigest);
      digest(d.finalDigest);
      bits(d.deltaBits);
      counter(d.changed);
      select(d.firstStep, ['PASS', 'FAIL']);
      break;
    }
    case 'RELOAD': {
      const d = closed(e.data, ['result', 'weightsDigest', 'checkpointDigest', 'rssBytes']);
      select(d.result, ['PASS', 'FAIL']);
      digest(d.weightsDigest);
      digest(d.checkpointDigest);
      counter(d.rssBytes);
      break;
    }
    case 'EVALUATION': {
      const d = closed(e.data, ['result', 'mseBits', 'baselineBits', 'predictionsDigest']);
      select(d.result, ['PASS', 'FAIL']);
      bits(d.mseBits);
      bits(d.baselineBits);
      digest(d.predictionsDigest);
      break;
    }
    case 'OBSERVATION_END': {
      const d = closed(e.data, ['training', 'delta', 'export', 'reload', 'evaluation', 'code']);
      select(d.training, ['COMPLETED', 'FAILED', 'UNKNOWN']);
      for (const k of ['delta', 'export', 'reload', 'evaluation']) select(d[k], ['PASS', 'FAIL', 'NOT_RUN', 'UNKNOWN']);
      token(d.code);
      break;
    }
    default:
      return canaryFail('TJ1_INVALID');
  }
  if (canonical(e) !== raw) canaryFail('TJ1_NONCANONICAL');
  return e as CanaryRecord;
}
export type CanaryProjection = {
  consumed: boolean;
  ready: boolean;
  steps: number;
  training: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  ended: boolean;
};
function transition(previous: CanaryProjection, e: CanaryRecord): CanaryProjection {
  const p = { ...previous };
  if (p.ended) canaryFail('TJ1_TERMINAL');
  switch (e.kind) {
    case 'PREPARED':
      if (e.sequence !== '1') canaryFail('TJ1_ORDER');
      break;
    case 'LAUNCH_CONSUMED':
      if (e.sequence !== '2' || p.consumed) canaryFail('TJ1_CONSUMED');
      p.consumed = true;
      break;
    case 'TRAINER_READY':
      if (!p.consumed || p.ready || p.training !== 'NOT_STARTED') canaryFail('TJ1_ORDER');
      p.ready = true;
      p.training = 'RUNNING';
      break;
    case 'STEP':
      if (!p.ready || p.training !== 'RUNNING' || e.data.step !== String(p.steps + 1) || p.steps >= 64)
        canaryFail('TJ1_ORDER');
      p.steps++;
      break;
    case 'TRAIN_TERMINAL':
      if (!p.consumed || !['NOT_STARTED', 'RUNNING'].includes(p.training)) canaryFail('TJ1_TERMINAL');
      if (
        e.data.observedSteps !== String(p.steps) ||
        (e.data.outcome === 'COMPLETED' && (p.steps !== 64 || e.data.exitCode !== 0))
      )
        canaryFail('TJ1_ORDER');
      p.training = e.data.outcome as CanaryProjection['training'];
      break;
    case 'PROCESS_OUTCOME':
      if (!p.consumed || (e.data.stage === 'evaluator' && p.training !== 'COMPLETED')) canaryFail('TJ1_ORDER');
      break;
    case 'OBSERVATION_END':
      if (['NOT_STARTED', 'RUNNING'].includes(p.training) || e.data.training !== p.training) canaryFail('TJ1_ORDER');
      p.ended = true;
      break;
    default:
      if (p.training !== 'COMPLETED') canaryFail('TJ1_ORDER');
  }
  const expected =
    e.kind === 'STEP' || e.kind === 'TRAINER_READY'
      ? 'PINNED_TRAINER_OBSERVED'
      : ['DELTA_CHECK', 'ARTIFACT', 'EVALUATION'].includes(e.kind)
        ? 'PARENT_VERIFIED'
        : e.kind === 'RELOAD'
          ? 'PINNED_EVALUATOR_OBSERVED'
          : 'HOST_CONTROL';
  if (e.source !== expected) canaryFail('TJ1_ORDER');
  return p;
}
export function privateDirectory(input: string): string {
  if (typeof input !== 'string' || !isAbsolute(input)) canaryFail('TJ1_PATH');
  const path = realpathSync(input);
  if (
    (process.platform === 'win32' ? path.toLowerCase() : path) !==
    (process.platform === 'win32' ? resolve(input).toLowerCase() : resolve(input))
  )
    canaryFail('TJ1_PATH');
  const root = dirname(dirname(fileURLToPath(import.meta.url))),
    rel = relative(root, path);
  if (
    !lstatSync(path).isDirectory() ||
    path.split(/[\\/]/).some((p) => /^onedrive(?:\s|$)/i.test(p)) ||
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
  )
    canaryFail('TJ1_PATH');
  return path;
}
export function boundedFile(path: string, max: number, optional = false): void {
  try {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) canaryFail('TJ1_PATH');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
const TABLE_META = 'CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)';
const TABLE_EVENTS =
  'CREATE TABLE events(sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, previous TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL)';
/** A receipt store never authenticates itself. Only the live observer can qualify new observed facts. */
export class CanaryLedger {
  #db: DatabaseSync;
  #lock: DatabaseSync;
  #gate: CanaryGate;
  #meta: CanaryLedgerMeta;
  #records: CanaryRecord[] = [];
  #hashes: string[] = [];
  #closed = false;
  #projection: CanaryProjection = { consumed: false, ready: false, steps: 0, training: 'NOT_STARTED', ended: false };
  #path: string;
  #stamp = '';
  private constructor(db: DatabaseSync, lock: DatabaseSync, gate: CanaryGate, meta: CanaryLedgerMeta, path: string) {
    this.#db = db;
    this.#lock = lock;
    this.#gate = gate;
    this.#meta = meta;
    this.#path = path;
  }
  static create(directory: string, gate: CanaryGate, meta: CanaryLedgerMeta): CanaryLedger {
    return this.#open(directory, gate, meta);
  }
  static open(directory: string, gate: CanaryGate): CanaryLedger {
    return this.#open(directory, gate);
  }
  static #open(directory: string, gate: CanaryGate, create?: CanaryLedgerMeta): CanaryLedger {
    let lock: DatabaseSync | undefined, db: DatabaseSync | undefined;
    try {
      const a = gate.check(create ? 'write' : 'read'),
        dir = privateDirectory(directory),
        lockPath = join(dir, 'tj1-owner.sqlite'),
        path = join(dir, 'tj1-receipts.sqlite');
      try {
        closeSync(openSync(lockPath, 'wx', 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      boundedFile(lockPath, 0);
      boundedFile(lockPath + '-journal', 512, true);
      for (const suffix of ['-wal', '-shm']) {
        try {
          lstatSync(lockPath + suffix);
          canaryFail('TJ1_PATH');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      lock = new DatabaseSync(lockPath, { timeout: 0 });
      try {
        lock.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
      } catch {
        return canaryFail('TJ1_LOCKED');
      }
      if (create) closeSync(openSync(path, 'wx', 0o600));
      boundedFile(path, CANARY_LIMITS.ledgerBytes);
      boundedFile(path + '-journal', CANARY_LIMITS.ledgerBytes, true);
      for (const suffix of ['-wal', '-shm']) {
        try {
          lstatSync(path + suffix);
          canaryFail('TJ1_PATH');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      db = new DatabaseSync(path, { timeout: 0 });
      db.exec(
        'PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=1024',
      );
      let meta: CanaryLedgerMeta;
      if (create) {
        meta = validateMeta(boundedJson(canonical(create)));
        if (meta.scopeDigest !== scopeDigest(a)) canaryFail('TJ1_AUTHORITY');
        db.exec(
          'BEGIN IMMEDIATE; PRAGMA application_id=1414140161; PRAGMA user_version=1; ' +
            TABLE_META +
            '; ' +
            TABLE_EVENTS +
            ';',
        );
        db.prepare('INSERT INTO meta VALUES (1,?)').run(canonical(meta));
        db.exec('COMMIT');
      } else {
        if (
          db.prepare('PRAGMA user_version').get()!.user_version !== 1 ||
          db.prepare('PRAGMA application_id').get()!.application_id !== 1414140161
        )
          canaryFail('TJ1_UNSUPPORTED');
        const schema = db
          .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
          .all();
        if (
          schema.length !== 2 ||
          schema[0]!.name !== 'events' ||
          schema[0]!.sql !== TABLE_EVENTS ||
          schema[1]!.name !== 'meta' ||
          schema[1]!.sql !== TABLE_META
        )
          canaryFail('TJ1_CORRUPT');
        const rows = db.prepare('SELECT value FROM meta').all();
        if (rows.length !== 1 || typeof rows[0]!.value !== 'string') canaryFail('TJ1_CORRUPT');
        meta = validateMeta(boundedJson(rows[0]!.value));
        if (canonical(meta) !== rows[0]!.value) canaryFail('TJ1_NONCANONICAL');
        if (meta.scopeDigest !== scopeDigest(a)) canaryFail('TJ1_AUTHORITY');
      }
      const j = new CanaryLedger(db, lock, gate, meta, path);
      j.#scan();
      j.#stamp = j.#fileStamp();
      gate.check(create ? 'write' : 'read');
      j.#check();
      return j;
    } catch (e) {
      try {
        db?.close();
      } catch {}
      try {
        lock?.close();
      } catch {}
      if (e instanceof CanaryError) throw e;
      return canaryFail('TJ1_IO');
    }
  }
  #fileStamp(): string {
    boundedFile(this.#path, CANARY_LIMITS.ledgerBytes);
    const s = statSync(this.#path, { bigint: true });
    return [s.ino, s.dev, s.size, s.mtimeNs, s.ctimeNs].join(':');
  }
  #check(): void {
    if (this.#closed) canaryFail('TJ1_FENCED');
    try {
      if (this.#fileStamp() !== this.#stamp) canaryFail('TJ1_CHANGED');
    } catch {
      this.#gate.fence();
      canaryFail('TJ1_CHANGED');
    }
  }
  #scan(): void {
    const count = this.#db.prepare('SELECT count(*) AS n FROM events').get()!.n;
    if (typeof count !== 'number' || count > CANARY_LIMITS.events) canaryFail('TJ1_LIMIT');
    const oversized = this.#db
      .prepare('SELECT count(*) AS n FROM events WHERE length(CAST(body AS BLOB))>?')
      .get(CANARY_LIMITS.eventBytes)!.n;
    if (oversized !== 0) canaryFail('TJ1_LIMIT');
    const rows = this.#db.prepare('SELECT sequence,event_id,previous,body,digest FROM events ORDER BY sequence').all();
    let previous = sha256(canonical(this.#meta));
    for (const [i, row] of rows.entries()) {
      if (
        row.sequence !== i + 1 ||
        typeof row.body !== 'string' ||
        Buffer.byteLength(row.body) > CANARY_LIMITS.eventBytes ||
        row.previous !== previous ||
        row.digest !== sha256(previous + '\n' + row.body)
      )
        canaryFail('TJ1_CORRUPT');
      const e = validateCanaryRecord(row.body);
      if (e.sequence !== String(i + 1) || e.eventId !== row.event_id || e.lane !== this.#meta.lane)
        canaryFail('TJ1_CORRUPT');
      if (e.kind === 'PREPARED' && e.data.manifestDigest !== this.#meta.manifestDigest) canaryFail('TJ1_CORRUPT');
      this.#projection = transition(this.#projection, e);
      this.#records.push(e);
      previous = row.digest as string;
      this.#hashes.push(previous);
    }
  }
  append(
    kind: CanaryKind,
    data: Record<string, unknown>,
    source: CanaryRecord['source'],
    receiptDigest: string | null = null,
    eventId = kind + ':' + (this.#records.length + 1),
  ): void {
    this.#gate.check('write');
    this.#check();
    const sequence = this.#records.length + 1,
      input: CanaryRecord = {
        logical: 'tj1-local-canary-v1',
        container: 'sqlite-event-ledger-v1',
        codec: 'identity-json-v1',
        lane: this.#meta.lane,
        sequence: String(sequence),
        eventId,
        kind,
        source,
        receiptDigest,
        data,
      };
    const raw = canonical(input),
      e = validateCanaryRecord(raw);
    const prior = this.#records.find((r) => r.eventId === eventId);
    if (kind === 'PREPARED' && e.data.manifestDigest !== this.#meta.manifestDigest) canaryFail('TJ1_CONFLICT');
    if (prior) {
      const compared = { ...e, sequence: prior.sequence };
      if (canonical(prior) !== canonical(compared)) canaryFail('TJ1_CONFLICT');
      this.#gate.check('write');
      return;
    }
    if (sequence > CANARY_LIMITS.events) canaryFail('TJ1_LIMIT');
    const next = transition(this.#projection, e),
      previous = this.#hashes.at(-1) ?? sha256(canonical(this.#meta)),
      digest = sha256(previous + '\n' + raw);
    this.#gate.check('write');
    this.#check();
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      this.#db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(sequence, eventId, previous, raw, digest);
      this.#db.exec('COMMIT');
    } catch {
      this.#gate.fence();
      return canaryFail('TJ1_COMMIT_UNKNOWN');
    }
    this.#records.push(e);
    this.#hashes.push(digest);
    this.#projection = next;
    try {
      this.#stamp = this.#fileStamp();
    } catch {
      this.#gate.fence();
      return canaryFail('TJ1_COMMIT_UNKNOWN');
    }
    this.#gate.check('write');
    this.#check();
  }
  read() {
    this.#gate.check('read');
    this.#check();
    const result = {
      assurance: 'RECORDED_CLAIMS_ONLY' as const,
      recovery: 'RECONCILE_REQUIRED' as const,
      meta: structuredClone(this.#meta),
      projection: { ...this.#projection },
      head: this.#hashes.at(-1) ?? sha256(canonical(this.#meta)),
      records: structuredClone(this.#records),
    };
    this.#gate.check('read');
    this.#check();
    return result;
  }
  export(): string {
    this.#gate.check('export');
    const result = canonical(this.read());
    this.#gate.check('export');
    return result;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#gate.fence();
    try {
      this.#db.close();
    } finally {
      this.#lock.close();
    }
  }
}
