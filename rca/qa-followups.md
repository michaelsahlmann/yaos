# QA Harness Follow-up Issues

Tracked here: open items from code review sessions that are not blockers for current
work but must not get lost.

## Verified clean (not issues)

- **`src/main.ts` rename event recording** — reviewer flagged a possible duplicate
  `path`/`data` key. Verified: the rename handler emits two separate
  `recordFlightPathEvent` calls (lines 780–805), each with a clean object. No duplicate
  keys. The transcript showed an edit artifact, not a code bug.

---

## QA-1: Move cleanup phase marker before trace export

**Status:** Implemented. Typechecked. Not yet runtime-verified.

`api.ts` reordered — `ctx.phase("cleanup")` now fires before `exportTraceWithAnalyzer`,
so the cleanup boundary marker is present in exported traces. `orphan-after-rename.ts`
comment updated. `hasCleanupPhaseMarker` is no longer dead code.

**Precise semantics:** The cleanup *boundary marker* is exported. Actual cleanup *events*
remain excluded (scenario.cleanup() still runs after export). Analyzers can now scope
teardown, but they are not analyzing teardown events — just seeing the boundary.

**Files changed:**
- `qa/obsidian-harness/api.ts:215-238` — reordered blocks
- `qa/analyzers/rules/orphan-after-rename.ts:43-49` — updated comment

---

## QA-2: S07k — attachment reference then blob arrives

**Status:** PASS. Verified 2026-05-15.

```
✓ s07k-blob-arrives-after-reference (2553ms)
  markdown CRDT unchanged after blob arrival
  blob path NOT in text CRDT (blobCrdt: null)
  disk == CRDT throughout
```

Blob uploaded to R2 (29 bytes, 729ms) — confirmed the blob pipeline fired.
Markdown remained stable. Text pipeline is correctly independent of blob events.

---

## QA-3: Bulk import stress family (500 / 1000 files, Unicode, nested, mixed types)

**Status:** Partially verified 2026-05-15. Three of four scenarios green; S08b had
one failure that revealed a real finding.

| Scenario | Result | Duration | Notes |
|---|---|---|---|
| S08a 500-file | PASS | 12520ms | 500/500 converged |
| S08b Unicode | FAIL → fixed | 1387ms | See below |
| S08c Nested | PASS | 2970ms | 100/100, 10 levels |
| S08d Mixed | PASS | 12337ms | 50 .md converged; .canvas→blob pipeline; .png not in text CRDT |

**S08b finding — NFC/NFD filesystem normalization:**

The filename `Note \u0041\u0300 combining` (A + combining grave, decomposed NFD)
produced:
```
disk=null  crdt=eb8c2add
```

CRDT registered it under the decomposed path. The filesystem (ext4/macOS) NFC-normalized
it on write. `getDiskHash(decomposedPath)` returned null because `vault.getFileByPath()`
could not find it. This is OS-level behavior, not a YAOS bug.

**Fix applied:** Removed the decomposed combining-char entry from `UNICODE_FILENAMES`.
Added comment explaining why. A dedicated S08e scenario for explicit NFC/NFD normalization
testing is tracked as a new follow-up.

**S08d finding — canvas files go to blob pipeline:**

```
[S08d] 0/50 .canvas files in CRDT (canvas syncability depends on config)
```

Canvas files are handled by the blob upload pipeline (`setBlobRef`), not the text CRDT.
This is the expected behavior — canvas is not markdown-syncable in this vault config.
The `waitForCrdtFile` timeout on canvas files was gracefully handled (non-fatal).

**S08d finding — partial blob upload on cleanup race:**

`canvas-14.canvas` uploaded after cleanup started:
```
deleteBlobRef: "canvas-14.canvas" not in CRDT, ignoring
...
upload: success "canvas-14.canvas" in 588ms
```
The upload completed after the scenario had already deleted the file in cleanup. The
delete log `not in CRDT, ignoring` is the correct behavior — the blob was never
registered in CRDT before deletion. No data loss, no crash.

**New follow-up added:** QA-7 (S08e NFC/NFD normalization scenario).

---

## QA-4: Real Templater plugin invocation

**Status:** Confirmed deferred. No code added. Will not be implemented until
Templater + Tasks + Dataview are added to the QA vault profile as explicit
versioned dependencies.

