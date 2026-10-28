import { createCipheriv,createDecipheriv,hkdfSync,randomBytes,randomUUID } from 'node:crypto';
import { closeSync,fsyncSync,openSync,readdirSync,writeFileSync } from 'node:fs';
import { isAbsolute,join,relative,sep } from 'node:path';
import { canonical,copyJson,digest,hash,id,integer,list,shape,stop,unique } from './wf1-json.ts';
import { privateRoot } from './wf1-storage.ts';
import { bindTrainingRoot } from './wf2-training-root.ts';
import { assembleScopedIndexes } from './corpus-qa-index.ts';
import { archiveCapability,archiveFile,QA_INDEX_ARCHIVE_PROFILE_DIGEST,QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST,QA_INDEX_ARCHIVE_SCOPE } from './corpus-qa-index-archive.ts';
import type { QualityIndexArchive,VerifiedQaIndexView } from './corpus-qa-index-archive.ts';
import { legacyJson } from './corpus-qa-legacy-f1.ts';

const within=(parent:string,child:string)=>{const rel=relative(parent,child);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
export const QA_ARCHIVE_ASSEMBLY_PROFILE_DIGEST=hash(canonical({version:'QaArchiveAssembly/0.2',inputProfiles:[QA_INDEX_ARCHIVE_PROFILE_DIGEST,QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST],scope:QA_INDEX_ARCHIVE_SCOPE,maxInputs:8,maxRows:192,chunkRows:32,rubricContentDigest:'UNKNOWN_NOT_INDEXED'}));
const evidence={evidenceClass:'MODEL_OPINION',factualTruth:'UNKNOWN',falseAcceptanceRate:'UNKNOWN',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'} as const;
const same=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))stop('CQA_ASSEMBLY_BINDING');};
const registered=(readers:QualityIndexArchive[])=>{if(readers.length<1||readers.length>8||new Set(readers).size!==readers.length)stop('CQA_ARCHIVE_INPUTS');return readers.map(archiveCapability);};
function recompute(views:VerifiedQaIndexView[],readerBuildDigest:string,purposeDigest:string){
  const first=views[0]!.descriptor;
  for(const v of views){const d=v.descriptor;if(d.readerBuildDigest!==readerBuildDigest||d.archiveProfileDigest!==(d.legacyProfile==='QA_F1'?QA_INDEX_ARCHIVE_PROFILE_DIGEST:QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST)||d.spec.purposeDigest!==purposeDigest||d.spec.studentTargetDigest!==first.spec.studentTargetDigest||d.source.tokenizerProfileDigest!==first.source.tokenizerProfileDigest||d.spec.baselineDigest!==first.spec.baselineDigest||d.spec.auditTargetBaselineDigest!==first.spec.auditTargetBaselineDigest)stop('CQA_ARCHIVE_INCOMPATIBLE');}
  // In particular, overlapping old-failed/new QA inputs of one source are not
  // reconciled row-by-row. assembleScopedIndexes rejects duplicate job/unit IDs.
  const assembly=assembleScopedIndexes(views.map(v=>v.index),views.map(v=>v.descriptor.indexDigest));
  const records=new Map(views.flatMap(v=>{const eligible=new Map(v.eligibleRows.map(r=>[r.caseId,r.verdictRef]));return v.selection.entries.map(e=>[canonical({jobId:v.descriptor.source.jobId,unitId:e.unit.unitId}),{e,verdictRef:eligible.get(e.caseId),descriptorDigest:v.descriptorDigest}] as const);}));
  const rows=assembly.rows.filter(r=>r.eligibleForNextExport&&records.get(canonical({jobId:r.sourceJobId,unitId:r.unitId}))?.verdictRef).map(r=>{const source=records.get(canonical({jobId:r.sourceJobId,unitId:r.unitId}))!;return {...r,caseId:source.e.caseId,verdictRef:source.verdictRef!,descriptorDigest:source.descriptorDigest,tokenReceiptRef:source.e.tokenReceiptRef,measurement:source.e.measurement};});
  const tokens=(split:'train'|'dev')=>{const selected=rows.filter(r=>r.split===split);return {rows:selected.length,studentInputTokens:selected.reduce((n,r)=>n+Number(r.measurement.studentInputTokens),0),studentLossTokens:selected.reduce((n,r)=>n+Number(r.measurement.studentLossTokens),0),fullTokens:selected.reduce((n,r)=>n+Number(r.measurement.fullTokens),0)};};
  const inputs=views.map(v=>({descriptorDigest:v.descriptorDigest,indexDigest:v.descriptor.indexDigest,coldReceiptRawDigest:v.descriptor.coldReceiptRawDigest,source:v.descriptor.source,auditId:v.descriptor.spec.auditId,auditSpecDigest:v.descriptor.specDigest,selectionDigest:v.descriptor.spec.selectionDigest,manifestRef:v.descriptor.manifestRef,legacyProfile:v.descriptor.legacyProfile,archiveProfileDigest:v.descriptor.archiveProfileDigest,sourceBuildDigest:v.descriptor.spec.buildDigest,sourceProfileDigest:v.descriptor.spec.profileDigest,generationTargetDigest:v.descriptor.spec.baselineDigest,auditTargetDigest:v.descriptor.spec.auditTargetBaselineDigest,studentTargetDigest:v.descriptor.spec.studentTargetDigest,purposeDigest:v.descriptor.spec.purposeDigest,rubric:v.rubric}));
  return {rows,fields:{archiveProfileDigest:QA_ARCHIVE_ASSEMBLY_PROFILE_DIGEST,readerBuildDigest,purposeDigest,scope:QA_INDEX_ARCHIVE_SCOPE,comparison:'EXACT_NORMALIZED_PROMPT_ONLY',ordering:'EXPLICIT_INPUT_ORDER',inputs,totals:{train:tokens('train'),dev:tokens('dev')},selectedRows:rows.length,indexedRows:assembly.rows.length,...evidence,packing:'OFF',tokenMeasurement:'INHERITED_NO_RETOKENIZATION'}};
}
type AssemblyFields=ReturnType<typeof recompute>['fields'];
const receiptFor=(assemblyId:string,fields:AssemblyFields,manifestDigest:string,commitDigest:string)=>({version:'QaArchiveAssemblyReceipt/0.2' as const,assemblyId,archiveProfileDigest:QA_ARCHIVE_ASSEMBLY_PROFILE_DIGEST,readerBuildDigest:fields.readerBuildDigest,purposeDigest:fields.purposeDigest,inputDescriptorDigests:fields.inputs.map(i=>i.descriptorDigest),manifestDigest,commitDigest,inputCount:fields.inputs.length,indexedRows:fields.indexedRows,selectedRows:fields.selectedRows,totals:fields.totals,...evidence});
export type QaArchiveAssemblyReceipt=ReturnType<typeof receiptFor>;
/** Private encrypted metadata output. A fresh empty destination and explicit input
 * order are required. Interrupted chunks remain encrypted, uncommitted evidence. */
