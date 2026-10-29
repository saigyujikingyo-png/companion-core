import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical,copyJson,hash,integer,parseJson,shape,stop } from './wf1-json.ts';
import { synchronousCheck } from './teaching-cycle-admission.ts';
import { validateAuditSelection,validateAuditSpec } from './corpus-qa-types.ts';
import type { AuditAdmission,AuditSelection,AuditSpec } from './corpus-qa-types.ts';
import { archiveCapability,archiveFile,openQualityIndexArchive,QA_INDEX_ARCHIVE_V2_PROFILE_DIGEST } from './corpus-qa-index-archive.ts';
import type { QaIndexArchiveAdmission,QaIndexArchiveDescriptor } from './corpus-qa-index-archive.ts';
import type { TeachingChildHostBinding } from './teaching-cycle-host.ts';

export type TeachingAuditTemplate=Omit<AuditSpec,'selectionDigest'|'populationDigest'|'readGrantDigest'|'purposeDigest'|'rowCount'>;
/** Every varying selection field is derived once from frozen bytes; createdAt,
 * identity, expiry and all other fields remain in the host's frozen template.
 * No grant is issued here. The resolver returns a CURRENT authorized grant.
 * openTeachingCycleHost persists this exact spec in the existing QA INIT before
 * returning; resume verifies the encrypted INIT, never replaces its binding. */
export function deterministicTeachingAuditBinding(templateInput:TeachingAuditTemplate,currentAdmission:(selection:AuditSelection)=>AuditAdmission):TeachingChildHostBinding['audit']['bind']{
  const template=copyJson(templateInput) as unknown as TeachingAuditTemplate;
  return input=>{const selection=validateAuditSelection(copyJson(input)),read=()=>copyJson(currentAdmission(structuredClone(selection))) as unknown as AuditAdmission,admission=read();
    const spec=validateAuditSpec({...template,selectionDigest:hash(canonical(selection)),populationDigest:selection.populationDigest,rowCount:selection.entries.length,readGrantDigest:hash(canonical(admission.readGrant)),purposeDigest:hash(canonical(admission.purposes))});
    return {spec,admission:read};
  };
}
export type TeachingArchiveSealOptions={approvedTrainingRoot:string;runtimeRoot:string;authorityPath:string;key:Uint8Array;readerBuildDigest:string;checkMetadata:()=>void;admission:(descriptor:QaIndexArchiveDescriptor)=>QaIndexArchiveAdmission;now?:()=>number};
/** A real metadata reopen in this process, with current grants and immutable file
 * pins. It does not claim process independence. The complete cycle's separate
 * inspect/report process is the independent-cold publication gate. */
export function sealTeachingQaArchive(context:Parameters<TeachingChildHostBinding['archive']['seal']>[0],options:TeachingArchiveSealOptions):QaIndexArchiveDescriptor{
  const check=()=>synchronousCheck(options.checkMetadata,'TC_METADATA_CHECK');check();
  const {spec,selection,index,state}=context;if(spec.version!=='CorpusQualityAudit/0.2'||state.status!=='COMPLETED'||!state.indexRef||!state.manifestRef||canonical(spec)!==canonical(state.spec)||hash(canonical(selection))!==spec.selectionDigest)stop('TC_ARCHIVE_SEAL');
  const ledger=join(options.runtimeRoot,'corpus-qa.sqlite');check();const ledgerRawDigest=hash(archiveFile(ledger,67108864));check();const authorityBytes=archiveFile(options.authorityPath,16384),authorityRawDigest=hash(authorityBytes),a=shape(parseJson(authorityBytes.toString('utf8')),['schemaVersion','campaignId','revision','runtimeId','status','expiresAt','head','rights']);
  if(a.schemaVersion!=='wf1-host/1'||a.campaignId!==spec.auditId||a.runtimeId!==spec.runtimeId||a.expiresAt!==spec.expiresAt||typeof a.head!=='string')stop('TC_ARCHIVE_SEAL');
  check();const db=new DatabaseSync(ledger,{readOnly:true,timeout:0});let sequence:number;try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');sequence=integer(db.prepare('SELECT count(*) AS n FROM events').get()!.n,3,2048);}finally{db.close();}
  const specDigest=hash(canonical(spec)),indexDigest=hash(canonical(index)),receipt={version:'TeachingQaMetadataReopen/0.1',verification:'CURRENT_PROCESS_METADATA_REOPEN',readerBuildDigest:options.readerBuildDigest,specDigest,selectionDigest:spec.selectionDigest,indexDigest,ledgerRawDigest,authorityRawDigest,committedHead:a.head,committedSequence:sequence};
  const descriptor:QaIndexArchiveDescriptor={version:'QaIndexArchiveDescriptor/0.1',legacyProfile:'QA_POLICY_V2',readerBuildDigest:options.readerBuildDigest,archiveProfileDigest:QA_INDEX_ARCHIVE_V2_PROFILE_DIGEST,spec,specDigest,source:selection.source,ledgerRawDigest,authorityRawDigest,authorityRevision:integer(a.revision,1),authorityStatus:a.status as QaIndexArchiveDescriptor['authorityStatus'],committedHead:a.head,committedSequence:sequence,coldReceiptRawDigest:hash(canonical(receipt)),indexDigest,indexRef:state.indexRef,manifestRef:state.manifestRef,selectionRef:state.selectionRef};
  check();const reader=openQualityIndexArchive({approvedTrainingRoot:options.approvedTrainingRoot,runtimeRoot:options.runtimeRoot,authorityPath:options.authorityPath,key:options.key,descriptor,descriptorDigest:hash(canonical(descriptor)),readerBuildDigest:options.readerBuildDigest,admission:()=>{check();return options.admission(structuredClone(descriptor));},...(options.now?{now:options.now}:{})});
  try{const cap=archiveCapability(reader);cap.check();const view=cap.read();if(canonical(view.index)!==canonical(index)||canonical(view.selection)!==canonical(selection))stop('TC_ARCHIVE_SEAL');check();return structuredClone(descriptor);}finally{reader.close();}
}
