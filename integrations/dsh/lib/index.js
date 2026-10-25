import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { applyCoupledPlugin } from './plugin-runtime.js';

export const inject=['llm','agents','sessions'];
export async function apply(ctx,provided){
  await applyCoupledPlugin(ctx,provided,{LlmAdapter,createUserMessage});
}
