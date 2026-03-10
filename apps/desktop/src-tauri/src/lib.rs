mod ai;

use std::collections::{hash_map::DefaultHasher, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::RecommendedWatcher;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use vault_ai_index::{IndexBuildPhase, VaultIndex};
use vault_ai_types::{
    BacklinkDto, NoteDetailDto, NoteDocument, NoteDto, NoteId, NoteMetadata, SearchResultDto,
    VaultNoteChangeDto, VaultOpenMetricsDto, VaultOpenStateDto,
};
use vault_ai_vault::{start_watcher, DiscoveredNoteFile, Vault, VaultEvent, WriteTracker};

const VAULT_NOTE_CHANGED_EVENT: &str = "vault://note-changed";
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const OPEN_STATE_POLL_INTERVAL: Duration = Duration::from_millis(25);

struct AppState {
    vault: Option<Vault>,
    index: Option<VaultIndex>,
    watcher: Option<RecommendedWatcher>,
    write_tracker: WriteTracker,
    open_job_id: u64,
    open_cancel: Option<Arc<AtomicBool>>,
    open_state: VaultOpenState,
}

#[derive(Debug, Clone, Default)]
struct VaultOpenMetrics {
    scan_ms: u64,
    snapshot_load_ms: u64,
    parse_ms: u64,
    index_ms: u64,
    snapshot_save_ms: u64,
}

#[derive(Debug, Clone)]
struct VaultOpenState {
    path: Option<String>,
    stage: String,
    message: String,
    processed: usize,
    total: usize,
    note_count: usize,
    snapshot_used: bool,
    cancelled: bool,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    metrics: VaultOpenMetrics,
    error: Option<String>,
}

impl Default for VaultOpenState {
    fn default() -> Self {
        Self::idle()
    }
}

impl VaultOpenState {
    fn idle() -> Self {
        Self {
            path: None,
            stage: "idle".to_string(),
            message: String::new(),
            processed: 0,
            total: 0,
            note_count: 0,
            snapshot_used: false,
            cancelled: false,
            started_at_ms: None,
            finished_at_ms: None,
            metrics: VaultOpenMetrics::default(),
            error: None,
        }
    }

    fn starting(path: String) -> Self {
        Self {
            path: Some(path),
            stage: "scanning".to_string(),
            message: "Scanning files...".to_string(),
            processed: 0,
            total: 0,
            note_count: 0,
            snapshot_used: false,
            cancelled: false,
            started_at_ms: Some(now_ms()),
            finished_at_ms: None,
            metrics: VaultOpenMetrics::default(),
            error: None,
        }
    }

    fn update_stage(&mut self, stage: &str, message: &str, processed: usize, total: usize) {
        self.stage = stage.to_string();
        self.message = message.to_string();
        self.processed = processed;
        self.total = total;
        self.finished_at_ms = None;
    }

    fn finish_ready(&mut self, note_count: usize, snapshot_used: bool, metrics: VaultOpenMetrics) {
        self.stage = "ready".to_string();
        self.message = "Vault ready".to_string();
        self.processed = note_count;
        self.total = note_count;
        self.note_count = note_count;
        self.snapshot_used = snapshot_used;
        self.cancelled = false;
        self.metrics = metrics;
        self.error = None;
        self.finished_at_ms = Some(now_ms());
    }

    fn finish_error(&mut self, message: String, metrics: VaultOpenMetrics) {
        self.stage = "error".to_string();
        self.message = "Failed to open vault".to_string();
        self.error = Some(message);
        self.cancelled = false;
        self.metrics = metrics;
        self.finished_at_ms = Some(now_ms());
    }

    fn finish_cancelled(&mut self) {
        self.stage = "cancelled".to_string();
        self.message = "Opening cancelled".to_string();
        self.cancelled = true;
        self.error = None;
        self.finished_at_ms = Some(now_ms());
    }

    fn to_dto(&self) -> VaultOpenStateDto {
        VaultOpenStateDto {
            path: self.path.clone(),
            stage: self.stage.clone(),
            message: self.message.clone(),
            processed: self.processed,
            total: self.total,
            note_count: self.note_count,
            snapshot_used: self.snapshot_used,
            cancelled: self.cancelled,
            started_at_ms: self.started_at_ms,
            finished_at_ms: self.finished_at_ms,
            metrics: VaultOpenMetricsDto {
                scan_ms: self.metrics.scan_ms,
                snapshot_load_ms: self.metrics.snapshot_load_ms,
                parse_ms: self.metrics.parse_ms,
                index_ms: self.metrics.index_ms,
                snapshot_save_ms: self.metrics.snapshot_save_ms,
            },
            error: self.error.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct VaultFingerprint {
    note_count: usize,
    modified_sum: u64,
    size_sum: u64,
}

impl VaultFingerprint {
    fn from_files(files: &[DiscoveredNoteFile]) -> Self {
        let mut modified_sum = 0_u64;
        let mut size_sum = 0_u64;

        for file in files {
            modified_sum = modified_sum.wrapping_add(file.modified_at);
            size_sum = size_sum.wrapping_add(file.size);
        }

        Self {
            note_count: files.len(),
            modified_sum,
            size_sum,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedVaultMetadata {
    version: u32,
    root_path: String,
    created_at_ms: u64,
    note_count: usize,
    fingerprint: VaultFingerprint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedVaultSnapshot {
    files: Vec<DiscoveredNoteFile>,
    index: VaultIndex,
}

#[derive(Debug, Clone)]
struct LoadedSnapshot {
    metadata: PersistedVaultMetadata,
    payload: PersistedVaultSnapshot,
}

struct OpenVaultResult {
    vault: Vault,
    index: VaultIndex,
    snapshot_used: bool,
    metrics: VaultOpenMetrics,
}

macro_rules! lock {
    ($state:expr) => {
        $state
            .lock()
            .map_err(|e| format!("Error de estado interno: {e}"))
    };
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn get_file_times(path: &std::path::Path) -> (u64, u64) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, 0);
    };
    let modified = meta.modified().map(system_time_to_secs).unwrap_or(0);
    let created = meta.created().map(system_time_to_secs).unwrap_or(modified);
    (modified, created)
}

fn system_time_to_secs(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn note_to_dto(n: &NoteMetadata) -> NoteDto {
    NoteDto {
        id: n.id.0.clone(),
        path: n.path.0.to_string_lossy().to_string(),
        title: n.title.clone(),
        modified_at: n.modified_at,
        created_at: n.created_at,
    }
}

fn note_document_to_dto(note: &NoteDocument) -> NoteDto {
    let (modified_at, created_at) = get_file_times(&note.path.0);
    NoteDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        modified_at,
        created_at,
    }
}

fn note_to_detail(note: &NoteDocument) -> NoteDetailDto {
    NoteDetailDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        content: note.raw_markdown.clone(),
        tags: note.tags.clone(),
        links: note.links.iter().map(|l| l.target.clone()).collect(),
        frontmatter: note.frontmatter.clone(),
    }
}

fn with_app_state<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut AppState) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<Mutex<AppState>>();
    let mut guard = lock!(state)?;
    f(&mut guard)
}

fn update_open_state_for_job(
    app: &AppHandle,
    job_id: u64,
    f: impl FnOnce(&mut VaultOpenState),
) -> Result<bool, String> {
    with_app_state(app, |state| {
        if state.open_job_id != job_id {
            return Ok(false);
        }
        f(&mut state.open_state);
        Ok(true)
    })
}

fn finish_cancelled_for_job(app: &AppHandle, job_id: u64) -> Result<(), String> {
    let _ = update_open_state_for_job(app, job_id, |open_state| {
        open_state.finish_cancelled();
    })?;
    Ok(())
}

fn ensure_not_cancelled(
    cancel: &Arc<AtomicBool>,
    app: &AppHandle,
    job_id: u64,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        finish_cancelled_for_job(app, job_id)?;
        return Err("cancelled".to_string());
    }
    Ok(())
}

fn snapshot_directory(app: &AppHandle, vault_root: &Path) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;

    let mut hasher = DefaultHasher::new();
    vault_root.to_string_lossy().hash(&mut hasher);
    let vault_id = format!("{:016x}", hasher.finish());

    Ok(base.join("vault-index").join(vault_id))
}

fn metadata_path(snapshot_dir: &Path) -> PathBuf {
    snapshot_dir.join("metadata.json")
}

fn snapshot_path(snapshot_dir: &Path) -> PathBuf {
    snapshot_dir.join("snapshot.json")
}

fn load_snapshot(app: &AppHandle, vault_root: &Path) -> Option<LoadedSnapshot> {
    let snapshot_dir = snapshot_directory(app, vault_root).ok()?;
    let metadata = fs::read(metadata_path(&snapshot_dir)).ok()?;
    let snapshot = fs::read(snapshot_path(&snapshot_dir)).ok()?;

    let metadata: PersistedVaultMetadata = serde_json::from_slice(&metadata).ok()?;
    let payload: PersistedVaultSnapshot = serde_json::from_slice(&snapshot).ok()?;

    Some(LoadedSnapshot { metadata, payload })
}

pub(crate) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Snapshot path without parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let temp_path = path.with_extension(format!("{}.tmp", now_ms()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temp_path, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn save_snapshot(
    app: &AppHandle,
    vault_root: &Path,
    files: &[DiscoveredNoteFile],
    index: &VaultIndex,
    fingerprint: &VaultFingerprint,
) -> Result<(), String> {
    let snapshot_dir = snapshot_directory(app, vault_root)?;
    let root_path = vault_root.to_string_lossy().to_string();

    let metadata = PersistedVaultMetadata {
        version: SNAPSHOT_SCHEMA_VERSION,
        root_path,
        created_at_ms: now_ms(),
        note_count: index.metadata.len(),
        fingerprint: fingerprint.clone(),
    };

    let snapshot = PersistedVaultSnapshot {
        files: files.to_vec(),
        index: index.clone(),
    };

    write_json_atomic(&metadata_path(&snapshot_dir), &metadata)?;
    write_json_atomic(&snapshot_path(&snapshot_dir), &snapshot)?;
    Ok(())
}

fn start_index_watcher(
    app: AppHandle,
    root: PathBuf,
    write_tracker: WriteTracker,
) -> Result<RecommendedWatcher, String> {
    start_watcher(root, write_tracker, move |event| {
        handle_external_vault_event(&app, event);
    })
    .map_err(|error| error.to_string())
}

fn handle_external_vault_event(app: &AppHandle, event: VaultEvent) {
    let change = with_app_state(app, |state| {
        let Some(vault) = state.vault.as_ref() else {
            return Ok(None);
        };
        let Some(index) = state.index.as_mut() else {
            return Ok(None);
        };

        let change = match event {
            VaultEvent::FileCreated(path) | VaultEvent::FileModified(path) => {
                match vault.read_note_from_path(&path) {
                    Ok(note) => {
                        let dto = note_document_to_dto(&note);
                        let note_id = note.id.0.clone();
                        index.reindex_note(note);
                        Some(VaultNoteChangeDto {
                            kind: "upsert".to_string(),
                            note: Some(dto),
                            note_id: Some(note_id),
                        })
                    }
                    Err(_) => {
                        // File can't be read — likely moved/renamed away.
                        // Treat as delete so stale entries are removed.
                        let note_id = vault.path_to_id(&path);
                        index.remove_note(&NoteId(note_id.clone()));
                        Some(VaultNoteChangeDto {
                            kind: "delete".to_string(),
                            note: None,
                            note_id: Some(note_id),
                        })
                    }
                }
            }
            VaultEvent::FileDeleted(path) => {
                let note_id = vault.path_to_id(&path);
                index.remove_note(&NoteId(note_id.clone()));
                Some(VaultNoteChangeDto {
                    kind: "delete".to_string(),
                    note: None,
                    note_id: Some(note_id),
                })
            }
            VaultEvent::FileRenamed { from, to } => {
                let old_id = vault.path_to_id(&from);
                index.remove_note(&NoteId(old_id.clone()));
                match vault.read_note_from_path(&to) {
                    Ok(note) => {
                        let dto = note_document_to_dto(&note);
                        let note_id = note.id.0.clone();
                        index.reindex_note(note);
                        Some(VaultNoteChangeDto {
                            kind: "upsert".to_string(),
                            note: Some(dto),
                            note_id: Some(note_id),
                        })
                    }
                    Err(_) => Some(VaultNoteChangeDto {
                        kind: "delete".to_string(),
                        note: None,
                        note_id: Some(old_id),
                    }),
                }
            }
        };

        Ok(change)
    });

    if let Ok(Some(change)) = change {
        let _ = app.emit(VAULT_NOTE_CHANGED_EVENT, change);
    }
}

fn run_open_vault_job(
    app: &AppHandle,
    job_id: u64,
    path: String,
    cancel: Arc<AtomicBool>,
) -> Result<OpenVaultResult, String> {
    let vault = Vault::open(PathBuf::from(&path)).map_err(|error| error.to_string())?;
    let mut metrics = VaultOpenMetrics::default();

    let scan_started = Instant::now();
    let files = vault
        .discover_markdown_files()
        .map_err(|error| error.to_string())?;
    metrics.scan_ms = scan_started.elapsed().as_millis() as u64;
    update_open_state_for_job(app, job_id, |open_state| {
        open_state.metrics.scan_ms = metrics.scan_ms;
        open_state.update_stage("scanning", "Scanning files...", files.len(), files.len());
    })?;

    ensure_not_cancelled(&cancel, app, job_id)?;

    let fingerprint = VaultFingerprint::from_files(&files);

    let snapshot_load_started = Instant::now();
    let snapshot = load_snapshot(app, &vault.root);
    metrics.snapshot_load_ms = snapshot_load_started.elapsed().as_millis() as u64;
    update_open_state_for_job(app, job_id, |open_state| {
        open_state.metrics.snapshot_load_ms = metrics.snapshot_load_ms;
        open_state.update_stage("indexing", "Loading snapshot...", 0, files.len());
    })?;

    ensure_not_cancelled(&cancel, app, job_id)?;

    let root_path = vault.root.to_string_lossy().to_string();

    let (index, snapshot_used) = match snapshot {
        Some(loaded)
            if loaded.metadata.version == SNAPSHOT_SCHEMA_VERSION
                && loaded.metadata.root_path == root_path
                && loaded.metadata.fingerprint == fingerprint =>
        {
            (loaded.payload.index, true)
        }
        Some(loaded)
            if loaded.metadata.version == SNAPSHOT_SCHEMA_VERSION
                && loaded.metadata.root_path == root_path =>
        {
            let snapshot_files: HashMap<String, DiscoveredNoteFile> = loaded
                .payload
                .files
                .iter()
                .cloned()
                .map(|file| (file.id.clone(), file))
                .collect();

            let current_ids: std::collections::HashSet<String> =
                files.iter().map(|file| file.id.clone()).collect();
            let deleted_ids: Vec<String> = loaded
                .payload
                .files
                .iter()
                .filter(|file| !current_ids.contains(&file.id))
                .map(|file| file.id.clone())
                .collect();

            let changed_files: Vec<DiscoveredNoteFile> = files
                .iter()
                .filter(|file| match snapshot_files.get(&file.id) {
                    Some(previous) => {
                        previous.modified_at != file.modified_at
                            || previous.size != file.size
                            || previous.path != file.path
                    }
                    None => true,
                })
                .cloned()
                .collect();

            update_open_state_for_job(app, job_id, |open_state| {
                open_state.update_stage(
                    "parsing",
                    "Parsing changed notes...",
                    0,
                    changed_files.len(),
                );
            })?;

            let parse_started = Instant::now();
            let changed_notes = vault
                .parse_discovered_files(&changed_files, |processed| {
                    let _ = update_open_state_for_job(app, job_id, |open_state| {
                        open_state.update_stage(
                            "parsing",
                            "Parsing changed notes...",
                            processed,
                            changed_files.len(),
                        );
                    });
                })
                .map_err(|error| error.to_string())?;
            metrics.parse_ms = parse_started.elapsed().as_millis() as u64;

            ensure_not_cancelled(&cancel, app, job_id)?;

            update_open_state_for_job(app, job_id, |open_state| {
                open_state.metrics.parse_ms = metrics.parse_ms;
                open_state.update_stage(
                    "indexing",
                    "Refreshing index...",
                    0,
                    deleted_ids.len() + changed_notes.len(),
                );
            })?;

            let index_started = Instant::now();
            let mut next_index = loaded.payload.index;

            let total_ops = deleted_ids.len() + changed_notes.len();
            let mut processed = 0_usize;

            for note_id in deleted_ids {
                next_index.remove_note(&NoteId(note_id));
                processed += 1;
                let _ = update_open_state_for_job(app, job_id, |open_state| {
                    open_state.update_stage(
                        "indexing",
                        "Refreshing index...",
                        processed,
                        total_ops,
                    );
                });
            }

            for note in changed_notes {
                ensure_not_cancelled(&cancel, app, job_id)?;
                next_index.reindex_note(note);
                processed += 1;
                let _ = update_open_state_for_job(app, job_id, |open_state| {
                    open_state.update_stage(
                        "indexing",
                        "Refreshing index...",
                        processed,
                        total_ops,
                    );
                });
            }

            metrics.index_ms = index_started.elapsed().as_millis() as u64;
            (next_index, true)
        }
        _ => {
            update_open_state_for_job(app, job_id, |open_state| {
                open_state.update_stage("parsing", "Parsing notes...", 0, files.len());
            })?;

            let parse_started = Instant::now();
            let notes = vault
                .parse_discovered_files(&files, |processed| {
                    let _ = update_open_state_for_job(app, job_id, |open_state| {
                        open_state.update_stage(
                            "parsing",
                            "Parsing notes...",
                            processed,
                            files.len(),
                        );
                    });
                })
                .map_err(|error| error.to_string())?;
            metrics.parse_ms = parse_started.elapsed().as_millis() as u64;

            ensure_not_cancelled(&cancel, app, job_id)?;

            let index_started = Instant::now();
            let index = VaultIndex::build_with_progress(notes, |progress| {
                let message = match progress.phase {
                    IndexBuildPhase::RegisteringNotes => "Registering notes...",
                    IndexBuildPhase::ResolvingLinks => "Resolving links...",
                };

                let _ = update_open_state_for_job(app, job_id, |open_state| {
                    open_state.metrics.parse_ms = metrics.parse_ms;
                    open_state.update_stage("indexing", message, progress.current, progress.total);
                });
            });
            metrics.index_ms = index_started.elapsed().as_millis() as u64;
            (index, false)
        }
    };

    update_open_state_for_job(app, job_id, |open_state| {
        open_state.metrics.index_ms = metrics.index_ms;
        open_state.update_stage(
            "saving_snapshot",
            "Saving snapshot...",
            index.metadata.len(),
            index.metadata.len(),
        );
    })?;

    let snapshot_save_started = Instant::now();
    let _ = save_snapshot(app, &vault.root, &files, &index, &fingerprint);
    metrics.snapshot_save_ms = snapshot_save_started.elapsed().as_millis() as u64;

    Ok(OpenVaultResult {
        vault,
        index,
        snapshot_used,
        metrics,
    })
}

fn start_open_vault_inner(
    path: String,
    app: AppHandle,
    state: &tauri::State<'_, Mutex<AppState>>,
) -> Result<u64, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let write_tracker = {
        let mut state = lock!(state)?;

        if let Some(previous_cancel) = state.open_cancel.take() {
            previous_cancel.store(true, Ordering::Relaxed);
        }

        state.open_job_id = state.open_job_id.wrapping_add(1);
        state.open_cancel = Some(cancel.clone());
        state.open_state = VaultOpenState::starting(path.clone());
        state.vault = None;
        state.index = None;
        state.watcher = None;

        state.write_tracker.clone()
    };

    let job_id = {
        let state = lock!(state)?;
        state.open_job_id
    };

    std::thread::spawn(
        move || match run_open_vault_job(&app, job_id, path, cancel.clone()) {
            Ok(result) => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = finish_cancelled_for_job(&app, job_id);
                    return;
                }

                let watcher = match start_index_watcher(
                    app.clone(),
                    result.vault.root.clone(),
                    write_tracker,
                ) {
                    Ok(watcher) => watcher,
                    Err(error) => {
                        let _ = update_open_state_for_job(&app, job_id, |open_state| {
                            open_state.finish_error(error.clone(), result.metrics.clone());
                        });
                        return;
                    }
                };

                let _ = with_app_state(&app, |state| {
                    if state.open_job_id != job_id {
                        return Ok(());
                    }

                    let note_count = result.index.metadata.len();
                    state.vault = Some(result.vault);
                    state.index = Some(result.index);
                    state.watcher = Some(watcher);
                    state.open_cancel = None;
                    state
                        .open_state
                        .finish_ready(note_count, result.snapshot_used, result.metrics);
                    Ok(())
                });
            }
            Err(error) if error == "cancelled" => {
                let _ = finish_cancelled_for_job(&app, job_id);
            }
            Err(error) => {
                let _ = update_open_state_for_job(&app, job_id, |open_state| {
                    let metrics = open_state.metrics.clone();
                    open_state.finish_error(error.clone(), metrics);
                });
            }
        },
    );

    Ok(job_id)
}

