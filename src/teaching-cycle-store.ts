import { closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readdirSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical,copyJson,digest,hash,id,integer,oneOf,parseJson,shape,stop } from './wf1-json.ts';
import { createArtifactBroker,HostAuthority } from './wf1-storage.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import { artifactRef } from './wf1-contract.ts';
import type { ScopedRef } from './corpus-production-types.ts';
import { cycleActiveChildren,validateCurriculumPlan,validateCycleOwner,validateCycleSpec } from './teaching-cycle-types.ts';
import type { ChildStage,CurriculumPlan,CycleEvent,ResourceLease,TeachingCycleSpec,TeachingCycleState } from './teaching-cycle-types.ts';
import { requireRealPlanAdmission } from './teaching-cycle-admission.ts';
import type { RealPlanAdmission } from './teaching-cycle-admission.ts';

export type TeachingCycleStoreOptions={approvedTrainingRoot:string;runtimeRoot:string;authorityPath:string;spec:TeachingCycleSpec;key:Uint8Array;mode:'create'|'resume'|'inspect';admission:()=>{planDigest:string;sourceAllowed:boolean;retainAllowed:boolean};realPlanAdmission?:RealPlanAdmission;now?:()=>number};
const SCHEMA=['CREATE TABLE events(sequence INTEGER PRIMARY KEY, previous TEXT NOT NULL, ref TEXT NOT NULL, digest TEXT NOT NULL)','CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)'];
const same=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))stop('TC_BINDING');};
function scoped(input:ScopedRef){shape(input,['bucket','ref']);if(!/^(meta|event-\d+|index-\d+)$/.test(input.bucket))stop('TC_BUCKET');artifactRef(input.ref);if(input.ref.partition!=='train')stop('TC_REF');return input;}
function plain(path:string,max:number){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)stop('TC_FILE');return s;}
function emptyFile(path:string){const fd=openSync(path,'wx',0o600);try{fsyncSync(fd);}finally{closeSync(fd);}}
export function cycleLeaseCapacity(s:TeachingCycleState,request:ResourceLease['request']){
  const r=s.spec.resources,a=r.accounts.find(a=>a.provider===request.provider&&a.accountRef===request.accountRef);if(!a)stop('TC_ACCOUNT');
  const local=s.leases.filter(l=>l.local==='HELD'),account=s.leases.filter(l=>l.request.provider===request.provider&&l.request.accountRef===request.accountRef),bytes=integer(request.requestBytes+request.responseBytes);
  if(bytes>r.bufferBytes)stop('TC_RESOURCE_REQUEST');return local.length<r.localSlots&&account.filter(l=>l.local==='HELD').length<a.localSlots&&integer(local.reduce((n,l)=>n+l.request.requestBytes+l.request.responseBytes,bytes))<=r.bufferBytes;
}
function reduce(current:TeachingCycleState|null,event:CycleEvent,spec:TeachingCycleSpec):TeachingCycleState{
  const real=spec.version==='TeachingCycle/0.2';shape(event,['version','kind','data',...(real?['at']:[])]);if(event.version!==(real?'TeachingCycleEvent/0.2':'TeachingCycleEvent/0.1'))stop('TC_EVENT');const d=event.data as Record<string,unknown>;
  if(real)integer(event.at,current?.timing?.lastObservedAt??spec.createdAt,spec.expiresAt-1);
  if(event.kind==='INIT'){if(current)stop('TC_EXISTS');shape(d,['spec','plan']);same(d.spec,spec);const plan=validateCurriculumPlan(d.plan,spec);return {version:real?'TeachingCycleState/0.2':'TeachingCycleState/0.1',spec,plan,status:'ACTIVE',microRound:0,children:plan.children.map(c=>({...c,stage:'PENDING',selectionRef:null,auditSpecDigest:null,indexRef:null,descriptorRef:null,indexDigest:null,code:null,...(real?{productionAccountingRef:null,qaAccountingRef:null}:{})})),leases:[],cooldowns:[],barriers:[],...(real?{timing:{startedAt:null,completedAt:null,lastObservedAt:event.at!}}:{})};}
  if(!current||current.status!=='ACTIVE')stop('TC_STATE');const s=structuredClone(current);
  if(real)s.timing!.lastObservedAt=event.at!;
  if(event.kind==='START'){
    shape(d,[]);if(!real||s.timing!.startedAt!==null||s.children.some(c=>c.stage!=='PENDING'))stop('TC_START');s.timing!.startedAt=event.at!;
  }else if(event.kind==='STAGE'){
    shape(d,['childId','expected','stage','selectionRef','auditSpecDigest','indexRef','descriptorRef','indexDigest','code',...(real?['productionAccountingRef','qaAccountingRef']:[])]);const child=s.children.find(c=>c.childId===d.childId);if(!child||child.stage!==d.expected||child.microRound!==s.microRound||real&&s.timing!.startedAt===null)stop('TC_STAGE');
    const next=oneOf(d.stage,['PRODUCTION','TOKENS','QA','INDEX','COMPLETE','FAILED']),order:ChildStage[]=['PENDING','PRODUCTION','TOKENS','QA','INDEX','COMPLETE'];if(next!=='FAILED'&&order.indexOf(next)!==order.indexOf(child.stage)+1||['COMPLETE','FAILED'].includes(child.stage))stop('TC_STAGE');
    if(child.stage==='PENDING'&&cycleActiveChildren(s).length>=spec.resources.activeChildren)stop('TC_ACTIVE_CHILDREN');
    for(const key of ['selectionRef','indexRef','descriptorRef'] as const){if(d[key]!==null)scoped(d[key] as ScopedRef);if(child[key]!==null)same(d[key],child[key]);}
    if(real){for(const key of ['productionAccountingRef','qaAccountingRef'] as const){if(d[key]!==null)scoped(d[key] as ScopedRef);if(child[key]!==null)same(d[key],child[key]);}if(['QA','INDEX','COMPLETE'].includes(next)&&d.productionAccountingRef===null||next==='COMPLETE'&&d.qaAccountingRef===null)stop('TC_ACCOUNTING');}
    for(const key of ['auditSpecDigest','indexDigest'] as const){if(d[key]!==null)digest(d[key]);if(child[key]!==null)same(d[key],child[key]);}
    if(['QA','INDEX','COMPLETE'].includes(next)&&d.selectionRef===null||next==='INDEX'&&d.auditSpecDigest===null||next==='COMPLETE'&&(!d.indexRef||!d.descriptorRef||!d.indexDigest))stop('TC_STAGE');
    if(next==='FAILED')id(d.code);else if(d.code!==null)stop('TC_STAGE');Object.assign(child,d,{stage:next});delete (child as unknown as Record<string,unknown>).expected;
  }else if(event.kind==='BIND_AUDIT'){
    shape(d,['childId','specDigest']);digest(d.specDigest);const child=s.children.find(c=>c.childId===d.childId);if(!child||child.stage!=='QA'||child.auditSpecDigest!==null)stop('TC_AUDIT_BINDING');child.auditSpecDigest=String(d.specDigest);
  }else if(event.kind==='LEASE'){
    const lease=copyJson(d) as unknown as ResourceLease;shape(lease,['id','childId','request','owner','acquiredAt','local','remote']);id(lease.id);id(lease.childId);validateCycleOwner(lease.owner);integer(lease.acquiredAt,spec.createdAt,spec.expiresAt-1);const r=shape(lease.request,['jobId','attemptId','provider','accountRef','requestBytes','responseBytes','expiresAt']);id(r.jobId);id(r.attemptId);oneOf(r.provider,['deepseek','together']);id(r.accountRef);integer(r.requestBytes,1);integer(r.responseBytes,1);integer(r.expiresAt,lease.acquiredAt+1);
    const child=s.children.find(c=>c.childId===lease.childId);if(!child||!['PRODUCTION','QA'].includes(child.stage)||child.microRound!==s.microRound||lease.local!=='HELD'||lease.remote!=='RESERVED'||s.leases.some(l=>l.id===lease.id||l.request.jobId===r.jobId&&l.request.attemptId===r.attemptId)||!cycleLeaseCapacity(s,lease.request))stop('TC_LEASE');
    const priorOwner=s.leases.find(l=>l.owner.epoch===lease.owner.epoch);if(priorOwner)same(priorOwner.owner,lease.owner);const cooldown=s.cooldowns.find(c=>c.provider===r.provider&&c.accountRef===r.accountRef);if(cooldown&&(cooldown.until===null||cooldown.until>lease.acquiredAt))stop('TC_COOLDOWN');s.leases.push(lease);
  }else if(['CONSUMED','SETTLED','ABANDON','LOCAL_RECLAIM'].includes(event.kind)){
    const lease=s.leases.find(l=>l.id===d.id);if(!lease)stop('TC_LEASE');
    if(event.kind==='CONSUMED'){shape(d,['id']);if(lease.remote!=='RESERVED'||lease.local!=='HELD')stop('TC_ONCE');lease.remote='CONSUMED';}
    else if(event.kind==='SETTLED'){
      shape(d,['id','localReleased','remoteUnknown','httpStatus','retryAfterMs','retryAfterInvalid','at']);if(lease.remote!=='CONSUMED'||typeof d.localReleased!=='boolean'||typeof d.remoteUnknown!=='boolean'||typeof d.retryAfterInvalid!=='boolean')stop('TC_SETTLE');integer(d.at,lease.acquiredAt);if(d.httpStatus!==null)integer(d.httpStatus,100,599);if(d.retryAfterMs!==null)integer(d.retryAfterMs);lease.local=d.localReleased?'RELEASED':'HELD';lease.remote=d.remoteUnknown?'UNKNOWN':'SETTLED';
      if(d.httpStatus===429){const until=d.retryAfterInvalid?null:integer(Number(d.at)+(d.retryAfterMs===null?1000:Number(d.retryAfterMs))),prior=s.cooldowns.find(c=>c.provider===lease.request.provider&&c.accountRef===lease.request.accountRef);if(prior)prior.until=prior.until===null||until===null?null:Math.max(prior.until,until);else s.cooldowns.push({provider:lease.request.provider,accountRef:lease.request.accountRef,until});}
    }else if(event.kind==='ABANDON'){shape(d,['id','localReleased']);if(typeof d.localReleased!=='boolean'||!['RESERVED','CONSUMED'].includes(lease.remote))stop('TC_LEASE');lease.local=d.localReleased?'RELEASED':'HELD';lease.remote=lease.remote==='RESERVED'?'SETTLED':'UNKNOWN';}
    else{shape(d,['id','owner','proofDigest']);same(d.owner,lease.owner);digest(d.proofDigest);if(lease.local!=='HELD')stop('TC_RECLAIM');lease.local='RECLAIMED';if(lease.remote==='RESERVED'||lease.remote==='CONSUMED')lease.remote='UNKNOWN';}
  }else if(event.kind==='BARRIER'){
    shape(d,['microRound','assemblyDigest','indexDigests']);if(d.microRound!==s.microRound||s.children.filter(c=>c.microRound===s.microRound).some(c=>c.stage!=='COMPLETE'))stop('TC_BARRIER');digest(d.assemblyDigest);same(d.indexDigests,s.children.filter(c=>c.microRound<=s.microRound).map(c=>c.indexDigest));s.barriers.push(d as unknown as TeachingCycleState['barriers'][number]);s.microRound++;if(s.children.every(c=>c.stage==='COMPLETE')){s.status='COMPLETE';if(real)s.timing!.completedAt=event.at!;}
  }else stop('TC_EVENT');return s;
}

