import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs, { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { constants as z, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { TrainingJournal, TJ_DISK } from '../src/training-journal.ts';
import { canonicalTrainingEvent, tjHash, TrainingJournalError } from '../src/training-journal-format.ts';
import { authority, DIGEST, event, freshDirectory, trace } from './fixtures/training-journal-fixture.ts';

const rejects=(fn:()=>unknown,code?:string)=>assert.throws(fn,(e:unknown)=>e instanceof TrainingJournalError&&(!code||e.code===code));
function fixture(t:TestContext) {
  const directory=freshDirectory(),current=authority(),options={directory,journalId:'synthetic-journal',authority:()=>current};
  const journal=TrainingJournal.create(options);t.after(()=>journal.close());return {directory,current,options,journal};
}
function seed() {
  const directory=freshDirectory(),options={directory,journalId:'synthetic-journal',authority:()=>authority()};
  const j=TrainingJournal.create(options);for(const raw of trace())j.append(raw);j.close();return {directory,options,bytes:readFileSync(join(directory,TJ_DISK.archiveName))};
}
function altered(bytes:Buffer) {
  const directory=freshDirectory();writeFileSync(join(directory,TJ_DISK.archiveName),bytes);
  return {directory,journalId:'synthetic-journal',authority:()=>authority('new-runtime')};
}
function framePositions(bytes:Buffer):number[] {const result:number[]=[];for(let p=128;p<bytes.length;){result.push(p);p+=168+bytes.readUInt32BE(p+20);}return result;}
function refreshFrameHash(bytes:Buffer,start:number):void {
  const length=bytes.readUInt32BE(start+20),hash=tjHash(bytes.subarray(start,start+128+length));Buffer.from(hash,'hex').copy(bytes,start+128+length+8);
}
test('TJ0 disk identity and standard zstd roundtrip exact logical bytes with independent phase states',t=>{
  for(const codec of ['identity','zstd'] as const) {
    const f=fixture(t),expected=trace().map(canonicalTrainingEvent).map(s=>s+'\n').join('');
    for(const raw of trace())f.journal.append(raw,{codec});assert.equal(f.journal.exportCanonical(),expected);
    assert.equal(f.journal.status().events,9);assert.equal(f.journal.status().realTrainingPerformed,false);
    f.journal.close();const re=TrainingJournal.open({...f.options,authority:()=>authority('fresh-runtime')});
    try {assert.equal(re.exportCanonical(),expected);assert.equal(re.status().recovery,'COMPLETE');
      assert.equal(re.readAttempt('run-1','attempt-1').projection.everActivated,true);
      for(let i=1;i<=9;i++)assert.equal(JSON.stringify(re.readEvent(i).event),canonicalTrainingEvent(trace()[i-1]!));
    }finally{re.close();}
  }
});
test('TJ0 durable duplicate identity+digest consumes no bytes; conflicting content rejects after reopen',t=>{
  const f=fixture(t);f.journal.append(event('INTENT',1));const before=f.journal.status().archiveBytes;f.journal.close();
  const re=TrainingJournal.open(f.options);try{
    assert.deepEqual(re.append(event('INTENT',1)),{duplicate:true,sequence:1});assert.equal(re.status().archiveBytes,before);
    const conflicting=JSON.parse(event('INTENT',1));conflicting.data.purpose='OTHER_SYNTHETIC';
    rejects(()=>re.append(JSON.stringify(conflicting)),'TJ_CONFLICT');assert.equal(re.status().events,1);
    re.append(event('STARTED',2));assert.equal(re.status().events,2);
  }finally{re.close();}
});
test('TJ0 only one cooperative opener can scan or write; closing invalidates all old instance use',t=>{
  const f=fixture(t);rejects(()=>TrainingJournal.open(f.options),'TJ_LOCKED');
  rejects(()=>TrainingJournal.open({...f.options,readOnly:true}),'TJ_LOCKED');f.journal.close();
  rejects(()=>f.journal.status(),'TJ_FENCED');rejects(()=>f.journal.append(event('INTENT',1)),'TJ_FENCED');
  const re=TrainingJournal.open(f.options);re.close();
});
test('TJ0 no automatic index/head fallback: unrelated corrupt sidecar index is ignored, canonical archive rebuilt',()=>{
  const s=seed();writeFileSync(join(s.directory,'index.json'),'PRIVATE_CORRUPT_INDEX_NOT_AUTHORITY');
  const re=TrainingJournal.open(s.options);try{assert.equal(re.status().events,9);assert.equal(re.readEvent(9).event.kind,'ACTIVATION');}
  finally{re.close();}
});
test('TJ0 full archive header has deterministic identity fallback golden bytes',t=>{
  const f=fixture(t);f.journal.append(event('INTENT',1));f.journal.close();
  const b=readFileSync(join(f.directory,TJ_DISK.archiveName));
  assert.equal(b.subarray(0,8).toString(),'TJ0AR001');assert.equal(b.readUInt16BE(8),1);
  assert.equal(b.subarray(96,128).toString('hex'),tjHash(b.subarray(0,96)));
  assert.equal(b.subarray(128+128,b.length-40).toString(),canonicalTrainingEvent(event('INTENT',1)));
  // The golden hash covers header, canonical event, chain and commit marker, with no wall-clock fields.
  assert.equal(tjHash(b),'552a173d645ba17da94e1bb0d6c97db7e7a9d2990c90ae663879f160f08a806b');
});
test('TJ0 truncated suffix retains exactly the consecutive complete prefix and never auto repairs or appends',()=>{
  const s=seed(),positions=framePositions(s.bytes),last=positions.at(-1)!;
  for(const cut of [last+1,last+127,last+128,last+130,s.bytes.length-1]) {
    const opts=altered(s.bytes.subarray(0,cut)),re=TrainingJournal.open(opts);
    try{const before=readFileSync(join(opts.directory,TJ_DISK.archiveName));assert.equal(re.status().recovery,'INCOMPLETE');
      assert.equal(re.status().events,8);assert.equal(re.readAttempt('run-1','attempt-1').history,'INCOMPLETE');
      assert.equal(re.status().archiveAppendable,false);rejects(()=>re.append(trace()[8]!),'TJ_INCOMPLETE');
      rejects(()=>re.exportCanonical(),'TJ_INCOMPLETE');
      assert.deepEqual(readFileSync(join(opts.directory,TJ_DISK.archiveName)),before);
    }finally{re.close();}
  }
});
for(const mutation of ['payload','commit','sequence','chain','reserved','unsupported-schema','unsupported-codec','oversize-encoded','oversize-decoded','skip-middle'] as const)
test(`TJ0 ${mutation} stops at the first invalid frame and does not skip a later valid suffix`,()=>{
  const s=seed(),positions=framePositions(s.bytes),p=positions[2]!,b=Buffer.from(s.bytes);
  switch(mutation){
    case 'payload':b[p+130]=b[p+130]!^1;break;case 'commit':b[positions[3]!-40]=b[positions[3]!-40]!^1;break;
    case 'sequence':b.writeUInt32BE(8,p+16);refreshFrameHash(b,p);break;
    case 'chain':b[p+32]=b[p+32]!^1;refreshFrameHash(b,p);break;
    case 'reserved':b[p+96]=1;refreshFrameHash(b,p);break;
    case 'unsupported-schema':b.writeUInt16BE(2,p+8);refreshFrameHash(b,p);break;
    case 'unsupported-codec':b.writeUInt16BE(2,p+10);refreshFrameHash(b,p);break;
    case 'oversize-encoded':b.writeUInt32BE(65_537,p+20);break;
    case 'oversize-decoded':b.writeUInt32BE(16_385,p+24);break;
    case 'skip-middle':break;
  }
  const opts=altered(mutation==='skip-middle'?Buffer.concat([b.subarray(0,p),b.subarray(positions[3]!) ]):b),re=TrainingJournal.open(opts);
  try{assert.equal(re.status().events,2);assert.equal(re.status().recovery,mutation.startsWith('unsupported')?'UNSUPPORTED':'CORRUPT');
    assert.equal(re.readAttempt('run-1','attempt-1').projection.state,'RUNNING');rejects(()=>re.readEvent(3),'TJ_NOT_FOUND');}
  finally{re.close();}
});
test('TJ0 forged checksum-consistent JSON still must be canonical, reducer-valid and synthetic',()=>{
  const s=seed(),p=framePositions(s.bytes)[2]!;
  for(const raw of [' '+canonicalTrainingEvent(trace()[2]!),canonicalTrainingEvent(trace()[2]!).replace('SYNTHETIC_FIXTURE','REAL_TRAINING'),
    canonicalTrainingEvent(trace()[2]!).replace('"sequence":"3"','"sequence":"9"'),'{"version":1,"version":1}',
    Buffer.from([0xff,0xfe]),'\ufeff'+canonicalTrainingEvent(trace()[2]!)]) {
    const body=Buffer.from(raw),h=Buffer.from(s.bytes.subarray(p,p+128));h.writeUInt32BE(body.length,20);h.writeUInt32BE(body.length,24);
    Buffer.from(tjHash(body),'hex').copy(h,64);const encoded=Buffer.concat([h,body]);
    const opts=altered(Buffer.concat([s.bytes.subarray(0,p),encoded,Buffer.from('TJ0DONE1'),Buffer.from(tjHash(encoded),'hex')]));
    const re=TrainingJournal.open(opts);try{assert.equal(re.status().events,2);assert.equal(re.status().recovery,'CORRUPT');}finally{re.close();}
  }
});
test('TJ0 zstd output expansion and decoder window are bounded independently of forged declared sizes',()=>{
  const s=seed(),p=framePositions(s.bytes)[2]!;
  for(const [length,windowLog] of [[32_768,15],[131_072,17]]) {
    const payload=zstdCompressSync(Buffer.alloc(length!,65),{params:{[z.ZSTD_c_windowLog]:windowLog!,[z.ZSTD_c_contentSizeFlag]:0}});
    assert.throws(()=>zstdDecompressSync(payload,{maxOutputLength:32,params:{[z.ZSTD_d_windowLogMax]:16}}),
      (error:unknown)=>length===32_768?(error as NodeJS.ErrnoException).code==='ERR_BUFFER_TOO_LARGE':
        (error as NodeJS.ErrnoException).code==='ZSTD_error_frameParameter_windowTooLarge');
    const h=Buffer.from(s.bytes.subarray(p,p+128));h.writeUInt16BE(1,10);h.writeUInt32BE(payload.length,20);h.writeUInt32BE(32,24);
    const body=Buffer.concat([h,payload]),opts=altered(Buffer.concat([s.bytes.subarray(0,p),body,Buffer.from('TJ0DONE1'),Buffer.from(tjHash(body),'hex')]));
    const re=TrainingJournal.open(opts);try{assert.equal(re.status().events,2);assert.equal(re.status().recovery,'CORRUPT');}finally{re.close();}
  }
});
test('TJ0 direct file change, partial header and authority/header mismatch fail closed without private diagnostics',t=>{
  const f=fixture(t);f.journal.append(event('INTENT',1));appendFileSync(join(f.directory,TJ_DISK.archiveName),'PRIVATE_PATH_OR_BODY');
  rejects(()=>f.journal.status(),'TJ_CHANGED');rejects(()=>f.journal.status(),'TJ_FENCED');
  const opts=altered(Buffer.from('PRIVATE_PATH_OR_BODY'));rejects(()=>TrainingJournal.open(opts),'TJ_INCOMPLETE');
  const unsupported=seed().bytes;unsupported.writeUInt16BE(2,8);Buffer.from(tjHash(unsupported.subarray(0,96)),'hex').copy(unsupported,96);
  rejects(()=>TrainingJournal.open(altered(unsupported)),'TJ_UNSUPPORTED');
  for(const change of ['identity','consent','journal']) {
    const s=seed();const a=authority();if(change==='identity')a.scopeId='other';if(change==='consent')a.consentRevision='2';
    rejects(()=>TrainingJournal.open({...s.options,authority:()=>a,journalId:change==='journal'?'other':'synthetic-journal'}),'TJ_AUTHORITY');
  }
});
test('TJ0 denies read/write/export separately; observed denial, expiry, epoch and clock reversal permanently fence',t=>{
  for(const mutation of ['read','write','export','expiry','runtime','consent','generation','clock'] as const) {
    const f=fixture(t);f.journal.append(event('INTENT',1));f.current.now=1_001;f.journal.status();
    const before=readFileSync(join(f.directory,TJ_DISK.archiveName));
    if(mutation==='read'||mutation==='write'||mutation==='export')f.current[mutation]=false;
    if(mutation==='expiry')f.current.expiresAt=f.current.now;
    if(mutation==='runtime')f.current.runtimeId='new-runtime';if(mutation==='consent')f.current.consentRevision='2';
    if(mutation==='generation')f.current.generation='1';if(mutation==='clock')f.current.now=1_000;
    const action=mutation==='write'?()=>f.journal.append(event('INTENT',1)):mutation==='export'?()=>f.journal.exportCanonical():()=>f.journal.status();
    rejects(action,'TJ_AUTHORITY');Object.assign(f.current,authority());rejects(()=>f.journal.status(),'TJ_FENCED');
    assert.deepEqual(readFileSync(join(f.directory,TJ_DISK.archiveName)),before);
  }
});
test('TJ0 readonly permissions permit current history without implying write capability',t=>{
  const f=fixture(t);f.journal.append(event('INTENT',1));f.current.write=false;
  assert.equal(f.journal.status().archiveAppendable,true);assert.equal(f.journal.readEvent(1).assurance,'NOT_AUTHENTICATED');
  assert.equal(f.journal.exportCanonical().length>0,true);rejects(()=>f.journal.append(event('STARTED',2)),'TJ_AUTHORITY');
});
test('TJ0 callback exceptions, async values, getters and proxy authority are fixed errors with no payload',()=>{
  for(const callback of [()=>{throw Error('PRIVATE_ERROR_PATH');},()=>Promise.resolve(authority()),
    ()=>({...authority(),get read(){throw Error('PRIVATE_GETTER');}}),()=>new Proxy(authority(),{})]) {
    const directory=freshDirectory();assert.throws(()=>TrainingJournal.create({directory,journalId:'synthetic-journal',authority:callback as ()=>ReturnType<typeof authority>}),
      (e:unknown)=>e instanceof TrainingJournalError&&e.message==='TJ_AUTHORITY'&&!JSON.stringify(e).includes('PRIVATE'));
  }
});
test('TJ0 reentrant authority cannot close/reopen, mutate or clear its old owner fence',()=>{
  const directory=freshDirectory();let j:TrainingJournal|undefined,reenter=false;
  j=TrainingJournal.create({directory,journalId:'synthetic-journal',authority:()=>{
    if(reenter){try{j!.close();}catch{}try{j!.append(event('INTENT',1));}catch{}}return authority();
  }});
  try{reenter=true;rejects(()=>j!.status(),'TJ_AUTHORITY');reenter=false;rejects(()=>j!.status(),'TJ_FENCED');}finally{j.close();}
});
test('TJ0 post-commit authority denial returns no success; fresh context reconciles the durable duplicate',()=>{
  const directory=freshDirectory();let calls=0,denyAt=Infinity;
  const opts={directory,journalId:'synthetic-journal',authority:()=>({...authority(),write:++calls!==denyAt})};
  const j=TrainingJournal.create(opts);denyAt=calls+3; // pre-operation, pre-write, final delivery
  rejects(()=>j.append(event('INTENT',1)),'TJ_AUTHORITY');rejects(()=>j.status(),'TJ_FENCED');j.close();
  const re=TrainingJournal.open({...opts,authority:()=>authority('fresh')});try{
    assert.equal(re.status().events,1);assert.deepEqual(re.append(event('INTENT',1)),{duplicate:true,sequence:1});
  }finally{re.close();}
});
test('TJ0 attempt and event limits are enforced across rebuilt indexes',()=>{
  const directory=freshDirectory(),options={directory,journalId:'synthetic-journal',authority:()=>authority()},j=TrainingJournal.create(options);
  for(let i=0;i<64;i++)j.append(event('INTENT',1,{}, {attemptId:'attempt-'+i}));
  rejects(()=>j.append(event('INTENT',1,{}, {attemptId:'attempt-extra'})),'TJ_LIMIT');j.close();
  const re=TrainingJournal.open(options);try{
    rejects(()=>re.append(event('INTENT',1,{}, {attemptId:'attempt-extra'})),'TJ_LIMIT');
    for(let i=0;i<64;i++){re.append(event('STARTED',2,{}, {attemptId:'attempt-'+i}));
      re.append(event('STEP',3,{optimizerSteps:'1',batches:null,metrics:[]},{attemptId:'attempt-'+i}));
      re.append(event('TERMINAL',4,{outcome:'COMPLETED'},{attemptId:'attempt-'+i}));}
    assert.equal(re.status().events,256);rejects(()=>re.append(event('NOTE',5,{relatedEventId:'event-1',code:'LATE_EVIDENCE',text:'x'},{attemptId:'attempt-0'})),'TJ_LIMIT');
  }finally{re.close();}
});
test('TJ0 archive and SQLite lock sidefiles have independent pre-open byte/type bounds',()=>{
  for(const [name,bytes] of [[TJ_DISK.lockName,1],[TJ_DISK.lockName+'-journal',513],[TJ_DISK.lockName+'-wal',0],
    [TJ_DISK.lockName+'-shm',0],[TJ_DISK.archiveName,8_388_609]] as const) {
    const directory=freshDirectory();writeFileSync(join(directory,name),Buffer.alloc(bytes));
    rejects(()=>TrainingJournal.open({directory,journalId:'synthetic-journal',authority:()=>authority()}),name===TJ_DISK.archiveName?'TJ_LIMIT':'TJ_PATH');
  }
  const directory=freshDirectory();mkdirSync(join(directory,TJ_DISK.lockName));
  rejects(()=>TrainingJournal.create({directory,journalId:'synthetic-journal',authority:()=>authority()}),'TJ_PATH');
});
test('TJ0 partial write and fsync failure return UNKNOWN, permanently fence and preserve actual bytes',()=>{
  for(const mode of ['partial-write','fsync'] as const) {
    const directory=freshDirectory(),options={directory,journalId:'synthetic-journal',authority:()=>authority()},j=TrainingJournal.create(options);
    const originalWrite=fs.writeSync,originalSync=fs.fsyncSync;
    try {
      if(mode==='partial-write')fs.writeSync=((fd:number,b:Buffer,offset:number,_length:number,position:number)=>{
        originalWrite(fd,b,offset,16,position);throw Error('PRIVATE_WRITE_EXCEPTION');}) as unknown as typeof fs.writeSync;
      else fs.fsyncSync=()=>{throw Error('PRIVATE_FSYNC_EXCEPTION');};
      syncBuiltinESMExports();rejects(()=>j.append(event('INTENT',1)),'TJ_COMMIT_UNKNOWN');rejects(()=>j.status(),'TJ_FENCED');
    }finally{fs.writeSync=originalWrite;fs.fsyncSync=originalSync;syncBuiltinESMExports();j.close();}
    const re=TrainingJournal.open(options);try{
      assert.equal(re.status().events,mode==='fsync'?1:0);assert.equal(re.status().recovery,mode==='fsync'?'COMPLETE':'INCOMPLETE');
      if(mode==='fsync')assert.equal(re.append(event('INTENT',1)).duplicate,true);else rejects(()=>re.append(event('INTENT',1)),'TJ_INCOMPLETE');
    }finally{re.close();}
  }
});
