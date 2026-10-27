import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANCHORED_FORMAT, INCREMENTAL_FORMAT, boundSqlite, canonicalDirectory, disjoint, id, identityOf, readBounded, same, validateHead, writeNew } from './anchored-codec.ts';
import type { VaultHead } from './anchored-codec.ts';
import { FORMAT, record, sha, validateHeadPin } from './durable-codec.ts';
import { fail, text } from './validation.ts';
import type {LegacyAdmissionReceipt,LegacyImportProof} from './legacy-import-types.ts';

export type PendingCommit = { version: 2; kind: 'create' | 'write' | 'restore' | 'rekey' | 'schema-migration' | 'fanout-maintenance' | 'compaction' | 'storage-upgrade' | 'legacy-m2-import'; operationId: string;
  requestDigest: string; oldHead: VaultHead | null; newHead: VaultHead; stagePath: string; stageDigest: string;
  maintenance?: { floor: number; resetConsumerIds: string[] };legacyImport?:LegacyImportProof };
export type AnchorReceipt = { version: 2; operationId: string; kind: PendingCommit['kind']; requestDigest: string;
  oldHead: VaultHead | null; newHead: VaultHead; maintenance?: { floor: number; resetConsumerIds: string[] };legacyImport?:LegacyImportProof };
export type LegacyRegistration={version:1;lineageId:string;migrationId:string;vaultId:string;requestDigest:string;proof:LegacyImportProof;
  status:'PREPARED'|'ACTIVE';importReceipt:AnchorReceipt|null;admission:'required'|'admitted';admissionReceipt:LegacyAdmissionReceipt|null};
export type AnchorRow = { status: 'ACTIVE' | 'PREPARED'; head: VaultHead | null; pending: PendingCommit | null };
export interface AuthorityTransaction {
  row(vaultId: string): AnchorRow | null;
  assertActive(head: VaultHead): void;
  receipt(vaultId: string, operationId: string): AnchorReceipt | null;
  prepare(pending: PendingCommit): void;
  finalize(pending: PendingCommit): AnchorReceipt;
  legacy(lineageId:string):LegacyRegistration|null;
  assertAdmitted(head:VaultHead):void;
}
const SCHEMA = `CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), authority_id TEXT NOT NULL, custody_domain TEXT NOT NULL) STRICT;
CREATE TABLE vaults (vault_id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
CREATE TABLE receipts (vault_id TEXT NOT NULL, operation_id TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(vault_id,operation_id)) STRICT;`;
const LEGACY_SCHEMA='CREATE TABLE legacy_imports (lineage_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, vault_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL) STRICT';
export const AUTHORITY_READ_LIMIT=64 * 1024 * 1024;
export const AUTHORITY_WRITE_LIMIT=Math.floor(AUTHORITY_READ_LIMIT/3);
export type AuthorityConfig={directory:string;authorityId:string;custodyDomain:string;writeLimitBytes?:number};
function validateImportProof(proof:LegacyImportProof):void{
  if(!record(proof)||proof.version!==1||!/^[a-f0-9]{64}$/.test(proof.lineageId)||!/^[a-f0-9]{64}$/.test(proof.genesisAuthorityDigest)
    ||proof.migrationId!==`m2-import-${proof.lineageId}`||proof.latestProven!==false||proof.legacyCopiesFenced!==false||proof.quotaScope!=='this-authority-only'
    ||proof.sourceRetirement!=='not-established'||proof.admissionAtImport!=='required')fail('LEGACY_PROOF');
  const freeze=proof.sourceFreeze;if(!record(freeze)||freeze.version!==1||!/^[a-f0-9]{64}$/.test(freeze.packageDigest))fail('LEGACY_PROOF');
  validateHeadPin(freeze.declaredHead,freeze.declaredHead?.identity);
  if(proof.lineageId!==sha(JSON.stringify([FORMAT,freeze.declaredHead.identity,proof.genesisAuthorityDigest])))fail('LEGACY_PROOF');
  if(!record(freeze.trust)||!['trusted-lower-bound','declared-snapshot-only'].includes(freeze.trust.policy))fail('LEGACY_PROOF');
  if(freeze.trust.policy==='trusted-lower-bound')validateHeadPin(freeze.trust.minimumHead,freeze.declaredHead.identity);
}

