import assert from 'node:assert/strict';
import test from 'node:test';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {brotliCompressSync} from 'node:zlib';
import {COLD_SAFETY_PROFILE,MAX_COLD_PLAIN,MAX_COMPLETE_SAFETY,canonicalSafetyJSON,terminalEligible,validateColdDescriptor} from '../src/safety-format.ts';
import type {OrderedSafetyEntry,HotSafetyEnvelope,HotSafetyCarrier} from '../src/safety-format.ts';
import {SafetySegment,sealSafetySegment,coldAAD,configureSafetyRuntime} from '../src/safety-segment.ts';
import {SafetyLedger,allHotSafety,completeHotSafety} from '../src/safety-ledger.ts';
import {encodeHotSafetyCarrier,decodeHotSafetyCarrier,encodeSafetyCarrier,decodeSafetyCarrier} from '../src/safety-carrier.ts';
import {INCREMENTAL_FORMAT,generateKeySet,validateIdentity} from '../src/anchored-codec.ts';
import type {VaultIdentity} from '../src/anchored-codec.ts';
import type {Safety,Terminal} from '../src/durable-codec.ts';
import {sha} from '../src/durable-codec.ts';
import {freezeFrame,reconstruct} from '../src/incremental-storage.ts';
import {MAX_REPLAY_BYTES,MAX_PATCH} from '../src/incremental-codec.ts';

const identity:VaultIdentity={format:INCREMENTAL_FORMAT,authorityId:'a',vaultId:'v',identity:'synthetic',instanceId:'i',ownerEpoch:1,keyEpoch:1,
  directory:resolve('synthetic'),storageDomain:'payload',storageProfile:COLD_SAFETY_PROFILE,safetyCold:null};
const empty=():Safety=>({version:1,identity:'synthetic',maxCalls:32,reserved:0,ingress:[],lastSourceRef:null,lastAcknowledgedDeliveryId:null,lastWall:100});
const entry=(i:number,state:Terminal='failed')=>({key:sha(`key-${i}`),fingerprint:sha(`payload-${i}`),state,deliveryId:['ready','taken','acknowledged'].includes(state)?`delivery-${i}`:null,feedbackConsumed:state==='acknowledged',reserved:false});
const rows=():OrderedSafetyEntry[]=>[{ordinal:0,entry:entry(0)},{ordinal:2,entry:entry(2,'unknown')},{ordinal:4,entry:entry(4,'acknowledged')}];
function fixture(){const key=randomBytes(32),ordered=rows(),sealed=sealSafetySegment(ordered,identity,key),id={...identity,safetyCold:sealed.descriptor};return{key,ordered,sealed,id};}
function plainOf(f:ReturnType<typeof fixture>):Buffer{const b=f.sealed.bytes,c=createDecipheriv('aes-256-gcm',f.key,b.subarray(0,12));c.setAAD(coldAAD(f.id));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]);}
function modified(f:ReturnType<typeof fixture>,change:(db:DatabaseSync)=>void):{bytes:Buffer;id:VaultIdentity}{
  const db=new DatabaseSync(':memory:',{allowExtension:false}),plain=plainOf(f);let next:Uint8Array;
  try{db.deserialize(plain);db.exec('PRAGMA temp_store=MEMORY;PRAGMA journal_mode=MEMORY;PRAGMA cache_spill=OFF');change(db);next=db.serialize();}finally{plain.fill(0);db.close();}
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',f.key,iv);c.setAAD(coldAAD(f.id));const data=Buffer.concat([c.update(next),c.final()]),bytes=Buffer.concat([iv,c.getAuthTag(),data]);
  const d={...f.sealed.descriptor,plainDigest:sha(next),plainBytes:next.length,cipherDigest:sha(bytes),cipherBytes:bytes.length,file:`safety-${sha(bytes)}.bin`};next.fill(0);return{bytes,id:{...f.id,safetyCold:d}};
}

