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

## [0.5.0] - 2026-07-12

### Added

- Added persistent folders to the Agents sidebar, including create, rename, collapse, delete, context-menu organization, and drag-and-drop assignment.
- Added browser-like Back and Forward navigation between AI sessions in a reused chat tab, plus an explicit **Open in New Tab** action for dedicated views.
- Added provider-specific identity icons and refined parent/subagent hierarchy alignment in the Agents sidebar.
- Added a chronological tool-activity timeline to AI chats, with compact activity rails, live progress, clearer completed states, and a Chat setting to show activity expanded, collapsed, or hidden.
- Added in-chat change-review cards with file and Markdown previews, while preserving the existing review surfaces as the canonical place to accept, reject, and undo changes.
- Added navigable breadcrumbs for subagent activity so parent chats can open the relevant child session.
- Added the Codex code-mode companion to packaged desktop builds.

### Changed

- Changed ACP chat session ownership so the Agents sidebar retains live sessions while editor tabs and panes act as temporary views; closing an ACP chat tab no longer stops or deletes its agent. Claude Code terminal entries remain projections of their live terminal and close when that terminal closes.
- Refined AI chat activity, message, code-fence, inline-code, and vault-reference presentation for a clearer and more compact conversation view.
- Updated the embedded Claude ACP runtime to `0.57.0` and the embedded Codex runtime to `0.144.0`, including refreshed configuration options after selecting a model.

### Fixed

- Fixed session deletion and ID migration cleanup so workspace histories, physical tabs, pins, and folder assignments do not retain stale session references.
- Fixed in-chat vault references so extensionless and nested note links resolve reliably, ambiguous basenames are not opened arbitrarily, and line targets are preserved.
- Fixed AI activity projection for duplicate, delayed, and out-of-order tool events so tool output and pending change diffs remain intact.
- Fixed subagent activity lifecycle handling so child status, messages, and wait groups remain accurate across handoffs and restored sessions.

## [0.4.5] - 2026-07-06

### Added

- Added OKF v0.1 document status support, including status indicators in the file tree, editor header status and type badges, trust banners for non-published documents, and a Settings toggle for file tree status dots.
- Added quick document status changes from the editor header, preserving existing frontmatter and recording the local user in `status_by` when available. Thanks to @spamsch
- Added `neverwrite://open` deep links for opening and revealing files inside the current vault, including optional line fragments such as `#L10` and `#L10-L20`. Thanks to @spamsch

### Changed

- Updated the embedded Claude ACP runtime to `0.56.0`.

## [0.4.4] - 2026-07-05

### Added

- Added Mermaid diagram previews for Markdown code fences and standalone Mermaid diagram files, including a source/preview toggle for diagram tabs.

### Fixed

- Fixed sticky folders in the file tree so nested directories stay aligned with their parent scope instead of sticking to the top of the entire tree.

## [0.4.3] - 2026-07-02

### Added

- Added a configurable default PDF zoom setting under Settings > Editor > PDF, including a new Fit width mode that opens PDFs scaled to the current viewport width.
- Added a Fit Width toggle to the PDF toolbar, with session-aware PDF tab state so fit-width mode is restored consistently across reopened tabs and history entries.

### Changed

- Changed the default PDF opening zoom from 100% to Fit width, making documents easier to read on larger screens by default. Thanks to @spamsch.
- Updated the embedded Claude ACP runtime to `0.55.0`.
- Polished the PDF toolbar with a simpler page counter, refined navigation controls, and a more compact layout in narrow panes.

### Fixed

- Fixed PDF fit-width behavior across resize, reopen, and alternate opening paths so the computed zoom remains stable and explicit zoom actions cleanly leave fit-width mode.
- Fixed Claude runtime model fallback coverage for the updated ACP runtime.

## [0.4.2] - 2026-07-01

### Added

- Added Claude Fast Mode support in chat controls, presented as a clear Off/Fast toggle while preserving the underlying ACP values.

### Changed

- Updated the embedded Claude ACP runtime to `0.54.1`, including Claude Sonnet 5 SDK support.

