# Review Hardening Checklist

This manual checklist is the operational companion to
[AI Change Control](./ai-change-control.md). Use it before merging or releasing
changes that touch AI review, inline change controls, the Review tab, the Edits
panel, file restoration, session persistence, or crash recovery.

The core rule to verify throughout: pending review is modeled as agent-owned
text spans. Inline controls, Review tab cards, Edits panel rows, diff stats, and
change rail markers are derived views. User-owned edits must not be attributed
back to the agent.

## Scope

- [ ] Test with `inlineReviewEnabled` on and off for the current vault.
- [ ] Test source mode and preview mode. Inline controls should appear only in
      source mode.
- [ ] Test both review surfaces:
      [Review tab](../apps/desktop/src/features/ai/components/AIReviewView.tsx)
      and
      [Edits panel](../apps/desktop/src/features/ai/components/EditedFilesBufferPanel.tsx).
- [ ] Test shared row behavior through
      [EditedFilesReviewList](../apps/desktop/src/features/ai/components/EditedFilesReviewList.tsx):
      Open, Accept/Keep, Reject, expansion, stats, and badges.
- [ ] Include created, modified, deleted, moved/renamed, conflicted, large text,
      and non-text/binary boundary cases.
- [ ] Verify copy and labels stay in English.

## Setup

- [ ] Start from a disposable vault with at least five files:
      `modified.md`, `created-target.md`, `deleted.md`, `rename-old.md`, and a
      large text/markdown file.
- [ ] Keep the same vault open in a terminal or external editor so external
      disk edits can be made during review.
- [ ] Start desktop from `apps/desktop` with the normal dev command:
      `npm run dev`.
- [ ] Confirm the AI runtime can produce file edits, or use the existing test
      harness/fake runtime if the change is not runtime-specific.
- [ ] Open DevTools before testing and keep the console visible.
- [ ] Clear unrelated pending AI edits before beginning so every visible row
      belongs to the current test session.

## Baseline Smoke

- [ ] Ask the agent to modify one existing text file.
- [ ] Confirm the Edits panel appears in the chat sidebar with one `Edits` row,
      the correct file name, and non-zero `+`/`-` stats.
- [ ] Click `Review` from the Edits panel.
- [ ] Confirm a Review tab opens for the same session and shows `Pending
      Changes`, file count, stats, and the same file row.
- [ ] Expand the file in the Review tab.
- [ ] Confirm the diff content matches the actual on-disk file and the editor
      content.
- [ ] Click `Open` on the file row and confirm the correct file opens.
- [ ] Accept/Keep the file from the Review tab.
- [ ] Confirm the Review tab shows `No pending AI edits` and the Edits panel
      disappears unless an undo banner is expected.
- [ ] Confirm the file content remains as the agent left it.

## Inline Review

- [ ] With inline review enabled, open a modified file in source mode.
- [ ] Confirm inline controls render beside the exact changed ranges.
- [ ] Confirm change rail markers align with the changed ranges and update when
      the editor is scrolled or resized.
- [ ] Accept a single inline hunk.
- [ ] Confirm only that hunk disappears from inline review and the remaining
      agent-owned hunks still appear in the editor, Review tab, and Edits panel.
- [ ] Reject a single inline hunk.
- [ ] Confirm the file is rewritten to remove only that hunk, then reloaded in
      open editors without losing unrelated user text.
- [ ] For two nearby hunks on the same line, confirm controls are grouped or
      de-densified instead of overlapping unreadably.
- [ ] For overlapping/ambiguous spans, confirm inline controls either group the
      safe closure or degrade to panel-only review.
- [ ] For conflicted chunks, confirm inline controls do not offer misleading
      accept/reject actions.
- [ ] Switch the editor to preview mode and confirm inline controls and merge
      view UI disappear.
- [ ] Disable inline review for the vault and confirm Review tab/Edits panel
      still work while inline controls stay hidden.
- [ ] Edit non-agent-owned text while pending AI changes exist.
- [ ] Confirm pending ranges rebase and only agent-owned spans remain in
      review.
- [ ] Edit inside an agent-owned hunk.
- [ ] Confirm that touched hunk is retired from pending review rather than
      overwriting or re-attributing the user's edit.

## Review Tab

- [ ] Open the Review tab from the Edits panel and from an editor entry point if
      available.
- [ ] Confirm the tab is scoped to the correct chat session, even when another
      chat is active.
- [ ] Confirm `Expand`/`Collapse` affects all cards and persists during ordinary
      navigation.
- [ ] Confirm `Wide`/`Center` changes only layout width and does not change
      pending review state.
