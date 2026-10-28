import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.ts';
import { SCHEMA_V2_ADDITION, SCHEMA_V2_SQL } from './schema-v2.ts';
import { DurableFanout, validateFanoutImage } from './durable-fanout.ts';
import { fail } from './validation.ts';
import { FANOUT_LIMITS } from './fanout-types.ts';
import {MAX_IMAGE} from './durable-codec.ts';
import {freezeCapacity} from './capacity-types.ts';
import type {MemoryImageCapacity} from './capacity-types.ts';

export type MemorySchema = 1 | 2;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function assertSchema(schema:unknown):asserts schema is MemorySchema{if(schema!==1&&schema!==2)fail('UNSUPPORTED_SCHEMA');}
export const schemaSQL=(schema:MemorySchema):string=>{assertSchema(schema);return schema===1?SCHEMA_SQL:SCHEMA_V2_SQL;};
export const schemaHash=(schema:MemorySchema):string=>sha(schemaSQL(schema));
export const actualLayoutHash=(db:DatabaseSync):string=>sha(JSON.stringify(db.prepare(
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()));
const layouts=new Map<MemorySchema,string>();
export function expectedLayoutHash(schema:MemorySchema):string{
  assertSchema(schema);
  let expected=layouts.get(schema);
  if(!expected){const db=new DatabaseSync(':memory:');try{db.exec(schemaSQL(schema));expected=actualLayoutHash(db);layouts.set(schema,expected);}finally{db.close();}}
  return expected;
}
export function assertMemoryLayout(db:DatabaseSync,expected:MemorySchema):void{
  assertSchema(expected);
  if(db.prepare('PRAGMA user_version').get()!.user_version!==expected)fail('UNSUPPORTED_SCHEMA');
  if(!db.prepare("SELECT name FROM sqlite_schema WHERE name='meta' AND type='table'").get())fail('UNKNOWN_DATABASE');
  const ledgerKey=db.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()?.value;
  if(typeof ledgerKey!=='string'||!/^[a-f0-9]{64}$/.test(ledgerKey))fail('DURABLE_LEDGER_KEY');
  const layout=actualLayoutHash(db);
  if(db.prepare("SELECT value FROM meta WHERE key='schema_hash'").get()?.value!==schemaHash(expected)
    ||db.prepare("SELECT value FROM meta WHERE key='layout_hash'").get()?.value!==layout||layout!==expectedLayoutHash(expected))fail('SCHEMA_MISMATCH');
}
export function inspectMemoryDatabase(db:DatabaseSync,expected:MemorySchema):{schema:MemorySchema;revocationHighWater:number}{
  assertMemoryLayout(db,expected);
  if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail('DURABLE_CORRUPT');
  db.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES('integrity-check',1);");
  if(expected===2)validateFanoutImage(db);
  return{schema:expected,revocationHighWater:db.prepare('SELECT coalesce(max(id),0) AS n FROM revocations').get()!.n as number};
}
function openImage(image:Uint8Array):DatabaseSync{
  if(!(image instanceof Uint8Array)||image.length>16*1024*1024)fail('DURABLE_LIMIT');
  const db=new DatabaseSync(':memory:',{allowExtension:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});
  try{db.deserialize(image);return db;}catch(error){db.close();throw error;}
}
/** Disposable inspector, without MemoryStore construction, boot resets or callbacks. */
export function inspectMemoryImage(image:Uint8Array,expected:MemorySchema):{schema:MemorySchema;revocationHighWater:number}{
  assertSchema(expected);
  const db=openImage(image);try{return inspectMemoryDatabase(db,expected);}finally{db.close();}
}
/** Counts retained storage in a disposable validated RAM image, without boot or serialization. */
export function inspectMemoryImageCapacity(image:Uint8Array,expected:MemorySchema):MemoryImageCapacity{
  assertSchema(expected);const db=openImage(image);
  try{
    const checked=inspectMemoryDatabase(db,expected);
    const count=(table:string)=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n as number;
    const rows={meta:count('meta'),scopes:count('scopes'),nodes:count('nodes'),ingress:count('ingress'),dependencies:count('dependencies'),
      jobs:count('jobs'),outbox:count('outbox'),artifacts:count('artifacts'),revocations:count('revocations'),memory_fts:count('memory_fts')};
    const state=expected===2?db.prepare('SELECT head_seq,floor_seq FROM fanout_state WHERE singleton=1').get()!:null;
    return freezeCapacity({...checked,bytes:image.byteLength,limitBytes:MAX_IMAGE,rows,fanout:state?{applicable:true,
      counts:{batches:count('fanout_batches'),items:count('fanout_items'),consumers:count('fanout_consumers'),projectionRows:count('fanout_projection'),
        projectionJsonUtf8Bytes:db.prepare('SELECT coalesce(sum(length(CAST(metadata AS BLOB))),0) AS n FROM fanout_projection').get()!.n as number,
        headSequence:state.head_seq as number,floorSequence:state.floor_seq as number},limits:{...FANOUT_LIMITS}}:{applicable:false,counts:null,limits:null}});
  }finally{db.close();}
}

const REPACK_SOURCE_ID='2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b';
/** This gate belongs only to physical repack. All temporary sorting and VACUUM
 * run after these settings, on this owned disposable unnamed RAM connection. */
export function configureRepackRuntime(db:DatabaseSync):void{
  const runtime=db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS source').get()!;
  const options=new Set(db.prepare('PRAGMA compile_options').all().map(row=>row.compile_options));
  if(runtime.version!=='3.53.0'||runtime.source!==REPACK_SOURCE_ID||!options.has('ENABLE_FTS5')
    ||![1,2,3].some(n=>options.has(`TEMP_STORE=${n}`))||options.has('TEMP_STORE=0')||db.isTransaction)fail('REPACK_RUNTIME');
  db.exec('PRAGMA temp_store=MEMORY; PRAGMA main.journal_mode=MEMORY; PRAGMA cache_spill=OFF;');
  if(db.prepare('PRAGMA temp_store').get()!.temp_store!==2||db.prepare('PRAGMA main.journal_mode').get()!.journal_mode!=='memory'
    ||db.prepare('PRAGMA cache_spill').get()!.cache_spill!==0
    ||db.prepare('PRAGMA database_list').all().some(row=>row.name!=='main'||row.file!==''))fail('REPACK_RUNTIME');
}

/** Logical identity, ordered by explicit business PKs, with type and byte-length
 * framing. FTS rowid and AUTOINCREMENT state are explicitly retained. Implicit
 * rowids of ordinary tables are not application identities. No row arrays. */
export function fingerprintMemoryDatabase(db:DatabaseSync,schema:MemorySchema):string{
  assertMemoryLayout(db,schema);
  const digest=createHash('sha256');
  const field=(tag:string,bytes:Uint8Array)=>{digest.update(tag);const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(bytes.length));digest.update(n);digest.update(bytes);};
  const tables=['meta','scopes','nodes','ingress','dependencies','jobs','outbox','artifacts','revocations',
    ...(schema===2?['fanout_state','fanout_batches','fanout_items','fanout_consumers','fanout_projection','sqlite_sequence']:[]),'memory_fts','memory_fts_config'];
  for(const table of tables){
    const info=db.prepare(`PRAGMA table_info("${table}")`).all();
    const columns=table==='memory_fts'?['rowid','node_id','statement']:info.map(row=>row.name as string);
    const keys=table==='memory_fts'?['rowid']:table==='sqlite_sequence'?['name']:info.filter(row=>(row.pk as number)>0).sort((a,b)=>(a.pk as number)-(b.pk as number)).map(row=>row.name as string);
    if(!columns.length||!keys.length)fail('REPACK_LOGICAL_SCHEMA');
    field('T',Buffer.from(table));for(const column of columns)field('C',Buffer.from(column));
    const query=db.prepare(`SELECT ${columns.map((column,i)=>`typeof("${column}") AS t${i},CASE WHEN typeof("${column}")='text' THEN CAST("${column}" AS BLOB) ELSE "${column}" END AS v${i}`).join(',')} FROM "${table}" ORDER BY ${keys.map(key=>`"${key}"`).join(',')}`);
    query.setReadBigInts(true);
    for(const row of query.iterate()){
      digest.update('R');
      for(let i=0;i<columns.length;i++){
        const type=row[`t${i}`] as string,value=row[`v${i}`];let bytes:Buffer;
        switch(type){
          case 'null':bytes=Buffer.alloc(0);break;
          case 'integer':bytes=Buffer.from(String(value));break;
          case 'real':bytes=Buffer.alloc(8);bytes.writeDoubleBE(value as number);break;
          // Hash the exact stored text bytes, including malformed UTF-8; a JS
          // string conversion could otherwise conflate replacement characters.
          case 'text':bytes=Buffer.from(value as Uint8Array);break;
          case 'blob':bytes=Buffer.from(value as Uint8Array);break;
          default:fail('REPACK_LOGICAL_TYPE');
        }
        try{field(type,bytes);}finally{bytes.fill(0);}
      }
    }
    digest.update('E');
  }
  return digest.digest('hex');
}

