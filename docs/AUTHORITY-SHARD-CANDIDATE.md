# Authority cold shard candidate

`src/authority-shard-candidate.ts` offers a RAM-only, **UNANCHORED_CANDIDATE** over one existing cold payload of at most 1 MiB. It does not take an authority handle or perform file I/O. It cannot archive, select a persistent root, activate a candidate, resume publication, or admit business operations. Passing validation does not make the input current or authoritative.

```ts
const candidate = buildCandidate(sourceBytes);
try {
  const view = candidate.open(candidate.parts);
  try {
    const result = view.receipt(vaultId, operationId);
    if (result.outcome === 'CANDIDATE_FOUND') {
      try { consumeCandidateJSON(result.value); }
      finally { result.close(); }
    }
    // CANDIDATE_ABSENT means absent in this candidate, not in authority history.
  } finally { view.close(); }
} finally { candidate.close(); }
```

Every view and query result carries `status: 'UNANCHORED_CANDIDATE'`. Malformed bytes, incomplete shards, conflicts and budget refusal throw; none become `CANDIDATE_ABSENT`. `raw(kind, primaryKey, operationId?)` returns exact R/S/L/M cells and `epoch`; R requires both vault and operation IDs. `receipt` resolves raw or IF8 receipts to the original JSON text. `legacyByMigration` and `legacyByVault` check both shards. `maintenance({operationId, expectedRouteEpoch})` returns the complete original M row for the exact request, rejects a conflicting request, and does not execute maintenance.

The candidate is a frozen closure with private construction state; there is no constructor accepting a caller-supplied trusted root or digest. Each construction assigns a fresh UUID to the shard container's `operationId` and binds its request digest. Other metadata fields are copied declarations, with per-shard counts. This label is not an executed authority operation. Internal expected image sizes/digests and the source row digest bind `open` to that construction, including when another candidate used identical source bytes. An object that merely imitates the interface cannot change that private state. No API here is an authority authentication mechanism.

Partition 0/1 is the low bit of the first SHA-256 digest byte over the existing typed, length-prefixed `hashRows` framing of **kind plus the full primary key** (both R components). Final lookup compares full keys. Both shards, including an empty one, are mandatory and opened completely. `open` validates each image with `ColdDatabase`, checks each row's partition, merges in key order with duplicate rejection, and compares the framed complete values plus moved epoch and total counts with the construction source. R/S/L/M payload bytes are retained unchanged; metadata is not an authority descriptor.

Candidate-local checks additionally require:

- L's lineage/migration/vault columns to match the JSON declaration, with all three identities unique across shards.
- IF8 canonical pointers and bounded segment decoding, with exactly one matching R pointer for every entry and no orphan pointers. A segment and its pointers may reside in different shards.
- M's canonical complete request/receipt pair, original moved-epoch relation and unique receipt epochs. Repeated exact queries return original bytes; conflicting requests are rejected.

`ColdDatabase` validates physical layout, counts and epoch bounds. Candidate-local checks do **not** validate V/current-head closure, legacy proofs/admission, current ownership/fencing, storage paths, or the full authority business protocol. R validation uses the existing receipt-entry codec, not complete `VaultHead` authentication. A structurally consistent input with unverified business claims remains an unanchored candidate.

The source is copied before parsing and remains untouched. `open` rejects proxies, accessor-based shard tuples, shared backing stores and resizable buffers, and snapshots caller byte views before SQLite opens them. Intrinsic typed-array getters bypass caller byte-accessor overrides. Exposed API-owned buffers cannot be transferred/detached; changing their contents can invalidate future `open`, but cannot modify an already opened view or its private expected digests. Teardown uses private byte views captured before exposure, with a captured fill intrinsic and result accounting released in `finally`. Public part views are distinct from the byte objects held by the existing serializer's cleanup. Caller changes to a returned BLOB's or part's own `fill` property, getters or prototype cannot participate in cleanup or prevent BLOB clearing and ticket release.

Both serialized images **together** must fit the existing 1 MiB payload cap. The second schema and SQLite page overhead count toward it, so a valid source near the cap may be refused. One existing `ColdWorkspace`, at most 12 MiB (optionally lowered by the second `buildCandidate` argument), charges the source copy, builders, output images, input snapshots, both opened databases, row/JSON representations, IF8 decode and outstanding returned values before their allocations. `candidate.workspace` exposes only used/peak/limit counters. Multiple opens and unclosed query results share that pool and can exhaust it. Result close releases its charge and clears owned BLOBs; view close closes all its results, and candidate close closes every view and output. Repeated close is harmless. Getters and queries reject closed objects.

This is an accounting bound for this API's live owned working set, following the existing workspace contract. It is not a measured process RSS guarantee and does not bound caller copies, pre-existing input allocations, immutable values retained by the caller after close, or all SQLite/V8 allocator overhead. There is no lazy open or demonstrated RAM/I/O reduction. The candidate's extra source and output copies are intentionally charged while it is open.

The focused `test/authority-shard-candidate.test.ts` uses codec-only synthetic rows for adversarial cases and an original public synthetic authority flow for real-format cold bytes. Its cross-candidate test proves binding rejection only; it is not stage/COMMIT crash recovery. This slice does not add a fifth maintenance epoch, reusable slots, unlimited history, a new active root, durable publication/recovery, real data/API execution, or training. Existing caps and the active authority protocol are unchanged.
