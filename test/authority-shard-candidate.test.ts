import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,realpathSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildCandidate} from '../src/authority-shard-candidate.ts';
import type {CandidateResult,CandidateRow} from '../src/authority-shard-candidate.ts';
import {ColdWorkspace} from '../src/authority-cold-storage.ts';
import {ColdDatabase,COLD_FORMAT,COLD_LIMITS,emptyCounts,hashRows,normalizeCold,receiptOf,descriptorOf} from '../src/authority-cold-format.ts';
import type {ColdMeta,RawRow,Intent} from '../src/authority-cold-format.ts';
import {encodeReceiptSegment,normalizeRollover,receiptPointer} from '../src/receipt-segments.ts';
import {sha} from '../src/durable-codec.ts';
import {LocalSqliteAuthority} from '../src/local-sqlite-authority.ts';
import {AnchoredVault} from '../src/anchored-vault.ts';
import {generateKeySet} from '../src/anchored-codec.ts';

const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
const receipt=(operationId:string,extra='synthetic')=>JSON.stringify({version:2,operationId,newHead:{vaultId:'vault'},extra});
function route(kind:RawRow['kind'],...keys:string[]):number{const h=hashRows();h.add({kind,values:keys,epoch:0});return Number.parseInt(h.finish().slice(0,2),16)&1;}
function meta(rows:RawRow[]):ColdMeta {
  const request=normalizeCold({operationId:'ac1-source',expectedRouteEpoch:1}),counts=emptyCounts();
  for(const row of rows)counts[({R:'receipts',S:'segments',L:'legacy',M:'operations'} as const)[row.kind as 'R'|'S'|'L'|'M']]++;
  return{format:COLD_FORMAT,version:1,authorityId:'synthetic',custodyDomain:'independent',operationId:request.operationId,
    requestDigest:sha(JSON.stringify(request)),fromEpoch:1,toEpoch:2,parentPayloadDigest:'c'.repeat(64),sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),counts};
}
function payload(rows:RawRow[]):Buffer {
  const w=new ColdWorkspace(),db=ColdDatabase.build(meta(rows),rows,w);
  try{const out=db.serialize();try{return Buffer.from(out.bytes);}finally{out.close();}}finally{db.close();assert.equal(w.used,0);}
}
function sourceRows():RawRow[] {
  const operationId='if8-receipt',body=receipt(operationId,'原字节'),p=route('R','vault',operationId);
  let segmentId='segment-0';for(let i=0;route('S',segmentId)===p;i++)segmentId='segment-'+(i+1);
  const encoded=encodeReceiptSegment(segmentId,[{vaultId:'vault',operationId,json:body}],1048576),request=normalizeCold({operationId:'ac1-earlier',expectedRouteEpoch:0});
  const intent:Intent={format:'companion-authority-cold-intent-v1',version:1,slot:0,authorityId:'synthetic',custodyDomain:'independent',request,
    requestDigest:sha(JSON.stringify(request)),fromEpoch:0,toEpoch:1,parentPayloadDigest:null,sourceSnapshotDigest:'a'.repeat(64),selectionDigest:'b'.repeat(64),
    counts:{...emptyCounts(),receipts:1},moved:{...emptyCounts(),receipts:1,framedBytes:128,skipped:{receipts:0,segments:0,legacy:0}},payloadBytes:32768,payloadDigest:'d'.repeat(64)};
  const maintenance=receiptOf(intent,descriptorOf(intent,bytes(intent)));
  return[
    {kind:'R',values:['vault','raw',Buffer.from('{ "version":2, "operationId":"raw", "newHead":{"vaultId":"vault"}, "extra":"原始格式" }')],epoch:1},
    {kind:'R',values:['vault',operationId,Buffer.from(receiptPointer(segmentId,0,Buffer.byteLength(body)))],epoch:2},
    {kind:'S',values:[segmentId,bytes(normalizeRollover({operationId:segmentId})),encoded.digest,encoded.decodedBytes,encoded.payload.length,1,encoded.jsonBytes,encoded.payload],epoch:2},
    {kind:'L',values:['lineage','migration','legacy-vault',bytes({version:1,lineageId:'lineage',migrationId:'migration',vaultId:'legacy-vault',extra:'declaration only'})],epoch:1},
    {kind:'M',values:[request.operationId,bytes(request),bytes(maintenance)],epoch:2},
  ];
}
function found<T>(result:CandidateResult<T>):Extract<CandidateResult<T>,{outcome:'CANDIDATE_FOUND'}>{
  assert.equal(result.status,'UNANCHORED_CANDIDATE');assert.equal(result.outcome,'CANDIDATE_FOUND');
  if(result.outcome!=='CANDIDATE_FOUND')throw Error('expected candidate data');return result;
}
function rawEqual(actual:CandidateRow,expected:RawRow){assert.equal(actual.kind,expected.kind);assert.equal(actual.epoch,expected.epoch);assert.equal(actual.values.length,expected.values.length);for(let i=0;i<actual.values.length;i++){const a=actual.values[i],b=expected.values[i];if(a instanceof Uint8Array&&b instanceof Uint8Array)assert.deepEqual(Buffer.from(a),Buffer.from(b));else assert.equal(a,b);}}

