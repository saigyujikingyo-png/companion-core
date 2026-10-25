import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DurableMemory } from '../src/durable-memory.ts';
import type { DurableConfig, DurableFault } from '../src/durable-memory.ts';
import { CoupledSession } from '../src/coupled-runtime.ts';
import { InteractionResources, RequestBudget } from '../src/interaction.ts';
import type { InteractionRequest, InteractionResponse } from '../src/interaction.ts';
import { HttpInteractionProvider } from '../src/http-interaction.ts';
const scopeIdentity = { tenantId:'synthetic',subjectId:'subject',personaId:'companion',relationshipId:'test' };
const response: InteractionResponse = { version:1,responseText:'SYNTHETIC_DURABLE_REPLY',memoryProposal:null,
  appraisal:{kind:'appraisal-hypothesis',confidence:.8,valence:.5,arousal:.2,uncertainty:0,fatigue:0} };
const config = (): DurableConfig => ({directory:mkdtempSync(join(tmpdir(),'companion-m2-')),identity:'synthetic-vault',keyBase64:randomBytes(32).toString('base64')});
function session(vault: DurableMemory, seen: InteractionRequest[] = []) {
  const resources = new InteractionResources(new RequestBudget({total:8,hourly:8,daily:8},()=>100,
    {initialTotal:vault.reserved,reserve:id=>vault.reserve(id)}));
  const scope = vault.store.ensureScope(scopeIdentity);
  const s = new CoupledSession(vault.store,scope,{durable:vault,resources,clock:()=>100,
    provider:{interact:async input=>{resources.budget.reserve(input.requestId);seen.push(input);return response;}}});
  const activate = () => { s.resume();s.setHostContext({quiet:false,available:true,ttlMs:30000}); };
  return {s,scope,activate,submit:(id:string,selectedText='SYNTHETIC_VIOLET_REMEMBER')=>s.submit({sessionId:s.sessionId,id,selectedText,recallQuery:'SYNTHETIC_VIOLET'})};
}

test('runtime capability records actual SQLite serialize/deserialize roundtrip without files', t => {
  const db=new DatabaseSync(':memory:'),copy=new DatabaseSync(':memory:');
  try {
    assert.equal(typeof db.serialize,'function');assert.equal(typeof db.deserialize,'function');
    db.exec("CREATE TABLE evidence(value TEXT); BEGIN; INSERT INTO evidence VALUES ('synthetic');");copy.deserialize(db.serialize());
    assert.equal(copy.prepare('SELECT value FROM evidence').get()!.value,'synthetic');
    assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    t.diagnostic(JSON.stringify({node:process.version,execPath:process.execPath,sqlite:db.prepare('SELECT sqlite_version() AS v').get()!.v}));
  } finally {db.close();copy.close();}
});

test('encrypted memory/derived FTS, budget and stable ingress survive fresh runtime; pending output is unknown', async()=>{
  const c=config();let v=new DurableMemory(c,8);const a=session(v);a.activate();
  const result=await a.submit('native-fixed');const oldToken=a.s.sessionId;
  a.s.takeDelivery(result.deliveryId);assert.equal(v.reserved,1);const source=a.s.status.lastSourceRef!;
  const bytesBefore=v.status.checkpointBytes,sequence=v.status.sequence;
  for(let i=0;i<20;i++){void v.status;void a.s.status;a.s.recall('SYNTHETIC_VIOLET');}
  assert.equal(v.status.sequence,sequence);assert.equal(v.status.checkpointBytes,bytesBefore);
  v.close();
  for(const name of readdirSync(c.directory))assert.equal(readFileSync(join(c.directory,name)).includes(Buffer.from('SYNTHETIC_VIOLET_REMEMBER')),false,name);
  v=new DurableMemory(c,8);const b=session(v);assert.notEqual(b.s.sessionId,oldToken);
  assert.equal(b.s.status.paused,true);assert.equal(v.status.unknownRequests,1);assert.equal(b.s.status.budget.total,1);
  assert.throws(()=>b.s.takeDelivery(result.deliveryId),/SESSION_PAUSED/);
  b.s.resume();await assert.rejects(b.submit('new-while-unavailable'),/HOST_CONTEXT_BLOCKED/);b.activate();
  assert.ok(b.s.recall('SYNTHETIC_VIOLET').some(r=>r.statement==='SYNTHETIC_VIOLET_REMEMBER'));
  await assert.rejects(b.submit('native-fixed'),/INTERACTION_TERMINATED/);
  await assert.rejects(b.submit('native-fixed','changed'),/INTERACTION_IDEMPOTENCY_CONFLICT/);
  assert.throws(()=>b.s.takeDelivery(result.deliveryId),/DELIVERY_STALE/);
  assert.deepEqual(b.s.status.lastSourceRef,source);assert.equal(v.reserved,1);v.close();
});