### Fixed

- Fixed Claude model availability when runtime model overrides are used.

## [0.4.1] - 2026-06-30

### Added

- Added RPM packages for Fedora and other RPM-based Linux distributions, including DNF repository metadata for release distribution.

### Changed

- Updated the embedded Claude ACP runtime to `0.53.0`.
- Improved Claude chat titles so automatic thread rename and title updates are consumed automatically, while runtime-provided title information is ignored after the user manually renames a thread.

### Fixed

- Fixed stacked tabs so their horizontal scroll position is preserved when switching between tabs and panes.
- Fixed dragging stacked tabs into the AI composer so stacked pane tabs behave consistently with regular workspace tabs.
- Fixed HTML preview links so external URLs open outside the app instead of navigating the preview window.

## [0.4.0] - 2026-06-26

### Added

- Added per-pane stacked tabs for editor panes, with an Obsidian-style sliding pane layout, persistent per-pane mode, horizontal spine rails, tab type icons, close buttons on every spine, and adaptive sizing for narrow panes.
- Added full drag-and-drop support for stacked tabs, including reordering within a stacked pane, moving stacked columns between panes, splitting them out, and preserving stacked mode when tabs are inserted, moved, or panes are merged.
- Added lazy mounting for stacked tab content so off-screen editor, PDF, CSV, file, chat, review, and history columns stay lightweight until they are revealed.
- Added hover previews for wikilinks, including previews for full notes, heading sections, unresolved notes, PDFs, images, and relative assets.
- Added a global "Note preview on hover" editor setting with a configurable hover delay, plus a keyboard shortcut for previewing the link at the caret.
- Added chat transcript search to active agent tabs and chat history, with Cmd/Ctrl+F support, CSS-highlighted matches, match counts, previous/next navigation, Unicode-safe matching, and pane-scoped highlights.
- Added a prompt outline menu for AI chats so long conversations can be navigated by user prompts.
- Added a visible rename button to the chat title bar, making the existing inline rename flow discoverable without relying on double-click.

### Changed

- Updated the embedded Claude ACP runtime to `0.51.0`.
- Updated the desktop runtime to Electron `42.4`.
- Improved AI user-input option buttons with a pressed state.

### Fixed

- Fixed a live preview crash that could corrupt editor layout or break mode switching after dragging a selection across rendered Markdown tables.
- Fixed chat search behavior while the composer is expanded, when Escape is pressed, and when matches span separate message blocks.
- Fixed wikilink hover preview flicker by prefetching note content before the tooltip opens and keeping the popover width stable.
- Fixed wikilink previews for relative assets.
- Fixed stacked tab scrolling so activating an already visible column no longer unexpectedly shifts neighboring columns.
- Fixed stacked tab hover styling so stacked columns no longer receive the normal tab-strip hover background.
- Hardened stacked tabs against narrow panes and overlay z-index conflicts.

### Security

- Updated Undici from `6.25.0` to `6.27.0`.

## [0.3.6] - 2026-06-19

### Added

- Added an Escape shortcut for stopping the focused agent, with shortcut settings coverage and safeguards so Escape still works correctly in dialogs, menus, and editable controls.

### Changed

- Updated the embedded Claude ACP runtime to `0.47.0`.
- Improved Claude ACP user-input prompts with option values, descriptions, previews, custom "Other" answers, and cleaner response handling.
- Delayed the floating selection toolbar until mouse selection finishes so it no longer appears while dragging across editor text.
- Hid the editor active-line highlight when the editor is not focused.

### Fixed

- Fixed drag-selection visibility in the editor.
- Fixed context-menu submenus so moving across the hover gap keeps nested menus open, including left-opening submenus.

### Removed

- Removed the Gemini ACP provider integration after upstream Gemini CLI subscription changes redirected users toward Antigravity, which does not expose ACP support for third-party apps.

### Security

- Updated DOMPurify dependency resolutions in the desktop app and Web Clipper.

## [0.3.5] - 2026-06-17

### Added