test('candidate R/S/L/M retains every raw byte and moved epoch; IF8 crosses the fixed full-key partition',()=>{
  const rows=sourceRows(),source=payload(rows),before=sha(source),candidate=buildCandidate(source),view=candidate.open(candidate.parts);
  try{
    assert.equal(candidate.status,'UNANCHORED_CANDIDATE');assert.equal(view.status,'UNANCHORED_CANDIDATE');assert.equal(sha(source),before);
    assert.ok(candidate.parts[0].length+candidate.parts[1].length<=COLD_LIMITS.payload);
    const r=rows[1]!,s=rows[2]!;assert.notEqual(route('R',r.values[0] as string,r.values[1] as string),route('S',s.values[0] as string));
    for(const row of rows){const item=found(view.raw(row.kind as 'R'|'S'|'L'|'M',row.values[0] as string,row.kind==='R'?row.values[1] as string:undefined));try{rawEqual(item.value,row);}finally{item.close();}}
    for(const item of [view.legacyByMigration('migration'),view.legacyByVault('legacy-vault')]){const x=found(item);rawEqual(x.value,rows[3]!);x.close();}
    const decoded=found(view.receipt('vault','if8-receipt'));assert.equal(decoded.value,receipt('if8-receipt','原字节'));decoded.close();
    const raw=found(view.receipt('vault','raw'));assert.equal(raw.value,Buffer.from(rows[0]!.values[2] as Uint8Array).toString());raw.close();
    const m=found(view.maintenance({operationId:'ac1-earlier',expectedRouteEpoch:0}));rawEqual(m.value,rows[4]!);m.close();
    assert.throws(()=>view.maintenance({operationId:'ac1-earlier',expectedRouteEpoch:1}),/CANDIDATE_CONFLICT/);
    for(const missing of [view.raw('R','vault','missing'),view.raw('S','missing'),view.raw('L','missing'),view.raw('M','missing'),view.receipt('vault','missing'),view.legacyByMigration('missing'),view.legacyByVault('missing'),view.maintenance({operationId:'ac1-missing',expectedRouteEpoch:0})])assert.deepEqual(missing,{status:'UNANCHORED_CANDIDATE',outcome:'CANDIDATE_ABSENT'});
  }finally{view.close();candidate.close();}assert.equal(candidate.workspace.used,0);
});

