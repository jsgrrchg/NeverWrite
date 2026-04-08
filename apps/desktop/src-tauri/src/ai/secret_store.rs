use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::technical_branding::SECRET_STORE_SERVICE;

#[cfg(test)]
use std::sync::{Mutex, OnceLock};

#[cfg(test)]
static TEST_BACKEND: OnceLock<Mutex<Option<Arc<dyn SecretStoreBackend>>>> = OnceLock::new();
#[cfg(test)]
static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SecretValuePatch {
    #[default]
    Unchanged,
    Set {
        value: String,
    },
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedSecretValuePatch {
    Unchanged,
    Set(String),
    Clear,
}

impl SecretValuePatch {
    pub fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }

    pub fn normalize(&self) -> NormalizedSecretValuePatch {
        match self {
            Self::Unchanged => NormalizedSecretValuePatch::Unchanged,
            Self::Clear => NormalizedSecretValuePatch::Clear,
            Self::Set { value } => normalize_secret_value(value)
                .map(NormalizedSecretValuePatch::Set)
                .unwrap_or(NormalizedSecretValuePatch::Clear),
        }
    }
}

trait SecretStoreBackend: Send + Sync {
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String>;
    fn get_secret(&self, account: &str) -> Result<Option<String>, String>;
    fn clear_secret(&self, account: &str) -> Result<(), String>;
}

#[derive(Debug, Default)]
struct KeyringSecretStore;

impl KeyringSecretStore {
    fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, account)
            .map_err(|error| format!("Failed to access the secure secret store: {error}"))
    }
}

impl SecretStoreBackend for KeyringSecretStore {
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(SECRET_STORE_SERVICE, account)?
            .set_password(value)
            .map_err(|error| format!("Failed to save a secret in the secure store: {error}"))
    }

    fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(SECRET_STORE_SERVICE, account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "Failed to read a secret from the secure store: {error}"
            )),
        }
    }

    fn clear_secret(&self, account: &str) -> Result<(), String> {
        match Self::entry(SECRET_STORE_SERVICE, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "Failed to clear a secret from the secure store: {error}"
            )),
        }
    }
}

#[cfg(test)]
fn active_backend() -> Arc<dyn SecretStoreBackend> {
    TEST_BACKEND
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("poisoned test secret store lock")
        .clone()
        .unwrap_or_else(|| Arc::new(KeyringSecretStore))
}

#[cfg(not(test))]
fn active_backend() -> Arc<dyn SecretStoreBackend> {
    Arc::new(KeyringSecretStore)
}

pub fn set_secret(runtime_id: &str, secret_key: &str, value: &str) -> Result<(), String> {
    active_backend().set_secret(&account_name(runtime_id, secret_key), value)
}

pub fn get_secret(runtime_id: &str, secret_key: &str) -> Result<Option<String>, String> {
    active_backend().get_secret(&account_name(runtime_id, secret_key))
}

pub fn has_secret(runtime_id: &str, secret_key: &str) -> Result<bool, String> {
    Ok(get_secret(runtime_id, secret_key)?.is_some())
}

pub fn clear_secret(runtime_id: &str, secret_key: &str) -> Result<(), String> {
    active_backend().clear_secret(&account_name(runtime_id, secret_key))
}

fn account_name(runtime_id: &str, secret_key: &str) -> String {
    format!("{runtime_id}:{secret_key}")
}

fn normalize_secret_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
use std::collections::HashMap;

#[cfg(test)]
#[derive(Debug, Default)]
pub struct TestSecretStore {
    values: Mutex<HashMap<String, String>>,
    failure: Mutex<Option<String>>,
}

#[cfg(test)]
impl TestSecretStore {
    pub fn install(self: &Arc<Self>) {
        *TEST_BACKEND
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("poisoned test secret store lock") = Some(self.clone());
    }

    pub fn uninstall() {
        *TEST_BACKEND
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("poisoned test secret store lock") = None;
    }

    pub fn fail_with(&self, message: impl Into<String>) {
        *self.failure.lock().expect("poisoned failure lock") = Some(message.into());
    }

    pub fn get_value(&self, runtime_id: &str, secret_key: &str) -> Option<String> {
        self.values
            .lock()
            .expect("poisoned values lock")
            .get(&account_name(runtime_id, secret_key))
            .cloned()
    }
}

#[cfg(test)]
pub fn test_lock() -> &'static Mutex<()> {
    TEST_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
impl SecretStoreBackend for TestSecretStore {
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        if let Some(message) = self.failure.lock().expect("poisoned failure lock").clone() {
            return Err(message);
        }

        self.values
            .lock()
            .expect("poisoned values lock")
            .insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
        if let Some(message) = self.failure.lock().expect("poisoned failure lock").clone() {
            return Err(message);
        }

        Ok(self
            .values
            .lock()
            .expect("poisoned values lock")
            .get(account)
            .cloned())
    }

    fn clear_secret(&self, account: &str) -> Result<(), String> {
        if let Some(message) = self.failure.lock().expect("poisoned failure lock").clone() {
            return Err(message);
        }

        self.values
            .lock()
            .expect("poisoned values lock")
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{NormalizedSecretValuePatch, SecretValuePatch};

    #[test]
    fn normalize_secret_patch_trims_set_values() {
        let patch = SecretValuePatch::Set {
            value: "  secret  ".to_string(),
        };

        assert_eq!(
            patch.normalize(),
            NormalizedSecretValuePatch::Set("secret".to_string())
        );
    }

    #[test]
    fn normalize_secret_patch_turns_blank_set_into_clear() {
        let patch = SecretValuePatch::Set {
            value: "   ".to_string(),
        };

        assert_eq!(patch.normalize(), NormalizedSecretValuePatch::Clear);
    }
}
