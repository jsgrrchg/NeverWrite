# AI Change Control

NeverWrite's AI change control system is the safety layer between agent-authored
file edits and the user's vault. It tracks what the agent changed, lets the user
accept or reject all or part of those changes, and protects against stale writes
when the file changed outside the tracked agent flow.

The important rule: pending review is modeled as agent-owned text spans. Line
hunks, inline controls, review cards, and diff stats are derived views.

## Overview

AI file diffs are consolidated into an ActionLog on the active chat session. The
ActionLog survives across work cycles and stores one accumulated tracked-file map
per session, keyed by stable `identityKey`.

Key source files:

- [`apps/desktop/src/features/ai/diff/actionLogTypes.ts`](../apps/desktop/src/features/ai/diff/actionLogTypes.ts) defines the persisted domain shape.
- [`apps/desktop/src/features/ai/store/actionLogModel.ts`](../apps/desktop/src/features/ai/store/actionLogModel.ts) owns pure tracked-file operations and invariants.
- [`apps/desktop/src/features/ai/store/actionLogRustEngine.ts`](../apps/desktop/src/features/ai/store/actionLogRustEngine.ts) calls the Rust/WASM engine with JS fallback.
- [`crates/diff/src/action_log.rs`](../crates/diff/src/action_log.rs) implements the shared diff/review algorithms.
- [`apps/desktop/src/features/ai/store/chatStore.ts`](../apps/desktop/src/features/ai/store/chatStore.ts) wires ActionLog updates, user decisions, disk conflict checks, and persistence.

## Data Model

`TrackedFile` has canonical fields and derived fields.

Canonical fields:

- `identityKey`, `originPath`, `path`, `previousPath` identify the file across moves.
- `status` records lifecycle: created, modified, or deleted.
- `reviewState` is `pending` while an agent work cycle is in-flight and `finalized` when ready for ordinary review actions.
- `diffBase` is the current pre-agent baseline. It is intentionally rebased when the user edits non-agent-owned text.
- `diffBaseHash` and `diffBaseCapturedAt` cache baseline metadata for drift detection and legacy repair.
- `currentText` is the last tracked agent-applied text.
- `unreviewedRanges` is the canonical pending agent attribution as `AgentTextSpan[]`.
- `version`, `isText`, `updatedAt`, and `conflictHash` drive cache invalidation, filtering, and conflict UI.

Derived fields:

- `unreviewedEdits` is a `LinePatch` derived from `diffBase`, `currentText`, and `unreviewedRanges`.
- Review hunks/chunks are derived by [`reviewProjectionIndex.ts`](../apps/desktop/src/features/ai/diff/reviewProjectionIndex.ts) and [`reviewProjection.ts`](../apps/desktop/src/features/ai/diff/reviewProjection.ts).
- Diff previews convert `unreviewedEdits` to display hunks with `unreviewedEditsToHunks`.

Do not treat derived line ranges as authoritative. Exact accept/reject decisions
must resolve to canonical spans first.

## Core Invariants

The ActionLog domain contract is exposed by `getTrackedFileDomainContract()` and
validated by `validateTrackedFileDomain()`.

Required invariants:

- If `diffBase === currentText`, there must be no pending ranges and no pending line patch.
- Pending ranges must cover the visible diff between `diffBase` and `currentText`.
- Pending ranges must be able to rebuild `diffBase` from `currentText`.
- `unreviewedEdits` must equal the line patch derived from `unreviewedRanges`.
- `diffBaseHash`, when present, must match `hashTextContent(diffBase)`.
- Mutations must return new `TrackedFile` objects. `syncDerivedLinePatch()` caches by object identity and warns in dev when a caller mutates canonical state in place.

Review projection has its own invariants in
[`reviewProjectionDiagnostics.ts`](../apps/desktop/src/features/ai/diff/reviewProjectionDiagnostics.ts):
hunks and chunks must stay in document bounds, chunks must cover their member
hunks, hunk IDs are versioned, and invalid chunks degrade inline rendering.

## Lifecycle

1. Agent diffs arrive in `chatStore`.
2. `consolidateActionLogDiffs()` normalizes incoming diffs and calls `consolidateTrackedFiles()`.
3. New tracked files are created with `createTrackedFileFromDiff()`. Existing tracked files are updated with `updateTrackedFileWithDiff()`.
4. Unsupported diffs (`is_text === false` or `reversible === false`) are not tracked for review.
5. New agent edits clear `lastRejectUndo`, because the previous undo snapshot is no longer safe.
6. At work-cycle finalization, `finalizeTrackedFiles()` moves pending tracked files to `reviewState: "finalized"`.

