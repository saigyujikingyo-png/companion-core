import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { OfflineStdioClient, OfflineClientError, OFFLINE_WATCHDOGS, OFFLINE_CASE_WATCHDOG_MS } from './fixtures/offline-stdio-client.ts';
import type { OfflineDiagnostic } from './fixtures/offline-stdio-client.ts';

function childHost(delayB=false){
  return new OfflineStdioClient(spawn(process.execPath,[fileURLToPath(new URL('./fixtures/durable-stdio-synthetic.ts',import.meta.url)),
    ...(delayB?['--delay-b-2300']:[])],{stdio:'pipe',windowsHide:true}));
}
const failureCode=(error:unknown)=>error instanceof OfflineClientError?error.code:'OFFLINE_CASE_ASSERTION_OR_UNKNOWN';

test('offline real stdin child: A/B, pause/C, restore/D, revoke A, second restore preserves quota and revocation',{timeout:OFFLINE_CASE_WATCHDOG_MS},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'companion-revoke-restart-'));
  const persistence={directory,identity:'SYNTHETIC_REVOKE_RESTART',keyBase64:randomBytes(32).toString('base64')};
  const evidence:Array<Record<string,unknown>>=[],transport:Array<{process:number;events:OfflineDiagnostic[]}>=[];
  let host:ReturnType<typeof childHost>|undefined,processes=0,primaryFailure:unknown=null;
  const stop=async()=>{await host!.stop();transport.push({process:processes,events:host!.diagnostics});host=undefined;};
  const boot=async(expected:number)=>{
    host=childHost(expected===0);processes++;const started=performance.now();
    const frame=await host.send('boot',{maxCalls:8,apiKey:'SYNTHETIC_OFFLINE_NOT_A_CREDENTIAL',persistence});
    evidence.push({phase:'boot',ok:frame.ok,code:frame.error?.code,elapsedMs:performance.now()-started,expected,stderrBytes:host.stderrBytes});
    assert.equal(frame.ok,true);assert.equal(frame.result.requests.total,expected);assert.equal(frame.result.paused,true);assert.equal(frame.result.available,false);
    return frame.result.sessionId as string;
  };
  const activate=async(sessionId:string)=>{
    assert.equal((await host!.send('resume',{sessionId})).ok,true);
    assert.equal((await host!.send('context',{sessionId,quiet:false,available:true,ttlMs:30000})).ok,true);
  };
  const turn=async(sessionId:string,messageId:string,selectedText:string,feedback?:{deliveryId:string;outcome:'engaged'})=>{
    const submit=await host!.send('submit',{sessionId,messageId,selectedText,recallQuery:'violet',...(feedback?{feedback}:{})});assert.equal(submit.ok,true);
    const taken=await host!.send('take',{sessionId,deliveryId:submit.result.deliveryId});assert.equal(taken.ok,true);
    assert.equal((await host!.send('ack',{sessionId,deliveryId:submit.result.deliveryId})).ok,true);
    const status=await host!.send('status');assert.equal(status.ok,true);
    evidence.push({phase:messageId,calls:status.result.requests.total,source:status.result.lastSourceRef,memory:status.result.lastMemoryRef,
      recalled:taken.result.recall.map((r:any)=>r.ref),state:status.result.background?.attentionPrior});
    return {deliveryId:submit.result.deliveryId as string,source:status.result.lastSourceRef,memory:status.result.lastMemoryRef,taken:taken.result};
  };
  try {
    let token=await boot(0);await activate(token);const a=await turn(token,'A','SYNTHETIC violet preference A');
    const b=await turn(token,'B','SYNTHETIC violet feedback B',{deliveryId:a.deliveryId,outcome:'engaged'});
    const delayedReply=host!.diagnostics.filter(row=>row.event==='reply'&&row.command==='submit').at(-1)!;
    assert.ok(delayedReply.elapsedMs!>2000); // This valid response exceeded the former test-only watchdog.
    assert.equal((await host!.send('pause')).ok,true);
    const blocked=await host!.send('submit',{sessionId:token,messageId:'paused-attempt',selectedText:'SYNTHETIC should not call'});
    assert.equal(blocked.error?.code,'SESSION_PAUSED');await activate(token);const c=await turn(token,'C','SYNTHETIC violet source C');
    await stop();
    const old=token;token=await boot(3);assert.notEqual(token,old);await activate(token);
    const d=await turn(token,'D','SYNTHETIC violet restored D');assert.ok(d.taken.recall.some((r:any)=>r.ref.id===a.memory.id));
    assert.equal((await host!.send('pause')).ok,true);
    const revoked=await host!.send('revoke',{sessionId:token,ref:a.source});assert.equal(revoked.ok,true);assert.equal(revoked.result.status.invalidated,true);
    await stop();
    const previous=token;token=await boot(4);assert.notEqual(token,previous);await activate(token);
    const e=await turn(token,'E-offline-only','SYNTHETIC violet post-revoke E');
    assert.equal(e.taken.recall.some((r:any)=>[a.memory.id,a.source.id].includes(r.ref.id)),false);
    assert.equal(e.taken.sourceRefs.some((r:any)=>[a.memory.id,a.source.id].includes(r.id)),false);
    for(const sibling of [b,c,d])assert.ok(e.taken.recall.some((r:any)=>r.ref.id===sibling.memory.id));
    await stop();
  } catch(error){primaryFailure=error;throw error;}
  finally {
    let cleanupFailure:unknown=null;
    if(host){try{await host.force();}catch(error){cleanupFailure=error;}finally{transport.push({process:processes,events:host.diagnostics});}}
    const failures={primary:primaryFailure?failureCode(primaryFailure):null,cleanup:cleanupFailure?failureCode(cleanupFailure):null};
    writeFileSync(join(directory,'offline-reproduction.json'),JSON.stringify({version:2,watchdogs:OFFLINE_WATCHDOGS,
      caseWatchdogMs:OFFLINE_CASE_WATCHDOG_MS,realModelCalls:0,failures,evidence,transport},null,2));
    t.diagnostic(JSON.stringify({syntheticEvidence:join(directory,'offline-reproduction.json'),watchdogs:OFFLINE_WATCHDOGS,
      caseWatchdogMs:OFFLINE_CASE_WATCHDOG_MS,realModelCalls:0,failures,transport,
      phases:evidence.map(({phase,ok,code,elapsedMs,calls})=>({phase,ok,code,elapsedMs,calls}))}));
    // Preserve the original assertion/RPC failure; cleanup uncertainty is separate evidence.
    if(cleanupFailure&&!primaryFailure)throw cleanupFailure;
  }
});
