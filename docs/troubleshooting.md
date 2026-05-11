# Troubleshooting

This guide is for power users and contributors diagnosing NeverWrite desktop,
native backend, AI runtime, vault, web clipper, and update issues. Prefer
checking the logs first, then narrow the failure to one boundary: Electron main,
renderer, native sidecar, provider runtime, vault filesystem, browser extension,
or updater.

Related references:

- [App logs](app-logs.md)
- [AI runtime setup](ai-runtime-setup.md)
- [AI session history and crash recovery](ai-session-history.md)
- [Data and privacy](data-and-privacy.md)
- [Testing and validation](testing.md)
- [`apps/desktop/src-electron/main/nativeBackend.ts`](../apps/desktop/src-electron/main/nativeBackend.ts)
- [`apps/desktop/native-backend/src/ai.rs`](../apps/desktop/native-backend/src/ai.rs)
- [`apps/desktop/src-electron/main/webClipper.ts`](../apps/desktop/src-electron/main/webClipper.ts)

## Start Here

1. Reproduce once with the smallest case possible: a fresh app start, one vault,
   one provider, or one clip.
2. Check the app logs listed in [App logs](app-logs.md). Look at `main.log`
   first for startup, window, updater, and IPC failures; `native-backend.log`
   for sidecar, vault, provider, and stderr failures; and `renderer.log` for UI
   errors.
3. Identify whether the failure happens before a vault opens, while opening a
   vault, after an AI provider is selected, or from the browser extension.
4. If the issue involves secrets, transcripts, clipped content, or vault files,
   review [Data and privacy](data-and-privacy.md) before sharing artifacts.
5. Do not delete `.neverwrite/`, `.neverwrite-cache/`, app data, or browser
   extension storage until you have copied the relevant logs and know which
   state you are trying to reset.

## Logs

NeverWrite writes JSONL logs under Electron's app data directory:

```text
Windows: %APPDATA%\NeverWrite\logs\
macOS: ~/Library/Application Support/NeverWrite/logs/
Linux: ~/.config/NeverWrite/logs/
```

The main files are:

- `main.log`: Electron startup, process diagnostics, windows, IPC, updater, and
  web clipper server errors.
- `renderer.log`: renderer warnings/errors and debug scopes.
- `native-backend.log`: native sidecar startup, stderr, malformed messages, and
  sidecar exits.

Logs rotate at about 5 MB per source, replacing the previous `.old.log`. Logs
redact common secret/transcript keys, but they can still contain paths, provider
ids, runtime commands, update URLs, stack traces, and local usernames.

## App Startup, Crash, Or Freeze

If the app does not open:

- Check `main.log` for `Uncaught exception`, `Unhandled promise rejection`, or
  early Electron errors.
- On Windows, also check Reliability Monitor (`perfmon /rel`) and Event Viewer
  (`Windows Logs` -> `Application`) for `NeverWrite.exe` or
  `neverwrite-native-backend.exe`.
- If this is a packaged app, verify the installed app bundle/resources are not
  partially removed by an antivirus, quarantine tool, or failed update.
- If this is development, run from `apps/desktop` with Node 22+:

```bash
cd apps/desktop
npm install
npm run dev
```

If the renderer freezes after opening:

- Check whether the issue is vault-specific by opening a tiny test vault.
- If the freeze follows use of the 3D graph on a large vault, restart the app;
  the README currently calls out known memory pressure in that area.
- Preserve logs before force-quitting so startup/open-state messages are not
  lost behind a later run.

## Native Backend

The Electron main process launches the Rust sidecar named
`neverwrite-native-backend` (`.exe` on Windows). If no sidecar is found, the
main process logs `No sidecar executable found` and user-facing requests can
fail with:

```text
Native backend is unavailable. Expected sidecar at: <path>. Rebuild or reinstall NeverWrite.
```

Diagnostic checks:

- In `native-backend.log`, look for `Starting native backend sidecar`, the
  resolved executable path, `Native backend failed to start`, or
  `Native backend exited with ...`.
- In packaged builds, the sidecar is expected under app resources in
  `native-backend/`.
- In development, Electron searches common `target/debug` and `target/release`
  locations relative to the desktop app and workspace.
- To force a local sidecar during development, launch the desktop app with
  `NEVERWRITE_NATIVE_BACKEND_PATH=/absolute/path/to/neverwrite-native-backend`.
- To force sidecar selection in development, use
  `NEVERWRITE_ELECTRON_BACKEND=sidecar` or set
  `NEVERWRITE_NATIVE_BACKEND_PATH`.
- `NEVERWRITE_ELECTRON_STRICT_SIDECAR=true` is useful with an explicitly
  requested sidecar when you want unsupported vault/editor commands to fail
  instead of falling back to the temporary Node backend.

Useful validation:

```bash
cargo build -p neverwrite-native-backend
```

```bash
cd apps/desktop
npm run electron:sidecar:build
npm run electron:vault-editor:smoke
```

## AI Providers And Runtime Setup

