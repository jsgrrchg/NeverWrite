use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use vault_ai_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, CLAUDE_RUNTIME_ID};

const SETUP_FILE_NAME: &str = "claude-setup.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClaudeSetupConfig {
    pub custom_binary_path: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub anthropic_custom_headers: Option<String>,
    pub anthropic_auth_token: Option<String>,
    pub auth_method: Option<String>,
    pub auth_invalidated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClaudeSetupInput {
    pub custom_binary_path: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub anthropic_custom_headers: Option<String>,
    pub anthropic_auth_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub program: Option<String>,
    pub args: Vec<String>,
    pub display: Option<String>,
    pub source: AiRuntimeBinarySource,
}

impl ClaudeSetupConfig {
    pub fn merge_input(mut self, input: ClaudeSetupInput) -> Self {
        if let Some(path) = input.custom_binary_path {
            self.custom_binary_path = normalize_optional_string(Some(path));
        }

        if let Some(value) = input.anthropic_base_url {
            self.anthropic_base_url = normalize_optional_string(Some(value));
            self.auth_method = None;
            self.auth_invalidated_at_ms = None;
        }

        if let Some(value) = input.anthropic_custom_headers {
            self.anthropic_custom_headers = normalize_optional_string(Some(value));
            self.auth_method = None;
            self.auth_invalidated_at_ms = None;
        }

        if let Some(value) = input.anthropic_auth_token {
            self.anthropic_auth_token = normalize_optional_string(Some(value));
            self.auth_method = None;
            self.auth_invalidated_at_ms = None;
        }

        self
    }
}

