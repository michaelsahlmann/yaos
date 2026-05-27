# Issue #25 (variant) — bound-file-local-only recovery amplifier timeline

Source trace: `~/temenos/.obsidian/plugins/yaos/flight-logs/2026-05-27/boot-wL7i012vR4mGXA-1.ndjson`
pathId: `p:476818d2ecba90d4e95e2a0c4f3ad1eb`
file: `issue22b-ipad-proof.md.md`
device: desktop, foreground, pluginVersion 1.6.1, taxonomyVersion 9
helper: `qa/scripts/issue22b-loop-summary.mjs`

## Cycle template, exact values from the trace

```
T+0.000s   disk.modify.observed       size grows by +5    ← Obsidian autosave
T+0.357s   recovery.decision          edEqDisk=true edEqCrdt=false action=apply-diff
T+0.357s   recovery.decision          (DUPLICATE — see "logging bug" below)
T+0.357s   recovery.apply.start       origin=disk-sync-recover-bound
T+0.357s   recovery.apply.done        matches=true forceR=false
T+0.357s   editor.repair.applied      compartment reconfigure
T+2.353s   disk.modify.observed       size grows by +5    ← next autosave
T+2.355s   device.witness.diverged    originClass=recovery fileOpen=true
                                       crdtH(t+1) === diskH(t)        // chained
T+2.713s   recovery.decision          (next cycle)
... repeats ...
```

Concrete values, cycles 6 through 13:

| cycle | T(s)   | disk size | crdtLen | diskLen | Δdisk | crdtH (prefix) | diskH (prefix) |
|------:|-------:|----------:|--------:|--------:|------:|----------------|----------------|
| 6     | 30.737 |  120      |  115    |  120    | +11   | 91649d0d       | d81d479a       |
| 7     | 33.100 |  125      |  120    |  125    |  +5   | d81d479a       | 3402eebb       |
| 8     | 35.452 |  130      |  125    |  130    |  +5   | 3402eebb       | 2b1f1278       |
| 9     | 37.807 |  135      |  130    |  135    |  +5   | 2b1f1278       | 5e5ba859       |
| 10    | 40.164 |  140      |  135    |  140    |  +5   | 5e5ba859       | 4aafdc0e       |
| 11    | 42.518 |  145      |  140    |  145    |  +5   | 4aafdc0e       | 22722c87       |
| 12    | 44.876 |  150      |  145    |  150    |  +5   | 22722c87       | 7ae70fcc       |
| 13    | (later) |  ...     |  ...    |  ...    |  +5   | ...            | ...            |

Period ≈ 2.36s, locked to the witness `stableAfterMs` of 2000ms plus the
controller's reconcile latency of ~360ms.

## Answer to the central question

> After `recovery.apply.done`, what event makes disk diverge again?

**Inferred answer:** the next user keystroke being autosaved by Obsidian.
This is the strongest hypothesis given the evidence; the writer was not
positively identified by the trace at the time this document was written.

What the trace at that time DID prove:
- Disk size grew by +5 chars per cycle, in lockstep with witness divergence.
- No `disk.write.ok` events were emitted on this path during the loop
  window. YAOS's own `flushWrite` records a `disk.write.ok`, so the
  absence of that event means YAOS was not the writer.
- The growth cadence (~2.36s) matches the witness `stableAfterMs` of
  2000ms plus the controller's reconcile latency, which also matches
  human typing burst cadence with Obsidian's autosave debounce.

What the trace at that time did NOT prove:
- The writer identity is not labeled in `disk.modify.observed` events
  prior to taxonomy version 10. After the editor-bound localOnly
  amplifier guard spec, those events carry `writerGuess`,
  `suppressWindowActive`, `lastDiskWriteOkAtMs`, and
  `msSinceLastDiskWriteOk` so future RCAs can confirm the inference
  without inferring from absence-of-write-ok.

After every successful recovery:
- CRDT == disk == editor at the instant of `recovery.apply.done`
  (postcondition reports `matchesExpected: true`).
- Roughly 2 seconds later, the user types another 5 characters and Obsidian's
  autosave fires (`disk.modify.observed` arrives, size grew by +5).
- The witness's `stableAfterMs=2000` timer (started by `markDirty("recovery")`
  inside `recordFlightPathEvent`) fires almost simultaneously, samples
  `disk` and `crdt`, finds them off by 5, emits `device.witness.diverged`
  with `originClass: recovery` because `lastRecoveryAt` is the most recent
  cause it knows about.
- ~360ms later, the controller's `handleVaultModify → syncFileFromDisk`
  pipeline runs `handleBoundFileSyncGap`, sees `editor matches disk` and
  `editor differs from crdt` (because the keystroke reached disk via
  autosave but did not yet reach the CRDT pre-reconcile snapshot), and
  fires another `bound-file-local-only-divergence` recovery.
