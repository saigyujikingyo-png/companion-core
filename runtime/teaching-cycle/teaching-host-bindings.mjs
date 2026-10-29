import fs from 'node:fs';
import path from 'node:path';
import { hkdfSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonical,hash,shape,digest,integer,stop } from '../../src/wf1-json.ts';
import { privateRoot } from '../../src/wf1-storage.ts';
import { validateCycleSpec,validateCurriculumPlan } from '../../src/teaching-cycle-types.ts';
import { TEACHING_CYCLE_BUILD_FILES,teachingCycleBuildDigest } from '../../src/teaching-cycle-build.ts';
import { openTeachingCycleHost,deterministicTeachingAuditBinding,sealTeachingQaArchive } from '../../src/teaching-cycle-host.ts';
import { createProductionTransport } from '../../src/corpus-production-runner.ts';
import { createQaTransport } from '../../src/corpus-qa-runner.ts';
import { runTeachingCycleCommand } from '../../src/teaching-cycle-cli.ts';
import { teachingCycleReport } from '../../src/teaching-cycle-report.ts';
import { finalizeTeachingAuthority } from './teaching-revoker.mjs';
export { finalizeTeachingAuthority,revokeTeachingCycle } from './teaching-revoker.mjs';

export const HOST_FILES=['runtime/teaching-cycle/teaching-host-bindings.mjs','runtime/teaching-cycle/teaching-native-worker.mjs','runtime/teaching-cycle/teaching-revoker.mjs','runtime/teaching-cycle/Invoke-TeachingCycle.ps1'];
const same=(a,b,code='TCH_BINDING')=>{if(canonical(a)!==canonical(b))stop(code);};
export function readBytes(file,cap=4194304){
  if(!path.isAbsolute(file)||fs.realpathSync.native(file).toLowerCase()!==path.resolve(file).toLowerCase())stop('TCH_PATH');
  const a=fs.lstatSync(file,{bigint:true});if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1n||a.size<1n||a.size>BigInt(cap))stop('TCH_FILE');
  const bytes=fs.readFileSync(file),b=fs.lstatSync(file,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>a[k]!==b[k])||BigInt(bytes.length)!==a.size)stop('TCH_FILE_CHANGED');return bytes;
}
export const readJson=(file,cap)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBytes(file,cap)).replace(/^\uFEFF/,''));
export function pinned(ref){shape(ref,['path','sha256']);digest(ref.sha256);const bytes=readBytes(ref.path);if(hash(bytes)!==ref.sha256)stop('TCH_PIN');return bytes;}
const pinnedJson=ref=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pinned(ref)).replace(/^\uFEFF/,''));
export function writeNew(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,canonical(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function inside(root,file){const r=path.relative(root,file);return r!==''&&!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);}
function controlPath(c,file){privateRoot(c.controlRoot);if(!inside(c.controlRoot,file))stop('TCH_CONTROL_PATH');return file;}

export function validateTeachingConfig(input){
  const c=shape(input,['version','environment','sourceRoot','sourcePins','approvedTrainingRoot','controlRoot','cycle','plan','objective','children','tokenizer','admission','launcher']);
  if(c.version!=='TeachingCycleHostConfig/0.1'||!['PRODUCTION_NATIVE','SYNTHETIC_FIXTURE'].includes(c.environment))stop('TCH_CONFIG');
  validateCycleSpec(c.cycle.spec);validateCurriculumPlan(c.plan,c.cycle.spec);if(c.cycle.spec.version!=='TeachingCycle/0.2'||hash(c.objective)!==c.plan.approvedObjectiveDigest)stop('TCH_CONFIG');
  shape(c.cycle,['runtimeRoot','authorityPath','spec']);shape(c.tokenizer,['profile','pythonPath','runtimePin']);shape(c.tokenizer.runtimePin,['path','sha256']);
  if(!Array.isArray(c.children)||c.children.length!==c.plan.children.length)stop('TCH_CONFIG');
  for(const child of c.children){shape(child,['childId','production','audit','archive']);shape(child.production,['runtimeRoot','authorityPath','spec','registry','purposes']);shape(child.audit,['runtimeRoot','authorityPath','template','purposes','grantPath','grantTemplate']);shape(child.archive,['readerBuildDigest','grantPath','grantTemplate']);}
  shape(c.admission,['rootRecord','curriculum','projectUseRecord','mentorEvidence']);
  shape(c.launcher,['nodePath','nodeSha256','shellPath','shellSha256','timeoutMs','credentialsDpapiPath']);integer(c.launcher.timeoutMs,1000,86400000);
  if(!path.isAbsolute(c.launcher.credentialsDpapiPath)||path.extname(c.launcher.credentialsDpapiPath)!=='.dpapi'||inside(c.approvedTrainingRoot,c.launcher.credentialsDpapiPath))stop('TCH_CREDENTIAL_PATH');
  const roots=[c.cycle.runtimeRoot,...c.children.flatMap(b=>[b.production.runtimeRoot,b.audit.runtimeRoot])],controls=[c.cycle.authorityPath,...c.children.flatMap(b=>[b.production.authorityPath,b.audit.authorityPath,b.audit.grantPath,b.archive.grantPath])];
  if(inside(c.approvedTrainingRoot,c.controlRoot)||inside(c.controlRoot,c.approvedTrainingRoot)||path.resolve(c.controlRoot)===path.resolve(c.approvedTrainingRoot)||roots.some(r=>!inside(c.approvedTrainingRoot,r))||controls.some(f=>!inside(c.controlRoot,f))||new Set([...roots,...controls].map(f=>path.resolve(f).toLowerCase())).size!==roots.length+controls.length)stop('TCH_CUSTODY');
  return c;
}

export function verifyTeachingSource(c){
  const root=path.resolve(c.sourceRoot),own=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));if(root.toLowerCase()!==own.toLowerCase())stop('TCH_SOURCE_ROOT');
  const expected=[...TEACHING_CYCLE_BUILD_FILES,...HOST_FILES].sort(),pins=c.sourcePins;
  if(!Array.isArray(pins)||pins.length!==expected.length)stop('TCH_SOURCE_PINS');
  same(pins.map(p=>p.path).sort(),expected,'TCH_SOURCE_PINS');
  for(const p of pins){shape(p,['path','sha256']);if(p.path.includes('\\')||p.path.includes(':')||p.path.split('/').some(x=>!x||x==='.'||x==='..'))stop('TCH_SOURCE_PINS');pinned({path:path.join(root,p.path),sha256:p.sha256});}
  if(c.cycle.spec.buildDigest!==teachingCycleBuildDigest()||hash(readBytes(c.launcher.nodePath,134217728))!==c.launcher.nodeSha256)stop('TCH_BUILD');
}

