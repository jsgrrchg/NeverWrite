use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use vault_ai_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, CODEX_RUNTIME_ID};

const SETUP_FILE_NAME: &str = "setup.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodexSetupConfig {
    pub custom_binary_path: Option<String>,
    pub codex_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub auth_method: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CodexSetupInput {
    pub custom_binary_path: Option<String>,
    pub codex_api_key: Option<String>,
    pub openai_api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub path: Option<PathBuf>,
    pub source: AiRuntimeBinarySource,
}

impl CodexSetupConfig {
    pub fn merge_input(mut self, input: CodexSetupInput) -> Self {
        if let Some(path) = input.custom_binary_path {
            self.custom_binary_path = normalize_optional_string(Some(path));
        }

        if let Some(value) = input.codex_api_key {
            self.codex_api_key = normalize_optional_string(Some(value));
            if self.codex_api_key.is_some() {
                self.openai_api_key = None;
                self.auth_method = None;
            }
        }

        if let Some(value) = input.openai_api_key {
            self.openai_api_key = normalize_optional_string(Some(value));
            if self.openai_api_key.is_some() {
                self.codex_api_key = None;
                self.auth_method = None;
            }
        }

        self
    }
}

pub fn load_setup_config(app: &AppHandle) -> Result<CodexSetupConfig, String> {
    let path = setup_file_path(app)?;
    if !path.exists() {
        return Ok(CodexSetupConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

pub fn save_setup_config(
    app: &AppHandle,
    input: CodexSetupInput,
) -> Result<CodexSetupConfig, String> {
    let config = load_setup_config(app)?.merge_input(input);
    let path = setup_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())?;
    Ok(config)
}

pub fn mark_authenticated_method(
    app: &AppHandle,
    method_id: &str,
) -> Result<CodexSetupConfig, String> {
    let mut config = load_setup_config(app)?;
    config.auth_method = Some(method_id.to_string());
    let path = setup_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())?;
    Ok(config)
}

pub fn clear_authenticated_method(app: &AppHandle) -> Result<CodexSetupConfig, String> {
    let mut config = load_setup_config(app)?;
    config.auth_method = None;
    let path = setup_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())?;
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
    let auth_method = detect_auth_method(&config);
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
        onboarding_required: !binary_ready || !auth_ready,
        message,
    })
}

pub fn resolve_binary_path(
    config: &CodexSetupConfig,
    bundled_path: PathBuf,
    vendor_path: PathBuf,
) -> ResolvedBinary {
    if let Ok(path) = std::env::var("VAULTAI_CODEX_ACP_BIN") {
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

pub fn apply_auth_env(command: &mut tokio::process::Command, config: &CodexSetupConfig) {
    if let Some(value) = config.codex_api_key.as_ref() {
        command.env("CODEX_API_KEY", value);
    }

    if let Some(value) = config.openai_api_key.as_ref() {
        command.env("OPENAI_API_KEY", value);
    }
}

fn detect_auth_method(config: &CodexSetupConfig) -> Option<String> {
    if config.auth_method.as_deref() == Some("chatgpt") {
        return Some("chatgpt".to_string());
    }

    if config.auth_method.as_deref() == Some("codex-api-key")
        && (config
            .codex_api_key
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
            || std::env::var("CODEX_API_KEY")
                .ok()
                .is_some_and(|value| !value.trim().is_empty()))
    {
        return Some("codex-api-key".to_string());
    }

    if config.auth_method.as_deref() == Some("openai-api-key")
        && (config
            .openai_api_key
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
            || std::env::var("OPENAI_API_KEY")
                .ok()
                .is_some_and(|value| !value.trim().is_empty()))
    {
        return Some("openai-api-key".to_string());
    }

    if config
        .codex_api_key
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        || std::env::var("CODEX_API_KEY")
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Some("codex-api-key".to_string());
    }

    if config
        .openai_api_key
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        || std::env::var("OPENAI_API_KEY")
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Some("openai-api-key".to_string());
    }

    None
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
        description: "Use an OpenAI API key stored locally in VaultAI.".to_string(),
    });

    methods
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
