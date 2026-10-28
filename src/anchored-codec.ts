import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { MAX_IMAGE, record, sha } from './durable-codec.ts';
import type { Safety } from './durable-codec.ts';
import { fail, text } from './validation.ts';
import type {LegacyImportProof} from './legacy-import-types.ts';
import {COLD_SAFETY_PROFILE,isColdSafetyProfile,validateColdDescriptor} from './safety-format.ts';
import type {SafetyColdDescriptor} from './safety-format.ts';
import {STORE_COLD_PROFILE,validateStoreColdDescriptor} from './store-cold-format.ts';
import type {StoreColdDescriptor} from './store-cold-format.ts';

export const ANCHORED_FORMAT = 'companion-anchored-vault-v2';
export const INCREMENTAL_FORMAT = 'companion-anchored-vault-v3';
export const INCREMENTAL_MARKER = 'AnchoredVault.v3';
export type StorageProfile = 'blocks-br4-v1' | 'full-br4-v1' | 'blocks-br4-safety-br4-v1' | typeof COLD_SAFETY_PROFILE | typeof STORE_COLD_PROFILE;
export const VAULT_MARKER = 'AnchoredVault.v2';
export const STAGE_LIMIT = MAX_IMAGE * 4;
export type VaultIdentity = { format: typeof ANCHORED_FORMAT | typeof INCREMENTAL_FORMAT; authorityId: string; vaultId: string; identity: string;
  instanceId: string; ownerEpoch: number; keyEpoch: number; directory: string; storageDomain: string; schemaVersion?: 1 | 2; storageProfile?: StorageProfile;
  legacyImport?:{lineageId:string;migrationId:string};safetyCold?:SafetyColdDescriptor|null;storeCold?:StoreColdDescriptor|null };
export type VaultHead = VaultIdentity & { sequence: number; digest: string };
export type KeySet = { version: 2; keyEpoch: number; storageDEK: Uint8Array; ingressKey: Uint8Array };
export type VaultRecord = { version: 2; identity: VaultIdentity; sequence: number; operationId: string;
  previous: string | null; parentHead: VaultHead | null; checkpointDigest: string; revocationHighWater: number;
  maintenance?: { floor: number; resetConsumerIds: string[] };legacyImport?:LegacyImportProof };
