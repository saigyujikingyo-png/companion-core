import assert from 'node:assert/strict';
import test from 'node:test';
import { HYBRID_LIMITS, HYBRID_PROTOCOL, bindingDigest, profileDigest, validateHybridBinding, validateHybridProfile } from '../src/hybrid-profile.ts';
import type { HybridBinding, HybridProfile } from '../src/hybrid-profile.ts';

const hash = 'a'.repeat(64), other = 'b'.repeat(64);
function profile(): HybridProfile { return { version:1, profileId:'fixture/hybrid',
  model:{ id:'fixture/model', revision:'a'.repeat(40), sha256:hash, precision:'fixture/fp32' },
  tokenizer:{ id:'fixture/tokenizer', revision:hash, sha256:hash }, processor:{ id:'fixture/processor', revision:hash, sha256:hash },
  chatTemplateSha256:hash, adapterSha256:null, routerAuxSha256:null,
  runtime:{ id:'fixture/runtime', buildSha256:hash, kernelSha256:hash, cacheLayoutSha256:hash, topologySha256:hash },
  modelModalities:['text','image','video'], stateFamilies:['attention-kv','ssm','convolution','position-prefix'], protocol:HYBRID_PROTOCOL }; }
function binding(): HybridBinding { return { namespace:{ tenantId:'fixture/tenant', subjectId:'fixture/subject', personaId:'fixture/persona', relationshipId:'fixture/relation' },
  scopeId:'fixture/scope', generation:0, consentRevision:0, runtimeEpoch:0, permissionEpoch:0,
  sessionId:'fixture/session', purpose:'memory-proposal', evaluationGroup:'fixture/eval', sourceRefs:[{ id:'fixture/source', revision:1 }] }; }

test('F01 canonical full profile identity and independent frozen copy', () => {
  const p = profile(), digest = profileDigest(p), copy = validateHybridProfile(p);
  assert.equal(profileDigest(copy), digest);
  assert.notEqual(copy.model, p.model); assert(Object.isFrozen(copy)); assert(Object.isFrozen(copy.runtime));
  const paths = [['profileId'],['model','id'],['model','revision'],['model','sha256'],['model','precision'],
    ['tokenizer','id'],['tokenizer','revision'],['tokenizer','sha256'],['processor','id'],['processor','revision'],['processor','sha256'],
    ['chatTemplateSha256'],['adapterSha256'],['routerAuxSha256'],['runtime','id'],['runtime','buildSha256'],
    ['runtime','kernelSha256'],['runtime','cacheLayoutSha256'],['runtime','topologySha256']];
  for (const path of paths) {
    const modified = structuredClone(p) as unknown as Record<string, unknown>;
    const parent = path.length === 1 ? modified : modified[path[0]!] as Record<string, unknown>;
    const key = path.at(-1)!;
    parent[key] = key === 'id' || key === 'profileId' || key === 'precision' ? 'fixture/changed' : other;
    assert.notEqual(profileDigest(modified), digest, path.join('.'));
  }
  assert.equal(profileDigest({ ...p, modelModalities:[...p.modelModalities].reverse(), stateFamilies:[...p.stateFamilies].reverse() }), digest);
  assert.notEqual(profileDigest({ ...p, modelModalities:['text'] }), digest);
  assert.notEqual(profileDigest({ ...p, stateFamilies:[...p.stateFamilies, 'vision'] }), digest);
});

test('F02 strict shapes reject proxy/accessor/symbol/float/duplicate/UTF-8 overflow without invocation', () => {
  const p = profile(); let touched = 0;
  const getter = Object.defineProperty({ ...p }, 'model', { enumerable:true, get() { touched++; return p.model; } });
  const proxy = new Proxy(p, { ownKeys() { touched++; return []; } });
  const sparse = new Array(4); sparse[0] = 'attention-kv';
  const badProfiles:unknown[] = [{ ...p, extra:true }, { ...p, protocol:undefined }, getter, proxy,
    { ...p, [Symbol('extra')]:true }, { ...p, model:{ ...p.model, revision:'main' } }, { ...p, chatTemplateSha256:hash.toUpperCase() },
    { ...p, profileId:'界'.repeat(43) }, { ...p, profileId:'fixture/\n' }, { ...p, profileId:'\ud800' },
    { ...p, stateFamilies:sparse }, { ...p, modelModalities:['text','text'] }, { ...p, stateFamilies:['attention-kv'] }];
  for (const bad of badProfiles) assert.throws(() => validateHybridProfile(bad));
  assert.equal(touched, 0);
  assert.equal(validateHybridProfile({ ...p, profileId:'fixture/\ud83d\ude00' }).profileId, 'fixture/\ud83d\ude00');
  const b = binding();
  for (const bad of [{ ...b, generation:Number.MAX_SAFE_INTEGER + 1 }, { ...b, runtimeEpoch:-1 },
    { ...b, sourceRefs:[...b.sourceRefs, ...b.sourceRefs] }, { ...b, sourceRefs:[{ id:'fixture/source', revision:0 }] },
    { ...b, sourceRefs:Array.from({ length:17 }, (_, i) => ({ id:`fixture/${i}`, revision:1 })) },
    { ...b, sourceRefs:new Proxy([...b.sourceRefs], {}) }, { ...b, namespace:{ ...b.namespace, extra:true } }]) assert.throws(() => validateHybridBinding(bad));
  assert.equal(HYBRID_LIMITS.profileBytes, 8192); assert.equal(HYBRID_LIMITS.bindingBytes, 8192);
});

test('F03 every binding dimension and ordered source participates in digest', () => {
  const b = binding(), digest = bindingDigest(b);
  for (const key of ['tenantId','subjectId','personaId','relationshipId'] as const)
    assert.notEqual(bindingDigest({ ...b, namespace:{ ...b.namespace, [key]:'fixture/other' } }), digest);
  for (const key of ['scopeId','sessionId','evaluationGroup'] as const) assert.notEqual(bindingDigest({ ...b, [key]:'fixture/other' }), digest);
  for (const key of ['generation','consentRevision','runtimeEpoch','permissionEpoch'] as const) assert.notEqual(bindingDigest({ ...b, [key]:1 }), digest);
  assert.throws(() => bindingDigest({ ...b, purpose:'training' }));
  assert.notEqual(bindingDigest({ ...b, sourceRefs:[{ id:'fixture/source', revision:2 }] }), digest);
  const refs = [{ id:'fixture/a', revision:1 }, { id:'fixture/b', revision:1 }];
  assert.notEqual(bindingDigest({ ...b, sourceRefs:refs }), bindingDigest({ ...b, sourceRefs:refs.toReversed() }));
  assert(Object.isFrozen(validateHybridBinding(b).sourceRefs[0]));
});
