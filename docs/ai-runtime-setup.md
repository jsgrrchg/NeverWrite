# AI Runtime Setup

NeverWrite talks to AI providers through ACP runtimes. The desktop renderer does
not launch provider CLIs directly; it calls the native backend through the
allowlisted `ai_*` commands in
[`apps/desktop/src-electron/main/nativeBackend.ts`](../apps/desktop/src-electron/main/nativeBackend.ts).
The backend owns runtime discovery, authentication state, environment injection,
session startup, and logout in
[`apps/desktop/native-backend/src/ai.rs`](../apps/desktop/native-backend/src/ai.rs).

The user-facing provider setup UI lives in
[`apps/desktop/src/features/settings/AIProvidersSettings.tsx`](../apps/desktop/src/features/settings/AIProvidersSettings.tsx).
The static fallback catalog is in
[`runtimeMetadata.ts`](../apps/desktop/src/features/ai/utils/runtimeMetadata.ts),
and terminal-auth routing helpers are in
[`authMethods.ts`](../apps/desktop/src/features/ai/utils/authMethods.ts).

## Provider Matrix

| Runtime id | Runtime command | Bundled in release | Auth methods exposed by NeverWrite |
| --- | --- | --- | --- |
| `codex-acp` | `codex-acp` | Yes. Staged as a sidecar binary. | ChatGPT account, OpenAI API key, Codex API key |
| `claude-acp` | Claude ACP adapter | Yes. Staged as vendored JS plus embedded Node. | Claude subscription terminal login, Anthropic Console terminal login, Anthropic API key, custom Anthropic-compatible gateway |
| `gemini-acp` | `gemini --acp` | No. Must be available from PATH or a configured binary override. | Google terminal login, Gemini API key |
| `grok-acp` | `grok --no-auto-update agent stdio` | No. Must be available from PATH or a configured binary override. | Grok terminal login, xAI API key |
| `kilo-acp` | `kilo acp` | No. Must be available from PATH or a configured binary override. | Kilo terminal login |
| `opencode-acp` | `opencode acp` | No. Must be available from PATH or a configured binary override. | OpenCode terminal login |

NeverWrite currently supports two ACP compatibility paths:

- `Current14`: Claude, Codex, Kilo, and OpenCode use the current ACP session
  config path.
- `Legacy12`: Gemini and Grok use the legacy ACP model/mode path.

For current ACP runtimes, model, mode, and reasoning selectors are derived from
ACP `config_options` and updated through `session/set_config_option` when the
runtime supports it. For Gemini and Grok, NeverWrite keeps using legacy
`models` / `modes` descriptors plus `session/set_model` / `session/set_mode`
instead. Gemini and Grok do not receive a synthetic `Auto` model when their
runtime does not expose real model options; in that case the model selector is
hidden.

Providers only show modes and slash commands that are either declared by ACP or
kept as provider-owned fallback behavior. Grok does not receive synthetic
`default` / `review` modes or hardcoded slash commands when its ACP runtime does
not advertise them. The frontend falls back to the static catalog if backend
inventory cannot be loaded.

## Runtime Discovery

For every provider, the backend resolves the runtime command in this order:

1. Provider-specific `NEVERWRITE_*_ACP_BIN` environment override.
2. Custom binary path saved through the backend setup payload.
3. Packaged release resources, when available.
4. Development vendor fallback for Codex and Claude.
5. A command found on the app process `PATH`.
6. macOS Homebrew fallback paths for Grok and OpenCode.

The provider-specific runtime binary overrides are:

| Variable | Provider |
| --- | --- |
| `NEVERWRITE_CODEX_ACP_BIN` | Codex |
| `NEVERWRITE_CLAUDE_ACP_BIN` | Claude |
| `NEVERWRITE_GEMINI_ACP_BIN` | Gemini |
| `NEVERWRITE_GROK_ACP_BIN` | Grok |
| `NEVERWRITE_KILO_ACP_BIN` | Kilo |
| `NEVERWRITE_OPENCODE_ACP_BIN` | OpenCode |

The values may be absolute paths or command names resolvable on `PATH`. For
Gemini, Grok, Kilo, and OpenCode, NeverWrite appends the ACP arguments automatically:
`gemini --acp`, `grok --no-auto-update agent stdio`, `kilo acp`, and
`opencode acp`.

Packaged builds use `NEVERWRITE_ELECTRON_ACP_RESOURCE_DIR` internally to point
the native backend at staged Electron resources. In normal app usage this is set
by the Electron main process, not by users.

## Authentication Methods

