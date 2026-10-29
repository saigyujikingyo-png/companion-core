# Trusted teaching-cycle host (S4)

This slice connects the [real-plan cycle](TEACHING-CYCLE-REAL.md) to a bounded Node
worker and a Windows PowerShell 5.1 launcher. It does not change the cycle journal
format, add a second execution ledger, authorize Student work, or turn a source
freeze or synthetic test into actual production acceptance. Frozen S3 jobs still
need their matching build; no consumed job is migrated to these new bytes.

## Stable child authority before source/archive capture

The optional `TeachingCyclePorts.finalizeProductionSource(child, production)`
returns a reopened `ProductionStore`. The runner calls it only after measurement,
export and export verification, before `prepareQualitySelection`. The portable
host closes the old store, calls the narrow
`production.finalizeAuthority({specDigest, committedHead})` hook, then opens inspect
and verifies the same spec/head and REVOKED authority. A host either supplies this
hook for all children or supplies none; the older path remains available without it.

The runtime hook uses `finalizeTeachingAuthority`: it checks the fixed job,
runtime, original revision, expiry and expected head under the existing authority
SQLite lock. It changes ACTIVE to REVOKED exactly once, incrementing the revision
once. An already matching REVOKED record is checked without rewriting its bytes.
PAUSED, wrong identity, wrong head or a different revision is rejected. Keys remain
in the trusted host closure and are not arguments to the finalizer.

Two crash windows have explicit recovery:

| Parent stage and current child authority | Allowed work |
| --- | --- |
| TOKENS, fixed production authority REVOKED | Open production inspect; verify completed state and full existing measurements/export, then prepare selection from those frozen bytes |
| INDEX, fixed QA authority REVOKED | Open audit inspect; verify completed QA and require both index and manifest, then seal/reopen those bytes |
| Any other stage, PAUSED or mismatched authority | Reject; inspect cannot authorize forward work |

Both inspect guards run before calling the older child runner. Recovery cannot
generate, measure, export or send again. Missing export/index artifacts remain a
failure; they are not repaired under revoked execution rights. The authority's
current head must still match the child's authenticated ledger.

`archive.seal` receives `committedHead` captured from the verified QA store before
its handles close. The runtime revokes that exact head and calls
`sealTeachingQaArchive`; descriptor and source hashes therefore capture the final
authority bytes. The terminal controller revokes only the cycle authority.
Previously sealed child authorities are never rewritten during cleanup or cold
verification.

## Runtime entrypoints

- `runtime/teaching-cycle/teaching-host-bindings.mjs`: validates the frozen config,
  Root admission, source pins and current grants; composes actual production/QA
  transports, the official pinned tokenizer and the host; binds selection/archive
  grants and implements fixed-head finalizers.
- `runtime/teaching-cycle/teaching-native-worker.mjs`: reads at most 64 KiB from an
  anonymous stdin pipe, verifies source pins before importing project execution
  code, runs one explicit action and emits only bounded safe aggregates. It has no
  environment-based credential lookup or arbitrary plugin loading.
- `runtime/teaching-cycle/Invoke-TeachingCycle.ps1`: verifies approved config and
  executable/source pins, owns Windows processes, handles private DPAPI envelopes,
  consumes the run once record, and compares a real independent cold process.
- `runtime/teaching-cycle/teaching-revoker.mjs`: the small fixed-identity/head CAS
  helper shared by child finalization and emergency cycle revocation. Its explicit
  transitive import closure excludes generation, QA, tokenizer and admission code.

Only those reviewed sources are exempted from the repository's runtime
ignore rule. Keys, DPAPI files, configs, grants and actual runtime artifacts remain
outside Git and outside the source checkout. The portable core takes an explicit
approved training root. The Windows production launcher separately enforces this
deployment's approved D-drive root; it has no C-drive fallback.

## Frozen config contract

`validateTeachingConfig` is the code authority for the closed config shape. A
public preview is not an executable config. The final caller must provide the
trusted SHA-256 of the exact config bytes to the launcher.

