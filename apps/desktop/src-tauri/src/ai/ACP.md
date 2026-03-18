# ACP (Agent Client Protocol) — Architecture Reference

VaultAI integrates two AI runtimes through the Agent Client Protocol: **Claude** and **Codex**. Both communicate with the app via JSON-RPC over stdio (NDJSON framing).

---

## Runtimes at a Glance

| | Claude | Codex |
|---|---|---|
| **Source** | TypeScript (`@zed-industries/claude-agent-acp` v0.22.2) | Rust (`codex-acp` v0.10.0) |
| **Release packaging** | Embedded Node runtime + vendor JS | Cargo (`cargo build --release`) |
| **Auth methods** | `claude-login`, custom gateway | ChatGPT OAuth, API key |
| **Capabilities** | attachments, permissions, plans, terminal_output | attachments, permissions, reasoning |
| **Sessions** | create, load, resume, fork, list, close | create, load, list, close |
| **ACP SDK version** | `@agentclientprotocol/sdk` 0.16.1 | `agent-client-protocol` 0.10.2 |
| **Vendor dir** | `vendor/Claude-agent-acp-upstream/` | `vendor/codex-acp/` |

---

## Binary Resolution (runtime)

When the app needs to spawn a runtime process, it resolves the binary in this order:

### Claude (`setup.rs` → `resolve_binary_command`)

1. `VAULTAI_CLAUDE_ACP_BIN` env var
2. Custom path from setup config
3. **Debug builds only:** vendor JS at `vendor/Claude-agent-acp-upstream/dist/index.js` (run via `node`)
4. Embedded Node runtime + embedded vendor JS at `{resource_dir}/embedded/node/bin/node {resource_dir}/embedded/claude-agent-acp/dist/index.js`
5. Bundled binary at `{resource_dir}/binaries/claude-agent-acp` (legacy fallback)
6. Vendor JS fallback
7. `claude-agent-acp` in PATH

### Codex (`setup.rs` → `resolve_binary_command`)

1. `VAULTAI_CODEX_ACP_BIN` env var
2. Custom path from setup config
3. Bundled binary at `{resource_dir}/binaries/codex-acp`
4. Vendor compiled binary
5. `codex-acp` in PATH

### Why vendor JS first in debug for Claude?

Bun-compiled binaries are unreliable when spawned as child processes by Tauri during development (intermittent SIGKILL from macOS, silent crashes). The vendor JS executed via `node` is stable. Release builds now embed a dedicated Node runtime plus the vendor JS so Claude uses the same stable execution path without requiring Node on the user's machine.

When a `.js` file is resolved, the app wraps it automatically: `node /path/to/index.js`.

---

## Binary Staging (build-time)

`build.rs` stages release resources into `src-tauri/binaries/` and `src-tauri/embedded/` before Tauri bundles the app.

### Candidate sources (checked in order):

1. `VAULTAI_*_ACP_BUNDLE_BIN` env var
2. `VAULTAI_*_ACP_BIN` env var
3. `vendor/{runtime}/target/release/{binary}`
4. `vendor/{runtime}/target/debug/{binary}`
5. System PATH

### Embedded Claude runtime staging

`build.rs` stages two Claude resources for release:

- an embedded Node runtime under `embedded/node/`
- the vendor Claude ACP project under `embedded/claude-agent-acp/`

The staged Claude project includes:

- `dist/`
- `package.json`
- the runtime dependency subset from `node_modules/`

Codex does not use Node — it's still a Rust binary built with `cargo build`.

### Tauri resource bundling

`tauri.conf.json` includes `"resources": ["binaries/*", "embedded/**/*"]`, so both the classic binaries and the embedded Claude runtime are bundled into the `.app`.

---

## Authentication

### Claude

Two methods, configured in `~/Library/Application Support/com.vaultai/ai/claude-setup.json`:

- **`claude-login`**: Opens a terminal and runs the resolved Claude runtime in CLI mode. In release that means the embedded Node runtime plus the embedded Claude vendor entry. Stores tokens in `~/.claude.json` (standard Claude CLI auth file). The app detects auth by checking if `~/.claude.json` exists and was modified after any invalidation timestamp.

- **`gateway`**: Custom Anthropic-compatible endpoint. Sets environment variables on the child process:
  - `ANTHROPIC_BASE_URL` — gateway URL
  - `ANTHROPIC_AUTH_TOKEN` — bearer token
  - `ANTHROPIC_CUSTOM_HEADERS` — extra headers

Auth invalidation: when the runtime returns errors containing "auth_required" or "you were signed out", the app clears the auth method and requires re-login.

### Codex

- **`chatgpt`**: Browser-based OAuth (skipped if `NO_BROWSER` env var is set)
- **`openai-api-key` / `codex-api-key`**: API key stored in config, passed via `CODEX_API_KEY` or `OPENAI_API_KEY` env vars

VaultAI carries a small local patch on `vendor/codex-acp` `v0.10.0` to preserve `SessionModeState` / `Approval Preset` options when upstream Codex expands a `workspace-write` sandbox with additional writable roots. Without this patch, the runtime can stop emitting `modes` even though the session still has a valid approval+sandbox configuration.

---

## Process Spawn Flow

Both runtimes follow the same pattern:

```
Frontend (React) → Tauri command → AiManager → RuntimeAdapter
    → RuntimeHandle.create_session(spec)
    → mpsc channel → actor thread (tokio LocalSet)
    → Command::new(program).args(args).stdin(Piped).stdout(Piped).stderr(Piped)
    → apply_auth_env(command, config)
    → child.spawn()
    → ClientSideConnection::new(client, stdin, stdout)
    → JSON-RPC: initialize → session/new → prompt
```

