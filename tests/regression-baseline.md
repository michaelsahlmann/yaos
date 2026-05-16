# Regression baseline — Layer 4 Phase 1 branch

## Pre-existing failures (present on `main` before this branch)

The following 7 suites fail on `main` at commit `146a221` and are **not caused by
Layer 4 changes**. They are tracked as open work in `rca/open-work.md`.

```
tests/disk-mirror-origin-classification.ts
tests/reconciliation-safety-brake.ts
tests/blob-download-conflicts.ts
tests/disk-mirror-observer.ts
tests/state-vector-ack.ts
tests/sv-echo-client-receiver.ts
tests/server-ack-tracker.ts
```

## This branch

- Adds `tests/device-witness-tracker.ts` (17 tests, all passing).
- Does **not** introduce any new failures.
- Full suite: **40 passed, 7 failed** (same 7 as above).

## Verification

```
git stash                    # stash branch changes
npm run test:regressions     # 39 passed, 7 failed  ← baseline
git stash pop                # restore branch changes
npm run test:regressions     # 40 passed, 7 failed  ← +1 new suite, same 7 failures
```
