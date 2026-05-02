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

## [0.2.1] - 2026-05-02

### Added

- Added working ChatGPT account sign-in for the Codex runtime through the ACP authentication flow, including backend logout support.
- Added Anthropic API key sign-in as an explicit Claude provider option.

### Changed

- Hardened Claude sign-in options so remote or no-browser environments use the appropriate terminal login method, while local environments keep Claude subscription, Anthropic Console, API key, and gateway choices.
- Hardened Gemini Google sign-in so the terminal launch explicitly maps the UI method to the Gemini CLI `oauth-personal` auth type instead of relying on ambiguous defaults.

### Fixed

- Fixed AI provider setup status so finding a runtime binary no longer incorrectly marks the provider as connected.
- Fixed terminal sign-in state so providers become connected only after the sign-in process exits successfully.
- Fixed AI sign-in terminals so refreshes no longer restart the active auth session or reopen duplicate browser tabs.
- Fixed AI sign-in terminals so they open focused and scrolled to the beginning of the auth prompt, allowing interactive choices such as Gemini Google sign-in to receive Enter correctly.
- Fixed AI provider setup recognition after restart by detecting persisted CLI account credentials for Codex, Claude, Gemini, and Kilo.
- Fixed AI provider logout so local auth state and Google Cloud environment settings are cleared consistently.
- Fixed Claude gateway setup so remote HTTP URLs are rejected by the backend, localhost HTTP remains allowed, and gateway-with-token setups stay labeled as gateway auth.
- Fixed Windows runtime lookup for CLI shims that depend on `PATHEXT`, such as `.cmd` and `.exe` launchers.
- Fixed Gemini startup on Windows so NeverWrite prefers the executable `.cmd` shim over npm's extensionless shim, avoiding `CreateProcessW` Win32 launch failures.
- Fixed Gemini Google sign-in hydration so NeverWrite marks the provider as connected as soon as the Gemini CLI reports successful authentication, instead of waiting for the login terminal process to exit.
- Fixed Gemini ACP sessions on Windows by stripping verbatim `\\?\` path prefixes before launching the Node-based CLI, avoiding `EISDIR: illegal operation on a directory, lstat 'C:'` failures.
- Fixed Gemini model and mode changes so NeverWrite uses Gemini's supported ACP `session/set_model` and `session/set_mode` requests instead of the unsupported `session/set_config_option` request.
- Fixed Codex subagent persistence so background subagent threads are saved when they are created or receive tool, status, plan, image, permission, or input events while their chat tab is closed, using the subagent's own vault path for delayed saves.
- NOTE ABOUT SUB AGENTS, chat gpt models tend to forget that they can't fork the context of subagents when you ask them to spawn childs with an aspecific model prompting like ''spawn 3 subagents to write this 3 docs using 5.4 mid effort...'', so there's a custom instruction in the acp that act like ''harness'' in order to orient the model to perform the action as you asked it. Weird edge case developing for frontier moderls, you will notice this when the acp refuses to perform the action and tells the agent mid session to do it the right way. I comment this because eventually you will encounter this scenario and the comments that gpt makes may sound odd. 

## [0.2.0] - 2026-05-01

### Added

- Added GitHub Release downloads for the Web Clipper: a Chrome MV3 zip for manual install and a Firefox MV3 build artifact for testing/signing workflows.
- Added **Codex subagents as first-class** sidebar sessions, so running agents stay available even after their chat tabs are closed. Please welcome your copernicos and galileos!
- Added dedicated threads for each Codex subagent, **including independent review tabs and inline review for file changes made by each agent**.
- Added **parent chat breadcrumbs with inline actions for opening subagent threads**, plus persistent parent-child grouping across restarts.

### Changed

- Removed the redundant collapse-all control from the note outline so the panel starts directly with the document structure while preserving per-section collapsing.
- Aligned file-oriented search across Search Files & Notes, New Tab, `@` mentions, and `[[ ]]` wikilink suggestions so all-files mode treats Markdown notes as files first, ranking file name and path matches before note title matches while keeping title search as a fallback.
- Updated wikilink suggestions in all-files mode to display Markdown note file names consistently with the file extension setting, so notes can appear as `example.md` when extensions are enabled without changing the inserted wikilink target.
- Made the wikilink suggestion popup horizontally scrollable so long note names and vault paths can be inspected without widening the popup.

### Fixed

- Fixed a mismatch where the file-oriented search notice promised file-name-first behavior, but Search Files & Notes and New Tab still used older title/path scoring.
- Fixed `@` mention suggestions in all-files mode so note titles remain searchable as a fallback after file name and path matches.

## [0.1.2] - 2026-04-30

### Fixed

- Fixed macOS DMG release validation so GitHub-built desktop release artifacts are staged and checked correctly.
- Fixed opening and using vaults on Windows rclone/WinFsp mounted drives that do not support path canonicalization, without compromising security layer.
- Fixed the drag preview disappearing when dragging items from an expanded sidebar onto editor panes or the chat composer.
- Fixed sticky folder headers in the file tree so they read as a distinct frosted plate, with the same visible blur treatment in both the docked sidebar and the Arc-style peek overlay.
- Fixed detached windows so agent conversations, review tabs, and terminal tabs keep their state when opened, moved, or reattached across windows.

## [0.1.1]

### Fixed

- Fixed the GitHub-built desktop app packaging so the bundled Claude ACP runtime includes its production dependencies.
- Prevented a failed AI runtime startup from blocking provider settings, note loading, and other backend requests indefinitely.
- Improved AI provider settings so providers show as checking while runtime inventory is loading instead of incorrectly offering installs.

## [0.1.0]

- First release. For full changelog, the commit history is available, from the first line of code to the last. 