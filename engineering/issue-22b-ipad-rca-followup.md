# Issue #22-B — why the previous fix did not fully solve the iPad case

Status: open. The 2026-05-27 closed-file conflict patch (`closedFileConflict.ts`
mtime tie-break + `_lastDiskIndexPersistedAt` persistence) is correct for what
it covers, but it does not cover the iPad workflow the user actually performed,
and it does not cover the second-order failure that surfaced afterwards. There
are two distinct bugs visible on the same iPad session.

The trace under analysis: `~/temenos/.obsidian/plugins/yaos/flight-logs/2026-05-27/boot-wL7i012vR4mGXA-1.ndjson`,
`localTraceId: trace-Sp7Wij_1OE8_RQ`, desktop side, file
`issue22b-ipad-proof.md.md`, pathId `p:476818d2ecba90d4e95e2a0c4f3ad1eb`.

## What actually happened on the iPad, in order

1. Desktop creates `issue22b-ipad-proof.md.md` with `BASELINE_PROOF`. Both
   devices reach steady state.
2. iPad opens YAOS → settings → disables the plugin. Obsidian goes back to
   the editor with the file open.
3. Desktop appends `\n\nREMOTE_FROM_DESKTOP\n`. iPad does not see it (YAOS
   off → no provider → no CRDT updates → no disk write through the mirror).
4. iPad user types `LOCAL_ON_IPAD` directly into Obsidian's editor while
   YAOS is disabled. Obsidian autosaves it to disk via its own writeback.
5. iPad user re-enables YAOS.
6. End state on iPad and desktop: file shows `BASELINE_PROOF\n\nREMOTE_FROM_DESKTOP\n`.
   `LOCAL_ON_IPAD` is gone. **No conflict artifact** is created.

The user then opens the desktop and starts typing. The recovery loop that the
trace captures begins here, not on the iPad.

## Bug 1 — the iPad clean-disable case still loses the local edit

This is a different code path from the cold-relaunch / process-kill case the
existing fix targets.

### What the fix actually covers

`decideClosedFileConflict` now treats missing-baseline like this:

```text
baselineHash === null
  AND diskMtime !== undefined
  AND lastDiskIndexPersistedAt !== undefined
  AND diskMtime > lastDiskIndexPersistedAt
    → disk wins, CRDT preserved as artifact
otherwise
    → CRDT wins, disk preserved as artifact (safe distributed default)
```

That branch only fires when `baselineHash === null`. The cold-kill desktop
repro `qa/scripts/repro-missing-baseline-kill.ts` works because the kill
path bypasses `teardownSync → flushAllPendingWrites → saveDiskIndex`, so the
disk-index entry for the test path is genuinely never persisted.

### Why the iPad clean-disable case does NOT enter that branch

When the user disables YAOS through settings, `onunload` runs. `teardownSync`
runs. `flushAllPendingWrites` runs. `saveDiskIndex` runs. The contentHash for
`issue22b-ipad-proof.md.md` IS persisted, with whatever value matched the file
at that instant — `BASELINE_PROOF\n`.

Then the iPad user types `LOCAL_ON_IPAD`. The Obsidian autosave writes
`BASELINE_PROOF\n\nLOCAL_ON_IPAD\n` to disk, but YAOS is off, so the disk
index is not advanced.

When YAOS re-enables, the closed-file reconcile runs:

```text
baselineHash = contentHash("BASELINE_PROOF\n")        // PERSISTED, NOT NULL
diskHash     = hash("BASELINE_PROOF\n\nLOCAL_ON_IPAD\n")
crdtHash     = hash("BASELINE_PROOF\n\nREMOTE_FROM_DESKTOP\n")
```

This satisfies the `both-changed` predicate, not `missing-baseline`:

```typescript
if (diskHash === baselineHash && crdtHash !== baselineHash) → apply-remote-to-disk
if (crdtHash === baselineHash && diskHash !== baselineHash) → import-disk-to-crdt
return preserve-conflict / both-changed / winner: disk      // ← this branch
```

The `both-changed` branch already preserves the loser as a conflict artifact.
That part is right.

### So why did `LOCAL_ON_IPAD` disappear?

There is a hole in the precondition. `crdtHash` at the moment of the iPad
reconcile is `hash("BASELINE_PROOF\n\nREMOTE_FROM_DESKTOP\n")` only IF the
provider has already streamed the desktop update into the iPad's CRDT before
the closed-file reconcile evaluates. There are three plausible iPad-specific
sequences and none of them are guaranteed to land us on the safe branch:

1. **Provider has not synced yet** — `crdtHash === baselineHash` because the
   CRDT still holds the pre-disable `BASELINE_PROOF\n`. Then the predicate
   `crdtHash === baselineHash && diskHash !== baselineHash` matches and the
   decision is `import-disk-to-crdt`. This would save `LOCAL_ON_IPAD`. Did
   not happen here, because:

2. **Provider syncs first, reconcile second** — by the time the closed-file
   scan runs, the CRDT is already `BASELINE_PROOF\n\nREMOTE_FROM_DESKTOP\n`.
   This lands on `both-changed / winner: disk`, which would also save
   `LOCAL_ON_IPAD` to the main file and demote `REMOTE_FROM_DESKTOP` to an
   artifact. Did not happen here either.

3. **Reconcile runs first, then a remote text update arrives, then the
   editor binding repairs** — this is what the trace pattern is consistent
   with. The reconcile sees `disk == baseline` momentarily (because the iPad
   never saw `LOCAL_ON_IPAD` get hashed into a baseline, and the editor's
   in-memory autosave timing on iPad is its own thing), or the reconcile
   gets gated by `editor-bound` (`handleBoundFileSyncGap`) and the bound
   path makes a different decision than the closed-file path.

The trace evidence shows we ended up in the editor-bound branch even though
the file was at-rest on the iPad. On startup the iPad reopens whichever note
was last open. `issue22b-ipad-proof.md.md` was last open. So when YAOS
re-enables and the reconcile fires, the file is editor-bound; this routes
through `handleBoundFileSyncGap`, not through the closed-file
`decideClosedFileConflict`.

### The closed-file fix is the wrong fix for this scenario

Even if `decideClosedFileConflict` were perfect, it is never consulted on the
iPad re-enable path because the file is open. The protected path is
`handleBoundFileSyncGap`, and that function's branches are:

- `crdtContent === content` → no-op
- `localOnly` (editor matches disk, editor != crdt) → recover **disk to CRDT**
  (apply-diff). No artifact created.
- `crdtOnly` (editor matches crdt, editor != disk) and idle ≥ 1.2s →
  recover **disk to CRDT**. No artifact created.
- ambiguous → conflict artifact, fingerprint dedupe.

There is no `both-changed` analog in the bound branch and there is no
mtime-evidence tie-break. Whichever way the iPad's three states (disk,
crdt, editor) land at re-enable time, the bound path will overwrite one of
them without preserving an artifact, unless the editor disagrees with both
disk and crdt.

In the iPad case, by the time the desktop's `REMOTE_FROM_DESKTOP` propagates
into the iPad's CRDT, the editor still shows whatever Obsidian last rendered
(possibly `BASELINE_PROOF\n\nLOCAL_ON_IPAD\n` from before disable, possibly
the post-rebind state pulled from CRDT). One of:

- editor matches disk and disagrees with crdt → `localOnly` → CRDT
  overwritten with disk content (`LOCAL_ON_IPAD` would survive if this
  fired, but only as long as no later cycle pushes it back).
- editor matches crdt and disagrees with disk → `crdtOnly` → CRDT pushed
  back to disk, **`LOCAL_ON_IPAD` lost without artifact**. This is most
  consistent with the observed end state.

That is the gap. The bound branch silently picks a winner with no artifact,
and for one common ordering that winner is the remote CRDT.

## Bug 2 — the desktop recovery loop after the iPad bug

The user then walks to the desktop and types. The trace shows what follows
is a tight loop: every ~2.4s,

```text
recovery.decision  reason: bound-file-local-only-divergence  CRDT(N) → DISK(N+5)
recovery.apply.start
recovery.apply.done  matchesExpected: true
editor.repair.applied
device.witness.diverged  originClass: recovery  reason: disk_crdt_mismatch
       crdtHash[t+1] === diskHash[t]   (chained)
… repeat
```

`crdtHash` at cycle N+1 equals `diskHash` at cycle N. Every cycle the disk
is exactly 5 chars longer than the previous CRDT. Five chars matches the
length of the trailing fragment `SKTOP` that keeps duplicating in the file.
The user typed `oooo` somewhere else; the loop is not about what they typed,
it is about the converging side itself.

### Why each cycle adds exactly 5 chars

The user-visible content shows the loop didn't just append once; it appended
the suffix `SKTOP` of `REMOTE_FROM_DESKTOP` over and over. That is a
classic sign of a stale-base diff being applied repeatedly without the
old anchor advancing.

Look at `applyDiffToYTextWithPostcondition`:

