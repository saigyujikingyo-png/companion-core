import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredFault, RestoreRequest } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import type { AuthorityTransaction, PendingCommit } from '../src/local-sqlite-authority.ts';
import { generateKeySet, rewrapKeyEnvelope, unwrapKeySet, wrapKeySet } from '../src/anchored-codec.ts';
import type { KeySet } from '../src/anchored-codec.ts';
import { DurableMemory } from '../src/durable-memory.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'synthetic', relationshipId: 'synthetic' };
const event = { source: 'synthetic', eventKey: 'fixed-native-event', evidence: { speakerId: 'subject', speakerRole: 'subject' as const,
  mode: 'self_report' as const, selectedText: 'SYNTHETIC_SECRET_VIOLET', occurredAt: null } };
function fixture(t: TestContext, options: Parameters<typeof AnchoredVault.create>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'companion-anchored-v2-'));
  const authorityConfig = { directory: join(root, 'independent-authority'), authorityId: 'synthetic-authority', custodyDomain: 'separate-custody' };
  const authority = LocalSqliteAuthority.create(authorityConfig), keys = generateKeySet();
  const config = { directory: join(root, 'vault'), vaultId: 'synthetic-vault', identity: 'synthetic', storageDomain: 'vault-storage', authority, keys };
  const v = AnchoredVault.create(config, 2, options);
  t.after(() => { v.close(); authority.close(); });
  return { root, authorityConfig, authority, keys, config, v };
}
const wireKeys = (keys: KeySet) => ({ version: 2, keyEpoch: keys.keyEpoch, storageDEK: Buffer.from(keys.storageDEK).toString('base64'), ingressKey: Buffer.from(keys.ingressKey).toString('base64') });
const childPrelude = `
import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';
import {AnchoredVault} from './src/anchored-vault.ts';
let chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString());
const authority=LocalSqliteAuthority.open(input.authority);
const keys={...input.keys,storageDEK:Buffer.from(input.keys.storageDEK,'base64'),ingressKey:Buffer.from(input.keys.ingressKey,'base64')};
`;
function child(script: string, data: unknown) {
  return spawnSync(process.execPath, ['--input-type=module','-e', childPrelude + script],
    { cwd: process.cwd(), input: JSON.stringify(data), encoding: 'utf8', timeout: 15000, windowsHide: true });
}
function ledgerKey(v: AnchoredVault): unknown {
  const db = new DatabaseSync(':memory:'), image = v.store.snapshot();
  try { db.deserialize(image); return db.prepare("SELECT value FROM meta WHERE key='ledger_key'").get()!.value; }
  finally { image.fill(0); db.close(); }
}

test('mandatory v2 anchor, encrypted current state and startup recovery preserve consumed requests', t => {
  const f = fixture(t); const scope = f.v.store.ensureScope(who); f.v.store.acceptEvent(scope, event);
  f.v.claim('native-one','payload'); f.v.reserve('native-one'); const head = f.v.head; f.v.close();
  for (const name of readdirSync(f.config.directory)) assert.equal(readFileSync(join(f.config.directory,name)).includes(Buffer.from(event.evidence.selectedText)), false);
  const reopened = AnchoredVault.open(f.config,2); t.after(() => reopened.close());
  assert.equal(reopened.head.sequence, head.sequence + 1); assert.equal(reopened.reserved,1); assert.equal(reopened.status.unknownRequests,1);
  assert.throws(() => reopened.claim('native-one','payload'), /INTERACTION_TERMINATED/);
  assert.throws(() => reopened.claim('native-one','different'), /INTERACTION_IDEMPOTENCY_CONFLICT/);
  assert.equal(reopened.store.scope(scope.id).runtimeEpoch, scope.runtimeEpoch + 1);
  assert.throws(() => new DurableMemory({directory:f.config.directory,identity:'synthetic',keyBase64:Buffer.from(f.keys.storageDEK).toString('base64')},2), /DURABLE_/);
});

