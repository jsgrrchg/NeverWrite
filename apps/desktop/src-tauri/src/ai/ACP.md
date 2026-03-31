# ACP (Agent Client Protocol) — Architecture Reference

VaultAI currently integrates three AI runtimes through the Agent Client Protocol:

- **Claude**
- **Codex**
- **Gemini**

All three communicate with the app over ACP / JSON-RPC on stdio.

---

## Runtimes at a Glance

| | Claude | Codex | Gemini |
|---|---|---|---|
| **Source** | TypeScript (`@zed-industries/claude-agent-acp` v0.22.2) | Rust (`codex-acp` v0.10.0) | External Gemini CLI binary (`gemini --acp`) |
| **Release packaging** | Embedded Node runtime + embedded vendor JS | Cargo-built sidecar binary bundled into `binaries/` | Not bundled today; resolved from env/custom path/PATH |
| **Auth methods** | `claude-login`, `gateway` | `chatgpt`, `openai-api-key`, `codex-api-key` | `login_with_google`, `use_gemini` |
| **Descriptor capabilities** | attachments, permissions, plans, terminal_output | attachments, permissions, reasoning, terminal_output | attachments, permissions, plans |
| **VaultAI adapter capabilities** | create, load, resume, fork, list, terminal_output, prompt_queueing | create, load, list, terminal_output, user_input | create, load, resume |
| **Session RPC used by VaultAI** | new, load, resume, fork, list, prompt, cancel | new, load, list, authenticate, prompt, cancel, close | new, load, list, authenticate, prompt, cancel, close |
| **ACP SDK version** | `@agentclientprotocol/sdk` 0.16.1 | `agent-client-protocol` 0.10.2 | Gemini CLI ACP implementation |
| **Vendor dir** | `vendor/Claude-agent-acp-upstream/` | `vendor/codex-acp/` | N/A |

Notes:

- `Gemini` is fully wired into `AiManager`, Tauri commands, setup, process, client and adapter layers.
- Gemini emits plans and available-command updates from the ACP stream, but VaultAI currently does **not** surface Gemini `user_input` as a supported adapter capability.
- Codex and Gemini support `session/close` in the client/runtime handle path; Claude session removal is currently local-state cleanup only.

---

## Binary Resolution (runtime)

When VaultAI needs to spawn a runtime process, it resolves the executable/command in this order.

### Claude (`claude/setup.rs` → `resolve_binary_command`)

1. `VAULTAI_CLAUDE_ACP_BIN`
2. Custom path from setup config
3. **Debug builds only:** vendor JS at `vendor/Claude-agent-acp-upstream/dist/index.js`
4. Embedded Node runtime + embedded vendor JS at `{resource_dir}/embedded/node/bin/node {resource_dir}/embedded/claude-agent-acp/dist/index.js`
5. Bundled binary at `{resource_dir}/binaries/claude-agent-acp` (legacy fallback)
6. Vendor JS fallback
7. `claude-agent-acp` in PATH

If the resolved target is a `.js` entry, VaultAI wraps it automatically as:

```text
node /path/to/index.js
```

### Codex (`codex/setup.rs` → `resolve_binary_path`)

1. `VAULTAI_CODEX_ACP_BIN`
2. Custom path from setup config
3. Bundled binary at `{resource_dir}/binaries/codex-acp`
4. Vendor compiled binary at `vendor/codex-acp/target/{debug|release}/codex-acp`

Unlike Claude, the current Codex resolution path does **not** fall back to PATH at runtime. If neither bundled nor vendor binaries exist, setup still points at the bundled target path and reports the runtime as missing.

### Gemini (`gemini/setup.rs` → `resolve_binary_command`)

1. `VAULTAI_GEMINI_ACP_BIN`
2. Custom path from setup config
3. `gemini` in PATH

When spawned, VaultAI appends:

```text
--acp
```

so the effective command is:

```text
gemini --acp
```

### Why vendor JS first in debug for Claude?

Bun-compiled Claude binaries proved unreliable when spawned as child processes by Tauri during development. Running the vendored JS with `node` is stable. Release builds therefore embed both:

- a Node runtime under `embedded/node/`
- the vendored Claude ACP project under `embedded/claude-agent-acp/`

This keeps Claude on the same stable execution path without requiring Node on the user's machine.

On Windows, command lookup is `PATHEXT`-aware.

