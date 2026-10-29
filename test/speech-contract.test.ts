import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalSpeech,
  prepareSpeechPlan,
  speechEffectKey,
  speechHash,
  speechResourceKey,
} from '../src/speech-contract.ts';
import { capabilities, plan, profile, text } from './fixtures/speech-synthetic.ts';
test('F27 deep snapshot and canonical fingerprints preserve accepted source metadata', () => {
  const input = structuredClone(plan()),
    accepted = prepareSpeechPlan(input, text, capabilities),
    before = canonicalSpeech(accepted);
  (input.sourceRefs[0] as { id: string }).id = 'changed';
  (input.profile as { rate: number }).rate = 1;
  assert.equal(canonicalSpeech(accepted), before);
  assert.ok(Object.isFrozen(accepted.sourceRefs[0]));
  assert.ok(Object.isFrozen(accepted.profile));
  assert.throws(() => prepareSpeechPlan(input, text + 'changed', capabilities), /EXPRESSION_MISMATCH/);
});
test('F04 C002 stable effect key excludes all changing expression and lifecycle fields', () => {
  const a = plan(),
    b = plan(a.speechIntentId, { utteranceId: 'other', turnId: 'other', binding: { ...a.binding, runtimeEpoch: 1 } });
  assert.equal(speechEffectKey(a), speechEffectKey(b));
  assert.notEqual(speechHash(canonicalSpeech(a)), speechHash(canonicalSpeech(b)));
  assert.equal(
    speechResourceKey(a),
    speechResourceKey({ ...a, profile: { ...profile, transportProfileId: 'different' } }),
  );
});
test('F15 exact profiles and whole utterance only, with closed bounded input', () => {
  assert.throws(() => prepareSpeechPlan({ ...plan(), extra: true }, text, capabilities), /INVALID_SHAPE/);
  assert.throws(
    () => prepareSpeechPlan(plan('x', { profile: { ...profile, deviceTokenId: 'missing' } }), text, capabilities),
    /UNSUPPORTED_PROFILE/,
  );
  assert.throws(
    () =>
      prepareSpeechPlan(
        plan('x', { chunk: { mode: 'whole-utterance', index: 1, final: true } as never }),
        text,
        capabilities,
      ),
    /UNSUPPORTED_CHUNK/,
  );
  assert.throws(
    () =>
      prepareSpeechPlan(
        plan('x', {
          sourceRefs: [
            { id: 'same', revision: 0 },
            { id: 'same', revision: 1 },
          ],
        }),
        text,
        capabilities,
      ),
    /DUPLICATE_SOURCE/,
  );
  assert.throws(() => prepareSpeechPlan(plan('x', { maxUtteranceMs: 5001 }), text, capabilities), /INVALID_NUMBER/);
  assert.throws(
    () =>
      prepareSpeechPlan(
        plan('x', { expression: { ...plan().expression, kind: 'draft' as never } }),
        text,
        capabilities,
      ),
    /EXPRESSION_MISMATCH/,
  );
  const getter = { ...plan() };
  Object.defineProperty(getter, 'hostId', {
    enumerable: true,
    get() {
      throw new Error('must not invoke');
    },
  });
  assert.throws(() => prepareSpeechPlan(getter, text, capabilities), /INVALID_SHAPE/);
  assert.throws(
    () => prepareSpeechPlan(plan('sparse', { sourceRefs: new Array(1) }), text, capabilities),
    /INVALID_SOURCE_ARRAY/,
  );
  const withAccessor: unknown[] = [];
  Object.defineProperty(withAccessor, '0', {
    enumerable: true,
    get() {
      throw new Error('must not invoke');
    },
  });
  assert.throws(
    () => prepareSpeechPlan({ ...plan(), sourceRefs: withAccessor }, text, capabilities),
    /INVALID_SOURCE_ARRAY/,
  );
});
test('F18 literal text preserves quotes, angle brackets, newline and filename-looking values', () => {
  const literal = '<speak>literal</speak>\nC:\\synthetic.wav "quoted"';
  const p = plan('literal', {
    expression: { ...plan().expression, sha256: speechHash(literal), utf8Bytes: Buffer.byteLength(literal) },
  });
  assert.equal(prepareSpeechPlan(p, literal, capabilities).expression.sha256, speechHash(literal));
  const long = 'a'.repeat(241);
  assert.throws(
    () =>
      prepareSpeechPlan(
        plan('long', { expression: { ...p.expression, sha256: speechHash(long), utf8Bytes: 241 } }),
        long,
        capabilities,
      ),
    /INVALID_EXPRESSION/,
  );
});