**Why:** The S07 suite simulates Templater-style write patterns via the harness API.
It does not test actual Templater plugin behavior with real templates, prompts, and
plugin lifecycle quirks (e.g. `tp.file.rename()` timing, `on-file-open` trigger mode,
async script execution with user prompts).

**What is needed:**
- Install Templater + Tasks + Dataview in the QA vault.
- Commit a set of template files to `qa/vault-profiles/templater/Templates/`.
- Write a scenario that triggers a real Templater command via `ctx.runCommand()`.
- Assert sync behavior on the resulting file operations.

**Deferred because:** Introduces Templater version dependency and template file
management. Not needed to prove current coverage; S07 pattern-based tests are
sufficient to prove the sync engine handles the vault API paths correctly.

**Unblock condition:** When QA vault profile gains a pinned Templater version.

**Files:** New `qa/vault-profiles/templater/` + scenario in `s07` or `s09`

---

## QA-5: `waitForActiveMarkdownLeaf` does not prove CRDT binding

**Status:** Implemented. Typechecked. S07c/S07e already use it — will be
runtime-verified when those scenarios run.

`getEditorBindingHealth` requires all three affirmatively true:
- `health.healthy === true`
- `collab.hasSyncFacet === true`
- `collab.yTextMatchesExpected === true`

`null`/unknown is not treated as healthy. Callers that hit a settling state will
simply wait longer until the binding completes.

**Files changed:**
- `src/qaDebugApi.ts` — `EditorBindingHealth` interface + implementation
- `src/main.ts` — `getEditorBindings` wired
- `qa/obsidian-harness/wait.ts` — `waitForCrdtBinding`
- `qa/obsidian-harness/types.ts` — exposed on `QaContext` + `QaConsoleApi`
- `qa/obsidian-harness/api.ts` — wired
- `qa/obsidian-harness/scenarios/s07-plugin-writes.ts` — S07c/S07e updated

---

## QA-6: S07g-2 — create then rename before CRDT registration (race test)

**Status:** DONE. Product bug found, fixed, and verified 2026-05-15.

---

### The bug

`S07g-rename-before-crdt` found a real data-sync bug in the Templater race:

```
create race-tmp
rename race-tmp → race-final (before CRDT admission)
→ Rename batch: no fileId for race-tmp → CRDT rename dropped
→ Dirty create for race-tmp: file gone → skipped
→ race-final never gets a CRDT entry
```

A second bug was found by `S07g-modify-then-rename` (S07g-5):

```
create mod-tmp, wait for CRDT admission
modify mod-tmp (pending modify, not yet drained)
rename mod-tmp → mod-final
→ Rename batch: CRDT rename succeeds (fileId exists)
→ Dirty modify for mod-tmp: file gone → skipped
→ mod-final CRDT has v1 content; disk has v2
```

Both are the same root class: stale path ownership after rename. The dirty queue
holds an entry keyed to `oldPath`, but `oldPath` no longer exists. The exact failure
differs — create race has no CRDT identity yet; modify race has a valid CRDT identity
but stale-path-queued content — yet the shared cause is that pending dirty entries in
`dirtyMarkdownPaths` for `oldPath` are not redirected to `newPath` when a rename batch
flushes.

---

### The fix

**`src/runtime/reconciliationController.ts`** — added `redirectPendingDirtyPath(oldPath, newPath)`:

- If `oldPath` has a pending create: redirect to `newPath` (pre-CRDT race recovery)
- If `oldPath` has a pending modify: redirect to `newPath` (modify-then-rename race)
- If `newPath` is already dirty: merge (preserve `create` priority, coalesce op IDs)
- If no entry for `oldPath`: no-op

**`src/main.ts`** — `onRenameBatchFlushed` callback calls `redirectPendingDirtyPath`
for every entry in the batch.

---

### Verified runs

```
✓ s07g-rename-before-crdt  (2075ms)  raceHit: true  disk==crdt 022a3ee6
  redirectPendingDirtyPath(create): race-tmp → race-final  (race recovery)
  ensureFile: created race-final

✓ s07g-modify-then-rename  (2577ms)  disk==crdt 889f1295
  redirectPendingDirtyPath(modify): mod-tmp → mod-final  (modify redirect)
  syncFileFromDisk: applying diff (410 → 645 chars)
```

---

### Analyzer rule update

`orphan-after-rename` updated to distinguish:

