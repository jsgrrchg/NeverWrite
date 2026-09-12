# Claude runtime

This private installation manifest pins the published Claude ACP adapter to
`0.75.1`. Its production versions and integrities are inherited from the former
snapshot; `baseline.json` records that comparison without retaining upstream
source. The only additional runtime package is the adapter itself.

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

Do not update the runtime version during the distribution migration. A future
update must compare the full production graph and rerun contracts and packaged
smokes. Remove the patch only after its tests pass on unmodified upstream output.
