use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use tauri::AppHandle;

use super::emit::{
    emit_terminal_error, emit_terminal_exited, emit_terminal_output, emit_terminal_started,
};
use super::types::{DevTerminalCreateInput, DevTerminalSessionSnapshot, DevTerminalStatus};

const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 28;
const MONITOR_INTERVAL: Duration = Duration::from_millis(120);
const OUTPUT_CHUNK_SIZE: usize = 4096;

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
            .map_err(|error| format!("Internal state error: {error}"))?
            .clone()
            .pipe(Ok)
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

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

pub struct DevTerminalManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    next_session_id: AtomicU64,
}

impl Default for DevTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DevTerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
        }
    }

    pub fn create_session(
        &self,
        input: DevTerminalCreateInput,
        app: &AppHandle,
    ) -> Result<DevTerminalSessionSnapshot, String> {
        let session_id = self.next_session_id();
        self.spawn_session(session_id, input, app)
    }

    pub fn restart_session(
        &self,
        session_id: &str,
        app: &AppHandle,
    ) -> Result<DevTerminalSessionSnapshot, String> {
        let previous = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal state error: {error}"))?;
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
            app,
        )
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
        let (writer, snapshot) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal state error: {error}"))?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
            (Arc::clone(&session.writer), Arc::clone(&session.snapshot))
        };

        let mut writer_guard = writer
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
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

    pub fn resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<DevTerminalSessionSnapshot, String> {
        let (snapshot, master) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("Internal state error: {error}"))?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
            (Arc::clone(&session.snapshot), Arc::clone(&session.master))
        };

        let cols = cols.max(1);
        let rows = rows.max(1);

        let master_guard = master
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
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
            .map_err(|error| format!("Internal state error: {error}"))?;
        snapshot.cols = cols;
        snapshot.rows = rows;
        Ok(snapshot.clone())
    }

    pub fn snapshot(&self, session_id: &str) -> Result<DevTerminalSessionSnapshot, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
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
        app: &AppHandle,
    ) -> Result<DevTerminalSessionSnapshot, String> {
        let cols = input.cols.unwrap_or(DEFAULT_COLS).max(1);
        let rows = input.rows.unwrap_or(DEFAULT_ROWS).max(1);
        let launch_config = resolve_terminal_launch_config(input.cwd.as_deref(), cols, rows)?;
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
            .map_err(|error| format!("Internal state error: {error}"))?
            .as_ref()
            .ok_or_else(|| "Terminal PTY is not available".to_string())?
            .take_writer()
            .map_err(|error| format!("Failed to open terminal writer: {error}"))?;
        let reader = master
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?
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
            app.clone(),
            session_id.clone(),
        );
        spawn_exit_monitor(
            Arc::clone(&handle.master),
            Arc::clone(&handle.writer),
            Arc::clone(&handle.child),
            Arc::clone(&handle.killer),
            Arc::clone(&handle.snapshot),
            Arc::clone(&handle.closed),
            app.clone(),
        );

        let created_snapshot = handle.snapshot()?;
        emit_terminal_started(app, &created_snapshot);

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("Internal state error: {error}"))?;
        sessions.insert(session_id, handle);

        Ok(created_snapshot)
    }

    fn stop_session_handle(&self, handle: SessionHandle) {
        handle.closed.store(true, Ordering::Relaxed);
        handle.release_runtime_resources(true);
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
                    emit_terminal_output(&app, &session_id, chunk);
                }
                Err(error) => {
                    if !closed.load(Ordering::Relaxed) {
                        emit_terminal_error(
                            &app,
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
                    emit_terminal_error(&app, &session_id, message);
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
            emit_terminal_exited(&app, &snapshot);
            break;
        }

        thread::sleep(MONITOR_INTERVAL);
    });
}

