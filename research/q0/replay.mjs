// Public regression replay controller. No encoder/evaluator code runs in prepare mode.
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,lstatSync,realpathSync,existsSync,
  openSync,closeSync,readSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir,freemem,totalmem} from 'node:os';
import {spawn} from 'node:child_process';

const EXPECTED=Object.freeze({
  encoder:'e9da23114a7c23cc2e1e380625d3aac61be82ee3f5cdddd8003d970be0ea5e74',
  commitment:'5d29c0a69a52dd95dfe26f81f6ef96debb11308c08ed6262defeabdef89c8d65',
  runnerFreeze:'0d214416d50797644dcd82070b4a896facf94e33cf6313306d27d728b767e25b',
  runner:'5b7d53b4b434db8e84edd72fd7547f5d27d64ac9ead1c9c25b4a235f6122ed91'});
const COMPUTE_MS=180_000,CLEANUP_MS=5_000,MIN_FREE=2048*1024*1024;
const fail=code=>{throw new Error(code);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const put=(path,value)=>writeFileSync(path,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const json=path=>JSON.parse(readFileSync(path,'utf8'));
function safeRelative(path){
  if(typeof path!=='string'||!path||isAbsolute(path)||path.includes('\\')||path.includes(':')||path.split('/').some(p=>!p||p==='.'||p==='..'))fail('INVALID_PACKAGE_PATH');
  return path;
}
function input(root,path){
  safeRelative(path);let current=root;
  for(const part of path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())fail('PACKAGE_LINK_REFUSED');}
  const real=realpathSync(current),rel=relative(root,real);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!lstatSync(real).isFile())fail('PACKAGE_PATH_ESCAPE');
  return real;
}
function checkedBytes(path,hash,bytes){
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024||(bytes!==undefined&&stat.size!==bytes))fail('SOURCE_SIZE_MISMATCH');
  const data=readFileSync(path);if(sha(data)!==hash)fail('SOURCE_HASH_MISMATCH');return data;
}
function restore(root,canonical,data){
  safeRelative(canonical);const target=join(root,canonical);mkdirSync(dirname(target),{recursive:true});put(target,data);
  if(sha(readFileSync(target))!==sha(data))fail('RESTORED_HASH_MISMATCH');
}
function runtime(){
  const fd=openSync(process.execPath,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0;
  try{for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;hash.update(buffer.subarray(0,n));count+=n;}}finally{closeSync(fd);}
  return {node:process.version,zstd:process.versions.zstd,platform:process.platform,arch:process.arch,executableBytes:count,executableSha256:hash.digest('hex')};
}
function options(args){
  const out={run:false,compat:false,packageRoot:dirname(fileURLToPath(import.meta.url))};let mode=null;
  for(let n=0;n<args.length;n++){
    const arg=args[n];if(arg==='--prepare'||arg==='--run'){if(mode)fail('ONE_MODE_REQUIRED');mode=arg;out.run=arg==='--run';}
    else if(arg==='--runtime-compatibility'){if(out.compat)fail('DUPLICATE_OPTION');out.compat=true;}
    else if(arg==='--package-root'){if(out.explicitRoot||!args[n+1]||args[n+1].startsWith('--'))fail('PACKAGE_ROOT_REQUIRED');out.packageRoot=resolve(args[++n]);out.explicitRoot=true;}
    else fail('UNKNOWN_OPTION');
  }return out;
}
async function execute(root,runner,config){
  // An exclusive wrapper claim is narrower than a system-wide process census.
  const lock=join(tmpdir(),'companion-q0-public-replay.compute.lock'),nonce=randomUUID();
  const lockFd=openSync(lock,'wx');closeSync(lockFd);writeFileSync(lock,JSON.stringify({nonce,controllerPid:process.pid,workspace:root})+'\n');
  let child=null,closed=false,stdoutFd=null,stderrFd=null;
  try{
    const available=freemem(),gate={runKind:'PUBLIC_REPLAY',freeRAMBytes:available,totalRAMBytes:totalmem(),minimumFreeRAMBytes:MIN_FREE,
      heapMiB:256,computeTimeoutMs:COMPUTE_MS,cleanupTimeoutMs:CLEANUP_MS,computeChildren:1,
      exclusivity:'this wrapper lock only; not a system-wide other-process assertion',utc:new Date().toISOString()};
    put(join(root,'CONTROLLER-ADMISSION.json'),gate);if(available<MIN_FREE)fail('INSUFFICIENT_FREE_RAM');
    if(existsSync(config.outputDirectory))fail('OUTPUT_ALREADY_EXISTS');
    stdoutFd=openSync(join(root,'replay.stdout.log'),'wx');stderrFd=openSync(join(root,'replay.stderr.log'),'wx');
    const result=await new Promise(resolveResult=>{
      let settled=false,timedOut=false,cleanup=null;
      const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);if(cleanup)clearTimeout(cleanup);resolveResult(value);};
      child=spawn(process.execPath,['--max-old-space-size=256',runner,join(root,'PUBLIC-REPLAY-CONFIG.json')],
        {cwd:root,stdio:['ignore',stdoutFd,stderrFd],windowsHide:true});
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');cleanup=setTimeout(()=>{
        child.kill('SIGKILL');child.unref();finish({exitCode:null,signal:null,timedOut:true,cleanupConfirmed:false});
      },CLEANUP_MS);},COMPUTE_MS);
      child.once('error',()=>finish({exitCode:null,signal:null,timedOut,cleanupConfirmed:false,error:'CHILD_START_ERROR'}));
      child.once('close',(code,signal)=>{closed=true;finish({exitCode:code,signal,timedOut,cleanupConfirmed:true});});
    });
    put(join(root,'CONTROLLER-COMPLETION.json'),{runKind:'PUBLIC_REPLAY',...result,automaticRetryAllowed:false});
    if(result.timedOut||result.exitCode!==0||!result.cleanupConfirmed)fail('PUBLIC_REPLAY_FAILED_OR_TIMEOUT');
    const report=json(join(config.outputDirectory,'RESULTS.json'));
    if(report.runKind!=='PUBLIC_REPLAY'||report.status!=='PUBLIC_REPLAY_COMPLETED')fail('PUBLIC_REPLAY_RESULT_KIND');
    return result;
  }finally{
    if(stdoutFd!==null)closeSync(stdoutFd);if(stderrFd!==null)closeSync(stderrFd);
    // Leave the claim on uncertain child cleanup; no stale-lock automatic retry.
    if((!child||closed)&&json(lock).nonce===nonce)unlinkSync(lock);
  }
}
let workspace=null;
try{
  const opts=options(process.argv.slice(2)),packageRoot=realpathSync(opts.packageRoot);
  const encoderBytes=checkedBytes(input(packageRoot,'ENCODER-FREEZE.json'),EXPECTED.encoder);
  const commitmentBytes=checkedBytes(input(packageRoot,'independent/COMMITMENT.json'),EXPECTED.commitment);
  const runnerFreezeBytes=checkedBytes(input(packageRoot,'independent/RUNNER-FREEZE.json'),EXPECTED.runnerFreeze);
  const encoder=JSON.parse(encoderBytes),commitment=JSON.parse(commitmentBytes),runnerFreeze=JSON.parse(runnerFreezeBytes);
  if(encoder.files.length!==9||commitment.files.length!==5||new Set(encoder.files.map(f=>f.path)).size!==9||new Set(commitment.files.map(f=>f.name)).size!==5)fail('FROZEN_FILE_SET');
  if(encoder.reviewerCommitment.commitmentSha256!==EXPECTED.commitment||Date.parse(commitment.committedAt)>=Date.parse(encoder.utc))fail('COMMITMENT_ORDER');
  workspace=mkdtempSync(join(tmpdir(),'companion-q0-public-replay-'));
  const sourceRoot=join(workspace,'source'),capsuleRoot=join(workspace,'capsule'),runnerRoot=join(workspace,'runner');
  for(const path of [sourceRoot,capsuleRoot,runnerRoot])mkdirSync(path);
  put(join(sourceRoot,'ENCODER-FREEZE.original.json'),encoderBytes);put(join(capsuleRoot,'COMMITMENT.json'),commitmentBytes);
  put(join(runnerRoot,'RUNNER-FREEZE.original.json'),runnerFreezeBytes);
  const checked=[];
  for(const f of encoder.files){const mapped=f.path==='PLAN.md'?'protocol-plan.txt':f.path;
    const bytes=checkedBytes(input(packageRoot,mapped),f.sha256,f.bytes);restore(sourceRoot,f.path,bytes);checked.push({domain:'encoder',canonical:f.path,package:mapped,bytes:f.bytes,sha256:f.sha256});}
  for(const f of commitment.files){const mapped='independent/'+(f.name==='private-seeds.json'?'seed-reveal.json':f.name);
    const bytes=checkedBytes(input(packageRoot,mapped),f.sha256,f.bytes);restore(capsuleRoot,f.name,bytes);checked.push({domain:'capsule',canonical:f.name,package:mapped,bytes:f.bytes,sha256:f.sha256});}
  for(const f of commitment.publicFiles)checkedBytes(join(sourceRoot,f.name),f.sha256,f.bytes);
  const runnerEntry=runnerFreeze.files.find(f=>f.name==='formal-runner.mjs');
  if(!runnerEntry||runnerEntry.sha256!==EXPECTED.runner)fail('RUNNER_FREEZE_ENTRY');
  const runner=join(runnerRoot,'formal-runner.mjs');put(runner,checkedBytes(input(packageRoot,'independent/formal-runner.mjs'),EXPECTED.runner,runnerEntry.bytes));
  let activeBytes=encoderBytes;const compatibility={requested:opts.compat,originalRuntime:encoder.runtime,changedFields:[],runKind:'PUBLIC_REPLAY'};
  if(opts.compat){
    const current=runtime();if(!/^v24\./.test(current.node)||Number(current.node.split('.')[1])<16||!current.zstd)fail('COMPATIBLE_RUNTIME_UNSUPPORTED');
    const derived=structuredClone(encoder);derived.runtime=current;
    compatibility.currentRuntime=current;compatibility.changedFields=Object.keys(current).filter(key=>current[key]!==encoder.runtime[key]).map(key=>({field:'runtime.'+key,original:encoder.runtime[key],derived:current[key]}));
    activeBytes=Buffer.from(JSON.stringify(derived,null,2)+'\n');
  }
  put(join(sourceRoot,'ENCODER-FREEZE.json'),activeBytes);
  compatibility.originalEncoderFreezeSha256=EXPECTED.encoder;compatibility.activeEncoderFreezeSha256=sha(activeBytes);
  put(join(workspace,'RUNTIME-COMPATIBILITY.json'),compatibility);
  const config={runKind:'PUBLIC_REPLAY',sourceRoot,capsuleRoot,outputDirectory:join(workspace,'results'),encoderFreezeSha256:sha(activeBytes),evaluatorCommitmentSha256:EXPECTED.commitment};
  put(join(workspace,'PUBLIC-REPLAY-CONFIG.json'),config);
  const preparation={status:'PUBLIC_REPLAY_PREPARED',runKind:'PUBLIC_REPLAY',workspace,computeStarted:false,encoderFiles:9,capsuleFiles:5,checked,
    runnerSha256:EXPECTED.runner,runplanCoverage:'only formal-runner entry verified; original config/launcher/syntax log not restored',
    runtimeCompatibility:opts.compat,runtimeExecutionValidation:'NOT_RUN_PREPARE_ONLY',originalFreezeSha256:EXPECTED.encoder,activeFreezeSha256:sha(activeBytes),
    originalCommitmentSha256:EXPECTED.commitment,originalRunnerFreezeSha256:EXPECTED.runnerFreeze,automaticRetryAllowed:false};
  put(join(workspace,'PREPARED.json'),preparation);
  if(opts.run){
    const current=runtime(),expected=JSON.parse(activeBytes).runtime;
    for(const key of ['node','zstd','executableSha256'])if(current[key]!==expected[key])fail('FROZEN_RUNTIME_MISMATCH_USE_EXPLICIT_COMPATIBILITY');
    await execute(workspace,runner,config);console.log(JSON.stringify({status:'PUBLIC_REPLAY_COMPLETED',runKind:'PUBLIC_REPLAY',workspace}));
  }else console.log(JSON.stringify(preparation));
}catch(error){
  if(workspace&&!existsSync(join(workspace,'WRAPPER-FAILURE.json')))put(join(workspace,'WRAPPER-FAILURE.json'),{status:'PUBLIC_REPLAY_WRAPPER_FAILED',workspace,code:error.message,automaticRetryAllowed:false});
  console.error(JSON.stringify({status:'PUBLIC_REPLAY_WRAPPER_FAILED',workspace,code:error.message,automaticRetryAllowed:false}));process.exitCode=1;
}