test('source and opened parts are snapshots; closed views/results revoke access and repeated close is harmless',()=>{
  const source=payload(sourceRows()),candidate=buildCandidate(source),input=[Buffer.from(candidate.parts[0]),Buffer.from(candidate.parts[1])] as const;
  source.fill(0);const view=candidate.open(input),base=candidate.workspace.used;input[0].fill(0);input[1].fill(0);
  const value=found(view.raw('R','vault','raw')),held=value.value.values[2] as Uint8Array;
  assert.throws(()=>structuredClone(candidate.parts[0].buffer,{transfer:[candidate.parts[0].buffer]}),/Cannot transfer/);
  assert.throws(()=>structuredClone(held.buffer,{transfer:[held.buffer]}),/Cannot transfer/);
  assert.ok(candidate.workspace.used>base);value.close();value.close();assert.equal(candidate.workspace.used,base);assert.ok(held.every(n=>n===0));assert.throws(()=>value.value,/CANDIDATE_CLOSED/);
  const live=found(view.receipt('vault','raw'));view.close();view.close();assert.throws(()=>live.value,/CANDIDATE_CLOSED/);assert.throws(()=>view.raw('R','vault','absent'),/CANDIDATE_CLOSED/);
  const another=candidate.open(candidate.parts),row=found(another.raw('L','lineage'));candidate.close();candidate.close();row.close();another.close();assert.equal(candidate.workspace.used,0);assert.throws(()=>row.value,/CANDIDATE_CLOSED/);assert.throws(()=>candidate.open(candidate.parts),/CANDIDATE_CLOSED/);
});

test('caller BLOB fill overrides/getters/prototypes cannot interrupt result, view or candidate cleanup',()=>{
  const source=payload(sourceRows());
  for(const mode of ['own-fill','fill-getter','prototype'] as const)for(const scope of ['result','view','candidate'] as const){
    const candidate=buildCandidate(source),view=candidate.open(candidate.parts),base=candidate.workspace.used;
    const result=found(view.raw('R','vault','raw')),blob=result.value.values[2] as Uint8Array;
    // Hold a pristine inspection view before the caller changes the public object.
    const inspect=new Uint8Array(blob.buffer,blob.byteOffset,blob.byteLength);let calls=0;
    if(mode==='own-fill')Object.defineProperty(blob,'fill',{value(){calls++;throw Error('CALLER_FILL');}});
    else if(mode==='fill-getter')Object.defineProperty(blob,'fill',{get(){calls++;throw Error('CALLER_GETTER');}});
    else Object.setPrototypeOf(blob,null);
    assert.ok(inspect.some(n=>n!==0));
    if(scope==='result'){result.close();result.close();assert.equal(candidate.workspace.used,base);}
    else if(scope==='view'){view.close();view.close();}
    else{candidate.close();candidate.close();}
    assert.ok(inspect.every(n=>n===0),`${mode}/${scope} clears the original BLOB`);assert.equal(calls,0);
    assert.throws(()=>result.value,/CANDIDATE_CLOSED/);result.close();view.close();candidate.close();candidate.close();assert.equal(candidate.workspace.used,0);
  }
});

test('caller part fill overrides/getters/prototypes leave open views independent and cannot block candidate close',()=>{
  const source=payload(sourceRows());
  for(const mode of ['own-fill','fill-getter','prototype'] as const){
    const candidate=buildCandidate(source),view=candidate.open(candidate.parts),raw=found(view.raw('R','vault','raw'));
    const resultBlob=raw.value.values[2] as Uint8Array,resultInspect=new Uint8Array(resultBlob.buffer,resultBlob.byteOffset,resultBlob.byteLength);
    const inspections=candidate.parts.map(p=>new Uint8Array(p.buffer,p.byteOffset,p.byteLength));let calls=0;
    for(const part of candidate.parts){
      if(mode==='own-fill')Object.defineProperty(part,'fill',{value(){calls++;throw Error('CALLER_PART_FILL');}});
      else if(mode==='fill-getter')Object.defineProperty(part,'fill',{get(){calls++;throw Error('CALLER_PART_GETTER');}});
      else Object.setPrototypeOf(part,null);
    }
    const receiptResult=found(view.receipt('vault','raw'));assert.ok(receiptResult.value.includes('原始格式'));
    candidate.close();candidate.close();view.close();raw.close();receiptResult.close();
    for(const inspect of inspections)assert.ok(inspect.every(n=>n===0),`${mode} clears both payloads`);
    assert.ok(resultInspect.every(n=>n===0));assert.equal(calls,0);assert.equal(candidate.workspace.used,0);
    assert.throws(()=>raw.value,/CANDIDATE_CLOSED/);assert.throws(()=>receiptResult.value,/CANDIDATE_CLOSED/);
  }
});

