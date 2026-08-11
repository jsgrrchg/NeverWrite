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
  - upstream baseline: `zed-industries/codex-acp` `0.16.0`
  - synced against upstream commit `863d433fc91855d0b5427372bf635c894bf68cb6`
  - latest upstream adapter sync from adapter `v0.14.0` to `v0.16.0` brought in 5 commits: `d9bf1c1`, `0c2d828`, `8aef91b`, `f67ca5f`, `863d433`
  - OpenAI Codex Rust crates: `rust-v0.147.0` (`be6e8eac029b183056b7e4402879f15d2c85f61b`)
  - vendor ACP SDK: `agent-client-protocol` `0.14.0`
  - ACP wire protocol: v1; ACP v2 is not enabled by this runtime promotion
  - local `vendor/codex-utils-pty/` snapshot: `0.147.0`, with the matching `[patch."https://github.com/openai/codex"]` entry and a standalone local manifest
  - resolved V8 crate: `150.4.0`, built with OpenAI's verified `ptrcomp_sandbox_release` archive and source binding for the target
  - Rust toolchain: NeverWrite `1.96.0`; upstream Codex `1.95.0`
  - local NeverWrite delta remains intentionally bounded and currently lives in:
    - `vendor/codex-acp/Cargo.toml`
    - `vendor/codex-acp/Cargo.lock`
    - `vendor/codex-acp/src/lib.rs`
    - `vendor/codex-acp/src/main.rs`
    - `vendor/codex-acp/src/codex_agent.rs`
    - `vendor/codex-acp/src/prompt_args.rs`
    - `vendor/codex-acp/src/subagents.rs`
    - `vendor/codex-acp/src/thread.rs`
    - `vendor/codex-acp/vendor/codex-utils-pty/`
- `Claude-agent-acp-upstream/`
  - vendored snapshot is currently based on `@agentclientprotocol/claude-agent-acp` `0.66.0`
  - upstream tag: `v0.66.0`
  - upstream commit: `6b405138fc82be947964612fac04e56654827b66`
  - dependencies match the upstream `0.66.0` release (`@agentclientprotocol/sdk` `1.3.0`, `@anthropic-ai/claude-agent-sdk` `0.3.220`, `@anthropic-ai/sdk` `0.115.0`)
  - `dist/` is generated from the upstream source snapshot because the desktop packaging flow depends on it even though upstream does not track it in git
- `acp12/`
  - local package names: `agent-client-protocol-legacy` and
    `agent-client-protocol-schema-legacy`
  - used by the native backend for Grok legacy ACP compatibility
  - kept separate from the current ACP path so Claude, Codex, Kilo, and OpenCode
    can continue to use the current protocol integration

## Current Codex Delta

The Codex vendor is no longer a raw upstream checkout. Its runtime compatibility baseline is OpenAI Codex `rust-v0.147.0`, resolved to `be6e8eac029b183056b7e4402879f15d2c85f61b` in `Cargo.lock`.

The remaining NeverWrite-specific delta exists to preserve desktop product behavior:

- canonical `neverwrite*` and `codexAcp*` ACP metadata for status, turn lifecycle, plan updates, diffs, `user_input_request`, and child-session relationships
- reconstruction of `unified_diff` into `old_text`, `new_text` and hunk metadata for inline review and edited-files flows
- review-mode and review-finding adaptation while preserving inline review and accept/reject flows
- permission, mode, and approval-preset stability when Codex expands writable roots under `workspace-write`
- custom slash-prompt discovery and expansion without moving NeverWrite's prompt queue
- model discovery through the route-aware HTTP client, Fast service-tier controls, and refreshed `ConfigOptionUpdate` values after successful model selection
- session-config synchronization from Codex `SessionConfiguredEvent` and thread snapshots, preserving model, provider, reasoning effort, service tier, and reviewer
- authentication/keyring selection, async login, reload, logout, and API-key flows without changing NeverWrite's credential policy
- MCP transport compatibility through `ClientMcpExtensions`, while retaining client-provided environment, cwd, auth, and approval settings
- explicit `PathUri` boundaries: UI paths use runtime rendering helpers and operational paths convert back to host-native paths
- state DB lookup plus thread-store and installation-ID wiring used by list, load, resume, fork, reconnect, and child-thread registration
- actor lifecycle behavior that does not keep the internal message channel alive after external senders disappear
- subagent sessions with typed `ThreadId` identity, descriptive `agent_path` metadata, idempotent registration, and reconciliation after missed child-thread broadcasts
- a private `codexAcp*` subagent contract for session creation, navigable activity breadcrumbs, child lifecycle, and receiver-owned inter-agent transcripts
- per-turn coalescing of equivalent subagent waits; only fully terminal status sets complete the ACP activity
- localized `StartThreadOptions`, shared models-manager, external code-mode provider, config, auth, MCP, permission, and thread-store adapters at the ACP boundary
- a local `codex-utils-pty` `0.147.0` snapshot that preserves its standalone manifest and NeverWrite's macOS process-group member fallback while adopting upstream Windows Job Objects, ConPTY/input changes, and tests