---

## Binary Staging (build-time)

`build.rs` stages release resources into `src-tauri/binaries/` and `src-tauri/embedded/` before Tauri bundles the app.

### What is staged today

- **Codex:** a prebuilt `codex-acp` binary is staged into `src-tauri/binaries/`
- **Claude:** an embedded Node runtime plus the vendored Claude ACP runtime are staged into `src-tauri/embedded/`
- **Gemini:** not staged or bundled today

### Candidate sources for staged binaries

For staged binaries, `build.rs` checks in this order:

1. `VAULTAI_*_ACP_BUNDLE_BIN`
2. `VAULTAI_*_ACP_BIN`
3. `vendor/{runtime}/target/release/{binary}`
4. `vendor/{runtime}/target/debug/{binary}`
5. System PATH

### Embedded Claude runtime staging

`build.rs` stages:

- `embedded/node/`
- `embedded/claude-agent-acp/`

The staged Claude tree includes:

- `dist/`
- `package.json`
- the runtime dependency subset from `node_modules/`

Staging is target-aware:

- macOS preserves the dylib-copy / code-sign flow for the embedded Node runtime
- Windows stages `node.exe` plus sibling runtime files such as `.dll` and `.dat`
- the staged Claude tree is validated after copy so missing runtime dependencies fail fast

For Windows targets, the build rejects reuse of a non-Windows Node binary. Windows bundles should therefore be built on Windows or with an explicit `VAULTAI_EMBEDDED_NODE_BIN` override pointing to a real Windows `node.exe`.

### Tauri resource bundling

`tauri.conf.json` currently includes:

```json
"resources": ["binaries/*", "embedded/**/*"]
```

This bundles:

- classic sidecar binaries such as `codex-acp`
- the embedded Claude runtime

It does **not** bundle Gemini today.

---

## Authentication

### Claude

Configured in:

```text
~/Library/Application Support/com.vaultai/ai/claude-setup.json
```

Secrets are stored in the OS secure secret store, not in the JSON config file.

Supported methods:

- **`claude-login`**
  - Opens a terminal and runs the resolved Claude runtime in CLI mode
  - In release, that means embedded Node + embedded Claude vendor entry
  - Auth is detected from `~/.claude.json`, checked against any invalidation timestamp

- **`gateway`**
  - Custom Anthropic-compatible endpoint
  - Injected into the child process through:
    - `ANTHROPIC_BASE_URL`
    - `ANTHROPIC_AUTH_TOKEN`
    - `ANTHROPIC_CUSTOM_HEADERS`

Claude gateway config is validated more strictly than this doc originally described:

- valid URL required
- HTTPS required except localhost HTTP
- embedded credentials in the URL are rejected

Auth invalidation:

- on explicit config changes affecting gateway/auth
- when the runtime returns auth-style failures such as `auth_required` or “you were signed out”

### Codex

Configured in:

```text
~/Library/Application Support/com.vaultai/ai/setup.json
```

Secrets are stored in the OS secure secret store.

Supported methods:

- **`chatgpt`**
  - Browser-based OAuth
  - Not offered when `NO_BROWSER` is set

- **`openai-api-key`**
  - Stored locally and injected as `OPENAI_API_KEY`

- **`codex-api-key`**
  - Stored locally and injected as `CODEX_API_KEY`

Auth detection is not based only on persisted `auth_method`. VaultAI also considers environment variables and available secrets when computing the effective ready/authenticated state.

VaultAI carries a local patch on `vendor/codex-acp` `v0.10.0` so `SessionModeState` / `Approval Preset` survives cases where upstream Codex expands a `workspace-write` sandbox with extra writable roots. Without this patch, Codex can stop emitting `modes` even though the session still has a valid approval+sandbox configuration.

### Gemini

Configured in:

```text
~/Library/Application Support/com.vaultai/ai/gemini-setup.json
```

Secrets are stored in the OS secure secret store.

Supported methods:

- **`login_with_google`**
  - Uses Gemini CLI's Google login flow
  - VaultAI detects readiness by inspecting `~/.gemini/settings.json`
  - The selected auth type must match Google-login aliases and be newer than any invalidation timestamp

- **`use_gemini`**
  - Uses a locally stored Gemini Developer API key
  - `GEMINI_API_KEY` and `GOOGLE_API_KEY` are both treated as valid developer-key sources

