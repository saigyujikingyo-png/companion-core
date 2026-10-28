import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readBounded} from './anchored-codec.ts';
import type {VaultIdentity} from './anchored-codec.ts';
import {sha} from './durable-codec.ts';
import {fail} from './validation.ts';
import {COLD_SAFETY_PROFILE,isColdSafetyProfile,MAX_COLD_PLAIN,canonicalSafetyJSON,terminalEligible,validateColdDescriptor} from './safety-format.ts';
import type {OrderedSafetyEntry,SafetyColdDescriptor} from './safety-format.ts';

export const SAFETY_SQL="CREATE TABLE entries (request_key TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, delivery_id TEXT UNIQUE, entry_json TEXT NOT NULL) STRICT, WITHOUT ROWID";
const APP_ID=0x41454d53;
const decodeText=(bytes:Uint8Array):string=>{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('SAFETY_COLD_UTF8');}};
function ram():DatabaseSync{
  const db=new DatabaseSync(':memory:',{allowExtension:false});
  try{configureSafetyRuntime(db);return db;}catch(error){db.close();throw error;}
}
/** Only the cold segment's ordinary SQLite operations: no VACUUM or FTS.
 * The owner constructs an unnamed database with extensions disabled. Recheck
 * its effective temporary-storage configuration before DDL/import and after import. */
