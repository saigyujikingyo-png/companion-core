import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemoryStore} from '../src/store.ts';
import {StoreColdSegment,selectStoreCold,sealStoreSegment,splitStoreImage,joinStoreImage,storeLogicalFingerprint,storeColdAAD} from '../src/store-cold.ts';
import {STORE_COLD_PROFILE,validateStoreColdDescriptor} from '../src/store-cold-format.ts';
import {validateIdentity} from '../src/anchored-codec.ts';
import type {VaultIdentity} from '../src/anchored-codec.ts';
import {schemaSQL,schemaHash,expectedLayoutHash,inspectMemoryImage} from '../src/memory-image.ts';
import {MAX_IMAGE,sha} from '../src/durable-codec.ts';
const who={tenantId:'tenant',subjectId:'subject',personaId:'character',relationshipId:'relationship'};
const input=(eventKey:string)=>({source:'synthetic',eventKey,evidence:{speakerId:'subject',speakerRole:'subject' as const,mode:'self_report' as const,selectedText:'synthetic retained key',occurredAt:null}});
const identity:VaultIdentity={format:'companion-anchored-vault-v3',authorityId:'a',vaultId:'v',identity:'synthetic',instanceId:'i',ownerEpoch:1,keyEpoch:1,
  directory:resolve('synthetic'),storageDomain:'payload',storageProfile:STORE_COLD_PROFILE,safetyCold:null,storeCold:null};
function fixture(schema:1|2=1){const store=new MemoryStore(':memory:',{schemaVersion:schema,clock:{wall:()=>100,monotonic:()=>0}}),scope=store.ensureScope(who),ref=store.acceptEvent(scope,input('old'));
  store.purge(scope);const image=store.snapshot();store.close();return{image,ref,scope};}
function segment(image:Uint8Array,schema:1|2=1,previous?:StoreColdSegment){const plain=selectStoreCold(image,schema,previous),key=randomBytes(32),id={...identity,...(schema===2?{schemaVersion:2 as const}:{})},sealed=sealStoreSegment(plain,id,key);
  id.storeCold=sealed.descriptor;return{plain,key,id,sealed,cold:StoreColdSegment.open(sealed.bytes,id,key)};}
function edited(image:Uint8Array,sql:string):Uint8Array{const db=new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});try{db.deserialize(image);db.exec(sql);return db.serialize();}finally{db.close();}}