```typescript
const currentText = ytext.toString();
if (currentText !== oldText) {
    forceReplaceYText(ytext, newText, origin);
    return { diffSkippedDueToStaleBase: true, ... };
}
applyDiffToYText(ytext, oldText, newText, origin);
```

The bound recovery calls it as
`applyDiffToYTextWithPostcondition(ytext, crdtContent, content, ...)` where
`crdtContent = yTextToString(existingText)` is read at the top of
`handleBoundFileSyncGap`. If between that read and the diff application the
CRDT mutates (which it does — collab edits, remote provider updates,
in-flight typing into the editor whose binding pushes into CRDT), the
postcondition fallback kicks in and `forceReplaceYText` runs. The diff
gets converted into a wholesale delete-all-then-insert-all.

The loop trace shows `forceReplaceApplied: false` on every cycle, so the
fallback is NOT being taken — the diff itself is succeeding. So the cycle is
not a stale-base re-apply. It is something else replenishing the divergence
each cycle.

### What replenishes the divergence

The witness event timing reveals it: each `device.witness.diverged` fires
~2s **after** the corresponding `recovery.apply.done`. The witness's
`stableAfterMs` is 2000ms — it samples disk and CRDT, waits 2s, samples
again, and emits if both samples disagree. So the "still diverged after 2s"
fact is real, not phantom.

The implication: after each successful `apply-diff` recovery (CRDT now
equals disk), one of the following must happen within 2s to put them back
into divergence:

(a) The disk grows by 5 chars. Either Obsidian's autosave or our own
    `flushWriteUnlocked` writes a file that is 5 chars longer than what we
    just put into CRDT.
(b) The CRDT shrinks by 5 chars. Some path is reverting the recovery.
(c) Both CRDT and disk move, ending up 5 apart again.

Trace count of `disk.modify.observed` events: 29, with sizes growing
45 → 54 → 71 → 84 → 89 → 94 → 99 → 104 → ... in the same 2-3s cadence as
the recovery cycles. So (a) is real: disk IS growing in lockstep with the
recovery cycles. The question is who is writing it.

There are only two writers to disk for this path:
- our `flushWriteUnlocked` (driven by CRDT updates that pass `isLocalOrigin`
  filter or by our recovery itself).
- Obsidian's autosave, which fires when the editor mutates.

`flushWriteUnlocked` calls `await this.suppressWrite(path, content)` before
`vault.modify(...)`, and the trace shows zero `disk.write.ok` events in the
loop window. So our writes are not driving the disk growth. **Obsidian
autosave is.**

But the editor binding is supposed to also push every editor mutation into
CRDT through `YSyncPluginValue.update`. The y-sync plugin updates ytext
from CodeMirror changes inside `ytext.doc.transact(..., this.conf)`, where
`this.conf` is a YSyncConfig instance. That transaction origin is the
config object, not a string. `isLocalStringOrigin` returns false for
non-strings. `isLocalOrigin` falls back to provider equality.

So if the editor → CRDT propagation ever stops working (the binding is
broken in a way that lets CodeMirror dispatch text changes without the
ySync plugin running), every keystroke writes the new text to the editor
buffer, Obsidian autosaves it to disk, but CRDT does not see the change.
The next reconcile sees `editor matches disk, editor != crdt`, runs the
local-only branch, applies a diff CRDT-to-disk via the recovery origin,
and emits `editor.repair.applied`. Then the user types more, autosave
fires again, divergence reopens.

That matches what the trace shows: `editor.repair.applied` after every
recovery cycle, with `reason: bound-file-local-only-divergence`. The
divergence is exactly the user's last keystroke burst (5 chars).

### So which path is bypassing the y-sync editor → CRDT plugin

There are three plausible mechanisms:

1. **`y-sync` plugin destroyed or never installed.** The compartment was
   reconfigured to `[]` by `unbind()` and a subsequent reconfigure to
   `yCollab(...)` did not stick. `applyBinding` only checks
   `cm.dispatch` did not throw — it does not verify `ySyncFacet` is now
   present in `cm.state.facet(ySyncFacet)`. The post-bind health check
   exists (`schedulePostBindHealthCheck`), but it logs/heals, it does not
   block typing.

2. **`heal()` was called and tainted the CRDT with stale editor content,**
   then immediately the next recovery overwrote disk-into-CRDT, but the
   editor moved on (user typed more) before the next CRDT observe propagated
   back. The recovery-amplifier test specifically calls out heal() as the
   contamination path; the controller is supposed to use repair() not heal().
   Trace confirms `editor.repair.applied`, not `editor.heal.applied`. So
   not this.