Provider setup state is stored under the app data directory as
`ai/runtime-setup.json`. Secret values are not kept in that JSON file in normal
production use; they are stored through the OS keyring service named
`NeverWrite AI Provider Secrets`. The JSON file tracks non-secret environment
values, selected auth method, custom binary path when one has been supplied by
an internal setup flow, and which secret keys belong to a runtime.

The backend also detects existing CLI auth files and environment secrets:

| Provider | Existing auth detection |
| --- | --- |
| Codex | `CODEX_API_KEY`, `OPENAI_API_KEY`, or non-empty `~/.codex/auth.json` |
| Claude | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`, or non-empty `~/.claude.json` |
| Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or non-empty `~/.gemini/oauth_creds.json` |
| Grok | `XAI_API_KEY` or active non-empty Grok CLI auth under `~/.grok/`, currently `~/.grok/auth.json` |
| Kilo | Non-empty Kilo auth file, including `~/.local/share/kilo/auth.json` on Unix-like systems |
| OpenCode | `OPENCODE_API_KEY`, provider keys inherited by OpenCode, or active `opencode/auth.json` in the platform data directory |

Codex ChatGPT auth is implemented through the ACP `authenticate` request and
requires a resolved Codex runtime binary before NeverWrite marks it connected.
Codex does not use the integrated auth terminal.

Claude, Gemini, Grok, Kilo, and OpenCode expose integrated terminal auth methods.
NeverWrite starts the provider CLI in a PTY and marks auth pending before
launch. A zero exit code marks the provider verified; Gemini and OpenCode can
also be marked verified when terminal output contains success strings recognized
by the backend. Grok is marked verified when `grok login` exits successfully or
prints recognized success output.

Claude adapts its visible terminal login methods to the environment. In remote
or no-browser environments (`NO_BROWSER`, `SSH_CONNECTION`, `SSH_CLIENT`,
`SSH_TTY`, or `CLAUDE_CODE_REMOTE`), the setup UI exposes `claude-login` instead
of the local `claude-ai-login` / `console-login` split.

## Provider-Specific Setup

### Codex

Use one of:

- ChatGPT account sign-in from the provider setup UI.
- An OpenAI API key saved in the setup UI, stored as `OPENAI_API_KEY` for this runtime.
- A Codex API key saved in the setup UI, stored as `CODEX_API_KEY` for this runtime.
- Existing CLI auth in `~/.codex/auth.json`.
- Process environment `OPENAI_API_KEY` or `CODEX_API_KEY`.

In releases, `codex-acp` is expected to be bundled under
`native-backend/binaries/`. In development, build or point to a local runtime if
the vendor fallback is not present.

### Claude

Use one of:

- Claude subscription terminal login.
- Anthropic Console terminal login.
- Anthropic API key saved in the setup UI, stored as `ANTHROPIC_API_KEY`.
- Custom Anthropic-compatible gateway.
- Custom Bedrock-compatible gateway.
- Existing CLI auth in `~/.claude.json`.
- Process environment `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, or `ANTHROPIC_BEDROCK_BASE_URL`.

Gateway setup accepts a base URL, optional headers, and an optional auth token.
Gateway URLs must be HTTPS unless the host is loopback (`localhost`, a
`.localhost` name, `127.0.0.0/8`, or `::1`). URLs with embedded credentials are
rejected by both frontend validation and backend validation. Gateway headers are
stored as `ANTHROPIC_CUSTOM_HEADERS`, the token as `ANTHROPIC_AUTH_TOKEN`, and
the base URL as `ANTHROPIC_BASE_URL`.

Bedrock gateway setup uses the same URL and headers validation, stores the base
URL as `ANTHROPIC_BEDROCK_BASE_URL`, and sets `CLAUDE_CODE_USE_BEDROCK=1` when
launching the Claude runtime. Bedrock gateway setup does not use an Anthropic
auth token.

### Gemini

Use one of:

- Google terminal login from the setup UI.
- Gemini Developer API key saved in the setup UI, stored as `GEMINI_API_KEY`.
- Existing OAuth credentials in `~/.gemini/oauth_creds.json`.
- Process environment `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

NeverWrite sets `GEMINI_DEFAULT_AUTH_TYPE` when launching Gemini for known
methods: `oauth-personal` for Google login and `gemini-api-key` for API-key
auth. `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are supported in the
backend setup payload, but the current provider settings UI does not expose
fields for them.

NeverWrite launches Gemini as `gemini --acp`, but handles it internally through
the legacy ACP compatibility path. Gemini model and mode changes use
`session/set_model` and `session/set_mode`, not `session/set_config_option`.
If Gemini does not advertise real model options, NeverWrite does not invent an
`Auto` model and the chat composer has no model selector.

