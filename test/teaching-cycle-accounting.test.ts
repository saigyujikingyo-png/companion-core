import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/wf1-json.ts';
import { deriveChildAccounting } from '../src/teaching-cycle-accounting.ts';
import { runCorpusProduction,verifyProduction } from '../src/corpus-production-runner.ts';
import { corpusResponseDisposition } from '../src/corpus-response-policy.ts';
import { fixture } from './corpus-production-fixture.ts';
import { nativeProduction } from './corpus-policy-v2-fixture.ts';

test('well-formed oversized usage stays isolated and accounting preserves valid subtotals',async()=>{
  const f=fixture(8,undefined,true),native=nativeProduction({usage:'known',change:r=>{if(r.operation==='candidate'&&r.index===0)r.envelope.usage={prompt_tokens:66049,completion_tokens:80,total_tokens:66129,completion_tokens_details:{reasoning_tokens:20}};}});
  try{
    const result=await runCorpusProduction(f.spec,{store:f.store,objective:f.objective,registry:f.registry,transport:native.transport});assert.equal(result.status,'COMPLETED');
    const state=verifyProduction(f.store),bad=state.attempts.find(a=>a.result?.usage?.input===66049)!;assert.ok(bad);assert.equal(bad.result!.usageParseCode,'VALID');assert.deepEqual(corpusResponseDisposition(bad.result,'deepseek',f.store.port(bad.bucket)),{kind:'ISOLATE',code:'USAGE_INVALID'});
    const receipt=deriveChildAccounting('synthetic-child',state,{committedHead:hash('synthetic-head'),ledgerDigest:hash('synthetic-ledger')},bucket=>f.store.port(bucket));
    assert.equal(receipt.usage.invalid,1);assert.equal(receipt.usage.reported,state.attempts.length-1);assert.equal(receipt.usage.knownInputTokens,100*receipt.usage.reported);assert.equal(receipt.usage.knownCompletionTokens,80*receipt.usage.reported);assert.equal(receipt.usage.inputTokens,null);assert.equal(receipt.usage.completionTokens,null);assert.equal(receipt.items.rejected,4);assert.equal(receipt.items.accepted,4);
  }finally{f.store.close();}
});
