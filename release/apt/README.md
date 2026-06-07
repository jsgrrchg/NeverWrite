# NeverWrite APT Repository

NeverWrite publishes a signed third-party APT repository for Ubuntu/Debian
packages through the latest GitHub Release:

```text
https://github.com/jsgrrchg/NeverWrite/releases/latest/download
```

This repository is separate from the Electron updater feeds. AppImage builds use
the in-app updater; Debian packages update through `apt` when this repository is
configured.

## User Install

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://jsgrrchg.github.io/NeverWrite/apt/neverwrite-archive-keyring.asc \
  | sudo tee /etc/apt/keyrings/neverwrite.asc >/dev/null
sudo chmod 0644 /etc/apt/keyrings/neverwrite.asc
sudo tee /etc/apt/sources.list.d/neverwrite.sources >/dev/null <<'EOF'
Types: deb
URIs: https://github.com/jsgrrchg/NeverWrite/releases/latest/download
Suites: ./
Architectures: amd64 arm64
Signed-By: /etc/apt/keyrings/neverwrite.asc
EOF
sudo apt update
sudo apt install neverwrite
```

Users who install a `.deb` directly from GitHub Releases can move to APT by
adding the repository above. Future upgrades then come from:

```bash
sudo apt update
sudo apt upgrade
```

Do not use `apt-key`; the source is scoped to
`/etc/apt/keyrings/neverwrite.asc`.

## Published Layout

The release workflow uploads the repository metadata as GitHub Release assets:

```text
InRelease
Release
Release.gpg
Packages
Packages.gz
NeverWrite-0.3.3-amd64.deb
NeverWrite-0.3.3-arm64.deb
```

The `.deb` binary packages stay on GitHub Releases with the other release
assets. The `Filename` field in each `Packages` stanza is the release asset file
name, for example `NeverWrite-0.3.3-amd64.deb`. APT resolves it relative to the
configured `latest/download` release URL.

GitHub Pages only publishes the install helper files:

```text
apt/
  neverwrite-archive-keyring.asc
  neverwrite.sources.example
```

The workflow reads the `.deb` metadata from the staged release assets,
generates flat `Packages` and `Release` metadata, signs the repository,
validates checksums and signatures, uploads the metadata to the GitHub Release,
then publishes the source example with the existing Electron feeds.

## Required GitHub Secrets

The release workflow requires a dedicated signing key for the APT repository:

- `APT_REPO_GPG_PRIVATE_KEY`: ASCII-armored private key.
- `APT_REPO_GPG_PASSPHRASE`: passphrase for the private key.
- `APT_REPO_GPG_KEY_ID`: full fingerprint or long key id used for signing.

Generate a dedicated signing key, not a personal commit/tag signing key:

```bash
gpg --batch --quick-generate-key "NeverWrite APT Repository <jsgrrchg@users.noreply.github.com>" ed25519 sign 2y
gpg --list-secret-keys --keyid-format LONG "NeverWrite APT Repository"
gpg --armor --export <FINGERPRINT> > neverwrite-archive-keyring.asc
gpg --armor --export-secret-keys <FINGERPRINT> > neverwrite-apt-private-key.asc
```

Only the public key is published. The private key must live in GitHub Actions
secrets or a secure vault.

## Validation

The release workflow runs:

```bash
node scripts/build-apt-repository.mjs ...
node scripts/sign-apt-repository.mjs ...
node scripts/validate-apt-repository.mjs ...
```

Manual post-release checks:

```bash
curl -fsSL https://github.com/jsgrrchg/NeverWrite/releases/latest/download/InRelease | head
curl -fsSL https://github.com/jsgrrchg/NeverWrite/releases/latest/download/Packages.gz \
  | gunzip \
  | grep -E '^(Package|Version|Architecture|Filename):'
apt-cache policy neverwrite
```

## Rollback

Rollback is done by regenerating and re-uploading repository metadata so APT no
longer advertises the bad version. Do not delete release assets first. Rebuild
`Packages` and `Release`, sign again, upload the metadata to the relevant
GitHub Release, and update the source example if the public endpoint changes.
