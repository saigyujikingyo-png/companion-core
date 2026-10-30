import { canonical, parseJson, shape, stop } from './wf1-json.ts';
import { CORPUS_PROFILE, CORPUS_PROFILE_DIGEST, validateHarvestSpec } from './corpus-types.ts';
import { harvestQualified, verifyCorpusManifest } from './corpus-manifest.ts';
import type { AdmissionPort, CorpusSelection, SelectedReader } from './corpus-types.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import type { CommitPort } from './corpus-manifest.ts';

export type CorpusCommandPorts = {
  admission: AdmissionPort;
  output: ArtifactPort;
  commits: CommitPort;
  selection?: CorpusSelection;
  reader?: SelectedReader;
  now?: () => number;
};
/** A host-bound CLI handler. Host launcher supplies narrow capabilities, never keys in stdin.
 * The frozen launcher may call this in a fresh Node process. stdout receives this safe result only. */
export function runCorpusCommand(raw: string, ports: CorpusCommandPorts) {
  const command = shape(parseJson(raw, { bytes: 16384, depth: 8, nodes: 128, stringBytes: 4096 }), [
    'version',
    'command',
    'spec',
  ]);
  if (command.version !== 'CorpusCommand/0.1') stop('CP0_COMMAND');
  if (command.command === 'describe') {
    if (command.spec !== null) stop('CP0_COMMAND');
    return { version: 'CorpusDescription/0.1', profile: CORPUS_PROFILE, profileDigest: CORPUS_PROFILE_DIGEST };
  }
  const spec = validateHarvestSpec(command.spec);
  if (command.command === 'harvest') {
    if (!ports.selection || !ports.reader) stop('CP0_READ_SCOPE');
    return harvestQualified(spec, { ...ports, selection: ports.selection, reader: ports.reader }).summary;
  }
  if (command.command === 'verify-manifest' || command.command === 'inspect') {
    const commit = ports.commits.load();
    if (!commit) stop('CP0_NOT_COMMITTED');
    // Verification does not open the original source or accept any dispatch capability.
    const verified = verifyCorpusManifest(spec, commit.manifestRef, {
      admission: ports.admission,
      reader: ports.output,
      commits: ports.commits,
      ...(ports.now ? { now: ports.now } : {}),
    });
    return verified.summary;
  }
  stop('CP0_COMMAND');
}
export function corpusCommandBytes(command: 'harvest' | 'verify-manifest' | 'inspect', spec: unknown): string {
  return canonical({ version: 'CorpusCommand/0.1', command, spec: validateHarvestSpec(spec) });
}