| Field | Contents |
| --- | --- |
| `version` | `TeachingCycleHostConfig/0.1` |
| `environment` | `PRODUCTION_NATIVE` or clearly labeled `SYNTHETIC_FIXTURE` |
| `sourceRoot`, `sourcePins` | Exact source directory; `{path, sha256}` for every `TEACHING_CYCLE_BUILD_FILES` entry plus `HOST_FILES`, with no extras |
| `approvedTrainingRoot`, `controlRoot` | Explicit disjoint paths; controls/authorities and secret custody are outside the corpus tree |
| `cycle` | `{runtimeRoot, authorityPath, spec}` |
| `plan`, `objective` | Frozen real-plan envelope and coordinator-approved teacher objective |
| `children` | Fixed child production, audit and archive bindings below |
| `tokenizer` | `{profile, pythonPath, runtimePin}` using the existing official profile and worker; runtimePin is a raw-byte `{path, sha256}` reference |
| `admission` | Root/document/evidence pins below |
| `launcher` | `{nodePath, nodeSha256, shellPath, shellSha256, timeoutMs, credentialsDpapiPath}` |

Each child has `childId` and:

- `production`: `{runtimeRoot, authorityPath, spec, registry, purposes}`.
- `audit`: `{runtimeRoot, authorityPath, template, purposes, grantPath,
  grantTemplate}`. The `TeachingAuditTemplate` omits only `selectionDigest`,
  `populationDigest`, `readGrantDigest`, `purposeDigest` and `rowCount`.
- `archive`: `{readerBuildDigest, grantPath, grantTemplate}`.

The source grant template uses the existing `CorpusArchiveReadGrant/0.1` fields,
excluding `selectionDigest`, `purposeDigest` and `sourcePurposeDigest`. The archive
grant template uses `QaIndexReadGrant/0.1`, excluding `descriptorDigest` and
`purposeDigest`. Those digests are derived from the actual verified artifacts.
The host uses CreateNew for the first grant and compares every field on subsequent
opens. It never generates a replacement ID, timestamp or revision on resume. The
original Root-approved templates are the authority for these derivations; model
responses cannot issue a grant. Current production/QA purpose manifests still pass
the existing route-specific validators, including parent chains. A data `training`
purpose is not authorization to execute a Student job.

The source roots may contain spaces and Unicode. The fixture config/control paths
explicitly include both, and the Windows test exercises them through argv and the
private UTF-8 pipe. Source pins include the exact Python worker bytes; actual
tokenizer assets/runtime continue to be checked by the existing official worker.
No actual mentor, credential or private corpus path is embedded in public fixtures.

The launcher rejects reparse points in source files and their parent directories.
A OneDrive development worktree can have a reparse-point ancestor even when its
source files are ordinary files. Stage the exact current `TEACHING_CYCLE_BUILD_FILES`
and `HOST_FILES` closure, preserving relative paths, into a new ordinary local directory
outside OneDrive. Verify every raw SHA, then freeze that directory as `sourceRoot`
in the actual config. Run and cold verification both use this same copy. Do not
copy `.git`, old runtime data or private configuration. The Windows synthetic
tests use the same staged-source pattern, including a Unicode/space directory.

`runtimePin` references the approved `S2CurrentPublicTokenizerPin/1` document.
The host verifies all 84 `runtimeFiles` against their byte hashes at open, again
immediately before measurement, and when the independent cold host opens.
`pythonPath` must equal `runtime.executable` and be present in that list; the base
executable must also be listed. Runtime version fields must match the tokenizer
profile. An unchanged version string cannot hide changed executable/library bytes.
Public asset metadata is bound to the profile, and the existing official worker
checks tokenizer/template bytes when it runs. This proves the declared 84-file
closure, not every possible standard-library or transitive dependency. Historical
S2 test-only labels (including `scope: S2_SYNTHETIC_TOKEN_MEASUREMENT_TEST_ONLY`)
and all 18 original top-level fields remain in the pinned document; none is
rewritten or reinterpreted as a new grant. The new RootAdmission and frozen config
provide this cycle's authority. The host never refreshes an approved pin itself.

## Root admission and mentor evidence

`admission` has `{rootRecord, curriculum, projectUseRecord, mentorEvidence}`.
Each of the first three fields is `{path, sha256}` over raw file bytes. The course
and use record also must match their JSON canonical digests in the plan.

The Root record is `TeachingCycleRootAdmission/0.1` with exactly:

```text
cycleId, planDigest, approvedObjectiveDigest, curriculumDigest,
projectUseRecordDigest, mentorViewVersion, mentorViewDigest,
productionSpecDigests, mentorEvidenceDigests, approvedActions,
validFrom, expiresAt
```

Execution requires `GENERATE`, `QA`, `METADATA_READ` and `RETAIN` in approvedActions;
independent inspection requires `METADATA_READ` and `RETAIN`. Explicit Resume also
requires `RESUME`. These are trusted human/coordinator approvals, not inferred
service guarantees. A changed or revoked pinned Root record is rejected. Execution
authority may be revoked while that independent metadata permission remains valid.

Each mentor evidence entry has the plan's five mentor binding fields plus
`evidenceKind` and `files`. `files[0]` is the original JSON completion-evidence
object: its **canonical JSON digest** must equal `completionEvidenceDigest`.
Every file separately carries its raw-byte `{path, sha256}` pin. This is neither
the advice object's digest nor a raw file hash substituted for the completion
digest. Supported evidence labels are `ROOT_OBSERVED_CONTROL_PLANE` and
`CLI_RESULT_SUCCESS_AND_SCHEMA_VALID`; the trusted Root authenticates the underlying
evidence before approving its digest. Runtime integrity checks do not independently
prove a provider's identity or add an absent stop reason/effort echo.

The course and ProjectUseRecord are reviewed metadata, not grants by themselves.
The runtime does not create `ServiceTermsVerified`, turn a successful reply into
permission, or send mentor advice/use metadata as teacher training rows or prompts.
The teacher receives the approved objective, existing baseline and assigned slots.
Slots/pools can cover the approved Chinese, emotion, reasoning and tools curriculum;
the implementation does not force six items or a mathematics-only course.

## Launcher actions, ownership and secret lifecycle

Invoke with the approved PowerShell binary and explicit arguments:

```powershell
& $approvedShell -NoProfile -NonInteractive -File $pinnedLauncher `
  -Action Run -ConfigPath $frozenConfig -ConfigSha256 $approvedConfigSha256
