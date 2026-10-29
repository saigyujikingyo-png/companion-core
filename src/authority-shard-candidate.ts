import {randomUUID} from 'node:crypto';
import {isProxy,isSharedArrayBuffer,isUint8Array} from 'node:util/types';
import {markAsUntransferable} from 'node:worker_threads';
import {id} from './anchored-codec.ts';
import {sha,record} from './durable-codec.ts';
import {fail} from './validation.ts';
import {ColdWorkspace} from './authority-cold-storage.ts';
import {COLD_LIMITS,ColdDatabase,ROW_KEYS,emptyCounts,hashRows,keyCompare,copyRow,safeSum,utf8,parsed,
  normalizeCold,validateRequest,validateReceipt,json} from './authority-cold-format.ts';
import type {RawRow,Counts,Workspace,Release,ColdInput} from './authority-cold-format.ts';
import {normalizeRollover,decodeReceiptSegment,parseReceiptPointer,receiptPointer,validateReceiptEntry} from './receipt-segments.ts';
import type {ReceiptEntry} from './receipt-segments.ts';

type Kind=Exclude<RawRow['kind'],'V'>;
const KINDS=['R','S','L','M'] as const;
const COUNT={R:'receipts',S:'segments',L:'legacy',M:'operations'} as const;
const STATUS='UNANCHORED_CANDIDATE' as const;
const ABSENT=Object.freeze({status:STATUS,outcome:'CANDIDATE_ABSENT' as const});
export type CandidateRow=Readonly<{kind:Kind;values:readonly (string|number|Uint8Array)[];epoch:number}>;
export type CandidateResult<T>=typeof ABSENT|Readonly<{status:typeof STATUS;outcome:'CANDIDATE_FOUND';value:T;close():void}>;
export interface CandidateView {
  readonly status:typeof STATUS;
  raw(kind:Kind,key:string,operationId?:string):CandidateResult<CandidateRow>;
  legacyByMigration(key:string):CandidateResult<CandidateRow>;
  legacyByVault(key:string):CandidateResult<CandidateRow>;
  receipt(vaultId:string,operationId:string):CandidateResult<string>;
  maintenance(input:ColdInput):CandidateResult<CandidateRow>;
  close():void;
}
export interface ShardCandidate {
  readonly status:typeof STATUS;
  readonly parts:readonly [Uint8Array,Uint8Array];
  readonly workspace:Readonly<{used:number;peak:number;limit:number}>;
  open(parts:readonly [Uint8Array,Uint8Array]):CandidateView;
  close():void;
}

