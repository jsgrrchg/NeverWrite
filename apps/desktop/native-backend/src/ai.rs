use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::{self, Sender},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_client_protocol::{
    Agent, Client, ClientCapabilities, ClientSideConnection, ContentBlock, ContentChunk,
    FileSystemCapabilities, Implementation, InitializeRequest, NewSessionRequest, PermissionOption,
    PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionId, SessionNotification,
    SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest, SetSessionModelRequest,
    ToolCall, ToolCallContent, ToolCallStatus,
};
use neverwrite_ai::{
    AiAuthMethod, AiConfigOption, AiConfigOptionCategory, AiConfigSelectOption, AiFileDiffPayload,
    AiMessageCompletedPayload, AiMessageDeltaPayload, AiMessageStartedPayload, AiModeOption,
    AiModelOption, AiPermissionOptionPayload, AiPermissionRequestPayload, AiRuntimeBinarySource,
    AiRuntimeConnectionPayload, AiRuntimeDescriptor, AiRuntimeOption, AiRuntimeSetupStatus,
    AiSession, AiSessionErrorPayload, AiSessionStatus, AiStatusEventPayload,
    AiTokenUsageCostPayload, AiTokenUsagePayload, AiToolActivityPayload, ToolDiffState,
    AI_MESSAGE_COMPLETED_EVENT, AI_MESSAGE_DELTA_EVENT, AI_MESSAGE_STARTED_EVENT,
    AI_PERMISSION_REQUEST_EVENT, AI_RUNTIME_CONNECTION_EVENT, AI_SESSION_CREATED_EVENT,
    AI_SESSION_ERROR_EVENT, AI_SESSION_UPDATED_EVENT, AI_STATUS_EVENT, AI_THINKING_COMPLETED_EVENT,
    AI_THINKING_DELTA_EVENT, AI_THINKING_STARTED_EVENT, AI_TOKEN_USAGE_EVENT,
    AI_TOOL_ACTIVITY_EVENT, CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, GEMINI_RUNTIME_ID,
    KILO_RUNTIME_ID,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{process::Command, runtime::Builder, sync::oneshot, task::LocalSet};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::RpcOutput;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);
const ELECTRON_AI_INTERACTIVE_AUTH_UNAVAILABLE: &str =
    "Interactive AI authentication is not available in Electron yet. Use an existing CLI login, an environment/API key, or a custom gateway.";
const ELECTRON_AI_USER_INPUT_UNAVAILABLE: &str =
    "Interactive AI user input prompts are not available in Electron yet.";
const AGENT_WRITE_ORIGIN_WINDOW: Duration = Duration::from_secs(15);
const MAX_TERMINAL_SUMMARY_CHARS: usize = 8_000;
const ACP_STATUS_EVENT_TYPE_KEY: &str = "neverwriteEventType";
const ACP_STATUS_KIND_KEY: &str = "neverwriteStatusKind";
const ACP_STATUS_EMPHASIS_KEY: &str = "neverwriteStatusEmphasis";