User edits while AI changes are pending go through `notifyUserEditOnFile()` and
`applyNonConflictingEdits()`. The algorithm rebases `diffBase` over user-owned
edits while preserving only untouched agent spans. If the user edits inside an
agent span, that span is retired from agent attribution.

This means the Review tab should show only remaining agent-owned work, not
ordinary user edits made after the agent patch landed.

## Keep And Reject

Keep all:

- `keepEditedFile()` removes one tracked file from the ActionLog.
- `keepAllEditedFiles()` clears all tracked files and clears reject undo.
- No disk write is needed because accepting means the current file content is already the desired content.

Reject all:

- `rejectEditedFile()` prepares the mutation, checks conflicts, restores disk via `rejectTrackedFileAndReload()`, removes the tracked file, and stores undo data.
- `rejectAllEditedFiles()` repeats the same conflict-aware path per file and keeps conflicted files visible.
- Restore behavior is lifecycle-aware through `computeRestoreAction()`: delete newly-created files, restore overwritten/modified/deleted files, and undo moves when needed.

Inline or partial review:

- `resolveReviewHunks()` verifies the tracked version, expands overlapping hunks to a safe closure, resolves the selected hunks to exact spans, then applies `keepExactSpans()` or `rejectExactSpans()`.
- Partial accept updates `diffBase` so accepted spans become baseline and remaining spans stay pending.
- Partial reject writes the updated `currentText` back to disk via `ai_restore_text_file`, reloads open editors, and stores an undo snapshot.
- If a partial decision empties the pending patch and the path returned to `originPath`, the tracked file is removed.

## Review Surfaces

There are two review surfaces:

- Full Review tab: [`AIReviewView.tsx`](../apps/desktop/src/features/ai/components/AIReviewView.tsx) opens from the editor and shows pending changes with global actions, expansion state, zoom, persisted scroll/anchor state, and per-file diff cards.
- Compact Edits surface: [`EditedFilesBufferPanel.tsx`](../apps/desktop/src/features/ai/components/EditedFilesBufferPanel.tsx) appears in the chat sidebar and offers compact keep/reject/review/undo actions.

Both surfaces render shared rows through
[`EditedFilesReviewList.tsx`](../apps/desktop/src/features/ai/components/EditedFilesReviewList.tsx)
and derive file items from the same tracked-file projection. Keep user-facing UI
copy in English.

Review projection groups spans into hunks and chunks:

- A hunk corresponds to one exact span or a set of member spans.
- A chunk groups nearby hunks for display and controls.
- Conflicted chunks are `panel-only`.
- Ambiguous overlapping chunks use grouped inline controls.
- Multi-hunk chunks may be resolved as a group when that is clearer than one control per span.

## Inline Review And Merge View

Inline review is gated by vault settings in
[`editorReviewGate.ts`](../apps/desktop/src/features/editor/editorReviewGate.ts).
It is enabled only for source mode and when `inlineReviewEnabled` is true for
the current vault.

Editor synchronization happens in two layers:

- [`editorReviewSync.ts`](../apps/desktop/src/features/editor/editorReviewSync.ts) can force-reload an open editor to the tracked `currentText` when it is safe. It avoids overwriting user/editor content unless the open text still matches the tracked baseline or is a transient empty document.
- [`mergeViewSync.ts`](../apps/desktop/src/features/editor/mergeViewSync.ts) resolves the open editor target to a tracked file, verifies the editor document matches `tracked.currentText`, builds the review projection, and configures CodeMirror merge extensions.

The CodeMirror layer lives in:

- [`extensions/mergeViewDiff.ts`](../apps/desktop/src/features/editor/extensions/mergeViewDiff.ts) for merge state facets, diff rendering, runtime metadata, and decision payloads.
- [`extensions/reviewProjectionControls.ts`](../apps/desktop/src/features/editor/extensions/reviewProjectionControls.ts) for inline Accept/Reject controls.
- [`extensions/changeRail.ts`](../apps/desktop/src/features/editor/extensions/changeRail.ts) for scrollbar rail markers.

If the editor document is stale, preview mode is active, the target cannot be
resolved, or projection diagnostics are invalid, inline review degrades instead
of applying misleading controls.

## Rust Engine And Fallback

The frontend calls the Rust/WASM diff engine for:

- line diffing and text-range patch creation;
- span mapping through user edits;
- rebasing `diffBase`;
- exact keep/reject;
- reject undo;
- word diffs for inline refinement.

The bindings are in [`crates/diff/src/wasm_bindings.rs`](../crates/diff/src/wasm_bindings.rs).
`actionLogRustEngine.ts` initializes WASM in dev/test and runtime, wraps every
operation in `callWithFallback()`, and records fallback stats through
`getRustFallbackStats()`. The JS fallback in
[`actionLogJsFallback.ts`](../apps/desktop/src/features/ai/store/actionLogJsFallback.ts)
is a compatibility path, not a separate source of truth. Keep Rust and fallback
behavior aligned with tests.

