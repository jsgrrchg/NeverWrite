# Vendored Dependencies

This directory is committed on purpose.

NeverWrite currently vendors upstream runtime projects that are needed for desktop
integration and release packaging, especially:

- `codex-acp`

Why this lives in git:

- release builds depend on these runtimes being available locally
- the desktop packaging flow stages binaries and runtime assets from here
- keeping the sources in-repo makes release inputs explicit and reproducible

What is currently required by the app/build pipeline:

- `codex-acp/`
  - used as a Rust crate and sidecar build input during desktop release builds

What is vendored mainly for auditability and maintenance, not direct runtime use:

- upstream Rust manifests, lockfiles, and documentation

That means the directory is intentionally reproducible, but not yet minimal.

## Current Baselines

- `codex-acp/`
  - upstream baseline: `zed-industries/codex-acp` `0.16.0`
  - synced against upstream adapter commit `bb590500e8646f6daf879b8b3c6a659fbd29017d`
  - OpenAI Codex Rust crates: `rust-v0.155.1` (`be2951ea34f0d295ed0becf97079f92fa5f6950e`)
  - vendor ACP SDK: `agent-client-protocol` `0.14.0`
  - ACP wire protocol: v1; ACP v2 is not enabled by this runtime promotion
  - local `vendor/codex-utils-pty/` snapshot: `0.155.1`, with the matching `[patch."https://github.com/openai/codex"]` entry and a standalone local manifest
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

## Current Codex Delta

The Codex vendor is no longer a raw upstream checkout. Its runtime compatibility baseline is OpenAI Codex `rust-v0.155.1`, resolved to `be2951ea34f0d295ed0becf97079f92fa5f6950e` in `Cargo.lock`.

The remaining NeverWrite-specific delta exists to preserve desktop product behavior:

- canonical `neverwrite*` and `codexAcp*` ACP metadata for status, turn lifecycle, plan updates, diffs, `user_input_request`, and child-session relationships
- reconstruction of `unified_diff` into `old_text`, `new_text` and hunk metadata for inline review and edited-files flows
- review-mode and review-finding adaptation while preserving inline review and accept/reject flows
- permission, mode, and approval-preset stability when Codex expands writable roots under `workspace-write`
- custom slash-prompt discovery and expansion without moving NeverWrite's prompt queue
- account-aware model discovery through the route-aware HTTP client, upstream visibility filtering, explicit raw model selection, Fast service-tier controls, and refreshed `ConfigOptionUpdate` values after successful model selection
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
- a local `codex-utils-pty` `0.155.1` snapshot with its standalone manifest, native executable-path encoding, upstream Unix process-group fallback, Windows Job Object and ConPTY path handling, and the upstream platform tests

The runtime turn-input boundary uses `TurnInputRequest` with `StartIfIdle` and consumes the runtime acknowledgement before registering the ACP prompt. `NotSubmitted` and an impossible `Steered` acknowledgement resolve as ACP errors instead of leaving a response pending.

The runtime event delta is handled as localized projections. Authentication recovery is visible as status activity, misalignment details survive the ACP error boundary, unsupported OpenAI elicitation forms fail closed, MCP policy amendments are exposed only when offered, Guardian stdin reviews redact the input payload, image failures retain their reason, standalone function outputs do not invent a call identity, and `ThreadQueueChanged` stays diagnostic because NeverWrite owns the user-facing queue.

`SubAgentActivity` is projected through the same canonical activity identity as its `TurnItem` fallback: matching protocol IDs update one ACP tool call, while distinct IDs remain separate rather than being correlated by descriptive metadata. `SendMessage`, `FollowupTask`, `InterruptAgent`, `ListAgents`, and `Completed` preserve their runtime IDs and terminal semantics. Child `ThreadId` values remain authoritative; paths, nicknames, and roles are display metadata only.

Reasoning options come from each runtime model preset. `max`, `ultra`, and future custom values cross the adapter dynamically; the native backend recognizes the two new suffixes without treating `xhigh` as a universal maximum.

