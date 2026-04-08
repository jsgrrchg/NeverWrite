Place precompiled ACP runtime binaries in this directory for release builds.

NeverWrite only bundles these two ACP runtimes:

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

1. `NEVERWRITE_CODEX_ACP_BUNDLE_BIN`
2. `NEVERWRITE_CODEX_ACP_BIN`
3. Rebuild `vendor/codex-acp` from source for the active Cargo profile
4. `vendor/codex-acp/target/release/`
5. `vendor/codex-acp/target/debug/`
6. workspace `target/{release,debug}/binaries/`
7. workspace `target/{release,debug}/`
8. `PATH`

Build-time staging priority for Claude:

1. `NEVERWRITE_CLAUDE_ACP_BUNDLE_BIN`
2. `NEVERWRITE_CLAUDE_ACP_BIN`
3. `vendor/Claude-agent-acp-upstream/target/release/`
4. `vendor/Claude-agent-acp-upstream/target/debug/`
5. `PATH`

If one of those binaries exists, `src-tauri/build.rs` copies it here automatically
before Tauri bundles the app. Codex now tries to rebuild from `vendor/codex-acp`
before falling back to older artifacts. If no fresh source is found but a file is
already present in `src-tauri/binaries/`, that staged binary is reused with a warning
that it may be stale.