fn wait_for_job_completion(app: &AppHandle, job_id: u64) -> Result<(), String> {
    loop {
        let state = app.state::<Mutex<AppState>>();
        let current = lock!(state)?;

        if current.open_job_id != job_id {
            return Err("Open vault job was replaced".to_string());
        }

        match current.open_state.stage.as_str() {
            "ready" => return Ok(()),
            "error" => {
                return Err(current
                    .open_state
                    .error
                    .clone()
                    .unwrap_or_else(|| "Failed to open vault".to_string()))
            }
            "cancelled" => return Err("Opening cancelled".to_string()),
            _ => {}
        }

        drop(current);
        std::thread::sleep(OPEN_STATE_POLL_INTERVAL);
    }
}

#[tauri::command]
fn open_vault(
    path: String,
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<NoteDto>, String> {
    let job_id = start_open_vault_inner(path, app.clone(), &state)?;
    wait_for_job_completion(&app, job_id)?;
    list_notes(state)
}

#[tauri::command]
fn start_open_vault(
    path: String,
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    start_open_vault_inner(path, app, &state)?;
    Ok(())
}

#[tauri::command]
fn get_vault_open_state(state: tauri::State<Mutex<AppState>>) -> Result<VaultOpenStateDto, String> {
    let state = lock!(state)?;
    Ok(state.open_state.to_dto())
}

#[tauri::command]
fn cancel_open_vault(state: tauri::State<Mutex<AppState>>) -> Result<(), String> {
    let mut state = lock!(state)?;
    if let Some(cancel) = state.open_cancel.as_ref() {
        cancel.store(true, Ordering::Relaxed);
        state.open_state.finish_cancelled();
    }
    Ok(())
}

#[tauri::command]
fn list_notes(state: tauri::State<Mutex<AppState>>) -> Result<Vec<NoteDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    let mut notes: Vec<NoteDto> = index.metadata.values().map(note_to_dto).collect();
    notes.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(notes)
}