- That recovery applies the +5 diff into the CRDT, briefly making them
  equal again, and immediately calls `editorBindings.repair()` which
  reconfigures the compartment — and the cycle restarts.

Why the +5 stays exactly 5 every cycle and never grows: the user is
typing in steady ~5-character bursts, and the recovery interval matches
the typing burst interval almost perfectly. The system has settled into a
1-burst-behind steady state. If the user stopped typing, CRDT would catch
up on the next cycle, the recovery would emit `crdtContent === content`
no-op, and the loop would stop. If the user typed faster, the gap would
grow and the diff would be larger but the loop would still run.

The trace evidence confirms this: at T=23.226s through T=30.737s, after
`recovery-lock-active` skip, when the user paused, the next divergence
was **+11 chars** (catching up two bursts at once), and after that the
delta returned to exactly +5. The user resumed steady typing.

## Why each piece of the existing protection misses

### `recovery-lock-active` (1500ms BOUND_RECOVERY_LOCK_MS)

This DOES fire — `seq=109` and `seq=178` are `recovery.skipped` with
`reason: recovery-lock-active`. It works for back-to-back recovery
attempts within 1.5s. It does NOT fire at the next cycle because cycles
are 2.36s apart; the lock has already expired.

### `shouldQuarantineRepeatedRecovery` (3 same-fingerprint in 60s)

`recoverySignature(reason, prev, next)` produces:

```
"bound-file-local-only-divergence\u0000<crdt-prefix>:<crdt-len>\u0000<disk-prefix>:<disk-len>"
```

Each cycle's `(prev, next)` lengths are unique (40→45, 79→84, 84→89, ...),
and the content prefixes are unique because Y.Text grew. The fingerprint
TTL of 60s does not matter; the signatures never repeat. `count` stays
at 1 forever, never reaches the threshold of 3.

The quarantine system is fingerprint-based. It catches "recovery applies
the same diff over and over." It does not catch "recovery applies a
growing diff at a steady cadence." That is exactly this loop.

### `OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS` (1200ms idle)

This guard exists in `handleBoundFileSyncGap`, but only in the **`crdtOnly`
branch** (line 1672–1697). The `localOnly` branch (line 1451–1665) has
no equivalent. The asymmetry is direct:

```typescript
// crdtOnly branch (line ~1672)
const lastEditorActivity = editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
const hasRecentEditorActivity = lastEditorActivity != null
    && (Date.now() - lastEditorActivity) < OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS;
if (hasRecentEditorActivity) {
    // recovery.skipped: recent-editor-activity
    return true;
}
```

```typescript
// localOnly branch (line ~1451) — NO equivalent guard
if (localOnlyViews.length > 0) {
    // ... straight into recovery.decision and apply-diff
}
```

The reasoning at the time was probably: localOnly = "editor knows
something CRDT doesn't, push it to CRDT." That is correct when the
editor authority is not actively moving. When the editor is being typed
into and Obsidian autosaves on top of it, "editor knows something CRDT
doesn't" is restated every ~2s. Each recovery is then applying yesterday's
news.

### The duplicate `recovery.decision` events

Two `recovery.decision` events appear in the trace per cycle, with the
same data and consecutive seq. This is a logging bug in `src/main.ts`:

```typescript
// recordFlightPathEvent
void this.flightTrace?.recordPath(event);            // FIRST emission
// ... markDirty etc.
if (event.kind === "recovery.decision" && event.path.endsWith(".md")) {
    if (this.flightTrace) {
        const recoverySeq = this.flightTrace.reserveAndRecordPath(event); // SECOND emission
        this.deviceWitnessTracker?.notifyPrecursorEvent(...);
        // ...
    }
    return;  // skips fallthrough but does not undo the first emission
}
```

`reserveAndRecordPath` is meant to replace `recordPath` for `recovery.decision`
specifically, so the witness can get a synchronous seq for precursor
tracking. The `return` was intended to prevent fallthrough to other
handlers, not to nullify the earlier `recordPath`. The first call has
already been queued.

This is purely cosmetic — both emissions carry the same data, the witness
is notified once via `reserveAndRecordPath`, and analyzers that index by
event semantics rather than count are not affected. It does pollute the
flight trace, doubles the entry count for this kind, and makes the trace
harder to read. **Not the loop cause.**

## What the witness actually proves

The `device.witness.diverged` events carry `originClass: recovery`
because `lastRecoveryAt` is the most recent precursor at the moment the
witness samples. This is a **labeling artifact**. The real chain of
causation is:

```
user keystroke → editor buffer update
      ↓
   ┌──┴──┐
   ↓     ↓
y-sync   Obsidian
update   autosave
   ↓     ↓
ytext  vault.modify → disk write
```

