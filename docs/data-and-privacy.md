# Data And Privacy

NeverWrite is local-first: vault files, hidden vault state, app preferences, logs,
and web clipper data are stored on the user's machine unless the user explicitly
sends content to an AI provider, a grammar service, a bug report, or another
external tool.

This page documents the storage locations that are visible in the current codebase
and what is safe to share when reporting bugs. It is intentionally conservative:
review any file before sharing it, and do not assume encryption unless it is
called out below.

Related implementation references:

- [App logs](app-logs.md)
- [AI session history and crash recovery](ai-session-history.md)
- [`apps/desktop/src-electron/main/appLogger.ts`](../apps/desktop/src-electron/main/appLogger.ts)
- [`apps/desktop/src-electron/main/webClipper.ts`](../apps/desktop/src-electron/main/webClipper.ts)
- [`apps/web-clipper/src/lib/storage.ts`](../apps/web-clipper/src/lib/storage.ts)
- [`crates/ai/src/persistence.rs`](../crates/ai/src/persistence.rs)
- [`crates/vault/src/pdf.rs`](../crates/vault/src/pdf.rs)

## Overview

NeverWrite stores data in three main places:

- The vault directory selected by the user.
- Electron's app data directory for logs, local app state, AI runtime setup, and
  desktop web clipper pairing state.
- The browser extension's `browser.storage.local` area for web clipper settings,
  local clip history, and its copy of the desktop pairing token.

Electron's app data directory is usually:

- Windows: `%APPDATA%\NeverWrite\`
- macOS: `~/Library/Application Support/NeverWrite/`
- Linux: `~/.config/NeverWrite/` for Electron-managed data such as logs.

The native backend normally receives Electron's `userData` path through
`NEVERWRITE_APP_DATA_DIR`, so its persisted app state is stored under the same
app data directory when launched from the desktop app. If the native backend is
run outside Electron, its fallback app data path is platform-dependent.

## Vault Data

The vault is the user's source of truth. NeverWrite reads and writes normal files
inside the selected vault, including Markdown notes, text/code files, CSV files,
PDFs, images, and `.excalidraw` concept maps.

Vault content is stored in the original file formats. It is plaintext when the
file format is plaintext, for example Markdown, CSV, JSON, source code, and
Excalidraw JSON. Binary files such as PDFs and images remain their original
binary files. NeverWrite does not add encryption to vault files.

Vault file paths, titles, tags, links, and content can be shown in the UI,
indexed for search, sent to AI providers when attached or included as context,
and written into local history or cache files described below.

## Hidden Vault State

NeverWrite uses hidden directories inside each vault for app-owned state:

```text
<vault>/.neverwrite/
<vault>/.neverwrite-cache/
```

The vault scanner intentionally ignores `.neverwrite`, `.neverwrite-cache`,
`.git`, `.obsidian`, `node_modules`, `target`, `vendor`, `.claude`, and several
other internal/tooling directories when building the visible vault tree. See
[`crates/vault/src/vault.rs`](../crates/vault/src/vault.rs).

Do not include `.neverwrite/` or `.neverwrite-cache/` in public bug reports
without reviewing them first.

## AI Session History

AI chat history is stored inside the currently open vault:

```text
<vault>/.neverwrite/sessions/session-<sha256(session_id)>/
```

Modern session directories contain:

- `session-meta.json`: metadata such as runtime, model, mode, title, timestamps,
  parent session, and message count.
- `index.json`: transcript offsets, lengths, and message hashes used for lazy
  transcript loading.
- `transcript.jsonl`: newline-delimited JSON transcript entries.
- `compact-state.json`: temporary compaction recovery state, only when needed.

The transcript is local plaintext JSONL while retained. It can contain user
prompts, AI responses, tool activity, permission requests, plans, diffs, file
paths, snippets, and metadata from attached vault files. Session directory names
hash the logical session id, but the transcript content itself is not encrypted.

Deleting a conversation from Chat History deletes its saved history from
`.neverwrite/sessions/`. Retention pruning also operates on this directory.

## App Logs

NeverWrite writes diagnostic JSONL logs under Electron's app data directory:

```text
<app-data>/logs/main.log
<app-data>/logs/renderer.log
<app-data>/logs/native-backend.log
```

Platform examples are documented in [App logs](app-logs.md). Each log line is a
JSON object with timestamp, source, level, message, and optional structured
detail. Logs rotate at about 5 MB per source, replacing the previous `.old.log`.

Log details are sanitized by key name for common sensitive fields such as
`content`, `transcript`, `prompt`, `body`, `raw`, `password`, `token`, `secret`,
`apiKey`, and `authorization`. Native backend stderr is also passed through a
secret redaction path before being written.

Logs are still diagnostic plaintext. They may include:

- Platform, app version, Electron/Node versions, process status, and timestamps.
- File paths, executable paths, vault names or paths, runtime names, provider
  ids, update URLs, and error messages.
- Stack traces or failures that can reveal local usernames or project names.

Review logs before sharing them publicly.

## Web Clipper Data

The desktop app exposes a local-only web clipper API at:

```text
http://127.0.0.1:32145/api/web-clipper
```

Requests are limited to allowed browser extension origins and require a pairing
token. The desktop pairing state is stored as plaintext JSON in:

```text
<app-data>/web_clipper_auth.json
```

That file contains the desktop token and, for Firefox, the paired extension
origin. Treat it as a secret. Do not share it in bug reports.

The browser extension stores its own state in `browser.storage.local`:

- `clipperSettings`: vault definitions and hints, selected vault, default
  folder, recent folders, recent tags, templates, and up to 50 local clip
  history entries.
- `clipperDesktopAuth`: the extension-side copy of the desktop pairing token.

Clip history entries can include the clipped Markdown, source URL, page title,
domain, metadata, folder, tags, vault id/name, and the save method. This is
plaintext in browser extension storage and may contain full page or selection
content.

When the desktop API is unavailable, the extension can use a `neverwrite://clip`
deep link. Small payloads can be embedded in the deep link. Larger payloads, or
the user preference for clipboard mode, use the system clipboard as a temporary
handoff: the extension writes the Markdown to the clipboard and the desktop app
reads it. That means clipped content can briefly be present in the system
clipboard and may be visible to clipboard managers.

