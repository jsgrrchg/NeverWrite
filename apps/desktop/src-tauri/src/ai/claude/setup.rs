use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use vault_ai_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, CLAUDE_RUNTIME_ID};

#[cfg(test)]
use crate::ai::secret_store::TestSecretStore;
use crate::ai::secret_store::{
    clear_secret, get_secret, set_secret, NormalizedSecretValuePatch, SecretValuePatch,
};

const SETUP_FILE_NAME: &str = "claude-setup.json";
const ANTHROPIC_CUSTOM_HEADERS_SECRET: &str = "anthropic_custom_headers";
const ANTHROPIC_AUTH_TOKEN_SECRET: &str = "anthropic_auth_token";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClaudeSetupConfig {
    pub custom_binary_path: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub auth_method: Option<String>,
    pub auth_invalidated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredClaudeSetupConfig {
    pub custom_binary_path: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub auth_method: Option<String>,
    pub auth_invalidated_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_custom_headers: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_auth_token: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeSecretBundle {
    pub anthropic_custom_headers: Option<String>,
    pub anthropic_auth_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClaudeSetupInput {
    pub custom_binary_path: Option<String>,
    pub anthropic_base_url: Option<String>,
    #[serde(default)]
    pub anthropic_custom_headers: SecretValuePatch,
    #[serde(default)]
    pub anthropic_auth_token: SecretValuePatch,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub program: Option<String>,
    pub args: Vec<String>,
    pub display: Option<String>,
    pub source: AiRuntimeBinarySource,
}

impl ClaudeSetupConfig {
    fn apply_input(&mut self, input: &ClaudeSetupInput) {
        if let Some(path) = input.custom_binary_path.as_ref() {
            self.custom_binary_path = normalize_optional_string(Some(path.clone()));
        }

        if let Some(value) = input.anthropic_base_url.as_ref() {
            self.anthropic_base_url = normalize_optional_string(Some(value.clone()));
        }

        if input.anthropic_base_url.is_some()
            || !input.anthropic_custom_headers.is_unchanged()
            || !input.anthropic_auth_token.is_unchanged()
        {
            self.auth_method = None;
            self.auth_invalidated_at_ms = None;
        }
    }
}

impl From<StoredClaudeSetupConfig> for ClaudeSetupConfig {
    fn from(value: StoredClaudeSetupConfig) -> Self {
        Self {
            custom_binary_path: value.custom_binary_path,
            anthropic_base_url: value.anthropic_base_url,
            auth_method: value.auth_method,
            auth_invalidated_at_ms: value.auth_invalidated_at_ms,
        }
    }
}

impl StoredClaudeSetupConfig {
    fn from_public(config: &ClaudeSetupConfig) -> Self {
        Self {
            custom_binary_path: config.custom_binary_path.clone(),
            anthropic_base_url: config.anthropic_base_url.clone(),
            auth_method: config.auth_method.clone(),
            auth_invalidated_at_ms: config.auth_invalidated_at_ms,
            anthropic_custom_headers: None,
            anthropic_auth_token: None,
        }
    }

    fn has_legacy_secrets(&self) -> bool {
        self.anthropic_custom_headers.is_some() || self.anthropic_auth_token.is_some()
    }
}

pub fn load_setup_config(app: &AppHandle) -> Result<ClaudeSetupConfig, String> {
    let path = setup_file_path(app)?;
    load_setup_config_from_path(&path)
}

pub fn load_secret_bundle(_app: &AppHandle) -> Result<ClaudeSecretBundle, String> {
    Ok(ClaudeSecretBundle {
        anthropic_custom_headers: get_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_CUSTOM_HEADERS_SECRET)?,
        anthropic_auth_token: get_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_AUTH_TOKEN_SECRET)?,
    })
}

pub fn save_setup_config(
    app: &AppHandle,
    input: ClaudeSetupInput,
) -> Result<ClaudeSetupConfig, String> {
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
) -> Result<ClaudeSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_method = Some(method_id.to_string());
    config.auth_invalidated_at_ms = None;
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn clear_authenticated_method(app: &AppHandle) -> Result<ClaudeSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_method = None;
    config.auth_invalidated_at_ms = Some(current_time_millis());
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn clear_gateway_settings(app: &AppHandle) -> Result<ClaudeSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.anthropic_base_url = None;
    if config.auth_method.as_deref() == Some("gateway") {
        config.auth_method = None;
    }
    config.auth_invalidated_at_ms = None;
    clear_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_CUSTOM_HEADERS_SECRET)?;
    clear_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_AUTH_TOKEN_SECRET)?;
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn setup_status(
    app: &AppHandle,
    bundled_path: PathBuf,
    bundled_node_path: PathBuf,
    bundled_vendor_path: PathBuf,
    vendor_path: PathBuf,
) -> Result<AiRuntimeSetupStatus, String> {
    let config = load_setup_config(app)?;
    let resolved = resolve_binary_command(
        &config,
        bundled_path.clone(),
        bundled_node_path,
        bundled_vendor_path,
        vendor_path,
    );
    let auth_methods = available_auth_methods();
    let auth_method = detect_auth_method(&config);
    let binary_ready = resolved.program.is_some();
    let auth_ready = auth_method.is_some();
    let has_custom_binary_path = config.custom_binary_path.is_some();
    let has_gateway_config = gateway_is_configured(&config);

    let message = if !binary_ready {
        Some(
            "Claude runtime was not found. Install claude-agent-acp, ship a bundled binary, or provide a custom runtime path.".to_string(),
        )
    } else if !auth_ready {
        Some("Log in with Claude or configure a custom gateway to finish setup.".to_string())
    } else if auth_method.as_deref() == Some("gateway") {
        Some("Claude gateway setup is ready.".to_string())
    } else {
        None
    };

    Ok(AiRuntimeSetupStatus {
        runtime_id: CLAUDE_RUNTIME_ID.to_string(),
        binary_ready,
        binary_path: resolved.display,
        binary_source: if binary_ready {
            resolved.source
        } else {
            AiRuntimeBinarySource::Missing
        },
        has_custom_binary_path,
        auth_ready,
        auth_method,
        auth_methods,
        has_gateway_config,
        onboarding_required: !binary_ready || !auth_ready,
        message,
    })
}

