mod ai;
mod clipper_api;
mod devtools;
mod maps;
mod spellcheck;

use std::collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque};
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
    NoteDto, NoteId, NoteMetadata, ResolvedWikilinkDto, SearchResultDto, VaultEntryDto,
    VaultNoteChangeDto, VaultOpenMetricsDto, VaultOpenStateDto, WikilinkSuggestionDto,
};
use vault_ai_vault::{start_watcher, DiscoveredNoteFile, Vault, VaultEvent, WriteTracker};

const VAULT_NOTE_CHANGED_EVENT: &str = "vault://note-changed";
const SNAPSHOT_SCHEMA_VERSION: u32 = 2;
const OPEN_STATE_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DEFAULT_GRAPH_MAX_NODES_GLOBAL: usize = 8_000;
const DEFAULT_GRAPH_MAX_LINKS_GLOBAL: usize = 24_000;
const DEFAULT_GRAPH_MAX_NODES_LOCAL: usize = 2_500;
const DEFAULT_GRAPH_MAX_LINKS_LOCAL: usize = 12_000;
const DEFAULT_LOCAL_GRAPH_HUB_NEIGHBOR_LIMIT: usize = 512;
const VAULT_CHANGE_ORIGIN_USER: &str = "user";
const VAULT_CHANGE_ORIGIN_AGENT: &str = "agent";
const VAULT_CHANGE_ORIGIN_EXTERNAL: &str = "external";

// --- Debug timing ---
#[cfg(feature = "debug-logs")]
static DEBUG_TIMING: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "debug-logs")]
macro_rules! dbg_log {
    ($($arg:tt)*) => {
        if DEBUG_TIMING.load(Ordering::Relaxed) {
            eprintln!("[perf] {}", format!($($arg)*));
        }
    };
}

#[cfg(not(feature = "debug-logs"))]
macro_rules! dbg_log {
    ($($arg:tt)*) => {};
}

#[cfg(feature = "debug-logs")]
fn debug_timing_enabled() -> bool {
    DEBUG_TIMING.load(Ordering::Relaxed)
}

#[cfg(not(feature = "debug-logs"))]
fn debug_timing_enabled() -> bool {
    false
}

fn serialized_payload_bytes<T: Serialize>(value: &T) -> Option<usize> {
    if !debug_timing_enabled() {
        return None;
    }

    serde_json::to_vec(value).ok().map(|bytes| bytes.len())
}

fn path_has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
}

fn compute_non_note_search_score(query_lower: &str, entry: &CachedNonNoteSearchEntry) -> f64 {
    let title_score = if entry.file_name_lower.contains(query_lower) {
        compute_substring_score(query_lower, &entry.file_name_lower)
    } else {
        0.0
    };

    let path_score = if entry.relative_path_lower.contains(query_lower) {
        compute_substring_score(query_lower, &entry.relative_path_lower) * 0.8
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
    non_note_search_index: Option<Vec<CachedNonNoteSearchEntry>>,
    graph_base_snapshot: Option<CachedGraphBaseSnapshot>,
    graph_revision: u64,
    index_revision: u64,
    note_revisions: HashMap<String, u64>,
    graph_query_cache: HashMap<String, CachedGraphQueryResult>,
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
            non_note_search_index: None,
            graph_base_snapshot: None,
            graph_revision: 0,
            index_revision: 0,
            note_revisions: HashMap::new(),
            graph_query_cache: HashMap::new(),
            watcher: None,
            open_job_id: 0,
            open_cancel: None,
            open_state: VaultOpenState::idle(),
        }
    }
}

struct AppState {
    vaults: HashMap<String, VaultInstance>,
    window_vault_routes: HashMap<String, WindowVaultRoute>,
    write_tracker: WriteTracker,
    next_job_id: u64,
    next_change_op_id: u64,
}

