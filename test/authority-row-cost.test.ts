import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqlRows,utf8,ColdDatabase} from '../src/authority-cold-format.ts';
import * as coldFormat from '../src/authority-cold-format.ts';
import type {Release} from '../src/authority-cold-format.ts';
import {ColdWorkspace} from '../src/authority-cold-storage.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {AnchoredVault} from '../src/anchored-vault.ts';
import {generateKeySet} from '../src/anchored-codec.ts';
import {parseReceiptPointer,receiptPointer} from '../src/receipt-segments.ts';

const payloadSQL='SELECT vault_id AS c0,operation_id AS c1,CAST(receipt AS BLOB) AS c2 FROM receipts WHERE vault_id=? AND operation_id=?';
function rawFixture(t:TestContext){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE receipts(vault_id TEXT,operation_id TEXT,receipt TEXT,PRIMARY KEY(vault_id,operation_id))');
 const insert=db.prepare('INSERT INTO receipts VALUES (?,?,?)');for(const [key,text] of [['c',' {"c":3} '],['a','合成\n原字节'],['b','{"b":2}']])insert.run('v',key!,text!);
 const w=new ColdWorkspace(),prepare=db.prepare;let payloadPrepares=0,payloadGets=0,cursorReturns=0;
 db.prepare=function(sql){const s=prepare.call(this,sql);if(sql===payloadSQL){payloadPrepares++;const get=s.get;s.get=function(...args){payloadGets++;return Reflect.apply(get,this,args);};}
  if(sql.startsWith('SELECT substr(CAST(vault_id AS TEXT)')){const iterate=s.iterate;s.iterate=function(...args){const cursor=Reflect.apply(iterate,this,args) as ReturnType<typeof iterate>,close=cursor.return;cursor.return=function(){cursorReturns++;return close!.call(this);};return cursor;};}return s;};
 return{db,w,counts:()=>({payloadPrepares,payloadGets,cursorReturns}),rows:()=>sqlRows(db,'R','receipts',false,w)};
}

test('sqlRows prepares one payload per iterator while preserving ordered original bytes and fresh results',t=>{
 const f=rawFixture(t),seen:string[][]=[];for(const r of f.rows())seen.push([r.values[1] as string,utf8(r.values[2] as Uint8Array)]);
 assert.deepEqual(seen,[['a','合成\n原字节'],['b','{"b":2}'],['c',' {"c":3} ']]);assert.deepEqual(f.counts(),{payloadPrepares:1,payloadGets:3,cursorReturns:1});assert.equal(f.w.used,0);
 f.db.prepare('UPDATE receipts SET receipt=? WHERE operation_id=?').run('new value','a');const again=f.rows();const row=again.next().value!;assert.equal(utf8(row.values[2] as Uint8Array),'new value');again.return(undefined);assert.equal(f.counts().payloadPrepares,2);assert.equal(f.w.used,0);
});

test('sqlRows nested same-kind cursors have independent statements and early return erases only their own row',t=>{
 const f=rawFixture(t),outer=f.rows(),first=outer.next().value!,bytes=first.values[2] as Uint8Array,original=Buffer.from(bytes),used=f.w.used;
 const inner=f.rows(),nested=inner.next().value!,nestedBytes=nested.values[2] as Uint8Array;assert.ok(f.w.used>used);inner.return(undefined);
 assert.ok(nestedBytes.every(b=>b===0));assert.deepEqual(Buffer.from(bytes),original);assert.equal(f.w.used,used);assert.equal(outer.next().value!.values[1],'b');assert.ok(bytes.every(b=>b===0));outer.return(undefined);
 assert.deepEqual(f.counts(),{payloadPrepares:2,payloadGets:3,cursorReturns:2});assert.equal(f.w.used,0);
});

