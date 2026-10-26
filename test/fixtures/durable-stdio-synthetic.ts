import { runTrustedStdio } from '../../src/coupled-stdio.ts';

// Offline process fixture only: no network, credential discovery or native host.
void runTrustedStdio({input:process.stdin,output:process.stdout,providerFactory:(_config,resources)=>({interact:async input=>{
  resources.budget.reserve(input.requestId);
  return {version:1,responseText:'SYNTHETIC_OFFLINE_REPLY',memoryProposal:null,
    appraisal:{kind:'appraisal-hypothesis',confidence:.8,valence:.4,arousal:.2,uncertainty:0,fatigue:0}};
}})}).then(result=>process.exit(result.status==='closed'?0:1),()=>process.exit(2));
