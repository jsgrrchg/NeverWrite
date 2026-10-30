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
  - OpenAI Codex Rust crates: `rust-v0.166.0` (`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`)
  - vendor ACP SDK: `agent-client-protocol` `0.14.0`
  - ACP wire protocol: v1; ACP v2 is not enabled by this runtime promotion
  - local `vendor/codex-utils-pty/` snapshot: `0.166.0`, with the matching `[patch."https://github.com/openai/codex"]` entry and a self-contained manifest in the adapter workspace
  - resolved V8 crate: `152.2.0` with Rust-side cppgc alignment patch `350c5a859a9b3c84ab8701b3ad51e3b7699b30c0` from `seanh-oai/rusty_v8`, built with OpenAI's verified `ptrcomp_sandbox_release` archive and source binding for the target
  - Rust toolchain: NeverWrite `1.99.1` (upstream Codex `1.95.0`)
  - local NeverWrite delta remains intentionally bounded and currently lives in:
    - `vendor/codex-acp/Cargo.toml`
    - `vendor/codex-acp/Cargo.lock`
    - `vendor/codex-acp/src/lib.rs`
    - `vendor/codex-acp/src/main.rs`
    - `vendor/codex-acp/src/codex_agent.rs`
    - `vendor/codex-acp/src/prompt_args.rs`
    - `vendor/codex-acp/src/subagents.rs`
    - `vendor/codex-acp/src/thread.rs`
    - `vendor/codex-acp/src/thread/paginated_history.rs`
    - `vendor/codex-acp/vendor/codex-utils-pty/`

## Current Codex Delta

The Codex vendor is no longer a raw upstream checkout. Its runtime compatibility baseline is OpenAI Codex `rust-v0.166.0`, resolved to `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` in `Cargo.lock`.

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
- a local `codex-utils-pty` `0.166.0` snapshot with its self-contained manifest, native executable-path encoding, upstream Unix process-group fallback, Windows Job Object and ConPTY path handling, and the upstream platform tests

The runtime turn-input boundary uses `TurnInputRequest` with `StartIfIdle` and consumes the runtime acknowledgement before registering the ACP prompt. `NotSubmitted` and an impossible `Steered` acknowledgement resolve as ACP errors instead of leaving a response pending.

The runtime event delta is handled as localized projections. Authentication recovery is visible as status activity, misalignment details survive the ACP error boundary, unsupported OpenAI elicitation forms fail closed, MCP policy amendments are exposed only when offered, Guardian stdin reviews redact the input payload, image failures retain their reason, standalone function outputs do not invent a call identity, and `ThreadQueueChanged` stays diagnostic because NeverWrite owns the user-facing queue.

`SubAgentActivity` is projected through the same canonical activity identity as its `TurnItem` fallback: matching protocol IDs update one ACP tool call, while distinct IDs remain separate rather than being correlated by descriptive metadata. `SendMessage`, `FollowupTask`, `InterruptAgent`, `ListAgents`, and `Completed` preserve their runtime IDs and terminal semantics. Child `ThreadId` values remain authoritative; paths, nicknames, and roles are display metadata only.

Reasoning options come from each runtime model preset. `max`, `ultra`, and future custom values cross the adapter dynamically; the native backend recognizes the two new suffixes without treating `xhigh` as a universal maximum.

The desktop release pipeline packages `codex-acp` and `codex-code-mode-host` as one runtime unit for macOS universal, Windows x64/ARM64, and Linux x64/ARM64. Each release build is lockfile-pinned, target-architecture checked, and signed together. Its packaged smoke drives an ACP `initialize`, `session/new`, and `session/prompt` exchange through the standalone host with a deterministic local Responses mock, verifies both the tool completion and assistant response, and proves a missing sibling host fails closed.

