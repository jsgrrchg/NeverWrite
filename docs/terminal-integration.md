# Terminal Architecture

The terminal is a first-class workspace surface. It is available from workspace
commands and tab menus without requiring Developer Mode, and terminal tabs
participate in pane layout, tab persistence, and workspace restore.

This page documents the current architecture. Older implementation plans used
`features/devtools/terminal`; the terminal UI now lives under
[`apps/desktop/src/features/terminal`](../apps/desktop/src/features/terminal).
The `devtools_*` command names and `devtools://terminal-*` event names remain
part of the IPC protocol and should not be renamed just because the renderer
folder moved.

## Runtime Boundary

The PTY backend is the Rust sidecar in
[`apps/desktop/native-backend/src/devtools.rs`](../apps/desktop/native-backend/src/devtools.rs).
It uses `portable-pty`, not `node-pty`, and is reached through the Electron main
process allowlist in
[`nativeBackend.ts`](../apps/desktop/src-electron/main/nativeBackend.ts).

Terminal session creation flows through:

```text
Terminal tab / runtime store
  -> invoke("devtools_create_terminal_session")
  -> Electron main native backend bridge
  -> Rust devtools PTY session
  -> devtools://terminal-* events
  -> terminal runtime store
  -> TerminalViewport / xterm.js
```

The Rust create input accepts `cwd`, `cols`, `rows`, and `extraEnv`. The sidecar
sets `TERM=xterm-256color` and `COLORTERM=truecolor`, then applies `extraEnv`.
Settings currently use that path to add `CLAUDE_CODE_NO_FLICKER=1` for newly
opened Claude Code terminals when fullscreen rendering is enabled.

Any change to PTY spawn behavior crosses the TypeScript/Rust boundary and
requires rebuilding and repackaging the native sidecar.

## Renderer Pieces

The main renderer files are:

- [`WorkspaceTerminalHost.tsx`](../apps/desktop/src/features/terminal/WorkspaceTerminalHost.tsx):
  subscribes to sidecar terminal events and feeds them into the runtime store.
- [`WorkspaceTerminalView.tsx`](../apps/desktop/src/features/terminal/WorkspaceTerminalView.tsx):
  mounts the active terminal viewport for a workspace tab.
- [`TerminalViewport.tsx`](../apps/desktop/src/features/terminal/TerminalViewport.tsx):
  owns the xterm.js instance, search UI, dictation overlay, WebGL renderer, fit
  behavior, copy/paste context menu, and replay snapshot capture.
- [`terminalRuntimeStore.ts`](../apps/desktop/src/features/terminal/terminalRuntimeStore.ts):
  owns live terminal runtime state and pipes PTY output directly to viewport
  subscribers instead of storing every chunk in React state.
- [`useTerminalTabs.ts`](../apps/desktop/src/features/terminal/useTerminalTabs.ts):
  reads the legacy standalone terminal workspace format used by the migration
  path.
- [`claudeCodeTerminal.ts`](../apps/desktop/src/features/terminal/claudeCodeTerminal.ts):
  launches Claude Code inside a terminal tab, injects safe startup arguments,
  and registers the terminal as an agent-sidebar entry.

Output is streamed to xterm through transient output commands. React state tracks
session metadata, busy/error state, and whether output exists, but the terminal
viewport is the source of truth for screen content. Reattach/reload support uses
serialized xterm replay snapshots rather than rebuilding screen content from a
large React string.

## Settings And Persistence

Terminal settings are stored with the vault-scoped Settings store:

- `terminalFontFamily`
- `terminalFontSize`
- `claudeCodeOptimized`
- `claudeCodeSkipPermissions`
- `claudeCodeModel`
- `claudeCodeContinueSession`

See [Settings Scope](./settings-scope.md) for the full storage matrix.

First-class workspace terminal tabs are persisted with the editor session under
`neverwrite.session.tabs:<vault-path>`. The older standalone terminal workspace
key, `neverwrite.devtools.terminal.tabs:<vault-path>`, is still read by the
legacy migration path and keeps its `devtools` prefix for compatibility with
existing user data. Replay snapshots are stored per terminal id under
`neverwrite.terminal.replay:<terminal-id>` and are cache/state, not a user-facing
setting.

## Claude Code Integration

Claude Code is represented in two ways:

- As an integrated terminal command launched by
  [`claudeCodeTerminal.ts`](../apps/desktop/src/features/terminal/claudeCodeTerminal.ts).
- As a lightweight, non-persisted agent-sidebar entry managed by
  [`claudeTerminalAgentSession.ts`](../apps/desktop/src/features/ai/claudeTerminalAgentSession.ts).

When a Claude Code terminal is opened from file-tree or agent context,
NeverWrite:

1. Opens a terminal tab in the requested pane.
2. Waits for the PTY to reach `running`.
3. Optionally changes directory to the selected vault folder.
4. Starts `claude` with sanitized settings-derived arguments.
5. Registers the terminal in the Agents sidebar.
6. Polls Claude Code transcript files, when a pinned session id is available, to
   update the sidebar title, preview, and terminal tab title.

`--continue` sessions cannot be pinned to a known transcript id up front, so
transcript-derived title/preview are intentionally disabled in that mode rather
than guessed from another terminal's JSONL.

Claude Code prompt prefill still uses a fixed TUI settle delay before injecting
`@` mentions. That delay is a best-effort heuristic; a future improvement should
detect a stable ready marker from terminal output or use an upstream CLI flag if
Claude Code exposes one.

## Validation

For terminal UI and runtime changes, start with targeted Vitest coverage:

```bash
cd apps/desktop
npm test -- src/features/terminal src/features/ai/claudeTerminalAgentSession.test.ts
```

When native commands or PTY behavior change, rebuild the sidecar and run the
Electron smoke tests:

```bash
cd apps/desktop
npm run electron:sidecar:build
npm run electron:vault-editor:smoke
npm run electron:ai-runtime:smoke
```

For packaging-sensitive terminal changes, also run the packaged app and sidecar
smokes described in [Testing and Validation](./testing.md).

Last updated: June 1, 2026.
