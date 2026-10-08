# Claude runtime

This private installation manifest pins the published Claude ACP adapter to
`0.88.0`, using its official Claude Agent SDK dependency `0.3.293`. All eight
SDK native packages are locked to `0.3.293` too. `baseline.json` records the
complete production graph and published runtime hashes. There is no SDK
override or local runtime patch; `patches.json` is empty.

Development and release staging use the same preparer. The native backend keeps
its existing override precedence and serialized runtime source values; its local
Claude fallback now points at the generated host-target directory. Releases still
ship Node and `embedded/claude-agent-acp/dist/index.js` outside the ASAR.

`NEVERWRITE_CLAUDE_EMBEDDED_DIR` remains the highest-priority staging override,
followed by `apps/desktop/embedded/claude-agent-acp`. These now designate a complete
prepared runtime at the pinned baseline, including native packages for the target.
They are validated without modification. Prepare an override with this script
and copy its output; a source-only checkout requiring `npm ci` is no longer a
staging input. Runtime executable overrides in settings and
`NEVERWRITE_CLAUDE_ACP_BIN` retain their existing behavior.

From `apps/desktop`, run `npm ci` then `npm run claude:prepare`. Preparation uses
an isolated lockfile install, includes native optional packages for the requested
target, and generates `.cache/claude-runtime/<rust-target>/` from the unmodified
published package. Use `-- --target <target>` for cross builds or `-- --force`
for a clean rebuild. Generated installations are not committed.

Foreign native packages are downloaded from their lockfile URLs, checked against
their SHA-512 integrity, and extracted into the temporary installation. This
does not resolve new versions or rewrite the committed lockfile. Unneeded host
native packages are removed before validation/publication. Universal macOS
includes both native SDK packages.

Claude ACP `0.77.0` includes the bounded linear TaskList parser from
https://github.com/agentclientprotocol/claude-agent-acp/pull/1006, so the runtime
no longer carries a TaskList patch. The TaskList contracts remain as regression
coverage for the published implementation.

