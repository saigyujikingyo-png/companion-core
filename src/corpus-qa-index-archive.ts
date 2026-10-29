import { QA_V2_PROFILE_DIGEST,validateAuditSpec } from './corpus-qa-types.ts';
import { createDecipheriv,hkdfSync } from 'node:crypto';
import { existsSync,lstatSync,readFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical,copyJson,digest,hash,id,integer,list,oneOf,shape,stop } from './wf1-json.ts';
import { privateRoot } from './wf1-storage.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import { assembleScopedIndexes } from './corpus-qa-index.ts';
import type { ScopedDedupIndex } from './corpus-qa-index.ts';
import type { AuditSelection,AuditSource,AuditSpec } from './corpus-qa-types.ts';
import type { ScopedRef } from './corpus-production-types.ts';
import { legacyJson,legacyRef,legacySelection,legacySpec,QA_LEGACY_F1,QA_LEGACY_F2,QA_LEGACY_SCHEMA } from './corpus-qa-legacy-f1.ts';

export const QA_INDEX_ARCHIVE_SCOPE='QA_INDEX_MANIFEST_SELECTION_METADATA_ONLY';
export const QA_INDEX_ARCHIVE_PROFILE_DIGEST=hash(canonical({version:'QaIndexArchive/0.1',legacy:QA_LEGACY_F1,schema:QA_LEGACY_SCHEMA,scope:QA_INDEX_ARCHIVE_SCOPE,maxInputs:8,maxRows:192,chunkRows:32,terminal:['INDEX','MANIFEST']}));
export const QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST=hash(canonical({version:'QaIndexArchive/0.1',legacy:QA_LEGACY_F2,schema:QA_LEGACY_SCHEMA,scope:QA_INDEX_ARCHIVE_SCOPE,maxInputs:8,maxRows:192,chunkRows:32,terminal:['INDEX','MANIFEST']}));
export const QA_INDEX_ARCHIVE_V2_PROFILE_DIGEST=hash(canonical({version:'QaIndexArchive/0.2',qaProfile:QA_V2_PROFILE_DIGEST,schema:QA_LEGACY_SCHEMA,scope:QA_INDEX_ARCHIVE_SCOPE,maxInputs:8,maxRows:192,chunkRows:32,terminal:['INDEX','MANIFEST']}));
export const qaArchiveProfile=(profile:'QA_F1'|'QA_F2'|'QA_POLICY_V2')=>profile==='QA_F1'?QA_INDEX_ARCHIVE_PROFILE_DIGEST:profile==='QA_F2'?QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST:QA_INDEX_ARCHIVE_V2_PROFILE_DIGEST;
export type QaIndexArchiveDescriptor={
  version:'QaIndexArchiveDescriptor/0.1';legacyProfile:'QA_F1'|'QA_F2'|'QA_POLICY_V2';readerBuildDigest:string;archiveProfileDigest:string;
  spec:AuditSpec;specDigest:string;source:AuditSource;
  ledgerRawDigest:string;authorityRawDigest:string;authorityRevision:number;authorityStatus:'ACTIVE'|'PAUSED'|'REVOKED';
  committedHead:string;committedSequence:number;coldReceiptRawDigest:string;indexDigest:string;
  indexRef:ScopedRef;manifestRef:ScopedRef;selectionRef:ScopedRef;
};
export type QaIndexReadGrant={version:'QaIndexReadGrant/0.1';grantId:string;revision:number;descriptorDigest:string;purposeDigest:string;status:'ACTIVE'|'REVOKED';readAllowed:boolean;retainAllowed:boolean;validFrom:number;expiresAt:number;scope:typeof QA_INDEX_ARCHIVE_SCOPE};
export type QaIndexArchiveAdmission={grant:QaIndexReadGrant;sourceJobId:string;sourcePurposeDigest:string;parentGrantIds:string[];sourceAllowed:boolean;retainAllowed:boolean};
export type VerifiedQaIndexView={version:'VerifiedQaIndexView/0.1';descriptor:QaIndexArchiveDescriptor;descriptorDigest:string;index:ScopedDedupIndex;selection:AuditSelection;eligibleRows:{caseId:string;verdictRef:ScopedRef}[];rubric:{ref:ScopedRef|null;cipherDigest:string|null;rubricContentDigest:'UNKNOWN_NOT_INDEXED'}};
export type QualityIndexArchive={check:()=>void;readVerifiedView:()=>VerifiedQaIndexView;close:()=>void};
export type QaIndexArchiveOptions={approvedTrainingRoot:string;runtimeRoot:string;authorityPath:string;key:Uint8Array;descriptor:QaIndexArchiveDescriptor;descriptorDigest:string;readerBuildDigest:string;admission:()=>QaIndexArchiveAdmission;now?:()=>number};