export type VaultState = { version: 2; identity: VaultIdentity; sequence: number; image: string; safety: Safety; revocationHighWater: number; ingressKeyDigest: string };
export type FrozenStage = { format: typeof ANCHORED_FORMAT; head: VaultHead; checkpoint: string; record: string };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const id = (value: string): void => { text(value, 128); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail('ANCHOR_ID'); };
export const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
export function canonicalDirectory(path: string): string {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('ANCHOR_PATH');
  return realpathSync(path);
}
export function disjoint(a: string, b: string): void {
  const inside = (x: string, y: string) => { const r = relative(x, y); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)); };
  if (inside(a, b) || inside(b, a)) fail('ANCHOR_CUSTODY_OVERLAP');
}
export function readBounded(path: string, maximum = STAGE_LIMIT): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('ANCHOR_FILE');
  return readFileSync(path);
}
/** Inspect main and recovery sidecars BEFORE giving a filename to SQLite. */
export function boundSqlite(directory: string, name: string, maximum: number): void {
  const names = new Set(readdirSync(directory)); let total = 0;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = name + suffix;
    if (!names.has(file)) continue;
    const stat = lstatSync(join(directory, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('ANCHOR_FILE');
    total += stat.size; if (total > maximum) fail('ANCHOR_FILE');
  }
}
export function writeNew(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
export function copyKeys(keys: KeySet): KeySet {
  if (!record(keys) || keys.version !== 2 || !integer(keys.keyEpoch, 1)
    || !(keys.storageDEK instanceof Uint8Array) || keys.storageDEK.length !== 32
    || !(keys.ingressKey instanceof Uint8Array) || keys.ingressKey.length !== 32
    || Buffer.from(keys.storageDEK).equals(keys.ingressKey)) fail('ANCHOR_KEYSET');
  return { version: 2, keyEpoch: keys.keyEpoch, storageDEK: Buffer.from(keys.storageDEK), ingressKey: Buffer.from(keys.ingressKey) };
}
export const generateKeySet = (): KeySet => ({ version: 2, keyEpoch: 1, storageDEK: randomBytes(32), ingressKey: randomBytes(32) });
export function sealV2(value: unknown, purpose: string, context: unknown, key: Uint8Array): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([ANCHORED_FORMAT, purpose, context])));
  const plain = Buffer.from(JSON.stringify(value));
  try { const data = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); }
  finally { plain.fill(0); }
}
export function unsealV2(bytes: Uint8Array, purpose: string, context: unknown, key: Uint8Array): any {
  if (bytes.length < 29 || bytes.length > STAGE_LIMIT) fail('ANCHOR_CORRUPT');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(JSON.stringify([ANCHORED_FORMAT, purpose, context]))); cipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); } finally { plain.fill(0); }
  } catch { fail('ANCHOR_CORRUPT'); }
}
export function validateIdentity(value: unknown): asserts value is VaultIdentity {
  if (!record(value) || ![ANCHORED_FORMAT,INCREMENTAL_FORMAT].includes(value.format) || !integer(value.ownerEpoch, 1) || !integer(value.keyEpoch, 1)
    || typeof value.directory !== 'string' || !isAbsolute(value.directory)) fail('ANCHOR_CORRUPT');
  if (value.schemaVersion !== undefined && ![1,2].includes(value.schemaVersion)) fail('ANCHOR_CORRUPT');
  if (value.format === INCREMENTAL_FORMAT ? !['blocks-br4-v1','full-br4-v1','blocks-br4-safety-br4-v1',COLD_SAFETY_PROFILE,STORE_COLD_PROFILE].includes(value.storageProfile) : value.storageProfile !== undefined) fail('ANCHOR_STORAGE_PROFILE');
  if(isColdSafetyProfile(value.storageProfile)){if(!Object.hasOwn(value,'safetyCold'))fail('SAFETY_COLD_DESCRIPTOR');if(value.safetyCold!==null)validateColdDescriptor(value.safetyCold);}
  else if(Object.hasOwn(value,'safetyCold'))fail('ANCHOR_STORAGE_PROFILE');
  if(value.storageProfile===STORE_COLD_PROFILE){if(!Object.hasOwn(value,'storeCold'))fail('STORE_COLD_DESCRIPTOR');if(value.storeCold!==null){validateStoreColdDescriptor(value.storeCold);if(value.storeCold.schema!==(value.schemaVersion??1))fail('STORE_COLD_DESCRIPTOR');}}
  else if(Object.hasOwn(value,'storeCold'))fail('ANCHOR_STORAGE_PROFILE');
  text(value.identity,128);
  for (const field of ['authorityId', 'vaultId', 'instanceId', 'storageDomain']) id(value[field]);
  if(value.legacyImport!==undefined&&(!record(value.legacyImport)||Object.keys(value.legacyImport).sort().join(',')!=='lineageId,migrationId'
    ||!/^[a-f0-9]{64}$/.test(value.legacyImport.lineageId)||value.legacyImport.migrationId!==`m2-import-${value.legacyImport.lineageId}`||value.format!==INCREMENTAL_FORMAT))fail('LEGACY_IDENTITY');
}
export function validateHead(value: unknown): asserts value is VaultHead {
  validateIdentity(value);
  const head = value as VaultHead;
  if (!integer(head.sequence, 1) || !/^[a-f0-9]{64}$/.test(head.digest)) fail('ANCHOR_CORRUPT');
}
export function identityOf(head: VaultHead): VaultIdentity {
  const { sequence: _sequence, digest: _digest, ...identity } = head; return identity;
}
export function canUpgradeStorage(old:VaultIdentity,profile:StorageProfile):boolean{
  if(profile===STORE_COLD_PROFILE)return old.format===INCREMENTAL_FORMAT&&old.storageProfile===COLD_SAFETY_PROFILE;
  if(profile===COLD_SAFETY_PROFILE)return old.format===INCREMENTAL_FORMAT&&old.storageProfile==='blocks-br4-safety-br4-v1';
  if(old.format===ANCHORED_FORMAT)return true;
  return profile==='blocks-br4-safety-br4-v1'&&(old.storageProfile==='blocks-br4-v1'||old.storageProfile==='full-br4-v1');
}
/** Writers must not acknowledge an identity that the bounded marker reader
 * cannot reopen. This bound also covers UTF-8 expansion in absolute paths. */
