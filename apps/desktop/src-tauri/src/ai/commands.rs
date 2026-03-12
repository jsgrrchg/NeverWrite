use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use serde::Deserialize;
use tauri::{AppHandle, State};
use vault_ai_ai::{AiRuntimeDescriptor, AiRuntimeSetupStatus, AiSession};

use super::{
    codex::CodexSetupInput,
    emit::{emit_session_created, emit_session_error, emit_session_updated},
    manager::{AiAttachmentInput, AiManager},
    persistence::{self, PersistedSessionHistory},
};

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
    pub method_id: String,
}

#[tauri::command]
pub fn ai_get_setup_status(
    app: AppHandle,
    state: State<Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.codex_setup_status(&app)
}

#[tauri::command]
pub fn ai_update_setup(
    input: CodexSetupInput,
    app: AppHandle,
    state: State<Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.save_codex_setup(&app, input)
}

#[tauri::command]
pub fn ai_start_auth(
    input: AiStartAuthInput,
    vault_path: Option<String>,
    app: AppHandle,
    state: State<Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.start_codex_auth(&app, &input.method_id, vault_root)
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
pub fn ai_list_sessions(
    vault_path: Option<String>,
    state: State<Mutex<AiManager>>,
) -> Result<Vec<AiSession>, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let state = state
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
pub fn ai_prune_session_histories(vault_path: String, max_age_days: u32) -> Result<usize, String> {
    persistence::prune_expired_session_histories(&PathBuf::from(vault_path), max_age_days)
}