test('cold SQLite exact rows, extra JSON, globals and mixed ordinal union round-trip',()=>{
  const s=empty();s.ingress=[entry(0),entry(1,'pending'),entry(2,'unknown'),entry(3,'acknowledged'),entry(4,'acknowledged')];s.ingress[3]!.feedbackConsumed=false;
  Object.assign(s,{extension:{opaque:['中',true,null,4]}});Object.assign(s.ingress[0]!,{unknownField:{b:2,a:1}});
  const hot=allHotSafety(s),initial=new SafetyLedger(s,identity,32),partition=initial.archivePartition(),key=randomBytes(32),sealed=sealSafetySegment(partition.cold,identity,key),id={...identity,safetyCold:sealed.descriptor};
  const segment=SafetySegment.open(sealed.bytes,id,key),ledger=new SafetyLedger(s,id,32,partition.hot,segment);
  try{
    assert.equal(ledger.hotCount,2);assert.equal(ledger.coldCount,3);assert.equal(canonicalSafetyJSON(ledger.completeSafety()),canonicalSafetyJSON(s));
    assert.equal(ledger.lookupRequest(s.ingress[0]!.key)!.state,'failed');assert.equal(ledger.lookupDelivery('delivery-4')!.feedbackConsumed,true);
    assert.deepEqual(ledger.hotEnvelope().ingress.map(row=>row.ordinal),[1,3]);assert.equal(sealed.bytes.length,sealed.descriptor.plainBytes+28);
    assert.deepEqual(decodeHotSafetyCarrier(encodeHotSafetyCarrier(hot)),hot);
    ledger.boot();assert.equal(ledger.lookupRequest(s.ingress[1]!.key)!.state,'unknown');assert.equal(ledger.coldCount,3);
  }finally{ledger.close();initial.close();}
});

