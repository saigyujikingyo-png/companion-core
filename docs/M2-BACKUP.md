# M2 current-state backup and quarantined restore preparation

The separate [explicit M2 import](LEGACY-M2-IMPORT.md) now accepts a verified export package into a new anchored-v3 generation. It does not activate a quarantine directory, fence legacy copies or change the original M2 wire format. This page retains the original export/verification/quarantine contract.

This slice adds a trusted head lower-bound check, encrypted current-state export,
disk-read-only verification, and quarantined restore preparation. It does not
activate restored copies, transfer writer authority, solve key custody, migrate
schema 1, implement durable consumers, or establish ten-year reliability.
The original schema SQL/hash and M2.v1 marker, checkpoint, authority record and
AES-GCM associated-data formats are unchanged. See [M2a](M2-DURABLE.md) and the
separate [durable consumer migration ADR](ADR-AR0B-DURABLE.md).

## Trust and API contract

`DurableMemory.head` returns only
`{version:1,format:'companion-core-m2-v1',identity,sequence,authoritySha256}`.
The digest covers the exact sealed authority row. Observing this metadata does
not establish that it is the latest independent trusted anchor. A caller must
retain and authenticate its chosen pin outside the rollbackable package/vault.
No key or decrypted state is returned by this getter.

`new DurableMemory(config, maxCalls, {expectedHead})` accepts an optional pin.
The bounded authenticated chain must contain that exact identity, format,
sequence and sealed-row hash. Equal heads and valid later descendants pass;
shorter prefixes, same-sequence forks, branches that fork before the pin and
unknown pin versions/formats fail. An older pin is a lower bound, not proof that
the supplied chain contains all later reservations or revocations. Without a
pin, the existing `KNOWN_UNPROTECTED_LEDGER_ROLLBACK` test remains unchanged and
still demonstrates the unprotected legacy boundary. No automatic pin discovery,
advancement, external monotonic service or latest-head certification is provided.

Public entry points:

```ts
// The live vault must already hold its exclusive writer lock.
const exported = vault.exportBackup(absoluteNewBackupDirectory);

// expectedHead comes from an independently trusted channel, not manifest.head.
const options = { identity, keyBase64, maxCalls, expectedHead };
const verified = verifyDurableBackup(absoluteBackupDirectory, options);

// The caller explicitly chooses a NEW leaf with this exact prefix.
const prepared = stageDurableRestore(
  absoluteBackupDirectory,
  absoluteParent + '/M2.restore-quarantine.v1-my-restore',
  options,
);
// prepared.status === 'RESTORE_VERIFIED_NOT_ACTIVATED'
```

The two free functions are exported by `src/durable-backup.ts`; the class and
pin type are exported by `src/durable-memory.ts`. Keys are supplied in memory.
The code does not discover/read DPAPI files, provider credentials, environment
files, host histories or original application data.

## Package and consistency

Export is synchronous and refuses a closed or poisoned writer. Reentrant source
operations and close are refused while export is in progress. The authority
SQLite database is captured with `serialize()` from the owned live connection;
it is not copied as a hot database file. The exact current checkpoint is read
once and verified against that captured chain and the writer's exact head.
All validation completes before output creation. Export does not append a source
checkpoint, change quota, turn pending output into unknown, or reset the source.
Failure leaves the healthy source usable and does not automatically retry.

A complete package has exactly three files:

| File | Content | Bound |
| --- | --- | --- |
| `authority.sqlite` | Complete serialized authority chain; rows contain authenticated ciphertext | 64 MiB |
| `checkpoint.bin` | Exact latest checkpoint ciphertext | 32 MiB |
| `manifest.json` | Version/format/current-state declaration, observed head, original checkpoint filename, both file sizes and SHA256 digests | 16 KiB |

This is a **current-state recovery package**, not a complete history archive.
Earlier checkpoint files are intentionally omitted. Their authenticated entries
remain in the chain, but historic image availability is not claimed. Keys, writer
lock files, DPAPI data and plaintext SQLite images are never exported.

