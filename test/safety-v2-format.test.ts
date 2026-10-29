import assert from 'node:assert/strict';
import test from 'node:test';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';
import {resolve} from 'node:path';
import {INCREMENTAL_FORMAT,generateKeySet,identityOf} from '../src/anchored-codec.ts';
import type {VaultIdentity} from '../src/anchored-codec.ts';
import {SAFETY_V2_PROFILE,safetyOperation,safetyWorkspace,safetyWorkspacePeak,validateV2Hot,boundedSafetyJSON} from '../src/safety-v2-format.ts';
import type {SafetyHotV2} from '../src/safety-v2-format.ts';
import {SafetyView,legacyHotV2} from '../src/safety-v2-view.ts';
import {sealSafetyV2,SafetySegmentV2} from '../src/safety-v2-segment.ts';
import {freezeSafetyV2Frame,reconstructSafetyV2} from '../src/incremental-safety-v2.ts';
import type {OrderedSafetyEntry} from '../src/safety-format.ts';
import {canonicalSafetyJSON} from '../src/safety-format.ts';
import {sha} from '../src/durable-codec.ts';

const identity:VaultIdentity={format:INCREMENTAL_FORMAT,authorityId:'a',vaultId:'v',identity:'synthetic',instanceId:'i',ownerEpoch:1,keyEpoch:1,directory:resolve('synthetic-codec-only'),storageDomain:'payload',storageProfile:SAFETY_V2_PROFILE,safetyCold:null};
const keys=generateKeySet(),entry=(i:number,extra='')=>({key:i.toString(16).padStart(64,'0'),fingerprint:'b'.repeat(64),state:'failed' as const,reserved:false,deliveryId:null,feedbackConsumed:false,...(extra?{extra}:{})});
const hot=(count=0):SafetyHotV2=>({version:2,globals:{version:1,identity:'synthetic',maxCalls:0,reserved:0,lastWall:100,lastSourceRef:null,lastAcknowledgedDeliveryId:null},nextOrdinal:count,ingress:Array.from({length:count},(_,ordinal)=>({ordinal,entry:entry(ordinal)}))});
function* rows(n:number,extra=''):Generator<OrderedSafetyEntry>{for(let ordinal=0;ordinal<n;ordinal++)yield{ordinal,entry:entry(ordinal,extra)};}

test('v2 canonical row/global/ordinal limits preserve extra fields and reject whole legacy conversion',()=>safetyOperation(()=>{
 const state=hot(1),original=canonicalSafetyJSON(state);(state.ingress[0]!.entry as any).extra='retained';const copied=legacyHotV2({...state.globals,ingress:state.ingress.map(r=>r.entry)},state.ingress);assert.equal((copied.ingress[0]!.entry as any).extra,'retained');assert.notEqual(canonicalSafetyJSON(copied),original);
 assert.throws(()=>legacyHotV2({...state.globals,ingress:[entry(0,'x'.repeat(8192))]},state.ingress),/SAFETY_V2_BOUND/);
 assert.throws(()=>legacyHotV2({...state.globals,extension:'x'.repeat(65536),ingress:[entry(0)]} as any,state.ingress),/SAFETY_V2_BOUND/);
 validateV2Hot({...hot(),nextOrdinal:16384},'synthetic',0);assert.throws(()=>validateV2Hot({...hot(),nextOrdinal:16385},'synthetic',0),/SAFETY_V2_FORMAT/);
 assert.throws(()=>validateV2Hot(hot(257),'synthetic',0),/SAFETY_V2_HOT/);
 const payload='x'.repeat(60000);assert.equal(Buffer.byteLength(boundedSafetyJSON({payload},65536)),60014);
}));

test('v2 cold stream early return/double close release tickets and reject union ordinal/request/delivery overlap',()=>safetyOperation(()=>{
 const sealed=sealSafetyV2(rows(2),identity,keys.storageDEK),context={...identity,safetyCold:sealed.descriptor},cold=SafetySegmentV2.open(sealed.bytes,context,keys.storageDEK),baseline=safetyWorkspace().used,cursor=cold.rows();cursor.next();assert.ok(safetyWorkspace().used>baseline);cursor.return(undefined);assert.equal(safetyWorkspace().used,baseline);
 const valid=hot();valid.nextOrdinal=2;const view=new SafetyView(valid,context,0,cold,false);view.validate(true);view.close();
 const collision=hot(1);collision.nextOrdinal=3;assert.throws(()=>new SafetyView(collision,context,0,cold,false),/SAFETY_V2_DUPLICATE/);
 const gap=hot();gap.nextOrdinal=3;assert.throws(()=>new SafetyView(gap,context,0,cold,false),/SAFETY_V2_COUNTS/);
 cold.close();const used=safetyWorkspace().used;cold.close();assert.equal(safetyWorkspace().used,used);
}));

