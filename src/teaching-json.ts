import { createHash } from 'node:crypto';
import { fail } from './validation.ts';
import { TEACHING_LIMITS as L } from './teaching-types.ts';
import type { TeachingFrozen } from './teaching-types.ts';

export type TeachingJson = null|boolean|number|string|TeachingJson[]|{ [key:string]:TeachingJson };
const forbidden = (key:string):boolean => ['__proto__','constructor','prototype'].includes(key);
function invalid():never { return fail('WF0_INVALID_JSON'); }
function unicode(value:string):void {
  for (let i=0;i<value.length;i++) {
    const c=value.charCodeAt(i);
    if (c>=0xd800 && c<=0xdbff) { const n=value.charCodeAt(++i); if (!(n>=0xdc00 && n<=0xdfff)) invalid(); }
    else if (c>=0xdc00 && c<=0xdfff) invalid();
  }
}
/** A separate bounded profile: duplicate decoded keys are rejected, never last-key-wins. */
export function parseTeachingJson(raw:string):TeachingJson {
  if (typeof raw!=='string') invalid();
  if (Buffer.byteLength(raw,'utf8')>L.jsonBytes) fail('WF0_LIMIT');
  let pos=0, nodes=0;
  const charge=():void => { if (++nodes>L.jsonNodes) fail('WF0_LIMIT'); };
  const ws=():void => { while (pos<raw.length && /[\x20\x09\x0a\x0d]/.test(raw[pos]!)) pos++; };
  const string=():string => {
    const start=pos++;
    while (pos<raw.length) {
      const c=raw.charCodeAt(pos++);
      if (c===34) {
        let result:string; try { result=JSON.parse(raw.slice(start,pos)) as string; } catch { return invalid(); }
        if (result.length>L.stringUnits) fail('WF0_LIMIT'); unicode(result); return result;
      }
      if (c<32) invalid();
      if (c===92) {
        const e=raw[pos++];
        if (e==='u') { if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(pos,pos+4))) invalid(); pos+=4; }
        else if (!e || !'"\\/bfnrt'.includes(e)) invalid();
      }
      if (pos-start>L.stringUnits*6+1) fail('WF0_LIMIT');
    }
    return invalid();
  };
  const number=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value=(depth:number):TeachingJson => {
    if (depth>L.jsonDepth) fail('WF0_LIMIT'); charge(); ws(); const c=raw[pos];
    if (c==='"') return string();
    if (c==='{' || c==='[') {
      const object=c==='{' , out:Record<string,TeachingJson>=Object.create(null) as Record<string,TeachingJson>, array:TeachingJson[]=[];
      pos++; ws(); const end=object?'}':']'; let count=0;
      if (raw[pos]===end) { pos++; return object?out:array; }
      while (true) {
        if (++count>(object?L.objectKeys:L.arrayItems)) fail('WF0_LIMIT'); ws(); let key='';
        if (object) {
          if (raw[pos]!=='"') invalid(); charge(); key=string();
          if (forbidden(key)) fail('WF0_INVALID_FIELD');
          if (Object.hasOwn(out,key)) fail('WF0_DUPLICATE_KEY');
          ws(); if (raw[pos++]!==':') invalid();
        }
        const child=value(depth+1); if (object) out[key]=child; else array.push(child);
        ws(); const next=raw[pos++]; if (next===end) break; if (next!==',') invalid();
      }
      return object?out:array;
    }
    for (const [token,result] of [['null',null],['true',true],['false',false]] as const) {
      if (raw.startsWith(token,pos)) { pos+=token.length; return result; }
    }
    number.lastIndex=pos; const match=number.exec(raw); if (!match || match[0].length>32) return invalid();
    // Reject non-integer spellings before Number can round a fraction or underflow an exponent.
    if (!/^(?:0|[1-9][0-9]*)$/.test(match[0])) fail('WF0_INVALID_NUMBER');
    pos=number.lastIndex; const n=Number(match[0]);
    if (!Number.isSafeInteger(n) || n<0 || Object.is(n,-0)) fail('WF0_INVALID_NUMBER'); return n;
  };
  const out=value(0); ws(); if (pos!==raw.length) invalid(); return out;
}
/** Object callers get a detached data-only snapshot. Accessors are never invoked.
 * Proxies are outside this trusted in-process API; external inputs must use JSON. */
export function ownTeachingJson(input:unknown):TeachingJson {
  if (typeof input==='string') return parseTeachingJson(input);
  let nodes=0, bytes=0; const active=new Set<object>();
  const copy=(v:unknown, depth:number):TeachingJson => {
    if (++nodes>L.jsonNodes || depth>L.jsonDepth) fail('WF0_LIMIT');
    if (v===null || typeof v==='boolean') return v;
    if (typeof v==='number') { if (!Number.isSafeInteger(v) || v<0 || Object.is(v,-0)) fail('WF0_INVALID_NUMBER'); return v; }
    if (typeof v==='string') {
      if (v.length>L.stringUnits) fail('WF0_LIMIT'); unicode(v); bytes+=Buffer.byteLength(v,'utf8');
      if (bytes>L.jsonBytes) fail('WF0_LIMIT'); return v;
    }
    if (typeof v!=='object' || active.has(v)) invalid();
    const array=Array.isArray(v), proto=Object.getPrototypeOf(v) as unknown;
    if (proto!==(array?Array.prototype:Object.prototype) && !(proto===null && !array)) invalid();
    const keys=Reflect.ownKeys(v); if (keys.length>(array?L.arrayItems+1:L.objectKeys)) fail('WF0_LIMIT');
    active.add(v); const out:Record<string,TeachingJson>=Object.create(null) as Record<string,TeachingJson>, list:TeachingJson[]=[];
    if (array && v.length>L.arrayItems) fail('WF0_LIMIT');
    for (const key of keys) {
      if (array && key==='length') continue;
      if (typeof key!=='string' || forbidden(key)) fail('WF0_INVALID_FIELD');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key)>=v.length)) invalid();
      const d=Object.getOwnPropertyDescriptor(v,key)!;
      if (!d.enumerable || !Object.hasOwn(d,'value')) invalid();
      if (array) list[Number(key)]=copy(d.value,depth+1); else { copy(key,depth+1); out[key]=copy(d.value,depth+1); }
    }
    if (array && (list.length!==v.length || keys.length!==v.length+1)) invalid();
    active.delete(v); return array?list:out;
  };
  const out=copy(input,0); if (Buffer.byteLength(canonicalTeachingJson(out),'utf8')>L.jsonBytes) fail('WF0_LIMIT'); return out;
}
/** Internal callers use only validated, bounded JSON; key ordering is locale independent. */
export function canonicalTeachingJson(value:unknown):string {
  if (Array.isArray(value)) return '['+value.map(canonicalTeachingJson).join(',')+']';
  if (value!==null && typeof value==='object') return '{'+Object.keys(value).sort().map(key=>
    JSON.stringify(key)+':'+canonicalTeachingJson((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
export function teachingDigest(input:unknown):string {
  return createHash('sha256').update(canonicalTeachingJson(ownTeachingJson(input))).digest('hex');
}
export function freezeTeaching<T>(value:T):TeachingFrozen<T> {
  if (value!==null && typeof value==='object') { for (const child of Object.values(value)) freezeTeaching(child); Object.freeze(value); }
  return value as TeachingFrozen<T>;
}
