import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical,copyJson,hash,id,integer,shape,stop } from './wf1-json.ts';
import type { CorpusExecution,CorpusExecutionLease,CorpusExecutionRequest } from './corpus-execution.ts';
import { cycleLeaseCapacity } from './teaching-cycle-store.ts';
import type { TeachingCycleStore } from './teaching-cycle-store.ts';
import { validateCycleOwner } from './teaching-cycle-types.ts';
import type { CycleOwner } from './teaching-cycle-types.ts';

export type LocalReclaimProof={version:'TeachingLocalReclaim/0.1';owner:CycleOwner;processExited:true;workersExited:true;resourcesReclaimed:true;observedAt:number};
/** Trusted host must compare process birth identity and every associated worker.
 * A heartbeat, elapsed TTL or kill request is not reclamation evidence. */
export type ConfirmLocalReclaim=(owner:CycleOwner)=>Promise<LocalReclaimProof>;
export class CorpusResourceScheduler {
  #store:TeachingCycleStore;#owner:CycleOwner;#check:()=>void;
  constructor(store:TeachingCycleStore,owner:CycleOwner,check:()=>void=()=>{}){this.#store=store;this.#owner=validateCycleOwner(owner);this.#check=check;}
  execution(childId:string,checkChild:()=>void):CorpusExecution{
    id(childId);const check=()=>{this.#check();this.#store.check();checkChild();};
    const authorize=<T>(action:()=>T)=>this.#store.authorizeSend(()=>{check();return action();});
    return {check,authorizeSend:authorize,authorizeCommit:authorize,acquire:async(input:CorpusExecutionRequest,signal?:AbortSignal)=>{
      const request=copyJson(input) as unknown as CorpusExecutionRequest;shape(request,['jobId','attemptId','provider','accountRef','requestBytes','responseBytes','expiresAt']);integer(request.expiresAt);let waited=false;
      while(true){
        check();signal?.throwIfAborted();const now=this.#store.now();if(now>=request.expiresAt)stop('TC_REQUEST_EXPIRED');const s=this.#store.snapshot()!;
        if(s.leases.some(l=>l.request.jobId===request.jobId&&l.request.attemptId===request.attemptId))stop('TC_ONCE');
        const cooldown=s.cooldowns.find(c=>c.provider===request.provider&&c.accountRef===request.accountRef);if(cooldown?.until===null)stop('TC_RETRY_AFTER_UNKNOWN');
        if((!cooldown||cooldown.until!<=now)&&cycleLeaseCapacity(s,request)){
          // The post-wait check is separate from the polling check. No await or
          // asynchronous callback may interleave this check and the lease commit.
          if(waited)check();const leaseId=randomUUID();this.#store.apply('LEASE',{id:leaseId,childId,request,owner:this.#owner,acquiredAt:now,local:'HELD',remote:'RESERVED'});let consumed=false,finished=false;
          const lease:CorpusExecutionLease={id:leaseId,check,consumed:()=>{if(finished||consumed)stop('TC_ONCE');this.#store.apply('CONSUMED',{id:leaseId});consumed=true;},settle:result=>{if(finished||!consumed)stop('TC_ONCE');this.#store.apply('SETTLED',{id:leaseId,...result,at:this.#store.now()});finished=true;},abandon:localReleased=>{if(finished)return;this.#store.apply('ABANDON',{id:leaseId,localReleased});finished=true;}};return lease;
        }
        waited=true;await delay(Math.min(25,request.expiresAt-now,Math.max(1,(cooldown?.until??now+25)-now)),undefined,{signal});
      }
    }};
  }
  async reclaim(leaseId:string,confirm:ConfirmLocalReclaim){
    if(this.#store.mode!=='resume')stop('TC_RECLAIM_MODE');this.#store.check();const lease=this.#store.snapshot()!.leases.find(l=>l.id===leaseId);if(!lease||lease.local!=='HELD'||canonical(lease.owner)===canonical(this.#owner))stop('TC_RECLAIM');
    const proof=shape(copyJson(await confirm(structuredClone(lease.owner))),['version','owner','processExited','workersExited','resourcesReclaimed','observedAt']);validateCycleOwner(proof.owner);if(proof.version!=='TeachingLocalReclaim/0.1'||canonical(proof.owner)!==canonical(lease.owner)||proof.processExited!==true||proof.workersExited!==true||proof.resourcesReclaimed!==true)stop('TC_RECLAIM_PROOF');integer(proof.observedAt,lease.acquiredAt,this.#store.now());this.#check();this.#store.check();this.#store.apply('LOCAL_RECLAIM',{id:lease.id,owner:lease.owner,proofDigest:hash(canonical(proof))});
  }
}
