use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};

use agent_client_protocol::{
    Agent, AuthenticateRequest, Client, ClientCapabilities, ClientSideConnection,
    CloseSessionRequest, ContentBlock, ContentChunk, FileSystemCapabilities, Implementation,
    InitializeRequest, ListSessionsRequest, LoadSessionRequest, Meta, NewSessionRequest,
    PermissionOption, PromptRequest, ProtocolVersion, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, Result as AcpResult,
    SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, SetSessionModelRequest, ToolCall,
    ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::{process::Command, runtime::Builder, sync::oneshot, task::LocalSet};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use neverwrite_ai::{
    AiConfigOption, AiConfigOptionCategory, AiConfigSelectOption, AiModeOption, AiModelOption,
    AiRuntimeSessionSummary, CODEX_RUNTIME_ID,
};
use tokio::sync::mpsc as tokio_mpsc;

use crate::ai::emit::{
    emit_message_completed, emit_message_delta, emit_message_started, emit_permission_request,
    emit_plan_update, emit_runtime_connection, emit_session_error, emit_status_event,
    emit_thinking_completed, emit_thinking_delta, emit_thinking_started, emit_token_usage,
    emit_tool_activity, emit_user_input_request, AiFileDiffHunkPayload, AiFileDiffPayload,
    AiPermissionOptionPayload, AiPermissionRequestPayload, AiPlanEntryPayload, AiPlanUpdatePayload,
    AiRuntimeConnectionPayload, AiStatusEventPayload, AiTokenUsageCostPayload, AiTokenUsagePayload,
    AiToolActivityPayload, AiUserInputQuestionOptionPayload, AiUserInputQuestionPayload,
    AiUserInputRequestPayload,
};
use crate::ai::env::preferred_path_value;
use crate::branding::APP_BRAND_NAME;
use crate::technical_branding::{
    meta_get, meta_get_str, ACP_DIFF_HUNKS_KEY, ACP_DIFF_PREVIOUS_PATH_KEY, ACP_IMPLEMENTATION_ID,
    ACP_PLAN_DETAIL_KEY, ACP_PLAN_TITLE_KEY, ACP_STATUS_EMPHASIS_KEY, ACP_STATUS_EVENT_TYPE_KEY,
    ACP_STATUS_KIND_KEY, ACP_USER_INPUT_EVENT_TYPE, ACP_USER_INPUT_RESPONSE_PREFIX,
};

use super::{process::CodexProcessSpec, setup::apply_auth_env};

const FILE_DELETED_PLACEHOLDER: &str = "[file deleted]";
const MAX_TERMINAL_SUMMARY_CHARS: usize = 8_000;

enum RuntimeCommand {
    CreateSession {
        spec: CodexProcessSpec,
        response_tx: mpsc::Sender<Result<CodexSessionState, String>>,
    },
    LoadSession {
        spec: CodexProcessSpec,
        session_id: String,
        response_tx: mpsc::Sender<Result<CodexSessionState, String>>,
    },
    ListSessions {
        spec: CodexProcessSpec,
        response_tx: mpsc::Sender<Result<Vec<AiRuntimeSessionSummary>, String>>,
    },
    Authenticate {
        spec: CodexProcessSpec,
        method_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    SetMode {
        session_id: String,
        mode_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    SetModel {
        session_id: String,
        model_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    SetConfigOption {
        session_id: String,
        option_id: String,
        value: String,
        response_tx: mpsc::Sender<Result<Vec<AiConfigOption>, String>>,
    },
    Prompt {
        session_id: String,
        content: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    Cancel {
        session_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    CloseSession {
        session_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    RespondPermission {
        request_id: String,
        option_id: Option<String>,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    RespondUserInput {
        session_id: String,
        request_id: String,
        answers: HashMap<String, Vec<String>>,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    RegisterFileBaseline {
        session_id: String,
        display_path: String,
        content: String,
    },
    ClearSessionState {
        session_id: String,
    },
    CheckHealth {
        response_tx: mpsc::Sender<Result<(), String>>,
    },
}

#[derive(Debug, Clone)]
struct StreamingState {
    next_message_number: Arc<AtomicU64>,
    current_message_ids: Arc<Mutex<HashMap<String, String>>>,
    current_thought_ids: Arc<Mutex<HashMap<String, String>>>,
}

impl StreamingState {
    fn new() -> Self {
        Self {
            next_message_number: Arc::new(AtomicU64::new(0)),
            current_message_ids: Arc::new(Mutex::new(HashMap::new())),
            current_thought_ids: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn begin_turn(&self, session_id: &str) -> String {
        let message_number = self.next_message_number.fetch_add(1, Ordering::Relaxed) + 1;
        let message_id = format!("{session_id}:assistant:{message_number}");

        if let Ok(mut guard) = self.current_message_ids.lock() {
            guard.insert(session_id.to_string(), message_id.clone());
        }

        message_id
    }

    fn current_message_id(&self, session_id: &str) -> Option<String> {
        self.current_message_ids
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
    }

    fn end_turn(&self, session_id: &str) -> Option<String> {
        self.current_message_ids
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(session_id))
    }

    fn begin_thought(&self, session_id: &str) -> String {
        let message_number = self.next_message_number.fetch_add(1, Ordering::Relaxed) + 1;
        let message_id = format!("{session_id}:thinking:{message_number}");

        if let Ok(mut guard) = self.current_thought_ids.lock() {
            guard.insert(session_id.to_string(), message_id.clone());
        }

        message_id
    }

    fn current_thought_id(&self, session_id: &str) -> Option<String> {
        self.current_thought_ids
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
    }

    fn end_thought(&self, session_id: &str) -> Option<String> {
        self.current_thought_ids
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(session_id))
    }

    fn clear_session(&self, session_id: &str) {
        if let Ok(mut guard) = self.current_message_ids.lock() {
            guard.remove(session_id);
        }
        if let Ok(mut guard) = self.current_thought_ids.lock() {
            guard.remove(session_id);
        }
    }

    fn clear_all(&self) {
        if let Ok(mut guard) = self.current_message_ids.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.current_thought_ids.lock() {
            guard.clear();
        }
    }
}

#[derive(Debug, Clone, Default)]
struct ToolState {
    calls: Arc<Mutex<HashMap<String, ToolCall>>>,
    terminal_output: Arc<Mutex<HashMap<String, String>>>,
    terminal_exit: Arc<Mutex<HashMap<String, TerminalExitMeta>>>,
    session_cwds: Arc<Mutex<HashMap<String, PathBuf>>>,
    write_diffs: Arc<Mutex<HashMap<String, Vec<AiFileDiffPayload>>>>,
    file_baselines: Arc<Mutex<HashMap<String, String>>>,
}

impl ToolState {
    fn register_session_cwd(&self, session_id: &str, cwd: PathBuf) {
        if let Ok(mut guard) = self.session_cwds.lock() {
            guard.insert(session_id.to_string(), cwd);
        }
    }

    fn upsert_tool_call(&self, session_id: &str, tool_call: ToolCall) -> ToolCall {
        let key = format!("{session_id}::{}", tool_call.tool_call_id.0);
        if let Ok(mut guard) = self.calls.lock() {
            guard.insert(key, tool_call.clone());
        }
        self.cache_read_baseline(session_id, &tool_call);
        self.capture_write_diff(
            session_id,
            &tool_call.tool_call_id.0,
            tool_call.raw_input.as_ref(),
        );
        self.cache_content_diffs(session_id, &tool_call);
        self.record_terminal_meta(
            session_id,
            &tool_call.tool_call_id.0,
            tool_call.meta.as_ref(),
        );
        if tool_call.status == ToolCallStatus::Completed {
            self.advance_baseline_after_success(session_id, tool_call.raw_input.as_ref());
        }
        tool_call
    }

    fn apply_tool_update(&self, session_id: &str, update: ToolCallUpdate) -> Option<ToolCall> {
        self.record_terminal_meta(session_id, &update.tool_call_id.0, update.meta.as_ref());
        self.capture_write_diff(
            session_id,
            &update.tool_call_id.0,
            update.fields.raw_input.as_ref(),
        );
        let key = format!("{session_id}::{}", update.tool_call_id.0);
        let mut guard = self.calls.lock().ok()?;

        let tool_call = if let Some(existing) = guard.get_mut(&key) {
            existing.update(update.fields);
            existing.clone()
        } else {
            let tool_call = ToolCall::try_from(update).ok()?;
            guard.insert(key, tool_call.clone());
            tool_call
        };

        drop(guard);
        self.cache_content_diffs(session_id, &tool_call);
        self.cache_read_baseline(session_id, &tool_call);
        if tool_call.status == ToolCallStatus::Completed {
            self.advance_baseline_after_success(session_id, tool_call.raw_input.as_ref());
        }
        Some(tool_call)
    }

    fn normalized_diffs_for_tool_call(
        &self,
        session_id: &str,
        tool_call: &ToolCall,
    ) -> Vec<AiFileDiffPayload> {
        let cwd = self.session_cwd(session_id);
        let actual = collect_tool_call_diffs(tool_call, cwd.as_deref());

        if tool_call.status != ToolCallStatus::Failed {
            if let Some(cached) = self.cached_diffs(session_id, &tool_call.tool_call_id.0) {
                if !cached.is_empty() {
                    return cached;
                }
            }
        }

        actual
    }

    fn terminal_summary(&self, session_id: &str, tool_call_id: &str) -> Option<String> {
        let key = format!("{session_id}::{tool_call_id}");
        let output = self
            .terminal_output
            .lock()
            .ok()
            .and_then(|guard| guard.get(&key).cloned());
        let exit = self
            .terminal_exit
            .lock()
            .ok()
            .and_then(|guard| guard.get(&key).cloned());

        match (output, exit) {
            (Some(output), Some(exit)) => Some(format_terminal_summary(&output, Some(&exit))),
            (Some(output), None) => Some(format_terminal_summary(&output, None)),
            (None, Some(exit)) => Some(format_terminal_exit_only(&exit)),
            (None, None) => None,
        }
    }

    fn record_terminal_meta(&self, session_id: &str, tool_call_id: &str, meta: Option<&Meta>) {
        let Some(meta) = meta else {
            return;
        };
        let key = format!("{session_id}::{tool_call_id}");

        if let Some(delta) = terminal_output_from_meta(meta) {
            if let Ok(mut guard) = self.terminal_output.lock() {
                let buffer = guard.entry(key.clone()).or_default();
                buffer.push_str(&delta);
                trim_terminal_buffer(buffer);
            }
        }

        if let Some(exit) = terminal_exit_from_meta(meta) {
            if let Ok(mut guard) = self.terminal_exit.lock() {
                guard.insert(key, exit);
            }
        }
    }

    fn session_cwd(&self, session_id: &str) -> Option<PathBuf> {
        self.session_cwds
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
    }

    fn cached_diffs(&self, session_id: &str, tool_call_id: &str) -> Option<Vec<AiFileDiffPayload>> {
        let key = format!("{session_id}::{tool_call_id}");
        self.write_diffs
            .lock()
            .ok()
            .and_then(|guard| guard.get(&key).cloned())
    }

    fn capture_write_diff(
        &self,
        session_id: &str,
        tool_call_id: &str,
        raw_input: Option<&serde_json::Value>,
    ) {
        let Some(raw_input) = raw_input else {
            return;
        };
        let cwd = self.session_cwd(session_id);

        let baseline_diff = self.reconstruct_with_baseline(session_id, raw_input, cwd.as_deref());
        let diff = baseline_diff
            .or_else(|| reconstruct_write_diff_payload(raw_input, cwd.as_deref()))
            .or_else(|| reconstruct_edit_diff_payload(raw_input, cwd.as_deref()));

        let Some(diff) = diff else {
            return;
        };
        let key = format!("{session_id}::{tool_call_id}");
        if let Ok(mut guard) = self.write_diffs.lock() {
            guard.entry(key).or_insert(vec![diff]);
        }
    }

    fn cache_content_diffs(&self, session_id: &str, tool_call: &ToolCall) {
        let cwd = self.session_cwd(session_id);
        let diffs = collect_tool_call_diffs(tool_call, cwd.as_deref());
        if diffs.is_empty() {
            return;
        }
        let tool_call_id = &tool_call.tool_call_id.0;
        let key = format!("{session_id}::{tool_call_id}");
        if let Ok(mut guard) = self.write_diffs.lock() {
            let has_old_text = diffs.iter().any(|d| d.old_text.is_some());
            let existing_is_reliable = guard
                .get(&key)
                .map(|cached| cached.iter().any(|d| d.old_text.is_some() && d.reversible))
                .unwrap_or(false);

            if existing_is_reliable {
                return;
            }

            if has_old_text {
                guard.insert(key, diffs);
            } else {
                guard.entry(key).or_insert(diffs);
            }
        }
    }

    fn cache_read_baseline(&self, session_id: &str, tool_call: &ToolCall) {
        if tool_call.kind != ToolKind::Read || tool_call.status != ToolCallStatus::Completed {
            return;
        }
        let Some(input) = read_tool_input(tool_call.raw_input.as_ref()) else {
            return;
        };
        if input.file_path.trim().is_empty() {
            return;
        }
        let cwd = self.session_cwd(session_id);
        let resolved = resolve_tool_path(&input.file_path, cwd.as_deref());
        let display_path = to_display_path(&resolved, cwd.as_deref());

        let content = match read_existing_text_snapshot(&resolved) {
            ExistingTextSnapshot::Text(text) => text,
            _ => return,
        };

        let key = format!("{session_id}::{display_path}");
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.entry(key).or_insert(content);
        }
    }

    fn get_file_baseline(&self, session_id: &str, display_path: &str) -> Option<String> {
        let key = format!("{session_id}::{display_path}");
        self.file_baselines.lock().ok()?.get(&key).cloned()
    }

    pub fn store_file_baseline(&self, session_id: &str, display_path: &str, content: String) {
        let key = format!("{session_id}::{display_path}");
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.insert(key, content);
        }
    }

    fn reconstruct_with_baseline(
        &self,
        session_id: &str,
        raw_input: &serde_json::Value,
        cwd: Option<&Path>,
    ) -> Option<AiFileDiffPayload> {
        if let Some(input) = write_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return None;
            }
            let resolved_path = resolve_tool_path(&input.file_path, cwd);
            let display_path = to_display_path(&resolved_path, cwd);
            let old_text = self.get_file_baseline(session_id, &display_path)?;

            return Some(AiFileDiffPayload {
                path: display_path,
                kind: "update".to_string(),
                previous_path: None,
                reversible: true,
                is_text: true,
                old_text: Some(old_text),
                new_text: Some(input.content),
                hunks: None,
            });
        }

        let input = edit_tool_input(Some(raw_input))?;
        if input.file_path.trim().is_empty() || input.new_string.is_empty() {
            return None;
        }
        let resolved_path = resolve_tool_path(&input.file_path, cwd);
        let display_path = to_display_path(&resolved_path, cwd);
        let old_text = self.get_file_baseline(session_id, &display_path)?;
        let new_text = replace_exactly_once(&old_text, &input.old_string, &input.new_string)?;

        Some(AiFileDiffPayload {
            path: display_path,
            kind: "update".to_string(),
            previous_path: None,
            reversible: true,
            is_text: true,
            old_text: Some(old_text),
            new_text: Some(new_text),
            hunks: None,
        })
    }

    fn advance_baseline_after_success(
        &self,
        session_id: &str,
        raw_input: Option<&serde_json::Value>,
    ) {
        let cwd = self.session_cwd(session_id);

        if let Some(input) = write_tool_input(raw_input) {
            if input.file_path.trim().is_empty() {
                return;
            }
            let resolved_path = resolve_tool_path(&input.file_path, cwd.as_deref());
            let display_path = to_display_path(&resolved_path, cwd.as_deref());
            let key = format!("{session_id}::{display_path}");
            if let Ok(mut guard) = self.file_baselines.lock() {
                guard.insert(key, input.content);
            }
            return;
        }

        if let Some(input) = edit_tool_input(raw_input) {
            if input.file_path.trim().is_empty() || input.new_string.is_empty() {
                return;
            }
            let resolved_path = resolve_tool_path(&input.file_path, cwd.as_deref());
            let display_path = to_display_path(&resolved_path, cwd.as_deref());
            let key = format!("{session_id}::{display_path}");

            if let Ok(mut guard) = self.file_baselines.lock() {
                if let Some(previous) = guard.get(&key).cloned() {
                    if let Some(next) =
                        replace_exactly_once(&previous, &input.old_string, &input.new_string)
                    {
                        guard.insert(key, next);
                    }
                }
            }
        }
    }

    fn clear_session(&self, session_id: &str) {
        let prefix = format!("{session_id}::");
        if let Ok(mut guard) = self.calls.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.terminal_output.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.terminal_exit.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.session_cwds.lock() {
            guard.remove(session_id);
        }
        if let Ok(mut guard) = self.write_diffs.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
    }

    fn clear_all(&self) {
        if let Ok(mut guard) = self.calls.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.terminal_output.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.terminal_exit.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.session_cwds.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.write_diffs.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.clear();
        }
    }
}

#[derive(Debug, Clone)]
struct TerminalExitMeta {
    exit_code: Option<i64>,
    signal: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WriteToolInput {
    file_path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct EditToolInput {
    file_path: String,
    old_string: String,
    new_string: String,
}

#[derive(Debug, Deserialize)]
struct ReadToolInput {
    file_path: String,
}

#[derive(Debug, Clone, Default)]
struct PermissionState {
    next_request_number: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<RequestPermissionOutcome>>>>,
}

impl PermissionState {
    fn create_request(
        &self,
        session_id: &str,
    ) -> (String, oneshot::Receiver<RequestPermissionOutcome>) {
        let request_number = self.next_request_number.fetch_add(1, Ordering::Relaxed) + 1;
        let request_id = format!("{session_id}:permission:{request_number}");
        let (response_tx, response_rx) = oneshot::channel();

        if let Ok(mut guard) = self.pending.lock() {
            guard.insert(request_id.clone(), response_tx);
        }

        (request_id, response_rx)
    }

    fn resolve(&self, request_id: &str, outcome: RequestPermissionOutcome) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|error| error.to_string())?
            .remove(request_id)
            .ok_or_else(|| format!("Permission request not found: {request_id}"))?;

        sender
            .send(outcome)
            .map_err(|_| "Permission channel closed".to_string())
    }

    fn clear_session(&self, session_id: &str) {
        let prefix = format!("{session_id}:permission:");
        if let Ok(mut guard) = self.pending.lock() {
            guard.retain(|request_id, _| !request_id.starts_with(&prefix));
        }
    }

    fn clear_all(&self) {
        if let Ok(mut guard) = self.pending.lock() {
            guard.clear();
        }
    }
}

#[derive(Debug, Clone)]
struct PendingUserInput {
    session_id: String,
    turn_id: String,
}

#[derive(Debug, Clone, Default)]
struct UserInputState {
    pending: Arc<Mutex<HashMap<String, PendingUserInput>>>,
}

impl UserInputState {
    fn register(&self, session_id: &str, request_id: String, turn_id: String) {
        if let Ok(mut guard) = self.pending.lock() {
            guard.insert(
                request_id,
                PendingUserInput {
                    session_id: session_id.to_string(),
                    turn_id,
                },
            );
        }
    }

    fn resolve_turn_id(&self, request_id: &str) -> Result<String, String> {
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .remove(request_id)
            .map(|entry| entry.turn_id)
            .ok_or_else(|| format!("User input request not found: {request_id}"))
    }

    fn clear_session(&self, session_id: &str) {
        if let Ok(mut guard) = self.pending.lock() {
            guard.retain(|_, entry| entry.session_id != session_id);
        }
    }

    fn clear_all(&self) {
        if let Ok(mut guard) = self.pending.lock() {
            guard.clear();
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RawUserInputQuestionOption {
    label: String,
    description: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawUserInputQuestion {
    id: String,
    header: String,
    question: String,
    #[serde(rename = "isOther", default)]
    is_other: bool,
    #[serde(rename = "isSecret", default)]
    is_secret: bool,
    options: Option<Vec<RawUserInputQuestionOption>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawUserInputRequest {
    request_id: String,
    turn_id: String,
    questions: Vec<RawUserInputQuestion>,
}

#[derive(Debug, Clone, Serialize)]
struct UserInputAnswerPayload {
    turn_id: String,
    response: UserInputResponsePayload,
}

#[derive(Debug, Clone, Serialize)]
struct UserInputResponsePayload {
    answers: HashMap<String, UserInputAnswerValuePayload>,
}

#[derive(Debug, Clone, Serialize)]
struct UserInputAnswerValuePayload {
    answers: Vec<String>,
}

/// Drop guard that ensures `emit_message_completed` fires even if the
/// spawned prompt task panics or is cancelled.
struct TurnCompletionGuard {
    app: AppHandle,
    streaming: StreamingState,
    session_id: String,
    fallback_message_id: String,
    completed: bool,
}

impl Drop for TurnCompletionGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        // Clean up any lingering thinking state.
        if let Some(thinking_id) = self.streaming.end_thought(&self.session_id) {
            emit_thinking_completed(&self.app, self.session_id.clone(), thinking_id);
        }
        let completed_id = self
            .streaming
            .end_turn(&self.session_id)
            .unwrap_or_else(|| self.fallback_message_id.clone());
        emit_message_completed(&self.app, self.session_id.clone(), completed_id);
    }
}

struct NeverWriteAcpClient {
    app: AppHandle,
    streaming: StreamingState,
    tools: ToolState,
    permissions: PermissionState,
    user_inputs: UserInputState,
}

#[derive(Debug, Clone)]
pub struct CodexSessionState {
    pub session_id: String,
    pub model_id: String,
    pub mode_id: String,
    pub models: Vec<AiModelOption>,
    pub modes: Vec<AiModeOption>,
    pub config_options: Vec<AiConfigOption>,
    /// Maps display model id to the effort levels the ACP supports for it.
    pub efforts_by_model: std::collections::HashMap<String, Vec<String>>,
    /// Maps display model id → canonical ACP base id (e.g. "gpt-5.1-codex" → "gpt-5.1-codex-max").
    pub acp_model_ids: std::collections::HashMap<String, String>,
}

#[async_trait::async_trait(?Send)]
impl Client for NeverWriteAcpClient {
    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> AcpResult<RequestPermissionResponse> {
        let session_id = args.session_id.0.to_string();
        let tool_call_id = args.tool_call.tool_call_id.0.to_string();
        let title = args
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| "Permission required".into());
        let target = args
            .tool_call
            .fields
            .locations
            .as_ref()
            .and_then(|locations| locations.first())
            .map(|location| location.path.display().to_string());

        // Register the tool call so subsequent ToolCallUpdates can find it.
        let pending_tool_call = ToolCall::try_from(args.tool_call.clone())
            .unwrap_or_else(|_| ToolCall::new(args.tool_call.tool_call_id.clone(), title.clone()));
        let registered = self.tools.upsert_tool_call(&session_id, pending_tool_call);
        let diffs = self
            .tools
            .normalized_diffs_for_tool_call(&session_id, &registered);
        emit_tool_activity(
            &self.app,
            map_tool_call(
                &session_id,
                &registered,
                self.tools
                    .terminal_summary(&session_id, &registered.tool_call_id.0),
                diffs.clone(),
            ),
        );

        let (request_id, response_rx) = self.permissions.create_request(&session_id);
        emit_permission_request(
            &self.app,
            AiPermissionRequestPayload {
                session_id,
                request_id,
                tool_call_id,
                title,
                target,
                options: args
                    .options
                    .into_iter()
                    .map(map_permission_option)
                    .collect(),
                diffs,
            },
        );

        let outcome = response_rx
            .await
            .unwrap_or(RequestPermissionOutcome::Cancelled);
        Ok(RequestPermissionResponse::new(outcome))
    }

    async fn session_notification(&self, args: SessionNotification) -> AcpResult<()> {
        let session_id = args.session_id.0.to_string();

        match args.update {
            SessionUpdate::AgentMessageChunk(ContentChunk {
                content: ContentBlock::Text(text),
                ..
            }) => {
                if let Some(thinking_id) = self.streaming.end_thought(&session_id) {
                    emit_thinking_completed(&self.app, session_id.clone(), thinking_id);
                }
                if let Some(message_id) = self.streaming.current_message_id(&session_id) {
                    emit_message_delta(&self.app, session_id, message_id, text.text);
                }
            }
            SessionUpdate::AgentThoughtChunk(ContentChunk {
                content: ContentBlock::Text(text),
                ..
            }) => {
                let message_id = self
                    .streaming
                    .current_thought_id(&session_id)
                    .unwrap_or_else(|| {
                        let message_id = self.streaming.begin_thought(&session_id);
                        emit_thinking_started(&self.app, session_id.clone(), message_id.clone());
                        message_id
                    });
                emit_thinking_delta(&self.app, session_id, message_id, text.text);
            }
            SessionUpdate::ToolCall(tool_call) => {
                if let Some(thinking_id) = self.streaming.end_thought(&session_id) {
                    emit_thinking_completed(&self.app, session_id.clone(), thinking_id);
                }
                let tool_call = self.tools.upsert_tool_call(&session_id, tool_call);
                if let Some(payload) = map_user_input_request(&session_id, &tool_call) {
                    self.user_inputs.register(
                        &session_id,
                        payload.request_id.clone(),
                        payload.turn_id.clone(),
                    );
                    emit_user_input_request(&self.app, payload.into_emit_payload());
                } else if let Some(payload) = map_status_event(&session_id, &tool_call) {
                    emit_status_event(&self.app, payload);
                } else {
                    emit_tool_activity(
                        &self.app,
                        map_tool_call(
                            &session_id,
                            &tool_call,
                            self.tools
                                .terminal_summary(&session_id, &tool_call.tool_call_id.0),
                            self.tools
                                .normalized_diffs_for_tool_call(&session_id, &tool_call),
                        ),
                    );
                }
            }
            SessionUpdate::ToolCallUpdate(update) => {
                if let Some(tool_call) = self.tools.apply_tool_update(&session_id, update) {
                    if let Some(payload) = map_user_input_request(&session_id, &tool_call) {
                        self.user_inputs.register(
                            &session_id,
                            payload.request_id.clone(),
                            payload.turn_id.clone(),
                        );
                        emit_user_input_request(&self.app, payload.into_emit_payload());
                    } else if let Some(payload) = map_status_event(&session_id, &tool_call) {
                        emit_status_event(&self.app, payload);
                    } else {
                        emit_tool_activity(
                            &self.app,
                            map_tool_call(
                                &session_id,
                                &tool_call,
                                self.tools
                                    .terminal_summary(&session_id, &tool_call.tool_call_id.0),
                                self.tools
                                    .normalized_diffs_for_tool_call(&session_id, &tool_call),
                            ),
                        );
                    }
                }
            }
            SessionUpdate::Plan(plan) => {
                emit_plan_update(&self.app, map_plan_update(&session_id, plan));
            }
            SessionUpdate::UsageUpdate(update) => {
                emit_token_usage(&self.app, map_usage_update(&session_id, update));
            }
            _ => {}
        }

        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct CodexRuntimeHandle {
    command_tx: tokio_mpsc::UnboundedSender<RuntimeCommand>,
}

impl CodexRuntimeHandle {
    pub fn spawn(app: AppHandle) -> Self {
        let (command_tx, command_rx) = tokio_mpsc::unbounded_channel::<RuntimeCommand>();

        thread::spawn(move || {
            let app_for_error = app.clone();
            let runtime = match Builder::new_current_thread().enable_all().build() {
                Ok(runtime) => runtime,
                Err(error) => {
                    emit_session_error(
                        &app_for_error,
                        None,
                        format!("Failed to start ACP runtime: {error}"),
                    );
                    return;
                }
            };

            let local = LocalSet::new();
            local.block_on(&runtime, async move {
                if let Err(error) = run_actor(command_rx, app).await {
                    emit_session_error(&app_for_error, None, error);
                }
            });
        });

        Self { command_tx }
    }

    pub fn create_session(&self, spec: CodexProcessSpec) -> Result<CodexSessionState, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::CreateSession { spec, response_tx })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn load_session(
        &self,
        spec: CodexProcessSpec,
        session_id: &str,
    ) -> Result<CodexSessionState, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::LoadSession {
                spec,
                session_id: session_id.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn list_sessions(
        &self,
        spec: CodexProcessSpec,
    ) -> Result<Vec<AiRuntimeSessionSummary>, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::ListSessions { spec, response_tx })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn authenticate(&self, spec: CodexProcessSpec, method_id: &str) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::Authenticate {
                spec,
                method_id: method_id.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::SetMode {
                session_id: session_id.to_string(),
                mode_id: mode_id.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn set_model(&self, session_id: &str, model_id: &str) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::SetModel {
                session_id: session_id.to_string(),
                model_id: model_id.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn set_config_option(
        &self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<Vec<AiConfigOption>, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::SetConfigOption {
                session_id: session_id.to_string(),
                option_id: option_id.to_string(),
                value: value.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    /// Fire-and-forget: sends the prompt command and returns immediately.
    /// Streaming events flow via Tauri events. Errors are emitted as session errors.
    pub fn prompt_async(
        &self,
        session_id: &str,
        content: &str,
        app: AppHandle,
    ) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::Prompt {
                session_id: session_id.to_string(),
                content: content.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;

        let sid = session_id.to_string();
        thread::spawn(move || match response_rx.recv() {
            Ok(Err(error)) => {
                emit_session_error(&app, Some(sid), error);
            }
            Err(recv_error) => {
                emit_session_error(&app, Some(sid), recv_error.to_string());
            }
            Ok(Ok(())) => {}
        });

        Ok(())
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::Cancel {
                session_id: session_id.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::CloseSession {
                session_id: session_id.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn respond_permission(
        &self,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::RespondPermission {
                request_id: request_id.to_string(),
                option_id: option_id.map(ToOwned::to_owned),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn respond_user_input(
        &self,
        session_id: &str,
        request_id: &str,
        answers: HashMap<String, Vec<String>>,
    ) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::RespondUserInput {
                session_id: session_id.to_string(),
                request_id: request_id.to_string(),
                answers,
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn clear_session_state(&self, session_id: &str) {
        let _ = self.command_tx.send(RuntimeCommand::ClearSessionState {
            session_id: session_id.to_string(),
        });
    }

    pub fn register_file_baseline(
        &self,
        session_id: &str,
        display_path: &str,
        content: String,
    ) -> Result<(), String> {
        self.command_tx
            .send(RuntimeCommand::RegisterFileBaseline {
                session_id: session_id.to_string(),
                display_path: display_path.to_string(),
                content,
            })
            .map_err(|error| error.to_string())
    }

    pub fn check_health(&self) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::CheckHealth { response_tx })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }
}

async fn run_actor(
    mut command_rx: tokio_mpsc::UnboundedReceiver<RuntimeCommand>,
    app: AppHandle,
) -> Result<(), String> {
    let mut actor = RuntimeActor::new(app);
    while let Some(command) = command_rx.recv().await {
        actor.handle(command).await;
    }
    Ok(())
}

struct RuntimeActor {
    app: AppHandle,
    connection: Option<Rc<ClientSideConnection>>,
    _io_task_done: Option<oneshot::Receiver<Result<(), String>>>,
    streaming: StreamingState,
    tools: ToolState,
    permissions: PermissionState,
    user_inputs: UserInputState,
    initialized: bool,
}

impl RuntimeActor {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            connection: None,
            _io_task_done: None,
            streaming: StreamingState::new(),
            tools: ToolState::default(),
            permissions: PermissionState::default(),
            user_inputs: UserInputState::default(),
            initialized: false,
        }
    }

    fn reset_connection(&mut self) {
        self.connection = None;
        self._io_task_done = None;
        self.initialized = false;
        self.streaming.clear_all();
        self.tools.clear_all();
        self.permissions.clear_all();
        self.user_inputs.clear_all();
    }

    fn clear_session_state(&mut self, session_id: &str) {
        self.streaming.clear_session(session_id);
        self.tools.clear_session(session_id);
        self.permissions.clear_session(session_id);
        self.user_inputs.clear_session(session_id);
    }

    fn poll_connection_health(&mut self) -> Result<(), String> {
        let Some(done_rx) = self._io_task_done.as_mut() else {
            return Ok(());
        };

        match done_rx.try_recv() {
            Ok(Ok(())) => {
                self.reset_connection();
                Err("The AI runtime process exited. Start a new turn to reconnect.".to_string())
            }
            Ok(Err(error)) => {
                self.reset_connection();
                Err(format!(
                    "The AI runtime process disconnected unexpectedly: {error}"
                ))
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => Ok(()),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                self.reset_connection();
                Err("The AI runtime process disconnected unexpectedly.".to_string())
            }
        }
    }

    async fn handle(&mut self, command: RuntimeCommand) {
        match command {
            RuntimeCommand::CreateSession { spec, response_tx } => {
                let result = self.create_session(spec).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::LoadSession {
                spec,
                session_id,
                response_tx,
            } => {
                let result = self.load_session(spec, session_id).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::ListSessions { spec, response_tx } => {
                let result = self.list_sessions(spec).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::Authenticate {
                spec,
                method_id,
                response_tx,
            } => {
                let result = self.authenticate(spec, method_id).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::SetMode {
                session_id,
                mode_id,
                response_tx,
            } => {
                let result = self.set_mode(session_id, mode_id).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::SetModel {
                session_id,
                model_id,
                response_tx,
            } => {
                let result = self.set_model(session_id, model_id).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::SetConfigOption {
                session_id,
                option_id,
                value,
                response_tx,
            } => {
                let result = self.set_config_option(session_id, option_id, value).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::Prompt {
                session_id,
                content,
                response_tx,
            } => {
                self.spawn_prompt(session_id, content, response_tx);
            }
            RuntimeCommand::Cancel {
                session_id,
                response_tx,
            } => {
                let result = self.cancel(session_id).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::CloseSession {
                session_id,
                response_tx,
            } => {
                let result = self.close_session(session_id).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::RespondPermission {
                request_id,
                option_id,
                response_tx,
            } => {
                let result = self.respond_permission(request_id, option_id);
                let _ = response_tx.send(result);
            }
            RuntimeCommand::RespondUserInput {
                session_id,
                request_id,
                answers,
                response_tx,
            } => {
                let result = self
                    .respond_user_input(session_id, request_id, answers)
                    .await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::RegisterFileBaseline {
                session_id,
                display_path,
                content,
            } => {
                self.tools
                    .store_file_baseline(&session_id, &display_path, content);
            }
            RuntimeCommand::ClearSessionState { session_id } => {
                self.clear_session_state(&session_id);
            }
            RuntimeCommand::CheckHealth { response_tx } => {
                let _ = response_tx.send(self.poll_connection_health());
            }
        }
    }

    async fn ensure_connection(
        &mut self,
        spec: &CodexProcessSpec,
    ) -> Result<Rc<ClientSideConnection>, String> {
        self.poll_connection_health()?;
        if let Some(connection) = self.connection.as_ref() {
            return Ok(connection.clone());
        }

        if !spec.binary_path.exists() {
            return Err(format!(
                "Codex ACP no esta compilado aun. Binario esperado en {}. Tambien puedes definir NEVERWRITE_CODEX_ACP_BIN.",
                spec.binary_path.display()
            ));
        }

        let mut command = Command::new(&spec.binary_path);
        prepare_runtime_command(&mut command, spec.cwd.as_deref())?;

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to acquire codex-acp stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to acquire codex-acp stdout".to_string())?;

        let client = Rc::new(NeverWriteAcpClient {
            app: self.app.clone(),
            streaming: self.streaming.clone(),
            tools: self.tools.clone(),
            permissions: self.permissions.clone(),
            user_inputs: self.user_inputs.clone(),
        });

        let (connection, io_task) =
            ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |fut| {
                tokio::task::spawn_local(fut);
            });

        let connection = Rc::new(connection);
        let (done_tx, done_rx) = oneshot::channel();
        let app = self.app.clone();
        tokio::task::spawn_local(async move {
            let result = io_task.await.map_err(|error| error.to_string());
            let message = match &result {
                Ok(()) => {
                    "The AI runtime process exited. Start a new turn to reconnect.".to_string()
                }
                Err(error) => {
                    format!("The AI runtime process disconnected unexpectedly: {error}")
                }
            };
            emit_runtime_connection(
                &app,
                AiRuntimeConnectionPayload {
                    runtime_id: CODEX_RUNTIME_ID.to_string(),
                    status: "error".to_string(),
                    message: Some(message),
                },
            );
            let _ = done_tx.send(result);
        });

        self.connection = Some(connection.clone());
        self._io_task_done = Some(done_rx);
        emit_runtime_connection(
            &self.app,
            AiRuntimeConnectionPayload {
                runtime_id: CODEX_RUNTIME_ID.to_string(),
                status: "ready".to_string(),
                message: None,
            },
        );

        Ok(connection)
    }

    async fn ensure_initialized(
        &mut self,
        spec: &CodexProcessSpec,
    ) -> Result<Rc<ClientSideConnection>, String> {
        let connection = self.ensure_connection(spec).await?;
        if self.initialized {
            return Ok(connection);
        }

        let request = InitializeRequest::new(ProtocolVersion::LATEST)
            .client_capabilities(
                ClientCapabilities::new()
                    .fs(FileSystemCapabilities::new())
                    .terminal(false)
                    .meta(Meta::from_iter([(
                        "terminal_output".to_string(),
                        serde_json::json!(true),
                    )])),
            )
            .client_info(
                Implementation::new(ACP_IMPLEMENTATION_ID, env!("CARGO_PKG_VERSION"))
                    .title(APP_BRAND_NAME),
            );

        connection
            .initialize(request)
            .await
            .map_err(|error| error.to_string())?;

        self.initialized = true;
        Ok(connection)
    }

    async fn create_session(
        &mut self,
        spec: CodexProcessSpec,
    ) -> Result<CodexSessionState, String> {
        let cwd = spec
            .cwd
            .clone()
            .ok_or_else(|| "No hay vault abierto para iniciar una sesion ACP.".to_string())?;

        let connection = self.ensure_initialized(&spec).await?;
        let response = connection
            .new_session(NewSessionRequest::new(cwd))
            .await
            .map_err(|error| error.to_string())?;
        self.tools
            .register_session_cwd(&response.session_id.0, spec.cwd.clone().unwrap());

        let current_model_id = response
            .models
            .as_ref()
            .map(|state| strip_effort_suffix(&state.current_model_id.0).to_string())
            .unwrap_or_default();

        let mapped = response.models.map(map_session_models);
        let (models, efforts_by_model, acp_model_ids) = match mapped {
            Some(m) => (m.models, m.efforts_by_model, m.acp_model_ids),
            None => Default::default(),
        };

        Ok(CodexSessionState {
            session_id: response.session_id.0.to_string(),
            model_id: current_model_id,
            mode_id: response
                .modes
                .as_ref()
                .map(|state| state.current_mode_id.0.to_string())
                .unwrap_or_else(|| "default".to_string()),
            models,
            modes: response.modes.map(map_session_modes).unwrap_or_default(),
            config_options: response
                .config_options
                .map(map_session_config_options)
                .unwrap_or_default(),
            efforts_by_model,
            acp_model_ids,
        })
    }

    async fn load_session(
        &mut self,
        spec: CodexProcessSpec,
        session_id: String,
    ) -> Result<CodexSessionState, String> {
        let cwd = spec
            .cwd
            .clone()
            .ok_or_else(|| "No hay vault abierto para cargar una sesion ACP.".to_string())?;

        let connection = self.ensure_initialized(&spec).await?;
        let response = connection
            .load_session(LoadSessionRequest::new(
                SessionId::new(session_id.clone()),
                cwd,
            ))
            .await
            .map_err(|error| error.to_string())?;
        self.tools
            .register_session_cwd(&session_id, spec.cwd.clone().unwrap());

        map_loaded_session_state(
            session_id,
            response.models,
            response.modes,
            response.config_options,
        )
    }

    async fn list_sessions(
        &mut self,
        spec: CodexProcessSpec,
    ) -> Result<Vec<AiRuntimeSessionSummary>, String> {
        let connection = self.ensure_initialized(&spec).await?;
        let response = connection
            .list_sessions(ListSessionsRequest::new().cwd(spec.cwd.clone()))
            .await
            .map_err(|error| error.to_string())?;

        Ok(response
            .sessions
            .into_iter()
            .map(|session| AiRuntimeSessionSummary {
                session_id: session.session_id.0.to_string(),
                runtime_id: CODEX_RUNTIME_ID.to_string(),
                cwd: Some(session.cwd.display().to_string()),
                title: session.title,
                updated_at: session.updated_at,
            })
            .collect())
    }

    async fn authenticate(
        &mut self,
        spec: CodexProcessSpec,
        method_id: String,
    ) -> Result<(), String> {
        let connection = self.ensure_initialized(&spec).await?;
        connection
            .authenticate(AuthenticateRequest::new(method_id))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn set_mode(&mut self, session_id: String, mode_id: String) -> Result<(), String> {
        self.poll_connection_health()?;
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())?
            .clone();

        connection
            .set_session_mode(SetSessionModeRequest::new(
                SessionId::new(session_id),
                mode_id,
            ))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn set_model(&mut self, session_id: String, model_id: String) -> Result<(), String> {
        self.poll_connection_health()?;
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())?
            .clone();

        connection
            .set_session_model(SetSessionModelRequest::new(
                SessionId::new(session_id),
                model_id,
            ))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn set_config_option(
        &mut self,
        session_id: String,
        option_id: String,
        value: String,
    ) -> Result<Vec<AiConfigOption>, String> {
        self.poll_connection_health()?;
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())?
            .clone();

        connection
            .set_session_config_option(SetSessionConfigOptionRequest::new(
                SessionId::new(session_id),
                option_id,
                value.as_str(),
            ))
            .await
            .map(|response| map_session_config_options(response.config_options))
            .map_err(|error| error.to_string())
    }

    fn spawn_prompt(
        &mut self,
        session_id: String,
        content: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    ) {
        if let Err(error) = self.poll_connection_health() {
            let _ = response_tx.send(Err(error));
            return;
        }
        let connection = match self.connection.as_ref() {
            Some(c) => c.clone(),
            None => {
                let _ = response_tx.send(Err("ACP runtime is not initialized.".to_string()));
                return;
            }
        };
        let streaming = self.streaming.clone();
        let app = self.app.clone();

        tokio::task::spawn_local(async move {
            let message_id = streaming.begin_turn(&session_id);
            emit_message_started(&app, session_id.clone(), message_id.clone());

            // Guard ensures emit_message_completed fires even on panic/drop.
            let mut guard = TurnCompletionGuard {
                app: app.clone(),
                streaming: streaming.clone(),
                session_id: session_id.clone(),
                fallback_message_id: message_id,
                completed: false,
            };

            let result = connection
                .prompt(PromptRequest::new(
                    SessionId::new(session_id.clone()),
                    vec![ContentBlock::from(content)],
                ))
                .await
                .map(|_| ());

            if let Some(thinking_id) = streaming.end_thought(&session_id) {
                emit_thinking_completed(&app, session_id.clone(), thinking_id);
            }
            let completed_id = streaming.end_turn(&session_id).unwrap_or_default();
            if !completed_id.is_empty() {
                emit_message_completed(&app, session_id, completed_id);
            }
            guard.completed = true;

            let _ = response_tx.send(result.map_err(|e| e.to_string()));
        });
    }

    async fn cancel(&mut self, session_id: String) -> Result<(), String> {
        self.poll_connection_health()?;
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())?
            .clone();

        connection
            .cancel(agent_client_protocol::CancelNotification::new(
                SessionId::new(session_id),
            ))
            .await
            .map_err(|error| error.to_string())
    }

    async fn close_session(&mut self, session_id: String) -> Result<(), String> {
        self.poll_connection_health()?;
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())?
            .clone();

        connection
            .close_session(CloseSessionRequest::new(SessionId::new(session_id)))
            .await
            .map(|_| ())
            .map_err(|error| format!("Failed to close session: {error}"))
    }

    fn respond_permission(
        &mut self,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let outcome = option_id
            .map(|value| RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(value)))
            .unwrap_or(RequestPermissionOutcome::Cancelled);
        self.permissions.resolve(&request_id, outcome)
    }

    async fn respond_user_input(
        &mut self,
        session_id: String,
        request_id: String,
        answers: HashMap<String, Vec<String>>,
    ) -> Result<(), String> {
        self.poll_connection_health()?;
        let turn_id = self.user_inputs.resolve_turn_id(&request_id)?;
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| "ACP runtime is not initialized.".to_string())?
            .clone();

        let response = UserInputAnswerPayload {
            turn_id,
            response: UserInputResponsePayload {
                answers: answers
                    .into_iter()
                    .map(|(question_id, answers)| {
                        (question_id, UserInputAnswerValuePayload { answers })
                    })
                    .collect(),
            },
        };
        let content = format!(
            "{ACP_USER_INPUT_RESPONSE_PREFIX}{}",
            serde_json::to_string(&response).map_err(|error| error.to_string())?
        );

        connection
            .prompt(PromptRequest::new(
                SessionId::new(session_id),
                vec![ContentBlock::from(content)],
            ))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh"];
/// Strip the reasoning-effort suffix that the ACP bakes into model IDs and names.
/// IDs use slash format:   "gpt-5.3-codex/medium" → "gpt-5.3-codex"
/// Names use paren format: "gpt-5.3-codex (medium)" → "gpt-5.3-codex"
fn strip_effort_suffix(text: &str) -> &str {
    for level in EFFORT_LEVELS {
        if let Some(base) = text.strip_suffix(&format!("/{level}")) {
            return base;
        }
        if let Some(base) = text.strip_suffix(&format!(" ({level})")) {
            return base;
        }
    }
    text
}

/// Extract the effort level from an ACP model id (e.g. "gpt-5.3-codex/medium" → "medium").
fn extract_effort(model_id: &str) -> Option<&str> {
    let suffix = model_id.rsplit('/').next()?;
    EFFORT_LEVELS.iter().find(|&&l| l == suffix).copied()
}

/// Deduplicate ACP models (which encode effort AND size variant in the id)
/// and build an effort map keyed by the canonical model id used in the dropdown.
///
/// The canonical id is the ACP base id of the first variant seen (e.g. "gpt-5.1-codex-max").
/// The display name strips both effort and size variant (e.g. "gpt-5.1-codex").
struct MappedModels {
    models: Vec<AiModelOption>,
    efforts_by_model: std::collections::HashMap<String, Vec<String>>,
    acp_model_ids: std::collections::HashMap<String, String>,
}

fn map_loaded_session_state(
    session_id: String,
    models_state: Option<agent_client_protocol::SessionModelState>,
    modes_state: Option<agent_client_protocol::SessionModeState>,
    config_options: Option<Vec<agent_client_protocol::SessionConfigOption>>,
) -> Result<CodexSessionState, String> {
    let current_model_id = models_state
        .as_ref()
        .map(|state| strip_effort_suffix(&state.current_model_id.0).to_string())
        .unwrap_or_default();

    let mapped = models_state.map(map_session_models);
    let (models, efforts_by_model, acp_model_ids) = match mapped {
        Some(mapped) => (mapped.models, mapped.efforts_by_model, mapped.acp_model_ids),
        None => Default::default(),
    };

    Ok(CodexSessionState {
        session_id,
        model_id: current_model_id,
        mode_id: modes_state
            .as_ref()
            .map(|state| state.current_mode_id.0.to_string())
            .unwrap_or_else(|| "default".to_string()),
        models,
        modes: modes_state.map(map_session_modes).unwrap_or_default(),
        config_options: config_options
            .map(map_session_config_options)
            .unwrap_or_default(),
        efforts_by_model,
        acp_model_ids,
    })
}

#[derive(Debug, Clone)]
struct ParsedUserInputRequest {
    session_id: String,
    request_id: String,
    turn_id: String,
    title: String,
    questions: Vec<AiUserInputQuestionPayload>,
}

impl ParsedUserInputRequest {
    fn into_emit_payload(self) -> AiUserInputRequestPayload {
        AiUserInputRequestPayload {
            session_id: self.session_id,
            request_id: self.request_id,
            title: self.title,
            questions: self.questions,
        }
    }
}

fn map_session_models(state: agent_client_protocol::SessionModelState) -> MappedModels {
    // display_id (keeps size variant) → canonical ACP base id (first variant seen)
    let mut canonical_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut efforts_by_model: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut models = Vec::new();

    for model in state.available_models {
        let acp_base = strip_effort_suffix(&model.model_id.0).to_string();
        let display_id = acp_base.clone();

        let canon = canonical_id
            .entry(display_id.clone())
            .or_insert_with(|| acp_base.clone());

        if let Some(effort) = extract_effort(&model.model_id.0) {
            // Only track efforts for the canonical (first) variant.
            if *canon == acp_base {
                efforts_by_model
                    .entry(display_id.clone())
                    .or_default()
                    .push(effort.to_string());
            }
        }

        // Already added this display model.
        if canon != &acp_base || models.iter().any(|m: &AiModelOption| m.id == display_id) {
            continue;
        }

        models.push(AiModelOption {
            id: display_id,
            runtime_id: CODEX_RUNTIME_ID.to_string(),
            name: strip_effort_suffix(&model.name).to_string(),
            description: model.description.unwrap_or_default(),
        });
    }

    MappedModels {
        models,
        efforts_by_model,
        acp_model_ids: canonical_id,
    }
}

fn map_session_modes(state: agent_client_protocol::SessionModeState) -> Vec<AiModeOption> {
    state
        .available_modes
        .into_iter()
        .map(|mode| AiModeOption {
            id: mode.id.0.to_string(),
            runtime_id: CODEX_RUNTIME_ID.to_string(),
            name: mode.name,
            description: mode.description.unwrap_or_default(),
            disabled: false,
        })
        .collect()
}

fn map_session_config_options(
    options: Vec<agent_client_protocol::SessionConfigOption>,
) -> Vec<AiConfigOption> {
    options
        .into_iter()
        .filter_map(|option| {
            let select = match option.kind {
                agent_client_protocol::SessionConfigKind::Select(select) => select,
                _ => return None,
            };
            let select_options = match select.options {
                agent_client_protocol::SessionConfigSelectOptions::Ungrouped(options) => options,
                agent_client_protocol::SessionConfigSelectOptions::Grouped(groups) => {
                    groups.into_iter().flat_map(|group| group.options).collect()
                }
                _ => Vec::new(),
            };

            Some(AiConfigOption {
                id: option.id.0.to_string(),
                runtime_id: CODEX_RUNTIME_ID.to_string(),
                category: match option.category {
                    Some(agent_client_protocol::SessionConfigOptionCategory::Mode) => {
                        AiConfigOptionCategory::Mode
                    }
                    Some(agent_client_protocol::SessionConfigOptionCategory::Model) => {
                        AiConfigOptionCategory::Model
                    }
                    Some(agent_client_protocol::SessionConfigOptionCategory::ThoughtLevel) => {
                        AiConfigOptionCategory::Reasoning
                    }
                    Some(agent_client_protocol::SessionConfigOptionCategory::Other(value)) => {
                        let _ = value;
                        AiConfigOptionCategory::Other
                    }
                    None => AiConfigOptionCategory::Other,
                    Some(_) => AiConfigOptionCategory::Other,
                },
                label: option.name,
                description: option.description,
                kind: "select".to_string(),
                value: select.current_value.0.to_string(),
                options: select_options
                    .into_iter()
                    .map(|item| AiConfigSelectOption {
                        value: item.value.0.to_string(),
                        label: item.name,
                        description: item.description,
                    })
                    .collect(),
            })
        })
        .collect()
}

fn map_permission_option(option: PermissionOption) -> AiPermissionOptionPayload {
    AiPermissionOptionPayload {
        option_id: option.option_id.0.to_string(),
        name: option.name,
        kind: match option.kind {
            agent_client_protocol::PermissionOptionKind::AllowOnce => "allow_once".to_string(),
            agent_client_protocol::PermissionOptionKind::AllowAlways => "allow_always".to_string(),
            agent_client_protocol::PermissionOptionKind::RejectOnce => "reject_once".to_string(),
            agent_client_protocol::PermissionOptionKind::RejectAlways => {
                "reject_always".to_string()
            }
            _ => "other".to_string(),
        },
    }
}

fn map_tool_call(
    session_id: &str,
    tool_call: &ToolCall,
    terminal_summary: Option<String>,
    diffs: Vec<AiFileDiffPayload>,
) -> AiToolActivityPayload {
    AiToolActivityPayload {
        session_id: session_id.to_string(),
        tool_call_id: tool_call.tool_call_id.0.to_string(),
        title: tool_call.title.clone(),
        kind: match tool_call.kind {
            agent_client_protocol::ToolKind::Read => "read".to_string(),
            agent_client_protocol::ToolKind::Edit => "edit".to_string(),
            agent_client_protocol::ToolKind::Delete => "delete".to_string(),
            agent_client_protocol::ToolKind::Move => "move".to_string(),
            agent_client_protocol::ToolKind::Search => "search".to_string(),
            agent_client_protocol::ToolKind::Execute => "execute".to_string(),
            agent_client_protocol::ToolKind::Think => "think".to_string(),
            agent_client_protocol::ToolKind::Fetch => "fetch".to_string(),
            agent_client_protocol::ToolKind::SwitchMode => "switch_mode".to_string(),
            agent_client_protocol::ToolKind::Other => "other".to_string(),
            _ => "other".to_string(),
        },
        status: match tool_call.status {
            ToolCallStatus::Pending => "pending".to_string(),
            ToolCallStatus::InProgress => "in_progress".to_string(),
            ToolCallStatus::Completed => "completed".to_string(),
            ToolCallStatus::Failed => "failed".to_string(),
            _ => "other".to_string(),
        },
        target: tool_call
            .locations
            .first()
            .map(|location| location.path.display().to_string()),
        summary: terminal_summary.or_else(|| summarize_tool_content(tool_call)),
        diffs: (!diffs.is_empty()).then_some(diffs),
    }
}

fn map_status_event(session_id: &str, tool_call: &ToolCall) -> Option<AiStatusEventPayload> {
    let meta = tool_call.meta.as_ref()?;
    let event_type = meta_get_str(meta, ACP_STATUS_EVENT_TYPE_KEY)?;
    if event_type != "status" {
        return None;
    }

    let kind = meta_get(meta, ACP_STATUS_KIND_KEY)
        .and_then(|value| value.as_str())
        .unwrap_or("status")
        .to_string();
    let emphasis = meta_get(meta, ACP_STATUS_EMPHASIS_KEY)
        .and_then(|value| value.as_str())
        .unwrap_or("neutral")
        .to_string();

    Some(AiStatusEventPayload {
        session_id: session_id.to_string(),
        event_id: tool_call.tool_call_id.0.to_string(),
        kind,
        status: match tool_call.status {
            ToolCallStatus::Pending => "pending".to_string(),
            ToolCallStatus::InProgress => "in_progress".to_string(),
            ToolCallStatus::Completed => "completed".to_string(),
            ToolCallStatus::Failed => "failed".to_string(),
            _ => "other".to_string(),
        },
        title: tool_call.title.clone(),
        detail: summarize_tool_content(tool_call),
        emphasis,
    })
}

fn map_plan_update(session_id: &str, plan: agent_client_protocol::Plan) -> AiPlanUpdatePayload {
    let title = plan
        .meta
        .as_ref()
        .and_then(|meta| meta_get(meta, ACP_PLAN_TITLE_KEY))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let detail = plan
        .meta
        .as_ref()
        .and_then(|meta| meta_get(meta, ACP_PLAN_DETAIL_KEY))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);

    AiPlanUpdatePayload {
        session_id: session_id.to_string(),
        plan_id: format!("{session_id}:plan"),
        title,
        detail,
        entries: plan
            .entries
            .into_iter()
            .map(|entry| AiPlanEntryPayload {
                content: entry.content,
                priority: match entry.priority {
                    agent_client_protocol::PlanEntryPriority::High => "high".to_string(),
                    agent_client_protocol::PlanEntryPriority::Medium => "medium".to_string(),
                    agent_client_protocol::PlanEntryPriority::Low => "low".to_string(),
                    _ => "medium".to_string(),
                },
                status: match entry.status {
                    agent_client_protocol::PlanEntryStatus::Pending => "pending".to_string(),
                    agent_client_protocol::PlanEntryStatus::InProgress => "in_progress".to_string(),
                    agent_client_protocol::PlanEntryStatus::Completed => "completed".to_string(),
                    _ => "pending".to_string(),
                },
            })
            .collect(),
    }
}

fn map_usage_update(
    session_id: &str,
    update: agent_client_protocol::UsageUpdate,
) -> AiTokenUsagePayload {
    AiTokenUsagePayload {
        session_id: session_id.to_string(),
        used: update.used,
        size: update.size,
        cost: update.cost.map(|cost| AiTokenUsageCostPayload {
            amount: cost.amount,
            currency: cost.currency,
        }),
    }
}

fn map_user_input_request(
    session_id: &str,
    tool_call: &ToolCall,
) -> Option<ParsedUserInputRequest> {
    let meta = tool_call.meta.as_ref()?;
    let event_type = meta_get_str(meta, ACP_STATUS_EVENT_TYPE_KEY)?;
    if event_type != ACP_USER_INPUT_EVENT_TYPE {
        return None;
    }

    let raw_input = tool_call.raw_input.as_ref()?;
    let request = serde_json::from_value::<RawUserInputRequest>(raw_input.clone()).ok()?;
    let questions = request
        .questions
        .into_iter()
        .map(|question| AiUserInputQuestionPayload {
            id: question.id,
            header: question.header,
            question: question.question,
            is_other: question.is_other,
            is_secret: question.is_secret,
            options: question.options.map(|options| {
                options
                    .into_iter()
                    .map(|option| AiUserInputQuestionOptionPayload {
                        label: option.label,
                        description: option.description,
                    })
                    .collect()
            }),
        })
        .collect::<Vec<_>>();

    let title = questions
        .first()
        .map(|question| question.header.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| tool_call.title.clone());

    Some(ParsedUserInputRequest {
        session_id: session_id.to_string(),
        request_id: request.request_id,
        turn_id: request.turn_id,
        title,
        questions,
    })
}

fn summarize_tool_content(tool_call: &ToolCall) -> Option<String> {
    tool_call.content.iter().find_map(|item| match item {
        ToolCallContent::Content(content) => match &content.content {
            ContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        },
        ToolCallContent::Diff(diff) => Some(format!("Updated {}", diff.path.display())),
        ToolCallContent::Terminal(_) => Some("Terminal output available.".to_string()),
        _ => None,
    })
}

fn terminal_output_from_meta(meta: &Meta) -> Option<String> {
    meta.get("terminal_output")
        .and_then(|value| value.as_object())
        .and_then(|object| object.get("data"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn terminal_exit_from_meta(meta: &Meta) -> Option<TerminalExitMeta> {
    let object = meta.get("terminal_exit")?.as_object()?;
    let exit_code = object.get("exit_code").and_then(|value| value.as_i64());
    let signal = object
        .get("signal")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);

    Some(TerminalExitMeta { exit_code, signal })
}

fn trim_terminal_buffer(buffer: &mut String) {
    if buffer.len() <= MAX_TERMINAL_SUMMARY_CHARS {
        return;
    }

    let keep_from = buffer.len().saturating_sub(MAX_TERMINAL_SUMMARY_CHARS);
    let trimmed = buffer
        .get(keep_from..)
        .unwrap_or(buffer.as_str())
        .to_string();
    *buffer = format!("...[truncated]\n{trimmed}");
}

fn format_terminal_summary(output: &str, exit: Option<&TerminalExitMeta>) -> String {
    let mut summary = output.trim_end_matches('\0').to_string();
    if let Some(exit) = exit {
        let suffix = format_terminal_exit_only(exit);
        if !summary.is_empty() {
            summary.push_str("\n\n");
        }
        summary.push_str(&suffix);
    }
    summary
}

fn format_terminal_exit_only(exit: &TerminalExitMeta) -> String {
    match (exit.exit_code, exit.signal.as_deref()) {
        (Some(code), Some(signal)) => format!("[process exited: code {code}, signal {signal}]"),
        (Some(code), None) => format!("[process exited: code {code}]"),
        (None, Some(signal)) => format!("[process exited: signal {signal}]"),
        (None, None) => "[process exited]".to_string(),
    }
}

fn write_tool_input(raw_input: Option<&serde_json::Value>) -> Option<WriteToolInput> {
    serde_json::from_value(raw_input?.clone()).ok()
}

fn edit_tool_input(raw_input: Option<&serde_json::Value>) -> Option<EditToolInput> {
    serde_json::from_value(raw_input?.clone()).ok()
}

fn read_tool_input(raw_input: Option<&serde_json::Value>) -> Option<ReadToolInput> {
    serde_json::from_value(raw_input?.clone()).ok()
}

fn is_edit_tool_input(raw_input: Option<&serde_json::Value>) -> bool {
    let Some(raw_input) = raw_input else {
        return false;
    };
    let Some(object) = raw_input.as_object() else {
        return false;
    };
    object.contains_key("file_path")
        && (object.contains_key("old_string") || object.contains_key("new_string"))
}

fn resolve_tool_path(file_path: &str, cwd: Option<&Path>) -> PathBuf {
    let candidate = PathBuf::from(file_path);
    if candidate.is_absolute() {
        candidate
    } else if let Some(cwd) = cwd {
        cwd.join(candidate)
    } else {
        candidate
    }
}

fn to_display_path(file_path: &Path, cwd: Option<&Path>) -> String {
    let Some(cwd) = cwd else {
        return file_path.to_string_lossy().to_string();
    };

    if file_path.is_absolute() && file_path.starts_with(cwd) {
        if let Ok(relative) = file_path.strip_prefix(cwd) {
            return relative.to_string_lossy().to_string();
        }
    }

    file_path.to_string_lossy().to_string()
}

enum ExistingTextSnapshot {
    Missing,
    Text(String),
    Unavailable,
}

fn read_existing_text_snapshot(path: &Path) -> ExistingTextSnapshot {
    match fs::read(path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => ExistingTextSnapshot::Text(text),
            Err(_) => ExistingTextSnapshot::Unavailable,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ExistingTextSnapshot::Missing,
        Err(_) => ExistingTextSnapshot::Unavailable,
    }
}

fn replace_exactly_once(text: &str, needle: &str, replacement: &str) -> Option<String> {
    if needle.is_empty() {
        return None;
    }

    let mut matches = text.match_indices(needle);
    let (first_index, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }

    let mut result =
        String::with_capacity(text.len() + replacement.len().saturating_sub(needle.len()));
    result.push_str(&text[..first_index]);
    result.push_str(replacement);
    result.push_str(&text[first_index + needle.len()..]);
    Some(result)
}

fn reconstruct_write_diff_payload(
    raw_input: &serde_json::Value,
    cwd: Option<&Path>,
) -> Option<AiFileDiffPayload> {
    let input = write_tool_input(Some(raw_input))?;
    if input.file_path.trim().is_empty() {
        return None;
    }

    let resolved_path = resolve_tool_path(&input.file_path, cwd);
    let display_path = to_display_path(&resolved_path, cwd);

    let diff = match read_existing_text_snapshot(&resolved_path) {
        ExistingTextSnapshot::Missing => AiFileDiffPayload {
            path: display_path,
            kind: "add".to_string(),
            previous_path: None,
            reversible: true,
            is_text: true,
            old_text: None,
            new_text: Some(input.content),
            hunks: None,
        },
        ExistingTextSnapshot::Text(old_text) => {
            if old_text == input.content {
                AiFileDiffPayload {
                    path: display_path,
                    kind: "update".to_string(),
                    previous_path: None,
                    reversible: false,
                    is_text: true,
                    old_text: None,
                    new_text: Some(input.content),
                    hunks: None,
                }
            } else {
                AiFileDiffPayload {
                    path: display_path,
                    kind: "update".to_string(),
                    previous_path: None,
                    reversible: true,
                    is_text: true,
                    old_text: Some(old_text),
                    new_text: Some(input.content),
                    hunks: None,
                }
            }
        }
        ExistingTextSnapshot::Unavailable => AiFileDiffPayload {
            path: display_path,
            kind: "update".to_string(),
            previous_path: None,
            reversible: false,
            is_text: false,
            old_text: None,
            new_text: Some(input.content),
            hunks: None,
        },
    };

    Some(diff)
}

fn reconstruct_edit_diff_payload(
    raw_input: &serde_json::Value,
    cwd: Option<&Path>,
) -> Option<AiFileDiffPayload> {
    let input = edit_tool_input(Some(raw_input))?;
    if input.file_path.trim().is_empty() {
        return None;
    }

    let resolved_path = resolve_tool_path(&input.file_path, cwd);
    let display_path = to_display_path(&resolved_path, cwd);
    let current_text = match read_existing_text_snapshot(&resolved_path) {
        ExistingTextSnapshot::Text(text) => text,
        _ => return None,
    };
    let old_text = replace_exactly_once(&current_text, &input.new_string, &input.old_string)?;

    Some(AiFileDiffPayload {
        path: display_path,
        kind: "update".to_string(),
        previous_path: None,
        reversible: true,
        is_text: true,
        old_text: Some(old_text),
        new_text: Some(current_text),
        hunks: None,
    })
}

fn diff_previous_path(diff: &agent_client_protocol::Diff, cwd: Option<&Path>) -> Option<String> {
    diff.meta
        .as_ref()
        .and_then(|meta| meta_get(meta, ACP_DIFF_PREVIOUS_PATH_KEY))
        .and_then(|value| value.as_str())
        .map(|path| to_display_path(&resolve_tool_path(path, cwd), cwd))
}

fn diff_hunks(diff: &agent_client_protocol::Diff) -> Option<Vec<AiFileDiffHunkPayload>> {
    diff.meta
        .as_ref()
        .and_then(|meta| meta_get(meta, ACP_DIFF_HUNKS_KEY))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .filter(|hunks: &Vec<AiFileDiffHunkPayload>| !hunks.is_empty())
}

fn has_reliable_old_text(old_text: Option<&str>) -> bool {
    matches!(old_text, Some(text) if text != FILE_DELETED_PLACEHOLDER)
}

fn classify_diff_kind(
    diff: &agent_client_protocol::Diff,
    raw_input: Option<&serde_json::Value>,
    previous_path: Option<&String>,
) -> &'static str {
    if previous_path.is_some() {
        return "move";
    }
    if is_edit_tool_input(raw_input) {
        return "update";
    }
    if write_tool_input(raw_input).is_some() {
        return if diff.old_text.is_none() {
            "add"
        } else {
            "update"
        };
    }
    if diff.old_text.is_none() {
        "add"
    } else if diff.new_text.is_empty() {
        "delete"
    } else {
        "update"
    }
}

fn map_diff_payload(
    diff: &agent_client_protocol::Diff,
    raw_input: Option<&serde_json::Value>,
    cwd: Option<&Path>,
) -> AiFileDiffPayload {
    let previous_path = diff_previous_path(diff, cwd);
    let old_text = diff.old_text.as_deref();
    let kind = classify_diff_kind(diff, raw_input, previous_path.as_ref());
    let text_changed = old_text
        .map(|text| text != diff.new_text)
        .unwrap_or(!diff.new_text.is_empty());
    let reversible = match kind {
        "add" => true,
        "delete" | "update" => has_reliable_old_text(old_text),
        "move" => previous_path.is_some() && (!text_changed || has_reliable_old_text(old_text)),
        _ => false,
    };

    AiFileDiffPayload {
        path: to_display_path(&diff.path, cwd),
        kind: kind.to_string(),
        previous_path,
        reversible,
        is_text: true,
        old_text: diff.old_text.clone(),
        new_text: if kind == "delete" {
            None
        } else {
            Some(diff.new_text.clone())
        },
        hunks: diff_hunks(diff),
    }
}

fn collect_tool_call_diffs(tool_call: &ToolCall, cwd: Option<&Path>) -> Vec<AiFileDiffPayload> {
    tool_call
        .content
        .iter()
        .filter_map(|item| match item {
            ToolCallContent::Diff(diff) => {
                Some(map_diff_payload(diff, tool_call.raw_input.as_ref(), cwd))
            }
            _ => None,
        })
        .collect()
}

fn prepare_runtime_command(command: &mut Command, cwd: Option<&Path>) -> Result<(), String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("CODEX_HOME");
    crate::ai::shared::configure_background_process(command);
    if let Some(path) = preferred_path_value() {
        command.env("PATH", path);
    }
    apply_auth_env(command)?;

    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::{Diff, Meta, ToolCallId, ToolKind};
    use std::{env, ffi::OsStr, fs, path::PathBuf};

    use super::*;
    use crate::ai::env::preferred_path_value;

    #[test]
    fn map_tool_call_extracts_structured_diffs() {
        let tool_call = ToolCall::new(ToolCallId::from("tool-1"), "Edit watcher")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![
                ToolCallContent::Diff(Diff::new("/tmp/new.rs", "new line").old_text("old line")),
                ToolCallContent::Diff(Diff::new("/tmp/added.rs", "added line")),
                ToolCallContent::Diff(Diff::new("/tmp/deleted.rs", "").old_text("gone")),
            ]);

        let payload = map_tool_call(
            "session-1",
            &tool_call,
            None,
            collect_tool_call_diffs(&tool_call, None),
        );

        assert_eq!(payload.kind, "edit");
        assert_eq!(payload.diffs.as_ref().map(Vec::len), Some(3));
        assert_eq!(
            payload
                .diffs
                .as_ref()
                .and_then(|diffs| diffs.first())
                .map(|diff| diff.kind.as_str()),
            Some("update")
        );
        assert_eq!(
            payload
                .diffs
                .as_ref()
                .and_then(|diffs| diffs.get(1))
                .map(|diff| diff.kind.as_str()),
            Some("add")
        );
        assert_eq!(
            payload
                .diffs
                .as_ref()
                .and_then(|diffs| diffs.get(2))
                .map(|diff| diff.kind.as_str()),
            Some("delete")
        );
        assert_eq!(
            payload
                .diffs
                .as_ref()
                .and_then(|diffs| diffs.first())
                .map(|diff| diff.reversible),
            Some(true)
        );
    }

    #[test]
    fn map_tool_call_keeps_summary_without_diffs() {
        let tool_call = ToolCall::new(ToolCallId::from("tool-2"), "Read file")
            .kind(ToolKind::Read)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Content(
                agent_client_protocol::Content::new("README.md"),
            )]);

        let payload = map_tool_call("session-1", &tool_call, None, Vec::new());

        assert_eq!(payload.summary.as_deref(), Some("README.md"));
        assert!(payload.diffs.is_none());
    }

    #[test]
    fn map_tool_call_marks_placeholder_delete_as_non_reversible() {
        let tool_call = ToolCall::new(ToolCallId::from("tool-3"), "Delete file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/deleted.rs", "").old_text(FILE_DELETED_PLACEHOLDER),
            )]);

        let payload = map_tool_call(
            "session-1",
            &tool_call,
            None,
            collect_tool_call_diffs(&tool_call, None),
        );
        let diff = payload
            .diffs
            .as_ref()
            .and_then(|diffs| diffs.first())
            .unwrap();

        assert_eq!(diff.kind, "delete");
        assert!(!diff.reversible);
        assert!(diff.is_text);
    }

    #[test]
    fn map_tool_call_preserves_move_source_path() {
        let tool_call = ToolCall::new(ToolCallId::from("tool-4"), "Move file")
            .kind(ToolKind::Move)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/new.rs", "updated")
                    .old_text("original")
                    .meta(Meta::from_iter([(
                        ACP_DIFF_PREVIOUS_PATH_KEY.to_string(),
                        serde_json::json!("/tmp/old.rs"),
                    )])),
            )]);

        let payload = map_tool_call(
            "session-1",
            &tool_call,
            None,
            collect_tool_call_diffs(&tool_call, None),
        );
        let diff = payload
            .diffs
            .as_ref()
            .and_then(|diffs| diffs.first())
            .unwrap();

        assert_eq!(diff.kind, "move");
        assert_eq!(diff.previous_path.as_deref(), Some("/tmp/old.rs"));
        assert!(diff.reversible);
    }

    #[test]
    fn map_tool_call_extracts_exact_hunks_from_meta() {
        let tool_call = ToolCall::new(ToolCallId::from("tool-6"), "Edit watcher")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/watcher.rs", "new line")
                    .old_text("old line")
                    .meta(Meta::from_iter([(
                        ACP_DIFF_HUNKS_KEY.to_string(),
                        serde_json::json!([
                            {
                                "old_start": 12,
                                "old_count": 1,
                                "new_start": 12,
                                "new_count": 1,
                                "lines": [
                                    { "type": "remove", "text": "old line" },
                                    { "type": "add", "text": "new line" }
                                ]
                            }
                        ]),
                    )])),
            )]);

        let payload = map_tool_call(
            "session-1",
            &tool_call,
            None,
            collect_tool_call_diffs(&tool_call, None),
        );
        let diff = payload
            .diffs
            .as_ref()
            .and_then(|diffs| diffs.first())
            .unwrap();

        assert_eq!(diff.hunks.as_ref().map(Vec::len), Some(1));
        let hunk = diff.hunks.as_ref().and_then(|hunks| hunks.first()).unwrap();
        assert_eq!(hunk.old_start, 12);
        assert_eq!(hunk.new_start, 12);
        assert_eq!(
            hunk.lines
                .iter()
                .map(|line| line.r#type.as_str())
                .collect::<Vec<_>>(),
            vec!["remove", "add"]
        );
    }

    #[test]
    fn map_tool_call_keeps_real_delete_snapshot_when_available() {
        let tool_call = ToolCall::new(ToolCallId::from("tool-5"), "Delete file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/deleted.rs", "").old_text("real previous content"),
            )]);

        let payload = map_tool_call(
            "session-1",
            &tool_call,
            None,
            collect_tool_call_diffs(&tool_call, None),
        );
        let diff = payload
            .diffs
            .as_ref()
            .and_then(|diffs| diffs.first())
            .unwrap();

        assert_eq!(diff.kind, "delete");
        assert!(diff.reversible);
        assert_eq!(diff.old_text.as_deref(), Some("real previous content"));
        assert_eq!(diff.new_text, None);
    }

    #[test]
    fn map_tool_call_prefers_terminal_summary_when_present() {
        let tool_call = ToolCall::new(ToolCallId::from("tool-7"), "Run cargo test")
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Terminal(
                agent_client_protocol::Terminal::new("terminal-1"),
            )]);

        let payload = map_tool_call(
            "session-1",
            &tool_call,
            Some("running tests\n\n[process exited: code 0]".to_string()),
            Vec::new(),
        );

        assert_eq!(
            payload.summary.as_deref(),
            Some("running tests\n\n[process exited: code 0]")
        );
    }

    #[test]
    fn tool_state_collects_terminal_meta_into_summary() {
        let tools = ToolState::default();
        let session_id = "session-1";
        let tool_call_id = "tool-8";

        let initial = ToolCall::new(ToolCallId::from(tool_call_id), "Run cargo fmt")
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::InProgress)
            .content(vec![ToolCallContent::Terminal(
                agent_client_protocol::Terminal::new("terminal-8"),
            )]);
        tools.upsert_tool_call(session_id, initial);

        tools.apply_tool_update(
            session_id,
            ToolCallUpdate::new(ToolCallId::from(tool_call_id), Default::default()).meta(
                Meta::from_iter([(
                    "terminal_output".to_string(),
                    serde_json::json!({
                        "terminal_id": "terminal-8",
                        "data": "fmt output"
                    }),
                )]),
            ),
        );
        tools.apply_tool_update(
            session_id,
            ToolCallUpdate::new(ToolCallId::from(tool_call_id), Default::default()).meta(
                Meta::from_iter([(
                    "terminal_exit".to_string(),
                    serde_json::json!({
                        "terminal_id": "terminal-8",
                        "exit_code": 0,
                        "signal": null
                    }),
                )]),
            ),
        );

        assert_eq!(
            tools.terminal_summary(session_id, tool_call_id).as_deref(),
            Some("fmt output\n\n[process exited: code 0]")
        );
    }

    #[test]
    fn external_baseline_reconstructs_full_write_diff() {
        let temp_dir = env::temp_dir().join(format!(
            "neverwrite-codex-baseline-tests-{}",
            std::process::id()
        ));
        fs::create_dir_all(temp_dir.join("notes")).unwrap();
        let file_path = temp_dir.join("notes").join("external.md");
        fs::write(&file_path, "disk content").unwrap();

        let tools = ToolState::default();
        tools.register_session_cwd("session-1", temp_dir.clone());
        tools.store_file_baseline("session-1", "notes/external.md", "editor content".into());

        let tool_call = ToolCall::new(ToolCallId::from("tool-9"), "Write external.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "notes/external.md",
                "content": "codex content"
            }))
            .content(vec![ToolCallContent::Diff(
                Diff::new(file_path.display().to_string(), "codex content")
                    .old_text("wrong old text from ACP"),
            )]);

        let registered = tools.upsert_tool_call("session-1", tool_call);
        let diffs = tools.normalized_diffs_for_tool_call("session-1", &registered);

        assert_eq!(diffs[0].old_text.as_deref(), Some("editor content"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("codex content"));
        assert!(diffs[0].reversible);
    }

    #[test]
    fn prepare_runtime_command_removes_inherited_codex_home() {
        let original = env::var_os("CODEX_HOME");
        env::set_var("CODEX_HOME", "/tmp/inherited-codex-home");

        let mut command = Command::new("true");
        prepare_runtime_command(&mut command, Some(PathBuf::from("/tmp").as_path())).unwrap();

        let codex_home_env = command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("CODEX_HOME"))
            .map(|(_, value)| value);
        let path_env = command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PATH"))
            .and_then(|(_, value)| value);

        match original {
            Some(value) => env::set_var("CODEX_HOME", value),
            None => env::remove_var("CODEX_HOME"),
        }

        assert_eq!(codex_home_env, Some(None));
        assert_eq!(path_env, preferred_path_value().as_deref());
        assert_eq!(command.as_std().get_current_dir(), Some(Path::new("/tmp")));
    }
}
