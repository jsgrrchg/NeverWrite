use std::path::{Path, PathBuf};

const VAULT_STORAGE_DIR: &str = ".neverwrite";

pub(super) fn vault_storage_root(vault_root: &Path) -> PathBuf {
    vault_root.join(VAULT_STORAGE_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_existing_vault_storage_layout() {
        let root = Path::new("vault-root");
        assert_eq!(vault_storage_root(root), root.join(".neverwrite"));
    }
}
