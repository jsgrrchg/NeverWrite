use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::Sender,
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::RpcOutput;

const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 28;
const MONITOR_INTERVAL: Duration = Duration::from_millis(120);
const OUTPUT_CHUNK_SIZE: usize = 4096;

const DEV_TERMINAL_OUTPUT_EVENT: &str = "devtools://terminal-output";
const DEV_TERMINAL_STARTED_EVENT: &str = "devtools://terminal-started";
const DEV_TERMINAL_EXITED_EVENT: &str = "devtools://terminal-exited";
const DEV_TERMINAL_ERROR_EVENT: &str = "devtools://terminal-error";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DevTerminalStatus {
    Running,
    Exited,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevTerminalSessionSnapshot {
    pub session_id: String,
    pub program: String,
    pub display_name: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: DevTerminalStatus,
    pub exit_code: Option<i32>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevTerminalCreateInput {
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevTerminalWriteInput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevTerminalResizeInput {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone)]
struct TerminalLaunchConfig {
    program: String,
    args: Vec<String>,
    display_name: String,
    cwd: PathBuf,
}

struct SessionHandle {
    snapshot: Arc<Mutex<DevTerminalSessionSnapshot>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    closed: Arc<AtomicBool>,
}

impl SessionHandle {
    fn snapshot(&self) -> Result<DevTerminalSessionSnapshot, String> {
        self.snapshot
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))
            .map(|snapshot| snapshot.clone())
    }

    fn release_runtime_resources(&self, terminate_process: bool) {
        release_session_runtime_resources(
            &self.master,
            &self.writer,
            &self.child,
            &self.killer,
            terminate_process,
        );
    }
}

pub struct DevTerminalManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    next_session_id: AtomicU64,
    event_tx: Sender<RpcOutput>,
}

