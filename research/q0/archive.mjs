// Research-only standard directory archive. No production/authentication guarantees.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFamily, decodeFamily, profile, profileHash, METHODS } from './codec.mjs';
import { stable, sha } from './scene.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const put=(path,value)=>writeFileSync(path,typeof value==='string'||Buffer.isBuffer(value) ? value : stable(value)+'\n',{flag:'wx'});
export function writeArchive(families, method, destination, prototypes) {
  if (!METHODS.includes(method) || !Array.isArray(families) || families.length<1 || families.length>600 || existsSync(destination)) throw new Error('ARCHIVE_ARGUMENT');
  if (new Set(families.map(f=>f.familyId)).size!==families.length) throw new Error('DUPLICATE_FAMILY');
  mkdirSync(destination,{recursive:false});
  const index={version:'q0-index-1',entries:[]};
  let payloadBytes=0,headerBytes=0;
  for (let i=0;i<families.length;i++) {
    const encoded=encodeFamily(families[i],method,prototypes), stem=String(i).padStart(6,'0');
    put(join(destination,stem+'.zst'),encoded.bytes);
    put(join(destination,stem+'.header.json'),encoded.header);
    payloadBytes+=encoded.bytes.length; headerBytes+=statSync(join(destination,stem+'.header.json')).size;
    index.entries.push({familyId:families[i].familyId,payload:stem+'.zst',header:stem+'.header.json'});
  }
  put(join(destination,'index.json'),index); put(join(destination,'profile.json'),profile);
  if (method.startsWith('PROTO_')) put(join(destination,'prototypes.json'),prototypes);
  for (const name of ['codec.mjs','scene.mjs','archive.mjs']) put(join(destination,name),readFileSync(join(here,name)));
  const runtime={name:'Node.js',version:process.version,platform:process.platform,arch:process.arch,executableBytes:statSync(process.execPath).size,executableSha256:sha(readFileSync(process.execPath)),zstdVersion:process.versions.zstd,retention:'external required runtime; byte cost reported, executable not copied into archive'};
  put(join(destination,'runtime-dependency.json'),runtime);
  const manifest={version:'q0-directory-1',logicalSchema:'q0-scene-1',method,profileHash,prototypeHash:method.startsWith('PROTO_')?sha(stable(prototypes)):null,families:families.length,events:families.length*4,objectObservations:families.length*12,index:'index.json',contentAuthority:'SYNTHETIC_DECLARED_NOT_AUTHENTICATED',readerSafety:'TRUSTED_RESEARCH_ASSETS_ONLY',files:readdirSync(destination).sort().map(name=>({name,bytes:statSync(join(destination,name)).size,sha256:sha(readFileSync(join(destination,name)))}))};
  put(join(destination,'manifest.json'),manifest);
  const archiveBytes=readdirSync(destination).reduce((total,name)=>total+statSync(join(destination,name)).size,0);
  const coldOriginalCanonicalBytes=Buffer.byteLength(stable(families)+'\n');
  return {method,families:families.length,objectObservations:families.length*12,payloadBytes,headerBytes,metadataProfileReaderBytes:archiveBytes-payloadBytes-headerBytes,archiveBytes,archiveBytesPerObjectObservation:archiveBytes/(families.length*12),coldOriginalCanonicalBytes,runtimeExecutableBytes:runtime.executableBytes,archivePlusRuntimePlusColdOriginalBytes:archiveBytes+runtime.executableBytes+coldOriginalCanonicalBytes,standaloneAuditToolingBytes:'EVALUATOR_MUST_ADD_PROTOCOL_CLI_ORACLE_RESULTS_RETENTION',filesystemAllocationAndOSBytes:'NOT_MEASURED',budgets:Object.fromEntries([128,256,512].map(b=>[b,archiveBytes<=b*families.length*12]))};
}
export function readArchiveFamily(directory,familyId) {
  const index=JSON.parse(readFileSync(join(directory,'index.json'),'utf8'));
  const entry=index.entries.find(item=>item.familyId===familyId); if (!entry) throw new Error('FAMILY_NOT_IN_INDEX');
  const prototypes=existsSync(join(directory,'prototypes.json')) ? JSON.parse(readFileSync(join(directory,'prototypes.json'),'utf8')) : undefined;
  return decodeFamily(JSON.parse(readFileSync(join(directory,entry.header),'utf8')),readFileSync(join(directory,entry.payload)),prototypes);
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,method,output]=process.argv.slice(2);
  if (!input || !method || !output) throw new Error('Usage: node archive.mjs observations.json METHOD NEW_OUTPUT_DIRECTORY');
  if (statSync(input).size>16*1024*1024) throw new Error('INPUT_LIMIT');
  const prototypes=JSON.parse(readFileSync(join(here,'development','prototypes.json'),'utf8'));
  const result=writeArchive(JSON.parse(readFileSync(input,'utf8')),method,output,prototypes);
  process.stdout.write(stable(result)+'\n');
}
