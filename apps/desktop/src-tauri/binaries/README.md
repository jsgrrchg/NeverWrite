Place precompiled ACP runtime sidecars in this directory for release builds when a
runtime still uses a bundled binary, or when you intentionally provide a legacy
fallback during development.

NeverWrite currently bundles these runtime resources:

- Codex as a staged sidecar binary in `src-tauri/binaries/`
- Claude as an embedded Node runtime plus embedded vendored JS in
  `src-tauri/embedded/`

Any other runtime must be downloaded and installed separately by the user.

Expected filenames:

- `codex-acp` on macOS/Linux
- `codex-acp.exe` on Windows
- `claude-agent-acp` on macOS/Linux (legacy Claude fallback only)
- `claude-agent-acp.exe` on Windows (legacy Claude fallback only)

Tauri bundles everything under `src-tauri/binaries/` as application resources.

Build-time staging priority for Codex:

1. `NEVERWRITE_CODEX_ACP_BUNDLE_BIN`
2. `NEVERWRITE_CODEX_ACP_BIN`
3. Rebuild `vendor/codex-acp` from source for the active Cargo profile
4. `vendor/codex-acp/target/release/`
5. `vendor/codex-acp/target/debug/`
6. workspace `target/{release,debug}/binaries/`
7. workspace `target/{release,debug}/`
8. `PATH`

Build-time behavior for Claude:

- `build.rs` does not currently stage a standalone `claude-agent-acp` binary
- Claude release packaging is the embedded runtime under `src-tauri/embedded/`
- the vendored Claude ACP project is copied from `vendor/Claude-agent-acp-upstream/`
- the embedded Node runtime is resolved from `PATH` or `NEVERWRITE_EMBEDDED_NODE_BIN`
- any existing `src-tauri/binaries/claude-agent-acp{,.exe}` legacy fallback is
  removed before the embedded runtime is staged

Codex is the only ACP runtime that `src-tauri/build.rs` stages into this directory
as part of the normal build. Claude's sidecar filename is documented here only
because the runtime resolver still supports it as a legacy fallback if such a file
is present in app resources.