test('sqlRows consumer throw, generator throw and keepParsed retain the original ownership contract',t=>{
 const f=rawFixture(t);let bytes:Uint8Array|undefined;
 assert.throws(()=>{for(const row of f.rows()){bytes=row.values[2] as Uint8Array;throw Error('CONSUMER');}},/CONSUMER/);assert.ok(bytes!.every(b=>b===0));assert.equal(f.w.used,0);
 const thrown=f.rows(),row=thrown.next().value!;bytes=row.values[2] as Uint8Array;assert.throws(()=>thrown.throw(Error('GENERATOR')),/GENERATOR/);assert.ok(bytes.every(b=>b===0));assert.equal(f.w.used,0);
 const kept=f.rows(),held=kept.next().value!,release=held.keepParsed!(),both=f.w.used;assert.throws(()=>held.keepParsed!(),/ANCHOR_COLD_WORKSPACE/);kept.return(undefined);
 assert.ok((held.values[2] as Uint8Array).every(b=>b===0));assert.equal(f.w.used,both/2);release();release();assert.equal(f.w.used,0);assert.equal(f.counts().cursorReturns,3);
});

test('sqlRows bounds and both workspace refusals precede payload allocation and close the selector',t=>{
 const f=rawFixture(t),original=f.w.reserve;for(const label of ['SQL row and transient UTF8 representation','SQL parsed representation']){
  let hold:Release|undefined;
  f.w.reserve=function(bytes,name){if(name===label){hold=original.call(this,this.limit-this.used-bytes+1,'synthetic occupancy');}return original.call(this,bytes,name);};
  try{assert.throws(()=>f.rows().next(),/ANCHOR_COLD_WORKSPACE/);}finally{hold?.();f.w.reserve=original;}assert.equal(f.w.used,0);
 }
 assert.deepEqual(f.counts(),{payloadPrepares:0,payloadGets:0,cursorReturns:2});
 f.db.prepare('UPDATE receipts SET vault_id=?').run('x'.repeat(257));assert.throws(()=>f.rows().next(),/ANCHOR_COLD_BOUND/);assert.equal(f.counts().payloadPrepares,0);assert.equal(f.counts().cursorReturns,3);assert.equal(f.w.used,0);
});

test('sqlRows payload failure and length mismatch release the row and cursor without caching a result',t=>{
 const f=rawFixture(t),prepare=f.db.prepare;let fault:'throw'|'length'='throw';
 f.db.prepare=function(sql){const s=prepare.call(this,sql);if(sql===payloadSQL){const get=s.get;s.get=function(...args){if(fault==='throw')throw Error('PAYLOAD_GET');const r=Reflect.apply(get,this,args)!;return{...r,c2:Buffer.alloc(1)};};}return s;};
 assert.throws(()=>f.rows().next(),/PAYLOAD_GET/);assert.equal(f.w.used,0);fault='length';assert.throws(()=>f.rows().next(),/ANCHOR_COLD_CORRUPT/);assert.equal(f.w.used,0);assert.equal(f.counts().cursorReturns,2);
 f.db.prepare=prepare;const again=f.rows();assert.equal(again.next().value!.values[1],'a');again.return(undefined);assert.equal(f.w.used,0);
});