pub fn resolve_binary_command(
    config: &ClaudeSetupConfig,
    bundled_path: PathBuf,
    bundled_node_path: PathBuf,
    bundled_vendor_path: PathBuf,
    vendor_path: PathBuf,
) -> ResolvedBinary {
    if let Ok(raw) = env::var("VAULTAI_CLAUDE_ACP_BIN") {
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

    if cfg!(debug_assertions) && vendor_path.exists() {
        return command_from_existing_path(vendor_path, AiRuntimeBinarySource::Vendor);
    }

    if bundled_node_path.exists() && bundled_vendor_path.exists() {
        return command_from_embedded_node(
            bundled_node_path,
            bundled_vendor_path,
            AiRuntimeBinarySource::Bundled,
        );
    }

    if bundled_path.exists() {
        return command_from_existing_path(bundled_path, AiRuntimeBinarySource::Bundled);
    }

    if vendor_path.exists() {
        return command_from_existing_path(vendor_path, AiRuntimeBinarySource::Vendor);
    }

    if let Some(path) = find_program("claude-agent-acp") {
        return command_from_existing_path(path, AiRuntimeBinarySource::Env);
    }

    ResolvedBinary {
        program: None,
        args: Vec::new(),
        display: Some(bundled_path.display().to_string()),
        source: AiRuntimeBinarySource::Bundled,
    }
}

fn command_from_embedded_node(
    node_path: PathBuf,
    entry_path: PathBuf,
    source: AiRuntimeBinarySource,
) -> ResolvedBinary {
    ResolvedBinary {
        program: Some(node_path.display().to_string()),
        args: vec![entry_path.display().to_string()],
        display: Some(format!("{} {}", node_path.display(), entry_path.display())),
        source,
    }
}

pub fn launch_claude_login(resolved: &ResolvedBinary, cwd: Option<&Path>) -> Result<(), String> {
    let program = resolved
        .program
        .as_deref()
        .ok_or_else(|| "Claude runtime binary is not configured.".to_string())?;

    let mut command_parts = Vec::with_capacity(resolved.args.len() + 2);
    command_parts.push(program.to_string());
    command_parts.extend(resolved.args.iter().cloned());
    command_parts.push("--cli".to_string());

    #[cfg(target_os = "windows")]
    {
        let script_path = build_windows_login_script(&command_parts, cwd)?;
        Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K"])
            .arg(script_path.as_os_str())
            .spawn()
            .map_err(|error| format!("Failed to open a terminal for Claude login: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let script_path = build_posix_login_script("command", &command_parts, cwd)?;
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&script_path)
            .spawn()
            .map_err(|error| format!("Failed to open Terminal for Claude login: {error}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let script_path = build_posix_login_script("sh", &command_parts, cwd)?;
        let candidates = [
            (
                "x-terminal-emulator",
                vec!["-e".to_string(), script_path.display().to_string()],
            ),
            (
                "gnome-terminal",
                vec![
                    "--".to_string(),
                    "bash".to_string(),
                    script_path.display().to_string(),
                ],
            ),
            (
                "konsole",
                vec![
                    "-e".to_string(),
                    "bash".to_string(),
                    script_path.display().to_string(),
                ],
            ),
            (
                "xterm",
                vec![
                    "-e".to_string(),
                    "bash".to_string(),
                    script_path.display().to_string(),
                ],
            ),
        ];

        for (program_name, args) in candidates {
            if let Some(path) = find_program(program_name) {
                Command::new(path).args(args).spawn().map_err(|error| {
                    format!("Failed to open a terminal for Claude login: {error}")
                })?;
                return Ok(());
            }
        }

        return Err("No compatible terminal launcher was found for Claude login.".to_string());
    }

    #[allow(unreachable_code)]
    Err("Claude login is not supported on this platform yet.".to_string())
}

pub fn apply_auth_env(
    command: &mut tokio::process::Command,
    app: &AppHandle,
    config: &ClaudeSetupConfig,
) -> Result<(), String> {
    let secrets = load_secret_bundle(app)?;
    let external_token_present = env_secret_present("ANTHROPIC_AUTH_TOKEN");
    let external_headers_present = env_secret_present("ANTHROPIC_CUSTOM_HEADERS");

    if let Some(value) = config.anthropic_base_url.as_ref() {
        command.env("ANTHROPIC_BASE_URL", value);
        if let Some(token) = secrets.anthropic_auth_token.as_ref() {
            if !external_token_present {
                command.env("ANTHROPIC_AUTH_TOKEN", token);
            }
        } else if !external_token_present {
            command.env("ANTHROPIC_AUTH_TOKEN", "");
        }
    } else if !external_token_present {
        if let Some(token) = secrets.anthropic_auth_token.as_ref() {
            command.env("ANTHROPIC_AUTH_TOKEN", token);
        }
    }

    if !external_headers_present {
        if let Some(value) = secrets.anthropic_custom_headers.as_ref() {
            command.env("ANTHROPIC_CUSTOM_HEADERS", value);
        }
    }

    Ok(())
}

fn detect_auth_method(config: &ClaudeSetupConfig) -> Option<String> {
    if config.auth_method.as_deref() == Some("gateway") && gateway_is_configured(config) {
        return Some("gateway".to_string());
    }

    if config.auth_method.as_deref() == Some("claude-login") && claude_login_available(config) {
        return Some("claude-login".to_string());
    }

    if claude_login_available(config) {
        return Some("claude-login".to_string());
    }

    None
}

fn available_auth_methods() -> Vec<AiAuthMethod> {
    vec![
        AiAuthMethod {
            id: "claude-login".to_string(),
            name: "Claude login".to_string(),
            description: "Open a terminal-based Claude login flow.".to_string(),
        },
        AiAuthMethod {
            id: "gateway".to_string(),
            name: "Custom gateway".to_string(),
            description: "Use a custom Anthropic-compatible gateway just for VaultAI.".to_string(),
        },
    ]
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

fn gateway_is_configured(config: &ClaudeSetupConfig) -> bool {
    config
        .anthropic_base_url
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
}

fn claude_login_available(config: &ClaudeSetupConfig) -> bool {
    let Some(auth_path) = claude_auth_file_path() else {
        return false;
    };

    if !auth_path.exists() {
        return false;
    }

    let Some(invalidated_at_ms) = config.auth_invalidated_at_ms else {
        return true;
    };

    file_modified_at_ms(&auth_path)
        .map(|modified_at_ms| modified_at_ms > invalidated_at_ms)
        .unwrap_or(false)
}

fn claude_auth_file_path() -> Option<PathBuf> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(home_dir_fallback);
    let Some(home_dir) = home else {
        return None;
    };

    Some(home_dir.join(".claude.json"))
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

fn setup_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(base.join("ai").join(SETUP_FILE_NAME))
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

fn load_setup_config_from_path(path: &Path) -> Result<ClaudeSetupConfig, String> {
    let stored = load_stored_setup_config(path)?;
    if stored.has_legacy_secrets() {
        migrate_legacy_secrets(path, &stored)?;
    }
    Ok(stored.into())
}

fn load_stored_setup_config(path: &Path) -> Result<StoredClaudeSetupConfig, String> {
    if !path.exists() {
        return Ok(StoredClaudeSetupConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn migrate_legacy_secrets(path: &Path, stored: &StoredClaudeSetupConfig) -> Result<(), String> {
    if let Some(value) = normalize_optional_string(stored.anthropic_custom_headers.clone()) {
        set_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_CUSTOM_HEADERS_SECRET, &value)?;
    }

    if let Some(value) = normalize_optional_string(stored.anthropic_auth_token.clone()) {
        set_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_AUTH_TOKEN_SECRET, &value)?;
    }

    let sanitized: ClaudeSetupConfig = stored.clone().into();
    write_setup_config_to_path(path, &sanitized)
}

fn write_setup_config_to_path(path: &Path, config: &ClaudeSetupConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(&StoredClaudeSetupConfig::from_public(config))
        .map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn apply_secret_patches(input: &ClaudeSetupInput) -> Result<(), String> {
    match input.anthropic_custom_headers.normalize() {
        NormalizedSecretValuePatch::Unchanged => {}
        NormalizedSecretValuePatch::Clear => {
            clear_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_CUSTOM_HEADERS_SECRET)?;
        }
        NormalizedSecretValuePatch::Set(value) => {
            set_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_CUSTOM_HEADERS_SECRET, &value)?;
        }
    }

    match input.anthropic_auth_token.normalize() {
        NormalizedSecretValuePatch::Unchanged => {}
        NormalizedSecretValuePatch::Clear => {
            clear_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_AUTH_TOKEN_SECRET)?;
        }
        NormalizedSecretValuePatch::Set(value) => {
            set_secret(CLAUDE_RUNTIME_ID, ANTHROPIC_AUTH_TOKEN_SECRET, &value)?;
        }
    }

    Ok(())
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
            "vaultai-claude-setup-tests-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir.join(SETUP_FILE_NAME)
    }

    #[test]
    fn save_gateway_input_clears_gateway_auth_metadata() {
        let mut config = ClaudeSetupConfig {
            anthropic_base_url: Some("https://gateway.example".to_string()),
            auth_method: Some("gateway".to_string()),
            auth_invalidated_at_ms: Some(10),
            ..ClaudeSetupConfig::default()
        };

        config.apply_input(&ClaudeSetupInput {
            custom_binary_path: None,
            anthropic_base_url: None,
            anthropic_custom_headers: SecretValuePatch::Set {
                value: "x-api-key: rotated".to_string(),
            },
            anthropic_auth_token: SecretValuePatch::Unchanged,
        });

        assert_eq!(config.auth_method, None);
        assert_eq!(config.auth_invalidated_at_ms, None);
    }

    #[test]
    fn gateway_clear_removes_base_url_and_secret_patches() {
        let mut config = ClaudeSetupConfig {
            anthropic_base_url: Some("https://gateway.example".to_string()),
            auth_method: Some("gateway".to_string()),
            ..ClaudeSetupConfig::default()
        };

        config.apply_input(&ClaudeSetupInput {
            custom_binary_path: None,
            anthropic_base_url: Some(String::new()),
            anthropic_custom_headers: SecretValuePatch::Clear,
            anthropic_auth_token: SecretValuePatch::Clear,
        });

        assert_eq!(config.anthropic_base_url, None);
        assert_eq!(config.auth_method, None);
    }

    #[test]
    fn migrate_legacy_json_secrets_into_secure_store() {
        let _guard = test_lock().lock().unwrap();
        let path = temp_setup_path("migrate");
        let store = Arc::new(TestSecretStore::default());
        store.install();

        let legacy = serde_json::json!({
            "anthropic_base_url": "https://gateway.example",
            "anthropic_custom_headers": "x-api-key: secret",
            "anthropic_auth_token": "token"
        });
        fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let loaded = load_setup_config_from_path(&path).expect("load config");
        let raw = fs::read_to_string(&path).expect("read sanitized setup");

        assert_eq!(
            loaded.anthropic_base_url.as_deref(),
            Some("https://gateway.example")
        );
        assert_eq!(
            store
                .get_value(CLAUDE_RUNTIME_ID, ANTHROPIC_CUSTOM_HEADERS_SECRET)
                .as_deref(),
            Some("x-api-key: secret")
        );
        assert_eq!(
            store
                .get_value(CLAUDE_RUNTIME_ID, ANTHROPIC_AUTH_TOKEN_SECRET)
                .as_deref(),
            Some("token")
        );
        assert!(!raw.contains("anthropic_custom_headers"));
        assert!(!raw.contains("anthropic_auth_token"));

        TestSecretStore::uninstall();
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detect_auth_method_does_not_auto_promote_gateway() {
        let config = ClaudeSetupConfig {
            anthropic_base_url: Some("https://gateway.example".to_string()),
            ..ClaudeSetupConfig::default()
        };

        assert_ne!(detect_auth_method(&config).as_deref(), Some("gateway"));
    }

    #[test]
    fn resolve_binary_command_falls_back_when_custom_path_is_missing() {
        let config = ClaudeSetupConfig {
            custom_binary_path: Some("/missing/claude-agent-acp".to_string()),
            ..ClaudeSetupConfig::default()
        };
        let bundled_path = std::env::temp_dir().join("vaultai-claude-test-bundled");
        let bundled_node_path = std::env::temp_dir().join("vaultai-claude-test-bundled-node");
        let bundled_vendor_path = std::env::temp_dir().join("vaultai-claude-test-bundled-vendor");
        let vendor_path = std::env::temp_dir().join("vaultai-claude-test-vendor");
        fs::write(&bundled_path, "binary").expect("write bundled stub");

        let resolved = resolve_binary_command(
            &config,
            bundled_path.clone(),
            bundled_node_path,
            bundled_vendor_path,
            vendor_path,
        );

        assert_eq!(resolved.program, Some(bundled_path.display().to_string()));
        assert_eq!(resolved.source, AiRuntimeBinarySource::Bundled);

        let _ = fs::remove_file(bundled_path);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn find_program_resolves_exe_from_pathext() {
        use std::sync::Mutex;

        static ENV_LOCK: Mutex<()> = Mutex::new(());

        let _guard = ENV_LOCK.lock().unwrap();
        let temp_dir = env::temp_dir().join(format!(
            "vaultai-claude-find-program-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let node_path = temp_dir.join("node.exe");
        fs::write(&node_path, b"test").unwrap();

        let original_path = env::var_os("PATH");
        let original_pathext = env::var_os("PATHEXT");
        env::set_var("PATH", &temp_dir);
        env::set_var("PATHEXT", ".EXE;.CMD");

        let resolved = find_program("node");

        if let Some(value) = original_path {
            env::set_var("PATH", value);
        } else {
            env::remove_var("PATH");
        }

        if let Some(value) = original_pathext {
            env::set_var("PATHEXT", value);
        } else {
            env::remove_var("PATHEXT");
        }

        let _ = fs::remove_dir_all(&temp_dir);
        assert_eq!(resolved.as_deref(), Some(node_path.as_path()));
    }
}

#[cfg(unix)]
fn build_posix_login_script(
    extension: &str,
    command_parts: &[String],
    cwd: Option<&Path>,
) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let script_path = temp_login_script_path(extension);
    let quoted_command = command_parts
        .iter()
        .map(|part| shell_quote(part))
        .collect::<Vec<_>>()
        .join(" ");

    let mut lines = vec!["#!/bin/sh".to_string()];
    if let Some(cwd) = cwd {
        lines.push(format!("cd {}", shell_quote(&cwd.display().to_string())));
    }
    lines.push(format!("exec {quoted_command}"));

    fs::write(&script_path, lines.join("\n")).map_err(|error| error.to_string())?;
    let mut permissions = fs::metadata(&script_path)
        .map_err(|error| error.to_string())?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script_path, permissions).map_err(|error| error.to_string())?;
    Ok(script_path)
}

#[cfg(windows)]
fn build_windows_login_script(
    command_parts: &[String],
    cwd: Option<&Path>,
) -> Result<PathBuf, String> {
    let script_path = temp_login_script_path("cmd");
    let mut lines = vec!["@echo off".to_string()];
    if let Some(cwd) = cwd {
        lines.push(format!(
            "cd /d {}",
            windows_quote(&cwd.display().to_string())
        ));
    }
    let command = command_parts
        .iter()
        .map(|part| windows_quote(part))
        .collect::<Vec<_>>()
        .join(" ");
    lines.push(command);
    lines.push("echo.".to_string());
    lines.push("echo Press any key to close this window...".to_string());
    lines.push("pause > nul".to_string());
    fs::write(&script_path, lines.join("\r\n")).map_err(|error| error.to_string())?;
    Ok(script_path)
}

fn temp_login_script_path(extension: &str) -> PathBuf {
    let suffix = format!(
        "vaultai-claude-login-{}-{}.{}",
        std::process::id(),
        current_time_millis(),
        extension
    );
    env::temp_dir().join(suffix)
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(windows)]
fn windows_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}