/** One cycle owner; child/provider work may overlap, transactions never await. */
export class TeachingCycleStore {
  readonly spec:TeachingCycleSpec;readonly mode:TeachingCycleStoreOptions['mode'];#o:TeachingCycleStoreOptions;#key:Buffer;#host:HostAuthority;#db!:DatabaseSync;#owner!:DatabaseSync;#state:TeachingCycleState|null=null;#head='0'.repeat(64);#seq=0;#stamp='';#loading=true;#closed=false;#broken=false;#ports=new Map<string,ArtifactPort>();
  constructor(o:TeachingCycleStoreOptions){
    this.spec=validateCycleSpec(o.spec);this.mode=o.mode;requireRealPlanAdmission(this.spec,o.mode!=='inspect',o.realPlanAdmission);if(o.key.length!==32)stop('TC_KEY');this.#key=Buffer.from(o.key);this.#o={...o,key:this.#key};requireTrainingBinding(o.approvedTrainingRoot,o.runtimeRoot,this.spec.storageBindingDigest,o.authorityPath);this.#host=new HostAuthority(o.authorityPath,this.spec.cycleId,o.now??Date.now);
    const a=this.#host.read(this.now(),o.mode!=='inspect'),file=join(o.runtimeRoot,'teaching-cycle.sqlite'),owner=join(o.runtimeRoot,'teaching-cycle-owner.sqlite');
    try{if(o.mode==='create'){if(a.head!==null||readdirSync(o.runtimeRoot).length)stop('TC_EXISTS');mkdirSync(join(o.runtimeRoot,'objects'));emptyFile(file);emptyFile(owner);}plain(owner,4096);plain(file,this.spec.resources.maxLedgerBytes);this.#owner=new DatabaseSync(owner,{timeout:0});try{this.#owner.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');}catch{stop('TC_OWNER');}
      for(const suffix of ['-wal','-shm'])if(existsSync(file+suffix))stop('TC_INTEGRITY');if(existsSync(file+'-journal')&&statSync(file+'-journal').size>0)stop('TC_COMMIT_UNKNOWN');this.#db=new DatabaseSync(file,{readOnly:o.mode==='inspect',timeout:0});this.#db.exec('PRAGMA trusted_schema=OFF');
      if(o.mode==='create')this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; PRAGMA application_id=1413698353; PRAGMA user_version=1; '+SCHEMA.join(';')+'; COMMIT;');else{if(this.#db.prepare('PRAGMA application_id').get()!.application_id!==1413698353||this.#db.prepare('PRAGMA user_version').get()!.user_version!==1)stop('TC_SCHEMA');same(this.#db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.sql),SCHEMA);}
      this.#stamp=this.#fileStamp();integer(this.#db.prepare('SELECT count(*) AS n FROM events').get()!.n,0,this.spec.resources.maxEvents);
      for(const [i,row]of this.#db.prepare('SELECT * FROM events ORDER BY sequence').all().entries()){
        if(row.sequence!==i+1||row.previous!==this.#head||typeof row.ref!=='string'||row.ref.length>2048||row.digest!==hash(this.#head+'\n'+row.ref))stop('TC_CHAIN');const ref=scoped(parseJson(row.ref) as unknown as ScopedRef);if(ref.ref.kind!=='teaching-cycle-event'||canonical(ref)!==row.ref)stop('TC_CHAIN');this.#state=reduce(this.#state,parseJson(this.read(ref).toString('utf8')) as unknown as CycleEvent,this.spec);this.#head=String(row.digest);this.#seq=i+1;
      }
      if(o.mode!=='create'&&(!this.#state||a.head!==this.#head))stop('TC_HEAD');if(this.#state&&this.#db.prepare('SELECT data FROM metadata WHERE id=1').get()?.data!==canonical(this.#state))stop('TC_PROJECTION');this.#loading=false;this.check(o.mode!=='inspect');
    }catch(error){try{this.#db?.close();}catch{}try{this.#owner?.close();}catch{}this.#key.fill(0);throw error;}
  }
  now(){return integer(this.#o.now?.()??Date.now());}
  #fileStamp(){const path=join(this.#o.runtimeRoot,'teaching-cycle.sqlite');plain(path,this.spec.resources.maxLedgerBytes);const s=statSync(path,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
  check(active=true){if(this.#closed||this.#broken)stop('TC_CLOSED');requireRealPlanAdmission(this.spec,active,this.#o.realPlanAdmission);requireTrainingBinding(this.#o.approvedTrainingRoot,this.#o.runtimeRoot,this.spec.storageBindingDigest,this.#o.authorityPath);const admission=shape(copyJson(this.#o.admission()),['planDigest','sourceAllowed','retainAllowed']);if(admission.planDigest!==this.spec.planDigest||admission.sourceAllowed!==true||admission.retainAllowed!==true)stop('TC_SOURCE');const now=this.now();if(this.#state?.timing&&now<this.#state.timing.lastObservedAt)stop('TC_CLOCK');const a=this.#host.read(now,active);if(this.#stamp&&this.#stamp!==this.#fileStamp()||!this.#loading&&a.head!==(this.#seq?this.#head:null))stop('TC_HEAD');if(active&&(this.mode==='inspect'||a.runtimeId!==this.spec.runtimeId||a.revision!==this.spec.authorityRevision||now<this.spec.createdAt||now>=this.spec.expiresAt))stop('TC_AUTHORITY');return a;}
  port(bucket:string){if(!/^(meta|event-\d+|index-\d+)$/.test(bucket))stop('TC_BUCKET');const prior=this.#ports.get(bucket);if(prior)return prior;const path=join(this.#o.runtimeRoot,'objects',bucket);if(!existsSync(path)){this.check();mkdirSync(path);}const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())stop('TC_FILE');const raw=createArtifactBroker(path,this.spec.cycleId+':'+bucket,this.#key,()=>this.check(false)).train,port={read:raw.read,put:(kind:string,bytes:string|Uint8Array)=>{this.check();return raw.put(kind,bytes);}};this.#ports.set(bucket,port);return port;}
  put(bucket:string,kind:string,bytes:string|Uint8Array):ScopedRef{const ref={bucket,ref:this.port(bucket).put(kind,bytes)};if(!this.read(ref).equals(Buffer.from(bytes)))stop('TC_READBACK');return ref;}
  read(input:ScopedRef){const ref=scoped(input);return this.port(ref.bucket).read(ref.ref);}
  snapshot(){this.check(false);return this.#state?structuredClone(this.#state):null;}
  initialize(plan:CurriculumPlan){this.apply('INIT',{spec:this.spec,plan});}
  apply(kind:CycleEvent['kind'],data:unknown){this.check();if(this.#seq>=this.spec.resources.maxEvents)stop('TC_EVENT_LIMIT');const real=this.spec.version==='TeachingCycle/0.2',event:CycleEvent={version:real?'TeachingCycleEvent/0.2':'TeachingCycleEvent/0.1',kind,data:copyJson(data),...(real?{at:this.now()}:{})},next=reduce(this.#state,event,this.spec),ref=this.put('event-'+Math.floor(this.#seq/128),'teaching-cycle-event',canonical(event)),body=canonical(ref),head=hash(this.#head+'\n'+body);
    try{this.#db.exec('BEGIN IMMEDIATE');this.#db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(this.#seq+1,this.#head,body,head);this.#db.prepare('INSERT OR REPLACE INTO metadata VALUES (1,?)').run(canonical(next));this.#db.exec('COMMIT');this.#host.commitHead(this.#seq?this.#head:null,head);this.#state=next;this.#head=head;this.#seq++;this.#stamp=this.#fileStamp();this.check();}catch{this.#broken=true;stop('TC_COMMIT_UNKNOWN');}
  }
  control(status:'PAUSED'|'REVOKED'){this.check();this.#host.control(status);}
  commitment(){this.check(false);return {head:this.#head,sequence:this.#seq};}
  authorizeSend<T>(send:()=>T){this.check();return this.#host.dispatch(this.#head,()=>{this.check();return send();});}
  close(){if(this.#closed)return;this.#closed=true;try{this.#db.close();}finally{try{this.#owner.close();}finally{this.#key.fill(0);this.#ports.clear();}}}
}
export const openTeachingCycle=(options:TeachingCycleStoreOptions)=>new TeachingCycleStore(options);
