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

## [0.1.0]

### Added

- Signed and notarized macOS release pipeline with public update feeds.
- Manual update checks and install flow from the desktop settings panel.
- Safety confirmation before installing updates when unsaved tabs, pending AI reviews, active agent sessions, or separate work windows are open.

### Changed

- Desktop releases now publish target-specific updater metadata for macOS and Windows.