The desktop release pipeline packages `codex-acp` and `codex-code-mode-host` as one runtime unit for macOS universal, Windows x64/ARM64, and Linux x64/ARM64. Each release build is lockfile-pinned, target-architecture checked, and signed together. Its packaged smoke drives an ACP `initialize`, `session/new`, and `session/prompt` exchange through the standalone host with a deterministic local Responses mock, verifies both the tool completion and assistant response, and proves a missing sibling host fails closed.

When updating Codex again, treat upstream adapter commit `bb590500e8646f6daf879b8b3c6a659fbd29017d`, OpenAI Codex tag `rust-v0.155.1` at `be2951ea34f0d295ed0becf97079f92fa5f6950e`, the local PTY `0.155.1` snapshot, V8 `150.4.0`, and the committed lockfile as one comparison base. Review the bounded delta file by file instead of replacing the vendor tree.

Canonical compatibility checks:

```bash
HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
cd apps/desktop
node scripts/run-with-codex-v8.mjs --target "$HOST_TARGET" -- cargo check --locked --manifest-path ../../vendor/codex-acp/Cargo.toml
node scripts/run-with-codex-v8.mjs --target "$HOST_TARGET" -- cargo test --locked --manifest-path ../../vendor/codex-acp/Cargo.toml
```

## Codex 0.155.1 Compatibility Baseline

The embedded runtime is pinned to OpenAI Codex `rust-v0.155.1`. Every Codex git dependency in `codex-acp/Cargo.toml` uses that tag, and `Cargo.lock` resolves it to `be2951ea34f0d295ed0becf97079f92fa5f6950e`. The local `codex-utils-pty` snapshot is also `0.155.1`; it is part of the same runtime baseline, not an independently updatable crate.

The vendor toolchain inherits Rust `1.96.0` from the repository-root `rust-toolchain.toml`, which is compatible with the upstream Codex `1.95.0` toolchain. This promotion deliberately does not change these protocol boundaries:

- the `codex-acp` adapter package remains `0.16.0`
- the vendored ACP Rust SDK remains `agent-client-protocol` `0.14.0`
- the adapter remains on ACP wire protocol v1; `unstable_protocol_v2` is not enabled
- the desktop native backend remains `agent-client-protocol` `1.2.0`, which it communicates through the serialized ACP protocol rather than a shared Rust crate boundary

### Changes from 0.153.4

NeverWrite maintains the Rust adapter fork directly against pinned OpenAI Codex
releases. The archived Zed adapter remains its provenance, not an update source.
The product's ACP v1 and private metadata contracts remain the compatibility
boundary; this update does not migrate to App Server.

Codex 0.155.1 removes `codex-mcp-server`. The unused public re-exports and their
dependency have been removed; the adapter still supports client MCP servers.
`ThreadManager` receives upstream's inline image store. Permission summaries use
executor-native `LegacyAppPathString` values, and local workspace mode detection
uses the explicit local-path policy API. Both general and host-owned Codex Apps
MCP 2026-07-28 flags are disabled at the ACP 0.14 boundary. Native user-verification
elicitations are declined through the existing unsupported-request path.

Thread settings distinguish absent runtime workspace roots from an explicit empty
selection. New plugin-selection and response-configuration history fields stay
runtime-owned. Declined turn admission, including `ServerDraining`, still returns
an ACP error before any pending prompt is registered. Model discovery uses the
upstream identity-scoped cache and the existing `OnlineIfUncached` adapter route.
API-key model discovery remains subject to upstream configuration.

All compared upstream PTY Rust sources are identical to 0.153.4. The standalone
manifest advances to 0.155.1 while retaining the local Windows compatibility
adjustments. V8 remains 150.4.0. Outside the Codex packages and local PTY version,
the lockfile changes are RMCP 3.1.3 to 3.2.0 and the new `rand_regex 0.18.1` package.

### Lockfile and V8 provisioning

The committed `Cargo.lock` is part of the runtime pin. In particular, `rama-core`, `rama-error`, `rama-macros`, and `rama-utils` must remain coordinated at `0.3.0-alpha.4`, matching the upstream 0.155.1 dependency graph. A broad lockfile regeneration can select stable Rama packages next to prerelease peers and produce an incompatible graph, so future promotions must compare this family with the candidate tag and update it as a coordinated set.

