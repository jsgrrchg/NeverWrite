# Testing and Validation

This guide maps repository areas to the checks that maintainers expect before a PR is ready. It only lists commands that exist in this repo.

NeverWrite is not a top-level JavaScript workspace. Run JavaScript commands from the app directory that owns the lockfile:

- Desktop: `apps/desktop`, `npm`, `package-lock.json`
- Web clipper: `apps/web-clipper`, `pnpm`, `pnpm-lock.yaml`, pinned to `pnpm@10.33.0`
- Rust workspace: repo root, `cargo`

CI uses Node.js 22. Use Node 22.12.0 or newer for `apps/desktop`, and Node 22 or newer for `apps/web-clipper`.

## Quick Checks

Use these while iterating on a focused change.

```bash
# Rust workspace, from the repo root
cargo test
```

```bash
# Desktop unit/component tests, from apps/desktop
cd apps/desktop
npm test
```

```bash
# Desktop lint, from apps/desktop
cd apps/desktop
npm run lint
```

```bash
# Desktop renderer TypeScript + Vite build, from apps/desktop
cd apps/desktop
npm run build
```

```bash
# Web clipper all-in-one validation, from apps/web-clipper
cd apps/web-clipper
pnpm run check
```

## Full Local Validation

For broad changes, run the same groups as the main CI workflow in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

```bash
# Rust job
cargo test
```

```bash
# Desktop job
cd apps/desktop
npm ci
npm run lint
npm test
npm run electron:build
cd ../..
cargo build -p neverwrite-native-backend
cd apps/desktop
npm run electron:vault-editor:smoke
npm run electron:ai-runtime:smoke
```

```bash
# Web clipper job
cd apps/web-clipper
pnpm install --frozen-lockfile
pnpm run check
```

`npm run electron:vault-editor:smoke` and `npm run electron:ai-runtime:smoke` expect the debug native sidecar at `target/debug/neverwrite-native-backend` (or `.exe` on Windows). Build it first with `cargo build -p neverwrite-native-backend` or, from `apps/desktop`, `npm run electron:sidecar:build`.

## Validation Matrix

| If you touched | Run at minimum | Add when risk is higher |
| --- | --- | --- |
| Rust crates under `crates/` | `cargo test` from repo root | `cargo test -p <crate-name>` while iterating, then full `cargo test` before handoff |
| Native backend under `apps/desktop/native-backend/` | `cargo test` and `cargo build -p neverwrite-native-backend` from repo root | From `apps/desktop`: `npm run electron:vault-editor:smoke` and `npm run electron:ai-runtime:smoke` |
| Desktop React/TypeScript under `apps/desktop/src/` | From `apps/desktop`: `npm run lint`, `npm test`, `npm run build` | Add `npm run electron:build` when Electron preload/main boundaries or runtime imports may be affected |
| Desktop Electron main/preload under `apps/desktop/src-electron/` | From `apps/desktop`: `npm run lint`, `npm test`, `npm run electron:build` | Add native sidecar build plus both Electron sidecar smokes |
| AI runtime setup, ACP integration, session history, or change-control plumbing | From `apps/desktop`: `npm test` and `npm run electron:ai-runtime:smoke` | Add `cargo test` and `npm run electron:build` when native commands or Electron IPC are involved |
| Vault opening, file tree, search, wikilinks, maps, filesystem watching, or editor save flows | `cargo test`, `cargo build -p neverwrite-native-backend`, then from `apps/desktop`: `npm run electron:vault-editor:smoke` | Add `npm test` for affected desktop UI/state tests |
| Desktop packaging config, `apps/desktop/scripts/`, `apps/desktop/build/`, `apps/desktop/embedded/`, vendored runtime packaging, or vendor ACP compatibility crates | From `apps/desktop`: `npm run electron:build`, `npm run electron:package:unsigned`, `npm run electron:app:smoke:packaged`, `npm run electron:sidecar:smoke:packaged` | Prefer the dedicated workflow in [`.github/workflows/electron-package-smoke.yml`](../.github/workflows/electron-package-smoke.yml) for macOS universal, Windows x64/ARM64, and Linux x64/ARM64 coverage. Linux ARM64 validates packaged contents and packages but cannot execute runtime smokes on the x64 runner. |
| Web clipper under `apps/web-clipper/` | From `apps/web-clipper`: `pnpm run check` | `pnpm test:run` for faster unit-test iteration; `pnpm build` when validating unpacked extension artifacts |
| Web clipper to desktop API integration | From `apps/web-clipper`: `pnpm run check`; from `apps/desktop`: relevant web clipper API tests if touched | Manually test with desktop running and authorized unpacked extension origins when changing origin, pairing, or deep-link behavior |
| Release metadata, version files, appcast, or release scripts | `node scripts/validate-release-metadata.mjs --tag vX.Y.Z` from repo root | Release-only builds are covered by [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml) and require signing/platform setup |
| Documentation only | No code check is required by CI | Run affected command examples if the doc changes validation instructions |