export function writeQualityArchiveAssembly(input:{approvedTrainingRoot:string;runtimeRoot:string;assemblyId:string;key:Uint8Array;readerBuildDigest:string;purposeDigest:string;readers:QualityIndexArchive[]}) {
  const o={...input,readers:[...input.readers]};id(o.assemblyId);digest(o.purposeDigest);digest(o.readerBuildDigest);
  const caps=registered(o.readers),guard=()=>{for(const cap of caps)cap.check();};guard();
  const views=caps.map(cap=>cap.read()),{rows,fields}=recompute(views,o.readerBuildDigest,o.purposeDigest);
  const root=bindTrainingRoot(o.approvedTrainingRoot,o.runtimeRoot).runtimeRoot;
  for(const cap of caps)if(within(cap.runtimeRoot,root)||within(root,cap.runtimeRoot))stop('CQA_ARCHIVE_DESTINATION');
  if(readdirSync(root).length)stop('CQA_ARCHIVE_DESTINATION');
  if(!(o.key instanceof Uint8Array)||o.key.length!==32)stop('CQA_ARCHIVE_KEY');guard();const key=Buffer.from(o.key);
  try{
    // One derivation per artifact, immediately cleared; no broker retains a key.
    const seal=(kind:string,artifactId:string,value:unknown)=>{
      const plain=Buffer.from(canonical(value));if(!plain.length||plain.length>262144)stop('CQA_ARCHIVE_LIMIT');
      const derived=Buffer.from(hkdfSync('sha256',key,o.assemblyId,'qa-index-archive-assembly/0.2',32));
      try{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derived,nonce);cipher.setAAD(Buffer.from(canonical({version:'QaArchiveAssemblyCipher/0.2',assemblyId:o.assemblyId,artifactId,kind})));return Buffer.concat([nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}finally{plain.fill(0);derived.fill(0);}
    };
    const outputs:{path:string;digest:string}[]=[];
    const destination=()=>{bindTrainingRoot(o.approvedTrainingRoot,root);privateRoot(root);const expected=new Set(outputs.map(o=>o.path));if(readdirSync(root).some(name=>!expected.has(join(root,name))))stop('CQA_ARCHIVE_DESTINATION');for(const out of outputs)if(hash(archiveFile(out.path,262172))!==out.digest)stop('CQA_ARCHIVE_CHANGED');};
    const write=(name:string,bytes:Buffer)=>{
      guard();destination();const path=join(root,name),fd=openSync(path,'wx',0o600);
      try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
      outputs.push({path,digest:hash(bytes)});guard();destination();
    };
    const chunks=[];for(let offset=0;offset<rows.length;offset+=32){const artifactId=randomUUID(),kind='qa-archive-assembly-chunk',value={version:'QaArchiveAssemblyChunk/0.2',assemblyId:o.assemblyId,index:offset/32,rows:rows.slice(offset,offset+32)},bytes=seal(kind,artifactId,value);write(artifactId+'.bin',bytes);chunks.push({artifactId,kind,bytes:bytes.length,digest:hash(bytes),rows:value.rows.length});}
    const manifest={version:'QaArchiveAssemblySelectionManifest/0.2',assemblyId:o.assemblyId,...fields,chunks};
    const manifestDigest=hash(canonical(manifest)),bytes=seal('qa-archive-assembly-manifest',o.assemblyId,manifest);
    write('manifest.pending.bin',bytes);guard();destination();
    // Exclusive final creation never overwrites a concurrently created file.
    // A partial final file is not a valid commit: its complete GCM/hash must verify.
    // Keep the pending copy as encrypted interruption evidence, never auto-recover.
    write('manifest.bin',bytes);
    guard();return receiptFor(o.assemblyId,fields,manifestDigest,hash(bytes));
  }finally{key.fill(0);}
}

export type QaArchiveAssemblyReadGrant={version:'QaArchiveAssemblyReadGrant/0.1';grantId:string;revision:number;receiptDigest:string;purposeDigest:string;status:'ACTIVE'|'REVOKED';readAllowed:boolean;retainAllowed:boolean;validFrom:number;expiresAt:number;scope:typeof QA_INDEX_ARCHIVE_SCOPE};
export type QaArchiveAssemblyReadOptions={approvedTrainingRoot:string;runtimeRoot:string;assemblyId:string;key:Uint8Array;readerBuildDigest:string;purposeDigest:string;readers:QualityIndexArchive[];receipt:QaArchiveAssemblyReceipt;receiptDigest:string;admission:()=>QaArchiveAssemblyReadGrant;now?:()=>number};
/** Cold metadata verifier. The host must authenticate the successfully returned
 * receipt and pin its canonical digest independently; files do not prove success.
 * No row accessor, arbitrary artifact read, execution store or transport exists. */
export function openQualityArchiveAssembly(input:QaArchiveAssemblyReadOptions){
  const o={...input,readers:[...input.readers]},receipt=shape(copyJson(o.receipt),['version','assemblyId','archiveProfileDigest','readerBuildDigest','purposeDigest','inputDescriptorDigests','manifestDigest','commitDigest','inputCount','indexedRows','selectedRows','totals',...Object.keys(evidence)]);
  id(o.assemblyId);for(const d of [o.receiptDigest,o.readerBuildDigest,o.purposeDigest])digest(d);
  if(receipt.version!=='QaArchiveAssemblyReceipt/0.2'||hash(canonical(receipt))!==o.receiptDigest||receipt.assemblyId!==o.assemblyId||receipt.archiveProfileDigest!==QA_ARCHIVE_ASSEMBLY_PROFILE_DIGEST||receipt.readerBuildDigest!==o.readerBuildDigest||receipt.purposeDigest!==o.purposeDigest)stop('CQA_ASSEMBLY_RECEIPT');
  digest(receipt.manifestDigest);digest(receipt.commitDigest);const expectedInputs=list(receipt.inputDescriptorDigests,8,1).map(digest);unique(expectedInputs);integer(receipt.inputCount,1,8);integer(receipt.indexedRows,1,1536);integer(receipt.selectedRows,0,Number(receipt.indexedRows));
  if(receipt.inputCount!==expectedInputs.length||receipt.inputCount!==o.readers.length)stop('CQA_ASSEMBLY_RECEIPT');
  const caps=registered(o.readers);let key:Buffer|undefined,closed=false,lastTime=0,identity:string|undefined;
  const close=()=>{closed=true;key?.fill(0);key=undefined;};
  const admission=()=>{
    if(closed)stop('CQA_ASSEMBLY_CLOSED');const g=shape(copyJson(o.admission()),['version','grantId','revision','receiptDigest','purposeDigest','status','readAllowed','retainAllowed','validFrom','expiresAt','scope']),now=integer(o.now?.()??Date.now());
    if(closed)stop('CQA_ASSEMBLY_CLOSED');
    id(g.grantId);integer(g.revision,1);integer(g.validFrom);integer(g.expiresAt,Number(g.validFrom)+1);
    if(g.version!=='QaArchiveAssemblyReadGrant/0.1'||g.receiptDigest!==o.receiptDigest||g.purposeDigest!==o.purposeDigest||g.status!=='ACTIVE'||g.readAllowed!==true||g.retainAllowed!==true||g.scope!==QA_INDEX_ARCHIVE_SCOPE||now<lastTime||now<Number(g.validFrom)||now>=Number(g.expiresAt))stop('CQA_ASSEMBLY_ADMISSION');
    const current=canonical(g);if(identity!==undefined&&identity!==current)stop('CQA_ASSEMBLY_ADMISSION');identity=current;lastTime=now;
  };
  const guard=()=>{
    admission();
    for(const cap of caps)cap.check();
    const root=bindTrainingRoot(o.approvedTrainingRoot,o.runtimeRoot).runtimeRoot;
    for(const cap of caps)if(within(cap.runtimeRoot,root)||within(root,cap.runtimeRoot))stop('CQA_ARCHIVE_DESTINATION');
    // Source callbacks can consume the remaining lease or close/revoke us.
    // Re-read the clock and complete admission after all guarded work.
    admission();
  };
  const cipher=(name:string,expected:string,size?:number)=>{guard();const bytes=archiveFile(join(o.runtimeRoot,name),262172);if(hash(bytes)!==expected||size!==undefined&&bytes.length!==size)stop('CQA_ASSEMBLY_CIPHER');guard();return bytes;};
  const unseal=(bytes:Buffer,artifactId:string,kind:string)=>{
    guard();const derived=Buffer.from(hkdfSync('sha256',key!,o.assemblyId,'qa-index-archive-assembly/0.2',32));let plain:Buffer|undefined;
    try{const decipher=createDecipheriv('aes-256-gcm',derived,bytes.subarray(0,12));decipher.setAAD(Buffer.from(canonical({version:'QaArchiveAssemblyCipher/0.2',assemblyId:o.assemblyId,artifactId,kind})));decipher.setAuthTag(bytes.subarray(-16));plain=Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);guard();return legacyJson(plain.toString('utf8'));}finally{derived.fill(0);plain?.fill(0);}
  };
  const check=()=>{try{cipher('manifest.bin',String(receipt.commitDigest));}catch(error){close();throw error;}};
  try{guard();if(!(o.key instanceof Uint8Array)||o.key.length!==32)stop('CQA_ARCHIVE_KEY');key=Buffer.from(o.key);o.key=new Uint8Array(0);check();}catch(error){close();throw error;}
  const readVerifiedReceipt=():QaArchiveAssemblyReceipt=>{
    try{
      guard();const views=caps.map(cap=>{guard();const view=cap.read();guard();return view;});same(views.map(v=>v.descriptorDigest),expectedInputs);
      const {rows,fields}=recompute(views,o.readerBuildDigest,o.purposeDigest),manifest=shape(unseal(cipher('manifest.bin',String(receipt.commitDigest)),o.assemblyId,'qa-archive-assembly-manifest'),['version','assemblyId',...Object.keys(fields),'chunks']);
      if(hash(canonical(manifest))!==receipt.manifestDigest)stop('CQA_ASSEMBLY_MANIFEST');
      const chunks=list(manifest.chunks,48).map(c=>{const r=shape(c,['artifactId','kind','bytes','digest','rows']);if(typeof r.artifactId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.artifactId)||r.kind!=='qa-archive-assembly-chunk')stop('CQA_ASSEMBLY_CHUNK');integer(r.bytes,28,262172);integer(r.rows,1,32);digest(r.digest);return r;});unique(chunks.map(c=>String(c.artifactId)));
      same(manifest,{version:'QaArchiveAssemblySelectionManifest/0.2',assemblyId:o.assemblyId,...fields,chunks});
      if(chunks.length!==Math.ceil(rows.length/32))stop('CQA_ASSEMBLY_CHUNK');
      for(const [i,c]of chunks.entries()){
        const expected=rows.slice(i*32,(i+1)*32);if(c.rows!==expected.length)stop('CQA_ASSEMBLY_CHUNK');
        const chunk=unseal(cipher(c.artifactId+'.bin',String(c.digest),Number(c.bytes)),String(c.artifactId),'qa-archive-assembly-chunk');same(chunk,{version:'QaArchiveAssemblyChunk/0.2',assemblyId:o.assemblyId,index:i,rows:expected});
      }
      const verified=receiptFor(o.assemblyId,fields,String(receipt.manifestDigest),String(receipt.commitDigest));same(receipt,verified);
      // Detect concurrent change after any earlier artifact read, not just stat
      // equality. Pending files are never consulted or used for recovery.
      for(const c of chunks)cipher(c.artifactId+'.bin',String(c.digest),Number(c.bytes));check();guard();return verified;
    }catch(error){close();throw error;}
  };
  return Object.freeze({check,readVerifiedReceipt,close});
}
