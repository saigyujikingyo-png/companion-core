/** Mechanical packaging of the unchanged Opus ESM source for DSH's lazy-CJS
 * baseline. The target is public build data, never browser access to host config. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function renderClient(sessionId){
  if(typeof sessionId!=='string'||!uuid.test(sessionId))throw new Error('INVALID_OWNED_SESSION_ID');
  let source=await readFile(new URL('./src/client.opus.js',import.meta.url),'utf8');
  const replacements=[
    ["import { createElement as h } from 'react'", "const { createElement: h } = require('react')"],
    ["export const inject =", "const inject ="],
    ["export function apply(ctx, config)", "function apply(ctx, config)"]
  ];
  for(const [from,to] of replacements){
    if(source.split(from).length!==2)throw new Error('OPUS_SOURCE_SHAPE_CHANGED');
    source=source.replace(from,to);
  }
  return `window.__ModuleLoader__.load({\n  id: '@companion/dsh-session-opener',\n  factory: (require) => {\n    const module = { exports: {} };\n${source}\n    module.exports.inject = inject;\n    module.exports.apply = (ctx) => apply(ctx, { sessionId: ${JSON.stringify(sessionId)} });\n    return module.exports;\n  }\n});\n`;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const [sessionId,output,...extra]=process.argv.slice(2);
  if(!output||extra.length)throw new Error('USAGE_SESSION_ID_OUTPUT');
  await writeFile(output,await renderClient(sessionId),{flag:'wx'});
  process.stdout.write(JSON.stringify({status:'BUILT_PUBLIC_OWNED_SESSION_CLIENT',sessionId})+'\n');
}
