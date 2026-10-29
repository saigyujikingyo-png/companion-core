import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readSafetyV2File} from './safety-v2-file.ts';
import type {VaultIdentity} from './anchored-codec.ts';
import {sha} from './durable-codec.ts';
import {fail} from './validation.ts';
import {SAFETY_SQL,configureSafetyRuntime} from './safety-segment.ts';
import {terminalEligible} from './safety-format.ts';
import type {OrderedSafetyEntry} from './safety-format.ts';
import {SAFETY_V2_PROFILE,safetyWorkspace,safetyPhase,boundedSafetyJSON,validateV2Cold,validateV2Entry,v2Integer,safetyFingerprint} from './safety-v2-format.ts';
import type {SafetyColdV2,Release} from './safety-v2-format.ts';

function ram():DatabaseSync{const db=new DatabaseSync(':memory:',{allowExtension:false,enableDoubleQuotedStringLiterals:false});try{configureSafetyRuntime(db);return db;}catch(e){db.close();throw e;}}
function layout(db:DatabaseSync):string{return JSON.stringify({schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),columns:db.prepare("PRAGMA table_xinfo('entries')").all(),tables:db.prepare('PRAGMA table_list').all(),indexes:db.prepare("PRAGMA index_list('entries')").all().map(r=>({row:r,columns:db.prepare(`PRAGMA index_xinfo('${String(r.name).replaceAll("'","''")}')`).all()}))});}
function validateDB(db:DatabaseSync):void{
 const pages=db.prepare('PRAGMA page_count').get()!.page_count;v2Integer(pages,1,2048);
 if(db.prepare('PRAGMA application_id').get()!.application_id!==0x41454d54||db.prepare('PRAGMA user_version').get()!.user_version!==2||db.prepare('PRAGMA page_size').get()!.page_size!==4096||db.prepare('PRAGMA encoding').get()!.encoding!=='UTF-8'||db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum!==0||db.prepare('PRAGMA freelist_count').get()!.freelist_count!==0)fail('SAFETY_V2_LAYOUT');
 const b=db.prepare('SELECT count(*) AS n,max(length(CAST(sql AS BLOB))) AS bytes FROM sqlite_schema').get()!;if(b.n!==3||typeof b.bytes!=='number'||b.bytes>2048)fail('SAFETY_V2_LAYOUT');
 for(const r of db.prepare('SELECT rootpage FROM sqlite_schema').all())v2Integer(r.rootpage,1,pages);
 safetyPhase(131072,'expected cold layout',()=>{const expected=ram();try{expected.exec(SAFETY_SQL);if(layout(db)!==layout(expected))fail('SAFETY_V2_LAYOUT');}finally{expected.close();}});
 const integrity=db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||integrity[0]!.integrity_check!=='ok')fail('SAFETY_V2_INTEGRITY');
 const bound=db.prepare('SELECT count(*) AS n,max(length(CAST(entry_json AS BLOB))) AS j,max(length(CAST(request_key AS BLOB))) AS k,max(length(CAST(delivery_id AS BLOB))) AS d FROM entries').get()!;v2Integer(bound.n,1,16384);if(typeof bound.j!=='number'||bound.j>8192||bound.k!==64||(bound.d!==null&&(bound.d as number)>512))fail('SAFETY_V2_BOUND');
}
export function safetyV2AAD(identity:VaultIdentity):Buffer{const {safetyCold:_,...context}=identity;return Buffer.from(JSON.stringify(['companion-anchored-vault-v3','safety-cold-v2',context]));}
export class SafetySegmentV2{
 readonly descriptor:SafetyColdV2;#db:DatabaseSync;#closed=false;#release:Release;readonly #context:string;
 private constructor(db:DatabaseSync,d:SafetyColdV2,release:Release,identity:VaultIdentity){this.#db=db;this.descriptor=Object.freeze(structuredClone(d));this.#release=release;this.#context=sha(safetyV2AAD(identity));}
 verifyReuse(bytes:Uint8Array,identity:VaultIdentity):void{if(this.#closed||sha(safetyV2AAD(identity))!==this.#context||JSON.stringify(identity.safetyCold)!==JSON.stringify(this.descriptor)||bytes.length!==this.descriptor.cipherBytes||sha(bytes)!==this.descriptor.cipherDigest)fail('SAFETY_V2_CIPHER');}
 get maxOrdinal():number{if(this.#closed)fail('SAFETY_V2_CLOSED');return this.#db.prepare('SELECT max(ordinal) AS n FROM entries').get()!.n as number;}
 hasOrdinal(ordinal:number):boolean{if(this.#closed)fail('SAFETY_V2_CLOSED');return !!this.#db.prepare('SELECT 1 FROM entries WHERE ordinal=?').get(ordinal);}
 static open(bytes:Uint8Array,identity:VaultIdentity,key:Uint8Array):SafetySegmentV2{
  const d=identity.safetyCold;validateV2Cold(d);if(identity.storageProfile!==SAFETY_V2_PROFILE||bytes.length!==d.cipherBytes||sha(bytes)!==d.cipherDigest)fail('SAFETY_V2_CIPHER');
  const image=safetyWorkspace().reserve(d.plainBytes+65536,'opened cold RAM SQLite');let db:DatabaseSync|undefined;
  try{return safetyPhase(d.plainBytes*3+65536,'cold decrypt input/output and serialization',()=>{let plain:Buffer|undefined;try{
   try{const c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAAD(safetyV2AAD(identity));c.setAuthTag(bytes.subarray(12,28));plain=Buffer.concat([c.update(bytes.subarray(28)),c.final()]);}catch{fail('SAFETY_V2_AUTH');}
   if(plain.length!==d.plainBytes||sha(plain)!==d.plainDigest||plain.subarray(0,16).toString('binary')!=='SQLite format 3\0'||plain.readUInt16BE(16)!==4096||plain.readUInt32BE(28)*4096!==plain.length||plain.readUInt32BE(32)!==0||plain.readUInt32BE(36)!==0)fail('SAFETY_V2_PLAIN');
   db=ram();db.deserialize(plain);configureSafetyRuntime(db);validateDB(db);db.enableDefensive(true);db.exec('PRAGMA query_only=ON');const result=new SafetySegmentV2(db,d,image,identity);db=undefined;try{const stats=result.stats();if(stats.count!==d.entryCount||stats.reserved!==d.reservedCount||stats.unknown!==d.unknownCount||stats.digest!==d.entryDigest)fail('SAFETY_V2_DIGEST');return result;}catch(e){result.close();throw e;}
  }finally{plain?.fill(0);}});}catch(e){db?.close();image();throw e;}
 }
 *rows():Generator<OrderedSafetyEntry>{if(this.#closed)fail('SAFETY_V2_CLOSED');let previous=-1;const cursor=this.#db.prepare('SELECT ordinal,CAST(request_key AS BLOB) AS k,CAST(delivery_id AS BLOB) AS d,CAST(entry_json AS BLOB) AS j FROM entries ORDER BY ordinal').iterate();
  try{for(;;){const release=safetyWorkspace().reserve(8192*8+2048,'cold row bytes UTF8 parsed and canonical comparison');try{const next=cursor.next();if(next.done)break;const r=next.value;v2Integer(r.ordinal,0,16383);if(r.ordinal<=previous)fail('SAFETY_V2_ORDINAL');previous=r.ordinal;const bytes=r.j as Uint8Array;if(bytes.length>8192)fail('SAFETY_V2_BOUND');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),entry=JSON.parse(text);validateV2Entry(entry);if(boundedSafetyJSON(entry,8192)!==text||Buffer.from(r.k as Uint8Array).toString('utf8')!==entry.key||(r.d===null?null:new TextDecoder('utf-8',{fatal:true}).decode(r.d as Uint8Array))!==entry.deliveryId||!terminalEligible(entry))fail('SAFETY_V2_INDEX');yield{ordinal:r.ordinal,entry};}finally{release();}}}finally{cursor.return?.();}
 }
 stats():{count:number;reserved:number;unknown:number;digest:string}{let count=0,reserved=0,unknown=0;const hash=safetyFingerprint();for(const r of this.rows()){count++;if(count>16384)fail('SAFETY_V2_BOUND');reserved+=Number(r.entry.reserved);unknown+=Number(r.entry.state==='unknown');hash.row(r);}return{count,reserved,unknown,digest:hash.finish()};}
 #lookup(column:'request_key'|'delivery_id',key:string):OrderedSafetyEntry|undefined{if(this.#closed)fail('SAFETY_V2_CLOSED');return safetyPhase(8192*8+2048,'cold exact lookup',()=>{const r=this.#db.prepare(`SELECT ordinal,entry_json FROM entries WHERE ${column}=?`).get(key);if(!r)return;const entry=JSON.parse(r.entry_json as string);validateV2Entry(entry);return{ordinal:r.ordinal as number,entry};});}
 lookupRequest(key:string):OrderedSafetyEntry|undefined{return this.#lookup('request_key',key);}
 lookupDelivery(key:string):OrderedSafetyEntry|undefined{return this.#lookup('delivery_id',key);}
 close():void{if(!this.#closed){this.#closed=true;try{this.#db.close();}finally{this.#release();}}}
}
export function sealSafetyV2(rows:Iterable<OrderedSafetyEntry>,identity:VaultIdentity,key:Uint8Array):{descriptor:SafetyColdV2;bytes:Buffer}{
 if(identity.storageProfile!==SAFETY_V2_PROFILE)fail('SAFETY_V2_PROFILE');const owner=safetyWorkspace().reserve(8388608+65536,'cold builder RAM image');let journal:Release=()=>{},serialized:Release=()=>{},db:DatabaseSync|undefined,plain:Uint8Array|undefined;
 try{journal=safetyWorkspace().reserve(2048*4104+131072,'cold worst RAM journal');db=ram();db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=2048; PRAGMA application_id=${0x41454d54}; PRAGMA user_version=2; ${SAFETY_SQL}; BEGIN`);const hash=safetyFingerprint();let count=0,reserved=0,unknown=0,last=-1;
  const insert=db.prepare('INSERT INTO entries VALUES (?,?,?,?)');for(const row of rows){v2Integer(row.ordinal,0,16383);validateV2Entry(row.entry);if(row.ordinal<=last||!terminalEligible(row.entry)||++count>16384)fail('SAFETY_V2_ORDINAL');last=row.ordinal;hash.row(row);reserved+=Number(row.entry.reserved);unknown+=Number(row.entry.state==='unknown');insert.run(row.entry.key,row.ordinal,row.entry.deliveryId,boundedSafetyJSON(row.entry,8192));}
  if(!count)fail('SAFETY_V2_EMPTY');db.exec('COMMIT');journal();validateDB(db);const size=(db.prepare('PRAGMA page_count').get()!.page_count as number)*4096;serialized=safetyWorkspace().reserve(size,'serialized cold output');plain=db.serialize();db.close();db=undefined;owner();
  if(plain.length!==size)fail('SAFETY_V2_BOUND');const plainDigest=sha(plain);return safetyPhase(size*3+65536,'cold encrypt buffers',()=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(safetyV2AAD(identity));
   const body=Buffer.concat([c.update(plain!),c.final()]),sealed=Buffer.concat([iv,c.getAuthTag(),body]);safetyWorkspace().reserve(sealed.length,'retained cold ciphertext');const cipherDigest=sha(sealed),descriptor:SafetyColdV2={version:2,format:'aemc-safety-sqlite-v2',file:`safety-${cipherDigest}.bin`,cipherDigest,cipherBytes:sealed.length,plainDigest,plainBytes:size,entryDigest:hash.finish(),entryCount:count,reservedCount:reserved,unknownCount:unknown};validateV2Cold(descriptor);return{descriptor,bytes:sealed};});
 }finally{plain?.fill(0);serialized();db?.close();journal();owner();}
}
export function assertSafetyV2Closure(identity:VaultIdentity):void{if(identity.storageProfile!==SAFETY_V2_PROFILE)return;const d=identity.safetyCold;if(d===null)return;validateV2Cold(d);safetyPhase(d.cipherBytes+65536,'required current cold ciphertext',()=>{const bytes=readSafetyV2File(join(identity.directory,d.file),d.cipherBytes);try{if(bytes.length!==d.cipherBytes||sha(bytes)!==d.cipherDigest)fail('SAFETY_V2_CIPHER');}finally{bytes.fill(0);}});}