/** Reuses the approved public-runtime manifest's byte pins, not version strings
 * as a substitute for identity. The official worker still verifies asset bytes. */
export function verifyTeachingPython(c){
  const {profile,pythonPath,runtimePin}=c.tokenizer,pin=pinnedJson(runtimePin);
  shape(pin,['version','scope','observedAtUtc','approval','historicalPin','closure','closureLimit','pythonPath','runtime','runtimeFiles','changes','signatures','publicAssets','realApiCalls','studentTraining','privateSamplesRead','testsRun','readiness']);shape(pin.runtime,['python','baseExecutable','basePrefix','executable','tokenizers','jinja2','markupsafe']);
  if(pin.version!=='S2CurrentPublicTokenizerPin/1'||pin.pythonPath!==pythonPath||pin.runtime.executable!==pythonPath||!path.isAbsolute(pythonPath)||!Array.isArray(pin.runtimeFiles)||pin.runtimeFiles.length!==84)stop('TCH_PYTHON_PIN');
  for(const name of ['python','tokenizers','jinja2','markupsafe'])same(pin.runtime[name],profile.runtime[name],'TCH_PYTHON_VERSION');
  const seen=new Set();for(const entry of pin.runtimeFiles){shape(entry,['path','sha256']);digest(entry.sha256);const file=path.resolve(entry.path).toLowerCase();if(seen.has(file))stop('TCH_PYTHON_PIN');seen.add(file);if(hash(readBytes(entry.path,200000000))!==entry.sha256)stop('TCH_PYTHON_DRIFT');}
  if(!seen.has(path.resolve(pythonPath).toLowerCase())||!seen.has(path.resolve(pin.runtime.baseExecutable).toLowerCase()))stop('TCH_PYTHON_EXECUTABLE');
  const assets=shape(pin.publicAssets,['model','revision','assetRoot','files']);for(const name of ['model','revision','assetRoot'])same(assets[name],profile[name],'TCH_PYTHON_ASSETS');
  if(!Array.isArray(assets.files)||assets.files.length!==4||new Set(assets.files.map(f=>f.path)).size!==4)stop('TCH_PYTHON_ASSETS');
  for(const f of assets.files){shape(f,['path','sha256','bytes']);digest(f.sha256);integer(f.bytes,1,33554432);if(typeof f.path!=='string'||f.path.includes('\\')||f.path.includes(':')||f.path.split('/').some(p=>!p||p==='.'||p==='..'))stop('TCH_PYTHON_ASSETS');}
  for(const [name,sha]of [['tokenizer.json',profile.tokenizerSha256],['chat_template.jinja',profile.templateSha256]])if(assets.files.find(f=>f.path===name)?.sha256!==sha)stop('TCH_PYTHON_ASSETS');
  return {profile,pythonPath};
}

