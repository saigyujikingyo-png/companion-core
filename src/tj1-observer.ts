import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { freemem } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedJson, bitsF64, canonical, CanaryError, canaryDatasets, canaryFail, CANARY_CONFIG, CANARY_LIMITS,
  closed, f64Bits, HEX64, independentEvaluation, initialCheckpoint, near, sha256, tensorValues, verifyFirstStep } from './tj1-spec.ts';
import { boundedFile, CanaryGate, CanaryLedger, privateDirectory, scopeDigest, validateCanaryRecord } from './tj1-ledger.ts';
import type { CanaryAuthority, CanaryLedgerMeta, CanaryProjection } from './tj1-ledger.ts';

const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD_FILES=['src/tj1-spec.ts','src/tj1-ledger.ts','src/tj1-observer.ts','src/tj1-canary-cli.ts','scripts/tj1-trainer.py','scripts/tj1-evaluator.py',
  'src/scene-json.ts','src/validation.ts'] as const;
type Manifest={format:'tj1-canary-manifest-v1';runId:string;attemptId:string;scopeDigest:string;config:typeof CANARY_CONFIG;configDigest:string;
  python:{path:string;sha256:string};build:Record<string,string>;files:{train:FileIdentity;eval:FileIdentity;initial:FileIdentity}};
type FileIdentity={name:string;bytes:number;sha256:string};
type Options={directory:string;authority:()=>CanaryAuthority};
function fileIdentity(path:string,name:string,max:number=CANARY_LIMITS.artifactBytes):FileIdentity {
  boundedFile(path,max);const bytes=readFileSync(path);return {name,bytes:bytes.length,sha256:sha256(bytes)};
}
function writeNew(path:string,bytes:string|Buffer):void {
  const b=typeof bytes==='string'?Buffer.from(bytes):bytes,fd=openSync(path,'wx',0o600);let p=0;
  try{while(p<b.length){const n=writeSync(fd,b,p,b.length-p);if(n<=0)canaryFail('TJ1_IO');p+=n;}fsyncSync(fd);}finally{closeSync(fd);}
}
function buildHashes():Record<string,string> {return Object.fromEntries(BUILD_FILES.map(name=>[name,fileIdentity(join(ROOT,name),name,65_536).sha256]));}
function validPython(path:string):string {
  if(process.platform!=='win32'||typeof path!=='string'||!isAbsolute(path)||/^[\\/]{2}/.test(path)||realpathSync(path).toLowerCase()!==path.toLowerCase())canaryFail('TJ1_PLATFORM_NOT_QUALIFIED');
  return fileIdentity(path,'python.exe',16_777_216).sha256;
}
function checkFrozen(directory:string,expected:string):Manifest {
  if(typeof expected!=='string'||!HEX64.test(expected))canaryFail('TJ1_INVALID');
  const path=join(directory,'manifest.json');boundedFile(path,8_192);const bytes=readFileSync(path);
  if(sha256(bytes)!==expected)canaryFail('TJ1_MANIFEST_MISMATCH');const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const m=closed(boundedJson(raw),['format','runId','attemptId','scopeDigest','config','configDigest','python','build','files']) as unknown as Manifest;
  if(canonical(m)!==raw||m.format!=='tj1-canary-manifest-v1'||canonical(m.config)!==canonical(CANARY_CONFIG)||
    m.configDigest!==sha256(canonical(CANARY_CONFIG))||canonical(m.build)!==canonical(buildHashes())||m.python.sha256!==validPython(m.python.path))canaryFail('TJ1_MANIFEST_MISMATCH');
  const data=canaryDatasets(),expectedFiles={train:{name:'train.jsonl',data:data.train},eval:{name:'eval.jsonl',data:data.eval},initial:{name:'initial.json',data:canonical(initialCheckpoint())}};
  closed(m.files,['train','eval','initial']);closed(m.python,['path','sha256']);
  for(const key of ['train','eval','initial'] as const) {
    const spec=expectedFiles[key],file=m.files[key];closed(file,['name','bytes','sha256']);
    if(file.name!==spec.name||file.bytes!==Buffer.byteLength(spec.data)||file.sha256!==sha256(spec.data)||
      canonical(fileIdentity(join(directory,spec.name),spec.name))!==canonical(file))canaryFail('TJ1_MANIFEST_MISMATCH');
  }
  return m;
}