/** Trusted reference backend. Its directory is independently provisioned and MUST
 * be excluded from vault/backup rollback. SQLite provides real cross-process
 * serialization, not protection against its administrator rolling this DB back. */
export class LocalSqliteAuthority {
  readonly directory: string;
  readonly authorityId: string;
  readonly custodyDomain: string;
  #db: DatabaseSync;
  #locked = false;
  #closed = false;
  #fileIdentity: string;
  #capability: symbol | undefined;
  #version:number;
  #schemaEpoch:number;
  #writeLimit:number;
  #mutation:'none'|'new'|'completion'='none';
  #mutationFailed=false;
  #startPages=0;
  #startBytes=0;
  #pageSize=4096;
  private constructor(directory: string, authorityId: string, custodyDomain: string, create: boolean,writeLimitBytes=AUTHORITY_WRITE_LIMIT) {
    id(authorityId); id(custodyDomain);
    if(!Number.isSafeInteger(writeLimitBytes)||writeLimitBytes<65536||writeLimitBytes>AUTHORITY_WRITE_LIMIT)fail('ANCHOR_CAPACITY_CONFIG');
    this.#writeLimit=writeLimitBytes;
    this.directory = canonicalDirectory(directory); this.authorityId = authorityId; this.custodyDomain = custodyDomain;
    const path = join(this.directory, 'authority.sqlite');
    if (!create && !existsSync(path)) fail('ANCHOR_MISSING');
    if (create) writeNew(path, Buffer.alloc(0)); else readBounded(path, AUTHORITY_READ_LIMIT);
    boundSqlite(this.directory, 'authority.sqlite', AUTHORITY_READ_LIMIT);
    this.#db = new DatabaseSync(path, { timeout: 0, allowExtension: false, enableDoubleQuotedStringLiterals: false });
    const st = statSync(path); this.#fileIdentity = `${st.dev}:${st.ino}`;
    try {
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF;');
      this.#checkPragmas();
      if (create) {
        this.#db.exec('BEGIN IMMEDIATE');this.#locked=true;this.#captureSize();this.#mutation='new';
        try{this.#db.exec(SCHEMA);
          this.#db.prepare('INSERT INTO metadata VALUES (1,?,?)').run(authorityId, custodyDomain);
          this.#db.exec('PRAGMA user_version=2');this.#commit();
        }catch(error){this.#db.exec('ROLLBACK');this.#locked=false;throw error;}
      }
      const metadata = this.#db.prepare('SELECT * FROM metadata WHERE id=1').get();
      const layout = this.#db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().map(row => row.sql).sort();
      this.#version=this.#db.prepare('PRAGMA user_version').get()!.user_version as number;
      this.#schemaEpoch=this.#db.prepare('PRAGMA schema_version').get()!.schema_version as number;
      const expected=SCHEMA.split(';').map(sql=>sql.trim()).filter(Boolean);if(this.#version===3)expected.push(LEGACY_SCHEMA);
      if (![2,3].includes(this.#version) || metadata?.authority_id !== authorityId
        || metadata?.custody_domain !== custodyDomain || !same(layout, expected.sort())
        || this.#db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') fail('ANCHOR_IDENTITY');
      this.#db.enableDefensive(true);
    } catch (error) { this.#db.close(); throw error; }
  }
  static create(config: AuthorityConfig): LocalSqliteAuthority {
    // New exclusive namespace: an interrupted provisioning is never initialized again.
    const directory = resolve(config.directory);
    canonicalDirectory(dirname(directory));
    if (existsSync(directory)) fail('ANCHOR_ALREADY_EXISTS');
    mkdirSync(directory); return new LocalSqliteAuthority(directory, config.authorityId, config.custodyDomain, true,config.writeLimitBytes);
  }
  static open(config: AuthorityConfig): LocalSqliteAuthority {
    if (!existsSync(config.directory)) fail('ANCHOR_MISSING');
    return new LocalSqliteAuthority(config.directory, config.authorityId, config.custodyDomain, false,config.writeLimitBytes);
  }
  /** Maintenance-only explicit schema migration. Existing handles must reopen;
   * old binaries without epoch checks must already have been stopped. */
  static upgradeSchema(config:AuthorityConfig,maintenance:'operator-attested-stopped',fault?:(point:'after-table'|'after-version')=>void):{from:number;to:3;alreadyCurrent:boolean}{
    if(maintenance!=='operator-attested-stopped')fail('ANCHOR_MAINTENANCE_REQUIRED');const authority=LocalSqliteAuthority.open(config);
    try{
      const db=authority.#db;db.exec('BEGIN EXCLUSIVE');authority.#locked=true;
      try{
        authority.#checkFiles();authority.#checkSchema();authority.#captureSize();authority.#validateLayout(authority.#version);
        if(authority.#version===3){authority.#commit();return{from:3,to:3,alreadyCurrent:true};}
        authority.#newMutation();
        const before=['metadata','vaults','receipts'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
        db.exec(LEGACY_SCHEMA);fault?.('after-table');db.exec('PRAGMA user_version=3');fault?.('after-version');
        if(!same(before,['metadata','vaults','receipts'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())))fail('ANCHOR_SCHEMA_MIGRATION');
        authority.#validateLayout(3);
        authority.#commit();return{from:2,to:3,alreadyCurrent:false};
      }catch(error){try{db.exec('ROLLBACK');}catch{}authority.#locked=false;throw error;}
    }finally{authority.close();}
  }
  #validateLayout(version:number):void{
    const expected=SCHEMA.split(';').map(sql=>sql.trim()).filter(Boolean);if(version===3)expected.push(LEGACY_SCHEMA);
    const metadata=this.#db.prepare('SELECT * FROM metadata WHERE id=1').get();
    if(![2,3].includes(version)||this.#db.prepare('PRAGMA user_version').get()!.user_version!==version||metadata?.authority_id!==this.authorityId||metadata?.custody_domain!==this.custodyDomain
      ||!same(this.#db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().map(r=>r.sql).sort(),expected.sort())
      ||this.#db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')fail('ANCHOR_SCHEMA_MIGRATION');
  }
  #checkSchema():void{
    if(this.#db.prepare('PRAGMA user_version').get()!.user_version!==this.#version||this.#db.prepare('PRAGMA schema_version').get()!.schema_version!==this.#schemaEpoch)fail('ANCHOR_SCHEMA_CHANGED');
  }
  #checkPragmas():void{
    if(this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode!=='delete'
      ||this.#db.prepare('PRAGMA synchronous').get()!.synchronous!==3
      ||this.#db.prepare('PRAGMA cache_spill').get()!.cache_spill!==0
      ||this.#db.prepare('PRAGMA temp_store').get()!.temp_store!==2)fail('ANCHOR_DURABILITY');
  }
  #checkFiles():void{
    boundSqlite(this.directory,'authority.sqlite',AUTHORITY_READ_LIMIT);
    const path=join(this.directory,'authority.sqlite');if(!existsSync(path))fail('ANCHOR_MISSING');
    const st=statSync(path);if(`${st.dev}:${st.ino}`!==this.#fileIdentity)fail('ANCHOR_REPLACED');
  }
  #pages():number{return this.#db.prepare('PRAGMA page_count').get()!.page_count as number;}
  #captureSize():void{
    this.#checkPragmas();this.#pageSize=this.#db.prepare('PRAGMA page_size').get()!.page_size as number;
    if(!Number.isSafeInteger(this.#pageSize)||this.#pageSize<512||this.#pageSize>65536||(this.#pageSize&(this.#pageSize-1)))fail('ANCHOR_DURABILITY');
    this.#startPages=this.#pages();this.#startBytes=Math.max(this.#startPages*this.#pageSize,statSync(join(this.directory,'authority.sqlite')).size);this.#mutation='none';this.#mutationFailed=false;
  }
  #newMutation():void{
    this.#checkLock();
    // One cooperating pending globally: no other growth write may consume its
    // exact completion preview's space or change its allocation layout.
    if(this.#db.prepare("SELECT 1 FROM vaults WHERE json_extract(state,'$.status')='PREPARED' LIMIT 1").get())fail('ANCHOR_CAPACITY_PENDING');
    if(Math.max(this.#startBytes,this.#pages()*this.#pageSize)>this.#writeLimit)fail('ANCHOR_CAPACITY');
    this.#mutation='new';
  }
  #checkCapacity(admission=this.#mutation==='new',startPages=this.#startPages,startBytes=this.#startBytes):void{
    this.#checkPragmas();this.#checkFiles();
    // Commit-time auto-vacuum could change the layout after the exact preview.
    // Existing databases remain readable; new admission needs stable allocation.
    if(admission&&this.#db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum!==0)fail('ANCHOR_DURABILITY');
    const bytes=this.#pages()*this.#pageSize;
    // No spill/attached DB: every original page at most once in the rollback
    // journal, 8 bytes per record, plus two maximum sector/header allowances.
    const combined=Math.max(startBytes,bytes)+startPages*(this.#pageSize+8)+131072;
    if(combined>AUTHORITY_READ_LIMIT || (admission&&bytes>this.#writeLimit))fail('ANCHOR_CAPACITY');
  }
  #begin(): void {
    try { this.#db.exec('BEGIN IMMEDIATE'); this.#locked = true; } catch { fail('ANCHOR_BUSY'); }
    try{this.#checkFiles();this.#checkSchema();this.#captureSize();}catch(error){this.#db.exec('ROLLBACK');this.#locked=false;throw error;}
  }
  #commit(): void { if(this.#mutationFailed)fail('ANCHOR_TRANSACTION_FAILED');if(this.#mutation!=='none')this.#checkCapacity();this.#db.exec('COMMIT');this.#locked=false;this.#mutation='none'; }
  #writeAction<T>(action:()=>T):T{
    if(this.#mutationFailed)fail('ANCHOR_TRANSACTION_FAILED');
    try{return action();}catch(error){this.#mutationFailed=true;throw error;}
  }
  #checkLock(): void { if (!this.#locked || this.#closed) fail('ANCHOR_TRANSACTION'); }
  #row(vaultId: string): AnchorRow | null {
    this.#checkLock(); const row = this.#db.prepare('SELECT state FROM vaults WHERE vault_id=?').get(vaultId);
    if (!row) return null;
    let parsed: AnchorRow; try { parsed = JSON.parse(row.state as string); } catch { fail('ANCHOR_CORRUPT'); }
    if (!['ACTIVE','PREPARED'].includes(parsed.status)) fail('ANCHOR_CORRUPT');
    if (parsed.head) { validateHead(parsed.head); if (parsed.head.authorityId !== this.authorityId || parsed.head.vaultId !== vaultId) fail('ANCHOR_CORRUPT'); }
    if (parsed.status === 'ACTIVE' && (!parsed.head || parsed.pending)) fail('ANCHOR_CORRUPT');
    if (parsed.status === 'PREPARED' && !parsed.pending) fail('ANCHOR_CORRUPT');
    return parsed;
  }
  #receipt(vaultId: string, operationId: string): AnchorReceipt | null {
    this.#checkLock(); const row = this.#db.prepare('SELECT receipt FROM receipts WHERE vault_id=? AND operation_id=?').get(vaultId, operationId);
    return row ? JSON.parse(row.receipt as string) as AnchorReceipt : null;
  }
  #assertActive(head: VaultHead): void {
    const row = this.#row(head.vaultId);
    if (!row) fail('ANCHOR_UNREGISTERED'); if (row.status !== 'ACTIVE') fail('ANCHOR_PENDING');
    if (!same(row.head, head)) fail('ANCHOR_FENCED');
    this.#checkLegacy(head);
  }
  #legacy(lineageId:string):LegacyRegistration|null{
    this.#checkLock();if(this.#version!==3)fail('LEGACY_AUTHORITY_UPGRADE_REQUIRED');
    const row=this.#db.prepare('SELECT * FROM legacy_imports WHERE lineage_id=?').get(lineageId);if(!row)return null;
    const value=JSON.parse(row.state as string) as LegacyRegistration;
    if(!record(value)||value.version!==1||value.lineageId!==row.lineage_id||value.migrationId!==row.migration_id||value.vaultId!==row.vault_id
      ||!['PREPARED','ACTIVE'].includes(value.status)||!['required','admitted'].includes(value.admission))fail('LEGACY_REGISTRY');
    validateImportProof(value.proof);
    if(value.proof.lineageId!==value.lineageId||value.proof.migrationId!==value.migrationId||!/^[a-f0-9]{64}$/.test(value.requestDigest))fail('LEGACY_REGISTRY');
    const matches=(head:VaultHead)=>{
      validateHead(head);
      return head.authorityId===this.authorityId&&head.vaultId===value.vaultId&&head.identity===value.proof.sourceFreeze.declaredHead.identity
        &&same(head.legacyImport,{lineageId:value.lineageId,migrationId:value.migrationId});
    };
    const vault=this.#row(value.vaultId);
    if(!vault)fail('LEGACY_REGISTRY');
    if(value.status==='PREPARED'){
      const pending=vault.pending;
      if(value.admission!=='required'||value.importReceipt!==null||value.admissionReceipt!==null||vault.status!=='PREPARED'||vault.head!==null
        ||!pending||pending.kind!=='legacy-m2-import'||pending.operationId!==value.migrationId||pending.requestDigest!==value.requestDigest
        ||pending.oldHead!==null||!same(pending.legacyImport,value.proof)||!matches(pending.newHead))fail('LEGACY_REGISTRY');
    }else{
      const receipt=value.importReceipt;
      if(!record(receipt)||receipt.version!==2||receipt.kind!=='legacy-m2-import'||receipt.operationId!==value.migrationId
        ||receipt.requestDigest!==value.requestDigest||receipt.oldHead!==null||!same(receipt.legacyImport,value.proof)||!matches(receipt.newHead)
        ||receipt.newHead.sequence!==1||receipt.newHead.ownerEpoch!==1||receipt.newHead.keyEpoch!==1
        ||!same(receipt,this.#receipt(value.vaultId,value.migrationId))||!vault.head||!matches(vault.head)
        ||(vault.pending&&(!matches(vault.pending.newHead)||vault.pending.kind==='legacy-m2-import')))fail('LEGACY_REGISTRY');
      if(value.admission==='required'){if(value.admissionReceipt!==null)fail('LEGACY_REGISTRY');}
      else{
        const admission=value.admissionReceipt;
        if(!record(admission)||admission.version!==1||admission.migrationId!==value.migrationId||admission.attestation!=='operator-attested-stopped'
          ||admission.latestProven!==false||admission.legacyCopiesFenced!==false||admission.quotaScope!=='this-authority-only'||!matches(admission.head))fail('LEGACY_REGISTRY');
        id(admission.operationId);text(admission.operatorId,128);
        if(admission.requestDigest!==sha(JSON.stringify({migrationId:admission.migrationId,head:admission.head,operationId:admission.operationId,
          operatorId:admission.operatorId,attestation:admission.attestation})))fail('LEGACY_REGISTRY');
      }
    }
    return value;
  }
  #checkLegacy(head:VaultHead):LegacyRegistration|null{
    if(!head.legacyImport){if(this.#version===3&&this.#db.prepare('SELECT 1 FROM legacy_imports WHERE vault_id=?').get(head.vaultId))fail('LEGACY_REGISTRY');return null;}
    const registered=this.#legacy(head.legacyImport.lineageId);
    if(!registered||registered.status!=='ACTIVE'||registered.vaultId!==head.vaultId||registered.migrationId!==head.legacyImport.migrationId
      ||registered.proof.sourceFreeze.declaredHead.identity!==head.identity)fail('LEGACY_REGISTRY');return registered;
  }
  #assertAdmitted(head:VaultHead):void{this.#assertActive(head);if(this.#checkLegacy(head)?.admission==='required')fail('LEGACY_ADMISSION_REQUIRED');}
  #prepare(pending: PendingCommit): void {
    this.#checkLock(); this.#validateTransition(pending);
    if (this.#receipt(pending.newHead.vaultId, pending.operationId)) fail('ANCHOR_OPERATION_CONSUMED');
    if (pending.oldHead) this.#assertActive(pending.oldHead);
    else if (this.#row(pending.newHead.vaultId)) fail('ANCHOR_ALREADY_REGISTERED');
    this.#newMutation();
    if(pending.kind==='legacy-m2-import'){
      const proof=pending.legacyImport!;if(this.#legacy(proof.lineageId)||this.#db.prepare('SELECT 1 FROM legacy_imports WHERE migration_id=? OR vault_id=?').get(proof.migrationId,pending.newHead.vaultId))fail('LEGACY_LINEAGE_CONSUMED');
      const registered:LegacyRegistration={version:1,lineageId:proof.lineageId,migrationId:proof.migrationId,vaultId:pending.newHead.vaultId,requestDigest:pending.requestDigest,proof,
        status:'PREPARED',importReceipt:null,admission:'required',admissionReceipt:null};
      this.#db.prepare('INSERT INTO legacy_imports VALUES (?,?,?,?)').run(proof.lineageId,proof.migrationId,pending.newHead.vaultId,JSON.stringify(registered));
    }
    this.#db.prepare('INSERT INTO vaults VALUES (?,?) ON CONFLICT(vault_id) DO UPDATE SET state=excluded.state').run(pending.newHead.vaultId,
      JSON.stringify({ status: 'PREPARED', head: pending.oldHead, pending }));
    this.#checkCapacity();
    const preparedPages=this.#pages();
    this.#db.exec('SAVEPOINT capacity_preview');
    try{this.#finalizeSQL(pending);this.#checkCapacity(true,preparedPages,Math.max(this.#startBytes,preparedPages*this.#pageSize));}
    finally{this.#db.exec('ROLLBACK TO capacity_preview; RELEASE capacity_preview');}
    if(this.#pages()!==preparedPages)fail('ANCHOR_CAPACITY_PREVIEW');
    // Durable intent survives process death before local publish. Releasing the
    // lock is safe only because every contender refuses the PREPARED state.
    this.#commit(); this.#begin();
    if (!same(this.#row(pending.newHead.vaultId)?.pending, pending)) fail('ANCHOR_PENDING_CONFLICT');
  }
  #validateTransition(pending: PendingCommit): void {
    if (!record(pending) || pending.version !== 2 || !['create','write','restore','rekey','schema-migration','fanout-maintenance','compaction','storage-upgrade','legacy-m2-import'].includes(pending.kind)
      || typeof pending.stagePath !== 'string' || !isAbsolute(pending.stagePath)
      || !/^[a-f0-9]{64}$/.test(pending.stageDigest) || !/^[a-f0-9]{64}$/.test(pending.requestDigest)) fail('ANCHOR_TRANSITION');
    id(pending.operationId); validateHead(pending.newHead);
    const next = pending.newHead, old = pending.oldHead;
    if(pending.kind==='legacy-m2-import'){
      if(this.#version!==3)fail('LEGACY_AUTHORITY_UPGRADE_REQUIRED');validateImportProof(pending.legacyImport!);
      const proof=pending.legacyImport!;if(pending.operationId!==proof.migrationId||next.format!==INCREMENTAL_FORMAT||next.keyEpoch!==1
        ||!same(next.legacyImport,{lineageId:proof.lineageId,migrationId:proof.migrationId})||next.identity!==proof.sourceFreeze.declaredHead.identity)fail('LEGACY_PROOF');
    }else if(pending.legacyImport!==undefined)fail('LEGACY_PROOF');
    if (pending.kind === 'fanout-maintenance') {
      const details = pending.maintenance;
      if (!details || !Number.isSafeInteger(details.floor) || details.floor < 0 || !Array.isArray(details.resetConsumerIds)
        || details.resetConsumerIds.length > 32 || new Set(details.resetConsumerIds).size !== details.resetConsumerIds.length
        || next.schemaVersion !== 2 || old?.schemaVersion !== 2) fail('ANCHOR_TRANSITION');
      for (const consumerId of details.resetConsumerIds) text(consumerId,128);
    } else if (pending.maintenance !== undefined) fail('ANCHOR_TRANSITION');
    if (next.authorityId !== this.authorityId || next.storageDomain === this.custodyDomain) fail('ANCHOR_IDENTITY');
    if (canonicalDirectory(next.directory) !== next.directory) fail('ANCHOR_TRANSITION');
    disjoint(this.directory, next.directory);
    if (pending.kind === 'create'||pending.kind==='legacy-m2-import') {
      if (old !== null || next.ownerEpoch !== 1 || next.sequence !== 1) fail('ANCHOR_TRANSITION');
      if(pending.kind==='create'&&next.legacyImport)fail('LEGACY_PROOF');
    } else {
      validateHead(old);
      if (old.authorityId !== next.authorityId || old.vaultId !== next.vaultId || old.identity !== next.identity) fail('ANCHOR_TRANSITION');
      if(!same(old.legacyImport,next.legacyImport))fail('LEGACY_IDENTITY');
      if(pending.kind==='storage-upgrade'){
        if(old.format!==ANCHORED_FORMAT||next.format!==INCREMENTAL_FORMAT)fail('ANCHOR_TRANSITION');
      }else if(old.format!==next.format||old.storageProfile!==next.storageProfile)fail('ANCHOR_TRANSITION');
      if(pending.kind==='compaction'&&next.format!==INCREMENTAL_FORMAT)fail('ANCHOR_TRANSITION');
      if (pending.kind === 'schema-migration') {
        if ((old.schemaVersion ?? 1) !== 1 || next.schemaVersion !== 2) fail('ANCHOR_TRANSITION');
      } else if ((old.schemaVersion ?? 1) !== (next.schemaVersion ?? 1)) fail('ANCHOR_TRANSITION');
      if (pending.kind === 'write') {
        if (!same(identityOf(old), identityOf(next)) || next.sequence !== old.sequence + 1) fail('ANCHOR_TRANSITION');
      } else {
        if (next.ownerEpoch !== old.ownerEpoch + 1 || next.sequence !== 1 || next.instanceId === old.instanceId
          || next.keyEpoch !== old.keyEpoch + (pending.kind === 'rekey' ? 1 : 0)) fail('ANCHOR_TRANSITION');
        disjoint(old.directory, next.directory);
      }
    }
    if (pending.stagePath !== join(next.directory, `stage-${pending.operationId}.json`)
      || sha(pending.newHead.format===INCREMENTAL_FORMAT?readBounded(pending.stagePath,65536):readBounded(pending.stagePath)) !== pending.stageDigest) fail('ANCHOR_TRANSITION');
  }
  #finalize(pending: PendingCommit): AnchorReceipt {
    this.#checkLock();this.#mutation='completion';
    // Old, unreserved pending may already lack even worst-case journal space.
    // Refuse before dirtying any page; never rely only on a post-SQL check.
    this.#checkCapacity(false);
    const receipt=this.#finalizeSQL(pending);
    this.#commit();this.#begin();
    this.#assertActive(pending.newHead);return receipt;
  }
  /** Same SQL for the uncommitted preview and real/recovered completion. */
  #finalizeSQL(pending:PendingCommit):AnchorReceipt {
    this.#checkLock(); const row = this.#row(pending.newHead.vaultId);
    if (!row || row.status !== 'PREPARED' || !same(row.pending, pending)) fail('ANCHOR_PENDING_CONFLICT');
    const receipt: AnchorReceipt = { version: 2, operationId: pending.operationId, kind: pending.kind, requestDigest: pending.requestDigest,
      oldHead: pending.oldHead, newHead: pending.newHead, ...(pending.maintenance ? { maintenance: pending.maintenance } : {}),...(pending.legacyImport?{legacyImport:pending.legacyImport}:{}) };
    if(pending.kind==='legacy-m2-import'){
      const registered=this.#legacy(pending.legacyImport!.lineageId);
      if(!registered||registered.status!=='PREPARED'||registered.vaultId!==pending.newHead.vaultId||registered.requestDigest!==pending.requestDigest||!same(registered.proof,pending.legacyImport))fail('LEGACY_REGISTRY');
      this.#db.prepare('UPDATE legacy_imports SET state=? WHERE lineage_id=?').run(JSON.stringify({...registered,status:'ACTIVE',importReceipt:receipt}),registered.lineageId);
    }
    this.#db.prepare('UPDATE vaults SET state=? WHERE vault_id=?').run(JSON.stringify({ status: 'ACTIVE', head: pending.newHead, pending: null }), pending.newHead.vaultId);
    this.#db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(pending.newHead.vaultId, pending.operationId, JSON.stringify(receipt));
    return receipt;
  }
  transaction<T>(operation: (transaction: AuthorityTransaction) => T): T {
    if (this.#closed || this.#locked) fail('ANCHOR_TRANSACTION');
    // Bound files and recovery sidecars before SQLite acquires its write lock.
    this.#checkFiles();
    this.#begin();
    const capability = Symbol('authority-transaction'); this.#capability = capability;
    const use = <R>(body: () => R): R => {
      if (this.#capability !== capability) fail('ANCHOR_TRANSACTION_EXPIRED'); this.#checkLock(); return body();
    };
    try {
      const metadata = this.#db.prepare('SELECT * FROM metadata WHERE id=1').get();
      if (metadata?.authority_id !== this.authorityId || metadata?.custody_domain !== this.custodyDomain) fail('ANCHOR_IDENTITY');
      const result = operation({ row: id => use(() => this.#row(id)), assertActive: head => use(() => this.#assertActive(head)),
        receipt: (vaultId, operationId) => use(() => this.#receipt(vaultId, operationId)), prepare: p => use(() => this.#writeAction(()=>this.#prepare(p))), finalize: p => use(() => this.#writeAction(()=>this.#finalize(p))),
        legacy:lineageId=>use(()=>this.#legacy(lineageId)),assertAdmitted:head=>use(()=>this.#assertAdmitted(head)) });
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as any).then === 'function') fail('ANCHOR_ASYNC_GUARD');
      this.#commit(); return result;
    } catch (error) {
      if (this.#locked) { try { this.#db.exec('ROLLBACK'); } finally { this.#locked = false; } }
      throw error;
    } finally { this.#capability = undefined; }
  }
  inspect(vaultId: string): AnchorRow | null { return this.transaction(tx => tx.row(vaultId)); }
  admitLegacyImport(request:{migrationId:string;head:VaultHead;operationId:string;operatorId:string;attestation:'operator-attested-stopped'}):LegacyAdmissionReceipt{
    id(request.operationId);id(request.migrationId);text(request.operatorId,128);if(request.attestation!=='operator-attested-stopped')fail('LEGACY_ATTESTATION_REQUIRED');
    return this.transaction(tx=>{
      tx.assertActive(request.head);const registered=this.#checkLegacy(request.head);if(!registered||registered.migrationId!==request.migrationId)fail('LEGACY_REGISTRY');
      const requestDigest=sha(JSON.stringify({migrationId:request.migrationId,head:request.head,operationId:request.operationId,operatorId:request.operatorId,attestation:request.attestation}));
      if(registered.admissionReceipt){if(registered.admissionReceipt.requestDigest!==requestDigest)fail('LEGACY_ADMISSION_CONFLICT');return registered.admissionReceipt;}
      if(registered.admission!=='required')fail('LEGACY_ADMISSION_CONFLICT');
      this.#newMutation();
      const receipt:LegacyAdmissionReceipt={version:1,migrationId:request.migrationId,head:request.head,operationId:request.operationId,
        operatorId:request.operatorId,attestation:request.attestation,requestDigest,latestProven:false,legacyCopiesFenced:false,quotaScope:'this-authority-only'};
      this.#db.prepare('UPDATE legacy_imports SET state=? WHERE lineage_id=?').run(JSON.stringify({...registered,admission:'admitted',admissionReceipt:receipt}),registered.lineageId);return receipt;
    });
  }
  close(): void { if (this.#locked) fail('ANCHOR_BUSY'); if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
