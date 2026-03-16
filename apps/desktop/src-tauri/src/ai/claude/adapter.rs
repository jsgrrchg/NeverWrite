use std::{collections::HashMap, path::PathBuf};

use tauri::AppHandle;
use vault_ai_ai::{AiRuntimeSessionSummary, AiSession, AiSessionStatus, CLAUDE_RUNTIME_ID};

use crate::ai::runtime::{AiRuntimeAdapter, AiRuntimeCapabilities, AiRuntimeSetupInput};

use super::{
    client::ClaudeRuntimeHandle,
    process::ClaudeRuntime,
    setup::{
        clear_authenticated_method, clear_gateway_settings, launch_claude_login, load_setup_config,
        mark_authenticated_method, save_setup_config,
    },
    ClaudeSetupInput,
};

#[derive(Debug, Clone)]
struct ClaudeManagedSession {
    session: AiSession,
}

#[derive(Debug, Default)]
pub struct ClaudeRuntimeAdapter {
    runtime: ClaudeRuntime,
    handle: Option<ClaudeRuntimeHandle>,
    sessions: HashMap<String, ClaudeManagedSession>,
}

impl AiRuntimeAdapter for ClaudeRuntimeAdapter {
    fn runtime_id(&self) -> &'static str {
        CLAUDE_RUNTIME_ID
    }

    fn descriptor(&self) -> vault_ai_ai::AiRuntimeDescriptor {
        self.runtime.descriptor()
    }

    fn capabilities(&self) -> AiRuntimeCapabilities {
        AiRuntimeCapabilities {
            create_session: true,
            fork_session: true,
            resume_session: true,
            list_sessions: true,
            prompt_queueing: true,
            terminal_output: true,
            ..AiRuntimeCapabilities::default()
        }
    }

    fn setup_status(&self, app: &AppHandle) -> Result<vault_ai_ai::AiRuntimeSetupStatus, String> {
        self.runtime.setup_status(app)
    }

    fn update_setup(
        &mut self,
        app: &AppHandle,
        input: AiRuntimeSetupInput,
    ) -> Result<vault_ai_ai::AiRuntimeSetupStatus, String> {
        let input: ClaudeSetupInput = input.into_claude()?;
        let _ = save_setup_config(app, input)?;
        self.runtime.setup_status(app)
    }

    fn start_auth(
        &mut self,
        app: &AppHandle,
        method_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<vault_ai_ai::AiRuntimeSetupStatus, String> {
        match method_id {
            "gateway" => {
                let config = load_setup_config(app)?;
                if config
                    .anthropic_base_url
                    .as_ref()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    return Err(
                        "Enter a gateway base URL before continuing with gateway authentication."
                            .to_string(),
                    );
                }

                let _ = mark_authenticated_method(app, "gateway")?;
                self.runtime.setup_status(app)
            }
            "claude-login" => {
                let _ = clear_gateway_settings(app)?;
                let resolved = self.runtime.resolved_binary(app)?;
                launch_claude_login(&resolved, vault_root.as_deref())?;
                let mut status = self.runtime.setup_status(app)?;
                status.message = Some(
                    "Claude login opened in a terminal. Finish signing in there, then start a new Claude chat to refresh setup."
                        .to_string(),
                );
                Ok(status)
            }
            other => Err(format!("Unsupported Claude auth method: {other}")),
        }
    }

    fn create_session(
        &mut self,
        app: &AppHandle,
        vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        let process_spec = self.runtime.process_spec(app, vault_root)?;
        let created = match self.handle(app).create_session(process_spec) {
            Ok(session) => session,
            Err(error) => {
                self.invalidate_auth_if_needed(app, &error);
                return Err(error);
            }
        };

        let session = AiSession {
            session_id: created.session_id.clone(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            model_id: created.model_id,
            mode_id: created.mode_id,
            status: AiSessionStatus::Idle,
            efforts_by_model: created.efforts_by_model,
            models: created.models,
            modes: created.modes,
            config_options: created.config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            ClaudeManagedSession {
                session: session.clone(),
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

        let session = AiSession {
            session_id: loaded.session_id.clone(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            model_id: loaded.model_id,
            mode_id: loaded.mode_id,
            status: AiSessionStatus::Idle,
            efforts_by_model: loaded.efforts_by_model,
            models: loaded.models,
            modes: loaded.modes,
            config_options: loaded.config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            ClaudeManagedSession {
                session: session.clone(),
            },
        );

        Ok(session)
    }

    fn resume_session(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        let process_spec = self.runtime.process_spec(app, vault_root.clone())?;
        let resumed = match self
            .handle(app)
            .resume_session(process_spec.clone(), session_id)
        {
            Ok(session) => session,
            Err(error) if should_fallback_to_load_session(&error) => {
                match self.handle(app).load_session(process_spec, session_id) {
                    Ok(session) => session,
                    Err(load_error) => {
                        self.invalidate_auth_if_needed(app, &load_error);
                        return Err(load_error);
                    }
                }
            }
            Err(error) => {
                self.invalidate_auth_if_needed(app, &error);
                return Err(error);
            }
        };

        let session = AiSession {
            session_id: resumed.session_id.clone(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            model_id: resumed.model_id,
            mode_id: resumed.mode_id,
            status: AiSessionStatus::Idle,
            efforts_by_model: resumed.efforts_by_model,
            models: resumed.models,
            modes: resumed.modes,
            config_options: resumed.config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            ClaudeManagedSession {
                session: session.clone(),
            },
        );

        Ok(session)
    }

    fn fork_session(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        vault_root: Option<PathBuf>,
    ) -> Result<AiSession, String> {
        let process_spec = self.runtime.process_spec(app, vault_root)?;
        let forked = match self.handle(app).fork_session(process_spec, session_id) {
            Ok(session) => session,
            Err(error) => {
                self.invalidate_auth_if_needed(app, &error);
                return Err(error);
            }
        };

        let session = AiSession {
            session_id: forked.session_id.clone(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            model_id: forked.model_id,
            mode_id: forked.mode_id,
            status: AiSessionStatus::Idle,
            efforts_by_model: forked.efforts_by_model,
            models: forked.models,
            modes: forked.modes,
            config_options: forked.config_options,
        };

        self.sessions.insert(
            session.session_id.clone(),
            ClaudeManagedSession {
                session: session.clone(),
            },
        );

        Ok(session)
    }

    fn set_model(&mut self, session_id: &str, model_id: &str) -> Result<AiSession, String> {
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
            return Err(format!("Modelo no soportado por Claude ACP: {model_id}"));
        }

        self.handle_from_session(session_id)?
            .set_model(session_id, model_id)?;

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
            return Err(format!("Modo no soportado por Claude ACP: {mode_id}"));
        }

        self.handle_from_session(session_id)?
            .set_mode(session_id, mode_id)?;
        let managed = self.session_mut(session_id)?;
        managed.session.mode_id = mode_id.to_string();
        if let Some(option) = managed
            .session
            .config_options
            .iter_mut()
            .find(|option| option.id == "mode")
        {
            option.value = mode_id.to_string();
        }
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
                "Opcion invalida para Claude ACP: {option_id}={value}"
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

        if option_id == "model" {
            managed.session.model_id = value.to_string();
        } else if option_id == "mode" {
            managed.session.mode_id = value.to_string();
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
        _session_id: &str,
        _request_id: &str,
        _answers: HashMap<String, Vec<String>>,
    ) -> Result<AiSession, String> {
        Err("Claude does not support user input requests in this build.".to_string())
    }
}

impl ClaudeRuntimeAdapter {
    fn handle(&mut self, app: &AppHandle) -> ClaudeRuntimeHandle {
        if let Some(handle) = self.handle.as_ref() {
            return handle.clone();
        }

        let handle = ClaudeRuntimeHandle::spawn(app.clone());
        self.handle = Some(handle.clone());
        handle
    }

    fn handle_from_session(&self, session_id: &str) -> Result<ClaudeRuntimeHandle, String> {
        if !self.sessions.contains_key(session_id) {
            return Err(format!("Sesion AI no encontrada: {session_id}"));
        }

        self.handle
            .clone()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut ClaudeManagedSession, String> {
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
    normalized.contains("auth_required")
        || normalized.contains("authentication required")
        || normalized.contains("you were signed out")
        || normalized.contains("reconnect claude")
}

fn should_fallback_to_load_session(message: &str) -> bool {
    let normalized = message.trim().to_lowercase();
    normalized.contains("session/resume")
        && (normalized.contains("method not found")
            || normalized.contains("unsupported")
            || normalized.contains("not supported"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_signed_out_copy_as_authentication_error() {
        assert!(is_authentication_error(
            "You were signed out. Reconnect Claude to continue."
        ));
    }

    #[test]
    fn recognizes_acp_resume_errors_for_load_fallback() {
        assert!(should_fallback_to_load_session(
            "session/resume method not supported by this ACP runtime"
        ));
    }
}
