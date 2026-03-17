use std::{collections::HashMap, path::PathBuf};

use tauri::AppHandle;
use vault_ai_ai::{AiRuntimeDescriptor, AiRuntimeSessionSummary, AiRuntimeSetupStatus, AiSession};

use super::{claude::ClaudeSetupInput, codex::CodexSetupInput};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AiRuntimeCapabilities {
    pub create_session: bool,
    pub fork_session: bool,
    pub resume_session: bool,
    pub list_sessions: bool,
    pub prompt_queueing: bool,
    pub terminal_output: bool,
    pub user_input: bool,
}

#[derive(Debug, Clone)]
pub enum AiRuntimeSetupInput {
    Codex(CodexSetupInput),
    Claude(ClaudeSetupInput),
}

impl AiRuntimeSetupInput {
    pub fn into_codex(self) -> Result<CodexSetupInput, String> {
        match self {
            Self::Codex(input) => Ok(input),
            Self::Claude(_) => Err("Configuracion de Claude enviada a Codex.".to_string()),
        }
    }

    pub fn into_claude(self) -> Result<ClaudeSetupInput, String> {
        match self {
            Self::Claude(input) => Ok(input),
            Self::Codex(_) => Err("Configuracion de Codex enviada a Claude.".to_string()),
        }
    }
}

pub trait AiRuntimeAdapter: Send {
    fn runtime_id(&self) -> &'static str;
    fn descriptor(&self) -> AiRuntimeDescriptor;
    fn capabilities(&self) -> AiRuntimeCapabilities;
    fn setup_status(&self, app: &AppHandle) -> Result<AiRuntimeSetupStatus, String>;
    fn update_setup(
        &mut self,
        app: &AppHandle,
        input: AiRuntimeSetupInput,
    ) -> Result<AiRuntimeSetupStatus, String>;
    fn start_auth(
        &mut self,
        app: &AppHandle,
        method_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiRuntimeSetupStatus, String>;
    fn create_session(
        &mut self,
        app: &AppHandle,
        vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String>;
    fn get_session(&self, session_id: &str) -> Option<AiSession>;
    fn sync_state(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn remove_session(&mut self, _session_id: &str) {}
    fn list_runtime_sessions(
        &mut self,
        _app: &AppHandle,
        _vault_root: Option<&PathBuf>,
    ) -> Result<Vec<AiRuntimeSessionSummary>, String> {
        Ok(Vec::new())
    }
    fn load_session(
        &mut self,
        _app: &AppHandle,
        session_id: &str,
        _vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        self.get_session(session_id)
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))
    }
    fn resume_session(
        &mut self,
        _app: &AppHandle,
        session_id: &str,
        _vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        Err(format!(
            "El runtime {} no soporta resume_session para {session_id}.",
            self.runtime_id()
        ))
    }
    fn fork_session(
        &mut self,
        _app: &AppHandle,
        session_id: &str,
        _vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        Err(format!(
            "El runtime {} no soporta fork_session para {session_id}.",
            self.runtime_id()
        ))
    }
    fn set_model(&mut self, session_id: &str, model_id: &str) -> Result<AiSession, String>;
    fn set_mode(&mut self, session_id: &str, mode_id: &str) -> Result<AiSession, String>;
    fn set_config_option(
        &mut self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<AiSession, String>;
    fn cancel_turn(&mut self, session_id: &str) -> Result<AiSession, String>;
    fn send_message(
        &mut self,
        session_id: &str,
        prompt: &str,
        app: &AppHandle,
    ) -> Result<AiSession, String>;
    fn respond_permission(
        &mut self,
        session_id: &str,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<AiSession, String>;
    fn respond_user_input(
        &mut self,
        session_id: &str,
        request_id: &str,
        answers: HashMap<String, Vec<String>>,
    ) -> Result<AiSession, String>;
    fn register_file_baseline(
        &mut self,
        _session_id: &str,
        _display_path: &str,
        _content: String,
    ) -> Result<(), String> {
        Ok(())
    }
}

pub fn merge_runtime_capabilities(
    mut descriptor: AiRuntimeDescriptor,
    capabilities: &AiRuntimeCapabilities,
) -> AiRuntimeDescriptor {
    let mut tags = descriptor.runtime.capabilities;
    for tag in capability_tags(capabilities) {
        if !tags.iter().any(|existing| existing == &tag) {
            tags.push(tag);
        }
    }
    descriptor.runtime.capabilities = tags;
    descriptor
}

fn capability_tags(capabilities: &AiRuntimeCapabilities) -> Vec<String> {
    let mut tags = Vec::new();
    if capabilities.create_session {
        tags.push("create_session".to_string());
    }
    if capabilities.fork_session {
        tags.push("fork_session".to_string());
    }
    if capabilities.resume_session {
        tags.push("resume_session".to_string());
    }
    if capabilities.list_sessions {
        tags.push("list_sessions".to_string());
    }
    if capabilities.prompt_queueing {
        tags.push("prompt_queueing".to_string());
    }
    if capabilities.terminal_output {
        tags.push("terminal_output".to_string());
    }
    if capabilities.user_input {
        tags.push("user_input".to_string());
    }
    tags
}
