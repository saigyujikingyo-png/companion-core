# HS0/NM0 implementation and acceptance plan

This slice implements SP03 H01/H02 and the text protocol / image boundary of SP04 H05. It follows accepted HS0/NM0 contract revision 002, SHA256 `8efd3166e18ab7f74a4b5eeb35b7592bab78ab3c0dbd118dbe5bff923eda4694`, on source baseline `0a640d7b3761831df84f3084b1abe1f0c125e4c4`. Author validation is `SYNTHETIC_COORDINATION_PASS`; independent code review remains pending. It does not complete SP03 or SP04.

The implementation is confined to `hybrid-profile.ts`, `hybrid-wire.ts`, `hybrid-inference.ts`, their three corresponding tests, and these two documents. A separately authorized documentation change synchronizes the shared efficiency rules in `AGENTS.md`. Existing contracts, HTTP adapters, runtime, Store, authority, Safety, entrypoints, packages and CI remain under their existing owners. No dependency is added.

The profile module copies closed own-data records, rejects proxies/accessors/symbols, canonicalizes declared modality/state sets, and hashes the full profile and binding. The wire module encodes bounded selected text and accepts one exact stamped final Proposal. The coordinator owns a shared worker lane, session leases, lifecycle consumption, currentness checks and the existing InferenceAdapter bridge. See [the interface and limitations](HYBRID-PROFILE.md).

The accepted fixture mapping is executable in the new tests:

| Cases | File | Checks |
|---|---|---|
| F01–F03 | `test/hybrid-profile.test.ts` | All profile/binding dimensions, canonical sets, ordered refs, strict data shape and bounded identifiers |
| F04–F07 | `test/hybrid-wire.test.ts` | Existing evidence/proposal semantics, final-only protocol, every identity stamp, malformed bytes and media rejection |
| F08–F11 | `test/hybrid-inference.test.ts` | Literal-true checks in all three phases; abort, rebind, close and stale replies |
| F12–F14 | `test/hybrid-inference.test.ts` | Stable-ID replay/conflict/UNKNOWN, raw physical occupancy, cross-session isolation and shared lifecycle limits |
| F15–F18 | `test/hybrid-inference.test.ts` | Unsupported tensor operations, stable-ID adapter bridge, copies/reentry and qualification boundaries |

Author checks run only synthetic fakes in native temporary storage, one Node process at a time, one test worker, `--max-old-space-size=128`. Each process has a 60-second deadline; all focused tests plus focused TypeScript share 180 seconds. Fresh free RAM must be at least 1 GiB, disk at least 64 MiB, retained artifacts at most 8 MiB, and measured process RSS at most 256 MiB. RSS is measured externally, not inferred from the V8 heap flag. A failure or refusal is retained unchanged; no whole-suite fallback, budget increase, real provider, model, audio, container or training run is admitted here.

The TypeScript check covers the three new modules/tests with the repository's strict flags and their imported `contracts.ts`, `validation.ts` and `wire.ts`. It is a focused check, not an assertion about the whole repository. A separate exact candidate manifest binds the explicit source/test/config allowlist and execution receipts for independent review. No commit, push, merge or deployment is performed by this slice.

Author results: the 18 planned fixtures pass (3 profile, 4 wire, 11 coordinator tests, with denial and identity matrices inside those tests), and focused strict TypeScript passes. The first TypeScript attempt failed because its temporary working directory did not locate the existing Node type definitions and ES2023 did not declare `String.isWellFormed`. The runner now specifies the installed type root; the implementation uses an equivalent Unicode lone-surrogate check. The original failure remains preserved. Affected tests were rerun after that change; counts are not summed across attempts. No whole-suite, cross-platform CI, real backend, loaded-model or hardware result is claimed.

Remaining owner work: wire currentness into real Store/source/permission checks and persistent request-consumption authority; qualify a real service mapper and loaded assets; separately admit image processing, tensor cache operations, hardware capacity and model quality. A fresh lane, session or process is never authority to retry an UNKNOWN request.