When updating Codex again, treat upstream adapter commit `bb590500e8646f6daf879b8b3c6a659fbd29017d`, OpenAI Codex tag `rust-v0.166.0` at `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, the local PTY `0.166.0` snapshot, V8 `152.2.0`, and the committed lockfile as one comparison base. Review the bounded delta file by file instead of replacing the vendor tree.

Canonical compatibility checks:

```bash
HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
cd apps/desktop
node scripts/run-with-codex-v8.mjs --target "$HOST_TARGET" -- cargo check --locked --manifest-path ../../vendor/codex-acp/Cargo.toml
node scripts/run-with-codex-v8.mjs --target "$HOST_TARGET" -- cargo test --locked --manifest-path ../../vendor/codex-acp/Cargo.toml --workspace
```

## Codex 0.166.0 Compatibility Baseline

The embedded runtime is pinned to OpenAI Codex `rust-v0.166.0`. Every Codex git dependency in `codex-acp/Cargo.toml` uses that tag, and `Cargo.lock` resolves it to `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. The local `codex-utils-pty` snapshot is also `0.166.0`; it is part of the same runtime baseline, not an independently updatable crate.

The vendor toolchain inherits Rust `1.99.1` from the repository-root `rust-toolchain.toml`, retained independently of upstream Codex `1.95.0`. This promotion deliberately does not change these protocol boundaries:

- the `codex-acp` adapter package remains `0.16.0`
- the vendored ACP Rust SDK remains `agent-client-protocol` `0.14.0`
- the adapter remains on ACP wire protocol v1; `unstable_protocol_v2` is not enabled
- the desktop native backend remains `agent-client-protocol` `3.3.0` with schema `1.11.0`, which it communicates through the serialized ACP protocol rather than a shared Rust crate boundary

### Changes from 0.164.0

All OpenAI Codex crates and the complete local PTY snapshot move together to
`rust-v0.166.0` at `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. Rebuild and stage
both `codex-acp` and `codex-code-mode-host` from the committed lockfile.

The display-history schema splits app-server `ThreadItem` into a timed wrapper
and `ThreadItemPayload`. Stored history decodes the payload directly and retains
the authoritative lifecycle times from `StoredThreadItem` columns. Paginated
replay continues to preserve ordered messages, diffs, child activities and wait
identity across page boundaries; `session/resume` does not replay that history.

The new in-process `PrivateSessionEvent` belongs to a private reviewer. It is
ignored by the parent ACP projection so recorded reviewer content cannot leak
into the transcript and reviewer cancellation cannot resolve the parent prompt.
Image completion constructors accept the new optional `generation_id`, carrying
it from extension-owned image items when available. Existing image identities
and file-backed attachment handling remain unchanged. Token fixtures accept
`last_usage_includes_reasoning`; accumulated ACP usage still comes from the
runtime's authoritative `TokenCount` projection.

The V8 crate remains `152.2.0`, but upstream patches it to
`https://github.com/seanh-oai/rusty_v8.git` revision
`350c5a859a9b3c84ab8701b3ad51e3b7699b30c0`. This fixes Rust cppgc pointer
alignment without changing C++ code, bindings or provisioning. The adapter
workspace declares the patch explicitly because dependency patches are not
inherited. Staging verifies both the effective manifest patch and the exact
lockfile source and commit, rather than accepting the version number alone.
The existing six target-specific verified archive/binding pairs and checksum
pins remain at `152.2.0`.

The PTY snapshot includes separate stdout/stderr readers, waiting for Unix
process-group exit, and Windows process-handle and Job Object termination
changes. Its self-contained manifest, Windows pointer adaptations and macOS
high-stdio fallback are retained. Native platform execution remains part of
the package CI matrix.

Runtime fixes for permission restoration, agent-message interruption and
reasoning-token accounting are supplied by upstream. Model catalog discovery
remains account-aware and explicit selections remain authoritative; the bundled
catalog now also includes GPT-6.1 Terra. ACP v1, start-if-idle admission, the
application-owned prompt queue and the verified stdio host transport are retained.

