import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { constants as z, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { types } from 'node:util';
import {
  canonicalTrainingEvent,
  parseTrainingEvent,
  reduceTrainingEvent,
  TJ_LIMITS,
  tjAttemptKey,
  tjCounter,
  tjEventKey,
  tjFail,
  tjHash,
  tjId,
  TrainingJournalError,
} from './training-journal-format.ts';
import type { AttemptProjection, TrainingEvent } from './training-journal-format.ts';

export type TrainingAuthority = {
  scopeId: string;
  generation: string;
  consentRevision: string;
  runtimeId: string;
  now: number;
  expiresAt: number;
  read: boolean;
  write: boolean;
  export: boolean;
};
export type TrainingJournalOptions = {
  directory: string;
  journalId: string;
  authority: () => TrainingAuthority;
  readOnly?: boolean;
};
export type TrainingCodec = 'identity' | 'zstd';
export type TrainingRecovery = 'COMPLETE' | 'INCOMPLETE' | 'CORRUPT' | 'UNSUPPORTED';
export const TJ_DISK = Object.freeze({
  archiveName: 'training.tj0',
  lockName: 'writer.sqlite',
  headerBytes: 128,
  frameHeaderBytes: 128,
  footerBytes: 40,
});
const ARCHIVE_MAGIC = Buffer.from('TJ0AR001'),
  FRAME_MAGIC = Buffer.from('TJ0CH001'),
  COMMIT_MAGIC = Buffer.from('TJ0DONE1');
const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const zeros = (buffer: Uint8Array): boolean => buffer.every((b) => b === 0);
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
type Entry = {
  offset: number;
  length: number;
  rawBytes: number;
  digest: string;
  eventKey: string;
  eventDigest: string;
};
const identity = (a: TrainingAuthority): string => tjHash(JSON.stringify([a.scopeId, a.generation, a.consentRevision]));
function authorityCopy(raw: unknown): TrainingAuthority {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    types.isProxy(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    tjFail('TJ_AUTHORITY');
  const keys = ['scopeId', 'generation', 'consentRevision', 'runtimeId', 'now', 'expiresAt', 'read', 'write', 'export'];
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(raw).length !== keys.length ||
    keys.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))
  )
    tjFail('TJ_AUTHORITY');
  const a = Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value])) as TrainingAuthority;
  tjId(a.scopeId);
  tjCounter(a.generation);
  tjCounter(a.consentRevision);
  tjId(a.runtimeId);
  if (
    !Number.isSafeInteger(a.now) ||
    a.now < 0 ||
    !Number.isSafeInteger(a.expiresAt) ||
    a.expiresAt <= a.now ||
    ['read', 'write', 'export'].some((k) => typeof a[k as 'read'] !== 'boolean')
  )
    tjFail('TJ_AUTHORITY');
  return a;
}
function checkedDirectory(directory: string): string {
  if (typeof directory !== 'string' || !isAbsolute(directory)) tjFail('TJ_PATH');
  const absolute = resolve(directory),
    real = realpathSync(absolute);
  if (!samePath(absolute, real) || !lstatSync(absolute).isDirectory()) tjFail('TJ_PATH');
  const rel = relative(SOURCE_ROOT, real);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) tjFail('TJ_PATH');
  if (real.split(/[\\/]/).some((part) => /^onedrive(?:\s|$)/i.test(part))) tjFail('TJ_PATH');
  return real;
}
function regular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) tjFail('TJ_PATH');
}
function lockFiles(path: string): void {
  // BEGIN IMMEDIATE without SQL writes leaves an empty main file, and at most a
  // 512-byte rollback journal (also observed after an owned process is killed).
  for (const [suffix, max] of [
    ['', 0],
    ['-journal', 512],
    ['-wal', 0],
    ['-shm', 0],
  ] as const) {
    const file = path + suffix;
    try {
      regular(file);
      const size = lstatSync(file).size;
      if (size > max || suffix === '-wal' || suffix === '-shm') tjFail('TJ_PATH');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && suffix !== '') continue;
      throw error;
    }
  }
}
function makeHeader(journalId: string, a: TrainingAuthority): Buffer {
  const b = Buffer.alloc(TJ_DISK.headerBytes);
  ARCHIVE_MAGIC.copy(b);
  b.writeUInt16BE(1, 8);
  b.writeUInt16BE(1, 10);
  b.writeUInt32BE(128, 12);
  Buffer.from(tjHash(journalId), 'hex').copy(b, 16);
  Buffer.from(identity(a), 'hex').copy(b, 48);
  Buffer.from(tjHash(b.subarray(0, 96)), 'hex').copy(b, 96);
  return b;
}
function readExactly(fd: number, length: number, position: number): Buffer {
  const b = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = readSync(fd, b, offset, length - offset, position + offset);
    if (n === 0) tjFail('TJ_INCOMPLETE');
    offset += n;
  }
  return b;
}
function writeAll(fd: number, b: Buffer, position: number): void {
  let offset = 0;
  while (offset < b.length) {
    const n = writeSync(fd, b, offset, b.length - offset, position + offset);
    if (n <= 0) tjFail('TJ_IO');
    offset += n;
  }
}
function decodedFrame(
  frame: Buffer,
  physical: number,
  previousDigest: string,
): { raw: string; event: TrainingEvent; digest: string } {
  if (frame.length < 168) tjFail('TJ_INCOMPLETE');
  const h = frame.subarray(0, 128),
    encoded = h.readUInt32BE(20),
    rawSize = h.readUInt32BE(24);
  if (
    !h.subarray(0, 8).equals(FRAME_MAGIC) ||
    !zeros(h.subarray(14, 16)) ||
    !zeros(h.subarray(28, 32)) ||
    !zeros(h.subarray(96, 128))
  )
    tjFail('TJ_CORRUPT');
  if (h.readUInt16BE(8) !== 1 || h.readUInt16BE(12) !== 1 || h.readUInt16BE(10) > 1) tjFail('TJ_UNSUPPORTED');
  if (encoded < 1 || encoded > TJ_LIMITS.encodedBytes || rawSize < 1 || rawSize > TJ_LIMITS.eventBytes)
    tjFail('TJ_LIMIT');
  if (
    h.readUInt32BE(16) !== physical ||
    h.subarray(32, 64).toString('hex') !== previousDigest ||
    frame.length !== 128 + encoded + 40
  )
    tjFail('TJ_CORRUPT');
  const payload = frame.subarray(128, 128 + encoded),
    footer = frame.subarray(128 + encoded),
    digest = tjHash(frame.subarray(0, 128 + encoded));
  if (!footer.subarray(0, 8).equals(COMMIT_MAGIC) || footer.subarray(8).toString('hex') !== digest)
    tjFail('TJ_CORRUPT');
  let bytes: Buffer;
  try {
    bytes =
      h.readUInt16BE(10) === 0
        ? payload
        : zstdDecompressSync(payload, { maxOutputLength: rawSize, params: { [z.ZSTD_d_windowLogMax]: 16 } });
  } catch {
    return tjFail('TJ_CORRUPT');
  }
  if (bytes.length !== rawSize || tjHash(bytes) !== h.subarray(64, 96).toString('hex')) tjFail('TJ_CORRUPT');
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return tjFail('TJ_CORRUPT');
  }
  const canonical = canonicalTrainingEvent(raw);
  if (canonical !== raw || !Buffer.from(canonical).equals(bytes)) tjFail('TJ_CORRUPT');
  return { raw, event: JSON.parse(raw) as TrainingEvent, digest };
}