3. **The editor's CodeMirror state has a different y-sync facet than the
   tracked binding's ytext.** This happens when Obsidian recreates the
   `EditorView` (note close+reopen, leaf relocate, file rename) without
   our binding manager noticing. The compartment from the OLD view is
   gone; the NEW view's compartment is empty. `getCmView` returns the new
   view, our `getCollabDebugInfoForView` reports `hasSyncFacet: false`
   (or wrong ytext), and `validateOpenBindings` should call repair. The
   trace does show `editor.repair.applied` runs every cycle, with
   `reason: bound-file-local-only-divergence`. But `applyBinding`
   reconfigures the compartment to a fresh `yCollab(ytext, ...)`. After
   that, y-sync's plugin sees the OLD CRDT (`crdtContent`) and the NEW
   editor content, but the plugin's first action on construction is just
   to register the observer — it does NOT push initial content either way.
   So if the editor was 5 chars longer than ytext at the moment of repair,
   that 5-char divergence is preserved across the repair, and the next
   keystroke widens it further.

Mechanism 3 is the most consistent explanation:

- After our recovery `applyDiffToYText` runs, CRDT equals disk equals editor
  for one tick.
- The user types the next 5 chars. y-sync's `update()` runs on that
  CodeMirror update and writes it into ytext. CRDT advances. An afterTransaction
  fires; diskMirror's `observeText` handler skips because origin is the
  YSyncConfig (not local-origin string but the same provider awareness?).
- Obsidian autosave fires, disk advances by 5.
- Now disk and CRDT are equal again, in theory.
- BUT — the ySync plugin's "is this a local change" decision is
  `tr.origin !== this.conf` (in the observer). When yCollab applies an
  external CRDT update, it dispatches a CM transaction with
  `annotations: [ySyncAnnotation.of(this.conf)]`. The check the plugin
  makes inside `update()` is `update.transactions[0].annotation(ySyncAnnotation) === this.conf`,
  meaning "skip if this update was caused by us echoing CRDT into the
  editor." That covers the round-trip. It does NOT cover what happens when
  our recovery code calls `applyDiffToYText(ytext, ..., ORIGIN_DISK_SYNC_RECOVER_BOUND)`.
  In that case, the ySync plugin's `_observer` sees `tr.origin === ORIGIN_DISK_SYNC_RECOVER_BOUND`,
  which is not equal to `this.conf` (`!==` is true), so it DOES dispatch
  the delta into CodeMirror. Good.
- BUT — at the precise moment the recovery transaction commits, the editor
  is in the middle of an active typing burst. The ySync `update()` is
  about to fire for the keystroke. The order of operations matters and is
  not guaranteed. If the recovery delta lands on the editor before the
  keystroke's update is captured, the editor's value briefly diverges from
  what the user sees on screen, and the user's next keystroke is computed
  against the post-recovery editor state, so the next CRDT update encodes
  a partial or shifted edit. This is consistent with the SKTOP fragment
  duplicating: the recovery keeps reapplying the disk content (which
  contains the full `REMOTE_FROM_DESKTOP`), then the editor's stale
  position-aware delta inserts only the suffix that "completes" what the
  user typed-against, producing duplicate `SKTOP`s.

This is the recovery-amplifier mechanism the test file specifically warned
about (`tests/recovery-amplifier.ts`, mechanism B), but in a slightly
different form. The fix for B was "use repair() not heal()" inside the
controller. That fix is in place. What we did NOT defend against is
**applying a CRDT-side recovery diff against an editor that is actively
mutating**.

### Why `OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS` does not save us here

The 1.2s idle guard exists in the `crdtOnly` branch. The loop is in the
`localOnly` branch, which has no such guard. The localOnly branch's
contract is "editor is the local authority and disk reflects it; CRDT must
be brought up." That contract is correct when nothing else is mutating
disk. It is dangerously wrong when something — Obsidian autosave fired
while user is typing — keeps moving disk forward 5 chars at a time
between every recovery cycle.

## Why the existing tests do not catch either bug

The existing test suite covers the closed-file path (`closedFileConflict.ts`)
exhaustively. The bound path that actually fires on a re-enable while the
file is open is covered only at the level of "the right reason gets emitted";
there is no test that runs the iPad-shaped sequence end-to-end with the
correct three-authority race ordering.