### Retained changes from 0.162.1 to 0.164.0

All OpenAI crates and the local PTY snapshot use `rust-v0.164.0` at
`6aaac694803004a63c6f393d153c96d22521a6b9`. Rust is aligned with upstream
at `1.99.1`; V8 moves to `152.2.0`. The staging baseline and checksum manifest
pins cover all six supported target triples. The previous V8 `150.4.0` pins
remain available for independently building the rollback pair. Rebuild and
stage `codex-acp` and `codex-code-mode-host` together.

The extension-owned `ImageGenerationEndEvent` and display-history image item now
carry `GeneratedImageRef`, either inline `result` data or a durable `fileId`.
Live events and paginated replay preserve both variants. Legacy hosted image
items and older inline rollouts retain their existing ACP `result` field.
File-backed images preserve `fileId` in ACP and `file_id` in desktop events and
message metadata; the UI shows the attachment identity if no local image path
is available. NeverWrite still uses upstream's passthrough attachment store:
this promotion does not add a remote attachment resolver or treat file IDs as
image bytes, URLs, or local paths. Saved local paths retain the existing preview
and open/reveal actions. Structured image failures remain authoritative.

`ListItemsParams.item_ids` is explicitly unset for full paginated replay.
Existing start and resume helpers retain upstream defaults for prompt-cache
policy and resume preparation. Session model, reasoning, permissions and
load-versus-resume replay contracts remain covered by compatibility tests.

MCP `ElicitationAbandoned` uses a synthetic event ID, so the adapter routes it
by server and original request token across active submissions and event
projections. It retires only the matching permission, emits one failed terminal
activity, and ignores late permission replies without sending an approval.
The desktop cancels the corresponding waiter and removes the pending permission
controls while preserving unrelated requests, including requests in other sessions.

The complete PTY baseline adds macOS fallback for valid high stdio descriptors
rejected by `posix_spawn`, plus its native regression test. The self-contained
manifest and existing Windows pointer adaptations remain the local PTY delta.

RMCP and its macros use upstream `3.5.1` at
`98a54789b80110ad210495c4ad845c89e1980471`; Rustls is `0.23.46`. Rama remains
coordinated at `0.3.0-alpha.4`. The lockfile retains unrelated existing pins
where possible rather than refreshing the entire dependency graph.

Upstream now enables `instant_interrupt` by default. NeverWrite explicitly
disables it to preserve `StartIfIdle` prompt admission and its application-owned
queue. The optional `code_mode_host_grpc` transport is also disabled: the bundled
companion continues to run the verified stdio protocol. Code-mode cancellation
improvements remain supplied by upstream. MCP `2026-07-28` remains disabled at
the ACP 0.14 boundary, including when the global Codex config enables it.

### Retained changes from 0.159.0 to 0.162.1

