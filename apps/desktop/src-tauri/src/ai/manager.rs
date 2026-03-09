use std::{collections::HashMap, path::PathBuf};

use serde::Deserialize;
use tauri::AppHandle;
use vault_ai_ai::{
    AiRuntimeDescriptor, AiRuntimeSetupStatus, AiSession, AiSessionStatus, CODEX_RUNTIME_ID,
};

use super::codex::{
    clear_authenticated_method, mark_authenticated_method, save_setup_config, CodexRuntime,
    CodexRuntimeHandle, CodexSetupInput,
};

#[derive(Debug, Clone, Deserialize)]
pub struct AiAttachmentInput {
    pub label: String,
    pub path: Option<String>,
    #[serde(rename = "type")]
    pub attachment_type: Option<String>,
    /// For folder attachments: the relative folder path (e.g. "daily" or "projects/work")
    #[serde(rename = "noteId")]
    pub note_id: Option<String>,
}

fn build_prompt_with_attachments(
    content: &str,
    attachments: &[AiAttachmentInput],
    vault_root: Option<&std::path::Path>,
) -> String {
    let mut context_parts: Vec<String> = Vec::new();
    for attachment in attachments {
        if attachment.attachment_type.as_deref() == Some("folder") {
            // Resolve folder: read all .md files in the folder
            if let (Some(folder_rel), Some(root)) = (&attachment.note_id, vault_root) {
                let folder_abs = root.join(folder_rel);
                if let Ok(entries) = std::fs::read_dir(&folder_abs) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().is_some_and(|ext| ext == "md") {
                            if let Ok(file_content) = std::fs::read_to_string(&path) {
                                let name = path
                                    .file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("unknown");
                                context_parts.push(format!(
                                    "<attached_note name=\"{}/{}\">\n{}\n</attached_note>",
                                    attachment.label.trim_start_matches("📁 "),
                                    name,
                                    file_content
                                ));
                            }
                        }
                    }
                }
            }
        } else if let Some(path) = &attachment.path {
            if let Ok(file_content) = std::fs::read_to_string(path) {
                context_parts.push(format!(
                    "<attached_note name=\"{}\">\n{}\n</attached_note>",
                    attachment.label, file_content
                ));
            }
        }
    }
    if context_parts.is_empty() {
        return content.to_string();
    }
    format!("{}\n\n{}", context_parts.join("\n\n"), content)
}

#[derive(Debug, Clone)]
struct ManagedSession {
    session: AiSession,
    /// The vault root that was active when this session was created.
    /// Used to ensure AI operations target the correct vault.
    vault_root: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub struct AiManager {
    codex: CodexRuntime,
    codex_handle: Option<CodexRuntimeHandle>,
    sessions: HashMap<String, ManagedSession>,
    session_order: Vec<String>,
}

impl AiManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list_runtimes(&self) -> Vec<AiRuntimeDescriptor> {
        vec![self.codex.descriptor()]
    }

    pub fn codex_setup_status(&self, app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
        self.codex.setup_status(app)
    }

    pub fn save_codex_setup(
        &self,
        app: &AppHandle,
        input: CodexSetupInput,
    ) -> Result<AiRuntimeSetupStatus, String> {
        let _ = save_setup_config(app, input)?;
        self.codex.setup_status(app)
    }

    pub fn start_codex_auth(
        &mut self,
        app: &AppHandle,
        method_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiRuntimeSetupStatus, String> {
        let process_spec = self.codex.process_spec(app, vault_root)?;
        self.codex_handle(app)
            .authenticate(process_spec, method_id)?;
        let _ = mark_authenticated_method(app, method_id)?;
        self.codex.setup_status(app)
    }

    pub fn list_sessions(&self, vault_root: Option<&PathBuf>) -> Vec<AiSession> {
        self.session_order
            .iter()
            .filter_map(|session_id| self.sessions.get(session_id))
            .filter(|managed| managed.vault_root.as_ref() == vault_root)
            .map(|managed| managed.session.clone())
            .collect()
    }

    pub fn load_session(&mut self, session_id: &str) -> Result<AiSession, String> {
        let session = self
            .sessions
            .get(session_id)
            .map(|managed| managed.session.clone())
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))?;

