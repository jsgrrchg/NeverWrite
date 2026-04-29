# NeverWrite

NeverWrite is a local-first knowledge workspace for people who find themself spawning lots of agents at the same time. Built like a code editor, but for markdown. It has inline review changes, like cursor and others. Please help me test it!

Today the repository combines:

- An Electron desktop app with a Rust sidecar that opens a real local vault and keeps working state on disk
- A  Markdown, CSV, and text/code editing workflow with wikilinks, live preview, frontmatter editing, spellcheck, and grammar checking
- Knowledge navigation tools such as backlinks, tags, advanced search, bookmarks, concept maps, and a 2D/3D graph view. 
- An ACP-based AI layer with Codex, Claude, Gemini, and Kilo runtimes
- An explicit AI change-review system with inline review inside the editor and a dedicated review surface in chat and as a tab. 
- A separate browser web clipper that can save directly into the desktop app through a local API, with deep-link fallback. Compatible with both firefox and chromium. 

This README reflects the code currently present in the repository, not a future roadmap.

## What NeverWrite Is Today

The current product already includes:

- Local vault opening with progress reporting, persisted snapshots, filesystem watching, and incremental re-sync
- A desktop workspace with tabs, sidebars, command palette, quick switcher, detached windows, and a developer terminal
- Native-feeling editing for Markdown notes, CSV files, PDFs, images, and generic text/code files
- Embedded Excalidraw-based concept maps stored as `.excalidraw` files in the vault
- A graph view with global, local, and overview modes plus 2D and 3D rendering
- AI chat sessions with attachments from the vault, slash commands, transcript persistence, and runtime-specific capabilities
- A real AI review pipeline so generated edits are not silently committed

## Why It Is Different

- It works on a real local vault instead of a proprietary cloud document model.
- AI edits stay reviewable through an accumulated action log, inline controls, and a dedicated review tab.
- The desktop app is not limited to Markdown notes; it already handles CSV files, PDFs, images, text/code files, and maps in the same workspace.
- The browser clipper is not a stub. It talks to a local desktop API, autocompletes folders and tags, and falls back to deep links when needed.

## Current Capabilities

### Vault and workspace

- Open, index, and watch a local vault
- Recent vaults, pinned vaults, reopen-last-vault behavior
- File tree with drag and drop, multi-selection, sorting, and context actions
- Persistent bookmarks per vault
- Persistent tabs and window session restore
- Detached note windows and separate vault windows

### Editing and reading

- Markdown editing with CodeMirror 6
- Wikilink suggestions, resolution, and navigation
- Live preview with tasks, tables, embeds, math, and YouTube previews
- Frontmatter/properties editing
- CSV editing with table and raw fallback views
- Editable text/code files with syntax highlighting and autosave
- PDF viewing with visual filters. 
- Internal image viewing with fit and zoom
- App-owned Hunspell-based spellcheck with bundled `en-US` and `es-ES`
- Grammar/style checks through LanguageTool

### Knowledge navigation

- Backlinks and outgoing links
- Tags extracted from content and frontmatter
- Advanced search with query builder, regex, negation, `OR`, and property filters
- Graph view in 2D and 3D
- Concept maps in `.excalidraw`

### AI and change control

- ACP runtime integration for Codex, Claude, Gemini, and Kilo
- Attachment flows for notes, folders, files, PDFs, audio, images, and screenshots
- Session history, transcript viewing, session export, fork, resume, and rename flows
- Inline review inside the editor when the tracked file has a reliable base
- A dedicated `Review` tab plus an `Edits` surface for keep/reject workflows
- Rust/WASM-backed diffing and change tracking

### Web clipper

- Dedicated browser extension in `apps/web-clipper`
- Full page, selection, and URL-only clipping modes
- Markdown preview before save
- Template system with vault and domain scoping
- Local clip history
- Direct desktop save through `http://127.0.0.1:32145/api/web-clipper`
- Deep-link fallback when the desktop API is unavailable

## Monorepo Layout

```text
apps/
  desktop/          Main Electron + React desktop application
  web-clipper/      Browser extension built with WXT + React

crates/
  ai/               Shared AI domain types
  diff/             Rust diff engine, plus WASM bindings for review flows
  index/            Vault indexing, link resolution, and search primitives
  types/            Shared DTOs and domain models
  vault/            Vault scanning, parsing, filesystem watching, and PDF discovery
```

