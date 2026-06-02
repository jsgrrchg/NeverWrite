# Settings Scope

This page documents the current settings and preference storage boundaries in
NeverWrite. It is meant as a maintenance reference for changes to Settings,
review behavior, AI preferences, vault-specific state, and local UI state.

The short version:

- Most desktop Settings values are scoped to the current vault and are stored in
  `neverwrite:settings:<vault-path>`.
- Vim settings are global even though they are shown inside Editor settings.
- Theme is vault-scoped after migration, with a global fallback for first run and
  legacy data.
- AI chat preferences are mostly global, except auto-context, which is
  per-vault.
- Some persisted values are UI state or caches, not user-facing settings. They
  are listed separately because they still affect debugging and privacy.

Related implementation references:

- [`settingsStore.ts`](../apps/desktop/src/app/store/settingsStore.ts)
- [`SettingsPanel.tsx`](../apps/desktop/src/features/settings/SettingsPanel.tsx)
- [`themeStore.ts`](../apps/desktop/src/app/store/themeStore.ts)
- [`chatStore.ts`](../apps/desktop/src/features/ai/store/chatStore.ts)
- [`graphSettingsStore.ts`](../apps/desktop/src/features/graph/graphSettingsStore.ts)
- [`data-and-privacy.md`](data-and-privacy.md)

## Scope Model

Desktop renderer preferences use the `safeStorage` wrapper, which prefers
`window.localStorage` and falls back to in-memory storage when localStorage is
unavailable.

The main settings store uses these keys:

| Storage key | Scope | Contents |
| --- | --- | --- |
| `neverwrite:settings` | Global fallback | Legacy fallback data plus the explicitly global Vim settings. |
| `neverwrite:settings:<vault-path>` | Per-vault | Main `Settings` values for the vault, excluding explicitly global keys. |
| `neverwrite:lastVaultPath` | Global app state | Initial vault path lookup for hydration, not a user-facing setting itself. |

`GLOBAL_SETTING_KEYS` currently contains only:

| Setting | Scope |
| --- | --- |
| `vimModeEnabled` | Global |
| `vimRelativeLineNumbers` | Global |

When a vault is open, `settingsStore` writes all other `Settings` values to
`neverwrite:settings:<vault-path>` and writes the Vim values back to
`neverwrite:settings`. When no vault is available, the fallback key can contain a
full `Settings` object.

## Settings Panel Matrix

These are the settings exposed through the desktop Settings panel or backed by
the same Settings stores.

