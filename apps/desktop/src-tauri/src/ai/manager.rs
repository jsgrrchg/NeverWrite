use std::{collections::HashMap, path::PathBuf};

use neverwrite_ai::{
    AiRuntimeDescriptor, AiRuntimeSessionSummary, AiRuntimeSetupStatus, AiSession,
};
use serde::Deserialize;
use tauri::AppHandle;

use super::{
    catalog::default_runtime_adapters,
    runtime::{merge_runtime_capabilities, AiRuntimeAdapter, AiRuntimeSetupInput},
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
    vault_root: Option<&std::path::Path>,
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
                if mime == "application/pdf" {
                    let rel_path = vault_root
                        .and_then(|root| std::path::Path::new(fp).strip_prefix(root).ok())
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|| fp.to_string());
                    context_parts.push(format!(
                        "<attached_pdf name=\"{}\" path=\"{}\" />",
                        attachment.label, rel_path
                    ));
                } else if mime.starts_with("text/") || mime == "application/json" {
                    match std::fs::read_to_string(fp) {
                        Ok(text) => {
                            context_parts.push(format!(
                                "<attached_file name=\"{}\" type=\"{}\">\n{}\n</attached_file>",
                                attachment.label, mime, text
                            ));
                        }
                        Err(e) => {
                            context_parts.push(format!(
                                "<attached_file name=\"{}\" type=\"{}\">\n[Error reading file: {}]\n</attached_file>",
                                attachment.label, mime, e
                            ));
                        }
                    }
                } else if mime.starts_with("image/") {
                    let rel_path = vault_root
                        .and_then(|root| std::path::Path::new(fp).strip_prefix(root).ok())
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|| fp.to_string());
                    let size = std::fs::metadata(fp).map(|m| m.len()).unwrap_or(0);
                    context_parts.push(format!(
                        "<attached_image name=\"{}\" type=\"{}\" path=\"{}\" size=\"{}\" />",
                        attachment.label, mime, rel_path, size
                    ));
                } else {
                    let size = std::fs::metadata(fp).map(|m| m.len()).unwrap_or(0);
                    context_parts.push(format!(
                        "<attached_file name=\"{}\" type=\"{}\">\n[Binary file: {} bytes]\n</attached_file>",
                        attachment.label, mime, size
                    ));
                }
            }
        } else if let Some(path) = &attachment.path {
            match std::fs::read_to_string(path) {
                Ok(file_content) => {
                    context_parts.push(format!(
                        "<attached_note name=\"{}\">\n{}\n</attached_note>",
                        attachment.label, file_content
                    ));
                }
                Err(e) => {
                    context_parts.push(format!(
                        "<attached_note name=\"{}\">\n[Error reading note: {}]\n</attached_note>",
                        attachment.label, e
                    ));
                }
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
    runtime_id: String,
    vault_root: Option<PathBuf>,
}

#[derive(Default)]
pub struct AiManager {
    runtimes: HashMap<String, Box<dyn AiRuntimeAdapter>>,
    runtime_order: Vec<String>,
    sessions: HashMap<String, ManagedSession>,
    session_order: Vec<String>,
}

impl AiManager {
    pub fn new() -> Self {
        let mut manager = Self::default();
        for runtime in default_runtime_adapters() {
            manager.register_runtime(runtime);
        }
        manager
    }

    pub fn list_runtimes(&self) -> Vec<AiRuntimeDescriptor> {
        self.runtime_order
            .iter()
            .filter_map(|runtime_id| self.runtimes.get(runtime_id))
            .map(|runtime| {
                merge_runtime_capabilities(runtime.descriptor(), &runtime.capabilities())
            })
            .collect()
    }

    pub fn runtime_setup_status(
        &self,
        app: &AppHandle,
        runtime_id: &str,
    ) -> Result<AiRuntimeSetupStatus, String> {
        self.runtime_ref(runtime_id)?.setup_status(app)
    }

    pub fn update_runtime_setup(
        &mut self,
        app: &AppHandle,
        runtime_id: &str,
        input: AiRuntimeSetupInput,
    ) -> Result<AiRuntimeSetupStatus, String> {
        self.runtime_mut(runtime_id)?.update_setup(app, input)
    }

    pub fn start_runtime_auth(
        &mut self,
        app: &AppHandle,
        runtime_id: &str,
        method_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiRuntimeSetupStatus, String> {
        self.runtime_mut(runtime_id)?
            .start_auth(app, method_id, vault_root)
    }

    pub fn list_sessions(&mut self, vault_root: Option<&PathBuf>) -> Vec<AiSession> {
        for runtime_id in self.runtime_order.clone() {
            if let Some(runtime) = self.runtimes.get_mut(&runtime_id) {
                let _ = runtime.sync_state();
            }
        }

        let mut stale_session_ids = Vec::new();
        let sessions = self
            .session_order
            .iter()
            .filter_map(|session_id| {
                self.sessions
                    .get(session_id)
                    .map(|managed| (session_id, managed))
            })
            .filter(|(_, managed)| managed.vault_root.as_ref() == vault_root)
            .filter_map(|(session_id, managed)| {
                let session = self
                    .runtimes
                    .get(&managed.runtime_id)
                    .and_then(|runtime| runtime.get_session(session_id));
                if session.is_none() {
                    stale_session_ids.push(session_id.to_string());
                }
                session
            })
            .collect();

        if !stale_session_ids.is_empty() {
            for session_id in stale_session_ids {
                self.sessions.remove(&session_id);
                self.session_order.retain(|id| id != &session_id);
            }
        }

        sessions
    }

    pub fn load_session(&mut self, session_id: &str) -> Result<AiSession, String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self
            .runtime_ref(&runtime_id)?
            .get_session(session_id)
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))?;

        self.touch_session(session_id);
        Ok(session)
    }

    pub fn list_runtime_sessions(
        &mut self,
        runtime_id: &str,
        vault_root: Option<&PathBuf>,
        app: &AppHandle,
    ) -> Result<Vec<AiRuntimeSessionSummary>, String> {
        self.runtime_mut(runtime_id)?
            .list_runtime_sessions(app, vault_root)
    }

    pub fn load_runtime_session(
        &mut self,
        runtime_id: &str,
        session_id: &str,
        vault_root: Option<PathBuf>,
        app: &AppHandle,
    ) -> Result<AiSession, String> {
        let session =
            self.runtime_mut(runtime_id)?
                .load_session(app, session_id, vault_root.clone())?;
        self.sessions.insert(
            session.session_id.clone(),
            ManagedSession {
                runtime_id: session.runtime_id.clone(),
                vault_root,
            },
        );
        self.touch_session(&session.session_id);
        Ok(session)
    }

    pub fn resume_runtime_session(
        &mut self,
        runtime_id: &str,
        session_id: &str,
        vault_root: Option<PathBuf>,
        app: &AppHandle,
    ) -> Result<AiSession, String> {
        let session =
            self.runtime_mut(runtime_id)?
                .resume_session(app, session_id, vault_root.clone())?;
        self.sessions.insert(
            session.session_id.clone(),
            ManagedSession {
                runtime_id: session.runtime_id.clone(),
                vault_root,
            },
        );
        self.touch_session(&session.session_id);
        Ok(session)
    }

    pub fn fork_runtime_session(
        &mut self,
        runtime_id: &str,
        session_id: &str,
        vault_root: Option<PathBuf>,
        app: &AppHandle,
    ) -> Result<AiSession, String> {
        let session =
            self.runtime_mut(runtime_id)?
                .fork_session(app, session_id, vault_root.clone())?;
        self.sessions.insert(
            session.session_id.clone(),
            ManagedSession {
                runtime_id: session.runtime_id.clone(),
                vault_root,
            },
        );
        self.touch_session(&session.session_id);
        Ok(session)
    }

    pub fn create_session(
        &mut self,
        runtime_id: &str,
        vault_root: Option<PathBuf>,
        additional_roots: Option<Vec<String>>,
        app: &AppHandle,
    ) -> Result<AiSession, String> {
        let session = self.runtime_mut(runtime_id)?.create_session(
            app,
            vault_root.clone(),
            additional_roots,
        )?;

        self.sessions.insert(
            session.session_id.clone(),
            ManagedSession {
                runtime_id: session.runtime_id.clone(),
                vault_root,
            },
        );
        self.touch_session(&session.session_id);

        Ok(session)
    }

    pub fn set_model(&mut self, session_id: &str, model_id: &str) -> Result<AiSession, String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self
            .runtime_mut(&runtime_id)?
            .set_model(session_id, model_id)?;
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn set_mode(&mut self, session_id: &str, mode_id: &str) -> Result<AiSession, String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self
            .runtime_mut(&runtime_id)?
            .set_mode(session_id, mode_id)?;
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn set_config_option(
        &mut self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<AiSession, String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self
            .runtime_mut(&runtime_id)?
            .set_config_option(session_id, option_id, value)?;
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn cancel_turn(&mut self, session_id: &str) -> Result<AiSession, String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self.runtime_mut(&runtime_id)?.cancel_turn(session_id)?;
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
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self
            .runtime_mut(&runtime_id)?
            .send_message(session_id, &full_prompt, app)?;
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn respond_permission(
        &mut self,
        session_id: &str,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<AiSession, String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self
            .runtime_mut(&runtime_id)?
            .respond_permission(session_id, request_id, option_id)?;
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn respond_user_input(
        &mut self,
        session_id: &str,
        request_id: &str,
        answers: HashMap<String, Vec<String>>,
    ) -> Result<AiSession, String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        let session = self
            .runtime_mut(&runtime_id)?
            .respond_user_input(session_id, request_id, answers)?;
        self.touch_session(session_id);
        Ok(session)
    }

    pub fn remove_session(&mut self, session_id: &str) -> Result<(), String> {
        let runtime_id = self
            .sessions
            .get(session_id)
            .map(|managed| managed.runtime_id.clone())
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))?;
        if let Ok(runtime) = self.runtime_mut(&runtime_id) {
            runtime.remove_session(session_id);
        }
        self.sessions.remove(session_id);
        self.session_order.retain(|id| id != session_id);
        Ok(())
    }

    pub fn remove_sessions_for_vault(&mut self, vault_root: Option<&PathBuf>) {
        let session_ids = self
            .sessions
            .iter()
            .filter(|(_, managed)| managed.vault_root.as_ref() == vault_root)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self.remove_session(&session_id);
        }
    }

    fn touch_session(&mut self, session_id: &str) {
        self.session_order.retain(|id| id != session_id);
        self.session_order.insert(0, session_id.to_string());
    }

    fn register_runtime(&mut self, runtime: Box<dyn AiRuntimeAdapter>) {
        let runtime_id = runtime.runtime_id().to_string();
        self.runtime_order.retain(|id| id != &runtime_id);
        self.runtime_order.push(runtime_id.clone());
        self.runtimes.insert(runtime_id, runtime);
    }

    fn runtime_ref(&self, runtime_id: &str) -> Result<&dyn AiRuntimeAdapter, String> {
        match self.runtimes.get(runtime_id) {
            Some(runtime) => Ok(runtime.as_ref()),
            None => Err(format!("Runtime no soportado: {runtime_id}")),
        }
    }

    fn runtime_mut(
        &mut self,
        runtime_id: &str,
    ) -> Result<&mut (dyn AiRuntimeAdapter + '_), String> {
        match self.runtimes.get_mut(runtime_id) {
            Some(runtime) => Ok(runtime.as_mut()),
            None => Err(format!("Runtime no soportado: {runtime_id}")),
        }
    }

    pub fn register_file_baseline(
        &mut self,
        session_id: &str,
        display_path: &str,
        content: String,
    ) -> Result<(), String> {
        let runtime_id = self.session_runtime_id(session_id)?;
        self.runtime_mut(&runtime_id)?
            .register_file_baseline(session_id, display_path, content)
    }

    fn session_runtime_id(&self, session_id: &str) -> Result<String, String> {
        self.sessions
            .get(session_id)
            .map(|managed| managed.runtime_id.clone())
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neverwrite_ai::{AiModeOption, AiRuntimeOption, AiSessionStatus, KILO_RUNTIME_ID};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::ai::runtime::{AiRuntimeAdapter, AiRuntimeCapabilities};

    #[derive(Default)]
    struct MockRuntime {
        sessions: HashMap<String, AiSession>,
    }

    impl AiRuntimeAdapter for MockRuntime {
        fn runtime_id(&self) -> &'static str {
            "mock-runtime"
        }

        fn descriptor(&self) -> AiRuntimeDescriptor {
            AiRuntimeDescriptor {
                runtime: AiRuntimeOption {
                    id: self.runtime_id().to_string(),
                    name: "Mock Runtime".to_string(),
                    description: "Test runtime".to_string(),
                    capabilities: vec![],
                },
                models: vec![],
                modes: vec![],
                config_options: vec![],
            }
        }

        fn capabilities(&self) -> AiRuntimeCapabilities {
            AiRuntimeCapabilities {
                user_input: true,
                ..AiRuntimeCapabilities::default()
            }
        }

        fn setup_status(&self, _app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
            Err("not used".to_string())
        }

        fn update_setup(
            &mut self,
            _app: &AppHandle,
            _input: AiRuntimeSetupInput,
        ) -> Result<AiRuntimeSetupStatus, String> {
            Err("not used".to_string())
        }

        fn start_auth(
            &mut self,
            _app: &AppHandle,
            _method_id: &str,
            _vault_root: Option<PathBuf>,
        ) -> Result<AiRuntimeSetupStatus, String> {
            Err("not used".to_string())
        }

        fn create_session(
            &mut self,
            _app: &AppHandle,
            _vault_root: Option<PathBuf>,
            _additional_roots: Option<Vec<String>>,
        ) -> Result<AiSession, String> {
            Err("not used".to_string())
        }

        fn get_session(&self, session_id: &str) -> Option<AiSession> {
            self.sessions.get(session_id).cloned()
        }

        fn set_model(&mut self, _session_id: &str, _model_id: &str) -> Result<AiSession, String> {
            Err("not used".to_string())
        }

        fn set_mode(&mut self, session_id: &str, mode_id: &str) -> Result<AiSession, String> {
            let session = self
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "missing session".to_string())?;
            session.mode_id = mode_id.to_string();
            Ok(session.clone())
        }

        fn set_config_option(
            &mut self,
            _session_id: &str,
            _option_id: &str,
            _value: &str,
        ) -> Result<AiSession, String> {
            Err("not used".to_string())
        }

        fn cancel_turn(&mut self, _session_id: &str) -> Result<AiSession, String> {
            Err("not used".to_string())
        }

        fn send_message(
            &mut self,
            _session_id: &str,
            _prompt: &str,
            _app: &AppHandle,
        ) -> Result<AiSession, String> {
            Err("not used".to_string())
        }

        fn respond_permission(
            &mut self,
            _session_id: &str,
            _request_id: &str,
            _option_id: Option<&str>,
        ) -> Result<AiSession, String> {
            Err("not used".to_string())
        }

        fn respond_user_input(
            &mut self,
            _session_id: &str,
            _request_id: &str,
            _answers: HashMap<String, Vec<String>>,
        ) -> Result<AiSession, String> {
            Err("not used".to_string())
        }
    }

    #[test]
    fn manager_dispatches_session_operations_to_runtime() {
        let session_id = "session-1".to_string();
        let mut manager = AiManager::default();
        let mut runtime = MockRuntime::default();
        runtime.sessions.insert(
            session_id.clone(),
            AiSession {
                session_id: session_id.clone(),
                runtime_id: "mock-runtime".to_string(),
                model_id: "model".to_string(),
                mode_id: "default".to_string(),
                status: AiSessionStatus::Idle,
                efforts_by_model: HashMap::new(),
                models: vec![],
                modes: vec![AiModeOption {
                    id: "plan".to_string(),
                    runtime_id: "mock-runtime".to_string(),
                    name: "Plan".to_string(),
                    description: String::new(),
                    disabled: false,
                }],
                config_options: vec![],
            },
        );

        manager.register_runtime(Box::new(runtime));
        manager.sessions.insert(
            session_id.clone(),
            ManagedSession {
                runtime_id: "mock-runtime".to_string(),
                vault_root: None,
            },
        );

        let updated = manager
            .set_mode(&session_id, "plan")
            .expect("mock runtime should receive set_mode");

        assert_eq!(updated.mode_id, "plan");
        assert_eq!(manager.session_order.first(), Some(&session_id));
    }

    #[test]
    fn manager_merges_runtime_capabilities_into_descriptor() {
        let mut manager = AiManager::default();
        let runtime = MockRuntime::default();
        manager.register_runtime(Box::new(runtime));

        let descriptor = manager
            .list_runtimes()
            .into_iter()
            .find(|item| item.runtime.id == "mock-runtime")
            .expect("runtime should be listed");

        assert!(descriptor
            .runtime
            .capabilities
            .iter()
            .any(|capability| capability == "user_input"));
    }

    #[test]
    fn manager_registers_kilo_runtime_by_default() {
        let manager = AiManager::new();

        assert!(manager
            .list_runtimes()
            .iter()
            .any(|descriptor| descriptor.runtime.id == KILO_RUNTIME_ID));
    }

    #[test]
    fn folder_attachments_only_include_relative_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "neverwrite-folder-attachment-test-{}",
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