- Added native image attachments to the AI composer, including paste/drop support, provider-aware limits, validation feedback, ACP image prompt blocks for capable providers, timeline rendering, chat history/export persistence, and opening sent images in app tabs.
- Added a Settings toggle for editor active line highlighting.

### Changed

- Polished Markdown live preview footnotes so named references render as sequential superscript numbers with matching definition badges while keeping raw labels editable.
- Centered outline and footnote jump destinations in the editor and added a brief landing flash so navigation targets are easier to locate.
- Flattened pane header action buttons with a simpler divider treatment.

### Fixed

- Fixed live preview footnote navigation so clicking a footnote reference scrolls to off-screen definitions reliably without moving the caret unless the number itself is clicked.
- Fixed adjacent live preview footnote references so they keep a stable superscript baseline and remain legible when citations are abutting.
- Fixed live preview block refreshes after parser updates so embedded preview blocks stay in sync with Markdown edits.
- Fixed window dragging from the docked sidebar header band after sidebar collapse and expand transitions.
- Fixed queued AI image edits so pasted image attachments are not duplicated.

## [0.3.4] - 2026-06-16

### Added

- Added support for ACP form and URL elicitations so agents can request structured input, multi-select answers, skip/cancel decisions, and browser follow-up actions from the chat flow.
- Added mixed ACP runtime compatibility so Claude can use the newer ACP stack while Gemini and Grok continue to run through legacy ACP sessions.

### Changed

- Updated the embedded Claude ACP runtime to `0.44.0` and the vendored ACP bridge baseline to `0.16.0`.
- Improved Grok model controls by preventing incompatible in-session model switches and explaining when a new Grok chat is required.
- Reduced Gemini transcript noise by hiding topic-update activity from chat history.
- Documented mixed ACP runtime compatibility, Claude ACP packaging checks, and related troubleshooting guidance.

### Fixed

- Fixed Gemini legacy sessions inheriting the wrong API-key authentication type.
- Hardened ACP user-input and review-interaction handling so accept, decline, skip, cancel, retry, and multi-answer flows stay consistent.

### Security

- Updated desktop and Web Clipper dependency resolutions, including `vite`, `dompurify`, `form-data`, `js-yaml`, `tar`, and `tmp`.
- Patched desktop Babel tooling and Web Clipper build tooling dependencies.

## [0.3.3] - 2026-06-07

### Added

- Added a native Grok ACP provider, including automatic detection for the official Grok CLI install path.

### Changed

- Updated the embedded Claude ACP runtime to `0.42.0`.
- Removed the Claude Code max-turns setting now that Claude Code manages turn limits internally.
- Constrained the AI chat transcript, composer, and action panels to a shared readable width.
- Top-aligned newly streamed chat messages so incoming responses stay easier to scan.

### Fixed

- Fixed dropped Excalidraw files so they open as maps instead of plain files.
- Fixed AI chat links so raw URLs are clickable and external links open in the system browser.
- Fixed runtime message timeline ordering so user messages, errors, and subagent activity stay in the correct transcript order.
- Fixed hook dependency warnings in the AI review UI.
- Fixed APT release asset publishing for Debian packages.

## [0.3.2] - 2026-06-01

### Added

- Added opt-in Vim mode for the editor, including Settings controls, relative line numbers, a Vim status bar, and Vim command handling. Thanks to @Abdulkader-Safi.
- Added a terminal dictation overlay for composing terminal input before sending it. Thanks to @spamsch.
- Added Claude Code terminal sessions to the Agents sidebar, with live transcript-derived titles and previews plus focus and close actions. Thanks to @spamsch.
- Added screenshot retention controls for AI chat screenshots, including automatic cleanup for expired screenshots and a `Forever` option.

### Changed

- Reworked terminal output rendering so PTY output streams directly into xterm, improving reliability and responsiveness under heavy Claude Code output. Thanks to @spamsch.
- Updated the embedded Claude ACP runtime to `0.39.0`.
- Clarified recent feature documentation and settings scope docs, including which settings are global and which are vault-scoped.
- Changed Debian release publishing so updater feeds are published before APT validation.