#[derive(Debug, Clone)]
struct TerminalExitMeta {
    exit_code: Option<i64>,
    signal: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct AgentWriteTracker {
    paths: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

impl AgentWriteTracker {
    fn mark_path(&self, path: PathBuf) {
        if let Ok(mut guard) = self.paths.lock() {
            Self::prune_expired(&mut guard);
            guard.insert(path, Instant::now());
        }
    }

    fn has_recent_match(&self, path: &Path) -> bool {
        self.paths
            .lock()
            .map(|mut guard| {
                Self::prune_expired(&mut guard);
                guard.contains_key(path)
            })
            .unwrap_or(false)
    }

    fn prune_expired(paths: &mut HashMap<PathBuf, Instant>) {
        paths.retain(|_, marked_at| marked_at.elapsed() <= AGENT_WRITE_ORIGIN_WINDOW);
    }
}

#[derive(Debug, Clone, Deserialize)]
struct AiSecretPatch {
    action: String,
    value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiRuntimeSetupPayload {
    custom_binary_path: Option<String>,
    #[serde(default)]
    codex_api_key: Option<AiSecretPatch>,
    #[serde(default)]
    openai_api_key: Option<AiSecretPatch>,
    #[serde(default)]
    gemini_api_key: Option<AiSecretPatch>,
    #[serde(default)]
    google_api_key: Option<AiSecretPatch>,
    google_cloud_project: Option<String>,
    google_cloud_location: Option<String>,
    gateway_base_url: Option<String>,
    #[serde(default)]
    gateway_headers: Option<AiSecretPatch>,
    anthropic_base_url: Option<String>,
    #[serde(default)]
    anthropic_custom_headers: Option<AiSecretPatch>,
    #[serde(default)]
    anthropic_auth_token: Option<AiSecretPatch>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiRuntimeSessionInput {
    runtime_id: String,
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AiCreateSessionInput {
    runtime_id: String,
    additional_roots: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiSetConfigOptionInput {
    session_id: String,
    option_id: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AiRespondPermissionInput {
    session_id: String,
    request_id: String,
    option_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiRespondUserInputInput {
    session_id: String,
    request_id: String,
    answers: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiAttachmentInput {
    label: String,
    path: Option<String>,
    content: Option<String>,
    #[serde(rename = "type")]
    attachment_type: Option<String>,
    #[serde(rename = "noteId")]
    note_id: Option<String>,
    #[serde(rename = "filePath")]
    file_path: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    transcription: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct RuntimeSetupState {
    custom_binary_path: Option<String>,
    auth_ready: bool,
    auth_method: Option<String>,
    has_gateway_config: bool,
    has_gateway_url: bool,
    message: Option<String>,
    env: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct ManagedAiSession {
    session: AiSession,
    vault_root: Option<PathBuf>,
    additional_roots: Vec<PathBuf>,
    runtime_handle: Option<AcpSessionHandle>,
}

#[derive(Default)]
struct NativeAiInner {
    sessions: HashMap<String, ManagedAiSession>,
    session_order: Vec<String>,
    setup: HashMap<String, RuntimeSetupState>,
}

#[derive(Debug, Clone)]
struct AcpProcessSpec {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    env: HashMap<String, String>,
    runtime_id: String,
}

#[derive(Debug, Clone)]
struct AcpSessionHandle {
    command_tx: tokio::sync::mpsc::UnboundedSender<AcpCommand>,
}

#[derive(Debug)]
enum AcpCommand {
    Prompt {
        session_id: String,
        content: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    SetModel {
        session_id: String,
        model_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    SetMode {
        session_id: String,
        mode_id: String,
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    SetConfigOption {
        session_id: String,
        option_id: String,
        value: String,
        response_tx: mpsc::Sender<Result<(), String>>,
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
}

#[derive(Clone)]
pub(crate) struct NativeAi {
    inner: Arc<Mutex<NativeAiInner>>,
    event_tx: Sender<RpcOutput>,
    tool_diffs: ToolDiffState,
    agent_writes: AgentWriteTracker,
}

impl NativeAi {
    pub(crate) fn new(event_tx: Sender<RpcOutput>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NativeAiInner::default())),
            event_tx,
            tool_diffs: ToolDiffState::default(),
            agent_writes: AgentWriteTracker::default(),
        }
    }

    pub(crate) fn list_runtimes(&self) -> Value {
        json!(runtime_descriptors())
    }

    pub(crate) fn get_setup_status(&self, args: &Value) -> Result<Value, String> {
        let runtime_id = required_runtime_id(args)?;
        let state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        Ok(json!(setup_status_for(
            &runtime_id,
            state.setup.get(&runtime_id).cloned().unwrap_or_default(),
        )?))
    }

    pub(crate) fn get_environment_diagnostics(&self) -> Value {
        let inherited_path: Option<String> =
            std::env::var_os("PATH").map(|value| value.to_string_lossy().into_owned());
        let inherited_entries = inherited_path
            .as_deref()
            .map(|raw| {
                std::env::split_paths(raw)
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let executables = diagnostic_executable_names()
            .into_iter()
            .map(|name| {
                json!({
                    "name": name,
                    "path": find_program_on_path(name).map(|path| path.display().to_string()),
                })
            })
            .collect::<Vec<_>>();
        let runtimes = runtime_descriptors()
            .into_iter()
            .map(|descriptor| {
                let runtime_id = descriptor.runtime.id.clone();
                let runtime_name = descriptor.runtime.name.clone();
                let setup_status = self
                    .inner
                    .lock()
                    .ok()
                    .and_then(|state| state.setup.get(&runtime_id).cloned())
                    .unwrap_or_default();
                let status = setup_status_for(&runtime_id, setup_status);
                let (setup_status, setup_error) = match status {
                    Ok(status) => (Some(status), None),
                    Err(error) => (None, Some(error)),
                };
                json!({
                    "runtime_id": runtime_id,
                    "runtime_name": runtime_name,
                    "setup_status": setup_status,
                    "setup_error": setup_error,
                    "launch_program": default_executable_name(&runtime_id),
                    "launch_args": [],
                    "resolution_display": find_program_on_path(default_executable_name(&runtime_id))
                        .map(|path| path.display().to_string()),
                })
            })
            .collect::<Vec<_>>();

        json!({
            "inherited_path": inherited_path,
            "inherited_entries": inherited_entries,
            "preferred_path": inherited_path,
            "preferred_entries": inherited_entries,
            "executables": executables,
            "runtimes": runtimes,
        })
    }

    pub(crate) fn update_setup(&self, args: &Value) -> Result<Value, String> {
        let runtime_id = required_runtime_id(args)?;
        validate_runtime_id(&runtime_id)?;
        let input: AiRuntimeSetupPayload = serde_json::from_value(
            args.get("input")
                .cloned()
                .ok_or_else(|| "Missing argument: input".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let setup = state.setup.entry(runtime_id.clone()).or_default();

        setup.custom_binary_path = input
            .custom_binary_path
            .clone()
            .and_then(normalize_optional_string);
        update_auth_state(setup, &runtime_id, input);
        Ok(json!(setup_status_for(&runtime_id, setup.clone())?))
    }

    pub(crate) fn start_auth(&self, args: &Value) -> Result<Value, String> {
        let input = args
            .get("input")
            .cloned()
            .ok_or_else(|| "Missing argument: input".to_string())?;
        let runtime_id = input
            .get("runtimeId")
            .and_then(Value::as_str)
            .or_else(|| input.get("runtime_id").and_then(Value::as_str))
            .ok_or_else(|| "Missing argument: runtimeId".to_string())?
            .to_string();
        let method_id = input
            .get("method_id")
            .and_then(Value::as_str)
            .or_else(|| input.get("methodId").and_then(Value::as_str))
            .ok_or_else(|| "Missing argument: methodId".to_string())?
            .to_string();

        validate_runtime_id(&runtime_id)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let setup = state.setup.entry(runtime_id.clone()).or_default();
        setup.auth_method = Some(method_id.clone());
        setup.auth_ready = false;
        setup.message = Some(ELECTRON_AI_INTERACTIVE_AUTH_UNAVAILABLE.to_string());
        Ok(json!(setup_status_for(&runtime_id, setup.clone())?))
    }

    pub(crate) fn list_sessions(&self, vault_root: Option<PathBuf>) -> Result<Value, String> {
        let state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let sessions = state
            .session_order
            .iter()
            .filter_map(|session_id| state.sessions.get(session_id))
            .filter(|managed| managed.vault_root == vault_root)
            .map(|managed| managed.session.clone())
            .collect::<Vec<_>>();
        Ok(json!(sessions))
    }

    pub(crate) fn load_session(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let session = state
            .sessions
            .get(&session_id)
            .map(|managed| managed.session.clone())
            .ok_or_else(|| format!("AI session not found: {session_id}"))?;
        touch_session(&mut state, &session_id);
        drop(state);
        self.emit_session("ai://session-updated", &session);
        Ok(json!(session))
    }

    pub(crate) fn create_session(
        &self,
        args: &Value,
        vault_root: Option<PathBuf>,
    ) -> Result<Value, String> {
        let input: AiCreateSessionInput = input_from_args(args)?;
        let additional_roots = normalize_additional_roots(input.additional_roots)?;
        let vault_root_for_spec = vault_root.clone().ok_or_else(|| {
            "An open vault is required to start an AI runtime session.".to_string()
        })?;
        let setup = {
            let state = self
                .inner
                .lock()
                .map_err(|error| format!("Internal AI state error: {error}"))?;
            state
                .setup
                .get(&input.runtime_id)
                .cloned()
                .unwrap_or_default()
        };
        let spec = acp_process_spec(&input.runtime_id, &setup, vault_root_for_spec)?;
        let created = start_acp_session(
            spec,
            self.event_tx.clone(),
            self.tool_diffs.clone(),
            self.agent_writes.clone(),
        )?;
        let mut session = created.session;
        let handle = created.handle;

        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        session.status = AiSessionStatus::Idle;
        state.sessions.insert(
            session.session_id.clone(),
            ManagedAiSession {
                session: session.clone(),
                vault_root,
                additional_roots,
                runtime_handle: Some(handle),
            },
        );
        touch_session(&mut state, &session.session_id);
        drop(state);

        self.emit_session(AI_SESSION_CREATED_EVENT, &session);
        Ok(json!(session))
    }

    pub(crate) fn load_runtime_session(
        &self,
        args: &Value,
        vault_root: Option<PathBuf>,
    ) -> Result<Value, String> {
        let input: AiRuntimeSessionInput = input_from_args(args)?;
        let session = new_session_with_id(&input.runtime_id, input.session_id)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        state.sessions.insert(
            session.session_id.clone(),
            ManagedAiSession {
                session: session.clone(),
                vault_root,
                additional_roots: vec![],
                runtime_handle: None,
            },
        );
        touch_session(&mut state, &session.session_id);
        drop(state);
        self.emit_session("ai://session-created", &session);
        Ok(json!(session))
    }

    pub(crate) fn resume_runtime_session(
        &self,
        args: &Value,
        vault_root: Option<PathBuf>,
    ) -> Result<Value, String> {
        self.load_runtime_session(args, vault_root)
    }

    pub(crate) fn fork_runtime_session(
        &self,
        args: &Value,
        vault_root: Option<PathBuf>,
    ) -> Result<Value, String> {
        let input: AiRuntimeSessionInput = input_from_args(args)?;
        let session = new_session(&input.runtime_id)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        state.sessions.insert(
            session.session_id.clone(),
            ManagedAiSession {
                session: session.clone(),
                vault_root,
                additional_roots: vec![],
                runtime_handle: None,
            },
        );
        touch_session(&mut state, &session.session_id);
        drop(state);
        self.emit_session("ai://session-created", &session);
        Ok(json!(session))
    }

    pub(crate) fn set_model(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let model_id = required_string(args, &["modelId", "model_id"])?;
        if let Some(handle) = self.session_handle(&session_id)? {
            handle.set_model(&session_id, &model_id)?;
        }
        self.update_session(&session_id, |session| {
            session.model_id = model_id;
            Ok(())
        })
    }

    pub(crate) fn set_mode(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let mode_id = required_string(args, &["modeId", "mode_id"])?;
        if let Some(handle) = self.session_handle(&session_id)? {
            handle.set_mode(&session_id, &mode_id)?;
        }
        self.update_session(&session_id, |session| {
            session.mode_id = mode_id;
            Ok(())
        })
    }

    pub(crate) fn set_config_option(&self, args: &Value) -> Result<Value, String> {
        let input: AiSetConfigOptionInput = input_from_args(args)?;
        if let Some(handle) = self.session_handle(&input.session_id)? {
            handle.set_config_option(&input.session_id, &input.option_id, &input.value)?;
        }
        self.update_session(&input.session_id, |session| {
            if input.option_id == "model" {
                session.model_id = input.value.clone();
            }
            if input.option_id == "mode" {
                session.mode_id = input.value.clone();
            }
            let option = session
                .config_options
                .iter_mut()
                .find(|option| option.id == input.option_id)
                .ok_or_else(|| format!("AI config option not found: {}", input.option_id))?;
            option.value = input.value;
            Ok(())
        })
    }

    pub(crate) fn send_message(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let content = required_string(args, &["content"])?;
        let attachments = args
            .get("attachments")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let attachments: Vec<AiAttachmentInput> =
            serde_json::from_value(attachments).map_err(|error| error.to_string())?;

        let (prompt, handle) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|error| format!("Internal AI state error: {error}"))?;
            let managed = state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| format!("AI session not found: {session_id}"))?;
            let prompt = build_prompt_with_attachments(
                &content,
                &attachments,
                managed.vault_root.as_deref(),
                &managed.additional_roots,
            )?;
            managed.session.status = AiSessionStatus::Streaming;
            let handle = managed
                .runtime_handle
                .clone()
                .ok_or_else(|| "AI runtime session is not connected.".to_string())?;
            touch_session(&mut state, &session_id);
            (prompt, handle)
        };

        handle.prompt(&session_id, &prompt)?;
        self.load_session(&json!({ "sessionId": session_id }))
    }

    pub(crate) fn cancel_turn(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let session = {
            let mut state = self
                .inner
                .lock()
                .map_err(|error| format!("Internal AI state error: {error}"))?;
            let managed = state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| format!("AI session not found: {session_id}"))?;
            if let Some(handle) = managed.runtime_handle.clone() {
                handle.cancel(&session_id)?;
            }
            managed.session.status = AiSessionStatus::Idle;
            managed.session.clone()
        };
        self.emit_session(AI_SESSION_UPDATED_EVENT, &session);
        Ok(json!(session))
    }

    pub(crate) fn respond_permission(&self, args: &Value) -> Result<Value, String> {
        let input: AiRespondPermissionInput = input_from_args(args)?;
        let handle = self
            .session_handle(&input.session_id)?
            .ok_or_else(|| "AI runtime session is not connected.".to_string())?;
        handle.respond_permission(&input.request_id, input.option_id.as_deref())?;
        self.load_session(&json!({ "sessionId": input.session_id }))
    }

    pub(crate) fn respond_user_input(&self, args: &Value) -> Result<Value, String> {
        let input: AiRespondUserInputInput = input_from_args(args)?;
        let _ = input.request_id;
        let _ = input.answers;
        let runtime_id = self.session_runtime_id(&input.session_id)?;
        self.emit_runtime_feature_unavailable(&runtime_id, ELECTRON_AI_USER_INPUT_UNAVAILABLE);
        Err(ELECTRON_AI_USER_INPUT_UNAVAILABLE.to_string())
    }

    pub(crate) fn delete_runtime_session(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        state
            .sessions
            .remove(&session_id)
            .ok_or_else(|| format!("AI session not found: {session_id}"))?;
        state.session_order.retain(|id| id != &session_id);
        self.tool_diffs.clear_session(&session_id);
        Ok(json!(null))
    }

    pub(crate) fn delete_runtime_sessions_for_vault(
        &self,
        vault_root: Option<PathBuf>,
    ) -> Result<Value, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let session_ids = state
            .sessions
            .iter()
            .filter(|(_, managed)| managed.vault_root == vault_root)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            state.sessions.remove(&session_id);
            state.session_order.retain(|id| id != &session_id);
            self.tool_diffs.clear_session(&session_id);
        }
        Ok(json!(null))
    }

    pub(crate) fn register_file_baseline(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let display_path = required_string(args, &["displayPath", "display_path"])?;
        let content = required_string(args, &["content"])?;
        let state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        state
            .sessions
            .get(&session_id)
            .ok_or_else(|| format!("AI session not found: {session_id}"))?;
        self.tool_diffs
            .register_file_baseline(&session_id, &display_path, content);
        Ok(json!(null))
    }

    pub(crate) fn has_recent_agent_write(&self, path: &Path) -> bool {
        self.agent_writes.has_recent_match(path)
    }

    pub(crate) fn auth_terminal_unavailable(&self) -> Result<Value, String> {
        Err("AI auth terminal is not available in Electron yet. Real AI runtime setup requires the shared AI runtime extraction.".to_string())
    }

    fn update_session<F>(&self, session_id: &str, update: F) -> Result<Value, String>
    where
        F: FnOnce(&mut AiSession) -> Result<(), String>,
    {
        let session = {
            let mut state = self
                .inner
                .lock()
                .map_err(|error| format!("Internal AI state error: {error}"))?;
            let managed = state
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| format!("AI session not found: {session_id}"))?;
            update(&mut managed.session)?;
            let session = managed.session.clone();
            touch_session(&mut state, session_id);
            session
        };
        self.emit_session("ai://session-updated", &session);
        Ok(json!(session))
    }

    fn session_runtime_id(&self, session_id: &str) -> Result<String, String> {
        let state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        state
            .sessions
            .get(session_id)
            .map(|managed| managed.session.runtime_id.clone())
            .ok_or_else(|| format!("AI session not found: {session_id}"))
    }

    fn session_handle(&self, session_id: &str) -> Result<Option<AcpSessionHandle>, String> {
        let state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        state
            .sessions
            .get(session_id)
            .map(|managed| managed.runtime_handle.clone())
            .ok_or_else(|| format!("AI session not found: {session_id}"))
    }

    fn emit_runtime_feature_unavailable(&self, runtime_id: &str, message: &str) {
        self.emit_json(
            "ai://runtime-connection",
            json!({
                "runtime_id": runtime_id,
                "status": "error",
                "message": message,
            }),
        );
    }

    fn emit_session(&self, event_name: &str, session: &AiSession) {
        self.emit_json(event_name, json!(session));
    }

    fn emit_json(&self, event_name: &str, payload: Value) {
        emit_event(&self.event_tx, event_name, payload);
    }
}

struct CreatedAcpSession {
    session: AiSession,
    handle: AcpSessionHandle,
}

impl AcpSessionHandle {
    fn request(
        &self,
        build: impl FnOnce(mpsc::Sender<Result<(), String>>) -> AcpCommand,
    ) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(build(response_tx))
            .map_err(|error| error.to_string())?;
        response_rx.recv().map_err(|error| error.to_string())?
    }

    fn prompt(&self, session_id: &str, content: &str) -> Result<(), String> {
        self.request(|response_tx| AcpCommand::Prompt {
            session_id: session_id.to_string(),
            content: content.to_string(),
            response_tx,
        })
    }

    fn set_model(&self, session_id: &str, model_id: &str) -> Result<(), String> {
        self.request(|response_tx| AcpCommand::SetModel {
            session_id: session_id.to_string(),
            model_id: model_id.to_string(),
            response_tx,
        })
    }

    fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<(), String> {
        self.request(|response_tx| AcpCommand::SetMode {
            session_id: session_id.to_string(),
            mode_id: mode_id.to_string(),
            response_tx,
        })
    }

    fn set_config_option(
        &self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<(), String> {
        self.request(|response_tx| AcpCommand::SetConfigOption {
            session_id: session_id.to_string(),
            option_id: option_id.to_string(),
            value: value.to_string(),
            response_tx,
        })
    }

    fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.request(|response_tx| AcpCommand::Cancel {
            session_id: session_id.to_string(),
            response_tx,
        })
    }

    fn respond_permission(&self, request_id: &str, option_id: Option<&str>) -> Result<(), String> {
        self.request(|response_tx| AcpCommand::RespondPermission {
            request_id: request_id.to_string(),
            option_id: option_id.map(ToString::to_string),
            response_tx,
        })
    }
}

#[derive(Clone)]
struct NativeAcpClient {
    event_tx: Sender<RpcOutput>,
    message_ids: Arc<Mutex<HashMap<String, String>>>,
    thinking_ids: Arc<Mutex<HashMap<String, String>>>,
    permission_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<RequestPermissionOutcome>>>>,
    tool_diffs: ToolDiffState,
    agent_writes: AgentWriteTracker,
    terminal_output: Arc<Mutex<HashMap<String, String>>>,
    terminal_exit: Arc<Mutex<HashMap<String, TerminalExitMeta>>>,
}

impl NativeAcpClient {
    fn emit<T: serde::Serialize>(&self, event_name: &str, payload: T) {
        if let Ok(value) = serde_json::to_value(payload) {
            emit_event(&self.event_tx, event_name, value);
        }
    }

    fn emit_tool_activity(&self, session_id: &str, tool_call: &ToolCall) {
        if let Some(payload) = map_status_event(session_id, tool_call) {
            self.emit(AI_STATUS_EVENT, payload);
            return;
        }

        let diffs = self
            .tool_diffs
            .normalized_diffs_for_tool_call(session_id, tool_call);
        if tool_call.status != ToolCallStatus::Failed {
            self.mark_agent_write_paths(session_id, &diffs);
        }
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            map_tool_call(
                session_id,
                tool_call,
                self.terminal_summary(session_id, &tool_call.tool_call_id.0),
                diffs,
            ),
        );
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
        let key = call_state_key(session_id, tool_call_id);

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

    fn terminal_summary(&self, session_id: &str, tool_call_id: &str) -> Option<String> {
        let key = call_state_key(session_id, tool_call_id);
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

    fn mark_agent_write_paths(&self, session_id: &str, diffs: &[AiFileDiffPayload]) {
        for diff in diffs {
            self.agent_writes.mark_path(
                self.tool_diffs
                    .absolute_path_for_display_path(session_id, &diff.path),
            );
            if let Some(previous_path) = diff.previous_path.as_deref() {
                self.agent_writes.mark_path(
                    self.tool_diffs
                        .absolute_path_for_display_path(session_id, previous_path),
                );
            }
        }
    }

    fn next_message_id(&self, session_id: &str, kind: &str) -> String {
        format!(
            "{session_id}:{kind}:{}",
            SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn begin_message(&self, session_id: &str) -> String {
        let message_id = self.next_message_id(session_id, "message");
        if let Ok(mut ids) = self.message_ids.lock() {
            ids.insert(session_id.to_string(), message_id.clone());
        }
        self.emit(
            AI_MESSAGE_STARTED_EVENT,
            AiMessageStartedPayload {
                session_id: session_id.to_string(),
                message_id: message_id.clone(),
            },
        );
        message_id
    }

    fn current_message_id(&self, session_id: &str) -> Option<String> {
        self.message_ids
            .lock()
            .ok()
            .and_then(|ids| ids.get(session_id).cloned())
    }

    fn end_message(&self, session_id: &str) {
        let message_id = self
            .message_ids
            .lock()
            .ok()
            .and_then(|mut ids| ids.remove(session_id));
        if let Some(message_id) = message_id {
            self.emit(
                AI_MESSAGE_COMPLETED_EVENT,
                AiMessageCompletedPayload {
                    session_id: session_id.to_string(),
                    message_id,
                },
            );
        }
    }

    fn begin_thinking(&self, session_id: &str) -> String {
        let thinking_id = self.next_message_id(session_id, "thinking");
        if let Ok(mut ids) = self.thinking_ids.lock() {
            ids.insert(session_id.to_string(), thinking_id.clone());
        }
        emit_event(
            &self.event_tx,
            AI_THINKING_STARTED_EVENT,
            json!({ "session_id": session_id, "message_id": thinking_id }),
        );
        thinking_id
    }

    fn current_thinking_id(&self, session_id: &str) -> Option<String> {
        self.thinking_ids
            .lock()
            .ok()
            .and_then(|ids| ids.get(session_id).cloned())
    }

    fn end_thinking(&self, session_id: &str) {
        let thinking_id = self
            .thinking_ids
            .lock()
            .ok()
            .and_then(|mut ids| ids.remove(session_id));
        if let Some(thinking_id) = thinking_id {
            emit_event(
                &self.event_tx,
                AI_THINKING_COMPLETED_EVENT,
                json!({ "session_id": session_id, "message_id": thinking_id }),
            );
        }
    }
}

#[async_trait::async_trait(?Send)]
impl Client for NativeAcpClient {
    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> agent_client_protocol::Result<RequestPermissionResponse> {
        let session_id = args.session_id.0.to_string();
        let request_id = format!(
            "permission-{}",
            SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let title = args
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| "Permission required".to_string());
        let tool_call_id = args.tool_call.tool_call_id.0.to_string();
        let target = args
            .tool_call
            .fields
            .locations
            .as_ref()
            .and_then(|locations| locations.first())
            .map(|location| location.path.display().to_string());
        let pending_tool_call = ToolCall::try_from(args.tool_call.clone())
            .unwrap_or_else(|_| ToolCall::new(args.tool_call.tool_call_id.clone(), title.clone()));
        self.record_terminal_meta(
            &session_id,
            &pending_tool_call.tool_call_id.0,
            args.tool_call.meta.as_ref(),
        );
        let registered = self
            .tool_diffs
            .upsert_tool_call(&session_id, pending_tool_call);
        let diffs = self
            .tool_diffs
            .normalized_diffs_for_tool_call(&session_id, &registered);
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            map_tool_call(
                &session_id,
                &registered,
                self.terminal_summary(&session_id, &registered.tool_call_id.0),
                diffs.clone(),
            ),
        );
        let options = args
            .options
            .into_iter()
            .map(map_permission_option)
            .collect();
        let (tx, rx) = oneshot::channel();
        if let Ok(mut waiters) = self.permission_waiters.lock() {
            waiters.insert(request_id.clone(), tx);
        }
        self.emit(
            AI_PERMISSION_REQUEST_EVENT,
            AiPermissionRequestPayload {
                session_id,
                request_id,
                tool_call_id,
                title,
                target,
                options,
                diffs,
            },
        );
        let outcome = rx.await.unwrap_or(RequestPermissionOutcome::Cancelled);
        Ok(RequestPermissionResponse::new(outcome))
    }

    async fn session_notification(
        &self,
        args: SessionNotification,
    ) -> agent_client_protocol::Result<()> {
        let session_id = args.session_id.0.to_string();
        match args.update {
            SessionUpdate::AgentMessageChunk(ContentChunk {
                content: ContentBlock::Text(text),
                ..
            }) => {
                self.end_thinking(&session_id);
                let message_id = self
                    .current_message_id(&session_id)
                    .unwrap_or_else(|| self.begin_message(&session_id));
                self.emit(
                    AI_MESSAGE_DELTA_EVENT,
                    AiMessageDeltaPayload {
                        session_id,
                        message_id,
                        delta: text.text,
                    },
                );
            }
            SessionUpdate::AgentThoughtChunk(ContentChunk {
                content: ContentBlock::Text(text),
                ..
            }) => {
                let thinking_id = self
                    .current_thinking_id(&session_id)
                    .unwrap_or_else(|| self.begin_thinking(&session_id));
                emit_event(
                    &self.event_tx,
                    AI_THINKING_DELTA_EVENT,
                    json!({ "session_id": session_id, "message_id": thinking_id, "delta": text.text }),
                );
            }
            SessionUpdate::ToolCall(tool_call) => {
                self.record_terminal_meta(
                    &session_id,
                    &tool_call.tool_call_id.0,
                    tool_call.meta.as_ref(),
                );
                let tool_call = self.tool_diffs.upsert_tool_call(&session_id, tool_call);
                self.emit_tool_activity(&session_id, &tool_call);
            }
            SessionUpdate::ToolCallUpdate(update) => {
                self.record_terminal_meta(
                    &session_id,
                    &update.tool_call_id.0,
                    update.meta.as_ref(),
                );
                if let Some(tool_call) = self.tool_diffs.apply_tool_update(&session_id, update) {
                    self.emit_tool_activity(&session_id, &tool_call);
                }
            }
            SessionUpdate::UsageUpdate(update) => {
                self.emit(
                    AI_TOKEN_USAGE_EVENT,
                    AiTokenUsagePayload {
                        session_id,
                        used: update.used,
                        size: update.size,
                        cost: update.cost.map(|cost| AiTokenUsageCostPayload {
                            amount: cost.amount,
                            currency: cost.currency,
                        }),
                    },
                );
            }
            _ => {}
        }
        Ok(())
    }
}

fn start_acp_session(
    spec: AcpProcessSpec,
    event_tx: Sender<RpcOutput>,
    tool_diffs: ToolDiffState,
    agent_writes: AgentWriteTracker,
) -> Result<CreatedAcpSession, String> {
    let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel::<AcpCommand>();
    let (created_tx, created_rx) = mpsc::channel();
    let handle = AcpSessionHandle {
        command_tx: command_tx.clone(),
    };
    thread::spawn(move || {
        let runtime = match Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = created_tx.send(Err(format!("Failed to start ACP runtime: {error}")));
                return;
            }
        };
        let local = LocalSet::new();
        local.block_on(&runtime, async move {
            run_acp_actor(
                spec,
                event_tx,
                tool_diffs,
                agent_writes,
                command_rx,
                created_tx,
            )
            .await;
        });
    });
    let session = created_rx.recv().map_err(|error| error.to_string())??;
    Ok(CreatedAcpSession { session, handle })
}

async fn run_acp_actor(
    spec: AcpProcessSpec,
    event_tx: Sender<RpcOutput>,
    tool_diffs: ToolDiffState,
    agent_writes: AgentWriteTracker,
    mut command_rx: tokio::sync::mpsc::UnboundedReceiver<AcpCommand>,
    created_tx: mpsc::Sender<Result<AiSession, String>>,
) {
    let result = run_acp_actor_inner(
        spec,
        event_tx,
        tool_diffs,
        agent_writes,
        &mut command_rx,
        created_tx.clone(),
    )
    .await;
    if let Err(error) = result {
        let _ = created_tx.send(Err(error));
    }
}

async fn run_acp_actor_inner(
    spec: AcpProcessSpec,
    event_tx: Sender<RpcOutput>,
    tool_diffs: ToolDiffState,
    agent_writes: AgentWriteTracker,
    command_rx: &mut tokio::sync::mpsc::UnboundedReceiver<AcpCommand>,
    created_tx: mpsc::Sender<Result<AiSession, String>>,
) -> Result<(), String> {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    command.current_dir(&spec.cwd);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to acquire ACP stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to acquire ACP stdout".to_string())?;
    let client = NativeAcpClient {
        event_tx: event_tx.clone(),
        message_ids: Arc::new(Mutex::new(HashMap::new())),
        thinking_ids: Arc::new(Mutex::new(HashMap::new())),
        permission_waiters: Arc::new(Mutex::new(HashMap::new())),
        tool_diffs,
        agent_writes,
        terminal_output: Arc::new(Mutex::new(HashMap::new())),
        terminal_exit: Arc::new(Mutex::new(HashMap::new())),
    };
    let permission_waiters = client.permission_waiters.clone();
    let (connection, io_task) = ClientSideConnection::new(
        client.clone(),
        stdin.compat_write(),
        stdout.compat(),
        |fut| {
            tokio::task::spawn_local(fut);
        },
    );
    let connection = std::rc::Rc::new(connection);
    tokio::task::spawn_local({
        let event_tx = event_tx.clone();
        let runtime_id = spec.runtime_id.clone();
        async move {
            let result = io_task.await.map_err(|error| error.to_string());
            let message = match result {
                Ok(()) => "The AI runtime process exited.".to_string(),
                Err(error) => format!("The AI runtime process disconnected unexpectedly: {error}"),
            };
            emit_event(
                &event_tx,
                AI_RUNTIME_CONNECTION_EVENT,
                json!(AiRuntimeConnectionPayload {
                    runtime_id,
                    status: "error".to_string(),
                    message: Some(message),
                }),
            );
        }
    });
    connection
        .initialize(
            InitializeRequest::new(ProtocolVersion::LATEST)
                .client_capabilities(ClientCapabilities::new().fs(FileSystemCapabilities::new()))
                .client_info(
                    Implementation::new("neverwrite", env!("CARGO_PKG_VERSION"))
                        .title("NeverWrite"),
                ),
        )
        .await
        .map_err(|error| error.to_string())?;
    emit_event(
        &event_tx,
        AI_RUNTIME_CONNECTION_EVENT,
        json!(AiRuntimeConnectionPayload {
            runtime_id: spec.runtime_id.clone(),
            status: "ready".to_string(),
            message: None,
        }),
    );
    let response = connection
        .new_session(NewSessionRequest::new(spec.cwd.clone()))
        .await
        .map_err(|error| error.to_string())?;
    let session = session_from_acp_response(
        &spec.runtime_id,
        response.session_id.0.to_string(),
        response.models,
        response.modes,
        response.config_options,
    );
    client
        .tool_diffs
        .register_session_cwd(&session.session_id, spec.cwd.clone());
    let _ = created_tx.send(Ok(session));
    tokio::task::spawn_local(async move {
        let _ = child.wait().await;
    });
    while let Some(command) = command_rx.recv().await {
        handle_acp_command(command, &connection, &client, &permission_waiters).await;
    }
    Ok(())
}

async fn handle_acp_command(
    command: AcpCommand,
    connection: &ClientSideConnection,
    client: &NativeAcpClient,
    permission_waiters: &Arc<Mutex<HashMap<String, oneshot::Sender<RequestPermissionOutcome>>>>,
) {
    match command {
        AcpCommand::Prompt {
            session_id,
            content,
            response_tx,
        } => {
            let message_id = client.begin_message(&session_id);
            let result = connection
                .prompt(PromptRequest::new(
                    SessionId::new(session_id.clone()),
                    vec![ContentBlock::from(content)],
                ))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            client.end_thinking(&session_id);
            if client.current_message_id(&session_id).is_none() {
                client.emit(
                    AI_MESSAGE_STARTED_EVENT,
                    AiMessageStartedPayload {
                        session_id: session_id.clone(),
                        message_id: message_id.clone(),
                    },
                );
            }
            client.end_message(&session_id);
            if let Err(error) = &result {
                client.emit(
                    AI_SESSION_ERROR_EVENT,
                    AiSessionErrorPayload {
                        session_id: Some(session_id),
                        message: error.clone(),
                    },
                );
            }
            let _ = response_tx.send(result);
        }
        AcpCommand::SetModel {
            session_id,
            model_id,
            response_tx,
        } => {
            let result = connection
                .set_session_model(SetSessionModelRequest::new(
                    SessionId::new(session_id),
                    model_id,
                ))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = response_tx.send(result);
        }
        AcpCommand::SetMode {
            session_id,
            mode_id,
            response_tx,
        } => {
            let result = connection
                .set_session_mode(SetSessionModeRequest::new(
                    SessionId::new(session_id),
                    mode_id,
                ))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = response_tx.send(result);
        }
        AcpCommand::SetConfigOption {
            session_id,
            option_id,
            value,
            response_tx,
        } => {
            let result = connection
                .set_session_config_option(SetSessionConfigOptionRequest::new(
                    SessionId::new(session_id),
                    option_id,
                    value.as_str(),
                ))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = response_tx.send(result);
        }
        AcpCommand::Cancel {
            session_id,
            response_tx,
        } => {
            let result = connection
                .cancel(agent_client_protocol::CancelNotification::new(
                    SessionId::new(session_id),
                ))
                .await
                .map_err(|error| error.to_string());
            let _ = response_tx.send(result);
        }
        AcpCommand::RespondPermission {
            request_id,
            option_id,
            response_tx,
        } => {
            let outcome = option_id
                .map(|value| {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(value))
                })
                .unwrap_or(RequestPermissionOutcome::Cancelled);
            let result = permission_waiters
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|mut waiters| {
                    waiters
                        .remove(&request_id)
                        .ok_or_else(|| format!("Permission request not found: {request_id}"))
                })
                .and_then(|sender| {
                    sender
                        .send(outcome)
                        .map_err(|_| "Permission request was closed.".to_string())
                });
            let _ = response_tx.send(result);
        }
    }
}

fn session_from_acp_response(
    runtime_id: &str,
    session_id: String,
    models_state: Option<agent_client_protocol::SessionModelState>,
    modes_state: Option<agent_client_protocol::SessionModeState>,
    config_options: Option<Vec<agent_client_protocol::SessionConfigOption>>,
) -> AiSession {
    let mapped_models = models_state
        .as_ref()
        .map(|state| map_session_models(runtime_id, state))
        .unwrap_or_default();
    let models = if mapped_models.models.is_empty() {
        default_models(runtime_id)
    } else {
        mapped_models.models
    };
    let modes = modes_state
        .as_ref()
        .map(|state| map_session_modes(runtime_id, state))
        .unwrap_or_else(|| default_modes(runtime_id));
    let mut config_options = config_options
        .map(|options| map_session_config_options(runtime_id, options))
        .unwrap_or_else(|| default_config_options(runtime_id, &models, &modes));
    config_options = ensure_reasoning_config_option(
        runtime_id,
        config_options,
        models_state.as_ref(),
        &mapped_models.efforts_by_model,
    );
    let model_id = selected_model_id(models_state.as_ref(), &config_options)
        .or_else(|| models.first().map(|model| model.id.clone()))
        .unwrap_or_default();
    let mode_id = selected_mode_id(modes_state.as_ref(), &config_options)
        .or_else(|| modes.first().map(|mode| mode.id.clone()))
        .unwrap_or_else(|| "default".to_string());

    AiSession {
        session_id,
        runtime_id: runtime_id.to_string(),
        model_id,
        mode_id,
        status: AiSessionStatus::Idle,
        efforts_by_model: mapped_models.efforts_by_model,
        models,
        modes,
        config_options,
    }
}

#[derive(Default)]
struct MappedSessionModels {
    models: Vec<AiModelOption>,
    efforts_by_model: HashMap<String, Vec<String>>,
}

fn map_session_models(
    runtime_id: &str,
    state: &agent_client_protocol::SessionModelState,
) -> MappedSessionModels {
    let mut mapped = MappedSessionModels::default();

    for model in &state.available_models {
        let model_id = model.model_id.0.as_ref();
        let base_model_id = strip_effort_suffix(model_id).to_string();
        if let Some(effort) = extract_effort(model_id) {
            let efforts = mapped
                .efforts_by_model
                .entry(base_model_id.clone())
                .or_default();
            if !efforts.iter().any(|item| item == effort) {
                efforts.push(effort.to_string());
            }
        }

        if mapped.models.iter().any(|item| item.id == base_model_id) {
            continue;
        }

        mapped.models.push(AiModelOption {
            id: base_model_id,
            runtime_id: runtime_id.to_string(),
            name: strip_effort_suffix(&model.name).to_string(),
            description: model.description.clone().unwrap_or_default(),
        });
    }

    mapped
}

fn map_session_modes(
    runtime_id: &str,
    state: &agent_client_protocol::SessionModeState,
) -> Vec<AiModeOption> {
    state
        .available_modes
        .iter()
        .map(|mode| AiModeOption {
            id: mode.id.0.to_string(),
            runtime_id: runtime_id.to_string(),
            name: mode.name.clone(),
            description: mode.description.clone().unwrap_or_default(),
            disabled: false,
        })
        .collect()
}

fn map_session_config_options(
    runtime_id: &str,
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
                runtime_id: runtime_id.to_string(),
                category: map_config_option_category(&option.id.0, option.category.as_ref()),
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

fn map_config_option_category(
    option_id: &str,
    category: Option<&agent_client_protocol::SessionConfigOptionCategory>,
) -> AiConfigOptionCategory {
    let normalized_id = option_id.to_ascii_lowercase();
    if matches!(
        normalized_id.as_str(),
        "reasoning_effort" | "thought_level" | "effort"
    ) {
        return AiConfigOptionCategory::Reasoning;
    }

    match category {
        Some(agent_client_protocol::SessionConfigOptionCategory::Mode) => {
            AiConfigOptionCategory::Mode
        }
        Some(agent_client_protocol::SessionConfigOptionCategory::Model) => {
            AiConfigOptionCategory::Model
        }
        Some(agent_client_protocol::SessionConfigOptionCategory::ThoughtLevel) => {
            AiConfigOptionCategory::Reasoning
        }
        Some(agent_client_protocol::SessionConfigOptionCategory::Other(value))
            if matches!(
                value.as_str(),
                "thought_level" | "effort" | "reasoning" | "reasoning_effort"
            ) =>
        {
            AiConfigOptionCategory::Reasoning
        }
        _ => AiConfigOptionCategory::Other,
    }
}

fn ensure_reasoning_config_option(
    runtime_id: &str,
    mut config_options: Vec<AiConfigOption>,
    models_state: Option<&agent_client_protocol::SessionModelState>,
    efforts_by_model: &HashMap<String, Vec<String>>,
) -> Vec<AiConfigOption> {
    if config_options
        .iter()
        .any(|option| matches!(option.category, AiConfigOptionCategory::Reasoning))
    {
        return config_options;
    }

    let Some(model_id) = selected_model_id(models_state, &config_options) else {
        return config_options;
    };
    let Some(efforts) = efforts_by_model.get(&model_id) else {
        return config_options;
    };
    if efforts.len() <= 1 {
        return config_options;
    }

    let current_effort = models_state
        .and_then(|state| extract_effort(state.current_model_id.0.as_ref()))
        .filter(|effort| efforts.iter().any(|item| item == effort))
        .or_else(|| {
            efforts
                .iter()
                .find(|effort| effort.as_str() == "medium")
                .map(String::as_str)
        })
        .unwrap_or_else(|| efforts[0].as_str())
        .to_string();
    let reasoning_option = AiConfigOption {
        id: "reasoning_effort".to_string(),
        runtime_id: runtime_id.to_string(),
        category: AiConfigOptionCategory::Reasoning,
        label: "Reasoning Effort".to_string(),
        description: Some("Choose how much reasoning effort the model should use.".to_string()),
        kind: "select".to_string(),
        value: current_effort,
        options: efforts
            .iter()
            .map(|effort| AiConfigSelectOption {
                value: effort.clone(),
                label: reasoning_effort_label(effort),
                description: None,
            })
            .collect(),
    };
    let insert_at = config_options
        .iter()
        .position(|option| matches!(option.category, AiConfigOptionCategory::Model))
        .map(|index| index + 1)
        .unwrap_or(config_options.len());
    config_options.insert(insert_at, reasoning_option);
    config_options
}

fn selected_model_id(
    models_state: Option<&agent_client_protocol::SessionModelState>,
    config_options: &[AiConfigOption],
) -> Option<String> {
    config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Model))
        .map(|option| strip_effort_suffix(&option.value).to_string())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            models_state
                .map(|state| strip_effort_suffix(state.current_model_id.0.as_ref()).to_string())
                .filter(|value| !value.trim().is_empty())
        })
}

fn selected_mode_id(
    modes_state: Option<&agent_client_protocol::SessionModeState>,
    config_options: &[AiConfigOption],
) -> Option<String> {
    config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Mode))
        .map(|option| option.value.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            modes_state
                .map(|state| state.current_mode_id.0.to_string())
                .filter(|value| !value.trim().is_empty())
        })
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
    summary: Option<String>,
    diffs: Vec<AiFileDiffPayload>,
) -> AiToolActivityPayload {
    AiToolActivityPayload {
        session_id: session_id.to_string(),
        tool_call_id: tool_call.tool_call_id.0.to_string(),
        title: tool_call.title.clone(),
        kind: tool_kind_label(&tool_call.kind),
        status: tool_status_label(&tool_call.status),
        target: tool_call
            .locations
            .first()
            .map(|location| location.path.display().to_string()),
        summary: summary.or_else(|| summarize_tool_content(tool_call)),
        diffs: (!diffs.is_empty()).then_some(diffs),
    }
}

