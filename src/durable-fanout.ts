import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Epoch } from './contracts.ts';
import { FANOUT_LIMITS as L, FANOUT_PROFILES } from './fanout-types.ts';
import type { ConsumerHandle, ConsumerProjection, ConsumerStatus, FanoutFault, FanoutProfile, JournalBatch, JournalItem, MetadataRef } from './fanout-types.ts';
import { fail, object, text } from './validation.ts';

type Row = Record<string, string | number | null>;
type Context = { txId: string; phase: string; asOf: number };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const nullableTime = (value: unknown) => value === null || safe(value);
const profile = (value: unknown): value is FanoutProfile => FANOUT_PROFILES.includes(value as FanoutProfile);
const values = (args: Array<SQLInputValue | undefined>): SQLInputValue[] => args.map(value => { if (value === undefined) fail('FANOUT_CORRUPT'); return value; });
const all = (db: DatabaseSync, sql: string, ...args: Array<SQLInputValue | undefined>) => db.prepare(sql).all(...values(args)) as Row[];
const one = (db: DatabaseSync, sql: string, ...args: Array<SQLInputValue | undefined>) => db.prepare(sql).get(...values(args)) as Row | undefined;
const items = (db: DatabaseSync, seq: number): JournalItem[] => all(db,
  'SELECT scope_id,kind,entity_id,related_id,operation FROM fanout_items WHERE batch_seq=? ORDER BY id',seq)
  .map(r=>({scopeId:r.scope_id as string,kind:r.kind as string,entityId:r.entity_id as string,relatedId:r.related_id as string|null,operation:r.operation as string}));
const digest = (batch: Row, content: JournalItem[]) => hash({ sequence: batch.seq, phase: batch.phase, asOf: batch.as_of,
  revocationHighWater: batch.revocation_high_water, items: content });
const jsonObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fields=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128&&!value.includes('\0');
function validRefs(value:unknown):boolean{
  return Array.isArray(value)&&value.length<=L.scopeNodes&&new Set(value.map(v=>jsonObject(v)?v.id:undefined)).size===value.length
    &&value.every(ref=>jsonObject(ref)&&fields(ref,['id','revision'])&&validId(ref.id)&&safe(ref.revision)&&ref.revision>0);
}
function validMetadata(value:unknown,kind:FanoutProfile):value is MetadataRef{
  if(!jsonObject(value)||!['event','memory'].includes(value.type as string)||(kind==='retrieval-refs-v1'&&value.type!=='memory')
    ||!fields(value,['id','revision','type','generation','consentRevision','recordedAt','validFrom','validTo','parents','rootEventRefs',...(value.type==='event'?['origin']:[])])
    ||!validId(value.id)||!safe(value.revision)||value.revision<1||!safe(value.generation)||!safe(value.consentRevision)||!safe(value.recordedAt)
    ||!nullableTime(value.validFrom)||!nullableTime(value.validTo)||!validRefs(value.parents)||!validRefs(value.rootEventRefs))return false;
  if(value.type==='event'){
    const origin=value.origin;
    if(!jsonObject(origin)||!fields(origin,['mode','speakerRole','occurredAt'])||!['self_report','observation','quotation','inference'].includes(origin.mode as string)
      ||!['subject','assistant','third_party','sensor'].includes(origin.speakerRole as string)||!nullableTime(origin.occurredAt))return false;
  }
  return true;
}

