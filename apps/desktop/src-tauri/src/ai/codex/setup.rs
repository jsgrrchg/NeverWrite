use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use neverwrite_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, CODEX_RUNTIME_ID};

#[cfg(test)]
use crate::ai::secret_store::TestSecretStore;
use crate::ai::secret_store::{
    clear_secret, get_secret, has_secret, set_secret, NormalizedSecretValuePatch, SecretValuePatch,
};
use crate::branding::APP_BRAND_NAME;
use crate::technical_branding::{app_data_dir, CODEX_ACP_BIN_ENV_VARS};

const SETUP_FILE_NAME: &str = "setup.json";
const CODEX_API_KEY_SECRET: &str = "codex_api_key";
const OPENAI_API_KEY_SECRET: &str = "openai_api_key";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodexSetupConfig {
    pub custom_binary_path: Option<String>,
    pub auth_method: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredCodexSetupConfig {
    pub custom_binary_path: Option<String>,
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_api_key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexSecretBundle {
    pub codex_api_key: Option<String>,
    pub openai_api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CodexSetupInput {
    pub custom_binary_path: Option<String>,
    #[serde(default)]
    pub codex_api_key: SecretValuePatch,
    #[serde(default)]
    pub openai_api_key: SecretValuePatch,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub path: Option<PathBuf>,
    pub source: AiRuntimeBinarySource,
}

impl CodexSetupConfig {
    fn apply_input(&mut self, input: &CodexSetupInput) {
        if let Some(path) = input.custom_binary_path.as_ref() {
            self.custom_binary_path = normalize_optional_string(Some(path.clone()));
        }
    }
}

impl From<StoredCodexSetupConfig> for CodexSetupConfig {
    fn from(value: StoredCodexSetupConfig) -> Self {
        Self {
            custom_binary_path: value.custom_binary_path,
            auth_method: value.auth_method,
        }
    }
}

impl StoredCodexSetupConfig {
    fn from_public(config: &CodexSetupConfig) -> Self {
        Self {
            custom_binary_path: config.custom_binary_path.clone(),
            auth_method: config.auth_method.clone(),
            codex_api_key: None,
            openai_api_key: None,
        }
    }

    fn has_legacy_secrets(&self) -> bool {
        self.codex_api_key.is_some() || self.openai_api_key.is_some()
    }
}

pub fn load_setup_config(app: &AppHandle) -> Result<CodexSetupConfig, String> {
    let path = setup_file_path(app)?;
    load_setup_config_from_path(&path)
}

pub fn load_secret_bundle() -> Result<CodexSecretBundle, String> {
    Ok(CodexSecretBundle {
        codex_api_key: get_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET)?,
        openai_api_key: get_secret(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET)?,
    })
}

pub fn save_setup_config(
    app: &AppHandle,
    input: CodexSetupInput,
) -> Result<CodexSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.apply_input(&input);
    apply_secret_patches(&input)?;
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn mark_authenticated_method(
    app: &AppHandle,
    method_id: &str,
) -> Result<CodexSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_method = Some(method_id.to_string());
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn clear_authenticated_method(app: &AppHandle) -> Result<CodexSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_method = None;
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn setup_status(
    app: &AppHandle,
    bundled_path: PathBuf,
    vendor_path: PathBuf,
) -> Result<AiRuntimeSetupStatus, String> {
    let config = load_setup_config(app)?;
    let resolved = resolve_binary_path(&config, bundled_path, vendor_path);
    let auth_methods = available_auth_methods();
    let auth_method = detect_auth_method(&config)?;
    let binary_ready = resolved.path.as_ref().is_some_and(|path| path.exists());
    let auth_ready = auth_method.is_some();

    let message = if !binary_ready {
        Some("Codex runtime is not available in this build yet.".to_string())
    } else if !auth_ready {
        Some("Connect your ChatGPT account or add an API key to finish setup.".to_string())
    } else {
        None
    };

    Ok(AiRuntimeSetupStatus {
        runtime_id: CODEX_RUNTIME_ID.to_string(),
        binary_ready,
        binary_path: resolved.path.map(|path| path.display().to_string()),
        binary_source: if binary_ready {
            resolved.source
        } else {
            AiRuntimeBinarySource::Missing
        },
        has_custom_binary_path: config.custom_binary_path.is_some(),
        auth_ready,
        auth_method,
        auth_methods,
        has_gateway_config: false,
        has_gateway_url: false,
        onboarding_required: !binary_ready || !auth_ready,
        message,
    })
}

pub fn resolve_binary_path(
    config: &CodexSetupConfig,
    bundled_path: PathBuf,
    vendor_path: PathBuf,
) -> ResolvedBinary {
    if let Some(path) = read_env_override(&CODEX_ACP_BIN_ENV_VARS) {
        let path = PathBuf::from(path);
        return ResolvedBinary {
            path: Some(path),
            source: AiRuntimeBinarySource::Env,
        };
    }

    if let Some(path) = config
        .custom_binary_path
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return ResolvedBinary {
            path: Some(path),
            source: AiRuntimeBinarySource::Custom,
        };
    }

    if bundled_path.exists() {
        return ResolvedBinary {
            path: Some(bundled_path),
            source: AiRuntimeBinarySource::Bundled,
        };
    }

    if vendor_path.exists() {
        return ResolvedBinary {
            path: Some(vendor_path),
            source: AiRuntimeBinarySource::Vendor,
        };
    }

    ResolvedBinary {
        path: Some(bundled_path),
        source: AiRuntimeBinarySource::Bundled,
    }
}

pub fn apply_auth_env(command: &mut tokio::process::Command) -> Result<(), String> {
    let secrets = load_secret_bundle()?;

    if !env_secret_present("CODEX_API_KEY") {
        if let Some(value) = secrets.codex_api_key.as_ref() {
            command.env("CODEX_API_KEY", value);
        }
    }

    if !env_secret_present("OPENAI_API_KEY") {
        if let Some(value) = secrets.openai_api_key.as_ref() {
            command.env("OPENAI_API_KEY", value);
        }
    }

    Ok(())
}

fn detect_auth_method(config: &CodexSetupConfig) -> Result<Option<String>, String> {
    if config.auth_method.as_deref() == Some("chatgpt") {
        return Ok(Some("chatgpt".to_string()));
    }

    if config.auth_method.as_deref() == Some("codex-api-key") && codex_api_key_ready()? {
        return Ok(Some("codex-api-key".to_string()));
    }

    if config.auth_method.as_deref() == Some("openai-api-key") && openai_api_key_ready()? {
        return Ok(Some("openai-api-key".to_string()));
    }

    if codex_api_key_ready()? {
        return Ok(Some("codex-api-key".to_string()));
    }

    if openai_api_key_ready()? {
        return Ok(Some("openai-api-key".to_string()));
    }

    Ok(None)
}

fn codex_api_key_ready() -> Result<bool, String> {
    if env_secret_present("CODEX_API_KEY") {
        return Ok(true);
    }
    has_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET)
}