#[tauri::command]
fn read_note(
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;
    let note = vault.read_note(&note_id).map_err(|e| e.to_string())?;

    Ok(note_to_detail(&note))
}

#[tauri::command]
fn save_note(
    note_id: String,
    content: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let path = vault.id_to_path(&note_id);
    state.write_tracker.track(path.clone());

    vault
        .save_note(&note_id, &content)
        .map_err(|e| e.to_string())?;

    // Build NoteDocument from content we already have — skip re-reading from disk
    let note = vault_ai_vault::parser::parse_note(&note_id, &path, &content);
    let dto = note_to_detail(&note);
    if let Some(index) = state.index.as_mut() {
        index.reindex_note(note);
    }

    Ok(dto)
}

#[tauri::command]
fn create_note(
    path: String,
    content: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let abs_path = vault.root.join(&path);
    state.write_tracker.track(abs_path);

    let note = vault
        .create_note(&path, &content)
        .map_err(|e| e.to_string())?;

    let dto = note_to_detail(&note);

    if let Some(index) = state.index.as_mut() {
        index.reindex_note(note);
    }

    Ok(dto)
}

#[tauri::command]
fn delete_note(note_id: String, state: tauri::State<Mutex<AppState>>) -> Result<(), String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let path = vault.id_to_path(&note_id);
    state.write_tracker.track(path);

    vault.delete_note(&note_id).map_err(|e| e.to_string())?;

    if let Some(index) = state.index.as_mut() {
        index.remove_note(&NoteId(note_id));
    }

    Ok(())
}

