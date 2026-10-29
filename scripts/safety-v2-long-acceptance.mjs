#!/usr/bin/env node
// STATICALLY PREPARED ONLY. This file has not executed the 8193 history.
// Copy the reviewed script into the frozen Safety v2 source tree, then explicitly use --run.
// No SQL, fabricated history, cap overrides, provider, model, training, retry or cleanup path.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';

const VERSION = 'safety-v2-long-acceptance/2026-10-29.1';
const SCRIPT = fileURLToPath(import.meta.url), REPO = path.resolve(path.dirname(SCRIPT),'..');
const NATIVE_TEMP = 'C:/Users/saigy/AppData/Local/Temp';
const P = Object.freeze({requests:8193,maxCalls:0,archiveEvery:256,archives:32,
  rolloverEvery:128,maxReceipts:256,maxJsonBytes:1048576,maxSegments:65,maxR:16640,
  entryFramedBytes:3584,imageBytes:262144,blobBytes:32768,stageBytes:16384,recordBytes:8192,
  ownedBytes:2*1024*1024*1024,totalMs:120*60*1000,stageMs:6*60*1000,progressEvery:64,
  profile:'blocks-br4-safety-ledger-v2'});
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const stamp = () => new Date().toISOString();
const id = i => 'r'+String(i).padStart(5,'0'), fp = i => 'f'+String(i).padStart(5,'0');
const json = p => JSON.parse(fs.readFileSync(p,'utf8'));
function writeNew(p,v) { fs.writeFileSync(p,JSON.stringify(v,null,2),{flag:'wx',mode:0o600}); }
function replaceOwn(p,v) { const t=p+'.next'; fs.writeFileSync(t,JSON.stringify(v,null,2),{flag:'wx',mode:0o600}); fs.renameSync(t,p); }
function sourceIdentity() {
  const git=(...a)=>execFileSync('C:/Program Files/Git/bin/git.exe',a,{cwd:REPO,encoding:'utf8'});
  const files=[];
  const visit=name=>{
    const p=path.join(REPO,name),s=fs.lstatSync(p);
    assert.ok(!s.isSymbolicLink(),'SOURCE_LINK_REFUSED:'+name);
    if(s.isDirectory()) {
      assert.ok(name==='src'||name.startsWith('src/'),'SOURCE_DIRECTORY_REFUSED');
      for(const child of fs.readdirSync(p).sort()) {
        assert.ok(!child.startsWith('.'),'SOURCE_HIDDEN_ENTRY_REFUSED');
        visit(name+'/'+child);
      }
    } else {
      assert.ok(s.isFile(),'SOURCE_SPECIAL_FILE_REFUSED:'+name);
      // Refuse unexpected/non-source files without reading them; never scan credentials or data.
      assert.ok(name==='package.json'||name==='package-lock.json'||name==='scripts/safety-v2-long-acceptance.mjs'
        ||(name.startsWith('src/')&&/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)),'NON_SOURCE_ENTRY_REFUSED:'+name);
      const b=fs.readFileSync(p);files.push({name,bytes:b.length,sha256:sha(b)});
    }
  };
  for(const name of ['src','scripts/safety-v2-long-acceptance.mjs','package.json','package-lock.json'])visit(name);
  return {version:VERSION,scriptSHA256:sha(fs.readFileSync(SCRIPT)),node:process.version,
    repository:REPO,head:git('rev-parse','HEAD').trim(),
    status:git('--no-optional-locks','status','--porcelain=v1','--untracked-files=all'),
    files};
}
function inputFileBound(name,bytes) {
  const limit=/^blob-.*\.bin$/.test(name)?P.blobBytes:
    /^stage-.*\.json$/.test(name)?P.stageBytes:/^record-\d+\.bin$/.test(name)?P.recordBytes:null;
  if(limit!==null && bytes>limit) throw Error('FIXED_INPUT_FILE_BOUND:'+name+':'+bytes);
}
async function scanOwned(root) {
  let bytes=0,files=0; const dirs=[root];
  while(dirs.length) {
    const dir=dirs.pop(); let handle;
    try {handle=await fsp.opendir(dir);} catch(e) {if(e.code==='ENOENT')continue;throw e;}
    for await(const ent of handle) {
      const p=path.join(dir,ent.name); let s;
      try{s=await fsp.lstat(p);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      if(s.isSymbolicLink())throw Error('OWNED_TREE_LINK_REFUSED');
      if(s.isDirectory())dirs.push(p);
      else if(s.isFile()){bytes+=s.size;files++;inputFileBound(ent.name,s.size);if(bytes>P.ownedBytes)throw Error('OWNED_TREE_2GIB');}
      else throw Error('OWNED_TREE_SPECIAL_FILE');
    }
  }
  return{bytes,files};
}
function encodeKeys(k) {return{version:k.version,keyEpoch:k.keyEpoch,storageDEK:Buffer.from(k.storageDEK).toString('base64'),ingressKey:Buffer.from(k.ingressKey).toString('base64')};}
function decodeKeys(k) {return{...k,storageDEK:Buffer.from(k.storageDEK,'base64'),ingressKey:Buffer.from(k.ingressKey,'base64')};}
function safeError(e) {return{name:e?.name,code:e?.code??null,message:String(e?.message??e)};}

async function parent() {
  assert.equal(process.platform,'win32','This fixed acceptance uses the native Windows TEMP contract.');
  assert.match(process.version,/^v24\./); assert.ok(Number(process.versions.node.split('.')[1])>=16);
  assert.equal(fs.realpathSync.native(os.tmpdir()).toLowerCase(),fs.realpathSync.native(NATIVE_TEMP).toLowerCase());
  // Freeze all public source bytes before creating a run. Missing runtime APIs refuse; no profile fallback.
  const sourceBefore=sourceIdentity();
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(NATIVE_TEMP,'sv2-long-')));
  const token=crypto.randomBytes(24).toString('hex'),started=performance.now(),startedAt=stamp();
  writeNew(path.join(root,'OWNED.json'),{version:VERSION,token,parentPid:process.pid,sourceBefore,parameters:P});
  const events=path.join(root,'progress.jsonl');
  const emit=v=>fs.appendFileSync(events,JSON.stringify({utc:stamp(),...v})+'\n');
  emit({event:'start',parameters:P,source:sourceBefore,modelProviderCalls:0,
    networkClaim:'NO_PROVIDER_OR_MODEL_API_IN_THIS_SCRIPT; NOT_OS_ENFORCED'});
  let active=null,incomplete=null,phaseTimer=null,scanTask=null,peakOwnedBytes=0;
  const roleResults=[];
  const stop=reason=>{const first=!incomplete;if(first)incomplete={reason,utc:stamp()};
    if(active && active.exitCode===null && active.signalCode===null){
      let requested=false;try{requested=active.kill('SIGKILL');}catch{}
      try{emit({event:'watchdog-kill',pid:active.pid,requested,signal:'SIGKILL'});}catch{}}
    if(first)try{emit({event:'watchdog-stop',reason});}catch{}};
  const interrupted=()=>stop('CONTROLLER_INTERRUPTED');
  process.on('SIGINT',interrupted);process.on('SIGTERM',interrupted);
  const totalTimer=setTimeout(()=>stop('TOTAL_120_MINUTES'),P.totalMs);
  const monitor=setInterval(()=>{if(scanTask)return;
    scanTask=(async()=>{try{const x=await scanOwned(root);peakOwnedBytes=Math.max(peakOwnedBytes,x.bytes);}
      catch(e){stop(String(e.message));}})().finally(()=>{scanTask=null;});},1000);
  async function role(name) {
    if(incomplete)return;
    const out=fs.openSync(path.join(root,name+'.stdout.log'),'wx');
    const err=fs.openSync(path.join(root,name+'.stderr.log'),'wx');
    let lastHistoryStage=0,phase='role:'+name;
    const arm=()=>{clearTimeout(phaseTimer);phaseTimer=setTimeout(()=>stop('STAGE_6_MINUTES:'+phase),P.stageMs);};
    arm(); emit({event:'child-start',role:name,phase});
    try {
      const result=await new Promise(resolve=>{
        const child=spawn(process.execPath,['--max-old-space-size=512',SCRIPT,'--child',name,root],{
          cwd:root,windowsHide:true,stdio:['ignore',out,err,'ipc'],
          env:{...process.env,TEMP:NATIVE_TEMP,TMP:NATIVE_TEMP,NODE_DISABLE_COMPILE_CACHE:'1',SV2_LONG_TOKEN:token}});
        active=child;let spawnError=null;
        child.on('error',e=>{spawnError=safeError(e);});
        child.on('message',m=>{
          try {
          if(m?.event==='phase' && name==='history') {
            if(!Number.isInteger(m.stage)||m.stage!==lastHistoryStage+1||m.stage>33){stop('INVALID_PHASE_SEQUENCE');return;}
            lastHistoryStage=m.stage;phase='history:'+m.stage;arm();
          }
          if(m?.event==='progress')emit({event:'progress',role:name,...m});
          } catch(e) {stop('CONTROLLER_IPC:'+String(e.message));}
        });
        child.on('close',(code,signal)=>resolve({role:name,pid:child.pid,code,signal,error:spawnError}));
      });
      active=null;roleResults.push(result);emit({event:'child-close',...result});
      const resultPath=path.join(root,name+'.result.json');
      result.actual=fs.existsSync(resultPath)?json(resultPath):null;
      emit({event:'child-result',role:name,actual:result.actual});
      if(result.code!==0)stop('CHILD_NOT_COMPLETE:'+name);
      else {
        const r=result.actual;
        if(r?.status!=='COMPLETE')stop('MISSING_COMPLETE_RESULT:'+name);
      }
    } finally {clearTimeout(phaseTimer);fs.closeSync(out);fs.closeSync(err);}
  }
  try {
    for(const name of ['history','verify-initial','cutover','verify-restored']){await role(name);if(incomplete)break;}
    if(!incomplete) {
      const x=await scanOwned(root);peakOwnedBytes=Math.max(peakOwnedBytes,x.bytes);
      if(performance.now()-started>=P.totalMs)stop('TOTAL_120_MINUTES');
      if(JSON.stringify(sourceIdentity())!==JSON.stringify(sourceBefore))stop('SOURCE_IDENTITY_CHANGED');
    }
  } catch(e) {stop('PARENT:'+String(e.message));}
  finally {clearInterval(monitor);if(scanTask)await scanTask;clearTimeout(totalTimer);clearTimeout(phaseTimer);
    process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);}
  if(performance.now()-started>=P.totalMs)stop('TOTAL_120_MINUTES');
  const finalDisk=await scanOwned(root).catch(e=>{stop('FINAL_OWNED_SCAN:'+String(e.message));return null;});
  if(performance.now()-started>=P.totalMs)stop('TOTAL_120_MINUTES');
  const summary={version:VERSION,status:incomplete?'INCOMPLETE':'PASS',startedAt,
    finished:stamp(),elapsedMs:performance.now()-started,parameters:P,root,sourceBefore,roleResults,
    incomplete,peakOwnedBytes,modelProviderCalls:0,networkVerification:'NOT_OS_ENFORCED',
    evidence:'Raw child stderr/stdout, every previous generation/backup/failure, authority PREPARED and CURRENT are retained. No retry, removal or new-root replay.'};
  // Include this final evidence file in the same fixed disk gate before claiming PASS.
  const summaryBytes=()=>Buffer.byteLength(JSON.stringify(summary,null,2));
  if(finalDisk && finalDisk.bytes+summaryBytes()>P.ownedBytes){
    stop('OWNED_TREE_2GIB_FINAL_EVIDENCE');summary.status='INCOMPLETE';summary.incomplete=incomplete;
  }
  writeNew(path.join(root,'summary.json'),summary);
  console.log(JSON.stringify({status:summary.status,root,elapsedMs:summary.elapsedMs,summarySHA256:sha(fs.readFileSync(path.join(root,'summary.json')))}));
  process.exitCode=incomplete?2:0;
}

