// Development checks only. Does not create heldout seeds, queries or quality scores.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {makeFamilies,learnPrototypes,stable,sha,ATTRS} from './scene.mjs';
import {encodeFamily,decodeFamily,METHODS} from './codec.mjs';
import {writeArchive,readArchiveFamily} from './archive.mjs';
const here=dirname(fileURLToPath(import.meta.url)), started=performance.now(), checks=[];
const receipt={stage:'DEVELOPMENT_ONLY',utc:new Date().toISOString(),node:process.version,zstdVersion:process.versions.zstd,freeRAMMiB:Math.floor(os.freemem()/1048576),checks,formalRun:'NOT_STARTED',heldoutGenerated:false,realModelCalls:0,gpuUsed:false};
let receiptPath;
try {
  if (receipt.freeRAMMiB<2048) throw new Error('RESOURCE_ADMISSION_REFUSED');
  if (process.argv.length>3) throw new Error('Usage: node dev-check.mjs [NEW_OUTPUT_DIRECTORY]');
  let output;
  if (process.argv[2]) { output=resolve(process.argv[2]); if (existsSync(output)) throw new Error('OUTPUT_ALREADY_EXISTS'); mkdirSync(output,{recursive:false}); }
  else output=mkdtempSync(join(os.tmpdir(),'aemc-q0-development-'));
  receipt.runtimeArtifactDirectory=output;
  receiptPath=join(output,'receipt.json');
  const config=JSON.parse(readFileSync(join(here,'protocol.json'),'utf8'));
  const families=makeFamilies(config.development.seed,config.development.families), prototypes=learnPrototypes(families);
  assert.equal(stable(prototypes),stable(JSON.parse(readFileSync(join(here,'development','prototypes.json'),'utf8'))),'Frozen development prototype mismatch');
  const development=output;
  for (const [name,value] of [['observations.json',families],['prototypes.json',prototypes]]) {
    const path=join(development,name), bytes=stable(value)+'\n';
    if (existsSync(path)) assert.equal(readFileSync(path,'utf8'),bytes,'Existing development asset cannot be silently replaced');
    else writeFileSync(path,bytes,{flag:'wx'});
  }
  for (const method of METHODS) {
    let boundChecks=0;
    for (const family of families) {
      const encoded=encodeFamily(family,method,prototypes), decoded=decodeFamily(encoded.header,encoded.bytes,prototypes);
      if (['FULL_JSON_ZSTD','FULL_BOUND_TEMPLATE_ZSTD','PROTO_DELTA_LOSSLESS_ZSTD'].includes(method)) assert.equal(stable(decoded),stable(family));
      family.events.forEach((event,t)=>{
        assert.equal(stable(decoded.events[t].relations),stable(event.relations));
        event.objects.forEach((object,o)=>{
          const result=decoded.events[t].objects[o];
          for (const key of ['objectId','trackId','conceptId','sourceRef']) assert.equal(result[key],object[key]);
          for (const name of ATTRS) {
            const original=object.attrs[name], actual=result.attrs[name];
            if (method==='TASK_SUBSET_ZSTD' && !config.knownAttributes.includes(name) && original.status!=='observed_unknown') assert.deepEqual(actual,{status:'omitted'});
            else if (original.status==='observed_unknown') assert.deepEqual(actual,original);
            else if (actual.fidelity==='quantized') { assert.ok(Math.abs(actual.value-original.value)<=actual.maxAbsError); boundChecks++; }
            else assert.deepEqual(actual,original);
            if (method==='PROTO_DELTA_Q_ANCHOR_ZSTD' && config.hardAnchors.includes(name)) assert.deepEqual(actual,original);
          }
        });
      });
    }
    checks.push({name:method+' development roundtrip/binding/status/bounds',families:families.length,quantizedBoundsChecked:boundChecks,status:'PASS'});
  }
  const family=structuredClone(families[0]);
  family.events[0].objects[0].attrs.label={status:'observed_value',value:'quote "x"\n雪\\',fidelity:'exact',maxAbsError:0};
  for (const method of ['FULL_JSON_ZSTD','FULL_BOUND_TEMPLATE_ZSTD','PROTO_DELTA_LOSSLESS_ZSTD']) {
    const first=encodeFamily(family,method,prototypes), second=encodeFamily(family,method,prototypes);
    assert.deepEqual(first.bytes,second.bytes); assert.equal(stable(decodeFamily(first.header,first.bytes,prototypes)),stable(family));
  }
  checks.push({name:'escaped strings and deterministic compression',status:'PASS'});
  const first=encodeFamily(family,'PROTO_DELTA_LOSSLESS_ZSTD',prototypes);
  assert.throws(()=>decodeFamily({...first.header,profileHash:'bad'},first.bytes,prototypes),/ENVELOPE_MISMATCH/);
  const wrong=structuredClone(prototypes); wrong.values.vessel[0]='incorrect';
  assert.throws(()=>decodeFamily(first.header,first.bytes,wrong),/PROTOTYPE_MISMATCH/);
  const bad=Buffer.from(first.bytes); bad[bad.length-1]^=1;
  assert.throws(()=>decodeFamily(first.header,bad,prototypes),/ENVELOPE_MISMATCH/);
  assert.throws(()=>decodeFamily({...first.header,payloadSha256:sha(bad)},bad,prototypes));
  checks.push({name:'profile/prototype/hash/checksum mismatch rejection',status:'PASS'});
  let changedRelations=0;
  for (const item of families) for (const event of item.events) for (const relation of event.relations) {
    const reverse=event.relations.find(r=>r.subjectId===relation.objectId&&r.objectId===relation.subjectId&&r.predicate===relation.predicate);
    if (relation.status==='observed_value'&&reverse.status==='observed_value') assert.equal(relation.value,relation.predicate==='near' ? reverse.value : !reverse.value);
    const initial=item.events[0].relations.find(r=>r.subjectId===relation.subjectId&&r.objectId===relation.objectId&&r.predicate===relation.predicate);
    if (relation.status==='observed_value'&&initial.status==='observed_value'&&relation.value!==initial.value) changedRelations++;
  }
  assert.ok(changedRelations>0); checks.push({name:'random changing relations, antisymmetric left_of and symmetric near',status:'PASS',changedRelations});
  const archive=join(development,'smoke-archive');
  const cost=writeArchive(families.slice(0,2),'PROTO_DELTA_LOSSLESS_ZSTD',archive,prototypes);
  for (const item of families.slice(0,2)) assert.equal(stable(readArchiveFamily(archive,item.familyId)),stable(item));
  assert.ok(cost.archiveBytes>cost.payloadBytes+cost.headerBytes); assert.ok(cost.runtimeExecutableBytes>0);
  checks.push({name:'real standard directory/reader roundtrip and non-payload cost',status:'PASS',archiveBytes:cost.archiveBytes});
  receipt.status='PASS'; receipt.developmentFamilies=families.length; receipt.prototypeSha256=sha(stable(prototypes)+'\n');
} catch(error) { receipt.status='FAIL'; receipt.error={name:error.name,message:error.message,stack:error.stack}; process.exitCode=1; }
receipt.elapsedMs=performance.now()-started; receipt.observedRSSMiB=Math.ceil(process.memoryUsage().rss/1048576);
receipt.sourceHashes=Object.fromEntries(['protocol.json','scene.mjs','codec.mjs','archive.mjs','dev-check.mjs'].map(name=>[name,sha(readFileSync(join(here,name)))]));
if (receiptPath) writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({...receipt,receiptPath})+'\n');
