use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use vault_ai_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, GEMINI_RUNTIME_ID};

const SETUP_FILE_NAME: &str = "gemini-setup.json";
const GEMINI_PROGRAM_NAME: &str = "gemini";
const GEMINI_AUTH_SETTINGS_RELATIVE_PATH: &str = ".gemini/settings.json";
const GEMINI_GOOGLE_AUTH_TYPE_ALIASES: &[&str] = &["oauth-personal", "login_with_google", "google"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GeminiSetupConfig {
    pub custom_binary_path: Option<String>,
    pub auth_method: Option<String>,
    pub auth_invalidated_at_ms: Option<u64>,
    pub gemini_api_key: Option<String>,
    pub google_api_key: Option<String>,
    pub google_cloud_project: Option<String>,
    pub google_cloud_location: Option<String>,
    pub gateway_base_url: Option<String>,
    pub gateway_headers: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GeminiSetupInput {
    pub custom_binary_path: Option<String>,
    pub gemini_api_key: Option<String>,
    pub google_api_key: Option<String>,
    pub google_cloud_project: Option<String>,
    pub google_cloud_location: Option<String>,
    pub gateway_base_url: Option<String>,
    pub gateway_headers: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub program: Option<String>,
    pub args: Vec<String>,
    pub display: Option<String>,
    pub source: AiRuntimeBinarySource,
}

impl GeminiSetupConfig {
    pub fn merge_input(mut self, input: GeminiSetupInput) -> Self {
        if let Some(path) = input.custom_binary_path {
            self.custom_binary_path = normalize_optional_string(Some(path));
        }
        if let Some(value) = input.gemini_api_key {
            self.gemini_api_key = normalize_optional_string(Some(value));
            self.auth_method = None;
            self.auth_invalidated_at_ms = None;
        }
        if let Some(value) = input.google_api_key {
            self.google_api_key = normalize_optional_string(Some(value));
        }
        if let Some(value) = input.google_cloud_project {
            self.google_cloud_project = normalize_optional_string(Some(value));
        }
        if let Some(value) = input.google_cloud_location {
            self.google_cloud_location = normalize_optional_string(Some(value));
        }
        if let Some(value) = input.gateway_base_url {
            self.gateway_base_url = normalize_optional_string(Some(value));
        }
        if let Some(value) = input.gateway_headers {
            self.gateway_headers = normalize_optional_string(Some(value));
        }
        self
    }
}

pub fn load_setup_config(app: &AppHandle) -> Result<GeminiSetupConfig, String> {
    let path = setup_file_path(app)?;
    if !path.exists() {
        return Ok(GeminiSetupConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

pub fn save_setup_config(
    app: &AppHandle,
    input: GeminiSetupInput,
) -> Result<GeminiSetupConfig, String> {
    let config = load_setup_config(app)?.merge_input(input);
    write_setup_config(app, &config)?;
    Ok(config)
}

pub fn mark_authenticated_method(
    app: &AppHandle,
    method_id: &str,
) -> Result<GeminiSetupConfig, String> {
    let mut config = load_setup_config(app)?;
    config.auth_method = Some(method_id.to_string());
    config.auth_invalidated_at_ms = None;
    write_setup_config(app, &config)?;
    Ok(config)
}

pub fn clear_authenticated_method(app: &AppHandle) -> Result<GeminiSetupConfig, String> {
    let mut config = load_setup_config(app)?;
    config.auth_method = None;
    config.auth_invalidated_at_ms = Some(current_time_millis());
    write_setup_config(app, &config)?;
    Ok(config)
}

pub fn setup_status(app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
    let config = load_setup_config(app)?;
    let resolved = resolve_binary_command(&config);
    let auth_methods = available_auth_methods();
    let auth_method = detect_auth_method(&config);
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

pub fn apply_auth_env(command: &mut tokio::process::Command, config: &GeminiSetupConfig) {
    if let Some(value) = config.gemini_api_key.as_ref() {
        command.env("GEMINI_API_KEY", value);
    }
    if let Some(value) = config.google_api_key.as_ref() {
        command.env("GOOGLE_API_KEY", value);
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
}

fn detect_auth_method(config: &GeminiSetupConfig) -> Option<String> {
    if config.auth_method.as_deref() == Some("use_gemini") && gemini_api_key_ready(config) {
        return Some("use_gemini".to_string());
    }

    if config.auth_method.as_deref() == Some("login_with_google")
        && gemini_google_login_available(config)
    {
        return Some("login_with_google".to_string());
    }

    if gemini_api_key_ready(config) {
        return Some("use_gemini".to_string());
    }

    if gemini_google_login_available(config) {
        return Some("login_with_google".to_string());
    }

    None
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

fn gemini_api_key_ready(config: &GeminiSetupConfig) -> bool {
    config
        .gemini_api_key
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        || env::var("GEMINI_API_KEY")
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
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

fn write_setup_config(app: &AppHandle, config: &GeminiSetupConfig) -> Result<(), String> {
    let path = setup_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
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
        || trimmed.contains('\\')
        || is_js_path(&candidate);

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
    let display = path.display().to_string();

    if is_js_path(&path) {
        if let Some(node_path) = find_program("node") {
            return ResolvedBinary {
                program: Some(node_path.display().to_string()),
                args: vec![display.clone()],
                display: Some(display),
                source,
            };
        }

        return ResolvedBinary {
            program: None,
            args: Vec::new(),
            display: Some(display),
            source,
        };
    }

    ResolvedBinary {
        program: Some(display.clone()),
        args: Vec::new(),
        display: Some(display),
        source,
    }
}

fn is_js_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("js" | "mjs" | "cjs")
    )
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
        }

        candidates
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![base]
    }
}

#[cfg(target_os = "windows")]
fn windows_path_extensions() -> Vec<String> {
    env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(ToString::to_string)
        .collect()
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

fn matches_google_login_selected_type(selected_type: &str) -> bool {
    GEMINI_GOOGLE_AUTH_TYPE_ALIASES.contains(&selected_type)
}

#[cfg(test)]
mod tests {
    use super::matches_google_login_selected_type;

    #[test]
    fn recognizes_supported_google_login_auth_aliases() {
        assert!(matches_google_login_selected_type("oauth-personal"));
        assert!(matches_google_login_selected_type("login_with_google"));
        assert!(matches_google_login_selected_type("google"));
        assert!(!matches_google_login_selected_type("gemini-api-key"));
    }
}