impl DevTerminalManager {
    pub fn new(event_tx: Sender<RpcOutput>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
            event_tx,
        }
    }

    pub fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        match command {
            "devtools_create_terminal_session" => {
                let input = parse_input::<DevTerminalCreateInput>(&args)?;
                Ok(json!(self.create_session(input)?))
            }
            "devtools_write_terminal_session" => {
                let input = parse_input::<DevTerminalWriteInput>(&args)?;
                self.write(&input.session_id, &input.data)?;
                Ok(json!(null))
            }
            "devtools_resize_terminal_session" => {
                let input = parse_input::<DevTerminalResizeInput>(&args)?;
                Ok(json!(self.resize(
                    &input.session_id,
                    input.cols,
                    input.rows
                )?))
            }
            "devtools_restart_terminal_session" => {
                let session_id = required_string(&args, &["sessionId", "session_id"])?;
                Ok(json!(self.restart_session(&session_id)?))
            }
            "devtools_close_terminal_session" => {
                let session_id = required_string(&args, &["sessionId", "session_id"])?;
                self.close_session(&session_id)?;
                Ok(json!(null))
            }
            "devtools_get_terminal_session_snapshot" => {
                let session_id = required_string(&args, &["sessionId", "session_id"])?;
                Ok(json!(self.snapshot(&session_id)?))
            }
            _ => Err(format!("Unknown devtools command: {command}")),
        }
    }

    fn create_session(
        &self,
        input: DevTerminalCreateInput,
    ) -> Result<DevTerminalSessionSnapshot, String> {
        let session_id = self.next_session_id();
        self.spawn_session(session_id, input)
    }

    fn restart_session(&self, session_id: &str) -> Result<DevTerminalSessionSnapshot, String> {
        let previous = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal terminal state error: {error}"))?;
            sessions
                .remove(session_id)
                .ok_or_else(|| format!("Terminal session not found: {session_id}"))?
        };

        let snapshot = previous.snapshot()?;
        self.stop_session_handle(previous);
        self.spawn_session(
            session_id.to_string(),
            DevTerminalCreateInput {
                cwd: Some(snapshot.cwd),
                cols: Some(snapshot.cols),
                rows: Some(snapshot.rows),
            },
        )
    }

    pub fn close_all(&self) {
        let handles = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, handle)| handle)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for handle in handles {
            self.stop_session_handle(handle);
        }
    }

    fn close_session(&self, session_id: &str) -> Result<(), String> {
        let handle = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal terminal state error: {error}"))?;
            sessions.remove(session_id)
        };

        if let Some(handle) = handle {
            self.stop_session_handle(handle);
        }

        Ok(())
    }

    fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let (writer, snapshot) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal terminal state error: {error}"))?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
            (Arc::clone(&session.writer), Arc::clone(&session.snapshot))
        };

        let mut writer_guard = writer
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))?;
        let writer = if let Some(writer) = writer_guard.as_mut() {
            writer
        } else {
            let status = snapshot
                .lock()
                .map(|snapshot| snapshot.status.clone())
                .unwrap_or(DevTerminalStatus::Error);
            return Err(match status {
                DevTerminalStatus::Exited => "Terminal session has already exited".to_string(),
                DevTerminalStatus::Error => "Terminal session is no longer available".to_string(),
                _ => "Terminal session writer is not available".to_string(),
            });
        };
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("Failed to write to terminal session: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush terminal input: {error}"))?;
        Ok(())
    }

    fn resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<DevTerminalSessionSnapshot, String> {
        let (snapshot, master) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal terminal state error: {error}"))?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
            (Arc::clone(&session.snapshot), Arc::clone(&session.master))
        };

        let cols = cols.max(1);
        let rows = rows.max(1);

        let master_guard = master
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))?;
        if let Some(master) = master_guard.as_ref() {
            master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("Failed to resize terminal PTY: {error}"))?;
        }

        let mut snapshot = snapshot
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))?;
        snapshot.cols = cols;
        snapshot.rows = rows;
        Ok(snapshot.clone())
    }

    fn snapshot(&self, session_id: &str) -> Result<DevTerminalSessionSnapshot, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))?;
        sessions
            .get(session_id)
            .ok_or_else(|| format!("Terminal session not found: {session_id}"))?
            .snapshot()
    }

    fn next_session_id(&self) -> String {
        format!(
            "devterm-{}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn spawn_session(
        &self,
        session_id: String,
        input: DevTerminalCreateInput,
    ) -> Result<DevTerminalSessionSnapshot, String> {
        let cols = input.cols.unwrap_or(DEFAULT_COLS).max(1);
        let rows = input.rows.unwrap_or(DEFAULT_ROWS).max(1);
        let launch_config = resolve_terminal_launch_config(input.cwd.as_deref())?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Failed to create terminal PTY: {error}"))?;

        let master = Arc::new(Mutex::new(Some(pair.master)));
        let mut command = CommandBuilder::new(&launch_config.program);
        command.args(&launch_config.args);
        command.cwd(&launch_config.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLUMNS", cols.to_string());
        command.env("LINES", rows.to_string());

        let child = pair.slave.spawn_command(command).map_err(|error| {
            format!(
                "Failed to start shell {}: {error}",
                launch_config.display_name
            )
        })?;
        let killer = child.clone_killer();
        let writer = master
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))?
            .as_ref()
            .ok_or_else(|| "Terminal PTY is not available".to_string())?
            .take_writer()
            .map_err(|error| format!("Failed to open terminal writer: {error}"))?;
        let reader = master
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))?
            .as_ref()
            .ok_or_else(|| "Terminal PTY is not available".to_string())?
            .try_clone_reader()
            .map_err(|error| format!("Failed to open terminal reader: {error}"))?;

        let snapshot = Arc::new(Mutex::new(DevTerminalSessionSnapshot {
            session_id: session_id.clone(),
            program: launch_config.program.clone(),
            display_name: launch_config.display_name.clone(),
            cwd: launch_config.cwd.to_string_lossy().into_owned(),
            cols,
            rows,
            status: DevTerminalStatus::Running,
            exit_code: None,
            error_message: None,
        }));

        let handle = SessionHandle {
            snapshot: Arc::clone(&snapshot),
            master: Arc::clone(&master),
            writer: Arc::new(Mutex::new(Some(writer))),
            child: Arc::new(Mutex::new(Some(child))),
            killer: Arc::new(Mutex::new(Some(killer))),
            closed: Arc::new(AtomicBool::new(false)),
        };

        spawn_output_reader(
            reader,
            Arc::clone(&handle.closed),
            self.event_tx.clone(),
            session_id.clone(),
        );
        spawn_exit_monitor(
            Arc::clone(&handle.master),
            Arc::clone(&handle.writer),
            Arc::clone(&handle.child),
            Arc::clone(&handle.killer),
            Arc::clone(&handle.snapshot),
            Arc::clone(&handle.closed),
            self.event_tx.clone(),
        );

        let created_snapshot = handle.snapshot()?;
        emit_terminal_started(&self.event_tx, &created_snapshot);

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("Internal terminal state error: {error}"))?;
        sessions.insert(session_id, handle);

        Ok(created_snapshot)
    }

    fn stop_session_handle(&self, handle: SessionHandle) {
        handle.closed.store(true, Ordering::Relaxed);
        handle.release_runtime_resources(true);
    }
}

