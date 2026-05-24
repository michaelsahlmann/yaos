# s13-linux-android-editor-open-remote-edit — PASS

**Date**: 2026-05-24T09:24:00Z
**scenarioRunId**: s13-linux-android-2026-05-22
**scenarioId**: s13-linux-android-editor-open-remote-edit
**qaTraceSecretHash**: sha256:9eaa2ab7e85695a5d8c4fc7c12f78239dcb6c3e73f308a79e69ba25f873bd894

## Devices

| Device | ID | Platform | Role |
|--------|-----|----------|------|
| Linux desktop (temenos) | abe2a07d | desktop | editor (made the edit) |
| Android (device-mn04msol) | 0e2465b7 | android | passive observer with file open |

## Scenario

Android had `QA-scratch/s13-witness.md` open in the editor.
Linux edited the file via `app.vault.modify`, adding `REMOTE_EDIT_FROM_LINUX`.
Android witnessed the remote edit arriving into the open editor.

## Android bundle evidence

| Event | seq | step | editorSampleKind | stateHash |
|-------|-----|------|-----------------|-----------|
| settled (baseline) | 1 | 1 | healthy_sampled | h:3471ca00... |
| diverged (unavailable, different file) | 2 | 1 | not_open | — |
| settled (remote-apply) | 1208 | 1 | healthy_sampled | h:098f177c... |
| settled (disk-write) | 1209 | 3 | healthy_sampled | h:098f177c... |

**seq=1208**: `originClass: remote-apply` — Android received the Linux edit via CRDT.
`editorHash == crdtHash == diskHash == h:098f177c...` — all three layers agree.
`editorSampleKind: healthy_sampled` — editor binding was healthy when the remote edit arrived.

**seq=2**: `unavailable` divergence is for a *different file* (different pathId/fileId) that was backgrounded. Not related to s13-witness.md.

## Acceptance criteria

| Check | Result |
|-------|--------|
| Android fileOpen=true at baseline | ✓ |
| Android editorSampleKind=healthy_sampled at baseline | ✓ |
| Android baseline: editor/CRDT/disk agree | ✓ h:3471ca00... |
| Android received remote edit (originClass=remote-apply) | ✓ |
| Android final: editorHash == crdtHash == diskHash | ✓ h:098f177c... |
| Android final editorSampleKind=healthy_sampled | ✓ |
| No stale_hash_after_newer_witness | ✓ |
| No recovery_emitted_old_hash | ✓ |
| No editor_crdt_mismatch | ✓ |
| No persistent disk_crdt_mismatch | ✓ |
| No transient_open_editor_disk_lag | ✓ (zero — cleaner than desktop s13) |
| analyzeConvergenceEvidence | ✓ PASS |
| All 6 analyzer rules | ✓ 6/6 PASS |

## Key finding

**No transient disk lag on Android** — unlike the desktop s13 run which had 1 transient
`disk_crdt_mismatch` during editor-open setup, the Android run produced zero. The mobile
stability window (4000ms vs desktop 2000ms) gives DiskMirror's open-write deferral
(1500ms) enough time to complete before the witness fires.

The "external persistence detected / merged" notification observed earlier is confirmed
as harmless: Android editor/CRDT/disk all converged correctly after the remote edit.
No duplication, no stale resurrection, no recovery-old-state emission.

## Result: PASS — Android open-editor remote edit is safe
