use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use vault_ai_ai::{AiRuntimeDescriptor, AiRuntimeOption, AiRuntimeSetupStatus, CODEX_RUNTIME_ID};

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
                    "terminal_output".to_string(),
                ],
            },
            // Models, modes and config options are populated dynamically from the
            // ACP session at creation time.  Keeping these empty avoids showing
            // stale placeholder names in the UI before a session is established.
            models: vec![],
            modes: vec![],
            config_options: vec![],
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
}