| UI area | Setting | Scope | Default | Storage / source | Notes |
| --- | --- | --- | --- | --- | --- |
| General / Startup | `openLastVaultOnLaunch` | Per-vault, fallback when no vault is open | `true` | `neverwrite:settings:<vault-path>` | Semantically startup-like, but persisted with the current vault when one is open. |
| General / Tabs | `tabOpenBehavior` | Per-vault | `history` | `neverwrite:settings:<vault-path>` | Valid values are `history` and `new_tab`. |
| Appearance / Mode | `mode` | Per-vault, legacy global fallback | `system` | `neverwrite:theme:<vault-path>` | Valid values are `system`, `light`, and `dark`. |
| Appearance / Mode | `themeName` | Per-vault, legacy global fallback | `default` | `neverwrite:theme:<vault-path>` | `isDark` is derived from `mode` plus OS preference. |
| Appearance / Navigation | `fileTreeScale` | Per-vault | `114` | `neverwrite:settings:<vault-path>` | Clamped to `90..140`. |
| Appearance / Navigation | `agentsSidebarScale` | Per-vault | `100` | `neverwrite:settings:<vault-path>` | Clamped to `90..140`. |
| Appearance / Navigation | `fileTreeStickyFolders` | Per-vault | `true` | `neverwrite:settings:<vault-path>` | Controls sticky parent folders in the file tree. |
| Appearance / Zoom | `appZoom` | Global | `1` | `neverwrite:appZoom` | Stored outside `settingsStore`; normalized by `appZoom.ts`. |
| Editor / Typography | `editorFontSize` | Per-vault | `14` | `neverwrite:settings:<vault-path>` | Clamped to `10..24`. |
| Editor / Typography | `editorFontFamily` | Per-vault | `system` | `neverwrite:settings:<vault-path>` | Validated against `EDITOR_FONT_FAMILY_OPTIONS`. |
| Editor / Typography | `editorLineHeight` | Per-vault | `175` | `neverwrite:settings:<vault-path>` | Percentage, clamped to `120..220`. |
| Editor / Typography | `editorAutosaveDelayMs` | Per-vault | `300` | `neverwrite:settings:<vault-path>` | Clamped to `50..5000`. |
| Editor / Formatting | `lineWrapping` | Per-vault | `true` | `neverwrite:settings:<vault-path>` | Used by editor and review surfaces. |
| Editor / Formatting | `justifyText` | Per-vault | `false` | `neverwrite:settings:<vault-path>` | Only meaningful when wrapping is enabled. |
| Editor / Formatting | `livePreviewEnabled` | Per-vault | `true` | `neverwrite:settings:<vault-path>` | Controls source vs live-preview editor mode; also exposed through quick actions outside the Settings panel. |
| Editor / Formatting | `tabSize` | Per-vault | `2` | `neverwrite:settings:<vault-path>` | Normalized to `2` or `4`. |
| Editor / Vim | `vimModeEnabled` | Global | `false` | `neverwrite:settings` | Migrated from vault-scoped data if found. |
| Editor / Vim | `vimRelativeLineNumbers` | Global | `false` | `neverwrite:settings` | Migrated from vault-scoped data if found. |
| Editor / Layout | `editorContentWidth` | Per-vault | `940` | `neverwrite:settings:<vault-path>` | Clamped to `600..1200`. |
| PDF toolbar | `pdfFilter` | Per-vault | `none` | `neverwrite:settings:<vault-path>` | Cycled from the PDF tab toolbar. Valid values are `none`, `dark`, `sepia`, and `grayscale`. |
| AI / Context | `inlineReviewEnabled` | Per-vault | `true` | `neverwrite:settings:<vault-path>` | Gates inline review in source mode. This is a review-system correctness setting. |
| AI / Context | `autoContextEnabled` | Per-vault, global fallback | `false` | `neverwrite.ai.auto-context:<vault-path>` | Legacy `neverwrite.ai.preferences.autoContextEnabled` is still read as fallback. |
| AI / Chat | `chatFontFamily` | Global | `system` | `neverwrite.ai.preferences` | Validated with editor font-family normalization. |
| AI / Chat | `chatFontSize` | Global | `14` | `neverwrite.ai.preferences` | Chat transcript font size. |
| AI / Chat | `historyRetentionDays` | Global preference, applied to current vault histories | `0` | `neverwrite.ai.preferences` | `0` means forever; pruning operates on the currently open vault's `.neverwrite/sessions/`. |
| AI / Composer | `requireCmdEnterToSend` | Global | `false` | `neverwrite.ai.preferences` | Changes Enter behavior in the AI composer. |
| AI / Composer | `contextUsageBarEnabled` | Global | `true` | `neverwrite.ai.preferences` | Shows or hides composer context usage. |
| AI / Composer | `screenshotRetentionSeconds` | Global | `0` | `neverwrite.ai.preferences` | `0` means forever. |
| AI / Composer | `composerFontFamily` | Global | `system` | `neverwrite.ai.preferences` | Validated with editor font-family normalization. |
| AI / Composer | `composerFontSize` | Global | `14` | `neverwrite.ai.preferences` | Composer input font size. |
| AI Providers | `defaultRuntimeId` | Global | Runtime-dependent | `neverwrite.ai.preferences` | Preferred runtime for new chats. |
| AI Providers | `modelId` | Global | Runtime-dependent | `neverwrite.ai.preferences` | Last selected model preference when supported by the active runtime. |
| AI Providers | `modeId` | Global | Runtime-dependent | `neverwrite.ai.preferences` | Last selected mode preference when supported by the active runtime. |
| AI Providers | `configOptions` | Global | Runtime-dependent | `neverwrite.ai.preferences` | Last selected runtime config options. Model and mode option categories also update `modelId` and `modeId`. |
| AI Providers | Runtime setup metadata | Global app-data | Empty | `<app-data>/ai/runtime-setup.json` | Stores non-secret env values, auth method, custom binary path, auth invalidation time, and names of configured secret keys. |
| AI Providers | Runtime secret values | Global OS credential store | Empty | `NeverWrite AI Provider Secrets` | API keys and secret headers are stored in the OS keyring, not localStorage. |
| Spellcheck / Languages | `editorSpellcheck` | Per-vault | `false` | `neverwrite:settings:<vault-path>` | The global-to-vault migration explicitly resets this to `false` for the new vault entry. |
| Spellcheck / Languages | `spellcheckPrimaryLanguage` | Per-vault | `system` | `neverwrite:settings:<vault-path>` | Legacy `spellcheckLanguage` is still migrated. |
| Spellcheck / Languages | `spellcheckSecondaryLanguage` | Per-vault | `null` | `neverwrite:settings:<vault-path>` | Normalization prevents duplicating the primary language. |
| Spellcheck / Grammar Check | `grammarCheckEnabled` | Per-vault | `false` | `neverwrite:settings:<vault-path>` | Enables LanguageTool grammar checks. |
| Spellcheck / Grammar Check | `grammarCheckServerUrl` | Per-vault | `""` | `neverwrite:settings:<vault-path>` | Trimmed on load; empty means the built-in/public default path used by the feature. |
| Terminal / Font | `terminalFontFamily` | Per-vault | `""` | `neverwrite:settings:<vault-path>` | Empty string means use the built-in terminal font stack. |
| Terminal / Font | `terminalFontSize` | Per-vault | `13` | `neverwrite:settings:<vault-path>` | Clamped to `8..24`. |
| Terminal / Shell Environment | `claudeCodeOptimized` | Per-vault | `false` | `neverwrite:settings:<vault-path>` | Adds `CLAUDE_CODE_NO_FLICKER=1` to newly opened Claude Code terminals. |
| Terminal / Claude Code | `claudeCodeSkipPermissions` | Per-vault | `false` | `neverwrite:settings:<vault-path>` | Enables the Claude Code skip-permissions launch flag. |
| Terminal / Claude Code | `claudeCodeModel` | Per-vault | `""` | `neverwrite:settings:<vault-path>` | Empty string means Claude Code default. |
| Terminal / Claude Code | `claudeCodeContinueSession` | Per-vault | `false` | `neverwrite:settings:<vault-path>` | Adds continue/resume behavior for new Claude Code terminal launches. |
| Terminal / Claude Code | `claudeCodeMaxTurns` | Per-vault | `0` | `neverwrite:settings:<vault-path>` | `0` means unlimited; storage normalization clamps to `0..1000`. |
| File Tree | `fileTreeContentMode` | Per-vault | `notes_only` | `neverwrite:settings:<vault-path>` | Valid values are `notes_only` and `all_files`. Affects file tree, file pickers, mentions, and wikilink suggestions. |
| File Tree | `fileTreeShowExtensions` | Per-vault | `false` | `neverwrite:settings:<vault-path>` | Shows full filenames with extensions. |
| File Tree | `fileTreeExtensionFilter` | Per-vault | `[]` | `neverwrite:settings:<vault-path>` | Lowercase extension allowlist; normalized by stripping leading dots and duplicates. |
| Vault | Recent vaults | Global | `[]` | `neverwrite:recentVaults` | Recent and pinned vault metadata. The main process also mirrors a shortened list to `<app-data>/recent_vaults.json`. |
| Vault | Last vault path | Global | `null` | `neverwrite:lastVaultPath` | Used for startup and initial settings/theme hydration. |
| Updates | Update configuration/status | Derived runtime state | N/A | Electron updater APIs | Settings shows version, channel, endpoint, status, and available update. These are not persisted user preferences in the renderer. |
| Shortcuts | Shortcut reference | Static/derived | N/A | Shortcut registry | Settings currently displays registered shortcuts; it does not persist user shortcut overrides. |
| Feedback / Sponsors | Links | Static | N/A | Settings UI | No persisted settings. |

