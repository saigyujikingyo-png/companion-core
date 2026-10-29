import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {SQLTagStore} from 'node:sqlite';
import {isProxy} from 'node:util/types';
import {id} from './anchored-codec.ts';
import {sha,record} from './durable-codec.ts';
import {fail} from './validation.ts';

export const COLD_LIMITS=Object.freeze({payload:1048576,intent:8192,descriptor:2048,receipt:8192,slots:4,retained:4227072,
  workspace:12582912,shared:67108864,files:10,selection:262144,receipts:256,segments:4,legacy:16,closure:1122304,manifest:65536});
export const COLD_KIND='authority-permanent-index-archive';
export const COLD_FORMAT='companion-authority-permanent-cold-sqlite-v1';
export const ROUTE_SQL='CREATE TABLE authority_cold_route (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL CHECK(epoch>=0 AND epoch<=4), descriptor TEXT) STRICT';
export const OPERATION_SQL='CREATE TABLE authority_cold_operation (id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, receipt TEXT NOT NULL) STRICT';
export type Release=()=>void;
export interface Workspace {reserve(bytes:number,label:string):Release;readonly used:number;readonly peak:number;}
export type ColdRequest={version:1;kind:typeof COLD_KIND;operationId:string;expectedRouteEpoch:number;policy:'closed-oldest-v1'};
export type ColdInput={operationId:string;expectedRouteEpoch:number};
export type Counts={receipts:number;segments:number;legacy:number;operations:number};
export type Moved=Counts&{framedBytes:number;skipped:{receipts:number;segments:number;legacy:number}};
export type Descriptor={format:'companion-authority-cold-route-v1';version:1;slot:number;epoch:number;intentBytes:number;intentDigest:string;payloadBytes:number;payloadDigest:string;counts:Counts};
export type ColdMeta={format:typeof COLD_FORMAT;version:1;authorityId:string;custodyDomain:string;operationId:string;requestDigest:string;fromEpoch:number;toEpoch:number;parentPayloadDigest:string|null;sourceSnapshotDigest:string;selectionDigest:string;counts:Counts};
export type Intent={format:'companion-authority-cold-intent-v1';version:1;slot:number;authorityId:string;custodyDomain:string;request:ColdRequest;requestDigest:string;fromEpoch:number;toEpoch:number;parentPayloadDigest:string|null;sourceSnapshotDigest:string;selectionDigest:string;counts:Counts;moved:Moved;payloadBytes:number;payloadDigest:string};
export type ColdReceipt={version:1;kind:typeof COLD_KIND;operationId:string;requestDigest:string;fromEpoch:number;toEpoch:number;sourceSnapshotDigest:string;selectionDigest:string;moved:Moved;descriptor:Descriptor};
export type Kind='R'|'S'|'L'|'M'|'V';
export type Cell=string|number|Uint8Array;
export type RawRow={kind:Kind;values:Cell[];epoch:number;keepParsed?:()=>Release};
export const ROW_COLUMNS:Record<Kind,readonly string[]>={R:['vault_id','operation_id','receipt'],S:['segment_id','request','digest','decoded_bytes','encoded_bytes','entry_count','json_bytes','payload'],L:['lineage_id','migration_id','vault_id','state'],M:['operation_id','request','receipt'],V:['vault_id','state']};
export const ROW_KEYS:Record<Kind,number>={R:2,S:1,L:1,M:1,V:1};
export const ROW_BLOBS:Record<Kind,readonly number[]>={R:[2],S:[1,7],L:[3],M:[1,2],V:[1]};
export const COLD_TABLE:Record<Exclude<Kind,'V'>,string>={R:'cold_receipts',S:'cold_segments',L:'cold_legacy',M:'cold_operations'};
const SQL=[
 'CREATE TABLE cold_meta (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL) STRICT',
 'CREATE TABLE cold_receipts (vault_id TEXT NOT NULL, operation_id TEXT NOT NULL, receipt_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL, PRIMARY KEY(vault_id,operation_id)) STRICT, WITHOUT ROWID',
 'CREATE TABLE cold_segments (segment_id TEXT PRIMARY KEY, request_utf8 BLOB NOT NULL, digest TEXT NOT NULL, decoded_bytes INTEGER NOT NULL, encoded_bytes INTEGER NOT NULL, entry_count INTEGER NOT NULL, json_bytes INTEGER NOT NULL, payload BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID',
 'CREATE TABLE cold_legacy (lineage_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, vault_id TEXT NOT NULL UNIQUE, state_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID',
 'CREATE TABLE cold_operations (operation_id TEXT PRIMARY KEY, request_utf8 BLOB NOT NULL, receipt_utf8 BLOB NOT NULL, moved_epoch INTEGER NOT NULL) STRICT, WITHOUT ROWID'];
