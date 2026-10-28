import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { COHORT } from './cohort.ts';
import { createSyntheticFixture } from './fixture.ts';
import { compareSyntheticQuery } from './driver.ts';
import { evaluateOrdinals, summarize } from './evaluate.ts';

// Explicit operator-run only, after independent review freezes the two hashes.
// Author mechanism tests must never import or execute this module.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const files=[...readdirSync(join(root,'src')).filter(f=>f.endsWith('.ts')).map(f=>`src/${f}`),
  ...readdirSync(join(root,'research/retrieval-baseline')).filter(f=>f.endsWith('.ts')&&f!=='cohort.ts')
    .map(f=>`research/retrieval-baseline/${f}`),'test/research-bm25.test.ts','package-lock.json','tsconfig.json'].sort();
const sources=files.map(path=>({path,sha256:sha(readFileSync(join(root,path)))}));
const sourceSha256=sha(sources.map(s=>`${s.path}\0${s.sha256}\n`).join(''));
const cohortSha256=sha(readFileSync(join(root,'research/retrieval-baseline/cohort.ts')));
const expected=[`--source-sha256=${sourceSha256}`,`--cohort-sha256=${cohortSha256}`];
if(process.argv.length!==5||process.argv[2]!=='--run'||!expected.every(arg=>process.argv.includes(arg)))
  throw Error('FORMAL_RUN_REQUIRES_REVIEWED_SOURCE_AND_COHORT_HASHES');
if(!process.execArgv.includes('--max-old-space-size=128'))throw Error('RESEARCH_HEAP_FLAG_REQUIRED');
const temporary=realpathSync.native(tmpdir());
if(process.platform!=='win32'||!process.env.LOCALAPPDATA||
  temporary.toLowerCase()!==realpathSync.native(join(process.env.LOCALAPPDATA,'Temp')).toLowerCase()||
  !process.env.TEMP||!process.env.TMP||
  realpathSync.native(process.env.TEMP).toLowerCase()!==temporary.toLowerCase()||
  realpathSync.native(process.env.TMP).toLowerCase()!==temporary.toLowerCase())throw Error('NATIVE_TEMP_REQUIRED');
const started=performance.now();
const checkResources=()=>{
  if(performance.now()-started>60_000)throw Error('RESEARCH_DEADLINE');
  if(process.resourceUsage().maxRSS>256*1024)throw Error('RESEARCH_RSS_LIMIT');
};
if(COHORT.length!==8||COHORT.some(f=>f.queries.length!==2))throw Error('COHORT_SHAPE_CHANGED');
const rows=[];
for(const family of COHORT) {
  checkResources();const fixture=createSyntheticFixture(family.documents);
  try {
    for(const gold of family.queries) {
      checkResources();const result=compareSyntheticQuery(fixture,gold.text);
      const ar0=evaluateOrdinals(family,gold,result.ar0.map(hit=>hit.ordinal));
      const bm25=evaluateOrdinals(family,gold,result.bm25.map(hit=>hit.ordinal));
      rows.push({family:family.id,query:gold.id,text:gold.text,gold,ar0:{hits:result.ar0,metrics:ar0},
        bm25:{hits:result.bm25,metrics:bm25},budget:result.budget});
    }
  } finally {fixture.close();}
}
checkResources();
console.log(JSON.stringify({status:'SYNTHETIC_COMPARISON_ONLY',sourceSha256,cohortSha256,sources,
  protocol:{families:8,queries:16,seed:'fixed-no-random-sampling',ordinalOrder:'fixture-publication-order-for-both',
    k1:1.2,b:0.75,N:'all-documents-including-empty',queryTerms:'unique',realModelCalls:0,
    embedding:'NOT_EVALUATED',PPR:'NOT_EVALUATED',model:'NOT_EVALUATED',learning:'NOT_EVALUATED',Spark:'NOT_EVALUATED'},
  limits:{selected:32,nodes:128,edges:512,serializedBytes:262144,heapFlagMiB:128,maxRssMiB:256,deadlineMs:60000},
  runtime:{node:process.version,platform:process.platform,tmpdir:temporary,elapsedMs:performance.now()-started,maxRssKiB:process.resourceUsage().maxRSS},
  summary:{ar0:summarize(rows.map(row=>row.ar0.metrics)),bm25:summarize(rows.map(row=>row.bm25.metrics))},rows,
  interpretation:'Sixteen synthetic queries do not establish general superiority. Empty candidates are not real abstention quality. Shared roots are not independent evidence.'},null,2));