## Conflict Handling

Before reject or partial hunk resolution, `chatStore` checks that disk still
matches the tracked applied content:

- `ai_get_text_file_hash` hashes the current vault file through the native backend.
- `hasConflict()` compares that hash to `hashTextContent(tracked.currentText)`.
- Deleted files are allowed to have no on-disk path when `status.kind === "deleted"`.
- Moved files also check that `originPath` has not been reused.
- `hasConflictAfterSettle()` retries short applied-content mismatches to avoid racing agent-origin reloads.
- `reconcileTrackedFileWithPersistedContentIfSafe()` can update tracked `currentText` when a recent agent-origin reload proves the persisted file is the real applied content.
- If conflict remains, `conflictHash` is set and the file stays in review instead of being removed.

Native restore is handled by
[`apps/desktop/native-backend/src/main.rs`](../apps/desktop/native-backend/src/main.rs):

- `ai_restore_text_file` writes restored content, deletes files for reject-created cases, handles move-back paths, refreshes vault state, advances note/file revisions, and emits an agent-origin vault change.
- `ai_get_text_file_hash` returns `null` for missing files and a content hash for existing files.

Never bypass these checks for reject paths. Accept-all can be store-only because
the accepted content is already on disk, but partial reject must write the new
`currentText`.

## Persistence And Recovery

ActionLog state is persisted inside `AIChatSession`.

Storage model:

- `trackedFilesByIdentityKey` is authoritative normalized session storage.
- `trackedFileIdsByWorkCycleId` records which identities belong to each work cycle.
- `trackedFilesByWorkCycleId` is legacy compatibility storage and is rebuilt/normalized on read.
- `lastRejectUndo` stores per-file undo buffers plus full tracked-file snapshots.

Recovery behavior:

- `normalizeActionLogStorage()` merges legacy and normalized state, preferring newer/higher-version/pending files.
- `syncDerivedLinePatch()` repairs missing/stale derived fields and legacy missing range/hash metadata.
- `undoLastReject()` restores snapshots only when disk still matches a safe restore condition, then re-tracks restored files and leaves failed snapshots in undo.
- Review tab scroll/anchor state is stored separately by `reviewTabPersistence` and does not affect the ActionLog domain.

## Validation Checklist

When changing this subsystem, run the narrowest relevant set first:

```bash
cd apps/desktop
npm run test -- src/features/ai/store/actionLogModel.test.ts
npm run test -- src/features/ai/store/actionLogRustEngine.test.ts src/features/ai/store/actionLogRustEngineFallback.test.ts
npm run test -- src/features/ai/diff/reviewProjection.test.ts src/features/ai/diff/reviewProjectionIndex.test.ts
npm run test -- src/features/editor/editorReviewGate.test.ts src/features/editor/editorReviewSync.test.ts src/features/editor/mergeViewSync.test.ts src/features/editor/extensions/mergeViewDiff.test.ts
npm run test -- src/features/ai/components/AIReviewView.test.tsx src/features/ai/components/EditedFilesBufferPanel.test.tsx src/features/ai/components/reviewMultiSessionIntegration.test.tsx
```

For Rust-side changes, also run the diff crate tests:

```bash
cargo test -p neverwrite-diff
```

Manual smoke checks:

- Agent modifies a file, then the user accepts from the compact Edits surface.
- Agent modifies a file, then the user rejects from the Review tab and uses Undo.
- Agent changes two words on one line, then the user accepts/rejects only one inline hunk.
- User edits a non-overlapping line while AI edits are pending; the pending diff should rebase and still show only agent-owned spans.
- User edits inside an agent hunk; that hunk should disappear from pending review.
- External disk edit before reject should mark conflict and keep the file visible.
- Move/rename reject should restore content to `originPath` and remove the moved path when appropriate.

## Known Limits

- Only reversible text diffs are tracked for full review. Binary or irreversible diffs get limited UI.
- Inline diff is hidden when a non-created file has an empty `diffBase`; positions would be unreliable.
- Inline controls degrade to panel-only for conflicts and invalid projections.
- Exact decisions are span-based, but visual grouping can merge nearby or overlapping spans for clarity.
- Reject undo is intentionally shallow: it is valid only until new agent edits arrive or disk state makes the stored snapshot unsafe.
- The JS fallback exists for availability, but Rust/WASM is the expected engine. Non-zero fallback stats should be treated as diagnostic signal.

Last updated: May 11, 2026.
