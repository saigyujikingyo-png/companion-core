import { fail } from './validation.ts';

export type SceneJson = null | boolean | number | string | SceneJson[] | { [key:string]:SceneJson };
export const SCENE_JSON_LIMITS = Object.freeze({ bytes:65_536, depth:16, nodes:4_096,
  stringUnits:2_048, totalStringUnits:32_768, arrayItems:256, objectKeys:64, numberUnits:128 });

/** SP0's stricter JSON profile, not a replacement for the existing Core wire parser. */
export function parseSceneJson(raw:string):SceneJson {
  if (typeof raw !== 'string') fail('SCENE_INVALID_JSON');
  if (Buffer.byteLength(raw,'utf8') > SCENE_JSON_LIMITS.bytes) fail('SCENE_LIMIT');
  let pos=0, nodes=0, stringUnits=0;
  const invalid=():never => fail('SCENE_INVALID_JSON');
  const charge=():void => { if (++nodes > SCENE_JSON_LIMITS.nodes) fail('SCENE_LIMIT'); };
  const whitespace=():void => { while (pos<raw.length && /[\x20\x09\x0a\x0d]/.test(raw[pos]!)) pos++; };
  const string=():string => {
    const start=pos++;
    while (pos<raw.length) {
      const unit=raw.charCodeAt(pos++);
      if (unit===34) {
        let result:string;
        try { result=JSON.parse(raw.slice(start,pos)) as string; } catch { return invalid(); }
        if (result.length>SCENE_JSON_LIMITS.stringUnits) fail('SCENE_LIMIT');
        stringUnits+=result.length;
        if (stringUnits>SCENE_JSON_LIMITS.totalStringUnits) fail('SCENE_LIMIT');
        for (let i=0;i<result.length;i++) {
          const c=result.charCodeAt(i);
          if (c>=0xd800 && c<=0xdbff) {
            const next=result.charCodeAt(++i);
            if (!(next>=0xdc00 && next<=0xdfff)) invalid();
          } else if (c>=0xdc00 && c<=0xdfff) invalid();
        }
        return result;
      }
      if (unit<32) invalid();
      if (unit===92) {
        const escape=raw[pos++];
        if (escape==='u') {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(pos,pos+4))) invalid();
          pos+=4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) invalid();
      }
      // A decoded string cannot be longer than this six-unit-per-character spelling.
      if (pos-start>SCENE_JSON_LIMITS.stringUnits*6+1) fail('SCENE_LIMIT');
    }
    return invalid();
  };
  const numberPattern=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value=(depth:number):SceneJson => {
    if (depth>SCENE_JSON_LIMITS.depth) fail('SCENE_LIMIT');
    charge(); whitespace();
    const current=raw[pos];
    if (current==='"') return string();
    if (current==='{' || current==='[') {
      const isObject=current==='{' ; pos++; whitespace();
      const object:Record<string,SceneJson>=Object.create(null) as Record<string,SceneJson>, array:SceneJson[]=[];
      const end=isObject?'}':']'; let entries=0;
      if (raw[pos]===end) {pos++;return isObject?object:array;}
      while (true) {
        if (++entries>(isObject?SCENE_JSON_LIMITS.objectKeys:SCENE_JSON_LIMITS.arrayItems)) fail('SCENE_LIMIT');
        whitespace(); let key='';
        if (isObject) {
          if (raw[pos]!=='"') invalid(); charge(); key=string();
          if (Object.hasOwn(object,key)) fail('SCENE_DUPLICATE_KEY');
          whitespace(); if (raw[pos++]!==':') invalid();
        }
        const child=value(depth+1);
        if (isObject) object[key]=child; else array.push(child);
        whitespace(); const next=raw[pos++];
        if (next===end) break;
        if (next!==',') invalid();
      }
      return isObject?object:array;
    }
    for (const [token,result] of [['null',null],['true',true],['false',false]] as const) {
      if (raw.startsWith(token,pos)) {pos+=token.length;return result;}
    }
    numberPattern.lastIndex=pos;
    const match=numberPattern.exec(raw);
    if (!match) return invalid();
    const token=match[0]; pos=numberPattern.lastIndex;
    if (token.length>SCENE_JSON_LIMITS.numberUnits) fail('SCENE_LIMIT');
    const result=Number(token), mantissa=token.split(/[eE]/)[0]!;
    if (!Number.isFinite(result) || Object.is(result,-0) || (result===0 && /[1-9]/.test(mantissa))) invalid();
    if (Number.isInteger(result) && (!Number.isSafeInteger(result) || !exactInteger(token,result))) invalid();
    return result;
  };
  const result=value(1); whitespace();
  if (pos!==raw.length) invalid();
  return result;
}

/** Integer-valued binary64 results must not hide rounded fractional or oversized tokens. */
function exactInteger(token:string, result:number):boolean {
  const [mantissa,exponent='0']=token.toLowerCase().split('e');
  const negative=mantissa!.startsWith('-'), unsigned=negative?mantissa!.slice(1):mantissa!;
  const [whole,fraction='']=unsigned.split('.');
  let digits=(whole!+fraction).replace(/^0+/,'');
  if (!digits) return result===0;
  const scale=Number(exponent)-fraction.length;
  if (!Number.isSafeInteger(scale)) return false;
  if (scale<0) {
    const remove=-scale;
    if (remove>=digits.length || !/^0*$/.test(digits.slice(-remove))) return false;
    digits=digits.slice(0,-remove);
  } else {
    if (digits.length+scale>16) return false;
    digits+='0'.repeat(scale);
  }
  return BigInt((negative?'-':'')+digits)===BigInt(result);
}

/** Scene canonical-json-v1: no Unicode normalization; UTF-16 key order; array order retained. */
export function normalizeSceneJson(raw:string):string {
  const render=(value:SceneJson):string => {
    if (Array.isArray(value)) return '['+value.map(render).join(',')+']';
    if (value!==null && typeof value==='object') return '{'+Object.keys(value).sort().map(key=>
      JSON.stringify(key)+':'+render(value[key]!)).join(',')+'}';
    return JSON.stringify(value);
  };
  return render(parseSceneJson(raw));
}
