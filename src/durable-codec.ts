import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SourceRef } from './contracts.ts';
import { fail, text } from './validation.ts';

// The M2.v1 wire representation and AEAD AAD remain unchanged.
export const FORMAT = 'companion-core-m2-v1';
export const MAX_COMMITS = 4096,
  MAX_IMAGE = 16 * 1024 * 1024,
  MAX_DISK = 256 * 1024 * 1024;
export const MAX_AUTHORITY = 64 * 1024 * 1024,
  MAX_AUTHORITY_RECORD = 4 * 1024 * 1024;
export const RESTORE_QUARANTINE = 'M2.restore-quarantine.v1';
export const RESTORE_DIRECTORY_PREFIX = 'M2.restore-quarantine.v1-';
export const isRestoreDirectoryName = (name: string): boolean =>
  name.toLowerCase().startsWith(RESTORE_DIRECTORY_PREFIX.toLowerCase());
export type Terminal = 'pending' | 'ready' | 'taken' | 'acknowledged' | 'failed' | 'unknown';
type Ingress = {
  key: string;
  fingerprint: string;
  state: Terminal;
  deliveryId: string | null;
  feedbackConsumed: boolean;
  reserved: boolean;
};
export type Safety = {
  version: 1;
  identity: string;
  maxCalls: number;
  reserved: number;
  ingress: Ingress[];
  lastSourceRef: SourceRef | null;
  lastAcknowledgedDeliveryId: string | null;
  lastWall: number;
};
export type Checkpoint = {
  version: 1;
  identity: string;
  sequence: number;
  image: string;
  safety: Safety;
  revocationHighWater: number;
};
export type Authority = {
  version: 1;
  identity: string;
  sequence: number;
  previous: string;
  checkpoint: string;
  sha256: string;
  safety: Safety;
  revocationHighWater: number;
};
export type DurableHeadPin = {
  version: 1;
  format: typeof FORMAT;
  identity: string;
  sequence: number;
  authoritySha256: string;
};
export const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeInteger = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function decodeKey(base64: string): Buffer {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(base64)) fail('DURABLE_KEY_INVALID');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64) {
    key.fill(0);
    fail('DURABLE_KEY_INVALID');
  }
  return key;
}

export function validateIdentityBudget(identity: string, maxCalls: number): void {
  text(identity, 128);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 32) fail('DURABLE_CONFIG');
}

export function validateHeadPin(pin: unknown, identity: string): asserts pin is DurableHeadPin {
  if (
    !record(pin) ||
    Object.keys(pin).sort().join(',') !== 'authoritySha256,format,identity,sequence,version' ||
    pin.version !== 1 ||
    pin.format !== FORMAT ||
    !safeInteger(pin.sequence) ||
    pin.sequence < 1 ||
    pin.sequence > MAX_COMMITS ||
    typeof pin.authoritySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(pin.authoritySha256)
  )
    fail('DURABLE_HEAD_PIN_INVALID');
  if (pin.identity !== identity) fail('DURABLE_IDENTITY_MISMATCH');
}

export function makeHead(identity: string, sequence: number, authoritySha256: string): DurableHeadPin {
  return { version: 1, format: FORMAT, identity, sequence, authoritySha256 };
}

function validateSafety(s: Safety, identity: string, maxCalls: number): void {
  if (
    !record(s) ||
    s.version !== 1 ||
    s.identity !== identity ||
    !safeInteger(s.reserved) ||
    s.reserved > s.maxCalls ||
    !safeInteger(s.lastWall) ||
    !Array.isArray(s.ingress) ||
    s.ingress.length > 8192
  )
    fail('DURABLE_CORRUPT');
  if (s.maxCalls !== maxCalls) fail('DURABLE_BUDGET_MISMATCH');
  const seen = new Set<string>();
  for (const e of s.ingress) {
    if (
      !record(e) ||
      !/^[a-f0-9]{64}$/.test(e.key) ||
      !/^[a-f0-9]{64}$/.test(e.fingerprint) ||
      !['pending', 'ready', 'taken', 'acknowledged', 'failed', 'unknown'].includes(e.state) ||
      typeof e.feedbackConsumed !== 'boolean' ||
      typeof e.reserved !== 'boolean' ||
      (e.deliveryId !== null && (typeof e.deliveryId !== 'string' || e.deliveryId.length > 128)) ||
      seen.has(e.key)
    )
      fail('DURABLE_CORRUPT');
    seen.add(e.key);
  }
}