- [ ] Adjust diff zoom and confirm it affects Review tab diffs without
      corrupting line numbers, wrapping, or inline hunk controls.
- [ ] Scroll deep into a long review, resolve a hunk, switch tabs, then return.
- [ ] Confirm the Review tab restores near the same file/hunk using persisted
      scroll/anchor state.
- [ ] In a second app window, change Review tab expansion or scroll state.
- [ ] Confirm stale persisted state does not clobber newer state from the other
      window.
- [ ] Click per-file `Accept` and confirm the row disappears while disk content
      stays at the current agent-applied text.
- [ ] Click per-file `Reject` and confirm disk content restores to the tracked
      baseline and the row disappears.
- [ ] Click `Keep All` with multiple files and confirm all tracked files clear
      without disk rewrites.
- [ ] Click `Reject All` with multiple files and confirm each rejectable file is
      restored or deleted according to its lifecycle.
- [ ] Confirm conflicted or non-rejectable files remain visible after `Reject
      All` and are counted in the header conflict stat.
- [ ] Confirm empty state offers `Undo Last Reject` only when undo data exists.

## Edits Surface

- [ ] Confirm the compact Edits panel appears only when the active session has
      visible tracked files or undo-only state.
- [ ] Confirm the file count, aggregate stats, and row stats match the Review
      tab.
- [ ] Collapse and expand the Edits panel.
- [ ] Confirm row order is newest updated file first.
- [ ] Confirm `Review` opens the Review tab for the active session with the
      expected title.
- [ ] Confirm compact row `Open` is disabled for deleted files and unavailable
      paths.
- [ ] Accept/Keep one compact row and confirm only that file is removed from
      pending review.
- [ ] Reject one compact row and confirm restore behavior matches the Review
      tab.
- [ ] Use compact `Keep All` and `Reject All` and confirm the same final state
      as the Review tab actions.
- [ ] After a reject, confirm the undo-only banner appears briefly when no
      pending files remain.
- [ ] Click undo from the compact panel and confirm the rejected tracked files
      and disk content are restored when safe.

## File Lifecycle Cases

- [ ] Modified file: reject restores original content; accept keeps agent
      content.
- [ ] Created file with no previous content: reject deletes the created file;
      accept keeps it.
- [ ] Created file over existing content: reject restores the previous content.
- [ ] Deleted file: reject restores the deleted content; accept keeps the file
      deleted.
- [ ] Moved/renamed file: reject restores content to `originPath` and removes
      the moved path when appropriate.
- [ ] Move/rename where `originPath` has been reused externally: reject should
      mark conflict and avoid overwriting the reused path.
- [ ] Markdown note: restore should refresh vault state, note/file revisions,
      and open editor content.
- [ ] Plain text file: restore should refresh the file tree and open editor
      content.
- [ ] Unsupported non-text or irreversible diff: row should be marked partial or
      limited, hunk resolution should be unavailable, and no inline exact
      controls should appear.
- [ ] Binary file boundary: no text diff should be shown as if it were
      reversible.

## Multi-session And Multi-window

- [ ] Create pending edits in session A and session B.
- [ ] Open Review tabs for both sessions.
- [ ] Switch between Review tabs and confirm each tab shows only its own
      session's files.
- [ ] Keep or reject a file in session A and confirm session B is unchanged.
- [ ] Switch active chat sessions and confirm the compact Edits panel follows
      the active session, while already-open Review tabs remain session-scoped.
- [ ] Open two windows against the same vault.
- [ ] Resolve a hunk in one window and confirm the other window updates or
      safely degrades instead of presenting stale actions.
- [ ] Attempt an inline decision from a stale window after the tracked version
      changed.
- [ ] Confirm stale version decisions are ignored or rejected safely and do not
      mutate the wrong spans.
- [ ] Confirm relative path collisions across vaults do not attach review UI to
      another vault's tracked file.

## Reload, Restart, And Crash Recovery

- [ ] With pending AI edits visible, reload the renderer.
- [ ] Confirm the chat session, ActionLog, Review tab state, Edits panel, and
      open editor content recover consistently.
- [ ] Quit and restart the app with the same vault.
- [ ] Restore the chat from Chat History as described in
      [AI Session History And Crash Recovery](./ai-session-history.md).
- [ ] Confirm pending tracked files reappear for the restored session when they
      were persisted.
- [ ] Confirm Review tab scroll/anchor persistence is separate from ActionLog
      persistence; losing scroll state must not lose pending review state.
- [ ] Force an AI runtime disconnect or crash during/after file edits.
- [ ] Confirm the app either reconnects with saved context or asks the user to
      restore/fork without losing already-tracked review state.
