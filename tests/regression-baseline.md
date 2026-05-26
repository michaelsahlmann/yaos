# Regression Baseline

## Repo prevention

`npm run guard:no-src-js-artifacts` (wired into `test:regressions`) fails immediately if stale `.js` or `.js.map` files exist under `src/sync`, `src/settings`, `src/runtime`, `src/debug`, or `src/diagnostics`.

To clean: `npm run clean:src-js-artifacts`

## Current state: 60 passed, 0 failed

All pre-existing failures resolved in commit that deleted stale `.js` artifacts from `src/`.

## Root cause of the 7 pre-existing failures

**Not semantic regressions.** All 7 failures were caused by stale compiled `.js` artifacts in `src/sync/` and `src/settings/` left over from an old `tsc` compilation run.

When JITI loaded test files that imported from `src/sync/stateVectorAck` (no extension), it found `stateVectorAck.js` first (native ESM, because `package.json` has `"type": "module"`). The `.js` file used `var Y = require("yjs")` (CommonJS), which loaded a different Yjs instance than the test's `import * as Y from "yjs"`. State vectors encoded by one Yjs instance could not be decoded by another, causing all `isStateVectorGe` calls to return incorrect results.

**Fix**: deleted local untracked `.js` artifacts from `src/` (they were gitignored, so no git change). Added `guard:no-src-js-artifacts` wired into `test:regressions` to prevent recurrence.

## Suites that were failing (now all pass)

```
tests/disk-mirror-origin-classification.ts  — was: Yjs double-import
tests/reconciliation-safety-brake.ts        — was: Yjs double-import
tests/blob-download-conflicts.ts            — was: Yjs double-import (TFile mock)
tests/disk-mirror-observer.ts               — was: Yjs double-import (normalizePath mock)
tests/state-vector-ack.ts                   — was: Yjs double-import → wrong isStateVectorGe results
tests/sv-echo-client-receiver.ts            — was: Yjs double-import → wrong ack semantics
tests/server-ack-tracker.ts                 — was: Yjs double-import → wrong ack semantics
```

## Verification

```
npm run build    → PASS
npm run test:regressions → 60 passed, 0 failed
```

## Pre-existing failures (7 suites, unchanged since Layer 4 Phase 1)

These 7 suites fail on `main` and are not caused by Layer 4 changes.

```
tests/disk-mirror-origin-classification.ts
tests/reconciliation-safety-brake.ts
tests/blob-download-conflicts.ts
tests/disk-mirror-observer.ts
tests/state-vector-ack.ts
tests/sv-echo-client-receiver.ts
tests/server-ack-tracker.ts
```

Current count: **53 passed, 7 failed** (as of Layer 4 Phase 3 + harness closure pass).

---

## Triage of each failing suite

### 1. `tests/disk-mirror-origin-classification.ts`
**Failure**: `FAIL at least the required count of repair origins` (1 test fails, 29 pass)
**Classification**: Stale test — the test expects a specific count of repair-origin events that changed when DiskMirror behavior was updated. The invariant it protects (origin classification) is still valid; the count threshold is stale.
**Action**: Update the count threshold. Low risk, ~15 min fix.

### 2. `tests/reconciliation-safety-brake.ts`
**Failure**: `TypeError: Cannot read properties of undefined (reading 'mtime')`
**Classification**: Stale test — the test constructs a mock disk index entry without `mtime`, but the reconciliation safety brake now requires it. The invariant (safety brake fires on suspicious reconcile) is still valid.
**Action**: Add `mtime` to mock disk index entries in the test. Low risk, ~15 min fix.

### 3. `tests/blob-download-conflicts.ts`
**Failure**: `TypeError: TFile is not a constructor`
**Classification**: Mock gap — the Obsidian mock (`tests/mocks/obsidian.ts`) doesn't export `TFile` as a constructor. The test imports it and tries to instantiate it. The invariant (blob download conflict resolution) is still valid.
**Action**: Add `TFile` constructor to the Obsidian mock. Low risk, ~15 min fix.

### 4. `tests/disk-mirror-observer.ts`
**Failure**: `normalizePath is not a function` + 1 logic failure
**Classification**: Mock gap — same Obsidian mock issue; `normalizePath` is not exported from the mock. The logic failure may be a real behavior change.
**Action**: Add `normalizePath` to mock. Then re-run to see if the logic failure is real. Medium risk.

### 5. `tests/state-vector-ack.ts`
**Failure**: Multiple failures — `isStateVectorGe(candidate, server)` returns `true` when it should return `false`
**Classification**: Real bug or semantic change — `isStateVectorGe` is supposed to return `false` when `a` is missing keys that `b` has. The current implementation only checks keys in `b` against `a`, which means if `b` has a key `a` doesn't, it returns `false` correctly. But the test says `isStateVectorGe(candidate, server)` should be `false` when server has a higher clock. Let me check: if `server = {client1: 5}` and `candidate = {client1: 3}`, then `isStateVectorGe(candidate, server)` checks if for every key in `server`, `candidate` has >= that clock. `candidate.client1 = 3 < server.client1 = 5` → returns `false`. That should work. The test is failing, which means either the implementation changed or the test is wrong.
**Classification**: Likely a real semantic regression in `isStateVectorGe` or its callers. Medium-high risk.
**Action**: Investigate `isStateVectorGe` implementation against test expectations. May be a real bug.

### 6. `tests/sv-echo-client-receiver.ts`
**Failure**: `FAIL valid non-dominating echo leaves candidate pending` (1 test fails, 12 pass)
**Classification**: Likely related to state-vector-ack semantic change. The server ack tracker uses `isStateVectorGe` internally.
**Action**: Fix after state-vector-ack is resolved.

### 7. `tests/server-ack-tracker.ts`
**Failure**: Multiple failures — `non-dominating echo: stays false`, `discarded candidate: null in store`, `doc ahead of candidate: state=false`
**Classification**: Same root cause as state-vector-ack. The server ack tracker behavior changed.
**Action**: Fix after state-vector-ack is resolved.

---

## Root cause hypothesis for suites 5, 6, 7

Suites 5, 6, 7 are likely all caused by the same root change: either `isStateVectorGe` semantics changed, or the server ack tracker's use of it changed. These three suites protect the server receipt confirmation path — a critical invariant for YAOS reliability.

**This is the highest-priority fix.** A sync project with broken server ack tests is not release-clean.

---

## Fix priority

| Suite | Priority | Effort | Risk |
|-------|----------|--------|------|
| state-vector-ack (5) | HIGH | Medium | Real semantic regression possible |
| sv-echo-client-receiver (6) | HIGH | Low (follows from 5) | Depends on 5 |
| server-ack-tracker (7) | HIGH | Low (follows from 5) | Depends on 5 |
| disk-mirror-origin-classification (1) | MEDIUM | Low | Stale count |
| reconciliation-safety-brake (2) | MEDIUM | Low | Stale mock |
| blob-download-conflicts (3) | LOW | Low | Mock gap |
| disk-mirror-observer (4) | LOW | Medium | Mock gap + possible real failure |
