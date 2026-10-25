import { createWriteStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';

export const AUDIT_MAX_BYTES=512*1024;
const prefix='COMPANION_COUPLED_EVENT:';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const numberKeys=new Set(['turn','requests','replyCharacters','realModelCalls','providerCalls','syntheticCalls','recallCount','sourceRefCount','elapsedMs']);
const booleanKeys=new Set(['corePaused','available','workerResident','completed','cancelled','duplicate','disposed','usageSnapshotKnown']);
const tokenKeys=new Set(['kind','status','code','appraisalStatus']);
const idKeys=new Set(['messageId','deliveryId']);

// Only the mount's already filtered event protocol may enter this private file.
// Never capture host stdout/stderr, console, prompt text or exception messages.
function checkedLine(chunk,config){
  const provider=config.launcher.persistence
    ?`companion-core-${createHash('sha256').update(config.launcher.persistence.identity).digest('hex').slice(0,12)}`:'companion-core';
  const line=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);
  if(Buffer.byteLength(line)>4096||!line.startsWith(prefix)||!line.endsWith('\n')||line.slice(0,-1).includes('\n'))
    throw new Error('COMPANION_AUDIT_PROTOCOL');
  const value=JSON.parse(line.slice(prefix.length));
  if(!value||Array.isArray(value)||value.auditId!==config.auditId||value.sessionId!==config.sessionId
    ||typeof value.kind!=='string'||typeof value.status!=='string')throw new Error('COMPANION_AUDIT_PROTOCOL');
  for(const [key,item] of Object.entries(value)){
    const valid=key==='auditId'||key==='sessionId'?uuid.test(item)
      :numberKeys.has(key)?Number.isSafeInteger(item)&&item>=0
      :booleanKeys.has(key)?typeof item==='boolean'
      :idKeys.has(key)?typeof item==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(item)
      :tokenKeys.has(key)?typeof item==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(item)
      :key==='replySha256'?typeof item==='string'&&/^[a-f0-9]{64}$/.test(item)
      :key==='provider'?item===provider
      :key==='model'?item==='coupled'
      :key==='backend'?['baseline','no-state','flywire'].includes(item):false;
    if(!valid)throw new Error('COMPANION_AUDIT_PROTOCOL');
  }
  return Buffer.from(prefix+JSON.stringify(value)+'\n','utf8');
}

async function bounded(promise,timeoutMs){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('COMPANION_AUDIT_TIMEOUT')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}

export async function openAuditSink(config,{createFile=createWriteStream,timeoutMs=2000,onFailure=()=>{}}={}){
  if(!uuid.test(config.auditId)||!uuid.test(config.sessionId)||typeof config.launcher?.runtimeRoot!=='string'||!isAbsolute(config.launcher.runtimeRoot))
    throw new Error('COMPANION_AUDIT_CONFIG');
  const path=join(config.launcher.runtimeRoot,`audit-${config.auditId}.jsonl`);
  const file=createFile(path,{flags:'wx',mode:0o600,highWaterMark:65536,autoClose:true,emitClose:true});
  let output,failed=false,totalBytes=0,closing,closingRequested=false;
  const fail=()=>{failed=true;output?.destroy(new Error('COMPANION_AUDIT_FAILED'));onFailure();};
  // Registered before open: errors cannot escape during startup or after unload.
  file.on('error',fail);
  const closed=new Promise(resolve=>file.once('close',()=>{resolve();if(!closingRequested)fail();}));
  let onOpen,onOpenError,onOpenClose;
  try{
    await bounded(new Promise((resolve,reject)=>{
      onOpen=resolve;
      onOpenError=onOpenClose=()=>reject(new Error('COMPANION_AUDIT_OPEN_FAILED'));
      file.once('open',onOpen);file.once('error',onOpenError);file.once('close',onOpenClose);
    }),timeoutMs);
  }catch{
    closingRequested=true;
    file.destroy();try{await bounded(closed,timeoutMs);}catch{}
    throw new Error('COMPANION_AUDIT_OPEN_FAILED');
  }finally{file.off('open',onOpen);file.off('error',onOpenError);file.off('close',onOpenClose);}
  output=new Writable({autoDestroy:false,highWaterMark:65536,write(chunk,_encoding,callback){
    let data;
    try{data=checkedLine(chunk,config);if(totalBytes+data.length>AUDIT_MAX_BYTES)throw new Error('COMPANION_AUDIT_CAP');}
    catch{failed=true;callback(new Error('COMPANION_AUDIT_REJECTED'));return;}
    totalBytes+=data.length;
    let timer=setTimeout(()=>{timer=undefined;fail();file.destroy(new Error('COMPANION_AUDIT_TIMEOUT'));},timeoutMs);
    file.write(data,error=>{clearTimeout(timer);callback(error?new Error('COMPANION_AUDIT_WRITE_FAILED'):undefined);});
  }});
  output.on('error',()=>{failed=true;onFailure();});
  return {output,path,get bytes(){return totalBytes;},close(){
    if(closing)return closing;
    closingRequested=true;
    closing=(async()=>{
      try{
        if(!failed&&!output.destroyed){const drained=finished(output,{cleanup:true});output.end();await bounded(drained,timeoutMs);}
        if(failed)file.destroy();else file.end();
        await bounded(closed,timeoutMs);
      }catch{failed=true;file.destroy();try{await bounded(closed,timeoutMs);}catch{}}
      finally{output.destroy();}
      return !failed;
    })();return closing;
  }};
}
