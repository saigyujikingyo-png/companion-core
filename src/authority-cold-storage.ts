import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { canonicalDirectory, disjoint } from './anchored-codec.ts';
import { sha } from './durable-codec.ts';
import { fail } from './validation.ts';
import {
  COLD_LIMITS,
  ColdDatabase,
  closed,
  json,
  parsed,
  safeSum,
  validateDescriptor,
  validateIntent,
  descriptorOf,
  metaOf,
} from './authority-cold-format.ts';
import type { Workspace, Release, Descriptor, Intent, ColdRequest } from './authority-cold-format.ts';

/** One pool per public operation, shared by nested guards, builders, readers and exports. */
export class ColdWorkspace implements Workspace {
  #used = 0;
  #peak = 0;
  readonly limit: number;
  constructor(limit: number = COLD_LIMITS.workspace) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > COLD_LIMITS.workspace) fail('ANCHOR_COLD_WORKSPACE');
    this.limit = limit;
  }
  get used(): number {
    return this.#used;
  }
  get peak(): number {
    return this.#peak;
  }
  reserve(bytes: number, _label: string): Release {
    const next = safeSum(this.#used, bytes);
    if (next > this.limit) fail('ANCHOR_COLD_WORKSPACE');
    this.#used = next;
    this.#peak = Math.max(this.#peak, next);
    let live = true;
    return () => {
      if (live) {
        live = false;
        this.#used -= bytes;
      }
    };
  }
}
export type Physical = {
  rootBytes: number;
  journalBytes: number;
  slots: { slot: number; intentBytes: number; payloadBytes: number }[];
  retainedBytes: number;
  files: number;
  occupiedSlots: number;
};
export function safeDirectory(path: string): string {
  let p = resolve(path);
  for (;;) {
    const st = lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('ANCHOR_COLD_PATH');
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return canonicalDirectory(path);
}
function fileStat(path: string, max: number, cold = true) {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    (cold && s.nlink !== 1) ||
    !Number.isSafeInteger(s.size) ||
    s.size < 0 ||
    s.size > max
  )
    fail('ANCHOR_COLD_FILE');
  return s;
}
function statFile(path: string, max: number, cold = true): number {
  return fileStat(path, max, cold).size;
}
export function slotNames(slot: number): { intent: string; payload: string } {
  if (!Number.isInteger(slot) || slot < 0 || slot > 3) fail('ANCHOR_COLD_FORMAT');
  return { intent: `cold-slot-${slot}.intent.json`, payload: `cold-slot-${slot}.sqlite` };
}
export function inspectFiles(directory: string, allowMissingCurrent = false): Physical {
  safeDirectory(directory);
  const slots = Array.from({ length: 4 }, (_, slot) => ({ slot, intentBytes: 0, payloadBytes: 0 }));
  let rootBytes = 0,
    journalBytes = 0,
    files = 0;
  const occupied = new Set<number>();
  const dir = opendirSync(directory);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (++files > 10) fail('ANCHOR_COLD_FILES');
      const path = join(directory, entry.name);
      if (entry.name === 'authority.sqlite') {
        rootBytes = statFile(path, COLD_LIMITS.shared, false);
        continue;
      }
      if (entry.name === 'authority.sqlite-journal') {
        journalBytes = statFile(path, COLD_LIMITS.shared, false);
        continue;
      }
      const match = /^cold-slot-([0-3])\.(intent\.json|sqlite)$/.exec(entry.name);
      if (!match) fail('ANCHOR_COLD_FILES');
      const slot = Number(match[1]),
        intent = match[2] === 'intent.json';
      occupied.add(slot);
      slots[slot]![intent ? 'intentBytes' : 'payloadBytes'] = statFile(path, intent ? 8192 : 1048576);
    }
  } finally {
    dir.closeSync();
  }
  if (rootBytes < 100 && !allowMissingCurrent) fail('ANCHOR_COLD_FILE');
  const retainedBytes = slots.reduce((n, s) => safeSum(n, s.intentBytes, s.payloadBytes), 0);
  if (
    retainedBytes > COLD_LIMITS.retained ||
    safeSum(rootBytes, journalBytes, COLD_LIMITS.retained, COLD_LIMITS.workspace) > COLD_LIMITS.shared
  )
    fail('ANCHOR_COLD_BOUND');
  return { rootBytes, journalBytes, slots, retainedBytes, files, occupiedSlots: occupied.size };
}
/** Never read the entire authority root into a temporary buffer. */
export function rootHeader(path: string): { version: number; bytes: number } {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 100 || st.size > COLD_LIMITS.shared) fail('ANCHOR_FILE');
  const bytes = st.size,
    w = new ColdWorkspace(),
    release = w.reserve(100, 'fixed root header'),
    b = Buffer.alloc(100),
    fd = openSync(path, 'r');
  try {
    if (readSync(fd, b, 0, 100, 0) !== 100 || b.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000')
      fail('ANCHOR_FILE');
    return { version: b.readUInt32BE(60), bytes };
  } finally {
    closeSync(fd);
    b.fill(0);
    release();
  }
}
export type OwnedBytes = { bytes: Buffer; close: Release };
/** Stage verification keeps the old file limit without allocating a whole v2 stage. */
export function hashFileBounded(path: string, maximum: number, w: Workspace): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail('ANCHOR_FILE');
  const release = w.reserve(Math.min(65536, Math.max(1, before.size)) + 1024, 'bounded stage hash chunk and digest'),
    chunk = Buffer.alloc(Math.min(65536, Math.max(1, before.size)));
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('ANCHOR_FILE');
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < before.size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (n < 1) fail('ANCHOR_FILE');
      hash.update(chunk.subarray(0, n));
      offset += n;
    }
    if (readSync(fd, chunk, 0, 1, offset) !== 0) fail('ANCHOR_FILE');
    const after = fstatSync(fd),
      current = lstatSync(path);
    if (
      after.size !== before.size ||
      current.size !== before.size ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      !current.isFile() ||
      current.isSymbolicLink()
    )
      fail('ANCHOR_FILE');
    return hash.digest('hex');
  } finally {
    if (fd !== undefined) closeSync(fd);
    chunk.fill(0);
    release();
  }
}
export function readOwned(path: string, max: number, w: Workspace): OwnedBytes {
  const before = fileStat(path, max),
    n = before.size,
    release = w.reserve(safeSum(n, 1), 'file read buffer and growth probe');
  let bytes: Buffer | undefined, fd: number | undefined;
  const probe = Buffer.alloc(1);
  try {
    bytes = Buffer.alloc(n);
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== n || opened.nlink !== 1)
      fail('ANCHOR_COLD_FILE');
    let offset = 0;
    while (offset < n) {
      const got = readSync(fd, bytes, offset, n - offset, offset);
      if (got < 1) fail('ANCHOR_COLD_FILE');
      offset += got;
    }
    if (readSync(fd, probe, 0, 1, n) !== 0) fail('ANCHOR_COLD_FILE');
    const after = fstatSync(fd),
      current = fileStat(path, max);
    if (
      after.size !== n ||
      current.size !== n ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      after.nlink !== 1
    )
      fail('ANCHOR_COLD_FILE');
    const owned = bytes;
    return {
      bytes: owned,
      close: () => {
        owned.fill(0);
        release();
      },
    };
  } catch (e) {
    bytes?.fill(0);
    release();
    throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
    probe.fill(0);
  }
}
export function exclusive(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function loadCurrent(
  directory: string,
  d: Descriptor,
  w: Workspace,
): { db: ColdDatabase; intent: Intent; close: Release } {
  validateDescriptor(d);
  const names = slotNames(d.slot);
  let intentBytes: OwnedBytes | undefined, payload: OwnedBytes | undefined, db: ColdDatabase | undefined;
  const metadata = w.reserve(32768, 'current intent and descriptor JSON representations');
  try {
    intentBytes = readOwned(join(directory, names.intent), 8192, w);
    payload = readOwned(join(directory, names.payload), 1048576, w);
    if (
      intentBytes.bytes.length !== d.intentBytes ||
      sha(intentBytes.bytes) !== d.intentDigest ||
      payload.bytes.length !== d.payloadBytes ||
      sha(payload.bytes) !== d.payloadDigest
    )
      fail('ANCHOR_COLD_DIGEST');
    const intent = parsed(intentBytes.bytes) as Intent;
    validateIntent(intent);
    if (
      json(intent, 8192) !== intentBytes.bytes.toString('utf8') ||
      JSON.stringify(descriptorOf(intent, intentBytes.bytes)) !== JSON.stringify(d)
    )
      fail('ANCHOR_COLD_FORMAT');
    db = ColdDatabase.open(payload.bytes, w);
    if (JSON.stringify(db.meta) !== JSON.stringify(metaOf(intent))) fail('ANCHOR_COLD_FORMAT');
    const owned = db;
    db = undefined;
    return {
      db: owned,
      intent,
      close: () => {
        owned.close();
        metadata();
      },
    };
  } catch (e) {
    db?.close();
    metadata();
    throw e;
  } finally {
    intentBytes?.close();
    payload?.close();
  }
}
export type Stage = { intent: Intent; descriptor: Descriptor };
/** Committed-ID lookup belongs to the caller and MUST precede this scan at every relock. */
export function findStage(directory: string, request: ColdRequest, w: Workspace): Stage | null {
  inspectFiles(directory);
  let found: Stage | null = null;
  for (let slot = 0; slot < 4; slot++) {
    const names = slotNames(slot),
      ip = join(directory, names.intent),
      pp = join(directory, names.payload);
    if (!existsSync(ip)) {
      if (existsSync(pp)) fail('ANCHOR_COLD_STAGE_INCOMPLETE');
      continue;
    }
    let raw: OwnedBytes | undefined;
    const ticket = w.reserve(32768, 'stage JSON');
    try {
      raw = readOwned(ip, 8192, w);
      const intent = parsed(raw.bytes) as Intent;
      validateIntent(intent);
      if (intent.slot !== slot || json(intent, 8192) !== raw.bytes.toString('utf8'))
        fail('ANCHOR_COLD_STAGE_INCOMPLETE');
      if (intent.request.operationId === request.operationId) {
        if (JSON.stringify(intent.request) !== JSON.stringify(request)) fail('ANCHOR_COLD_CONFLICT');
        if (found) fail('ANCHOR_COLD_STAGE_AMBIGUOUS');
        if (!existsSync(pp)) fail('ANCHOR_COLD_STAGE_INCOMPLETE');
        const d = descriptorOf(intent, raw.bytes),
          current = loadCurrent(directory, d, w);
        current.close();
        found = { intent, descriptor: d };
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ANCHOR_COLD_CONFLICT' || code === 'ANCHOR_COLD_STAGE_AMBIGUOUS' || code === 'ANCHOR_COLD_WORKSPACE')
        throw e;
      fail('ANCHOR_COLD_STAGE_INCOMPLETE');
    } finally {
      raw?.close();
      ticket();
    }
  }
  return found;
}
export function writeStage(
  directory: string,
  intentFor: (slot: number) => Intent,
  payload: Uint8Array,
  w: Workspace,
): Stage {
  inspectFiles(directory);
  for (let slot = 0; slot < 4; slot++) {
    const names = slotNames(slot),
      intent = intentFor(slot);
    validateIntent(intent);
    const text = json(intent, 8192),
      ticket = w.reserve(Buffer.byteLength(text) * 2, 'intent string and write bytes');
    const bytes = Buffer.from(text);
    try {
      try {
        exclusive(join(directory, names.intent), bytes);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      exclusive(join(directory, names.payload), payload);
      const descriptor = descriptorOf(intent, bytes),
        check = loadCurrent(directory, descriptor, w);
      check.close();
      return { intent, descriptor };
    } finally {
      bytes.fill(0);
      ticket();
    }
  }
  fail('ANCHOR_COLD_SLOTS_FULL');
}
type ClosureManifest = {
  format: 'companion-authority-cold-closure-v1';
  version: 1;
  authorityId: string;
  custodyDomain: string;
  descriptor: Descriptor;
  files: { name: 'intent.json' | 'payload.sqlite'; bytes: number; sha256: string }[];
};
export type ClosurePackage = {
  manifest: ClosureManifest;
  intent: OwnedBytes;
  payload: OwnedBytes;
  db: ColdDatabase;
  close: Release;
};
export function readClosure(
  directory: string,
  d: Descriptor,
  authorityId: string,
  custodyDomain: string,
  w: Workspace,
): ClosurePackage {
  safeDirectory(directory);
  const dir = opendirSync(directory),
    names: string[] = [];
  try {
    for (;;) {
      const e = dir.readSync();
      if (!e) break;
      names.push(e.name);
      if (names.length > 3) fail('ANCHOR_COLD_PACKAGE');
    }
  } finally {
    dir.closeSync();
  }
  if (names.sort().join('|') !== 'closure.json|intent.json|payload.sqlite') fail('ANCHOR_COLD_PACKAGE');
  let raw: OwnedBytes | undefined,
    intent: OwnedBytes | undefined,
    payload: OwnedBytes | undefined,
    db: ColdDatabase | undefined;
  const metadata = w.reserve(3 * COLD_LIMITS.manifest, 'closure manifest and decoded metadata');
  try {
    raw = readOwned(join(directory, 'closure.json'), 65536, w);
    const manifest = parsed(raw.bytes) as ClosureManifest;
    closed(manifest, ['format', 'version', 'authorityId', 'custodyDomain', 'descriptor', 'files']);
    validateDescriptor(manifest.descriptor);
    if (
      manifest.format !== 'companion-authority-cold-closure-v1' ||
      manifest.version !== 1 ||
      manifest.authorityId !== authorityId ||
      manifest.custodyDomain !== custodyDomain ||
      JSON.stringify(manifest.descriptor) !== JSON.stringify(d)
    )
      fail('ANCHOR_COLD_PACKAGE_STALE');
    intent = readOwned(join(directory, 'intent.json'), 8192, w);
    payload = readOwned(join(directory, 'payload.sqlite'), 1048576, w);
    if (safeSum(raw.bytes.length, intent.bytes.length, payload.bytes.length) > COLD_LIMITS.closure)
      fail('ANCHOR_COLD_BOUND');
    const expected = [
      { name: 'intent.json', bytes: intent.bytes.length, sha256: sha(intent.bytes) },
      { name: 'payload.sqlite', bytes: payload.bytes.length, sha256: sha(payload.bytes) },
    ];
    if (
      JSON.stringify(manifest.files) !== JSON.stringify(expected) ||
      intent.bytes.length !== d.intentBytes ||
      sha(intent.bytes) !== d.intentDigest ||
      payload.bytes.length !== d.payloadBytes ||
      sha(payload.bytes) !== d.payloadDigest
    )
      fail('ANCHOR_COLD_DIGEST');
    const i = parsed(intent.bytes) as Intent;
    validateIntent(i);
    if (
      json(i, 8192) !== intent.bytes.toString('utf8') ||
      JSON.stringify(descriptorOf(i, intent.bytes)) !== JSON.stringify(d)
    )
      fail('ANCHOR_COLD_FORMAT');
    db = ColdDatabase.open(payload.bytes, w);
    if (JSON.stringify(db.meta) !== JSON.stringify(metaOf(i))) fail('ANCHOR_COLD_FORMAT');
    const ownedI = intent,
      ownedP = payload,
      ownedDB = db;
    intent = payload = undefined;
    db = undefined;
    return {
      manifest,
      intent: ownedI,
      payload: ownedP,
      db: ownedDB,
      close: () => {
        ownedDB.close();
        ownedI.close();
        ownedP.close();
        metadata();
      },
    };
  } catch (e) {
    intent?.close();
    payload?.close();
    db?.close();
    metadata();
    throw e;
  } finally {
    raw?.close();
  }
}
export function exportClosure(
  directory: string,
  target: string,
  d: Descriptor,
  authorityId: string,
  custodyDomain: string,
  w: Workspace,
): void {
  const parent = safeDirectory(dirname(resolve(target)));
  if (join(parent, resolve(target).slice(dirname(resolve(target)).length + 1)) !== resolve(target))
    fail('ANCHOR_COLD_PATH');
  disjoint(directory, resolve(target));
  if (existsSync(target)) fail('ANCHOR_COLD_TARGET_EXISTS');
  const names = slotNames(d.slot),
    intent = readOwned(join(directory, names.intent), 8192, w);
  let payload: OwnedBytes | undefined;
  let output: Release | undefined;
  try {
    payload = readOwned(join(directory, names.payload), 1048576, w);
    const manifest: ClosureManifest = {
      format: 'companion-authority-cold-closure-v1',
      version: 1,
      authorityId,
      custodyDomain,
      descriptor: d,
      files: [
        { name: 'intent.json', bytes: intent.bytes.length, sha256: sha(intent.bytes) },
        { name: 'payload.sqlite', bytes: payload.bytes.length, sha256: sha(payload.bytes) },
      ],
    };
    const text = json(manifest, 65536);
    output = w.reserve(
      safeSum(Buffer.byteLength(text) * 2, intent.bytes.length, payload.bytes.length),
      'closure output files and manifest',
    );
    mkdirSync(target);
    exclusive(join(target, 'closure.json'), Buffer.from(text));
    exclusive(join(target, 'intent.json'), intent.bytes);
    exclusive(join(target, 'payload.sqlite'), payload.bytes);
    const check = readClosure(target, d, authorityId, custodyDomain, w);
    check.close();
  } finally {
    payload?.close();
    intent.close();
    output?.();
  }
}