/** Physical packing only: no MemoryStore boot, live SQL, data deletion or path.
 * Refuses no benefit before callers create a target or consume an operation ID. */
export function repackMemoryImage(image:Uint8Array,expected:MemorySchema,expectedHighWater?:number):Uint8Array{
  assertSchema(expected);const db=openImage(image);let result:Uint8Array|undefined;
  try{
    configureRepackRuntime(db);
    const before=inspectMemoryDatabase(db,expected),fingerprint=fingerprintMemoryDatabase(db,expected);
    if(expectedHighWater!==undefined&&before.revocationHighWater!==expectedHighWater)fail('ANCHOR_CORRUPT');
    if(db.isTransaction)fail('REPACK_RUNTIME');
    db.exec('VACUUM');
    const after=inspectMemoryDatabase(db,expected);
    if(before.revocationHighWater!==after.revocationHighWater||fingerprint!==fingerprintMemoryDatabase(db,expected))fail('REPACK_LOGICAL_MISMATCH');
    result=db.serialize();
    if(result.length>MAX_IMAGE||result.length>=image.length)fail('REPACK_NO_BENEFIT');
    const accepted=result;result=undefined;return accepted;
  }finally{result?.fill(0);db.close();}
}
export const MEMORY_MIGRATIONS=Object.freeze([{id:'memory-1-to-2',from:1 as const,to:2 as const}]);
/** Atomic migration of a private RAM copy. No source file, image byte, lease,
 * runtime epoch or source ledger is modified by the migration itself. */
