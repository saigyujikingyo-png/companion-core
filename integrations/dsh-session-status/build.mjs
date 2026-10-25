/** Mechanical SDK packaging; frontend logic remains the recorded Opus source. */
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export async function renderStatusClient(sessionId) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('INVALID_OWNED_SESSION_ID');
  let source = await readFile(new URL('./src/client.opus.js', import.meta.url), 'utf8');
  for (const [from,to] of [
    ["import { createElement as h, useState, useRef, useEffect, useSyncExternalStore } from 'react';", "const {createElement:h,useState,useRef,useEffect,useSyncExternalStore}=require('react');"],
    ['export const inject =','const inject ='],
    ['export function apply(ctx, config)','function apply(ctx, config)']
  ]) {
    if(source.split(from).length!==2)throw new Error('OPUS_SOURCE_SHAPE_CHANGED');
    source=source.replace(from,to);
  }
  return `window.__ModuleLoader__.load({id:'@companion/dsh-session-status',factory:(require)=>{\n${source}\nreturn {inject,apply:(ctx)=>apply(ctx,{sessionId:${JSON.stringify(sessionId)}})};}});\n`;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const [sid,out,...extra]=process.argv.slice(2);
  if(!out||extra.length)throw new Error('USAGE_SESSION_ID_OUTPUT');
  await writeFile(out,await renderStatusClient(sid),{flag:'wx'});
  process.stdout.write(JSON.stringify({status:'BUILT_PUBLIC_SESSION_STATUS_CLIENT',sessionId:sid})+'\n');
}