### Fixed

- Fixed historical AI chat diff cards so older diffs remain inspectable after later file edits.
- Fixed Pending Changes edited-files tray overflow so large review lists remain usable.
- Fixed closed subagent sessions so closed child-agent conversations stay closed across store rebuilds and resume paths.
- Fixed primary-vault window session restoration when the stored vault value is narrowed to a path.
- Fixed Debian APT repository publication and validation for release assets hosted on GitHub Releases.

### Security

- Updated the Web Clipper workspace dependency metadata to address the transitive `tmp` advisory.

## [0.3.1] - 2026-05-28

### Changed

- Updated the embedded Claude Code runtime to `2.1.154`, including compatibility with the newer thinking-token telemetry event emitted by the Claude SDK.
- Changed APT repository publishing so Debian `.deb` binaries stay on GitHub Releases while signed APT metadata remains on GitHub Pages, keeping Linux installs pointed at release assets without publishing large package files to the Pages branch.
- Updated the desktop app's transitive `tmp` dependency to `0.2.6`.

### Fixed

- Fixed HTML preview tabs so iframe previews no longer swallow internal file-tree or agent-sidebar drag events, restoring reliable drag interactions across HTML previews.
- Fixed APT repository validation for Debian packages published through remote GitHub Release URLs.

## [0.3.0] - 2026-05-27

### Added

- Promoted Terminal to a first-class workspace feature, including terminal tabs, theme-aware ANSI palettes, Terminal settings, and Claude Code CLI integration as a built-in agent provider. Thanks to @spamsch.
- Added native OpenCode ACP provider support, including CLI auth, diagnostics, provider settings, runtime smoke coverage, and setup-state handling without storing OpenCode secrets in NeverWrite.
- Added file tree extension filtering for power users with mixed vaults, with a curated default file set and consistent filtering across the file tree, `@` mentions, New Tab, Quick Switcher, Search Files & Notes, and wikilink suggestions.
- Added support for dragging files from Finder into vault folders, including folder hover feedback, multiple-file drops, root drops, and existing-name deduplication. Thanks to @spamsch.
- Added keyboard shortcut hints to the empty workspace pane so Open File, Command Palette, New Agent, and New Terminal actions show their current platform shortcuts.
- Added an AI chat warning when a resumed session drops previously approved external directories because they are no longer accessible.
- Added Debian `.deb` release packages for amd64 and arm64 Linux installs, while keeping AppImage as the portable Linux package and updater target.
- Added signed APT repository publishing for Debian packages, including GitHub Pages metadata, package retention, signed `InRelease`/`Release.gpg` files, validation, and user install documentation.
- Added a repository security policy with private vulnerability reporting guidance.
- Added Settings links for GitHub issues, GitHub discussions, Buy Me a Coffee, and GitHub Sponsors.

### Changed

- Updated the embedded Claude ACP runtime to `0.37.0`, including first-class additional directory support so approved external roots persist across session create, load, resume, and fork paths.
- Updated the embedded Codex ACP runtime vendor to the `0.15` line and aligned the desktop/backend protocol dependency with `agent-client-protocol` `0.12.1`.
- Updated Mermaid to `11.15.0`, bringing newer diagram syntax and upstream rendering fixes.
- Clarified default agent preference behavior so explicit provider choices win over the current or last-used runtime, while Automatic keeps contextual selection.
- Clarified File Tree settings, renamed the old Developers section to File Tree, and removed the duplicate Line wrapping setting from that section.
- Polished Settings navigation around the main product workflows, moved Updates later, clarified that updates are checked automatically but installed manually, and added tactile press styling to Settings action buttons.
- Polished APT repository metadata with streamed hashing for large packages, Debian-specific checksum casing, and a `neverwrite-stable` repository codename.

### Fixed

