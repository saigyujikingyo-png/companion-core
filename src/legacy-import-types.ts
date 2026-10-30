import type { DurableHeadPin } from './durable-codec.ts';
import type { VaultHead } from './anchored-codec.ts';

export type LegacyTrust =
  { policy: 'trusted-lower-bound'; minimumHead: DurableHeadPin } | { policy: 'declared-snapshot-only' };
export type LegacySourceFreeze = {
  version: 1;
  declaredHead: DurableHeadPin;
  packageDigest: string;
  trust: LegacyTrust;
};
export type LegacyImportProof = {
  version: 1;
  lineageId: string;
  migrationId: string;
  genesisAuthorityDigest: string;
  sourceFreeze: LegacySourceFreeze;
  latestProven: false;
  legacyCopiesFenced: false;
  quotaScope: 'this-authority-only';
  sourceRetirement: 'not-established';
  admissionAtImport: 'required';
};
export type LegacyAdmissionReceipt = {
  version: 1;
  operationId: string;
  migrationId: string;
  head: VaultHead;
  requestDigest: string;
  operatorId: string;
  attestation: 'operator-attested-stopped';
  latestProven: false;
  legacyCopiesFenced: false;
  quotaScope: 'this-authority-only';
};