## Graph Settings

Graph settings use Zustand `persist` under the key `vault-graph-settings`. Most
graph settings are global preferences, with one explicit per-vault map:
`defaultModeByVault`.

| Setting | Scope | Default | Notes |
| --- | --- | --- | --- |
| `graphMode` | Global | `global` | Current graph mode. |
| `rendererMode` | Global | `2d` | Valid values are `2d` and `3d`. |
| `localDepth` | Global | `2` | Local graph traversal depth. |
| `qualityMode` | Global | `auto` | Can resolve to quality presets. |
| `layoutStrategy` | Global | `preset` | Force/preset/overview/cluster strategy. |
| `defaultModeByVault` | Per-vault map inside global key | `{}` | Maps vault paths to their default graph mode. |
| `centerForce` | Global | `0.3` | Force layout tuning. |
| `repelForce` | Global | `80` | Force layout tuning. |
| `linkForce` | Global | `0.3` | Force layout tuning. |
| `linkDistance` | Global | `60` | Force layout tuning. |
| `nodeSize` | Global | `3` | Graph display. |
| `linkThickness` | Global | `0.5` | Graph display. |
| `showTitles` | Global | `true` | Graph label display. |
| `textFadeThreshold` | Global | `0.6` | Graph label fade threshold. |
| `arrows` | Global | `false` | Link arrow display. |
| `glowIntensity` | Global | `50` | Graph display. |
| `maxGlobalNodes` | Global | `8000` | Global graph cap. |
| `maxGlobalLinks` | Global | `24000` | Global graph cap. |
| `maxOverviewNodes` | Global | `400` | Overview graph cap. |
| `maxOverviewLinks` | Global | `1200` | Overview graph cap. |
| `maxLocalNodes` | Global | `2500` | Local graph cap. |
| `maxLocalLinks` | Global | `12000` | Local graph cap. |
| `searchFilter` | Global persisted UI state | `""` | Persisted filter text; not usually treated as a durable setting. |
| `showOrphans` | Global | `true` | Graph filter. |
| `showTagNodes` | Global | `false` | Graph filter. |
| `showAttachmentNodes` | Global | `false` | Graph filter. |
| `groups` | Global | `[]` | Ordered graph groups. |
| `panelOpen` | Global persisted UI state | `false` | Panel visibility, not a behavioral setting. |