function authorityFixture(t:TestContext,version:4|5|6){
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-row-cost-'))),ac={directory:join(root,'a'),authorityId:'synthetic',custodyDomain:'independent'};
 LocalSqliteAuthority.create(ac).close();LocalSqliteAuthority.upgradeSchema(ac,'operator-attested-stopped');LocalSqliteAuthority.upgradeReceiptSchema(ac,'operator-attested-stopped');
 if(version>=5)LocalSqliteAuthority.upgradeColdSchema(ac,'operator-attested-stopped');if(version===6)LocalSqliteAuthority.upgradeShardedColdSchema(ac,'operator-attested-stopped');
 const authority=LocalSqliteAuthority.open(ac),config={directory:join(root,'v'),vaultId:'v',identity:'s',storageDomain:'p',storageProfile:'blocks-br4-v1' as const,keys:generateKeySet(),authority};
 const vault=AnchoredVault.create(config,0,{clock:{wall:()=>100,monotonic:()=>0}});for(let i=0;i<35;i++)vault.claim('key-'+i,'p');
 const roll=authority.rolloverReceipts({operationId:'if8-cost'});t.after(()=>{vault.close();authority.close();});return{root,ac,authority,vault,roll};
}
for(const version of [5,6] as const)test(`schema${version} IF8 closure bounds preparation and rereads every full key in each new closure`,t=>{
 const f=authorityFixture(t,version),prepare=DatabaseSync.prototype.prepare,create=DatabaseSync.prototype.createTagStore;let exactSelectors=0;const stores:{gets:number;maxSize:number;cleared:boolean;keys:string[]}[]=[];
 try{DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('SELECT substr(CAST(vault_id AS TEXT)')&&sql.includes('FROM receipts WHERE vault_id=? AND operation_id=? ORDER BY'))exactSelectors++;return prepare.call(this,sql);};
  DatabaseSync.prototype.createTagStore=function(capacity){assert.equal(capacity,2);const store=create.call(this,capacity),record={gets:0,maxSize:0,cleared:false,keys:[] as string[]};stores.push(record);const get=store.get,clear=store.clear;
   store.get=function(strings,...args){assert.equal(args.length,2);record.gets++;record.keys.push(JSON.stringify(args));const result=Reflect.apply(get,this,[strings,...args]);record.maxSize=Math.max(record.maxSize,store.size);return result;};store.clear=function(){clear.call(this);assert.equal(store.size,0);record.cleared=true;};return store;};
  f.authority.transaction(()=>{});f.authority.transaction(()=>{});
 }finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.createTagStore=create;}
 assert.equal(exactSelectors,0);assert.equal(stores.length,2);for(const s of stores){assert.equal(s.maxSize,2);assert.equal(s.gets,2*f.roll.receiptCount);assert.equal(new Set(s.keys).size,f.roll.receiptCount);assert.equal(s.cleared,true);}
 const db=new DatabaseSync(join(f.ac.directory,'authority.sqlite'));try{
  const row=db.prepare('SELECT * FROM receipts ORDER BY vault_id,operation_id LIMIT 1').get()!,pointer=parseReceiptPointer(row.receipt as string)!;
  const restore=()=>db.prepare('INSERT OR REPLACE INTO receipts VALUES (?,?,?)').run(row.vault_id!,row.operation_id!,row.receipt!);
  try{db.prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?').run(receiptPointer(pointer.segmentId,(pointer.index+1)%128,pointer.jsonBytes),row.vault_id!,row.operation_id!);assert.throws(()=>f.authority.transaction(()=>{}),/ANCHOR_RECEIPT_SEGMENT/);}finally{restore();}
  try{db.prepare('DELETE FROM receipts WHERE vault_id=? AND operation_id=?').run(row.vault_id!,row.operation_id!);assert.throws(()=>f.authority.transaction(()=>{}),/ANCHOR_RECEIPT_SEGMENT/);}finally{restore();}
  try{db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('orphan','orphan',row.receipt!);assert.throws(()=>f.authority.transaction(()=>{}),/ANCHOR_RECEIPT_SEGMENT/);}finally{db.prepare('DELETE FROM receipts WHERE vault_id=?').run('orphan');}
 }finally{db.close();}
 assert.deepEqual(f.authority.rolloverReceipts({operationId:'if8-cost'}),f.roll);
});

test('schema4 rollover helper keeps exact retry, conflict and damaged-pointer behavior',t=>{
 const f=authorityFixture(t,4);assert.deepEqual(f.authority.rolloverReceipts({operationId:'if8-cost'}),f.roll);assert.throws(()=>f.authority.rolloverReceipts({operationId:'if8-cost',maxReceipts:127}),/ANCHOR_ROLLOVER_CONFLICT/);
 const db=new DatabaseSync(join(f.ac.directory,'authority.sqlite'));try{const row=db.prepare('SELECT * FROM receipts LIMIT 1').get()!,p=parseReceiptPointer(row.receipt as string)!;db.prepare('UPDATE receipts SET receipt=? WHERE vault_id=? AND operation_id=?').run(receiptPointer(p.segmentId,(p.index+1)%128,p.jsonBytes),row.vault_id!,row.operation_id!);assert.throws(()=>f.authority.rolloverReceipts({operationId:'if8-cost'}),/ANCHOR_RECEIPT_SEGMENT/);}finally{db.close();}
});

