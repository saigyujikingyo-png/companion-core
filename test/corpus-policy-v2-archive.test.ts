import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdirSync,readFileSync} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical,hash } from '../src/wf1-json.ts';
import { qaFixture } from './corpus-qa-fixture.ts';
import { nativeQa } from './corpus-policy-v2-fixture.ts';
import { QA_V2_PROFILE_DIGEST,validateAuditSpec } from '../src/corpus-qa-types.ts';
import { runQualityAudit,verifyQualityAudit,exportQualityAudit,readQualityIndex } from '../src/corpus-qa-runner.ts';
import { openQualityIndexArchive,QA_INDEX_ARCHIVE_SCOPE,QA_INDEX_ARCHIVE_V2_PROFILE_DIGEST,QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST } from '../src/corpus-qa-index-archive.ts';
import type { QaIndexArchiveDescriptor,QaIndexArchiveAdmission } from '../src/corpus-qa-index-archive.ts';
import { openQualityArchiveAssembly,writeQualityArchiveAssembly,QA_ARCHIVE_ASSEMBLY_V2_POLICY_PROFILE_DIGEST,QA_ARCHIVE_ASSEMBLY_PROFILE_DIGEST } from '../src/corpus-qa-archive-assembly.ts';
import type { QaArchiveAssemblyReadGrant } from '../src/corpus-qa-archive-assembly.ts';

