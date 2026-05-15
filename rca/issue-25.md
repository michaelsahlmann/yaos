# Issue #25 RCA: Editor-Bound Recovery Loop (57-Char Growth Every ~4s)

## Status

**Resolved on current main.**

All three required proofs pass. See Evidence section.

This issue does not cover offline handoff behavior or multi-device convergence
after reconnect; those are tracked separately.

## Symptom (User Report)

- Single device.
- Open daily note repeatedly grew by a stable fragment (~57 chars) every ~4 seconds for ~6 minutes.
- Log line repeated: `syncFileFromDisk: recovering ... (editor-bound local-only divergence: ... -> ... chars)`.
- Loop stopped only when provider disconnected.

## Likely Root Cause

Likely unsafe editor-bound recovery diff application against an ambiguous/stale base in a note with repeated structural anchors (notably repeated `tasks` blocks), combined with insufficient postcondition enforcement.

- Recovery could apply a "Frankenstein" patch (misaligned diff) and fail to converge.
- Without a converge-or-stop postcondition and loop fingerprinting/quarantine, the same recovery signature could repeat, creating monotonic growth.

This is phrased as **likely** because we did not replay the exact 1.6.1 environment end-to-end from historical diagnostics.

## Fix Class (Current Main)

- Editor-bound recovery now uses `applyDiffToYTextWithPostcondition`.
- Recovery attempts are fingerprinted/quarantined to prevent unbounded repeated application.
- `recovery.decision`, `recovery.apply.start`, `recovery.apply.done`, `recovery.postcondition.failed` flight events emitted for traceability.

## Evidence

### 1. Forced local-only recovery branch

Scenario: `issue-25-editor-bound-loop-forced-recovery-local-only`

Precondition manufactured deterministically:
- `editor == disk` (local authoritative state)
- `CRDT != disk` (stale)
- file editor-bound

Branch fired:
```
syncFileFromDisk: recovering ... (editor-bound local-only divergence: 26931 -> 26976 chars)
repair: repaired ... reason=bound-file-local-only-divergence
```

Postcondition:
```
diskHash == crdtHash == editorHash == 19c9...
```

Analyzer passed. Trace: `flight-trace-qa-safe-2026-05-12T19-10-20-620Z.ndjson`

---

### 2. Forced open-idle editor-bound recovery branch

Scenario: `issue-25-editor-bound-loop-forced-recovery-crdt-only`

Branch fired:
```
syncFileFromDisk: recovering ... (editor-bound external disk edit while idle: ...)
```

Postcondition:
```
diskHash == crdtHash == editorHash == c86b...
```

Analyzer passed. Trace: `flight-trace-qa-safe-2026-05-12T19-10-24-444Z.ndjson`

---

### 3. Natural repeated-anchor soak (user-visible symptom test)

Scenario: `issue-25-editor-bound-loop-natural`

- Real MarkdownView editor, large (~30k) repeated-anchor fixture.
- Checkbox edits + selection delete crossing the `tasks` boundary.
- 3-minute wall-clock soak with 30-second size sampling.

Result:
```
soak sample 1/6: size=27705, growth=+0
soak sample 2/6: size=27705, growth=+0
soak sample 3/6: size=27705, growth=+0
soak sample 4/6: size=27705, growth=+0
soak sample 5/6: size=27705, growth=+0
soak sample 6/6: size=27705, growth=+0
```

Analyzer passed. Trace: `flight-trace-qa-safe-2026-05-12T19-13-31-580Z.ndjson`

---

## What This Proves

- The exact historical `bound-file-local-only-divergence` branch is isolated and converges.
- The `bound-file-open-idle-disk-recovery` sibling branch is isolated and converges.
- No natural editor-bound growth loop occurs on current main under a realistic
  large repeated-anchor fixture over a 3-minute soak.

## What This Does Not Prove

- The exact 1.6.1 historical environment was not replayed.
- Offline handoff behavior is not covered by this issue.

## Remaining Follow-up

None blocking. Harness improvements tracked separately (in-memory QA policy override,
`waitForEditorBinding` helper).
