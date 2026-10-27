import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './store.ts';
import { CoreError, fail, text } from './validation.ts';
import { decodeKey, FORMAT, isRestoreDirectoryName, makeHead, MAX_AUTHORITY, MAX_IMAGE, readAuthority, readCheckpoint, record,
  RESTORE_QUARANTINE, sha, validateHeadPin, validateIdentityBudget } from './durable-codec.ts';
import type { DurableHeadPin } from './durable-codec.ts';

const BACKUP_FORMAT = 'companion-core-m2-current-state-backup-v1';
const MANIFEST = 'manifest.json', AUTHORITY = 'authority.sqlite', CHECKPOINT = 'checkpoint.bin';
const MAX_MANIFEST = 16 * 1024;
type FileEntry = { name: string; bytes: number; sha256: string };
type Manifest = { version: 1; format: typeof BACKUP_FORMAT; scope: 'current-state'; head: DurableHeadPin;
  checkpointName: string; files: [FileEntry, FileEntry] };
export type BackupVerificationOptions = { identity: string; keyBase64: string; maxCalls: number; expectedHead: DurableHeadPin };
export type BackupFault = 'after-authority' | 'after-checkpoint' | 'before-complete';
export type RestoreFault = 'after-directory-create' | 'after-quarantine' | 'after-authority' | 'after-checkpoint' | 'before-complete';
export type BackupVerification = { status: 'BACKUP_VERIFIED'; scope: 'current-state'; head: DurableHeadPin;
  pinPolicy: 'contains-trusted-pin'; schema: 1; consumedRequests: number; revocationHighWater: number };
type Criteria = { identity: string; key: Uint8Array; maxCalls: number; expectedHead: DurableHeadPin };
type Captured = { authority: Uint8Array; checkpoint: Uint8Array };

function fixedError(error: unknown): never {
  if (error instanceof CoreError) throw error;
  fail('DURABLE_BACKUP_IO');
}

/** Reject links in every existing path component; parents must already exist.
 * These APIs require an owner-controlled directory, not hostile concurrent path mutation. */
export function plainDirectory(path: string): string {
  text(path, 4096);
  if (!isAbsolute(path)) fail('DURABLE_BACKUP_PATH');
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('DURABLE_BACKUP_PATH');
  }
  return realpathSync(absolute);
}

function newLeaf(path: string, forbiddenDirectory: string): string {
  text(path, 4096);
  if (!isAbsolute(path) || resolve(path) === parse(resolve(path)).root) fail('DURABLE_BACKUP_PATH');
  const parent = plainDirectory(dirname(resolve(path))), target = join(parent, parse(resolve(path)).base);
  const inside = relative(forbiddenDirectory, target);
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) fail('DURABLE_BACKUP_PATH');
  try { lstatSync(target); fail('DURABLE_TARGET_EXISTS'); }
  catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
  mkdirSync(target, { mode: 0o700 }); // Exclusive leaf creation; never recursive or overwrite.
  return target;
}

/** Bound before allocation and after reading, and do not follow a leaf symlink. */
export function readBoundedFile(path: string, maximum: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('DURABLE_BACKUP_PATH');
  if (before.size < 1 || before.size > maximum) fail('DURABLE_LIMIT');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('DURABLE_BACKUP_CHANGED');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (n === 0) fail('DURABLE_BACKUP_CHANGED');
      offset += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) fail('DURABLE_BACKUP_CHANGED');
    const after = fstatSync(fd), pathAfter = lstatSync(path);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || pathAfter.isSymbolicLink()
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) fail('DURABLE_BACKUP_CHANGED');
    return bytes;
  } finally { closeSync(fd); }
}

