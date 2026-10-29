import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANCHORED_FORMAT, INCREMENTAL_FORMAT, STAGE_LIMIT, boundSqlite, canonicalDirectory, disjoint, id, identityOf, readBounded, same, validateHead, writeNew,canUpgradeStorage } from './anchored-codec.ts';
import type { VaultHead } from './anchored-codec.ts';
import { FORMAT, record, sha, validateHeadPin } from './durable-codec.ts';
import { fail, text } from './validation.ts';
import type {LegacyAdmissionReceipt,LegacyImportProof} from './legacy-import-types.ts';
import {freezeCapacity} from './capacity-types.ts';
import type {AuthorityCapacity,FrozenData} from './capacity-types.ts';
import {RECEIPT_SEGMENT_LIMITS,RECEIPT_POINTER_PREFIX,RECEIPT_POINTER_LIMIT,normalizeRollover,parseReceiptPointer,receiptPointer,segmentFrame,validateReceiptEntry,encodeReceiptSegment,decodeReceiptSegment} from './receipt-segments.ts';
import type {RolloverRequest,RolloverReceipt,ReceiptEntry} from './receipt-segments.ts';
import {COLD_LIMITS,COLD_FORMAT,COLD_KIND,ROUTE_SQL,OPERATION_SQL,ROW_COLUMNS,ROW_BLOBS,ColdDatabase,normalizeCold,validateDescriptor,validateRequest,validateReceipt,validateIntent,emptyCounts,json,parsed,utf8,safeSum,sqlRows,keyCompare,sameRow,copyRow,frameBytes,hashRows,metaOf,receiptOf,plainJsonBytes,withPlainJSON,samePlainJSON,ReceiptKeyReader,usingReceiptKeys} from './authority-cold-format.ts';
import type {Kind,RawRow,Release,Descriptor,Intent,ColdInput,ColdReceipt,Counts,Moved,ColdMeta,Workspace} from './authority-cold-format.ts';
import {ColdWorkspace,rootHeader,inspectFiles,loadCurrent,findStage,writeStage,exportClosure,readClosure,slotNames,readOwned,exclusive,safeDirectory,hashFileBounded} from './authority-cold-storage.ts';
import type {Stage} from './authority-cold-storage.ts';
import {SHARD_LIMITS,SHARD_ROOT_SQL,ShardDatabase,normalizeShard,manifest as validateShardManifest,reservation as validateReservation,anyRequest,anyReceipt,partition,planned,intentFor,nextManifest,receiptFor} from './authority-sharded-format.ts';
import type {ShardInput,ShardRequest,ShardReceipt,ShardManifest,ShardReservation,ShardMeta,AnyRequest,AnyReceipt} from './authority-sharded-format.ts';
import {inspectShardFiles,obligations,requiredFiles,loadShards,stageState,verifyFile,exportShardClosure,readShardClosure} from './authority-sharded-storage.ts';
import type {LoadedShards} from './authority-sharded-storage.ts';
import {SAFETY_V2_PROFILE,safetyOperation,safetyPhase} from './safety-v2-format.ts';
import {readSafetyV2File} from './safety-v2-file.ts';

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
  capacity():AuthorityCapacity;
}
const SCHEMA = `CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), authority_id TEXT NOT NULL, custody_domain TEXT NOT NULL) STRICT;
CREATE TABLE vaults (vault_id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
CREATE TABLE receipts (vault_id TEXT NOT NULL, operation_id TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(vault_id,operation_id)) STRICT;`;
const LEGACY_SCHEMA='CREATE TABLE legacy_imports (lineage_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, vault_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL) STRICT';
const RECEIPT_SCHEMA='CREATE TABLE receipt_segments (segment_id TEXT PRIMARY KEY, request TEXT NOT NULL, digest TEXT NOT NULL, decoded_bytes INTEGER NOT NULL, encoded_bytes INTEGER NOT NULL, entry_count INTEGER NOT NULL, json_bytes INTEGER NOT NULL, payload BLOB NOT NULL) STRICT';
export const AUTHORITY_READ_LIMIT=64 * 1024 * 1024;
export const AUTHORITY_WRITE_LIMIT=Math.floor(AUTHORITY_READ_LIMIT/3);
export type AuthorityConfig={directory:string;authorityId:string;custodyDomain:string;writeLimitBytes?:number};
type ColdSelection={rows:RawRow[];moved:Moved;digest:string;close:Release};
type ColdSubset=Omit<ColdSelection,'close'>;
type ShardBuild={outputs:ReturnType<ShardDatabase['serialize']>[];counts:Counts;close:Release};
type ClosureResult={status:'COLD_CLOSURE_ONLY';authority:'ORIGINAL_AUTHORITY_REQUIRED';descriptor:Descriptor|ShardManifest};
type ColdGroup={rows:RawRow[];receipts:number;segments:number;legacy:number;framedBytes:number;skipped:'receipts'|'segments'|'legacy'};
function validateImportProof(proof:LegacyImportProof,workspace?:Workspace):void{
  if(!record(proof)||proof.version!==1||!/^[a-f0-9]{64}$/.test(proof.lineageId)||!/^[a-f0-9]{64}$/.test(proof.genesisAuthorityDigest)
    ||proof.migrationId!==`m2-import-${proof.lineageId}`||proof.latestProven!==false||proof.legacyCopiesFenced!==false||proof.quotaScope!=='this-authority-only'
    ||proof.sourceRetirement!=='not-established'||proof.admissionAtImport!=='required')fail('LEGACY_PROOF');
  const freeze=proof.sourceFreeze;if(!record(freeze)||freeze.version!==1||!/^[a-f0-9]{64}$/.test(freeze.packageDigest))fail('LEGACY_PROOF');
  validateHeadPin(freeze.declaredHead,freeze.declaredHead?.identity);
  const lineage=[FORMAT,freeze.declaredHead.identity,proof.genesisAuthorityDigest];
  if(proof.lineageId!==(workspace?withPlainJSON(lineage,workspace,sha):sha(JSON.stringify(lineage))))fail('LEGACY_PROOF');
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
  #version=2;
  #schemaEpoch:number;
  #writeLimit:number;
  #mutation:'none'|'new'|'completion'='none';
  #mutationFailed=false;
  #startPages=0;
  #startBytes=0;
  #pageSize=4096;
  #workspace:ColdWorkspace|undefined;
  #cold:{db:ColdDatabase;intent:Intent;close:Release}|undefined;
  #route:Descriptor|null=null;
  #lastWorkspacePeak=0;
  #guardReleases:Release[]=[];
  #returnReleases:Release[]=[];
  #valueScopes:Release[][]=[];
  #repair=false;
  #shards:LoadedShards|undefined;
  #manifest:ShardManifest|null=null;
  #reservation:ShardReservation|null=null;
  private constructor(directory: string, authorityId: string, custodyDomain: string, create: boolean,writeLimitBytes=AUTHORITY_WRITE_LIMIT) {
    id(authorityId); id(custodyDomain);
    if(!Number.isSafeInteger(writeLimitBytes)||writeLimitBytes<65536||writeLimitBytes>AUTHORITY_WRITE_LIMIT)fail('ANCHOR_CAPACITY_CONFIG');
    this.#writeLimit=writeLimitBytes;
    this.directory = canonicalDirectory(directory); this.authorityId = authorityId; this.custodyDomain = custodyDomain;
    const path = join(this.directory, 'authority.sqlite');
    if (!create && !existsSync(path)) fail('ANCHOR_MISSING');
    if (create) writeNew(path, Buffer.alloc(0)); else {const header=rootHeader(path);if(header.version===5)inspectFiles(this.directory);else if(header.version===6)inspectShardFiles(this.directory);}
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
      const expected=SCHEMA.split(';').map(sql=>sql.trim()).filter(Boolean);if(this.#version>=3)expected.push(LEGACY_SCHEMA);if(this.#version>=4)expected.push(RECEIPT_SCHEMA);if(this.#version>=5)expected.push(ROUTE_SQL,OPERATION_SQL);if(this.#version===6)expected.push(SHARD_ROOT_SQL);
      if (![2,3,4,5,6].includes(this.#version) || metadata?.authority_id !== authorityId
        || metadata?.custody_domain !== custodyDomain || !same(layout, expected.sort())
        || this.#db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') fail('ANCHOR_IDENTITY');
      this.#db.enableDefensive(true);
      if(this.#version===6)this.#checkShardObligations();
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
        if(authority.#version>=4)fail('ANCHOR_SCHEMA_ALREADY_NEWER');
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
  /** Explicit maintenance; never implicitly enable schema3 legacy semantics. */
  static upgradeReceiptSchema(config:AuthorityConfig,maintenance:'operator-attested-stopped',fault?:(point:'after-table'|'after-version')=>void):{from:3|4;to:4;alreadyCurrent:boolean}{
    if(maintenance!=='operator-attested-stopped')fail('ANCHOR_MAINTENANCE_REQUIRED');
    const authority=LocalSqliteAuthority.open(config);
    try{
      const db=authority.#db;db.exec('BEGIN EXCLUSIVE');authority.#locked=true;
      try{
        authority.#checkFiles();authority.#checkSchema();authority.#captureSize();authority.#validateLayout(authority.#version);
        if(authority.#version>4)fail('ANCHOR_SCHEMA_ALREADY_NEWER');
        if(authority.#version===4){authority.#commit();return{from:4,to:4,alreadyCurrent:true};}
        if(authority.#version!==3)fail('ANCHOR_RECEIPT_UPGRADE_REQUIRED');
        authority.#newMutation();
        // DDL only: original table schemas and every row stay untouched.
        db.exec(RECEIPT_SCHEMA);fault?.('after-table');db.exec('PRAGMA user_version=4');fault?.('after-version');
        authority.#validateLayout(4);authority.#commit();return{from:3,to:4,alreadyCurrent:false};
      }catch(error){try{db.exec('ROLLBACK');}catch{}authority.#locked=false;throw error;}
    }finally{authority.close();}
  }
  #validateLayout(version:number):void{
    const expected=SCHEMA.split(';').map(sql=>sql.trim()).filter(Boolean);if(version>=3)expected.push(LEGACY_SCHEMA);if(version>=4)expected.push(RECEIPT_SCHEMA);if(version>=5)expected.push(ROUTE_SQL,OPERATION_SQL);if(version===6)expected.push(SHARD_ROOT_SQL);
    const metadata=this.#db.prepare('SELECT * FROM metadata WHERE id=1').get();
    if(![2,3,4,5,6].includes(version)||this.#db.prepare('PRAGMA user_version').get()!.user_version!==version||metadata?.authority_id!==this.authorityId||metadata?.custody_domain!==this.custodyDomain
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
    if(this.#version===5)inspectFiles(this.directory);else if(this.#version===6)inspectShardFiles(this.directory);
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
    if(this.#version===6&&this.#readShardState().reservation)fail('ANCHOR_SHARD_PENDING');
    // One cooperating pending globally: no other growth write may consume its
    // exact completion preview's space or change its allocation layout.
    if(this.#db.prepare("SELECT 1 FROM vaults WHERE json_extract(state,'$.status')='PREPARED' LIMIT 1").get())fail('ANCHOR_CAPACITY_PENDING');
    if(Math.max(this.#startBytes,this.#pages()*this.#pageSize)>this.#writeLimit)fail('ANCHOR_CAPACITY');
    if(this.#version===6)this.#checkCapacity(true);
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
    let retained=this.#version>=5?COLD_LIMITS.retained:0;
    if(this.#version===6){const state=this.#readShardState();retained=obligations(inspectShardFiles(this.directory),state.manifest,state.reservation).bytes;}
    const combined=Math.max(startBytes,bytes)+startPages*(this.#pageSize+8)+131072+retained+(this.#version>=5?COLD_LIMITS.workspace:0);
    if(combined>AUTHORITY_READ_LIMIT || (admission&&bytes>this.#writeLimit))fail('ANCHOR_CAPACITY');
  }
  #begin(): void {
    try { this.#db.exec('BEGIN IMMEDIATE'); this.#locked = true; } catch { fail('ANCHOR_BUSY'); }
    try{this.#checkFiles();this.#checkSchema();this.#captureSize();if(this.#version===6)this.#checkShardObligations();if(this.#version>=5&&!this.#repair){this.#loadCold();this.#validateClosure();}}catch(error){this.#dropCold();this.#db.exec('ROLLBACK');this.#locked=false;throw error;}
  }
  #commit(): void { if(this.#mutationFailed)fail('ANCHOR_TRANSACTION_FAILED');if(this.#mutation!=='none'){if(this.#version>=5)this.#validateClosure();this.#checkCapacity();}this.#db.exec('COMMIT');this.#locked=false;this.#mutation='none';this.#dropCold(); }
  #writeAction<T>(action:()=>T):T{
    if(this.#mutationFailed)fail('ANCHOR_TRANSACTION_FAILED');
    try{return action();}catch(error){this.#mutationFailed=true;throw error;}
  }
  #checkLock(): void { if (!this.#locked || this.#closed) fail('ANCHOR_TRANSACTION'); }
  #capacity():AuthorityCapacity{
    this.#checkLock();if(this.#mutationFailed)fail('ANCHOR_TRANSACTION_FAILED');
    if(this.#version>=5)return this.#capacityFive();
    this.#checkFiles();this.#checkPragmas();
    const pageCount=this.#pages(),pageSize=this.#pageSize,freelistPages=this.#db.prepare('PRAGMA freelist_count').get()!.freelist_count as number;
    const size=(suffix:string)=>{
      const path=join(this.directory,'authority.sqlite'+suffix);
      try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())fail('ANCHOR_FILE');return stat.size;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&suffix)return 0;throw error;}
    };
    const fileBytes=size(''),journalBytes=size('-journal'),walBytes=size('-wal'),shmBytes=size('-shm'),totalBytes=journalBytes+walBytes+shmBytes;
    const counts=this.#db.prepare("SELECT count(*) AS count,coalesce(sum(json_extract(state,'$.status')='ACTIVE'),0) AS active,coalesce(sum(json_extract(state,'$.status')='PREPARED'),0) AS pending FROM vaults").get()!;
    const receipt=this.#db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(receipt AS BLOB))),0) AS bytes FROM receipts').get()!;
    let originalBytes=receipt.bytes as number;
    let receiptStorage:AuthorityCapacity['receiptStorage'];
    if(this.#version===4){
      let pointerCount=0,pointerBytes=0,archivedBytes=0;
      const pointers=this.#db.prepare('SELECT substr(receipt,1,?) AS receipt,length(CAST(receipt AS BLOB)) AS bytes FROM receipts WHERE substr(receipt,1,?)=?')
        .iterate(RECEIPT_POINTER_LIMIT+1,RECEIPT_POINTER_PREFIX.length,RECEIPT_POINTER_PREFIX);
      for(const row of pointers){
        if((row.bytes as number)>RECEIPT_POINTER_LIMIT||Buffer.byteLength(row.receipt as string)!==row.bytes)fail('ANCHOR_RECEIPT_SEGMENT');
        const pointer=parseReceiptPointer(row.receipt as string);if(!pointer)fail('ANCHOR_RECEIPT_SEGMENT');
        pointerCount++;pointerBytes+=row.bytes as number;archivedBytes+=pointer.jsonBytes;
      }
      const segments=this.#db.prepare('SELECT count(*) AS count,coalesce(sum(length(payload)),0) AS encoded,coalesce(sum(decoded_bytes),0) AS decoded,coalesce(sum(json_bytes),0) AS json FROM receipt_segments').get()!;
      originalBytes=originalBytes-pointerBytes+archivedBytes;
      receiptStorage={hot:{count:(receipt.count as number)-pointerCount,jsonUtf8Bytes:(receipt.bytes as number)-pointerBytes},pointers:{count:pointerCount,storedUtf8Bytes:pointerBytes},
        segments:{count:segments.count as number,encodedBytes:segments.encoded as number,decodedBytes:segments.decoded as number,jsonUtf8Bytes:segments.json as number},limits:{...RECEIPT_SEGMENT_LIMITS}};
    }
    const blockers:('GLOBAL_PENDING'|'CURRENT_EXTENT_OVER_WRITE_LIMIT')[]=[];
    if(counts.pending as number)blockers.push('GLOBAL_PENDING');
    if(Math.max(fileBytes,pageCount*pageSize)>this.#writeLimit)blockers.push('CURRENT_EXTENT_OVER_WRITE_LIMIT');
    return freezeCapacity({version:1,schemaVersion:this.#version as 2|3|4,database:{fileBytes,pageSize,pageCount,pageBytes:pageCount*pageSize,freelistPages},
      sidecars:{journalBytes,walBytes,shmBytes,totalBytes},totalFileBytes:fileBytes+totalBytes,limits:{writeLimitBytes:this.#writeLimit,readLimitBytes:AUTHORITY_READ_LIMIT},
      vaults:{count:counts.count as number,active:counts.active as number,pending:counts.pending as number},receipts:{count:receipt.count as number,jsonUtf8Bytes:originalBytes},
      ...(receiptStorage?{receiptStorage}:{}),legacyRegistry:this.#version>=3?{applicable:true,count:this.#db.prepare('SELECT count(*) AS n FROM legacy_imports').get()!.n as number}:{applicable:false,count:null},blockers});
  }
  #row(vaultId: string,retain=false): AnchorRow | null {
    if(this.#version>=5)return this.#usingRaw('V',0,vaultId,row=>{const bytes=row.values[1] as Uint8Array;this.#keepParsed(row,retain);return this.#rowValue(vaultId,utf8(bytes));});
    this.#checkLock(); const row = this.#db.prepare('SELECT state FROM vaults WHERE vault_id=?').get(vaultId);
    if (!row) return null;
    return this.#rowValue(vaultId,row.state as string);
  }
  #rowValue(vaultId:string,state:string):AnchorRow{
    let parsed: AnchorRow; try { parsed = JSON.parse(state); } catch { fail('ANCHOR_CORRUPT'); }
    if (!['ACTIVE','PREPARED'].includes(parsed.status)) fail('ANCHOR_CORRUPT');
    if (parsed.head) { validateHead(parsed.head); if (parsed.head.authorityId !== this.authorityId || parsed.head.vaultId !== vaultId) fail('ANCHOR_CORRUPT'); }
    if (parsed.status === 'ACTIVE' && (!parsed.head || parsed.pending)) fail('ANCHOR_CORRUPT');
    if (parsed.status === 'PREPARED' && !parsed.pending) fail('ANCHOR_CORRUPT');
    return parsed;
  }
  #receipt(vaultId: string, operationId: string,retain=false): AnchorReceipt | null {
    if(this.#version>=5)return this.#usingRaw('R',0,vaultId,row=>{
      if(row.values[1]!==operationId)return undefined;const value=utf8(row.values[2] as Uint8Array),p=parseReceiptPointer(value);
      if(!p){this.#keepParsed(row,retain);return parsed(row.values[2] as Uint8Array) as AnchorReceipt;}
      const receipt=this.#usingRaw('S',0,p.segmentId,raw=>{const decoded=this.#decodeSegment(raw);try{const entry=decoded.entries[p.index];if(!entry||entry.vaultId!==vaultId||entry.operationId!==operationId||Buffer.byteLength(entry.json)!==p.jsonBytes)fail('ANCHOR_RECEIPT_SEGMENT');this.#holdValue(this.#workspace!.reserve(safeSum(p.jsonBytes*2,1024),'decoded receipt parsed representation'),retain);return JSON.parse(entry.json) as AnchorReceipt;}finally{decoded.close();}});if(!receipt)fail('ANCHOR_RECEIPT_SEGMENT');return receipt;
    },operationId);
    if(this.#version===4){
      this.#checkLock();const bounds=this.#db.prepare('SELECT substr(receipt,1,?) AS prefix,length(CAST(receipt AS BLOB)) AS bytes FROM receipts WHERE vault_id=? AND operation_id=?')
        .get(RECEIPT_POINTER_PREFIX.length,vaultId,operationId);
      if(bounds?.prefix===RECEIPT_POINTER_PREFIX&&(bounds.bytes as number)>RECEIPT_POINTER_LIMIT)fail('ANCHOR_RECEIPT_SEGMENT');
    }
    this.#checkLock(); const row = this.#db.prepare('SELECT receipt FROM receipts WHERE vault_id=? AND operation_id=?').get(vaultId, operationId);
    if(!row)return null;
    const text=row.receipt as string,pointer=this.#version===4?parseReceiptPointer(text):null;
    if(!pointer)return JSON.parse(text) as AnchorReceipt;
    const segment=this.#segment(pointer.segmentId),entry=segment.entries[pointer.index];
    if(!entry||entry.vaultId!==vaultId||entry.operationId!==operationId||Buffer.byteLength(entry.json)!==pointer.jsonBytes)fail('ANCHOR_RECEIPT_SEGMENT');
    return JSON.parse(entry.json) as AnchorReceipt;
  }
  #segment(segmentId:string):{entries:ReceiptEntry[];receipt:RolloverReceipt}{
    this.#checkLock();
    if(this.#version>=5){const result=this.#usingRaw('S',0,segmentId,row=>{const result=this.#decodeSegment(row);this.#guardReleases.push(result.close);return result;});if(!result)fail('ANCHOR_RECEIPT_SEGMENT');return result;}
    // Inspect length before requesting BLOB (or arbitrary stored request TEXT) from SQLite.
    const sizes=this.#db.prepare('SELECT length(payload) AS bytes,length(CAST(request AS BLOB)) AS requestBytes FROM receipt_segments WHERE segment_id=?').get(segmentId);
    if(!sizes||typeof sizes.bytes!=='number'||sizes.bytes<1||sizes.bytes>RECEIPT_SEGMENT_LIMITS.encodedBytes
      ||typeof sizes.requestBytes!=='number'||sizes.requestBytes<1||sizes.requestBytes>512)fail('ANCHOR_RECEIPT_SEGMENT');
    const row=this.#db.prepare('SELECT * FROM receipt_segments WHERE segment_id=?').get(segmentId)!;
    let request:ReturnType<typeof normalizeRollover>;
    try{request=normalizeRollover(JSON.parse(row.request as string));}catch{fail('ANCHOR_RECEIPT_SEGMENT');}
    if(JSON.stringify(request)!==row.request||request.operationId!==segmentId||row.encoded_bytes!==sizes.bytes||(row.decoded_bytes as number)>request.maxJsonBytes
      ||(row.entry_count as number)>request.maxReceipts||!(row.payload instanceof Uint8Array))fail('ANCHOR_RECEIPT_SEGMENT');
    const payload=row.payload as Uint8Array;
    try{
      const entries=decodeReceiptSegment(payload,segmentId,row.decoded_bytes as number,row.digest as string,row.entry_count as number,row.json_bytes as number);
      const receipt:RolloverReceipt={version:1,operationId:segmentId,requestDigest:sha(JSON.stringify(request)),receiptCount:entries.length,jsonUtf8Bytes:row.json_bytes as number,
        decodedBytes:row.decoded_bytes as number,encodedBytes:row.encoded_bytes as number,digest:row.digest as string,limits:{maxReceipts:request.maxReceipts,maxJsonBytes:request.maxJsonBytes}};
      return{entries,receipt};
    }finally{payload.fill(0);}
  }
  #verifySegmentPointers(segmentId:string,entries:ReceiptEntry[],expectedHot?:boolean,readers?:readonly ReceiptKeyReader[]):void{
    let wrongTier=false;
    for(const [index,entry] of entries.entries()){
      if(this.#version>=5){const check=(row:RawRow)=>{
        if(row.values[1]!==entry.operationId)return undefined;
        if(expectedHot!==undefined&&(row.epoch===0)!==expectedHot)wrongTier=true;
        return utf8(row.values[2] as Uint8Array)===receiptPointer(segmentId,index,Buffer.byteLength(entry.json));
      };const valid=readers?usingReceiptKeys(readers,entry.vaultId,entry.operationId,check):this.#usingRaw('R',0,entry.vaultId,check,entry.operationId);if(!valid)fail('ANCHOR_RECEIPT_SEGMENT');continue;}
      const row=this.#db.prepare('SELECT substr(receipt,1,?) AS receipt,length(CAST(receipt AS BLOB)) AS bytes FROM receipts WHERE vault_id=? AND operation_id=?').get(RECEIPT_POINTER_LIMIT+1,entry.vaultId,entry.operationId);
      const expected=receiptPointer(segmentId,index,Buffer.byteLength(entry.json));
      if(row?.receipt!==expected||row.bytes!==Buffer.byteLength(expected))fail('ANCHOR_RECEIPT_SEGMENT');
    }
    // Preserve pointer-validation priority while sharing its actual row read.
    // Different positive epochs are valid: the invariant is only hot vs cold.
    if(wrongTier)fail('ANCHOR_RECEIPT_SEGMENT');
  }
  rolloverReceipts(input:RolloverRequest):FrozenData<RolloverReceipt>{
    const request=normalizeRollover(input),requestJSON=JSON.stringify(request);
    return this.transaction(()=>this.#writeAction(()=>{
      if(this.#version!==4&&this.#version<5)fail('ANCHOR_RECEIPT_UPGRADE_REQUIRED');
      // A confirmed operation is a read even when pending or segment/full limits block new writes.
      if(this.#version>=5?this.#hasRaw('S',0,request.operationId):this.#db.prepare('SELECT 1 FROM receipt_segments WHERE segment_id=?').get(request.operationId)){
        const prior=this.#segment(request.operationId);
        if(prior.receipt.requestDigest!==sha(requestJSON))fail('ANCHOR_ROLLOVER_CONFLICT');
        this.#verifySegmentPointers(request.operationId,prior.entries);return freezeCapacity(prior.receipt);
      }
      // A missing segment with surviving pointers is corruption, not an unused operation ID.
      const pointerStart=RECEIPT_POINTER_PREFIX+JSON.stringify([request.operationId]).slice(0,-1)+',';
      if(this.#version>=5?this.#hasPointerPrefix(pointerStart):this.#db.prepare('SELECT 1 FROM receipts WHERE substr(receipt,1,?)=? LIMIT 1').get(pointerStart.length,pointerStart))fail('ANCHOR_RECEIPT_SEGMENT');
      this.#newMutation();this.#checkCapacity();
      if(this.#version>=5)this.#guardReleases.push(this.#workspace!.reserve(request.maxJsonBytes*5+65536,'IF8 rollover input, framing, encoder and verification temporaries'));
      if((this.#version>=5?this.#countKind('S'):(this.#db.prepare('SELECT count(*) AS n FROM receipt_segments').get()!.n as number))>=RECEIPT_SEGMENT_LIMITS.segments)fail('ANCHOR_ROLLOVER_SEGMENT_LIMIT');
      const entries:ReceiptEntry[]=[];
      // Keys and SQL byte lengths first: never allocate an oversized raw receipt from SQLite.
      const selected=this.#db.prepare('SELECT vault_id,operation_id,length(CAST(receipt AS BLOB)) AS bytes FROM receipts WHERE substr(receipt,1,?)<>? ORDER BY rowid LIMIT ?')
        .all(RECEIPT_POINTER_PREFIX.length,RECEIPT_POINTER_PREFIX,request.maxReceipts);
      for(const row of selected){
        if(typeof row.bytes!=='number'||row.bytes<1||row.bytes>request.maxJsonBytes)fail('ANCHOR_ROLLOVER_BOUND');
        const value=this.#db.prepare('SELECT CAST(receipt AS BLOB) AS bytes FROM receipts WHERE vault_id=? AND operation_id=?').get(row.vault_id!,row.operation_id!)!;
        const raw=value.bytes as Uint8Array;let json:string;
        try{if(raw.byteLength!==row.bytes)fail('ANCHOR_RECEIPT_SEGMENT');json=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}
        catch{fail('ANCHOR_RECEIPT_SEGMENT');}finally{raw.fill(0);}
        const entry:ReceiptEntry={vaultId:row.vault_id as string,operationId:row.operation_id as string,json};validateReceiptEntry(entry);
        const prospective=[...entries,entry];
        if(Buffer.byteLength(segmentFrame(request.operationId,prospective))>request.maxJsonBytes){if(!entries.length)fail('ANCHOR_ROLLOVER_BOUND');break;}
        entries.push(entry);
      }
      if(!entries.length)fail('ANCHOR_ROLLOVER_EMPTY');
      const packed=encodeReceiptSegment(request.operationId,entries,request.maxJsonBytes),startPages=this.#pages(),startFree=this.#freelist();
      const pointers=entries.map((entry,index)=>receiptPointer(request.operationId,index,Buffer.byteLength(entry.json)));
      const originalCount=this.#db.prepare('SELECT count(*) AS n FROM receipts').get()!.n;
      try{
        // Repack one fully materialized batch. No callbacks, lookups, unlock or commit
        // occur while keys are temporarily absent inside this private transaction.
        for(const entry of entries){
          const deleted=this.#db.prepare('DELETE FROM receipts WHERE vault_id=? AND operation_id=? AND receipt=?').run(entry.vaultId,entry.operationId,entry.json);
          if(deleted.changes!==1)fail('ANCHOR_RECEIPT_SEGMENT');
        }
        for(const [index,entry] of entries.entries()){
          const inserted=this.#db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(entry.vaultId,entry.operationId,pointers[index]!);
          if(inserted.changes!==1)fail('ANCHOR_RECEIPT_SEGMENT');
        }
        this.#db.prepare('INSERT INTO receipt_segments VALUES (?,?,?,?,?,?,?,?)')
          .run(request.operationId,requestJSON,packed.digest,packed.decodedBytes,packed.payload.length,entries.length,packed.jsonBytes,packed.payload);
        if(this.#pages()>startPages||this.#pages()-this.#freelist()>=startPages-startFree)fail('ANCHOR_ROLLOVER_NO_BENEFIT');
        this.#checkCapacity();
        const verified=this.#segment(request.operationId);this.#verifySegmentPointers(request.operationId,verified.entries);
        if(this.#db.prepare('SELECT count(*) AS n FROM receipts').get()!.n!==originalCount||!this.#same(verified.entries,entries))fail('ANCHOR_RECEIPT_SEGMENT');
        return freezeCapacity(verified.receipt);
      }finally{packed.payload.fill(0);}
    }));
  }
  #freelist():number{return this.#db.prepare('PRAGMA freelist_count').get()!.freelist_count as number;}
  #assertActive(head: VaultHead): void {
    if(this.#version>=5)plainJsonBytes(head);
    const row = this.#row(head.vaultId);
    if (!row) fail('ANCHOR_UNREGISTERED'); if (row.status !== 'ACTIVE') fail('ANCHOR_PENDING');
    if (!this.#same(row.head, head)) fail('ANCHOR_FENCED');
    this.#checkLegacy(head);
  }
  #legacy(lineageId:string,retain=false):LegacyRegistration|null{
    this.#checkLock();if(this.#version<3)fail('LEGACY_AUTHORITY_UPGRADE_REQUIRED');
    if(this.#version>=5)return this.#usingRaw('L',0,lineageId,row=>{this.#keepParsed(row,retain);return this.#legacyValue({lineage_id:row.values[0],migration_id:row.values[1],vault_id:row.values[2],state:utf8(row.values[3] as Uint8Array)});});
    const row=this.#db.prepare('SELECT * FROM legacy_imports WHERE lineage_id=?').get(lineageId);if(!row)return null;
    return this.#legacyValue(row);
  }
  #legacyValue(row:Record<string,unknown>):LegacyRegistration{
    const value=JSON.parse(row.state as string) as LegacyRegistration;
    if(!record(value)||value.version!==1||value.lineageId!==row.lineage_id||value.migrationId!==row.migration_id||value.vaultId!==row.vault_id
      ||!['PREPARED','ACTIVE'].includes(value.status)||!['required','admitted'].includes(value.admission))fail('LEGACY_REGISTRY');
    validateImportProof(value.proof,this.#version>=5?this.#workspace:undefined);
    if(value.proof.lineageId!==value.lineageId||value.proof.migrationId!==value.migrationId||!/^[a-f0-9]{64}$/.test(value.requestDigest))fail('LEGACY_REGISTRY');
    const matches=(head:VaultHead)=>{
      validateHead(head);
      return head.authorityId===this.authorityId&&head.vaultId===value.vaultId&&head.identity===value.proof.sourceFreeze.declaredHead.identity
        &&this.#same(head.legacyImport,{lineageId:value.lineageId,migrationId:value.migrationId});
    };
    const vault=this.#row(value.vaultId);
    if(!vault)fail('LEGACY_REGISTRY');
    if(value.status==='PREPARED'){
      const pending=vault.pending;
      if(value.admission!=='required'||value.importReceipt!==null||value.admissionReceipt!==null||vault.status!=='PREPARED'||vault.head!==null
        ||!pending||pending.kind!=='legacy-m2-import'||pending.operationId!==value.migrationId||pending.requestDigest!==value.requestDigest
        ||pending.oldHead!==null||!this.#same(pending.legacyImport,value.proof)||!matches(pending.newHead))fail('LEGACY_REGISTRY');
    }else{
      const receipt=value.importReceipt;
      if(!record(receipt)||receipt.version!==2||receipt.kind!=='legacy-m2-import'||receipt.operationId!==value.migrationId
        ||receipt.requestDigest!==value.requestDigest||receipt.oldHead!==null||!this.#same(receipt.legacyImport,value.proof)||!matches(receipt.newHead)
        ||receipt.newHead.sequence!==1||receipt.newHead.ownerEpoch!==1||receipt.newHead.keyEpoch!==1
        ||!this.#same(receipt,this.#receipt(value.vaultId,value.migrationId))||!vault.head||!matches(vault.head)
        ||(vault.pending&&(!matches(vault.pending.newHead)||vault.pending.kind==='legacy-m2-import')))fail('LEGACY_REGISTRY');
      if(value.admission==='required'){if(value.admissionReceipt!==null)fail('LEGACY_REGISTRY');}
      else{
        const admission=value.admissionReceipt;
        if(!record(admission)||admission.version!==1||admission.migrationId!==value.migrationId||admission.attestation!=='operator-attested-stopped'
          ||admission.latestProven!==false||admission.legacyCopiesFenced!==false||admission.quotaScope!=='this-authority-only'||!matches(admission.head))fail('LEGACY_REGISTRY');
        id(admission.operationId);text(admission.operatorId,128);
        if(admission.requestDigest!==this.#withJSON({migrationId:admission.migrationId,head:admission.head,operationId:admission.operationId,
          operatorId:admission.operatorId,attestation:admission.attestation},sha))fail('LEGACY_REGISTRY');
      }
    }
    return value;
  }
  #checkLegacy(head:VaultHead,retain=false):LegacyRegistration|null{
    if(!head.legacyImport){if(this.#version>=3&&(this.#version>=5?this.#hasRaw('L',2,head.vaultId):this.#db.prepare('SELECT 1 FROM legacy_imports WHERE vault_id=?').get(head.vaultId)))fail('LEGACY_REGISTRY');return null;}
    const registered=this.#legacy(head.legacyImport.lineageId,retain);
    if(!registered||registered.status!=='ACTIVE'||registered.vaultId!==head.vaultId||registered.migrationId!==head.legacyImport.migrationId
      ||registered.proof.sourceFreeze.declaredHead.identity!==head.identity)fail('LEGACY_REGISTRY');return registered;
  }
  #assertAdmitted(head:VaultHead):void{this.#assertActive(head);if(this.#checkLegacy(head)?.admission==='required')fail('LEGACY_ADMISSION_REQUIRED');}
  #prepare(pending: PendingCommit): void {
    if(this.#version>=5)plainJsonBytes(pending);
    this.#checkLock(); this.#validateTransition(pending);
    if (this.#receipt(pending.newHead.vaultId, pending.operationId)) fail('ANCHOR_OPERATION_CONSUMED');
    if (pending.oldHead) this.#assertActive(pending.oldHead);
    else if (this.#row(pending.newHead.vaultId)) fail('ANCHOR_ALREADY_REGISTERED');
    this.#newMutation();
    if(pending.kind==='legacy-m2-import'){
      const proof=pending.legacyImport!;if(this.#legacy(proof.lineageId)||(this.#version>=5?(this.#hasRaw('L',1,proof.migrationId)||this.#hasRaw('L',2,pending.newHead.vaultId)):this.#db.prepare('SELECT 1 FROM legacy_imports WHERE migration_id=? OR vault_id=?').get(proof.migrationId,pending.newHead.vaultId)))fail('LEGACY_LINEAGE_CONSUMED');
      const registered:LegacyRegistration={version:1,lineageId:proof.lineageId,migrationId:proof.migrationId,vaultId:pending.newHead.vaultId,requestDigest:pending.requestDigest,proof,
        status:'PREPARED',importReceipt:null,admission:'required',admissionReceipt:null};
      this.#withJSON(registered,encoded=>this.#db.prepare('INSERT INTO legacy_imports VALUES (?,?,?,?)').run(proof.lineageId,proof.migrationId,pending.newHead.vaultId,encoded));
    }
    this.#withJSON({status:'PREPARED',head:pending.oldHead,pending},encoded=>this.#db.prepare('INSERT INTO vaults VALUES (?,?) ON CONFLICT(vault_id) DO UPDATE SET state=excluded.state').run(pending.newHead.vaultId,encoded));
    this.#checkCapacity();
    const preparedPages=this.#pages();
    this.#db.exec('SAVEPOINT capacity_preview');
    try{this.#withValues(()=>this.#finalizeSQL(pending));this.#checkCapacity(true,preparedPages,Math.max(this.#startBytes,preparedPages*this.#pageSize));}
    finally{this.#db.exec('ROLLBACK TO capacity_preview; RELEASE capacity_preview');}
    if(this.#pages()!==preparedPages)fail('ANCHOR_CAPACITY_PREVIEW');
    // Durable intent survives process death before local publish. Releasing the
    // lock is safe only because every contender refuses the PREPARED state.
    this.#commit(); this.#begin();
    if (!this.#same(this.#row(pending.newHead.vaultId)?.pending, pending)) fail('ANCHOR_PENDING_CONFLICT');
  }
  #validateTransition(pending: PendingCommit): void {
    if (!record(pending) || pending.version !== 2 || !['create','write','restore','rekey','schema-migration','fanout-maintenance','compaction','storage-upgrade','legacy-m2-import'].includes(pending.kind)
      || typeof pending.stagePath !== 'string' || !isAbsolute(pending.stagePath)
      || !/^[a-f0-9]{64}$/.test(pending.stageDigest) || !/^[a-f0-9]{64}$/.test(pending.requestDigest)) fail('ANCHOR_TRANSITION');
    id(pending.operationId); validateHead(pending.newHead);
    const next = pending.newHead, old = pending.oldHead;
    if(pending.kind==='legacy-m2-import'){
      if(this.#version<3)fail('LEGACY_AUTHORITY_UPGRADE_REQUIRED');validateImportProof(pending.legacyImport!,this.#version>=5?this.#workspace:undefined);
      const proof=pending.legacyImport!;if(pending.operationId!==proof.migrationId||next.format!==INCREMENTAL_FORMAT||next.keyEpoch!==1
        ||!this.#same(next.legacyImport,{lineageId:proof.lineageId,migrationId:proof.migrationId})||next.identity!==proof.sourceFreeze.declaredHead.identity)fail('LEGACY_PROOF');
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
      if(!this.#same(old.legacyImport,next.legacyImport))fail('LEGACY_IDENTITY');
      if(pending.kind==='storage-upgrade'){
        if(next.format!==INCREMENTAL_FORMAT||!next.storageProfile||!canUpgradeStorage(old,next.storageProfile))fail('ANCHOR_TRANSITION');
      }else if(old.format!==next.format||old.storageProfile!==next.storageProfile)fail('ANCHOR_TRANSITION');
      if(pending.kind==='compaction'&&next.format!==INCREMENTAL_FORMAT)fail('ANCHOR_TRANSITION');
      if (pending.kind === 'schema-migration') {
        if ((old.schemaVersion ?? 1) !== 1 || next.schemaVersion !== 2) fail('ANCHOR_TRANSITION');
      } else if ((old.schemaVersion ?? 1) !== (next.schemaVersion ?? 1)) fail('ANCHOR_TRANSITION');
      if (pending.kind === 'write') {
        if (!this.#same(identityOf(old), identityOf(next)) || next.sequence !== old.sequence + 1) fail('ANCHOR_TRANSITION');
      } else {
        if (next.ownerEpoch !== old.ownerEpoch + 1 || next.sequence !== 1 || next.instanceId === old.instanceId
          || next.keyEpoch !== old.keyEpoch + (pending.kind === 'rekey' ? 1 : 0)) fail('ANCHOR_TRANSITION');
        disjoint(old.directory, next.directory);
      }
    }
    if (pending.stagePath !== join(next.directory, `stage-${pending.operationId}.json`)
      || (this.#version>=5?hashFileBounded(pending.stagePath,pending.newHead.format===INCREMENTAL_FORMAT?65536:STAGE_LIMIT,this.#workspace!):next.storageProfile===SAFETY_V2_PROFILE
        ?safetyOperation(()=>safetyPhase(65537,'v2 PREPARED stage hash read',()=>sha(readSafetyV2File(pending.stagePath,65536))))
        :sha(pending.newHead.format===INCREMENTAL_FORMAT?readBounded(pending.stagePath,65536):readBounded(pending.stagePath))) !== pending.stageDigest) fail('ANCHOR_TRANSITION');
  }
  #finalize(pending: PendingCommit): AnchorReceipt {
    if(this.#version>=5)plainJsonBytes(pending);
    this.#checkLock();this.#mutation='completion';
    // Old, unreserved pending may already lack even worst-case journal space.
    // Refuse before dirtying any page; never rely only on a post-SQL check.
    this.#checkCapacity(false);
    const receipt=this.#finalizeSQL(pending,true);
    this.#commit();this.#begin();
    this.#assertActive(pending.newHead);return receipt;
  }
  /** Same SQL for the uncommitted preview and real/recovered completion. */
  #finalizeSQL(pending:PendingCommit,retain=false):AnchorReceipt {
    this.#checkLock(); const row = this.#row(pending.newHead.vaultId);
    if (!row || row.status !== 'PREPARED' || !this.#same(row.pending, pending)) fail('ANCHOR_PENDING_CONFLICT');
    if(this.#version>=5&&this.#receipt(pending.newHead.vaultId,pending.operationId))fail('ANCHOR_OPERATION_CONSUMED');
    const receipt: AnchorReceipt = { version: 2, operationId: pending.operationId, kind: pending.kind, requestDigest: pending.requestDigest,
      oldHead: pending.oldHead, newHead: pending.newHead, ...(pending.maintenance ? { maintenance: pending.maintenance } : {}),...(pending.legacyImport?{legacyImport:pending.legacyImport}:{}) };
    if(this.#version>=5)this.#holdValue(this.#workspace!.reserve(safeSum(plainJsonBytes(receipt)*2,1024),'finalize receipt representation'),retain);
    if(pending.kind==='legacy-m2-import'){
      const registered=this.#legacy(pending.legacyImport!.lineageId);
      if(!registered||registered.status!=='PREPARED'||registered.vaultId!==pending.newHead.vaultId||registered.requestDigest!==pending.requestDigest||!this.#same(registered.proof,pending.legacyImport))fail('LEGACY_REGISTRY');
      this.#withJSON({...registered,status:'ACTIVE',importReceipt:receipt},encoded=>this.#db.prepare('UPDATE legacy_imports SET state=? WHERE lineage_id=?').run(encoded,registered.lineageId));
    }
    this.#withJSON({status:'ACTIVE',head:pending.newHead,pending:null},encoded=>this.#db.prepare('UPDATE vaults SET state=? WHERE vault_id=?').run(encoded,pending.newHead.vaultId));
    this.#withJSON(receipt,encoded=>this.#db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(pending.newHead.vaultId,pending.operationId,encoded));
    return receipt;
  }
  transaction<T>(operation: (transaction: AuthorityTransaction) => T): T {
    if (this.#closed || this.#locked) fail('ANCHOR_TRANSACTION');
    // Bound files and recovery sidecars before SQLite acquires its write lock.
    this.#checkFiles();
    const ownsWorkspace=this.#workspace===undefined;if(ownsWorkspace)this.#workspace=new ColdWorkspace();
    const fixed=this.#workspace!.reserve(131072,'guard metadata, head/stage checks and returned JSON');
    try{this.#begin();}catch(e){fixed();if(ownsWorkspace){this.#lastWorkspacePeak=this.#workspace!.peak;this.#workspace=undefined;}throw e;}
    const capability = Symbol('authority-transaction'); this.#capability = capability;
    const use = <R>(body: () => R): R => {
      if (this.#capability !== capability) fail('ANCHOR_TRANSACTION_EXPIRED'); this.#checkLock(); return this.#withValues(body);
    };
    try {
      const metadata = this.#db.prepare('SELECT * FROM metadata WHERE id=1').get();
      if (metadata?.authority_id !== this.authorityId || metadata?.custody_domain !== this.custodyDomain) fail('ANCHOR_IDENTITY');
      const result = this.#withValues(()=>operation({ row: id => use(() => this.#row(id,true)), assertActive: head => use(() => this.#assertActive(head)),
        receipt: (vaultId, operationId) => use(() => this.#receipt(vaultId, operationId,true)), prepare: p => use(() => this.#writeAction(()=>this.#prepare(p))), finalize: p => use(() => this.#writeAction(()=>this.#finalize(p))),
        legacy:lineageId=>use(()=>this.#legacy(lineageId,true)),assertAdmitted:head=>use(()=>this.#assertAdmitted(head)),capacity:()=>use(()=>{const result=this.#capacity();if(this.#version>=5)this.#retainReturn(Buffer.byteLength(json(result,65536)));return result;}) }));
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as any).then === 'function') fail('ANCHOR_ASYNC_GUARD');
      this.#commit(); return result;
    } catch (error) {
      if (this.#locked) { try { this.#db.exec('ROLLBACK'); } finally { this.#locked = false; } }
      throw error;
    } finally { this.#capability = undefined;this.#dropCold();for(const release of this.#returnReleases)release();this.#returnReleases=[];fixed();if(ownsWorkspace){this.#lastWorkspacePeak=this.#workspace!.peak;this.#workspace=undefined;} }
  }
  #retainReturn(bytes:number):void{this.#returnReleases.push(this.#workspace!.reserve(safeSum(bytes*2,1024),'public transaction return UTF8/parsed representation'));}
  #holdValue(release:Release,retain=false):void{(retain?this.#returnReleases:this.#valueScopes.at(-1)??this.#guardReleases).push(release);}
  #keepParsed(row:RawRow,retain:boolean):void{this.#holdValue(row.keepParsed!(),retain);}
  #withValues<T>(body:()=>T):T{if(this.#version<5)return body();const releases:Release[]=[];this.#valueScopes.push(releases);try{return body();}finally{this.#valueScopes.pop();for(const release of releases)release();}}
  #withJSON<T>(value:unknown,body:(encoded:string)=>T):T{return this.#version>=5?withPlainJSON(value,this.#workspace!,body):body(JSON.stringify(value));}
  #same(a:unknown,b:unknown):boolean{return this.#version>=5?samePlainJSON(a,b,this.#workspace!):same(a,b);}
  #dropCold():void{this.#cold?.close();this.#cold=undefined;this.#shards?.close();this.#shards=undefined;this.#route=null;this.#manifest=null;this.#reservation=null;for(const release of this.#guardReleases)release();this.#guardReleases=[];}
  #readShardState():{manifest:ShardManifest;reservation:ShardReservation|null}{
    const bound=this.#db.prepare('SELECT count(*) AS n,max(length(CAST(manifest AS BLOB))) AS m,max(length(CAST(reservation AS BLOB))) AS r FROM authority_shard_root').get()!;
    if(bound.n!==1||typeof bound.m!=='number'||bound.m>8192||(bound.r!==null&&(typeof bound.r!=='number'||bound.r>8192)))fail('ANCHOR_SHARD_ROOT');
    const w=this.#workspace??new ColdWorkspace(),release=w.reserve(65536,'v2 root manifest and reservation');
    try{const row=this.#db.prepare('SELECT manifest,reservation FROM authority_shard_root WHERE id=1').get();if(!row)fail('ANCHOR_SHARD_ROOT');const m=JSON.parse(row.manifest as string) as ShardManifest;validateShardManifest(m);if(json(m,8192)!==row.manifest||m.authorityId!==this.authorityId||m.custodyDomain!==this.custodyDomain)fail('ANCHOR_SHARD_ROOT');
      const r=row.reservation===null?null:JSON.parse(row.reservation as string) as ShardReservation;if(r){validateReservation(r);if(json(r,8192)!==row.reservation||json(r.baseManifest,8192)!==json(m,8192))fail('ANCHOR_SHARD_RESERVATION');for(const index of [0,1] as const){const text=json(intentFor(r,index),8192),f=r.plans[index].intent;if(Buffer.byteLength(text)!==f.bytes||sha(text)!==f.sha256)fail('ANCHOR_SHARD_RESERVATION');}}
      return{manifest:m,reservation:r};
    }finally{release();}
  }
  #checkShardObligations():void{const state=this.#readShardState(),physical=inspectShardFiles(this.directory),budget=obligations(physical,state.manifest,state.reservation);if(safeSum(physical.rootBytes,physical.journalBytes,budget.bytes,COLD_LIMITS.workspace)>COLD_LIMITS.shared)fail('ANCHOR_CAPACITY');}
  #readRoute():Descriptor|null{
    const bounds=this.#db.prepare('SELECT count(*) AS n,max(length(CAST(descriptor AS BLOB))) AS bytes FROM authority_cold_route').get()!;
    if(bounds.n!==1||(bounds.bytes!==null&&(typeof bounds.bytes!=='number'||bounds.bytes>2048)))fail('ANCHOR_COLD_ROUTE');
    const row=this.#db.prepare('SELECT epoch,descriptor FROM authority_cold_route WHERE id=1').get();if(!row)fail('ANCHOR_COLD_ROUTE');
    if(row.epoch===0){if(row.descriptor!==null||this.#db.prepare('SELECT count(*) AS n FROM authority_cold_operation').get()!.n!==0)fail('ANCHOR_COLD_ROUTE');return null;}
    let d:Descriptor;try{d=JSON.parse(row.descriptor as string);}catch{fail('ANCHOR_COLD_ROUTE');}validateDescriptor(d);
    if(d.epoch!==row.epoch||json(d,2048)!==row.descriptor||this.#db.prepare('SELECT count(*) AS n FROM authority_cold_operation').get()!.n!==1)fail('ANCHOR_COLD_ROUTE');return d;
  }
  #loadCold():void{
    this.#dropCold();
    if(this.#version===6){const state=this.#readShardState();this.#manifest=state.manifest;this.#reservation=state.reservation;const c=state.manifest.current;if(c?.format==='two-shards-v2'){this.#shards=loadShards(this.directory,state.manifest,this.#workspace!);return;}this.#route=c?.descriptor??null;}
    else this.#route=this.#readRoute();
    if(this.#route){this.#cold=loadCurrent(this.directory,this.#route,this.#workspace!);if(this.#cold.intent.authorityId!==this.authorityId||this.#cold.intent.custodyDomain!==this.custodyDomain)fail('ANCHOR_COLD_IDENTITY');}
  }
  *#hotRows(kind:Kind,index?:number,value?:string,secondary?:string):Generator<RawRow>{
    const table={R:'receipts',S:'receipt_segments',L:'legacy_imports',M:'authority_cold_operation',V:'vaults'}[kind];
    if(kind==='M'&&this.#version<5)return;
    const columns={R:['vault_id','operation_id'],S:['segment_id'],L:['lineage_id','migration_id','vault_id'],M:['operation_id'],V:['vault_id']}[kind];
    yield*sqlRows(this.#db,kind,table,false,this.#workspace!,index===undefined?'':`WHERE ${columns[index]}=?${secondary===undefined?'':' AND operation_id=?'}`,index===undefined?[]:secondary===undefined?[value!]:[value!,secondary]);
  }
  *#rawRows(kind:Kind,index?:number,value?:string,secondary?:string):Generator<RawRow>{
    const iterators:Generator<RawRow>[]=[this.#hotRows(kind,index,value,secondary)];if(kind!=='V'){if(this.#cold)iterators.push(this.#cold.db.rows(kind,index,value,secondary));for(const db of this.#shards?.dbs??[])iterators.push(db.rows(kind,index,value,secondary));}
    try{const next=iterators.map(i=>i.next());for(;;){let smallest=-1;for(let i=0;i<next.length;i++){if(next[i]!.done)continue;if(smallest<0){smallest=i;continue;}const order=keyCompare(next[i]!.value!,next[smallest]!.value!);if(!order)fail('ANCHOR_COLD_DUPLICATE');if(order<0)smallest=i;}if(smallest<0)break;yield next[smallest]!.value!;next[smallest]=iterators[smallest]!.next();}}
    finally{for(const i of iterators)i.return(undefined);}
  }
  #usingRaw<T>(kind:Kind,index:number,value:string,read:(row:RawRow)=>T|undefined,secondary?:string):T|null{
    let found=false,result:T|null=null;for(const row of this.#rawRows(kind,index,value,secondary)){const next=read(row);if(next!==undefined){if(found)fail('ANCHOR_COLD_DUPLICATE');found=true;result=next;}}return result;
  }
  #hasRaw(kind:Kind,index:number,value:string):boolean{return this.#usingRaw(kind,index,value,()=>true)===true;}
  #hasPointerPrefix(prefix:string):boolean{for(const row of this.#rawRows('R'))if(utf8(row.values[2] as Uint8Array).startsWith(prefix))return true;return false;}
  #countKind(kind:Kind):number{let n=0;for(const _ of this.#rawRows(kind))n++;return n;}
  #decodeSegment(row:RawRow):{entries:ReceiptEntry[];receipt:RolloverReceipt;close:Release}{
    const [segmentId,requestBytes,digest,decoded,encoded,count,original,payload]=row.values;
    if(!(requestBytes instanceof Uint8Array)||requestBytes.byteLength<1||requestBytes.byteLength>512||!(payload instanceof Uint8Array)||payload.byteLength<1||payload.byteLength>1048576||encoded!==payload.byteLength)fail('ANCHOR_RECEIPT_SEGMENT');
    const request=normalizeRollover(parsed(requestBytes));if(JSON.stringify(request)!==utf8(requestBytes)||request.operationId!==segmentId||(decoded as number)>request.maxJsonBytes||(count as number)>request.maxReceipts)fail('ANCHOR_RECEIPT_SEGMENT');
    const release=this.#workspace!.reserve(safeSum((decoded as number)*3,1024),'IF8 output buffer, UTF8 JSON and entries');
    try{const entries=decodeReceiptSegment(payload,segmentId as string,decoded as number,digest as string,count as number,original as number);
      return{entries,receipt:{version:1,operationId:segmentId as string,requestDigest:sha(JSON.stringify(request)),receiptCount:entries.length,jsonUtf8Bytes:original as number,decodedBytes:decoded as number,encodedBytes:encoded as number,digest:digest as string,limits:{maxReceipts:request.maxReceipts,maxJsonBytes:request.maxJsonBytes}},close:release};
    }catch(e){release();throw e;}
  }
  #validateClosure():void{
    this.#checkLock();const metadata=this.#db.prepare('SELECT * FROM metadata WHERE id=1').get();if(metadata?.authority_id!==this.authorityId||metadata.custody_domain!==this.custodyDomain)fail('ANCHOR_IDENTITY');
    let pointers=0,expectedPointers=0,segments=0;
    for(const row of this.#rawRows('R')){
      id(row.values[0] as string);id(row.values[1] as string);const value=utf8(row.values[2] as Uint8Array),pointer=parseReceiptPointer(value);
      if(pointer){pointers++;continue;}validateReceiptEntry({vaultId:row.values[0] as string,operationId:row.values[1] as string,json:value});
      const receipt=JSON.parse(value) as AnchorReceipt;validateHead(receipt.newHead);if(receipt.newHead.authorityId!==this.authorityId)fail('ANCHOR_COLD_IDENTITY');
    }
    const readers:ReceiptKeyReader[]=[];
    try{for(const row of this.#rawRows('S')){if(++segments>128)fail('ANCHOR_ROLLOVER_SEGMENT_LIMIT');const decoded=this.#decodeSegment(row);try{
      if(!readers.length){readers.push(new ReceiptKeyReader(this.#db,false,this.#workspace!));if(this.#cold)readers.push(this.#cold.db.receiptReader());for(const db of this.#shards?.dbs??[])readers.push(db.receiptReader());}
      // A complete IF8 group is wholly hot or wholly cold.
      this.#verifySegmentPointers(row.values[0] as string,decoded.entries,row.epoch===0,readers);expectedPointers+=decoded.entries.length;
      }finally{decoded.close();}
    }}finally{let closeError:unknown,failed=false;for(const reader of readers){try{reader.close();}catch(e){if(!failed){closeError=e;failed=true;}}}if(failed)throw closeError;}
    if(pointers!==expectedPointers)fail('ANCHOR_RECEIPT_SEGMENT');
    for(const row of this.#rawRows('L'))this.#withValues(()=>{
      const legacy=this.#legacy(row.values[0] as string);if(!legacy)fail('LEGACY_REGISTRY');
      if(!this.#hasRaw('L',1,row.values[1] as string)||!this.#hasRaw('L',2,row.values[2] as string))fail('LEGACY_REGISTRY');
      if(row.epoch&&(legacy.status!=='ACTIVE'||legacy.admission!=='admitted'))fail('LEGACY_REGISTRY');
    });
    for(const raw of this.#rawRows('V'))this.#withValues(()=>{const row=this.#rowValue(raw.values[0] as string,utf8(raw.values[1] as Uint8Array));if(row.head)this.#checkLegacy(row.head);});
    const epochs=new Set<number>();let operations=0;for(const row of this.#rawRows('M')){
      const request=anyRequest(parsed(row.values[1] as Uint8Array)),receipt=parsed(row.values[2] as Uint8Array) as AnyReceipt;anyReceipt(receipt,request);if(this.#version===5&&request.version!==1)fail('ANCHOR_COLD_OPERATION');
      if(request.operationId!==row.values[0]||json(request,8192)!==utf8(row.values[1] as Uint8Array)||json(receipt,8192)!==utf8(row.values[2] as Uint8Array)||epochs.has(receipt.toEpoch))fail('ANCHOR_COLD_OPERATION');
      if(row.epoch?receipt.toEpoch!==row.epoch-1:receipt.toEpoch!==(this.#manifest?.epoch??this.#route?.epoch))fail('ANCHOR_COLD_OPERATION');epochs.add(receipt.toEpoch);operations++;
    }
    const epoch=this.#manifest?.epoch??this.#route?.epoch??0;if(operations!==epoch)fail('ANCHOR_COLD_OPERATION');for(let i=1;i<=epoch;i++)if(!epochs.has(i))fail('ANCHOR_COLD_OPERATION');
    if(this.#route&&this.#cold){const prior=this.#maintenance(this.#cold.intent.request);if(!prior||!same(prior,receiptOf(this.#cold.intent,this.#route)))fail('ANCHOR_COLD_OPERATION');}
    if(this.#shards&&this.#manifest){const i=this.#shards.intent,prior=this.#maintenance(i.request);const expected={version:2,kind:i.request.kind,operationId:i.request.operationId,requestDigest:sha(json(i.request,1024)),fromEpoch:i.request.expectedRouteEpoch,toEpoch:this.#manifest.epoch,sourceSnapshotDigest:i.sourceSnapshotDigest,selectionDigest:i.selectionDigest,moved:i.moved,manifest:this.#manifest};if(!prior||!same(prior,expected))fail('ANCHOR_COLD_OPERATION');}
    if(this.#reservation){if(this.#db.prepare("SELECT 1 FROM vaults WHERE json_extract(state,'$.status')='PREPARED' LIMIT 1").get()||this.#snapshot()!==this.#reservation.sourceSnapshotDigest)fail('ANCHOR_SHARD_RESERVATION');}
  }
  #maintenance(request:AnyRequest):AnyReceipt|null{
    return this.#usingRaw('M',0,request.operationId,row=>{const stored=anyRequest(parsed(row.values[1] as Uint8Array));if(JSON.stringify(stored)!==JSON.stringify(request))fail('ANCHOR_COLD_CONFLICT');const receipt=parsed(row.values[2] as Uint8Array) as AnyReceipt;anyReceipt(receipt,stored);return receipt;});
  }
  #snapshot(includeRoute=true):string{
    const hash=hashRows();for(const kind of (includeRoute?['V','R','S','L','M']:['V','R','S','L']) as Kind[])for(const row of this.#rawRows(kind))hash.add(this.#version===6&&includeRoute?{...row,values:[...row.values,row.epoch]}:row);
    if(includeRoute)hash.add({kind:'V',values:['@route',Buffer.from(JSON.stringify(this.#manifest??this.#route))],epoch:0});return hash.finish();
  }
  static upgradeColdSchema(config:AuthorityConfig,maintenance:'operator-attested-stopped',fault?:(point:'after-table'|'after-version')=>void):{from:4|5;to:5;alreadyCurrent:boolean}{
    if(maintenance!=='operator-attested-stopped')fail('ANCHOR_MAINTENANCE_REQUIRED');const a=LocalSqliteAuthority.open(config);a.#workspace=new ColdWorkspace();
    try{if(a.#version===5)return a.transaction(()=>({from:5 as const,to:5 as const,alreadyCurrent:true}));if(a.#version!==4)fail('ANCHOR_COLD_UPGRADE_REQUIRED');
      a.#db.exec('BEGIN EXCLUSIVE');a.#locked=true;
      try{a.#checkFiles();a.#checkSchema();a.#captureSize();a.#validateLayout(4);a.#newMutation();inspectFiles(a.directory);a.#validateClosure();const before=a.#snapshot(false);
        a.#db.exec(`${ROUTE_SQL};${OPERATION_SQL};INSERT INTO authority_cold_route VALUES (1,0,NULL)`);fault?.('after-table');a.#db.exec('PRAGMA user_version=5');fault?.('after-version');a.#version=5;a.#schemaEpoch=a.#db.prepare('PRAGMA schema_version').get()!.schema_version as number;
        a.#validateLayout(5);a.#loadCold();a.#validateClosure();if(a.#snapshot(false)!==before)fail('ANCHOR_SCHEMA_MIGRATION');a.#checkCapacity();a.#commit();return{from:4,to:5,alreadyCurrent:false};
      }catch(e){if(a.#locked){a.#db.exec('ROLLBACK');a.#locked=false;}a.#dropCold();throw e;}
    }finally{a.#lastWorkspacePeak=a.#workspace.peak;a.#workspace=undefined;a.close();}
  }
  static upgradeShardedColdSchema(config:AuthorityConfig,maintenance:'operator-attested-stopped',fault?:(point:'after-table'|'after-version')=>void):{from:5|6;to:6;alreadyCurrent:boolean}{
    if(maintenance!=='operator-attested-stopped')fail('ANCHOR_MAINTENANCE_REQUIRED');const a=LocalSqliteAuthority.open(config);a.#workspace=new ColdWorkspace();
    try{if(a.#version===6)return a.transaction(()=>({from:6 as const,to:6 as const,alreadyCurrent:true}));if(a.#version!==5)fail('ANCHOR_SHARD_UPGRADE_REQUIRED');
      a.#db.exec('BEGIN EXCLUSIVE');a.#locked=true;
      try{a.#checkFiles();a.#checkSchema();a.#captureSize();a.#validateLayout(5);a.#newMutation();a.#loadCold();a.#validateClosure();const business=a.#snapshot(false),source=a.#snapshot();
        const m:ShardManifest={format:'companion-authority-manifest-v2',version:2,profile:'two-shards-1MiB-v2',authorityId:a.authorityId,custodyDomain:a.custodyDomain,epoch:a.#route?.epoch??0,parentManifestDigest:null,sourceSnapshotDigest:source,selectionDigest:null,current:a.#route?{format:'legacy-v1',descriptor:a.#route}:null};
        a.#db.exec(SHARD_ROOT_SQL);a.#db.prepare('INSERT INTO authority_shard_root VALUES (1,?,NULL)').run(json(m,8192));fault?.('after-table');a.#db.exec('PRAGMA user_version=6');fault?.('after-version');a.#version=6;a.#schemaEpoch=a.#db.prepare('PRAGMA schema_version').get()!.schema_version as number;
        a.#validateLayout(6);a.#loadCold();a.#validateClosure();if(a.#snapshot(false)!==business)fail('ANCHOR_SCHEMA_MIGRATION');a.#checkCapacity();a.#commit();return{from:5,to:6,alreadyCurrent:false};
      }catch(e){if(a.#locked){a.#db.exec('ROLLBACK');a.#locked=false;}a.#dropCold();throw e;}
    }finally{a.#lastWorkspacePeak=a.#workspace.peak;a.#workspace=undefined;a.close();}
  }
  #buildShards(request:ShardRequest,batch:ColdSelection,snapshot:string):{outputs:ReturnType<ShardDatabase['serialize']>[];counts:Counts;close:Release}{
    const outputs:ReturnType<ShardDatabase['serialize']>[]=[],counts=[emptyCounts(),emptyCounts()],total=emptyCounts();
    const rows=(self:LocalSqliteAuthority,kind:Exclude<Kind,'V'>):Iterable<RawRow>=>({*[Symbol.iterator](){for(const row of self.#rawRows(kind))if(row.epoch)yield row;for(const row of batch.rows)if(row.kind===kind)yield{...row,epoch:request.expectedRouteEpoch+1};}});
    try{for(const kind of ['R','S','L','M'] as const)for(const row of rows(this,kind)){const key={R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts;counts[partition(row)]![key]++;total[key]++;}
      for(const part of [0,1] as const){const self=this;function* selected(){for(const kind of ['R','S','L','M'] as const)for(const row of rows(self,kind))if(partition(row)===part)yield row;}
        const meta:ShardMeta={format:'companion-authority-shard-sqlite-v2',version:2,authorityId:this.authorityId,custodyDomain:this.custodyDomain,operationId:request.operationId,requestDigest:sha(json(request,1024)),fromEpoch:request.expectedRouteEpoch,toEpoch:request.expectedRouteEpoch+1,partition:part,sourceSnapshotDigest:snapshot,selectionDigest:batch.digest,counts:counts[part]!};
        const db=ShardDatabase.build(meta,selected(),this.#workspace!);try{outputs.push(db.serialize());}finally{db.close();}
      }return{outputs,counts:total,close:()=>{for(const out of outputs)out.close();}};
    }catch(e){for(const out of outputs)out.close();throw e;}
  }
  #pendingFor(request:ShardRequest):ShardReservation|null{
    const r=this.#reservation;if(!r)return null;if(r.request.operationId!==request.operationId)fail('ANCHOR_SHARD_PENDING');if(json(r.request,1024)!==json(request,1024))fail('ANCHOR_COLD_CONFLICT');return r;
  }
  #verifyShardSelection(r:ShardReservation,dbs:readonly ShardDatabase[]):ColdSelection{
    if(this.#snapshot()!==r.sourceSnapshotDigest||json(this.#manifest,8192)!==json(r.baseManifest,8192))fail('ANCHOR_COLD_STALE_SNAPSHOT');
    const batch=this.#selectCold();try{if(batch.digest!==r.selectionDigest||json(batch.moved,1024)!==json(r.moved,1024))fail('ANCHOR_COLD_SELECTION');const found=new Set<RawRow>(),counts=emptyCounts();
      for(const db of dbs)for(const kind of ['R','S','L','M'] as const)for(const row of db.rows(kind)){
        const matches=this.#usingRaw(kind,0,row.values[0] as string,original=>keyCompare(original,row)===0?sameRow(original,row)&&((original.epoch||r.request.expectedRouteEpoch+1)===row.epoch):undefined,kind==='R'?row.values[1] as string:undefined);if(!matches)fail('ANCHOR_COLD_SELECTION');
        if(row.epoch===r.request.expectedRouteEpoch+1){const selected=batch.rows.find(x=>sameRow(x,row));if(!selected||found.has(selected))fail('ANCHOR_COLD_SELECTION');found.add(selected);}counts[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts]++;
      }
      if(found.size!==batch.rows.length||json(counts,1024)!==json(r.plans[r.activeAttempt].counts,1024))fail('ANCHOR_COLD_SELECTION');
      for(const kind of ['R','S','L','M'] as const){let n=batch.rows.filter(x=>x.kind===kind).length;for(const row of this.#rawRows(kind))if(row.epoch)n++;if(n!==counts[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts])fail('ANCHOR_COLD_COUNTS');}return batch;
    }catch(e){batch.close();throw e;}
  }
  #publishShardSQL(r:ShardReservation,candidate:LoadedShards):ShardReceipt{
    const batch=this.#verifyShardSelection(r,candidate.dbs),business=this.#snapshot(false),receipt=receiptFor(r);
    try{for(const row of batch.rows){const table={R:'receipts',S:'receipt_segments',L:'legacy_imports',M:'authority_cold_operation',V:'vaults'}[row.kind],conditions=ROW_COLUMNS[row.kind].map((c,i)=>ROW_BLOBS[row.kind].includes(i)?`CAST(${c} AS BLOB)=?`:`${c}=?`).join(' AND ');if(this.#db.prepare(`DELETE FROM ${table} WHERE ${conditions}`).run(...row.values).changes!==1)fail('ANCHOR_COLD_SELECTION');}
      if(this.#db.prepare('UPDATE authority_shard_root SET manifest=?,reservation=NULL WHERE id=1 AND manifest=? AND reservation=?').run(json(receipt.manifest,8192),json(r.baseManifest,8192),json(r,8192)).changes!==1)fail('ANCHOR_SHARD_RESERVATION');
      this.#db.prepare('INSERT INTO authority_cold_operation VALUES (1,?,?,?)').run(r.request.operationId,json(r.request,1024),json(receipt,8192));
      const saved={cold:this.#cold,shards:this.#shards,route:this.#route,manifest:this.#manifest,reservation:this.#reservation};this.#cold=undefined;this.#shards=candidate;this.#route=null;this.#manifest=receipt.manifest;this.#reservation=null;
      try{this.#validateClosure();if(this.#snapshot(false)!==business)fail('ANCHOR_COLD_SELECTION');if(this.#pages()-this.#freelist()>=r.rootUsedPages)fail('ANCHOR_COLD_NO_BENEFIT');this.#checkCapacity(false);}finally{this.#cold=saved.cold;this.#shards=saved.shards;this.#route=saved.route;this.#manifest=saved.manifest;this.#reservation=saved.reservation;}
      return receipt;
    }finally{batch.close();}
  }
  #previewShardReservation(r:ShardReservation,outputs:readonly {bytes:Uint8Array}[]):void{
    const beforePages=this.#pages(),beforeFree=this.#freelist(),beforeSnapshot=this.#snapshot(),beforeRoot=this.#db.prepare('SELECT manifest,reservation FROM authority_shard_root WHERE id=1').get()!,dbs:ShardDatabase[]=[];
    try{for(const out of outputs)dbs.push(ShardDatabase.open(out.bytes,this.#workspace!));
      // Both active-attempt shapes must fit, including their durable starting image and next rollback journal.
      for(const active of [0,1] as const){const trial={...r,activeAttempt:active};this.#db.exec('SAVEPOINT shard_preview');
        try{this.#db.prepare('UPDATE authority_shard_root SET reservation=? WHERE id=1').run(json(r,8192));this.#checkCapacity(true);const initialPages=this.#pages();this.#checkCapacity(true,initialPages,Math.max(this.#startBytes,initialPages*this.#pageSize));
          if(active===1){this.#db.prepare('UPDATE authority_shard_root SET reservation=? WHERE id=1 AND reservation=?').run(json(trial,8192),json(r,8192));this.#checkCapacity(true,initialPages,Math.max(this.#startBytes,initialPages*this.#pageSize));}
          const reservedPages=this.#pages();this.#checkCapacity(true,reservedPages,Math.max(this.#startBytes,reservedPages*this.#pageSize));
          this.#publishShardSQL(trial,{dbs:dbs as [ShardDatabase,ShardDatabase],intent:intentFor(trial,active),close:()=>{}});this.#checkCapacity(true,reservedPages,Math.max(this.#startBytes,reservedPages*this.#pageSize));
        }finally{this.#db.exec('ROLLBACK TO shard_preview; RELEASE shard_preview');}
        if(this.#pages()!==beforePages||this.#freelist()!==beforeFree||this.#snapshot()!==beforeSnapshot||!same(this.#db.prepare('SELECT manifest,reservation FROM authority_shard_root WHERE id=1').get(),beforeRoot))fail('ANCHOR_CAPACITY_PREVIEW');
      }
    }finally{for(const db of dbs)db.close();}
  }
  archivePermanentKeysV2(input:ShardInput):FrozenData<ShardReceipt>{
    const request=normalizeShard(input);if(this.#closed||this.#locked||this.#workspace)fail('ANCHOR_TRANSACTION');this.#workspace=new ColdWorkspace();let built:ShardBuild|undefined;
    try{const frozen=this.transaction(()=>{
        if(this.#version!==6)fail('ANCHOR_SHARD_UPGRADE_REQUIRED');const prior=this.#maintenance(request);if(prior)return{prior:prior as ShardReceipt,reservation:null};const pending=this.#pendingFor(request);if(pending)return{prior:null,reservation:pending};
        if(this.#manifest!.epoch!==request.expectedRouteEpoch||sha(json(this.#manifest,8192))!==request.expectedManifestDigest)fail('ANCHOR_COLD_STALE_SNAPSHOT');this.#newMutation();this.#checkCapacity();this.#mutation='none';const source=this.#snapshot(),batch=this.#selectCold();
        try{built=this.#buildShards(request,batch,source);const r=planned({format:'companion-authority-publication-v2',version:2,request,sourceSnapshotDigest:source,baseManifest:this.#manifest!,selectionDigest:batch.digest,moved:batch.moved,rootPageCount:this.#pages(),rootUsedPages:this.#pages()-this.#freelist()},built.outputs.map(x=>x.bytes),built.counts);return{prior:null,reservation:r};}finally{batch.close();}
      });if(frozen.prior)return freezeCapacity(frozen.prior);let r=frozen.reservation!;
      if(built){const prepared=this.transaction(()=>this.#writeAction(()=>{const prior=this.#maintenance(request);if(prior)return prior;const pending=this.#pendingFor(request);if(pending){r=pending;return null;}if(this.#snapshot()!==r.sourceSnapshotDigest||json(this.#manifest,8192)!==json(r.baseManifest,8192))fail('ANCHOR_COLD_STALE_SNAPSHOT');this.#newMutation();const physical=inspectShardFiles(this.directory);for(const p of r.plans)for(const f of [p.intent,...p.parts])if(physical.entries.has(f.name))fail('ANCHOR_SHARD_STAGE');obligations(physical,r.baseManifest,r);this.#previewShardReservation(r,built!.outputs);this.#db.prepare('UPDATE authority_shard_root SET reservation=? WHERE id=1 AND reservation IS NULL').run(json(r,8192));this.#reservation=r;return null;}));if(prepared)return freezeCapacity(prepared as ShardReceipt);built.close();built=undefined;}
      // Decide recovery while holding the root lock. A partial attempt is never appended to.
      const resumed=this.transaction(()=>this.#writeAction(()=>{const prior=this.#maintenance(request);if(prior)return prior;const pending=this.#pendingFor(request);if(!pending)fail('ANCHOR_SHARD_RESERVATION');r=pending;
        const state=stageState(this.directory,r.plans[r.activeAttempt],this.#workspace!);if(state==='partial'){if(r.activeAttempt===1)fail('ANCHOR_SHARD_ATTEMPTS_EXHAUSTED');const next={...r,activeAttempt:1 as const};for(const f of [next.plans[1].intent,...next.plans[1].parts])if(existsSync(join(this.directory,f.name)))fail('ANCHOR_SHARD_STAGE');this.#mutation='completion';this.#checkCapacity(false);this.#db.prepare('UPDATE authority_shard_root SET reservation=? WHERE id=1 AND reservation=?').run(json(next,8192),json(r,8192));r=next;this.#reservation=next;this.#checkCapacity(false);}return null;}));if(resumed)return freezeCapacity(resumed as ShardReceipt);
      return this.transaction(()=>this.#writeAction(()=>{const prior=this.#maintenance(request);if(prior)return freezeCapacity(prior as ShardReceipt);const pending=this.#pendingFor(request);if(!pending)fail('ANCHOR_SHARD_RESERVATION');r=pending;const state=stageState(this.directory,r.plans[r.activeAttempt],this.#workspace!);if(state==='partial')fail('ANCHOR_SHARD_STAGE');this.#mutation='completion';
        if(state==='absent'){const batch=this.#selectCold();try{built=this.#buildShards(request,batch,r.sourceSnapshotDigest);if(batch.digest!==r.selectionDigest||json(batch.moved,1024)!==json(r.moved,1024))fail('ANCHOR_COLD_SELECTION');for(const i of [0,1] as const){const f=r.plans[r.activeAttempt].parts[i],bytes=built.outputs[i]!.bytes;if(bytes.length!==f.bytes||sha(bytes)!==f.sha256)fail('ANCHOR_SHARD_BINDING');}this.#checkCapacity(false);const intent=json(intentFor(r,r.activeAttempt),8192);exclusive(join(this.directory,r.plans[r.activeAttempt].intent.name),Buffer.from(intent));for(const i of [0,1] as const)exclusive(join(this.directory,r.plans[r.activeAttempt].parts[i].name),built.outputs[i]!.bytes);}finally{built?.close();built=undefined;batch.close();}}
        const candidate=loadShards(this.directory,nextManifest(r),this.#workspace!);try{const receipt=this.#publishShardSQL(r,candidate);candidate.close();this.#loadCold();return freezeCapacity(receipt);}finally{candidate.close();}
      }));
    }finally{built?.close();this.#dropCold();this.#lastWorkspacePeak=this.#workspace.peak;this.#workspace=undefined;}
  }
  #selectCold():ColdSelection{
    const owned:{row:RawRow;close:Release}[]=[],moved:Moved={...emptyCounts(),framedBytes:0,skipped:{receipts:0,segments:0,legacy:0}};
    const fits=(bytes:number,receipts:number,segments:number,legacy:number):boolean=>moved.receipts+receipts<=256&&moved.segments+segments<=4&&moved.legacy+legacy<=16&&moved.framedBytes+bytes<=262144;
    const take=(group:{row:RawRow;close:Release}[],bytes:number,receipts:number,segments:number,legacy:number):void=>{
      owned.push(...group);moved.receipts+=receipts;moved.segments+=segments;moved.legacy+=legacy;moved.framedBytes+=bytes;
    };
    try{
      for(const row of this.#hotRows('S')){
        const decoded=this.#decodeSegment(row),group:{row:RawRow;close:Release}[]=[];
        try{let bytes=frameBytes(row);
          // Validate the entire group even when it will not fit; do not retain copies until admission.
          for(const [index,entry] of decoded.entries.entries()){const size=this.#usingRaw('R',0,entry.vaultId,r=>{if(r.values[1]!==entry.operationId)return undefined;if(r.epoch||utf8(r.values[2] as Uint8Array)!==receiptPointer(row.values[0] as string,index,Buffer.byteLength(entry.json)))fail('ANCHOR_RECEIPT_SEGMENT');return frameBytes(r);},entry.operationId);if(size===null)fail('ANCHOR_RECEIPT_SEGMENT');bytes=safeSum(bytes,size);}
          if(!fits(bytes,decoded.entries.length,1,0)){moved.skipped.segments++;continue;}
          group.push(copyRow(row,this.#workspace!));
          for(const entry of decoded.entries){const item=this.#usingRaw('R',0,entry.vaultId,r=>r.values[1]===entry.operationId?copyRow(r,this.#workspace!):undefined,entry.operationId);if(!item||item.row.epoch)fail('ANCHOR_RECEIPT_SEGMENT');group.push(item);}
          take(group,bytes,decoded.entries.length,1,0);
        }catch(e){for(const x of group)x.close();throw e;}finally{decoded.close();}
      }
      for(const row of this.#hotRows('R')){if(parseReceiptPointer(utf8(row.values[2] as Uint8Array)))continue;const bytes=frameBytes(row);if(fits(bytes,1,0,0))take([copyRow(row,this.#workspace!)],bytes,1,0,0);else moved.skipped.receipts++;}
      for(const row of this.#hotRows('L')){const value=parsed(row.values[3] as Uint8Array) as LegacyRegistration;if(value.status!=='ACTIVE'||value.admission!=='admitted')continue;const bytes=frameBytes(row);if(fits(bytes,0,0,1))take([copyRow(row,this.#workspace!)],bytes,0,0,1);else moved.skipped.legacy++;}
      if(moved.receipts+moved.segments+moved.legacy===0)fail('ANCHOR_COLD_EMPTY');
      for(const row of this.#hotRows('M')){owned.push(copyRow(row,this.#workspace!));moved.operations++;}
      const rows=owned.map(x=>x.row).sort((a,b)=>Buffer.compare(Buffer.from(a.kind),Buffer.from(b.kind))||keyCompare(a,b)),hash=hashRows();for(const row of rows)hash.add(row);
      return{rows,moved,digest:hash.finish(),close:()=>{for(const x of owned){for(const v of x.row.values)if(v instanceof Uint8Array)v.fill(0);x.close();}}};
    }catch(e){for(const x of owned)x.close();throw e;}
  }
  *#frozenGroups(rows:RawRow[]):Generator<ColdGroup>{
    const covered=new Set<RawRow>();
    for(const segment of rows.filter(r=>r.kind==='S')){
      const decoded=this.#decodeSegment(segment),group=[segment];
      try{for(const [index,entry] of decoded.entries.entries()){
        const pointer=rows.find(r=>r.kind==='R'&&r.values[0]===entry.vaultId&&r.values[1]===entry.operationId);
        if(!pointer||covered.has(pointer)||utf8(pointer.values[2] as Uint8Array)!==receiptPointer(segment.values[0] as string,index,Buffer.byteLength(entry.json)))fail('ANCHOR_RECEIPT_SEGMENT');covered.add(pointer);group.push(pointer);
      }}finally{decoded.close();}
      yield{rows:group,receipts:group.length-1,segments:1,legacy:0,framedBytes:group.reduce((n,r)=>safeSum(n,frameBytes(r)),0),skipped:'segments'};
    }
    for(const row of rows.filter(r=>r.kind==='R')){if(covered.has(row))continue;if(parseReceiptPointer(utf8(row.values[2] as Uint8Array)))fail('ANCHOR_RECEIPT_SEGMENT');yield{rows:[row],receipts:1,segments:0,legacy:0,framedBytes:frameBytes(row),skipped:'receipts'};}
    for(const row of rows.filter(r=>r.kind==='L'))yield{rows:[row],receipts:0,segments:0,legacy:1,framedBytes:frameBytes(row),skipped:'legacy'};
  }
  #selectedDigest(rows:RawRow[]):{rows:RawRow[];digest:string}{
    const ordered=[...rows].sort((a,b)=>Buffer.compare(Buffer.from(a.kind),Buffer.from(b.kind))||keyCompare(a,b)),hash=hashRows();for(const row of ordered)hash.add(row);return{rows:ordered,digest:hash.finish()};
  }
  #coldSubset(batch:ColdSelection,rows:RawRow[]):ColdSubset{
    const selected=new Set(rows);if(selected.size!==rows.length||rows.some(row=>!batch.rows.includes(row)))fail('ANCHOR_COLD_SELECTION');
    const moved:Moved={...emptyCounts(),framedBytes:0,skipped:{...batch.moved.skipped}};
    for(const row of batch.rows.filter(r=>r.kind==='M')){if(!selected.has(row))fail('ANCHOR_COLD_SELECTION');moved.operations++;}
    for(const group of this.#frozenGroups(batch.rows)){
      const count=group.rows.filter(row=>selected.has(row)).length;if(count!==0&&count!==group.rows.length)fail('ANCHOR_COLD_SELECTION');
      if(count){moved.receipts+=group.receipts;moved.segments+=group.segments;moved.legacy+=group.legacy;moved.framedBytes=safeSum(moved.framedBytes,group.framedBytes);}
      else moved.skipped[group.skipped]++;
    }
    if(moved.receipts+moved.segments+moved.legacy===0)fail('ANCHOR_COLD_EMPTY');return{...this.#selectedDigest(rows),moved};
  }
  #buildPhysicalCold(batch:ColdSelection,request:ReturnType<typeof normalizeCold>,route:Descriptor|null,snapshot:string):{candidate:ColdDatabase;selected:ColdSubset}{
    let old:ReturnType<typeof loadCurrent>|undefined,candidate:ColdDatabase|undefined;
    try{
      if(route)old=loadCurrent(this.directory,route,this.#workspace!);
      const mandatory=batch.rows.filter(r=>r.kind==='M'),initial=this.#selectedDigest(mandatory),counts=old?{...old.db.meta.counts}:emptyCounts();counts.operations+=mandatory.length;
      const meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:this.authorityId,custodyDomain:this.custodyDomain,operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:request.expectedRouteEpoch,toEpoch:request.expectedRouteEpoch+1,parentPayloadDigest:route?.payloadDigest??null,sourceSnapshotDigest:snapshot,selectionDigest:initial.digest,counts};
      function* required():Generator<RawRow>{if(old)for(const kind of ['R','S','L','M'] as const)yield*old.db.rows(kind);for(const row of mandatory)yield{...row,epoch:meta.toEpoch};}
      candidate=ColdDatabase.build(meta,required(),this.#workspace!,true);old?.close();old=undefined;let accepted=initial.rows;
      for(const group of this.#frozenGroups(batch.rows)){
        const next=this.#selectedDigest([...accepted,...group.rows]),counts={...candidate.meta.counts};counts.receipts+=group.receipts;counts.segments+=group.segments;counts.legacy+=group.legacy;
        if(candidate.tryGroup({...candidate.meta,selectionDigest:next.digest,counts},group.rows.map(row=>({...row,epoch:meta.toEpoch}))))accepted=next.rows;
      }
      const selected=this.#coldSubset(batch,accepted);if(selected.digest!==candidate.meta.selectionDigest)fail('ANCHOR_COLD_SELECTION');candidate.seal();const result=candidate;candidate=undefined;return{candidate:result,selected};
    }finally{candidate?.close();old?.close();}
  }
  archivePermanentKeys(input:ColdInput):FrozenData<ColdReceipt>{
    const request=normalizeCold(input);if(this.#closed||this.#locked||this.#workspace)fail('ANCHOR_TRANSACTION');this.#workspace=new ColdWorkspace();
    let selection:ColdSelection|undefined;
    try{
      const frozen=this.transaction(()=>{
        if(this.#version<5)fail('ANCHOR_COLD_UPGRADE_REQUIRED');const prior=this.#maintenance(request);if(prior)return{prior:prior as ColdReceipt,stage:null,snapshot:'',route:null};if(this.#version===6)fail('ANCHOR_SHARD_API_REQUIRED');
        const stage=findStage(this.directory,request,this.#workspace!);
        if((this.#route?.epoch??0)!==request.expectedRouteEpoch)fail('ANCHOR_COLD_STALE_SNAPSHOT');this.#newMutation();this.#checkCapacity();this.#mutation='none';
        const snapshot=this.#snapshot();if(stage){if(stage.intent.sourceSnapshotDigest!==snapshot)fail('ANCHOR_COLD_STALE_SNAPSHOT');return{prior:null,stage,snapshot,route:this.#route};}
        selection=this.#selectCold();return{prior:null,stage:null,snapshot,route:this.#route};
      });
      if(frozen.prior)return freezeCapacity(frozen.prior);
      let stage:Stage;
      if(frozen.stage)stage=frozen.stage;
      else{
        let candidate:ColdDatabase|undefined,serialized:ReturnType<ColdDatabase['serialize']>|undefined;
        try{
          const built=this.#buildPhysicalCold(selection!,request,frozen.route,frozen.snapshot);candidate=built.candidate;serialized=candidate.serialize();
          const meta=candidate.meta,counts=meta.counts,moved=built.selected.moved,payloadBytes=serialized.bytes.length,payloadDigest=sha(serialized.bytes);
          stage=writeStage(this.directory,slot=>({format:'companion-authority-cold-intent-v1',version:1,slot,authorityId:this.authorityId,custodyDomain:this.custodyDomain,request,requestDigest:meta.requestDigest,fromEpoch:meta.fromEpoch,toEpoch:meta.toEpoch,parentPayloadDigest:meta.parentPayloadDigest,sourceSnapshotDigest:meta.sourceSnapshotDigest,selectionDigest:meta.selectionDigest,counts,moved,payloadBytes,payloadDigest}),serialized.bytes,this.#workspace);
        }finally{serialized?.close();candidate?.close();selection?.close();selection=undefined;}
      }
      this.transaction(()=>this.#writeAction(()=>{
        // Each publication relock repeats the accepted M-first ordering.
        const prior=this.#maintenance(request);if(prior)return prior;
        const staged=findStage(this.directory,request,this.#workspace!);if(!staged||!same(staged,stage))fail('ANCHOR_COLD_STAGE_INCOMPLETE');
        if((this.#route?.epoch??0)!==request.expectedRouteEpoch)fail('ANCHOR_COLD_STALE_SNAPSHOT');this.#newMutation();this.#checkCapacity();
        if(this.#snapshot()!==stage.intent.sourceSnapshotDigest)fail('ANCHOR_COLD_STALE_SNAPSHOT');
        const batch=this.#selectCold();let candidate:ReturnType<typeof loadCurrent>|undefined;
        try{
          candidate=loadCurrent(this.directory,stage.descriptor,this.#workspace!);const business=this.#snapshot(false),beforePages=this.#pages(),beforeUsed=beforePages-this.#freelist();
          if(stage.intent.parentPayloadDigest!==(this.#route?.payloadDigest??null))fail('ANCHOR_COLD_SELECTION');
          const chosen:RawRow[]=[];for(const kind of ['R','S','L','M'] as const)for(const row of candidate.db.rows(kind)){
            const source=this.#usingRaw(kind,0,row.values[0] as string,original=>keyCompare(original,row)===0?sameRow(original,row)&&((original.epoch||stage.intent.toEpoch)===row.epoch):undefined,kind==='R'?row.values[1] as string:undefined);
            if(!source)fail('ANCHOR_COLD_SELECTION');if(row.epoch===stage.intent.toEpoch){const selected=batch.rows.find(r=>sameRow(r,row));if(!selected)fail('ANCHOR_COLD_SELECTION');chosen.push(selected);}
          }
          const selected=this.#coldSubset(batch,chosen);if(selected.digest!==stage.intent.selectionDigest||!same(selected.moved,stage.intent.moved))fail('ANCHOR_COLD_SELECTION');
          for(const kind of ['R','S','L','M'] as const){const expected=(this.#cold?.db.meta.counts[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts]??0)+selected.rows.filter(r=>r.kind===kind).length;if(stage.intent.counts[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts]!==expected)fail('ANCHOR_COLD_COUNTS');}
          // Private synchronous SQL interval: no public callback or await.
          for(const row of selected.rows){const table={R:'receipts',S:'receipt_segments',L:'legacy_imports',M:'authority_cold_operation',V:'vaults'}[row.kind];
            const conditions=ROW_COLUMNS[row.kind].map((column,i)=>ROW_BLOBS[row.kind].includes(i)?`CAST(${column} AS BLOB)=?`:`${column}=?`).join(' AND ');
            if(this.#db.prepare(`DELETE FROM ${table} WHERE ${conditions}`).run(...row.values).changes!==1)fail('ANCHOR_COLD_SELECTION');}
          const receipt=receiptOf(stage.intent,stage.descriptor);
          this.#db.prepare('UPDATE authority_cold_route SET epoch=?,descriptor=? WHERE id=1 AND epoch=?').run(stage.intent.toEpoch,json(stage.descriptor,2048),request.expectedRouteEpoch);
          this.#db.prepare('INSERT INTO authority_cold_operation VALUES (1,?,?,?)').run(request.operationId,json(request,8192),json(receipt,8192));
          this.#loadCold();this.#validateClosure();if(this.#snapshot(false)!==business)fail('ANCHOR_COLD_SELECTION');
          if(this.#pages()>beforePages||this.#pages()-this.#freelist()>=beforeUsed)fail('ANCHOR_COLD_NO_BENEFIT');this.#checkCapacity();return receipt;
        }finally{candidate?.close();batch.close();}
      }));
      // A separate guarded lookup handles both our commit and a competing committed ID.
      return this.transaction(()=>{const receipt=this.#maintenance(request);if(!receipt)fail('ANCHOR_COLD_OPERATION');return freezeCapacity(receipt as ColdReceipt);});
    }finally{selection?.close();this.#dropCold();this.#lastWorkspacePeak=this.#workspace.peak;this.#workspace=undefined;}
  }
  #assertClosureTarget(path:string):void{
    const target=resolve(path);disjoint(this.directory,target);for(const row of this.#rawRows('V')){const state=parsed(row.values[1] as Uint8Array) as AnchorRow;for(const head of [state.head,state.pending?.newHead])if(head)disjoint(head.directory,target);}
  }
  exportColdClosure(newDirectory:string):FrozenData<ClosureResult>{
    return this.transaction(()=>{if(this.#version<5)fail('ANCHOR_COLD_UPGRADE_REQUIRED');this.#assertClosureTarget(newDirectory);if(this.#manifest?.current?.format==='two-shards-v2'){exportShardClosure(this.directory,newDirectory,this.#manifest,this.#workspace!);return freezeCapacity({status:'COLD_CLOSURE_ONLY',authority:'ORIGINAL_AUTHORITY_REQUIRED',descriptor:this.#manifest});}if(!this.#route)fail('ANCHOR_COLD_EMPTY');exportClosure(this.directory,newDirectory,this.#route,this.authorityId,this.custodyDomain,this.#workspace!);return freezeCapacity({status:'COLD_CLOSURE_ONLY',authority:'ORIGINAL_AUTHORITY_REQUIRED',descriptor:this.#route});});
  }
  verifyColdClosure(directory:string):FrozenData<ClosureResult>{
    return this.transaction(()=>{if(this.#version<5)fail('ANCHOR_COLD_UPGRADE_REQUIRED');this.#assertClosureTarget(directory);if(this.#manifest?.current?.format==='two-shards-v2'){const pack=readShardClosure(directory,this.#manifest,this.#workspace!);pack.close();const check=loadShards(directory,this.#manifest,this.#workspace!,true);check.close();return freezeCapacity({status:'COLD_CLOSURE_ONLY',authority:'ORIGINAL_AUTHORITY_REQUIRED',descriptor:this.#manifest});}if(!this.#route)fail('ANCHOR_COLD_EMPTY');const pack=readClosure(directory,this.#route,this.authorityId,this.custodyDomain,this.#workspace!);pack.close();return freezeCapacity({status:'COLD_CLOSURE_ONLY',authority:'ORIGINAL_AUTHORITY_REQUIRED',descriptor:this.#route});});
  }
  repairMissingColdClosure(directory:string):FrozenData<ClosureResult>{
    if(this.#version<5)fail('ANCHOR_COLD_UPGRADE_REQUIRED');if(this.#closed||this.#locked||this.#workspace)fail('ANCHOR_TRANSACTION');this.#repair=true;
    try{return this.transaction(()=>{
      if(this.#version===6){const state=this.#readShardState();this.#manifest=state.manifest;this.#reservation=state.reservation;if(state.manifest.current?.format==='two-shards-v2')return this.#repairShards(directory,state.manifest);}
      const route=this.#readRoute();if(!route)fail('ANCHOR_COLD_EMPTY');this.#route=route;this.#assertClosureTarget(directory);
      const pack=readClosure(directory,route,this.authorityId,this.custodyDomain,this.#workspace!),names=slotNames(route.slot);let ticket:Release|undefined;
      try{
        ticket=this.#workspace!.reserve(route.intentBytes+route.payloadBytes,'repair output files');
        const intent=parsed(pack.intent.bytes) as Intent;this.#cold={db:pack.db,intent,close:()=>{}};this.#validateClosure();
        for(const [name,bytes] of [[names.intent,pack.intent.bytes],[names.payload,pack.payload.bytes]] as const){const path=join(this.directory,name);if(existsSync(path)){const prior=readOwned(path,bytes.length,this.#workspace!);try{if(!prior.bytes.equals(bytes))fail('ANCHOR_COLD_DIGEST');}finally{prior.close();}}}
        for(const [name,bytes] of [[names.intent,pack.intent.bytes],[names.payload,pack.payload.bytes]] as const)if(!existsSync(join(this.directory,name)))exclusive(join(this.directory,name),bytes);
        this.#cold=undefined;this.#loadCold();this.#validateClosure();return freezeCapacity({status:'COLD_CLOSURE_ONLY',authority:'ORIGINAL_AUTHORITY_REQUIRED',descriptor:route});
      }finally{if(this.#cold?.db===pack.db)this.#cold=undefined;pack.close();ticket?.();}
    });}finally{this.#repair=false;}
  }
  #repairShards(directory:string,m:ShardManifest):FrozenData<ClosureResult>{
    this.#assertClosureTarget(directory);const pack=readShardClosure(directory,m,this.#workspace!);let loaded:LoadedShards|undefined;
    try{loaded=loadShards(directory,m,this.#workspace!,true);this.#shards=loaded;this.#validateClosure();const refs=requiredFiles(m),contents=[pack.intent,...pack.parts];
      // Existing bytes must all match before creating even the first missing file.
      for(const f of refs)if(existsSync(join(this.directory,f.name))){const raw=verifyFile(this.directory,f,this.#workspace!);raw.close();}
      this.#checkCapacity(false);for(const [i,f] of refs.entries())if(!existsSync(join(this.directory,f.name)))exclusive(join(this.directory,f.name),contents[i]!.bytes);
      this.#shards=undefined;loaded.close();loaded=undefined;pack.close();this.#loadCold();this.#validateClosure();this.#checkCapacity(false);return freezeCapacity({status:'COLD_CLOSURE_ONLY',authority:'ORIGINAL_AUTHORITY_REQUIRED',descriptor:m});
    }finally{if(loaded){if(this.#shards===loaded)this.#shards=undefined;loaded.close();}pack.close();}
  }
  #capacitySix():AuthorityCapacity{
    const physical=inspectShardFiles(this.directory),state=this.#readShardState(),budget=obligations(physical,state.manifest,state.reservation),pageCount=this.#pages(),freelistPages=this.#freelist(),pageSize=this.#pageSize;
    const vaults=this.#db.prepare("SELECT count(*) AS count,coalesce(sum(json_extract(state,'$.status')='ACTIVE'),0) AS active,coalesce(sum(json_extract(state,'$.status')='PREPARED'),0) AS pending FROM vaults").get()!;
    const hot=emptyCounts(),cold=emptyCounts();let count=0,original=0,rawCount=0,rawBytes=0,pointerCount=0,pointerBytes=0,encoded=0,decoded=0,segmentJson=0;
    for(const kind of ['R','S','L','M'] as const)for(const row of this.#rawRows(kind)){
      (row.epoch?cold:hot)[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts]++;
      if(kind==='R'){count++;const value=utf8(row.values[2] as Uint8Array),p=parseReceiptPointer(value);if(p){pointerCount++;pointerBytes+=(row.values[2] as Uint8Array).byteLength;original+=p.jsonBytes;}else{rawCount++;rawBytes+=(row.values[2] as Uint8Array).byteLength;original+=(row.values[2] as Uint8Array).byteLength;}}
      if(kind==='S'){encoded+=row.values[4] as number;decoded+=row.values[3] as number;segmentJson+=row.values[6] as number;}
    }
    const blockers:AuthorityCapacity['blockers'][number][]=[];if(vaults.pending as number)blockers.push('GLOBAL_PENDING');if(state.reservation)blockers.push('PUBLICATION_PENDING');if(Math.max(physical.rootBytes,pageCount*pageSize)>this.#writeLimit)blockers.push('CURRENT_EXTENT_OVER_WRITE_LIMIT');
    return freezeCapacity({version:1,schemaVersion:6,database:{fileBytes:physical.rootBytes,pageSize,pageCount,pageBytes:pageCount*pageSize,freelistPages},sidecars:{journalBytes:physical.journalBytes,walBytes:0,shmBytes:0,totalBytes:physical.journalBytes},totalFileBytes:physical.rootBytes+physical.journalBytes+physical.retainedBytes,limits:{writeLimitBytes:this.#writeLimit,readLimitBytes:AUTHORITY_READ_LIMIT},vaults:{count:vaults.count as number,active:vaults.active as number,pending:vaults.pending as number},receipts:{count,jsonUtf8Bytes:original},receiptStorage:{hot:{count:rawCount,jsonUtf8Bytes:rawBytes},pointers:{count:pointerCount,storedUtf8Bytes:pointerBytes},segments:{count:hot.segments+cold.segments,encodedBytes:encoded,decodedBytes:decoded,jsonUtf8Bytes:segmentJson},limits:{...RECEIPT_SEGMENT_LIMITS}},legacyRegistry:{applicable:true,count:hot.legacy+cold.legacy},blockers,
      shardedColdRouting:{generation:state.manifest.epoch,manifestDigest:sha(json(state.manifest,8192)),currentBytes:requiredFiles(state.manifest).reduce((n,f)=>n+f.bytes,0),retainedBytes:physical.retainedBytes,obligationBytes:budget.bytes,missingObligationBytes:budget.missingBytes,files:physical.files,reservedFiles:budget.files,usedPages:pageCount-freelistPages,hot,cold,pending:state.reservation?{operationId:state.reservation.request.operationId,activeAttempt:state.reservation.activeAttempt}:null,workspacePeakBytes:Math.max(this.#workspace!.peak,this.#lastWorkspacePeak),limits:{retainedBytes:SHARD_LIMITS.retained,files:SHARD_LIMITS.files,partBytes:SHARD_LIMITS.part,parts:2,workspaceBytes:COLD_LIMITS.workspace,sharedBytes:COLD_LIMITS.shared,generation:SHARD_LIMITS.epoch}}});
  }
  #capacityFive():AuthorityCapacity{
    if(this.#version===6)return this.#capacitySix();
    const physical=inspectFiles(this.directory),pageCount=this.#pages(),freelistPages=this.#freelist(),pageSize=this.#pageSize;
    const vaults=this.#db.prepare("SELECT count(*) AS count,coalesce(sum(json_extract(state,'$.status')='ACTIVE'),0) AS active,coalesce(sum(json_extract(state,'$.status')='PREPARED'),0) AS pending FROM vaults").get()!;
    const hot=emptyCounts(),cold=emptyCounts();let count=0,original=0,rawCount=0,rawBytes=0,pointerCount=0,pointerBytes=0,encoded=0,decoded=0,segmentJson=0;
    for(const kind of ['R','S','L','M'] as const)for(const row of this.#rawRows(kind)){
      (row.epoch?cold:hot)[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts]++;
      if(kind==='R'){count++;const text=utf8(row.values[2] as Uint8Array),p=parseReceiptPointer(text);if(p){pointerCount++;pointerBytes+=(row.values[2] as Uint8Array).byteLength;original+=p.jsonBytes;}else{rawCount++;rawBytes+=(row.values[2] as Uint8Array).byteLength;original+=(row.values[2] as Uint8Array).byteLength;}}
      if(kind==='S'){encoded+=row.values[4] as number;decoded+=row.values[3] as number;segmentJson+=row.values[6] as number;}
    }
    const current=this.#route?this.#route.intentBytes+this.#route.payloadBytes:0;let retiredBytes=0;
    for(const slot of physical.slots){if(slot.slot===this.#route?.slot||!slot.intentBytes)continue;let raw:ReturnType<typeof readOwned>|undefined;const reserve=this.#workspace!.reserve(32768,'retained intent classification');
      try{raw=readOwned(join(this.directory,slotNames(slot.slot).intent),8192,this.#workspace!);const intent=parsed(raw.bytes) as Intent;validateIntent(intent);const committed=this.#maintenance(intent.request);if(committed?.version===1&&committed.descriptor.slot===slot.slot&&committed.descriptor.intentDigest===sha(raw.bytes))retiredBytes+=slot.intentBytes+slot.payloadBytes;}
      catch(e){if((e as {code?:string}).code==='ANCHOR_COLD_WORKSPACE')throw e;/* Unreferenced malformed stages are measured, never used as logical state. */}finally{raw?.close();reserve();}
    }
    const blockers:AuthorityCapacity['blockers'][number][]=[];if(vaults.pending as number)blockers.push('GLOBAL_PENDING');if(Math.max(physical.rootBytes,pageCount*pageSize)>this.#writeLimit)blockers.push('CURRENT_EXTENT_OVER_WRITE_LIMIT');
    return freezeCapacity({version:1,schemaVersion:5,database:{fileBytes:physical.rootBytes,pageSize,pageCount,pageBytes:pageCount*pageSize,freelistPages},sidecars:{journalBytes:physical.journalBytes,walBytes:0,shmBytes:0,totalBytes:physical.journalBytes},totalFileBytes:physical.rootBytes+physical.journalBytes+physical.retainedBytes,
      limits:{writeLimitBytes:this.#writeLimit,readLimitBytes:AUTHORITY_READ_LIMIT},vaults:{count:vaults.count as number,active:vaults.active as number,pending:vaults.pending as number},receipts:{count,jsonUtf8Bytes:original},receiptStorage:{hot:{count:rawCount,jsonUtf8Bytes:rawBytes},pointers:{count:pointerCount,storedUtf8Bytes:pointerBytes},segments:{count:hot.segments+cold.segments,encodedBytes:encoded,decodedBytes:decoded,jsonUtf8Bytes:segmentJson},limits:{...RECEIPT_SEGMENT_LIMITS}},legacyRegistry:{applicable:true,count:hot.legacy+cold.legacy},blockers,
      coldRouting:{epoch:this.#route?.epoch??0,slot:this.#route?.slot??null,hot,cold,currentBytes:current,retainedBytes:physical.retainedBytes,retiredBytes,stagingBytes:physical.retainedBytes-current-retiredBytes,otherSlotBytes:physical.retainedBytes-current,occupiedSlots:physical.occupiedSlots,files:physical.files,slots:physical.slots,
        limits:{slotReserveBytes:COLD_LIMITS.retained,workspaceBytes:COLD_LIMITS.workspace,sharedBytes:COLD_LIMITS.shared,payloadBytes:COLD_LIMITS.payload,slots:4},workspacePeakBytes:Math.max(this.#workspace!.peak,this.#lastWorkspacePeak),usedPages:pageCount-freelistPages,blockers:physical.occupiedSlots===4?['SLOTS_FULL']:[]}});
  }
  inspect(vaultId: string): AnchorRow | null { return this.transaction(tx => tx.row(vaultId)); }
  inspectCapacity():AuthorityCapacity{return this.transaction(tx=>tx.capacity());}
  admitLegacyImport(request:{migrationId:string;head:VaultHead;operationId:string;operatorId:string;attestation:'operator-attested-stopped'}):LegacyAdmissionReceipt{
    id(request.operationId);id(request.migrationId);text(request.operatorId,128);if(request.attestation!=='operator-attested-stopped')fail('LEGACY_ATTESTATION_REQUIRED');
    return this.transaction(tx=>{
      tx.assertActive(request.head);const registered=this.#checkLegacy(request.head,true);if(!registered||registered.migrationId!==request.migrationId)fail('LEGACY_REGISTRY');
      const requestDigest=this.#withJSON({migrationId:request.migrationId,head:request.head,operationId:request.operationId,operatorId:request.operatorId,attestation:request.attestation},sha);
      if(registered.admissionReceipt){if(registered.admissionReceipt.requestDigest!==requestDigest)fail('LEGACY_ADMISSION_CONFLICT');return registered.admissionReceipt;}
      if(registered.admission!=='required')fail('LEGACY_ADMISSION_CONFLICT');
      this.#newMutation();
      const receipt:LegacyAdmissionReceipt={version:1,migrationId:request.migrationId,head:request.head,operationId:request.operationId,
        operatorId:request.operatorId,attestation:request.attestation,requestDigest,latestProven:false,legacyCopiesFenced:false,quotaScope:'this-authority-only'};
      if(this.#version>=5)this.#retainReturn(plainJsonBytes(receipt));
      this.#withJSON({...registered,admission:'admitted',admissionReceipt:receipt},encoded=>this.#db.prepare('UPDATE legacy_imports SET state=? WHERE lineage_id=?').run(encoded,registered.lineageId));return receipt;
    });
  }
  close(): void { if (this.#locked) fail('ANCHOR_BUSY'); if (!this.#closed) { this.#dropCold();this.#db.close(); this.#closed = true; } }
}