export function seal(value: unknown, purpose: 'authority' | 'checkpoint', key: Uint8Array): Buffer {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${FORMAT}:${purpose}`));
  const plain = Buffer.from(JSON.stringify(value));
  try {
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  } finally {
    plain.fill(0);
  }
}

function unseal(sealed: Uint8Array, purpose: 'authority' | 'checkpoint', key: Uint8Array): unknown {
  if (sealed.length < 29 || sealed.length > MAX_IMAGE * 2) fail('DURABLE_CORRUPT');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${FORMAT}:${purpose}`));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    } finally {
      plain.fill(0);
    }
  } catch {
    fail('DURABLE_CORRUPT');
  }
}

/** Shared boot/backup validator. Reads only; no SQLite repair or recovery write. */
export function readAuthority(
  db: DatabaseSync,
  key: Uint8Array,
  identity: string,
  maxCalls: number,
  expectedHead?: DurableHeadPin,
  allowEmpty = false,
): { latest: Authority | undefined; sequence: number; previous: string } {
  if (expectedHead !== undefined) validateHeadPin(expectedHead, identity);
  const version = db.prepare('PRAGMA user_version').get()!.user_version;
  const layout = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if (
    version !== 1 ||
    layout.length !== 1 ||
    layout[0]!.sql !== 'CREATE TABLE entries (sequence INTEGER PRIMARY KEY, sealed BLOB NOT NULL) STRICT' ||
    db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok'
  )
    fail('DURABLE_CORRUPT');
  const bounds = db.prepare('SELECT count(*) AS n,coalesce(max(length(sealed)),0) AS largest FROM entries').get()!;
  if (
    (bounds.n as number) > MAX_COMMITS ||
    (bounds.largest as number) > MAX_AUTHORITY_RECORD ||
    (!allowEmpty && bounds.n === 0)
  )
    fail('DURABLE_CORRUPT');
  let latest: Authority | undefined,
    sequence = 0,
    previous = '',
    matched = expectedHead === undefined;
  for (const row of db.prepare('SELECT sequence,sealed FROM entries ORDER BY sequence').iterate()) {
    const sealed = row.sealed as Uint8Array,
      a = unseal(sealed, 'authority', key) as Authority;
    if (
      !record(a) ||
      a.version !== 1 ||
      a.sequence !== sequence + 1 ||
      row.sequence !== a.sequence ||
      a.previous !== previous ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !/^checkpoint-[1-9][0-9]*-[a-f0-9-]{36}\.bin$/.test(a.checkpoint) ||
      !safeInteger(a.revocationHighWater)
    )
      fail('DURABLE_CORRUPT');
    if (a.identity !== identity) fail('DURABLE_IDENTITY_MISMATCH');
    validateSafety(a.safety, identity, maxCalls);
    if (latest && (a.safety.reserved < latest.safety.reserved || a.revocationHighWater < latest.revocationHighWater))
      fail('DURABLE_CORRUPT');
    sequence = a.sequence;
    previous = sha(sealed);
    latest = a;
    if (expectedHead?.sequence === sequence) {
      if (expectedHead.authoritySha256 !== previous) fail('DURABLE_HEAD_MISMATCH');
      matched = true;
    }
  }
  if (!matched) fail('DURABLE_HEAD_ROLLBACK');
  return { latest, sequence, previous };
}

export function readCheckpoint(sealed: Uint8Array, latest: Authority, key: Uint8Array, identity: string): Buffer {
  if (sha(sealed) !== latest.sha256) fail('DURABLE_CORRUPT');
  const checkpoint = unseal(sealed, 'checkpoint', key) as Checkpoint;
  if (
    !record(checkpoint) ||
    checkpoint.version !== 1 ||
    checkpoint.identity !== identity ||
    checkpoint.sequence !== latest.sequence ||
    checkpoint.revocationHighWater !== latest.revocationHighWater ||
    JSON.stringify(checkpoint.safety) !== JSON.stringify(latest.safety) ||
    typeof checkpoint.image !== 'string'
  )
    fail('DURABLE_CORRUPT');
  const image = Buffer.from(checkpoint.image, 'base64');
  if (image.length > MAX_IMAGE || image.toString('base64') !== checkpoint.image) {
    image.fill(0);
    fail('DURABLE_CORRUPT');
  }
  return image;
}
