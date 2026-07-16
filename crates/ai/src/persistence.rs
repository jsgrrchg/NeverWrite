use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SESSION_META_FILE: &str = "session-meta.json";
const SESSION_INDEX_FILE: &str = "index.json";
const SESSION_TRANSCRIPT_FILE: &str = "transcript.jsonl";
const SESSION_COMPACTION_MARKER_FILE: &str = "compact-state.json";
const FORMAT_VERSION: u32 = 1;
const MB: u64 = 1024 * 1024;
const DEFAULT_TRANSCRIPT_COMPACTION_POLICY: TranscriptCompactionPolicy =
    TranscriptCompactionPolicy {
        min_obsolete_bytes: 4 * MB,
        max_physical_to_indexed_ratio: 2,
        force_physical_bytes: 64 * MB,
    };

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedMessage {
    pub id: String,
    pub role: String,
    pub kind: String,
    pub content: String,
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_options: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diffs: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_diffs: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_questions: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_elicitation_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_elicitation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_elicitation_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_entries: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_action: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSessionHistory {
    pub version: u32,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    pub model_id: String,
    pub mode_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_options: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_roots: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub messages: Vec<PersistedMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSessionHistoryPage {
    pub session_id: String,
    pub total_messages: usize,
    pub start_index: usize,
    pub end_index: usize,
    pub messages: Vec<PersistedMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchedMessage {
    pub message_id: String,
    pub role: String,
    pub content_snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSearchResult {
    pub session_id: String,
    pub title: Option<String>,
    pub custom_title: Option<String>,
    pub updated_at: u64,
    pub matched_messages: Vec<MatchedMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InspectedHistoryFormat {
    Directory,
    LegacyJson,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectedHistory {
    pub session_id: String,
    pub relative_path: String,
    pub format: InspectedHistoryFormat,
    pub content_fingerprint: String,
    pub artifact_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageArtifactIssue {
    pub relative_path: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnknownStorageEntry {
    pub relative_path: String,
    pub entry_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateSessionId {
    pub session_id: String,
    pub artifacts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionIdClaim {
    pub session_id: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoverableStorageState {
    pub relative_path: String,
    pub state_type: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryStorageInventory {
    pub storage_root_exists: bool,
    pub sessions_root_exists: bool,
    pub sessions: Vec<InspectedHistory>,
    pub session_id_claims: Vec<SessionIdClaim>,
    pub corrupt_artifacts: Vec<StorageArtifactIssue>,
    pub duplicate_session_ids: Vec<DuplicateSessionId>,
    pub recoverable_states: Vec<RecoverableStorageState>,
    pub unknown_entries: Vec<UnknownStorageEntry>,
    pub read_errors: Vec<StorageArtifactIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageInventory {
    pub fingerprint: String,
    pub histories: HistoryStorageInventory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSessionMetadata {
    version: u32,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_id: Option<String>,
    model_id: String,
    mode_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    modes: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    config_options: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    additional_roots: Vec<String>,
    created_at: u64,
    updated_at: u64,
    message_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    custom_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    forked_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedTranscriptIndex {
    version: u32,
    message_offsets: Vec<u64>,
    message_lengths: Vec<u64>,
    message_hashes: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct TranscriptCompactionPolicy {
    min_obsolete_bytes: u64,
    max_physical_to_indexed_ratio: u64,
    force_physical_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TranscriptCompactionState {
    version: u32,
    metadata_tmp: String,
    index_tmp: String,
    transcript_tmp: String,
    metadata_backup: String,
    index_backup: String,
    transcript_backup: String,
}

#[derive(Debug, Default)]
struct LegacySessionArtifacts {
    file_path: Option<PathBuf>,
    dir_path: Option<PathBuf>,
}

fn sessions_dir(storage_root: &Path) -> PathBuf {
    storage_root.join("sessions")
}

fn sha256_hex(bytes: &[u8]) -> String {
    digest_hex(&sha256_digest(bytes))
}

fn sha256_digest(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn digest_hex(digest: &[u8; 32]) -> String {
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

#[derive(Default)]
struct InventoryFingerprintBuilder {
    records: Vec<Vec<u8>>,
}

impl InventoryFingerprintBuilder {
    fn add(&mut self, kind: &str, relative_path: &str, content: &[u8]) {
        self.add_digest(kind, relative_path, &sha256_digest(content));
    }

    fn add_digest(&mut self, kind: &str, relative_path: &str, digest: &[u8; 32]) {
        let mut record = Vec::new();
        append_fingerprint_part(&mut record, kind.as_bytes());
        append_fingerprint_part(&mut record, relative_path.as_bytes());
        append_fingerprint_part(&mut record, digest);
        self.records.push(record);
    }

    fn finish(mut self) -> String {
        self.records.sort();
        let mut hasher = Sha256::new();
        for record in self.records {
            hasher.update((record.len() as u64).to_le_bytes());
            hasher.update(record);
        }
        digest_hex(&hasher.finalize().into())
    }
}

fn append_fingerprint_part(target: &mut Vec<u8>, part: &[u8]) {
    target.extend_from_slice(&(part.len() as u64).to_le_bytes());
    target.extend_from_slice(part);
}

struct Sha256Writer<'a>(&'a mut Sha256);

impl Write for Sha256Writer<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn update_canonical_json(value: &serde_json::Value, output: &mut Sha256) {
    match value {
        serde_json::Value::Null => output.update(b"null"),
        serde_json::Value::Bool(value) => {
            output.update(if *value { &b"true"[..] } else { &b"false"[..] })
        }
        serde_json::Value::Number(value) => output.update(value.to_string().as_bytes()),
        serde_json::Value::String(value) => {
            serde_json::to_writer(Sha256Writer(output), value)
                .expect("serializing a JSON string cannot fail");
        }
        serde_json::Value::Array(values) => {
            output.update(b"[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.update(b",");
                }
                update_canonical_json(value, output);
            }
            output.update(b"]");
        }
        serde_json::Value::Object(values) => {
            output.update(b"{");
            let sorted = values.iter().collect::<BTreeMap<_, _>>();
            for (index, (key, value)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    output.update(b",");
                }
                serde_json::to_writer(Sha256Writer(output), key)
                    .expect("serializing a JSON object key cannot fail");
                output.update(b":");
                update_canonical_json(value, output);
            }
            output.update(b"}");
        }
    }
}

fn artifact_fingerprint(_path: &Path, bytes: &[u8]) -> [u8; 32] {
    sha256_digest(bytes)
}

fn raw_file_fingerprint(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn artifact_file_fingerprint(path: &Path) -> std::io::Result<[u8; 32]> {
    raw_file_fingerprint(path)
}

fn relative_storage_path(storage_root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(storage_root).unwrap_or(path);
    lossless_path_string(relative)
}

fn lossless_path_string(path: &Path) -> String {
    if let Some(value) = path.to_str() {
        let normalized = value.replace('\\', "/");
        if normalized.starts_with("@neverwrite-bytes:") {
            return format!("@neverwrite-utf8:{normalized}");
        }
        return normalized;
    }

    encode_non_utf8_path(path)
}

#[cfg(unix)]
fn encode_non_utf8_path(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;

    let mut encoded = String::from("@neverwrite-bytes:");
    for byte in path.as_os_str().as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(windows)]
fn encode_non_utf8_path(path: &Path) -> String {
    use std::os::windows::ffi::OsStrExt;

    let mut encoded = String::from("@neverwrite-bytes:");
    for unit in path.as_os_str().encode_wide() {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{unit:04x}");
    }
    encoded
}

#[cfg(not(any(unix, windows)))]
fn encode_non_utf8_path(path: &Path) -> String {
    format!(
        "@neverwrite-bytes:{}",
        sha256_hex(path.to_string_lossy().as_bytes())
    )
}

fn push_corrupt_artifact(
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
    relative_path: String,
    error: impl Into<String>,
) {
    let error = error.into();
    fingerprint.add("corrupt", &relative_path, error.as_bytes());
    inventory.corrupt_artifacts.push(StorageArtifactIssue {
        relative_path,
        error,
    });
}

fn push_read_error(
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
    relative_path: String,
    error: impl Into<String>,
) {
    let error = error.into();
    fingerprint.add("read-error", &relative_path, error.as_bytes());
    inventory.read_errors.push(StorageArtifactIssue {
        relative_path,
        error,
    });
}

fn push_unknown_entry(
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
    relative_path: String,
    entry_type: impl Into<String>,
) {
    let entry_type = entry_type.into();
    fingerprint.add("unknown", &relative_path, entry_type.as_bytes());
    inventory.unknown_entries.push(UnknownStorageEntry {
        relative_path,
        entry_type,
    });
}

struct ReadArtifact {
    bytes: Vec<u8>,
    fingerprint: [u8; 32],
}

fn read_expected_artifact(
    storage_root: &Path,
    path: &Path,
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
) -> Option<ReadArtifact> {
    let relative_path = relative_storage_path(storage_root, path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            push_corrupt_artifact(
                inventory,
                fingerprint,
                relative_path,
                "Required history artifact is missing.",
            );
            return None;
        }
        Err(error) => {
            push_read_error(inventory, fingerprint, relative_path, error.to_string());
            return None;
        }
    };

    if !metadata.file_type().is_file() {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_path,
            "Required history artifact is not a regular file.",
        );
        return None;
    }

    match fs::read(path) {
        Ok(bytes) => {
            let artifact_fingerprint = artifact_fingerprint(path, &bytes);
            fingerprint.add_digest("file", &relative_path, &artifact_fingerprint);
            Some(ReadArtifact {
                bytes,
                fingerprint: artifact_fingerprint,
            })
        }
        Err(error) => {
            push_read_error(inventory, fingerprint, relative_path, error.to_string());
            None
        }
    }
}

fn fingerprint_unknown_tree(
    storage_root: &Path,
    path: &Path,
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
) {
    let relative_path = relative_storage_path(storage_root, path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            push_read_error(inventory, fingerprint, relative_path, error.to_string());
            return;
        }
    };
    let file_type = metadata.file_type();

    if file_type.is_symlink() {
        match fs::read_link(path) {
            Ok(target) => {
                let target = lossless_path_string(&target);
                fingerprint.add("symlink", &relative_path, target.as_bytes());
            }
            Err(error) => push_read_error(inventory, fingerprint, relative_path, error.to_string()),
        }
        return;
    }

    if file_type.is_file() {
        match artifact_file_fingerprint(path) {
            Ok(artifact_fingerprint) => {
                fingerprint.add_digest("file", &relative_path, &artifact_fingerprint)
            }
            Err(error) => push_read_error(inventory, fingerprint, relative_path, error.to_string()),
        }
        return;
    }

    if !file_type.is_dir() {
        fingerprint.add("special", &relative_path, &[]);
        return;
    }

    fingerprint.add("directory", &relative_path, &[]);
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            push_read_error(inventory, fingerprint, relative_path, error.to_string());
            return;
        }
    };
    for entry in entries {
        match entry {
            Ok(entry) => {
                fingerprint_unknown_tree(storage_root, &entry.path(), inventory, fingerprint)
            }
            Err(error) => push_read_error(
                inventory,
                fingerprint,
                format!("{relative_path}/<unreadable-entry>"),
                error.to_string(),
            ),
        }
    }
}

// `session_id` remains a logical product identifier; disk layout uses a hashed storage key.
fn session_storage_key(session_id: &str) -> String {
    format!("session-{}", sha256_hex(session_id.as_bytes()))
}

fn storage_session_dir(storage_root: &Path, session_id: &str) -> PathBuf {
    sessions_dir(storage_root).join(session_storage_key(session_id))
}

fn session_meta_path(session_dir: &Path) -> PathBuf {
    session_dir.join(SESSION_META_FILE)
}

fn session_index_path(session_dir: &Path) -> PathBuf {
    session_dir.join(SESSION_INDEX_FILE)
}

fn session_transcript_path(session_dir: &Path) -> PathBuf {
    session_dir.join(SESSION_TRANSCRIPT_FILE)
}

fn session_compaction_marker_path(session_dir: &Path) -> PathBuf {
    session_dir.join(SESSION_COMPACTION_MARKER_FILE)
}

fn storage_session_meta_file(storage_root: &Path, session_id: &str) -> PathBuf {
    session_meta_path(&storage_session_dir(storage_root, session_id))
}

fn storage_session_index_file(storage_root: &Path, session_id: &str) -> PathBuf {
    session_index_path(&storage_session_dir(storage_root, session_id))
}

fn storage_session_transcript_file(storage_root: &Path, session_id: &str) -> PathBuf {
    session_transcript_path(&storage_session_dir(storage_root, session_id))
}

fn storage_session_is_complete(storage_root: &Path, session_id: &str) -> bool {
    storage_session_meta_file(storage_root, session_id).exists()
        && storage_session_index_file(storage_root, session_id).exists()
        && storage_session_transcript_file(storage_root, session_id).exists()
}

fn ensure_sessions_root(storage_root: &Path) -> Result<(), String> {
    fs::create_dir_all(sessions_dir(storage_root)).map_err(|e| e.to_string())
}

fn trim_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn derive_title(messages: &[PersistedMessage]) -> Option<String> {
    messages.iter().find_map(|message| {
        if message.role == "user" && message.kind == "text" {
            return trim_non_empty(&message.content);
        }
        None
    })
}

fn derive_preview(messages: &[PersistedMessage]) -> Option<String> {
    messages.iter().rev().find_map(|message| {
        let content = trim_non_empty(&message.content)?;
        if message.kind == "status" {
            return None;
        }

        let preview = match message.kind.as_str() {
            "tool" => content,
            "plan" => format!("Plan: {content}"),
            "permission" => format!("Permission: {content}"),
            "user_input_request" => format!("Input: {content}"),
            "url_elicitation_request" => format!("URL request: {content}"),
            "error" => format!("Error: {content}"),
            _ => content,
        };

        Some(preview)
    })
}

fn serialize_message_bytes(message: &PersistedMessage) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn hash_message(message: &PersistedMessage) -> Result<String, String> {
    let bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    Ok(sha256_hex(&bytes))
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "AI history path has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let temp_path = path.with_extension(format!("{suffix}.tmp"));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temp_path, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn load_session_metadata(
    storage_root: &Path,
    session_id: &str,
) -> Result<PersistedSessionMetadata, String> {
    read_json_file(&storage_session_meta_file(storage_root, session_id))
}

fn load_session_index(
    storage_root: &Path,
    session_id: &str,
) -> Result<PersistedTranscriptIndex, String> {
    read_json_file(&storage_session_index_file(storage_root, session_id))
}

fn load_session_metadata_from_dir(session_dir: &Path) -> Result<PersistedSessionMetadata, String> {
    recover_incomplete_compaction(session_dir)?;
    read_json_file(&session_meta_path(session_dir))
}

fn indexed_transcript_bytes(index: &PersistedTranscriptIndex) -> u64 {
    index.message_lengths.iter().copied().sum()
}

fn validate_index(index: &PersistedTranscriptIndex) -> Result<(), String> {
    let count = index.message_offsets.len();
    if index.message_lengths.len() != count || index.message_hashes.len() != count {
        return Err("Persisted transcript index is inconsistent.".to_string());
    }
    Ok(())
}

fn validate_lazy_session_files(
    metadata: &PersistedSessionMetadata,
    index: &PersistedTranscriptIndex,
) -> Result<(), String> {
    validate_index(index)?;
    if index.message_offsets.len() != metadata.message_count {
        return Err("Persisted transcript metadata and index are inconsistent.".to_string());
    }
    Ok(())
}

enum StrictTranscriptInspectionError {
    Read(std::io::Error),
    Corrupt(String),
}

impl From<std::io::Error> for StrictTranscriptInspectionError {
    fn from(error: std::io::Error) -> Self {
        Self::Read(error)
    }
}

struct StrictTranscriptFingerprints {
    artifact: [u8; 32],
    content: String,
}

fn inspect_strict_transcript_file(
    metadata: &PersistedSessionMetadata,
    index: &PersistedTranscriptIndex,
    transcript_path: &Path,
) -> Result<StrictTranscriptFingerprints, StrictTranscriptInspectionError> {
    validate_lazy_session_files(metadata, index)
        .map_err(StrictTranscriptInspectionError::Corrupt)?;
    if metadata.version != FORMAT_VERSION {
        return Err(StrictTranscriptInspectionError::Corrupt(format!(
            "Unsupported session metadata version: {}.",
            metadata.version
        )));
    }
    if index.version != FORMAT_VERSION {
        return Err(StrictTranscriptInspectionError::Corrupt(format!(
            "Unsupported transcript index version: {}.",
            index.version
        )));
    }

    let transcript = File::open(transcript_path)?;
    let mut reader = BufReader::new(transcript);
    let mut artifact_hasher = Sha256::new();
    let mut line = Vec::new();
    let mut line_index = 0_usize;
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        line_index += 1;
        artifact_hasher.update(&line);
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        serde_json::from_slice::<PersistedMessage>(&line).map_err(|error| {
            StrictTranscriptInspectionError::Corrupt(format!(
                "Persisted transcript row {} is invalid: {error}",
                line_index
            ))
        })?;
    }

    let history = history_from_metadata(metadata.clone(), Vec::new());
    let mut content_hasher =
        history_content_hasher(&history).map_err(StrictTranscriptInspectionError::Corrupt)?;
    let mut transcript = File::open(transcript_path)?;
    let transcript_length = transcript.metadata()?.len();
    for position in 0..index.message_offsets.len() {
        let offset = index.message_offsets[position];
        let indexed_length = index.message_lengths[position];
        let end = offset.checked_add(indexed_length).ok_or_else(|| {
            StrictTranscriptInspectionError::Corrupt(
                "Persisted transcript range overflows.".to_string(),
            )
        })?;
        if end > transcript_length {
            return Err(StrictTranscriptInspectionError::Corrupt(format!(
                "Persisted transcript entry {position} points outside the transcript."
            )));
        }
        let length = usize::try_from(indexed_length).map_err(|_| {
            StrictTranscriptInspectionError::Corrupt(
                "Persisted transcript length exceeds this platform.".to_string(),
            )
        })?;
        transcript.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|error| {
            StrictTranscriptInspectionError::Corrupt(format!(
                "Persisted transcript entry {position} is too large to inspect: {error}"
            ))
        })?;
        bytes.resize(length, 0);
        transcript.read_exact(&mut bytes).map_err(|error| {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                StrictTranscriptInspectionError::Corrupt(format!(
                    "Persisted transcript entry {position} points outside the transcript."
                ))
            } else {
                StrictTranscriptInspectionError::Read(error)
            }
        })?;
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
        }
        let message = serde_json::from_slice::<PersistedMessage>(&bytes).map_err(|error| {
            StrictTranscriptInspectionError::Corrupt(format!(
                "Persisted transcript entry {position} is invalid: {error}"
            ))
        })?;
        let message_hash =
            hash_message(&message).map_err(StrictTranscriptInspectionError::Corrupt)?;
        if message_hash != index.message_hashes[position] {
            return Err(StrictTranscriptInspectionError::Corrupt(format!(
                "Persisted transcript entry {position} does not match its index hash."
            )));
        }
        update_history_content_field(&mut content_hasher, "message", &message)
            .map_err(StrictTranscriptInspectionError::Corrupt)?;
    }

    Ok(StrictTranscriptFingerprints {
        artifact: artifact_hasher.finalize().into(),
        content: digest_hex(&content_hasher.finalize().into()),
    })
}

fn combined_artifact_fingerprint(fingerprints: &[[u8; 32]]) -> String {
    let mut hasher = Sha256::new();
    for fingerprint in fingerprints {
        hasher.update(fingerprint);
    }
    digest_hex(&hasher.finalize().into())
}

fn update_history_content_field<T: Serialize + ?Sized>(
    hasher: &mut Sha256,
    name: &str,
    value: &T,
) -> Result<(), String> {
    hasher.update(name.as_bytes());
    let value = serde_json::to_value(value).map_err(|error| error.to_string())?;
    update_canonical_json(&value, hasher);
    Ok(())
}

fn history_content_hasher(history: &PersistedSessionHistory) -> Result<Sha256, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"neverwrite-history-content-v1");
    update_history_content_field(&mut hasher, "version", &history.version)?;
    update_history_content_field(&mut hasher, "session_id", &history.session_id)?;
    update_history_content_field(&mut hasher, "parent_session_id", &history.parent_session_id)?;
    update_history_content_field(&mut hasher, "closed_at", &history.closed_at)?;
    update_history_content_field(&mut hasher, "runtime_id", &history.runtime_id)?;
    update_history_content_field(&mut hasher, "model_id", &history.model_id)?;
    update_history_content_field(&mut hasher, "mode_id", &history.mode_id)?;
    update_history_content_field(&mut hasher, "models", &history.models)?;
    update_history_content_field(&mut hasher, "modes", &history.modes)?;
    update_history_content_field(&mut hasher, "config_options", &history.config_options)?;
    update_history_content_field(&mut hasher, "additional_roots", &history.additional_roots)?;
    update_history_content_field(&mut hasher, "created_at", &history.created_at)?;
    update_history_content_field(&mut hasher, "updated_at", &history.updated_at)?;
    update_history_content_field(&mut hasher, "start_index", &history.start_index)?;
    update_history_content_field(&mut hasher, "message_count", &history.message_count)?;
    update_history_content_field(&mut hasher, "title", &history.title)?;
    update_history_content_field(&mut hasher, "custom_title", &history.custom_title)?;
    update_history_content_field(&mut hasher, "preview", &history.preview)?;
    Ok(hasher)
}

fn persisted_history_content_fingerprint(
    history: &PersistedSessionHistory,
) -> Result<String, String> {
    let mut hasher = history_content_hasher(history)?;
    for message in &history.messages {
        update_history_content_field(&mut hasher, "message", message)?;
    }
    Ok(digest_hex(&hasher.finalize().into()))
}

fn inspect_compaction_state(
    storage_root: &Path,
    session_dir: &Path,
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
) -> HashSet<std::ffi::OsString> {
    let marker_path = session_compaction_marker_path(session_dir);
    let mut known_entries = HashSet::new();
    let marker_metadata = match fs::symlink_metadata(&marker_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return known_entries,
        Err(error) => {
            push_read_error(
                inventory,
                fingerprint,
                relative_storage_path(storage_root, &marker_path),
                error.to_string(),
            );
            return known_entries;
        }
    };
    known_entries.insert(std::ffi::OsString::from(SESSION_COMPACTION_MARKER_FILE));
    if !marker_metadata.file_type().is_file() {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_storage_path(storage_root, &marker_path),
            "Transcript compaction marker is not a regular file.",
        );
        return known_entries;
    }

    let Some(marker_artifact) =
        read_expected_artifact(storage_root, &marker_path, inventory, fingerprint)
    else {
        return known_entries;
    };
    let state = match serde_json::from_slice::<TranscriptCompactionState>(&marker_artifact.bytes) {
        Ok(state) => state,
        Err(error) => {
            push_corrupt_artifact(
                inventory,
                fingerprint,
                relative_storage_path(storage_root, &marker_path),
                format!("Invalid transcript compaction marker: {error}"),
            );
            return known_entries;
        }
    };
    if state.version != FORMAT_VERSION {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_storage_path(storage_root, &marker_path),
            format!(
                "Unsupported transcript compaction marker version: {}.",
                state.version
            ),
        );
        return known_entries;
    }

    for file_name in [
        &state.metadata_tmp,
        &state.index_tmp,
        &state.transcript_tmp,
        &state.metadata_backup,
        &state.index_backup,
        &state.transcript_backup,
    ] {
        let sidecar_path = match session_sidecar_from_marker(session_dir, file_name) {
            Ok(path) => path,
            Err(error) => {
                push_corrupt_artifact(
                    inventory,
                    fingerprint,
                    relative_storage_path(storage_root, &marker_path),
                    error,
                );
                return known_entries;
            }
        };
        known_entries.insert(std::ffi::OsString::from(file_name.as_str()));
        match fs::symlink_metadata(&sidecar_path) {
            Ok(metadata) if metadata.file_type().is_file() => {
                let relative_path = relative_storage_path(storage_root, &sidecar_path);
                match artifact_file_fingerprint(&sidecar_path) {
                    Ok(artifact_fingerprint) => {
                        fingerprint.add_digest("file", &relative_path, &artifact_fingerprint)
                    }
                    Err(error) => {
                        push_read_error(inventory, fingerprint, relative_path, error.to_string())
                    }
                }
            }
            Ok(_) => {
                push_corrupt_artifact(
                    inventory,
                    fingerprint,
                    relative_storage_path(storage_root, &sidecar_path),
                    "Transcript compaction sidecar is not a regular file.",
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => push_read_error(
                inventory,
                fingerprint,
                relative_storage_path(storage_root, &sidecar_path),
                error.to_string(),
            ),
        }
    }

    inventory.recoverable_states.push(RecoverableStorageState {
        relative_path: relative_storage_path(storage_root, &marker_path),
        state_type: "interrupted_transcript_compaction".to_string(),
    });
    known_entries
}

fn inspect_session_directory(
    storage_root: &Path,
    session_dir: &Path,
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
) {
    let relative_dir = relative_storage_path(storage_root, session_dir);
    fingerprint.add("directory", &relative_dir, &[]);
    let compaction_entries =
        inspect_compaction_state(storage_root, session_dir, inventory, fingerprint);

    match fs::read_dir(session_dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        push_read_error(
                            inventory,
                            fingerprint,
                            format!("{relative_dir}/<unreadable-entry>"),
                            error.to_string(),
                        );
                        continue;
                    }
                };
                let name = entry.file_name();
                if name == SESSION_META_FILE
                    || name == SESSION_INDEX_FILE
                    || name == SESSION_TRANSCRIPT_FILE
                    || compaction_entries.contains(&name)
                {
                    continue;
                }

                let path = entry.path();
                let relative_path = relative_storage_path(storage_root, &path);
                let entry_type = fs::symlink_metadata(&path)
                    .map(|metadata| {
                        let file_type = metadata.file_type();
                        if file_type.is_symlink() {
                            "symlink"
                        } else if file_type.is_dir() {
                            "directory"
                        } else if file_type.is_file() {
                            "file"
                        } else {
                            "special"
                        }
                    })
                    .unwrap_or("unreadable");
                push_unknown_entry(inventory, fingerprint, relative_path, entry_type);
                fingerprint_unknown_tree(storage_root, &path, inventory, fingerprint);
            }
        }
        Err(error) => push_read_error(
            inventory,
            fingerprint,
            relative_dir.clone(),
            error.to_string(),
        ),
    }

    let metadata_path = session_meta_path(session_dir);
    let index_path = session_index_path(session_dir);
    let transcript_path = session_transcript_path(session_dir);
    let metadata_bytes =
        read_expected_artifact(storage_root, &metadata_path, inventory, fingerprint);
    let index_bytes = read_expected_artifact(storage_root, &index_path, inventory, fingerprint);
    let transcript_relative_path = relative_storage_path(storage_root, &transcript_path);
    let transcript_artifact_fingerprint = match fs::symlink_metadata(&transcript_path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            match artifact_file_fingerprint(&transcript_path) {
                Ok(artifact_fingerprint) => {
                    fingerprint.add_digest(
                        "file",
                        &transcript_relative_path,
                        &artifact_fingerprint,
                    );
                    Some(artifact_fingerprint)
                }
                Err(error) => {
                    push_read_error(
                        inventory,
                        fingerprint,
                        transcript_relative_path,
                        error.to_string(),
                    );
                    None
                }
            }
        }
        Ok(_) => {
            push_corrupt_artifact(
                inventory,
                fingerprint,
                transcript_relative_path,
                "Required history artifact is not a regular file.",
            );
            None
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            push_corrupt_artifact(
                inventory,
                fingerprint,
                transcript_relative_path,
                "Required history artifact is missing.",
            );
            None
        }
        Err(error) => {
            push_read_error(
                inventory,
                fingerprint,
                transcript_relative_path,
                error.to_string(),
            );
            None
        }
    };

    let metadata = metadata_bytes.as_ref().and_then(|artifact| {
        match serde_json::from_slice::<PersistedSessionMetadata>(&artifact.bytes) {
            Ok(metadata) => Some(metadata),
            Err(error) => {
                push_corrupt_artifact(
                    inventory,
                    fingerprint,
                    relative_storage_path(storage_root, &metadata_path),
                    format!("Invalid session metadata: {error}"),
                );
                None
            }
        }
    });
    let index = index_bytes.as_ref().and_then(|artifact| {
        match serde_json::from_slice::<PersistedTranscriptIndex>(&artifact.bytes) {
            Ok(index) => Some(index),
            Err(error) => {
                push_corrupt_artifact(
                    inventory,
                    fingerprint,
                    relative_storage_path(storage_root, &index_path),
                    format!("Invalid transcript index: {error}"),
                );
                None
            }
        }
    });

    let Some(metadata) = metadata else {
        return;
    };
    if metadata.session_id.trim().is_empty() {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_storage_path(storage_root, &metadata_path),
            "Session metadata contains an empty session ID.",
        );
        return;
    }
    inventory.session_id_claims.push(SessionIdClaim {
        session_id: metadata.session_id.clone(),
        relative_path: relative_dir.clone(),
    });

    let (Some(index), Some(transcript_artifact_fingerprint)) =
        (index, transcript_artifact_fingerprint)
    else {
        return;
    };
    let transcript_fingerprints =
        match inspect_strict_transcript_file(&metadata, &index, &transcript_path) {
            Ok(fingerprints) => fingerprints,
            Err(StrictTranscriptInspectionError::Corrupt(error)) => {
                push_corrupt_artifact(inventory, fingerprint, relative_dir, error);
                return;
            }
            Err(StrictTranscriptInspectionError::Read(error)) => {
                push_read_error(
                    inventory,
                    fingerprint,
                    relative_storage_path(storage_root, &transcript_path),
                    error.to_string(),
                );
                return;
            }
        };
    if transcript_fingerprints.artifact != transcript_artifact_fingerprint {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_dir,
            "Transcript changed while it was being inspected.",
        );
        return;
    }
    let (Some(metadata_artifact), Some(index_artifact)) =
        (metadata_bytes.as_ref(), index_bytes.as_ref())
    else {
        return;
    };
    inventory.sessions.push(InspectedHistory {
        session_id: metadata.session_id,
        relative_path: relative_dir,
        format: InspectedHistoryFormat::Directory,
        content_fingerprint: transcript_fingerprints.content,
        artifact_fingerprint: combined_artifact_fingerprint(&[
            metadata_artifact.fingerprint,
            index_artifact.fingerprint,
            transcript_fingerprints.artifact,
        ]),
    });
}