#[tauri::command]
fn rename_note(
    note_id: String,
    new_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let old_path = vault.id_to_path(&note_id);
    let new_abs_path = vault.root.join(&new_path);
    state.write_tracker.track(old_path);
    state.write_tracker.track(new_abs_path);

    let note = vault
        .rename_note(&note_id, &new_path)
        .map_err(|e| e.to_string())?;

    let dto = note_to_detail(&note);

    if let Some(index) = state.index.as_mut() {
        index.remove_note(&NoteId(note_id));
        index.reindex_note(note);
    }

    Ok(dto)
}

#[tauri::command]
fn search_notes(
    query: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<SearchResultDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    Ok(index
        .search(&query)
        .into_iter()
        .take(200)
        .map(|r| SearchResultDto {
            id: r.metadata.id.0.clone(),
            path: r.metadata.path.0.to_string_lossy().to_string(),
            title: r.metadata.title.clone(),
            score: r.score,
        })
        .collect())
}

#[derive(serde::Serialize)]
struct TagDto {
    tag: String,
    note_ids: Vec<String>,
}

#[tauri::command]
fn get_tags(state: tauri::State<Mutex<AppState>>) -> Result<Vec<TagDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    let mut tags: Vec<TagDto> = index
        .tags
        .iter()
        .map(|(tag, note_ids)| TagDto {
            tag: tag.clone(),
            note_ids: note_ids.iter().map(|id| id.0.clone()).collect(),
        })
        .collect();

    tags.sort_by(|a, b| a.tag.cmp(&b.tag));
    Ok(tags)
}