fn map_status_event(session_id: &str, tool_call: &ToolCall) -> Option<AiStatusEventPayload> {
    let meta = tool_call.meta.as_ref()?;
    let event_type = meta.get(ACP_STATUS_EVENT_TYPE_KEY)?.as_str()?;
    if event_type != "status" {
        return None;
    }

    Some(AiStatusEventPayload {
        session_id: session_id.to_string(),
        event_id: tool_call.tool_call_id.0.to_string(),
        kind: meta
            .get(ACP_STATUS_KIND_KEY)
            .and_then(|value| value.as_str())
            .unwrap_or("status")
            .to_string(),
        status: tool_status_label(&tool_call.status),
        title: tool_call.title.clone(),
        detail: summarize_tool_content(tool_call),
        emphasis: meta
            .get(ACP_STATUS_EMPHASIS_KEY)
            .and_then(|value| value.as_str())
            .unwrap_or("info")
            .to_string(),
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

fn call_state_key(session_id: &str, tool_call_id: &str) -> String {
    format!("{session_id}::{tool_call_id}")
}

fn tool_kind_label(kind: &agent_client_protocol::ToolKind) -> String {
    match kind {
        agent_client_protocol::ToolKind::Read => "read",
        agent_client_protocol::ToolKind::Edit => "edit",
        agent_client_protocol::ToolKind::Delete => "delete",
        agent_client_protocol::ToolKind::Move => "move",
        agent_client_protocol::ToolKind::Search => "search",
        agent_client_protocol::ToolKind::Execute => "execute",
        agent_client_protocol::ToolKind::Think => "think",
        agent_client_protocol::ToolKind::Fetch => "fetch",
        agent_client_protocol::ToolKind::SwitchMode => "switch_mode",
        agent_client_protocol::ToolKind::Other => "other",
        _ => "other",
    }
    .to_string()
}

fn tool_status_label(status: &ToolCallStatus) -> String {
    match status {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::InProgress => "in_progress",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
        _ => "other",
    }
    .to_string()
}

fn strip_effort_suffix(value: &str) -> &str {
    for effort in EFFORT_LEVELS {
        if let Some(base) = value.strip_suffix(&format!("/{effort}")) {
            return base;
        }
        if let Some(base) = value.strip_suffix(&format!(" ({effort})")) {
            return base;
        }
        if let Some(base) = value.strip_suffix(&format!("-{effort}")) {
            return base;
        }
    }
    value
}

const EFFORT_LEVELS: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];

fn extract_effort(value: &str) -> Option<&str> {
    let suffix = value.rsplit('/').next()?;
    EFFORT_LEVELS
        .iter()
        .find(|effort| **effort == suffix)
        .copied()
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

fn runtime_descriptors() -> Vec<AiRuntimeDescriptor> {
    [
        (
            CODEX_RUNTIME_ID,
            "Codex",
            "OpenAI Codex-compatible agent runtime.",
            vec!["chatgpt", "openai-api-key", "codex-api-key"],
        ),
        (
            CLAUDE_RUNTIME_ID,
            "Claude",
            "Claude ACP-compatible agent runtime.",
            vec!["claude-ai-login", "console-login", "gateway"],
        ),
        (
            GEMINI_RUNTIME_ID,
            "Gemini",
            "Gemini ACP-compatible agent runtime.",
            vec!["login_with_google", "use_gemini"],
        ),
        (
            KILO_RUNTIME_ID,
            "Kilo",
            "Kilo ACP-compatible agent runtime.",
            vec!["kilo-login"],
        ),
    ]
    .into_iter()
    .map(|(runtime_id, name, description, auth_methods)| {
        let models = default_models(runtime_id);
        let modes = default_modes(runtime_id);
        AiRuntimeDescriptor {
            runtime: AiRuntimeOption {
                id: runtime_id.to_string(),
                name: name.to_string(),
                description: description.to_string(),
                capabilities: vec![
                    "create_session".to_string(),
                    "prompt_queueing".to_string(),
                    "user_input".to_string(),
                ],
            },
            config_options: default_config_options(runtime_id, &models, &modes),
            models,
            modes,
        }
        .with_auth_capabilities(auth_methods)
    })
    .collect()
}

trait RuntimeDescriptorAuthTags {
    fn with_auth_capabilities(self, auth_methods: Vec<&str>) -> Self;
}

impl RuntimeDescriptorAuthTags for AiRuntimeDescriptor {
    fn with_auth_capabilities(mut self, auth_methods: Vec<&str>) -> Self {
        self.runtime
            .capabilities
            .extend(auth_methods.into_iter().map(ToString::to_string));
        self
    }
}

fn default_models(runtime_id: &str) -> Vec<AiModelOption> {
    vec![AiModelOption {
        id: "auto".to_string(),
        runtime_id: runtime_id.to_string(),
        name: "Auto".to_string(),
        description: "Use the runtime default model.".to_string(),
    }]
}

fn default_modes(runtime_id: &str) -> Vec<AiModeOption> {
    vec![
        AiModeOption {
            id: "default".to_string(),
            runtime_id: runtime_id.to_string(),
            name: "Default".to_string(),
            description: "Balanced assistance with normal approval behavior.".to_string(),
            disabled: false,
        },
        AiModeOption {
            id: "review".to_string(),
            runtime_id: runtime_id.to_string(),
            name: "Review".to_string(),
            description: "Focus on inspecting proposed changes before editing.".to_string(),
            disabled: false,
        },
    ]
}

fn default_config_options(
    runtime_id: &str,
    models: &[AiModelOption],
    modes: &[AiModeOption],
) -> Vec<AiConfigOption> {
    vec![
        AiConfigOption {
            id: "model".to_string(),
            runtime_id: runtime_id.to_string(),
            category: AiConfigOptionCategory::Model,
            label: "Model".to_string(),
            description: Some("Runtime model selection.".to_string()),
            kind: "select".to_string(),
            value: models
                .first()
                .map(|model| model.id.clone())
                .unwrap_or_else(|| "auto".to_string()),
            options: models
                .iter()
                .map(|model| AiConfigSelectOption {
                    value: model.id.clone(),
                    label: model.name.clone(),
                    description: Some(model.description.clone()),
                })
                .collect(),
        },
        AiConfigOption {
            id: "mode".to_string(),
            runtime_id: runtime_id.to_string(),
            category: AiConfigOptionCategory::Mode,
            label: "Mode".to_string(),
            description: Some("Agent behavior preset.".to_string()),
            kind: "select".to_string(),
            value: modes
                .first()
                .map(|mode| mode.id.clone())
                .unwrap_or_else(|| "default".to_string()),
            options: modes
                .iter()
                .map(|mode| AiConfigSelectOption {
                    value: mode.id.clone(),
                    label: mode.name.clone(),
                    description: Some(mode.description.clone()),
                })
                .collect(),
        },
    ]
}

fn new_session(runtime_id: &str) -> Result<AiSession, String> {
    let session_id = format!(
        "electron-session-{}-{}",
        now_ms(),
        SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    new_session_with_id(runtime_id, session_id)
}

fn new_session_with_id(runtime_id: &str, session_id: String) -> Result<AiSession, String> {
    validate_runtime_id(runtime_id)?;
    let models = default_models(runtime_id);
    let modes = default_modes(runtime_id);
    let config_options = default_config_options(runtime_id, &models, &modes);
    Ok(AiSession {
        session_id,
        runtime_id: runtime_id.to_string(),
        model_id: models
            .first()
            .map(|model| model.id.clone())
            .unwrap_or_else(|| "auto".to_string()),
        mode_id: modes
            .first()
            .map(|mode| mode.id.clone())
            .unwrap_or_else(|| "default".to_string()),
        status: AiSessionStatus::Idle,
        efforts_by_model: HashMap::new(),
        models,
        modes,
        config_options,
    })
}

fn setup_status_for(
    runtime_id: &str,
    setup: RuntimeSetupState,
) -> Result<AiRuntimeSetupStatus, String> {
    validate_runtime_id(runtime_id)?;
    let custom_path = setup
        .custom_binary_path
        .clone()
        .and_then(normalize_optional_string);
    let resolved = resolve_acp_command(runtime_id, &setup);
    let binary_path = resolved.display;
    let binary_ready = resolved.program.is_some();
    let binary_source = if binary_ready {
        resolved.source
    } else {
        AiRuntimeBinarySource::Missing
    };
    let inherited_auth_method = inherited_auth_method(runtime_id);
    let auth_ready = setup.auth_ready
        || inherited_auth_method.is_some()
        || (binary_ready && runtime_delegates_auth(runtime_id));
    let auth_method = setup.auth_method.or(inherited_auth_method).or_else(|| {
        (binary_ready && runtime_delegates_auth(runtime_id)).then(|| "runtime-managed".to_string())
    });
    let message = if !binary_ready {
        setup.message
    } else if auth_ready {
        None
    } else {
        setup.message
    };

    Ok(AiRuntimeSetupStatus {
        runtime_id: runtime_id.to_string(),
        binary_ready,
        binary_path,
        binary_source,
        has_custom_binary_path: custom_path.is_some(),
        auth_ready,
        auth_method,
        auth_methods: auth_methods(runtime_id),
        has_gateway_config: setup.has_gateway_config,
        has_gateway_url: setup.has_gateway_url,
        onboarding_required: !binary_ready || !auth_ready,
        message,
    })
}

fn acp_process_spec(
    runtime_id: &str,
    setup: &RuntimeSetupState,
    cwd: PathBuf,
) -> Result<AcpProcessSpec, String> {
    validate_runtime_id(runtime_id)?;
    let resolved = resolve_acp_command(runtime_id, setup);
    let program = resolved.program.ok_or_else(|| {
        format!(
            "No {} runtime binary is configured.",
            runtime_name(runtime_id)
        )
    })?;
    let mut env = setup.env.clone();
    if let Some(method) = setup.auth_method.as_deref() {
        if runtime_id == GEMINI_RUNTIME_ID {
            env.insert("GEMINI_DEFAULT_AUTH_TYPE".to_string(), method.to_string());
        }
    }
    Ok(AcpProcessSpec {
        program,
        args: resolved.args,
        cwd,
        env,
        runtime_id: runtime_id.to_string(),
    })
}

#[derive(Debug)]
struct ResolvedAcpCommand {
    program: Option<PathBuf>,
    args: Vec<String>,
    display: Option<String>,
    source: AiRuntimeBinarySource,
}

fn resolve_acp_command(runtime_id: &str, setup: &RuntimeSetupState) -> ResolvedAcpCommand {
    if let Some(raw) = std::env::var_os(runtime_bin_env_var(runtime_id)) {
        let resolved =
            resolve_command_candidate(&raw.to_string_lossy(), AiRuntimeBinarySource::Env);
        if resolved.display.is_some() {
            return with_runtime_args(runtime_id, resolved);
        }
    }

    if let Some(raw) = setup.custom_binary_path.as_deref() {
        let resolved = resolve_command_candidate(raw, AiRuntimeBinarySource::Custom);
        if resolved.display.is_some() {
            return with_runtime_args(runtime_id, resolved);
        }
    }

    if let Some(resolved) = resolve_packaged_acp_command(runtime_id) {
        return with_runtime_args(runtime_id, resolved);
    }

    if runtime_id == CODEX_RUNTIME_ID {
        let vendor = codex_vendor_binary_path();
        if vendor.is_file() {
            return ResolvedAcpCommand {
                display: Some(vendor.display().to_string()),
                program: Some(vendor),
                args: Vec::new(),
                source: AiRuntimeBinarySource::Vendor,
            };
        }
    }

    if runtime_id == CLAUDE_RUNTIME_ID {
        let vendor = claude_vendor_entry_path();
        if vendor.is_file() {
            return ResolvedAcpCommand {
                display: Some(vendor.display().to_string()),
                program: Some(PathBuf::from("node")),
                args: vec![vendor.display().to_string()],
                source: AiRuntimeBinarySource::Vendor,
            };
        }
    }

    if let Some(path) = find_program_on_path(default_executable_name(runtime_id)) {
        return with_runtime_args(
            runtime_id,
            ResolvedAcpCommand {
                display: Some(path.display().to_string()),
                program: Some(path),
                args: Vec::new(),
                source: AiRuntimeBinarySource::Env,
            },
        );
    }

    ResolvedAcpCommand {
        program: None,
        args: Vec::new(),
        display: setup
            .custom_binary_path
            .clone()
            .or_else(|| Some(default_executable_name(runtime_id).to_string())),
        source: AiRuntimeBinarySource::Missing,
    }
}

fn resolve_packaged_acp_command(runtime_id: &str) -> Option<ResolvedAcpCommand> {
    let resource_dir = acp_resource_dir()?;
    match runtime_id {
        CODEX_RUNTIME_ID => {
            let binary = resource_dir
                .join("binaries")
                .join(runtime_binary_name("codex-acp"));
            binary.is_file().then(|| ResolvedAcpCommand {
                display: Some(binary.display().to_string()),
                program: Some(binary),
                args: Vec::new(),
                source: AiRuntimeBinarySource::Bundled,
            })
        }
        CLAUDE_RUNTIME_ID => {
            let node = resource_dir
                .join("embedded")
                .join("node")
                .join("bin")
                .join(runtime_binary_name("node"));
            let entry = resource_dir
                .join("embedded")
                .join("claude-agent-acp")
                .join("dist")
                .join("index.js");
            if node.is_file() && entry.is_file() {
                return Some(ResolvedAcpCommand {
                    display: Some(entry.display().to_string()),
                    program: Some(node),
                    args: vec![entry.display().to_string()],
                    source: AiRuntimeBinarySource::Bundled,
                });
            }

            let binary = resource_dir
                .join("binaries")
                .join(runtime_binary_name("claude-agent-acp"));
            binary.is_file().then(|| ResolvedAcpCommand {
                display: Some(binary.display().to_string()),
                program: Some(binary),
                args: Vec::new(),
                source: AiRuntimeBinarySource::Bundled,
            })
        }
        _ => None,
    }
}

fn acp_resource_dir() -> Option<PathBuf> {
    std::env::var_os("NEVERWRITE_ELECTRON_ACP_RESOURCE_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn runtime_binary_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn resolve_command_candidate(raw: &str, source: AiRuntimeBinarySource) -> ResolvedAcpCommand {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ResolvedAcpCommand {
            program: None,
            args: Vec::new(),
            display: None,
            source,
        };
    }
    let path = PathBuf::from(trimmed);
    if path.components().count() > 1 {
        return ResolvedAcpCommand {
            program: path.is_file().then_some(path.clone()),
            args: Vec::new(),
            display: Some(path.display().to_string()),
            source,
        };
    }
    if let Some(path) = find_program_on_path(trimmed) {
        return ResolvedAcpCommand {
            program: Some(path.clone()),
            args: Vec::new(),
            display: Some(path.display().to_string()),
            source,
        };
    }
    ResolvedAcpCommand {
        program: None,
        args: Vec::new(),
        display: Some(trimmed.to_string()),
        source,
    }
}

fn with_runtime_args(runtime_id: &str, mut resolved: ResolvedAcpCommand) -> ResolvedAcpCommand {
    if resolved.program.is_none() {
        return resolved;
    }
    match runtime_id {
        GEMINI_RUNTIME_ID if !resolved.args.iter().any(|arg| arg == "--acp") => {
            resolved.args.push("--acp".to_string());
        }
        KILO_RUNTIME_ID if !resolved.args.iter().any(|arg| arg == "acp") => {
            resolved.args.push("acp".to_string());
        }
        _ => {}
    }
    resolved
}

fn runtime_bin_env_var(runtime_id: &str) -> &'static str {
    match runtime_id {
        CODEX_RUNTIME_ID => "NEVERWRITE_CODEX_ACP_BIN",
        CLAUDE_RUNTIME_ID => "NEVERWRITE_CLAUDE_ACP_BIN",
        GEMINI_RUNTIME_ID => "NEVERWRITE_GEMINI_ACP_BIN",
        KILO_RUNTIME_ID => "NEVERWRITE_KILO_ACP_BIN",
        _ => "NEVERWRITE_AI_ACP_BIN",
    }
}

fn inherited_auth_method(runtime_id: &str) -> Option<String> {
    match runtime_id {
        CODEX_RUNTIME_ID => env_secret_present("CODEX_API_KEY")
            .then(|| "codex-api-key".to_string())
            .or_else(|| env_secret_present("OPENAI_API_KEY").then(|| "openai-api-key".to_string())),
        CLAUDE_RUNTIME_ID => env_secret_present("ANTHROPIC_AUTH_TOKEN")
            .then(|| "console-login".to_string())
            .or_else(|| {
                env_secret_present("ANTHROPIC_API_KEY").then(|| "console-login".to_string())
            })
            .or_else(|| env_secret_present("ANTHROPIC_BASE_URL").then(|| "gateway".to_string())),
        GEMINI_RUNTIME_ID => env_secret_present("GEMINI_API_KEY")
            .then(|| "use_gemini".to_string())
            .or_else(|| env_secret_present("GOOGLE_API_KEY").then(|| "use_gemini".to_string())),
        KILO_RUNTIME_ID => None,
        _ => None,
    }
}

fn env_secret_present(key: &str) -> bool {
    std::env::var_os(key)
        .map(|value| !value.to_string_lossy().trim().is_empty())
        .unwrap_or(false)
}

fn runtime_delegates_auth(runtime_id: &str) -> bool {
    matches!(
        runtime_id,
        CODEX_RUNTIME_ID | CLAUDE_RUNTIME_ID | GEMINI_RUNTIME_ID | KILO_RUNTIME_ID
    )
}

fn runtime_name(runtime_id: &str) -> &'static str {
    match runtime_id {
        CODEX_RUNTIME_ID => "Codex",
        CLAUDE_RUNTIME_ID => "Claude",
        GEMINI_RUNTIME_ID => "Gemini",
        KILO_RUNTIME_ID => "Kilo",
        _ => "AI",
    }
}

fn codex_vendor_binary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../vendor/codex-acp/target")
        .join(if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        })
        .join(runtime_binary_name("codex-acp"))
}