fn openai_api_key_ready() -> Result<bool, String> {
    if env_secret_present("OPENAI_API_KEY") {
        return Ok(true);
    }
    has_secret(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET)
}

fn apply_secret_patches(input: &CodexSetupInput) -> Result<(), String> {
    match input.codex_api_key.normalize() {
        NormalizedSecretValuePatch::Unchanged => {}
        NormalizedSecretValuePatch::Clear => {
            clear_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET)?;
        }
        NormalizedSecretValuePatch::Set(value) => {
            set_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET, &value)?;
            clear_secret(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET)?;
        }
    }

    match input.openai_api_key.normalize() {
        NormalizedSecretValuePatch::Unchanged => {}
        NormalizedSecretValuePatch::Clear => {
            clear_secret(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET)?;
        }
        NormalizedSecretValuePatch::Set(value) => {
            set_secret(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET, &value)?;
            clear_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET)?;
        }
    }

    Ok(())
}

fn available_auth_methods() -> Vec<AiAuthMethod> {
    let mut methods = Vec::new();

    if std::env::var("NO_BROWSER").is_err() {
        methods.push(AiAuthMethod {
            id: "chatgpt".to_string(),
            name: "ChatGPT account".to_string(),
            description: "Sign in with your paid ChatGPT account to connect Codex.".to_string(),
        });
    }

    methods.push(AiAuthMethod {
        id: "openai-api-key".to_string(),
        name: "API key".to_string(),
        description: format!(
            "Use an OpenAI API key stored locally in {}.",
            APP_BRAND_NAME
        ),
    });

    methods.push(AiAuthMethod {
        id: "codex-api-key".to_string(),
        name: "Codex API key".to_string(),
        description: format!("Use a Codex API key stored locally in {}.", APP_BRAND_NAME),
    });

    methods
}

