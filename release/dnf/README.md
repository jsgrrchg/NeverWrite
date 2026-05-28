# NeverWrite DNF Repository

NeverWrite publishes a signed DNF repository for Fedora/RHEL packages at:

```text
https://jsgrrchg.github.io/NeverWrite/dnf
```

RPM packages are hosted on GitHub Releases; the DNF repository contains only
package metadata.

## User Install

```bash
sudo dnf config-manager --add-repo https://jsgrrchg.github.io/NeverWrite/dnf/neverwrite.repo.example
sudo rpm --import https://jsgrrchg.github.io/NeverWrite/dnf/neverwrite-archive-keyring.asc
sudo dnf install neverwrite
```

## Published Layout

```text
dnf/
  neverwrite-archive-keyring.asc
  neverwrite.repo.example
  repodata/
    repomd.xml
    repomd.xml.asc
    primary.xml.gz
    filelists.xml.gz
    other.xml.gz
```

## Validation

Manual post-release checks:

```bash
curl -fsSL https://jsgrrchg.github.io/NeverWrite/dnf/repodata/repomd.xml | head
curl -fsSL https://jsgrrchg.github.io/NeverWrite/dnf/neverwrite.repo.example
dnf info neverwrite
```
