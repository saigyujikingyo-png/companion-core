import { randomUUID, createDecipheriv, hkdfSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hash } from '../src/wf1-json.ts';
import { bindTrainingRoot } from '../src/wf2-training-root.ts';
import { createArtifactBroker } from '../src/wf1-storage.ts';
import { assembleScopedIndexes } from '../src/corpus-qa-index.ts';
import type { ScopedDedupIndex } from '../src/corpus-qa-index.ts';
import { QA_LEGACY_F1, QA_LEGACY_F2, QA_LEGACY_SCHEMA } from '../src/corpus-qa-legacy-f1.ts';
import {
  QA_INDEX_ARCHIVE_PROFILE_DIGEST,
  QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST,
  QA_INDEX_ARCHIVE_SCOPE,
} from '../src/corpus-qa-index-archive.ts';
import type { QaIndexArchiveDescriptor, QaIndexArchiveAdmission } from '../src/corpus-qa-index-archive.ts';
import type { AuditSelection, AuditSpec } from '../src/corpus-qa-types.ts';
import type { ScopedRef } from '../src/corpus-production-types.ts';

const ref = (kind: string, bucket = 'meta'): ScopedRef => ({
  bucket,
  ref: { id: randomUUID(), kind, partition: 'train', bytes: 32, digest: hash('SYNTHETIC absent payload') },
});
/** Structural synthetic f1 archive only; absent source samples/notes cannot be read. */
export function archiveFixture(
  options: {
    count?: number;
    job?: string;
    zero?: boolean;
    profile?: 'QA_F1' | 'QA_F2';
    configure?: (entries: ScopedDedupIndex['entries'], selection: AuditSelection) => void;
  } = {},
) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'qa-index-archive-synthetic-'))),
    approvedTrainingRoot = join(base, 'training'),
    runtimeRoot = join(approvedTrainingRoot, 'qa');
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(join(runtimeRoot, 'objects'));
  const job = options.job ?? 'synthetic-job',
    auditId = 'audit-' + job,
    now = Date.now(),
    key = Buffer.alloc(32, 87),
    readerBuildDigest = hash('SYNTHETIC trusted reader closure'),
    source = {
      jobId: job,
      specDigest: hash('source spec ' + job),
      buildDigest: hash('producer'),
      profileDigest: hash('source profile'),
      committedHead: hash('source head'),
      ledgerFileDigest: hash('source ledger'),
      authorityFileDigest: hash('source authority'),
      exportRef: ref('corpus-production-export'),
      exportDigest: hash('source export'),
      registryDigest: hash('registry'),
      purposeDigest: hash('source purposes'),
      tokenizerProfileDigest: hash('fixed synthetic tokenizer profile'),
      parentGrantIds: ['source-training'],
    };
  const selection: AuditSelection = {
    version: 'CorpusQualitySelection/0.1',
    source,
    entries: Array.from({ length: options.count ?? 40 }, (_, i) => {
      const rowDigest = hash(job + ' row ' + i);
      return {
        caseId: 'case-' + i,
        sourceRowRef: ref('corpus-production-row', 'shard-0'),
        rowDigest,
        candidateRef: ref('corpus-production-candidate', 'attempt-0'),
        candidateDigest: hash('candidate ' + i),
        unit: {
          ordinal: i,
          unitId: 'unit-' + i,
          poolId: 'pool-0',
          familyId: 'family-' + i,
          sourceId: 'source-0',
          roots: ['root-' + i],
          split: i % 2 ? 'dev' : 'train',
          rightsDigest: hash('rights'),
        },
        tokenReceiptRef: ref('corpus-production-token-receipt', 'tokens-0'),
        measurement: {
          version: 'CorpusTokenMeasurement/0.1',
          status: 'LOCAL_PINNED_EXACT',
          rowDigest,
          tokenizerProfileDigest: source.tokenizerProfileDigest,
          studentInputTokens: String(3 + i),
          studentLossTokens: String(5 + i),
          fullTokens: String(8 + 2 * i),
          inputIdsDigest: hash('input ' + i),
          fullIdsDigest: hash('full ' + i),
          lossMaskDigest: hash('mask ' + i),
          lossPolicy: 'ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR',
          officialPipelineParity: 'NOT_VALIDATED',
          actualTrainerParity: 'NOT_RUN',
          trainingReady: false,
        },
      };
    }),
    scope: 'SELECTED_ELIGIBLE_ONLY',
    providerReaudit: 'NOT_PERFORMED',
    excludedContentRead: false,
    ordering: { algorithm: 'SHA256_SEED_POPULATION_ROW', seed: hash('seed') },
    populationDigest: '',
  };
  const index: ScopedDedupIndex = {
    version: 'CorpusScopedDedupIndex/0.1',
    scope: {
      selectionDigest: '',
      populationDigest: '',
      sourceJobId: job,
      included: 'SELECTED_ELIGIBLE_ONLY',
      excludedOriginalRejected: 'NOT_READ',
      comparison: 'EXACT_NORMALIZED_PROMPT_ONLY',
    },
    entries: selection.entries.map((e) => ({
      sourceJobId: job,
      unitId: e.unit.unitId,
      poolId: e.unit.poolId,
      familyId: e.unit.familyId,
      split: e.unit.split,
      rowRef: e.sourceRowRef,
      rowDigest: e.rowDigest,
      exactDigest: hash(job + ' exact ' + e.caseId),
      normalizedDigest: hash(job + ' normalized ' + e.caseId),
      promptDigest: hash(job + ' prompt ' + e.caseId),
      qaDisposition: options.zero ? 'HOLD' : 'PASS',
    })),
  };
  options.configure?.(index.entries, selection);
  // Configure both metadata views, then freeze source selection ordering.
  for (const e of selection.entries) {
    const r = index.entries.find((r) => r.unitId === e.unit.unitId)!;
    e.unit.familyId = r.familyId;
    e.unit.split = r.split;
  }
  selection.populationDigest = hash(
    canonical(
      selection.entries
        .map((e) => ({ unitId: e.unit.unitId, rowDigest: e.rowDigest }))
        .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)),
    ),
  );
  const order = (e: AuditSelection['entries'][number]) =>
    hash(selection.ordering.seed + '\n' + selection.populationDigest + '\n' + e.rowDigest);
  selection.entries.sort((a, b) => (order(a) < order(b) ? -1 : 1));
  index.entries = selection.entries.map((e) => index.entries.find((r) => r.unitId === e.unit.unitId)!);
  index.scope.selectionDigest = hash(canonical(selection));
  index.scope.populationDigest = selection.populationDigest;
  const spec: AuditSpec = {
    version: 'CorpusQualityAudit/0.1',
    ...(options.profile === 'QA_F2' ? QA_LEGACY_F2 : QA_LEGACY_F1),
    auditId,
    selectionDigest: index.scope.selectionDigest,
    populationDigest: selection.populationDigest,
    readGrantDigest: hash('old grant'),
    purposeDigest: hash('QA purposes'),
    objectiveDigest: hash('objective'),
    storageBindingDigest: bindTrainingRoot(approvedTrainingRoot, runtimeRoot).storageBindingDigest,
    authorityRevision: 1,
    runtimeId: 'runtime-' + job,
    createdAt: now - 7200000,
    expiresAt: now - 3600000,
    rowCount: selection.entries.length,
    coordinator: {
      provider: 'deepseek',
      model: 'deepseek-flash',
      service: 'deepseek-official-api',
      accountType: 'api',
      accountRef: 'synthetic-ds',
    },
    reviewer: {
      provider: 'together',
      model: 'openai/gpt-oss-120b',
      service: 'together-serverless-api',
      accountType: 'api',
      accountRef: 'synthetic-tg',
    },
    prices: { deepseek: null, together: null },
  };
  const paths = new Map<string, string>(),
    ports = new Map<string, ReturnType<typeof createArtifactBroker>['train']>();
  const put = (kind: string, value: unknown, bucket = 'meta'): ScopedRef => {
    let port = ports.get(bucket);
    if (!port) {
      mkdirSync(join(runtimeRoot, 'objects', bucket));
      port = createArtifactBroker(join(runtimeRoot, 'objects', bucket), auditId + ':' + bucket, key).train;
      ports.set(bucket, port);
    }
    const artifact = port.put(kind, canonical(value)),
      r = { bucket, ref: artifact };
    paths.set(artifact.id, join(runtimeRoot, 'objects', bucket, 'train-' + artifact.id + '.bin'));
    return r;
  };
  const chunks = (entries: unknown[], kind: string) => {
    const refs = [];
    for (let i = 0; i < entries.length; i += 32) refs.push(put(kind, entries.slice(i, i + 32)));
    return refs;
  };
  const { entries, ...header } = selection,
    selectionChunks = chunks(entries, 'corpus-qa-selection-chunk'),
    selectionRef = put('corpus-qa-selection', {
      version: 'CorpusQualitySelectionChunks/0.1',
      header,
      entries: selectionChunks,
    }),
    indexChunks = chunks(index.entries, 'corpus-qa-index-chunk'),
    indexRef = put('corpus-qa-dedup-index', {
      version: 'CorpusScopedDedupIndexChunks/0.1',
      scope: index.scope,
      entries: indexChunks,
    });
  const indexDigest = hash(canonical(index)),
    eligible = new Set(
      assembleScopedIndexes([index], [indexDigest])
        .rows.filter((r) => r.eligibleForNextExport)
        .map((r) => r.unitId),
    ),
    rubricRef = ref('corpus-qa-rubric', 'attempt-0');
  rubricRef.ref.digest = hash('SYNTHETIC rubric cipher ' + job);
  const manifest = {
      version: 'CorpusQualitySelectionManifest/0.1',
      auditId,
      selectionDigest: spec.selectionDigest,
      populationDigest: spec.populationDigest,
      selectionRef,
      source,
      baselineDigest: spec.baselineDigest,
      auditTargetBaselineDigest: spec.auditTargetBaselineDigest,
      studentTargetDigest: spec.studentTargetDigest,
      purposeDigest: spec.purposeDigest,
      readGrantDigest: spec.readGrantDigest,
      rubricRef,
      indexRef,
      indexDigest,
      rows: selection.entries
        .filter((e) => eligible.has(e.unit.unitId))
        .map((e) => ({ caseId: e.caseId, verdictRef: ref('corpus-qa-verdict', 'attempt-1') })),
      evidenceClass: 'MODEL_OPINION',
      independence: 'SAME_MODEL_OR_ROUTING_UNKNOWN',
      factualTruth: 'UNKNOWN',
      packing: 'OFF',
      trainingReady: false,
      trainingJobPolicy: 'NOT_AUTHORIZED',
    },
    manifestRef = put('corpus-qa-selection-manifest', manifest);
  const eventRefs = [
    put('corpus-qa-event', { NEVER_DECRYPT: 'synthetic forbidden initial body' }, 'event-0'),
    put(
      'corpus-qa-event',
      { version: 'CorpusQualityAuditEvent/0.1', kind: 'INDEX', data: { ref: indexRef } },
      'event-0',
    ),
    put(
      'corpus-qa-event',
      { version: 'CorpusQualityAuditEvent/0.1', kind: 'MANIFEST', data: { ref: manifestRef } },
      'event-0',
    ),
  ];
  const projection = {
    version: 'CorpusQualityAuditState/0.1',
    spec,
    status: options.zero ? 'FENCED' : 'COMPLETED',
    code: options.zero ? 'CQA_INTEGRITY' : null,
    selectionRef,
    objectiveRef: ref('corpus-qa-objective'),
    rubricRef,
    manifestRef,
    indexRef,
    wallMs: 1,
  };
  const ledger = join(runtimeRoot, 'corpus-qa.sqlite'),
    db = new DatabaseSync(ledger);
  db.exec('PRAGMA application_id=1129406769; PRAGMA user_version=1; ' + QA_LEGACY_SCHEMA.join(';'));
  let head = '0'.repeat(64);
  eventRefs.forEach((r, i) => {
    const body = canonical(r),
      next = hash(head + '\n' + body);
    db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(i + 1, head, body, next);
    head = next;
  });
  db.prepare('INSERT INTO metadata VALUES (1,?)').run(canonical(projection));
  db.prepare('INSERT INTO attempts VALUES (?,?)').run('forbidden', 'NEVER_READ_REQUESTS_RAW_REASONING');
  db.prepare('INSERT INTO cases VALUES (?,?)').run('forbidden', 'NEVER_READ_VERDICT_NOTES');
  db.close();
  const authorityPath = join(base, 'authority.json'),
    authority = {
      schemaVersion: 'wf1-host/1',
      campaignId: auditId,
      revision: 2,
      runtimeId: spec.runtimeId,
      status: 'REVOKED',
      expiresAt: spec.expiresAt,
      head,
      rights: { seal: false, coordinate: false, generate: false, review: false, retain: false },
    };
  writeFileSync(authorityPath, canonical(authority));
  writeFileSync(join(runtimeRoot, 'once.json'), 'SYNTHETIC consumed request; never replay');
  const descriptor: QaIndexArchiveDescriptor = {
    version: 'QaIndexArchiveDescriptor/0.1',
    legacyProfile: options.profile ?? 'QA_F1',
    readerBuildDigest,
    archiveProfileDigest:
      options.profile === 'QA_F2' ? QA_INDEX_ARCHIVE_F2_PROFILE_DIGEST : QA_INDEX_ARCHIVE_PROFILE_DIGEST,
    spec,
    specDigest: hash(canonical(spec)),
    source,
    ledgerRawDigest: hash(readFileSync(ledger)),
    authorityRawDigest: hash(readFileSync(authorityPath)),
    authorityRevision: 2,
    authorityStatus: 'REVOKED',
    committedHead: head,
    committedSequence: 3,
    coldReceiptRawDigest: hash('SYNTHETIC externally accepted cold receipt'),
    indexDigest,
    indexRef,
    manifestRef,
    selectionRef,
  };
  const admission: QaIndexArchiveAdmission = {
    grant: {
      version: 'QaIndexReadGrant/0.1',
      grantId: 'fresh-index-grant',
      revision: 1,
      descriptorDigest: hash(canonical(descriptor)),
      purposeDigest: spec.purposeDigest,
      status: 'ACTIVE',
      readAllowed: true,
      retainAllowed: true,
      validFrom: now - 1000,
      expiresAt: now + 3600000,
      scope: QA_INDEX_ARCHIVE_SCOPE,
    },
    sourceJobId: job,
    sourcePurposeDigest: source.purposeDigest,
    parentGrantIds: source.parentGrantIds,
    sourceAllowed: true,
    retainAllowed: true,
  };
  const readerOptions = {
    approvedTrainingRoot,
    runtimeRoot,
    authorityPath,
    key,
    descriptor,
    descriptorDigest: hash(canonical(descriptor)),
    readerBuildDigest,
    admission: () => admission,
  };
  const repin = () => {
    descriptor.ledgerRawDigest = hash(readFileSync(ledger));
    descriptor.authorityRawDigest = hash(readFileSync(authorityPath));
    descriptor.specDigest = hash(canonical(descriptor.spec));
    readerOptions.descriptorDigest = hash(canonical(descriptor));
    admission.grant.descriptorDigest = readerOptions.descriptorDigest;
  };
  const changeProjection = (change: (p: typeof projection) => void) => {
    change(projection);
    const db = new DatabaseSync(ledger);
    db.prepare('UPDATE metadata SET data=? WHERE id=1').run(canonical(projection));
    db.close();
    repin();
  };
  const replaceTerminal = (kind: 'INDEX' | 'MANIFEST', r: ScopedRef) => {
    const i = kind === 'INDEX' ? 1 : 2;
    eventRefs[i] = put(
      'corpus-qa-event',
      { version: 'CorpusQualityAuditEvent/0.1', kind, data: { ref: r } },
      'event-0',
    );
    const db = new DatabaseSync(ledger);
    db.exec('DELETE FROM events');
    let head = '0'.repeat(64);
    eventRefs.forEach((r, i) => {
      const body = canonical(r),
        next = hash(head + '\n' + body);
      db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(i + 1, head, body, next);
      head = next;
    });
    db.close();
    authority.head = head;
    descriptor.committedHead = head;
    writeFileSync(authorityPath, canonical(authority));
    repin();
  };
  const output = (
    readers: Parameters<
      typeof import('../src/corpus-qa-archive-assembly.ts').writeQualityArchiveAssembly
    >[0]['readers'],
  ) => {
    const runtimeRoot = join(approvedTrainingRoot, 'assembly-' + randomUUID());
    mkdirSync(runtimeRoot);
    return {
      approvedTrainingRoot,
      runtimeRoot,
      assemblyId: 'synthetic-assembly',
      key: Buffer.alloc(32, 89),
      readerBuildDigest,
      purposeDigest: spec.purposeDigest,
      readers,
    };
  };
  return {
    base,
    ledger,
    authorityPath,
    runtimeRoot,
    key,
    readerOptions,
    descriptor,
    admission,
    selection,
    index,
    manifest,
    projection,
    authority,
    eventRefs,
    indexChunks,
    selectionChunks,
    paths,
    put,
    repin,
    changeProjection,
    replaceTerminal,
    output,
  };
}

export function decryptAssembly(
  o: { runtimeRoot: string; assemblyId: string; key: Uint8Array },
  name = 'manifest.bin',
  artifactId = o.assemblyId,
  kind = 'qa-archive-assembly-manifest',
): any {
  const bytes = readFileSync(join(o.runtimeRoot, name)),
    derived = Buffer.from(hkdfSync('sha256', o.key, o.assemblyId, 'qa-index-archive-assembly/0.2', 32));
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived, bytes.subarray(0, 12));
    decipher.setAAD(
      Buffer.from(canonical({ version: 'QaArchiveAssemblyCipher/0.2', assemblyId: o.assemblyId, artifactId, kind })),
    );
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
  } finally {
    derived.fill(0);
  }
}
