use std::path::PathBuf;

use neverwrite_ai::{AiRuntimeDescriptor, AiRuntimeOption, AiRuntimeSetupStatus, KILO_RUNTIME_ID};
use tauri::AppHandle;

use super::setup::{load_setup_config, resolve_binary_command, setup_status, KiloSetupConfig};

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct KiloProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub setup: KiloSetupConfig,
}

#[derive(Debug, Default)]
pub struct KiloRuntime;

impl KiloRuntime {
    pub fn descriptor(&self) -> AiRuntimeDescriptor {
        AiRuntimeDescriptor {
            runtime: AiRuntimeOption {
                id: KILO_RUNTIME_ID.to_string(),
                name: "Kilo".to_string(),
                description: "Kilo CLI running as a native ACP agent.".to_string(),
                capabilities: vec![
                    "attachments".to_string(),
                    "permissions".to_string(),
                    "plans".to_string(),
                ],
            },
            models: vec![],
            modes: vec![],
            config_options: vec![],
        }
    }

    pub fn setup_status(&self, app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
        setup_status(app)
    }

    pub fn resolved_binary(&self, app: &AppHandle) -> Result<super::setup::ResolvedBinary, String> {
        let setup = load_setup_config(app)?;
        Ok(resolve_binary_command(&setup))
    }

    pub fn process_spec(
        &self,
        app: &AppHandle,
        cwd: Option<PathBuf>,
    ) -> Result<KiloProcessSpec, String> {
        let setup = load_setup_config(app)?;
        let resolved = resolve_binary_command(&setup);
        let program = resolved
            .program
            .ok_or_else(|| "Kilo CLI is not configured.".to_string())?;

        let mut args = resolved.args;
        args.push("acp".to_string());

        Ok(KiloProcessSpec {
            program,
            args,
            cwd,
            setup,
        })
    }
}