fn inspect_legacy_json_history(
    storage_root: &Path,
    path: &Path,
    inventory: &mut HistoryStorageInventory,
    fingerprint: &mut InventoryFingerprintBuilder,
) {
    let relative_path = relative_storage_path(storage_root, path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            push_read_error(inventory, fingerprint, relative_path, error.to_string());
            return;
        }
    };
    if !metadata.file_type().is_file() {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_path,
            "Legacy session history is not a regular file.",
        );
        return;
    }
    let artifact_fingerprint = match raw_file_fingerprint(path) {
        Ok(artifact_fingerprint) => {
            fingerprint.add_digest("file", &relative_path, &artifact_fingerprint);
            artifact_fingerprint
        }
        Err(error) => {
            push_read_error(inventory, fingerprint, relative_path, error.to_string());
            return;
        }
    };
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            push_read_error(inventory, fingerprint, relative_path, error.to_string());
            return;
        }
    };
    let history = match serde_json::from_reader::<_, PersistedSessionHistory>(BufReader::new(file))
    {
        Ok(history) => history,
        Err(error) => {
            push_corrupt_artifact(
                inventory,
                fingerprint,
                relative_path,
                format!("Invalid legacy session history: {error}"),
            );
            return;
        }
    };
    if history.session_id.trim().is_empty() {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_path,
            "Legacy session history contains an empty session ID.",
        );
        return;
    }
    inventory.session_id_claims.push(SessionIdClaim {
        session_id: history.session_id.clone(),
        relative_path: relative_path.clone(),
    });
    if history.version != FORMAT_VERSION {
        push_corrupt_artifact(
            inventory,
            fingerprint,
            relative_path,
            format!("Unsupported legacy session version: {}.", history.version),
        );
        return;
    }

    let history = normalize_legacy_history(history);
    let content_fingerprint = match persisted_history_content_fingerprint(&history) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            push_corrupt_artifact(
                inventory,
                fingerprint,
                relative_path,
                format!("Could not fingerprint legacy session content: {error}"),
            );
            return;
        }
    };
    inventory.sessions.push(InspectedHistory {
        session_id: history.session_id,
        relative_path,
        format: InspectedHistoryFormat::LegacyJson,
        content_fingerprint,
        artifact_fingerprint: digest_hex(&artifact_fingerprint),
    });
}

