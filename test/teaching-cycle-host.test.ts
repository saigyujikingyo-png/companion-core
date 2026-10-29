import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teachingHostFixture } from './teaching-cycle-host-fixture.ts';
import { installSyntheticTokenizer } from './teaching-tokenizer-fixture.ts';
import { runTeachingCycleCommand } from '../src/teaching-cycle-cli.ts';
import { teachingCycleReport } from '../src/teaching-cycle-report.ts';
import { openTeachingCycleHost } from '../src/teaching-cycle-host.ts';
import { hash } from '../src/wf1-json.ts';

test('portable host runs real stores, deterministic QA binding and metadata seals; fresh host process verifies all final bindings',async()=>{
  const f=teachingHostFixture(),restore=installSyntheticTokenizer();try{
    const result=await runTeachingCycleCommand({version:'TeachingCycleCommand/0.2',command:'run',spec:f.options.cycle.spec},f.host.ports);assert.equal('status' in result&&result.status,'COMPLETE',JSON.stringify(result));assert.equal(f.peak,2);assert.equal(f.sends,32);assert.equal(f.host.automaticLocalReclaim,'DISABLED');
    const report=teachingCycleReport(f.host.ports.store,f.host.ports.openIndex,f.host.ports.checkChildMetadata);assert.equal(report.qualified!.train.rows,8);assert.equal(report.qualified!.dev.rows,8);assert.equal(report.publication,'INDEPENDENT_COLD_REQUIRED');const file=f.persist();f.host.close();
    const cold=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/teaching-cycle-host-worker.mjs',import.meta.url)),file],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(cold.status,0,cold.stderr);assert.deepEqual(JSON.parse(cold.stdout),report);
    const reopened=teachingHostFixture(file,'resume');try{const prior=reopened.host.ports.store.snapshot()!.timing;await runTeachingCycleCommand({version:'TeachingCycleCommand/0.2',command:'run',spec:reopened.options.cycle.spec},reopened.host.ports);assert.equal(reopened.sends,0);assert.deepEqual(reopened.host.ports.store.snapshot()!.timing,prior);reopened.denyMetadata();assert.throws(()=>teachingCycleReport(reopened.host.ports.store,reopened.host.ports.openIndex,reopened.host.ports.checkChildMetadata));}finally{reopened.host.close();}
  }finally{restore();f.host.close();}
});

test('host rejects substituted child specs before custody mutation',()=>{
  const f=teachingHostFixture();f.host.close();const options=f.options,child=options.children[0]!;child.production.spec={...child.production.spec,buildDigest:hash('substitution')};assert.throws(()=>openTeachingCycleHost(options),{code:'TC_HOST_CHILDREN'});
});

for(const failure of ['later-child','overlap','cycle-open'] as const)test('host wipes owned key copies after '+failure+' construction failure and preserves caller keys',()=>{
  const f=teachingHostFixture();f.host.close();const options=f.options,inputs=options.children.flatMap(c=>[c.production.key,c.audit.key]),before=inputs.map(k=>Buffer.from(k));
  if(failure==='later-child')options.children[1]!.production.spec={...options.children[1]!.production.spec,buildDigest:hash('SYNTHETIC substitution')};
  if(failure==='overlap')options.children[0]!.audit.runtimeRoot=options.children[0]!.production.runtimeRoot;
  if(failure==='cycle-open')options.cycle.key=new Uint8Array(0);
  const original=Buffer.from,copies:Buffer[]=[];
  Buffer.from=((...args:any[])=>{const copy=(original as any)(...args);if(inputs.includes(args[0]))copies.push(copy);return copy;}) as typeof Buffer.from;
  try{assert.throws(()=>openTeachingCycleHost(options),{code:failure==='later-child'?'TC_HOST_CHILDREN':failure==='overlap'?'TC_HOST_CUSTODY':'TC_KEY'});}
  finally{Buffer.from=original;}
  assert.equal(copies.length,failure==='later-child'?2:8);for(const copy of copies)assert.ok(copy.every(v=>v===0));for(const [i,key]of inputs.entries())assert.deepEqual(key,before[i]);
});