test('feedback consumption is durable, background resets and old ACK cannot reward a new binding',async()=>{
  const c=config();let v=new DurableMemory(c,8);const a=session(v);a.activate();const first=await a.submit('one');
  a.s.takeDelivery(first.deliveryId);a.s.acknowledgeDelivery(first.deliveryId);
  await a.s.submit({sessionId:a.s.sessionId,id:'two',selectedText:'SYNTHETIC_EXPLICIT_FEEDBACK',feedback:{deliveryId:first.deliveryId,outcome:'engaged'}});
  assert.throws(()=>a.s.validateFeedback(first.deliveryId),/DELIVERY_FEEDBACK_ALREADY_CONSUMED/);
  v.close();v=new DurableMemory(c,8);const b=session(v);b.activate();
  assert.equal(b.s.background().ledgerSize,0);assert.equal(b.s.background().sourceRefs.length,0);
  assert.throws(()=>b.s.validateFeedback(first.deliveryId),/DELIVERY_STALE/);
  await assert.rejects(b.submit('two','SYNTHETIC_EXPLICIT_FEEDBACK'),/INTERACTION_IDEMPOTENCY_CONFLICT/);v.close();
});

test('revoke persists and swapping latest ciphertext with an old checkpoint fails closed',async()=>{
  const c=config();let v=new DurableMemory(c,8);const a=session(v);a.activate();await a.submit('one');
  const snapshots=readdirSync(c.directory).filter(n=>n.startsWith('checkpoint-'));
  const old=readFileSync(join(c.directory,snapshots.at(-1)!));const source=a.s.status.lastSourceRef!;
  a.s.revoke(source);v.close();v=new DurableMemory(c,8);const b=session(v);b.activate();assert.equal(b.s.recall('SYNTHETIC_VIOLET').length,0);v.close();
  const latest=readdirSync(c.directory).filter(n=>n.startsWith('checkpoint-')).sort((x,y)=>Number(x.split('-')[1])-Number(y.split('-')[1])).at(-1)!;
  writeFileSync(join(c.directory,latest),old);assert.throws(()=>new DurableMemory(c,8),/DURABLE_CORRUPT/);
});

test('missing ledger, wrong key/identity/budget and bad ciphertext do not silently initialize',()=>{
  for(const kind of ['key','identity','budget','missing','corrupt'] as const){
    const c=config(),v=new DurableMemory(c,8);v.close();
    if(kind==='missing'){
      const partial=mkdtempSync(join(tmpdir(),'companion-m2-incomplete-'));
      for(const name of readdirSync(c.directory).filter(n=>n!=='authority.sqlite'))copyFileSync(join(c.directory,name),join(partial,name));
      c.directory=partial;
    }
    if(kind==='corrupt'){const p=join(c.directory,readdirSync(c.directory).find(n=>n.startsWith('checkpoint-'))!);const b=readFileSync(p);b[30]=b[30]!^1;writeFileSync(p,b);}
    assert.throws(()=>new DurableMemory({...c,...(kind==='key'?{keyBase64:randomBytes(32).toString('base64')}:{ }),...(kind==='identity'?{identity:'different'}:{})},kind==='budget'?9:8),/DURABLE_/);
  }
});

for(const point of ['checkpoint-write','checkpoint-fsync','authority-commit','after-authority-commit'] as DurableFault[]){
  test(`crash fence ${point}: failed writer is poisoned; reopening consumes only committed safety state`,()=>{
    const c=config();let armed=false;
    const v=new DurableMemory(c,8,{fault:p=>{if(armed&&p===point)throw new Error('synthetic fault');}});
    v.claim('fixed','payload');armed=true;assert.throws(()=>v.reserve('fixed'),/DURABLE_WRITE_FAILED/);
    assert.throws(()=>v.claim('other','payload'),/DURABLE_UNAVAILABLE/);assert.throws(()=>v.status,/DURABLE_UNAVAILABLE/);
    assert.throws(()=>v.store.ensureScope(scopeIdentity),/DURABLE_UNAVAILABLE/);assert.throws(()=>v.store.snapshot(),/DURABLE_UNAVAILABLE/);v.close();
    const restored=new DurableMemory(c,8);assert.equal(restored.reserved,point==='after-authority-commit'?1:0);
    assert.equal(restored.status.unknownRequests,1);assert.throws(()=>restored.claim('fixed','payload'),/INTERACTION_TERMINATED/);restored.close();
  });
}

