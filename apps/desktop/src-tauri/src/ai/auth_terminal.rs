use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use vault_ai_ai::{CLAUDE_RUNTIME_ID, GEMINI_RUNTIME_ID};

use super::claude::{
    save_setup_config as save_claude_setup_config, ClaudeRuntime, ClaudeSetupInput,
};
use super::gemini::{
    save_setup_config as save_gemini_setup_config, GeminiRuntime, GeminiSetupInput,
};

const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 28;
const MONITOR_INTERVAL: Duration = Duration::from_millis(120);
const OUTPUT_CHUNK_SIZE: usize = 4096;
const MAX_AUTH_TERMINAL_BUFFER: usize = 32 * 1024;

pub const AI_AUTH_TERMINAL_STARTED_EVENT: &str = "ai://auth-terminal-started";
pub const AI_AUTH_TERMINAL_OUTPUT_EVENT: &str = "ai://auth-terminal-output";
pub const AI_AUTH_TERMINAL_EXITED_EVENT: &str = "ai://auth-terminal-exited";
pub const AI_AUTH_TERMINAL_ERROR_EVENT: &str = "ai://auth-terminal-error";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiAuthTerminalStatus {
    Starting,
    Running,
    Exited,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthTerminalSessionSnapshot {
    pub session_id: String,
    pub runtime_id: String,
    pub program: String,
    pub display_name: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub buffer: String,
    pub status: AiAuthTerminalStatus,
    pub exit_code: Option<i32>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthTerminalOutputPayload {
    pub session_id: String,
    pub chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthTerminalErrorPayload {
    pub session_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthTerminalStartInput {
    pub runtime_id: String,
    pub vault_path: Option<String>,
    pub custom_binary_path: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthTerminalWriteInput {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthTerminalResizeInput {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
struct TerminalLaunchConfig {
    runtime_id: String,
    program: String,
    args: Vec<String>,
    display_name: String,
    cwd: PathBuf,
}

struct SessionHandle {
    snapshot: Arc<Mutex<AiAuthTerminalSessionSnapshot>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    closed: Arc<AtomicBool>,
}

impl SessionHandle {
    fn snapshot(&self) -> Result<AiAuthTerminalSessionSnapshot, String> {
        self.snapshot
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?
            .clone()
            .pipe(Ok)
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

pub struct AiAuthTerminalManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    next_session_id: AtomicU64,
}

impl Default for AiAuthTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AiAuthTerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session_id: AtomicU64::new(1),
        }
    }

    pub fn start_session(
        &self,
        input: AiAuthTerminalStartInput,
        app: &AppHandle,
    ) -> Result<AiAuthTerminalSessionSnapshot, String> {
        let session_id = self.next_session_id();
        self.spawn_session(session_id, input, app)
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let handle = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal state error: {error}"))?;
            sessions.remove(session_id)
        };

        if let Some(handle) = handle {
            self.stop_session_handle(handle);
        }

        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal state error: {error}"))?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Auth terminal session not found: {session_id}"))?;
            Arc::clone(&session.writer)
        };

        let mut writer_guard = writer
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
        let writer = writer_guard
            .as_mut()
            .ok_or_else(|| "Auth terminal writer is not available".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("Failed to write to auth terminal: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush auth terminal input: {error}"))?;
        Ok(())
    }

    pub fn resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<AiAuthTerminalSessionSnapshot, String> {
        let (snapshot, master) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal state error: {error}"))?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Auth terminal session not found: {session_id}"))?;
            (Arc::clone(&session.snapshot), Arc::clone(&session.master))
        };

        let cols = cols.max(1);
        let rows = rows.max(1);

        master
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Failed to resize auth terminal PTY: {error}"))?;

        let mut snapshot = snapshot
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
        snapshot.cols = cols;
        snapshot.rows = rows;
        Ok(snapshot.clone())
    }

    pub fn snapshot(&self, session_id: &str) -> Result<AiAuthTerminalSessionSnapshot, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
        sessions
            .get(session_id)
            .ok_or_else(|| format!("Auth terminal session not found: {session_id}"))?
            .snapshot()
    }

    fn next_session_id(&self) -> String {
        format!(
            "authterm-{}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn spawn_session(
        &self,
        session_id: String,
        input: AiAuthTerminalStartInput,
        app: &AppHandle,
    ) -> Result<AiAuthTerminalSessionSnapshot, String> {
        let cols = input.cols.unwrap_or(DEFAULT_COLS).max(1);
        let rows = input.rows.unwrap_or(DEFAULT_ROWS).max(1);
        let launch_config = resolve_auth_terminal_launch_config(app, &input)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Failed to create auth terminal PTY: {error}"))?;

        let master = Arc::new(Mutex::new(pair.master));
        let mut command = CommandBuilder::new(&launch_config.program);
        command.args(&launch_config.args);
        command.cwd(&launch_config.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLUMNS", cols.to_string());
        command.env("LINES", rows.to_string());

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Failed to start {}: {error}", launch_config.display_name))?;
        let killer = child.clone_killer();
        let writer = master
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?
            .take_writer()
            .map_err(|error| format!("Failed to open auth terminal writer: {error}"))?;
        let reader = master
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?
            .try_clone_reader()
            .map_err(|error| format!("Failed to open auth terminal reader: {error}"))?;

        let snapshot = Arc::new(Mutex::new(AiAuthTerminalSessionSnapshot {
            session_id: session_id.clone(),
            runtime_id: launch_config.runtime_id.clone(),
            program: launch_config.program.clone(),
            display_name: launch_config.display_name.clone(),
            cwd: launch_config.cwd.to_string_lossy().into_owned(),
            cols,
            rows,
            buffer: String::new(),
            status: AiAuthTerminalStatus::Running,
            exit_code: None,
            error_message: None,
        }));

        let writer = Arc::new(Mutex::new(Some(writer)));
        let child = Arc::new(Mutex::new(child));
        let killer = Arc::new(Mutex::new(killer));
        let closed = Arc::new(AtomicBool::new(false));
        let handle = SessionHandle {
            snapshot: Arc::clone(&snapshot),
            master: Arc::clone(&master),
            writer: Arc::clone(&writer),
            killer: Arc::clone(&killer),
            closed: Arc::clone(&closed),
        };
        let created_snapshot = snapshot
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?
            .clone();

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
        sessions.insert(session_id.clone(), handle);
        drop(sessions);

        spawn_output_reader(
            reader,
            Arc::clone(&snapshot),
            Arc::clone(&closed),
            app.clone(),
            session_id.clone(),
        );

        spawn_exit_monitor(
            Arc::clone(&self.sessions),
            session_id.clone(),
            child,
            snapshot,
            closed,
            app.clone(),
        );

        emit_started(app, &created_snapshot);

        Ok(created_snapshot)
    }

    fn stop_session_handle(&self, handle: SessionHandle) {
        handle.closed.store(true, Ordering::Relaxed);

        if let Ok(mut writer) = handle.writer.lock() {
            writer.take();
        }

        if let Ok(mut killer) = handle.killer.lock() {
            let _ = killer.kill();
        }
    }
}

#[tauri::command]
pub fn ai_start_auth_terminal_session(
    input: AiAuthTerminalStartInput,
    app: AppHandle,
    state: State<AiAuthTerminalManager>,
) -> Result<AiAuthTerminalSessionSnapshot, String> {
    state.start_session(input, &app)
}

#[tauri::command]
pub fn ai_write_auth_terminal_session(
    input: AiAuthTerminalWriteInput,
    state: State<AiAuthTerminalManager>,
) -> Result<(), String> {
    state.write(&input.session_id, &input.data)
}

#[tauri::command]
pub fn ai_resize_auth_terminal_session(
    input: AiAuthTerminalResizeInput,
    state: State<AiAuthTerminalManager>,
) -> Result<AiAuthTerminalSessionSnapshot, String> {
    state.resize(&input.session_id, input.cols, input.rows)
}

#[tauri::command]
pub fn ai_close_auth_terminal_session(
    session_id: String,
    state: State<AiAuthTerminalManager>,
) -> Result<(), String> {
    state.close_session(&session_id)
}

#[tauri::command]
pub fn ai_get_auth_terminal_session_snapshot(
    session_id: String,
    state: State<AiAuthTerminalManager>,
) -> Result<AiAuthTerminalSessionSnapshot, String> {
    state.snapshot(&session_id)
}

fn emit_started(app: &AppHandle, snapshot: &AiAuthTerminalSessionSnapshot) {
    let _ = app.emit(AI_AUTH_TERMINAL_STARTED_EVENT, snapshot.clone());
}

fn emit_output(app: &AppHandle, session_id: &str, chunk: String) {
    let _ = app.emit(
        AI_AUTH_TERMINAL_OUTPUT_EVENT,
        AiAuthTerminalOutputPayload {
            session_id: session_id.to_string(),
            chunk,
        },
    );
}

fn emit_exited(app: &AppHandle, snapshot: &AiAuthTerminalSessionSnapshot) {
    let _ = app.emit(AI_AUTH_TERMINAL_EXITED_EVENT, snapshot.clone());
}

fn emit_error(app: &AppHandle, session_id: &str, message: String) {
    let _ = app.emit(
        AI_AUTH_TERMINAL_ERROR_EVENT,
        AiAuthTerminalErrorPayload {
            session_id: session_id.to_string(),
            message,
        },
    );
}

fn trim_auth_terminal_buffer(buffer: &mut String) {
    if buffer.len() <= MAX_AUTH_TERMINAL_BUFFER {
        return;
    }

    let keep_from = buffer.len().saturating_sub(MAX_AUTH_TERMINAL_BUFFER);
    let trimmed = buffer
        .get(keep_from..)
        .unwrap_or(buffer.as_str())
        .to_string();
    *buffer = format!("...[truncated]\n{trimmed}");
}

fn spawn_output_reader(
    mut reader: Box<dyn Read + Send>,
    snapshot: Arc<Mutex<AiAuthTerminalSessionSnapshot>>,
    closed: Arc<AtomicBool>,
    app: AppHandle,
    session_id: String,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; OUTPUT_CHUNK_SIZE];
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
                    if let Ok(mut snapshot_guard) = snapshot.lock() {
                        snapshot_guard.buffer.push_str(&chunk);
                        trim_auth_terminal_buffer(&mut snapshot_guard.buffer);
                    }
                    emit_output(&app, &session_id, chunk);
                }
                Err(error) => {
                    if !closed.load(Ordering::Relaxed) {
                        emit_error(
                            &app,
                            &session_id,
                            format!("Failed to read auth terminal output: {error}"),
                        );
                    }
                    break;
                }
            }
        }
    });
}