#[tauri::command]
fn get_backlinks(
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<BacklinkDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    let id = NoteId(note_id);
    Ok(index
        .get_backlinks(&id)
        .into_iter()
        .filter_map(|bl_id| {
            let note = index.metadata.get(bl_id)?;
            Some(BacklinkDto {
                id: note.id.0.clone(),
                title: note.title.clone(),
            })
        })
        .collect())
}

#[tauri::command]
fn delete_vault_snapshot(app: AppHandle, vault_path: String) -> Result<(), String> {
    let root = Path::new(&vault_path);
    let dir = snapshot_directory(&app, root)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppState {
            vault: None,
            index: None,
            watcher: None,
            write_tracker: WriteTracker::new(),
            open_job_id: 0,
            open_cancel: None,
            open_state: VaultOpenState::idle(),
        }))
        .manage(Mutex::new(ai::AiManager::new()))
        .invoke_handler(tauri::generate_handler![
            open_vault,
            start_open_vault,
            get_vault_open_state,
            cancel_open_vault,
            list_notes,
            read_note,
            save_note,
            create_note,
            delete_note,
            rename_note,
            search_notes,
            get_backlinks,
            get_tags,
            ai::commands::ai_list_runtimes,
            ai::commands::ai_get_setup_status,
            ai::commands::ai_update_setup,
            ai::commands::ai_start_auth,
            ai::commands::ai_list_sessions,
            ai::commands::ai_load_session,
            ai::commands::ai_create_session,
            ai::commands::ai_set_model,
            ai::commands::ai_set_mode,
            ai::commands::ai_set_config_option,
            ai::commands::ai_cancel_turn,
            ai::commands::ai_send_message,
            ai::commands::ai_respond_permission,
            ai::commands::ai_save_session_history,
            ai::commands::ai_load_session_histories,
            ai::commands::ai_delete_session_history,
            ai::commands::ai_delete_all_session_histories,
            ai::commands::ai_prune_session_histories,
            delete_vault_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
