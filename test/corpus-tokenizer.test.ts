import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonical,hash } from '../src/wf1-json.ts';
import { collectEvidence,verifySelectedEvidence } from '../src/corpus-harvest.ts';
import { measureCorpusManifest,measureCorpusRow,validateTokenizerProfile,verifyCorpusTokenMeasurement } from '../src/corpus-tokenizer.ts';
import { harvestQualified,openCorpusRun } from '../src/corpus-manifest.ts';
import type { CorpusTokenizerProfile } from '../src/corpus-tokenizer.ts';
import { corpusFixture } from './fixtures/corpus-fixture.ts';

test('CP0 tokenizer profile rejects unpinned, download-capable or approximate settings',()=>{
  const p={version:'CorpusTokenizer/0.1',model:'synthetic/wordlevel',revision:'a'.repeat(40),assetRoot:process.cwd(),tokenizerSha256:hash('tokenizer'),templateSha256:hash('template'),runtime:{python:'3.12.14',tokenizers:'0.23.3',jinja2:'3.1.6',markupsafe:'3.0.4'},templatePolicy:'SFT_USER_ASSISTANT_NO_THINKING/1',addSpecialTokens:false,maxInputBytes:65536,maxTokens:65536,officialPipelineParity:'NOT_VALIDATED'};
  validateTokenizerProfile(p);for(const change of [{revision:'main'},{addSpecialTokens:true},{trustRemoteCode:true},{maxTokens:1000000},{officialPipelineParity:'VERIFIED'},{assetRoot:'relative'}])assert.throws(()=>validateTokenizerProfile({...p,...change}));
});