ACP `0.88.0` supplies Claude Code `2.1.293`. Its model catalog exposes Sonnet 5.5
and Haiku 5.5 under the official `sonnet` and `haiku` aliases. NeverWrite's chat
selector uses the model options returned by ACP; the native CLI resolves these
aliases to `claude-sonnet-5-5` and `claude-haiku-5-5` on provider requests.
The checked-in smoke verifies Sonnet's concrete request ID on the initial turn,
tool followup and cancellation. A separate local mock probe verified the Haiku
catalog option, provider request ID, Read tool followup and cancellation.
The Claude Code terminal settings use a separate static model list that still
offers Haiku 4.5. The temporary Sonnet 5.5 SDK override and model-catalog rewrite
from [#494](https://github.com/jsgrrchg/NeverWrite/pull/494) have been removed.
Preparation and packaged validation check the original published hashes.

Validate preparation with `npm run test:claude-preparation`. The runtime contracts
accept `NEVERWRITE_CLAUDE_CONTRACT_RUNTIME` for comparing an explicit artifact and
execute the actual parser from a temporary isolated copy, with a parent timeout.

`npm run claude:smoke` runs the actual adapter and native Claude CLI against a
local Anthropic mock. It checks `--version`, `--cli --version`, ACP initialization,
session creation, discovery and selection of Sonnet 5.5 via `sonnet`, the exact model
ID on provider requests (including tool followups), an actual Read tool result,
assistant output, and cancellation
of a pending inference request. The smoke uses a temporary profile and workspace,
synthetic credentials and an isolated runtime copy. `--runtime`, `--node` and
`--target` select a packaged runtime unit explicitly. Processes are cleaned up
on success or failure.

The packaged-sidecar smoke invokes this same test using the bundled Node. The
package workflow additionally runs native Claude jobs for Linux/Windows x64 and
ARM64 and both macOS architectures. Its Intel job downloads the actual universal
runtime packaged on the ARM runner and executes its other Node slice. Full Linux
ARM64 application packaging remains a cross-build; the separate ARM64 runtime job
provides native runtime execution coverage. These jobs must run remotely before
claiming platform-wide release validation.

Version updates must use an exact stable pin, regenerate the isolated lockfile and
full baseline, and rerun contracts and packaged smokes. The `0.81.0` update moves
`@anthropic-ai/claude-agent-sdk` to `0.3.280`; `@agentclientprotocol/sdk` stays
at `1.5.0`, the resolved `@anthropic-ai/sdk` peer at `0.128.0`, and `zod` at
`4.6.5`. The `0.81.1` update keeps those dependency versions and adds the
published managed-policy module to the runtime baseline.
The `0.81.2` update keeps the same production dependency graph. Its published
JavaScript changes the ACP agent, exit-plan handling, and native subagent
runtime; the runtime baseline records those three new file hashes.

The `0.88.0` baseline comes from published tag commit
`d43fec3fa3118e88ff8a8ed99b85d2a5f444e538`. It includes ACP SDK `1.7.0`,
Claude Agent SDK `0.3.293`, the resolved Anthropic SDK peer `0.132.1`, `diff`
`9.0.0` and `zod` `4.6.5`. It records all 72 published JavaScript modules,
including the MCP command, turn events and expanded draft ACP v2 surface,
and the complete locked production dependency graph.

### Updating the runtime

1. Update the exact stable ACP pin in `package.json`.
2. Regenerate `package-lock.json` and verify the SDK and every native package
   have the same version. Refresh the published baseline from the new npm tarball.
3. Keep `patches.json` empty and retain native-version parity coverage.
4. Run preparation, contracts, the Sonnet selection/provider smoke, UI selection
   tests and all native/packaged CI jobs. Verify both the published catalog option
   and the concrete model ID received by the provider.

## Product compatibility

NeverWrite retains runtime ID `claude-acp`, persisted history and configuration,
the existing queue, authentication probes and provider routing. The backend
advertises filesystem access and form/URL elicitation. It does not enable native
subagent sessions, AIR async tasks, legacy subagent transcripts or steering.
Claude native resume remains disabled; forks use NeverWrite's persisted history.

The client consumes session titles while preserving explicit manual renames,
generic model/effort/mode options, compaction tool activity and usage Markdown.
NeverWrite does not advertise `clientCapabilities.session.compaction`, so
`0.81.0` retains the existing compaction tool-call presentation. The experimental
compaction updates and summary chunks, including upstream's interrupted-compaction
cleanup, remain outside the client integration.
Claude ACP `0.79.0` uses the canonical Bash and PowerShell tool-call title for
permission requests, preserving the exact command instead of a model-authored
description. NeverWrite's backend already forwards that ACP title and the UI
already renders it in the permission card, so no product-side change is needed.
NeverWrite does not advertise the AIR `recommendedValue` capability, so the
upstream metadata addition does not alter the selected configuration. NeverWrite
does not pass the removed `claudeCode.options.agent` value, so that `0.77.0`
breaking change does not affect its session creation flow.
NeverWrite does not advertise the `terminal_output_delta` extension. Claude ACP
`0.81.0` therefore keeps its existing terminal output fallback for NeverWrite;
the upstream delta preference does not change the client metadata contract.
NeverWrite also does not advertise `clientCapabilities.session.notices`. The
new experimental session notices therefore retain their transcript-message
fallback, preserving the existing chat presentation.
In `0.81.1`, informational notices add metadata while retaining their rendered
text, so the transcript fallback remains unchanged. The release also fixes
permission mode updates after plan approval, Write tool input aliases, usage
metadata, and provider/session handling. NeverWrite continues consuming the
same ACP notifications and does not advertise new client capabilities.
In `0.81.2`, resumed native subagents are announced when their next generation
starts. NeverWrite does not advertise native subagent sessions, so this does not
change its current UI. The release also resumes a clear-context plan approved
while a background task followup holds the turn open. NeverWrite's existing
permission flow can deliver the plan approval; the adapter handles continuation
without changing the client protocol.
In `0.83.0`, permission presentation metadata is restricted to AIR clients.
NeverWrite still receives the exact shell command in standard `toolCall.title`;
the contract test checks that field and the absence of AIR-only metadata.
In `0.85.1`, the adapter replies to session close without waiting for an interrupt
reply, reports unfinished foreground tools as failed turns, and restores
background task stops during replay. It also incorporates the SDK replay and
ultracode compatibility fixes from `0.85.0`. Draft ACP v2 remains opt-in via
`CLAUDE_AGENT_ACP_EXPERIMENTAL_V2`; NeverWrite continues using ACP v1.
In `0.86.0`, `/mcp` reports server status and supports reconnection in chat.
Cancellation removes cancelled queued prompts, and cancellation and session close
settle pending turns. Context-window probes avoid excessive token-count requests,
shell results report exit codes only when explicitly provided, and the main-thread
agent configuration option is restored. Permission requests from subagents count
as waiting on user input. The experimental ACP v2 Write replay fix remains outside
NeverWrite's current integration.
In `0.87.0`, prompts absorbed into a background-task notification cycle settle
normally instead of leaving the client running. Streamed tool calls abandoned
before execution close without a false session failure; tools that actually ran
and lack results retain the failure behavior. AIR async task routing, Monitor
filtering, structured task IDs and output-path handling are also corrected, but
NeverWrite continues without the AIR async task capability or native subagent
sessions. The runtime remains unmodified, with no local patches or SDK overrides.
In `0.88.0`, the adapter updates Claude Agent SDK and all eight native packages
to `0.3.293`. ACP SDK stays at `1.7.0`; NeverWrite continues using ACP v1 and
the published Sonnet model alias without enabling additional client capabilities.

The push-only authStatus, goal, AIR session-failure and JetBrains file-audit
extensions remain outside the current client integration. NeverWrite's own
filesystem/diff tracking remains authoritative for inline review and accept/reject.
Provider routing is applied before session creation, preserving upstream's
settings-tier enforcement against competing project/user routing settings.

Relevant existing validation includes `cargo test -p neverwrite-native-backend`,
desktop chat/history/settings/review tests, `npm run electron:ai-runtime:smoke`,
and the runtime-specific contracts above. A real-account login/provider check
is separate from the deterministic, credential-free packaged smoke.

## Rollback

Revert the distribution migration as one unit: dependency manifest/lockfile,
baseline, preparer, resolver, packaging, CI and snapshot deletion. Rebuild the
app from that revision. Never mix an adapter with another revision's SDK/native
packages. This migration introduces no persisted-data schema changes.