fn finish_storage_inventory(
    mut histories: HistoryStorageInventory,
    fingerprint: InventoryFingerprintBuilder,
) -> StorageInventory {
    histories.sessions.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    histories.session_id_claims.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    histories.corrupt_artifacts.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.error.cmp(&right.error))
    });
    histories.unknown_entries.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.entry_type.cmp(&right.entry_type))
    });
    histories.read_errors.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.error.cmp(&right.error))
    });
    histories.recoverable_states.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.state_type.cmp(&right.state_type))
    });

    let mut artifacts_by_session = BTreeMap::<String, Vec<String>>::new();
    for claim in &histories.session_id_claims {
        artifacts_by_session
            .entry(claim.session_id.clone())
            .or_default()
            .push(claim.relative_path.clone());
    }
    histories.duplicate_session_ids = artifacts_by_session
        .into_iter()
        .filter_map(|(session_id, mut artifacts)| {
            if artifacts.len() < 2 {
                return None;
            }
            artifacts.sort();
            Some(DuplicateSessionId {
                session_id,
                artifacts,
            })
        })
        .collect();

    StorageInventory {
        fingerprint: fingerprint.finish(),
        histories,
    }
}

/// Inspects every history artifact without applying loader recovery or skipping failures.
///
/// The regular loaders intentionally remain tolerant for existing users. Destructive storage
/// decisions must use this inventory instead: an unreadable or unknown artifact is represented
/// explicitly and therefore cannot be mistaken for an empty root.
pub fn inspect_history_storage(storage_root: &Path) -> StorageInventory {
    let mut histories = HistoryStorageInventory::default();
    let mut fingerprint = InventoryFingerprintBuilder::default();
    let storage_metadata = match fs::symlink_metadata(storage_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fingerprint.add("storage-root", "", b"missing");
            return finish_storage_inventory(histories, fingerprint);
        }
        Err(error) => {
            fingerprint.add("storage-root", "", b"unreadable");
            push_read_error(
                &mut histories,
                &mut fingerprint,
                ".".to_string(),
                error.to_string(),
            );
            return finish_storage_inventory(histories, fingerprint);
        }
    };
    histories.storage_root_exists = true;
    fingerprint.add("storage-root", "", b"present");
    if !storage_metadata.file_type().is_dir() {
        push_corrupt_artifact(
            &mut histories,
            &mut fingerprint,
            ".".to_string(),
            "History storage root is not a regular directory.",
        );
        return finish_storage_inventory(histories, fingerprint);
    }

    let sessions_root = sessions_dir(storage_root);
    let root_entries = match fs::read_dir(storage_root) {
        Ok(entries) => entries,
        Err(error) => {
            push_read_error(
                &mut histories,
                &mut fingerprint,
                ".".to_string(),
                error.to_string(),
            );
            return finish_storage_inventory(histories, fingerprint);
        }
    };
    for entry in root_entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                push_read_error(
                    &mut histories,
                    &mut fingerprint,
                    "<unreadable-entry>".to_string(),
                    error.to_string(),
                );
                continue;
            }
        };
        let path = entry.path();
        if path == sessions_root {
            continue;
        }
        let relative_path = relative_storage_path(storage_root, &path);
        let entry_type = fs::symlink_metadata(&path)
            .map(|metadata| {
                let file_type = metadata.file_type();
                if file_type.is_symlink() {
                    "symlink"
                } else if file_type.is_dir() {
                    "directory"
                } else if file_type.is_file() {
                    "file"
                } else {
                    "special"
                }
            })
            .unwrap_or("unreadable");
        push_unknown_entry(&mut histories, &mut fingerprint, relative_path, entry_type);
        fingerprint_unknown_tree(storage_root, &path, &mut histories, &mut fingerprint);
    }

    let sessions_metadata = match fs::symlink_metadata(&sessions_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fingerprint.add("sessions-root", "sessions", b"missing");
            return finish_storage_inventory(histories, fingerprint);
        }
        Err(error) => {
            push_read_error(
                &mut histories,
                &mut fingerprint,
                "sessions".to_string(),
                error.to_string(),
            );
            return finish_storage_inventory(histories, fingerprint);
        }
    };
    if !sessions_metadata.file_type().is_dir() {
        push_corrupt_artifact(
            &mut histories,
            &mut fingerprint,
            "sessions".to_string(),
            "History sessions root is not a regular directory.",
        );
        return finish_storage_inventory(histories, fingerprint);
    }
    histories.sessions_root_exists = true;
    fingerprint.add("sessions-root", "sessions", b"present");

    let entries = match fs::read_dir(&sessions_root) {
        Ok(entries) => entries,
        Err(error) => {
            push_read_error(
                &mut histories,
                &mut fingerprint,
                "sessions".to_string(),
                error.to_string(),
            );
            return finish_storage_inventory(histories, fingerprint);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                push_read_error(
                    &mut histories,
                    &mut fingerprint,
                    "sessions/<unreadable-entry>".to_string(),
                    error.to_string(),
                );
                continue;
            }
        };
        let path = entry.path();
        let relative_path = relative_storage_path(storage_root, &path);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                push_read_error(
                    &mut histories,
                    &mut fingerprint,
                    relative_path,
                    error.to_string(),
                );
                continue;
            }
        };
        let file_type = metadata.file_type();
        if file_type.is_dir() {
            inspect_session_directory(storage_root, &path, &mut histories, &mut fingerprint);
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        {
            inspect_legacy_json_history(storage_root, &path, &mut histories, &mut fingerprint);
        } else {
            let entry_type = if file_type.is_symlink() {
                "symlink"
            } else if file_type.is_file() {
                "file"
            } else {
                "special"
            };
            push_unknown_entry(&mut histories, &mut fingerprint, relative_path, entry_type);
            fingerprint_unknown_tree(storage_root, &path, &mut histories, &mut fingerprint);
        }
    }

    finish_storage_inventory(histories, fingerprint)
}

fn history_window_bounds(history: &PersistedSessionHistory) -> Result<(usize, usize), String> {
    let start_index = history.start_index.unwrap_or_else(|| {
        history
            .message_count
            .map(|count| count.saturating_sub(history.messages.len()))
            .unwrap_or(0)
    });
    let total_count = history
        .message_count
        .unwrap_or(start_index + history.messages.len());

    if start_index > total_count {
        return Err("Persisted history window is invalid.".to_string());
    }

    if start_index + history.messages.len() != total_count {
        return Err(
            "Persisted history windows must currently describe a suffix of the transcript."
                .to_string(),
        );
    }

    Ok((start_index, total_count))
}

fn metadata_from_history(
    history: &PersistedSessionHistory,
    total_count: usize,
) -> PersistedSessionMetadata {
    PersistedSessionMetadata {
        version: history.version,
        session_id: history.session_id.clone(),
        parent_session_id: history.parent_session_id.clone(),
        closed_at: history.closed_at.clone(),
        runtime_id: history.runtime_id.clone(),
        model_id: history.model_id.clone(),
        mode_id: history.mode_id.clone(),
        models: history.models.clone(),
        modes: history.modes.clone(),
        config_options: history.config_options.clone(),
        additional_roots: history.additional_roots.clone(),
        created_at: history.created_at,
        updated_at: history.updated_at,
        message_count: total_count,
        title: history
            .title
            .clone()
            .or_else(|| derive_title(&history.messages)),
        custom_title: history.custom_title.clone(),
        preview: history
            .preview
            .clone()
            .or_else(|| derive_preview(&history.messages)),
        forked_from: None,
    }
}

fn history_from_metadata(
    metadata: PersistedSessionMetadata,
    messages: Vec<PersistedMessage>,
) -> PersistedSessionHistory {
    PersistedSessionHistory {
        version: metadata.version,
        session_id: metadata.session_id,
        parent_session_id: metadata.parent_session_id,
        closed_at: metadata.closed_at,
        runtime_id: metadata.runtime_id,
        model_id: metadata.model_id,
        mode_id: metadata.mode_id,
        models: metadata.models,
        modes: metadata.modes,
        config_options: metadata.config_options,
        additional_roots: metadata.additional_roots,
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
        start_index: Some(0),
        message_count: Some(metadata.message_count),
        title: metadata.title,
        custom_title: metadata.custom_title,
        preview: metadata.preview,
        messages,
    }
}

fn load_legacy_history_file(path: &Path) -> Result<PersistedSessionHistory, String> {
    let history = read_json_file::<PersistedSessionHistory>(path)?;
    Ok(normalize_legacy_history(history))
}

fn normalize_legacy_history(history: PersistedSessionHistory) -> PersistedSessionHistory {
    PersistedSessionHistory {
        version: history.version,
        session_id: history.session_id,
        parent_session_id: history.parent_session_id,
        closed_at: history.closed_at,
        runtime_id: history.runtime_id,
        model_id: history.model_id,
        mode_id: history.mode_id,
        models: history.models,
        modes: history.modes,
        config_options: history.config_options,
        additional_roots: history.additional_roots,
        created_at: history.created_at,
        updated_at: history.updated_at,
        start_index: Some(0),
        message_count: Some(history.messages.len()),
        title: history.title.or_else(|| derive_title(&history.messages)),
        custom_title: history.custom_title,
        preview: history
            .preview
            .or_else(|| derive_preview(&history.messages)),
        messages: history.messages,
    }
}

fn load_history_from_session_dir(
    session_dir: &Path,
    include_messages: bool,
) -> Result<PersistedSessionHistory, String> {
    let metadata = load_session_metadata_from_dir(session_dir)?;
    let messages = if include_messages {
        load_all_lazy_messages_from_dir(session_dir)?
    } else {
        vec![]
    };
    Ok(history_from_metadata(metadata, messages))
}

fn legacy_session_priority(storage_root: &Path, path: &Path, session_id: &str) -> u8 {
    if path == storage_session_dir(storage_root, session_id) {
        3
    } else if path.is_dir() {
        2
    } else {
        1
    }
}