/** Validation is read-only and never creates a boot batch or changes leases. */
export function validateFanoutImage(db: DatabaseSync): void {
  const state=one(db,'SELECT * FROM fanout_state WHERE singleton=1');
  if(!state || all(db,'SELECT * FROM fanout_state').length!==1 || !safe(state.head_seq) || !safe(state.floor_seq)
    || state.floor_seq>state.head_seq || !safe(state.last_wall) || !nullableTime(state.next_due)) fail('FANOUT_CORRUPT');
  const batches=all(db,'SELECT * FROM fanout_batches ORDER BY seq');
  const highWater=one(db,'SELECT coalesce(max(id),0) AS n FROM revocations')!.n as number;
  if(batches.length>L.batches || (one(db,'SELECT count(*) AS n FROM fanout_items')!.n as number)>L.totalItems)fail('FANOUT_LIMIT');
  let previous=state.floor_seq;
  for(const batch of batches){
    if(!safe(batch.seq)||batch.seq<=previous||batch.seq>state.head_seq||batch.complete!==1||!safe(batch.as_of)
      ||batch.as_of>state.last_wall||!safe(batch.revocation_high_water)||batch.revocation_high_water>highWater
      ||!['source','boot','sweep'].includes(batch.phase as string))fail('FANOUT_CORRUPT');
    const content=items(db,batch.seq);
    if(!content.length||content.length>L.batchItems||batch.item_count!==content.length||batch.digest!==digest(batch,content))fail('FANOUT_CORRUPT');
    previous=batch.seq;
  }
  if(previous!==state.head_seq)fail('FANOUT_CORRUPT');
  const sequence=one(db,"SELECT seq FROM sqlite_sequence WHERE name='fanout_batches'")?.seq ?? 0;
  if(!safe(sequence)||sequence<state.head_seq||sequence<state.floor_seq)fail('FANOUT_CORRUPT');
  const consumers=all(db,'SELECT * FROM fanout_consumers');
  if(consumers.length>L.consumers||(one(db,'SELECT count(*) AS n FROM scopes')!.n as number)>L.scopes)fail('FANOUT_LIMIT');
  const positions=new Set([state.floor_seq,...batches.map(batch=>batch.seq)]);
  for(const c of consumers){
    if(!profile(c.profile)||!safe(c.generation)||c.generation<1||!safe(c.applied_seq)||c.applied_seq<state.floor_seq||c.applied_seq>state.head_seq
      ||!positions.has(c.applied_seq)||!safe(c.baseline_seq)||c.baseline_seq>c.applied_seq||!safe(c.as_of)||c.as_of>state.last_wall
      ||!nullableTime(c.next_due)||(c.next_due!==null&&(c.next_due as number)<=c.as_of))fail('FANOUT_CORRUPT');
    let authority:unknown;try{authority=JSON.parse(c.authority as string);}catch{fail('FANOUT_CORRUPT');}
    const scope=one(db,'SELECT * FROM scopes WHERE id=?',c.scope_id);
    if(!jsonObject(authority)||!fields(authority,['id','generation','consentRevision','runtimeEpoch'])||authority.id!==c.scope_id||!scope
      ||!safe(authority.generation)||authority.generation>(scope.generation as number)||!safe(authority.consentRevision)||authority.consentRevision>(scope.consent_revision as number)
      ||!safe(authority.runtimeEpoch)||authority.runtimeEpoch>(scope.runtime_epoch as number))fail('FANOUT_CORRUPT');
    const projection=all(db,'SELECT node_id,revision,metadata FROM fanout_projection WHERE consumer_id=?',c.id);
    if(projection.length>L.scopeNodes||(c.status!=='active'&&projection.length!==0))fail('FANOUT_CORRUPT');
    const decoded:MetadataRef[]=[];
    for(const p of projection){try{const value:unknown=JSON.parse(p.metadata as string);
      if(!validMetadata(value,c.profile)||value.id!==p.node_id||value.revision!==p.revision)fail('FANOUT_CORRUPT');decoded.push(value);}catch{fail('FANOUT_CORRUPT');}}
    if(Buffer.byteLength(JSON.stringify(decoded))>L.projectionBytes)fail('FANOUT_LIMIT');
  }
}

/** Internal controller: callers get only MemoryStore's guarded wrappers, never a
 * SQLite handle or an arbitrary callback/ACK/offset mutation. */
