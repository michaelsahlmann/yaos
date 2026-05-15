# Open work — YAOS QA / sync correctness

Last updated: 2026-05-15

This file is the scannable summary of deferred work.
Full RCA and context for each item is in `qa-followups.md`.

---

## Priority order

| ID | Item | Priority | Blocked by |
|---|---|---|---|
| QA-15 | No-event reconcile admission (s09d) | **Next** | Nothing — runnable today |
| QA-7 | NFC/NFD path normalization (s08e) | High | Nothing |
| QA-12 | S09b platform coverage — macOS/iOS/Android | High | QA-15 result informs mobile risk |
| QA-13 | Transient active excluded CRDT state (architecture) | Medium | Design decision |
| QA-14 | No-event mobile import | Medium | QA-15 result |
| QA-4 | Real Templater plugin invocation | Low | QA vault profile + pinned Templater |
| — | True overwrite/collision test | Low | Behavior definition |
| — | Multi-device offline handoff | Separate track | Two-device QA environment |

---

## QA-15: s09d — no-event reconcile admission

**What:** Write a syncable file via adapter (no vault event), call `forceReconcile()`,
assert file enters CRDT without any create event firing.

**Why first:** Answers whether reconcile does a full vault scan or only processes
event deltas. This determines the mobile safety of S09b (rename-from-excluded) and
any other "file appears on disk without Obsidian noticing" scenario.

**If PASS:** Mobile risk for S09b is low — reconcile catches files that appear without
events.
**If FAIL:** Mobile rename-from-excluded is a silent sync gap. Needs a product fix
before mobile launch.

**Effort:** One scenario (~50 lines). No product changes needed to write the test.

**Scenario:** `s09d-reconcile-admits-adapter-written-file` in a new
`qa/obsidian-harness/scenarios/s09-reconcile-admission.ts`.

---

## QA-7: s08e — NFC/NFD filename normalization

**What:** YAOS may not normalize vault paths to NFC before CRDT keying. A file created
with an NFD filename (decomposed Unicode, e.g. `A\u0300` for À) gets NFC-normalized
by the filesystem on write. If CRDT uses the original NFD path as key, no hash match
is found on read — the file appears as a new create on every reconcile, or never
converges.

**Why matters:** Real user impact on macOS (HFS+ normalizes to NFC) and any vault
containing filenames with accents, CJK characters, or composed emoji.

**What to verify:**
1. Create file with NFD path.
2. Confirm filesystem normalizes to NFC.
3. Assert CRDT uses NFC path (no NFD ghost key).
4. Assert no duplicate CRDT entry (one NFD + one NFC).

**Effort:** One scenario. May require a product fix in `ensureFile` or
`reconciliationController` to normalize paths before CRDT keying.

---

## QA-12: S09b platform coverage

**What:** S09b passed on Linux because inotify fires a `create` event when
`adapter.rename` moves a file into the vault. Other platforms are unverified.

| Platform | Risk |
|---|---|
| macOS | Low-medium — FSEvents coalesces; probably works; unconfirmed |
| Windows | Low — ReadDirectoryChangesW fires FILE_ACTION_ADDED |
| iOS / iPadOS | **High** — no OS watcher; depends on QA-15 reconcile result |
| Android | **Medium-high** — same as iOS |

**Unblocked portion:** Run `s09b-rename-from-excluded` on macOS. Takes 5 minutes.

**Blocked portion:** iOS/Android — needs device or simulator. Risk assessment depends
on QA-15 result first.

---

## QA-13: Transient active excluded CRDT state (architecture debt)

**What:** The current S09a fix is promote-then-tombstone. `applyRenameBatch` moves
the CRDT identity to `.trash/trash-dst` (briefly active), then `onRenameBatchFlushed`
immediately tombstones it. Two separate Yjs transactions — not atomic.

**Why it matters:** Remote peers syncing in the window between the two transactions
could observe a live CRDT entry at an excluded path. Flight traces contain a state
that should never have existed. Future analyzer rules must tolerate it.

**Preferred fix:** Pre-filter the rename batch in `main.ts` before `applyRenameBatch`.
If `newPath` is excluded: tombstone `oldPath` directly (file is effectively deleted
from sync), do not promote identity to the excluded path.

**Requires:** Explicit `VaultSync` caller contract. Current contract: "caller must not
leave an excluded path active." Better contract: "caller must not ask VaultSync to
rename identity to an excluded path." These are different.

**Not urgent** — final state is always correct; this is about eliminating the
transient invalid state.

---

## QA-14: Mobile no-event import

**What:** On iOS/Android, `adapter.rename` from an excluded path into the vault may
not fire any vault event. File appears on disk; YAOS never sees it.

**Depends on QA-15.** If reconcile does a full scan, mobile gets a safety net. If not,
this becomes a product bug requiring a platform-specific fix or periodic re-scan.

---

## QA-4: Real Templater plugin invocation

**What:** Run actual Templater templates in the QA vault and verify YAOS handles the
create→fill→rename sequence without data loss.

**Blocked:** Needs a pinned Templater version + reproducible QA vault profile. Pattern
coverage from S07a–S07h is a reasonable substitute until this is set up.

---

## True overwrite/collision test (untracked)

**What:** S09c is honest — it tests rename into a vacated path, not a true collision.
A real collision requires A.md dirty + B.md exists + move A over B at the adapter
level, bypassing Obsidian's `vault.rename` guard.

**First step:** Define the expected behavior explicitly before writing the test.
Expected: CRDT converges to disk content (A's v2) at B path. A absent. No ghost of
B's old content. `syncFileFromDisk` re-reads disk regardless of op IDs — this is
already proven by S09c, so the collision test is mostly about verifying the
pre-rename CRDT state of B is cleanly overwritten and not left as a conflict.

**Not urgent** — the merge behavior in `redirectPendingDirtyPath` is already tested
under the vacated-path shape.

---

## Multi-device offline handoff (untracked)

**What:** The reported user complaint "sync only happens if both devices online" is
a separate correctness class not covered by the single-device harness. Needs:
- Device A goes offline (provider disconnected)
- Device B makes edits
- Device A reconnects
- Assert convergence in both directions

**Separate track.** Requires a two-device or two-provider QA environment. Not
representable in the current single-vault harness without mocking the provider layer.

---

## Analyzer coverage notes

**`active-excluded-path` rule fallback:** In safe-mode traces, the rule uses
`data.excludedByPolicy` (embedded by `recordFlightPathEvent` since QA-9). For traces
recorded before that fix, it falls back to raw path matching against `.trash/` and
`.obsidian/` only — user-configured exclude patterns are not covered in fallback mode.
This is acceptable; the primary path covers all exclusion reasons.

**`orphan-after-rename` intermediate hop exemption:** The rule skips pathIds that
appear as both rename target and rename source (chain intermediates). This prevents
false positives on A→B→C chains where YAOS collapses to A→C. Risk: if a genuine
identity loss occurs at an intermediate hop, the rule won't catch it. Mitigated by
the terminal hop check (C must have `crdt.file.renamed`).

**Analyzer identity continuity by fileId:** The reviewer noted that rename bugs are
often identity bugs, and the analyzer should verify identity continuity by `fileId`
not just by `pathId`. Not yet implemented. `fileId` is present in some events;
a future rule could assert that the `fileId` at the rename target matches the source.
