# Verified M2 snapshot import into AnchoredVault

The [final combined IF3/IF4 evidence](AEMC-INFRA-EVIDENCE-IF4.md) records the independent 822/822 whole suite, typecheck, two final read-only reviews and complete-vault measurement on the frozen final source.

`AnchoredVault.inspectLegacyM2()` and `AnchoredVault.importLegacyM2()` accept an exported M2 three-file package and create a real anchored-v3 current-state generation. They do not start the old runtime, boot a source Store, write to the package, claim its namespace, or resume a provider request. The old M2 verify and quarantined-restore APIs retain their contracts.

This is a local reference implementation. The independently held authority must be excluded from vault/backup rollback. It cannot fence legacy M2 instances or a different authority, prove the package is the latest copy, or prevent an administrator from rolling back both storage and the authority. Every import receipt therefore records `latestProven: false`, `legacyCopiesFenced: false`, `quotaScope: 'this-authority-only'`, `sourceRetirement: 'not-established'` and `admissionAtImport: 'required'`.

## Authority preparation

Existing authority schema 2 remains valid for ordinary anchored vaults. Import requires an explicit maintenance migration to schema 3:

```ts
// Stop clients first, including old binaries without schema-epoch checks.
authority.close();
LocalSqliteAuthority.upgradeSchema(authorityConfig, 'operator-attested-stopped');
authority = LocalSqliteAuthority.open(authorityConfig);
```

The migration takes an exclusive SQLite transaction, verifies the known old layout/identity/integrity while holding that lock, creates `legacy_imports`, sets the numbered version and verifies the exact resulting layout. Original metadata, vault rows and receipt JSON strings are compared before commit and retained unchanged. Under the [IF6 capacity protocol](AUTHORITY-CAPACITY-PLAN.md), an outstanding PREPARED operation now blocks an upgrade before mutation: reconcile it first, then upgrade. This supersedes the historical IF4 upgrade-while-pending behavior without rewriting its evidence. Repeating a complete upgrade is idempotent. Missing tables, extra objects and unknown versions are rejected; `open()` never upgrades or repairs a database.

New authority objects pin both `user_version` and `schema_version`. Every transaction acquisition, including prepare/finalize commit-and-relock, checks those values. Handles opened before the upgrade must reopen. This does not provide safe mixed-version operation with an old binary that lacks these checks; the maintenance stop is an operator precondition.

## Inspect, freeze and import

All keys below are caller-owned byte arrays already supplied in memory. The library does not load private key files. `declaredHead` must exactly name the package tip. An independent trusted lower bound and the package's declared tip are distinct inputs:

```ts
const source = {
  backupDirectory,
  legacyKey,
  identity,
  expectedMaxCalls,
  declaredHead,
  trust: { policy: 'trusted-lower-bound' as const, minimumHead },
};
const inspected = AnchoredVault.inspectLegacyM2(source);
const receipt = AnchoredVault.importLegacyM2({
  ...source,
  sourceFreeze: inspected.sourceFreeze,
  authority,
  vaultId: 'destination-vault',
  targetDirectory,
  storageDomain: 'payload-domain',
  storageProfile: 'blocks-br4-v1',
  newStorageDEK, // Different from the legacy key; exactly 32 bytes.
  operationId: inspected.migrationId,
  // targetSchema: 2, // Optional explicit RAM-copy schema migration.
});
const keys = { version: 2 as const, keyEpoch: 1, storageDEK: newStorageDEK, ingressKey: legacyKey };
```

Without an independently held minimum head, callers must explicitly choose `{ policy: 'declared-snapshot-only' }`. This verifies the selected snapshot and its authenticated chain but supplies no independent freshness evidence. A manifest is never used to manufacture a trusted lower bound. Even the lower-bound policy does not prove that no later copy exists.

Each inspect/import invocation captures the three bounded files once, verifies that frozen capture, and performs subsequent decoding in RAM. Inspect returns metadata only. Import recaptures once and requires the same `sourceFreeze`: canonical declared head, explicit trust policy and package digest of the exact ordered file names, lengths and bytes. Equivalent head objects with different property insertion order normalize identically. A package byte change, including otherwise harmless manifest whitespace, changes the freeze and refuses the import. The source image is checked using the no-boot image inspector.

After the full old authority chain is verified, its first sealed entry digest and business identity derive a lineage ID. The fixed migration ID is `m2-import-<lineageId>`. The authority registry uniquely binds lineage, migration ID and destination vault. Prefixes, successors and forks sharing that verified genesis cannot obtain a second destination or fresh quota on this authority. A wholly separate legacy genesis or a different independently provisioned authority is outside that guarantee.

The target is a new exclusive directory and a complete v3 base. Schema 1 is retained unless `targetSchema: 2` explicitly requests the registered offline RAM migration. The source package and original live directory remain unchanged. Unicode and colon characters are supported in the business identity under the existing 128-character text contract; authority, vault, instance, storage-domain and operation IDs retain their stricter ID rules.

Path isolation applies consistently to anchored create/open/export and subsequent cutovers. Canonical targets and their ancestors must be outside M2 claimed or restore-quarantine namespaces. Source, target and custody directories must be disjoint; symlink leaf/file inputs are refused. Ancestor resolution uses canonical paths under the existing owner-controlled-directory assumption. This intentionally tightens reserved-path isolation while preserving ordinary v2 paths and formats.

## Atomic registration, failures and reconciliation

The full base and immutable staging metadata are frozen and synced before PREPARED. The same authority transaction registers both the lineage PREPARED row and vault PREPARED intent. Publication then installs the exact frozen record; finalize atomically stores both ACTIVE states and the original import receipt. There is no independent claim/release registry API.

