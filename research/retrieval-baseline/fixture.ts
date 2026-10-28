import { MemoryStore } from '../../src/store.ts';
import type { Epoch, Proposal, SourceRef } from '../../src/contracts.ts';

export type SyntheticDocument = Readonly<{statement:string;root:number;validTo?:number}>;
export const syntheticIdentity={tenantId:'synthetic-bm25',subjectId:'subject',personaId:'research',relationshipId:'fixture'};
export const syntheticEvidence=(key:string)=>({speakerId:'subject',speakerRole:'subject' as const,
  mode:'self_report' as const,selectedText:`SYNTHETIC root ${key}`,occurredAt:null});

export function publishSynthetic(store:MemoryStore,scope:Epoch,refs:SourceRef[],statement:string,validTo:number|null=null):SourceRef {
  const job=store.beginJob(scope,refs),lease=store.claimLease(scope,job.id);
  const proposal:Proposal={kind:'claim',statement,basis:'self_report',validFrom:null,validTo};
  store.propose(scope,job.id,lease.token,proposal);
  return {id:store.publish(scope,job.id,lease.token).id,revision:1};
}

/** Actual schema2 public APIs, new RAM Store only; no disk, private data or model. */
export function createSyntheticFixture(documents:readonly SyntheticDocument[],learningConsent=false) {
  let wall=100_000;
  const store=new MemoryStore(':memory:',{schemaVersion:2,clock:{wall:()=>wall,monotonic:()=>0}});
  try {
    let scope=store.ensureScope(syntheticIdentity);
    if(learningConsent)scope=store.setLearningConsent(scope,true);
    const roots=new Map<number,SourceRef>();
    const refs=documents.map(document=>{
      let root=roots.get(document.root);
      if(!root){root=store.acceptEvent(scope,{source:'synthetic',eventKey:String(document.root),
        evidence:syntheticEvidence(String(document.root))});roots.set(document.root,root);}
      return publishSynthetic(store,scope,[root],document.statement,document.validTo??null);
    });
    const handle=store.registerConsumer('synthetic-research',scope,'retrieval-refs-v1');
    return {store,scope,roots,refs,handle,setWall:(value:number)=>{wall=value;},close:()=>store.close()};
  } catch(error){store.close();throw error;}
}
export type SyntheticFixture = ReturnType<typeof createSyntheticFixture>;