export function encodeVaultMarker(identity:VaultIdentity):Buffer{
  validateIdentity(identity);const bytes=Buffer.from(JSON.stringify(identity));if(bytes.length>8192)fail('ANCHOR_LIMIT');return bytes;
}
export function validateState(state: VaultState, identity: VaultIdentity, sequence: number, maxCalls: number): Buffer {
  if (!record(state) || state.version !== 2 || !same(state.identity, identity) || state.sequence !== sequence
    || !integer(state.revocationHighWater) || typeof state.image !== 'string') fail('ANCHOR_CORRUPT');
  validateSafetyState(state.safety, identity, maxCalls);
  const image = Buffer.from(state.image, 'base64');
  if (image.length > MAX_IMAGE || image.toString('base64') !== state.image) { image.fill(0); fail('ANCHOR_CORRUPT'); }
  return image;
}
export function validateSafetyState(s: Safety, identity: VaultIdentity, maxCalls: number): void {
  if (!record(s) || s.version !== 1 || s.identity !== identity.identity || s.maxCalls !== maxCalls
    || !integer(s.reserved) || s.reserved > maxCalls || !integer(s.lastWall) || !Array.isArray(s.ingress) || s.ingress.length > 8192) fail('ANCHOR_CORRUPT');
  const seen = new Set<string>(), deliveries = new Set<string>();
  let reserved = 0;
  for (const e of s.ingress) {
    if (!record(e) || !/^[a-f0-9]{64}$/.test(e.key) || !/^[a-f0-9]{64}$/.test(e.fingerprint) || seen.has(e.key)
      || !['pending','ready','taken','acknowledged','failed','unknown'].includes(e.state)
      || typeof e.reserved !== 'boolean' || typeof e.feedbackConsumed !== 'boolean'
      || (e.deliveryId !== null && (typeof e.deliveryId !== 'string' || e.deliveryId.length > 128 || deliveries.has(e.deliveryId)))) fail('ANCHOR_CORRUPT');
    if (['ready','taken','acknowledged'].includes(e.state) && e.deliveryId === null) fail('ANCHOR_CORRUPT');
    seen.add(e.key); if (e.deliveryId !== null) deliveries.add(e.deliveryId); if (e.reserved) reserved++;
  }
  if (reserved !== s.reserved) fail('ANCHOR_CORRUPT');
}
export function decodeStage(bytes: Uint8Array, keys: KeySet, maxCalls: number): { stage: FrozenStage; state: VaultState; record: VaultRecord; image: Buffer } {
  let stage: FrozenStage;
  try { stage = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('ANCHOR_CORRUPT'); }
  if (!record(stage) || stage.format !== ANCHORED_FORMAT || typeof stage.checkpoint !== 'string' || typeof stage.record !== 'string') fail('ANCHOR_CORRUPT');
  validateHead(stage.head); if (stage.head.keyEpoch !== keys.keyEpoch) fail('ANCHOR_KEY_EPOCH');
  if(stage.head.format!==ANCHORED_FORMAT)fail('ANCHOR_STORAGE_PROFILE');
  const identity = identityOf(stage.head), cp = Buffer.from(stage.checkpoint, 'base64'), row = Buffer.from(stage.record, 'base64');
  if (row.toString('base64') !== stage.record || cp.toString('base64') !== stage.checkpoint || sha(row) !== stage.head.digest) fail('ANCHOR_CORRUPT');
  const rec: VaultRecord = unsealV2(row, 'record', identity, keys.storageDEK);
  if (!record(rec) || rec.version !== 2 || !same(rec.identity, identity) || rec.sequence !== stage.head.sequence || rec.checkpointDigest !== sha(cp)
    || !integer(rec.revocationHighWater)) fail('ANCHOR_CORRUPT');
  id(rec.operationId);
  if (rec.previous !== null && !/^[a-f0-9]{64}$/.test(rec.previous)) fail('ANCHOR_CORRUPT');
  if (rec.parentHead !== null) validateHead(rec.parentHead);
  const state: VaultState = unsealV2(cp, 'checkpoint', identity, keys.storageDEK);
  if (state.ingressKeyDigest !== sha(keys.ingressKey)) fail('ANCHOR_INGRESS_KEY');
  const image = validateState(state, identity, stage.head.sequence, maxCalls);
  if (rec.revocationHighWater !== state.revocationHighWater) { image.fill(0); fail('ANCHOR_CORRUPT'); }
  return { stage, state, record: rec, image };
}