test('v2 production/QA output stays fully indexable under explicit metadata-only profile and cold assembly',async()=>{
  const f=await qaFixture(8,undefined,false,hash('SYNTHETIC v2 producer closure'),true),m=nativeQa({change:r=>{if(r.operation==='review'&&r.index===0){r.body.items[0].disposition='REJECT';r.body.items[1].unexpected=true;}}});
  try{
    const oldProfile='d6f2dbff88314de27c1561067dae8b5dcf6e140752da63a48073c3b96aaeeed4';assert.equal(f.spec.profileDigest,QA_V2_PROFILE_DIGEST);assert.notEqual(QA_V2_PROFILE_DIGEST,oldProfile);assert.throws(()=>validateAuditSpec({...f.spec,profileDigest:oldProfile}),{code:'CQA_PROFILE'});
    const result=await runQualityAudit(f.spec,{store:f.store,source:f.source,selection:f.selection,objective:f.objective,transport:m.transport});assert.equal(result.status,'COMPLETED');assert.equal(result.counts.REJECT,1);assert.equal(result.counts.HOLD,1);assert.equal(result.counts.PASS,6);exportQualityAudit(f.store,f.source);
    const state=verifyQualityAudit(f.store,f.source).state,index=readQualityIndex(f.store,state.indexRef!);f.store.control('REVOKED');f.store.close();f.source.close();
    const authority=JSON.parse(readFileSync(f.storeOptions.authorityPath,'utf8')),ledger=join(f.storeOptions.runtimeRoot,'corpus-qa.sqlite'),db=new DatabaseSync(ledger,{readOnly:true}),sequence=Number(db.prepare('SELECT count(*) AS n FROM events').get()!.n);db.close();
    const readerBuildDigest=hash('SYNTHETIC independently pinned reader closure'),coldReceipt={version:'SYNTHETIC_CURRENT_SOURCE_VERIFIED/1',specDigest:hash(canonical(f.spec)),profileDigest:f.spec.profileDigest,buildDigest:f.spec.buildDigest,stateDigest:hash(canonical(state)),committedHead:authority.head};
    const descriptor:QaIndexArchiveDescriptor={version:'QaIndexArchiveDescriptor/0.1',legacyProfile:'QA_POLICY_V2',readerBuildDigest,archiveProfileDigest:QA_INDEX_ARCHIVE_V2_PROFILE_DIGEST,spec:f.spec,specDigest:hash(canonical(f.spec)),source:f.selection.source,ledgerRawDigest:hash(readFileSync(ledger)),authorityRawDigest:hash(readFileSync(f.storeOptions.authorityPath)),authorityRevision:authority.revision,authorityStatus:authority.status,committedHead:authority.head,committedSequence:sequence,coldReceiptRawDigest:hash(canonical(coldReceipt)),indexDigest:hash(canonical(index)),indexRef:state.indexRef!,manifestRef:state.manifestRef!,selectionRef:state.selectionRef};
    const now=Date.now(),descriptorDigest=hash(canonical(descriptor)),admission:QaIndexArchiveAdmission={grant:{version:'QaIndexReadGrant/0.1',grantId:'synthetic-current-index-grant',revision:1,descriptorDigest,purposeDigest:f.spec.purposeDigest,status:'ACTIVE',readAllowed:true,retainAllowed:true,validFrom:now-1,expiresAt:now+3600000,scope:QA_INDEX_ARCHIVE_SCOPE},sourceJobId:f.selection.source.jobId,sourcePurposeDigest:f.selection.source.purposeDigest,parentGrantIds:f.selection.source.parentGrantIds,sourceAllowed:true,retainAllowed:true};
    const options={...f.storeOptions,descriptor,descriptorDigest,readerBuildDigest,admission:()=>admission};
    const oldTag={...descriptor,legacyProfile:'QA_F2' as const,archiveProfileDigest:QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST};assert.throws(()=>openQualityIndexArchive({...options,descriptor:oldTag,descriptorDigest:hash(canonical(oldTag))}));
    const oldSpec={...f.spec,profileDigest:oldProfile},oldPolicy={...descriptor,spec:oldSpec,specDigest:hash(canonical(oldSpec))};assert.throws(()=>openQualityIndexArchive({...options,descriptor:oldPolicy,descriptorDigest:hash(canonical(oldPolicy))}),{code:'CQA_PROFILE'});
    const oldRead=fs.readFileSync,reads:string[]=[],oldPrepare=DatabaseSync.prototype.prepare,queries:string[]=[];
    fs.readFileSync=((path:any,...args:any[])=>{const p=String(path);reads.push(p);assert.ok(!p.startsWith(f.old.options.runtimeRoot),'index permission cannot read source samples');assert.ok(!/[\\/]objects[\\/]attempt-/.test(p),'index permission cannot decrypt provider/rubric/verdict bodies');return (oldRead as any)(path,...args);}) as typeof fs.readFileSync;
    DatabaseSync.prototype.prepare=function(sql:string){queries.push(sql);assert.ok(!/\bFROM\s+(attempts|cases)\b/i.test(sql),'metadata reader cannot inspect attempts or verdict cases');return oldPrepare.call(this,sql);};syncBuiltinESMExports();
    try{
      const reader=openQualityIndexArchive(options);try{const view=reader.readVerifiedView();assert.equal(view.index.entries.length,8);assert.equal(view.eligibleRows.length,6);assert.equal(view.index.entries.filter(r=>r.qaDisposition==='HOLD').length,1);assert.equal(view.index.entries.filter(r=>r.qaDisposition==='REJECT').length,1);
        const runtimeRoot=join(f.storeOptions.approvedTrainingRoot,'v2-index-assembly');mkdirSync(runtimeRoot);const output={approvedTrainingRoot:f.storeOptions.approvedTrainingRoot,runtimeRoot,assemblyId:'synthetic-v2-assembly',key:Buffer.alloc(32,89),readerBuildDigest,purposeDigest:f.spec.purposeDigest,readers:[reader]},receipt=writeQualityArchiveAssembly(output);assert.equal(receipt.archiveProfileDigest,QA_ARCHIVE_ASSEMBLY_V2_POLICY_PROFILE_DIGEST);assert.equal(receipt.indexedRows,8);assert.equal(receipt.selectedRows,6);
        const grant:QaArchiveAssemblyReadGrant={version:'QaArchiveAssemblyReadGrant/0.1',grantId:'synthetic-v2-cold',revision:1,receiptDigest:hash(canonical(receipt)),purposeDigest:f.spec.purposeDigest,status:'ACTIVE',readAllowed:true,retainAllowed:true,validFrom:now-1,expiresAt:now+3600000,scope:QA_INDEX_ARCHIVE_SCOPE},coldOptions={...output,receipt,receiptDigest:grant.receiptDigest,admission:()=>grant};
        const cold=openQualityArchiveAssembly(coldOptions);try{assert.equal(canonical(cold.readVerifiedReceipt()),canonical(receipt));}finally{cold.close();}
        const downgraded={...receipt,archiveProfileDigest:QA_ARCHIVE_ASSEMBLY_PROFILE_DIGEST};assert.throws(()=>{const c=openQualityArchiveAssembly({...coldOptions,receipt:downgraded,receiptDigest:hash(canonical(downgraded)),admission:()=>({...grant,receiptDigest:hash(canonical(downgraded))})});try{c.readVerifiedReceipt();}finally{c.close();}});
        admission.grant.status='REVOKED';assert.throws(reader.readVerifiedView);
      }finally{reader.close();}
      assert.ok(reads.length>0);assert.ok(queries.some(q=>/FROM metadata/.test(q)));
    }finally{fs.readFileSync=oldRead;DatabaseSync.prototype.prepare=oldPrepare;syncBuiltinESMExports();}
  }finally{f.store.close();f.source.close();}
});
