import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { openAuditSink, AUDIT_MAX_BYTES } from '../integrations/dsh/lib/audit-sink.js';
import { applyCoupledPlugin } from '../integrations/dsh/lib/plugin-runtime.js';
import * as hostModule from '../src/dsh-coupled-host.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function configuration(){const directory=await mkdtemp(join(tmpdir(),'companion-audit-test-'));return {
  auditId:randomUUID(),sessionId:randomUUID(),cwd:directory,auditFile:true,
  launcher:{mode:'synthetic',corePath:resolve('.'),nodePath:process.execPath,runtimeRoot:directory,maxCalls:0}};}
const line=(config,extra={})=>'COMPANION_COUPLED_EVENT:'+JSON.stringify({auditId:config.auditId,sessionId:config.sessionId,kind:'status',status:'ready',...extra})+'\n';
const write=(output,value)=>new Promise((resolve,reject)=>output.write(value,error=>error?reject(error):resolve()));
function fakeHost(config){
  const effects=[],commands=new Map();let created=0,closed=0,disposed=0,requests=0;
  const backend={sessionId:randomUUID(),command:async name=>{if(name==='submit')requests++;return {paused:true,available:false,backend:'baseline',requests:{total:requests}};},
    close:async()=>{closed++;return {closed:true,graceful:true};}};
  const agent={session:{id:config.sessionId},cancel:async()=>{},followup:()=>assert.fail('unexpected followup'),
    ctx:{on:()=>()=>{},inject:(_names,fn)=>fn({commands:{register:definition=>{commands.set(definition.name,definition);return()=>commands.delete(definition.name);}}})}};
  const ctx={effect:fn=>{effects.push(fn());},on:()=>()=>{},llm:{registerAdapter:()=>()=>{}},
    sessions:{get:id=>{assert.equal(id,config.sessionId);return null;},flush:async()=>{}},
    agents:{get:id=>{assert.equal(id,config.sessionId);return null;},create:async()=>{created++;return {agent,dispose:async()=>{disposed++;}};}}};
  return {ctx,effects,backend,commands,get counts(){return {created,closed,disposed,requests};}};
}
const sdk={LlmAdapter:class{},createUserMessage:()=>assert.fail('unexpected setup or human message')};
const dependencies=host=>({loadHost:async()=>hostModule,mountDependencies:{startBackend:async()=>host.backend}});

test('exclusive audit opens only fixed runtime path and retains complete terminal frame after same cleanup',async()=>{
  const config=await configuration(),host=fakeHost(config);let opened;
  const result=await applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),openSink:(value,options)=>openAuditSink(value,{...options,
    createFile:(path,flags)=>{opened={path,flags};assert.equal(host.effects.length,1);return createWriteStream(path,flags);}})});
  assert.equal(opened.path,join(config.launcher.runtimeRoot,`audit-${config.auditId}.jsonl`));assert.equal(opened.flags.flags,'wx');
  assert.equal(host.counts.created,1);
  // Cordis may run both effects concurrently. The wrapper cannot end the stream early.
  await Promise.all(host.effects.map(effect=>effect()));assert.equal(await result.cleanup(),true);
  assert.equal(result.mounted.cleanup(),result.mounted.cleanup());
  assert.deepEqual(host.counts,{created:1,closed:1,disposed:1,requests:0});
  const text=await readFile(opened.path,'utf8'),frames=text.trimEnd().split('\n').map(value=>JSON.parse(value.slice(24)));
  assert.ok(frames.some(value=>value.kind==='plugin-ready'));assert.equal(frames.at(-1).kind,'disposed');assert.equal(frames.at(-1).status,'closed');
  assert.ok(text.endsWith('\n'));
  const status=await stat(opened.path);assert.ok(status.size>0&&status.size<=AUDIT_MAX_BYTES);
  await assert.rejects(openAuditSink(config),/AUDIT_OPEN_FAILED/);assert.equal(await readFile(opened.path,'utf8'),text);
});

test('unload while asynchronous file open is pending creates no host and closes late sink',async()=>{
  const config=await configuration(),host=fakeHost(config),entered=deferred(),release=deferred();let sink;
  const starting=applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),openSink:async(value,options)=>{
    entered.resolve();await release.promise;sink=await openAuditSink(value,options);return sink;}});
  await entered.promise;const stopping=host.effects[0]();release.resolve();await starting;await stopping;
  assert.equal(sink.output.destroyed,true);assert.equal((await stat(sink.path)).size,0);
  assert.deepEqual(host.counts,{created:0,closed:0,disposed:0,requests:0});
});

test('unload during backend startup harvests it before closing audit without false ready',async()=>{
  const config=await configuration(),host=fakeHost(config),entered=deferred(),release=deferred();
  const starting=applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),mountDependencies:{startBackend:()=>{entered.resolve();return release.promise;}}});
  await entered.promise;const stopping=host.effects[0]();release.resolve(host.backend);await starting;await stopping;
  const text=await readFile(join(config.launcher.runtimeRoot,`audit-${config.auditId}.jsonl`),'utf8');
  assert.equal(text.includes('plugin-ready'),false);assert.equal(text.trim().split('\n').at(-1).includes('disposed'),true);
  assert.deepEqual(host.counts,{created:0,closed:1,disposed:0,requests:0});
});

