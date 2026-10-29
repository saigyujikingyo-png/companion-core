import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { canonical,hash } from '../src/wf1-json.ts';
import { syntheticOwner } from './teaching-cycle-fixture.ts';
import { installSyntheticTokenizer } from './teaching-tokenizer-fixture.ts';
import { teachingNativeFixture,syntheticCredentials,syntheticTeachingFetch } from './teaching-native-fixture.mjs';
import { initializeTeachingCustody,revokeTeachingCycle,writeNew } from '../runtime/teaching-cycle/teaching-host-bindings.mjs';

const windows=process.platform==='win32',quote=s=>"'"+s.replaceAll("'","''")+"'";
function configureWindows(f){const c=f.config,shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');c.launcher.shellPath=shell;c.launcher.shellSha256=hash(fs.readFileSync(shell));return shell;}
function save(f){fs.writeFileSync(f.configPath,canonical(f.config)+'\n');return hash(fs.readFileSync(f.configPath));}
function invoke(f,action,timeout=90000,nonUtf8=false){const launcher=path.join(f.config.sourceRoot,'runtime/teaching-cycle/Invoke-TeachingCycle.ps1'),sha=hash(fs.readFileSync(f.configPath));
  const args=nonUtf8?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(`[Console]::InputEncoding=[Text.Encoding]::GetEncoding(437); [Console]::OutputEncoding=[Text.Encoding]::GetEncoding(437); $OutputEncoding=[Text.Encoding]::GetEncoding(437); & ${quote(launcher)} -Action ${action} -ConfigPath ${quote(f.configPath)} -ConfigSha256 '${sha}'`,'utf16le').toString('base64')]:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',launcher,'-Action',action,'-ConfigPath',f.configPath,'-ConfigSha256',sha];
  const result=spawnSync(f.config.launcher.shellPath,args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:2097152});return {...result,safe:result.stdout?JSON.parse(result.stdout.trim()):null};}
function sourceSnapshot(f,name){const snapshot=path.join(f.base,name);fs.mkdirSync(snapshot);for(const pin of f.config.sourcePins){const target=path.join(snapshot,pin.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(f.config.sourceRoot,pin.path),target,fs.constants.COPYFILE_EXCL);}return snapshot;}
function wrapSynthetic(f,withCredentials=false){
  const values=[{file:path.join(f.config.controlRoot,'custody.dpapi'),bytes:f.key}];if(withCredentials)values.push({file:f.config.launcher.credentialsDpapiPath,bytes:Buffer.from(JSON.stringify(syntheticCredentials))});
  for(const v of values){const script=`Add-Type -AssemblyName System.Security; [byte[]]$syntheticBytes=[Convert]::FromBase64String('${v.bytes.toString('base64')}'); $wrapped=[Security.Cryptography.ProtectedData]::Protect($syntheticBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); $file=New-Object IO.FileStream(${quote(v.file)},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try{$file.Write($wrapped,0,$wrapped.Length);$file.Flush($true)}finally{$file.Dispose();[Array]::Clear($syntheticBytes,0,$syntheticBytes.Length);[Array]::Clear($wrapped,0,$wrapped.Length)}`;const wrap=spawnSync(f.config.launcher.shellPath,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(wrap.status,0,wrap.stderr);}
}

test('PS5 revoke JSON closure enumerates exact string paths and rejects nested/duplicate entries',{skip:!windows},()=>{
  const shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),launcher=fileURLToPath(new URL('../runtime/teaching-cycle/Invoke-TeachingCycle.ps1',import.meta.url)),revoker=fileURLToPath(new URL('../runtime/teaching-cycle/teaching-revoker.mjs',import.meta.url));
  const script=`$ErrorActionPreference='Stop'; if($PSVersionTable.PSEdition-cne'Desktop'-or$PSVersionTable.PSVersion.Major-ne5){throw 'wrong shell'}; $t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(launcher)},[ref]$t,[ref]$e);$fn=$ast.Find({param($n)$n-is[System.Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-ceq'ReadRevokeClosure'},$true);. ([scriptblock]::Create($fn.Extent.Text));$source=Get-Content -LiteralPath ${quote(revoker)} -Raw -Encoding UTF8;$paths=ReadRevokeClosure $source;if($paths.Count-ne14-or$paths[0]-isnot[string]-or'runtime/teaching-cycle/teaching-native-worker.mjs'-cnotin$paths){throw 'bad flatten'};foreach($bad in @('REVOKER_FILES=[["a","b","c"]]','REVOKER_FILES=["a","a","b"]','REVOKER_FILES=["a",3,"c"]')){$denied=$false;try{$null=ReadRevokeClosure $bad}catch{$denied=$true};if(-not$denied){throw 'bad accepted'}};'PS51_EXACT_ARRAY_PASS'`;
  const result=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PS51_EXACT_ARRAY_PASS/);
});

