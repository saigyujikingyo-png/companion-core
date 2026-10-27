import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {mkdtempSync,realpathSync,statSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {AnchoredVault} from '../src/anchored-vault.ts';
import {generateKeySet} from '../src/anchored-codec.ts';
import {directoryReader,reconstruct} from '../src/incremental-storage.ts';
import type {PendingCommit} from '../src/local-sqlite-authority.ts';
import {AUTHORITY_READ_LIMIT,AUTHORITY_WRITE_LIMIT} from '../src/local-sqlite-authority.ts';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {RetrievalService} from '../src/retrieval.ts';
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
function rawPending(f:ReturnType<typeof fixture>,name:string):PendingCommit{
  const old=f.authority.inspect('vault')!.head!,stagePath=join(f.config.directory,`stage-${name}.json`),bytes=Buffer.from('SYNTHETIC_AUTHORITY_ONLY_STAGE');
  writeFileSync(stagePath,bytes,{flag:'wx'});
  return{version:2,kind:'write',operationId:name,requestDigest:sha(name),oldHead:old,newHead:{...old,sequence:old.sequence+1,digest:sha(bytes)},stagePath,stageDigest:sha(bytes)};
}
function authorityData(f:ReturnType<typeof fixture>){const db=new DatabaseSync(join(f.authority.directory,'authority.sqlite'));try{
  return ['metadata','vaults','receipts'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
}finally{db.close();}}

function fixture(t:TestContext,writeLimitBytes=65536){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aemc-if6-capacity-'))),authorityConfig={directory:join(root,'authority'),authorityId:'synthetic',custodyDomain:'independent',writeLimitBytes};
  const authority=LocalSqliteAuthority.create(authorityConfig),config={directory:join(root,'vault'),vaultId:'vault',identity:'synthetic',storageDomain:'payload',
    storageProfile:'blocks-br4-v1' as const,authority,keys:generateKeySet()},v=AnchoredVault.create(config,4);
  t.after(()=>{v.close();authority.close();});return{root,authorityConfig,authority,config,v};
}
test('capacity refusal precedes PREPARED and leaves the last ACTIVE head and safety ledger intact',t=>{
  const f=fixture(t);let refused=false;
  for(let i=0;i<80;i++){
    const before=f.authority.inspect('vault')!,decoded=reconstruct(before.head!,directoryReader(f.config.directory),f.config.keys,4),safety=decoded.state.safety;decoded.image.fill(0);
    try{f.v.claim(`synthetic-${i}`,'payload');}
    catch(error){assert.match(String(error),/ANCHOR_(CAPACITY|WRITE_FAILED)/);assert.deepEqual(f.authority.inspect('vault'),before);
      const after=reconstruct(before.head!,directoryReader(f.config.directory),f.config.keys,4);assert.deepEqual(after.state.safety,safety);after.image.fill(0);refused=true;break;}
    assert.ok(statSync(join(f.authority.directory,'authority.sqlite')).size<=65536,'acknowledged authority exceeded its admission budget');
  }
  assert.equal(refused,true);
});

test('a caught preview SQL failure poisons only mutation completion and cannot commit a proposed PREPARED',t=>{
  const f=fixture(t),p=rawPending(f,'preview-fault'),before=authorityData(f),prepare=DatabaseSync.prototype.prepare;let injected=0;
  try{
    DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipts VALUES (?,?,?)'){injected++;throw Error('SYNTHETIC_PREVIEW_SQL');}return prepare.call(this,sql);};
    assert.throws(()=>f.authority.transaction(tx=>{
      assert.throws(()=>tx.prepare(p),/SYNTHETIC_PREVIEW_SQL/);
      assert.throws(()=>tx.finalize(p),/ANCHOR_TRANSACTION_FAILED/);
      assert.throws(()=>tx.prepare(p),/ANCHOR_TRANSACTION_FAILED/);
    }),/ANCHOR_TRANSACTION_FAILED/);
  }finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(injected,1);assert.deepEqual(authorityData(f),before);
  // A fresh transaction is usable; the failed operation never became durable.
  f.authority.transaction(tx=>{tx.prepare(p);tx.finalize(p);});assert.equal(f.authority.inspect('vault')!.status,'ACTIVE');
});

test('a caught real finalization SQL failure preserves durable PREPARED and poisons the outer commit',t=>{
  const f=fixture(t),p=rawPending(f,'finalize-fault');f.authority.transaction(tx=>tx.prepare(p));const before=authorityData(f),prepare=DatabaseSync.prototype.prepare;
  try{DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipts VALUES (?,?,?)')throw Error('SYNTHETIC_FINALIZE_SQL');return prepare.call(this,sql);};
    assert.throws(()=>f.authority.transaction(tx=>{assert.throws(()=>tx.finalize(p),/SYNTHETIC_FINALIZE_SQL/);}),/ANCHOR_TRANSACTION_FAILED/);
  }finally{DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(authorityData(f),before);assert.equal(f.authority.inspect('vault')!.status,'PREPARED');
  f.authority.transaction(tx=>tx.finalize(p));assert.deepEqual(f.authority.inspect('vault')!.head,p.newHead);
});

test('caught real capacity refusal never commits partial authority rows or a receipt',t=>{
  const f=fixture(t);f.v.close();let refused=false,previewReached=false;
  const prepare=DatabaseSync.prototype.prepare;
  try{
    DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipts VALUES (?,?,?)')previewReached=true;return prepare.call(this,sql);};
    for(let i=0;i<100;i++){
      const p=rawPending(f,`candidate-${i}`),before=authorityData(f);previewReached=false;
      try{f.authority.transaction(tx=>{
        try{tx.prepare(p);}catch(error){assert.match(String(error),/ANCHOR_CAPACITY/);refused=true;return;}
        tx.finalize(p);
      });}catch(error){assert.match(String(error),/ANCHOR_TRANSACTION_FAILED/);assert.equal(refused,true);}
      if(refused){assert.deepEqual(authorityData(f),before);break;}
    }
  }finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(refused,true);assert.equal(previewReached,true,'refusal must exercise future-finalization preview');
});

test('new write limits only lower admission, never the 64 MiB read ceiling or completion limit',t=>{
  assert.equal(AUTHORITY_READ_LIMIT,67108864);assert.equal(AUTHORITY_WRITE_LIMIT,22369621);
  const f=fixture(t,128*1024);addOldPadding(f,70*1024);const p=rawPending(f,'pending');f.authority.transaction(tx=>tx.prepare(p));
  assert.ok(statSync(join(f.authority.directory,'authority.sqlite')).size>65536);
  const low=LocalSqliteAuthority.open({...f.authorityConfig,writeLimitBytes:65536});t.after(()=>low.close());
  low.transaction(tx=>tx.finalize(p));assert.equal(low.inspect('vault')!.status,'ACTIVE');
  for(const n of [0,65535,AUTHORITY_WRITE_LIMIT+1,NaN,Infinity])assert.throws(()=>LocalSqliteAuthority.open({...f.authorityConfig,writeLimitBytes:n}),/ANCHOR_CAPACITY_CONFIG/);
});

test('independent processes preserve pending completion space and a real exit after PREPARED reconciles',t=>{
  const f=fixture(t,1024*1024),otherConfig={...f.config,directory:join(f.root,'other'),vaultId:'other'},other=AnchoredVault.create(otherConfig,4);t.after(()=>other.close());f.v.close();
  const prelude=`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {AnchoredVault} from './src/anchored-vault.ts';
    import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';const x=JSON.parse(readFileSync(0,'utf8')),authority=LocalSqliteAuthority.open(x.authority);
    const keys={...x.keys,storageDEK:Buffer.from(x.keys.storageDEK,'base64'),ingressKey:Buffer.from(x.keys.ingressKey,'base64')};`;
  const data={authority:f.authorityConfig,config:{directory:f.config.directory,vaultId:'vault',identity:'synthetic',storageDomain:'payload',storageProfile:'blocks-br4-v1'},
    keys:{version:2,keyEpoch:1,storageDEK:Buffer.from(f.config.keys.storageDEK).toString('base64'),ingressKey:Buffer.from(f.config.keys.ingressKey).toString('base64')}};
  const child=(script:string,value:unknown)=>spawnSync(process.execPath,['--input-type=module','-e',prelude+script],{cwd:process.cwd(),windowsHide:true,timeout:15000,encoding:'utf8',input:JSON.stringify(value)});
  const interrupted=child(`let armed=false;const v=AnchoredVault.open({...x.config,authority,keys},4,{fault:p=>{if(armed&&p==='prepared')process.exit(42);}});armed=true;v.claim('exit-after-prepare','synthetic');`,data);
  assert.equal(interrupted.status,42,interrupted.stderr);const pending=f.authority.inspect('vault')!,before=authorityData(f);assert.equal(pending.status,'PREPARED');
  const contender=child(`try{assert.throws(()=>AnchoredVault.create({...x.config,authority,keys},4),/ANCHOR_CAPACITY_PENDING/);console.log('COMPETITOR_REFUSED');}finally{authority.close();}`,
    {...data,config:{...data.config,directory:join(f.root,'contender'),vaultId:'contender'}});
  assert.equal(contender.status,0,contender.stderr);assert.match(contender.stdout,/COMPETITOR_REFUSED/);
  assert.throws(()=>other.claim('other-write','payload'),/ANCHOR_CAPACITY_PENDING|ANCHOR_WRITE_FAILED/);assert.deepEqual(authorityData(f),before);
  const receipt=AnchoredVault.reconcile({authority:f.authority,vaultId:'vault',operationId:pending.pending!.operationId,keys:f.config.keys,maxCalls:4});
  assert.deepEqual(receipt.newHead,pending.pending!.newHead);assert.equal(f.authority.inspect('vault')!.status,'ACTIVE');
  const fresh=AnchoredVault.create({...f.config,directory:join(f.root,'fresh'),vaultId:'fresh'},4);fresh.close();
});

function addOldPadding(f:ReturnType<typeof fixture>,bytes:number){
  const db=new DatabaseSync(join(f.authority.directory,'authority.sqlite'));try{
    const original=JSON.parse(db.prepare('SELECT receipt FROM receipts LIMIT 1').get()!.receipt as string);
    db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('historical-fixture','historical-padding',JSON.stringify({...original,padding:'x'.repeat(bytes)}));
  }finally{db.close();}
}
test('historical high-water ACTIVE above the new soft limit remains readable without changing its bytes',t=>{
  const f=fixture(t,AUTHORITY_WRITE_LIMIT);f.v.close();addOldPadding(f,24*1024*1024);
  const path=join(f.authority.directory,'authority.sqlite'),before=sha(readFileSync(path)),size=statSync(path).size;
  assert.ok(size>AUTHORITY_WRITE_LIMIT&&size<AUTHORITY_READ_LIMIT);
  const reopened=LocalSqliteAuthority.open(f.authorityConfig);t.after(()=>reopened.close());const head=reopened.inspect('vault')!.head!;
  reopened.transaction(tx=>{tx.assertActive(head);assert.equal(tx.receipt('vault','absent'),null);});
  assert.equal(sha(readFileSync(path)),before);
  const p=rawPending(f,'no-room');assert.throws(()=>reopened.transaction(tx=>tx.prepare(p)),/ANCHOR_CAPACITY/);assert.equal(sha(readFileSync(path)),before);
});

test('historical pending without worst-case journal headroom remains preserved and unresolved',t=>{
  const f=fixture(t,AUTHORITY_WRITE_LIMIT),p=rawPending(f,'old-pending');f.v.close();f.authority.transaction(tx=>tx.prepare(p));
  addOldPadding(f,34*1024*1024);const path=join(f.authority.directory,'authority.sqlite'),before=sha(readFileSync(path));
  assert.ok(statSync(path).size<AUTHORITY_READ_LIMIT);const reopened=LocalSqliteAuthority.open(f.authorityConfig);t.after(()=>reopened.close());
  assert.equal(reopened.inspect('vault')!.status,'PREPARED');assert.throws(()=>reopened.transaction(tx=>tx.finalize(p)),/ANCHOR_CAPACITY/);
  assert.equal(sha(readFileSync(path)),before);assert.equal(reopened.inspect('vault')!.status,'PREPARED');
});

test('historical pending above the admission soft limit still completes when worst-case recovery fits',t=>{
  const f=fixture(t,AUTHORITY_WRITE_LIMIT),p=rawPending(f,'old-room');f.v.close();f.authority.transaction(tx=>tx.prepare(p));
  addOldPadding(f,24*1024*1024);assert.ok(statSync(join(f.authority.directory,'authority.sqlite')).size>AUTHORITY_WRITE_LIMIT);
  f.authority.transaction(tx=>tx.finalize(p));assert.deepEqual(f.authority.inspect('vault')!.head,p.newHead);
});

test('legacy multiple pending remain readable and complete individually without admitting a new pending',t=>{
  const f=fixture(t,1024*1024),other=AnchoredVault.create({...f.config,directory:join(f.root,'other'),vaultId:'other'},4);t.after(()=>other.close());
  const first=rawPending(f,'first'),old=other.head,stagePath=join(f.root,'other','stage-second.json'),bytes=Buffer.from('SYNTHETIC_OLD_PENDING');writeFileSync(stagePath,bytes,{flag:'wx'});
  const second:PendingCommit={...first,operationId:'second',oldHead:old,newHead:{...old,sequence:old.sequence+1,digest:sha(bytes)},stagePath,stageDigest:sha(bytes)};
  f.authority.transaction(tx=>tx.prepare(first));
  // New disposable fixture only: model an old binary's two-pending history.
  const db=new DatabaseSync(join(f.authority.directory,'authority.sqlite'));try{db.prepare('UPDATE vaults SET state=? WHERE vault_id=?').run(JSON.stringify({status:'PREPARED',head:old,pending:second}),'other');}finally{db.close();}
  assert.equal(f.authority.inspect('vault')!.status,'PREPARED');assert.equal(f.authority.inspect('other')!.status,'PREPARED');
  f.authority.transaction(tx=>tx.finalize(second));assert.equal(f.authority.inspect('vault')!.status,'PREPARED');
  const third={...second,operationId:'third',oldHead:second.newHead,newHead:{...second.newHead,sequence:second.newHead.sequence+1},stagePath:join(f.root,'other','stage-third.json')};
  writeFileSync(third.stagePath,bytes,{flag:'wx'});assert.throws(()=>f.authority.transaction(tx=>tx.prepare(third)),/ANCHOR_CAPACITY_PENDING/);
  f.authority.transaction(tx=>tx.finalize(first));assert.equal(f.authority.inspect('vault')!.status,'ACTIVE');
});

test('schema upgrade over the lowered admission limit leaves the original layout and rows untouched',t=>{
  const f=fixture(t);addOldPadding(f,65536);const path=join(f.authority.directory,'authority.sqlite'),before=sha(readFileSync(path));
  assert.throws(()=>LocalSqliteAuthority.upgradeSchema(f.authorityConfig,'operator-attested-stopped'),/ANCHOR_CAPACITY/);
  assert.equal(sha(readFileSync(path)),before);const db=new DatabaseSync(path);try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='legacy_imports'").get(),undefined);
  }finally{db.close();}
});

test('prepare COMMIT and completion use verified no-spill DELETE EXTRA MEMORY pragmas',t=>{
  const f=fixture(t),p=rawPending(f,'pragmas'),prepare=DatabaseSync.prototype.prepare;let checked=0;
  try{DatabaseSync.prototype.prepare=function(sql){if(sql==='INSERT INTO receipts VALUES (?,?,?)'){
    assert.equal(prepare.call(this,'PRAGMA cache_spill').get()!.cache_spill,0);assert.equal(prepare.call(this,'PRAGMA journal_mode').get()!.journal_mode,'delete');
    assert.equal(prepare.call(this,'PRAGMA synchronous').get()!.synchronous,3);assert.equal(prepare.call(this,'PRAGMA temp_store').get()!.temp_store,2);checked++;
  }return prepare.call(this,sql);};f.authority.transaction(tx=>{tx.prepare(p);tx.finalize(p);});}
  finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(checked,2);
});

test('actual hot rollback journal stays within the hard bound and the real opener restores prior authority bytes',t=>{
  const f=fixture(t,AUTHORITY_WRITE_LIMIT);f.v.close();addOldPadding(f,1024*1024);const file=join(f.authority.directory,'authority.sqlite');
  const before=sha(readFileSync(file)),head=f.authority.inspect('vault')!,rows=authorityData(f);f.authority.close();
  // Reader recovery fixture: raw test controller deliberately enables spills.
  // This is neither the new no-spill writer nor a physical-power-loss claim.
  const script=`import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';const file=JSON.parse(readFileSync(0,'utf8')).file;
    const db=new DatabaseSync(file);db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE;");
    db.prepare("UPDATE receipts SET receipt=? WHERE vault_id='historical-fixture'").run(JSON.stringify({synthetic:'interrupted',padding:'y'.repeat(1024*1024)}));process.exit(42);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,timeout:15000,encoding:'utf8',input:JSON.stringify({file})});
  assert.equal(child.status,42,child.stderr);const journal=file+'-journal';assert.equal(existsSync(journal),true);
  const bytes=readFileSync(journal);assert.deepEqual(bytes.subarray(0,8),Buffer.from('d9d505f920a163d7','hex'));assert.ok(bytes.readUInt32BE(8)>0);
  assert.ok(statSync(file).size+bytes.length<AUTHORITY_READ_LIMIT);assert.notEqual(sha(readFileSync(file)),before);
  const opened=LocalSqliteAuthority.open(f.authorityConfig);t.after(()=>opened.close());assert.deepEqual(opened.inspect('vault'),head);
  assert.deepEqual(authorityData(f),rows);assert.equal(sha(readFileSync(file)),before);assert.equal(existsSync(journal),false);
});

test('a durable retrieval TTL barrier refuses across another pending vault and fresh catch-up excludes expired bodies',t=>{
  let wall=100,armed=false;const root=realpathSync(mkdtempSync(join(tmpdir(),'aemc-if6-retrieval-')));
  const authority=LocalSqliteAuthority.create({directory:join(root,'authority'),authorityId:'synthetic',custodyDomain:'independent'}),keys=generateKeySet();
  const config={directory:join(root,'recall'),vaultId:'recall',identity:'synthetic',storageDomain:'payload',storageProfile:'blocks-br4-v1' as const,schemaVersion:2 as const,keys,authority};
  const options={clock:{wall:()=>wall,monotonic:()=>0}},v=AnchoredVault.create(config,4,options);
  const other=AnchoredVault.create({...config,directory:join(root,'other'),vaultId:'other'},4,{...options,fault:p=>{if(armed&&p==='prepared')throw Error('SYNTHETIC_STOP');}});
  t.after(()=>{other.close();v.close();authority.close();});const s=v.store,scope=s.ensureScope({tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test'});
  const e=s.acceptEvent(scope,{source:'synthetic',eventKey:'one',evidence:{speakerId:'subject',speakerRole:'subject',mode:'self_report',selectedText:'SYNTHETIC_ANCESTOR',occurredAt:null}});
  const job=s.beginJob(scope,[e]),lease=s.claimLease(scope,job.id);s.propose(scope,job.id,lease.token,{kind:'claim',statement:'synthetic blue',basis:'self_report',validFrom:null,validTo:200});s.publish(scope,job.id,lease.token);
  const h=s.registerConsumer('recall-consumer',scope,'retrieval-refs-v1'),service=new RetrievalService(s),b=service.bindConsumer(h);service.refresh(b);
  const candidate=service.query(b,{text:'blue'}).candidate,head=authority.inspect('recall');
  armed=true;assert.throws(()=>other.claim('pending','synthetic'),/SYNTHETIC_STOP|ANCHOR_WRITE_FAILED/);const pending=authority.inspect('other')!;
  wall=200;assert.throws(()=>service.resolve(b,candidate),/ANCHOR_CAPACITY_PENDING|ANCHOR_WRITE_FAILED/);
  assert.deepEqual(authority.inspect('recall'),head);assert.deepEqual(authority.inspect('other'),pending);
  assert.throws(()=>service.refresh(b),/UNAUTHENTICATED/);
  AnchoredVault.reconcile({authority,vaultId:'other',operationId:pending.pending!.operationId,keys,maxCalls:4});v.close();
  const next=AnchoredVault.open(config,4,options);t.after(()=>next.close());const current=next.store.bindConsumer(h.id,next.store.scope(scope.id));next.store.applyConsumers([current]);
  const fresh=new RetrievalService(next.store),binding=fresh.bindConsumer(current);fresh.refresh(binding);
  assert.deepEqual(fresh.resolve(binding,fresh.query(binding,{text:'blue'}).candidate).hits,[]);
});
