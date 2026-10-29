import fs from 'node:fs';
import { canonical,hash } from '../../src/wf1-json.ts';
import { syntheticOwner } from '../teaching-cycle-fixture.ts';
import { installSyntheticTokenizer } from '../teaching-tokenizer-fixture.ts';
import { teachingNativeFixture,syntheticCredentials,syntheticTeachingFetch } from '../teaching-native-fixture.mjs';
import { initializeTeachingCustody,openTrustedTeachingHost,executeTeachingWorker,finalizeTeachingAuthority } from '../../runtime/teaching-cycle/teaching-host-bindings.mjs';
import { runTeachingCycle } from '../../src/teaching-cycle-runner.ts';

const [action,target]=process.argv.slice(2),restore=installSyntheticTokenizer();
try{
  if(action==='crash'){
    const f=teachingNativeFixture({activeChildren:1});initializeTeachingCustody(f.config);const native=syntheticTeachingFetch(),host=openTrustedTeachingHost(f.config,f.key,syntheticCredentials,syntheticOwner('crash-'+process.pid),'create',{fetch:native.fetch});
    const crash=()=>{const state=host.ports.store.snapshot(),saved={configPath:f.configPath,calls:native.calls.length,state,authorities:f.config.children.map(b=>({production:hash(fs.readFileSync(b.production.authorityPath)),qa:hash(fs.readFileSync(b.audit.authorityPath))}))};fs.writeSync(1,JSON.stringify(saved)+'\n');process.exit(17);};
    if(target==='production'){const original=host.ports.finalizeProductionSource;host.ports.finalizeProductionSource=async(child,p)=>{const reopened=await original(child,p);if(child.childId==='child-0'){reopened.close();await crash();}return reopened;};}
    else if(target==='qa'){const original=host.ports.archiveAudit;host.ports.archiveAudit=async(child,p)=>{const reader=await original(child,p);if(child.childId==='child-0'){reader.close();await crash();}return reader;};}
    else if(target==='production-missing-export'||target==='qa-missing-index'){
      let opened;const production=target==='production-missing-export',name=production?'openProduction':'openAudit',original=host.ports[name];host.ports[name]=async(...args)=>{const p=await original(...args);if(args[0].childId==='child-0')opened=p;return p;};
      const apply=host.ports.store.apply.bind(host.ports.store);host.ports.store.apply=(kind,data)=>{apply(kind,data);if(kind==='STAGE'&&data.childId==='child-0'&&data.stage===(production?'TOKENS':'INDEX')){const s=opened.store.spec,head=opened.store.check(false).head;opened.store.close();opened.source?.close();const b=f.config.children[0][production?'production':'audit'];finalizeTeachingAuthority(b.authorityPath,s,production?s.jobId:s.auditId,head);crash();}};
    }
    else throw Error('unknown fixture');
    await runTeachingCycle(host.ports);throw Error('crash not reached');
  }else if(action==='cold'){
    const c=JSON.parse(fs.readFileSync(target,'utf8'));const result=await executeTeachingWorker(c,Buffer.alloc(32,61),null,syntheticOwner('cold-'+process.pid),'verify-report');process.stdout.write(JSON.stringify(result)+'\n');
  }else throw Error('unknown fixture');
}finally{restore();}
