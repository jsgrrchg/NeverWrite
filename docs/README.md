# NeverWrite Documentation

This directory contains maintainer and operator documentation for NeverWrite.
The root [README](../README.md) explains what the product is and how to run it;
these documents go deeper into the systems that are easiest to break during
polish and hardening.

## Start Here

- [Project README](../README.md): product overview, monorepo layout, development setup, validation commands, and current project status.
- [Contributing](../CONTRIBUTING.md): contributor workflow, code style, testing expectations, versioning, and release preparation.
- [Project Architecture](project-architecture.md): high-level map of the monorepo, Electron runtime, IPC boundaries, Rust sidecar, shared crates, web clipper, ACP runtimes, and major data flows.
- [Testing and Validation](testing.md): the command matrix for Rust, desktop, Electron smoke tests, web clipper checks, CI parity, and area-specific validation.

## AI And Change Control

- [AI Change Control](ai-change-control.md): the ActionLog model, tracked files, pending review, keep/reject flows, inline review, conflicts, persistence, and known limits.
- [Review Hardening Checklist](review-hardening-checklist.md): manual QA checklist for inline review, Review tab, Edits surface, keep/reject, lifecycle cases, multi-session, reload/recovery, conflicts, performance, and release sign-off.
- [AI Runtime Setup](ai-runtime-setup.md): ACP providers, runtime discovery, authentication methods, `NEVERWRITE_*` overrides, release bundling, and troubleshooting for Codex, Claude, Gemini, and Kilo.
- [AI Session History And Crash Recovery](ai-session-history.md): where chat transcripts are stored, how restore/fork/reconnect works, and what to check after a crash.

Read these before changing AI editing behavior, provider setup, session
persistence, runtime packaging, or anything that can affect whether agent edits
remain reviewable.

## Editor And Workspace

- [Editor Architecture](editor-architecture.md): CodeMirror, live preview, wikilinks, frontmatter/properties, autosave, dirty tabs, merge view, inline review overlays, and power-user invariants.
- [Subagents Working State Map](concept-maps/codex-subagents-working-state-map.excalidraw): visual working map for subagent state and coordination.

Use these when touching the editor surface, tab model, pane/workspace behavior,
selection/cursor handling, live preview, or inline review rendering.

## Data, Privacy, And Diagnostics

- [Data And Privacy](data-and-privacy.md): vault data, hidden vault state, session history, logs, web clipper tokens, settings, secrets, caches, and bug-report redaction guidance.
- [App Logs](app-logs.md): platform-specific log paths, log file contents, privacy notes, and Windows crash-report collection.
- [Troubleshooting](troubleshooting.md): practical diagnostics for startup failures, native backend issues, AI runtime setup, web clipper connectivity, vault/indexing problems, session recovery, updates, and bug reports.

Use these before asking users to share logs or local files. Never assume a local
file is safe to upload until it has been reviewed for vault content, transcripts,
tokens, provider credentials, or personally sensitive paths.

## Web Clipper And Releases

- [Web Clipper README](../apps/web-clipper/README.md): browser extension development, validation, manual loading, local desktop API, pairing, and deep-link fallback notes.
- [Electron Release Feeds](../release/appcast/README.md): desktop release topology, appcast feeds, signing/notarization, version readiness, updater validation, and rollback.

These currently live next to their implementation/release artifacts because
they are tightly coupled to package-specific workflows.

Last updated: May 11, 2026.
