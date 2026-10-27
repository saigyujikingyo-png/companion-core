import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './store.ts';
import type { Clock } from './store.ts';
import { inspectMemoryImage, maintainFanoutImage, migrateMemoryImage } from './memory-image.ts';
import type { MemorySchema } from './memory-image.ts';
import type { FanoutFault } from './fanout-types.ts';
import type { SourceRef } from './contracts.ts';
import { MAX_COMMITS, MAX_DISK, MAX_IMAGE, sha, validateIdentityBudget } from './durable-codec.ts';
import type { Safety, Terminal } from './durable-codec.ts';
import { CoreError, fail, text } from './validation.ts';
import { ANCHORED_FORMAT, INCREMENTAL_FORMAT, INCREMENTAL_MARKER, VAULT_MARKER, boundSqlite, canonicalDirectory, copyKeys, decodeStage, disjoint, id,
  encodeVaultMarker, identityOf, readBounded, same, sealV2, validateIdentity, writeNew } from './anchored-codec.ts';
import type { FrozenStage, KeySet, StorageProfile, VaultHead, VaultIdentity, VaultRecord, VaultState } from './anchored-codec.ts';
import { directoryReader, freezeFrame, parseFrozenV3, reconstruct, MANIFEST_LIMIT } from './incremental-storage.ts';
import type { Baseline, FrozenV3, Reconstructed } from './incremental-storage.ts';
import { LocalSqliteAuthority } from './local-sqlite-authority.ts';
import type { AnchorReceipt, AuthorityTransaction, PendingCommit } from './local-sqlite-authority.ts';
import {captureLegacyM2,inspectLegacyM2,normalizeLegacyFreeze,rejectLegacyNamespace} from './legacy-m2-import.ts';
import type {InspectLegacyRequest,LegacyInspection} from './legacy-m2-import.ts';
import type {LegacyImportProof,LegacySourceFreeze} from './legacy-import-types.ts';

export type AnchoredConfig = { directory: string; vaultId: string; identity: string; storageDomain: string;
  authority: LocalSqliteAuthority; keys: KeySet; schemaVersion?: MemorySchema; storageProfile?: StorageProfile };
export type AnchoredFault = 'stage-written' | 'prepared' | 'checkpoint-published' | 'record-published' | 'finalized';
type Options = { clock?: Clock; fault?: (point: AnchoredFault) => void; fanoutFault?: (point: FanoutFault) => void };
export type RestoreRequest = { backupDirectory: string; targetDirectory: string; storageDomain: string;
  authority: LocalSqliteAuthority; keys: KeySet; maxCalls: number; operationId: string; fault?: (point: AnchoredFault) => void };
export type CompactRequest = Omit<RestoreRequest,'backupDirectory'> & {vaultId:string};
export type LegacyImportRequest=InspectLegacyRequest & {sourceFreeze:LegacySourceFreeze;authority:LocalSqliteAuthority;vaultId:string;targetDirectory:string;
  storageDomain:string;storageProfile:StorageProfile;newStorageDEK:Uint8Array;operationId:string;targetSchema?:2;fault?:(point:AnchoredFault)=>void};
export type BackupReceipt = { format: VaultIdentity['format']; coverage: 'current-state'; head: VaultHead; stageDigest: string };
type Decoded = ReturnType<typeof decodeStage> | Reconstructed;
type Frozen = { bytes:Buffer;stage:FrozenStage|FrozenV3;blob?:Buffer;baseline?:Baseline };
const markerName=(identity:VaultIdentity)=>identity.format===INCREMENTAL_FORMAT?INCREMENTAL_MARKER:VAULT_MARKER;