These two paths are **not strictly ordered**. The y-sync `update()` runs
on the next CodeMirror tick; the Obsidian autosave runs on its own
schedule (debounced, but at human-typing cadence it fires every ~2s). In
this trace, autosave consistently lands first. Disk leads CRDT by exactly
one keystroke burst, every cycle, forever.

## What this is NOT

It is not a stale-base diff problem (`forceR=false` every cycle, the
diff applies cleanly).

It is not a heal/contamination problem (`editor.heal.applied` never
appears in the trace).

It is not a binding-broken problem (`editor.repair.applied` succeeds
every cycle, and CRDT keeps catching up by the right amount).

It is not the `crdtOnly` guard misfiring (we never enter that branch).

It is not the closed-file conflict policy (file is editor-bound; that
code path is never consulted).

## What this IS

The `localOnly` recovery branch has no idle guard. Every time disk lands
a write (whose source is the same editor we are about to "repair"),
the controller treats it as authoritative and writes it into CRDT,
because it cannot distinguish:

- "external tool edited the file while CRDT was offline" (correct
  recovery target), versus
- "Obsidian autosave is one tick ahead of y-sync" (false target — we
  are applying changes that will reach CRDT on their own in the next ms).

The recovery is doing real work — the postcondition genuinely improves
CRDT — but each pass is also calling `editorBindings.repair()`, which
reconfigures the CodeMirror compartment. That reconfigure does not lose
content (the y-sync plugin re-attaches with the up-to-date ytext), but it
does add ~milliseconds of in-flight-update jitter. Combined with steady
typing, this keeps the autosave-first-vs-y-sync-first race biased toward
autosave-first.

## What a fix has to do, ranked by structural correctness

1. **Add an idle guard to the localOnly branch** symmetric to the
   `crdtOnly` branch. The guard predicate is the same:
   `lastEditorActivity within OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS`.
   Recommended threshold: not 1200ms — too short for human typing
   bursts. Use 3000–5000ms specifically for the localOnly case (the
   crdtOnly threshold can stay 1200ms because that branch is only
   meaningful when the editor IS at rest).

2. **Stop calling `editorBindings.repair()` unconditionally on every
   recovery.** Repair the binding only when health markers say the
   binding is unhealthy (`hasSyncFacet === false`,
   `yTextMatchesExpected === false`, etc., already exposed via
   `getCollabDebugInfoForView`). This removes the per-cycle compartment
   reconfigure, which removes the jitter that biases the race.

3. **Add a length-monotonic amplification quarantine.** If 3+ recoveries
   in 15s on the same path produce monotonically growing
   `(prevLen, nextLen)` pairs with the same delta, quarantine the path:
   stop running content recovery, emit a recovery.loop.detected, surface
   a notice. Threshold suggestion: same direction × same delta × 3 in
   15s → quarantine.

4. **Single-flight recovery per path with an explicit cooldown after
   apply.done.** Today the only thing that prevents back-to-back recovery
   is `boundRecoveryLocks` (1500ms). That works against tight retries
   but not against typing-cadence cycles. Add a separate cooldown that
   is reset by user activity (so a real external edit during a long pause
   is still handled promptly).

The minimum safe patch is (1) + (3). (2) is the structurally correct fix
and should be done as well; (4) is a defensive net.

## Regression test the patch must pass

Two scenarios, both in deterministic Node tests using
`__qaOnlyForceSyncFileFromDiskUnsafe`:

**Scenario A — typing-cadence loop:**
- Bind file. Set CRDT to "Hello". Set disk to "Hello world" (5 char
  divergence). Set `getLastEditorActivityForPath` to "200ms ago".
- Force one syncFileFromDisk. Assert the localOnly branch emits
  `recovery.skipped` with reason "recent-editor-activity", NOT
  `recovery.apply.start`.
- Advance editor activity to "5 seconds ago". Force another
  syncFileFromDisk. Assert the recovery now applies normally.

**Scenario B — amplification quarantine:**
- Bind file. Run 3 successive recoveries with monotonically growing
  diffs at 3s intervals (50→55, 55→60, 60→65) with `lastEditorActivity`
  always recent.
- Assert that on attempt 3, `recovery.quarantined` and
  `recovery.loop.detected` fire, no `recovery.apply.start`.
- Verify the quarantine is keyed on path + length-monotonic detector,
  not fingerprint identity.

These are tests that fail before the patch and pass after.

## What to leave alone

- The closed-file conflict policy (`closedFileConflict.ts`,
  `decideClosedFileConflict`). Different bug.
- The mtime tie-break and `_lastDiskIndexPersistedAt` field. Correct
  for the cold-kill case it covers; not relevant here.
- The `crdtOnly` branch idle guard. Already correct.
- The fingerprint-based quarantine. Keep it; it covers a different shape.