pub fn load_setup_config(app: &AppHandle) -> Result<ClaudeSetupConfig, String> {
    let path = setup_file_path(app)?;
    if !path.exists() {
        return Ok(ClaudeSetupConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

pub fn save_setup_config(
    app: &AppHandle,
    input: ClaudeSetupInput,
) -> Result<ClaudeSetupConfig, String> {
    let config = load_setup_config(app)?.merge_input(input);
    write_setup_config(app, &config)?;
    Ok(config)
}

pub fn mark_authenticated_method(
    app: &AppHandle,
    method_id: &str,
) -> Result<ClaudeSetupConfig, String> {
    let mut config = load_setup_config(app)?;
    config.auth_method = Some(method_id.to_string());
    config.auth_invalidated_at_ms = None;
    write_setup_config(app, &config)?;
    Ok(config)
}

pub fn clear_authenticated_method(app: &AppHandle) -> Result<ClaudeSetupConfig, String> {
    let mut config = load_setup_config(app)?;
    config.auth_method = None;
    config.auth_invalidated_at_ms = Some(current_time_millis());
    write_setup_config(app, &config)?;
    Ok(config)
}

pub fn clear_gateway_settings(app: &AppHandle) -> Result<ClaudeSetupConfig, String> {
    let mut config = load_setup_config(app)?;
    config.anthropic_base_url = None;
    config.anthropic_custom_headers = None;
    config.anthropic_auth_token = None;
    if config.auth_method.as_deref() == Some("gateway") {
        config.auth_method = None;
    }
    config.auth_invalidated_at_ms = None;
    write_setup_config(app, &config)?;
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

    // In debug builds prefer vendor JS (node) over the Bun-compiled binary.
    // Bun binaries are unreliable when spawned as child processes by Tauri.
    // Release builds use the compiled binary (signed inside the .app bundle).
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

pub fn apply_auth_env(command: &mut tokio::process::Command, config: &ClaudeSetupConfig) {
    if let Some(value) = config.anthropic_base_url.as_ref() {
        command.env("ANTHROPIC_BASE_URL", value);
        command.env(
            "ANTHROPIC_AUTH_TOKEN",
            config.anthropic_auth_token.as_deref().unwrap_or(""),
        );
    } else if let Some(value) = config.anthropic_auth_token.as_ref() {
        command.env("ANTHROPIC_AUTH_TOKEN", value);
    }

    if let Some(value) = config.anthropic_custom_headers.as_ref() {
        command.env("ANTHROPIC_CUSTOM_HEADERS", value);
    }
}

fn write_setup_config(app: &AppHandle, config: &ClaudeSetupConfig) -> Result<(), String> {
    let path = setup_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
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
    env::split_paths(&paths)
        .map(|path| path.join(program))
        .find(|path| path.exists() && path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_input_clears_gateway_auth_when_any_gateway_field_changes() {
        let config = ClaudeSetupConfig {
            anthropic_base_url: Some("https://gateway.example".to_string()),
            anthropic_custom_headers: Some("x-api-key: secret".to_string()),
            anthropic_auth_token: Some("token".to_string()),
            auth_method: Some("gateway".to_string()),
            auth_invalidated_at_ms: Some(10),
            ..ClaudeSetupConfig::default()
        };

        let merged = config.merge_input(ClaudeSetupInput {
            custom_binary_path: None,
            anthropic_base_url: None,
            anthropic_custom_headers: Some("x-api-key: rotated".to_string()),
            anthropic_auth_token: None,
        });

        assert_eq!(merged.auth_method, None);
        assert_eq!(merged.auth_invalidated_at_ms, None);
        assert_eq!(
            merged.anthropic_custom_headers.as_deref(),
            Some("x-api-key: rotated")
        );
    }

    #[test]
    fn merge_input_can_clear_gateway_values() {
        let config = ClaudeSetupConfig {
            anthropic_base_url: Some("https://gateway.example".to_string()),
            anthropic_custom_headers: Some("x-api-key: secret".to_string()),
            anthropic_auth_token: Some("token".to_string()),
            auth_method: Some("gateway".to_string()),
            ..ClaudeSetupConfig::default()
        };

        let merged = config.merge_input(ClaudeSetupInput {
            custom_binary_path: None,
            anthropic_base_url: Some(String::new()),
            anthropic_custom_headers: Some(String::new()),
            anthropic_auth_token: Some(String::new()),
        });

        assert_eq!(merged.anthropic_base_url, None);
        assert_eq!(merged.anthropic_custom_headers, None);
        assert_eq!(merged.anthropic_auth_token, None);
        assert_eq!(merged.auth_method, None);
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
        let vendor_path = std::env::temp_dir().join("vaultai-claude-test-vendor");
        fs::write(&bundled_path, "binary").expect("write bundled stub");

        let resolved = resolve_binary_command(&config, bundled_path.clone(), vendor_path);

        assert_eq!(resolved.program, Some(bundled_path.display().to_string()));
        assert_eq!(resolved.source, AiRuntimeBinarySource::Bundled);

        let _ = fs::remove_file(bundled_path);
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
    lines.push(String::new());

    fs::write(&script_path, lines.join("\n")).map_err(|error| error.to_string())?;
    let mut permissions = fs::metadata(&script_path)
        .map_err(|error| error.to_string())?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script_path, permissions).map_err(|error| error.to_string())?;
    Ok(script_path)
}

#[cfg(target_os = "windows")]
fn build_windows_login_script(
    command_parts: &[String],
    cwd: Option<&Path>,
) -> Result<PathBuf, String> {
    let script_path = temp_login_script_path("cmd");
    let quoted_command = command_parts
        .iter()
        .map(|part| windows_quote(part))
        .collect::<Vec<_>>()
        .join(" ");

    let mut lines = vec!["@echo off".to_string()];
    if let Some(cwd) = cwd {
        lines.push(format!(
            "cd /d {}",
            windows_quote(&cwd.display().to_string())
        ));
    }
    lines.push(quoted_command);
    lines.push(String::new());

    fs::write(&script_path, lines.join("\r\n")).map_err(|error| error.to_string())?;
    Ok(script_path)
}

fn temp_login_script_path(extension: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    env::temp_dir().join(format!("vaultai-claude-login-{suffix}.{extension}"))
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "windows")]
fn windows_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