The 0.162.1 promotion moved all OpenAI Codex crates and the local PTY snapshot to `rust-v0.162.1`
at `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. That promotion updated staging,
fixtures and the lockfile together and rebuilt both runtime binaries.

`ExecCommandEndEvent` now carries only `aggregated_output`; upstream removed
`stdout`, `stderr` and `formatted_output`. The ACP projection consumes the
aggregated text for definitive command-policy rejections while preserving
streamed command output, terminal status, raw event output, file diffs and
canonical activity identity. It emits a rejection reason only when no output
was already displayed, and does not turn policy rejections into permission
requests. Existing command-event fixtures use the new schema.

Paginated restoration forwards `StoredModelContext.revision` to
`ResumedHistory.history_revision`, allowing upstream to reuse the exact snapshot
without losing model-visible context. Paginated subagent replay retains the new
optional model and reasoning-effort fields in the canonical activity's raw
output. Turn acknowledgements retain the runtime's local `turn_id` identity;
new root-turn attribution does not replace the ACP session/turn identity.
Regression coverage exercises lifecycle events with root-turn attribution and
subagent model metadata restored across a display-history page boundary.

The subagent snapshot fixture initializes upstream's new host-owned
`turn_extension_init` field to its empty default. Root threads continue to use
`StartThreadOptions::new`, preserving upstream defaults at the ACP boundary.
The full PTY snapshot includes upstream Windows Job Object console suppression
and unsuspended fallback launches when containment is unavailable. Its platform
tests use upstream's pinned
`codex-utils-cargo-bin` helper; the self-contained manifest and the two local
Windows pointer-type adaptations remain the only source and manifest delta.

The bundled fallback catalog now defaults to GPT-6.1 Sol when no model is
configured. Explicit model selections and a valid authenticated account catalog
remain authoritative; Astra, Sol and Luna remain selectable.

At that promotion Rust remained 1.96.0 (upstream 1.95.0), V8 remained 150.4.0, and the coordinated
Rama family remains 0.3.0-alpha.4. RMCP and its macros now use upstream's
3.3.0 Git pin at `3e636cab26c013eca5131103c03d20237f12c4df`.
ACP v1, start-if-idle prompt admission, model restoration and the private
NeverWrite metadata contract remain unchanged. New upstream UI features and
optional tools require separate product integration.

### Retained changes from 0.157.1 to 0.159.0

All OpenAI Codex crates and the full local PTY snapshot now use `rust-v0.159.0`
at `687a119f0fcaace47e1f1abcc77cec6c813fd6da`. The desktop staging baseline
and its source-alignment tests use the same version and commit. Both
`codex-acp` and `codex-code-mode-host` must be rebuilt, staged and signed together;
0.159.0 changes the host handshake and yield protocol.

The ACP boundary uses `ExecServerRuntimeOptions` and the renamed
`resume_legacy_thread_from_rollout`. MCP configurations initialize the new
`startup_readiness` and `tool_input_schema_max_bytes` fields to upstream defaults.
Legacy sessions retain their existing restoration and replay contract.
Paginated sessions restore model context through
`ThreadStore::load_latest_model_context` and `resume_thread_with_history`.
Only `session/load` replays the display history, using ordered `list_items`
pages decoded as the store's typed display schema. `session/resume` avoids
replay. Display history is independent of the resumable model-context suffix;
subagent wait identities survive page boundaries, and reconstructed diffs retain
NeverWrite hunk metadata. A replay failure shuts down and removes the resumed
runtime before returning the error.

Model, reasoning effort, service tier and permission-mode changes send
`Op::ThreadSettings` with a reply channel and consume the runtime's acceptance
before changing ACP state or reporting success. Rejection and a dropped reply
leave the local selection unchanged. Abort events carrying an `ErrorEvent`
emit a visible failed status and propagate its message, classification
(including `TooManyDenials` and `FlexUnavailable`) and misalignment details.
User interruption without an error still resolves as `Cancelled`.

The complete PTY snapshot adds Linux `init_spawn_helper`, descriptor validation,
process launch, signals and child reaping changes, and their tests. Its
self-contained manifest includes test dependency `ctor 0.6.3`. Only the existing
Windows raw-handle cast and `winapi::ctypes::c_void` adaptations differ from
upstream PTY source. Linux runs the new helper and descriptor tests; Windows and
macOS retain native tests in the package CI matrix.

The adapter continues to use the runtime's local `AgentControl` implementation;
child registration, reconciliation and canonical activity/message projection
keep their existing private ACP contract. Guardian stdin review and filesystem
policy improvements come from the pinned runtime, with the ACP's existing
permission and redaction projections preserved.

Steer and `instant_interrupt` remain deferred. Prompts still use `StartIfIdle`,
and this update does not enable `instant_interrupt` or add a second input queue.
See the [official Codex changelog](https://learn.chatgpt.com/docs/changelog) and
[the upstream release](https://github.com/openai/codex/releases/tag/rust-v0.159.0).

### Retained changes from 0.155.1 to 0.157.1

NeverWrite maintains the Rust adapter fork directly against pinned OpenAI Codex
releases. The archived Zed adapter remains its provenance, not an update source.
The product's ACP v1 and private metadata contracts remain the compatibility
boundary; this update does not migrate to App Server.

The host instruction provider uses upstream's renamed `LoadInstructionsFuture`.
Prompt dispatch boxes the larger upstream operations and turn requests while
retaining start-if-idle admission and its acknowledgement handling.
ACP image blocks now use the upstream `ImageReference::Inline` representation,
retaining the original MIME type and base64 content on the Responses boundary.
The PTY snapshot includes upstream's new child-process API, descriptor policy,
macOS spawn and process-group handling, and Windows pseudoconsole lifecycle
changes and tests. Its self-contained manifest enables Tokio signal support and the
new test dependency while preserving the two local Windows pointer-type fixes.
The PTY is a member of the adapter workspace so its unit and platform tests use
the committed runtime lockfile. Package CI runs them on native macOS, Windows
x64/ARM64 and Linux x64 runners; cross-compiled Linux ARM64 remains build-only.
Windows CI enables Git long paths before Cargo checks out the full upstream tree.
It follows [upstream's Windows CI exclusion](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/.bazelrc#L168-L170)
for `conpty_ctrl_c_interrupts_powershell_foreground_child`, whose Ctrl-C delivery
is unreliable on Windows CI runners. The test remains unchanged and enabled for
local `cargo test` runs; the other process, descendant termination and ConPTY
lifecycle tests still run in CI. Interactive PowerShell Ctrl-C behavior requires
validation on a Windows desktop outside the hosted runner environment.

That promotion retained Rust 1.96.0 (upstream 1.95.0), V8 150.4.0 and RMCP 3.2.0.
The dependency graph upgrades Rustls to 0.23.45 and includes upstream's platform
certificate verifier. Rama prerelease packages remain coordinated with upstream.

### Lockfile and V8 provisioning

The committed `Cargo.lock` is part of the runtime pin. In particular, `rama-core`, `rama-error`, `rama-macros`, and `rama-utils` must remain coordinated at `0.3.0-alpha.4`, matching the upstream 0.166.0 dependency graph. A broad lockfile regeneration can select stable Rama packages next to prerelease peers and produce an incompatible graph, so future promotions must compare this family with the candidate tag and update it as a coordinated set.

The lockfile resolves `v8 152.2.0` from the exact patched Git revision above. `apps/desktop/scripts/codex-v8-artifacts.mjs` obtains the target-specific `ptrcomp_sandbox_release` archive, source binding, and SHA-256 manifest from the official `openai/codex` release `rusty-v8-v152.2.0`. It authenticates the downloaded or cached manifest against the target-specific digest pinned in `apps/desktop/scripts/codex-v8-manifest-pins.mjs` before downloading archives or bindings, requires the manifest to cover exactly both artifacts, verifies their checksums before use, and caches the verified set under `apps/desktop/.cache/codex-v8/<version>/<profile>/<target>/`.

Local builds may provide `RUSTY_V8_ARCHIVE` and `RUSTY_V8_SRC_BINDING_PATH` only as a pair. A partial override fails immediately. Release and package-smoke CI use `--require-verified-artifacts`, which rejects direct overrides and `V8_FROM_SOURCE`; each target therefore compiles against the verified OpenAI pair selected for that target.

### Product behavior covered by this baseline

- ACP prompts start only while the runtime is idle. The one-shot turn acknowledgement is consumed before local prompt state is registered, so declined submissions cannot hang or steer an active turn.
- MCP persistent approval, Guardian `WriteStdin`, image-generation failures, optional function-call IDs, `PathUri`, and runtime queue notifications have explicit safe projections.
- Collaboration tools `SendMessage`, `FollowupTask`, `InterruptAgent`, and `ListAgents` preserve runtime activity identity. `SubAgentActivityKind::Completed` terminalizes that identity once, while internal agent messages remain outside the parent transcript.
- Reasoning efforts are catalog-driven, including `max`, `ultra`, and future custom values. Load, resume, fork, and model changes retain an effort only when the selected model supports it.
- The normal model picker follows the authenticated remote catalog and its visibility flags. The bundled fallback catalog lists GPT-6.1 Sol and GPT-6 Astra, Sol and Luna, and selects GPT-6.1 Sol by default when no model is configured. A valid ChatGPT account catalog remains authoritative, and explicit model selections survive the default change. The Codex-only exact model-ID path remains available for unlisted models.
- `TurnItem::Extension(ExtensionItem::Sleep(...))` is projected as the canonical `Waiting` activity and keeps stable item identity across live events and replay.
- `ItemCompleted.started_at_ms` is propagated into activity metadata when positive so restored activities keep their upstream start time. Turn-level `started_at` fields are accepted but do not invent a second timeline contract.
- `TurnComplete.error` emits a visible failed `turn_error` status and fails the pending ACP prompt instead of reporting `EndTurn`; aborts with an error follow the same failure contract, while ordinary cancellation keeps its lifecycle event and `Cancelled` result.
- `RawResponseCompleted` is logged without a separate ACP projection because `TokenCount` remains the authoritative accumulated usage signal. Projecting both would overwrite or duplicate usage.
- `EnvironmentConnected` and `EnvironmentDisconnected` are logged without transcript activity because remote runtime environments are outside the current ACP v1 product contract.
- Code mode requires the standalone sibling `codex-code-mode-host`; the runtime disables the in-process fallback, packaging and signing include both binaries, and the smoke proves the host process runs.
- A definitive dangerous-command policy rejection is projected as a failed, terminal ACP tool activity with its visible reason; it never becomes an ACP permission request.
- Thread metadata synchronizes both a selected reasoning effort and an explicit clearing of it, preventing a stale value after load, resume, or fork.
- Model context-window metadata remains dynamic. Regression coverage exercises the 272K context window reported for Sol, Terra, and Luna without hard-coding that size into the runtime.
- The public Full Access label and its ACP description remain unchanged. The UI adds only contextual help explaining that Codex safety policy can still block some destructive command forms.

### Intentionally deferred capabilities

This baseline does not add steer, `instant_interrupt`, Bedrock onboarding, visible task references, a second runtime-owned prompt queue, TUI-only commands, MCP protocol `2026-07-28`, `--approve-for-me`, an ACP SDK update beyond `agent-client-protocol 0.14.0`, ACP v2, or an App Server migration. Each changes a product, protocol, permission, or client contract and requires separate compatibility work.

The App Server adapter remains an architectural follow-up rather than a replacement. It must demonstrate parity for sessions, configuration, permissions, review, inline changes, and accept/reject flows before it can replace the current adapter.

Portable plugins, thread sections/pinning, side conversations, audio/realtime, external imports, and Bedrock support are also deferred. NeverWrite does not expose a local projection merely because the upstream runtime can represent one. The Goal contract remains tracked separately in issue `#387`.

