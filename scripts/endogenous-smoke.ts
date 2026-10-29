import assert from 'node:assert/strict';
import { EndogenousOwner } from '../src/endogenous-lifecycle.ts';
import type { EndogenousRequest } from '../src/endogenous-lifecycle.ts';

// Real referenced Node timers, zero external input and a fixed synthetic decision port.
// beforeExit (rather than a polling observer or forced exit) proves normal lifecycle drain.
const started = performance.now();
const requests: Array<Pick<EndogenousRequest, 'trigger' | 'sequence'>> = [];
const owner = new EndogenousOwner({
  limits: { maxCalls: 2, maxDurationMs: 2_000, callTimeoutMs: 500, maxResultBytes: 512 },
});
const session = owner.bind(async (request) => {
  requests.push({ trigger: request.trigger, sequence: request.sequence });
  return request.sequence === 1 ? '{"version":1,"choice":"REST","nextWakeInMs":40}' : '{"version":1,"choice":"NOOP"}';
});
process.once('beforeExit', () => {
  const snapshot = owner.read();
  assert.deepEqual(requests, [
    { trigger: 'boot', sequence: 1 },
    { trigger: 'wake', sequence: 2 },
  ]);
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.outcome),
    ['REST', 'NOOP'],
  );
  assert.equal(snapshot.callsConsumed, 2);
  assert.equal(snapshot.state, 'exhausted');
  assert.equal(snapshot.code, 'CAPACITY');
  assert.equal(snapshot.actualPending, false);
  assert.equal(snapshot.timerPending, false);
  assert.ok(performance.now() - started >= 40);
  owner.close();
  console.log(
    JSON.stringify({
      status: 'E1A_ZERO_INPUT_SMOKE_PASS',
      triggerSequence: requests.map((x) => x.trigger),
      outcomes: snapshot.entries.map((x) => x.outcome),
      syntheticDecisions: snapshot.callsConsumed,
      externalInputs: 0,
      modelCalls: 0,
      toolCalls: 0,
      communication: 0,
      actualPending: false,
      timerPending: false,
      stop: snapshot.code,
      elapsedMs: Math.round(performance.now() - started),
      rssBytes: process.memoryUsage().rss,
    }),
  );
});
session.start();
