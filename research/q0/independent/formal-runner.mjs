import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,statSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {freemem,totalmem} from 'node:os';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert(['FORMAL_INITIAL_BLIND','PUBLIC_REPLAY'].includes(config.runKind),'RUN_KIND');const formal=config.runKind==='FORMAL_INITIAL_BLIND';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceRoot=config.sourceRoot,capsuleRoot=config.capsuleRoot,out=config.outputDirectory;
if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');mkdirSync(out);
const started=performance.now(),startedAt=new Date().toISOString();let phase='admission',peakRSS=process.memoryUsage().rss,gate=null;
const emit=(stage,extra={})=>console.log(JSON.stringify({stage,elapsedSeconds:(performance.now()-started)/1000,...extra}));
const put=(name,value)=>{const data=typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n';writeFileSync(join(out,name),data,{flag:'wx'});};
const bytesUnder=dir=>readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?bytesUnder(join(dir,e.name)):statSync(join(dir,e.name)).size),0);
function resource(label){
  const rss=process.memoryUsage().rss;peakRSS=Math.max(peakRSS,rss,process.resourceUsage().maxRSS*1024);
  const wall=(performance.now()-started)/1000,artifactBytes=bytesUnder(out);
  if(peakRSS>512*1024*1024)throw Error('RSS_LIMIT:'+label);
  if(wall>180)throw Error('WALL_LIMIT:'+label);
  if(artifactBytes>64*1024*1024)throw Error('ARTIFACT_LIMIT:'+label);
  return{label,rssBytes:rss,observedPeakRSSBytes:peakRSS,wallSeconds:wall,artifactBytes};
}
function verifyFrozen(){
  const mf=readFileSync(join(sourceRoot,'ENCODER-FREEZE.json'));
  assert.equal(sha(mf),config.encoderFreezeSha256,'ENCODER_FREEZE_HASH');
  const manifest=JSON.parse(mf),checked=[];
  for(const f of manifest.files){const b=readFileSync(join(sourceRoot,f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256,'ENCODER_SOURCE_CHANGED:'+f.path);checked.push({path:f.path,bytes:b.length,sha256:f.sha256});}
  const cb=readFileSync(join(capsuleRoot,'COMMITMENT.json'));assert.equal(sha(cb),config.evaluatorCommitmentSha256);
  const commitment=JSON.parse(cb);
  for(const f of commitment.files){const b=readFileSync(join(capsuleRoot,f.name));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256,'EVALUATOR_CHANGED:'+f.name);}
  assert.equal(manifest.reviewerCommitment.commitmentSha256,config.evaluatorCommitmentSha256);
  assert.equal(process.version,manifest.runtime.node);assert.equal(process.versions.zstd,manifest.runtime.zstd);
  assert.equal(sha(readFileSync(process.execPath)),manifest.runtime.executableSha256);
  assert(Date.parse(commitment.committedAt)<Date.parse(manifest.utc),'ORDERING');
  return{manifest,commitment,checked};
}
function skeleton(family){
  const {events,...meta}=family;
  return{...meta,events:events.map(({objects,relations,...event})=>({...event,
    objects:objects.map(({attrs,...object})=>({...object,attributeNames:Object.keys(attrs).sort()})),
    relations:relations.map(({status,value,fidelity,maxAbsError,...relation})=>relation)}))};
}
const quantile=(a,p)=>{const x=[...a].sort((u,v)=>u-v);return x[Math.floor(p*(x.length-1))];};
const timing=values=>({count:values.length,p50Ms:quantile(values,.5),p95Ms:quantile(values,.95),totalMs:values.reduce((a,b)=>a+b,0)});
let firstFrozen;
try{
  firstFrozen=verifyFrozen();
  const free=freemem();gate={utc:new Date().toISOString(),freeRAMBytes:free,totalRAMBytes:totalmem(),minimumFreeRAMBytes:2048*1024*1024,node:process.version,zstd:process.versions.zstd,platform:process.platform,arch:process.arch,heapFlag:'--max-old-space-size=256',cpuWorkers:1,gpuUsed:false,realModelCalls:0,ownedPriorResearchProcess:'NONE; exclusive single launch claim'};
  put('ADMISSION.json',gate);
  if(free<2048*1024*1024){put('REFUSED.json',{status:'REFUSED_BEFORE_HELDOUT_GENERATION',reason:'INSUFFICIENT_FREE_RAM',gate,formalComputeStarted:false,automaticRetryAllowed:false});emit('REFUSED');process.exitCode=2;}
  else{
    resource('admitted');emit('ADMITTED',{freeRAMMiB:Math.floor(free/1048576)});
    mkdirSync(join(out,'reproduce'));
    for(const name of ['evaluator.mjs','selfcheck.mjs','SAMPLER-RULES.md','selfcheck.log','private-seeds.json','COMMITMENT.json'])copyFileSync(join(capsuleRoot,name),join(out,'reproduce',name));
    for(const name of ['INTERFACE.md','protocol.json','PLAN.md','ENCODER-FREEZE.json'])copyFileSync(join(sourceRoot,name),join(out,'reproduce',name));
    copyFileSync(process.argv[1],join(out,'reproduce','formal-runner.mjs'));copyFileSync(process.argv[2],join(out,'reproduce','formal-config.json'));
    const ev=await import(pathToFileURL(join(capsuleRoot,'evaluator.mjs')));
    const {makeFamilies,stable}=await import(pathToFileURL(join(sourceRoot,'scene.mjs')));
    const {encodeFamily,decodeFamily,METHODS}=await import(pathToFileURL(join(sourceRoot,'codec.mjs')));
    const {writeArchive,readArchiveFamily}=await import(pathToFileURL(join(sourceRoot,'archive.mjs')));
    const protocol=JSON.parse(readFileSync(join(sourceRoot,'protocol.json'),'utf8')),seeds=JSON.parse(readFileSync(join(capsuleRoot,'private-seeds.json'),'utf8'));
    assert.deepEqual(METHODS,protocol.methods);
    const prototypes=JSON.parse(readFileSync(join(sourceRoot,'development','prototypes.json'),'utf8'));
    phase='generation';
    const families=seeds.dataSeeds.flatMap(seed=>makeFamilies(seed,200));
    assert.equal(families.length,600);assert.equal(new Set(families.map(f=>f.familyId)).size,600);
    const queries=families.map((family,i)=>ev.makeQueries(family,Math.floor(i/200),i%200,seeds.querySeed));
    const rawText=stable(families)+'\n',queryText=JSON.stringify(queries)+'\n';
    assert(Buffer.byteLength(rawText)<=16*1024*1024,'INPUT_16MIB');
    put('observations.json',rawText);put('queries.json',queryText);
    put('DATA-MANIFEST.json',{families:600,seeds:3,events:2400,objectObservations:7200,queries:14400,observationsSha256:sha(rawText),queriesSha256:sha(queryText),privateSeedCommitment:firstFrozen.commitment.seedCommitment,generatorHash:firstFrozen.checked.find(x=>x.path==='scene.mjs').sha256});
    resource('generated');emit('HELDOUT_GENERATED',{families:600,queries:14400,inputBytes:Buffer.byteLength(rawText)});
    const rows=families.map((f,i)=>({familyId:f.familyId,seedIndex:Math.floor(i/200),familyIndex:i%200,methods:{}})),methods={},allCosts={};
    mkdirSync(join(out,'archives'));mkdirSync(join(out,'amortization'));mkdirSync(join(out,'metrics'));
    for(const method of METHODS){
      phase='method:'+method;emit('METHOD_STARTED',{method});
      const warm=encodeFamily(families[0],method,prototypes);decodeFamily(warm.header,warm.bytes,prototypes);
      const directory=join(out,'archives',method),wall=performance.now(),cpu0=process.cpuUsage();
      const cost=writeArchive(families,method,directory,prototypes);
      const archiveBuildMs=performance.now()-wall,archiveBuildCPU=process.cpuUsage(cpu0);
      resource('archive:'+method);
      const decodeMs=[],encodeMs=[];
      for(let i=0;i<families.length;i++){
        const stem=String(i).padStart(6,'0'),header=JSON.parse(readFileSync(join(directory,stem+'.header.json'),'utf8')),bytes=readFileSync(join(directory,stem+'.zst'));
        // A fixed additional pure-encoder timing pass; no refit, result-dependent retries or query input.
        const e0=performance.now(),encoded=encodeFamily(families[i],method,prototypes);encodeMs.push(performance.now()-e0);
        assert.equal(sha(encoded.bytes),sha(bytes),'NONDETERMINISTIC_ENCODING');
        const d0=performance.now(),decoded=decodeFamily(header,bytes,prototypes);decodeMs.push(performance.now()-d0);
        assert.equal(stable(skeleton(decoded)),stable(skeleton(families[i])),'BINDING_SKELETON_CORRUPTION');
        if(['FULL_JSON_ZSTD','FULL_BOUND_TEMPLATE_ZSTD','PROTO_DELTA_LOSSLESS_ZSTD'].includes(method))assert.equal(stable(decoded),stable(families[i]),'LOSSLESS_ROUNDTRIP_MISMATCH');
        const score=ev.scoreFamily(families[i],decoded,queries[i]);rows[i].methods[method]=score;
        assert.equal(score.detail.bindingErrors,0,'BINDING_CORRUPTION');assert.equal(score.detail.fabricatedUnknown,0,'UNKNOWN_FABRICATION');assert.equal(score.detail.unknownLost,0,'UNKNOWN_LOSS');assert.equal(score.detail.quantizedErrorBoundViolations,0,'QUANTIZATION_BOUND_INVALID');
        if(['FULL_JSON_ZSTD','FULL_BOUND_TEMPLATE_ZSTD','PROTO_DELTA_LOSSLESS_ZSTD','PROTO_DELTA_Q_ANCHOR_ZSTD'].includes(method))assert.equal(score.detail.anchorExact,score.detail.anchorCells,'PROMISED_ANCHOR_LOSS');
        if(i%32===0)resource('score:'+method+':'+i);
      }
      const random=ev.rng(seeds.querySeed^0x517cc1b7),order=families.map((_,i)=>i);
      for(let i=order.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
      readArchiveFamily(directory,families[0].familyId);
      const readMs=[];
      for(const i of order){const t=performance.now();readArchiveFamily(directory,families[i].familyId);readMs.push(performance.now()-t);}
      const summary=ev.aggregate(rows.map(row=>row.methods[method])),perSeed=[0,1,2].map(seedIndex=>({seedIndex,...ev.aggregate(rows.filter(row=>row.seedIndex===seedIndex).map(row=>row.methods[method]))}));
      put('metrics/'+method+'-families.json',rows.map(row=>({familyId:row.familyId,seedIndex:row.seedIndex,score:row.methods[method]})));
      put('metrics/'+method+'-summary.json',{summary,perSeed});
      methods[method]={summary,perSeed,timing:{warmup:'one encode/decode plus one archive-read, disclosed and excluded',encode:timing(encodeMs),decode:timing(decodeMs),randomArchiveRead:timing(readMs),archiveBuildMs,archiveBuildCPU,measurement:'single process; additional fixed pure encode pass; archive random read includes index parse, filesystem and decode; warm OS cache not cold disk'}};
      allCosts[method]={...cost,amortization:[]};resource('method:'+method);emit('METHOD_FINISHED',{method});
    }
    phase='amortization';
    for(const method of METHODS){mkdirSync(join(out,'amortization',method));
      for(const n of [8,32,128,512]){const cost=writeArchive(families.slice(0,n),method,join(out,'amortization',method,String(n)),prototypes);allCosts[method].amortization.push(cost);resource('amortization:'+method+':'+n);}
    }
    phase='statistics';emit('BOOTSTRAP_STARTED');
    const standard=['FULL_JSON_ZSTD','FULL_BOUND_TEMPLATE_ZSTD'],best=standard.reduce((a,b)=>allCosts[a].archiveBytes<=allCosts[b].archiveBytes?a:b);
    const intervals=ev.pairedIntervals(rows,best,seeds.bootstrapSeed,2000);
    resource('bootstrap');emit('BOOTSTRAP_FINISHED');
    const fixedAuditBytes=bytesUnder(join(out,'reproduce'))+statSync(join(out,'queries.json')).size+statSync(join(out,'DATA-MANIFEST.json')).size;
    const decisions={};
    for(const method of METHODS){
      put('metrics/'+method+'-intervals.json',intervals[method]);
      const c=allCosts[method],summary=methods[method].summary,metricsBytes=['-families.json','-summary.json','-intervals.json'].reduce((n,suffix)=>n+statSync(join(out,'metrics',method+suffix)).size,0),sharedAuditBytes=fixedAuditBytes;
      c.retainedSharedAuditBytes=sharedAuditBytes;c.retainedMethodMetricsBytes=metricsBytes;
      c.standaloneWithReproductionAuditBytes=c.archivePlusRuntimePlusColdOriginalBytes+sharedAuditBytes+metricsBytes;
      c.auditExclusions='one-shot controller logs/admission/final summary and experimental competing-method/amortization archives are reported separately as experiment artifacts; filesystem allocation, OS and backups not measured';
      const archiveSavingsPercent=(1-c.archiveBytes/allCosts[best].archiveBytes)*100,qi=intervals[method],detail=summary.detail;
      const exactNI=['announced','unannounced_all'].every(group=>qi['exact:'+group].lower95!==null&&qi['exact:'+group].lower95>-.01);
      const rareNI=['crack_mm','serial_tag','dose_mg'].every(attr=>summary.rare[attr].minimumSupportMet&&qi['rareDetailPrecision:'+attr].lower95!==null&&qi['rareDetailPrecision:'+attr].lower95>-.01&&qi['rareDetailRecall:'+attr].lower95!==null&&qi['rareDetailRecall:'+attr].lower95>-.01);
      const anchors=detail.anchorExact===detail.anchorCells;
      decisions[method]={relativeTo:best,archiveSavingsPercent,exactNoninferiority:exactNI,rareDetailNoninferiority:rareNI,hardAnchorsExact:anchors,sourceBindingsExact:detail.bindingErrors===0,unknownsPreserved:detail.fabricatedUnknown===0&&detail.unknownLost===0,
        utilityGate:archiveSavingsPercent>=15&&exactNI&&rareNI&&anchors?'FINITE_SYNTHETIC_ARCHIVE_CRITERIA_MET':'NO_QUALIFYING_ADVANTAGE_OR_INCONCLUSIVE',standaloneSavingIsSeparate:true};
    }
    const finalFrozen=verifyFrozen();assert.deepEqual(firstFrozen.checked,finalFrozen.checked);
    const result={version:'q0-independent-formal-result-1',status:formal?'FORMAL_RUN_COMPLETED':'PUBLIC_REPLAY_COMPLETED',runKind:config.runKind,startedAt,endedAt:new Date().toISOString(),baseline:best,gate,resources:resource('final'),methods,costs:allCosts,pairedIntervals:intervals,decisions,recipe:ev.RULES,sourceIntegrity:{encoderFreezeSha256:config.encoderFreezeSha256,evaluatorCommitmentSha256:config.evaluatorCommitmentSha256,filesBeforeAfterUnchanged:true},boundaries:{realModelCalls:0,trainingJobs:0,gpuUsed:false,productionData:false,coreWrites:0,perception:'NOT_TESTED',retrieval:'GIVEN_ADDRESS_ONLY',openWorld:'NOT_TESTED',statistics:'conditional frozen synthetic generator; degenerate bootstrap is not future zero risk; 30 positives is not power',publishedHoldout:'REGRESSION_AFTER_REVEAL'},noAutomaticRetry:true};
    put('RESULTS.json',result);put('COMPLETION.json',{status:result.status,resultsSha256:sha(readFileSync(join(out,'RESULTS.json'))),resources:resource('completed'),finalSourcesVerified:true,oneFormalRun:formal});
    emit(formal?'FORMAL_RUN_COMPLETED':'PUBLIC_REPLAY_COMPLETED',{outputDirectory:out,resultsSha256:sha(readFileSync(join(out,'RESULTS.json'))),observedPeakRSSMiB:peakRSS/1048576});
  }
}catch(error){
  const message=error instanceof Error?error.message:String(error);
  let sourceCheck;try{verifyFrozen();sourceCheck='UNCHANGED';}catch(e){sourceCheck='FAILED:'+e.message;}
  put('FAILURE.json',{status:'FORMAL_RUN_FAILED_OR_REFUSED',phase,startedAt,failedAt:new Date().toISOString(),message,stack:error?.stack??null,resources:{wallSeconds:(performance.now()-started)/1000,observedPeakRSSBytes:peakRSS,artifactBytes:bytesUnder(out)},gate,sourceCheck,automaticRetryAllowed:false});
  console.error(JSON.stringify({stage:'FORMAL_FAILED',phase,message,outputDirectory:out}));process.exitCode=1;
}
