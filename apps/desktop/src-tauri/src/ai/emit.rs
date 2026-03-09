use serde::Serialize;
use tauri::{AppHandle, Emitter};
use vault_ai_ai::AiSession;

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
pub const AI_PERMISSION_REQUEST_EVENT: &str = "ai://permission-request";

#[derive(Debug, Clone, Serialize)]
pub struct AiSessionErrorPayload {
    pub session_id: Option<String>,
    pub message: String,
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
}

#[derive(Debug, Clone, Serialize)]
pub struct AiPermissionOptionPayload {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiPermissionRequestPayload {
    pub session_id: String,
    pub request_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub target: Option<String>,
    pub options: Vec<AiPermissionOptionPayload>,
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

pub fn emit_permission_request(app: &AppHandle, payload: AiPermissionRequestPayload) {
    let _ = app.emit(AI_PERMISSION_REQUEST_EVENT, payload);
}
