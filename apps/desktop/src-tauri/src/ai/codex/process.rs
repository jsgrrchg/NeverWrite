use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use vault_ai_ai::{
    AiConfigOption, AiConfigOptionCategory, AiConfigSelectOption, AiModeOption, AiModelOption,
    AiRuntimeDescriptor, AiRuntimeOption, AiRuntimeSetupStatus, CODEX_RUNTIME_ID,
};

use super::setup::{load_setup_config, resolve_binary_path, setup_status};

const CODEX_VENDOR_RELATIVE_PATH: &str = "../../../vendor/codex-acp";

#[derive(Debug, Clone)]
pub struct CodexProcessSpec {
    pub binary_path: PathBuf,
    pub home_dir: PathBuf,
    pub cwd: Option<PathBuf>,
    pub setup: super::setup::CodexSetupConfig,
}

#[derive(Debug, Default)]
pub struct CodexRuntime;

impl CodexRuntime {
    pub fn descriptor(&self) -> AiRuntimeDescriptor {
        AiRuntimeDescriptor {
            runtime: AiRuntimeOption {
                id: CODEX_RUNTIME_ID.to_string(),
                name: "Codex ACP".to_string(),
                description: "Codex runtime embedded as an ACP sidecar.".to_string(),
                capabilities: vec![
                    "attachments".to_string(),
                    "permissions".to_string(),
                    "reasoning".to_string(),
                ],
            },
            models: vec![
                AiModelOption {
                    id: "gpt-5-codex".to_string(),
                    runtime_id: CODEX_RUNTIME_ID.to_string(),
                    name: "GPT-5 Codex".to_string(),
                    description: "General-purpose coding and editing model.".to_string(),
                },
                AiModelOption {
                    id: "codex-mini".to_string(),
                    runtime_id: CODEX_RUNTIME_ID.to_string(),
                    name: "Codex Mini".to_string(),
                    description: "Faster runtime for lightweight iterations.".to_string(),
                },
            ],
            modes: vec![
                AiModeOption {
                    id: "default".to_string(),
                    runtime_id: CODEX_RUNTIME_ID.to_string(),
                    name: "Default".to_string(),
                    description: "Prompt for actions that need explicit approval.".to_string(),
                    disabled: false,
                },
                AiModeOption {
                    id: "acceptEdits".to_string(),
                    runtime_id: CODEX_RUNTIME_ID.to_string(),
                    name: "Accept Edits".to_string(),
                    description: "Approve edit operations automatically.".to_string(),
                    disabled: false,
                },
                AiModeOption {
                    id: "plan".to_string(),
                    runtime_id: CODEX_RUNTIME_ID.to_string(),
                    name: "Plan".to_string(),
                    description: "Reason first without executing tools.".to_string(),
                    disabled: false,
                },
                AiModeOption {
                    id: "bypassPermissions".to_string(),
                    runtime_id: CODEX_RUNTIME_ID.to_string(),
                    name: "Bypass Permissions".to_string(),
                    description: "Skip permission checks when supported.".to_string(),
                    disabled: true,
                },
            ],
            config_options: vec![AiConfigOption {
                id: "reasoning_effort".to_string(),
                runtime_id: CODEX_RUNTIME_ID.to_string(),
                category: AiConfigOptionCategory::Reasoning,
                label: "Reasoning Effort".to_string(),
                description: Some(
                    "Choose how much reasoning effort the runtime should use.".to_string(),
                ),
                kind: "select".to_string(),
                value: "medium".to_string(),
                options: vec![
                    AiConfigSelectOption {
                        value: "low".to_string(),
                        label: "Low".to_string(),
                        description: Some("Faster answers with lighter reasoning.".to_string()),
                    },
                    AiConfigSelectOption {
                        value: "medium".to_string(),
                        label: "Medium".to_string(),
                        description: Some("Balanced default.".to_string()),
                    },
                    AiConfigSelectOption {
                        value: "high".to_string(),
                        label: "High".to_string(),
                        description: Some("Deeper reasoning with higher latency.".to_string()),
                    },
                ],
            }],
        }
    }

    pub fn vendor_dir(&self) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(CODEX_VENDOR_RELATIVE_PATH)
    }

    pub fn vendor_binary_path(&self) -> PathBuf {
        let binary_name = if cfg!(target_os = "windows") {
            "codex-acp.exe"
        } else {
            "codex-acp"
        };

        self.vendor_dir()
            .join("target")
            .join(if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            })
            .join(binary_name)
    }

    pub fn bundled_binary_path(&self, app: &AppHandle) -> Result<PathBuf, String> {
        let binary_name = if cfg!(target_os = "windows") {
            "codex-acp.exe"
        } else {
            "codex-acp"
        };

        let resource_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));

        Ok(resource_dir.join("binaries").join(binary_name))
    }

    pub fn setup_status(&self, app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
        setup_status(
            app,
            self.bundled_binary_path(app)?,
            self.vendor_binary_path(),
        )
    }

    pub fn home_dir(&self, app: &AppHandle) -> Result<PathBuf, String> {
        let base = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;

        Ok(base.join("codex"))
    }

    pub fn process_spec(
        &self,
        app: &AppHandle,
        cwd: Option<PathBuf>,
    ) -> Result<CodexProcessSpec, String> {
        let setup = load_setup_config(app)?;
        let resolved = resolve_binary_path(
            &setup,
            self.bundled_binary_path(app)?,
            self.vendor_binary_path(),
        );

        Ok(CodexProcessSpec {
            binary_path: resolved
                .path
                .ok_or_else(|| "No Codex runtime binary is configured.".to_string())?,
            home_dir: self.home_dir(app)?,
            cwd,
            setup,
        })
    }

    pub fn supports_config_value(&self, option_id: &str, value: &str) -> bool {
        self.descriptor()
            .config_options
            .iter()
            .find(|option| option.id == option_id)
            .map(|option| {
                option
                    .options
                    .iter()
                    .any(|candidate| candidate.value == value)
            })
            .unwrap_or(false)
    }
}
