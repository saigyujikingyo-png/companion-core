import { closeSync,existsSync,fsyncSync,lstatSync,openSync,readdirSync,statSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artifactRef } from './wf1-contract.ts';
import { canonical,copyJson,hash,integer,parseJson,shape,stop } from './wf1-json.ts';
import { createArtifactBroker,HostAuthority } from './wf1-storage.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import type { ArtifactRef } from './wf1-types.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import { validatePilotSpec } from './corpus-teacher-types.ts';
import type { PilotSpec,PilotState } from './corpus-teacher-types.ts';

export type PilotSourceCheck=()=>{registryDigest:string;allowed:boolean};
type Options={approvedTrainingRoot:string;runtimeRoot:string;authorityPath:string;spec:PilotSpec;key:Uint8Array;mode:'create'|'inspect';sourceCheck:PilotSourceCheck;now?:()=>number};
const SCHEMA='CREATE TABLE events(sequence INTEGER PRIMARY KEY, previous TEXT NOT NULL, ref TEXT NOT NULL, digest TEXT NOT NULL)';
function plain(path:string,max:number){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)stop('CPQ_INTEGRITY');}
function writeNew(path:string,body:string){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}}
/** One bounded controller, encrypted immutable objects, and the existing independent host head.
 * No external attempt resume or lease/retry API exists. Cold opens can only inspect. */
