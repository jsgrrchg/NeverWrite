use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const VAULT_STORAGE_DIR: &str = ".neverwrite";

pub(super) fn vault_storage_root(vault_root: &Path) -> PathBuf {
    vault_root.join(VAULT_STORAGE_DIR)
}

pub(super) fn draft_storage_root(
    app_data_root: &Path,
    vault_root: &Path,
) -> Result<PathBuf, String> {
    let canonical_vault = vault_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve vault root: {error}"))?;
    let normalized = canonical_vault.to_string_lossy().replace('\\', "/");
    let vault_key = hex_sha256(normalized.as_bytes());
    Ok(app_data_root
        .join("ai-history")
        .join("v1")
        .join("vaults")
        .join(vault_key)
        .join("drafts"))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_existing_vault_storage_layout() {
        let root = Path::new("vault-root");
        assert_eq!(vault_storage_root(root), root.join(".neverwrite"));
    }

    #[test]
    fn derives_a_local_draft_namespace_without_exposing_the_vault_path() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let root = draft_storage_root(app_data.path(), vault.path()).unwrap();
        assert!(root.starts_with(app_data.path().join("ai-history/v1/vaults")));
        assert_eq!(
            root.file_name().and_then(|value| value.to_str()),
            Some("drafts")
        );
        assert!(
            !root
                .to_string_lossy()
                .contains(&vault.path().to_string_lossy().to_string())
        );
    }
}
