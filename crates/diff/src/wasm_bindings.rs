use wasm_bindgen::prelude::*;

use crate::{
    apply_non_conflicting_edits, apply_reject_undo, build_text_range_patch_from_texts,
    compute_line_diff, compute_word_diffs_for_hunk, derive_line_patch_from_text_ranges,
    keep_edits_in_range, map_agent_span_through_text_edits, map_text_position_through_edits,
    partition_spans_by_overlap, rebuild_diff_base_from_pending_spans, reject_all_edits,
    reject_edits_in_ranges, sync_derived_line_patch, AgentTextSpan, LineEdit, LinePatch, LineRange,
    TextEdit, TrackedFile,
};

fn parse_json<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PartitionedSpans {
    overlapping: Vec<AgentTextSpan>,
    non_overlapping: Vec<AgentTextSpan>,
}

#[wasm_bindgen]
pub fn build_patch_from_texts_json(old_text: &str, new_text: &str) -> Result<String, JsValue> {
    to_json(&compute_line_diff(old_text, new_text))
}

#[wasm_bindgen]
pub fn build_text_range_patch_from_texts_json(
    old_text: &str,
    new_text: &str,
    line_patch_json: Option<String>,
) -> Result<String, JsValue> {
    let line_patch = match line_patch_json {
        Some(json) => Some(parse_json::<LinePatch>(&json)?),
        None => None,
    };
    to_json(&build_text_range_patch_from_texts(
        old_text,
        new_text,
        line_patch.as_ref(),
    ))
}

#[wasm_bindgen]
pub fn compute_word_diffs_for_hunk_json(
    base_text: &str,
    current_text: &str,
    edit_json: &str,
    max_lines: u32,
    max_chars: u32,
) -> Result<String, JsValue> {
    let edit: LineEdit = parse_json(edit_json)?;
    to_json(&compute_word_diffs_for_hunk(
        base_text,
        current_text,
        &edit,
        max_lines,
        max_chars,
    ))
}

#[wasm_bindgen]
pub fn derive_line_patch_from_text_ranges_json(
    base_text: &str,
    current_text: &str,
    spans_json: &str,
) -> Result<String, JsValue> {
    let spans: Vec<AgentTextSpan> = parse_json(spans_json)?;
    to_json(&derive_line_patch_from_text_ranges(
        base_text,
        current_text,
        &spans,
    ))
}

#[wasm_bindgen]
pub fn sync_derived_line_patch_json(file_json: &str) -> Result<String, JsValue> {
    let file: TrackedFile = parse_json(file_json)?;
    to_json(&sync_derived_line_patch(&file))
}

#[wasm_bindgen]
pub fn apply_non_conflicting_edits_json(
    file_json: &str,
    user_edits_json: &str,
    new_full_text: &str,
) -> Result<String, JsValue> {
    let file: TrackedFile = parse_json(file_json)?;
    let user_edits: Vec<TextEdit> = parse_json(user_edits_json)?;
    to_json(&apply_non_conflicting_edits(
        &file,
        &user_edits,
        new_full_text,
    ))
}

#[wasm_bindgen]
pub fn keep_edits_in_range_json(
    file_json: &str,
    start_line: u32,
    end_line: u32,
) -> Result<String, JsValue> {
    let file: TrackedFile = parse_json(file_json)?;
    to_json(&keep_edits_in_range(&file, start_line, end_line))
}

#[wasm_bindgen]
pub fn reject_all_edits_json(file_json: &str) -> Result<String, JsValue> {
    let file: TrackedFile = parse_json(file_json)?;
    to_json(&reject_all_edits(&file))
}

#[wasm_bindgen]
pub fn reject_edits_in_ranges_json(file_json: &str, ranges_json: &str) -> Result<String, JsValue> {
    let file: TrackedFile = parse_json(file_json)?;
    let ranges: Vec<LineRange> = parse_json(ranges_json)?;
    to_json(&reject_edits_in_ranges(&file, &ranges))
}

#[wasm_bindgen]
pub fn apply_reject_undo_json(file_json: &str, undo_json: &str) -> Result<String, JsValue> {
    let file: TrackedFile = parse_json(file_json)?;
    let undo = parse_json(undo_json)?;
    to_json(&apply_reject_undo(&file, &undo))
}

#[wasm_bindgen]
pub fn map_text_position_through_edits_json(
    position: u32,
    edits_json: &str,
    assoc: i32,
) -> Result<u32, JsValue> {
    let edits: Vec<TextEdit> = parse_json(edits_json)?;
    Ok(map_text_position_through_edits(position, &edits, assoc))
}

#[wasm_bindgen]
pub fn map_agent_span_through_text_edits_json(
    span_json: &str,
    edits_json: &str,
) -> Result<String, JsValue> {
    let span: AgentTextSpan = parse_json(span_json)?;
    let edits: Vec<TextEdit> = parse_json(edits_json)?;
    to_json(&map_agent_span_through_text_edits(&span, &edits))
}

#[wasm_bindgen]
pub fn rebuild_diff_base_from_pending_spans_json(
    original_diff_base: &str,
    current_text: &str,
    spans_json: &str,
) -> Result<String, JsValue> {
    let spans: Vec<AgentTextSpan> = parse_json(spans_json)?;
    Ok(rebuild_diff_base_from_pending_spans(
        original_diff_base,
        current_text,
        &spans,
    ))
}

#[wasm_bindgen]
pub fn partition_spans_by_overlap_json(
    spans_json: &str,
    ranges_json: &str,
    base_text: &str,
    current_text: &str,
) -> Result<String, JsValue> {
    let spans: Vec<AgentTextSpan> = parse_json(spans_json)?;
    let ranges: Vec<LineRange> = parse_json(ranges_json)?;
    let (overlapping, non_overlapping) =
        partition_spans_by_overlap(&spans, &ranges, base_text, current_text);
    to_json(&PartitionedSpans {
        overlapping,
        non_overlapping,
    })
}
