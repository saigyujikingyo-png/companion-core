import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { posix } from 'node:path';
import ts from 'typescript';
import { TEACHING_CYCLE_BUILD_FILES,teachingCycleBuildDigest } from '../src/teaching-cycle-build.ts';
test('teaching source pin covers every transitive local import and executed worker',()=>{
  const files=new Set<string>(),pending=['src/teaching-cycle-runner.ts','src/teaching-cycle-store.ts','src/teaching-cycle-types.ts','src/corpus-resource-scheduler.ts'];
  while(pending.length){const file=pending.pop()!;if(files.has(file))continue;files.add(file);const ast=ts.createSourceFile(file,fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);const visit=(node:ts.Node)=>{let target:string|undefined;if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))target=node.moduleSpecifier.text;if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))target=node.arguments[0].text;if(target?.startsWith('.'))pending.push(posix.normalize(posix.join(posix.dirname(file),target)));ts.forEachChild(node,visit);};visit(ast);}
  files.add('workers/corpus/tokenizer-batch.py');files.add('workers/corpus/tokenizer.py');assert.deepEqual([...TEACHING_CYCLE_BUILD_FILES],[...files].sort());
});
test('changed execution, scheduler, cycle or tokenizer bytes change the teaching build identity',()=>{
  const original=fs.readFileSync,before=teachingCycleBuildDigest();for(const file of ['src/corpus-execution.ts','src/corpus-resource-scheduler.ts','src/teaching-cycle-store.ts','src/teaching-cycle-types.ts','src/teaching-cycle-runner.ts','workers/corpus/tokenizer-batch.py']){
    fs.readFileSync=((path:any,...args:any[])=>{const data=(original as any)(path,...args);return String(path).endsWith(file)?Buffer.concat([data,Buffer.from('\n# SYNTHETIC mutation')]):data;}) as typeof fs.readFileSync;syncBuiltinESMExports();try{assert.notEqual(teachingCycleBuildDigest(),before,file);}finally{fs.readFileSync=original;syncBuiltinESMExports();}
  }
});
