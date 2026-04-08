# Spellcheck Architecture

NeverWrite now uses a single app-owned spellcheck system.

## Overview

- Rust owns dictionaries, language resolution, suggestions, personal dictionary mutations, and session ignore state.
- The frontend talks to Rust only through `features/spellcheck/api.ts` and `features/spellcheck/store.ts`.
- CodeMirror renders spellcheck decorations for the note body with the extension in `features/editor/extensions/spellcheck.ts`.
- The note title and the note body share the same suggestion menu builder in `features/spellcheck/contextMenu.ts`.

## Current Behavior

- Body spellcheck is fully app-owned.
- Title suggestions are app-owned and use the same backend/store/menu flow as the body.
- Native browser/WebView spellcheck is not used as the primary spellcheck engine.
- User dictionary is global per app and stored under the app spellcheck runtime directory.
- Rust uses `spellbook` as the Hunspell-compatible engine.
- `en-US` and `es-ES` are bundled with real Hunspell dictionaries.
- Additional dictionaries can be discovered from the runtime `spellcheck/packs` directory.

## Main Files

- `apps/desktop/src-tauri/src/spellcheck/mod.rs`
- `apps/desktop/src-tauri/src/spellcheck/language.rs`
- `apps/desktop/src-tauri/src/spellcheck/storage.rs`
- `apps/desktop/src/features/spellcheck/api.ts`
- `apps/desktop/src/features/spellcheck/store.ts`
- `apps/desktop/src/features/spellcheck/contextMenu.ts`
- `apps/desktop/src/features/editor/extensions/spellcheck.ts`
- `apps/desktop/src/features/editor/Editor.tsx`

## Rules

- Do not add new spellcheck behavior through native WebView spellcheck menus or DOM `spellcheck=true` as the feature base.
- New spellcheck UI should go through the shared store and Rust commands.
- New editable surfaces should reuse the shared context menu payload/actions where possible.