test('Windows anonymous-stdin cold worker uses owned Job and never reads provider credentials; duplicate Run starts nothing',{skip:!windows},async()=>{
  const f=teachingNativeFixture(),shell=configureWindows(f),restore=installSyntheticTokenizer();
  try{initializeTeachingCustody(f.config);f.config.sourceRoot=sourceSnapshot(f,'cold source 教学');save(f);const {executeTeachingWorker}=await import(pathToFileURL(path.join(f.config.sourceRoot,'runtime/teaching-cycle/teaching-host-bindings.mjs')).href);const native=syntheticTeachingFetch(),run=await executeTeachingWorker(f.config,f.key,syntheticCredentials,syntheticOwner(),'run',{fetch:native.fetch});revokeTeachingCycle(f.config);
    const safeReport=path.join(f.base,'synthetic report.json');writeNew(safeReport,run);
    const schemaScript=`$config=Get-Content -LiteralPath ${quote(f.configPath)} -Raw -Encoding UTF8|ConvertFrom-Json; $result=Get-Content -LiteralPath ${quote(safeReport)} -Raw -Encoding UTF8|ConvertFrom-Json; $t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(path.join(f.config.sourceRoot,'runtime/teaching-cycle/Invoke-TeachingCycle.ps1'))},[ref]$t,[ref]$e); foreach($fn in $ast.FindAll({param($n) $n-is[System.Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-in@('AssertFields','AssertReportNumber','AssertReport')},$true)){. ([scriptblock]::Create($fn.Extent.Text))}; $result.report.timing.qualifiedTrainLossTokensPerMinute=0.125; AssertReport $result; $result.report.timing.qualifiedTrainLossTokensPerMinute=[double]::NaN; $denied=$false; try{AssertReport $result}catch{$denied=$true}; if(-not$denied){exit 1}; 'FINITE_FRACTION_PASS'`;
    const schema=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',schemaScript],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(schema.status,0,schema.stderr);assert.match(schema.stdout,/FINITE_FRACTION_PASS/);
    wrapSynthetic(f);
    const cold=invoke(f,'ColdVerify',90000,true);assert.equal(cold.status,0,cold.stderr+JSON.stringify(cold.safe));assert.equal(cold.safe.status,'INDEPENDENT_INSPECTION_ONLY');assert.equal(cold.safe.process.allOwnedProcessesExited,true);assert.match(cold.safe.process.birthId,/^windows-ticks-[0-9]+$/);assert.deepEqual(cold.safe.report,run.report);assert.equal(fs.existsSync(f.config.launcher.credentialsDpapiPath),false);
    writeNew(path.join(f.config.controlRoot,'run-once.intent.json'),{version:'TeachingHostOnce/0.1',cycleId:f.config.cycle.spec.cycleId,configSha256:hash(fs.readFileSync(f.configPath)),automaticRetry:false});const duplicate=invoke(f,'Run');assert.equal(duplicate.status,0,duplicate.stderr);assert.equal(duplicate.safe.status,'REFUSED_ALREADY_CONSUMED');assert.equal(duplicate.safe.newWorkers,0);assert.equal(duplicate.safe.keyReads,0);assert.equal(duplicate.safe.credentialReads,0);assert.equal(duplicate.safe.providerCalls,0);
  }finally{restore();f.key.fill(0);}
});

