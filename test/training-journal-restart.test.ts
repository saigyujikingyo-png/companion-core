import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalTrainingEvent, tjHash } from '../src/training-journal-format.ts';
import { event, freshDirectory, trace } from './fixtures/training-journal-fixture.ts';

const childPath=fileURLToPath(new URL('./fixtures/training-journal-child.ts',import.meta.url));
test('TJ0 actual killed owner releases OS lock; fresh process rebuilds indexes, dedups and appends with new authority',{timeout:60_000},async t=>{
  const directory=freshDirectory(),child=spawn(process.execPath,['--max-old-space-size=64',childPath,'hold',directory],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderrBytes=0,exitObserved=false;
  child.stderr.on('data',(b:Buffer)=>{stderrBytes+=b.length;});
  const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>{exitObserved=true;resolve();});});
  const ready=new Promise<Record<string,unknown>>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('TJ_CHILD_BOOT_TIMEOUT')),10_000);
    child.stdout.on('data',(b:Buffer)=>{stdout+=b.toString('utf8');if(stdout.length>8_192){clearTimeout(timer);reject(Error('TJ_CHILD_OUTPUT_LIMIT'));}
      else if(stdout.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(stdout.split('\n')[0]!));}catch{reject(Error('TJ_CHILD_BAD_FRAME'));}}});
    child.once('exit',()=>{clearTimeout(timer);if(!stdout.includes('\n'))reject(Error('TJ_CHILD_EARLY_EXIT'));});
    child.once('error',()=>{clearTimeout(timer);reject(Error('TJ_CHILD_START_FAILED'));});
  });
  const invoke=(mode:string)=>{
    const result=spawnSync(process.execPath,['--max-old-space-size=64',childPath,mode,directory],{encoding:'utf8',timeout:10_000,maxBuffer:8_192,windowsHide:true});
    assert.equal(result.error,undefined);assert.equal(result.status,0,JSON.stringify({mode,stdout:result.stdout,stderrBytes:result.stderr.length}));
    return JSON.parse(result.stdout.trim()) as Record<string,any>;
  };
  let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
  try {
    const first=await ready;assert.equal(first.events,3);assert.equal(first.lockBytes,0);assert.ok(Number(first.journalBytes)<=512);
    assert.equal(first.digest,tjHash(trace().slice(0,3).map(canonicalTrainingEvent).map(s=>s+'\n').join('')));
    assert.deepEqual(invoke('locked'),{code:'TJ_LOCKED'});
    assert.equal(child.kill('SIGKILL'),true);
    await Promise.race([exited,new Promise<never>((_,reject)=>{cleanupTimer=setTimeout(()=>reject(Error('TJ_CHILD_KILL_TIMEOUT')),5_000);})]);
    clearTimeout(cleanupTimer);assert.equal(exitObserved,true);
    assert.deepEqual(invoke('denied'),{code:'TJ_AUTHORITY'});
    const recovered=invoke('reopen');assert.equal(recovered.before,3);assert.deepEqual(recovered.duplicate,{duplicate:true,sequence:1});
    assert.equal(recovered.conflict,true);assert.equal(recovered.terminal,true);assert.equal(recovered.events,4);
    assert.equal(recovered.steps,'9007199254740993');assert.equal(recovered.mode,'SYNTHETIC_FIXTURE');assert.equal(recovered.realTraining,false);
    const expected=[...trace().slice(0,3),event('TERMINAL',4,{outcome:'FAILED'})].map(canonicalTrainingEvent).map(s=>s+'\n').join('');
    assert.equal(recovered.digest,tjHash(expected));
    writeFileSync(join(directory,'restart-evidence.json'),JSON.stringify({version:1,first,recovered,killedOwnerExited:exitObserved,stderrBytes,realModelCalls:0},null,2));
    t.diagnostic(JSON.stringify({evidence:join(directory,'restart-evidence.json'),killedOwnerExited:exitObserved,realModelCalls:0}));
  }finally {
    clearTimeout(cleanupTimer);
    if(!exitObserved){child.kill('SIGKILL');await Promise.race([exited,new Promise<void>(resolve=>{cleanupTimer=setTimeout(resolve,5_000);})]);clearTimeout(cleanupTimer);}
  }
});