test('missing, swapped, duplicated, tampered and same-source other-construction parts cannot be candidate absence',()=>{
  const source=payload(sourceRows()),a=buildCandidate(source),b=buildCandidate(source),used=a.workspace.used;
  try{
    const bad=Buffer.from(a.parts[0]);bad[bad.length-1]=bad[bad.length-1]!^1;
    const inputs:unknown[]=[[a.parts[0]],[a.parts[1],a.parts[0]],[a.parts[0],a.parts[0]],[bad,a.parts[1]],[b.parts[0],a.parts[1]],[a.parts[0],b.parts[1]],b.parts,[a.parts[0],a.parts[1],a.parts[0]]];
    for(const input of inputs){assert.throws(()=>a.open(input as [Uint8Array,Uint8Array]),/CANDIDATE_(BINDING|PARTS)/);assert.equal(a.workspace.used,used);}
    let invoked=0;const getter=[a.parts[0],a.parts[1]];Object.defineProperty(getter,'0',{get(){invoked++;return a.parts[0];}});
    assert.throws(()=>a.open(getter as [Uint8Array,Uint8Array]),/CANDIDATE_PARTS/);assert.equal(invoked,0);
    const success=a.open(a.parts);success.close();assert.equal(a.workspace.used,used);
  }finally{a.close();b.close();}assert.equal(a.workspace.used,0);assert.equal(b.workspace.used,0);
});

function mutate(part:Uint8Array,body:(db:DatabaseSync)=>void):Uint8Array {
  const db=new DatabaseSync(':memory:');try{db.deserialize(part);body(db);return db.serialize();}finally{db.close();}
}
test('cross-part duplicate primary key, wrong partition, altered epoch and legacy alias collision are rejected',()=>{
  const rows=sourceRows(),candidate=buildCandidate(payload(rows));
  try{
    const legacy=rows[3]!,from=route('L',legacy.values[0] as string),to=1-from;
    for(const mode of ['duplicate-key','wrong-partition','legacy-migration','legacy-vault','epoch']){
      const parts:[Uint8Array,Uint8Array]=[candidate.parts[0],candidate.parts[1]];
      parts[to]=mutate(parts[to]!,db=>{
        const key=mode==='legacy-migration'||mode==='legacy-vault'?'other-lineage':legacy.values[0] as string;
        db.prepare('INSERT INTO cold_legacy VALUES (?,?,?,?,?)').run(key,mode==='legacy-vault'?'other-migration':legacy.values[1] as string,mode==='legacy-migration'?'other-vault':legacy.values[2] as string,legacy.values[3] as Uint8Array,mode==='epoch'?2:1);
        const m=JSON.parse(db.prepare('SELECT state FROM cold_meta').get()!.state as string);m.counts.legacy++;db.prepare('UPDATE cold_meta SET state=?').run(JSON.stringify(m));
      });
      if(mode==='wrong-partition')parts[from]=mutate(parts[from]!,db=>{db.exec('DELETE FROM cold_legacy');const m=JSON.parse(db.prepare('SELECT state FROM cold_meta').get()!.state as string);m.counts.legacy--;db.prepare('UPDATE cold_meta SET state=?').run(JSON.stringify(m));});
      assert.throws(()=>candidate.open(parts),/CANDIDATE_BINDING/);
    }
  }finally{candidate.close();}
});

