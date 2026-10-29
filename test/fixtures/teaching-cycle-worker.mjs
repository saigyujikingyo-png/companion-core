import { pipelineFixture } from '../teaching-cycle-fixture.ts';
import { installSyntheticTokenizer } from '../teaching-tokenizer-fixture.ts';
import { runTeachingCycle,verifyTeachingCycle,teachingCycleSummary } from '../../src/teaching-cycle-runner.ts';
import { canonical,hash } from '../../src/wf1-json.ts';

if(process.argv[2]==='verify'){
  const f=pipelineFixture(undefined,process.argv[3]);try{const {state,digests,measurementDigest,tokens}=verifyTeachingCycle(f.store,f.ports.openIndex,f.ports.checkChildMetadata);process.stdout.write(JSON.stringify({summary:teachingCycleSummary(state),stateDigest:hash(canonical(state)),indexDigests:digests,measurementDigest,tokens}));}finally{f.store.close();}
}else if(process.argv[2]==='crash'){
  installSyntheticTokenizer();const f=pipelineFixture(undefined,undefined,{activeChildren:1}),window=process.argv[3];
  if(window==='audit-created'){const open=f.ports.openAudit;f.ports.openAudit=async(...args)=>{const result=await open(...args);process.stdout.write(f.persist());process.exit(17);return result;};}
  else{const archive=f.ports.archiveAudit;f.ports.archiveAudit=async(...args)=>{const result=await archive(...args);process.stdout.write(f.persist());process.exit(17);return result;};}
  await runTeachingCycle(f.ports);throw new Error('crash window not reached');
}else throw new Error('unknown synthetic worker command');
