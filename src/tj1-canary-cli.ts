import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { boundedJson, canonical, CanaryError, canaryFail, closed } from './tj1-spec.ts';
import { boundedFile } from './tj1-ledger.ts';
import type { CanaryAuthority } from './tj1-ledger.ts';
import { prepareCanary, readCanaryHistory, runCanary } from './tj1-observer.ts';

// Explicit operator entrypoint. Never called by npm check, a demo, import, or a scheduler.
async function main():Promise<void> {
  const args=process.argv.slice(2),mode=args.shift();if(!['prepare','run','read'].includes(mode??''))canaryFail('TJ1_CLI_USAGE');
  const values:Record<string,string>={};while(args.length){const key=args.shift()!,value=args.shift();
    if(!['--directory','--authority-file','--manifest-digest','--python-path'].includes(key)||value===undefined||values[key]!==undefined)canaryFail('TJ1_CLI_USAGE');values[key]=value;}
  const directory=values['--directory'],authorityFile=values['--authority-file'];if(!directory||!authorityFile||!isAbsolute(authorityFile))canaryFail('TJ1_CLI_USAGE');
  const authorityPath=realpathSync(authorityFile),archive=realpathSync(directory),rel=relative(archive,authorityPath);
  if(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel))canaryFail('TJ1_AUTHORITY_LOCATION');
  if((process.platform==='win32'?resolve(authorityFile).toLowerCase():resolve(authorityFile))!==(process.platform==='win32'?authorityPath.toLowerCase():authorityPath))canaryFail('TJ1_AUTHORITY_LOCATION');
  const authority=():CanaryAuthority=>{
    boundedFile(authorityPath,4_096);const v=closed(boundedJson(readFileSync(authorityPath,'utf8')),['scopeId','generation','consentRevision','runtimeId','expiresAt','read','write','train','export']);
    return {...v,now:Date.now()} as CanaryAuthority;
  };
  const options={directory:archive,authority};
  if(mode==='prepare'){if(values['--manifest-digest']||!values['--python-path'])canaryFail('TJ1_CLI_USAGE');console.log(canonical(prepareCanary({...options,pythonPath:values['--python-path']})));}
  else if(mode==='run'){const expectedManifestDigest=values['--manifest-digest'];if(!expectedManifestDigest||values['--python-path'])canaryFail('TJ1_CLI_USAGE');
    console.log(canonical(await runCanary({...options,expectedManifestDigest})));}
  else {if(values['--manifest-digest']||values['--python-path'])canaryFail('TJ1_CLI_USAGE');const history=readCanaryHistory(options);
    console.log(canonical({assurance:history.assurance,recovery:history.recovery,projection:history.projection,records:history.records.length}));}
}
main().catch(error=>{console.error(error instanceof CanaryError?error.code:'TJ1_CLI_UNKNOWN');process.exitCode=1;});