test('cold IF8 closure rejects a wrong hot/cold tier but permits different positive epochs',t=>{
 const f=authorityFixture(t,5);f.authority.archivePermanentKeys({operationId:'ac1-cost-1',expectedRouteEpoch:0});for(let i=0;i<35;i++)f.vault.claim('second-'+i,'p');f.authority.archivePermanentKeys({operationId:'ac1-cost-2',expectedRouteEpoch:1});
 // Fault injection only at the exact row reader: no persistent bytes or digest
 // are rewritten. Whole-image validation still reads the unchanged real rows.
 const make=ColdDatabase.prototype.receiptReader;let epoch=0,hits=0,badSecond=false;
 try{ColdDatabase.prototype.receiptReader=function(){const reader=make.call(this),using=reader.using;reader.using=function(vault,operation,body){return using.call(this,vault,operation,row=>{
   if(parseReceiptPointer(utf8(row.values[2] as Uint8Array))){hits++;return body({...row,epoch,...(badSecond&&hits===2?{values:[row.values[0]!,row.values[1]!,new Uint8Array([255])]}:{})});}return body(row);
  }) as ReturnType<typeof body>;};return reader;};
  assert.throws(()=>f.authority.transaction(()=>{}),/ANCHOR_RECEIPT_SEGMENT/);assert.ok(hits>0);
  badSecond=true;hits=0;assert.throws(()=>f.authority.transaction(()=>{}),/ANCHOR_COLD_UTF8/);assert.equal(hits,2);badSecond=false;
  epoch=2;hits=0;f.authority.transaction(()=>{});assert.ok(hits>0);
 }finally{ColdDatabase.prototype.receiptReader=make;}
 assert.deepEqual(f.authority.rolloverReceipts({operationId:'if8-cost'}),f.roll);
});

test('fixed receipt reader has two shapes, fresh bindings/results and no shared full-scan cursor',t=>{
 const f=rawFixture(t),create=f.db.createTagStore,stores:ReturnType<typeof create>[]=[];f.db.createTagStore=function(cap){assert.equal(cap,2);const s=create.call(this,cap);stores.push(s);return s;};
 const reader=new coldFormat.ReceiptKeyReader(f.db,false,f.w);assert.equal(f.w.used,65536);let bytes:Uint8Array|undefined;
 reader.using('v','a',row=>{bytes=row.values[2] as Uint8Array;assert.equal(utf8(bytes),'合成\n原字节');assert.throws(()=>reader.using('v','b',()=>0),/ANCHOR_COLD_READER_BUSY/);assert.throws(()=>reader.close(),/ANCHOR_COLD_READER_BUSY/);
  const seen=[];for(const other of f.rows())seen.push(other.values[1]);assert.deepEqual(seen,['a','b','c']);assert.equal(utf8(bytes),'合成\n原字节');});
 assert.ok(bytes!.every(b=>b===0));assert.equal(reader.using('v','absent',()=>true),undefined);
 f.db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('v','absent','newly present');assert.equal(reader.using('v','absent',r=>utf8(r.values[2] as Uint8Array)),'newly present');
 f.db.prepare('UPDATE receipts SET receipt=? WHERE operation_id=?').run('updated','a');assert.equal(reader.using('v','a',r=>utf8(r.values[2] as Uint8Array)),'updated');assert.equal(reader.using('v','b',r=>utf8(r.values[2] as Uint8Array)),'{"b":2}');
 assert.equal(stores.length,1);assert.equal(stores[0]!.capacity,2);assert.equal(stores[0]!.size,2);reader.close();reader.close();assert.equal(stores[0]!.size,0);assert.equal(f.w.used,0);assert.throws(()=>reader.using('v','a',()=>0),/ANCHOR_COLD_CLOSED/);
 const fresh=new coldFormat.ReceiptKeyReader(f.db,false,f.w);assert.equal(stores[1]!.size,0);assert.equal(fresh.using('v','a',r=>utf8(r.values[2] as Uint8Array)),'updated');assert.equal(stores[1]!.size,2);fresh.close();assert.equal(f.w.used,0);
});

test('fixed receipt reader ends actual row ownership on return/throw, including keepParsed and mutated public values',t=>{
 const f=rawFixture(t),reader=new coldFormat.ReceiptKeyReader(f.db,false,f.w);let bytes:Uint8Array|undefined,keep:Release|undefined;
 try{assert.throws(()=>reader.using('v','a',r=>{bytes=r.values[2] as Uint8Array;(bytes as Uint8Array&{fill:()=>never}).fill=()=>{throw Error('OWN_FILL');};r.values[2]=new Uint8Array(1);throw Error('BODY');}),/BODY/);assert.ok(bytes!.every(b=>b===0));assert.equal(f.w.used,65536);
  reader.using('v','b',r=>{bytes=r.values[2] as Uint8Array;keep=r.keepParsed!();assert.throws(()=>r.keepParsed!(),/ANCHOR_COLD_WORKSPACE/);});assert.ok(bytes!.every(b=>b===0));assert.ok(f.w.used>65536);reader.close();assert.ok(f.w.used>0);keep!();keep!();assert.equal(f.w.used,0);
 }finally{reader.close();keep?.();}
});