test('Windows owned timeout is retained as unknown and cannot claim worker exit or retry',{skip:!windows},()=>{
  const f=teachingNativeFixture();configureWindows(f);const snapshot=sourceSnapshot(f,'timeout-source');
  const worker=path.join(snapshot,'runtime/teaching-cycle/teaching-native-worker.mjs');fs.writeFileSync(worker,"// SYNTHETIC owned-timeout target: never reads stdin, keys or config.\nsetInterval(()=>{},1000);\n");f.config.sourcePins.find(p=>p.path.endsWith('teaching-native-worker.mjs')).sha256=hash(fs.readFileSync(worker));f.config.sourceRoot=snapshot;f.config.launcher.timeoutMs=1000;save(f);
  const result=invoke(f,'Preflight',30000);assert.equal(result.status,1,result.stderr);assert.equal(result.safe.status,'REFUSED_OR_UNKNOWN');assert.equal(result.safe.newWorkers,1);assert.equal(result.safe.keyReads,0);assert.equal(result.safe.credentialReads,0);assert.equal(result.safe.automaticRetry,false);assert.equal(result.safe.ownedExit,'NOT_CLAIMED_ON_FAILURE');
});

for(const target of ['production','qa'])test('Windows controller preserves explicit same-config Resume after '+target+' freeze and confirmed owned exit',{skip:!windows},()=>{
  const f=teachingNativeFixture({activeChildren:1});configureWindows(f);initializeTeachingCustody(f.config);wrapSynthetic(f,true);
  const snapshot=sourceSnapshot(f,'controller-crash-'+target),replacement=fs.readFileSync(fileURLToPath(new URL('./fixtures/teaching-launcher-crash-worker.mjs',import.meta.url)),'utf8')
    .replace('__SYNTHETIC_FETCH_FIXTURE_URL__',pathToFileURL(fileURLToPath(new URL('./teaching-native-fixture.mjs',import.meta.url))).href)
    .replace('__SYNTHETIC_TOKENIZER_FIXTURE_URL__',pathToFileURL(fileURLToPath(new URL('./teaching-tokenizer-fixture.ts',import.meta.url))).href)
    .replace('__SYNTHETIC_CRASH_TARGET__',target);
  const worker=path.join(snapshot,'runtime/teaching-cycle/teaching-native-worker.mjs');fs.writeFileSync(worker,replacement);f.config.sourcePins.find(p=>p.path.endsWith('teaching-native-worker.mjs')).sha256=hash(fs.readFileSync(worker));f.config.sourceRoot=snapshot;save(f);
  try{const crashed=invoke(f,'Run');assert.equal(crashed.status,1,crashed.stderr);assert.notEqual(crashed.safe.status,'FINAL_COLD_VERIFIED');assert.equal(crashed.safe.automaticRetry,false);assert.equal(crashed.safe.ownedExit,'CONFIRMED');assert.equal(crashed.safe.revocation,'NOT_REQUESTED_CONFIRMED_EXIT');assert.equal(crashed.safe.executionProcess.exitCode,17);
    const once=fs.readFileSync(path.join(f.config.controlRoot,'run-once.intent.json')),saved=JSON.parse(fs.readFileSync(path.join(f.config.controlRoot,'synthetic-crash.json'))),authority=JSON.parse(fs.readFileSync(f.config.cycle.authorityPath));
    assert.equal(authority.status,'ACTIVE');assert.equal(authority.revision,f.config.cycle.spec.authorityRevision);assert.equal(saved.state.children[0].stage,target==='production'?'TOKENS':'INDEX');
    const duplicate=invoke(f,'Run');assert.equal(duplicate.safe.status,'REFUSED_ALREADY_CONSUMED');assert.equal(duplicate.safe.newWorkers,0);assert.equal(duplicate.safe.keyReads,0);assert.equal(duplicate.safe.credentialReads,0);
    const resumed=invoke(f,'Resume');assert.equal(resumed.status,0,resumed.stderr+JSON.stringify(resumed.safe));assert.equal(resumed.safe.status,'FINAL_COLD_VERIFIED');assert.equal(resumed.safe.runProcess.allOwnedProcessesExited,true);assert.equal(resumed.safe.coldProcess.allOwnedProcessesExited,true);assert.notDeepEqual(resumed.safe.runProcess,resumed.safe.coldProcess);assert.notEqual(resumed.safe.runProcess.birthId,crashed.safe.executionProcess.birthId);
    const done=JSON.parse(fs.readFileSync(path.join(f.config.controlRoot,'synthetic-resume.json')));assert.equal(done.calls,target==='production'?17:15);assert.equal(done.tokenCalls,3);assert.equal(resumed.safe.report.qualified.train.rows,12);assert.equal(resumed.safe.report.qualified.dev.rows,4);assert.deepEqual(fs.readFileSync(path.join(f.config.controlRoot,'run-once.intent.json')),once);
    assert.equal(hash(fs.readFileSync(f.config.children[0].production.authorityPath)),saved.authorities[0].production);if(target==='qa')assert.equal(hash(fs.readFileSync(f.config.children[0].audit.authorityPath)),saved.authorities[0].qa);
  }finally{f.key.fill(0);}
});

