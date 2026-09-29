# AI Session History And Crash Recovery

NeverWrite stores AI chat history locally by default. Each vault has one
backend-owned canonical scope: `device` or `vault`. The renderer asks the
backend for that scope; it never chooses a history root or derives one from a
filesystem path.

New vaults use device-local storage. Existing vaults that already contain
NeverWrite history are adopted as vault storage. In Settings, enable
**Store AI chats inside this vault** to move all history and
NeverWrite-managed pasted attachments into the vault. Moving back to device
storage uses the same verified transaction.

## Disk Layout

Device-local sessions are stored under:

```text
<app-data>/ai-history/v1/vaults/<vault-key>/history/session-<sha256(session_id)>/
```

Vault-scoped sessions are stored under:

```text
<vault>/.neverwrite/sessions/session-<sha256(session_id)>/
```

Each modern session directory contains:

- `session-meta.json`: session metadata such as runtime, model, mode, title, timestamps, parent session, and message count.
- `index.json`: transcript offsets, lengths, and message hashes used for windowed transcript loading.
- `transcript.jsonl`: newline-delimited JSON transcript entries.
- `conversation-bindings.json`: optional versioned canonical conversation metadata for ACP provider bindings, continuation strategies, next-turn selection, and transcript cursors.

The `.neverwrite` directory is NeverWrite's internal hidden-state directory.
It is hidden by dotfile convention on macOS and Linux, and may be filtered by
file managers or search tools. Show hidden files in your file manager, or
inspect it from a terminal, if you need to audit the stored history directly.

NeverWrite may also have `.neverwrite-cache/` in the vault for derived cache
data. Vault-scoped chat recovery uses `.neverwrite/sessions/`; device-scoped
chat recovery uses the app-data namespace shown above.

## Screenshot Attachment Lifecycle

Pasted screenshots have a separate draft and durable lifecycle. Before send,
the original image is stored as a plaintext local draft under:

```text
<app-data>/ai-history/v1/vaults/<sha256(canonical-vault-path)>/drafts/<draft-id>/
```

The hash identifies the vault namespace without placing the vault path in the
directory name; it does not encrypt the image. Drafts released by the composer,
queue, or queue editor are deleted immediately when possible. Crash-orphaned
drafts are eligible for best-effort startup cleanup after seven days.

Sending atomically acquires the composer snapshot, promotes each draft, and only
then inserts and persists the optimistic user message. Promotion writes a
managed blob in the active canonical scope:

```text
<app-data>/ai-history/v1/vaults/<vault-key>/assets/chat/.neverwrite-managed/v1/blobs/<managed-attachment-id>/
# or, when vault storage is active:
<vault>/assets/chat/.neverwrite-managed/v1/blobs/<managed-attachment-id>/
```

History stores the opaque managed attachment ID and descriptive metadata, not a
physical draft or blob path. Saving history marks referenced managed blobs as
committed. Uncommitted promotions receive a seven-day grace period so a crash
between promotion and history persistence does not leave an immediately broken
reference. Deleting or pruning histories removes a managed blob only after its
last retained history reference is gone.

## Sessions, Sidebar Entries, And The Chat Pane

ACP conversations are listed in the Agents sidebar and displayed in a dedicated
chat pane alongside the editor workspace. Selecting a conversation reveals it
in that pane. Hiding the pane or selecting another conversation does not stop
or delete the underlying session; it remains available from the sidebar.

The pane has `conversation`, `history`, and `empty` views. Chat History opens in
the same pane, with a Back action that returns to the previous conversation when
available. Editor tab-opening preferences and per-tab Back/Forward history do
not control chat selection.

