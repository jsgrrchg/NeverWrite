# Project Architecture

This document is the high-level map for contributors and maintainers. It explains
how the monorepo fits together and where the major runtime boundaries are. It is
not meant to replace subsystem docs; follow the linked documents when changing a
specific area.

Useful deeper references:

- [Editor Architecture](./editor-architecture.md)
- [AI Change Control](./ai-change-control.md)
- [AI Runtime Setup](./ai-runtime-setup.md)
- [AI Session History And Crash Recovery](./ai-session-history.md)
- [Data And Privacy](./data-and-privacy.md)
- [Testing and Validation](./testing.md)
- [App Logs](./app-logs.md)

## Overview

NeverWrite is a local-first desktop knowledge workspace with an Electron shell,
a React renderer, a Rust native sidecar, shared Rust crates, and a separate WXT
browser extension for clipping web content into an open vault.

At runtime, the main desktop path is:

```text
React renderer
  -> preload bridge: window.neverwriteElectron
  -> Electron main IPC router
  -> ElectronVaultBackend wrapper
  -> Rust native backend sidecar, when the command is sidecar-owned
  -> local vault files, ACP runtime processes, spellcheck dictionaries, terminals
```

The renderer never talks directly to Node.js APIs, the filesystem, or provider
CLIs. Those capabilities are exposed through explicit runtime commands and
events.

## Monorepo Map

```text
apps/
  desktop/              Electron + React desktop app
    src/                Renderer app, features, Zustand stores, runtime facade
    src-electron/       Electron main/preload/shared IPC code
    native-backend/     Rust sidecar binary used by the desktop app
    scripts/            Desktop build, sidecar staging, smoke tests, packaging
  web-clipper/          WXT + React browser extension

crates/
  types/                Shared DTOs and domain models
  vault/                Vault scanning, parsing, scoped paths, filesystem watch
  index/                Search, tags, links, backlinks, wikilink resolution
  diff/                 Diff/action-log engine and WASM bindings for review
  ai/                   Shared AI runtime/session/events/persistence types

vendor/
  codex-acp/            Vendored Codex ACP adapter used for release builds
  Claude-agent-acp-upstream/
                        Vendored Claude ACP runtime snapshot and dist output
  acp12/                Vendored legacy ACP crates used by the native backend
                        for Grok compatibility

scripts/                Root release, appcast, version, and validation utilities
release/appcast/        Appcast and release topology documentation
```

There is no top-level JavaScript workspace package. Desktop JavaScript commands
run from `apps/desktop` with npm; web clipper commands run from
`apps/web-clipper` with pnpm. The Rust workspace is rooted at `Cargo.toml` and
includes the shared crates plus `apps/desktop/native-backend`.

## Desktop Runtime

The Electron app has three JavaScript/TypeScript layers:

- The renderer in [`apps/desktop/src`](../apps/desktop/src) owns the React UI,
  feature modules, CodeMirror editor surfaces, graph/map views, AI chat/review
  UI, settings, terminal UI, and Zustand stores.
- The preload script in
  [`apps/desktop/src-electron/preload/index.ts`](../apps/desktop/src-electron/preload/index.ts)
  exposes a narrow `window.neverwriteElectron` API through Electron's
  `contextBridge`.
- The main process in
  [`apps/desktop/src-electron/main`](../apps/desktop/src-electron/main) owns
  windows, menus, app identity, custom protocols, native dialogs, opener APIs,
  update checks, web clipper HTTP integration, logging, and sidecar lifecycle.

[`apps/desktop/src/App.tsx`](../apps/desktop/src/App.tsx) is the main renderer
composition point. It wires workspace layout, tabs, vault events, menu actions,
window restoration, AI chat hosts, terminal hosts, clipper notifications, and
app update state. Most feature-specific behavior should live under
`apps/desktop/src/features/<feature>` or `apps/desktop/src/app/store`, not in
Electron main.

The renderer calls the desktop environment through the runtime facade in
[`apps/desktop/src/app/runtime`](../apps/desktop/src/app/runtime). In production
that facade delegates to the Electron preload API; tests can use the test
runtime to avoid depending on Electron.

## IPC Boundaries

The IPC contract is intentionally small:

- Channel names and envelopes live in
  [`apps/desktop/src-electron/shared/ipc.ts`](../apps/desktop/src-electron/shared/ipc.ts).
- Renderer calls use `invoke(command, args)` and event subscriptions from the
  runtime facade.
- Preload forwards those calls to `ipcRenderer` and forwards main-process events
  back to renderer listeners.
- Main process handlers are registered in
  [`apps/desktop/src-electron/main/ipc.ts`](../apps/desktop/src-electron/main/ipc.ts).

The important command path is:

```text
renderer invoke("command", args)
  -> preload ELECTRON_IPC.invoke
  -> main registerInvokeHandler()
  -> ElectronVaultBackend.invoke(command, args)
  -> nativeBackend.invoke(command, args), if the sidecar supports it
```

