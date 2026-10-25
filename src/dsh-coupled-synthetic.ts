/** Explicit synthetic acceptance child. No HTTP provider, key lookup or neural worker. */
import { pathToFileURL } from 'node:url';
import { runTrustedStdio } from './coupled-stdio.ts';
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  void runTrustedStdio({input:process.stdin,output:process.stdout,providerFactory:(_config,resources)=>({
    interact:async()=>{resources.budget.reserve();return {version:1,responseText:'SYNTHETIC_COUPLED_REPLY',
      appraisal:{kind:'appraisal-hypothesis',confidence:0,valence:0,arousal:0,uncertainty:0,fatigue:0},memoryProposal:null};}
  })}).then(result=>process.exit(result.status==='closed'?0:1),()=>process.exit(1));
}
