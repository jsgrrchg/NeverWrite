# Editor Architecture

This document is a maintainer guide for changing NeverWrite's editor without
breaking the power-user experience. It focuses on the desktop editor stack:
CodeMirror 6, live preview, Mermaid rendering, wikilinks,
frontmatter/properties, autosave/dirty state, inline review/merge view, and
workspace tab boundaries.

For test-command conventions, also see [Testing and Validation](./testing.md).

## Overview

The editor is pane-centric. The Zustand workspace store owns panes, tabs, active
tab IDs, history, dirty flags, reload versions, and external-conflict markers in
[`apps/desktop/src/app/store/editorWorkspace.ts`](../apps/desktop/src/app/store/editorWorkspace.ts).
[`editorStore.ts`](../apps/desktop/src/app/store/editorStore.ts) wraps that
workspace slice and adds cross-editor selection/reveal state.

The main renderer boundary is
[`EditorPaneContent.tsx`](../apps/desktop/src/features/editor/EditorPaneContent.tsx):

- `note` tabs render through [`Editor.tsx`](../apps/desktop/src/features/editor/Editor.tsx), the Markdown/notes CodeMirror editor.
- `file` tabs render through [`FileTabView.tsx`](../apps/desktop/src/features/editor/FileTabView.tsx), then branch by `FileTab.viewer`.
- `pdf` tabs render through [`PdfTabView.tsx`](../apps/desktop/src/features/pdf/PdfTabView.tsx), not CodeMirror.
- AI review/chat, map, graph, and terminal tabs have separate hosts.

Notes and text-like files are intentionally different editor surfaces. Do not
assume behavior added to `Editor.tsx` automatically applies to arbitrary files,
CSV files, Mermaid diagram files, PDFs, or images.

## Tab Model

Tab data types and viewer inference live in
[`editorTabs.ts`](../apps/desktop/src/app/store/editorTabs.ts). The important
resource-backed tab kinds are:

- `NoteTab`: Markdown note content keyed by `noteId`.
- `FileTab`: vault file content keyed by `relativePath`, with `viewer` set to
  `text`, `csv`, `mermaid`, or `image`.
- `PdfTab`: PDF state, including page, zoom, view mode, and scroll position.

Only `note`, `pdf`, `file`, and `map` participate in the resource-backed history
registry in
[`editorTabRegistry.ts`](../apps/desktop/src/app/store/editorTabRegistry.ts).
AI review and graph tabs remain outside that model. AI chat tabs implement a
separate session-navigation history directly on `ChatTab`; they do not use the
resource registry.

### AI Chat Views And Session Ownership

The Agents sidebar is the durable owner of live ACP chat sessions. An `ai-chat`
tab is a workspace view of an ACP session, not the session itself. Closing a chat
tab must therefore close only that physical view; it must not stop, delete, or
otherwise change the lifetime of the underlying agent. Explicit session deletion
is the operation that removes matching physical tabs and prunes that session
from the history of other chat tabs.

When the configured tab-open behavior is `history`, opening a chat from the
sidebar reuses the focused chat tab and appends a `ChatHistoryEntry`. Back and
Forward navigate those entries in place. `Open in New Tab`, pane-targeted opens,
background opens, and drag/drop placement can create or move a separate physical
view instead. Each chat history entry stores the live session ID, optional saved
history session ID, and title; the workspace session serializer persists the
history and current index.

Session IDs can change when a temporary or restored session becomes durable.
That migration must update every workspace history entry as well as other
session-keyed sidebar metadata such as pins and folder membership. Likewise,
deleting a session must clean all panes without leaving stale Back/Forward
entries or empty panes behind.

Claude Code terminal agents are an intentional exception to this ownership
model. They have no ACP backend session. A live terminal is their durable owner,
and [`claudeTerminalAgentSession.ts`](../apps/desktop/src/features/ai/claudeTerminalAgentSession.ts)
projects a lightweight, non-persisted pseudo-session into the Agents sidebar.
Opening that entry focuses its existing terminal tab; it cannot participate in
chat-tab history or `Open in New Tab`. Closing the terminal tab ends the PTY and
removes the sidebar entry, while the sidebar's explicit `Close Terminal` action
confirms before performing the same lifecycle operation.

