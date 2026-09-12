# Claude runtime

This private installation manifest pins the published Claude ACP adapter to
`0.75.1`. Its production versions and integrities are inherited from the former
snapshot; `baseline.json` records that comparison without retaining upstream
source. The only additional runtime package is the adapter itself.

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
target, applies the TaskList patch explicitly, and generates
`.cache/claude-runtime/<rust-target>/`. Use `-- --target <target>` for cross builds
or `-- --force` for a clean rebuild. Generated installations are not committed.

Foreign native packages are downloaded from their lockfile URLs, checked against
their SHA-512 integrity, and extracted into the temporary installation. This
does not resolve new versions or rewrite the committed lockfile. Unneeded host
native packages are removed before validation/publication. Universal macOS
includes both native SDK packages.

The patch in `patches/` preserves the bounded linear TaskList parser. It applies
only to the published `dist/tools.js`; pre/post hashes reject incompatible input
or incomplete patch application. Upstream tracking:
https://github.com/agentclientprotocol/claude-agent-acp/pull/1006.
The previous trailer-parsing fix is already upstream and is not reapplied.

Validate preparation with `npm run test:claude-preparation`. The runtime contracts
accept `NEVERWRITE_CLAUDE_CONTRACT_RUNTIME` for comparing an explicit artifact and
execute the actual parser from a temporary isolated copy, with a parent timeout.

`npm run claude:smoke` runs the actual adapter and native Claude CLI against a
local Anthropic mock. It checks `--version`, `--cli --version`, ACP initialization,
session creation, an actual Read tool result, assistant output, and cancellation
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

Do not update the runtime version during the distribution migration. A future
update must compare the full production graph and rerun contracts and packaged
smokes. Remove the patch only after its tests pass on unmodified upstream output.

## Product compatibility

NeverWrite retains runtime ID `claude-acp`, persisted history and configuration,
the existing queue, authentication probes and provider routing. The backend
advertises filesystem access and form/URL elicitation. It does not enable native
subagent sessions, AIR async tasks, legacy subagent transcripts or steering.
Claude native resume remains disabled; forks use NeverWrite's persisted history.

The client consumes session titles while preserving explicit manual renames,
generic model/effort/mode options, compaction tool activity and usage Markdown.
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
patch, preparer, resolver, packaging, CI and snapshot deletion. Rebuild the app
from that revision. Never mix an adapter with another revision's SDK/native
packages. This migration introduces no persisted-data schema changes.