impl AppState {
    fn new() -> Self {
        Self {
            vaults: HashMap::new(),
            window_vault_routes: HashMap::new(),
            write_tracker: WriteTracker::new(),
            next_job_id: 0,
            next_change_op_id: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowRouteKind {
    Main,
    Note,
    Settings,
    Ghost,
    Unknown,
}

impl WindowRouteKind {
    fn from_window_mode(window_mode: &str) -> Self {
        match window_mode {
            "main" => Self::Main,
            "note" => Self::Note,
            "settings" => Self::Settings,
            "ghost" => Self::Ghost,
            _ => Self::Unknown,
        }
    }

    fn can_receive_web_clipper_clip(self) -> bool {
        matches!(self, Self::Main)
    }
}

#[derive(Debug, Clone)]
struct WindowVaultRoute {
    label: String,
    vault_path: Option<String>,
    window_kind: WindowRouteKind,
    last_seen_ms: u64,
}

#[derive(Debug, Clone)]
struct CachedNonNoteSearchEntry {
    id: String,
    path: String,
    title: String,
    kind: String,
    file_name_lower: String,
    relative_path_lower: String,
}

fn build_non_note_search_index(entries: &[VaultEntryDto]) -> Vec<CachedNonNoteSearchEntry> {
    entries
        .iter()
        .filter(|entry| entry.kind != "note")
        .map(|entry| CachedNonNoteSearchEntry {
            id: entry.id.clone(),
            path: entry.path.clone(),
            title: entry.title.clone(),
            kind: entry.kind.clone(),
            file_name_lower: entry.file_name.to_lowercase(),
            relative_path_lower: entry.relative_path.to_lowercase(),
        })
        .collect()
}

#[derive(Debug, Clone)]
struct CachedGraphBaseNode {
    id: String,
    title: String,
    overview_cluster_id: String,
    overview_cluster_title: String,
    overview_cluster_filter: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedGraphBaseTag {
    id: String,
    title: String,
    note_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedGraphBaseAttachment {
    id: String,
    title: String,
    source_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedGraphBaseSnapshot {
    revision: u64,
    note_nodes: Vec<CachedGraphBaseNode>,
    note_links: Vec<GraphLinkDto>,
    tags: Vec<CachedGraphBaseTag>,
    attachments: Vec<CachedGraphBaseAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GraphNoteFingerprint {
    title: String,
    tags: Vec<String>,
    links: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GraphQueryKind {
    Cheap,
    Expensive,
}

#[derive(Debug, Clone)]
struct CachedGraphQueryResult {
    revision: u64,
    kind: GraphQueryKind,
    note_ids: Vec<String>,
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

fn next_change_op_id(state: &mut AppState, origin: &str) -> String {
    let next = state.next_change_op_id;
    state.next_change_op_id = state.next_change_op_id.saturating_add(1);
    format!("{origin}-{next}")
}

fn advance_note_revision(
    note_revisions: &mut HashMap<String, u64>,
    note_id: &str,
    previous_note_id: Option<&str>,
) -> u64 {
    let previous_revision = previous_note_id
        .filter(|previous| *previous != note_id)
        .and_then(|previous| note_revisions.remove(previous))
        .unwrap_or(0);
    let current_revision = note_revisions.get(note_id).copied().unwrap_or(0);
    let next_revision = previous_revision
        .max(current_revision)
        .saturating_add(1)
        .max(1);
    note_revisions.insert(note_id.to_string(), next_revision);
    next_revision
}

fn note_content_hash(content: &str) -> String {
    fnv1a_hash_hex(content.as_bytes())
}

fn build_vault_note_change(
    vault_path: &str,
    kind: &str,
    note: Option<NoteDto>,
    note_id: Option<String>,
    entry: Option<VaultEntryDto>,
    relative_path: Option<String>,
    origin: &str,
    op_id: Option<String>,
    revision: u64,
    content_hash: Option<String>,
    graph_revision: u64,
) -> VaultNoteChangeDto {
    VaultNoteChangeDto {
        vault_path: vault_path.to_string(),
        kind: kind.to_string(),
        note,
        note_id,
        entry,
        relative_path,
        origin: origin.to_string(),
        op_id,
        revision,
        content_hash,
        graph_revision,
    }
}

fn emit_vault_note_change(app: &AppHandle, _context: &str, change: VaultNoteChangeDto) {
    dbg_log!(
        "{_context} emit change kind={}, note_id={:?}, origin={}, op_id={:?}, revision={}, bytes={:?}",
        change.kind,
        change.note_id,
        change.origin,
        change.op_id,
        change.revision,
        serialized_payload_bytes(&change)
    );
    let _ = app.emit(VAULT_NOTE_CHANGED_EVENT, change);
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

fn window_route_label_rank(label: &str) -> u8 {
    if label == "main" {
        0
    } else {
        1
    }
}

fn prune_stale_window_vault_routes(app: &AppHandle, state: &mut AppState) {
    state
        .window_vault_routes
        .retain(|label, _| app.get_webview_window(label).is_some());
}

fn select_web_clipper_target_window_label(state: &AppState, vault_path: &str) -> Option<String> {
    let mut candidates = state
        .window_vault_routes
        .values()
        .filter(|route| {
            route.window_kind.can_receive_web_clipper_clip()
                && route.vault_path.as_deref() == Some(vault_path)
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        right
            .last_seen_ms
            .cmp(&left.last_seen_ms)
            .then_with(|| {
                window_route_label_rank(&left.label).cmp(&window_route_label_rank(&right.label))
            })
            .then_with(|| left.label.cmp(&right.label))
    });

    candidates.first().map(|route| route.label.clone())
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

fn note_change_from_document(
    vault_path: &str,
    note: &NoteDocument,
    relative_path: String,
    origin: &str,
    op_id: Option<String>,
    revision: u64,
    graph_revision: u64,
) -> VaultNoteChangeDto {
    build_vault_note_change(
        vault_path,
        "upsert",
        Some(note_document_to_dto(note)),
        Some(note.id.0.clone()),
        None,
        Some(relative_path),
        origin,
        op_id,
        revision,
        Some(note_content_hash(&note.raw_markdown)),
        graph_revision,
    )
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
        instance.non_note_search_index = None;
        return Ok(());
    };

    let entries = vault
        .discover_vault_entries()
        .map_err(|error| error.to_string())?;
    let non_note_search_index = build_non_note_search_index(&entries);
    instance.entries = Some(entries);
    instance.non_note_search_index = Some(non_note_search_index);
    Ok(())
}

fn sort_entries_cache(entries: &mut [VaultEntryDto]) {
    entries.sort_by(|left, right| left.id.cmp(&right.id));
}

fn upsert_entry_in_cache(entries: &mut Vec<VaultEntryDto>, entry: VaultEntryDto) {
    if let Some(existing) = entries
        .iter_mut()
        .find(|existing| existing.relative_path == entry.relative_path)
    {
        *existing = entry;
        return;
    }

    entries.push(entry);
}

fn remove_entry_from_cache(entries: &mut Vec<VaultEntryDto>, relative_path: &str) {
    entries.retain(|entry| entry.relative_path != relative_path);
}

fn remove_subtree_from_cache(entries: &mut Vec<VaultEntryDto>, relative_path: &str) {
    let prefix = format!("{relative_path}/");
    entries.retain(|entry| {
        entry.relative_path != relative_path && !entry.relative_path.starts_with(&prefix)
    });
}

fn path_is_hidden_from_entries(vault_root: &Path, path: &Path) -> bool {
    const HIDDEN_DIR_NAMES: &[&str] = &[
        ".obsidian",
        ".git",
        ".vaultai",
        ".vaultai-cache",
        ".trash",
        "target",
        "node_modules",
        "vendor",
        ".cargo-home",
        ".claude",
    ];

    let Ok(relative_path) = path.strip_prefix(vault_root) else {
        return false;
    };

    relative_path.components().any(|component| match component {
        std::path::Component::Normal(name) => {
            let value = name.to_string_lossy();
            HIDDEN_DIR_NAMES.contains(&value.as_ref())
        }
        _ => false,
    })
}

fn relative_path_from_absolute(vault_root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(vault_root)
        .map(|value| value.to_string_lossy().to_string())
        .map_err(|_| "Path fuera del vault".to_string())
}

fn ensure_parent_folders_in_cache(
    entries: &mut Vec<VaultEntryDto>,
    vault: &Vault,
    relative_path: &str,
) -> Result<(), String> {
    let absolute_path = vault
        .resolve_relative_path(relative_path)
        .map_err(|error| error.to_string())?;
    let mut current = absolute_path.parent();

    while let Some(parent) = current {
        if parent == vault.root {
            break;
        }
        if path_is_hidden_from_entries(&vault.root, parent) {
            current = parent.parent();
            continue;
        }

        let parent_relative_path = vault.path_to_relative_path(parent);
        if !entries
            .iter()
            .any(|entry| entry.relative_path == parent_relative_path)
        {
            let parent_entry = vault
                .read_vault_entry_from_path(parent)
                .map_err(|error| error.to_string())?;
            entries.push(parent_entry);
        }

        current = parent.parent();
    }

    Ok(())
}

fn mutate_entries_cache(
    instance: &mut VaultInstance,
    mutate: impl FnOnce(&Vault, &mut Vec<VaultEntryDto>) -> Result<(), String>,
) -> Result<(), String> {
    if instance.vault.is_none() {
        instance.entries = None;
        instance.non_note_search_index = None;
        return Ok(());
    }

    if instance.entries.is_none() {
        refresh_entries_cache(instance)?;
    }

    let non_note_search_index = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        let entries = instance.entries.as_mut().ok_or("No hay vault abierto")?;
        mutate(vault, entries)?;
        sort_entries_cache(entries);
        build_non_note_search_index(entries)
    };
    instance.non_note_search_index = Some(non_note_search_index);
    Ok(())
}

fn next_graph_revision(current: u64) -> u64 {
    current.saturating_add(1).max(1)
}

fn next_index_revision(current: u64) -> u64 {
    current.saturating_add(1).max(1)
}

fn invalidate_graph_cache(instance: &mut VaultInstance) {
    instance.graph_revision = next_graph_revision(instance.graph_revision);
    instance.graph_base_snapshot = None;
}

fn reset_graph_cache(instance: &mut VaultInstance) {
    instance.graph_revision = 1;
    instance.graph_base_snapshot = None;
}

fn invalidate_graph_query_cache(instance: &mut VaultInstance) {
    instance.index_revision = next_index_revision(instance.index_revision);
    instance.graph_query_cache.clear();
}

fn reset_graph_query_cache(instance: &mut VaultInstance) {
    instance.index_revision = 1;
    instance.graph_query_cache.clear();
}

fn graph_note_fingerprint_from_index(
    index: &VaultIndex,
    note_id: &NoteId,
) -> Option<GraphNoteFingerprint> {
    let metadata = index.metadata.get(note_id)?;
    let indexed = index
        .notes
        .get(note_id)
        .cloned()
        .unwrap_or(vault_ai_types::IndexedNote {
            tags: Vec::new(),
            links: Vec::new(),
        });

    let mut tags = indexed.tags;
    tags.sort();

    let mut links = indexed.links;
    links.sort();

    Some(GraphNoteFingerprint {
        title: metadata.title.clone(),
        tags,
        links,
    })
}

fn graph_note_fingerprint_from_document(note: &NoteDocument) -> GraphNoteFingerprint {
    let mut tags = note.tags.clone();
    tags.sort();

    let mut links: Vec<String> = note.links.iter().map(|link| link.target.clone()).collect();
    links.sort();

    GraphNoteFingerprint {
        title: note.title.clone(),
        tags,
        links,
    }
}

fn note_graph_exists(index: &VaultIndex, note_id: &NoteId) -> bool {
    index.metadata.contains_key(note_id)
        || index.notes.contains_key(note_id)
        || index.forward_links.contains_key(note_id)
        || index.backlinks.contains_key(note_id)
        || index.unresolved_links.contains_key(note_id)
}

fn overview_cluster_for_note_id(note_id: &str) -> (String, String, Option<String>) {
    let mut segments = note_id.split('/');
    let first = segments.next().unwrap_or_default();
    if first.is_empty() || !note_id.contains('/') {
        return (
            "cluster:__root__".to_string(),
            "Root Notes".to_string(),
            None,
        );
    }

    let cluster_id = format!("cluster:{first}");
    (cluster_id, first.to_string(), Some(first.to_string()))
}

fn build_cached_graph_base_snapshot(index: &VaultIndex, revision: u64) -> CachedGraphBaseSnapshot {
    let mut note_nodes: Vec<CachedGraphBaseNode> = index
        .metadata
        .values()
        .map(|meta| {
            let (overview_cluster_id, overview_cluster_title, overview_cluster_filter) =
                overview_cluster_for_note_id(&meta.id.0);
            CachedGraphBaseNode {
                id: meta.id.0.clone(),
                title: meta.title.clone(),
                overview_cluster_id,
                overview_cluster_title,
                overview_cluster_filter,
            }
        })
        .collect();
    note_nodes.sort_by(|left, right| left.id.cmp(&right.id));

    let mut note_links: Vec<GraphLinkDto> = index
        .forward_links
        .iter()
        .flat_map(|(source_id, targets)| {
            targets.iter().map(move |target_id| GraphLinkDto {
                source: source_id.0.clone(),
                target: target_id.0.clone(),
            })
        })
        .collect();
    note_links.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then_with(|| left.target.cmp(&right.target))
    });

    let mut tags: Vec<CachedGraphBaseTag> = index
        .tags
        .iter()
        .map(|(tag, note_ids)| {
            let mut ids: Vec<String> = note_ids.iter().map(|id| id.0.clone()).collect();
            ids.sort();
            CachedGraphBaseTag {
                id: format!("tag:{tag}"),
                title: format!("#{tag}"),
                note_ids: ids,
            }
        })
        .collect();
    tags.sort_by(|left, right| left.id.cmp(&right.id));

    let mut attachment_sources = HashMap::<String, CachedGraphBaseAttachment>::new();
    for (note_id, targets) in &index.unresolved_links {
        for target in targets {
            let attachment_id = format!("att:{target}");
            let entry = attachment_sources
                .entry(attachment_id.clone())
                .or_insert_with(|| CachedGraphBaseAttachment {
                    id: attachment_id.clone(),
                    title: target.rsplit('/').next().unwrap_or(target).to_string(),
                    source_ids: Vec::new(),
                });
            entry.source_ids.push(note_id.0.clone());
        }
    }

    let mut attachments: Vec<CachedGraphBaseAttachment> =
        attachment_sources.into_values().collect();
    for attachment in &mut attachments {
        attachment.source_ids.sort();
    }
    attachments.sort_by(|left, right| left.id.cmp(&right.id));

    CachedGraphBaseSnapshot {
        revision,
        note_nodes,
        note_links,
        tags,
        attachments,
    }
}

fn ensure_graph_base_snapshot(
    instance: &mut VaultInstance,
) -> Result<&CachedGraphBaseSnapshot, String> {
    let graph_revision = instance.graph_revision.max(1);
    let needs_rebuild = instance
        .graph_base_snapshot
        .as_ref()
        .is_none_or(|snapshot| snapshot.revision != graph_revision);

    if needs_rebuild {
        let Some(index) = instance.index.as_ref() else {
            return Err("No hay vault abierto".to_string());
        };
        instance.graph_base_snapshot =
            Some(build_cached_graph_base_snapshot(index, graph_revision));
    }

    instance
        .graph_base_snapshot
        .as_ref()
        .ok_or("No hay snapshot de grafo".to_string())
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
    invalidate_graph_query_cache(instance);
    invalidate_graph_cache(instance);
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
    let _event_label = match &event {
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

    let _watcher_start = Instant::now();
    let change = {
        let state = app.state::<Mutex<AppState>>();
        let lock_start = Instant::now();
        let mut guard = match lock!(state) {
            Ok(g) => g,
            Err(_) => return,
        };
        let _lock_wait = lock_start.elapsed();
        let Some(instance) = guard.vaults.get_mut(vault_path) else {
            return;
        };
        let Some(vault) = instance.vault.as_ref() else {
            return;
        };
        let Some(index) = instance.index.as_mut() else {
            return;
        };
        dbg_log!("{_event_label} mutex wait: {_lock_wait:.2?}");

        let mut graph_changed = false;
        let mut search_changed = false;
        let mut change = match event {
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
                        search_changed = true;
                    }
                    Err(e) => {
                        eprintln!("[pdf-watcher] Failed to extract {}: {e}", path.display());
                    }
                }
                // Emit a vault entry change so the frontend can refresh its entries list
                Some(build_vault_note_change(
                    vault_path,
                    "upsert",
                    None,
                    None,
                    None,
                    Some(vault.path_to_relative_path(path)),
                    VAULT_CHANGE_ORIGIN_EXTERNAL,
                    None,
                    0,
                    None,
                    0,
                ))
            }
            VaultEvent::FileDeleted(ref path) if path_has_extension(path, "pdf") => {
                let pdf_id = vault.path_to_entry_id(path);
                index.remove_pdf(&NoteId(pdf_id));
                search_changed = true;
                Some(build_vault_note_change(
                    vault_path,
                    "delete",
                    None,
                    None,
                    None,
                    Some(vault.path_to_relative_path(path)),
                    VAULT_CHANGE_ORIGIN_EXTERNAL,
                    None,
                    0,
                    None,
                    0,
                ))
            }
            VaultEvent::FileRenamed { ref from, ref to }
                if path_has_extension(from, "pdf") || path_has_extension(to, "pdf") =>
            {
                let old_id = vault.path_to_entry_id(from);
                index.remove_pdf(&NoteId(old_id));
                search_changed = true;
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
                        search_changed = true;
                    }
                }
                Some(build_vault_note_change(
                    vault_path,
                    "upsert",
                    None,
                    None,
                    None,
                    Some(vault.path_to_relative_path(to)),
                    VAULT_CHANGE_ORIGIN_EXTERNAL,
                    None,
                    0,
                    None,
                    0,
                ))
            }
            VaultEvent::FileCreated(path) | VaultEvent::FileModified(path)
                if path_has_extension(&path, "md") =>
            {
                let note_id = vault.path_to_id(&path);
                let before = graph_note_fingerprint_from_index(index, &NoteId(note_id.clone()));
                match vault.read_note_from_path(&path) {
                    Ok(note) => {
                        let note_id = note.id.0.clone();
                        let after = graph_note_fingerprint_from_document(&note);
                        let note_for_change = note.clone();
                        index.reindex_note(note);
                        graph_changed = before.as_ref() != Some(&after);
                        search_changed = true;
                        let revision =
                            advance_note_revision(&mut instance.note_revisions, &note_id, None);
                        Some(note_change_from_document(
                            vault_path,
                            &note_for_change,
                            vault.path_to_relative_path(&path),
                            VAULT_CHANGE_ORIGIN_EXTERNAL,
                            None,
                            revision,
                            0,
                        ))
                    }
                    Err(_) => {
                        graph_changed = before.is_some();
                        index.remove_note(&NoteId(note_id.clone()));
                        search_changed = true;
                        let revision =
                            advance_note_revision(&mut instance.note_revisions, &note_id, None);
                        Some(build_vault_note_change(
                            vault_path,
                            "delete",
                            None,
                            Some(note_id),
                            None,
                            Some(vault.path_to_relative_path(&path)),
                            VAULT_CHANGE_ORIGIN_EXTERNAL,
                            None,
                            revision,
                            None,
                            0,
                        ))
                    }
                }
            }
            VaultEvent::FileDeleted(path) if path_has_extension(&path, "md") => {
                let note_id = vault.path_to_id(&path);
                graph_changed = note_graph_exists(index, &NoteId(note_id.clone()));
                index.remove_note(&NoteId(note_id.clone()));
                search_changed = true;
                let revision = advance_note_revision(&mut instance.note_revisions, &note_id, None);
                Some(build_vault_note_change(
                    vault_path,
                    "delete",
                    None,
                    Some(note_id),
                    None,
                    Some(vault.path_to_relative_path(&path)),
                    VAULT_CHANGE_ORIGIN_EXTERNAL,
                    None,
                    revision,
                    None,
                    0,
                ))
            }
            VaultEvent::FileRenamed { from, to }
                if path_has_extension(&from, "md") || path_has_extension(&to, "md") =>
            {
                let old_id = vault.path_to_id(&from);
                graph_changed = note_graph_exists(index, &NoteId(old_id.clone()));
                index.remove_note(&NoteId(old_id.clone()));
                search_changed = true;
                match vault.read_note_from_path(&to) {
                    Ok(note) => {
                        let note_id = note.id.0.clone();
                        let note_for_change = note.clone();
                        index.reindex_note(note);
                        graph_changed = true;
                        search_changed = true;
                        let revision = advance_note_revision(
                            &mut instance.note_revisions,
                            &note_id,
                            Some(&old_id),
                        );
                        Some(note_change_from_document(
                            vault_path,
                            &note_for_change,
                            vault.path_to_relative_path(&to),
                            VAULT_CHANGE_ORIGIN_EXTERNAL,
                            None,
                            revision,
                            0,
                        ))
                    }
                    Err(_) => {
                        let revision =
                            advance_note_revision(&mut instance.note_revisions, &old_id, None);
                        Some(build_vault_note_change(
                            vault_path,
                            "delete",
                            None,
                            Some(old_id),
                            None,
                            Some(vault.path_to_relative_path(&from)),
                            VAULT_CHANGE_ORIGIN_EXTERNAL,
                            None,
                            revision,
                            None,
                            0,
                        ))
                    }
                }
            }
            VaultEvent::FileCreated(path) | VaultEvent::FileModified(path) => {
                let entry = vault.read_vault_entry_from_path(&path).ok();
                Some(build_vault_note_change(
                    vault_path,
                    "upsert",
                    None,
                    None,
                    entry,
                    Some(vault.path_to_relative_path(&path)),
                    VAULT_CHANGE_ORIGIN_EXTERNAL,
                    None,
                    0,
                    None,
                    0,
                ))
            }
            VaultEvent::FileDeleted(path) => Some(build_vault_note_change(
                vault_path,
                "delete",
                None,
                None,
                None,
                Some(vault.path_to_relative_path(&path)),
                VAULT_CHANGE_ORIGIN_EXTERNAL,
                None,
                0,
                None,
                0,
            )),
            VaultEvent::FileRenamed { to, .. } => {
                let entry = vault.read_vault_entry_from_path(&to).ok();
                Some(build_vault_note_change(
                    vault_path,
                    "upsert",
                    None,
                    None,
                    entry,
                    Some(vault.path_to_relative_path(&to)),
                    VAULT_CHANGE_ORIGIN_EXTERNAL,
                    None,
                    0,
                    None,
                    0,
                ))
            }
        };

        if search_changed {
            invalidate_graph_query_cache(instance);
        }
        if graph_changed {
            invalidate_graph_cache(instance);
        }

        if change.is_some() {
            let _ = refresh_entries_cache(instance);
        }

        if let Some(change) = change.as_mut() {
            change.graph_revision = instance.graph_revision.max(1);
        }

        change
    };

    dbg_log!("{_event_label} total: {:.2?}", _watcher_start.elapsed());

    if let Some(change) = change {
        emit_vault_note_change(app, &_event_label, change);
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
        instance.non_note_search_index = None;
        instance.graph_base_snapshot = None;
        instance.graph_revision = 0;
        instance.index_revision = 0;
        instance.graph_query_cache.clear();
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
                    let non_note_search_index = build_non_note_search_index(&result.entries);
                    instance.vault = Some(result.vault);
                    instance.index = Some(result.index);
                    instance.entries = Some(result.entries);
                    instance.non_note_search_index = Some(non_note_search_index);
                    reset_graph_cache(instance);
                    reset_graph_query_cache(instance);
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
fn get_graph_revision(
    vault_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<u64, String> {
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    Ok(instance.graph_revision.max(1))
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
    let (entry, detail) = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        let abs_path = vault
            .resolve_relative_path(&relative_path)
            .map_err(|e| e.to_string())?;
        write_tracker.track_content(abs_path, &content);

        let entry = vault
            .save_text_file(&relative_path, &content)
            .map_err(|e| e.to_string())?;

        let detail = VaultFileDetail {
            path: entry.path.clone(),
            relative_path: entry.relative_path.clone(),
            file_name: entry.file_name.clone(),
            mime_type: entry.mime_type.clone(),
            content,
        };

        (entry, detail)
    };
    mutate_entries_cache(instance, |vault, entries| {
        ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
        upsert_entry_in_cache(entries, entry);
        Ok(())
    })?;

    Ok(detail)
}

#[derive(serde::Serialize)]
struct SavedBinaryFileDetail {
    path: String,
    relative_path: String,
    file_name: String,
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputeLineDiffInput {
    old_text: String,
    new_text: String,
}

#[tauri::command]
fn save_vault_binary_file(
    vault_path: String,
    relative_dir: String,
    file_name: String,
    bytes: Vec<u8>,
    state: tauri::State<Mutex<AppState>>,
) -> Result<SavedBinaryFileDetail, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let (abs_path, entry) = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        vault
            .save_binary_file(&relative_dir, &file_name, &bytes)
            .map_err(|e| e.to_string())?
    };
    let detail = SavedBinaryFileDetail {
        path: entry.path.clone(),
        relative_path: entry.relative_path.clone(),
        file_name: entry.file_name.clone(),
        mime_type: entry.mime_type.clone(),
    };

    write_tracker.track_any(abs_path);
    mutate_entries_cache(instance, |vault, entries| {
        ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
        upsert_entry_in_cache(entries, entry.clone());
        Ok(())
    })?;

    Ok(detail)
}

#[tauri::command]
fn read_note(
    vault_path: String,
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let _cmd_start = Instant::now();
    let lock_start = Instant::now();
    let state = lock!(state)?;
    let _lock_wait = lock_start.elapsed();
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
    let note = vault.read_note(&note_id).map_err(|e| e.to_string())?;

    dbg_log!(
        "read_note({note_id}) mutex wait: {_lock_wait:.2?}, total: {:.2?}",
        _cmd_start.elapsed()
    );
    Ok(note_to_detail(&note))
}

#[tauri::command]
fn save_note(
    vault_path: String,
    note_id: String,
    content: String,
    op_id: Option<String>,
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let _cmd_start = Instant::now();
    let lock_start = Instant::now();
    let mut state = lock!(state)?;
    let _lock_wait = lock_start.elapsed();
    let write_tracker = state.write_tracker.clone();
    let op_id = op_id.unwrap_or_else(|| next_change_op_id(&mut state, VAULT_CHANGE_ORIGIN_USER));
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let path = vault.id_to_path(&note_id);
    write_tracker.track_content(path.clone(), &content);

    vault
        .save_note(&note_id, &content)
        .map_err(|e| e.to_string())?;

    // Build NoteDocument from content we already have — skip re-reading from disk
    let note = vault_ai_vault::parser::parse_note(&note_id, &path, &content);
    let dto = note_to_detail(&note);
    let relative_path = vault.path_to_relative_path(&path);
    let revision = advance_note_revision(&mut instance.note_revisions, &note_id, None);
    let change = note_change_from_document(
        &vault_path,
        &note,
        relative_path,
        VAULT_CHANGE_ORIGIN_USER,
        Some(op_id),
        revision,
        instance.graph_revision.max(1),
    );
    // Reindex deferred to the file watcher's background thread to avoid
    // holding the Mutex during the expensive O(n) index update.

    dbg_log!(
        "save_note({note_id}) mutex wait: {_lock_wait:.2?}, total: {:.2?}",
        _cmd_start.elapsed()
    );
    drop(state);
    emit_vault_note_change(&app, "save_note", change);
    Ok(dto)
}

#[tauri::command]
fn create_note(
    vault_path: String,
    path: String,
    content: String,
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let op_id = next_change_op_id(&mut state, VAULT_CHANGE_ORIGIN_USER);
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let (note, entry) = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        let abs_path = vault.root.join(&path);
        write_tracker.track_content(abs_path, &content);

        let note = vault
            .create_note(&path, &content)
            .map_err(|e| e.to_string())?;
        let entry = vault
            .read_vault_entry_from_path(&note.path.0)
            .map_err(|e| e.to_string())?;

        (note, entry)
    };

    let dto = note_to_detail(&note);
    let revision = advance_note_revision(&mut instance.note_revisions, &note.id.0, None);
    let change = note_change_from_document(
        &vault_path,
        &note,
        entry.relative_path.clone(),
        VAULT_CHANGE_ORIGIN_USER,
        Some(op_id.clone()),
        revision,
        instance.graph_revision.max(1),
    );

    if let Some(index) = instance.index.as_mut() {
        index.reindex_note(note);
    }
    invalidate_graph_query_cache(instance);
    invalidate_graph_cache(instance);
    mutate_entries_cache(instance, |vault, entries| {
        ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
        upsert_entry_in_cache(entries, entry);
        Ok(())
    })?;

    drop(state);
    emit_vault_note_change(&app, "create_note", change);
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
    let entry = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        let abs_path = vault.root.join(&path);
        write_tracker.track_any(abs_path);
        vault.create_folder(&path).map_err(|e| e.to_string())?
    };
    mutate_entries_cache(instance, |vault, entries| {
        ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
        upsert_entry_in_cache(entries, entry.clone());
        Ok(())
    })?;

    Ok(entry)
}

#[tauri::command]
fn delete_note(
    vault_path: String,
    note_id: String,
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let op_id = next_change_op_id(&mut state, VAULT_CHANGE_ORIGIN_USER);
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let removed_relative_path = format!("{note_id}.md");
    {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        let path = vault.id_to_path(&note_id);
        write_tracker.track_any(path);
        vault.delete_note(&note_id).map_err(|e| e.to_string())?;
    }

    if let Some(index) = instance.index.as_mut() {
        index.remove_note(&NoteId(note_id.clone()));
    }
    invalidate_graph_query_cache(instance);
    invalidate_graph_cache(instance);
    mutate_entries_cache(instance, |_, entries| {
        remove_entry_from_cache(entries, &removed_relative_path);
        Ok(())
    })?;

    let revision = advance_note_revision(&mut instance.note_revisions, &note_id, None);
    let change = build_vault_note_change(
        &vault_path,
        "delete",
        None,
        Some(note_id.clone()),
        None,
        Some(removed_relative_path),
        VAULT_CHANGE_ORIGIN_USER,
        Some(op_id),
        revision,
        None,
        instance.graph_revision.max(1),
    );
    drop(state);
    emit_vault_note_change(&app, "delete_note", change);
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
    mutate_entries_cache(instance, |_, entries| {
        remove_subtree_from_cache(entries, &relative_path);
        Ok(())
    })?;

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
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let write_tracker = state.write_tracker.clone();
    let op_id = next_change_op_id(&mut state, VAULT_CHANGE_ORIGIN_USER);
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let removed_relative_path = format!("{note_id}.md");
    let (note, entry) = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        let old_path = vault.id_to_path(&note_id);
        let new_abs_path = vault.root.join(&new_path);
        write_tracker.track_any(old_path);
        write_tracker.track_any(new_abs_path);

        let note = vault
            .rename_note(&note_id, &new_path)
            .map_err(|e| e.to_string())?;
        let entry = vault
            .read_vault_entry_from_path(&note.path.0)
            .map_err(|e| e.to_string())?;

        (note, entry)
    };

    let dto = note_to_detail(&note);
    let revision = advance_note_revision(&mut instance.note_revisions, &note.id.0, Some(&note_id));
    let change = note_change_from_document(
        &vault_path,
        &note,
        entry.relative_path.clone(),
        VAULT_CHANGE_ORIGIN_USER,
        Some(op_id),
        revision,
        instance.graph_revision.max(1),
    );

    if let Some(index) = instance.index.as_mut() {
        index.remove_note(&NoteId(note_id));
        index.reindex_note(note);
    }
    invalidate_graph_query_cache(instance);
    invalidate_graph_cache(instance);
    mutate_entries_cache(instance, |vault, entries| {
        remove_entry_from_cache(entries, &removed_relative_path);
        ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
        upsert_entry_in_cache(entries, entry);
        Ok(())
    })?;

    drop(state);
    emit_vault_note_change(&app, "rename_note", change);
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

    let entry = {
        let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
        vault
            .move_vault_entry(&relative_path, &new_relative_path)
            .map_err(|e| e.to_string())?
    };

    mutate_entries_cache(instance, |vault, entries| {
        remove_entry_from_cache(entries, &relative_path);
        ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
        upsert_entry_in_cache(entries, entry.clone());
        Ok(())
    })?;
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

    mutate_entries_cache(instance, |_, entries| {
        remove_entry_from_cache(entries, &relative_path);
        Ok(())
    })?;
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
    app: AppHandle,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Option<VaultNoteChangeDto>, String> {
    let (write_tracker, current_path, restore_path, op_id) = {
        let mut state = lock!(state)?;
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
        let op_id = next_change_op_id(&mut state, VAULT_CHANGE_ORIGIN_AGENT);

        (
            state.write_tracker.clone(),
            current_path,
            restore_path,
            op_id,
        )
    };

    if let Some(target_path) = restore_path.as_ref() {
        write_tracker.track_any(target_path.clone());
    }
    write_tracker.track_any(current_path.clone());

    let final_path = restore_path.clone().unwrap_or_else(|| current_path.clone());

    if let Some(text) = content.as_ref() {
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        write_tracker.track_content(final_path.clone(), text);
        fs::write(&final_path, text).map_err(|error| error.to_string())?;

        if final_path != current_path && current_path.exists() {
            fs::remove_file(&current_path).map_err(|error| error.to_string())?;
        }

        let mut state = lock!(state)?;
        let instance = state
            .vaults
            .get_mut(&vault_path)
            .ok_or("No hay vault abierto")?;

        let change = if path_has_extension(&final_path, "md") {
            let (note, entry, relative_path, previous_note_id, current_relative_path) = {
                let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
                let note = vault
                    .read_note_from_path(&final_path)
                    .map_err(|error| error.to_string())?;
                let entry = vault
                    .read_vault_entry_from_path(&final_path)
                    .map_err(|error| error.to_string())?;
                let relative_path = entry.relative_path.clone();
                let previous_note_id =
                    if current_path != final_path && path_has_extension(&current_path, "md") {
                        Some(vault.path_to_id(&current_path))
                    } else {
                        None
                    };
                let current_relative_path =
                    relative_path_from_absolute(&vault.root, &current_path)?;
                (
                    note,
                    entry,
                    relative_path,
                    previous_note_id,
                    current_relative_path,
                )
            };

            let revision = advance_note_revision(
                &mut instance.note_revisions,
                &note.id.0,
                previous_note_id.as_deref(),
            );

            if let Some(index) = instance.index.as_mut() {
                if let Some(previous_note_id) = previous_note_id.as_ref() {
                    if previous_note_id != &note.id.0 {
                        index.remove_note(&NoteId(previous_note_id.clone()));
                    }
                }
                index.reindex_note(note.clone());
            }
            invalidate_graph_query_cache(instance);
            invalidate_graph_cache(instance);

            mutate_entries_cache(instance, |vault, entries| {
                remove_entry_from_cache(entries, &current_relative_path);
                remove_entry_from_cache(entries, &relative_path);
                ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
                upsert_entry_in_cache(entries, entry.clone());
                Ok(())
            })?;

            note_change_from_document(
                &vault_path,
                &note,
                relative_path,
                VAULT_CHANGE_ORIGIN_AGENT,
                Some(op_id.clone()),
                revision,
                instance.graph_revision.max(1),
            )
        } else {
            let (entry, relative_path, current_relative_path) = {
                let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
                let relative_path = relative_path_from_absolute(&vault.root, &final_path)?;
                let entry = if !path_is_hidden_from_entries(&vault.root, &final_path)
                    && final_path.exists()
                {
                    Some(
                        vault
                            .read_vault_entry_from_path(&final_path)
                            .map_err(|error| error.to_string())?,
                    )
                } else {
                    None
                };
                let current_relative_path =
                    relative_path_from_absolute(&vault.root, &current_path)?;
                (entry, relative_path, current_relative_path)
            };

            mutate_entries_cache(instance, |vault, entries| {
                remove_entry_from_cache(entries, &current_relative_path);
                remove_entry_from_cache(entries, &relative_path);
                if let Some(entry) = entry.as_ref() {
                    ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
                    upsert_entry_in_cache(entries, entry.clone());
                }
                Ok(())
            })?;

            build_vault_note_change(
                &vault_path,
                "upsert",
                None,
                None,
                entry,
                Some(relative_path),
                VAULT_CHANGE_ORIGIN_AGENT,
                Some(op_id.clone()),
                0,
                Some(note_content_hash(text)),
                instance.graph_revision.max(1),
            )
        };

        drop(state);
        emit_vault_note_change(&app, "ai_restore_text_file", change.clone());
        return Ok(Some(change));
    }

    if current_path.exists() {
        fs::remove_file(&current_path).map_err(|error| error.to_string())?;
    }

    if let Some(target_path) = restore_path.as_ref() {
        if target_path.exists() {
            fs::remove_file(target_path).map_err(|error| error.to_string())?;
        }
    }

    let mut state = lock!(state)?;
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let change = if path_has_extension(&current_path, "md") {
        let (note_id, relative_path) = {
            let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
            (
                vault.path_to_id(&current_path),
                relative_path_from_absolute(&vault.root, &current_path)?,
            )
        };

        if let Some(index) = instance.index.as_mut() {
            index.remove_note(&NoteId(note_id.clone()));
        }
        invalidate_graph_query_cache(instance);
        invalidate_graph_cache(instance);
        mutate_entries_cache(instance, |_, entries| {
            remove_entry_from_cache(entries, &relative_path);
            Ok(())
        })?;

        let revision = advance_note_revision(&mut instance.note_revisions, &note_id, None);
        build_vault_note_change(
            &vault_path,
            "delete",
            None,
            Some(note_id),
            None,
            Some(relative_path),
            VAULT_CHANGE_ORIGIN_AGENT,
            Some(op_id.clone()),
            revision,
            None,
            instance.graph_revision.max(1),
        )
    } else {
        let (current_relative_path, target_relative_path) = {
            let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;
            let current_relative_path = relative_path_from_absolute(&vault.root, &current_path)?;
            let target_relative_path = restore_path
                .as_ref()
                .map(|target_path| relative_path_from_absolute(&vault.root, target_path.as_path()))
                .transpose()?;
            (current_relative_path, target_relative_path)
        };

        mutate_entries_cache(instance, |_, entries| {
            remove_entry_from_cache(entries, &current_relative_path);
            if let Some(target_relative_path) = target_relative_path.as_ref() {
                remove_entry_from_cache(entries, target_relative_path);
            }
            Ok(())
        })?;

        build_vault_note_change(
            &vault_path,
            "delete",
            None,
            None,
            None,
            Some(current_relative_path),
            VAULT_CHANGE_ORIGIN_AGENT,
            Some(op_id),
            0,
            None,
            instance.graph_revision.max(1),
        )
    };

    drop(state);
    emit_vault_note_change(&app, "ai_restore_text_file", change.clone());
    Ok(Some(change))
}

#[tauri::command]
fn compute_tracked_file_patches(
    inputs: Vec<ComputeLineDiffInput>,
) -> Result<Vec<vault_ai_diff::TrackedFilePatches>, String> {
    Ok(inputs
        .into_iter()
        .map(|input| vault_ai_diff::compute_tracked_file_patch(&input.old_text, &input.new_text))
        .collect())
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
    let fallback_non_note_search_index;
    let non_note_search_index =
        if let Some(non_note_search_index) = instance.non_note_search_index.as_ref() {
            non_note_search_index.as_slice()
        } else {
            let entries = if let Some(entries) = instance.entries.as_ref() {
                entries.clone()
            } else {
                vault.discover_vault_entries().map_err(|e| e.to_string())?
            };
            fallback_non_note_search_index = build_non_note_search_index(&entries);
            fallback_non_note_search_index.as_slice()
        };

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

    results.extend(non_note_search_index.into_iter().filter_map(|entry| {
        let score = compute_non_note_search_score(&query_lower, entry);
        if score <= 0.0 {
            return None;
        }
        Some(SearchResultDto {
            id: entry.id.clone(),
            path: entry.path.clone(),
            title: entry.title.clone(),
            kind: entry.kind.clone(),
            score,
        })
    }));

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
    let _cmd_start = Instant::now();
    let state = lock!(state)?;
    let instance = state
        .vaults
        .get(&vault_path)
        .ok_or("No hay vault abierto")?;
    let index = instance.index.as_ref().ok_or("No hay vault abierto")?;
    let vault = instance.vault.as_ref().ok_or("No hay vault abierto")?;

    let results = index.advanced_search(&params, vault);
    let _payload_bytes = serialized_payload_bytes(&results).unwrap_or(0);

    dbg_log!(
        "advanced_search() → {} results, bytes: {}, terms: {}, tags: {}, paths: {}, files: {}, content: {}, properties: {}, total: {:.2?}",
        results.len(),
        _payload_bytes,
        params.terms.len(),
        params.tag_filters.len(),
        params.path_filters.len(),
        params.file_filters.len(),
        params.content_searches.len(),
        params.property_filters.len(),
        _cmd_start.elapsed()
    );

    Ok(results)
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
    let _cmd_start = Instant::now();
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
    let _payload_bytes = serialized_payload_bytes(&tags).unwrap_or(0);
    let _note_refs: usize = tags.iter().map(|tag| tag.note_ids.len()).sum();
    dbg_log!(
        "get_tags() → {} tags, {} note refs, bytes: {}, total: {:.2?}",
        tags.len(),
        _note_refs,
        _payload_bytes,
        _cmd_start.elapsed()
    );
    Ok(tags)
}

#[derive(Debug, Clone, serde::Serialize)]
struct GraphLinkDto {
    source: String,
    target: String,
}

#[derive(serde::Deserialize)]
struct GraphGroupQueryDto {
    color: String,
    params: AdvancedSearchParams,
}

#[derive(serde::Deserialize)]
struct GraphSnapshotOptions {
    mode: String,
    root_note_id: Option<String>,
    local_depth: Option<u32>,
    preferred_node_ids: Option<Vec<String>>,
    include_tags: bool,
    include_attachments: bool,
    include_groups: bool,
    group_queries: Option<Vec<GraphGroupQueryDto>>,
    search_filter: Option<AdvancedSearchParams>,
    show_orphans: bool,
    max_nodes: Option<usize>,
    max_links: Option<usize>,
    overview_mode: Option<bool>,
    layout_cache_key: Option<String>,
}

#[derive(serde::Serialize)]
struct GraphSnapshotStatsDto {
    total_nodes: usize,
    total_links: usize,
    truncated: bool,
    cluster_count: Option<usize>,
}

#[derive(serde::Serialize)]
struct GraphNodeDto {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hop_distance: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_root: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    importance: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cluster_filter: Option<String>,
}

#[derive(serde::Serialize)]
struct GraphSnapshotDto {
    version: u32,
    mode: String,
    stats: GraphSnapshotStatsDto,
    nodes: Vec<GraphNodeDto>,
    links: Vec<GraphLinkDto>,
}

fn graph_search_has_filters(params: &AdvancedSearchParams) -> bool {
    !params.terms.is_empty()
        || !params.tag_filters.is_empty()
        || !params.file_filters.is_empty()
        || !params.path_filters.is_empty()
        || !params.content_searches.is_empty()
        || !params.property_filters.is_empty()
}

fn graph_note_title(index: &VaultIndex, note_id: &NoteId) -> Option<String> {
    index.metadata.get(note_id).map(|meta| meta.title.clone())
}

fn graph_query_kind(params: &AdvancedSearchParams) -> GraphQueryKind {
    if params.content_searches.is_empty() && params.property_filters.is_empty() {
        GraphQueryKind::Cheap
    } else {
        GraphQueryKind::Expensive
    }
}

fn normalize_graph_query(params: &AdvancedSearchParams) -> Result<String, String> {
    serde_json::to_string(params).map_err(|error| error.to_string())
}

fn resolve_graph_query_ids_batch(
    instance: &mut VaultInstance,
    queries: &[&AdvancedSearchParams],
) -> Result<HashMap<String, HashSet<String>>, String> {
    if queries.is_empty() {
        return Ok(HashMap::new());
    }

    let Some(index) = instance.index.as_ref() else {
        return Err("No hay vault abierto".to_string());
    };
    let Some(vault) = instance.vault.as_ref() else {
        return Err("No hay vault abierto".to_string());
    };
    let index_revision = instance.index_revision.max(1);

    let mut unique_queries = HashMap::<String, &AdvancedSearchParams>::new();
    for query in queries {
        unique_queries
            .entry(normalize_graph_query(query)?)
            .or_insert(*query);
    }

    let mut resolved = HashMap::<String, HashSet<String>>::new();

    for (normalized_query, params) in unique_queries {
        let expected_kind = graph_query_kind(params);
        let cached_ids = instance
            .graph_query_cache
            .get(&normalized_query)
            .filter(|entry| entry.revision == index_revision && entry.kind == expected_kind)
            .map(|entry| entry.note_ids.clone());

        if let Some(note_ids) = cached_ids {
            dbg_log!(
                "graph_query_cache HIT kind={:?}, ids={}, revision={}",
                expected_kind,
                note_ids.len(),
                index_revision
            );
            resolved.insert(normalized_query, note_ids.into_iter().collect());
            continue;
        }

        let _query_start = Instant::now();
        let note_ids = index.advanced_search_note_ids(params, vault);
        let mut sorted_note_ids: Vec<String> = note_ids.into_iter().collect();
        sorted_note_ids.sort();

        dbg_log!(
            "graph_query_cache MISS kind={:?}, ids={}, revision={}, total: {:.2?}",
            expected_kind,
            sorted_note_ids.len(),
            index_revision,
            _query_start.elapsed()
        );

        instance.graph_query_cache.insert(
            normalized_query.clone(),
            CachedGraphQueryResult {
                revision: index_revision,
                kind: expected_kind,
                note_ids: sorted_note_ids.clone(),
            },
        );
        resolved.insert(normalized_query, sorted_note_ids.into_iter().collect());
    }

    Ok(resolved)
}

fn graph_node_type_rank(node_type: Option<&str>) -> u8 {
    match node_type {
        Some("cluster") => 0,
        Some("tag") => 1,
        Some("attachment") => 2,
        _ => 0,
    }
}

fn graph_note_weight(index: &VaultIndex, note_id: &NoteId) -> usize {
    index.forward_links.get(note_id).map_or(0, Vec::len)
        + index.backlinks.get(note_id).map_or(0, Vec::len)
}

fn graph_sort_nodes_by_priority(
    nodes: &mut [GraphNodeDto],
    links: &[GraphLinkDto],
    preferred_node_ids: &HashSet<String>,
) {
    let mut degrees = HashMap::<&str, usize>::new();
    for link in links {
        *degrees.entry(link.source.as_str()).or_default() += 1;
        *degrees.entry(link.target.as_str()).or_default() += 1;
    }

    nodes.sort_by(|left, right| {
        let left_is_root = left.is_root.unwrap_or(false);
        let right_is_root = right.is_root.unwrap_or(false);
        right_is_root
            .cmp(&left_is_root)
            .then_with(|| {
                let left_is_preferred = preferred_node_ids.contains(&left.id);
                let right_is_preferred = preferred_node_ids.contains(&right.id);
                right_is_preferred.cmp(&left_is_preferred)
            })
            .then_with(|| {
                left.hop_distance
                    .unwrap_or(u32::MAX)
                    .cmp(&right.hop_distance.unwrap_or(u32::MAX))
            })
            .then_with(|| {
                let left_degree = degrees.get(left.id.as_str()).copied().unwrap_or(0);
                let right_degree = degrees.get(right.id.as_str()).copied().unwrap_or(0);
                right_degree.cmp(&left_degree)
            })
            .then_with(|| {
                graph_node_type_rank(left.node_type.as_deref())
                    .cmp(&graph_node_type_rank(right.node_type.as_deref()))
            })
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn graph_truncate_snapshot(
    nodes: &mut Vec<GraphNodeDto>,
    links: &mut Vec<GraphLinkDto>,
    max_nodes: usize,
    max_links: usize,
    preferred_node_ids: &HashSet<String>,
) -> bool {
    let mut truncated = false;
    let max_nodes = max_nodes.max(1);
    let max_links = max_links.max(1);

    graph_sort_nodes_by_priority(nodes, links, preferred_node_ids);

    if nodes.len() > max_nodes {
        nodes.truncate(max_nodes);
        let visible_ids: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
        links.retain(|link| {
            visible_ids.contains(link.source.as_str()) && visible_ids.contains(link.target.as_str())
        });
        truncated = true;
    }

    if links.len() > max_links {
        let mut node_rank = HashMap::<&str, usize>::new();
        for (index, node) in nodes.iter().enumerate() {
            node_rank.insert(node.id.as_str(), index);
        }

        links.sort_by(|left, right| {
            let left_min_rank = node_rank
                .get(left.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .min(
                    node_rank
                        .get(left.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );
            let right_min_rank = node_rank
                .get(right.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .min(
                    node_rank
                        .get(right.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );
            let left_max_rank = node_rank
                .get(left.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .max(
                    node_rank
                        .get(left.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );
            let right_max_rank = node_rank
                .get(right.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .max(
                    node_rank
                        .get(right.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );

            left_min_rank
                .cmp(&right_min_rank)
                .then_with(|| left_max_rank.cmp(&right_max_rank))
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| left.target.cmp(&right.target))
        });
        links.truncate(max_links);
        truncated = true;
    }

    truncated
}

fn build_limited_local_graph(
    index: &VaultIndex,
    root: &NoteId,
    max_depth: u32,
    max_nodes: usize,
    max_links: usize,
) -> (Vec<(NoteId, u32)>, Vec<GraphLinkDto>, bool) {
    let mut visited: HashSet<NoteId> = HashSet::new();
    let mut queue: VecDeque<(NoteId, u32)> = VecDeque::new();
    let mut nodes: Vec<(NoteId, u32)> = Vec::new();
    let mut truncated = false;
    let node_limit = max_nodes.max(1);
    let link_limit = max_links.max(1);
    let hub_neighbor_limit = DEFAULT_LOCAL_GRAPH_HUB_NEIGHBOR_LIMIT.min(node_limit.max(1));

    if !index.metadata.contains_key(root) {
        return (nodes, Vec::new(), false);
    }

    visited.insert(root.clone());
    queue.push_back((root.clone(), 0));

    while let Some((current, depth)) = queue.pop_front() {
        nodes.push((current.clone(), depth));

        if depth >= max_depth {
            continue;
        }

        let mut unique_neighbors = HashSet::<NoteId>::new();
        if let Some(targets) = index.forward_links.get(&current) {
            unique_neighbors.extend(targets.iter().cloned());
        }
        if let Some(sources) = index.backlinks.get(&current) {
            unique_neighbors.extend(sources.iter().cloned());
        }

        let mut neighbors: Vec<NoteId> = unique_neighbors.into_iter().collect();
        neighbors.sort_by(|left, right| {
            let left_weight = graph_note_weight(index, left);
            let right_weight = graph_note_weight(index, right);
            right_weight
                .cmp(&left_weight)
                .then_with(|| left.0.cmp(&right.0))
        });

        if neighbors.len() > hub_neighbor_limit {
            neighbors.truncate(hub_neighbor_limit);
            truncated = true;
        }

        for neighbor in neighbors {
            if visited.contains(&neighbor) {
                continue;
            }
            if visited.len() >= node_limit {
                truncated = true;
                break;
            }
            visited.insert(neighbor.clone());
            queue.push_back((neighbor, depth + 1));
        }
    }

    let mut links: Vec<GraphLinkDto> = Vec::new();
    for node_id in &visited {
        if let Some(targets) = index.forward_links.get(node_id) {
            for target in targets {
                if visited.contains(target) {
                    links.push(GraphLinkDto {
                        source: node_id.0.clone(),
                        target: target.0.clone(),
                    });
                    if links.len() >= link_limit {
                        truncated = true;
                        return (nodes, links, truncated);
                    }
                }
            }
        }
    }

    (nodes, links, truncated)
}

fn build_overview_graph(
    base_nodes: &[CachedGraphBaseNode],
    visible_note_ids: &HashSet<String>,
    note_links: &[GraphLinkDto],
    show_orphans: bool,
) -> (Vec<GraphNodeDto>, Vec<GraphLinkDto>, usize) {
    let mut note_to_cluster = HashMap::<&str, (&str, &str, Option<&str>)>::new();
    let mut cluster_sizes = HashMap::<String, (String, Option<String>, u32)>::new();

    for node in base_nodes {
        if !visible_note_ids.contains(&node.id) {
            continue;
        }

        note_to_cluster.insert(
            node.id.as_str(),
            (
                node.overview_cluster_id.as_str(),
                node.overview_cluster_title.as_str(),
                node.overview_cluster_filter.as_deref(),
            ),
        );

        let entry = cluster_sizes
            .entry(node.overview_cluster_id.clone())
            .or_insert((
                node.overview_cluster_title.clone(),
                node.overview_cluster_filter.clone(),
                0,
            ));
        entry.2 += 1;
    }

    let mut cluster_links = HashSet::<(String, String)>::new();
    for link in note_links {
        let Some((source_cluster, _, _)) = note_to_cluster.get(link.source.as_str()) else {
            continue;
        };
        let Some((target_cluster, _, _)) = note_to_cluster.get(link.target.as_str()) else {
            continue;
        };
        if source_cluster == target_cluster {
            continue;
        }

        let ordered = if source_cluster <= target_cluster {
            ((*source_cluster).to_string(), (*target_cluster).to_string())
        } else {
            ((*target_cluster).to_string(), (*source_cluster).to_string())
        };
        cluster_links.insert(ordered);
    }

    let mut nodes: Vec<GraphNodeDto> = cluster_sizes
        .into_iter()
        .map(
            |(cluster_id, (cluster_title, cluster_filter, size))| GraphNodeDto {
                id: cluster_id,
                title: format!("{cluster_title} ({size})"),
                node_type: Some("cluster".to_string()),
                hop_distance: None,
                group_color: None,
                is_root: None,
                importance: Some(size),
                cluster_filter,
            },
        )
        .collect();

    let mut links: Vec<GraphLinkDto> = cluster_links
        .into_iter()
        .map(|(source, target)| GraphLinkDto { source, target })
        .collect();

    if !show_orphans {
        let connected_ids: HashSet<&str> = links
            .iter()
            .flat_map(|link| [link.source.as_str(), link.target.as_str()])
            .collect();
        nodes.retain(|node| connected_ids.contains(node.id.as_str()));
    }

    links.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then_with(|| left.target.cmp(&right.target))
    });
    nodes.sort_by(|left, right| left.id.cmp(&right.id));

    let cluster_count = nodes.len();
    (nodes, links, cluster_count)
}

#[tauri::command]
fn get_graph_snapshot(
    vault_path: String,
    options: GraphSnapshotOptions,
    state: tauri::State<Mutex<AppState>>,
) -> Result<GraphSnapshotDto, String> {
    let _cmd_start = Instant::now();
    let mut state = lock!(state)?;
    let instance = state
        .vaults
        .get_mut(&vault_path)
        .ok_or("No hay vault abierto")?;
    let graph_revision = instance.graph_revision.max(1);

    let _ = (options.overview_mode, options.layout_cache_key.as_ref());

    let mode = if options.mode == "local" {
        "local"
    } else if options.mode == "overview" {
        "overview"
    } else {
        "global"
    };
    let local_depth = options.local_depth.unwrap_or(2);
    let root_note_id = options.root_note_id.clone();
    let max_nodes = options.max_nodes.unwrap_or(if mode == "local" {
        DEFAULT_GRAPH_MAX_NODES_LOCAL
    } else {
        DEFAULT_GRAPH_MAX_NODES_GLOBAL
    });
    let max_links = options.max_links.unwrap_or(if mode == "local" {
        DEFAULT_GRAPH_MAX_LINKS_LOCAL
    } else {
        DEFAULT_GRAPH_MAX_LINKS_GLOBAL
    });
    let mut preferred_node_ids: HashSet<String> = options
        .preferred_node_ids
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    if let Some(root_id) = root_note_id.as_ref() {
        preferred_node_ids.insert(root_id.clone());
    }

    let mut note_nodes: Vec<GraphNodeDto>;
    let mut note_links: Vec<GraphLinkDto>;
    let mut truncated = false;
    let mut cluster_count = None;

    if mode == "local" {
        let index = instance.index.as_ref().ok_or("No hay vault abierto")?;
        let Some(root_note_id) = root_note_id.as_ref() else {
            let response = GraphSnapshotDto {
                version: graph_revision as u32,
                mode: mode.to_string(),
                stats: GraphSnapshotStatsDto {
                    total_nodes: 0,
                    total_links: 0,
                    truncated: false,
                    cluster_count: None,
                },
                nodes: Vec::new(),
                links: Vec::new(),
            };
            dbg_log!(
                "get_graph_snapshot(mode=local, missing root) → 0 nodes, 0 links, bytes: {}, total: {:.2?}",
                serialized_payload_bytes(&response).unwrap_or(0),
                _cmd_start.elapsed()
            );
            return Ok(response);
        };

        let root = NoteId(root_note_id.clone());
        let (bfs_nodes, bfs_links, local_truncated) =
            build_limited_local_graph(index, &root, local_depth, max_nodes, max_links);
        truncated |= local_truncated;

        note_nodes = bfs_nodes
            .iter()
            .filter_map(|(id, depth)| {
                graph_note_title(index, id).map(|title| GraphNodeDto {
                    id: id.0.clone(),
                    title,
                    node_type: None,
                    hop_distance: Some(*depth),
                    group_color: None,
                    is_root: Some(id.0 == *root_note_id),
                    importance: None,
                    cluster_filter: None,
                })
            })
            .collect();

        note_links = bfs_links;
    } else {
        let base_snapshot = ensure_graph_base_snapshot(instance)?.clone();
        note_nodes = base_snapshot
            .note_nodes
            .into_iter()
            .map(|node| GraphNodeDto {
                id: node.id,
                title: node.title,
                node_type: None,
                hop_distance: None,
                group_color: None,
                is_root: None,
                importance: None,
                cluster_filter: None,
            })
            .collect();
        note_links = base_snapshot.note_links;
    }

    let search_filter = options
        .search_filter
        .as_ref()
        .filter(|params| graph_search_has_filters(params));
    let group_queries = options.group_queries.as_ref();
    let mut batched_queries: Vec<&AdvancedSearchParams> = Vec::new();
    if let Some(search_filter) = search_filter {
        batched_queries.push(search_filter);
    }
    if options.include_groups {
        if let Some(group_queries) = group_queries {
            for group in group_queries {
                if graph_search_has_filters(&group.params) {
                    batched_queries.push(&group.params);
                }
            }
        }
    }

    let resolved_graph_queries = resolve_graph_query_ids_batch(instance, &batched_queries)?;

    if let Some(search_filter) = search_filter {
        let normalized_query = normalize_graph_query(search_filter)?;
        let allowed_ids = resolved_graph_queries
            .get(&normalized_query)
            .cloned()
            .unwrap_or_default();
        note_nodes.retain(|node| allowed_ids.contains(&node.id));
    }

    let visible_note_ids: HashSet<String> = note_nodes.iter().map(|node| node.id.clone()).collect();
    note_links.retain(|link| {
        visible_note_ids.contains(&link.source) && visible_note_ids.contains(&link.target)
    });

    if mode == "overview" {
        let base_snapshot = ensure_graph_base_snapshot(instance)?.clone();
        let (mut overview_nodes, mut overview_links, overview_cluster_count) = build_overview_graph(
            &base_snapshot.note_nodes,
            &visible_note_ids,
            &note_links,
            options.show_orphans,
        );

        let total_nodes = overview_nodes.len();
        let total_links = overview_links.len();
        truncated |= graph_truncate_snapshot(
            &mut overview_nodes,
            &mut overview_links,
            max_nodes,
            max_links,
            &preferred_node_ids,
        );

        cluster_count = Some(overview_cluster_count);

        let response = GraphSnapshotDto {
            version: graph_revision as u32,
            mode: mode.to_string(),
            stats: GraphSnapshotStatsDto {
                total_nodes,
                total_links,
                truncated,
                cluster_count,
            },
            nodes: overview_nodes,
            links: overview_links,
        };

        dbg_log!(
            "get_graph_snapshot(mode={}, root={}, tags={}, attachments={}, groups={}, filtered={}, show_orphans={}, max_nodes={}, max_links={}) → visible {} nodes / {} links, total {} nodes / {} links, truncated={}, bytes: {}, total: {:.2?}",
            mode,
            root_note_id.as_deref().unwrap_or("-"),
            options.include_tags,
            options.include_attachments,
            options.include_groups,
            options
                .search_filter
                .as_ref()
                .is_some_and(graph_search_has_filters),
            options.show_orphans,
            max_nodes,
            max_links,
            response.nodes.len(),
            response.links.len(),
            total_nodes,
            total_links,
            truncated,
            serialized_payload_bytes(&response).unwrap_or(0),
            _cmd_start.elapsed()
        );

        return Ok(response);
    }

    if options.include_groups {
        if let Some(group_queries) = group_queries {
            let mut note_colors = HashMap::<String, String>::new();
            for group in group_queries {
                if !graph_search_has_filters(&group.params) {
                    continue;
                }
                let normalized_query = normalize_graph_query(&group.params)?;
                let Some(group_ids) = resolved_graph_queries.get(&normalized_query) else {
                    continue;
                };

                for note_id in group_ids {
                    if visible_note_ids.contains(note_id) && !note_colors.contains_key(note_id) {
                        note_colors.insert(note_id.clone(), group.color.clone());
                    }
                }
            }

            for node in &mut note_nodes {
                if let Some(color) = note_colors.get(&node.id) {
                    node.group_color = Some(color.clone());
                }
            }
        }
    }

    let mut nodes = note_nodes;
    let mut links = note_links;

    if options.include_tags {
        let base_snapshot = ensure_graph_base_snapshot(instance)?.clone();
        for tag in base_snapshot.tags {
            let connected_note_ids: Vec<String> = tag
                .note_ids
                .iter()
                .filter(|id| visible_note_ids.contains(*id))
                .cloned()
                .collect();

            if connected_note_ids.is_empty() {
                continue;
            }

            nodes.push(GraphNodeDto {
                id: tag.id.clone(),
                title: tag.title.clone(),
                node_type: Some("tag".to_string()),
                hop_distance: None,
                group_color: None,
                is_root: None,
                importance: None,
                cluster_filter: None,
            });

            links.extend(connected_note_ids.into_iter().map(|note_id| GraphLinkDto {
                source: note_id,
                target: tag.id.clone(),
            }));
        }
    }

    if options.include_attachments {
        let base_snapshot = ensure_graph_base_snapshot(instance)?.clone();
        for attachment in base_snapshot.attachments {
            let connected_source_ids: Vec<String> = attachment
                .source_ids
                .iter()
                .filter(|source_id| visible_note_ids.contains(*source_id))
                .cloned()
                .collect();

            if connected_source_ids.is_empty() {
                continue;
            }

            nodes.push(GraphNodeDto {
                id: attachment.id.clone(),
                title: attachment.title.clone(),
                node_type: Some("attachment".to_string()),
                hop_distance: None,
                group_color: None,
                is_root: None,
                importance: None,
                cluster_filter: None,
            });

            links.extend(
                connected_source_ids
                    .into_iter()
                    .map(|source_id| GraphLinkDto {
                        source: source_id,
                        target: attachment.id.clone(),
                    }),
            );
        }
    }

    if !options.show_orphans {
        let connected_ids: HashSet<String> = links
            .iter()
            .flat_map(|link| [link.source.clone(), link.target.clone()])
            .collect();
        nodes.retain(|node| connected_ids.contains(&node.id));
    }

    let visible_ids: HashSet<String> = nodes.iter().map(|node| node.id.clone()).collect();
    links.retain(|link| visible_ids.contains(&link.source) && visible_ids.contains(&link.target));

    let total_nodes = nodes.len();
    let total_links = links.len();
    truncated |= graph_truncate_snapshot(
        &mut nodes,
        &mut links,
        max_nodes,
        max_links,
        &preferred_node_ids,
    );
    if !options.show_orphans {
        let connected_ids: HashSet<&str> = links
            .iter()
            .flat_map(|link| [link.source.as_str(), link.target.as_str()])
            .collect();
        nodes.retain(|node| connected_ids.contains(node.id.as_str()));
    }

    let response = GraphSnapshotDto {
        version: graph_revision as u32,
        mode: mode.to_string(),
        stats: GraphSnapshotStatsDto {
            total_nodes,
            total_links,
            truncated,
            cluster_count,
        },
        nodes,
        links,
    };

    dbg_log!(
        "get_graph_snapshot(mode={}, root={}, tags={}, attachments={}, groups={}, filtered={}, show_orphans={}, max_nodes={}, max_links={}) → visible {} nodes / {} links, total {} nodes / {} links, truncated={}, bytes: {}, total: {:.2?}",
        mode,
        root_note_id.as_deref().unwrap_or("-"),
        options.include_tags,
        options.include_attachments,
        options.include_groups,
        options
            .search_filter
            .as_ref()
            .is_some_and(graph_search_has_filters),
        options.show_orphans,
        max_nodes,
        max_links,
        response.nodes.len(),
        response.links.len(),
        total_nodes,
        total_links,
        truncated,
        serialized_payload_bytes(&response).unwrap_or(0),
        _cmd_start.elapsed()
    );

    Ok(response)
}

#[tauri::command]
fn get_backlinks(
    vault_path: String,
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<BacklinkDto>, String> {
    let _cmd_start = Instant::now();
    let lock_start = Instant::now();
    let state = lock!(state)?;
    let _lock_wait = lock_start.elapsed();
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
        "get_backlinks({note_id}) → {} results, mutex wait: {_lock_wait:.2?}, total: {:.2?}",
        result.len(),
        _cmd_start.elapsed()
    );
    Ok(result)
}

#[tauri::command]
fn resolve_wikilinks_batch(
    vault_path: String,
    note_id: String,
    targets: Vec<String>,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<ResolvedWikilinkDto>, String> {
    let _cmd_start = Instant::now();
    let _target_count = targets.len();
    let lock_start = Instant::now();
    let state = lock!(state)?;
    let _lock_wait = lock_start.elapsed();
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

    let _resolved_count = links
        .iter()
        .filter(|l| l.resolved_note_id.is_some())
        .count();
    dbg_log!(
        "resolve_wikilinks_batch({note_id}, {_target_count} targets) → {_resolved_count} resolved, mutex wait: {_lock_wait:.2?}, total: {:.2?}",
        _cmd_start.elapsed()
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
fn debug_set_timing(enabled: bool) -> String {
    #[cfg(feature = "debug-logs")]
    {
        DEBUG_TIMING.store(enabled, Ordering::Relaxed);
        let status = if enabled { "ON" } else { "OFF" };
        eprintln!("[perf] Debug timing {status}");
        return format!("Debug timing {status}");
    }

    #[cfg(not(feature = "debug-logs"))]
    {
        let _ = enabled;
        "Debug timing unavailable in this build".to_string()
    }
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

// ---------------------------------------------------------------------------
// macOS version detection (for traffic-light sizing in macOS 26+)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn detect_macos_major_version() -> u32 {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|v| v.trim().split('.').next().map(String::from))
        .and_then(|s| s.parse().ok())
        .unwrap_or(15)
}

#[cfg(not(target_os = "macos"))]
fn detect_macos_major_version() -> u32 {
    0
}

#[tauri::command]
fn get_macos_major_version() -> u32 {
    detect_macos_major_version()
}

/// Traffic-light Y offset per macOS generation.
#[cfg(target_os = "macos")]
fn traffic_light_position_for_version(version: u32) -> (f64, f64) {
    if version >= 26 {
        (14.0, 22.0) // macOS 26 (Tahoe) — push traffic lights down to align with 38px bar
    } else {
        (14.0, 20.0) // macOS ≤15
    }
}

pub(crate) const WEB_CLIPPER_CLIP_SAVED_EVENT: &str = "vaultai:web-clipper/clip-saved";
pub(crate) const WEB_CLIPPER_ROUTE_CLIP_EVENT: &str = "vaultai:web-clipper/route-clip";

#[tauri::command]
fn register_window_vault_route(
    label: String,
    window_mode: String,
    vault_path: Option<String>,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    state.window_vault_routes.insert(
        label.clone(),
        WindowVaultRoute {
            label,
            vault_path,
            window_kind: WindowRouteKind::from_window_mode(&window_mode),
            last_seen_ms: now_ms(),
        },
    );
    Ok(())
}

#[tauri::command]
fn unregister_window_vault_route(
    label: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state = lock!(state)?;
    state.window_vault_routes.remove(&label);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebClipperSavedPayload {
    request_id: String,
    vault_path: String,
    target_window_label: Option<String>,
    note_id: String,
    title: String,
    relative_path: String,
    content: String,
}

fn clipper_vault_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn resolve_web_clipper_vault_key(
    state: &AppState,
    vault_path_hint: Option<&str>,
    vault_name_hint: Option<&str>,
) -> Result<String, String> {
    let ready_keys: Vec<String> = state
        .vaults
        .iter()
        .filter_map(|(path, instance)| {
            if instance.open_state.stage == "ready" && instance.vault.is_some() {
                Some(path.clone())
            } else {
                None
            }
        })
        .collect();

    if ready_keys.is_empty() {
        return Err("No ready vault is available in VaultAI.".to_string());
    }

    if let Some(path_hint) = vault_path_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(found) = ready_keys.iter().find(|path| path.as_str() == path_hint) {
            return Ok(found.clone());
        }
    }

    if let Some(name_hint) = vault_name_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let lower = name_hint.to_lowercase();
        let mut matches = ready_keys
            .iter()
            .filter(|path| clipper_vault_name(path).to_lowercase() == lower)
            .cloned()
            .collect::<Vec<_>>();

        if matches.len() == 1 {
            return Ok(matches.remove(0));
        }
    }

    if ready_keys.len() == 1 {
        return Ok(ready_keys[0].clone());
    }

    Err("VaultAI has multiple open vaults. Provide a more specific vault hint.".to_string())
}

fn normalize_web_clipper_folder(folder: &str) -> Result<String, String> {
    let mut normalized = PathBuf::new();

    for component in Path::new(folder).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(value) => normalized.push(value),
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err("Folder hint must stay inside the vault.".to_string())
            }
        }
    }

    Ok(normalized.to_string_lossy().replace('\\', "/"))
}

fn sanitize_web_clipper_title(title: &str) -> String {
    let sanitized = title
        .trim()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            value if value.is_control() => ' ',
            value => value,
        })
        .collect::<String>()
        .replace('.', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    sanitized
        .chars()
        .take(96)
        .collect::<String>()
        .trim()
        .to_string()
}

fn build_web_clipper_relative_note_path(
    vault: &Vault,
    folder: &str,
    title: &str,
) -> Result<String, String> {
    let normalized_folder = normalize_web_clipper_folder(folder)?;
    let stem = sanitize_web_clipper_title(title);
    let base = if stem.is_empty() {
        "untitled-clip".to_string()
    } else {
        stem
    };

    for index in 1..10_000 {
        let file_name = if index == 1 {
            format!("{base}.md")
        } else {
            format!("{base}-{index}.md")
        };
        let relative_path = if normalized_folder.is_empty() {
            file_name
        } else {
            format!("{normalized_folder}/{file_name}")
        };

        let path = vault
            .resolve_relative_path(&relative_path)
            .map_err(|error| error.to_string())?;
        if !path.exists() {
            return Ok(relative_path);
        }
    }

    Err("Could not find a free filename for the clip.".to_string())
}

pub(crate) fn web_clipper_ready_vaults(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let state = app.state::<Mutex<AppState>>();
    let guard = lock!(state)?;
    Ok(guard
        .vaults
        .iter()
        .filter_map(|(path, instance)| {
            if instance.open_state.stage == "ready" && instance.vault.is_some() {
                Some((path.clone(), clipper_vault_name(path)))
            } else {
                None
            }
        })
        .collect())
}

pub(crate) fn web_clipper_list_folders(
    app: &AppHandle,
    vault_path_hint: Option<&str>,
    vault_name_hint: Option<&str>,
) -> Result<Vec<String>, String> {
    let state = app.state::<Mutex<AppState>>();
    let guard = lock!(state)?;
    let vault_key = resolve_web_clipper_vault_key(&guard, vault_path_hint, vault_name_hint)?;
    let instance = guard
        .vaults
        .get(&vault_key)
        .ok_or("Vault not found".to_string())?;

    let mut folders: Vec<String> = instance
        .entries
        .as_ref()
        .ok_or("Vault entries are not loaded yet.".to_string())?
        .iter()
        .filter(|entry| entry.kind == "folder")
        .map(|entry| entry.relative_path.clone())
        .collect();

    folders.sort();
    Ok(folders)
}

pub(crate) fn web_clipper_list_tags(
    app: &AppHandle,
    vault_path_hint: Option<&str>,
    vault_name_hint: Option<&str>,
) -> Result<Vec<String>, String> {
    let state = app.state::<Mutex<AppState>>();
    let guard = lock!(state)?;
    let vault_key = resolve_web_clipper_vault_key(&guard, vault_path_hint, vault_name_hint)?;
    let instance = guard
        .vaults
        .get(&vault_key)
        .ok_or("Vault not found".to_string())?;
    let index = instance
        .index
        .as_ref()
        .ok_or("Vault index is not available.".to_string())?;

    let mut tags: Vec<String> = index.tags.keys().cloned().collect();
    tags.sort();
    Ok(tags)
}

pub(crate) fn web_clipper_save_note(
    app: &AppHandle,
    request_id: String,
    vault_path_hint: Option<&str>,
    vault_name_hint: Option<&str>,
    title: &str,
    folder: &str,
    content: &str,
) -> Result<WebClipperSavedPayload, String> {
    let state = app.state::<Mutex<AppState>>();
    let mut guard = lock!(state)?;
    prune_stale_window_vault_routes(app, &mut guard);
    let vault_key = resolve_web_clipper_vault_key(&guard, vault_path_hint, vault_name_hint)?;
    let write_tracker = guard.write_tracker.clone();
    let op_id = next_change_op_id(&mut guard, VAULT_CHANGE_ORIGIN_EXTERNAL);
    let instance = guard
        .vaults
        .get_mut(&vault_key)
        .ok_or("Vault not found".to_string())?;

    let (note, entry, relative_path) = {
        let vault = instance
            .vault
            .as_ref()
            .ok_or("Vault is not loaded.".to_string())?;
        let relative_path = build_web_clipper_relative_note_path(vault, folder, title)?;
        let abs_path = vault.root.join(&relative_path);
        write_tracker.track_content(abs_path, content);

        let note = vault
            .create_note(&relative_path, content)
            .map_err(|error| error.to_string())?;
        let entry = vault
            .read_vault_entry_from_path(&note.path.0)
            .map_err(|error| error.to_string())?;

        (note, entry, relative_path)
    };

    let revision = advance_note_revision(&mut instance.note_revisions, &note.id.0, None);
    let change = note_change_from_document(
        &vault_key,
        &note,
        entry.relative_path.clone(),
        VAULT_CHANGE_ORIGIN_EXTERNAL,
        Some(op_id),
        revision,
        instance.graph_revision.max(1),
    );

    if let Some(index) = instance.index.as_mut() {
        index.reindex_note(note.clone());
    }
    invalidate_graph_query_cache(instance);
    invalidate_graph_cache(instance);
    mutate_entries_cache(instance, |vault, entries| {
        ensure_parent_folders_in_cache(entries, vault, &entry.relative_path)?;
        upsert_entry_in_cache(entries, entry);
        Ok(())
    })?;

    let target_window_label = select_web_clipper_target_window_label(&guard, &vault_key);
    let payload = WebClipperSavedPayload {
        request_id,
        vault_path: vault_key.clone(),
        target_window_label: target_window_label.clone(),
        note_id: note.id.0.clone(),
        title: note.title.clone(),
        relative_path,
        content: content.to_string(),
    };

    drop(guard);
    emit_vault_note_change(app, "web_clipper_save", change);
    if let Some(label) = target_window_label {
        let _ = app.emit_to(label, WEB_CLIPPER_CLIP_SAVED_EVENT, payload.clone());
    } else if app.get_webview_window("main").is_some() {
        let _ = app.emit_to("main", WEB_CLIPPER_ROUTE_CLIP_EVENT, payload.clone());
    }
    Ok(payload)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppState::new()))
        .manage(Mutex::new(ai::AiManager::new()))
        .manage(ai::auth_terminal::AiAuthTerminalManager::new())
        .manage(devtools::DevTerminalManager::new())
        .manage(spellcheck::SpellcheckState::new())
        .setup(|app| {
            // Create the main window programmatically so we can set the
            // traffic-light position dynamically based on the macOS version.
            #[cfg(target_os = "macos")]
            let (tl_x, tl_y) = traffic_light_position_for_version(detect_macos_major_version());
            #[cfg(not(target_os = "macos"))]
            let (tl_x, tl_y) = (14.0, 20.0);

            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("VaultAI")
            .inner_size(1200.0, 800.0)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(tl_x, tl_y))
            .build()?;

            clipper_api::start_server(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            start_open_vault,
            get_vault_open_state,
            cancel_open_vault,
            register_window_vault_route,
            unregister_window_vault_route,
            list_notes,
            get_graph_revision,
            list_vault_entries,
            read_vault_file,
            save_vault_file,
            save_vault_binary_file,
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
            compute_tracked_file_patches,
            search_notes,
            advanced_search,
            get_backlinks,
            get_graph_snapshot,
            get_tags,
            resolve_wikilinks_batch,
            suggest_wikilinks,
            debug_set_timing,
            spellcheck::spellcheck_list_languages,
            spellcheck::spellcheck_list_catalog,
            spellcheck::spellcheck_check_text,
            spellcheck::spellcheck_suggest,
            spellcheck::spellcheck_add_to_dictionary,
            spellcheck::spellcheck_remove_from_dictionary,
            spellcheck::spellcheck_ignore_word,
            spellcheck::spellcheck_get_runtime_directory,
            spellcheck::spellcheck_get_metrics,
            spellcheck::spellcheck_reset_metrics,
            spellcheck::spellcheck_install_dictionary,
            spellcheck::spellcheck_remove_installed_dictionary,
            spellcheck::spellcheck_check_grammar,
            ai::commands::ai_list_runtimes,
            ai::commands::ai_get_setup_status,
            ai::commands::ai_update_setup,
            ai::commands::ai_start_auth,
            ai::auth_terminal::ai_start_auth_terminal_session,
            ai::auth_terminal::ai_write_auth_terminal_session,
            ai::auth_terminal::ai_resize_auth_terminal_session,
            ai::auth_terminal::ai_close_auth_terminal_session,
            ai::auth_terminal::ai_get_auth_terminal_session_snapshot,
            ai::commands::ai_list_runtime_sessions,
            ai::commands::ai_list_sessions,
            ai::commands::ai_load_session,
            ai::commands::ai_load_runtime_session,
            ai::commands::ai_resume_runtime_session,
            ai::commands::ai_fork_runtime_session,
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
            ai::commands::ai_delete_runtime_session,
            ai::commands::ai_delete_runtime_sessions_for_vault,
            ai::commands::ai_prune_session_histories,
            ai::commands::ai_register_file_baseline,
            devtools::commands::devtools_create_terminal_session,
            devtools::commands::devtools_write_terminal_session,
            devtools::commands::devtools_resize_terminal_session,
            devtools::commands::devtools_restart_terminal_session,
            devtools::commands::devtools_close_terminal_session,
            devtools::commands::devtools_get_terminal_session_snapshot,
            delete_vault_snapshot,
            maps::list_maps,
            maps::read_map,
            maps::save_map,
            maps::create_map,
            maps::delete_map,
            maps::notify_map_changed,
            get_macos_major_version,
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

    #[test]
    fn remove_subtree_from_cache_drops_folder_and_descendants() {
        let mut entries = vec![
            VaultEntryDto {
                id: "docs".to_string(),
                path: "/tmp/docs".to_string(),
                relative_path: "docs".to_string(),
                title: "docs".to_string(),
                file_name: "docs".to_string(),
                extension: String::new(),
                kind: "folder".to_string(),
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: None,
            },
            VaultEntryDto {
                id: "docs/file.txt".to_string(),
                path: "/tmp/docs/file.txt".to_string(),
                relative_path: "docs/file.txt".to_string(),
                title: "file".to_string(),
                file_name: "file.txt".to_string(),
                extension: "txt".to_string(),
                kind: "file".to_string(),
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: Some("text/plain".to_string()),
            },
            VaultEntryDto {
                id: "notes/test".to_string(),
                path: "/tmp/notes/test.md".to_string(),
                relative_path: "notes/test.md".to_string(),
                title: "test".to_string(),
                file_name: "test.md".to_string(),
                extension: "md".to_string(),
                kind: "note".to_string(),
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: Some("text/markdown".to_string()),
            },
        ];

        remove_subtree_from_cache(&mut entries, "docs");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "notes/test.md");
    }

    #[test]
    fn ensure_parent_folders_in_cache_adds_missing_ancestors() {
        let dir = std::env::temp_dir().join(format!(
            "vault-ai-entry-cache-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let nested_dir = dir.join("projects/2026");
        fs::create_dir_all(&nested_dir).unwrap();
        fs::write(nested_dir.join("plan.md"), b"# Plan").unwrap();

        let vault = Vault::open(dir.clone()).unwrap();
        let mut entries = Vec::new();

        ensure_parent_folders_in_cache(&mut entries, &vault, "projects/2026/plan.md").unwrap();
        sort_entries_cache(&mut entries);

        let relative_paths: Vec<String> = entries
            .iter()
            .map(|entry| entry.relative_path.clone())
            .collect();
        assert_eq!(
            relative_paths,
            vec!["projects".to_string(), "projects/2026".to_string()]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_non_note_search_index_skips_notes_and_normalizes_fields() {
        let entries = vec![
            VaultEntryDto {
                id: "notes/test".to_string(),
                path: "/tmp/notes/test.md".to_string(),
                relative_path: "notes/test.md".to_string(),
                title: "Test".to_string(),
                file_name: "Test.md".to_string(),
                extension: "md".to_string(),
                kind: "note".to_string(),
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: Some("text/markdown".to_string()),
            },
            VaultEntryDto {
                id: "Docs/Guide.pdf".to_string(),
                path: "/tmp/Docs/Guide.pdf".to_string(),
                relative_path: "Docs/Guide.pdf".to_string(),
                title: "Guide".to_string(),
                file_name: "Guide.pdf".to_string(),
                extension: "pdf".to_string(),
                kind: "pdf".to_string(),
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: Some("application/pdf".to_string()),
            },
        ];

        let index = build_non_note_search_index(&entries);

        assert_eq!(index.len(), 1);
        assert_eq!(index[0].id, "Docs/Guide.pdf");
        assert_eq!(index[0].file_name_lower, "guide.pdf");
        assert_eq!(index[0].relative_path_lower, "docs/guide.pdf");
    }

    #[test]
    fn sanitize_web_clipper_title_preserves_spaces() {
        assert_eq!(
            sanitize_web_clipper_title("  Donald Trump's Greenland plan  "),
            "Donald Trump's Greenland plan"
        );
        assert_eq!(
            sanitize_web_clipper_title("Roadmap: Q2/Q3 update"),
            "Roadmap Q2 Q3 update"
        );
    }

    #[test]
    fn build_web_clipper_relative_note_path_keeps_spaces_in_filename() {
        let dir = std::env::temp_dir().join(format!(
            "vault-ai-web-clipper-path-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();

        let vault = Vault::open(dir.clone()).unwrap();
        let relative_path =
            build_web_clipper_relative_note_path(&vault, "Clips", "Donald Trump's Greenland plan")
                .unwrap();

        assert_eq!(relative_path, "Clips/Donald Trump's Greenland plan.md");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn select_web_clipper_target_window_label_prefers_latest_matching_window() {
        let mut state = AppState::new();
        state.window_vault_routes.insert(
            "vault-b".to_string(),
            WindowVaultRoute {
                label: "vault-b".to_string(),
                vault_path: Some("/vaults/shared".to_string()),
                window_kind: WindowRouteKind::Main,
                last_seen_ms: 10,
            },
        );
        state.window_vault_routes.insert(
            "vault-a".to_string(),
            WindowVaultRoute {
                label: "vault-a".to_string(),
                vault_path: Some("/vaults/shared".to_string()),
                window_kind: WindowRouteKind::Main,
                last_seen_ms: 20,
            },
        );

        assert_eq!(
            select_web_clipper_target_window_label(&state, "/vaults/shared"),
            Some("vault-a".to_string())
        );
    }

    #[test]
    fn select_web_clipper_target_window_label_prefers_main_label_on_tie() {
        let mut state = AppState::new();
        state.window_vault_routes.insert(
            "vault-z".to_string(),
            WindowVaultRoute {
                label: "vault-z".to_string(),
                vault_path: Some("/vaults/shared".to_string()),
                window_kind: WindowRouteKind::Main,
                last_seen_ms: 20,
            },
        );
        state.window_vault_routes.insert(
            "main".to_string(),
            WindowVaultRoute {
                label: "main".to_string(),
                vault_path: Some("/vaults/shared".to_string()),
                window_kind: WindowRouteKind::Main,
                last_seen_ms: 20,
            },
        );

        assert_eq!(
            select_web_clipper_target_window_label(&state, "/vaults/shared"),
            Some("main".to_string())
        );
    }

    #[test]
    fn select_web_clipper_target_window_label_ignores_non_main_and_mismatched_routes() {
        let mut state = AppState::new();
        state.window_vault_routes.insert(
            "note-window".to_string(),
            WindowVaultRoute {
                label: "note-window".to_string(),
                vault_path: Some("/vaults/shared".to_string()),
                window_kind: WindowRouteKind::Note,
                last_seen_ms: 50,
            },
        );
        state.window_vault_routes.insert(
            "main".to_string(),
            WindowVaultRoute {
                label: "main".to_string(),
                vault_path: Some("/vaults/other".to_string()),
                window_kind: WindowRouteKind::Main,
                last_seen_ms: 100,
            },
        );

        assert_eq!(
            select_web_clipper_target_window_label(&state, "/vaults/shared"),
            None
        );
    }

    #[test]
    fn compute_tracked_file_patches_returns_line_and_text_ranges() {
        let patches = compute_tracked_file_patches(vec![ComputeLineDiffInput {
            old_text: "alpha".to_string(),
            new_text: "alpHa".to_string(),
        }])
        .unwrap();

        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].line_patch.edits.len(), 1);
        assert_eq!(patches[0].line_patch.edits[0].old_start, 0);
        assert_eq!(patches[0].line_patch.edits[0].old_end, 1);
        assert_eq!(patches[0].line_patch.edits[0].new_start, 0);
        assert_eq!(patches[0].line_patch.edits[0].new_end, 1);
        assert_eq!(patches[0].text_range_patch.spans.len(), 1);
        assert_eq!(patches[0].text_range_patch.spans[0].base_from, 3);
        assert_eq!(patches[0].text_range_patch.spans[0].base_to, 4);
        assert_eq!(patches[0].text_range_patch.spans[0].current_from, 3);
        assert_eq!(patches[0].text_range_patch.spans[0].current_to, 4);
    }

    #[test]
    fn advance_note_revision_increments_and_preserves_history_across_rename() {
        let mut revisions = HashMap::new();

        assert_eq!(advance_note_revision(&mut revisions, "notes/a", None), 1);
        assert_eq!(advance_note_revision(&mut revisions, "notes/a", None), 2);
        assert_eq!(
            advance_note_revision(&mut revisions, "notes/b", Some("notes/a")),
            3
        );
        assert_eq!(revisions.get("notes/a"), None);
        assert_eq!(revisions.get("notes/b"), Some(&3));
    }

    #[test]
    fn next_change_op_id_is_monotonic_and_origin_prefixed() {
        let mut state = AppState::new();

        assert_eq!(next_change_op_id(&mut state, "user"), "user-0");
        assert_eq!(next_change_op_id(&mut state, "external"), "external-1");
        assert_eq!(state.next_change_op_id, 2);
    }
}