test('a legal empty partition is mandatory and all-empty source remains only an unanchored candidate',()=>{
  const rows:RawRow[]=[{kind:'R',values:['vault','single',Buffer.from(receipt('single'))],epoch:1}],candidate=buildCandidate(payload(rows));
  try{const w=new ColdWorkspace(),empty=ColdDatabase.open(candidate.parts[1-route('R','vault','single')]!,w);try{assert.deepEqual(empty.meta.counts,emptyCounts());}finally{empty.close();}assert.equal(w.used,0);
    assert.throws(()=>candidate.open([candidate.parts[route('R','vault','single')]!] as unknown as [Uint8Array,Uint8Array]),/CANDIDATE_PARTS/);
    const view=candidate.open(candidate.parts);assert.equal(view.raw('R','vault','absent').outcome,'CANDIDATE_ABSENT');view.close();
  }finally{candidate.close();}
  const empty=buildCandidate(payload([])),opened=empty.open(empty.parts);assert.equal(opened.raw('M','ac1-none').outcome,'CANDIDATE_ABSENT');empty.close();assert.equal(empty.workspace.used,0);
});

test('IF8 requires every pointer exactly once in both directions and validates decoder payload',()=>{
  const rows=sourceRows();
  const missing=rows.filter(r=>r!==rows[1]);assert.throws(()=>buildCandidate(payload(missing)),/ANCHOR_RECEIPT_SEGMENT/);
  const noSegment=rows.filter(r=>r.kind!=='S');assert.throws(()=>buildCandidate(payload(noSegment)),/ANCHOR_RECEIPT_SEGMENT/);
  const wrong=structuredClone(rows);wrong[1]!.values[2]=Buffer.from(receiptPointer(rows[2]!.values[0] as string,1,1));assert.throws(()=>buildCandidate(payload(wrong)),/ANCHOR_RECEIPT_SEGMENT/);
  const extra=[...rows,{kind:'R' as const,values:['vault','extra',Buffer.from(receiptPointer(rows[2]!.values[0] as string,0,1))],epoch:1}];assert.throws(()=>buildCandidate(payload(extra)),/ANCHOR_RECEIPT_SEGMENT/);
  const corrupt=structuredClone(rows);(corrupt[2]!.values[7] as Uint8Array).fill(0);assert.throws(()=>buildCandidate(payload(corrupt)),/ANCHOR_RECEIPT_SEGMENT/);
  const malformed=structuredClone(rows);malformed[4]!.values[1]=bytes({...normalizeCold({operationId:'ac1-earlier',expectedRouteEpoch:0}),extra:true});assert.throws(()=>buildCandidate(payload(malformed)),/ANCHOR_COLD_FORMAT/);
  const identity=structuredClone(rows);identity[3]!.values[3]=bytes({version:1,lineageId:'other',migrationId:'migration',vaultId:'legacy-vault'});assert.throws(()=>buildCandidate(payload(identity)),/CANDIDATE_LEGACY/);
});

test('shared/resizable/proxy byte inputs and forged byte accessors never establish the source',()=>{
  const source=payload(sourceRows());
  for(const input of [new Uint8Array(new SharedArrayBuffer(source.length)),new Uint8Array(Reflect.construct(ArrayBuffer,[source.length,{maxByteLength:source.length*2}]) as ArrayBuffer),new Proxy(source,{})])assert.throws(()=>buildCandidate(input),/CANDIDATE_BYTES/);
  let calls=0;Object.defineProperty(source,'buffer',{get(){calls++;throw Error('caller code');}});Object.defineProperty(source,'byteLength',{get(){calls++;throw Error('caller code');}});
  const candidate=buildCandidate(source);assert.equal(calls,0);
  try{const shared=new Uint8Array(new SharedArrayBuffer(candidate.parts[0].length));assert.throws(()=>candidate.open([shared,candidate.parts[1]]),/CANDIDATE_BYTES/);const view=candidate.open(candidate.parts);view.close();}finally{candidate.close();}
});