// Intrinsic getters avoid caller-defined buffer/length accessors. Shared and
// resizable backing stores cannot supply a stable snapshot and are rejected.
const typed=Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferOf=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!;
const lengthOf=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!;
const offsetOf=Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!;
const resizableOf=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')!.get!;
const fillBytes=Uint8Array.prototype.fill;
// A distinct object over the same storage: caller-owned properties/prototypes on
// an exposed view must never participate in teardown or BLOB identification.
function privateView(value:Uint8Array):Uint8Array {
  return new Uint8Array(bufferOf.call(value) as ArrayBuffer,offsetOf.call(value) as number,lengthOf.call(value) as number);
}
function wipe(view:Uint8Array):void{fillBytes.call(view,0);}
function bytesView(value:unknown):Uint8Array {
  if(isProxy(value)||!isUint8Array(value))fail('CANDIDATE_BYTES');
  const buffer=bufferOf.call(value) as ArrayBuffer;
  if(isSharedArrayBuffer(buffer)||resizableOf.call(buffer))fail('CANDIDATE_BYTES');
  const length=lengthOf.call(value) as number;
  if(length<4096||length>COLD_LIMITS.payload||length%4096)fail('CANDIDATE_PAYLOAD');
  return new Uint8Array(buffer,offsetOf.call(value) as number,length);
}
function pair(value:unknown):[Uint8Array,Uint8Array] {
  if(isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length!==2
    ||Reflect.ownKeys(value).length!==3)fail('CANDIDATE_PARTS');
  const a=Object.getOwnPropertyDescriptor(value,'0'),b=Object.getOwnPropertyDescriptor(value,'1');
  if(!a||!b||!Object.hasOwn(a,'value')||!Object.hasOwn(b,'value'))fail('CANDIDATE_PARTS');
  const views:[Uint8Array,Uint8Array]=[bytesView(a.value),bytesView(b.value)];
  if(safeSum(views[0].byteLength,views[1].byteLength)>COLD_LIMITS.payload)fail('CANDIDATE_PAYLOAD');
  return views;
}
function snapshot(view:Uint8Array,w:Workspace){
  const release=w.reserve(view.byteLength,'candidate input snapshot');
  try{const bytes=Buffer.from(view);return{bytes,close:()=>{try{wipe(bytes);}finally{release();}}};}catch(e){release();throw e;}
}
/** Existing typed, length-prefixed framing; hash kind and EVERY primary-key component. */
function partition(kind:Kind,keys:readonly string[]):0|1 {
  const hash=hashRows();hash.add({kind,values:[...keys],epoch:0});
  return (Number.parseInt(hash.finish().slice(0,2),16)&1) as 0|1;
}
function rowPartition(row:RawRow):0|1{return partition(row.kind as Kind,row.values.slice(0,ROW_KEYS[row.kind]) as string[]);}
function* merged(dbs:readonly ColdDatabase[],kind:Kind):Generator<RawRow>{
  if(dbs.length===1){yield*dbs[0]!.rows(kind);return;}
  const a=dbs[0]!.rows(kind),b=dbs[1]!.rows(kind);
  try{let x=a.next(),y=b.next();while(!x.done||!y.done){
    if(x.done){yield y.value!;y=b.next();}else if(y.done){yield x.value;x=a.next();}
    else{const order=keyCompare(x.value,y.value);if(!order)fail('CANDIDATE_DUPLICATE');
      if(order<0){yield x.value;x=a.next();}else{yield y.value;y=b.next();}}
  }}finally{a.return(undefined);b.return(undefined);}
}
function using<T>(dbs:readonly ColdDatabase[],kind:Kind,index:number,key:string,read:(row:RawRow)=>T,secondary?:string):T|null {
  let result:T|null=null,found=false;
  for(const db of dbs)for(const row of db.rows(kind,index,key,secondary)){
    if(found)fail('CANDIDATE_DUPLICATE');found=true;result=read(row);
  }
  return result;
}
function decoded<T>(row:RawRow,w:Workspace,read:(entries:ReceiptEntry[])=>T):T {
  const [segmentId,requestBytes,digest,n,encoded,count,jsonBytes,payload]=row.values;
  if(!(requestBytes instanceof Uint8Array)||requestBytes.length<1||requestBytes.length>512
    ||!(payload instanceof Uint8Array)||encoded!==payload.length||!Number.isSafeInteger(n)||(n as number)<1||(n as number)>1048576)fail('ANCHOR_RECEIPT_SEGMENT');
  const request=normalizeRollover(parsed(requestBytes));
  if(JSON.stringify(request)!==utf8(requestBytes)||request.operationId!==segmentId||(n as number)>request.maxJsonBytes||(count as number)>request.maxReceipts)fail('ANCHOR_RECEIPT_SEGMENT');
  const release=w.reserve(safeSum((n as number)*3,1024),'IF8 output buffer, UTF8 JSON and entries');
  let entries:ReceiptEntry[]=[];
  try{entries=decodeReceiptSegment(payload,segmentId as string,n as number,digest as string,count as number,jsonBytes as number);return read(entries);}
  finally{entries.length=0;release();}
}
/** Candidate-local consistency only. No V/current head, admission, fencing or authority identity authentication. */
function validate(dbs:readonly ColdDatabase[],w:Workspace):{digest:string;counts:Counts} {
  const hash=hashRows(),counts=emptyCounts();let pointers=0,expected=0;
  const epochs=new Set<number>();
  for(const kind of KINDS)for(const row of merged(dbs,kind)){
    counts[COUNT[kind]]++;
    for(const key of row.values.slice(0,ROW_KEYS[kind]))id(key as string);
    // Include epoch in the same unambiguous framing, not only the original values.
    hash.add({kind,values:[...row.values,row.epoch],epoch:0});
    if(kind==='R'){
      const value=utf8(row.values[2] as Uint8Array);
      if(parseReceiptPointer(value))pointers++;
      else validateReceiptEntry({vaultId:row.values[0] as string,operationId:row.values[1] as string,json:value});
    }else if(kind==='S')decoded(row,w,entries=>{
      expected+=entries.length;
      for(const [i,e] of entries.entries()){
        const found=using(dbs,'R',0,e.vaultId,r=>utf8(r.values[2] as Uint8Array)===receiptPointer(row.values[0] as string,i,Buffer.byteLength(e.json)),e.operationId);
        if(found!==true)fail('ANCHOR_RECEIPT_SEGMENT');
      }
    });
    else if(kind==='L'){
      const state=parsed(row.values[3] as Uint8Array);
      if(!record(state)||state.version!==1||state.lineageId!==row.values[0]||state.migrationId!==row.values[1]||state.vaultId!==row.values[2])fail('CANDIDATE_LEGACY');
      for(const i of [1,2]){id(row.values[i] as string);using(dbs,'L',i,row.values[i] as string,()=>true);}
    }else{
      const request=validateRequest(parsed(row.values[1] as Uint8Array)),receipt=parsed(row.values[2] as Uint8Array);
      validateReceipt(receipt,request);
      if(request.operationId!==row.values[0]||json(request,8192)!==utf8(row.values[1] as Uint8Array)
        ||json(receipt,8192)!==utf8(row.values[2] as Uint8Array)||receipt.toEpoch!==row.epoch-1||epochs.has(receipt.toEpoch))fail('CANDIDATE_MAINTENANCE');
      epochs.add(receipt.toEpoch);
    }
  }
  if(pointers!==expected)fail('ANCHOR_RECEIPT_SEGMENT');
  return{digest:hash.finish(),counts};
}