fn load_setup_config_from_path(path: &Path) -> Result<CodexSetupConfig, String> {
    let stored = load_stored_setup_config(path)?;
    if stored.has_legacy_secrets() {
        migrate_legacy_secrets(path, &stored)?;
    }
    Ok(stored.into())
}

fn load_stored_setup_config(path: &Path) -> Result<StoredCodexSetupConfig, String> {
    if !path.exists() {
        return Ok(StoredCodexSetupConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn migrate_legacy_secrets(path: &Path, stored: &StoredCodexSetupConfig) -> Result<(), String> {
    if let Some(value) = normalize_optional_string(stored.codex_api_key.clone()) {
        set_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET, &value)?;
    }

    if let Some(value) = normalize_optional_string(stored.openai_api_key.clone()) {
        set_secret(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET, &value)?;
    }

    let sanitized: CodexSetupConfig = stored.clone().into();
    write_setup_config_to_path(path, &sanitized)
}

fn write_setup_config_to_path(path: &Path, config: &CodexSetupConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(&StoredCodexSetupConfig::from_public(config))
        .map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn setup_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app_data_dir(app)?;
    Ok(base.join("ai").join(SETUP_FILE_NAME))
}

fn read_env_override(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn env_secret_present(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::secret_store::test_lock;
    use std::{env, sync::Arc};

    fn temp_setup_path(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "neverwrite-codex-setup-tests-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir.join(SETUP_FILE_NAME)
    }

    #[test]
    fn writes_public_config_without_serializing_secrets() {
        let _guard = test_lock().lock().unwrap();
        let path = temp_setup_path("public-only");
        let store = Arc::new(TestSecretStore::default());
        store.install();

        let config = CodexSetupConfig {
            custom_binary_path: Some("/tmp/codex".to_string()),
            auth_method: Some("chatgpt".to_string()),
        };

        write_setup_config_to_path(&path, &config).expect("write setup");
        let raw = fs::read_to_string(&path).expect("read setup");

        assert!(raw.contains("custom_binary_path"));
        assert!(!raw.contains("codex_api_key"));
        assert!(!raw.contains("openai_api_key"));

        TestSecretStore::uninstall();
        let _ = fs::remove_file(path);
    }

    #[test]
    fn migrates_legacy_json_secrets_into_secure_store() {
        let _guard = test_lock().lock().unwrap();
        let path = temp_setup_path("migrate");
        let store = Arc::new(TestSecretStore::default());
        store.install();

        let legacy = serde_json::json!({
            "custom_binary_path": "/tmp/codex",
            "codex_api_key": "secret-one",
            "openai_api_key": "secret-two",
            "auth_method": "codex-api-key"
        });
        fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let loaded = load_setup_config_from_path(&path).expect("load config");
        let raw = fs::read_to_string(&path).expect("read sanitized setup");

        assert_eq!(loaded.custom_binary_path.as_deref(), Some("/tmp/codex"));
        assert_eq!(
            store
                .get_value(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET)
                .as_deref(),
            Some("secret-one")
        );
        assert_eq!(
            store
                .get_value(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET)
                .as_deref(),
            Some("secret-two")
        );
        assert!(!raw.contains("codex_api_key"));
        assert!(!raw.contains("openai_api_key"));

        TestSecretStore::uninstall();
        let _ = fs::remove_file(path);
    }

    #[test]
    fn migration_keeps_legacy_json_when_secure_store_fails() {
        let _guard = test_lock().lock().unwrap();
        let path = temp_setup_path("migrate-fail");
        let store = Arc::new(TestSecretStore::default());
        store.fail_with("secure store unavailable");
        store.install();

        let legacy = serde_json::json!({
            "custom_binary_path": "/tmp/codex",
            "codex_api_key": "secret-one"
        });
        fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let error = load_setup_config_from_path(&path).expect_err("migration should fail");
        let raw = fs::read_to_string(&path).expect("read original setup");

        assert!(error.contains("secure store unavailable"));
        assert!(raw.contains("codex_api_key"));

        TestSecretStore::uninstall();
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detect_auth_method_prefers_external_env_before_secure_store() {
        let _secret_guard = test_lock().lock().unwrap();
        let original = env::var_os("CODEX_API_KEY");
        env::set_var("CODEX_API_KEY", "external-secret");
        let store = Arc::new(TestSecretStore::default());
        store.install();

        let config = CodexSetupConfig {
            auth_method: Some("codex-api-key".to_string()),
            ..CodexSetupConfig::default()
        };

        let detected = detect_auth_method(&config).expect("detect auth method");

        if let Some(value) = original {
            env::set_var("CODEX_API_KEY", value);
        } else {
            env::remove_var("CODEX_API_KEY");
        }
        TestSecretStore::uninstall();

        assert_eq!(detected.as_deref(), Some("codex-api-key"));
    }

    #[test]
    fn apply_auth_env_sets_missing_secrets_from_secure_store() {
        let _secret_guard = test_lock().lock().unwrap();
        let original_codex = env::var_os("CODEX_API_KEY");
        let original_openai = env::var_os("OPENAI_API_KEY");
        env::remove_var("CODEX_API_KEY");
        env::remove_var("OPENAI_API_KEY");

        let store = Arc::new(TestSecretStore::default());
        store.install();
        set_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET, "codex-secret").unwrap();
        set_secret(CODEX_RUNTIME_ID, OPENAI_API_KEY_SECRET, "openai-secret").unwrap();

        let mut command = tokio::process::Command::new("true");
        apply_auth_env(&mut command).expect("apply auth env");
        let std_command = command.as_std();

        let codex_value = std_command
            .get_envs()
            .find_map(|(key, value)| (key == "CODEX_API_KEY").then_some(value))
            .flatten()
            .map(|value| value.to_string_lossy().into_owned());
        let openai_value = std_command
            .get_envs()
            .find_map(|(key, value)| (key == "OPENAI_API_KEY").then_some(value))
            .flatten()
            .map(|value| value.to_string_lossy().into_owned());

        match original_codex {
            Some(value) => env::set_var("CODEX_API_KEY", value),
            None => env::remove_var("CODEX_API_KEY"),
        }
        match original_openai {
            Some(value) => env::set_var("OPENAI_API_KEY", value),
            None => env::remove_var("OPENAI_API_KEY"),
        }
        TestSecretStore::uninstall();

        assert_eq!(codex_value.as_deref(), Some("codex-secret"));
        assert_eq!(openai_value.as_deref(), Some("openai-secret"));
    }

    #[test]
    fn apply_auth_env_preserves_external_env_values() {
        let _secret_guard = test_lock().lock().unwrap();
        let original_codex = env::var_os("CODEX_API_KEY");
        env::set_var("CODEX_API_KEY", "external-secret");

        let store = Arc::new(TestSecretStore::default());
        store.install();
        set_secret(CODEX_RUNTIME_ID, CODEX_API_KEY_SECRET, "stored-secret").unwrap();

        let mut command = tokio::process::Command::new("true");
        apply_auth_env(&mut command).expect("apply auth env");
        let std_command = command.as_std();

        let codex_value = std_command
            .get_envs()
            .find_map(|(key, value)| (key == "CODEX_API_KEY").then_some(value))
            .flatten()
            .map(|value| value.to_string_lossy().into_owned());

        match original_codex {
            Some(value) => env::set_var("CODEX_API_KEY", value),
            None => env::remove_var("CODEX_API_KEY"),
        }
        TestSecretStore::uninstall();

        assert!(codex_value.is_none());
    }
}
