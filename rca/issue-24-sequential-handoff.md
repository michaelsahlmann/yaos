# Issue #24: Sequential Device Handoff Failure — RCA and Fix

## Observed Failure

Reporter had ~666 files in their vault. After editing on Device A (laptop)
and switching to Device B (phone), Device B saw an empty or near-empty vault.
Server diagnostic logs showed:

```
journalEntryCount: 2
journalBytes: 103
```

despite clients reporting 664–666 active paths. The server acted as a live
relay only — real-time sync worked when both devices were online, but durable
persistence was broken.

## Root Cause

The old `enqueueSave()` method in `y-partyserver`'s save chain had a
`.catch(() => undefined)` that silently swallowed storage write failures.
When `appendUpdate` failed (likely due to the initial large delta after a
near-empty server reload), `lastSavedStateVector` never advanced. Every
subsequent DO reload re-read the same 2 tiny sentinel journal entries,
computed the same large delta, and failed again silently.

This created a death spiral: the server appeared healthy (connected, syncing)
but never durably persisted the vault state.

## Fix Summary

1. **PersistenceCoordinator** (`server/src/persistenceCoordinator.ts`):
   Extracted save orchestration into a testable unit. Owns save chain,
   state vector advancement, health tracking, checkpoint fallback.

2. **Checkpoint fallback**: After consecutive append failures, immediately
   attempts a full checkpoint rewrite in the same save task. Does not wait
   for a future mutation.

3. **pendingPersistence semantics**: Set at enqueue time (not when save
   starts). Stays `true` when `status === "degraded"` even if queue is empty.

4. **Legacy document migration**: Detects pre-ChunkedDocStore `"document"`
   key with real file state alongside sentinel-only chunked journal.
   Migrates legacy state into chunked checkpoint, deletes legacy key.

5. **Tombstone conflict safety**: Disk files at tombstoned CRDT paths are
   recorded as structured conflicts, not auto-revived (zombie prevention).

6. **Debug endpoint**: Forces `ensureDocumentLoaded()`, returns decoded
   `documentSummary` with `activePathCount`, `activePathsWithText`, and
   consistency counts for deployment validation.

## Validation

- 87 automated regression tests covering pathology, coordinator failures,
  legacy migration, tombstone classification.
- 700-file sequential handoff against real Cloudflare staging deployment.
- 700-file cold-load validation across Worker redeploy boundary (forces
  fresh DO load from durable storage).

## Remaining Limitations

- Real Obsidian sequential handoff should be sanity-tested before release.
  The programmatic Yjs validation does not exercise Obsidian file events,
  disk mirror, editor binding, or mobile lifecycle.
- Tombstone conflicts are surfaced in diagnostics but not yet user-resolvable
  via UI. Files are preserved locally and not synced until explicit action.
- The `capabilities` endpoint reports `maxSchemaVersion: 2` while documents
  use `schemaVersion: 8`. These are different schema concepts (protocol vs
  CRDT document) but the naming should be clarified.