for(const budget of ['encoded','decoded'] as const)test(`P4 ${budget} 64 MiB recovery admission precedes malformed patch expansion`,()=>{
  const keys=generateKeySet(),s=empty();s.ingress=[entry(0)];const sealed=sealSafetySegment([{ordinal:0,entry:s.ingress[0]!}],identity,keys.storageDEK),id={...identity,safetyCold:sealed.descriptor},hot=allHotSafety(s);hot.ingress=[];
  const carrier=encodeHotSafetyCarrier(hot),files=new Map<string,Buffer>([[sealed.descriptor.file,sealed.bytes]]);let head:any=null;
  const seal=(plain:Buffer,purpose:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',keys.storageDEK,iv);c.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,purpose,id])));const body=Buffer.concat([c.update(plain),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);};
  const count=budget==='encoded'?8:5;
  for(let sequence=1;sequence<=count;sequence++){
    const payload=budget==='encoded'?Buffer.alloc(8*1024*1024):Buffer.from([0]);
    const blocks={mode:sequence===1?'base':'replace',codec:budget==='encoded'?'raw':'br4',rawLength:budget==='encoded'?payload.length:MAX_PATCH,
      targetLength:budget==='encoded'?payload.length:16*1024*1024,targetHash:sha('synthetic-image'),baseHash:sequence===1?null:sha('synthetic-image'),blockSize:4096};
    if(sequence===1)blocks.rawLength=blocks.targetLength;
    const header=Buffer.from(JSON.stringify({version:3,identity:id,sequence,safety:carrier,revocationHighWater:0,ingressKeyDigest:sha(keys.ingressKey),blocks,depth:sequence})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);
    const blob=seal(Buffer.concat([prefix,header,payload]),'frame'),row=seal(Buffer.from(JSON.stringify({version:3,identity:id,sequence,operationId:`forged-${sequence}`,previous:head?.digest??null,previousHead:head,parentHead:null,checkpointDigest:sha(blob),revocationHighWater:0})),'record');
    head={...id,sequence,digest:sha(row)};files.set(`blob-${sha(blob)}.bin`,blob);files.set(`record-${sequence}.bin`,row);payload.fill(0);
  }
  assert.throws(()=>reconstruct(head,name=>files.get(name)!,keys,32),/INCREMENTAL_REPLAY_LIMIT/);
  for(const bytes of files.values())bytes.fill(0);
});

test('all-hot null root, all-cold and no newly eligible terminal refusal',()=>{
  const s=empty(),ledger=new SafetyLedger(s,identity,32);assert.throws(()=>ledger.archivePartition(),/SAFETY_ARCHIVE_NO_TERMINALS/);
  const ordered=[{ordinal:0,entry:entry(0)}],key=randomBytes(32),sealed=sealSafetySegment(ordered,identity,key),id={...identity,safetyCold:sealed.descriptor};
  s.ingress=[ordered[0]!.entry];const hot=allHotSafety(s);hot.ingress=[];const cold=SafetySegment.open(sealed.bytes,id,key),l=new SafetyLedger(s,id,32,hot,cold);
  try{assert.equal(l.count,1);assert.equal(l.hotCount,0);assert.throws(()=>l.archivePartition(),/SAFETY_ARCHIVE_NO_TERMINALS/);}finally{l.close();ledger.close();}
});

for(const state of ['pending','ready','taken','acknowledged','failed','unknown'] as Terminal[])test(`eligibility is exact for ${state}`,()=>{
  const e=entry(0,state);e.feedbackConsumed=false;assert.equal(terminalEligible(e),state==='failed'||state==='unknown');
  if(state==='acknowledged'){e.feedbackConsumed=true;assert.equal(terminalEligible(e),true);}
  if(!terminalEligible(e))assert.throws(()=>sealSafetySegment([{ordinal:0,entry:e}],identity,randomBytes(32)),/SAFETY_COLD_ROWS/);
});

test('canonical JSON rejects lossy values, getters, holes, cycles and preserves arrays/unknown keys',()=>{
  const cycle:any={};cycle.self=cycle;
  for(const value of [undefined,NaN,Infinity,-0,1n,new Date(),[1,,2],{x:undefined},{get x(){throw Error('EXECUTED');}},cycle])assert.throws(()=>canonicalSafetyJSON(value),/SAFETY_JSON/);
  assert.equal(canonicalSafetyJSON({z:[3,2,1],a:{z:'中',a:true}}),'{"a":{"a":true,"z":"中"},"z":[3,2,1]}');
});

test('union rejects missing, duplicate, reordered, crossed key/delivery ordinals and overflow',()=>{
  const f=fixture(),s=empty();s.ingress=[entry(0),entry(1,'pending'),entry(2,'unknown'),entry(3,'pending'),entry(4,'acknowledged')];
  const valid=allHotSafety(s);valid.ingress=valid.ingress.filter(r=>[1,3].includes(r.ordinal));
  assert.equal(completeHotSafety(valid,f.ordered,f.id,32).ingress.length,5);
  const bad:HotSafetyEnvelope[]=[{...valid,ingress:valid.ingress.slice(1)},{...valid,ingress:[valid.ingress[1]!,valid.ingress[0]!]},{...valid,ingress:[{ordinal:0,entry:entry(1)},valid.ingress[1]!]},
    {...valid,ingress:[{ordinal:1,entry:{...entry(1),key:entry(0).key}},valid.ingress[1]!]},{...valid,ingress:[{ordinal:1,entry:{...entry(1),deliveryId:'delivery-4'}},valid.ingress[1]!]}];
  for(const h of bad)assert.throws(()=>completeHotSafety(h,f.ordered,f.id,32));
  assert.throws(()=>completeHotSafety(valid,f.ordered,{...f.id,safetyCold:null},32),/SAFETY_COLD_ROWS/);
});

test('P4 identity requires closed descriptor; all older profiles forbid it',()=>{
  const f=fixture();validateIdentity(f.id);
  const missing={...identity};delete missing.safetyCold;assert.throws(()=>validateIdentity(missing),/SAFETY_COLD_DESCRIPTOR/);
  for(const profile of ['blocks-br4-v1','full-br4-v1','blocks-br4-safety-br4-v1'])assert.throws(()=>validateIdentity({...identity,storageProfile:profile}),/ANCHOR_STORAGE_PROFILE/);
  const d=f.sealed.descriptor;
  for(const changed of [{extra:1},{entryCount:0},{entryCount:8193},{unknownCount:4},{reservedCount:-1},{file:'../outside'},{cipherBytes:d.cipherBytes+1},
    {plainBytes:MAX_COLD_PLAIN+4096,cipherBytes:MAX_COLD_PLAIN+4124},{plainBytes:4097,cipherBytes:4125},{entryDigest:'A'.repeat(64)}])assert.throws(()=>validateColdDescriptor({...d,...changed}),/SAFETY_COLD_DESCRIPTOR/);
});

test('hot carrier strict framing, BOM, UTF8, digest, length, concatenation and profile confusion',()=>{
  const h=allHotSafety(empty()),carrier=encodeHotSafetyCarrier(h),raw=Buffer.from(canonicalSafetyJSON(h));
  assert.ok(Buffer.byteLength(JSON.stringify(carrier))<=Buffer.byteLength(JSON.stringify({...carrier,codec:'raw',data:h})));
  const packed:HotSafetyCarrier={version:1,codec:'br4',decodedBytes:raw.length,digest:sha(raw),data:brotliCompressSync(raw).toString('base64')};
  const bad:any[]=[{...packed,extra:0},{...packed,digest:'0'.repeat(64)},{...packed,decodedBytes:1},{...packed,decodedBytes:MAX_COMPLETE_SAFETY+1},{...packed,data:'Zh=='},
    {...packed,data:Buffer.concat([Buffer.from(packed.data as string,'base64'),Buffer.from([0])]).toString('base64')},
    {...packed,data:Buffer.concat([Buffer.from(packed.data as string,'base64'),Buffer.from(packed.data as string,'base64')]).toString('base64')}];
  for(const x of bad)assert.throws(()=>decodeHotSafetyCarrier(x));
  for(const bytes of [Buffer.from([0xff]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),raw]),Buffer.concat([raw,Buffer.from(' ')]),raw.subarray(0,-1)]){
    assert.throws(()=>decodeHotSafetyCarrier({...packed,decodedBytes:bytes.length,digest:sha(bytes),data:brotliCompressSync(bytes).toString('base64')}));
  }
  const oldIdentity={...identity,storageProfile:'blocks-br4-safety-br4-v1' as const};delete oldIdentity.safetyCold;
  assert.throws(()=>decodeHotSafetyCarrier(encodeSafetyCarrier(empty(),oldIdentity,32) as any));
  assert.throws(()=>decodeSafetyCarrier(carrier as any,oldIdentity,32));
});

