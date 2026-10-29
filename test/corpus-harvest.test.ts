import assert from 'node:assert/strict';
import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonical,hash,parseJson } from '../src/wf1-json.ts';
import { collectEvidence,prepareWf2Harvest,selectedRefs,verifySelectedEvidence } from '../src/corpus-harvest.ts';
import { corpusCommandBytes,runCorpusCommand } from '../src/corpus-cli.ts';
import { harvestQualified,openCorpusRun,verifyCorpusManifest } from '../src/corpus-manifest.ts';
import { corpusFixture } from './fixtures/corpus-fixture.ts';
import type { CorpusEvidence } from '../src/corpus-types.ts';
const files=(root:string)=>readdirSync(root).sort().map(name=>[name,hash(readFileSync(join(root,name)))]);

test('CP0 harvests the first qualified row of an actual synthetic stopped chain, then cold verifies with no source capability',{timeout:30000},async()=>{
  const f=await corpusFixture();const before=f.originalSourceFiles,oldAuthority=readFileSync(f.f.authorityPath);
  const store=openCorpusRun({approvedTrainingRoot:f.f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,spec:f.spec,key:f.key,admission:f.admission,mode:'harvest',now:()=>f.f.now});
  try{
    assert.equal(f.state.status,'STOPPED');assert.equal(f.state.candidates.length,2);assert.equal(f.state.candidates[1]!.disposition,'QUARANTINE');assert.equal(f.state.manifestRef,null);assert.equal(f.mock.operations.length,12);
    assert.throws(()=>f.reader.read(f.state.sealRef!));assert.throws(()=>f.reader.read(f.state.candidates[1]!.targetRef!));assert.throws(()=>f.reader.read(f.state.planRef!));assert.throws(()=>f.reader.read(f.state.planUnits![1]!));assert.equal(f.reads.length,0);
    const result=harvestQualified(f.spec,{...f,...store,now:()=>f.f.now});assert.equal(result.summary.rows,1);assert.equal(result.summary.train,1);assert.equal(result.summary.dev,0);assert.equal(result.summary.studentInputTokens,null);assert.equal(result.summary.trainingReady,false);assert.equal(result.summary.trustClass,'SYNTHETIC_FIXTURE');
    assert.deepEqual(f.reads,selectedRefs(f.selection).map(r=>r.id));const after=files(f.runtimeRoot);
    const duplicate=harvestQualified(f.spec,{...f,...store,reader:{read(){throw Error('duplicate must not read old source');}},now:()=>f.f.now});assert.equal(duplicate.summary.idempotent,true);assert.equal(canonical(duplicate.commit),canonical(result.commit));assert.deepEqual(files(f.runtimeRoot),after);
    const row=verifyCorpusManifest(f.spec,result.commit.manifestRef,{admission:f.admission,reader:store.output,commits:store.commits,now:()=>f.f.now}).row;
    assert.equal(row.selectedTargetScope,'EXACT_RATIONAL_TYPED_TARGET_ONLY');assert.equal(row.evidenceClass,'EXACT_VERIFIED');assert.equal(row.teacher.revision,null);assert.equal(row.reviewer.provider,'deepseek');
    store.close();f.close();
    const imports={cli:new URL('../src/corpus-cli.ts',import.meta.url).href,manifest:new URL('../src/corpus-manifest.ts',import.meta.url).href,json:new URL('../src/wf1-json.ts',import.meta.url).href};
    const source=`import {readFileSync} from 'node:fs';import {runCorpusCommand} from ${JSON.stringify(imports.cli)};import {openCorpusRun} from ${JSON.stringify(imports.manifest)};import {parseJson} from ${JSON.stringify(imports.json)};const spec=${canonical(f.spec)},admission=()=>parseJson(readFileSync(${JSON.stringify(f.authorityPath)},'utf8'));const store=openCorpusRun({approvedTrainingRoot:${JSON.stringify(f.f.approvedTrainingRoot)},runtimeRoot:${JSON.stringify(f.runtimeRoot)},spec,key:Buffer.alloc(32,19),admission,mode:'verify',now:()=>1000});try{let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16384)throw Error('bound');}process.stdout.write(JSON.stringify(runCorpusCommand(raw,{...store,admission,now:()=>1000})));}finally{store.close();}`;
    const cold=spawnSync(process.execPath,['--input-type=module','--eval',source],{input:corpusCommandBytes('verify-manifest',f.spec),encoding:'utf8',timeout:10000,maxBuffer:16384,windowsHide:true});assert.equal(cold.status,0,cold.stderr);assert.equal(JSON.parse(cold.stdout).verification,'VERIFIED');assert.ok(!cold.stdout.includes('PRIVATE_'));assert.ok(!cold.stdout.includes('family0'));assert.equal(JSON.parse(cold.stdout).measurementStatus,'TOKENIZER_NOT_PINNED');
    assert.deepEqual(files(f.f.runtimeRoot),before);assert.deepEqual(readFileSync(f.f.authorityPath),oldAuthority);assert.equal(f.mock.operations.length,12);
  }finally{store.close();f.close();}
});

