import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDshTeacherOperation,validateTeacherReply } from '../src/wf2-teacher-service.ts';
import { parseJson,shape } from '../src/wf1-json.ts';
const plugin=new URL('../integrations/dsh-teacher-control/index.mjs',import.meta.url);
function childPlugin(){
  // This fixture only tests plugin framing. It is never native DSH acceptance.
  const source=`import {apply} from ${JSON.stringify(plugin.href)};const disposers=[];const map={cmdlineArgs:{get:()=>['--teacher-control']},appExit:code=>{for(const dispose of disposers)dispose();process.exitCode=code},appReady:{onReady:callback=>{const pending=setImmediate(callback);return ()=>clearImmediate(pending);}}};apply({get:name=>map[name],effect:factory=>{const dispose=factory();if(typeof dispose!=='function')throw Error('SYNTHETIC_EFFECT_DISPOSER_REQUIRED');disposers.push(dispose);}});`;
  const child=spawn(process.execPath,['--input-type=module','--eval',source],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const guard=setTimeout(()=>child.kill(),4500);child.once('close',()=>clearTimeout(guard));return child;
}
function channel(child){let buffer='',messages=[];const waiters=[];child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;for(let i;(i=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const parsed=JSON.parse(line);if(waiters.length)waiters.shift()(parsed);else messages.push(parsed);}});
  const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});child.stdin.on('error',()=>{});
  return {next:()=>messages.length?Promise.resolve(messages.shift()):new Promise(resolve=>waiters.push(resolve)),send:value=>child.stdin.write(JSON.stringify(value)+'\n'),closed,get errors(){return errors;}};
}
test('plugin framing has exactly status/start operations and no private capability in output',{timeout:5000},async()=>{
  const child=childPlugin(),c=channel(child);c.send({version:1,kind:'grant'});assert.deepEqual(await c.next(),{version:1,requestId:'initial-status',operation:'status'});
  c.send({version:1,kind:'reply',requestId:'initial-status',operation:'status',state:'READY'});assert.deepEqual(await c.next(),{version:1,requestId:'single-start',operation:'start'});
  c.send({version:1,kind:'reply',requestId:'single-start',operation:'start',state:'RUNNING'});c.send({version:1,kind:'settled',state:'COMPLETED'});assert.equal(await c.closed,0,c.errors);
});
test('plugin framing rejects extra fields and owner EOF without starting a worker',{timeout:5000},async()=>{
  const child=childPlugin(),c=channel(child);c.send({version:1,kind:'grant',workerPath:'forbidden'});assert.equal(await c.closed,1);
  const other=childPlugin(),d=channel(other);d.send({version:1,kind:'grant'});await d.next();other.stdin.end();assert.equal(await d.closed,1);
});
test('plugin terminal control tolerates the older start reply still in transit',{timeout:5000},async()=>{
  const child=childPlugin(),c=channel(child);c.send({version:1,kind:'grant'});await c.next();c.send({version:1,kind:'reply',requestId:'initial-status',operation:'status',state:'READY'});await c.next();
  c.send({version:1,kind:'control',operation:'cancel'});assert.deepEqual(await c.next(),{version:1,requestId:'terminal-control',operation:'cancel'});
  c.send({version:1,kind:'reply',requestId:'single-start',operation:'start',state:'RUNNING'});c.send({version:1,kind:'reply',requestId:'terminal-control',operation:'cancel',state:'CANCELLED'});assert.equal(await c.closed,1);
});
test('separate synthetic worker and plugin pipes bind one run and settle both children',{timeout:5000},async()=>{
  const cap='d4'.repeat(32),worker=spawn(process.execPath,[fileURLToPath(new URL('../scripts/wf2-synthetic-teacher-worker.ts',import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true}),w=channel(worker);
  w.send({version:'wf2-synthetic-bind/1',capability:cap});assert.deepEqual(await w.next(),{version:'wf2-worker-event/1',type:'ready'});
  const dsh=childPlugin(),d=channel(dsh);d.send({version:1,kind:'grant'});
  for(let i=0;i<2;i++){const op=parseDshTeacherOperation(await d.next());assert.equal(op.operation,i===0?'status':'start');w.send({...op,capability:cap});const event=shape(parseJson(JSON.stringify(await w.next())),['version','type','reply']);const reply=validateTeacherReply(event.reply);assert.equal(reply.metadata.calls.deepseek,0);d.send({version:1,kind:'reply',requestId:reply.requestId,operation:reply.operation,state:reply.state});}
  const settled=await w.next();assert.equal(settled.type,'settled');assert.equal(settled.state,'COMPLETED');w.send({version:'wf2-worker-control/1',action:'acknowledge-completed',completionDigest:settled.completion.digest});assert.deepEqual(await w.next(),{version:'wf2-worker-event/1',type:'completion-acknowledged'});
  d.send({version:1,kind:'settled',state:'COMPLETED'});assert.equal(await d.closed,0);worker.stdin.end();assert.equal(await w.closed,0);
});
