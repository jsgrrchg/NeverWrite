use std::path::PathBuf;

use neverwrite_ai::{
    AiRuntimeDescriptor, AiRuntimeOption, AiRuntimeSetupStatus, CLAUDE_RUNTIME_ID,
};
use tauri::{AppHandle, Manager};

use super::setup::{
    load_setup_config, resolve_binary_command, setup_status, ClaudeSetupConfig, ResolvedBinary,
};

const CLAUDE_VENDOR_RELATIVE_PATH: &str = "../../../vendor/Claude-agent-acp-upstream";
const CLAUDE_EMBEDDED_RELATIVE_PATH: &str = "embedded/claude-agent-acp";
const NODE_EMBEDDED_RELATIVE_PATH: &str = "embedded/node";

#[derive(Debug, Clone)]
pub struct ClaudeProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub setup: ClaudeSetupConfig,
}

#[derive(Debug, Default)]
pub struct ClaudeRuntime;

impl ClaudeRuntime {
    pub fn descriptor(&self) -> AiRuntimeDescriptor {
        AiRuntimeDescriptor {
            runtime: AiRuntimeOption {
                id: CLAUDE_RUNTIME_ID.to_string(),
                name: "Claude ACP".to_string(),
                description: "Claude runtime exposed through the upstream ACP adapter.".to_string(),
                capabilities: vec![
                    "attachments".to_string(),
                    "permissions".to_string(),
                    "reasoning".to_string(),
                    "plans".to_string(),
                    "terminal_output".to_string(),
                ],
            },
            models: vec![],
            modes: vec![],
            config_options: vec![],
        }
    }

    pub fn bundled_binary_path(&self, app: &AppHandle) -> Result<PathBuf, String> {
        let binary_name = if cfg!(target_os = "windows") {
            "claude-agent-acp.exe"
        } else {
            "claude-agent-acp"
        };

        let resource_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));

        Ok(resource_dir.join("binaries").join(binary_name))
    }

    pub fn vendor_entry_path(&self) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(CLAUDE_VENDOR_RELATIVE_PATH)
            .join("dist")
            .join("index.js")
    }

    pub fn bundled_vendor_entry_path(&self, app: &AppHandle) -> Result<PathBuf, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));

        Ok(resource_dir
            .join(CLAUDE_EMBEDDED_RELATIVE_PATH)
            .join("dist")
            .join("index.js"))
    }

    pub fn bundled_node_path(&self, app: &AppHandle) -> Result<PathBuf, String> {
        let binary_name = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };

        let resource_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));

        Ok(resource_dir
            .join(NODE_EMBEDDED_RELATIVE_PATH)
            .join("bin")
            .join(binary_name))
    }

    pub fn resolved_binary(&self, app: &AppHandle) -> Result<ResolvedBinary, String> {
        let setup = load_setup_config(app)?;
        Ok(resolve_binary_command(
            &setup,
            self.bundled_binary_path(app)?,
            self.bundled_node_path(app)?,
            self.bundled_vendor_entry_path(app)?,
            self.vendor_entry_path(),
        ))
    }

    pub fn setup_status(&self, app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
        setup_status(
            app,
            self.bundled_binary_path(app)?,
            self.bundled_node_path(app)?,
            self.bundled_vendor_entry_path(app)?,
            self.vendor_entry_path(),
        )
    }

    pub fn process_spec(
        &self,
        app: &AppHandle,
        cwd: Option<PathBuf>,
    ) -> Result<ClaudeProcessSpec, String> {
        let setup = load_setup_config(app)?;
        let resolved = resolve_binary_command(
            &setup,
            self.bundled_binary_path(app)?,
            self.bundled_node_path(app)?,
            self.bundled_vendor_entry_path(app)?,
            self.vendor_entry_path(),
        );

        Ok(ClaudeProcessSpec {
            program: resolved
                .program
                .ok_or_else(|| "No Claude runtime binary is configured.".to_string())?,
            args: resolved.args,
            cwd,
            setup,
        })
    }
}
