# Configurable Custom ACP Runtimes

Custom ACP runtimes let you connect a local ACP-compatible executable that NeverWrite does not bundle or authenticate itself. They are intended for adapters, gateways, and local agents that already know how to authenticate in their own environment.

Custom runtimes appear in **Settings → AI Providers → Custom ACP runtimes**. They participate in the normal chat, history, ActionLog, Edits, Review, inline-review, permission, user-input, slash-command, token-usage, and reconnect flows only when the ACP runtime announces the corresponding protocol capability.

## Add and verify a runtime

Choose **Add runtime**, then provide a runtime name, command, arguments, and optional environment entries. Arguments are one per line. Environment entries use one `NAME=value` pair per line. Select **Verify executable** before creating a chat to check that NeverWrite can resolve and execute the configured command; verification does not start an ACP session or authenticate the adapter.

For example, a locally installed adapter might be represented as:

```text
Runtime name: Local review adapter
Command: /Users/me/bin/review-acp
Arguments:
--stdio
--workspace-aware
Environment:
REVIEW_PROFILE=careful
```

The command is an executable path or a command resolvable through the controlled runtime `PATH`. NeverWrite invokes it directly with an argument vector. It does not run a shell, interpolate shell syntax, or evaluate arguments such as `;`, `&&`, `$()`, or redirections.

## Authentication and environment boundary

Authentication is managed by the custom runtime. NeverWrite does not show built-in sign-in controls for it, does not persist custom runtime secrets, and does not inject Codex, Claude, Grok, Kilo, or OpenCode credentials into its process.

Every custom runtime receives a fresh, isolated environment. NeverWrite supplies a controlled `PATH`, a small platform-safe baseline required to launch a local process, and only the non-secret environment entries saved in that runtime definition. It deliberately excludes sidecar variables, provider API keys, gateway headers, and unrelated inherited environment variables.

Do not put tokens, API keys, passwords, or secret headers in the custom environment form. Secret-looking names are rejected. Configure credentials using the adapter's own secure mechanism, such as its keychain integration, its local login flow, or a credential helper it owns.

Editing or deleting a definition does not mutate the launch snapshot of a session that is already running. That session continues with the exact command, arguments, environment, and fingerprint it started with until it is closed.

## Capability-driven behavior

NeverWrite starts a custom runtime with ACP initialization and uses only the behavior the runtime announces. The runtime may expose config options, modes, slash commands, token usage, permissions, user input, images, and tool diffs. If it does not announce a feature, NeverWrite does not invent a provider-specific substitute.

Images are sent as native ACP image blocks only after the initialized runtime advertises image support. Custom runtimes use conservative image count, size, and MIME-type limits. Otherwise image attachments are represented as textual file context rather than binary image payloads.

For continuation, NeverWrite records the strategy returned by the initial handshake:

| Runtime capability | Reconnect behavior |
| --- | --- |
| `session/resume` | Reopen the prior ACP session with `session/resume`. |
| `session/load` | Reopen the prior ACP session with `session/load`. |
| Neither | `new-session-only`; the saved transcript remains available, but NeverWrite does not claim the ACP session can continue. |

When native continuation is unavailable, start a new chat or use the transcript-only history view. NeverWrite never sends a `resume` or `load` request that the runtime did not announce.

## Identity, revisions, and deleted definitions

Each custom definition has a stable runtime ID, a revision, and a launch fingerprint. The fingerprint describes the launch-relevant command, arguments, and configured environment. A saved chat records that identity together with the ACP runtime session ID and its continuation strategy.

If a definition changes after a chat was created, reconnecting the chat asks for confirmation before starting the changed executable. This makes the configuration change visible instead of silently continuing a historical chat through a different adapter or gateway.

Deleting a definition removes it from the selectable runtime catalog but retains a tombstone under **Deleted definitions retained for history**. Tombstones preserve the stable ID needed to render and search old chats without making the deleted adapter available for new chats. Restore returns the same ID to the active catalog; a changed fingerprint can still require reconnect confirmation.

Definitions are global application configuration, not vault data. NeverWrite intentionally does not copy commands, environment settings, or adapter definitions into a vault. A shared vault can contain history that refers to a custom runtime without distributing executable paths or local machine configuration to collaborators.

## Limits and recovery

At most 32 active and 32 deleted custom definitions are retained. Runtime names, commands, arguments, environment names, and values are length-limited and validated before saving. The setup screen only considers an active definition selectable when its executable is ready.

Deleting a live chat explicitly closes the ACP process NeverWrite launched for that session. Deleting a definition does not close an already-live session. Closing a chat tab only hides the view; it does not delete the chat or terminate the runtime.

If reconnect reports that the definition is missing, restore it in Settings and retry. If it reports that the definition changed, review the command and environment, then confirm the new fingerprint only if it is expected. If the executable is missing, fix the command or installation and use **Verify executable**. If a runtime exits or rejects the handshake, inspect its own logs and verify that it speaks the current ACP protocol over stdio.

For broader diagnostics, see [AI Runtime Setup](ai-runtime-setup.md), [AI Session History And Crash Recovery](ai-session-history.md), [Data And Privacy](data-and-privacy.md), and [Troubleshooting](troubleshooting.md).
