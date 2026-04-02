use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::write_json_atomic;

const SESSIONS_DIR: &str = ".vaultai/sessions";
const SESSION_META_FILE: &str = "session-meta.json";
const SESSION_INDEX_FILE: &str = "index.json";
const SESSION_TRANSCRIPT_FILE: &str = "transcript.jsonl";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedMessage {
    pub id: String,
    pub role: String,
    pub kind: String,
    pub content: String,
    pub timestamp: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_questions: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_entries: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSessionHistory {
    pub version: u32,
    pub session_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSessionMetadata {
    version: u32,
    session_id: String,
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

#[derive(Debug, Default)]
struct LegacySessionArtifacts {
    file_path: Option<PathBuf>,
    dir_path: Option<PathBuf>,
}

fn sessions_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(SESSIONS_DIR)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

// `session_id` remains a logical product identifier; disk layout uses a hashed storage key.
fn session_storage_key(session_id: &str) -> String {
    format!("session-{}", sha256_hex(session_id.as_bytes()))
}

fn storage_session_dir(vault_root: &Path, session_id: &str) -> PathBuf {
    sessions_dir(vault_root).join(session_storage_key(session_id))
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

fn storage_session_meta_file(vault_root: &Path, session_id: &str) -> PathBuf {
    session_meta_path(&storage_session_dir(vault_root, session_id))
}

fn storage_session_index_file(vault_root: &Path, session_id: &str) -> PathBuf {
    session_index_path(&storage_session_dir(vault_root, session_id))
}

fn storage_session_transcript_file(vault_root: &Path, session_id: &str) -> PathBuf {
    session_transcript_path(&storage_session_dir(vault_root, session_id))
}

fn storage_session_is_complete(vault_root: &Path, session_id: &str) -> bool {
    storage_session_meta_file(vault_root, session_id).exists()
        && storage_session_index_file(vault_root, session_id).exists()
        && storage_session_transcript_file(vault_root, session_id).exists()
}

fn ensure_sessions_root(vault_root: &Path) -> Result<(), String> {
    fs::create_dir_all(sessions_dir(vault_root)).map_err(|e| e.to_string())
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

fn load_session_metadata(
    vault_root: &Path,
    session_id: &str,
) -> Result<PersistedSessionMetadata, String> {
    read_json_file(&storage_session_meta_file(vault_root, session_id))
}

fn load_session_index(
    vault_root: &Path,
    session_id: &str,
) -> Result<PersistedTranscriptIndex, String> {
    read_json_file(&storage_session_index_file(vault_root, session_id))
}

fn load_session_metadata_from_dir(session_dir: &Path) -> Result<PersistedSessionMetadata, String> {
    read_json_file(&session_meta_path(session_dir))
}

fn load_session_index_from_dir(session_dir: &Path) -> Result<PersistedTranscriptIndex, String> {
    read_json_file(&session_index_path(session_dir))
}

fn validate_index(index: &PersistedTranscriptIndex) -> Result<(), String> {
    let count = index.message_offsets.len();
    if index.message_lengths.len() != count || index.message_hashes.len() != count {
        return Err("Persisted transcript index is inconsistent.".to_string());
    }
    Ok(())
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
        runtime_id: history.runtime_id.clone(),
        model_id: history.model_id.clone(),
        mode_id: history.mode_id.clone(),
        models: history.models.clone(),
        modes: history.modes.clone(),
        config_options: history.config_options.clone(),
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
        runtime_id: metadata.runtime_id,
        model_id: metadata.model_id,
        mode_id: metadata.mode_id,
        models: metadata.models,
        modes: metadata.modes,
        config_options: metadata.config_options,
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
    let history = read_json_file::<PersistedSessionHistory>(&path)?;
    Ok(PersistedSessionHistory {
        version: history.version,
        session_id: history.session_id,
        runtime_id: history.runtime_id,
        model_id: history.model_id,
        mode_id: history.mode_id,
        models: history.models,
        modes: history.modes,
        config_options: history.config_options,
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
    })
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

fn legacy_session_priority(vault_root: &Path, path: &Path, session_id: &str) -> u8 {
    if path == storage_session_dir(vault_root, session_id) {
        3
    } else if path.is_dir() {
        2
    } else {
        1
    }
}

fn find_legacy_session_artifacts(
    vault_root: &Path,
    session_id: &str,
) -> Result<LegacySessionArtifacts, String> {
    let dir = sessions_dir(vault_root);
    if !dir.exists() {
        return Ok(LegacySessionArtifacts::default());
    }

    let storage_dir = storage_session_dir(vault_root, session_id);
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
    vault_root: &Path,
    session_id: &str,
) -> Result<Option<PersistedSessionHistory>, String> {
    let artifacts = find_legacy_session_artifacts(vault_root, session_id)?;
    if let Some(dir_path) = artifacts.dir_path {
        return load_history_from_session_dir(&dir_path, true).map(Some);
    }
    if let Some(file_path) = artifacts.file_path {
        return load_legacy_history_file(&file_path).map(Some);
    }
    Ok(None)
}

fn remove_legacy_history_artifacts(vault_root: &Path, session_id: &str) -> Result<(), String> {
    let artifacts = find_legacy_session_artifacts(vault_root, session_id)?;
    if let Some(file_path) = artifacts.file_path {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    if let Some(dir_path) = artifacts.dir_path {
        fs::remove_dir_all(dir_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_full_lazy_history(
    vault_root: &Path,
    history: &PersistedSessionHistory,
) -> Result<(), String> {
    let (start_index, total_count) = history_window_bounds(history)?;
    if start_index != 0 || total_count != history.messages.len() {
        return Err("Full lazy history writes require a complete transcript.".to_string());
    }

    ensure_sessions_root(vault_root)?;
    let session_dir = storage_session_dir(vault_root, &history.session_id);
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
    remove_legacy_history_artifacts(vault_root, &history.session_id)?;

    Ok(())
}

fn ensure_lazy_session_from_legacy(vault_root: &Path, session_id: &str) -> Result<(), String> {
    if storage_session_is_complete(vault_root, session_id) {
        return Ok(());
    }

    let Some(history) = load_legacy_history(vault_root, session_id)? else {
        return Ok(());
    };

    write_full_lazy_history(vault_root, &history)
}

fn load_lazy_history_page(
    vault_root: &Path,
    session_id: &str,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    let session_dir = storage_session_dir(vault_root, session_id);
    load_lazy_history_page_from_dir(&session_dir, start_index, limit)
}

fn load_lazy_history_page_from_dir(
    session_dir: &Path,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    let metadata = load_session_metadata_from_dir(session_dir)?;
    let index = load_session_index_from_dir(session_dir)?;
    validate_index(&index)?;

    let total_messages = metadata.message_count;
    let start = start_index.min(total_messages);
    let end = start.saturating_add(limit).min(total_messages);

    let mut transcript =
        File::open(session_transcript_path(session_dir)).map_err(|e| e.to_string())?;
    let mut messages = Vec::with_capacity(end.saturating_sub(start));

    for idx in start..end {
        let offset = index.message_offsets[idx];
        let length = index.message_lengths[idx] as usize;
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

        let message =
            serde_json::from_slice::<PersistedMessage>(&bytes).map_err(|e| e.to_string())?;
        messages.push(message);
    }

    Ok(PersistedSessionHistoryPage {
        session_id: metadata.session_id,
        total_messages,
        start_index: start,
        end_index: end,
        messages,
    })
}

fn load_all_lazy_messages_from_dir(session_dir: &Path) -> Result<Vec<PersistedMessage>, String> {
    let metadata = load_session_metadata_from_dir(session_dir)?;
    if metadata.message_count == 0 {
        return Ok(vec![]);
    }

    Ok(load_lazy_history_page_from_dir(session_dir, 0, metadata.message_count)?.messages)
}

pub fn save_session_history(
    vault_root: &Path,
    history: &PersistedSessionHistory,
) -> Result<(), String> {
    ensure_lazy_session_from_legacy(vault_root, &history.session_id)?;
    let (start_index, total_count) = history_window_bounds(history)?;

    let metadata_path = storage_session_meta_file(vault_root, &history.session_id);
    let index_path = storage_session_index_file(vault_root, &history.session_id);
    if !metadata_path.exists() || !index_path.exists() {
        if start_index != 0 || total_count != history.messages.len() {
            return Err(
                "Cannot persist a partial transcript window before the base transcript exists."
                    .to_string(),
            );
        }
        return write_full_lazy_history(vault_root, history);
    }

    let existing_metadata = load_session_metadata(vault_root, &history.session_id)?;
    let existing_index = load_session_index(vault_root, &history.session_id)?;
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
        let transcript_path = storage_session_transcript_file(vault_root, &history.session_id);
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

    write_json_atomic(&metadata_path, &next_metadata)?;
    write_json_atomic(&index_path, &next_index)?;
    remove_legacy_history_artifacts(vault_root, &history.session_id)?;

    Ok(())
}

pub fn load_session_history_page(
    vault_root: &Path,
    session_id: &str,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    ensure_lazy_session_from_legacy(vault_root, session_id)?;

    if storage_session_is_complete(vault_root, session_id) {
        return load_lazy_history_page(vault_root, session_id, start_index, limit);
    }

    let Some(history) = load_legacy_history(vault_root, session_id)? else {
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

pub fn delete_session_history(vault_root: &Path, session_id: &str) -> Result<(), String> {
    let dir = storage_session_dir(vault_root, session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    remove_legacy_history_artifacts(vault_root, session_id)?;

    Ok(())
}

pub fn delete_all_session_histories(vault_root: &Path) -> Result<(), String> {
    let dir = sessions_dir(vault_root);
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
    vault_root: &Path,
    max_age_days: u32,
) -> Result<usize, String> {
    if max_age_days == 0 {
        return Ok(0);
    }

    let dir = sessions_dir(vault_root);
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
    vault_root: &Path,
    include_messages: bool,
) -> Result<Vec<PersistedSessionHistory>, String> {
    let dir = sessions_dir(vault_root);
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
            let priority = legacy_session_priority(vault_root, &path, &history.session_id);
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
                    runtime_id: history.runtime_id,
                    model_id: history.model_id,
                    mode_id: history.mode_id,
                    models: history.models,
                    modes: history.modes,
                    config_options: history.config_options,
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
                    runtime_id: history.runtime_id,
                    model_id: history.model_id,
                    mode_id: history.mode_id,
                    models: history.models,
                    modes: history.modes,
                    config_options: history.config_options,
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
    histories.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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
    vault_root: &Path,
    query: &str,
) -> Result<Vec<SessionSearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let query_lower = query.to_lowercase();
    let dir = sessions_dir(vault_root);
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

    results.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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

pub fn fork_session_history(vault_root: &Path, source_session_id: &str) -> Result<String, String> {
    ensure_lazy_session_from_legacy(vault_root, source_session_id)?;

    let source_dir = storage_session_dir(vault_root, source_session_id);
    if !source_dir.exists() {
        return Err(format!("Source session not found: {source_session_id}"));
    }

    let source_meta = load_session_metadata_from_dir(&source_dir)?;

    let new_session_id = uuid::Uuid::new_v4().to_string();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    ensure_sessions_root(vault_root)?;
    let dest_dir = storage_session_dir(vault_root, &new_session_id);
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
        runtime_id: source_meta.runtime_id,
        model_id: source_meta.model_id,
        mode_id: source_meta.mode_id,
        models: source_meta.models,
        modes: source_meta.modes,
        config_options: source_meta.config_options,
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
            "vaultai-history-test-{}-{suffix}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn sample_history() -> PersistedSessionHistory {
        PersistedSessionHistory {
            version: 1,
            session_id: "session-1".to_string(),
            runtime_id: Some("codex-acp".to_string()),
            model_id: "test-model".to_string(),
            mode_id: "default".to_string(),
            models: None,
            modes: None,
            config_options: None,
            created_at: 10,
            updated_at: 20,
            start_index: Some(0),
            message_count: Some(2),
            title: Some("Hello".to_string()),
            preview: Some("Assistant reply".to_string()),
            messages: vec![
                PersistedMessage {
                    id: "user:1".to_string(),
                    role: "user".to_string(),
                    kind: "text".to_string(),
                    content: "Hello".to_string(),
                    timestamp: 10,
                    title: None,
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    plan_entries: None,
                    plan_detail: None,
                },
                PersistedMessage {
                    id: "assistant:1".to_string(),
                    role: "assistant".to_string(),
                    kind: "text".to_string(),
                    content: "Assistant reply".to_string(),
                    timestamp: 20,
                    title: None,
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    plan_entries: None,
                    plan_detail: None,
                },
            ],
        }
    }

    fn sample_history_with_session_id(session_id: &str) -> PersistedSessionHistory {
        let mut history = sample_history();
        history.session_id = session_id.to_string();
        history
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
        let sibling = dir.join(".vaultai/keep.txt");

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
        let sibling = dir.join(".vaultai/keep-after-prune.txt");

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
            runtime_id: Some("codex-acp".to_string()),
            model_id: "test-model".to_string(),
            mode_id: "default".to_string(),
            models: None,
            modes: None,
            config_options: None,
            created_at: 10,
            updated_at: 30,
            start_index: Some(1),
            message_count: Some(3),
            title: Some("Hello".to_string()),
            preview: Some("Plan: Next step".to_string()),
            messages: vec![
                PersistedMessage {
                    id: "assistant:1".to_string(),
                    role: "assistant".to_string(),
                    kind: "text".to_string(),
                    content: "Assistant reply (edited)".to_string(),
                    timestamp: 20,
                    title: None,
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    plan_entries: None,
                    plan_detail: None,
                },
                PersistedMessage {
                    id: "plan:1".to_string(),
                    role: "assistant".to_string(),
                    kind: "plan".to_string(),
                    content: "Next step".to_string(),
                    timestamp: 30,
                    title: Some("Plan".to_string()),
                    meta: None,
                    permission_request_id: None,
                    permission_options: None,
                    diffs: None,
                    user_input_request_id: None,
                    user_input_questions: None,
                    plan_entries: None,
                    plan_detail: Some("Do the thing".to_string()),
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
            title: Some("Reply".to_string()),
            meta: Some(serde_json::json!({
                "status": "completed",
            })),
            permission_request_id: None,
            permission_options: None,
            diffs: None,
            user_input_request_id: None,
            user_input_questions: None,
            plan_entries: None,
            plan_detail: None,
        };
        let permission = PersistedMessage {
            id: "permission:1".to_string(),
            role: "assistant".to_string(),
            kind: "permission".to_string(),
            content: "Edit watcher.rs".to_string(),
            timestamp: 30,
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
            user_input_request_id: None,
            user_input_questions: None,
            plan_entries: None,
            plan_detail: None,
        };
        let user_input = PersistedMessage {
            id: "input:1".to_string(),
            role: "assistant".to_string(),
            kind: "user_input_request".to_string(),
            content: "Need confirmation".to_string(),
            timestamp: 40,
            title: Some("Input requested".to_string()),
            meta: Some(serde_json::json!({
                "status": "pending",
            })),
            permission_request_id: None,
            permission_options: None,
            diffs: None,
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
            plan_entries: None,
            plan_detail: None,
        };
        let plan = PersistedMessage {
            id: "plan:1".to_string(),
            role: "assistant".to_string(),
            kind: "plan".to_string(),
            content: "Confirm restore".to_string(),
            timestamp: 50,
            title: Some("Plan".to_string()),
            meta: None,
            permission_request_id: None,
            permission_options: None,
            diffs: None,
            user_input_request_id: None,
            user_input_questions: None,
            plan_entries: Some(serde_json::json!([
                {
                    "content": "Confirm restore",
                    "priority": "high",
                    "status": "in_progress"
                }
            ])),
            plan_detail: Some("Verify all message fields survive paging.".to_string()),
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
            runtime_id: Some("codex-acp".to_string()),
            model_id: "test-model".to_string(),
            mode_id: "default".to_string(),
            models: None,
            modes: None,
            config_options: None,
            created_at: 10,
            updated_at: 50,
            start_index: Some(1),
            message_count: Some(expected_messages.len()),
            title: Some("Hello".to_string()),
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
}
