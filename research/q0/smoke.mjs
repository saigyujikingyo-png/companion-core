// Tiny read-only CI candidate; never performs the heldout quality experiment.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeFamilies,stable} from './scene.mjs';
import {encodeFamily,decodeFamily,METHODS} from './codec.mjs';
const prototypes=JSON.parse(readFileSync(new URL('./development/prototypes.json',import.meta.url),'utf8'));
const family=makeFamilies(1193046,1)[0];
family.events[0].objects[0].attrs.label={status:'observed_unknown'};
family.events[0].objects[0].attrs.crack_mm={status:'observed_value',value:0.25,fidelity:'exact',maxAbsError:0};
family.events[0].objects[0].attrs.serial_tag={status:'observed_value',value:'rare "tag"\n雪',fidelity:'exact',maxAbsError:0};
for (const method of METHODS) {
  const {header,bytes}=encodeFamily(family,method,prototypes), copy=decodeFamily(header,bytes,prototypes);
  if (['FULL_JSON_ZSTD','FULL_BOUND_TEMPLATE_ZSTD','PROTO_DELTA_LOSSLESS_ZSTD'].includes(method)) assert.equal(stable(copy),stable(family));
  assert.deepEqual(copy.events[0].objects[0].attrs.label,{status:'observed_unknown'});
  assert.equal(copy.events[0].objects[0].sourceRef,family.events[0].objects[0].sourceRef);
  if (method==='PROTO_DELTA_Q_ANCHOR_ZSTD') for (const name of ['crack_mm','serial_tag','dose_mg']) assert.deepEqual(copy.events[0].objects[0].attrs[name],family.events[0].objects[0].attrs[name]);
  assert.throws(()=>decodeFamily({...header,profileHash:'wrong'},bytes,prototypes),/ENVELOPE_MISMATCH/);
}
process.stdout.write('Q0_SMOKE_PASS methods=6 family=1 heldout=0 modelCalls=0\n');