/** Root's approved record is the trusted input. Model output cannot create it.
 * Every check reads the currently pinned files; changed/revoked bytes deny access.
 * files[0] is the JSON completion evidence, whose canonical digest is in the plan. */
export function checkRootAdmission(c,active=false,action=null){
  const a=c.admission,root=pinnedJson(a.rootRecord);
  shape(root,['version','cycleId','planDigest','approvedObjectiveDigest','curriculumDigest','projectUseRecordDigest','mentorViewVersion','mentorViewDigest','productionSpecDigests','mentorEvidenceDigests','approvedActions','validFrom','expiresAt']);
  const plan=c.plan,spec=c.cycle.spec,now=Date.now();integer(root.validFrom);integer(root.expiresAt,root.validFrom+1);
  if(root.version!=='TeachingCycleRootAdmission/0.1'||root.cycleId!==spec.cycleId||root.planDigest!==spec.planDigest||now<root.validFrom||now>=root.expiresAt)stop('TCH_ROOT_ADMISSION');
  for(const field of ['approvedObjectiveDigest','curriculumDigest','projectUseRecordDigest','mentorViewVersion','mentorViewDigest'])same(root[field],plan[field],'TCH_ROOT_BINDING');
  same(root.productionSpecDigests,plan.children.map(c=>c.productionSpecDigest),'TCH_ROOT_BINDING');same(root.mentorEvidenceDigests,plan.mentors.map(m=>m.completionEvidenceDigest),'TCH_ROOT_BINDING');
  const actions=active?['GENERATE','QA','METADATA_READ','RETAIN']:['METADATA_READ','RETAIN'];if(action)actions.push(action);
  if(!Array.isArray(root.approvedActions)||actions.some(v=>!root.approvedActions.includes(v)))stop('TCH_ROOT_ACTION');
  for(const [ref,expected]of [[a.curriculum,plan.curriculumDigest],[a.projectUseRecord,plan.projectUseRecordDigest]])if(hash(canonical(pinnedJson(ref)))!==expected)stop('TCH_ROOT_DOCUMENT');
  if(!Array.isArray(a.mentorEvidence)||a.mentorEvidence.length!==2)stop('TCH_MENTOR');
  for(const [i,e]of a.mentorEvidence.entries()){
    shape(e,['model','requestedEffort','effectiveEffort','effortEvidence','completionEvidenceDigest','evidenceKind','files']);
    const {evidenceKind,files,...binding}=e;same(binding,plan.mentors[i],'TCH_MENTOR');
    if(!['ROOT_OBSERVED_CONTROL_PLANE','CLI_RESULT_SUCCESS_AND_SCHEMA_VALID'].includes(evidenceKind)||!Array.isArray(files)||files.length<1||files.length>8)stop('TCH_MENTOR');
    const evidence=pinnedJson(files[0]);if(hash(canonical(evidence))!==e.completionEvidenceDigest)stop('TCH_MENTOR');for(const ref of files.slice(1))pinned(ref);
  }
}