        self.touch_session(session_id);
        Ok(session)
    }

    pub fn create_session(
        &mut self,
        runtime_id: &str,
        vault_root: Option<PathBuf>,
        app: &AppHandle,
    ) -> Result<AiSession, String> {
        if runtime_id != CODEX_RUNTIME_ID {
            return Err(format!("Runtime no soportado: {runtime_id}"));
        }

        let process_spec = self.codex.process_spec(app, vault_root.clone())?;
        let session_id = match self.codex_handle(app).create_session(process_spec.clone()) {
            Ok(session_id) => session_id,
            Err(error) => {
                self.invalidate_auth_if_needed(app, &error);
                return Err(error);
            }
        };
        let session = AiSession {
            session_id: session_id.session_id.clone(),
            runtime_id: CODEX_RUNTIME_ID.to_string(),
            model_id: session_id.model_id,
            mode_id: session_id.mode_id,
            status: AiSessionStatus::Idle,
            models: session_id.models,
            modes: session_id.modes,
            config_options: session_id.config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            ManagedSession {
                session: session.clone(),
                vault_root,
            },
        );
        self.touch_session(&session.session_id);

        Ok(session)
    }

    pub fn set_model(&mut self, session_id: &str, model_id: &str) -> Result<AiSession, String> {
        let supports_model = self
            .sessions
            .get(session_id)
            .map(|managed| {
                managed
                    .session
                    .models
                    .iter()
                    .any(|model| model.id == model_id)
            })
            .unwrap_or(false);
        if !supports_model {
            return Err(format!("Modelo no soportado por Codex ACP: {model_id}"));
        }

        self.codex_handle_from_session(session_id)?
            .set_model(session_id, model_id)?;
        let session = {
            let managed = self.session_mut(session_id)?;
            managed.session.model_id = model_id.to_string();
            managed.session.clone()
        };
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn set_mode(&mut self, session_id: &str, mode_id: &str) -> Result<AiSession, String> {
        let supports_mode = self
            .sessions
            .get(session_id)
            .map(|managed| managed.session.modes.iter().any(|mode| mode.id == mode_id))
            .unwrap_or(false);
        if !supports_mode {
            return Err(format!("Modo no soportado por Codex ACP: {mode_id}"));
        }

        self.codex_handle_from_session(session_id)?
            .set_mode(session_id, mode_id)?;
        let session = {
            let managed = self.session_mut(session_id)?;
            managed.session.mode_id = mode_id.to_string();
            managed.session.clone()
        };
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn set_config_option(
        &mut self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<AiSession, String> {
        if !self.codex.supports_config_value(option_id, value) {
            return Err(format!(
                "Opcion invalida para Codex ACP: {option_id}={value}"
            ));
        }

        self.codex_handle_from_session(session_id)?
            .set_config_option(session_id, option_id, value)?;
        let session = {
            let managed = self.session_mut(session_id)?;
            let option = managed
                .session
                .config_options
                .iter_mut()
                .find(|item| item.id == option_id)
                .ok_or_else(|| format!("Opcion no encontrada: {option_id}"))?;

            option.value = value.to_string();
            managed.session.clone()
        };
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn cancel_turn(&mut self, session_id: &str) -> Result<AiSession, String> {
        self.codex_handle_from_session(session_id)?
            .cancel(session_id)?;
        let session = {
            let managed = self.session_mut(session_id)?;
            managed.session.status = AiSessionStatus::Idle;
            managed.session.clone()
        };
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn send_message(
        &mut self,
        session_id: &str,
        content: &str,
        attachments: &[AiAttachmentInput],
        app: &AppHandle,
    ) -> Result<AiSession, String> {
        // Use the vault_root stored with the session (captured at creation time)
        // instead of the current global vault — prevents cross-vault operations.
        let vault_root = self
            .sessions
            .get(session_id)
            .and_then(|m| m.vault_root.clone());
        let full_prompt =
            build_prompt_with_attachments(content, attachments, vault_root.as_deref());
        if let Err(error) = self.codex_handle_from_session(session_id)?.prompt_async(
            session_id,
            &full_prompt,
            app.clone(),
        ) {
            self.invalidate_auth_if_needed(app, &error);
            return Err(error);
        }
        let session = {
            let managed = self.session_mut(session_id)?;
            managed.session.status = AiSessionStatus::Streaming;
            managed.session.clone()
        };
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn respond_permission(
        &mut self,
        session_id: &str,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<AiSession, String> {
        self.codex_handle_from_session(session_id)?
            .respond_permission(request_id, option_id)?;
        let session = {
            let managed = self.session_mut(session_id)?;
            managed.session.status = AiSessionStatus::Streaming;
            managed.session.clone()
        };
        self.touch_session(session_id);
        Ok(session)
    }

    fn touch_session(&mut self, session_id: &str) {
        self.session_order.retain(|id| id != session_id);
        self.session_order.insert(0, session_id.to_string());
    }

    fn codex_handle(&mut self, app: &AppHandle) -> CodexRuntimeHandle {
        if let Some(handle) = self.codex_handle.as_ref() {
            return handle.clone();
        }

        let handle = CodexRuntimeHandle::spawn(app.clone());
        self.codex_handle = Some(handle.clone());
        handle
    }

    fn codex_handle_from_session(&self, session_id: &str) -> Result<CodexRuntimeHandle, String> {
        if !self.sessions.contains_key(session_id) {
            return Err(format!("Sesion AI no encontrada: {session_id}"));
        }

        self.codex_handle
            .clone()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut ManagedSession, String> {
        self.sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))
    }

    fn invalidate_auth_if_needed(&self, app: &AppHandle, error: &str) {
        if is_authentication_error(error) {
            let _ = clear_authenticated_method(app);
        }
    }
}

fn is_authentication_error(message: &str) -> bool {
    let normalized = message.trim().to_lowercase();
    normalized.contains("auth_required") || normalized.contains("authentication required")
}