Gemini can emit internal `update_topic` activity for provider-owned chat topic
metadata. NeverWrite filters that activity from the visible timeline because it
is not assistant reasoning, user-facing tool work, or a reviewable change.

### Grok

Use one of:

- Grok terminal login from the setup UI, exposed as `grok-login`.
- xAI API key saved in the setup UI, exposed as `xai-api-key` and stored as `XAI_API_KEY`.
- Existing Grok CLI auth under `~/.grok/`, currently `~/.grok/auth.json`.
- Process environment `XAI_API_KEY`.

Because Grok is not bundled by default, install the Grok CLI separately or
configure `NEVERWRITE_GROK_ACP_BIN`. NeverWrite launches sessions as
`grok --no-auto-update agent stdio` and opens terminal auth as `grok login`.

Grok requires ACP authentication inside the same runtime process that opens the
session. Before `session/new`, NeverWrite sends `authenticate` with
`xai.api_key` for API-key auth and `cached_token` for Grok CLI login auth. If
the running Grok ACP process does not advertise the selected method during
`initialize`, setup remains local but session startup fails with an explicit
auth-method error.

Saved xAI API keys live in the OS keyring as `XAI_API_KEY`; they are not written
to `ai/runtime-setup.json`. The JSON setup file only records the selected auth
method and secret-key marker. If the app process inherits `XAI_API_KEY`, that
environment value is preferred by default. A locally saved xAI key that is
selected and ready is passed to the Grok ACP process explicitly, so it can
recover from an inherited `XAI_API_KEY` that NeverWrite has marked invalid.
NeverWrite does not delete or overwrite the inherited environment variable.

Grok uses the legacy ACP compatibility path for model and mode changes:
NeverWrite reads legacy `models` / `modes` descriptors and sends
`session/set_model` / `session/set_mode` instead of
`session/set_config_option`. If the Grok runtime does not expose real model
options, NeverWrite does not synthesize an `Auto` model.

Some Grok models map to different provider-side `agentType` values. Once a chat
has started, switching to a model that requires a different `agentType` is
blocked because the Grok ACP runtime requires a fresh session for that change.
Start a new chat with the desired model instead.

Disconnecting Grok in NeverWrite clears local NeverWrite setup state. For stored
xAI API keys, it also deletes the local keyring secret. For Grok CLI login, it
records a local invalidation marker so stale `~/.grok/auth.json` credentials are
not immediately rehydrated, but it does not remotely log out of Grok or delete
Grok's CLI auth files. Use the Grok CLI, or remove its auth file yourself, when
you need a full remote/provider logout.

### Kilo

Use Kilo terminal login from the setup UI, a Kilo API key saved in the setup UI,
or pre-existing Kilo CLI auth. Because Kilo is not bundled by default, install
the CLI separately or configure `NEVERWRITE_KILO_ACP_BIN`.

### OpenCode

Use OpenCode terminal login from the setup UI, pre-existing OpenCode CLI auth, a
provider key inherited by the OpenCode CLI, or `/connect` inside OpenCode.
The current UI keeps OpenCode auth primarily owned by the OpenCode CLI rather
than exposing a first-party API key form. Disconnecting OpenCode clears
NeverWrite's local selection and persists an invalidation marker, but it does
not delete `opencode/auth.json`.

Because OpenCode is not bundled by default, install the CLI separately or
configure `NEVERWRITE_OPENCODE_ACP_BIN`. NeverWrite launches sessions as
`opencode acp` and opens auth as `opencode auth login`.

## Environment Overrides

These `NEVERWRITE_*` variables are relevant to AI runtime setup and packaging:

| Variable | Use |
| --- | --- |
| `NEVERWRITE_CODEX_ACP_BIN` | Runtime launch override for Codex in dev or local troubleshooting. |
| `NEVERWRITE_CLAUDE_ACP_BIN` | Runtime launch override for Claude in dev or local troubleshooting. |
| `NEVERWRITE_GEMINI_ACP_BIN` | Runtime launch override for Gemini in dev or local troubleshooting. |
| `NEVERWRITE_GROK_ACP_BIN` | Runtime launch override for Grok in dev or local troubleshooting. |
| `NEVERWRITE_KILO_ACP_BIN` | Runtime launch override for Kilo in dev or local troubleshooting. |
| `NEVERWRITE_OPENCODE_ACP_BIN` | Runtime launch override for OpenCode in dev or local troubleshooting. |
| `NEVERWRITE_APP_DATA_DIR` | Overrides app data storage, including `ai/runtime-setup.json`; Electron sets this for the sidecar. |
| `NEVERWRITE_AI_SECRET_STORE=memory` | Test/smoke-only opt-in for in-memory secrets when no OS keyring is available. Do not use for production persistence. |
| `NEVERWRITE_NATIVE_BACKEND_PATH` | Forces Electron to use a specific native backend sidecar. Useful when testing a local sidecar build. |
| `NEVERWRITE_ELECTRON_ACP_RESOURCE_DIR` | Internal packaged-resource directory used by Electron to expose bundled ACP resources to the backend. |
| `NEVERWRITE_NATIVE_BACKEND_BUNDLE_BIN` | Packaging override for the native backend binary staged into Electron. |
| `NEVERWRITE_CODEX_ACP_BUNDLE_BIN` | Packaging override for the Codex binary staged into Electron. |
| `NEVERWRITE_EMBEDDED_NODE_BIN` | Packaging override for the embedded Node binary used by bundled Claude. |
| `NEVERWRITE_EMBEDDED_NODE_BIN_ARM64` / `NEVERWRITE_EMBEDDED_NODE_BIN_X64` | Packaging overrides for macOS universal embedded Node inputs. |
| `NEVERWRITE_EMBEDDED_NODE_VERSION` | Embedded Node download version used by sidecar staging when no Node binary override is supplied. |
| `NEVERWRITE_CLAUDE_EMBEDDED_DIR` | Packaging override for the Claude embedded runtime source directory. |
| `NEVERWRITE_ELECTRON_RELEASE_TARGET` | Default Rust target for `stage-electron-sidecar.mjs`. |
| `NEVERWRITE_ELECTRON_OUTPUT_DIR` | Electron release output directory override. |

Use launch overrides (`NEVERWRITE_*_ACP_BIN`) when a local provider CLI is
installed outside the packaged app, when testing a patched runtime, or when
diagnostics show the app cannot inherit the shell PATH you expected.

Use bundle overrides (`*_BUNDLE_BIN`, embedded Node, Claude embedded directory)
only while staging releases or local packaged builds.

## Development Setup

Basic desktop development:

```bash
cd apps/desktop
npm install
npm run dev
```

If a runtime is not found, either install the provider CLI so Electron can see
it on PATH or launch the app with an explicit override:

```bash
cd apps/desktop
NEVERWRITE_GEMINI_ACP_BIN=/absolute/path/to/gemini npm run dev
```

For sidecar-only AI runtime smoke testing:

```bash
cd apps/desktop
npm run electron:sidecar:build
npm run electron:ai-runtime:smoke
```

The smoke test creates fake ACP runtimes, uses
`NEVERWRITE_AI_SECRET_STORE=memory` by default, validates runtime inventory,
setup status, diagnostics, session creation, ACP streaming, persisted history,
the Codex auth-terminal rejection path, and the Grok ACP auth handshake plus
reversible text-diff path.

## Release Packaging

Electron release packaging runs through
[`build-electron-release.mjs`](../apps/desktop/scripts/build-electron-release.mjs),
which builds the Electron app, stages the sidecar/resources, and then runs
`electron-builder`.

Runtime staging is handled by
[`stage-electron-sidecar.mjs`](../apps/desktop/scripts/stage-electron-sidecar.mjs):

- Builds or resolves the target-specific native backend.
- Builds or resolves the target-specific `codex-acp` binary.
- Downloads or uses an overridden embedded Node runtime.
- Resolves the Claude embedded runtime from `apps/desktop/embedded/claude-agent-acp`,
  `vendor/Claude-agent-acp-upstream`, or `NEVERWRITE_CLAUDE_EMBEDDED_DIR`.
- Installs required Claude production dependencies and target-specific optional packages.
- Copies resources to `apps/desktop/out/native-backend/`.

The Electron builder config stages `apps/desktop/out/native-backend/` into the
packaged `native-backend/` resources directory and runs
[`verify-electron-bundle.mjs`](../apps/desktop/scripts/verify-electron-bundle.mjs)
as an `afterPack` hook. That verification treats these Claude runtime files as
release-critical resources:

- `native-backend/embedded/claude-agent-acp/dist/index.js`
- `native-backend/embedded/claude-agent-acp/node_modules/@agentclientprotocol/sdk/package.json`
- `native-backend/embedded/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/package.json`
- `native-backend/embedded/claude-agent-acp/node_modules/zod/package.json`