## Electron Smoke Tests

The desktop app has two smoke-test categories in [apps/desktop/scripts](../apps/desktop/scripts/).

Debug sidecar smokes run against the locally built native backend:

```bash
cd apps/desktop
npm run electron:sidecar:build
npm run electron:vault-editor:smoke
npm run electron:ai-runtime:smoke
```

`electron:vault-editor:smoke` exercises opening a fixture vault, note/file CRUD, search, backlinks, wikilinks, maps, and filesystem watcher events through the sidecar.

`electron:ai-runtime:smoke` uses a fake ACP runtime to validate runtime descriptors, setup state, session creation, streamed assistant output, tool diff projection, session history persistence/search/fork/delete, agent-origin file restoration, and unsupported terminal auth handling.

Packaged smokes require a packaged Electron output first:

```bash
cd apps/desktop
npm run electron:package:unsigned
npm run electron:app:smoke:packaged
npm run electron:sidecar:smoke:packaged
```

The packaged app smoke launches the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`. The packaged sidecar smoke locates the bundled native backend and sends a `ping` command. Both scripts default to `apps/desktop/dist-electron`, but can be pointed at another build output with:

```bash
NEVERWRITE_ELECTRON_OUTPUT_DIR=/path/to/electron-dist
NEVERWRITE_ELECTRON_DIST_ARCH=x64
```

For custom paths, use `NEVERWRITE_PACKAGED_APP_EXECUTABLE` or `NEVERWRITE_PACKAGED_SIDECAR_PATH`.

## Deep Link QA

Use this checklist when changing Electron app identity, URI registration,
deep-link dispatch, web clipper fallback behavior, vault path resolution, or
editor reveal behavior. See [Deep Links](deep-links.md) for the full contract.

Deep-link QA should use a packaged app, not a pure `npm run dev` session. On
macOS, Launch Services can keep stale `neverwrite://` registrations, so force
the exact app under test:

```bash
open -a /path/to/NeverWrite.app 'neverwrite://open?path=notes/todo.md'
```

If the wrong app opens, re-register the app:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /path/to/NeverWrite.app
```

With a known test vault open, validate successful opens:

```bash
open -a /path/to/NeverWrite.app 'neverwrite://open?path=notes/todo.md'
open -a /path/to/NeverWrite.app 'neverwrite://open?path=Daily%20Notes%2F2026-07-06.md'
open -a /path/to/NeverWrite.app 'neverwrite://open?path=projects/spec.md'
open -a /path/to/NeverWrite.app 'neverwrite:open?path=notes/todo.md'
```

Validate line reveal and range selection:

```bash
open -a /path/to/NeverWrite.app 'neverwrite://open?path=notes/todo.md#L20'
open -a /path/to/NeverWrite.app 'neverwrite://open?path=notes/todo.md#L10-L20'
open -a /path/to/NeverWrite.app 'neverwrite://open?path=projects/spec.md#L30-L45'
```

Validate absolute paths inside the vault and traversal that stays inside:

```bash
open -a /path/to/NeverWrite.app 'neverwrite://open?path=/path/to/vault/notes/todo.md'
open -a /path/to/NeverWrite.app 'neverwrite://open?path=projects/drafts/../../notes/todo.md#L5'
```

Validate blocked requests. These should show a notice and must not open
external files:

```bash
open -a /path/to/NeverWrite.app 'neverwrite://open?path=missing.md'
open -a /path/to/NeverWrite.app 'neverwrite://open?path=../secret.txt'
open -a /path/to/NeverWrite.app 'neverwrite://open?path=/etc/passwd'
```

Also verify that `neverwrite://clip` still routes to the existing web clipper
fallback flow when the extension cannot use the loopback desktop API.