test('sum of both SQLite images is capped at 1 MiB, including the second schema/page overhead',()=>{
  // Synthetic codec rows only: these sizes are not business-history capacity acceptance.
  let fitting:Buffer|undefined,over:Buffer|undefined;
  for(let n=940000;n<=1030000;n+=4096){
    let source:Buffer;try{source=payload([{kind:'R',values:['vault','large',Buffer.from(receipt('large','x'.repeat(n)))],epoch:1}]);}catch{break;}
    try{const candidate=buildCandidate(source);fitting=source;candidate.close();}catch(e){assert.match(String(e),/CANDIDATE_PAYLOAD/);over=source;break;}
  }
  assert.ok(fitting);assert.ok(over);assert.ok(over.length<=COLD_LIMITS.payload);
  const candidate=buildCandidate(fitting);assert.ok(candidate.parts[0].length+candidate.parts[1].length<=COLD_LIMITS.payload);candidate.close();assert.throws(()=>buildCandidate(over),/CANDIDATE_PAYLOAD/);
  assert.throws(()=>buildCandidate(Buffer.alloc(COLD_LIMITS.payload+4096)),/CANDIDATE_PAYLOAD/);
});

test('one Workspace charges build/open/IF8/returned values before allocation, releases every refused operation',()=>{
  const source=payload(sourceRows()),initial=buildCandidate(source),buildPeak=initial.workspace.peak;initial.close();assert.equal(initial.workspace.used,0);
  assert.throws(()=>buildCandidate(source,buildPeak-1),/ANCHOR_COLD_WORKSPACE/);const exact=buildCandidate(source,buildPeak);exact.close();assert.equal(exact.workspace.used,0);
  for(const target of ['candidate input snapshot','current RAM SQLite image and metadata','IF8 output buffer, UTF8 JSON and entries','candidate returned receipt','retained selected row']){
    const candidate=buildCandidate(source),baseline=candidate.workspace.used,view=target==='candidate returned receipt'||target==='retained selected row'?candidate.open(candidate.parts):undefined;
    const start=candidate.workspace.used,original=ColdWorkspace.prototype.reserve;let hold:(()=>void)|undefined,hits=0;
    try{ColdWorkspace.prototype.reserve=function(n,label){if(label===target&&!hits++){hold=original.call(this,this.limit-this.used-n+1,'synthetic other live allocations');}return original.call(this,n,label);};
      assert.throws(()=>view?target==='candidate returned receipt'?view.receipt('vault','if8-receipt'):view.raw('R','vault','raw'):candidate.open(candidate.parts),/ANCHOR_COLD_WORKSPACE/);
    }finally{hold?.();ColdWorkspace.prototype.reserve=original;}
    assert.equal(hits,1);assert.equal(candidate.workspace.used,start);view?.close();assert.equal(candidate.workspace.used,baseline);
    const retry=candidate.open(candidate.parts);retry.close();candidate.close();assert.equal(candidate.workspace.used,0);assert.ok(candidate.workspace.peak<=COLD_LIMITS.workspace);
  }
  const candidate=buildCandidate(source),view=candidate.open(candidate.parts),values:ReturnType<typeof found<string>>[]=[];
  try{assert.throws(()=>{for(let i=0;i<20000;i++)values.push(found(view.receipt('vault','raw')));},/ANCHOR_COLD_WORKSPACE/);assert.ok(values.length>1);}finally{candidate.close();}
  assert.equal(candidate.workspace.used,0);for(const value of values)assert.throws(()=>value.value,/CANDIDATE_CLOSED/);
});

