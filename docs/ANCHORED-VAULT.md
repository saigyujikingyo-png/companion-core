# AnchoredVault v2 — S1 reference implementation

This page retains the S1/v2 protocol and examples. Current extensions are [schema2 consumers](DURABLE-FANOUT.md), [explicit v3 incremental storage and compaction](INCREMENTAL-STORAGE.md), and [verified legacy M2 package import](LEGACY-M2-IMPORT.md). Storage format and application schema are separate choices; the original v2 default and schema-1 SQL remain compatible.

`AnchoredVault` is a separate, mandatory-anchor storage API. It does not open an M2.v1 live directory or upgrade it in place. The separate explicit import creates a new v3 target from a verified export package; it cannot fence the unanchored legacy copies. M2.v1 and its valid-prefix rollback negative control remain unchanged.

The implemented recovery boundary is **current-state recovery with independently held freshness and anchored-writer fencing**. This is a local reference backend, not a production key-custody service or hardware monotonic counter. No provider call, training, archive deletion or in-place source migration is performed.

## Trust and custody

`LocalSqliteAuthority` must be provisioned separately from the vault and its backups. Its SQLite database contains safe head/operation metadata, canonical paths, and immutable receipts; it contains neither application images nor decryption keys. Operators must exclude it from vault rollback and administer it as trusted current state. A caller-supplied `custodyDomain` declaration and disjoint canonical paths detect accidental overlap; they do not prove filesystem ACL separation, a different administrator, or a different physical failure domain.

An attacker who rolls back or rewrites both the external authority and the vault under the same account/administrator defeats this reference backend. An attacker who can execute arbitrary code in the process can read in-memory keys and already-returned data. These are explicit prerequisites, not solved threats. The authority is not automatically recreated when missing. Opening requires its expected provisioned authority ID and custody domain. Each operation checks backing-file identity and provisioned metadata again; missing/replaced files fail closed. Windows prevents renaming its open SQLite file; the POSIX detection path needs platform verification.

