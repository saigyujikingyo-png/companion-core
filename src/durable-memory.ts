import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './store.ts';
import type { Clock } from './store.ts';
import type { SourceRef } from './contracts.ts';
import { CoreError, fail, text } from './validation.ts';

type Terminal = 'pending' | 'ready' | 'taken' | 'acknowledged' | 'failed' | 'unknown';
type Ingress = { key: string; fingerprint: string; state: Terminal; deliveryId: string | null; feedbackConsumed: boolean; reserved: boolean };
type Safety = { version: 1; identity: string; maxCalls: number; reserved: number; ingress: Ingress[];
  lastSourceRef: SourceRef | null; lastAcknowledgedDeliveryId: string | null; lastWall: number };
type Checkpoint = { version: 1; identity: string; sequence: number; image: string; safety: Safety; revocationHighWater: number };
type Authority = { version: 1; identity: string; sequence: number; previous: string; checkpoint: string;
  sha256: string; safety: Safety; revocationHighWater: number };
export type DurableConfig = { directory: string; identity: string; keyBase64: string };
export type DurableFault = 'checkpoint-write' | 'checkpoint-fsync' | 'authority-commit' | 'after-authority-commit';
const FORMAT = 'companion-core-m2-v1';
const MAX_COMMITS = 4096, MAX_IMAGE = 16 * 1024 * 1024, MAX_DISK = 256 * 1024 * 1024;
const MAX_AUTHORITY = 64 * 1024 * 1024, MAX_AUTHORITY_RECORD = 4 * 1024 * 1024;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeInteger = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/** New M2 format only. The SQLite memory authority never touches disk. The
 * separate safety database contains authenticated ciphertext, never an image or
 * text index. Backups of checkpoints MUST NOT replace this independent ledger.
 * A valid-prefix rollback of this independent ledger is NOT detected without an
 * external trusted head. Its integrity/currentness is an explicit prerequisite. */
