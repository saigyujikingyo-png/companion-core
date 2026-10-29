import { lstatSync, opendirSync } from 'node:fs';
import type { BigIntStats, Dir } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isProxy } from 'node:util/types';
import { canonicalDirectory, disjoint } from './anchored-codec.ts';
import { CAPACITY_DIRECTORY_ENTRY_LIMIT, freezeCapacity } from './capacity-types.ts';
import type { RetainedRootObservation, RetainedRootsCapacity } from './capacity-types.ts';
import { CoreError, fail, text } from './validation.ts';

export type InspectRetainedRootsRequest = { roots: readonly string[]; entryLimit?: number };

// Copy only data before path I/O; reject proxies before any reflective operation.
function requestData(request: InspectRetainedRootsRequest): { roots: string[]; entryLimit: number } {
  if (request === null || typeof request !== 'object' || isProxy(request)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(request),
    keys = Reflect.ownKeys(descriptors);
  if (!Object.hasOwn(descriptors, 'roots') || keys.some((key) => key !== 'roots' && key !== 'entryLimit'))
    fail('INVALID_INPUT');
  for (const key of keys)
    if (!Object.hasOwn(descriptors[key as keyof typeof descriptors]!, 'value')) fail('INVALID_INPUT');
  const values = descriptors.roots!.value as unknown;
  if (isProxy(values) || !Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype)
    fail('INVALID_INPUT');
  // Array length is intrinsic own data; bound it before enumerating indices.
  const length = Object.getOwnPropertyDescriptor(values, 'length')!.value as number;
  if (length < 1 || length > 8) fail('INVALID_INPUT');
  const entries = Object.getOwnPropertyDescriptors(values) as Record<string, PropertyDescriptor>;
  if (Reflect.ownKeys(entries).length !== length + 1) fail('INVALID_INPUT');
  const roots: string[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = entries[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
    const value: unknown = descriptor.value;
    text(value);
    // Reject original parent traversal before resolve can erase a linked component.
    if (!isAbsolute(value) || value.split(process.platform === 'win32' ? /[\\/]/ : /\//).includes('..'))
      fail('ANCHOR_PATH');
    roots.push(value);
  }
  const limit = descriptors.entryLimit?.value as unknown,
    entryLimit = limit === undefined ? CAPACITY_DIRECTORY_ENTRY_LIMIT : limit;
  if (
    typeof entryLimit !== 'number' ||
    !Number.isSafeInteger(entryLimit) ||
    entryLimit < 1 ||
    entryLimit > CAPACITY_DIRECTORY_ENTRY_LIMIT
  )
    fail('INVALID_INPUT');
  return { roots, entryLimit };
}

type Root = { path: string; canonical: string; stat: BigIntStats };
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameObservation(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function checkedRoot(path: string): Root {
  const ancestors: string[] = [];
  for (let part = path; ; part = dirname(part)) {
    ancestors.push(part);
    if (dirname(part) === part) break;
  }
  let stat: BigIntStats | undefined;
  for (const part of ancestors.reverse()) {
    stat = lstatSync(part, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ANCHOR_PATH');
  }
  const canonical = canonicalDirectory(path),
    current = lstatSync(canonical, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || !sameObservation(stat!, current))
    fail('RETAINED_ROOT_CHANGED');
  return { path, canonical, stat: current };
}
function changed(root: Root): boolean {
  const current = checkedRoot(root.path);
  return current.canonical !== root.canonical || !sameObservation(current.stat, root.stat);
}
function unknown(report: RetainedRootObservation, reason: RetainedRootObservation['reason']): void {
  report.status = 'UNKNOWN';
  report.reason = reason;
}

/** Metadata only. EOF is this enumeration's end, never a snapshot or a custody proof. */
export function inspectRetainedRoots(request: InspectRetainedRootsRequest): RetainedRootsCapacity {
  const { roots, entryLimit } = requestData(request),
    paths = roots.map((root) => resolve(root));
  for (let i = 0; i < paths.length; i++) for (let j = 0; j < i; j++) disjoint(paths[i]!, paths[j]!);
  const reports: RetainedRootObservation[] = roots.map((root) => ({
    root,
    canonicalRoot: null,
    entriesObserved: 0,
    observedBytes: 0,
    status: 'NOT_SCANNED',
    reason: 'ENTRY_LIMIT',
  }));
  const checked: (Root | null)[] = paths.map((path, i) => {
    try {
      const root = checkedRoot(path);
      reports[i]!.canonicalRoot = root.canonical;
      return root;
    } catch (error) {
      if (error instanceof CoreError && error.code === 'ANCHOR_PATH') throw error;
      unknown(
        reports[i]!,
        error instanceof CoreError && error.code === 'RETAINED_ROOT_CHANGED' ? 'ROOT_CHANGED' : 'ROOT_UNAVAILABLE',
      );
      return null;
    }
  });
  // Validate every available root before enumerating any root. Known inode aliases
  // are rejected too; this does not establish physical uniqueness on every FS.
  for (let i = 0; i < checked.length; i++)
    for (let j = 0; j < i; j++) {
      const a = checked[i],
        b = checked[j];
      if (!a || !b) continue;
      disjoint(a.canonical, b.canonical);
      if (a.stat.ino !== 0n && b.stat.ino !== 0n && sameIdentity(a.stat, b.stat)) fail('ANCHOR_CUSTODY_OVERLAP');
    }
  let entriesObserved = 0,
    observedBytes = 0;
  for (let i = 0; i < checked.length; i++) {
    const root = checked[i],
      report = reports[i]!;
    if (!root || entriesObserved === entryLimit) continue;
    let stream: Dir | undefined;
    try {
      try {
        if (changed(root)) {
          unknown(report, 'ROOT_CHANGED');
          continue;
        }
      } catch (error) {
        unknown(report, error instanceof CoreError ? 'ROOT_CHANGED' : 'ROOT_UNAVAILABLE');
        continue;
      }
      try {
        stream = opendirSync(root.canonical, { bufferSize: 1 });
      } catch {
        unknown(report, 'ROOT_UNAVAILABLE');
        continue;
      }
      report.status = 'TRUNCATED';
      while (entriesObserved < entryLimit) {
        const entry = stream.readSync();
        if (entry === null) {
          report.status = 'EOF';
          report.reason = null;
          break;
        }
        entriesObserved++;
        report.entriesObserved++;
        // Count all yielded entries against the common budget, even refused ones.
        try {
          if (changed(root)) {
            unknown(report, 'ROOT_CHANGED');
            break;
          }
        } catch (error) {
          unknown(report, error instanceof CoreError ? 'ROOT_CHANGED' : 'ROOT_UNAVAILABLE');
          break;
        }
        let stat: BigIntStats;
        try {
          stat = lstatSync(join(root.canonical, entry.name), { bigint: true });
        } catch {
          unknown(report, 'ENTRY_UNAVAILABLE');
          break;
        }
        if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) {
          unknown(report, 'UNSAFE_ENTRY');
          break;
        }
        const bytes = Number(stat.size);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(observedBytes + bytes))
          fail('ANCHOR_LIMIT');
        report.observedBytes += bytes;
        observedBytes += bytes;
      }
      if (report.reason === null || report.reason === 'ENTRY_LIMIT') {
        try {
          if (changed(root)) unknown(report, 'ROOT_CHANGED');
        } catch (error) {
          unknown(report, error instanceof CoreError ? 'ROOT_CHANGED' : 'ROOT_UNAVAILABLE');
        }
      }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'ANCHOR_LIMIT') throw error;
      unknown(report, 'IO_ERROR');
    } finally {
      if (stream)
        try {
          stream.closeSync();
        } catch {
          if (report.status !== 'UNKNOWN') unknown(report, 'IO_ERROR');
        }
    }
  }
  return freezeCapacity({ version: 1, entryLimit, entriesObserved, observedBytes, roots: reports });
}
