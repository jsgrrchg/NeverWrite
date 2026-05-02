
# NeverWrite

<img width="2693" height="1211" alt="Captura de pantalla 2026-04-30 a las 5 03 43" src="https://github.com/user-attachments/assets/83968dc3-cfb9-41b5-ad99-bfea4305447b" />

**Note**: To everyone who has starred the repo: thank you. You’ve made me genuinely happy, I published this 3 days ago and I’ll keep improving this app for the long run. If you’re a Linux developer, I’d really appreciate your help getting the app fully up and running on Linux. I’m still a bit lost with the different package formats and how to wire them all into the GitHub Actions release pipeline, so a PR on this front would be amazing. Next, I’ll be focusing on adding Cron jobs — similar in spirit to OpenClaw — plus hardening, modularizing some of the larger files, and fixing edge cases in the live Markdown preview. Obsidian, one of my favorite apps, has years of patches behind its editor, and getting CodeMirror to render Markdown, hide source decorations, and stay fast is surprisingly difficult. If you run into rendering bugs or weird editor behavior, please help me find and fix them. 

Also, NeverWrite will expand its current provider list to include all ACP compliant providers. This will take time, and API credits, because each provider needs to be extensively tested and adapted where necessary to support NeverWrite’s AI change-control layer. Because of NeverWrite’s ethics, I have to prioritize making every change reviewable by the user: no black boxes, no obfuscation, and no hidden writes of any kind. The most urgent feature right now is to give power users a way to set up a custom ACP implementation themselves. Currently being discussed here https://github.com/jsgrrchg/NeverWrite/discussions/17. 

Thanks again for your support!

----

NeverWrite is a local-first knowledge workspace for people who need to handle workflows with multiple parallel agents and subagents. Built like a code editor, but for markdown. It has inline review changes, like Cursor and others. Please help me test it!

Today the repository combines:

- An Electron desktop app with a Rust sidecar that opens a local vault and keeps working state on disk.
- A Markdown, CSV, and text/code editing workflow with wikilinks, live preview, frontmatter editing, spellcheck, and grammar checking.
- Knowledge navigation tools such as backlinks, tags, advanced search, bookmarks, concept maps, and a 2D/3D graph view.
- An ACP-based AI layer with Codex, Claude, Gemini, and Kilo runtimes.
- An explicit AI change-review system with inline review inside the editor and a dedicated surface in chat and a tab with changes pending approval.
- A separate browser web clipper that can save directly into the desktop app through a local API, with deep-link fallback. Compatible with both Firefox and Chromium.

## What NeverWrite Is Today

The current product already includes:

- Local vault opening with progress reporting, persisted snapshots, filesystem watching, and incremental re-sync
- A desktop workspace with tabs, sidebars, command palette, quick switcher, detached windows, and a developer terminal
- Native-feeling editing for Markdown notes, CSV files, PDFs, images, and generic text/code files
- Embedded Excalidraw-based concept maps stored as `.excalidraw` files in the vault. The map format is visible and editable by agents.
- A graph view with global, local, and overview modes plus 2D and 3D rendering
- AI chat sessions with attachments from the vault, slash commands, transcript persistence, and runtime-specific capabilities
- A real AI review pipeline so generated edits are not silently committed

## Why It Is Different

- AI edits stay reviewable through an accumulated action log, inline controls, and a dedicated review tab. It is much more than a chat.
- The desktop app is not limited to Markdown notes; it already handles CSV files, PDFs, images, text/code files, and maps in the same workspace.
- It features a best-in-class multipane experience that lets the user parallelize multiple lines of work with agents while simultaneously reading and editing documents in the same window.
- The web clipper allows saving web articles quickly, securely, and efficiently.

## Current Capabilities

### Vault and workspace

- Open, index, and watch a local vault.
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
- PDF viewing with visual filters
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

## Stack

- **Desktop shell**: Electron 41, React 19, TypeScript 6, Vite 8, Tailwind CSS 4, CodeMirror 6, Excalidraw, PDF.js, electron-updater
- **Desktop native backend**: Rust 2021, Tokio, `notify`, `portable-pty`, `reqwest`, `spellbook`, app-owned spellcheck runtime
- **Desktop main process**: Electron IPC plus a Node HTTP server for the local web clipper API
- **Shared Rust crates**: vault parsing, indexing, search, diff, DTOs
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

Build unpacked extension artifacts:

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
- `gemini-acp`
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

NeverWrite is in a polish and hardening phase. Core systems already exist, but the project is still pre-`1.0`, in the process of resolving edge cases — help me find them!!

The areas with the highest product sensitivity right now are:

- AI review and change control
- Inline review and merge behavior
- Session persistence and multi-window workflows
- Desktop-to-clipper integration
- Using the 3D graph on large vaults has memory leaks; after using it, prefer restarting the application.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