fn find_legacy_session_artifacts(
    storage_root: &Path,
    session_id: &str,
) -> Result<LegacySessionArtifacts, String> {
    let dir = sessions_dir(storage_root);
    if !dir.exists() {
        return Ok(LegacySessionArtifacts::default());
    }

    let storage_dir = storage_session_dir(storage_root, session_id);
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut artifacts = LegacySessionArtifacts::default();

    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let path = entry.path();
        if path == storage_dir {
            continue;
        }

        if path.is_dir() {
            let metadata = match load_session_metadata_from_dir(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if metadata.session_id == session_id {
                artifacts.dir_path = Some(path);
            }
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let history = match load_legacy_history_file(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if history.session_id == session_id {
            artifacts.file_path = Some(path);
        }
    }

    Ok(artifacts)
}

fn load_legacy_history(
    storage_root: &Path,
    session_id: &str,
) -> Result<Option<PersistedSessionHistory>, String> {
    let artifacts = find_legacy_session_artifacts(storage_root, session_id)?;
    if let Some(dir_path) = artifacts.dir_path {
        return load_history_from_session_dir(&dir_path, true).map(Some);
    }
    if let Some(file_path) = artifacts.file_path {
        return load_legacy_history_file(&file_path).map(Some);
    }
    Ok(None)
}

fn remove_legacy_history_artifacts(storage_root: &Path, session_id: &str) -> Result<(), String> {
    let artifacts = find_legacy_session_artifacts(storage_root, session_id)?;
    if let Some(file_path) = artifacts.file_path {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    if let Some(dir_path) = artifacts.dir_path {
        fs::remove_dir_all(dir_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_full_lazy_history(
    storage_root: &Path,
    history: &PersistedSessionHistory,
) -> Result<(), String> {
    let (start_index, total_count) = history_window_bounds(history)?;
    if start_index != 0 || total_count != history.messages.len() {
        return Err("Full lazy history writes require a complete transcript.".to_string());
    }

    ensure_sessions_root(storage_root)?;
    let session_dir = storage_session_dir(storage_root, &history.session_id);
    fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;

    let transcript_path = session_transcript_path(&session_dir);
    let transcript_tmp = transcript_path.with_extension("jsonl.tmp");
    let mut transcript_file = File::create(&transcript_tmp).map_err(|e| e.to_string())?;

    let mut offsets = Vec::with_capacity(history.messages.len());
    let mut lengths = Vec::with_capacity(history.messages.len());
    let mut hashes = Vec::with_capacity(history.messages.len());
    let mut cursor = 0_u64;

    for message in &history.messages {
        let bytes = serialize_message_bytes(message)?;
        let hash = hash_message(message)?;
        transcript_file
            .write_all(&bytes)
            .map_err(|e| e.to_string())?;
        offsets.push(cursor);
        lengths.push(bytes.len() as u64);
        hashes.push(hash);
        cursor += bytes.len() as u64;
    }

    transcript_file.flush().map_err(|e| e.to_string())?;
    fs::rename(&transcript_tmp, &transcript_path).map_err(|e| e.to_string())?;

    let metadata = metadata_from_history(history, total_count);
    let index = PersistedTranscriptIndex {
        version: FORMAT_VERSION,
        message_offsets: offsets,
        message_lengths: lengths,
        message_hashes: hashes,
    };

    write_json_atomic(&session_meta_path(&session_dir), &metadata)?;
    write_json_atomic(&session_index_path(&session_dir), &index)?;
    remove_legacy_history_artifacts(storage_root, &history.session_id)?;

    Ok(())
}

fn ensure_lazy_session_from_legacy(storage_root: &Path, session_id: &str) -> Result<(), String> {
    recover_incomplete_compaction(&storage_session_dir(storage_root, session_id))?;
    if storage_session_is_complete(storage_root, session_id) {
        return Ok(());
    }

    let Some(history) = load_legacy_history(storage_root, session_id)? else {
        return Ok(());
    };

    write_full_lazy_history(storage_root, &history)
}

fn load_lazy_history_page(
    storage_root: &Path,
    session_id: &str,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    let session_dir = storage_session_dir(storage_root, session_id);
    load_lazy_history_page_from_dir(&session_dir, start_index, limit)
}

fn load_lazy_history_page_from_dir(
    session_dir: &Path,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    let (metadata, index) = load_repaired_lazy_session_files(session_dir)?;
    read_lazy_history_page_from_files(session_dir, &metadata, &index, start_index, limit)
}

fn read_lazy_history_page_from_files(
    session_dir: &Path,
    metadata: &PersistedSessionMetadata,
    index: &PersistedTranscriptIndex,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    let total_messages = metadata.message_count;
    let start = start_index.min(total_messages);
    let end = start.saturating_add(limit).min(total_messages);

    let mut transcript =
        File::open(session_transcript_path(session_dir)).map_err(|e| e.to_string())?;
    let mut messages = Vec::with_capacity(end.saturating_sub(start));

    for idx in start..end {
        let message = read_indexed_transcript_message(
            &mut transcript,
            index.message_offsets[idx],
            index.message_lengths[idx] as usize,
        )?;
        messages.push(message);
    }

    Ok(PersistedSessionHistoryPage {
        session_id: metadata.session_id.clone(),
        total_messages,
        start_index: start,
        end_index: end,
        messages,
    })
}

fn read_indexed_transcript_message(
    transcript: &mut File,
    offset: u64,
    length: usize,
) -> Result<PersistedMessage, String> {
    let mut bytes = vec![0_u8; length];
    transcript
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    transcript
        .read_exact(&mut bytes)
        .map_err(|e| e.to_string())?;

    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }

    match serde_json::from_slice::<PersistedMessage>(&bytes) {
        Ok(message) => Ok(message),
        Err(index_error) => {
            // Some old dev builds wrote stale byte lengths while keeping valid JSONL rows.
            // Falling back to the newline boundary preserves recoverable transcripts.
            transcript
                .seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut line = Vec::new();
            let mut reader = BufReader::new(transcript);
            let read = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if read == 0 {
                return Err(format!(
                    "Persisted transcript message at offset {offset} is empty: {index_error}"
                ));
            }
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            serde_json::from_slice::<PersistedMessage>(&line).map_err(|line_error| {
                format!(
                    "Persisted transcript message at offset {offset} is invalid: {line_error}; indexed read failed with: {index_error}"
                )
            })
        }
    }
}

fn should_compact_transcript(
    physical_bytes: u64,
    indexed_bytes: u64,
    policy: TranscriptCompactionPolicy,
) -> bool {
    if physical_bytes <= indexed_bytes {
        return false;
    }

    let obsolete_bytes = physical_bytes - indexed_bytes;
    if physical_bytes >= policy.force_physical_bytes {
        return true;
    }

    if obsolete_bytes < policy.min_obsolete_bytes {
        return false;
    }

    physical_bytes >= indexed_bytes.saturating_mul(policy.max_physical_to_indexed_ratio.max(1))
}

fn compact_transcript_if_needed(
    session_dir: &Path,
    metadata: &PersistedSessionMetadata,
    index: &PersistedTranscriptIndex,
    policy: TranscriptCompactionPolicy,
) -> Result<PersistedTranscriptIndex, String> {
    validate_lazy_session_files(metadata, index)?;

    let transcript_path = session_transcript_path(session_dir);
    let physical_bytes = fs::metadata(&transcript_path)
        .map_err(|error| error.to_string())?
        .len();
    let indexed_bytes = indexed_transcript_bytes(index);

    if should_compact_transcript(physical_bytes, indexed_bytes, policy) {
        persist_compacted_lazy_history(session_dir, metadata, index)
    } else {
        Ok(index.clone())
    }
}

fn load_repaired_lazy_session_files(
    session_dir: &Path,
) -> Result<(PersistedSessionMetadata, PersistedTranscriptIndex), String> {
    recover_incomplete_compaction(session_dir)?;

    let metadata = read_json_file(&session_meta_path(session_dir))?;
    let index = read_json_file(&session_index_path(session_dir))?;
    let index = compact_transcript_if_needed(
        session_dir,
        &metadata,
        &index,
        DEFAULT_TRANSCRIPT_COMPACTION_POLICY,
    )?;
    validate_lazy_session_files(&metadata, &index)?;

    Ok((metadata, index))
}

fn unique_session_sidecar_path(path: &Path, label: &str, suffix: u128) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "AI history path has no file name.".to_string())?;
    let mut sidecar_name = file_name.to_os_string();
    sidecar_name.push(format!(".{label}.{pid}.{suffix}", pid = std::process::id()));
    Ok(path.with_file_name(sidecar_name))
}

fn session_sidecar_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| "AI history sidecar path has no valid file name.".to_string())
}

fn session_sidecar_from_marker(session_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("AI history compaction marker contains an invalid sidecar path.".to_string());
    }
    Ok(session_dir.join(path))
}

fn write_compacted_transcript_tmp(
    session_dir: &Path,
    source_index: &PersistedTranscriptIndex,
    transcript_tmp: &Path,
) -> Result<PersistedTranscriptIndex, String> {
    validate_index(source_index)?;

    let mut source =
        File::open(session_transcript_path(session_dir)).map_err(|error| error.to_string())?;
    let mut target = File::create(transcript_tmp).map_err(|error| error.to_string())?;
    let mut offsets = Vec::with_capacity(source_index.message_offsets.len());
    let mut lengths = Vec::with_capacity(source_index.message_lengths.len());
    let mut hashes = Vec::with_capacity(source_index.message_hashes.len());
    let mut cursor = 0_u64;

    for idx in 0..source_index.message_offsets.len() {
        let message = read_indexed_transcript_message(
            &mut source,
            source_index.message_offsets[idx],
            source_index.message_lengths[idx] as usize,
        )?;
        let bytes = serialize_message_bytes(&message)?;
        let hash = hash_message(&message)?;

        target
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        offsets.push(cursor);
        lengths.push(bytes.len() as u64);
        hashes.push(hash);
        cursor += bytes.len() as u64;
    }

    target.flush().map_err(|error| error.to_string())?;

    Ok(PersistedTranscriptIndex {
        version: FORMAT_VERSION,
        message_offsets: offsets,
        message_lengths: lengths,
        message_hashes: hashes,
    })
}

fn restore_session_file_backups(replacements: &[(&Path, &Path)]) {
    for (final_path, backup_path) in replacements.iter().rev() {
        if backup_path.exists() {
            let _ = fs::remove_file(final_path);
            let _ = fs::rename(backup_path, final_path);
        }
    }
}

fn cleanup_session_sidecars(paths: &[&Path]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn recover_incomplete_compaction(session_dir: &Path) -> Result<(), String> {
    let marker_path = session_compaction_marker_path(session_dir);
    if !marker_path.exists() {
        return Ok(());
    }

    let state: TranscriptCompactionState = read_json_file(&marker_path)?;
    let metadata_tmp = session_sidecar_from_marker(session_dir, &state.metadata_tmp)?;
    let index_tmp = session_sidecar_from_marker(session_dir, &state.index_tmp)?;
    let transcript_tmp = session_sidecar_from_marker(session_dir, &state.transcript_tmp)?;
    let metadata_backup = session_sidecar_from_marker(session_dir, &state.metadata_backup)?;
    let index_backup = session_sidecar_from_marker(session_dir, &state.index_backup)?;
    let transcript_backup = session_sidecar_from_marker(session_dir, &state.transcript_backup)?;
    let metadata_path = session_meta_path(session_dir);
    let index_path = session_index_path(session_dir);
    let transcript_path = session_transcript_path(session_dir);

    let backup_pairs = [
        (transcript_path.as_path(), transcript_backup.as_path()),
        (index_path.as_path(), index_backup.as_path()),
        (metadata_path.as_path(), metadata_backup.as_path()),
    ];
    restore_session_file_backups(&backup_pairs);
    cleanup_session_sidecars(&[
        &metadata_tmp,
        &index_tmp,
        &transcript_tmp,
        &metadata_backup,
        &index_backup,
        &transcript_backup,
        &marker_path,
    ]);

    Ok(())
}

fn abort_compacted_lazy_history(
    marker_path: &Path,
    backup_pairs: &[(&Path, &Path)],
    sidecars: &[&Path],
) {
    restore_session_file_backups(backup_pairs);
    cleanup_session_sidecars(sidecars);
    let _ = fs::remove_file(marker_path);
}

fn persist_compacted_lazy_history(
    session_dir: &Path,
    metadata: &PersistedSessionMetadata,
    source_index: &PersistedTranscriptIndex,
) -> Result<PersistedTranscriptIndex, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let metadata_path = session_meta_path(session_dir);
    let index_path = session_index_path(session_dir);
    let transcript_path = session_transcript_path(session_dir);
    let metadata_tmp = unique_session_sidecar_path(&metadata_path, "compact-tmp", suffix)?;
    let index_tmp = unique_session_sidecar_path(&index_path, "compact-tmp", suffix)?;
    let transcript_tmp = unique_session_sidecar_path(&transcript_path, "compact-tmp", suffix)?;
    let metadata_backup = unique_session_sidecar_path(&metadata_path, "compact-bak", suffix)?;
    let index_backup = unique_session_sidecar_path(&index_path, "compact-bak", suffix)?;
    let transcript_backup = unique_session_sidecar_path(&transcript_path, "compact-bak", suffix)?;
    let marker_path = session_compaction_marker_path(session_dir);

    let compacted_index =
        match write_compacted_transcript_tmp(session_dir, source_index, &transcript_tmp) {
            Ok(index) => index,
            Err(error) => {
                cleanup_session_sidecars(&[&metadata_tmp, &index_tmp, &transcript_tmp]);
                return Err(error);
            }
        };
    if let Err(error) = write_json_file(&index_tmp, &compacted_index) {
        cleanup_session_sidecars(&[&metadata_tmp, &index_tmp, &transcript_tmp]);
        return Err(error);
    }
    if let Err(error) = write_json_file(&metadata_tmp, metadata) {
        cleanup_session_sidecars(&[&metadata_tmp, &index_tmp, &transcript_tmp]);
        return Err(error);
    }

    let backup_pairs = [
        (transcript_path.as_path(), transcript_backup.as_path()),
        (index_path.as_path(), index_backup.as_path()),
        (metadata_path.as_path(), metadata_backup.as_path()),
    ];
    let sidecars = [
        metadata_tmp.as_path(),
        index_tmp.as_path(),
        transcript_tmp.as_path(),
        metadata_backup.as_path(),
        index_backup.as_path(),
        transcript_backup.as_path(),
    ];
    let marker = TranscriptCompactionState {
        version: FORMAT_VERSION,
        metadata_tmp: session_sidecar_file_name(&metadata_tmp)?,
        index_tmp: session_sidecar_file_name(&index_tmp)?,
        transcript_tmp: session_sidecar_file_name(&transcript_tmp)?,
        metadata_backup: session_sidecar_file_name(&metadata_backup)?,
        index_backup: session_sidecar_file_name(&index_backup)?,
        transcript_backup: session_sidecar_file_name(&transcript_backup)?,
    };
    write_json_atomic(&marker_path, &marker)?;

    // The marker lets the next load/save roll back if the app exits between
    // these renames. Without it, a crash could leave index offsets and the
    // transcript file from different generations.
    if let Err(error) = fs::rename(&transcript_path, &transcript_backup) {
        abort_compacted_lazy_history(&marker_path, &[], &sidecars);
        return Err(error.to_string());
    }
    if let Err(error) = fs::rename(&index_path, &index_backup) {
        abort_compacted_lazy_history(&marker_path, &backup_pairs[..1], &sidecars);
        return Err(error.to_string());
    }
    if let Err(error) = fs::rename(&metadata_path, &metadata_backup) {
        abort_compacted_lazy_history(&marker_path, &backup_pairs[..2], &sidecars);
        return Err(error.to_string());
    }

    if let Err(error) = fs::rename(&transcript_tmp, &transcript_path) {
        abort_compacted_lazy_history(&marker_path, &backup_pairs, &sidecars);
        return Err(error.to_string());
    }
    if let Err(error) = fs::rename(&index_tmp, &index_path) {
        abort_compacted_lazy_history(&marker_path, &backup_pairs, &sidecars);
        return Err(error.to_string());
    }
    if let Err(error) = fs::rename(&metadata_tmp, &metadata_path) {
        abort_compacted_lazy_history(&marker_path, &backup_pairs, &sidecars);
        return Err(error.to_string());
    }

    let _ = fs::remove_file(&marker_path);
    cleanup_session_sidecars(&[&metadata_backup, &index_backup, &transcript_backup]);

    Ok(compacted_index)
}

