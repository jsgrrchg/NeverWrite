pub use neverwrite_ai::events::*;
use neverwrite_ai::AiSession;
use tauri::{AppHandle, Emitter};

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

pub fn emit_token_usage(app: &AppHandle, payload: AiTokenUsagePayload) {
    let _ = app.emit(AI_TOKEN_USAGE_EVENT, payload);
}
