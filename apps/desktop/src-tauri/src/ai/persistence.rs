use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::write_json_atomic;

const SESSIONS_DIR: &str = ".vaultai/sessions";

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSessionHistory {
    pub version: u32,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    pub model_id: String,
    pub mode_id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<PersistedMessage>,
}

fn sessions_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(SESSIONS_DIR)
}

fn session_file(vault_root: &Path, session_id: &str) -> PathBuf {
    sessions_dir(vault_root).join(format!("{session_id}.json"))
}

pub fn save_session_history(
    vault_root: &Path,
    history: &PersistedSessionHistory,
) -> Result<(), String> {
    let path = session_file(vault_root, &history.session_id);
    write_json_atomic(&path, history)
}

pub fn delete_session_history(vault_root: &Path, session_id: &str) -> Result<(), String> {
    let path = session_file(vault_root, session_id);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
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
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let history = match serde_json::from_str::<PersistedSessionHistory>(&raw) {
            Ok(history) if history.version == 1 => history,
            _ => continue,
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
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        match serde_json::from_str::<PersistedSessionHistory>(&raw) {
            Ok(history) if history.version == 1 => histories.push(history),
            _ => continue,
        }
    }

    histories.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(histories)
}
