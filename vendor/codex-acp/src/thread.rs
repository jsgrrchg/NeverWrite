use std::{
    cell::RefCell,
    collections::HashMap,
    ops::DerefMut,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, LazyLock, Mutex},
};

use agent_client_protocol::{
    AvailableCommand, AvailableCommandInput, AvailableCommandsUpdate, Client, ClientCapabilities,
    ConfigOptionUpdate, Content, ContentBlock, ContentChunk, Diff, EmbeddedResource,
    EmbeddedResourceResource, Error, LoadSessionResponse, Meta, ModelId, ModelInfo,
    PermissionOption, PermissionOptionKind, Plan, PlanEntry, PlanEntryPriority, PlanEntryStatus,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResourceLink, SelectedPermissionOutcome, SessionConfigId, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigOptionValue, SessionConfigSelectOption,
    SessionConfigValueId, SessionId, SessionInfoUpdate, SessionMode, SessionModeId,
    SessionModeState, SessionModelState, SessionNotification, SessionUpdate, StopReason, Terminal,
    TextResourceContents, ToolCall, ToolCallContent, ToolCallId, ToolCallLocation, ToolCallStatus,
    ToolCallUpdate, ToolCallUpdateFields, ToolKind, UnstructuredCommandInput, UsageUpdate,
};
use codex_apply_patch::parse_patch;
use codex_core::{
    AuthManager, CodexThread,
    config::{Config, set_project_trust_level},
    error::CodexErr,
    models_manager::manager::{ModelsManager, RefreshStrategy},
    review_format::format_review_findings_block,
    review_prompts::user_facing_hint,
};
use codex_protocol::protocol::{
    AgentMessageContentDeltaEvent, AgentMessageEvent, AgentReasoningEvent,
    AgentReasoningRawContentEvent, AgentReasoningSectionBreakEvent, ApplyPatchApprovalRequestEvent,
    AskForApproval, ElicitationAction, ErrorEvent, Event, EventMsg, ExecApprovalRequestEvent,
    ExecCommandBeginEvent, ExecCommandEndEvent, ExecCommandOutputDeltaEvent, ExecCommandStatus,
    ExitedReviewModeEvent, FileChange, ItemCompletedEvent, ItemStartedEvent,
    ListCustomPromptsResponseEvent, McpInvocation, McpStartupCompleteEvent, McpStartupUpdateEvent,
    McpToolCallBeginEvent, McpToolCallEndEvent, ModelRerouteEvent, Op, PatchApplyBeginEvent,
    PatchApplyEndEvent, PatchApplyStatus, PlanDeltaEvent, ReasoningContentDeltaEvent,
    ReasoningRawContentDeltaEvent, ReviewDecision, ReviewOutputEvent, ReviewRequest,
    ReviewTarget, SandboxPolicy, StreamErrorEvent, TerminalInteractionEvent, TokenCountEvent,
    TurnAbortedEvent, TurnCompleteEvent, TurnStartedEvent, UserMessageEvent,
    ViewImageToolCallEvent, WarningEvent, WebSearchBeginEvent, WebSearchEndEvent,
};
use codex_protocol::{
    approvals::ElicitationRequestEvent,
    config_types::TrustLevel,
    custom_prompts::CustomPrompt,
    dynamic_tools::{DynamicToolCallOutputContentItem, DynamicToolCallRequest},
    items::TurnItem,
    mcp::CallToolResult,
    models::{
        FileSystemPermissions, ResponseItem, WebSearchAction,
    },
    openai_models::{ModelPreset, ReasoningEffort},
    parse_command::ParsedCommand,
    plan_tool::{PlanItemArg, StepStatus, UpdatePlanArgs},
    protocol::{
        DynamicToolCallResponseEvent, NetworkApprovalContext, NetworkPolicyAmendment, RolloutItem,
    },
    request_permissions::{
        PermissionGrantScope, RequestPermissionProfile, RequestPermissionsEvent,
        RequestPermissionsResponse,
    },
    user_input::UserInput,
};
use codex_shell_command::parse_command::parse_command;
use codex_utils_approval_presets::{ApprovalPreset, builtin_approval_presets};
use heck::ToTitleCase;
use itertools::Itertools;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    ACP_CLIENT,
    prompt_args::{expand_custom_prompt, parse_slash_name},
};

static APPROVAL_PRESETS: LazyLock<Vec<ApprovalPreset>> = LazyLock::new(builtin_approval_presets);
const INIT_COMMAND_PROMPT: &str = include_str!("./prompt_for_init_command.md");
const NEVERWRITE_USER_INPUT_RESPONSE_PREFIX: &str = "__neverwrite_user_input_response__:";
const NEVERWRITE_STATUS_EVENT_TYPE_KEY: &str = "neverwriteEventType";
const NEVERWRITE_STATUS_KIND_KEY: &str = "neverwriteStatusKind";
const NEVERWRITE_STATUS_EMPHASIS_KEY: &str = "neverwriteStatusEmphasis";
const NEVERWRITE_PLAN_TITLE_KEY: &str = "neverwritePlanTitle";
const NEVERWRITE_PLAN_DETAIL_KEY: &str = "neverwritePlanDetail";
const NEVERWRITE_DIFF_PREVIOUS_PATH_KEY: &str = "neverwritePreviousPath";
const NEVERWRITE_DIFF_HUNKS_KEY: &str = "neverwriteHunks";
const NEVERWRITE_STATUS_EVENT_ID_PREFIX: &str = "neverwrite:status:";
const FILE_DELETED_PLACEHOLDER: &str = "[file deleted]";

fn approval_preset_matches_config(
    preset: &ApprovalPreset,
    approval_policy: &AskForApproval,
    sandbox_policy: &SandboxPolicy,
) -> bool {
    if &preset.approval != approval_policy {
        return false;
    }

    match (&preset.sandbox, sandbox_policy) {
        (
            SandboxPolicy::ReadOnly {
                access: preset_access,
                network_access: preset_network_access,
            },
            SandboxPolicy::ReadOnly {
                access,
                network_access,
            },
        ) => preset_access == access && preset_network_access == network_access,
        (
            SandboxPolicy::WorkspaceWrite {
                read_only_access: preset_read_only_access,
                network_access: preset_network_access,
                exclude_tmpdir_env_var: preset_exclude_tmpdir_env_var,
                exclude_slash_tmp: preset_exclude_slash_tmp,
                ..
            },
            SandboxPolicy::WorkspaceWrite {
                read_only_access,
                network_access,
                exclude_tmpdir_env_var,
                exclude_slash_tmp,
                ..
            },
        ) => {
            preset_read_only_access == read_only_access
                && preset_network_access == network_access
                && preset_exclude_tmpdir_env_var == exclude_tmpdir_env_var
                && preset_exclude_slash_tmp == exclude_slash_tmp
        }
        (SandboxPolicy::DangerFullAccess, SandboxPolicy::DangerFullAccess) => true,
        _ => &preset.sandbox == sandbox_policy,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct NeverWriteDiffHunk {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
    lines: Vec<NeverWriteDiffHunkLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct NeverWriteDiffHunkLine {
    r#type: String,
    text: String,
}

/// Trait for abstracting over the `CodexThread` to make testing easier.
#[async_trait::async_trait]
pub trait CodexThreadImpl {
    async fn submit(&self, op: Op) -> Result<String, CodexErr>;
    async fn next_event(&self) -> Result<Event, CodexErr>;
}

#[async_trait::async_trait]
impl CodexThreadImpl for CodexThread {
    async fn submit(&self, op: Op) -> Result<String, CodexErr> {
        self.submit(op).await
    }

    async fn next_event(&self) -> Result<Event, CodexErr> {
        self.next_event().await
    }
}

#[async_trait::async_trait]
pub trait ModelsManagerImpl {
    async fn get_model(&self, model_id: &Option<String>) -> String;
    async fn list_models(&self) -> Vec<ModelPreset>;
}

#[async_trait::async_trait]
impl ModelsManagerImpl for ModelsManager {
    async fn get_model(&self, model_id: &Option<String>) -> String {
        self.get_default_model(model_id, RefreshStrategy::OnlineIfUncached)
            .await
    }

    async fn list_models(&self) -> Vec<ModelPreset> {
        self.list_models(RefreshStrategy::OnlineIfUncached).await
    }
}

pub trait Auth {
    fn logout(&self) -> Result<bool, Error>;
}

impl Auth for Arc<AuthManager> {
    fn logout(&self) -> Result<bool, Error> {
        self.as_ref()
            .logout()
            .map_err(|e| Error::internal_error().data(e.to_string()))
    }
}

enum ThreadMessage {
    Load {
        response_tx: oneshot::Sender<Result<LoadSessionResponse, Error>>,
    },
    GetConfigOptions {
        response_tx: oneshot::Sender<Result<Vec<SessionConfigOption>, Error>>,
    },
    Prompt {
        request: PromptRequest,
        response_tx: oneshot::Sender<Result<oneshot::Receiver<Result<StopReason, Error>>, Error>>,
    },
    SetMode {
        mode: SessionModeId,
        response_tx: oneshot::Sender<Result<(), Error>>,
    },
    SetModel {
        model: ModelId,
        response_tx: oneshot::Sender<Result<(), Error>>,
    },
    SetConfigOption {
        config_id: SessionConfigId,
        value: SessionConfigOptionValue,
        response_tx: oneshot::Sender<Result<(), Error>>,
    },
    Cancel {
        response_tx: oneshot::Sender<Result<(), Error>>,
    },
    ReplayHistory {
        history: Vec<RolloutItem>,
        response_tx: oneshot::Sender<Result<(), Error>>,
    },
    PermissionRequestResolved {
        submission_id: String,
        request_id: String,
        outcome: Result<RequestPermissionOutcome, Error>,
    },
}

pub struct Thread {
    /// A sender for interacting with the thread.
    message_tx: mpsc::UnboundedSender<ThreadMessage>,
    /// A handle to the spawned task.
    _handle: tokio::task::JoinHandle<()>,
}

impl Thread {
    pub fn new(
        session_id: SessionId,
        thread: Arc<dyn CodexThreadImpl>,
        auth: Arc<AuthManager>,
        models_manager: Arc<dyn ModelsManagerImpl>,
        client_capabilities: Arc<Mutex<ClientCapabilities>>,
        config: Config,
    ) -> Self {
        let (message_tx, message_rx) = mpsc::unbounded_channel();

        let actor = ThreadActor::new(
            auth,
            SessionClient::new(session_id, client_capabilities),
            thread,
            models_manager,
            config,
            message_rx,
            message_tx.downgrade(),
        );
        let handle = tokio::task::spawn_local(actor.spawn());

        Self {
            message_tx,
            _handle: handle,
        }
    }

    pub async fn load(&self) -> Result<LoadSessionResponse, Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::Load { response_tx };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }

    pub async fn config_options(&self) -> Result<Vec<SessionConfigOption>, Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::GetConfigOptions { response_tx };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }

    pub async fn prompt(&self, request: PromptRequest) -> Result<StopReason, Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::Prompt {
            request,
            response_tx,
        };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))??
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }

    pub async fn set_mode(&self, mode: SessionModeId) -> Result<(), Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::SetMode { mode, response_tx };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }

    pub async fn set_model(&self, model: ModelId) -> Result<(), Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::SetModel { model, response_tx };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }

    pub async fn set_config_option(
        &self,
        config_id: SessionConfigId,
        value: SessionConfigOptionValue,
    ) -> Result<(), Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::SetConfigOption {
            config_id,
            value,
            response_tx,
        };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }

    pub async fn cancel(&self) -> Result<(), Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::Cancel { response_tx };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }

    pub async fn shutdown(&self) -> Result<(), Error> {
        drop(self.cancel().await);
        self._handle.abort();
        Ok(())
    }

    pub async fn replay_history(&self, history: Vec<RolloutItem>) -> Result<(), Error> {
        let (response_tx, response_rx) = oneshot::channel();

        let message = ThreadMessage::ReplayHistory {
            history,
            response_tx,
        };
        drop(self.message_tx.send(message));

        response_rx
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?
    }
}

enum SubmissionState {
    /// Loading custom prompts from the project
    CustomPrompts(CustomPromptsState),
    /// User prompts, including slash commands like /init, /review, /compact, /undo.
    Prompt(PromptState),
}

impl SubmissionState {
    fn is_active(&self) -> bool {
        match self {
            Self::CustomPrompts(state) => state.is_active(),
            Self::Prompt(state) => state.is_active(),
        }
    }

    async fn handle_event(&mut self, client: &SessionClient, event: EventMsg) {
        match self {
            Self::CustomPrompts(state) => state.handle_event(event),
            Self::Prompt(state) => state.handle_event(client, event).await,
        }
    }
}

struct CustomPromptsState {
    response_tx: Option<oneshot::Sender<Result<Vec<CustomPrompt>, Error>>>,
}

impl CustomPromptsState {
    fn new(response_tx: oneshot::Sender<Result<Vec<CustomPrompt>, Error>>) -> Self {
        Self {
            response_tx: Some(response_tx),
        }
    }

    fn is_active(&self) -> bool {
        let Some(response_tx) = &self.response_tx else {
            return false;
        };
        !response_tx.is_closed()
    }

    fn handle_event(&mut self, event: EventMsg) {
        match event {
            EventMsg::ListCustomPromptsResponse(ListCustomPromptsResponseEvent {
                custom_prompts,
            }) => {
                if let Some(tx) = self.response_tx.take() {
                    drop(tx.send(Ok(custom_prompts)));
                }
            }
            e => {
                warn!("Unexpected event: {e:?}");
            }
        }
    }
}

struct ActiveCommand {
    tool_call_id: ToolCallId,
    terminal_output: bool,
    output: String,
    file_extension: Option<String>,
    /// Snapshots of file contents taken before the command executes.
    /// Key = absolute path, Value = file content (None if file didn't exist).
    file_snapshots: HashMap<PathBuf, Option<String>>,
}

struct PendingPermissionInteraction {
    request: PendingPermissionRequest,
    handle: tokio::task::JoinHandle<()>,
}

enum PendingPermissionRequest {
    Exec {
        approval_id: String,
        turn_id: String,
    },
    Patch {
        call_id: String,
    },
    RequestPermissions {
        call_id: String,
        permissions: RequestPermissionProfile,
    },
}

struct PromptState {
    active_commands: HashMap<String, ActiveCommand>,
    active_web_search: Option<String>,
    active_plan_text: HashMap<String, String>,
    thread: Arc<dyn CodexThreadImpl>,
    message_tx: mpsc::WeakUnboundedSender<ThreadMessage>,
    submission_id: String,
    pending_permission_requests: HashMap<String, PendingPermissionInteraction>,
    event_count: usize,
    response_tx: Option<oneshot::Sender<Result<StopReason, Error>>>,
    seen_message_deltas: bool,
    seen_reasoning_deltas: bool,
}
#[derive(Debug, serde::Deserialize)]
struct NeverWriteUserInputAnswerPayload {
    turn_id: String,
    response: codex_protocol::request_user_input::RequestUserInputResponse,
}

fn neverwrite_status_meta(kind: &str, emphasis: &str) -> Meta {
    let mut meta = Meta::new();
    meta.insert(NEVERWRITE_STATUS_EVENT_TYPE_KEY.to_string(), json!("status"));
    meta.insert(NEVERWRITE_STATUS_KIND_KEY.to_string(), json!(kind));
    meta.insert(NEVERWRITE_STATUS_EMPHASIS_KEY.to_string(), json!(emphasis));
    meta
}
fn neverwrite_user_input_meta() -> Meta {
    let mut meta = Meta::new();
    meta.insert(
        NEVERWRITE_STATUS_EVENT_TYPE_KEY.to_string(),
        json!("user_input_request"),
    );
    meta
}

fn neverwrite_plan_meta(title: Option<&str>, detail: Option<&str>) -> Option<Meta> {
    let mut meta = Meta::new();
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        meta.insert(NEVERWRITE_PLAN_TITLE_KEY.to_string(), json!(title));
    }
    if let Some(detail) = detail.filter(|value| !value.trim().is_empty()) {
        meta.insert(NEVERWRITE_PLAN_DETAIL_KEY.to_string(), json!(detail));
    }
    (!meta.is_empty()).then_some(meta)
}

fn turn_item_id(item: &TurnItem) -> &str {
    match item {
        TurnItem::UserMessage(item) => &item.id,
        TurnItem::HookPrompt(item) => &item.id,
        TurnItem::AgentMessage(item) => &item.id,
        TurnItem::Plan(item) => &item.id,
        TurnItem::Reasoning(item) => &item.id,
        TurnItem::WebSearch(item) => &item.id,
        TurnItem::ImageGeneration(item) => &item.id,
        TurnItem::ContextCompaction(item) => &item.id,
    }
}

fn describe_turn_item(item: &TurnItem) -> (&'static str, Option<String>) {
    match item {
        TurnItem::UserMessage(..) => ("Preparing input", None),
        TurnItem::HookPrompt(..) => ("Awaiting hook guidance", None),
        TurnItem::AgentMessage(..) => ("Drafting response", None),
        TurnItem::Plan(item) => ("Updating plan", Some(item.text.clone())),
        TurnItem::Reasoning(item) => (
            "Reasoning",
            item.summary_text
                .first()
                .cloned()
                .or_else(|| item.raw_content.first().cloned()),
        ),
        TurnItem::WebSearch(item) => ("Web search", Some(item.query.clone())),
        TurnItem::ImageGeneration(item) => (
            "Generating image",
            item.saved_path
                .clone()
                .or_else(|| Some(item.result.clone())),
        ),
        TurnItem::ContextCompaction(..) => ("Compacting context", None),
    }
}