The lockfile resolves `v8 150.4.0`. `apps/desktop/scripts/codex-v8-artifacts.mjs` obtains the target-specific `ptrcomp_sandbox_release` archive, source binding, and SHA-256 manifest from the official `openai/codex` release `rusty-v8-v150.4.0`. It authenticates the downloaded or cached manifest against the target-specific digest pinned in `apps/desktop/scripts/codex-v8-manifest-pins.mjs` before downloading archives or bindings, requires the manifest to cover exactly both artifacts, verifies their checksums before use, and caches the verified set under `apps/desktop/.cache/codex-v8/<version>/<profile>/<target>/`.

Local builds may provide `RUSTY_V8_ARCHIVE` and `RUSTY_V8_SRC_BINDING_PATH` only as a pair. A partial override fails immediately. Release and package-smoke CI use `--require-verified-artifacts`, which rejects direct overrides and `V8_FROM_SOURCE`; each target therefore compiles against the verified OpenAI pair selected for that target.

### Product behavior covered by this baseline

- ACP prompts start only while the runtime is idle. The one-shot turn acknowledgement is consumed before local prompt state is registered, so declined submissions cannot hang or steer an active turn.
- MCP persistent approval, Guardian `WriteStdin`, image-generation failures, optional function-call IDs, `PathUri`, and runtime queue notifications have explicit safe projections.
- Collaboration tools `SendMessage`, `FollowupTask`, `InterruptAgent`, and `ListAgents` preserve runtime activity identity. `SubAgentActivityKind::Completed` terminalizes that identity once, while internal agent messages remain outside the parent transcript.
- Reasoning efforts are catalog-driven, including `max`, `ultra`, and future custom values. Load, resume, fork, and model changes retain an effort only when the selected model supports it.
- The normal model picker follows the authenticated remote catalog and its visibility flags. The bundled fallback catalog lists GPT-6 Astra and selects it by default when no model is configured. A valid ChatGPT account catalog remains authoritative, and explicit model selections survive the default change. The Codex-only exact model-ID path remains available for unlisted models.
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

This baseline does not add Bedrock onboarding, visible task references, a second runtime-owned prompt queue, TUI-only commands, MCP protocol `2026-07-28`, `--approve-for-me`, an ACP SDK update beyond `agent-client-protocol 0.14.0`, ACP v2, or an App Server migration. Each changes a product, protocol, permission, or client contract and requires separate compatibility work.

The App Server adapter remains an architectural follow-up rather than a replacement. It must demonstrate parity for sessions, configuration, permissions, review, inline changes, and accept/reject flows before it can replace the current adapter.

Portable plugins, thread sections/pinning, side conversations, audio/realtime, external imports, and Bedrock support are also deferred. NeverWrite does not expose a local projection merely because the upstream runtime can represent one. The Goal contract remains tracked separately in issue `#387`.

### Packaged code-mode smoke matrix

| Package target | Executes the functional ACP code-mode smoke | Coverage when it cannot execute |
| --- | --- | --- |
| macOS universal | Yes, on a native runner slice | Both packaged host slices are staged |
| Windows x64 and ARM64 | Yes | — |
| Linux x64 | Yes | — |
| Linux ARM64 | No, because it is cross-compiled | Packaging, sidecar staging, and architecture checks run without executing the foreign binary |

The smoke uses a temporary `CODEX_HOME`, a local deterministic Responses mock, and the 0.155.1 install-context layout where the packaged host is a sibling of `codex-acp`. It checks that an ACP image reaches Responses as inline image content, asserts a real ACP turn reaches both a code-mode tool completion and a final assistant response, and inspects the ACP process tree to prove the packaged standalone host was launched rather than an in-process fallback.

The same smoke starts an isolated copy of `codex-acp` without its sibling host and requires the code-mode tool to fail closed with the missing host path in its diagnostic. It does not require credentials or a network service.

Linux x64 package CI also runs the vendor's unit tests and standalone-host
integration tests in the release profile, reusing the verified V8 artifacts.

