use std::{
    env, fs,
    net::IpAddr,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use neverwrite_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, CLAUDE_RUNTIME_ID};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::ai::env::find_program_on_preferred_path;
#[cfg(test)]
use crate::ai::secret_store::TestSecretStore;
use crate::ai::secret_store::{
    clear_secret, get_secret, set_secret, NormalizedSecretValuePatch, SecretValuePatch,
};
use crate::branding::APP_BRAND_NAME;
use crate::technical_branding::{app_data_dir, CLAUDE_ACP_BIN_ENV_VARS};

const SETUP_FILE_NAME: &str = "claude-setup.json";
const ANTHROPIC_CUSTOM_HEADERS_SECRET: &str = "anthropic_custom_headers";
const ANTHROPIC_AUTH_TOKEN_SECRET: &str = "anthropic_auth_token";
const INVALID_GATEWAY_URL_MESSAGE: &str = "Enter a valid gateway URL.";
const GATEWAY_HTTPS_REQUIRED_MESSAGE: &str = "Gateway URL must use HTTPS.";
const GATEWAY_LOCAL_HTTP_ONLY_MESSAGE: &str = "HTTP gateways are only allowed for localhost.";
const GATEWAY_EMBEDDED_CREDENTIALS_MESSAGE: &str =
    "Gateway URL must not include embedded credentials.";
const GATEWAY_URL_REQUIRED_MESSAGE: &str =
    "Enter a gateway base URL before continuing with gateway authentication.";
const CLAUDE_AI_LOGIN_METHOD_ID: &str = "claude-ai-login";
const CLAUDE_LOGIN_LEGACY_METHOD_ID: &str = "claude-login";
const CONSOLE_LOGIN_METHOD_ID: &str = "console-login";

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedClaudeGatewayUrl(String);

