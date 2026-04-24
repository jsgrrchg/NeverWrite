# Electron Release Feeds

This directory documents the Electron release topology for NeverWrite.

Electron now owns the signed desktop release path:

- manual installers live in `GitHub Releases`
- updater metadata lives in `gh-pages`
- updater downloads still resolve to `GitHub Releases`

## Published layout

GitHub Pages publishes one feed per channel, platform, and architecture:

```text
<channel>/<feed-target>/latest-mac.yml
<channel>/<feed-target>/latest.yml
```

Current feed targets:

| Build target | Feed target | Metadata file |
| --- | --- | --- |
| `aarch64-apple-darwin` | `darwin-arm64` | `latest-mac.yml` |
| `x86_64-apple-darwin` | `darwin-x64` | `latest-mac.yml` |
| `aarch64-pc-windows-msvc` | `windows-arm64` | `latest.yml` |
| `x86_64-pc-windows-msvc` | `windows-x64` | `latest.yml` |

Example published URLs:

```text
https://jsgrrchg.github.io/NeverWrite/stable/darwin-arm64/latest-mac.yml
https://jsgrrchg.github.io/NeverWrite/stable/windows-x64/latest.yml
```

The updater metadata always points back to versioned assets on `GitHub Releases`.

## Release assets

Each build target uploads:

- one manual installer for humans
- one updater asset for `electron-updater`
- one blockmap for differential updates

Public naming remains stable per target:

| Build target | Manual asset | Updater asset |
| --- | --- | --- |
| `aarch64-apple-darwin` | `NeverWrite_<version>_macOS_AppleSilicon.dmg` | `NeverWrite_<version>_macOS_AppleSilicon.zip` |
| `x86_64-apple-darwin` | `NeverWrite_<version>_macOS_Intel.dmg` | `NeverWrite_<version>_macOS_Intel.zip` |
| `aarch64-pc-windows-msvc` | `NeverWrite_<version>_Windows_ARM64_Setup.exe` | `NeverWrite_<version>_Windows_ARM64_Setup.exe` |
| `x86_64-pc-windows-msvc` | `NeverWrite_<version>_Windows_x64_Setup.exe` | `NeverWrite_<version>_Windows_x64_Setup.exe` |

The architecture suffix is mandatory. We do not publish shared `latest.yml` / `latest-mac.yml` metadata for multiple architectures in the same directory because `electron-builder` would otherwise collide on macOS and Windows metadata names.

## Signing and notarization

### macOS

The release workflow supports either notarization mode accepted by `electron-builder`:

1. App Store Connect API key
   - `APPLE_API_KEY`
   - `APPLE_API_KEY_ID`
   - `APPLE_API_ISSUER`
2. Apple ID + app-specific password
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`

macOS code signing also requires:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`

### Windows

Windows signing supports either:

1. PFX-based signing
   - `WIN_CSC_LINK`
   - `WIN_CSC_KEY_PASSWORD`
2. Azure Trusted Signing
   - `NEVERWRITE_WINDOWS_AZURE_SIGN_ENDPOINT`
   - `NEVERWRITE_WINDOWS_AZURE_SIGN_ACCOUNT`
   - `NEVERWRITE_WINDOWS_AZURE_SIGN_CERTIFICATE_PROFILE`
   - `NEVERWRITE_WINDOWS_AZURE_SIGN_PUBLISHER`
   - plus the standard Azure authentication environment required by `electron-builder`

## Workflow

The production release entrypoint is:

- `.github/workflows/release-desktop.yml`

High-level flow:

1. validate version identity and changelog
2. build one signed target per matrix entry
3. smoke the packaged native sidecar
4. stage release assets and target metadata
5. upload release files to `GitHub Releases`
6. publish feeds to `gh-pages`
7. generate a platform validation pack

## Local build commands

From `apps/desktop`:

```bash
npm run electron:build
npm run electron:package:unsigned
npm run electron:dist:mac -- --arch arm64
npm run electron:dist:mac -- --arch x64
npm run electron:dist:win -- --arch x64
```

The release wrapper is target-aware and stages the correct Rust sidecar for the selected architecture before calling `electron-builder`.

## Local updater validation

The runtime updater is intentionally strict:

- packaged builds only allow production `https` feeds by default
- non-packaged builds only allow loopback or `file:` feeds by default
- feed hosts and download hosts can be allowlisted explicitly
- production downloads default to `github.com`

Runtime knobs:

- `NEVERWRITE_UPDATER_BASE_URL`
- `NEVERWRITE_UPDATER_ENDPOINT`
- `NEVERWRITE_UPDATER_CHANNEL`
- `NEVERWRITE_UPDATER_ALLOWED_FEED_HOSTS`
- `NEVERWRITE_UPDATER_ALLOWED_DOWNLOAD_HOSTS`
- `NEVERWRITE_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD`

Validation pack generation:

```bash
node scripts/build-platform-validation-pack.mjs \
  --version 0.2.0 \
  --tag v0.2.0 \
  --channel stable \
  --feeds-dir .artifacts/feeds \
  --metadata-dir .artifacts/release-targets \
  --output-dir dist/platform-validation/v0.2.0
```

The validation pack includes:

- target-specific valid feeds
- target-specific invalid-checksum fixtures
- a checklist for clean install, update, target routing, and sensitive-state confirmation

## Rollback

Rollback means publishing feed metadata that no longer points to the defective version.

Because the updater reads target-specific feeds, rollback can be:

- global for every target in a channel, or
- scoped to one target if only one architecture is affected

Do not delete release assets as the first reaction. First stop advertising the bad version from the published feed for the affected targets.
