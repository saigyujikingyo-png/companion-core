import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MEASUREMENT_PROTOCOL,gateSavings} from '../scripts/incremental-storage-measure.ts';
test('measurement freezes three arms, per-workload gates and complete hot filesystem coverage',()=>{
  assert.deepEqual(MEASUREMENT_PROTOCOL.arms,['v2-raw','v3-full-br4','v3-blocks-br4']);assert.equal(MEASUREMENT_PROTOCOL.events,12);
  assert.equal(MEASUREMENT_PROTOCOL.gate.incrementalVsFull,.15);assert.equal(MEASUREMENT_PROTOCOL.gate.incrementalVsV2,.50);
  assert.equal(gateSavings(1000,600,500).pass,true);assert.equal(gateSavings(1000,550,500).pass,false);assert.equal(gateSavings(1000,900,501).pass,false);
  assert.match(MEASUREMENT_PROTOCOL.primaryCoverage,/no backup/);
});
