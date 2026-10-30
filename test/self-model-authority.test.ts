import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/store.ts';
import { CoreError } from '../src/validation.ts';
import type { EventInput, Proposal } from '../src/contracts.ts';

const identity = { tenantId:'synthetic', subjectId:'synthetic-self', personaId:'neutral', relationshipId:'self' };
const claim: Proposal = { kind:'claim', statement:'SYNTHETIC identity remains undecided', basis:'self_report', validFrom:null, validTo:null };
const event = (eventKey: string): EventInput => ({ source:'synthetic-host', eventKey,
  evidence:{ speakerId:identity.subjectId, speakerRole:'subject', mode:'self_report', selectedText:claim.statement, occurredAt:null } });
const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
const storeForTest = () => new MemoryStore(':memory:', { clock:{ wall:()=>1_000_000, monotonic:()=>0 } });

test('self scope rejects conflicting caregiver declarations and self-report laundering', { timeout:3000 }, () => {
  const store=storeForTest();
  try {
    const scope=store.ensureScope(identity);
    assert.throws(()=>store.acceptEvent(scope,{...event('caregiver-self-report'),evidence:{...event('x').evidence,speakerId:'synthetic-caregiver',speakerRole:'third_party'}}),code('SPEAKER_MISMATCH'));
    assert.throws(()=>store.acceptEvent(scope,{...event('wrong-subject'),evidence:{...event('x').evidence,speakerId:'synthetic-caregiver'}}),code('SPEAKER_MISMATCH'));
    for(const mode of ['observation','quotation'] as const){
      const source=store.acceptEvent(scope,{...event(mode),evidence:{...event('x').evidence,speakerId:'synthetic-caregiver',speakerRole:'third_party',mode}});
      const job=store.beginJob(scope,[source]),lease=store.claimLease(scope,job.id);
      assert.throws(()=>store.propose(scope,job.id,lease.token,claim),code('SPEAKER_MISMATCH'));
    }
  } finally { store.close(); }
});

test('matching subject labels and consent changes still rely on the trusted host caller', { timeout:3000 }, () => {
  const store=storeForTest();
  try {
    const scope=store.ensureScope(identity);
    // No authenticated actor parameter exists here: this characterizes the
    // current trusted-host API, not a proof that only the subject can call it.
    const source=store.acceptEvent(scope,event('declared-self'));
    const job=store.beginJob(scope,[source]),lease=store.claimLease(scope,job.id);
    store.propose(scope,job.id,lease.token,claim);
    const receipt=store.publish(scope,job.id,lease.token);
    assert.equal(store.read(scope,{id:receipt.id,revision:1})!.statement,claim.statement);
    const next=store.setLearningConsent(scope,true);
    assert.equal(next.learningAllowed,true);
    assert.equal(next.consentRevision,scope.consentRevision+1);
    assert.equal(next.runtimeEpoch,scope.runtimeEpoch+1);
    assert.throws(()=>store.acceptEvent(scope,event('stale-consent')),code('STALE_CONSENT'));
  } finally { store.close(); }
});
