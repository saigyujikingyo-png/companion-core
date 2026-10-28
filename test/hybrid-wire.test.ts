import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingDigest } from '../src/hybrid-profile.ts';
import type { HybridBinding, HybridLease } from '../src/hybrid-profile.ts';
import { decodeHybridReply, encodeHybridRequest } from '../src/hybrid-wire.ts';
import type { HybridReplyIdentity } from '../src/hybrid-wire.ts';

const hash = 'a'.repeat(64);
const binding:HybridBinding = { namespace:{ tenantId:'fixture/tenant', subjectId:'fixture/subject', personaId:'fixture/persona', relationshipId:'fixture/relation' },
  scopeId:'fixture/scope', generation:0, consentRevision:0, runtimeEpoch:0, permissionEpoch:0,
  sessionId:'fixture/session', purpose:'memory-proposal', evaluationGroup:'fixture/eval', sourceRefs:[{ id:'fixture/source', revision:1 }] };
const lease:HybridLease = { controllerId:'fixture/controller', leaseId:'fixture/lease', epoch:0, profileDigest:hash, bindingDigest:bindingDigest(binding) };
const identity:HybridReplyIdentity = { requestId:'fixture/request', lease, profileDigest:hash };
const selectedEvidence = [{ speakerId:'fixture/subject', speakerRole:'subject', mode:'self_report', selectedText:'Synthetic selected evidence.', occurredAt:null }];
const proposal = { kind:'claim', statement:'Synthetic candidate.', basis:'self_report', validFrom:null, validTo:null };
function body() { return { version:1, kind:'final-proposal', ...identity, proposal }; }
function reply(value:unknown) { return { contentType:'application/json', body:new TextEncoder().encode(JSON.stringify(value)) }; }

test('F04 normalized text final roundtrip uses existing Evidence and Proposal semantics', () => {
  const bytes = encodeHybridRequest({ ...identity, binding, selectedEvidence });
  const request = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(request), ['version','kind','requestId','lease','profileDigest','binding','selectedEvidence']);
  assert.deepEqual(decodeHybridReply(reply(body()), identity), proposal);
  assert.throws(() => encodeHybridRequest({ ...identity, binding, selectedEvidence:[{ ...selectedEvidence[0], speakerId:'fixture/wrong' }] }), /SPEAKER_MISMATCH/u);
  assert.throws(() => decodeHybridReply(reply({ ...body(), proposal:{ ...proposal, kind:'status' } }), identity), /TTL_REQUIRED/u);
  assert.throws(() => decodeHybridReply(reply({ ...body(), proposal:{ ...proposal, basis:'inference' } }), identity), /INFERENCE_IS_NOT_FACT/u);
});

test('F05 image/audio/video/attachment inputs are explicitly outside the text shape', () => {
  for (const field of ['image','audio','video','attachments','tools'])
    assert.throws(() => encodeHybridRequest({ ...identity, binding, selectedEvidence:[{ ...selectedEvidence[0], [field]:'fixture/media' }] }), /HYBRID_WIRE_SHAPE/u);
  assert.throws(() => encodeHybridRequest({ ...identity, binding, selectedEvidence, image:'fixture/image' }), /HYBRID_WIRE_SHAPE/u);
  assert.throws(() => encodeHybridRequest({ ...identity, binding, selectedEvidence:[] }));
});

test('F06 every returned identity stamp must match the exact request', () => {
  for (const field of ['controllerId','leaseId','epoch','profileDigest','bindingDigest'] as const) {
    const changed = field === 'epoch' ? 1 : field.endsWith('Digest') ? 'b'.repeat(64) : 'fixture/other';
    assert.throws(() => decodeHybridReply(reply({ ...body(), lease:{ ...lease, [field]:changed } }), identity), /HYBRID_IDENTITY_MISMATCH/u);
  }
  assert.throws(() => decodeHybridReply(reply({ ...body(), requestId:'fixture/other' }), identity), /HYBRID_IDENTITY_MISMATCH/u);
  assert.throws(() => decodeHybridReply(reply({ ...body(), profileDigest:'b'.repeat(64) }), identity), /HYBRID_IDENTITY_MISMATCH/u);
  for (const kind of ['draft','reasoning','tool','audio']) assert.throws(() => decodeHybridReply(reply({ ...body(), kind }), identity));
});

test('F07 closed final reply rejects malformed bytes, payloads, fields and media', () => {
  for (const bytes of [new Uint8Array([0xc3, 0x28]), new TextEncoder().encode('{'), new Uint8Array(65537)])
    assert.throws(() => decodeHybridReply({ contentType:'application/json', body:bytes }, identity));
  for (const field of ['reasoning','draft','tool','audio','extra'])
    assert.throws(() => decodeHybridReply(reply({ ...body(), [field]:'forbidden' }), identity), /HYBRID_WIRE_SHAPE/u);
  assert.throws(() => decodeHybridReply({ ...reply(body()), contentType:'text/plain' }, identity));
  assert.throws(() => decodeHybridReply({ contentType:'application/json', body:'text' }, identity));
  assert.throws(() => decodeHybridReply(reply({ ...body(), proposal:{ ...proposal, extra:true } }), identity));
  assert.throws(() => decodeHybridReply({ contentType:'application/json', body:new Uint8Array(new SharedArrayBuffer(8)) }, identity));
  let read = false;
  assert.throws(() => decodeHybridReply({ contentType:'application/json', get body() { read = true; return new Uint8Array(); } }, identity));
  assert.equal(read, false);
  const refs = Array.from({ length:16 }, (_, i) => ({ id:`fixture/${i}`, revision:1 }));
  const bigBinding = { ...binding, sourceRefs:refs };
  assert.throws(() => encodeHybridRequest({ ...identity, binding:bigBinding,
    lease:{ ...lease, bindingDigest:bindingDigest(bigBinding) }, selectedEvidence:refs.map(() => ({ ...selectedEvidence[0], selectedText:'界'.repeat(4096) })) }), /HYBRID_BYTE_LIMIT/u);
});
