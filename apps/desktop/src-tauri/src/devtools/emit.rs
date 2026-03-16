use tauri::{AppHandle, Emitter};

use super::types::{
    DevTerminalErrorEventPayload, DevTerminalOutputEventPayload, DevTerminalSessionSnapshot,
};

pub const DEV_TERMINAL_OUTPUT_EVENT: &str = "devtools://terminal-output";
pub const DEV_TERMINAL_STARTED_EVENT: &str = "devtools://terminal-started";
pub const DEV_TERMINAL_EXITED_EVENT: &str = "devtools://terminal-exited";
pub const DEV_TERMINAL_ERROR_EVENT: &str = "devtools://terminal-error";

pub fn emit_terminal_started(app: &AppHandle, snapshot: &DevTerminalSessionSnapshot) {
    let _ = app.emit(DEV_TERMINAL_STARTED_EVENT, snapshot);
}

pub fn emit_terminal_output(app: &AppHandle, session_id: &str, chunk: String) {
    let _ = app.emit(
        DEV_TERMINAL_OUTPUT_EVENT,
        DevTerminalOutputEventPayload {
            session_id: session_id.to_string(),
            chunk,
        },
    );
}

pub fn emit_terminal_exited(app: &AppHandle, snapshot: &DevTerminalSessionSnapshot) {
    let _ = app.emit(DEV_TERMINAL_EXITED_EVENT, snapshot);
}

pub fn emit_terminal_error(app: &AppHandle, session_id: &str, message: String) {
    let _ = app.emit(
        DEV_TERMINAL_ERROR_EVENT,
        DevTerminalErrorEventPayload {
            session_id: session_id.to_string(),
            message,
        },
    );
}
