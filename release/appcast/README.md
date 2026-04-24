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
| `universal-apple-darwin` | `darwin-universal` | `latest-mac.yml` |
| `aarch64-pc-windows-msvc` | `windows-arm64` | `latest.yml` |
| `x86_64-pc-windows-msvc` | `windows-x64` | `latest.yml` |

Example published URLs:

```text
https://jsgrrchg.github.io/NeverWrite/stable/darwin-universal/latest-mac.yml
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
| `universal-apple-darwin` | `NeverWrite_<version>_macOS_Universal.dmg` | `NeverWrite_<version>_macOS_Universal.zip` |
| `aarch64-pc-windows-msvc` | `NeverWrite_<version>_Windows_ARM64_Setup.exe` | `NeverWrite_<version>_Windows_ARM64_Setup.exe` |
| `x86_64-pc-windows-msvc` | `NeverWrite_<version>_Windows_x64_Setup.exe` | `NeverWrite_<version>_Windows_x64_Setup.exe` |

The architecture suffix is mandatory for Windows. macOS publishes a universal package and a single universal updater feed. We do not publish shared Windows `latest.yml` metadata for multiple architectures in the same directory because `electron-builder` would otherwise collide on Windows metadata names.

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

Windows releases are distributed unsigned for now. The release workflow disables
certificate auto-discovery for Windows builds and does not require `WIN_CSC_*`,
Azure Trusted Signing, or other Windows signing secrets.

Unsigned Windows installers can trigger SmartScreen or Defender warnings until a
future signed distribution path builds reputation.

## Workflow

The production release entrypoint is:

- `.github/workflows/release-desktop.yml`

High-level flow:

1. validate version identity and changelog
2. build one target per matrix entry
3. smoke the packaged native sidecar
4. stage release assets and target metadata as internal workflow artifacts
5. publish all release files to `GitHub Releases` after every target succeeds
6. publish feeds to `gh-pages`
7. generate a platform validation pack

## Local build commands

From `apps/desktop`:

```bash
npm run electron:build
npm run electron:package:unsigned
npm run electron:dist:mac
npm run electron:dist:win -- --arch x64
npm run electron:dist:win -- --arch arm64
```

The release wrapper is target-aware and stages the correct Rust sidecar for the selected architecture before calling `electron-builder`. For universal macOS builds, CI downloads both Node runtimes and stages a lipo'd embedded Node binary via `NEVERWRITE_EMBEDDED_NODE_BIN_ARM64` and `NEVERWRITE_EMBEDDED_NODE_BIN_X64`.

## Local updater validation

The runtime updater is intentionally strict:

- packaged builds only allow production `https` feeds by default
- non-packaged builds only allow loopback or `file:` feeds by default
- feed hosts and download hosts can be allowlisted explicitly
- production downloads default to `github.com`

Runtime knobs:

- Packaged builds default to `https://jsgrrchg.github.io/NeverWrite`.
- The env vars below are overrides for local validation, staging feeds, or one-off diagnostics.
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