fn spawn_exit_monitor(
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    session_id: String,
    child: Arc<Mutex<Box<dyn PtyChild + Send + Sync>>>,
    snapshot: Arc<Mutex<AiAuthTerminalSessionSnapshot>>,
    closed: Arc<AtomicBool>,
    app: AppHandle,
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

            match child_guard.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    let session_id = snapshot
                        .lock()
                        .ok()
                        .map(|snapshot| snapshot.session_id.clone())
                        .unwrap_or_else(|| "unknown".to_string());
                    emit_error(
                        &app,
                        &session_id,
                        format!("Failed to monitor auth terminal process: {error}"),
                    );
                    break;
                }
            }
        };

        if let Some(exit_status) = exit_status {
            let snapshot = {
                let mut snapshot_guard = match snapshot.lock() {
                    Ok(snapshot_guard) => snapshot_guard,
                    Err(_) => break,
                };
                snapshot_guard.status = AiAuthTerminalStatus::Exited;
                snapshot_guard.exit_code = i32::try_from(exit_status.exit_code()).ok();
                snapshot_guard.error_message = None;
                snapshot_guard.clone()
            };
            emit_exited(&app, &snapshot);
            if let Ok(mut sessions_guard) = sessions.lock() {
                sessions_guard.remove(&session_id);
            }
            break;
        }

        thread::sleep(MONITOR_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    use super::{trim_auth_terminal_buffer, MAX_AUTH_TERMINAL_BUFFER};

    #[test]
    fn trim_auth_terminal_buffer_keeps_small_buffers_unchanged() {
        let mut buffer = "hello".to_string();
        trim_auth_terminal_buffer(&mut buffer);
        assert_eq!(buffer, "hello");
    }

    #[test]
    fn trim_auth_terminal_buffer_keeps_tail_with_marker() {
        let mut buffer = "a".repeat(MAX_AUTH_TERMINAL_BUFFER + 64);
        trim_auth_terminal_buffer(&mut buffer);

        assert!(buffer.starts_with("...[truncated]\n"));
        assert!(buffer.len() > MAX_AUTH_TERMINAL_BUFFER);
        assert!(buffer.ends_with(&"a".repeat(MAX_AUTH_TERMINAL_BUFFER)));
    }
}

