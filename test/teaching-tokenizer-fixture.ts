import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { canonical,hash } from '../src/wf1-json.ts';
/** Exercises the real measurement/export code with explicit synthetic process
 * receipts. It is not evidence that the official tokenizer executed. */
export function installSyntheticTokenizer(onCall:()=>void=()=>{}){
  const original=childProcess.spawnSync;
  childProcess.spawnSync=((file:any,args:any,options:any)=>{
    if(Array.isArray(args)&&args[0]==='-I'&&args[1]==='-B'&&args[2]==='-c'&&String(args[3]).includes('CorpusProductionTokenizerBatchResult/0.1')){
      onCall();const request=JSON.parse(options.input),measurements=request.items.map((p:any)=>({version:'CorpusTokenMeasurement/0.1',status:'LOCAL_PINNED_EXACT',rowDigest:p.rowDigest,tokenizerProfileDigest:request.tokenizerProfileDigest,studentInputTokens:'3',studentLossTokens:'5',fullTokens:'8',inputIdsDigest:hash('SYNTHETIC input'),fullIdsDigest:hash('SYNTHETIC full'),lossMaskDigest:hash('SYNTHETIC mask'),lossPolicy:'ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR',officialPipelineParity:'NOT_VALIDATED',actualTrainerParity:'NOT_RUN',trainingReady:false}));return {status:0,signal:null,pid:0,stdout:Buffer.from(canonical({version:'CorpusProductionTokenizerBatchResult/0.1',tokenizerProfileDigest:request.tokenizerProfileDigest,measurements})),stderr:Buffer.alloc(0),output:[]};
    }return (original as any)(file,args,options);
  }) as typeof childProcess.spawnSync;syncBuiltinESMExports();return ()=>{childProcess.spawnSync=original;syncBuiltinESMExports();};
}