fn claude_vendor_entry_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../vendor/Claude-agent-acp-upstream/dist/index.js")
}

fn auth_methods(runtime_id: &str) -> Vec<AiAuthMethod> {
    match runtime_id {
        CODEX_RUNTIME_ID => vec![
            AiAuthMethod {
                id: "chatgpt".to_string(),
                name: "ChatGPT account".to_string(),
                description: "Sign in with your ChatGPT account.".to_string(),
            },
            AiAuthMethod {
                id: "openai-api-key".to_string(),
                name: "API key".to_string(),
                description: "Use an OpenAI API key stored locally.".to_string(),
            },
            AiAuthMethod {
                id: "codex-api-key".to_string(),
                name: "Codex API key".to_string(),
                description: "Use a Codex API key stored locally.".to_string(),
            },
        ],
        CLAUDE_RUNTIME_ID => vec![
            AiAuthMethod {
                id: "claude-ai-login".to_string(),
                name: "Claude subscription".to_string(),
                description: "Open a terminal-based Claude subscription login flow.".to_string(),
            },
            AiAuthMethod {
                id: "console-login".to_string(),
                name: "Anthropic Console".to_string(),
                description: "Open a terminal-based Anthropic Console login flow.".to_string(),
            },
            AiAuthMethod {
                id: "gateway".to_string(),
                name: "Custom gateway".to_string(),
                description: "Use a custom Anthropic-compatible gateway.".to_string(),
            },
        ],
        GEMINI_RUNTIME_ID => vec![
            AiAuthMethod {
                id: "login_with_google".to_string(),
                name: "Log in with Google".to_string(),
                description: "Open a Gemini sign-in terminal for Google account authentication."
                    .to_string(),
            },
            AiAuthMethod {
                id: "use_gemini".to_string(),
                name: "Gemini API key".to_string(),
                description: "Use a Gemini Developer API key stored locally.".to_string(),
            },
        ],
        KILO_RUNTIME_ID => vec![AiAuthMethod {
            id: "kilo-login".to_string(),
            name: "Kilo login".to_string(),
            description: "Open the Kilo CLI sign-in flow in an integrated terminal.".to_string(),
        }],
        _ => vec![],
    }
}