test('CP0 refuses missing qualifications, mismatched requests/reviews/source and custody or failed references before export',async()=>{
  const f=await corpusFixture();try{
    assert.throws(()=>prepareWf2Harvest(f.ledger,{read(){throw Error('must not read');}},f.state.candidates[1]!.id,f.expected));
    for(const key of ['campaignId','ledgerHead','buildDigest','profileDigest'] as const){const expected={...f.expected,[key]:key==='campaignId'?'other':hash('other')};assert.throws(()=>prepareWf2Harvest(f.ledger,f.train,f.state.candidates[0]!.id,expected));}
    const good=collectEvidence(f.selection,f.reader);assert.equal(verifySelectedEvidence(good).split,'train');
    const changeContent=(e:CorpusEvidence,index:number,change:(v:any)=>void)=>{const a=e.artifacts[index]!,v=JSON.parse(a.content);change(v);a.content=canonical(v);a.plaintextDigest=hash(a.content);};
    const mutations:Array<(e:CorpusEvidence)=>void>=[
      e=>{e.selection.exclusion.commitment=hash('wrong');},e=>{e.selection.candidate.evidence.targetCommitment=hash('wrong');},
      e=>{e.selection.review.familyId='wrong';},e=>{e.selection.generation.requestCommitment=hash('wrong');},
      e=>{e.selection.review.result!.returnedModel='wrong';},e=>{e.selection.review.result!.outcome='INCOMPLETE_OUTPUT';},
      e=>{e.artifacts[0]!.sourceRef=e.selection.validatedAggregatePlanRef;},e=>{e.artifacts.pop();},
      e=>changeContent(e,6,v=>{v.disposition='FLAG';}),e=>changeContent(e,4,v=>{v.target.numerator='99';}),
      e=>changeContent(e,5,v=>{v.messages[1].content=v.messages[1].content.replace('SYNTHETIC_UNTRUSTED_RUBRIC','different');}),
      e=>{e.artifacts[2]!.content='{"numerator":"1","numerator":"2","denominator":"1"}';e.artifacts[2]!.plaintextDigest=hash(e.artifacts[2]!.content);}
    ];
    for(const mutate of mutations){const bad=structuredClone(good);mutate(bad);assert.throws(()=>verifySelectedEvidence(bad));}
    let head=f.ledger.head,count=0;const narrowed=prepareWf2Harvest({snapshot:()=>f.ledger.snapshot(),get head(){return head;}},{read:r=>{const bytes=f.train.read(r);if(++count===7)head=hash('advanced during last read');return bytes;}},f.state.candidates[0]!.id,f.expected);
    assert.throws(()=>collectEvidence(narrowed.selection,narrowed.reader));assert.equal(count,7);
    assert.throws(()=>verifySelectedEvidence({qualified:1}));assert.deepEqual(readdirSync(f.runtimeRoot),[]);
  }finally{f.close();}
});