fn resolve_auth_terminal_launch_config(
    app: &AppHandle,
    input: &AiAuthTerminalStartInput,
) -> Result<TerminalLaunchConfig, String> {
    match input.runtime_id.as_str() {
        CLAUDE_RUNTIME_ID => resolve_claude_launch_config(app, input),
        GEMINI_RUNTIME_ID => resolve_gemini_launch_config(app, input),
        other => Err(format!(
            "Integrated auth terminal is not supported for runtime: {other}"
        )),
    }
}

fn resolve_claude_launch_config(
    app: &AppHandle,
    input: &AiAuthTerminalStartInput,
) -> Result<TerminalLaunchConfig, String> {
    if let Some(custom_binary_path) = input.custom_binary_path.clone() {
        let _ = save_claude_setup_config(
            app,
            ClaudeSetupInput {
                custom_binary_path: Some(custom_binary_path),
                anthropic_base_url: None,
                anthropic_custom_headers: super::secret_store::SecretValuePatch::Unchanged,
                anthropic_auth_token: super::secret_store::SecretValuePatch::Unchanged,
            },
        )?;
    }

    let runtime = ClaudeRuntime::default();
    let resolved = runtime.resolved_binary(app)?;
    let program = resolved
        .program
        .ok_or_else(|| "Claude runtime binary is not configured.".to_string())?;
    let mut args = resolved.args;
    args.push("--cli".to_string());

    Ok(TerminalLaunchConfig {
        runtime_id: CLAUDE_RUNTIME_ID.to_string(),
        program,
        args,
        display_name: "Claude sign-in".to_string(),
        cwd: resolve_terminal_cwd(input.vault_path.as_deref())?,
    })
}