function storagePath(directory: string, domain: string, authority: LocalSqliteAuthority, mustExist: boolean): string {
  id(domain);
  if (!(authority instanceof LocalSqliteAuthority) || domain === authority.custodyDomain) fail('ANCHOR_CUSTODY_OVERLAP');
  const path = mustExist ? canonicalDirectory(directory) : join(canonicalDirectory(dirname(resolve(directory))), resolve(directory).slice(dirname(resolve(directory)).length + 1));
  rejectLegacyNamespace(path);disjoint(path, authority.directory); return path;
}
function createDirectory(path: string): void { if (existsSync(path)) fail('ANCHOR_TARGET_EXISTS'); mkdirSync(path); }
const marker=encodeVaultMarker;
function readMarker(directory: string): VaultIdentity {
  let value: VaultIdentity;
  try {
    const old=existsSync(join(directory,VAULT_MARKER)),next=existsSync(join(directory,INCREMENTAL_MARKER));
    if(old===next)fail('ANCHOR_INCOMPLETE');value=JSON.parse(readBounded(join(directory,next?INCREMENTAL_MARKER:VAULT_MARKER),8192).toString('utf8'));
    if(markerName(value)!==(next?INCREMENTAL_MARKER:VAULT_MARKER))fail('ANCHOR_INCOMPLETE');
  }
  catch { fail('ANCHOR_INCOMPLETE'); }
  validateIdentity(value); if (value.directory !== directory) fail('ANCHOR_INSTANCE_PATH'); return value;
}
function diskBytes(directory: string): number {
  let total = 0;
  for (const file of readdirSync(directory)) {
    const stat = lstatSync(join(directory, file));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('ANCHOR_FILE'); total += stat.size;
  }
  if (total > MAX_DISK) fail('ANCHOR_LIMIT'); return total;
}
function stageBytes(identity: VaultIdentity, sequence: number, operationId: string, image: Uint8Array, safety: Safety,
  revocationHighWater: number, keys: KeySet, oldHead: VaultHead | null, parentHead: VaultHead | null,
  maintenance?: PendingCommit['maintenance'], baseline:Baseline|null=null,legacyImport?:LegacyImportProof): Frozen {
  if (image.length > MAX_IMAGE || sequence > MAX_COMMITS) fail('ANCHOR_LIMIT');
  if(identity.format===INCREMENTAL_FORMAT)return freezeFrame(identity,sequence,operationId,image,safety,revocationHighWater,keys,oldHead,parentHead,baseline,maintenance,legacyImport);
  const state: VaultState = { version: 2, identity, sequence, image: Buffer.from(image).toString('base64'), safety,
    revocationHighWater, ingressKeyDigest: sha(keys.ingressKey) };
  const checkpoint = sealV2(state, 'checkpoint', identity, keys.storageDEK);
  const row: VaultRecord = { version: 2, identity, sequence, operationId, previous: oldHead?.digest ?? null,
    parentHead, checkpointDigest: sha(checkpoint), revocationHighWater, ...(maintenance ? { maintenance } : {}) };
  const record = sealV2(row, 'record', identity, keys.storageDEK);
  const stage: FrozenStage = { format: ANCHORED_FORMAT, head: { ...identity, sequence, digest: sha(record) },
    checkpoint: checkpoint.toString('base64'), record: record.toString('base64') };
  return { bytes: Buffer.from(JSON.stringify(stage)), stage };
}
function writeStage(directory: string, operationId: string, bytes: Buffer, frozen:Frozen): string {
  if (diskBytes(directory) + bytes.length * 2 + (frozen.blob?.length??0) > MAX_DISK) fail('ANCHOR_LIMIT');
  if(frozen.stage.format===INCREMENTAL_FORMAT){if(!frozen.blob)fail('INCREMENTAL_CORRUPT');writeNew(join(directory,frozen.stage.blob),frozen.blob);}
  const path = join(directory, `stage-${operationId}.json`); writeNew(path, bytes); return path;
}
function publish(stage: FrozenStage|FrozenV3, fault?: (point: AnchoredFault) => void): void {
  if(stage.format===INCREMENTAL_FORMAT){
    if(sha(readBounded(join(stage.head.directory,stage.blob),stage.blobLength))!==stage.blobDigest)fail('ANCHOR_PUBLISH_CONFLICT');
    fault?.('checkpoint-published');const path=join(stage.head.directory,`record-${stage.head.sequence}.bin`),bytes=Buffer.from(stage.record,'base64');
    if(existsSync(path)){if(!readBounded(path).equals(bytes))fail('ANCHOR_PUBLISH_CONFLICT');}else writeNew(path,bytes);
    fault?.('record-published');return;
  }
  for (const [name, data, point] of [
    [`checkpoint-${stage.head.sequence}.bin`, stage.checkpoint, 'checkpoint-published'],
    [`record-${stage.head.sequence}.bin`, stage.record, 'record-published'],
  ] as const) {
    const path = join(stage.head.directory, name), bytes = Buffer.from(data, 'base64');
    if (existsSync(path)) { if (!readBounded(path).equals(bytes)) fail('ANCHOR_PUBLISH_CONFLICT'); }
    else writeNew(path, bytes);
    fault?.(point);
  }
}
function readCurrent(head: VaultHead, keys: KeySet, maxCalls: number): Decoded {
  if (!same(readMarker(head.directory), identityOf(head))) fail('ANCHOR_IDENTITY');
  if(head.format===INCREMENTAL_FORMAT)return reconstruct(head,directoryReader(head.directory),keys,maxCalls);
  return decodeStage(Buffer.from(JSON.stringify({ format: ANCHORED_FORMAT, head,
    checkpoint: readBounded(join(head.directory, `checkpoint-${head.sequence}.bin`)).toString('base64'),
    record: readBounded(join(head.directory, `record-${head.sequence}.bin`)).toString('base64') })), keys, maxCalls);
}
function validateImage(image: Uint8Array, highWater: number, schema: MemorySchema = 1): void {
  if (inspectMemoryImage(image, schema).revocationHighWater !== highWater) fail('ANCHOR_CORRUPT');
}
function readBackup(directory: string, keys: KeySet, maxCalls: number): Decoded & { bytes: Buffer } {
  const path = canonicalDirectory(directory);let receipt:BackupReceipt;
  try{receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBounded(join(path,'backup.json'),16384)));}catch{fail('ANCHOR_BACKUP');}
  if(!receipt||![ANCHORED_FORMAT,INCREMENTAL_FORMAT].includes(receipt.format)||receipt.coverage!=='current-state')fail('ANCHOR_BACKUP');
  const bytes=receipt.format===INCREMENTAL_FORMAT?readBounded(join(path,'current-state.json'),MANIFEST_LIMIT):readBounded(join(path,'current-state.json'));
  let decoded:Decoded;
  if(receipt.format===INCREMENTAL_FORMAT){
    let candidate:any;try{candidate=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('ANCHOR_BACKUP');}
    if(candidate?.format!==INCREMENTAL_FORMAT)fail('ANCHOR_BACKUP');
    if(bytes.length>MANIFEST_LIMIT||Object.keys(candidate).sort().join(',')!=='files,format,head'||!Array.isArray(candidate.files)||candidate.files.length>32)fail('ANCHOR_BACKUP');
    const files=new Map<string,{size:number;digest:string}>();let total=0;
    for(const file of candidate.files){if(!file||Object.keys(file).sort().join(',')!=='digest,name,size'||typeof file.name!=='string'
      ||! /^(blob-[a-f0-9]{64}|record-[1-9][0-9]*)\.bin$/.test(file.name)||files.has(file.name)||!Number.isSafeInteger(file.size)||file.size<1||! /^[a-f0-9]{64}$/.test(file.digest))fail('ANCHOR_BACKUP');
      total+=file.size;if(total>64*1024*1024)fail('ANCHOR_BACKUP');files.set(file.name,file);}
    decoded=reconstruct(candidate.head,(name,max)=>{const file=files.get(name);if(!file||file.size>max)fail('ANCHOR_BACKUP');const data=readBounded(join(path,name),file.size);
      if(data.length!==file.size||sha(data)!==file.digest)fail('ANCHOR_BACKUP');return data;},keys,maxCalls);
    if(files.size!==decoded.files.size){decoded.image.fill(0);fail('ANCHOR_BACKUP');}
  }else decoded=decodeStage(bytes,keys,maxCalls);
  try {
    if (receipt.format !== decoded.stage.head.format || receipt.coverage !== 'current-state' || receipt.stageDigest !== sha(bytes) || !same(receipt.head, decoded.stage.head)) fail('ANCHOR_BACKUP');
    validateImage(decoded.image, decoded.state.revocationHighWater, decoded.stage.head.schemaVersion ?? 1);
    return { ...decoded, bytes };
  } catch (error) { decoded.image.fill(0); throw error; }
}