test('explicit authority provisioning never recreates missing state and rejects wrong authority, key or stable ingress key', t => {
  const f=fixture(t); f.v.close();
  assert.throws(() => LocalSqliteAuthority.open({...f.authorityConfig,directory:join(f.root,'missing')}),/ANCHOR_MISSING/);
  assert.equal(existsSync(join(f.root,'missing')),false);
  assert.throws(() => LocalSqliteAuthority.create(f.authorityConfig),/ANCHOR_ALREADY_EXISTS/);
  assert.throws(() => LocalSqliteAuthority.open({...f.authorityConfig,authorityId:'other'}),/ANCHOR_IDENTITY/);
  const other=LocalSqliteAuthority.create({...f.authorityConfig,directory:join(f.root,'other-authority'),authorityId:'other'}); t.after(()=>other.close());
  assert.throws(()=>AnchoredVault.open({...f.config,authority:other},2),/ANCHOR_IDENTITY/);
  assert.throws(()=>AnchoredVault.open({...f.config,authority:undefined as any},2),/ANCHOR_CUSTODY_OVERLAP/);
  assert.throws(()=>AnchoredVault.open({...f.config,keys:{...f.keys,storageDEK:randomBytes(32)}},2),/ANCHOR_CORRUPT/);
  assert.throws(()=>AnchoredVault.open({...f.config,keys:{...f.keys,ingressKey:randomBytes(32)}},2),/ANCHOR_INGRESS_KEY/);
  assert.throws(()=>AnchoredVault.open({...f.config,keys:{...f.keys,keyEpoch:2}},2),/ANCHOR_IDENTITY/);
  assert.throws(()=>AnchoredVault.open(f.config,3),/ANCHOR_CORRUPT/);
});

test('authority custody and paths must be disjoint; duplicate writer and copied instance are rejected', t => {
  const f=fixture(t);
  assert.throws(()=>AnchoredVault.create({...f.config,directory:join(f.authority.directory,'nested')},2),/ANCHOR_CUSTODY_OVERLAP/);
  assert.throws(()=>AnchoredVault.create({...f.config,directory:join(f.root,'domain'),storageDomain:f.authority.custodyDomain},2),/ANCHOR_CUSTODY_OVERLAP/);
  assert.throws(()=>f.v.exportBackup(join(f.authority.directory,'backup')),/ANCHOR_CUSTODY_OVERLAP/);
  assert.throws(()=>f.v.exportBackup(join(f.config.directory,'backup')),/ANCHOR_CUSTODY_OVERLAP/);
  assert.throws(()=>AnchoredVault.open(f.config,2),/ANCHOR_WRITER_BUSY/);
  const copied=join(f.root,'copied'); cpSync(f.config.directory,copied,{recursive:true});
  assert.throws(()=>AnchoredVault.open({...f.config,directory:copied},2),/ANCHOR_INSTANCE_PATH/);
});

test('current-head backup verification rejects a valid stale backup and valid-prefix local rollback', t => {
  const f=fixture(t), backup=join(f.root,'backup'), archive=join(f.root,'old-prefix');
  f.v.exportBackup(backup); cpSync(f.config.directory,archive,{recursive:true}); f.v.claim('later','payload');
  assert.throws(()=>AnchoredVault.verifyBackup({backupDirectory:backup,authority:f.authority,keys:f.keys,maxCalls:2}),/ANCHOR_FENCED/);
  assert.throws(()=>AnchoredVault.restoreBackup({backupDirectory:backup,targetDirectory:join(f.root,'stale-target'),storageDomain:'vault-storage',authority:f.authority,keys:f.keys,maxCalls:2,operationId:'restore-stale'}),/ANCHOR_FENCED/);
  assert.equal(existsSync(join(f.root,'stale-target')),false);
  f.v.close(); renameSync(f.config.directory,join(f.root,'current-preserved')); cpSync(archive,f.config.directory,{recursive:true});
  assert.throws(()=>AnchoredVault.open(f.config,2),/ENOENT|ANCHOR_/);
});