impl Drop for DevTerminalManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn release_session_runtime_resources(
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

fn spawn_output_reader(
    mut reader: Box<dyn Read + Send>,
    closed: Arc<AtomicBool>,
    event_tx: Sender<RpcOutput>,
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
                    emit_terminal_output(&event_tx, &session_id, chunk);
                }
                Err(error) => {
                    if !closed.load(Ordering::Relaxed) {
                        emit_terminal_error(
                            &event_tx,
                            &session_id,
                            format!("Failed to read shell output: {error}"),
                        );
                    }
                    break;
                }
            }
        }
    });
}

fn spawn_exit_monitor(
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    snapshot: Arc<Mutex<DevTerminalSessionSnapshot>>,
    closed: Arc<AtomicBool>,
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
                        snapshot_guard.status = DevTerminalStatus::Error;
                        snapshot_guard.exit_code = None;
                        snapshot_guard.error_message =
                            Some(format!("Failed to monitor shell process: {error}"));
                        (
                            snapshot_guard.session_id.clone(),
                            snapshot_guard
                                .error_message
                                .clone()
                                .unwrap_or_else(|| "Failed to monitor shell process".to_string()),
                        )
                    };
                    release_session_runtime_resources(&master, &writer, &child, &killer, false);
                    emit_terminal_error(&event_tx, &session_id, message);
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
                snapshot_guard.status = DevTerminalStatus::Exited;
                snapshot_guard.exit_code = i32::try_from(exit_status.exit_code()).ok();
                snapshot_guard.error_message = None;
                snapshot_guard.clone()
            };
            release_session_runtime_resources(&master, &writer, &child, &killer, false);
            emit_terminal_exited(&event_tx, &snapshot);
            break;
        }

        thread::sleep(MONITOR_INTERVAL);
    });
}

fn resolve_terminal_launch_config(
    requested_cwd: Option<&str>,
) -> Result<TerminalLaunchConfig, String> {
    let cwd = resolve_terminal_cwd(requested_cwd)?;

    #[cfg(target_os = "windows")]
    {
        for (program, args, display_name) in [
            ("pwsh.exe", vec!["-NoLogo".to_string()], "PowerShell"),
            (
                "powershell.exe",
                vec!["-NoLogo".to_string()],
                "Windows PowerShell",
            ),
        ] {
            if let Some(path) = find_program(program) {
                return Ok(TerminalLaunchConfig {
                    program: path.to_string_lossy().into_owned(),
                    args,
                    display_name: display_name.to_string(),
                    cwd,
                });
            }
        }

        if let Some(comspec) = env::var_os("COMSPEC") {
            return Ok(TerminalLaunchConfig {
                program: PathBuf::from(comspec).to_string_lossy().into_owned(),
                args: Vec::new(),
                display_name: "Command Prompt".to_string(),
                cwd,
            });
        }

        if let Some(path) = find_program("cmd.exe") {
            return Ok(TerminalLaunchConfig {
                program: path.to_string_lossy().into_owned(),
                args: Vec::new(),
                display_name: "Command Prompt".to_string(),
                cwd,
            });
        }

        Err(
            "No compatible shell was found. Install PowerShell or ensure COMSPEC points to cmd.exe"
                .to_string(),
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(shell) = env::var_os("SHELL") {
            candidates.push(PathBuf::from(shell));
        }
        #[cfg(target_os = "macos")]
        {
            candidates.push(PathBuf::from("/bin/zsh"));
            candidates.push(PathBuf::from("/bin/sh"));
        }
        #[cfg(target_os = "linux")]
        {
            candidates.push(PathBuf::from("/bin/bash"));
            candidates.push(PathBuf::from("/bin/sh"));
        }

        for candidate in candidates {
            if candidate.as_os_str().is_empty() {
                continue;
            }
            let path = if candidate.is_absolute() {
                if candidate.exists() {
                    candidate
                } else {
                    continue;
                }
            } else if let Some(found) = find_program(candidate.to_string_lossy().as_ref()) {
                found
            } else {
                continue;
            };

            let display_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Shell")
                .to_string();

            return Ok(TerminalLaunchConfig {
                program: path.to_string_lossy().into_owned(),
                args: vec!["-i".to_string()],
                display_name,
                cwd,
            });
        }

        Err("No compatible shell was found. Check SHELL or install a standard shell such as zsh, bash or sh".to_string())
    }
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
        .map_err(|error| format!("Failed to resolve terminal working directory: {error}"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE").map(PathBuf::from).or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            Some(PathBuf::from(format!(
                "{}{}",
                PathBuf::from(drive).to_string_lossy(),
                PathBuf::from(path).to_string_lossy()
            )))
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME").map(PathBuf::from)
    }
}

