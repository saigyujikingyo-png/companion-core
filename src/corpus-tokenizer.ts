import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical,copyJson,digest,hash,parseJson,shape,stop,text,Wf1Error } from './wf1-json.ts';
import { verifyFormal } from './wf1-verifier.ts';
import { artifactRef } from './wf1-contract.ts';
import { verifyCorpusManifest } from './corpus-manifest.ts';
import type { CommitPort } from './corpus-manifest.ts';
import { requireAdmission,validateHarvestSpec } from './corpus-types.ts';
import type { AdmissionPort,CorpusRow,SelectedReader } from './corpus-types.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import type { ArtifactRef } from './wf1-types.ts';

export type CorpusTokenizerProfile={version:'CorpusTokenizer/0.1';model:string;revision:string;assetRoot:string;tokenizerSha256:string;templateSha256:string;
  runtime:{python:string;tokenizers:string;jinja2:string;markupsafe:string};templatePolicy:'SFT_USER_ASSISTANT_NO_THINKING/1';addSpecialTokens:false;
  maxInputBytes:65536;maxTokens:65536;officialPipelineParity:'NOT_VALIDATED'};
export type CorpusTokenMeasurement={version:'CorpusTokenMeasurement/0.1';status:'LOCAL_PINNED_EXACT';rowDigest:string;tokenizerProfileDigest:string;
  studentInputTokens:string;studentLossTokens:string;fullTokens:string;inputIdsDigest:string;fullIdsDigest:string;lossMaskDigest:string;
  lossPolicy:'ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR';officialPipelineParity:'NOT_VALIDATED';actualTrainerParity:'NOT_RUN';trainingReady:false};
const WORKER_STAGES=['REQUEST_READ','REQUEST_PARSE','REQUEST_SCHEMA','PROFILE_BINDING','TEXT_BOUNDS','RUNTIME_VERSION',
  'ROOT_CANONICALITY','ROOT_SYMLINK','TOKENIZER_ASSET','TEMPLATE_ASSET','IMPORT_TOKENIZERS','IMPORT_TEMPLATE','LOAD_TOKENIZER',
  'TOKENIZER_SETTINGS','COMPILE_TEMPLATE','RENDER_PROMPT','RENDER_FULL','RENDER_BOUNDS','ENCODE_PROMPT','ENCODE_FULL','TOKEN_BOUNDS','PREFIX_MATCH','RESULT'] as const;
const WORKER_CODES=['VALIDATION_REJECTED','FILE_NOT_FOUND','ACCESS_DENIED','UNICODE_ERROR','PACKAGE_NOT_FOUND','IMPORT_ERROR','OS_ERROR','UNKNOWN'] as const;
const SPAWN_CODES=['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS'] as const;
export type CorpusTokenizerDiagnostic={version:'CorpusTokenizerDiagnostic/0.1';failure:'SPAWN_FAILED'|'TIMEOUT'|'OUTPUT_LIMIT'|'SIGNAL'|'WORKER_EXIT'|'STDERR_PRESENT';
  exitStatus:number|null;signal:'SIGTERM'|'SIGKILL'|'OTHER'|null;spawnCode:typeof SPAWN_CODES[number]|'UNKNOWN'|'NONE';
  stdout:{capturedBytes:number;sha256:string};stderr:{capturedBytes:number;sha256:string};
  worker:{version:'CorpusTokenizerFailure/0.2';stage:typeof WORKER_STAGES[number];code:typeof WORKER_CODES[number]}|null};
/** Project only fixed process metadata and validated worker enums. Never retain a path,
 * exception message, traceback, output prefix, prompt, profile, or spawn arguments. */