fn load_all_lazy_messages_from_dir(session_dir: &Path) -> Result<Vec<PersistedMessage>, String> {
    let (metadata, index) = load_repaired_lazy_session_files(session_dir)?;
    if metadata.message_count == 0 {
        return Ok(vec![]);
    }

    Ok(read_lazy_history_page_from_files(
        session_dir,
        &metadata,
        &index,
        0,
        metadata.message_count,
    )?
    .messages)
}

pub fn save_session_history(
    storage_root: &Path,
    history: &PersistedSessionHistory,
) -> Result<(), String> {
    save_session_history_with_compaction_policy(
        storage_root,
        history,
        DEFAULT_TRANSCRIPT_COMPACTION_POLICY,
    )
}

fn save_session_history_with_compaction_policy(
    storage_root: &Path,
    history: &PersistedSessionHistory,
    compaction_policy: TranscriptCompactionPolicy,
) -> Result<(), String> {
    ensure_lazy_session_from_legacy(storage_root, &history.session_id)?;
    let (start_index, total_count) = history_window_bounds(history)?;

    let metadata_path = storage_session_meta_file(storage_root, &history.session_id);
    let index_path = storage_session_index_file(storage_root, &history.session_id);
    if !metadata_path.exists() || !index_path.exists() {
        if start_index != 0 || total_count != history.messages.len() {
            return Err(
                "Cannot persist a partial transcript window before the base transcript exists."
                    .to_string(),
            );
        }
        return write_full_lazy_history(storage_root, history);
    }

    let existing_metadata = load_session_metadata(storage_root, &history.session_id)?;
    let existing_index = load_session_index(storage_root, &history.session_id)?;
    validate_index(&existing_index)?;

    if start_index > existing_metadata.message_count {
        return Err("Transcript patch starts beyond the stored history.".to_string());
    }

    let mut next_offsets = existing_index.message_offsets[..start_index].to_vec();
    let mut next_lengths = existing_index.message_lengths[..start_index].to_vec();
    let mut next_hashes = existing_index.message_hashes[..start_index].to_vec();
    let window_hashes = history
        .messages
        .iter()
        .map(hash_message)
        .collect::<Result<Vec<_>, _>>()?;

    let existing_suffix_len = existing_metadata.message_count.saturating_sub(start_index);
    let comparable = existing_suffix_len.min(history.messages.len());
    let mut common = 0_usize;
    while common < comparable
        && existing_index.message_hashes[start_index + common] == window_hashes[common]
    {
        common += 1;
    }

    next_offsets
        .extend_from_slice(&existing_index.message_offsets[start_index..start_index + common]);
    next_lengths
        .extend_from_slice(&existing_index.message_lengths[start_index..start_index + common]);
    next_hashes
        .extend_from_slice(&existing_index.message_hashes[start_index..start_index + common]);

    if common < history.messages.len() {
        let transcript_path = storage_session_transcript_file(storage_root, &history.session_id);
        let mut transcript = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&transcript_path)
            .map_err(|e| e.to_string())?;
        let mut cursor = transcript.metadata().map_err(|e| e.to_string())?.len();

        for (message, hash) in history
            .messages
            .iter()
            .zip(window_hashes.iter())
            .skip(common)
        {
            let bytes = serialize_message_bytes(message)?;
            transcript.write_all(&bytes).map_err(|e| e.to_string())?;
            next_offsets.push(cursor);
            next_lengths.push(bytes.len() as u64);
            next_hashes.push(hash.clone());
            cursor += bytes.len() as u64;
        }

        transcript.flush().map_err(|e| e.to_string())?;
    }

    if next_offsets.len() != total_count
        || next_lengths.len() != total_count
        || next_hashes.len() != total_count
    {
        return Err("Persisted transcript patch produced an invalid index.".to_string());
    }

    let next_metadata = metadata_from_history(history, total_count);
    let next_index = PersistedTranscriptIndex {
        version: FORMAT_VERSION,
        message_offsets: next_offsets,
        message_lengths: next_lengths,
        message_hashes: next_hashes,
    };

    let session_dir = storage_session_dir(storage_root, &history.session_id);
    let transcript_path = session_transcript_path(&session_dir);
    let physical_bytes = fs::metadata(&transcript_path)
        .map_err(|error| error.to_string())?
        .len();
    let indexed_bytes = indexed_transcript_bytes(&next_index);

    if should_compact_transcript(physical_bytes, indexed_bytes, compaction_policy) {
        persist_compacted_lazy_history(&session_dir, &next_metadata, &next_index)?;
    } else {
        write_json_atomic(&metadata_path, &next_metadata)?;
        write_json_atomic(&index_path, &next_index)?;
    }

    remove_legacy_history_artifacts(storage_root, &history.session_id)?;

    Ok(())
}

pub fn load_session_history_page(
    storage_root: &Path,
    session_id: &str,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    ensure_lazy_session_from_legacy(storage_root, session_id)?;

    if storage_session_is_complete(storage_root, session_id) {
        return load_lazy_history_page(storage_root, session_id, start_index, limit);
    }

    let Some(history) = load_legacy_history(storage_root, session_id)? else {
        return Ok(PersistedSessionHistoryPage {
            session_id: session_id.to_string(),
            total_messages: 0,
            start_index: 0,
            end_index: 0,
            messages: vec![],
        });
    };

    let total_messages = history.messages.len();
    let start = start_index.min(total_messages);
    let end = start.saturating_add(limit).min(total_messages);

    Ok(PersistedSessionHistoryPage {
        session_id: history.session_id,
        total_messages,
        start_index: start,
        end_index: end,
        messages: history.messages[start..end].to_vec(),
    })
}

pub fn delete_session_history(storage_root: &Path, session_id: &str) -> Result<(), String> {
    let dir = storage_session_dir(storage_root, session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    remove_legacy_history_artifacts(storage_root, session_id)?;

    Ok(())
}

pub fn delete_all_session_histories(storage_root: &Path) -> Result<(), String> {
    let dir = sessions_dir(storage_root);
    if !dir.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

fn now_ms() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(duration.as_millis() as u64)
}

pub fn prune_expired_session_histories(
    storage_root: &Path,
    max_age_days: u32,
) -> Result<usize, String> {
    if max_age_days == 0 {
        return Ok(0);
    }

    let dir = sessions_dir(storage_root);
    if !dir.exists() {
        return Ok(0);
    }

    let max_age_ms = u64::from(max_age_days) * 24 * 60 * 60 * 1000;
    let cutoff_ms = now_ms()?.saturating_sub(max_age_ms);
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut deleted = 0;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if path.is_dir() {
            let metadata = match load_session_metadata_from_dir(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };

            if metadata.updated_at < cutoff_ms && fs::remove_dir_all(&path).is_ok() {
                deleted += 1;
            }
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let history = match serde_json::from_str::<PersistedSessionHistory>(&raw) {
            Ok(history) => history,
            Err(_) => continue,
        };

        if history.updated_at >= cutoff_ms {
            continue;
        }

        if fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }

    Ok(deleted)
}

pub fn load_all_session_histories(
    storage_root: &Path,
    include_messages: bool,
) -> Result<Vec<PersistedSessionHistory>, String> {
    let dir = sessions_dir(storage_root);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut histories_by_session_id: HashMap<String, (u8, PersistedSessionHistory)> =
        HashMap::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if path.is_dir() {
            let history = match load_history_from_session_dir(&path, include_messages) {
                Ok(history) => history,
                Err(_) => continue,
            };
            let priority = legacy_session_priority(storage_root, &path, &history.session_id);
            upsert_history(
                &mut histories_by_session_id,
                history.session_id.clone(),
                priority,
                history,
            );
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let history = match load_legacy_history_file(&path) {
            Ok(history) => history,
            Err(_) => continue,
        };

        if include_messages {
            upsert_history(
                &mut histories_by_session_id,
                history.session_id.clone(),
                1,
                PersistedSessionHistory {
                    version: history.version,
                    session_id: history.session_id,
                    parent_session_id: history.parent_session_id,
                    closed_at: history.closed_at,
                    runtime_id: history.runtime_id,
                    model_id: history.model_id,
                    mode_id: history.mode_id,
                    models: history.models,
                    modes: history.modes,
                    config_options: history.config_options,
                    additional_roots: history.additional_roots,
                    created_at: history.created_at,
                    updated_at: history.updated_at,
                    start_index: Some(0),
                    message_count: Some(history.messages.len()),
                    title: history.title.or_else(|| derive_title(&history.messages)),
                    custom_title: history.custom_title,
                    preview: history
                        .preview
                        .or_else(|| derive_preview(&history.messages)),
                    messages: history.messages,
                },
            );
        } else {
            let message_count = history.messages.len();
            upsert_history(
                &mut histories_by_session_id,
                history.session_id.clone(),
                1,
                PersistedSessionHistory {
                    version: history.version,
                    session_id: history.session_id,
                    parent_session_id: history.parent_session_id,
                    closed_at: history.closed_at,
                    runtime_id: history.runtime_id,
                    model_id: history.model_id,
                    mode_id: history.mode_id,
                    models: history.models,
                    modes: history.modes,
                    config_options: history.config_options,
                    additional_roots: history.additional_roots,
                    created_at: history.created_at,
                    updated_at: history.updated_at,
                    start_index: Some(0),
                    message_count: Some(message_count),
                    title: history.title.or_else(|| derive_title(&history.messages)),
                    custom_title: history.custom_title,
                    preview: history
                        .preview
                        .or_else(|| derive_preview(&history.messages)),
                    messages: vec![],
                },
            );
        }
    }

    let mut histories = histories_by_session_id
        .into_values()
        .map(|(_, history)| history)
        .collect::<Vec<_>>();
    histories.sort_by_key(|history| std::cmp::Reverse(history.updated_at));
    Ok(histories)
}

fn upsert_history(
    histories_by_session_id: &mut HashMap<String, (u8, PersistedSessionHistory)>,
    session_id: String,
    priority: u8,
    history: PersistedSessionHistory,
) {
    match histories_by_session_id.get(&session_id) {
        Some((existing_priority, existing_history))
            if *existing_priority > priority
                || (*existing_priority == priority
                    && existing_history.updated_at >= history.updated_at) => {}
        _ => {
            histories_by_session_id.insert(session_id, (priority, history));
        }
    }
}

// ---------------------------------------------------------------------------
// Content search
// ---------------------------------------------------------------------------

const MAX_MATCHED_MESSAGES_PER_SESSION: usize = 5;
const SNIPPET_CONTEXT_CHARS: usize = 50;

pub fn search_session_content(
    storage_root: &Path,
    query: &str,
) -> Result<Vec<SessionSearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let query_lower = query.to_lowercase();
    let dir = sessions_dir(storage_root);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut results: Vec<SessionSearchResult> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();

        if path.is_dir() {
            if let Ok(result) = search_in_session_dir(&path, &query_lower) {
                if !result.matched_messages.is_empty() {
                    results.push(result);
                }
            }
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            if let Ok(result) = search_in_legacy_file(&path, &query_lower) {
                if !result.matched_messages.is_empty() {
                    results.push(result);
                }
            }
        }
    }

    results.sort_by_key(|result| std::cmp::Reverse(result.updated_at));
    Ok(results)
}

fn search_in_session_dir(
    session_dir: &Path,
    query_lower: &str,
) -> Result<SessionSearchResult, String> {
    let metadata = load_session_metadata_from_dir(session_dir)?;
    let transcript_path = session_transcript_path(session_dir);

    let mut matched = Vec::new();

    if transcript_path.exists() {
        let file = File::open(&transcript_path).map_err(|e| e.to_string())?;
        let reader = std::io::BufReader::new(file);

        for line_result in reader.lines() {
            let line = match line_result {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }
            // Quick byte-level pre-filter before deserializing
            if !line.to_lowercase().contains(query_lower) {
                continue;
            }
            if let Ok(msg) = serde_json::from_str::<PersistedMessage>(&line) {
                if msg.content.to_lowercase().contains(query_lower) {
                    matched.push(MatchedMessage {
                        message_id: msg.id,
                        role: msg.role,
                        content_snippet: extract_snippet(&msg.content, query_lower),
                    });
                    if matched.len() >= MAX_MATCHED_MESSAGES_PER_SESSION {
                        break;
                    }
                }
            }
        }
    }

    Ok(SessionSearchResult {
        session_id: metadata.session_id,
        title: metadata.title,
        custom_title: metadata.custom_title,
        updated_at: metadata.updated_at,
        matched_messages: matched,
    })
}

fn search_in_legacy_file(path: &Path, query_lower: &str) -> Result<SessionSearchResult, String> {
    let history: PersistedSessionHistory = read_json_file(path)?;
    let mut matched = Vec::new();

    for msg in &history.messages {
        if msg.content.to_lowercase().contains(query_lower) {
            matched.push(MatchedMessage {
                message_id: msg.id.clone(),
                role: msg.role.clone(),
                content_snippet: extract_snippet(&msg.content, query_lower),
            });
            if matched.len() >= MAX_MATCHED_MESSAGES_PER_SESSION {
                break;
            }
        }
    }

    Ok(SessionSearchResult {
        session_id: history.session_id,
        title: history.title,
        custom_title: history.custom_title,
        updated_at: history.updated_at,
        matched_messages: matched,
    })
}

// ---------------------------------------------------------------------------
// Session fork
// ---------------------------------------------------------------------------

pub fn fork_session_history(
    storage_root: &Path,
    source_session_id: &str,
) -> Result<String, String> {
    ensure_lazy_session_from_legacy(storage_root, source_session_id)?;

    let source_dir = storage_session_dir(storage_root, source_session_id);
    if !source_dir.exists() {
        return Err(format!("Source session not found: {source_session_id}"));
    }

    let source_meta = load_session_metadata_from_dir(&source_dir)?;

    let new_session_id = uuid::Uuid::new_v4().to_string();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    ensure_sessions_root(storage_root)?;
    let dest_dir = storage_session_dir(storage_root, &new_session_id);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    // Copy transcript and index as-is
    let src_transcript = session_transcript_path(&source_dir);
    let src_index = session_index_path(&source_dir);
    if src_transcript.exists() {
        fs::copy(&src_transcript, session_transcript_path(&dest_dir)).map_err(|e| e.to_string())?;
    }
    if src_index.exists() {
        fs::copy(&src_index, session_index_path(&dest_dir)).map_err(|e| e.to_string())?;
    }

    // Write new metadata with fresh ID and timestamps
    let forked_title = source_meta
        .custom_title
        .or(source_meta.title)
        .map(|t| format!("{t} (fork)"));

    let new_metadata = PersistedSessionMetadata {
        version: source_meta.version,
        session_id: new_session_id.clone(),
        parent_session_id: None,
        closed_at: None,
        runtime_id: source_meta.runtime_id,
        model_id: source_meta.model_id,
        mode_id: source_meta.mode_id,
        models: source_meta.models,
        modes: source_meta.modes,
        config_options: source_meta.config_options,
        additional_roots: source_meta.additional_roots,
        created_at: now_ms,
        updated_at: now_ms,
        message_count: source_meta.message_count,
        title: forked_title,
        custom_title: None,
        preview: source_meta.preview,
        forked_from: Some(source_session_id.to_string()),
    };

    write_json_atomic(&session_meta_path(&dest_dir), &new_metadata)?;

    Ok(new_session_id)
}