for(const field of ['authorityId','vaultId','identity','instanceId','ownerEpoch','keyEpoch','directory','storageDomain','schemaVersion','legacyImport'] as const)test(`cold AAD binds ${field}`,()=>{
  const f=fixture(),changed={...f.id,[field]:['ownerEpoch','keyEpoch','schemaVersion'].includes(field)?2:field==='legacyImport'?{lineageId:'a'.repeat(64),migrationId:`m2-import-${'a'.repeat(64)}`}:'different'};
  assert.throws(()=>SafetySegment.open(f.sealed.bytes,changed as VaultIdentity,f.key),/SAFETY_COLD_AUTH/);
});

test('cipher/plain/entry hashes and exact counts are independent; no context self-reference',()=>{
  const f=fixture();assert.deepEqual(coldAAD(f.id),coldAAD({...f.id,safetyCold:null}));
  for(const patch of [{plainDigest:'0'.repeat(64)},{entryDigest:'0'.repeat(64)},{entryCount:2},{reservedCount:1},{unknownCount:0}])assert.throws(()=>SafetySegment.open(f.sealed.bytes,{...f.id,safetyCold:{...f.sealed.descriptor,...patch}},f.key));
  assert.throws(()=>SafetySegment.open(f.sealed.bytes,f.id,randomBytes(32)),/SAFETY_COLD_AUTH/);
  assert.throws(()=>SafetySegment.open(f.sealed.bytes.subarray(1),f.id,f.key),/SAFETY_COLD_CIPHER/);
  assert.throws(()=>SafetySegment.open(Buffer.concat([f.sealed.bytes,Buffer.from([0])]),f.id,f.key),/SAFETY_COLD_CIPHER/);
});

