import { readFileSync } from 'node:fs';
import { hash } from './wf1-json.ts';
/** Complete runtime closure for both the persistent worker and its separate cold inspector. */
export const TEACHER_WORKER_FILES = [
  'wf2-teacher-worker.ts',
  'wf2-teacher-service.ts',
  'wf2-teacher-policy.ts',
  'wf2-teacher-build.ts',
  'wf2-teacher-inspect.ts',
  'wf2-strict-data.ts',
  'wf2-fixed-slots.ts',
  'wf2-named-data.ts',
  'wf2-together-pilot.ts',
  'wf2-unit-pilot.ts',
  'wf2-response-diagnostic.ts',
  'wf2-failure-diagnostic.ts',
  'wf2-training-root.ts',
  'wf1-types.ts',
  'wf1-json.ts',
  'wf1-contract.ts',
  'wf1-verifier.ts',
  'wf1-storage.ts',
  'wf1-provider.ts',
  'wf1-usage-diagnostic.ts',
  'corpus-response-policy.ts',
  'wf1-campaign.ts',
  'runtime.ts',
  'validation.ts',
] as const;
export function teacherWorkerBuildDigest(): string {
  return hash(
    Buffer.concat(
      TEACHER_WORKER_FILES.flatMap((name) => [Buffer.from(name + '\0'), readFileSync(new URL(name, import.meta.url))]),
    ),
  );
}