Graph layout snapshots are caches, not settings. They are stored with the
`vault-graph-layout:v1:` prefix and include the vault path in the serialized key.

## Other Persisted Desktop State

These values are not all Settings-panel controls, but they are user-visible
preferences, workspace state, or privacy-relevant local state.

| Storage key | Scope | Default | Owner | Notes |
| --- | --- | --- | --- | --- |
| `neverwrite:theme` | Global fallback / legacy | `{ mode: "system", themeName: "default" }` | `themeStore.ts` | Migrated into `neverwrite:theme:<vault-path>` when a vault opens. |
| `neverwrite:theme:<vault-path>` | Per-vault | Global theme or default | `themeStore.ts` | Active theme preference for the vault. |
| `neverwrite:bookmarks:<vault-path>` | Per-vault | Empty folders/items | `bookmarkStore.ts` | Bookmark folders and entries for the vault. |
| `neverwrite.session.tabs` | Global fallback / legacy | None | `editorSession.ts` | Legacy fallback for workspace tabs. |
| `neverwrite.session.tabs:<vault-path>` | Per-vault | Current workspace | `editorSession.ts` | Editor tabs and workspace restore state. |
| `neverwrite.chat.tabs:<vault-path>` | Per-vault | Initial chat tab state | `chatTabsStore.ts` | Chat tab workspace for the vault. |
| `neverwrite.ai.review.view:<vault-or-__global__>:<session-id>` | Per-vault plus session | None | `reviewTabPersistence.ts` | Review tab UI state such as expanded files, scroll, anchors, zoom, and wide mode. |
| `neverwrite.devtools.terminal.tabs:<vault-path>` | Per-vault legacy migration | Initial terminal tab | `useTerminalTabs.ts` / `legacyTerminalMigration.ts` | Older standalone terminal workspace state, migrated into `neverwrite.session.tabs:<vault-path>`. |
| `neverwrite.workspace.terminal.legacyMigrated:<vault-path>` | Per-vault migration marker | None | `legacyTerminalMigration.ts` | Marks migration from older terminal workspace state. |
| `neverwrite.terminal.replay:<terminal-id>` | Per-terminal | None | `terminalRuntimeStore.ts` | Terminal replay buffer snapshot; cache/state, not a setting. |
| `neverwrite.sidebar.width` | Global layout | `280` | `layoutStore.ts` | Sidebar width. |
| `neverwrite.sidebar.collapsed` | Global layout | `false` | `layoutStore.ts` | Sidebar collapsed state. |
| `neverwrite.sidebar.view` | Global layout | `files` | `layoutStore.ts` | Active left sidebar view. |
| `neverwrite.rightpanel.width` | Global layout | `280` | `layoutStore.ts` | Right panel width. |
| `neverwrite.rightpanel.collapsed` | Global layout | `false` | `layoutStore.ts` | Right panel collapsed state. |
| `neverwrite.rightpanel.view` | Global layout | `outline` | `layoutStore.ts` | Active right panel view. |
| `neverwrite.editor-pane.sizes` | Global layout | `[1]` | `layoutStore.ts` | Editor pane split ratios. |
| `neverwrite:sort-mode` | Global file tree preference | `name_asc` | `FileTree.tsx` | File tree sort mode. |
| `neverwrite:reveal-active` | Global file tree preference | `false` | `FileTree.tsx` | Whether the file tree reveals the active tab. |
| `neverwrite:file-tree-expanded-folders:<vault-path>` | Per-vault file tree state | None | `FileTree.tsx` | Expanded folder paths. |
| `neverwrite.fileTree.clipboard` | Global transient state | None | `fileTreeClipboard.ts` | File tree copy/cut payload. |
| `neverwrite.search.history` | Global preference/state | `[]` | `searchHistory.ts` | Recent search queries. |
| `neverwrite.chats.pinnedIds` | Global preference/state | `[]` | `pinnedChatsStore.ts` | Pinned chat session ids. |
| `neverwrite.ai.agentsSidebar.collapsedParents` | Global UI state | `[]` | `AgentsSidebarPanel.tsx` | Collapsed parent groups in the agents sidebar. |
| `neverwrite.ai.runtime-catalog` | Global cache | `{}` | `chatStore.ts` | Cached runtime models, modes, and config option catalogs. |
| `neverwrite:debug-log-scopes` | Global developer preference | None | `runtimeLog.ts` | Enables scoped debug logging. |
| `neverwrite:perf-probe` | Global developer preference | `false` | `perfInstrumentation.ts` | Enables performance probe instrumentation. |
| `neverwrite:window-operational-state:<label>` | Per-window operational state | None | `sensitiveState.ts` | Temporary update-safety state listing dirty tabs, pending review sessions, active agent sessions, and child windows. |
| `neverwrite:detached-window:<label>` | Per-window state | None | `detachedWindows.ts` | Detached note window descriptor. |
| `neverwrite:window-tab-drop-zone:<label>` | Per-window UI state | None | `detachedWindows.ts` | Detached window tab drop-zone state. |
| `neverwrite:window-session:<label>` | Per-window state | None | `windowSession.ts` | Window session descriptor. |
| `neverwrite:window-session-snapshot` | Global window state | None | `windowSession.ts` | Snapshot used for window restore. |