export class DurableFanout {
  #db: DatabaseSync;
  #wall: () => number;
  #bootId = randomUUID();
  #context: Context | undefined;
  #observed = 0;
  #fault: ((point: FanoutFault) => void) | undefined;
  constructor(db: DatabaseSync, wall: () => number, fault?: (point: FanoutFault) => void) {
    this.#db=db;this.#wall=wall;this.#fault=fault;
    db.function('fanout_tx',()=>this.#context?.txId ?? null);
    db.function('fanout_phase',()=>this.#context?.phase ?? 'none');
    db.function('fanout_asof',()=>this.#context?.asOf ?? null);
  }
  #one(sql:string,...args:Array<SQLInputValue|undefined>):Row|undefined{return one(this.#db,sql,...args);}
  #all(sql:string,...args:Array<SQLInputValue|undefined>):Row[]{return all(this.#db,sql,...args);}
  #run(sql:string,...args:Array<SQLInputValue|undefined>):void{this.#db.prepare(sql).run(...values(args));}
  #state():Row{return this.#one('SELECT * FROM fanout_state WHERE singleton=1')!;}
  checkWall():number{
    const now=this.#wall(), floor=this.#state().last_wall as number;
    if(!safe(now)||now<Math.max(floor,this.#observed))fail('FANOUT_CLOCK_ROLLBACK');
    this.#observed=now;return now;
  }
  begin(phase:'source'|'boot'='source',frozenAsOf?:number):void{
    if(this.#context)fail('FANOUT_TRANSACTION');
    if(frozenAsOf!==undefined&&frozenAsOf!==this.#observed)fail('FANOUT_TRANSACTION');
    this.#context={txId:randomUUID(),phase,asOf:frozenAsOf??this.checkWall()};
  }
  time():number{return this.#ctx().asOf;}
  end():void{this.#context=undefined;}
  #ctx():Context{if(!this.#context)fail('FANOUT_TRANSACTION');return this.#context;}
  #nextDue():number|null{
    const now=this.#ctx().asOf;
    return this.#one(`SELECT min(t) AS n FROM (SELECT valid_from AS t FROM nodes WHERE status='active' AND valid_from>?
      UNION ALL SELECT valid_to AS t FROM nodes WHERE status='active' AND valid_to>?)`,now,now)!.n as number|null;
  }
  finalizeJournal():void{
    const context=this.#ctx(),batch=this.#one('SELECT * FROM fanout_batches WHERE tx_id=?',context.txId);
    if(!batch||batch.complete===1)return;
    this.#fault?.('before-journal-finalize');
    const content=items(this.#db,batch.seq as number);
    if(content.length>L.batchItems || (this.#one('SELECT count(*) AS n FROM fanout_batches')!.n as number)>L.batches
      ||(this.#one('SELECT count(*) AS n FROM fanout_items')!.n as number)>L.totalItems
      ||(this.#one('SELECT count(*) AS n FROM scopes')!.n as number)>L.scopes)fail('FANOUT_LIMIT');
    batch.revocation_high_water=this.#one('SELECT coalesce(max(id),0) AS n FROM revocations')!.n as number;
    this.#run('UPDATE fanout_batches SET revocation_high_water=?,item_count=?,digest=?,complete=1 WHERE seq=?',batch.revocation_high_water,content.length,digest(batch,content),batch.seq);
    this.#run('UPDATE fanout_state SET head_seq=?,last_wall=?,next_due=? WHERE singleton=1',batch.seq,context.asOf,this.#nextDue());
  }
  finish(changed:boolean):void{
    this.finalizeJournal();
    if(changed)this.#run('UPDATE fanout_state SET last_wall=? WHERE singleton=1 AND last_wall<?',this.#ctx().asOf,this.#ctx().asOf);
  }
  #scope(epoch:Epoch):Row{
    object(epoch);text(epoch.id,128);
    const scope=this.#one('SELECT * FROM scopes WHERE id=?',epoch.id);if(!scope)fail('SCOPE_NOT_FOUND');
    if(scope.generation!==epoch.generation)fail('STALE_SCOPE');if(scope.consent_revision!==epoch.consentRevision)fail('STALE_CONSENT');return scope;
  }
  #authority(scope:Row):string{return JSON.stringify({id:scope.id,generation:scope.generation,consentRevision:scope.consent_revision,runtimeEpoch:scope.runtime_epoch});}
  #collect(scope:Row):{refs:MetadataRef[];visible:Set<string>;nextDue:number|null}{
    const asOf=this.#ctx().asOf;
    const rows=this.#all(`SELECT id,scope_id,type,revision,generation,consent_revision,status,created_at,valid_from,valid_to,
      json_extract(body,'$.mode') AS mode,json_extract(body,'$.speakerRole') AS speaker_role,json_extract(body,'$.occurredAt') AS occurred_at
      FROM nodes WHERE scope_id=? AND generation=? ORDER BY id LIMIT ?`,scope.id,scope.generation,L.scopeNodes+1);
    const edges=this.#all(`SELECT d.child_id,d.parent_id,d.parent_revision FROM dependencies d JOIN nodes n ON n.id=d.child_id
      WHERE n.scope_id=? AND n.generation=? ORDER BY d.child_id,d.parent_id LIMIT ?`,scope.id,scope.generation,L.scopeEdges+1);
    if(rows.length>L.scopeNodes||edges.length>L.scopeEdges)fail('FANOUT_BASELINE_LIMIT');
    const nodes=new Map(rows.map(row=>[row.id as string,row])),parents=new Map<string,Array<{id:string;revision:number}>>();
    for(const edge of edges){const list=parents.get(edge.child_id as string)??[];list.push({id:edge.parent_id as string,revision:edge.parent_revision as number});parents.set(edge.child_id as string,list);}
    const valid=new Map<string,boolean>(),visiting=new Set<string>(),roots=new Map<string,Array<{id:string;revision:number}>>();
    const walk=(nodeId:string):boolean=>{
      if(valid.has(nodeId))return valid.get(nodeId)!;
      if(visiting.has(nodeId))fail('FANOUT_SOURCE_CYCLE');
      const node=nodes.get(nodeId);if(!node)return false;
      visiting.add(nodeId);
      let ok=node.status==='active'&&node.generation===scope.generation&&(node.valid_from===null||(node.valid_from as number)<=asOf)
        &&(node.valid_to===null||(node.valid_to as number)>asOf);
      const root=new Map<string,{id:string;revision:number}>();
      if(node.type==='event')root.set(nodeId,{id:nodeId,revision:node.revision as number});
      for(const ref of parents.get(nodeId)??[]){
        if(!walk(ref.id)||nodes.get(ref.id)?.revision!==ref.revision)ok=false;
        for(const r of roots.get(ref.id)??[])root.set(r.id,r);
      }
      roots.set(nodeId,[...root.values()].sort((a,b)=>a.id.localeCompare(b.id)));visiting.delete(nodeId);valid.set(nodeId,ok);return ok;
    };
    for(const row of rows)walk(row.id as string);
    const visible=new Set(rows.filter(row=>row.type==='memory'&&valid.get(row.id as string)).map(row=>row.id as string));
    const selected=new Set<string>();const add=(nodeId:string):void=>{if(selected.has(nodeId))return;selected.add(nodeId);for(const p of parents.get(nodeId)??[])add(p.id);};
    for(const nodeId of visible)add(nodeId);
    const refs:MetadataRef[]=[...selected].sort().map(nodeId=>{
      const row=nodes.get(nodeId)!;
      return {id:nodeId,revision:row.revision as number,type:row.type as 'event'|'memory',generation:row.generation as number,
        consentRevision:row.consent_revision as number,recordedAt:row.created_at as number,validFrom:row.valid_from as number|null,validTo:row.valid_to as number|null,
        parents:parents.get(nodeId)??[],rootEventRefs:roots.get(nodeId)??[],
        ...(row.type==='event'?{origin:{mode:row.mode as string,speakerRole:row.speaker_role as string,occurredAt:row.occurred_at as number|null}}:{})};
    });
    if(Buffer.byteLength(JSON.stringify(refs))>L.projectionBytes)fail('FANOUT_BASELINE_LIMIT');
    const times=rows.filter(r=>r.status==='active').flatMap(r=>[r.valid_from,r.valid_to]).filter(t=>typeof t==='number'&&t>asOf) as number[];
    return {refs,visible,nextDue:times.length?Math.min(...times):null};
  }
  sweep():{changed:boolean;head:number}{
    const context=this.#ctx(),state=this.#state();
    if(state.next_due===null||(state.next_due as number)>context.asOf)return{changed:false,head:state.head_seq as number};
    const scopes=this.#all('SELECT * FROM scopes ORDER BY id LIMIT ?',L.scopes+1);if(scopes.length>L.scopes)fail('FANOUT_BASELINE_LIMIT');
    const priorPhase=context.phase;context.phase='sweep';
    let changed=false;
    try{
      for(const scope of scopes){
        const collected=this.#collect(scope);
        for(const row of this.#all("SELECT id,projection_visible FROM nodes WHERE scope_id=? AND type='memory'",scope.id)){
          const visible=Number(collected.visible.has(row.id as string));
          if(visible!==row.projection_visible){this.#run('UPDATE nodes SET projection_visible=? WHERE id=?',visible,row.id);changed=true;}
        }
      }
      // Even a time boundary with no projected memory changes advances a durable
      // barrier. Consumers must prove freshness across this complete TTL batch.
      if(!changed){
        this.#run('INSERT INTO fanout_batches(tx_id,phase,as_of) VALUES (?,?,?)',context.txId,'sweep',context.asOf);
        this.#run("INSERT INTO fanout_items(batch_seq,scope_id,kind,entity_id,related_id,operation) SELECT seq,'*','ttl','*',NULL,'sweep' FROM fanout_batches WHERE tx_id=?",context.txId);
      }
      this.finalizeJournal();return{changed:true,head:this.#state().head_seq as number};
    }finally{context.phase=priorPhase;}
  }
  #current():void{this.sweep();this.finalizeJournal();}
  #consumer(id:string):Row{text(id,128);const row=this.#one('SELECT * FROM fanout_consumers WHERE id=?',id);if(!row)fail('FANOUT_CONSUMER_NOT_FOUND');return row;}
  #stamp(scope:Row):ConsumerHandle['authority']{return{generation:scope.generation as number,consentRevision:scope.consent_revision as number,runtimeEpoch:scope.runtime_epoch as number};}
  #handle(c:Row):ConsumerHandle{const scope=this.#one('SELECT * FROM scopes WHERE id=?',c.scope_id)!;return{id:c.id as string,generation:c.generation as number,
    profile:c.profile as FanoutProfile,scopeId:c.scope_id as string,bootId:this.#bootId,authority:this.#stamp(scope)};}
  #check(handle:ConsumerHandle,active=true):Row{
    object(handle);const c=this.#consumer(handle.id);
    if(handle.bootId!==this.#bootId||handle.generation!==c.generation||handle.scopeId!==c.scope_id||handle.profile!==c.profile)fail('FANOUT_STALE_HANDLE');
    const scope=this.#one('SELECT * FROM scopes WHERE id=?',c.scope_id);
    if(!scope||JSON.stringify(handle.authority)!==JSON.stringify(this.#stamp(scope)))fail('FANOUT_STALE_HANDLE');
    if(active&&c.status!=='active')fail('FANOUT_CONSUMER_INACTIVE');return c;
  }
  #baseline(c:Row,scope:Row,generation:number):ConsumerHandle{
    const snapshot=this.#collect(scope),head=this.#state().head_seq as number;
    const refs=c.profile==='retrieval-refs-v1'?snapshot.refs.filter(ref=>ref.type==='memory'):snapshot.refs;
    this.#run('DELETE FROM fanout_projection WHERE consumer_id=?',c.id);
    for(const ref of refs)this.#run('INSERT INTO fanout_projection VALUES (?,?,?,?)',c.id,ref.id,ref.revision,JSON.stringify(ref));
    this.#fault?.('after-projection-write');this.#fault?.('before-consumer-checkpoint');
    this.#run("UPDATE fanout_consumers SET generation=?,status='active',applied_seq=?,baseline_seq=?,authority=?,as_of=?,next_due=? WHERE id=?",
      generation,head,head,this.#authority(scope),this.#ctx().asOf,snapshot.nextDue,c.id);
    return this.#handle(this.#consumer(c.id as string));
  }
  register(id:string,epoch:Epoch,kind:FanoutProfile,required=false):ConsumerHandle{
    text(id,128);if(!profile(kind)||typeof required!=='boolean')fail('FANOUT_PROFILE');this.#current();const scope=this.#scope(epoch);
    if(this.#one('SELECT id FROM fanout_consumers WHERE id=?',id))fail('FANOUT_CONSUMER_EXISTS');
    if((this.#one('SELECT count(*) AS n FROM fanout_consumers')!.n as number)>=L.consumers)fail('FANOUT_LIMIT');
    const head=this.#state().head_seq;
    this.#run("INSERT INTO fanout_consumers VALUES (?,?,?,?,1,'reset_required',?,?,?, ?,NULL)",id,scope.id,kind,Number(required),head,head,this.#authority(scope),this.#ctx().asOf);
    return this.#baseline(this.#consumer(id),scope,1);
  }
  bind(id:string,epoch:Epoch):ConsumerHandle{
    this.#current();const scope=this.#scope(epoch),c=this.#consumer(id);if(c.scope_id!==scope.id)fail('FANOUT_SCOPE');return this.#handle(c);
  }
  apply(handles:ConsumerHandle[]):ConsumerStatus[]{
    if(!Array.isArray(handles)||!handles.length||handles.length>L.consumers||new Set(handles.map(h=>h.id)).size!==handles.length)fail('FANOUT_INPUT');
    this.#current();const state=this.#state(),head=state.head_seq as number;
    for(const handle of handles){
      const c=this.#check(handle);if((c.applied_seq as number)<(state.floor_seq as number))fail('FANOUT_RESET_REQUIRED');
      if(c.applied_seq===head)continue;
      const pending=this.#all('SELECT seq,complete FROM fanout_batches WHERE seq>? ORDER BY seq',c.applied_seq);
      if(!pending.length||pending.at(-1)!.seq!==head||pending.some(b=>b.complete!==1))fail('FANOUT_PREFIX');
      const scope=this.#one('SELECT * FROM scopes WHERE id=?',c.scope_id);if(!scope)fail('SCOPE_NOT_FOUND');
      const snapshot=this.#collect(scope),refs=c.profile==='retrieval-refs-v1'?snapshot.refs.filter(ref=>ref.type==='memory'):snapshot.refs;
      this.#run('DELETE FROM fanout_projection WHERE consumer_id=?',c.id);
      for(const ref of refs)this.#run('INSERT INTO fanout_projection VALUES (?,?,?,?)',c.id,ref.id,ref.revision,JSON.stringify(ref));
      this.#fault?.('after-projection-write');this.#fault?.('before-consumer-checkpoint');
      this.#run('UPDATE fanout_consumers SET applied_seq=?,authority=?,as_of=?,next_due=? WHERE id=?',head,this.#authority(scope),this.#ctx().asOf,snapshot.nextDue,c.id);
    }
    return handles.map(handle=>this.#status(this.#consumer(handle.id)));
  }
  read(handle:ConsumerHandle):ConsumerProjection{
    const c=this.#check(handle),state=this.#state();
    if(c.applied_seq!==state.head_seq)fail('FANOUT_STALE_PROJECTION');
    const scope=this.#one('SELECT * FROM scopes WHERE id=?',c.scope_id);
    if(!scope||c.authority!==this.#authority(scope)||(c.next_due!==null&&(c.next_due as number)<=this.#ctx().asOf))fail('FANOUT_STALE_PROJECTION');
    return{version:1,profile:c.profile as FanoutProfile,scopeId:c.scope_id as string,generation:c.generation as number,
      applied:c.applied_seq as number,asOf:c.as_of as number,refs:this.#all('SELECT metadata FROM fanout_projection WHERE consumer_id=? ORDER BY node_id',c.id).map(r=>JSON.parse(r.metadata as string) as MetadataRef)};
  }
  pause(handle:ConsumerHandle):void{
    const c=this.#check(handle);this.#run('DELETE FROM fanout_projection WHERE consumer_id=?',c.id);
    this.#run("UPDATE fanout_consumers SET generation=generation+1,status='paused' WHERE id=?",c.id);
  }
  reset(id:string,epoch:Epoch):ConsumerHandle{
    this.#current();const scope=this.#scope(epoch),c=this.#consumer(id);if(c.scope_id!==scope.id)fail('FANOUT_SCOPE');
    return this.#baseline(c,scope,(c.generation as number)+1);
  }
  #status(c:Row):ConsumerStatus{const s=this.#state();return{id:c.id as string,scopeId:c.scope_id as string,profile:c.profile as FanoutProfile,
    generation:c.generation as number,required:c.required===1,status:c.status as ConsumerStatus['status'],applied:c.applied_seq as number,
    baseline:c.baseline_seq as number,head:s.head_seq as number,floor:s.floor_seq as number};}
  status(id:string):ConsumerStatus{return this.#status(this.#consumer(id));}
  journal():JournalBatch[]{return this.#all('SELECT * FROM fanout_batches WHERE complete=1 ORDER BY seq').map(b=>({sequence:b.seq as number,phase:b.phase as string,
    asOf:b.as_of as number,revocationHighWater:b.revocation_high_water as number,digest:b.digest as string,items:items(this.#db,b.seq as number)}));}
  prune(retainBatches:number,resetRequiredIds:string[]=[]):{floor:number;removed:number;resetConsumers:string[]}{
    if(!safe(retainBatches)||retainBatches>L.batches)fail('FANOUT_INPUT');
    if(!Array.isArray(resetRequiredIds)||resetRequiredIds.length>L.consumers||new Set(resetRequiredIds).size!==resetRequiredIds.length)fail('FANOUT_RESET_SELECTION');
    for(const id of resetRequiredIds)text(id,128);
    const batches=this.#all('SELECT seq FROM fanout_batches ORDER BY seq'),remove=batches.slice(0,Math.max(0,batches.length-retainBatches));
    if(!remove.length){if(resetRequiredIds.length)fail('FANOUT_RESET_SELECTION');return{floor:this.#state().floor_seq as number,removed:0,resetConsumers:[]};}
    const floor=remove.at(-1)!.seq as number,affected=this.#all('SELECT * FROM fanout_consumers WHERE applied_seq<? ORDER BY id',floor);
    if(resetRequiredIds.some(id=>!affected.some(c=>c.id===id)))fail('FANOUT_RESET_SELECTION');
    if(affected.some(c=>c.required===1&&!resetRequiredIds.includes(c.id as string)))fail('FANOUT_RETENTION_BLOCKED');
    for(const c of affected){
      this.#run('DELETE FROM fanout_projection WHERE consumer_id=?',c.id);
      this.#run("UPDATE fanout_consumers SET generation=generation+1,status='reset_required',applied_seq=?,baseline_seq=? WHERE id=?",floor,floor,c.id);
    }
    const context=this.#ctx(),phase=context.phase;context.phase='prune';
    try{this.#run('DELETE FROM fanout_batches WHERE seq<=?',floor);this.#run('UPDATE fanout_state SET floor_seq=? WHERE singleton=1',floor);}finally{context.phase=phase;}
    return{floor,removed:remove.length,resetConsumers:affected.map(c=>c.id as string)};
  }
}