test('write failure in a MemoryStore mutation poisons RAM authority even after rollback',()=>{
  const c=config();let armed=false;const v=new DurableMemory(c,8,{fault:p=>{if(armed&&p==='after-authority-commit')throw new Error('synthetic');}});
  armed=true;assert.throws(()=>v.store.ensureScope(scopeIdentity),/DURABLE_WRITE_FAILED/);
  assert.throws(()=>v.store.ensureScope(scopeIdentity),/DURABLE_UNAVAILABLE/);v.close();
  const restored=new DurableMemory(c,8);assert.ok(restored.store.ensureScope(scopeIdentity));restored.close();
});

test('wall clock rollback rejects reopen and never refunds a durable request reservation',()=>{
  const c=config();let wall=2000;const clock={wall:()=>wall,monotonic:()=>0};let v=new DurableMemory(c,8,{clock});
  v.claim('r','p');v.reserve('r');v.close();wall=1999;
  assert.throws(()=>new DurableMemory(c,8,{clock}),/DURABLE_CLOCK_ROLLBACK/);wall=2100;v=new DurableMemory(c,8,{clock});assert.equal(v.reserved,1);v.close();
});

test('explicit reservation IDs and terminal transitions cannot refund, reverse or relabel a delivery',()=>{
  const c=config(),v=new DurableMemory(c,8);v.claim('one','one');v.claim('two','two');
  assert.throws(()=>v.reserve(),/DURABLE_REQUEST_REQUIRED/);assert.throws(()=>v.reserve('absent'),/DURABLE_REQUEST_REQUIRED/);
  v.reserve('one');assert.throws(()=>v.reserve('one'),/DURABLE_REQUEST_REQUIRED/);assert.equal(v.reserved,1);
  assert.throws(()=>v.terminal('one','acknowledged','receipt'),/INTERACTION_TERMINATED/);
  v.terminal('one','ready','receipt');assert.throws(()=>v.terminal('one','pending'),/INTERACTION_TERMINATED/);
  assert.throws(()=>v.terminal('two','ready','receipt'),/DURABLE_DELIVERY_CONFLICT/);
  v.terminal('one','taken','receipt');assert.throws(()=>v.terminal('one','ready','receipt'),/INTERACTION_TERMINATED/);
  v.terminal('one','acknowledged','receipt');const seq=v.status.sequence;v.terminal('one','acknowledged','receipt');assert.equal(v.status.sequence,seq);
  assert.throws(()=>v.terminal('one','acknowledged','other'),/DURABLE_DELIVERY_CONFLICT/);v.close();
});

test('synchronous durable reservation exhausting fixed deadline never reaches HTTP fetch',async()=>{
  const c=config();let now=0,armed=false,calls=0;const v=new DurableMemory(c,8,{fault:p=>{if(armed&&p==='after-authority-commit')now=100;}});
  v.claim('r','p');const resources=new InteractionResources(new RequestBudget({total:8,hourly:8,daily:8},()=>now,
    {initialTotal:0,reserve:id=>v.reserve(id)}));
  const provider=new HttpInteractionProvider({transport:'local_http',endpoint:'http://127.0.0.1:1',model:'synthetic',timeoutMs:10},resources,
    {clock:()=>now,fetch:(async()=>{calls++;throw new Error('must not fetch');}) as typeof fetch});
  armed=true;await assert.rejects(provider.interact({sessionId:'s',requestId:'r',kind:'user',selectedText:'synthetic',recalled:[],
    engineeredPrior:{background:null,neural:null,backend:'baseline'},motive:null,signal:new AbortController().signal}),/INFERENCE_TIMEOUT/);
  assert.equal(calls,0);assert.equal(v.reserved,1);assert.equal(resources.lastRequestAudit,null);v.close();
});