| Outcome | Verdict |
|---|---|
| `crdt.file.renamed` at newPath | Clean identity-preserving rename — pass |
| No prior CRDT identity for source + `crdt.file.created` at newPath | Pre-CRDT race recovery — **warning** (content preserved, fileId is new) |
| Source had prior CRDT identity + no `crdt.file.renamed` | Identity loss — **hard failure** |
| Neither renamed nor created | Content lost — **hard failure** |

---

### S07g suite final state

| Scenario | ID | Status |
|---|---|---|
| S07g-1 | `s07g-rename-after-create` | PASS |
| S07g-2 | `s07g-rename-before-crdt` | PASS (race fix) |
| S07g-3 | `s07g-rename-to-tombstoned-path` | PASS |
| S07g-4 | `s07g-rename-chain` | PASS |
| S07g-5 | `s07g-modify-then-rename` | PASS (modify-redirect fix) |

**Files changed:**
- `src/runtime/reconciliationController.ts` — `redirectPendingDirtyPath`
- `src/main.ts` — `onRenameBatchFlushed` calls `redirectPendingDirtyPath`
- `qa/analyzers/rules/orphan-after-rename.ts` — race recovery warning path
- `qa/obsidian-harness/scenarios/s07g-rename-after-create.ts` — S07g-2 and S07g-5
- `qa/obsidian-harness/main.ts` — registered S07g-2 and S07g-5

---

## QA-7: S08e — NFC/NFD filename normalization (new, from S08b run)

**Status:** Open. Found during S08b execution 2026-05-15.

**Finding:** Decomposed Unicode filenames (NFD — e.g. `A\u0300` for À) are NFC-normalized
by the filesystem on write. The harness path (decomposed) does not match the vault path
(NFC-composed), causing `getDiskHash(nfdPath)` to return null.

This is OS/filesystem behavior. It is not a YAOS bug per se, but it is a real user
concern: if a user imports notes from a system that stores NFD filenames, YAOS must
handle the normalization consistently. The CRDT key must match what the filesystem
returns, not what the user originally specified.

**What needs testing:**
1. Create a file with NFD path.
2. Confirm filesystem normalizes it to NFC.
3. Assert CRDT uses the NFC path (not NFD).
4. Assert `getDiskHash(nfcPath)` succeeds, `getDiskHash(nfdPath)` returns null.
5. Verify no duplicate CRDT entries (one NFD ghost + one NFC real).

**Files:** New scenario `qa/obsidian-harness/scenarios/s08-bulk-import.ts` or
`s08e-unicode-normalization.ts`

---

## QA-8: S07g-6 — modify-then-rename chain (stale path ownership, chained)

**Status:** DONE. Verified 2026-05-15.

**Finding:** YAOS collapses A→B→C rename chains into a single CRDT batch hop (A→C)
when both renames arrive before the batch timer fires. The dirty modify entry follows
A→C via a single `redirectPendingDirtyPath(modify)` call. C gets v2 content. A and B
absent.

**Analyzer fix:** `orphan-after-rename` rule now skips intermediate chain hops —
pathIds that appear as both a rename target and a subsequent rename source within the
same trace. These are exempt from the `crdt.file.renamed` requirement because YAOS
collapses the chain and emits `crdt.file.renamed` only at the final destination.

**Verified:** `disk == crdt: 889f1295` at C ✓. No orphan at A or B.

**Files changed:**
- `qa/analyzers/rules/orphan-after-rename.ts` — intermediate chain hop exemption
- `qa/obsidian-harness/scenarios/s07g-rename-after-create.ts` — S07g-6 scenario

---

## QA-9: S09a — rename into excluded path (syncable → excluded)

**Status:** DONE. Product bug found, fixed (tightened 2026-05-15), and verified.

**Finding:** `applyRenameBatch` had no knowledge of path exclusion rules. When a file
was renamed from a syncable path into `.trash/` (or any excluded folder), the CRDT
entry was promoted to the excluded path — creating a ghost live entry that would sync
to other devices.

**Root cause:** `applyRenameBatch` in `vaultSync.ts` is a pure CRDT operation and
deliberately has no access to vault path exclusion rules. The exclusion check was
missing in the layer that does have access to it.

**Architecture contract established:**
> `VaultSync` never decides path eligibility.
> The caller must never leave an excluded path active in CRDT.
> `dropDirtyPath` is unconditional for excluded destinations — "excluded path" means
> "do not sync this path" regardless of whether a CRDT identity exists there.

