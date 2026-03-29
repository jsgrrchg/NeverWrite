use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use vault_ai_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, GEMINI_RUNTIME_ID};

#[cfg(test)]
use crate::ai::secret_store::TestSecretStore;
use crate::ai::secret_store::{
    clear_secret, get_secret, has_secret, set_secret, NormalizedSecretValuePatch, SecretValuePatch,
};

const SETUP_FILE_NAME: &str = "gemini-setup.json";
const GEMINI_PROGRAM_NAME: &str = "gemini";
const GEMINI_AUTH_SETTINGS_RELATIVE_PATH: &str = ".gemini/settings.json";
const GEMINI_GOOGLE_AUTH_TYPE_ALIASES: &[&str] = &["oauth-personal", "login_with_google", "google"];
const GEMINI_API_KEY_SECRET: &str = "gemini_api_key";
const GOOGLE_API_KEY_SECRET: &str = "google_api_key";
const GATEWAY_HEADERS_SECRET: &str = "gateway_headers";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GeminiSetupConfig {
    pub custom_binary_path: Option<String>,
    pub auth_method: Option<String>,
    pub auth_invalidated_at_ms: Option<u64>,
    pub google_cloud_project: Option<String>,
    pub google_cloud_location: Option<String>,
    pub gateway_base_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredGeminiSetupConfig {
    pub custom_binary_path: Option<String>,
    pub auth_method: Option<String>,
    pub auth_invalidated_at_ms: Option<u64>,
    pub google_cloud_project: Option<String>,
    pub google_cloud_location: Option<String>,
    pub gateway_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_headers: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GeminiSecretBundle {
    pub gemini_api_key: Option<String>,
    pub google_api_key: Option<String>,
    pub gateway_headers: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GeminiSetupInput {
    pub custom_binary_path: Option<String>,
    #[serde(default)]
    pub gemini_api_key: SecretValuePatch,
    #[serde(default)]
    pub google_api_key: SecretValuePatch,
    pub google_cloud_project: Option<String>,
    pub google_cloud_location: Option<String>,
    pub gateway_base_url: Option<String>,
    #[serde(default)]
    pub gateway_headers: SecretValuePatch,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub program: Option<String>,
    pub args: Vec<String>,
    pub display: Option<String>,
    pub source: AiRuntimeBinarySource,
}

impl GeminiSetupConfig {
    fn apply_input(&mut self, input: &GeminiSetupInput) {
        if let Some(path) = input.custom_binary_path.as_ref() {
            self.custom_binary_path = normalize_optional_string(Some(path.clone()));
        }
        if let Some(value) = input.google_cloud_project.as_ref() {
            self.google_cloud_project = normalize_optional_string(Some(value.clone()));
        }
        if let Some(value) = input.google_cloud_location.as_ref() {
            self.google_cloud_location = normalize_optional_string(Some(value.clone()));
        }
        if let Some(value) = input.gateway_base_url.as_ref() {
            self.gateway_base_url = normalize_optional_string(Some(value.clone()));
        }
        if !input.gemini_api_key.is_unchanged() || !input.google_api_key.is_unchanged() {
            self.auth_method = None;
            self.auth_invalidated_at_ms = None;
        }
    }
}

impl From<StoredGeminiSetupConfig> for GeminiSetupConfig {
    fn from(value: StoredGeminiSetupConfig) -> Self {
        Self {
            custom_binary_path: value.custom_binary_path,
            auth_method: value.auth_method,
            auth_invalidated_at_ms: value.auth_invalidated_at_ms,
            google_cloud_project: value.google_cloud_project,
            google_cloud_location: value.google_cloud_location,
            gateway_base_url: value.gateway_base_url,
        }
    }
}

impl StoredGeminiSetupConfig {
    fn from_public(config: &GeminiSetupConfig) -> Self {
        Self {
            custom_binary_path: config.custom_binary_path.clone(),
            auth_method: config.auth_method.clone(),
            auth_invalidated_at_ms: config.auth_invalidated_at_ms,
            google_cloud_project: config.google_cloud_project.clone(),
            google_cloud_location: config.google_cloud_location.clone(),
            gateway_base_url: config.gateway_base_url.clone(),
            gemini_api_key: None,
            google_api_key: None,
            gateway_headers: None,
        }
    }

    fn has_legacy_secrets(&self) -> bool {
        self.gemini_api_key.is_some()
            || self.google_api_key.is_some()
            || self.gateway_headers.is_some()
    }
}

pub fn load_setup_config(app: &AppHandle) -> Result<GeminiSetupConfig, String> {
    let path = setup_file_path(app)?;
    load_setup_config_from_path(&path)
}

pub fn load_secret_bundle(_app: &AppHandle) -> Result<GeminiSecretBundle, String> {
    Ok(GeminiSecretBundle {
        gemini_api_key: get_secret(GEMINI_RUNTIME_ID, GEMINI_API_KEY_SECRET)?,
        google_api_key: get_secret(GEMINI_RUNTIME_ID, GOOGLE_API_KEY_SECRET)?,
        gateway_headers: get_secret(GEMINI_RUNTIME_ID, GATEWAY_HEADERS_SECRET)?,
    })
}

pub fn save_setup_config(
    app: &AppHandle,
    input: GeminiSetupInput,
) -> Result<GeminiSetupConfig, String> {
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
) -> Result<GeminiSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_method = Some(method_id.to_string());
    config.auth_invalidated_at_ms = None;
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn clear_authenticated_method(app: &AppHandle) -> Result<GeminiSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_method = None;
    config.auth_invalidated_at_ms = Some(current_time_millis());
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn setup_status(app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
    let config = load_setup_config(app)?;
    let resolved = resolve_binary_command(&config);
    let auth_methods = available_auth_methods();
    let auth_method = detect_auth_method(&config, app)?;
    let binary_ready = resolved.program.is_some();
    let auth_ready = auth_method.is_some();

    let message = if !binary_ready {
        Some(
            "Gemini CLI was not found. Install gemini-cli or provide a custom runtime path."
                .to_string(),
        )
    } else if !auth_ready {
        Some("Log in with Google or add a Gemini API key to finish setup.".to_string())
    } else {
        None
    };

    Ok(AiRuntimeSetupStatus {
        runtime_id: GEMINI_RUNTIME_ID.to_string(),
        binary_ready,
        binary_path: resolved.display,
        binary_source: if binary_ready {
            resolved.source
        } else {
            AiRuntimeBinarySource::Missing
        },
        has_custom_binary_path: config.custom_binary_path.is_some(),
        auth_ready,
        auth_method,
        auth_methods,
        has_gateway_config: config
            .gateway_base_url
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty()),
        has_gateway_url: config
            .gateway_base_url
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty()),
        onboarding_required: !binary_ready || !auth_ready,
        message,
    })
}

pub fn resolve_binary_command(config: &GeminiSetupConfig) -> ResolvedBinary {
    if let Ok(raw) = env::var("VAULTAI_GEMINI_ACP_BIN") {
        let resolved = resolve_command_candidate(raw.trim(), AiRuntimeBinarySource::Env);
        if resolved.display.is_some() {
            return resolved;
        }
    }

    if let Some(raw) = config.custom_binary_path.as_deref() {
        let resolved = resolve_command_candidate(raw, AiRuntimeBinarySource::Custom);
        if resolved.program.is_some() {
            return resolved;
        }
    }

    if let Some(path) = find_program(GEMINI_PROGRAM_NAME) {
        return command_from_existing_path(path, AiRuntimeBinarySource::Env);
    }

    ResolvedBinary {
        program: None,
        args: Vec::new(),
        display: Some(GEMINI_PROGRAM_NAME.to_string()),
        source: AiRuntimeBinarySource::Env,
    }
}

pub fn apply_auth_env(
    command: &mut tokio::process::Command,
    app: &AppHandle,
    config: &GeminiSetupConfig,
) -> Result<(), String> {
    let secrets = load_secret_bundle(app)?;

    if !env_secret_present("GEMINI_API_KEY") {
        if let Some(value) = secrets.gemini_api_key.as_ref() {
            command.env("GEMINI_API_KEY", value);
        }
    }
    if !env_secret_present("GOOGLE_API_KEY") {
        if let Some(value) = secrets.google_api_key.as_ref() {
            command.env("GOOGLE_API_KEY", value);
        }
    }
    if let Some(value) = config.google_cloud_project.as_ref() {
        command.env("GOOGLE_CLOUD_PROJECT", value);
    }
    if let Some(value) = config.google_cloud_location.as_ref() {
        command.env("GOOGLE_CLOUD_LOCATION", value);
    }
    if let Some(value) = config.auth_method.as_deref() {
        command.env("GEMINI_DEFAULT_AUTH_TYPE", value);
    }

    Ok(())
}

pub fn has_gemini_api_key(_app: &AppHandle) -> Result<bool, String> {
    developer_api_key_ready()
}

fn detect_auth_method(
    config: &GeminiSetupConfig,
    app: &AppHandle,
) -> Result<Option<String>, String> {
    if config.auth_method.as_deref() == Some("use_gemini") && gemini_api_key_ready(app)? {
        return Ok(Some("use_gemini".to_string()));
    }

    if config.auth_method.as_deref() == Some("login_with_google")
        && gemini_google_login_available(config)
    {
        return Ok(Some("login_with_google".to_string()));
    }

    if gemini_api_key_ready(app)? {
        return Ok(Some("use_gemini".to_string()));
    }

    if gemini_google_login_available(config) {
        return Ok(Some("login_with_google".to_string()));
    }

    Ok(None)
}

fn available_auth_methods() -> Vec<AiAuthMethod> {
    vec![
        AiAuthMethod {
            id: "login_with_google".to_string(),
            name: "Log in with Google".to_string(),
            description: "Open a Gemini sign-in terminal for Google account authentication."
                .to_string(),
        },
        AiAuthMethod {
            id: "use_gemini".to_string(),
            name: "Gemini API key".to_string(),
            description: "Use a Gemini Developer API key stored only for VaultAI.".to_string(),
        },
    ]
}

fn gemini_api_key_ready(_app: &AppHandle) -> Result<bool, String> {
    developer_api_key_ready()
}

fn developer_api_key_ready() -> Result<bool, String> {
    if env_secret_present("GEMINI_API_KEY") {
        return Ok(true);
    }
    if env_secret_present("GOOGLE_API_KEY") {
        return Ok(true);
    }
    if has_secret(GEMINI_RUNTIME_ID, GEMINI_API_KEY_SECRET)? {
        return Ok(true);
    }
    has_secret(GEMINI_RUNTIME_ID, GOOGLE_API_KEY_SECRET)
}

fn gemini_google_login_available(config: &GeminiSetupConfig) -> bool {
    let Some(settings_path) = gemini_settings_file_path() else {
        return false;
    };

    if !settings_path.exists() {
        return false;
    }

    let Some(selected_type) = read_selected_auth_type(&settings_path) else {
        return false;
    };
    if !matches_google_login_selected_type(&selected_type) {
        return false;
    }

    let Some(invalidated_at_ms) = config.auth_invalidated_at_ms else {
        return true;
    };

    file_modified_at_ms(&settings_path)
        .map(|modified_at_ms| modified_at_ms > invalidated_at_ms)
        .unwrap_or(false)
}

fn read_selected_auth_type(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    json.get("security")?
        .get("auth")?
        .get("selectedType")?
        .as_str()
        .map(ToString::to_string)
}

fn gemini_settings_file_path() -> Option<PathBuf> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(home_dir_fallback);
    Some(home?.join(GEMINI_AUTH_SETTINGS_RELATIVE_PATH))
}

