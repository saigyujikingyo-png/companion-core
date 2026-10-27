import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.ts';
import { SCHEMA_V2_ADDITION, SCHEMA_V2_SQL } from './schema-v2.ts';
import { DurableFanout, validateFanoutImage } from './durable-fanout.ts';
import { fail } from './validation.ts';
import { FANOUT_LIMITS } from './fanout-types.ts';

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
