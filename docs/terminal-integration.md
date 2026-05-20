# Terminal: First-Class Integration Plan

Related issue: [jsgrrchg/NeverWrite#107](https://github.com/jsgrrchg/NeverWrite/issues/107)

## Background

The terminal currently works but sits behind a double gate: `developerModeEnabled` must be on, then `developerTerminalEnabled` inside it. Both flags live in the Developer section of Settings.

**The PTY backend is a Rust sidecar** (`apps/desktop/native-backend/src/devtools.rs`) using `portable-pty`, spawned and managed by `nativeBackend.ts` over JSON-line stdio. There is no node-pty. This matters for Step 6: any change to env vars or spawn options crosses a language boundary and requires the sidecar binary to be rebuilt and repackaged. `TERM=xterm-256color` is already set at `devtools.rs:345`. `COLORTERM=truecolor` is not.

The IPC struct is `DevTerminalCreateInput` (Rust, `devtools.rs:55`), currently with only `cwd`, `cols`, `rows`. Adding env var passthrough requires extending this struct in Rust and the corresponding TypeScript call sites.

The rendering layer (xterm.js v6 in `TerminalViewport.tsx`) is sound but has three gaps: font is hardcoded, the ANSI color palette is only partially wired to theme tokens, and `COLORTERM` is missing from the PTY environment.

There is no viable drop-in replacement for xterm.js today. The most promising future alternative — libghostty-vt (Ghostty's VT parser as a C/WASM library) — is alpha with no usable web bindings yet. We stay on xterm.js and improve the integration.

## Goals

1. Terminal is a first-class workspace feature, usable without enabling Developer Mode.
2. Font family and font size are user-configurable in Settings.
3. The terminal looks like it belongs in the app — full ANSI palette from theme tokens.
4. Claude Code runs correctly inside the terminal without user-side workarounds.
5. Terminal code lives in a coherent location, not split across `features/terminal/` and `features/devtools/terminal/`.

## Non-goals

- PTY architecture changes (utilityProcess migration, flow control). The sidecar approach is fine.
- Bundling fonts. Users provide their own.
- Enumerating system fonts in the UI. No clean cross-platform API without native modules.
- xterm.js WebGL renderer upgrade. Separate concern, not blocking.

---

## Step 1 — Ungate the terminal

**Files:** `src/App.tsx:921-943`, `src/features/editor/newTabMenuActions.ts:85-147`, `src/features/editor/EditorPaneBar.tsx`

Remove the `developerModeEnabled` guard from the `developer:new-terminal-tab` command palette entry (`App.tsx:939`). Remove the `developerTerminalEnabled` check from `buildNewTabContextMenuEntries` (`newTabMenuActions.ts:138`) so "New Terminal" appears in every pane's `+` menu unconditionally.

Note: `developerTerminalEnabled` already defaults to `true` (`settingsStore.ts:175`). No default flip needed — only the `developerModeEnabled` outer gate has to drop.

Leave both toggles in the Developer settings section for users who want to hide the feature.

The `developer:restart-terminal` command stays behind `developerModeEnabled`. But once terminal creation is ungated, restart becomes a usability need for ordinary users too. Add a right-click context menu entry on the terminal tab itself (already partially exists in `EditorPaneBar.tsx` tab context menu) so non-developer users have a recovery path that doesn't require dev mode.

**Also do:**
- Change the command id from `developer:new-terminal-tab` to `workspace:new-terminal-tab` and the category from `"Developer"` to `"Workspace"` (or `"Tabs"`) — cosmetics, but "first-class" means it shows up in the right palette group.
- Assign a keyboard shortcut. Check for collisions in the existing shortcut registry.

**Do this step last** — only ungate once the full experience (Steps 2–7) is ready.

---

## Step 2 — Add terminal settings to the store

**File:** `src/app/store/settingsStore.ts`

Add to the settings interface and default object:

```ts
terminalFontFamily: string   // default: ""
terminalFontSize: number     // default: 13
claudeCodeOptimized: boolean // default: false
```

The existing persistence merge pattern at `settingsStore.ts:388-393` handles new fields via `?? defaults.X` — follow the same pattern. Empty `terminalFontFamily` means "use the built-in fallback stack" everywhere it's read; never pass an empty string to xterm.js.

---

## Step 3 — Expose settings in a Terminal section

**File:** `src/features/settings/SettingsPanel.tsx`

`Category` is a tagged union (`SettingsPanel.tsx:3570-3580`) with a matching `CATEGORIES` array and a render switch (~`4497+`). Adding "Terminal" means:

1. Extend the union with `"terminal"`.
2. Add an entry to `CATEGORIES` (needs an icon — pick from the existing icon set).
3. Create a `<TerminalSettings>` component.
4. Add `case "terminal"` in the render switch.

Section contents:
- **Font family** — text input. Placeholder: `"JetBrainsMono Nerd Font"`. Hint: "Font must be installed on this system."
- **Font size** — number input, range 8–24. Check whether a number input control already exists in the settings component library before building a new one.
- **Optimize for Claude Code** — toggle. Label: "Fullscreen rendering (experimental)". Hint: "Sets CLAUDE_CODE_NO_FLICKER=1. Improves rendering but disables scrollback. Only applies to new terminals." Wired to `claudeCodeOptimized`.

The Developer section keeps `developerTerminalEnabled` and `developerModeEnabled`. Consider whether `developerTerminalEnabled` should be renamed `terminalEnabled` now that the terminal is first-class — if so, add a migration in the persistence merge.

---

## Step 4 — Font loading in TerminalViewport

**Files:** `src/features/devtools/terminal/terminalTheme.ts`, `src/features/devtools/terminal/TerminalViewport.tsx`

### terminalTheme.ts

`getTerminalTheme` currently returns a hardcoded font stack. Accept settings values:

```ts
export function getTerminalTheme(
  element: HTMLElement | null,
  opts?: { fontFamily?: string; fontSize?: number }
): TerminalTheme {
  const fallback = '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';
  return {
    // ...
    fontFamily: opts?.fontFamily?.trim() || fallback,
    fontSize: opts?.fontSize ?? 13,
  };
}
```

### TerminalViewport.tsx

Before calling `terminal.open(containerEl)`, load the font if one is configured:

```ts
const { terminalFontFamily, terminalFontSize } = useSettingsStore.getState();
const fontFamily = terminalFontFamily.trim();

if (fontFamily) {
  try {
    await Promise.all([
      document.fonts.load(`normal ${terminalFontSize}px "${fontFamily}"`),
      document.fonts.load(`bold ${terminalFontSize}px "${fontFamily}"`),
    ]);
    // document.fonts.load() resolves even when the font is absent.
    // Check that it actually loaded before trusting it.
    if (!document.fonts.check(`normal ${terminalFontSize}px "${fontFamily}"`)) {
      console.warn(`[terminal] Font "${fontFamily}" not found, using fallback`);
      // fontFamily falls back to empty → getTerminalTheme uses fallback stack
    }
  } catch {
    console.warn(`[terminal] Font load failed for "${fontFamily}", using fallback`);
  }
}

terminal.open(containerEl);
fitAddon.fit();
```

The existing `useEffect` at `TerminalViewport.tsx:354-367` that updates `terminal.options.fontFamily` / `fontSize` on settings changes needs `fitAddon.fit()` appended — font changes alter cell metrics and the viewport must reflow. Also update the dep array to include the new settings fields.

---

## Step 5 — Wire up the full ANSI palette

**File:** `src/features/devtools/terminal/terminalTheme.ts`

xterm.js v6 `ITheme` accepts all 16 ANSI colors (normal + bright), cursor, selection, and scrollbar. Currently `getTerminalTheme` maps only `--bg-primary`, `--text-primary`, `--accent`, a selection color hardcoded to `rgba(120, 138, 158, 0.28)` (`TerminalViewport.tsx:43`), and nothing else.

**Audit first:** read the existing CSS custom properties in `src/index.css` and the theme definitions to find what color tokens exist. If ANSI-specific tokens exist (e.g. `--ansi-red`, `--syntax-string`), map to them. If not, define a fixed palette per theme variant (light/dark) that draws from the existing semantic tokens — don't attempt to compute 16 colors from 3.

**At minimum, set:**
- `black` / `brightBlack` — from `--bg-secondary` / `--text-secondary` or equivalent
- `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` and their bright variants — from syntax/status color tokens if present
- `cursor` — `--accent`
- `selectionBackground` — replace the hardcoded rgba with a token or derived value
- `scrollbarSliderBackground` / `scrollbarSliderHoverBackground` / `scrollbarSliderActiveBackground`

**Reactivity:** the dep array on the terminal options effect (`TerminalViewport.tsx:360-367`) currently watches only background/cursor/font/text. Adding 16 colors means updating that dep array. CSS vars read via `getComputedStyle` aren't reactive — they only re-read when the React render runs. Verify theme switching actually triggers a re-render (the `useThemeStore` subscription at `TerminalViewport.tsx:104` should handle this, but test it).

---

## Step 6a — Rust: extend the PTY spawn input

**File:** `apps/desktop/native-backend/src/devtools.rs`

Extend `DevTerminalCreateInput` to accept additional environment variables:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevTerminalCreateInput {
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(default)]
    extra_env: HashMap<String, String>,
}
```

`#[serde(default)]` makes it backwards-compatible — existing callers that don't send `extraEnv` get an empty map, no IPC break.

In `spawn_session`, after the existing `command.env("TERM", "xterm-256color")`, add:

```rust
command.env("COLORTERM", "truecolor");
for (key, value) in &input.extra_env {
    command.env(key, value);
}
```

**Sidecar rebuild:** this requires rebuilding the native backend binary. Update CI to run the Rust build step and ensure the rebuilt binary is included in the package. On macOS, verify code signing still applies to the new binary.

## Step 6b — TypeScript: thread extra_env through and add the Claude Code toggle

**Files:** `src/features/terminal/terminalRuntimeStore.ts`, `src/features/devtools/terminal/useTerminalTabs.ts`

Update the `devtools_create_terminal_session` call sites to pass `extraEnv` when `claudeCodeOptimized` is set in settings:

```ts
const { claudeCodeOptimized } = useSettingsStore.getState();
const extraEnv = claudeCodeOptimized ? { CLAUDE_CODE_NO_FLICKER: "1" } : {};

await invoke("devtools_create_terminal_session", { cwd, cols, rows, extraEnv });
```

`CLAUDE_CODE_NO_FLICKER=1` applies only at session creation. Document this in the Settings UI hint: the toggle only affects newly opened terminals.

---

## Step 7 — Consolidate terminal code

**This is a refactor, not a pure rename.** Two directories exist and already cross-import each other:

- `src/features/terminal/` — `WorkspaceTerminalHost`, `WorkspaceTerminalView`, `terminalRuntimeStore`, `legacyTerminalMigration` (plus tests)
- `src/features/devtools/terminal/` — `TerminalViewport`, `terminalTypes`, `terminalTheme`, `useTerminalTabs`, `terminalSessionTracking` (plus tests)

**Move** the `devtools/terminal/` files into `src/features/terminal/`. Update all imports — including files not in the terminal directories:

- `src/App.tsx`
- `src/features/editor/EditorPaneBar.tsx`
- `src/features/ai/components/AIAuthTerminalModal.tsx` ← easy to miss; imports `terminalTypes`
- Any test files referencing the old paths

**CSS:** `.devtools-terminal-surface` at `src/index.css:607` is referenced by `TerminalViewport.tsx:559`. Decide: rename the CSS class to `.terminal-surface` (update both files) or leave it as-is. If renaming, do it in this commit.

**Event names:** `devtools://terminal-output`, `devtools://terminal-started`, etc. are constants defined in Rust and matched in TypeScript. Leave them as-is — the `devtools://` prefix is in the IPC protocol, not the file path. Document this decision so future readers don't wonder.

**Dead code:** `useTerminalTabs.ts` is only called by `legacyTerminalMigration.ts` for `readPersistedTerminalWorkspace`. Audit whether other exports are still used before moving; delete unused ones rather than dragging them forward.

**Do this as a standalone commit** with zero logic changes so the diff is reviewable and bisectable.

---

## Step 8 — Update tests

Several test files assert the developer-gate behaviour and will break after Step 1:

- `src/App.noteWindow.test.tsx` — asserts terminal tab behaviour, references `openTerminal()`
- `src/features/terminal/WorkspaceTerminalHost.test.tsx`
- `src/features/terminal/terminalRuntimeStore.test.ts`
- `src/features/settings/SettingsPanel.test.tsx` — may enumerate categories
- `src/app/store/settingsStore.ts` — `settingsStore.test.ts` for new fields

Update assertions to reflect ungated behaviour and new settings fields. Add tests for font loading fallback path and `claudeCodeOptimized` env passthrough.

---

## Sequence

| Step | Scope | Dependency | Risk |
|---|---|---|---|
| 7 — consolidate | Refactor, imports | None | Low — no logic changes |
| 6a — Rust env passthrough | Rust + sidecar build | None | Medium — crosses language boundary, needs CI |
| 2 — settings fields | TS store only | None | Low |
| 5 — full ANSI palette | `terminalTheme.ts` | None | Low — visual only |
| 6b — TS Claude Code toggle | TS call sites | 6a, 2 | Low |
| 4 — font loading | `TerminalViewport.tsx` | 2 | Medium — async open() path |
| 3 — Settings UI | `SettingsPanel.tsx` | 2 | Low |
| 8 — tests | Test files | All above | Low |
| 1 — ungate | `App.tsx`, menus | All above | Low |

Steps 7, 6a, 2, and 5 have no dependencies on each other and can be done in parallel.

---

## Future / out of scope for this iteration

- **libghostty-vt** — Ghostty's VT parser as a standalone C/WASM library (alpha, Sept 2025). No web bindings yet. When it ships, it's the most accurate available parser; worth evaluating as a drop-in under xterm.js's rendering layer.
- **WebGL renderer** (`@xterm/addon-webgl`) — up to 9x faster than canvas under heavy output. Not loaded currently. Add after this work settles.
- **utilityProcess PTY isolation** — migrate the Rust sidecar invocation to use Electron's `utilityProcess` API so sidecar crashes can't bring down the main process. Not urgent for a single-window app.
- **`CLAUDE_CODE_NO_FLICKER=1` fullscreen rendering** — already exposed as a toggle in Step 3, but Anthropic still marks it experimental. Promote the toggle to non-experimental once Anthropic stabilises scrollback behaviour.
- **Keyboard shortcut for New Terminal** — decide on a shortcut and register it. Deferred to avoid shortcut collision analysis blocking the main work.
