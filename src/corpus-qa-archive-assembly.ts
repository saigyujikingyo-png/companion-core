import { createCipheriv,hkdfSync,randomBytes,randomUUID } from 'node:crypto';
import { closeSync,fsyncSync,openSync,readdirSync,writeFileSync } from 'node:fs';
import { isAbsolute,join,relative,sep } from 'node:path';
import { canonical,digest,hash,id,stop } from './wf1-json.ts';
import { privateRoot } from './wf1-storage.ts';
import { bindTrainingRoot } from './wf2-training-root.ts';
import { assembleScopedIndexes } from './corpus-qa-index.ts';
import { archiveCapability,archiveFile,QA_INDEX_ARCHIVE_PROFILE_DIGEST,QA_INDEX_ARCHIVE_SCOPE } from './corpus-qa-index-archive.ts';
import type { QualityIndexArchive } from './corpus-qa-index-archive.ts';

const within=(parent:string,child:string)=>{const rel=relative(parent,child);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
/** Private encrypted metadata output. A fresh empty destination and explicit input
 * order are required. Interrupted chunks remain encrypted, uncommitted evidence. */
export function writeQualityArchiveAssembly(input:{approvedTrainingRoot:string;runtimeRoot:string;assemblyId:string;key:Uint8Array;readerBuildDigest:string;purposeDigest:string;readers:QualityIndexArchive[]}) {
  const o={...input,readers:[...input.readers]};id(o.assemblyId);digest(o.purposeDigest);digest(o.readerBuildDigest);
  if(o.readers.length<1||o.readers.length>8||new Set(o.readers).size!==o.readers.length)stop('CQA_ARCHIVE_INPUTS');
  const caps=o.readers.map(archiveCapability),guard=()=>{for(const cap of caps)cap.check();};guard();
  const views=caps.map(cap=>cap.read()),first=views[0]!.descriptor;
  for(const v of views){const d=v.descriptor;if(d.readerBuildDigest!==o.readerBuildDigest||d.archiveProfileDigest!==QA_INDEX_ARCHIVE_PROFILE_DIGEST||d.spec.purposeDigest!==o.purposeDigest||d.spec.studentTargetDigest!==first.spec.studentTargetDigest||d.source.tokenizerProfileDigest!==first.source.tokenizerProfileDigest||d.spec.baselineDigest!==first.spec.baselineDigest||d.spec.auditTargetBaselineDigest!==first.spec.auditTargetBaselineDigest)stop('CQA_ARCHIVE_INCOMPATIBLE');}
  const root=bindTrainingRoot(o.approvedTrainingRoot,o.runtimeRoot).runtimeRoot;
  for(const cap of caps)if(within(cap.runtimeRoot,root)||within(root,cap.runtimeRoot))stop('CQA_ARCHIVE_DESTINATION');
  if(readdirSync(root).length)stop('CQA_ARCHIVE_DESTINATION');
  if(!(o.key instanceof Uint8Array)||o.key.length!==32)stop('CQA_ARCHIVE_KEY');guard();const key=Buffer.from(o.key);
  try{
    const assembly=assembleScopedIndexes(views.map(v=>v.index),views.map(v=>v.descriptor.indexDigest));
    const records=new Map(views.flatMap(v=>{const eligible=new Map(v.eligibleRows.map(r=>[r.caseId,r.verdictRef]));return v.selection.entries.map(e=>[canonical({jobId:v.descriptor.source.jobId,unitId:e.unit.unitId}),{e,verdictRef:eligible.get(e.caseId),descriptorDigest:v.descriptorDigest}] as const);}));
    const rows=assembly.rows.filter(r=>r.eligibleForNextExport&&records.get(canonical({jobId:r.sourceJobId,unitId:r.unitId}))?.verdictRef).map(r=>{const source=records.get(canonical({jobId:r.sourceJobId,unitId:r.unitId}))!;return {...r,caseId:source.e.caseId,verdictRef:source.verdictRef!,descriptorDigest:source.descriptorDigest,tokenReceiptRef:source.e.tokenReceiptRef,measurement:source.e.measurement};});
    const tokens=(split:'train'|'dev')=>{const selected=rows.filter(r=>r.split===split);return {rows:selected.length,studentInputTokens:selected.reduce((n,r)=>n+Number(r.measurement.studentInputTokens),0),studentLossTokens:selected.reduce((n,r)=>n+Number(r.measurement.studentLossTokens),0),fullTokens:selected.reduce((n,r)=>n+Number(r.measurement.fullTokens),0)};};
    // One derivation per artifact, immediately cleared; no broker retains a key.
    const seal=(kind:string,artifactId:string,value:unknown)=>{
      const plain=Buffer.from(canonical(value));if(!plain.length||plain.length>262144)stop('CQA_ARCHIVE_LIMIT');
      const derived=Buffer.from(hkdfSync('sha256',key,o.assemblyId,'qa-index-archive-assembly/0.1',32));
      try{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derived,nonce);cipher.setAAD(Buffer.from(canonical({version:'QaArchiveAssemblyCipher/0.1',assemblyId:o.assemblyId,artifactId,kind})));return Buffer.concat([nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}finally{plain.fill(0);derived.fill(0);}
    };
    const outputs:{path:string;digest:string}[]=[];
    const destination=()=>{bindTrainingRoot(o.approvedTrainingRoot,root);privateRoot(root);const expected=new Set(outputs.map(o=>o.path));if(readdirSync(root).some(name=>!expected.has(join(root,name))))stop('CQA_ARCHIVE_DESTINATION');for(const out of outputs)if(hash(archiveFile(out.path,262172))!==out.digest)stop('CQA_ARCHIVE_CHANGED');};
    const write=(name:string,bytes:Buffer)=>{
      guard();destination();const path=join(root,name),fd=openSync(path,'wx',0o600);
      try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
      outputs.push({path,digest:hash(bytes)});guard();destination();
    };
    const chunks=[];for(let offset=0;offset<rows.length;offset+=32){const artifactId=randomUUID(),kind='qa-archive-assembly-chunk',value={version:'QaArchiveAssemblyChunk/0.1',assemblyId:o.assemblyId,index:offset/32,rows:rows.slice(offset,offset+32)},bytes=seal(kind,artifactId,value);write(artifactId+'.bin',bytes);chunks.push({artifactId,kind,bytes:bytes.length,digest:hash(bytes),rows:value.rows.length});}
    const totals={train:tokens('train'),dev:tokens('dev')};
    const manifest={version:'QaArchiveAssemblySelectionManifest/0.1',assemblyId:o.assemblyId,archiveProfileDigest:QA_INDEX_ARCHIVE_PROFILE_DIGEST,readerBuildDigest:o.readerBuildDigest,purposeDigest:o.purposeDigest,scope:QA_INDEX_ARCHIVE_SCOPE,comparison:'EXACT_NORMALIZED_PROMPT_ONLY',ordering:'EXPLICIT_INPUT_ORDER',inputs:views.map(v=>({descriptorDigest:v.descriptorDigest,indexDigest:v.descriptor.indexDigest,coldReceiptRawDigest:v.descriptor.coldReceiptRawDigest,source:v.descriptor.source,auditId:v.descriptor.spec.auditId,auditSpecDigest:v.descriptor.specDigest,selectionDigest:v.descriptor.spec.selectionDigest,manifestRef:v.descriptor.manifestRef,sourceBuildDigest:v.descriptor.spec.buildDigest,generationTargetDigest:v.descriptor.spec.baselineDigest,auditTargetDigest:v.descriptor.spec.auditTargetBaselineDigest,studentTargetDigest:v.descriptor.spec.studentTargetDigest,purposeDigest:v.descriptor.spec.purposeDigest})),chunks,totals,selectedRows:rows.length,indexedRows:assembly.rows.length,evidenceClass:'MODEL_OPINION',factualTruth:'UNKNOWN',falseAcceptanceRate:'UNKNOWN',packing:'OFF',tokenMeasurement:'INHERITED_NO_RETOKENIZATION',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'};
    const manifestDigest=hash(canonical(manifest)),bytes=seal('qa-archive-assembly-manifest',o.assemblyId,manifest);
    write('manifest.pending.bin',bytes);guard();destination();
    // Exclusive final creation never overwrites a concurrently created file.
    // A partial final file is not a valid commit: its complete GCM/hash must verify.
    // Keep the pending copy as encrypted interruption evidence, never auto-recover.
    write('manifest.bin',bytes);
    return {version:'QaArchiveAssemblyReceipt/0.1',manifestDigest,commitDigest:hash(bytes),inputCount:views.length,indexedRows:assembly.rows.length,selectedRows:rows.length,totals,evidenceClass:'MODEL_OPINION',factualTruth:'UNKNOWN',falseAcceptanceRate:'UNKNOWN',trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED'};
  }finally{key.fill(0);}
}