### Packaged code-mode smoke matrix

| Package target | Executes the functional ACP code-mode smoke | Coverage when it cannot execute |
| --- | --- | --- |
| macOS universal | Yes, on a native runner slice | Both packaged host slices are staged |
| Windows x64 and ARM64 | Yes | — |
| Linux x64 | Yes | — |
| Linux ARM64 | No, because it is cross-compiled | Packaging, sidecar staging, and architecture checks run without executing the foreign binary |

The smoke uses a temporary `CODEX_HOME`, a local deterministic Responses mock, and the 0.166.0 install-context layout where the packaged host is a sibling of `codex-acp`. It checks that an ACP image reaches Responses as inline image content, asserts a real ACP turn reaches both a code-mode tool completion and a final assistant response, and inspects the ACP process tree to prove the packaged standalone host was launched rather than an in-process fallback.

The same smoke starts an isolated copy of `codex-acp` without its sibling host and requires the code-mode tool to fail closed with the missing host path in its diagnostic. It does not require credentials or a network service.

Linux x64 package CI also runs the vendor's unit tests and standalone-host
integration tests in the release profile, reusing the verified V8 artifacts.

The macOS package job runs the complete native PTY suite, including the
high-stdio fallback regression that opens more than 10,240 descriptors. Before
running it, the job raises Darwin's kernel ceilings to at least 131,072 system
files and 32,768 files per process, and the shell's soft limit to at least
16,384. Existing higher limits are retained. Kernel and shell limits are logged;
the shell adjustment and Cargo invocation share one step so the limit is
inherited. Raising only `RLIMIT_NOFILE` inside the test can still hit `EMFILE`
on hosted runners whose kernel ceiling is lower.

