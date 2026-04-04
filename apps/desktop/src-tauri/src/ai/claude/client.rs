use std::{
    collections::{HashMap, HashSet, VecDeque},
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
    Agent, Client, ClientCapabilities, ClientSideConnection, ContentBlock, ContentChunk,
    FileSystemCapabilities, ForkSessionRequest, Implementation, InitializeRequest,
    ListSessionsRequest, LoadSessionRequest, Meta, NewSessionRequest, PermissionOption,
    PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, Result as AcpResult, ResumeSessionRequest,
    SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, SetSessionModelRequest, ToolCall,
    ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use serde::Deserialize;
use tauri::AppHandle;
use tokio::{io::AsyncReadExt, process::Command, runtime::Builder, sync::oneshot, task::LocalSet};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use tokio::sync::mpsc as tokio_mpsc;
use vault_ai_ai::{
    AiConfigOption, AiConfigOptionCategory, AiConfigSelectOption, AiModeOption, AiModelOption,
    AiRuntimeSessionSummary, AiSession, CLAUDE_RUNTIME_ID,
};

use crate::ai::emit::{
    emit_available_commands_updated, emit_message_completed, emit_message_delta,
    emit_message_started, emit_permission_request, emit_plan_update, emit_runtime_connection,
    emit_session_error, emit_session_updated, emit_status_event, emit_thinking_completed,
    emit_thinking_delta, emit_thinking_started, emit_tool_activity, AiAvailableCommandPayload,
    AiAvailableCommandsPayload, AiFileDiffHunkPayload, AiFileDiffPayload,
    AiPermissionOptionPayload, AiPermissionRequestPayload, AiPlanEntryPayload, AiPlanUpdatePayload,
    AiRuntimeConnectionPayload, AiStatusEventPayload, AiToolActivityPayload,
};
use crate::ai::env::preferred_path_value;

use super::{process::ClaudeProcessSpec, setup::apply_auth_env};

const VAULTAI_STATUS_EVENT_TYPE_KEY: &str = "vaultaiEventType";
const VAULTAI_STATUS_KIND_KEY: &str = "vaultaiStatusKind";
const VAULTAI_STATUS_EMPHASIS_KEY: &str = "vaultaiStatusEmphasis";
const VAULTAI_PLAN_TITLE_KEY: &str = "vaultaiPlanTitle";
const VAULTAI_PLAN_DETAIL_KEY: &str = "vaultaiPlanDetail";
const VAULTAI_DIFF_PREVIOUS_PATH_KEY: &str = "vaultaiPreviousPath";
const VAULTAI_DIFF_HUNKS_KEY: &str = "vaultaiHunks";
const FILE_DELETED_PLACEHOLDER: &str = "[file deleted]";
const MAX_TERMINAL_SUMMARY_CHARS: usize = 8_000;

enum RuntimeCommand {
    CreateSession {
        spec: ClaudeProcessSpec,
        additional_roots: Option<Vec<String>>,
        response_tx: mpsc::Sender<Result<ClaudeSessionState, String>>,
    },
    LoadSession {
        spec: ClaudeProcessSpec,
        session_id: String,
        response_tx: mpsc::Sender<Result<ClaudeSessionState, String>>,
    },
    ListSessions {
        spec: ClaudeProcessSpec,
        response_tx: mpsc::Sender<Result<Vec<AiRuntimeSessionSummary>, String>>,
    },
    ResumeSession {
        spec: ClaudeProcessSpec,
        session_id: String,
        response_tx: mpsc::Sender<Result<ClaudeSessionState, String>>,
    },
    ForkSession {
        spec: ClaudeProcessSpec,
        session_id: String,
        response_tx: mpsc::Sender<Result<ClaudeSessionState, String>>,
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
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    Prompt {
        session_id: String,
        content: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    PromptFinished {
        session_id: String,
        result: Result<(), String>,
    },
    Cancel {
        session_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    RespondPermission {
        request_id: String,
        option_id: Option<String>,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    CheckHealth {
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

struct PendingPrompt {
    content: String,
    response_tx: mpsc::Sender<Result<(), String>>,
}

#[derive(Default)]
struct PromptQueueState {
    active_sessions: HashSet<String>,
    pending_by_session: HashMap<String, VecDeque<PendingPrompt>>,
}

impl PromptQueueState {
    fn pop_next(&mut self, session_id: &str) -> Option<PendingPrompt> {
        let next = self
            .pending_by_session
            .get_mut(session_id)
            .and_then(VecDeque::pop_front);

        if self
            .pending_by_session
            .get(session_id)
            .is_some_and(VecDeque::is_empty)
        {
            self.pending_by_session.remove(session_id);
        }

        next
    }

    fn clear_session(&mut self, session_id: &str) -> Vec<PendingPrompt> {
        self.active_sessions.remove(session_id);
        self.pending_by_session
            .remove(session_id)
            .map(VecDeque::into_iter)
            .into_iter()
            .flatten()
            .collect()
    }

    fn clear_queued_session(&mut self, session_id: &str) -> Vec<PendingPrompt> {
        self.pending_by_session
            .remove(session_id)
            .map(VecDeque::into_iter)
            .into_iter()
            .flatten()
            .collect()
    }

    fn clear_all(&mut self) -> Vec<PendingPrompt> {
        self.active_sessions.clear();
        self.pending_by_session
            .drain()
            .flat_map(|(_, queue)| queue.into_iter())
            .collect()
    }
}

#[derive(Debug, Clone, Default)]
struct ToolState {
    calls: Arc<Mutex<HashMap<String, ToolCall>>>,
    terminal_output: Arc<Mutex<HashMap<String, String>>>,
    terminal_exit: Arc<Mutex<HashMap<String, TerminalExitMeta>>>,
    session_cwds: Arc<Mutex<HashMap<String, PathBuf>>>,
    write_diffs: Arc<Mutex<HashMap<String, Vec<AiFileDiffPayload>>>>,
    /// Pre-write file baselines captured when Claude reads a file.
    /// Key: "session_id::display_path", Value: file content at read time.
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

    fn terminal_summary(&self, session_id: &str, tool_call_id: &str) -> Option<String> {
        let key = format!("{session_id}::{tool_call_id}");
        let output = self
            .terminal_output
            .lock()
            .ok()
            .and_then(|guard| guard.get(&key).cloned())
            .filter(|value| !value.is_empty());
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

    fn record_terminal_meta(
        &self,
        session_id: &str,
        tool_call_id: &str,
        meta: Option<&agent_client_protocol::Meta>,
    ) {
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

        // 1. Try baseline from prior Read (most reliable for auto-approved writes)
        let baseline_diff = self.reconstruct_with_baseline(session_id, raw_input, cwd.as_deref());
        let diff = baseline_diff
            // 2. Fallback: reconstruct from disk
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
                // A baseline reconstruction (reversible + old_text) is already cached.
                // Don't overwrite it with ACP diffs whose old_text may come from
                // a different file state (e.g. after a prior edit in the same turn).
                return;
            }

            if has_old_text {
                guard.insert(key, diffs);
            } else {
                guard.entry(key).or_insert(diffs);
            }
        }
    }

    // -- File baseline cache (Read-before-edit pattern) ----------------------

    /// Cache the original file content when Claude reads a file.
    /// At Read time the file is still unmodified, so disk content = baseline.
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
        if let Ok(mut guard) = self.write_diffs.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.session_cwds.lock() {
            guard.remove(session_id);
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

    /// Reconstruct a diff using a cached baseline instead of reading from disk.
    fn reconstruct_with_baseline(
        &self,
        session_id: &str,
        raw_input: &serde_json::Value,
        cwd: Option<&Path>,
    ) -> Option<AiFileDiffPayload> {
        // Write tool
        if let Some(input) = write_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return None;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd);
            let display_path = to_display_path(&resolved, cwd);
            let old_text = self.get_file_baseline(session_id, &display_path)?;

            if old_text == input.content {
                return None; // No real change
            }

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

        // Edit tool — baseline enables reconstruction only when the target is unique.
        if let Some(input) = edit_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return None;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd);
            let display_path = to_display_path(&resolved, cwd);
            let old_text = self.get_file_baseline(session_id, &display_path)?;

            let new_text = replace_exactly_once(&old_text, &input.old_string, &input.new_string)?;

            return Some(AiFileDiffPayload {
                path: display_path,
                kind: "update".to_string(),
                previous_path: None,
                reversible: true,
                is_text: true,
                old_text: Some(old_text),
                new_text: Some(new_text),
                hunks: None,
            });
        }

        None
    }

    /// After a successful edit, update the baseline to reflect the new content
    /// so that consecutive edits to the same file produce correct diffs.
    fn advance_baseline_after_success(
        &self,
        session_id: &str,
        raw_input: Option<&serde_json::Value>,
    ) {
        let Some(raw_input) = raw_input else {
            return;
        };
        let cwd = self.session_cwd(session_id);

        if let Some(input) = write_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd.as_deref());
            let display_path = to_display_path(&resolved, cwd.as_deref());
            let key = format!("{session_id}::{display_path}");
            if let Ok(mut guard) = self.file_baselines.lock() {
                guard.insert(key, input.content);
            }
        } else if let Some(input) = edit_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd.as_deref());
            let display_path = to_display_path(&resolved, cwd.as_deref());
            if let ExistingTextSnapshot::Text(new_content) = read_existing_text_snapshot(&resolved)
            {
                let key = format!("{session_id}::{display_path}");
                if let Ok(mut guard) = self.file_baselines.lock() {
                    guard.insert(key, new_content);
                }
            }
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

/// Drop guard that ensures `emit_message_completed` fires even if the
/// spawned prompt task panics or is cancelled.
struct TurnCompletionGuard {
    app: AppHandle,
    command_tx: tokio_mpsc::UnboundedSender<RuntimeCommand>,
    streaming: StreamingState,
    session_id: String,
    fallback_message_id: String,
    completed: bool,
    queue_drained: bool,
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
        if !self.queue_drained {
            let _ = self.command_tx.send(RuntimeCommand::PromptFinished {
                session_id: self.session_id.clone(),
                result: Err("Claude prompt task ended unexpectedly.".to_string()),
            });
        }
    }
}

struct VaultAiAcpClient {
    app: AppHandle,
    streaming: StreamingState,
    tools: ToolState,
    permissions: PermissionState,
    session_cache: ClaudeSessionCache,
}

#[derive(Debug, Clone)]
pub struct ClaudeSessionState {
    pub session_id: String,
    pub model_id: String,
    pub mode_id: String,
    pub models: Vec<AiModelOption>,
    pub modes: Vec<AiModeOption>,
    pub config_options: Vec<AiConfigOption>,
    /// Maps display model id to the effort levels the ACP supports for it.
    pub efforts_by_model: std::collections::HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ClaudeSessionCache {
    sessions: Arc<Mutex<HashMap<String, AiSession>>>,
}

impl ClaudeSessionCache {
    pub(crate) fn contains(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .ok()
            .is_some_and(|guard| guard.contains_key(session_id))
    }

    pub(crate) fn get(&self, session_id: &str) -> Option<AiSession> {
        self.sessions
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
    }

    pub(crate) fn upsert(&self, session: AiSession) {
        if let Ok(mut guard) = self.sessions.lock() {
            guard.insert(session.session_id.clone(), session);
        }
    }

    pub(crate) fn update<F>(&self, session_id: &str, f: F) -> Option<AiSession>
    where
        F: FnOnce(&mut AiSession),
    {
        let mut guard = self.sessions.lock().ok()?;
        let session = guard.get_mut(session_id)?;
        f(session);
        Some(session.clone())
    }

    pub(crate) fn remove(&self, session_id: &str) {
        if let Ok(mut guard) = self.sessions.lock() {
            guard.remove(session_id);
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut guard) = self.sessions.lock() {
            guard.clear();
        }
    }
}

#[async_trait::async_trait(?Send)]
impl Client for VaultAiAcpClient {
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
                if let Some(payload) = map_status_event(&session_id, &tool_call) {
                    emit_status_event(&self.app, payload);
                } else {
                    let diffs = self
                        .tools
                        .normalized_diffs_for_tool_call(&session_id, &tool_call);
                    emit_tool_activity(
                        &self.app,
                        map_tool_call(
                            &session_id,
                            &tool_call,
                            self.tools
                                .terminal_summary(&session_id, &tool_call.tool_call_id.0),
                            diffs,
                        ),
                    );
                }
            }
            SessionUpdate::ToolCallUpdate(update) => {
                if let Some(tool_call) = self.tools.apply_tool_update(&session_id, update) {
                    if let Some(payload) = map_status_event(&session_id, &tool_call) {
                        emit_status_event(&self.app, payload);
                    } else {
                        let diffs = self
                            .tools
                            .normalized_diffs_for_tool_call(&session_id, &tool_call);
                        emit_tool_activity(
                            &self.app,
                            map_tool_call(
                                &session_id,
                                &tool_call,
                                self.tools
                                    .terminal_summary(&session_id, &tool_call.tool_call_id.0),
                                diffs,
                            ),
                        );
                    }
                }
            }
            SessionUpdate::Plan(plan) => {
                emit_plan_update(&self.app, map_plan_update(&session_id, plan));
            }
            SessionUpdate::AvailableCommandsUpdate(update) => {
                emit_available_commands_updated(
                    &self.app,
                    map_available_commands_update(&session_id, update),
                );
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                let config_options = map_session_config_options(update.config_options);
                if let Some(session) = self.session_cache.update(&session_id, |session| {
                    apply_config_options_to_session(session, config_options.clone());
                }) {
                    emit_session_updated(&self.app, &session);
                }
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                let mode_id = update.current_mode_id.0.to_string();
                if let Some(session) = self.session_cache.update(&session_id, |session| {
                    apply_mode_update_to_session(session, &mode_id);
                }) {
                    emit_session_updated(&self.app, &session);
                }
                emit_status_event(
                    &self.app,
                    AiStatusEventPayload {
                        session_id,
                        event_id: format!("mode:{mode_id}"),
                        kind: "mode_changed".to_string(),
                        status: "completed".to_string(),
                        title: "Mode changed".to_string(),
                        detail: Some(mode_id),
                        emphasis: "neutral".to_string(),
                    },
                );
            }
            _ => {}
        }

        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ClaudeRuntimeHandle {
    command_tx: tokio_mpsc::UnboundedSender<RuntimeCommand>,
}

impl ClaudeRuntimeHandle {
    pub fn spawn(app: AppHandle, session_cache: ClaudeSessionCache) -> Self {
        let (command_tx, command_rx) = tokio_mpsc::unbounded_channel::<RuntimeCommand>();
        let actor_command_tx = command_tx.clone();

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
                if let Err(error) =
                    run_actor(command_rx, app, actor_command_tx, session_cache).await
                {
                    emit_session_error(&app_for_error, None, error);
                }
            });
        });

        Self { command_tx }
    }

    pub fn create_session(
        &self,
        spec: ClaudeProcessSpec,
        additional_roots: Option<Vec<String>>,
    ) -> Result<ClaudeSessionState, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::CreateSession {
                spec,
                additional_roots,
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn load_session(
        &self,
        spec: ClaudeProcessSpec,
        session_id: &str,
    ) -> Result<ClaudeSessionState, String> {
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
        spec: ClaudeProcessSpec,
    ) -> Result<Vec<AiRuntimeSessionSummary>, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::ListSessions { spec, response_tx })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn resume_session(
        &self,
        spec: ClaudeProcessSpec,
        session_id: &str,
    ) -> Result<ClaudeSessionState, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::ResumeSession {
                spec,
                session_id: session_id.to_string(),
                response_tx,
            })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    pub fn fork_session(
        &self,
        spec: ClaudeProcessSpec,
        session_id: &str,
    ) -> Result<ClaudeSessionState, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::ForkSession {
                spec,
                session_id: session_id.to_string(),
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
    ) -> Result<(), String> {
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

    pub fn check_health(&self) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(RuntimeCommand::CheckHealth { response_tx })
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
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

    pub fn clear_session_state(&self, session_id: &str) {
        let _ = self.command_tx.send(RuntimeCommand::ClearSessionState {
            session_id: session_id.to_string(),
        });
    }
}