test('fixed reader metadata, both row tickets and overlength bounds refuse before payload get',t=>{
 const f=rawFixture(t),create=f.db.createTagStore;let creates=0,payload=0,badBounds=false;
 f.db.createTagStore=function(cap){creates++;const s=create.call(this,cap),get=s.get;s.get=function(strings,...args){const isPayload=strings[0]!.startsWith('SELECT vault_id');if(isPayload)payload++;const row=Reflect.apply(get,this,[strings,...args]);return badBounds&&!isPayload&&row?{...row,n0:257}:row;};return s;};
 const tight=new ColdWorkspace(),occupied=tight.reserve(tight.limit-65535,'synthetic existing residents');assert.throws(()=>new coldFormat.ReceiptKeyReader(f.db,false,tight),/ANCHOR_COLD_WORKSPACE/);assert.equal(tight.used,tight.limit-65535);occupied();assert.equal(tight.used,0);assert.equal(creates,0);
 const reader=new coldFormat.ReceiptKeyReader(f.db,false,f.w),reserve=f.w.reserve;try{
  for(const target of ['SQL row and transient UTF8 representation','SQL parsed representation']){let held:Release|undefined;f.w.reserve=function(n,label){if(label===target)held=reserve.call(this,this.limit-this.used-n+1,'synthetic pressure');return reserve.call(this,n,label);};try{assert.throws(()=>reader.using('v','a',()=>0),/ANCHOR_COLD_WORKSPACE/);}finally{held?.();f.w.reserve=reserve;}assert.equal(f.w.used,65536);assert.equal(payload,0);}
  badBounds=true;assert.throws(()=>reader.using('v','a',()=>0),/ANCHOR_COLD_BOUND/);assert.equal(payload,0);badBounds=false;assert.equal(reader.using('v','a',r=>utf8(r.values[2] as Uint8Array)),'合成\n原字节');
 }finally{reader.close();}assert.equal(f.w.used,0);
});

function receiptSources(t:TestContext){const w=new ColdWorkspace(),dbs=[false,true,true].map(cold=>{const db=new DatabaseSync(':memory:');db.exec(cold?'CREATE TABLE cold_receipts(vault_id TEXT,operation_id TEXT,receipt_utf8 BLOB,moved_epoch INTEGER,PRIMARY KEY(vault_id,operation_id))':'CREATE TABLE receipts(vault_id TEXT,operation_id TEXT,receipt TEXT,PRIMARY KEY(vault_id,operation_id))');return db;});t.after(()=>{for(const db of dbs)db.close();});return{w,dbs,readers:dbs.map((db,i)=>new coldFormat.ReceiptKeyReader(db,i>0,w))};}
test('fixed readers preload all three sources, detect duplicate before interpretation, and release refused rows',t=>{
 const f=receiptSources(t),held:Uint8Array[]=[];let calls=0;const create=DatabaseSync.prototype.createTagStore;
 // Instrument the existing owners through the fixed reader callback, while the
 // third source's SQL failure proves it is visited even after two matches.
 f.dbs[0]!.prepare('INSERT INTO receipts VALUES (?,?,?)').run('v','x','first');f.dbs[1]!.prepare('INSERT INTO cold_receipts VALUES (?,?,?,?)').run('v','x',Buffer.from('second'),1);
 for(const reader of f.readers){const using=reader.using;reader.using=function(v,o,body){return using.call(this,v,o,row=>{held.push(row.values[2] as Uint8Array);return body(row);}) as ReturnType<typeof body>;};}
 try{
  f.dbs[2]!.exec('DROP TABLE cold_receipts');assert.throws(()=>coldFormat.usingReceiptKeys(f.readers,'v','x',()=>{calls++;return 1;}),/no such table/);assert.equal(calls,0);assert.ok(held.every(b=>b.every(v=>v===0)));assert.equal(f.w.used,3*65536);
  f.dbs[2]!.exec('CREATE TABLE cold_receipts(vault_id TEXT,operation_id TEXT,receipt_utf8 BLOB,moved_epoch INTEGER,PRIMARY KEY(vault_id,operation_id))');assert.throws(()=>coldFormat.usingReceiptKeys(f.readers,'v','x',()=>{calls++;return 1;}),/ANCHOR_COLD_DUPLICATE/);assert.equal(calls,0);assert.equal(f.w.used,3*65536);
  f.dbs[0]!.exec('DELETE FROM receipts');assert.equal(coldFormat.usingReceiptKeys(f.readers,'v','x',r=>utf8(r.values[2] as Uint8Array)),'second');assert.equal(coldFormat.usingReceiptKeys(f.readers,'v','missing',()=>true),undefined);
 }finally{for(const reader of f.readers)reader.close();DatabaseSync.prototype.createTagStore=create;}assert.equal(f.w.used,0);
});