## Web Clipper

The web clipper is an isolated WXT app. Do not run `npm install` here.

```bash
cd apps/web-clipper
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` expands to TypeScript validation, Vitest once, and browser builds:

```bash
pnpm run compile
pnpm run test:run
pnpm run build
```

`pnpm run build` generates WXT output and syncs unpacked artifacts into:

- `apps/web-clipper/dist/chrome-mv3/`
- `apps/web-clipper/dist/firefox-mv3/`

The extension talks to the desktop app at `http://127.0.0.1:32145/api/web-clipper`. When testing an unpacked local extension against the desktop app, start desktop with exact allowed origins:

```bash
cd apps/desktop
NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS="chrome-extension://<dev-id>,moz-extension://<dev-id>" npm run dev
```

Wildcards are intentionally unsupported. See [apps/web-clipper/README.md](../apps/web-clipper/README.md) for manual loading and deep-link notes.

## Rust Workspace

The root [Cargo workspace](../Cargo.toml) includes:

- `crates/types`
- `crates/vault`
- `crates/index`
- `crates/diff`
- `crates/ai`
- `apps/desktop/native-backend`

Run all workspace tests from the repo root:

```bash
cargo test
```

Run a single crate while iterating:

```bash
cargo test -p neverwrite-vault
```

Build the native sidecar used by Electron smoke tests:

```bash
cargo build -p neverwrite-native-backend
```

## CI Parity

The main PR workflow in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) has three jobs:

- Rust: `cargo test`
- Desktop: `npm ci`, `npm run lint`, `npm test`, `npm run electron:build`, `cargo build -p neverwrite-native-backend`, and both debug sidecar smokes
- Web Clipper: `pnpm install --frozen-lockfile` and `pnpm run check`

Packaging-sensitive changes also trigger [`.github/workflows/electron-package-smoke.yml`](../.github/workflows/electron-package-smoke.yml). That workflow builds release sidecars and packages unsigned desktop apps for macOS universal, Windows x64/ARM64, and Linux x64/ARM64. It runs packaged runtime smokes on macOS, both Windows architectures, and Linux x64; Linux ARM64 validates the packaged runtime files and Linux packages without executing them. Runtime/vendor ACP changes should be checked against this workflow because they can affect release sidecar builds even when normal unit tests pass.

Desktop release validation lives in [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml). It is release-only, tag-driven, and includes signing/notarization or platform-specific packaging assumptions that are not expected for normal local PR validation.

## Troubleshooting

- If JavaScript install/build behavior differs from CI, check Node first. CI uses Node.js 22, `apps/desktop` declares `node >=22.12.0`, and `apps/web-clipper` declares `node >=22`.
- If desktop dependency commands fail, make sure you are in `apps/desktop` and using `npm`, not `pnpm`.
- If web clipper commands fail or create the wrong lockfile, make sure you are in `apps/web-clipper` and using `pnpm`, not `npm`.
- If `electron:vault-editor:smoke` or `electron:ai-runtime:smoke` cannot find the sidecar, build it with `cargo build -p neverwrite-native-backend` from the repo root or `npm run electron:sidecar:build` from `apps/desktop`.
- If a packaged smoke cannot find an executable, confirm that `npm run electron:package:unsigned` produced output under `apps/desktop/dist-electron`, or set `NEVERWRITE_ELECTRON_OUTPUT_DIR`.
- If a packaged sidecar smoke fails after packaging changes, verify that the native backend was staged into the expected `resources/native-backend` location and has executable permissions on macOS/Linux.
- If local web clipper requests are blocked, confirm the desktop app is running, the extension is calling `127.0.0.1:32145`, and `NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS` contains the exact unpacked extension origin.

Last updated: July 6, 2026.