test('synchronous take persistence cannot return text after original host lease/deadline',async()=>{
  const c=config();let now=100,armed=false;
  const v=new DurableMemory(c,8,{fault:p=>{if(armed&&p==='after-authority-commit')now=30100;}});
  const resources=new InteractionResources(new RequestBudget({total:8,hourly:8,daily:8},()=>now,{initialTotal:0,reserve:id=>v.reserve(id)}));
  const s=new CoupledSession(v.store,v.store.ensureScope(scopeIdentity),{durable:v,resources,clock:()=>now,
    provider:{interact:async input=>{resources.budget.reserve(input.requestId);return response;}}});
  s.resume();s.setHostContext({quiet:false,available:true,ttlMs:30000});const result=await s.submit({sessionId:s.sessionId,id:'r',selectedText:'synthetic'});
  armed=true;assert.throws(()=>s.takeDelivery(result.deliveryId),/HOST_CONTEXT_BLOCKED/);v.close();
  const reopened=new DurableMemory(c,8);assert.equal(reopened.status.unknownRequests,1);reopened.close();
});

test('missing runtime image APIs fail closed without plaintext fallback',()=>{
  const old=DatabaseSync.prototype.serialize,c=config();
  try {(DatabaseSync.prototype as any).serialize=undefined;assert.throws(()=>new DurableMemory(c,8),/DURABLE_UNSUPPORTED/);}
  finally {DatabaseSync.prototype.serialize=old;}
  assert.equal(readdirSync(c.directory).some(name=>name.startsWith('checkpoint-')),false);
});

test('authority database and individual blob bounds reject before materializing an unbounded ledger',()=>{
  for(const kind of ['file','blob','sidecar'] as const){
    const c=config(),v=new DurableMemory(c,8);v.close();const path=join(c.directory,'authority.sqlite');
    if(kind==='file')truncateSync(path,64*1024*1024+1);
    if(kind==='sidecar'){const side=path+'-journal';writeFileSync(side,Buffer.alloc(0));truncateSync(side,64*1024*1024+1);}
    if(kind==='blob'){const db=new DatabaseSync(path);db.prepare('INSERT INTO entries VALUES (?,?)').run(2,Buffer.alloc(4*1024*1024+1));db.close();}
    assert.throws(()=>new DurableMemory(c,8),/DURABLE_(LIMIT|CORRUPT)/);
  }
});

test('KNOWN_UNPROTECTED_LEDGER_ROLLBACK: an external valid-prefix rollback can rewind quota without changing keys or checkpoints',t=>{
  const c=config(),v=new DurableMemory(c,8);v.claim('request','payload');const prefix=v.status.sequence;v.reserve('request');
  assert.equal(v.reserved,1);v.close();
  const snapshots=readdirSync(c.directory).filter(n=>n.startsWith('checkpoint-')).map(name=>[name,readFileSync(join(c.directory,name))] as const);
  const external=new DatabaseSync(join(c.directory,'authority.sqlite'));
  external.prepare('DELETE FROM entries WHERE sequence>?').run(prefix);external.close();
  const restored=new DurableMemory(c,8);assert.equal(restored.reserved,0);assert.equal(restored.status.unknownRequests,1);restored.close();
  for(const [name,bytes] of snapshots)assert.deepEqual(readFileSync(join(c.directory,name)),bytes);
  t.diagnostic('KNOWN_UNPROTECTED_LEDGER_ROLLBACK: protectionImplemented=false; complete latest independent ledger is required; not a rollback-defense PASS');
});

test('second process cannot own vault; killed owner releases OS lock without deleting lock file',async()=>{
  const c=config();const url=new URL('../src/durable-memory.ts',import.meta.url).href;
  const script=`import {DurableMemory} from ${JSON.stringify(url)}; let b='';process.stdin.on('data',x=>{b+=x;if(b.includes('\\n')){const v=new DurableMemory(JSON.parse(b),8);v.claim('killed','payload');v.reserve('killed');process.stdout.write('READY\\n');setInterval(()=>{},1000);}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'pipe',windowsHide:true});let err='';child.stderr.on('data',b=>{err+=b;});
  try {
    const ready=new Promise<void>((resolve,reject)=>{child.stdout.on('data',b=>{if(b.toString().includes('READY'))resolve();});child.once('exit',()=>reject(new Error(err)));});
    child.stdin.write(JSON.stringify(c)+'\n');await ready;
    assert.throws(()=>new DurableMemory(c,8),/DURABLE_LOCKED/);
    const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await exit;
    const v=new DurableMemory(c,8);assert.equal(v.reserved,1);assert.equal(v.status.unknownRequests,1);v.close();
  } finally {child.kill();}
});