Local Linux x64 validation for 0.166.0 passes 115 adapter unit tests (including
private-reviewer isolation), 2 standalone-host integration tests and 62 PTY unit
tests. All 629 NeverWrite workspace Rust tests also pass. The workspace suite
runs with `--test-threads=1` because parallel vault watcher tests exceed this
host's inotify instance limit; no backend source changes are required.
The 78 staging/V8 tests and 96 focused frontend ACP, runtime-metadata and review
tests pass, along with TypeScript and ESLint checks. Locked all-target runtime
checking and workspace Clippy with warnings denied pass. Both runtime binaries
use the verified V8 archive and source
binding, and PTY library/test sources pass cross-target checks for Windows x64
and macOS ARM64. Native macOS/Windows execution, signing and full release
packaging remain covered by the package CI matrix; Linux execution does not
substitute for those platform checks.

The deterministic smoke passes six legacy load/resume transitions across
0.164.0 → 0.166.0 → 0.164.0 → 0.166.0, plus paginated load/resume with more than
one display-history page and continuation. A fresh 0.166.0 ACP session also
preserves the inline image, executes the standalone code-mode host and emits
the final assistant response. Missing-host checks fail closed. These smokes use
temporary `CODEX_HOME` directories and a loopback Responses mock without real
credentials.