`tests/recovery-amplifier.ts` documents mechanism A (diskMirror loop) and
mechanism B (heal contamination). Both are at the Yjs/origin layer, not the
controller layer. The controller-level recovery orchestration test
(`tests/controller-recovery-orchestration.ts`) covers the quarantine threshold
(3 identical fingerprints in a row). But the loop the user hit is NOT
quarantined, because each cycle's fingerprint is different: the disk grows
by 5 chars each cycle, so `recoverySignature(reason, prev, next)` differs
every time. The fingerprint TTL window does not matter because the prev/next
hashes never repeat.

The quarantine system is fingerprint-based. It works for "same diff
repeating." It does not work for "diff growing along an axis." The iPad
loop is the latter.

## Summary

Two distinct bugs, neither solved by the 2026-05-27 patch:

| | Bug 1 (iPad clean-disable) | Bug 2 (desktop recovery loop) |
|-|-|-|
| Code path | `handleBoundFileSyncGap` | `handleBoundFileSyncGap` localOnly branch |
| Why current fix misses | `decideClosedFileConflict` is not consulted when the file is editor-bound at re-enable | localOnly branch has no idle-grace guard and no fingerprint-growth detector |
| Symptom | Local edit silently lost, no artifact | Content duplicates trailing fragments every ~2.4s while typing |
| Bound by quarantine? | n/a | No: each fingerprint is unique because disk grows |
| Bound by `OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS`? | n/a | No: localOnly branch does not check it |
| Real-device proof? | Yes — this trace | Yes — same trace, after the user starts typing on desktop |

## What a fix has to do, at minimum

For Bug 1, on the bound-path re-enable case:

- When `handleBoundFileSyncGap` runs and the file was `wasBound` from a
  prior session boundary (re-enable, reload), prefer creating a conflict
  artifact for the loser side instead of silently picking a winner. The
  closed-file `both-changed` policy is the right shape; it is missing from
  the bound path. This needs a new bound-path `both-changed` analog that
  preserves the loser as an artifact even if the editor matches one of the
  two.
- The detection signal exists: the bound path can compute the same three
  hashes (`baselineHash`, `diskHash`, `crdtHash`) and run the same
  classifier. If the classifier returns `preserve-conflict`, do not let
  the bound code's `localOnly` / `crdtOnly` heuristics override it.

For Bug 2:

- Add an idle-grace guard to the localOnly branch symmetric to the
  crdtOnly branch. Trade-off: this can stall recovery for ≥1.2s when the
  user has just typed.
- OR: detect "growing fingerprint" loops by tracking the lengths of
  prev/next over a window. If `nextLength - prevLength` is constant and
  cycles are < N seconds apart, quarantine.
- OR: re-examine whether the y-sync `update()` is firing on every
  keystroke for this binding. If it is, CRDT should be advancing in
  lockstep with disk and the localOnly branch should never see persistent
  divergence. If it is not, the binding has a deeper integrity bug that
  no amount of recovery logic can paper over.

The third option is the structurally correct one. The first two are
mitigations.

## What needs to happen before the next iPad run

1. Decide whether to carry the closed-file mtime tie-break code. It is
   correct for the cold-kill desktop variant it targets, but it does not
   cover the user's actual workflow. Keeping it is fine; relying on it as
   "the iPad fix" is wrong.
2. Either patch the bound path, or document explicitly that the bound path
   has no conflict-artifact behavior and that re-enabling YAOS while a
   file is open is a known data-loss surface.
3. Decide what to do about the localOnly recovery loop when typing. The
   user can reproduce this in 30 seconds locally; the next iPad trip is
   not blocking on this — desktop CDP is sufficient.
4. Restore `~/temenos/issue22b-ipad-proof.md.md` to a clean state before
   the next attempt; the file currently contains accumulated `SKTOP`
   fragments that will confound future runs.

## Files to review

- `src/runtime/reconciliationController.ts` — `handleBoundFileSyncGap`
  branches at lines 1450, 1670 (localOnly, crdtOnly), 1853 (ambiguous)
- `src/sync/closedFileConflict.ts` — the closed-file decision used
  outside the bound path
- `src/sync/diff.ts` — `applyDiffToYTextWithPostcondition` and the
  recovery-time stale-base detection
- `src/sync/editorBinding.ts` — `applyBinding`, `repair`, `heal`,
  `validateOpenBindings`, `maybeHealBinding`
- `node_modules/y-codemirror.next/src/y-sync.js` — the CodeMirror →
  ytext propagation that is suspected of being silently bypassed
- `tests/recovery-amplifier.ts` — mechanisms A and B documented; mechanism
  3 (the one that actually fired) is not covered.
