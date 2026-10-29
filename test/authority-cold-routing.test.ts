import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {mkdtempSync,realpathSync,readFileSync,readdirSync,mkdirSync,writeFileSync,statSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import type {PendingCommit} from '../src/local-sqlite-authority.ts';
import {AnchoredVault} from '../src/anchored-vault.ts';
import {generateKeySet,decodeStage,sealV2} from '../src/anchored-codec.ts';
import {sha,FORMAT} from '../src/durable-codec.ts';
import {DurableMemory} from '../src/durable-memory.ts';
import {inspectLegacyM2} from '../src/legacy-m2-import.ts';
import {directoryReader,reconstruct} from '../src/incremental-storage.ts';
import {ColdWorkspace,loadCurrent} from '../src/authority-cold-storage.ts';
import {plainJsonBytes,ColdDatabase} from '../src/authority-cold-format.ts';
import type {VaultHead} from '../src/anchored-codec.ts';

function fixture(t:TestContext,writeLimitBytes=524288){const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-if11-routing-'))),ac={directory:join(root,'authority'),authorityId:'synthetic',custodyDomain:'independent',writeLimitBytes};
 LocalSqliteAuthority.create(ac).close();LocalSqliteAuthority.upgradeSchema(ac,'operator-attested-stopped');LocalSqliteAuthority.upgradeReceiptSchema(ac,'operator-attested-stopped');LocalSqliteAuthority.upgradeColdSchema(ac,'operator-attested-stopped');
 const authority=LocalSqliteAuthority.open(ac),config={directory:join(root,'vault'),vaultId:'vault',identity:'synthetic',storageDomain:'payload',storageProfile:'blocks-br4-v1' as const,schemaVersion:2 as const,keys:generateKeySet(),authority},vault=AnchoredVault.create(config,8,{clock:{wall:()=>100,monotonic:()=>0}});
 t.after(()=>{vault.close();authority.close();});return{root,ac,authority,config,vault};}
function rows(f:ReturnType<typeof fixture>){const db=new DatabaseSync(join(f.ac.directory,'authority.sqlite'));try{return db.prepare('SELECT * FROM receipts ORDER BY vault_id,operation_id').all();}finally{db.close();}}
test('T01 explicit schema5 migration preserves original rows and expires old handles',t=>{
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-if11-upgrade-'))),config={directory:join(root,'a'),authorityId:'a',custodyDomain:'i'};
 LocalSqliteAuthority.create(config).close();assert.throws(()=>LocalSqliteAuthority.upgradeColdSchema(config,'operator-attested-stopped'),/ANCHOR_COLD_UPGRADE_REQUIRED/);LocalSqliteAuthority.upgradeSchema(config,'operator-attested-stopped');LocalSqliteAuthority.upgradeReceiptSchema(config,'operator-attested-stopped');
 const old=LocalSqliteAuthority.open(config);t.after(()=>old.close());const before=sha(readFileSync(join(config.directory,'authority.sqlite')));
 for(const point of ['after-table','after-version']){assert.throws(()=>LocalSqliteAuthority.upgradeColdSchema(config,'operator-attested-stopped',p=>{if(p===point)throw Error('SYNTHETIC_UPGRADE');}),/SYNTHETIC_UPGRADE/);assert.equal(sha(readFileSync(join(config.directory,'authority.sqlite'))),before);}
 assert.deepEqual(LocalSqliteAuthority.upgradeColdSchema(config,'operator-attested-stopped'),{from:4,to:5,alreadyCurrent:false});assert.throws(()=>old.inspectCapacity(),/ANCHOR_SCHEMA_CHANGED/);
 assert.deepEqual(LocalSqliteAuthority.upgradeColdSchema(config,'operator-attested-stopped'),{from:5,to:5,alreadyCurrent:true});assert.throws(()=>LocalSqliteAuthority.upgradeReceiptSchema(config,'operator-attested-stopped'),/ANCHOR_SCHEMA_ALREADY_NEWER/);
});
test('T02/T03/T04 complete receipt routing, two epochs and permanent maintenance retries',t=>{
 const f=fixture(t);for(let i=0;i<45;i++)f.vault.claim('first-'+i,'synthetic');const original=rows(f),before=f.authority.inspectCapacity(),head=f.authority.inspect('vault');
 const a=f.authority.archivePermanentKeys({operationId:'ac1-first',expectedRouteEpoch:0}),after=f.authority.inspectCapacity();
 assert.deepEqual(after.receipts,before.receipts);assert.deepEqual(f.authority.inspect('vault'),head);assert.equal(after.database.pageCount,before.database.pageCount);assert.ok(after.database.freelistPages>before.database.freelistPages);
 for(const row of original)assert.equal(JSON.stringify(f.authority.transaction(tx=>tx.receipt(row.vault_id as string,row.operation_id as string))),row.receipt);
 assert.deepEqual(f.authority.archivePermanentKeys({operationId:'ac1-first',expectedRouteEpoch:0}),a);assert.throws(()=>f.authority.archivePermanentKeys({operationId:'ac1-first',expectedRouteEpoch:1}),/ANCHOR_COLD_CONFLICT/);
 for(let i=0;i<45;i++)f.vault.claim('second-'+i,'synthetic');const b=f.authority.archivePermanentKeys({operationId:'ac1-second',expectedRouteEpoch:1});assert.equal(b.toEpoch,2);assert.deepEqual(f.authority.archivePermanentKeys({operationId:'ac1-first',expectedRouteEpoch:0}),a);
 const capacity=f.authority.inspectCapacity();assert.equal(capacity.coldRouting!.hot.operations,1);assert.equal(capacity.coldRouting!.cold.operations,1);assert.equal(readdirSync(f.ac.directory).filter(n=>n.endsWith('.intent.json')).length,2);
 const target=join(f.root,'closure');f.authority.exportColdClosure(target);assert.equal(f.authority.verifyColdClosure(target).descriptor.epoch,2);
});
test('T02/T03 IF8 complete groups retain original rollover receipts and global logical counts',t=>{
 const f=fixture(t);for(let i=0;i<50;i++)f.vault.claim('segment-'+i,'synthetic');const original=rows(f),roll=f.authority.rolloverReceipts({operationId:'if8'});for(let i=0;i<30;i++)f.vault.claim('raw-'+i,'synthetic');
 const before=f.authority.inspectCapacity();f.authority.archivePermanentKeys({operationId:'ac1-if8',expectedRouteEpoch:0});assert.deepEqual(f.authority.inspectCapacity().receipts,before.receipts);assert.deepEqual(f.authority.rolloverReceipts({operationId:'if8'}),roll);assert.throws(()=>f.authority.rolloverReceipts({operationId:'if8',maxReceipts:127}),/ANCHOR_ROLLOVER_CONFLICT/);
 for(const row of original)assert.equal(JSON.stringify(f.authority.transaction(tx=>tx.receipt(row.vault_id as string,row.operation_id as string))),row.receipt);
});
test('T03 the same ID remains independent across business, IF8 and cold maintenance namespaces',t=>{
 const f=fixture(t);for(let i=0;i<35;i++)f.vault.claim('namespace-'+i,'p');const old=f.authority.inspect('vault')!.head!,operationId='ac1-shared',stage=Buffer.from('SYNTHETIC_NAMESPACE_STAGE'),stagePath=join(f.config.directory,`stage-${operationId}.json`);writeFileSync(stagePath,stage,{flag:'wx'});
 const p:PendingCommit={version:2,kind:'write',operationId,requestDigest:sha(stage),oldHead:old,newHead:{...old,sequence:old.sequence+1,digest:sha(stage)},stagePath,stageDigest:sha(stage)},business=f.authority.transaction(tx=>{tx.prepare(p);return tx.finalize(p);}),rollover=f.authority.rolloverReceipts({operationId}),maintenance=f.authority.archivePermanentKeys({operationId,expectedRouteEpoch:0});
 assert.deepEqual(f.authority.transaction(tx=>tx.receipt('vault',operationId)),business);assert.deepEqual(f.authority.rolloverReceipts({operationId}),rollover);assert.deepEqual(f.authority.archivePermanentKeys({operationId,expectedRouteEpoch:0}),maintenance);assert.throws(()=>f.authority.rolloverReceipts({operationId,maxReceipts:127}),/ANCHOR_ROLLOVER_CONFLICT/);assert.throws(()=>f.authority.archivePermanentKeys({operationId,expectedRouteEpoch:1}),/ANCHOR_COLD_CONFLICT/);
});
test('T02/T03 actual admitted legacy moves cold with exact state, old head priority and all unique indexes',t=>{
 const f=fixture(t);for(let i=0;i<35;i++)f.vault.claim('fill-'+i,'p');const source=join(f.root,'legacy');mkdirSync(source);const key=randomBytes(32),legacy=new DurableMemory({directory:source,identity:'synthetic-legacy',keyBase64:key.toString('base64')},8,{clock:{wall:()=>100,monotonic:()=>0}});t.after(()=>legacy.close());
 legacy.claim('unknown','p');legacy.reserve('unknown');const backup=join(f.root,'legacy-backup');legacy.exportBackup(backup);
 const inspect={backupDirectory:backup,legacyKey:key,identity:'synthetic-legacy',expectedMaxCalls:8,declaredHead:legacy.head,trust:{policy:'trusted-lower-bound' as const,minimumHead:legacy.head}},inspection=inspectLegacyM2(inspect),storageDEK=randomBytes(32);
 const request={...inspect,sourceFreeze:inspection.sourceFreeze,authority:f.authority,vaultId:'imported',targetDirectory:join(f.root,'imported'),storageDomain:'payload',storageProfile:'blocks-br4-v1' as const,newStorageDEK:storageDEK,operationId:inspection.migrationId};
 const imported=AnchoredVault.importLegacyM2(request),keys={version:2 as const,keyEpoch:1,storageDEK,ingressKey:key},v=AnchoredVault.open({directory:request.targetDirectory,authority:f.authority,vaultId:'imported',identity:'synthetic-legacy',storageDomain:'payload',storageProfile:'blocks-br4-v1',keys},8,{clock:{wall:()=>100,monotonic:()=>0}});t.after(()=>v.close());
 const admission={migrationId:inspection.migrationId,head:f.authority.inspect('imported')!.head!,operationId:'admit',operatorId:'synthetic',attestation:'operator-attested-stopped' as const},admitted=f.authority.admitLegacyImport(admission),original=f.authority.transaction(tx=>tx.legacy(inspection.lineageId));
 f.authority.archivePermanentKeys({operationId:'ac1-legacy',expectedRouteEpoch:0});assert.equal(f.authority.inspectCapacity().coldRouting!.cold.legacy,1);assert.deepEqual(f.authority.transaction(tx=>tx.legacy(inspection.lineageId)),original);assert.deepEqual(f.authority.admitLegacyImport(admission),admitted);assert.throws(()=>f.authority.admitLegacyImport({...admission,head:imported.newHead}),/ANCHOR_FENCED/);
 assert.deepEqual(AnchoredVault.importLegacyM2(request),imported);assert.throws(()=>AnchoredVault.importLegacyM2({...request,vaultId:'other',targetDirectory:join(f.root,'other')}),/LEGACY_LINEAGE_CONSUMED/);assert.throws(()=>v.claim('unknown','p'),/INTERACTION_TERMINATED/);v.claim('new','p');assert.throws(()=>f.authority.admitLegacyImport(admission),/ANCHOR_FENCED/);
 // Independent structural collision probes exercise all three indexes; these are not extra real imports.
 const path=join(f.ac.directory,'authority.sqlite');for(const column of ['lineage_id','migration_id','vault_id']){const db=new DatabaseSync(path);try{const x=structuredClone(original)!;const args=[column==='lineage_id'?x.lineageId:'different-lineage',column==='migration_id'?x.migrationId:'different-migration',column==='vault_id'?x.vaultId:'different-vault',JSON.stringify(x)];db.prepare('INSERT INTO legacy_imports VALUES (?,?,?,?)').run(...args);assert.throws(()=>f.authority.inspectCapacity());db.prepare('DELETE FROM legacy_imports WHERE lineage_id=?').run(args[0]!);}finally{db.close();}}
});
test('T11 cold authority retains full backup/rekey/restore/compaction and historical operation conflicts',t=>{
 const f=fixture(t);for(let i=0;i<35;i++)f.vault.claim('fill-'+i,'p');f.authority.archivePermanentKeys({operationId:'ac1-cutover',expectedRouteEpoch:0});
 const backup=join(f.root,'backup');f.vault.exportBackup(backup);const oldHead=f.vault.head,newKey=randomBytes(32),rekeyRequest={authority:f.authority,backupDirectory:backup,keys:f.config.keys,maxCalls:8,targetDirectory:join(f.root,'rekeyed'),storageDomain:'payload',operationId:'rekey',newStorageDEK:newKey};
 const rekey=AnchoredVault.rekeyBackup(rekeyRequest);assert.throws(()=>f.vault.claim('old','p'),/ANCHOR_FENCED|ANCHOR_WRITE_FAILED/);f.vault.close();const keys={...f.config.keys,keyEpoch:2,storageDEK:newKey},v=AnchoredVault.open({...f.config,directory:rekey.newHead.directory,keys},8,{clock:{wall:()=>100,monotonic:()=>0}});t.after(()=>v.close());
 const nextBackup=join(f.root,'next-backup');v.exportBackup(nextBackup);const restored=AnchoredVault.restoreBackup({authority:f.authority,backupDirectory:nextBackup,keys,maxCalls:8,targetDirectory:join(f.root,'restored'),storageDomain:'payload',operationId:'restore'});v.close();
 const compactRequest={authority:f.authority,vaultId:'vault',keys,maxCalls:8,targetDirectory:join(f.root,'compact'),storageDomain:'payload',operationId:'compact'},compacted=AnchoredVault.compact(compactRequest);
 assert.deepEqual(AnchoredVault.compact(compactRequest),compacted);assert.throws(()=>AnchoredVault.compact({...compactRequest,targetDirectory:join(f.root,'conflict')}),/ANCHOR_OPERATION_CONFLICT/);assert.equal(AnchoredVault.inspectCapacity({authority:f.authority,vaultId:'vault',keys,maxCalls:8}).status,'ACTIVE');
 assert.deepEqual(AnchoredVault.rekeyBackup(rekeyRequest),rekey);assert.throws(()=>AnchoredVault.restoreBackup({authority:f.authority,backupDirectory:backup,keys:f.config.keys,maxCalls:8,targetDirectory:join(f.root,'old-restore'),storageDomain:'payload',operationId:'old-restore'}),/ANCHOR_FENCED/);
 assert.ok(restored.newHead.ownerEpoch>oldHead.ownerEpoch);const decoded=reconstruct(compacted.newHead,directoryReader(compacted.newHead.directory),keys,8);decoded.image.fill(0);
});
test('T06 a valid large freelist root above W still upgrades and opens without whole-root allocation',t=>{
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-if11-large-root-'))),ac={directory:join(root,'a'),authorityId:'a',custodyDomain:'i'};LocalSqliteAuthority.create(ac).close();LocalSqliteAuthority.upgradeSchema(ac,'operator-attested-stopped');LocalSqliteAuthority.upgradeReceiptSchema(ac,'operator-attested-stopped');
 const path=join(ac.directory,'authority.sqlite'),db=new DatabaseSync(path);try{db.exec("INSERT INTO receipts VALUES ('synthetic-padding','padding',CAST(zeroblob(14680064) AS TEXT));DELETE FROM receipts WHERE vault_id='synthetic-padding'");}finally{db.close();}
 assert.ok(statSync(path).size>12582912);LocalSqliteAuthority.upgradeColdSchema(ac,'operator-attested-stopped');const a=LocalSqliteAuthority.open(ac);t.after(()=>a.close());assert.equal(a.inspectCapacity().schemaVersion,5);assert.ok(a.inspectCapacity().database.fileBytes>12582912);
});
test('T06 shared workspace reservations refuse before stage creation and preserve root bytes',t=>{
 const f=fixture(t);for(let i=0;i<35;i++)f.vault.claim('fill-'+i,'p');const before=sha(readFileSync(join(f.ac.directory,'authority.sqlite'))),reserve=ColdWorkspace.prototype.reserve;let injected=0,hold:(()=>void)|undefined;
 try{ColdWorkspace.prototype.reserve=function(bytes,label){if(label==='candidate RAM SQLite image and metadata'&&!injected++){hold=reserve.call(this,this.limit-this.used-bytes+1,'synthetic shared occupancy');}return reserve.call(this,bytes,label);};assert.throws(()=>f.authority.archivePermanentKeys({operationId:'ac1-budget',expectedRouteEpoch:0}),/ANCHOR_COLD_WORKSPACE/);}finally{hold?.();ColdWorkspace.prototype.reserve=reserve;}
 assert.equal(sha(readFileSync(join(f.ac.directory,'authority.sqlite'))),before);assert.equal(readdirSync(f.ac.directory).some(n=>n.startsWith('cold-slot-')),false);
});
test('T02 original receipt UTF8 whitespace and extra fields survive cold bytes exactly',t=>{
 const f=fixture(t);for(let i=0;i<35;i++)f.vault.claim('fill-'+i,'p');const db=new DatabaseSync(join(f.ac.directory,'authority.sqlite'));let key='',original='';try{const row=db.prepare('SELECT * FROM receipts ORDER BY operation_id LIMIT 1').get()!;key=row.operation_id as string;original='  '+JSON.stringify({...JSON.parse(row.receipt as string),extra:'合成额外字段'},null,1)+'\n';db.prepare('UPDATE receipts SET receipt=? WHERE operation_id=?').run(original,key);}finally{db.close();}
 const receipt=f.authority.archivePermanentKeys({operationId:'ac1-bytes',expectedRouteEpoch:0}),w=new ColdWorkspace(),cold=loadCurrent(f.ac.directory,receipt.descriptor,w);try{let found=false;for(const row of cold.db.rows('R'))if(row.values[1]===key){assert.equal(Buffer.from(row.values[2] as Uint8Array).toString(),original);found=true;}assert.equal(found,true);}finally{cold.close();}assert.equal(w.used,0);
});
test('T02 selection skips a valid 2MiB extra-field receipt before copying and archives later small rows',t=>{
 const f=fixture(t,4*1048576);for(let i=0;i<35;i++)f.vault.claim('small-'+i,'p');const path=join(f.ac.directory,'authority.sqlite'),db=new DatabaseSync(path);let key='',original='';
 try{const row=db.prepare('SELECT * FROM receipts ORDER BY vault_id COLLATE BINARY,operation_id COLLATE BINARY LIMIT 1').get()!;key=row.operation_id as string;original=' '+JSON.stringify({...JSON.parse(row.receipt as string),extra:'x'.repeat(2*1048576)})+'\n';db.prepare('UPDATE receipts SET receipt=? WHERE operation_id=?').run(original,key);}finally{db.close();}
 const before=f.authority.inspectCapacity(),result=f.authority.archivePermanentKeys({operationId:'ac1-skip-large',expectedRouteEpoch:0}),after=f.authority.inspectCapacity();
 assert.equal(result.moved.skipped.receipts,1);assert.ok(result.moved.receipts>0);assert.ok(result.moved.framedBytes<=262144);assert.deepEqual(after.receipts,before.receipts);assert.ok(after.database.freelistPages>before.database.freelistPages);
 const retained=rows(f);assert.equal(retained.length,1);assert.equal(retained[0]!.operation_id,key);assert.equal(retained[0]!.receipt,original);assert.equal(after.coldRouting!.hot.receipts,1);assert.ok(after.coldRouting!.cold.receipts>0);
});
test('T02 physical-fit archives a closed subset when 1078-byte synthetic receipts overflow the 1MiB cold image',t=>{
 const f=fixture(t,4*1048576),path=join(f.ac.directory,'authority.sqlite'),db=new DatabaseSync(path);
 try{const template=JSON.parse(db.prepare('SELECT receipt FROM receipts LIMIT 1').get()!.receipt as string);for(let i=0;i<245;i++){const operationId='physical-'+String(i).padStart(28,'0'),receipt={...template,operationId,extra:''},padding=1078-Buffer.byteLength(JSON.stringify(receipt));assert.ok(padding>=0);receipt.extra='x'.repeat(padding);const text=JSON.stringify(receipt);assert.equal(Buffer.byteLength(text),1078);db.prepare('INSERT INTO receipts VALUES (?,?,?)').run('vault',operationId,text);}}finally{db.close();}
 const original=rows(f),roll=f.authority.rolloverReceipts({operationId:'if8-physical',maxReceipts:16}),before=f.authority.inspectCapacity(),tryGroup=ColdDatabase.prototype.tryGroup;let physicalSkips=0;
 try{ColdDatabase.prototype.tryGroup=function(meta,group){const accepted=tryGroup.call(this,meta,group);if(!accepted)physicalSkips++;return accepted;};const archived=f.authority.archivePermanentKeys({operationId:'ac1-physical',expectedRouteEpoch:0});assert.equal(archived.moved.segments,1);assert.ok(archived.moved.framedBytes<=262144);}finally{ColdDatabase.prototype.tryGroup=tryGroup;}
 assert.ok(physicalSkips>0);const after=f.authority.inspectCapacity();assert.deepEqual(after.receipts,before.receipts);assert.equal(after.database.pageCount,before.database.pageCount);assert.ok(after.database.freelistPages>before.database.freelistPages);assert.deepEqual(f.authority.rolloverReceipts({operationId:'if8-physical',maxReceipts:16}),roll);
 f.authority.transaction(tx=>{for(const row of original)assert.equal(JSON.stringify(tx.receipt(row.vault_id as string,row.operation_id as string)),row.receipt);});
});
test('T06 repeated public receipt results retain shared W until the outer callback ends',t=>{
 const f=fixture(t),path=join(f.ac.directory,'authority.sqlite'),db=new DatabaseSync(path);let key='';try{const row=db.prepare('SELECT * FROM receipts LIMIT 1').get()!;key=row.operation_id as string;db.prepare('UPDATE receipts SET receipt=? WHERE operation_id=?').run(JSON.stringify({...JSON.parse(row.receipt as string),extra:'x'.repeat(65536)}),key);}finally{db.close();}
 const before=sha(readFileSync(path));assert.throws(()=>f.authority.transaction(tx=>{const held=[];for(let i=0;i<1000;i++)held.push(tx.receipt('vault',key));return held;}),/ANCHOR_COLD_WORKSPACE/);assert.equal(sha(readFileSync(path)),before);assert.ok(f.authority.transaction(tx=>tx.receipt('vault',key)));
});
test('T06 public returned bytes stay charged across prepare/finalize internal relocks',t=>{
 const f=fixture(t),old=f.authority.inspect('vault')!.head!,stage=Buffer.from('SYNTHETIC_AUTHORITY_ONLY_STAGE'),stagePath=join(f.config.directory,'stage-retained-result.json');writeFileSync(stagePath,stage,{flag:'wx'});
 const p:PendingCommit={version:2,kind:'write',operationId:'retained-result',requestDigest:sha('retained-result'),oldHead:old,newHead:{...old,sequence:old.sequence+1,digest:sha(stage)},stagePath,stageDigest:sha(stage)};
 const original=rows(f)[0]!,reserve=ColdWorkspace.prototype.reserve,charges:number[]=[];let workspace:ColdWorkspace;
 try{ColdWorkspace.prototype.reserve=function(bytes,label){workspace=this;return reserve.call(this,bytes,label);};
  f.authority.transaction(tx=>{const first=tx.receipt('vault',original.operation_id as string);charges.push(workspace.used);tx.prepare(p);const second=tx.receipt('vault',original.operation_id as string);charges.push(workspace.used);assert.deepEqual(second,first);tx.finalize(p);const third=tx.receipt('vault',original.operation_id as string);charges.push(workspace.used);assert.deepEqual(third,first);});
 }finally{ColdWorkspace.prototype.reserve=reserve;}
 assert.equal(charges.length,3);assert.ok(charges[1]!>charges[0]!);assert.ok(charges[2]!>charges[1]!);
});
test('T06 schema5 Pending extra preserves exact bytes and refuses insufficient W before serialization',t=>{
 const f=fixture(t,4*1048576),old=f.authority.inspect('vault')!.head!,stage=Buffer.from('SYNTHETIC_PENDING_EXTRA'),stagePath=join(f.config.directory,'stage-json-extra.json');writeFileSync(stagePath,stage,{flag:'wx'});
 const pending={version:2 as const,kind:'write' as const,operationId:'json-extra',requestDigest:sha(stage),oldHead:old,newHead:{...old,sequence:old.sequence+1,digest:sha(stage)},stagePath,stageDigest:sha(stage),extra:'x'.repeat(262144)},expected=JSON.stringify({status:'PREPARED',head:old,pending}),path=join(f.ac.directory,'authority.sqlite'),before=sha(readFileSync(path));
 const reserve=ColdWorkspace.prototype.reserve,stringify=JSON.stringify;let hold:(()=>void)|undefined,calls=0;
 try{ColdWorkspace.prototype.reserve=function(bytes,label){if(label==='plain JSON serialized UTF8'&&bytes===Buffer.byteLength(expected))hold=reserve.call(this,this.limit-this.used-bytes+1,'synthetic remaining W');return reserve.call(this,bytes,label);};JSON.stringify=((value:any,...args:any[])=>{if(value?.status==='PREPARED')calls++;return (stringify as any)(value,...args);}) as typeof JSON.stringify;
  assert.throws(()=>f.authority.transaction(tx=>tx.prepare(pending)),/ANCHOR_COLD_WORKSPACE/);assert.equal(calls,0);
 }finally{hold?.();ColdWorkspace.prototype.reserve=reserve;JSON.stringify=stringify;}
 assert.equal(sha(readFileSync(path)),before);f.authority.transaction(tx=>tx.prepare(pending));const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT state FROM vaults WHERE vault_id=?').get('vault')!.state,expected);}finally{db.close();}
 assert.deepEqual(f.authority.inspect('vault')!.pending,pending);f.authority.transaction(tx=>tx.finalize(pending));
});
test('T06 Head comparisons budget both strings; finalize receipts accumulate across internal relocks',t=>{
 const f=fixture(t,4*1048576),path=join(f.ac.directory,'authority.sqlite'),db=new DatabaseSync(path);let old:VaultHead;
 try{const value=JSON.parse(db.prepare('SELECT state FROM vaults WHERE vault_id=?').get('vault')!.state as string);value.head.extra='x'.repeat(65536);old=value.head;db.prepare('UPDATE vaults SET state=? WHERE vault_id=?').run(JSON.stringify(value),'vault');}finally{db.close();}
 const reserve=ColdWorkspace.prototype.reserve,pairs:number[]=[],used:number[]=[];let workspace:ColdWorkspace;
 try{ColdWorkspace.prototype.reserve=function(bytes,label){workspace=this;if(label==='plain JSON comparison UTF8 pair')pairs.push(bytes);return reserve.call(this,bytes,label);};
  f.authority.transaction(tx=>{tx.assertActive(old);const retained=[];for(let i=0;i<2;i++){const operationId='json-final-'+i,stage=Buffer.from(operationId),stagePath=join(f.config.directory,`stage-${operationId}.json`);writeFileSync(stagePath,stage,{flag:'wx'});const p:PendingCommit={version:2,kind:'write',operationId,requestDigest:sha(stage),oldHead:old,newHead:{...old,sequence:old.sequence+1,digest:sha(stage)},stagePath,stageDigest:sha(stage)};tx.prepare(p);retained.push(tx.finalize(p));used.push(workspace.used);old=p.newHead;}assert.equal(retained.length,2);});
 }finally{ColdWorkspace.prototype.reserve=reserve;}
 assert.ok(pairs.some(n=>n===plainJsonBytes(old)*2));assert.ok(used[1]!>used[0]!+262144);assert.ok(f.authority.inspect('vault')!.head);
});
test('T06 plain long legacy identity refuses without an uncharged lineage serialization',t=>{
 const f=fixture(t),head=f.authority.inspect('vault')!.head!,identity='x'.repeat(262144),genesisAuthorityDigest='a'.repeat(64),lineageId=sha(JSON.stringify([FORMAT,identity,genesisAuthorityDigest])),migrationId='m2-import-'+lineageId;
 const proof:NonNullable<PendingCommit['legacyImport']>={version:1,lineageId,migrationId,genesisAuthorityDigest,sourceFreeze:{version:1,declaredHead:{version:1,format:FORMAT,identity,sequence:1,authoritySha256:'b'.repeat(64)},packageDigest:'c'.repeat(64),trust:{policy:'declared-snapshot-only'}},latestProven:false,legacyCopiesFenced:false,quotaScope:'this-authority-only',sourceRetirement:'not-established',admissionAtImport:'required'};
 const p:PendingCommit={version:2,kind:'legacy-m2-import',operationId:migrationId,requestDigest:'d'.repeat(64),oldHead:null,newHead:{...head,legacyImport:{lineageId,migrationId}},stagePath:join(f.config.directory,`stage-${migrationId}.json`),stageDigest:'e'.repeat(64),legacyImport:proof},before=sha(readFileSync(join(f.ac.directory,'authority.sqlite'))),bytes=plainJsonBytes([FORMAT,identity,genesisAuthorityDigest]),reserve=ColdWorkspace.prototype.reserve,stringify=JSON.stringify;
 for(const exhaust of [false,true]){let charged=false,calls=0,hold:(()=>void)|undefined;
  try{ColdWorkspace.prototype.reserve=function(n,label){if(label==='plain JSON serialized UTF8'&&n===bytes){if(exhaust)hold=reserve.call(this,this.limit-this.used-n+1,'synthetic remaining W');const release=reserve.call(this,n,label);charged=true;return()=>{charged=false;release();};}return reserve.call(this,n,label);};
   JSON.stringify=((value:any,...args:any[])=>{if(Array.isArray(value)&&value[0]===FORMAT&&value[1]===identity){calls++;assert.equal(charged,true);}return (stringify as any)(value,...args);}) as typeof JSON.stringify;
   assert.throws(()=>f.authority.transaction(tx=>tx.prepare(p)),exhaust?/ANCHOR_COLD_WORKSPACE/:/LEGACY_PROOF/);assert.equal(calls,exhaust?0:1);assert.equal(charged,false);
  }finally{hold?.();ColdWorkspace.prototype.reserve=reserve;JSON.stringify=stringify;}
  assert.equal(sha(readFileSync(join(f.ac.directory,'authority.sqlite'))),before);
 }
});
test('T06 a real valid v2 stage above W is verified through one charged 64KiB chunk',t=>{
 const f=fixture(t),config={directory:join(f.root,'v2'),vaultId:'v2',identity:'synthetic',storageDomain:'payload',keys:generateKeySet(),authority:f.authority};AnchoredVault.create(config,8).close();let armed=false;
 const v=AnchoredVault.open(config,8,{fault:p=>{if(armed&&p==='stage-written')throw Error('SYNTHETIC_STAGE_ONLY');}});t.after(()=>v.close());const old=f.authority.inspect('v2')!.head!,beforeNames=new Set(readdirSync(config.directory));armed=true;assert.throws(()=>v.claim('stage-only','p'));
 const originalName=readdirSync(config.directory).find(n=>n.startsWith('stage-')&&!beforeNames.has(n))!,original=readFileSync(join(config.directory,originalName)),decoded=decodeStage(original,config.keys,8),operationId='large-stage';
 const record=sealV2({...decoded.record,operationId},'record',decoded.state.identity,config.keys.storageDEK),head={...decoded.stage.head,digest:sha(record)},prefix=Buffer.from(JSON.stringify({...decoded.stage,head,record:record.toString('base64')}));decoded.image.fill(0);const verified=decodeStage(prefix,config.keys,8);verified.image.fill(0);
 const stagePath=join(config.directory,`stage-${operationId}.json`),fd=openSync(stagePath,'wx'),chunk=Buffer.alloc(65536,32),hash=createHash('sha256');try{writeSync(fd,prefix);hash.update(prefix);for(let i=0;i<224;i++){writeSync(fd,chunk);hash.update(chunk);}fsyncSync(fd);}finally{closeSync(fd);chunk.fill(0);}
 const digest=hash.digest('hex'),p:PendingCommit={version:2,kind:'write',operationId,requestDigest:digest,oldHead:old,newHead:head,stagePath,stageDigest:digest};assert.ok(statSync(stagePath).size>12582912);
 const before=sha(readFileSync(join(f.ac.directory,'authority.sqlite')));assert.throws(()=>f.authority.transaction(tx=>tx.prepare({...p,stageDigest:'0'.repeat(64)})),/ANCHOR_TRANSITION/);assert.equal(sha(readFileSync(join(f.ac.directory,'authority.sqlite'))),before);
 const reserve=ColdWorkspace.prototype.reserve;let charged=0;try{ColdWorkspace.prototype.reserve=function(bytes,label){if(label==='bounded stage hash chunk and digest')charged=Math.max(charged,bytes);return reserve.call(this,bytes,label);};f.authority.transaction(tx=>tx.prepare(p));}finally{ColdWorkspace.prototype.reserve=reserve;}
 assert.equal(charged,65536+1024);assert.equal(f.authority.inspect('v2')!.status,'PREPARED');assert.ok(statSync(stagePath).size>12582912);assert.ok(readFileSync(join(config.directory,originalName)).equals(original));
});