for(const schema of [1,2] as const)test(`schema${schema} split/join preserves complete logical rows and cold references`,()=>{
  const f=fixture(schema),s=segment(f.image,schema);try{const split=splitStoreImage(f.image,schema,s.cold),joined=joinStoreImage(split.image,schema,s.cold,split.fingerprint);
    assert.equal(storeLogicalFingerprint(joined,schema),storeLogicalFingerprint(f.image,schema));assert.equal(s.sealed.descriptor.counts.nodes,1);assert.equal(s.sealed.descriptor.counts.ingress,1);
    const store=new MemoryStore(':memory:',{image:joined,schemaVersion:schema,clock:{wall:()=>100,monotonic:()=>0}});try{const scope=store.scope(f.scope.id);assert.equal(store.acceptEvent(scope,input('old')).currentStatus,'revoked');assert.throws(()=>store.acceptEvent(scope,{...input('old'),evidence:{...input('old').evidence,selectedText:'conflict'}}),/IDEMPOTENCY_CONFLICT/);}finally{store.close();}
  }finally{s.cold.close();}
});
test('raw TEXT bytes and 64-bit INTEGER retain exact type/value across split/join',()=>{
  const f=fixture(),image=edited(f.image,`INSERT INTO meta VALUES ('opaque',CAST(x'ff00c080' AS TEXT)); UPDATE nodes SET created_at=9223372036854775807,valid_from=-9223372036854775808; UPDATE ingress SET payload_hash=CAST(x'ff' AS TEXT);
    INSERT INTO jobs(id,scope_id,kind,generation,consent_revision,refs,status,lease_deadline) VALUES ('real','${f.scope.id}','memory',0,0,'[]','revoked',0.1)`);
  const s=segment(image);try{const split=splitStoreImage(image,1,s.cold),joined=joinStoreImage(split.image,1,s.cold,split.fingerprint);assert.equal(storeLogicalFingerprint(image,1),storeLogicalFingerprint(joined,1));}finally{s.cold.close();}
});
test('first candidate over one MiB refuses; full logical image still bounded at sixteen MiB',()=>{
  const f=fixture(),db=new DatabaseSync(':memory:');let image:Uint8Array;
  try{db.deserialize(f.image);db.exec('BEGIN');const stmt=db.prepare("INSERT INTO nodes(id,scope_id,type,revision,generation,consent_revision,status,body,created_at) VALUES (?,?,'event',1,0,0,'revoked',NULL,100)");
    for(let i=0;i<1000;i++)stmt.run(`large-${i}`.padEnd(512,'x'),f.scope.id);db.exec('COMMIT');image=db.serialize();
  }finally{db.close();}
  assert.ok(image.length<16*1024*1024);assert.throws(()=>selectStoreCold(image,1),/STORE_COLD_LIMIT/);assert.throws(()=>splitStoreImage(Buffer.alloc(16*1024*1024+1),1),/STORE_COLD_LIMIT/);
});
test('64 KiB source pages cannot allocate an oversized 4 KiB hot/full serialized target',t=>{
  const db=new DatabaseSync(':memory:');let image:Uint8Array;
  try{
    db.exec(`PRAGMA page_size=65536; ${schemaSQL(1)} PRAGMA user_version=1; BEGIN`);
    const put=db.prepare('INSERT INTO meta VALUES (?,?)');put.run('schema_hash',schemaHash(1));put.run('layout_hash',expectedLayoutHash(1));put.run('ledger_key','1'.repeat(64));
    for(let i=0;i<4000;i++)put.run(String(i).padStart(7,'0')+'x'.repeat(1000),'x');db.exec('COMMIT');image=db.serialize();
  }finally{db.close();}
  assert.ok(image.length<MAX_IMAGE);assert.equal(inspectMemoryImage(image,1).schema,1);const before=sha(image),fingerprint=storeLogicalFingerprint(image,1);
  const serialize=DatabaseSync.prototype.serialize,exec=DatabaseSync.prototype.exec;let calls=0,capped=0;
  DatabaseSync.prototype.serialize=function(...args){calls++;return serialize.apply(this,args);};
  DatabaseSync.prototype.exec=function(sql){if(sql==='PRAGMA max_page_count=4096')capped++;return exec.call(this,sql);};
  try{
    assert.throws(()=>splitStoreImage(image,1),/STORE_COLD_LIMIT/);
    assert.throws(()=>joinStoreImage(image,1,undefined,fingerprint),/STORE_COLD_LIMIT/);
    assert.equal(calls,0,'oversized copies must be rejected before any target serialization');assert.equal(capped,2);
  }finally{DatabaseSync.prototype.serialize=serialize;DatabaseSync.prototype.exec=exec;}
  assert.equal(sha(image),before);assert.equal(storeLogicalFingerprint(image,1),fingerprint);
  t.diagnostic(JSON.stringify({sourcePageSize:65536,metaEntries:4000,keyBytes:1007,sourceBytes:image.length,targetPageSize:4096,targetMaxPages:4096,serializeCallsBeforeRefusal:calls,sourceUnchanged:true}));
});
test('every immutable cold row is mandatory and exact on subsequent full snapshots',()=>{
  const f=fixture(),s=segment(f.image);try{for(const sql of ["UPDATE ingress SET payload_hash='changed'","UPDATE nodes SET revision=revision+1","DELETE FROM ingress","UPDATE nodes SET generation=1"])
    assert.throws(()=>splitStoreImage(edited(f.image,sql),1,s.cold),/STORE_COLD_IMMUTABLE/);
  }finally{s.cold.close();}
});
test('missing and duplicate hot/cold rows and fingerprint mismatch refuse reconstruction',()=>{
  const f=fixture(),s=segment(f.image);try{const split=splitStoreImage(f.image,1,s.cold);assert.throws(()=>joinStoreImage(split.image,1,undefined,split.fingerprint));
    assert.throws(()=>joinStoreImage(f.image,1,s.cold,split.fingerprint));assert.throws(()=>joinStoreImage(split.image,1,s.cold,'0'.repeat(64)),/STORE_LOGICAL_MISMATCH/);
  }finally{s.cold.close();}
});
test('cold descriptors are P5-only and AAD binds generation excluding both descriptors',()=>{
  const s=segment(fixture().image);try{validateIdentity(s.id);assert.deepEqual(storeColdAAD(s.id),storeColdAAD({...s.id,storeCold:null,safetyCold:null}));
    assert.throws(()=>validateIdentity({...s.id,storageProfile:'blocks-br4-safety-cold-v1'}));assert.throws(()=>validateStoreColdDescriptor({...s.sealed.descriptor,plainBytes:1048577}));
    for(const patch of [{instanceId:'other'},{ownerEpoch:2},{directory:resolve('elsewhere')},{schemaVersion:2 as const}])assert.throws(()=>StoreColdSegment.open(s.sealed.bytes,{...s.id,...patch},s.key));
    const changed=Buffer.from(s.sealed.bytes);changed[30]=changed[30]!^1;assert.throws(()=>StoreColdSegment.open(changed,s.id,s.key),/STORE_COLD_CIPHER/);
  }finally{s.cold.close();}
});
test('selection retains previous cold and takes exactly one next complete generation',()=>{
  const f=fixture(),first=segment(f.image);try{const store=new MemoryStore(':memory:',{image:f.image,clock:{wall:()=>100,monotonic:()=>0}});let scope=store.scope(f.scope.id);
    store.acceptEvent(scope,input('second'));scope=store.purge(scope);store.acceptEvent(scope,input('third'));store.purge(scope);const image=store.snapshot();store.close();
    const next=segment(image,1,first.cold);try{assert.equal(next.sealed.descriptor.counts.nodes,2);const split=splitStoreImage(image,1,next.cold);assert.equal(split.fingerprint,storeLogicalFingerprint(image,1));}finally{next.cold.close();}
  }finally{first.cold.close();}
});
test('first eligible generation crossing dependency group refuses instead of searching later',()=>{
  const f=fixture(),store=new MemoryStore(':memory:',{image:f.image,clock:{wall:()=>100,monotonic:()=>0}}),scope=store.scope(f.scope.id),next=store.acceptEvent(scope,input('next'));store.purge(scope);const image=store.snapshot();store.close();
  const cross=edited(image,`INSERT INTO dependencies VALUES ('${f.ref.id}','${next.id}',1)`);assert.throws(()=>selectStoreCold(cross,1),/STORE_ARCHIVE_CROSS_GENERATION/);
});