test('startup failure closes audit and preserves failure plus terminal disposed without ready',async()=>{
  const config=await configuration(),host=fakeHost(config);let sink;
  await assert.rejects(applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),
    openSink:async(value,options)=>sink=await openAuditSink(value,options),
    mountDependencies:{startBackend:async()=>{throw new Error('SYNTHETIC_PRIVATE_FAILURE');}}}),/PLUGIN_START_FAILED/);
  assert.equal(sink.output.destroyed,true);const text=await readFile(sink.path,'utf8');
  assert.equal(text.includes('SYNTHETIC_PRIVATE_FAILURE'),false);assert.equal(text.includes('plugin-ready'),false);
  assert.ok(text.includes('plugin-start'));assert.ok(text.trim().split('\n').at(-1).includes('disposed'));
});

test('audit rejects raw host output and extra text, and cap fails closed without exceeding disk bound',async()=>{
  for(const invalid of ['raw host synthetic URL\n',{text:'synthetic private prompt'}]){
    const config=await configuration();let errors=0;const sink=await openAuditSink(config,{onFailure:()=>{errors++;}});
    await assert.rejects(write(sink.output,typeof invalid==='string'?invalid:line(config,invalid)));
    assert.equal(await sink.close(),false);assert.ok(errors>=1);assert.equal((await stat(sink.path)).size,0);
  }
  const config=await configuration();let errors=0;const sink=await openAuditSink(config,{onFailure:()=>{errors++;}});
  const record=line(config);let accepted=0;
  while(accepted+Buffer.byteLength(record)<=AUDIT_MAX_BYTES){await write(sink.output,record);accepted+=Buffer.byteLength(record);}
  await assert.rejects(write(sink.output,record));assert.equal(await sink.close(),false);assert.ok(errors>=1);
  assert.equal((await stat(sink.path)).size,accepted);assert.ok(accepted<=AUDIT_MAX_BYTES);
});

test('disk failure shuts the owned host down and closes sink using the same cleanup',async()=>{
  const config=await configuration(),host=fakeHost(config);let file,sink;
  const result=await applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),openSink:async(value,options)=>sink=await openAuditSink(value,{...options,
    createFile:(path,flags)=>file=createWriteStream(path,flags)})});
  file.destroy(new Error('SYNTHETIC_PRIVATE_DISK_ERROR'));await tick();assert.equal(await result.cleanup(),false);
  assert.deepEqual(host.counts,{created:1,closed:1,disposed:1,requests:0});assert.equal(sink.output.destroyed,true);
  const text=await readFile(sink.path,'utf8');assert.equal(text.includes('SYNTHETIC_PRIVATE_DISK_ERROR'),false);
});

test('unexpected audit file close fails closed even without a subsequent write',async()=>{
  const config=await configuration(),host=fakeHost(config);let file;
  const result=await applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),openSink:(value,options)=>openAuditSink(value,{...options,
    createFile:(path,flags)=>file=createWriteStream(path,flags)})});
  await tick();file.destroy();await tick();assert.equal(await result.cleanup(),false);
  assert.deepEqual(host.counts,{created:1,closed:1,disposed:1,requests:0});
});

test('slow terminal write is flushed before sink end under concurrent SDK disposal',async()=>{
  const config=await configuration(),host=fakeHost(config),terminal=deferred(),release=deferred(),trace=[];let file;
  const result=await applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),openSink:(value,options)=>openAuditSink(value,{...options,
    createFile:()=>{
      file=new Writable({write(chunk,_encoding,done){
        if(chunk.toString().includes('"kind":"disposed"')){trace.push('terminal-start');terminal.resolve();release.promise.then(()=>{trace.push('terminal-written');done();});}
        else done();
      },final(done){trace.push('file-end');done();}});queueMicrotask(()=>file.emit('open',1));return file;
    }})});
  const stopping=Promise.all(host.effects.map(effect=>effect()));await terminal.promise;
  assert.deepEqual(trace,['terminal-start']);assert.equal(file.writableEnded,false);
  release.resolve();await stopping;assert.equal(await result.cleanup(),true);
  assert.deepEqual(trace,['terminal-start','terminal-written','file-end']);assert.equal(file.destroyed,true);
});

test('bounded write timeout destroys file and closes without retaining handles',async()=>{
  const config=await configuration();let file,destructs=0;
  const sink=await openAuditSink(config,{timeoutMs:20,createFile:()=>{
    file=new Writable({write(_chunk,_encoding,_done){},destroy(error,done){destructs++;done(error);}});
    queueMicrotask(()=>file.emit('open',1));return file;}});
  sink.output.write(line(config));await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(await sink.close(),false);assert.equal(file.destroyed,true);assert.equal(sink.output.destroyed,true);assert.equal(destructs,1);
});

test('audit disabled preserves existing output route without model requests',async()=>{
  const config=await configuration();delete config.auditFile;const host=fakeHost(config),chunks=[];
  const output=new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done();}});
  const result=await applyCoupledPlugin(host.ctx,config,sdk,{...dependencies(host),
    openSink:()=>assert.fail('audit must be opt-in'),mountDependencies:{startBackend:async()=>host.backend,output}});
  assert.ok(host.commands.has('companion-status'));await result.cleanup();assert.ok(chunks.some(chunk=>chunk.includes('plugin-ready')));
  assert.equal(host.counts.requests,0);
});