test('CP0 fresh authority fences denial, revocation, epoch advance and expired scope before reads or commit',async()=>{
  const f=await corpusFixture();let reads=0,writes=0,commits=0;
  const output={put(){writes++;throw Error('no put');},read(){throw Error('no read');}},port={load:()=>null,commit(){commits++;}};
  try{for(const delta of [{status:'REVOKED'},{status:'PAUSED'},{revision:2},{expiresAt:1000},{sourceUse:'UNKNOWN'},{sourceUse:'DENY'},{rights:{retain:true,harvest:false,verify:true}},{runtimeId:'other'}]){
    const admission=()=>({...f.authority,...delta}) as typeof f.authority;
    assert.throws(()=>harvestQualified(f.spec,{selection:f.selection,reader:{read(){reads++;throw Error('no read');}},output,commits:port,admission,now:()=>1000}));
  }assert.equal(reads,0);assert.equal(writes,0);assert.equal(commits,0);
  const store=openCorpusRun({approvedTrainingRoot:f.f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,spec:f.spec,key:f.key,admission:f.admission,mode:'harvest',now:()=>1000});
  try{assert.throws(()=>harvestQualified(f.spec,{...f,...store,now:()=>1000,output:{...store.output,put(kind,bytes){const ref=store.output.put(kind,bytes);writeFileSync(f.authorityPath,canonical({...f.authority,status:'REVOKED'}));return ref;}}}));
    assert.ok(!readdirSync(f.runtimeRoot).includes('corpus-commit.json'));assert.equal(readdirSync(f.runtimeRoot).filter(n=>n.endsWith('.bin')).length,1);
  }finally{store.close();}
  }finally{f.close();}
});

test('CP0 commit failure leaves no exported row; new offline run recovers once, corruption and read-only mutation refuse',async()=>{
  const f=await corpusFixture();let store=openCorpusRun({approvedTrainingRoot:f.f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,spec:f.spec,key:f.key,admission:f.admission,mode:'harvest',now:()=>1000});
  try{
    assert.throws(()=>openCorpusRun({approvedTrainingRoot:f.f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,spec:f.spec,key:f.key,admission:f.admission,mode:'harvest',now:()=>1000}));
    let orphan:ReturnType<typeof harvestQualified>['commit']|undefined;
    assert.throws(()=>harvestQualified(f.spec,{...f,...store,commits:{load:()=>null,commit(record){orphan=record;throw Error('simulated process death before receipt');}},now:()=>1000}));
    assert.ok(orphan);const orphanRef=orphan.manifestRef;assert.throws(()=>verifyCorpusManifest(f.spec,orphanRef,{admission:f.admission,reader:store.output,commits:store.commits,now:()=>1000}));
    assert.equal(store.commits.load(),null);store.close();store=openCorpusRun({approvedTrainingRoot:f.f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,spec:f.spec,key:f.key,admission:f.admission,mode:'harvest',now:()=>1000});
    const result=harvestQualified(f.spec,{...f,...store,now:()=>1000});assert.equal(result.summary.rows,1);assert.equal(readdirSync(f.runtimeRoot).filter(n=>n.endsWith('.bin')).length,6); // three orphan objects remain, never exported
    assert.throws(()=>verifyCorpusManifest(f.spec,result.commit.manifestRef,{admission:f.admission,reader:store.output,commits:{load:()=>({...result.commit,specDigest:hash('wrong')})},now:()=>1000}));
    const verified=verifyCorpusManifest(f.spec,result.commit.manifestRef,{admission:f.admission,reader:store.output,commits:store.commits,now:()=>1000});
    const shard=join(f.runtimeRoot,'train-'+verified.manifest.shardRef.id+'.bin'),bytes=readFileSync(shard);bytes[15]=bytes[15]!^1;writeFileSync(shard,bytes);
    assert.throws(()=>runCorpusCommand(corpusCommandBytes('inspect',f.spec),{...store,admission:f.admission,now:()=>1000}));store.close();
    const cold=openCorpusRun({approvedTrainingRoot:f.f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,spec:f.spec,key:f.key,admission:f.admission,mode:'verify',now:()=>1000});
    try{assert.throws(()=>cold.output.put('corpus-manifest','{}'));assert.throws(()=>cold.commits.commit(result.commit));}finally{cold.close();}
    assert.throws(()=>runCorpusCommand('{"version":"CorpusCommand/0.1","command":"inspect","command":"harvest","spec":null}',{...store,admission:f.admission}));
  }finally{store.close();f.close();}
});