export const emptyCounts=():Counts=>({receipts:0,segments:0,legacy:0,operations:0});
export function safeSum(...n:number[]):number{let result=0;for(const v of n){if(!Number.isSafeInteger(v)||v<0||!Number.isSafeInteger(result+v))fail('ANCHOR_COLD_BOUND');result+=v;}return result;}
export function utf8(value:Uint8Array):string{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);}catch{fail('ANCHOR_COLD_UTF8');}}
export function parsed(value:Uint8Array):any{try{return JSON.parse(utf8(value));}catch{fail('ANCHOR_COLD_JSON');}}
export function closed(value:unknown,keys:readonly string[]):asserts value is Record<string,any>{if(!record(value)||Object.keys(value).length!==keys.length||keys.some((k,i)=>Object.keys(value)[i]!==k))fail('ANCHOR_COLD_FORMAT');}
function integer(n:unknown,min:number,max:number):asserts n is number{if(!Number.isSafeInteger(n)||(n as number)<min||(n as number)>max)fail('ANCHOR_COLD_FORMAT');}
function digest(v:unknown):asserts v is string{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail('ANCHOR_COLD_FORMAT');}
export function json(value:unknown,maximum:number):string{const s=JSON.stringify(value);if(typeof s!=='string'||Buffer.byteLength(s)>maximum)fail('ANCHOR_COLD_BOUND');return s;}
/** Measure ordinary JSON without allocating its serialized string or invoking user code. */
export function plainJsonBytes(value:unknown):number{
 const active=new Set<object>();
 const stringBytes=(s:string):number=>{let n=Buffer.byteLength(s)+2;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c===34||c===92)n++;else if(c<32)n+=[8,9,10,12,13].includes(c)?1:5;else if(c>=0xd800&&c<=0xdbff){const next=s.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff)i++;else n+=3;}else if(c>=0xdc00&&c<=0xdfff)n+=3;}return n;};
 const count=(v:unknown):number=>{
  if(v===undefined)return 0;if(v===null)return 4;if(typeof v==='string')return stringBytes(v);if(typeof v==='boolean')return v?4:5;if(typeof v==='number')return Number.isFinite(v)?String(v).length:4;
  if(typeof v!=='object'||isProxy(v)||active.has(v))fail('ANCHOR_COLD_JSON');
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('ANCHOR_COLD_JSON');
  for(const key of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,key)!;if(!Object.hasOwn(d,'value')||key==='toJSON')fail('ANCHOR_COLD_JSON');}
  if(Object.hasOwn(Object.prototype,'toJSON')||(array&&Object.hasOwn(Array.prototype,'toJSON')))fail('ANCHOR_COLD_JSON');
  active.add(v);try{let n=2,first=true;
   if(array){for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d&&i in v)fail('ANCHOR_COLD_JSON');n=safeSum(n,first?0:1,count(d?.value)||4);first=false;}}
   else for(const key of Object.keys(v)){const child=Object.getOwnPropertyDescriptor(v,key)!.value;if(child===undefined)continue;n=safeSum(n,first?0:1,stringBytes(key),1,count(child));first=false;}
   return n;
  }finally{active.delete(v);}
 };return count(value);
}
export function withPlainJSON<T>(value:unknown,w:Workspace,body:(json:string)=>T):T{const bytes=plainJsonBytes(value),release=w.reserve(bytes,'plain JSON serialized UTF8');try{const encoded=JSON.stringify(value);if(typeof encoded!=='string')fail('ANCHOR_COLD_JSON');return body(encoded);}finally{release();}}
export function samePlainJSON(a:unknown,b:unknown,w:Workspace):boolean{const bytes=safeSum(plainJsonBytes(a),plainJsonBytes(b)),release=w.reserve(bytes,'plain JSON comparison UTF8 pair');try{return JSON.stringify(a)===JSON.stringify(b);}finally{release();}}
export function normalizeCold(input:unknown):ColdRequest{
 if(!input||typeof input!=='object'||isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('ANCHOR_COLD_REQUEST');
 const keys=Reflect.ownKeys(input);if(keys.length!==2||!keys.includes('operationId')||!keys.includes('expectedRouteEpoch'))fail('ANCHOR_COLD_REQUEST');
 const copy:Record<string,unknown>={};for(const key of keys as string[]){const d=Object.getOwnPropertyDescriptor(input,key)!;if(!Object.hasOwn(d,'value'))fail('ANCHOR_COLD_REQUEST');copy[key]=d.value;}
 if(typeof copy.operationId!=='string'||!/^ac1-[A-Za-z0-9_-]{1,96}$/.test(copy.operationId))fail('ANCHOR_COLD_REQUEST');id(copy.operationId);
 if(!Number.isSafeInteger(copy.expectedRouteEpoch)||(copy.expectedRouteEpoch as number)<0||(copy.expectedRouteEpoch as number)>3)fail('ANCHOR_COLD_REQUEST');
 return{version:1,kind:COLD_KIND,operationId:copy.operationId,expectedRouteEpoch:copy.expectedRouteEpoch as number,policy:'closed-oldest-v1'};
}
export function validateRequest(v:unknown):ColdRequest{closed(v,['version','kind','operationId','expectedRouteEpoch','policy']);const expected=normalizeCold({operationId:v.operationId,expectedRouteEpoch:v.expectedRouteEpoch});if(JSON.stringify(expected)!==JSON.stringify(v))fail('ANCHOR_COLD_FORMAT');return expected;}
export function validateCounts(v:unknown):asserts v is Counts{closed(v,['receipts','segments','legacy','operations']);for(const n of Object.values(v))integer(n,0,1048576);if(v.segments>128||v.operations>3)fail('ANCHOR_COLD_FORMAT');}
export function validateMoved(v:unknown):asserts v is Moved{closed(v,['receipts','segments','legacy','operations','framedBytes','skipped']);integer(v.receipts,0,256);integer(v.segments,0,4);integer(v.legacy,0,16);integer(v.operations,0,1);integer(v.framedBytes,0,262144);if(v.receipts+v.segments+v.legacy<1)fail('ANCHOR_COLD_FORMAT');closed(v.skipped,['receipts','segments','legacy']);for(const n of Object.values(v.skipped))integer(n,0,Number.MAX_SAFE_INTEGER);}
export function validateDescriptor(v:unknown):asserts v is Descriptor{
 closed(v,['format','version','slot','epoch','intentBytes','intentDigest','payloadBytes','payloadDigest','counts']);
 if(v.format!=='companion-authority-cold-route-v1'||v.version!==1)fail('ANCHOR_COLD_FORMAT');integer(v.slot,0,3);integer(v.epoch,1,4);integer(v.intentBytes,1,8192);integer(v.payloadBytes,4096,1048576);if(v.payloadBytes%4096)fail('ANCHOR_COLD_FORMAT');digest(v.intentDigest);digest(v.payloadDigest);validateCounts(v.counts);json(v,2048);
}
export function validateMeta(v:unknown):asserts v is ColdMeta{
 closed(v,['format','version','authorityId','custodyDomain','operationId','requestDigest','fromEpoch','toEpoch','parentPayloadDigest','sourceSnapshotDigest','selectionDigest','counts']);
 if(v.format!==COLD_FORMAT||v.version!==1)fail('ANCHOR_COLD_FORMAT');id(v.authorityId);id(v.custodyDomain);normalizeCold({operationId:v.operationId,expectedRouteEpoch:v.fromEpoch});integer(v.toEpoch,1,4);if(v.toEpoch!==v.fromEpoch+1)fail('ANCHOR_COLD_FORMAT');for(const k of ['requestDigest','sourceSnapshotDigest','selectionDigest'])digest(v[k]);if(v.fromEpoch===0){if(v.parentPayloadDigest!==null)fail('ANCHOR_COLD_FORMAT');}else digest(v.parentPayloadDigest);validateCounts(v.counts);
}
export function validateIntent(v:unknown):asserts v is Intent{
 closed(v,['format','version','slot','authorityId','custodyDomain','request','requestDigest','fromEpoch','toEpoch','parentPayloadDigest','sourceSnapshotDigest','selectionDigest','counts','moved','payloadBytes','payloadDigest']);
 if(v.format!=='companion-authority-cold-intent-v1'||v.version!==1)fail('ANCHOR_COLD_FORMAT');integer(v.slot,0,3);validateRequest(v.request);validateMoved(v.moved);
 validateMeta(metaOf(v as Intent));if(v.requestDigest!==sha(JSON.stringify(v.request))||v.fromEpoch!==v.request.expectedRouteEpoch)fail('ANCHOR_COLD_FORMAT');integer(v.payloadBytes,4096,1048576);if(v.payloadBytes%4096)fail('ANCHOR_COLD_FORMAT');digest(v.payloadDigest);json(v,8192);
}
export function metaOf(v:Intent):ColdMeta{return{format:COLD_FORMAT,version:1,authorityId:v.authorityId,custodyDomain:v.custodyDomain,operationId:v.request.operationId,requestDigest:v.requestDigest,fromEpoch:v.fromEpoch,toEpoch:v.toEpoch,parentPayloadDigest:v.parentPayloadDigest,sourceSnapshotDigest:v.sourceSnapshotDigest,selectionDigest:v.selectionDigest,counts:v.counts};}
export function descriptorOf(v:Intent,bytes:Uint8Array):Descriptor{return{format:'companion-authority-cold-route-v1',version:1,slot:v.slot,epoch:v.toEpoch,intentBytes:bytes.byteLength,intentDigest:sha(bytes),payloadBytes:v.payloadBytes,payloadDigest:v.payloadDigest,counts:v.counts};}
export function receiptOf(v:Intent,d:Descriptor):ColdReceipt{return{version:1,kind:COLD_KIND,operationId:v.request.operationId,requestDigest:v.requestDigest,fromEpoch:v.fromEpoch,toEpoch:v.toEpoch,sourceSnapshotDigest:v.sourceSnapshotDigest,selectionDigest:v.selectionDigest,moved:v.moved,descriptor:d};}
export function validateReceipt(v:unknown,request:ColdRequest):asserts v is ColdReceipt{
 closed(v,['version','kind','operationId','requestDigest','fromEpoch','toEpoch','sourceSnapshotDigest','selectionDigest','moved','descriptor']);
 if(v.version!==1||v.kind!==COLD_KIND||v.operationId!==request.operationId||v.requestDigest!==sha(JSON.stringify(request))||v.fromEpoch!==request.expectedRouteEpoch||v.toEpoch!==v.fromEpoch+1)fail('ANCHOR_COLD_FORMAT');digest(v.sourceSnapshotDigest);digest(v.selectionDigest);validateMoved(v.moved);validateDescriptor(v.descriptor);if(v.descriptor.epoch!==v.toEpoch)fail('ANCHOR_COLD_FORMAT');json(v,8192);
}
/** Stream framing: tag ASCII + uint64BE byte length + UTF-8/BLOB bytes; no concatenated snapshot. */
export function frameBytes(row:RawRow):number{return safeSum(10,...row.values.map(v=>9+(typeof v==='number'?Buffer.byteLength(String(v)):typeof v==='string'?Buffer.byteLength(v):v.byteLength)));}
export function hashRows(){const hash=createHash('sha256');return{add(row:RawRow){hash.update(row.kind);const count=Buffer.alloc(9);count[0]=row.values.length;count.writeBigUInt64BE(BigInt(row.values.length),1);hash.update(count);for(const v of row.values){const bytes=typeof v==='number'?Buffer.from(String(v)):typeof v==='string'?Buffer.from(v):v;const h=Buffer.alloc(9);h[0]=typeof v==='number'?78:typeof v==='string'?84:66;h.writeBigUInt64BE(BigInt(bytes.byteLength),1);hash.update(h);hash.update(bytes);}},finish(){return hash.digest('hex');}};}
export function keyCompare(a:RawRow,b:RawRow):number{for(let i=0;i<ROW_KEYS[a.kind];i++){const n=Buffer.compare(Buffer.from(a.values[i] as string),Buffer.from(b.values[i] as string));if(n)return n;}return 0;}
export function sameRow(a:RawRow,b:RawRow):boolean{return a.kind===b.kind&&a.values.length===b.values.length&&a.values.every((v,i)=>v instanceof Uint8Array?b.values[i] instanceof Uint8Array&&Buffer.from(v).equals(b.values[i] as Uint8Array):v===b.values[i]);}
export function rowBytes(row:RawRow):number{return safeSum(...row.values.map(v=>typeof v==='number'?8:typeof v==='string'?Buffer.byteLength(v):v.byteLength));}
export function copyRow(row:RawRow,w:Workspace):{row:RawRow;close:Release}{const release=w.reserve(safeSum(rowBytes(row)*4,1024),'retained selected row');try{return{row:{kind:row.kind,values:row.values.map(v=>v instanceof Uint8Array?Buffer.from(v):v),epoch:row.epoch},close:release};}catch(e){release();throw e;}}

function ram():DatabaseSync{const db=new DatabaseSync(':memory:',{allowExtension:false,enableDoubleQuotedStringLiterals:false});try{runtime(db);return db;}catch(e){db.close();throw e;}}
function runtime(db:DatabaseSync):void{
 const unnamed=()=>{const rows=db.prepare('PRAGMA database_list').all();return rows.length===1&&rows[0]!.name==='main'&&rows[0]!.file==='';};
 const options=new Set(db.prepare('PRAGMA compile_options').all().map(r=>r.compile_options));
 if(db.isTransaction||!unnamed()||options.has('TEMP_STORE=0')||![1,2,3].some(n=>options.has(`TEMP_STORE=${n}`)))fail('ANCHOR_COLD_RUNTIME');
 db.exec('PRAGMA temp_store=MEMORY; PRAGMA main.journal_mode=MEMORY; PRAGMA cache_spill=OFF;');
 if(!unnamed()||db.prepare('PRAGMA temp_store').get()!.temp_store!==2||db.prepare('PRAGMA main.journal_mode').get()!.journal_mode!=='memory'||db.prepare('PRAGMA cache_spill').get()!.cache_spill!==0)fail('ANCHOR_COLD_RUNTIME');
}
function layout(db:DatabaseSync):string{return JSON.stringify({schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),tables:db.prepare('PRAGMA main.table_list').all(),details:SQL.map(sql=>{const table=sql.split(' ')[2]!;return{table,columns:db.prepare(`PRAGMA table_xinfo('${table}')`).all(),indexes:db.prepare(`PRAGMA index_list('${table}')`).all().map(i=>({row:i,columns:db.prepare(`PRAGMA index_xinfo('${i.name}')`).all()}))};})});}
function assertLayout(db:DatabaseSync,w:Workspace):void{
 if(db.prepare('PRAGMA user_version').get()!.user_version!==1||db.prepare('PRAGMA application_id').get()!.application_id!==1094922545||db.prepare('PRAGMA page_size').get()!.page_size!==4096||db.prepare('PRAGMA freelist_count').get()!.freelist_count!==0||db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum!==0||db.prepare('PRAGMA encoding').get()!.encoding!=='UTF-8')fail('ANCHOR_COLD_LAYOUT');
 const release=w.reserve(131072,'expected layout temporary SQLite and bounded signatures');let expected:DatabaseSync|undefined;
 try{
  // sqlite_schema is structural metadata. Bound it before fetching SQL or touching any application table.
  const bounds=db.prepare('SELECT count(*) AS n,max(length(CAST(name AS BLOB))) AS names,max(length(CAST(tbl_name AS BLOB))) AS tables,max(length(CAST(sql AS BLOB))) AS sqlBytes FROM sqlite_schema').get()!;
  if(bounds.n!==7||typeof bounds.names!=='number'||bounds.names>128||typeof bounds.tables!=='number'||bounds.tables>128||typeof bounds.sqlBytes!=='number'||bounds.sqlBytes>2048)fail('ANCHOR_COLD_LAYOUT');
  const pages=db.prepare('PRAGMA page_count').get()!.page_count as number,objects=db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY name').all();
  for(const object of objects){
   if(typeof object.rootpage!=='number'||!Number.isInteger(object.rootpage)||object.rootpage<1||object.rootpage>pages)fail('ANCHOR_COLD_LAYOUT');
   if(object.type==='table'){const sql=SQL.find(s=>s.split(' ')[2]===object.name);if(!sql||object.tbl_name!==object.name||object.sql!==sql)fail('ANCHOR_COLD_LAYOUT');}
   else if(object.type!=='index'||object.tbl_name!=='cold_legacy'||!['sqlite_autoindex_cold_legacy_2','sqlite_autoindex_cold_legacy_3'].includes(object.name as string)||object.sql!==null)fail('ANCHOR_COLD_LAYOUT');
  }
  expected=ram();expected.exec(SQL.join(';'));if(layout(db)!==layout(expected))fail('ANCHOR_COLD_LAYOUT');
 }finally{expected?.close();release();}
}
function physicalColumn(kind:Kind,i:number,cold:boolean):string{const c=ROW_COLUMNS[kind][i]!;return cold&&ROW_BLOBS[kind].includes(i)&&c!=='payload'?c+'_utf8':c;}
/** BLOB/TEXT sizes are inspected before allocation. Each yielded row owns a shared ticket until next(). */
export function* sqlRows(db:DatabaseSync,kind:Kind,table:string,cold:boolean,w:Workspace,where='',args:(string|number)[]=[]):Generator<RawRow>{
 const columns=ROW_COLUMNS[kind],keys=columns.slice(0,ROW_KEYS[kind]);
 const fields=columns.map((_,i)=>physicalColumn(kind,i,cold));
 const small=fields.map((c,i)=>ROW_BLOBS[kind].includes(i)?`length(CAST(${c} AS BLOB)) AS n${i}`:typeof i==='number'?`substr(CAST(${c} AS TEXT),1,257) AS s${i},length(CAST(${c} AS BLOB)) AS n${i}`:'');
 const selector=db.prepare(`SELECT ${small.join(',')}${cold?',moved_epoch':''} FROM ${table} ${where} ORDER BY ${keys.map(c=>c+' COLLATE BINARY').join(',')}`);
 const blobs=fields.map((_,i)=>ROW_BLOBS[kind].includes(i)),lengthNames=fields.map((_,i)=>'n'+i),valueNames=fields.map((_,i)=>'c'+i),keyNames=keys.map((_,i)=>'s'+i);
 const payloadSQL=`SELECT ${fields.map((c,i)=>blobs[i]?`CAST(${c} AS BLOB) AS c${i}`:`${c} AS c${i}`).join(',')} FROM ${table} WHERE ${keys.map(c=>c+'=?').join(' AND ')}`;
 // One statement per iterator, never a result or cross-transaction cache.
 // Prepare lazily after the first row's bounds and workspace admission.
 let payload:ReturnType<DatabaseSync['prepare']>|undefined;const cursor=selector.iterate(...args);
 try{for(;;){const next=cursor.next();if(next.done)break;const bounds=next.value;
  let total=0;for(let i=0;i<fields.length;i++){const n=bounds[lengthNames[i]!];if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||(!blobs[i]&&n>256))fail('ANCHOR_COLD_BOUND');total=safeSum(total,n);}
  const release=w.reserve(safeSum(total*2,512),'SQL row and transient UTF8 representation');let parsedRelease:Release|undefined,kept=false;let values:Cell[]=[];
  try{
   parsedRelease=w.reserve(safeSum(total*2,512),'SQL parsed representation');
   const keyValues=keyNames.map(name=>bounds[name] as string);
   payload??=db.prepare(payloadSQL);const row=payload.get(...keyValues);
   if(!row)fail('ANCHOR_COLD_CORRUPT');values=valueNames.map(name=>row[name] as Cell);
   for(let i=0;i<values.length;i++){const v=values[i];if(blobs[i]){if(!(v instanceof Uint8Array)||v.byteLength!==bounds[lengthNames[i]!])fail('ANCHOR_COLD_CORRUPT');}else if(typeof v!=='string'&&typeof v!=='number')fail('ANCHOR_COLD_CORRUPT');}
   yield{kind,values,epoch:cold?bounds.moved_epoch as number:0,keepParsed:()=>{if(kept)fail('ANCHOR_COLD_WORKSPACE');kept=true;return parsedRelease!;}};
  }finally{for(const v of values)if(v instanceof Uint8Array)v.fill(0);if(!kept)parsedRelease?.();release();}
 }}finally{cursor.return?.();}
}
/** Two fixed full-R-key statements for one closure's IF8 loop only.
 * clear() ends API cache ownership, not a promise of native finalization/RSS. */
