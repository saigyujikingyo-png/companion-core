// Executable wiring example. Always creates fresh synthetic fixtures and keys in
// the OS temporary directory; takes no paths, secrets, corpus or provider inputs.
import assert from 'node:assert/strict';
import { canonical,hash } from '../src/wf1-json.ts';
import { HostAuthority } from '../src/wf1-storage.ts';
import { openQualityIndexArchive,QA_INDEX_ARCHIVE_SCOPE } from '../src/corpus-qa-index-archive.ts';
import { openQualityArchiveAssembly,writeQualityArchiveAssembly } from '../src/corpus-qa-archive-assembly.ts';
import type { QaArchiveAssemblyReadGrant } from '../src/corpus-qa-archive-assembly.ts';
import { archiveFixture } from '../test/corpus-qa-index-archive-fixture.ts';

const sources=[archiveFixture({job:'synthetic-f1',count:3}),archiveFixture({job:'synthetic-f2',count:4,profile:'QA_F2'})];
const writerReaders=sources.map(s=>openQualityIndexArchive(s.readerOptions)),output=sources[0]!.output(writerReaders);
let receipt:ReturnType<typeof writeQualityArchiveAssembly>;
try{receipt=writeQualityArchiveAssembly(output);}finally{writerReaders.forEach(r=>r.close());}
// In a real host, persist this successfully returned receipt through a trusted
// channel and independently pin its canonical SHA. Merely finding it in an output
// directory does not authenticate successful commit or grant reading authority.
const receiptDigest=hash(canonical(receipt)),readers=sources.map(s=>openQualityIndexArchive(s.readerOptions)),now=Date.now();
const grant:QaArchiveAssemblyReadGrant={version:'QaArchiveAssemblyReadGrant/0.1',grantId:'synthetic-new-cold-grant',revision:1,receiptDigest,purposeDigest:output.purposeDigest,status:'ACTIVE',readAllowed:true,retainAllowed:true,validFrom:now-1,expiresAt:now+60000,scope:QA_INDEX_ARCHIVE_SCOPE};
try{
  const cold=openQualityArchiveAssembly({...output,readers,receipt,receiptDigest,admission:()=>grant});
  try{
    const verified=cold.readVerifiedReceipt();assert.deepEqual(verified,receipt);
    for(const s of sources)assert.throws(()=>new HostAuthority(s.authorityPath,s.descriptor.spec.auditId).read(Date.now(),false),{code:'WF1_AUTHORITY'});
    grant.status='REVOKED';assert.throws(cold.readVerifiedReceipt,{code:'CQA_ASSEMBLY_ADMISSION'});grant.status='ACTIVE';assert.throws(cold.check,{code:'CQA_ASSEMBLY_CLOSED'});
    // Safe aggregates only: no paths, source identities, row refs or fingerprints.
    console.log(JSON.stringify({status:'SYNTHETIC_COLD_METADATA_PASS',version:verified.version,inputCount:verified.inputCount,indexedRows:verified.indexedRows,selectedRows:verified.selectedRows,totals:verified.totals,manifestDigest:verified.manifestDigest,commitDigest:verified.commitDigest,evidenceClass:verified.evidenceClass,trainingReady:false,trainingJobPolicy:'NOT_AUTHORIZED',actualApiCalls:0,sourcePayloadReads:0}));
  }finally{cold.close();}
}finally{readers.forEach(r=>r.close());output.key.fill(0);sources.forEach(s=>s.key.fill(0));}
