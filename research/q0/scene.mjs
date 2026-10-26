// Synthetic development/generation support, not a perception model or a truth reader.
import { createHash } from 'node:crypto';
export const ATTRS = ['color','material','location','mass_g','temperature_c','orientation_deg','capacity_ml','texture','label','crack_mm','serial_tag','dose_mg'];
export const CONCEPTS = {
  vessel: ['white','ceramic','shelf',200,20,0,250,'smooth','plain',0,null,0],
  tool: ['gray','steel','drawer',400,20,0,0,'rough','plain',0,null,0],
  container: ['blue','plastic','table',100,20,0,500,'smooth','plain',0,null,0]
};
export function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
}
export const sha = value => createHash('sha256').update(value).digest('hex');
export function rng(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let x = state; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
export function makeFamilies(seed, count) {
  if (!Number.isSafeInteger(seed) || seed<0 || seed>0xffffffff || !Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('GENERATOR_LIMIT');
  const random = rng(seed), pick = values => values[Math.floor(random()*values.length)];
  let idCount = 0;
  const id = prefix => prefix + '-' + sha(String(seed) + ':' + idCount++ + ':' + random()).slice(0,20);
  const families = [];
  for (let f=0; f<count; f++) {
    const family = { logicalSchema:'q0-scene-1', namespace:'q0-synthetic', familyId:id('f'), domain:['desk','workbench','room'][f%3], events:[] };
    const objects = Object.entries(CONCEPTS).map(([conceptId, values]) => ({ objectId:id('o'), trackId:id('t'), conceptId, values:[...values] }));
    for (let t=0; t<4; t++) {
      const event = { eventId:id('e'), timeTick:t*10, objects:[], relations:[] };
      const positions=[];
      while (positions.length<3) { const position=Math.floor(random()*101); if (!positions.includes(position)) positions.push(position); }
      for (const object of objects) {
        const values = object.values;
        if (random()<0.35) values[0]=pick(['white','red','blue','green','black']);
        if (random()<0.10) values[1]=pick(['ceramic','steel','plastic','wood']);
        if (random()<0.35) values[2]=pick(['shelf','drawer','table','floor']);
        if (random()<0.25) values[3]=Math.max(1, values[3]+pick([-7,-3,1,5,11]));
        if (random()<0.25) values[4]=pick([17,19,20,23,27,31]);
        if (random()<0.25) values[5]=pick([0,13,37,91,179,271,359]);
        if (random()<0.15) values[6]=pick([0,125,251,503,1001]);
        if (random()<0.15) values[7]=pick(['smooth','rough','ribbed']);
        if (random()<0.15) values[8]=pick(['plain','red label','line\nbreak','quote "A"','snow 雪']);
        if (random()<0.08) values[9]=pick([0,0.25,0.5,1.5,2]);
        if (random()<0.08) values[10]=random()<0.25 ? null : id('tag');
        if (random()<0.08) values[11]=pick([0,0.25,0.5,2,5]);
        const attrs = Object.fromEntries(ATTRS.map((name,i) => [name, random()<0.06 ? {status:'observed_unknown'} : {status:'observed_value',value:values[i],fidelity:'exact',maxAbsError:0}]));
        event.objects.push({ objectId:object.objectId,trackId:object.trackId,conceptId:object.conceptId,sourceRef:id('s'),attrs });
      }
      for (let a=0; a<3; a++) for (let b=0; b<3; b++) if (a!==b) {
        for (const predicate of ['left_of','near']) {
          const base = {subjectId:objects[a].objectId,predicate,objectId:objects[b].objectId,sourceRef:id('r')};
          event.relations.push(random()<0.04 ? {...base,status:'observed_unknown'} : {...base,status:'observed_value',value:predicate==='left_of' ? positions[a] < positions[b] : Math.abs(positions[a]-positions[b])<=25,fidelity:'exact',maxAbsError:0});
        }
      }
      family.events.push(event);
    }
    families.push(family);
  }
  return families;
}
export function learnPrototypes(families) {
  const modes = Object.fromEntries(Object.keys(CONCEPTS).map(c => [c,ATTRS.map(()=>new Map())]));
  for (const family of families) for (const event of family.events) for (const object of event.objects) {
    ATTRS.forEach((name,i) => { const cell=object.attrs[name]; if (cell.status==='observed_value') { const key=stable(cell.value), values=modes[object.conceptId][i]; values.set(key,(values.get(key)??0)+1); } });
  }
  return {version:'q0-prototype-1',learnedFrom:'development-observations-only',values:Object.fromEntries(Object.entries(modes).map(([concept, maps]) => [concept,maps.map((map,i) => { const order=[...map].sort((a,b)=>b[1]-a[1] || (a[0]<b[0] ? -1 : a[0]>b[0] ? 1 : 0)); return order.length ? JSON.parse(order[0][0]) : CONCEPTS[concept][i]; })]))};
}