## Web Clipper Settings

The browser extension stores its settings in `browser.storage.local`, not in the
desktop renderer's `safeStorage`.

| Storage key | Scope | Default | Contents |
| --- | --- | --- | --- |
| `clipperSettings` | Browser-extension global, with vault records inside | Default empty vault definition | Vault definitions, active vault index, selected-only mode, clipboard fallback mode, default template, recent tags, recent folders by vault id, templates, and local clip history. |
| `clipperDesktopAuth` | Browser-extension global secret | None | Extension-side desktop pairing token. |

`clipperSettings.vaults` contains per-vault-ish records by extension vault id:
`id`, `name`, `path`, `defaultFolder`, and `folderHints`. Templates can also be
scoped by `vaultId` and `domain`. `recentFoldersByVault` is keyed by extension
vault id.

## Migration And Compatibility Notes

- `settingsStore` migrates legacy global settings into the current vault's
  `neverwrite:settings:<vault-path>` entry the first time that vault opens.
- `editorSpellcheck` is intentionally reset to its default during that migration
  instead of blindly copying a legacy global value.
- `spellcheckPrimaryLanguage` and `spellcheckSecondaryLanguage` are migrated
  from the older `spellcheckLanguage` field when present.
- Vim settings are migrated in the opposite direction: if a vault entry has Vim
  values and the global key does not, those values are written to
  `neverwrite:settings`.
- `themeStore` migrates `neverwrite:theme` into
  `neverwrite:theme:<vault-path>` if the vault-specific key does not exist.
- AI auto-context still reads legacy `neverwrite.ai.preferences.autoContextEnabled`
  as a fallback, but new writes go to `neverwrite.ai.auto-context:<vault-path>`
  or `neverwrite.ai.auto-context:__global__`.
- Removing a vault from recent vaults also removes its vault-scoped settings,
  theme, editor tabs, chat tabs, and bookmarks.

## Derived State And Caches

The following values should not be treated as user-configurable settings even
when they are persisted or visible in Settings:

- `isDark`, which is derived from theme mode and OS color-scheme preference.
- Update status, current version, channel, endpoint, and available update
  metadata, which come from updater APIs.
- Spellcheck catalog availability and installed dictionary metadata.
- AI runtime discovery status, installed CLI status, and live authentication
  status.
- Terminal replay snapshots and graph layout snapshots.
- Review anchors, resolved hunk positions, and transient review synchronization
  state.

Last updated: June 1, 2026.