Both authority and writer SQLite main files and recovery sidecars are bounded and checked for regular-file/no-symlink status before the first SQLite open. Unknown schema layouts are refused. The authority uses `journal_mode=DELETE` and `synchronous=EXTRA`, with readback of both settings. EXTRA is selected for the rollback-journal directory-sync behavior described in [SQLite's synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous). Native file writes use exclusive creation and `fsync`; the reference does not claim that tests simulate power loss or establish hardware durability. A lost staged file yields unresolved recovery, never permission to rewind the authority.

## API

Source modules:

- `src/anchored-codec.ts`: v2 authenticated codec, `KeySet`, recipient envelopes, bounded file helpers.
- `src/local-sqlite-authority.ts`: explicit authority provisioning/open, synchronous guarded transactions, PREPARED/ACTIVE CAS and receipts.
- `src/anchored-vault.ts`: live vault, current-state backup, verification, restore/rekey activation and reconciliation.
- `src/store.ts`: `aroundAccess` seam, including transaction operations and direct snapshot/scope/high-water/diagnostic reads.

```ts
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { generateKeySet } from '../src/anchored-codec.ts';

// Use new absolute directories outside the source tree. Provision separately.
const authority = LocalSqliteAuthority.create({
  directory: authorityDirectory, authorityId: 'chosen-authority-id',
  custodyDomain: 'independently-managed-anchor',
});
const keys = generateKeySet(); // Keep in memory; supply through stdin for a child.
const config = {
  directory: newVaultDirectory, vaultId: 'chosen-vault-id', identity: 'companion',
  storageDomain: 'vault-and-backups', authority, keys,
};
const vault = AnchoredVault.create(config, 8);
const backup = vault.exportBackup(newBackupDirectory);
// Later: LocalSqliteAuthority.open(...) and AnchoredVault.open(config, 8).
// Close the vault before closing its caller-owned authority handle.
```

`create` requires a nonexistent leaf; `open` requires the marker and a registered active exact head. An interrupted create is not automatically resumed as a fresh database. The marker's identity, instance, owner/key epochs, canonical instance directory and authority ID are authenticated by the checkpoint and record AAD. Copying an instance to a new path cannot activate it. A long-lived local writer SQLite lock prevents two processes from using the same live instance.

All live data operations (`claim`, `reserve`, `terminal`, `consumeFeedback`, `source`, `head`, `reserved`, `status`, `exportBackup` and direct `vault.store` operations) acquire an authority `BEGIN IMMEDIATE`, compare the active exact head including owner/instance identity, and hold the guard until completion. The guard is synchronous. Promise/thenable results are rejected. Public operations cannot reenter via clock/fault callbacks; only explicit private helpers reuse the held guard. Captured authority transaction capabilities expire permanently at transaction exit. `close` permits poisoned/fenced cleanup but refuses closing during an active operation.

This guarantees currentness at each synchronous operation's linearization point. It cannot retract a snapshot or text already returned to a consumer before a later fence. Every later authority-sensitive read must use the guarded API again.

## Commit and recovery order

Each mutation runs under the guard. The Store commits its disposable RAM image first, including FTS state; success is not acknowledged yet. The subsequent steps are:

1. Freeze the exact checkpoint ciphertext and sealed record in a new `stage-<operationId>.json`; fsync it. The record binds the ciphertext digest, operation ID, previous head and revocation high water.
2. CAS the external authority from the exact old ACTIVE head to durable PREPARED with old/new heads, operation ID, owner epoch, stage path and stage digest. Commit the authority transaction and reacquire its lock. During this gap normal reads/writes/open refuse PREPARED.
3. Exclusively publish the checkpoint and immutable record files from the same staged bytes. Existing identical bytes are accepted for reconciliation; conflicting bytes are refused.
4. Finalize authority ACTIVE at the new exact head, with an immutable operation receipt in the same transaction. Commit, reacquire, and recheck the new exact head before any successful return.

Any write exception poisons the live handle. Its cleanup remains possible. A failure before PREPARED leaves the prior head authoritative and returns no successful reservation; inference must not begin before `reserve` succeeds. After PREPARED there is no rollback/refund/fallback API.

| Interruption | Normal use | Explicit action |
| --- | --- | --- |
| Stage written, before PREPARED | Current handle poisoned; previous ACTIVE state remains | Reopen prior committed state; pending ingress becomes unknown; orphan stage is retained |
| PREPARED, before/while local publication | All ordinary access refuses pending | `reconcile` validates and publishes the exact frozen stage |
| Local record complete, before finalization | Still pending | Same reconciliation; no business/provider replay |
| Finalization durable, response lost | New head is authoritative; caller outcome was unknown | Operation receipt identifies the completed transition |
| Missing/tampered stage, wrong keys, publication conflict | Pending remains unresolved | Stop; preserve evidence; repair by an explicit trusted recovery procedure outside this API |

```ts
const pending = authority.inspect(vaultId)?.pending;
if (pending) {
  const receipt = AnchoredVault.reconcile({
    authority, vaultId, operationId: pending.operationId, keys, maxCalls: 8,
  });
}
```

Reconciliation performs ciphertext/hash/identity/image/FTS/revocation validation and publishes only an already-prepared exact operation. It does not rerun callbacks, issue provider requests, create a new reservation, refund quota, or select an older head. If the operation already completed, it returns its receipt. A receipt proves that operation's completion, not that its resulting head is still latest after subsequent operations.

## Backup and activating a recovery target

`exportBackup(newDirectory)` writes two new files: `current-state.json` containing ciphertext plus its exact head and `backup.json` containing metadata/digest/coverage. There are no keys or plaintext application images. Coverage is explicitly `current-state`; immutable historical files are not claimed as included or reencrypted.

`exportBackup(newDirectory, maxOutputBytes)` optionally limits one export's complete logical output. The budget must be a primitive nonnegative safe integer, including zero; other supplied values fail `INVALID_INPUT`. Omitting it or passing `undefined` retains the existing behavior. Under the same authority guard, the export validates the current head, complete required recovery chain and image, then checks that the target is new before validating and applying the budget. Existing health, fencing, missing-dependency and target refusals keep precedence.

Before creating the target, the exporter fixes every output buffer and sums its exact byte length: the complete UTF-8 `current-state.json` and `backup.json`, plus every required v3 blob, record and cold Safety file. An output larger than the budget fails `ANCHOR_BACKUP_OUTPUT_LIMIT` without creating the target or modifying the source, authority or ledgers; equality is admitted. Publication writes those same buffers with the existing exclusive-create/fsync behavior. A later filesystem failure still returns its original error and retains partial output, without cleanup, retry or another target. The budget does not reserve physical space, bound RAM usage, enforce cumulative retention or reclaim bytes, and it does not change any existing storage/authority capacity limit or the backup format/receipt.

`verifyBackup({ backupDirectory, authority, keys, maxCalls })` validates authenticated content and the disposable RAM image, then compares the package head to the independent authority's current exact head. A valid older package is rejected as stale. This API prioritizes refusal of quota/revocation rollback over availability: if the latest image and matching frozen stage are lost, an older backup cannot silently become latest.

`restoreBackup` does real activation:

```ts
const request = {
  backupDirectory, targetDirectory: newTargetDirectory, storageDomain: 'vault-and-backups',
  authority, keys, maxCalls: 8, operationId: 'caller-stable-restore-id',
};
const receipt = AnchoredVault.restoreBackup(request);
const restored = AnchoredVault.open({ ...config, directory: newTargetDirectory }, 8);
```

Under the authority lock, it verifies that the backup's parent is still the current exact head, creates a new instance with `ownerEpoch + 1`, and freezes a sequence-1 current-state genesis carrying the authenticated `parentHead`. PREPARED blocks both source and target. Publication and finalization activate only the new instance. Old live source reads/writes, its restart, and copies of its old instance are refused. The source files and backup remain untouched. A target that exists already or only partially exists is not initialized again. A complete retry with the same operation ID and request returns the receipt; changed request arguments conflict. Pending retries require `reconcile`, not another cutover.

This v2 restore protocol supplies no activation bypass for an old `M2.restore-quarantine.v1-*` target. The separate [M2 import](LEGACY-M2-IMPORT.md) accepts only verified export packages, registers their lineage once on this authority and creates a new v3 base. Legacy copies remain outside this authority's fencing protocol.

## Key envelopes and true rekey

A v2 `KeySet` contains independent random 32-byte `storageDEK` and stable `ingressKey`, with `version: 2` and a positive `keyEpoch`. Equal keys are rejected. The checkpoint authenticates the ingress key digest; correct DEK plus wrong ingress key fails on open, before it can bypass native request deduplication. Store's separate `meta.ledger_key` remains in the encrypted application image.

`wrapKeySet(keys, recipientKEK, { authorityId, vaultId, recipient })` uses AES-256-GCM, a random 96-bit IV and AAD binding the v2 format/purpose, authority/vault identity, key epoch and recipient. `unwrapKeySet` requires the expected recipient/identity/epoch and a 32-byte KEK. These APIs accept key bytes in memory, not command-line arguments, plaintext key files, password strings or DPAPI copies.

`rewrapKeyEnvelope(oldEnvelope, oldKEK, expected, newKEK, newRecipient, newEnvelopePath)` writes an exclusive new recipient envelope. It leaves the payload, storage DEK, ingress key and current head unchanged. It neither revokes access to an old envelope nor erases old KEKs.

`rekeyBackup({ ...restoreRequest, newStorageDEK })` performs actual storage-key migration: it requires a new distinct 32-byte DEK, preserves the stable ingress key and Store ledger key, increments `keyEpoch`, and uses the same new-instance/owner-epoch fencing cutover. Open the returned target with `{ ...oldKeys, storageDEK: newStorageDEK, keyEpoch: oldKeys.keyEpoch + 1 }`. The old DEK cannot decrypt new ciphertext. New recipient envelopes should be generated for the resulting KeySet by the caller. The caller owns key custody and retention; no platform key service integration is included.

Only the current recovery state is reencrypted. Old archives and envelopes remain readable by their old valid keys; this is not crypto-erasure or remediation of leaked historical keys. The separate legacy import retains the old key as stable ingress HMAC while using a different storage DEK. It does not destroy legacy keys or backups.

## Validation and limits

The synthetic suite exercises mandatory-anchor failures, wrong identity/key/ingress key, stale packages and valid-prefix rollback, full restore source fencing, rewrap roundtrip, DEK migration preserving consumed native IDs/quota/revocation/feedback/Store ledger key, five injected write interruption points, unresolved-stage failures, cross-process lock contention/cutover, and actual child process exit at PREPARED/record-published/finalized. Keys are generated solely for fresh native TEMP fixtures and sent to children only on stdin.

The original S1/v2 slice remains a bounded full-image reference: 16 MiB application image, 256 MiB local generation budget, 4096 commits, 8192 ingress IDs and configured request budget at most 32. Exhaustion fails closed. Later [durable fanout](DURABLE-FANOUT.md), [v3 incremental storage and compaction](INCREMENTAL-STORAGE.md), and [legacy M2 import](LEGACY-M2-IMPORT.md) extend that historical slice without changing its wire contract. No retention/RPO-RTO scale claim is included. Production service integration, remote authority deployment, physical power loss, Linux/macOS execution, hardware monotonic storage and migration of existing private data remain unverified/unimplemented as applicable.