```

`Preflight` reads only public/approved metadata and source pins. `Initialize`
requires new control/custody directories, installs private ACLs, generates a new
32-byte master key protected with current-user DPAPI, and creates initial fixed
authorities. Keep the frozen config/evidence outside the new control directory so
Initialize does not encounter an existing directory. Partial initialization is
preserved for diagnosis; it is never overwritten or automatically renamed.

The scoped credential envelope at `credentialsDpapiPath` is separately prepared by
the trusted operator using current-user DPAPI, containing only the two explicitly
selected `deepseek` and `together` credentials. It is never created or read by public
preview builders. The master-key envelope is `controlRoot/custody.dpapi`. The host
derives separate cycle/child/role keys using HKDF with the cycle ID and
`TeachingCycleKeys/0.1` domain. Only current-run keys are sent through the anonymous
pipe. Owned byte buffers are cleared on close/failure. Managed JSON/credential
strings are discarded and the worker exits; forensic erasure of managed strings
is not claimed.

`Run` atomically consumes `run-once.intent.json` before reading any key, credential
or starting any worker. A repeated Run returns `REFUSED_ALREADY_CONSUMED` with zero
new workers, key/credential reads and provider calls. `Resume` is a separate explicit
call authorized by Root, using the same config/spec/cycle/once. It cannot revive a
revoked parent, replace IDs, create another once record, retry consumed UNKNOWN,
or reclaim old held leases. Each new worker reports its actual new PID/birth;
it never pretends to be the prior owner. If an interrupted Run/Resume has a real
receipt proving the worker and all owned descendants exited, the controller leaves
the original ACTIVE authority/revision untouched and reports
`NOT_REQUESTED_CONFIRMED_EXIT`. This only permits a later explicit Resume to attempt
the existing ledger gates; it does not clear UNKNOWN/pending leases or prove remote
completion. A revoked parent cannot be revived by Resume.

The parent records process birth from Windows before sending bootstrap data,
assigns the worker to a private Job Object, and only then writes stdin. The job
does not enable breakaway, and its close policy terminates owned descendants. A
successful process receipt requires observed main-process exit and zero active
owned processes, using the Windows
[job accounting API](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information).
The [job limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
and held native handles are the mechanism; PID disappearance or TTL is not proof.
The private bootstrap is encoded as explicit UTF-8 without BOM and written as
bounded bytes through the pipe's BaseStream; console code pages cannot change it.
Owned byte buffers are cleared after write or failure. Timeout, pipe failure or
uncertain ownership produces `REFUSED_OR_UNKNOWN`, no automatic retry and no claimed
owned exit. It requests cycle revocation. Automatic local reclaim remains disabled.

After a verified complete run the controller closes execution, revokes the cycle authority, and
starts a new inspect worker with the key but **no provider credentials**. It compares
the entire report and all committed binding digests before emitting
`FINAL_COLD_VERIFIED`. Incomplete cycles or pending/remote UNKNOWN cannot pass that
publication gate. Missing usage is separate from unresolved work and is not
converted to zero. `ColdVerify` alone emits `INDEPENDENT_INSPECTION_ONLY`; without
the matching run comparison it cannot publish a final wrapper.

Reports use bounded ordinary JSON and an explicit safe-report shape. Finite
fractional throughput is accepted; NaN, infinity and fractional integer fields
are rejected. The integer-only journal parser is not used for the whole report.
`Revoke` and failure cleanup touch only the fixed cycle authority, never the frozen
child authorities or the once record. They validate the frozen config, own
launcher/worker/revoker bytes, Node executable and the revoker's explicit transitive
import closure before the same SQLite-lock CAS. A changed production module, expired
Root record or withdrawn corpus metadata permission cannot block this authority
reduction. Changed critical revoker bytes or an unconfirmed target still refuse;
failure output reports `revocation: NOT_CONFIRMED`, never a success claim. No key,
provider credential, source row or mentor evidence is read for revocation. Safe
outputs contain no config, credential, raw provider text, source rows or mentor advice.

## Acceptance boundaries

The targeted synthetic suite is:

```text
node --test --test-concurrency=1 test/teaching-cycle-finalization.test.mjs test/teaching-launcher.test.mjs
```

It includes actual store/transport codecs with injected HTTP, intercepted tokenizer
receipts, cold processes, fixed-head crash recovery and denial cases. Windows-only
tests cover actual DPAPI on synthetic keys, anonymous stdin, Job ownership,
Unicode/space paths under a non-UTF-8 console, finite fractional report parsing,
duplicate Run, timeout, minimal-closure emergency revocation,
and controller-level child-freeze interruption followed by explicit same-config
Resume. For the two interruption cases only, a clearly synthetic replacement
worker in the temporary source snapshot injects transport/tokenizer results and
exits at the chosen boundary; the launcher itself is copied unchanged.
Those tests skip on non-Windows systems and do not imply cross-platform launcher
support. The separate v0.1 pipeline/current-grant regressions cover the shared
runner's unchanged path. Official tokenizer and actual provider runs remain separate
evidence; the source freeze/handoff records which checks actually ran.

The first final-candidate Windows run on 2026-10-29 recorded 12 passes and
4 failures across 16 tests. Three launcher failures were traced to PowerShell
5.1 nesting the JSON revocation-path array inside `@(...)`, causing exact
membership checks to reject before starting the revoker. The v2 candidate
explicitly enumerates and validates the same pinned string-path set; it adds a
PS5.1 regression for flat, nested, duplicate and non-string arrays. The separate
QA freeze/recovery test returned ACTIVE in that original run. A fresh single-test
synthetic diagnostic run passed, but did not reproduce the error; the original
cause remains UNKNOWN. Safe assertion diagnostics are retained without changing
production recovery, fences or timeouts.

The original failed receipt remains valid historical evidence. At the v2 freeze,
the seven Windows launcher tests (six existing and the new array regression)
still require normal-machine validation. The passing QA diagnostic is reused;
complete core coverage follows in the three-platform CI run. Neither the source
review nor that isolated pass replaces the original failures with acceptance.

The intended first actual run is the independently approved 16-candidate calibration.
Any subsequent 768-candidate cycle is a new separately admitted cycle after the
declared quality gate. This launcher does not autonomously start it or combine its
report with calibration as an all-history deduplicated corpus. Old failed/private
corpora and sealed evaluation are outside the configured source scope.
