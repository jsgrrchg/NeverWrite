# NeverWrite APT Repository

NeverWrite publishes a signed third-party APT repository for Ubuntu/Debian
packages at:

```text
https://jsgrrchg.github.io/NeverWrite/apt
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
URIs: https://jsgrrchg.github.io/NeverWrite/apt
Suites: stable
Components: main
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

The release workflow publishes these files to `gh-pages`:

```text
apt/
  neverwrite-archive-keyring.asc
  neverwrite.sources.example
  dists/
    stable/
      InRelease
      Release
      Release.gpg
      main/
        binary-amd64/
          Packages
          Packages.gz
        binary-arm64/
          Packages
          Packages.gz
  pool/
    main/
      n/
        neverwrite/
          neverwrite_<version>_amd64.deb
          neverwrite_<version>_arm64.deb
```

The workflow copies the `.deb` assets produced for GitHub Releases into
`apt/pool/`, retains the latest three package versions, regenerates `Packages`
and `Release`, signs the repository, validates checksums and signatures, then
publishes the result with the existing Electron feeds.

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
curl -fsSL https://jsgrrchg.github.io/NeverWrite/apt/dists/stable/InRelease | head
curl -fsSL https://jsgrrchg.github.io/NeverWrite/apt/dists/stable/main/binary-amd64/Packages.gz \
  | gunzip \
  | grep -E '^(Package|Version|Architecture|Filename):'
apt-cache policy neverwrite
```

## Rollback

Rollback is done by regenerating repository metadata so APT no longer advertises
the bad version. Do not delete release assets first. Keep at least one previous
version in `apt/pool/`, regenerate `Packages` and `Release`, sign again, and
publish `gh-pages`.
