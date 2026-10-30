import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TeachingCampaign } from '../../src/wf1-campaign.ts';
import { CampaignLedger, createArtifactBroker } from '../../src/wf1-storage.ts';
import { canonical, hash, parseJson } from '../../src/wf1-json.ts';
import { bindTrainingRoot } from '../../src/wf2-training-root.ts';
import { prepareWf2Harvest } from '../../src/corpus-harvest.ts';
import { CORPUS_PROFILE_DIGEST, validateAdmission } from '../../src/corpus-types.ts';
import type { CorpusAdmission, CorpusHarvestSpec } from '../../src/corpus-types.ts';
import { unitFixture, unitKey, unitMock } from './wf2-unit-fixture.ts';

export async function corpusFixture() {
  const f = unitFixture(),
    mock = unitMock(f.runtimeRoot, { operation: 'candidate', index: 1, kind: 'target' });
  const campaign = TeachingCampaign.admitCampaign({
    root: f.runtimeRoot,
    authorityPath: f.authorityPath,
    spec: f.spec,
    key: unitKey,
    objective: f.bootstrap.objective,
    provider: mock.provider,
    approvedTrainingRoot: f.approvedTrainingRoot,
    now: () => f.now,
  });
  await campaign.run();
  const state = campaign.ledger.snapshot(),
    head = campaign.ledger.head;
  campaign.close();
  // A fresh retain-only host file authenticates the same immutable HMAC ledger without reviving execution.
  const sourceAuthority = join(f.base, 'host', 'harvest-source-authority.json'),
    old = JSON.parse(readFileSync(f.authorityPath, 'utf8'));
  writeFileSync(
    sourceAuthority,
    canonical({
      ...old,
      runtimeId: 'cp0-read-owner',
      revision: 2,
      rights: { seal: false, coordinate: false, generate: false, review: false, retain: true },
    }),
  );
  const originalSourceFiles = readdirSync(f.runtimeRoot)
    .sort()
    .map((name) => [name, hash(readFileSync(join(f.runtimeRoot, name)))]);
  const ledger = CampaignLedger.inspect(f.runtimeRoot, sourceAuthority, f.spec.id, unitKey, () => f.now),
    train = createArtifactBroker(f.runtimeRoot, f.spec.id, unitKey).train;
  const expected = {
    campaignId: f.spec.id,
    ledgerHead: head,
    buildDigest: f.spec.sourceDigest,
    profileDigest: f.spec.profileDigest,
    archiveDigest: hash('SYNTHETIC_ARCHIVE'),
  };
  const reads: string[] = [],
    selected = prepareWf2Harvest(
      ledger,
      {
        read: (r) => {
          reads.push(r.id);
          return train.read(r);
        },
      },
      state.candidates[0]!.id,
      expected,
    );
  const runtimeRoot = join(f.approvedTrainingRoot, 'cp0-harvest');
  mkdirSync(runtimeRoot);
  const spec: CorpusHarvestSpec = {
    version: 'CorpusHarvest/0.1',
    runId: 'cp0-synthetic',
    profileDigest: CORPUS_PROFILE_DIGEST,
    selectionDigest: selected.selectionDigest,
    storageBindingDigest: bindTrainingRoot(f.approvedTrainingRoot, runtimeRoot).storageBindingDigest,
    authorityId: 'current-cp0',
    authorityRevision: 1,
    runtimeId: 'cp0-owner',
  };
  const authority: CorpusAdmission = {
    version: 'CorpusAdmission/0.1',
    authorityId: spec.authorityId,
    revision: 1,
    runtimeId: spec.runtimeId,
    expiresAt: 999999,
    status: 'ACTIVE',
    runId: spec.runId,
    selectionDigest: spec.selectionDigest,
    storageBindingDigest: spec.storageBindingDigest,
    rights: { retain: true, harvest: true, verify: true },
    sourceUse: 'ALLOW',
    trustClass: 'SYNTHETIC_FIXTURE',
  };
  const authorityPath = join(f.base, 'host', 'cp0-authority.json');
  writeFileSync(authorityPath, canonical(authority));
  const admission = () => validateAdmission(parseJson(readFileSync(authorityPath, 'utf8')));
  return {
    f,
    mock,
    state,
    ledger,
    train,
    expected,
    reads,
    ...selected,
    originalSourceFiles,
    runtimeRoot,
    spec,
    authority,
    authorityPath,
    admission,
    key: Buffer.alloc(32, 19),
    close: () => ledger.close(),
  };
}
