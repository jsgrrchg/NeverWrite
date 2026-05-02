use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{self, Sender},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::{
    AuthenticateRequest, CancelNotification, ClientCapabilities, ContentBlock, ContentChunk,
    FileSystemCapabilities, Implementation, InitializeRequest, LogoutRequest, Meta,
    NewSessionRequest, PermissionOption, PermissionOptionKind, PromptRequest, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigSelectOptions, SessionId, SessionModeState, SessionModelState,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest,
    SetSessionModelRequest, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo};
use neverwrite_ai::{
    AiAuthMethod, AiConfigOption, AiConfigOptionCategory, AiConfigSelectOption, AiFileDiffPayload,
    AiImageGenerationPayload, AiMessageCompletedPayload, AiMessageDeltaPayload,
    AiMessageStartedPayload, AiModeOption, AiModelOption, AiPermissionOptionPayload,
    AiPermissionRequestPayload, AiRuntimeBinarySource, AiRuntimeConnectionPayload,
    AiRuntimeDescriptor, AiRuntimeOption, AiRuntimeSetupStatus, AiSession, AiSessionErrorPayload,
    AiSessionStatus, AiStatusEventPayload, AiTokenUsageCostPayload, AiTokenUsagePayload,
    AiToolActivityActionPayload, AiToolActivityPayload, ToolDiffState,
    AI_AUTH_TERMINAL_ERROR_EVENT, AI_AUTH_TERMINAL_EXITED_EVENT, AI_AUTH_TERMINAL_OUTPUT_EVENT,
    AI_AUTH_TERMINAL_STARTED_EVENT, AI_IMAGE_GENERATION_EVENT, AI_MESSAGE_COMPLETED_EVENT,
    AI_MESSAGE_DELTA_EVENT, AI_MESSAGE_STARTED_EVENT, AI_PERMISSION_REQUEST_EVENT,
    AI_RUNTIME_CONNECTION_EVENT, AI_SESSION_CREATED_EVENT, AI_SESSION_ERROR_EVENT,
    AI_SESSION_UPDATED_EVENT, AI_STATUS_EVENT, AI_THINKING_COMPLETED_EVENT,
    AI_THINKING_DELTA_EVENT, AI_THINKING_STARTED_EVENT, AI_TOKEN_USAGE_EVENT,
    AI_TOOL_ACTIVITY_EVENT, CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, GEMINI_RUNTIME_ID,
    KILO_RUNTIME_ID,
};
use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{process::Command, runtime::Builder, sync::oneshot};
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
const ACP_IMAGE_GENERATION_EVENT_TYPE: &str = "image_generation";
const CODEX_ACP_EVENT_TYPE_KEY: &str = "codexAcpEventType";
const CODEX_ACP_PARENT_SESSION_ID_KEY: &str = "codexAcpParentSessionId";
const CODEX_ACP_CHILD_SESSION_ID_KEY: &str = "codexAcpChildSessionId";
const CODEX_ACP_AGENT_NICKNAME_KEY: &str = "codexAcpAgentNickname";
const CODEX_ACP_MODEL_KEY: &str = "codexAcpModel";
const CODEX_ACP_REASONING_EFFORT_KEY: &str = "codexAcpReasoningEffort";
const CODEX_ACP_CWD_KEY: &str = "codexAcpCwd";
const CODEX_ACP_SUBAGENT_CREATED_EVENT_TYPE: &str = "subagent_session_created";
const CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE: &str = "subagent_breadcrumb";
const CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY: &str = "codexAcpSubagentEventType";
const CODEX_ACP_SUBAGENT_CLOSE_END_EVENT_TYPE: &str = "close_end";
const CODEX_ACP_SUBAGENT_INTERACTION_END_EVENT_TYPE: &str = "interaction_end";
const CODEX_ACP_SUBAGENT_RESUME_END_EVENT_TYPE: &str = "resume_end";
const CODEX_ACP_SUBAGENT_WAITING_END_EVENT_TYPE: &str = "waiting_end";
const AUTH_TERMINAL_DEFAULT_COLS: u16 = 100;
const AUTH_TERMINAL_DEFAULT_ROWS: u16 = 28;
const AUTH_TERMINAL_MONITOR_INTERVAL: Duration = Duration::from_millis(120);
const AUTH_TERMINAL_OUTPUT_CHUNK_SIZE: usize = 4096;
const ACP_SESSION_START_TIMEOUT: Duration = Duration::from_secs(15);

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
    #[serde(default)]
    anthropic_api_key: Option<AiSecretPatch>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiAuthTerminalStartInput {
    runtime_id: String,
    method_id: Option<String>,
    vault_path: Option<String>,
    custom_binary_path: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiAuthTerminalWriteInput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiAuthTerminalResizeInput {
    session_id: String,
    cols: u16,
    rows: u16,
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
    suppress_persisted_auth: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AiAuthTerminalStatus {
    Starting,
    Running,
    Exited,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiAuthTerminalSessionSnapshot {
    session_id: String,
    runtime_id: String,
    program: String,
    display_name: String,
    cwd: String,
    cols: u16,
    rows: u16,
    buffer: String,
    status: AiAuthTerminalStatus,
    exit_code: Option<i32>,
    error_message: Option<String>,
}

#[derive(Debug, Clone)]
struct AuthTerminalLaunchConfig {
    program: PathBuf,
    args: Vec<String>,
    display_name: String,
    cwd: PathBuf,
    env: HashMap<String, String>,
    runtime_id: String,
    method_id: String,
}

struct AuthTerminalHandle {
    snapshot: Arc<Mutex<AiAuthTerminalSessionSnapshot>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    closed: Arc<AtomicBool>,
}

impl AuthTerminalHandle {
    fn snapshot(&self) -> Result<AiAuthTerminalSessionSnapshot, String> {
        self.snapshot
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))
            .map(|snapshot| snapshot.clone())
    }

    fn release_runtime_resources(&self, terminate_process: bool) {
        release_auth_terminal_runtime_resources(
            &self.master,
            &self.writer,
            &self.child,
            &self.killer,
            terminate_process,
        );
    }
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
        response_tx: mpsc::Sender<Result<Vec<SessionConfigOption>, String>>,
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
    auth_terminal_sessions: Arc<Mutex<HashMap<String, AuthTerminalHandle>>>,
    auth_terminal_counter: Arc<AtomicU64>,
}

impl NativeAi {
    pub(crate) fn new(event_tx: Sender<RpcOutput>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NativeAiInner::default())),
            event_tx,
            tool_diffs: ToolDiffState::default(),
            agent_writes: AgentWriteTracker::default(),
            auth_terminal_sessions: Arc::new(Mutex::new(HashMap::new())),
            auth_terminal_counter: Arc::new(AtomicU64::new(1)),
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
        update_auth_state(setup, &runtime_id, input)?;
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
        let cwd = resolve_auth_terminal_cwd(args.get("vaultPath").and_then(Value::as_str))?;

        if runtime_id == CODEX_RUNTIME_ID && method_id == "chatgpt" {
            let setup = self
                .inner
                .lock()
                .map_err(|error| format!("Internal AI state error: {error}"))?
                .setup
                .get(&runtime_id)
                .cloned()
                .unwrap_or_default();
            let spec = acp_process_spec(&runtime_id, &setup, cwd)?;
            run_acp_auth(spec, method_id.clone())?;

            let mut state = self
                .inner
                .lock()
                .map_err(|error| format!("Internal AI state error: {error}"))?;
            let setup = state.setup.entry(runtime_id.clone()).or_default();
            setup.auth_method = Some(method_id.clone());
            setup.auth_ready = true;
            setup.message = None;
            return Ok(json!(setup_status_for(&runtime_id, setup.clone())?));
        }

        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let setup = state.setup.entry(runtime_id.clone()).or_default();
        setup.auth_method = Some(method_id.clone());
        setup.auth_ready = auth_method_has_local_config(setup, &method_id);
        setup.message = if setup.auth_ready {
            None
        } else {
            Some(ELECTRON_AI_INTERACTIVE_AUTH_UNAVAILABLE.to_string())
        };
        Ok(json!(setup_status_for(&runtime_id, setup.clone())?))
    }

    pub(crate) fn logout(&self, args: &Value) -> Result<Value, String> {
        let runtime_id = required_runtime_id(args)?;
        validate_runtime_id(&runtime_id)?;
        let cwd = resolve_auth_terminal_cwd(args.get("vaultPath").and_then(Value::as_str))?;

        let setup = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?
            .setup
            .get(&runtime_id)
            .cloned()
            .unwrap_or_default();

        if runtime_id == CODEX_RUNTIME_ID && setup.auth_method.as_deref() == Some("chatgpt") {
            let spec = acp_process_spec(&runtime_id, &setup, cwd)?;
            run_acp_logout(spec)?;
        }

        let mut state = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let setup = state.setup.entry(runtime_id.clone()).or_default();
        clear_runtime_auth_state(setup);
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
            Arc::clone(&self.inner),
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
        let config_options = self
            .session_handle(&input.session_id)?
            .map(|handle| {
                handle.set_config_option(&input.session_id, &input.option_id, &input.value)
            })
            .transpose()?;
        self.update_session(&input.session_id, |session| {
            if let Some(config_options) = config_options {
                let mapped_options =
                    map_session_config_options(&session.runtime_id, config_options);
                apply_config_options_to_session(session, mapped_options);
                return Ok(());
            }

            apply_local_config_option_selection(session, &input.option_id, input.value)
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

    pub(crate) fn start_auth_terminal_session(&self, args: &Value) -> Result<Value, String> {
        let input: AiAuthTerminalStartInput = input_from_args(args)?;
        validate_runtime_id(&input.runtime_id)?;

        let mut setup = self
            .inner
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?
            .setup
            .get(&input.runtime_id)
            .cloned()
            .unwrap_or_default();
        if let Some(custom_binary_path) =
            input.custom_binary_path.and_then(normalize_optional_string)
        {
            setup.custom_binary_path = Some(custom_binary_path);
        }

        let session_id = format!(
            "authterm-{}",
            self.auth_terminal_counter.fetch_add(1, Ordering::Relaxed)
        );
        let method_id = input
            .method_id
            .and_then(normalize_optional_string)
            .unwrap_or_else(|| default_terminal_auth_method(&input.runtime_id).to_string());
        let cwd = resolve_auth_terminal_cwd(input.vault_path.as_deref())?;
        let launch_config =
            auth_terminal_launch_config(&input.runtime_id, &method_id, &setup, cwd)?;
        mark_runtime_auth_pending(&self.inner, &input.runtime_id, &method_id);
        let snapshot = self.spawn_auth_terminal_session(
            session_id,
            launch_config,
            input.cols.unwrap_or(AUTH_TERMINAL_DEFAULT_COLS),
            input.rows.unwrap_or(AUTH_TERMINAL_DEFAULT_ROWS),
        )?;
        Ok(json!(snapshot))
    }

    pub(crate) fn write_auth_terminal_session(&self, args: &Value) -> Result<Value, String> {
        let input: AiAuthTerminalWriteInput = input_from_args(args)?;
        let (writer, snapshot) = {
            let sessions = self
                .auth_terminal_sessions
                .lock()
                .map_err(|error| format!("Internal auth terminal state error: {error}"))?;
            let session = sessions
                .get(&input.session_id)
                .ok_or_else(|| format!("Auth terminal session not found: {}", input.session_id))?;
            (Arc::clone(&session.writer), Arc::clone(&session.snapshot))
        };

        let mut writer_guard = writer
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?;
        let writer = if let Some(writer) = writer_guard.as_mut() {
            writer
        } else {
            let status = snapshot
                .lock()
                .map(|snapshot| snapshot.status.clone())
                .unwrap_or(AiAuthTerminalStatus::Error);
            return Err(match status {
                AiAuthTerminalStatus::Exited => {
                    "Auth terminal session has already exited".to_string()
                }
                AiAuthTerminalStatus::Error => {
                    "Auth terminal session is no longer available".to_string()
                }
                _ => "Auth terminal writer is not available".to_string(),
            });
        };
        writer
            .write_all(input.data.as_bytes())
            .map_err(|error| format!("Failed to write to auth terminal: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush auth terminal input: {error}"))?;
        Ok(json!(null))
    }

    pub(crate) fn resize_auth_terminal_session(&self, args: &Value) -> Result<Value, String> {
        let input: AiAuthTerminalResizeInput = input_from_args(args)?;
        let (snapshot, master) = {
            let sessions = self
                .auth_terminal_sessions
                .lock()
                .map_err(|error| format!("Internal auth terminal state error: {error}"))?;
            let session = sessions
                .get(&input.session_id)
                .ok_or_else(|| format!("Auth terminal session not found: {}", input.session_id))?;
            (Arc::clone(&session.snapshot), Arc::clone(&session.master))
        };

        let cols = input.cols.max(1);
        let rows = input.rows.max(1);
        let master_guard = master
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?;
        if let Some(master) = master_guard.as_ref() {
            master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("Failed to resize auth terminal PTY: {error}"))?;
        }

        let mut snapshot = snapshot
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?;
        snapshot.cols = cols;
        snapshot.rows = rows;
        Ok(json!(snapshot.clone()))
    }

    pub(crate) fn close_auth_terminal_session(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let handle = self
            .auth_terminal_sessions
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?
            .remove(&session_id);
        if let Some(handle) = handle {
            handle.closed.store(true, Ordering::Relaxed);
            handle.release_runtime_resources(true);
        }
        Ok(json!(null))
    }

    pub(crate) fn get_auth_terminal_session_snapshot(&self, args: &Value) -> Result<Value, String> {
        let session_id = required_string(args, &["sessionId", "session_id"])?;
        let sessions = self
            .auth_terminal_sessions
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?;
        Ok(json!(sessions
            .get(&session_id)
            .ok_or_else(|| format!("Auth terminal session not found: {session_id}"))?
            .snapshot()?))
    }

    fn spawn_auth_terminal_session(
        &self,
        session_id: String,
        launch_config: AuthTerminalLaunchConfig,
        cols: u16,
        rows: u16,
    ) -> Result<AiAuthTerminalSessionSnapshot, String> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Failed to create auth terminal PTY: {error}"))?;

        let master = Arc::new(Mutex::new(Some(pair.master)));
        let mut command = CommandBuilder::new(&launch_config.program);
        command.args(&launch_config.args);
        command.cwd(&launch_config.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLUMNS", cols.to_string());
        command.env("LINES", rows.to_string());
        for (key, value) in &launch_config.env {
            command.env(key, value);
        }

        let child = pair.slave.spawn_command(command).map_err(|error| {
            format!(
                "Failed to start {} sign-in terminal: {error}",
                launch_config.display_name
            )
        })?;
        let killer = child.clone_killer();
        let writer = master
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?
            .as_ref()
            .ok_or_else(|| "Auth terminal PTY is not available".to_string())?
            .take_writer()
            .map_err(|error| format!("Failed to open auth terminal writer: {error}"))?;
        let reader = master
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?
            .as_ref()
            .ok_or_else(|| "Auth terminal PTY is not available".to_string())?
            .try_clone_reader()
            .map_err(|error| format!("Failed to open auth terminal reader: {error}"))?;

        let snapshot = Arc::new(Mutex::new(AiAuthTerminalSessionSnapshot {
            session_id: session_id.clone(),
            runtime_id: launch_config.runtime_id.clone(),
            program: launch_config.program.display().to_string(),
            display_name: launch_config.display_name,
            cwd: launch_config.cwd.to_string_lossy().into_owned(),
            cols,
            rows,
            buffer: String::new(),
            status: AiAuthTerminalStatus::Running,
            exit_code: None,
            error_message: None,
        }));

        let handle = AuthTerminalHandle {
            snapshot: Arc::clone(&snapshot),
            master: Arc::clone(&master),
            writer: Arc::new(Mutex::new(Some(writer))),
            child: Arc::new(Mutex::new(Some(child))),
            killer: Arc::new(Mutex::new(Some(killer))),
            closed: Arc::new(AtomicBool::new(false)),
        };

        spawn_auth_terminal_output_reader(
            reader,
            Arc::clone(&handle.snapshot),
            Arc::clone(&handle.closed),
            Arc::clone(&self.inner),
            launch_config.runtime_id.clone(),
            launch_config.method_id.clone(),
            self.event_tx.clone(),
        );
        spawn_auth_terminal_exit_monitor(
            Arc::clone(&handle.master),
            Arc::clone(&handle.writer),
            Arc::clone(&handle.child),
            Arc::clone(&handle.killer),
            Arc::clone(&handle.snapshot),
            Arc::clone(&handle.closed),
            Arc::clone(&self.inner),
            launch_config.runtime_id.clone(),
            launch_config.method_id.clone(),
            self.event_tx.clone(),
        );

        let created_snapshot = handle.snapshot()?;
        emit_auth_terminal_started(&self.event_tx, &created_snapshot);

        self.auth_terminal_sessions
            .lock()
            .map_err(|error| format!("Internal auth terminal state error: {error}"))?
            .insert(session_id, handle);

        Ok(created_snapshot)
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
    fn request<T>(
        &self,
        build: impl FnOnce(mpsc::Sender<Result<T, String>>) -> AcpCommand,
    ) -> Result<T, String> {
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
    ) -> Result<Vec<SessionConfigOption>, String> {
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
    session_state: Arc<Mutex<NativeAiInner>>,
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

    fn emit_session_update_from_result(&self, result: Result<Option<AiSession>, String>) {
        match result {
            Ok(Some(session)) => self.emit(AI_SESSION_UPDATED_EVENT, session),
            Ok(None) => {}
            Err(message) => self.emit(
                AI_SESSION_ERROR_EVENT,
                AiSessionErrorPayload {
                    session_id: None,
                    message,
                },
            ),
        }
    }

    fn apply_config_options_update(
        &self,
        session_id: &str,
        config_options: Vec<SessionConfigOption>,
    ) -> Result<Option<AiSession>, String> {
        let mut state = self
            .session_state
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let Some(managed) = state.sessions.get_mut(session_id) else {
            return Ok(None);
        };
        let mapped_options =
            map_session_config_options(&managed.session.runtime_id, config_options);
        apply_config_options_to_session(&mut managed.session, mapped_options);
        let session = managed.session.clone();
        touch_session(&mut state, session_id);
        Ok(Some(session))
    }

    fn apply_current_mode_update(
        &self,
        session_id: &str,
        mode_id: String,
    ) -> Result<Option<AiSession>, String> {
        let mut state = self
            .session_state
            .lock()
            .map_err(|error| format!("Internal AI state error: {error}"))?;
        let Some(managed) = state.sessions.get_mut(session_id) else {
            return Ok(None);
        };
        apply_mode_update_to_session(&mut managed.session, &mode_id);
        let session = managed.session.clone();
        touch_session(&mut state, session_id);
        Ok(Some(session))
    }

    fn emit_tool_activity(&self, session_id: &str, tool_call: &ToolCall) {
        if let Some(payload) = map_image_generation_event(session_id, tool_call) {
            self.emit(AI_IMAGE_GENERATION_EVENT, payload);
            return;
        }

        if let Some(payload) = map_legacy_image_generation_status_event(session_id, tool_call) {
            self.emit(AI_IMAGE_GENERATION_EVENT, payload);
            return;
        }

        let action = self.subagent_open_session_action(session_id, tool_call);

        if let Some(payload) = map_status_event(session_id, tool_call, action.clone()) {
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
                action,
                self.terminal_summary(session_id, &tool_call.tool_call_id.0),
                diffs,
            ),
        );
    }

    fn subagent_open_session_action(
        &self,
        session_id: &str,
        tool_call: &ToolCall,
    ) -> Option<AiToolActivityActionPayload> {
        let meta = tool_call.meta.as_ref()?;
        let event_type = meta_string(meta, CODEX_ACP_EVENT_TYPE_KEY)?;
        if event_type != CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE {
            return None;
        }

        let runtime_child_session_id = meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY)?;
        let child_session_id = self
            .find_app_session_id(&runtime_child_session_id)
            .or_else(|| {
                self.create_subagent_session_from_meta(&runtime_child_session_id, Some(meta))
                    .map(|session| session.session_id)
            })
            .unwrap_or(runtime_child_session_id);
        if child_session_id == session_id {
            return None;
        }

        Some(AiToolActivityActionPayload {
            kind: "open_session".to_string(),
            session_id: child_session_id,
            label: None,
        })
    }

    fn record_terminal_meta(&self, session_id: &str, tool_call_id: &str, meta: Option<&Meta>) {
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

    fn mark_session_idle(&self, session_id: &str) {
        self.end_thinking(session_id);
        self.end_message(session_id);

        let session = self.session_state.lock().ok().and_then(|mut state| {
            let managed = state.sessions.get_mut(session_id)?;
            managed.session.status = AiSessionStatus::Idle;
            Some(managed.session.clone())
        });
        if let Some(session) = session {
            self.emit(AI_SESSION_UPDATED_EVENT, session);
        }
    }

    fn resolve_app_session_id(&self, runtime_session_id: &str, meta: Option<&Meta>) -> String {
        if let Some(session_id) = self.find_app_session_id(runtime_session_id) {
            return session_id;
        }

        self.create_subagent_session_from_meta(runtime_session_id, meta)
            .map(|session| session.session_id)
            .unwrap_or_else(|| runtime_session_id.to_string())
    }

    fn find_app_session_id(&self, runtime_session_id: &str) -> Option<String> {
        self.session_state
            .lock()
            .ok()?
            .sessions
            .values()
            .find(|managed| {
                managed.session.session_id == runtime_session_id
                    || managed.session.runtime_session_id.as_deref() == Some(runtime_session_id)
            })
            .map(|managed| managed.session.session_id.clone())
    }

    fn create_subagent_session_from_meta(
        &self,
        runtime_session_id: &str,
        meta: Option<&Meta>,
    ) -> Option<AiSession> {
        let meta = meta?;
        let event_type = meta_string(meta, CODEX_ACP_EVENT_TYPE_KEY)?;
        if event_type != CODEX_ACP_SUBAGENT_CREATED_EVENT_TYPE {
            return None;
        }

        let runtime_child_session_id = meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY)
            .unwrap_or_else(|| runtime_session_id.to_string());
        let runtime_parent_session_id = meta_string(meta, CODEX_ACP_PARENT_SESSION_ID_KEY)?;
        let cwd = meta_string(meta, CODEX_ACP_CWD_KEY).map(PathBuf::from);
        let model_id = meta_string(meta, CODEX_ACP_MODEL_KEY);
        let reasoning_effort = meta_string(meta, CODEX_ACP_REASONING_EFFORT_KEY);
        let title =
            meta_string(meta, CODEX_ACP_AGENT_NICKNAME_KEY).or_else(|| meta_string(meta, "title"));

        let mut state = self.session_state.lock().ok()?;
        if let Some(existing) = state.sessions.values().find(|managed| {
            managed.session.session_id == runtime_child_session_id
                || managed.session.runtime_session_id.as_deref()
                    == Some(runtime_child_session_id.as_str())
        }) {
            return Some(existing.session.clone());
        }

        let parent = state
            .sessions
            .values()
            .find(|managed| {
                managed.session.session_id == runtime_parent_session_id
                    || managed.session.runtime_session_id.as_deref()
                        == Some(runtime_parent_session_id.as_str())
            })?
            .clone();

        let mut session = parent.session.clone();
        session.session_id = runtime_child_session_id.clone();
        session.parent_session_id = Some(parent.session.session_id.clone());
        session.runtime_session_id = Some(runtime_child_session_id.clone());
        session.title = title;
        session.status = AiSessionStatus::Idle;

        if let Some(model_id) = model_id.as_deref() {
            let base_model_id = strip_effort_suffix(model_id).to_string();
            session.model_id = base_model_id.clone();
            if let Some(option) = session
                .config_options
                .iter_mut()
                .find(|option| option.id == "model")
            {
                option.value = base_model_id;
            }
        }

        if let Some(reasoning_effort) = reasoning_effort {
            if let Some(option) = session
                .config_options
                .iter_mut()
                .find(|option| option.id == "reasoning_effort")
            {
                option.value = reasoning_effort;
            }
        }

        let register_cwd = cwd.or_else(|| parent.vault_root.clone());
        state.sessions.insert(
            session.session_id.clone(),
            ManagedAiSession {
                session: session.clone(),
                vault_root: parent.vault_root,
                additional_roots: parent.additional_roots,
                runtime_handle: parent.runtime_handle,
            },
        );
        touch_session(&mut state, &session.session_id);
        drop(state);

        if let Some(cwd) = register_cwd {
            self.tool_diffs
                .register_session_cwd(&session.session_id, cwd);
        }
        self.emit(AI_SESSION_CREATED_EVENT, &session);
        Some(session)
    }

    fn handle_subagent_lifecycle_breadcrumb(&self, parent_session_id: &str, meta: Option<&Meta>) {
        let Some(meta) = meta else {
            return;
        };
        if meta_string(meta, CODEX_ACP_EVENT_TYPE_KEY).as_deref()
            != Some(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE)
        {
            return;
        }

        let child_session_ids =
            self.child_session_ids_for_terminal_subagent_breadcrumb(parent_session_id, meta);
        for child_session_id in child_session_ids {
            if child_session_id != parent_session_id {
                self.mark_session_idle(&child_session_id);
            }
        }
    }

    fn child_session_ids_for_terminal_subagent_breadcrumb(
        &self,
        parent_session_id: &str,
        meta: &Meta,
    ) -> Vec<String> {
        let Some(subagent_event_type) = meta_string(meta, CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY) else {
            return vec![];
        };

        let closes_single_child = matches!(
            subagent_event_type.as_str(),
            CODEX_ACP_SUBAGENT_CLOSE_END_EVENT_TYPE
                | CODEX_ACP_SUBAGENT_INTERACTION_END_EVENT_TYPE
                | CODEX_ACP_SUBAGENT_RESUME_END_EVENT_TYPE
        );
        if closes_single_child {
            return meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY)
                .and_then(|runtime_child_session_id| {
                    self.find_app_session_id(&runtime_child_session_id)
                })
                .into_iter()
                .collect();
        }

        if subagent_event_type != CODEX_ACP_SUBAGENT_WAITING_END_EVENT_TYPE {
            return vec![];
        }

        if let Some(runtime_child_session_id) = meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY) {
            return self
                .find_app_session_id(&runtime_child_session_id)
                .into_iter()
                .collect();
        }

        self.session_state
            .lock()
            .ok()
            .map(|state| {
                state
                    .sessions
                    .values()
                    .filter(|managed| {
                        managed.session.parent_session_id.as_deref() == Some(parent_session_id)
                    })
                    .map(|managed| managed.session.session_id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> agent_client_protocol::Result<RequestPermissionResponse> {
        let runtime_session_id = args.session_id.0.to_string();
        let session_id =
            self.resolve_app_session_id(&runtime_session_id, args.tool_call.meta.as_ref());
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
                self.subagent_open_session_action(&session_id, &registered),
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
        let runtime_session_id = args.session_id.0.to_string();
        let meta = merged_session_notification_meta(&args);
        let session_id = self.resolve_app_session_id(&runtime_session_id, meta.as_ref());
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
                let tool_call = tool_call_with_merged_meta(tool_call, meta.as_ref());
                self.record_terminal_meta(
                    &session_id,
                    &tool_call.tool_call_id.0,
                    tool_call.meta.as_ref(),
                );
                let tool_call = self.tool_diffs.upsert_tool_call(&session_id, tool_call);
                self.emit_tool_activity(&session_id, &tool_call);
                self.handle_subagent_lifecycle_breadcrumb(&session_id, meta.as_ref());
            }
            SessionUpdate::ToolCallUpdate(update) => {
                let update = tool_call_update_with_merged_meta(update, meta.as_ref());
                self.record_terminal_meta(
                    &session_id,
                    &update.tool_call_id.0,
                    update.meta.as_ref(),
                );
                if let Some(tool_call) = self.tool_diffs.apply_tool_update(&session_id, update) {
                    self.emit_tool_activity(&session_id, &tool_call);
                }
                self.handle_subagent_lifecycle_breadcrumb(&session_id, meta.as_ref());
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
            SessionUpdate::ConfigOptionUpdate(update) => {
                let result = self.apply_config_options_update(&session_id, update.config_options);
                self.emit_session_update_from_result(result);
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                let result = self
                    .apply_current_mode_update(&session_id, update.current_mode_id.0.to_string());
                self.emit_session_update_from_result(result);
            }
            _ => {}
        }
        Ok(())
    }
}

fn start_acp_session(
    spec: AcpProcessSpec,
    event_tx: Sender<RpcOutput>,
    session_state: Arc<Mutex<NativeAiInner>>,
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
        runtime.block_on(async move {
            run_acp_actor(
                spec,
                event_tx,
                session_state,
                tool_diffs,
                agent_writes,
                command_rx,
                created_tx,
            )
            .await;
        });
    });
    let session = created_rx
        .recv_timeout(ACP_SESSION_START_TIMEOUT)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => format!(
                "Timed out waiting for the AI runtime to create a session after {} seconds.",
                ACP_SESSION_START_TIMEOUT.as_secs()
            ),
            mpsc::RecvTimeoutError::Disconnected => {
                "AI runtime session startup disconnected before responding.".to_string()
            }
        })??;
    Ok(CreatedAcpSession { session, handle })
}