Main process also exposes separate IPC handlers for dialogs, opening/revealing
paths, external URLs, window management, renderer-to-renderer event routing, and
renderer log forwarding. Keep privileged behavior behind these explicit
handlers instead of adding ad-hoc globals to the renderer.

The native backend transport is JSON lines over the sidecar's stdin/stdout. Main
assigns request IDs, tracks pending promises, redacts known secret patterns from
sidecar stderr, and rebroadcasts sidecar event messages to all renderer windows.

## Native Backend

The Rust sidecar lives in
[`apps/desktop/native-backend`](../apps/desktop/native-backend). Its entry point
is [`src/main.rs`](../apps/desktop/native-backend/src/main.rs). The sidecar owns
the local, stateful backend capabilities that should not live in the renderer:

- Opening vaults, scanning notes/files, building an in-memory `VaultIndex`, and
  discovering visible vault entries.
- Maintaining per-vault runtime state, graph revisions, note/file revisions,
  write tracking, and filesystem watchers.
- Reading, saving, creating, moving, deleting, and trashing vault entries with
  vault-scoped path validation.
- Search, advanced search, tags, backlinks, graph snapshots, wikilink
  resolution, and map file operations.
- AI runtime discovery, setup state, authentication helpers, ACP session
  lifecycle, permission responses, user-input responses, events, and session
  history persistence.
- Web clipper save hooks that resolve a ready vault, create a note, emit a vault
  change, and return the saved note path to Electron main.
- App-owned spellcheck and LanguageTool grammar checks in
  [`spellcheck.rs`](../apps/desktop/native-backend/src/spellcheck.rs).
- Developer/auth terminal PTY management in
  [`devtools.rs`](../apps/desktop/native-backend/src/devtools.rs) and
  [`ai.rs`](../apps/desktop/native-backend/src/ai.rs).

Vault changes are emitted as runtime events with origin metadata such as `user`,
`agent`, or `external`. The renderer uses those events to refresh stores,
invalidate editor caches, reconcile open tabs, and display clipper or review
updates.

## Shared Rust Crates

The shared crates keep core logic out of Electron-specific code:

- [`crates/types`](../crates/types) defines common DTOs and domain types shared
  by the sidecar and other crates.
- [`crates/vault`](../crates/vault) opens vaults, parses Markdown/frontmatter,
  discovers PDFs and general entries, enforces scoped path intent, and starts
  filesystem watchers with write tracking.
- [`crates/index`](../crates/index) builds `VaultIndex` and powers search,
  tags, backlinks, outgoing links, and wikilink suggestions/resolution.
- [`crates/diff`](../crates/diff) computes line/text patches and implements the
  action-log review algorithms. The renderer consumes its WASM build for AI
  change-control flows, with JavaScript fallbacks where needed.
- [`crates/ai`](../crates/ai) defines AI runtime descriptors, events, session
  domain models, persistence helpers, and tool-diff normalization shared with
  the native backend.

When changing behavior that must stay consistent across the sidecar and
renderer review UI, prefer moving the invariant into the shared Rust crate
instead of duplicating it in TypeScript.

## AI Runtime Flow

NeverWrite talks to providers through ACP runtimes. The renderer owns the chat
UX, but the native backend owns runtime process discovery, setup, auth state,
session startup, provider environment injection, ACP requests, and event
translation. See [AI Runtime Setup](./ai-runtime-setup.md) for provider setup
details.

High-level flow:

```text
Settings / AI chat UI
  -> ai_* runtime command
  -> native backend NativeAi
  -> resolved ACP runtime process
  -> ACP initialize + new/load session
  -> provider session notifications
  -> ai://... events back through Electron IPC
  -> chat store, review UI, transcript persistence
```

The backend currently supports Codex, Claude, Grok, Kilo, and OpenCode
runtime IDs. Codex and Claude have vendored release inputs under `vendor/`;
Grok, Kilo, and OpenCode are integrated as external runtimes that must be found
on `PATH` or configured by override.

ACP runtime handling is split by provider compatibility:

- Claude, Codex, Kilo, and OpenCode use the current ACP session-config path.
- Grok uses the legacy ACP model/mode path, backed by the vendored
  `vendor/acp12/` Rust crates in the native backend.

`vendor/acp12/` is not a packaged provider runtime. It is a backend
compatibility dependency that lets NeverWrite talk to the external Grok CLI
while the rest of the ACP stack can continue using the current protocol path.

ACP session notifications are normalized into renderer events for assistant
message deltas, thinking deltas, tool activity, file diffs, permission requests,
status updates, token usage, generated images, runtime connection state, and
session lifecycle changes. Permission requests block in the ACP client until the
renderer responds through `ai_respond_permission`.