Open Settings -> AI Providers -> Diagnostics first. The important fields are
separate:

- `binaryReady=false`: NeverWrite could not resolve the runtime executable.
- `authReady=false`: the runtime exists, but auth is not configured or detected.
- `onboardingRequired=true`: at least one of binary/auth readiness is missing.

Runtime command resolution is documented in [AI runtime setup](ai-runtime-setup.md).
For local troubleshooting, the most useful overrides are:

```text
NEVERWRITE_CODEX_ACP_BIN
NEVERWRITE_CLAUDE_ACP_BIN
NEVERWRITE_GEMINI_ACP_BIN
NEVERWRITE_KILO_ACP_BIN
```

Important packaging expectations:

- Codex is intended to be bundled as a sidecar runtime in release builds.
- Claude is intended to be bundled through embedded Node plus vendored runtime
  files.
- Gemini and Kilo are integrated but not bundled by default, so they need an
  external CLI or explicit binary override.

If a provider works in your terminal but not in the app:

- Compare the Diagnostics PATH/command output with your shell. GUI-launched apps
  often inherit a different PATH.
- Prefer an absolute `NEVERWRITE_*_ACP_BIN` override while isolating the issue.
- Check `native-backend.log` for provider stderr or `Failed to start ACP runtime`.
- If secure credential storage fails, the backend can report:

```text
Secure credential storage is unavailable. Reconnect this AI provider or configure an environment variable before starting a session.
```

For terminal auth issues:

- Integrated terminal auth applies to Claude, Gemini, and Kilo. Codex ChatGPT
  auth does not use the integrated auth terminal.
- Confirm the terminal process exits successfully. For Gemini, successful auth
  output can mark the provider verified before exit.
- If the auth terminal cannot start, check whether the configured runtime command
  exists and whether the requested working directory exists.
- Reopen Diagnostics after auth; setup status is the source of truth.

Useful validation:

```bash
cd apps/desktop
npm run electron:sidecar:build
npm run electron:ai-runtime:smoke
```

```bash
cargo test -p neverwrite-native-backend ai
```

## Web Clipper

The web clipper talks to the desktop app at:

```text
http://127.0.0.1:32145/api/web-clipper
```

The desktop app starts a local HTTP server on loopback only. Extension requests
must include an allowed extension identity and a pairing token. The desktop
pairing state is stored in app data as:

```text
web_clipper_auth.json
```

Treat that file as a secret.

If the clipper cannot connect:

- Confirm the desktop app is running and a vault is fully open. `/health` can
  return that NeverWrite is running but no vault is ready.
- Check `main.log` for `[web-clipper-api]` errors. A port conflict on `32145`
  or a startup error will appear there.
- For local unpacked extension builds, launch desktop with exact origins:

```bash
cd apps/desktop
NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS="chrome-extension://<dev-id>,moz-extension://<dev-id>" npm run dev
```

- Wildcards are intentionally unsupported. The origin must be the exact unpacked
  extension origin.
- If pairing keeps failing, clear the extension-side stored token and pair again.
  For Firefox, the desktop token is tied to the paired Firefox extension origin.
- If saving fails after connection succeeds, inspect the response message; common
  boundaries are empty clip content, no ready vault, a vault hint that does not
  match an open vault, or a filesystem write error.

Use the web clipper package commands from `apps/web-clipper` with `pnpm`, not
`npm`:

```bash
cd apps/web-clipper
pnpm install --frozen-lockfile
pnpm run check
```

## Custom URI And Deep Links

When the desktop API is unavailable, the extension can fall back to
`neverwrite://clip` deep links. Current limitations:

- Deep links require the installed app to have registered the `neverwrite://`
  scheme with the OS.
- On macOS, `npm run dev` does not register custom URI schemes, so browser
  fallback cannot be validated end-to-end against a pure dev session there.
- The desktop handler only supports `neverwrite://clip` with required
  `requestId`, `title`, `folder`, and `mode` parameters.
- Supported modes are `inline` and `clipboard`.
- Clipboard mode uses the system clipboard as a temporary handoff, so clipped
  content may briefly be visible to clipboard managers.

Prefer the direct desktop API while debugging save behavior; use deep links only
to isolate fallback and OS registration issues.

## Vault Opening, Indexing, And Filesystem Issues

Vault open state moves through `scanning`, `parsing`, `indexing`,
`saving_snapshot`, and `ready`, or ends as `error`/`cancelled`. If opening is
slow or stuck:

- Watch the open-state UI and check `native-backend.log` for sidecar errors.
- Try a tiny vault to separate app startup problems from vault content problems.
- Check whether the vault is on a network drive, cloud-sync folder, external
  disk, or path with restrictive permissions.
- Confirm the app can read the vault and write hidden app-owned state under the
  vault.
- Avoid placing the vault inside directories that are already ignored or heavy
  tooling folders, such as `.git`, `.obsidian`, `node_modules`, `target`,
  `vendor`, `.claude`, `.neverwrite`, or `.neverwrite-cache`.