/** Explicit runtime preparation; offline tests do not call this real-attempt entrypoint. No torch import here. */
export function prepareCanary(options:Options&{pythonPath:string}) {
  const gate=new CanaryGate(options.authority);
  try {
    const a=gate.check('write'),directory=privateDirectory(options.directory);if(readdirSync(directory).length!==0)canaryFail('TJ1_DIRECTORY_NOT_EMPTY');
    const python={path:options.pythonPath,sha256:validPython(options.pythonPath)},build=buildHashes(),data=canaryDatasets(),runId=randomUUID(),attemptId=randomUUID();
    writeNew(join(directory,'preparation-intent.json'),canonical({format:'tj1-preparation-intent-v1',runId,attemptId,scopeDigest:scopeDigest(a),zeroOptimizerSteps:true}));
    for(const [name,bytes] of [['train.jsonl',data.train],['eval.jsonl',data.eval],['initial.json',canonical(initialCheckpoint())]]) {
      gate.check('write');writeNew(join(directory,name!),bytes!);
    }
    const manifest:Manifest={format:'tj1-canary-manifest-v1',runId,attemptId,scopeDigest:scopeDigest(a),config:CANARY_CONFIG,
      configDigest:sha256(canonical(CANARY_CONFIG)),python,build,files:{train:fileIdentity(join(directory,'train.jsonl'),'train.jsonl'),
        eval:fileIdentity(join(directory,'eval.jsonl'),'eval.jsonl'),initial:fileIdentity(join(directory,'initial.json'),'initial.json')}};
    const bytes=canonical(manifest),manifestDigest=sha256(bytes);gate.check('write');writeNew(join(directory,'manifest.json'),bytes);mkdirSync(join(directory,'artifacts'),{mode:0o700});
    const meta:CanaryLedgerMeta={logical:'tj1-local-canary-v1',container:'sqlite-event-ledger-v1',codec:'identity-json-v1',lane:'ACTUAL_LOCAL',runId,attemptId,scopeDigest:manifest.scopeDigest,manifestDigest};
    const ledger=CanaryLedger.create(directory,gate,meta);
    try{ledger.append('PREPARED',{manifestDigest},'HOST_CONTROL');gate.check('write');return {state:'PREPARED_ZERO_STEPS',runId,attemptId,manifestDigest};}
    finally{ledger.close();}
  }catch(e){gate.fence();if(e instanceof CanaryError)throw e;return canaryFail('TJ1_PREPARATION_UNKNOWN');}
}