test('fixed reader partial multi-source preload refusal erases prior rows and releases every ticket',t=>{
 const f=receiptSources(t);f.dbs[0]!.prepare('INSERT INTO receipts VALUES (?,?,?)').run('v','x','first');for(const db of f.dbs.slice(1))db.prepare('INSERT INTO cold_receipts VALUES (?,?,?,?)').run('v','x',Buffer.from('cold'),1);
 const bytes:Uint8Array[]=[];for(const reader of f.readers){const using=reader.using;reader.using=function(v,o,body){return using.call(this,v,o,row=>{bytes.push(row.values[2] as Uint8Array);return body(row);}) as ReturnType<typeof body>;};}
 const reserve=f.w.reserve;let seen=0,hold:Release|undefined;f.w.reserve=function(n,label){if(label==='SQL parsed representation'&&++seen===3)hold=reserve.call(this,this.limit-this.used-n+1,'synthetic third-source pressure');return reserve.call(this,n,label);};
 try{assert.throws(()=>coldFormat.usingReceiptKeys(f.readers,'v','x',()=>1),/ANCHOR_COLD_WORKSPACE/);}finally{hold?.();f.w.reserve=reserve;for(const reader of f.readers)reader.close();}assert.equal(seen,3);assert.equal(bytes.length,2);assert.ok(bytes.every(b=>b.every(v=>v===0)));assert.equal(f.w.used,0);
});

test('schema6 closure clears earlier fixed owners when creating owner two or three fails',t=>{
 const f=authorityFixture(t,6),cap=f.authority.inspectCapacity().shardedColdRouting!;f.authority.archivePermanentKeysV2({operationId:'ac2-reader',expectedRouteEpoch:cap.generation,expectedManifestDigest:cap.manifestDigest});
 const create=DatabaseSync.prototype.createTagStore,reserve=ColdWorkspace.prototype.reserve;let workspace:ColdWorkspace|undefined;
 for(const target of [2,3]){let created=0;const stores:ReturnType<typeof create>[]=[];
  try{ColdWorkspace.prototype.reserve=function(n,label){workspace=this;return reserve.call(this,n,label);};DatabaseSync.prototype.createTagStore=function(capacity){if(++created===target)throw Error('CREATE_OWNER');const s=create.call(this,capacity);stores.push(s);return s;};assert.throws(()=>f.authority.transaction(()=>{}),/CREATE_OWNER/);
  }finally{DatabaseSync.prototype.createTagStore=create;ColdWorkspace.prototype.reserve=reserve;}assert.equal(created,target);assert.ok(stores.every(s=>s.size===0));assert.equal(workspace!.used,0);
 }
 const stores:ReturnType<typeof create>[]=[];try{
  ColdWorkspace.prototype.reserve=function(n,label){workspace=this;return reserve.call(this,n,label);};DatabaseSync.prototype.createTagStore=function(capacity){const s=create.call(this,capacity),clear=s.clear,index=stores.length;stores.push(s);s.clear=function(){clear.call(this);if(index===0)throw Error('CLEAR_OWNER');};return s;};assert.throws(()=>f.authority.transaction(()=>{}),/CLEAR_OWNER/);
 }finally{DatabaseSync.prototype.createTagStore=create;ColdWorkspace.prototype.reserve=reserve;}assert.equal(stores.length,3);assert.ok(stores.every(s=>s.size===0));assert.equal(workspace!.used,0);
 f.authority.transaction(()=>{});
});
