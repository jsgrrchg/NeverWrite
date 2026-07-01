# Vendored Dependencies

This directory is committed on purpose.

NeverWrite currently vendors upstream runtime projects that are needed for desktop
integration and release packaging, especially:

- `codex-acp`
- `Claude-agent-acp-upstream`
- `acp12`

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
- `Claude-agent-acp-upstream/node_modules/`
  - production dependencies are installed by the Electron sidecar staging step
    and copied into the packaged embedded Claude runtime
- `acp12/`
  - used as Rust compatibility crates by the native backend for Grok legacy ACP
    sessions

What is vendored mainly for auditability and maintenance, not direct runtime use:

- `Claude-agent-acp-upstream/src/`
- `Claude-agent-acp-upstream/src/tests/`
- `Claude-agent-acp-upstream/dist/tests/`
- `Claude-agent-acp-upstream/docs/`
- `acp12/agent-client-protocol*/`
- assorted upstream config files (`tsconfig`, `vitest`, `eslint`, lockfiles)

That means the directory is intentionally reproducible, but not yet minimal.

## Current Baselines

- `codex-acp/`
  - upstream baseline: `zed-industries/codex-acp` `0.15.0`
  - synced against upstream commit `863d433fc91855d0b5427372bf635c894bf68cb6`
  - latest upstream sync from `0.14.0` brought in 5 commits:
    `d9bf1c1`, `0c2d828`, `8aef91b`, `f67ca5f`, `863d433`
  - OpenAI Codex Rust crates: `rust-v0.133.0` (`9474e5cfc4494b0ba319352aa86ce436c59e65c8`)
  - vendor ACP SDK: `agent-client-protocol` `0.12.1`
  - upstream snapshot includes `vendor/codex-utils-pty/` plus the matching
    `[patch."https://github.com/openai/codex"]` entry required by the OpenAI Codex crate graph
  - local NeverWrite delta remains intentionally bounded and currently lives in:
    - `vendor/codex-acp/Cargo.toml`
    - `vendor/codex-acp/src/lib.rs`
    - `vendor/codex-acp/src/codex_agent.rs`
    - `vendor/codex-acp/src/prompt_args.rs`
    - `vendor/codex-acp/src/subagents.rs`
    - `vendor/codex-acp/src/thread.rs`
- `Claude-agent-acp-upstream/`
  - vendored snapshot is currently based on `@agentclientprotocol/claude-agent-acp` `0.54.1`
  - upstream tag: `v0.54.1`
  - upstream commit: `15ec9ab0dcd79b417674b11748bfeace629c085d`
  - dependencies match the upstream `0.54.1` release (`@agentclientprotocol/sdk` `1.1.0`, `@anthropic-ai/claude-agent-sdk` `0.3.197`)
  - `dist/` is generated from the upstream source snapshot because the desktop packaging flow depends on it even though upstream does not track it in git
- `acp12/`
  - local package names: `agent-client-protocol-legacy` and
    `agent-client-protocol-schema-legacy`
  - used by the native backend for Grok legacy ACP compatibility
  - kept separate from the current ACP path so Claude, Codex, Kilo, and OpenCode
    can continue to use the current protocol integration

## Current Codex Delta

The Codex vendor is no longer a raw upstream checkout.

The remaining NeverWrite-specific delta exists to preserve desktop product behavior:

- canonical `neverwrite*` ACP metadata for status, plan updates, diffs and `user_input_request`
- reconstruction of `unified_diff` into `old_text`, `new_text` and hunk metadata for inline review and edited-files flows
- mode and approval-preset stability when Codex expands writable roots under `workspace-write`
- custom slash-prompt expansion and Fast service-tier controls exposed to the desktop UI
- session-config synchronization from Codex `SessionConfiguredEvent` back into the ACP session config
- actor lifecycle behavior that does not keep the internal message channel alive after external senders disappear
- subagent thread projection for collaboration events surfaced through the desktop ACP session

When updating Codex again, treat `863d433` plus the current OpenAI Codex crate tag as the comparison base, and review those files intentionally instead of replacing the whole directory blindly.

The desktop backend now supports a mixed ACP world: current ACP integration for
Claude, Codex, Kilo, and OpenCode, plus the vendored
`agent-client-protocol-legacy` crates for Grok. The native backend tests cover
the reconstructed diff, permission, status metadata, and legacy runtime
compatibility paths that NeverWrite depends on.

## Current Claude Delta

The Claude vendor is based on upstream `@agentclientprotocol/claude-agent-acp`
`0.54.1` with no expected NeverWrite-specific source delta.

The `dist/` directory is rebuilt from the vendored source snapshot because the
desktop packaging flow stages the compiled runtime files, while upstream does
not track generated output in git.

Electron release packaging treats the staged Claude runtime as incomplete unless
the packaged resources include:

- `native-backend/embedded/claude-agent-acp/dist/index.js`
- `native-backend/embedded/claude-agent-acp/node_modules/@agentclientprotocol/sdk/package.json`
- `native-backend/embedded/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/package.json`
- `native-backend/embedded/claude-agent-acp/node_modules/zod/package.json`

The only expected local non-source delta is the vendor `.gitignore`: NeverWrite
keeps `dist/` visible to Git so newly emitted runtime files are not missed.

NeverWrite advertises ACP client capabilities through the native backend, not by
patching the vendored Claude runtime. The active capability matrix for the
Claude runtime compatibility work is:

- `fs`: advertised
- `elicitation.form`: advertised; the native backend bridges form requests into
  NeverWrite's user-input UI
- `elicitation.url`: advertised; the native backend bridges URL requests into a
  compact timeline confirmation UI

## Updating Vendored Runtimes

When updating a vendored dependency:

1. Refresh the upstream snapshot to the exact release or commit you intend to ship.
2. Keep `dist/` aligned with the vendored Claude source snapshot.
3. Re-apply only the bounded local product delta that NeverWrite still needs.
4. Remove any local byproducts before committing.
5. Re-run the relevant validation:
   - `cd vendor/codex-acp && cargo test -q`
   - `cargo test -p neverwrite-native-backend`
   - `cd apps/desktop && npm test -- src/features/ai/store/chatStore.test.ts src/features/ai/components/AIReviewView.test.tsx src/features/ai/components/EditedFilesBufferPanel.test.tsx src/features/ai/components/reviewMultiSessionIntegration.test.tsx src/features/ai/components/AIChatMessageList.test.tsx src/features/ai/components/AIChatMessageItem.test.tsx src/features/editor/mergeViewSync.test.ts src/features/editor/extensions/mergeViewDiff.test.ts`

The repository keeps the Claude runtime snapshot broader than the minimum
runtime surface on purpose. The desktop build depends directly on `dist/`, while
the vendored source and test trees stay in-repo for auditability, upstream diff
review, and easier runtime updates.

What should not be committed here:

- local build outputs such as `target/`
- temporary install trees such as `node_modules/`
- transient bundler caches such as `.vite/`

Those generated paths are ignored in the repository root `.gitignore`.