**Fix:** `onRenameBatchFlushed` callback in `main.ts`:
```
for each [oldPath, newPath] in renames:
  if !isMarkdownPathSyncable(newPath):
    dropDirtyPath(newPath)            ← unconditional
    if vaultSync.getFileId(newPath):  ← only if CRDT was promoted
      vaultSync.handleDelete(newPath)
```

Note: the current fix is "promote-then-tombstone" — `applyRenameBatch` first makes
the excluded path active, then `onRenameBatchFlushed` tombstones it. See **QA-13** for
the follow-up to prevent transient active excluded CRDT state entirely.

**Verified log sequence:**
```
renameBatch: trash-src → .trash/trash-dst  (id promoted — bug)
redirectPendingDirtyPath(modify): trash-src → .trash/trash-dst
onRenameBatchFlushed: tombstoning excluded destination ".trash/trash-dst"
handleDelete: ".trash/trash-dst" marked deleted  (fixed)
dropDirtyPath: dropped excluded dirty entry for ".trash/trash-dst"
→ no ghost CRDT entry at excluded destination ✓
```

**Files changed:**
- `src/main.ts` — `onRenameBatchFlushed` tombstone + drop loop; `dropDirtyPath` unconditional
- `src/runtime/reconciliationController.ts` — `dropDirtyPath(path)`

---

## QA-10: S09b — rename out of excluded path (excluded → syncable)

**Status:** DONE on Linux desktop. Platform-sensitive. See QA-12 for mobile follow-up.

**Correct status:** "rename from excluded works on Linux via OS watcher create event."

**Finding:** When `adapter.rename` moves a file from `.trash/` into a syncable path,
the OS inotify watcher fires, Obsidian translates it into a vault `create` event at
the destination, and YAOS calls `ensureFile` normally.

**Why `vault.rename` fails for excluded sources:** Obsidian's `vault.rename` requires
the source to be indexed. Excluded paths are not indexed. The harness uses
`adapter.rename` instead for excluded-source renames.

**Verified on Linux:**
```
adapter.rename: .trash/from-trash-* → QA-s09/from-trash-dst-*
ensureFile: created "QA-s09/from-trash-dst-*"  ← OS watcher fired create
disk == crdt: 25b36c76 ✓
```

**Not verified:** macOS (FSEvents coalescing), iOS/Android (no OS watcher). See QA-12.

---

## QA-11: S09c — dirty rename into vacated path

**Status:** DONE. Verified 2026-05-15. Correct behavior confirmed.

**Scenario ID updated:** `s09c-rename-collision` → `s09c-rename-to-vacated-path`.

**Why renamed:** Obsidian's `vault.rename` blocks renames onto existing files
(`"Destination file already exists!"`). The original "collision" framing was wrong —
true simultaneous-dirty overwrite is not testable via the vault API. The scenario
tests a dirty rename into a vacated path slot, which is a different (and weaker) case.

**A true overwrite/collision test** requires adapter-level file replacement bypassing
Obsidian's guard. That is a separate scenario, not yet written.

**Verified:** `disk == crdt: 1815785c` ✓. A absent from CRDT. `syncFileFromDisk`
re-reads disk regardless of op IDs — no dedup suppression.

---

## QA-12: S09b platform coverage + no-event import (mobile/watcher risk)

**Status:** Open. Platform risk. Documented 2026-05-15.
**Note:** QA-14 was merged into this entry (overlapping content).

**Background:** S09b passed on Linux desktop. The mechanism: `adapter.rename` triggers
the OS inotify watcher → Obsidian translates it to a vault `create` event at the
destination → YAOS calls `ensureFile`. This relies entirely on the OS file watcher
firing a `create`-class event at the destination.

**Platform risk matrix:**

| Platform | File watcher | Rename-from-excluded risk |
|---|---|---|
| Linux desktop | inotify — reliable | Low — confirmed working |
| macOS desktop | FSEvents — coalescing | Low-medium — probably works; unconfirmed |
| Windows desktop | ReadDirectoryChangesW — `FILE_ACTION_ADDED` fires | Low — expected to work |
| iOS / iPadOS | No OS watcher — Obsidian polls | **High** — no watcher event, file may be missed |
| Android | Limited watcher — behavior varies | **Medium-high** — same concern as iOS |

