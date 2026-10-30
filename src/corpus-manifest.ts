import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artifactRef } from './wf1-contract.ts';
import { canonical, copyJson, digest, hash, parseJson, shape, stop } from './wf1-json.ts';
import { createArtifactBroker } from './wf1-storage.ts';
import type { ArtifactPort } from './wf1-storage.ts';
import type { ArtifactRef } from './wf1-types.ts';
import { requireTrainingBinding } from './wf2-training-root.ts';
import { collectEvidence, validateSelection, verifySelectedEvidence } from './corpus-harvest.ts';
import { CORPUS_PROFILE_DIGEST, requireAdmission, validateHarvestSpec } from './corpus-types.ts';
import type {
  AdmissionPort,
  CorpusHarvestSpec,
  CorpusManifest,
  CorpusRow,
  CorpusSelection,
  SelectedReader,
} from './corpus-types.ts';

export type CorpusCommit = { version: 'CorpusCommit/0.1'; specDigest: string; manifestRef: ArtifactRef };
export type CommitPort = { load: () => CorpusCommit | null; commit: (record: CorpusCommit) => void };
export type CorpusSummary = {
  version: 'CorpusSummary/0.1';
  status: 'HARVESTED_TOKENIZATION_PENDING';
  verification: 'VERIFIED';
  rows: 1;
  train: 0 | 1;
  dev: 0 | 1;
  reusedQualified: 1;
  generatedNew: 0;
  evidenceClass: 'EXACT_VERIFIED';
  dataGateAccepted: true;
  trainingJobPolicy: 'NOT_AUTHORIZED';
  trainingReady: false;
  studentInputTokens: null;
  studentLossTokens: null;
  tokenizerProfileDigest: null;
  measurementStatus: 'TOKENIZER_NOT_PINNED';
  trustClass: CorpusManifest['trustClass'];
  idempotent: boolean;
};
type VerifyPorts = {
  admission: AdmissionPort;
  reader: SelectedReader;
  commits: Pick<CommitPort, 'load'>;
  now?: () => number;
};
function readKind(reader: SelectedReader, input: ArtifactRef, kind: string): Buffer {
  const ref = artifactRef(copyJson(input));
  if (ref.partition !== 'train' || ref.kind !== kind) stop('CP0_MANIFEST');
  const bytes = reader.read(ref);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 262144) stop('CP0_BYTES');
  return bytes;
}
function decode(bytes: Buffer) {
  return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function summary(m: CorpusManifest, idempotent = false): CorpusSummary {
  return {
    version: 'CorpusSummary/0.1',
    status: m.status,
    verification: 'VERIFIED',
    rows: 1,
    train: Number(m.splitCounts.train) as 0 | 1,
    dev: Number(m.splitCounts.dev) as 0 | 1,
    reusedQualified: 1,
    generatedNew: 0,
    evidenceClass: 'EXACT_VERIFIED',
    dataGateAccepted: true,
    trainingJobPolicy: 'NOT_AUTHORIZED',
    trainingReady: false,
    studentInputTokens: null,
    studentLossTokens: null,
    tokenizerProfileDigest: null,
    measurementStatus: 'TOKENIZER_NOT_PINNED',
    trustClass: m.trustClass,
    idempotent,
  };
}
function makeManifest(
  spec: CorpusHarvestSpec,
  row: CorpusRow,
  evidenceRef: ArtifactRef,
  shardRef: ArtifactRef,
  trustClass: CorpusManifest['trustClass'],
): CorpusManifest {
  return {
    version: 'CorpusManifest/0.1',
    runId: spec.runId,
    profileDigest: CORPUS_PROFILE_DIGEST,
    spec,
    evidenceRef,
    shardRef,
    logicalRowsDigest: hash(canonical(row) + '\n'),
    rows: '1',
    splitCounts: { train: row.split === 'train' ? '1' : '0', dev: row.split === 'dev' ? '1' : '0' },
    reusedQualified: '1',
    generatedNew: '0',
    dataGateAccepted: true,
    trainingJobPolicy: 'NOT_AUTHORIZED',
    trainingReady: false,
    status: 'HARVESTED_TOKENIZATION_PENDING',
    tokenizerProfileDigest: null,
    studentInputTokens: null,
    studentLossTokens: null,
    measurementStatus: 'TOKENIZER_NOT_PINNED',
    trustClass,
  };
}
function verifyManifestObjects(
  specInput: unknown,
  manifestRef: ArtifactRef,
  ports: Omit<VerifyPorts, 'commits'>,
): { manifest: CorpusManifest; row: CorpusRow; summary: CorpusSummary } {
  const spec = validateHarvestSpec(specInput),
    check = () => requireAdmission(spec, ports.admission, 'verify', ports.now?.() ?? Date.now()),
    admission = check();
  const guarded: SelectedReader = {
    read: (r) => {
      check();
      const bytes = ports.reader.read(r);
      check();
      return bytes;
    },
  };
  const raw = decode(readKind(guarded, manifestRef, 'corpus-manifest')),
    m = shape(raw, [
      'version',
      'runId',
      'profileDigest',
      'spec',
      'evidenceRef',
      'shardRef',
      'logicalRowsDigest',
      'rows',
      'splitCounts',
      'reusedQualified',
      'generatedNew',
      'dataGateAccepted',
      'trainingJobPolicy',
      'trainingReady',
      'status',
      'tokenizerProfileDigest',
      'studentInputTokens',
      'studentLossTokens',
      'measurementStatus',
      'trustClass',
    ]);
  if (canonical(m.spec) !== canonical(spec)) stop('CP0_MANIFEST');
  const evidenceRef = artifactRef(m.evidenceRef),
    evidence = decode(readKind(guarded, evidenceRef, 'corpus-evidence'));
  const selection = validateSelection(shape(evidence, ['version', 'selection', 'artifacts']).selection);
  if (hash(canonical(selection)) !== spec.selectionDigest || selection.sourceCampaignId === spec.runId)
    stop('CP0_SOURCE');
  if ((selection.transportLane === 'SYNTHETIC_FIXTURE') !== (admission.trustClass === 'SYNTHETIC_FIXTURE'))
    stop('CP0_TRUST_CLASS');
  const row: CorpusRow = { ...verifySelectedEvidence(evidence), evidenceRef },
    shardRef = artifactRef(m.shardRef),
    shard = readKind(guarded, shardRef, 'corpus-jsonl');
  // Canonical one-line export excludes reviewer notes, reasoning, source metadata and plan text from the selected loss target.
  if (!shard.equals(Buffer.from(canonical(row) + '\n'))) stop('CP0_SHARD');
  const manifest = makeManifest(spec, row, evidenceRef, shardRef, admission.trustClass);
  if (canonical(raw) !== canonical(manifest)) stop('CP0_MANIFEST');
  check();
  return { manifest, row, summary: summary(manifest) };
}
export function verifyCorpusManifest(specInput: unknown, manifestRef: ArtifactRef, ports: VerifyPorts) {
  const spec = validateHarvestSpec(specInput);
  requireAdmission(spec, ports.admission, 'verify', ports.now?.() ?? Date.now());
  const commit = validateCommit(ports.commits.load());
  if (
    commit.specDigest !== hash(canonical(spec)) ||
    canonical(commit.manifestRef) !== canonical(artifactRef(copyJson(manifestRef)))
  )
    stop('CP0_NOT_COMMITTED');
  const result = verifyManifestObjects(spec, manifestRef, ports);
  if (canonical(ports.commits.load()) !== canonical(commit)) stop('CP0_COMMIT_UNKNOWN');
  return result;
}
export function harvestQualified(
  specInput: unknown,
  ports: {
    selection: CorpusSelection;
    reader: SelectedReader;
    admission: AdmissionPort;
    output: ArtifactPort;
    commits: CommitPort;
    now?: () => number;
  },
) {
  const spec = validateHarvestSpec(specInput),
    check = () => requireAdmission(spec, ports.admission, 'harvest', ports.now?.() ?? Date.now());
  check();
  const selection = validateSelection(ports.selection);
  if (hash(canonical(selection)) !== spec.selectionDigest || selection.sourceCampaignId === spec.runId)
    stop('CP0_SOURCE');
  const old = ports.commits.load();
  if (old) {
    const commit = validateCommit(old);
    if (commit.specDigest !== hash(canonical(spec))) stop('CP0_RUN_CONFLICT');
    const result = verifyCorpusManifest(spec, commit.manifestRef, {
      admission: ports.admission,
      reader: ports.output,
      commits: ports.commits,
      ...(ports.now ? { now: ports.now } : {}),
    });
    check();
    return { commit, summary: { ...result.summary, idempotent: true } };
  }
  const evidence = collectEvidence(selection, {
      read: (r) => {
        check();
        const bytes = ports.reader.read(r);
        check();
        return bytes;
      },
    }),
    base = verifySelectedEvidence(evidence),
    admission = check();
  if ((selection.transportLane === 'SYNTHETIC_FIXTURE') !== (admission.trustClass === 'SYNTHETIC_FIXTURE'))
    stop('CP0_TRUST_CLASS');
  const put = (kind: string, content: string) => {
    check();
    const ref = ports.output.put(kind, content);
    check();
    if (!readKind(ports.output, ref, kind).equals(Buffer.from(content))) stop('CP0_READBACK');
    check();
    return ref;
  };
  const evidenceRef = put('corpus-evidence', canonical(evidence)),
    row: CorpusRow = { ...base, evidenceRef },
    shardRef = put('corpus-jsonl', canonical(row) + '\n');
  const manifest = makeManifest(spec, row, evidenceRef, shardRef, admission.trustClass),
    manifestRef = put('corpus-manifest', canonical(manifest));
  const result = verifyManifestObjects(spec, manifestRef, {
    admission: ports.admission,
    reader: ports.output,
    ...(ports.now ? { now: ports.now } : {}),
  });
  check();
  const commit: CorpusCommit = { version: 'CorpusCommit/0.1', specDigest: hash(canonical(spec)), manifestRef };
  ports.commits.commit(commit);
  check();
  if (canonical(ports.commits.load()) !== canonical(commit)) stop('CP0_COMMIT_UNKNOWN');
  return { commit, summary: result.summary };
}
export function validateCommit(input: unknown): CorpusCommit {
  const c = shape(copyJson(input), ['version', 'specDigest', 'manifestRef']);
  if (c.version !== 'CorpusCommit/0.1') stop('CP0_COMMIT');
  digest(c.specDigest);
  const r = artifactRef(c.manifestRef);
  if (r.partition !== 'train' || r.kind !== 'corpus-manifest') stop('CP0_COMMIT');
  return c as CorpusCommit;
}

/** Trusted-host adapter: same bounded encrypted artifact primitive, separate CP0 root and key.
 * The host retains keys and this store. Pass only bound read/put/commit capabilities to workers.
 * Orphan objects after a crash are uncommitted and never implicitly exported or deleted. */
export function openCorpusRun(options: {
  approvedTrainingRoot: string;
  runtimeRoot: string;
  spec: CorpusHarvestSpec;
  key: Uint8Array;
  admission: AdmissionPort;
  mode: 'harvest' | 'verify';
  now?: () => number;
}) {
  const spec = validateHarvestSpec(options.spec),
    check = () => {
      requireTrainingBinding(options.approvedTrainingRoot, options.runtimeRoot, spec.storageBindingDigest);
      requireAdmission(spec, options.admission, options.mode, options.now?.() ?? Date.now());
    };
  check();
  if (existsSync(join(options.runtimeRoot, 'wf1-ledger.sqlite'))) stop('CP0_SOURCE_ROOT');
  const path = join(options.runtimeRoot, 'corpus-commit.json'),
    owner = join(options.runtimeRoot, 'corpus-owner.sqlite');
  let db: DatabaseSync | undefined;
  const plainFile = (p: string, max: number) => {
    const s = lstatSync(p);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) stop('CP0_PATH');
  };
  const writeNew = (p: string, bytes: string) => {
    const fd = openSync(p, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  if (options.mode === 'harvest') {
    if (!existsSync(owner))
      try {
        writeNew(owner, '');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    plainFile(owner, 4096);
    db = new DatabaseSync(owner, { timeout: 0 });
    try {
      db.exec('PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
    } catch {
      db.close();
      stop('CP0_OWNER_BUSY');
    }
  }
  let closed = false;
  const guard = () => {
    if (closed) stop('CP0_CLOSED');
    check();
  };
  let train: ArtifactPort;
  try {
    train = createArtifactBroker(options.runtimeRoot, spec.runId, options.key, guard).train;
  } catch (error) {
    db?.close();
    throw error;
  }
  const output: ArtifactPort = Object.freeze({
    read: train.read,
    put(kind: string, bytes: string | Uint8Array) {
      guard();
      if (
        options.mode !== 'harvest' ||
        !['corpus-evidence', 'corpus-jsonl', 'corpus-manifest', 'corpus-token-measurement'].includes(kind)
      )
        stop('CP0_READ_ONLY');
      return train.put(kind, bytes);
    },
  });
  const commits: CommitPort = Object.freeze({
    load() {
      guard();
      if (!existsSync(path)) return null;
      plainFile(path, 16384);
      return validateCommit(parseJson(readFileSync(path, 'utf8')));
    },
    commit(record: CorpusCommit) {
      guard();
      if (options.mode !== 'harvest') stop('CP0_READ_ONLY');
      const checked = validateCommit(record);
      if (checked.specDigest !== hash(canonical(spec))) stop('CP0_RUN_CONFLICT');
      writeNew(path, canonical(checked));
      guard();
    },
  });
  return {
    output,
    commits,
    close() {
      if (closed) return;
      closed = true;
      db?.close();
    },
  };
}