test('recipient rewrap roundtrip changes only new envelope, rejects wrong KEK, recipient and epoch', t => {
  const f=fixture(t), kek=randomBytes(32), next=randomBytes(32), recipient={authorityId:f.authority.authorityId,vaultId:f.config.vaultId,recipient:'recipient-one'};
  const head=f.v.head, envelope=wrapKeySet(f.keys,kek,recipient), path=join(f.root,'recipient-two.json');
  rewrapKeyEnvelope(envelope,kek,{...recipient,keyEpoch:1},next,'recipient-two',path);
  const restored=unwrapKeySet(readFileSync(path),next,{...recipient,recipient:'recipient-two',keyEpoch:1});
  assert.deepEqual(restored,f.keys); assert.deepEqual(f.v.head,head);
  const reordered=wrapKeySet(f.keys,kek,{recipient:'recipient-one',vaultId:f.config.vaultId,authorityId:f.authority.authorityId});
  assert.deepEqual(unwrapKeySet(reordered,kek,{...recipient,keyEpoch:1}),f.keys);
  assert.throws(()=>unwrapKeySet(envelope,next,{...recipient,keyEpoch:1}),/ANCHOR_CORRUPT/);
  assert.throws(()=>unwrapKeySet(envelope,kek,{...recipient,recipient:'different',keyEpoch:1}),/ANCHOR_ENVELOPE/);
  assert.throws(()=>unwrapKeySet(envelope,kek,{...recipient,keyEpoch:2}),/ANCHOR_ENVELOPE/);
  assert.throws(()=>rewrapKeyEnvelope(envelope,kek,{...recipient,keyEpoch:1},next,'recipient-two',path),/EEXIST/);
});

test('authority rejects cross-vault writes, backward heads and illegal epoch/key transitions', t => {
  const f=fixture(t), other=AnchoredVault.create({...f.config,directory:join(f.root,'other-vault'),vaultId:'other-vault'},2);t.after(()=>other.close());
  const a=f.v.head,b=other.head;
  mkdirSync(join(f.root,'new-dir'));
  const base:PendingCommit={version:2,kind:'write',operationId:'invalid-transition',requestDigest:'a'.repeat(64),oldHead:a,
    newHead:{...a,sequence:a.sequence+1,digest:'b'.repeat(64)},stagePath:join(f.config.directory,'stage-invalid-transition.json'),stageDigest:'c'.repeat(64)};
  const invalid:PendingCommit[]=[
    {...base,newHead:{...b,sequence:b.sequence+1}},
    {...base,newHead:{...base.newHead,identity:'different'}},
    {...base,newHead:{...a}},
    {...base,newHead:{...base.newHead,ownerEpoch:a.ownerEpoch+1}},
    {...base,newHead:{...base.newHead,keyEpoch:a.keyEpoch+1}},
    {...base,kind:'create',oldHead:null,newHead:{...base.newHead,sequence:2}},
    {...base,kind:'restore',newHead:{...base.newHead,sequence:1,ownerEpoch:a.ownerEpoch+1}},
    {...base,kind:'rekey',newHead:{...base.newHead,sequence:1,ownerEpoch:a.ownerEpoch+1,instanceId:'new-instance',directory:join(f.root,'new-dir')}},
  ];
  for(const p of invalid)assert.throws(()=>f.authority.transaction(tx=>tx.prepare(p)),/ANCHOR_TRANSITION/);
  assert.deepEqual(f.authority.inspect(a.vaultId)!.head,a);assert.deepEqual(f.authority.inspect(b.vaultId)!.head,b);
});

test('low-level authority refuses a noncanonical target through a junction or symlink ancestor', t => {
  const f=fixture(t),alias=join(f.root,'alias');symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');
  const head=f.v.head;
  const p:PendingCommit={version:2,kind:'create',operationId:'aliased-stage',requestDigest:'a'.repeat(64),oldHead:null,
    newHead:{...head,vaultId:'aliased-vault',directory:join(alias,'vault')},
    stagePath:join(alias,'vault','stage-aliased-stage.json'),stageDigest:'c'.repeat(64)};
  assert.throws(()=>f.authority.transaction(tx=>tx.prepare(p)),/ANCHOR_TRANSITION/);
  assert.equal(f.authority.inspect('aliased-vault'),null);assert.deepEqual(f.v.head,head);
});