export type EnvelopeRecipient = { authorityId: string; vaultId: string; recipient: string };
type EnvelopeContext = EnvelopeRecipient & { version: 2; keyEpoch: number };
export function wrapKeySet(keys: KeySet, kek: Uint8Array, recipient: EnvelopeRecipient): Buffer {
  const copy = copyKeys(keys);
  try {
    if (kek.length !== 32) fail('ANCHOR_KEK'); for (const value of Object.values(recipient)) id(value);
    const context: EnvelopeContext = { authorityId: recipient.authorityId, vaultId: recipient.vaultId,
      recipient: recipient.recipient, version: 2, keyEpoch: keys.keyEpoch };
    return Buffer.from(JSON.stringify({ context, sealed: sealV2({ version: 2, keyEpoch: copy.keyEpoch,
      storageDEK: Buffer.from(copy.storageDEK).toString('base64'), ingressKey: Buffer.from(copy.ingressKey).toString('base64') }, 'recipient-key-envelope', context, kek).toString('base64') }));
  } finally { copy.storageDEK.fill(0); copy.ingressKey.fill(0); }
}
export function unwrapKeySet(envelope: Uint8Array, kek: Uint8Array, expected: EnvelopeRecipient & { keyEpoch: number }): KeySet {
  if (envelope.length > 4096 || kek.length !== 32) fail('ANCHOR_ENVELOPE');
  let value: any; try { value = JSON.parse(Buffer.from(envelope).toString('utf8')); } catch { fail('ANCHOR_ENVELOPE'); }
  if (!record(value) || !same(value.context, { authorityId: expected.authorityId, vaultId: expected.vaultId,
    recipient: expected.recipient, version: 2, keyEpoch: expected.keyEpoch }) || typeof value.sealed !== 'string') fail('ANCHOR_ENVELOPE');
  const plain = unsealV2(Buffer.from(value.sealed, 'base64'), 'recipient-key-envelope', value.context, kek);
  if (!record(plain) || plain.version !== 2 || plain.keyEpoch !== expected.keyEpoch || typeof plain.storageDEK !== 'string' || typeof plain.ingressKey !== 'string') fail('ANCHOR_ENVELOPE');
  return copyKeys({ version: 2, keyEpoch: plain.keyEpoch, storageDEK: Buffer.from(plain.storageDEK, 'base64'), ingressKey: Buffer.from(plain.ingressKey, 'base64') });
}
/** Rewrap only: writes a NEW envelope; does not touch a vault, ciphertext, epoch or idempotency key. */
export function rewrapKeyEnvelope(envelope: Uint8Array, oldKEK: Uint8Array, expected: EnvelopeRecipient & { keyEpoch: number },
  newKEK: Uint8Array, newRecipient: string, targetFile: string): void {
  const keys = unwrapKeySet(envelope, oldKEK, expected);
  try { writeNew(targetFile, wrapKeySet(keys, newKEK, { authorityId: expected.authorityId, vaultId: expected.vaultId, recipient: newRecipient })); }
  finally { keys.storageDEK.fill(0); keys.ingressKey.fill(0); }
}
