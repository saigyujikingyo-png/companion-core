import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import {join} from 'node:path';
import {readBounded} from './anchored-codec.ts';
import type {VaultIdentity} from './anchored-codec.ts';
import {MAX_IMAGE,sha} from './durable-codec.ts';
import {assertMemoryLayout,fingerprintMemoryDatabase,inspectMemoryDatabase,schemaSQL} from './memory-image.ts';
import type {MemorySchema} from './memory-image.ts';
import {fail} from './validation.ts';
import {MAX_STORE_COLD,STORE_COLD_PROFILE,validateStoreColdDescriptor} from './store-cold-format.ts';
import type {StoreColdDescriptor} from './store-cold-format.ts';

const COLD_TABLES=['nodes','ingress','dependencies'] as const;
type ColdTable=typeof COLD_TABLES[number];
type Cell={type:string;value:SQLInputValue};
type RawRow=Cell[];
type Table={name:string;columns:string[];keys:number[]};
const APP_ID=0x41454d54;
function ram():DatabaseSync{
  const db=new DatabaseSync(':memory:',{allowExtension:false,enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false});
  try{configureStoreMirrorRuntime(db);return db;}catch(error){db.close();throw error;}
}
/** Ordinary schema/row copying and FTS inserts only; no VACUUM, file path or boot. */
export function configureStoreMirrorRuntime(db:DatabaseSync):void{
  const unnamed=()=>{const rows=db.prepare('PRAGMA database_list').all();return rows.length===1&&rows[0]!.name==='main'&&rows[0]!.file==='';};
  const options=new Set(db.prepare('PRAGMA compile_options').all().map(r=>r.compile_options));
  if(db.isTransaction||!unnamed()||options.has('TEMP_STORE=0')||![1,2,3].some(n=>options.has(`TEMP_STORE=${n}`))||!options.has('ENABLE_FTS5'))fail('STORE_COLD_RUNTIME');
  db.exec('PRAGMA temp_store=MEMORY; PRAGMA main.journal_mode=MEMORY; PRAGMA cache_spill=OFF;');
  if(!unnamed()||db.prepare('PRAGMA temp_store').get()!.temp_store!==2||db.prepare('PRAGMA main.journal_mode').get()!.journal_mode!=='memory'
    ||db.prepare('PRAGMA cache_spill').get()!.cache_spill!==0)fail('STORE_COLD_RUNTIME');
}
function open(image:Uint8Array,limit=MAX_IMAGE):DatabaseSync{
  if(!(image instanceof Uint8Array)||image.length<4096||image.length>limit)fail('STORE_COLD_LIMIT');
  const db=ram();try{db.deserialize(image);configureStoreMirrorRuntime(db);return db;}catch(error){db.close();throw error;}
}
/** Bound each owned copy target before schema/row insertion. This is an SQLite
 * image extent bound, not a bound on total SQLite working memory or process RSS. */
