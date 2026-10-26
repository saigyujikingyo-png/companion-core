import { createHash } from 'node:crypto';
import { frozenCopy, type Frozen } from './curation-types.ts';
import { normalizeSceneJson, parseSceneJson, SCENE_JSON_LIMITS } from './scene-json.ts';
import { fail } from './validation.ts';

export const SCENE_LIMITS = Object.freeze({ objects:32, relations:64, anchors:32, claims:128,
  tracks:32, residuals:32, concepts:128, profiles:16, prototypes:32, sources:64, refs:32, labels:8 });
export type SceneRef = { id:string; revision:number };
export type ConceptRef = SceneRef & { namespace:string };
export type SceneEpoch = { generation:number; consentRevision:number };
export type TrackRef = { device:string; streamEpoch:number; localTrackId:string; rev:number };
export type ConceptDefinition = { ref:ConceptRef; kind:'object_type'|'attribute'|'relation'|'value';
  definition:string; labels:Array<{language:string; text:string}>; status:'active'|'retired' };
export type MappingProfile = { ref:SceneRef; modelRef:SceneRef; checkpointRef:SceneRef; layer:string;
  activationKind:string; preprocessRef:SceneRef; tokenizerRef:SceneRef; pooling:string; dtype:string;
  normalization:string; encoderRef:SceneRef; saeDictionaryRef:SceneRef|null; prototypeDictionaryRef:SceneRef;
  decoderRef:SceneRef; quantizerRef:SceneRef; latentSpace:string; dimension:number; alignmentRef:SceneRef|null;
  trainingLineage:SceneRef[]; calibrationLineage:SceneRef[] };
export type SceneCatalog = { version:1; concepts:ConceptDefinition[]; mappingProfiles:MappingProfile[];
  prototypes:Array<{ref:SceneRef; conceptRef:ConceptRef; profileRef:SceneRef; dictionaryRef:SceneRef;
    decoderRef:SceneRef; quantizerRef:SceneRef}>;
  declaredSources:Array<{ref:SceneRef; scopeRef:string; epoch:SceneEpoch; kind:'observation'|'report'}> };
export type SceneValue = {kind:'unknown'; reason:'not_observed'|'withheld'|'not_applicable'} |
  {kind:'text'; text:string} | {kind:'number'; number:number; unit:string} |
  {kind:'concept'; conceptRef:ConceptRef} | {kind:'object'; objectId:string} |
  {kind:'entity'; scopeRef:string; ref:SceneRef} | {kind:'pixel2D'; x:number; y:number; width:number; height:number};
export type SceneClaim = SceneRef & { kind:'classification'|'identity'|'attribute'|'relation'; subject:string;
  predicate:ConceptRef|null; value:SceneValue; origin:'observation'|'report'|'inference';
  verification:'not_verified'; sourceRefs:SceneRef[]; occurredAt:number|null };
export type ScenePacket = { version:1; ref:SceneRef; scopeRef:string; epoch:SceneEpoch;
  occurredAt:number|null; recordedAt:number; applicability:{from:number|null; to:number|null}; sourceRefs:SceneRef[];
  tracks:Array<TrackRef & {sourceRef:SceneRef}>;
  objects:Array<{id:string; typeClaim:SceneRef; trackRef:TrackRef|null; identityClaim:SceneRef|null; attributeClaims:SceneRef[]}>;
  claims:SceneClaim[]; relations:Array<{id:string; claimRef:SceneRef}>;
  anchors:Array<{id:string; claimRef:SceneRef; sourceRef:SceneRef; selector:{kind:'opaque'; ref:string}}>;
  geometry:{kind:'unknown'}|{kind:'pixel2D'; frameRef:SceneRef; width:number; height:number;
    units:'pixel'; origin:'top_left'; xAxis:'right'; yAxis:'down'};
  residuals:Array<{id:string; objectId:string; claimRefs:SceneRef[]; profileRef:SceneRef; prototypeRef:SceneRef;
    decoderRef:SceneRef; quantizerRef:SceneRef; opaqueRef:string}> };
