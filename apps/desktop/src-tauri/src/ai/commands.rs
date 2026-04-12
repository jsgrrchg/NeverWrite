use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use neverwrite_ai::{
    AiRuntimeDescriptor, AiRuntimeSessionSummary, AiRuntimeSetupStatus, AiSession,
    CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, GEMINI_RUNTIME_ID, KILO_RUNTIME_ID,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::AppState;

use super::{
    catalog::diagnostic_executable_names,
    claude::{ClaudeRuntime, ClaudeSetupInput},
    codex::{CodexRuntime, CodexSetupInput},
    emit::{emit_session_created, emit_session_error, emit_session_updated},
    env::{
        find_program_on_preferred_path, inherited_path_value, preferred_path_entries,
        preferred_path_value,
    },
    gemini::{GeminiRuntime, GeminiSetupInput},
    kilo::{KiloRuntime, KiloSetupInput},
    manager::{AiAttachmentInput, AiManager},
    persistence::{
        self, PersistedSessionHistory, PersistedSessionHistoryPage, SessionSearchResult,
    },
    runtime::AiRuntimeSetupInput,
    secret_store::SecretValuePatch,
};

fn require_runtime_id(runtime_id: Option<String>, command_name: &str) -> Result<String, String> {
    runtime_id.ok_or_else(|| format!("{command_name} requiere runtimeId explícito"))
}

// `vault_path` is treated as a logical key from the renderer, not as a filesystem root.
fn resolve_ai_history_vault_root(state: &AppState, vault_key: &str) -> Result<PathBuf, String> {
    let instance = state.vaults.get(vault_key).ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    Ok(vault.root.clone())
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
    #[serde(default)]
    pub codex_api_key: SecretValuePatch,
    #[serde(default)]
    pub openai_api_key: SecretValuePatch,
    #[serde(default)]
    pub gemini_api_key: SecretValuePatch,
    #[serde(default)]
    pub google_api_key: SecretValuePatch,
    pub google_cloud_project: Option<String>,
    pub google_cloud_location: Option<String>,
    pub gateway_base_url: Option<String>,
    #[serde(default)]
    pub gateway_headers: SecretValuePatch,
    pub anthropic_base_url: Option<String>,
    #[serde(default)]
    pub anthropic_custom_headers: SecretValuePatch,
    #[serde(default)]
    pub anthropic_auth_token: SecretValuePatch,
}

#[derive(Debug, Deserialize)]
pub struct AiRuntimeSessionInput {
    pub runtime_id: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct AiCreateSessionInput {
    pub runtime_id: String,
    pub additional_roots: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct AiResolvedExecutable {
    pub name: String,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AiRuntimeDiagnostic {
    pub runtime_id: String,
    pub runtime_name: String,
    pub setup_status: Option<AiRuntimeSetupStatus>,
    pub setup_error: Option<String>,
    pub launch_program: Option<String>,
    pub launch_args: Vec<String>,
    pub resolution_display: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AiEnvironmentDiagnostics {
    pub inherited_path: Option<String>,
    pub inherited_entries: Vec<String>,
    pub preferred_path: Option<String>,
    pub preferred_entries: Vec<String>,
    pub executables: Vec<AiResolvedExecutable>,
    pub runtimes: Vec<AiRuntimeDiagnostic>,
}

fn build_runtime_diagnostic(
    runtime_id: &str,
    runtime_name: &str,
    setup_status: Result<AiRuntimeSetupStatus, String>,
    launch_program: Option<String>,
    launch_args: Vec<String>,
    resolution_display: Option<String>,
) -> AiRuntimeDiagnostic {
    AiRuntimeDiagnostic {
        runtime_id: runtime_id.to_string(),
        runtime_name: runtime_name.to_string(),
        setup_status: setup_status.clone().ok(),
        setup_error: setup_status.as_ref().err().cloned(),
        launch_program,
        launch_args,
        resolution_display,
    }
}

#[tauri::command]
pub async fn ai_get_setup_status(
    runtime_id: Option<String>,
    app: AppHandle,
    state: State<'_, Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let runtime_id = require_runtime_id(runtime_id, "ai_get_setup_status")?;
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.runtime_setup_status(&app, &runtime_id)
}

#[tauri::command]
pub async fn ai_get_environment_diagnostics(
    app: AppHandle,
) -> Result<AiEnvironmentDiagnostics, String> {
    let inherited_path = inherited_path_value().map(|value| value.to_string_lossy().into_owned());
    let inherited_entries = inherited_path
        .as_deref()
        .map(|raw| {
            std::env::split_paths(raw)
                .map(|path| path.display().to_string())
                .collect()
        })
        .unwrap_or_default();
    let preferred_path = preferred_path_value().map(|value| value.to_string_lossy().into_owned());
    let preferred_entries = preferred_path_entries()
        .into_iter()
        .map(|path| path.display().to_string())
        .collect();

    let executables = diagnostic_executable_names()
        .iter()
        .map(|name| AiResolvedExecutable {
            name: (*name).to_string(),
            path: find_program_on_preferred_path(name).map(|path| path.display().to_string()),
        })
        .collect();

    let codex_runtime = CodexRuntime;
    let codex_setup = codex_runtime.setup_status(&app);
    let codex_spec = codex_runtime.process_spec(&app, None);
    let codex_resolution_display = codex_setup
        .as_ref()
        .ok()
        .and_then(|status| status.binary_path.clone());

    let claude_runtime = ClaudeRuntime;
    let claude_setup = claude_runtime.setup_status(&app);
    let claude_spec = claude_runtime.process_spec(&app, None);
    let claude_resolved = claude_runtime.resolved_binary(&app);

    let gemini_runtime = GeminiRuntime;
    let gemini_setup = gemini_runtime.setup_status(&app);
    let gemini_spec = gemini_runtime.process_spec(&app, None);
    let gemini_resolved = gemini_runtime.resolved_binary(&app);

    let kilo_runtime = KiloRuntime;
    let kilo_setup = kilo_runtime.setup_status(&app);
    let kilo_spec = kilo_runtime.process_spec(&app, None);
    let kilo_resolved = kilo_runtime.resolved_binary(&app);

    let runtimes = vec![
        build_runtime_diagnostic(
            CODEX_RUNTIME_ID,
            "Codex",
            codex_setup,
            codex_spec
                .as_ref()
                .ok()
                .map(|spec| spec.binary_path.display().to_string()),
            Vec::new(),
            codex_resolution_display,
        ),
        build_runtime_diagnostic(
            CLAUDE_RUNTIME_ID,
            "Claude",
            claude_setup,
            claude_spec.as_ref().ok().map(|spec| spec.program.clone()),
            claude_spec
                .as_ref()
                .ok()
                .map(|spec| spec.args.clone())
                .unwrap_or_default(),
            claude_resolved.ok().and_then(|resolved| resolved.display),
        ),
        build_runtime_diagnostic(
            GEMINI_RUNTIME_ID,
            "Gemini",
            gemini_setup,
            gemini_spec.as_ref().ok().map(|spec| spec.program.clone()),
            gemini_spec
                .as_ref()
                .ok()
                .map(|spec| spec.args.clone())
                .unwrap_or_default(),
            gemini_resolved.ok().and_then(|resolved| resolved.display),
        ),
        build_runtime_diagnostic(
            KILO_RUNTIME_ID,
            "Kilo",
            kilo_setup,
            kilo_spec.as_ref().ok().map(|spec| spec.program.clone()),
            kilo_spec
                .as_ref()
                .ok()
                .map(|spec| spec.args.clone())
                .unwrap_or_default(),
            kilo_resolved.ok().and_then(|resolved| resolved.display),
        ),
    ];

    Ok(AiEnvironmentDiagnostics {
        inherited_path,
        inherited_entries,
        preferred_path,
        preferred_entries,
        executables,
        runtimes,
    })
}

#[tauri::command]
pub async fn ai_update_setup(
    input: AiRuntimeSetupPayload,
    runtime_id: Option<String>,
    app: AppHandle,
    state: State<'_, Mutex<AiManager>>,
) -> Result<AiRuntimeSetupStatus, String> {
    let runtime_id = require_runtime_id(runtime_id, "ai_update_setup")?;
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.update_runtime_setup(&app, &runtime_id, map_setup_input(&runtime_id, input)?)
}

#[tauri::command]
pub async fn ai_start_auth(
    input: AiStartAuthInput,
    vault_path: Option<String>,
    app: AppHandle,
    state: State<'_, Mutex<AiManager>>,
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
        GEMINI_RUNTIME_ID => Ok(AiRuntimeSetupInput::Gemini(GeminiSetupInput {
            custom_binary_path: input.custom_binary_path,
            gemini_api_key: input.gemini_api_key,
            google_api_key: input.google_api_key,
            google_cloud_project: input.google_cloud_project,
            google_cloud_location: input.google_cloud_location,
            gateway_base_url: input.gateway_base_url,
            gateway_headers: input.gateway_headers,
        })),
        KILO_RUNTIME_ID => Ok(AiRuntimeSetupInput::Kilo(KiloSetupInput {
            custom_binary_path: input.custom_binary_path,
        })),
        other => Err(format!("Runtime no soportado: {other}")),
    }
}

#[tauri::command]
pub async fn ai_list_runtimes(
    state: State<'_, Mutex<AiManager>>,
) -> Result<Vec<AiRuntimeDescriptor>, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    Ok(state.list_runtimes())
}

#[tauri::command]
pub async fn ai_list_runtime_sessions(
    runtime_id: String,
    vault_path: Option<String>,
    app: AppHandle,
    state: State<'_, Mutex<AiManager>>,
) -> Result<Vec<AiRuntimeSessionSummary>, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    state.list_runtime_sessions(&runtime_id, vault_root.as_ref(), &app)
}

#[tauri::command]
pub async fn ai_list_sessions(
    vault_path: Option<String>,
    state: State<'_, Mutex<AiManager>>,
) -> Result<Vec<AiSession>, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    Ok(state.list_sessions(vault_root.as_ref()))
}

#[tauri::command]
pub async fn ai_load_session(
    session_id: String,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.load_session(&session_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn ai_load_runtime_session(
    input: AiRuntimeSessionInput,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
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
pub async fn ai_resume_runtime_session(
    input: AiRuntimeSessionInput,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
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
pub async fn ai_fork_runtime_session(
    input: AiRuntimeSessionInput,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
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
pub async fn ai_create_session(
    input: AiCreateSessionInput,
    vault_path: Option<String>,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session =
        ai_state.create_session(&input.runtime_id, vault_root, input.additional_roots, &app)?;
    emit_session_created(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn ai_set_model(
    session_id: String,
    model_id: String,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.set_model(&session_id, &model_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn ai_set_mode(
    session_id: String,
    mode_id: String,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.set_mode(&session_id, &mode_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn ai_set_config_option(
    input: AiSetConfigOptionInput,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.set_config_option(&input.session_id, &input.option_id, &input.value)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn ai_cancel_turn(
    session_id: String,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<AiSession, String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let session = ai_state.cancel_turn(&session_id)?;
    emit_session_updated(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn ai_send_message(
    session_id: String,
    content: String,
    attachments: Vec<AiAttachmentInput>,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
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
pub async fn ai_respond_permission(
    input: AiRespondPermissionInput,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
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
pub async fn ai_respond_user_input(
    input: AiRespondUserInputInput,
    app: AppHandle,
    ai_state: State<'_, Mutex<AiManager>>,
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
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::save_session_history(&vault_root, &history)
}

#[tauri::command]
pub fn ai_load_session_histories(
    vault_path: String,
    include_messages: Option<bool>,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<PersistedSessionHistory>, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::load_all_session_histories(&vault_root, include_messages.unwrap_or(true))
}

#[tauri::command]
pub fn ai_load_session_history_page(
    vault_path: String,
    session_id: String,
    start_index: usize,
    limit: usize,
    state: State<'_, Mutex<AppState>>,
) -> Result<PersistedSessionHistoryPage, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::load_session_history_page(&vault_root, &session_id, start_index, limit)
}

#[tauri::command]
pub fn ai_search_session_content(
    vault_path: String,
    query: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<SessionSearchResult>, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::search_session_content(&vault_root, &query)
}

#[tauri::command]
pub fn ai_fork_session_history(
    vault_path: String,
    source_session_id: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::fork_session_history(&vault_root, &source_session_id)
}

#[tauri::command]
pub fn ai_delete_session_history(
    vault_path: String,
    session_id: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::delete_session_history(&vault_root, &session_id)
}

#[tauri::command]
pub fn ai_delete_all_session_histories(
    vault_path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::delete_all_session_histories(&vault_root)
}

#[tauri::command]
pub async fn ai_delete_runtime_session(
    session_id: String,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<(), String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    ai_state.remove_session(&session_id)
}

#[tauri::command]
pub async fn ai_delete_runtime_sessions_for_vault(
    vault_path: Option<String>,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<(), String> {
    let vault_root = vault_path.map(PathBuf::from);
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    ai_state.remove_sessions_for_vault(vault_root.as_ref());
    Ok(())
}

#[tauri::command]
pub fn ai_prune_session_histories(
    vault_path: String,
    max_age_days: u32,
    state: State<'_, Mutex<AppState>>,
) -> Result<usize, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_ai_history_vault_root(&state, &vault_path)?;
    persistence::prune_expired_session_histories(&vault_root, max_age_days)
}

#[tauri::command]
pub async fn ai_register_file_baseline(
    session_id: String,
    display_path: String,
    content: String,
    ai_state: State<'_, Mutex<AiManager>>,
) -> Result<(), String> {
    let mut ai_state = ai_state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    ai_state.register_file_baseline(&session_id, &display_path, content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::VaultInstance;
    use neverwrite_vault::Vault;

    fn make_open_vault_state(vault_key: &str) -> (PathBuf, AppState) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("neverwrite-ai-history-root-test-{suffix}"));
        fs::create_dir_all(&dir).expect("temp vault dir should exist");

        let mut state = AppState::new();
        let mut instance = VaultInstance::new();
        instance.vault = Some(Vault::open(dir.clone()).expect("vault should open"));
        state.vaults.insert(vault_key.to_string(), instance);

        (dir, state)
    }

    #[test]
    fn resolve_ai_history_vault_root_returns_open_vault_root() {
        let (dir, state) = make_open_vault_state("/vault-a");

        let resolved =
            resolve_ai_history_vault_root(&state, "/vault-a").expect("vault root should resolve");

        assert_eq!(resolved, dir);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolve_ai_history_vault_root_rejects_unknown_vault_key() {
        let (dir, state) = make_open_vault_state("/vault-a");

        let error = resolve_ai_history_vault_root(&state, "/vault-b")
            .expect_err("unknown vault key should fail");

        assert!(error.contains("No hay vault abierto"));
        fs::remove_dir_all(dir).ok();
    }
}
