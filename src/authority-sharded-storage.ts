import { existsSync, lstatSync, mkdirSync, opendirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { disjoint } from './anchored-codec.ts';
import { sha } from './durable-codec.ts';
import { fail } from './validation.ts';
import { COLD_LIMITS, closed, json, parsed, safeSum, emptyCounts, validateMoved } from './authority-cold-format.ts';
import type { Workspace, Release, Counts } from './authority-cold-format.ts';
import { safeDirectory, readOwned, exclusive, slotNames } from './authority-cold-storage.ts';
import { SHARD_LIMITS, ShardDatabase, manifest, shardRequest, current, digest } from './authority-sharded-format.ts';
import type {
  FileRef,
  ShardManifest,
  ShardReservation,
  ShardCurrent,
  ShardIntent,
} from './authority-sharded-format.ts';

export type ShardPhysical = {
  rootBytes: number;
  journalBytes: number;
  journalPresent: boolean;
  retainedBytes: number;
  files: number;
  entries: Map<string, number>;
};
export function inspectShardFiles(directory: string): ShardPhysical {
  safeDirectory(directory);
  const entries = new Map<string, number>();
  let rootBytes = 0,
    journalBytes = 0,
    journalPresent = false,
    retainedBytes = 0,
    files = 0;
  const dir = opendirSync(directory);
  try {
    for (;;) {
      const e = dir.readSync();
      if (!e) break;
      if (++files > 32) fail('ANCHOR_SHARD_FILES');
      const st = lstatSync(join(directory, e.name)),
        root = e.name === 'authority.sqlite',
        journal = e.name === 'authority.sqlite-journal';
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        (!root && !journal && st.nlink !== 1) ||
        !Number.isSafeInteger(st.size) ||
        st.size < 0
      )
        fail('ANCHOR_COLD_FILE');
      if (root || journal) {
        if (st.size > COLD_LIMITS.shared) fail('ANCHOR_COLD_BOUND');
        if (root) rootBytes = st.size;
        else {
          journalBytes = st.size;
          journalPresent = true;
        }
        continue;
      }
      if (
        !/^cold-slot-[0-3]\.(intent\.json|sqlite)$/.test(e.name) &&
        !/^cold-v2-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(\.intent\.json|-[01]\.sqlite)$/.test(
          e.name,
        )
      )
        fail('ANCHOR_SHARD_FILES');
      if (st.size > (e.name.endsWith('.sqlite') ? 1048576 : 8192)) fail('ANCHOR_COLD_BOUND');
      entries.set(e.name, st.size);
      retainedBytes = safeSum(retainedBytes, st.size);
    }
  } finally {
    dir.closeSync();
  }
  if (
    rootBytes < 100 ||
    retainedBytes > SHARD_LIMITS.retained ||
    safeSum(rootBytes, journalBytes, retainedBytes, COLD_LIMITS.workspace) > COLD_LIMITS.shared
  )
    fail('ANCHOR_COLD_BOUND');
  return { rootBytes, journalBytes, journalPresent, retainedBytes, files, entries };
}
export function requiredFiles(m: ShardManifest): FileRef[] {
  if (!m.current) return [];
  if (m.current.format === 'two-shards-v2') return [m.current.intent, ...m.current.parts];
  const d = m.current.descriptor,
    n = slotNames(d.slot);
  return [
    { name: n.intent, bytes: d.intentBytes, sha256: d.intentDigest },
    { name: n.payload, bytes: d.payloadBytes, sha256: d.payloadDigest },
  ];
}
/** Missing current files and every not-yet-written reserved byte remain obligations. */
export function obligations(
  p: ShardPhysical,
  m: ShardManifest,
  r: ShardReservation | null,
): { bytes: number; files: number; missingBytes: number } {
  const expected = new Map<string, FileRef>();
  for (const f of [...requiredFiles(m), ...(r ? r.plans.flatMap((a) => [a.intent, ...a.parts]) : [])]) {
    const old = expected.get(f.name);
    if (old && json(old, 1024) !== json(f, 1024)) fail('ANCHOR_SHARD_RESERVATION');
    expected.set(f.name, f);
  }
  let bytes = p.retainedBytes,
    files = p.files,
    missingBytes = 0;
  for (const f of expected.values()) {
    const actual = p.entries.get(f.name);
    const extra = Math.max(0, f.bytes - (actual ?? 0));
    bytes = safeSum(bytes, extra);
    missingBytes += extra;
    if (actual === undefined) files++;
  }
  // The optional rollback journal always retains its directory-entry allowance.
  if (!p.journalPresent) files++;
  if (bytes > SHARD_LIMITS.retained || files > SHARD_LIMITS.files) fail('ANCHOR_SHARD_CAPACITY');
  return { bytes, files, missingBytes };
}
export function verifyFile(directory: string, f: FileRef, w: Workspace): ReturnType<typeof readOwned> {
  const raw = readOwned(join(directory, f.name), f.name.endsWith('.sqlite') ? 1048576 : 8192, w);
  if (raw.bytes.length !== f.bytes || sha(raw.bytes) !== f.sha256) {
    raw.close();
    fail('ANCHOR_COLD_DIGEST');
  }
  return raw;
}
export type LoadedShards = { dbs: [ShardDatabase, ShardDatabase]; intent: ShardIntent; close: Release };
export function loadShards(directory: string, m: ShardManifest, w: Workspace, packageFiles = false): LoadedShards {
  manifest(m);
  if (m.current?.format !== 'two-shards-v2') fail('ANCHOR_SHARD_FORMAT');
  const c = m.current;
  current(c);
  const release = w.reserve(65536, 'v2 manifest intent and metadata');
  let raw: ReturnType<typeof readOwned> | undefined;
  const dbs: ShardDatabase[] = [];
  const read = (f: FileRef) =>
    verifyFile(
      directory,
      packageFiles
        ? { ...f, name: f === c.intent ? 'intent.json' : f === c.parts[0] ? 'part-0.sqlite' : 'part-1.sqlite' }
        : f,
      w,
    );
  try {
    raw = read(c.intent);
    const i = parsed(raw.bytes) as ShardIntent;
    closed(i, [
      'format',
      'version',
      'attemptId',
      'request',
      'authorityId',
      'custodyDomain',
      'sourceSnapshotDigest',
      'selectionDigest',
      'moved',
      'parts',
      'counts',
    ]);
    shardRequest(i.request);
    validateMoved(i.moved);
    digest(i.sourceSnapshotDigest);
    digest(i.selectionDigest);
    if (
      i.format !== 'companion-authority-shard-intent-v2' ||
      i.version !== 2 ||
      i.attemptId !== c.attemptId ||
      i.authorityId !== m.authorityId ||
      i.custodyDomain !== m.custodyDomain ||
      i.request.expectedRouteEpoch + 1 !== m.epoch ||
      i.request.expectedManifestDigest !== m.parentManifestDigest ||
      i.sourceSnapshotDigest !== m.sourceSnapshotDigest ||
      i.selectionDigest !== m.selectionDigest ||
      json(i.parts, 4096) !== json(c.parts, 4096) ||
      json(i.counts, 1024) !== json(c.counts, 1024) ||
      json(i, 8192) !== raw.bytes.toString('utf8')
    )
      fail('ANCHOR_SHARD_BINDING');
    raw.close();
    raw = undefined;
    const total = emptyCounts();
    for (const part of [0, 1] as const) {
      raw = read(c.parts[part]);
      const db = ShardDatabase.open(raw.bytes, w);
      dbs.push(db);
      raw.close();
      raw = undefined;
      const meta = db.meta;
      if (
        meta.authorityId !== m.authorityId ||
        meta.custodyDomain !== m.custodyDomain ||
        meta.operationId !== i.request.operationId ||
        meta.requestDigest !== sha(json(i.request, 1024)) ||
        meta.fromEpoch !== i.request.expectedRouteEpoch ||
        meta.toEpoch !== m.epoch ||
        meta.partition !== part ||
        meta.sourceSnapshotDigest !== i.sourceSnapshotDigest ||
        meta.selectionDigest !== i.selectionDigest
      )
        fail('ANCHOR_SHARD_BINDING');
      for (const key of Object.keys(total) as (keyof Counts)[]) total[key] += meta.counts[key];
    }
    if (json(total, 1024) !== json(c.counts, 1024)) fail('ANCHOR_COLD_COUNTS');
    return {
      dbs: dbs as [ShardDatabase, ShardDatabase],
      intent: i,
      close: () => {
        for (const db of dbs) db.close();
        release();
      },
    };
  } catch (e) {
    raw?.close();
    for (const db of dbs) db.close();
    release();
    throw e;
  }
}
export function stageState(directory: string, c: ShardCurrent, w: Workspace): 'absent' | 'partial' | 'complete' {
  const refs = [c.intent, ...c.parts],
    present = refs.filter((f) => existsSync(join(directory, f.name)));
  if (!present.length) return 'absent';
  for (const f of present) {
    const size = lstatSync(join(directory, f.name)).size;
    if (size > f.bytes) fail('ANCHOR_SHARD_STAGE');
    if (size === f.bytes) {
      const raw = verifyFile(directory, f, w);
      raw.close();
    }
  }
  if (present.length !== 3 || present.some((f) => lstatSync(join(directory, f.name)).size !== f.bytes))
    return 'partial';
  return 'complete';
}
type PackageManifest = {
  format: 'companion-authority-closure-v2';
  version: 2;
  manifest: ShardManifest;
  files: FileRef[];
};
export function readShardClosure(
  directory: string,
  expected: ShardManifest,
  w: Workspace,
): {
  manifest: ShardManifest;
  intent: ReturnType<typeof readOwned>;
  parts: [ReturnType<typeof readOwned>, ReturnType<typeof readOwned>];
  close: Release;
} {
  safeDirectory(directory);
  const dir = opendirSync(directory),
    names: string[] = [];
  try {
    for (;;) {
      const e = dir.readSync();
      if (!e) break;
      if (names.length === 4) fail('ANCHOR_COLD_PACKAGE');
      names.push(e.name);
    }
  } finally {
    dir.closeSync();
  }
  const shape = names.sort().join('|');
  if (shape === 'closure.json|intent.json|payload.sqlite') fail('ANCHOR_COLD_PACKAGE_STALE');
  if (shape !== 'closure.json|intent.json|part-0.sqlite|part-1.sqlite') fail('ANCHOR_COLD_PACKAGE');
  const release = w.reserve(196608, 'v2 closure manifest and parse');
  let metadata: ReturnType<typeof readOwned> | undefined;
  const content: ReturnType<typeof readOwned>[] = [];
  try {
    metadata = readOwned(join(directory, 'closure.json'), 65536, w);
    const p = parsed(metadata.bytes) as PackageManifest;
    closed(p, ['format', 'version', 'manifest', 'files']);
    manifest(p.manifest);
    if (
      p.format !== 'companion-authority-closure-v2' ||
      p.version !== 2 ||
      json(p.manifest, 8192) !== json(expected, 8192) ||
      expected.current?.format !== 'two-shards-v2'
    )
      fail('ANCHOR_COLD_PACKAGE_STALE');
    const refs = [expected.current.intent, ...expected.current.parts],
      local = ['intent.json', 'part-0.sqlite', 'part-1.sqlite'];
    const expectedFiles = refs.map((f, i) => ({ ...f, name: local[i]! }));
    if (json(p.files, 8192) !== json(expectedFiles, 8192) || json(p, 65536) !== metadata.bytes.toString('utf8'))
      fail('ANCHOR_COLD_PACKAGE');
    let total = metadata.bytes.length;
    for (const f of expectedFiles) {
      const raw = readOwned(join(directory, f.name), f.name.endsWith('.sqlite') ? 1048576 : 8192, w);
      content.push(raw);
      total += raw.bytes.length;
      if (raw.bytes.length !== f.bytes || sha(raw.bytes) !== f.sha256) fail('ANCHOR_COLD_DIGEST');
    }
    if (total > SHARD_LIMITS.closure) fail('ANCHOR_COLD_BOUND');
    // The caller also validates the complete root business closure before repair.
    return {
      manifest: p.manifest,
      intent: content[0]!,
      parts: [content[1]!, content[2]!],
      close: () => {
        for (const raw of content) raw.close();
        release();
      },
    };
  } catch (e) {
    for (const raw of content) raw.close();
    release();
    throw e;
  } finally {
    metadata?.close();
  }
}
export function exportShardClosure(directory: string, target: string, m: ShardManifest, w: Workspace): void {
  safeDirectory(dirname(resolve(target)));
  disjoint(directory, resolve(target));
  if (existsSync(target)) fail('ANCHOR_COLD_TARGET_EXISTS');
  if (m.current?.format !== 'two-shards-v2') fail('ANCHOR_SHARD_FORMAT');
  const refs = [m.current.intent, ...m.current.parts],
    names = ['intent.json', 'part-0.sqlite', 'part-1.sqlite'];
  const p: PackageManifest = {
    format: 'companion-authority-closure-v2',
    version: 2,
    manifest: m,
    files: refs.map((f, i) => ({ ...f, name: names[i]! })),
  };
  const encoded = json(p, 65536),
    release = w.reserve(Buffer.byteLength(encoded) * 2, 'v2 closure output metadata');
  try {
    mkdirSync(target);
    exclusive(join(target, 'closure.json'), Buffer.from(encoded));
    for (const [i, f] of refs.entries()) {
      const raw = verifyFile(directory, f, w);
      try {
        exclusive(join(target, names[i]!), raw.bytes);
      } finally {
        raw.close();
      }
    }
    const check = readShardClosure(target, m, w);
    check.close();
  } finally {
    release();
  }
}
