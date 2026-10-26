import { CanaryGate, CanaryLedger, scopeDigest } from '../../src/tj1-ledger.ts';
const [mode,directory]=process.argv.slice(2);
if(!directory||!['hold','read'].includes(mode??''))process.exit(2);
const authority=()=>({scopeId:'offline-fixture',generation:'0',consentRevision:'0',runtimeId:'runtime-'+mode,now:1000,expiresAt:2000,read:true,write:true,train:false,export:true});
const gate=new CanaryGate(authority);
if(mode==='hold') {
  const ledger=CanaryLedger.create(directory,gate,{logical:'tj1-local-canary-v1',container:'sqlite-event-ledger-v1',codec:'identity-json-v1',lane:'OFFLINE_FIXTURE',
    runId:'offline-run',attemptId:'offline-attempt',manifestDigest:'a'.repeat(64),scopeDigest:scopeDigest(authority())});
  ledger.append('PREPARED',{manifestDigest:'a'.repeat(64)},'HOST_CONTROL');ledger.append('LAUNCH_CONSUMED',{launchId:'fixture'},'HOST_CONTROL');
  process.stdout.write(JSON.stringify({ready:true,lane:ledger.read().meta.lane})+'\n');setInterval(()=>{if(!ledger)process.exitCode=1;},1000);
} else {
  const ledger=CanaryLedger.open(directory,gate);try{const data=ledger.read();process.stdout.write(JSON.stringify({lane:data.meta.lane,consumed:data.projection.consumed,
    assurance:data.assurance,recovery:data.recovery,steps:data.projection.steps})+'\n');}finally{ledger.close();}
}
