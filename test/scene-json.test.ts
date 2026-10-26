import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSceneJson, normalizeSceneJson } from '../src/scene-json.ts';

const code = (expected:string) => (error:unknown) => error instanceof Error && error.message === expected;

test('scene JSON rejects decoded duplicate keys, including escaped aliases', () => {
  assert.throws(() => parseSceneJson('{"a":1,"\\u0061":2}'), code('SCENE_DUPLICATE_KEY'));
});
test('scene JSON refuses non-string input without coercion or callbacks', () => {
  let reads=0;
  const input=new Proxy({}, {get(){reads++;throw new Error('CALLER');}});
  assert.throws(() => parseSceneJson(input as never), code('SCENE_INVALID_JSON'));
  assert.equal(reads,0);
});
test('scene normalization sorts decoded UTF-16 keys and preserves strings and arrays', () => {
  assert.equal(normalizeSceneJson('{"b":[2,1],"a":"e\\u0301"}'), '{"a":"é","b":[2,1]}');
});

test('scene JSON checks exact UTF-8 bytes before parsing, including one-byte overflow', () => {
  const text='"杯"';
  const exact=text+' '.repeat(65_536-Buffer.byteLength(text));
  assert.equal(parseSceneJson(exact),'杯');
  assert.throws(()=>parseSceneJson(exact+' '),code('SCENE_LIMIT'));
});
test('scene JSON bounds depth, every value/key node, arrays and object properties', () => {
  assert.equal(normalizeSceneJson('['.repeat(15)+'0'+']'.repeat(15)).length,31);
  assert.throws(()=>parseSceneJson('['.repeat(16)+'0'+']'.repeat(16)),code('SCENE_LIMIT'));
  const nodes:unknown[]=Array.from({length:16},()=>Array(254).fill(0));nodes.push(...Array(15).fill(0));
  assert.doesNotThrow(()=>parseSceneJson(JSON.stringify(nodes)));
  nodes.push(0);assert.throws(()=>parseSceneJson(JSON.stringify(nodes)),code('SCENE_LIMIT'));
  assert.doesNotThrow(()=>parseSceneJson(JSON.stringify(Array(256).fill(0))));
  assert.throws(()=>parseSceneJson(JSON.stringify(Array(257).fill(0))),code('SCENE_LIMIT'));
  const object=Object.fromEntries(Array.from({length:64},(_,i)=>['k'+i,0]));
  assert.doesNotThrow(()=>parseSceneJson(JSON.stringify(object)));
  object.extra=0;assert.throws(()=>parseSceneJson(JSON.stringify(object)),code('SCENE_LIMIT'));
});
test('scene JSON bounds decoded string units and aggregate string units', () => {
  assert.equal((parseSceneJson(JSON.stringify('x'.repeat(2048))) as string).length,2048);
  assert.throws(()=>parseSceneJson(JSON.stringify('x'.repeat(2049))),code('SCENE_LIMIT'));
  const strings=Array(16).fill('x'.repeat(2048));
  assert.doesNotThrow(()=>parseSceneJson(JSON.stringify(strings)));
  strings.push('x');assert.throws(()=>parseSceneJson(JSON.stringify(strings)),code('SCENE_LIMIT'));
});
test('scene JSON refuses isolated surrogates, invalid syntax and nonstandard whitespace', () => {
  for(const raw of ['"\\ud800"','"\\udc00"','"\ud800"','"a\n"','"\\x41"','[1,]','{"a":1,}',
    '01','+1','NaN','Infinity','undefined','null false','\ufeffnull','\u00a0null'])
    assert.throws(()=>parseSceneJson(raw),code('SCENE_INVALID_JSON'));
  assert.equal(parseSceneJson('"\\ud83d\\ude00"'),'😀');
  assert.equal(parseSceneJson('"😀"'),'😀');
});
test('scene JSON finite binary64 profile rejects unsafe integers, negative zero, underflow and rounded integers', () => {
  for(const raw of ['1E400','9007199254740992','-9007199254740992','-0','-0.0','1e-999',
    '-1e-999','1.00000000000000001','9007199254740991.1'])
    assert.throws(()=>parseSceneJson(raw),code('SCENE_INVALID_JSON'));
  for(const raw of ['9007199254740991','-9007199254740991','100e-2','0e999','1.25','5e-324'])
    assert.equal(parseSceneJson(raw),Number(raw));
  assert.doesNotThrow(()=>parseSceneJson('0e'+'0'.repeat(126)));
  assert.throws(()=>parseSceneJson('0e'+'0'.repeat(127)),code('SCENE_LIMIT'));
});
test('scene JSON safely parses dangerous property names as own data, never prototype setters', () => {
  const parsed=parseSceneJson('{"__proto__":{"polluted":true},"constructor":1}') as Record<string,unknown>;
  assert.equal(Object.getPrototypeOf(parsed),null);
  assert.equal(Object.hasOwn(parsed,'__proto__'),true);
  assert.equal(Object.hasOwn({},'polluted'),false);
});
