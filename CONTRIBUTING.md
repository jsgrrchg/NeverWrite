# Contributing to NeverWrite

Thanks for your interest in contributing to NeverWrite. This guide covers everything you need to get started.

## Prerequisites
| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 22+ | Required for desktop app and CI |
| **npm** | 11+ | Package manager for `apps/desktop` |
| **pnpm** | 10.33+ | Package manager for `apps/web-clipper` |
| **Rust** | 1.94+ | Edition 2021 across all crates |
| **Tauri CLI** | 2.x | Install via `cargo install tauri-cli` |

### Platform-specific

- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: MSVC Build Tools, WebView2
- **Linux**: See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Repository structure

```
apps/
  desktop/            Tauri + React desktop app (npm)
  web-clipper/        WXT browser extension (pnpm)
crates/
  types/              Shared DTOs and domain models
  vault/              Vault scanning, parsing, filesystem watching
  index/              Search, link resolution, indexing
  diff/               Diff engine + WASM bindings
  ai/                 Shared AI domain types
vendor/               Vendored ACP runtimes
scripts/              Automation utilities
```

## Getting started

### Desktop app

```bash
cd apps/desktop
npm install

# Frontend only (Vite dev server)
npm run dev

# Full Tauri app with Rust backend
npm run tauri -- dev
```

### Web clipper

```bash
cd apps/web-clipper
pnpm install
pnpm dev
```

### Rust workspace

```bash
# From the repo root
cargo build
cargo test
```

## Development workflow

### 1. Fork and clone

```bash
git clone <your-fork-url>
cd <your-clone-directory>
```

### 2. Create a branch

```bash
git checkout -b my-change
```

### 3. Make your changes

Follow the code style guidelines below, then verify:

```bash
# Desktop
cd apps/desktop
npm run lint          # ESLint
npm run build         # TypeScript check (tsc -b) + Vite build
npm test              # Vitest

# Web clipper
cd apps/web-clipper
pnpm run check        # TypeScript + tests + build (all-in-one)

# Rust
cargo test
```

### 4. Commit and push

```bash
git add <files>
git commit -m "fix(editor): resolve cursor jump on live preview toggle"
git push origin my-change
```

### 5. Open a pull request

Open a PR against `main`. Describe what changed and why. Link related issues if applicable.

## Commit messages

We use a lightweight conventional format:

```
type(scope): short description
```

**Types**: `fix`, `feat`, `refactor`, `chore`, `docs`, `test`, `perf`

**Scope** is optional but encouraged for targeted changes (e.g., `editor`, `vault`, `clipper`, `ai`).

**Examples**:

```
fix(editor): resolve cursor jump on live preview toggle
feat(clipper): add selection-only clipping mode
refactor: simplify change rail review projection
chore: clean up pdf tab view zoom handling
```

Keep messages descriptive and action-focused. Write in lowercase unless starting with a proper noun.

## Code style

### TypeScript

- **Strict mode** is enabled (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
- Use `import type` for type-only imports (`verbatimModuleSyntax` is enforced)
- Prefix unused parameters with `_`
- ESLint with TypeScript strict rules — run `npm run lint` before committing

### React

- Functional components only
- Zustand for state management — stores live in `app/store/`
- Feature code goes in `features/<feature-name>/`
- Shared components go in `components/`

### Rust

- Default `rustfmt` formatting
- Edition 2021
- Use `cargo clippy` for additional lint checks

### General principles

- **Simplicity first** — the simplest solution that works
- **Fix root causes** — don't patch around broken abstractions
- **Bounded refactors** — if a fix requires restructuring, keep it scoped to the affected module
- **No speculative cleanup** — don't refactor code that your change doesn't touch

## Testing

### Frontend (Vitest + Testing Library)

```bash
# Desktop
cd apps/desktop
npm test              # Run once
npm run test:watch    # Watch mode

# Web clipper
cd apps/web-clipper
pnpm test             # Watch mode
pnpm test:run         # Run once
```

- Test files live next to the code they test: `MyComponent.test.tsx`
- Use `describe()`, `it()`, `expect()` from Vitest
- Use Testing Library for component tests (`@testing-library/react`)
- Mock Tauri APIs with `vi.mocked()`

### Rust

```bash
cargo test                        # All workspace tests
cargo test -p neverwrite-vault      # Single crate
```

## Architecture notes

### Frontend stack

- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS 4** — utility-first styling with CSS variables for theming
- **CodeMirror 6** — markdown editor with custom extensions (live preview, change tracking)
- **Zustand** — lightweight state management with per-feature stores

### Backend

- **Tauri 2** — desktop runtime with IPC commands
- **Tokio** — async runtime
- **notify** — filesystem watching
- **tiny_http** — local API server for web clipper communication (port 32145)

### Key patterns

- **Feature modules**: each feature in `features/` owns its components, hooks, and store slices
- **ActionLog**: patch-based change tracking with author attribution (user vs AI)
- **Live preview**: CodeMirror ViewPlugin that hides markdown syntax when the cursor is elsewhere
- **Wikilinks**: parsed from markdown, resolved against the vault index for navigation and backlinks

## Environment variables

For development, these optional variables can override default runtime paths:
| Variable | Purpose |
|----------|---------|
| `NEVERWRITE_CODEX_ACP_BIN` | Override Codex ACP runtime binary |
| `NEVERWRITE_CLAUDE_ACP_BIN` | Override Claude ACP runtime binary |
| `NEVERWRITE_GEMINI_ACP_BIN` | Override Gemini ACP runtime binary |
| `NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS` | Allow unpacked extension origins |

## Versioning

We follow [Semantic Versioning](https://semver.org/). During the `0.x` phase, minor bumps may include breaking changes.

Versions are kept in sync across:
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`
- `CHANGELOG.md`

Use `scripts/bump-version.sh` to update all locations at once.

## Release automation

Desktop releases are maintainer-driven and run manually from GitHub Actions.

Before triggering [`.github/workflows/release-desktop.yml`](.github/workflows/release-desktop.yml):

- Create and push the release tag first, for example `v0.2.0`
- Ensure the required signing secrets are configured in the GitHub repository settings
- If you want signed macOS artifacts, also configure the Apple signing and notarization secrets documented in [`release/appcast/README.md`](release/appcast/README.md)

## Reporting issues

- Search the existing issue tracker before opening a new one
- Include steps to reproduce, expected behavior, and actual behavior
- For crashes, include the OS version and any relevant logs

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
