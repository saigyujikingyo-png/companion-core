import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isProxy} from 'node:util/types';
import {id} from './anchored-codec.ts';
import {sha} from './durable-codec.ts';
import {fail} from './validation.ts';
import {closed,json,emptyCounts,ROW_KEYS,ROW_COLUMNS,COLD_TABLE,sqlRows,hashRows,validateDescriptor,validateMoved,validateRequest,validateReceipt,ReceiptKeyReader} from './authority-cold-format.ts';
import type {Counts,Moved,RawRow,Workspace,Release,Descriptor,ColdRequest,ColdReceipt} from './authority-cold-format.ts';

export const SHARD_LIMITS=Object.freeze({part:1048576,current:2097152,intent:8192,manifest:8192,reservation:8192,request:1024,receipt:8192,retained:16777216,files:32,epoch:14,attempts:2,closure:2170880});
export const SHARD_ROOT_SQL='CREATE TABLE authority_shard_root (id INTEGER PRIMARY KEY CHECK(id=1), manifest TEXT NOT NULL, reservation TEXT) STRICT';
export type ShardInput={operationId:string;expectedRouteEpoch:number;expectedManifestDigest:string};
export type ShardRequest={version:2;kind:'authority-permanent-index-archive';operationId:string;expectedRouteEpoch:number;expectedManifestDigest:string;policy:'closed-two-shards-v2'};
export type FileRef={name:string;bytes:number;sha256:string};
export type ShardCurrent={format:'two-shards-v2';codec:'companion-authority-shard-sqlite-v2';partition:'sha256-full-key-bit0';attemptId:string;intent:FileRef;parts:[FileRef,FileRef];counts:Counts};
export type ShardManifest={format:'companion-authority-manifest-v2';version:2;profile:'two-shards-1MiB-v2';authorityId:string;custodyDomain:string;epoch:number;parentManifestDigest:string|null;sourceSnapshotDigest:string;selectionDigest:string|null;current:null|{format:'legacy-v1';descriptor:Descriptor}|ShardCurrent};
export type ShardReceipt={version:2;kind:'authority-permanent-index-archive';operationId:string;requestDigest:string;fromEpoch:number;toEpoch:number;sourceSnapshotDigest:string;selectionDigest:string;moved:Moved;manifest:ShardManifest};
export type ShardMeta={format:'companion-authority-shard-sqlite-v2';version:2;authorityId:string;custodyDomain:string;operationId:string;requestDigest:string;fromEpoch:number;toEpoch:number;partition:0|1;sourceSnapshotDigest:string;selectionDigest:string;counts:Counts};
export type ShardIntent={format:'companion-authority-shard-intent-v2';version:2;attemptId:string;request:ShardRequest;authorityId:string;custodyDomain:string;sourceSnapshotDigest:string;selectionDigest:string;moved:Moved;parts:[FileRef,FileRef];counts:Counts};
export type ShardReservation={format:'companion-authority-publication-v2';version:2;request:ShardRequest;sourceSnapshotDigest:string;baseManifest:ShardManifest;selectionDigest:string;moved:Moved;rootPageCount:number;rootUsedPages:number;activeAttempt:0|1;plans:[ShardCurrent,ShardCurrent]};
export type AnyRequest=ColdRequest|ShardRequest;
export type AnyReceipt=ColdReceipt|ShardReceipt;
export function number(v:unknown,min:number,max:number):asserts v is number{if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>max)fail('ANCHOR_SHARD_FORMAT');}
export function digest(v:unknown):asserts v is string{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail('ANCHOR_SHARD_FORMAT');}
export function normalizeShard(input:unknown):ShardRequest{
 if(!input||typeof input!=='object'||isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('ANCHOR_SHARD_REQUEST');
 const keys=Reflect.ownKeys(input);if(keys.length!==3||!keys.includes('operationId')||!keys.includes('expectedRouteEpoch')||!keys.includes('expectedManifestDigest'))fail('ANCHOR_SHARD_REQUEST');
 const a=Object.getOwnPropertyDescriptor(input,'operationId')!,b=Object.getOwnPropertyDescriptor(input,'expectedRouteEpoch')!,c=Object.getOwnPropertyDescriptor(input,'expectedManifestDigest')!;
 if(!Object.hasOwn(a,'value')||!Object.hasOwn(b,'value')||!Object.hasOwn(c,'value')||typeof a.value!=='string'||!/^ac2-[A-Za-z0-9_-]{1,96}$/.test(a.value))fail('ANCHOR_SHARD_REQUEST');
 id(a.value);number(b.value,0,13);digest(c.value);return{version:2,kind:'authority-permanent-index-archive',operationId:a.value,expectedRouteEpoch:b.value,expectedManifestDigest:c.value,policy:'closed-two-shards-v2'};
}
export function shardRequest(v:unknown):ShardRequest{closed(v,['version','kind','operationId','expectedRouteEpoch','expectedManifestDigest','policy']);const n=normalizeShard({operationId:v.operationId,expectedRouteEpoch:v.expectedRouteEpoch,expectedManifestDigest:v.expectedManifestDigest});if(json(n,1024)!==json(v,1024))fail('ANCHOR_SHARD_FORMAT');return n;}
export function anyRequest(v:any):AnyRequest{return v?.version===2?shardRequest(v):validateRequest(v);}
export function counts(v:unknown):asserts v is Counts{closed(v,['receipts','segments','legacy','operations']);for(const n of Object.values(v))number(n,0,1048576);if(v.segments>128||v.operations>13)fail('ANCHOR_SHARD_FORMAT');}
export function attemptId(v:unknown):asserts v is string{if(typeof v!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))fail('ANCHOR_SHARD_FORMAT');}
export function fileRef(v:unknown,name?:string):asserts v is FileRef{closed(v,['name','bytes','sha256']);if(typeof v.name!=='string'||(name!==undefined&&v.name!==name))fail('ANCHOR_SHARD_FORMAT');number(v.bytes,1,v.name.endsWith('.sqlite')?1048576:8192);if(v.name.endsWith('.sqlite')&&(v.bytes<4096||v.bytes%4096))fail('ANCHOR_SHARD_FORMAT');digest(v.sha256);}
export function names(attempt:string):[string,string,string]{attemptId(attempt);return[`cold-v2-${attempt}.intent.json`,`cold-v2-${attempt}-0.sqlite`,`cold-v2-${attempt}-1.sqlite`];}
export function current(v:unknown):asserts v is ShardCurrent{closed(v,['format','codec','partition','attemptId','intent','parts','counts']);if(v.format!=='two-shards-v2'||v.codec!=='companion-authority-shard-sqlite-v2'||v.partition!=='sha256-full-key-bit0')fail('ANCHOR_SHARD_FORMAT');attemptId(v.attemptId);const n=names(v.attemptId);fileRef(v.intent,n[0]);if(!Array.isArray(v.parts)||v.parts.length!==2)fail('ANCHOR_SHARD_FORMAT');fileRef(v.parts[0],n[1]);fileRef(v.parts[1],n[2]);counts(v.counts);}
export function manifest(v:unknown):asserts v is ShardManifest{
 closed(v,['format','version','profile','authorityId','custodyDomain','epoch','parentManifestDigest','sourceSnapshotDigest','selectionDigest','current']);if(v.format!=='companion-authority-manifest-v2'||v.version!==2||v.profile!=='two-shards-1MiB-v2')fail('ANCHOR_SHARD_FORMAT');id(v.authorityId);id(v.custodyDomain);number(v.epoch,0,14);if(v.parentManifestDigest!==null)digest(v.parentManifestDigest);digest(v.sourceSnapshotDigest);if(v.selectionDigest!==null)digest(v.selectionDigest);
 if(v.current===null){if(v.epoch!==0||v.parentManifestDigest!==null||v.selectionDigest!==null)fail('ANCHOR_SHARD_FORMAT');}else if(v.current?.format==='legacy-v1'){closed(v.current,['format','descriptor']);validateDescriptor(v.current.descriptor);if(v.epoch!==v.current.descriptor.epoch||v.parentManifestDigest!==null||v.selectionDigest!==null)fail('ANCHOR_SHARD_FORMAT');}else{current(v.current);if(v.epoch<1)fail('ANCHOR_SHARD_FORMAT');digest(v.parentManifestDigest);digest(v.selectionDigest);}json(v,8192);
}
export function shardReceipt(v:unknown,r:ShardRequest):asserts v is ShardReceipt{
 closed(v,['version','kind','operationId','requestDigest','fromEpoch','toEpoch','sourceSnapshotDigest','selectionDigest','moved','manifest']);
 if(v.version!==2||v.kind!==r.kind||v.operationId!==r.operationId||v.requestDigest!==sha(json(r,1024))||v.fromEpoch!==r.expectedRouteEpoch||v.toEpoch!==v.fromEpoch+1)fail('ANCHOR_SHARD_FORMAT');
 digest(v.sourceSnapshotDigest);digest(v.selectionDigest);validateMoved(v.moved);manifest(v.manifest);if(v.manifest.epoch!==v.toEpoch||v.manifest.current?.format!=='two-shards-v2')fail('ANCHOR_SHARD_FORMAT');json(v,8192);
}
export function anyReceipt(v:unknown,r:AnyRequest):asserts v is AnyReceipt{if(r.version===1)validateReceipt(v,r);else shardReceipt(v,r);}
export function reservation(v:unknown):asserts v is ShardReservation{
 closed(v,['format','version','request','sourceSnapshotDigest','baseManifest','selectionDigest','moved','rootPageCount','rootUsedPages','activeAttempt','plans']);
 if(v.format!=='companion-authority-publication-v2'||v.version!==2)fail('ANCHOR_SHARD_FORMAT');shardRequest(v.request);digest(v.sourceSnapshotDigest);manifest(v.baseManifest);digest(v.selectionDigest);validateMoved(v.moved);number(v.rootPageCount,1,131072);number(v.rootUsedPages,1,v.rootPageCount);number(v.activeAttempt,0,1);
 if(v.baseManifest.epoch!==v.request.expectedRouteEpoch||sha(json(v.baseManifest,8192))!==v.request.expectedManifestDigest||!Array.isArray(v.plans)||v.plans.length!==2)fail('ANCHOR_SHARD_FORMAT');current(v.plans[0]);current(v.plans[1]);
 if(v.plans[0].attemptId===v.plans[1].attemptId||json(v.plans[0].counts,1024)!==json(v.plans[1].counts,1024)||v.plans[0].parts.some((f:FileRef,i:number)=>f.bytes!==v.plans[1].parts[i].bytes||f.sha256!==v.plans[1].parts[i].sha256))fail('ANCHOR_SHARD_FORMAT');json(v,8192);
}
export function intentFor(r:ShardReservation,index:0|1):ShardIntent{const p=r.plans[index];return{format:'companion-authority-shard-intent-v2',version:2,attemptId:p.attemptId,request:r.request,authorityId:r.baseManifest.authorityId,custodyDomain:r.baseManifest.custodyDomain,sourceSnapshotDigest:r.sourceSnapshotDigest,selectionDigest:r.selectionDigest,moved:r.moved,parts:p.parts,counts:p.counts};}
export function nextManifest(r:ShardReservation):ShardManifest{return{...r.baseManifest,epoch:r.request.expectedRouteEpoch+1,parentManifestDigest:sha(json(r.baseManifest,8192)),sourceSnapshotDigest:r.sourceSnapshotDigest,selectionDigest:r.selectionDigest,current:r.plans[r.activeAttempt]};}
export function receiptFor(r:ShardReservation):ShardReceipt{return{version:2,kind:r.request.kind,operationId:r.request.operationId,requestDigest:sha(json(r.request,1024)),fromEpoch:r.request.expectedRouteEpoch,toEpoch:r.request.expectedRouteEpoch+1,sourceSnapshotDigest:r.sourceSnapshotDigest,selectionDigest:r.selectionDigest,moved:r.moved,manifest:nextManifest(r)};}
export function planned(r:Omit<ShardReservation,'plans'|'activeAttempt'>,parts:readonly Uint8Array[],total:Counts):ShardReservation{
 const plans=[] as ShardCurrent[];
 for(let i=0;i<2;i++){const attempt=randomUUID(),n=names(attempt),p:ShardCurrent={format:'two-shards-v2',codec:'companion-authority-shard-sqlite-v2',partition:'sha256-full-key-bit0',attemptId:attempt,intent:{name:n[0],bytes:1,sha256:'0'.repeat(64)},parts:[{name:n[1],bytes:parts[0]!.byteLength,sha256:sha(parts[0]!)},{name:n[2],bytes:parts[1]!.byteLength,sha256:sha(parts[1]!)}],counts:total};plans.push(p);}
 const result:ShardReservation={...r,activeAttempt:0,plans:plans as [ShardCurrent,ShardCurrent]};
 for(const i of [0,1] as const){const s=json(intentFor(result,i),8192);result.plans[i].intent.bytes=Buffer.byteLength(s);result.plans[i].intent.sha256=sha(s);}reservation(result);return result;
}
export function partition(row:Pick<RawRow,'kind'|'values'>):0|1{const h=hashRows();h.add({kind:row.kind,values:row.values.slice(0,ROW_KEYS[row.kind]),epoch:0});return(Number.parseInt(h.finish().slice(0,2),16)&1) as 0|1;}
export function meta(v:unknown):asserts v is ShardMeta{closed(v,['format','version','authorityId','custodyDomain','operationId','requestDigest','fromEpoch','toEpoch','partition','sourceSnapshotDigest','selectionDigest','counts']);if(v.format!=='companion-authority-shard-sqlite-v2'||v.version!==2)fail('ANCHOR_SHARD_FORMAT');id(v.authorityId);id(v.custodyDomain);if(typeof v.operationId!=='string'||!/^ac2-[A-Za-z0-9_-]{1,96}$/.test(v.operationId))fail('ANCHOR_SHARD_FORMAT');number(v.fromEpoch,0,13);number(v.toEpoch,1,14);number(v.partition,0,1);if(v.toEpoch!==v.fromEpoch+1)fail('ANCHOR_SHARD_FORMAT');digest(v.requestDigest);digest(v.sourceSnapshotDigest);digest(v.selectionDigest);counts(v.counts);}

