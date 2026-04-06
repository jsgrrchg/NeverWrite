# Appcast Layout

This directory documents the static appcast shape for VaultAI.

## Public topology

The appcast is published from the `gh-pages` branch and served through GitHub Pages.

Public base URL:

- `https://<owner>.github.io/<repo>`

Stable channel URL:

- `https://<owner>.github.io/<repo>/stable/latest.json`

Future channels keep the same shape:

- `beta/latest.json`
- `nightly/latest.json`

Branch layout on `gh-pages`:

```text
gh-pages/
  stable/latest.json
  beta/latest.json
  nightly/latest.json
```

The file generated in CI should keep that same relative layout. The recommended local output path is:

```text
dist/appcast/<channel>/latest.json
```

## Separation of concerns

- `GitHub Pages` serves the stable channel URL and is the only endpoint the app consumes.
- `GitHub Releases` stores the actual downloadable release assets.
- `latest.json` only points to the real assets in `GitHub Releases`.

This keeps the client decoupled from release asset listing and `releases/latest/download` conventions.

## Mapping

| Build target | Appcast key | Public manual asset | Updater artifact family |
| --- | --- | --- | --- |
| `aarch64-apple-darwin` | `darwin-aarch64` | `VaultAI_<version>_macOS_AppleSilicon.dmg` | macOS updater archive (`.app.tar.gz`) |
| `x86_64-apple-darwin` | `darwin-x86_64` | `VaultAI_<version>_macOS_Intel.dmg` | macOS updater archive (`.app.tar.gz`) |
| `aarch64-pc-windows-msvc` | `windows-aarch64` | `VaultAI_<version>_Windows_ARM64_Setup.exe` | Windows updater archive (`.nsis.zip`) |
| `x86_64-pc-windows-msvc` | `windows-x86_64` | `VaultAI_<version>_Windows_x64_Setup.exe` | Windows updater archive (`.nsis.zip`) |

## Signed updater artifact convention

- Manual installer assets keep the human-facing names above.
- Updater archives keep the native Tauri updater archive for that target.
- The signature asset name is always the updater archive name plus `.sig`.
- `latest.json` must embed the signature file content, not a signature URL.

Examples:

- `VaultAI.app.tar.gz` -> `VaultAI.app.tar.gz.sig`
- `VaultAI-setup.nsis.zip` -> `VaultAI-setup.nsis.zip.sig`

## Manual Installation

The public/manual installer set for v1 is intentionally small:

- macOS:
  - `VaultAI_<version>_macOS_AppleSilicon.dmg`
  - `VaultAI_<version>_macOS_Intel.dmg`
- Windows:
  - `VaultAI_<version>_Windows_ARM64_Setup.exe`
  - `VaultAI_<version>_Windows_x64_Setup.exe`

`MSI` is explicitly out of scope for v1.

Release page rule:

- the release body must tell humans to download the `DMG` or `Setup.exe`
- updater archives (`.app.tar.gz`, `.nsis.zip`) and `.sig` files are attached for the updater pipeline, but are not part of the manual install story

## Static `latest.json` shape

```json
{
  "version": "0.2.0",
  "notes": "## Added\n\n- Multi-target release",
  "pub_date": "2026-04-04T18:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/<asset>",
      "signature": "<signature contents>"
    },
    "darwin-x86_64": {
      "url": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/<asset>",
      "signature": "<signature contents>"
    },
    "windows-aarch64": {
      "url": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/<asset>",
      "signature": "<signature contents>"
    },
    "windows-x86_64": {
      "url": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/<asset>",
      "signature": "<signature contents>"
    }
  }
}
```

## Manifest generation

Generate a channel manifest from `CHANGELOG.md` plus a platform map:

```bash
node scripts/build-appcast-manifest.mjs \
  --version v0.2.0 \
  --channel stable \
  --pub-date 2026-04-04T18:00:00Z \
  --platforms-file ./tmp/platforms.json \
  --public-base-url https://<owner>.github.io/<repo>
```

The `platforms.json` input can be keyed by either:

- Rust build target, for example `aarch64-apple-darwin`
- appcast key, for example `darwin-aarch64`

Each entry must include:

- `url`
- `signature`

Validation:

```bash
node scripts/validate-appcast-manifest.mjs dist/appcast/stable/latest.json
```

## Release Workflow

The multi-target release workflow lives at:

- `.github/workflows/release-desktop.yml`

High-level flow:

1. Validate release metadata and extract notes from `CHANGELOG.md`
2. Create or update the GitHub release for the manually selected `vX.Y.Z` tag
3. Build four desktop targets
4. Upload manual assets plus updater archives/signatures to `GitHub Releases`
5. Merge target metadata into `stable/latest.json`
6. Commit the generated appcast to the `gh-pages` branch

Maintainer control:

- The workflow is triggered manually from GitHub Actions with `workflow_dispatch`.
- The requested tag must already exist in the repository before the workflow runs.
- This keeps public release automation visible without allowing every pushed tag to publish automatically.

Required repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Optional macOS signing/notarization secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Operational note:

- GitHub Pages must be configured to publish from the `gh-pages` branch root for the workflow output to be publicly reachable.
- A public repository can keep this workflow enabled safely; missing secrets will fail the release job, but do not expose secret values.

## Security Guardrails

The updater is intentionally strict at runtime:

- A public key must be configured or the updater stays disabled.
- Tauri verifies the updater artifact signature before install using that public key.
- The feed endpoint must be a clean `latest.json` URL:
  - no query string
  - no fragment
  - no embedded credentials
- Production-like feeds must use `https`.
- Production default only permits:
  - feed hosts under `*.github.io`
  - download URLs on `github.com`

Optional runtime overrides:

- `VAULTAI_UPDATER_ALLOWED_FEED_HOSTS`
  - comma-separated allowlist to pin the feed host explicitly
  - example: `vaultai.github.io`
- `VAULTAI_UPDATER_ALLOWED_DOWNLOAD_HOSTS`
  - comma-separated allowlist for updater asset URLs
  - example: `github.com`
- `VAULTAI_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD=true`
  - allows a local/dev build to hit a production-like feed for an explicit one-off validation
  - do not leave this enabled in normal development

## Local and Dev Rule

Local and dev builds must not point to the production appcast by default.

Accepted non-production feed shapes:

- `file:///.../stable/latest.json`
- `http://127.0.0.1:<port>/stable/latest.json`
- `http://localhost:<port>/stable/latest.json`

Recommended local example:

```bash
export VAULTAI_UPDATER_ENDPOINT="http://127.0.0.1:8787/stable/latest.json"
export VAULTAI_UPDATER_PUBLIC_KEY="<staging-or-local-public-key>"
```

If a developer needs to validate the real public feed from a non-production build, they must opt in explicitly:

```bash
export VAULTAI_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD=true
```

That override is for short-lived manual validation only.

## Key Rotation Runbook

Use this when the signing key is scheduled for rotation or suspected compromised.

1. Generate a new updater signing keypair.
2. Store the new private key and password in GitHub Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. Roll out the matching public key to the app runtime configuration:
   - `VAULTAI_UPDATER_PUBLIC_KEY` or `TAURI_UPDATER_PUBLIC_KEY`
4. Publish a new release signed with the new private key.
5. Keep the old key out of future releases.
6. If compromise is suspected, treat all still-unpublished artifacts signed with the old key as invalid.

Important v1 constraint:

- clients can only verify updates signed by the public key they already trust
- do not rotate the production public key silently without coordinating a client rollout path first

## Defective Release Response

Rollback v1 is operational, not automatic downgrade.

When a release is defective:

1. Update `gh-pages/<channel>/latest.json` so the feed points to the last known-good release, or to a newer hotfix if already available.
2. If the defective release has already been consumed, publish a hotfix with a higher version.
3. Edit the GitHub release body to mark the defective release as bad for manual installers.
4. If the signing key is involved, perform the key rotation runbook above.

Revocation note:

- removing a GitHub Release asset alone is not enough
- the critical action is to stop advertising the defective version from the appcast feed

## Platform Validation Pack

The release workflow now produces a platform validation artifact for each tag:

- artifact name: `platform-validation-pack-<tag>`

Pack contents:

- `validation-matrix.json`
- `checklist.md`
- `fixtures/valid/<channel>/latest.json`
- `fixtures/<appcast-key>/invalid-signature/<channel>/latest.json`

Build it locally from release target metadata plus the generated appcast:

```bash
node scripts/build-platform-validation-pack.mjs \
  --version 0.2.0 \
  --tag v0.2.0 \
  --channel stable \
  --appcast dist/appcast/stable/latest.json \
  --metadata-dir .artifacts/release-targets \
  --pages-base-url https://<owner>.github.io/<repo> \
  --output-dir dist/platform-validation/v0.2.0
```

Serve the fixtures on loopback for local validation:

```bash
node scripts/serve-static-directory.mjs \
  --dir dist/platform-validation/v0.2.0/fixtures \
  --host 127.0.0.1 \
  --port 8787
```

Then point the app to the local validation feed:

```bash
export VAULTAI_UPDATER_ENDPOINT="http://127.0.0.1:8787/valid/stable/latest.json"
export VAULTAI_UPDATER_PUBLIC_KEY="<public-key-for-the-artifacts-under-test>"
export VAULTAI_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD=true
```

That override is required for local validation packs because the loopback feed still points to the signed updater assets hosted on GitHub Releases.

To validate the invalid-signature path for a specific target, switch the endpoint to that target fixture. Example for `windows-x86_64`:

```bash
export VAULTAI_UPDATER_ENDPOINT="http://127.0.0.1:8787/windows-x86_64/invalid-signature/stable/latest.json"
```

Expected use:

1. Install the previous version or start from a clean machine for the target under test.
2. Use the `valid` fixture to confirm detection, correct target routing, and successful restart.
3. Use the target-specific `invalid-signature` fixture to confirm installation is blocked.
4. Repeat once with sensitive in-app state present to confirm the inline confirmation gate.

The generated `checklist.md` is the canonical matrix to record each target run.
