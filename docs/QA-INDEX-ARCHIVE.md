# QA index archive metadata reuse

This slice opens an already accepted F1 or F2 QA index after its execution authority
expires or is revoked. It exposes a private verified metadata view and writes a
new encrypted selection manifest. It never restores sending/resume rights, reads
source samples or verdict notes, retokenizes, or authorizes Student training.
`HostAuthority` and `QualityAuditStore` retain their existing expiry rules.

## Trusted host inputs

`openQualityIndexArchive` in `src/corpus-qa-index-archive.ts` requires an explicit
training root, source runtime, independent authority path, key, descriptor,
externally pinned descriptor digest, loaded reader closure digest, and current
admission callback. No directory discovery or real descriptor preparation is
implemented. Descriptor preparation requires a separately authorized metadata
read. All descriptors, index entries, source IDs, fingerprints, refs, family/pool
labels, and token lengths are private.

The host must independently verify/pin its loaded reader closure, the producer
build, the accepted cold receipt's raw digest and full reconstructed index digest,
and the descriptor digest. A file declaring a build digest does not authenticate
that build. A cold receipt JSON is not a signature. The reader does not discover,
load, or execute code from the archived directory, or read the cold receipt.
The externally authenticated descriptor is its trust boundary.

`QaIndexArchiveDescriptor/0.1` binds the frozen spec/source lineage, ledger and
authority raw SHA-256, authority identity/status/revision/head and sequence,
selection/index/manifest refs and index digest, accepted receipt digest, and
reader/profile digests. The original F1 profile is producer build
`f1b8d25398fc287bc665a2faea38ef00f69a236815057e799b3591fca6e0e9c9`.
`corpus-qa-legacy-f1.ts` freezes its schema, target/model/profile identities and
selection/measurement wire validators. Its constants and archive profile digest
remain unchanged. The separately frozen F2 pair is build
`6f3fdad98aeeb67c9daddb7c05f5b972d7ce0c1f437939e9850967542bd8ba1c`
and QA profile
`a782b492ab39749bf6cf627d824d2a8d89a4d1627fb8bf204d30e0fba810699f`.
Both use `CorpusQualityAudit/0.1` and the same storage schema. F2 changes the
rubric output contract and safe failure codes; source, targets, Student,
tokenizer, retention and crypto constraints remain frozen. A descriptor declares
`QA_F1` or `QA_F2` with its exact corresponding archive profile digest. Mixed
build/profile pairs and unknown writers fail even with an identical schema.
Future builds need a separately reviewed
adapter; changing current target constants cannot reinterpret this archive.

`QaIndexReadGrant/0.1` is a new finite, revocable capability for
`QA_INDEX_MANIFEST_SELECTION_METADATA_ONLY`. Admission also binds current source
read/retention decisions, source purpose and parent grants. Check the current
grant/source before each artifact read, decrypted result, returned view, output
write, and commit. A grant revision/expiry change needs a new reader; a failed or
closed reader cannot revive. The key is copied privately; owned and derived keys
are cleared on close/failure. No credentials or transport enter this interface.

## Read proof and limits

Open SQLite read-only with the exact f1 schema; never open the owner database or
once file. Verify every event's sequence, previous hash, canonical ref and digest
against the pinned authority head. Only the final two event bodies may be
decrypted, and they must be INDEX then MANIFEST. Projection pointers are locators,
checked against these events and the descriptor. Missing manifests, later events
and crash tails fail closed without scanning event bodies or recovery.

Only index header/chunks, source manifest, and manifest-bound selection metadata
are read. Cipher hashes/GCM, kinds, ordered unique chunks, cold index digest,
selection digest, job/unit/pool/family/split/row-ref joins and manifest eligibility
are verified. Original manifest membership must exactly equal the existing
single-index assembly result. Zero eligible rows from a fenced or partial audit
remain valid; rejected/pending rows cannot become PASS. Raw ledger/authority
hashes are checked again before return, with path/link and journal rejection.
Filesystem protection remains cooperative: a malicious same-user host able to
replace trusted pins or process code is outside this capability boundary.

## New encrypted assembly

`writeQualityArchiveAssembly` accepts 1–8 explicitly ordered registered reader
handles, at most 8 × 192 rows, and a separate empty output directory under an
approved root. Copies of returned views are not live capabilities; the internal
handle records are frozen, and each source is checked at output/commit time.

The existing `assembleScopedIndexes` applies exact/NFKC/normalized-prompt rules,
job/family namespaces, first-input duplicate preference, and whole connected
family holds across splits. All index nodes participate, including QA REJECT or
UNCERTAIN bridge nodes. Output is source-manifest membership intersected with QA
PASS and cross-index eligibility. This makes no semantic or all-history guarantee.
Student/tokenizer/generation/audit target and QA purpose profiles must match.
The manifest records each source lineage and input order. Token totals come from
the bound source selection measurements, without sample reads or tokenization.
Overlapping source job/unit identities still fail with `CQA_INDEX_CONFLICT`.
The host must explicitly exclude a superseded failed audit before assembly;
the library does not choose the best verdict independently for each row.

