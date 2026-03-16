Place precompiled ACP runtime binaries in this directory for release builds.

VaultAI only bundles these two ACP runtimes:

- Codex
- Claude

Any other runtime must be downloaded and installed separately by the user.

Expected filenames:

- `codex-acp` on macOS/Linux
- `codex-acp.exe` on Windows
- `claude-agent-acp` on macOS/Linux
- `claude-agent-acp.exe` on Windows

Tauri bundles everything under `src-tauri/binaries/` as application resources.

Build-time staging priority for Codex:

1. `VAULTAI_CODEX_ACP_BUNDLE_BIN`
2. `VAULTAI_CODEX_ACP_BIN`
3. `vendor/codex-acp/target/release/`
4. `vendor/codex-acp/target/debug/`
5. `PATH`

Build-time staging priority for Claude:

1. `VAULTAI_CLAUDE_ACP_BUNDLE_BIN`
2. `VAULTAI_CLAUDE_ACP_BIN`
3. `vendor/Claude-agent-acp-upstream/target/release/`
4. `vendor/Claude-agent-acp-upstream/target/debug/`
5. `PATH`

If one of those binaries exists, `src-tauri/build.rs` copies it here automatically
before Tauri bundles the app. If no source is found but a file is already present in
`src-tauri/binaries/`, that staged binary is kept as-is.
