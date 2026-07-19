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

## Sessions, Sidebar Entries, And Workspace Views

For ACP chats, the Agents sidebar owns the durable live-session entry. Editor
tabs and panes are views into that session, so closing a chat tab does not stop
or delete the agent. The session remains available in the sidebar and can be
reopened in the focused chat tab, explicitly opened in a new tab, or placed in
another pane.

With history-based tab opening enabled, a physical chat tab can hold a local
Back/Forward history of sessions visited through that view. This workspace
navigation history is persisted with the editor session, but it is distinct
from the transcript stored under `.neverwrite/sessions/`.

Deleting a conversation is different from closing a view. Explicit deletion
removes physical tabs that display the session and prunes it from other chat-tab
histories. Sidebar pins and folder assignments are local UI metadata rather
than provider transcript data; they follow session ID migrations so a restored
or newly durable session keeps its organization.

Claude Code launched in an integrated terminal is not an ACP chat and does not
use this durable sidebar ownership model. Its sidebar row is a non-persisted
projection of the live terminal. Selecting the row focuses that terminal;
closing the terminal ends the process and removes the row. It has no chat-tab
Back/Forward history, saved chat view, or `Open in New Tab` action. Terminal tabs
can be restored as workspace tabs, but their current metadata does not relaunch
Claude Code or recreate the agent-sidebar projection after an app restart.

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
- Removing a vault from Recents clears local registration, drafts, and
  device-local history; it never deletes history or managed blobs inside the
  vault.
- If a recovered chat is missing, confirm you reopened the same vault and that the retention window did not prune the conversation.
- Pasted screenshot drafts and managed blobs are plaintext local image files;
  review them before sharing app data or a vault archive.

Last updated: July 19, 2026.