for(const [name,sql] of [
  ['table','CREATE TABLE extra (n INTEGER)'],['view','CREATE VIEW extra AS SELECT * FROM entries'],['trigger','CREATE TRIGGER extra AFTER INSERT ON entries BEGIN SELECT 1; END'],
  ['index','CREATE INDEX extra ON entries(entry_json)'],['application-id','PRAGMA application_id=1'],['version','PRAGMA user_version=2'],
  ['key-index',"UPDATE entries SET request_key='wrong' WHERE ordinal=0"],['delivery-index',"UPDATE entries SET delivery_id='wrong' WHERE ordinal=0"],
  ['invalid-utf8',"UPDATE entries SET entry_json=CAST(x'FF' AS TEXT) WHERE ordinal=0"],['noncanonical',"UPDATE entries SET entry_json=entry_json||' ' WHERE ordinal=0"],
  ['missing-row','DELETE FROM entries WHERE ordinal=0'],['wrong-index-column','DROP TABLE entries; CREATE TABLE entries (request_key TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, delivery_id TEXT, entry_json TEXT NOT NULL UNIQUE) STRICT, WITHOUT ROWID']
] as const)test(`cold rejects authenticated but invalid SQLite ${name}`,()=>{
  const f=fixture(),m=modified(f,db=>db.exec(sql));assert.throws(()=>SafetySegment.open(m.bytes,m.id,f.key));
});

test('RAM temporary configuration is read back before cold DDL and import',()=>{
  const exec=DatabaseSync.prototype.exec;let ddl=0;
  try{DatabaseSync.prototype.exec=function(sql:string){if(sql.includes('CREATE TABLE entries'))ddl++;if(sql.includes('PRAGMA temp_store=MEMORY'))return;return exec.call(this,sql);};
    assert.throws(()=>sealSafetySegment(rows(),identity,randomBytes(32)),/SAFETY_COLD_RUNTIME/);assert.equal(ddl,0);
  }finally{DatabaseSync.prototype.exec=exec;}
});

test('cold RAM capability gate rejects each missing capability/readback without requiring FTS or a SQLite source ID',()=>{
  for(const problem of ['temp0','temp-missing','filename','extra-db','empty-db','transaction','temp-readback','journal-readback','spill-readback']){
    let statements=0;const fake={isTransaction:problem==='transaction',exec:()=>{statements++;},prepare:(sql:string)=>({
      all:()=>sql.includes('compile_options')?(problem==='temp-missing'?[]:[{compile_options:problem==='temp0'?'TEMP_STORE=0':'TEMP_STORE=1'}]):
        problem==='empty-db'?[]:problem==='extra-db'?[{name:'main',file:''},{name:'temp',file:''}]:[{name:'main',file:problem==='filename'?'named.sqlite':''}],
      get:()=>sql.includes('temp_store')?{temp_store:problem==='temp-readback'?1:2}:sql.includes('journal_mode')?{journal_mode:problem==='journal-readback'?'delete':'memory'}:{cache_spill:problem==='spill-readback'?1:0}
    })};
    assert.throws(()=>configureSafetyRuntime(fake as any),/SAFETY_COLD_RUNTIME/);
    assert.equal(statements,problem.endsWith('readback')?1:0);
  }
  const db=new DatabaseSync(':memory:',{allowExtension:false});try{configureSafetyRuntime(db);assert.equal(db.prepare('PRAGMA temp_store').get()!.temp_store,2);db.exec('BEGIN');assert.throws(()=>configureSafetyRuntime(db),/SAFETY_COLD_RUNTIME/);}finally{db.close();}
});

