// Official DSH application plugin. Empty profile bundles are required.
// stdout is a private operation pipe to one trusted parent, never a model/session channel.
export const name='wf2-teacher-control';
const states=['READY','RUNNING','COMPLETED','STOPPED','PAUSED','CANCELLED','OWNER_LOST','UNKNOWN'];
const terminal=state=>['COMPLETED','STOPPED','PAUSED','CANCELLED','OWNER_LOST','UNKNOWN'].includes(state);
function closed(value,keys){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
export function apply(ctx){
  const args=ctx.get('cmdlineArgs')?.get(),exit=ctx.get('appExit'),ready=ctx.get('appReady');
  if(!exit||!ready||JSON.stringify(args)!=='["--teacher-control"]')throw Error('WF2_FIXED_ARGS');
  for(const service of ['llm','agents','sessions','commands','compaction','sessionTitle'])if(ctx.get(service)!==undefined)throw Error('WF2_FORBIDDEN_MODEL_SERVICE');
  let phase='WAIT_GRANT',bytes=0,lines=0,buffer=Buffer.alloc(0),done=false,timer,pendingStartReply=false;
  const finish=code=>{if(done)return;done=true;clearTimeout(timer);process.stdin.off('data',data);process.stdin.off('end',end);process.stdin.off('error',failed);process.stdin.off('close',failed);process.stdin.destroy();exit(code);};
  const failed=()=>finish(1),end=()=>finish(1);
  const send=(requestId,operation)=>process.stdout.write(JSON.stringify({version:1,requestId,operation})+'\n');
  function line(raw){
    if(++lines>16)throw Error('WF2_PIPE_LIMIT');const frame=JSON.parse(raw);
    // Parent emits exact compact JSON; rejecting other representations also rejects duplicate keys.
    if(raw!==JSON.stringify(frame)||frame.version!==1)throw Error('WF2_PIPE_FORMAT');
    if(phase==='WAIT_GRANT'){
      if(!closed(frame,['version','kind'])||frame.kind!=='grant')throw Error('WF2_PIPE_GRANT');
      phase='WAIT_STATUS';send('initial-status','status');return;
    }
    if(frame.kind==='settled'){
      if(!closed(frame,['version','kind','state'])||!terminal(frame.state)||!['WAIT_START','RUNNING'].includes(phase))throw Error('WF2_PIPE_SETTLED');
      finish(frame.state==='COMPLETED'?0:1);return;
    }
    if(frame.kind==='control'){
      if(!closed(frame,['version','kind','operation'])||!['pause','cancel'].includes(frame.operation)||!['WAIT_START','RUNNING'].includes(phase))throw Error('WF2_PIPE_CONTROL');
      phase='WAIT_TERMINAL';send('terminal-control',frame.operation);return;
    }
    if(!closed(frame,['version','kind','requestId','operation','state'])||frame.kind!=='reply'||!states.includes(frame.state))throw Error('WF2_PIPE_REPLY');
    if(phase==='WAIT_STATUS'&&frame.requestId==='initial-status'&&frame.operation==='status'&&frame.state==='READY'){
      phase='WAIT_START';pendingStartReply=true;send('single-start','start');return;
    }
    // Parent may forward a terminal control while the start reply is still in the pipe.
    // Consume that older reply without losing the newer pause/cancel request.
    if(phase==='WAIT_TERMINAL'&&pendingStartReply&&frame.requestId==='single-start'&&frame.operation==='start'){
      if(frame.state!=='RUNNING'&&!terminal(frame.state))throw Error('WF2_PIPE_START');pendingStartReply=false;return;
    }
    if(phase==='WAIT_START'&&frame.requestId==='single-start'&&frame.operation==='start'){
      pendingStartReply=false;if(terminal(frame.state)){finish(frame.state==='COMPLETED'?0:1);return;}if(frame.state!=='RUNNING')throw Error('WF2_PIPE_START');phase='RUNNING';return;
    }
    if(phase==='WAIT_TERMINAL'&&frame.requestId==='terminal-control'&&['pause','cancel'].includes(frame.operation)&&terminal(frame.state)){finish(1);return;}
    throw Error('WF2_PIPE_ORDER');
  }
  function data(chunk){
    try{bytes+=chunk.length;if(bytes>16384)throw Error('WF2_PIPE_BYTES');buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8192)throw Error('WF2_PIPE_LINE');
      for(let index;(index=buffer.indexOf(10))>=0;){const raw=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,index));buffer=buffer.subarray(index+1);line(raw);if(done)return;}
    }catch{finish(1);}
  }
  const cancel=ready.onReady(()=>{if(process.stdin.destroyed||process.stdin.readableEnded){finish(1);return;}process.stdin.on('data',data);process.stdin.once('end',end);process.stdin.once('error',failed);process.stdin.once('close',failed);timer=setTimeout(failed,3900000);});
  ctx.effect(()=>()=>{cancel();clearTimeout(timer);process.stdin.off('data',data);process.stdin.off('end',end);process.stdin.off('error',failed);process.stdin.off('close',failed);process.stdin.destroy();},'wf2.control.lifecycle');
}