test('authority transaction capabilities expire permanently, including during a later transaction', t => {
  const f=fixture(t);let old:AuthorityTransaction|undefined;
  f.authority.transaction(tx=>{old=tx;});
  assert.throws(()=>old!.row(f.config.vaultId),/ANCHOR_TRANSACTION_EXPIRED/);
  f.authority.transaction(tx=>{assert.ok(tx.row(f.config.vaultId));assert.throws(()=>old!.row(f.config.vaultId),/ANCHOR_TRANSACTION_EXPIRED/);});
});

test('backing-file replacement is refused by Windows or detected by the live authority on POSIX', t => {
  const f=fixture(t),path=join(f.authority.directory,'authority.sqlite');
  if(process.platform==='win32') {
    assert.throws(()=>renameSync(path,path+'.preserved'),/EBUSY|EPERM/);
    assert.equal(existsSync(path),true); assert.ok(f.v.store.snapshot().length>0);
  } else {
    renameSync(path,path+'.preserved');
    assert.throws(()=>f.v.store.snapshot(),/ANCHOR_MISSING/);assert.equal(existsSync(path),false);
  }
});

test('a live authority revalidates provisioned identity on every operation', t => {
  const f=fixture(t),db=new DatabaseSync(join(f.authority.directory,'authority.sqlite'));
  try {db.prepare('UPDATE metadata SET authority_id=? WHERE id=1').run('changed-authority');}finally{db.close();}
  assert.throws(()=>f.v.store.snapshot(),/ANCHOR_IDENTITY/);assert.throws(()=>f.v.status,/ANCHOR_IDENTITY/);
});

for (const database of ['authority','writer'] as const) {
  for (const suffix of ['-journal','-wal','-shm']) {
    test(`${database} oversized ${suffix} is bounded before SQLite opens or recovers files`, t => {
      const f=fixture(t);f.v.close();
      if(database==='authority')f.authority.close();
      const file=join(database==='authority'?f.authority.directory:f.config.directory,`${database}.sqlite${suffix}`);
      writeFileSync(file,Buffer.alloc(0));truncateSync(file,database==='authority'?64*1024*1024+1:65537);
      if(database==='authority')assert.throws(()=>LocalSqliteAuthority.open(f.authorityConfig),/ANCHOR_FILE/);
      else assert.throws(()=>AnchoredVault.open(f.config,2),/ANCHOR_FILE/);
    });
  }
}

test('unknown writer and authority SQLite layouts are rejected rather than adopted', t => {
  const f=fixture(t);f.v.close();
  let db=new DatabaseSync(join(f.config.directory,'writer.sqlite'));db.exec('CREATE TABLE alien (value TEXT)');db.close();
  assert.throws(()=>AnchoredVault.open(f.config,2),/ANCHOR_WRITER_LAYOUT/);
  f.authority.close();db=new DatabaseSync(join(f.authority.directory,'authority.sqlite'));db.exec('CREATE TABLE alien (value TEXT)');db.close();
  assert.throws(()=>LocalSqliteAuthority.open(f.authorityConfig),/ANCHOR_IDENTITY/);
});

test('restore activates a new generation, fences live source and restart, and returns one immutable receipt', t => {
  const f=fixture(t), scope=f.v.store.ensureScope(who); f.v.store.acceptEvent(scope,event); f.v.claim('native','payload'); f.v.reserve('native');
  const backup=join(f.root,'backup'), target=join(f.root,'restored'); const backupReceipt=f.v.exportBackup(backup);
  const request: RestoreRequest={backupDirectory:backup,targetDirectory:target,storageDomain:'vault-storage',authority:f.authority,keys:f.keys,maxCalls:2,operationId:'restore-once'};
  const receipt=AnchoredVault.restoreBackup(request); assert.equal(receipt.newHead.ownerEpoch,2); assert.deepEqual(receipt.oldHead,backupReceipt.head);
  assert.deepEqual(AnchoredVault.restoreBackup(request),receipt);
  assert.throws(()=>AnchoredVault.restoreBackup({...request,targetDirectory:join(f.root,'different')}),/ANCHOR_OPERATION_CONFLICT/);
  for (const read of [()=>f.v.head,()=>f.v.status,()=>f.v.reserved,()=>f.v.store.snapshot(),()=>f.v.store.scope(scope.id),()=>f.v.store.revocationHighWater(),()=>f.v.store.diagnostics(),()=>f.v.store.search(scope,'violet'),()=>f.v.exportBackup(join(f.root,'denied-backup'))]) assert.throws(read,/ANCHOR_FENCED/);
  assert.throws(()=>f.v.claim('new','payload'),/ANCHOR_FENCED/); assert.throws(()=>f.v.reserve('native'),/ANCHOR_FENCED/); assert.throws(()=>f.v.store.ensureScope(who),/ANCHOR_FENCED/);
  f.v.close(); assert.throws(()=>AnchoredVault.open(f.config,2),/ANCHOR_FENCED/);
  const restored=AnchoredVault.open({...f.config,directory:target},2); t.after(()=>restored.close());
  assert.equal(restored.reserved,1); assert.throws(()=>restored.claim('native','payload'),/INTERACTION_TERMINATED/);
  assert.equal(restored.store.scope(scope.id).runtimeEpoch,scope.runtimeEpoch+1);
  assert.deepEqual(AnchoredVault.restoreBackup(request),receipt);
});

