import { isAbsolute, relative, sep } from 'node:path';
import { canonical, hash, stop, text } from './wf1-json.ts';
import { privateRoot } from './wf1-storage.ts';

/** A deployment supplies the approved root privately. No environment discovery, defaults or fallback. */
export function bindTrainingRoot(approvedInput: unknown, runtimeInput: unknown) {
  const approvedTrainingRoot = privateRoot(text(approvedInput, 4096)),
    runtimeRoot = privateRoot(text(runtimeInput, 4096)),
    rel = relative(approvedTrainingRoot, runtimeRoot);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) stop('WF2_TRAINING_ROOT');
  return {
    approvedTrainingRoot,
    runtimeRoot,
    storageBindingDigest: hash(canonical({ version: 'wf2-training-root/1', approvedTrainingRoot, runtimeRoot })),
  };
}
export function requireTrainingBinding(
  approved: unknown,
  runtime: unknown,
  expected: unknown,
  authorityPath?: string,
): ReturnType<typeof bindTrainingRoot> {
  const bound = bindTrainingRoot(approved, runtime);
  if (bound.storageBindingDigest !== expected) stop('WF2_STORAGE_BINDING');
  if (authorityPath !== undefined) {
    const rel = relative(bound.approvedTrainingRoot, authorityPath);
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) stop('WF2_AUTHORITY_IN_TRAINING_ROOT');
  }
  return bound;
}