async fn run_actor(
    mut command_rx: tokio_mpsc::UnboundedReceiver<RuntimeCommand>,
    app: AppHandle,
    command_tx: tokio_mpsc::UnboundedSender<RuntimeCommand>,
    session_cache: ClaudeSessionCache,
) -> Result<(), String> {
    let mut actor = RuntimeActor::new(app, command_tx, session_cache);
    while let Some(command) = command_rx.recv().await {
        actor.handle(command).await;
    }
    Ok(())
}

struct RuntimeActor {
    app: AppHandle,
    command_tx: tokio_mpsc::UnboundedSender<RuntimeCommand>,
    connection: Option<Rc<ClientSideConnection>>,
    _io_task_done: Option<oneshot::Receiver<Result<(), String>>>,
    prompt_queue: PromptQueueState,
    streaming: StreamingState,
    tools: ToolState,
    permissions: PermissionState,
    session_cache: ClaudeSessionCache,
    initialized: bool,
    stderr_tail: Arc<Mutex<String>>,
}

impl RuntimeActor {
    fn new(
        app: AppHandle,
        command_tx: tokio_mpsc::UnboundedSender<RuntimeCommand>,
        session_cache: ClaudeSessionCache,
    ) -> Self {
        Self {
            app,
            command_tx,
            connection: None,
            _io_task_done: None,
            prompt_queue: PromptQueueState::default(),
            streaming: StreamingState::new(),
            tools: ToolState::default(),
            permissions: PermissionState::default(),
            session_cache,
            initialized: false,
            stderr_tail: Arc::new(Mutex::new(String::new())),
        }
    }