fn format_permission_rule(permissions: &RequestPermissionProfile) -> Option<String> {
    let mut parts = Vec::new();

    if permissions
        .network
        .as_ref()
        .and_then(|network| network.enabled)
        .unwrap_or(false)
    {
        parts.push("network".to_string());
    }

    if let Some(FileSystemPermissions { read, write }) = permissions.file_system.as_ref() {
        if let Some(read) = read.as_ref().filter(|paths| !paths.is_empty()) {
            parts.push(format!(
                "read {}",
                read.iter()
                    .map(|path| format!("`{}`", path.display()))
                    .join(", ")
            ));
        }
        if let Some(write) = write.as_ref().filter(|paths| !paths.is_empty()) {
            parts.push(format!(
                "write {}",
                write
                    .iter()
                    .map(|path| format!("`{}`", path.display()))
                    .join(", ")
            ));
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(format!("Permission rule: {}", parts.join("; ")))
    }
}

fn format_review_target(target: &ReviewTarget) -> String {
    match target {
        ReviewTarget::UncommittedChanges => "Reviewing working tree changes".to_string(),
        ReviewTarget::BaseBranch { branch } => format!("Reviewing changes against {branch}"),
        ReviewTarget::Commit { sha, title } => {
            if let Some(title) = title {
                format!("Reviewing commit {sha}: {title}")
            } else {
                format!("Reviewing commit {sha}")
            }
        }
        ReviewTarget::Custom { instructions } => instructions.clone(),
    }
}
fn summarize_user_input_questions(
    questions: &[codex_protocol::request_user_input::RequestUserInputQuestion],
) -> Option<String> {
    if questions.is_empty() {
        return None;
    }

    Some(
        questions
            .iter()
            .map(|question| question.question.trim())
            .filter(|question| !question.is_empty())
            .take(2)
            .join("\n"),
    )
}
fn plan_entry_status_from_marker(line: &str) -> Option<(StepStatus, &str)> {
    let trimmed = line.trim_start();
    let (rest, default_status) = if let Some(rest) = trimmed.strip_prefix("- ") {
        (rest, StepStatus::Pending)
    } else if let Some(rest) = trimmed.strip_prefix("* ") {
        (rest, StepStatus::Pending)
    } else if let Some(rest) = trimmed.strip_prefix("+ ") {
        (rest, StepStatus::Pending)
    } else {
        let digit_count = trimmed
            .chars()
            .take_while(|char| char.is_ascii_digit())
            .count();
        if digit_count == 0 {
            return None;
        }

        let marker = trimmed.as_bytes().get(digit_count).copied();
        let spacing = trimmed.as_bytes().get(digit_count + 1).copied();
        if !matches!(marker, Some(b'.' | b')')) || spacing != Some(b' ') {
            return None;
        }

        (&trimmed[digit_count + 2..], StepStatus::Pending)
    };

    let rest = rest.trim_start();
    let statuses = [
        ("[x]", StepStatus::Completed),
        ("[X]", StepStatus::Completed),
        ("[ ]", StepStatus::Pending),
        ("[~]", StepStatus::InProgress),
        ("[/]", StepStatus::InProgress),
        ("[>]", StepStatus::InProgress),
        ("[-]", StepStatus::InProgress),
    ];

    for (marker, status) in statuses {
        if let Some(content) = rest.strip_prefix(marker) {
            return Some((status, content.trim_start()));
        }
    }

    Some((default_status, rest))
}

fn push_plan_item(items: &mut Vec<PlanItemArg>, step: String, status: StepStatus) {
    let step = step.trim().to_string();
    if step.is_empty() {
        return;
    }

    items.push(PlanItemArg { step, status });
}

#[derive(Debug, Clone)]
struct ParsedPlanText {
    title: Option<String>,
    detail: Option<String>,
    entries: Vec<PlanItemArg>,
}

fn normalize_plan_context_lines(lines: Vec<String>) -> Vec<String> {
    let mut lines = lines;
    while matches!(lines.first(), Some(line) if line.trim().is_empty()) {
        lines.remove(0);
    }
    while matches!(lines.last(), Some(line) if line.trim().is_empty()) {
        lines.pop();
    }

    let mut normalized = Vec::new();
    let mut previous_blank = false;
    for line in lines {
        let is_blank = line.trim().is_empty();
        if is_blank && previous_blank {
            continue;
        }
        previous_blank = is_blank;
        normalized.push(line);
    }

    normalized
}

fn split_plan_title_and_detail(lines: Vec<String>) -> (Option<String>, Option<String>) {
    let lines = normalize_plan_context_lines(lines);
    if lines.is_empty() {
        return (None, None);
    }

    let first = lines[0].trim();
    if let Some(title) = first.strip_prefix("# ") {
        let detail = lines[1..].join("\n").trim().to_string();
        return (
            Some(title.trim().to_string()),
            (!detail.is_empty()).then_some(detail),
        );
    }

    (None, Some(lines.join("\n").trim().to_string()))
}

fn is_plan_item_continuation(line: &str) -> bool {
    line.starts_with("  ") || line.starts_with('\t')
}

fn parse_plan_text(text: &str, streaming: bool) -> ParsedPlanText {
    let mut items = Vec::new();
    let mut current_item: Option<(String, StepStatus)> = None;
    let mut context_lines: Vec<String> = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim_end();
        let trimmed = line.trim();

        if trimmed.is_empty() {
            if let Some((content, _status)) = current_item.as_mut()
                && !content.is_empty()
            {
                content.push('\n');
            } else if !context_lines.is_empty() {
                context_lines.push(String::new());
            }
            continue;
        }

        if let Some((status, content)) = plan_entry_status_from_marker(trimmed) {
            if let Some((existing_content, existing_status)) = current_item.take() {
                push_plan_item(&mut items, existing_content, existing_status);
            }

            current_item = Some((content.to_string(), status));
            continue;
        }

        if let Some((content, _status)) = current_item.as_mut()
            && is_plan_item_continuation(raw_line)
        {
            if !content.is_empty() {
                content.push('\n');
            }
            content.push_str(trimmed);
            continue;
        }

        if let Some((existing_content, existing_status)) = current_item.take() {
            push_plan_item(&mut items, existing_content, existing_status);
        }
        context_lines.push(trimmed.to_string());
    }

    if let Some((content, status)) = current_item.take() {
        push_plan_item(&mut items, content, status);
    }
    let (title, detail) = split_plan_title_and_detail(context_lines);

    if items.is_empty() {
        let fallback = text.trim();
        if !fallback.is_empty() {
            let detail = if detail.as_ref().is_some_and(|value| !value.is_empty()) {
                detail
            } else {
                Some(fallback.to_string())
            };
            return ParsedPlanText {
                title,
                detail,
                entries: Vec::new(),
            };
        }
    } else if streaming
        && !items
            .iter()
            .any(|item| matches!(item.status, StepStatus::InProgress))
        && let Some(last_pending) = items
            .iter_mut()
            .rfind(|item| matches!(item.status, StepStatus::Pending))
    {
        last_pending.status = StepStatus::InProgress;
    }

    ParsedPlanText {
        title,
        detail,
        entries: items,
    }
}

fn extract_user_input_answer_payload(
    prompt: &[ContentBlock],
) -> Result<Option<NeverWriteUserInputAnswerPayload>, Error> {
    let Some(ContentBlock::Text(text)) = prompt.first() else {
        return Ok(None);
    };

    let raw_payload = text
        .text
        .strip_prefix(NEVERWRITE_USER_INPUT_RESPONSE_PREFIX);
    let Some(raw_payload) = raw_payload else {
        return Ok(None);
    };

    serde_json::from_str::<NeverWriteUserInputAnswerPayload>(raw_payload)
        .map(Some)
        .map_err(|err| Error::invalid_params().data(err.to_string()))
}

impl PromptState {
    fn new(
        thread: Arc<dyn CodexThreadImpl>,
        message_tx: mpsc::WeakUnboundedSender<ThreadMessage>,
        submission_id: String,
        response_tx: oneshot::Sender<Result<StopReason, Error>>,
    ) -> Self {
        Self {
            active_commands: HashMap::new(),
            active_web_search: None,
            active_plan_text: HashMap::new(),
            thread,
            message_tx,
            submission_id,
            pending_permission_requests: HashMap::new(),
            event_count: 0,
            response_tx: Some(response_tx),
            seen_message_deltas: false,
            seen_reasoning_deltas: false,
        }
    }

    fn is_active(&self) -> bool {
        let Some(response_tx) = &self.response_tx else {
            return false;
        };
        !response_tx.is_closed()
    }

    fn spawn_permission_request(
        &mut self,
        client: &SessionClient,
        request_id: String,
        request: PendingPermissionRequest,
        tool_call: ToolCallUpdate,
        options: Vec<PermissionOption>,
    ) {
        let client = client.clone();
        let message_tx = self.message_tx.clone();
        let submission_id = self.submission_id.clone();
        let request_id_for_task = request_id.clone();
        let handle = tokio::task::spawn_local(async move {
            let outcome = client
                .request_permission(tool_call, options)
                .await
                .map(|response| response.outcome);
            if let Some(message_tx) = message_tx.upgrade() {
                drop(message_tx.send(ThreadMessage::PermissionRequestResolved {
                    submission_id,
                    request_id: request_id_for_task,
                    outcome,
                }));
            }
        });

        self.pending_permission_requests
            .insert(request_id, PendingPermissionInteraction { request, handle });
    }

    fn abort_pending_interactions(&mut self) {
        for interaction in self
            .pending_permission_requests
            .drain()
            .map(|(_, value)| value)
        {
            interaction.handle.abort();
        }
    }

    async fn handle_permission_request_resolved(
        &mut self,
        request_id: String,
        outcome: Result<RequestPermissionOutcome, Error>,
    ) -> Result<(), Error> {
        let Some(interaction) = self.pending_permission_requests.remove(&request_id) else {
            return Ok(());
        };

        let outcome = outcome?;
        match interaction.request {
            PendingPermissionRequest::Exec {
                approval_id,
                turn_id,
            } => {
                let decision = match outcome {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome {
                        option_id,
                        ..
                    }) => match option_id.0.as_ref() {
                        "approved-for-session" => ReviewDecision::ApprovedForSession,
                        "approved" => ReviewDecision::Approved,
                        _ => ReviewDecision::Abort,
                    },
                    RequestPermissionOutcome::Cancelled => ReviewDecision::Abort,
                    _ => ReviewDecision::Abort,
                };

                self.thread
                    .submit(Op::ExecApproval {
                        id: approval_id,
                        turn_id: Some(turn_id),
                        decision,
                    })
                    .await
                    .map_err(|e| Error::from(anyhow::anyhow!(e)))?;
            }
            PendingPermissionRequest::Patch { call_id } => {
                let decision = match outcome {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome {
                        option_id,
                        ..
                    }) => match option_id.0.as_ref() {
                        "approved-for-session" => ReviewDecision::ApprovedForSession,
                        "approved" => ReviewDecision::Approved,
                        _ => ReviewDecision::Abort,
                    },
                    RequestPermissionOutcome::Cancelled => ReviewDecision::Abort,
                    _ => ReviewDecision::Abort,
                };

                self.thread
                    .submit(Op::PatchApproval {
                        id: call_id,
                        decision,
                    })
                    .await
                    .map_err(|e| Error::from(anyhow::anyhow!(e)))?;
            }
            PendingPermissionRequest::RequestPermissions {
                call_id,
                permissions,
            } => {
                let response = match outcome {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome {
                        option_id,
                        ..
                    }) => match option_id.0.as_ref() {
                        "approved-for-session" => RequestPermissionsResponse {
                            permissions,
                            scope: PermissionGrantScope::Session,
                        },
                        "approved" => RequestPermissionsResponse {
                            permissions,
                            scope: PermissionGrantScope::Turn,
                        },
                        _ => RequestPermissionsResponse {
                            permissions: RequestPermissionProfile::default(),
                            scope: PermissionGrantScope::Turn,
                        },
                    },
                    RequestPermissionOutcome::Cancelled => RequestPermissionsResponse {
                        permissions: RequestPermissionProfile::default(),
                        scope: PermissionGrantScope::Turn,
                    },
                    _ => RequestPermissionsResponse {
                        permissions: RequestPermissionProfile::default(),
                        scope: PermissionGrantScope::Turn,
                    },
                };