Local validation for this promotion on Linux x64 passed 107 adapter unit tests,
2 standalone-host integration tests, 374 native-backend tests, 550 selected
frontend product tests and 63 staging/V8 tests. The staged-resource smoke passed
with locally built debug Codex binaries, including inline images, standalone
code mode, a missing host, native-backend ping and the existing Claude smoke.
Other platform builds, signing and complete release packaging remain covered by
the package CI matrix rather than this local run.

### Follow-up and rollback

#### Rollback baseline

The rollback baseline is OpenAI Codex `rust-v0.153.4` at
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, local PTY `0.153.4`, V8 `150.4.0`,
and the lockfile in NeverWrite commit `7b71e37f67b6c9417ca159a1056f472dc421a2fd`.
Restore the runtime manifest, lockfile,
PTY manifest, staging baseline, fixtures and documentation together; rebuild and
stage both binaries. Do not downgrade one crate or one executable independently.

The state migration adds `threads.originator` and `threads.daybreak_enabled`, and
renames `thread_artifacts` to `thread_attachments` (including its type column and
index). The old runtime tolerates newer migration records, but that alone is not
a guarantee that every new feature's persisted data can be consumed by it.
Before a deployment rollback, stop all processes sharing the affected
`CODEX_HOME` and retain a consistent backup of that directory. Do not edit
`_sqlx_migrations` or attempt ad hoc SQL downgrades.

The deterministic upgrade smoke creates a real 0.153.4 conversation, then lists,
loads, continues and closes it with 0.155.1, 0.153.4 and 0.155.1 in sequence. It
uses an isolated temporary `CODEX_HOME` and a loopback Responses mock, and checks
model selection, ACP replay and model-visible conversation continuity. Its scope
is the local text, inline-image and code-mode session path; it does not certify rollback of new
attachment features, remote environments, or every user database.

A separate local schema inspection confirmed `state_5.sqlite` advanced from
migration 52 to 55 and retained the same session row after reopening with
0.153.4, with migration 55 still recorded.

```bash
cd apps/desktop
node scripts/smoke-codex-runtime-upgrade.mjs \
  --previous /path/to/0.153.4/codex-acp \
  --current /path/to/0.155.1/codex-acp
```

Each executable must have its matching `codex-code-mode-host` sibling. Build the
previous pair before updating, retain it outside the checkout, then build the new
pair using the verified V8 wrapper. The smoke deletes its temporary state.

The desktop backend supports a mixed ACP world: current ACP integration for Claude, Codex, Kilo, and OpenCode, plus the vendored `agent-client-protocol-legacy` crates for Grok. The native backend tests cover the reconstructed diff, permission, status metadata, and legacy runtime compatibility paths that NeverWrite depends on.

## Claude Runtime Dependency

Claude ACP is consumed as an exact npm dependency and is no longer vendored.
Its isolated manifest, lockfile, compatibility baseline, and
maintenance instructions live in
[`apps/desktop/runtimes/claude/`](../apps/desktop/runtimes/claude/README.md).
Development and Electron releases use the same preparer, which generates the
existing embedded runtime layout without committing upstream source or dist.

## Updating Vendored Runtimes

When updating a vendored dependency:

1. Refresh the upstream snapshot to the exact release or commit you intend to ship.
2. Re-apply only the bounded local product delta that NeverWrite still needs.
3. Remove any local byproducts before committing.
4. Re-run the relevant validation:
   - the target-aware vendor check and test commands in the canonical compatibility checks above
   - `cargo test -p neverwrite-native-backend`
   - `cd apps/desktop && npm test -- src/features/ai/store/chatStore.test.ts src/features/ai/components/AIReviewView.test.tsx src/features/ai/components/EditedFilesBufferPanel.test.tsx src/features/ai/components/reviewMultiSessionIntegration.test.tsx src/features/ai/components/AIChatMessageList.test.tsx src/features/ai/components/AIChatMessageItem.test.tsx src/features/editor/mergeViewSync.test.ts src/features/editor/extensions/mergeViewDiff.test.ts`

What should not be committed here:

- local build outputs such as `target/`
- temporary install trees such as `node_modules/`
- transient bundler caches such as `.vite/`

Those generated paths are ignored in the repository root `.gitignore`.