    fn reset_connection(&mut self) {
        self.connection = None;
        self._io_task_done = None;
        self.initialized = false;
        self.fail_pending_prompts("The AI runtime process disconnected unexpectedly.".to_string());
        self.streaming.clear_all();
        self.tools.clear_all();
        self.permissions.clear_all();
        if let Ok(mut guard) = self.stderr_tail.lock() {
            guard.clear();
        }
    }

    fn clear_session_state(&mut self, session_id: &str) {
        let pending = self.prompt_queue.clear_session(session_id);
        self.resolve_pending_prompts(pending, Ok(()));
        self.streaming.clear_session(session_id);
        self.tools.clear_session(session_id);
        self.permissions.clear_session(session_id);
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
            RuntimeCommand::CreateSession {
                spec,
                additional_roots,
                response_tx,
            } => {
                let result = self.create_session(spec, additional_roots).await;
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
            RuntimeCommand::ResumeSession {
                spec,
                session_id,
                response_tx,
            } => {
                let result = self.resume_session(spec, session_id).await;
                let _ = response_tx.send(result);
            }
            RuntimeCommand::ForkSession {
                spec,
                session_id,
                response_tx,
            } => {
                let result = self.fork_session(spec, session_id).await;
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
                self.enqueue_prompt(session_id, content, response_tx);
            }
            RuntimeCommand::PromptFinished { session_id, result } => {
                self.handle_prompt_finished(session_id, result);
            }
            RuntimeCommand::Cancel {
                session_id,
                response_tx,
            } => {
                let pending = self.prompt_queue.clear_queued_session(&session_id);
                self.resolve_pending_prompts(pending, Ok(()));
                let result = self.cancel(session_id).await;
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
            RuntimeCommand::CheckHealth { response_tx } => {
                let _ = response_tx.send(self.poll_connection_health());
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
        }
    }

    async fn ensure_connection(
        &mut self,
        spec: &ClaudeProcessSpec,
    ) -> Result<Rc<ClientSideConnection>, String> {
        self.poll_connection_health()?;
        if let Some(connection) = self.connection.as_ref() {
            return Ok(connection.clone());
        }

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = preferred_path_value() {
            command.env("PATH", path);
        }
        apply_auth_env(&mut command, &self.app, &spec.setup)?;

        if let Some(cwd) = spec.cwd.as_ref() {
            command.current_dir(cwd);
        }

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to acquire claude-acp stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to acquire claude-acp stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to acquire claude-acp stderr".to_string())?;

        spawn_stderr_reader(stderr, Arc::clone(&self.stderr_tail));

        let client = Rc::new(VaultAiAcpClient {
            app: self.app.clone(),
            streaming: self.streaming.clone(),
            tools: self.tools.clone(),
            permissions: self.permissions.clone(),
            session_cache: self.session_cache.clone(),
        });

        let (connection, io_task) =
            ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |fut| {
                tokio::task::spawn_local(fut);
            });

        let connection = Rc::new(connection);
        let (done_tx, done_rx) = oneshot::channel();
        let app = self.app.clone();
        let stderr_tail = Arc::clone(&self.stderr_tail);
        tokio::task::spawn_local(async move {
            let result = io_task.await.map_err(|error| error.to_string());
            let stderr_summary = stderr_tail
                .lock()
                .ok()
                .map(|guard| summarize_stderr(&guard))
                .filter(|value| !value.is_empty());
            let message = match &result {
                Ok(()) => {
                    if let Some(stderr_summary) = stderr_summary.as_ref() {
                        format!(
                            "The AI runtime process exited. Start a new turn to reconnect. Runtime stderr: {stderr_summary}"
                        )
                    } else {
                        "The AI runtime process exited. Start a new turn to reconnect.".to_string()
                    }
                }
                Err(error) => {
                    if let Some(stderr_summary) = stderr_summary.as_ref() {
                        format!(
                            "The AI runtime process disconnected unexpectedly: {error}. Runtime stderr: {stderr_summary}"
                        )
                    } else {
                        format!("The AI runtime process disconnected unexpectedly: {error}")
                    }
                }
            };
            emit_runtime_connection(
                &app,
                AiRuntimeConnectionPayload {
                    runtime_id: CLAUDE_RUNTIME_ID.to_string(),
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
                runtime_id: CLAUDE_RUNTIME_ID.to_string(),
                status: "ready".to_string(),
                message: None,
            },
        );

        Ok(connection)
    }

    async fn ensure_initialized(
        &mut self,
        spec: &ClaudeProcessSpec,
    ) -> Result<Rc<ClientSideConnection>, String> {
        let connection = self.ensure_connection(spec).await?;
        if self.initialized {
            return Ok(connection);
        }

        let request = InitializeRequest::new(ProtocolVersion::LATEST)
            .client_capabilities(
                ClientCapabilities::new()
                    .fs(FileSystemCapabilities::new()
                        .read_text_file(true)
                        .write_text_file(true))
                    .terminal(false)
                    .meta(Meta::from_iter([(
                        "terminal_output".to_string(),
                        serde_json::json!(true),
                    )])),
            )
            .client_info(
                Implementation::new("vaultai", env!("CARGO_PKG_VERSION")).title("VaultAI"),
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
        spec: ClaudeProcessSpec,
        additional_roots: Option<Vec<String>>,
    ) -> Result<ClaudeSessionState, String> {
        let cwd = spec
            .cwd
            .clone()
            .ok_or_else(|| "No hay vault abierto para iniciar una sesion Claude.".to_string())?;

        let connection = self.ensure_initialized(&spec).await?;
        let response = connection
            .new_session(build_new_session_request(cwd.clone(), additional_roots))
            .await
            .map_err(|error| error.to_string())?;

        let current_model_id = response
            .models
            .as_ref()
            .map(|state| strip_effort_suffix(&state.current_model_id.0).to_string())
            .unwrap_or_default();

        let mapped = response.models.map(map_session_models);
        let (models, efforts_by_model, _) = match mapped {
            Some(m) => (m.models, m.efforts_by_model, m.acp_model_ids),
            None => Default::default(),
        };
        self.tools
            .register_session_cwd(&response.session_id.0, cwd.clone());

        Ok(ClaudeSessionState {
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
        })
    }

    async fn load_session(
        &mut self,
        spec: ClaudeProcessSpec,
        session_id: String,
    ) -> Result<ClaudeSessionState, String> {
        let cwd = spec
            .cwd
            .clone()
            .ok_or_else(|| "No hay vault abierto para cargar una sesion Claude.".to_string())?;

        let connection = self.ensure_initialized(&spec).await?;
        let response = connection
            .load_session(LoadSessionRequest::new(
                SessionId::new(session_id.clone()),
                cwd.clone(),
            ))
            .await
            .map_err(|error| error.to_string())?;
        self.tools.register_session_cwd(&session_id, cwd);

        map_loaded_session_state(
            session_id,
            response.models,
            response.modes,
            response.config_options,
        )
    }

    async fn list_sessions(
        &mut self,
        spec: ClaudeProcessSpec,
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
                runtime_id: CLAUDE_RUNTIME_ID.to_string(),
                cwd: Some(session.cwd.display().to_string()),
                title: session.title,
                updated_at: session.updated_at,
            })
            .collect())
    }

    async fn resume_session(
        &mut self,
        spec: ClaudeProcessSpec,
        session_id: String,
    ) -> Result<ClaudeSessionState, String> {
        let cwd = spec
            .cwd
            .clone()
            .ok_or_else(|| "No hay vault abierto para reanudar una sesion Claude.".to_string())?;

        let connection = self.ensure_initialized(&spec).await?;
        let response = connection
            .resume_session(ResumeSessionRequest::new(
                SessionId::new(session_id.clone()),
                cwd.clone(),
            ))
            .await
            .map_err(|error| error.to_string())?;
        self.tools.register_session_cwd(&session_id, cwd);

        map_loaded_session_state(
            session_id,
            response.models,
            response.modes,
            response.config_options,
        )
    }

    async fn fork_session(
        &mut self,
        spec: ClaudeProcessSpec,
        session_id: String,
    ) -> Result<ClaudeSessionState, String> {
        let cwd = spec
            .cwd
            .clone()
            .ok_or_else(|| "No hay vault abierto para bifurcar una sesion Claude.".to_string())?;

        let connection = self.ensure_initialized(&spec).await?;
        let response = connection
            .fork_session(ForkSessionRequest::new(
                SessionId::new(session_id),
                cwd.clone(),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let forked_session_id = response.session_id.0.to_string();
        self.tools
            .register_session_cwd(&forked_session_id, cwd.clone());

        map_loaded_session_state(
            forked_session_id,
            response.models,
            response.modes,
            response.config_options,
        )
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
    ) -> Result<(), String> {
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
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn enqueue_prompt(
        &mut self,
        session_id: String,
        content: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    ) {
        let pending = PendingPrompt {
            content,
            response_tx,
        };

        if self.prompt_queue.active_sessions.insert(session_id.clone()) {
            self.start_prompt(session_id, pending);
            return;
        }

        self.prompt_queue
            .pending_by_session
            .entry(session_id)
            .or_default()
            .push_back(pending);
    }

    fn start_prompt(&mut self, session_id: String, pending: PendingPrompt) {
        if let Err(error) = self.poll_connection_health() {
            let _ = pending.response_tx.send(Err(error.clone()));
            self.fail_queued_prompts_for_session(&session_id, error);
            self.prompt_queue.active_sessions.remove(&session_id);
            return;
        }
        let connection = match self.connection.as_ref() {
            Some(c) => c.clone(),
            None => {
                let error = "ACP runtime is not initialized.".to_string();
                let _ = pending.response_tx.send(Err(error.clone()));
                self.fail_queued_prompts_for_session(&session_id, error);
                self.prompt_queue.active_sessions.remove(&session_id);
                return;
            }
        };
        let streaming = self.streaming.clone();
        let app = self.app.clone();
        let command_tx = self.command_tx.clone();
        let response_tx = pending.response_tx;
        let content = pending.content;

        tokio::task::spawn_local(async move {
            let message_id = streaming.begin_turn(&session_id);
            emit_message_started(&app, session_id.clone(), message_id.clone());

            // Guard ensures emit_message_completed fires even on panic/drop.
            let mut guard = TurnCompletionGuard {
                app: app.clone(),
                command_tx: command_tx.clone(),
                streaming: streaming.clone(),
                session_id: session_id.clone(),
                fallback_message_id: message_id,
                completed: false,
                queue_drained: false,
            };

            let result = connection
                .prompt(PromptRequest::new(
                    SessionId::new(session_id.clone()),
                    vec![ContentBlock::from(content)],
                ))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());

            if let Some(thinking_id) = streaming.end_thought(&session_id) {
                emit_thinking_completed(&app, session_id.clone(), thinking_id);
            }
            let completed_id = streaming.end_turn(&session_id).unwrap_or_default();
            if !completed_id.is_empty() {
                emit_message_completed(&app, session_id.clone(), completed_id);
            }
            guard.completed = true;
            guard.queue_drained = true;

            let drain_result = result.clone();
            let _ = response_tx.send(result);
            let _ = command_tx.send(RuntimeCommand::PromptFinished {
                session_id,
                result: drain_result,
            });
        });
    }

    fn handle_prompt_finished(&mut self, session_id: String, result: Result<(), String>) {
        self.prompt_queue.active_sessions.remove(&session_id);

        match result {
            Ok(()) => {
                if let Some(next) = self.prompt_queue.pop_next(&session_id) {
                    self.prompt_queue.active_sessions.insert(session_id.clone());
                    self.start_prompt(session_id, next);
                }
            }
            Err(error) => {
                self.fail_queued_prompts_for_session(&session_id, error);
            }
        }
    }

    fn resolve_pending_prompts(&self, pending: Vec<PendingPrompt>, result: Result<(), String>) {
        for pending_prompt in pending {
            let _ = pending_prompt.response_tx.send(result.clone());
        }
    }

    fn fail_queued_prompts_for_session(&mut self, session_id: &str, error: String) {
        let pending = self.prompt_queue.clear_queued_session(session_id);
        self.resolve_pending_prompts(pending, Err(error));
    }

    fn fail_pending_prompts(&mut self, error: String) {
        let pending = self.prompt_queue.clear_all();
        self.resolve_pending_prompts(pending, Err(error));
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
}

fn spawn_stderr_reader(stderr: tokio::process::ChildStderr, stderr_tail: Arc<Mutex<String>>) {
    tokio::task::spawn_local(async move {
        let mut reader = stderr;
        let mut buffer = [0_u8; 2048];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = String::from_utf8_lossy(&buffer[..read]);
                    if let Ok(mut guard) = stderr_tail.lock() {
                        guard.push_str(&chunk);
                        trim_stderr_tail(&mut guard);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn trim_stderr_tail(buffer: &mut String) {
    const MAX_STDERR_TAIL_CHARS: usize = 8_000;
    if buffer.len() <= MAX_STDERR_TAIL_CHARS {
        return;
    }

    let start = buffer.len() - MAX_STDERR_TAIL_CHARS;
    let boundary = buffer
        .char_indices()
        .find_map(|(index, _)| (index >= start).then_some(index))
        .unwrap_or(0);
    buffer.drain(..boundary);
}

fn summarize_stderr(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
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
) -> Result<ClaudeSessionState, String> {
    let current_model_id = models_state
        .as_ref()
        .map(|state| strip_effort_suffix(&state.current_model_id.0).to_string())
        .unwrap_or_default();

    let mapped = models_state.map(map_session_models);
    let (models, efforts_by_model, _) = match mapped {
        Some(mapped) => (mapped.models, mapped.efforts_by_model, mapped.acp_model_ids),
        None => Default::default(),
    };

    Ok(ClaudeSessionState {
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
    })
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
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
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
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
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
                runtime_id: CLAUDE_RUNTIME_ID.to_string(),
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

fn build_new_session_request(
    cwd: PathBuf,
    additional_roots: Option<Vec<String>>,
) -> NewSessionRequest {
    let additional_roots = additional_roots
        .unwrap_or_default()
        .into_iter()
        .filter(|root| !root.is_empty())
        .collect::<Vec<_>>();

    let request = NewSessionRequest::new(cwd);
    if additional_roots.is_empty() {
        request
    } else {
        request.meta(Meta::from_iter([(
            "additionalRoots".to_string(),
            serde_json::json!(additional_roots),
        )]))
    }
}

fn apply_mode_update_to_session(session: &mut AiSession, mode_id: &str) {
    session.mode_id = mode_id.to_string();
    if let Some(option) = session
        .config_options
        .iter_mut()
        .find(|option| option.id == "mode")
    {
        option.value = mode_id.to_string();
    }
}

fn apply_config_options_to_session(session: &mut AiSession, config_options: Vec<AiConfigOption>) {
    let mode_id = config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Mode))
        .map(|option| option.value.clone());
    let model_id = config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Model))
        .map(|option| option.value.clone());

    session.config_options = config_options;

    if let Some(mode_id) = mode_id {
        session.mode_id = mode_id;
    }
    if let Some(model_id) = model_id {
        session.model_id = model_id;
    }
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
    let event_type = meta.get(VAULTAI_STATUS_EVENT_TYPE_KEY)?.as_str()?;
    if event_type != "status" {
        return None;
    }

    let kind = meta
        .get(VAULTAI_STATUS_KIND_KEY)
        .and_then(|value| value.as_str())
        .unwrap_or("status")
        .to_string();
    let emphasis = meta
        .get(VAULTAI_STATUS_EMPHASIS_KEY)
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
        .and_then(|meta| meta.get(VAULTAI_PLAN_TITLE_KEY))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let detail = plan
        .meta
        .as_ref()
        .and_then(|meta| meta.get(VAULTAI_PLAN_DETAIL_KEY))
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

fn map_available_commands_update(
    session_id: &str,
    update: agent_client_protocol::AvailableCommandsUpdate,
) -> AiAvailableCommandsPayload {
    AiAvailableCommandsPayload {
        session_id: session_id.to_string(),
        commands: update
            .available_commands
            .into_iter()
            .map(|command| {
                let label = if command.name.starts_with('/') {
                    command.name.clone()
                } else {
                    format!("/{}", command.name)
                };
                let insert_text = if let Some(input) = command.input.as_ref() {
                    match input {
                        agent_client_protocol::AvailableCommandInput::Unstructured(input) => {
                            format!("{label} {}", input.hint)
                        }
                        _ => format!("{label} "),
                    }
                } else {
                    format!("{label} ")
                };

                AiAvailableCommandPayload {
                    id: command.name.clone(),
                    label,
                    description: command.description,
                    insert_text,
                }
            })
            .collect(),
    }
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

fn terminal_output_from_meta(meta: &agent_client_protocol::Meta) -> Option<String> {
    meta.get("terminal_output")
        .and_then(|value| value.as_object())
        .and_then(|object| object.get("data"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn terminal_exit_from_meta(meta: &agent_client_protocol::Meta) -> Option<TerminalExitMeta> {
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
                // File already written — can't compute meaningful diff, but
                // we know it's an update (file existed). Cache this marker to
                // prevent the ACP fallback from misclassifying as "add".
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

    // Read the current file from disk (post-edit, already written by Claude)
    let current_text = match read_existing_text_snapshot(&resolved_path) {
        ExistingTextSnapshot::Text(text) => text,
        _ => return None,
    };

    // Reconstruct old_text by reversing the edit only when the inserted text
    // is unique and non-empty. Empty new_string (deletions) cannot be
    // reversed reliably from disk alone.
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
        .and_then(|meta| meta.get(VAULTAI_DIFF_PREVIOUS_PATH_KEY))
        .and_then(|value| value.as_str())
        .map(|path| to_display_path(&resolve_tool_path(path, cwd), cwd))
}

fn diff_hunks(diff: &agent_client_protocol::Diff) -> Option<Vec<AiFileDiffHunkPayload>> {
    diff.meta
        .as_ref()
        .and_then(|meta| meta.get(VAULTAI_DIFF_HUNKS_KEY))
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
        // Edit tool always operates on existing files — never "add"
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    use agent_client_protocol::{Content, Diff, Meta, ToolCallId, ToolCallUpdateFields, ToolKind};

    use super::*;

    fn test_select_option(value: &str) -> AiConfigSelectOption {
        AiConfigSelectOption {
            value: value.to_string(),
            label: value.to_string(),
            description: None,
        }
    }

    fn test_config_option(
        id: &str,
        category: AiConfigOptionCategory,
        value: &str,
        options: Vec<AiConfigSelectOption>,
    ) -> AiConfigOption {
        AiConfigOption {
            id: id.to_string(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            category,
            label: id.to_string(),
            description: None,
            kind: "select".to_string(),
            value: value.to_string(),
            options,
        }
    }

    fn test_session() -> AiSession {
        AiSession {
            session_id: "session-1".to_string(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            model_id: "claude-3-5-sonnet".to_string(),
            mode_id: "default".to_string(),
            status: vault_ai_ai::AiSessionStatus::Idle,
            efforts_by_model: HashMap::new(),
            models: Vec::new(),
            modes: Vec::new(),
            config_options: vec![
                test_config_option(
                    "model",
                    AiConfigOptionCategory::Model,
                    "claude-3-5-sonnet",
                    vec![
                        test_select_option("claude-3-5-sonnet"),
                        test_select_option("claude-3-7-sonnet"),
                    ],
                ),
                test_config_option(
                    "mode",
                    AiConfigOptionCategory::Mode,
                    "default",
                    vec![test_select_option("default"), test_select_option("plan")],
                ),
            ],
        }
    }

    fn test_pending_prompt(content: &str) -> (PendingPrompt, mpsc::Receiver<Result<(), String>>) {
        let (response_tx, response_rx) = mpsc::channel();
        (
            PendingPrompt {
                content: content.to_string(),
                response_tx,
            },
            response_rx,
        )
    }

    #[test]
    fn apply_mode_update_updates_session_and_mode_config_option() {
        let mut session = test_session();

        apply_mode_update_to_session(&mut session, "plan");

        assert_eq!(session.mode_id, "plan");
        assert_eq!(
            session
                .config_options
                .iter()
                .find(|option| option.id == "mode")
                .map(|option| option.value.as_str()),
            Some("plan")
        );
    }

    #[test]
    fn apply_config_options_updates_config_options_and_derived_ids() {
        let mut session = test_session();
        let updated_options = vec![
            test_config_option(
                "model",
                AiConfigOptionCategory::Model,
                "claude-3-7-sonnet",
                vec![
                    test_select_option("claude-3-5-sonnet"),
                    test_select_option("claude-3-7-sonnet"),
                ],
            ),
            test_config_option(
                "mode",
                AiConfigOptionCategory::Mode,
                "plan",
                vec![test_select_option("default"), test_select_option("plan")],
            ),
            test_config_option(
                "reasoning",
                AiConfigOptionCategory::Reasoning,
                "high",
                vec![test_select_option("medium"), test_select_option("high")],
            ),
        ];

        apply_config_options_to_session(&mut session, updated_options.clone());

        assert_eq!(session.model_id, "claude-3-7-sonnet");
        assert_eq!(session.mode_id, "plan");
        assert_eq!(session.config_options, updated_options);
    }

    #[test]
    fn prompt_queue_pop_next_preserves_order_and_cleans_empty_queue() {
        let mut queue = PromptQueueState::default();
        queue.active_sessions.insert("session-1".to_string());
        let (first, _) = test_pending_prompt("first");
        let (second, _) = test_pending_prompt("second");
        queue
            .pending_by_session
            .entry("session-1".to_string())
            .or_default()
            .push_back(first);
        queue
            .pending_by_session
            .entry("session-1".to_string())
            .or_default()
            .push_back(second);

        let first = queue.pop_next("session-1").unwrap();
        let second = queue.pop_next("session-1").unwrap();

        assert_eq!(first.content, "first");
        assert_eq!(second.content, "second");
        assert!(!queue.pending_by_session.contains_key("session-1"));
        assert!(queue.active_sessions.contains("session-1"));
    }

    #[test]
    fn prompt_queue_clear_queued_session_keeps_active_turn() {
        let mut queue = PromptQueueState::default();
        queue.active_sessions.insert("session-1".to_string());
        let (queued, _) = test_pending_prompt("queued");
        queue
            .pending_by_session
            .entry("session-1".to_string())
            .or_default()
            .push_back(queued);

        let pending = queue.clear_queued_session("session-1");

        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].content, "queued");
        assert!(queue.active_sessions.contains("session-1"));
        assert!(!queue.pending_by_session.contains_key("session-1"));
    }

    #[test]
    fn prompt_queue_clear_session_removes_active_turn_and_queued_prompts() {
        let mut queue = PromptQueueState::default();
        queue.active_sessions.insert("session-1".to_string());
        let (queued, _) = test_pending_prompt("queued");
        queue
            .pending_by_session
            .entry("session-1".to_string())
            .or_default()
            .push_back(queued);

        let pending = queue.clear_session("session-1");

        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].content, "queued");
        assert!(!queue.active_sessions.contains("session-1"));
        assert!(!queue.pending_by_session.contains_key("session-1"));
    }

    #[test]
    fn build_new_session_request_includes_additional_roots_meta() {
        let request = build_new_session_request(
            PathBuf::from("/vault"),
            Some(vec!["/shared".to_string(), "relative/root".to_string()]),
        );

        let additional_roots = request
            .meta
            .as_ref()
            .and_then(|meta| meta.get("additionalRoots"))
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap();

        assert_eq!(
            additional_roots,
            vec![
                serde_json::json!("/shared"),
                serde_json::json!("relative/root"),
            ]
        );
    }

    fn map_with_tool_state(
        tool_state: &ToolState,
        session_id: &str,
        tool_call: &ToolCall,
    ) -> AiToolActivityPayload {
        map_tool_call(
            session_id,
            tool_call,
            None,
            tool_state.normalized_diffs_for_tool_call(session_id, tool_call),
        )
    }

    fn unique_temp_dir() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("vaultai-claude-client-{suffix}"))
    }

    #[test]
    fn map_tool_call_extracts_structured_diffs() {
        let tool_state = ToolState::default();
        let tool_call = ToolCall::new(ToolCallId::from("tool-1"), "Edit watcher")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![
                ToolCallContent::Diff(Diff::new("/tmp/new.rs", "new line").old_text("old line")),
                ToolCallContent::Diff(Diff::new("/tmp/added.rs", "added line")),
                ToolCallContent::Diff(Diff::new("/tmp/deleted.rs", "").old_text("gone")),
            ]);

        let payload = map_with_tool_state(&tool_state, "session-1", &tool_call);

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
        let tool_state = ToolState::default();
        let tool_call = ToolCall::new(ToolCallId::from("tool-2"), "Read file")
            .kind(ToolKind::Read)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Content(Content::new("README.md"))]);

        let payload = map_with_tool_state(&tool_state, "session-1", &tool_call);

        assert_eq!(payload.summary.as_deref(), Some("README.md"));
        assert!(payload.diffs.is_none());
    }

    #[test]
    fn map_tool_call_marks_placeholder_delete_as_non_reversible() {
        let tool_state = ToolState::default();
        let tool_call = ToolCall::new(ToolCallId::from("tool-3"), "Delete file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/deleted.rs", "").old_text(FILE_DELETED_PLACEHOLDER),
            )]);

        let payload = map_with_tool_state(&tool_state, "session-1", &tool_call);
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
        let tool_state = ToolState::default();
        let tool_call = ToolCall::new(ToolCallId::from("tool-4"), "Move file")
            .kind(ToolKind::Move)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/new.rs", "updated")
                    .old_text("original")
                    .meta(Meta::from_iter([(
                        VAULTAI_DIFF_PREVIOUS_PATH_KEY.to_string(),
                        serde_json::json!("/tmp/old.rs"),
                    )])),
            )]);

        let payload = map_with_tool_state(&tool_state, "session-1", &tool_call);
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
        let tool_state = ToolState::default();
        let tool_call = ToolCall::new(ToolCallId::from("tool-6"), "Edit watcher")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/watcher.rs", "new line")
                    .old_text("old line")
                    .meta(Meta::from_iter([(
                        VAULTAI_DIFF_HUNKS_KEY.to_string(),
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

        let payload = map_with_tool_state(&tool_state, "session-1", &tool_call);
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
        let tool_state = ToolState::default();
        let tool_call = ToolCall::new(ToolCallId::from("tool-5"), "Delete file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/deleted.rs", "").old_text("real previous content"),
            )]);

        let payload = map_with_tool_state(&tool_state, "session-1", &tool_call);
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
    fn map_tool_call_reconstructs_write_diff_after_content_is_replaced() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("watcher.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "old line").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        let initial = ToolCall::new(ToolCallId::from("tool-write"), "Write src/watcher.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Pending)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new line",
            }))
            .content(vec![ToolCallContent::Diff(Diff::new(
                file_path.display().to_string(),
                "new line",
            ))]);
        let _ = tool_state.upsert_tool_call("session-1", initial);

        let updated = tool_state
            .apply_tool_update(
                "session-1",
                agent_client_protocol::ToolCallUpdate::new(
                    "tool-write",
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Completed)
                        .content(vec![ToolCallContent::Content(Content::new("File updated"))]),
                ),
            )
            .unwrap();

        let payload = map_with_tool_state(&tool_state, "session-1", &updated);
        let diff = payload
            .diffs
            .as_ref()
            .and_then(|diffs| diffs.first())
            .unwrap();

        assert_eq!(diff.path, "src/watcher.rs");
        assert_eq!(diff.kind, "update");
        assert!(diff.reversible);
        assert!(diff.is_text);
        assert_eq!(diff.old_text.as_deref(), Some("old line"));
        assert_eq!(diff.new_text.as_deref(), Some("new line"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn map_tool_call_reconstructs_write_diff_for_new_file() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        fs::create_dir_all(temp_dir.join("notes")).unwrap();
        tool_state.register_session_cwd("session-2", temp_dir.clone());

        let tool_call = ToolCall::new(ToolCallId::from("tool-write-new"), "Write notes/new.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "notes/new.md",
                "content": "",
            }));

        let registered = tool_state.upsert_tool_call("session-2", tool_call);
        let payload = map_with_tool_state(&tool_state, "session-2", &registered);
        let diff = payload
            .diffs
            .as_ref()
            .and_then(|diffs| diffs.first())
            .unwrap();

        assert_eq!(diff.path, "notes/new.md");
        assert_eq!(diff.kind, "add");
        assert!(diff.reversible);
        assert_eq!(diff.old_text, None);
        assert_eq!(diff.new_text.as_deref(), Some(""));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn edit_tool_diffs_cached_from_content_survive_completion() {
        let tool_state = ToolState::default();
        let file_path = "/tmp/vaultai-test-edit-cache.rs";

        // Initial ToolCall arrives with Diff content + Edit raw_input (status=in_progress)
        let initial = ToolCall::new(ToolCallId::from("tool-edit"), "Edit file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({
                "file_path": file_path,
                "old_string": "old code",
                "new_string": "new code",
            }))
            .content(vec![ToolCallContent::Diff(
                Diff::new(file_path, "full file with new code").old_text("full file with old code"),
            )]);
        let _ = tool_state.upsert_tool_call("session-1", initial);

        // Completion arrives — content replaced with text summary (no Diffs)
        let updated = tool_state
            .apply_tool_update(
                "session-1",
                agent_client_protocol::ToolCallUpdate::new(
                    "tool-edit",
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Completed)
                        .content(vec![ToolCallContent::Content(Content::new(
                            "The file was updated successfully.",
                        ))]),
                ),
            )
            .unwrap();

        // Diffs should still be available from cache
        let payload = map_with_tool_state(&tool_state, "session-1", &updated);
        let diffs = payload.diffs.as_ref().expect("diffs should be present");
        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some("full file with old code")
        );
        assert_eq!(
            diffs[0].new_text.as_deref(),
            Some("full file with new code")
        );
    }

    #[test]
    fn reconstruct_edit_diff_from_raw_input() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("module.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();

        // File already contains the post-edit content (Claude wrote it)
        fs::write(&file_path, "fn main() {\n    new_code();\n}\n").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // ToolCall with Edit raw_input but NO Diff content items
        let initial = ToolCall::new(ToolCallId::from("tool-edit-raw"), "Edit module.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "old_string": "old_code()",
                "new_string": "new_code()",
            }));
        let registered = tool_state.upsert_tool_call("session-1", initial);

        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should be present");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].kind, "update");
        assert!(diffs[0].reversible);
        // old_text should have old_string restored
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some("fn main() {\n    old_code();\n}\n")
        );
        assert_eq!(
            diffs[0].new_text.as_deref(),
            Some("fn main() {\n    new_code();\n}\n")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn write_tool_diff_still_works_with_vec_cache() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("readme.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "old content").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        let initial = ToolCall::new(ToolCallId::from("tool-write-v"), "Write readme.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Pending)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new content",
            }));
        let _ = tool_state.upsert_tool_call("session-1", initial);

        let updated = tool_state
            .apply_tool_update(
                "session-1",
                agent_client_protocol::ToolCallUpdate::new(
                    "tool-write-v",
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Completed)
                        .content(vec![ToolCallContent::Content(Content::new("Done"))]),
                ),
            )
            .unwrap();

        let payload = map_with_tool_state(&tool_state, "session-1", &updated);
        let diffs = payload.diffs.as_ref().expect("diffs should be present");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].kind, "update");
        assert_eq!(diffs[0].old_text.as_deref(), Some("old content"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new content"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn map_diff_payload_treats_edit_to_empty_file_as_update() {
        let diff = map_diff_payload(
            &Diff::new("/tmp/file.txt", "").old_text("before"),
            Some(&serde_json::json!({
                "file_path": "/tmp/file.txt",
                "old_string": "before",
                "new_string": "",
            })),
            None,
        );

        assert_eq!(diff.kind, "update");
        assert_eq!(diff.old_text.as_deref(), Some("before"));
        assert_eq!(diff.new_text.as_deref(), Some(""));
    }

    #[test]
    fn write_diff_caches_update_marker_when_file_already_written() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("already_written.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();

        // File already contains the content Claude wants to write (post-write state)
        fs::write(&file_path, "new content").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // Simulate auto-approved tool: only SessionUpdate::ToolCall arrives (post-write)
        let tool_call = ToolCall::new(ToolCallId::from("tool-auto"), "Write already_written.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new content",
            }));
        let registered = tool_state.upsert_tool_call("session-1", tool_call);

        // Since old_text == new_text, capture_write_diff caches a marker with kind="update"
        let cached = tool_state.cached_diffs("session-1", "tool-auto");
        assert!(cached.is_some(), "update marker should be cached");
        let diffs = cached.unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].kind, "update",
            "post-write marker must be 'update' not 'add'"
        );
        assert!(diffs[0].old_text.is_none(), "old_text unknown post-write");
        assert_eq!(diffs[0].new_text.as_deref(), Some("new content"));
        assert!(!diffs[0].reversible, "not reversible without old_text");

        // normalized_diffs_for_tool_call should return the cached marker
        let normalized = tool_state.normalized_diffs_for_tool_call("session-1", &registered);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].kind, "update");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn acp_diffs_used_as_fallback_when_reconstruction_fails() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("fallback.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        // File already contains post-write content → reconstruction returns None (old == new)
        fs::write(&file_path, "new content via raw_input").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // ToolCall with raw_input (reconstruction will fail) AND Diff content (from ACP)
        let tool_call = ToolCall::new(ToolCallId::from("tool-fallback"), "Write fallback.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new content via raw_input",
            }))
            .content(vec![ToolCallContent::Diff(
                Diff::new(file_path.display().to_string(), "new via ACP").old_text("old via ACP"),
            )]);
        let registered = tool_state.upsert_tool_call("session-1", tool_call);

        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should exist");
        assert_eq!(diffs.len(), 1);
        // ACP diff with old_text overwrites the post-write reconstruction marker
        assert_eq!(diffs[0].old_text.as_deref(), Some("old via ACP"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new via ACP"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn edit_diff_returns_none_when_replacen_finds_nothing() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("no_match.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();

        // File content does NOT contain new_string (simulates race condition)
        fs::write(&file_path, "fn main() { totally_different(); }").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        let tool_call = ToolCall::new(ToolCallId::from("tool-edit-nomatch"), "Edit no_match.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "old_string": "old_code()",
                "new_string": "new_code()",
            }));
        let _ = tool_state.upsert_tool_call("session-1", tool_call);

        // Since new_string is not in the file, reconstruction should fail gracefully
        let cached = tool_state.cached_diffs("session-1", "tool-edit-nomatch");
        assert!(
            cached.is_none(),
            "unreliable reconstruction should not be cached"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn apply_tool_update_caches_content_diffs() {
        let tool_state = ToolState::default();

        // First, register a tool call with no diffs
        let initial = ToolCall::new(ToolCallId::from("tool-update-diffs"), "Edit file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::InProgress);
        let _ = tool_state.upsert_tool_call("session-1", initial);

        // Update arrives with Diff content
        let updated = tool_state
            .apply_tool_update(
                "session-1",
                agent_client_protocol::ToolCallUpdate::new(
                    "tool-update-diffs",
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Completed)
                        .content(vec![ToolCallContent::Diff(
                            Diff::new("/tmp/updated.rs", "new code").old_text("old code"),
                        )]),
                ),
            )
            .unwrap();

        let diffs = tool_state.normalized_diffs_for_tool_call("session-1", &updated);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].old_text.as_deref(), Some("old code"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new code"));
    }

    #[test]
    fn second_upsert_does_not_overwrite_first_cached_diff() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("overwrite_test.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "original content").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // First upsert (pre-write): disk has "original content", raw_input has "new content"
        let first = ToolCall::new(ToolCallId::from("tool-ow"), "Write overwrite_test.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Pending)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new content",
            }));
        let _ = tool_state.upsert_tool_call("session-1", first);

        // Simulate Claude writing the file
        fs::write(&file_path, "new content").unwrap();

        // Second upsert (post-write): disk now has "new content"
        let second = ToolCall::new(ToolCallId::from("tool-ow"), "Write overwrite_test.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new content",
            }));
        let registered = tool_state.upsert_tool_call("session-1", second);

        // The first (pre-write) diff should be preserved, not overwritten
        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should exist");
        assert_eq!(diffs[0].old_text.as_deref(), Some("original content"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new content"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    // -- File baseline cache tests -------------------------------------------

    #[test]
    fn read_tool_caches_baseline_for_subsequent_write() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("hello.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "original content").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // Simulate Claude reading the file (completed Read tool)
        let read_call = ToolCall::new(ToolCallId::from("tool-read"), "Read hello.md")
            .kind(ToolKind::Read)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
            }))
            .content(vec![ToolCallContent::Content(Content::new(
                "original content",
            ))]);
        let _ = tool_state.upsert_tool_call("session-1", read_call);

        // Now Claude writes the file (auto-approved, file already written)
        fs::write(&file_path, "new content").unwrap();

        let write_call = ToolCall::new(ToolCallId::from("tool-write"), "Write hello.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new content",
            }));
        let registered = tool_state.upsert_tool_call("session-1", write_call);

        // Baseline should produce a proper diff with old_text
        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should exist");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].kind, "update");
        assert_eq!(diffs[0].old_text.as_deref(), Some("original content"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new content"));
        assert!(diffs[0].reversible);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn consecutive_edits_use_updated_baseline() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("app.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "version 1").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // Claude reads file
        let read_call = ToolCall::new(ToolCallId::from("tool-read-1"), "Read app.rs")
            .kind(ToolKind::Read)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
            }))
            .content(vec![ToolCallContent::Content(Content::new("version 1"))]);
        let _ = tool_state.upsert_tool_call("session-1", read_call);

        // First write (auto-approved)
        fs::write(&file_path, "version 2").unwrap();
        let write1 = ToolCall::new(ToolCallId::from("tool-write-1"), "Write app.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "version 2",
            }));
        let reg1 = tool_state.upsert_tool_call("session-1", write1);

        let payload1 = map_with_tool_state(&tool_state, "session-1", &reg1);
        let diffs1 = payload1.diffs.as_ref().unwrap();
        assert_eq!(diffs1[0].old_text.as_deref(), Some("version 1"));
        assert_eq!(diffs1[0].new_text.as_deref(), Some("version 2"));

        // Second write (auto-approved, baseline should be "version 2" now)
        fs::write(&file_path, "version 3").unwrap();
        let write2 = ToolCall::new(ToolCallId::from("tool-write-2"), "Write app.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "version 3",
            }));
        let reg2 = tool_state.upsert_tool_call("session-1", write2);

        let payload2 = map_with_tool_state(&tool_state, "session-1", &reg2);
        let diffs2 = payload2.diffs.as_ref().unwrap();
        assert_eq!(diffs2[0].old_text.as_deref(), Some("version 2"));
        assert_eq!(diffs2[0].new_text.as_deref(), Some("version 3"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn write_without_prior_read_falls_back_to_disk() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("no_read.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "disk content").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // No prior Read — baseline not available, falls back to disk
        let write_call = ToolCall::new(ToolCallId::from("tool-write-nr"), "Write no_read.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Pending)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "new content",
            }));
        let registered = tool_state.upsert_tool_call("session-1", write_call);

        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should exist");
        assert_eq!(diffs[0].old_text.as_deref(), Some("disk content"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new content"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn store_file_baseline_from_external_source() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("external.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // Simulate frontend sending baseline via Tauri command
        tool_state.store_file_baseline("session-1", "notes/external.md", "editor content".into());

        // Claude writes the file (already written to disk)
        fs::write(&file_path, "claude content").unwrap();
        let write_call = ToolCall::new(ToolCallId::from("tool-write-ext"), "Write external.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "claude content",
            }));
        let registered = tool_state.upsert_tool_call("session-1", write_call);

        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should exist");
        assert_eq!(diffs[0].old_text.as_deref(), Some("editor content"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("claude content"));
        assert!(diffs[0].reversible);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn store_file_baseline_overwrites_with_newer_editor_content() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("refresh.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        tool_state.store_file_baseline("session-1", "notes/refresh.md", "editor v1".into());
        tool_state.store_file_baseline("session-1", "notes/refresh.md", "editor v2".into());

        fs::write(&file_path, "claude content").unwrap();
        let write_call = ToolCall::new(ToolCallId::from("tool-write-refresh"), "Write refresh.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": "claude content",
            }));
        let registered = tool_state.upsert_tool_call("session-1", write_call);

        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should exist");
        assert_eq!(diffs[0].old_text.as_deref(), Some("editor v2"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("claude content"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pending_write_does_not_advance_baseline() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("pending_write.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        tool_state.store_file_baseline("session-1", "notes/pending_write.md", "version 1".into());

        let write_call = ToolCall::new(
            ToolCallId::from("tool-pending-write"),
            "Write pending_write.md",
        )
        .kind(ToolKind::Edit)
        .status(ToolCallStatus::Pending)
        .raw_input(serde_json::json!({
            "file_path": file_path.display().to_string(),
            "content": "version 2",
        }));
        let _ = tool_state.upsert_tool_call("session-1", write_call);

        let baseline = tool_state.get_file_baseline("session-1", "notes/pending_write.md");
        assert_eq!(baseline.as_deref(), Some("version 1"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn failed_write_does_not_advance_baseline() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("failed_write.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        tool_state.store_file_baseline("session-1", "notes/failed_write.md", "version 1".into());

        let initial = ToolCall::new(
            ToolCallId::from("tool-failed-write"),
            "Write failed_write.md",
        )
        .kind(ToolKind::Edit)
        .status(ToolCallStatus::Pending)
        .raw_input(serde_json::json!({
            "file_path": file_path.display().to_string(),
            "content": "version 2",
        }));
        let _ = tool_state.upsert_tool_call("session-1", initial);

        let _ = tool_state.apply_tool_update(
            "session-1",
            agent_client_protocol::ToolCallUpdate::new(
                "tool-failed-write",
                ToolCallUpdateFields::new()
                    .status(ToolCallStatus::Failed)
                    .content(vec![ToolCallContent::Content(Content::new("Write failed"))]),
            ),
        );

        let baseline = tool_state.get_file_baseline("session-1", "notes/failed_write.md");
        assert_eq!(baseline.as_deref(), Some("version 1"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pending_read_does_not_cache_baseline() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("pending.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "some content").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // Read tool still in progress (not completed yet)
        let read_call = ToolCall::new(ToolCallId::from("tool-read-p"), "Read pending.md")
            .kind(ToolKind::Read)
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
            }));
        let _ = tool_state.upsert_tool_call("session-1", read_call);

        let baseline = tool_state.get_file_baseline("session-1", "notes/pending.md");
        assert!(baseline.is_none(), "pending read should not cache baseline");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn ambiguous_edit_with_multiple_old_string_occurrences_is_not_reconstructed() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("ambiguous_baseline.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "still unrelated").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        tool_state.store_file_baseline(
            "session-1",
            "src/ambiguous_baseline.rs",
            "old_code();\nold_code();".into(),
        );

        let tool_call = ToolCall::new(
            ToolCallId::from("tool-edit-ambiguous-old"),
            "Edit ambiguous_baseline.rs",
        )
        .kind(ToolKind::Edit)
        .status(ToolCallStatus::Completed)
        .raw_input(serde_json::json!({
            "file_path": file_path.display().to_string(),
            "old_string": "old_code()",
            "new_string": "new_code()",
        }));
        let _ = tool_state.upsert_tool_call("session-1", tool_call);

        let cached = tool_state.cached_diffs("session-1", "tool-edit-ambiguous-old");
        assert!(
            cached.is_none(),
            "ambiguous baseline edit should not be reconstructed"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn ambiguous_edit_with_multiple_new_string_occurrences_is_not_reconstructed() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("ambiguous_current.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "new_code();\nnew_code();").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        let tool_call = ToolCall::new(
            ToolCallId::from("tool-edit-ambiguous-new"),
            "Edit ambiguous_current.rs",
        )
        .kind(ToolKind::Edit)
        .status(ToolCallStatus::Completed)
        .raw_input(serde_json::json!({
            "file_path": file_path.display().to_string(),
            "old_string": "old_code()",
            "new_string": "new_code()",
        }));
        let _ = tool_state.upsert_tool_call("session-1", tool_call);

        let cached = tool_state.cached_diffs("session-1", "tool-edit-ambiguous-new");
        assert!(
            cached.is_none(),
            "ambiguous reverse edit should not be reconstructed"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn edit_delete_without_baseline_does_not_invent_old_text() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("delete_without_baseline.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "prefix\nsuffix\n").unwrap();
        tool_state.register_session_cwd("session-1", temp_dir.clone());

        let tool_call = ToolCall::new(
            ToolCallId::from("tool-edit-delete"),
            "Edit delete_without_baseline.rs",
        )
        .kind(ToolKind::Edit)
        .status(ToolCallStatus::Completed)
        .raw_input(serde_json::json!({
            "file_path": file_path.display().to_string(),
            "old_string": "deleted_line\n",
            "new_string": "",
        }));
        let _ = tool_state.upsert_tool_call("session-1", tool_call);

        let cached = tool_state.cached_diffs("session-1", "tool-edit-delete");
        assert!(
            cached.is_none(),
            "delete fallback without baseline should not invent old_text"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn acp_diffs_do_not_overwrite_reliable_baseline_reconstruction() {
        let tool_state = ToolState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("baseline_priority.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();

        let original = "line 1\nline 2\noriginal line 60\nline 61";
        let edited = "line 1\nline 2\nedited line 60\nline 61";
        fs::write(&file_path, edited).unwrap(); // post-write state on disk

        tool_state.register_session_cwd("session-1", temp_dir.clone());

        // Register baseline (simulates prior Read or frontend registration)
        tool_state.store_file_baseline(
            "session-1",
            "notes/baseline_priority.md",
            original.to_string(),
        );

        // ToolCall with BOTH raw_input AND ACP Diff content (with wrong old_text)
        let tool_call = ToolCall::new(ToolCallId::from("tool-bl"), "Write baseline_priority.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": file_path.display().to_string(),
                "content": edited,
            }))
            .content(vec![ToolCallContent::Diff(
                Diff::new(file_path.display().to_string(), edited)
                    .old_text("wrong old text from ACP"),
            )]);
        let registered = tool_state.upsert_tool_call("session-1", tool_call);

        // The baseline reconstruction (with correct old_text) should NOT be overwritten
        let payload = map_with_tool_state(&tool_state, "session-1", &registered);
        let diffs = payload.diffs.as_ref().expect("diffs should exist");
        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some(original),
            "baseline old_text must be preserved, not overwritten by ACP"
        );
        assert!(
            diffs[0].reversible,
            "baseline reconstruction must be reversible"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }
}
