use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use agent_client_protocol::schema::{
    Diff, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use serde::Deserialize;

use crate::{AiFileDiffHunkPayload, AiFileDiffPayload};

const FILE_DELETED_PLACEHOLDER: &str = "[file deleted]";
const ACP_DIFF_PREVIOUS_PATH_KEY: &str = "neverwritePreviousPath";
const ACP_DIFF_HUNKS_KEY: &str = "neverwriteHunks";

#[derive(Debug, Clone, Default)]
pub struct ToolDiffState {
    calls: Arc<Mutex<HashMap<String, ToolCall>>>,
    session_cwds: Arc<Mutex<HashMap<String, PathBuf>>>,
    write_diffs: Arc<Mutex<HashMap<String, Vec<AiFileDiffPayload>>>>,
    /// Key: "session_id::display_path"; value: file content before agent writes.
    file_baselines: Arc<Mutex<HashMap<String, String>>>,
}

impl ToolDiffState {
    pub fn register_session_cwd(&self, session_id: &str, cwd: PathBuf) {
        if let Ok(mut guard) = self.session_cwds.lock() {
            guard.insert(session_id.to_string(), cwd);
        }
    }

    pub fn upsert_tool_call(&self, session_id: &str, tool_call: ToolCall) -> ToolCall {
        let key = call_key(session_id, &tool_call.tool_call_id.0);
        if let Ok(mut guard) = self.calls.lock() {
            guard.insert(key, tool_call.clone());
        }

        self.cache_read_baseline(session_id, &tool_call);
        self.capture_write_diff(
            session_id,
            &tool_call.tool_call_id.0,
            tool_call.raw_input.as_ref(),
        );
        self.cache_content_diffs(session_id, &tool_call);
        if tool_call.status == ToolCallStatus::Completed {
            self.advance_baseline_after_success(session_id, tool_call.raw_input.as_ref());
        }

        tool_call
    }

    pub fn apply_tool_update(&self, session_id: &str, update: ToolCallUpdate) -> Option<ToolCall> {
        self.capture_write_diff(
            session_id,
            &update.tool_call_id.0,
            update.fields.raw_input.as_ref(),
        );

        let key = call_key(session_id, &update.tool_call_id.0);
        let mut guard = self.calls.lock().ok()?;
        let tool_call = if let Some(existing) = guard.get_mut(&key) {
            existing.update(update.fields);
            existing.clone()
        } else {
            let tool_call = ToolCall::try_from(update).ok()?;
            guard.insert(key, tool_call.clone());
            tool_call
        };
        drop(guard);

        self.cache_content_diffs(session_id, &tool_call);
        self.cache_read_baseline(session_id, &tool_call);
        if tool_call.status == ToolCallStatus::Completed {
            self.advance_baseline_after_success(session_id, tool_call.raw_input.as_ref());
        }

        Some(tool_call)
    }

    pub fn register_file_baseline(&self, session_id: &str, display_path: &str, content: String) {
        let display_path = self.normalize_display_path(session_id, display_path);
        let key = baseline_key(session_id, &display_path);
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.insert(key, content);
        }
    }

    pub fn normalized_diffs_for_tool_call(
        &self,
        session_id: &str,
        tool_call: &ToolCall,
    ) -> Vec<AiFileDiffPayload> {
        let cwd = self.session_cwd(session_id);
        let actual = collect_tool_call_diffs(tool_call, cwd.as_deref());

        if tool_call.status != ToolCallStatus::Failed {
            if let Some(cached) = self.cached_diffs(session_id, &tool_call.tool_call_id.0) {
                if !cached.is_empty() {
                    return cached;
                }
            }
        }

        actual
    }

    pub fn clear_session(&self, session_id: &str) {
        let prefix = format!("{session_id}::");

        if let Ok(mut guard) = self.calls.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.write_diffs.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut guard) = self.session_cwds.lock() {
            guard.remove(session_id);
        }
    }

    pub fn clear_all(&self) {
        if let Ok(mut guard) = self.calls.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.session_cwds.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.write_diffs.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.file_baselines.lock() {
            guard.clear();
        }
    }

    pub fn absolute_path_for_display_path(&self, session_id: &str, display_path: &str) -> PathBuf {
        resolve_tool_path(display_path, self.session_cwd(session_id).as_deref())
    }

    fn session_cwd(&self, session_id: &str) -> Option<PathBuf> {
        self.session_cwds
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
    }

    fn cached_diffs(&self, session_id: &str, tool_call_id: &str) -> Option<Vec<AiFileDiffPayload>> {
        self.write_diffs
            .lock()
            .ok()
            .and_then(|guard| guard.get(&call_key(session_id, tool_call_id)).cloned())
    }

    fn normalize_display_path(&self, session_id: &str, display_path: &str) -> String {
        let cwd = self.session_cwd(session_id);
        let resolved = resolve_tool_path(display_path, cwd.as_deref());
        to_display_path(&resolved, cwd.as_deref())
    }

    fn capture_write_diff(
        &self,
        session_id: &str,
        tool_call_id: &str,
        raw_input: Option<&serde_json::Value>,
    ) {
        let Some(raw_input) = raw_input else {
            return;
        };
        let cwd = self.session_cwd(session_id);

        let diff = self
            .reconstruct_with_baseline(session_id, raw_input, cwd.as_deref())
            .or_else(|| reconstruct_write_diff_payload(raw_input, cwd.as_deref()))
            .or_else(|| reconstruct_edit_diff_payload(raw_input, cwd.as_deref()));

        let Some(diff) = diff else {
            return;
        };

        if let Ok(mut guard) = self.write_diffs.lock() {
            guard
                .entry(call_key(session_id, tool_call_id))
                .or_insert(vec![diff]);
        }
    }

    fn cache_content_diffs(&self, session_id: &str, tool_call: &ToolCall) {
        let cwd = self.session_cwd(session_id);
        let diffs = collect_tool_call_diffs(tool_call, cwd.as_deref());
        if diffs.is_empty() {
            return;
        }

        let key = call_key(session_id, &tool_call.tool_call_id.0);
        if let Ok(mut guard) = self.write_diffs.lock() {
            let has_old_text = diffs.iter().any(|diff| diff.old_text.is_some());
            let existing_is_reliable = guard
                .get(&key)
                .map(|cached| {
                    cached
                        .iter()
                        .any(|diff| diff.old_text.is_some() && diff.reversible)
                })
                .unwrap_or(false);

            if existing_is_reliable {
                return;
            }

            if has_old_text {
                guard.insert(key, diffs);
            } else {
                guard.entry(key).or_insert(diffs);
            }
        }
    }

    fn cache_read_baseline(&self, session_id: &str, tool_call: &ToolCall) {
        if tool_call.kind != ToolKind::Read || tool_call.status != ToolCallStatus::Completed {
            return;
        }

        let Some(input) = read_tool_input(tool_call.raw_input.as_ref()) else {
            return;
        };
        if input.file_path.trim().is_empty() {
            return;
        }

        let cwd = self.session_cwd(session_id);
        let resolved = resolve_tool_path(&input.file_path, cwd.as_deref());
        let display_path = to_display_path(&resolved, cwd.as_deref());
        let content = match read_existing_text_snapshot(&resolved) {
            ExistingTextSnapshot::Text(text) => text,
            _ => return,
        };

        if let Ok(mut guard) = self.file_baselines.lock() {
            guard
                .entry(baseline_key(session_id, &display_path))
                .or_insert(content);
        }
    }

    fn get_file_baseline(&self, session_id: &str, display_path: &str) -> Option<String> {
        self.file_baselines
            .lock()
            .ok()?
            .get(&baseline_key(session_id, display_path))
            .cloned()
    }

    fn reconstruct_with_baseline(
        &self,
        session_id: &str,
        raw_input: &serde_json::Value,
        cwd: Option<&Path>,
    ) -> Option<AiFileDiffPayload> {
        if let Some(input) = write_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return None;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd);
            let display_path = to_display_path(&resolved, cwd);
            let old_text = self.get_file_baseline(session_id, &display_path)?;
            if old_text == input.content {
                return None;
            }

            return Some(AiFileDiffPayload {
                path: display_path,
                kind: "update".to_string(),
                previous_path: None,
                reversible: true,
                is_text: true,
                old_text: Some(old_text),
                new_text: Some(input.content),
                hunks: None,
            });
        }

        if let Some(input) = edit_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return None;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd);
            let display_path = to_display_path(&resolved, cwd);
            let old_text = self.get_file_baseline(session_id, &display_path)?;
            let new_text = replace_exactly_once(&old_text, &input.old_string, &input.new_string)?;

            return Some(AiFileDiffPayload {
                path: display_path,
                kind: "update".to_string(),
                previous_path: None,
                reversible: true,
                is_text: true,
                old_text: Some(old_text),
                new_text: Some(new_text),
                hunks: None,
            });
        }

        None
    }

    fn advance_baseline_after_success(
        &self,
        session_id: &str,
        raw_input: Option<&serde_json::Value>,
    ) {
        let Some(raw_input) = raw_input else {
            return;
        };
        let cwd = self.session_cwd(session_id);

        if let Some(input) = write_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd.as_deref());
            let display_path = to_display_path(&resolved, cwd.as_deref());
            self.register_file_baseline(session_id, &display_path, input.content);
        } else if let Some(input) = edit_tool_input(Some(raw_input)) {
            if input.file_path.trim().is_empty() {
                return;
            }
            let resolved = resolve_tool_path(&input.file_path, cwd.as_deref());
            let display_path = to_display_path(&resolved, cwd.as_deref());
            if let ExistingTextSnapshot::Text(new_content) = read_existing_text_snapshot(&resolved)
            {
                self.register_file_baseline(session_id, &display_path, new_content);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct WriteToolInput {
    file_path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct EditToolInput {
    file_path: String,
    old_string: String,
    new_string: String,
}

#[derive(Debug, Deserialize)]
struct ReadToolInput {
    file_path: String,
}

enum ExistingTextSnapshot {
    Missing,
    Text(String),
    Unavailable,
}

pub fn collect_tool_call_diffs(tool_call: &ToolCall, cwd: Option<&Path>) -> Vec<AiFileDiffPayload> {
    tool_call
        .content
        .iter()
        .filter_map(|item| match item {
            ToolCallContent::Diff(diff) => {
                Some(map_diff_payload(diff, tool_call.raw_input.as_ref(), cwd))
            }
            _ => None,
        })
        .collect()
}

fn call_key(session_id: &str, tool_call_id: &str) -> String {
    format!("{session_id}::{tool_call_id}")
}

fn baseline_key(session_id: &str, display_path: &str) -> String {
    format!("{session_id}::{display_path}")
}

fn write_tool_input(raw_input: Option<&serde_json::Value>) -> Option<WriteToolInput> {
    serde_json::from_value(raw_input?.clone()).ok()
}

fn edit_tool_input(raw_input: Option<&serde_json::Value>) -> Option<EditToolInput> {
    serde_json::from_value(raw_input?.clone()).ok()
}

fn read_tool_input(raw_input: Option<&serde_json::Value>) -> Option<ReadToolInput> {
    serde_json::from_value(raw_input?.clone()).ok()
}

fn is_edit_tool_input(raw_input: Option<&serde_json::Value>) -> bool {
    let Some(raw_input) = raw_input else {
        return false;
    };
    let Some(object) = raw_input.as_object() else {
        return false;
    };
    object.contains_key("file_path")
        && (object.contains_key("old_string") || object.contains_key("new_string"))
}

fn resolve_tool_path(file_path: &str, cwd: Option<&Path>) -> PathBuf {
    let candidate = PathBuf::from(file_path);
    if candidate.is_absolute() {
        candidate
    } else if let Some(cwd) = cwd {
        cwd.join(candidate)
    } else {
        candidate
    }
}

fn to_display_path(file_path: &Path, cwd: Option<&Path>) -> String {
    let Some(cwd) = cwd else {
        return file_path.to_string_lossy().to_string();
    };

    if file_path.is_absolute() && file_path.starts_with(cwd) {
        if let Ok(relative) = file_path.strip_prefix(cwd) {
            return relative.to_string_lossy().to_string();
        }
    }

    file_path.to_string_lossy().to_string()
}

fn read_existing_text_snapshot(path: &Path) -> ExistingTextSnapshot {
    match fs::read(path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => ExistingTextSnapshot::Text(text),
            Err(_) => ExistingTextSnapshot::Unavailable,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ExistingTextSnapshot::Missing,
        Err(_) => ExistingTextSnapshot::Unavailable,
    }
}

fn replace_exactly_once(text: &str, needle: &str, replacement: &str) -> Option<String> {
    if needle.is_empty() {
        return None;
    }

    let mut matches = text.match_indices(needle);
    let (first_index, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }

    let mut result =
        String::with_capacity(text.len() + replacement.len().saturating_sub(needle.len()));
    result.push_str(&text[..first_index]);
    result.push_str(replacement);
    result.push_str(&text[first_index + needle.len()..]);
    Some(result)
}

fn reconstruct_write_diff_payload(
    raw_input: &serde_json::Value,
    cwd: Option<&Path>,
) -> Option<AiFileDiffPayload> {
    let input = write_tool_input(Some(raw_input))?;
    if input.file_path.trim().is_empty() {
        return None;
    }

    let resolved_path = resolve_tool_path(&input.file_path, cwd);
    let display_path = to_display_path(&resolved_path, cwd);
    let diff = match read_existing_text_snapshot(&resolved_path) {
        ExistingTextSnapshot::Missing => AiFileDiffPayload {
            path: display_path,
            kind: "add".to_string(),
            previous_path: None,
            reversible: true,
            is_text: true,
            old_text: None,
            new_text: Some(input.content),
            hunks: None,
        },
        ExistingTextSnapshot::Text(old_text) => {
            if old_text == input.content {
                AiFileDiffPayload {
                    path: display_path,
                    kind: "update".to_string(),
                    previous_path: None,
                    reversible: false,
                    is_text: true,
                    old_text: None,
                    new_text: Some(input.content),
                    hunks: None,
                }
            } else {
                AiFileDiffPayload {
                    path: display_path,
                    kind: "update".to_string(),
                    previous_path: None,
                    reversible: true,
                    is_text: true,
                    old_text: Some(old_text),
                    new_text: Some(input.content),
                    hunks: None,
                }
            }
        }
        ExistingTextSnapshot::Unavailable => AiFileDiffPayload {
            path: display_path,
            kind: "update".to_string(),
            previous_path: None,
            reversible: false,
            is_text: false,
            old_text: None,
            new_text: Some(input.content),
            hunks: None,
        },
    };

    Some(diff)
}

fn reconstruct_edit_diff_payload(
    raw_input: &serde_json::Value,
    cwd: Option<&Path>,
) -> Option<AiFileDiffPayload> {
    let input = edit_tool_input(Some(raw_input))?;
    if input.file_path.trim().is_empty() {
        return None;
    }

    let resolved_path = resolve_tool_path(&input.file_path, cwd);
    let display_path = to_display_path(&resolved_path, cwd);
    let current_text = match read_existing_text_snapshot(&resolved_path) {
        ExistingTextSnapshot::Text(text) => text,
        _ => return None,
    };
    let old_text = replace_exactly_once(&current_text, &input.new_string, &input.old_string)?;

    Some(AiFileDiffPayload {
        path: display_path,
        kind: "update".to_string(),
        previous_path: None,
        reversible: true,
        is_text: true,
        old_text: Some(old_text),
        new_text: Some(current_text),
        hunks: None,
    })
}

fn diff_previous_path(diff: &Diff, cwd: Option<&Path>) -> Option<String> {
    diff.meta
        .as_ref()
        .and_then(|meta| meta.get(ACP_DIFF_PREVIOUS_PATH_KEY))
        .and_then(|value| value.as_str())
        .map(|path| to_display_path(&resolve_tool_path(path, cwd), cwd))
}

fn diff_hunks(diff: &Diff) -> Option<Vec<AiFileDiffHunkPayload>> {
    diff.meta
        .as_ref()
        .and_then(|meta| meta.get(ACP_DIFF_HUNKS_KEY))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .filter(|hunks: &Vec<AiFileDiffHunkPayload>| !hunks.is_empty())
}

fn has_reliable_old_text(old_text: Option<&str>) -> bool {
    matches!(old_text, Some(text) if text != FILE_DELETED_PLACEHOLDER)
}

fn classify_diff_kind(
    diff: &Diff,
    raw_input: Option<&serde_json::Value>,
    previous_path: Option<&String>,
) -> &'static str {
    if previous_path.is_some() {
        return "move";
    }
    if is_edit_tool_input(raw_input) {
        return "update";
    }
    if write_tool_input(raw_input).is_some() {
        return if diff.old_text.is_none() {
            "add"
        } else {
            "update"
        };
    }
    if diff.old_text.is_none() {
        "add"
    } else if diff.new_text.is_empty() {
        "delete"
    } else {
        "update"
    }
}

fn map_diff_payload(
    diff: &Diff,
    raw_input: Option<&serde_json::Value>,
    cwd: Option<&Path>,
) -> AiFileDiffPayload {
    let previous_path = diff_previous_path(diff, cwd);
    let old_text = diff.old_text.as_deref();
    let kind = classify_diff_kind(diff, raw_input, previous_path.as_ref());
    let text_changed = old_text
        .map(|text| text != diff.new_text)
        .unwrap_or(!diff.new_text.is_empty());
    let reversible = match kind {
        "add" => true,
        "delete" | "update" => has_reliable_old_text(old_text),
        "move" => previous_path.is_some() && (!text_changed || has_reliable_old_text(old_text)),
        _ => false,
    };

    AiFileDiffPayload {
        path: to_display_path(&diff.path, cwd),
        kind: kind.to_string(),
        previous_path,
        reversible,
        is_text: true,
        old_text: diff.old_text.clone(),
        new_text: if kind == "delete" {
            None
        } else {
            Some(diff.new_text.clone())
        },
        hunks: diff_hunks(diff),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use agent_client_protocol::schema::{
        Content, Diff, Meta, ToolCallContent, ToolCallId, ToolCallStatus, ToolCallUpdate,
        ToolCallUpdateFields,
    };

    use super::*;

    fn unique_temp_dir() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("neverwrite-tool-diffs-{suffix}"))
    }

    #[test]
    fn content_diff_maps_add_update_delete_and_move() {
        let state = ToolDiffState::default();
        let call = ToolCall::new(ToolCallId::from("tool-1"), "Edit files")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![
                ToolCallContent::Diff(Diff::new("/tmp/update.md", "new").old_text("old")),
                ToolCallContent::Diff(Diff::new("/tmp/add.md", "new")),
                ToolCallContent::Diff(Diff::new("/tmp/delete.md", "").old_text("old")),
                ToolCallContent::Diff(Diff::new("/tmp/new.md", "moved").old_text("moved").meta(
                    Meta::from_iter([(
                        ACP_DIFF_PREVIOUS_PATH_KEY.to_string(),
                        serde_json::json!("/tmp/old.md"),
                    )]),
                )),
            ]);

        let diffs = state.normalized_diffs_for_tool_call("session-1", &call);

        assert_eq!(diffs.len(), 4);
        assert_eq!(diffs[0].kind, "update");
        assert_eq!(diffs[1].kind, "add");
        assert_eq!(diffs[2].kind, "delete");
        assert_eq!(diffs[2].new_text, None);
        assert_eq!(diffs[3].kind, "move");
        assert_eq!(diffs[3].previous_path.as_deref(), Some("/tmp/old.md"));
    }

    #[test]
    fn content_diff_extracts_hunks_from_meta() {
        let call = ToolCall::new(ToolCallId::from("tool-1"), "Edit file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/tmp/file.md", "new")
                    .old_text("old")
                    .meta(Meta::from_iter([(
                        ACP_DIFF_HUNKS_KEY.to_string(),
                        serde_json::json!([
                            {
                                "old_start": 1,
                                "old_count": 1,
                                "new_start": 1,
                                "new_count": 1,
                                "lines": [
                                    { "type": "remove", "text": "old" },
                                    { "type": "add", "text": "new" }
                                ]
                            }
                        ]),
                    )])),
            )]);

        let diffs = collect_tool_call_diffs(&call, None);

        let hunk = diffs[0].hunks.as_ref().unwrap().first().unwrap();
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.lines.len(), 2);
    }

    #[test]
    fn write_over_existing_file_produces_reversible_update() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("hello.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "old content").unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());

        let call = ToolCall::new(ToolCallId::from("tool-write"), "Write hello.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "notes/hello.md",
                "content": "new content",
            }));
        let registered = state.upsert_tool_call("session-1", call);

        let diffs = state.normalized_diffs_for_tool_call("session-1", &registered);
        assert_eq!(diffs[0].path, "notes/hello.md");
        assert_eq!(diffs[0].kind, "update");
        assert!(diffs[0].reversible);
        assert_eq!(diffs[0].old_text.as_deref(), Some("old content"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new content"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn write_missing_file_produces_reversible_add() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        fs::create_dir_all(temp_dir.join("notes")).unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());

        let call = ToolCall::new(ToolCallId::from("tool-write"), "Write new.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "notes/new.md",
                "content": "created",
            }));
        let registered = state.upsert_tool_call("session-1", call);

        let diffs = state.normalized_diffs_for_tool_call("session-1", &registered);
        assert_eq!(diffs[0].kind, "add");
        assert!(diffs[0].reversible);
        assert_eq!(diffs[0].old_text, None);
        assert_eq!(diffs[0].new_text.as_deref(), Some("created"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn edit_raw_input_reconstructs_from_post_write_file() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("app.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "fn main() { new_code(); }\n").unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());

        let call = ToolCall::new(ToolCallId::from("tool-edit"), "Edit app.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "src/app.rs",
                "old_string": "old_code()",
                "new_string": "new_code()",
            }));
        let registered = state.upsert_tool_call("session-1", call);

        let diffs = state.normalized_diffs_for_tool_call("session-1", &registered);
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some("fn main() { old_code(); }\n")
        );
        assert_eq!(
            diffs[0].new_text.as_deref(),
            Some("fn main() { new_code(); }\n")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn ambiguous_edit_raw_input_does_not_cache_unreliable_diff() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("src").join("app.rs");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "new_code();\nnew_code();\n").unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());

        let call = ToolCall::new(ToolCallId::from("tool-edit"), "Edit app.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "src/app.rs",
                "old_string": "old_code()",
                "new_string": "new_code()",
            }));
        let registered = state.upsert_tool_call("session-1", call);

        assert!(state
            .normalized_diffs_for_tool_call("session-1", &registered)
            .is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn read_before_write_uses_baseline_instead_of_post_write_disk() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("hello.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "original").unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());

        let read_call = ToolCall::new(ToolCallId::from("tool-read"), "Read hello.md")
            .kind(ToolKind::Read)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({ "file_path": "notes/hello.md" }))
            .content(vec![ToolCallContent::Content(Content::new("original"))]);
        state.upsert_tool_call("session-1", read_call);

        fs::write(&file_path, "updated").unwrap();
        let write_call = ToolCall::new(ToolCallId::from("tool-write"), "Write hello.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "notes/hello.md",
                "content": "updated",
            }));
        let registered = state.upsert_tool_call("session-1", write_call);

        let diffs = state.normalized_diffs_for_tool_call("session-1", &registered);
        assert_eq!(diffs[0].old_text.as_deref(), Some("original"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("updated"));
        assert!(diffs[0].reversible);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn consecutive_edits_advance_baseline() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("hello.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "version 1").unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());
        state.register_file_baseline("session-1", "notes/hello.md", "version 1".to_string());

        let first = ToolCall::new(ToolCallId::from("tool-1"), "Write hello.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "notes/hello.md",
                "content": "version 2",
            }));
        let first = state.upsert_tool_call("session-1", first);
        assert_eq!(
            state.normalized_diffs_for_tool_call("session-1", &first)[0]
                .old_text
                .as_deref(),
            Some("version 1")
        );

        fs::write(&file_path, "version 3").unwrap();
        let second = ToolCall::new(ToolCallId::from("tool-2"), "Write hello.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "notes/hello.md",
                "content": "version 3",
            }));
        let second = state.upsert_tool_call("session-1", second);

        assert_eq!(
            state.normalized_diffs_for_tool_call("session-1", &second)[0]
                .old_text
                .as_deref(),
            Some("version 2")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn reliable_baseline_diff_is_not_overwritten_by_weaker_acp_diff() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("notes").join("hello.md");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, "old").unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());
        state.register_file_baseline("session-1", "notes/hello.md", "old".to_string());

        let initial = ToolCall::new(ToolCallId::from("tool-write"), "Write hello.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({
                "file_path": "notes/hello.md",
                "content": "new",
            }));
        state.upsert_tool_call("session-1", initial);

        let update = ToolCallUpdate::new(
            "tool-write",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::Diff(Diff::new(
                    "notes/hello.md",
                    "new",
                ))]),
        );
        let completed = state.apply_tool_update("session-1", update).unwrap();

        let diffs = state.normalized_diffs_for_tool_call("session-1", &completed);
        assert_eq!(diffs[0].old_text.as_deref(), Some("old"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("new"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn binary_existing_file_produces_non_text_non_reversible_update() {
        let state = ToolDiffState::default();
        let temp_dir = unique_temp_dir();
        let file_path = temp_dir.join("blob.bin");
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(&file_path, vec![0xff, 0xfe]).unwrap();
        state.register_session_cwd("session-1", temp_dir.clone());

        let call = ToolCall::new(ToolCallId::from("tool-write"), "Write blob.bin")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({
                "file_path": "blob.bin",
                "content": "text now",
            }));
        let registered = state.upsert_tool_call("session-1", call);

        let diffs = state.normalized_diffs_for_tool_call("session-1", &registered);
        assert!(!diffs[0].is_text);
        assert!(!diffs[0].reversible);

        let _ = fs::remove_dir_all(temp_dir);
    }
}