Pins, renames, and folder assignments can decorate a live Claude Code terminal
entry, but they do not make the pseudo-session durable. Its pin and folder
assignment are reconciled away when the terminal ends. A restored `TerminalTab`
also does not encode enough information to relaunch Claude Code or reconstruct
the pseudo-session automatically; terminal-agent restoration would require a
separate persisted terminal role and launch contract.

`FileTabView` applies the file viewer boundary:

- `viewer === "image"` uses a custom image viewer. Image tabs do not need text
  content and use vault preview URLs.
- `viewer === "csv"` uses [`CsvFileTabView.tsx`](../apps/desktop/src/features/editor/CsvFileTabView.tsx).
- `viewer === "mermaid"` uses [`FileTextTabView.tsx`](../apps/desktop/src/features/editor/FileTextTabView.tsx)
  with a Source/Preview switch and [`MermaidFilePreview.tsx`](../apps/desktop/src/features/editor/MermaidFilePreview.tsx)
  for rendered diagrams.
- other text-like file viewers use [`FileTextTabView.tsx`](../apps/desktop/src/features/editor/FileTextTabView.tsx).

`fileViewerNeedsTextContent(viewer)` returns `viewer !== "image"`, so adding a
new viewer mode must define whether it participates in text loading, autosave,
dirty state, reload handling, and review sync.

## CodeMirror Extensions

Shared CodeMirror styling and compartments live in
[`editorExtensions.ts`](../apps/desktop/src/features/editor/editorExtensions.ts).
The key invariant is that extensions that change at runtime should be installed
through a `Compartment` and reconfigured instead of rebuilding the editor view:

- `syntaxCompartment`: switches syntax highlighting for theme changes.
- `livePreviewCompartment`: toggles live preview/source-mode presentation.
- `alignmentCompartment`, `wrappingCompartment`, and `tabSizeCompartment`:
  editor layout and editing behavior.
- spellcheck and grammar compartments: app-owned language tooling.
- `mergeViewCompartment`: inline review/merge view overlay.

`Editor.tsx` creates the note editor state with Markdown commands, search,
wikilink suggester key handling, live preview, wikilinks, URL links,
paste/drop image handling, selection tracking, and user-edit notification.
`FileTextTabView.tsx` creates a smaller text/code editor with syntax loading,
search, context menu actions, selection-to-chat support, and source-mode merge
view sync.

When applying external content to a live CodeMirror document, preserve user
state. Existing code replaces the whole document while clamping selection to the
new document length, uses scroll snapshots where possible, and annotates
agent-origin changes with `changeAuthorAnnotation.of("agent")`.

## Live Preview

Live preview is assembled by
[`extensions/livePreview.ts`](../apps/desktop/src/features/editor/extensions/livePreview.ts)
and enabled through `getLivePreviewExtension(...)`. When live preview is off,
the extension sets `data-live-preview="false"` and restores line numbers.

The live preview system is split by concern:

- [`livePreviewInline.ts`](../apps/desktop/src/features/editor/extensions/livePreviewInline.ts)
  builds inline and line decorations for Markdown presentation.
- [`livePreviewBlocks.ts`](../apps/desktop/src/features/editor/extensions/livePreviewBlocks.ts)
  handles heavier block widgets such as code blocks, images, tables, math,
  Mermaid diagrams, embeds, and note previews.
- [`livePreviewHelpers.ts`](../apps/desktop/src/features/editor/extensions/livePreviewHelpers.ts)
  centralizes cursor-awareness and Markdown parsing helpers.
- [`livePreviewTheme.ts`](../apps/desktop/src/features/editor/extensions/livePreviewTheme.ts)
  owns the visual presentation.

Performance matters here. Inline live preview only rebuilds the viewport; simple
edits that do not contain Markdown-significant characters remap existing
decorations instead of rebuilding. The plugin records perf measures such as
`editor.livePreviewInline.build.docChanged`. Preserve these fast paths when
changing parsing or decoration rules.

Cursor-awareness is part of the editing contract. Syntax marks and collapsed
ranges should reveal when the selection touches the relevant range or line.
Avoid hiding source syntax under the cursor, inside active selections, or while
the user is editing an ambiguous Markdown structure.