The output parent must exist and the requested leaf must not exist. Export
cannot write inside the source vault. Payload files use exclusive creation and
file fsync. The complete manifest is written/fsynced under `manifest.json.pending`
and published by a final rename. Missing completion, pending files, extra files,
unexpected fields, path substitutions, unknown versions and invalid sizes or
hashes are rejected. No successful return is issued before publication. These
operations provide bounded process-failure evidence, not directory durability
under power loss.

## Verification and recovery isolation

Verification opens package files read-only with pre-allocation size bounds,
single-link regular-file checks and before/after file identity checks. Existing
path components must be plain directories; symlinks/junctions are refused. Files
are captured once into bounded memory; recovery uses those validated bytes
without rereading a potentially changed package. The manifest's head is checked
against the actual decrypted chain, never promoted to the independent pin.

The shared `durable-codec.ts` validates format/identity/budget, each AEAD record,
consecutive sequences, previous sealed-row hashes, monotonic quota/revocation
high-water, the trusted pin, and the exact latest checkpoint and safety state.
The authority snapshot is deserialized into a query-only RAM database. The
decrypted memory image is validated by the existing MemoryStore schema/layout,
SQLite integrity, foreign-key and FTS5 integrity checks. This disposable RAM
MemoryStore performs its normal lease/epoch reset **only in RAM**, with no
persistence callback; package bytes and original pending states remain unchanged.
The decrypted image buffer and decoded input key buffer are cleared afterward;
this is not a claim to erase every JS/SQLite allocation, swap or process dump.

Restore preparation requires a new leaf whose basename begins with
`M2.restore-quarantine.v1-`; it does not silently rename caller input. It cannot
write inside the package. The live DurableMemory constructor refuses this
reserved **canonical basename before lock creation or initialization**, even if
the directory is empty. Thus a process exit immediately after mkdir cannot leave
a target that will later initialize as a new empty vault. It also refuses the
`M2.restore-quarantine.v1` marker independently of directory name/content.

After complete verification, preparation creates that new leaf, writes/fsyncs
the quarantine marker, authority snapshot, exact original checkpoint name and
original M2 marker, then publishes `restore-verified.json` last. Failures after
directory creation leave a quarantined partial (or remove only a just-created
empty leaf after marker creation fails). Existing targets are never overwritten.
The successful result is `RESTORE_VERIFIED_NOT_ACTIVATED`; ordinary boot remains
refused. There is no ignore-quarantine option, activation API, automatic fallback,
source stop, quota refill or replay. A later protocol must fence the old writer,
reconcile the independent trusted head and transfer authority before activation.
Manually renaming/removing guards is not that protocol.

Path operations require an owner-controlled parent directory. They do not claim
protection against a hostile local process concurrently replacing directory
components or tampering with files using the same account/key. Symlink checks
and fixed filenames are not a general filesystem sandbox.

## Evidence and remaining gates

Synthetic tests cover live export with unchanged disk/RAM state, quota and
revocation in a verified RAM image, independent-process verification, mandatory
pins, equal/later/fork/prefix behavior, malformed/unknown/oversized/missing
packages, path traversal and symlinks, schema/foreign-key/FTS corruption,
export/restore faults, completion fsync failure, and source usability afterward.
A new child process exits directly after restore mkdir; the resulting empty
directory is refused by ordinary boot with no writer file created.

The first Windows sandbox run had 3/33 passing: final manifest rename was refused
with `EPERM` in the sandbox Temp directory. Native Windows Temp execution retained
the publication gate. A subsequent fixture correction disabled defensive mode
only inside the synthetic FTS corruption builder and corrupted an actual FTS
data block; production defensive mode remained enabled. These intermediate
failures are not presented as passes. Final author results and independent review
are recorded by the integrating Root; full regression/CI/native deployment are
separate gates. Only fresh synthetic `os.tmpdir()` data was used.

Unimplemented: restore activation/fencing, independently operated pin custody,
key escrow/rotation/migration, old-format import, compaction/retention/tiers,
historical archive completeness, multi-device synchronization, durable fanout,
long-duration/capacity benchmarks and power-loss qualification. This slice grants
no training, provider-call or production-deployment authority.