The actor runs on a dedicated thread with a tokio `LocalSet` to allow `Rc<ClientSideConnection>` (not `Send`).

Stderr is captured to an `Arc<Mutex<String>>` ring buffer (8KB) and included in error messages when the process exits.

---

## ACP Protocol Basics

**Framing:** NDJSON — one JSON object per line, over stdin/stdout.

**Client → Agent messages:**
- `initialize` — handshake, exchange protocol version and capabilities
- `session/new` — create a new conversation session
- `session/load` — load an existing session by ID
- `session/close` — close an active session
- `session/resume` — resume a previous session (Claude only)
- `session/fork` — fork a session (Claude only)
- `session/list` — list active sessions
- `prompt` — send a user message
- `set_session_model` / `set_session_mode` / `set_session_config_option`
- `respond_to_permission_request` — approve/deny tool use
- `respond_to_user_input_request` — answer agent questions (Codex only)

**Agent → Client notifications:**
- `session/update` — session state changed (models, modes, commands)
- `message/started`, `message/delta`, `message/completed` — streaming response
- `thinking/started`, `thinking/delta`, `thinking/completed` — reasoning
- `tool_activity` — tool use with diffs, terminal output
- `status` — agent status changes
- `permission_request` — ask for tool use approval
- `plan_updated` — plan changes (Claude only)

**Protocol version:** Numeric `1` (not a date string).

---

## Tauri Event System

The Rust backend emits events to the React frontend via Tauri IPC:

| Event | Payload |
|-------|---------|
| `ai://session-created` | `AiSession` |
| `ai://session-updated` | `AiSession` |
| `ai://session-error` | `{ session_id, runtime_id, message }` |
| `ai://message-started` | `{ session_id, message_id }` |
| `ai://message-delta` | `{ session_id, message_id, delta }` |
| `ai://message-completed` | `{ session_id, message_id }` |
| `ai://thinking-*` | Same pattern as messages |
| `ai://tool-activity` | `{ session_id, tool, diffs[], summary }` |
| `ai://status-event` | `{ session_id, status }` |
| `ai://permission-request` | `{ session_id, request_id, diffs[] }` |
| `ai://runtime-connection` | `{ runtime_id, status, message }` |

---

## File Map

```
apps/desktop/src-tauri/
├── build.rs                          # Codex binary staging + embedded Claude runtime staging
├── tauri.conf.json                   # resources: ["binaries/*", "embedded/**/*"]
├── binaries/
│   └── codex-acp                     # Rust-compiled (gitignored)
├── embedded/
│   ├── node/                         # Embedded Node runtime (auto-generated, gitignored)
│   └── claude-agent-acp/             # Embedded Claude vendor runtime (auto-generated, gitignored)
├── src/ai/
│   ├── mod.rs
│   ├── runtime.rs                    # AiRuntimeAdapter trait
│   ├── manager.rs                    # AiManager — multi-runtime orchestrator
│   ├── commands.rs                   # Tauri #[command] handlers
│   ├── emit.rs                       # Event emission helpers
│   ├── claude/
│   │   ├── setup.rs                  # Config, auth, binary resolution
│   │   ├── process.rs                # ClaudeRuntime, paths
│   │   ├── client.rs                 # Actor, ClientSideConnection, VaultAiAcpClient
│   │   └── adapter.rs               # ClaudeRuntimeAdapter impl
│   └── codex/
│       ├── setup.rs                  # Config, auth, binary resolution
│       ├── process.rs                # CodexRuntime, paths, home_dir
│       ├── client.rs                 # Actor, ClientSideConnection
│       └── adapter.rs               # CodexRuntimeAdapter impl

vendor/
├── Claude-agent-acp-upstream/        # @zed-industries/claude-agent-acp v0.22.2
│   ├── dist/index.js                 # JS entry (used in dev via node)
│   ├── node_modules/                 # Dependencies (claude-agent-sdk, etc.)
│   └── package.json
└── codex-acp/                        # Rust crate (v0.10.0)
    ├── src/main.rs
    └── Cargo.toml
```

### App data (macOS)

```
~/Library/Application Support/com.vaultai/
├── ai/
│   ├── setup.json                    # Codex auth/setup config
│   └── claude-setup.json             # Claude auth/setup config
└── codex/
    ├── sessions/                     # Codex session logs
    ├── config.toml                   # Codex runtime config
    └── state_5.sqlite                # Codex state DB
```

---

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `VAULTAI_CLAUDE_ACP_BIN` | build.rs, setup.rs | Override Claude binary path |
| `VAULTAI_CLAUDE_ACP_BUNDLE_BIN` | build.rs | Override Claude bundle binary |
| `VAULTAI_EMBEDDED_NODE_BIN` | build.rs | Override the Node binary used for the embedded Claude runtime |
| `VAULTAI_CODEX_ACP_BIN` | build.rs, setup.rs | Override Codex binary path |
| `VAULTAI_CODEX_ACP_BUNDLE_BIN` | build.rs | Override Codex bundle binary |
| `ANTHROPIC_BASE_URL` | Claude process | Custom gateway endpoint |
| `ANTHROPIC_AUTH_TOKEN` | Claude process | Gateway auth token |
| `ANTHROPIC_CUSTOM_HEADERS` | Claude process | Gateway custom headers |
| `CODEX_API_KEY` | Codex process | Codex/OpenAI API key |
| `OPENAI_API_KEY` | Codex process | Fallback API key |
| `NO_BROWSER` | Codex setup | Skip OAuth auth method |