The writer now creates `QaArchiveAssemblySelectionManifest/0.2` with matching
`QaArchiveAssemblyChunk/0.2`, `QaArchiveAssemblyReceipt/0.2`, and cipher AAD/KDF
domain `/0.2`. Each input records its F1/F2 writer profile and the verified
manifest's rubric reference and ciphertext digest. `rubricContentDigest` is
always `UNKNOWN_NOT_INDEXED`: a public output-contract digest is not a digest of
the audit's particular rubric text. Different audit rubric references/digests
need not agree. Rubric bodies are never read. Existing `/0.1` files/receipts are
unchanged and unsupported by the new cold consumer; no upgrade or recovery is
inferred from their presence.

The writer uses encrypted chunks of at most 32 selected metadata rows and an
encrypted manifest. It returns only aggregate counts/token totals and digests.
Every output remains `MODEL_OPINION`, factual truth and false-acceptance rate
`UNKNOWN`, `trainingReady=false`, and `trainingJobPolicy=NOT_AUTHORIZED`.

Final creation uses `wx`, so a concurrent destination file is never overwritten.
The encrypted pending copy is retained. File existence is **not** a successful
commit: acceptance requires the successfully returned receipt, matching full
ciphertext `commitDigest`, complete GCM authentication and plaintext
`manifestDigest`. An interrupted/truncated final file, thrown write, or missing
receipt has no success claim and must not be consumed or automatically retried.
A grant withdrawal after output creation may leave encrypted files while the
operation refuses to return a receipt. Source-row dereferencing is a separate
future authorization.

## Cold metadata verification ABI

`openQualityArchiveAssembly` in `src/corpus-qa-archive-assembly.ts` accepts:

- `approvedTrainingRoot`, `runtimeRoot`, `assemblyId`, an assembly key supplied by
  the trusted host, `readerBuildDigest`, and `purposeDigest`;
- the successfully returned `/0.2` `receipt` and its independently pinned
  canonical SHA-256 `receiptDigest`;
- 1–8 explicitly ordered `readers`, newly opened with `openQualityIndexArchive`
  and current per-source grants; their descriptor digests must equal the receipt's
  `inputDescriptorDigests` in that exact order;
- `admission: () => QaArchiveAssemblyReadGrant` and optional test clock `now`.

The finite `QaArchiveAssemblyReadGrant/0.1` contains `grantId`, `revision`,
`receiptDigest`, `purposeDigest`, `status`, `readAllowed`, `retainAllowed`,
`validFrom`, `expiresAt`, and `scope: QA_INDEX_MANIFEST_SELECTION_METADATA_ONLY`.
Its identity cannot change during one reader lifetime. The host authenticates
the receipt's provenance and pins its loaded code closure; a JSON found beside
the ciphertext is not proof that the writer successfully returned it. This API
does not discover receipt files, obtain keys, or issue grants.

The frozen handle exposes only `check()`, `readVerifiedReceipt()`, and `close()`.
`check()` checks current permission/source snapshots and the committed file hash;
only `readVerifiedReceipt()` performs full cold verification. It authenticates
the full manifest ciphertext/GCM and plaintext digest, reconstructs every source
metadata view, reruns `assembleScopedIndexes`, and compares exact input lineage,
all selected metadata rows, 32-row chunk order/size/count, membership, inherited
measurements and train/dev token totals. It rehashes all consumed chunks and the
manifest before returning the aggregate receipt. It exposes no row accessor.

Each file read, unsealed value and final result requires the current assembly
grant and every current source/parent-retention check. Failure or close clears
the owned key and permanently closes the handle; derived keys are cleared after
each artifact. Renewing a grant requires a new reader. Old execution authority is
never revived. Missing receipts, missing final files, truncated or altered data,
foreign inputs/profiles and withdrawn sources fail; encrypted pending copies are
never consumed, promoted or automatically retried. Cross-process receipt custody
and any real host rollout remain separate from this library's synthetic checks.

Run `node scripts/qa-archive-cold-synthetic.ts` for an executable fixture-only
example of writer close, fresh source readers, independent cold permission,
full verification and permanent refusal after withdrawal. It creates fresh OS
temporary artifacts and synthetic keys, prints only aggregate counts/digests,
and never accepts a real corpus path, reads sample bodies or calls an API.

## Synthetic validation

`test/corpus-qa-index-archive.test.ts` covers frozen producer compatibility,
expired/revoked legacy execution, current grant denial and revocation mid-read or
precommit, read/SQL spies, ledger/authority/projection/orphan/terminal attacks,
wrong chunks and metadata substitutions, source joins, deterministic dedup and
rejected A–B–C bridges, zero eligible rows, maximum 1536 rows, key ownership and
zeroization, immutable capabilities, link/journal/mutation rejection, exclusive
commit and truncated ciphertext. Fixtures create fresh temporary directories;
no real archive, API, harness or Student training is used. Existing QA regression
is run separately from whole-project/CI acceptance.

`test/corpus-qa-archive-cold.test.ts` additionally covers exact F2 admission,
mixed F1/F2 provenance, absent/foreign `/0.1` receipts, external pin failures,
full-hash/GCM failures, malicious but authenticated rewritten metadata/rows/token
totals, changed input order, rubric-content mislabeling, missing/duplicate/reordered
chunks, mid-read grant/source withdrawal, concurrent artifact mutation, closed
handle/key ownership, source overlap refusal, zero rows and the full 1536-row
cold reconstruction. These tests do not confer real data or training acceptance.