for(const critical of [false,true])test('Windows emergency revocation '+(critical?'rejects critical dependency drift honestly':'survives nonessential source drift and withdrawn metadata permission'),{skip:!windows},()=>{
  const f=teachingNativeFixture();configureWindows(f);initializeTeachingCustody(f.config);wrapSynthetic(f,true);const snapshot=sourceSnapshot(f,'emergency source '+critical),worker=path.join(snapshot,'runtime/teaching-cycle/teaching-native-worker.mjs');
  const drift=critical?'src/wf1-json.ts':'src/corpus-production-runner.ts',marker='  const api=await import(',source=fs.readFileSync(worker,'utf8');assert.ok(source.includes(marker));
  const injected=`  if(payload.action==='run'){fs.appendFileSync(path.join(c.sourceRoot,${JSON.stringify(drift)}),'\\n// SYNTHETIC in-flight drift\\n');fs.writeFileSync(c.admission.rootRecord.path,JSON.stringify({...JSON.parse(fs.readFileSync(c.admission.rootRecord.path,'utf8')),expiresAt:0}));await new Promise(()=>setInterval(()=>{},1000));}\n`;
  fs.writeFileSync(worker,source.replace(marker,injected+marker));f.config.sourcePins.find(p=>p.path.endsWith('teaching-native-worker.mjs')).sha256=hash(fs.readFileSync(worker));f.config.sourceRoot=snapshot;f.config.launcher.timeoutMs=1000;save(f);
  const files=f.config.children.flatMap(b=>[b.production.authorityPath,b.audit.authorityPath]),before=files.map(p=>fs.readFileSync(p));
  try{const result=invoke(f,'Run',30000);assert.equal(result.status,1,result.stderr);assert.equal(result.safe.status,'REFUSED_OR_UNKNOWN');assert.equal(result.safe.ownedExit,'NOT_CLAIMED_ON_FAILURE');assert.equal(result.safe.revocation,critical?'NOT_CONFIRMED':'CONFIRMED');assert.equal(result.safe.automaticRetry,false);assert.equal(result.safe.newWorkers,critical?1:2);assert.equal(JSON.parse(fs.readFileSync(f.config.cycle.authorityPath)).status,critical?'ACTIVE':'REVOKED');assert.deepEqual(files.map(p=>fs.readFileSync(p)),before);
    const repeated=invoke(f,'Run');assert.equal(repeated.safe.status,'REFUSED_ALREADY_CONSUMED');assert.equal(repeated.safe.newWorkers,0);assert.equal(repeated.safe.keyReads,0);assert.equal(repeated.safe.credentialReads,0);
  }finally{f.key.fill(0);}
});