The release workflow
[`release-desktop.yml`](../.github/workflows/release-desktop.yml) builds the
target-specific Codex sidecar, downloads embedded Node for the target, exports
the bundle override variables, and verifies macOS universal binaries for the
native backend, Codex, and embedded Node.

Current packaging expectations:

- Codex is bundled as a native sidecar binary.
- Claude is bundled through embedded Node plus vendored runtime files.
- Gemini is integrated but not bundled by default.
- Grok is integrated but not bundled by default.
- Kilo is integrated but not bundled by default.
- OpenCode is integrated but not bundled by default.

## Troubleshooting

### Binary Missing

Open Settings -> AI Providers -> Diagnostics. Check each runtime's launch
command, resolution source, and setup binary path. The backend reports
`binaryReady=false` when the resolved program does not exist or cannot be found
on PATH.

Common fixes:

- Set the provider-specific `NEVERWRITE_*_ACP_BIN` variable before launching the app.
- Supply a custom binary path through `ai_update_setup` if you are exercising
  the backend API directly or a caller that exposes this field.
- For Gemini, Grok, Kilo, or OpenCode, install the CLI separately; they are not bundled in releases.
- For packaged Codex or Claude, check that `native-backend/binaries/` and
  `native-backend/embedded/` exist inside the packaged app resources.

### Auth Not Ready

`binaryReady` and `authReady` are separate. A resolved binary does not imply
authentication. If setup shows `authReady=false`, configure an API key, complete
the provider terminal login, or ensure the corresponding CLI auth file exists
and is non-empty.

If the setup store cannot load because secure credential storage is unavailable,
NeverWrite suppresses persisted auth and reports that the provider must be
reconnected or configured through environment variables.

### Provider Terminal Auth

Integrated terminal auth is supported for Claude, Gemini, Grok, Kilo, and
OpenCode. If terminal auth opens but the provider remains unready:

- Confirm the terminal process exited successfully.
- For Gemini, look for provider success output such as authentication succeeded
  or successful Google sign-in.
- For Grok, confirm `grok login` completed successfully and that active CLI auth
  exists under `~/.grok/`, currently `~/.grok/auth.json`. You can also configure
  `XAI_API_KEY` through the setup UI or the process environment.
- For OpenCode, confirm `opencode auth login` completed or use `/connect` in
  OpenCode itself.
- Reopen diagnostics and confirm the runtime launch command points to the CLI
  you expected.
- Remember that Codex ChatGPT auth does not use the integrated auth terminal.

### Gateway Validation

Claude custom gateways must use HTTPS unless they are loopback development
gateways. Do not include credentials in the URL. Put secrets in the optional
headers or token fields instead.

Examples:

```text
https://gateway.example/v1        OK
http://localhost:8787/v1          OK for local development
http://gateway.example/v1         Rejected
https://user:pass@gateway.example Rejected
```

### Environment Diagnostics

The diagnostics panel compares the app's inherited PATH, the PATH injected into
runtimes, common executable resolution, and the final launch command for each
runtime. Use it when a provider works in your shell but not in the Electron app.
GUI-launched apps often inherit a different PATH than interactive shells.

### Packaged vs Development Differences

Development can resolve Codex and Claude from vendor paths if those artifacts
exist. Packaged builds should resolve Codex and Claude from
`NEVERWRITE_ELECTRON_ACP_RESOURCE_DIR`, which Electron sets to the staged
resources directory. Gemini, Grok, Kilo, and OpenCode still require an external
CLI or explicit runtime override in both development and packaged builds.

If a provider works in `npm run dev` but not in a packaged app, verify:

- Whether the provider is expected to be bundled at all.
- Whether the packaged resources contain the staged runtime.
- Whether the packaged app inherited the needed environment variables.
- Whether a previously saved custom binary path points to a dev-only location.

## Validation Commands

Use the narrowest command that verifies the change you made:

```bash
# Runtime metadata/auth UI tests
cd apps/desktop
npm test -- src/features/ai/utils/runtimeMetadata.test.ts src/features/ai/utils/authMethods.test.ts src/features/ai/utils/claudeGatewayUrl.test.ts src/features/settings/AIProvidersSettings.test.tsx
```

```bash
# Native backend AI runtime tests
cargo test -p neverwrite-native-backend ai
```

```bash
# Sidecar smoke test with a fake ACP runtime
cd apps/desktop
npm run electron:sidecar:build
npm run electron:ai-runtime:smoke
```

```bash
# Local packaged app build path
cd apps/desktop
npm run electron:package:unsigned
```

Last updated: June 2, 2026.