## Settings And Local UI State

Desktop renderer preferences use a `safeStorage` wrapper that prefers persistent
`window.localStorage` and falls back to in-memory storage if localStorage is
blocked. In normal desktop use, these values are plaintext localStorage entries
inside Electron's profile data.

Examples include:

- `neverwrite:settings` and `neverwrite:settings:<vault-path>`: editor,
  spellcheck, grammar, developer, review, and UI preferences.
- `neverwrite:theme` and `neverwrite:theme:<vault-path>`: theme preference.
- `neverwrite:lastVaultPath` and `neverwrite:recentVaults`: recent vault paths
  and pinned/recent vault metadata.
- `neverwrite:bookmarks:<vault-path>`: vault bookmarks.
- `neverwrite.session.tabs:<vault-path>` and related chat/window keys: workspace,
  tab, detached-window, and window restore state.
- `neverwrite.ai.preferences` and per-vault AI preference keys: UI preferences
  such as auto-context and diff zoom, plus cached runtime catalog data.
- `neverwrite:window-operational-state:<label>`: temporary update-safety state
  listing dirty tab titles, pending review session titles, active agent session
  titles, and separate open windows.

These entries can reveal vault paths, file names, note titles, session titles,
UI state, and workflow context. They are not a good default for public bug
reports.

The desktop main process also mirrors a shortened recent-vault list to:

```text
<app-data>/recent_vaults.json
```

That file contains vault paths and names.

## AI Provider Secrets And Auth

NeverWrite separates AI runtime setup metadata from secret values.

Runtime setup metadata is stored under app data:

```text
<app-data>/ai/runtime-setup.json
```

The setup file can include non-secret values such as custom runtime binary paths,
auth method selection, gateway/base URLs, cloud project/location values, and a
list of which secret environment keys are configured. On Unix-like systems the
file is written with owner-only permissions when possible.

API keys and secret headers for supported runtimes are stored through the OS
credential store using the service name:

```text
NeverWrite AI Provider Secrets
```

Secret account names are runtime/key pairs such as `codex:OPENAI_API_KEY` or
`claude:ANTHROPIC_API_KEY`. Supported secret env keys include `CODEX_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_CUSTOM_HEADERS`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and
`KILO_API_KEY`.

Do not share `runtime-setup.json` without reviewing it: even when secret values
are not stored there, it can reveal private endpoint URLs, local binary paths,
project ids, and which credentials are configured.

Some provider login methods use provider-owned CLI authentication outside
NeverWrite's app data directory. For example, a runtime CLI may keep its own
tokens or config in that provider's standard location. NeverWrite cannot
guarantee or document those third-party storage formats here.

## Caches And Derived Data

