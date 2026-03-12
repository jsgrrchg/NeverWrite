use std::{collections::HashMap, path::PathBuf};

use serde::Deserialize;
use tauri::AppHandle;
use vault_ai_ai::{
    AiConfigOption, AiConfigOptionCategory, AiConfigSelectOption, AiRuntimeDescriptor,
    AiRuntimeSetupStatus, AiSession, AiSessionStatus, CODEX_RUNTIME_ID,
};

use super::codex::{
    clear_authenticated_method, mark_authenticated_method, save_setup_config, CodexRuntime,
    CodexRuntimeHandle, CodexSetupInput,
};

#[derive(Debug, Clone, Deserialize)]
pub struct AiAttachmentInput {
    pub label: String,
    pub path: Option<String>,
    pub content: Option<String>,
    #[serde(rename = "type")]
    pub attachment_type: Option<String>,
    /// For folder attachments: the relative folder path (e.g. "daily" or "projects/work")
    #[serde(rename = "noteId")]
    pub note_id: Option<String>,
    /// Absolute path to the source file (audio/file attachments)
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
    /// MIME type (audio/file attachments)
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    /// Pre-computed transcription text (audio attachments)
    pub transcription: Option<String>,
}

fn build_prompt_with_attachments(
    content: &str,
    attachments: &[AiAttachmentInput],
    _vault_root: Option<&std::path::Path>,
) -> String {
    let mut context_parts: Vec<String> = Vec::new();
    for attachment in attachments {
        if let Some(content) = attachment.content.as_deref() {
            let tag = if attachment.attachment_type.as_deref() == Some("selection") {
                "attached_selection"
            } else {
                "attached_note"
            };
            context_parts.push(format!(
                "<{tag} name=\"{}\">\n{}\n</{tag}>",
                attachment.label, content
            ));
            continue;
        }

        if attachment.attachment_type.as_deref() == Some("folder") {
            if let Some(folder_rel) = attachment.note_id.as_deref() {
                context_parts.push(format!(
                    "<attached_folder name=\"{}\" path=\"{}\" />",
                    attachment.label.trim_start_matches("📁 "),
                    folder_rel
                ));
            }
        } else if attachment.attachment_type.as_deref() == Some("audio") {
            if let Some(transcription) = &attachment.transcription {
                let duration_hint = attachment.file_path.as_deref().unwrap_or("audio");
                context_parts.push(format!(
                    "<attached_audio name=\"{}\" source=\"{}\">\n[Transcription]\n{}\n</attached_audio>",
                    attachment.label, duration_hint, transcription
                ));
            }
        } else if attachment.attachment_type.as_deref() == Some("file") {
            let file_path = attachment
                .file_path
                .as_deref()
                .or(attachment.path.as_deref());
            if let Some(fp) = file_path {
                let mime = attachment
                    .mime_type
                    .as_deref()
                    .unwrap_or("application/octet-stream");
                let extracted = if mime.starts_with("text/") || mime == "application/json" {
                    std::fs::read_to_string(fp).unwrap_or_default()
                } else if mime == "application/pdf" {
                    match std::fs::read(fp) {
                        Ok(bytes) => match pdf_extract::extract_text_from_mem_by_pages(&bytes) {
                            Ok(pages) if !pages.is_empty() => pages
                                .iter()
                                .enumerate()
                                .map(|(i, text)| format!("--- Page {} ---\n{}", i + 1, text.trim()))
                                .collect::<Vec<_>>()
                                .join("\n\n"),
                            _ => format!("[PDF: could not extract text, {} bytes]", bytes.len()),
                        },
                        Err(_) => "[PDF: could not read file]".to_string(),
                    }
                } else {
                    let size = std::fs::metadata(fp).map(|m| m.len()).unwrap_or(0);
                    format!("[Binary file: {} bytes, type: {}]", size, mime)
                };
                context_parts.push(format!(
                    "<attached_file name=\"{}\" type=\"{}\">\n{}\n</attached_file>",
                    attachment.label, mime, extracted
                ));
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

/// Filter the reasoning_effort config option so it only shows the effort levels
/// available for the given model. Adjusts the current value when needed.
fn filter_effort_options(
    mut options: Vec<AiConfigOption>,
    model_id: &str,
    efforts_by_model: &HashMap<String, Vec<String>>,
) -> Vec<AiConfigOption> {
    let Some(available) = efforts_by_model.get(model_id) else {
        return options;
    };

    let existing_index = options
        .iter()
        .position(|option| option.id == "reasoning_effort");
    let current_value = options
        .iter()
        .find(|option| option.id == "reasoning_effort")
        .map(|option| option.value.clone())
        .unwrap_or_default();
    let runtime_id = options
        .iter()
        .find(|option| option.id == "reasoning_effort" || option.id == "model")
        .map(|option| option.runtime_id.clone())
        .unwrap_or_else(|| CODEX_RUNTIME_ID.to_string());

    options.retain(|option| option.id != "reasoning_effort");

    let Some(reasoning_option) =
        build_reasoning_option(&runtime_id, available, current_value.as_str())
    else {
        return options;
    };

    let insert_at = existing_index
        .or_else(|| {
            options
                .iter()
                .position(|option| option.id == "model")
                .map(|index| index + 1)
        })
        .unwrap_or(options.len())
        .min(options.len());

    options.insert(insert_at, reasoning_option);
    options
}

fn build_reasoning_option(
    runtime_id: &str,
    available: &[String],
    current_value: &str,
) -> Option<AiConfigOption> {
    if available.len() <= 1 {
        return None;
    }

    let value = if available.iter().any(|effort| effort == current_value) {
        current_value.to_string()
    } else {
        available.first()?.clone()
    };

    Some(AiConfigOption {
        id: "reasoning_effort".to_string(),
        runtime_id: runtime_id.to_string(),
        category: AiConfigOptionCategory::Reasoning,
        label: "Reasoning Effort".to_string(),
        description: Some("Choose how much reasoning effort the model should use".to_string()),
        kind: "select".to_string(),
        value,
        options: available
            .iter()
            .map(|effort| AiConfigSelectOption {
                value: effort.clone(),
                label: reasoning_effort_label(effort),
                description: None,
            })
            .collect(),
    })
}

fn reasoning_effort_label(effort: &str) -> String {
    match effort {
        "xhigh" => "Extra High".to_string(),
        _ => {
            let mut chars = effort.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        }
    }
}

fn sync_model_selection(
    session: &mut AiSession,
    model_id: &str,
    efforts_by_model: &HashMap<String, Vec<String>>,
) {
    session.model_id = model_id.to_string();

    if let Some(option) = session
        .config_options
        .iter_mut()
        .find(|option| option.id == "model")
    {
        option.value = model_id.to_string();
    }

    session.config_options =
        filter_effort_options(session.config_options.clone(), model_id, efforts_by_model);
}

#[derive(Debug, Clone)]
struct ManagedSession {
    session: AiSession,
    vault_root: Option<PathBuf>,
    /// Maps display model id → available effort levels.
    efforts_by_model: HashMap<String, Vec<String>>,
    /// Maps display model id → canonical ACP base id (e.g. "gpt-5.1-codex" → "gpt-5.1-codex-max").
    acp_model_ids: HashMap<String, String>,
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
        let config_options = filter_effort_options(
            session_id.config_options,
            &session_id.model_id,
            &session_id.efforts_by_model,
        );
        let session = AiSession {
            session_id: session_id.session_id.clone(),
            runtime_id: CODEX_RUNTIME_ID.to_string(),
            model_id: session_id.model_id,
            mode_id: session_id.mode_id,
            status: AiSessionStatus::Idle,
            efforts_by_model: session_id.efforts_by_model.clone(),
            models: session_id.models,
            modes: session_id.modes,
            config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            ManagedSession {
                session: session.clone(),
                vault_root,
                efforts_by_model: session_id.efforts_by_model,
                acp_model_ids: session_id.acp_model_ids,
            },
        );
        self.touch_session(&session.session_id);

        Ok(session)
    }

    pub fn set_model(&mut self, session_id: &str, model_id: &str) -> Result<AiSession, String> {
        let managed = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))?;

        if !managed.session.models.iter().any(|m| m.id == model_id) {
            return Err(format!("Modelo no soportado por Codex ACP: {model_id}"));
        }

        // Pick the current reasoning effort, falling back to "medium".
        let current_effort = managed
            .session
            .config_options
            .iter()
            .find(|o| o.id == "reasoning_effort")
            .map(|o| o.value.clone())
            .unwrap_or_else(|| "medium".to_string());

        // If the new model doesn't support the current effort, pick the first available.
        let available_efforts = managed.efforts_by_model.get(model_id);
        let effort = match available_efforts {
            Some(levels) if levels.contains(&current_effort) => current_effort,
            Some(levels) => levels.first().cloned().unwrap_or(current_effort),
            None => current_effort,
        };

        // Resolve display id → canonical ACP base id (e.g. "gpt-5.1-codex" → "gpt-5.1-codex-max").
        let acp_base = managed
            .acp_model_ids
            .get(model_id)
            .cloned()
            .unwrap_or_else(|| model_id.to_string());
        let acp_model_id = format!("{acp_base}/{effort}");

        self.codex_handle_from_session(session_id)?
            .set_model(session_id, &acp_model_id)?;

        let session = {
            let managed = self.session_mut(session_id)?;
            sync_model_selection(&mut managed.session, model_id, &managed.efforts_by_model);
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
        let supports_value = self
            .sessions
            .get(session_id)
            .and_then(|managed| {
                managed
                    .session
                    .config_options
                    .iter()
                    .find(|item| item.id == option_id)
                    .map(|option| option.options.iter().any(|item| item.value == value))
            })
            .unwrap_or(false);

        if !supports_value {
            return Err(format!(
                "Opcion invalida para Codex ACP: {option_id}={value}"
            ));
        }

        self.codex_handle_from_session(session_id)?
            .set_config_option(session_id, option_id, value)?;

        // The ACP encodes effort in the model ID, so changing reasoning_effort
        // also requires sending a set_model with the recalculated ACP model ID.
        if option_id == "reasoning_effort" {
            let managed = self
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))?;
            let model_id = &managed.session.model_id;
            let acp_base = managed
                .acp_model_ids
                .get(model_id)
                .cloned()
                .unwrap_or_else(|| model_id.clone());
            let acp_model_id = format!("{acp_base}/{value}");
            self.codex_handle_from_session(session_id)?
                .set_model(session_id, &acp_model_id)?;
        }

        let session = {
            let managed = self.session_mut(session_id)?;
            if option_id == "model" {
                sync_model_selection(&mut managed.session, value, &managed.efforts_by_model);
            } else {
                let option = managed
                    .session
                    .config_options
                    .iter_mut()
                    .find(|item| item.id == option_id)
                    .ok_or_else(|| format!("Opcion no encontrada: {option_id}"))?;

                option.value = value.to_string();
            }
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

    pub fn respond_user_input(
        &mut self,
        session_id: &str,
        request_id: &str,
        answers: HashMap<String, Vec<String>>,
    ) -> Result<AiSession, String> {
        self.codex_handle_from_session(session_id)?
            .respond_user_input(session_id, request_id, answers)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn config_option(id: &str, category: AiConfigOptionCategory) -> AiConfigOption {
        AiConfigOption {
            id: id.to_string(),
            runtime_id: CODEX_RUNTIME_ID.to_string(),
            category,
            label: id.to_string(),
            description: None,
            kind: "select".to_string(),
            value: String::new(),
            options: Vec::new(),
        }
    }

    #[test]
    fn filter_effort_options_can_expand_after_switching_models() {
        let options = vec![
            AiConfigOption {
                value: "model-a".to_string(),
                options: vec![
                    AiConfigSelectOption {
                        value: "model-a".to_string(),
                        label: "Model A".to_string(),
                        description: None,
                    },
                    AiConfigSelectOption {
                        value: "model-b".to_string(),
                        label: "Model B".to_string(),
                        description: None,
                    },
                ],
                ..config_option("model", AiConfigOptionCategory::Model)
            },
            AiConfigOption {
                value: "medium".to_string(),
                options: vec![
                    AiConfigSelectOption {
                        value: "medium".to_string(),
                        label: "Medium".to_string(),
                        description: None,
                    },
                    AiConfigSelectOption {
                        value: "high".to_string(),
                        label: "High".to_string(),
                        description: None,
                    },
                ],
                ..config_option("reasoning_effort", AiConfigOptionCategory::Reasoning)
            },
        ];

        let efforts_by_model = HashMap::from([
            (
                "model-a".to_string(),
                vec!["medium".to_string(), "high".to_string()],
            ),
            (
                "model-b".to_string(),
                vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                    "xhigh".to_string(),
                ],
            ),
        ]);

        let filtered = filter_effort_options(options, "model-b", &efforts_by_model);
        let reasoning = filtered
            .iter()
            .find(|option| option.id == "reasoning_effort")
            .expect("missing reasoning option");

        assert_eq!(
            reasoning
                .options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "medium", "high", "xhigh"]
        );
        assert_eq!(reasoning.value, "medium");
    }

    #[test]
    fn filter_effort_options_removes_selector_for_single_effort_models() {
        let options = vec![
            config_option("model", AiConfigOptionCategory::Model),
            config_option("reasoning_effort", AiConfigOptionCategory::Reasoning),
        ];
        let efforts_by_model = HashMap::from([("model-a".to_string(), vec!["medium".to_string()])]);

        let filtered = filter_effort_options(options, "model-a", &efforts_by_model);

        assert!(filtered
            .iter()
            .all(|option| option.id != "reasoning_effort"));
    }

    #[test]
    fn folder_attachments_only_include_relative_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "vaultai-folder-attachment-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos()
        ));
        let folder_dir = temp_dir.join("YOUTUBE");
        fs::create_dir_all(&folder_dir).expect("create folder attachment dir");
        fs::write(
            folder_dir.join("huge.md"),
            "this note content should not be expanded",
        )
        .expect("write attachment note");

        let prompt = build_prompt_with_attachments(
            "implementa un indice",
            &[AiAttachmentInput {
                label: "YOUTUBE".to_string(),
                path: None,
                content: None,
                attachment_type: Some("folder".to_string()),
                note_id: Some("YOUTUBE".to_string()),
                file_path: None,
                mime_type: None,
                transcription: None,
            }],
            Some(temp_dir.as_path()),
        );

        assert!(prompt.contains("<attached_folder name=\"YOUTUBE\" path=\"YOUTUBE\" />"));
        assert!(!prompt.contains("this note content should not be expanded"));
        assert!(prompt.ends_with("implementa un indice"));

        let _ = fs::remove_dir_all(temp_dir);
    }
}
