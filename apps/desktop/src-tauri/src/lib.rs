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
    AdvancedSearchParams, AdvancedSearchResultDto, BacklinkDto, NoteDetailDto, NoteDocument,
    NoteDto, NoteId, NoteMetadata, OutlineHeadingDto, ResolvedLinkDto, ResolvedWikilinkDto,
    SearchResultDto, VaultEntryDto, VaultNoteChangeDto, VaultOpenMetricsDto, VaultOpenStateDto,
    WikilinkSuggestionDto,
};
use vault_ai_vault::{start_watcher, DiscoveredNoteFile, Vault, VaultEvent, WriteTracker};

const VAULT_NOTE_CHANGED_EVENT: &str = "vault://note-changed";
const SNAPSHOT_SCHEMA_VERSION: u32 = 2;
const OPEN_STATE_POLL_INTERVAL: Duration = Duration::from_millis(25);

// --- Debug timing ---
static DEBUG_TIMING: AtomicBool = AtomicBool::new(false);

macro_rules! dbg_log {
    ($($arg:tt)*) => {
        if DEBUG_TIMING.load(Ordering::Relaxed) {
            eprintln!("[perf] {}", format!($($arg)*));
        }
    };
}

fn path_has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
}

fn compute_entry_search_score(query_lower: &str, title: &str, path: &str) -> f64 {
    let title_lower = title.to_lowercase();
    let path_lower = path.to_lowercase();

    let title_score = if title_lower.contains(query_lower) {
        compute_substring_score(query_lower, &title_lower)
    } else {
        0.0
    };

    let path_score = if path_lower.contains(query_lower) {
        compute_substring_score(query_lower, &path_lower) * 0.8
    } else {
        0.0
    };

    title_score.max(path_score)
}

fn compute_substring_score(query: &str, target: &str) -> f64 {
    if target == query {
        return 1.0;
    }
    if target.starts_with(query) {
        return 0.9 * (query.len() as f64 / target.len().max(1) as f64);
    }
    0.5 * (query.len() as f64 / target.len().max(1) as f64)
}

struct VaultInstance {
    vault: Option<Vault>,
    index: Option<VaultIndex>,
    entries: Option<Vec<VaultEntryDto>>,
    watcher: Option<RecommendedWatcher>,
    open_job_id: u64,
    open_cancel: Option<Arc<AtomicBool>>,
    open_state: VaultOpenState,
}

impl VaultInstance {
    fn new() -> Self {
        Self {
            vault: None,
            index: None,
            entries: None,
            watcher: None,
            open_job_id: 0,
            open_cancel: None,
            open_state: VaultOpenState::idle(),
        }
    }
}

struct AppState {
    vaults: HashMap<String, VaultInstance>,
    write_tracker: WriteTracker,
    next_job_id: u64,
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
    entry_count: usize,
    entry_modified_sum: u64,
    entry_size_sum: u64,
}

impl VaultFingerprint {
    fn from_state(files: &[DiscoveredNoteFile], entries: &[VaultEntryDto]) -> Self {
        let mut modified_sum = 0_u64;
        let mut size_sum = 0_u64;
        let mut entry_modified_sum = 0_u64;
        let mut entry_size_sum = 0_u64;

        for file in files {
            modified_sum = modified_sum.wrapping_add(file.modified_at);
            size_sum = size_sum.wrapping_add(file.size);
        }

        for entry in entries {
            entry_modified_sum = entry_modified_sum.wrapping_add(entry.modified_at);
            entry_size_sum = entry_size_sum.wrapping_add(entry.size);
        }

        Self {
            note_count: files.len(),
            modified_sum,
            size_sum,
            entry_count: entries.len(),
            entry_modified_sum,
            entry_size_sum,
        }
    }
}

