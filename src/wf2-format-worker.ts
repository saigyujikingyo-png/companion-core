import { readFileSync } from 'node:fs';
import { dirname,isAbsolute,relative,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash,oneOf,parseJson,shape,stop,text,Wf1Error } from './wf1-json.ts';
import { HostAuthority,privateRoot } from './wf1-storage.ts';
import { TeacherProvider } from './wf1-provider.ts';
import { FORMAT_PROFILE_DIGEST,FORMAT_RESERVE_MICRO_USD,FormatProbe,validateFormatSpec,WF2_FORMAT } from './wf2-format.ts';

export const FORMAT_BUILD_FILES=['wf2-format.ts','wf2-format-worker.ts','wf1-types.ts','wf1-json.ts','wf1-contract.ts','wf1-verifier.ts','wf1-storage.ts','wf1-provider.ts','wf1-usage-diagnostic.ts','corpus-response-policy.ts','wf2-teacher-policy.ts','wf2-strict-data.ts','wf2-fixed-slots.ts','wf2-named-data.ts','wf2-together-pilot.ts','wf2-unit-pilot.ts','wf2-response-diagnostic.ts','runtime.ts','validation.ts'] as const;
export function formatBuildDigest():string {return hash(Buffer.concat(FORMAT_BUILD_FILES.flatMap(name=>[Buffer.from(name+'\0'),readFileSync(new URL(name,import.meta.url))])));}
export function describeFormatWorker(){return {version:'wf2-format-worker-description/1',buildDigest:formatBuildDigest(),profileDigest:FORMAT_PROFILE_DIGEST,
  command:'node src/wf2-format-worker.ts',runtime:'Node >=24.16 <25, native TypeScript stripping; no loader or install',
  stdinFields:['version','action','runtimeRoot','authorityPath','expectedHead','spec','custodyKeyBase64','credentials'],actions:['prepare','run','inspect','pause','cancel'],
  credentialsFields:['deepseek'],custodyKey:'32 random bytes as canonical base64; anonymous stdin from trusted launcher only',
  specSchema:{schemaVersion:'wf2-format/1',fields:['id','createdAt','expiresAt','sourceDigest','profileDigest']},
  authoritySchema:{schemaVersion:'wf1-host/1',fields:['campaignId','revision','runtimeId','status','expiresAt','head','rights'],statuses:['ACTIVE','PAUSED','REVOKED'],rights:['seal','coordinate','generate','review','retain']},
  profile:WF2_FORMAT,reservationMicroUsdPerCall:FORMAT_RESERVE_MICRO_USD,reservationMicroUsdAllCalls:6*FORMAT_RESERVE_MICRO_USD,
  run:'NEW_RUN_ONLY_NO_RESUME_NO_RETRIES',inspect:'READ_ONLY_NO_DECRYPT_RECORDED_CLAIMS_ONLY',control:'SEPARATE_TRUSTED_PROCESS_AUTHORITY_CHANGE; active watcher aborts locally, remote cancellation unknown',
  stdinLifecycle:'ONE_BOOTSTRAP_DOCUMENT_TO_EOF; EOF commits input and is not live owner disconnect',
  continue:'PRESELECTED_CASES_AFTER_FORMAT_FAILURE_ONLY',stop:'UNKNOWN_USAGE_TRANSPORT_AUTHORITY_TIME_BUDGET_MODEL_OR_PROVIDER_FAILURE',
  stdout:'ONE_ALLOWLISTED_JSON_NO_BODY_REFS_PATHS_PRIVATE_IDS_OR_CREDENTIALS',operationalVersion:'wf2-format-operational/1',
  statuses:['PREPARED_NOT_STARTED','ACTIVE','COMPLETED','STOPPED','PAUSED','REVOKED','RECONCILE_REQUIRED','RECORDED_CLAIMS_ONLY','REFUSED_OR_STOPPED'],
  teachingData:'NOT_GENERATED',studentInference:'NOT_RUN',studentTraining:'NOT_RUN'};}
export async function formatWorkerMain(raw:string):Promise<unknown>{
  const b=shape(parseJson(raw),['version','action','runtimeRoot','authorityPath','expectedHead','spec','custodyKeyBase64','credentials']);if(b.version!==1)stop('WF2_VERSION');
  const action=oneOf(b.action,['prepare','run','inspect','pause','cancel']),spec=validateFormatSpec(b.spec);if(spec.sourceDigest!==formatBuildDigest())stop('WF2_BUILD_MISMATCH');
  const root=privateRoot(text(b.runtimeRoot,4096)),authorityPath=text(b.authorityPath,4096);privateRoot(dirname(authorityPath));
  const rel=relative(root,authorityPath);if(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))stop('WF2_AUTHORITY_PATH');
  const host=new HostAuthority(authorityPath,spec.id),a=host.read(Date.now(),action==='prepare'||action==='run');if(b.expectedHead!==a.head)stop('WF2_HEAD_MISMATCH');
  const credentials=shape(b.credentials,['deepseek']);if(credentials.deepseek!==null)text(credentials.deepseek,4096);
  const encoded=text(b.custodyKeyBase64,64),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)stop('WF2_KEY');let probe:FormatProbe|undefined;
  try{
    if(action==='pause'||action==='cancel'){host.control(action==='pause'?'PAUSED':'REVOKED');return {version:'wf2-format-operational/1',status:action==='pause'?'PAUSED':'REVOKED',apiCalls:0};}
    if(action==='inspect')return FormatProbe.inspect(root,authorityPath,spec,key);
    if(a.head!==null)stop('WF2_ALREADY_CONSUMED');if(Date.now()<spec.createdAt||Date.now()>=spec.expiresAt)stop('WF2_TIME');
    if(action==='prepare')return {version:'wf2-format-operational/1',status:'PREPARED_NOT_STARTED',apiCalls:0,sourceBound:true,profileBound:true,route:'NATIVE_DIRECT'};
    if(!credentials.deepseek)stop('WF2_CREDENTIAL_UNAVAILABLE');
    probe=FormatProbe.admit({root,authorityPath,spec,key,provider:new TeacherProvider({deepseek:credentials.deepseek as string,together:null})});return await probe.run();
  }finally{probe?.close();key.fill(0);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  if(process.argv.length===3&&process.argv[2]==='--describe')process.stdout.write(JSON.stringify(describeFormatWorker())+'\n');
  else {
    try{if(process.argv.length!==2)stop('WF2_ARGUMENTS');const chunks:Buffer[]=[];let bytes=0;for await(const part of process.stdin){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>32768)stop('WF2_STDIN_LIMIT');chunks.push(chunk);}
      const result=await formatWorkerMain(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));process.stdout.write(JSON.stringify(result)+'\n');
    }catch(e){process.stdout.write(JSON.stringify({version:'wf2-format-operational/1',status:'REFUSED_OR_STOPPED',code:e instanceof Wf1Error?e.code:'WF2_INTERNAL',teachingData:'NOT_GENERATED',studentInference:'NOT_RUN',studentTraining:'NOT_RUN'})+'\n');process.exitCode=1;}
  }
}