test('partial builders, output buffers and second-shard opens unwind the same pool on refusal',()=>{
  const source=payload(sourceRows());
  for(const [label,occurrence,phase] of [
    ['candidate input snapshot',1,'build'],['current RAM SQLite image and metadata',1,'build'],
    ['candidate RAM SQLite image and metadata',1,'build'],['candidate RAM SQLite image and metadata',2,'build'],
    ['candidate serialize buffer',1,'build'],['candidate serialize buffer',2,'build'],
    ['candidate input snapshot',2,'open'],['current RAM SQLite image and metadata',2,'open'],
  ] as const){
    const candidate=phase==='open'?buildCandidate(source):undefined,start=candidate?.workspace.used??0;
    const original=ColdWorkspace.prototype.reserve,pools=new Set<ColdWorkspace>();let calls=0,hold:(()=>void)|undefined;
    try{ColdWorkspace.prototype.reserve=function(n,name){pools.add(this);if(name===label&&++calls===occurrence)hold=original.call(this,this.limit-this.used-n+1,'synthetic other live allocations');return original.call(this,n,name);};
      assert.throws(()=>candidate?candidate.open(candidate.parts):buildCandidate(source),/ANCHOR_COLD_WORKSPACE/);
    }finally{hold?.();ColdWorkspace.prototype.reserve=original;}
    assert.equal(calls,occurrence);for(const w of pools)assert.equal(w.used,start);
    candidate?.close();for(const w of pools)assert.equal(w.used,0);
  }
  for(const n of [-1,COLD_LIMITS.workspace+1,Infinity])assert.throws(()=>buildCandidate(source,n),/ANCHOR_COLD_WORKSPACE/);
});

test('public synthetic authority flow supplies real cold bytes without altering source, root, head or old receipts',()=>{
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'aemc-candidate-public-'))),config={directory:join(root,'authority'),authorityId:'synthetic',custodyDomain:'independent',writeLimitBytes:524288};
  LocalSqliteAuthority.create(config).close();LocalSqliteAuthority.upgradeSchema(config,'operator-attested-stopped');LocalSqliteAuthority.upgradeReceiptSchema(config,'operator-attested-stopped');LocalSqliteAuthority.upgradeColdSchema(config,'operator-attested-stopped');
  const authority=LocalSqliteAuthority.open(config),vault=AnchoredVault.create({directory:join(root,'vault'),vaultId:'vault',identity:'synthetic',storageDomain:'payload',storageProfile:'blocks-br4-v1',schemaVersion:2,keys:generateKeySet(),authority},8,{clock:{wall:()=>100,monotonic:()=>0}});
  try{
    for(let i=0;i<36;i++)vault.claim('synthetic-'+i,'p');authority.rolloverReceipts({operationId:'if8-public'});
    const first=authority.archivePermanentKeys({operationId:'ac1-first',expectedRouteEpoch:0});for(let i=0;i<36;i++)vault.claim('next-'+i,'p');
    const second=authority.archivePermanentKeys({operationId:'ac1-second',expectedRouteEpoch:1}),path=join(config.directory,`cold-slot-${second.descriptor.slot}.sqlite`),source=readFileSync(path),sourceHash=sha(source),head=authority.inspect('vault');
    const inventory=()=>readdirSync(config.directory).sort().map(name=>[name,sha(readFileSync(join(config.directory,name)))]),before=inventory();
    const candidate=buildCandidate(source),view=candidate.open(candidate.parts),w=new ColdWorkspace(),db=ColdDatabase.open(source,w);
    try{for(const kind of ['R','S','L','M'] as const)for(const row of db.rows(kind)){
      const hit=found(view.raw(kind,row.values[0] as string,kind==='R'?row.values[1] as string:undefined));rawEqual(hit.value,row);hit.close();
      if(kind==='R'){const original=JSON.stringify(authority.transaction(tx=>tx.receipt(row.values[0] as string,row.values[1] as string))),resolved=found(view.receipt(row.values[0] as string,row.values[1] as string));assert.equal(resolved.value,original);resolved.close();}
    }
      const prior=found(view.maintenance({operationId:'ac1-first',expectedRouteEpoch:0}));assert.deepEqual(JSON.parse(Buffer.from(prior.value.values[2] as Uint8Array).toString()),first);prior.close();
    }finally{db.close();view.close();candidate.close();}assert.equal(w.used,0);assert.equal(candidate.workspace.used,0);
    assert.equal(sha(source),sourceHash);assert.equal(sha(readFileSync(path)),sourceHash);assert.deepEqual(inventory(),before);assert.deepEqual(authority.inspect('vault'),head);assert.deepEqual(authority.archivePermanentKeys({operationId:'ac1-first',expectedRouteEpoch:0}),first);
  }finally{vault.close();authority.close();}
});
