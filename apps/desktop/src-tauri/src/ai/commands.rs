use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use serde::Deserialize;
use tauri::{AppHandle, State};
use vault_ai_ai::{
    AiRuntimeDescriptor, AiRuntimeSessionSummary, AiRuntimeSetupStatus, AiSession,
    CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID,
};

use super::{
    claude::ClaudeSetupInput,
    codex::CodexSetupInput,
    emit::{emit_session_created, emit_session_error, emit_session_updated},
    manager::{AiAttachmentInput, AiManager},
    persistence::{self, PersistedSessionHistory},
    runtime::AiRuntimeSetupInput,
};

fn require_runtime_id(runtime_id: Option<String>, command_name: &str) -> Result<String, String> {
    runtime_id.ok_or_else(|| format!("{command_name} requiere runtimeId explícito"))
}

#[derive(Debug, Deserialize)]
pub struct AiSetConfigOptionInput {
    pub session_id: String,
    pub option_id: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct AiRespondPermissionInput {
    pub session_id: String,
    pub request_id: String,
    pub option_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AiRespondUserInputInput {
    pub session_id: String,
    pub request_id: String,
    pub answers: HashMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct AiStartAuthInput {
    #[serde(rename = "runtimeId")]
    pub runtime_id: Option<String>,
    pub method_id: String,
}

#[derive(Debug, Deserialize)]
pub struct AiRuntimeSetupPayload {
    pub custom_binary_path: Option<String>,
    pub codex_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub anthropic_custom_headers: Option<String>,
    pub anthropic_auth_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AiRuntimeSessionInput {
    pub runtime_id: String,
    pub session_id: String,
}

#[tauri::command]
pub fn ai_get_setup_status(
    runtime_id: Option<String>,
    app: AppHandle,
    state: State<Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let runtime_id = require_runtime_id(runtime_id, "ai_get_setup_status")?;
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.runtime_setup_status(&app, &runtime_id)
}

#[tauri::command]
pub fn ai_update_setup(
    input: AiRuntimeSetupPayload,
    runtime_id: Option<String>,
    app: AppHandle,
    state: State<Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let runtime_id = require_runtime_id(runtime_id, "ai_update_setup")?;
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.update_runtime_setup(&app, &runtime_id, map_setup_input(&runtime_id, input)?)
}

#[tauri::command]
pub fn ai_start_auth(
    input: AiStartAuthInput,
    vault_path: Option<String>,
    app: AppHandle,
    state: State<Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let runtime_id = require_runtime_id(input.runtime_id, "ai_start_auth")?;
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.start_runtime_auth(&app, &runtime_id, &input.method_id, vault_root)
}

fn map_setup_input(
    runtime_id: &str,
    input: AiRuntimeSetupPayload,
) -> Result<AiRuntimeSetupInput, String> {
    match runtime_id {
        CODEX_RUNTIME_ID => Ok(AiRuntimeSetupInput::Codex(CodexSetupInput {
            custom_binary_path: input.custom_binary_path,
            codex_api_key: input.codex_api_key,
            openai_api_key: input.openai_api_key,
        })),
        CLAUDE_RUNTIME_ID => Ok(AiRuntimeSetupInput::Claude(ClaudeSetupInput {
            custom_binary_path: input.custom_binary_path,
            anthropic_base_url: input.anthropic_base_url,
            anthropic_custom_headers: input.anthropic_custom_headers,
            anthropic_auth_token: input.anthropic_auth_token,
        })),
        other => Err(format!("Runtime no soportado: {other}")),
    }
}

#[tauri::command]
pub fn ai_list_runtimes(
    state: State<Mutex<AiManager>>,
) -> Result<Vec<AiRuntimeDescriptor>, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    Ok(state.list_runtimes())
}

#[tauri::command]
pub fn ai_list_runtime_sessions(
    runtime_id: String,
    vault_path: Option<String>,
    app: AppHandle,
    state: State<Mutex<AiManager>>,
) -> Result<Vec<AiRuntimeSessionSummary>, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.list_runtime_sessions(&runtime_id, vault_root.as_ref(), &app)
}

#[tauri::command]
pub fn ai_list_sessions(
    vault_path: Option<String>,
    state: State<Mutex<AiManager>>,
) -> Result<Vec<AiSession>, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    Ok(state.list_sessions(vault_root.as_ref()))
}

#[tauri::command]
pub fn ai_load_session(
    session_id: String,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.load_session(&session_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_load_runtime_session(
    input: AiRuntimeSessionInput,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session =
        ai_state.load_runtime_session(&input.runtime_id, &input.session_id, vault_root, &app)?;
    emit_session_created(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_resume_runtime_session(
    input: AiRuntimeSessionInput,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session =
        ai_state.resume_runtime_session(&input.runtime_id, &input.session_id, vault_root, &app)?;
    emit_session_created(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_fork_runtime_session(
    input: AiRuntimeSessionInput,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session =
        ai_state.fork_runtime_session(&input.runtime_id, &input.session_id, vault_root, &app)?;
    emit_session_created(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_create_session(
    runtime_id: String,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.create_session(&runtime_id, vault_root, &app)?;
    emit_session_created(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_set_model(
    session_id: String,
    model_id: String,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.set_model(&session_id, &model_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_set_mode(
    session_id: String,
    mode_id: String,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.set_mode(&session_id, &mode_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_set_config_option(
    input: AiSetConfigOptionInput,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.set_config_option(&input.session_id, &input.option_id, &input.value)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_cancel_turn(
    session_id: String,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.cancel_turn(&session_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_send_message(
    session_id: String,
    content: String,
    attachments: Vec<AiAttachmentInput>,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    match ai_state.send_message(&session_id, &content, &attachments, &app) {
        Ok(session) => {
            emit_session_updated(&app, &session);
            Ok(session)
        }
        Err(error) => {
            emit_session_error(&app, Some(session_id), error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub fn ai_respond_permission(
    input: AiRespondPermissionInput,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.respond_permission(
        &input.session_id,
        &input.request_id,
        input.option_id.as_deref(),
    )?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_respond_user_input(
    input: AiRespondUserInputInput,
    app: AppHandle,
    ai_state: State<Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session =
        ai_state.respond_user_input(&input.session_id, &input.request_id, input.answers)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub fn ai_save_session_history(
    vault_path: String,
    history: PersistedSessionHistory,
) -> Result<(), String> {
    persistence::save_session_history(&PathBuf::from(vault_path), &history)
}

#[tauri::command]
pub fn ai_load_session_histories(
    vault_path: String,
) -> Result<Vec<PersistedSessionHistory>, String> {
    persistence::load_all_session_histories(&PathBuf::from(vault_path))
}

#[tauri::command]
pub fn ai_delete_session_history(vault_path: String, session_id: String) -> Result<(), String> {
    persistence::delete_session_history(&PathBuf::from(vault_path), &session_id)
}

#[tauri::command]
pub fn ai_delete_all_session_histories(vault_path: String) -> Result<(), String> {
    persistence::delete_all_session_histories(&PathBuf::from(vault_path))
}

#[tauri::command]
pub fn ai_delete_runtime_session(
    session_id: String,
    ai_state: State<Mutex<AiManager>>,
) -> Result<(), String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    ai_state.remove_session(&session_id)
}

#[tauri::command]
pub fn ai_delete_runtime_sessions_for_vault(
    vault_path: Option<String>,
    ai_state: State<Mutex<AiManager>>,
) -> Result<(), String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    ai_state.remove_sessions_for_vault(vault_root.as_ref());
    Ok(())
}

#[tauri::command]
pub fn ai_prune_session_histories(vault_path: String, max_age_days: u32) -> Result<usize, String> {
    persistence::prune_expired_session_histories(&PathBuf::from(vault_path), max_age_days)
}

#[tauri::command]
pub fn ai_register_file_baseline(
    session_id: String,
    display_path: String,
    content: String,
    ai_state: State<Mutex<AiManager>>,
) -> Result<(), String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    ai_state.register_file_baseline(&session_id, &display_path, content)
}