test('true DEK migration retains ingress and Store ledgers, quota, feedback consumption and revocation', t => {
  const f=fixture(t), scope=f.v.store.ensureScope(who), accepted=f.v.store.acceptEvent(scope,event);
  const stableStoreKey=ledgerKey(f.v); f.v.store.revoke(scope,accepted);
  f.v.claim('consumed-native','payload'); f.v.reserve('consumed-native'); f.v.terminal('consumed-native','ready','delivery'); f.v.terminal('consumed-native','taken','delivery'); f.v.terminal('consumed-native','acknowledged','delivery'); f.v.consumeFeedback('delivery');
  const backup=join(f.root,'backup'), target=join(f.root,'rekey'); f.v.exportBackup(backup);
  const newStorageDEK=randomBytes(32), request={backupDirectory:backup,targetDirectory:target,storageDomain:'vault-storage',authority:f.authority,keys:f.keys,maxCalls:2,operationId:'rekey-once',newStorageDEK};
  const receipt=AnchoredVault.rekeyBackup(request), nextKeys={...f.keys,keyEpoch:2,storageDEK:newStorageDEK};
  assert.equal(receipt.newHead.keyEpoch,2); assert.deepEqual(AnchoredVault.rekeyBackup(request),receipt);
  assert.throws(()=>AnchoredVault.open({...f.config,directory:target},2),/ANCHOR_IDENTITY/);
  assert.throws(()=>AnchoredVault.open({...f.config,directory:target,keys:{...f.keys,keyEpoch:2}},2),/ANCHOR_CORRUPT/);
  const v=AnchoredVault.open({...f.config,directory:target,keys:nextKeys},2); t.after(()=>v.close());
  assert.equal(ledgerKey(v),stableStoreKey); assert.equal(v.store.revocationHighWater(),1);
  assert.deepEqual(v.store.acceptEvent(v.store.scope(scope.id),event),{...accepted,currentStatus:'revoked'});
  assert.throws(()=>v.claim('consumed-native','payload'),/INTERACTION_TERMINATED/);
  assert.throws(()=>v.consumeFeedback('delivery'),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
  v.claim('second','payload'); v.reserve('second'); assert.equal(v.reserved,2); v.claim('third','payload'); assert.throws(()=>v.reserve('third'),/REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(existsSync(join(backup,'current-state.json')),true); assert.equal(existsSync(f.config.directory),true);
});

for (const point of ['stage-written','prepared','checkpoint-published','record-published','finalized'] as AnchoredFault[]) {
  test(`write interruption ${point}: poisoned handle, durable intent and exact explicit reconciliation`, t => {
    let armed=false; const f=fixture(t,{fault:p=>{if(armed&&p===point)throw new Error('SYNTHETIC_FAULT');}});
    f.v.claim('native','payload'); const before=f.v.head; armed=true;
    assert.throws(()=>f.v.reserve('native'),/ANCHOR_WRITE_FAILED/); assert.throws(()=>f.v.store.snapshot(),/ANCHOR_UNAVAILABLE/); f.v.close();
    const row=f.authority.inspect(f.config.vaultId)!;
    if (point==='stage-written') { assert.equal(row.status,'ACTIVE'); assert.deepEqual(row.head,before); }
    else if(point!=='finalized') {
      assert.equal(row.status,'PREPARED'); assert.throws(()=>AnchoredVault.open(f.config,2),/ANCHOR_PENDING/);
      const request={authority:f.authority,vaultId:f.config.vaultId,operationId:row.pending!.operationId,keys:f.keys,maxCalls:2};
      const receipt=AnchoredVault.reconcile(request); assert.deepEqual(AnchoredVault.reconcile(request),receipt);
    } else { assert.equal(row.status,'ACTIVE'); assert.equal(row.head!.sequence,before.sequence+1); }
    const opened=AnchoredVault.open(f.config,2); t.after(()=>opened.close());
    assert.equal(opened.reserved,point==='stage-written'?0:1); assert.throws(()=>opened.claim('native','payload'),/INTERACTION_TERMINATED/);
  });
}

for (const defect of ['missing-stage','tampered-stage','conflicting-record','wrong-key'] as const) {
  test(`unresolved ${defect} never refunds or falls back to old source`, t => {
    let armed=false;const f=fixture(t,{fault:p=>{if(armed&&p==='prepared')throw new Error('SYNTHETIC_FAULT');}});
    f.v.claim('native','payload'); armed=true; assert.throws(()=>f.v.reserve('native')); f.v.close();
    const pending=f.authority.inspect(f.config.vaultId)!.pending!;
    if(defect==='missing-stage')renameSync(pending.stagePath,pending.stagePath+'.preserved');
    if(defect==='tampered-stage')writeFileSync(pending.stagePath,Buffer.from('SYNTHETIC_CORRUPT'));
    if(defect==='conflicting-record')writeFileSync(join(f.config.directory,`record-${pending.newHead.sequence}.bin`),Buffer.from('SYNTHETIC_CONFLICT'));
    assert.throws(()=>AnchoredVault.reconcile({authority:f.authority,vaultId:f.config.vaultId,operationId:pending.operationId,keys:defect==='wrong-key'?{...f.keys,storageDEK:randomBytes(32)}:f.keys,maxCalls:2}),/ANCHOR_UNRESOLVED/);
    assert.equal(f.authority.inspect(f.config.vaultId)!.status,'PREPARED'); assert.throws(()=>AnchoredVault.open(f.config,2),/ANCHOR_PENDING/);
  });
}

test('pending restore fences source, rejects partial target, reconciles frozen cutover without replay', t => {
  const f=fixture(t),backup=join(f.root,'backup'),target=join(f.root,'partial');f.v.claim('native','payload');f.v.reserve('native');f.v.exportBackup(backup);
  const request={backupDirectory:backup,targetDirectory:target,storageDomain:'vault-storage',authority:f.authority,keys:f.keys,maxCalls:2,operationId:'interrupted-restore'};
  assert.throws(()=>AnchoredVault.restoreBackup({...request,fault:p=>{if(p==='prepared')throw new Error('SYNTHETIC_FAULT');}}),/SYNTHETIC_FAULT/);
  assert.throws(()=>f.v.status,/ANCHOR_PENDING/); assert.throws(()=>AnchoredVault.open({...f.config,directory:target},2),/ANCHOR_PENDING/);
  AnchoredVault.reconcile({authority:f.authority,vaultId:f.config.vaultId,operationId:request.operationId,keys:f.keys,maxCalls:2});
  assert.throws(()=>f.v.status,/ANCHOR_FENCED/); const v=AnchoredVault.open({...f.config,directory:target},2);t.after(()=>v.close());assert.equal(v.reserved,1);
});

test('fault and clock callbacks cannot reenter public store reads or close during a guarded operation', t => {
  let armed=false;let f: ReturnType<typeof fixture>;
  const check=()=>{if(armed){for(const read of [()=>f.v.status,()=>f.v.store.snapshot(),()=>f.v.store.diagnostics(),()=>f.v.close(),()=>f.v.store.close()])assert.throws(read,/ACCESS_BUSY/);}};
  f=fixture(t,{clock:{wall:()=>{check();return 100;},monotonic:()=>0},fault:()=>check()});armed=true;
  f.v.store.ensureScope(who);f.v.claim('native','payload');f.v.reserve('native');assert.equal(f.v.reserved,1);
  assert.throws(()=>f.authority.transaction(()=>Promise.resolve('must-not-escape')),/ANCHOR_ASYNC_GUARD/);
});

test('separate process cutover fences an already-open source without relying on in-process memory', t => {
  const f=fixture(t),backup=join(f.root,'backup'),target=join(f.root,'child-restored');f.v.claim('native','payload');f.v.reserve('native');f.v.exportBackup(backup);
  const result=child(`const r=AnchoredVault.restoreBackup({...input.request,authority,keys});console.log(JSON.stringify({epoch:r.newHead.ownerEpoch}));authority.close();`,
    {authority:f.authorityConfig,keys:wireKeys(f.keys),request:{backupDirectory:backup,targetDirectory:target,storageDomain:'vault-storage',maxCalls:2,operationId:'process-cutover'}});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{epoch:2});assert.throws(()=>f.v.store.snapshot(),/ANCHOR_FENCED/);
});

test('cross-process lock remains held for complete synchronous store read, including clock callback', t => {
  let armed=false;let f:ReturnType<typeof fixture>;let observed=0;
  f=fixture(t,{clock:{wall:()=>{if(armed){const result=child(`try{authority.inspect(input.vaultId);process.exit(1);}catch(e){console.log(e.code);authority.close();}`,
    {authority:f.authorityConfig,keys:wireKeys(f.keys),vaultId:f.config.vaultId});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/ANCHOR_BUSY/);observed++;}return 100;},monotonic:()=>0}});
  const scope=f.v.store.ensureScope(who);armed=true;f.v.store.search(scope,'synthetic');
  f.v.store.acceptEvent(scope,event);assert.ok(observed>0);
});