test('8192 structural fixture, 8193 refusal and maxCalls 0/32 are total logical bounds',()=>{
  for(const maxCalls of [0,32]){
    const s={...empty(),maxCalls,ingress:Array.from({length:8192},(_,i)=>entry(i))},ordered=s.ingress.map((e,ordinal)=>({ordinal,entry:e})),key=randomBytes(32),sealed=sealSafetySegment(ordered,identity,key),id={...identity,safetyCold:sealed.descriptor};
    const hot=allHotSafety(s);hot.ingress=[];const segment=SafetySegment.open(sealed.bytes,id,key),l=new SafetyLedger(s,id,maxCalls,hot,segment);
    try{assert.equal(l.count,8192);assert.throws(()=>l.append(entry(8192)),/ANCHOR_LIMIT/);assert.equal(l.completeSafety().ingress.length,8192);
      console.log('IF10_STRUCTURAL_BOUND',JSON.stringify({maxCalls,requests:8192,publicDurableOperations:0,logicalBytes:Buffer.byteLength(canonicalSafetyJSON(s)),coldPlainBytes:sealed.descriptor.plainBytes,coldCipherBytes:sealed.bytes.length}));
    }finally{l.close();}
    assert.throws(()=>new SafetyLedger({...s,ingress:[...s.ingress,entry(8192)]},{...identity,safetyCold:null},maxCalls));
  }
});

test('P4 recovery counts cold once and writer rebases at 15 frames with both budget constants',()=>{
  const keys=generateKeySet(),s=empty();s.ingress=[entry(0)];const ordered=[{ordinal:0,entry:s.ingress[0]!}],sealed=sealSafetySegment(ordered,identity,keys.storageDEK),id={...identity,safetyCold:sealed.descriptor},hot=allHotSafety(s);hot.ingress=[];
  const files=new Map<string,Buffer>([[sealed.descriptor.file,sealed.bytes]]),originalImage=randomBytes(65536);let baseline:any=null,head:any=null;
  for(let sequence=1;sequence<=16;sequence++){
    const image=Buffer.from(originalImage);image.writeUInt32BE(sequence);const frame=freezeFrame(id,sequence,`write-${sequence}`,image,s,0,keys,head,null,baseline,undefined,undefined,hot);
    assert.equal(frame.baseline.coldEncodedBytes,sealed.bytes.length);assert.equal(frame.baseline.coldDecodedBytes,sealed.descriptor.plainBytes);
    assert.ok(frame.baseline.decodedBytes>=sealed.descriptor.plainBytes);files.set(frame.stage.blob,frame.blob);files.set(`record-${sequence}.bin`,Buffer.from(frame.stage.record,'base64'));
    baseline=frame.baseline;head=frame.stage.head;
    const calls:string[]=[],d=reconstruct(head,(name,max)=>{calls.push(name);const bytes=files.get(name)!;assert.ok(bytes.length<=max);return bytes;},keys,32);
    try{assert.equal(calls.filter(x=>x===sealed.descriptor.file).length,1);assert.ok(d.files.size<=31);assert.equal(d.baseline.depth,sequence===16?1:sequence);
      if(sequence===15)assert.equal(d.files.size,31);assert.equal(d.baseline.readBytes,frame.baseline.readBytes);assert.equal(d.baseline.decodedBytes,frame.baseline.decodedBytes);}finally{d.image.fill(0);d.ledger.close();}
  }
  for(const budget of ['readBytes','decodedBytes']){
    const forced=freezeFrame(id,17,`budget-base-${budget}`,Buffer.from(originalImage),s,0,keys,head,null,{...baseline,depth:2,[budget]:MAX_REPLAY_BYTES},undefined,undefined,hot);
    assert.equal(forced.baseline.depth,1);assert.ok(forced.baseline.readBytes>sealed.bytes.length);assert.ok(forced.baseline.decodedBytes>=sealed.descriptor.plainBytes+originalImage.length);
  }
});

