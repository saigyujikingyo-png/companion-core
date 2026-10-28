# QA index archive metadata reuse

This slice opens an already accepted f1 QA index after its execution authority
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
reader/profile digests. The only legacy profile is producer build
`f1b8d25398fc287bc665a2faea38ef00f69a236815057e799b3591fca6e0e9c9`.
`corpus-qa-legacy-f1.ts` freezes its schema, target/model/profile identities and
selection/measurement wire validators. Future builds need a separately reviewed
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
operation refuses to return a receipt. No cold assembly consumer/recovery API is
provided in this slice; any future consumer must independently authorize access,
verify those bindings and recheck source retention. Source-row dereferencing is
a separate future authorization.

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