Before PREPARED, an interrupted target is an unusable partial directory and the lineage is not consumed. Preserve it and use a new target namespace for a new attempt. Once PREPARED is durable, the slot remains consumed: ordinary open/import refuses pending work, and the only completion path is explicit reconciliation:

```ts
const completed = AnchoredVault.reconcile({
  authority, vaultId, operationId: inspected.migrationId, keys, maxCalls: expectedMaxCalls,
});
```

Reconciliation checks the frozen stage, authenticated import proof, pending intent and registry consistency, then completes those bytes. It never rereads the legacy package or reruns business/provider work. A missing or damaged frozen stage, required blob or predecessor dependency remains unresolved. The not-yet-published current record is created from the verified stage; an already-existing conflicting record is refused. There is no refund or fallback to the old source. The source package may be offline after PREPARED. Repeating an already completed operation returns its historical receipt; this does not reactivate a fenced generation. Repeating `importLegacyM2` also requires a matching frozen package and exact original destination request.

PREPARED registry entries must match their pending import and contain no receipts or admission. ACTIVE entries must retain the original import receipt exactly as recorded in the authority receipt table. Admission state and its receipt are checked together. A missing or inconsistent registry fails closed; authenticated lineage cannot be removed by compaction, restore, rekey, schema migration or fanout maintenance. ACTIVE registry entries can coexist with a later ordinary cutover's PREPARED vault state. Historical receipts are checked against their own identities, not forced to equal a later current head.

## Keys, Safety and admission

The new storage DEK encrypts all new v3 data. The legacy key's exact bytes remain the stable ingress HMAC key because original native IDs cannot be recovered from their HMACs. The Store's independent `meta.ledger_key` is retained. The legacy key still decrypts old M2 ciphertext; this migration neither erases archives nor repairs a historical key compromise. Later DEK rekey preserves stable ingress and Store ledger keys.

Original Safety is validated against the new strict contract before transformation. Incompatible delivery IDs, duplicate receipts or reservation totals are rejected rather than concealed. Budget limits, total/per-entry reservation flags, feedback consumption, existing terminal states, revocation highwater and source state are preserved. Only unfinished pending/ready/taken entries become terminal UNKNOWN, and the last acknowledged delivery pointer is cleared. No request is replayed, refunded or reopened. A normal first target open then performs the ordinary target boot fencing; schema-1 import's pre-boot image itself is byte-identical to the verified source image.

Import defaults to `admission: 'required'`. Actual `claim()` and `reserve()` calls check this state under the same external authority guard before ingress or budget mutation and before persistence. Reads, inspection and controlled maintenance remain possible. Admission is an explicit separate CAS against the exact current head:

```ts
const admission = authority.admitLegacyImport({
  migrationId: inspected.migrationId,
  head: vault.head,
  operationId: 'operator-admission-1',
  operatorId: 'migration-operator',
  attestation: 'operator-attested-stopped',
});
```

The attestation is recorded as an operator statement, not mechanically verified legacy fencing. The independent receipt preserves the fixed false/latest and authority-only quota statements. Admission never edits the original import receipt, adds budget or reopens UNKNOWN. It survives later writes and cutovers. An identical retry is idempotent while its exact head remains current; a different admission request conflicts, and a stale head is refused. No new process or provider is started by admission.

## Bounds and verification

The current M2 package limits and schema-1 validation remain in force. The imported destination inherits [v3 bounds](INCREMENTAL-STORAGE.md): 16 MiB image, at most 16 frames per required chain, bounded decode, 4096 commits and 256 MiB per generation, and bounded marker/stage/record files. [Fanout](DURABLE-FANOUT.md) limits apply if schema 2 is selected. This is bounded local current-state migration, not historical replay, ten-year capacity or a physical-power-loss qualification.

The final author IF4 suite passed **21/21**, typecheck exit 0, Node 24.16.0, single worker and new native TEMP. It covers frozen bytes, incorrect keys and heads, Unicode identity, duplicate/fork lineage, explicit schema upgrade/rollback/old handles, persistent registry mismatch, all five commit fault points, two actual processes competing for one slot, and a real PREPARED process exit followed by reconciliation without the package. It also checks admission zero-side-effects, quota/UNKNOWN/feedback/ledger/revocation preservation, schema 2 and admission across compaction/rekey/restore, reserved namespaces and normal v2 reopen. A synthetic old M2 instance still independently accepts a reservation, documenting the non-fencing limitation.

Associated anchored/v3/M2/fanout/Store tests passed **196/196** in 23.044 seconds (fresh RAM 3.470 GiB). That run's typecheck caught a test fixture supplying an explicit `undefined` optional profile under `exactOptionalPropertyTypes`; the fixture now omits the field. The final IF4 rerun passed 21/21 in 4.180 seconds with typecheck exit 0. No runtime test failed during IF4. An earlier edit-stage typecheck also caught nullable child-process stream types; the explicit pipe fixture was annotated without changing runtime behavior.

Logs are retained under native TEMP: `aemc-if4-first-20261027T035957Z` (16/16), `aemc-if4-focused-20261027T040217Z` (19/19), `aemc-if4-registry-20261027T040737Z` (21/21), `aemc-if4-associated-20261027T040846Z` (196/196 and the fixture typecheck failure), and `aemc-if4-final-20261027T040954Z` (final 21/21 and typecheck 0). Independent final whole-suite and measurement runs are recorded separately in the combined evidence linked above and have passed. The IF3 historical measurement is not relabeled as IF4 evidence; its driver hash coverage now includes the three newly loaded runtime modules, while workloads, codecs and gates are unchanged.