export function migrateMemoryImage(image:Uint8Array,from:MemorySchema,to:MemorySchema,minimumWall=0):Uint8Array{
  if(from!==1||to!==2||!Number.isSafeInteger(minimumWall)||minimumWall<0)fail('UNSUPPORTED_MIGRATION');
  const db=openImage(image);
  try{
    inspectMemoryDatabase(db,1);
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec(SCHEMA_V2_ADDITION);
      db.prepare('UPDATE fanout_state SET last_wall=?,next_due=0 WHERE singleton=1').run(minimumWall);
      db.prepare("UPDATE meta SET value=? WHERE key='schema_hash'").run(schemaHash(2));
      db.prepare("UPDATE meta SET value=? WHERE key='layout_hash'").run(expectedLayoutHash(2));
      db.exec('PRAGMA user_version=2; COMMIT');
    }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
    inspectMemoryDatabase(db,2);return db.serialize();
  }finally{db.close();}
}
/** Explicit maintenance of a frozen RAM copy, without booting the source. */
export function maintainFanoutImage(image:Uint8Array,retainBatches:number,resetConsumerIds:string[],minimumWall:number):{
  image:Uint8Array;floor:number;resetConsumers:string[];removed:number;
}{
  const db=openImage(image);
  try{
    inspectMemoryDatabase(db,2);
    const controller=new DurableFanout(db,()=>minimumWall);
    db.exec('BEGIN IMMEDIATE');controller.begin();
    let result:{floor:number;resetConsumers:string[];removed:number};
    try{result=controller.prune(retainBatches,resetConsumerIds);controller.finish(result.removed>0);db.exec('COMMIT');}
    catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{controller.end();}
    const scopes=db.prepare('SELECT count(*) AS n FROM scopes').get()!.n as number;
    if ((db.prepare('SELECT count(*) AS n FROM fanout_batches').get()!.n as number)+(scopes?1:0)>FANOUT_LIMITS.batches
      ||(db.prepare('SELECT count(*) AS n FROM fanout_items').get()!.n as number)+scopes>FANOUT_LIMITS.totalItems)fail('FANOUT_MAINTENANCE_CAPACITY');
    inspectMemoryDatabase(db,2);return{...result,image:db.serialize()};
  }finally{db.close();}
}