fn fnv1a_hash_hex(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn resolve_vault_scoped_path(vault_root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    let resolved = if candidate.is_absolute() {
        normalize_path(&candidate)
    } else {
        normalize_path(&vault_root.join(candidate))
    };

    if !resolved.starts_with(vault_root) {
        return Err("Path fuera del vault".to_string());
    }

    Ok(resolved)
}

fn build_unique_trash_target_path(
    vault_root: &Path,
    source_path: &Path,
) -> Result<PathBuf, String> {
    let relative_path = source_path
        .strip_prefix(vault_root)
        .map_err(|_| "Path fuera del vault".to_string())?;
    let trash_root = vault_root.join(".trash");
    let initial_target = trash_root.join(relative_path);

    if !initial_target.exists() {
        return Ok(initial_target);
    }

    let parent = initial_target
        .parent()
        .ok_or("No se pudo resolver carpeta destino")?;
    let file_name = initial_target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Nombre de archivo inválido")?;
    let stem = initial_target
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(file_name);
    let extension = initial_target.extension().and_then(|value| value.to_str());

    for index in 2.. {
        let candidate_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem} {index}.{ext}"),
            _ => format!("{stem} {index}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("No se pudo resolver destino en trash".to_string())
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
    #[serde(default)]
    entries: Vec<VaultEntryDto>,
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
    entries: Vec<VaultEntryDto>,
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

// --- Helpers for vault instance access ---

fn update_open_state_for_job(
    app: &AppHandle,
    vault_path: &str,
    job_id: u64,
    f: impl FnOnce(&mut VaultOpenState),
) -> Result<bool, String> {
    let state = app.state::<Mutex<AppState>>();
    let mut guard = lock!(state)?;
    let Some(instance) = guard.vaults.get_mut(vault_path) else {
        return Ok(false);
    };
    if instance.open_job_id != job_id {
        return Ok(false);
    }
    f(&mut instance.open_state);
    Ok(true)
}

fn finish_cancelled_for_job(app: &AppHandle, vault_path: &str, job_id: u64) -> Result<(), String> {
    let _ = update_open_state_for_job(app, vault_path, job_id, |open_state| {
        open_state.finish_cancelled();
    })?;
    Ok(())
}

fn ensure_not_cancelled(
    cancel: &Arc<AtomicBool>,
    app: &AppHandle,
    vault_path: &str,
    job_id: u64,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        finish_cancelled_for_job(app, vault_path, job_id)?;
        return Err("cancelled".to_string());
    }
    Ok(())
}

// --- Snapshot helpers ---

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

fn cleanup_obsolete_snapshot(snapshot_dir: &Path, version: u32) {
    if version < SNAPSHOT_SCHEMA_VERSION {
        let _ = fs::remove_dir_all(snapshot_dir);
    }
}

fn load_snapshot(app: &AppHandle, vault_root: &Path) -> Option<LoadedSnapshot> {
    let snapshot_dir = snapshot_directory(app, vault_root).ok()?;
    let metadata = fs::read(metadata_path(&snapshot_dir)).ok()?;
    let snapshot = fs::read(snapshot_path(&snapshot_dir)).ok()?;

    let metadata: PersistedVaultMetadata = serde_json::from_slice(&metadata).ok()?;
    if metadata.version < SNAPSHOT_SCHEMA_VERSION {
        cleanup_obsolete_snapshot(&snapshot_dir, metadata.version);
        return None;
    }
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
    entries: &[VaultEntryDto],
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
        entries: entries.to_vec(),
        index: index.clone(),
    };

    write_json_atomic(&metadata_path(&snapshot_dir), &metadata)?;
    write_json_atomic(&snapshot_path(&snapshot_dir), &snapshot)?;
    Ok(())
}

fn refresh_entries_cache(instance: &mut VaultInstance) -> Result<(), String> {
    let Some(vault) = instance.vault.as_ref() else {
        instance.entries = None;
        return Ok(());
    };

    let entries = vault
        .discover_vault_entries()
        .map_err(|error| error.to_string())?;
    instance.entries = Some(entries);
    Ok(())
}

fn rebuild_index(instance: &mut VaultInstance) -> Result<(), String> {
    let Some(vault) = instance.vault.as_ref() else {
        instance.index = None;
        return Ok(());
    };

    let files = vault
        .discover_markdown_files()
        .map_err(|error| error.to_string())?;
    let notes = vault
        .parse_discovered_files(&files, |_| {})
        .map_err(|error| error.to_string())?;
    let mut index = VaultIndex::build(notes);

    let pdf_files = vault
        .discover_pdf_files()
        .map_err(|error| error.to_string())?;
    for pdf_file in pdf_files {
        match vault_ai_vault::pdf::extract_pdf_text(&vault.root, &pdf_file.path, &pdf_file.id) {
            Ok(doc) => {
                index.register_pdf(
                    &doc,
                    pdf_file.modified_at,
                    pdf_file.created_at,
                    pdf_file.size,
                );
            }
            Err(error) => {
                eprintln!("[pdf] Failed to extract {}: {error}", pdf_file.id);
            }
        }
    }

    instance.index = Some(index);
    Ok(())
}

// --- File watcher ---

fn start_index_watcher(
    app: AppHandle,
    vault_path: String,
    root: PathBuf,
    write_tracker: WriteTracker,
) -> Result<RecommendedWatcher, String> {
    start_watcher(root, write_tracker, move |event| {
        handle_external_vault_event(&app, &vault_path, event);
    })
    .map_err(|error| error.to_string())
}

fn handle_external_vault_event(app: &AppHandle, vault_path: &str, event: VaultEvent) {
    let event_label = match &event {
        VaultEvent::FileCreated(p) | VaultEvent::FileModified(p) => {
            format!(
                "watcher.upsert({})",
                p.file_name().unwrap_or_default().to_string_lossy()
            )
        }
        VaultEvent::FileDeleted(p) => {
            format!(
                "watcher.delete({})",
                p.file_name().unwrap_or_default().to_string_lossy()
            )
        }
        VaultEvent::FileRenamed { from, to } => {
            format!(
                "watcher.rename({} → {})",
                from.file_name().unwrap_or_default().to_string_lossy(),
                to.file_name().unwrap_or_default().to_string_lossy()
            )
        }
    };

    let watcher_start = Instant::now();
    let change = {
        let state = app.state::<Mutex<AppState>>();
        let lock_start = Instant::now();
        let mut guard = match lock!(state) {
            Ok(g) => g,
            Err(_) => return,
        };
        let lock_wait = lock_start.elapsed();
        let Some(instance) = guard.vaults.get_mut(vault_path) else {
            return;
        };
        let Some(vault) = instance.vault.as_ref() else {
            return;
        };
        let Some(index) = instance.index.as_mut() else {
            return;
        };
        dbg_log!("{event_label} mutex wait: {lock_wait:.2?}");

        let change = match event {
            VaultEvent::FileCreated(ref path) | VaultEvent::FileModified(ref path)
                if path_has_extension(path, "pdf") =>
            {
                let pdf_id = vault.path_to_entry_id(path);
                match vault_ai_vault::pdf::extract_pdf_text(&vault.root, path, &pdf_id) {
                    Ok(doc) => {
                        let meta = std::fs::metadata(path).ok();
                        let modified_at = meta
                            .as_ref()
                            .and_then(|m| m.modified().ok())
                            .map(|t| {
                                t.duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            })
                            .unwrap_or(0);
                        let created_at = meta
                            .as_ref()
                            .and_then(|m| m.created().ok())
                            .map(|t| {
                                t.duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            })
                            .unwrap_or(modified_at);
                        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                        index.reindex_pdf(&doc, modified_at, created_at, size);
                    }
                    Err(e) => {
                        eprintln!("[pdf-watcher] Failed to extract {}: {e}", path.display());
                    }
                }
                // Emit a vault entry change so the frontend can refresh its entries list
                Some(VaultNoteChangeDto {
                    vault_path: vault_path.to_string(),
                    kind: "upsert".to_string(),
                    note: None,
                    note_id: None,
                })
            }
            VaultEvent::FileDeleted(ref path) if path_has_extension(path, "pdf") => {
                let pdf_id = vault.path_to_entry_id(path);
                index.remove_pdf(&NoteId(pdf_id));
                Some(VaultNoteChangeDto {
                    vault_path: vault_path.to_string(),
                    kind: "delete".to_string(),
                    note: None,
                    note_id: None,
                })
            }
            VaultEvent::FileRenamed { ref from, ref to }
                if path_has_extension(from, "pdf") || path_has_extension(to, "pdf") =>
            {
                let old_id = vault.path_to_entry_id(from);
                index.remove_pdf(&NoteId(old_id));
                if path_has_extension(to, "pdf") {
                    let new_id = vault.path_to_entry_id(to);
                    if let Ok(doc) = vault_ai_vault::pdf::extract_pdf_text(&vault.root, to, &new_id)
                    {
                        let meta = std::fs::metadata(to).ok();
                        let modified_at = meta
                            .as_ref()
                            .and_then(|m| m.modified().ok())
                            .map(|t| {
                                t.duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            })
                            .unwrap_or(0);
                        let created_at = meta
                            .as_ref()
                            .and_then(|m| m.created().ok())
                            .map(|t| {
                                t.duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            })
                            .unwrap_or(modified_at);
                        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                        index.register_pdf(&doc, modified_at, created_at, size);
                    }
                }
                Some(VaultNoteChangeDto {
                    vault_path: vault_path.to_string(),
                    kind: "upsert".to_string(),
                    note: None,
                    note_id: None,
                })
            }
            VaultEvent::FileCreated(path) | VaultEvent::FileModified(path)
                if path_has_extension(&path, "md") =>
            {
                match vault.read_note_from_path(&path) {
                    Ok(note) => {
                        let dto = note_document_to_dto(&note);
                        let note_id = note.id.0.clone();
                        index.reindex_note(note);
                        Some(VaultNoteChangeDto {
                            vault_path: vault_path.to_string(),
                            kind: "upsert".to_string(),
                            note: Some(dto),
                            note_id: Some(note_id),
                        })
                    }
                    Err(_) => {
                        let note_id = vault.path_to_id(&path);
                        index.remove_note(&NoteId(note_id.clone()));
                        Some(VaultNoteChangeDto {
                            vault_path: vault_path.to_string(),
                            kind: "delete".to_string(),
                            note: None,
                            note_id: Some(note_id),
                        })
                    }
                }
            }
            VaultEvent::FileDeleted(path) if path_has_extension(&path, "md") => {
                let note_id = vault.path_to_id(&path);
                index.remove_note(&NoteId(note_id.clone()));
                Some(VaultNoteChangeDto {
                    vault_path: vault_path.to_string(),
                    kind: "delete".to_string(),
                    note: None,
                    note_id: Some(note_id),
                })
            }
            VaultEvent::FileRenamed { from, to }
                if path_has_extension(&from, "md") || path_has_extension(&to, "md") =>
            {
                let old_id = vault.path_to_id(&from);
                index.remove_note(&NoteId(old_id.clone()));
                match vault.read_note_from_path(&to) {
                    Ok(note) => {
                        let dto = note_document_to_dto(&note);
                        let note_id = note.id.0.clone();
                        index.reindex_note(note);
                        Some(VaultNoteChangeDto {
                            vault_path: vault_path.to_string(),
                            kind: "upsert".to_string(),
                            note: Some(dto),
                            note_id: Some(note_id),
                        })
                    }
                    Err(_) => Some(VaultNoteChangeDto {
                        vault_path: vault_path.to_string(),
                        kind: "delete".to_string(),
                        note: None,
                        note_id: Some(old_id),
                    }),
                }
            }
            VaultEvent::FileCreated(_)
            | VaultEvent::FileModified(_)
            | VaultEvent::FileDeleted(_)
            | VaultEvent::FileRenamed { .. } => Some(VaultNoteChangeDto {
                vault_path: vault_path.to_string(),
                kind: "upsert".to_string(),
                note: None,
                note_id: None,
            }),
        };

        if change.is_some() {
            let _ = refresh_entries_cache(instance);
        }

        change
    };

    dbg_log!("{event_label} total: {:.2?}", watcher_start.elapsed());

    if let Some(change) = change {
        let _ = app.emit(VAULT_NOTE_CHANGED_EVENT, change);
    }
}

// --- Open vault job ---

fn run_open_vault_job(
    app: &AppHandle,
    job_id: u64,
    path: String,
    cancel: Arc<AtomicBool>,
) -> Result<OpenVaultResult, String> {
    let vault_path = path.as_str();
    let vault = Vault::open(PathBuf::from(&path)).map_err(|error| error.to_string())?;
    let mut metrics = VaultOpenMetrics::default();

    let scan_started = Instant::now();
    let files = vault
        .discover_markdown_files()
        .map_err(|error| error.to_string())?;
    let entries = vault
        .discover_vault_entries()
        .map_err(|error| error.to_string())?;
    metrics.scan_ms = scan_started.elapsed().as_millis() as u64;
    update_open_state_for_job(app, vault_path, job_id, |open_state| {
        open_state.metrics.scan_ms = metrics.scan_ms;
        open_state.update_stage("scanning", "Scanning files...", files.len(), files.len());
    })?;

    ensure_not_cancelled(&cancel, app, vault_path, job_id)?;

    let fingerprint = VaultFingerprint::from_state(&files, &entries);

    let snapshot_load_started = Instant::now();
    let snapshot = load_snapshot(app, &vault.root);
    metrics.snapshot_load_ms = snapshot_load_started.elapsed().as_millis() as u64;
    update_open_state_for_job(app, vault_path, job_id, |open_state| {
        open_state.metrics.snapshot_load_ms = metrics.snapshot_load_ms;
        open_state.update_stage("indexing", "Loading snapshot...", 0, files.len());
    })?;

    ensure_not_cancelled(&cancel, app, vault_path, job_id)?;

    let root_path = vault.root.to_string_lossy().to_string();

    let (mut index, snapshot_entries, snapshot_used) = match snapshot {
        Some(loaded)
            if loaded.metadata.version == SNAPSHOT_SCHEMA_VERSION
                && loaded.metadata.root_path == root_path
                && loaded.metadata.fingerprint == fingerprint =>
        {
            (loaded.payload.index, loaded.payload.entries, true)
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

            update_open_state_for_job(app, vault_path, job_id, |open_state| {
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
                    let _ = update_open_state_for_job(app, vault_path, job_id, |open_state| {
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

            ensure_not_cancelled(&cancel, app, vault_path, job_id)?;

            update_open_state_for_job(app, vault_path, job_id, |open_state| {
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
                let _ = update_open_state_for_job(app, vault_path, job_id, |open_state| {
                    open_state.update_stage(
                        "indexing",
                        "Refreshing index...",
                        processed,
                        total_ops,
                    );
                });
            }

            for note in changed_notes {
                ensure_not_cancelled(&cancel, app, vault_path, job_id)?;
                next_index.reindex_note(note);
                processed += 1;
                let _ = update_open_state_for_job(app, vault_path, job_id, |open_state| {
                    open_state.update_stage(
                        "indexing",
                        "Refreshing index...",
                        processed,
                        total_ops,
                    );
                });
            }

            metrics.index_ms = index_started.elapsed().as_millis() as u64;
            (next_index, entries.clone(), true)
        }
        _ => {
            update_open_state_for_job(app, vault_path, job_id, |open_state| {
                open_state.update_stage("parsing", "Parsing notes...", 0, files.len());
            })?;

            let parse_started = Instant::now();
            let notes = vault
                .parse_discovered_files(&files, |processed| {
                    let _ = update_open_state_for_job(app, vault_path, job_id, |open_state| {
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

            ensure_not_cancelled(&cancel, app, vault_path, job_id)?;

            let index_started = Instant::now();
            let index = VaultIndex::build_with_progress(notes, |progress| {
                let message = match progress.phase {
                    IndexBuildPhase::RegisteringNotes => "Registering notes...",
                    IndexBuildPhase::ResolvingLinks => "Resolving links...",
                };

                let _ = update_open_state_for_job(app, vault_path, job_id, |open_state| {
                    open_state.metrics.parse_ms = metrics.parse_ms;
                    open_state.update_stage("indexing", message, progress.current, progress.total);
                });
            });
            metrics.index_ms = index_started.elapsed().as_millis() as u64;
            (index, entries.clone(), false)
        }
    };

    // PDF extraction — discover PDFs and extract only those missing from the index
    let pdf_files = vault.discover_pdf_files().unwrap_or_default();
    if !pdf_files.is_empty() {
        let missing_pdfs: Vec<_> = pdf_files
            .iter()
            .filter(|f| {
                let id = vault_ai_types::NoteId(f.id.clone());
                match index.pdf_metadata.get(&id) {
                    Some(existing) => {
                        existing.modified_at != f.modified_at || existing.size != f.size
                    }
                    None => true,
                }
            })
            .collect();

        if !missing_pdfs.is_empty() {
            update_open_state_for_job(app, vault_path, job_id, |open_state| {
                open_state.update_stage(
                    "extracting_pdfs",
                    "Extracting PDFs...",
                    0,
                    missing_pdfs.len(),
                );
            })?;

            let mut pdf_failures = 0usize;
            for (i, pdf_file) in missing_pdfs.iter().enumerate() {
                ensure_not_cancelled(&cancel, app, vault_path, job_id)?;
                match vault_ai_vault::pdf::extract_pdf_text(
                    &vault.root,
                    &pdf_file.path,
                    &pdf_file.id,
                ) {
                    Ok(doc) => {
                        index.register_pdf(
                            &doc,
                            pdf_file.modified_at,
                            pdf_file.created_at,
                            pdf_file.size,
                        );
                    }
                    Err(e) => {
                        pdf_failures += 1;
                        eprintln!("[pdf] Failed to extract {}: {e}", pdf_file.id);
                    }
                }
                let msg = if pdf_failures > 0 {
                    format!("Extracting PDFs... ({} failed)", pdf_failures)
                } else {
                    "Extracting PDFs...".to_string()
                };
                let _ = update_open_state_for_job(app, vault_path, job_id, |open_state| {
                    open_state.update_stage("extracting_pdfs", &msg, i + 1, missing_pdfs.len());
                });
            }
        }

        // Remove PDFs that no longer exist on disk
        let current_pdf_ids: std::collections::HashSet<String> =
            pdf_files.iter().map(|f| f.id.clone()).collect();
        let stale_pdf_ids: Vec<vault_ai_types::NoteId> = index
            .pdf_metadata
            .keys()
            .filter(|id| !current_pdf_ids.contains(&id.0))
            .cloned()
            .collect();
        for id in stale_pdf_ids {
            index.remove_pdf(&id);
        }
    } else {
        // No PDFs on disk — clear any stale entries from snapshot
        index.pdf_metadata.clear();
        index.pdf_search_index.clear();
    }

    update_open_state_for_job(app, vault_path, job_id, |open_state| {
        open_state.metrics.index_ms = metrics.index_ms;
        open_state.update_stage(
            "saving_snapshot",
            "Saving snapshot...",
            index.metadata.len(),
            index.metadata.len(),
        );
    })?;

    let snapshot_save_started = Instant::now();
    let _ = save_snapshot(
        app,
        &vault.root,
        &files,
        &snapshot_entries,
        &index,
        &fingerprint,
    );
    metrics.snapshot_save_ms = snapshot_save_started.elapsed().as_millis() as u64;

    Ok(OpenVaultResult {
        vault,
        index,
        entries: snapshot_entries,
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
    let (write_tracker, job_id) = {
        let mut state = lock!(state)?;

        state.next_job_id = state.next_job_id.wrapping_add(1);
        let job_id = state.next_job_id;
        let write_tracker = state.write_tracker.clone();

        let instance = state
            .vaults
            .entry(path.clone())
            .or_insert_with(VaultInstance::new);

        // Cancel any previous open for THIS vault only
        if let Some(previous_cancel) = instance.open_cancel.take() {
            previous_cancel.store(true, Ordering::Relaxed);
        }

        instance.open_job_id = job_id;
        instance.open_cancel = Some(cancel.clone());
        instance.open_state = VaultOpenState::starting(path.clone());
        instance.vault = None;
        instance.index = None;
        instance.entries = None;
        instance.watcher = None;

        (write_tracker, job_id)
    };

    let vault_path = path.clone();
    std::thread::spawn(
        move || match run_open_vault_job(&app, job_id, path, cancel.clone()) {
            Ok(result) => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = finish_cancelled_for_job(&app, &vault_path, job_id);
                    return;
                }

                let watcher = match start_index_watcher(
                    app.clone(),
                    vault_path.clone(),
                    result.vault.root.clone(),
                    write_tracker,
                ) {
                    Ok(watcher) => watcher,
                    Err(error) => {
                        let _ =
                            update_open_state_for_job(&app, &vault_path, job_id, |open_state| {
                                open_state.finish_error(error.clone(), result.metrics.clone());
                            });
                        return;
                    }
                };

                let state = app.state::<Mutex<AppState>>();
                let _ = lock!(state).map(|mut guard| {
                    let Some(instance) = guard.vaults.get_mut(&vault_path) else {
                        return;
                    };
                    if instance.open_job_id != job_id {
                        return;
                    }

                    let note_count = result.index.metadata.len();
                    instance.vault = Some(result.vault);
                    instance.index = Some(result.index);
                    instance.entries = Some(result.entries);
                    instance.watcher = Some(watcher);
                    instance.open_cancel = None;
                    instance.open_state.finish_ready(
                        note_count,
                        result.snapshot_used,
                        result.metrics,
                    );
                });
            }
            Err(error) if error == "cancelled" => {
                let _ = finish_cancelled_for_job(&app, &vault_path, job_id);
            }
            Err(error) => {
                let _ = update_open_state_for_job(&app, &vault_path, job_id, |open_state| {
                    let metrics = open_state.metrics.clone();
                    open_state.finish_error(error.clone(), metrics);
                });
            }
        },
    );

    Ok(job_id)
}

fn wait_for_job_completion(app: &AppHandle, vault_path: &str, job_id: u64) -> Result<(), String> {
    loop {
        let state = app.state::<Mutex<AppState>>();
        let current = lock!(state)?;

        let Some(instance) = current.vaults.get(vault_path) else {
            return Err("Vault instance not found".to_string());
        };

        if instance.open_job_id != job_id {
            return Err("Open vault job was replaced".to_string());
        }

        match instance.open_state.stage.as_str() {
            "ready" => return Ok(()),
            "error" => {
                return Err(instance
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

// --- Tauri commands ---

#[tauri::command]
fn open_vault(
    path: String,
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<NoteDto>, String> {
    let job_id = start_open_vault_inner(path.clone(), app.clone(), &state)?;
    wait_for_job_completion(&app, &path, job_id)?;
    list_notes(path, state)
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
fn get_vault_open_state(
    vault_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<VaultOpenStateDto, String> {
    let state = lock!(state)?;
    let instance = state.vaults.get(&vault_path).ok_or("Vault not found")?;
    Ok(instance.open_state.to_dto())
}

#[tauri::command]
fn cancel_open_vault(
    vault_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    let Some(instance) = state.vaults.get_mut(&vault_path) else {
        return Ok(());
    };
    if let Some(cancel) = instance.open_cancel.as_ref() {
        cancel.store(true, Ordering::Relaxed);
        instance.open_state.finish_cancelled();
    }
    Ok(())
}

#[tauri::command]
fn list_notes(
    vault_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<NoteDto>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;

    let mut notes: Vec<NoteDto> = index.metadata.values().map(note_to_dto).collect();
    notes.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(notes)
}

#[tauri::command]
fn list_vault_entries(
    vault_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<VaultEntryDto>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    if let Some(entries) = instance.entries.as_ref() {
        return Ok(entries.clone());
    }

    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    vault.discover_vault_entries().map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct VaultFileDetail {
    path: String,
    relative_path: String,
    file_name: String,
    mime_type: Option<String>,
    content: String,
}

fn build_vault_file_detail(
    vault: &Vault,
    relative_path: String,
    content: String,
) -> Result<VaultFileDetail, String> {
    let path = vault
        .resolve_relative_path(&relative_path)
        .map_err(|e| e.to_string())?;
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| relative_path.clone());

    let mime_type = vault
        .discover_vault_entries()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|entry| entry.relative_path == relative_path)
        .and_then(|entry| entry.mime_type);

    Ok(VaultFileDetail {
        path: path.to_string_lossy().to_string(),
        relative_path,
        file_name,
        mime_type,
        content,
    })
}

#[tauri::command]
fn read_vault_file(
    vault_path: String,
    relative_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<VaultFileDetail, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    let content = vault
        .read_text_file(&relative_path)
        .map_err(|e| e.to_string())?;
    build_vault_file_detail(vault, relative_path, content)
}

#[tauri::command]
fn save_vault_file(
    vault_path: String,
    relative_path: String,
    content: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<VaultFileDetail, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let abs_path = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        vault
            .resolve_relative_path(&relative_path)
            .map_err(|e| e.to_string())?
    };

    write_tracker.track_content(abs_path, &content);
    {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        vault
            .save_text_file(&relative_path, &content)
            .map_err(|e| e.to_string())?;
    }
    refresh_entries_cache(instance)?;

    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    build_vault_file_detail(vault, relative_path, content)
}

#[tauri::command]
fn read_note(
    vault_path: String,
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let cmd_start = Instant::now();
    let lock_start = Instant::now();
    let state = lock!(state)?;
    let lock_wait = lock_start.elapsed();
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    let note = vault.read_note(&note_id).map_err(|e| e.to_string())?;

    dbg_log!(
        "read_note({note_id}) mutex wait: {lock_wait:.2?}, total: {:.2?}",
        cmd_start.elapsed()
    );
    Ok(note_to_detail(&note))
}

#[tauri::command]
fn save_note(
    vault_path: String,
    note_id: String,
    content: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let cmd_start = Instant::now();
    let lock_start = Instant::now();
    let state = lock!(state)?;
    let lock_wait = lock_start.elapsed();
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let path = vault.id_to_path(&note_id);

    vault
        .save_note(&note_id, &content)
        .map_err(|e| e.to_string())?;

    // Build NoteDocument from content we already have — skip re-reading from disk
    let note = vault_ai_vault::parser::parse_note(&note_id, &path, &content);
    let dto = note_to_detail(&note);
    // Reindex deferred to the file watcher's background thread to avoid
    // holding the Mutex during the expensive O(n) index update.

    dbg_log!(
        "save_note({note_id}) mutex wait: {lock_wait:.2?}, total: {:.2?}",
        cmd_start.elapsed()
    );
    Ok(dto)
}

#[tauri::command]
fn create_note(
    vault_path: String,
    path: String,
    content: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let abs_path = vault.root.join(&path);
    write_tracker.track_content(abs_path, &content);

    let note = vault
        .create_note(&path, &content)
        .map_err(|e| e.to_string())?;

    let dto = note_to_detail(&note);

    if let Some(index) = instance.index.as_mut() {
        index.reindex_note(note);
    }
    refresh_entries_cache(instance)?;

    Ok(dto)
}

#[tauri::command]
fn create_folder(
    vault_path: String,
    path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<VaultEntryDto, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let abs_path = vault.root.join(&path);
    write_tracker.track_any(abs_path);

    let entry = vault.create_folder(&path).map_err(|e| e.to_string())?;
    refresh_entries_cache(instance)?;

    Ok(entry)
}

#[tauri::command]
fn delete_note(
    vault_path: String,
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let path = vault.id_to_path(&note_id);
    write_tracker.track_any(path);

    vault.delete_note(&note_id).map_err(|e| e.to_string())?;

    if let Some(index) = instance.index.as_mut() {
        index.remove_note(&NoteId(note_id));
    }
    refresh_entries_cache(instance)?;

    Ok(())
}

#[tauri::command]
fn delete_folder(
    vault_path: String,
    relative_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    vault
        .delete_folder(&relative_path)
        .map_err(|e| e.to_string())?;

    rebuild_index(instance)?;
    refresh_entries_cache(instance)?;

    Ok(())
}

#[tauri::command]
fn move_folder(
    vault_path: String,
    relative_path: String,
    new_relative_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let old_path = vault.root.join(&relative_path);
    let new_path = vault.root.join(&new_relative_path);
    write_tracker.track_any(old_path);
    write_tracker.track_any(new_path);

    vault
        .move_folder(&relative_path, &new_relative_path)
        .map_err(|e| e.to_string())?;

    rebuild_index(instance)?;
    refresh_entries_cache(instance)?;
    Ok(())
}

#[tauri::command]
fn copy_folder(
    vault_path: String,
    relative_path: String,
    new_relative_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<VaultEntryDto, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let new_path = vault.root.join(&new_relative_path);
    write_tracker.track_any(new_path);

    let entry = vault
        .copy_folder(&relative_path, &new_relative_path)
        .map_err(|e| e.to_string())?;

    rebuild_index(instance)?;
    refresh_entries_cache(instance)?;
    Ok(entry)
}

#[tauri::command]
fn rename_note(
    vault_path: String,
    note_id: String,
    new_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let old_path = vault.id_to_path(&note_id);
    let new_abs_path = vault.root.join(&new_path);
    write_tracker.track_any(old_path);
    write_tracker.track_any(new_abs_path);

    let note = vault
        .rename_note(&note_id, &new_path)
        .map_err(|e| e.to_string())?;

    let dto = note_to_detail(&note);

    if let Some(index) = instance.index.as_mut() {
        index.remove_note(&NoteId(note_id));
        index.reindex_note(note);
    }
    refresh_entries_cache(instance)?;

    Ok(dto)
}

#[tauri::command]
fn move_vault_entry(
    vault_path: String,
    relative_path: String,
    new_relative_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<VaultEntryDto, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let old_path = vault.resolve_relative_path(&relative_path);
    let new_path = vault.resolve_relative_path(&new_relative_path);
    if let Ok(path) = old_path {
        write_tracker.track_any(path);
    }
    if let Ok(path) = new_path {
        write_tracker.track_any(path);
    }

    let entry = vault
        .move_vault_entry(&relative_path, &new_relative_path)
        .map_err(|e| e.to_string())?;

    refresh_entries_cache(instance)?;
    Ok(entry)
}

#[tauri::command]
fn move_vault_entry_to_trash(
    vault_path: String,
    relative_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let source_path = resolve_vault_scoped_path(&vault.root, &relative_path)?;
    if !source_path.exists() {
        return Err("Archivo no encontrado".to_string());
    }
    if !source_path.is_file() {
        return Err("Solo se pueden mover archivos a trash".to_string());
    }
    if source_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("md"))
    {
        return Err("Las notas deben eliminarse con Delete Note".to_string());
    }

    let trash_target = build_unique_trash_target_path(&vault.root, &source_path)?;
    if let Some(parent) = trash_target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    write_tracker.track_any(source_path.clone());
    write_tracker.track_any(trash_target.clone());
    fs::rename(&source_path, &trash_target).map_err(|error| error.to_string())?;

    refresh_entries_cache(instance)?;
    Ok(())
}

#[tauri::command]
fn ai_get_text_file_hash(
    vault_path: String,
    path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Option<String>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    let resolved_path = resolve_vault_scoped_path(&vault.root, &path)?;

    match fs::read(&resolved_path) {
        Ok(bytes) => Ok(Some(fnv1a_hash_hex(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn ai_restore_text_file(
    vault_path: String,
    path: String,
    previous_path: Option<String>,
    content: Option<String>,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let (write_tracker, current_path, restore_path) = {
        let state = lock!(state)?;
        let instance = state
            .vaults
            .get(&vault_path)
            .ok_or("No hay vault abierto")?;
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        let current_path = resolve_vault_scoped_path(&vault.root, &path)?;
        let restore_path = previous_path
            .as_deref()
            .map(|value| resolve_vault_scoped_path(&vault.root, value))
            .transpose()?;

        (state.write_tracker.clone(), current_path, restore_path)
    };

    if let Some(target_path) = restore_path.as_ref() {
        write_tracker.track_any(target_path.clone());
    }
    write_tracker.track_any(current_path.clone());

    if let Some(text) = content.as_ref() {
        let final_path = restore_path.as_ref().unwrap_or(&current_path);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        write_tracker.track_content(final_path.clone(), text);
        fs::write(final_path, text).map_err(|error| error.to_string())?;

        if final_path != &current_path && current_path.exists() {
            fs::remove_file(&current_path).map_err(|error| error.to_string())?;
        }
        let mut state = lock!(state)?;
        let instance = state
            .vaults
            .get_mut(&vault_path)
            .ok_or("No hay vault abierto")?;
        refresh_entries_cache(instance)?;
        return Ok(());
    }

    if current_path.exists() {
        fs::remove_file(&current_path).map_err(|error| error.to_string())?;
    }

    if let Some(target_path) = restore_path {
        if target_path.exists() {
            fs::remove_file(target_path).map_err(|error| error.to_string())?;
        }
    }

    let mut state = lock!(state)?;
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    refresh_entries_cache(instance)?;

    Ok(())
}

#[tauri::command]
fn search_notes(
    vault_path: String,
    query: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<SearchResultDto>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let query_lower = query.to_lowercase();

    let mut results: Vec<SearchResultDto> = index
        .search(&query)
        .into_iter()
        .map(|r| SearchResultDto {
            id: r.metadata.id.0.clone(),
            path: r.metadata.path.0.to_string_lossy().to_string(),
            title: r.metadata.title.clone(),
            kind: "note".to_string(),
            score: r.score,
        })
        .collect();

    results.extend(
        vault
            .discover_vault_entries()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|entry| entry.kind != "note")
            .filter_map(|entry| {
                let score = compute_entry_search_score(
                    &query_lower,
                    &entry.file_name,
                    &entry.relative_path,
                );
                if score <= 0.0 {
                    return None;
                }
                Some(SearchResultDto {
                    id: entry.id,
                    path: entry.path,
                    title: entry.title,
                    kind: entry.kind,
                    score,
                })
            }),
    );

    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(200);

    Ok(results)
}

#[tauri::command]
fn advanced_search(
    vault_path: String,
    params: AdvancedSearchParams,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<AdvancedSearchResultDto>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    Ok(index.advanced_search(&params, vault))
}

#[derive(serde::Serialize)]
struct TagDto {
    tag: String,
    note_ids: Vec<String>,
}

#[tauri::command]
fn get_tags(
    vault_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<TagDto>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;

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
    vault_path: String,
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<BacklinkDto>, String> {
    let cmd_start = Instant::now();
    let lock_start = Instant::now();
    let state = lock!(state)?;
    let lock_wait = lock_start.elapsed();
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;

    let id = NoteId(note_id.clone());
    let result: Vec<BacklinkDto> = index
        .get_backlinks(&id)
        .into_iter()
        .filter_map(|bl_id| {
            let note = index.metadata.get(bl_id)?;
            Some(BacklinkDto {
                id: note.id.0.clone(),
                title: note.title.clone(),
            })
        })
        .collect();
    dbg_log!(
        "get_backlinks({note_id}) → {} results, mutex wait: {lock_wait:.2?}, total: {:.2?}",
        result.len(),
        cmd_start.elapsed()
    );
    Ok(result)
}

#[tauri::command]
fn resolve_outgoing_links(
    vault_path: String,
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<ResolvedLinkDto>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;

    let note = vault.read_note(&note_id).map_err(|e| e.to_string())?;
    let from_note = NoteId(note_id);

    let mut seen = std::collections::HashSet::new();
    let links: Vec<ResolvedLinkDto> = note
        .links
        .iter()
        .filter(|link| seen.insert(link.target.clone()))
        .map(|link| {
            let resolved = index.resolve_wikilink(&link.target, &from_note);
            let (resolved_id, resolved_title) = match resolved {
                Some(ref id) => (
                    Some(id.0.clone()),
                    index.metadata.get(id).map(|m| m.title.clone()),
                ),
                None => (None, None),
            };
            ResolvedLinkDto {
                target: link.target.clone(),
                note_id: resolved_id,
                title: resolved_title,
            }
        })
        .collect();

    Ok(links)
}

#[tauri::command]
fn resolve_wikilinks_batch(
    vault_path: String,
    note_id: String,
    targets: Vec<String>,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<ResolvedWikilinkDto>, String> {
    let cmd_start = Instant::now();
    let target_count = targets.len();
    let lock_start = Instant::now();
    let state = lock!(state)?;
    let lock_wait = lock_start.elapsed();
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;
    let from_note = NoteId(note_id.clone());

    let mut seen = std::collections::HashSet::new();
    let links: Vec<ResolvedWikilinkDto> = targets
        .into_iter()
        .filter(|target| seen.insert(target.clone()))
        .map(|target| {
            let resolved = index.resolve_wikilink(&target, &from_note);
            let (resolved_note_id, resolved_title) = match resolved {
                Some(ref id) => (
                    Some(id.0.clone()),
                    index.metadata.get(id).map(|m| m.title.clone()),
                ),
                None => (None, None),
            };

            ResolvedWikilinkDto {
                target,
                resolved_note_id,
                resolved_title,
            }
        })
        .collect();

    let resolved_count = links
        .iter()
        .filter(|l| l.resolved_note_id.is_some())
        .count();
    dbg_log!(
        "resolve_wikilinks_batch({note_id}, {target_count} targets) → {resolved_count} resolved, mutex wait: {lock_wait:.2?}, total: {:.2?}",
        cmd_start.elapsed()
    );
    Ok(links)
}

#[tauri::command]
fn suggest_wikilinks(
    vault_path: String,
    note_id: String,
    query: String,
    limit: usize,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<WikilinkSuggestionDto>, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;

    Ok(index
        .suggest_wikilinks(&query, &NoteId(note_id), limit.max(1))
        .into_iter()
        .filter_map(|note_id| {
            let metadata = index.metadata.get(&note_id)?;
            let insert_text = if metadata.title.trim().is_empty() {
                metadata
                    .id
                    .0
                    .split('/')
                    .next_back()
                    .unwrap_or(&metadata.id.0)
                    .trim_end_matches(".md")
                    .to_string()
            } else {
                metadata.title.trim().to_string()
            };

            Some(WikilinkSuggestionDto {
                id: metadata.id.0.clone(),
                title: insert_text.clone(),
                subtitle: metadata.id.0.clone(),
                insert_text,
            })
        })
        .collect())
}

#[tauri::command]
fn get_note_outline(content: String) -> Result<Vec<OutlineHeadingDto>, String> {
    let headings = vault_ai_vault::parser::headings::extract_headings(&content);
    Ok(headings
        .into_iter()
        .map(|h| OutlineHeadingDto {
            id: h.id,
            title: h.title,
            level: h.level,
            anchor: h.anchor,
            head: h.head,
        })
        .collect())
}

#[tauri::command]
fn debug_set_timing(enabled: bool) -> String {
    DEBUG_TIMING.store(enabled, Ordering::Relaxed);
    let status = if enabled { "ON" } else { "OFF" };
    eprintln!("[perf] Debug timing {status}");
    format!("Debug timing {status}")
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
            vaults: HashMap::new(),
            write_tracker: WriteTracker::new(),
            next_job_id: 0,
        }))
        .manage(Mutex::new(ai::AiManager::new()))
        .manage(ai::whisper::WhisperDownloadCancel::new())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            start_open_vault,
            get_vault_open_state,
            cancel_open_vault,
            list_notes,
            list_vault_entries,
            read_vault_file,
            save_vault_file,
            read_note,
            save_note,
            create_note,
            create_folder,
            delete_folder,
            delete_note,
            move_folder,
            copy_folder,
            rename_note,
            move_vault_entry,
            move_vault_entry_to_trash,
            ai_get_text_file_hash,
            ai_restore_text_file,
            search_notes,
            advanced_search,
            get_backlinks,
            get_tags,
            resolve_outgoing_links,
            resolve_wikilinks_batch,
            suggest_wikilinks,
            get_note_outline,
            debug_set_timing,
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
            ai::commands::ai_respond_user_input,
            ai::commands::ai_save_session_history,
            ai::commands::ai_load_session_histories,
            ai::commands::ai_delete_session_history,
            ai::commands::ai_delete_all_session_histories,
            ai::commands::ai_prune_session_histories,
            ai::whisper::whisper_list_models,
            ai::whisper::whisper_get_status,
            ai::whisper::whisper_download_model,
            ai::whisper::whisper_delete_model,
            ai::whisper::whisper_set_selected_model,
            ai::whisper::whisper_set_enabled,
            ai::whisper::whisper_check_audio_file,
            ai::whisper::whisper_transcribe,
            ai::whisper::whisper_cancel_download,
            delete_vault_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_obsolete_snapshot_removes_older_versions() {
        let dir = std::env::temp_dir().join(format!(
            "vault-ai-snapshot-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("snapshot.json"), b"{}").unwrap();

        cleanup_obsolete_snapshot(&dir, SNAPSHOT_SCHEMA_VERSION - 1);

        assert!(!dir.exists());
    }

    #[test]
    fn cleanup_obsolete_snapshot_keeps_current_version() {
        let dir = std::env::temp_dir().join(format!(
            "vault-ai-snapshot-test-{}-{}-keep",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("snapshot.json"), b"{}").unwrap();

        cleanup_obsolete_snapshot(&dir, SNAPSHOT_SCHEMA_VERSION);

        assert!(dir.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