export class TeacherPilotStore {
  readonly spec:PilotSpec;readonly output:ArtifactPort;readonly custody:ArtifactPort;#host:HostAuthority;
  #options:Options;#db!:DatabaseSync;#owner:DatabaseSync;#state:PilotState|null=null;#head='0'.repeat(64);#sequence=0;#stamp='';#closed=false;#broken=false;#loading=true;
  constructor(options:Options){
    this.#options=options;this.spec=validatePilotSpec(options.spec);const now=options.now??Date.now;
    requireTrainingBinding(options.approvedTrainingRoot,options.runtimeRoot,this.spec.storageBindingDigest,options.authorityPath);
    this.#host=new HostAuthority(options.authorityPath,this.spec.runId,now);
    const a=this.#host.read(now(),options.mode==='create');
    if(options.mode==='create'&&(a.head!==null||a.runtimeId!==this.spec.runtimeId||a.revision!==this.spec.authorityRevision||now()<this.spec.createdAt||now()>=this.spec.expiresAt))stop('CPQ_AUTHORITY');
    this.#source();const root=options.runtimeRoot,path=join(root,'corpus-teacher-ledger.sqlite'),ownerPath=join(root,'corpus-teacher-owner.sqlite');
    if(existsSync(join(root,'wf1-ledger.sqlite'))||existsSync(join(root,'corpus-commit.json')))stop('CPQ_SOURCE_ROOT');
    if(options.mode==='create'){if(readdirSync(root).length!==0)stop('CPQ_RUN_EXISTS');writeNew(ownerPath,'');}
    plain(ownerPath,4096);this.#owner=new DatabaseSync(ownerPath,{timeout:0});
    try{this.#owner.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');}catch{this.#owner.close();stop('CPQ_OWNER_BUSY');}
    try{
      if(options.mode==='create')writeNew(path,'');plain(path,67108864);
      for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix))stop('CPQ_INTEGRITY');
      if(existsSync(path+'-journal')&&statSync(path+'-journal').size>0)stop('CPQ_COMMIT_UNKNOWN');
      this.#db=new DatabaseSync(path,{timeout:0,readOnly:options.mode==='inspect'});this.#db.exec('PRAGMA trusted_schema=OFF');
      if(options.mode==='create')this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=16384; BEGIN IMMEDIATE; PRAGMA application_id=1129337137; PRAGMA user_version=1; '+SCHEMA+'; COMMIT;');
      else {if(this.#db.prepare('PRAGMA application_id').get()!.application_id!==1129337137||this.#db.prepare('PRAGMA user_version').get()!.user_version!==1)stop('CPQ_INTEGRITY');const schema=this.#db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();if(schema.length!==1||schema[0]!.sql!==SCHEMA)stop('CPQ_INTEGRITY');}
      const broker=createArtifactBroker(root,this.spec.runId,options.key,()=>this.check(false));
      const bind=(port:ArtifactPort):ArtifactPort=>({read:port.read,put:(kind,bytes)=>{this.check();return port.put(kind,bytes);}});
      this.output=bind(broker.train);this.custody=bind(broker.custody);
      this.#stamp=this.#fileStamp();
      const count=this.#db.prepare('SELECT count(*) AS n FROM events').get()!.n;integer(count,0,128);
      if(this.#db.prepare('SELECT count(*) AS n FROM events WHERE length(CAST(ref AS BLOB))>2048').get()!.n!==0)stop('CPQ_INTEGRITY');
      for(const [i,row] of this.#db.prepare('SELECT * FROM events ORDER BY sequence').all().entries()){
        if(row.sequence!==i+1||row.previous!==this.#head||typeof row.ref!=='string'||row.digest!==hash(this.#head+'\n'+row.ref))stop('CPQ_INTEGRITY');
        const ref=artifactRef(parseJson(row.ref));if(ref.partition!=='train'||ref.kind!=='corpus-teacher-state'||canonical(ref)!==row.ref)stop('CPQ_INTEGRITY');
        // Validate every immutable state object, not only the final index entry.
        const state=parseJson(broker.train.read(ref).toString('utf8')) as unknown as PilotState;this.#validateState(state);
        this.#state=state;this.#head=row.digest as string;this.#sequence=i+1;
      }
      if(options.mode==='inspect'&&(!this.#state||a.head!==this.#head))stop('CPQ_HEAD');
      this.#loading=false;this.check(false);
    }catch(e){try{this.#db!.close();}catch{}this.#owner.close();throw e;}
  }
  #source(){const s=this.#options.sourceCheck();shape(copyJson(s),['registryDigest','allowed']);if(s.registryDigest!==this.spec.registryDigest||s.allowed!==true)stop('CPQ_SOURCE');}
  #fileStamp(){const path=join(this.#options.runtimeRoot,'corpus-teacher-ledger.sqlite');plain(path,67108864);const s=statSync(path,{bigint:true});return [s.ino,s.dev,s.size,s.mtimeNs,s.ctimeNs].join(':');}
  #validateState(s:PilotState){shape(s,['version','spec','status','code','objectiveRef','registryRef','planRef','attempts','units','manifestRefs','tokenMeasurementRef','wallMs','controllerPeakRss','cpuMicros']);if(s.version!=='CorpusTeacherState/0.1'||canonical(validatePilotSpec(s.spec))!==canonical(this.spec)||s.attempts.length>13||s.units.length>6||s.manifestRefs.length>6)stop('CPQ_INTEGRITY');integer(s.wallMs);integer(s.controllerPeakRss);integer(s.cpuMicros);}
  check(active=true){if(this.#closed||this.#broken)stop('CPQ_CLOSED');requireTrainingBinding(this.#options.approvedTrainingRoot,this.#options.runtimeRoot,this.spec.storageBindingDigest,this.#options.authorityPath);this.#source();const now=(this.#options.now??Date.now)(),a=this.#host.read(now,active);
    if(this.#stamp&&this.#stamp!==this.#fileStamp())stop('CPQ_INTEGRITY');
    if(!this.#loading&&a.head!==(this.#sequence?this.#head:null))stop('CPQ_HEAD');
    // While loading the chain, the final anchor is checked after all rows have been read.
    if(active&&(this.#options.mode!=='create'||a.runtimeId!==this.spec.runtimeId||a.revision!==this.spec.authorityRevision||now>=this.spec.expiresAt||a.head!==(this.#sequence?this.#head:null)))stop('CPQ_AUTHORITY');
    return a;
  }
  snapshot(){this.check(false);return this.#state?structuredClone(this.#state):null;}
  get head(){return this.#head;}
  control(status:'PAUSED'|'REVOKED'){this.check();this.#host.control(status);}
  get readOnly(){return this.#options.mode==='inspect';}
  initialize(state:PilotState){if(this.#state)stop('CPQ_RUN_EXISTS');this.#commit(state);}
  update(change:(s:PilotState)=>void){this.check();if(!this.#state)stop('CPQ_STATE');const next=structuredClone(this.#state);change(next);this.#commit(next);}
  #commit(next:PilotState){this.check();this.#validateState(next);if(this.#sequence>=128)stop('CPQ_LIMIT');
    const ref=this.output.put('corpus-teacher-state',canonical(next)),body=canonical(ref),head=hash(this.#head+'\n'+body),sequence=this.#sequence+1;
    try{this.#db.exec('BEGIN IMMEDIATE');this.#db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(sequence,this.#head,body,head);this.#db.exec('COMMIT');this.#host.commitHead(this.#sequence?this.#head:null,head);this.#head=head;this.#sequence=sequence;this.#state=next;this.#stamp=this.#fileStamp();this.check();}catch{this.#broken=true;stop('CPQ_COMMIT_UNKNOWN');}
  }
  authorizeSend<T>(send:()=>T):T {this.check();return this.#host.dispatch(this.#head,()=>{this.#source();return send();});}
  metrics(){this.check(false);return {diskFinalBytes:readdirSync(this.#options.runtimeRoot).reduce((n,name)=>{const p=join(this.#options.runtimeRoot,name);plain(p,67108864);return n+statSync(p).size;},0)};}
  close(){if(this.#closed)return;this.#closed=true;try{this.#db.close();}finally{this.#owner.close();}}
}
export const openTeacherPilotRun=(options:Options)=>new TeacherPilotStore(options);
