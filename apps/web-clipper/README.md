# NeverWrite Web Clipper

This package is an isolated browser-extension project inside the NeverWrite monorepo.

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

## GitHub Release Install

Chrome:

Download `NeverWrite-Web-Clipper-vX.Y.Z-chrome-mv3.zip` from the GitHub Release, unzip it, then open `chrome://extensions`, enable Developer mode, and choose `Load unpacked`.

Firefox:

`NeverWrite-Web-Clipper-vX.Y.Z-firefox-mv3.zip` is attached as a Firefox MV3 build artifact for testing and release traceability. Normal Firefox Release/Beta installation requires a Mozilla-signed package through AMO or self-distribution signing.

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

When developing against the local desktop API, unpacked extension origins are blocked by default.
To authorize a local unpacked build explicitly, launch the desktop app with:

```bash
cd apps/desktop
NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS="chrome-extension://<dev-id>,moz-extension://<dev-id>" npm run dev
```

Use exact origins only. Wildcards are intentionally unsupported.

## Shortcuts

- Toolbar click opens the dedicated clip window.
- Context menu entry: `Save to NeverWrite`
- Context menu entry: `Open NeverWrite Side Panel`
- Keyboard shortcut: `Ctrl+Shift+S` on Windows/Linux, `Command+Shift+S` on macOS

## Current Features

- Templates support variables such as `{{title}}`, `{{url}}`, `{{content}}`, `{{tags}}`, and `{{folder}}`.
- Custom templates can be scoped per vault and/or per domain from the Settings view.
- The clipper keeps a local clip history with rendered previews and a `Use again` action.
- Chrome builds expose a side panel mode. Firefox MV3 builds skip the side panel entrypoint.

## Desktop API

When NeverWrite desktop is running, the extension also tries a direct local integration first:

- Base URL: `http://127.0.0.1:32145/api/web-clipper`
- Endpoints used by the extension:
  - `POST /pair`
  - `GET /health`
  - `GET /themes`
  - `POST /folders`
  - `POST /tags`
  - `POST /clips`

This local API is used to:

- autocomplete folders and tags from the real vault state
- save clips directly into the desktop app with explicit success/error feedback
- open the created note in the editor and show a desktop toast on success

On first successful contact, the clipper pairs with the desktop app through
`POST /pair` and stores a local token in `browser.storage.local`. Subsequent
requests must send both the extension identity and that token.

If the local API is unavailable, the extension falls back to the deep-link handoff flow.

On macOS, that deep-link fallback only works with an installed NeverWrite app bundle
that has the `neverwrite://` scheme registered.
`npm run dev` does not register custom URI schemes with the OS, so the
browser fallback cannot be validated end-to-end against a pure dev session there.
