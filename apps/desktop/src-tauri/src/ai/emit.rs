use neverwrite_ai::AiSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const AI_SESSION_CREATED_EVENT: &str = "ai://session-created";
pub const AI_SESSION_UPDATED_EVENT: &str = "ai://session-updated";
pub const AI_SESSION_ERROR_EVENT: &str = "ai://session-error";
pub const AI_MESSAGE_STARTED_EVENT: &str = "ai://message-started";
pub const AI_MESSAGE_DELTA_EVENT: &str = "ai://message-delta";
pub const AI_MESSAGE_COMPLETED_EVENT: &str = "ai://message-completed";
pub const AI_THINKING_STARTED_EVENT: &str = "ai://thinking-started";
pub const AI_THINKING_DELTA_EVENT: &str = "ai://thinking-delta";
pub const AI_THINKING_COMPLETED_EVENT: &str = "ai://thinking-completed";
pub const AI_TOOL_ACTIVITY_EVENT: &str = "ai://tool-activity";
pub const AI_STATUS_EVENT: &str = "ai://status-event";
pub const AI_PERMISSION_REQUEST_EVENT: &str = "ai://permission-request";
pub const AI_USER_INPUT_REQUEST_EVENT: &str = "ai://user-input-request";
pub const AI_PLAN_UPDATED_EVENT: &str = "ai://plan-updated";
pub const AI_AVAILABLE_COMMANDS_UPDATED_EVENT: &str = "ai://available-commands-updated";
pub const AI_RUNTIME_CONNECTION_EVENT: &str = "ai://runtime-connection";

#[derive(Debug, Clone, Serialize)]
pub struct AiSessionErrorPayload {
    pub session_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiRuntimeConnectionPayload {
    pub runtime_id: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiMessageStartedPayload {
    pub session_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiMessageDeltaPayload {
    pub session_id: String,
    pub message_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiMessageCompletedPayload {
    pub session_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiToolActivityPayload {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub target: Option<String>,
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diffs: Option<Vec<AiFileDiffPayload>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStatusEventPayload {
    pub session_id: String,
    pub event_id: String,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub detail: Option<String>,
    pub emphasis: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiPlanEntryPayload {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiPlanUpdatePayload {
    pub session_id: String,
    pub plan_id: String,
    pub title: Option<String>,
    pub detail: Option<String>,
    pub entries: Vec<AiPlanEntryPayload>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiAvailableCommandPayload {
    pub id: String,
    pub label: String,
    pub description: String,
    pub insert_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiAvailableCommandsPayload {
    pub session_id: String,
    pub commands: Vec<AiAvailableCommandPayload>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiUserInputQuestionOptionPayload {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiUserInputQuestionPayload {
    pub id: String,
    pub header: String,
    pub question: String,
    pub is_other: bool,
    pub is_secret: bool,
    pub options: Option<Vec<AiUserInputQuestionOptionPayload>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiUserInputRequestPayload {
    pub session_id: String,
    pub request_id: String,
    pub title: String,
    pub questions: Vec<AiUserInputQuestionPayload>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiPermissionOptionPayload {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiFileDiffPayload {
    pub path: String,
    /// "add" | "delete" | "move" | "update"
    pub kind: String,
    pub previous_path: Option<String>,
    pub reversible: bool,
    pub is_text: bool,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunks: Option<Vec<AiFileDiffHunkPayload>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiFileDiffHunkPayload {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<AiFileDiffHunkLinePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiFileDiffHunkLinePayload {
    pub r#type: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiPermissionRequestPayload {
    pub session_id: String,
    pub request_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub target: Option<String>,
    pub options: Vec<AiPermissionOptionPayload>,
    pub diffs: Vec<AiFileDiffPayload>,
}

pub fn emit_session_created(app: &AppHandle, session: &AiSession) {
    let _ = app.emit(AI_SESSION_CREATED_EVENT, session);
}

pub fn emit_session_updated(app: &AppHandle, session: &AiSession) {
    let _ = app.emit(AI_SESSION_UPDATED_EVENT, session);
}

pub fn emit_session_error(app: &AppHandle, session_id: Option<String>, message: String) {
    let payload = AiSessionErrorPayload {
        session_id,
        message,
    };
    let _ = app.emit(AI_SESSION_ERROR_EVENT, payload);
}

pub fn emit_message_started(app: &AppHandle, session_id: String, message_id: String) {
    let payload = AiMessageStartedPayload {
        session_id,
        message_id,
    };
    let _ = app.emit(AI_MESSAGE_STARTED_EVENT, payload);
}

pub fn emit_message_delta(app: &AppHandle, session_id: String, message_id: String, delta: String) {
    let payload = AiMessageDeltaPayload {
        session_id,
        message_id,
        delta,
    };
    let _ = app.emit(AI_MESSAGE_DELTA_EVENT, payload);
}

pub fn emit_message_completed(app: &AppHandle, session_id: String, message_id: String) {
    let payload = AiMessageCompletedPayload {
        session_id,
        message_id,
    };
    let _ = app.emit(AI_MESSAGE_COMPLETED_EVENT, payload);
}

pub fn emit_thinking_started(app: &AppHandle, session_id: String, message_id: String) {
    let payload = AiMessageStartedPayload {
        session_id,
        message_id,
    };
    let _ = app.emit(AI_THINKING_STARTED_EVENT, payload);
}

pub fn emit_thinking_delta(app: &AppHandle, session_id: String, message_id: String, delta: String) {
    let payload = AiMessageDeltaPayload {
        session_id,
        message_id,
        delta,
    };
    let _ = app.emit(AI_THINKING_DELTA_EVENT, payload);
}

pub fn emit_thinking_completed(app: &AppHandle, session_id: String, message_id: String) {
    let payload = AiMessageCompletedPayload {
        session_id,
        message_id,
    };
    let _ = app.emit(AI_THINKING_COMPLETED_EVENT, payload);
}

pub fn emit_tool_activity(app: &AppHandle, payload: AiToolActivityPayload) {
    let _ = app.emit(AI_TOOL_ACTIVITY_EVENT, payload);
}

pub fn emit_status_event(app: &AppHandle, payload: AiStatusEventPayload) {
    let _ = app.emit(AI_STATUS_EVENT, payload);
}

pub fn emit_user_input_request(app: &AppHandle, payload: AiUserInputRequestPayload) {
    let _ = app.emit(AI_USER_INPUT_REQUEST_EVENT, payload);
}

pub fn emit_plan_update(app: &AppHandle, payload: AiPlanUpdatePayload) {
    let _ = app.emit(AI_PLAN_UPDATED_EVENT, payload);
}

pub fn emit_permission_request(app: &AppHandle, payload: AiPermissionRequestPayload) {
    let _ = app.emit(AI_PERMISSION_REQUEST_EVENT, payload);
}

pub fn emit_available_commands_updated(app: &AppHandle, payload: AiAvailableCommandsPayload) {
    let _ = app.emit(AI_AVAILABLE_COMMANDS_UPDATED_EVENT, payload);
}

pub fn emit_runtime_connection(app: &AppHandle, payload: AiRuntimeConnectionPayload) {
    let _ = app.emit(AI_RUNTIME_CONNECTION_EVENT, payload);
}