- [ ] Reject after recovery and confirm native restore still uses the correct
      vault and path.
- [ ] Undo last reject after recovery and confirm snapshots restore only when
      disk still matches a safe restore condition.

## Conflict Cases

- [ ] Modify a pending file externally before clicking per-file `Reject`.
- [ ] Confirm reject does not overwrite the external edit, sets conflict state,
      and keeps the file visible.
- [ ] Modify a pending file externally before `Reject All`.
- [ ] Confirm conflicted files remain visible while non-conflicted files are
      restored.
- [ ] Modify a pending file externally before rejecting a single inline hunk.
- [ ] Confirm no partial restore is written and the file becomes conflicted.
- [ ] Delete a pending modified file externally before reject.
- [ ] Confirm missing-file handling is safe and does not crash the Review tab.
- [ ] Recreate a deleted or moved path externally before reject.
- [ ] Confirm the app avoids overwriting externally-created content.
- [ ] Trigger a short race where the applied content hash has not settled yet.
- [ ] Confirm reject waits/retries and succeeds only when the file matches the
      tracked current text.
- [ ] After a conflict, apply a new agent diff for the same tracked file.
- [ ] Confirm stale `conflictHash` clears only when the new tracked state is
      safe.

## Performance And Large Files

- [ ] Test a file with many small hunks across the document.
- [ ] Confirm Review tab expansion, scrolling, diff zoom, and line wrapping
      remain responsive.
- [ ] Confirm inline controls do not overlap in dense clusters.
- [ ] Confirm change rail marker geometry remains aligned after resize, zoom,
      and scrolling.
- [ ] Test a large file where stats may be approximate.
- [ ] Confirm approximate stats are displayed consistently across Review tab and
      Edits panel.
- [ ] Confirm accepting/rejecting a hunk in a large file does not freeze the UI
      or lose scroll/anchor state.
- [ ] Confirm invalid or out-of-bounds projection diagnostics degrade inline
      rendering rather than crashing.
- [ ] Watch DevTools for repeated warnings, unhandled promise rejections, or
      runaway storage writes while scrolling.

## Automation To Run

Run the narrow review/change-control set first:

```bash
cd apps/desktop
npm run test -- src/features/ai/store/actionLogModel.test.ts
npm run test -- src/features/ai/store/actionLogRustEngine.test.ts src/features/ai/store/actionLogRustEngineFallback.test.ts
npm run test -- src/features/ai/diff/reviewProjection.test.ts src/features/ai/diff/reviewProjectionIndex.test.ts
npm run test -- src/features/ai/components/AIReviewView.test.tsx src/features/ai/components/EditedFilesBufferPanel.test.tsx src/features/ai/components/reviewMultiSessionIntegration.test.tsx src/features/ai/components/reviewTabPersistence.test.ts
npm run test -- src/features/editor/editorReviewGate.test.ts src/features/editor/editorReviewSync.test.ts src/features/editor/mergeViewSync.test.ts src/features/editor/extensions/mergeViewDiff.test.ts src/features/editor/extensions/changeRail.test.ts
```

Run store/session tests when persistence, recovery, or user-edit rebasing is in
scope:

```bash
cd apps/desktop
npm run test -- src/features/ai/store/chatStore.test.ts src/features/ai/store/editedFilesBufferModel.test.ts
```

Run broader validation before release or when native restore/hash behavior is in
scope:

```bash
cargo test -p neverwrite-diff
cargo test -p neverwrite-native-backend
cd apps/desktop
npm run lint
npm run build
npm run electron:sidecar:build
npm run electron:vault-editor:smoke
npm run electron:ai-runtime:smoke
```

Refer to [Testing and Validation](./testing.md) for full CI parity commands.

## Release Sign-off

- [ ] All checked manual scenarios pass on a disposable vault.
- [ ] No scenario overwrites external user edits without conflict handling.
- [ ] Accept/Keep never rewrites disk unnecessarily.
- [ ] Reject and partial reject always go through conflict-aware native restore.
- [ ] Undo last reject is available only for safe snapshots and never resurrects
      stale state over newer disk content.
- [ ] Review tab, Edits panel, inline controls, and change rail agree on the
      same pending files and hunks.
- [ ] Multi-session and multi-window flows do not leak review state across
      sessions, vaults, or tracked versions.
- [ ] Reload/restart recovery preserves pending review state or degrades with a
      clear, safe user path.
- [ ] Non-text and irreversible diffs are visibly limited and cannot be
      partially resolved as text.
- [ ] Relevant automated tests and smoke commands have passed, or skipped
      commands are documented with a reason.

Last updated: May 11, 2026.
