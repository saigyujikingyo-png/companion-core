import { pipelineFixture } from '../teaching-cycle-fixture.ts';
import { installSyntheticTokenizer } from '../teaching-tokenizer-fixture.ts';
import { runTeachingCycle } from '../../src/teaching-cycle-runner.ts';
import { runTeachingCycleCommand } from '../../src/teaching-cycle-cli.ts';

if(process.argv[2]==='verify'){
  const f=pipelineFixture(undefined,process.argv[3],{},true,true);
  try{process.stdout.write(JSON.stringify(await runTeachingCycleCommand({version:'TeachingCycleCommand/0.2',command:'verify-report',spec:f.spec},f.ports)));}finally{f.store.close();}
}else if(process.argv[2]==='crash'){
  installSyntheticTokenizer();const f=pipelineFixture(undefined,undefined,{activeChildren:1},true),window=process.argv[3];
  if(window==='audit-created'){const open=f.ports.openAudit;f.ports.openAudit=async(...args)=>{const result=await open(...args);process.stdout.write(f.persist());process.exit(17);return result;};}
  else{const archive=f.ports.archiveAudit;f.ports.archiveAudit=async(...args)=>{const result=await archive(...args);process.stdout.write(f.persist());process.exit(17);return result;};}
  await runTeachingCycle(f.ports);throw new Error('synthetic crash window not reached');
}else throw new Error('unknown synthetic command');