### Follow-up and rollback

#### Rollback baseline

The rollback baseline is OpenAI Codex `rust-v0.164.0` at
`6aaac694803004a63c6f393d153c96d22521a6b9`, local PTY `0.164.0`, registry V8 `152.2.0`,
and the lockfile before this promotion.
Restore the runtime manifest, lockfile, PTY snapshot, adapter source, staging
baseline, fixtures and documentation together; rebuild and stage both binaries.
Do not downgrade one crate or one executable independently.

Upstream adds state migration 62 (`threads_attached_parent`). Rollout JSONL
remains canonical. The isolated upgrade
smoke exercises the local session path across these versions; it does not prove
that the previous runtime can consume every feature added by 0.166.0.
Before a deployment rollback, stop all processes sharing the affected
`CODEX_HOME` and retain a consistent backup of that directory. Do not edit
`_sqlx_migrations` or attempt ad hoc SQL downgrades.

The deterministic upgrade smoke creates a real conversation using the previous
runtime, then lists, loads, resumes, continues and closes it with the current,
previous and current runtime in sequence. Each restoration starts a fresh ACP
process; load must replay history and resume must not duplicate it. It uses an
isolated temporary `CODEX_HOME` and a loopback Responses mock, and checks model
selection, ACP replay and
model-visible conversation continuity. Its scope is the local text, inline-image
and code-mode session path; it does not certify rollback of every upstream
feature or every user database.

```bash
cd apps/desktop
node scripts/smoke-codex-runtime-upgrade.mjs \
  --previous /path/to/0.164.0/codex-acp \
  --current /path/to/0.166.0/codex-acp
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