function boundGrant(c,file,expected,mayCreate){controlPath(c,file);if(!fs.existsSync(file)){if(!mayCreate)stop('TCH_GRANT_MISSING');writeNew(file,expected);}const grant=readJson(file,32768);same(grant,expected,'TCH_GRANT_CHANGED');return grant;}
export function initializeTeachingCustody(c){
  checkRootAdmission(c,true);verifyTeachingSource(c);privateRoot(c.controlRoot);privateRoot(c.approvedTrainingRoot);
  const jobs=[{...c.cycle,jobId:c.cycle.spec.cycleId},...c.children.flatMap(b=>[{...b.production,jobId:b.production.spec.jobId},{...b.audit,spec:b.audit.template,jobId:b.audit.template.auditId}])];
  for(const j of jobs){privateRoot(j.runtimeRoot);controlPath(c,j.authorityPath);if(fs.readdirSync(j.runtimeRoot).length||fs.existsSync(j.authorityPath))stop('TCH_INITIALIZE_EXISTS');}
  for(const j of jobs)writeNew(j.authorityPath,{schemaVersion:'wf1-host/1',campaignId:j.jobId,revision:j.spec.authorityRevision,runtimeId:j.spec.runtimeId,status:'ACTIVE',expiresAt:j.spec.expiresAt,head:null,rights:{seal:true,coordinate:true,generate:true,review:true,retain:true}});
  return {version:'TeachingHostInitialized/0.1',cycleId:c.cycle.spec.cycleId,children:jobs.length-1,providerCalls:0};
}