NeverWrite stores derived cache data that can still contain source content.

PDF text extraction cache:

```text
<vault>/.neverwrite-cache/pdf/<cache-key>.json
```

Each PDF cache entry stores the PDF relative path, modified time, size, page
count, and extracted page text. It is plaintext JSON and may contain sensitive
PDF text.

Spellcheck data:

```text
<app-data>/spellcheck/
<app-data>/spellcheck/packs/
<app-data>/spellcheck/user/
<app-data>/spellcheck/cache/
```

Installed dictionary packs and user dictionary words are stored under app data.
User dictionary files can reveal custom words, names, project terms, or domain
terminology.

Development/build artifacts such as `node_modules/`, `target/`, extension
`dist/`, logs from package managers, and test output are not user data by design,
but they may contain local paths or generated copies of source files. They are
not needed for normal bug reports unless a maintainer asks for them.

## Release And Update State

The updater code keeps update status in memory and uses `electron-updater` for
platform-specific download/install behavior. NeverWrite's update safety check
does write temporary plaintext localStorage entries named
`neverwrite:window-operational-state:<label>` so it can warn before installing
while there are unsaved tabs, pending review changes, active agent sessions, or
separate operational windows.

Those entries contain titles and status labels, not full document contents, but
they can still reveal sensitive file or chat names.

## Bug Report Checklist

Usually safe to share:

- NeverWrite version, operating system, architecture, and whether the app is
  packaged or running from development.
- A short description of the action that failed and the expected behavior.
- Screenshots with private note content, file paths, and tokens hidden.
- Minimal sample vaults created only for reproduction.
- Redacted snippets from `main.log`, `renderer.log`, or `native-backend.log`
  around the time of the failure.
- Error messages after checking that they do not include private paths, note
  text, tokens, or provider output.

Review and redact before sharing:

- Any file under `<vault>/.neverwrite/sessions/`.
- Any file under `<vault>/.neverwrite-cache/`.
- App logs under `<app-data>/logs/`.
- `recent_vaults.json`.
- Browser extension `clipperSettings` export or screenshots.
- LocalStorage values whose keys start with `neverwrite:`,
  `neverwrite.`, or `neverwrite.ai.`.
- `runtime-setup.json`, especially gateway URLs, project ids, custom headers,
  custom binary paths, and local usernames.
- Screenshots of AI review panels, inline diffs, chat transcripts, terminal
  output, graph/search results, or file trees.

Never share without deliberate review:

- `<app-data>/web_clipper_auth.json`.
- `clipperDesktopAuth` from browser extension storage.
- API keys, auth tokens, custom auth headers, cookies, bearer tokens, or
  provider CLI config files.
- Full vault archives, full `.neverwrite/sessions/` directories, or full
  `.neverwrite-cache/` directories.
- System clipboard contents captured during a web clipper clipboard handoff.
- Private PDFs, extracted PDF cache files, or generated transcripts.

## Redaction Guidance

When preparing a bug report:

1. Reproduce the issue in a small test vault if possible.
2. Copy only the few relevant log lines, not the whole log directory.
3. Replace local usernames and vault paths with placeholders such as
   `/Users/alex/Vault` or `C:\Users\Alex\Vault`.
4. Replace note text, prompts, transcripts, URLs with tokens, and provider
   responses with short placeholders like `[private note content]`.
5. Remove `x-neverwrite-clipper-token`, `authorization`, `apiKey`, `token`,
   `secret`, `password`, and custom header values.
6. If an AI change-control bug depends on a diff, reduce it to a synthetic file
   and synthetic edit whenever possible.

For maintainer-requested private diagnostics, prefer a minimal zip containing
only the requested files. Do not include the whole vault or app data directory
unless the maintainer explicitly explains why it is needed and you have reviewed
the contents.

## Known Limits

- Vault files and AI transcripts are not encrypted by NeverWrite.
- Hidden vault directories are local-only by design, but they will be copied by
  backups, sync tools, and manual zip/archive operations unless excluded.
- Log sanitization is best-effort and key-based. It reduces accidental leakage
  but cannot prove that every string is non-sensitive.
- Browser extension storage and Electron localStorage are plaintext from the
  application's perspective and follow browser/Electron profile behavior.
- OS credential storage security depends on the operating system keychain,
  credential manager, or secret service available on the user's machine.
- Third-party AI runtime CLIs can store their own auth state outside NeverWrite.
  Check that provider's documentation before sharing provider config folders.

Last updated: May 11, 2026.
