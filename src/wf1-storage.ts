import { DatabaseSync } from 'node:sqlite';
import { createCipheriv,createDecipheriv,createHmac,hkdfSync,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,statSync,writeFileSync } from 'node:fs';
import { dirname,isAbsolute,join,relative,resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactRef,validateAuthority,validateSpec } from './wf1-contract.ts';
import { canonical,copyJson,hash,integer,parseJson,stop,text,Wf1Error } from './wf1-json.ts';
import { WF1 } from './wf1-types.ts';
import type { ArtifactRef,Authority,CampaignSpec,CampaignState } from './wf1-types.ts';

function file(path:string,max:number):void {const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)stop('WF1_PATH');}
export function privateRoot(path:string):string {
  if(typeof path!=='string'||!isAbsolute(path))stop('WF1_PATH');const actual=realpathSync(path);
  if(actual.toLowerCase()!==resolve(path).toLowerCase()||!lstatSync(path).isDirectory()||path.split(/[\\/]/).some(p=>/^onedrive(?:\s|$)/i.test(p)))stop('WF1_PATH');
  const source=dirname(dirname(fileURLToPath(import.meta.url))),rel=relative(source,actual);if(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)))stop('WF1_PATH');return actual;
}
function writeNew(path:string,bytes:Uint8Array|string):void {const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(path:string,bytes:string):void {const temp=path+'.'+randomUUID()+'.pending';writeNew(temp,bytes);renameSync(temp,path);}
export type ArtifactPort={put:(kind:string,bytes:string|Uint8Array)=>ArtifactRef;read:(ref:ArtifactRef)=>Buffer};
/** Only the trusted worker obtains both capabilities. No public role-parameter decrypt method. */
export function createArtifactBroker(root:string,campaignId:string,key:Uint8Array,storageGuard?:()=>void) {
  root=privateRoot(root);if(key.length!==32)stop('WF1_KEY');const ownKey=Buffer.from(key);
  const port=(partition:'custody'|'train'):ArtifactPort=>{
    const derived=Buffer.from(hkdfSync('sha256',ownKey,campaignId,'wf1-'+partition,32));
    return Object.freeze({put(kind:string,bytes:string|Uint8Array):ArtifactRef{
      storageGuard?.();
      text(kind,64);const plain=typeof bytes==='string'?Buffer.from(bytes,'utf8'):Buffer.from(bytes);if(plain.length===0||plain.length>WF1.artifactBytes)stop('WF1_ARTIFACT_LIMIT');
      let total=0;for(const name of readdirSync(root)){const s=lstatSync(join(root,name));if(s.isSymbolicLink())stop('WF1_PATH');if(s.isFile())total+=s.size;}
      if(total+plain.length+28>WF1.runBytes)stop('WF1_DISK_LIMIT');
      const id=randomUUID(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derived,nonce);cipher.setAAD(Buffer.from(canonical({campaignId,partition,id,kind})));
      const encrypted=Buffer.concat([nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);const ref={id,kind,partition,bytes:encrypted.length,digest:hash(encrypted)};
      writeNew(join(root,partition+'-'+id+'.bin'),encrypted);return ref;
    },read(input:ArtifactRef):Buffer{
      storageGuard?.();
      const ref=artifactRef(copyJson(input));if(ref.partition!==partition)stop('WF1_ROLE_ACCESS');const path=join(root,partition+'-'+ref.id+'.bin');file(path,WF1.artifactBytes+28);
      const encrypted=readFileSync(path);if(encrypted.length!==ref.bytes||hash(encrypted)!==ref.digest)stop('WF1_ARTIFACT_CHANGED');
      try{const decipher=createDecipheriv('aes-256-gcm',derived,encrypted.subarray(0,12));decipher.setAAD(Buffer.from(canonical({campaignId,partition,id:ref.id,kind:ref.kind})));decipher.setAuthTag(encrypted.subarray(-16));return Buffer.concat([decipher.update(encrypted.subarray(12,-16)),decipher.final()]);}
      catch{return stop('WF1_SEALED_UNAVAILABLE');}
    }});
  };
  const custody=port('custody'),train=port('train');ownKey.fill(0);return Object.freeze({custody,train});
}
/** Independent host file is a cooperative high-water input, not protection against a malicious same-user host. */
export class HostAuthority {
  readonly path:string;#lastTime=0;#revision:number;#runtimeId:string;#campaignId:string;#now:()=>number;
  constructor(path:string,campaignId:string,now=()=>Date.now()){privateRoot(dirname(path));file(path,16384);this.path=path;this.#now=now;const a=validateAuthority(parseJson(readFileSync(path,'utf8')));if(a.campaignId!==campaignId)stop('WF1_AUTHORITY');this.#revision=a.revision;this.#runtimeId=a.runtimeId;this.#campaignId=campaignId;}
  read(now:number,active=true):Authority {integer(now);file(this.path,16384);const a=validateAuthority(parseJson(readFileSync(this.path,'utf8')));
    if(a.campaignId!==this.#campaignId||a.revision!==this.#revision||a.runtimeId!==this.#runtimeId||now<this.#lastTime||now>=a.expiresAt||
      !a.rights.retain||(active&&(a.status!=='ACTIVE'||Object.values(a.rights).some(v=>!v))))stop('WF1_AUTHORITY');this.#lastTime=now;return a;}
  #locked<T>(operation:()=>T):T {const path=this.path+'.owner.sqlite';try{writeNew(path,'');}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}file(path,4096);
    const db=new DatabaseSync(path,{timeout:1000});try{try{db.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');}catch{return stop('WF1_HOST_BUSY');}return operation();}finally{db.close();}}
  commitHead(expected:string|null,next:string):void {this.#locked(()=>{const a=this.read(this.#now());if(a.head!==expected)stop('WF1_HEAD_MISMATCH');atomic(this.path,canonical({...a,head:next}));const read=this.read(this.#now());if(read.head!==next)stop('WF1_HEAD_MISMATCH');});}
  dispatch<T>(expected:string,start:()=>T):T {return this.#locked(()=>{const a=this.read(this.#now());if(a.head!==expected)stop('WF1_HEAD_MISMATCH');return start();});}
  control(status:'PAUSED'|'REVOKED'):void {this.#locked(()=>{const a=this.read(this.#now(),false);if(a.status==='REVOKED')stop('WF1_REVOKED');atomic(this.path,canonical({...a,status,revision:a.revision+1}));});}
}
const SCHEMA='CREATE TABLE events(sequence INTEGER PRIMARY KEY, previous TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL)';
/** Durable consume first. Cold opens are read-only; an archive never grants execution. */
export class CampaignLedger {
  #db:DatabaseSync;#lock:DatabaseSync;#state:CampaignState;#head:string;#sequence:number;#closed=false;#readonly:boolean;
  readonly host:HostAuthority;readonly root:string;#now:()=>number;#key:Buffer;#stamp:string;
  private constructor(db:DatabaseSync,lock:DatabaseSync,state:CampaignState,head:string,sequence:number,host:HostAuthority,root:string,key:Buffer,readonly:boolean,now:()=>number){this.#db=db;this.#lock=lock;this.#state=state;this.#head=head;this.#sequence=sequence;this.host=host;this.root=root;this.#key=key;this.#readonly=readonly;this.#now=now;this.#stamp=this.#fileStamp();}
  static create(root:string,authorityPath:string,specInput:CampaignSpec,key:Uint8Array,now=()=>Date.now()):CampaignLedger {
    root=privateRoot(root);const rel=relative(root,authorityPath);if(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))stop('WF1_AUTHORITY_PATH');
    const spec=validateSpec(specInput),host=new HostAuthority(authorityPath,spec.id,now),a=host.read(now());
    if(a.head!==null||now()<spec.createdAt||now()>=spec.expiresAt)stop('WF1_ADMISSION');
    return this.#open(root,host,key,false,now,{spec,authorityRevision:a.revision,runtimeId:a.runtimeId,createdAt:now(),transportLane:'UNBOUND',manifestRows:null,status:'ACTIVE',phase:'pilot',sealRef:null,objectiveRef:null,planRef:null,rubricRef:null,attempts:[],candidates:[],exclusions:[],manifestRef:null,code:null,phaseStartedAt:now(),...(spec.schemaVersion==='wf1-campaign/0.8'?{sealUnits:[],planUnits:[]}:{} )});
  }
  static inspect(root:string,authorityPath:string,campaignId:string,key:Uint8Array,now=()=>Date.now()):CampaignLedger {root=privateRoot(root);return this.#open(root,new HostAuthority(authorityPath,campaignId,now),key,true,now);}
  static #open(root:string,host:HostAuthority,key:Uint8Array,readonly:boolean,now:()=>number,initial?:CampaignState):CampaignLedger {
    if(key.length!==32)stop('WF1_KEY');let lock:DatabaseSync|undefined,db:DatabaseSync|undefined;
    const secret=Buffer.from(hkdfSync('sha256',key,'wf1-ledger','chain',32));
    try{
      const owner=join(root,'wf1-owner.sqlite'),path=join(root,'wf1-ledger.sqlite');if(!readonly)try{writeNew(owner,'');}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}file(owner,4096);
      lock=new DatabaseSync(owner,{timeout:0});try{lock.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');}catch{return stop('WF1_OWNER_BUSY');}
      if(initial)writeNew(path,'');file(path,WF1.runBytes);for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix))stop('WF1_PATH');
      if(readonly&&existsSync(path+'-journal')&&statSync(path+'-journal').size>0)stop('WF1_HOT_JOURNAL_RECONCILE');
      db=new DatabaseSync(path,{timeout:0,readOnly:readonly});db.exec('PRAGMA trusted_schema=OFF');
      if(!readonly)db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=16384');
      if(initial)db.exec('BEGIN IMMEDIATE; PRAGMA application_id=1464226097; PRAGMA user_version=1; '+SCHEMA+'; COMMIT;');
      else {if(db.prepare('PRAGMA application_id').get()!.application_id!==1464226097||db.prepare('PRAGMA user_version').get()!.user_version!==1)stop('WF1_LEDGER_VERSION');
        const schemas=db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();if(schemas.length!==1||schemas[0]!.sql!==SCHEMA)stop('WF1_LEDGER_SCHEMA');}
      const count=db.prepare('SELECT count(*) AS n FROM events').get()!.n;integer(count,0,256);
      if(db.prepare('SELECT count(*) AS n FROM events WHERE length(CAST(body AS BLOB))>262144').get()!.n!==0)stop('WF1_LEDGER_LIMIT');
      const rows=db.prepare('SELECT * FROM events ORDER BY sequence').all();let head='0'.repeat(64),state:CampaignState|undefined;
      for(const [index,row]of rows.entries()){
        if(row.sequence!==index+1||row.previous!==head||typeof row.body!=='string'||row.digest!==createHmac('sha256',secret).update(head+'\n'+row.body).digest('hex'))stop('WF1_LEDGER_CORRUPT');
        const parsed=parseJson(row.body);if(canonical(parsed)!==row.body)stop('WF1_LEDGER_CORRUPT');state=parsed as unknown as CampaignState;validateSpec(state.spec);if(state.attempts.length>52||state.candidates.length>24)stop('WF1_LEDGER_LIMIT');head=row.digest as string;
      }
      const a=host.read(now(),!readonly);if(!initial&&(!state||a.head!==head))stop('WF1_HEAD_MISMATCH');
      const ledger=new CampaignLedger(db,lock,initial??state!,head,rows.length,host,root,secret,readonly,now);if(initial)ledger.update('admit',s=>s);return ledger;
    }catch(e){try{db?.close();}catch{}try{lock?.close();}catch{}secret.fill(0);if(e instanceof Wf1Error)throw e;return stop('WF1_LEDGER_IO');}
  }
  #fileStamp():string {const path=join(this.root,'wf1-ledger.sqlite');file(path,WF1.runBytes);const s=statSync(path,{bigint:true});return [s.ino,s.dev,s.size,s.mtimeNs,s.ctimeNs].join(':');}
  #check(active=true):Authority {if(this.#closed)stop('WF1_FENCED');if(this.#stamp!==this.#fileStamp())stop('WF1_LEDGER_CHANGED');const a=this.host.read(this.#now(),active);if(a.head!==(this.#sequence===0?null:this.#head))stop('WF1_HEAD_MISMATCH');return a;}
  snapshot():CampaignState {this.#check(false);return structuredClone(this.#state);}
  get head():string {return this.#head;}
  authorizeDispatch<T>(start:()=>T):T {if(this.#readonly)stop('WF1_READ_ONLY_RECONCILE');this.#check();return this.host.dispatch(this.#head,start);}
  update(_kind:string,change:(state:CampaignState)=>void):void {
    if(this.#readonly)stop('WF1_READ_ONLY_RECONCILE');this.#check();const next=structuredClone(this.#state);change(next);
    const body=canonical(next);parseJson(body);if(++this.#sequence>256)stop('WF1_LEDGER_LIMIT');
    const digest=createHmac('sha256',this.#key).update(this.#head+'\n'+body).digest('hex');
    try{this.#db.exec('BEGIN IMMEDIATE');this.#db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(this.#sequence,this.#head,body,digest);this.#db.exec('COMMIT');
      this.host.commitHead(this.#sequence===1?null:this.#head,digest);this.#state=next;this.#head=digest;this.#stamp=this.#fileStamp();this.#check();
    }catch{this.#closed=true;try{this.#db.close();}finally{this.#lock.close();}stop('WF1_COMMIT_UNKNOWN');}
  }
  close():void {if(this.#closed)return;this.#closed=true;this.#key.fill(0);try{this.#db.close();}finally{this.#lock.close();}}
}