fn run_acp_auth(spec: AcpProcessSpec, method_id: String) -> Result<(), String> {
    run_acp_auth_command(spec, AcpAuthCommand::Authenticate(method_id))
}

fn run_acp_logout(spec: AcpProcessSpec) -> Result<(), String> {
    run_acp_auth_command(spec, AcpAuthCommand::Logout)
}

#[derive(Debug, Clone)]
enum AcpAuthCommand {
    Authenticate(String),
    Logout,
}

fn run_acp_auth_command(spec: AcpProcessSpec, auth_command: AcpAuthCommand) -> Result<(), String> {
    let (result_tx, result_rx) = mpsc::channel();
    thread::spawn(move || {
        let runtime = match Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = result_tx.send(Err(format!("Failed to start ACP runtime: {error}")));
                return;
            }
        };
        let result = runtime.block_on(run_acp_auth_inner(spec, auth_command));
        let _ = result_tx.send(result);
    });

    result_rx
        .recv()
        .map_err(|_| "AI runtime authentication disconnected before responding.".to_string())?
}

async fn run_acp_auth_inner(
    spec: AcpProcessSpec,
    auth_command: AcpAuthCommand,
) -> Result<(), String> {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    command.current_dir(&spec.cwd);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());
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
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());

    let result = Client
        .builder()
        .name("neverwrite")
        .connect_with(transport, async move |connection: ConnectionTo<Agent>| {
            let auth_result = tokio::select! {
                response = async {
                    connection
                        .send_request(
                            InitializeRequest::new(ProtocolVersion::LATEST)
                                .client_capabilities(
                                    ClientCapabilities::new().fs(FileSystemCapabilities::new()),
                                )
                                .client_info(
                                    Implementation::new("neverwrite", env!("CARGO_PKG_VERSION"))
                                        .title("NeverWrite"),
                                ),
                        )
                        .block_task()
                        .await?;
                    match auth_command {
                        AcpAuthCommand::Authenticate(method_id) => {
                            connection
                                .send_request(AuthenticateRequest::new(method_id))
                                .block_task()
                                .await?;
                        }
                        AcpAuthCommand::Logout => {
                            connection
                                .send_request(LogoutRequest::new())
                                .block_task()
                                .await?;
                        }
                    }
                    Ok::<(), agent_client_protocol::Error>(())
                } => response,
                wait_result = child.wait() => {
                    let message = wait_result
                        .map(acp_child_exit_message)
                        .unwrap_or_else(|error| {
                            format!("Failed to wait for AI runtime process: {error}")
                        });
                    return Err(agent_client_protocol::Error::internal_error().data(message));
                }
            };

            let _ = child.start_kill();
            let _ = child.wait().await;
            auth_result
        })
        .await;

    result.map_err(|error| error.to_string())
}