for(const budget of ['encoded','decoded'] as const)test(`P4 ${budget} recovery crosses 64 MiB only when the cold constant is counted`,()=>{
  const keys=generateKeySet(),s=empty();s.ingress=[entry(0)];const sealed=sealSafetySegment([{ordinal:0,entry:s.ingress[0]!}],identity,keys.storageDEK),coldIdentity={...identity,safetyCold:sealed.descriptor};
  const coldHot=allHotSafety(s);coldHot.ingress=[];const hotOnly=allHotSafety(s),count=4,largeHeader=budget==='encoded'?'x'.repeat(256*1024):'';
  const decodedTarget=MAX_REPLAY_BYTES-Math.floor(sealed.descriptor.plainBytes/2)-count*Math.max(encodeHotSafetyCarrier(coldHot).decodedBytes,encodeHotSafetyCarrier(hotOnly).decodedBytes);
  const payloadLengths:number[]=[];
  const make=(id:VaultIdentity,hot:HotSafetyEnvelope)=>{
    const files=new Map<string,Buffer>(),carrier=encodeHotSafetyCarrier(hot);if(id.safetyCold)files.set(id.safetyCold.file,sealed.bytes);
    let head:any=null,encoded=0,decoded=0;
    const encrypt=(plain:Buffer,purpose:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',keys.storageDEK,iv);c.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,purpose,id])));const body=Buffer.concat([c.update(plain),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);};
    for(let sequence=1;sequence<=count;sequence++){
      const rawLength=budget==='decoded'?Math.floor(decodedTarget/count)+(sequence===count?decodedTarget%count:0):payloadLengths[sequence-1]??(16*1024*1024-256*1024-4096);
      const build=(size:number)=>{
        const payload=Buffer.alloc(budget==='encoded'?size:1),blocks={mode:sequence===1?'base':'replace',codec:budget==='encoded'?'raw':'br4',rawLength:budget==='encoded'?size:rawLength,
          targetLength:sequence===1?(budget==='encoded'?size:rawLength):16*1024*1024,targetHash:sha('invalid-image'),baseHash:sequence===1?null:sha('invalid-image'),blockSize:4096};
        const header=Buffer.from(JSON.stringify({version:3,identity:id,sequence,safety:carrier,revocationHighWater:0,ingressKeyDigest:sha(keys.ingressKey),blocks,depth:sequence,padding:largeHeader})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);
        const blob=encrypt(Buffer.concat([prefix,header,payload]),'frame'),row=encrypt(Buffer.from(JSON.stringify({version:3,identity:id,sequence,operationId:`boundary-${sequence}`,previous:head?.digest??null,previousHead:head,parentHead:null,checkpointDigest:sha(blob),revocationHighWater:0})),'record');payload.fill(0);return{blob,row,rawLength:blocks.rawLength};
      };
      let size=rawLength,frame=build(size);
      if(budget==='encoded'&&id.safetyCold&&sequence===count){
        size+=MAX_REPLAY_BYTES-Math.floor(sealed.bytes.length/2)-encoded-frame.blob.length-frame.row.length;frame.blob.fill(0);frame.row.fill(0);frame=build(size);
      }
      if(id.safetyCold)payloadLengths.push(size);
      head={...id,sequence,digest:sha(frame.row)};files.set(`blob-${sha(frame.blob)}.bin`,frame.blob);files.set(`record-${sequence}.bin`,frame.row);
      encoded+=frame.blob.length+frame.row.length;decoded+=frame.rawLength+carrier.decodedBytes;
    }
    return{files,head,encoded,decoded};
  };
  const withCold=make(coldIdentity,coldHot);
  assert.ok(withCold.encoded<=MAX_REPLAY_BYTES);assert.ok(withCold.decoded<=MAX_REPLAY_BYTES);
  assert.ok((budget==='encoded'?withCold.encoded+sealed.bytes.length:withCold.decoded+sealed.descriptor.plainBytes)>MAX_REPLAY_BYTES);
  assert.throws(()=>reconstruct(withCold.head,name=>withCold.files.get(name)!,keys,32),/INCREMENTAL_REPLAY_LIMIT/);
  for(const[name,bytes]of withCold.files)if(!name.startsWith('safety-'))bytes.fill(0);withCold.files.clear();
  const withoutCold=make(identity,hotOnly);assert.ok(withoutCold.encoded<=MAX_REPLAY_BYTES);assert.ok(withoutCold.decoded<=MAX_REPLAY_BYTES);
  assert.throws(()=>reconstruct(withoutCold.head,name=>withoutCold.files.get(name)!,keys,32),/INCREMENTAL_DECODE|INCREMENTAL_HASH|INCREMENTAL_PATCH/);
  for(const bytes of withoutCold.files.values())bytes.fill(0);
});