async function child(role,root) {
  assert.ok(process.send,'Internal children require the owning controller IPC channel.');
  root=fs.realpathSync.native(root);
  assert.equal(path.dirname(root).toLowerCase(),fs.realpathSync.native(NATIVE_TEMP).toLowerCase());
  const owner=json(path.join(root,'OWNED.json'));
  assert.equal(owner.version,VERSION);assert.equal(owner.token,process.env.SV2_LONG_TOKEN);
  assert.equal(owner.sourceBefore.scriptSHA256,sha(fs.readFileSync(SCRIPT)));
  assert.deepEqual(sourceIdentity(),owner.sourceBefore,'SOURCE_IDENTITY_CHANGED_BEFORE_CHILD_IMPORT');
  writeNew(path.join(root,role+'.started.json'),{version:VERSION,utc:stamp(),pid:process.pid});
  const load=name=>import(pathToFileURL(path.join(REPO,'src',name)).href);
  const [{AnchoredVault},{LocalSqliteAuthority,AUTHORITY_READ_LIMIT,AUTHORITY_WRITE_LIMIT},{generateKeySet},{directoryReader},
    {safetyOperation},{reconstructSafetyV2},{segmentFrame}]=await Promise.all([
      load('anchored-vault.ts'),load('local-sqlite-authority.ts'),load('anchored-codec.ts'),
      load('incremental-storage.ts'),load('safety-v2-format.ts'),load('incremental-safety-v2.ts'),
      load('receipt-segments.ts')]);
  assert.equal(typeof AnchoredVault.archiveTerminalSafetyV2,'function');
  assert.equal(AUTHORITY_READ_LIMIT,64*1024*1024);assert.equal(AUTHORITY_WRITE_LIMIT,Math.floor(AUTHORITY_READ_LIMIT/3));
  const ac={directory:path.join(root,'a'),authorityId:'a',custodyDomain:'c'};
  const clock={wall:()=>100,monotonic:()=>0};
  let authority=null,v=null,state,privateState,known,pending,pendingHeads,stageFiles,headDigests;
  function save() {
    state.ids=[...known];state.pending=[...pending];state.pendingHeads=[...pendingHeads];
    state.stageFiles=[...stageFiles];state.headDigests=[...headDigests];
    replaceOwn(path.join(root,'CURRENT.json'),state);
    replaceOwn(path.join(root,'PRIVATE.json'),privateState);
  }
  function keys() {return decodeKeys(privateState.epochs[state.keyEpoch]);}
  function config() {return{directory:state.head.directory,vaultId:'v',identity:'s',storageDomain:'p',
    storageProfile:P.profile,schemaVersion:2,keys:keys(),authority};}
  function capture(head) {
    // Public heads are collected cheaply. Batch discovery uses stage filenames, never sealed-record JSON.
    assert.ok(path.resolve(head.directory).startsWith(root+path.sep),'HEAD_OUTSIDE_OWNED_ROOT');
    assert.equal(head.vaultId,'v');
    if(!headDigests.has(head.digest))pendingHeads.set(head.digest,head);
    state.head=head;
  }
  function collectStages() {
    // Filename is an ID-discovery hint only. Receipt, exact public head and ciphertext digest bind it.
    const directories=new Set([...pendingHeads.values()].map(h=>h.directory));
    for(const directory of directories)for(const name of fs.readdirSync(directory)) {
      const match=/^stage-(.+)\.json$/.exec(name);if(!match)continue;
      const p=path.join(directory,name);if(stageFiles.has(p))continue;
      const bytes=fs.readFileSync(p);inputFileBound(name,bytes.length);
      const stage=JSON.parse(bytes.toString('utf8')),expected=pendingHeads.get(stage.head?.digest);
      assert.ok(expected,'UNEXPECTED_STAGE_HEAD');assert.deepEqual(stage.head,expected);
      assert.equal(typeof stage.record,'string');const sealed=Buffer.from(stage.record,'base64');
      assert.equal(sealed.toString('base64'),stage.record);assert.equal(sha(sealed),stage.head.digest);
      const recordName='record-'+stage.head.sequence+'.bin',recordBytes=fs.readFileSync(path.join(directory,recordName));
      inputFileBound(recordName,recordBytes.length);assert.equal(sha(recordBytes),stage.head.digest);
      const key=JSON.stringify(['v',match[1]]);assert.ok(!known.has(key),'DUPLICATE_STAGE_OPERATION_ID');
      known.add(key);pending.set(key,stage.head);stageFiles.add(p);headDigests.add(stage.head.digest);
      pendingHeads.delete(stage.head.digest);
    }
    assert.equal(pendingHeads.size,0,'MISSING_STAGE_FOR_PUBLIC_HEAD');
  }
  function verifyNewReceipts() {
    collectStages();
    const segmentId='if8-'+String(state.rollovers+1).padStart(3,'0');
    const ids=[...pending.keys()];
    const report=authority.transaction(tx=>{
      for(const composite of ids) {
        const [vaultId,operationId]=JSON.parse(composite),receipt=tx.receipt(vaultId,operationId);
        assert.ok(receipt,'MISSING_ACTUAL_RECEIPT');assert.equal(receipt.operationId,operationId);
        assert.deepEqual(receipt.newHead,pending.get(composite),'RECEIPT_HEAD_BINDING');
        const entry={vaultId,operationId,json:JSON.stringify(receipt)};
        const framed=Buffer.byteLength(segmentFrame(segmentId,[entry]));
        assert.ok(framed<=P.entryFramedBytes,'ESCAPED_FRAMED_ENTRY_OVER_3584');
        state.maxEntryFramedBytes=Math.max(state.maxEntryFramedBytes,framed);
      }
      return tx.capacity();
    });
    assert.equal(report.schemaVersion,6);
    assert.equal(report.receipts.count,known.size,'EVERY_PRODUCED_R_MUST_BE_KNOWN');
    assert.ok(known.size<=P.maxR,'TOTAL_R_OVER_16640');
    assert.ok(report.receiptStorage.segments.count<=P.maxSegments,'S_OVER_65');
    for(const key of ids)pending.delete(key);
    return report;
  }
  function rollover() {
    verifyNewReceipts();
    const operationId='if8-'+String(state.rollovers+1).padStart(3,'0');
    const r=authority.rolloverReceipts({operationId,maxReceipts:P.maxReceipts,maxJsonBytes:P.maxJsonBytes});
    assert.ok(r.receiptCount>0&&r.receiptCount<=256);
    assert.ok(r.decodedBytes>0&&r.decodedBytes<=1048576&&r.encodedBytes>0&&r.encodedBytes<=1048576);
    state.rollovers++;
    assert.ok(state.rollovers<=P.maxSegments);
    const report=verifyNewReceipts();
    assert.equal(report.receiptStorage.segments.count,state.rollovers);
    fs.appendFileSync(path.join(root,'progress.jsonl'),JSON.stringify({utc:stamp(),event:'IF8',r,
      billing:'All candidate R were individually bounded, therefore the selected subset is bounded; selected IDs are not enumerated.'})+'\n');
  }
  function inspect(expectedCount,full=false) {
    return safetyOperation(()=>{
      const d=reconstructSafetyV2(state.head,directoryReader(state.head.directory),keys(),0);
      try {
        assert.ok(d.image.length<=P.imageBytes,'STORE_IMAGE_OVER_256KIB');
        const stats=d.view.stats();assert.equal(stats.count,expectedCount);assert.equal(stats.reserved,0);assert.equal(stats.unknown,0);
        assert.equal(d.view.globals.identity,'s');assert.equal(d.view.globals.maxCalls,0);assert.equal(d.view.globals.reserved,0);
        assert.equal(d.view.globals.lastSourceRef,null);assert.equal(d.view.globals.lastAcknowledgedDeliveryId,null);
        assert.equal(d.view.globals.lastWall,100);
        if(full) {
          let n=0;const seen=new Set();
          const h=x=>crypto.createHmac('sha256',keys().ingressKey).update(JSON.stringify(x)).digest('hex');
          for(const row of d.view.iterateEntries()) {
            assert.equal(row.ordinal,n);assert.equal(row.entry.key,h(['ingress',id(n)]));
            assert.equal(row.entry.fingerprint,h(['payload',fp(n)]));
            assert.equal(row.entry.state,'failed');assert.equal(row.entry.reserved,false);
            assert.equal(row.entry.deliveryId,null);assert.equal(row.entry.feedbackConsumed,false);
            assert.ok(!seen.has(row.entry.key));seen.add(row.entry.key);n++;
          }
          assert.equal(n,P.requests);assert.equal(seen.size,P.requests);
        }
        return{stats,imageBytes:d.image.length,hot:d.view.hotCount,cold:d.view.coldCount};
      } finally {d.close();}
    });
  }
  async function progress(n) {
    const disk=await scanOwned(root),report=verifyNewReceipts(),view=inspect(n);save();
    process.send({event:'progress',completed:n,archives:state.archives,rollovers:state.rollovers,
      R:report.receipts.count,S:report.receiptStorage.segments.count,maxEntryFramedBytes:state.maxEntryFramedBytes,view,ownedBytes:disk.bytes});
  }
  function req(operationId,target) {return{authority,vaultId:'v',keys:keys(),maxCalls:0,
    targetDirectory:path.join(root,target),storageDomain:'p',operationId};}
  function openCurrent() {v=AnchoredVault.open(config(),0,{clock});capture(v.head);}
  function expectFenced(body) {assert.throws(body,e=>e?.code==='ANCHOR_FENCED'||e?.message==='ANCHOR_FENCED');}
  try {
    if(role==='history') {
      process.send({event:'phase',stage:1});
      LocalSqliteAuthority.create(ac).close();
      LocalSqliteAuthority.upgradeSchema(ac,'operator-attested-stopped');
      LocalSqliteAuthority.upgradeReceiptSchema(ac,'operator-attested-stopped');
      LocalSqliteAuthority.upgradeColdSchema(ac,'operator-attested-stopped');
      LocalSqliteAuthority.upgradeShardedColdSchema(ac,'operator-attested-stopped');
      authority=LocalSqliteAuthority.open(ac);
      const k=generateKeySet();privateState={epochs:{1:encodeKeys(k)}};
      state={version:VERSION,keyEpoch:1,head:null,completed:0,archives:0,rollovers:0,maxEntryFramedBytes:0};
      known=new Set();pending=new Map();pendingHeads=new Map();stageFiles=new Set();headDigests=new Set();
      v=AnchoredVault.create({directory:path.join(root,'g00'),vaultId:'v',identity:'s',storageDomain:'p',
        storageProfile:P.profile,schemaVersion:2,keys:k,authority},0,{clock});
      capture(v.head);save();
      for(let i=0;i<P.requests;i++) {
        v.claim(id(i),fp(i));capture(v.head);
        v.terminal(id(i),'failed');capture(v.head);
        state.completed=i+1;
        if(state.completed%128===0)rollover();
        if(state.completed%256===0) {
          v.close();v=null;
          const number=state.completed/256,r=AnchoredVault.archiveTerminalSafetyV2(req('arc-'+String(number).padStart(2,'0'),'g'+String(number).padStart(2,'0')));
          assert.equal(r.kind,'compaction');capture(r.newHead);
          state.archives++;openCurrent();save();
          process.send({event:'phase',stage:number+1});
        }
        if(state.completed%64===0)await progress(state.completed);
      }
      rollover(); // Explicit 65th/tail rollover. NO_BENEFIT or any capacity refusal is fatal.
      assert.equal(state.archives,32);assert.equal(state.rollovers,65);await progress(P.requests);
    } else {
      state=json(path.join(root,'CURRENT.json'));privateState=json(path.join(root,'PRIVATE.json'));
      known=new Set(state.ids);pending=new Map(state.pending);pendingHeads=new Map(state.pendingHeads);
      stageFiles=new Set(state.stageFiles);headDigests=new Set(state.headDigests);authority=LocalSqliteAuthority.open(ac);
      assert.equal(state.completed,P.requests);
      if(role==='verify-initial'||role==='verify-restored') {
        openCurrent();
        inspect(P.requests,true);
        const old=JSON.stringify(v.head);
        assert.throws(()=>v.claim(id(0),'conflicting-fingerprint'),e=>e?.code==='INTERACTION_IDEMPOTENCY_CONFLICT'||e?.message==='INTERACTION_IDEMPOTENCY_CONFLICT');
        assert.equal(JSON.stringify(v.head),old);
        await progress(P.requests);
      } else if(role==='cutover') {
        openCurrent();const oldConfig=config(),oldKeys=keys(),backupA=path.join(root,'ba');
        v.exportBackup(backupA);
        AnchoredVault.verifyBackup({authority,keys:oldKeys,maxCalls:0,backupDirectory:backupA});
        const nextEpoch=state.keyEpoch+1,nextKeys={...oldKeys,keyEpoch:nextEpoch,storageDEK:crypto.randomBytes(32)};
        privateState.epochs[nextEpoch]=encodeKeys(nextKeys);save(); // Retain both keysets before any durable cutover.
        const r=AnchoredVault.rekeyBackup({...req('rekey','rk'),backupDirectory:backupA,newStorageDEK:nextKeys.storageDEK});
        expectFenced(()=>v.head);v.close();v=null;
        expectFenced(()=>AnchoredVault.open(oldConfig,0,{clock}));
        state.keyEpoch=nextEpoch;capture(r.newHead);save();openCurrent();
        const backupB=path.join(root,'bb');v.exportBackup(backupB);
        AnchoredVault.verifyBackup({authority,keys:keys(),maxCalls:0,backupDirectory:backupB});
        const priorConfig=config();
        const restored=AnchoredVault.restoreBackup({...req('restore','rs'),backupDirectory:backupB});
        expectFenced(()=>v.head);v.close();v=null;
        expectFenced(()=>AnchoredVault.open(priorConfig,0,{clock}));
        expectFenced(()=>AnchoredVault.restoreBackup({...req('old-backup','rejected'),keys:oldKeys,backupDirectory:backupA}));
        capture(restored.newHead);save();inspect(P.requests,true);await progress(P.requests);
      } else throw Error('UNKNOWN_ROLE');
    }
    assert.ok(known.size<=P.maxR);save();
    assert.deepEqual(sourceIdentity(),owner.sourceBefore,'SOURCE_IDENTITY_CHANGED_AT_CHILD_END');
    writeNew(path.join(root,role+'.result.json'),{status:'COMPLETE',role,completed:state.completed,
      archives:state.archives,rollovers:state.rollovers,R:known.size,maxEntryFramedBytes:state.maxEntryFramedBytes,modelProviderCalls:0});
  } catch(e) {
    try {if(state&&known&&pending)save();} catch {}
    writeNew(path.join(root,role+'.result.json'),{status:'INCOMPLETE',role,error:safeError(e),
      completed:state?.completed??0,archives:state?.archives??0,rollovers:state?.rollovers??0});
    console.error(e?.stack??String(e));process.exitCode=2;
  } finally {try{v?.close();}finally{authority?.close();}}
}

if(process.argv[2]==='--child') {
  assert.equal(process.argv.length,5);await child(process.argv[3],process.argv[4]);
} else if(process.argv.length===3&&process.argv[2]==='--run') await parent();
else {
  console.log(JSON.stringify({version:VERSION,status:'NOT_RUN',parameters:P,
    usage:'node scripts/safety-v2-long-acceptance.mjs --run',
    note:'Requires reviewed/frozen Safety v2 modules. --check is syntax-only. No automatic resume or new-root retry.'}));
  if(process.argv.length>2)process.exitCode=64;
}