Leading frontmatter and the leading H1 are collapsed by
`createLeadingContentCollapseField()` in live preview, but only when the
selection is not on those lines. Source mode keeps raw Markdown visible.

Mermaid rendering is shared between Markdown fences and standalone Mermaid
files through [`mermaidRenderer.ts`](../apps/desktop/src/features/editor/mermaid/mermaidRenderer.ts).
Keep asynchronous render calls stale-safe so older renders cannot replace newer
diagram source after quick edits.

## Wikilinks

There are three distinct wikilink responsibilities:

- Rendering/click behavior:
  [`extensions/wikilinks.ts`](../apps/desktop/src/features/editor/extensions/wikilinks.ts).
- Resolution/cache/navigation helpers:
  [`wikilinkResolution.ts`](../apps/desktop/src/features/editor/wikilinkResolution.ts)
  and [`wikilinkNavigation.ts`](../apps/desktop/src/features/editor/wikilinkNavigation.ts).
- Live-preview inline/table/embed treatment:
  `livePreview*` extensions.

The CodeMirror wikilink extension decorates only visible ranges. It batches
resolution through `resolveWikilinksBatch`, caches decoration marks, and has a
dense-mode path: nearby targets resolve immediately while the rest are resolved
in idle batches. This prevents large notes with many wikilinks from blocking
typing or scrolling.

Resolution is vault-aware. `wikilinkResolution.ts` clears caches when vault path
or resolver revision changes, resolves note targets through the backend
`resolve_wikilinks_batch`, and can fall back to text-like vault file matches.
Navigation opens existing notes/files when possible and creates a note for a
broken note link.

Links emitted in AI chat are resolved separately by
[`chatNoteNavigation.ts`](../apps/desktop/src/features/ai/chatNoteNavigation.ts).
Chat output may reference a note by ID, relative path, title, or an extensionless
basename, so this resolver normalizes Markdown extensions, path separators,
case, accents, spaces, underscores, and hyphens. It must never choose an
arbitrary result: basename and normalized matches open only when they identify a
single note across the vault.

Pitfall: active note context matters. `Editor.tsx` passes
`activeTabRef.current?.noteId` into the wikilink extension; helpers such as
`getNoteLinkTarget()` also derive relative note paths from the focused note tab.
Be careful with multi-pane changes that alter focus or active-tab resolution.

## Frontmatter And Properties

The properties UI is
[`FrontmatterPanel.tsx`](../apps/desktop/src/features/editor/FrontmatterPanel.tsx),
rendered inside `MarkdownNoteHeader` from `Editor.tsx`. It parses and serializes
a simple frontmatter subset:

- scalar `key: value`
- list-style values with indented `- item` rows
- property type hints for text, URL, date, list, and tags

`Editor.tsx` keeps a `frontmatterByTabId` ref keyed by note ID. In current
source-mode architecture, `stripFrontmatter()` records the raw frontmatter but
returns the full content unchanged. This is deliberate: the CodeMirror document
must stay aligned with the persisted note text and tracked-file text so inline
review/merge view can compare the same positions.

`applyFrontmatterChange()` updates or removes the raw frontmatter block at the
start of the CodeMirror document, derives the displayed title, updates note
metadata, updates the tab content, and schedules autosave. Do not make the
properties panel edit a separate shadow document unless merge/review projection,
dirty tracking, and save baselines are updated at the same time.

Title derivation and leading-content collapse helpers live in
[`noteTitleHelpers.ts`](../apps/desktop/src/features/editor/noteTitleHelpers.ts).

## Autosave And Dirty State

Dirty state is centralized as `dirtyTabIds` in the editor workspace store.
`setTabDirty(tabId, dirty)` only updates the set; each editor surface decides
when content differs from its saved baseline.

Notes use the autosave path inside `Editor.tsx`:

- User edits update the active tab after a short debounce and call
  `setTabDirty(tab.id, isTabDirty(tab.noteId, content))`.
- Saves call the backend `save_note` with an operation ID.
- Saved baselines live in refs such as `lastSavedContentByTabId`,
  `lastAckRevisionByTabId`, `pendingLocalOpIdByTabId`, and
  `pendingLocalSerializedContentByTabId`.