                self.thread
                    .submit(Op::RequestPermissionsResponse {
                        id: call_id,
                        response,
                    })
                    .await
                    .map_err(|e| Error::from(anyhow::anyhow!(e)))?;
            }
        }

        Ok(())
    }

    async fn send_status_tool_call(
        &self,
        client: &SessionClient,
        call_id: impl Into<ToolCallId>,
        kind: &str,
        title: impl Into<String>,
        detail: Option<String>,
        emphasis: &str,
        status: ToolCallStatus,
    ) {
        let mut tool_call = ToolCall::new(call_id, title)
            .kind(ToolKind::Other)
            .status(status)
            .meta(neverwrite_status_meta(kind, emphasis));

        if let Some(detail) = detail {
            tool_call = tool_call.content(vec![ToolCallContent::Content(Content::new(detail))]);
        }

        client.send_tool_call(tool_call).await;
    }

    async fn send_status_tool_call_update(
        &self,
        client: &SessionClient,
        call_id: impl Into<ToolCallId>,
        title: impl Into<String>,
        detail: Option<String>,
        status: ToolCallStatus,
    ) {
        let mut fields = ToolCallUpdateFields::new()
            .title(title.into())
            .status(status);

        if let Some(detail) = detail {
            fields = fields.content(vec![ToolCallContent::Content(Content::new(detail))]);
        }

        client
            .send_tool_call_update(ToolCallUpdate::new(call_id, fields))
            .await;
    }
    async fn emit_plan_text_update(&self, client: &SessionClient, text: &str, streaming: bool) {
        let parsed = parse_plan_text(text, streaming);
        if parsed.entries.is_empty() && parsed.title.is_none() && parsed.detail.is_none() {
            return;
        }

        client
            .update_plan_with_meta(
                parsed.entries,
                neverwrite_plan_meta(parsed.title.as_deref(), parsed.detail.as_deref()),
            )
            .await;
    }

    #[expect(clippy::too_many_lines)]
    async fn handle_event(&mut self, client: &SessionClient, event: EventMsg) {
        self.event_count += 1;

        // Complete any previous web search before starting a new one
        match &event {
            EventMsg::Error(..)
            | EventMsg::StreamError(..)
            | EventMsg::WebSearchBegin(..)
            | EventMsg::UserMessage(..)
            | EventMsg::ExecApprovalRequest(..)
            | EventMsg::RequestPermissions(..)
            | EventMsg::ExecCommandBegin(..)
            | EventMsg::ExecCommandOutputDelta(..)
            | EventMsg::ExecCommandEnd(..)
            | EventMsg::McpToolCallBegin(..)
            | EventMsg::McpToolCallEnd(..)
            | EventMsg::ApplyPatchApprovalRequest(..)
            | EventMsg::PatchApplyBegin(..)
            | EventMsg::PatchApplyEnd(..)
            | EventMsg::TurnStarted(..)
            | EventMsg::TurnComplete(..)
            | EventMsg::TurnDiff(..)
            | EventMsg::TurnAborted(..)
            | EventMsg::EnteredReviewMode(..)
            | EventMsg::ExitedReviewMode(..)
            | EventMsg::ShutdownComplete => {
                self.complete_web_search(client).await;
            }
            _ => {}
        }

        match event {
            EventMsg::TurnStarted(TurnStartedEvent {
                model_context_window,
                collaboration_mode_kind,
                turn_id,
            }) => {
                info!("Task started with context window of {turn_id} {model_context_window:?} {collaboration_mode_kind:?}");
                let detail = model_context_window.map(|size| format!("Context window: {size}"));
                self.send_status_tool_call(
                    client,
                    format!("{NEVERWRITE_STATUS_EVENT_ID_PREFIX}turn:{turn_id}"),
                    "turn_started",
                    "New turn",
                    detail,
                    "neutral",
                    ToolCallStatus::Completed,
                )
                .await;
            }
            EventMsg::TokenCount(TokenCountEvent { info, .. }) => {
                if let Some(info) = info
                    && let Some(size) = info.model_context_window {
                        let used = info.last_token_usage.tokens_in_context_window().max(0) as u64;
                        client
                            .send_notification(SessionUpdate::UsageUpdate(UsageUpdate::new(
                                used,
                                size as u64,
                            )))
                            .await;
                    }
            }
            EventMsg::ItemStarted(ItemStartedEvent { thread_id, turn_id, item }) => {
                info!("Item started with thread_id: {thread_id}, turn_id: {turn_id}, item: {item:?}");
                let (title, detail) = describe_turn_item(&item);
                self.send_status_tool_call(
                    client,
                    format!("{NEVERWRITE_STATUS_EVENT_ID_PREFIX}item:{}", turn_item_id(&item)),
                    "item_activity",
                    title,
                    detail,
                    "neutral",
                    ToolCallStatus::InProgress,
                )
                .await;
            }
            EventMsg::UserMessage(UserMessageEvent {
                message,
                images: _,
                text_elements: _,
                local_images: _,
            }) => {
                info!("User message: {message:?}");
            }
            EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent {
                thread_id,
                turn_id,
                item_id,
                delta,
            }) => {
                info!("Agent message content delta received: thread_id: {thread_id}, turn_id: {turn_id}, item_id: {item_id}, delta: {delta:?}");
                self.seen_message_deltas = true;
                client.send_agent_text(delta).await;
            }
            EventMsg::ReasoningContentDelta(ReasoningContentDeltaEvent {
                thread_id,
                turn_id,
                item_id,
                delta,
                summary_index: index,
            })
            | EventMsg::ReasoningRawContentDelta(ReasoningRawContentDeltaEvent {
                thread_id,
                turn_id,
                item_id,
                delta,
                content_index: index,
            }) => {
                info!("Agent reasoning content delta received: thread_id: {thread_id}, turn_id: {turn_id}, item_id: {item_id}, index: {index}, delta: {delta:?}");
                self.seen_reasoning_deltas = true;
                client.send_agent_thought(delta).await;
            }
            EventMsg::AgentReasoningSectionBreak(AgentReasoningSectionBreakEvent {
                item_id,
                summary_index,
            }) => {
                info!("Agent reasoning section break received:  item_id: {item_id}, index: {summary_index}");
                // Make sure the section heading actually get spacing
                self.seen_reasoning_deltas = true;
                client.send_agent_thought("\n\n").await;
            }
            EventMsg::AgentMessage(AgentMessageEvent {
                message,
                phase: _,
                ..
            }) => {
                info!("Agent message (non-delta) received: {message:?}");
                // We didn't receive this message via streaming
                if !std::mem::take(&mut self.seen_message_deltas) {
                    client.send_agent_text(message).await;
                }
            }
            EventMsg::AgentReasoning(AgentReasoningEvent { text }) => {
                info!("Agent reasoning (non-delta) received: {text:?}");
                // We didn't receive this message via streaming
                if !std::mem::take(&mut self.seen_reasoning_deltas) {
                    client.send_agent_thought(text).await;
                }
            }
            EventMsg::ThreadNameUpdated(event) => {
                info!("Thread name updated: {:?}", event.thread_name);
                if let Some(title) = event.thread_name {
                    client
                        .send_notification(SessionUpdate::SessionInfoUpdate(
                            SessionInfoUpdate::new().title(title),
                        ))
                        .await;
                }
            }
            EventMsg::PlanUpdate(UpdatePlanArgs { explanation, plan }) => {
                // Send this to the client via session/update notification
                info!("Agent plan updated. Explanation: {:?}", explanation);
                client
                    .update_plan_with_meta(
                        plan,
                        neverwrite_plan_meta(None, explanation.as_deref()),
                    )
                    .await;
            }
            EventMsg::PlanDelta(PlanDeltaEvent {
                thread_id,
                turn_id,
                item_id,
                delta,
            }) => {
                info!(
                    "Plan delta received: thread_id: {thread_id}, turn_id: {turn_id}, item_id: {item_id}, delta: {delta:?}"
                );
                let plan_text = {
                    let plan_text = self.active_plan_text.entry(item_id).or_default();
                    plan_text.push_str(&delta);
                    plan_text.clone()
                };
                self.emit_plan_text_update(client, &plan_text, true).await;
            }
            EventMsg::WebSearchBegin(WebSearchBeginEvent { call_id }) => {
                info!("Web search started: call_id={}", call_id);
                // Create a ToolCall notification for the search beginning
                self.start_web_search(client, call_id).await;
            }
            EventMsg::WebSearchEnd(WebSearchEndEvent {
                call_id,
                query,
                action,
            }) => {
                info!("Web search query received: call_id={call_id}, query={query}");
                // Send update that the search is in progress with the query
                // (WebSearchEnd just means we have the query, not that results are ready)
                self.update_web_search_query(client, call_id, query, action)
                    .await;
                // The actual search results will come through AgentMessage events
                // We mark as completed when a new tool call begins
            }
            EventMsg::ExecApprovalRequest(event) => {
                info!(
                    "Command execution started: call_id={}, command={:?}",
                    event.call_id, event.command
                );
                if let Err(err) = self.exec_approval(client, event).await
                    && let Some(response_tx) = self.response_tx.take()
                {
                    drop(response_tx.send(Err(err)));
                }
            }
            EventMsg::ExecCommandBegin(event) => {
                info!(
                    "Command execution started: call_id={}, command={:?}",
                    event.call_id, event.command
                );
                self.exec_command_begin(client, event).await;
            }
            EventMsg::ExecCommandOutputDelta(delta_event) => {
                self.exec_command_output_delta(client, delta_event).await;
            }
            EventMsg::ExecCommandEnd(end_event) => {
                info!(
                    "Command execution ended: call_id={}, exit_code={}",
                    end_event.call_id, end_event.exit_code
                );
                self.exec_command_end(client, end_event).await;
            }
            EventMsg::TerminalInteraction(event) => {
                info!(
                    "Terminal interaction: call_id={}, process_id={}, stdin={}",
                    event.call_id, event.process_id, event.stdin
                );
                self.terminal_interaction(client, event).await;
            }
            EventMsg::DynamicToolCallRequest(DynamicToolCallRequest { call_id, turn_id, tool, arguments }) => {
                info!("Dynamic tool call request: call_id={call_id}, turn_id={turn_id}, tool={tool}");
                self.start_dynamic_tool_call(client, call_id, tool, arguments).await;
            }
            EventMsg::DynamicToolCallResponse(event) => {
                info!(
                    "Dynamic tool call response: call_id={}, turn_id={}, tool={}",
                    event.call_id, event.turn_id, event.tool
                );
                self.end_dynamic_tool_call(client, event).await;
            }
            EventMsg::McpToolCallBegin(McpToolCallBeginEvent {
                call_id,
                invocation,
            }) => {
                info!(
                    "MCP tool call begin: call_id={call_id}, invocation={} {}",
                    invocation.server, invocation.tool
                );
                self.start_mcp_tool_call(client, call_id, invocation).await;
            }
            EventMsg::McpToolCallEnd(McpToolCallEndEvent {
                call_id,
                invocation,
                duration,
                result,
            }) => {
                info!(
                    "MCP tool call ended: call_id={call_id}, invocation={} {}, duration={duration:?}",
                    invocation.server, invocation.tool
                );
                self.end_mcp_tool_call(client, call_id, result).await;
            }
            EventMsg::ApplyPatchApprovalRequest(event) => {
                info!(
                    "Apply patch approval request: call_id={}, reason={:?}",
                    event.call_id, event.reason
                );
                if let Err(err) = self.patch_approval(client, event).await
                    && let Some(response_tx) = self.response_tx.take()
                {
                    drop(response_tx.send(Err(err)));
                }
            }
            EventMsg::RequestPermissions(event) => {
                info!(
                    "Request permissions: call_id={}, turn_id={}, reason={:?}",
                    event.call_id, event.turn_id, event.reason
                );
                if let Err(err) = self.request_permissions(client, event).await
                    && let Some(response_tx) = self.response_tx.take()
                {
                    drop(response_tx.send(Err(err)));
                }
            }
            EventMsg::PatchApplyBegin(event) => {
                info!(
                    "Patch apply begin: call_id={}, auto_approved={}",
                    event.call_id, event.auto_approved
                );
                self.start_patch_apply(client, event).await;
            }
            EventMsg::PatchApplyEnd(event) => {
                info!(
                    "Patch apply end: call_id={}, success={}",
                    event.call_id, event.success
                );
                self.end_patch_apply(client, event).await;
            }
            EventMsg::ItemCompleted(ItemCompletedEvent {
                thread_id,
                turn_id,
                item,
            }) => {
                info!("Item completed: thread_id={}, turn_id={}, item={:?}", thread_id, turn_id, item);
                if let TurnItem::Plan(plan_item) = &item {
                    let buffered_text = self.active_plan_text.remove(&plan_item.id);
                    let final_text = if !plan_item.text.trim().is_empty() {
                        plan_item.text.clone()
                    } else {
                        buffered_text.unwrap_or_default()
                    };
                    self.emit_plan_text_update(client, &final_text, false).await;
                }
                let (title, detail) = describe_turn_item(&item);
                self.send_status_tool_call_update(
                    client,
                    format!("{NEVERWRITE_STATUS_EVENT_ID_PREFIX}item:{}", turn_item_id(&item)),
                    title,
                    detail,
                    ToolCallStatus::Completed,
                )
                .await;
                // Notify the client when context compaction completes so users see
                // a status message rather than silence during /compact.
                if matches!(item, TurnItem::ContextCompaction(..)) {
                    client.send_agent_text("Context compacted".to_string()).await;
                }
            }
            EventMsg::TurnComplete(TurnCompleteEvent { last_agent_message, turn_id }) => {
                info!(
                    "Task {turn_id} completed successfully after {} events. Last agent message: {last_agent_message:?}",
                    self.event_count
                );
                self.abort_pending_interactions();
                if let Some(response_tx) = self.response_tx.take() {
                    response_tx.send(Ok(StopReason::EndTurn)).ok();
                }
            }
            EventMsg::UndoStarted(event) => {
                client
                    .send_agent_text(
                        event
                            .message
                            .unwrap_or_else(|| "Undo in progress...".to_string()),
                    )
                    .await;
            }
            EventMsg::UndoCompleted(event) => {
                let fallback = if event.success {
                    "Undo completed.".to_string()
                } else {
                    "Undo failed.".to_string()
                };
                client.send_agent_text(event.message.unwrap_or(fallback)).await;
            }
            EventMsg::StreamError(StreamErrorEvent {
                message,
                codex_error_info,
                additional_details,
            }) => {
                error!(
                    "Handled error during turn: {message} {codex_error_info:?} {additional_details:?}"
                );
                let detail = additional_details
                    .filter(|details| !details.trim().is_empty())
                    .unwrap_or_else(|| message.clone());
                self.send_status_tool_call(
                    client,
                    format!("{NEVERWRITE_STATUS_EVENT_ID_PREFIX}stream_error:{}", self.event_count),
                    "stream_error",
                    "Streaming interrupted",
                    Some(detail),
                    "error",
                    ToolCallStatus::Failed,
                )
                .await;
            }
            EventMsg::Error(ErrorEvent {
                message,
                codex_error_info,
            }) => {
                error!("Unhandled error during turn: {message} {codex_error_info:?}");
                self.abort_pending_interactions();
                if let Some(response_tx) = self.response_tx.take() {
                    response_tx
                        .send(Err(Error::internal_error().data(
                            json!({ "message": message, "codex_error_info": codex_error_info }),
                        )))
                        .ok();
                }
            }
            EventMsg::TurnAborted(TurnAbortedEvent { reason, turn_id }) => {
                info!("Turn {turn_id:?} aborted: {reason:?}");
                self.abort_pending_interactions();
                if let Some(response_tx) = self.response_tx.take() {
                    response_tx.send(Ok(StopReason::Cancelled)).ok();
                }
            }
            EventMsg::ShutdownComplete => {
                info!("Agent shutting down");
                self.abort_pending_interactions();
                if let Some(response_tx) = self.response_tx.take() {
                    response_tx.send(Ok(StopReason::Cancelled)).ok();
                }
            }
            EventMsg::ViewImageToolCall(ViewImageToolCallEvent { call_id, path }) => {
                info!("ViewImageToolCallEvent received");
                let display_path = path.display().to_string();
                client
                    .send_notification(
                        SessionUpdate::ToolCall(
                            ToolCall::new(call_id, format!("View Image {display_path}"))
                                .kind(ToolKind::Read).status(ToolCallStatus::Completed)
                                .content(vec![ToolCallContent::Content(Content::new(ContentBlock::ResourceLink(ResourceLink::new(display_path.clone(), display_path.clone())
                            )
                        )
                    )]).locations(vec![ToolCallLocation::new(path)])))
                    .await;
            }
            EventMsg::EnteredReviewMode(review_request) => {
                info!("Review begin: request={review_request:?}");
                self.send_status_tool_call(
                    client,
                    format!("{NEVERWRITE_STATUS_EVENT_ID_PREFIX}review:{}", self.event_count),
                    "review_mode",
                    "Review mode active",
                    Some(format_review_target(&review_request.target)),
                    "info",
                    ToolCallStatus::Completed,
                )
                .await;
            }
            EventMsg::ExitedReviewMode(event) => {
                info!("Review end: output={event:?}");
                if let Err(err) = self.review_mode_exit(client, event).await
                    && let Some(response_tx) = self.response_tx.take()
                {
                    drop(response_tx.send(Err(err)));
                }
            }
            EventMsg::Warning(WarningEvent { message }) => {
                warn!("Warning: {message}");
                // Forward warnings to the client as agent messages so users see
                // informational notices (e.g., the post-compact advisory message).
                client.send_agent_text(message).await;
            }
            EventMsg::McpStartupUpdate(McpStartupUpdateEvent { server, status }) => {
                info!("MCP startup update: server={server}, status={status:?}");
            }
            EventMsg::McpStartupComplete(McpStartupCompleteEvent {
                ready,
                failed,
                cancelled,
            }) => {
                info!(
                    "MCP startup complete: ready={ready:?}, failed={failed:?}, cancelled={cancelled:?}"
                );
            }
            EventMsg::ElicitationRequest(event) => {
                info!(
                    "Elicitation request: server={}, id={:?}, message={}",
                    event.server_name,
                    event.id,
                    event.request.message()
                );
                if let Err(err) = self.mcp_elicitation(client, event).await
                    && let Some(response_tx) = self.response_tx.take()
                {
                    drop(response_tx.send(Err(err)));
                }
            }
            EventMsg::ModelReroute(ModelRerouteEvent { from_model, to_model, reason }) => {
                info!("Model reroute: from={from_model}, to={to_model}, reason={reason:?}");
                let reason = match reason {
                    codex_protocol::protocol::ModelRerouteReason::HighRiskCyberActivity => {
                        Some("High-risk cyber activity".to_string())
                    }
                };
                let detail = reason
                    .map(|reason| format!("{from_model} -> {to_model}. {reason}"))
                    .or_else(|| Some(format!("{from_model} -> {to_model}")));
                self.send_status_tool_call(
                    client,
                    format!("{NEVERWRITE_STATUS_EVENT_ID_PREFIX}model_reroute:{}", self.event_count),
                    "model_reroute",
                    format!("Switched to {to_model}"),
                    detail,
                    "info",
                    ToolCallStatus::Completed,
                )
                .await;
            }
            EventMsg::RequestUserInput(event) => {
                info!(
                    "RequestUserInput: call_id={}, turn_id={}, questions={}",
                    event.call_id,
                    event.turn_id,
                    event.questions.len()
                );
                let title = event
                    .questions
                    .first()
                    .map(|question| question.header.clone())
                    .filter(|header| !header.trim().is_empty())
                    .unwrap_or_else(|| "Input requested".to_string());
                let detail = summarize_user_input_questions(&event.questions);
                client
                    .send_tool_call(
                        ToolCall::new(event.call_id.clone(), title)
                            .kind(ToolKind::Other)
                            .status(ToolCallStatus::Pending)
                            .content(
                                detail
                                    .into_iter()
                                    .map(|text| ToolCallContent::Content(Content::new(text)))
                                    .collect(),
                            )
                            .raw_input(json!({
                                "request_id": event.call_id,
                                "turn_id": event.turn_id,
                                "questions": event.questions,
                            }))
                            .meta(neverwrite_user_input_meta()),
                    )
                    .await;
            }

            EventMsg::ContextCompacted(..) => {
                info!("Context compacted");
                client.send_agent_text("Context compacted".to_string()).await;
            }

            // Ignore these events
            EventMsg::AgentReasoningRawContent(..)
            | EventMsg::ThreadRolledBack(..)
            // we already have a way to diff the turn, so ignore
            | EventMsg::TurnDiff(..)
            // Revisit when we can emit status updates
            | EventMsg::BackgroundEvent(..)
            | EventMsg::SkillsUpdateAvailable
            // Old events
            | EventMsg::AgentMessageDelta(..)
            | EventMsg::AgentReasoningDelta(..)
            | EventMsg::AgentReasoningRawContentDelta(..)
            | EventMsg::RawResponseItem(..)
            | EventMsg::SessionConfigured(..)
            // TODO: Subagent UI?
            | EventMsg::CollabAgentSpawnBegin(..)
            | EventMsg::CollabAgentSpawnEnd(..)
            | EventMsg::CollabAgentInteractionBegin(..)
            | EventMsg::CollabAgentInteractionEnd(..)
            | EventMsg::RealtimeConversationStarted(..)
            | EventMsg::RealtimeConversationRealtime(..)
            | EventMsg::RealtimeConversationClosed(..)
            | EventMsg::CollabWaitingBegin(..)
            | EventMsg::CollabWaitingEnd(..)
            | EventMsg::CollabResumeBegin(..)
            | EventMsg::CollabResumeEnd(..)
            | EventMsg::CollabCloseBegin(..)
            | EventMsg::CollabCloseEnd(..)
            | EventMsg::ImageGenerationBegin(..)
            | EventMsg::ImageGenerationEnd(..)
            | EventMsg::GuardianAssessment(..)
            | EventMsg::HookStarted(..)
            | EventMsg::HookCompleted(..) => {}
            e @ (EventMsg::McpListToolsResponse(..)
            // returned from Op::ListCustomPrompts, ignore
            | EventMsg::ListCustomPromptsResponse(..)
            | EventMsg::ListSkillsResponse(..)
            // Used for returning a single history entry
            | EventMsg::GetHistoryEntryResponse(..)
            | EventMsg::DeprecationNotice(..)) => {
                warn!("Unexpected event: {:?}", e);
            }
        }
    }

    async fn mcp_elicitation(
        &self,
        client: &SessionClient,
        event: ElicitationRequestEvent,
    ) -> Result<(), Error> {
        let raw_input = serde_json::json!(&event);
        let ElicitationRequestEvent {
            server_name,
            id,
            request,
            ..
        } = event;
        let tool_call_id = ToolCallId::new(match &id {
            codex_protocol::mcp::RequestId::String(s) => s.clone(),
            codex_protocol::mcp::RequestId::Integer(i) => i.to_string(),
        });
        let response = client
            .request_permission(
                ToolCallUpdate::new(
                    tool_call_id.clone(),
                    ToolCallUpdateFields::new()
                        .title(server_name.clone())
                        .status(ToolCallStatus::Pending)
                        .content(vec![request.message().to_string().into()])
                        .raw_input(raw_input),
                ),
                vec![
                    PermissionOption::new(
                        "approved",
                        "Yes, provide the requested info",
                        PermissionOptionKind::AllowOnce,
                    ),
                    PermissionOption::new(
                        "abort",
                        "No, but continue without it",
                        PermissionOptionKind::RejectOnce,
                    ),
                    PermissionOption::new(
                        "cancel",
                        "Cancel this request",
                        PermissionOptionKind::RejectOnce,
                    ),
                ],
            )
            .await?;

        let decision = match response.outcome {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome { option_id, .. }) => {
                match option_id.0.as_ref() {
                    "approved" => ElicitationAction::Accept,
                    "abort" => ElicitationAction::Decline,
                    _ => ElicitationAction::Cancel,
                }
            }
            RequestPermissionOutcome::Cancelled | _ => ElicitationAction::Cancel,
        };

        self.thread
            .submit(Op::ResolveElicitation {
                server_name,
                request_id: id,
                decision,
                content: None,
                meta: None,
            })
            .await
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;

        client
            .send_notification(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                tool_call_id,
                ToolCallUpdateFields::new().status(if decision == ElicitationAction::Accept {
                    ToolCallStatus::Completed
                } else {
                    ToolCallStatus::Failed
                }),
            )))
            .await;

        Ok(())
    }

    async fn request_permissions(
        &mut self,
        client: &SessionClient,
        event: RequestPermissionsEvent,
    ) -> Result<(), Error> {
        let raw_input = serde_json::json!(&event);
        let RequestPermissionsEvent {
            call_id,
            turn_id: _,
            reason,
            permissions,
        } = event;

        let content = vec![
            reason
                .filter(|value| !value.trim().is_empty())
                .map(ToolCallContent::from),
            format_permission_rule(&permissions).map(ToolCallContent::from),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

        self.spawn_permission_request(
            client,
            call_id.clone(),
            PendingPermissionRequest::RequestPermissions {
                call_id: call_id.clone(),
                permissions,
            },
            ToolCallUpdate::new(
                call_id,
                ToolCallUpdateFields::new()
                    .kind(ToolKind::Other)
                    .status(ToolCallStatus::Pending)
                    .title("Grant permissions")
                    .raw_input(raw_input)
                    .content((!content.is_empty()).then_some(content)),
            ),
            vec![
                PermissionOption::new(
                    "approved",
                    "Yes, grant these permissions",
                    PermissionOptionKind::AllowOnce,
                ),
                PermissionOption::new(
                    "approved-for-session",
                    "Yes, grant these permissions for this session",
                    PermissionOptionKind::AllowAlways,
                ),
                PermissionOption::new(
                    "denied",
                    "No, continue without permissions",
                    PermissionOptionKind::RejectOnce,
                ),
            ],
        );

        Ok(())
    }

    async fn review_mode_exit(
        &self,
        client: &SessionClient,
        event: ExitedReviewModeEvent,
    ) -> Result<(), Error> {
        let ExitedReviewModeEvent { review_output } = event;
        let Some(ReviewOutputEvent {
            findings,
            overall_correctness: _,
            overall_explanation,
            overall_confidence_score: _,
        }) = review_output
        else {
            return Ok(());
        };

        let text = if findings.is_empty() {
            let explanation = overall_explanation.trim();
            if explanation.is_empty() {
                "Reviewer failed to output a response"
            } else {
                explanation
            }
            .to_string()
        } else {
            format_review_findings_block(&findings, None)
        };

        client.send_agent_text(&text).await;
        Ok(())
    }

    async fn patch_approval(
        &mut self,
        client: &SessionClient,
        event: ApplyPatchApprovalRequestEvent,
    ) -> Result<(), Error> {
        let raw_input = serde_json::json!(&event);
        let ApplyPatchApprovalRequestEvent {
            call_id,
            changes,
            reason,
            // grant_root doesn't seem to be set anywhere on the codex side
            grant_root: _,
            turn_id: _,
        } = event;
        let (title, locations, content) = extract_tool_call_content_from_changes(changes);
        self.spawn_permission_request(
            client,
            call_id.clone(),
            PendingPermissionRequest::Patch {
                call_id: call_id.clone(),
            },
            ToolCallUpdate::new(
                call_id.clone(),
                ToolCallUpdateFields::new()
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::Pending)
                    .title(title)
                    .locations(locations)
                    .content(content.chain(reason.map(|r| r.into())).collect::<Vec<_>>())
                    .raw_input(raw_input),
            ),
            vec![
                PermissionOption::new(
                    "approved-for-session",
                    "Always",
                    PermissionOptionKind::AllowAlways,
                ),
                PermissionOption::new("approved", "Yes", PermissionOptionKind::AllowOnce),
                PermissionOption::new(
                    "abort",
                    "No, provide feedback",
                    PermissionOptionKind::RejectOnce,
                ),
            ],
        );
        Ok(())
    }

    async fn start_patch_apply(&self, client: &SessionClient, event: PatchApplyBeginEvent) {
        let raw_input = serde_json::json!(&event);
        let PatchApplyBeginEvent {
            call_id,
            auto_approved: _,
            changes,
            turn_id: _,
        } = event;

        let (title, locations, content) = extract_tool_call_content_from_changes(changes);

        client
            .send_tool_call(
                ToolCall::new(call_id, title)
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::InProgress)
                    .locations(locations)
                    .content(content.collect())
                    .raw_input(raw_input),
            )
            .await;
    }

    async fn end_patch_apply(&self, client: &SessionClient, event: PatchApplyEndEvent) {
        let raw_output = serde_json::json!(&event);
        let PatchApplyEndEvent {
            call_id,
            stdout: _,
            stderr: _,
            success,
            changes,
            turn_id: _,
            status,
        } = event;

        let (title, locations, content) = if !changes.is_empty() {
            let (title, locations, content) = extract_tool_call_content_from_changes(changes);
            (Some(title), Some(locations), Some(content.collect()))
        } else {
            (None, None, None)
        };

        let status = match status {
            PatchApplyStatus::Completed => ToolCallStatus::Completed,
            _ if success => ToolCallStatus::Completed,
            PatchApplyStatus::Failed | PatchApplyStatus::Declined => ToolCallStatus::Failed,
        };

        client
            .send_tool_call_update(ToolCallUpdate::new(
                call_id,
                ToolCallUpdateFields::new()
                    .status(status)
                    .raw_output(raw_output)
                    .title(title)
                    .locations(locations)
                    .content(content),
            ))
            .await;
    }

    async fn start_dynamic_tool_call(
        &self,
        client: &SessionClient,
        call_id: String,
        tool: String,
        arguments: serde_json::Value,
    ) {
        client
            .send_tool_call(
                ToolCall::new(call_id, format!("Tool: {tool}"))
                    .status(ToolCallStatus::InProgress)
                    .raw_input(serde_json::json!(&arguments)),
            )
            .await;
    }

    async fn start_mcp_tool_call(
        &self,
        client: &SessionClient,
        call_id: String,
        invocation: McpInvocation,
    ) {
        let title = format!("Tool: {}/{}", invocation.server, invocation.tool);
        client
            .send_tool_call(
                ToolCall::new(call_id, title)
                    .status(ToolCallStatus::InProgress)
                    .raw_input(serde_json::json!(&invocation)),
            )
            .await;
    }

    async fn end_dynamic_tool_call(
        &self,
        client: &SessionClient,
        event: DynamicToolCallResponseEvent,
    ) {
        let raw_output = serde_json::json!(event);
        let DynamicToolCallResponseEvent {
            call_id,
            turn_id: _,
            tool: _,
            arguments: _,
            content_items,
            success,
            error,
            duration: _,
        } = event;

        client
            .send_tool_call_update(ToolCallUpdate::new(
                call_id,
                ToolCallUpdateFields::new()
                    .status(if success {
                        ToolCallStatus::Completed
                    } else {
                        ToolCallStatus::Failed
                    })
                    .raw_output(raw_output)
                    .content(
                        content_items
                            .into_iter()
                            .map(|item| match item {
                                DynamicToolCallOutputContentItem::InputText { text } => {
                                    ToolCallContent::Content(Content::new(text))
                                }
                                DynamicToolCallOutputContentItem::InputImage { image_url } => {
                                    ToolCallContent::Content(Content::new(
                                        ContentBlock::ResourceLink(ResourceLink::new(
                                            image_url.clone(),
                                            image_url,
                                        )),
                                    ))
                                }
                            })
                            .chain(error.map(|e| ToolCallContent::Content(Content::new(e))))
                            .collect::<Vec<_>>(),
                    ),
            ))
            .await;
    }

    async fn end_mcp_tool_call(
        &self,
        client: &SessionClient,
        call_id: String,
        result: Result<CallToolResult, String>,
    ) {
        let is_error = match result.as_ref() {
            Ok(result) => result.is_error.unwrap_or_default(),
            Err(_) => true,
        };
        let raw_output = match result.as_ref() {
            Ok(result) => serde_json::json!(result),
            Err(err) => serde_json::json!(err),
        };

        client
            .send_tool_call_update(ToolCallUpdate::new(
                call_id,
                ToolCallUpdateFields::new()
                    .status(if is_error {
                        ToolCallStatus::Failed
                    } else {
                        ToolCallStatus::Completed
                    })
                    .raw_output(raw_output)
                    .content(result.ok().filter(|result| !result.content.is_empty()).map(
                        |result| {
                            result
                                .content
                                .into_iter()
                                .filter_map(|content| {
                                    serde_json::from_value::<ContentBlock>(content).ok()
                                })
                                .map(|content| ToolCallContent::Content(Content::new(content)))
                                .collect()
                        },
                    )),
            ))
            .await;
    }

    async fn exec_approval(
        &mut self,
        client: &SessionClient,
        event: ExecApprovalRequestEvent,
    ) -> Result<(), Error> {
        let raw_input = serde_json::json!(&event);
        let ExecApprovalRequestEvent {
            call_id,
            command: _,
            turn_id,
            cwd,
            reason,
            parsed_cmd,
            proposed_execpolicy_amendment,
            approval_id,
            network_approval_context,
            additional_permissions,
            available_decisions,
            proposed_network_policy_amendments,
            ..
        } = event;

        // Create a new tool call for the command execution
        let tool_call_id = ToolCallId::new(call_id.clone());
        let ParseCommandToolCall {
            title,
            terminal_output,
            file_extension,
            locations,
            kind,
        } = parse_command_tool_call(parsed_cmd, &cwd);
        self.active_commands.insert(
            call_id.clone(),
            ActiveCommand {
                terminal_output,
                tool_call_id: tool_call_id.clone(),
                output: String::new(),
                file_extension,
                file_snapshots: HashMap::new(),
            },
        );

        let mut content = vec![];

        if let Some(reason) = reason {
            content.push(reason);
        }
        if let Some(amendment) = proposed_execpolicy_amendment {
            content.push(format!(
                "Proposed Amendment: {}",
                amendment.command().join("\n")
            ));
        }
        if let Some(policy) = network_approval_context {
            let NetworkApprovalContext { host, protocol } = policy;
            content.push(format!("Network Approval Context: {:?} {}", protocol, host));
        }
        if let Some(permissions) = additional_permissions {
            content.push(format!(
                "Additional Permissions: {}",
                serde_json::to_string_pretty(&permissions)?
            ));
        }
        if let Some(decisions) = available_decisions {
            content.push(format!(
                "Available Decisions: {}",
                decisions.into_iter().map(|d| d.to_string()).join("\n")
            ));
        }
        if let Some(amendments) = proposed_network_policy_amendments {
            content.push(format!(
                "Proposed Network Policy Amendments: {}",
                amendments
                    .into_iter()
                    .map(|NetworkPolicyAmendment { host, action }| format!(
                        "{:?} {:?}",
                        action, host
                    ))
                    .join("\n")
            ));
        }

        let content = if content.is_empty() {
            None
        } else {
            Some(vec![content.join("\n").into()])
        };

        self.spawn_permission_request(
            client,
            call_id.clone(),
            PendingPermissionRequest::Exec {
                approval_id: approval_id.unwrap_or(call_id.clone()),
                turn_id,
            },
            ToolCallUpdate::new(
                tool_call_id,
                ToolCallUpdateFields::new()
                    .kind(kind)
                    .status(ToolCallStatus::Pending)
                    .title(title)
                    .raw_input(raw_input)
                    .content(content)
                    .locations(if locations.is_empty() {
                        None
                    } else {
                        Some(locations)
                    }),
            ),
            vec![
                PermissionOption::new(
                    "approved-for-session",
                    "Always",
                    PermissionOptionKind::AllowAlways,
                ),
                PermissionOption::new("approved", "Yes", PermissionOptionKind::AllowOnce),
                PermissionOption::new(
                    "abort",
                    "No, provide feedback",
                    PermissionOptionKind::RejectOnce,
                ),
            ],
        );

        Ok(())
    }

    async fn exec_command_begin(&mut self, client: &SessionClient, event: ExecCommandBeginEvent) {
        let raw_input = serde_json::json!(&event);
        let ExecCommandBeginEvent {
            turn_id: _,
            source: _,
            interaction_input: _,
            call_id,
            command,
            cwd,
            parsed_cmd,
            process_id: _,
        } = event;
        // Create a new tool call for the command execution
        let tool_call_id = ToolCallId::new(call_id.clone());
        let ParseCommandToolCall {
            title,
            file_extension,
            locations,
            terminal_output,
            kind,
        } = parse_command_tool_call(parsed_cmd, &cwd);

        // Snapshot candidate files before the command modifies them
        let candidate_paths = extract_candidate_paths_from_command(&command, &cwd);
        let mut file_snapshots = HashMap::new();
        for path in candidate_paths {
            file_snapshots.insert(path.clone(), read_text_snapshot(&path));
        }

        let active_command = ActiveCommand {
            tool_call_id: tool_call_id.clone(),
            output: String::new(),
            file_extension,
            terminal_output,
            file_snapshots,
        };
        let (content, meta) = if client.supports_terminal_output(&active_command) {
            let content = vec![ToolCallContent::Terminal(Terminal::new(call_id.clone()))];
            let meta = Some(Meta::from_iter([(
                "terminal_info".to_owned(),
                serde_json::json!({
                    "terminal_id": call_id,
                    "cwd": cwd
                }),
            )]));
            (content, meta)
        } else {
            (vec![], None)
        };

        self.active_commands.insert(call_id.clone(), active_command);

        client
            .send_tool_call(
                ToolCall::new(tool_call_id, title)
                    .kind(kind)
                    .status(ToolCallStatus::InProgress)
                    .locations(locations)
                    .raw_input(raw_input)
                    .content(content)
                    .meta(meta),
            )
            .await;
    }

    async fn exec_command_output_delta(
        &mut self,
        client: &SessionClient,
        event: ExecCommandOutputDeltaEvent,
    ) {
        let ExecCommandOutputDeltaEvent {
            call_id,
            chunk,
            stream: _,
        } = event;
        // Stream output bytes to the display-only terminal via ToolCallUpdate meta.
        if let Some(active_command) = self.active_commands.get_mut(&call_id) {
            let data_str = String::from_utf8_lossy(&chunk).to_string();

            let update = if client.supports_terminal_output(active_command) {
                ToolCallUpdate::new(
                    active_command.tool_call_id.clone(),
                    ToolCallUpdateFields::new(),
                )
                .meta(Meta::from_iter([(
                    "terminal_output".to_owned(),
                    serde_json::json!({
                        "terminal_id": call_id,
                        "data": data_str
                    }),
                )]))
            } else {
                active_command.output.push_str(&data_str);
                let content = match active_command.file_extension.as_deref() {
                    Some("md") => active_command.output.clone(),
                    Some(ext) => format!(
                        "```{ext}\n{}\n```\n",
                        active_command.output.trim_end_matches('\n')
                    ),
                    None => format!(
                        "```sh\n{}\n```\n",
                        active_command.output.trim_end_matches('\n')
                    ),
                };
                ToolCallUpdate::new(
                    active_command.tool_call_id.clone(),
                    ToolCallUpdateFields::new().content(vec![content.into()]),
                )
            };

            client.send_tool_call_update(update).await;
        }
    }

    async fn exec_command_end(&mut self, client: &SessionClient, event: ExecCommandEndEvent) {
        let raw_output = serde_json::json!(&event);
        let ExecCommandEndEvent {
            turn_id: _,
            command: _,
            cwd: _,
            parsed_cmd: _,
            source: _,
            interaction_input: _,
            call_id,
            exit_code,
            stdout: _,
            stderr: _,
            aggregated_output: _,
            duration: _,
            formatted_output: _,
            process_id: _,
            status,
        } = event;
        if let Some(active_command) = self.active_commands.remove(&call_id) {
            let is_success = exit_code == 0;

            let status = match status {
                ExecCommandStatus::Completed => ToolCallStatus::Completed,
                _ if is_success => ToolCallStatus::Completed,
                ExecCommandStatus::Failed | ExecCommandStatus::Declined => ToolCallStatus::Failed,
            };

            // Collect diffs by comparing file snapshots with current state on disk
            let exec_diffs = if !active_command.file_snapshots.is_empty() {
                collect_exec_file_diffs(&active_command.file_snapshots)
            } else {
                vec![]
            };

            // When diffs are found, reconstruct the full content array (existing
            // output + diffs) because setting content replaces the existing items.
            // When there are no diffs, leave content as None to preserve existing.
            let content: Option<Vec<ToolCallContent>> = if !exec_diffs.is_empty() {
                let mut items: Vec<ToolCallContent> = Vec::new();
                if client.supports_terminal_output(&active_command) {
                    items.push(ToolCallContent::Terminal(Terminal::new(call_id.clone())));
                } else if !active_command.output.is_empty() {
                    let text = match active_command.file_extension.as_deref() {
                        Some("md") => active_command.output.clone(),
                        Some(ext) => format!(
                            "```{ext}\n{}\n```\n",
                            active_command.output.trim_end_matches('\n')
                        ),
                        None => format!(
                            "```sh\n{}\n```\n",
                            active_command.output.trim_end_matches('\n')
                        ),
                    };
                    items.push(text.into());
                }
                items.extend(exec_diffs);
                Some(items)
            } else {
                None
            };

            let fields = ToolCallUpdateFields::new()
                .status(status)
                .raw_output(raw_output)
                .content(content);

            client
                .send_tool_call_update(
                    ToolCallUpdate::new(active_command.tool_call_id.clone(), fields).meta(
                        client.supports_terminal_output(&active_command).then(|| {
                            Meta::from_iter([(
                                "terminal_exit".into(),
                                serde_json::json!({
                                    "terminal_id": call_id,
                                    "exit_code": exit_code,
                                    "signal": null
                                }),
                            )])
                        }),
                    ),
                )
                .await;
        }
    }

    async fn terminal_interaction(
        &mut self,
        client: &SessionClient,
        event: TerminalInteractionEvent,
    ) {
        let TerminalInteractionEvent {
            call_id,
            process_id: _,
            stdin,
        } = event;

        let stdin = format!("\n{stdin}\n");
        // Stream output bytes to the display-only terminal via ToolCallUpdate meta.
        if let Some(active_command) = self.active_commands.get_mut(&call_id) {
            let update = if client.supports_terminal_output(active_command) {
                ToolCallUpdate::new(
                    active_command.tool_call_id.clone(),
                    ToolCallUpdateFields::new(),
                )
                .meta(Meta::from_iter([(
                    "terminal_output".to_owned(),
                    serde_json::json!({
                        "terminal_id": call_id,
                        "data": stdin
                    }),
                )]))
            } else {
                active_command.output.push_str(&stdin);
                let content = match active_command.file_extension.as_deref() {
                    Some("md") => active_command.output.clone(),
                    Some(ext) => format!(
                        "```{ext}\n{}\n```\n",
                        active_command.output.trim_end_matches('\n')
                    ),
                    None => format!(
                        "```sh\n{}\n```\n",
                        active_command.output.trim_end_matches('\n')
                    ),
                };
                ToolCallUpdate::new(
                    active_command.tool_call_id.clone(),
                    ToolCallUpdateFields::new().content(vec![content.into()]),
                )
            };

            client.send_tool_call_update(update).await;
        }
    }

    async fn start_web_search(&mut self, client: &SessionClient, call_id: String) {
        self.active_web_search = Some(call_id.clone());
        client
            .send_tool_call(ToolCall::new(call_id, "Searching the Web").kind(ToolKind::Fetch))
            .await;
    }

    async fn update_web_search_query(
        &self,
        client: &SessionClient,
        call_id: String,
        query: String,
        action: WebSearchAction,
    ) {
        let title = match &action {
            WebSearchAction::Search { query, queries } => queries
                .as_ref()
                .map(|q| format!("Searching for: {}", q.join(", ")))
                .or_else(|| query.as_ref().map(|q| format!("Searching for: {q}")))
                .unwrap_or_else(|| "Web search".to_string()),
            WebSearchAction::OpenPage { url } => url
                .as_ref()
                .map(|u| format!("Opening: {u}"))
                .unwrap_or_else(|| "Open page".to_string()),
            WebSearchAction::FindInPage { pattern, url } => match (pattern, url) {
                (Some(p), Some(u)) => format!("Finding: {p} in {u}"),
                (Some(p), None) => format!("Finding: {p}"),
                (None, Some(u)) => format!("Find in page: {u}"),
                (None, None) => "Find in page".to_string(),
            },
            WebSearchAction::Other => "Web search".to_string(),
        };

        client
            .send_tool_call_update(ToolCallUpdate::new(
                call_id,
                ToolCallUpdateFields::new()
                    .status(ToolCallStatus::InProgress)
                    .title(title)
                    .raw_input(serde_json::json!({
                        "query": query,
                        "action": action
                    })),
            ))
            .await;
    }

    async fn complete_web_search(&mut self, client: &SessionClient) {
        if let Some(call_id) = self.active_web_search.take() {
            client
                .send_tool_call_update(ToolCallUpdate::new(
                    call_id,
                    ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
                ))
                .await;
        }
    }
}