export class ReceiptKeyReader{
 #store:SQLTagStore|undefined;readonly #cold:boolean;readonly #w:Workspace;readonly #release:Release;#busy=false;#closed=false;
 constructor(db:DatabaseSync,cold:boolean,w:Workspace){
  this.#cold=cold;this.#w=w;this.#release=w.reserve(65536,'IF8 fixed receipt reader metadata and two statement owners');
  try{this.#store=db.createTagStore(2);if(this.#store.capacity!==2||this.#store.size!==0)fail('ANCHOR_COLD_READER');}catch(e){try{this.#store?.clear();}finally{this.#store=undefined;this.#release();}throw e;}
 }
 using<T>(vaultId:string,operationId:string,body:(row:RawRow)=>T):T|undefined{
  if(this.#closed)fail('ANCHOR_COLD_CLOSED');if(this.#busy)fail('ANCHOR_COLD_READER_BUSY');id(vaultId);id(operationId);this.#busy=true;
  let release:Release=()=>{},parsedRelease:Release|undefined,kept=false,wipe:Uint8Array|undefined;
  try{
   // Both parameters are rebound on every get. Only these two literal shapes
   // can enter this DB's capacity-two store; no SQL iterator escapes a call.
   const bounds=this.#cold?this.#store!.get`SELECT substr(CAST(vault_id AS TEXT),1,257) AS s0,length(CAST(vault_id AS BLOB)) AS n0,substr(CAST(operation_id AS TEXT),1,257) AS s1,length(CAST(operation_id AS BLOB)) AS n1,length(CAST(receipt_utf8 AS BLOB)) AS n2,moved_epoch FROM cold_receipts WHERE vault_id=${vaultId} AND operation_id=${operationId}`
    :this.#store!.get`SELECT substr(CAST(vault_id AS TEXT),1,257) AS s0,length(CAST(vault_id AS BLOB)) AS n0,substr(CAST(operation_id AS TEXT),1,257) AS s1,length(CAST(operation_id AS BLOB)) AS n1,length(CAST(receipt AS BLOB)) AS n2 FROM receipts WHERE vault_id=${vaultId} AND operation_id=${operationId}`;
   if(!bounds)return undefined;let total=0;for(const [i,n] of [bounds.n0,bounds.n1,bounds.n2].entries()){if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||(i<2&&n>256))fail('ANCHOR_COLD_BOUND');total=safeSum(total,n);}
   release=this.#w.reserve(safeSum(total*2,512),'SQL row and transient UTF8 representation');parsedRelease=this.#w.reserve(safeSum(total*2,512),'SQL parsed representation');
   const row=this.#cold?this.#store!.get`SELECT vault_id AS c0,operation_id AS c1,CAST(receipt_utf8 AS BLOB) AS c2 FROM cold_receipts WHERE vault_id=${vaultId} AND operation_id=${operationId}`
    :this.#store!.get`SELECT vault_id AS c0,operation_id AS c1,CAST(receipt AS BLOB) AS c2 FROM receipts WHERE vault_id=${vaultId} AND operation_id=${operationId}`;
   if(!row)fail('ANCHOR_COLD_CORRUPT');const values:Cell[]=[row.c0 as Cell,row.c1 as Cell,row.c2 as Cell];if(row.c2 instanceof Uint8Array)wipe=new Uint8Array(row.c2.buffer,row.c2.byteOffset,row.c2.byteLength);
   for(let i=0;i<values.length;i++){const v=values[i];if(i===2){if(!(v instanceof Uint8Array)||v.byteLength!==bounds.n2)fail('ANCHOR_COLD_CORRUPT');}else if(typeof v!=='string'&&typeof v!=='number')fail('ANCHOR_COLD_CORRUPT');}
   return body({kind:'R',values,epoch:this.#cold?bounds.moved_epoch as number:0,keepParsed:()=>{if(kept)fail('ANCHOR_COLD_WORKSPACE');kept=true;return parsedRelease!;}});
  }finally{try{wipe?.fill(0);}finally{try{if(!kept)parsedRelease?.();}finally{try{release();}finally{this.#busy=false;}}}}
 }
 close():void{if(this.#closed)return;if(this.#busy)fail('ANCHOR_COLD_READER_BUSY');this.#closed=true;try{this.#store!.clear();}finally{this.#store=undefined;this.#release();}}
}
/** Preload every source before duplicate detection or interpretation, as rawRows
 * does. Nested calls retain each row's two tickets until all sources unwind. */
export function usingReceiptKeys<T>(readers:readonly ReceiptKeyReader[],vaultId:string,operationId:string,body:(row:RawRow)=>T):T|undefined{
 if(readers.length<1||readers.length>3)fail('ANCHOR_COLD_READER');
 const rows:RawRow[]=[];const visit=(i:number):T|undefined=>{
  if(i===readers.length){if(rows.length>1)fail('ANCHOR_COLD_DUPLICATE');return rows.length?body(rows[0]!):undefined;}
  let present=false;const result=readers[i]!.using(vaultId,operationId,row=>{present=true;rows.push(row);try{return visit(i+1);}finally{rows.pop();}});return present?result:visit(i+1);
 };return visit(0);
}
export class ColdDatabase{
 #db:DatabaseSync;#w:Workspace;#release:Release;#closed=false;#mutable=false;#meta:ColdMeta;
 get meta():ColdMeta{return this.#meta;}
 private constructor(db:DatabaseSync,w:Workspace,release:Release,meta:ColdMeta){this.#db=db;this.#w=w;this.#release=release;this.#meta=meta;}
 static build(meta:ColdMeta,rows:Iterable<RawRow>,w:Workspace,mutable=false):ColdDatabase{
  validateMeta(meta);const release=w.reserve(COLD_LIMITS.payload+32768,'candidate RAM SQLite image and metadata');let db:DatabaseSync|undefined,journal:Release|undefined;
  try{db=ram();db.exec(`PRAGMA page_size=4096; PRAGMA auto_vacuum=0; PRAGMA max_page_count=256; PRAGMA application_id=1094922545; PRAGMA user_version=1; ${SQL.join(';')};`);
   if(mutable){journal=w.reserve(safeSum((db.prepare('PRAGMA page_count').get()!.page_count as number)*4104,131072),'candidate RAM transaction journal');db.exec('BEGIN');}
   db.prepare('INSERT INTO cold_meta VALUES (1,?)').run(json(meta,8192));
   for(const row of rows){if(row.kind==='V')fail('ANCHOR_COLD_FORMAT');db.prepare(`INSERT INTO ${COLD_TABLE[row.kind]} VALUES (${row.values.map(()=>'?').join(',')},?)`).run(...row.values,row.epoch);}
   const result=new ColdDatabase(db,w,release,meta);db=undefined;try{result.validate();if(mutable)result.#db.exec('COMMIT');result.#db.enableDefensive(true);result.#mutable=mutable;if(!mutable)result.#db.exec('PRAGMA query_only=ON');return result;}catch(e){result.close();throw e;}
  }catch(e){if(db){db.close();release();}else if(!db)release();throw e;}finally{journal?.();}
 }
 static open(bytes:Uint8Array,w:Workspace):ColdDatabase{
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(b.length<4096||b.length>1048576||b.length%4096||b.subarray(0,16).toString('binary')!=='SQLite format 3\u0000'||b.readUInt16BE(16)!==4096||b.readUInt32BE(28)*4096!==b.length||b.readUInt32BE(56)!==1||b.readUInt32BE(32)!==0||b.readUInt32BE(36)!==0)fail('ANCHOR_COLD_HEADER');
  const release=w.reserve(b.length+32768,'current RAM SQLite image and metadata');let db:DatabaseSync|undefined;
  try{db=ram();db.deserialize(b);runtime(db);db.enableDefensive(true);db.exec('PRAGMA query_only=ON');assertLayout(db,w);
   const bounds=db.prepare('SELECT count(*) AS n,max(length(CAST(state AS BLOB))) AS bytes FROM cold_meta').get()!;if(bounds.n!==1||typeof bounds.bytes!=='number'||bounds.bytes>8192)fail('ANCHOR_COLD_FORMAT');
   const meta=JSON.parse(db.prepare('SELECT state FROM cold_meta WHERE id=1').get()!.state as string) as ColdMeta;validateMeta(meta);
   const result=new ColdDatabase(db,w,release,meta);db=undefined;try{result.validate(true);return result;}catch(e){result.close();throw e;}
  }catch(e){db?.close();release();throw e;}
 }
 /** Each complete group and its final metadata is its own top-level RAM transaction. */
 tryGroup(meta:ColdMeta,rows:readonly RawRow[]):boolean{
  if(this.#closed||!this.#mutable||this.#db.isTransaction)fail('ANCHOR_COLD_TRANSACTION');validateMeta(meta);
  const prior=this.#meta;for(const key of ['format','version','authorityId','custodyDomain','operationId','requestDigest','fromEpoch','toEpoch','parentPayloadDigest','sourceSnapshotDigest'] as const)if(meta[key]!==prior[key])fail('ANCHOR_COLD_FORMAT');
  const before=this.serialize(),beforeDigest=sha(before.bytes),beforePages=before.bytes.length/4096;let journal:Release|undefined;
  try{
   journal=this.#w.reserve(safeSum(beforePages*4104,131072),'candidate RAM transaction journal');
   try{this.#db.exec('BEGIN');for(const row of rows){if(row.kind==='V'||row.epoch!==meta.toEpoch)fail('ANCHOR_COLD_FORMAT');this.#db.prepare(`INSERT INTO ${COLD_TABLE[row.kind]} VALUES (${row.values.map(()=>'?').join(',')},?)`).run(...row.values,row.epoch);}
    if(this.#db.prepare('UPDATE cold_meta SET state=? WHERE id=1').run(json(meta,8192)).changes!==1)fail('ANCHOR_COLD_FORMAT');this.validate(false,meta);this.#db.exec('COMMIT');this.#meta=meta;return true;
   }catch(error){
    try{if(this.#db.isTransaction)this.#db.exec('ROLLBACK');}catch{fail('ANCHOR_COLD_ROLLBACK');}
    if((error as {code?:string;errcode?:number})?.code!=='ERR_SQLITE_ERROR'||(error as {errcode?:number})?.errcode!==13)throw error;
    if(this.#db.isTransaction||this.#db.prepare('PRAGMA max_page_count').get()!.max_page_count!==256)fail('ANCHOR_COLD_ROLLBACK');
    const after=this.serialize();try{if(after.bytes.length!==beforePages*4096||sha(after.bytes)!==beforeDigest)fail('ANCHOR_COLD_ROLLBACK');}finally{after.close();}
    // Exact image equality preserves every previously committed/mandatory row. Revalidate physical format and counts too.
    this.validate();if(this.#db.prepare('SELECT state FROM cold_meta WHERE id=1').get()!.state!==json(prior,8192))fail('ANCHOR_COLD_ROLLBACK');return false;
   }
  }finally{journal?.();before.close();}
 }
 seal():void{if(this.#closed||!this.#mutable||this.#db.isTransaction)fail('ANCHOR_COLD_TRANSACTION');this.validate();this.#db.exec('PRAGMA query_only=ON');this.#mutable=false;}
 validate(layoutChecked=false,meta=this.#meta):void{
  if(!layoutChecked)assertLayout(this.#db,this.#w);
  const integrity=this.#db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||integrity[0]!.integrity_check!=='ok')fail('ANCHOR_COLD_INTEGRITY');
  const counts=emptyCounts();for(const kind of ['R','S','L','M'] as const){for(const row of this.rows(kind)){if(!Number.isSafeInteger(row.epoch)||row.epoch<1||row.epoch>meta.toEpoch)fail('ANCHOR_COLD_FORMAT');counts[{R:'receipts',S:'segments',L:'legacy',M:'operations'}[kind] as keyof Counts]++;}}
  if(JSON.stringify(counts)!==JSON.stringify(meta.counts))fail('ANCHOR_COLD_COUNTS');
 }
 rows(kind:Exclude<Kind,'V'>,index?:number,value?:string,secondary?:string):Generator<RawRow>{if(this.#closed)fail('ANCHOR_COLD_CLOSED');return sqlRows(this.#db,kind,COLD_TABLE[kind],true,this.#w,index===undefined?'':`WHERE ${ROW_COLUMNS[kind][index]}=?${secondary===undefined?'':' AND operation_id=?'}`,index===undefined?[]:secondary===undefined?[value!]:[value!,secondary]);}
 receiptReader():ReceiptKeyReader{if(this.#closed)fail('ANCHOR_COLD_CLOSED');return new ReceiptKeyReader(this.#db,true,this.#w);}
 serialize():{bytes:Uint8Array;close:Release}{const n=(this.#db.prepare('PRAGMA page_count').get()!.page_count as number)*4096;if(n>1048576)fail('ANCHOR_COLD_BOUND');const release=this.#w.reserve(n,'candidate serialize buffer');try{const bytes=this.#db.serialize();if(bytes.length!==n)fail('ANCHOR_COLD_BOUND');return{bytes,close:()=>{bytes.fill(0);release();}};}catch(e){release();throw e;}}
 close():void{if(!this.#closed){this.#closed=true;this.#db.close();this.#release();}}
}