function boundTarget(db:DatabaseSync,limit:number):void{
  db.exec('PRAGMA page_size=4096');
  const pageSize=db.prepare('PRAGMA page_size').get()!.page_size;
  if(pageSize!==4096||limit%pageSize!==0)fail('STORE_COLD_RUNTIME');
  db.exec(`PRAGMA max_page_count=${limit/pageSize}`);
  if(db.prepare('PRAGMA max_page_count').get()!.max_page_count!==limit/pageSize)fail('STORE_COLD_RUNTIME');
  checkExtent(db,limit);
}
function checkExtent(db:DatabaseSync,limit:number):void{
  const pageSize=db.prepare('PRAGMA page_size').get()!.page_size,pageCount=db.prepare('PRAGMA page_count').get()!.page_count;
  if(pageSize!==4096||typeof pageCount!=='number'||!Number.isSafeInteger(pageCount)||pageCount<0||pageCount>limit/pageSize)fail('STORE_COLD_LIMIT');
}
function boundedSerialize(db:DatabaseSync,limit:number):Buffer{
  checkExtent(db,limit); // Must precede serialize(), which allocates the entire image.
  const image=Buffer.from(db.serialize());if(image.length>limit){image.fill(0);fail('STORE_COLD_LIMIT');}return image;
}
function limitFailure(error:unknown):never{
  if(error instanceof Error&&'errcode' in error&&typeof error.errcode==='number'&&(error.errcode&255)===13)fail('STORE_COLD_LIMIT');
  throw error;
}
function table(db:DatabaseSync,name:string):Table{
  if(name==='memory_fts')return{name,columns:['rowid','node_id','statement'],keys:[0]};
  const info=db.prepare(`PRAGMA table_info("${name}")`).all(),columns=info.map(r=>r.name as string);
  const keys=name==='sqlite_sequence'?[0]:info.filter(r=>(r.pk as number)>0).sort((a,b)=>(a.pk as number)-(b.pk as number)).map(r=>columns.indexOf(r.name as string));
  if(!columns.length||!keys.length)fail('STORE_COLD_LAYOUT');return{name,columns,keys};
}
function query(t:Table):string{return `SELECT ${t.columns.map((c,i)=>`typeof("${c}") AS t${i},CASE WHEN typeof("${c}")='text' THEN CAST("${c}" AS BLOB) ELSE "${c}" END AS v${i}`).join(',')} FROM "${t.name}"`;}
function raw(row:Record<string,unknown>,t:Table):RawRow{return t.columns.map((_,i)=>({type:row[`t${i}`] as string,value:row[`v${i}`] as SQLInputValue}));}
function* rows(db:DatabaseSync,t:Table):Generator<RawRow>{const stmt=db.prepare(`${query(t)} ORDER BY ${t.keys.map(i=>`"${t.columns[i]}"`).join(',')}`);stmt.setReadBigInts(true);for(const row of stmt.iterate())yield raw(row,t);}
function framed(row:RawRow):string{return JSON.stringify(row.map(c=>[c.type,c.type==='text'||c.type==='blob'?Buffer.from(c.value as Uint8Array).toString('base64'):c.type==='real'?(()=>{const b=Buffer.alloc(8);b.writeDoubleBE(c.value as number);return b.toString('hex');})():String(c.value)]));}
const rowKey=(row:RawRow,t:Table)=>framed(t.keys.map(i=>row[i]!));
function insert(db:DatabaseSync,t:Table,row:RawRow):void{
  db.prepare(`INSERT INTO "${t.name}" (${t.columns.map(c=>`"${c}"`).join(',')}) VALUES (${row.map(c=>c.type==='text'?'CAST(? AS TEXT)':'?').join(',')})`).run(...row.map(c=>c.value));
}
const tables=(schema:MemorySchema)=>['meta','scopes','nodes','ingress','dependencies','jobs','outbox','artifacts','revocations',
  ...(schema===2?['fanout_state','fanout_batches','fanout_items','fanout_consumers','fanout_projection','sqlite_sequence']:[]),'memory_fts','memory_fts_config'];
