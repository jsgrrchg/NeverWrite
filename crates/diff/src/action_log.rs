use serde::{Deserialize, Serialize};

use crate::{
    compute_line_diff, compute_text_range_patch, AgentTextSpan, LineEdit, LinePatch, TextRangePatch,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub old_from: u32,
    pub old_to: u32,
    pub new_from: u32,
    pub new_to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewState {
    Pending,
    Finalized,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrackedFileStatus {
    Created {
        #[serde(rename = "existingFileContent", alias = "existing_file_content")]
        existing_file_content: Option<String>,
    },
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedFile {
    pub identity_key: String,
    pub origin_path: String,
    pub path: String,
    pub previous_path: Option<String>,
    pub status: TrackedFileStatus,
    pub review_state: Option<ReviewState>,
    pub diff_base: String,
    pub current_text: String,
    pub unreviewed_ranges: Option<TextRangePatch>,
    pub unreviewed_edits: LinePatch,
    pub version: u32,
    pub is_text: bool,
    pub updated_at: u64,
    pub conflict_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerFileUndoEdit {
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerFileUndo {
    pub path: String,
    pub edits_to_restore: Vec<PerFileUndoEdit>,
    pub previous_status: TrackedFileStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectEditsResult {
    pub file: TrackedFile,
    pub undo_data: PerFileUndo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

fn empty_patch() -> LinePatch {
    LinePatch { edits: Vec::new() }
}

fn empty_text_range_patch() -> TextRangePatch {
    TextRangePatch { spans: Vec::new() }
}

pub fn patch_is_empty(patch: &LinePatch) -> bool {
    patch.edits.is_empty()
}

pub fn ranges_overlap(a_start: u32, a_end: u32, b_start: u32, b_end: u32) -> bool {
    a_start < b_end && b_start < a_end
}

fn utf16_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn build_line_start_offsets(text: &str) -> Vec<u32> {
    let units = utf16_units(text);
    let mut offsets = vec![0];
    for (index, unit) in units.iter().enumerate() {
        if *unit == b'\n' as u16 {
            offsets.push((index + 1) as u32);
        }
    }
    offsets
}

fn line_index_at_offset(line_starts: &[u32], offset: u32) -> u32 {
    if line_starts.is_empty() {
        return 0;
    }

    let mut low = 0usize;
    let mut high = line_starts.len() - 1;

    while low <= high {
        let mid = (low + high) / 2;
        if line_starts[mid] <= offset {
            low = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }

    high as u32
}

fn insertion_line_index_at_offset(line_starts: &[u32], offset: u32) -> u32 {
    let mut low = 0usize;
    let mut high = line_starts.len();

    while low < high {
        let mid = (low + high) / 2;
        if line_starts[mid] < offset {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    low as u32
}

fn contains_newline(text: &str, from: u32, to: u32) -> bool {
    let units = utf16_units(text);
    let start = (from as usize).min(units.len());
    let end = (to as usize).min(units.len());
    if start >= end {
        return false;
    }
    units[start..end].contains(&(b'\n' as u16))
}

fn is_line_boundary(text: &str, offset: u32) -> bool {
    let units = utf16_units(text);
    if offset == 0 || offset >= units.len() as u32 {
        return true;
    }

    units[offset as usize - 1] == b'\n' as u16
}

fn is_single_line_text_range(line_starts: &[u32], from: u32, to: u32) -> bool {
    if from >= to {
        return true;
    }

    line_index_at_offset(line_starts, from) == line_index_at_offset(line_starts, to - 1)
}

fn span_part_to_line_range(
    text: &str,
    line_starts: &[u32],
    from: u32,
    to: u32,
    counterpart_text: &str,
    counterpart_from: u32,
    counterpart_to: u32,
) -> LineRange {
    if from == to && counterpart_from == counterpart_to {
        let point = insertion_line_index_at_offset(line_starts, from);
        return LineRange {
            start: point,
            end: point,
        };
    }

    if from == to {
        let inline_single_line_insert =
            !contains_newline(counterpart_text, counterpart_from, counterpart_to)
                && !is_line_boundary(text, from)
                && !is_line_boundary(counterpart_text, counterpart_from);

        if inline_single_line_insert {
            let line = line_index_at_offset(line_starts, from.saturating_sub(1));
            return LineRange {
                start: line,
                end: line + 1,
            };
        }

        let point = insertion_line_index_at_offset(line_starts, from);
        return LineRange {
            start: point,
            end: point,
        };
    }

    let inline_single_line_change = !contains_newline(text, from, to)
        && !contains_newline(counterpart_text, counterpart_from, counterpart_to)
        && is_single_line_text_range(line_starts, from, to);

    if inline_single_line_change {
        let line = line_index_at_offset(line_starts, from);
        return LineRange {
            start: line,
            end: line + 1,
        };
    }

    LineRange {
        start: line_index_at_offset(line_starts, from),
        end: line_index_at_offset(line_starts, to - 1) + 1,
    }
}

fn merge_overlapping_line_edits(edits: Vec<LineEdit>) -> Vec<LineEdit> {
    if edits.len() <= 1 {
        return edits;
    }

    let mut sorted = edits;
    sorted.sort_by(|left, right| {
        left.new_start
            .cmp(&right.new_start)
            .then(left.new_end.cmp(&right.new_end))
            .then(left.old_start.cmp(&right.old_start))
            .then(left.old_end.cmp(&right.old_end))
    });

    let mut merged = vec![sorted[0].clone()];
    for edit in sorted.into_iter().skip(1) {
        let previous = merged.last_mut().expect("merged is never empty");
        let overlaps_old = ranges_overlap(
            previous.old_start,
            previous.old_end,
            edit.old_start,
            edit.old_end,
        );
        let overlaps_new = ranges_overlap(
            previous.new_start,
            previous.new_end,
            edit.new_start,
            edit.new_end,
        );

        if overlaps_old || overlaps_new {
            previous.old_start = previous.old_start.min(edit.old_start);
            previous.old_end = previous.old_end.max(edit.old_end);
            previous.new_start = previous.new_start.min(edit.new_start);
            previous.new_end = previous.new_end.max(edit.new_end);
        } else {
            merged.push(edit);
        }
    }

    merged
}

pub fn map_text_position_through_edits(position: u32, edits: &[TextEdit], assoc: i32) -> u32 {
    let mut delta = 0i64;

    for edit in edits {
        let change_delta = (edit.new_to as i64 - edit.new_from as i64)
            - (edit.old_to as i64 - edit.old_from as i64);

        if edit.old_to < position || (edit.old_to == position && assoc > 0) {
            delta += change_delta;
            continue;
        }

        break;
    }

    (position as i64 + delta) as u32
}

pub fn map_agent_span_through_text_edits(
    span: &AgentTextSpan,
    edits: &[TextEdit],
) -> Option<AgentTextSpan> {
    let touched_by_user = edits.iter().any(|edit| {
        ranges_overlap(
            edit.old_from,
            edit.old_to,
            span.current_from,
            span.current_to,
        )
    });

    if touched_by_user {
        return None;
    }

    Some(AgentTextSpan {
        base_from: span.base_from,
        base_to: span.base_to,
        current_from: map_text_position_through_edits(span.current_from, edits, 1),
        current_to: map_text_position_through_edits(span.current_to, edits, -1),
    })
}

pub fn rebuild_diff_base_from_pending_spans(
    original_diff_base: &str,
    current_text: &str,
    spans: &[AgentTextSpan],
) -> String {
    if spans.is_empty() {
        return current_text.to_string();
    }

    let original_units = utf16_units(original_diff_base);
    let current_units = utf16_units(current_text);
    let mut sorted_spans = spans.to_vec();
    sorted_spans.sort_by_key(|span| span.current_from);

    let mut parts: Vec<u16> = Vec::new();
    let mut cursor = 0u32;

    for span in sorted_spans {
        let cur_from = (cursor as usize).min(current_units.len());
        let cur_to = (span.current_from as usize).min(current_units.len());
        if cur_from < cur_to {
            parts.extend_from_slice(&current_units[cur_from..cur_to]);
        }
        let base_from = (span.base_from as usize).min(original_units.len());
        let base_to = (span.base_to as usize).min(original_units.len());
        if base_from < base_to {
            parts.extend_from_slice(&original_units[base_from..base_to]);
        }
        cursor = span.current_to;
    }

    let tail_start = (cursor as usize).min(current_units.len());
    parts.extend_from_slice(&current_units[tail_start..]);
    String::from_utf16_lossy(&parts)
}

pub fn build_text_range_patch_from_texts(
    old_text: &str,
    new_text: &str,
    line_patch: Option<&LinePatch>,
) -> TextRangePatch {
    if old_text == new_text {
        return empty_text_range_patch();
    }

    match line_patch {
        Some(line_patch) => compute_text_range_patch(old_text, new_text, line_patch),
        None => {
            let line_patch = compute_line_diff(old_text, new_text);
            compute_text_range_patch(old_text, new_text, &line_patch)
        }
    }
}

pub fn derive_line_patch_from_text_ranges(
    base_text: &str,
    current_text: &str,
    spans: &[AgentTextSpan],
) -> LinePatch {
    if spans.is_empty() {
        return empty_patch();
    }

    let base_line_starts = build_line_start_offsets(base_text);
    let current_line_starts = build_line_start_offsets(current_text);
    let edits = spans
        .iter()
        .map(|span| {
            let old_range = span_part_to_line_range(
                base_text,
                &base_line_starts,
                span.base_from,
                span.base_to,
                current_text,
                span.current_from,
                span.current_to,
            );
            let new_range = span_part_to_line_range(
                current_text,
                &current_line_starts,
                span.current_from,
                span.current_to,
                base_text,
                span.base_from,
                span.base_to,
            );

            LineEdit {
                old_start: old_range.start,
                old_end: old_range.end,
                new_start: new_range.start,
                new_end: new_range.end,
            }
        })
        .collect();

    LinePatch {
        edits: merge_overlapping_line_edits(edits),
    }
}

fn get_line_edit_for_span(
    base_text: &str,
    current_text: &str,
    span: &AgentTextSpan,
) -> Option<LineEdit> {
    derive_line_patch_from_text_ranges(base_text, current_text, std::slice::from_ref(span))
        .edits
        .into_iter()
        .next()
}

fn line_range_ends_before_edit(range: LineRange, edit: &LineEdit) -> bool {
    if range.start == range.end && edit.new_start == edit.new_end && range.end == edit.new_start {
        return false;
    }

    range.end <= edit.new_start
}

fn edit_ends_before_line_range(edit: &LineEdit, range: LineRange) -> bool {
    if range.start == range.end && edit.new_start == edit.new_end && edit.new_end == range.start {
        return false;
    }

    edit.new_end <= range.start
}

pub fn partition_spans_by_overlap(
    spans: &[AgentTextSpan],
    ranges: &[LineRange],
    base_text: &str,
    current_text: &str,
) -> (Vec<AgentTextSpan>, Vec<AgentTextSpan>) {
    if spans.is_empty() {
        return (Vec::new(), Vec::new());
    }

    if ranges.is_empty() {
        return (Vec::new(), spans.to_vec());
    }

    let mut overlap_flags = vec![false; spans.len()];
    let mut sorted_ranges = ranges.to_vec();
    sorted_ranges.sort_by_key(|range| (range.start, range.end));

    let mut sorted_spans: Vec<(AgentTextSpan, usize, LineEdit)> = spans
        .iter()
        .cloned()
        .enumerate()
        .filter_map(|(index, span)| {
            get_line_edit_for_span(base_text, current_text, &span).map(|edit| (span, index, edit))
        })
        .collect();
    sorted_spans.sort_by(|left, right| {
        left.2
            .new_start
            .cmp(&right.2.new_start)
            .then(left.2.new_end.cmp(&right.2.new_end))
            .then(left.1.cmp(&right.1))
    });

    let mut range_index = 0usize;
    for (_, original_index, edit) in sorted_spans {
        while range_index < sorted_ranges.len()
            && line_range_ends_before_edit(sorted_ranges[range_index], &edit)
        {
            range_index += 1;
        }

        let Some(range) = sorted_ranges.get(range_index).copied() else {
            continue;
        };
        if edit_ends_before_line_range(&edit, range) {
            continue;
        }

        overlap_flags[original_index] =
            ranges_overlap(range.start, range.end, edit.new_start, edit.new_end);
    }

    let mut overlapping = Vec::new();
    let mut non_overlapping = Vec::new();
    for (index, span) in spans.iter().cloned().enumerate() {
        if overlap_flags[index] {
            overlapping.push(span);
        } else {
            non_overlapping.push(span);
        }
    }

    (overlapping, non_overlapping)
}

pub fn sync_derived_line_patch(file: &TrackedFile) -> TrackedFile {
    let unreviewed_ranges = file.unreviewed_ranges.clone().unwrap_or_else(|| {
        build_text_range_patch_from_texts(&file.diff_base, &file.current_text, None)
    });
    let unreviewed_edits = derive_line_patch_from_text_ranges(
        &file.diff_base,
        &file.current_text,
        &unreviewed_ranges.spans,
    );

    let mut next = file.clone();
    next.unreviewed_ranges = Some(unreviewed_ranges);
    next.unreviewed_edits = unreviewed_edits;
    next
}

pub fn apply_non_conflicting_edits(
    file: &TrackedFile,
    user_edits: &[TextEdit],
    new_full_text: &str,
) -> TrackedFile {
    let synced_file = sync_derived_line_patch(file);

    if user_edits.is_empty() {
        let mut next = synced_file.clone();
        next.current_text = new_full_text.to_string();
        next.version += 1;
        return next;
    }

    let current_spans = synced_file
        .unreviewed_ranges
        .clone()
        .unwrap_or_else(empty_text_range_patch)
        .spans;
    if current_spans.is_empty() {
        let mut next = synced_file.clone();
        next.diff_base = new_full_text.to_string();
        next.current_text = new_full_text.to_string();
        next.unreviewed_ranges = Some(empty_text_range_patch());
        next.unreviewed_edits = empty_patch();
        next.version += 1;
        return next;
    }

    let surviving_spans: Vec<AgentTextSpan> = current_spans
        .iter()
        .filter_map(|span| map_agent_span_through_text_edits(span, user_edits))
        .collect();
    let new_diff_base = rebuild_diff_base_from_pending_spans(
        &synced_file.diff_base,
        new_full_text,
        &surviving_spans,
    );
    let unreviewed_ranges = if surviving_spans.is_empty() {
        empty_text_range_patch()
    } else {
        build_text_range_patch_from_texts(&new_diff_base, new_full_text, None)
    };
    let unreviewed_edits =
        derive_line_patch_from_text_ranges(&new_diff_base, new_full_text, &unreviewed_ranges.spans);

    let mut next = synced_file.clone();
    next.diff_base = new_diff_base;
    next.current_text = new_full_text.to_string();
    next.unreviewed_ranges = Some(unreviewed_ranges);
    next.unreviewed_edits = unreviewed_edits;
    next.version += 1;
    next
}

pub fn keep_edits_in_range(file: &TrackedFile, start_line: u32, end_line: u32) -> TrackedFile {
    let synced_file = sync_derived_line_patch(file);
    let current_spans = synced_file
        .unreviewed_ranges
        .clone()
        .unwrap_or_else(empty_text_range_patch)
        .spans;
    let (_, remaining_spans) = partition_spans_by_overlap(
        &current_spans,
        &[LineRange {
            start: start_line,
            end: end_line,
        }],
        &synced_file.diff_base,
        &synced_file.current_text,
    );
    let new_diff_base = rebuild_diff_base_from_pending_spans(
        &synced_file.diff_base,
        &synced_file.current_text,
        &remaining_spans,
    );
    let unreviewed_ranges = if remaining_spans.is_empty() {
        empty_text_range_patch()
    } else {
        build_text_range_patch_from_texts(&new_diff_base, &synced_file.current_text, None)
    };
    let unreviewed_edits = derive_line_patch_from_text_ranges(
        &new_diff_base,
        &synced_file.current_text,
        &unreviewed_ranges.spans,
    );

    let mut next = synced_file.clone();
    next.diff_base = new_diff_base;
    next.unreviewed_ranges = Some(unreviewed_ranges);
    next.unreviewed_edits = unreviewed_edits;
    next.version += 1;
    next
}

fn clamped_lines_text(lines: &[String], start: u32, end: u32) -> String {
    let s = (start as usize).min(lines.len());
    let e = (end as usize).min(lines.len());
    if s >= e {
        return String::new();
    }
    lines[s..e].join("\n")
}

pub fn reject_all_edits(file: &TrackedFile) -> RejectEditsResult {
    let synced_file = sync_derived_line_patch(file);
    let current_lines: Vec<String> = synced_file
        .current_text
        .split('\n')
        .map(str::to_owned)
        .collect();
    let edits_to_restore = synced_file
        .unreviewed_edits
        .edits
        .iter()
        .map(|edit| PerFileUndoEdit {
            start_line: edit.new_start,
            end_line: edit.new_end,
            text: clamped_lines_text(&current_lines, edit.new_start, edit.new_end),
        })
        .collect();

    let undo_data = PerFileUndo {
        path: synced_file.path.clone(),
        edits_to_restore,
        previous_status: synced_file.status.clone(),
    };

    let mut reverted_file = synced_file.clone();
    reverted_file.current_text = reverted_file.diff_base.clone();
    reverted_file.unreviewed_ranges = Some(empty_text_range_patch());
    reverted_file.unreviewed_edits = empty_patch();
    reverted_file.version += 1;

    RejectEditsResult {
        file: reverted_file,
        undo_data,
    }
}

pub fn reject_edits_in_ranges(file: &TrackedFile, ranges: &[LineRange]) -> RejectEditsResult {
    let synced_file = sync_derived_line_patch(file);
    let current_lines: Vec<String> = synced_file
        .current_text
        .split('\n')
        .map(str::to_owned)
        .collect();
    let current_spans = synced_file
        .unreviewed_ranges
        .clone()
        .unwrap_or_else(empty_text_range_patch)
        .spans;
    let (rejected_spans, remaining_spans) = partition_spans_by_overlap(
        &current_spans,
        ranges,
        &synced_file.diff_base,
        &synced_file.current_text,
    );

    let mut edits_to_restore = Vec::new();
    for span in &rejected_spans {
        let Some(edit) =
            get_line_edit_for_span(&synced_file.diff_base, &synced_file.current_text, span)
        else {
            continue;
        };

        edits_to_restore.push(PerFileUndoEdit {
            start_line: edit.new_start,
            end_line: edit.new_end,
            text: clamped_lines_text(&current_lines, edit.new_start, edit.new_end),
        });
    }

    let new_current_text = rebuild_diff_base_from_pending_spans(
        &synced_file.diff_base,
        &synced_file.current_text,
        &rejected_spans,
    );
    let unreviewed_ranges = if remaining_spans.is_empty() {
        empty_text_range_patch()
    } else {
        build_text_range_patch_from_texts(&synced_file.diff_base, &new_current_text, None)
    };
    let unreviewed_edits = derive_line_patch_from_text_ranges(
        &synced_file.diff_base,
        &new_current_text,
        &unreviewed_ranges.spans,
    );

    let undo_data = PerFileUndo {
        path: synced_file.path.clone(),
        edits_to_restore,
        previous_status: synced_file.status.clone(),
    };

    let mut next = synced_file.clone();
    next.current_text = new_current_text;
    next.unreviewed_ranges = Some(unreviewed_ranges);
    next.unreviewed_edits = unreviewed_edits;
    next.version += 1;

    RejectEditsResult {
        file: next,
        undo_data,
    }
}

pub fn apply_reject_undo(file: &TrackedFile, undo: &PerFileUndo) -> TrackedFile {
    let synced_file = sync_derived_line_patch(file);
    let mut lines: Vec<String> = synced_file
        .current_text
        .split('\n')
        .map(str::to_owned)
        .collect();
    let mut delta = 0i32;

    for entry in &undo.edits_to_restore {
        let restore_lines: Vec<String> = entry.text.split('\n').map(str::to_owned).collect();
        let splice_start_i32 = entry.start_line as i32 + delta;
        if splice_start_i32 < 0 || splice_start_i32 as usize > lines.len() {
            continue;
        }
        let splice_start = splice_start_i32 as usize;
        let matching_edit = synced_file
            .unreviewed_edits
            .edits
            .iter()
            .find(|edit| edit.new_start as i32 == splice_start_i32);
        let delete_count = matching_edit
            .map(|edit| (edit.new_end - edit.new_start) as usize)
            .unwrap_or(restore_lines.len());
        let clamped_delete = delete_count.min(lines.len() - splice_start);

        lines.splice(
            splice_start..splice_start + clamped_delete,
            restore_lines.clone(),
        );
        delta += restore_lines.len() as i32 - delete_count as i32;
    }

    let new_current_text = lines.join("\n");
    let unreviewed_edits = if synced_file.diff_base == new_current_text {
        empty_patch()
    } else {
        compute_line_diff(&synced_file.diff_base, &new_current_text)
    };
    let unreviewed_ranges =
        compute_text_range_patch(&synced_file.diff_base, &new_current_text, &unreviewed_edits);

    let mut next = synced_file.clone();
    next.current_text = new_current_text;
    next.unreviewed_ranges = Some(unreviewed_ranges);
    next.unreviewed_edits = unreviewed_edits;
    next.status = undo.previous_status.clone();
    next.version += 1;
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracked_file(diff_base: &str, current_text: &str) -> TrackedFile {
        TrackedFile {
            identity_key: "test.md".to_string(),
            origin_path: "test.md".to_string(),
            path: "test.md".to_string(),
            previous_path: None,
            status: TrackedFileStatus::Modified,
            review_state: Some(ReviewState::Pending),
            diff_base: diff_base.to_string(),
            current_text: current_text.to_string(),
            unreviewed_ranges: None,
            unreviewed_edits: empty_patch(),
            version: 1,
            is_text: true,
            updated_at: 1,
            conflict_hash: None,
        }
    }

    #[test]
    fn derive_line_patch_from_text_ranges_keeps_inline_changes_line_based() {
        let patch = derive_line_patch_from_text_ranges(
            "first line\nalpha\nlast line",
            "first line\nalpHa\nlast line",
            &[AgentTextSpan {
                base_from: 14,
                base_to: 15,
                current_from: 14,
                current_to: 15,
            }],
        );

        assert_eq!(
            patch.edits,
            vec![LineEdit {
                old_start: 1,
                old_end: 2,
                new_start: 1,
                new_end: 2,
            }]
        );
    }

    #[test]
    fn apply_non_conflicting_edits_rebases_diff_base() {
        let file = tracked_file("aaa\nbbb\nccc", "aaa\nBBB\nccc");
        let result = apply_non_conflicting_edits(
            &file,
            &[TextEdit {
                old_from: 2,
                old_to: 2,
                new_from: 2,
                new_to: 3,
            }],
            "aaXa\nBBB\nccc",
        );

        assert_eq!(result.diff_base, "aaXa\nbbb\nccc");
        assert_eq!(result.current_text, "aaXa\nBBB\nccc");
        assert_eq!(
            result.unreviewed_edits.edits,
            vec![LineEdit {
                old_start: 1,
                old_end: 2,
                new_start: 1,
                new_end: 2,
            }]
        );
    }

    #[test]
    fn keep_edits_in_range_accepts_hunks() {
        let file = tracked_file("aaa\nbbb\nccc", "aaa\nBBB\nccc");
        let accepted = keep_edits_in_range(&file, 1, 2);

        assert_eq!(accepted.diff_base, "aaa\nBBB\nccc");
        assert!(accepted.unreviewed_edits.edits.is_empty());
    }

    #[test]
    fn reject_edits_in_ranges_reverts_selected_hunks() {
        let file = tracked_file("aaa\nbbb\nccc", "aaa\nBBB\nccc");
        let rejected = reject_edits_in_ranges(&file, &[LineRange { start: 1, end: 2 }]);

        assert_eq!(rejected.file.current_text, "aaa\nbbb\nccc");
        assert!(rejected.file.unreviewed_edits.edits.is_empty());
        assert_eq!(rejected.undo_data.edits_to_restore.len(), 1);
    }
}