fn resolve_gemini_launch_config(
    app: &AppHandle,
    input: &AiAuthTerminalStartInput,
) -> Result<TerminalLaunchConfig, String> {
    if let Some(custom_binary_path) = input.custom_binary_path.clone() {
        let _ = save_gemini_setup_config(
            app,
            GeminiSetupInput {
                custom_binary_path: Some(custom_binary_path),
                gemini_api_key: super::secret_store::SecretValuePatch::Unchanged,
                google_api_key: super::secret_store::SecretValuePatch::Unchanged,
                google_cloud_project: None,
                google_cloud_location: None,
                gateway_base_url: None,
                gateway_headers: super::secret_store::SecretValuePatch::Unchanged,
            },
        )?;
    }

    let runtime = GeminiRuntime::default();
    let resolved = runtime.resolved_binary(app)?;
    let program = resolved
        .program
        .ok_or_else(|| "Gemini CLI is not configured.".to_string())?;
    let args = resolved.args;

    Ok(TerminalLaunchConfig {
        runtime_id: GEMINI_RUNTIME_ID.to_string(),
        program,
        args,
        display_name: "Gemini sign-in".to_string(),
        cwd: resolve_terminal_cwd(input.vault_path.as_deref())?,
    })
}

fn resolve_terminal_cwd(requested_cwd: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = requested_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        if path.is_dir() {
            return Ok(path);
        }
        return Err(format!(
            "The terminal working directory does not exist: {}",
            path.to_string_lossy()
        ));
    }

    if let Some(home) = home_dir() {
        return Ok(home);
    }

    env::current_dir()
        .map_err(|error| format!("Failed to resolve auth terminal working directory: {error}"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE").map(PathBuf::from)
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME").map(PathBuf::from)
    }
}
