use std::path::PathBuf;

use tauri::AppHandle;
use vault_ai_ai::{AiRuntimeDescriptor, AiRuntimeOption, AiRuntimeSetupStatus, GEMINI_RUNTIME_ID};

use super::setup::{load_setup_config, resolve_binary_command, setup_status};

#[derive(Debug, Clone)]
pub struct GeminiProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub setup: super::setup::GeminiSetupConfig,
}

#[derive(Debug, Default)]
pub struct GeminiRuntime;

impl GeminiRuntime {
    pub fn descriptor(&self) -> AiRuntimeDescriptor {
        AiRuntimeDescriptor {
            runtime: AiRuntimeOption {
                id: GEMINI_RUNTIME_ID.to_string(),
                name: "Gemini ACP".to_string(),
                description: "Gemini CLI running as a native ACP agent.".to_string(),
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
    ) -> Result<GeminiProcessSpec, String> {
        let setup = load_setup_config(app)?;
        let resolved = resolve_binary_command(&setup);
        let program = resolved
            .program
            .ok_or_else(|| "Gemini CLI is not configured.".to_string())?;

        let mut args = resolved.args;
        args.push("--acp".to_string());

        Ok(GeminiProcessSpec {
            program,
            args,
            cwd,
            setup,
        })
    }
}