export function configureSafetyRuntime(db:DatabaseSync):void{
  const unnamed=()=>{const list=db.prepare('PRAGMA database_list').all();return list.length===1&&list[0]!.name==='main'&&list[0]!.file==='';};
  if(db.isTransaction||!unnamed())fail('SAFETY_COLD_RUNTIME');
  const options=new Set(db.prepare('PRAGMA compile_options').all().map(row=>row.compile_options));
  if(options.has('TEMP_STORE=0')||![1,2,3].some(n=>options.has(`TEMP_STORE=${n}`)))fail('SAFETY_COLD_RUNTIME');
  db.exec('PRAGMA temp_store=MEMORY; PRAGMA main.journal_mode=MEMORY; PRAGMA cache_spill=OFF;');
  if(db.isTransaction||!unnamed()||db.prepare('PRAGMA temp_store').get()!.temp_store!==2
    ||db.prepare('PRAGMA main.journal_mode').get()!.journal_mode!=='memory'||db.prepare('PRAGMA cache_spill').get()!.cache_spill!==0)fail('SAFETY_COLD_RUNTIME');
}
function layout(db:DatabaseSync):string{
  return JSON.stringify({schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),
    columns:db.prepare("PRAGMA table_xinfo('entries')").all(),tables:db.prepare('PRAGMA main.table_list').all(),
    indexes:db.prepare("PRAGMA index_list('entries')").all().map(row=>({row,columns:db.prepare(`PRAGMA index_xinfo('${String(row.name).replaceAll("'","''")}')`).all()}))});
}
let expectedLayout:string|undefined;
function fixedLayout():string{
  if(expectedLayout===undefined){const db=ram();try{db.exec(SAFETY_SQL);expectedLayout=layout(db);}finally{db.close();}}
  return expectedLayout;
}
function validateRows(rows:OrderedSafetyEntry[]):void{
  if(rows.length<1||rows.length>8192)fail('SAFETY_COLD_ROWS');
  const keys=new Set<string>(),deliveries=new Set<string>();let last=-1;
  for(const {ordinal,entry} of rows){
    if(!Number.isSafeInteger(ordinal)||ordinal<=last||ordinal>=8192||!terminalEligible(entry)||typeof entry.reserved!=='boolean'
      ||typeof entry.feedbackConsumed!=='boolean'||! /^[a-f0-9]{64}$/.test(entry.key)||! /^[a-f0-9]{64}$/.test(entry.fingerprint)||keys.has(entry.key)
      ||(entry.deliveryId!==null&&(typeof entry.deliveryId!=='string'||entry.deliveryId.length>128||deliveries.has(entry.deliveryId)))
      ||(entry.state==='acknowledged'&&entry.deliveryId===null))fail('SAFETY_COLD_ROWS');
    canonicalSafetyJSON(entry);keys.add(entry.key);if(entry.deliveryId!==null)deliveries.add(entry.deliveryId);last=ordinal;
  }
}
function rowsFrom(db:DatabaseSync):OrderedSafetyEntry[]{
  const result:OrderedSafetyEntry[]=[];
  for(const row of db.prepare('SELECT CAST(request_key AS BLOB) AS k,ordinal,CAST(delivery_id AS BLOB) AS d,CAST(entry_json AS BLOB) AS j FROM entries ORDER BY ordinal').iterate()){
    if(result.length>=8192)fail('SAFETY_COLD_ROWS');
    const json=decodeText(row.j as Uint8Array);let entry:any;
    try{entry=JSON.parse(json);}catch{fail('SAFETY_COLD_JSON');}
    if(canonicalSafetyJSON(entry)!==json||entry.key!==decodeText(row.k as Uint8Array)||entry.deliveryId!==(row.d===null?null:decodeText(row.d as Uint8Array)))fail('SAFETY_COLD_INDEX');
    result.push({ordinal:row.ordinal as number,entry});
  }
  validateRows(result);return result;
}
function assertDatabase(db:DatabaseSync):OrderedSafetyEntry[]{
  if(db.prepare('PRAGMA application_id').get()!.application_id!==APP_ID||db.prepare('PRAGMA user_version').get()!.user_version!==1
    ||db.prepare('PRAGMA page_size').get()!.page_size!==4096||layout(db)!==fixedLayout())fail('SAFETY_COLD_LAYOUT');
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||integrity[0]!.integrity_check!=='ok')fail('SAFETY_COLD_INTEGRITY');
  return rowsFrom(db);
}
export function coldAAD(identity:VaultIdentity):Buffer{
  return Buffer.from(JSON.stringify(['companion-anchored-vault-v3','safety-cold-v1',{
    authorityId:identity.authorityId,vaultId:identity.vaultId,identity:identity.identity,instanceId:identity.instanceId,ownerEpoch:identity.ownerEpoch,keyEpoch:identity.keyEpoch,
    directory:identity.directory,storageDomain:identity.storageDomain,schemaVersion:identity.schemaVersion??1,storageProfile:identity.storageProfile,legacyImport:identity.legacyImport??null}]));
}
export function sealSafetySegment(rows:OrderedSafetyEntry[],identity:VaultIdentity,key:Uint8Array):{descriptor:SafetyColdDescriptor;bytes:Buffer}{
  if(!isColdSafetyProfile(identity.storageProfile))fail('SAFETY_COLD_PROFILE');validateRows(rows);
  const db=ram();let plain:Uint8Array|undefined;
  try{
    db.exec(`PRAGMA page_size=4096; PRAGMA application_id=${APP_ID}; PRAGMA user_version=1; ${SAFETY_SQL}; BEGIN`);
    const insert=db.prepare('INSERT INTO entries VALUES (?,?,?,?)');
    for(const row of rows)insert.run(row.entry.key,row.ordinal,row.entry.deliveryId,canonicalSafetyJSON(row.entry));
    db.exec('COMMIT');const checked=assertDatabase(db);
    if(canonicalSafetyJSON(checked)!==canonicalSafetyJSON(rows))fail('SAFETY_COLD_ROWS');
    plain=db.serialize();if(plain.length>MAX_COLD_PLAIN||plain.length%4096!==0)fail('SAFETY_COLD_LIMIT');
    db.exec('PRAGMA query_only=ON');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(coldAAD(identity));
    const body=Buffer.concat([cipher.update(plain),cipher.final()]),bytes=Buffer.concat([iv,cipher.getAuthTag(),body]),cipherDigest=sha(bytes);
    const descriptor:SafetyColdDescriptor={version:1,format:'aemc-safety-sqlite-v1',file:`safety-${cipherDigest}.bin`,cipherDigest,cipherBytes:bytes.length,
      plainDigest:sha(plain),plainBytes:plain.length,entryDigest:sha(canonicalSafetyJSON(rows)),entryCount:rows.length,
      reservedCount:rows.filter(r=>r.entry.reserved).length,unknownCount:rows.filter(r=>r.entry.state==='unknown').length};
    validateColdDescriptor(descriptor);return{descriptor,bytes};
  }finally{plain?.fill(0);db.close();}
}
/** Owns an unnamed, query-only RAM database. No caller can mutate its rows. */
export class SafetySegment{
  #db:DatabaseSync;#closed=false;readonly descriptor:SafetyColdDescriptor;
  private constructor(db:DatabaseSync,descriptor:SafetyColdDescriptor){this.#db=db;this.descriptor=structuredClone(descriptor);}
  static open(bytes:Uint8Array,identity:VaultIdentity,key:Uint8Array):SafetySegment{
    const d=identity.safetyCold;if(!isColdSafetyProfile(identity.storageProfile)||!d)fail('SAFETY_COLD_PROFILE');validateColdDescriptor(d);
    if(bytes.length!==d.cipherBytes||sha(bytes)!==d.cipherDigest)fail('SAFETY_COLD_CIPHER');
    let plain:Buffer|undefined,db:DatabaseSync|undefined;
    try{
      try{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(coldAAD(identity));cipher.setAuthTag(bytes.subarray(12,28));
        plain=Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]);}catch{fail('SAFETY_COLD_AUTH');}
      if(plain.length!==d.plainBytes||sha(plain)!==d.plainDigest||plain.subarray(0,16).toString('binary')!=='SQLite format 3\u0000'
        ||plain.readUInt16BE(16)!==4096||plain.readUInt32BE(28)*4096!==plain.length||plain.readUInt32BE(56)!==1)fail('SAFETY_COLD_PLAIN');
      db=ram();db.deserialize(plain);configureSafetyRuntime(db);const rows=assertDatabase(db);
      if(rows.length!==d.entryCount||rows.filter(r=>r.entry.reserved).length!==d.reservedCount||rows.filter(r=>r.entry.state==='unknown').length!==d.unknownCount
        ||sha(canonicalSafetyJSON(rows))!==d.entryDigest)fail('SAFETY_COLD_DIGEST');
      db.exec('PRAGMA query_only=ON');if(db.prepare('PRAGMA query_only').get()!.query_only!==1)fail('SAFETY_COLD_RUNTIME');
      const result=new SafetySegment(db,d);db=undefined;return result;
    }finally{plain?.fill(0);db?.close();}
  }
  rows():OrderedSafetyEntry[]{if(this.#closed)fail('SAFETY_COLD_CLOSED');return rowsFrom(this.#db);}
  lookupRequest(key:string):OrderedSafetyEntry|undefined{return this.#lookup('request_key',key);}
  lookupDelivery(id:string):OrderedSafetyEntry|undefined{return this.#lookup('delivery_id',id);}
  #lookup(column:'request_key'|'delivery_id',value:string):OrderedSafetyEntry|undefined{
    if(this.#closed)fail('SAFETY_COLD_CLOSED');const row=this.#db.prepare(`SELECT ordinal,entry_json FROM entries WHERE ${column}=?`).get(value);
    return row?{ordinal:row.ordinal as number,entry:JSON.parse(row.entry_json as string)}:undefined;
  }
  close():void{if(!this.#closed){this.#closed=true;this.#db.close();}}
}
export function assertColdClosure(identity:VaultIdentity,reader:(name:string,maximum:number)=>Buffer=(name,max)=>readBounded(join(identity.directory,name),max)):void{
  if(!isColdSafetyProfile(identity.storageProfile))return;
  const d=identity.safetyCold;if(d===null)return;validateColdDescriptor(d);
  const bytes=reader(d.file,d.cipherBytes);if(bytes.length!==d.cipherBytes||sha(bytes)!==d.cipherDigest)fail('SAFETY_COLD_CIPHER');
}
