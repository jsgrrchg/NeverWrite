# VaultAI Web Clipper

This package is an isolated browser-extension project inside the VaultAI monorepo.

## Development

```bash
cd apps/web-clipper
pnpm install
pnpm dev
```

## Validation

```bash
cd apps/web-clipper
pnpm check
```

`pnpm check` runs TypeScript validation, unit tests, and browser builds before syncing the unpacked artifacts into `dist/`.

## Build

```bash
cd apps/web-clipper
pnpm build
```

`pnpm build` generates WXT output under `.output/` and then copies the unpacked browser bundles into:

- `dist/chrome-mv3/`
- `dist/firefox-mv3/`

## Unit Tests

```bash
cd apps/web-clipper
pnpm test:run
```

Current coverage focuses on:

- extractor metadata/content fallbacks with realistic HTML fixtures
- selected text extraction behavior
- deep link bridge mode switching between inline and clipboard
- local preference helpers for folders, tags, and recent usage

## Manual Loading

Chrome:

```text
chrome://extensions -> Developer mode -> Load unpacked -> apps/web-clipper/dist/chrome-mv3
```

Firefox:

```text
about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> apps/web-clipper/dist/firefox-mv3/manifest.json
```

## Shortcuts

- Toolbar click opens the dedicated clip window.
- Context menu entry: `Save to VaultAI`
- Context menu entry: `Open VaultAI Side Panel`
- Keyboard shortcut: `Ctrl+Shift+S` on Windows/Linux, `Command+Shift+S` on macOS

## Phase 3 Features

- Templates support variables such as `{{title}}`, `{{url}}`, `{{content}}`, `{{tags}}`, and `{{folder}}`.
- Custom templates can be scoped per vault and/or per domain from the Settings view.
- The clipper keeps a local clip history with rendered previews and a `Use again` action.
- Chrome builds expose a side panel mode. Firefox MV3 builds skip the side panel entrypoint.

## Desktop API

When VaultAI desktop is running, the extension also tries a direct local integration first:

- Base URL: `http://127.0.0.1:32145/api/web-clipper`
- Endpoints used by the extension:
  - `GET /health`
  - `GET /themes`
  - `POST /folders`
  - `POST /tags`
  - `POST /clips`

This local API is used to:

- autocomplete folders and tags from the real vault state
- save clips directly into the desktop app with explicit success/error feedback
- open the created note in the editor and show a desktop toast on success

If the local API is unavailable, the extension falls back to the deep-link handoff flow.