struct ParseCommandToolCall {
    title: String,
    file_extension: Option<String>,
    terminal_output: bool,
    locations: Vec<ToolCallLocation>,
    kind: ToolKind,
}

/// Extract candidate file paths from raw command args for pre-execution snapshots.
/// Looks at each argument after the command name and resolves paths that point to
/// existing files on disk. For `bash -c "..."` style commands, also scans the
/// inner command string for path-like tokens.
fn extract_candidate_paths_from_command(command: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if command.is_empty() {
        return paths;
    }

    let mut seen = std::collections::HashSet::new();

    let add_candidate = |token: &str,
                         cwd: &Path,
                         seen: &mut std::collections::HashSet<PathBuf>|
     -> Option<PathBuf> {
        let token = token.trim();
        if token.is_empty() || token.starts_with('-') {
            return None;
        }
        // Skip tokens that look like sed expressions, regex patterns, etc.
        if token.starts_with("s/") || token.starts_with("s|") || token.contains("///") {
            return None;
        }
        let path = Path::new(token);
        let abs = if path.is_relative() {
            cwd.join(path)
        } else {
            path.to_path_buf()
        };
        // Only track files that exist (we want to capture "before" state)
        // or whose parent exists (might be created by the command).
        let dominated = abs.is_file() || abs.parent().is_some_and(|p| p.is_dir());
        if dominated && seen.insert(abs.clone()) {
            Some(abs)
        } else {
            None
        }
    };

    // Detect bash/sh -c "..." pattern
    let is_shell_wrapper = matches!(
        command
            .first()
            .and_then(|c| Path::new(c).file_name())
            .and_then(|n| n.to_str()),
        Some("bash" | "sh" | "zsh")
    );

    if is_shell_wrapper && command.len() >= 3 && command[1] == "-c" {
        // Parse inner command string for path-like tokens
        let inner = command[2..].join(" ");
        for token in inner.split_whitespace() {
            // Strip shell redirections
            let token = token.trim_start_matches('>').trim_start_matches('<');
            if let Some(abs) = add_candidate(token, cwd, &mut seen) {
                paths.push(abs);
            }
        }
    } else {
        // Direct command: skip command name, check remaining args
        for arg in command.iter().skip(1) {
            if let Some(abs) = add_candidate(arg, cwd, &mut seen) {
                paths.push(abs);
            }
        }
    }

    paths
}

fn parse_command_tool_call(parsed_cmd: Vec<ParsedCommand>, cwd: &Path) -> ParseCommandToolCall {
    let mut titles = Vec::new();
    let mut locations = Vec::new();
    let mut file_extension = None;
    let mut terminal_output = false;
    let mut kind = ToolKind::Execute;

    for cmd in parsed_cmd {
        let mut cmd_path = None;
        match cmd {
            ParsedCommand::Read { cmd: _, name, path } => {
                titles.push(format!("Read {name}"));
                file_extension = path
                    .extension()
                    .map(|ext| ext.to_string_lossy().to_string());
                cmd_path = Some(path);
                kind = ToolKind::Read;
            }
            ParsedCommand::ListFiles { cmd: _, path } => {
                let dir = if let Some(path) = path.as_ref() {
                    &cwd.join(path)
                } else {
                    cwd
                };
                titles.push(format!("List {}", dir.display()));
                cmd_path = path.map(PathBuf::from);
                kind = ToolKind::Search;
            }
            ParsedCommand::Search { cmd, query, path } => {
                titles.push(match (query, path.as_ref()) {
                    (Some(query), Some(path)) => format!("Search {query} in {path}"),
                    (Some(query), None) => format!("Search {query}"),
                    _ => format!("Search {cmd}"),
                });
                kind = ToolKind::Search;
            }
            ParsedCommand::Unknown { cmd } => {
                titles.push(format!("Run {cmd}"));
                terminal_output = true;
            }
        }

        if let Some(path) = cmd_path {
            locations.push(ToolCallLocation::new(if path.is_relative() {
                cwd.join(&path)
            } else {
                path
            }));
        }
    }

    ParseCommandToolCall {
        title: titles.join(", "),
        file_extension,
        terminal_output,
        locations,
        kind,
    }
}

#[derive(Clone)]
struct SessionClient {
    session_id: SessionId,
    client: Arc<dyn Client>,
    client_capabilities: Arc<Mutex<ClientCapabilities>>,
}

impl SessionClient {
    fn new(session_id: SessionId, client_capabilities: Arc<Mutex<ClientCapabilities>>) -> Self {
        Self {
            session_id,
            client: ACP_CLIENT.get().expect("Client should be set").clone(),
            client_capabilities,
        }
    }

    #[cfg(test)]
    fn with_client(
        session_id: SessionId,
        client: Arc<dyn Client>,
        client_capabilities: Arc<Mutex<ClientCapabilities>>,
    ) -> Self {
        Self {
            session_id,
            client,
            client_capabilities,
        }
    }

    fn supports_terminal_output(&self, active_command: &ActiveCommand) -> bool {
        active_command.terminal_output
            && self
                .client_capabilities
                .lock()
                .unwrap()
                .meta
                .as_ref()
                .is_some_and(|v| {
                    v.get("terminal_output")
                        .is_some_and(|v| v.as_bool().unwrap_or_default())
                })
    }

    async fn send_notification(&self, update: SessionUpdate) {
        if let Err(e) = self
            .client
            .session_notification(SessionNotification::new(self.session_id.clone(), update))
            .await
        {
            error!("Failed to send session notification: {:?}", e);
        }
    }

    async fn send_user_message(&self, text: impl Into<String>) {
        self.send_notification(SessionUpdate::UserMessageChunk(ContentChunk::new(
            text.into().into(),
        )))
        .await;
    }