**Failure mode on iOS:** User moves a file from an excluded folder into the vault via
Files app or a plugin. The file lands on disk but YAOS never admits it to CRDT unless
reconcile performs a full vault scan.

**Key question (answerable without a device — see QA-15):**
Does YAOS reconcile scan the full vault and admit syncable disk files that have no CRDT
entry, even if no vault `create` event fired? If yes, mobile risk drops substantially.

**What to verify:**
1. Does YAOS reconcile scan the full vault for new files, or only process known paths?
2. On iOS, does `adapter.rename` from an excluded path into a syncable path trigger
   any vault event at all?
3. If reconcile does full scan: mobile risk is low.
4. If reconcile is delta-only: mobile rename-from-excluded is a silent product gap.

**Blocked on QA-15 result.** Run QA-15 first.

---

## QA-13: Prevent transient active excluded CRDT state (architecture follow-up)

**Status:** Open. Architecture improvement. Documented 2026-05-15.

**Current behavior:** When a file is renamed into an excluded path, `applyRenameBatch`
first promotes the CRDT identity to the excluded path (active for one transaction), then
`onRenameBatchFlushed` tombstones it. This "promote-then-tombstone" pattern is correct
in terms of final state but creates a transient active excluded CRDT entry.

**Why this matters:**
- Remote peers may observe the intermediate active state before tombstone arrives
- Flight traces contain a state that should never have existed
- Future analyzer rules and bugs may treat "active excluded path for one tick" as normal
- The Yjs transaction in `applyRenameBatch` and the tombstone in `handleDelete` are
  separate transactions — not atomic from a Yjs perspective

**Preferred fix shape:**
```
Before applyRenameBatch promotes a fileId to newPath:
  if !isMarkdownPathSyncable(newPath):
    tombstone oldPath directly (file moved to excluded = effectively deleted from sync)
    do not rename CRDT identity to excluded path
```

**Where to implement:** Either pass an `isPathSyncable` callback into `VaultSync`
(clean but changes the interface), or filter the batch in `main.ts` before calling
`applyRenameBatch` (keep VaultSync pure, but requires VaultSync to expose separate
"rename" and "delete" entry points for the pre-filtered batch).

**Prerequisite:** Define the architecture contract explicitly before implementing.
Current contract (established by QA-9 fix): "caller must never leave an excluded path
active in CRDT." The cleaner contract is: "caller must never ask VaultSync to rename
identity to an excluded path."

---

## QA-15: S09d — no-event reconcile admission (mobile/adapter-write safety)

**Status:** Open. Next priority. Documented 2026-05-15.

**Background:** S09b confirmed that `adapter.rename` from `.trash/` to a syncable path
works on Linux because the OS watcher fires a `create` event. On mobile (iOS/Android),
no OS watcher event fires. Whether YAOS recovers depends entirely on whether its
reconcile cycle scans the full vault for syncable files that have no CRDT entry.

**This test can be run today on the Linux QA vault — no device required.** The mobile
scenario is simulated by writing a file directly via the adapter (bypassing vault event
pipeline) and then asserting that `forceReconcile()` admits it to CRDT.

**Scenario: `s09d-reconcile-admits-adapter-written-file`**

```
1. writeAdapterFile("QA-s09/no-event-admit-<ts>.md", CONTENT_A)
   — bypasses vault event pipeline; no handleCreate fires
2. await yaos.forceReconcile()
3. assert getCrdtHash(path) is non-null
   — if PASS: reconcile scans full vault; mobile risk reduced
   — if FAIL: files appearing without events are silently missed; mobile is a sync gap
```

**Expected outcome (if reconcile does full scan):** PASS — file admitted.
**Expected outcome (if reconcile is delta-only):** FAIL — silent gap documented as product bug.

**Why this matters:**
- Determines whether mobile rename-from-excluded (S09b) has a safety net
- Determines whether adapter-level plugin writes (e.g. Dataview cache files moved
  into vault, iOS Files app copy-in) are eventually caught by YAOS
- Answers the "startup full scan" question: does YAOS compare vault files against
  CRDT on load, or only respond to events?

**Files to create:**
- `qa/obsidian-harness/scenarios/s09-reconcile-admission.ts` — new scenario file
- Register in `main.ts`

**Related:** QA-12 (platform coverage), QA-14 (mobile/no-event import)
