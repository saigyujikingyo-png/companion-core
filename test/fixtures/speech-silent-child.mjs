// Original synthetic protocol fixture. It never imports or invokes an audio API.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const monitorDirectory=process.env.SPEECH_TEST_MONITOR_ACK_DIR;
if(monitorDirectory){
  const deadline=Date.now()+2000,ack=join(monitorDirectory,process.pid+'.ack');
  while(!existsSync(ack)){if(Date.now()>=deadline)process.exit(71);await delay(5);}
}
const mode=process.argv[2]??'normal';
let initialization=null,sequence=0,spoken=false,ended=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const event=(kind,code='SYNTHETIC')=>send({version:1,kind,token:initialization.token,sequence:++sequence,streamId:spoken?7:0,code});
const exit=()=>{if(ended)return;ended=true;process.exitCode=0;reader.close();process.stdin.destroy();};
const reader=createInterface({input:process.stdin});
reader.on('line',line=>{
  if(Buffer.byteLength(line)>16384){process.exitCode=1;exit();return;}
  const request=JSON.parse(line);
  if(request.action==='initialize'){
    initialization=request;
    send({version:1,kind:'ready',token:request.token,profile:mode==='missing-profile'?{...request.profile,voiceTokenId:'wrong'}:request.profile});
  }else if(request.action==='speak'){
    if(spoken){process.exitCode=1;exit();return;}spoken=true;
    if(mode==='overflow'){process.stdout.write('x'.repeat(17000));return;}
    if(mode==='malformed'){process.stdout.write('{bad}\n');return;}
    if(mode==='truncated'){process.stdout.write('{partial');exit();return;}
    if(mode==='unknown'){send({version:1,kind:'chunk',token:initialization.token,sequence:1,streamId:7,code:'SYNTHETIC',chunk:1});return;}
    event('queued');
    if(mode==='normal')setTimeout(()=>{event('completed');exit();},10);
  }else if(request.action==='stop'){
    if(mode==='ignore-stop')return;
    event('stopped');exit();
  }
});
reader.on('close',()=>{
  // EOF simulates a parent loss: the fake engine clears its synthetic active state.
  if(!ended&&initialization){event('stopped','EOF_PURGED');ended=true;}
});
setTimeout(()=>{if(!ended){if(initialization)event('stopped','LOCAL_WATCHDOG');exit();}},8000).unref();
