use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use agent_client_protocol::schema::v1::{
    Diff, Meta, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use serde::Deserialize;

use crate::{AiFileDiffHunkPayload, AiFileDiffPayload};

const FILE_DELETED_PLACEHOLDER: &str = "[file deleted]";
const ACP_DIFF_PREVIOUS_PATH_KEY: &str = "neverwritePreviousPath";
const ACP_DIFF_HUNKS_KEY: &str = "neverwriteHunks";
const CLAUDE_CODE_META_KEY: &str = "claudeCode";
const CLAUDE_CODE_TOOL_NAME_KEY: &str = "toolName";
const CLAUDE_CODE_TOOL_RESPONSE_KEY: &str = "toolResponse";
const CLAUDE_CODE_STRUCTURED_PATCH_KEY: &str = "structuredPatch";
const CLAUDE_CODE_FILE_PATH_KEY: &str = "filePath";
const CLAUDE_NO_NEWLINE_MARKER: &str = "\\ No newline at end of file";

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
        let became_completed = if let Ok(mut guard) = self.calls.lock() {
            let was_completed = guard
                .get(&key)
                .is_some_and(|existing| existing.status == ToolCallStatus::Completed);
            guard.insert(key, tool_call.clone());
            tool_call.status == ToolCallStatus::Completed && !was_completed
        } else {
            false
        };

        self.cache_read_baseline(session_id, &tool_call);
        self.capture_write_diff(
            session_id,
            &tool_call.tool_call_id.0,
            tool_call.raw_input.as_ref(),
        );
        self.cache_content_diffs(session_id, &tool_call);
        if became_completed {
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
        let update_meta = update.meta.clone();
        let mut guard = self.calls.lock().ok()?;
        let tool_call = if let Some(existing) = guard.get_mut(&key) {
            let was_completed = existing.status == ToolCallStatus::Completed;
            existing.update(update.fields);
            if let Some(update_meta) = update_meta {
                merge_tool_call_meta(existing, update_meta);
            }
            (
                existing.clone(),
                !was_completed && existing.status == ToolCallStatus::Completed,
            )
        } else {
            let tool_call = ToolCall::try_from(update).ok()?;
            guard.insert(key, tool_call.clone());
            let became_completed = tool_call.status == ToolCallStatus::Completed;
            (tool_call, became_completed)
        };
        drop(guard);

        let (tool_call, became_completed) = tool_call;

        self.cache_content_diffs(session_id, &tool_call);
        self.cache_read_baseline(session_id, &tool_call);
        if became_completed {
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

        let key = call_key(session_id, tool_call_id);
        let diffs = vec![diff];
        if let Ok(mut guard) = self.write_diffs.lock() {
            let Some(existing) = guard.get(&key).cloned() else {
                guard.insert(key, diffs);
                return;
            };

            if let Some(merged) = reconcile_cached_diffs(&existing, &diffs) {
                guard.insert(key, merged);
            }
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
            let Some(existing) = guard.get(&key).cloned() else {
                guard.insert(key, diffs);
                return;
            };

            if let Some(merged) = reconcile_cached_diffs(&existing, &diffs) {
                guard.insert(key, merged);
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

#[derive(Debug, Clone)]
struct ClaudeStructuredPatchHunk {
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
    lines: Vec<String>,
}

#[derive(Debug, Clone)]
struct ClaudeStructuredPatchDiffCandidate {
    hunk: ClaudeStructuredPatchHunk,
    new_text: String,
    old_text: Option<String>,
    path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DiffCacheQuality {
    Weak,
    ReliableSnapshot,
    Anchored,
}

enum ExistingTextSnapshot {
    Missing,
    Text(String),
    Unavailable,
}

pub fn collect_tool_call_diffs(tool_call: &ToolCall, cwd: Option<&Path>) -> Vec<AiFileDiffPayload> {
    // Claude emits structuredPatch in tool-call meta, while the display diffs
    // remain regular ToolCallContent::Diff entries. Match them by path + text.
    let anchored_hunks_by_content_index = build_claude_structured_patch_hunks_by_content_index(
        &tool_call.content,
        tool_call.meta.as_ref(),
        cwd,
    );

    tool_call
        .content
        .iter()
        .enumerate()
        .filter_map(|(content_index, item)| match item {
            ToolCallContent::Diff(diff) => {
                let mut payload = map_diff_payload(diff, tool_call.raw_input.as_ref(), cwd);
                if let Some(hunks) = anchored_hunks_by_content_index.get(&content_index) {
                    payload.hunks = Some(hunks.clone());
                }
                Some(payload)
            }
            _ => None,
        })
        .collect()
}

fn merge_tool_call_meta(tool_call: &mut ToolCall, update_meta: Meta) {
    let meta = tool_call.meta.get_or_insert_with(Meta::new);
    for (key, value) in update_meta {
        meta.insert(key, value);
    }
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

fn diff_cache_quality(diffs: &[AiFileDiffPayload]) -> DiffCacheQuality {
    diffs
        .iter()
        .map(diff_payload_quality)
        .max()
        .unwrap_or(DiffCacheQuality::Weak)
}

fn diff_payload_quality(diff: &AiFileDiffPayload) -> DiffCacheQuality {
    if diff.hunks.as_ref().is_some_and(|hunks| !hunks.is_empty()) {
        return DiffCacheQuality::Anchored;
    }

    if diff.old_text.is_some() && diff.reversible {
        return DiffCacheQuality::ReliableSnapshot;
    }

    DiffCacheQuality::Weak
}

fn reconcile_cached_diffs(
    existing: &[AiFileDiffPayload],
    incoming: &[AiFileDiffPayload],
) -> Option<Vec<AiFileDiffPayload>> {
    let incoming_quality = diff_cache_quality(incoming);
    let existing_quality = diff_cache_quality(existing);

    if incoming_quality == DiffCacheQuality::ReliableSnapshot
        && existing_quality == DiffCacheQuality::Anchored
    {
        // Full snapshots are the canonical accept/reject text. Existing exact
        // hunks are presentation metadata, so keep them only when they still
        // match inside the incoming snapshot.
        return Some(merge_anchored_hunks_into_cached_diffs(incoming, existing));
    }

    if incoming_quality == DiffCacheQuality::Anchored
        && should_merge_anchored_diffs_into_cached(existing, incoming)
    {
        return Some(merge_anchored_hunks_into_cached_diffs(existing, incoming));
    }

    if incoming_quality == DiffCacheQuality::Anchored
        && existing_quality >= DiffCacheQuality::ReliableSnapshot
    {
        // If we cannot safely attach the anchored metadata onto the canonical
        // snapshot, keep the existing full-text diff intact.
        return None;
    }

    // Exact anchored hunks are review metadata and must not be blocked by an
    // earlier weaker diff, but full-text snapshots still own the canonical
    // old/new text used for accept/reject safety.
    if incoming_quality > existing_quality
        || (incoming_quality == DiffCacheQuality::Anchored
            && existing_quality == DiffCacheQuality::Anchored)
    {
        return Some(incoming.to_vec());
    }

    None
}

fn merge_anchored_hunks_into_cached_diffs(
    cached: &[AiFileDiffPayload],
    anchored: &[AiFileDiffPayload],
) -> Vec<AiFileDiffPayload> {
    let mut next = cached.to_vec();

    for incoming in anchored {
        let Some(incoming_hunks) = incoming.hunks.as_ref().filter(|hunks| !hunks.is_empty()) else {
            continue;
        };

        let Some(cached_diff) = next.iter_mut().find(|candidate| {
            candidate.path == incoming.path
                && candidate.previous_path == incoming.previous_path
                && cached_diff_contains_incoming_snippet(candidate, incoming)
        }) else {
            continue;
        };

        let merged_hunks =
            merge_unique_hunks(cached_diff.hunks.as_deref().unwrap_or(&[]), incoming_hunks);
        cached_diff.hunks = (!merged_hunks.is_empty()).then_some(merged_hunks);
    }

    next
}

fn should_merge_anchored_diffs_into_cached(
    cached: &[AiFileDiffPayload],
    anchored: &[AiFileDiffPayload],
) -> bool {
    anchored
        .iter()
        .filter(|incoming| {
            incoming
                .hunks
                .as_ref()
                .is_some_and(|hunks| !hunks.is_empty())
        })
        .all(|incoming| {
            cached.iter().any(|candidate| {
                candidate.path == incoming.path
                    && candidate.previous_path == incoming.previous_path
                    && cached_diff_contains_incoming_snippet(candidate, incoming)
            })
        })
}

fn cached_diff_contains_incoming_snippet(
    cached: &AiFileDiffPayload,
    incoming: &AiFileDiffPayload,
) -> bool {
    let old_matches = match (cached.old_text.as_deref(), incoming.old_text.as_deref()) {
        (_, None) => true,
        (Some(cached_text), Some(incoming_text)) => cached_text.contains(incoming_text),
        (None, Some(_)) => false,
    };
    let new_matches = match (cached.new_text.as_deref(), incoming.new_text.as_deref()) {
        (_, None) => true,
        (Some(cached_text), Some(incoming_text)) => cached_text.contains(incoming_text),
        (None, Some(_)) => false,
    };

    old_matches && new_matches
}

fn merge_unique_hunks(
    existing: &[AiFileDiffHunkPayload],
    incoming: &[AiFileDiffHunkPayload],
) -> Vec<AiFileDiffHunkPayload> {
    let mut merged = existing.to_vec();

    for hunk in incoming {
        if !merged.iter().any(|candidate| candidate == hunk) {
            merged.push(hunk.clone());
        }
    }

    merged
}

fn build_claude_structured_patch_hunks_by_content_index(
    content: &[ToolCallContent],
    meta: Option<&Meta>,
    cwd: Option<&Path>,
) -> HashMap<usize, Vec<AiFileDiffHunkPayload>> {
    let candidates = read_claude_structured_patch_diff_candidates(meta, cwd);
    if candidates.is_empty() {
        return HashMap::new();
    }

    let mut anchored_hunks_by_content_index = HashMap::new();
    let mut used_candidate_indexes = HashSet::new();

    for (content_index, entry) in content.iter().enumerate() {
        let ToolCallContent::Diff(diff) = entry else {
            continue;
        };

        let path = to_display_path(&diff.path, cwd);
        let old_text = diff.old_text.as_deref();
        let candidate_index = candidates
            .iter()
            .enumerate()
            .find_map(|(index, candidate)| {
                if used_candidate_indexes.contains(&index)
                    || candidate.path != path
                    || !claude_old_text_matches(candidate.old_text.as_deref(), old_text)
                    || !claude_new_text_matches(&candidate.new_text, &diff.new_text)
                {
                    return None;
                }

                Some(index)
            });

        let Some(candidate_index) = candidate_index else {
            continue;
        };

        used_candidate_indexes.insert(candidate_index);
        let candidate = &candidates[candidate_index];
        if let Some(hunks) =
            claude_structured_patch_to_ai_diff_hunks(std::slice::from_ref(&candidate.hunk))
        {
            anchored_hunks_by_content_index.insert(content_index, hunks);
        }
    }

    anchored_hunks_by_content_index
}

fn read_claude_structured_patch_diff_candidates(
    meta: Option<&Meta>,
    cwd: Option<&Path>,
) -> Vec<ClaudeStructuredPatchDiffCandidate> {
    let Some(claude_code) = meta
        .and_then(|meta| meta.get(CLAUDE_CODE_META_KEY))
        .and_then(|value| value.as_object())
    else {
        return Vec::new();
    };

    let tool_name = claude_code
        .get(CLAUDE_CODE_TOOL_NAME_KEY)
        .and_then(|value| value.as_str());
    if !matches!(tool_name, Some("Edit" | "Write")) {
        return Vec::new();
    }

    let Some(tool_response) = claude_code
        .get(CLAUDE_CODE_TOOL_RESPONSE_KEY)
        .and_then(|value| value.as_object())
    else {
        return Vec::new();
    };

    let Some(file_path) = tool_response
        .get(CLAUDE_CODE_FILE_PATH_KEY)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };

    let Some(structured_patch) = tool_response
        .get(CLAUDE_CODE_STRUCTURED_PATCH_KEY)
        .and_then(|value| value.as_array())
    else {
        return Vec::new();
    };

    let path = to_display_path(&resolve_tool_path(file_path, cwd), cwd);
    structured_patch
        .iter()
        .filter_map(|candidate| {
            let hunk = read_claude_structured_patch_hunk(candidate)?;
            let (old_text, new_text) = claude_structured_patch_hunk_to_diff_texts(&hunk)?;
            Some(ClaudeStructuredPatchDiffCandidate {
                hunk,
                new_text,
                old_text,
                path: path.clone(),
            })
        })
        .collect()
}

fn read_claude_structured_patch_hunk(
    candidate: &serde_json::Value,
) -> Option<ClaudeStructuredPatchHunk> {
    let candidate = candidate.as_object()?;
    let old_start = read_finite_usize(candidate.get("oldStart")?, 0)?;
    let old_lines = read_finite_usize(candidate.get("oldLines")?, 0)?;
    let new_start = read_finite_usize(candidate.get("newStart")?, 0)?;
    let new_lines = read_finite_usize(candidate.get("newLines")?, 0)?;
    let lines = candidate
        .get("lines")?
        .as_array()?
        .iter()
        .filter_map(|line| line.as_str().map(str::to_string))
        .collect();

    Some(ClaudeStructuredPatchHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines,
    })
}

fn read_finite_usize(value: &serde_json::Value, minimum: usize) -> Option<usize> {
    let number = value.as_f64()?;
    if !number.is_finite() {
        return None;
    }

    let clamped = number.trunc().max(minimum as f64);
    if clamped > usize::MAX as f64 {
        return None;
    }

    Some(clamped as usize)
}

fn claude_structured_patch_hunk_to_diff_texts(
    hunk: &ClaudeStructuredPatchHunk,
) -> Option<(Option<String>, String)> {
    let mut old_text = Vec::new();
    let mut new_text = Vec::new();

    for line in &hunk.lines {
        if claude_structured_patch_marker_matches(line) {
            continue;
        }

        if let Some(text) = line.strip_prefix('-') {
            old_text.push(text.to_string());
        } else if let Some(text) = line.strip_prefix('+') {
            new_text.push(text.to_string());
        } else {
            let text = strip_first_char(line).to_string();
            old_text.push(text.clone());
            new_text.push(text);
        }
    }

    if old_text.is_empty() && new_text.is_empty() {
        return None;
    }

    let old_text = old_text.join("\n");
    let new_text = new_text.join("\n");
    Some(((!old_text.is_empty()).then_some(old_text), new_text))
}

fn claude_structured_patch_marker_matches(line: &str) -> bool {
    line == CLAUDE_NO_NEWLINE_MARKER
}

fn claude_diff_text_marker_matches(line: &str) -> bool {
    claude_structured_patch_marker_matches(line)
        || line
            == CLAUDE_NO_NEWLINE_MARKER
                .strip_prefix('\\')
                .unwrap_or(CLAUDE_NO_NEWLINE_MARKER)
}

fn strip_claude_no_newline_marker_lines(text: &str) -> String {
    text.split('\n')
        .filter(|line| !claude_diff_text_marker_matches(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_claude_old_text(text: Option<&str>) -> Option<String> {
    let normalized = strip_claude_no_newline_marker_lines(text?);
    (!normalized.is_empty()).then_some(normalized)
}

fn claude_old_text_matches(candidate: Option<&str>, actual: Option<&str>) -> bool {
    candidate == actual || normalize_claude_old_text(candidate) == normalize_claude_old_text(actual)
}

fn claude_new_text_matches(candidate: &str, actual: &str) -> bool {
    candidate == actual
        || strip_claude_no_newline_marker_lines(candidate)
            == strip_claude_no_newline_marker_lines(actual)
}

fn claude_structured_patch_to_ai_diff_hunks(
    structured_patch: &[ClaudeStructuredPatchHunk],
) -> Option<Vec<AiFileDiffHunkPayload>> {
    let hunks = structured_patch
        .iter()
        .filter_map(|hunk| {
            let lines: Vec<_> = hunk
                .lines
                .iter()
                .filter_map(|raw_line| {
                    if claude_structured_patch_marker_matches(raw_line) {
                        return None;
                    }

                    let (line_type, text) = if let Some(text) = raw_line.strip_prefix('+') {
                        ("add", text.to_string())
                    } else if let Some(text) = raw_line.strip_prefix('-') {
                        ("remove", text.to_string())
                    } else if let Some(text) = raw_line.strip_prefix(' ') {
                        ("context", text.to_string())
                    } else {
                        ("context", raw_line.clone())
                    };

                    Some(crate::AiFileDiffHunkLinePayload {
                        r#type: line_type.to_string(),
                        text,
                    })
                })
                .collect();

            if lines.is_empty() {
                return None;
            }

            Some(AiFileDiffHunkPayload {
                old_start: hunk.old_start,
                old_count: hunk.old_lines,
                new_start: hunk.new_start,
                new_count: hunk.new_lines,
                lines,
            })
        })
        .collect::<Vec<_>>();

    (!hunks.is_empty()).then_some(hunks)
}

fn strip_first_char(value: &str) -> &str {
    let Some((first_index, _)) = value.char_indices().nth(1) else {
        return "";
    };

    &value[first_index..]
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
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use agent_client_protocol::schema::v1::{
        Content, Diff, Meta, ToolCallContent, ToolCallId, ToolCallStatus, ToolCallUpdate,
        ToolCallUpdateFields,
    };

    use super::*;

    static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("neverwrite-tool-diffs-{suffix}-{counter}"))
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
    fn grok_like_acp_content_diffs_remain_text_and_reversible_for_review() {
        let call = ToolCall::new(ToolCallId::from("grok-tool-1"), "Edit Grok files")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![
                ToolCallContent::Diff(Diff::new("notes/existing.md", "new").old_text("old")),
                ToolCallContent::Diff(Diff::new("notes/new.md", "created")),
                ToolCallContent::Diff(Diff::new("notes/removed.md", "").old_text("removed")),
                ToolCallContent::Diff(Diff::new("notes/renamed.md", "body").old_text("body").meta(
                    Meta::from_iter([(
                        ACP_DIFF_PREVIOUS_PATH_KEY.to_string(),
                        serde_json::json!("notes/original.md"),
                    )]),
                )),
            ]);

        let diffs = collect_tool_call_diffs(&call, None);

        assert_eq!(diffs.len(), 4);
        for diff in &diffs {
            assert!(
                diff.is_text,
                "Grok ACP review diffs must remain text-trackable: {diff:?}"
            );
            assert!(
                diff.reversible,
                "Grok ACP review diffs must remain reversible: {diff:?}"
            );
        }
        assert_eq!(
            diffs
                .iter()
                .map(|diff| diff.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["update", "add", "delete", "move"]
        );
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
    fn claude_structured_patch_attaches_anchored_hunks_to_matching_content_diff() {
        let mut call = ToolCall::new(ToolCallId::from("tool-1"), "Edit file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("src/app.ts", "alpha\nnew\nomega").old_text("alpha\nold\nomega"),
            )]);
        call.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 12,
                            "oldLines": 3,
                            "newStart": 12,
                            "newLines": 3,
                            "lines": [
                                " alpha",
                                "-old",
                                "+new",
                                " omega"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let diffs = collect_tool_call_diffs(&call, None);

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].old_text.as_deref(), Some("alpha\nold\nomega"));
        assert_eq!(diffs[0].new_text.as_deref(), Some("alpha\nnew\nomega"));
        let hunk = diffs[0].hunks.as_ref().unwrap().first().unwrap();
        assert_eq!((hunk.old_start, hunk.new_start), (12, 12));
        assert_eq!((hunk.old_count, hunk.new_count), (3, 3));
        assert_eq!(hunk.lines[0].r#type, "context");
        assert_eq!(hunk.lines[0].text, "alpha");
        assert_eq!(hunk.lines[1].r#type, "remove");
        assert_eq!(hunk.lines[1].text, "old");
        assert_eq!(hunk.lines[2].r#type, "add");
        assert_eq!(hunk.lines[2].text, "new");
    }

    #[test]
    fn claude_structured_patch_preserves_zero_start_lines_for_creation_hunks() {
        let mut call = ToolCall::new(ToolCallId::from("tool-1"), "Write file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(Diff::new(
                "src/new.ts",
                "first line",
            ))]);
        call.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Write",
                "toolResponse": {
                    "filePath": "src/new.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 0,
                            "oldLines": 0,
                            "newStart": 0,
                            "newLines": 1,
                            "lines": [
                                "+first line"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let diffs = collect_tool_call_diffs(&call, None);

        let hunk = diffs[0].hunks.as_ref().unwrap().first().unwrap();
        assert_eq!((hunk.old_start, hunk.new_start), (0, 0));
        assert_eq!((hunk.old_count, hunk.new_count), (0, 1));
        assert_eq!(hunk.lines[0].r#type, "add");
        assert_eq!(hunk.lines[0].text, "first line");
    }

    #[test]
    fn claude_structured_patch_ignores_no_newline_marker_when_matching_content_diff() {
        let mut call = ToolCall::new(ToolCallId::from("tool-1"), "Edit file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("src/app.ts", "new").old_text("old"),
            )]);
        call.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 1,
                            "oldLines": 1,
                            "newStart": 1,
                            "newLines": 1,
                            "lines": [
                                "-old",
                                "+new",
                                "\\ No newline at end of file"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let diffs = collect_tool_call_diffs(&call, None);

        let hunk = diffs[0].hunks.as_ref().unwrap().first().unwrap();
        assert_eq!((hunk.old_start, hunk.new_start), (1, 1));
        assert_eq!(hunk.lines.len(), 2);
        assert_eq!(hunk.lines[0].text, "old");
        assert_eq!(hunk.lines[1].text, "new");
    }

    #[test]
    fn claude_structured_patch_matches_content_diff_with_stripped_no_newline_marker() {
        let mut call = ToolCall::new(ToolCallId::from("tool-1"), "Edit file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("src/app.ts", "new\n No newline at end of file")
                    .old_text("old\n No newline at end of file"),
            )]);
        call.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 1,
                            "oldLines": 1,
                            "newStart": 1,
                            "newLines": 1,
                            "lines": [
                                "-old",
                                "+new",
                                "\\ No newline at end of file"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let diffs = collect_tool_call_diffs(&call, None);

        let hunk = diffs[0].hunks.as_ref().unwrap().first().unwrap();
        assert_eq!((hunk.old_start, hunk.new_start), (1, 1));
        assert_eq!(hunk.lines.len(), 2);
        assert_eq!(hunk.lines[0].text, "old");
        assert_eq!(hunk.lines[1].text, "new");
    }

    #[test]
    fn claude_structured_patch_preserves_context_line_named_like_no_newline_marker() {
        let mut call = ToolCall::new(ToolCallId::from("tool-1"), "Edit file")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("src/app.ts", "No newline at end of file\nnew")
                    .old_text("No newline at end of file\nold"),
            )]);
        call.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 1,
                            "oldLines": 2,
                            "newStart": 1,
                            "newLines": 2,
                            "lines": [
                                " No newline at end of file",
                                "-old",
                                "+new"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let diffs = collect_tool_call_diffs(&call, None);

        let hunk = diffs[0].hunks.as_ref().unwrap().first().unwrap();
        assert_eq!(hunk.lines.len(), 3);
        assert_eq!(hunk.lines[0].r#type, "context");
        assert_eq!(hunk.lines[0].text, "No newline at end of file");
        assert_eq!(hunk.lines[1].text, "old");
        assert_eq!(hunk.lines[2].text, "new");
    }

    #[test]
    fn claude_structured_patch_matches_multiple_identical_content_diffs_by_position() {
        let mut call = ToolCall::new(ToolCallId::from("tool-1"), "Edit all matches")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![
                ToolCallContent::Diff(Diff::new("src/app.ts", "newValue").old_text("oldValue")),
                ToolCallContent::Diff(Diff::new("src/app.ts", "newValue").old_text("oldValue")),
            ]);
        call.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 3,
                            "oldLines": 1,
                            "newStart": 3,
                            "newLines": 1,
                            "lines": [
                                "-oldValue",
                                "+newValue"
                            ]
                        },
                        {
                            "oldStart": 15,
                            "oldLines": 1,
                            "newStart": 15,
                            "newLines": 1,
                            "lines": [
                                "-oldValue",
                                "+newValue"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let diffs = collect_tool_call_diffs(&call, None);

        assert_eq!(diffs.len(), 2);
        assert_eq!(
            diffs
                .iter()
                .map(|diff| {
                    let hunk = diff.hunks.as_ref().unwrap().first().unwrap();
                    (hunk.old_start, hunk.new_start)
                })
                .collect::<Vec<_>>(),
            vec![(3, 3), (15, 15)]
        );
    }

    #[test]
    fn claude_structured_patch_update_attaches_hunks_to_cached_snapshot_diff() {
        let state = ToolDiffState::default();
        state.register_file_baseline(
            "session-1",
            "src/app.ts",
            "header\nalpha\nold\nomega\nfooter".to_string(),
        );

        let initial = ToolCall::new(ToolCallId::from("tool-write"), "Write app.ts")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({
                "file_path": "src/app.ts",
                "content": "header\nalpha\nnew\nomega\nfooter",
            }));
        let initial = state.upsert_tool_call("session-1", initial);
        let initial_diffs = state.normalized_diffs_for_tool_call("session-1", &initial);
        assert_eq!(
            initial_diffs[0].old_text.as_deref(),
            Some("header\nalpha\nold\nomega\nfooter")
        );
        assert!(initial_diffs[0].hunks.is_none());

        let mut update = ToolCallUpdate::new(
            "tool-write",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::Diff(
                    Diff::new("src/app.ts", "alpha\nnew\nomega").old_text("alpha\nold\nomega"),
                )]),
        );
        update.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Write",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 2,
                            "oldLines": 3,
                            "newStart": 2,
                            "newLines": 3,
                            "lines": [
                                " alpha",
                                "-old",
                                "+new",
                                " omega"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let completed = state.apply_tool_update("session-1", update).unwrap();
        let diffs = state.normalized_diffs_for_tool_call("session-1", &completed);

        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some("header\nalpha\nold\nomega\nfooter")
        );
        assert_eq!(
            diffs[0].new_text.as_deref(),
            Some("header\nalpha\nnew\nomega\nfooter")
        );
        let hunk = diffs[0].hunks.as_ref().unwrap().first().unwrap();
        assert_eq!((hunk.old_start, hunk.new_start), (2, 2));
    }

    #[test]
    fn reliable_snapshot_replaces_prior_anchored_snippet_and_preserves_hunks() {
        let state = ToolDiffState::default();
        state.register_file_baseline(
            "session-1",
            "src/app.ts",
            "header\nalpha\nold\nomega\nfooter".to_string(),
        );

        let mut anchored = ToolCall::new(ToolCallId::from("tool-write"), "Write app.ts")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("src/app.ts", "alpha\nnew\nomega").old_text("alpha\nold\nomega"),
            )]);
        anchored.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Write",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 2,
                            "oldLines": 3,
                            "newStart": 2,
                            "newLines": 3,
                            "lines": [
                                " alpha",
                                "-old",
                                "+new",
                                " omega"
                            ]
                        }
                    ]
                }
            }),
        )]));
        let anchored = state.upsert_tool_call("session-1", anchored);
        let anchored_diffs = state.normalized_diffs_for_tool_call("session-1", &anchored);
        assert_eq!(
            anchored_diffs[0].old_text.as_deref(),
            Some("alpha\nold\nomega")
        );

        let snapshot_update = ToolCallUpdate::new(
            "tool-write",
            ToolCallUpdateFields::new().raw_input(serde_json::json!({
                "file_path": "src/app.ts",
                "content": "header\nalpha\nnew\nomega\nfooter",
            })),
        );

        let completed = state
            .apply_tool_update("session-1", snapshot_update)
            .unwrap();
        let diffs = state.normalized_diffs_for_tool_call("session-1", &completed);

        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some("header\nalpha\nold\nomega\nfooter")
        );
        assert_eq!(
            diffs[0].new_text.as_deref(),
            Some("header\nalpha\nnew\nomega\nfooter")
        );
        let hunks = diffs[0].hunks.as_ref().unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!((hunks[0].old_start, hunks[0].new_start), (2, 2));
    }

    #[test]
    fn repeated_claude_structured_patch_updates_preserve_full_snapshot_and_deduplicate_hunks() {
        let state = ToolDiffState::default();
        state.register_file_baseline(
            "session-1",
            "src/app.ts",
            "header\nalpha\nold\nomega\nfooter".to_string(),
        );

        let initial = ToolCall::new(ToolCallId::from("tool-write"), "Write app.ts")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({
                "file_path": "src/app.ts",
                "content": "header\nalpha\nnew\nomega\nfooter",
            }));
        state.upsert_tool_call("session-1", initial);

        let make_update = || {
            let mut update = ToolCallUpdate::new(
                "tool-write",
                ToolCallUpdateFields::new()
                    .status(ToolCallStatus::Completed)
                    .content(vec![ToolCallContent::Diff(
                        Diff::new("src/app.ts", "alpha\nnew\nomega").old_text("alpha\nold\nomega"),
                    )]),
            );
            update.meta = Some(Meta::from_iter([(
                CLAUDE_CODE_META_KEY.to_string(),
                serde_json::json!({
                    "toolName": "Write",
                    "toolResponse": {
                        "filePath": "src/app.ts",
                        "structuredPatch": [
                            {
                                "oldStart": 2,
                                "oldLines": 3,
                                "newStart": 2,
                                "newLines": 3,
                                "lines": [
                                    " alpha",
                                    "-old",
                                    "+new",
                                    " omega"
                                ]
                            }
                        ]
                    }
                }),
            )]));
            update
        };

        let first = state.apply_tool_update("session-1", make_update()).unwrap();
        let second = state.apply_tool_update("session-1", make_update()).unwrap();
        let diffs = state.normalized_diffs_for_tool_call("session-1", &second);

        assert_eq!(first.tool_call_id.0, second.tool_call_id.0);
        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some("header\nalpha\nold\nomega\nfooter")
        );
        assert_eq!(
            diffs[0].new_text.as_deref(),
            Some("header\nalpha\nnew\nomega\nfooter")
        );
        let hunks = diffs[0].hunks.as_ref().unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 4);
    }

    #[test]
    fn unmatched_claude_structured_patch_update_preserves_cached_full_snapshot() {
        let state = ToolDiffState::default();
        state.register_file_baseline(
            "session-1",
            "src/app.ts",
            "header\nalpha\nold\nomega\nfooter".to_string(),
        );

        let initial = ToolCall::new(ToolCallId::from("tool-write"), "Write app.ts")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({
                "file_path": "src/app.ts",
                "content": "header\nalpha\nnew\nomega\nfooter",
            }));
        let initial = state.upsert_tool_call("session-1", initial);
        let initial_diffs = state.normalized_diffs_for_tool_call("session-1", &initial);
        assert_eq!(
            initial_diffs[0].old_text.as_deref(),
            Some("header\nalpha\nold\nomega\nfooter")
        );
        assert!(initial_diffs[0].hunks.is_none());

        let mut update = ToolCallUpdate::new(
            "tool-write",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::Diff(
                    Diff::new("src/app.ts", "different\nsnippet").old_text("different\nsource"),
                )]),
        );
        update.meta = Some(Meta::from_iter([(
            CLAUDE_CODE_META_KEY.to_string(),
            serde_json::json!({
                "toolName": "Write",
                "toolResponse": {
                    "filePath": "src/app.ts",
                    "structuredPatch": [
                        {
                            "oldStart": 20,
                            "oldLines": 2,
                            "newStart": 20,
                            "newLines": 2,
                            "lines": [
                                " different",
                                "-source",
                                "+snippet"
                            ]
                        }
                    ]
                }
            }),
        )]));

        let completed = state.apply_tool_update("session-1", update).unwrap();
        let diffs = state.normalized_diffs_for_tool_call("session-1", &completed);

        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].old_text.as_deref(),
            Some("header\nalpha\nold\nomega\nfooter")
        );
        assert_eq!(
            diffs[0].new_text.as_deref(),
            Some("header\nalpha\nnew\nomega\nfooter")
        );
        assert!(diffs[0].hunks.is_none());
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