    async fn send_agent_text(&self, text: impl Into<String>) {
        self.send_notification(SessionUpdate::AgentMessageChunk(ContentChunk::new(
            text.into().into(),
        )))
        .await;
    }

    async fn send_agent_thought(&self, text: impl Into<String>) {
        self.send_notification(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
            text.into().into(),
        )))
        .await;
    }

    async fn send_tool_call(&self, tool_call: ToolCall) {
        self.send_notification(SessionUpdate::ToolCall(tool_call))
            .await;
    }

    async fn send_tool_call_update(&self, update: ToolCallUpdate) {
        self.send_notification(SessionUpdate::ToolCallUpdate(update))
            .await;
    }

    /// Send a completed tool call (used for replay and simple cases)
    async fn send_completed_tool_call(
        &self,
        call_id: impl Into<ToolCallId>,
        title: impl Into<String>,
        kind: ToolKind,
        raw_input: Option<serde_json::Value>,
    ) {
        let mut tool_call = ToolCall::new(call_id, title)
            .kind(kind)
            .status(ToolCallStatus::Completed);
        if let Some(input) = raw_input {
            tool_call = tool_call.raw_input(input);
        }
        self.send_tool_call(tool_call).await;
    }

    /// Send a tool call completion update (used for replay)
    async fn send_tool_call_completed(
        &self,
        call_id: impl Into<ToolCallId>,
        raw_output: Option<serde_json::Value>,
    ) {
        let mut fields = ToolCallUpdateFields::new().status(ToolCallStatus::Completed);
        if let Some(output) = raw_output {
            fields = fields.raw_output(output);
        }
        self.send_tool_call_update(ToolCallUpdate::new(call_id, fields))
            .await;
    }

    async fn update_plan_with_meta(&self, plan: Vec<PlanItemArg>, meta: Option<Meta>) {
        self.send_notification(SessionUpdate::Plan(
            Plan::new(
                plan.into_iter()
                    .map(|entry| {
                        PlanEntry::new(
                            entry.step,
                            PlanEntryPriority::Medium,
                            match entry.status {
                                StepStatus::Pending => PlanEntryStatus::Pending,
                                StepStatus::InProgress => PlanEntryStatus::InProgress,
                                StepStatus::Completed => PlanEntryStatus::Completed,
                            },
                        )
                    })
                    .collect(),
            )
            .meta(meta),
        ))
        .await;
    }

    async fn request_permission(
        &self,
        tool_call: ToolCallUpdate,
        options: Vec<PermissionOption>,
    ) -> Result<RequestPermissionResponse, Error> {
        self.client
            .request_permission(RequestPermissionRequest::new(
                self.session_id.clone(),
                tool_call,
                options,
            ))
            .await
    }
}

struct ThreadActor<A> {
    /// Allows for logging out from slash commands
    auth: A,
    /// Used for sending messages back to the client.
    client: SessionClient,
    /// The thread associated with this task.
    thread: Arc<dyn CodexThreadImpl>,
    /// The configuration for the thread.
    config: Config,
    /// The custom prompts loaded for this workspace.
    custom_prompts: Rc<RefCell<Vec<CustomPrompt>>>,
    /// The models available for this thread.
    models_manager: Arc<dyn ModelsManagerImpl>,
    /// A sender for each interested `Op` submission that needs events routed.
    submissions: HashMap<String, SubmissionState>,
    /// A receiver for incoming thread messages.
    message_rx: mpsc::UnboundedReceiver<ThreadMessage>,
    /// Weak sender used to feed async results back without keeping the actor alive.
    message_tx: mpsc::WeakUnboundedSender<ThreadMessage>,
    /// Last config options state we emitted to the client, used for deduping updates.
    last_sent_config_options: Option<Vec<SessionConfigOption>>,
}

impl<A: Auth> ThreadActor<A> {
    fn new(
        auth: A,
        client: SessionClient,
        thread: Arc<dyn CodexThreadImpl>,
        models_manager: Arc<dyn ModelsManagerImpl>,
        config: Config,
        message_rx: mpsc::UnboundedReceiver<ThreadMessage>,
        message_tx: mpsc::WeakUnboundedSender<ThreadMessage>,
    ) -> Self {
        Self {
            auth,
            client,
            thread,
            config,
            custom_prompts: Rc::default(),
            models_manager,
            submissions: HashMap::new(),
            message_rx,
            message_tx,
            last_sent_config_options: None,
        }
    }

    async fn spawn(mut self) {
        loop {
            tokio::select! {
                biased;
                message = self.message_rx.recv() => match message {
                    Some(message) => self.handle_message(message).await,
                    None => break,
                },
                event = self.thread.next_event() => match event {
                    Ok(event) => self.handle_event(event).await,
                    Err(e) => {
                        error!("Error getting next event: {:?}", e);
                        break;
                    }
                }
            }
            // Litter collection of senders with no receivers
            self.submissions
                .retain(|_, submission| submission.is_active());
        }
    }

    async fn handle_message(&mut self, message: ThreadMessage) {
        match message {
            ThreadMessage::Load { response_tx } => {
                let result = self.handle_load().await;
                drop(response_tx.send(result));
                let client = self.client.clone();
                let mut available_commands = Self::builtin_commands();
                let load_custom_prompts = self.load_custom_prompts().await;
                let custom_prompts = self.custom_prompts.clone();

                // Have this happen after the session is loaded by putting it
                // in a separate task
                tokio::task::spawn_local(async move {
                    let mut new_custom_prompts = load_custom_prompts
                        .await
                        .map_err(|_| Error::internal_error())
                        .flatten()
                        .inspect_err(|e| error!("Failed to load custom prompts {e:?}"))
                        .unwrap_or_default();

                    for prompt in &new_custom_prompts {
                        available_commands.push(
                            AvailableCommand::new(
                                prompt.name.clone(),
                                prompt.description.clone().unwrap_or_default(),
                            )
                            .input(prompt.argument_hint.as_ref().map(
                                |hint| {
                                    AvailableCommandInput::Unstructured(
                                        UnstructuredCommandInput::new(hint.clone()),
                                    )
                                },
                            )),
                        );
                    }
                    std::mem::swap(
                        custom_prompts.borrow_mut().deref_mut(),
                        &mut new_custom_prompts,
                    );

                    client
                        .send_notification(SessionUpdate::AvailableCommandsUpdate(
                            AvailableCommandsUpdate::new(available_commands),
                        ))
                        .await;
                });
            }
            ThreadMessage::GetConfigOptions { response_tx } => {
                let result = self.config_options().await;
                drop(response_tx.send(result));
            }
            ThreadMessage::Prompt {
                request,
                response_tx,
            } => {
                let result = self.handle_prompt(request).await;
                drop(response_tx.send(result));
            }
            ThreadMessage::SetMode { mode, response_tx } => {
                let result = self.handle_set_mode(mode).await;
                drop(response_tx.send(result));
                self.maybe_emit_config_options_update().await;
            }
            ThreadMessage::SetModel { model, response_tx } => {
                let result = self.handle_set_model(model).await;
                drop(response_tx.send(result));
                self.maybe_emit_config_options_update().await;
            }
            ThreadMessage::SetConfigOption {
                config_id,
                value,
                response_tx,
            } => {
                let result = self.handle_set_config_option(config_id, value).await;
                drop(response_tx.send(result));
            }
            ThreadMessage::Cancel { response_tx } => {
                let result = self.handle_cancel().await;
                drop(response_tx.send(result));
            }
            ThreadMessage::ReplayHistory {
                history,
                response_tx,
            } => {
                let result = self.handle_replay_history(history).await;
                drop(response_tx.send(result));
            }
            ThreadMessage::PermissionRequestResolved {
                submission_id,
                request_id,
                outcome,
            } => {
                if let Some(SubmissionState::Prompt(state)) =
                    self.submissions.get_mut(&submission_id)
                {
                    if let Err(err) = state
                        .handle_permission_request_resolved(request_id, outcome)
                        .await
                        && let Some(response_tx) = state.response_tx.take()
                    {
                        drop(response_tx.send(Err(err)));
                    }
                }
            }
        }
    }

    fn builtin_commands() -> Vec<AvailableCommand> {
        vec![
            AvailableCommand::new("review", "Review my current changes and find issues").input(
                AvailableCommandInput::Unstructured(UnstructuredCommandInput::new(
                    "optional custom review instructions",
                )),
            ),
            AvailableCommand::new(
                "review-branch",
                "Review the code changes against a specific branch",
            )
            .input(AvailableCommandInput::Unstructured(
                UnstructuredCommandInput::new("branch name"),
            )),
            AvailableCommand::new(
                "review-commit",
                "Review the code changes introduced by a commit",
            )
            .input(AvailableCommandInput::Unstructured(
                UnstructuredCommandInput::new("commit sha"),
            )),
            AvailableCommand::new(
                "init",
                "create an AGENTS.md file with instructions for Codex",
            ),
            AvailableCommand::new(
                "compact",
                "summarize conversation to prevent hitting the context limit",
            ),
            AvailableCommand::new("undo", "undo Codex’s most recent turn"),
            AvailableCommand::new("logout", "logout of Codex"),
        ]
    }

    async fn load_custom_prompts(&mut self) -> oneshot::Receiver<Result<Vec<CustomPrompt>, Error>> {
        let (response_tx, response_rx) = oneshot::channel();
        let submission_id = match self.thread.submit(Op::ListCustomPrompts).await {
            Ok(id) => id,
            Err(e) => {
                drop(response_tx.send(Err(Error::internal_error().data(e.to_string()))));
                return response_rx;
            }
        };

        self.submissions.insert(
            submission_id,
            SubmissionState::CustomPrompts(CustomPromptsState::new(response_tx)),
        );

        response_rx
    }

    fn modes(&self) -> Option<SessionModeState> {
        let current_mode_id = APPROVAL_PRESETS
            .iter()
            .find(|preset| {
                approval_preset_matches_config(
                    preset,
                    self.config.permissions.approval_policy.get(),
                    self.config.permissions.sandbox_policy.get(),
                )
            })
            .or_else(|| {
                // When the project is untrusted, the above code won't match
                // since AskForApproval::UnlessTrusted is not part of the
                // default presets. However, in this case we still want to show
                // the mode selector, which allows the user to choose a
                // different mode (which will set the project to be trusted)
                // See https://github.com/zed-industries/zed/issues/48132
                if self.config.active_project.is_untrusted() {
                    APPROVAL_PRESETS
                        .iter()
                        .find(|preset| preset.id == "read-only")
                } else {
                    None
                }
            })
            .map(|preset| SessionModeId::new(preset.id))?;

        Some(SessionModeState::new(
            current_mode_id,
            APPROVAL_PRESETS
                .iter()
                .map(|preset| {
                    SessionMode::new(preset.id, preset.label).description(preset.description)
                })
                .collect(),
        ))
    }

    async fn find_current_model(&self) -> Option<ModelId> {
        let model_presets = self.models_manager.list_models().await;
        let config_model = self.get_current_model().await;
        let preset = model_presets
            .iter()
            .find(|preset| preset.model == config_model)?;

        let effort = self
            .config
            .model_reasoning_effort
            .and_then(|effort| {
                preset
                    .supported_reasoning_efforts
                    .iter()
                    .find_map(|e| (e.effort == effort).then_some(effort))
            })
            .unwrap_or(preset.default_reasoning_effort);

        Some(Self::model_id(&preset.id, effort))
    }

    fn model_id(id: &str, effort: ReasoningEffort) -> ModelId {
        ModelId::new(format!("{id}/{effort}"))
    }

    fn parse_model_id(id: &ModelId) -> Option<(String, ReasoningEffort)> {
        let (model, reasoning) = id.0.split_once('/')?;
        let reasoning = serde_json::from_value(reasoning.into()).ok()?;
        Some((model.to_owned(), reasoning))
    }

    async fn config_options(&self) -> Result<Vec<SessionConfigOption>, Error> {
        let mut options = Vec::new();

        if let Some(modes) = self.modes() {
            let select_options = modes
                .available_modes
                .into_iter()
                .map(|m| SessionConfigSelectOption::new(m.id.0, m.name).description(m.description))
                .collect::<Vec<_>>();

            options.push(
                SessionConfigOption::select(
                    "mode",
                    "Approval Preset",
                    modes.current_mode_id.0,
                    select_options,
                )
                .category(SessionConfigOptionCategory::Mode)
                .description("Choose an approval and sandboxing preset for your session"),
            );
        }

        let presets = self.models_manager.list_models().await;

        let current_model = self.get_current_model().await;
        let current_preset = presets.iter().find(|p| p.model == current_model).cloned();

        let mut model_select_options = Vec::new();

        if current_preset.is_none() {
            // If no preset found, return the current model string as-is
            model_select_options.push(SessionConfigSelectOption::new(
                current_model.clone(),
                current_model.clone(),
            ));
        };

        model_select_options.extend(
            presets
                .into_iter()
                .filter(|model| model.show_in_picker || model.model == current_model)
                .map(|preset| {
                    SessionConfigSelectOption::new(preset.id, preset.display_name)
                        .description(preset.description)
                }),
        );

        options.push(
            SessionConfigOption::select("model", "Model", current_model, model_select_options)
                .category(SessionConfigOptionCategory::Model)
                .description("Choose which model Codex should use"),
        );

        // Reasoning effort selector (only if the current preset exists and has >1 supported effort)
        if let Some(preset) = current_preset
            && preset.supported_reasoning_efforts.len() > 1
        {
            let supported = &preset.supported_reasoning_efforts;

            let current_effort = self
                .config
                .model_reasoning_effort
                .and_then(|effort| {
                    supported
                        .iter()
                        .find_map(|e| (e.effort == effort).then_some(effort))
                })
                .unwrap_or(preset.default_reasoning_effort);

            let effort_select_options = supported
                .iter()
                .map(|e| {
                    SessionConfigSelectOption::new(
                        e.effort.to_string(),
                        e.effort.to_string().to_title_case(),
                    )
                    .description(e.description.clone())
                })
                .collect::<Vec<_>>();

            options.push(
                SessionConfigOption::select(
                    "reasoning_effort",
                    "Reasoning Effort",
                    current_effort.to_string(),
                    effort_select_options,
                )
                .category(SessionConfigOptionCategory::ThoughtLevel)
                .description("Choose how much reasoning effort the model should use"),
            );
        }

        Ok(options)
    }