const capabilities=new WeakMap<QualityIndexArchive,{check:()=>void;read:()=>VerifiedQaIndexView;runtimeRoot:string}>();
/** Assembly must retain this registered handle; a copied view grants no authority. */
export function archiveCapability(reader:QualityIndexArchive){const cap=capabilities.get(reader);if(!cap)stop('CQA_ARCHIVE_CAPABILITY');return cap;}

export function archiveFile(path:string,max:number):Buffer {
  privateRoot(dirname(path));const before=lstatSync(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(max))stop('CQA_ARCHIVE_FILE');
  const bytes=readFileSync(path),after=lstatSync(path,{bigint:true});
  if(bytes.length>max||BigInt(bytes.length)!==before.size||!after.isFile()||after.isSymbolicLink()||after.nlink!==1n||['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k as 'ino']!==after[k as 'ino']))stop('CQA_ARCHIVE_CHANGED');return bytes;
}
function noJournal(file:string){for(const suffix of ['-wal','-shm','-journal'])if(existsSync(file+suffix))stop('CQA_ARCHIVE_JOURNAL');}
function refKind(input:unknown,kind:string,bucket='meta'):ScopedRef {const ref=legacyRef(input);if(ref.ref.kind!==kind||ref.bucket!==bucket)stop('CQA_ARCHIVE_KIND');return ref;}
function same(a:unknown,b:unknown){if(canonical(a)!==canonical(b))stop('CQA_ARCHIVE_BINDING');}
function descriptor(input:unknown,expected:string,readerBuildDigest:string):QaIndexArchiveDescriptor {
  const d=shape(copyJson(input),['version','legacyProfile','readerBuildDigest','archiveProfileDigest','spec','specDigest','source','ledgerRawDigest','authorityRawDigest','authorityRevision','authorityStatus','committedHead','committedSequence','coldReceiptRawDigest','indexDigest','indexRef','manifestRef','selectionRef']);
  digest(expected);digest(readerBuildDigest);
  const profile=oneOf(d.legacyProfile,['QA_F1','QA_F2','QA_POLICY_V2']);
  if(hash(canonical(d))!==expected||d.version!=='QaIndexArchiveDescriptor/0.1'||d.archiveProfileDigest!==qaArchiveProfile(profile)||d.readerBuildDigest!==readerBuildDigest)stop('CQA_ARCHIVE_DESCRIPTOR');
  const spec=profile==='QA_POLICY_V2'?validateAuditSpec(d.spec):legacySpec(d.spec,profile);if(profile==='QA_POLICY_V2'&&spec.version!=='CorpusQualityAudit/0.2')stop('CQA_ARCHIVE_PROFILE');if(hash(canonical(spec))!==d.specDigest)stop('CQA_ARCHIVE_BINDING');
  for(const k of ['ledgerRawDigest','authorityRawDigest','committedHead','coldReceiptRawDigest','indexDigest'])digest(d[k]);integer(d.authorityRevision,spec.authorityRevision);oneOf(d.authorityStatus,['ACTIVE','PAUSED','REVOKED']);integer(d.committedSequence,3,2048);
  const s=shape(d.source,['jobId','specDigest','buildDigest','profileDigest','committedHead','ledgerFileDigest','authorityFileDigest','exportRef','exportDigest','registryDigest','purposeDigest','tokenizerProfileDigest','parentGrantIds']);id(s.jobId);for(const [k,v]of Object.entries(s))if(!['jobId','exportRef','parentGrantIds'].includes(k))digest(v);list(s.parentGrantIds,32).forEach(id);legacyRef(s.exportRef);
  refKind(d.indexRef,'corpus-qa-dedup-index');refKind(d.manifestRef,'corpus-qa-selection-manifest');refKind(d.selectionRef,'corpus-qa-selection');return d as QaIndexArchiveDescriptor;
}

/** Trusted host pins descriptorDigest and its loaded reader closure, independently
 * of the archive. Neither a producer's build claim nor a cold JSON is a signature. */
export function openQualityIndexArchive(input:QaIndexArchiveOptions):QualityIndexArchive {
  const o={...input},d=descriptor(o.descriptor,o.descriptorDigest,o.readerBuildDigest),ledger=join(o.runtimeRoot,'corpus-qa.sqlite');
  let key:Buffer|undefined,closed=false,lastTime=0,grantIdentity:string|undefined;
  const close=()=>{closed=true;key?.fill(0);key=undefined;};
  const admission=()=>{
    if(closed)stop('CQA_ARCHIVE_CLOSED');
    const a=shape(copyJson(o.admission()),['grant','sourceJobId','sourcePurposeDigest','parentGrantIds','sourceAllowed','retainAllowed']),now=integer(o.now?.()??Date.now());
    if(closed)stop('CQA_ARCHIVE_CLOSED');
    const g=shape(a.grant,['version','grantId','revision','descriptorDigest','purposeDigest','status','readAllowed','retainAllowed','validFrom','expiresAt','scope']);
    id(g.grantId);integer(g.revision,1);integer(g.validFrom);integer(g.expiresAt,Number(g.validFrom)+1);
    if(g.version!=='QaIndexReadGrant/0.1'||g.descriptorDigest!==o.descriptorDigest||g.purposeDigest!==d.spec.purposeDigest||g.status!=='ACTIVE'||g.readAllowed!==true||g.retainAllowed!==true||g.scope!==QA_INDEX_ARCHIVE_SCOPE||now<lastTime||now<Number(g.validFrom)||now>=Number(g.expiresAt)||a.sourceJobId!==d.source.jobId||a.sourcePurposeDigest!==d.source.purposeDigest||a.sourceAllowed!==true||a.retainAllowed!==true)stop('CQA_ARCHIVE_ADMISSION');
    same(a.parentGrantIds,d.source.parentGrantIds);const identity=canonical(g);if(grantIdentity!==undefined&&identity!==grantIdentity)stop('CQA_ARCHIVE_ADMISSION');grantIdentity=identity;lastTime=now;
  };
  const snapshot=()=>{
    requireTrainingBinding(o.approvedTrainingRoot,o.runtimeRoot,d.spec.storageBindingDigest,o.authorityPath);noJournal(ledger);
    if(hash(archiveFile(ledger,67108864))!==d.ledgerRawDigest||hash(archiveFile(o.authorityPath,16384))!==d.authorityRawDigest)stop('CQA_ARCHIVE_CHANGED');
    noJournal(ledger);
  };
  const check=()=>{try{admission();snapshot();admission();}catch(error){close();throw error;}};
  const read=(input:ScopedRef,kind:string,bucket='meta')=>{
    admission();const ref=refKind(input,kind,bucket),root=join(o.runtimeRoot,'objects',ref.bucket);privateRoot(root);
    const encrypted=archiveFile(join(root,'train-'+ref.ref.id+'.bin'),262172);
    if(encrypted.length!==ref.ref.bytes||hash(encrypted)!==ref.ref.digest)stop('CQA_ARCHIVE_CIPHER');
    admission();const derived=Buffer.from(hkdfSync('sha256',key!,d.spec.auditId+':'+ref.bucket,'wf1-train',32));
    let bytes:Buffer|undefined;
    try{const decipher=createDecipheriv('aes-256-gcm',derived,encrypted.subarray(0,12));decipher.setAAD(Buffer.from(canonical({campaignId:d.spec.auditId+':'+ref.bucket,partition:'train',id:ref.ref.id,kind})));decipher.setAuthTag(encrypted.subarray(-16));bytes=Buffer.concat([decipher.update(encrypted.subarray(12,-16)),decipher.final()]);admission();return legacyJson(bytes.toString('utf8'));}
    finally{derived.fill(0);bytes?.fill(0);}
  };
  try{
    // A denied current capability cannot copy or derive the caller's key.
    admission();if(!(o.key instanceof Uint8Array)||o.key.length!==32)stop('CQA_ARCHIVE_KEY');key=Buffer.from(o.key);o.key=new Uint8Array(0);check();
    const a=shape(legacyJson(archiveFile(o.authorityPath,16384).toString('utf8')),['schemaVersion','campaignId','revision','runtimeId','status','expiresAt','head','rights']);
    if(a.schemaVersion!=='wf1-host/1'||a.campaignId!==d.spec.auditId||a.runtimeId!==d.spec.runtimeId||a.revision!==d.authorityRevision||a.status!==d.authorityStatus||a.expiresAt!==d.spec.expiresAt||a.head!==d.committedHead)stop('CQA_ARCHIVE_AUTHORITY');
    for(const v of Object.values(shape(a.rights,['seal','coordinate','generate','review','retain'])))if(typeof v!=='boolean')stop('CQA_ARCHIVE_AUTHORITY');
  }catch(error){close();throw error;}
  const readVerifiedView=():VerifiedQaIndexView=>{
    let db:DatabaseSync|undefined;
    try{
      check();db=new DatabaseSync(ledger,{readOnly:true,timeout:0});db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
      const schemas=db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.sql);
      if(db.prepare('PRAGMA application_id').get()!.application_id!==1129406769||db.prepare('PRAGMA user_version').get()!.user_version!==1)stop('CQA_ARCHIVE_SCHEMA');same(schemas,[...QA_LEGACY_SCHEMA].sort((a,b)=>a.split(' ')[2]!<b.split(' ')[2]!?-1:1));
      if(db.prepare('SELECT count(*) AS n FROM events').get()!.n!==d.committedSequence||db.prepare('SELECT count(*) AS n FROM events WHERE length(CAST(ref AS BLOB))>2048').get()!.n!==0)stop('CQA_ARCHIVE_CHAIN');
      const rows=db.prepare('SELECT sequence,previous,ref,digest FROM events ORDER BY sequence').all();let head='0'.repeat(64);const terminal:ScopedRef[]=[];
      for(const [i,r]of rows.entries()){
        if(r.sequence!==i+1||r.previous!==head||typeof r.ref!=='string'||r.digest!==hash(head+'\n'+r.ref))stop('CQA_ARCHIVE_CHAIN');
        const ref=refKind(legacyJson(r.ref),'corpus-qa-event','event-'+Math.floor(i/128));if(canonical(ref)!==r.ref)stop('CQA_ARCHIVE_CHAIN');head=String(r.digest);if(i>=rows.length-2)terminal.push(ref);
      }
      if(head!==d.committedHead)stop('CQA_ARCHIVE_CHAIN');
      if(db.prepare('SELECT count(*) AS n FROM metadata').get()!.n!==1||db.prepare('SELECT count(*) AS n FROM metadata WHERE length(CAST(data AS BLOB))>262144').get()!.n!==0)stop('CQA_ARCHIVE_PROJECTION');
      const raw=db.prepare('SELECT data FROM metadata WHERE id=1').get()?.data;if(typeof raw!=='string')stop('CQA_ARCHIVE_PROJECTION');
      const projection=shape(legacyJson(raw),['version','spec','status','code','selectionRef','objectiveRef','rubricRef','manifestRef','indexRef','wallMs']);
      if(projection.version!=='CorpusQualityAuditState/0.1'||!['COMPLETED','FENCED'].includes(String(projection.status)))stop('CQA_ARCHIVE_PROJECTION');same(projection.spec,d.spec);same(projection.selectionRef,d.selectionRef);same(projection.indexRef,d.indexRef);same(projection.manifestRef,d.manifestRef);
      db.close();db=undefined;
      for(const [i,kind,ref]of [[0,'INDEX',d.indexRef],[1,'MANIFEST',d.manifestRef]] as const){const eventRef=terminal[i]!,event=shape(read(eventRef,'corpus-qa-event',eventRef.bucket),['version','kind','data']);if(event.version!=='CorpusQualityAuditEvent/0.1'||event.kind!==kind)stop('CQA_ARCHIVE_TERMINAL');same(shape(event.data,['ref']).ref,ref);}
      const chunkRefs=(value:unknown,kind:string)=>{const refs=list(value,6,1).map(r=>refKind(r,kind));if(new Set(refs.map(r=>r.ref.id)).size!==refs.length)stop('CQA_ARCHIVE_CHUNKS');return refs;};
      const header=shape(read(d.indexRef,'corpus-qa-dedup-index'),['version','scope','entries']);if(header.version!=='CorpusScopedDedupIndexChunks/0.1')stop('CQA_ARCHIVE_INDEX');
      const index:ScopedDedupIndex={version:'CorpusScopedDedupIndex/0.1',scope:header.scope as ScopedDedupIndex['scope'],entries:chunkRefs(header.entries,'corpus-qa-index-chunk').flatMap(r=>list(read(r,'corpus-qa-index-chunk'),32,1)) as ScopedDedupIndex['entries']};
      if(hash(canonical(index))!==d.indexDigest)stop('CQA_ARCHIVE_INDEX');const assembly=assembleScopedIndexes([index],[d.indexDigest]);
      if(index.entries.length!==d.spec.rowCount||index.scope.sourceJobId!==d.source.jobId||index.scope.selectionDigest!==d.spec.selectionDigest||index.scope.populationDigest!==d.spec.populationDigest)stop('CQA_ARCHIVE_BINDING');
      const m=shape(read(d.manifestRef,'corpus-qa-selection-manifest'),['version','auditId','selectionDigest','populationDigest','selectionRef','source','baselineDigest','auditTargetBaselineDigest','studentTargetDigest','purposeDigest','readGrantDigest','rubricRef','indexRef','indexDigest','rows','evidenceClass','independence','factualTruth','packing','trainingReady','trainingJobPolicy']);
      if(m.version!=='CorpusQualitySelectionManifest/0.1'||m.indexDigest!==d.indexDigest||m.evidenceClass!=='MODEL_OPINION'||m.independence!=='SAME_MODEL_OR_ROUTING_UNKNOWN'||m.factualTruth!=='UNKNOWN'||m.packing!=='OFF'||m.trainingReady!==false||m.trainingJobPolicy!=='NOT_AUTHORIZED')stop('CQA_ARCHIVE_MANIFEST');
      for(const k of ['auditId','selectionDigest','populationDigest','baselineDigest','auditTargetBaselineDigest','studentTargetDigest','purposeDigest','readGrantDigest'] as const)same(m[k],d.spec[k]);
      same(m.source,d.source);same(m.selectionRef,d.selectionRef);same(m.indexRef,d.indexRef);same(m.rubricRef,projection.rubricRef);if(m.rubricRef!==null){const rubric=legacyRef(m.rubricRef);if(rubric.ref.kind!=='corpus-qa-rubric'||!/^attempt-\d+$/.test(rubric.bucket))stop('CQA_ARCHIVE_MANIFEST');}
      const s=shape(read(d.selectionRef,'corpus-qa-selection'),['version','header','entries']);if(s.version!=='CorpusQualitySelectionChunks/0.1')stop('CQA_ARCHIVE_SELECTION');
      const selection=legacySelection({...s.header as object,entries:chunkRefs(s.entries,'corpus-qa-selection-chunk').flatMap(r=>list(read(r,'corpus-qa-selection-chunk'),32,1))});
      if(hash(canonical(selection))!==d.spec.selectionDigest||selection.populationDigest!==d.spec.populationDigest||selection.entries.length!==d.spec.rowCount)stop('CQA_ARCHIVE_SELECTION');same(selection.source,d.source);
      for(const [i,e]of selection.entries.entries()){const row=index.entries[i]!;same({sourceJobId:d.source.jobId,unitId:e.unit.unitId,poolId:e.unit.poolId,familyId:e.unit.familyId,split:e.unit.split,rowRef:e.sourceRowRef,rowDigest:e.rowDigest},{sourceJobId:row.sourceJobId,unitId:row.unitId,poolId:row.poolId,familyId:row.familyId,split:row.split,rowRef:row.rowRef,rowDigest:row.rowDigest});}
      const eligibleRows=list(m.rows,192).map(v=>{const r=shape(v,['caseId','verdictRef']);id(r.caseId);const ref=legacyRef(r.verdictRef);if(ref.ref.kind!=='corpus-qa-verdict'||!/^attempt-\d+$/.test(ref.bucket))stop('CQA_ARCHIVE_MANIFEST');return {caseId:String(r.caseId),verdictRef:ref};});
      const eligible=new Set(assembly.rows.filter(r=>r.eligibleForNextExport).map(r=>r.unitId));same(eligibleRows.map(r=>r.caseId),selection.entries.filter(e=>eligible.has(e.unit.unitId)).map(e=>e.caseId));
      const rubricRef=m.rubricRef===null?null:legacyRef(m.rubricRef);
      check();return {version:'VerifiedQaIndexView/0.1',descriptor:structuredClone(d),descriptorDigest:o.descriptorDigest,index,selection,eligibleRows,rubric:{ref:rubricRef,cipherDigest:rubricRef?.ref.digest??null,rubricContentDigest:'UNKNOWN_NOT_INDEXED'}};
    }catch(error){close();throw error;}finally{db?.close();}
  };
  const reader=Object.freeze({check,readVerifiedView,close});capabilities.set(reader,Object.freeze({check,read:readVerifiedView,runtimeRoot:o.runtimeRoot}));return reader;
}