fn update_auth_state(
    setup: &mut RuntimeSetupState,
    runtime_id: &str,
    input: AiRuntimeSetupPayload,
) {
    let has_gateway_url = input
        .gateway_base_url
        .as_ref()
        .and_then(|value| normalize_optional_string(value.clone()))
        .or_else(|| {
            input
                .anthropic_base_url
                .as_ref()
                .and_then(|value| normalize_optional_string(value.clone()))
        })
        .is_some();
    let has_gateway_config = has_gateway_url
        || input.gateway_headers.is_some()
        || input.anthropic_custom_headers.is_some()
        || input
            .google_cloud_project
            .as_ref()
            .and_then(|value| normalize_optional_string(value.clone()))
            .is_some()
        || input
            .google_cloud_location
            .as_ref()
            .and_then(|value| normalize_optional_string(value.clone()))
            .is_some();
    let mut touched_auth = false;
    if runtime_id == CODEX_RUNTIME_ID {
        if let Some(patch) = input.openai_api_key.clone() {
            touched_auth |= apply_secret_patch(setup, "OPENAI_API_KEY", patch, "openai-api-key");
        }
        if let Some(patch) = input.codex_api_key.clone() {
            touched_auth |= apply_secret_patch(setup, "CODEX_API_KEY", patch, "codex-api-key");
        }
    }
    if runtime_id == CLAUDE_RUNTIME_ID {
        if let Some(patch) = input.anthropic_auth_token.clone() {
            touched_auth |=
                apply_secret_patch(setup, "ANTHROPIC_AUTH_TOKEN", patch, "console-login");
        }
        if let Some(patch) = input.anthropic_custom_headers.clone() {
            touched_auth |= apply_secret_patch(setup, "ANTHROPIC_CUSTOM_HEADERS", patch, "gateway");
        }
    }
    if runtime_id == GEMINI_RUNTIME_ID {
        if let Some(patch) = input.gemini_api_key.clone() {
            touched_auth |= apply_secret_patch(setup, "GEMINI_API_KEY", patch, "use_gemini");
        }
        if let Some(patch) = input.google_api_key.clone() {
            touched_auth |= apply_secret_patch(setup, "GOOGLE_API_KEY", patch, "use_gemini");
        }
    }

    setup.has_gateway_url = has_gateway_url;
    setup.has_gateway_config = has_gateway_config;
    if has_gateway_config {
        setup
            .auth_method
            .get_or_insert_with(|| "gateway".to_string());
        if let Some(value) = input
            .gateway_base_url
            .or(input.anthropic_base_url)
            .and_then(normalize_optional_string)
        {
            setup.env.insert("ANTHROPIC_BASE_URL".to_string(), value);
        }
        touched_auth = true;
    }
    if let Some(value) = input
        .google_cloud_project
        .and_then(normalize_optional_string)
    {
        setup.env.insert("GOOGLE_CLOUD_PROJECT".to_string(), value);
    }
    if let Some(value) = input
        .google_cloud_location
        .and_then(normalize_optional_string)
    {
        setup.env.insert("GOOGLE_CLOUD_LOCATION".to_string(), value);
    }
    if touched_auth {
        setup.auth_ready = !setup.env.is_empty() || has_gateway_config;
        setup.message = None;
    }
}