export class DurableMemory {
  readonly store: MemoryStore;
  readonly restored: boolean;
  readonly #directory: string; readonly #identity: string; readonly #key: Buffer;
  readonly #fault: ((point: DurableFault) => void) | undefined;
  readonly #wall: () => number;
  #lock: DatabaseSync | undefined; #authority: DatabaseSync | undefined;
  #safety: Safety; #sequence = 0; #previous = ''; #bytes = 0; #poisoned = false; #closed = false;
  constructor(config: DurableConfig, maxCalls: number, options: { clock?: Clock; fault?: (point: DurableFault) => void } = {}) {
    text(config.directory, 4096); text(config.identity, 128);
    if (!isAbsolute(config.directory) || !Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 32) fail('DURABLE_CONFIG');
    if (typeof config.keyBase64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(config.keyBase64)) fail('DURABLE_KEY_INVALID');
    this.#key = Buffer.from(config.keyBase64, 'base64');
    if (this.#key.length !== 32 || this.#key.toString('base64') !== config.keyBase64) fail('DURABLE_KEY_INVALID');
    if (!statSync(config.directory).isDirectory() || lstatSync(config.directory).isSymbolicLink()) fail('DURABLE_CONFIG');
    this.#directory = realpathSync(config.directory); this.#identity = config.identity; this.#fault = options.fault;
    this.#wall = options.clock?.wall ?? Date.now;
    this.#safety = { version: 1, identity: config.identity, maxCalls, reserved: 0, ingress: [], lastSourceRef: null, lastAcknowledgedDeliveryId: null, lastWall: 0 };
    let store: MemoryStore | undefined;
    try {
      const lockPath = join(this.#directory, 'writer.sqlite'), existingLock=existsSync(lockPath); this.#plainFile(lockPath, true);
      this.#lock = new DatabaseSync(lockPath, { timeout: 0, allowExtension: false });
      if(existingLock){
        try {
          const layout=this.#lock.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
          if(layout.length!==1||layout[0]!.sql!=='CREATE TABLE ownership (version INTEGER)'
            ||this.#lock.prepare('PRAGMA user_version').get()!.user_version!==1)fail('DURABLE_CORRUPT');
        } catch(error) {
          if(record(error)&&[5,6].includes(error.errcode))fail('DURABLE_LOCKED');throw error;
        }
      }
      try {
        if(!existingLock)this.#lock.exec('CREATE TABLE ownership (version INTEGER); PRAGMA user_version=1;');
        this.#lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
      }
      catch { fail('DURABLE_LOCKED'); }
      const marker = join(this.#directory, 'M2.v1.claimed'), authorityPath = join(this.#directory, 'authority.sqlite');
      const initializing = !existsSync(marker);
      if (initializing) {
        if (readdirSync(this.#directory).some(name => !['writer.sqlite','writer.sqlite-journal','memory-key.dpapi','memory-key.init-claimed'].includes(name))) fail('DURABLE_INCOMPLETE');
        this.#writeNew(marker, Buffer.from(FORMAT));
      } else {
        this.#plainFile(marker); if (readFileSync(marker, 'utf8') !== FORMAT || !existsSync(authorityPath)) fail('DURABLE_INCOMPLETE');
      }
      this.#plainFile(authorityPath, initializing);
      this.#authorityBytes(); // Bound main database and recovery sidecars BEFORE SQLite opens them.
      this.#authority = new DatabaseSync(authorityPath, { timeout: 0, allowExtension: false, enableDoubleQuotedStringLiterals: false });
      if (initializing) this.#authority.exec('CREATE TABLE entries (sequence INTEGER PRIMARY KEY, sealed BLOB NOT NULL) STRICT; PRAGMA user_version=1;');
      const version = this.#authority.prepare('PRAGMA user_version').get()!.user_version;
      const layout = this.#authority.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (version !== 1 || layout.length!==1 || layout[0]!.sql !== 'CREATE TABLE entries (sequence INTEGER PRIMARY KEY, sealed BLOB NOT NULL) STRICT'
        || this.#authority.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') fail('DURABLE_CORRUPT');
      this.#authority.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;');
      this.#authority.enableDefensive(true);
      const bounds=this.#authority.prepare('SELECT count(*) AS n,coalesce(max(length(sealed)),0) AS largest FROM entries').get()!;
      if ((bounds.n as number)>MAX_COMMITS||(bounds.largest as number)>MAX_AUTHORITY_RECORD||(!initializing&&bounds.n===0))fail('DURABLE_CORRUPT');
      let latest: Authority | undefined;
      for (const row of this.#authority.prepare('SELECT sequence,sealed FROM entries ORDER BY sequence').iterate()) {
        const sealed = row.sealed as Uint8Array, a = this.#unseal(sealed, 'authority') as Authority;
        if (!record(a) || a.version !== 1 || a.sequence !== this.#sequence + 1 || row.sequence !== a.sequence
          || a.previous !== this.#previous || !/^[a-f0-9]{64}$/.test(a.sha256)
          || !/^checkpoint-[1-9][0-9]*-[a-f0-9-]{36}\.bin$/.test(a.checkpoint) || !safeInteger(a.revocationHighWater)) fail('DURABLE_CORRUPT');
        if (a.identity !== this.#identity) fail('DURABLE_IDENTITY_MISMATCH');
        this.#validateSafety(a.safety, maxCalls);
        if (latest && (a.safety.reserved < latest.safety.reserved || a.revocationHighWater < latest.revocationHighWater)) fail('DURABLE_CORRUPT');
        this.#sequence = a.sequence; this.#previous = sha(sealed); latest = a;
      }
      let image: Buffer | undefined;
      if (latest) {
        const path = join(this.#directory, latest.checkpoint); this.#plainFile(path);
        if (statSync(path).size > MAX_IMAGE * 2) fail('DURABLE_LIMIT');
        const sealed = readFileSync(path); if (sha(sealed) !== latest.sha256) fail('DURABLE_CORRUPT');
        const checkpoint = this.#unseal(sealed, 'checkpoint') as Checkpoint;
        if (!record(checkpoint) || checkpoint.version !== 1 || checkpoint.identity !== this.#identity || checkpoint.sequence !== this.#sequence
          || checkpoint.revocationHighWater !== latest.revocationHighWater || JSON.stringify(checkpoint.safety) !== JSON.stringify(latest.safety)
          || typeof checkpoint.image !== 'string') fail('DURABLE_CORRUPT');
        image = Buffer.from(checkpoint.image, 'base64');
        if (image.length > MAX_IMAGE || image.toString('base64') !== checkpoint.image) fail('DURABLE_CORRUPT');
        this.#safety = structuredClone(latest.safety);
      }
      this.restored = !!image;
      for (const entry of this.#safety.ingress) if (['pending','ready','taken'].includes(entry.state)) entry.state = 'unknown';
      // Metadata is retained for audit, never restored as feedback authority.
      this.#safety.lastAcknowledgedDeliveryId = null;
      this.#bytes = readdirSync(this.#directory).filter(n => /^checkpoint-/.test(n)).reduce((sum, name) => {
        const path = join(this.#directory, name); this.#plainFile(path); return sum + statSync(path).size;
      }, 0);
      this.#wallNow();
      store = new MemoryStore(':memory:', { clock: { wall: () => this.#wallNow(), monotonic: options.clock?.monotonic ?? (() => performance.now()) }, ...(image ? { image } : {}),
        persist: (bytes, highWater) => this.#commit(bytes, highWater), assertHealthy:()=>this.#guard(), onPoison:()=>{this.#poisoned=true;} });
      this.store = store;
      if (latest && this.store.revocationHighWater() !== latest.revocationHighWater) fail('DURABLE_CORRUPT');
      this.#commit(this.store.snapshot(), this.store.revocationHighWater());
      image?.fill(0);
    } catch (error) {
      try { store?.close(); } catch {} this.#release(); this.#key.fill(0);
      if (error instanceof CoreError) throw error;
      fail('DURABLE_CORRUPT');
    }
  }
  #plainFile(path: string, mayBeMissing = false): void {
    if (mayBeMissing && !existsSync(path)) return;
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('DURABLE_CORRUPT');
  }
  #authorityBytes():number {
    let bytes=0;
    for(const suffix of ['','-journal','-wal','-shm']){
      const path=join(this.#directory,`authority.sqlite${suffix}`);
      if(existsSync(path)){this.#plainFile(path);bytes+=statSync(path).size;if(bytes>MAX_AUTHORITY)fail('DURABLE_LIMIT');}
    }
    return bytes;
  }
  #validateSafety(s: Safety, maxCalls: number): void {
    if (!record(s) || s.version !== 1 || s.identity !== this.#identity || !safeInteger(s.reserved) || s.reserved > s.maxCalls
      || !safeInteger(s.lastWall) || !Array.isArray(s.ingress) || s.ingress.length > 8192) fail('DURABLE_CORRUPT');
    if (s.maxCalls !== maxCalls) fail('DURABLE_BUDGET_MISMATCH');
    const seen = new Set<string>();
    for (const e of s.ingress) {
      if (!record(e) || !/^[a-f0-9]{64}$/.test(e.key) || !/^[a-f0-9]{64}$/.test(e.fingerprint)
        || !['pending','ready','taken','acknowledged','failed','unknown'].includes(e.state) || typeof e.feedbackConsumed !== 'boolean' || typeof e.reserved !== 'boolean'
        || (e.deliveryId !== null && (typeof e.deliveryId !== 'string' || e.deliveryId.length > 128)) || seen.has(e.key)) fail('DURABLE_CORRUPT');
      seen.add(e.key);
    }
  }
  #seal(value: unknown, purpose: string): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(`${FORMAT}:${purpose}`));
    const plain = Buffer.from(JSON.stringify(value));
    try { const data = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); }
    finally { plain.fill(0); }
  }
  #unseal(sealed: Uint8Array, purpose: string): unknown {
    if (sealed.length < 29 || sealed.length > MAX_IMAGE * 2) fail('DURABLE_CORRUPT');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${FORMAT}:${purpose}`)); decipher.setAuthTag(sealed.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); } finally { plain.fill(0); }
    } catch { fail('DURABLE_CORRUPT'); }
  }
  #writeNew(path: string, bytes: Uint8Array): void {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  #guard(): void { if (this.#closed || this.#poisoned) fail('DURABLE_UNAVAILABLE'); }
  #wallNow(): number {
    const now = this.#wall();
    if (!Number.isSafeInteger(now) || now < this.#safety.lastWall) { this.#poisoned = true; fail('DURABLE_CLOCK_ROLLBACK'); }
    this.#safety.lastWall = now; return now;
  }
  #commit(image: Uint8Array, revocationHighWater: number): void {
    this.#guard();
    try {
      this.#wallNow();
      if (this.#sequence >= MAX_COMMITS || image.length > MAX_IMAGE) fail('DURABLE_LIMIT');
      const sequence = this.#sequence + 1, checkpoint = `checkpoint-${sequence}-${randomUUID()}.bin`;
      const state: Checkpoint = { version: 1, identity: this.#identity, sequence, image: Buffer.from(image).toString('base64'),
        safety: this.#safety, revocationHighWater };
      const bytes = this.#seal(state, 'checkpoint');
      if (this.#bytes + bytes.length > MAX_DISK) fail('DURABLE_LIMIT');
      this.#fault?.('checkpoint-write');
      const fd = openSync(join(this.#directory, checkpoint), 'wx', 0o600);
      try { writeFileSync(fd, bytes); this.#fault?.('checkpoint-fsync'); fsyncSync(fd); } finally { closeSync(fd); }
      const a: Authority = { version: 1, identity: this.#identity, sequence, previous: this.#previous, checkpoint,
        sha256: sha(bytes), safety: this.#safety, revocationHighWater };
      const sealed = this.#seal(a, 'authority');
      // Conservatively allow a full rollback journal plus new data and page
      // overhead, rather than relying on SQLite's normal small append journal.
      if(sealed.length>MAX_AUTHORITY_RECORD||2*(this.#authorityBytes()+sealed.length+65536)>MAX_AUTHORITY)fail('DURABLE_LIMIT');
      this.#authority!.exec('BEGIN IMMEDIATE');
      try {
        this.#authority!.prepare('INSERT INTO entries(sequence,sealed) VALUES (?,?)').run(sequence, sealed);
        this.#fault?.('authority-commit'); this.#authority!.exec('COMMIT');
      } catch (error) { try { this.#authority!.exec('ROLLBACK'); } catch {} throw error; }
      this.#fault?.('after-authority-commit');
      this.#authorityBytes();
      this.#sequence = sequence; this.#previous = sha(sealed); this.#bytes += bytes.length;
    } catch (error) {
      this.#poisoned = true;
      if (error instanceof CoreError) throw error;
      fail('DURABLE_WRITE_FAILED');
    }
  }
  #save(): void { this.#commit(this.store.snapshot(), this.store.revocationHighWater()); }
  #digest(v: unknown): string { return createHmac('sha256', this.#key).update(JSON.stringify(v)).digest('hex'); }
  claim(id: string, fingerprint: string): void {
    this.#guard(); const key = this.#digest(['ingress', id]), fp = this.#digest(['payload', fingerprint]);
    const prior = this.#safety.ingress.find(e => e.key === key);
    if (prior) { if (prior.fingerprint !== fp) fail('INTERACTION_IDEMPOTENCY_CONFLICT'); fail('INTERACTION_TERMINATED'); }
    if (this.#safety.ingress.length >= 8192) fail('DURABLE_LIMIT');
    this.#safety.ingress.push({ key, fingerprint: fp, state: 'pending', deliveryId: null, feedbackConsumed: false, reserved: false }); this.#save();
  }
  terminal(id: string, state: Terminal, deliveryId: string | null = null): void {
    this.#guard(); const entry = this.#safety.ingress.find(e => e.key === this.#digest(['ingress', id]));
    if (!entry) fail('DURABLE_CORRUPT');
    const next = state === 'failed' && entry.reserved ? 'unknown' : state;
    const allowed: Record<Terminal, Terminal[]> = { pending:['ready','failed','unknown'],ready:['taken','failed','unknown'],
      taken:['acknowledged','unknown'],acknowledged:[],failed:[],unknown:[] };
    if ((entry.deliveryId !== null && deliveryId !== null && entry.deliveryId !== deliveryId)
      || (['ready','taken','acknowledged'].includes(next) && deliveryId === null)) fail('DURABLE_DELIVERY_CONFLICT');
    if (deliveryId && this.#safety.ingress.some(other=>other!==entry&&other.deliveryId===deliveryId)) fail('DURABLE_DELIVERY_CONFLICT');
    if (entry.state === next) {
      if (entry.deliveryId !== deliveryId) fail('DURABLE_DELIVERY_CONFLICT'); return;
    }
    if (!allowed[entry.state].includes(next)) fail('INTERACTION_TERMINATED');
    entry.state = next; if (deliveryId) entry.deliveryId = deliveryId;
    if (state === 'acknowledged') this.#safety.lastAcknowledgedDeliveryId = deliveryId;
    this.#save();
  }
  consumeFeedback(deliveryId: string): void {
    this.#guard(); const entry = this.#safety.ingress.find(e => e.deliveryId === deliveryId);
    if (!entry || entry.state !== 'acknowledged') fail('FEEDBACK_REQUIRES_DELIVERED_RECEIPT');
    if (entry.feedbackConsumed) fail('DELIVERY_FEEDBACK_ALREADY_CONSUMED');
    entry.feedbackConsumed = true; this.#save();
  }
  source(ref: SourceRef): void { this.#guard(); this.#safety.lastSourceRef = structuredClone(ref); this.#save(); }
  reserve(requestId?: string): void {
    this.#guard(); if (this.#safety.reserved >= this.#safety.maxCalls) fail('REQUEST_BUDGET_EXHAUSTED');
    if (typeof requestId !== 'string') fail('DURABLE_REQUEST_REQUIRED');
    const key = this.#digest(['ingress', requestId]);
    const entry = this.#safety.ingress.find(e => e.key === key && e.state === 'pending' && !e.reserved);
    if (!entry) fail('DURABLE_REQUEST_REQUIRED'); entry.reserved = true;
    this.#safety.reserved++; this.#save(); // Must complete before a provider can begin I/O.
  }
  get reserved(): number { this.#guard(); return this.#safety.reserved; }
  get status() {
    this.#guard(); return { version: 1, identity: this.#identity, sequence: this.#sequence, restored: this.restored,
      consumedRequests: this.#safety.reserved, unknownRequests: this.#safety.ingress.filter(e => e.state === 'unknown').length,
      ingressCount: this.#safety.ingress.length, manualResumeRequired: true,
      checkpointBytes: this.#bytes, maxCheckpointHistoryBytes: MAX_DISK, authorityBytes:this.#authorityBytes(),maxAuthorityBytes:MAX_AUTHORITY,
      maxCheckpointBytes: MAX_IMAGE, maxCommits: MAX_COMMITS,
      lastSourceRef: structuredClone(this.#safety.lastSourceRef), lastAcknowledgedDeliveryId: this.#safety.lastAcknowledgedDeliveryId };
  }
  #release(): void {
    try { this.#authority?.close(); } catch {} try { this.#lock?.close(); } catch {}
    this.#authority = undefined; this.#lock = undefined;
  }
  close(): void { if (this.#closed) return; this.#closed = true; try { this.store.close(); } finally { this.#release(); this.#key.fill(0); } }
}