Useful docs already in the repo:

- [`apps/web-clipper/README.md`](apps/web-clipper/README.md)
- [`release/appcast/README.md`](release/appcast/README.md)
- [`apps/desktop/src/features/spellcheck/ARCHITECTURE.md`](apps/desktop/src/features/spellcheck/ARCHITECTURE.md)

## Stack

- **Desktop shell**: Electron 41, React 19, TypeScript 6, Vite 8, Tailwind CSS 4, CodeMirror 6, Excalidraw, PDF.js, electron-updater
- Desktop native backend: Rust 2021, Tokio, `notify`, `portable-pty`, `reqwest`, `spellbook`, app-owned spellcheck runtime
- **Desktop main process**: Electron IPC plus a Node HTTP server for the local web clipper API
- Shared Rust crates: vault parsing, indexing, search, diff, DTOs
- **Browser extension**: WXT, React, TypeScript, Chrome MV3 and Firefox MV3 targets

## Development

**Important**: there is no top-level JavaScript workspace package. JavaScript dependencies are installed per app.

### Requirements

- Rust and Cargo
- Node.js 22+ and npm for `apps/desktop` and JavaScript tooling
- pnpm for `apps/web-clipper` (`packageManager` is pinned to `pnpm@10.33.0`)

CI and release workflows are pinned to Node.js 22, so local development should use Node 22 or newer.

### Desktop app

```bash
cd apps/desktop
npm install
npm run dev
```

That starts the Electron desktop app plus the local renderer dev server.

If you only need the renderer dev server:

```bash
cd apps/desktop
npm run renderer:dev
```

### Web clipper

```bash
cd apps/web-clipper
pnpm install
pnpm dev
```

Build unpacked extensión artifacts:

```bash
cd apps/web-clipper
pnpm build
```

This produces:

- `apps/web-clipper/dist/chrome-mv3/`
- `apps/web-clipper/dist/firefox-mv3/`

### Rust workspace

```bash
cargo test
```

## Validation

Desktop frontend tests:

```bash
cd apps/desktop
npm test
```

Web clipper validation:

```bash
cd apps/web-clipper
pnpm check
```

Rust workspace tests:

```bash
cargo test
```

The repository already contains broad Vitest coverage in the desktop app and web clipper, plus Rust integration tests for vault and index behavior.

## AI Runtime Notes

NeverWrite currently wires four ACP runtimes:

- `codex-acp`
- `claude-acp`
- `gemini`
- `kilo-acp`

Current packaging status:

- Codex is intended to be bundled as a sidecar binary in desktop release builds.
- Claude is intended to be bundled through an embedded Node runtime plus vendored runtime files.
- Gemini is integrated in the app, but not bundled by default today.
- Kilo is integrated in the app, but not bundled by default today.

Useful runtime overrides during development:

- `NEVERWRITE_CODEX_ACP_BIN`
- `NEVERWRITE_CLAUDE_ACP_BIN`
- `NEVERWRITE_GEMINI_ACP_BIN`
- `NEVERWRITE_KILO_ACP_BIN`

For release builds, see `apps/desktop/scripts/stage-electron-sidecar.mjs` and `release/appcast/README.md`.

## Web Clipper Notes

The web clipper talks to the desktop app through a local HTTP API on port `32145`.

When developing against an unpacked extension build, the desktop app blocks arbitrary extension origins by default. To explicitly allow a local extension origin, start the desktop app with:

```bash
cd apps/desktop
NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS="chrome-extension://<dev-id>,moz-extension://<dev-id>" npm run dev
```

Use exact origins only. Wildcards are intentionally unsupported.

## Project Status

NeverWrite is in a polish and hardening phase, not in a toy-MVP phase. Core systems already exist, but the project is still pre-`1.0`.

The areas with the highest product sensitivity right now are:

- AI review and change control
- Inline review and merge behavior
- Session persistence and multi-window workflows
- Desktop-to-clipper integration

## License

Apache-2.0. See [`LICENSE`](LICENSE).