test('another process holding authority lock blocks every direct store read until release', async t => {
  const f=fixture(t),scope=f.v.store.ensureScope(who);
  const p=spawn(process.execPath,['--input-type=module','-e',childPrelude+`authority.transaction(()=>{console.log('LOCKED');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);});authority.close();`],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});
  p.stdin.end(JSON.stringify({authority:f.authorityConfig,keys:wireKeys(f.keys)}));
  await new Promise<void>((resolve,reject)=>{p.stdout.once('data',()=>resolve());p.once('error',reject);p.once('exit',code=>{if(code)reject(new Error(`child exit ${code}`));});});
  for(const read of [()=>f.v.store.snapshot(),()=>f.v.store.scope(scope.id),()=>f.v.store.revocationHighWater(),()=>f.v.store.diagnostics(),()=>f.v.status])assert.throws(read,/ANCHOR_BUSY/);
  await new Promise<void>(resolve=>p.once('exit',()=>resolve()));assert.equal(f.v.store.scope(scope.id).id,scope.id);
});

for (const point of ['prepared','record-published','finalized'] as AnchoredFault[]) {
  test(`real process death at ${point} preserves reservation and reconciles without provider replay`, t => {
    const f=fixture(t);f.v.claim('native','payload');f.v.close();
    const result=child(`let armed=false;const v=AnchoredVault.open({...input.config,authority,keys},2,{fault:p=>{if(armed&&p===input.point)process.exit(47);}});v.claim('child-native','payload');armed=true;v.reserve('child-native');`,
      {authority:f.authorityConfig,keys:wireKeys(f.keys),config:{directory:f.config.directory,vaultId:f.config.vaultId,identity:f.config.identity,storageDomain:f.config.storageDomain},point});
    assert.equal(result.status,47,JSON.stringify({error:result.error?{message:result.error.message,code:'code' in result.error?result.error.code:null}:null,
      signal:result.signal,status:result.status,stderr:result.stderr}));
    const row=f.authority.inspect(f.config.vaultId)!;
    if(row.status==='PREPARED')AnchoredVault.reconcile({authority:f.authority,vaultId:f.config.vaultId,operationId:row.pending!.operationId,keys:f.keys,maxCalls:2});
    const v=AnchoredVault.open(f.config,2);t.after(()=>v.close());assert.equal(v.reserved,1);
  });
}