type WorkerFrame={protocol:'TJ1_WORKER_V1';stage:'trainer'|'evaluator';launchId:string;manifestDigest:string;sequence:string;kind:string;data:Record<string,unknown>};
/** Parsing a frame does not authenticate it or create any actual-observation capability. */
export function parseCanaryWorkerFrame(raw:string):{assurance:'UNTRUSTED_PROCESS_FRAME';frame:WorkerFrame} {
  const f=closed(boundedJson(raw),['protocol','stage','launchId','manifestDigest','sequence','kind','data']);
  if(f.protocol!=='TJ1_WORKER_V1'||!['trainer','evaluator'].includes(f.stage as string)||typeof f.launchId!=='string'||
    !/^[a-z0-9-]{1,64}$/.test(f.launchId)||typeof f.manifestDigest!=='string'||!HEX64.test(f.manifestDigest)||
    typeof f.sequence!=='string'||!/^[1-9][0-9]{0,2}$/.test(f.sequence))canaryFail('TJ1_PROTOCOL');
  const data=f.data as Record<string,unknown>;
  if(f.kind==='READY'||(f.kind==='STEP'&&f.stage==='trainer')) {
    validateCanaryRecord(canonical({logical:'tj1-local-canary-v1',container:'sqlite-event-ledger-v1',codec:'identity-json-v1',lane:'OFFLINE_FIXTURE',
      sequence:'1',eventId:'validate-only',kind:f.kind==='READY'?'TRAINER_READY':'STEP',source:'PINNED_TRAINER_OBSERVED',receiptDigest:null,data}));
    if(f.kind==='STEP')bitsF64(data.lossBits as string);
    else if(!Number.isSafeInteger(Number(data.availableBytes))||Number(data.availableBytes)<0)canaryFail('TJ1_PROTOCOL');
  } else if(f.kind==='EXPORTED'&&f.stage==='trainer') {
    closed(data,['checkpoint','weights','rssBytes']);if(data.checkpoint!=='checkpoint.pt'||data.weights!=='weights.json')canaryFail('TJ1_PROTOCOL');
  } else if(f.kind==='RESULT'&&f.stage==='evaluator') {
    closed(data,['weightsDigest','checkpointDigest','initialDigest','tensors','predictions','mseBits','baselineBits','deltaBits','changed','rssBytes','checkpointVerified']);
    for(const name of ['weightsDigest','checkpointDigest','initialDigest'])if(typeof data[name]!=='string'||!HEX64.test(data[name] as string))canaryFail('TJ1_PROTOCOL');
    tensorValues(data.tensors);for(const name of ['mseBits','baselineBits','deltaBits'])bitsF64(data[name] as string);
    if(!Array.isArray(data.predictions)||data.predictions.length!==256||data.checkpointVerified!==true)canaryFail('TJ1_PROTOCOL');
    data.predictions.forEach(v=>bitsF64(v as string));
    if(typeof data.changed!=='string'||!/^(0|[1-9][0-9]?)$/.test(data.changed)||Number(data.changed)>14)canaryFail('TJ1_PROTOCOL');
  } else canaryFail('TJ1_PROTOCOL');
  if(typeof data.rssBytes!=='string'||!/^[1-9][0-9]{0,15}$/.test(data.rssBytes)||Number(data.rssBytes)>CANARY_LIMITS.observedRssLimit)canaryFail('TJ1_RESOURCE_REFUSED');
  return {assurance:'UNTRUSTED_PROCESS_FRAME',frame:f as WorkerFrame};
}
type ChildResult={pid:number|null;launchId:string;spawnedAtUnixMs:number;exitCode:number|null;signal:string|null;closeObserved:boolean;
  failure:string|null;stdoutBytes:number;stderrBytes:number;stderrRetainedBytes:number;stderrTruncated:boolean;
  stdoutDigest:string;stderrDigest:string;outcomePersisted:boolean;peakReportedRss:number|null;elapsedMs:number};