fn extract_snippet(content: &str, query_lower: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    let content_lower = content.to_lowercase();
    let query_char_len = query_lower.chars().count();

    let match_char_idx = if let Some(byte_pos) = content_lower.find(query_lower) {
        content_lower[..byte_pos].chars().count()
    } else {
        let end = chars.len().min(SNIPPET_CONTEXT_CHARS * 2);
        let result: String = chars[..end].iter().collect();
        return if end < chars.len() {
            format!("{result}…")
        } else {
            result
        };
    };

    let start = match_char_idx.saturating_sub(SNIPPET_CONTEXT_CHARS);
    let end = (match_char_idx + query_char_len + SNIPPET_CONTEXT_CHARS).min(chars.len());

    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(&chars[start..end]);
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_temp_dir() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let unique = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "neverwrite-history-test-{}-{suffix}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn sample_history() -> PersistedSessionHistory {
        PersistedSessionHistory {
            version: 1,
            session_id: "session-1".to_string(),
            parent_session_id: None,
            closed_at: None,
            runtime_id: Some("codex-acp".to_string()),
            model_id: "test-model".to_string(),
            mode_id: "default".to_string(),
            models: None,
            modes: None,
            config_options: None,
            additional_roots: vec![],
            created_at: 10,
            updated_at: 20,
            start_index: Some(0),
            message_count: Some(2),
            title: Some("Hello".to_string()),
            custom_title: None,
            preview: Some("Assistant reply".to_string()),
            messages: vec![
                PersistedMessage {
                    id: "user:1".to_string(),
                    role: "user".to_string(),
                    kind: "text".to_string(),
                    content: "Hello".to_string(),
                    timestamp: 10,
                    attachments: Some(serde_json::json!([
                        {
                            "id": "attachment:image",
                            "type": "file",
                            "noteId": null,
                            "label": "Screenshot 10:32",
                            "path": null,
                            "filePath": "/vault/assets/chat/screenshot.png",
                            "mimeType": "image/png"
                        }
                    ])),
                    title: None,
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    review_diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    url_elicitation_request_id: None,
                    url_elicitation_id: None,
                    url_elicitation_url: None,
                    plan_entries: None,
                    plan_detail: None,
                    tool_action: None,
                },
                PersistedMessage {
                    id: "assistant:1".to_string(),
                    role: "assistant".to_string(),
                    kind: "text".to_string(),
                    content: "Assistant reply".to_string(),
                    timestamp: 20,
                    attachments: None,
                    title: None,
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    review_diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    url_elicitation_request_id: None,
                    url_elicitation_id: None,
                    url_elicitation_url: None,
                    plan_entries: None,
                    plan_detail: None,
                    tool_action: None,
                },
            ],
        }
    }

    fn sample_history_with_session_id(session_id: &str) -> PersistedSessionHistory {
        let mut history = sample_history();
        history.session_id = session_id.to_string();
        history
    }

    fn assistant_update_patch(content: String, updated_at: u64) -> PersistedSessionHistory {
        let mut message = sample_history().messages[1].clone();
        message.content = content;
        message.timestamp = updated_at;

        PersistedSessionHistory {
            version: 1,
            session_id: "session-1".to_string(),
            parent_session_id: None,
            closed_at: None,
            runtime_id: Some("codex-acp".to_string()),
            model_id: "test-model".to_string(),
            mode_id: "default".to_string(),
            models: None,
            modes: None,
            config_options: None,
            additional_roots: vec![],
            created_at: 10,
            updated_at,
            start_index: Some(1),
            message_count: Some(2),
            title: Some("Hello".to_string()),
            custom_title: None,
            preview: Some(message.content.clone()),
            messages: vec![message],
        }
    }

    fn transcript_line_count(storage_root: &Path, session_id: &str) -> usize {
        let file = File::open(storage_session_transcript_file(storage_root, session_id))
            .expect("transcript should open");
        BufReader::new(file)
            .lines()
            .collect::<Result<Vec<_>, _>>()
            .expect("transcript lines should read")
            .len()
    }

    fn disabled_compaction_policy() -> TranscriptCompactionPolicy {
        TranscriptCompactionPolicy {
            min_obsolete_bytes: u64::MAX,
            max_physical_to_indexed_ratio: u64::MAX,
            force_physical_bytes: u64::MAX,
        }
    }

    fn persist_default_compaction_candidate(storage_root: &Path) -> (usize, u64, String) {
        let history = sample_history();
        save_session_history_with_compaction_policy(
            storage_root,
            &history,
            disabled_compaction_policy(),
        )
        .expect("base history should persist");

        let mut final_content = String::new();
        for version in 0..6 {
            final_content = format!(
                "Assistant reply load repair version {version}: {}",
                "obsolete transcript bytes ".repeat(45_000)
            );
            save_session_history_with_compaction_policy(
                storage_root,
                &assistant_update_patch(final_content.clone(), 30 + version),
                disabled_compaction_policy(),
            )
            .expect("inflating update should persist");
        }

        let inflated_lines = transcript_line_count(storage_root, "session-1");
        let inflated_bytes =
            fs::metadata(storage_session_transcript_file(storage_root, "session-1"))
                .expect("inflated transcript metadata should load")
                .len();
        let index = load_session_index(storage_root, "session-1").expect("index should load");

        assert!(inflated_lines > history.messages.len());
        assert!(should_compact_transcript(
            inflated_bytes,
            indexed_transcript_bytes(&index),
            DEFAULT_TRANSCRIPT_COMPACTION_POLICY
        ));

        (inflated_lines, inflated_bytes, final_content)
    }

    #[test]
    fn default_compaction_policy_compacts_real_world_obsolete_overhead() {
        assert!(should_compact_transcript(
            6 * MB + 600 * 1024,
            MB,
            DEFAULT_TRANSCRIPT_COMPACTION_POLICY
        ));
    }

    #[test]
    fn default_compaction_policy_ignores_small_ratio_only_overhead() {
        assert!(!should_compact_transcript(
            100 * 1024,
            40 * 1024,
            DEFAULT_TRANSCRIPT_COMPACTION_POLICY
        ));
    }

    #[test]
    fn default_compaction_policy_forces_huge_transcripts_with_any_obsolete_bytes() {
        assert!(should_compact_transcript(
            64 * MB,
            64 * MB - 1,
            DEFAULT_TRANSCRIPT_COMPACTION_POLICY
        ));
    }

    #[test]
    fn session_storage_key_is_stable_and_deterministic() {
        let first = session_storage_key("session-1");
        let second = session_storage_key("session-1");
        let third = session_storage_key("session-2");

        assert_eq!(first, second);
        assert_ne!(first, third);
        assert!(first.starts_with("session-"));
    }

    #[test]
    fn strict_inspector_reports_every_artifact_the_tolerant_loader_skips() {
        let storage_root = make_temp_dir();
        let valid_history = sample_history();
        save_session_history(&storage_root, &valid_history).expect("valid history should persist");

        let duplicate_path = sessions_dir(&storage_root).join("duplicate.json");
        write_json_atomic(&duplicate_path, &valid_history).expect("duplicate should persist");
        fs::write(sessions_dir(&storage_root).join("broken.json"), b"{broken")
            .expect("broken history should persist");
        fs::write(sessions_dir(&storage_root).join("unknown.bin"), b"unknown")
            .expect("unknown entry should persist");
        fs::write(
            storage_root.join("unexpected-root.bin"),
            b"unknown root entry",
        )
        .expect("unknown root entry should persist");

        let corrupt_meta = sample_history_with_session_id("corrupt-meta");
        save_session_history(&storage_root, &corrupt_meta).expect("history should persist");
        fs::write(
            storage_session_meta_file(&storage_root, "corrupt-meta"),
            b"{broken",
        )
        .expect("metadata should be corrupted");

        let corrupt_index = sample_history_with_session_id("corrupt-index");
        save_session_history(&storage_root, &corrupt_index).expect("history should persist");
        fs::write(
            storage_session_index_file(&storage_root, "corrupt-index"),
            b"{broken",
        )
        .expect("index should be corrupted");

        let corrupt_transcript = sample_history_with_session_id("corrupt-transcript");
        save_session_history(&storage_root, &corrupt_transcript).expect("history should persist");
        fs::write(
            storage_session_transcript_file(&storage_root, "corrupt-transcript"),
            b"{broken\n",
        )
        .expect("transcript should be corrupted");

        let valid_session_dir = storage_session_dir(&storage_root, &valid_history.session_id);
        fs::write(valid_session_dir.join("unexpected.txt"), b"unexpected")
            .expect("nested unknown entry should persist");
        let corrupt_duplicate_dir = sessions_dir(&storage_root).join("corrupt-duplicate");
        fs::create_dir_all(&corrupt_duplicate_dir).expect("duplicate directory should exist");
        for file_name in [
            SESSION_META_FILE,
            SESSION_INDEX_FILE,
            SESSION_TRANSCRIPT_FILE,
        ] {
            fs::copy(
                valid_session_dir.join(file_name),
                corrupt_duplicate_dir.join(file_name),
            )
            .expect("duplicate artifact should copy");
        }
        fs::write(corrupt_duplicate_dir.join(SESSION_INDEX_FILE), b"{broken")
            .expect("duplicate index should be corrupted");

        let tolerant = load_all_session_histories(&storage_root, false)
            .expect("the normal loader should remain tolerant");
        assert!(tolerant
            .iter()
            .any(|history| history.session_id == valid_history.session_id));
        assert!(!tolerant
            .iter()
            .any(|history| history.session_id == "corrupt-meta"));

        let inventory = inspect_history_storage(&storage_root);
        assert_eq!(inventory.histories.sessions.len(), 2);
        assert_eq!(inventory.histories.duplicate_session_ids.len(), 1);
        assert_eq!(
            inventory.histories.duplicate_session_ids[0].session_id,
            valid_history.session_id
        );
        assert!(inventory.histories.duplicate_session_ids[0]
            .artifacts
            .iter()
            .any(|path| path.contains("corrupt-duplicate")));
        for expected in ["broken.json", "session-meta.json", "index.json"] {
            assert!(
                inventory
                    .histories
                    .corrupt_artifacts
                    .iter()
                    .any(|artifact| artifact.relative_path.contains(expected)),
                "missing corruption diagnostic for {expected}"
            );
        }
        assert!(inventory
            .histories
            .corrupt_artifacts
            .iter()
            .any(|artifact| artifact.error.contains("Persisted transcript")));
        for expected in ["unknown.bin", "unexpected.txt", "unexpected-root.bin"] {
            assert!(
                inventory
                    .histories
                    .unknown_entries
                    .iter()
                    .any(|entry| entry.relative_path.contains(expected)),
                "missing unknown entry diagnostic for {expected}"
            );
        }

        fs::remove_dir_all(storage_root).ok();
    }

    #[test]
    fn strict_inspector_rejects_oversized_index_ranges_before_allocating() {
        let storage_root = make_temp_dir();
        let history = sample_history();
        save_session_history(&storage_root, &history).expect("history should persist");
        let index_path = storage_session_index_file(&storage_root, &history.session_id);
        let mut index: PersistedTranscriptIndex =
            read_json_file(&index_path).expect("index should load");
        index.message_lengths[0] = u64::MAX;
        write_json_atomic(&index_path, &index).expect("corrupt index should persist");

        let inventory = inspect_history_storage(&storage_root);

        assert!(inventory.histories.sessions.is_empty());
        assert!(inventory
            .histories
            .corrupt_artifacts
            .iter()
            .any(|artifact| artifact.error.contains("points outside the transcript")));

        fs::remove_dir_all(storage_root).ok();
    }

    #[test]
    fn content_fingerprints_ignore_json_object_key_order() {
        let first_root = make_temp_dir();
        let second_root = make_temp_dir();
        ensure_sessions_root(&first_root).expect("first sessions root should exist");
        ensure_sessions_root(&second_root).expect("second sessions root should exist");
        let first = br#"{
            "version": 1,
            "session_id": "stable-session",
            "model_id": "test-model",
            "mode_id": "default",
            "created_at": 10,
            "updated_at": 20,
            "messages": [{
                "id": "message-1",
                "role": "user",
                "kind": "text",
                "content": "hello",
                "timestamp": 10,
                "meta": {"z": 2, "a": 1}
            }]
        }"#;
        let second = br#"{
            "messages": [{
                "timestamp": 10,
                "content": "hello",
                "kind": "text",
                "role": "user",
                "id": "message-1",
                "meta": {"a": 1, "z": 2}
            }],
            "updated_at": 20,
            "created_at": 10,
            "mode_id": "default",
            "model_id": "test-model",
            "session_id": "stable-session",
            "version": 1
        }"#;
        fs::write(sessions_dir(&first_root).join("history.json"), first)
            .expect("first history should persist");
        fs::write(sessions_dir(&second_root).join("history.json"), second)
            .expect("second history should persist");

        let first_inventory = inspect_history_storage(&first_root);
        let second_inventory = inspect_history_storage(&second_root);
        assert_eq!(first_inventory.histories.sessions.len(), 1);
        assert_eq!(second_inventory.histories.sessions.len(), 1);
        assert_eq!(
            first_inventory.histories.sessions[0].content_fingerprint,
            second_inventory.histories.sessions[0].content_fingerprint
        );
        assert_ne!(
            first_inventory.histories.sessions[0].artifact_fingerprint,
            second_inventory.histories.sessions[0].artifact_fingerprint
        );
        assert_ne!(first_inventory.fingerprint, second_inventory.fingerprint);

        fs::remove_dir_all(first_root).ok();
        fs::remove_dir_all(second_root).ok();
    }

    #[test]
    fn content_fingerprint_matches_across_legacy_and_directory_formats() {
        let storage_root = make_temp_dir();
        let history = sample_history();
        save_session_history(&storage_root, &history).expect("directory history should persist");
        write_json_atomic(&sessions_dir(&storage_root).join("legacy.json"), &history)
            .expect("legacy history should persist");

        let inventory = inspect_history_storage(&storage_root);
        assert_eq!(inventory.histories.sessions.len(), 2);
        assert_eq!(
            inventory.histories.sessions[0].content_fingerprint,
            inventory.histories.sessions[1].content_fingerprint
        );
        assert_ne!(
            inventory.histories.sessions[0].artifact_fingerprint,
            inventory.histories.sessions[1].artifact_fingerprint
        );

        fs::remove_dir_all(storage_root).ok();
    }

    #[test]
    fn strict_inventory_fingerprint_covers_unindexed_transcript_bytes() {
        let storage_root = make_temp_dir();
        let history = sample_history();
        save_session_history(&storage_root, &history).expect("history should persist");
        let before = inspect_history_storage(&storage_root);
        let transcript = storage_session_transcript_file(&storage_root, &history.session_id);
        OpenOptions::new()
            .append(true)
            .open(&transcript)
            .expect("transcript should open")
            .write_all(b"\n")
            .expect("unindexed byte should append");

        let after = inspect_history_storage(&storage_root);
        assert_eq!(before.histories.sessions.len(), 1);
        assert_eq!(after.histories.sessions.len(), 1);
        assert_ne!(before.fingerprint, after.fingerprint);
        assert_ne!(
            before.histories.sessions[0].artifact_fingerprint,
            after.histories.sessions[0].artifact_fingerprint
        );
        assert_eq!(
            before.histories.sessions[0].content_fingerprint,
            after.histories.sessions[0].content_fingerprint
        );

        fs::remove_dir_all(storage_root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn strict_inventory_distinguishes_non_utf8_paths() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let storage_root = Path::new("storage");
        let first_path = storage_root.join(OsString::from_vec(vec![
            b'u', b'n', b'k', b'n', b'o', b'w', b'n', b'-', 0xfe, b'.', b'b', b'i', b'n',
        ]));
        let second_path = storage_root.join(OsString::from_vec(vec![
            b'u', b'n', b'k', b'n', b'o', b'w', b'n', b'-', 0xff, b'.', b'b', b'i', b'n',
        ]));
        let first = relative_storage_path(storage_root, &first_path);
        let second = relative_storage_path(storage_root, &second_path);
        assert!(first.starts_with("@neverwrite-bytes:"));
        assert!(second.starts_with("@neverwrite-bytes:"));
        assert_ne!(first, second);
    }

    #[cfg(unix)]
    #[test]
    fn strict_inspector_reports_permission_denied_artifacts() {
        use std::os::unix::fs::PermissionsExt;

        let storage_root = make_temp_dir();
        let history = sample_history();
        save_session_history(&storage_root, &history).expect("history should persist");
        let transcript = storage_session_transcript_file(&storage_root, &history.session_id);
        let original_permissions = fs::metadata(&transcript)
            .expect("transcript metadata should load")
            .permissions();
        fs::set_permissions(&transcript, fs::Permissions::from_mode(0o000))
            .expect("transcript permissions should change");

        let read_is_denied = fs::read(&transcript).is_err();
        let inventory = inspect_history_storage(&storage_root);
        fs::set_permissions(&transcript, original_permissions)
            .expect("transcript permissions should restore");
        if read_is_denied {
            assert!(inventory
                .histories
                .read_errors
                .iter()
                .any(|error| error.relative_path.ends_with(SESSION_TRANSCRIPT_FILE)));
        }

        fs::remove_dir_all(storage_root).ok();
    }

    #[test]
    fn persists_untrusted_session_ids_inside_storage_key_layout() {
        let dir = make_temp_dir();

        for session_id in ["../outside", "..\\outside", "nested/evil", "nested\\evil"] {
            let history = sample_history_with_session_id(session_id);
            save_session_history(&dir, &history).expect("history should persist safely");

            assert!(storage_session_dir(&dir, session_id).exists());
            assert!(!sessions_dir(&dir).join(session_id).exists());

            let page = load_session_history_page(&dir, session_id, 0, 20)
                .expect("history page should load from safe storage");
            assert_eq!(page.total_messages, history.messages.len());

            delete_session_history(&dir, session_id).expect("history should delete safely");
            assert!(!storage_session_dir(&dir, session_id).exists());
        }

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn migrates_legacy_flat_file_to_storage_key_layout() {
        let dir = make_temp_dir();
        let history = sample_history_with_session_id("legacy-session");
        let legacy_path = sessions_dir(&dir).join("legacy-safe.json");

        ensure_sessions_root(&dir).expect("sessions root should exist");
        write_json_atomic(&legacy_path, &history).expect("legacy file should persist");

        let page = load_session_history_page(&dir, "legacy-session", 0, 20)
            .expect("legacy history should load and migrate");
        assert_eq!(page.total_messages, history.messages.len());
        assert!(storage_session_dir(&dir, "legacy-session").exists());
        assert!(!legacy_path.exists());

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn load_all_session_histories_prefers_storage_layout_over_legacy_file() {
        let dir = make_temp_dir();
        let mut storage_history = sample_history_with_session_id("shared-session");
        storage_history.updated_at = 200;
        save_session_history(&dir, &storage_history).expect("storage history should persist");

        let mut legacy_history = sample_history_with_session_id("shared-session");
        legacy_history.updated_at = 100;
        let legacy_path = sessions_dir(&dir).join("legacy-duplicate.json");
        write_json_atomic(&legacy_path, &legacy_history).expect("legacy file should persist");

        let histories =
            load_all_session_histories(&dir, false).expect("session histories should load");
        assert_eq!(histories.len(), 1);
        assert_eq!(histories[0].session_id, "shared-session");
        assert_eq!(histories[0].updated_at, 200);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn delete_all_session_histories_only_clears_sessions_dir() {
        let dir = make_temp_dir();
        let history = sample_history();
        let sibling = dir.join("keep.txt");

        save_session_history(&dir, &history).expect("history should persist");
        fs::create_dir_all(sibling.parent().expect("sibling parent should exist"))
            .expect("sibling parent should exist");
        fs::write(&sibling, b"keep").expect("sibling file should persist");

        delete_all_session_histories(&dir).expect("histories should delete");

        assert!(sibling.exists());
        assert!(sessions_dir(&dir).is_dir());
        assert_eq!(
            fs::read_dir(sessions_dir(&dir))
                .expect("sessions dir should be readable")
                .count(),
            0
        );

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn prune_expired_session_histories_only_touches_sessions_dir() {
        let dir = make_temp_dir();
        let mut history = sample_history();
        history.updated_at = 1;
        let sibling = dir.join("keep-after-prune.txt");

        save_session_history(&dir, &history).expect("history should persist");
        fs::create_dir_all(sibling.parent().expect("sibling parent should exist"))
            .expect("sibling parent should exist");
        fs::write(&sibling, b"keep").expect("sibling file should persist");

        let deleted = prune_expired_session_histories(&dir, 1).expect("prune should succeed");

        assert_eq!(deleted, 1);
        assert!(sibling.exists());
        assert!(!storage_session_dir(&dir, &history.session_id).exists());

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn saves_metadata_and_loads_paged_messages_from_lazy_transcript() {
        let dir = make_temp_dir();
        let history = sample_history();

        save_session_history(&dir, &history).expect("history should persist");

        let summaries =
            load_all_session_histories(&dir, false).expect("history summaries should load");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].messages.len(), 0);
        assert_eq!(summaries[0].message_count, Some(2));
        assert_eq!(summaries[0].title.as_deref(), Some("Hello"));

        let page =
            load_session_history_page(&dir, "session-1", 1, 1).expect("history page should load");
        assert_eq!(page.start_index, 1);
        assert_eq!(page.end_index, 2);
        assert_eq!(page.total_messages, 2);
        assert_eq!(page.messages[0].id, "assistant:1");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn preserves_message_attachments_in_lazy_transcript() {
        let dir = make_temp_dir();
        let history = sample_history();
        let expected_attachments = history.messages[0].attachments.clone();

        save_session_history(&dir, &history).expect("history should persist");

        let page =
            load_session_history_page(&dir, "session-1", 0, 1).expect("history page should load");
        assert_eq!(page.messages[0].attachments, expected_attachments);

        let histories = load_all_session_histories(&dir, true).expect("full history should load");
        assert_eq!(histories[0].messages[0].attachments, expected_attachments);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn preserves_parent_session_id_in_lazy_metadata() {
        let dir = make_temp_dir();
        let mut history = sample_history_with_session_id("child-session");
        history.parent_session_id = Some("parent-session".to_string());
        history.closed_at = Some("123".to_string());

        save_session_history(&dir, &history).expect("child history should persist");

        let metadata =
            load_session_metadata(&dir, "child-session").expect("child metadata should load");
        assert_eq!(
            metadata.parent_session_id.as_deref(),
            Some("parent-session")
        );
        assert_eq!(metadata.closed_at.as_deref(), Some("123"));

        let summaries =
            load_all_session_histories(&dir, false).expect("history summaries should load");
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].parent_session_id.as_deref(),
            Some("parent-session")
        );
        assert_eq!(summaries[0].closed_at.as_deref(), Some("123"));

        let full = load_all_session_histories(&dir, true).expect("full history should load");
        assert_eq!(full[0].parent_session_id.as_deref(), Some("parent-session"));
        assert_eq!(full[0].closed_at.as_deref(), Some("123"));

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn preserves_empty_persisted_subagent_sessions() {
        let dir = make_temp_dir();
        let mut history = sample_history_with_session_id("empty-child-session");
        history.parent_session_id = Some("parent-session".to_string());
        history.start_index = Some(0);
        history.message_count = Some(0);
        history.messages = vec![];
        history.title = Some("Worker".to_string());
        history.preview = None;

        save_session_history(&dir, &history).expect("empty child history should persist");

        let summaries =
            load_all_session_histories(&dir, false).expect("history summaries should load");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].session_id, "empty-child-session");
        assert_eq!(
            summaries[0].parent_session_id.as_deref(),
            Some("parent-session")
        );
        assert_eq!(summaries[0].message_count, Some(0));

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn legacy_histories_without_parent_session_id_still_load() {
        let dir = make_temp_dir();
        let legacy_path = sessions_dir(&dir).join("legacy-no-parent.json");
        ensure_sessions_root(&dir).expect("sessions root should exist");
        fs::write(
            &legacy_path,
            serde_json::json!({
                "version": 1,
                "session_id": "legacy-no-parent",
                "runtime_id": "codex-acp",
                "model_id": "test-model",
                "mode_id": "default",
                "created_at": 10,
                "updated_at": 20,
                "messages": []
            })
            .to_string(),
        )
        .expect("legacy file should persist");

        let histories =
            load_all_session_histories(&dir, false).expect("legacy history should load");
        assert_eq!(histories.len(), 1);
        assert_eq!(histories[0].session_id, "legacy-no-parent");
        assert_eq!(histories[0].parent_session_id, None);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn preserves_agent_catalog_metadata_across_lazy_history_roundtrips() {
        let dir = make_temp_dir();
        let mut history = sample_history();
        history.models = Some(serde_json::json!([
            {
                "id": "test-model",
                "runtime_id": "codex-acp",
                "name": "Test Model",
                "description": "A test model for unit tests."
            }
        ]));
        history.modes = Some(serde_json::json!([
            {
                "id": "default",
                "runtime_id": "codex-acp",
                "name": "Default",
                "description": "Prompt for actions that need explicit approval.",
                "disabled": false
            }
        ]));
        history.config_options = Some(serde_json::json!([
            {
                "id": "model",
                "runtime_id": "codex-acp",
                "category": "model",
                "label": "Model",
                "type": "select",
                "value": "test-model",
                "options": [
                    {
                        "value": "test-model",
                        "label": "Test Model",
                        "description": null
                    }
                ]
            }
        ]));

        save_session_history(&dir, &history).expect("history should persist");

        let summaries =
            load_all_session_histories(&dir, false).expect("history summaries should load");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].models, history.models);
        assert_eq!(summaries[0].modes, history.modes);
        assert_eq!(summaries[0].config_options, history.config_options);

        let full = load_all_session_histories(&dir, true).expect("full history should load");
        assert_eq!(full.len(), 1);
        assert_eq!(full[0].models, history.models);
        assert_eq!(full[0].modes, history.modes);
        assert_eq!(full[0].config_options, history.config_options);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn appends_only_the_changed_suffix_for_partial_windows() {
        let dir = make_temp_dir();
        let history = sample_history();

        save_session_history(&dir, &history).expect("history should persist");

        let patch = PersistedSessionHistory {
            version: 1,
            session_id: "session-1".to_string(),
            parent_session_id: None,
            closed_at: None,
            runtime_id: Some("codex-acp".to_string()),
            model_id: "test-model".to_string(),
            mode_id: "default".to_string(),
            models: None,
            modes: None,
            config_options: None,
            additional_roots: vec![],
            created_at: 10,
            updated_at: 30,
            start_index: Some(1),
            message_count: Some(3),
            title: Some("Hello".to_string()),
            custom_title: None,
            preview: Some("Plan: Next step".to_string()),
            messages: vec![
                PersistedMessage {
                    id: "assistant:1".to_string(),
                    role: "assistant".to_string(),
                    kind: "text".to_string(),
                    content: "Assistant reply (edited)".to_string(),
                    timestamp: 20,
                    attachments: None,
                    title: None,
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    review_diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    url_elicitation_request_id: None,
                    url_elicitation_id: None,
                    url_elicitation_url: None,
                    plan_entries: None,
                    plan_detail: None,
                    tool_action: None,
                },
                PersistedMessage {
                    id: "plan:1".to_string(),
                    role: "assistant".to_string(),
                    kind: "plan".to_string(),
                    content: "Next step".to_string(),
                    timestamp: 30,
                    attachments: None,
                    title: Some("Plan".to_string()),
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    review_diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    url_elicitation_request_id: None,
                    url_elicitation_id: None,
                    url_elicitation_url: None,
                    plan_entries: None,
                    plan_detail: Some("Do the thing".to_string()),
                    tool_action: None,
                },
            ],
        };

        save_session_history(&dir, &patch).expect("partial window should merge");

        let histories = load_all_session_histories(&dir, true).expect("full history should load");
        assert_eq!(histories[0].messages.len(), 3);
        assert_eq!(histories[0].messages[0].id, "user:1");
        assert_eq!(histories[0].messages[1].content, "Assistant reply (edited)");
        assert_eq!(histories[0].messages[2].id, "plan:1");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn compacts_obsolete_transcript_versions_after_repeated_suffix_updates() {
        let dir = make_temp_dir();
        let history = sample_history();
        let disabled_compaction = TranscriptCompactionPolicy {
            min_obsolete_bytes: u64::MAX,
            max_physical_to_indexed_ratio: u64::MAX,
            force_physical_bytes: u64::MAX,
        };
        let aggressive_compaction = TranscriptCompactionPolicy {
            min_obsolete_bytes: 1,
            max_physical_to_indexed_ratio: 2,
            force_physical_bytes: u64::MAX,
        };

        save_session_history_with_compaction_policy(&dir, &history, disabled_compaction)
            .expect("base history should persist");

        for version in 0..12 {
            let patch = assistant_update_patch(
                format!(
                    "Assistant reply update {version}: {}",
                    "tool output ".repeat(20)
                ),
                30 + version,
            );
            save_session_history_with_compaction_policy(&dir, &patch, disabled_compaction)
                .expect("inflating update should persist");
        }

        let inflated_lines = transcript_line_count(&dir, "session-1");
        let inflated_bytes = fs::metadata(storage_session_transcript_file(&dir, "session-1"))
            .expect("inflated transcript metadata should load")
            .len();
        assert!(inflated_lines > history.messages.len());

        let final_content = "Assistant reply compacted final state".to_string();
        let final_patch = assistant_update_patch(final_content.clone(), 100);
        save_session_history_with_compaction_policy(&dir, &final_patch, aggressive_compaction)
            .expect("compacting update should persist");

        let compacted_lines = transcript_line_count(&dir, "session-1");
        let compacted_bytes = fs::metadata(storage_session_transcript_file(&dir, "session-1"))
            .expect("compacted transcript metadata should load")
            .len();
        assert_eq!(compacted_lines, history.messages.len());
        assert!(compacted_bytes < inflated_bytes);

        let histories = load_all_session_histories(&dir, true).expect("full history should load");
        assert_eq!(histories.len(), 1);
        assert_eq!(histories[0].messages.len(), 2);
        assert_eq!(histories[0].messages[0].id, "user:1");
        assert_eq!(histories[0].messages[1].id, "assistant:1");
        assert_eq!(histories[0].messages[1].content, final_content);

        let index = load_session_index(&dir, "session-1").expect("index should load");
        validate_index(&index).expect("index should be valid");
        assert_eq!(index.message_offsets.len(), histories[0].messages.len());

        let mut expected_offset = 0_u64;
        let mut transcript = File::open(storage_session_transcript_file(&dir, "session-1"))
            .expect("open transcript");
        for (idx, message) in histories[0].messages.iter().enumerate() {
            assert_eq!(index.message_offsets[idx], expected_offset);
            let bytes = serialize_message_bytes(message).expect("message should serialize");
            assert_eq!(index.message_lengths[idx], bytes.len() as u64);
            assert_eq!(
                index.message_hashes[idx],
                hash_message(message).expect("message should hash")
            );
            let indexed_message = read_indexed_transcript_message(
                &mut transcript,
                index.message_offsets[idx],
                index.message_lengths[idx] as usize,
            )
            .expect("indexed message should read");
            assert_eq!(indexed_message.id, message.id);
            assert_eq!(indexed_message.content, message.content);
            expected_offset += index.message_lengths[idx];
        }
        assert_eq!(expected_offset, compacted_bytes);

        let page = load_session_history_page(&dir, "session-1", 0, 2).expect("page should load");
        assert_eq!(page.total_messages, 2);
        assert_eq!(page.messages[1].content, final_content);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn recovers_interrupted_transcript_compaction_before_loading_history() {
        let dir = make_temp_dir();
        let history = sample_history();
        save_session_history(&dir, &history).expect("history should persist");

        let session_dir = storage_session_dir(&dir, "session-1");
        let metadata_path = session_meta_path(&session_dir);
        let index_path = session_index_path(&session_dir);
        let transcript_path = session_transcript_path(&session_dir);
        let metadata_backup = metadata_path.with_file_name("session-meta.json.compact-bak.test");
        let index_backup = index_path.with_file_name("index.json.compact-bak.test");
        let transcript_backup = transcript_path.with_file_name("transcript.jsonl.compact-bak.test");
        let metadata_tmp = metadata_path.with_file_name("session-meta.json.compact-tmp.test");
        let index_tmp = index_path.with_file_name("index.json.compact-tmp.test");
        let transcript_tmp = transcript_path.with_file_name("transcript.jsonl.compact-tmp.test");

        let original_metadata = fs::read(&metadata_path).expect("metadata should read");
        let original_index = fs::read(&index_path).expect("index should read");
        let original_transcript = fs::read(&transcript_path).expect("transcript should read");
        fs::copy(&metadata_path, &metadata_backup).expect("metadata backup should write");
        fs::copy(&index_path, &index_backup).expect("index backup should write");
        fs::copy(&transcript_path, &transcript_backup).expect("transcript backup should write");
        fs::write(&metadata_tmp, b"{}").expect("metadata tmp should write");
        fs::write(&index_tmp, b"{}").expect("index tmp should write");
        fs::write(&transcript_tmp, b"{\"broken\":true}\n").expect("transcript tmp should write");
        fs::write(&transcript_path, b"{\"broken\":true}\n")
            .expect("partial transcript replacement should write");

        let marker = TranscriptCompactionState {
            version: FORMAT_VERSION,
            metadata_tmp: session_sidecar_file_name(&metadata_tmp).expect("metadata tmp name"),
            index_tmp: session_sidecar_file_name(&index_tmp).expect("index tmp name"),
            transcript_tmp: session_sidecar_file_name(&transcript_tmp)
                .expect("transcript tmp name"),
            metadata_backup: session_sidecar_file_name(&metadata_backup)
                .expect("metadata backup name"),
            index_backup: session_sidecar_file_name(&index_backup).expect("index backup name"),
            transcript_backup: session_sidecar_file_name(&transcript_backup)
                .expect("transcript backup name"),
        };
        write_json_atomic(&session_compaction_marker_path(&session_dir), &marker)
            .expect("marker should write");

        let marker_path = session_compaction_marker_path(&session_dir);
        let marker_before = fs::read(&marker_path).expect("marker should read");
        let transcript_before = fs::read(&transcript_path).expect("partial transcript should read");
        let inventory = inspect_history_storage(&dir);
        assert_eq!(inventory.histories.recoverable_states.len(), 1);
        assert_eq!(
            inventory.histories.recoverable_states[0].state_type,
            "interrupted_transcript_compaction"
        );
        assert!(!inventory.histories.unknown_entries.iter().any(|entry| {
            entry.relative_path.contains("compact-state")
                || entry.relative_path.contains("compact-tmp")
                || entry.relative_path.contains("compact-bak")
        }));
        assert_eq!(
            fs::read(&marker_path).expect("inspection must preserve marker"),
            marker_before
        );
        assert_eq!(
            fs::read(&transcript_path).expect("inspection must preserve transcript"),
            transcript_before
        );
        assert!(metadata_backup.exists());
        assert!(index_backup.exists());
        assert!(transcript_backup.exists());
        assert!(metadata_tmp.exists());
        assert!(index_tmp.exists());
        assert!(transcript_tmp.exists());

        let histories = load_all_session_histories(&dir, true).expect("history should recover");
        assert_eq!(histories.len(), 1);
        assert_eq!(histories[0].messages.len(), history.messages.len());
        assert_eq!(histories[0].messages[0].id, history.messages[0].id);
        assert_eq!(
            histories[0].messages[0].content,
            history.messages[0].content
        );
        assert_eq!(histories[0].messages[1].id, history.messages[1].id);
        assert_eq!(
            histories[0].messages[1].content,
            history.messages[1].content
        );
        assert_eq!(
            fs::read(&metadata_path).expect("metadata should be restored"),
            original_metadata
        );
        assert_eq!(
            fs::read(&index_path).expect("index should be restored"),
            original_index
        );
        assert_eq!(
            fs::read(&transcript_path).expect("transcript should be restored"),
            original_transcript
        );
        assert!(!session_compaction_marker_path(&session_dir).exists());
        assert!(!metadata_tmp.exists());
        assert!(!index_tmp.exists());
        assert!(!transcript_tmp.exists());

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn roundtrips_chunked_transcript_pages_without_losing_message_fields() {
        let dir = make_temp_dir();
        let history = sample_history();

        save_session_history(&dir, &history).expect("base history should persist");

        let edited_assistant = PersistedMessage {
            id: "assistant:1".to_string(),
            role: "assistant".to_string(),
            kind: "text".to_string(),
            content: "Assistant reply (edited)".to_string(),
            timestamp: 20,
            attachments: None,
            title: Some("Reply".to_string()),
            meta: Some(serde_json::json!({
                "status": "completed",
            })),
            permission_request_id: None,
            permission_options: None,
            diffs: None,
            review_diffs: None,
            user_input_request_id: None,
            user_input_questions: None,
            url_elicitation_request_id: None,
            url_elicitation_id: None,
            url_elicitation_url: None,
            plan_entries: None,
            plan_detail: None,
            tool_action: None,
        };
        let permission = PersistedMessage {
            id: "permission:1".to_string(),
            role: "assistant".to_string(),
            kind: "permission".to_string(),
            content: "Edit watcher.rs".to_string(),
            timestamp: 30,
            attachments: None,
            title: Some("Permission request".to_string()),
            meta: Some(serde_json::json!({
                "status": "pending",
                "target": "/vault/src/watcher.rs",
            })),
            permission_request_id: Some("permission-1".to_string()),
            permission_options: Some(serde_json::json!([
                {
                    "option_id": "reject_once",
                    "name": "Reject",
                    "kind": "reject_once"
                },
                {
                    "option_id": "allow_once",
                    "name": "Allow once",
                    "kind": "allow_once"
                }
            ])),
            diffs: Some(serde_json::json!([
                {
                    "path": "/vault/src/watcher.rs",
                    "kind": "update",
                    "old_text": "old line",
                    "new_text": "new line"
                }
            ])),
            review_diffs: Some(serde_json::json!([
                {
                    "path": "/vault/src/watcher.rs",
                    "kind": "update",
                    "old_text": "old line",
                    "new_text": "review line"
                }
            ])),
            user_input_request_id: None,
            user_input_questions: None,
            url_elicitation_request_id: None,
            url_elicitation_id: None,
            url_elicitation_url: None,
            plan_entries: None,
            plan_detail: None,
            tool_action: None,
        };
        let user_input = PersistedMessage {
            id: "input:1".to_string(),
            role: "assistant".to_string(),
            kind: "user_input_request".to_string(),
            content: "Need confirmation".to_string(),
            timestamp: 40,
            attachments: None,
            title: Some("Input requested".to_string()),
            meta: Some(serde_json::json!({
                "status": "pending",
            })),
            permission_request_id: None,
            permission_options: None,
            diffs: None,
            review_diffs: None,
            user_input_request_id: Some("input-1".to_string()),
            user_input_questions: Some(serde_json::json!([
                {
                    "id": "confirm",
                    "header": "Confirm",
                    "question": "Proceed?",
                    "is_other": false,
                    "is_secret": false
                }
            ])),
            url_elicitation_request_id: None,
            url_elicitation_id: None,
            url_elicitation_url: None,
            plan_entries: None,
            plan_detail: None,
            tool_action: None,
        };
        let plan = PersistedMessage {
            id: "plan:1".to_string(),
            role: "assistant".to_string(),
            kind: "plan".to_string(),
            content: "Confirm restore".to_string(),
            timestamp: 50,
            attachments: None,
            title: Some("Plan".to_string()),
            meta: None,
            permission_request_id: None,
            permission_options: None,
            diffs: None,
            review_diffs: None,
            user_input_request_id: None,
            user_input_questions: None,
            url_elicitation_request_id: None,
            url_elicitation_id: None,
            url_elicitation_url: None,
            plan_entries: Some(serde_json::json!([
                {
                    "content": "Confirm restore",
                    "priority": "high",
                    "status": "in_progress"
                }
            ])),
            plan_detail: Some("Verify all message fields survive paging.".to_string()),
            tool_action: Some(serde_json::json!({
                "kind": "open_session",
                "session_id": "child-session",
                "label": "Open child"
            })),
        };

        let expected_messages = vec![
            history.messages[0].clone(),
            edited_assistant,
            permission,
            user_input,
            plan,
        ];
        let patch = PersistedSessionHistory {
            version: 1,
            session_id: "session-1".to_string(),
            parent_session_id: None,
            closed_at: None,
            runtime_id: Some("codex-acp".to_string()),
            model_id: "test-model".to_string(),
            mode_id: "default".to_string(),
            models: None,
            modes: None,
            config_options: None,
            additional_roots: vec![],
            created_at: 10,
            updated_at: 50,
            start_index: Some(1),
            message_count: Some(expected_messages.len()),
            title: Some("Hello".to_string()),
            custom_title: None,
            preview: Some("Plan: Confirm restore".to_string()),
            messages: expected_messages[1..].to_vec(),
        };

        save_session_history(&dir, &patch).expect("chunked patch should persist");

        let first_page =
            load_session_history_page(&dir, "session-1", 0, 2).expect("first page should load");
        let second_page =
            load_session_history_page(&dir, "session-1", 2, 3).expect("second page should load");
        let mut reconstructed = first_page.messages.clone();
        reconstructed.extend(second_page.messages.clone());

        assert_eq!(
            serde_json::to_value(&reconstructed).expect("messages should serialize"),
            serde_json::to_value(&expected_messages).expect("messages should serialize"),
        );

        let histories = load_all_session_histories(&dir, true).expect("full history should load");
        assert_eq!(
            serde_json::to_value(&histories[0].messages).expect("messages should serialize"),
            serde_json::to_value(&expected_messages).expect("messages should serialize"),
        );

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn compacts_inflated_transcript_when_loading_history_page() {
        let dir = make_temp_dir();
        let (_inflated_lines, inflated_bytes, final_content) =
            persist_default_compaction_candidate(&dir);

        let page =
            load_session_history_page(&dir, "session-1", 0, 2).expect("history page should load");

        let compacted_lines = transcript_line_count(&dir, "session-1");
        let compacted_bytes = fs::metadata(storage_session_transcript_file(&dir, "session-1"))
            .expect("compacted transcript metadata should load")
            .len();

        assert_eq!(compacted_lines, page.total_messages);
        assert_eq!(page.total_messages, 2);
        assert_eq!(page.messages[0].id, "user:1");
        assert_eq!(page.messages[1].content, final_content);
        assert!(compacted_bytes < inflated_bytes);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn compacts_inflated_transcript_when_loading_all_messages() {
        let dir = make_temp_dir();
        let (_inflated_lines, inflated_bytes, final_content) =
            persist_default_compaction_candidate(&dir);

        let histories = load_all_session_histories(&dir, true).expect("full history should load");

        let compacted_lines = transcript_line_count(&dir, "session-1");
        let compacted_bytes = fs::metadata(storage_session_transcript_file(&dir, "session-1"))
            .expect("compacted transcript metadata should load")
            .len();

        assert_eq!(histories.len(), 1);
        assert_eq!(histories[0].messages.len(), 2);
        assert_eq!(histories[0].messages[0].id, "user:1");
        assert_eq!(histories[0].messages[1].content, final_content);
        assert_eq!(compacted_lines, histories[0].message_count.unwrap());
        assert!(compacted_bytes < inflated_bytes);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn does_not_compact_inflated_transcript_when_loading_summaries_only() {
        let dir = make_temp_dir();
        let (inflated_lines, inflated_bytes, _final_content) =
            persist_default_compaction_candidate(&dir);

        let summaries =
            load_all_session_histories(&dir, false).expect("history summaries should load");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].messages.len(), 0);
        assert_eq!(transcript_line_count(&dir, "session-1"), inflated_lines);
        assert_eq!(
            fs::metadata(storage_session_transcript_file(&dir, "session-1"))
                .expect("inflated transcript metadata should load")
                .len(),
            inflated_bytes
        );

        fs::remove_dir_all(dir).ok();
    }
}