Session history is saved under the vault's `.neverwrite/sessions/` directory.
See [AI Session History And Crash Recovery](./ai-session-history.md) for the disk
layout and recovery behavior.

## Web Clipper Flow

The web clipper is an isolated WXT extension in
[`apps/web-clipper`](../apps/web-clipper). It extracts page, selection, and URL
content in the browser; applies user templates and preferences; and tries to save
directly into the running desktop app through the local API first.

Direct desktop flow:

```text
Browser extension
  -> http://127.0.0.1:32145/api/web-clipper
  -> Electron main webClipper server
  -> ElectronVaultBackend.invoke("web_clipper_*")
  -> Rust native backend
  -> vault note creation + vault change event
  -> renderer toast / route-to-created-note event
```

The local API is implemented in
[`apps/desktop/src-electron/main/webClipper.ts`](../apps/desktop/src-electron/main/webClipper.ts).
It exposes pairing, health, theme, folder, tag, and clip-save endpoints. Requests
must come from the official extension origins or explicitly allowed development
origins, and subsequent requests include a stored pairing token.

If the local API is unavailable, the extension falls back to a `neverwrite://clip`
deep link. Electron main handles those links on app startup, second-instance
activation, or macOS `open-url`, then saves through the same backend command.

## Review And Vault Data Flow

The vault is the source of truth. Renderer stores cache active UI state; the
native backend reads and writes vault files, refreshes its index, and emits
change events. A typical user save is:

```text
Editor tab
  -> save_note / save_vault_file
  -> native backend writes file with WriteTracker
  -> backend refreshes index and emits vault change
  -> vault/editor stores update open resources and graph/search metadata
```

AI edits follow a stricter review path. ACP tool diffs are normalized by the
native backend and delivered to the renderer as AI tool activity. The AI chat
store consolidates those diffs into an ActionLog, then the editor and review
surfaces project that canonical tracked-file state into inline controls, review
cards, and keep/reject actions. The important invariant is that pending review is
agent-owned text spans, not just visual line hunks. See
[AI Change Control](./ai-change-control.md) before changing inline review,
edited-files buffers, merge view behavior, or accept/reject logic.

Editor internals, tab boundaries, live preview, autosave, and merge-view
integration are covered in [Editor Architecture](./editor-architecture.md).

## Release And Packaging Touchpoints

Release builds stage more than the renderer bundle:

- Desktop packaging scripts live in
  [`apps/desktop/scripts`](../apps/desktop/scripts), including sidecar staging,
  release asset staging, bundle verification, and smoke tests.
- Root release/appcast utilities live in [`scripts`](../scripts), with appcast
  details in [`release/appcast/README.md`](../release/appcast/README.md).
- Vendored ACP runtimes are documented in
  [`vendor/README.md`](../vendor/README.md). Treat updates there as runtime
  upgrades, not ordinary dependency bumps.
- Web clipper builds produce Chrome and Firefox MV3 artifacts from
  `apps/web-clipper`.

Before broad changes, use [Testing and Validation](./testing.md) to choose the
right checks. For runtime, packaging, or release work, include the sidecar build
and Electron smoke tests when possible.

## Where To Start

- For renderer UI, start with [`apps/desktop/src/App.tsx`](../apps/desktop/src/App.tsx),
  the relevant `features/<feature>` directory, and the related Zustand store in
  [`apps/desktop/src/app/store`](../apps/desktop/src/app/store).
- For Electron boundaries, start with
  [`src-electron/main/ipc.ts`](../apps/desktop/src-electron/main/ipc.ts),
  [`src-electron/preload/index.ts`](../apps/desktop/src-electron/preload/index.ts),
  and [`src-electron/main/nativeBackend.ts`](../apps/desktop/src-electron/main/nativeBackend.ts).
- For vault behavior, start with
  [`apps/desktop/native-backend/src/main.rs`](../apps/desktop/native-backend/src/main.rs),
  [`crates/vault`](../crates/vault), and [`crates/index`](../crates/index).
- For AI runtime behavior, start with
  [`apps/desktop/native-backend/src/ai.rs`](../apps/desktop/native-backend/src/ai.rs),
  [`apps/desktop/src/features/ai`](../apps/desktop/src/features/ai), and
  [AI Runtime Setup](./ai-runtime-setup.md).
- For AI review/change control, start with
  [`apps/desktop/src/features/ai/store/actionLogModel.ts`](../apps/desktop/src/features/ai/store/actionLogModel.ts),
  [`crates/diff`](../crates/diff), and [AI Change Control](./ai-change-control.md).
- For web clipping, start with
  [`apps/web-clipper/README.md`](../apps/web-clipper/README.md),
  [`apps/web-clipper/src/lib/desktop-api.ts`](../apps/web-clipper/src/lib/desktop-api.ts),
  and [`apps/desktop/src-electron/main/webClipper.ts`](../apps/desktop/src-electron/main/webClipper.ts).

Last updated: June 1, 2026.