/** RAM-only candidate, bound to this construction. Never an authority, active root or archive operation. */
export function buildCandidate(sourceBytes:Uint8Array,workspaceLimit:number=COLD_LIMITS.workspace):ShardCandidate {
  const w=new ColdWorkspace(workspaceLimit),fixed=w.reserve(65536,'candidate metadata, key framing and handle bookkeeping');
  let source:ReturnType<typeof snapshot>|undefined,db:ColdDatabase|undefined;
  const outputs:ReturnType<ColdDatabase['serialize']>[]=[],views=new Set<()=>void>();
  let closed=false;
  const close=()=>{if(closed)return;closed=true;for(const end of views)end();views.clear();for(const out of outputs)out.close();outputs.length=0;source?.close();source=undefined;fixed();};
  try{
    source=snapshot(bytesView(sourceBytes),w);db=ColdDatabase.open(source.bytes,w);
    const expected=validate([db],w),counts=[emptyCounts(),emptyCounts()],operationId='ac1-candidate-'+randomUUID();
    const requestDigest=sha(JSON.stringify(normalizeCold({operationId,expectedRouteEpoch:db.meta.fromEpoch})));
    for(const kind of KINDS)for(const row of db.rows(kind))counts[rowPartition(row)]![COUNT[kind]]++;
    for(const p of [0,1] as const){
      const sourceDB=db;
      function* rows(){for(const kind of KINDS)for(const row of sourceDB.rows(kind))if(rowPartition(row)===p)yield row;}
      const part=ColdDatabase.build({...db.meta,operationId,requestDigest,counts:counts[p]!},rows(),w);
      try{const output=part.serialize();outputs.push(output);markAsUntransferable(output.bytes.buffer);}finally{part.close();}
    }
    if(safeSum(...outputs.map(o=>o.bytes.length))>COLD_LIMITS.payload)fail('CANDIDATE_PAYLOAD');
    const digests=outputs.map(o=>sha(o.bytes)),sizes=outputs.map(o=>o.bytes.length);
    db.close();db=undefined;
    // ColdDatabase.serialize.close owns its original byte object. Expose only
    // separate views so caller changes cannot affect that existing cleanup code.
    const parts=Object.freeze([privateView(outputs[0]!.bytes),privateView(outputs[1]!.bytes)] as const);
    const check=()=>{if(closed)fail('CANDIDATE_CLOSED');};
    return Object.freeze({status:STATUS,parts,get workspace(){return Object.freeze({used:w.used,peak:w.peak,limit:w.limit});},close,
      open(input:readonly [Uint8Array,Uint8Array]):CandidateView {
        check();const incoming=pair(input),opened:ColdDatabase[]=[],copies:ReturnType<typeof snapshot>[]=[];
        const results=new Set<()=>void>();let ended=false;
        const end=()=>{if(ended)return;ended=true;for(const done of results)done();results.clear();for(const d of opened)d.close();opened.length=0;views.delete(end);};
        const active=()=>{check();if(ended)fail('CANDIDATE_CLOSED');};
        function found<T>(value:T,release:Release,clear:()=>void):CandidateResult<T>{
          let live=true,held:T|undefined=value;
          const done=()=>{if(!live)return;live=false;try{clear();}finally{held=undefined;release();results.delete(done);}};
          results.add(done);
          return Object.freeze({status:STATUS,outcome:'CANDIDATE_FOUND' as const,get value(){active();if(!live)fail('CANDIDATE_CLOSED');return held!;},close:done});
        }
        function returned(row:RawRow):CandidateResult<CandidateRow>{
          const owned=copyRow(row,w),values=Object.freeze(owned.row.values);
          const cleanup=values.filter(isUint8Array).map(value=>privateView(value as Uint8Array));
          for(const view of cleanup)markAsUntransferable(view.buffer);
          return found(Object.freeze({kind:row.kind as Kind,values,epoch:row.epoch}),owned.close,()=>{for(const view of cleanup)wipe(view);});
        }
        function lookup(kind:Kind,key:string,secondary?:string):CandidateResult<CandidateRow>{
          active();if(!KINDS.includes(kind))fail('CANDIDATE_KEY');id(key);
          if(kind==='R'){id(secondary!);}else if(secondary!==undefined)fail('CANDIDATE_KEY');
          const route=partition(kind,kind==='R'?[key,secondary!]:[key]);
          return using([opened[route]!],kind,0,key,returned,secondary)??ABSENT;
        }
        try{
          // Snapshot all caller buffers before opening either image; no caller root/digest is accepted.
          for(const p of [0,1] as const){copies.push(snapshot(incoming[p],w));
            if(copies[p]!.bytes.length!==sizes[p]||sha(copies[p]!.bytes)!==digests[p])fail('CANDIDATE_BINDING');}
          for(const copy of copies)opened.push(ColdDatabase.open(copy.bytes,w));
          for(const p of [0,1] as const)for(const kind of KINDS)for(const row of opened[p]!.rows(kind))if(rowPartition(row)!==p)fail('CANDIDATE_PARTITION');
          const actual=validate(opened,w);
          if(actual.digest!==expected.digest||JSON.stringify(actual.counts)!==JSON.stringify(expected.counts))fail('CANDIDATE_SOURCE');
          views.add(end);
          return Object.freeze({status:STATUS,raw:lookup,
            legacyByMigration(key:string){active();id(key);return using(opened,'L',1,key,returned)??ABSENT;},
            legacyByVault(key:string){active();id(key);return using(opened,'L',2,key,returned)??ABSENT;},
            receipt(vaultId:string,operationId:string):CandidateResult<string>{
              active();id(vaultId);id(operationId);
              const keep=(value:string)=>{const release=w.reserve(safeSum(Buffer.byteLength(value)*2,1024),'candidate returned receipt');return found(value,release,()=>{});};
              return using([opened[partition('R',[vaultId,operationId])]!],'R',0,vaultId,row=>{
                const value=utf8(row.values[2] as Uint8Array),pointer=parseReceiptPointer(value);if(!pointer)return keep(value);
                const result=using([opened[partition('S',[pointer.segmentId])]!],'S',0,pointer.segmentId,s=>decoded(s,w,entries=>{
                  const entry=entries[pointer.index];if(!entry||entry.vaultId!==vaultId||entry.operationId!==operationId||Buffer.byteLength(entry.json)!==pointer.jsonBytes)fail('ANCHOR_RECEIPT_SEGMENT');return keep(entry.json);
                }));if(!result)fail('ANCHOR_RECEIPT_SEGMENT');return result;
              },operationId)??ABSENT;
            },
            maintenance(input:ColdInput):CandidateResult<CandidateRow>{
              active();const request=normalizeCold(input);
              return using([opened[partition('M',[request.operationId])]!],'M',0,request.operationId,row=>{if(json(request,8192)!==utf8(row.values[1] as Uint8Array))fail('CANDIDATE_CONFLICT');return returned(row);})??ABSENT;
            },close:end});
        }catch(e){end();throw e;}finally{for(const copy of copies)copy.close();}
      }});
  }catch(e){db?.close();close();throw e;}
}