The 0.147 deferred turn items are handled as localized projections. `SubAgentActivity` is projected through the same canonical activity identity as its `TurnItem` fallback: matching protocol IDs update one ACP tool call, while distinct IDs remain separate rather than being correlated by descriptive metadata. Child `ThreadId` values remain authoritative; paths, nicknames, and roles are display metadata only.

The desktop release pipeline packages `codex-acp` and `codex-code-mode-host` as one runtime unit for macOS universal, Windows x64/ARM64, and Linux x64/ARM64. Each release build is lockfile-pinned, target-architecture checked, and signed together. Its packaged smoke drives an ACP `initialize`, `session/new`, and `session/prompt` exchange through the standalone host with a deterministic local Responses mock, verifies both the tool completion and assistant response, and proves a missing sibling host fails closed.

When updating Codex again, treat upstream ACP commit `863d433fc91855d0b5427372bf635c894bf68cb6`, OpenAI Codex tag `rust-v0.147.0` at `be6e8eac029b183056b7e4402879f15d2c85f61b`, the local PTY `0.147.0` snapshot, V8 `150.4.0`, and the committed lockfile as one comparison base. Review the bounded delta file by file instead of replacing the vendor tree.

Canonical compatibility checks:

```bash
HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
cd apps/desktop
node scripts/run-with-codex-v8.mjs --target "$HOST_TARGET" -- cargo check --locked --manifest-path ../../vendor/codex-acp/Cargo.toml
node scripts/run-with-codex-v8.mjs --target "$HOST_TARGET" -- cargo test --locked --manifest-path ../../vendor/codex-acp/Cargo.toml
```

## Codex 0.147.0 Compatibility Baseline

The embedded runtime is pinned to OpenAI Codex `rust-v0.147.0`. Every Codex git dependency in `codex-acp/Cargo.toml` uses that tag, and `Cargo.lock` resolves it to `be6e8eac029b183056b7e4402879f15d2c85f61b`. The local `codex-utils-pty` snapshot is also `0.147.0`; it is part of the same runtime baseline, not an independently updatable crate.

The vendor toolchain inherits Rust `1.96.0` from the repository-root `rust-toolchain.toml`, which is compatible with the upstream Codex `1.95.0` toolchain. This promotion deliberately does not change these protocol boundaries:

- the `codex-acp` adapter package remains `0.16.0`
- the vendored ACP Rust SDK remains `agent-client-protocol` `0.14.0`
- the adapter remains on ACP wire protocol v1; `unstable_protocol_v2` is not enabled
- the desktop native backend remains `agent-client-protocol` `1.2.0`, which it communicates through the serialized ACP protocol rather than a shared Rust crate boundary

### Lockfile and V8 provisioning

The committed `Cargo.lock` is part of the runtime pin. In particular, `rama-core`, `rama-error`, and `rama-utils` must remain coordinated at `0.3.0-alpha.4`, matching the upstream 0.147 lock. A broad lockfile regeneration can select the stable `rama-error 0.3.0` next to prerelease peers and produce an incompatible graph, so future promotions must compare these packages with the candidate tag and update them as a coordinated set.

The lockfile resolves `v8 150.4.0`. `apps/desktop/scripts/codex-v8-artifacts.mjs` obtains the target-specific `ptrcomp_sandbox_release` archive, source binding, and SHA-256 manifest from the official `openai/codex` release `rusty-v8-v150.4.0`. It authenticates the downloaded or cached manifest against the target-specific digest pinned in `apps/desktop/scripts/codex-v8-manifest-pins.mjs` before downloading archives or bindings, requires the manifest to cover exactly both artifacts, verifies their checksums before use, and caches the verified set under `apps/desktop/.cache/codex-v8/<version>/<profile>/<target>/`.

Local builds may provide `RUSTY_V8_ARCHIVE` and `RUSTY_V8_SRC_BINDING_PATH` only as a pair. A partial override fails immediately. Release and package-smoke CI use `--require-verified-artifacts`, which rejects direct overrides and `V8_FROM_SOURCE`; each target therefore compiles against the verified OpenAI pair selected for that target.

### Product behavior covered by this baseline

- `TurnItem::Extension(ExtensionItem::Sleep(...))` is projected as the canonical `Waiting` activity and keeps stable item identity across live events and replay.
- `ItemCompleted.started_at_ms` is propagated into activity metadata when positive so restored activities keep their upstream start time. Turn-level `started_at` fields are accepted but do not invent a second timeline contract.
- `TurnComplete.error` emits a visible failed `turn_error` status and fails the pending ACP prompt instead of reporting `EndTurn`; aborts remain cancelled and keep their lifecycle event.
- `RawResponseCompleted` is logged without a separate ACP projection because `TokenCount` remains the authoritative accumulated usage signal. Projecting both would overwrite or duplicate usage.
- `EnvironmentConnected` and `EnvironmentDisconnected` are logged without transcript activity because remote runtime environments are outside the current ACP v1 product contract.
- Code mode requires the standalone sibling `codex-code-mode-host`; the runtime disables the in-process fallback, packaging and signing include both binaries, and the smoke proves the host process runs.
- A definitive dangerous-command policy rejection is projected as a failed, terminal ACP tool activity with its visible reason; it never becomes an ACP permission request.
- Thread metadata synchronizes both a selected reasoning effort and an explicit clearing of it, preventing a stale value after load, resume, or fork.
- Model context-window metadata remains dynamic. Regression coverage exercises the 272K context window reported for Sol, Terra, and Luna without hard-coding that size into the runtime.
- The public Full Access label and its ACP description remain unchanged. The UI adds only contextual help explaining that Codex safety policy can still block some destructive command forms.

