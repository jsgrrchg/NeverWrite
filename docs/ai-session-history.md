# AI Session History And Crash Recovery

NeverWrite stores AI chat history inside the currently open vault. This keeps
conversation recovery local-first and lets the app reconnect or reconstruct a
saved chat after a renderer reload, runtime crash, or full app restart.

## Disk Layout

Session history is stored under:

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
data. Chat recovery uses `.neverwrite/sessions/`.

## Recovery Flow

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

- Session history is local to the vault and follows the chat history retention setting in `Chat History`.
- `transcript.jsonl` is stored as local plaintext JSONL while retained.
- Deleting a conversation from `Chat History` deletes its saved history from `.neverwrite/sessions/`.
- If a recovered chat is missing, confirm you reopened the same vault and that the retention window did not prune the conversation.