- Fixed terminal rendering crashes and jank under heavy Claude Code output by batching PTY output, adding terminal write backpressure, enabling the WebGL renderer when available, and avoiding repeated cold-path terminal resets. Thanks to @spamsch.
- Fixed AI provider default selection so choosing Claude Code or another provider in Settings is not overwritten by a racing chat-store initialization.
- Fixed Claude/OpenCode structured diff handling so chat review snippets preserve the exact hunk shown to the review system, keep stable line numbers, survive history restore, and do not leak later edits into older cards.
- Fixed Pending Changes review tabs so wide/center mode and scroll position persist reliably when switching tabs or remounting the review view.
- Fixed file tree multi-selection cleanup so selected files and folders clear when focus moves back into an editor or workspace pane.
- Fixed fatal startup fallback rendering so exception text is displayed as text instead of being assigned through `innerHTML`.
- Fixed Web Clipper YAML frontmatter date detection so only explicit ISO-like dates and timestamps are quoted as YAML-implicit dates.

### Security

- Hardened Web Clipper public HTTP responses so internal exception details, stack traces, local paths, and arbitrary unknown values cannot be serialized back to the browser extension.
- Hardened Claude local command metadata stripping by replacing a broad regex with a deterministic scanner over known marker tags, avoiding a potential local denial-of-service pattern.
- Reduced release metadata workflow permissions to the minimum needed for validation.
- Patched vulnerable transitive dependencies across the desktop app, web clipper, and Rust backend, including `rustls-webpki`, `uuid`, `rand`, `brace-expansion`, and `ws`.

## [0.2.7] - 2026-05-19

### Added

- Added keyboard navigation for the file tree, including Next File and Previous File shortcuts (`Cmd/Ctrl+Shift+Down` and `Cmd/Ctrl+Shift+Up`) that can move through files inside collapsed folders.
- Added a New Terminal shortcut (`Cmd+R` on macOS, `Ctrl+R` on Windows/Linux), available from the app menu and shortcut settings.
- Added Fliege Mono as an editor font option.

### Changed

- Updated the embedded Claude ACP runtime to upstream `0.35.0`, including the `0.34.0` gateway and authorization compatibility updates.
- Polished app chrome and core controls with more tactile hover, press, focus, and open states across sidebar tabs, agent controls, settings controls, the vault switcher, tab close buttons, and the chat composer.
- Changed the expanded chat composer so it collapses after sending and keeps its action row stable during queued sends or stop actions.

### Fixed

- Fixed frontmatter property editing so values keep their intended spaces.
- Fixed live preview rendering around tables, inline markup boundaries, and empty list items so caret placement, marker alignment, and spacing remain stable while editing.
- Fixed YouTube embeds opened in theater mode so their video identity is recognized correctly.
- Fixed restored AI chat sessions so transcript hydration preserves usable conversation history.
- Fixed the agent sidebar drag lifecycle so thread dragging, previews, and cleanup behave consistently.

## [0.2.6] - 2026-05-15

### Added

- Added per-theme syntax highlighting for CodeMirror source mode, live preview markup, chat code blocks, and static diff/code rendering, with shared `--code-*` CSS variables so theme changes stay consistent across editor surfaces.
- Added a compact searchable Move to Folder destination picker for notes, PDFs, generic files, folders, and mixed selections from the file-tree context menu.
- Added pane-scoped tab context menu actions for `Close Others` and `Close Tabs to the Right`, including active-agent close confirmation and disabled states when the actions do not apply.

### Changed

- Updated Developer Mode settings copy to describe terminal tabs in the editor workspace instead of the old bottom terminal panel. Thanks to @mvanhorn.
- Added a README notice about Claude subscription usage in NeverWrite starting June 15, 2026.

### Fixed

- Fixed Move to Folder behavior so context menu moves and drag/drop moves share the same move executor and support notes, PDFs, generic files, folders, and mixed selections consistently.

## [0.2.5] - 2026-05-12

**Security note:** NeverWrite's repository was audited for the May 2026 **Mini Shai-Hulud** npm supply-chain attack and no exposure was found. The repo does not contain the known malware indicators, does not depend on the affected TanStack/Mistral/UiPath/Squawk package sets, and its own GitHub workflows do not use the risky `pull_request_target` plus trusted-publishing/OIDC pattern involved in the attack. **Cloning the repository and updating the app through this channel is safe**.