async fn run_acp_actor(
    spec: AcpProcessSpec,
    event_tx: Sender<RpcOutput>,
    session_state: Arc<Mutex<NativeAiInner>>,
    tool_diffs: ToolDiffState,
    agent_writes: AgentWriteTracker,
    mut command_rx: tokio::sync::mpsc::UnboundedReceiver<AcpCommand>,
    created_tx: mpsc::Sender<Result<AiSession, String>>,
) {
    let result = run_acp_actor_inner(
        spec,
        event_tx,
        session_state,
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
    session_state: Arc<Mutex<NativeAiInner>>,
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
        session_state,
        message_ids: Arc::new(Mutex::new(HashMap::new())),
        thinking_ids: Arc::new(Mutex::new(HashMap::new())),
        permission_waiters: Arc::new(Mutex::new(HashMap::new())),
        tool_diffs,
        agent_writes,
        terminal_output: Arc::new(Mutex::new(HashMap::new())),
        terminal_exit: Arc::new(Mutex::new(HashMap::new())),
    };
    let permission_waiters = client.permission_waiters.clone();
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());
    let session_created = Arc::new(AtomicBool::new(false));
    let session_created_for_connection = Arc::clone(&session_created);
    let disconnect_runtime_id = spec.runtime_id.clone();
    let event_tx_for_connection = event_tx.clone();

    let result = Client
        .builder()
        .name("neverwrite")
        .on_receive_request(
            {
                let client = client.clone();
                async move |request: RequestPermissionRequest,
                            responder,
                            cx: ConnectionTo<Agent>| {
                    let client = client.clone();
                    cx.spawn(async move {
                        let result = client.request_permission(request).await;
                        responder.respond_with_result(result)?;
                        Ok(())
                    })?;
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            {
                let client = client.clone();
                async move |notification: SessionNotification, _cx: ConnectionTo<Agent>| {
                    client.session_notification(notification).await
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(transport, async move |connection: ConnectionTo<Agent>| {
            let response = tokio::select! {
                response = async {
                    connection
                        .send_request(
                            InitializeRequest::new(ProtocolVersion::LATEST)
                                .client_capabilities(
                                    ClientCapabilities::new().fs(FileSystemCapabilities::new()),
                                )
                                .client_info(
                                    Implementation::new("neverwrite", env!("CARGO_PKG_VERSION"))
                                        .title("NeverWrite"),
                                ),
                        )
                        .block_task()
                        .await?;
                    emit_event(
                        &event_tx_for_connection,
                        AI_RUNTIME_CONNECTION_EVENT,
                        json!(AiRuntimeConnectionPayload {
                            runtime_id: spec.runtime_id.clone(),
                            status: "ready".to_string(),
                            message: None,
                        }),
                    );
                    connection
                        .send_request(NewSessionRequest::new(acp_session_wire_cwd(
                            &spec.runtime_id,
                            &spec.cwd,
                        )))
                        .block_task()
                        .await
                } => response?,
                wait_result = child.wait() => {
                    let message = wait_result
                        .map(acp_child_exit_message)
                        .unwrap_or_else(|error| {
                            format!("Failed to wait for AI runtime process: {error}")
                        });
                    return Err(agent_client_protocol::Error::internal_error().data(message));
                }
            };
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
            session_created_for_connection.store(true, Ordering::Relaxed);
            let _ = created_tx.send(Ok(session));
            loop {
                tokio::select! {
                    maybe_command = command_rx.recv() => {
                        let Some(command) = maybe_command else {
                            return Ok(());
                        };
                        handle_acp_command(command, &connection, &client, &permission_waiters).await;
                    }
                    wait_result = child.wait() => {
                        let message = wait_result
                            .map(acp_child_exit_message)
                            .unwrap_or_else(|error| {
                                format!("Failed to wait for AI runtime process: {error}")
                            });
                        return Err(agent_client_protocol::Error::internal_error().data(message));
                    }
                }
            }
        })
        .await;

    match result {
        Ok(()) => Ok(()),
        Err(error) if session_created.load(Ordering::Relaxed) => {
            emit_event(
                &event_tx,
                AI_RUNTIME_CONNECTION_EVENT,
                json!(AiRuntimeConnectionPayload {
                    runtime_id: disconnect_runtime_id,
                    status: "error".to_string(),
                    message: Some(format!(
                        "The AI runtime process disconnected unexpectedly: {error}"
                    )),
                }),
            );
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

async fn handle_acp_command(
    command: AcpCommand,
    connection: &ConnectionTo<Agent>,
    client: &NativeAcpClient,
    permission_waiters: &Arc<Mutex<HashMap<String, oneshot::Sender<RequestPermissionOutcome>>>>,
) {
    match command {
        AcpCommand::Prompt {
            session_id,
            content,
            response_tx,
        } => {
            let connection = connection.clone();
            let client = client.clone();
            tokio::spawn(async move {
                let message_id = client.begin_message(&session_id);
                let result = connection
                    .send_request(PromptRequest::new(
                        SessionId::new(session_id.clone()),
                        vec![ContentBlock::from(content)],
                    ))
                    .block_task()
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
            });
            let _ = response_tx.send(Ok(()));
        }
        AcpCommand::SetModel {
            session_id,
            model_id,
            response_tx,
        } => {
            let result = connection
                .send_request(SetSessionModelRequest::new(
                    SessionId::new(session_id),
                    model_id,
                ))
                .block_task()
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
                .send_request(SetSessionModeRequest::new(
                    SessionId::new(session_id),
                    mode_id,
                ))
                .block_task()
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
                .send_request(SetSessionConfigOptionRequest::new(
                    SessionId::new(session_id),
                    option_id,
                    value.as_str(),
                ))
                .block_task()
                .await
                .map(|response| response.config_options)
                .map_err(|error| error.to_string());
            let _ = response_tx.send(result);
        }
        AcpCommand::Cancel {
            session_id,
            response_tx,
        } => {
            let result = connection
                .send_notification(CancelNotification::new(SessionId::new(session_id)))
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
    models_state: Option<SessionModelState>,
    modes_state: Option<SessionModeState>,
    config_options: Option<Vec<SessionConfigOption>>,
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
        parent_session_id: None,
        runtime_session_id: None,
        title: None,
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

fn acp_child_exit_message(status: std::process::ExitStatus) -> String {
    if status.success() {
        "The AI runtime process exited.".to_string()
    } else {
        format!("The AI runtime process exited with status {status}.")
    }
}

#[derive(Default)]
struct MappedSessionModels {
    models: Vec<AiModelOption>,
    efforts_by_model: HashMap<String, Vec<String>>,
}

fn map_session_models(runtime_id: &str, state: &SessionModelState) -> MappedSessionModels {
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

fn map_session_modes(runtime_id: &str, state: &SessionModeState) -> Vec<AiModeOption> {
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
    options: Vec<SessionConfigOption>,
) -> Vec<AiConfigOption> {
    options
        .into_iter()
        .filter_map(|option| {
            let select = match option.kind {
                SessionConfigKind::Select(select) => select,
                _ => return None,
            };
            let select_options = match select.options {
                SessionConfigSelectOptions::Ungrouped(options) => options,
                SessionConfigSelectOptions::Grouped(groups) => {
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
    category: Option<&SessionConfigOptionCategory>,
) -> AiConfigOptionCategory {
    let normalized_id = option_id.to_ascii_lowercase();
    if matches!(
        normalized_id.as_str(),
        "reasoning_effort" | "thought_level" | "effort"
    ) {
        return AiConfigOptionCategory::Reasoning;
    }

    match category {
        Some(SessionConfigOptionCategory::Mode) => AiConfigOptionCategory::Mode,
        Some(SessionConfigOptionCategory::Model) => AiConfigOptionCategory::Model,
        Some(SessionConfigOptionCategory::ThoughtLevel) => AiConfigOptionCategory::Reasoning,
        Some(SessionConfigOptionCategory::Other(value))
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
    models_state: Option<&SessionModelState>,
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
    models_state: Option<&SessionModelState>,
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
    modes_state: Option<&SessionModeState>,
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

fn apply_config_options_to_session(session: &mut AiSession, config_options: Vec<AiConfigOption>) {
    if let Some(model_id) = config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Model))
        .map(|option| strip_effort_suffix(&option.value).to_string())
        .filter(|value| !value.trim().is_empty())
    {
        session.model_id = model_id;
    }
    if let Some(mode_id) = config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Mode))
        .map(|option| option.value.clone())
        .filter(|value| !value.trim().is_empty())
    {
        session.mode_id = mode_id;
    }
    session.config_options = config_options;
}

fn apply_mode_update_to_session(session: &mut AiSession, mode_id: &str) {
    session.mode_id = mode_id.to_string();
    if let Some(option) = session
        .config_options
        .iter_mut()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Mode))
    {
        option.value = mode_id.to_string();
    }
}

fn apply_local_config_option_selection(
    session: &mut AiSession,
    option_id: &str,
    value: String,
) -> Result<(), String> {
    if option_id == "model" {
        session.model_id = strip_effort_suffix(&value).to_string();
    }
    if option_id == "mode" {
        session.mode_id = value.clone();
    }
    let option = session
        .config_options
        .iter_mut()
        .find(|option| option.id == option_id)
        .ok_or_else(|| format!("AI config option not found: {option_id}"))?;
    option.value = value;
    Ok(())
}

fn map_permission_option(option: PermissionOption) -> AiPermissionOptionPayload {
    AiPermissionOptionPayload {
        option_id: option.option_id.0.to_string(),
        name: option.name,
        kind: match option.kind {
            PermissionOptionKind::AllowOnce => "allow_once".to_string(),
            PermissionOptionKind::AllowAlways => "allow_always".to_string(),
            PermissionOptionKind::RejectOnce => "reject_once".to_string(),
            PermissionOptionKind::RejectAlways => "reject_always".to_string(),
            _ => "other".to_string(),
        },
    }
}

fn map_tool_call(
    session_id: &str,
    tool_call: &ToolCall,
    action: Option<AiToolActivityActionPayload>,
    summary: Option<String>,
    diffs: Vec<AiFileDiffPayload>,
) -> AiToolActivityPayload {
    AiToolActivityPayload {
        session_id: session_id.to_string(),
        tool_call_id: tool_call.tool_call_id.0.to_string(),
        title: tool_call.title.clone(),
        kind: tool_kind_label(&tool_call.kind),
        status: tool_status_label(&tool_call.status),
        action,
        target: tool_call
            .locations
            .first()
            .map(|location| location.path.display().to_string()),
        summary: summary.or_else(|| summarize_tool_content(tool_call)),
        diffs: (!diffs.is_empty()).then_some(diffs),
    }
}

fn merged_session_notification_meta(args: &SessionNotification) -> Option<Meta> {
    let mut merged = args.meta.clone().unwrap_or_default();
    if let Some(update_meta) = session_update_meta(&args.update) {
        for (key, value) in update_meta {
            merged.insert(key.clone(), value.clone());
        }
    }

    (!merged.is_empty()).then_some(merged)
}

fn session_update_meta(update: &SessionUpdate) -> Option<&Meta> {
    match update {
        SessionUpdate::UserMessageChunk(chunk)
        | SessionUpdate::AgentMessageChunk(chunk)
        | SessionUpdate::AgentThoughtChunk(chunk) => chunk.meta.as_ref(),
        SessionUpdate::ToolCall(tool_call) => tool_call.meta.as_ref(),
        SessionUpdate::ToolCallUpdate(update) => update.meta.as_ref(),
        SessionUpdate::CurrentModeUpdate(update) => update.meta.as_ref(),
        SessionUpdate::ConfigOptionUpdate(update) => update.meta.as_ref(),
        SessionUpdate::SessionInfoUpdate(update) => update.meta.as_ref(),
        _ => None,
    }
}

fn tool_call_with_merged_meta(mut tool_call: ToolCall, meta: Option<&Meta>) -> ToolCall {
    if let Some(meta) = meta {
        tool_call.meta = Some(meta.clone());
    }
    tool_call
}

fn tool_call_update_with_merged_meta(
    mut update: ToolCallUpdate,
    meta: Option<&Meta>,
) -> ToolCallUpdate {
    if let Some(meta) = meta {
        update.meta = Some(meta.clone());
    }
    update
}

fn meta_string(meta: &Meta, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn acp_event_type(meta: &Meta) -> Option<&str> {
    meta.get(ACP_STATUS_EVENT_TYPE_KEY)
        .or_else(|| meta.get(CODEX_ACP_EVENT_TYPE_KEY))
        .and_then(Value::as_str)
}

fn map_image_generation_event(
    session_id: &str,
    tool_call: &ToolCall,
) -> Option<AiImageGenerationPayload> {
    let meta = tool_call.meta.as_ref()?;
    let event_type = acp_event_type(meta)?;
    if event_type != ACP_IMAGE_GENERATION_EVENT_TYPE {
        return None;
    }

    let raw = tool_call.raw_input.as_ref();
    let status =
        raw_string_field(raw, &["status"]).unwrap_or_else(|| tool_status_label(&tool_call.status));
    let path = raw_string_field(raw, &["path", "saved_path"]);
    let result = raw_string_field(raw, &["result"]);
    let revised_prompt = raw_string_field(raw, &["revised_prompt"]);
    let explicit_error = raw_string_field(raw, &["error"]);
    let error = explicit_error.or_else(|| {
        if status == "failed" || tool_call.status == ToolCallStatus::Failed {
            result.clone()
        } else {
            None
        }
    });

    Some(AiImageGenerationPayload {
        session_id: session_id.to_string(),
        image_id: tool_call.tool_call_id.0.to_string(),
        status,
        title: tool_call.title.clone(),
        mime_type: path.as_deref().and_then(image_mime_type_from_path),
        path,
        revised_prompt,
        result,
        error,
    })
}

fn map_legacy_image_generation_status_event(
    session_id: &str,
    tool_call: &ToolCall,
) -> Option<AiImageGenerationPayload> {
    let meta = tool_call.meta.as_ref()?;
    let event_type = acp_event_type(meta)?;
    if event_type != "status" || tool_call.title != "Generating image" {
        return None;
    }

    let detail = summarize_tool_content(tool_call);
    let path = detail
        .as_deref()
        .filter(|value| is_generated_image_artifact_path(value))
        .map(ToString::to_string);
    let status = tool_status_label(&tool_call.status);
    let failed = status == "failed" || tool_call.status == ToolCallStatus::Failed;

    Some(AiImageGenerationPayload {
        session_id: session_id.to_string(),
        image_id: tool_call.tool_call_id.0.to_string(),
        status: status.clone(),
        title: if failed {
            "Image generation failed".to_string()
        } else if status == "completed" {
            "Generated image".to_string()
        } else {
            tool_call.title.clone()
        },
        mime_type: path.as_deref().and_then(image_mime_type_from_path),
        path,
        revised_prompt: None,
        result: detail.filter(|_| failed),
        error: failed.then(|| "Image generation failed".to_string()),
    })
}

fn map_status_event(
    session_id: &str,
    tool_call: &ToolCall,
    tool_action: Option<AiToolActivityActionPayload>,
) -> Option<AiStatusEventPayload> {
    let meta = tool_call.meta.as_ref()?;
    let event_type = acp_event_type(meta)?;
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
        tool_action,
    })
}

fn raw_string_field(raw: Option<&Value>, keys: &[&str]) -> Option<String> {
    let raw = raw?;
    keys.iter()
        .find_map(|key| raw.get(*key).and_then(Value::as_str))
        .map(ToString::to_string)
}

fn image_mime_type_from_path(path: &str) -> Option<String> {
    match Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" | "jpe" | "jfif" => Some("image/jpeg".to_string()),
        "gif" => Some("image/gif".to_string()),
        "webp" => Some("image/webp".to_string()),
        "avif" => Some("image/avif".to_string()),
        "bmp" => Some("image/bmp".to_string()),
        _ => None,
    }
}

fn normalize_path_for_generated_image_check(path: &str) -> String {
    path.strip_prefix("file://")
        .unwrap_or(path)
        .replace('\\', "/")
}

fn is_generated_image_artifact_path(path: &str) -> bool {
    if image_mime_type_from_path(path).is_none() {
        return false;
    }

    let normalized = normalize_path_for_generated_image_check(path);
    if normalized.contains("/.codex/generated_images/") {
        return true;
    }

    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let codex_generated_images = Path::new(&codex_home).join("generated_images");
        let normalized_root =
            normalize_path_for_generated_image_check(&codex_generated_images.display().to_string());
        return normalized.starts_with(&format!("{normalized_root}/"));
    }

    false
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

fn call_state_key(session_id: &str, tool_call_id: &str) -> String {
    format!("{session_id}::{tool_call_id}")
}

fn tool_kind_label(kind: &ToolKind) -> String {
    match kind {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::SwitchMode => "switch_mode",
        ToolKind::Other => "other",
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
            auth_method_ids(CODEX_RUNTIME_ID),
        ),
        (
            CLAUDE_RUNTIME_ID,
            "Claude",
            "Claude ACP-compatible agent runtime.",
            auth_method_ids(CLAUDE_RUNTIME_ID),
        ),
        (
            GEMINI_RUNTIME_ID,
            "Gemini",
            "Gemini ACP-compatible agent runtime.",
            auth_method_ids(GEMINI_RUNTIME_ID),
        ),
        (
            KILO_RUNTIME_ID,
            "Kilo",
            "Kilo ACP-compatible agent runtime.",
            auth_method_ids(KILO_RUNTIME_ID),
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
        parent_session_id: None,
        runtime_session_id: None,
        title: None,
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
    let inherited_auth_method = inherited_auth_method(runtime_id, !setup.suppress_persisted_auth);
    let auth_ready = setup.auth_ready || inherited_auth_method.is_some();
    let auth_method = setup.auth_method.or(inherited_auth_method);
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
            env.insert(
                "GEMINI_DEFAULT_AUTH_TYPE".to_string(),
                gemini_cli_auth_type(method).to_string(),
            );
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
    with_runtime_args(runtime_id, resolve_base_acp_command(runtime_id, setup))
}

fn resolve_base_acp_command(runtime_id: &str, setup: &RuntimeSetupState) -> ResolvedAcpCommand {
    if let Some(raw) = std::env::var_os(runtime_bin_env_var(runtime_id)) {
        let resolved =
            resolve_command_candidate(&raw.to_string_lossy(), AiRuntimeBinarySource::Env);
        if resolved.display.is_some() {
            return resolved;
        }
    }

    if let Some(raw) = setup.custom_binary_path.as_deref() {
        let resolved = resolve_command_candidate(raw, AiRuntimeBinarySource::Custom);
        if resolved.display.is_some() {
            return resolved;
        }
    }

    if let Some(resolved) = resolve_packaged_acp_command(runtime_id) {
        return resolved;
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
        return ResolvedAcpCommand {
            display: Some(path.display().to_string()),
            program: Some(path),
            args: Vec::new(),
            source: AiRuntimeBinarySource::Env,
        };
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

fn default_terminal_auth_method(runtime_id: &str) -> &'static str {
    match runtime_id {
        CLAUDE_RUNTIME_ID => default_claude_terminal_auth_method(),
        GEMINI_RUNTIME_ID => "login_with_google",
        KILO_RUNTIME_ID => "kilo-login",
        _ => "terminal-login",
    }
}

fn gemini_cli_auth_type(method_id: &str) -> &str {
    match method_id {
        "login_with_google" => "oauth-personal",
        "use_gemini" => "gemini-api-key",
        method_id => method_id,
    }
}

fn auth_terminal_launch_config(
    runtime_id: &str,
    method_id: &str,
    setup: &RuntimeSetupState,
    cwd: PathBuf,
) -> Result<AuthTerminalLaunchConfig, String> {
    validate_runtime_id(runtime_id)?;
    let mut resolved = resolve_base_acp_command(runtime_id, setup);
    let program = resolved.program.take().ok_or_else(|| {
        format!(
            "No {} runtime binary is configured.",
            runtime_name(runtime_id)
        )
    })?;
    let mut args = resolved.args;
    let mut env = setup.env.clone();
    let display_name = match (runtime_id, method_id) {
        (CLAUDE_RUNTIME_ID, "claude-ai-login") => {
            args.extend([
                "--cli".to_string(),
                "auth".to_string(),
                "login".to_string(),
                "--claudeai".to_string(),
            ]);
            "Claude Login".to_string()
        }
        (CLAUDE_RUNTIME_ID, "console-login") => {
            args.extend([
                "--cli".to_string(),
                "auth".to_string(),
                "login".to_string(),
                "--console".to_string(),
            ]);
            "Anthropic Console Login".to_string()
        }
        (CLAUDE_RUNTIME_ID, "claude-login") => {
            args.push("--cli".to_string());
            "Claude Login".to_string()
        }
        (GEMINI_RUNTIME_ID, "login_with_google") => {
            env.insert(
                "GEMINI_DEFAULT_AUTH_TYPE".to_string(),
                gemini_cli_auth_type(method_id).to_string(),
            );
            "Gemini Login".to_string()
        }
        (KILO_RUNTIME_ID, "kilo-login") => {
            args.extend(["auth".to_string(), "login".to_string()]);
            "Kilo Login".to_string()
        }
        _ => {
            return Err(format!(
                "Unsupported terminal auth method for {}: {}",
                runtime_name(runtime_id),
                method_id
            ))
        }
    };

    Ok(AuthTerminalLaunchConfig {
        program,
        args,
        display_name,
        cwd,
        env,
        runtime_id: runtime_id.to_string(),
        method_id: method_id.to_string(),
    })
}

fn resolve_auth_terminal_cwd(requested_cwd: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = requested_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        if path.is_dir() {
            return Ok(path);
        }
        return Err(format!(
            "The auth terminal working directory does not exist: {}",
            path.to_string_lossy()
        ));
    }

    if let Some(home) = home_dir() {
        return Ok(home);
    }

    std::env::current_dir()
        .map_err(|error| format!("Failed to resolve auth terminal working directory: {error}"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                Some(PathBuf::from(format!(
                    "{}{}",
                    PathBuf::from(drive).to_string_lossy(),
                    PathBuf::from(path).to_string_lossy()
                )))
            })
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
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
        let executable_extensions = executable_extensions_for_path_lookup();
        let program = find_executable_candidate(path.clone(), &executable_extensions);
        return ResolvedAcpCommand {
            program,
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

fn inherited_auth_method(runtime_id: &str, include_persisted: bool) -> Option<String> {
    match runtime_id {
        CODEX_RUNTIME_ID => env_secret_present("CODEX_API_KEY")
            .then(|| "codex-api-key".to_string())
            .or_else(|| env_secret_present("OPENAI_API_KEY").then(|| "openai-api-key".to_string()))
            .or_else(|| inherited_persisted_auth_method(runtime_id, include_persisted)),
        CLAUDE_RUNTIME_ID => env_secret_present("ANTHROPIC_AUTH_TOKEN")
            .then(|| "console-login".to_string())
            .or_else(|| {
                env_secret_present("ANTHROPIC_API_KEY").then(|| "anthropic-api-key".to_string())
            })
            .or_else(|| env_secret_present("ANTHROPIC_BASE_URL").then(|| "gateway".to_string()))
            .or_else(|| inherited_persisted_auth_method(runtime_id, include_persisted)),
        GEMINI_RUNTIME_ID => env_secret_present("GEMINI_API_KEY")
            .then(|| "use_gemini".to_string())
            .or_else(|| env_secret_present("GOOGLE_API_KEY").then(|| "use_gemini".to_string()))
            .or_else(|| inherited_persisted_auth_method(runtime_id, include_persisted)),
        KILO_RUNTIME_ID => inherited_persisted_auth_method(runtime_id, include_persisted),
        _ => None,
    }
}

fn inherited_persisted_auth_method(runtime_id: &str, include_persisted: bool) -> Option<String> {
    include_persisted
        .then(|| persisted_cli_auth_method(runtime_id))
        .flatten()
}

fn persisted_cli_auth_method(runtime_id: &str) -> Option<String> {
    let home = home_dir()?;
    persisted_cli_auth_method_for_home(runtime_id, &home, is_claude_remote_environment())
}

fn persisted_cli_auth_method_for_home(
    runtime_id: &str,
    home: &Path,
    is_claude_remote: bool,
) -> Option<String> {
    match runtime_id {
        CODEX_RUNTIME_ID if non_empty_file_exists(&home.join(".codex").join("auth.json")) => {
            Some("chatgpt".to_string())
        }
        CLAUDE_RUNTIME_ID if non_empty_file_exists(&home.join(".claude.json")) => {
            let method_id = if is_claude_remote {
                "claude-login"
            } else {
                "claude-ai-login"
            };
            Some(method_id.to_string())
        }
        GEMINI_RUNTIME_ID => non_empty_file_exists(&home.join(".gemini").join("oauth_creds.json"))
            .then(|| "login_with_google".to_string()),
        KILO_RUNTIME_ID if non_empty_file_exists_any(kilo_auth_file_candidates(home)) => {
            Some("kilo-login".to_string())
        }
        _ => None,
    }
}

fn kilo_auth_file_candidates(home: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(
        home.join(".local")
            .join("share")
            .join("kilo")
            .join("auth.json"),
    );

    #[cfg(target_os = "windows")]
    {
        candidates.push(
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Roaming"))
                .join("kilo")
                .join("auth.json"),
        );
        candidates.push(
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Local"))
                .join("kilo")
                .join("auth.json"),
        );
    }

    candidates
}

fn non_empty_file_exists_any(paths: impl IntoIterator<Item = PathBuf>) -> bool {
    paths.into_iter().any(|path| non_empty_file_exists(&path))
}

fn non_empty_file_exists(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(metadata) => metadata.is_file() && metadata.len() > 0,
        Err(_) => false,
    }
}

fn auth_method_has_local_config(setup: &RuntimeSetupState, method_id: &str) -> bool {
    match method_id {
        "codex-api-key" => setup
            .env
            .get("CODEX_API_KEY")
            .is_some_and(|value| !value.is_empty()),
        "openai-api-key" => setup
            .env
            .get("OPENAI_API_KEY")
            .is_some_and(|value| !value.is_empty()),
        "anthropic-api-key" => setup
            .env
            .get("ANTHROPIC_API_KEY")
            .is_some_and(|value| !value.is_empty()),
        "use_gemini" => {
            setup
                .env
                .get("GEMINI_API_KEY")
                .is_some_and(|value| !value.is_empty())
                || setup
                    .env
                    .get("GOOGLE_API_KEY")
                    .is_some_and(|value| !value.is_empty())
        }
        "gateway" => setup.has_gateway_config,
        _ => false,
    }
}

fn has_local_auth_config(setup: &RuntimeSetupState) -> bool {
    setup.has_gateway_config
        || [
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
        ]
        .into_iter()
        .any(|key| setup.env.get(key).is_some_and(|value| !value.is_empty()))
}

fn clear_runtime_auth_state(setup: &mut RuntimeSetupState) {
    setup.auth_ready = false;
    setup.auth_method = None;
    setup.suppress_persisted_auth = true;
    setup.has_gateway_config = false;
    setup.has_gateway_url = false;
    setup.message = None;
    for key in [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_BASE_URL",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
    ] {
        setup.env.remove(key);
    }
}

fn env_secret_present(key: &str) -> bool {
    std::env::var_os(key)
        .map(|value| !value.to_string_lossy().trim().is_empty())
        .unwrap_or(false)
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
        CLAUDE_RUNTIME_ID => claude_auth_methods_for_environment(is_claude_remote_environment()),
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

fn auth_method_ids(runtime_id: &str) -> Vec<&'static str> {
    match runtime_id {
        CODEX_RUNTIME_ID => vec!["chatgpt", "openai-api-key", "codex-api-key"],
        CLAUDE_RUNTIME_ID => claude_auth_method_ids_for_environment(is_claude_remote_environment()),
        GEMINI_RUNTIME_ID => vec!["login_with_google", "use_gemini"],
        KILO_RUNTIME_ID => vec!["kilo-login"],
        _ => vec![],
    }
}

fn is_claude_remote_environment() -> bool {
    [
        "NO_BROWSER",
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "SSH_TTY",
        "CLAUDE_CODE_REMOTE",
    ]
    .into_iter()
    .any(|key| std::env::var_os(key).is_some())
}

fn default_claude_terminal_auth_method() -> &'static str {
    if is_claude_remote_environment() {
        "claude-login"
    } else {
        "claude-ai-login"
    }
}

fn claude_auth_method_ids_for_environment(is_remote: bool) -> Vec<&'static str> {
    if is_remote {
        vec!["claude-login", "anthropic-api-key", "gateway"]
    } else {
        vec![
            "claude-ai-login",
            "console-login",
            "anthropic-api-key",
            "gateway",
        ]
    }
}

fn claude_auth_methods_for_environment(is_remote: bool) -> Vec<AiAuthMethod> {
    let gateway = AiAuthMethod {
        id: "gateway".to_string(),
        name: "Custom gateway".to_string(),
        description: "Use a custom Anthropic-compatible gateway.".to_string(),
    };

    if is_remote {
        return vec![
            AiAuthMethod {
                id: "claude-login".to_string(),
                name: "Log in with Claude".to_string(),
                description:
                    "Open Claude's terminal login flow for remote or no-browser environments."
                        .to_string(),
            },
            AiAuthMethod {
                id: "anthropic-api-key".to_string(),
                name: "Anthropic API key".to_string(),
                description: "Use an Anthropic API key stored locally.".to_string(),
            },
            gateway,
        ];
    }

    vec![
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
            id: "anthropic-api-key".to_string(),
            name: "Anthropic API key".to_string(),
            description: "Use an Anthropic API key stored locally.".to_string(),
        },
        gateway,
    ]
}

fn validate_claude_gateway_url(raw: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(raw.trim()).map_err(|_| "Enter a valid gateway URL.".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Gateway URL must not include embedded credentials.".to_string());
    }
    let host = parsed
        .host_str()
        .filter(|host| !host.trim().is_empty())
        .ok_or_else(|| "Enter a valid gateway URL.".to_string())?;

    match parsed.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_gateway_hostname(host) => Ok(()),
        "http" => Err("HTTP gateways are only allowed for localhost.".to_string()),
        _ => Err("Gateway URL must use HTTPS.".to_string()),
    }
}

fn is_loopback_gateway_hostname(hostname: &str) -> bool {
    let normalized = hostname
        .trim_matches(|ch| ch == '[' || ch == ']')
        .trim_end_matches('.')
        .to_ascii_lowercase();

    if normalized == "localhost" || normalized.ends_with(".localhost") || normalized == "::1" {
        return true;
    }

    normalized
        .parse::<std::net::Ipv4Addr>()
        .map(|addr| addr.octets()[0] == 127)
        .unwrap_or(false)
}

fn update_auth_state(
    setup: &mut RuntimeSetupState,
    runtime_id: &str,
    input: AiRuntimeSetupPayload,
) -> Result<(), String> {
    let gateway_url_touched =
        input.gateway_base_url.is_some() || input.anthropic_base_url.is_some();
    let gateway_headers_patch = input
        .anthropic_custom_headers
        .clone()
        .or_else(|| input.gateway_headers.clone());
    let gateway_config_touched = runtime_id == CLAUDE_RUNTIME_ID
        && (gateway_url_touched
            || gateway_headers_patch.is_some()
            || (input.anthropic_auth_token.is_some() && gateway_url_touched));
    let gateway_base_url = input
        .gateway_base_url
        .as_ref()
        .or(input.anthropic_base_url.as_ref())
        .and_then(|value| normalize_optional_string(value.clone()));
    if let Some(value) = gateway_base_url.as_deref() {
        validate_claude_gateway_url(value)?;
    }

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
        if let Some(patch) = input.anthropic_api_key.clone() {
            touched_auth |=
                apply_secret_patch(setup, "ANTHROPIC_API_KEY", patch, "anthropic-api-key");
        }
        if let Some(patch) = input.anthropic_auth_token.clone() {
            let auth_method = if gateway_url_touched || gateway_headers_patch.is_some() {
                "gateway"
            } else {
                "console-login"
            };
            touched_auth |= apply_secret_patch(setup, "ANTHROPIC_AUTH_TOKEN", patch, auth_method);
        }
        if let Some(patch) = gateway_headers_patch {
            touched_auth |= apply_secret_patch(setup, "ANTHROPIC_CUSTOM_HEADERS", patch, "gateway");
        }
        if gateway_url_touched {
            if let Some(value) = gateway_base_url {
                setup.env.insert("ANTHROPIC_BASE_URL".to_string(), value);
            } else {
                setup.env.remove("ANTHROPIC_BASE_URL");
            }
            touched_auth = true;
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

    if input.google_cloud_project.is_some() {
        if let Some(value) = input
            .google_cloud_project
            .and_then(normalize_optional_string)
        {
            setup.env.insert("GOOGLE_CLOUD_PROJECT".to_string(), value);
        } else {
            setup.env.remove("GOOGLE_CLOUD_PROJECT");
        }
    }
    if input.google_cloud_location.is_some() {
        if let Some(value) = input
            .google_cloud_location
            .and_then(normalize_optional_string)
        {
            setup.env.insert("GOOGLE_CLOUD_LOCATION".to_string(), value);
        } else {
            setup.env.remove("GOOGLE_CLOUD_LOCATION");
        }
    }

    setup.has_gateway_url = setup
        .env
        .get("ANTHROPIC_BASE_URL")
        .is_some_and(|value| !value.is_empty());
    setup.has_gateway_config = runtime_id == CLAUDE_RUNTIME_ID
        && (setup.has_gateway_url
            || setup
                .env
                .get("ANTHROPIC_CUSTOM_HEADERS")
                .is_some_and(|value| !value.is_empty()));
    if setup.has_gateway_config && gateway_config_touched {
        setup.auth_method = Some("gateway".to_string());
        touched_auth = true;
    }
    if touched_auth {
        setup.auth_ready = has_local_auth_config(setup);
        setup.suppress_persisted_auth = false;
        setup.message = None;
    }
    Ok(())
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
                setup.auth_method = Some(auth_method.to_string());
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
    let executable_extensions = executable_extensions_for_path_lookup();
    let candidate = PathBuf::from(name);
    if candidate.components().count() > 1 {
        return find_executable_candidate(candidate, &executable_extensions);
    }
    let path_value = std::env::var_os("PATH")?;
    find_program_in_path_entries(
        name,
        std::env::split_paths(&path_value),
        &executable_extensions,
    )
}

fn find_program_in_path_entries<I>(
    name: &str,
    entries: I,
    executable_extensions: &[String],
) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    for entry in entries {
        if let Some(candidate) = find_executable_candidate(entry.join(name), executable_extensions)
        {
            return Some(candidate);
        }
    }
    None
}

fn find_executable_candidate(
    candidate: PathBuf,
    executable_extensions: &[String],
) -> Option<PathBuf> {
    if candidate.extension().is_some() {
        return is_executable_file(&candidate).then_some(candidate);
    }
    for extension in executable_extensions {
        let mut with_extension = candidate.as_os_str().to_os_string();
        with_extension.push(extension);
        let with_extension = PathBuf::from(with_extension);
        if is_executable_file(&with_extension) {
            return Some(with_extension);
        }
    }
    if is_executable_file(&candidate) {
        return Some(candidate);
    }
    None
}

#[cfg(target_os = "windows")]
fn executable_extensions_for_path_lookup() -> Vec<String> {
    parse_windows_pathext(
        std::env::var_os("PATHEXT")
            .map(|value| value.to_string_lossy().into_owned())
            .as_deref(),
    )
}

#[cfg(not(target_os = "windows"))]
fn executable_extensions_for_path_lookup() -> Vec<String> {
    Vec::new()
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_pathext(raw: Option<&str>) -> Vec<String> {
    let mut extensions = raw
        .unwrap_or("")
        .split(';')
        .filter_map(|extension| {
            let extension = extension.trim();
            if extension.is_empty() {
                return None;
            }
            let extension = if extension.starts_with('.') {
                extension.to_string()
            } else {
                format!(".{extension}")
            };
            Some(extension.to_ascii_lowercase())
        })
        .collect::<Vec<_>>();

    if extensions.is_empty() {
        extensions = [".exe", ".cmd", ".bat", ".com"]
            .into_iter()
            .map(ToString::to_string)
            .collect();
    }

    extensions
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn release_auth_terminal_runtime_resources(
    master: &Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: &Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: &Arc<Mutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    killer: &Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    terminate_process: bool,
) {
    if terminate_process {
        if let Ok(mut killer_guard) = killer.lock() {
            if let Some(killer) = killer_guard.as_mut() {
                let _ = killer.kill();
            }
        }
    }

    if let Ok(mut writer_guard) = writer.lock() {
        writer_guard.take();
    }
    if let Ok(mut child_guard) = child.lock() {
        child_guard.take();
    }
    if let Ok(mut killer_guard) = killer.lock() {
        killer_guard.take();
    }
    if let Ok(mut master_guard) = master.lock() {
        master_guard.take();
    }
}

fn spawn_auth_terminal_output_reader(
    mut reader: Box<dyn Read + Send>,
    snapshot: Arc<Mutex<AiAuthTerminalSessionSnapshot>>,
    closed: Arc<AtomicBool>,
    session_state: Arc<Mutex<NativeAiInner>>,
    runtime_id: String,
    method_id: String,
    event_tx: Sender<RpcOutput>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; AUTH_TERMINAL_OUTPUT_CHUNK_SIZE];
        let mut verified_auth = false;
        loop {
            if closed.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if closed.load(Ordering::Relaxed) {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    let session_id = match snapshot.lock() {
                        Ok(mut snapshot) => {
                            append_auth_terminal_buffer(&mut snapshot.buffer, &chunk);
                            if !verified_auth
                                && auth_terminal_output_indicates_success(
                                    &runtime_id,
                                    &snapshot.buffer,
                                )
                            {
                                mark_runtime_auth_verified(&session_state, &runtime_id, &method_id);
                                verified_auth = true;
                            }
                            snapshot.session_id.clone()
                        }
                        Err(_) => break,
                    };
                    emit_auth_terminal_output(&event_tx, &session_id, chunk);
                }
                Err(error) => {
                    if !closed.load(Ordering::Relaxed) {
                        let (session_id, message) = match snapshot.lock() {
                            Ok(mut snapshot) => {
                                snapshot.status = AiAuthTerminalStatus::Error;
                                snapshot.error_message =
                                    Some(format!("Failed to read auth terminal output: {error}"));
                                (
                                    snapshot.session_id.clone(),
                                    snapshot.error_message.clone().unwrap_or_default(),
                                )
                            }
                            Err(_) => break,
                        };
                        emit_auth_terminal_error(&event_tx, &session_id, message);
                    }
                    break;
                }
            }
        }
    });
}

fn auth_terminal_output_indicates_success(runtime_id: &str, buffer: &str) -> bool {
    match runtime_id {
        GEMINI_RUNTIME_ID => {
            buffer.contains("Authentication succeeded")
                || buffer.contains("successfully signed in with Google")
        }
        _ => false,
    }
}

fn acp_session_wire_cwd(runtime_id: &str, cwd: &Path) -> PathBuf {
    if runtime_id == GEMINI_RUNTIME_ID {
        return PathBuf::from(normalize_path_for_node_acp(cwd));
    }
    cwd.to_path_buf()
}

fn normalize_path_for_node_acp(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn spawn_auth_terminal_exit_monitor(
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    snapshot: Arc<Mutex<AiAuthTerminalSessionSnapshot>>,
    closed: Arc<AtomicBool>,
    session_state: Arc<Mutex<NativeAiInner>>,
    runtime_id: String,
    method_id: String,
    event_tx: Sender<RpcOutput>,
) {
    thread::spawn(move || loop {
        if closed.load(Ordering::Relaxed) {
            break;
        }

        let exit_status = {
            let mut child_guard = match child.lock() {
                Ok(child_guard) => child_guard,
                Err(_) => break,
            };
            let Some(process) = child_guard.as_mut() else {
                break;
            };

            match process.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    let (session_id, message) = {
                        let mut snapshot_guard = match snapshot.lock() {
                            Ok(snapshot_guard) => snapshot_guard,
                            Err(_) => break,
                        };
                        snapshot_guard.status = AiAuthTerminalStatus::Error;
                        snapshot_guard.exit_code = None;
                        snapshot_guard.error_message =
                            Some(format!("Failed to monitor auth terminal process: {error}"));
                        (
                            snapshot_guard.session_id.clone(),
                            snapshot_guard.error_message.clone().unwrap_or_else(|| {
                                "Failed to monitor auth terminal process".to_string()
                            }),
                        )
                    };
                    release_auth_terminal_runtime_resources(
                        &master, &writer, &child, &killer, false,
                    );
                    emit_auth_terminal_error(&event_tx, &session_id, message);
                    break;
                }
            }
        };

        if let Some(exit_status) = exit_status {
            let exit_code = i32::try_from(exit_status.exit_code()).ok();
            if exit_code == Some(0) {
                mark_runtime_auth_verified(&session_state, &runtime_id, &method_id);
            }
            let snapshot = {
                let mut snapshot_guard = match snapshot.lock() {
                    Ok(snapshot_guard) => snapshot_guard,
                    Err(_) => break,
                };
                snapshot_guard.status = AiAuthTerminalStatus::Exited;
                snapshot_guard.exit_code = exit_code;
                snapshot_guard.error_message = None;
                snapshot_guard.clone()
            };
            release_auth_terminal_runtime_resources(&master, &writer, &child, &killer, false);
            emit_auth_terminal_exited(&event_tx, &snapshot);
            break;
        }

        thread::sleep(AUTH_TERMINAL_MONITOR_INTERVAL);
    });
}

fn append_auth_terminal_buffer(buffer: &mut String, chunk: &str) {
    buffer.push_str(chunk);
    if buffer.len() <= MAX_TERMINAL_SUMMARY_CHARS {
        return;
    }
    let excess = buffer.len() - MAX_TERMINAL_SUMMARY_CHARS;
    let trim_to = buffer
        .char_indices()
        .map(|(index, _)| index)
        .find(|index| *index >= excess)
        .unwrap_or(excess);
    buffer.drain(..trim_to);
}

fn mark_runtime_auth_pending(
    session_state: &Arc<Mutex<NativeAiInner>>,
    runtime_id: &str,
    method_id: &str,
) {
    if let Ok(mut state) = session_state.lock() {
        let setup = state.setup.entry(runtime_id.to_string()).or_default();
        setup.auth_method = Some(method_id.to_string());
        setup.auth_ready = false;
        setup.suppress_persisted_auth = false;
        setup.message = None;
    }
}

fn mark_runtime_auth_verified(
    session_state: &Arc<Mutex<NativeAiInner>>,
    runtime_id: &str,
    method_id: &str,
) {
    if let Ok(mut state) = session_state.lock() {
        let setup = state.setup.entry(runtime_id.to_string()).or_default();
        setup.auth_method = Some(method_id.to_string());
        setup.auth_ready = true;
        setup.suppress_persisted_auth = false;
        setup.message = None;
    }
}

fn emit_auth_terminal_started(
    event_tx: &Sender<RpcOutput>,
    snapshot: &AiAuthTerminalSessionSnapshot,
) {
    emit_event(event_tx, AI_AUTH_TERMINAL_STARTED_EVENT, json!(snapshot));
}

fn emit_auth_terminal_output(event_tx: &Sender<RpcOutput>, session_id: &str, chunk: String) {
    emit_event(
        event_tx,
        AI_AUTH_TERMINAL_OUTPUT_EVENT,
        json!({
            "sessionId": session_id,
            "chunk": chunk,
        }),
    );
}

fn emit_auth_terminal_exited(
    event_tx: &Sender<RpcOutput>,
    snapshot: &AiAuthTerminalSessionSnapshot,
) {
    emit_event(event_tx, AI_AUTH_TERMINAL_EXITED_EVENT, json!(snapshot));
}

fn emit_auth_terminal_error(event_tx: &Sender<RpcOutput>, session_id: &str, message: String) {
    emit_event(
        event_tx,
        AI_AUTH_TERMINAL_ERROR_EVENT,
        json!({
            "sessionId": session_id,
            "message": message,
        }),
    );
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
    use agent_client_protocol::schema::{
        ConfigOptionUpdate, Meta, ModelInfo, PermissionOptionKind, SessionConfigOption,
        SessionConfigOptionCategory, SessionConfigSelectOption, SessionInfoUpdate,
        SessionModelState, SessionNotification, SessionUpdate, ToolCallContent, ToolCallId,
        ToolCallUpdate, ToolCallUpdateFields, ToolKind,
    };
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration as StdDuration;

    fn test_client(event_tx: mpsc::Sender<RpcOutput>) -> NativeAcpClient {
        test_client_with_state(event_tx, Arc::new(Mutex::new(NativeAiInner::default())))
    }

    fn test_client_with_state(
        event_tx: mpsc::Sender<RpcOutput>,
        session_state: Arc<Mutex<NativeAiInner>>,
    ) -> NativeAcpClient {
        NativeAcpClient {
            event_tx,
            session_state,
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

    const CODEX_ACP_EVENT_TYPE_KEY: &str = "codexAcpEventType";
    const CODEX_ACP_PARENT_SESSION_ID_KEY: &str = "codexAcpParentSessionId";
    const CODEX_ACP_PARENT_THREAD_ID_KEY: &str = "codexAcpParentThreadId";
    const CODEX_ACP_CHILD_SESSION_ID_KEY: &str = "codexAcpChildSessionId";
    const CODEX_ACP_CHILD_THREAD_ID_KEY: &str = "codexAcpChildThreadId";
    const CODEX_ACP_AGENT_NICKNAME_KEY: &str = "codexAcpAgentNickname";
    const CODEX_ACP_AGENT_ROLE_KEY: &str = "codexAcpAgentRole";
    const CODEX_ACP_SUBAGENT_CREATED_EVENT: &str = "subagent_session_created";
    const CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT: &str = "subagent_breadcrumb";
    const CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY: &str = "codexAcpSubagentEventType";
    const CODEX_ACP_SUBAGENT_CLOSE_END_EVENT: &str = "close_end";
    const CODEX_ACP_SUBAGENT_WAITING_END_EVENT: &str = "waiting_end";
    const PARENT_RUNTIME_SESSION_ID: &str = "parent-runtime-session-id";
    const CHILD_RUNTIME_SESSION_ID: &str = "child-runtime-session-id";

    fn subagent_session_created_meta() -> Meta {
        Meta::from_iter([
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_CREATED_EVENT),
            ),
            (
                CODEX_ACP_PARENT_SESSION_ID_KEY.to_string(),
                json!(PARENT_RUNTIME_SESSION_ID),
            ),
            (
                CODEX_ACP_PARENT_THREAD_ID_KEY.to_string(),
                json!("parent-thread-id"),
            ),
            (
                CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
                json!(CHILD_RUNTIME_SESSION_ID),
            ),
            (
                CODEX_ACP_CHILD_THREAD_ID_KEY.to_string(),
                json!("child-thread-id"),
            ),
            (CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!("Galileo")),
            (CODEX_ACP_AGENT_ROLE_KEY.to_string(), json!("worker")),
        ])
    }

    fn subagent_session_created_notification_fixture() -> SessionNotification {
        SessionNotification::new(
            CHILD_RUNTIME_SESSION_ID,
            SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::from(
                "Spawning worker agent",
            ))),
        )
        .meta(subagent_session_created_meta())
    }

    fn subagent_session_info_created_notification_fixture() -> SessionNotification {
        SessionNotification::new(
            CHILD_RUNTIME_SESSION_ID,
            SessionUpdate::SessionInfoUpdate(
                SessionInfoUpdate::new()
                    .title("Galileo")
                    .meta(subagent_session_created_meta()),
            ),
        )
    }

    fn subagent_child_message_notification_fixture() -> SessionNotification {
        SessionNotification::new(
            CHILD_RUNTIME_SESSION_ID,
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
                "Child agent output",
            ))),
        )
    }

    fn insert_test_managed_session(
        session_state: &Arc<Mutex<NativeAiInner>>,
        runtime_id: &str,
        session_id: &str,
    ) {
        session_state.lock().unwrap().sessions.insert(
            session_id.to_string(),
            ManagedAiSession {
                session: new_session_with_id(runtime_id, session_id.to_string()).unwrap(),
                vault_root: None,
                additional_roots: vec![],
                runtime_handle: None,
            },
        );
    }

    #[test]
    fn acp_subagent_session_created_fixture_preserves_notification_meta() {
        let notification = subagent_session_created_notification_fixture();
        let encoded = serde_json::to_value(&notification).unwrap();

        assert_eq!(
            encoded.get("sessionId").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );
        assert_eq!(
            encoded
                .get("_meta")
                .and_then(|meta| meta.get(CODEX_ACP_EVENT_TYPE_KEY))
                .and_then(Value::as_str),
            Some(CODEX_ACP_SUBAGENT_CREATED_EVENT)
        );
        assert_eq!(
            encoded
                .get("_meta")
                .and_then(|meta| meta.get(CODEX_ACP_PARENT_SESSION_ID_KEY))
                .and_then(Value::as_str),
            Some(PARENT_RUNTIME_SESSION_ID)
        );

        let decoded: SessionNotification = serde_json::from_value(encoded).unwrap();
        let decoded_meta = decoded.meta.expect("subagent metadata should round-trip");
        assert_eq!(
            decoded_meta
                .get(CODEX_ACP_CHILD_SESSION_ID_KEY)
                .and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );
    }

    #[test]
    fn acp_subagent_fixtures_document_target_child_routing_contract() {
        let created = subagent_session_created_notification_fixture();
        let child_update = subagent_child_message_notification_fixture();
        let meta = created.meta.as_ref().expect("subagent creation meta");

        assert_eq!(
            meta.get(CODEX_ACP_EVENT_TYPE_KEY).and_then(Value::as_str),
            Some(CODEX_ACP_SUBAGENT_CREATED_EVENT)
        );
        assert_eq!(
            meta.get(CODEX_ACP_PARENT_SESSION_ID_KEY)
                .and_then(Value::as_str),
            Some(PARENT_RUNTIME_SESSION_ID)
        );
        assert_eq!(created.session_id.0.as_ref(), CHILD_RUNTIME_SESSION_ID);
        assert_eq!(child_update.session_id.0.as_ref(), CHILD_RUNTIME_SESSION_ID);
    }

    #[test]
    fn subagent_session_created_metadata_reads_update_meta() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        let client = test_client_with_state(event_tx, Arc::clone(&session_state));

        run_client_future(
            client.session_notification(subagent_session_info_created_notification_fixture()),
        )
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("child session created event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };
        assert_eq!(event_name, AI_SESSION_CREATED_EVENT);
        assert_eq!(
            payload.get("session_id").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );
        assert_eq!(
            payload.get("parent_session_id").and_then(Value::as_str),
            Some(PARENT_RUNTIME_SESSION_ID)
        );

        let sessions = &session_state.lock().unwrap().sessions;
        assert!(sessions.contains_key(CHILD_RUNTIME_SESSION_ID));
    }

    #[test]
    fn subagent_session_created_metadata_creates_child_session() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        let client = test_client_with_state(event_tx, Arc::clone(&session_state));

        run_client_future(
            client.session_notification(subagent_session_created_notification_fixture()),
        )
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("child session created event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };
        assert_eq!(event_name, AI_SESSION_CREATED_EVENT);
        assert_eq!(
            payload.get("session_id").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );
        assert_eq!(
            payload.get("parent_session_id").and_then(Value::as_str),
            Some(PARENT_RUNTIME_SESSION_ID)
        );
        assert_eq!(
            payload.get("runtime_session_id").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );
        assert_eq!(
            payload.get("title").and_then(Value::as_str),
            Some("Galileo")
        );

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("child thinking started event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };
        assert_eq!(event_name, AI_THINKING_STARTED_EVENT);
        assert_eq!(
            payload.get("session_id").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("child thinking delta event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };
        assert_eq!(event_name, AI_THINKING_DELTA_EVENT);
        assert_eq!(
            payload.get("session_id").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );

        let sessions = &session_state.lock().unwrap().sessions;
        assert!(sessions.contains_key(PARENT_RUNTIME_SESSION_ID));
        let child = sessions
            .get(CHILD_RUNTIME_SESSION_ID)
            .expect("child session should be registered");
        assert_eq!(
            child.session.parent_session_id.as_deref(),
            Some(PARENT_RUNTIME_SESSION_ID)
        );
        assert_eq!(
            child.session.runtime_session_id.as_deref(),
            Some(CHILD_RUNTIME_SESSION_ID)
        );
    }

    #[test]
    fn child_runtime_updates_do_not_mutate_parent_message_state() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        let client = test_client_with_state(event_tx, session_state);

        run_client_future(
            client.session_notification(subagent_child_message_notification_fixture()),
        )
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("child message started event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };
        assert_eq!(event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(
            payload.get("session_id").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("child message delta event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };
        assert_eq!(event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(
            payload.get("session_id").and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );

        let message_ids = client.message_ids.lock().unwrap();
        assert!(message_ids.contains_key(CHILD_RUNTIME_SESSION_ID));
        assert!(!message_ids.contains_key(PARENT_RUNTIME_SESSION_ID));
    }

    #[test]
    fn subagent_close_breadcrumb_marks_child_idle() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        let client = test_client_with_state(event_tx, Arc::clone(&session_state));

        run_client_future(
            client.session_notification(subagent_session_info_created_notification_fixture()),
        )
        .unwrap();
        while event_rx.try_recv().is_ok() {}

        run_client_future(
            client.session_notification(subagent_child_message_notification_fixture()),
        )
        .unwrap();
        while event_rx.try_recv().is_ok() {}
        assert!(client
            .message_ids
            .lock()
            .unwrap()
            .contains_key(CHILD_RUNTIME_SESSION_ID));

        let close_meta = Meta::from_iter([
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
            ),
            (
                CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
                json!(CHILD_RUNTIME_SESSION_ID),
            ),
            (
                CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_CLOSE_END_EVENT),
            ),
        ]);
        run_client_future(
            client.session_notification(SessionNotification::new(
                PARENT_RUNTIME_SESSION_ID,
                SessionUpdate::ToolCall(
                    ToolCall::new(ToolCallId::from("subagent-close-1"), "Closed Galileo")
                        .kind(ToolKind::Other)
                        .status(ToolCallStatus::Completed)
                        .meta(close_meta),
                ),
            )),
        )
        .unwrap();

        let mut saw_message_completed = false;
        let mut saw_idle_update = false;
        for _ in 0..3 {
            let RpcOutput::Event {
                event_name,
                payload,
            } = event_rx
                .recv_timeout(StdDuration::from_millis(250))
                .expect("close breadcrumb event")
            else {
                panic!("expected event");
            };
            if event_name == AI_MESSAGE_COMPLETED_EVENT {
                saw_message_completed = payload.get("session_id").and_then(Value::as_str)
                    == Some(CHILD_RUNTIME_SESSION_ID);
            }
            if event_name == AI_SESSION_UPDATED_EVENT
                && payload.get("session_id").and_then(Value::as_str)
                    == Some(CHILD_RUNTIME_SESSION_ID)
                && payload.get("status").and_then(Value::as_str) == Some("idle")
            {
                saw_idle_update = true;
            }
        }

        assert!(saw_message_completed);
        assert!(saw_idle_update);
        assert!(!client
            .message_ids
            .lock()
            .unwrap()
            .contains_key(CHILD_RUNTIME_SESSION_ID));
    }

    #[test]
    fn subagent_waiting_end_breadcrumb_marks_parent_children_idle() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, "child-app-session-1");
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, "child-app-session-2");
        {
            let mut state = session_state.lock().unwrap();
            for (app_session_id, runtime_session_id) in [
                ("child-app-session-1", "child-runtime-session-1"),
                ("child-app-session-2", "child-runtime-session-2"),
            ] {
                let child = state
                    .sessions
                    .get_mut(app_session_id)
                    .expect("child session should exist");
                child.session.parent_session_id = Some(PARENT_RUNTIME_SESSION_ID.to_string());
                child.session.runtime_session_id = Some(runtime_session_id.to_string());
                child.session.status = AiSessionStatus::Streaming;
            }
        }
        let client = test_client_with_state(event_tx, Arc::clone(&session_state));

        let waiting_end_meta = Meta::from_iter([
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
            ),
            (
                CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_WAITING_END_EVENT),
            ),
        ]);
        run_client_future(
            client.session_notification(SessionNotification::new(
                PARENT_RUNTIME_SESSION_ID,
                SessionUpdate::ToolCall(
                    ToolCall::new(ToolCallId::from("subagent-waiting-1"), "Subagents finished")
                        .kind(ToolKind::Other)
                        .status(ToolCallStatus::Completed)
                        .meta(waiting_end_meta),
                ),
            )),
        )
        .unwrap();

        let mut idle_updates = vec![];
        for _ in 0..3 {
            let RpcOutput::Event {
                event_name,
                payload,
            } = event_rx
                .recv_timeout(StdDuration::from_millis(250))
                .expect("waiting-end breadcrumb event")
            else {
                panic!("expected event");
            };
            if event_name == AI_SESSION_UPDATED_EVENT
                && payload.get("status").and_then(Value::as_str) == Some("idle")
            {
                if let Some(session_id) = payload.get("session_id").and_then(Value::as_str) {
                    idle_updates.push(session_id.to_string());
                }
            }
        }
        idle_updates.sort();

        assert_eq!(
            idle_updates,
            vec![
                "child-app-session-1".to_string(),
                "child-app-session-2".to_string()
            ]
        );
        let state = session_state.lock().unwrap();
        assert_eq!(
            state
                .sessions
                .get("child-app-session-1")
                .expect("first child session")
                .session
                .status,
            AiSessionStatus::Idle
        );
        assert_eq!(
            state
                .sessions
                .get("child-app-session-2")
                .expect("second child session")
                .session
                .status,
            AiSessionStatus::Idle
        );
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
    fn setup_status_does_not_treat_binary_as_authentication() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("fake-kilo");
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        ai.inner.lock().unwrap().setup.insert(
            KILO_RUNTIME_ID.to_string(),
            RuntimeSetupState {
                suppress_persisted_auth: true,
                ..RuntimeSetupState::default()
            },
        );

        let status = ai
            .update_setup(&json!({
                "runtimeId": KILO_RUNTIME_ID,
                "input": {
                    "custom_binary_path": runtime
                }
            }))
            .expect("setup should update");

        assert_eq!(
            status.get("binary_ready").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            status.get("auth_ready").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            status.get("onboarding_required").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(status.get("auth_method").and_then(Value::as_str), None);
    }

    #[test]
    fn verified_terminal_auth_marks_runtime_ready() {
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));

        mark_runtime_auth_verified(&session_state, KILO_RUNTIME_ID, "kilo-login");

        let state = session_state.lock().unwrap();
        let setup = state.setup.get(KILO_RUNTIME_ID).expect("runtime setup");
        assert!(setup.auth_ready);
        assert_eq!(setup.auth_method.as_deref(), Some("kilo-login"));
        assert_eq!(setup.message, None);
    }

    #[test]
    fn pending_terminal_auth_records_method_without_auth_ready() {
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));

        mark_runtime_auth_pending(&session_state, GEMINI_RUNTIME_ID, "login_with_google");

        let state = session_state.lock().unwrap();
        let setup = state.setup.get(GEMINI_RUNTIME_ID).expect("runtime setup");
        assert!(!setup.auth_ready);
        assert_eq!(setup.auth_method.as_deref(), Some("login_with_google"));
        assert_eq!(setup.message, None);
    }

    #[test]
    fn logout_clears_local_runtime_auth_state() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("fake-gemini");
        fs::write(&runtime, "#!/bin/sh\n").unwrap();

        ai.update_setup(&json!({
            "runtimeId": GEMINI_RUNTIME_ID,
            "input": {
                "custom_binary_path": runtime,
                "gemini_api_key": { "action": "set", "value": "test-key" }
            }
        }))
        .expect("setup should update");

        let status = ai
            .logout(&json!({
                "runtimeId": GEMINI_RUNTIME_ID,
                "vaultPath": temp.path()
            }))
            .expect("logout should clear local setup");

        assert_eq!(
            status.get("auth_ready").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            status.get("onboarding_required").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(status.get("auth_method").and_then(Value::as_str), None);
    }

    #[test]
    fn logout_does_not_require_acp_for_codex_api_keys() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);
        let temp = tempfile::tempdir().unwrap();

        ai.update_setup(&json!({
            "runtimeId": CODEX_RUNTIME_ID,
            "input": {
                "custom_binary_path": temp.path().join("missing-codex-acp"),
                "openai_api_key": { "action": "set", "value": "test-key" }
            }
        }))
        .expect("setup should update");

        let status = ai
            .logout(&json!({
                "runtimeId": CODEX_RUNTIME_ID,
                "vaultPath": temp.path()
            }))
            .expect("API key logout should only clear local setup");

        assert_eq!(
            status.get("auth_ready").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(status.get("auth_method").and_then(Value::as_str), None);
    }

    #[test]
    fn setup_rejects_remote_http_claude_gateway_urls() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);

        let error = ai
            .update_setup(&json!({
                "runtimeId": CLAUDE_RUNTIME_ID,
                "input": {
                    "anthropic_base_url": "http://gateway.example",
                    "anthropic_auth_token": { "action": "set", "value": "test-token" }
                }
            }))
            .expect_err("remote HTTP gateway URLs should be rejected by the backend");

        assert_eq!(error, "HTTP gateways are only allowed for localhost.");
    }

    #[test]
    fn setup_accepts_local_http_claude_gateway_urls() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);

        let status = ai
            .update_setup(&json!({
                "runtimeId": CLAUDE_RUNTIME_ID,
                "input": {
                    "anthropic_base_url": "http://localhost:3000",
                    "anthropic_auth_token": { "action": "set", "value": "test-token" }
                }
            }))
            .expect("localhost HTTP gateways are allowed for development");

        assert_eq!(
            status.get("auth_method").and_then(Value::as_str),
            Some("gateway")
        );
        assert_eq!(
            status.get("auth_ready").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn setup_uses_gateway_auth_method_when_gateway_has_token() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);

        let status = ai
            .update_setup(&json!({
                "runtimeId": CLAUDE_RUNTIME_ID,
                "input": {
                    "anthropic_base_url": "https://gateway.example",
                    "anthropic_auth_token": { "action": "set", "value": "test-token" }
                }
            }))
            .expect("gateway setup should update");

        assert_eq!(
            status.get("auth_method").and_then(Value::as_str),
            Some("gateway")
        );
        assert_eq!(
            status.get("has_gateway_config").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn setup_accepts_anthropic_api_key_auth() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);

        let status = ai
            .update_setup(&json!({
                "runtimeId": CLAUDE_RUNTIME_ID,
                "input": {
                    "anthropic_api_key": { "action": "set", "value": "test-key" }
                }
            }))
            .expect("Anthropic API key setup should update");

        assert_eq!(
            status.get("auth_method").and_then(Value::as_str),
            Some("anthropic-api-key")
        );
        assert_eq!(
            status.get("auth_ready").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn start_auth_preserves_configured_api_key_auth() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("fake-acp");
        fs::write(&runtime, "#!/bin/sh\n").unwrap();

        ai.update_setup(&json!({
            "runtimeId": CODEX_RUNTIME_ID,
            "input": {
                "custom_binary_path": runtime,
                "openai_api_key": { "action": "set", "value": "test-key" }
            }
        }))
        .expect("setup should update");

        let status = ai
            .start_auth(&json!({
                "input": {
                    "runtimeId": CODEX_RUNTIME_ID,
                    "methodId": "openai-api-key"
                },
                "vaultPath": temp.path()
            }))
            .expect("configured API key auth should not require interactive login");

        assert_eq!(
            status.get("auth_method").and_then(Value::as_str),
            Some("openai-api-key")
        );
        assert_eq!(
            status.get("auth_ready").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(status.get("message").and_then(Value::as_str), None);
    }

    #[test]
    fn start_auth_chatgpt_requires_a_resolved_codex_runtime() {
        let (event_tx, _event_rx) = mpsc::channel();
        let ai = NativeAi::new(event_tx);
        let temp = tempfile::tempdir().unwrap();

        ai.update_setup(&json!({
            "runtimeId": CODEX_RUNTIME_ID,
            "input": {
                "custom_binary_path": temp.path().join("missing-codex-acp")
            }
        }))
        .expect("setup should update");

        let error = ai
            .start_auth(&json!({
                "input": {
                    "runtimeId": CODEX_RUNTIME_ID,
                    "methodId": "chatgpt"
                },
                "vaultPath": temp.path()
            }))
            .expect_err("ChatGPT auth should fail before pretending it connected");

        assert!(error.contains("No Codex runtime binary is configured."));
    }

    #[test]
    fn path_lookup_resolves_windows_cmd_shims_from_pathext() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("gemini"), "#!/usr/bin/env node\n").unwrap();
        let shim = temp.path().join("gemini.cmd");
        fs::write(&shim, "").unwrap();

        let resolved = find_program_in_path_entries(
            "gemini",
            vec![temp.path().to_path_buf()],
            &parse_windows_pathext(Some(".COM;.EXE;.BAT;.CMD")),
        );

        assert_eq!(resolved, Some(shim));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn explicit_program_path_prefers_windows_extension_shim() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("gemini"), "#!/usr/bin/env node\n").unwrap();
        let shim = temp.path().join("gemini.cmd");
        fs::write(&shim, "").unwrap();

        let resolved = resolve_command_candidate(
            &temp.path().join("gemini").display().to_string(),
            AiRuntimeBinarySource::Custom,
        );

        assert_eq!(resolved.program, Some(shim));
    }

    #[test]
    fn explicit_program_path_resolves_windows_extension_fallbacks() {
        let temp = tempfile::tempdir().unwrap();
        let shim = temp.path().join("kilo.cmd");
        fs::write(&shim, "").unwrap();

        let resolved =
            find_executable_candidate(temp.path().join("kilo"), &parse_windows_pathext(None));

        assert_eq!(resolved, Some(shim));
    }

    #[test]
    fn subagent_breadcrumb_tool_activity_opens_registered_child_session() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, "child-app-session");
        {
            let mut state = session_state.lock().unwrap();
            state
                .sessions
                .get_mut("child-app-session")
                .expect("child session should exist")
                .session
                .runtime_session_id = Some(CHILD_RUNTIME_SESSION_ID.to_string());
        }
        let client = test_client_with_state(event_tx, session_state);
        let meta = Meta::from_iter([
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
            ),
            (
                CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
                json!(CHILD_RUNTIME_SESSION_ID),
            ),
            (CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!("Worker")),
        ]);

        run_client_future(
            client.session_notification(SessionNotification::new(
                PARENT_RUNTIME_SESSION_ID,
                SessionUpdate::ToolCall(
                    ToolCall::new(ToolCallId::from("subagent-tool-1"), "Spawned Worker")
                        .kind(ToolKind::Other)
                        .status(ToolCallStatus::Completed)
                        .meta(meta),
                ),
            )),
        )
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
        assert_eq!(
            payload.pointer("/action/kind").and_then(Value::as_str),
            Some("open_session")
        );
        assert_eq!(
            payload
                .pointer("/action/session_id")
                .and_then(Value::as_str),
            Some("child-app-session")
        );
        assert_eq!(
            payload.pointer("/action/label").and_then(Value::as_str),
            None
        );
    }

    #[test]
    fn subagent_breadcrumb_tool_update_opens_registered_child_session() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, "child-app-session");
        {
            let mut state = session_state.lock().unwrap();
            state
                .sessions
                .get_mut("child-app-session")
                .expect("child session should exist")
                .session
                .runtime_session_id = Some(CHILD_RUNTIME_SESSION_ID.to_string());
        }
        let client = test_client_with_state(event_tx, session_state);
        let begin_meta = Meta::from_iter([
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
            ),
            (
                CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY.to_string(),
                json!("spawn_begin"),
            ),
        ]);

        run_client_future(
            client.session_notification(SessionNotification::new(
                PARENT_RUNTIME_SESSION_ID,
                SessionUpdate::ToolCall(
                    ToolCall::new(
                        ToolCallId::from("subagent-tool-update"),
                        "Spawning subagent",
                    )
                    .kind(ToolKind::Other)
                    .status(ToolCallStatus::InProgress)
                    .meta(begin_meta),
                ),
            )),
        )
        .unwrap();
        let _ = event_rx.recv_timeout(StdDuration::from_millis(250));

        let end_meta = Meta::from_iter([
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
            ),
            (
                CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
                json!(CHILD_RUNTIME_SESSION_ID),
            ),
            (
                CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY.to_string(),
                json!("spawn_end"),
            ),
            (CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!("Hypatia")),
        ]);
        run_client_future(
            client.session_notification(SessionNotification::new(
                PARENT_RUNTIME_SESSION_ID,
                SessionUpdate::ToolCallUpdate(
                    ToolCallUpdate::new(
                        "subagent-tool-update",
                        ToolCallUpdateFields::new()
                            .title("Spawned Hypatia")
                            .status(ToolCallStatus::Completed)
                            .content(vec![ToolCallContent::from("Status: pending")]),
                    )
                    .meta(end_meta),
                ),
            )),
        )
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
        assert_eq!(
            payload.pointer("/action/kind").and_then(Value::as_str),
            Some("open_session")
        );
        assert_eq!(
            payload
                .pointer("/action/session_id")
                .and_then(Value::as_str),
            Some("child-app-session")
        );
    }

    #[test]
    fn subagent_breadcrumb_tool_activity_keeps_open_action_before_child_registration() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        let client = test_client_with_state(event_tx, session_state);
        let meta = Meta::from_iter([
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
            ),
            (
                CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
                json!(CHILD_RUNTIME_SESSION_ID),
            ),
            (CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!("Cicero")),
        ]);

        run_client_future(
            client.session_notification(SessionNotification::new(
                PARENT_RUNTIME_SESSION_ID,
                SessionUpdate::ToolCall(
                    ToolCall::new(ToolCallId::from("subagent-tool-early"), "Spawned Cicero")
                        .kind(ToolKind::Other)
                        .status(ToolCallStatus::Completed)
                        .meta(meta),
                ),
            )),
        )
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
        assert_eq!(
            payload.pointer("/action/kind").and_then(Value::as_str),
            Some("open_session")
        );
        assert_eq!(
            payload
                .pointer("/action/session_id")
                .and_then(Value::as_str),
            Some(CHILD_RUNTIME_SESSION_ID)
        );
    }

    #[test]
    fn subagent_status_breadcrumb_includes_open_child_session_action() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, PARENT_RUNTIME_SESSION_ID);
        insert_test_managed_session(&session_state, CODEX_RUNTIME_ID, "child-app-session");
        {
            let mut state = session_state.lock().unwrap();
            state
                .sessions
                .get_mut("child-app-session")
                .expect("child session should exist")
                .session
                .runtime_session_id = Some(CHILD_RUNTIME_SESSION_ID.to_string());
        }
        let client = test_client_with_state(event_tx, session_state);
        let meta = Meta::from_iter([
            (ACP_STATUS_EVENT_TYPE_KEY.to_string(), json!("status")),
            (ACP_STATUS_KIND_KEY.to_string(), json!("item_activity")),
            (ACP_STATUS_EMPHASIS_KEY.to_string(), json!("neutral")),
            (
                CODEX_ACP_EVENT_TYPE_KEY.to_string(),
                json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
            ),
            (
                CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
                json!(CHILD_RUNTIME_SESSION_ID),
            ),
            (CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!("Mendel")),
        ]);

        run_client_future(
            client.session_notification(SessionNotification::new(
                PARENT_RUNTIME_SESSION_ID,
                SessionUpdate::ToolCall(
                    ToolCall::new(ToolCallId::from("subagent-status-1"), "Spawned Mendel")
                        .kind(ToolKind::Other)
                        .status(ToolCallStatus::Pending)
                        .meta(meta),
                ),
            )),
        )
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
            payload.pointer("/tool_action/kind").and_then(Value::as_str),
            Some("open_session")
        );
        assert_eq!(
            payload
                .pointer("/tool_action/session_id")
                .and_then(Value::as_str),
            Some("child-app-session")
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
    fn applying_config_options_removes_stale_reasoning_option() {
        let mut session = new_session_with_id(CLAUDE_RUNTIME_ID, "session-1".to_string()).unwrap();
        session.model_id = "claude-sonnet-4-5".to_string();
        session.config_options = map_session_config_options(
            CLAUDE_RUNTIME_ID,
            vec![
                SessionConfigOption::select(
                    "model",
                    "Model",
                    "claude-sonnet-4-5",
                    vec![
                        SessionConfigSelectOption::new("claude-sonnet-4-5", "Claude Sonnet 4.5"),
                        SessionConfigSelectOption::new("claude-haiku-4-5", "Claude Haiku 4.5"),
                    ],
                )
                .category(SessionConfigOptionCategory::Model),
                SessionConfigOption::select(
                    "effort",
                    "Effort",
                    "high",
                    vec![
                        SessionConfigSelectOption::new("medium", "Medium"),
                        SessionConfigSelectOption::new("high", "High"),
                    ],
                )
                .category(SessionConfigOptionCategory::Other("effort".to_string())),
            ],
        );

        let haiku_options = map_session_config_options(
            CLAUDE_RUNTIME_ID,
            vec![
                SessionConfigOption::select(
                    "model",
                    "Model",
                    "claude-haiku-4-5",
                    vec![
                        SessionConfigSelectOption::new("claude-sonnet-4-5", "Claude Sonnet 4.5"),
                        SessionConfigSelectOption::new("claude-haiku-4-5", "Claude Haiku 4.5"),
                    ],
                )
                .category(SessionConfigOptionCategory::Model),
                SessionConfigOption::select(
                    "mode",
                    "Mode",
                    "default",
                    vec![SessionConfigSelectOption::new("default", "Default")],
                )
                .category(SessionConfigOptionCategory::Mode),
            ],
        );

        apply_config_options_to_session(&mut session, haiku_options);

        assert_eq!(session.model_id, "claude-haiku-4-5");
        assert_eq!(session.mode_id, "default");
        assert!(session
            .config_options
            .iter()
            .all(|option| !matches!(option.category, AiConfigOptionCategory::Reasoning)));
    }

    #[test]
    fn config_option_update_notification_updates_cached_session() {
        let (event_tx, event_rx) = mpsc::channel();
        let session_state = Arc::new(Mutex::new(NativeAiInner::default()));
        let client = test_client_with_state(event_tx, Arc::clone(&session_state));
        let mut session = new_session_with_id(CLAUDE_RUNTIME_ID, "session-1".to_string()).unwrap();
        session.model_id = "claude-sonnet-4-5".to_string();
        session.config_options = map_session_config_options(
            CLAUDE_RUNTIME_ID,
            vec![
                SessionConfigOption::select(
                    "model",
                    "Model",
                    "claude-sonnet-4-5",
                    vec![
                        SessionConfigSelectOption::new("claude-sonnet-4-5", "Claude Sonnet 4.5"),
                        SessionConfigSelectOption::new("claude-haiku-4-5", "Claude Haiku 4.5"),
                    ],
                )
                .category(SessionConfigOptionCategory::Model),
                SessionConfigOption::select(
                    "effort",
                    "Effort",
                    "high",
                    vec![SessionConfigSelectOption::new("high", "High")],
                )
                .category(SessionConfigOptionCategory::Other("effort".to_string())),
            ],
        );
        session_state.lock().unwrap().sessions.insert(
            "session-1".to_string(),
            ManagedAiSession {
                session,
                vault_root: None,
                additional_roots: vec![],
                runtime_handle: None,
            },
        );

        let updated_options = vec![
            SessionConfigOption::select(
                "model",
                "Model",
                "claude-haiku-4-5",
                vec![
                    SessionConfigSelectOption::new("claude-sonnet-4-5", "Claude Sonnet 4.5"),
                    SessionConfigSelectOption::new("claude-haiku-4-5", "Claude Haiku 4.5"),
                ],
            )
            .category(SessionConfigOptionCategory::Model),
            SessionConfigOption::select(
                "mode",
                "Mode",
                "default",
                vec![SessionConfigSelectOption::new("default", "Default")],
            )
            .category(SessionConfigOptionCategory::Mode),
        ];

        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(updated_options)),
        )))
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("session update event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };
        assert_eq!(event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(
            payload.get("model_id").and_then(Value::as_str),
            Some("claude-haiku-4-5")
        );
        let session = session_state
            .lock()
            .unwrap()
            .sessions
            .get("session-1")
            .unwrap()
            .session
            .clone();
        assert!(session
            .config_options
            .iter()
            .all(|option| !matches!(option.category, AiConfigOptionCategory::Reasoning)));
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

        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCall(tool_call),
        )))
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
        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCall(pending),
        )))
        .unwrap();
        let _ = event_rx.recv_timeout(StdDuration::from_millis(250));

        let completed = ToolCallUpdate::new(
            "tool-1",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::from("File updated")]),
        );
        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCallUpdate(completed),
        )))
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
        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCall(started),
        )))
        .unwrap();
        let _ = event_rx.recv_timeout(StdDuration::from_millis(250));

        let update =
            ToolCallUpdate::new("tool-1", ToolCallUpdateFields::new()).meta(Meta::from_iter([(
                "terminal_output".to_string(),
                json!({ "data": "running tests\n" }),
            )]));
        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCallUpdate(update),
        )))
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

        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCall(tool_call),
        )))
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
    fn session_tool_call_image_generation_meta_emits_image_event() {
        let (event_tx, event_rx) = mpsc::channel();
        let client = test_client(event_tx);

        let tool_call = ToolCall::new(ToolCallId::from("neverwrite:image:ig-1"), "Generated image")
            .kind(ToolKind::Other)
            .status(ToolCallStatus::Completed)
            .raw_input(json!({
                "status": "completed",
                "path": "/Users/test/.codex/generated_images/session/ig-1.png",
                "revised_prompt": "A tiny blue square",
                "result": "Zm9v",
            }))
            .meta(Meta::from_iter([(
                ACP_STATUS_EVENT_TYPE_KEY.to_string(),
                json!(ACP_IMAGE_GENERATION_EVENT_TYPE),
            )]));

        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCall(tool_call),
        )))
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("image generation event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };

        assert_eq!(event_name, AI_IMAGE_GENERATION_EVENT);
        assert_eq!(
            payload.get("image_id").and_then(Value::as_str),
            Some("neverwrite:image:ig-1")
        );
        assert_eq!(
            payload.get("mime_type").and_then(Value::as_str),
            Some("image/png")
        );
        assert_eq!(
            payload.get("revised_prompt").and_then(Value::as_str),
            Some("A tiny blue square")
        );
    }

    #[test]
    fn legacy_image_generation_status_meta_emits_image_event() {
        let (event_tx, event_rx) = mpsc::channel();
        let client = test_client(event_tx);

        let tool_call = ToolCall::new(
            ToolCallId::from("neverwrite:status:item:ig-legacy"),
            "Generating image",
        )
        .kind(ToolKind::Other)
        .status(ToolCallStatus::Completed)
        .content(vec![ToolCallContent::Content(
            agent_client_protocol::schema::Content::new(
                "/Users/test/.codex/generated_images/session/ig-legacy.png",
            ),
        )])
        .meta(Meta::from_iter([
            (ACP_STATUS_EVENT_TYPE_KEY.to_string(), json!("status")),
            (ACP_STATUS_KIND_KEY.to_string(), json!("item_activity")),
            (ACP_STATUS_EMPHASIS_KEY.to_string(), json!("neutral")),
        ]));

        run_client_future(client.session_notification(SessionNotification::new(
            "session-1",
            SessionUpdate::ToolCall(tool_call),
        )))
        .unwrap();

        let event = event_rx
            .recv_timeout(StdDuration::from_millis(250))
            .expect("image generation event");
        let RpcOutput::Event {
            event_name,
            payload,
        } = event
        else {
            panic!("expected event");
        };

        assert_eq!(event_name, AI_IMAGE_GENERATION_EVENT);
        assert_eq!(
            payload.get("image_id").and_then(Value::as_str),
            Some("neverwrite:status:item:ig-legacy")
        );
        assert_eq!(
            payload.get("path").and_then(Value::as_str),
            Some("/Users/test/.codex/generated_images/session/ig-legacy.png")
        );
        assert_eq!(
            payload.get("title").and_then(Value::as_str),
            Some("Generated image")
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
        run_client_future(client.request_permission(request)).unwrap();

        let (saw_tool_activity_diffs, saw_permission_diffs) = event_thread.join().unwrap();
        assert!(saw_tool_activity_diffs);
        assert!(saw_permission_diffs);
    }

    #[test]
    fn auth_terminal_launch_config_uses_selected_claude_method() {
        let current_exe = std::env::current_exe().unwrap();
        let setup = RuntimeSetupState {
            custom_binary_path: Some(current_exe.display().to_string()),
            ..RuntimeSetupState::default()
        };

        let config = auth_terminal_launch_config(
            CLAUDE_RUNTIME_ID,
            "console-login",
            &setup,
            std::env::current_dir().unwrap(),
        )
        .unwrap();

        assert_eq!(
            config.args,
            vec![
                "--cli".to_string(),
                "auth".to_string(),
                "login".to_string(),
                "--console".to_string()
            ]
        );
        assert_eq!(config.display_name, "Anthropic Console Login");
    }

    #[test]
    fn claude_auth_methods_match_local_environment_contract() {
        let method_ids = claude_auth_method_ids_for_environment(false);
        assert_eq!(
            method_ids,
            vec![
                "claude-ai-login",
                "console-login",
                "anthropic-api-key",
                "gateway"
            ]
        );

        let methods = claude_auth_methods_for_environment(false)
            .into_iter()
            .map(|method| method.id)
            .collect::<Vec<_>>();
        assert_eq!(methods, method_ids);
    }

    #[test]
    fn claude_auth_methods_match_remote_environment_contract() {
        let method_ids = claude_auth_method_ids_for_environment(true);
        assert_eq!(
            method_ids,
            vec!["claude-login", "anthropic-api-key", "gateway"]
        );

        let methods = claude_auth_methods_for_environment(true)
            .into_iter()
            .map(|method| method.id)
            .collect::<Vec<_>>();
        assert_eq!(methods, method_ids);
    }

    #[test]
    fn detects_persisted_gemini_oauth_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let gemini_dir = temp.path().join(".gemini");
        fs::create_dir_all(&gemini_dir).unwrap();
        fs::write(gemini_dir.join("oauth_creds.json"), "{}").unwrap();

        assert_eq!(
            persisted_cli_auth_method_for_home(GEMINI_RUNTIME_ID, temp.path(), false),
            Some("login_with_google".to_string())
        );
    }

    #[test]
    fn ignores_empty_persisted_gemini_oauth_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let gemini_dir = temp.path().join(".gemini");
        fs::create_dir_all(&gemini_dir).unwrap();
        fs::write(gemini_dir.join("oauth_creds.json"), "").unwrap();

        assert_eq!(
            persisted_cli_auth_method_for_home(GEMINI_RUNTIME_ID, temp.path(), false),
            None
        );
    }

    #[test]
    fn detects_persisted_claude_credentials_for_environment() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(".claude.json"), "{}").unwrap();

        assert_eq!(
            persisted_cli_auth_method_for_home(CLAUDE_RUNTIME_ID, temp.path(), false),
            Some("claude-ai-login".to_string())
        );
        assert_eq!(
            persisted_cli_auth_method_for_home(CLAUDE_RUNTIME_ID, temp.path(), true),
            Some("claude-login".to_string())
        );
    }

    #[test]
    fn detects_persisted_codex_chatgpt_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let codex_dir = temp.path().join(".codex");
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(codex_dir.join("auth.json"), "{}").unwrap();

        assert_eq!(
            persisted_cli_auth_method_for_home(CODEX_RUNTIME_ID, temp.path(), false),
            Some("chatgpt".to_string())
        );
    }

    #[test]
    fn detects_persisted_kilo_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let kilo_dir = temp.path().join(".local").join("share").join("kilo");
        fs::create_dir_all(&kilo_dir).unwrap();
        fs::write(kilo_dir.join("auth.json"), "{}").unwrap();

        assert_eq!(
            persisted_cli_auth_method_for_home(KILO_RUNTIME_ID, temp.path(), false),
            Some("kilo-login".to_string())
        );
    }

    #[test]
    fn ignores_empty_persisted_kilo_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let kilo_dir = temp.path().join(".local").join("share").join("kilo");
        fs::create_dir_all(&kilo_dir).unwrap();
        fs::write(kilo_dir.join("auth.json"), "").unwrap();

        assert_eq!(
            persisted_cli_auth_method_for_home(KILO_RUNTIME_ID, temp.path(), false),
            None
        );
    }

    #[test]
    fn auth_terminal_launch_config_does_not_use_acp_args_for_login() {
        let current_exe = std::env::current_exe().unwrap();
        let setup = RuntimeSetupState {
            custom_binary_path: Some(current_exe.display().to_string()),
            ..RuntimeSetupState::default()
        };

        let config = auth_terminal_launch_config(
            KILO_RUNTIME_ID,
            "kilo-login",
            &setup,
            std::env::current_dir().unwrap(),
        )
        .unwrap();

        assert_eq!(config.args, vec!["auth".to_string(), "login".to_string()]);
        assert_eq!(config.display_name, "Kilo Login");
    }

    #[test]
    fn auth_terminal_launch_config_forces_gemini_google_login_method() {
        let current_exe = std::env::current_exe().unwrap();
        let setup = RuntimeSetupState {
            custom_binary_path: Some(current_exe.display().to_string()),
            ..RuntimeSetupState::default()
        };

        let config = auth_terminal_launch_config(
            GEMINI_RUNTIME_ID,
            "login_with_google",
            &setup,
            std::env::current_dir().unwrap(),
        )
        .unwrap();

        assert!(config.args.is_empty());
        assert_eq!(config.display_name, "Gemini Login");
        assert_eq!(
            config
                .env
                .get("GEMINI_DEFAULT_AUTH_TYPE")
                .map(String::as_str),
            Some("oauth-personal")
        );
    }

    #[test]
    fn gemini_auth_terminal_success_output_is_detected_before_exit() {
        assert!(auth_terminal_output_indicates_success(
            GEMINI_RUNTIME_ID,
            "\u{1b}[33mAuthentication succeeded\u{1b}[0m\nYou've successfully signed in with Google."
        ));
        assert!(!auth_terminal_output_indicates_success(
            CLAUDE_RUNTIME_ID,
            "Authentication succeeded"
        ));
    }

    #[test]
    fn gemini_acp_session_cwd_uses_node_friendly_separators() {
        let cwd = PathBuf::from(r"C:\Users\jsgrr\Vault");

        let gemini_cwd = acp_session_wire_cwd(GEMINI_RUNTIME_ID, &cwd);
        let codex_cwd = acp_session_wire_cwd(CODEX_RUNTIME_ID, &cwd);

        assert_eq!(gemini_cwd.to_string_lossy(), "C:/Users/jsgrr/Vault");
        assert_eq!(codex_cwd, cwd);
    }

    #[test]
    fn acp_process_spec_maps_gemini_api_key_method_to_cli_auth_type() {
        let current_exe = std::env::current_exe().unwrap();
        let setup = RuntimeSetupState {
            custom_binary_path: Some(current_exe.display().to_string()),
            auth_method: Some("use_gemini".to_string()),
            ..RuntimeSetupState::default()
        };

        let spec = acp_process_spec(GEMINI_RUNTIME_ID, &setup, std::env::current_dir().unwrap())
            .expect("Gemini ACP process spec should resolve");

        assert_eq!(
            spec.env.get("GEMINI_DEFAULT_AUTH_TYPE").map(String::as_str),
            Some("gemini-api-key")
        );
    }
}