fn apply_secret_patch(
    setup: &mut RuntimeSetupState,
    env_key: &str,
    patch: AiSecretPatch,
    auth_method: &str,
) -> bool {
    match patch.action.as_str() {
        "set" => {
            if let Some(value) = patch.value.and_then(normalize_optional_string) {
                setup.env.insert(env_key.to_string(), value);
                setup
                    .auth_method
                    .get_or_insert_with(|| auth_method.to_string());
                setup.auth_ready = true;
                setup.message = None;
                return true;
            }
        }
        "clear" => {
            setup.env.remove(env_key);
            setup.auth_ready = false;
            setup.auth_method = None;
            setup.message = None;
            return true;
        }
        _ => {}
    }
    false
}

fn build_prompt_with_attachments(
    content: &str,
    attachments: &[AiAttachmentInput],
    vault_root: Option<&Path>,
    additional_roots: &[PathBuf],
) -> Result<String, String> {
    let mut context_parts = Vec::new();
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

        match attachment.attachment_type.as_deref() {
            Some("folder") => {
                if let Some(folder_rel) = attachment.note_id.as_deref() {
                    context_parts.push(format!(
                        "<attached_folder name=\"{}\" path=\"{}\" />",
                        attachment.label.trim_start_matches("Folder "),
                        folder_rel
                    ));
                }
            }
            Some("audio") => {
                if let Some(transcription) = attachment.transcription.as_deref() {
                    let source = attachment.file_path.as_deref().unwrap_or("audio");
                    context_parts.push(format!(
                        "<attached_audio name=\"{}\" source=\"{}\">\n[Transcription]\n{}\n</attached_audio>",
                        attachment.label, source, transcription
                    ));
                }
            }
            Some("file") => {
                if let Some(file_path) = attachment
                    .file_path
                    .as_deref()
                    .or(attachment.path.as_deref())
                {
                    append_file_attachment(
                        &mut context_parts,
                        attachment,
                        file_path,
                        vault_root,
                        additional_roots,
                    )?;
                }
            }
            _ => {
                if let Some(path) = attachment.path.as_deref() {
                    let path = allowed_attachment_path(path, vault_root, additional_roots)?;
                    match std::fs::read_to_string(&path) {
                        Ok(file_content) => context_parts.push(format!(
                            "<attached_note name=\"{}\">\n{}\n</attached_note>",
                            attachment.label, file_content
                        )),
                        Err(error) => context_parts.push(format!(
                            "<attached_note name=\"{}\">\n[Error reading note: {}]\n</attached_note>",
                            attachment.label, error
                        )),
                    }
                }
            }
        }
    }

    if context_parts.is_empty() {
        return Ok(content.to_string());
    }
    Ok(format!("{}\n\n{}", context_parts.join("\n\n"), content))
}