### Intentionally deferred capabilities

This baseline does not enable MCP protocol `2026-07-28`, expose `--approve-for-me`, update the ACP SDK beyond `agent-client-protocol 0.14.0`, or migrate the adapter to ACP v2. Each changes a protocol, permission, or client contract and requires separate compatibility work.

The App Server adapter `1.1.4` remains an architectural follow-up rather than a replacement. It must demonstrate parity for sessions, configuration, permissions, review, inline changes, and accept/reject flows before it can replace the current adapter.

Portable plugins, thread sections/pinning, side conversations, audio/realtime, external imports, and Bedrock support are also deferred. NeverWrite does not expose a local projection merely because the upstream runtime can represent one. The Goal contract remains tracked separately in issue `#387`.

### Packaged code-mode smoke matrix

| Package target | Executes the functional ACP code-mode smoke | Coverage when it cannot execute |
| --- | --- | --- |
| macOS universal | Yes, on a native runner slice | Both packaged host slices are staged |
| Windows x64 and ARM64 | Yes | — |
| Linux x64 | Yes | — |
| Linux ARM64 | No, because it is cross-compiled | Packaging, sidecar staging, and architecture checks run without executing the foreign binary |

The smoke uses a temporary `CODEX_HOME`, a local deterministic Responses mock, and the 0.147 install-context layout where the packaged host is a sibling of `codex-acp`. It asserts a real ACP turn reaches both a code-mode tool completion and a final assistant response, and it inspects the ACP process tree to prove the packaged standalone host was launched rather than an in-process fallback.

The same smoke starts an isolated copy of `codex-acp` without its sibling host and requires the code-mode tool to fail closed with the missing host path in its diagnostic. It does not require credentials or a network service.

### Follow-up and rollback

#### Historical rollback baseline

The known rollback baseline is OpenAI Codex `rust-v0.144.6` at `5d1fbf26c43abc65a203928b2e31561cb039e06d`, local PTY `0.144.6`, V8 `149.2.0` with the standard `release` artifact profile, and the lockfile recorded by NeverWrite commit `248a743f`. A rollback must restore `vendor/codex-acp/Cargo.toml`, `vendor/codex-acp/Cargo.lock`, `vendor/codex-acp/vendor/codex-utils-pty/`, the V8 artifact profile, and any 0.147-only adapter API changes as one reviewed unit. Never roll back a single Codex crate, PTY snapshot, V8 profile, or lockfile independently.

The desktop backend supports a mixed ACP world: current ACP integration for Claude, Codex, Kilo, and OpenCode, plus the vendored `agent-client-protocol-legacy` crates for Grok. The native backend tests cover the reconstructed diff, permission, status metadata, and legacy runtime compatibility paths that NeverWrite depends on.

## Current Claude Delta

The Claude vendor is based on upstream `@agentclientprotocol/claude-agent-acp` `0.66.0` at commit `6b405138fc82be947964612fac04e56654827b66`, with no NeverWrite-specific runtime source delta.

The previous NeverWrite trailer-parsing hardening is fully absorbed by upstream. Version `0.66.0` retains the linear-time ReDoS protection and its whole-line matching, so no local runtime patch needs to be reapplied.

Upstream `0.66.0` includes an opt-in `subagent-transcript` client capability. NeverWrite does not advertise that capability, so Claude keeps the legacy behavior that filters nested subagent text and thinking from the top-level feed. Rich nested transcript integration remains intentionally out of scope.

Upstream `0.66.0` also publishes the provider-neutral `_meta.goal` extension. NeverWrite does not yet consume goal snapshots or expose goal controls; that product integration is tracked separately in issue `#377` and is intentionally out of scope for this vendor update.

The `dist/` directory is rebuilt from the vendored source snapshot because the
desktop packaging flow stages the compiled runtime files, while upstream does
not track generated output in git.

Electron release packaging treats the staged Claude runtime as incomplete unless
the packaged resources include:

- `native-backend/embedded/claude-agent-acp/dist/index.js`
- `native-backend/embedded/claude-agent-acp/node_modules/@agentclientprotocol/sdk/package.json`
- `native-backend/embedded/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/package.json`
- `native-backend/embedded/claude-agent-acp/node_modules/zod/package.json`

The only expected local non-source delta is generated `dist/`, which upstream does not commit. The vendor `.gitignore` matches upstream, so newly generated files must be force-added when the snapshot is refreshed.

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
   - the target-aware vendor check and test commands in the canonical compatibility checks above
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
