// Real native DSH + isolated synthetic worker. Used only after installing the pinned runtime wheel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { canonical,hash,parseJson,shape } from '../src/wf1-json.ts';
import { parseDshTeacherOperation,validateTeacherMetadata,validateTeacherReply } from '../src/wf2-teacher-service.ts';

if(process.argv.length!==2)throw Error('WF2_SMOKE_ARGUMENTS');
const here=path.dirname(fileURLToPath(import.meta.url));
const located=spawnSync('python',['-c','import json; from importlib.metadata import version; from deepseek_harness_runtime import bundled_runtime_path; print(json.dumps({"path":str(bundled_runtime_path()),"version":version("deepseek-harness-runtime-bin")}))'],{encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true});
if(located.status!==0)throw Error('WF2_RUNTIME_UNAVAILABLE');const installation=JSON.parse(located.stdout),executable=installation.path;if(installation.version!=='0.2.1rc2'||!path.isAbsolute(executable)||!fs.statSync(executable).isFile())throw Error('WF2_RUNTIME_PATH');
const slot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'wf2-native-dsh-'))),home=path.join(slot,'home'),profile=path.join(home,'profiles','wf2-runtime');fs.mkdirSync(profile,{recursive:true});
const plugin=path.resolve(here,'../integrations/dsh-teacher-control/index.mjs');
function fresh(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
fresh(path.join(profile,'package.json'),{name:'dsh-profile-wf2-runtime',private:true,dependencies:{},dsh:{profile:{bundles:[]}}});
fresh(path.join(profile,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'wf2-teacher-control',name:pathToFileURL(plugin).href}]}]));
fresh(path.join(slot,'launch.once'),'{"synthetic":true,"automaticRetry":false}');
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'])if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',DSH_PRIMARY_RUNTIME:'',DSH_OFFICE_SIDECAR:'',USERPROFILE:slot,HOME:slot,PATH:process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32'):'/usr/bin:/bin'});
const version=spawnSync(executable,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:4096,env,cwd:slot,windowsHide:true});if(version.status!==0||!version.stdout.includes('0.2.1'))throw Error('WF2_RUNTIME_VERSION');
const capability=crypto.randomBytes(32).toString('hex');
let worker,dsh,failed=false,killed=false,workerClosed=false,dshClosed=false,workerExit=null,dshExit=null,dispatches=0,settled=false,completionAcknowledged=false;
const children=[];
function stop(){if(failed)return;failed=true;for(const child of children){child.stdin.end();if(child.exitCode===null){killed=true;child.kill();}}}
function lineReader(stream,callback){let buffer=Buffer.alloc(0),total=0,count=0;stream.on('data',chunk=>{try{total+=chunk.length;if(total>16384)throw Error('WF2_SMOKE_OUTPUT');buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8192)throw Error('WF2_SMOKE_LINE');for(let i;(i=buffer.indexOf(10))>=0;){if(++count>16)throw Error('WF2_SMOKE_LINES');const line=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,i));buffer=buffer.subarray(i+1);callback(parseJson(line));}}catch{stop();}});stream.on('end',()=>{if(buffer.length)stop();});stream.on('error',stop);}
function stderrBound(stream){let bytes=0;stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384)stop();});stream.on('error',stop);}
function send(child,value){if(child.stdin.destroyed){stop();return;}child.stdin.write(JSON.stringify(value)+'\n',error=>{if(error)stop();});}
worker=spawn(process.execPath,[path.join(here,'wf2-synthetic-teacher-worker.ts')],{cwd:slot,env,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(worker);stderrBound(worker.stderr);worker.stdin.on('error',stop);
const workerDone=new Promise(resolve=>{worker.on('error',()=>{failed=true;});worker.on('close',code=>{workerClosed=true;workerExit=code;if(!settled&&dsh)dsh.stdin.end();resolve();});});
let dshDone=Promise.resolve();
lineReader(worker.stdout,event=>{
  if(event.type==='ready'){
    shape(event,['version','type']);if(event.version!=='wf2-worker-event/1'||dsh)throw Error('WF2_SMOKE_READY');
    dsh=spawn(executable,['--profile','wf2-runtime','--teacher-control'],{cwd:slot,env,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(dsh);stderrBound(dsh.stderr);dsh.stdin.on('error',stop);
    dshDone=new Promise(resolve=>{dsh.on('error',()=>{failed=true;});dsh.on('close',code=>{dshClosed=true;dshExit=code;worker.stdin.end();resolve();});});
    lineReader(dsh.stdout,value=>{const operation=parseDshTeacherOperation(value);if(++dispatches>2||operation.operation!==(dispatches===1?'status':'start'))throw Error('WF2_SMOKE_DISPATCH');send(worker,{...operation,capability});});
    send(dsh,{version:1,kind:'grant'});
  }else if(event.type==='reply'){
    shape(event,['version','type','reply']);if(event.version!=='wf2-worker-event/1'||!dsh)throw Error('WF2_SMOKE_REPLY');const reply=validateTeacherReply(event.reply);
    if(reply.metadata.calls.deepseek!==0||reply.metadata.calls.together!==0||reply.duplicate)throw Error('WF2_SMOKE_MODEL_CALL');
    send(dsh,{version:1,kind:'reply',requestId:reply.requestId,operation:reply.operation,state:reply.state});
  }else if(event.type==='settled'){
    shape(event,['version','type','state','completion']);if(event.version!=='wf2-worker-event/1'||event.state!=='COMPLETED'||!dsh||settled)throw Error('WF2_SMOKE_SETTLED');
    const completion=shape(event.completion,['digest','metadata']),metadata=validateTeacherMetadata(completion.metadata);if(metadata.campaignStatus!=='COMPLETED'||completion.digest!==hash(canonical(metadata)))throw Error('WF2_SMOKE_COMPLETION');
    fresh(path.join(slot,'completion-observed.json'),{version:1,state:'COMPLETED',synthetic:true,metadata});settled=true;send(worker,{version:'wf2-worker-control/1',action:'acknowledge-completed',completionDigest:completion.digest});
  }else{
    shape(event,['version','type']);if(event.version!=='wf2-worker-event/1'||event.type!=='completion-acknowledged'||!settled||!dsh||completionAcknowledged)throw Error('WF2_SMOKE_ACK');
    completionAcknowledged=true;send(dsh,{version:1,kind:'settled',state:'COMPLETED'});dsh.stdin.end();worker.stdin.end();
  }
});
send(worker,{version:'wf2-synthetic-bind/1',capability});const timer=setTimeout(stop,20000);
let hardTimer;
const hardDeadline=new Promise(resolve=>{hardTimer=setTimeout(()=>{
  stop();for(const child of children)if(child.exitCode===null){
    if(process.platform==='win32')spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'});
    else child.kill('SIGKILL');
  }
  resolve();
},25000);});
await Promise.race([(async()=>{await workerDone;await dshDone;})(),hardDeadline]);clearTimeout(timer);clearTimeout(hardTimer);
const receipt={version:'wf2-native-dsh-smoke/1',status:!failed&&!killed&&workerClosed&&dshClosed&&workerExit===0&&dshExit===0&&dispatches===2&&settled&&completionAcknowledged?'PASS':'FAIL',runtimePackage:'deepseek-harness-runtime-bin',runtimeVersion:'0.2.1rc2',reportedVersion:version.stdout.trim(),platform:process.platform,arch:process.arch,pluginSha256:crypto.createHash('sha256').update(fs.readFileSync(plugin)).digest('hex'),dispatches,completionAcknowledged,workerClosed,dshClosed,workerExit,dshExit,forced:killed,modelCalls:0,providerApiCalls:0,networkVerification:'NOT_OS_ENFORCED',automaticRetry:false};
fresh(path.join(slot,'receipt.json'),receipt);process.stdout.write(JSON.stringify(receipt)+'\n');process.exitCode=receipt.status==='PASS'?0:1;
if(!workerClosed||!dshClosed){for(const child of children){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();}}