export function tokenizerProcessFailure(result:{status:number|null;signal:string|null;error?:{code?:string};stdout:Uint8Array;stderr:Uint8Array}):CorpusTokenizerDiagnostic|null {
  const stdout=Buffer.from(result.stdout),stderr=Buffer.from(result.stderr),error=result.error;
  const spawnCode=!error?'NONE':SPAWN_CODES.includes(error.code as typeof SPAWN_CODES[number])?error.code as typeof SPAWN_CODES[number]:'UNKNOWN';
  const failure=error?spawnCode==='ETIMEDOUT'?'TIMEOUT':spawnCode==='ENOBUFS'?'OUTPUT_LIMIT':'SPAWN_FAILED':result.signal?'SIGNAL':result.status!==0?'WORKER_EXIT':stderr.toString('utf8').trim()!==''?'STDERR_PRESENT':null;
  if(!failure)return null;let worker:CorpusTokenizerDiagnostic['worker']=null;
  if(result.status!==0&&stdout.length<=1024)try{
    const p=shape(parseJson(new TextDecoder('utf-8',{fatal:true}).decode(stdout),{bytes:1024,depth:2,nodes:8,stringBytes:64}),['version','stage','code']);
    if(p.version==='CorpusTokenizerFailure/0.2'&&WORKER_STAGES.includes(p.stage as typeof WORKER_STAGES[number])&&WORKER_CODES.includes(p.code as typeof WORKER_CODES[number]))worker=p as NonNullable<CorpusTokenizerDiagnostic['worker']>;
  }catch{/* Unrecognized output is not diagnostic authority; retain only its exact bytes/hash. */}
  return {version:'CorpusTokenizerDiagnostic/0.1',failure,exitStatus:Number.isSafeInteger(result.status)?result.status:null,
    signal:result.signal===null?null:result.signal==='SIGTERM'||result.signal==='SIGKILL'?result.signal:'OTHER',spawnCode,
    stdout:{capturedBytes:stdout.length,sha256:hash(stdout)},stderr:{capturedBytes:stderr.length,sha256:hash(stderr)},worker};
}
export class CorpusTokenizerFailure extends Wf1Error {
  readonly diagnostic:CorpusTokenizerDiagnostic;
  constructor(diagnostic:CorpusTokenizerDiagnostic){super('CP0_TOKENIZER_FAILED');this.diagnostic=diagnostic;}
}
export function validateTokenizerProfile(input:unknown):CorpusTokenizerProfile {
  const p=shape(copyJson(input),['version','model','revision','assetRoot','tokenizerSha256','templateSha256','runtime','templatePolicy','addSpecialTokens','maxInputBytes','maxTokens','officialPipelineParity']);
  if(p.version!=='CorpusTokenizer/0.1'||p.templatePolicy!=='SFT_USER_ASSISTANT_NO_THINKING/1'||p.addSpecialTokens!==false||p.maxInputBytes!==65536||p.maxTokens!==65536||p.officialPipelineParity!=='NOT_VALIDATED')stop('CP0_TOKENIZER_PROFILE');
  text(p.model,256);const revision=text(p.revision,64);if(!/^[a-f0-9]{40}$/.test(revision))stop('CP0_TOKENIZER_PROFILE');text(p.assetRoot,4096);if(!isAbsolute(p.assetRoot as string))stop('CP0_TOKENIZER_PROFILE');digest(p.tokenizerSha256);digest(p.templateSha256);
  const runtime=shape(p.runtime,['python','tokenizers','jinja2','markupsafe']);for(const version of Object.values(runtime))if(!/^\d+\.\d+\.\d+$/.test(text(version,32)))stop('CP0_TOKENIZER_PROFILE');return p as CorpusTokenizerProfile;
}
export function measureCorpusRow(row:CorpusRow,profileInput:unknown,pythonPath:string):CorpusTokenMeasurement {
  const profile=validateTokenizerProfile(profileInput);if(!isAbsolute(text(pythonPath,4096)))stop('CP0_TOKENIZER_RUNTIME');
  const own=copyJson(row) as unknown as CorpusRow;if(own.evidenceClass!=='EXACT_VERIFIED'||own.selectedTargetScope!=='EXACT_RATIONAL_TYPED_TARGET_ONLY'||verifyFormal({verifier:own.projection.tool,input:own.projection.input},own.projection.typedTarget).status!=='VERIFIED')stop('CP0_TOKENIZER_ROW');
  const user=canonical({tool:own.projection.tool,input:own.projection.input}),assistant=canonical(own.projection.typedTarget),rowDigest=hash(canonical(own)),tokenizerProfileDigest=hash(canonical(profile));
  if(Buffer.byteLength(user)+Buffer.byteLength(assistant)>profile.maxInputBytes)stop('CP0_TOKENIZER_LIMIT');
  const env:NodeJS.ProcessEnv={HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false',PYTHONDONTWRITEBYTECODE:'1'};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[name]!==undefined)env[name]=process.env[name];
  const result=spawnSync(pythonPath,['-I','-B',fileURLToPath(new URL('../workers/corpus/tokenizer.py',import.meta.url))],{
    input:canonical({version:'CorpusTokenizerRequest/0.1',profile,tokenizerProfileDigest,rowDigest,user,assistant}),encoding:null,timeout:30000,maxBuffer:16384,windowsHide:true,
    env});
  const diagnostic=tokenizerProcessFailure({status:result.status,signal:result.signal,...(result.error?{error:{code:(result.error as NodeJS.ErrnoException).code??'UNKNOWN'}}:{}),stdout:result.stdout??Buffer.alloc(0),stderr:result.stderr??Buffer.alloc(0)});
  if(diagnostic)throw new CorpusTokenizerFailure(diagnostic);
  const m=shape(parseJson(new TextDecoder('utf-8',{fatal:true}).decode(result.stdout),{bytes:16384,depth:8,nodes:128,stringBytes:4096}),['version','status','rowDigest','tokenizerProfileDigest','studentInputTokens','studentLossTokens','fullTokens','inputIdsDigest','fullIdsDigest','lossMaskDigest','lossPolicy','officialPipelineParity','actualTrainerParity','trainingReady']);
  if(m.version!=='CorpusTokenMeasurement/0.1'||m.status!=='LOCAL_PINNED_EXACT'||m.rowDigest!==rowDigest||m.tokenizerProfileDigest!==tokenizerProfileDigest||m.lossPolicy!=='ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR'||m.officialPipelineParity!=='NOT_VALIDATED'||m.actualTrainerParity!=='NOT_RUN'||m.trainingReady!==false)stop('CP0_TOKENIZER_RECEIPT');
  const count=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,5})$/.test(v)||BigInt(v)>BigInt(profile.maxTokens))stop('CP0_TOKENIZER_RECEIPT');return BigInt(v);};
  const input=count(m.studentInputTokens),loss=count(m.studentLossTokens),full=count(m.fullTokens);if(input===0n||loss===0n||input+loss!==full)stop('CP0_TOKENIZER_RECEIPT');
  digest(m.inputIdsDigest);digest(m.fullIdsDigest);digest(m.lossMaskDigest);return m as CorpusTokenMeasurement;
}
type MeasurementPorts={admission:AdmissionPort;reader:SelectedReader;commits:Pick<CommitPort,'load'>;pythonPath:string;now?:()=>number};
/** A separate immutable, encrypted receipt; the harvested manifest is never backfilled. */
export function measureCorpusManifest(specInput:unknown,manifestRef:ArtifactRef,profileInput:unknown,ports:MeasurementPorts&{output:ArtifactPort}) {
  const spec=validateHarvestSpec(specInput),profile=validateTokenizerProfile(profileInput),check=()=>requireAdmission(spec,ports.admission,'harvest',ports.now?.()??Date.now());check();
  const verified=verifyCorpusManifest(spec,manifestRef,ports),measurement=measureCorpusRow(verified.row,profile,ports.pythonPath);check();
  const record={version:'CorpusTokenReceipt/0.1',manifestRef:artifactRef(copyJson(manifestRef)),profile,measurement},bytes=canonical(record),measurementRef=ports.output.put('corpus-token-measurement',bytes);check();
  if(!ports.output.read(measurementRef).equals(Buffer.from(bytes)))stop('CP0_READBACK');check();return {measurementRef,measurement};
}
/** New-process verification recomputes IDs from the committed row, not saved token counts. */
export function verifyCorpusTokenMeasurement(specInput:unknown,manifestRef:ArtifactRef,measurementRef:ArtifactRef,profileInput:unknown,ports:MeasurementPorts):CorpusTokenMeasurement {
  const spec=validateHarvestSpec(specInput),profile=validateTokenizerProfile(profileInput),check=()=>requireAdmission(spec,ports.admission,'verify',ports.now?.()??Date.now());check();
  const ref=artifactRef(copyJson(measurementRef));if(ref.kind!=='corpus-token-measurement'||ref.partition!=='train')stop('CP0_TOKENIZER_RECEIPT');
  const bytes=ports.reader.read(ref);check();if(!Buffer.isBuffer(bytes)||bytes.length>262144)stop('CP0_TOKENIZER_RECEIPT');
  const record=shape(parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),['version','manifestRef','profile','measurement']);
  if(record.version!=='CorpusTokenReceipt/0.1'||canonical(record.manifestRef)!==canonical(artifactRef(copyJson(manifestRef)))||canonical(record.profile)!==canonical(profile))stop('CP0_TOKENIZER_RECEIPT');
  const verified=verifyCorpusManifest(spec,manifestRef,ports),actual=measureCorpusRow(verified.row,profile,ports.pythonPath);check();
  if(canonical(actual)!==canonical(record.measurement))stop('CP0_TOKENIZER_RECEIPT');return actual;
}
