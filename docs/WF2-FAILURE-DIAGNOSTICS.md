# WF2 failure diagnostics

This source slice adds a content-free `wf2-failure-diagnostic/1` record with exactly `version`, `stage`, and `code`. The stage is set at the executing request, validation, storage or gate boundary, not inferred from the latest provider attempt. Codes come from an exact source-owned allowlist; arbitrary exception text, paths, response values, artifact identifiers and family identifiers are never projected. `responseFailureCode` continues to describe the latest response independently: `NONE` does not mean the local plan or candidate passed.

The diagnostic is committed in the same authenticated ledger update as `STOPPED`. Candidate and review validators retain swallowed rejection codes when the corresponding first-four gate stops the run. The recorded terminal `state.code` remains that original coarse gate; `failureDiagnostic.code` describes its captured cause. A candidate target and its artifact reference become available together only after the artifact write succeeds, so a failed write cannot start review or count as a qualified candidate.

Live terminal metadata and the diagnostic come from one fresh observation before owner withdrawal. Stale authority, a changed head or a half commit yields an unknown diagnostic. A legacy record without a diagnostic may project an allowlisted recorded code with stage `UNKNOWN`; it never reconstructs a historical stage. Cold inspection shares this projection, labels it `RECORDED_CLAIMS_ONLY`, makes no provider call and does not read rejected or sealed payloads. Revoked history remains a recorded claim and cannot resume execution. Existing archived campaigns still require their archived source build; no historical failure has been regraded.

The new closed outputs are:

| Output | Version / addition |
|---|---|
| Campaign operational snapshot | `wf1-operational/2`, adds `failureDiagnostic` |
| Worker description | `wf2-teacher-worker-description/4`, declares diagnostic vocabulary and output versions |
| Worker stopped event | `wf2-worker-event/3`, adds `failureDiagnostic` |
| Bridge receipt | `wf2-teacher-bridge/3`, adds `failureDiagnostic`; stopped metadata file version 3 |
| Non-pilot cold inspection | `wf2-teacher-inspection/4`, adds `failureDiagnostic` |
| Pilot cold inspection | `wf2-teacher-inspection/5`, adds `failureDiagnostic` |

Other worker events, DSH operations, bootstrap/request contracts, `TeacherSafeMetadata`, service replies and completion ACK semantics stay unchanged. New diagnostics are not silently accepted inside those legacy closed objects. Bridge completion has an unknown failure diagnostic, not an invented success diagnosis. Inspection refusals also carry an unknown diagnostic.

`WF1_SPLIT` and `WF1_PAIR_BINDING` now have local-schema classification, with the other bounded parser/formal validation codes. In the existing fixed-slot lane, a wrong slot split is rejected earlier as `WF2_SLOT_WIRE_REJECTED`; this distinction is tested. These coverage fixes alone do not establish the cause of the retained medium experiment. A subsequent authorized, authenticated metadata-only inspection identified its recorded terminal code as `WF1_PAIR_BINDING`, after a completed plan response (T2/DS0, sealed true, planned false). In the original source that code rejects paired IDs outside the authored family list; no offending IDs or private payload were inspected, repaired or re-evaluated. That run remains negative with zero qualified training rows.

Validation is synthetic and focused: source throw-code coverage, actual plan rejection, swallowed candidate/review rejection, candidate storage failure, pre-dispatch stage binding, stale/half-commit erasure, revoked cross-process inspection with unavailable payload artifacts, and closed worker/bridge projection. Provider calls, external Harness execution and historical payload inspection are not part of this diagnostic slice.

The subsequent [`.8` unit pilot](WF2-UNIT-PILOT.md) retains these Phase A rules and adds diagnostic version 2 with a trusted `unitIndex` (0–3 or null), worker description version 5 and unit inspection version 6. Its new metadata profile alone carries validated persisted-unit counts; legacy metadata stays closed.