Chat navigation is persisted separately from editor tabs and saved transcripts.
The historical `neverwrite.chat.tabs:<vault-path>` key and `chatTabsStore.ts`
name are retained. Their current payload includes the pane view, history filter,
and conversation references in tab-shaped metadata. Older editor chat tabs and
their navigation entries are migrated into those references before the editor
tab projections are removed. See [Editor Architecture](editor-architecture.md#chat-pane-and-session-ownership)
and [Settings Scope](settings-scope.md) for the UI and compatibility boundaries.

Explicit conversation deletion closes its live runtime when applicable, removes
its saved history and navigation references, and clears a matching pane selection
or return-from-history target. Sidebar pins and folder assignments are local UI
metadata rather than provider transcript data; they follow session ID migrations
so a restored or newly durable session keeps its organization.

Claude Code launched in an integrated terminal has no ACP chat session. Its
sidebar row is a non-persisted projection of the live terminal. Selecting the row
focuses that terminal rather than opening a conversation in the chat pane;
closing the terminal ends the process and removes the row. Terminal tabs can be
restored as workspace tabs, but their current metadata does not relaunch Claude
Code or recreate the agent-sidebar projection after an app restart.

## Archiving Conversations

`Archive` and `Unarchive` are available for root ACP conversations in the
Agents sidebar and Chat History. A root's subagents inherit its archive state;
they are not archived independently. Claude Code terminal entries do not offer
these actions.

Archiving preserves the conversation, saved transcript, pending review state
in memory, and any active runtime process. It removes the root's pin and moves
the group into the sidebar's Archived section. If the pane currently displays
the root or one of its subagents, archiving clears that selection, hides the
chat pane, and returns focus to the editor. It does not cancel a running turn.
The temporary archive notice offers Undo; it restores the prior conversation
selection only if navigation has not changed in the meantime. Unarchiving does
not restore the removed pin.

Chat History offers `All`, `Active`, and `Archived` filters. `Unarchive and
continue` removes the archive marker and opens the selected conversation in the
chat pane. History retention applies to both active and archived conversations;
archiving does not exempt a transcript from pruning.

Archive metadata is per-vault renderer state under
`neverwrite.chats.archived:<vault-path>`, stored as version 1 entries mapping
root conversation identities to `{ archivedAt }` timestamps. It is separate
from backend history storage and follows conversation ID migrations. See
[`chatArchiving.ts`](../apps/desktop/src/features/ai/chatArchiving.ts),
[`archivedChatsStore.ts`](../apps/desktop/src/features/ai/store/archivedChatsStore.ts),
and [Settings Scope](settings-scope.md).

## Export To A Markdown Note

`Export to note` in Chat History loads the full saved transcript, creates a
Markdown note in the current vault, saves it, and opens it in the editor. The
name starts with `Exported chat - <title>`; invalid filename characters are
sanitized and numeric suffixes avoid collisions with existing notes.

The export includes the conversation title, export time, runtime, session and
history IDs, status, attached-context descriptions, and messages with role,
kind, timestamps, and content. Attachment entries describe their references;
this operation does not copy attachment bytes into the note.

The resulting file is an ordinary editable vault note and a snapshot of the
conversation at export time. Later chat messages do not update it, and deleting
or pruning the chat history does not delete the exported note. Exporting does
not fork or reconnect the runtime and does not preserve pending review or
Reject undo state. See
[`chatExport.ts`](../apps/desktop/src/features/ai/chatExport.ts).

## Canonical Conversation Rollout And Rollback

Canonical ACP conversations are a normal data-model upgrade, not a Beta setting or runtime feature flag. A conversation keeps one durable transcript while each ACP provider has an independent binding; switching A -> B -> A can resume or load the previous binding when the provider supports it, and otherwise starts an isolated runtime session with a bounded transcript handoff.

The compatibility window targets the last public release immediately before canonical conversations and the first releases that write `conversation-bindings.json`. Opening legacy history is lazy and does not create the sidecar until the upgraded app writes the conversation. The legacy projection in `session-meta.json` and the transcript remain readable by the previous release.

For a rollback, close NeverWrite, install the immediately preceding public release, and reopen the same vault. Do not delete or edit the canonical sidecar. The older release ignores it and can continue writing the legacy transcript; a later re-upgrade reconciles those writes, preserves provider bindings, and invalidates stale context cursors so the next turn uses a safe transcript handoff.

Rollback cannot reconnect a provider or model that the older release does not contain. A missing provider remains transcript-only, a custom ACP launch fingerprint change requires confirmation before continuation, and a `new_session_only` binding cannot regain native resume semantics. Forks receive independent canonical identities and do not reuse custom runtime session handles.

Canonical routing diagnostics record only strategies, provider IDs, boolean outcomes, counts, runtime states, and bounded error codes. They never include prompt or transcript content, vault paths, attachment names, runtime command lines, environment values, or raw error messages.

## Recovery Flow

If a scope move is interrupted or storage cannot be safely inspected, NeverWrite
blocks normal history operations and shows recovery controls in Chat History.
The control can reveal the safe diagnostic roots and retry after manual repair;
it never silently selects a winner between conflicting roots. A partial
destination is never published as canonical and the source remains until the
destination has been validated and withdrawn successfully.

Device-local history is keyed by the canonical vault path. Renaming or moving a
vault therefore requires the visible import/recovery flow; NeverWrite does not
silently assume that two paths identify the same vault. Two devices that sync a
vault also keep separate local scope state. Filesystem changes made by another
device are treated as external changes and are checked during initialization,
recovery, and an explicit scope change.

The vault root's filesystem identity is a replacement signal, not a permanent logical identity. Cloud sync, File Provider rematerialization, restore operations, and storage reconnects can replace the root directory while preserving its canonical path and contents. NeverWrite blocks AI history when that identity changes and requires `Restore access to AI chats`; the confirmation updates only the canonical state identity after validating the saved scope, without moving or deleting histories.

A newly created folder at the previous path never inherits device-local AI history automatically. Confirm the recovery action only when the current folder represents the same logical vault. If the identity changed while a storage transaction was pending, automatic recovery remains paused and the diagnostic must be reviewed before any manual repair.

After a crash, freeze, renderer reload, or AI runtime disconnect:

1. Reopen the same vault.
2. Open `Chat History`.
3. Select the saved conversation.
4. Click `Restore`.
5. Wait for `Reconnecting saved chat...` if the runtime needs to reconnect.
6. Send the next message normally.

When a provider supports native session loading, NeverWrite reconnects the
runtime session directly. When native loading is unavailable or unsafe,
NeverWrite creates a fresh runtime session and sends the saved transcript as
context with the next prompt.

### Review State After Reload Or Restart

Transcript recovery does not recover the pending edits buffer. `ActionLog`,
its pending tracked files, and `lastRejectUndo` snapshots are in-memory session
state and are excluded from saved history. After a renderer reload or app
restart, restoring a conversation can show its saved messages and diff previews,
but does not recreate the former pending Keep/Reject state or Undo Last Reject
buffer. File changes already written to the vault remain on disk.

A runtime disconnect while the renderer remains alive is a different boundary:
review state still held in memory is distinct from the saved transcript used
for reconnection. See [AI Change Control](ai-change-control.md#persistence-and-recovery)
for normalization and undo behavior within a live session.

## Transaction Diagnostics

Scope moves emit lifecycle diagnostics with an opaque vault key and operation
ID. The recorded phases are `inspect`, `prepare`, `validate`, `publish`,
`withdraw`, `commit`, and `housekeeping`. Diagnostics never include vault
paths, transcript content, prompts, attachment names, or physical attachment
paths. A failed operation reports the phase that was active when it stopped,
which makes an interrupted move diagnosable without disclosing chat data.

Release validation exercises these phases with in-process failpoints and a
real sidecar subprocess that is terminated across the durable transaction
boundaries. Windows runs the same transaction suite in CI.

If the app detects that an AI runtime lost its live connection, the chat can show:

```text
The AI runtime lost its connection. Reconnecting with saved context...
```

If reconnecting fails, the chat shows:

```text
Could not reconnect this chat. Start a new session with saved transcript context?
```

In that case, restore or fork the saved conversation from `Chat History`, then
send a new message so NeverWrite can continue with the stored transcript.

## Retention And Privacy Notes

- Session history follows the chat history retention setting in `Chat History`.
- Device-local history and drafts live only in this app-data installation. Vault
  history and managed blobs are copied when the vault itself is synchronized or
  backed up.
- `transcript.jsonl` is stored as local plaintext JSONL while retained.
- Deleting a conversation from `Chat History` deletes its saved history and
  only managed blobs that no retained history references.
- Removing a vault from Recents clears local registration, drafts, and device-local history; it never deletes history or managed blobs inside the vault. The stored canonical path still identifies this device-local data when the original vault folder no longer exists.
- If a recovered chat is missing, confirm you reopened the same vault and that the retention window did not prune the conversation.
- Pasted screenshot drafts and managed blobs are plaintext local image files;
  review them before sharing app data or a vault archive.

Last updated: September 29, 2026.
