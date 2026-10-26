// Trusted synthetic research codec. Does not authenticate sources or authorize use.
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { ATTRS, stable, sha } from './scene.mjs';
export const METHODS = ['FULL_JSON_ZSTD','FULL_BOUND_TEMPLATE_ZSTD','TASK_SUBSET_ZSTD','PROTO_DELTA_LOSSLESS_ZSTD','PROTO_DELTA_Q_ZSTD','PROTO_DELTA_Q_ANCHOR_ZSTD'];
const KNOWN = new Set(['color','material','location','mass_g']);
const ANCHORS = new Set(['crack_mm','serial_tag','dose_mg']);
const QUANTUM = {mass_g:4,temperature_c:4,orientation_deg:15,capacity_ml:16,crack_mm:1,dose_mg:4};
const MAX_BYTES=262144;
export const profile = Object.freeze({logicalSchema:'q0-scene-1',containerVersion:'q0-directory-1',codecVersion:'zstd-3-checksum-workers0',attributeOrder:ATTRS,knownAttributes:[...KNOWN],hardAnchors:[...ANCHORS],quantum:QUANTUM,prototypeEncoding:'q0-prototype-status-delta-1',templateEncoding:'q0-object-template-1'});
export const profileHash=sha(stable(profile));
export function validateFamily(family) {
  if (Buffer.byteLength(stable(family))>MAX_BYTES || family.logicalSchema!=='q0-scene-1' || family.namespace!=='q0-synthetic' || !Array.isArray(family.events) || family.events.length!==4) throw new Error('FAMILY_INVALID');
  for (const event of family.events) {
    if (event.objects.length!==3 || !Number.isFinite(event.timeTick)) throw new Error('EVENT_INVALID');
    for (const object of event.objects) for (const name of ATTRS) {
      const cell=object.attrs[name];
      if (!cell || !['observed_value','observed_unknown'].includes(cell.status)) throw new Error('SOURCE_STATUS_INVALID');
      if (cell.status==='observed_value' && (cell.fidelity!=='exact' || cell.maxAbsError!==0 || (typeof cell.value==='number' && !Number.isFinite(cell.value)))) throw new Error('SOURCE_VALUE_INVALID');
    }
  }
}
function templateEncode(family) {
  const {events,...meta}=family, lines=['Family '+stable(meta)+'.'];
  for (const event of events) {
    const {objects,relations,...eventMeta}=event;
    lines.push('Event '+stable(eventMeta)+'.');
    for (const object of objects) {
      const {attrs,...objectMeta}=object;
      lines.push('Object '+stable(objectMeta)+'.');
      for (const name of ATTRS) lines.push('Its '+JSON.stringify(name)+' is '+stable(attrs[name])+'.');
      lines.push('End object.');
    }
    for (const relation of relations) lines.push('Relation '+stable(relation)+'.');
    lines.push('End event.');
  }
  lines.push('End family.');
  return lines.join('\n')+'\n';
}
function templateDecode(text) {
  let family, event, object;
  for (const line of text.trimEnd().split('\n')) {
    if (line.startsWith('Family ')) family={...JSON.parse(line.slice(7,-1)),events:[]};
    else if (line.startsWith('Event ')) { event={...JSON.parse(line.slice(6,-1)),objects:[],relations:[]}; family.events.push(event); }
    else if (line.startsWith('Object ')) { object={...JSON.parse(line.slice(7,-1)),attrs:{}}; event.objects.push(object); }
    else if (line.startsWith('Its ')) { const match=/^Its ("(?:[^"\\]|\\.)*") is (.*)\.$/.exec(line); if (!match || !object) throw new Error('TEMPLATE_INVALID'); object.attrs[JSON.parse(match[1])]=JSON.parse(match[2]); }
    else if (line.startsWith('Relation ')) event.relations.push(JSON.parse(line.slice(9,-1)));
    else if (line==='End object.') object=undefined;
    else if (line==='End event.') event=undefined;
    else if (line!=='End family.') throw new Error('TEMPLATE_INVALID');
  }
  return family;
}
function protoEncode(family, method, prototypes) {
  const copy=structuredClone(family);
  for (const event of copy.events) for (const object of event.objects) {
    const base=prototypes.values[object.conceptId]; if (!base) throw new Error('UNKNOWN_CONCEPT');
    const codes=[], overrides=[];
    ATTRS.forEach((name,i)=>{
      const cell=object.attrs[name];
      if (cell.status==='observed_unknown') { codes.push(1); return; }
      let value=cell.value;
      const quantum=method.includes('_Q') && !(method.includes('_ANCHOR_') && ANCHORS.has(name)) ? QUANTUM[name] : undefined;
      if (quantum!==undefined && typeof value==='number') value=base[i]+Math.round((value-base[i])/quantum)*quantum;
      if (stable(value)===stable(base[i])) codes.push(2);
      else if (typeof value==='number' && typeof base[i]==='number') { codes.push(4); overrides.push([i,value-base[i]]); }
      else { codes.push(3); overrides.push([i,value]); }
    });
    delete object.attrs; object.packedAttrs={codes,overrides};
  }
  return copy;
}
function protoDecode(data, method, prototypes) {
  for (const event of data.events) for (const object of event.objects) {
    const base=prototypes.values[object.conceptId], {codes,overrides}=object.packedAttrs, values=new Map(overrides);
    if (!base || codes.length!==ATTRS.length) throw new Error('PROTOTYPE_INVALID');
    object.attrs=Object.fromEntries(ATTRS.map((name,i)=>{
      if (codes[i]===0) return [name,{status:'omitted'}];
      if (codes[i]===1) return [name,{status:'observed_unknown'}];
      const value=codes[i]===2 ? base[i] : codes[i]===3 ? values.get(i) : codes[i]===4 ? base[i]+values.get(i) : undefined;
      if (value===undefined) throw new Error('PROTOTYPE_CODE_INVALID');
      const quantum=method.includes('_Q') && !(method.includes('_ANCHOR_') && ANCHORS.has(name)) ? QUANTUM[name] : undefined;
      return [name,{status:'observed_value',value,fidelity:quantum===undefined ? 'exact' : 'quantized',maxAbsError:quantum===undefined ? 0 : quantum/2}];
    }));
    delete object.packedAttrs;
  }
  return data;
}
export function encodeFamily(family, method, prototypes) {
  if (!METHODS.includes(method)) throw new Error('METHOD_INVALID');
  validateFamily(family);
  let data=family;
  if (method==='TASK_SUBSET_ZSTD') {
    data=structuredClone(family);
    for (const event of data.events) for (const object of event.objects) for (const name of ATTRS) if (!KNOWN.has(name) && object.attrs[name].status!=='observed_unknown') object.attrs[name]={status:'omitted'};
  }
  if (method.startsWith('PROTO_')) data=protoEncode(family,method,prototypes);
  const raw=Buffer.from(method==='FULL_BOUND_TEMPLATE_ZSTD' ? templateEncode(data) : stable(data));
  if (raw.length>MAX_BYTES) throw new Error('ENCODED_SIZE_LIMIT');
  const bytes=zstdCompressSync(raw,{params:{[constants.ZSTD_c_compressionLevel]:3,[constants.ZSTD_c_checksumFlag]:1,[constants.ZSTD_c_nbWorkers]:0}});
  return {header:{version:'q0-envelope-1',method,profileHash,prototypeHash:method.startsWith('PROTO_') ? sha(stable(prototypes)) : null,familyId:family.familyId,rawBytes:raw.length,payloadBytes:bytes.length,payloadSha256:sha(bytes)},bytes};
}
export function decodeFamily(header, bytes, prototypes) {
  if (header.version!=='q0-envelope-1' || !METHODS.includes(header.method) || header.profileHash!==profileHash || header.payloadBytes!==bytes.length || header.payloadSha256!==sha(bytes)) throw new Error('ENVELOPE_MISMATCH');
  if (header.method.startsWith('PROTO_') && header.prototypeHash!==sha(stable(prototypes))) throw new Error('PROTOTYPE_MISMATCH');
  const raw=zstdDecompressSync(bytes,{maxOutputLength:MAX_BYTES});
  if (raw.length!==header.rawBytes) throw new Error('SIZE_MISMATCH');
  let data=header.method==='FULL_BOUND_TEMPLATE_ZSTD' ? templateDecode(raw.toString('utf8')) : JSON.parse(raw);
  if (header.method.startsWith('PROTO_')) data=protoDecode(data,header.method,prototypes);
  if (data.familyId!==header.familyId) throw new Error('FAMILY_MISMATCH');
  return data;
}