impl ValidatedClaudeGatewayUrl {
    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
struct GatewayEnvPolicy {
    managed_base_url: Option<ValidatedClaudeGatewayUrl>,
    allow_secret_bundle: bool,
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
    if input.anthropic_base_url.is_some() {
        validate_gateway_configured(&config)?;
    }
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
    if method_id == "gateway" {
        validate_gateway_configured(&config)?;
    }
    config.auth_method = Some(
        normalize_claude_auth_method_id(method_id)
            .unwrap_or(method_id)
            .to_string(),
    );
    config.auth_invalidated_at_ms = None;
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn set_preferred_auth_method(
    app: &AppHandle,
    method_id: &str,
) -> Result<ClaudeSetupConfig, String> {
    let normalized = normalize_claude_auth_method_id(method_id)
        .ok_or_else(|| format!("Unsupported Claude auth method: {method_id}"))?;
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_method = Some(normalized.to_string());
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
    let gateway_issue = gateway_validation_error(&config);
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
    let has_gateway_url = config.anthropic_base_url.is_some();
    let has_gateway_config = gateway_issue.is_none() && gateway_is_configured(&config);

    let message = if !binary_ready {
        Some(
            "Claude runtime was not found. Install claude-agent-acp, ship a bundled binary, or provide a custom runtime path.".to_string(),
        )
    } else if !auth_ready && gateway_issue.is_some() {
        gateway_issue
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
        has_gateway_url,
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
    if let Some(raw) = read_env_override(&CLAUDE_ACP_BIN_ENV_VARS) {
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

pub fn launch_claude_login(
    resolved: &ResolvedBinary,
    cwd: Option<&Path>,
    method_id: &str,
) -> Result<(), String> {
    let program = resolved
        .program
        .as_deref()
        .ok_or_else(|| "Claude runtime binary is not configured.".to_string())?;

    let login_args = claude_login_args(method_id)?;
    let mut command_parts = Vec::with_capacity(resolved.args.len() + 1 + login_args.len());
    command_parts.push(program.to_string());
    command_parts.extend(resolved.args.iter().cloned());
    command_parts.extend(login_args.iter().copied().map(str::to_string));

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
    let external_base_url_present = env_secret_present("ANTHROPIC_BASE_URL");
    let policy = gateway_env_policy(config, external_base_url_present);

    if let Some(value) = policy.managed_base_url.as_ref() {
        command.env("ANTHROPIC_BASE_URL", value.as_str());
        if let Some(token) = secrets.anthropic_auth_token.as_ref() {
            if !external_token_present {
                command.env("ANTHROPIC_AUTH_TOKEN", token);
            }
        } else if !external_token_present {
            command.env("ANTHROPIC_AUTH_TOKEN", "");
        }
    } else if policy.allow_secret_bundle && !external_token_present {
        if let Some(token) = secrets.anthropic_auth_token.as_ref() {
            command.env("ANTHROPIC_AUTH_TOKEN", token);
        }
    } else if !external_token_present && !external_base_url_present {
        command.env_remove("ANTHROPIC_AUTH_TOKEN");
    }

    if !external_headers_present && policy.allow_secret_bundle {
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

    if let Some(method_id) = config
        .auth_method
        .as_deref()
        .and_then(normalize_claude_auth_method_id)
        .filter(|_| claude_login_available(config))
    {
        return Some(method_id.to_string());
    }

    if claude_login_available(config) {
        return Some(CLAUDE_AI_LOGIN_METHOD_ID.to_string());
    }

    None
}

fn available_auth_methods() -> Vec<AiAuthMethod> {
    vec![
        AiAuthMethod {
            id: CLAUDE_AI_LOGIN_METHOD_ID.to_string(),
            name: "Claude subscription".to_string(),
            description: "Open a terminal-based Claude subscription login flow.".to_string(),
        },
        AiAuthMethod {
            id: CONSOLE_LOGIN_METHOD_ID.to_string(),
            name: "Anthropic Console".to_string(),
            description: "Open a terminal-based Anthropic Console login flow.".to_string(),
        },
        AiAuthMethod {
            id: "gateway".to_string(),
            name: "Custom gateway".to_string(),
            description: format!(
                "Use a custom Anthropic-compatible gateway just for {}.",
                APP_BRAND_NAME
            ),
        },
    ]
}

fn normalize_claude_auth_method_id(method_id: &str) -> Option<&'static str> {
    match method_id {
        CLAUDE_LOGIN_LEGACY_METHOD_ID | CLAUDE_AI_LOGIN_METHOD_ID => {
            Some(CLAUDE_AI_LOGIN_METHOD_ID)
        }
        CONSOLE_LOGIN_METHOD_ID => Some(CONSOLE_LOGIN_METHOD_ID),
        _ => None,
    }
}

fn claude_login_args(method_id: &str) -> Result<&'static [&'static str], String> {
    match normalize_claude_auth_method_id(method_id) {
        Some(CLAUDE_AI_LOGIN_METHOD_ID) => Ok(&["--cli", "auth", "login", "--claudeai"]),
        Some(CONSOLE_LOGIN_METHOD_ID) => Ok(&["--cli", "auth", "login", "--console"]),
        _ => Err(format!("Unsupported Claude auth method: {method_id}")),
    }
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
    matches!(validated_gateway_url(config), Ok(Some(_)))
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
    let base = app_data_dir(app)?;
    Ok(base.join("ai").join(SETUP_FILE_NAME))
}

fn read_env_override(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| env::var(key).ok())
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

fn is_js_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("js" | "mjs" | "cjs")
    )
}

fn find_program(program: &str) -> Option<PathBuf> {
    find_program_on_preferred_path(program)
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

fn validate_gateway_configured(
    config: &ClaudeSetupConfig,
) -> Result<ValidatedClaudeGatewayUrl, String> {
    match validated_gateway_url(config)? {
        Some(value) => Ok(value),
        None => Err(GATEWAY_URL_REQUIRED_MESSAGE.to_string()),
    }
}

fn gateway_validation_error(config: &ClaudeSetupConfig) -> Option<String> {
    match validated_gateway_url(config) {
        Ok(_) => None,
        Err(error) => Some(error),
    }
}

fn validated_gateway_url(
    config: &ClaudeSetupConfig,
) -> Result<Option<ValidatedClaudeGatewayUrl>, String> {
    config
        .anthropic_base_url
        .as_deref()
        .map(validate_claude_gateway_base_url)
        .transpose()
}

fn validate_claude_gateway_base_url(raw: &str) -> Result<ValidatedClaudeGatewayUrl, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GATEWAY_URL_REQUIRED_MESSAGE.to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|_| INVALID_GATEWAY_URL_MESSAGE.to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| INVALID_GATEWAY_URL_MESSAGE.to_string())?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(GATEWAY_EMBEDDED_CREDENTIALS_MESSAGE.to_string());
    }

    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback_gateway_host(host) => {}
        "http" => return Err(GATEWAY_LOCAL_HTTP_ONLY_MESSAGE.to_string()),
        _ => return Err(GATEWAY_HTTPS_REQUIRED_MESSAGE.to_string()),
    }

    Ok(ValidatedClaudeGatewayUrl(trimmed.to_string()))
}