    async fn maybe_emit_config_options_update(&mut self) {
        let config_options = self.config_options().await.unwrap_or_default();

        if self
            .last_sent_config_options
            .as_ref()
            .is_some_and(|prev| prev == &config_options)
        {
            return;
        }

        self.last_sent_config_options = Some(config_options.clone());

        self.client
            .send_notification(SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(
                config_options,
            )))
            .await;
    }

    async fn handle_set_config_option(
        &mut self,
        config_id: SessionConfigId,
        value: SessionConfigOptionValue,
    ) -> Result<(), Error> {
        let SessionConfigOptionValue::ValueId { value } = value else {
            return Err(Error::invalid_params().data("Unsupported config value type"));
        };

        match config_id.0.as_ref() {
            "mode" => self.handle_set_mode(SessionModeId::new(value.0)).await,
            "model" => self.handle_set_config_model(value).await,
            "reasoning_effort" => self.handle_set_config_reasoning_effort(value).await,
            _ => Err(Error::invalid_params().data("Unsupported config option")),
        }
    }

    async fn handle_set_config_model(&mut self, value: SessionConfigValueId) -> Result<(), Error> {
        let model_id = value.0;

        let presets = self.models_manager.list_models().await;
        let preset = presets.iter().find(|p| p.id.as_str() == &*model_id);

        let model_to_use = preset
            .map(|p| p.model.clone())
            .unwrap_or_else(|| model_id.to_string());

        if model_to_use.is_empty() {
            return Err(Error::invalid_params().data("No model selected"));
        }

        let effort_to_use = if let Some(preset) = preset {
            if let Some(effort) = self.config.model_reasoning_effort
                && preset
                    .supported_reasoning_efforts
                    .iter()
                    .any(|e| e.effort == effort)
            {
                Some(effort)
            } else {
                Some(preset.default_reasoning_effort)
            }
        } else {
            // If the user selected a raw model string (not a known preset), don't invent a default.
            // Keep whatever was previously configured (or leave unset) so Codex can decide.
            self.config.model_reasoning_effort
        };

        self.thread
            .submit(Op::OverrideTurnContext {
                cwd: None,
                approval_policy: None,
                sandbox_policy: None,
                model: Some(model_to_use.clone()),
                effort: Some(effort_to_use),
                summary: None,
                service_tier: None,
                collaboration_mode: None,
                personality: None,
                windows_sandbox_level: None,
                approvals_reviewer: None,
            })
            .await
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;

        self.config.model = Some(model_to_use);
        self.config.model_reasoning_effort = effort_to_use;

        Ok(())
    }

    async fn handle_set_config_reasoning_effort(
        &mut self,
        value: SessionConfigValueId,
    ) -> Result<(), Error> {
        let effort: ReasoningEffort =
            serde_json::from_value(value.0.as_ref().into()).map_err(|_| Error::invalid_params())?;

        let current_model = self.get_current_model().await;
        let presets = self.models_manager.list_models().await;
        let Some(preset) = presets.iter().find(|p| p.model == current_model) else {
            return Err(Error::invalid_params()
                .data("Reasoning effort can only be set for known model presets"));
        };

        if !preset
            .supported_reasoning_efforts
            .iter()
            .any(|e| e.effort == effort)
        {
            return Err(
                Error::invalid_params().data("Unsupported reasoning effort for selected model")
            );
        }

        self.thread
            .submit(Op::OverrideTurnContext {
                cwd: None,
                approval_policy: None,
                sandbox_policy: None,
                model: None,
                effort: Some(Some(effort)),
                summary: None,
                service_tier: None,
                collaboration_mode: None,
                personality: None,
                windows_sandbox_level: None,
                approvals_reviewer: None,
            })
            .await
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;

        self.config.model_reasoning_effort = Some(effort);

        Ok(())
    }

    async fn models(&self) -> Result<SessionModelState, Error> {
        let mut available_models = Vec::new();
        let config_model = self.get_current_model().await;

        let current_model_id = if let Some(model_id) = self.find_current_model().await {
            model_id
        } else {
            // If no preset found, return the current model string as-is
            let model_id = ModelId::new(self.get_current_model().await);
            available_models.push(ModelInfo::new(model_id.clone(), model_id.to_string()));
            model_id
        };

        available_models.extend(
            self.models_manager
                .list_models()
                .await
                .iter()
                .filter(|model| model.show_in_picker || model.model == config_model)
                .flat_map(|preset| {
                    preset.supported_reasoning_efforts.iter().map(|effort| {
                        ModelInfo::new(
                            Self::model_id(&preset.id, effort.effort),
                            format!("{} ({})", preset.display_name, effort.effort),
                        )
                        .description(format!("{} {}", preset.description, effort.description))
                    })
                }),
        );

        Ok(SessionModelState::new(current_model_id, available_models))
    }

    async fn handle_load(&mut self) -> Result<LoadSessionResponse, Error> {
        Ok(LoadSessionResponse::new()
            .models(self.models().await?)
            .modes(self.modes())
            .config_options(self.config_options().await?))
    }
    async fn handle_prompt(
        &mut self,
        request: PromptRequest,
    ) -> Result<oneshot::Receiver<Result<StopReason, Error>>, Error> {
        let (response_tx, response_rx) = oneshot::channel();
        // Adaptation made por Valt AI
        if let Some(payload) = extract_user_input_answer_payload(&request.prompt)? {
            self.thread
                .submit(Op::UserInputAnswer {
                    id: payload.turn_id,
                    response: payload.response,
                })
                .await
                .map_err(|e| Error::internal_error().data(e.to_string()))?;
            drop(response_tx.send(Ok(StopReason::EndTurn)));
            return Ok(response_rx);
        }

        let items = build_prompt_items(request.prompt);
        let op;
        if let Some((name, rest)) = extract_slash_command(&items) {
            match name {
                "compact" => op = Op::Compact,
                "undo" => op = Op::Undo,
                "init" => {
                    op = Op::UserInput {
                        items: vec![UserInput::Text {
                            text: INIT_COMMAND_PROMPT.into(),
                            text_elements: vec![],
                        }],
                        final_output_json_schema: None,
                    }
                }
                "review" => {
                    let instructions = rest.trim();
                    let target = if instructions.is_empty() {
                        ReviewTarget::UncommittedChanges
                    } else {
                        ReviewTarget::Custom {
                            instructions: instructions.to_owned(),
                        }
                    };

                    op = Op::Review {
                        review_request: ReviewRequest {
                            user_facing_hint: Some(user_facing_hint(&target)),
                            target,
                        },
                    }
                }
                "review-branch" if !rest.is_empty() => {
                    let target = ReviewTarget::BaseBranch {
                        branch: rest.trim().to_owned(),
                    };
                    op = Op::Review {
                        review_request: ReviewRequest {
                            user_facing_hint: Some(user_facing_hint(&target)),
                            target,
                        },
                    }
                }
                "review-commit" if !rest.is_empty() => {
                    let target = ReviewTarget::Commit {
                        sha: rest.trim().to_owned(),
                        title: None,
                    };
                    op = Op::Review {
                        review_request: ReviewRequest {
                            user_facing_hint: Some(user_facing_hint(&target)),
                            target,
                        },
                    }
                }
                "logout" => {
                    self.auth.logout()?;
                    return Err(Error::auth_required());
                }
                _ => {
                    if let Some(prompt) =
                        expand_custom_prompt(name, rest, self.custom_prompts.borrow().as_ref())
                            .map_err(|e| Error::invalid_params().data(e.user_message()))?
                    {
                        op = Op::UserInput {
                            items: vec![UserInput::Text {
                                text: prompt,
                                text_elements: vec![],
                            }],
                            final_output_json_schema: None,
                        }
                    } else {
                        op = Op::UserInput {
                            items,
                            final_output_json_schema: None,
                        }
                    }
                }
            }
        } else {
            op = Op::UserInput {
                items,
                final_output_json_schema: None,
            }
        }

        let submission_id = self
            .thread
            .submit(op.clone())
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))?;

        info!("Submitted prompt with submission_id: {submission_id}");
        info!("Starting to wait for conversation events for submission_id: {submission_id}");

        let state = SubmissionState::Prompt(PromptState::new(
            self.thread.clone(),
            self.message_tx.clone(),
            submission_id.clone(),
            response_tx,
        ));

        self.submissions.insert(submission_id, state);

        Ok(response_rx)
    }

    async fn handle_set_mode(&mut self, mode: SessionModeId) -> Result<(), Error> {
        let preset = APPROVAL_PRESETS
            .iter()
            .find(|preset| mode.0.as_ref() == preset.id)
            .ok_or_else(Error::invalid_params)?;

        self.thread
            .submit(Op::OverrideTurnContext {
                cwd: None,
                approval_policy: Some(preset.approval),
                sandbox_policy: Some(preset.sandbox.clone()),
                model: None,
                effort: None,
                summary: None,
                service_tier: None,
                collaboration_mode: None,
                personality: None,
                windows_sandbox_level: None,
                approvals_reviewer: None,
            })
            .await
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;

        self.config
            .permissions
            .approval_policy
            .set(preset.approval)
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;
        self.config
            .permissions
            .sandbox_policy
            .set(preset.sandbox.clone())
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;

        match preset.sandbox {
            // Treat this user action as a trusted dir
            SandboxPolicy::DangerFullAccess
            | SandboxPolicy::WorkspaceWrite { .. }
            | SandboxPolicy::ExternalSandbox { .. } => {
                set_project_trust_level(
                    &self.config.codex_home,
                    &self.config.cwd,
                    TrustLevel::Trusted,
                )?;
            }
            SandboxPolicy::ReadOnly { .. } => {}
        }

        Ok(())
    }

    async fn get_current_model(&self) -> String {
        self.models_manager.get_model(&self.config.model).await
    }

    async fn handle_set_model(&mut self, model: ModelId) -> Result<(), Error> {
        // Try parsing as preset format, otherwise use as-is, fallback to config
        let (model_to_use, effort_to_use) = if let Some((m, e)) = Self::parse_model_id(&model) {
            (m, Some(e))
        } else {
            let model_str = model.0.to_string();
            let fallback = if !model_str.is_empty() {
                model_str
            } else {
                self.get_current_model().await
            };
            (fallback, self.config.model_reasoning_effort)
        };

        if model_to_use.is_empty() {
            return Err(Error::invalid_params().data("No model parsed or configured"));
        }

        self.thread
            .submit(Op::OverrideTurnContext {
                cwd: None,
                approval_policy: None,
                sandbox_policy: None,
                model: Some(model_to_use.clone()),
                effort: Some(effort_to_use),
                summary: None,
                service_tier: None,
                collaboration_mode: None,
                personality: None,
                windows_sandbox_level: None,
                approvals_reviewer: None,
            })
            .await
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;

        self.config.model = Some(model_to_use);
        self.config.model_reasoning_effort = effort_to_use;

        Ok(())
    }

    async fn handle_cancel(&mut self) -> Result<(), Error> {
        self.thread
            .submit(Op::Interrupt)
            .await
            .map_err(|e| Error::from(anyhow::anyhow!(e)))?;
        Ok(())
    }

    /// Replay conversation history to the client via session/update notifications.
    /// This is called when loading a session to stream all prior messages.
    ///
    /// We process both `EventMsg` and `ResponseItem`:
    /// - `EventMsg` for user/agent messages and reasoning (like the TUI does)
    /// - `ResponseItem` for tool calls only (not persisted as EventMsg)
    async fn handle_replay_history(&mut self, history: Vec<RolloutItem>) -> Result<(), Error> {
        for item in history {
            match item {
                RolloutItem::EventMsg(event_msg) => {
                    self.replay_event_msg(&event_msg).await;
                }
                RolloutItem::ResponseItem(response_item) => {
                    self.replay_response_item(&response_item).await;
                }
                // Skip SessionMeta, TurnContext, Compacted
                _ => {}
            }
        }
        Ok(())
    }

    /// Convert and send an EventMsg as ACP notification(s) during replay.
    /// Handles messages and reasoning - mirrors the live event handling in PromptState.
    async fn replay_event_msg(&self, msg: &EventMsg) {
        match msg {
            EventMsg::UserMessage(UserMessageEvent { message, .. }) => {
                self.client.send_user_message(message.clone()).await;
            }
            EventMsg::AgentMessage(AgentMessageEvent {
                message,
                phase: _,
                ..
            }) => {
                self.client.send_agent_text(message.clone()).await;
            }
            EventMsg::AgentReasoning(AgentReasoningEvent { text }) => {
                self.client.send_agent_thought(text.clone()).await;
            }
            EventMsg::AgentReasoningRawContent(AgentReasoningRawContentEvent { text }) => {
                self.client.send_agent_thought(text.clone()).await;
            }
            // Skip other event types during replay - they either:
            // - Are transient (deltas, turn lifecycle)
            // - Don't have direct ACP equivalents
            // - Are handled via ResponseItem instead
            _ => {}
        }
    }

    /// Parse apply_patch call input to extract patch content for display.
    /// Returns (title, locations, content) if successful.
    /// For CustomToolCall, the input is the patch string directly.
    fn parse_apply_patch_call(
        &self,
        input: &str,
    ) -> Option<(String, Vec<ToolCallLocation>, Vec<ToolCallContent>)> {
        // Try to parse the patch using codex-apply-patch parser
        let parsed = parse_patch(input).ok()?;

        let mut locations = Vec::new();
        let mut file_names = Vec::new();
        let mut content = Vec::new();

        for hunk in &parsed.hunks {
            match hunk {
                codex_apply_patch::Hunk::AddFile { path, contents } => {
                    let full_path = self.config.cwd.join(path).ok()?;
                    file_names.push(path.display().to_string());
                    locations.push(ToolCallLocation::new(full_path.clone()));
                    // New file: no old_text, new_text is the contents
                    content.push(ToolCallContent::Diff(with_neverwrite_diff_meta(
                        Diff::new(full_path.clone(), contents.clone()),
                        None,
                        build_single_hunk(None, Some(contents.as_str())),
                    )));
                }
                codex_apply_patch::Hunk::DeleteFile { path } => {
                    let full_path = self.config.cwd.join(path).ok()?;
                    file_names.push(path.display().to_string());
                    locations.push(ToolCallLocation::new(full_path.clone()));
                    let old_text = read_text_snapshot(full_path.as_path())
                        .unwrap_or_else(|| FILE_DELETED_PLACEHOLDER.to_string());
                    let hunks = if old_text == FILE_DELETED_PLACEHOLDER {
                        None
                    } else {
                        build_single_hunk(Some(old_text.as_str()), None)
                    };
                    content.push(ToolCallContent::Diff(with_neverwrite_diff_meta(
                        Diff::new(full_path, "").old_text(old_text),
                        None,
                        hunks,
                    )));
                }
                codex_apply_patch::Hunk::UpdateFile {
                    path,
                    move_path,
                    chunks,
                } => {
                    let full_path = self.config.cwd.join(path).ok()?;
                    let dest_path = move_path
                        .as_ref()
                        .map(|p| self.config.cwd.join(p))
                        .transpose()
                        .ok()?
                        .unwrap_or_else(|| full_path.clone());
                    let previous_path = move_path.as_ref().map(|_| full_path.as_path());
                    file_names.push(path.display().to_string());
                    locations.push(ToolCallLocation::new(dest_path.clone()));
                    let snapshot = read_text_snapshot(full_path.as_path());
                    let projected_chunks: Vec<ProjectedUpdateFileChunk> = chunks
                        .iter()
                        .map(|chunk| ProjectedUpdateFileChunk {
                            change_context: chunk.change_context.clone(),
                            old_lines: chunk.old_lines.clone(),
                            new_lines: chunk.new_lines.clone(),
                            is_end_of_file: chunk.is_end_of_file,
                        })
                        .collect();

                    // Build old and new text from chunks
                    let old_lines: Vec<String> = chunks
                        .iter()
                        .flat_map(|c| c.old_lines.iter().cloned())
                        .collect();
                    let new_lines: Vec<String> = chunks
                        .iter()
                        .flat_map(|c| c.new_lines.iter().cloned())
                        .collect();
                    let old_text = if chunks.is_empty() && previous_path.is_some() {
                        read_text_snapshot(full_path.as_path()).unwrap_or_default()
                    } else {
                        old_lines.join("\n")
                    };
                    let new_text = if chunks.is_empty() && previous_path.is_some() {
                        old_text.clone()
                    } else {
                        new_lines.join("\n")
                    };
                    let hunks = snapshot.as_deref().and_then(|snapshot| {
                        compute_update_file_hunks(snapshot, &projected_chunks)
                    });

                    content.push(ToolCallContent::Diff(with_neverwrite_diff_meta(
                        Diff::new(dest_path, new_text).old_text(old_text),
                        previous_path,
                        hunks,
                    )));
                }
            }
        }

        let title = if file_names.is_empty() {
            "Apply patch".to_string()
        } else {
            format!("Edit {}", file_names.join(", "))
        };

        Some((title, locations, content))
    }

    /// Parse shell function call arguments to extract command info for rich display.
    /// Returns (title, kind, locations) if successful.
    ///
    /// Handles both:
    /// - `shell` / `container.exec`: `command` is `Vec<String>`
    /// - `shell_command`: `command` is a `String` (shell script)
    fn parse_shell_function_call(
        &self,
        name: &str,
        arguments: &str,
    ) -> Option<(String, ToolKind, Vec<ToolCallLocation>)> {
        // Extract command and workdir based on tool type
        let (command_vec, workdir): (Vec<String>, Option<String>) = if name == "shell_command" {
            // shell_command: command is a string (shell script)
            #[derive(serde::Deserialize)]
            struct ShellCommandArgs {
                command: String,
                #[serde(default)]
                workdir: Option<String>,
            }
            let args: ShellCommandArgs = serde_json::from_str(arguments).ok()?;
            // Wrap in bash -lc for parsing
            (
                vec!["bash".to_string(), "-lc".to_string(), args.command],
                args.workdir,
            )
        } else {
            // shell / container.exec: command is Vec<String>
            #[derive(serde::Deserialize)]
            struct ShellArgs {
                command: Vec<String>,
                #[serde(default)]
                workdir: Option<String>,
            }
            let args: ShellArgs = serde_json::from_str(arguments).ok()?;
            (args.command, args.workdir)
        };

        let cwd = workdir
            .map(PathBuf::from)
            .unwrap_or_else(|| self.config.cwd.to_path_buf());

        let parsed_cmd = parse_command(&command_vec);
        let ParseCommandToolCall {
            title,
            file_extension: _,
            terminal_output: _,
            locations,
            kind,
        } = parse_command_tool_call(parsed_cmd, &cwd);

        Some((title, kind, locations))
    }

    /// Convert and send a single ResponseItem as ACP notification(s) during replay.
    /// Only handles tool calls - messages/reasoning are handled via EventMsg.
    async fn replay_response_item(&self, item: &ResponseItem) {
        match item {
            // Skip Message and Reasoning - these are handled via EventMsg
            ResponseItem::Message { .. } | ResponseItem::Reasoning { .. } => {}
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } => {
                // Check if this is a shell command - parse it like we do for LocalShellCall
                if matches!(name.as_str(), "shell" | "container.exec" | "shell_command")
                    && let Some((title, kind, locations)) =
                        self.parse_shell_function_call(name, arguments)
                {
                    self.client
                        .send_tool_call(
                            ToolCall::new(call_id.clone(), title)
                                .kind(kind)
                                .status(ToolCallStatus::Completed)
                                .locations(locations)
                                .raw_input(
                                    serde_json::from_str::<serde_json::Value>(arguments).ok(),
                                ),
                        )
                        .await;
                    return;
                }

                // Fall through to generic function call handling
                self.client
                    .send_completed_tool_call(
                        call_id.clone(),
                        name.clone(),
                        ToolKind::Other,
                        serde_json::from_str(arguments).ok(),
                    )
                    .await;
            }
            ResponseItem::FunctionCallOutput { call_id, output } => {
                self.client
                    .send_tool_call_completed(call_id.clone(), serde_json::to_value(output).ok())
                    .await;
            }
            ResponseItem::LocalShellCall {
                call_id: Some(call_id),
                action,
                status,
                ..
            } => {
                let codex_protocol::models::LocalShellAction::Exec(exec) = action;
                let cwd = exec
                    .working_directory
                    .as_ref()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.config.cwd.to_path_buf());

                // Parse the command to get rich info like the live event handler does
                let parsed_cmd = parse_command(&exec.command);
                let ParseCommandToolCall {
                    title,
                    file_extension: _,
                    terminal_output: _,
                    locations,
                    kind,
                } = parse_command_tool_call(parsed_cmd, &cwd);

                let tool_status = match status {
                    codex_protocol::models::LocalShellStatus::Completed => {
                        ToolCallStatus::Completed
                    }
                    codex_protocol::models::LocalShellStatus::InProgress
                    | codex_protocol::models::LocalShellStatus::Incomplete => {
                        ToolCallStatus::Failed
                    }
                };
                self.client
                    .send_tool_call(
                        ToolCall::new(call_id.clone(), title)
                            .kind(kind)
                            .status(tool_status)
                            .locations(locations),
                    )
                    .await;
            }
            ResponseItem::CustomToolCall {
                name,
                input,
                call_id,
                ..
            } => {
                // Check if this is an apply_patch call - show the patch content
                if name == "apply_patch" {
                    if let Some((title, locations, content)) = self.parse_apply_patch_call(input) {
                        self.client
                            .send_tool_call(
                                ToolCall::new(call_id.clone(), title)
                                    .kind(ToolKind::Edit)
                                    .status(ToolCallStatus::Completed)
                                    .locations(locations)
                                    .content(content)
                                    .raw_input(
                                        serde_json::from_str::<serde_json::Value>(input).ok(),
                                    ),
                            )
                            .await;
                    } else {
                        // Parsing failed — send as Edit so the UI still shows an edit occurred
                        warn!(
                            "Failed to parse apply_patch input for replay: call_id={call_id}, input_len={}",
                            input.len()
                        );
                        self.client
                            .send_completed_tool_call(
                                call_id.clone(),
                                "Edit (replay)".to_string(),
                                ToolKind::Edit,
                                serde_json::from_str(input).ok(),
                            )
                            .await;
                    }
                    return;
                }

                // Fall through to generic custom tool call handling
                self.client
                    .send_completed_tool_call(
                        call_id.clone(),
                        name.clone(),
                        ToolKind::Other,
                        serde_json::from_str(input).ok(),
                    )
                    .await;
            }
            ResponseItem::CustomToolCallOutput {
                call_id, output, ..
            } => {
                self.client
                    .send_tool_call_completed(call_id.clone(), Some(serde_json::json!(output)))
                    .await;
            }
            ResponseItem::WebSearchCall { id, action, .. } => {
                let (title, call_id) = if let Some(action) = action {
                    web_search_action_to_title_and_id(id, action)
                } else {
                    ("Web Search".into(), generate_fallback_id("web_search"))
                };
                self.client
                    .send_tool_call(
                        ToolCall::new(call_id, title)
                            .kind(ToolKind::Search)
                            .status(ToolCallStatus::Completed),
                    )
                    .await;
            }
            // Skip GhostSnapshot, Compaction, Other, LocalShellCall without call_id
            _ => {}
        }
    }

    async fn handle_event(&mut self, Event { id, msg }: Event) {
        if let Some(submission) = self.submissions.get_mut(&id) {
            submission.handle_event(&self.client, msg).await;
        } else {
            warn!("Received event for unknown submission ID: {id} {msg:?}");
        }
    }
}

fn build_prompt_items(prompt: Vec<ContentBlock>) -> Vec<UserInput> {
    prompt
        .into_iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text_block) => Some(UserInput::Text {
                text: text_block.text,
                text_elements: vec![],
            }),
            ContentBlock::Image(image_block) => Some(UserInput::Image {
                image_url: format!("data:{};base64,{}", image_block.mime_type, image_block.data),
            }),
            ContentBlock::ResourceLink(ResourceLink { name, uri, .. }) => Some(UserInput::Text {
                text: format_uri_as_link(Some(name), uri),
                text_elements: vec![],
            }),
            ContentBlock::Resource(EmbeddedResource {
                resource:
                    EmbeddedResourceResource::TextResourceContents(TextResourceContents {
                        text,
                        uri,
                        ..
                    }),
                ..
            }) => Some(UserInput::Text {
                text: format!(
                    "{}\n<context ref=\"{uri}\">\n{text}\n</context>",
                    format_uri_as_link(None, uri.clone())
                ),
                text_elements: vec![],
            }),
            // Skip other content types for now
            ContentBlock::Audio(..) | ContentBlock::Resource(..) | _ => None,
        })
        .collect()
}

fn format_uri_as_link(name: Option<String>, uri: String) -> String {
    if let Some(name) = name
        && !name.is_empty()
    {
        format!("[@{name}]({uri})")
    } else if let Some(path) = uri.strip_prefix("file://") {
        let name = path.split('/').next_back().unwrap_or(path);
        format!("[@{name}]({uri})")
    } else if uri.starts_with("zed://") {
        let name = uri.split('/').next_back().unwrap_or(&uri);
        format!("[@{name}]({uri})")
    } else {
        uri
    }
}