// Optional Python extra: CI Core remains dependency-free; author runs this against pinned public libraries.
test('CP0 local pinned CPU worker exactly counts synthetic IDs and loss suffix; hash/runtime/prefix drift refuses', {skip:!process.env.CP0_TOKENIZER_PYTHON,timeout:30000},async()=>{
  const f=await corpusFixture();try{
    const python=process.env.CP0_TOKENIZER_PYTHON!,version=spawnSync(python,['-I','-B','-c','import platform; print(platform.python_version())'],{encoding:'utf8',timeout:5000,maxBuffer:1024,windowsHide:true});
    assert.equal(version.status,0);const pythonVersion=version.stdout.trim();assert.match(pythonVersion,/^3\.12\.(10|14)$/);
    const root=join(f.f.base,'artificial-tokenizer');mkdirSync(root);
    const tokenizer=canonical({version:'1.0',truncation:null,padding:null,added_tokens:[],normalizer:null,pre_tokenizer:{type:'WhitespaceSplit'},post_processor:null,decoder:null,model:{type:'WordLevel',vocab:{'[UNK]':0,user:1,assistant:2,end:3},unk_token:'[UNK]'}});
    const template='user {{ messages[0].content }} assistant {% if not add_generation_prompt %}{{ messages[1].content }} end{% endif %}';
    writeFileSync(join(root,'tokenizer.json'),tokenizer);writeFileSync(join(root,'chat_template.jinja'),template);
    const profile:CorpusTokenizerProfile={version:'CorpusTokenizer/0.1',model:'synthetic/wordlevel',revision:'a'.repeat(40),assetRoot:root,tokenizerSha256:hash(tokenizer),templateSha256:hash(template),runtime:{python:pythonVersion,tokenizers:'0.23.3',jinja2:'3.1.6',markupsafe:'3.0.4'},templatePolicy:'SFT_USER_ASSISTANT_NO_THINKING/1',addSpecialTokens:false,maxInputBytes:65536,maxTokens:65536,officialPipelineParity:'NOT_VALIDATED'};
    const row={...verifySelectedEvidence(collectEvidence(f.selection,f.reader)),evidenceRef:f.selection.candidate.targetRef!};
    const result=measureCorpusRow(row,profile,python);assert.equal(result.studentInputTokens,'3');assert.equal(result.studentLossTokens,'2');assert.equal(result.fullTokens,'5');
    assert.equal(result.inputIdsDigest,hash(canonical([1,0,2])));assert.equal(result.fullIdsDigest,hash(canonical([1,0,2,0,3])));assert.equal(result.lossMaskDigest,hash(canonical([0,0,0,1,1])));assert.equal(result.actualTrainerParity,'NOT_RUN');assert.equal(result.trainingReady,false);
    const store=openCorpusRun({approvedTrainingRoot:f.f.approvedTrainingRoot,runtimeRoot:f.runtimeRoot,spec:f.spec,key:f.key,admission:f.admission,mode:'harvest',now:()=>1000});
    try{
      const harvested=harvestQualified(f.spec,{...f,...store,now:()=>1000}),manifestBefore=store.output.read(harvested.commit.manifestRef);
      const measured=measureCorpusManifest(f.spec,harvested.commit.manifestRef,profile,{admission:f.admission,reader:store.output,commits:store.commits,output:store.output,pythonPath:python,now:()=>1000});
      assert.equal(measured.measurement.fullTokens,'5');assert.ok(store.output.read(measured.measurementRef).length>0);assert.deepEqual(store.output.read(harvested.commit.manifestRef),manifestBefore);
      const record=JSON.parse(store.output.read(measured.measurementRef).toString());record.measurement.studentLossTokens='9';
      const wrong=store.output.put('corpus-token-measurement',canonical(record));assert.throws(()=>verifyCorpusTokenMeasurement(f.spec,harvested.commit.manifestRef,wrong,profile,{admission:f.admission,reader:store.output,commits:store.commits,pythonPath:python,now:()=>1000}));
      store.close();
      const tokenizerUrl=new URL('../src/corpus-tokenizer.ts',import.meta.url).href,manifestUrl=new URL('../src/corpus-manifest.ts',import.meta.url).href,jsonUrl=new URL('../src/wf1-json.ts',import.meta.url).href;
      const source=`import {readFileSync} from 'node:fs';import {verifyCorpusTokenMeasurement} from ${JSON.stringify(tokenizerUrl)};import {openCorpusRun} from ${JSON.stringify(manifestUrl)};import {parseJson} from ${JSON.stringify(jsonUrl)};const admission=()=>parseJson(readFileSync(${JSON.stringify(f.authorityPath)},'utf8'));let raw='';for await(const c of process.stdin){raw+=c;if(raw.length>16384)throw Error('bounded');}const config=parseJson(raw),store=openCorpusRun({approvedTrainingRoot:${JSON.stringify(f.f.approvedTrainingRoot)},runtimeRoot:${JSON.stringify(f.runtimeRoot)},spec:config.spec,key:Buffer.alloc(32,19),admission,mode:'verify',now:()=>1000});try{process.stdout.write(JSON.stringify(verifyCorpusTokenMeasurement(config.spec,config.manifestRef,config.measurementRef,config.profile,{admission,reader:store.output,commits:store.commits,pythonPath:${JSON.stringify(python)},now:()=>1000})));}finally{store.close();}`;
      const cold=spawnSync(process.execPath,['--input-type=module','--eval',source],{input:canonical({spec:f.spec,manifestRef:harvested.commit.manifestRef,measurementRef:measured.measurementRef,profile}),encoding:'utf8',timeout:10000,maxBuffer:16384,windowsHide:true});
      assert.equal(cold.status,0,cold.stderr);assert.equal(JSON.parse(cold.stdout).rowDigest,measured.measurement.rowDigest);assert.equal(JSON.parse(cold.stdout).fullIdsDigest,measured.measurement.fullIdsDigest);
      assert.equal(JSON.parse(manifestBefore.toString()).status,'HARVESTED_TOKENIZATION_PENDING');
    }finally{store.close();}
    assert.throws(()=>measureCorpusRow(row,{...profile,tokenizerSha256:hash('wrong')},python));
    assert.throws(()=>measureCorpusRow(row,{...profile,runtime:{...profile.runtime,tokenizers:'0.0.0'}},python));
    const mismatched='{% if add_generation_prompt %}end {% endif %}'+template;writeFileSync(join(root,'chat_template.jinja'),mismatched);
    assert.throws(()=>measureCorpusRow(row,{...profile,templateSha256:hash(mismatched)},python));
  }finally{f.close();}
});
