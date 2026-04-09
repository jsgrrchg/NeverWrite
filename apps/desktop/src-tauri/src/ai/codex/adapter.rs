use std::{collections::HashMap, path::PathBuf};

use neverwrite_ai::{
    AiConfigOption, AiConfigOptionCategory, AiConfigSelectOption, AiRuntimeSessionSummary,
    AiSession, AiSessionStatus, CODEX_RUNTIME_ID,
};
use tauri::AppHandle;

use crate::ai::runtime::{AiRuntimeAdapter, AiRuntimeCapabilities, AiRuntimeSetupInput};

use super::{
    clear_authenticated_method, mark_authenticated_method, save_setup_config, CodexRuntime,
    CodexRuntimeHandle, CodexSetupInput,
};

#[derive(Debug, Clone)]
struct CodexManagedSession {
    session: AiSession,
    efforts_by_model: HashMap<String, Vec<String>>,
    acp_model_ids: HashMap<String, String>,
}

#[derive(Debug, Default)]
pub struct CodexRuntimeAdapter {
    runtime: CodexRuntime,
    handle: Option<CodexRuntimeHandle>,
    sessions: HashMap<String, CodexManagedSession>,
}

impl AiRuntimeAdapter for CodexRuntimeAdapter {
    fn runtime_id(&self) -> &'static str {
        CODEX_RUNTIME_ID
    }

    fn descriptor(&self) -> neverwrite_ai::AiRuntimeDescriptor {
        self.runtime.descriptor()
    }

    fn capabilities(&self) -> AiRuntimeCapabilities {
        AiRuntimeCapabilities {
            create_session: true,
            list_sessions: true,
            terminal_output: true,
            user_input: true,
            ..AiRuntimeCapabilities::default()
        }
    }

    fn setup_status(&self, app: &AppHandle) -> Result<neverwrite_ai::AiRuntimeSetupStatus, String> {
        self.runtime.setup_status(app)
    }

    fn update_setup(
        &mut self,
        app: &AppHandle,
        input: AiRuntimeSetupInput,
    ) -> Result<neverwrite_ai::AiRuntimeSetupStatus, String> {
        let input: CodexSetupInput = input.into_codex()?;
        let _ = save_setup_config(app, input)?;
        self.runtime.setup_status(app)
    }

    fn start_auth(
        &mut self,
        app: &AppHandle,
        method_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<neverwrite_ai::AiRuntimeSetupStatus, String> {
        let process_spec = self.runtime.process_spec(app, vault_root)?;
        self.handle(app).authenticate(process_spec, method_id)?;
        let _ = mark_authenticated_method(app, method_id)?;
        self.runtime.setup_status(app)
    }

    fn create_session(
        &mut self,
        app: &AppHandle,
        vault_root: Option<PathBuf>,
        _additional_roots: Option<Vec<String>>,
    ) -> Result<AiSession, String> {
        let process_spec = self.runtime.process_spec(app, vault_root)?;
        let created = match self.handle(app).create_session(process_spec) {
            Ok(session) => session,
            Err(error) => {
                self.invalidate_auth_if_needed(app, &error);
                return Err(error);
            }
        };

        let config_options = filter_effort_options(
            created.config_options,
            &created.model_id,
            &created.efforts_by_model,
        );
        let session = AiSession {
            session_id: created.session_id.clone(),
            runtime_id: CODEX_RUNTIME_ID.to_string(),
            model_id: created.model_id,
            mode_id: created.mode_id,
            status: AiSessionStatus::Idle,
            efforts_by_model: created.efforts_by_model.clone(),
            models: created.models,
            modes: created.modes,
            config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            CodexManagedSession {
                session: session.clone(),
                efforts_by_model: created.efforts_by_model,
                acp_model_ids: created.acp_model_ids,
            },
        );

        Ok(session)
    }

    fn get_session(&self, session_id: &str) -> Option<AiSession> {
        self.sessions
            .get(session_id)
            .map(|managed| managed.session.clone())
    }

    fn sync_state(&mut self) -> Result<(), String> {
        if let Some(handle) = self.handle.as_ref() {
            if let Err(error) = handle.check_health() {
                self.sessions.clear();
                return Err(error);
            }
        }
        Ok(())
    }

    fn remove_session(&mut self, session_id: &str) {
        if let Some(handle) = self.handle.as_ref() {
            let _ = handle.close_session(session_id);
            handle.clear_session_state(session_id);
        }
        self.sessions.remove(session_id);
    }

    fn list_runtime_sessions(
        &mut self,
        app: &AppHandle,
        vault_root: Option<&PathBuf>,
    ) -> Result<Vec<AiRuntimeSessionSummary>, String> {
        let process_spec = self.runtime.process_spec(app, vault_root.cloned())?;
        self.handle(app).list_sessions(process_spec)
    }

    fn load_session(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        if let Some(session) = self.get_session(session_id) {
            return Ok(session);
        }

        let process_spec = self.runtime.process_spec(app, vault_root)?;
        let loaded = match self.handle(app).load_session(process_spec, session_id) {
            Ok(session) => session,
            Err(error) => {
                self.invalidate_auth_if_needed(app, &error);
                return Err(error);
            }
        };

        let config_options = filter_effort_options(
            loaded.config_options,
            &loaded.model_id,
            &loaded.efforts_by_model,
        );
        let session = AiSession {
            session_id: loaded.session_id.clone(),
            runtime_id: CODEX_RUNTIME_ID.to_string(),
            model_id: loaded.model_id,
            mode_id: loaded.mode_id,
            status: AiSessionStatus::Idle,
            efforts_by_model: loaded.efforts_by_model.clone(),
            models: loaded.models,
            modes: loaded.modes,
            config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            CodexManagedSession {
                session: session.clone(),
                efforts_by_model: loaded.efforts_by_model,
                acp_model_ids: loaded.acp_model_ids,
            },
        );

        Ok(session)
    }

    fn set_model(&mut self, session_id: &str, model_id: &str) -> Result<AiSession, String> {
        let managed = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Sesion AI no encontrada: {session_id}"))?;

        if !managed
            .session
            .models
            .iter()
            .any(|model| model.id == model_id)
        {
            return Err(format!("Modelo no soportado por Codex ACP: {model_id}"));
        }

        let current_effort = managed
            .session
            .config_options
            .iter()
            .find(|option| option.id == "reasoning_effort")
            .map(|option| option.value.clone())
            .unwrap_or_else(|| "medium".to_string());
        let available_efforts = managed.efforts_by_model.get(model_id);
        let effort = match available_efforts {
            Some(levels) if levels.contains(&current_effort) => current_effort,
            Some(levels) => levels.first().cloned().unwrap_or(current_effort),
            None => current_effort,
        };
        let acp_base = managed
            .acp_model_ids
            .get(model_id)
            .cloned()
            .unwrap_or_else(|| model_id.to_string());
        let acp_model_id = format!("{acp_base}/{effort}");

        self.handle_from_session(session_id)?
            .set_model(session_id, &acp_model_id)?;

        let managed = self.session_mut(session_id)?;
        sync_model_selection(&mut managed.session, model_id, &managed.efforts_by_model);
        Ok(managed.session.clone())
    }

    fn set_mode(&mut self, session_id: &str, mode_id: &str) -> Result<AiSession, String> {
        let supports_mode = self
            .sessions
            .get(session_id)
            .map(|managed| managed.session.modes.iter().any(|mode| mode.id == mode_id))
            .unwrap_or(false);
        if !supports_mode {
            return Err(format!("Modo no soportado por Codex ACP: {mode_id}"));
        }

        self.handle_from_session(session_id)?
            .set_mode(session_id, mode_id)?;
        let managed = self.session_mut(session_id)?;
        managed.session.mode_id = mode_id.to_string();
        Ok(managed.session.clone())
    }

    fn set_config_option(
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

        self.handle_from_session(session_id)?
            .set_config_option(session_id, option_id, value)?;

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
            self.handle_from_session(session_id)?
                .set_model(session_id, &acp_model_id)?;
        }

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

        Ok(managed.session.clone())
    }

    fn cancel_turn(&mut self, session_id: &str) -> Result<AiSession, String> {
        self.handle_from_session(session_id)?.cancel(session_id)?;
        let managed = self.session_mut(session_id)?;
        managed.session.status = AiSessionStatus::Idle;
        Ok(managed.session.clone())
    }

    fn send_message(
        &mut self,
        session_id: &str,
        prompt: &str,
        app: &AppHandle,
    ) -> Result<AiSession, String> {
        if let Err(error) =
            self.handle_from_session(session_id)?
                .prompt_async(session_id, prompt, app.clone())
        {
            self.invalidate_auth_if_needed(app, &error);
            return Err(error);
        }

        let managed = self.session_mut(session_id)?;
        managed.session.status = AiSessionStatus::Streaming;
        Ok(managed.session.clone())
    }

    fn respond_permission(
        &mut self,
        session_id: &str,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<AiSession, String> {
        self.handle_from_session(session_id)?
            .respond_permission(request_id, option_id)?;
        let managed = self.session_mut(session_id)?;
        managed.session.status = AiSessionStatus::Streaming;
        Ok(managed.session.clone())
    }

    fn respond_user_input(
        &mut self,
        session_id: &str,
        request_id: &str,
        answers: HashMap<String, Vec<String>>,
    ) -> Result<AiSession, String> {
        self.handle_from_session(session_id)?
            .respond_user_input(session_id, request_id, answers)?;
        let managed = self.session_mut(session_id)?;
        managed.session.status = AiSessionStatus::Streaming;
        Ok(managed.session.clone())
    }
}

impl CodexRuntimeAdapter {
    fn handle(&mut self, app: &AppHandle) -> CodexRuntimeHandle {
        if let Some(handle) = self.handle.as_ref() {
            return handle.clone();
        }

        let handle = CodexRuntimeHandle::spawn(app.clone());
        self.handle = Some(handle.clone());
        handle
    }

    fn handle_from_session(&self, session_id: &str) -> Result<CodexRuntimeHandle, String> {
        if !self.sessions.contains_key(session_id) {
            return Err(format!("Sesion AI no encontrada: {session_id}"));
        }

        self.handle
            .clone()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut CodexManagedSession, String> {
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

fn is_authentication_error(message: &str) -> bool {
    let normalized = message.trim().to_lowercase();
    normalized.contains("auth_required") || normalized.contains("authentication required")
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
