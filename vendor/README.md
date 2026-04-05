# Vendored Dependencies

This directory is committed on purpose.

VaultAI currently vendors upstream runtime projects that are needed for desktop
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

## Updating Vendored Runtimes

When updating a vendored dependency:

1. Refresh the upstream snapshot to the exact release or commit you intend to ship.
2. Keep `dist/` aligned with the vendored Claude source snapshot.
3. Remove any local byproducts before committing.
4. Re-run the relevant validation:
   - `cargo test -q`
   - `cd apps/desktop && npm run lint && npm test`

The repository keeps the Claude runtime snapshot broader than the minimum
runtime surface on purpose. The desktop build depends directly on `dist/`, while
the vendored source and test trees stay in-repo for auditability, upstream diff
review, and easier runtime updates.

What should not be committed here:

- local build outputs such as `target/`
- temporary install trees such as `node_modules/`
- transient bundler caches such as `.vite/`

Those generated paths are ignored in the repository root `.gitignore`.