- Incoming reloads use `_noteReloadVersions`, `_pendingForceReloads`, and
  `_noteReloadMetadata` to distinguish local save acknowledgements, stale
  revisions, safe external reloads, and true conflicts.

Text-like files and CSV share
[`useEditableFileResource.ts`](../apps/desktop/src/features/editor/useEditableFileResource.ts):

- It schedules `save_vault_file` with `editorAutosaveDelayMs`.
- It tracks saved content, pending local op IDs, acknowledged revisions, and
  per-path request IDs.
- It prunes caches to the currently open workspace tabs and clears file-path
  caches when the vault path changes.
- It exposes `reloadFileFromDisk()`, `keepLocalFileVersion()`, and
  `flushCurrentSave()`.

External conflicts are surfaced differently for notes and files but follow the
same safety rule: do not overwrite local unsaved content automatically. The UI
offers "Reload from Disk" and "Keep Local" when an external change arrives while
the editor has unsaved local changes.

On unmount or tab switch, flush pending saves. `FileTextTabView` explicitly
calls `flushCurrentSave()` during cleanup; note tab closing routes through
`closeActiveTabWithSave()`.

## Merge View And Inline Review

Inline review is built on CodeMirror's `@codemirror/merge` package plus
NeverWrite review projection metadata.

The main pieces are:

- [`editorReviewGate.ts`](../apps/desktop/src/features/editor/editorReviewGate.ts):
  enables inline review only when the per-vault setting is enabled and the
  editor mode is `"source"`.
- [`editorReviewSync.ts`](../apps/desktop/src/features/editor/editorReviewSync.ts):
  safely force-reloads an open tracked target when the editor is still at the
  tracked diff base or is transiently empty.
- [`mergeViewSync.ts`](../apps/desktop/src/features/editor/mergeViewSync.ts):
  resolves the tracked file, verifies the active editor target, waits until the
  editor document matches `trackedFile.currentText`, builds review projection,
  and reconfigures `mergeViewCompartment`.
- [`extensions/mergeViewDiff.ts`](../apps/desktop/src/features/editor/extensions/mergeViewDiff.ts):
  creates the unified merge view, runtime facets, control widgets, change rail,
  and diff options.
- [`extensions/reviewProjectionControls.ts`](../apps/desktop/src/features/editor/extensions/reviewProjectionControls.ts):
  places accept/reject controls for review chunks/hunks.
- [`extensions/changeRail.ts`](../apps/desktop/src/features/editor/extensions/changeRail.ts):
  renders scrollbar-adjacent change markers from review hunk geometry.

The key invariant is text alignment. Inline merge view only appears when the
CodeMirror document is normalized-equal to the tracked current text. If the
editor is stale, `mergeViewSync` hides the merge extension, marks a transition,
and retries a few times. This avoids applying review controls to the wrong
positions.

Preview mode intentionally disables inline merge view. `shouldEnableInlineReviewMergeView(mode)`
returns true only for `"source"`, because live preview decorations and collapsed
widgets change visual positions and source-token visibility.

Accept/reject actions are version-checked. Control widgets carry review chunk
and hunk IDs; stale decisions set merge transitioning and schedule resync rather
than resolving against old tracked-file state.

## Multi-Pane And Detached Windows

Workspace panes are first-class owners of tab order, active tab, pinned tabs,
activation history, navigation history, and tab display mode. Most editor code
should use pane-aware selectors such as `selectEditorPaneState`,
`selectEditorPaneActiveTab`, `selectEditorWorkspaceTabs`, and
`selectFocusedEditorTab`.

Each pane can render tabs in the classic `"default"` mode or in `"stacked"`
mode, where open tabs are shown as side-by-side columns for scanning several
documents within one pane. The mode is stored as `tabDisplayMode` on
`EditorPaneState`, normalized through `normalizeTabDisplayMode()`, toggled by
`setPaneTabDisplayMode()` / `togglePaneTabDisplayMode()`, and rendered through
`StackedPaneContent` when active. Treat it as pane-owned workspace state: it
must persist with session restore, detach payloads, and cross-window hydration,
but it should not become a property of individual tabs.

`EditorPaneContent` keeps the note CodeMirror editor mounted behind non-editor
tabs when an editable note exists in the pane. This preserves note-local scroll,
selection, and undo state while the user visits AI review/chat tabs.

