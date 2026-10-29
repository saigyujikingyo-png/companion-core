// Only this bounded anonymous pipe receives the current cycle's owned key.
// Verify the bootstrap's source pins BEFORE importing any project execution code.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const fail=code=>{throw Object.assign(new Error(code),{code});},sha=b=>createHash('sha256').update(b).digest('hex');
const exact=(o,keys)=>{if(!o||Array.isArray(o)||typeof o!=='object'||Object.keys(o).sort().join('\0')!==keys.sort().join('\0'))fail('TCH_BOOTSTRAP');};
function bytes(file,cap){const a=fs.lstatSync(file,{bigint:true});if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1n||a.size<1n||a.size>BigInt(cap)||fs.realpathSync.native(file).toLowerCase()!==path.resolve(file).toLowerCase())fail('TCH_FILE');const b=fs.readFileSync(file),after=fs.lstatSync(file,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>a[k]!==after[k]))fail('TCH_FILE_CHANGED');return b;}
function verifyPins(c,revokeOnly=false){
  const own=fileURLToPath(import.meta.url),root=path.resolve(c.sourceRoot);if(own.toLowerCase()!==path.join(root,'runtime/teaching-cycle/teaching-native-worker.mjs').toLowerCase()||!Array.isArray(c.sourcePins)||c.sourcePins.length<3||c.sourcePins.length>192)fail('TCH_SOURCE_PINS');
  const seen=new Set();for(const p of c.sourcePins){exact(p,['path','sha256']);if(typeof p.path!=='string'||p.path.includes('\\')||p.path.includes(':')||p.path.split('/').some(x=>!x||x==='.'||x==='..')||!/^([a-f0-9]{64})$/.test(p.sha256)||seen.has(p.path))fail('TCH_SOURCE_PINS');seen.add(p.path);}
  const check=name=>{const pin=c.sourcePins.find(p=>p.path===name);if(!pin||sha(bytes(path.join(root,name),4194304))!==pin.sha256)fail('TCH_SOURCE_PIN');};
  const host=['runtime/teaching-cycle/teaching-host-bindings.mjs','runtime/teaching-cycle/teaching-native-worker.mjs','runtime/teaching-cycle/teaching-revoker.mjs','runtime/teaching-cycle/Invoke-TeachingCycle.ps1'];
  if(revokeOnly){
    check('runtime/teaching-cycle/teaching-revoker.mjs');const declaration=bytes(path.join(root,'runtime/teaching-cycle/teaching-revoker.mjs'),4194304).toString('utf8').match(/REVOKER_FILES=(\[[^\r\n]+\])/);if(!declaration)fail('TCH_REVOKER_CLOSURE');
    const required=JSON.parse(declaration[1]);for(const own of host.slice(1))if(!required.includes(own))fail('TCH_REVOKER_CLOSURE');for(const name of required)check(name);
  }else{
    for(const name of seen)check(name);if(!seen.has('src/teaching-cycle-build.ts'))fail('TCH_SOURCE_PINS');
    const declaration=bytes(path.join(root,'src/teaching-cycle-build.ts'),4194304).toString('utf8').match(/TEACHING_CYCLE_BUILD_FILES=(\[[^\n]+\]) as const/);if(!declaration)fail('TCH_SOURCE_CLOSURE');
    const required=[...JSON.parse(declaration[1]),...host];if(required.length!==seen.size||required.some(name=>!seen.has(name)))fail('TCH_SOURCE_CLOSURE');
  }
  if(path.resolve(process.execPath).toLowerCase()!==path.resolve(c.launcher.nodePath).toLowerCase()||sha(bytes(process.execPath,134217728))!==c.launcher.nodeSha256)fail('TCH_NODE_PIN');
}
let payload,key,input;const chunks=[];let size=0;
try{
  if(process.argv.length!==3||process.argv[2]!=='--private-worker')fail('TCH_ENTRY');
  const timeout=setTimeout(()=>{process.stdin.destroy(Object.assign(new Error('TCH_STDIN_TIMEOUT'),{code:'TCH_STDIN_TIMEOUT'}));},10000);timeout.unref();
  try{for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)fail('TCH_STDIN_LIMIT');chunks.push(Buffer.from(chunk));}input=Buffer.concat(chunks);payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input));}finally{clearTimeout(timeout);input?.fill(0);for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
  exact(payload,['version','action','configPath','configSha256','keyBase64','credentials','owner']);
  if(payload.version!=='TeachingPrivateBootstrap/0.1'||!['preflight','initialize','run','resume','verify-report','revoke'].includes(payload.action)||!/^([a-f0-9]{64})$/.test(payload.configSha256))fail('TCH_BOOTSTRAP');
  const configBytes=bytes(payload.configPath,4194304);if(sha(configBytes)!==payload.configSha256)fail('TCH_CONFIG_PIN');const c=JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/,''));verifyPins(c,payload.action==='revoke');
  const api=await import(payload.action==='revoke'?'./teaching-revoker.mjs':'./teaching-host-bindings.mjs');
  if(payload.action!=='revoke'){api.validateTeachingConfig(c);api.verifyTeachingSource(c);}
  const active=['run','resume'].includes(payload.action),needsKey=active||payload.action==='verify-report';
  if(!active&&payload.credentials!==null)fail('TCH_COLD_CREDENTIALS');
  if(needsKey){if(typeof payload.keyBase64!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(payload.keyBase64))fail('TCH_KEY');key=Buffer.from(payload.keyBase64,'base64');payload.keyBase64=null;if(key.length!==32)fail('TCH_KEY');}
  else if(payload.keyBase64!==null)fail('TCH_KEY');
  if(!payload.owner||payload.owner.process?.pid!==process.pid||typeof payload.owner.process.birthId!=='string'||!/^windows-ticks-[0-9]+$/.test(payload.owner.process.birthId)||payload.owner.workers?.length!==0)fail('TCH_OWNER');
  if(active){const once=api.readJson(path.join(c.controlRoot,'run-once.intent.json'),16384);if(once.version!=='TeachingHostOnce/0.1'||once.cycleId!==c.cycle.spec.cycleId||once.configSha256!==payload.configSha256||once.automaticRetry!==false)fail('TCH_ONCE');}
  let result;
  if(payload.action==='preflight'){api.checkRootAdmission(c,false);api.verifyTeachingPython(c);result={version:'TeachingHostPreflight/0.1',status:'SOURCE_AND_BINDINGS_VERIFIED',cycleId:c.cycle.spec.cycleId,providerCalls:0};}
  else if(payload.action==='initialize')result=api.initializeTeachingCustody(c);
  else if(payload.action==='revoke')result=api.revokeTeachingCycle(c);
  else result=await api.executeTeachingWorker(c,key,payload.credentials,payload.owner,payload.action);
  // JSON.stringify intentionally accepts finite fractional throughput. The core
  // report digest uses canonical JSON; the integer-only journal parser is not used.
  const output=JSON.stringify(result);if(Buffer.byteLength(output)>1048576)fail('TCH_STDOUT_LIMIT');process.stdout.write(output+'\n');
}catch(error){const code=typeof error?.code==='string'&&/^(TCH|TC|CPR|CQA|WF1)_[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'TCH_REFUSED_OR_UNKNOWN';process.stdout.write(JSON.stringify({version:'TeachingNativeFailure/0.1',status:'REFUSED_OR_UNKNOWN',code,automaticRetry:false,providerCalls:null,rawErrorPrinted:false})+'\n');process.exitCode=1;}
finally{key?.fill(0);input?.fill(0);for(const chunk of chunks)chunk.fill(0);if(payload){payload.keyBase64=null;payload.credentials=null;}payload=null;}
