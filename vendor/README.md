# Vendored Dependencies

This directory is committed on purpose.

NeverWrite currently vendors upstream runtime projects that are needed for desktop
integration and release packaging, especially:

- `codex-acp`
- `Claude-agent-acp-upstream`

Why this lives in git:

- release builds depend on these runtimes being available locally
- the desktop packaging flow stages binaries and runtime assets from here
- keeping the sources in-repo makes release inputs explicit and reproducible

What is currently required by the app/build pipeline:

- `codex-acp/`
  - used as a Rust crate and sidecar build input during desktop release builds
- `Claude-agent-acp-upstream/package.json`
  - used by the desktop build to validate and stage the embedded Claude runtime
- `Claude-agent-acp-upstream/dist/`
  - compiled runtime files that are copied into the desktop bundle

What is vendored mainly for auditability and maintenance, not direct runtime use:

- `Claude-agent-acp-upstream/src/`
- `Claude-agent-acp-upstream/src/tests/`
- `Claude-agent-acp-upstream/dist/tests/`
- `Claude-agent-acp-upstream/docs/`
- assorted upstream config files (`tsconfig`, `vitest`, `eslint`, lockfiles)

That means the directory is intentionally reproducible, but not yet minimal.

## Current Baselines

- `codex-acp/`
  - upstream baseline: `zed-industries/codex-acp` `0.11.1`
  - synced against upstream commit `c3e95ca414f57a3db8a5bf5714719a102b98e0b5`
  - local NeverWrite delta remains intentionally bounded and currently lives in:
    - `vendor/codex-acp/src/thread.rs`
- `Claude-agent-acp-upstream/`
  - vendored snapshot is currently based on `@agentclientprotocol/claude-agent-acp` `0.27.0`

## Current Codex Delta

The Codex vendor is no longer a raw upstream checkout.

The remaining NeverWrite-specific delta exists to preserve desktop product behavior:

- canonical `neverwrite*` ACP metadata for status, plan updates, diffs and `user_input_request`
- reconstruction of `unified_diff` into `old_text`, `new_text` and hunk metadata for inline review and edited-files flows
- mode and approval-preset stability when Codex expands writable roots under `workspace-write`
- actor lifecycle behavior that does not keep the internal message channel alive after external senders disappear

When updating Codex again, treat `c3e95ca` as the comparison base and review those files intentionally instead of replacing the whole directory blindly.

## Updating Vendored Runtimes

When updating a vendored dependency:

1. Refresh the upstream snapshot to the exact release or commit you intend to ship.
2. Keep `dist/` aligned with the vendored Claude source snapshot.
3. Re-apply only the bounded local product delta that NeverWrite still needs.
4. Remove any local byproducts before committing.
5. Re-run the relevant validation:
   - `cd vendor/codex-acp && cargo test -q`
   - `NEVERWRITE_CODEX_ACP_BUNDLE_BIN=$REPO_ROOT/vendor/codex-acp/target/debug/codex-acp cargo test -p neverwrite-desktop`
   - `cd apps/desktop && npm test -- src/features/ai/store/chatStore.test.ts src/features/ai/components/AIReviewView.test.tsx src/features/ai/components/EditedFilesBufferPanel.test.tsx src/features/ai/components/reviewMultiSessionIntegration.test.tsx src/features/ai/AIChatPanel.test.tsx src/features/ai/components/AIChatMessageItem.test.tsx src/features/editor/mergeViewSync.test.ts src/features/editor/extensions/mergeViewDiff.test.ts`

The repository keeps the Claude runtime snapshot broader than the minimum
runtime surface on purpose. The desktop build depends directly on `dist/`, while
the vendored source and test trees stay in-repo for auditability, upstream diff
review, and easier runtime updates.

What should not be committed here:

- local build outputs such as `target/`
- temporary install trees such as `node_modules/`
- transient bundler caches such as `.vite/`

Those generated paths are ignored in the repository root `.gitignore`.