Additional Gemini process env injected by VaultAI:

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION`
- `GEMINI_DEFAULT_AUTH_TYPE`

Gemini setup also persists `gateway_base_url` and `gateway_headers`. VaultAI can serialize these into Gemini ACP auth metadata when the runtime is asked to authenticate with `gateway`, but the primary supported VaultAI setup flows today are still Google login and Gemini API key.

---

## Process Spawn Flow

All runtimes follow the same high-level pattern:

```text
Frontend (React) → Tauri command → AiManager → RuntimeAdapter
    → RuntimeHandle.*(spec)
    → mpsc channel → actor thread (tokio LocalSet)
    → Command::new(...).stdin(Piped).stdout(Piped)
    → apply_auth_env(...)
    → child.spawn()
    → ClientSideConnection::new(client, stdin, stdout)
    → initialize → session/new|load|resume|fork → prompt
```

The actor runs on a dedicated thread with a tokio `LocalSet` so it can safely hold `Rc<ClientSideConnection>` values.

### Spawn differences by runtime

- **Claude**
  - `program + args`
  - `stderr` is piped
  - stderr tail is buffered in an `Arc<Mutex<String>>` ring buffer (~8 KB) and included in disconnect/exit errors

- **Codex**
  - binary path only
  - `CODEX_HOME` is set to the app data directory
  - `stderr` is currently discarded with `Stdio::null()`

- **Gemini**
  - `program + args + --acp`
  - `stderr` is currently discarded with `Stdio::null()`

---

## ACP Protocol Basics

**Framing:** ACP over stdio. In practice this is line-delimited JSON / NDJSON style framing handled by the ACP client libraries.

### Client → Agent requests used by VaultAI

- `initialize`
- `authenticate` (Codex, Gemini)
- `session/new`
- `session/load`
- `session/list`
- `session/resume` (Claude)
- `session/fork` (Claude)
- `session/close` (Codex, Gemini)
- `prompt`
- `set_session_model`
- `set_session_mode`
- `set_session_config_option`
- cancel notification

Permission approval is resolved through ACP permission request handling inside the client runtime state. Codex `user_input` replies are currently sent back by synthesizing a special prompt payload rather than using a dedicated first-class ACP request method.

### Agent → Client notifications handled by VaultAI

- session updates carrying:
  - message chunks
  - thought chunks
  - tool calls / tool call updates
  - plan updates
  - available command updates
  - current mode updates
- permission requests

### Protocol version

VaultAI initializes ACP clients with:

```rust
ProtocolVersion::LATEST
```

not a hardcoded numeric literal in app code.

---

## Tauri Event System

The Rust backend emits the following events to the React frontend:

| Event | Payload |
|-------|---------|
| `ai://session-created` | `AiSession` |
| `ai://session-updated` | `AiSession` |
| `ai://session-error` | `{ session_id?: string, message }` |
| `ai://message-started` | `{ session_id, message_id }` |
| `ai://message-delta` | `{ session_id, message_id, delta }` |
| `ai://message-completed` | `{ session_id, message_id }` |
| `ai://thinking-started` | `{ session_id, message_id }` |
| `ai://thinking-delta` | `{ session_id, message_id, delta }` |
| `ai://thinking-completed` | `{ session_id, message_id }` |
| `ai://tool-activity` | `{ session_id, tool_call_id, title, kind, status, target?, summary?, diffs? }` |
| `ai://status-event` | `{ session_id, event_id, kind, status, title, detail?, emphasis }` |
| `ai://permission-request` | `{ session_id, request_id, tool_call_id, title, target?, options[], diffs[] }` |
| `ai://user-input-request` | `{ session_id, request_id, title, questions[] }` |
| `ai://plan-updated` | `{ session_id, plan_id, title?, detail?, entries[] }` |
| `ai://available-commands-updated` | `{ session_id, commands[] }` |
| `ai://runtime-connection` | `{ runtime_id, status, message? }` |

Notes:

- Claude emits plan + available-command updates.
- Codex emits permission, plan, status, tool activity and `user-input-request`.
- Gemini emits plan + available-command updates, but VaultAI currently rejects Gemini `respond_user_input`.

---

## File Map