// Separate versioned codec. v1's schema, epochs, validators and golden bytes are unchanged.
const SQL=[
 'CREATE TABLE cold_meta (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL) STRICT',
 'CREATE TABLE cold_receipts (vault_id TEXT NOT NULL, operation_id TEXT NOT NULL, receipt_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL, PRIMARY KEY(vault_id,operation_id)) STRICT, WITHOUT ROWID',
 'CREATE TABLE cold_segments (segment_id TEXT PRIMARY KEY, request_utf8 BLOB NOT NULL, digest TEXT NOT NULL, decoded_bytes INTEGER NOT NULL, encoded_bytes INTEGER NOT NULL, entry_count INTEGER NOT NULL, json_bytes INTEGER NOT NULL, payload BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID',
 'CREATE TABLE cold_legacy (lineage_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, vault_id TEXT NOT NULL UNIQUE, state_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID',
 'CREATE TABLE cold_operations (operation_id TEXT PRIMARY KEY, request_utf8 BLOB NOT NULL, receipt_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID'];
function runtime(db:DatabaseSync):void{const options=new Set(db.prepare('PRAGMA compile_options').all().map(r=>r.compile_options));if(db.isTransaction||options.has('TEMP_STORE=0')||![1,2,3].some(n=>options.has(`TEMP_STORE=${n}`)))fail('ANCHOR_COLD_RUNTIME');db.exec('PRAGMA temp_store=MEMORY; PRAGMA journal_mode=MEMORY; PRAGMA cache_spill=OFF');const list=db.prepare('PRAGMA database_list').all();if(list.length!==1||list[0]!.name!=='main'||list[0]!.file!==''||db.prepare('PRAGMA temp_store').get()!.temp_store!==2||db.prepare('PRAGMA journal_mode').get()!.journal_mode!=='memory'||db.prepare('PRAGMA cache_spill').get()!.cache_spill!==0)fail('ANCHOR_COLD_RUNTIME');}
function ram():DatabaseSync{const db=new DatabaseSync(':memory:',{allowExtension:false,enableDoubleQuotedStringLiterals:false});try{runtime(db);return db;}catch(e){db.close();throw e;}}
function signature(db:DatabaseSync):string{return JSON.stringify({schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),tables:db.prepare('PRAGMA table_list').all(),details:SQL.map(s=>{const t=s.split(' ')[2]!;return{columns:db.prepare(`PRAGMA table_xinfo('${t}')`).all(),indexes:db.prepare(`PRAGMA index_list('${t}')`).all().map(i=>({row:i,columns:db.prepare(`PRAGMA index_xinfo('${i.name}')`).all()}))};})});}
function layout(db:DatabaseSync,w:Workspace):void{
 const b=db.prepare('SELECT count(*) AS n,max(length(CAST(name AS BLOB))) AS names,max(length(CAST(sql AS BLOB))) AS sql FROM sqlite_schema').get()!;
 if(b.n!==7||(b.names as number)>128||(b.sql as number)>2048)fail('ANCHOR_COLD_LAYOUT');
 const pages=db.prepare('PRAGMA page_count').get()!.page_count as number;if(!Number.isSafeInteger(pages)||pages<1||pages>256)fail('ANCHOR_COLD_LAYOUT');
 for(const x of db.prepare('SELECT type,name,tbl_name,sql,rootpage FROM sqlite_schema').all()){if(typeof x.rootpage!=='number'||x.rootpage<1||x.rootpage>pages)fail('ANCHOR_COLD_LAYOUT');if(x.type==='table'){if(!SQL.includes(x.sql as string)||x.tbl_name!==x.name)fail('ANCHOR_COLD_LAYOUT');}else if(x.type!=='index'||x.tbl_name!=='cold_legacy'||!['sqlite_autoindex_cold_legacy_2','sqlite_autoindex_cold_legacy_3'].includes(x.name as string)||x.sql!==null)fail('ANCHOR_COLD_LAYOUT');}
 if(db.prepare('PRAGMA user_version').get()!.user_version!==2||db.prepare('PRAGMA application_id').get()!.application_id!==1094922546||db.prepare('PRAGMA page_size').get()!.page_size!==4096||db.prepare('PRAGMA freelist_count').get()!.freelist_count!==0||db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum!==0||db.prepare('PRAGMA encoding').get()!.encoding!=='UTF-8')fail('ANCHOR_COLD_LAYOUT');
 const release=w.reserve(131072,'v2 expected layout and signatures');let expected:DatabaseSync|undefined;try{expected=ram();expected.exec(SQL.join(';'));if(signature(expected)!==signature(db))fail('ANCHOR_COLD_LAYOUT');}finally{expected?.close();release();}
}
export class ShardDatabase{
 #db:DatabaseSync;#w:Workspace;#release:Release;#closed=false;readonly meta:ShardMeta;
 private constructor(db:DatabaseSync,w:Workspace,release:Release,m:ShardMeta){this.#db=db;this.#w=w;this.#release=release;this.meta=m;}
 static build(m:ShardMeta,rows:Iterable<RawRow>,w:Workspace):ShardDatabase{
  meta(m);const release=w.reserve(1048576+32768,'v2 builder image and metadata');let db:DatabaseSync|undefined,journal:Release|undefined;
  try{journal=w.reserve(256*4104+131072,'v2 builder worst RAM statement journal');db=ram();db.exec(`PRAGMA page_size=4096; PRAGMA auto_vacuum=0; PRAGMA max_page_count=256; PRAGMA application_id=1094922546; PRAGMA user_version=2; ${SQL.join(';')}`);db.prepare('INSERT INTO cold_meta VALUES (1,?)').run(json(m,8192));
   for(const row of rows){if(row.kind==='V')fail('ANCHOR_SHARD_FORMAT');db.prepare(`INSERT INTO ${COLD_TABLE[row.kind]} VALUES (${row.values.map(()=>'?').join(',')},?)`).run(...row.values,row.epoch);}
   const result=new ShardDatabase(db,w,release,m);db=undefined;try{result.validate();result.#db.enableDefensive(true);result.#db.exec('PRAGMA query_only=ON');return result;}catch(e){result.close();throw e;}
  }catch(e){db?.close();release();throw e;}finally{journal?.();}
 }
 static open(bytes:Uint8Array,w:Workspace):ShardDatabase{
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(b.length<4096||b.length>1048576||b.length%4096||b.subarray(0,16).toString('binary')!=='SQLite format 3\u0000'||b.readUInt16BE(16)!==4096||b.readUInt32BE(28)*4096!==b.length||b.readUInt32BE(32)!==0||b.readUInt32BE(36)!==0)fail('ANCHOR_COLD_HEADER');
  const release=w.reserve(b.length+32768,'v2 opened image and metadata');let db:DatabaseSync|undefined;
  try{db=ram();db.deserialize(b);runtime(db);db.enableDefensive(true);db.exec('PRAGMA query_only=ON');layout(db,w);const bound=db.prepare('SELECT count(*) AS n,max(length(CAST(state AS BLOB))) AS bytes FROM cold_meta').get()!;if(bound.n!==1||typeof bound.bytes!=='number'||bound.bytes>8192)fail('ANCHOR_SHARD_FORMAT');const m=JSON.parse(db.prepare('SELECT state FROM cold_meta WHERE id=1').get()!.state as string);meta(m);const result=new ShardDatabase(db,w,release,m);db=undefined;try{result.validate(true);return result;}catch(e){result.close();throw e;}}catch(e){db?.close();release();throw e;}
 }
 validate(checked=false):void{if(!checked)layout(this.#db,this.#w);const integrity=this.#db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||integrity[0]!.integrity_check!=='ok')fail('ANCHOR_COLD_INTEGRITY');const c=emptyCounts();for(const k of ['R','S','L','M'] as const)for(const r of this.rows(k)){number(r.epoch,1,this.meta.toEpoch);if(partition(r)!==this.meta.partition)fail('ANCHOR_SHARD_PARTITION');c[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[k] as keyof Counts]++;}if(json(c,1024)!==json(this.meta.counts,1024))fail('ANCHOR_COLD_COUNTS');}
 rows(kind:Exclude<RawRow['kind'],'V'>,index?:number,value?:string,secondary?:string):Generator<RawRow>{if(this.#closed)fail('ANCHOR_COLD_CLOSED');return sqlRows(this.#db,kind,COLD_TABLE[kind],true,this.#w,index===undefined?'':`WHERE ${ROW_COLUMNS[kind][index]}=?${secondary===undefined?'':' AND operation_id=?'}`,index===undefined?[]:secondary===undefined?[value!]:[value!,secondary]);}
 receiptReader():ReceiptKeyReader{if(this.#closed)fail('ANCHOR_COLD_CLOSED');return new ReceiptKeyReader(this.#db,true,this.#w);}
 serialize():{bytes:Uint8Array;close:Release}{const n=(this.#db.prepare('PRAGMA page_count').get()!.page_count as number)*4096;if(n>1048576)fail('ANCHOR_COLD_BOUND');const release=this.#w.reserve(n,'v2 serialize');try{const bytes=this.#db.serialize();if(bytes.length!==n)fail('ANCHOR_COLD_BOUND');return{bytes,close:()=>{bytes.fill(0);release();}};}catch(e){release();throw e;}}
 close():void{if(!this.#closed){this.#closed=true;this.#db.close();this.#release();}}
}