fn append_file_attachment(
    context_parts: &mut Vec<String>,
    attachment: &AiAttachmentInput,
    file_path: &str,
    vault_root: Option<&Path>,
    additional_roots: &[PathBuf],
) -> Result<(), String> {
    let path = allowed_attachment_path(file_path, vault_root, additional_roots)?;
    let mime = attachment
        .mime_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    let rel_path = display_attachment_path(&path, vault_root);

    if mime == "application/pdf" {
        context_parts.push(format!(
            "<attached_pdf name=\"{}\" path=\"{}\" />",
            attachment.label, rel_path
        ));
    } else if mime.starts_with("text/") || mime == "application/json" {
        match std::fs::read_to_string(&path) {
            Ok(text) => context_parts.push(format!(
                "<attached_file name=\"{}\" type=\"{}\">\n{}\n</attached_file>",
                attachment.label, mime, text
            )),
            Err(error) => context_parts.push(format!(
                "<attached_file name=\"{}\" type=\"{}\">\n[Error reading file: {}]\n</attached_file>",
                attachment.label, mime, error
            )),
        }
    } else if mime.starts_with("image/") {
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        context_parts.push(format!(
            "<attached_image name=\"{}\" type=\"{}\" path=\"{}\" size=\"{}\" />",
            attachment.label, mime, rel_path, size
        ));
    } else {
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        context_parts.push(format!(
            "<attached_file name=\"{}\" type=\"{}\">\n[Binary file: {} bytes]\n</attached_file>",
            attachment.label, mime, size
        ));
    }

    Ok(())
}

fn allowed_attachment_path(
    raw_path: &str,
    vault_root: Option<&Path>,
    additional_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if vault_root
        .and_then(|root| path.strip_prefix(root).ok())
        .is_some()
        || additional_roots
            .iter()
            .any(|root| path.strip_prefix(root).is_ok())
    {
        return Ok(path);
    }
    Err("Attachment path is outside the vault and approved additional roots.".to_string())
}

fn display_attachment_path(path: &Path, vault_root: Option<&Path>) -> String {
    vault_root
        .and_then(|root| path.strip_prefix(root).ok())
        .unwrap_or(path)
        .display()
        .to_string()
}

