## VaultAI app icons

- `sources/VaultAI-macos26.icon` is the macOS 26 Icon Composer source.
- `sources/VaultAI-symbol-1024.png` is the original symbol extracted from that package.
- `sources/VaultAI-macos15-1024.png` is the legacy 1024x1024 render used to generate the current Tauri bundle icons for macOS 15, Windows, and other classic targets.

Regenerate the Tauri icons with:

```bash
cd apps/desktop
npm exec -- tauri icon ./src-tauri/icons/sources/VaultAI-macos15-1024.png --output ./src-tauri/icons
```

Tauri currently bundles the generated classic assets (`icon.icns`, `icon.ico`, PNG sizes). The `.icon` source is kept in the repo so the macOS 26 version stays aligned with the legacy exports.
