# NeverWrite Desktop

This package contains the main NeverWrite desktop application: a Tauri shell with a
React/TypeScript frontend and a Rust backend.

It is the primary app in the monorepo and includes:

- local vault opening, indexing, and filesystem watching
- Markdown, text/code, PDF, image, and map tabs
- the AI chat surface plus the review and change-control workflow
- spellcheck, grammar integration, search, graph, bookmarks, and detached windows
- the local desktop API used by the browser web clipper

## Package Layout

```text
apps/desktop/
  src/              React frontend
  src-tauri/        Tauri app, Rust backend, bundling config
  public/           Static frontend assets
  scripts/          Local helper scripts used by package.json
```

## Development

Install dependencies:

```bash
cd apps/desktop
npm install
```

Run the frontend only:

```bash
cd apps/desktop
npm run dev
```

That starts Vite on `http://localhost:5173`.

Run the full desktop app:

```bash
cd apps/desktop
npm run tauri -- dev
```

That launches the Tauri app and points it at the local Vite dev server.

## Validation

Lint:

```bash
cd apps/desktop
npm run lint
```

Frontend tests:

```bash
cd apps/desktop
npm test
```

Production frontend build:

```bash
cd apps/desktop
npm run build
```

Rust workspace tests still run from the repository root:

```bash
cargo test
```

## Desktop-Specific Notes

### Frontend vs Tauri

`npm run dev` only starts the frontend. Anything that depends on Tauri commands,
native windows, updater APIs, deep links, the local clipper API, or bundled AI
runtimes must be exercised through `npm run tauri -- dev`.

### AI Runtimes

NeverWrite currently integrates three ACP runtimes:

- `codex-acp`
- `claude-acp`
- `gemini`

Development overrides:

- `VAULTAI_CODEX_ACP_BIN`
- `VAULTAI_CLAUDE_ACP_BIN`
- `VAULTAI_GEMINI_ACP_BIN`

Release-time binary staging is documented in
[`src-tauri/binaries/README.md`](./src-tauri/binaries/README.md).

### Web Clipper Integration

The desktop app exposes a local API for the browser extension on:

```text
http://127.0.0.1:32145/api/web-clipper
```

When testing an unpacked extension build against a local desktop session, allow
the exact extension origins explicitly:

```bash
cd apps/desktop
VAULTAI_WEB_CLIPPER_DEV_ORIGINS="chrome-extension://<dev-id>,moz-extension://<dev-id>" npm run tauri -- dev
```

Wildcards are intentionally unsupported.

### Packaging

The Tauri app configuration lives under `src-tauri/`, especially:

- `src-tauri/tauri.conf.json`
- `src-tauri/Info.plist`
- `src-tauri/Entitlements.plist`
- `src-tauri/build.rs`

The desktop release flow currently targets:

- macOS app bundles and DMGs
- Windows NSIS installers

## Current Status

NeverWrite desktop is already feature-rich, but the project is still pre-`1.0` and
in a polish/hardening phase.

The most sensitive subsystems today are:

- AI review and change control
- inline review and merge behavior
- session persistence and multi-window state
- desktop-to-clipper integration
