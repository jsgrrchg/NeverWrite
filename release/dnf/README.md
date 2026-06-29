# NeverWrite DNF Repository

NeverWrite publishes a signed DNF repository for Fedora/RHEL packages at:

```text
https://jsgrrchg.github.io/NeverWrite/dnf
```

RPM packages are hosted on GitHub Releases; the DNF repository contains only
package metadata generated from the signed RPM headers with `createrepo_c`. The
repository enables both RPM package signature checks and repository metadata
signature checks.

## User Install

```bash
sudo tee /etc/yum.repos.d/neverwrite.repo >/dev/null <<'EOF'
[neverwrite]
name=NeverWrite
baseurl=https://jsgrrchg.github.io/NeverWrite/dnf
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://jsgrrchg.github.io/NeverWrite/dnf/neverwrite-archive-keyring.asc
EOF
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
sudo dnf install --downloadonly neverwrite
```