fn is_loopback_gateway_host(host: &str) -> bool {
    let normalized = host
        .trim_matches(|ch| ch == '[' || ch == ']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized == "localhost" || normalized.ends_with(".localhost") {
        return true;
    }

    normalized
        .parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn gateway_env_policy(
    config: &ClaudeSetupConfig,
    external_base_url_present: bool,
) -> GatewayEnvPolicy {
    let managed_base_url = validated_gateway_url(config).ok().flatten();
    let invalid_managed_gateway = config.anthropic_base_url.is_some() && managed_base_url.is_none();

    GatewayEnvPolicy {
        managed_base_url,
        allow_secret_bundle: !invalid_managed_gateway || external_base_url_present,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::secret_store::test_lock;
    use std::{env, sync::Arc};

    fn temp_setup_path(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "neverwrite-claude-setup-tests-{}-{}",
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
    fn normalize_claude_auth_method_maps_legacy_id() {
        assert_eq!(
            normalize_claude_auth_method_id("claude-login"),
            Some(CLAUDE_AI_LOGIN_METHOD_ID)
        );
        assert_eq!(
            normalize_claude_auth_method_id(CLAUDE_AI_LOGIN_METHOD_ID),
            Some(CLAUDE_AI_LOGIN_METHOD_ID)
        );
        assert_eq!(
            normalize_claude_auth_method_id(CONSOLE_LOGIN_METHOD_ID),
            Some(CONSOLE_LOGIN_METHOD_ID)
        );
    }

    #[test]
    fn claude_login_args_match_selected_terminal_auth() {
        assert_eq!(
            claude_login_args(CLAUDE_LOGIN_LEGACY_METHOD_ID).unwrap(),
            ["--cli", "auth", "login", "--claudeai"]
        );
        assert_eq!(
            claude_login_args(CONSOLE_LOGIN_METHOD_ID).unwrap(),
            ["--cli", "auth", "login", "--console"]
        );
    }

    #[test]
    fn validate_claude_gateway_base_url_allows_https() {
        assert_eq!(
            validate_claude_gateway_base_url("https://gateway.example/v1")
                .unwrap()
                .as_str(),
            "https://gateway.example/v1"
        );
    }

    #[test]
    fn validate_claude_gateway_base_url_allows_loopback_http() {
        for value in [
            "http://localhost:3000",
            "http://api.localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(validate_claude_gateway_base_url(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn validate_claude_gateway_base_url_rejects_remote_http() {
        assert_eq!(
            validate_claude_gateway_base_url("http://gateway.example").unwrap_err(),
            GATEWAY_LOCAL_HTTP_ONLY_MESSAGE
        );
    }

    #[test]
    fn validate_claude_gateway_base_url_rejects_non_https_schemes() {
        assert_eq!(
            validate_claude_gateway_base_url("ftp://gateway.example").unwrap_err(),
            GATEWAY_HTTPS_REQUIRED_MESSAGE
        );
    }

    #[test]
    fn validate_claude_gateway_base_url_rejects_embedded_credentials() {
        assert_eq!(
            validate_claude_gateway_base_url("https://user:pass@gateway.example").unwrap_err(),
            GATEWAY_EMBEDDED_CREDENTIALS_MESSAGE
        );
    }

    #[test]
    fn gateway_is_configured_requires_permitted_url() {
        let config = ClaudeSetupConfig {
            anthropic_base_url: Some("http://gateway.example".to_string()),
            ..ClaudeSetupConfig::default()
        };

        assert!(!gateway_is_configured(&config));
    }

    #[test]
    fn gateway_env_policy_blocks_secret_bundle_for_invalid_managed_gateway() {
        let config = ClaudeSetupConfig {
            anthropic_base_url: Some("http://gateway.example".to_string()),
            ..ClaudeSetupConfig::default()
        };
        let policy = gateway_env_policy(&config, false);

        assert!(policy.managed_base_url.is_none());
        assert!(!policy.allow_secret_bundle);
    }

    #[test]
    fn resolve_binary_command_falls_back_when_custom_path_is_missing() {
        let config = ClaudeSetupConfig {
            custom_binary_path: Some("/missing/claude-agent-acp".to_string()),
            ..ClaudeSetupConfig::default()
        };
        let bundled_path = std::env::temp_dir().join("neverwrite-claude-test-bundled");
        let bundled_node_path = std::env::temp_dir().join("neverwrite-claude-test-bundled-node");
        let bundled_vendor_path =
            std::env::temp_dir().join("neverwrite-claude-test-bundled-vendor");
        let vendor_path = std::env::temp_dir().join("neverwrite-claude-test-vendor");
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
            "neverwrite-claude-find-program-{}",
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
        "neverwrite-claude-login-{}-{}.{}",
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