fn normalize_additional_roots(raw_roots: Option<Vec<String>>) -> Result<Vec<PathBuf>, String> {
    raw_roots
        .unwrap_or_default()
        .into_iter()
        .filter_map(normalize_optional_string)
        .map(|raw| {
            PathBuf::from(raw)
                .canonicalize()
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn input_from_args<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.get("input").cloned().unwrap_or_else(|| args.clone()))
        .map_err(|error| error.to_string())
}

fn required_runtime_id(args: &Value) -> Result<String, String> {
    required_string(args, &["runtimeId", "runtime_id"])
}

fn required_string(args: &Value, names: &[&str]) -> Result<String, String> {
    names
        .iter()
        .find_map(|name| {
            args.get(*name)
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn validate_runtime_id(runtime_id: &str) -> Result<(), String> {
    match runtime_id {
        CODEX_RUNTIME_ID | CLAUDE_RUNTIME_ID | GEMINI_RUNTIME_ID | KILO_RUNTIME_ID => Ok(()),
        other => Err(format!("Unsupported AI runtime: {other}")),
    }
}

fn normalize_optional_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn default_executable_name(runtime_id: &str) -> &'static str {
    match runtime_id {
        CODEX_RUNTIME_ID => "codex",
        CLAUDE_RUNTIME_ID => "claude",
        GEMINI_RUNTIME_ID => "gemini",
        KILO_RUNTIME_ID => "kilo",
        _ => "unknown",
    }
}

fn diagnostic_executable_names() -> Vec<&'static str> {
    vec!["codex", "claude", "gemini", "kilo"]
}

fn find_program_on_path(name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(name);
    if candidate.components().count() > 1 && is_executable_file(&candidate) {
        return Some(candidate);
    }
    let path_value = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path_value) {
        let candidate = entry.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn touch_session(state: &mut NativeAiInner, session_id: &str) {
    state.session_order.retain(|id| id != session_id);
    state.session_order.insert(0, session_id.to_string());
}

fn emit_event(event_tx: &Sender<RpcOutput>, event_name: &str, payload: Value) {
    let _ = event_tx.send(RpcOutput::Event {
        event_name: event_name.to_string(),
        payload,
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::{
        Meta, ModelInfo, PermissionOptionKind, SessionConfigOption, SessionConfigOptionCategory,
        SessionConfigSelectOption, SessionModelState, SessionNotification, SessionUpdate,
        ToolCallContent, ToolCallId, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
    };
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration as StdDuration;

    fn test_client(event_tx: mpsc::Sender<RpcOutput>) -> NativeAcpClient {
        NativeAcpClient {
            event_tx,
            message_ids: Arc::new(Mutex::new(HashMap::new())),
            thinking_ids: Arc::new(Mutex::new(HashMap::new())),
            permission_waiters: Arc::new(Mutex::new(HashMap::new())),
            tool_diffs: ToolDiffState::default(),
            agent_writes: AgentWriteTracker::default(),
            terminal_output: Arc::new(Mutex::new(HashMap::new())),
            terminal_exit: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn run_client_future<F>(future: F) -> F::Output
    where
        F: std::future::Future,
    {
        Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn setup_status_accepts_custom_acp_binary_and_auth_env() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("fake-acp");
        fs::write(&runtime, "#!/bin/sh\n").unwrap();

        let status = ai
            .update_setup(&json!({
                "runtimeId": CODEX_RUNTIME_ID,
                "input": {
                    "custom_binary_path": runtime,
                    "openai_api_key": { "action": "set", "value": "test-key" }
                }
            }))
            .expect("setup should update");

        assert_eq!(
            status.get("binary_ready").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            status.get("auth_ready").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            status.get("onboarding_required").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn acp_session_synthesizes_reasoning_config_from_model_efforts() {
        let models_state = SessionModelState::new(
            "gpt-5.5/medium",
            vec![
                ModelInfo::new("gpt-5.5/low", "GPT-5.5 (low)"),
                ModelInfo::new("gpt-5.5/medium", "GPT-5.5 (medium)"),
                ModelInfo::new("gpt-5.5/high", "GPT-5.5 (high)"),
                ModelInfo::new("gpt-5.5/xhigh", "GPT-5.5 (xhigh)"),
            ],
        );
        let config_options = vec![SessionConfigOption::select(
            "model",
            "Model",
            "gpt-5.5",
            vec![SessionConfigSelectOption::new("gpt-5.5", "GPT-5.5")],
        )
        .category(SessionConfigOptionCategory::Model)];

        let session = session_from_acp_response(
            CODEX_RUNTIME_ID,
            "session-1".to_string(),
            Some(models_state),
            None,
            Some(config_options),
        );

        assert_eq!(session.model_id, "gpt-5.5");
        assert_eq!(session.models.len(), 1);
        assert_eq!(
            session.efforts_by_model.get("gpt-5.5"),
            Some(&vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
                "xhigh".to_string()
            ])
        );

        let reasoning = session
            .config_options
            .iter()
            .find(|option| option.id == "reasoning_effort")
            .expect("reasoning config should be synthesized");
        assert!(matches!(
            reasoning.category,
            AiConfigOptionCategory::Reasoning
        ));
        assert_eq!(reasoning.value, "medium");
        assert_eq!(
            reasoning
                .options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "medium", "high", "xhigh"]
        );
    }

    #[test]
    fn acp_config_mapping_treats_effort_category_as_reasoning() {
        let mapped = map_session_config_options(
            CODEX_RUNTIME_ID,
            vec![SessionConfigOption::select(
                "custom_effort",
                "Effort",
                "high",
                vec![SessionConfigSelectOption::new("high", "High")],
            )
            .category(SessionConfigOptionCategory::Other("effort".to_string()))],
        );

        assert!(matches!(
            mapped[0].category,
            AiConfigOptionCategory::Reasoning
        ));
    }

    #[test]
    fn blocks_attachment_paths_outside_allowed_roots() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();

        let error = build_prompt_with_attachments(
            "hello",
            &[AiAttachmentInput {
                label: "Secret".to_string(),
                path: None,
                content: None,
                attachment_type: Some("file".to_string()),
                note_id: None,
                file_path: Some(outside_file.display().to_string()),
                mime_type: Some("text/plain".to_string()),
                transcription: None,
            }],
            Some(vault.path()),
            &[],
        )
        .expect_err("outside attachment should be blocked");

        assert!(error.contains("outside the vault"));
    }

    #[test]
    fn session_tool_call_completed_emits_reconstructed_diffs() {
        let (event_tx, event_rx) = mpsc::channel();
        let client = test_client(event_tx);
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("note.md");
        fs::write(&file_path, "old text").unwrap();
        client
            .tool_diffs
            .register_session_cwd("session-1", temp.path().to_path_buf());

        let tool_call = ToolCall::new(ToolCallId::from("tool-1"), "Write note.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(json!({
                "file_path": "note.md",
                "content": "new text",
            }));

        run_client_future(Client::session_notification(
            &client,
            SessionNotification::new("session-1", SessionUpdate::ToolCall(tool_call)),
        ))
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("tool activity event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };

        assert_eq!(event_name, AI_TOOL_ACTIVITY_EVENT);
        let diff = payload
            .get("diffs")
            .and_then(Value::as_array)
            .and_then(|diffs| diffs.first())
            .expect("diff payload");
        assert_eq!(diff.get("path").and_then(Value::as_str), Some("note.md"));
        assert_eq!(diff.get("kind").and_then(Value::as_str), Some("update"));
        assert_eq!(
            diff.get("old_text").and_then(Value::as_str),
            Some("old text")
        );
        assert_eq!(
            diff.get("new_text").and_then(Value::as_str),
            Some("new text")
        );
        assert!(client.agent_writes.has_recent_match(&file_path));
    }

    #[test]
    fn session_tool_call_update_preserves_cached_diffs_on_completion() {
        let (event_tx, event_rx) = mpsc::channel();
        let client = test_client(event_tx);
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("note.md");
        fs::write(&file_path, "before").unwrap();
        client
            .tool_diffs
            .register_session_cwd("session-1", temp.path().to_path_buf());

        let pending = ToolCall::new(ToolCallId::from("tool-1"), "Write note.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Pending)
            .raw_input(json!({
                "file_path": "note.md",
                "content": "after",
            }));
        run_client_future(Client::session_notification(
            &client,
            SessionNotification::new("session-1", SessionUpdate::ToolCall(pending)),
        ))
        .unwrap();
        let _ = event_rx.recv_timeout(StdDuration::from_millis(250));

        let completed = ToolCallUpdate::new(
            "tool-1",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::from("File updated")]),
        );
        run_client_future(Client::session_notification(
            &client,
            SessionNotification::new("session-1", SessionUpdate::ToolCallUpdate(completed)),
        ))
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("completion tool activity event");
        let RpcOutput::Event { payload, .. } = event else {
            panic!("expected event");
        };
        let diff = payload
            .get("diffs")
            .and_then(Value::as_array)
            .and_then(|diffs| diffs.first())
            .expect("diff payload");
        assert_eq!(diff.get("old_text").and_then(Value::as_str), Some("before"));
        assert_eq!(diff.get("new_text").and_then(Value::as_str), Some("after"));
    }

    #[test]
    fn tool_activity_uses_content_summary_when_no_diffs_exist() {
        let payload = map_tool_call(
            "session-1",
            &ToolCall::new(ToolCallId::from("tool-1"), "Read README.md")
                .kind(ToolKind::Read)
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::from("README.md")]),
            None,
            vec![],
        );

        assert_eq!(payload.summary.as_deref(), Some("README.md"));
        assert!(payload.diffs.is_none());
    }

    #[test]
    fn session_tool_call_terminal_meta_updates_summary() {
        let (event_tx, event_rx) = mpsc::channel();
        let client = test_client(event_tx);

        let started = ToolCall::new(ToolCallId::from("tool-1"), "Run tests")
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::InProgress);
        run_client_future(Client::session_notification(
            &client,
            SessionNotification::new("session-1", SessionUpdate::ToolCall(started)),
        ))
        .unwrap();
        let _ = event_rx.recv_timeout(StdDuration::from_millis(250));

        let update =
            ToolCallUpdate::new("tool-1", ToolCallUpdateFields::new()).meta(Meta::from_iter([(
                "terminal_output".to_string(),
                json!({ "data": "running tests\n" }),
            )]));
        run_client_future(Client::session_notification(
            &client,
            SessionNotification::new("session-1", SessionUpdate::ToolCallUpdate(update)),
        ))
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("tool activity event");
        let RpcOutput::Event { payload, .. } = event else {
            panic!("expected event");
        };
        assert_eq!(
            payload.get("summary").and_then(Value::as_str),
            Some("running tests\n")
        );
    }

    #[test]
    fn session_tool_call_status_meta_emits_status_event() {
        let (event_tx, event_rx) = mpsc::channel();
        let client = test_client(event_tx);

        let tool_call = ToolCall::new(ToolCallId::from("neverwrite:status:1"), "Review mode")
            .kind(ToolKind::Other)
            .status(ToolCallStatus::Completed)
            .meta(Meta::from_iter([
                (ACP_STATUS_EVENT_TYPE_KEY.to_string(), json!("status")),
                (ACP_STATUS_KIND_KEY.to_string(), json!("review_mode")),
                (ACP_STATUS_EMPHASIS_KEY.to_string(), json!("info")),
            ]));

        run_client_future(Client::session_notification(
            &client,
            SessionNotification::new("session-1", SessionUpdate::ToolCall(tool_call)),
        ))
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("status event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };

        assert_eq!(event_name, AI_STATUS_EVENT);
        assert_eq!(
            payload.get("kind").and_then(Value::as_str),
            Some("review_mode")
        );
    }

    #[test]
    fn permission_request_emits_tool_activity_and_permission_diffs() {
        let (event_tx, event_rx) = mpsc::channel();
        let client = test_client(event_tx);
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("note.md"), "before").unwrap();
        client
            .tool_diffs
            .register_session_cwd("session-1", temp.path().to_path_buf());

        let waiters = client.permission_waiters.clone();
        let event_thread = std::thread::spawn(move || {
            let mut saw_tool_activity_diffs = false;
            let mut saw_permission_diffs = false;
            let mut request_id = None;

            for _ in 0..2 {
                let event = event_rx
                    .recv_timeout(StdDuration::from_secs(1))
                    .expect("permission events");
                let RpcOutput::Event {
                    event_name,
                    payload,
                } = event
                else {
                    continue;
                };

                let has_diffs = payload
                    .get("diffs")
                    .and_then(Value::as_array)
                    .map(|diffs| !diffs.is_empty())
                    .unwrap_or(false);
                if event_name == AI_TOOL_ACTIVITY_EVENT {
                    saw_tool_activity_diffs = has_diffs;
                }
                if event_name == AI_PERMISSION_REQUEST_EVENT {
                    saw_permission_diffs = has_diffs;
                    request_id = payload
                        .get("request_id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string);
                }
            }

            let request_id = request_id.expect("permission request id");
            let sender = waiters
                .lock()
                .unwrap()
                .remove(&request_id)
                .expect("permission waiter");
            sender.send(RequestPermissionOutcome::Cancelled).unwrap();
            (saw_tool_activity_diffs, saw_permission_diffs)
        });

        let request = RequestPermissionRequest::new(
            "session-1",
            ToolCallUpdate::new(
                "tool-1",
                ToolCallUpdateFields::new()
                    .title("Write note.md".to_string())
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::Pending)
                    .raw_input(json!({
                        "file_path": "note.md",
                        "content": "after",
                    })),
            ),
            vec![PermissionOption::new(
                "allow",
                "Allow",
                PermissionOptionKind::AllowOnce,
            )],
        );
        run_client_future(Client::request_permission(&client, request)).unwrap();

        let (saw_tool_activity_diffs, saw_permission_diffs) = event_thread.join().unwrap();
        assert!(saw_tool_activity_diffs);
        assert!(saw_permission_diffs);
    }
}