export function openTrustedTeachingHost(c,masterKey,credentials,owner,mode,dependencies={}){
  validateTeachingConfig(c);verifyTeachingSource(c);checkRootAdmission(c,mode!=='inspect');verifyTeachingPython(c);
  if(!(masterKey instanceof Uint8Array)||masterKey.length!==32)stop('TCH_KEY');
  if(mode==='inspect'&&credentials!==null)stop('TCH_COLD_CREDENTIALS');
  if(mode!=='inspect'){shape(credentials,['deepseek','together']);for(const v of Object.values(credentials))if(typeof v!=='string'||!v||v.length>8192)stop('TCH_CREDENTIALS');}
  const keys=[],keyFor=id=>{const k=Buffer.from(hkdfSync('sha256',masterKey,c.cycle.spec.cycleId,'TeachingCycleKeys/0.1:'+id,32));keys.push(k);return k;},wipe=()=>{for(const key of keys)key.fill(0);keys.length=0;};let host,returned=false;
  try{
    const current=active=>checkRootAdmission(c,active),metadata=child=>{current(false);const plan=c.plan.children.find(p=>p.childId===child.childId);if(!plan||plan.productionSpecDigest!==child.productionSpecDigest)stop('TCH_METADATA');};
    const children=c.children.map(b=>{
      const p=b.production,a=b.audit,productionKey=keyFor(b.childId+':production'),auditKey=keyFor(b.childId+':qa');
      const sourceAdmission=selection=>{current(false);const expected={...a.grantTemplate,selectionDigest:hash(canonical(selection)),purposeDigest:hash(canonical(a.purposes)),sourcePurposeDigest:p.spec.purposeDigest};return {readGrant:boundGrant(c,a.grantPath,expected,mode!=='inspect'),purposes:a.purposes,sourceAllowed:true,retainAllowed:true};};
      const archiveAdmission=descriptor=>{current(false);const expected={...b.archive.grantTemplate,descriptorDigest:hash(canonical(descriptor)),purposeDigest:descriptor.spec.purposeDigest};return {grant:boundGrant(c,b.archive.grantPath,expected,mode!=='inspect'),sourceJobId:p.spec.jobId,sourcePurposeDigest:p.spec.purposeDigest,parentGrantIds:p.registry.parentGrantIds,sourceAllowed:true,retainAllowed:true};};
      const tokenizer={profile:c.tokenizer.profile,get pythonPath(){return verifyTeachingPython(c).pythonPath;}};
      return {childId:b.childId,production:{...p,key:productionKey,objective:c.objective,admission:()=>{current(false);return {registryDigest:p.spec.registryDigest,purposes:p.purposes,sourceAllowed:true,retainAllowed:true};},tokenizer,transport:createProductionTransport({deepseek:credentials?.deepseek??null},dependencies),authorizeSelection:()=>current(false),finalizeAuthority:async binding=>{current(true);same(binding.specDigest,hash(canonical(p.spec)));finalizeTeachingAuthority(p.authorityPath,p.spec,p.spec.jobId,binding.committedHead);}},
        audit:{runtimeRoot:a.runtimeRoot,authorityPath:a.authorityPath,key:auditKey,transport:createQaTransport({deepseek:credentials?.deepseek??null,together:credentials?.together??null},dependencies),bind:deterministicTeachingAuditBinding(a.template,sourceAdmission)},
        archive:{readerBuildDigest:b.archive.readerBuildDigest,admission:archiveAdmission,seal:async context=>{current(true);finalizeTeachingAuthority(a.authorityPath,context.spec,context.spec.auditId,context.committedHead);return sealTeachingQaArchive(context,{approvedTrainingRoot:c.approvedTrainingRoot,runtimeRoot:a.runtimeRoot,authorityPath:a.authorityPath,key:auditKey,readerBuildDigest:b.archive.readerBuildDigest,checkMetadata:()=>metadata(context.child),admission:archiveAdmission});}}};
    });
    host=openTeachingCycleHost({cycle:{...c.cycle,approvedTrainingRoot:c.approvedTrainingRoot,key:keyFor('cycle'),mode,admission:()=>{current(false);return {planDigest:c.cycle.spec.planDigest,sourceAllowed:true,retainAllowed:true};},realPlanAdmission:({active})=>current(active)},plan:c.plan,owner,children,checkChildMetadata:metadata});
    returned=true;return {ports:host.ports,close:()=>{try{host.close();}finally{wipe();}}};
  }finally{if(!returned)wipe();}
}

export async function executeTeachingWorker(c,key,credentials,owner,action,dependencies={}){
  if(!['run','resume','verify-report'].includes(action))stop('TCH_ACTION');checkRootAdmission(c,action!=='verify-report',action==='resume'?'RESUME':null);
  const mode=action==='verify-report'?'inspect':fs.existsSync(path.join(c.cycle.runtimeRoot,'teaching-cycle.sqlite'))?'resume':'create';
  if(action==='resume'&&mode!=='resume')stop('TCH_RESUME_MISSING');
  const host=openTrustedTeachingHost(c,key,credentials,owner,mode,dependencies);
  try{if(action!=='verify-report')await runTeachingCycleCommand({version:'TeachingCycleCommand/0.2',command:'run',spec:c.cycle.spec},host.ports);
    const report=action==='verify-report'?await runTeachingCycleCommand({version:'TeachingCycleCommand/0.2',command:'verify-report',spec:c.cycle.spec},host.ports):teachingCycleReport(host.ports.store,host.ports.openIndex,host.ports.checkChildMetadata);
    return {version:'TeachingNativeResult/0.1',cycleId:c.cycle.spec.cycleId,action,report};
  }finally{host.close();}
}