/** Cooperative single-owner, bounded, synthetic disk journal. Hashes provide consistency, not authenticity. */
export class TrainingJournal {
  #authority: () => TrainingAuthority;
  #bound: TrainingAuthority | null = null;
  #lastNow = 0;
  #busy = false;
  #fenced = false;
  #closed = false;
  #db: DatabaseSync | null = null;
  #fd: number | null = null;
  #path = '';
  #readOnly: boolean;
  #stamp = '';
  #headerDigest = '';
  #lastDigest = '';
  #entries: Entry[] = [];
  #dedup = new Map<string, number>();
  #attempts = new Map<string, AttemptProjection>();
  #recovery: TrainingRecovery = 'COMPLETE';
  #committedBytes = 128;
  #decodedBytes = 0;
  #archiveBytes = 128;
  private constructor(options: TrainingJournalOptions) {
    this.#authority = options.authority;
    this.#readOnly = options.readOnly === true;
  }
  static create(options: TrainingJournalOptions): TrainingJournal {
    return TrainingJournal.#initialize(options, true);
  }
  static open(options: TrainingJournalOptions): TrainingJournal {
    return TrainingJournal.#initialize(options, false);
  }
  static #initialize(options: TrainingJournalOptions, create: boolean): TrainingJournal {
    const j = new TrainingJournal(options);
    j.#busy = true;
    try {
      j.#gate(create ? 'write' : 'read');
      tjId(options.journalId);
      if (create && j.#readOnly) tjFail('TJ_INVALID');
      const directory = checkedDirectory(options.directory),
        lockPath = join(directory, TJ_DISK.lockName);
      // The sidecar contains no journal index, authority state or committed head.
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      lockFiles(lockPath);
      j.#db = new DatabaseSync(lockPath, { timeout: 0 });
      try {
        j.#db.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
      } catch {
        return tjFail('TJ_LOCKED');
      }
      j.#path = join(directory, TJ_DISK.archiveName);
      if (create) {
        j.#gate('write');
        j.#fd = openSync(j.#path, 'wx+', 0o600);
        const h = makeHeader(options.journalId, j.#bound!);
        try {
          writeAll(j.#fd, h, 0);
          fsyncSync(j.#fd);
        } catch {
          j.#fenced = true;
          return tjFail('TJ_COMMIT_UNKNOWN');
        }
      } else {
        regular(j.#path);
        j.#fd = openSync(j.#path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        if (!j.#readOnly) {
          closeSync(j.#fd);
          j.#fd = openSync(j.#path, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
        }
      }
      regular(j.#path);
      j.#scan(options.journalId);
      j.#stamp = j.#fileStamp();
      j.#gate(create ? 'write' : 'read');
      j.#checkFile();
      return j;
    } catch (error) {
      j.#dispose();
      if (error instanceof TrainingJournalError) throw error;
      return tjFail('TJ_IO');
    } finally {
      j.#busy = false;
    }
  }
  #gate(right: 'read' | 'write' | 'export'): void {
    if (this.#closed || this.#fenced) tjFail('TJ_FENCED');
    let current: TrainingAuthority;
    try {
      current = authorityCopy(this.#authority());
    } catch {
      this.#fenced = true;
      return tjFail('TJ_AUTHORITY');
    }
    if (
      this.#fenced ||
      this.#closed ||
      !current.read ||
      !current[right] ||
      current.now < this.#lastNow ||
      (this.#bound && (identity(current) !== identity(this.#bound) || current.runtimeId !== this.#bound.runtimeId))
    ) {
      this.#fenced = true;
      return tjFail('TJ_AUTHORITY');
    }
    this.#bound ??= current;
    this.#lastNow = current.now;
  }
  #fileStamp(): string {
    const s = fstatSync(this.#fd!, { bigint: true }),
      named = lstatSync(this.#path, { bigint: true });
    if (
      !s.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      s.ino !== named.ino ||
      s.dev !== named.dev ||
      s.nlink !== 1n
    )
      tjFail('TJ_CHANGED');
    return [s.size, s.mtimeNs, s.ctimeNs].join(':');
  }
  #checkFile(): void {
    try {
      if (this.#fileStamp() !== this.#stamp) tjFail('TJ_CHANGED');
    } catch {
      this.#fenced = true;
      tjFail('TJ_CHANGED');
    }
  }
  #operation<T>(right: 'read' | 'write' | 'export', fn: () => T): T {
    if (this.#busy) {
      this.#fenced = true;
      tjFail('TJ_REENTRANT');
    }
    this.#busy = true;
    try {
      this.#gate(right);
      this.#checkFile();
      const result = fn();
      this.#gate(right);
      this.#checkFile();
      return result;
    } catch (error) {
      if (error instanceof TrainingJournalError) throw error;
      this.#fenced = true;
      return tjFail('TJ_IO');
    } finally {
      this.#busy = false;
    }
  }
  #scan(journalId: string): void {
    const size = fstatSync(this.#fd!).size;
    if (size > TJ_LIMITS.archiveBytes) tjFail('TJ_LIMIT');
    if (size < 128) tjFail('TJ_INCOMPLETE');
    const h = readExactly(this.#fd!, 128, 0);
    if (
      !h.subarray(0, 8).equals(ARCHIVE_MAGIC) ||
      h.readUInt32BE(12) !== 128 ||
      !zeros(h.subarray(80, 96)) ||
      tjHash(h.subarray(0, 96)) !== h.subarray(96).toString('hex')
    )
      tjFail('TJ_CORRUPT');
    if (h.readUInt16BE(8) !== 1 || h.readUInt16BE(10) !== 1) tjFail('TJ_UNSUPPORTED');
    if (
      h.subarray(16, 48).toString('hex') !== tjHash(journalId) ||
      h.subarray(48, 80).toString('hex') !== identity(this.#bound!)
    )
      tjFail('TJ_AUTHORITY');
    this.#headerDigest = tjHash(h);
    this.#lastDigest = this.#headerDigest;
    this.#archiveBytes = size;
    while (this.#committedBytes < size) {
      try {
        if (this.#entries.length >= TJ_LIMITS.events) tjFail('TJ_LIMIT');
        if (size - this.#committedBytes < 128) tjFail('TJ_INCOMPLETE');
        const head = readExactly(this.#fd!, 128, this.#committedBytes),
          length = head.readUInt32BE(20),
          rawBytes = head.readUInt32BE(24);
        // Check untrusted lengths before allocating the frame or expanding its payload.
        if (
          length < 1 ||
          length > TJ_LIMITS.encodedBytes ||
          rawBytes < 1 ||
          rawBytes > TJ_LIMITS.eventBytes ||
          this.#decodedBytes + rawBytes > TJ_LIMITS.decodedBytes
        )
          tjFail('TJ_LIMIT');
        if (size - this.#committedBytes < 128 + length + 40) tjFail('TJ_INCOMPLETE');
        const frame = readExactly(this.#fd!, 128 + length + 40, this.#committedBytes);
        const decoded = decodedFrame(frame, this.#entries.length + 1, this.#lastDigest),
          key = tjEventKey(decoded.event),
          attempt = tjAttemptKey(decoded.event);
        if (this.#dedup.has(key)) tjFail('TJ_CONFLICT');
        if (!this.#attempts.has(attempt) && this.#attempts.size >= TJ_LIMITS.attempts) tjFail('TJ_LIMIT');
        const projection = reduceTrainingEvent(this.#attempts.get(attempt), decoded.event);
        this.#entries.push({
          offset: this.#committedBytes,
          length: frame.length,
          rawBytes,
          digest: decoded.digest,
          eventKey: key,
          eventDigest: tjHash(decoded.raw),
        });
        this.#dedup.set(key, this.#entries.length);
        this.#attempts.set(attempt, projection);
        this.#lastDigest = decoded.digest;
        this.#committedBytes += frame.length;
        this.#decodedBytes += rawBytes;
      } catch (error) {
        this.#recovery =
          error instanceof TrainingJournalError && error.code === 'TJ_INCOMPLETE'
            ? 'INCOMPLETE'
            : error instanceof TrainingJournalError && error.code === 'TJ_UNSUPPORTED'
              ? 'UNSUPPORTED'
              : 'CORRUPT';
        break;
      }
    }
  }
  #raw(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > this.#entries.length) tjFail('TJ_NOT_FOUND');
    const entry = this.#entries[sequence - 1]!,
      previous = sequence === 1 ? this.#headerDigest : this.#entries[sequence - 2]!.digest;
    try {
      const d = decodedFrame(readExactly(this.#fd!, entry.length, entry.offset), sequence, previous);
      if (d.digest !== entry.digest) tjFail('TJ_CHANGED');
      return d.raw;
    } catch {
      this.#fenced = true;
      return tjFail('TJ_CORRUPT');
    }
  }
  append(raw: string, options: { codec?: TrainingCodec } = {}): { duplicate: boolean; sequence: number } {
    return this.#operation('write', () => {
      if (this.#readOnly) tjFail('TJ_FENCED');
      if (this.#recovery !== 'COMPLETE') tjFail('TJ_INCOMPLETE');
      const canonical = canonicalTrainingEvent(raw),
        event = JSON.parse(canonical) as TrainingEvent,
        key = tjEventKey(event),
        eventDigest = tjHash(canonical);
      const duplicate = this.#dedup.get(key);
      if (duplicate !== undefined) {
        if (this.#entries[duplicate - 1]!.eventDigest !== eventDigest) tjFail('TJ_CONFLICT');
        this.#raw(duplicate);
        return { duplicate: true, sequence: duplicate };
      }
      const attempt = tjAttemptKey(event),
        projection = reduceTrainingEvent(this.#attempts.get(attempt), event);
      if (
        this.#entries.length >= TJ_LIMITS.events ||
        (!this.#attempts.has(attempt) && this.#attempts.size >= TJ_LIMITS.attempts)
      )
        tjFail('TJ_LIMIT');
      const bytes = Buffer.from(canonical),
        codec = options.codec ?? 'identity';
      if (codec !== 'identity' && codec !== 'zstd') tjFail('TJ_INVALID');
      let payload: Buffer;
      try {
        payload =
          codec === 'identity'
            ? bytes
            : zstdCompressSync(bytes, {
                maxOutputLength: TJ_LIMITS.encodedBytes,
                params: { [z.ZSTD_c_compressionLevel]: 3, [z.ZSTD_c_windowLog]: 16 },
              });
      } catch {
        return tjFail('TJ_INVALID');
      }
      if (
        payload.length > TJ_LIMITS.encodedBytes ||
        this.#decodedBytes + bytes.length > TJ_LIMITS.decodedBytes ||
        this.#committedBytes + 128 + payload.length + 40 > TJ_LIMITS.archiveBytes
      )
        tjFail('TJ_LIMIT');
      const h = Buffer.alloc(128);
      FRAME_MAGIC.copy(h);
      h.writeUInt16BE(1, 8);
      h.writeUInt16BE(codec === 'identity' ? 0 : 1, 10);
      h.writeUInt16BE(1, 12);
      h.writeUInt32BE(this.#entries.length + 1, 16);
      h.writeUInt32BE(payload.length, 20);
      h.writeUInt32BE(bytes.length, 24);
      Buffer.from(this.#lastDigest, 'hex').copy(h, 32);
      Buffer.from(eventDigest, 'hex').copy(h, 64);
      const body = Buffer.concat([h, payload]),
        digest = tjHash(body),
        frame = Buffer.concat([body, COMMIT_MAGIC, Buffer.from(digest, 'hex')]);
      this.#gate('write');
      this.#checkFile();
      try {
        writeAll(this.#fd!, frame, this.#committedBytes);
        fsyncSync(this.#fd!);
      } catch {
        this.#fenced = true;
        return tjFail('TJ_COMMIT_UNKNOWN');
      }
      this.#entries.push({
        offset: this.#committedBytes,
        length: frame.length,
        rawBytes: bytes.length,
        digest,
        eventKey: key,
        eventDigest,
      });
      this.#dedup.set(key, this.#entries.length);
      this.#attempts.set(attempt, projection);
      this.#lastDigest = digest;
      this.#committedBytes += frame.length;
      this.#archiveBytes = this.#committedBytes;
      this.#decodedBytes += bytes.length;
      this.#stamp = this.#fileStamp();
      return { duplicate: false, sequence: this.#entries.length };
    });
  }
  status() {
    return this.#operation('read', () => ({
      version: 1 as const,
      assurance: 'NOT_AUTHENTICATED' as const,
      executionMode: 'SYNTHETIC_FIXTURE' as const,
      realTrainingPerformed: false as const,
      modelCalls: 0 as const,
      recovery: this.#recovery,
      events: this.#entries.length,
      attempts: this.#attempts.size,
      committedBytes: this.#committedBytes,
      archiveBytes: this.#archiveBytes,
      decodedBytes: this.#decodedBytes,
      archiveAppendable: this.#recovery === 'COMPLETE',
      openedReadOnly: this.#readOnly,
      rollbackProtection: 'KNOWN_UNPROTECTED' as const,
    }));
  }
  readEvent(sequence: number) {
    return this.#operation('read', () => parseTrainingEvent(this.#raw(sequence)));
  }
  readAttempt(runId: string, attemptId: string) {
    return this.#operation('read', () => {
      const p = this.#attempts.get(tjAttemptKey({ runId: tjId(runId), attemptId: tjId(attemptId) }));
      if (!p) tjFail('TJ_NOT_FOUND');
      return {
        assurance: 'NOT_AUTHENTICATED' as const,
        executionMode: 'SYNTHETIC_FIXTURE' as const,
        realTrainingPerformed: false as const,
        history: this.#recovery === 'COMPLETE' ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
        continuation: 'NOT_EXECUTED' as const,
        projection: structuredClone(p),
      };
    });
  }
  /** Private, permission-gated declaration stream; it is not a public summary or a restore capability. */
  exportCanonical(): string {
    return this.#operation('export', () => {
      if (this.#recovery !== 'COMPLETE') tjFail('TJ_INCOMPLETE');
      return this.#entries.map((_, i) => this.#raw(i + 1) + '\n').join('');
    });
  }
  #dispose(): void {
    this.#closed = true;
    this.#fenced = true;
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {}
      this.#fd = null;
    }
    if (this.#db !== null) {
      try {
        this.#db.close();
      } catch {}
      this.#db = null;
    }
  }
  close(): void {
    if (this.#busy) {
      this.#fenced = true;
      tjFail('TJ_REENTRANT');
    }
    this.#dispose();
  }
}