fn file_modified_at_ms(path: &Path) -> Option<u64> {
    let modified_at = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified_at.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis().try_into().ok()?)
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn setup_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(base.join("ai").join(SETUP_FILE_NAME))
}

fn write_setup_config_to_path(path: &Path, config: &GeminiSetupConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(&StoredGeminiSetupConfig::from_public(config))
        .map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn load_setup_config_from_path(path: &Path) -> Result<GeminiSetupConfig, String> {
    let stored = load_stored_setup_config(path)?;
    if stored.has_legacy_secrets() {
        migrate_legacy_secrets(path, &stored)?;
    }
    Ok(stored.into())
}

fn load_stored_setup_config(path: &Path) -> Result<StoredGeminiSetupConfig, String> {
    if !path.exists() {
        return Ok(StoredGeminiSetupConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn migrate_legacy_secrets(path: &Path, stored: &StoredGeminiSetupConfig) -> Result<(), String> {
    if let Some(value) = normalize_optional_string(stored.gemini_api_key.clone()) {
        set_secret(GEMINI_RUNTIME_ID, GEMINI_API_KEY_SECRET, &value)?;
    }
    if let Some(value) = normalize_optional_string(stored.google_api_key.clone()) {
        set_secret(GEMINI_RUNTIME_ID, GOOGLE_API_KEY_SECRET, &value)?;
    }
    if let Some(value) = normalize_optional_string(stored.gateway_headers.clone()) {
        set_secret(GEMINI_RUNTIME_ID, GATEWAY_HEADERS_SECRET, &value)?;
    }

    let sanitized: GeminiSetupConfig = stored.clone().into();
    write_setup_config_to_path(path, &sanitized)
}

fn apply_secret_patches(input: &GeminiSetupInput) -> Result<(), String> {
    match input.gemini_api_key.normalize() {
        NormalizedSecretValuePatch::Unchanged => {}
        NormalizedSecretValuePatch::Clear => {
            clear_secret(GEMINI_RUNTIME_ID, GEMINI_API_KEY_SECRET)?;
        }
        NormalizedSecretValuePatch::Set(value) => {
            set_secret(GEMINI_RUNTIME_ID, GEMINI_API_KEY_SECRET, &value)?;
        }
    }

    match input.google_api_key.normalize() {
        NormalizedSecretValuePatch::Unchanged => {}
        NormalizedSecretValuePatch::Clear => {
            clear_secret(GEMINI_RUNTIME_ID, GOOGLE_API_KEY_SECRET)?;
        }
        NormalizedSecretValuePatch::Set(value) => {
            set_secret(GEMINI_RUNTIME_ID, GOOGLE_API_KEY_SECRET, &value)?;
        }
    }

    match input.gateway_headers.normalize() {
        NormalizedSecretValuePatch::Unchanged => {}
        NormalizedSecretValuePatch::Clear => {
            clear_secret(GEMINI_RUNTIME_ID, GATEWAY_HEADERS_SECRET)?;
        }
        NormalizedSecretValuePatch::Set(value) => {
            set_secret(GEMINI_RUNTIME_ID, GATEWAY_HEADERS_SECRET, &value)?;
        }
    }

    Ok(())
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

fn resolve_command_candidate(raw: &str, source: AiRuntimeBinarySource) -> ResolvedBinary {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ResolvedBinary {
            program: None,
            args: Vec::new(),
            display: None,
            source,
        };
    }

    let candidate = PathBuf::from(trimmed);
    let looks_like_path = candidate.is_absolute()
        || trimmed.contains(std::path::MAIN_SEPARATOR)
        || trimmed.contains('/')
        || trimmed.contains('\\');

    if looks_like_path {
        if candidate.exists() {
            return command_from_existing_path(candidate, source);
        }

        return ResolvedBinary {
            program: None,
            args: Vec::new(),
            display: Some(trimmed.to_string()),
            source,
        };
    }

    if let Some(found) = find_program(trimmed) {
        return command_from_existing_path(found, source);
    }

    ResolvedBinary {
        program: None,
        args: Vec::new(),
        display: Some(trimmed.to_string()),
        source,
    }
}

fn command_from_existing_path(path: PathBuf, source: AiRuntimeBinarySource) -> ResolvedBinary {
    ResolvedBinary {
        program: Some(path.display().to_string()),
        args: Vec::new(),
        display: Some(path.display().to_string()),
        source,
    }
}

fn home_dir_fallback() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE").map(PathBuf::from)
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn find_program(program: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() {
        return candidate.exists().then_some(candidate);
    }

    let paths = env::var_os("PATH")?;
    for directory in env::split_paths(&paths) {
        for candidate in executable_candidates(&directory, program) {
            if candidate.exists() && candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn executable_candidates(directory: &Path, program: &str) -> Vec<PathBuf> {
    let base = directory.join(program);

    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec![base.clone()];
        let has_extension = Path::new(program).extension().is_some();

        if !has_extension {
            for extension in windows_path_extensions() {
                let normalized = extension.trim();
                if normalized.is_empty() {
                    continue;
                }
                let ext = normalized.strip_prefix('.').unwrap_or(normalized);
                candidates.push(directory.join(format!("{program}.{ext}")));
            }

            if !candidates.iter().any(|candidate| {
                candidate
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
            }) {
                candidates.push(directory.join(format!("{program}.exe")));
            }
        }

        return candidates;
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![base]
    }
}

#[cfg(target_os = "windows")]
fn windows_path_extensions() -> Vec<String> {
    env::var_os("PATHEXT")
        .and_then(|value| value.into_string().ok())
        .map(|raw| {
            raw.split(';')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn matches_google_login_selected_type(value: &str) -> bool {
    GEMINI_GOOGLE_AUTH_TYPE_ALIASES
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(value))
}

fn env_secret_present(name: &str) -> bool {
    env::var(name)
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
            "vaultai-gemini-setup-tests-{}-{}",
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
        let config = GeminiSetupConfig {
            gateway_base_url: Some("https://gateway.example".to_string()),
            ..GeminiSetupConfig::default()
        };

        write_setup_config_to_path(&path, &config).expect("write setup");
        let raw = fs::read_to_string(&path).expect("read setup");

        assert!(raw.contains("gateway_base_url"));
        assert!(!raw.contains("gemini_api_key"));
        assert!(!raw.contains("gateway_headers"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn migrates_legacy_json_secrets_into_secure_store() {
        let _guard = test_lock().lock().unwrap();
        let path = temp_setup_path("migrate");
        let store = Arc::new(TestSecretStore::default());
        store.install();

        let legacy = serde_json::json!({
            "gemini_api_key": "gemini-secret",
            "google_api_key": "google-secret",
            "gateway_headers": "x-api-key: secret"
        });
        fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let _ = load_setup_config_from_path(&path).expect("load config");
        let raw = fs::read_to_string(&path).expect("read sanitized setup");

        assert_eq!(
            store
                .get_value(GEMINI_RUNTIME_ID, GEMINI_API_KEY_SECRET)
                .as_deref(),
            Some("gemini-secret")
        );
        assert_eq!(
            store
                .get_value(GEMINI_RUNTIME_ID, GOOGLE_API_KEY_SECRET)
                .as_deref(),
            Some("google-secret")
        );
        assert_eq!(
            store
                .get_value(GEMINI_RUNTIME_ID, GATEWAY_HEADERS_SECRET)
                .as_deref(),
            Some("x-api-key: secret")
        );
        assert!(!raw.contains("gemini_api_key"));
        assert!(!raw.contains("gateway_headers"));

        TestSecretStore::uninstall();
        let _ = fs::remove_file(path);
    }

    #[test]
    fn developer_api_key_ready_accepts_google_api_key_from_secure_store() {
        let _guard = test_lock().lock().unwrap();
        let store = Arc::new(TestSecretStore::default());
        store.install();
        set_secret(GEMINI_RUNTIME_ID, GOOGLE_API_KEY_SECRET, "google-secret")
            .expect("seed secure store");

        let ready = developer_api_key_ready().expect("check secure store");

        assert!(ready);

        TestSecretStore::uninstall();
    }

    #[test]
    fn apply_input_invalidates_auth_when_google_api_key_changes() {
        let mut config = GeminiSetupConfig {
            auth_method: Some("use_gemini".to_string()),
            auth_invalidated_at_ms: Some(42),
            ..GeminiSetupConfig::default()
        };

        config.apply_input(&GeminiSetupInput {
            custom_binary_path: None,
            gemini_api_key: SecretValuePatch::Unchanged,
            google_api_key: SecretValuePatch::Set {
                value: "google-secret".to_string(),
            },
            google_cloud_project: None,
            google_cloud_location: None,
            gateway_base_url: None,
            gateway_headers: SecretValuePatch::Unchanged,
        });

        assert_eq!(config.auth_method, None);
        assert_eq!(config.auth_invalidated_at_ms, None);
    }
}
