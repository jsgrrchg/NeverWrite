use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
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
    preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedTranscriptIndex {
    version: u32,
    message_offsets: Vec<u64>,
    message_lengths: Vec<u64>,
    message_hashes: Vec<String>,
}

fn sessions_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(SESSIONS_DIR)
}

fn legacy_session_file(vault_root: &Path, session_id: &str) -> PathBuf {
    sessions_dir(vault_root).join(format!("{session_id}.json"))
}

fn session_dir(vault_root: &Path, session_id: &str) -> PathBuf {
    sessions_dir(vault_root).join(session_id)
}

fn session_meta_file(vault_root: &Path, session_id: &str) -> PathBuf {
    session_dir(vault_root, session_id).join(SESSION_META_FILE)
}

fn session_index_file(vault_root: &Path, session_id: &str) -> PathBuf {
    session_dir(vault_root, session_id).join(SESSION_INDEX_FILE)
}

fn session_transcript_file(vault_root: &Path, session_id: &str) -> PathBuf {
    session_dir(vault_root, session_id).join(SESSION_TRANSCRIPT_FILE)
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
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Ok(hex)
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn load_session_metadata(
    vault_root: &Path,
    session_id: &str,
) -> Result<PersistedSessionMetadata, String> {
    read_json_file(&session_meta_file(vault_root, session_id))
}

fn load_session_index(
    vault_root: &Path,
    session_id: &str,
) -> Result<PersistedTranscriptIndex, String> {
    read_json_file(&session_index_file(vault_root, session_id))
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
        preview: history
            .preview
            .clone()
            .or_else(|| derive_preview(&history.messages)),
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
        preview: metadata.preview,
        messages,
    }
}

fn load_legacy_history(
    vault_root: &Path,
    session_id: &str,
) -> Result<Option<PersistedSessionHistory>, String> {
    let path = legacy_session_file(vault_root, session_id);
    if !path.exists() {
        return Ok(None);
    }

    let history = read_json_file::<PersistedSessionHistory>(&path)?;
    Ok(Some(PersistedSessionHistory {
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
        preview: history
            .preview
            .or_else(|| derive_preview(&history.messages)),
        messages: history.messages,
    }))
}

fn remove_legacy_history_file(vault_root: &Path, session_id: &str) -> Result<(), String> {
    let legacy_path = legacy_session_file(vault_root, session_id);
    if legacy_path.exists() {
        fs::remove_file(legacy_path).map_err(|e| e.to_string())?;
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
    let session_dir = session_dir(vault_root, &history.session_id);
    fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;

    let transcript_path = session_transcript_file(vault_root, &history.session_id);
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

    write_json_atomic(
        &session_meta_file(vault_root, &history.session_id),
        &metadata,
    )?;
    write_json_atomic(&session_index_file(vault_root, &history.session_id), &index)?;
    remove_legacy_history_file(vault_root, &history.session_id)?;

    Ok(())
}

fn ensure_lazy_session_from_legacy(vault_root: &Path, session_id: &str) -> Result<(), String> {
    if session_meta_file(vault_root, session_id).exists()
        && session_index_file(vault_root, session_id).exists()
        && session_transcript_file(vault_root, session_id).exists()
    {
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
    let metadata = load_session_metadata(vault_root, session_id)?;
    let index = load_session_index(vault_root, session_id)?;
    validate_index(&index)?;

    let total_messages = metadata.message_count;
    let start = start_index.min(total_messages);
    let end = start.saturating_add(limit).min(total_messages);

    let mut transcript =
        File::open(session_transcript_file(vault_root, session_id)).map_err(|e| e.to_string())?;
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

fn load_all_lazy_messages(
    vault_root: &Path,
    session_id: &str,
) -> Result<Vec<PersistedMessage>, String> {
    let metadata = load_session_metadata(vault_root, session_id)?;
    if metadata.message_count == 0 {
        return Ok(vec![]);
    }

    Ok(load_lazy_history_page(vault_root, session_id, 0, metadata.message_count)?.messages)
}

pub fn save_session_history(
    vault_root: &Path,
    history: &PersistedSessionHistory,
) -> Result<(), String> {
    ensure_lazy_session_from_legacy(vault_root, &history.session_id)?;
    let (start_index, total_count) = history_window_bounds(history)?;

    let metadata_path = session_meta_file(vault_root, &history.session_id);
    let index_path = session_index_file(vault_root, &history.session_id);
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
        let transcript_path = session_transcript_file(vault_root, &history.session_id);
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
    remove_legacy_history_file(vault_root, &history.session_id)?;

    Ok(())
}

pub fn load_session_history_page(
    vault_root: &Path,
    session_id: &str,
    start_index: usize,
    limit: usize,
) -> Result<PersistedSessionHistoryPage, String> {
    ensure_lazy_session_from_legacy(vault_root, session_id)?;

    if session_meta_file(vault_root, session_id).exists()
        && session_index_file(vault_root, session_id).exists()
        && session_transcript_file(vault_root, session_id).exists()
    {
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
    let legacy_path = legacy_session_file(vault_root, session_id);
    if legacy_path.exists() {
        fs::remove_file(&legacy_path).map_err(|e| e.to_string())?;
    }

    let dir = session_dir(vault_root, session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }

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
            let session_id = match path.file_name().and_then(|name| name.to_str()) {
                Some(value) => value,
                None => continue,
            };
            let metadata = match load_session_metadata(vault_root, session_id) {
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
    let mut histories = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if path.is_dir() {
            let session_id = match path.file_name().and_then(|name| name.to_str()) {
                Some(value) => value,
                None => continue,
            };

            let metadata = match load_session_metadata(vault_root, session_id) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };

            let messages = if include_messages {
                match load_all_lazy_messages(vault_root, session_id) {
                    Ok(messages) => messages,
                    Err(_) => continue,
                }
            } else {
                vec![]
            };

            histories.push(history_from_metadata(metadata, messages));
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

        if include_messages {
            histories.push(PersistedSessionHistory {
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
                preview: history
                    .preview
                    .or_else(|| derive_preview(&history.messages)),
                messages: history.messages,
            });
        } else {
            let message_count = history.messages.len();
            histories.push(PersistedSessionHistory {
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
                preview: history
                    .preview
                    .or_else(|| derive_preview(&history.messages)),
                messages: vec![],
            });
        }
    }

    histories.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(histories)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("vaultai-history-test-{suffix}"));
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
