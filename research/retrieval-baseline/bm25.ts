import { types } from 'node:util';
import { RETRIEVAL_LIMITS } from '../../src/retrieval-types.ts';
import { fail, text } from '../../src/validation.ts';

export type Bm25Hit = Readonly<{ ordinal:number; score:number }>;
const normalize = (value:string) => value.normalize('NFKC').toLowerCase();

/** Conservative serialized working-representation reservation, NOT a heap estimate.
 * Per decomposed UTF-16 unit: 6 bytes normalized text + 6 bytes term key +
 * 16 bytes TF tuple/count/separator. There cannot be more terms than units.
 * NFKD bounds later NFKC composition; default lowercase expansion is counted
 * before reservation. The scalar scratch is bounded independently of input size.
 * The fixed envelope covers 32 doc lengths/maps, 32 ordinal/score results and query.
 * Reject before allocating a full normalized string, match array or TF map.
 */
export function bm25WorkingReservation(statements:readonly string[],query:string,limit=8):number {
  text(query,256);
  if(!Number.isSafeInteger(limit)||limit<1||limit>32)fail('INVALID_INPUT');
  if(types.isProxy(statements)||!Array.isArray(statements)||Object.getPrototypeOf(statements)!==Array.prototype)fail('INVALID_INPUT');
  const length=statements.length;
  if(length>RETRIEVAL_LIMITS.selected)fail('RETRIEVAL_LIMIT');
  if(Reflect.ownKeys(statements).length!==length+1)fail('INVALID_INPUT');
  // Validate the entire bounded input before any Unicode expansion.
  for(let i=0;i<length;i++) {
    const d=Object.getOwnPropertyDescriptor(statements,String(i));
    if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'||d.value.length>4096||d.value.includes('\0'))fail('INVALID_INPUT');
  }
  let reserved=4_352;
  const charge=(value:string)=>{
    for(const scalar of value) {
      reserved+=28*scalar.normalize('NFKD').toLowerCase().length;
      if(reserved>RETRIEVAL_LIMITS.bytes)fail('BM25_WORKING_LIMIT');
    }
  };
  charge(query);
  for(const value of statements)charge(value);
  if(!normalize(query).trim())fail('INVALID_INPUT');
  return reserved;
}

/** Pure synchronous research scorer. Inputs are trusted synthetic selected strings;
 * ordinals are array offsets, never Store references, candidates or capabilities.
 */
export function rankBm25(statements:readonly string[],query:string,limit=8):readonly Bm25Hit[] {
  bm25WorkingReservation(statements,query,limit);
  const queryTerms=[...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu)??[])];
  const documents=statements.map(statement=>{
    const counts=new Map<string,number>();let length=0;
    for(const match of normalize(statement).matchAll(/[\p{L}\p{N}]+/gu)) {
      const term=match[0];counts.set(term,(counts.get(term)??0)+1);length++;
    }
    return {counts,length};
  });
  const n=documents.length,total=documents.reduce((sum,doc)=>sum+doc.length,0);
  if(!n||!total||!queryTerms.length)return Object.freeze([]);
  const avgdl=total/n,k1=1.2,b=0.75,scores=new Array<number>(n).fill(0);
  for(const term of queryTerms) {
    const df=documents.reduce((sum,doc)=>sum+Number(doc.counts.has(term)),0);
    const idf=Math.log(1+(n-df+0.5)/(df+0.5));
    for(const [ordinal,doc] of documents.entries()) {
      const tf=doc.counts.get(term)??0;
      if(tf)scores[ordinal]!+=idf*tf*(k1+1)/(tf+k1*(1-b+b*doc.length/avgdl));
    }
  }
  return Object.freeze(scores.map((score,ordinal)=>({ordinal,score})).filter(hit=>hit.score>0)
    .sort((a,b)=>b.score-a.score||a.ordinal-b.ordinal).slice(0,limit).map(hit=>Object.freeze(hit)));
}