test('v2 8 MiB cold physical bound and operation pressure refuse without leaked builders',()=>safetyOperation(()=>{
 const baseline=safetyWorkspace().used;assert.throws(()=>sealSafetyV2(rows(2048,'x'.repeat(7900)),identity,keys.storageDEK),/full|SQLITE_FULL/);assert.equal(safetyWorkspace().used,baseline);
 const pressure=safetyWorkspace().reserve(safetyWorkspace().available-9000000,'synthetic pressure');const before=safetyWorkspace().used;assert.throws(()=>sealSafetyV2(rows(1),identity,keys.storageDEK),/SAFETY_V2_WORKSPACE/);assert.equal(safetyWorkspace().used,before);pressure();
}));

test('v2 a multi-MiB cold image streams and a separately charged resident set causes honest joint refusal',()=>{
 let coldBytes=0,peak=0;safetyOperation(()=>{
  const sealed=sealSafetyV2(rows(640,'x'.repeat(7900)),identity,keys.storageDEK);coldBytes=sealed.descriptor.plainBytes;assert.ok(coldBytes>4*1024*1024);assert.ok(coldBytes<=8*1024*1024);const context={...identity,safetyCold:sealed.descriptor},cold=SafetySegmentV2.open(sealed.bytes,context,keys.storageDEK);let n=0;for(const r of cold.rows()){assert.equal(r.ordinal,n++);assert.equal((r.entry as any).extra?.length,7900);}assert.equal(n,640);cold.close();
  const pressure=safetyWorkspace().reserve(90*1024*1024,'additional already-live resources');const before=safetyWorkspace().used;assert.throws(()=>SafetySegmentV2.open(sealed.bytes,context,keys.storageDEK),/SAFETY_V2_WORKSPACE/);assert.equal(safetyWorkspace().used,before);pressure();peak=safetyWorkspace().peak;
 });console.log('SAFETY_V2_CODEC_LARGE',JSON.stringify({plainBytes:coldBytes,workspacePeakBytes:peak,limit:134217728,publicPersistentHistory:false}));
});

function unseal(bytes:Buffer,purpose:string){const c=createDecipheriv('aes-256-gcm',keys.storageDEK,bytes.subarray(0,12));c.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,purpose,identity])));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]);}
function seal(bytes:Buffer,purpose:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',keys.storageDEK,iv);c.setAAD(Buffer.from(JSON.stringify([INCREMENTAL_FORMAT,purpose,identity])));const body=Buffer.concat([c.update(bytes),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);}
test('v2 recovery validates an older frame even when the latest frame has a valid complete union',()=>safetyOperation(()=>{
 const view=new SafetyView(hot(1),identity,0),image=randomBytes(128*1024),first=freezeSafetyV2Frame(identity,1,'first',image,view,0,keys,null,null,null),plain=unseal(first.blob,'frame'),n=plain.readUInt32BE(),header=JSON.parse(plain.subarray(4,n+4).toString('utf8'));
 const h=header.safety.codec==='raw'?header.safety.data:JSON.parse(brotliDecompressSync(Buffer.from(header.safety.data,'base64')).toString('utf8'));h.globals.reserved=1;
 const raw=Buffer.from(canonicalSafetyJSON(h));header.safety={version:2,codec:'raw',decodedBytes:raw.length,digest:sha(raw),data:h};const changed=Buffer.from(JSON.stringify(header)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(changed.length);const badBlob=seal(Buffer.concat([prefix,changed,plain.subarray(n+4)]),'frame'),row=JSON.parse(unseal(Buffer.from(first.stage.record,'base64'),'record').toString('utf8'));row.checkpointDigest=sha(badBlob);const badRecord=seal(Buffer.from(JSON.stringify(row)),'record'),badHead={...first.stage.head,digest:sha(badRecord)};
 const changedImage=Buffer.from(image);changedImage[123]=changedImage[123]!^1;const second=freezeSafetyV2Frame(identity,2,'second',changedImage,view,0,keys,badHead,null,first.baseline);assert.equal(second.baseline.depth,2);
 const files=new Map([[`blob-${sha(badBlob)}.bin`,badBlob],['record-1.bin',badRecord],[second.stage.blob,second.blob]]);
 assert.throws(()=>reconstructSafetyV2(second.stage.head,(name,max)=>{const b=files.get(name);assert.ok(b);assert.ok(b.length<=max);return b;},keys,0,second.stage),/SAFETY_V2_FORMAT|SAFETY_V2_COUNTS/);view.close();first.release();second.release();
}));
