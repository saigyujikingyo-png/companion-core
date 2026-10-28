import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ColdWorkspace,readOwned,inspectFiles} from '../src/authority-cold-storage.ts';
import {boundSqlite} from '../src/anchored-codec.ts';
import {mkdtempSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {COLD_LIMITS,COLD_FORMAT,ColdDatabase,normalizeCold,emptyCounts,hashRows,frameBytes,utf8,plainJsonBytes,withPlainJSON,samePlainJSON} from '../src/authority-cold-format.ts';
import type {ColdMeta,RawRow} from '../src/authority-cold-format.ts';
import {sha} from '../src/durable-codec.ts';

test('T01/T06 closed requests reject accessors/proxies and workspace tickets share one exact pool',()=>{
 let called=0;assert.throws(()=>normalizeCold({get operationId(){called++;return'ac1-x';},expectedRouteEpoch:0}),/ANCHOR_COLD_REQUEST/);assert.equal(called,0);
 for(const value of [{operationId:'x',expectedRouteEpoch:0},{operationId:'ac1-x',expectedRouteEpoch:4},{operationId:'ac1-x',expectedRouteEpoch:0,extra:1},new Proxy({operationId:'ac1-x',expectedRouteEpoch:0},{})])assert.throws(()=>normalizeCold(value));
 const w=new ColdWorkspace(12),a=w.reserve(8,'old'),b=w.reserve(4,'new');assert.equal(w.peak,12);assert.throws(()=>w.reserve(1,'decode'),/ANCHOR_COLD_WORKSPACE/);a();a();assert.equal(w.used,4);b();assert.equal(w.used,0);
 assert.equal(COLD_LIMITS.retained,4227072);assert.equal(COLD_LIMITS.workspace,12582912);assert.equal(COLD_LIMITS.shared,67108864);
});
test('T06 plain JSON measures exact order/escapes/duplicates and reserves both comparison strings before encoding',()=>{
 const shared={text:'合成\n\t\u0000"\\😀\ud800'},value={z:shared,a:[shared,undefined,null,-0,Infinity],omit:undefined};
 assert.equal(plainJsonBytes(value),Buffer.byteLength(JSON.stringify(value)));const w=new ColdWorkspace();assert.equal(withPlainJSON(value,w,s=>s),JSON.stringify(value));assert.equal(w.used,0);
 let executed=0;for(const bad of [new Proxy({},{}),{get x(){executed++;return 1;}},{toJSON(){executed++;return{};}}])assert.throws(()=>plainJsonBytes(bad),/ANCHOR_COLD_JSON/);assert.equal(executed,0);
 const a={extra:'x'.repeat(262144)},b={...a},bytes=plainJsonBytes(a)+plainJsonBytes(b),small=new ColdWorkspace(bytes-1),stringify=JSON.stringify;let calls=0;
 try{JSON.stringify=((v:any,...args:any[])=>{if(v===a||v===b)calls++;return (stringify as any)(v,...args);}) as typeof JSON.stringify;assert.throws(()=>samePlainJSON(a,b,small),/ANCHOR_COLD_WORKSPACE/);assert.equal(calls,0);assert.equal(small.used,0);}finally{JSON.stringify=stringify;}
 const large={extra:'x'.repeat(COLD_LIMITS.workspace+1)};try{JSON.stringify=((v:any,...args:any[])=>{if(v===large)calls++;return (stringify as any)(v,...args);}) as typeof JSON.stringify;assert.throws(()=>withPlainJSON(large,w,()=>{}),/ANCHOR_COLD_WORKSPACE/);assert.equal(calls,0);}finally{JSON.stringify=stringify;}
});
test('T05 strict RAM SQLite preserves complete original UTF8 bytes and rejects altered header',()=>{
 const request=normalizeCold({operationId:'ac1-format',expectedRouteEpoch:0}),body=Buffer.from('{"b":"合成", "a":2,"extra":[true]}'),row:RawRow={kind:'R',values:['vault','op',body],epoch:1};
 const h=hashRows();h.add(row);const meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:'authority',custodyDomain:'independent',operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:0,toEpoch:1,parentPayloadDigest:null,sourceSnapshotDigest:'a'.repeat(64),selectionDigest:h.finish(),counts:{...emptyCounts(),receipts:1}};
 const w=new ColdWorkspace(),db=ColdDatabase.build(meta,[row],w),serialized=db.serialize();
 try{const opened=ColdDatabase.open(serialized.bytes,w);try{const values=[...opened.rows('R')];assert.equal(values.length,1); // Streaming rows must be consumed before advancing.
   for(const r of opened.rows('R'))assert.equal(utf8(r.values[2] as Uint8Array),body.toString());
  }finally{opened.close();}
  const altered=Buffer.from(serialized.bytes);altered[56]=1;assert.throws(()=>ColdDatabase.open(altered,w),/ANCHOR_COLD_HEADER/);
  assert.ok(frameBytes(row)>body.length);assert.throws(()=>ColdDatabase.open(Buffer.concat([Buffer.from(serialized.bytes),Buffer.from('x')]),w),/ANCHOR_COLD_HEADER/);
 }finally{serialized.close();db.close();}assert.equal(w.used,0);
});
test('T06 old image, candidate image, read and serialize buffers share the actual W ceiling independently',()=>{
 const request=normalizeCold({operationId:'ac1-budget',expectedRouteEpoch:0}),row:RawRow={kind:'R',values:['vault','op',Buffer.from('{}')],epoch:1};
 const meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:'a',custodyDomain:'i',operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:0,toEpoch:1,parentPayloadDigest:null,sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),counts:{...emptyCounts(),receipts:1}};
 const w=new ColdWorkspace(),db=ColdDatabase.build(meta,[row],w),out=db.serialize();try{
  const next=new ColdWorkspace();const occupied=next.reserve(next.limit-out.bytes.length-32768+1,'other live representations');assert.throws(()=>ColdDatabase.open(out.bytes,next),/ANCHOR_COLD_WORKSPACE/);occupied();assert.equal(next.used,0);
  const candidate=new ColdWorkspace();const occupiedCandidate=candidate.reserve(candidate.limit-1048576-32768+1,'other live representations');assert.throws(()=>ColdDatabase.build(meta,[row],candidate),/ANCHOR_COLD_WORKSPACE/);occupiedCandidate();assert.equal(candidate.used,0);
  const room=w.reserve(w.limit-w.used-out.bytes.length+1,'other live representations');assert.throws(()=>db.serialize(),/ANCHOR_COLD_WORKSPACE/);room();
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-if11-read-bound-'))),path=join(root,'bytes.bin');writeFileSync(path,Buffer.alloc(1024),{flag:'wx'});const read=new ColdWorkspace(),readHold=read.reserve(read.limit-1023,'other live representations');assert.throws(()=>readOwned(path,1024,read),/ANCHOR_COLD_WORKSPACE/);readHold();assert.equal(read.used,0);
 }finally{out.close();db.close();}assert.equal(w.used,0);
});
test('T05 cold layout rejects extra tables, indexes, altered metadata and freelist',()=>{
 const request=normalizeCold({operationId:'ac1-corrupt',expectedRouteEpoch:0}),meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:'a',custodyDomain:'i',operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:0,toEpoch:1,parentPayloadDigest:null,sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),counts:emptyCounts()},w=new ColdWorkspace(),source=ColdDatabase.build(meta,[],w),out=source.serialize();
 try{for(const sql of ['CREATE TABLE extra (x TEXT)','CREATE INDEX extra ON cold_receipts(operation_id)','PRAGMA user_version=2',"UPDATE cold_meta SET state='{}'"]){const db=new DatabaseSync(':memory:');try{db.deserialize(out.bytes);db.exec(sql);const mutated=db.serialize();assert.throws(()=>ColdDatabase.open(mutated,w));mutated.fill(0);}finally{db.close();}}}finally{out.close();source.close();}assert.equal(w.used,0);
});
test('T05 cold_meta views and generated expressions are rejected before any application data query',()=>{
 const request=normalizeCold({operationId:'ac1-layout-order',expectedRouteEpoch:0}),meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:'a',custodyDomain:'i',operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:0,toEpoch:1,parentPayloadDigest:null,sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),counts:emptyCounts()},w=new ColdWorkspace(),source=ColdDatabase.build(meta,[],w),out=source.serialize(),template=new DatabaseSync(':memory:');
 try{template.deserialize(out.bytes);const tables=template.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name<>'cold_meta' ORDER BY name").all().map(row=>row.sql as string);
  for(const malicious of ['CREATE VIEW cold_meta AS SELECT 1 AS id,abs(-9223372036854775808) AS state','CREATE TABLE cold_meta (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT GENERATED ALWAYS AS (abs(-9223372036854775808)) VIRTUAL) STRICT']){
   const db=new DatabaseSync(':memory:');try{db.exec(`PRAGMA page_size=4096;PRAGMA application_id=1094922545;PRAGMA user_version=1;${malicious};${tables.join(';')}`);const bytes=db.serialize(),prepare=DatabaseSync.prototype.prepare;let dataQueries=0;
    try{DatabaseSync.prototype.prepare=function(sql){if(/^SELECT .* FROM cold_meta(?:\s|$)/i.test(sql))dataQueries++;return prepare.call(this,sql);};assert.throws(()=>ColdDatabase.open(bytes,w),/ANCHOR_COLD_LAYOUT/);assert.equal(dataQueries,0);}finally{DatabaseSync.prototype.prepare=prepare;bytes.fill(0);}
   }finally{db.close();}
  }
 }finally{template.close();out.close();source.close();}assert.equal(w.used,0);
});
test('T04 accumulated cold image refuses its fixed 1MiB ceiling without changing the prior image',()=>{
 const request=normalizeCold({operationId:'ac1-full',expectedRouteEpoch:0}),meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:'a',custodyDomain:'i',operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:0,toEpoch:1,parentPayloadDigest:null,sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),counts:{...emptyCounts(),receipts:3}},w=new ColdWorkspace(),payload=Buffer.from(JSON.stringify({extra:'x'.repeat(262144)}));
 const rows:RawRow[]=Array.from({length:4},(_,i)=>({kind:'R',values:['vault',String(i),payload],epoch:1}));const prior=ColdDatabase.build(meta,rows.slice(0,3),w),before=prior.serialize();
 try{assert.ok(before.bytes.length<1048576);assert.throws(()=>ColdDatabase.build({...meta,counts:{...meta.counts,receipts:4}},rows,w,true),/full|ANCHOR_COLD_BOUND/);const after=prior.serialize();try{assert.equal(sha(after.bytes),sha(before.bytes));}finally{after.close();}}finally{before.close();prior.close();payload.fill(0);}assert.equal(w.used,0);
});
test('T04 physical FULL rolls back complete groups and metadata exactly, then permits a smaller group',()=>{
 const request=normalizeCold({operationId:'ac1-physical-fit',expectedRouteEpoch:1}),meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:'a',custodyDomain:'i',operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:1,toEpoch:2,parentPayloadDigest:'f'.repeat(64),sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),counts:{...emptyCounts(),receipts:1,operations:1}},w=new ColdWorkspace();
 const mandatory:RawRow[]=[{kind:'R',values:['prior','old',Buffer.from('{}')],epoch:1},{kind:'M',values:['ac1-prior',Buffer.from('{}'),Buffer.from('{}')],epoch:2}],db=ColdDatabase.build(meta,mandatory,w,true),body=Buffer.from(JSON.stringify({x:'x'.repeat(1068)}));assert.equal(body.length,1076);
 const candidates:RawRow[]=Array.from({length:224},(_,i)=>({kind:'R',values:['vault','row-'+String(i).padStart(32,'0'),body],epoch:2}));assert.ok(candidates.reduce((n,r)=>n+frameBytes(r),0)<=262144);
 const image=()=>{const bytes=db.serialize();try{return sha(bytes.bytes);}finally{bytes.close();}};let skipped=0;
 try{for(const [index,row] of candidates.entries()){const before=image(),prior=db.meta,next={...prior,selectionDigest:sha('trial-'+index),counts:{...prior.counts,receipts:prior.counts.receipts+1}};if(!db.tryGroup(next,[row])){skipped++;assert.equal(image(),before);assert.equal(db.meta,prior);}}
  assert.ok(skipped>0);assert.ok(db.meta.counts.receipts>200);const before=image(),prior=db.meta;
  // A pointer can fit while its segment needs more pages: both must roll back together.
  const pointer:RawRow={kind:'R',values:['vault','000-pointer',Buffer.from('@synthetic-complete-group-pointer')],epoch:2},payload=Buffer.alloc(100000,1),segment:RawRow={kind:'S',values:['full-if8',Buffer.from('{}'),sha(payload),100000,100000,1,99000,payload],epoch:2};
  assert.equal(db.tryGroup({...prior,selectionDigest:sha('whole-group'),counts:{...prior.counts,receipts:prior.counts.receipts+1,segments:1}},[pointer,segment]),false);assert.equal(image(),before);assert.equal([...db.rows('S')].length,0);payload.fill(0);
  const small:RawRow={kind:'L',values:['lineage','migration','new-vault',Buffer.from('{}')],epoch:2},next={...prior,selectionDigest:sha('small'),counts:{...prior.counts,legacy:1}},prepare=DatabaseSync.prototype.prepare;
  // An 8192-byte valid JSON state forces metadata overflow pages inside the same group transaction.
  try{DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql==='UPDATE cold_meta SET state=? WHERE id=1'){const run=statement.run;statement.run=function(...args){const value=args[0] as string;return (run as (...values:string[])=>ReturnType<typeof run>).call(this,value+' '.repeat(8192-Buffer.byteLength(value)));};}return statement;};assert.equal(db.tryGroup(next,[small]),false);assert.equal(image(),before);assert.equal(db.meta,prior);}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(db.tryGroup(next,[small]),true);const accepted=image();assert.throws(()=>db.tryGroup({...next,counts:{...next.counts,legacy:2}},[small]),error=>(error as {errcode?:number}).errcode!==13);assert.equal(image(),accepted);assert.equal(db.meta,next);
  for(const row of db.rows('M'))assert.equal(row.values[0],'ac1-prior');db.seal();assert.throws(()=>db.tryGroup(next,[]),/ANCHOR_COLD_TRANSACTION/);
 }finally{body.fill(0);db.close();}assert.equal(w.used,0);
});
test('T06 physical-fit snapshot W and altered rollback images are fatal, never skipped',()=>{
 const request=normalizeCold({operationId:'ac1-rollback-proof',expectedRouteEpoch:0}),meta:ColdMeta={format:COLD_FORMAT,version:1,authorityId:'a',custodyDomain:'i',operationId:request.operationId,requestDigest:sha(JSON.stringify(request)),fromEpoch:0,toEpoch:1,parentPayloadDigest:null,sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),counts:emptyCounts()},w=new ColdWorkspace(),db=ColdDatabase.build(meta,[],w,true),row:RawRow={kind:'R',values:['vault','op',Buffer.from('{}')],epoch:1},next={...meta,counts:{...meta.counts,receipts:1}},before=db.serialize();
 try{const hold=w.reserve(w.limit-w.used-before.bytes.length+1,'synthetic shared occupancy');try{assert.throws(()=>db.tryGroup(next,[row]),/ANCHOR_COLD_WORKSPACE/);}finally{hold();}
  const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;try{DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql.startsWith('INSERT INTO cold_receipts'))statement.run=()=>{throw Object.assign(Error('synthetic full'),{code:'ERR_SQLITE_ERROR',errcode:13});};return statement;};DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql==='ROLLBACK')exec.call(this,"UPDATE cold_meta SET state=state||' '");return result;};assert.throws(()=>db.tryGroup(next,[row]),/ANCHOR_COLD_ROLLBACK/);}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
 }finally{before.close();db.close();}assert.equal(w.used,0);
});
for(const point of ['open','read'] as const)test(`T06 growing file at ${point} never allocates or reads beyond its reserved length`,()=>{
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-if11-growth-'))),path=join(root,'growing.bin'),growth=Buffer.alloc(1048576,1);writeFileSync(path,Buffer.alloc(16),{flag:'wx'});
 const open=fs.openSync,read=fs.readSync,whole=fs.readFileSync,w=new ColdWorkspace();let armed=true,largestRead=0;
 try{
  fs.openSync=function(p,...args){if(point==='open'&&String(p)===path&&armed){armed=false;fs.appendFileSync(path,growth);}return (open as any).call(this,p,...args);};
  fs.readSync=function(fd,...args:any[]){const length=typeof args[2]==='number'?args[2]:0;largestRead=Math.max(largestRead,length);if(point==='read'&&armed){armed=false;fs.appendFileSync(path,growth);}return (read as any).call(this,fd,...args);};
  fs.readFileSync=function(p:fs.PathOrFileDescriptor,...args:any[]){if(String(p)===path)throw Error('SYNTHETIC_UNBOUNDED_READ');return (whole as any).call(this,p,...args);};syncBuiltinESMExports();
  assert.throws(()=>readOwned(path,2*1048576,w),/ANCHOR_COLD_FILE/);assert.ok(largestRead<=16);assert.equal(w.peak,17);assert.equal(w.used,0);
 }finally{fs.openSync=open;fs.readSync=read;fs.readFileSync=whole;syncBuiltinESMExports();}
 assert.equal(fs.statSync(path).size,1048576+16);
});
test('T01/T06 root-plus-reserves, single-file and exact namespace limits are independent physical gates',()=>{
 const base=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-if11-physical-')));
 const make=(name:string)=>{const path=join(base,name);fs.mkdirSync(path);writeFileSync(join(path,'authority.sqlite'),Buffer.alloc(4096),{flag:'wx'});return path;};
 const large=make('large');fs.truncateSync(join(large,'authority.sqlite'),52*1048576);boundSqlite(large,'authority.sqlite',67108864);assert.throws(()=>inspectFiles(large),/ANCHOR_COLD_BOUND/);
 const tooMany=make('names');for(let slot=0;slot<4;slot++){writeFileSync(join(tooMany,`cold-slot-${slot}.intent.json`),'x',{flag:'wx'});writeFileSync(join(tooMany,`cold-slot-${slot}.sqlite`),'x',{flag:'wx'});}writeFileSync(join(tooMany,'authority.sqlite-journal'),'x',{flag:'wx'});assert.equal(inspectFiles(tooMany).files,10);writeFileSync(join(tooMany,'extra'),'x',{flag:'wx'});assert.throws(()=>inspectFiles(tooMany),/ANCHOR_COLD_FILES/);
 for(const [name,bytes] of [['cold-slot-0.intent.json',8193],['cold-slot-0.sqlite',1048577]] as const){const path=make(String(bytes));writeFileSync(join(path,name),'',{flag:'wx'});fs.truncateSync(join(path,name),bytes);assert.throws(()=>inspectFiles(path),/ANCHOR_COLD_FILE/);}
 const hard=make('hard');writeFileSync(join(hard,'cold-slot-0.sqlite'),'x',{flag:'wx'});fs.linkSync(join(hard,'cold-slot-0.sqlite'),join(base,'retained-hardlink'));assert.throws(()=>inspectFiles(hard),/ANCHOR_COLD_FILE/);
 const alias=join(base,'junction');fs.symlinkSync(hard,alias,'junction');assert.throws(()=>inspectFiles(alias),/ANCHOR_COLD_PATH/);
});
