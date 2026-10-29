// SYNTHETIC controller regression worker. The test copies this file into a
// temporary pinned source snapshot. Production never loads this replacement.
import fs from 'node:fs';
import path from 'node:path';
import { hash } from '../../src/wf1-json.ts';
import { runTeachingCycle } from '../../src/teaching-cycle-runner.ts';
import { openTrustedTeachingHost,executeTeachingWorker,revokeTeachingCycle } from '../../runtime/teaching-cycle/teaching-host-bindings.mjs';
import { syntheticTeachingFetch } from '__SYNTHETIC_FETCH_FIXTURE_URL__';
import { installSyntheticTokenizer } from '__SYNTHETIC_TOKENIZER_FIXTURE_URL__';

const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),config=JSON.parse(fs.readFileSync(input.configPath,'utf8'));
for(const chunk of chunks)chunk.fill(0);
const key=input.keyBase64===null?null:Buffer.from(input.keyBase64,'base64');input.keyBase64=null;
let tokenCalls=0;const restore=installSyntheticTokenizer(()=>tokenCalls++),native=syntheticTeachingFetch();
try{
  let value;
  if(input.action==='run'){
    const host=openTrustedTeachingHost(config,key,input.credentials,input.owner,'create',{fetch:native.fetch});
    const crash=()=>{const saved={state:host.ports.store.snapshot(),calls:native.calls.length,authorities:config.children.map(b=>({production:hash(fs.readFileSync(b.production.authorityPath)),qa:hash(fs.readFileSync(b.audit.authorityPath))}))};fs.writeFileSync(path.join(config.controlRoot,'synthetic-crash.json'),JSON.stringify(saved),{flag:'wx'});process.exit(17);};
    if('__SYNTHETIC_CRASH_TARGET__'==='production'){const original=host.ports.finalizeProductionSource;host.ports.finalizeProductionSource=async(child,p)=>{const store=await original(child,p);if(child.childId==='child-0'){store.close();crash();}return store;};}
    else{const original=host.ports.archiveAudit;host.ports.archiveAudit=async(child,p)=>{const reader=await original(child,p);if(child.childId==='child-0'){reader.close();crash();}return reader;};}
    await runTeachingCycle(host.ports);throw Error('synthetic crash not reached');
  }else if(input.action==='resume'||input.action==='verify-report'){
    value=await executeTeachingWorker(config,key,input.credentials,input.owner,input.action,{fetch:native.fetch});
    if(input.action==='resume')fs.writeFileSync(path.join(config.controlRoot,'synthetic-resume.json'),JSON.stringify({calls:native.calls.length,tokenCalls}),{flag:'wx'});
  }else if(input.action==='revoke')value=revokeTeachingCycle(config);
  else throw Error('unsupported synthetic action');
  process.stdout.write(JSON.stringify(value)+'\n');
}finally{restore();key?.fill(0);input.credentials=null;}
