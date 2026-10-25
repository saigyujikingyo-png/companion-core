import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openAuditSink } from './audit-sink.js';

async function readPublicConfig(provided){
  if(provided?.sessionId)return provided;
  if(provided?.configPath!==undefined&&(typeof provided.configPath!=='string'||Object.keys(provided).some(key=>key!=='configPath')))
    throw new Error('COMPANION_CONFIG_INVALID');
  const path=provided?.configPath??process.env.COMPANION_CORE_CONFIG_PATH;
  if(typeof path!=='string'||!isAbsolute(path)||!path.toLowerCase().endsWith('.json'))throw new Error('COMPANION_PUBLIC_CONFIG_REQUIRED');
  const file=await open(path,'r');try{
    if((await file.stat()).size>32768)throw new Error('COMPANION_CONFIG_TOO_LARGE');
    const buffer=Buffer.alloc(32769),{bytesRead}=await file.read(buffer,0,buffer.length,0);
    if(bytesRead>32768)throw new Error('COMPANION_CONFIG_TOO_LARGE');
    try{return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}catch{throw new Error('COMPANION_CONFIG_INVALID');}
  }finally{await file.close();}
}

const loadHost=config=>import(pathToFileURL(join(config.launcher.corePath,'src','dsh-coupled-host.ts')).href);

/** Thin-package ownership. Every unload path awaits the very same host cleanup
 * before ending its sink, including unload while open or mount is pending. */
export async function applyCoupledPlugin(ctx,provided,sdk,dependencies={}){
  let stopped=false,startup,mounted,hostCleanup,sink,closing;
  const cleanup=()=>{
    stopped=true;
    if(closing)return closing;
    const stopping=hostCleanup?.();
    closing=(async()=>{
      try{await startup;}catch{}
      let graceful=true;
      try{if(hostCleanup)graceful=await hostCleanup();else if(mounted)graceful=await mounted.cleanup();await stopping;}catch{graceful=false;}
      const auditClosed=sink?await sink.close():true;
      return graceful&&auditClosed;
    })();return closing;
  };
  ctx.effect(()=>async()=>{await cleanup();});
  startup=(async()=>{
    const providedConfig=await readPublicConfig(provided);
    if(stopped)return;
    if(typeof providedConfig?.launcher?.corePath!=='string'||!isAbsolute(providedConfig.launcher.corePath))throw new Error('COMPANION_CONFIG_INVALID');
    const host=await (dependencies.loadHost??loadHost)(providedConfig);
    const config=host.validateDshConfig(providedConfig);
    if(stopped)return;
    if(config.auditFile)sink=await (dependencies.openSink??openAuditSink)(config,{onFailure:()=>{void cleanup();}});
    if(stopped)return;
    mounted=await host.mountDshCoupled(ctx,config,sdk,{
      ...dependencies.mountDependencies,...(sink?{output:sink.output}:{}),
      onCleanupReady:fn=>{hostCleanup=fn;if(stopped)void fn();}
    });
  })();
  try{await startup;if(stopped)await cleanup();}
  catch{await cleanup();throw new Error('COMPANION_PLUGIN_START_FAILED');}
  return {cleanup,mounted};
}
