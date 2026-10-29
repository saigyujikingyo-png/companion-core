import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqlRows,utf8,ColdDatabase} from '../src/authority-cold-format.ts';
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
for(const version of [5,6] as const)test(`schema${version} IF8 closure performs one real exact pointer read per entry and keeps both directions`,t=>{
 const f=authorityFixture(t,version),prepare=DatabaseSync.prototype.prepare;let exactSelectors=0;
 try{DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('SELECT substr(CAST(vault_id AS TEXT)')&&sql.includes('FROM receipts WHERE vault_id=? AND operation_id=? ORDER BY'))exactSelectors++;return prepare.call(this,sql);};f.authority.transaction(()=>{});}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(exactSelectors,f.roll.receiptCount);
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
 const rows=ColdDatabase.prototype.rows;let epoch=0,hits=0;
 try{ColdDatabase.prototype.rows=function*(kind,index,value,secondary){for(const row of rows.call(this,kind,index,value,secondary)){
   if(kind==='R'&&index!==undefined&&parseReceiptPointer(utf8(row.values[2] as Uint8Array))){hits++;yield{...row,epoch};}else yield row;
  }};
  assert.throws(()=>f.authority.transaction(()=>{}),/ANCHOR_RECEIPT_SEGMENT/);assert.ok(hits>0);epoch=2;hits=0;f.authority.transaction(()=>{});assert.ok(hits>0);
 }finally{ColdDatabase.prototype.rows=rows;}
 assert.deepEqual(f.authority.rolloverReceipts({operationId:'if8-cost'}),f.roll);
});
