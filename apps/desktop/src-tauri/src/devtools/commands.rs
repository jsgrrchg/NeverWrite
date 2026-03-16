use tauri::{AppHandle, State};

use super::manager::DevTerminalManager;
use super::types::{
    DevTerminalCreateInput, DevTerminalResizeInput, DevTerminalSessionSnapshot,
    DevTerminalWriteInput,
};

#[tauri::command]
pub fn devtools_create_terminal_session(
    input: DevTerminalCreateInput,
    app: AppHandle,
    state: State<DevTerminalManager>,
) -> Result<DevTerminalSessionSnapshot, String> {
    state.create_session(input, &app)
}

#[tauri::command]
pub fn devtools_write_terminal_session(
    input: DevTerminalWriteInput,
    state: State<DevTerminalManager>,
) -> Result<(), String> {
    state.write(&input.session_id, &input.data)
}

#[tauri::command]
pub fn devtools_resize_terminal_session(
    input: DevTerminalResizeInput,
    state: State<DevTerminalManager>,
) -> Result<DevTerminalSessionSnapshot, String> {
    state.resize(&input.session_id, input.cols, input.rows)
}

#[tauri::command]
pub fn devtools_restart_terminal_session(
    session_id: String,
    app: AppHandle,
    state: State<DevTerminalManager>,
) -> Result<DevTerminalSessionSnapshot, String> {
    state.restart_session(&session_id, &app)
}

#[tauri::command]
pub fn devtools_close_terminal_session(
    session_id: String,
    state: State<DevTerminalManager>,
) -> Result<(), String> {
    state.close_session(&session_id)
}

#[tauri::command]
pub fn devtools_get_terminal_session_snapshot(
    session_id: String,
    state: State<DevTerminalManager>,
) -> Result<DevTerminalSessionSnapshot, String> {
    state.snapshot(&session_id)
}