/** A separate mandatory-anchor format. Never opens/upgrades an M2.v1 directory. */
export class AnchoredVault {
  #store!: MemoryStore;
  get store(): MemoryStore { return this.#store; }
  readonly restored: boolean;
  readonly #authority: LocalSqliteAuthority;
  readonly #identity: VaultIdentity;
  readonly #keys: KeySet;
  readonly #clock: Clock;
  readonly #fault: Options['fault'];
  #head: VaultHead | null = null;
  #baseline: Baseline | null = null;
  #safety: Safety;
  #writer: DatabaseSync | undefined;
  #tx: AuthorityTransaction | undefined;
  #depth = 0;
  #storePermit = false;
  #closed = false;
  #poisoned = false;
  private constructor(config: AnchoredConfig, maxCalls: number, options: Options, creating: boolean) {
    id(config.vaultId); text(config.identity,128); validateIdentityBudget(config.identity, maxCalls);
    this.#authority = config.authority; this.#keys = copyKeys(config.keys); this.#fault = options.fault;
    this.#clock = options.clock ?? { wall: Date.now, monotonic: () => performance.now() };
    const directory = storagePath(config.directory, config.storageDomain, config.authority, !creating);
    this.#identity = creating ? { format: config.storageProfile?INCREMENTAL_FORMAT:ANCHORED_FORMAT, authorityId: config.authority.authorityId, vaultId: config.vaultId,
      identity: config.identity, instanceId: randomUUID(), ownerEpoch: 1, keyEpoch: config.keys.keyEpoch, directory, storageDomain: config.storageDomain,
      ...(config.schemaVersion === 2 ? { schemaVersion: 2 } : {}),...(config.storageProfile?{storageProfile:config.storageProfile}:{}) } : readMarker(directory);
    validateIdentity(this.#identity);
    if (this.#identity.authorityId !== config.authority.authorityId || this.#identity.vaultId !== config.vaultId
      || this.#identity.identity !== config.identity || this.#identity.keyEpoch !== config.keys.keyEpoch || this.#identity.storageDomain !== config.storageDomain
      || (this.#identity.schemaVersion ?? 1) !== (config.schemaVersion ?? 1)||this.#identity.storageProfile!==config.storageProfile) fail('ANCHOR_IDENTITY');
    this.#safety = { version: 1, identity: config.identity, maxCalls, reserved: 0, ingress: [], lastSourceRef: null, lastAcknowledgedDeliveryId: null, lastWall: 0 };
    let store: MemoryStore | undefined;
    this.restored = !creating;
    try {
      if (creating) { createDirectory(directory); writeNew(join(directory, markerName(this.#identity)), marker(this.#identity)); }
      const writerPath = join(directory, 'writer.sqlite');
      boundSqlite(directory, 'writer.sqlite', 65536);
      this.#writer = new DatabaseSync(writerPath, { timeout: 0, allowExtension: false });
      try {
        if (this.#writer.prepare('PRAGMA user_version').get()!.user_version !== 0
          || this.#writer.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length !== 0) fail('ANCHOR_WRITER_LAYOUT');
        this.#writer.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
      } catch (error) { if (error instanceof CoreError) throw error; fail('ANCHOR_WRITER_BUSY'); }
      this.#authority.transaction(tx => {
        this.#depth = 1; this.#tx = tx;
        let image: Buffer | undefined;
        try {
          const row = tx.row(config.vaultId);
          if (creating) { if (row) fail('ANCHOR_ALREADY_REGISTERED'); }
          else {
            if (!row) fail('ANCHOR_UNREGISTERED'); if (row.status !== 'ACTIVE') fail('ANCHOR_PENDING');
            this.#head = row.head!;
            if (!same(identityOf(this.#head), this.#identity)) fail('ANCHOR_FENCED');
            tx.assertActive(this.#head); // Includes mandatory imported-lineage registry validation before boot or staging.
            const decoded = readCurrent(this.#head, this.#keys, maxCalls); image = decoded.image; this.#safety = decoded.state.safety;
            if('baseline' in decoded)this.#baseline={...decoded.baseline,image:Buffer.from(decoded.image)};
          }
          for (const entry of this.#safety.ingress) if (['pending','ready','taken'].includes(entry.state)) entry.state = 'unknown';
          this.#safety.lastAcknowledgedDeliveryId = null;
          this.#wallNow();
          store = new MemoryStore(':memory:', { ...(image ? { image } : {}), clock: { wall: () => this.#wallNow(), monotonic: this.#clock.monotonic },
            schemaVersion: this.#identity.schemaVersion ?? 1, ...(options.fanoutFault ? { fanoutFault: options.fanoutFault } : {}),
            aroundAccess: body => this.#storeAccess(body), assertHealthy: () => this.#healthy(), onPoison: () => { this.#poisoned = true; },
            persist: (bytes, highWater) => this.#commit(bytes, highWater), assertCloseAllowed: () => { if (this.#depth) fail('ANCHOR_ACCESS_BUSY'); } });
          this.#store = store;
          if (image) validateImage(image, this.#withStore(() => store!.revocationHighWater()), this.#identity.schemaVersion ?? 1);
          this.#save();
        } finally { image?.fill(0); this.#depth = 0; this.#tx = undefined; }
      });
      this.#store = store!;
    } catch (error) {
      this.#depth = 0; try { store?.close(); } catch {} try { this.#writer?.close(); } catch {}
      this.#baseline?.image.fill(0);this.#keys.storageDEK.fill(0); this.#keys.ingressKey.fill(0); throw error;
    }
  }
  static create(config: AnchoredConfig, maxCalls: number, options: Options = {}): AnchoredVault { return new AnchoredVault(config, maxCalls, options, true); }
  static open(config: AnchoredConfig, maxCalls: number, options: Options = {}): AnchoredVault { return new AnchoredVault(config, maxCalls, options, false); }
  #healthy(): void { if (this.#closed || this.#poisoned) fail('ANCHOR_UNAVAILABLE'); }
  #access<T>(body: () => T): T {
    this.#healthy(); if (this.#depth) fail('ANCHOR_ACCESS_BUSY');
    return this.#authority.transaction(tx => {
      tx.assertActive(this.#head!); this.#depth = 1; this.#tx = tx;
      try { return body(); } finally { this.#depth = 0; this.#tx = undefined; }
    });
  }
  #storeAccess<T>(body: () => T): T {
    if (!this.#depth) return this.#access(body);
    if (!this.#storePermit) fail('ANCHOR_ACCESS_BUSY');
    this.#storePermit = false;
    try { return body(); } finally { this.#storePermit = true; }
  }
  #withStore<T>(body: () => T): T {
    this.#storePermit = true; try { return body(); } finally { this.#storePermit = false; }
  }
  #wallNow(): number {
    const now = this.#clock.wall();
    if (!Number.isSafeInteger(now) || now < this.#safety.lastWall) { this.#poisoned = true; fail('ANCHOR_CLOCK_ROLLBACK'); }
    this.#safety.lastWall = now; return now;
  }
  #commit(image: Uint8Array, highWater: number): void {
    if (!this.#depth || !this.#tx) fail('ANCHOR_TRANSACTION');
    try {
      this.#wallNow(); const operationId = randomUUID(), sequence = (this.#head?.sequence ?? 0) + 1;
      const frozen = stageBytes(this.#identity, sequence, operationId, image, this.#safety, highWater, this.#keys, this.#head, null,undefined,this.#baseline);
      const stagePath = writeStage(this.#identity.directory, operationId, frozen.bytes,frozen); this.#fault?.('stage-written');
      const pending: PendingCommit = { version: 2, kind: this.#head ? 'write' : 'create', operationId, requestDigest: sha(frozen.bytes),
        oldHead: this.#head, newHead: frozen.stage.head, stagePath, stageDigest: sha(frozen.bytes) };
      this.#tx.prepare(pending); this.#fault?.('prepared');
      publish(frozen.stage, this.#fault); this.#tx.finalize(pending); this.#head = frozen.stage.head;
      if(frozen.baseline){this.#baseline?.image.fill(0);this.#baseline={...frozen.baseline,image:Buffer.from(image)};}this.#fault?.('finalized');
    } catch (error) { this.#poisoned = true; if (error instanceof CoreError) throw error; fail('ANCHOR_WRITE_FAILED'); }
  }
  #save(): void {
    let image:Uint8Array|undefined;
    try { image=this.#withStore(() => this.store.snapshot()); this.#commit(image, this.#withStore(() => this.store.revocationHighWater())); }
    catch(error) { this.#poisoned=true; if(error instanceof CoreError)throw error; fail('ANCHOR_WRITE_FAILED'); }
    finally { image?.fill(0); }
  }
  #digest(value: unknown): string { return createHmac('sha256', this.#keys.ingressKey).update(JSON.stringify(value)).digest('hex'); }
  claim(requestId: string, fingerprint: string): void {
    this.#access(() => {
      this.#tx!.assertAdmitted(this.#head!);
      text(requestId, 256); text(fingerprint, 4096);
      const key = this.#digest(['ingress', requestId]), fp = this.#digest(['payload', fingerprint]), prior = this.#safety.ingress.find(e => e.key === key);
      if (prior) { if (prior.fingerprint !== fp) fail('INTERACTION_IDEMPOTENCY_CONFLICT'); fail('INTERACTION_TERMINATED'); }
      if (this.#safety.ingress.length >= 8192) fail('ANCHOR_LIMIT');
      this.#safety.ingress.push({ key, fingerprint: fp, state: 'pending', deliveryId: null, feedbackConsumed: false, reserved: false }); this.#save();
    });
  }
  reserve(requestId?: string): void {
    this.#access(() => {
      this.#tx!.assertAdmitted(this.#head!);
      if (this.#safety.reserved >= this.#safety.maxCalls) fail('REQUEST_BUDGET_EXHAUSTED');
      if (typeof requestId !== 'string') fail('DURABLE_REQUEST_REQUIRED');
      const entry = this.#safety.ingress.find(e => e.key === this.#digest(['ingress', requestId]) && e.state === 'pending' && !e.reserved);
      if (!entry) fail('DURABLE_REQUEST_REQUIRED'); entry.reserved = true; this.#safety.reserved++; this.#save();
    });
  }
  terminal(requestId: string, state: Terminal, deliveryId: string | null = null): void {
    this.#access(() => {
      const entry = this.#safety.ingress.find(e => e.key === this.#digest(['ingress', requestId])); if (!entry) fail('ANCHOR_CORRUPT');
      const next = state === 'failed' && entry.reserved ? 'unknown' : state;
      const allowed: Record<Terminal, Terminal[]> = { pending: ['ready','failed','unknown'], ready: ['taken','failed','unknown'], taken: ['acknowledged','unknown'], acknowledged: [], failed: [], unknown: [] };
      if (!(next in allowed)) fail('INVALID_INPUT');
      if ((entry.deliveryId !== null && deliveryId !== null && entry.deliveryId !== deliveryId)
        || (['ready','taken','acknowledged'].includes(next) && deliveryId === null)) fail('DURABLE_DELIVERY_CONFLICT');
      if (deliveryId !== null) { text(deliveryId, 128); if (this.#safety.ingress.some(e => e !== entry && e.deliveryId === deliveryId)) fail('DURABLE_DELIVERY_CONFLICT'); }
      if (entry.state === next) { if (entry.deliveryId !== deliveryId) fail('DURABLE_DELIVERY_CONFLICT'); return; }
      if (!allowed[entry.state].includes(next)) fail('INTERACTION_TERMINATED');
      entry.state = next; if (deliveryId) entry.deliveryId = deliveryId;
      if (state === 'acknowledged') this.#safety.lastAcknowledgedDeliveryId = deliveryId; this.#save();
    });
  }
  consumeFeedback(deliveryId: string): void {
    this.#access(() => {
      const entry = this.#safety.ingress.find(e => e.deliveryId === deliveryId);
      if (!entry || entry.state !== 'acknowledged') fail('FEEDBACK_REQUIRES_DELIVERED_RECEIPT');
      if (entry.feedbackConsumed) fail('DELIVERY_FEEDBACK_ALREADY_CONSUMED'); entry.feedbackConsumed = true; this.#save();
    });
  }
  source(ref: SourceRef): void { this.#access(() => { this.#safety.lastSourceRef = structuredClone(ref); this.#save(); }); }
  get head(): VaultHead { return this.#access(() => structuredClone(this.#head!)); }
  get reserved(): number { return this.#access(() => this.#safety.reserved); }
  get status() {
    return this.#access(() => ({ format: this.#identity.format, head: structuredClone(this.#head!), restored: this.restored,
      consumedRequests: this.#safety.reserved, unknownRequests: this.#safety.ingress.filter(e => e.state === 'unknown').length,
      ingressCount: this.#safety.ingress.length, lastSourceRef: structuredClone(this.#safety.lastSourceRef),
      lastAcknowledgedDeliveryId: this.#safety.lastAcknowledgedDeliveryId, manualResumeRequired: true, coverage: 'current-state' as const }));
  }
  exportBackup(target: string): BackupReceipt {
    return this.#access(() => {
      const directory = storagePath(target, this.#identity.storageDomain, this.#authority, false);
      disjoint(directory, this.#identity.directory);
      const decoded = readCurrent(this.#head!, this.#keys, this.#safety.maxCalls);
      try {
        validateImage(decoded.image, decoded.state.revocationHighWater, this.#identity.schemaVersion ?? 1);
        const files='files' in decoded?decoded.files:undefined;
        const bytes = Buffer.from(JSON.stringify(files?{format:INCREMENTAL_FORMAT,head:this.#head!,files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,data])=>({name,size:data.length,digest:sha(data)}))}:decoded.stage));
        const receipt: BackupReceipt = { format: this.#identity.format, coverage: 'current-state', head: this.#head!, stageDigest: sha(bytes) };
        createDirectory(directory);if(files)for(const[name,data]of files)writeNew(join(directory,name),data);
        writeNew(join(directory, 'current-state.json'), bytes); writeNew(join(directory, 'backup.json'), Buffer.from(JSON.stringify(receipt)));
        return structuredClone(receipt);
      } finally { decoded.image.fill(0); }
    });
  }
  close(): void {
    if (this.#depth) fail('ANCHOR_ACCESS_BUSY'); if (this.#closed) return; this.#closed = true;
    try { this.store.close(); } finally { this.#writer?.close(); this.#baseline?.image.fill(0);this.#keys.storageDEK.fill(0); this.#keys.ingressKey.fill(0); }
  }

  static verifyBackup(request: Pick<RestoreRequest, 'backupDirectory' | 'authority' | 'keys' | 'maxCalls'>): BackupReceipt {
    const decoded = readBackup(request.backupDirectory, request.keys, request.maxCalls);
    try {
      disjoint(canonicalDirectory(request.backupDirectory), request.authority.directory);
      return request.authority.transaction(tx => { tx.assertActive(decoded.stage.head); return { format: decoded.stage.head.format,
        coverage: 'current-state', head: decoded.stage.head, stageDigest: sha(decoded.bytes) }; });
    } finally { decoded.image.fill(0); }
  }
  static restoreBackup(request: RestoreRequest): AnchorReceipt { return AnchoredVault.#cutover(request); }
  static rekeyBackup(request: RestoreRequest & { newStorageDEK: Uint8Array }): AnchorReceipt { return AnchoredVault.#cutover(request, request.newStorageDEK); }
  static migrateBackup(request: RestoreRequest & { targetSchema: 2 }): AnchorReceipt {
    if (request.targetSchema !== 2) fail('UNSUPPORTED_MIGRATION'); return AnchoredVault.#cutover(request, undefined, 2);
  }
  static inspectLegacyM2(request:InspectLegacyRequest):LegacyInspection{return inspectLegacyM2(request);}
  /** One captured verified legacy snapshot -> one new anchored genesis. The
   * independent authority's lineage registry prevents second quota admissions. */
  static importLegacyM2(request:LegacyImportRequest):AnchorReceipt{
    id(request.vaultId);id(request.operationId);if(request.targetSchema!==undefined&&request.targetSchema!==2)fail('UNSUPPORTED_MIGRATION');
    if(!(request.newStorageDEK instanceof Uint8Array)||request.newStorageDEK.length!==32||Buffer.from(request.newStorageDEK).equals(request.legacyKey))fail('LEGACY_KEY_SEPARATION');
    const captured=captureLegacyM2(request),keys=copyKeys({version:2,keyEpoch:1,storageDEK:request.newStorageDEK,ingressKey:request.legacyKey});let migrated:Uint8Array|undefined;
    try{
      if(!same(captured.inspection.sourceFreeze,normalizeLegacyFreeze(request.sourceFreeze,request.identity)))fail('LEGACY_SOURCE_CHANGED');
      if(request.operationId!==captured.inspection.migrationId)fail('LEGACY_OPERATION');
      const target=storagePath(request.targetDirectory,request.storageDomain,request.authority,false);disjoint(target,captured.directory);disjoint(captured.directory,request.authority.directory);
      const proof:LegacyImportProof={version:1,lineageId:captured.inspection.lineageId,migrationId:captured.inspection.migrationId,genesisAuthorityDigest:captured.inspection.genesisAuthorityDigest,
        sourceFreeze:captured.inspection.sourceFreeze,latestProven:false,legacyCopiesFenced:false,quotaScope:'this-authority-only',sourceRetirement:'not-established',admissionAtImport:'required'};
      const requestDigest=sha(JSON.stringify({kind:'legacy-m2-import',proof,target,vaultId:request.vaultId,storageDomain:request.storageDomain,storageProfile:request.storageProfile,
        targetSchema:request.targetSchema??1,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey),maxCalls:request.expectedMaxCalls}));
      return request.authority.transaction(tx=>{
        const registered=tx.legacy(proof.lineageId);
        if(registered){if(registered.requestDigest!==requestDigest||registered.vaultId!==request.vaultId)fail('LEGACY_LINEAGE_CONSUMED');
          if(registered.status==='PREPARED')fail('ANCHOR_PENDING');if(!registered.importReceipt)fail('LEGACY_REGISTRY');return registered.importReceipt;}
        if(tx.row(request.vaultId))fail('ANCHOR_ALREADY_REGISTERED');
        const identity:VaultIdentity={format:INCREMENTAL_FORMAT,authorityId:request.authority.authorityId,vaultId:request.vaultId,identity:request.identity,instanceId:randomUUID(),ownerEpoch:1,keyEpoch:1,
          directory:target,storageDomain:request.storageDomain,storageProfile:request.storageProfile,...(request.targetSchema?{schemaVersion:request.targetSchema}:{}),legacyImport:{lineageId:proof.lineageId,migrationId:proof.migrationId}};
        const encodedMarker=marker(identity);if(request.targetSchema)migrated=migrateMemoryImage(captured.image,1,2,captured.safety.lastWall);
        for(const entry of captured.safety.ingress)if(['pending','ready','taken'].includes(entry.state))entry.state='unknown';captured.safety.lastAcknowledgedDeliveryId=null;
        createDirectory(target);writeNew(join(target,markerName(identity)),encodedMarker);
        const frozen=stageBytes(identity,1,request.operationId,migrated??captured.image,captured.safety,captured.inspection.revocationHighWater,keys,null,null,undefined,null,proof);
        const stagePath=writeStage(target,request.operationId,frozen.bytes,frozen);request.fault?.('stage-written');
        const pending:PendingCommit={version:2,kind:'legacy-m2-import',operationId:request.operationId,requestDigest,oldHead:null,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes),legacyImport:proof};
        tx.prepare(pending);request.fault?.('prepared');publish(frozen.stage,request.fault);const receipt=tx.finalize(pending);request.fault?.('finalized');return receipt;
      });
    }finally{captured.image.fill(0);migrated?.fill(0);keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  /** New active generation; retains the source directory and does not boot it. */
  static compact(request:CompactRequest):AnchorReceipt{return AnchoredVault.#rewriteCurrent(request);}
  /** Explicit v2 -> v3 storage transition, independent of application schema. */
  static upgradeStorage(request:CompactRequest & {storageProfile:StorageProfile}):AnchorReceipt{
    if(!['blocks-br4-v1','full-br4-v1'].includes(request.storageProfile))fail('ANCHOR_STORAGE_PROFILE');
    return AnchoredVault.#rewriteCurrent(request,request.storageProfile);
  }
  static #rewriteCurrent(request:CompactRequest,profile?:StorageProfile):AnchorReceipt{
    id(request.vaultId);id(request.operationId);const keys=copyKeys(request.keys);
    const target=storagePath(request.targetDirectory,request.storageDomain,request.authority,false),kind=profile?'storage-upgrade':'compaction';
    try{return request.authority.transaction(tx=>{
      const digest=(oldHead:VaultHead)=>sha(JSON.stringify({kind,oldHead,target,storageDomain:request.storageDomain,profile:profile??oldHead.storageProfile,
        maxCalls:request.maxCalls,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey)}));
      const prior=tx.receipt(request.vaultId,request.operationId);if(prior){if(!prior.oldHead||prior.requestDigest!==digest(prior.oldHead))fail('ANCHOR_OPERATION_CONFLICT');return prior;}
      const row=tx.row(request.vaultId);if(!row?.head)fail('ANCHOR_UNREGISTERED');tx.assertActive(row.head);const oldHead=row.head;
      if(profile?oldHead.format!==ANCHORED_FORMAT:oldHead.format!==INCREMENTAL_FORMAT)fail('ANCHOR_STORAGE_PROFILE');disjoint(oldHead.directory,target);
      const decoded=readCurrent(oldHead,keys,request.maxCalls);
      try{
        validateImage(decoded.image,decoded.state.revocationHighWater,oldHead.schemaVersion??1);
        const identity:VaultIdentity={...identityOf(oldHead),format:INCREMENTAL_FORMAT,storageProfile:profile??oldHead.storageProfile!,
          instanceId:randomUUID(),ownerEpoch:oldHead.ownerEpoch+1,directory:target,storageDomain:request.storageDomain};
        validateIdentity(identity);createDirectory(target);writeNew(join(target,markerName(identity)),marker(identity));
        const frozen=stageBytes(identity,1,request.operationId,decoded.image,decoded.state.safety,decoded.state.revocationHighWater,keys,null,oldHead);
        const stagePath=writeStage(target,request.operationId,frozen.bytes,frozen);request.fault?.('stage-written');
        const pending:PendingCommit={version:2,kind,operationId:request.operationId,requestDigest:digest(oldHead),oldHead,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes)};
        tx.prepare(pending);request.fault?.('prepared');publish(frozen.stage,request.fault);const receipt=tx.finalize(pending);request.fault?.('finalized');return receipt;
      }finally{decoded.image.fill(0);}
    });}finally{keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  /** Capacity recovery reads the authority's exact CURRENT files, without booting
   * the source or requiring a possibly stale backup. Required reset IDs are explicit. */
  static maintainFanout(request: { authority: LocalSqliteAuthority; vaultId: string; keys: KeySet; maxCalls: number;
    targetDirectory: string; storageDomain: string; operationId: string; retainBatches: number; resetConsumerIds: string[];
    fault?: (point: AnchoredFault) => void }): AnchorReceipt {
    id(request.operationId); id(request.vaultId);
    if (!Array.isArray(request.resetConsumerIds)) fail('FANOUT_RESET_SELECTION');
    const selected = [...request.resetConsumerIds].sort(); for (const consumerId of selected) text(consumerId,128);
    const target = storagePath(request.targetDirectory, request.storageDomain, request.authority, false), keys = copyKeys(request.keys);
    try {
      return request.authority.transaction(tx => {
        const digest = (oldHead: VaultHead) => sha(JSON.stringify({kind:'fanout-maintenance',oldHead,target,storageDomain:request.storageDomain,
          retainBatches:request.retainBatches,resetConsumerIds:selected,keyEpoch:keys.keyEpoch,storageKeyDigest:sha(keys.storageDEK),ingressKeyDigest:sha(keys.ingressKey)}));
        const prior = tx.receipt(request.vaultId,request.operationId);
        if (prior) { if (!prior.oldHead || prior.requestDigest !== digest(prior.oldHead)) fail('ANCHOR_OPERATION_CONFLICT'); return prior; }
        const row = tx.row(request.vaultId); if (!row?.head) fail('ANCHOR_UNREGISTERED'); tx.assertActive(row.head);
        const oldHead = row.head; if (oldHead.schemaVersion !== 2) fail('FANOUT_SCHEMA_REQUIRED');
        disjoint(target,oldHead.directory);
        const decoded = readCurrent(oldHead,keys,request.maxCalls); let image:Uint8Array|undefined;
        try {
          validateImage(decoded.image,decoded.state.revocationHighWater,2);
          const result = maintainFanoutImage(decoded.image,request.retainBatches,selected,decoded.state.safety.lastWall); image=result.image;
          const maintenance = {floor:result.floor,resetConsumerIds:result.resetConsumers};
          const identity:VaultIdentity = {...identityOf(oldHead),instanceId:randomUUID(),ownerEpoch:oldHead.ownerEpoch+1,directory:target,storageDomain:request.storageDomain};
          createDirectory(target);writeNew(join(target,markerName(identity)),marker(identity));
          const frozen=stageBytes(identity,1,request.operationId,image,decoded.state.safety,decoded.state.revocationHighWater,keys,null,oldHead,maintenance);
          const stagePath=writeStage(target,request.operationId,frozen.bytes,frozen);request.fault?.('stage-written');
          const pending:PendingCommit={version:2,kind:'fanout-maintenance',operationId:request.operationId,requestDigest:digest(oldHead),
            oldHead,newHead:frozen.stage.head,stagePath,stageDigest:sha(frozen.bytes),maintenance};
          tx.prepare(pending);request.fault?.('prepared');publish(frozen.stage,request.fault);const receipt=tx.finalize(pending);request.fault?.('finalized');return receipt;
        }finally{image?.fill(0);decoded.image.fill(0);}
      });
    }finally{keys.storageDEK.fill(0);keys.ingressKey.fill(0);}
  }
  static #cutover(request: RestoreRequest, newStorageDEK?: Uint8Array, targetSchema?: 2): AnchorReceipt {
    id(request.operationId); validateIdentityBudget('synthetic-validation', request.maxCalls);
    const keys = copyKeys(request.keys);
    if (newStorageDEK) {
      if (newStorageDEK.length !== 32 || Buffer.from(newStorageDEK).equals(keys.storageDEK) || Buffer.from(newStorageDEK).equals(keys.ingressKey)) fail('ANCHOR_KEYSET');
      keys.storageDEK.fill(0); keys.storageDEK = Buffer.from(newStorageDEK); keys.keyEpoch++;
    }
    const decoded = readBackup(request.backupDirectory, request.keys, request.maxCalls);
    let migrated: Uint8Array | undefined;
    try {
      disjoint(canonicalDirectory(request.backupDirectory), request.authority.directory);
      const target = storagePath(request.targetDirectory, request.storageDomain, request.authority, false), oldHead = decoded.stage.head;
      disjoint(target, canonicalDirectory(request.backupDirectory)); disjoint(target, oldHead.directory);
      const kind = targetSchema ? 'schema-migration' : newStorageDEK ? 'rekey' : 'restore';
      const requestDigest = sha(JSON.stringify({ kind, backupDigest: sha(decoded.bytes), target, storageDomain: request.storageDomain,
        keyEpoch: keys.keyEpoch, ...(targetSchema ? { targetSchema } : {}), storageKeyDigest: sha(keys.storageDEK), ingressKeyDigest: sha(keys.ingressKey) }));
      return request.authority.transaction(tx => {
        const prior = tx.receipt(oldHead.vaultId, request.operationId);
        if (prior) { if (prior.requestDigest !== requestDigest) fail('ANCHOR_OPERATION_CONFLICT'); return prior; }
        tx.assertActive(oldHead); // Exact fresh head is taken from independently held authority, never package trust alone.
        if (targetSchema) migrated = migrateMemoryImage(decoded.image, oldHead.schemaVersion ?? 1, targetSchema, decoded.state.safety.lastWall);
        const identity: VaultIdentity = { ...identityOf(oldHead), instanceId: randomUUID(), ownerEpoch: oldHead.ownerEpoch + 1,
          keyEpoch: keys.keyEpoch, directory: target, storageDomain: request.storageDomain, ...(targetSchema ? { schemaVersion: targetSchema } : {}) };
        createDirectory(target); writeNew(join(target, markerName(identity)), marker(identity));
        const frozen = stageBytes(identity, 1, request.operationId, migrated ?? decoded.image, decoded.state.safety, decoded.state.revocationHighWater,
          keys, null, oldHead);
        const stagePath = writeStage(target, request.operationId, frozen.bytes,frozen); request.fault?.('stage-written');
        const pending: PendingCommit = { version: 2, kind, operationId: request.operationId, requestDigest, oldHead,
          newHead: frozen.stage.head, stagePath, stageDigest: sha(frozen.bytes) };
        tx.prepare(pending); request.fault?.('prepared'); publish(frozen.stage, request.fault);
        const receipt = tx.finalize(pending); request.fault?.('finalized'); return receipt;
      });
    } finally { migrated?.fill(0); decoded.image.fill(0); keys.storageDEK.fill(0); keys.ingressKey.fill(0); }
  }
  /** Explicit completion of the exact frozen operation. No business/provider
   * callback is replayed, and a missing/conflicting stage leaves PREPARED intact. */
  static reconcile(request: { authority: LocalSqliteAuthority; vaultId: string; operationId: string; keys: KeySet; maxCalls: number }): AnchorReceipt {
    return request.authority.transaction(tx => {
      const prior = tx.receipt(request.vaultId, request.operationId); if (prior) return prior;
      const row = tx.row(request.vaultId), pending = row?.pending;
      if (row?.status !== 'PREPARED' || !pending || pending.operationId !== request.operationId) fail('ANCHOR_UNRESOLVED');
      try {
        const bytes = pending.newHead.format===INCREMENTAL_FORMAT?readBounded(pending.stagePath,MANIFEST_LIMIT):readBounded(pending.stagePath);
        if (sha(bytes) !== pending.stageDigest || pending.stagePath !== join(pending.newHead.directory, `stage-${pending.operationId}.json`)) fail('ANCHOR_UNRESOLVED');
        const decoded = pending.newHead.format===INCREMENTAL_FORMAT
          ?reconstruct(pending.newHead,directoryReader(pending.newHead.directory),request.keys,request.maxCalls,parseFrozenV3(bytes))
          :decodeStage(bytes, request.keys, request.maxCalls);
        try {
          if (!same(decoded.stage.head, pending.newHead) || decoded.record.operationId !== pending.operationId
            || !same(readMarker(pending.newHead.directory), identityOf(pending.newHead))) fail('ANCHOR_UNRESOLVED');
          if (['restore','rekey','schema-migration','fanout-maintenance','compaction','storage-upgrade'].includes(pending.kind) && !same(decoded.record.parentHead, pending.oldHead)) fail('ANCHOR_UNRESOLVED');
          if(pending.kind==='write'&&decoded.record.version===3&&!same(decoded.record.previousHead,pending.oldHead))fail('ANCHOR_UNRESOLVED');
          if (!same(decoded.record.maintenance, pending.maintenance)) fail('ANCHOR_UNRESOLVED');
          if(!same(decoded.record.legacyImport,pending.legacyImport))fail('ANCHOR_UNRESOLVED');
          validateImage(decoded.image, decoded.state.revocationHighWater, pending.newHead.schemaVersion ?? 1); publish(decoded.stage); return tx.finalize(pending);
        } finally { decoded.image.fill(0); }
      } catch { fail('ANCHOR_UNRESOLVED'); }
    });
  }
}