fn read_text_snapshot(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Compare file snapshots taken before an exec command with the current state
/// on disk and produce `ToolCallContent::Diff` items for any files that changed.
fn collect_exec_file_diffs(
    file_snapshots: &HashMap<PathBuf, Option<String>>,
) -> Vec<ToolCallContent> {
    let mut diffs = Vec::new();

    for (path, old_snapshot) in file_snapshots {
        let new_snapshot = read_text_snapshot(path);

        match (old_snapshot, &new_snapshot) {
            // File didn't exist before and still doesn't → no change
            (None, None) => {}
            // File didn't exist before but now exists → add
            (None, Some(new_text)) => {
                if !new_text.is_empty() {
                    diffs.push(ToolCallContent::Diff(with_neverwrite_diff_meta(
                        Diff::new(path.clone(), new_text.clone()),
                        None,
                        build_single_hunk(None, Some(new_text.as_str())),
                    )));
                }
            }
            // File existed before but now doesn't → delete
            (Some(old_text), None) => {
                diffs.push(ToolCallContent::Diff(with_neverwrite_diff_meta(
                    Diff::new(path.clone(), String::new()).old_text(old_text.clone()),
                    None,
                    build_single_hunk(Some(old_text.as_str()), None),
                )));
            }
            // File existed before and still exists → check if content changed
            (Some(old_text), Some(new_text)) => {
                if old_text != new_text {
                    diffs.push(ToolCallContent::Diff(with_neverwrite_diff_meta(
                        Diff::new(path.clone(), new_text.clone()).old_text(old_text.clone()),
                        None,
                        build_single_hunk(Some(old_text.as_str()), Some(new_text.as_str())),
                    )));
                }
            }
        }
    }

    diffs
}

fn split_snapshot_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

fn seek_sequence(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }

    if pattern.len() > lines.len() {
        return None;
    }

    let search_start = if eof && lines.len() >= pattern.len() {
        lines.len() - pattern.len()
    } else {
        start
    };

    for i in search_start..=lines.len().saturating_sub(pattern.len()) {
        if lines[i..i + pattern.len()] == *pattern {
            return Some(i);
        }
    }

    for i in search_start..=lines.len().saturating_sub(pattern.len()) {
        let mut ok = true;
        for (p_idx, pat) in pattern.iter().enumerate() {
            if lines[i + p_idx].trim_end() != pat.trim_end() {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(i);
        }
    }

    for i in search_start..=lines.len().saturating_sub(pattern.len()) {
        let mut ok = true;
        for (p_idx, pat) in pattern.iter().enumerate() {
            if lines[i + p_idx].trim() != pat.trim() {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(i);
        }
    }

    None
}

fn diff_hunk_lines(old_lines: &[String], new_lines: &[String]) -> Vec<NeverWriteDiffHunkLine> {
    let m = old_lines.len();
    let n = new_lines.len();
    let dp: Vec<Vec<usize>> = (0..=m).map(|_| vec![0; n + 1]).collect();
    let mut dp = dp;

    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if old_lines[i - 1] == new_lines[j - 1] {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }

    let mut stack = Vec::new();
    let (mut i, mut j) = (m, n);
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old_lines[i - 1] == new_lines[j - 1] {
            stack.push(NeverWriteDiffHunkLine {
                r#type: "context".to_string(),
                text: old_lines[i - 1].clone(),
            });
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            stack.push(NeverWriteDiffHunkLine {
                r#type: "add".to_string(),
                text: new_lines[j - 1].clone(),
            });
            j -= 1;
        } else {
            stack.push(NeverWriteDiffHunkLine {
                r#type: "remove".to_string(),
                text: old_lines[i - 1].clone(),
            });
            i -= 1;
        }
    }

    stack.reverse();
    stack
}

fn trim_trailing_empty_line(lines: &[String]) -> Vec<String> {
    let mut trimmed = lines.to_vec();
    if trimmed.last().is_some_and(String::is_empty) {
        trimmed.pop();
    }
    trimmed
}

#[derive(Debug, Clone)]
struct ResolvedUpdateFileChunk {
    start_idx: usize,
    old_lines: Vec<String>,
    new_lines: Vec<String>,
}

#[derive(Debug, Clone)]
struct ProjectedUpdateFileChunk {
    change_context: Option<String>,
    old_lines: Vec<String>,
    new_lines: Vec<String>,
    is_end_of_file: bool,
}

fn resolve_update_file_chunks(
    original_text: &str,
    chunks: &[ProjectedUpdateFileChunk],
) -> Option<Vec<ResolvedUpdateFileChunk>> {
    let original_lines = split_snapshot_lines(original_text);
    let mut line_index = 0usize;
    let mut resolved = Vec::with_capacity(chunks.len());

    for chunk in chunks {
        if let Some(ctx_line) = &chunk.change_context {
            let ctx_pattern = [ctx_line.clone()];
            let idx = seek_sequence(&original_lines, &ctx_pattern, line_index, false)?;
            line_index = idx + 1;
        }

        if chunk.old_lines.is_empty() {
            let insertion_idx = original_lines.len();
            resolved.push(ResolvedUpdateFileChunk {
                start_idx: insertion_idx,
                old_lines: Vec::new(),
                new_lines: trim_trailing_empty_line(&chunk.new_lines),
            });
            continue;
        }

        let mut pattern = chunk.old_lines.clone();
        let mut new_lines = chunk.new_lines.clone();
        let mut found = seek_sequence(&original_lines, &pattern, line_index, chunk.is_end_of_file);

        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern.pop();
            if new_lines.last().is_some_and(String::is_empty) {
                new_lines.pop();
            }
            found = seek_sequence(&original_lines, &pattern, line_index, chunk.is_end_of_file);
        }

        let start_idx = found?;
        line_index = start_idx + pattern.len();
        resolved.push(ResolvedUpdateFileChunk {
            start_idx,
            old_lines: pattern,
            new_lines,
        });
    }

    Some(resolved)
}

fn compute_update_file_hunks(
    original_text: &str,
    chunks: &[ProjectedUpdateFileChunk],
) -> Option<Vec<NeverWriteDiffHunk>> {
    let resolved = resolve_update_file_chunks(original_text, chunks)?;
    let mut hunks = Vec::with_capacity(resolved.len());
    let mut cumulative_delta = 0isize;

    for chunk in resolved {
        let old_count = chunk.old_lines.len();
        let new_count = chunk.new_lines.len();
        hunks.push(NeverWriteDiffHunk {
            old_start: chunk.start_idx + 1,
            old_count,
            new_start: (chunk.start_idx as isize + cumulative_delta + 1).max(1) as usize,
            new_count,
            lines: diff_hunk_lines(&chunk.old_lines, &chunk.new_lines),
        });
        cumulative_delta += new_count as isize - old_count as isize;
    }

    Some(hunks)
}

fn build_single_hunk(
    old_text: Option<&str>,
    new_text: Option<&str>,
) -> Option<Vec<NeverWriteDiffHunk>> {
    let old_lines = old_text.map(split_snapshot_lines).unwrap_or_default();
    let new_lines = new_text.map(split_snapshot_lines).unwrap_or_default();

    if old_lines.is_empty() && new_lines.is_empty() {
        return None;
    }

    Some(vec![NeverWriteDiffHunk {
        old_start: 1,
        old_count: old_lines.len(),
        new_start: 1,
        new_count: new_lines.len(),
        lines: diff_hunk_lines(&old_lines, &new_lines),
    }])
}

fn parse_unified_diff_range(segment: &str) -> Option<(usize, usize)> {
    let (start, count) = match segment.split_once(',') {
        Some((start, count)) => (start, count),
        None => (segment, "1"),
    };
    Some((start.parse().ok()?, count.parse().ok()?))
}

fn parse_unified_diff_hunks(unified_diff: &str) -> Vec<NeverWriteDiffHunk> {
    let mut hunks = Vec::new();
    let mut current: Option<NeverWriteDiffHunk> = None;

    for line in unified_diff.lines() {
        if let Some(header) = line.strip_prefix("@@ -") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }

            let Some((old_part, rest)) = header.split_once(" +") else {
                continue;
            };
            let Some((new_part, _)) = rest.split_once(" @@") else {
                continue;
            };
            let Some((old_start, old_count)) = parse_unified_diff_range(old_part) else {
                continue;
            };
            let Some((new_start, new_count)) = parse_unified_diff_range(new_part) else {
                continue;
            };

            current = Some(NeverWriteDiffHunk {
                old_start,
                old_count,
                new_start,
                new_count,
                lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            continue;
        };

        if line == r"\ No newline at end of file" {
            continue;
        }

        let Some((marker, text)) = line
            .strip_prefix(' ')
            .map(|text| ("context", text))
            .or_else(|| line.strip_prefix('+').map(|text| ("add", text)))
            .or_else(|| line.strip_prefix('-').map(|text| ("remove", text)))
        else {
            continue;
        };

        hunk.lines.push(NeverWriteDiffHunkLine {
            r#type: marker.to_string(),
            text: text.to_string(),
        });
    }

    if let Some(hunk) = current {
        hunks.push(hunk);
    }

    hunks
}

fn extract_full_texts_from_unified_diff(
    current_text: &str,
    unified_diff: &str,
) -> Option<(String, String)> {
    let patch = diffy::Patch::from_str(unified_diff).ok()?;

    if let Ok(old_text) = diffy::apply(current_text, &patch.reverse()) {
        return Some((old_text, current_text.to_string()));
    }

    if let Ok(new_text) = diffy::apply(current_text, &patch) {
        return Some((current_text.to_string(), new_text));
    }

    None
}

fn fallback_texts_from_unified_diff(unified_diff: &str) -> Option<(String, String)> {
    let patch = diffy::Patch::from_str(unified_diff).ok()?;
    let mut old_text = String::new();
    let mut new_text = String::new();

    for hunk in patch.hunks() {
        for line in hunk.lines() {
            match line {
                diffy::Line::Context(text) => {
                    old_text.push_str(text);
                    new_text.push_str(text);
                }
                diffy::Line::Delete(text) => old_text.push_str(text),
                diffy::Line::Insert(text) => new_text.push_str(text),
            }
        }
    }

    Some((old_text, new_text))
}

fn with_neverwrite_diff_meta(
    mut diff: Diff,
    previous_path: Option<&Path>,
    hunks: Option<Vec<NeverWriteDiffHunk>>,
) -> Diff {
    let mut meta = diff.meta.take().unwrap_or_default();

    if let Some(path) = previous_path {
        meta.insert(
            NEVERWRITE_DIFF_PREVIOUS_PATH_KEY.to_string(),
            json!(path.display().to_string()),
        );
    }

    if let Some(hunks) = hunks.filter(|hunks| !hunks.is_empty()) {
        meta.insert(NEVERWRITE_DIFF_HUNKS_KEY.to_string(), json!(hunks));
    }

    if !meta.is_empty() {
        diff = diff.meta(meta);
    }

    diff
}

fn extract_tool_call_content_from_changes(
    changes: HashMap<PathBuf, FileChange>,
) -> (
    String,
    Vec<ToolCallLocation>,
    impl Iterator<Item = ToolCallContent>,
) {
    let changes = changes.into_iter().collect_vec();
    let title = if changes.is_empty() {
        "Edit".to_string()
    } else {
        format!(
            "Edit {}",
            changes
                .iter()
                .map(|(path, change)| {
                    extract_tool_call_location_for_change(path, change)
                        .display()
                        .to_string()
                })
                .join(", ")
        )
    };
    let locations = changes
        .iter()
        .map(|(path, change)| ToolCallLocation::new(extract_tool_call_location_for_change(path, change)))
        .collect_vec();
    let content = changes
        .into_iter()
        .flat_map(|(path, change)| extract_tool_call_content_from_change(path, change));

    (title, locations, content)
}

fn extract_tool_call_location_for_change(path: &Path, change: &FileChange) -> PathBuf {
    match change {
        FileChange::Update {
            move_path: Some(move_path),
            ..
        } => move_path.clone(),
        _ => path.to_path_buf(),
    }
}

fn extract_tool_call_content_from_change(path: PathBuf, change: FileChange) -> Vec<ToolCallContent> {
    match change {
        FileChange::Add { content } => vec![ToolCallContent::Diff(with_neverwrite_diff_meta(
            Diff::new(path, content.clone()),
            None,
            build_single_hunk(None, Some(content.as_str())),
        ))],
        FileChange::Delete { content } => vec![ToolCallContent::Diff(with_neverwrite_diff_meta(
            Diff::new(path, String::new()).old_text(content.clone()),
            None,
            build_single_hunk(Some(content.as_str()), None),
        ))],
        FileChange::Update {
            unified_diff,
            move_path,
        } => extract_tool_call_content_from_unified_diff(path, move_path, unified_diff),
    }
}

fn extract_tool_call_content_from_unified_diff(
    path: PathBuf,
    move_path: Option<PathBuf>,
    unified_diff: String,
) -> Vec<ToolCallContent> {
    let resolved_path = move_path.clone().unwrap_or_else(|| path.clone());
    let previous_path = move_path.as_ref().map(|_| path.as_path());
    let hunks = Some(parse_unified_diff_hunks(&unified_diff)).filter(|value| !value.is_empty());
    let snapshot = read_text_snapshot(&resolved_path).or_else(|| read_text_snapshot(&path));
    let texts = snapshot
        .as_deref()
        .and_then(|current| extract_full_texts_from_unified_diff(current, &unified_diff))
        .or_else(|| fallback_texts_from_unified_diff(&unified_diff));

    if let Some((old_text, new_text)) = texts {
        vec![ToolCallContent::Diff(with_neverwrite_diff_meta(
            Diff::new(resolved_path, new_text).old_text(old_text),
            previous_path,
            hunks,
        ))]
    } else {
        vec![ToolCallContent::Content(Content::new(unified_diff))]
    }
}

/// Extract title and call_id from a WebSearchAction (used for replay)
fn web_search_action_to_title_and_id(
    id: &Option<String>,
    action: &codex_protocol::models::WebSearchAction,
) -> (String, String) {
    match action {
        codex_protocol::models::WebSearchAction::Search { query, queries } => {
            let title = queries
                .as_ref()
                .map(|q| q.join(", "))
                .or_else(|| query.clone())
                .unwrap_or_else(|| "Web search".to_string());
            let call_id = id
                .clone()
                .unwrap_or_else(|| generate_fallback_id("web_search"));
            (title, call_id)
        }
        codex_protocol::models::WebSearchAction::OpenPage { url } => {
            let title = url.clone().unwrap_or_else(|| "Open page".to_string());
            let call_id = id
                .clone()
                .unwrap_or_else(|| generate_fallback_id("web_open"));
            (title, call_id)
        }
        codex_protocol::models::WebSearchAction::FindInPage { pattern, .. } => {
            let title = pattern
                .clone()
                .unwrap_or_else(|| "Find in page".to_string());
            let call_id = id
                .clone()
                .unwrap_or_else(|| generate_fallback_id("web_find"));
            (title, call_id)
        }
        codex_protocol::models::WebSearchAction::Other => {
            ("Unknown".to_string(), generate_fallback_id("web_search"))
        }
    }
}

/// Generate a fallback ID using UUID (used when id is missing)
fn generate_fallback_id(prefix: &str) -> String {
    format!("{}_{}", prefix, Uuid::new_v4())
}