fn resolve_terminal_launch_config(
    requested_cwd: Option<&str>,
    _cols: u16,
    _rows: u16,
) -> Result<TerminalLaunchConfig, String> {
    let cwd = resolve_terminal_cwd(requested_cwd)?;

    #[cfg(target_os = "windows")]
    {
        let candidates = [
            ("pwsh.exe", vec!["-NoLogo".to_string()], "PowerShell"),
            (
                "powershell.exe",
                vec!["-NoLogo".to_string()],
                "Windows PowerShell",
            ),
        ];

        for (program, args, display_name) in candidates {
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

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::native_pty_system;
    use portable_pty::ExitStatus;
    use std::fs;
    use std::io;
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);

    fn make_temp_dir() -> PathBuf {
        let suffix = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let dir = env::temp_dir().join(format!("neverwrite-devtools-test-{timestamp}-{suffix}"));
        fs::create_dir_all(&dir).expect("temp test dir");
        dir
    }

    #[derive(Debug)]
    struct FakeChild {
        kill_count: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
    }

    impl Drop for FakeChild {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> io::Result<()> {
            self.kill_count.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(FakeKiller {
                kill_count: Arc::clone(&self.kill_count),
                dropped: Arc::new(AtomicUsize::new(0)),
            })
        }
    }

    impl PtyChild for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(1)
        }
    }

    #[derive(Debug)]
    struct FakeKiller {
        kill_count: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
    }

    impl Drop for FakeKiller {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    impl ChildKiller for FakeKiller {
        fn kill(&mut self) -> io::Result<()> {
            self.kill_count.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(FakeKiller {
                kill_count: Arc::clone(&self.kill_count),
                dropped: Arc::clone(&self.dropped),
            })
        }
    }

    fn make_snapshot(
        session_id: &str,
        status: DevTerminalStatus,
    ) -> Arc<Mutex<DevTerminalSessionSnapshot>> {
        Arc::new(Mutex::new(DevTerminalSessionSnapshot {
            session_id: session_id.to_string(),
            program: "/bin/sh".to_string(),
            display_name: "Shell".to_string(),
            cwd: "/tmp".to_string(),
            cols: 80,
            rows: 24,
            status,
            exit_code: None,
            error_message: None,
        }))
    }

    fn make_session_handle(
        session_id: &str,
        status: DevTerminalStatus,
    ) -> (
        SessionHandle,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    ) {
        let child_dropped = Arc::new(AtomicUsize::new(0));
        let killer_dropped = Arc::new(AtomicUsize::new(0));
        let kill_count = Arc::new(AtomicUsize::new(0));
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("test pty");
        let writer = pair.master.take_writer().expect("test pty writer");

        let handle = SessionHandle {
            snapshot: make_snapshot(session_id, status),
            master: Arc::new(Mutex::new(Some(pair.master))),
            writer: Arc::new(Mutex::new(Some(writer))),
            child: Arc::new(Mutex::new(Some(Box::new(FakeChild {
                kill_count: Arc::clone(&kill_count),
                dropped: Arc::clone(&child_dropped),
            })))),
            killer: Arc::new(Mutex::new(Some(Box::new(FakeKiller {
                kill_count: Arc::clone(&kill_count),
                dropped: Arc::clone(&killer_dropped),
            })))),
            closed: Arc::new(AtomicBool::new(false)),
        };

        (handle, kill_count, child_dropped, killer_dropped)
    }

    #[test]
    fn resolves_requested_cwd_when_directory_exists() {
        let dir = make_temp_dir();
        let resolved =
            resolve_terminal_cwd(Some(dir.to_string_lossy().as_ref())).expect("cwd should resolve");
        assert_eq!(resolved, dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_missing_requested_cwd() {
        let dir = env::temp_dir().join("neverwrite-devtools-missing-dir");
        let error = resolve_terminal_cwd(Some(dir.to_string_lossy().as_ref()))
            .expect_err("missing cwd should fail");
        assert!(error.contains("does not exist"));
    }

    #[test]
    fn resolves_launch_config_for_current_platform() {
        let dir = make_temp_dir();
        let config = resolve_terminal_launch_config(Some(dir.to_string_lossy().as_ref()), 120, 30)
            .expect("launch config should resolve");

        assert!(!config.program.is_empty());
        assert!(!config.display_name.is_empty());
        assert_eq!(config.cwd, dir);
        #[cfg(target_os = "windows")]
        assert!(config.program.ends_with(".exe"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_session_id_is_stable_and_incremental() {
        let manager = DevTerminalManager::new();
        assert_eq!(manager.next_session_id(), "devterm-1");
        assert_eq!(manager.next_session_id(), "devterm-2");
    }

    #[test]
    fn release_runtime_resources_compacts_exited_session_without_killing_process() {
        let (handle, kill_count, child_dropped, killer_dropped) =
            make_session_handle("devterm-1", DevTerminalStatus::Exited);

        handle.release_runtime_resources(false);

        assert!(handle.master.lock().unwrap().is_none());
        assert!(handle.writer.lock().unwrap().is_none());
        assert!(handle.child.lock().unwrap().is_none());
        assert!(handle.killer.lock().unwrap().is_none());
        assert_eq!(kill_count.load(Ordering::Relaxed), 0);
        assert_eq!(child_dropped.load(Ordering::Relaxed), 1);
        assert_eq!(killer_dropped.load(Ordering::Relaxed), 1);
        assert_eq!(handle.snapshot().unwrap().status, DevTerminalStatus::Exited);
    }

    #[test]
    fn close_session_releases_runtime_resources_and_kills_process() {
        let manager = DevTerminalManager::new();
        let (handle, kill_count, child_dropped, killer_dropped) =
            make_session_handle("devterm-1", DevTerminalStatus::Running);

        manager
            .sessions
            .lock()
            .unwrap()
            .insert("devterm-1".to_string(), handle);

        manager.close_session("devterm-1").unwrap();

        assert_eq!(kill_count.load(Ordering::Relaxed), 1);
        assert_eq!(child_dropped.load(Ordering::Relaxed), 1);
        assert_eq!(killer_dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn resize_updates_snapshot_even_after_runtime_resources_are_released() {
        let manager = DevTerminalManager::new();
        let (handle, _, _, _) = make_session_handle("devterm-1", DevTerminalStatus::Exited);
        handle.release_runtime_resources(false);

        manager
            .sessions
            .lock()
            .unwrap()
            .insert("devterm-1".to_string(), handle);

        let snapshot = manager.resize("devterm-1", 132, 40).unwrap();

        assert_eq!(snapshot.cols, 132);
        assert_eq!(snapshot.rows, 40);
        assert_eq!(snapshot.status, DevTerminalStatus::Exited);
    }

    #[test]
    fn write_reports_exited_session_after_runtime_resources_are_released() {
        let manager = DevTerminalManager::new();
        let (handle, _, _, _) = make_session_handle("devterm-1", DevTerminalStatus::Exited);
        handle.release_runtime_resources(false);

        manager
            .sessions
            .lock()
            .unwrap()
            .insert("devterm-1".to_string(), handle);

        let error = manager.write("devterm-1", "echo test\n").unwrap_err();
        assert!(error.contains("already exited"));
    }
}