### Added

- Added Linux AppImage releases for x64 and ARM64, including Linux update feed support and AppImage updater integration. Thanks to @seifzellaban.
- Added Kilo API key setup in AI provider settings, with `KILO_API_KEY` detection, secure local persistence, logout cleanup, and setup-state validation alongside the existing Kilo CLI login flow.
- Added an in-app HTML viewer for vault `.html` and `.htm` files, including sandboxed script execution, relative asset loading, and restrictive network protections. You can now ask agents to create HTML documents or dashboards in your vault and preview them inside the app. Thanks to @spamsch.
- Added `.html` and `.htm` files to the default file tree so HTML documents appear without enabling the global all-files view. Thanks to @spamsch.

### Changed

- Updated the embedded Claude ACP runtime to upstream `0.33.1`, keeping the vendored Claude agent adapter aligned with current upstream behavior.
- Updated the embedded Codex agent runtime to `0.14.0`, keeping subagents, permissions, history replay, and change-review metadata compatible with NeverWrite.
- Polished Linux-specific desktop packaging behavior, window chrome, updater handling, and cross-platform shortcut behavior as part of the AppImage release path.

### Fixed

- Fixed chat Markdown rendering so slash-prefixed text is no longer converted into a clickable vault pill unless it resolves to a valid vault reference.
- Fixed dragging agent chats from the collapsed sidebar so the sidebar overlay stays active while the drag starts.
- Fixed inline file-review Accept and Reject buttons so decisions run on click release instead of immediately on press.
- Fixed review tabs for subagents so pending-change reviews show the subagent name instead of the generic runtime label.
- Fixed provider quota, rate-limit, and usage-limit failures so the chat shows a clear provider-limit message instead of treating the error like a setup or authentication failure.
- Fixed oversized saved AI session transcripts by compacting new saves and repairing previously inflated saved chats on load.
- Fixed vault scans, text-file reads, and watcher/upsert hashing for Markdown and text files that contain invalid UTF-8 bytes by decoding them lossily instead of failing the vault operation. Thanks to @kwojtaszek.
- Fixed Linux updater handling when a release feed is missing so the app can continue gracefully across Linux release variants.
- Fixed macOS single-architecture DMG post-processing so x64 and ARM64 release layouts are found correctly. Thanks to @spamsch.

### Security

- Secured persisted AI provider secrets for Codex/OpenAI, Claude/Anthropic, Gemini/Google, and newly added Kilo API keys through OS credential storage instead of storing secret values in runtime setup JSON.
- Added migration for legacy plaintext AI provider setup data, transactional setup/logout persistence, fail-closed behavior when secure storage is unavailable, and broader redaction for native backend secret logs.

## [0.2.4] - 2026-05-08

### Added

- Added file-tree context menu actions to add notes, folders, PDFs, and sidebar files directly to the current chat composer as context pills.
- Added "Add to New Chat" and "Add Selected to New Chat" actions from the file tree, opening a fresh agent chat with the currently selected/last active provider before attaching the chosen context.
- Added multi-selection-aware chat context actions for selected notes and sidebar files in the file tree.
- Added local app diagnostics logs for Electron main, renderer, and native backend events, with documented log locations and privacy notes.
- Added saved-chat crash recovery docs and recovery flow for AI conversations stored locally under each vault's `.neverwrite/sessions/` directory.
- Added native saved-session resume support for Codex when available, with a saved-transcript fallback path when direct runtime resume is unavailable or fails.

### Changed

- Changed file-tree path copy actions to consistently use "Copy Full Path" and copy absolute paths for notes, folders, PDFs, and sidebar files.

### Fixed

