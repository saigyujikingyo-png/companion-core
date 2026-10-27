import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical,copyJson,digest,hash,parseJson,shape,stop,text } from './wf1-json.ts';
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
    input:canonical({version:'CorpusTokenizerRequest/0.1',profile,tokenizerProfileDigest,rowDigest,user,assistant}),encoding:'utf8',timeout:30000,maxBuffer:16384,windowsHide:true,
    env});
  if(result.error||result.signal||result.status!==0||result.stderr.trim()!=='')stop('CP0_TOKENIZER_FAILED');
  const m=shape(parseJson(result.stdout,{bytes:16384,depth:8,nodes:128,stringBytes:4096}),['version','status','rowDigest','tokenizerProfileDigest','studentInputTokens','studentLossTokens','fullTokens','inputIdsDigest','fullIdsDigest','lossMaskDigest','lossPolicy','officialPipelineParity','actualTrainerParity','trainingReady']);
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
