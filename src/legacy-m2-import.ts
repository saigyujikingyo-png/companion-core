import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureVerifiedM2Package, plainDirectory } from './durable-backup.ts';
import {
  FORMAT,
  isRestoreDirectoryName,
  makeHead,
  readAuthority,
  readCheckpoint,
  record,
  sha,
  validateHeadPin,
  validateIdentityBudget,
} from './durable-codec.ts';
import type { DurableHeadPin, Safety } from './durable-codec.ts';
import type { LegacySourceFreeze, LegacyTrust } from './legacy-import-types.ts';
import { same, validateSafetyState } from './anchored-codec.ts';
import type { VaultIdentity } from './anchored-codec.ts';
import { fail } from './validation.ts';

export type InspectLegacyRequest = {
  backupDirectory: string;
  legacyKey: Uint8Array;
  identity: string;
  expectedMaxCalls: number;
  declaredHead: DurableHeadPin;
  trust: LegacyTrust;
};
export type LegacyInspection = {
  sourceFreeze: LegacySourceFreeze;
  lineageId: string;
  migrationId: string;
  genesisAuthorityDigest: string;
  schema: 1;
  consumedRequests: number;
  revocationHighWater: number;
  latestProven: false;
  legacyCopiesFenced: false;
  quotaScope: 'this-authority-only';
};
function canonicalHead(head: DurableHeadPin, identity: string): DurableHeadPin {
  validateHeadPin(head, identity);
  return makeHead(identity, head.sequence, head.authoritySha256);
}
function canonicalTrust(trust: LegacyTrust, identity: string): LegacyTrust {
  if (
    !record(trust) ||
    !['trusted-lower-bound', 'declared-snapshot-only'].includes(trust.policy) ||
    Object.keys(trust).sort().join(',') !== (trust.policy === 'trusted-lower-bound' ? 'minimumHead,policy' : 'policy')
  )
    fail('LEGACY_TRUST_REQUIRED');
  return trust.policy === 'trusted-lower-bound'
    ? { policy: trust.policy, minimumHead: canonicalHead(trust.minimumHead, identity) }
    : { policy: trust.policy };
}
export function normalizeLegacyFreeze(freeze: LegacySourceFreeze, identity: string): LegacySourceFreeze {
  if (
    !record(freeze) ||
    Object.keys(freeze).sort().join(',') !== 'declaredHead,packageDigest,trust,version' ||
    freeze.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(freeze.packageDigest)
  )
    fail('LEGACY_SOURCE_FREEZE');
  return {
    version: 1,
    declaredHead: canonicalHead(freeze.declaredHead, identity),
    packageDigest: freeze.packageDigest,
    trust: canonicalTrust(freeze.trust, identity),
  };
}
/** Reserved M2 namespaces stay isolated, including when they are ancestors. */
export function rejectLegacyNamespace(path: string): void {
  let current = resolve(path);
  for (;;) {
    if (
      isRestoreDirectoryName(basename(current)) ||
      existsSync(join(current, 'M2.v1.claimed')) ||
      existsSync(join(current, 'M2.restore-quarantine.v1'))
    )
      fail('LEGACY_RESERVED_NAMESPACE');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function captureLegacyM2(request: InspectLegacyRequest): {
  inspection: LegacyInspection;
  image: Buffer;
  safety: Safety;
  directory: string;
} {
  validateIdentityBudget(request.identity, request.expectedMaxCalls);
  const declaredHead = canonicalHead(request.declaredHead, request.identity),
    trust = canonicalTrust(request.trust, request.identity);
  if (!(request.legacyKey instanceof Uint8Array) || request.legacyKey.length !== 32) fail('LEGACY_KEY');
  const directory = plainDirectory(request.backupDirectory);
  rejectLegacyNamespace(directory);
  const captured = captureVerifiedM2Package(directory, {
    identity: request.identity,
    key: request.legacyKey,
    maxCalls: request.expectedMaxCalls,
    expectedHead: trust.policy === 'trusted-lower-bound' ? trust.minimumHead : declaredHead,
  });
  if (!same(captured.result.head, declaredHead)) fail('LEGACY_DECLARED_HEAD');
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  let image: Buffer | undefined;
  try {
    db.deserialize(captured.bytes.authority);
    db.enableDefensive(true);
    db.exec('PRAGMA query_only=ON');
    const chain = readAuthority(
      db,
      request.legacyKey,
      request.identity,
      request.expectedMaxCalls,
      request.trust.policy === 'trusted-lower-bound' ? request.trust.minimumHead : undefined,
    );
    const genesis = sha(db.prepare('SELECT sealed FROM entries WHERE sequence=1').get()!.sealed as Uint8Array);
    const lineageId = sha(JSON.stringify([FORMAT, request.identity, genesis])),
      migrationId = `m2-import-${lineageId}`;
    image = readCheckpoint(captured.bytes.checkpoint, chain.latest!, request.legacyKey, request.identity);
    const safety = structuredClone(chain.latest!.safety);
    // Validate BEFORE terminalization: UNKNOWN must never conceal a malformed
    // old delivery ledger, duplicate delivery IDs or inconsistent reservations.
    validateSafetyState(safety, { identity: request.identity } as VaultIdentity, request.expectedMaxCalls);
    const files = [
      ['manifest.json', captured.manifest],
      ['authority.sqlite', captured.bytes.authority],
      ['checkpoint.bin', captured.bytes.checkpoint],
    ] as const;
    const sourceFreeze: LegacySourceFreeze = {
      version: 1,
      declaredHead,
      packageDigest: sha(
        JSON.stringify(files.map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) }))),
      ),
      trust,
    };
    const inspection: LegacyInspection = {
      sourceFreeze,
      lineageId,
      migrationId,
      genesisAuthorityDigest: genesis,
      schema: 1,
      consumedRequests: safety.reserved,
      revocationHighWater: chain.latest!.revocationHighWater,
      latestProven: false,
      legacyCopiesFenced: false,
      quotaScope: 'this-authority-only',
    };
    const result = { inspection, image, safety, directory };
    image = undefined;
    return result;
  } finally {
    image?.fill(0);
    db.close();
  }
}
export function inspectLegacyM2(request: InspectLegacyRequest): LegacyInspection {
  const captured = captureLegacyM2(request);
  try {
    return captured.inspection;
  } finally {
    captured.image.fill(0);
  }
}