- Fixed external vault refresh handling so ambiguous external deletes, including folders that look like Markdown notes, refresh the vault structure instead of leaving the file tree stale.
- Fixed closing active AI agent tabs so NeverWrite asks for confirmation consistently, including Cmd/Ctrl+W and multi-tab close paths. Thanks to @wtasg for the first contribution!
- Fixed Codex saved chats so restored, detached, resumed, or crash-recovered sessions keep enough transcript context to continue without losing the prior conversation.
- Fixed Codex subagent breadcrumb `Open` actions so they continue working after restore or resume even when the live `sessionId` differs from the saved history or runtime session id.
- Fixed detached windows and tab reattachment for AI chats so related parent, child, and sibling subagent sessions transfer and hydrate together instead of losing the agent tree.
- Fixed file-tree chat context targeting so context menu actions and drops attach to the intended chat, including newly opened chats whose composer is still mounting.
- Fixed normal native backend shutdown so expected sidecar exits no longer appear as app errors.

### Security

- Hardened diagnostic log redaction for prompt, transcript, message, content, token, secret, authorization, and API key fields, including `apiKey`, `api_key`, `api-key`, and `x-api-key` variants.

## [0.2.3] - 2026-05-05

### Added

- Added a "release notes" button in Settings → Updates that opens the latest GitHub release in the user's browser.
- Added pane-native drag and drop for Agents sidebar threads: drag a chat or subagent from the sidebar onto a pane, tab strip, or pane edge to open it there, move the existing chat tab without duplicating it, or create a new split pane.
- Added a floating drag preview for Agents sidebar threads, including the thread title, runtime, and active/error state while dragging.

### Changed

- Changed file-tree drag behavior so dropping existing notes, PDFs, and files onto editor panes opens them as tabs instead of inserting embed markup into the active note.
- Changed file-tree and external file drops to use the same pane-native targeting as workspace tabs: drop on a pane center to open there, on a tab strip to choose the tab position, or on a pane edge to create a split. Drops over the AI composer still attach to the chat composer instead of opening editor panes.
- Polished the chat composer expand/collapse button: the diagonal arrows now point toward the natural corners (top-right / bottom-left when collapsed, inward when expanded) and the button gains a subtle hover highlight that matches the other composer controls.

### Fixed

- Fixed AI chat tabs restored from saved history so their `persisted:*` identifiers no longer leak into live runtime commands, preventing repeated "AI session not found" errors when switching between a Markdown note and an empty or saved chat in the same pane.
- Fixed workspace tab dragging so file-attachment drag events emitted by tabs no longer clear the pane split/drop preview.

## [0.2.2] - 2026-05-03

### Changed

- Updated the embedded Claude ACP runtime to the latest upstream `0.31.4` snapshot, keeping NeverWrite aligned with Claude Code `v2.1.123` and picking up upstream runtime dependency fixes.

### Security

- Updated the embedded Claude ACP runtime's vendored dependencies to include upstream Hono security fixes for JSX tag validation and chunked request body limits.

### Fixed

- Fixed Codex subagent threads so their sidebar `Working` state now follows the child agent's own turn lifecycle instead of relying on parent-thread breadcrumbs.
- Fixed subagent completion handling so child threads return to idle when their ACP turn completes, aborts, or shuts down, even when the parent thread is not actively open.
- Fixed stale Codex subagent turn completion events so an older completed turn can no longer mark a reactivated child agent as idle while it is already working on a newer turn.
- Fixed subagent reactivation so resumed or still-running child agents are no longer incorrectly marked idle by parent `interaction_end`, `resume_end`, or `waiting_end` breadcrumbs.
- Fixed subagent reactivation in the sidebar so live child sessions can return to `Working` from backend lifecycle updates while root sessions remain protected from stale streaming updates.
- Fixed multi-subagent waiting updates so a completed child no longer causes every sibling subagent under the same parent to stop showing as working.
- Fixed Codex ACP lifecycle projection by emitting structured turn lifecycle metadata and structured waiting-status metadata for subagents.

## [0.2.1] - 2026-05-02

### Added

- Added Web Clipper release artifacts to the `0.2.1` GitHub Release pipeline, including Chrome MV3 manual-install and Firefox MV3 testing/signing zips.
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
- Documented a Codex subagent edge case where models may try to combine a full-history fork with explicit child role, model, or reasoning-effort overrides; Codex rejects that combination and the parent may retry visibly with a non-forked launch.

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