async function supervisedChild(stage:'trainer'|'evaluator',manifest:Manifest,directory:string,request:Record<string,unknown>,gate:CanaryGate,
  onFrame:(frame:WorkerFrame,receiptDigest:string,send:(command:string,step:number)=>void)=>void):Promise<ChildResult> {
  const requestPath=join(directory,stage+'-request.json'),rawPath=join(directory,stage+'-receipts.jsonl'),stderrPath=join(directory,stage+'-stderr.bin');
  gate.check('train');writeNew(requestPath,canonical(request));const fd=openSync(rawPath,'wx',0o600),started=performance.now(),spawnedAtUnixMs=Date.now();
  let errorFd:number;try{errorFd=openSync(stderrPath,'wx',0o600);}catch(e){closeSync(fd);throw e;}
  let output=Buffer.alloc(0),stdoutBytes=0,stderrBytes=0,stderrRetainedBytes=0,peakReportedRss:number|null=null,sequence=0,ready=false,failure:string|null=null,settled=false,killed=false;
  let startup:ReturnType<typeof setTimeout>|undefined,work:ReturnType<typeof setTimeout>|undefined,cleanup:ReturnType<typeof setTimeout>|undefined,watch:ReturnType<typeof setInterval>|undefined;
  const child=(()=>{try{gate.check('train');return spawn(manifest.python.path,['-I','-B','-u',join(ROOT,stage==='trainer'?'scripts/tj1-trainer.py':'scripts/tj1-evaluator.py'),requestPath],{
    windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',WINDIR:process.env.WINDIR??'C:\\Windows',
      PATH:dirname(manifest.python.path)+';'+(process.env.SystemRoot??'C:\\Windows')+'\\System32',TEMP:process.env.TEMP??directory,TMP:process.env.TMP??directory,
      CUDA_VISIBLE_DEVICES:'',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
    }catch(e){closeSync(fd);closeSync(errorFd);
      try{gate.check('write');writeNew(join(directory,stage+'-process.json'),canonical({format:'tj1-process-outcome-v1',stage,launchId:request.launchId,
        manifestDigest:request.manifestDigest,pythonDigest:manifest.python.sha256,scriptDigest:request.scriptDigest,pid:null,spawnedAtUnixMs,
        exitCode:null,signal:null,closeObserved:false,failure:'TJ1_SPAWN_FAILED',stdoutBytes:0,stderrBytes:0,stderrRetainedBytes:0,stderrTruncated:false,
        stdoutDigest:sha256(''),stderrDigest:sha256(''),peakReportedRss:null,elapsedMs:performance.now()-started}));}catch{}
      if(e instanceof CanaryError)throw e;return canaryFail('TJ1_SPAWN_FAILED');}})();
  return await new Promise<ChildResult>(resolve=>{
    const finish=(code:number|null,signal:string|null,closeObserved:boolean)=>{
      if(settled)return;settled=true;clearTimeout(startup);clearTimeout(work);clearTimeout(cleanup);clearInterval(watch);
      if(!closeObserved){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();}
      try{fsyncSync(fd);}catch{failure??='TJ1_RECEIPT_IO';}try{closeSync(fd);}catch{failure??='TJ1_RECEIPT_IO';}
      try{fsyncSync(errorFd);}catch{failure??='TJ1_RECEIPT_IO';}try{closeSync(errorFd);}catch{failure??='TJ1_RECEIPT_IO';}
      const result:ChildResult={pid:child.pid??null,launchId:request.launchId as string,spawnedAtUnixMs,exitCode:code,signal,closeObserved,failure,stdoutBytes,stderrBytes,
        stderrRetainedBytes,stderrTruncated:stderrRetainedBytes<stderrBytes,stdoutDigest:'',stderrDigest:'',outcomePersisted:false,peakReportedRss,elapsedMs:performance.now()-started};
      try {gate.check('write');result.stdoutDigest=fileIdentity(rawPath,stage+'-receipts.jsonl',CANARY_LIMITS.stdoutBytes).sha256;
        result.stderrDigest=fileIdentity(stderrPath,stage+'-stderr.bin',CANARY_LIMITS.stderrBytes).sha256;
        const {outcomePersisted:_,...stored}=result;
        writeNew(join(directory,stage+'-process.json'),canonical({format:'tj1-process-outcome-v1',stage,manifestDigest:request.manifestDigest,
          pythonDigest:manifest.python.sha256,scriptDigest:request.scriptDigest,...stored}));result.outcomePersisted=true;
      }catch{result.failure??='TJ1_PROCESS_EVIDENCE_UNAVAILABLE';}
      resolve(result);
    };
    const stop=(code:string)=>{
      failure??=code;if(!killed){killed=true;child.kill('SIGKILL');cleanup=setTimeout(()=>finish(null,null,false),CANARY_LIMITS.cleanupMs);}
    };
    const send=(command:string,step:number)=>{
      gate.check('train');if(failure||settled)canaryFail('TJ1_CHILD_STOPPED');
      child.stdin.write(canonical({command,step:String(step),launchId:request.launchId,manifestDigest:request.manifestDigest})+'\n');
    };
    startup=setTimeout(()=>stop('TJ1_STARTUP_TIMEOUT'),CANARY_LIMITS.startupMs);
    watch=setInterval(()=>{try{gate.check('train');if(freemem()<CANARY_LIMITS.postImportRamBytes)canaryFail('TJ1_RESOURCE_REFUSED');}catch{stop('TJ1_AUTHORITY_OR_RESOURCE');}},250);
    child.once('error',()=>stop('TJ1_SPAWN_FAILED'));child.stdin.on('error',()=>stop('TJ1_PIPE_FAILED'));
    child.stderr.on('data',(chunk:Buffer)=>{if(settled)return;stderrBytes+=chunk.length;
      try {gate.check('write');const retain=Math.min(chunk.length,CANARY_LIMITS.stderrBytes-stderrRetainedBytes);let p=0;
        while(p<retain){const n=writeSync(errorFd,chunk,p,retain-p);if(n<=0)canaryFail('TJ1_RECEIPT_IO');p+=n;}stderrRetainedBytes+=retain;
      }catch{stop('TJ1_STDERR_EVIDENCE_UNAVAILABLE');}
      if(stderrBytes>CANARY_LIMITS.stderrBytes)stop('TJ1_STDERR_LIMIT');});
    child.stdout.on('data',(chunk:Buffer)=>{
      if(failure||settled)return;
      try {
        gate.check('train');stdoutBytes+=chunk.length;if(stdoutBytes>CANARY_LIMITS.stdoutBytes)canaryFail('TJ1_STDOUT_LIMIT');
        // Retain exact bounded private stdout, including a malformed final receipt; never echo it in errors.
        let written=0;while(written<chunk.length){const n=writeSync(fd,chunk,written,chunk.length-written);if(n<=0)canaryFail('TJ1_RECEIPT_IO');written+=n;}
        fsyncSync(fd);output=Buffer.concat([output,chunk]);
        while(output.includes(10)) {
          const end=output.indexOf(10);if(end>CANARY_LIMITS.lineBytes)canaryFail('TJ1_LINE_LIMIT');
          const bytes=output.subarray(0,end),raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);output=output.subarray(end+1);
          const {frame}=parseCanaryWorkerFrame(raw);
          if(frame.stage!==stage||frame.launchId!==request.launchId||frame.manifestDigest!==request.manifestDigest||frame.sequence!==String(++sequence))canaryFail('TJ1_PROTOCOL');
          if(!ready){if(frame.kind!=='READY')canaryFail('TJ1_PROTOCOL');ready=true;clearTimeout(startup);
            if(frame.data.runtime!=='torch:'+CANARY_CONFIG.torchVersion)canaryFail('TJ1_RUNTIME_MISMATCH');
            if(freemem()<CANARY_LIMITS.postImportRamBytes||Number(frame.data.availableBytes)<CANARY_LIMITS.postImportRamBytes)canaryFail('TJ1_RESOURCE_REFUSED');
            work=setTimeout(()=>stop('TJ1_WORK_TIMEOUT'),stage==='trainer'?CANARY_LIMITS.trainMs:CANARY_LIMITS.evalMs);
          }else if(frame.kind==='READY')canaryFail('TJ1_PROTOCOL');
          peakReportedRss=Math.max(peakReportedRss??0,Number(frame.data.rssBytes));
          onFrame(frame,sha256(Buffer.concat([bytes,Buffer.from('\n')])),send);gate.check('train');
        }
        if(output.length>CANARY_LIMITS.lineBytes)canaryFail('TJ1_LINE_LIMIT');
      }catch(e){stop(e instanceof CanaryError?e.code:'TJ1_PROTOCOL_OR_IO');}
    });
    child.once('close',(code,signal)=>{if(output.length!==0)failure??='TJ1_TRUNCATED_RECEIPT';finish(code,signal,true);});
  });
}

/** Explicit one-attempt entrypoint. A fresh current grant and an externally frozen manifest digest are required. */
export async function runCanary(options:Options&{expectedManifestDigest:string}) {
  const gate=new CanaryGate(options.authority);let ledger:CanaryLedger|undefined,consumed=false,training:'COMPLETED'|'FAILED'|'UNKNOWN'='UNKNOWN';
  const stages={delta:'NOT_RUN',export:'NOT_RUN',reload:'NOT_RUN',evaluation:'NOT_RUN'} as Record<'delta'|'export'|'reload'|'evaluation','PASS'|'FAIL'|'NOT_RUN'|'UNKNOWN'>;
  let trainer:ChildResult|undefined,evaluator:ChildResult|undefined;
  try {
    const authority=gate.check('train'),directory=privateDirectory(options.directory),m=checkFrozen(directory,options.expectedManifestDigest);
    if(m.scopeDigest!==scopeDigest(authority))canaryFail('TJ1_AUTHORITY');ledger=CanaryLedger.open(directory,gate);
    const history=ledger.read();if(history.meta.lane!=='ACTUAL_LOCAL'||history.meta.manifestDigest!==options.expectedManifestDigest||
      history.meta.runId!==m.runId||history.meta.attemptId!==m.attemptId||history.projection.consumed)canaryFail('TJ1_CONSUMED');
    if(history.records.length!==1||history.records[0]!.kind!=='PREPARED')canaryFail('TJ1_PREPARATION_UNKNOWN');
    const outputDirectory=privateDirectory(join(directory,'artifacts'));if(readdirSync(outputDirectory).length!==0)canaryFail('TJ1_ARTIFACT_SET');
    if(freemem()<CANARY_LIMITS.preRamBytes)canaryFail('TJ1_RESOURCE_REFUSED');gate.check('train');
    const launchId=randomUUID();ledger.append('LAUNCH_CONSUMED',{launchId},'HOST_CONTROL');consumed=true;
    let observedSteps=0,exported=false,finalTensors:unknown=null,firstVerified=false;
    const request={version:1,launchId,manifestDigest:options.expectedManifestDigest,scriptDigest:m.build['scripts/tj1-trainer.py'],
      trainPath:join(directory,m.files.train.name),trainDigest:m.files.train.sha256,initialPath:join(directory,m.files.initial.name),initialDigest:m.files.initial.sha256,
      outputDirectory,config:m.config,configDigest:m.configDigest};
    trainer=await supervisedChild('trainer',m,directory,request,gate,(frame,receiptDigest,send)=>{
      if(frame.kind==='READY'){ledger!.append('TRAINER_READY',frame.data,'PINNED_TRAINER_OBSERVED',receiptDigest);send('START',0);}
      else if(frame.kind==='STEP') {
        if(exported||frame.data.step!==String(observedSteps+1)||observedSteps>=64)canaryFail('TJ1_ORDER');
        ledger!.append('STEP',frame.data,'PINNED_TRAINER_OBSERVED',receiptDigest);observedSteps++;finalTensors=frame.data.tensors;
        if(observedSteps===1){verifyFirstStep(frame.data.gradient,frame.data.tensors);firstVerified=true;}
        if(observedSteps===64)stages.export='UNKNOWN';
        send(observedSteps===64?'EXPORT':'NEXT',observedSteps);
      }else if(frame.kind==='EXPORTED'){if(observedSteps!==64||exported)canaryFail('TJ1_ORDER');exported=true;}
      else canaryFail('TJ1_PROTOCOL');
    });
    if(trainer.outcomePersisted){const evidence=fileIdentity(join(directory,'trainer-process.json'),'trainer-process.json',8_192);
      ledger.append('PROCESS_OUTCOME',{stage:'trainer',bytes:String(evidence.bytes),sha256:evidence.sha256},'HOST_CONTROL',null,'PROCESS_OUTCOME:trainer');}
    training=trainer.closeObserved&&trainer.exitCode===0&&!trainer.failure&&observedSteps===64&&exported?'COMPLETED':
      trainer.closeObserved&&trainer.exitCode!==null&&trainer.exitCode!==0?'FAILED':'UNKNOWN';
    // Training terminal is committed before any reload or quality result can exist.
    ledger.append('TRAIN_TERMINAL',{outcome:training,observedSteps:String(observedSteps),exitCode:trainer.exitCode},'HOST_CONTROL');
    if(training!=='COMPLETED')canaryFail(trainer.failure??'TJ1_TRAINING_NOT_COMPLETED');
    const artifactDirectory=join(directory,'artifacts');privateDirectory(artifactDirectory);
    if(canonical(readdirSync(artifactDirectory).sort())!==canonical(['checkpoint.pt','weights.json']))canaryFail('TJ1_ARTIFACT_SET');
    const weights=fileIdentity(join(artifactDirectory,'weights.json'),'weights.json'),checkpoint=fileIdentity(join(artifactDirectory,'checkpoint.pt'),'checkpoint.pt');
    if(weights.bytes+checkpoint.bytes>CANARY_LIMITS.totalArtifactBytes)canaryFail('TJ1_LIMIT');
    const exportedWeights=closed(boundedJson(readFileSync(join(artifactDirectory,'weights.json'),'utf8')),['format','tensors']);
    if(exportedWeights.format!=='tj1-weights-v1'||canonical(exportedWeights.tensors)!==canonical(finalTensors))canaryFail('TJ1_TENSOR_IDENTITY');
    stages.delta='UNKNOWN';const independent=independentEvaluation(exportedWeights.tensors);
    if(!firstVerified||independent.changed===0||independent.deltaL2<=1e-6)canaryFail('TJ1_DELTA_FAILED');
    ledger.append('DELTA_CHECK',{initialDigest:m.files.initial.sha256,finalDigest:sha256(canonical(exportedWeights.tensors)),deltaBits:f64Bits(independent.deltaL2),
      changed:String(independent.changed),firstStep:'PASS'},'PARENT_VERIFIED');stages.delta='PASS';
    for(const file of [weights,checkpoint])ledger.append('ARTIFACT',{name:file.name,bytes:String(file.bytes),sha256:file.sha256},'PARENT_VERIFIED');stages.export='PASS';
    const evalLaunch=randomUUID();let evalResult:Record<string,unknown>|undefined,evalReceipt:string|null=null;
    if(freemem()<CANARY_LIMITS.preRamBytes)canaryFail('TJ1_RESOURCE_REFUSED');
    const evalRequest={version:1,launchId:evalLaunch,manifestDigest:options.expectedManifestDigest,scriptDigest:m.build['scripts/tj1-evaluator.py'],
      evalPath:join(directory,m.files.eval.name),evalDigest:m.files.eval.sha256,initialPath:join(directory,m.files.initial.name),initialDigest:m.files.initial.sha256,
      weightsPath:join(artifactDirectory,weights.name),weightsDigest:weights.sha256,checkpointPath:join(artifactDirectory,checkpoint.name),checkpointDigest:checkpoint.sha256,
      configDigest:m.configDigest,trainDigest:m.files.train.sha256,trainerDigest:m.build['scripts/tj1-trainer.py']};
    gate.check('train');stages.reload='UNKNOWN';stages.evaluation='UNKNOWN';
    evaluator=await supervisedChild('evaluator',m,directory,evalRequest,gate,(frame,receipt,send)=>{
      if(frame.kind==='READY')send('EVALUATE',0);else if(frame.kind==='RESULT'&&!evalResult){evalResult=frame.data;evalReceipt=receipt;}else canaryFail('TJ1_PROTOCOL');
    });
    if(evaluator.outcomePersisted){const evidence=fileIdentity(join(directory,'evaluator-process.json'),'evaluator-process.json',8_192);
      ledger.append('PROCESS_OUTCOME',{stage:'evaluator',bytes:String(evidence.bytes),sha256:evidence.sha256},'HOST_CONTROL',null,'PROCESS_OUTCOME:evaluator');}
    if(evaluator.failure||!evaluator.closeObserved||evaluator.exitCode!==0||!evalResult)canaryFail('TJ1_EVALUATOR_UNKNOWN');
    const result=evalResult as Record<string,unknown>;
    if(result.weightsDigest!==weights.sha256||result.checkpointDigest!==checkpoint.sha256||result.initialDigest!==m.files.initial.sha256||
      canonical(result.tensors)!==canonical(exportedWeights.tensors)||result.changed!==String(independent.changed)||
      !near(bitsF64(result.deltaBits as string),independent.deltaL2))canaryFail('TJ1_RELOAD_MISMATCH');
    // Rehash after the evaluator exited; a readback result cannot bless changed artifacts.
    for(const f of [weights,checkpoint])if(canonical(fileIdentity(join(artifactDirectory,f.name),f.name))!==canonical(f))canaryFail('TJ1_ARTIFACT_CHANGED');
    ledger.append('RELOAD',{result:'PASS',weightsDigest:weights.sha256,checkpointDigest:checkpoint.sha256,rssBytes:result.rssBytes},'PINNED_EVALUATOR_OBSERVED',evalReceipt);stages.reload='PASS';
    const predictions=result.predictions as string[],mse=bitsF64(result.mseBits as string),baseline=bitsF64(result.baselineBits as string);
    if(!predictions.every((v,i)=>near(bitsF64(v),bitsF64(independent.predictions[i]!)))||!near(mse,independent.mse)||!near(baseline,independent.baselineMse))canaryFail('TJ1_EVAL_MISMATCH');
    const quality=baseline>0&&mse<=1e-6&&mse<=.01*baseline&&independent.mse<=1e-6&&independent.mse<=.01*independent.baselineMse?'PASS':'FAIL';
    ledger.append('EVALUATION',{result:quality,mseBits:result.mseBits,baselineBits:result.baselineBits,predictionsDigest:sha256(canonical(predictions))},'PARENT_VERIFIED',evalReceipt);stages.evaluation=quality;
    ledger.append('OBSERVATION_END',{training,...stages,code:'OBSERVATION_COMPLETED'},'HOST_CONTROL');gate.check('read');
    return {status:'OBSERVATION_COMPLETED',assurance:'CURRENT_LOCAL_OBSERVER',executionMode:'ACTUAL_LOCAL',datasetOrigin:'ORIGINAL_SYNTHETIC',training,realTrainingPerformed:true,
      optimizerSteps:{value:64,evidence:'PINNED_TRAINER_OBSERVED'},firstStep:{result:'PASS',evidence:'PARENT_ANALYTIC_CHECK'},stages,
      metrics:{mseBits:result.mseBits,baselineBits:result.baselineBits,deltaL2Bits:f64Bits(independent.deltaL2),changed:independent.changed},
      trainer,evaluator,externalProviderCalls:0,paidApiCalls:0,networkCalls:0,activation:'NOT_IMPLEMENTED',reopenAssurance:'RECONCILE_REQUIRED',
      manifestDigest:options.expectedManifestDigest,ledgerHead:ledger.read().head};
  }catch(error) {
    if(consumed&&ledger) {
      try {const p=ledger.read().projection;
        if(['NOT_STARTED','RUNNING'].includes(p.training))ledger.append('TRAIN_TERMINAL',{outcome:'UNKNOWN',observedSteps:String(p.steps),exitCode:trainer?.exitCode??null},'HOST_CONTROL');
        const after=ledger.read().projection;training=after.training as typeof training;
        if(!after.ended)ledger.append('OBSERVATION_END',{training,...stages,code:error instanceof CanaryError?error.code:'TJ1_OBSERVER_UNKNOWN'},'HOST_CONTROL');
      }catch{/* Revocation/failure leaves consumed history incomplete. Never bypass the authority gate to repair it. */}
    }
    if(error instanceof CanaryError)throw error;return canaryFail('TJ1_OBSERVER_UNKNOWN');
  }finally{ledger?.close();gate.fence();}
}
export function readCanaryHistory(options:Options):ReturnType<CanaryLedger['read']> {
  const gate=new CanaryGate(options.authority),ledger=CanaryLedger.open(options.directory,gate);try{return ledger.read();}finally{ledger.close();}
}