```text
apps/desktop/src-tauri/
├── build.rs                          # Codex staging + embedded Claude staging
├── tauri.conf.json                   # resources: ["binaries/*", "embedded/**/*"]
├── binaries/
│   └── codex-acp                     # Rust-compiled sidecar (gitignored)
├── embedded/
│   ├── node/                         # Embedded Node runtime (auto-generated, gitignored)
│   └── claude-agent-acp/             # Embedded Claude runtime (auto-generated, gitignored)
├── src/ai/
│   ├── mod.rs
│   ├── runtime.rs                    # AiRuntimeAdapter trait + capability merging
│   ├── manager.rs                    # Multi-runtime orchestration + attachment expansion
│   ├── commands.rs                   # Tauri #[command] handlers
│   ├── emit.rs                       # Event emission helpers
│   ├── persistence.rs                # Session history persistence
│   ├── secret_store.rs               # OS-backed secret storage
│   ├── auth_terminal.rs
│   ├── claude/
│   │   ├── setup.rs
│   │   ├── process.rs
│   │   ├── client.rs
│   │   └── adapter.rs
│   ├── codex/
│   │   ├── setup.rs
│   │   ├── process.rs
│   │   ├── client.rs
│   │   └── adapter.rs
│   └── gemini/
│       ├── setup.rs
│       ├── process.rs
│       ├── client.rs
│       └── adapter.rs
│
vendor/
├── Claude-agent-acp-upstream/        # @zed-industries/claude-agent-acp v0.22.2
│   ├── dist/index.js
│   ├── node_modules/
│   └── package.json
└── codex-acp/                        # codex-acp v0.10.0 + local VaultAI patch
    ├── src/main.rs
    └── Cargo.toml
```

---

## App Data (macOS)

```text
~/Library/Application Support/com.vaultai/
├── ai/
│   ├── setup.json                    # Codex setup/auth config
│   ├── claude-setup.json             # Claude setup/auth config
│   └── gemini-setup.json             # Gemini setup/auth config
└── codex/
    ├── sessions/                     # Codex session logs
    ├── config.toml                   # Codex runtime config
    └── state_5.sqlite                # Codex state DB
```

External auth state also used:

```text
~/.claude.json
~/.gemini/settings.json
```

---

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `VAULTAI_CLAUDE_ACP_BIN` | Claude build/runtime | Override Claude binary / command path |
| `VAULTAI_CLAUDE_ACP_BUNDLE_BIN` | Claude build | Override Claude bundle binary |
| `VAULTAI_EMBEDDED_NODE_BIN` | Claude build | Override embedded Node runtime source |
| `VAULTAI_CODEX_ACP_BIN` | Codex build/runtime | Override Codex binary path |
| `VAULTAI_CODEX_ACP_BUNDLE_BIN` | Codex build | Override Codex bundle binary |
| `VAULTAI_GEMINI_ACP_BIN` | Gemini runtime | Override Gemini CLI command/path |
| `ANTHROPIC_BASE_URL` | Claude process | Anthropic gateway URL |
| `ANTHROPIC_AUTH_TOKEN` | Claude process | Gateway auth token |
| `ANTHROPIC_CUSTOM_HEADERS` | Claude process | Gateway custom headers |
| `CODEX_API_KEY` | Codex process | Codex API key |
| `OPENAI_API_KEY` | Codex process | OpenAI API key |
| `NO_BROWSER` | Codex setup | Hide ChatGPT OAuth auth method |
| `GEMINI_API_KEY` | Gemini process | Gemini Developer API key |
| `GOOGLE_API_KEY` | Gemini process | Alternate Gemini developer key source |
| `GOOGLE_CLOUD_PROJECT` | Gemini process | Google Cloud project hint |
| `GOOGLE_CLOUD_LOCATION` | Gemini process | Google Cloud location hint |
| `GEMINI_DEFAULT_AUTH_TYPE` | Gemini process | Default Gemini auth mode |

---

## Current Caveats

- Gemini is integrated end-to-end in VaultAI, but it is **not** currently bundled by `build.rs` / Tauri resources.
- Claude is the only ACP runtime whose stderr is currently captured and surfaced in disconnect errors.
- Codex `user_input` is supported in VaultAI; Gemini `user_input` is not.
- The document should be kept aligned with `apps/desktop/src-tauri/src/ai/{claude,codex,gemini}/` whenever runtime behavior changes, because the app now has runtime-specific differences that matter operationally.