function writeNew(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function complete(directory: string, name: string, value: unknown): void {
  // A failed write/fsync leaves only the unaccepted pending filename. Publication
  // is the final operation. No directory power-loss durability is asserted.
  const pending = join(directory, `${name}.pending`);
  writeNew(pending, Buffer.from(JSON.stringify(value)));
  renameSync(pending, join(directory, name));
}

function validateCaptured(bytes: Captured, criteria: Criteria): { result: BackupVerification; checkpointName: string } {
  validateIdentityBudget(criteria.identity, criteria.maxCalls);
  validateHeadPin(criteria.expectedHead, criteria.identity);
  if (bytes.authority.length < 1 || bytes.authority.length > MAX_AUTHORITY || bytes.checkpoint.length > MAX_IMAGE * 2) fail('DURABLE_LIMIT');
  const db = new DatabaseSync(':memory:', { allowExtension: false, enableDoubleQuotedStringLiterals: false });
  let image: Buffer | undefined;
  try {
    if (typeof db.deserialize !== 'function') fail('DURABLE_UNSUPPORTED');
    db.exec('PRAGMA temp_store=MEMORY;');
    db.deserialize(bytes.authority);
    db.enableDefensive(true);
    db.exec('PRAGMA query_only=ON;');
    const chain = readAuthority(db, criteria.key, criteria.identity, criteria.maxCalls, criteria.expectedHead);
    const latest = chain.latest!;
    image = readCheckpoint(bytes.checkpoint, latest, criteria.key, criteria.identity);
    // The no-boot inspector validates this decrypted image in disposable RAM;
    // it does not construct a Store, reset leases/epochs or install persistence.
    const checked = MemoryStore.validateImage(image);
    if (checked.revocationHighWater !== latest.revocationHighWater) fail('DURABLE_CORRUPT');
    return { checkpointName: latest.checkpoint, result: { status: 'BACKUP_VERIFIED', scope: 'current-state',
      head: makeHead(criteria.identity, chain.sequence, chain.previous), pinPolicy: 'contains-trusted-pin',
      schema: checked.schema, consumedRequests: latest.safety.reserved, revocationHighWater: latest.revocationHighWater } };
  } finally { image?.fill(0); db.close(); }
}

function entry(name: string, bytes: Uint8Array): FileEntry { return { name, bytes: bytes.length, sha256: sha(bytes) }; }

/** Internal writer adapter: callers supply a synchronously captured, owned head. */
export function writeCurrentStateBackup(sourceDirectory: string, target: string, bytes: Captured, criteria: Criteria,
  fault?: (point: BackupFault) => void): BackupVerification {
  try {
    const checked = validateCaptured(bytes, criteria);
    if (JSON.stringify(checked.result.head) !== JSON.stringify(criteria.expectedHead)) fail('DURABLE_HEAD_MISMATCH');
    const manifest: Manifest = { version: 1, format: BACKUP_FORMAT, scope: 'current-state', head: checked.result.head,
      checkpointName: checked.checkpointName, files: [entry(AUTHORITY, bytes.authority), entry(CHECKPOINT, bytes.checkpoint)] };
    const directory = newLeaf(target, sourceDirectory);
    writeNew(join(directory, AUTHORITY), bytes.authority); fault?.('after-authority');
    writeNew(join(directory, CHECKPOINT), bytes.checkpoint); fault?.('after-checkpoint');
    fault?.('before-complete'); complete(directory, MANIFEST, manifest);
    return checked.result;
  } catch (error) { return fixedError(error); }
}

function readPackage(directory: string, criteria: Criteria): { bytes: Captured; manifest:Buffer;directory:string;result: BackupVerification; checkpointName: string } {
  const canonical = plainDirectory(directory), dir = opendirSync(canonical), names: string[] = [];
  try {
    for (let item = dir.readSync(); item !== null; item = dir.readSync()) {
      names.push(item.name);
      if (names.length > 3) fail('DURABLE_BACKUP_MANIFEST');
    }
  } finally { dir.closeSync(); }
  if (names.sort().join(',') !== [AUTHORITY, CHECKPOINT, MANIFEST].sort().join(',')) fail('DURABLE_BACKUP_INCOMPLETE');
  let value: unknown;const manifest=readBoundedFile(join(canonical, MANIFEST), MAX_MANIFEST);
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest)); }
  catch (error) { if (error instanceof CoreError) throw error; fail('DURABLE_BACKUP_MANIFEST'); }
  if (!record(value) || Object.keys(value).sort().join(',') !== 'checkpointName,files,format,head,scope,version'
    || value.version !== 1 || value.format !== BACKUP_FORMAT || value.scope !== 'current-state'
    || typeof value.checkpointName !== 'string' || !/^checkpoint-[1-9][0-9]*-[a-f0-9-]{36}\.bin$/.test(value.checkpointName)
    || !Array.isArray(value.files) || value.files.length !== 2) fail('DURABLE_BACKUP_MANIFEST');
  validateHeadPin(value.head, criteria.identity);
  const files: Buffer[] = [];
  for (const [index, name, limit] of [[0, AUTHORITY, MAX_AUTHORITY], [1, CHECKPOINT, MAX_IMAGE * 2]] as const) {
    const file = value.files[index];
    if (!record(file) || Object.keys(file).sort().join(',') !== 'bytes,name,sha256' || file.name !== name
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > limit
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('DURABLE_BACKUP_MANIFEST');
    const bytes = readBoundedFile(join(canonical, name), limit);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) fail('DURABLE_BACKUP_HASH');
    files.push(bytes);
  }
  const bytes = { authority: files[0]!, checkpoint: files[1]! }, checked = validateCaptured(bytes, criteria);
  const head = checked.result.head;
  if (head.sequence !== value.head.sequence || head.authoritySha256 !== value.head.authoritySha256 || checked.checkpointName !== value.checkpointName) fail('DURABLE_HEAD_MISMATCH');
  return { bytes,manifest,directory:canonical, ...checked };
}
/** Internal migration adapter. One immutable capture, still fully validated by
 * the existing M2 backup contract. It neither opens nor boots a live source. */