fn find_program(program: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() {
        return candidate.exists().then_some(candidate);
    }

    let paths = env::var_os("PATH")?;
    env::split_paths(&paths)
        .map(|path| path.join(program))
        .find(|path| path.exists() && path_is_file(path))
}

fn path_is_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn emit_terminal_started(event_tx: &Sender<RpcOutput>, snapshot: &DevTerminalSessionSnapshot) {
    emit_event(event_tx, DEV_TERMINAL_STARTED_EVENT, json!(snapshot));
}

fn emit_terminal_output(event_tx: &Sender<RpcOutput>, session_id: &str, chunk: String) {
    emit_event(
        event_tx,
        DEV_TERMINAL_OUTPUT_EVENT,
        json!({
            "sessionId": session_id,
            "chunk": chunk,
        }),
    );
}

fn emit_terminal_exited(event_tx: &Sender<RpcOutput>, snapshot: &DevTerminalSessionSnapshot) {
    emit_event(event_tx, DEV_TERMINAL_EXITED_EVENT, json!(snapshot));
}

fn emit_terminal_error(event_tx: &Sender<RpcOutput>, session_id: &str, message: String) {
    emit_event(
        event_tx,
        DEV_TERMINAL_ERROR_EVENT,
        json!({
            "sessionId": session_id,
            "message": message,
        }),
    );
}

fn emit_event(event_tx: &Sender<RpcOutput>, event_name: &str, payload: Value) {
    let _ = event_tx.send(RpcOutput::Event {
        event_name: event_name.to_string(),
        payload,
    });
}

fn parse_input<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    let input = args.get("input").cloned().unwrap_or_else(|| args.clone());
    serde_json::from_value(input).map_err(|error| error.to_string())
}

fn required_string(args: &Value, keys: &[&str]) -> Result<String, String> {
    for key in keys {
        if let Some(value) = args.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(format!("Missing argument: {}", keys[0]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolves_requested_cwd_when_directory_exists() {
        let dir = tempfile::tempdir().expect("temp dir");
        let resolved = resolve_terminal_cwd(Some(dir.path().to_string_lossy().as_ref()))
            .expect("cwd should resolve");
        assert_eq!(resolved, dir.path());
    }

    #[test]
    fn rejects_missing_requested_cwd() {
        let dir = env::temp_dir().join("neverwrite-devtools-missing-dir");
        let _ = fs::remove_dir_all(&dir);
        let error = resolve_terminal_cwd(Some(dir.to_string_lossy().as_ref()))
            .expect_err("missing cwd should fail");
        assert!(error.contains("does not exist"));
    }

    #[test]
    fn parses_renderer_input_wrapper() {
        let input: DevTerminalResizeInput = parse_input(&json!({
            "input": {
                "sessionId": "devterm-1",
                "cols": 132,
                "rows": 40
            }
        }))
        .expect("input should parse");
        assert_eq!(input.session_id, "devterm-1");
        assert_eq!(input.cols, 132);
        assert_eq!(input.rows, 40);
    }
}
