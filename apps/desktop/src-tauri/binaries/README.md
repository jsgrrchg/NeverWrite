Place precompiled ACP runtime binaries in this directory for release builds.

Expected filenames:

- `codex-acp` on macOS/Linux
- `codex-acp.exe` on Windows

Tauri bundles everything under `src-tauri/binaries/` as application resources.

Build-time staging priority:

1. `VAULTAI_CODEX_ACP_BUNDLE_BIN`
2. `VAULTAI_CODEX_ACP_BIN`
3. `vendor/codex-acp/target/release/`
4. `vendor/codex-acp/target/debug/`

If one of those binaries exists, `src-tauri/build.rs` copies it here automatically
before Tauri bundles the app.
