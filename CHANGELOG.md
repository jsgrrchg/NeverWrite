# Changelog

All notable user-facing changes to NeverWrite will be documented in this file.

## Format

This changelog follows [Keep a Changelog](https://keepachangelog.com/).

Entries are grouped by release version under the following categories:

- **Added** — New features
- **Changed** — Changes to existing functionality
- **Fixed** — Bug fixes
- **Removed** — Removed features
- **Security** — Vulnerability fixes

## Versioning

NeverWrite uses [Semantic Versioning](https://semver.org/) with `0.x` releases
during the beta phase. The minor version increments with each release — there
is no upper limit before `1.0`. The `1.0` release signals a stable, public API
and UX commitment.

```
0.1 → 0.2 → ... → 0.47 → ... → 1.0
```

Patch versions (`0.x.1`, `0.x.2`) are reserved for hotfixes within a release.

## What belongs here

Only changes that matter to users who download and use NeverWrite. Internal
refactors, dependency updates, CI changes, and code cleanup do not belong here.

---

## [0.1.2]

### Fixed

- Fixed macOS DMG release validation so GitHub-built desktop release artifacts are staged and checked correctly.
- Fixed opening and using vaults on Windows rclone/WinFsp mounted drives that do not support path canonicalization, without compromising security layer.
- Fixed the drag preview disappearing when dragging items from an expanded sidebar onto editor panes or the chat composer.
- Fixed sticky folder headers in the file tree so they read as a distinct frosted plate, with the same visible blur treatment in both the docked sidebar and the Arc-style peek overlay.

## [0.1.1]

### Fixed

- Fixed the GitHub-built desktop app packaging so the bundled Claude ACP runtime includes its production dependencies.
- Prevented a failed AI runtime startup from blocking provider settings, note loading, and other backend requests indefinitely.
- Improved AI provider settings so providers show as checking while runtime inventory is loading instead of incorrectly offering installs.

## [0.1.0]

- First release. For full changelog, the commit history is available, from the first line of code to the last. 