export function captureVerifiedM2Package(directory:string,criteria:Criteria):ReturnType<typeof readPackage>{return readPackage(directory,criteria);}

function withCriteria<T>(options: BackupVerificationOptions, body: (criteria: Criteria) => T): T {
  let key: Buffer | undefined;
  try {
    validateIdentityBudget(options.identity, options.maxCalls);
    validateHeadPin(options.expectedHead, options.identity); // Mandatory, independently supplied; never trust manifest.head as an anchor.
    key = decodeKey(options.keyBase64);
    return body({ identity: options.identity, maxCalls: options.maxCalls, expectedHead: structuredClone(options.expectedHead), key });
  } catch (error) { return fixedError(error); }
  finally { key?.fill(0); }
}

/** Disk read-only: neither source nor package is opened as a live DurableMemory. */
export function verifyDurableBackup(directory: string, options: BackupVerificationOptions): BackupVerification {
  return withCriteria(options, criteria => readPackage(directory, criteria).result);
}

/** No activation or fencing bypass. A separate future protocol must fence the
 * original owner and transfer quota authority before any clone can become live. */
export function stageDurableRestore(directory: string, target: string, options: BackupVerificationOptions,
  hooks: { fault?: (point: RestoreFault) => void } = {}): Omit<BackupVerification, 'status'> & { status: 'RESTORE_VERIFIED_NOT_ACTIVATED' } {
  return withCriteria(options, criteria => {
    text(target, 4096);
    if (!isRestoreDirectoryName(basename(resolve(target)))) fail('DURABLE_RESTORE_NAME_REQUIRED');
    const captured = readPackage(directory, criteria); // Fully verify before target creation; no second, racy read.
    const output = newLeaf(target, plainDirectory(directory));
    hooks.fault?.('after-directory-create'); // Even this empty directory is unbootable by its reserved name.
    try { writeNew(join(output, RESTORE_QUARANTINE), Buffer.from('RESTORE_NOT_ACTIVATED')); }
    catch (error) {
      // If exclusive marker creation failed before a file existed, remove only
      // our just-created empty leaf. A partial marker itself still blocks boot.
      try { rmdirSync(output); } catch { /* Nonempty means quarantine marker exists. */ }
      throw error;
    }
    hooks.fault?.('after-quarantine');
    writeNew(join(output, AUTHORITY), captured.bytes.authority); hooks.fault?.('after-authority');
    writeNew(join(output, captured.checkpointName), captured.bytes.checkpoint); hooks.fault?.('after-checkpoint');
    writeNew(join(output, 'M2.v1.claimed'), Buffer.from(FORMAT));
    const result = { ...captured.result, status: 'RESTORE_VERIFIED_NOT_ACTIVATED' as const };
    hooks.fault?.('before-complete'); complete(output, 'restore-verified.json', result);
    return result;
  });
}