Detached note windows are bootstrapped through
[`detachedWindows.ts`](../apps/desktop/src/app/detachedWindows.ts) and
[`detachedWindowBootstrap.ts`](../apps/desktop/src/app/detachedWindowBootstrap.ts).
Detach payloads include tabs, active tab ID, vault path, pinned tab IDs, and
related AI sessions when needed. Any editor state added to tabs must be safe to
serialize for transfer, persistence, and cross-window hydration.

Vault path handling is a correctness boundary. Caches for live notes, live
files, wikilink resolution, reload baselines, and detached windows must not leak
across vaults. Prefer vault-relative identifiers for files inside the vault and
absolute paths only when a runtime API or preview URL requires them.

## Validation Checklist

For documentation-only changes, CI does not require a code check. For editor
code changes, start with the narrowest relevant tests and then add broader
checks based on risk.

Focused editor tests:

```bash
cd apps/desktop
npm test -- src/features/editor/Editor.test.tsx src/features/editor/FileTabView.test.tsx src/features/editor/CsvFileTabView.test.tsx
```

Live preview and wikilinks:

```bash
cd apps/desktop
npm test -- src/features/editor/extensions/livePreview.test.ts src/features/editor/extensions/livePreviewInline.test.ts src/features/editor/extensions/livePreviewBlocks.test.ts src/features/editor/extensions/wikilinks.test.ts src/features/editor/extensions/wikilinkSuggester.test.ts
```

Merge view and inline review:

```bash
cd apps/desktop
npm test -- src/features/editor/mergeViewSync.test.ts src/features/editor/mergeViewConfig.test.ts src/features/editor/editorReviewGate.test.ts src/features/editor/editorReviewSync.test.ts src/features/editor/extensions/mergeViewDiff.test.ts src/features/editor/extensions/changeRail.test.ts src/features/ai/components/reviewMultiSessionIntegration.test.tsx src/features/ai/components/AIReviewView.test.tsx
```

Workspace, tabs, panes, and persistence:

```bash
cd apps/desktop
npm test -- src/app/store/editorStore.test.ts src/app/store/editorSession.test.ts src/features/editor/MultiPaneWorkspace.test.tsx src/features/editor/EditorPaneContent.test.tsx src/features/editor/editorTargetResolver.test.ts src/features/editor/workspaceTabDropPreview.test.ts
```

Before handoff for non-trivial editor code changes:

```bash
cd apps/desktop
npm run lint
npm test
npm run build
```

For vault opening, file watching, save/reload, wikilinks, maps, or sidecar
boundaries, follow the smoke-test guidance in [Testing and Validation](./testing.md):

```bash
cargo build -p neverwrite-native-backend
cd apps/desktop
npm run electron:vault-editor:smoke
```

## Pitfalls

- Do not rebuild `EditorView` for normal setting changes. Reconfigure
  compartments so selection, undo history, scroll position, and DOM focus
  survive.
- Do not let live preview hide Markdown source that the cursor or selection is
  actively touching.
- Do not run expensive Markdown, wikilink, or geometry work across the whole
  document on every keystroke. Prefer visible ranges, cached decorations, idle
  batches, and perf instrumentation.
- Do not apply external reloads over unsaved local edits. Preserve the conflict
  flow unless a forced reload is explicit.
- Do not desynchronize frontmatter/properties from the CodeMirror document.
  Inline review expects source text positions to match persisted/tracked text.
- Do not show inline merge controls in live preview mode without redesigning
  projection geometry and source-token visibility.
- Do not treat `path`, `relativePath`, and `noteId` as interchangeable. Review
  sync and wikilink resolution intentionally pass candidate path sets.
- Do not forget multi-pane focus. Global active-tab selectors can be wrong when
  a secondary pane or detached window owns the interaction.
- Do not tie an ACP session's lifetime to a workspace tab. Closing a chat tab
  closes a view; explicit session deletion owns cross-pane and history cleanup.
  Claude Code terminal agents are the explicit exception because their PTY/tab
  is the owned session, not a view of an ACP session.
- Do not add a file viewer without deciding its text-content, autosave, dirty,
  reload, history, and session-persistence behavior.

Last updated: July 11, 2026.