export type SceneRead = Frozen<{packet:ScenePacket; catalog:SceneCatalog; assurance:'NOT_AUTHENTICATED'}>;

type RecordValue = Record<string,unknown>;
const invalid=():never=>fail('SCENE_INVALID_INPUT');
function fields(value:unknown, names:string[]):RecordValue {
  if (value===null || typeof value!=='object' || Array.isArray(value)) return invalid();
  const result=value as RecordValue, keys=Object.keys(result);
  if (keys.length!==names.length || keys.some(key=>!names.includes(key))) invalid();
  return result;
}
function list(value:unknown,max:number,min=0):unknown[] {
  if (!Array.isArray(value)) return invalid();
  if (value.length>max) fail('SCENE_LIMIT');
  if (value.length<min) invalid();
  return value;
}
function str(value:unknown,max=128):string {
  if (typeof value!=='string' || !value.length || value.length>max || /[\x00-\x1f\x7f]/.test(value)) return invalid();
  return value;
}
function id(value:unknown):string {
  const result=str(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) invalid();
  return result;
}
function integer(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number {
  if (typeof value!=='number' || !Number.isSafeInteger(value) || value<min || value>max) return invalid();
  return value;
}
function finite(value:unknown,min=-Number.MAX_VALUE):number {
  if (typeof value!=='number' || !Number.isFinite(value) || value<min) return invalid();
  return value;
}
/** With nonnegative operands, subtract the larger one so a tiny positive overrun is not rounded away. */
function fitsAxis(offset:number,size:number,extent:number):boolean {
  const larger=Math.max(offset,size),smaller=Math.min(offset,size);
  return larger<=extent && smaller<=extent-larger;
}
function oneOf<T extends string>(value:unknown,values:readonly T[]):T {
  if (typeof value!=='string' || !values.includes(value as T)) return invalid();
  return value as T;
}
function version(value:unknown,expected:unknown):void { if (value!==expected) fail('SCENE_UNSUPPORTED_VERSION'); }
function ref(value:unknown):SceneRef { const v=fields(value,['id','revision']);id(v.id);integer(v.revision,1);return v as SceneRef; }
function conceptRef(value:unknown):ConceptRef {
  const v=fields(value,['namespace','id','revision']);id(v.namespace);id(v.id);integer(v.revision,1);return v as ConceptRef;
}
function epoch(value:unknown):SceneEpoch {
  const v=fields(value,['generation','consentRevision']);integer(v.generation,1);integer(v.consentRevision,1);return v as SceneEpoch;
}
function track(value:unknown,withSource=false):TrackRef {
  const v=fields(value,['device','streamEpoch','localTrackId','rev',...(withSource?['sourceRef']:[])]);
  id(v.device);integer(v.streamEpoch,1);id(v.localTrackId);integer(v.rev,1);if(withSource)ref(v.sourceRef);return v as TrackRef;
}
const key=(value:SceneRef):string=>JSON.stringify([value.id,value.revision]);
const conceptKey=(value:ConceptRef):string=>JSON.stringify([value.namespace,value.id,value.revision]);
const trackKey=(value:TrackRef):string=>JSON.stringify([value.device,value.streamEpoch,value.localTrackId,value.rev]);
function sameRef(a:SceneRef,b:SceneRef):boolean {return key(a)===key(b);}
function unique<T>(values:T[],getKey:(value:T)=>string):Map<string,T> {
  const result=new Map<string,T>();for(const value of values){const k=getKey(value);if(result.has(k))fail('SCENE_DUPLICATE_REF');result.set(k,value);}return result;
}
function references(value:unknown,min=0):SceneRef[] {
  const result=list(value,SCENE_LIMITS.refs,min).map(ref);unique(result,key);return result;
}
function required<T>(map:Map<string,T>,k:string):T { const result=map.get(k);if(result===undefined)fail('SCENE_REF_MISMATCH');return result; }
function timestamp(value:unknown):void {if(value!==null)integer(value);}

function catalog(value:unknown):SceneCatalog {
  const c=fields(value,['version','concepts','mappingProfiles','prototypes','declaredSources']);version(c.version,1);
  const concepts=list(c.concepts,SCENE_LIMITS.concepts).map(item=>{
    const v=fields(item,['ref','kind','definition','labels','status']);conceptRef(v.ref);
    oneOf(v.kind,['object_type','attribute','relation','value']);str(v.definition,2_048);oneOf(v.status,['active','retired']);
    const labels=list(v.labels,SCENE_LIMITS.labels,1).map(label=>{
      const l=fields(label,['language','text']);id(l.language);str(l.text,256);return l;
    });unique(labels,l=>l.language as string);return v as ConceptDefinition;
  });
  const conceptMap=unique(concepts,c=>conceptKey(c.ref));
  const sources=list(c.declaredSources,SCENE_LIMITS.sources).map(item=>{
    const v=fields(item,['ref','scopeRef','epoch','kind']);ref(v.ref);id(v.scopeRef);epoch(v.epoch);oneOf(v.kind,['observation','report']);
    return v as SceneCatalog['declaredSources'][number];
  });const sourceMap=unique(sources,s=>key(s.ref));
  const profiles=list(c.mappingProfiles,SCENE_LIMITS.profiles).map(item=>{
    const v=fields(item,['ref','modelRef','checkpointRef','layer','activationKind','preprocessRef','tokenizerRef','pooling','dtype',
      'normalization','encoderRef','saeDictionaryRef','prototypeDictionaryRef','decoderRef','quantizerRef','latentSpace','dimension',
      'alignmentRef','trainingLineage','calibrationLineage']);
    for(const k of ['ref','modelRef','checkpointRef','preprocessRef','tokenizerRef','encoderRef','prototypeDictionaryRef','decoderRef','quantizerRef'])ref(v[k]);
    for(const k of ['layer','activationKind','pooling','dtype','normalization','latentSpace'])id(v[k]);
    for(const k of ['saeDictionaryRef','alignmentRef'])if(v[k]!==null)ref(v[k]);
    integer(v.dimension,1,4_096);
    for(const k of ['trainingLineage','calibrationLineage'])for(const r of references(v[k]))required(sourceMap,key(r));
    return v as MappingProfile;
  });const profileMap=unique(profiles,p=>key(p.ref));
  const prototypes=list(c.prototypes,SCENE_LIMITS.prototypes).map(item=>{
    const v=fields(item,['ref','conceptRef','profileRef','dictionaryRef','decoderRef','quantizerRef']);
    for(const k of ['ref','profileRef','dictionaryRef','decoderRef','quantizerRef'])ref(v[k]);conceptRef(v.conceptRef);
    const concept=required(conceptMap,conceptKey(v.conceptRef as ConceptRef));
    if(concept.kind!=='object_type')invalid();
    const p=required(profileMap,key(v.profileRef as SceneRef));
    for(const [field,expected] of [['dictionaryRef',p.prototypeDictionaryRef],['decoderRef',p.decoderRef],['quantizerRef',p.quantizerRef]] as const)
      if(!sameRef(v[field] as SceneRef,expected))fail('SCENE_PROFILE_MISMATCH');
    return v as SceneCatalog['prototypes'][number];
  });unique(prototypes,p=>key(p.ref));
  return c as SceneCatalog;
}

function packet(value:unknown,c:SceneCatalog):ScenePacket {
  const p=fields(value,['version','ref','scopeRef','epoch','occurredAt','recordedAt','applicability','sourceRefs',
    'tracks','objects','claims','relations','anchors','geometry','residuals']);version(p.version,1);ref(p.ref);id(p.scopeRef);
  const e=epoch(p.epoch);timestamp(p.occurredAt);integer(p.recordedAt);
  const applies=fields(p.applicability,['from','to']);timestamp(applies.from);timestamp(applies.to);
  if(applies.from!==null && applies.to!==null && (applies.from as number)>(applies.to as number))invalid();
  const conceptMap=unique(c.concepts,v=>conceptKey(v.ref)),sourceMap=unique(c.declaredSources,v=>key(v.ref));
  const sources=references(p.sourceRefs), sourceKeys=new Set(sources.map(key));
  for(const r of sources){const source=required(sourceMap,key(r));
    if(source.scopeRef!==p.scopeRef || source.epoch.generation!==e.generation || source.epoch.consentRevision!==e.consentRevision)fail('SCENE_SOURCE_MISMATCH');}
  const checkSource=(r:SceneRef):SceneCatalog['declaredSources'][number]=>{
    if(!sourceKeys.has(key(r)))fail('SCENE_SOURCE_MISMATCH');return required(sourceMap,key(r));
  };
  const checkConcept=(r:ConceptRef,kind:ConceptDefinition['kind']):void=>{
    if(required(conceptMap,conceptKey(r)).kind!==kind)fail('SCENE_REF_MISMATCH');
  };
  const tracks=list(p.tracks,SCENE_LIMITS.tracks).map(item=>{
    track(item,true);const t=item as ScenePacket['tracks'][number];checkSource(t.sourceRef);return t;
  });const trackMap=unique(tracks,trackKey);
  const objects=list(p.objects,SCENE_LIMITS.objects).map(item=>{
    const o=fields(item,['id','typeClaim','trackRef','identityClaim','attributeClaims']);id(o.id);ref(o.typeClaim);
    if(o.trackRef!==null)required(trackMap,trackKey(track(o.trackRef)));
    if(o.identityClaim!==null)ref(o.identityClaim);references(o.attributeClaims);return o as ScenePacket['objects'][number];
  });const objectMap=unique(objects,o=>o.id);
  const geometry=p.geometry as RecordValue;
  if(geometry!==null && typeof geometry==='object' && geometry.kind==='calibrated3D')fail('SCENE_UNSUPPORTED_GEOMETRY');
  if(geometry?.kind==='unknown')fields(geometry,['kind']);
  else {
    const g=fields(geometry,['kind','frameRef','width','height','units','origin','xAxis','yAxis']);
    oneOf(g.kind,['pixel2D']);checkSource(ref(g.frameRef));integer(g.width,1,1_000_000);integer(g.height,1,1_000_000);
    oneOf(g.units,['pixel']);oneOf(g.origin,['top_left']);oneOf(g.xAxis,['right']);oneOf(g.yAxis,['down']);
  }
  const claims=list(p.claims,SCENE_LIMITS.claims).map(item=>{
    const q=fields(item,['id','revision','kind','subject','predicate','value','origin','verification','sourceRefs','occurredAt']);
    id(q.id);integer(q.revision,1);const kind=oneOf(q.kind,['classification','identity','attribute','relation']);
    required(objectMap,id(q.subject));const origin=oneOf(q.origin,['observation','report','inference']);
    oneOf(q.verification,['not_verified']);timestamp(q.occurredAt);
    for(const r of references(q.sourceRefs,1)){const source=checkSource(r);
      if(origin!=='inference' && source.kind!==origin)fail('SCENE_SOURCE_MISMATCH');}
    if(kind==='attribute' || kind==='relation')checkConcept(conceptRef(q.predicate),kind);
    else if(q.predicate!==null)invalid();
    const v=q.value as RecordValue;
    if(v===null || typeof v!=='object' || Array.isArray(v))invalid();
    switch(v.kind){
      case 'unknown':fields(v,['kind','reason']);oneOf(v.reason,['not_observed','withheld','not_applicable']);break;
      case 'text':fields(v,['kind','text']);str(v.text,2_048);break;
      case 'number':fields(v,['kind','number','unit']);finite(v.number);id(v.unit);break;
      case 'concept':fields(v,['kind','conceptRef']);checkConcept(conceptRef(v.conceptRef),kind==='classification'?'object_type':'value');break;
      case 'object':fields(v,['kind','objectId']);required(objectMap,id(v.objectId));break;
      case 'entity':fields(v,['kind','scopeRef','ref']);ref(v.ref);if(v.scopeRef!==p.scopeRef)fail('SCENE_SOURCE_MISMATCH');break;
      case 'pixel2D':{
        fields(v,['kind','x','y','width','height']);
        if(geometry.kind!=='pixel2D')fail('SCENE_GEOMETRY_MISMATCH');
        if(!(q.sourceRefs as SceneRef[]).some(r=>sameRef(r,geometry.frameRef as SceneRef)))fail('SCENE_SOURCE_MISMATCH');
        for(const k of ['x','y','width','height'])finite(v[k],0);
        if(!fitsAxis(v.x as number,v.width as number,geometry.width as number) ||
          !fitsAxis(v.y as number,v.height as number,geometry.height as number))fail('SCENE_GEOMETRY_MISMATCH');break;
      }
      default:invalid();
    }
    const allowed={classification:['concept','unknown'],identity:['entity','unknown'],attribute:['unknown','text','number','concept','pixel2D'],relation:['object','unknown']};
    if(!allowed[kind].includes(v.kind as string))invalid();
    return q as SceneClaim;
  });const claimMap=unique(claims,key);unique(claims,q=>q.id);
  const bound=new Set<string>();
  const bind=(r:SceneRef,kind:SceneClaim['kind'],subject?:string):SceneClaim=>{
    const q=required(claimMap,key(r));if(q.kind!==kind || (subject!==undefined && q.subject!==subject))fail('SCENE_BINDING_MISMATCH');
    if(bound.has(key(r)))fail('SCENE_BINDING_MISMATCH');bound.add(key(r));return q;
  };
  for(const o of objects){bind(o.typeClaim,'classification',o.id);if(o.identityClaim!==null)bind(o.identityClaim,'identity',o.id);
    const predicates=new Set<string>();for(const r of o.attributeClaims){const q=bind(r,'attribute',o.id),k=conceptKey(q.predicate!);
      if(predicates.has(k))fail('SCENE_BINDING_MISMATCH');predicates.add(k);}}
  const relations=list(p.relations,SCENE_LIMITS.relations).map(item=>{
    const v=fields(item,['id','claimRef']);id(v.id);bind(ref(v.claimRef),'relation');return v;
  });unique(relations,v=>v.id as string);
  if(bound.size!==claims.length)fail('SCENE_BINDING_MISMATCH');
  const anchors=list(p.anchors,SCENE_LIMITS.anchors).map(item=>{
    const a=fields(item,['id','claimRef','sourceRef','selector']);id(a.id);const q=required(claimMap,key(ref(a.claimRef))),r=ref(a.sourceRef);
    if(!q.sourceRefs.some(source=>sameRef(source,r)))fail('SCENE_SOURCE_MISMATCH');
    const selector=fields(a.selector,['kind','ref']);oneOf(selector.kind,['opaque']);id(selector.ref);return a;
  });unique(anchors,a=>a.id as string);
  const profileMap=unique(c.mappingProfiles,v=>key(v.ref)),prototypeMap=unique(c.prototypes,v=>key(v.ref));
  const residuals=list(p.residuals,SCENE_LIMITS.residuals).map(item=>{
    const r=fields(item,['id','objectId','claimRefs','profileRef','prototypeRef','decoderRef','quantizerRef','opaqueRef']);id(r.id);id(r.opaqueRef);
    const o=required(objectMap,id(r.objectId));for(const claim of references(r.claimRefs,1))
      if(required(claimMap,key(claim)).subject!==o.id)fail('SCENE_BINDING_MISMATCH');
    const profile=required(profileMap,key(ref(r.profileRef))),prototype=required(prototypeMap,key(ref(r.prototypeRef)));
    for(const source of [...profile.trainingLineage,...profile.calibrationLineage])checkSource(source);
    const type=required(claimMap,key(o.typeClaim)).value;
    if(type.kind!=='concept' || conceptKey(type.conceptRef)!==conceptKey(prototype.conceptRef) ||
      !sameRef(profile.ref,prototype.profileRef) || !sameRef(ref(r.decoderRef),profile.decoderRef) ||
      !sameRef(ref(r.quantizerRef),profile.quantizerRef))fail('SCENE_PROFILE_MISMATCH');return r;
  });unique(residuals,r=>r.id as string);
  return p as ScenePacket;
}

const CONTAINER='scene-json-envelope-v1',CODEC='identity-json-v1',CANONICAL='scene-canonical-json-v1';
const digest=(raw:string):string=>createHash('sha256').update(raw,'utf8').digest('hex');
/** No clock, authority, IO, decoder or callbacks. Catalog consistency is not source authentication. */
export class SceneContract {
  #catalog:Frozen<SceneCatalog>;
  #catalogJson:string;
  constructor(catalogJson:string){
    this.#catalog=frozenCopy(catalog(parseSceneJson(catalogJson)));
    this.#catalogJson=normalizeSceneJson(JSON.stringify(this.#catalog));
  }
  #envelope(p:ScenePacket):string {
    const payload={catalog:this.#catalog,packet:p};
    const normalized=normalizeSceneJson(JSON.stringify(payload));
    const envelope={manifest:{logicalSchemaVersion:1,containerProfile:CONTAINER,codecProfile:CODEC,
      canonicalization:CANONICAL,integrity:'sha256',payloadBytes:Buffer.byteLength(normalized,'utf8'),payloadSha256:digest(normalized)},payload};
    // Full envelope (including catalog/manifest) must pass the same aggregate byte/node/depth budgets.
    return normalizeSceneJson(JSON.stringify(envelope));
  }
  #read(packetJson:string):{packet:ScenePacket; envelope:string} {
    const p=packet(parseSceneJson(packetJson),this.#catalog as SceneCatalog);
    return {packet:p,envelope:this.#envelope(p)};
  }
  read(packetJson:string):SceneRead {
    const result=this.#read(packetJson);
    return frozenCopy({packet:result.packet,catalog:this.#catalog as SceneCatalog,assurance:'NOT_AUTHENTICATED' as const});
  }
  export(packetJson:string):string {return this.#read(packetJson).envelope;}
  import(exchangeJson:string):SceneRead {
    const envelope=fields(parseSceneJson(exchangeJson),['manifest','payload']);
    const manifest=fields(envelope.manifest,['logicalSchemaVersion','containerProfile','codecProfile','canonicalization','integrity','payloadBytes','payloadSha256']);
    version(manifest.logicalSchemaVersion,1);version(manifest.containerProfile,CONTAINER);version(manifest.codecProfile,CODEC);
    version(manifest.canonicalization,CANONICAL);version(manifest.integrity,'sha256');
    integer(manifest.payloadBytes,0,SCENE_JSON_LIMITS.bytes);
    if(typeof manifest.payloadSha256!=='string' || !/^[0-9a-f]{64}$/.test(manifest.payloadSha256))invalid();
    const payload=fields(envelope.payload,['catalog','packet']);
    const normalized=normalizeSceneJson(JSON.stringify(payload));
    if(Buffer.byteLength(normalized,'utf8')!==manifest.payloadBytes || digest(normalized)!==manifest.payloadSha256)fail('SCENE_INTEGRITY_MISMATCH');
    if(normalizeSceneJson(JSON.stringify(payload.catalog))!==this.#catalogJson)fail('SCENE_CATALOG_MISMATCH');
    return this.read(JSON.stringify(payload.packet));
  }
}