Hidden vault state:

```text
<vault>/.neverwrite/
<vault>/.neverwrite-cache/
```

Chat recovery uses `.neverwrite/sessions/`. Derived cache data may live under
`.neverwrite-cache/`. Do not delete these directories as a first step; rename or
copy them only when you intentionally want to test whether hidden state is the
trigger.

If a vault appears corrupt or a file cannot be opened/saved:

- Verify the same file can be read/written outside NeverWrite.
- Check for path traversal-like names, backslashes in relative paths, null bytes,
  invalid filename characters for the platform, or case-only renames on
  case-insensitive filesystems.
- Look for permission errors in `native-backend.log`.
- If the issue involves a specific file type, include the file extension and
  whether it is Markdown, CSV, PDF, image, text/code, or `.excalidraw`.

## AI Session History And Recovery

AI chat history is local to the currently open vault:

```text
<vault>/.neverwrite/sessions/session-<sha256(session_id)>/
```

Modern session directories contain `session-meta.json`, `index.json`, and
`transcript.jsonl`. See [AI session history and crash recovery](ai-session-history.md)
for the disk layout and recovery flow.

If a session does not recover:

- Reopen the same vault first. Session history is per-vault.
- Open `Chat History`, select the saved conversation, and click `Restore`.
- Check whether retention settings or manual deletion removed the conversation.
- Confirm `.neverwrite/sessions/` exists and is readable.
- If the UI shows `The AI runtime lost its connection. Reconnecting with saved
  context...`, wait for the reconnect attempt before sending a new message.
- If reconnecting fails with `Could not reconnect this chat. Start a new session
  with saved transcript context?`, restore or fork the saved conversation and
  continue from stored transcript context.
- If history writes fail, look for vault write/permission errors in
  `native-backend.log`.

Do not share `transcript.jsonl` publicly without reviewing it; it is plaintext
and can include prompts, AI responses, tool activity, file paths, snippets, and
attached context.

## Updates Blocked By Pending State

NeverWrite blocks or asks for confirmation around updates when live windows have
sensitive operational state. The current blockers are collected from renderer
state in [`sensitiveState.ts`](../apps/desktop/src/features/updates/sensitiveState.ts):

- Unsaved editor tabs.
- Pending inline review or agent changes.
- Active agent sessions, including streaming, permission, or user-input waits.
- Separate operational windows, including detached note windows and separate
  vault windows.

If an update is blocked:

- Save or close dirty tabs.
- Accept/reject pending review changes before updating.
- Stop or finish active AI sessions.
- Close detached note windows and separate vault windows.
- Retry the update after the window state settles for a moment.

Updater configuration and network failures appear in `main.log`. Production
updater endpoints must be HTTPS and are host-restricted by default. Non-production
endpoints must stay local unless explicitly overridden for validation.

## Bug Reports

Include enough detail to reproduce without sharing secrets:

- NeverWrite version, platform, CPU architecture, and whether it is packaged or
  `npm run dev`.
- The exact action sequence and the smallest vault/provider/clip that reproduces
  the problem.
- Relevant excerpts from `main.log`, `renderer.log`, and `native-backend.log`.
- For sidecar issues: sidecar path, whether `NEVERWRITE_NATIVE_BACKEND_PATH` was
  set, and the sidecar exit/error message.
- For AI issues: runtime id, setup `binaryReady`/`authReady` status, resolution
  source, auth method, and whether an override such as `NEVERWRITE_*_ACP_BIN`
  was used.
- For web clipper issues: browser, extension origin, whether the extension is
  official or unpacked, whether desktop was started with
  `NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS`, and the API response message.
- For vault issues: vault location type, failing relative path, file extension,
  and whether the file can be read/written outside NeverWrite.

Do not share API keys, provider tokens, `web_clipper_auth.json`, OS keychain
exports, full `.neverwrite/sessions/` transcripts, or complete vault contents
unless you have reviewed and intentionally sanitized them.

## Validation Commands

Use the narrowest command that matches the suspected boundary:

```bash
# Rust workspace
cargo test
```

```bash
# Native backend build
cargo build -p neverwrite-native-backend
```

```bash
# Desktop tests and build
cd apps/desktop
npm run lint
npm test
npm run build
```

```bash
# Electron sidecar and vault smoke
cd apps/desktop
npm run electron:sidecar:build
npm run electron:vault-editor:smoke
```

```bash
# AI runtime sidecar smoke
cd apps/desktop
npm run electron:sidecar:build
npm run electron:ai-runtime:smoke
```

```bash
# Web clipper validation
cd apps/web-clipper
pnpm install --frozen-lockfile
pnpm run check
```

```bash
# Packaged app smoke path
cd apps/desktop
npm run electron:package:unsigned
npm run electron:app:smoke:packaged
npm run electron:sidecar:smoke:packaged
```

Documentation-only changes do not require code validation in CI, but command
examples should still match [Testing and validation](testing.md).

Last updated: May 11, 2026.