function empty(schema:MemorySchema):{db:DatabaseSync;triggers:string[]}{
  const db=ram();try{
    boundTarget(db,MAX_IMAGE);db.exec(`${schemaSQL(schema)} PRAGMA user_version=${schema};`);
    // Only this newly created disposable target may copy the exact FTS config.
    db.enableDefensive(false);
    const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
    for(const trigger of triggers)db.exec(`DROP TRIGGER "${trigger.name}"`);
    db.exec('DELETE FROM memory_fts_config;');if(schema===2)db.exec('DELETE FROM fanout_state; DELETE FROM sqlite_sequence;');
    return{db,triggers:triggers.map(t=>t.sql as string)};
  }catch(error){db.close();throw error;}
}
let coldSQL:string|undefined,coldLayout:string|undefined;
function layout(db:DatabaseSync):string{return JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all());}
function coldTemplate():string{
  if(coldSQL===undefined){const {db}=empty(1);try{coldSQL=COLD_TABLES.map(name=>db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name)!.sql as string).join(';');}finally{db.close();}}
  return coldSQL;
}
function emptyCold():DatabaseSync{const db=ram();try{boundTarget(db,MAX_STORE_COLD);db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1; ${coldTemplate()}`);return db;}catch(error){db.close();throw error;}}
function checkCold(db:DatabaseSync):StoreColdDescriptor['counts']{
  if(coldLayout===undefined){const template=emptyCold();try{coldLayout=layout(template);}finally{template.close();}}
  if(layout(db)!==coldLayout||db.prepare('PRAGMA application_id').get()!.application_id!==APP_ID||db.prepare('PRAGMA user_version').get()!.user_version!==1
    ||db.prepare('PRAGMA page_size').get()!.page_size!==4096||db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')fail('STORE_COLD_LAYOUT');
  const count=(name:ColdTable)=>db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n as number;
  const counts={nodes:count('nodes'),ingress:count('ingress'),dependencies:count('dependencies')};
  if(!counts.nodes||db.prepare("SELECT 1 FROM nodes WHERE status!='revoked' OR body IS NOT NULL OR search_text!='' OR projection_visible!=0 LIMIT 1").get()
    ||db.prepare('SELECT 1 FROM ingress i LEFT JOIN nodes n ON i.node_id=n.id WHERE n.id IS NULL LIMIT 1').get()
    ||db.prepare('SELECT 1 FROM dependencies d LEFT JOIN nodes n ON d.child_id=n.id LEFT JOIN nodes p ON d.parent_id=p.id WHERE n.id IS NULL OR p.id IS NULL OR n.scope_id!=p.scope_id OR n.generation!=p.generation LIMIT 1').get())fail('STORE_COLD_ROWS');
  return counts;
}
function coldKeys(cold:DatabaseSync|undefined):Map<string,Set<string>>{
  const result=new Map<string,Set<string>>();if(cold)for(const name of COLD_TABLES){const t=table(cold,name);result.set(name,new Set([...rows(cold,t)].map(row=>rowKey(row,t))));}return result;
}
function assertRows(full:DatabaseSync,cold:DatabaseSync):void{
  checkCold(cold);
  for(const name of COLD_TABLES){const t=table(cold,name);
    for(const row of rows(cold,t)){
      const key=t.keys.map(i=>row[i]!),stmt=full.prepare(`${query(t)} WHERE ${t.keys.map((i,j)=>`"${t.columns[i]}" IS ${key[j]!.type==='text'?'CAST(? AS TEXT)':'?'}`).join(' AND ')}`);stmt.setReadBigInts(true);
      const found=stmt.get(...key.map(c=>c.value));if(!found||framed(raw(found,t))!==framed(row))fail('STORE_COLD_IMMUTABLE');
    }
  }
  // Current scopes and FTS remain hot. Cold nodes must still be strictly old and erased.
  const nodes=table(cold,'nodes');for(const row of rows(cold,nodes)){
    const id=row[0]!.value,scope=row[1]!.value,generation=row[4]!.value;
    const stmt=full.prepare('SELECT generation FROM scopes WHERE id=CAST(? AS TEXT)');stmt.setReadBigInts(true);const current=stmt.get(scope);
    if(!current||(current.generation as bigint)<=(generation as bigint)||full.prepare('SELECT 1 FROM memory_fts WHERE node_id=CAST(? AS TEXT)').get(id))fail('STORE_COLD_ROWS');
  }
}
function rebuild(source:DatabaseSync,schema:MemorySchema,cold?:DatabaseSync,omit=false):Buffer{
  const target=empty(schema),keys=omit?coldKeys(cold):new Map<string,Set<string>>();
  try{
    target.db.exec('BEGIN');
    for(const name of tables(schema)){
      if(name==='sqlite_sequence')target.db.exec('DELETE FROM sqlite_sequence');
      const t=table(source,name);for(const row of rows(source,t))if(!keys.get(name)?.has(rowKey(row,t)))insert(target.db,t,row);
      if(!omit&&cold&&COLD_TABLES.includes(name as ColdTable))for(const row of rows(cold,t))insert(target.db,t,row);
    }
    for(const trigger of target.triggers)target.db.exec(trigger);
    target.db.exec('COMMIT; PRAGMA foreign_keys=ON');target.db.enableDefensive(true);assertMemoryLayout(target.db,schema);
    return boundedSerialize(target.db,MAX_IMAGE);
  }catch(error){return limitFailure(error);}finally{target.db.close();}
}
export function storeLogicalFingerprint(image:Uint8Array,schema:MemorySchema):string{
  const db=open(image);try{inspectMemoryDatabase(db,schema);return fingerprintMemoryDatabase(db,schema);}finally{db.close();}
}
export function joinStoreImage(hot:Uint8Array,schema:MemorySchema,cold:StoreColdSegment|undefined,fingerprint:string):Buffer{
  const db=open(hot);let image:Buffer|undefined;
  try{assertMemoryLayout(db,schema);image=rebuild(db,schema,cold?.database);const full=open(image);
    try{inspectMemoryDatabase(full,schema);if(cold)assertRows(full,cold.database);if(fingerprintMemoryDatabase(full,schema)!==fingerprint)fail('STORE_LOGICAL_MISMATCH');}finally{full.close();}
    const result=image;image=undefined;return result;
  }finally{db.close();image?.fill(0);}
}
export function splitStoreImage(image:Uint8Array,schema:MemorySchema,cold?:StoreColdSegment):{image:Buffer;fingerprint:string}{
  const db=open(image);let hot:Buffer|undefined;
  try{inspectMemoryDatabase(db,schema);if(cold)assertRows(db,cold.database);const fingerprint=fingerprintMemoryDatabase(db,schema);
    hot=rebuild(db,schema,cold?.database,true);const joined=joinStoreImage(hot,schema,cold,fingerprint);joined.fill(0);
    const result={image:hot,fingerprint};hot=undefined;return result;
  }finally{db.close();hot?.fill(0);}
}
/** One deterministic complete generation; never selects a later candidate on overflow. */
export function selectStoreCold(image:Uint8Array,schema:MemorySchema,previous?:StoreColdSegment):Buffer{
  const full=open(image),cold=emptyCold();
  try{
    inspectMemoryDatabase(full,schema);if(previous)assertRows(full,previous.database);
    const known=coldKeys(previous?.database).get('nodes')??new Set<string>(),nt=table(full,'nodes');
    const candidateQuery=full.prepare(`SELECT CAST(n.scope_id AS BLOB) AS scope_id,n.generation FROM nodes n JOIN scopes s ON s.id=n.scope_id WHERE n.generation<s.generation
      GROUP BY n.scope_id,n.generation HAVING sum(CASE WHEN n.status='revoked' AND n.body IS NULL AND n.search_text='' AND n.projection_visible=0
      AND NOT EXISTS(SELECT 1 FROM memory_fts f WHERE f.node_id=n.id) THEN 0 ELSE 1 END)=0 ORDER BY n.scope_id COLLATE BINARY,n.generation`);candidateQuery.setReadBigInts(true);
    let selected:Set<string>|undefined;
    for(const candidate of candidateQuery.iterate()){
      const ids=new Set<string>();const stmt=full.prepare(`${query(nt)} WHERE scope_id=CAST(? AS TEXT) AND generation=?`);stmt.setReadBigInts(true);
      for(const row of stmt.iterate(candidate.scope_id as SQLInputValue,candidate.generation as SQLInputValue))ids.add(rowKey(raw(row,nt),nt));
      if([...ids].some(id=>known.has(id)))continue;selected=ids;break;
    }
    if(!selected)fail('STORE_ARCHIVE_NO_GENERATION');
    const dt=table(full,'dependencies');for(const row of rows(full,dt)){
      const child=selected.has(framed([row[0]!])),parent=selected.has(framed([row[1]!]));
      if(child!==parent)fail('STORE_ARCHIVE_CROSS_GENERATION');
    }
    cold.exec('BEGIN');
    for(const name of COLD_TABLES){const t=table(full,name);if(previous)for(const row of rows(previous.database,t))insert(cold,t,row);
      const nodeColumn=name==='nodes'?0:name==='ingress'?3:0;
      for(const row of rows(full,t))if(selected.has(framed([row[nodeColumn]!])))insert(cold,t,row);
    }
    cold.exec('COMMIT');checkCold(cold);return boundedSerialize(cold,MAX_STORE_COLD);
  }catch(error){return limitFailure(error);}finally{full.close();cold.close();}
}
export function storeColdAAD(identity:VaultIdentity):Buffer{
  const {safetyCold:_safety,storeCold:_store,...context}=identity;
  return Buffer.from(JSON.stringify(['companion-anchored-vault-v3','store-cold-v1',context]));
}
export function sealStoreSegment(plain:Uint8Array,identity:VaultIdentity,key:Uint8Array):{descriptor:StoreColdDescriptor;bytes:Buffer}{
  if(identity.storageProfile!==STORE_COLD_PROFILE)fail('STORE_COLD_PROFILE');const db=open(plain,MAX_STORE_COLD);
  try{const counts=checkCold(db),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(storeColdAAD(identity));
    const data=Buffer.concat([cipher.update(plain),cipher.final()]),bytes=Buffer.concat([iv,cipher.getAuthTag(),data]);
    const descriptor:StoreColdDescriptor={version:1,format:'aemc-store-sqlite-v1',schema:identity.schemaVersion??1,file:`store-${sha(bytes)}.bin`,cipherDigest:sha(bytes),cipherBytes:bytes.length,
      plainDigest:sha(plain),plainBytes:plain.length,counts};validateStoreColdDescriptor(descriptor);return{descriptor,bytes};
  }finally{db.close();}
}
export class StoreColdSegment{
  readonly database:DatabaseSync;
  private constructor(db:DatabaseSync){this.database=db;}
  static open(bytes:Uint8Array,identity:VaultIdentity,key:Uint8Array):StoreColdSegment{
    const d=identity.storeCold;if(identity.storageProfile!==STORE_COLD_PROFILE||!d)fail('STORE_COLD_PROFILE');validateStoreColdDescriptor(d);
    if(d.schema!==(identity.schemaVersion??1)||bytes.length!==d.cipherBytes||sha(bytes)!==d.cipherDigest)fail('STORE_COLD_CIPHER');
    let plain:Buffer|undefined,db:DatabaseSync|undefined;
    try{
      try{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(storeColdAAD(identity));cipher.setAuthTag(bytes.subarray(12,28));plain=Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]);}catch{fail('STORE_COLD_AUTH');}
      if(plain.length!==d.plainBytes||sha(plain)!==d.plainDigest||plain.subarray(0,16).toString('binary')!=='SQLite format 3\u0000'
        ||plain.readUInt16BE(16)!==4096||plain.readUInt32BE(28)*4096!==plain.length||plain.readUInt32BE(56)!==1)fail('STORE_COLD_PLAIN');db=open(plain,MAX_STORE_COLD);
      const counts=checkCold(db);if(COLD_TABLES.some(name=>counts[name]!==d.counts[name]))fail('STORE_COLD_ROWS');db.exec('PRAGMA query_only=ON');
      const result=new StoreColdSegment(db);db=undefined;return result;
    }finally{plain?.fill(0);db?.close();}
  }
  plain():Buffer{return boundedSerialize(this.database,MAX_STORE_COLD);}
  close():void{this.database.close();}
}
export function assertStoreColdClosure(identity:VaultIdentity,reader:(name:string,max:number)=>Buffer=(name,max)=>readBounded(join(identity.directory,name),max)):void{
  if(identity.storageProfile!==STORE_COLD_PROFILE)return;const d=identity.storeCold;if(d===null)return;validateStoreColdDescriptor(d);
  const bytes=reader(d.file,d.cipherBytes);if(bytes.length!==d.cipherBytes||sha(bytes)!==d.cipherDigest)fail('STORE_COLD_CIPHER');
}
