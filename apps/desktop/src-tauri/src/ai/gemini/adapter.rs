use std::{collections::HashMap, path::PathBuf};

use tauri::AppHandle;
use vault_ai_ai::{AiRuntimeSetupStatus, AiSession, AiSessionStatus, GEMINI_RUNTIME_ID};

use crate::ai::runtime::{AiRuntimeAdapter, AiRuntimeCapabilities, AiRuntimeSetupInput};

use super::{
    clear_authenticated_method, mark_authenticated_method, save_setup_config, GeminiRuntime,
    GeminiRuntimeHandle, GeminiSessionState, GeminiSetupInput,
};

#[derive(Debug, Clone)]
struct GeminiManagedSession {
    session: AiSession,
    acp_model_ids: HashMap<String, String>,
}

#[derive(Debug, Default)]
pub struct GeminiRuntimeAdapter {
    runtime: GeminiRuntime,
    handle: Option<GeminiRuntimeHandle>,
    sessions: HashMap<String, GeminiManagedSession>,
}

impl AiRuntimeAdapter for GeminiRuntimeAdapter {
    fn runtime_id(&self) -> &'static str {
        GEMINI_RUNTIME_ID
    }

    fn descriptor(&self) -> vault_ai_ai::AiRuntimeDescriptor {
        self.runtime.descriptor()
    }

    fn capabilities(&self) -> AiRuntimeCapabilities {
        AiRuntimeCapabilities {
            create_session: true,
            resume_session: true,
            ..AiRuntimeCapabilities::default()
        }
    }

    fn setup_status(&self, app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
        self.runtime.setup_status(app)
    }

    fn update_setup(
        &mut self,
        app: &AppHandle,
        input: AiRuntimeSetupInput,
    ) -> Result<AiRuntimeSetupStatus, String> {
        let input: GeminiSetupInput = input.into_gemini()?;
        let _ = save_setup_config(app, input)?;
        self.runtime.setup_status(app)
    }

    fn start_auth(
        &mut self,
        app: &AppHandle,
        method_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiRuntimeSetupStatus, String> {
        if method_id == "use_gemini" {
            let status = self.runtime.setup_status(app)?;
            if status.auth_method.as_deref() != Some("use_gemini")
                && !std::env::var("GEMINI_API_KEY")
                    .ok()
                    .is_some_and(|value| !value.trim().is_empty())
            {
                if !super::setup::has_gemini_api_key(app)? {
                    return Err("Enter a Gemini API key before continuing.".to_string());
                }
            }
        }

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

        let session = map_managed_session(created);
        let ai_session = session.session.clone();
        self.sessions.insert(ai_session.session_id.clone(), session);
        Ok(ai_session)
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

        let session = map_managed_session(loaded);
        let ai_session = session.session.clone();
        self.sessions.insert(ai_session.session_id.clone(), session);
        Ok(ai_session)
    }

    fn resume_session(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        self.load_session(app, session_id, vault_root)
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
            return Err(format!("Modelo no soportado por Gemini ACP: {model_id}"));
        }

        let acp_model_id = managed
            .acp_model_ids
            .get(model_id)
            .cloned()
            .unwrap_or_else(|| model_id.to_string());
        self.handle_from_session(session_id)?
            .set_model(session_id, &acp_model_id)?;

        let managed = self.session_mut(session_id)?;
        managed.session.model_id = model_id.to_string();
        if let Some(option) = managed
            .session
            .config_options
            .iter_mut()
            .find(|option| option.id == "model")
        {
            option.value = model_id.to_string();
        }
        Ok(managed.session.clone())
    }

    fn set_mode(&mut self, session_id: &str, mode_id: &str) -> Result<AiSession, String> {
        let supports_mode = self
            .sessions
            .get(session_id)
            .map(|managed| managed.session.modes.iter().any(|mode| mode.id == mode_id))
            .unwrap_or(false);
        if !supports_mode {
            return Err(format!("Modo no soportado por Gemini ACP: {mode_id}"));
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
                "Opcion invalida para Gemini ACP: {option_id}={value}"
            ));
        }

        self.handle_from_session(session_id)?
            .set_config_option(session_id, option_id, value)?;

        let managed = self.session_mut(session_id)?;
        let option = managed
            .session
            .config_options
            .iter_mut()
            .find(|item| item.id == option_id)
            .ok_or_else(|| format!("Opcion no encontrada: {option_id}"))?;
        option.value = value.to_string();
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
        _session_id: &str,
        _request_id: &str,
        _answers: HashMap<String, Vec<String>>,
    ) -> Result<AiSession, String> {
        Err("Gemini ACP no soporta user_input en NeverWrite.".to_string())
    }
}

impl GeminiRuntimeAdapter {
    fn handle(&mut self, app: &AppHandle) -> GeminiRuntimeHandle {
        if let Some(handle) = self.handle.as_ref() {
            return handle.clone();
        }

        let handle = GeminiRuntimeHandle::spawn(app.clone());
        self.handle = Some(handle.clone());
        handle
    }

    fn handle_from_session(&self, session_id: &str) -> Result<GeminiRuntimeHandle, String> {
        if !self.sessions.contains_key(session_id) {
            return Err(format!("Sesion AI no encontrada: {session_id}"));
        }

        self.handle
            .clone()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut GeminiManagedSession, String> {
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

fn map_managed_session(state: GeminiSessionState) -> GeminiManagedSession {
    let session = AiSession {
        session_id: state.session_id.clone(),
        runtime_id: GEMINI_RUNTIME_ID.to_string(),
        model_id: state.model_id,
        mode_id: state.mode_id,
        status: AiSessionStatus::Idle,
        efforts_by_model: state.efforts_by_model.clone(),
        models: state.models,
        modes: state.modes,
        config_options: state.config_options,
    };

    GeminiManagedSession {
        session,
        acp_model_ids: state.acp_model_ids,
    }
}

fn is_authentication_error(message: &str) -> bool {
    let normalized = message.trim().to_lowercase();
    normalized.contains("auth_required")
        || normalized.contains("authentication required")
        || normalized.contains("api key")
}