/// Checks if a prompt is slash command
fn extract_slash_command(content: &[UserInput]) -> Option<(&str, &str)> {
    let line = content.first().and_then(|block| match block {
        UserInput::Text { text, .. } => Some(text),
        _ => None,
    })?;

    parse_slash_name(line)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use agent_client_protocol::TextContent;
    use codex_core::{config::ConfigOverrides, test_support::all_model_presets};
    use codex_protocol::config_types::ModeKind;
    use tokio::{
        sync::{Mutex, mpsc::UnboundedSender},
        task::LocalSet,
    };

    use super::*;

    #[tokio::test]
    async fn test_prompt() -> anyhow::Result<()> {
        let (session_id, client, _, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["Hi".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert_eq!(notifications.len(), 1);
        assert!(matches!(
            &notifications[0].update,
            SessionUpdate::AgentMessageChunk(ContentChunk {
                content: ContentBlock::Text(TextContent { text, .. }),
                ..
            }) if text == "Hi"
        ));

        Ok(())
    }

    #[tokio::test]
    async fn test_compact() -> anyhow::Result<()> {
        let (session_id, client, thread, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["/compact".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert!(
            notifications.iter().any(|notification| {
                matches!(
                    &notification.update,
                    SessionUpdate::AgentMessageChunk(ContentChunk {
                        content: ContentBlock::Text(TextContent { text, .. }),
                        ..
                    }) if text == "Compact task completed"
                )
            }),
            "notifications don't match {notifications:?}"
        );
        let ops = thread.ops.lock().unwrap();
        assert_eq!(ops.as_slice(), &[Op::Compact]);

        Ok(())
    }

    #[tokio::test]
    async fn test_undo() -> anyhow::Result<()> {
        let (session_id, client, thread, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["/undo".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert_eq!(
            notifications.len(),
            2,
            "notifications don't match {notifications:?}"
        );
        assert!(matches!(
            &notifications[0].update,
            SessionUpdate::AgentMessageChunk(ContentChunk {
                content: ContentBlock::Text(TextContent { text, .. }),
                ..
            }) if text == "Undo in progress..."
        ));
        assert!(matches!(
            &notifications[1].update,
            SessionUpdate::AgentMessageChunk(ContentChunk {
                content: ContentBlock::Text(TextContent { text, .. }),
                ..
            }) if text == "Undo completed."
        ));

        let ops = thread.ops.lock().unwrap();
        assert_eq!(ops.as_slice(), &[Op::Undo]);

        Ok(())
    }

    #[tokio::test]
    async fn test_init() -> anyhow::Result<()> {
        let (session_id, client, thread, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["/init".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert_eq!(notifications.len(), 1);
        assert!(
            matches!(
                &notifications[0].update,
                SessionUpdate::AgentMessageChunk(ContentChunk {
                    content: ContentBlock::Text(TextContent { text, .. }), ..
                }) if text == INIT_COMMAND_PROMPT // we echo the prompt
            ),
            "notifications don't match {notifications:?}"
        );
        let ops = thread.ops.lock().unwrap();
        assert_eq!(
            ops.as_slice(),
            &[Op::UserInput {
                items: vec![UserInput::Text {
                    text: INIT_COMMAND_PROMPT.to_string(),
                    text_elements: vec![]
                }],
                final_output_json_schema: None,
            }],
            "ops don't match {ops:?}"
        );

        Ok(())
    }

    #[tokio::test]
    async fn test_review() -> anyhow::Result<()> {
        let (session_id, client, thread, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["/review".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert!(
            notifications.iter().any(|notification| {
                matches!(
                    &notification.update,
                    SessionUpdate::AgentMessageChunk(ContentChunk {
                        content: ContentBlock::Text(TextContent { text, .. }),
                        ..
                    }) if text == "current changes"
                )
            }),
            "notifications don't match {notifications:?}"
        );

        let ops = thread.ops.lock().unwrap();
        assert_eq!(
            ops.as_slice(),
            &[Op::Review {
                review_request: ReviewRequest {
                    user_facing_hint: Some(user_facing_hint(&ReviewTarget::UncommittedChanges)),
                    target: ReviewTarget::UncommittedChanges,
                }
            }],
            "ops don't match {ops:?}"
        );

        Ok(())
    }

    #[tokio::test]
    async fn test_custom_review() -> anyhow::Result<()> {
        let (session_id, client, thread, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();
        let instructions = "Review what we did in agents.md";

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(
                session_id.clone(),
                vec![format!("/review {instructions}").into()],
            ),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert!(
            notifications.iter().any(|notification| {
                matches!(
                    &notification.update,
                    SessionUpdate::AgentMessageChunk(ContentChunk {
                        content: ContentBlock::Text(TextContent { text, .. }),
                        ..
                    }) if text == "Review what we did in agents.md"
                )
            }),
            "notifications don't match {notifications:?}"
        );

        let ops = thread.ops.lock().unwrap();
        assert_eq!(
            ops.as_slice(),
            &[Op::Review {
                review_request: ReviewRequest {
                    user_facing_hint: Some(user_facing_hint(&ReviewTarget::Custom {
                        instructions: instructions.to_owned()
                    })),
                    target: ReviewTarget::Custom {
                        instructions: instructions.to_owned()
                    },
                }
            }],
            "ops don't match {ops:?}"
        );

        Ok(())
    }

    #[tokio::test]
    async fn test_commit_review() -> anyhow::Result<()> {
        let (session_id, client, thread, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["/review-commit 123456".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert!(
            notifications.iter().any(|notification| {
                matches!(
                    &notification.update,
                    SessionUpdate::AgentMessageChunk(ContentChunk {
                        content: ContentBlock::Text(TextContent { text, .. }),
                        ..
                    }) if text == "commit 123456"
                )
            }),
            "notifications don't match {notifications:?}"
        );

        let ops = thread.ops.lock().unwrap();
        assert_eq!(
            ops.as_slice(),
            &[Op::Review {
                review_request: ReviewRequest {
                    user_facing_hint: Some(user_facing_hint(&ReviewTarget::Commit {
                        sha: "123456".to_owned(),
                        title: None
                    })),
                    target: ReviewTarget::Commit {
                        sha: "123456".to_owned(),
                        title: None
                    },
                }
            }],
            "ops don't match {ops:?}"
        );

        Ok(())
    }

    #[tokio::test]
    async fn test_branch_review() -> anyhow::Result<()> {
        let (session_id, client, thread, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["/review-branch feature".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert!(
            notifications.iter().any(|notification| {
                matches!(
                    &notification.update,
                    SessionUpdate::AgentMessageChunk(ContentChunk {
                        content: ContentBlock::Text(TextContent { text, .. }),
                        ..
                    }) if text == "changes against 'feature'"
                )
            }),
            "notifications don't match {notifications:?}"
        );

        let ops = thread.ops.lock().unwrap();
        assert_eq!(
            ops.as_slice(),
            &[Op::Review {
                review_request: ReviewRequest {
                    user_facing_hint: Some(user_facing_hint(&ReviewTarget::BaseBranch {
                        branch: "feature".to_owned()
                    })),
                    target: ReviewTarget::BaseBranch {
                        branch: "feature".to_owned()
                    },
                }
            }],
            "ops don't match {ops:?}"
        );

        Ok(())
    }

    #[tokio::test]
    async fn test_custom_prompts() -> anyhow::Result<()> {
        let custom_prompts = vec![CustomPrompt {
            name: "custom".to_string(),
            path: "/tmp/custom.md".into(),
            content: "Custom prompt with $1 arg.".into(),
            description: None,
            argument_hint: None,
        }];
        let (session_id, client, thread, message_tx, local_set) = setup(custom_prompts).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["/custom foo".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();
        assert_eq!(notifications.len(), 1);
        assert!(
            matches!(
                &notifications[0].update,
                SessionUpdate::AgentMessageChunk(ContentChunk {
                    content: ContentBlock::Text(TextContent { text, .. }),
                    ..
                }) if text == "Custom prompt with foo arg."
            ),
            "notifications don't match {notifications:?}"
        );

        let ops = thread.ops.lock().unwrap();
        assert_eq!(
            ops.as_slice(),
            &[Op::UserInput {
                items: vec![UserInput::Text {
                    text: "Custom prompt with foo arg.".into(),
                    text_elements: vec![]
                }],
                final_output_json_schema: None,
            }],
            "ops don't match {ops:?}"
        );

        Ok(())
    }

    #[tokio::test]
    async fn test_delta_deduplication() -> anyhow::Result<()> {
        let (session_id, client, _, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["test delta".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        // We should only get ONE notification, not duplicates from both delta and non-delta
        let notifications = client.notifications.lock().unwrap();
        assert_eq!(
            notifications.len(),
            1,
            "Should only receive delta event, not duplicate non-delta. Got: {notifications:?}"
        );
        assert!(matches!(
            &notifications[0].update,
            SessionUpdate::AgentMessageChunk(ContentChunk {
                content: ContentBlock::Text(TextContent { text, .. }),
                ..
            }) if text == "test delta"
        ));

        Ok(())
    }

    #[test]
    fn test_parse_plan_text_handles_markdown_and_streaming_status() {
        let parsed = parse_plan_text(
            "# Final plan\nSummary paragraph\n- [x] Inspect current state\n- Implement live plan updates\n  including final completion handling",
            true,
        );

        assert_eq!(parsed.title.as_deref(), Some("Final plan"));
        assert_eq!(parsed.detail.as_deref(), Some("Summary paragraph"));
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].step, "Inspect current state");
        assert!(matches!(parsed.entries[0].status, StepStatus::Completed));
        assert_eq!(
            parsed.entries[1].step,
            "Implement live plan updates\nincluding final completion handling"
        );
        assert!(matches!(parsed.entries[1].status, StepStatus::InProgress));
    }

    #[test]
    fn test_parse_plan_text_keeps_non_step_sections_outside_entries() {
        let parsed = parse_plan_text(
            "# Final plan\nSummary paragraph\n- [x] Inspect current state\n## Tests\nCover sync and resume flows",
            false,
        );

        assert_eq!(parsed.title.as_deref(), Some("Final plan"));
        assert_eq!(
            parsed.detail.as_deref(),
            Some("Summary paragraph\n## Tests\nCover sync and resume flows")
        );
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].step, "Inspect current state");
    }

    #[tokio::test]
    async fn test_plan_delta_emits_plan_updates() -> anyhow::Result<()> {
        let session_id = SessionId::new("test");
        let client = Arc::new(StubClient::new());
        let session_client =
            SessionClient::with_client(session_id.clone(), client.clone(), Arc::default());
        let thread = Arc::new(StubCodexThread::new());
        let (message_tx, _message_rx) = mpsc::unbounded_channel();
        let (response_tx, _response_rx) = oneshot::channel();
        let mut prompt_state =
            PromptState::new(
                thread,
                message_tx.downgrade(),
                "submission-1".to_string(),
                response_tx,
            );

        prompt_state
            .handle_event(
                &session_client,
                EventMsg::PlanDelta(PlanDeltaEvent {
                    thread_id: codex_protocol::ThreadId::new().to_string(),
                    turn_id: "turn-1".into(),
                    item_id: "plan-1".into(),
                    delta: "# Final plan\nSummary paragraph\n- [x] Inspect current state\n- Implement live plan updates\n".into(),
                }),
            )
            .await;

        prompt_state
            .handle_event(
                &session_client,
                EventMsg::ItemCompleted(ItemCompletedEvent {
                    thread_id: codex_protocol::ThreadId::new(),
                    turn_id: "turn-1".into(),
                    item: TurnItem::Plan(codex_protocol::items::PlanItem {
                        id: "plan-1".into(),
                        text: "# Final plan\nSummary paragraph\n- [x] Inspect current state\n- Implement live plan updates\n".into(),
                    }),
                }),
            )
            .await;

        let notifications = client.notifications.lock().unwrap();
        let plan_updates = notifications
            .iter()
            .filter_map(|notification| match &notification.update {
                SessionUpdate::Plan(plan) => Some(plan.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(plan_updates.len(), 2, "notifications={notifications:?}");
        assert_eq!(
            plan_updates[0]
                .meta
                .as_ref()
                .and_then(|meta| meta.get(NEVERWRITE_PLAN_TITLE_KEY))
                .and_then(|value| value.as_str()),
            Some("Final plan")
        );
        assert_eq!(
            plan_updates[0]
                .meta
                .as_ref()
                .and_then(|meta| meta.get(NEVERWRITE_PLAN_DETAIL_KEY))
                .and_then(|value| value.as_str()),
            Some("Summary paragraph")
        );
        assert_eq!(plan_updates[0].entries.len(), 2);
        assert_eq!(plan_updates[0].entries[0].content, "Inspect current state");
        assert_eq!(
            plan_updates[0].entries[0].status,
            PlanEntryStatus::Completed
        );
        assert_eq!(
            plan_updates[0].entries[1].content,
            "Implement live plan updates"
        );
        assert_eq!(
            plan_updates[0].entries[1].status,
            PlanEntryStatus::InProgress
        );
        assert_eq!(plan_updates[1].entries[1].status, PlanEntryStatus::Pending);

        Ok(())
    }

    async fn setup(
        custom_prompts: Vec<CustomPrompt>,
    ) -> anyhow::Result<(
        SessionId,
        Arc<StubClient>,
        Arc<StubCodexThread>,
        UnboundedSender<ThreadMessage>,
        LocalSet,
    )> {
        let session_id = SessionId::new("test");
        let client = Arc::new(StubClient::new());
        let session_client =
            SessionClient::with_client(session_id.clone(), client.clone(), Arc::default());
        let conversation = Arc::new(StubCodexThread::new());
        let models_manager = Arc::new(StubModelsManager);
        let config = Config::load_with_cli_overrides_and_harness_overrides(
            vec![],
            ConfigOverrides::default(),
        )
        .await?;
        let (message_tx, message_rx) = tokio::sync::mpsc::unbounded_channel();

        let mut actor = ThreadActor::new(
            StubAuth,
            session_client,
            conversation.clone(),
            models_manager,
            config,
            message_rx,
            message_tx.downgrade(),
        );
        actor.custom_prompts = Rc::new(RefCell::new(custom_prompts));

        let local_set = LocalSet::new();
        local_set.spawn_local(actor.spawn());
        Ok((session_id, client, conversation, message_tx, local_set))
    }

    struct StubAuth;

    impl Auth for StubAuth {
        fn logout(&self) -> Result<bool, Error> {
            Ok(true)
        }
    }

    struct StubModelsManager;

    #[async_trait::async_trait]
    impl ModelsManagerImpl for StubModelsManager {
        async fn get_model(&self, _model_id: &Option<String>) -> String {
            all_model_presets()[0].to_owned().id
        }

        async fn list_models(&self) -> Vec<ModelPreset> {
            all_model_presets().to_owned()
        }
    }

    struct StubCodexThread {
        current_id: AtomicUsize,
        ops: std::sync::Mutex<Vec<Op>>,
        op_tx: mpsc::UnboundedSender<Event>,
        op_rx: Mutex<mpsc::UnboundedReceiver<Event>>,
    }

    impl StubCodexThread {
        fn new() -> Self {
            let (op_tx, op_rx) = mpsc::unbounded_channel();
            StubCodexThread {
                current_id: AtomicUsize::new(0),
                ops: std::sync::Mutex::default(),
                op_tx,
                op_rx: Mutex::new(op_rx),
            }
        }
    }

    #[async_trait::async_trait]
    impl CodexThreadImpl for StubCodexThread {
        async fn submit(&self, op: Op) -> Result<String, CodexErr> {
            let id = self
                .current_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

            self.ops.lock().unwrap().push(op.clone());

            match op {
                Op::UserInput { items, .. } => {
                    let prompt = items
                        .into_iter()
                        .map(|i| match i {
                            UserInput::Text { text, .. } => text,
                            _ => unimplemented!(),
                        })
                        .join("\n");

                    if prompt == "parallel-exec" {
                        // Emit interleaved exec events: Begin A, Begin B, End A, End B
                        let turn_id = id.to_string();
                        let cwd = std::env::current_dir().unwrap();
                        let send = |msg| {
                            self.op_tx
                                .send(Event {
                                    id: id.to_string(),
                                    msg,
                                })
                                .unwrap();
                        };
                        send(EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                            call_id: "call-a".into(),
                            process_id: None,
                            turn_id: turn_id.clone(),
                            command: vec!["echo".into(), "a".into()],
                            cwd: cwd.clone(),
                            parsed_cmd: vec![ParsedCommand::Unknown {
                                cmd: "echo a".into(),
                            }],
                            source: Default::default(),
                            interaction_input: None,
                        }));
                        send(EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                            call_id: "call-b".into(),
                            process_id: None,
                            turn_id: turn_id.clone(),
                            command: vec!["echo".into(), "b".into()],
                            cwd: cwd.clone(),
                            parsed_cmd: vec![ParsedCommand::Unknown {
                                cmd: "echo b".into(),
                            }],
                            source: Default::default(),
                            interaction_input: None,
                        }));
                        send(EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                            call_id: "call-a".into(),
                            process_id: None,
                            turn_id: turn_id.clone(),
                            command: vec!["echo".into(), "a".into()],
                            cwd: cwd.clone(),
                            parsed_cmd: vec![],
                            source: Default::default(),
                            interaction_input: None,
                            stdout: "a\n".into(),
                            stderr: String::new(),
                            aggregated_output: "a\n".into(),
                            exit_code: 0,
                            duration: std::time::Duration::from_millis(10),
                            formatted_output: "a\n".into(),
                            status: ExecCommandStatus::Completed,
                        }));
                        send(EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                            call_id: "call-b".into(),
                            process_id: None,
                            turn_id: turn_id.clone(),
                            command: vec!["echo".into(), "b".into()],
                            cwd: cwd.clone(),
                            parsed_cmd: vec![],
                            source: Default::default(),
                            interaction_input: None,
                            stdout: "b\n".into(),
                            stderr: String::new(),
                            aggregated_output: "b\n".into(),
                            exit_code: 0,
                            duration: std::time::Duration::from_millis(10),
                            formatted_output: "b\n".into(),
                            status: ExecCommandStatus::Completed,
                        }));
                        send(EventMsg::TurnComplete(TurnCompleteEvent {
                            last_agent_message: None,
                            turn_id,
                        }));
                    } else {
                        self.op_tx
                            .send(Event {
                                id: id.to_string(),
                                msg: EventMsg::AgentMessageContentDelta(
                                    AgentMessageContentDeltaEvent {
                                        thread_id: id.to_string(),
                                        turn_id: id.to_string(),
                                        item_id: id.to_string(),
                                        delta: prompt.clone(),
                                    },
                                ),
                            })
                            .unwrap();
                        // Send non-delta event (should be deduplicated, but handled by deduplication)
                        self.op_tx
                            .send(Event {
                                id: id.to_string(),
                                msg: EventMsg::AgentMessage(AgentMessageEvent {
                                    message: prompt,
                                    phase: None,
                                    memory_citation: None,
                                }),
                            })
                            .unwrap();
                        self.op_tx
                            .send(Event {
                                id: id.to_string(),
                                msg: EventMsg::TurnComplete(TurnCompleteEvent {
                                    last_agent_message: None,
                                    turn_id: id.to_string(),
                                }),
                            })
                            .unwrap();
                    }
                }
                Op::Compact => {
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::TurnStarted(TurnStartedEvent {
                                model_context_window: None,
                                collaboration_mode_kind: ModeKind::default(),
                                turn_id: id.to_string(),
                            }),
                        })
                        .unwrap();
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::AgentMessage(AgentMessageEvent {
                                message: "Compact task completed".to_string(),
                                phase: None,
                                memory_citation: None,
                            }),
                        })
                        .unwrap();
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::TurnComplete(TurnCompleteEvent {
                                last_agent_message: None,
                                turn_id: id.to_string(),
                            }),
                        })
                        .unwrap();
                }
                Op::Undo => {
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::UndoStarted(
                                codex_protocol::protocol::UndoStartedEvent {
                                    message: Some("Undo in progress...".to_string()),
                                },
                            ),
                        })
                        .unwrap();
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::UndoCompleted(
                                codex_protocol::protocol::UndoCompletedEvent {
                                    success: true,
                                    message: Some("Undo completed.".to_string()),
                                },
                            ),
                        })
                        .unwrap();
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::TurnComplete(TurnCompleteEvent {
                                last_agent_message: None,
                                turn_id: id.to_string(),
                            }),
                        })
                        .unwrap();
                }
                Op::Review { review_request } => {
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::EnteredReviewMode(review_request.clone()),
                        })
                        .unwrap();
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::ExitedReviewMode(ExitedReviewModeEvent {
                                review_output: Some(ReviewOutputEvent {
                                    findings: vec![],
                                    overall_correctness: String::new(),
                                    overall_explanation: review_request
                                        .user_facing_hint
                                        .clone()
                                        .unwrap_or_default(),
                                    overall_confidence_score: 1.,
                                }),
                            }),
                        })
                        .unwrap();
                    self.op_tx
                        .send(Event {
                            id: id.to_string(),
                            msg: EventMsg::TurnComplete(TurnCompleteEvent {
                                last_agent_message: None,
                                turn_id: id.to_string(),
                            }),
                        })
                        .unwrap();
                }
                _ => {
                    unimplemented!()
                }
            }
            Ok(id.to_string())
        }

        async fn next_event(&self) -> Result<Event, CodexErr> {
            let Some(event) = self.op_rx.lock().await.recv().await else {
                return Err(CodexErr::InternalAgentDied);
            };
            Ok(event)
        }
    }

    struct StubClient {
        notifications: std::sync::Mutex<Vec<SessionNotification>>,
    }

    impl StubClient {
        fn new() -> Self {
            StubClient {
                notifications: std::sync::Mutex::default(),
            }
        }
    }

    #[async_trait::async_trait(?Send)]
    impl Client for StubClient {
        async fn request_permission(
            &self,
            _args: RequestPermissionRequest,
        ) -> Result<RequestPermissionResponse, Error> {
            unimplemented!()
        }

        async fn session_notification(&self, args: SessionNotification) -> Result<(), Error> {
            self.notifications.lock().unwrap().push(args);
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_parallel_exec_commands() -> anyhow::Result<()> {
        let (session_id, client, _, message_tx, local_set) = setup(vec![]).await?;
        let (prompt_response_tx, prompt_response_rx) = tokio::sync::oneshot::channel();

        message_tx.send(ThreadMessage::Prompt {
            request: PromptRequest::new(session_id.clone(), vec!["parallel-exec".into()]),
            response_tx: prompt_response_tx,
        })?;

        tokio::try_join!(
            async {
                let stop_reason = prompt_response_rx.await??.await??;
                assert_eq!(stop_reason, StopReason::EndTurn);
                drop(message_tx);
                anyhow::Ok(())
            },
            async {
                local_set.await;
                anyhow::Ok(())
            }
        )?;

        let notifications = client.notifications.lock().unwrap();

        // Collect all ToolCall (begin) notifications keyed by their tool_call_id prefix.
        let tool_calls: Vec<_> = notifications
            .iter()
            .filter_map(|n| match &n.update {
                SessionUpdate::ToolCall(tc) => Some(tc.clone()),
                _ => None,
            })
            .collect();

        // Collect all ToolCallUpdate notifications that carry a terminal status.
        let completed_updates: Vec<_> = notifications
            .iter()
            .filter_map(|n| match &n.update {
                SessionUpdate::ToolCallUpdate(update) => {
                    if update.fields.status == Some(ToolCallStatus::Completed) {
                        Some(update.clone())
                    } else {
                        None
                    }
                }
                _ => None,
            })
            .collect();

        // Both commands A and B should have produced a ToolCall (begin).
        assert_eq!(
            tool_calls.len(),
            2,
            "expected 2 ToolCall begin notifications, got {tool_calls:?}"
        );

        // Both commands A and B should have produced a completed ToolCallUpdate.
        assert_eq!(
            completed_updates.len(),
            2,
            "expected 2 completed ToolCallUpdate notifications, got {completed_updates:?}"
        );

        // The completed updates should reference the same tool_call_ids as the begins.
        let begin_ids: std::collections::HashSet<_> = tool_calls
            .iter()
            .map(|tc| tc.tool_call_id.clone())
            .collect();
        let end_ids: std::collections::HashSet<_> = completed_updates
            .iter()
            .map(|u| u.tool_call_id.clone())
            .collect();
        assert_eq!(
            begin_ids, end_ids,
            "completed update tool_call_ids should match begin tool_call_ids"
        );

        Ok(())
    }

    #[test]
    fn compute_update_file_hunks_preserves_exact_line_numbers() {
        let snapshot = "alpha\nbeta\ngamma\n";
        let chunks = vec![ProjectedUpdateFileChunk {
            change_context: None,
            old_lines: vec!["beta".to_string()],
            new_lines: vec!["BETA".to_string()],
            is_end_of_file: false,
        }];

        let hunks = compute_update_file_hunks(snapshot, &chunks).unwrap();

        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old_start, 2);
        assert_eq!(hunks[0].new_start, 2);
        assert_eq!(
            hunks[0]
                .lines
                .iter()
                .map(|line| line.r#type.as_str())
                .collect::<Vec<_>>(),
            vec!["remove", "add"]
        );
    }

    #[test]
    fn parse_unified_diff_hunks_reads_multi_hunk_headers() {
        let unified_diff = "\
@@ -2,2 +2,2 @@
-beta
+BETA
 gamma
@@ -6,1 +6,2 @@
-zeta
+zeta
+eta
";

        let hunks = parse_unified_diff_hunks(unified_diff);

        assert_eq!(hunks.len(), 2);
        assert_eq!((hunks[0].old_start, hunks[0].new_start), (2, 2));
        assert_eq!((hunks[1].old_start, hunks[1].new_start), (6, 6));
        assert_eq!(
            hunks[1]
                .lines
                .iter()
                .map(|line| line.r#type.as_str())
                .collect::<Vec<_>>(),
            vec!["remove", "add", "add"]
        );
    }
}
