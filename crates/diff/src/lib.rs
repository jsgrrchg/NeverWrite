use std::str::Split;

use imara_diff::{Algorithm, Diff, InternedInput, TokenSource};
use serde::{Deserialize, Serialize};

mod action_log;
pub use action_log::*;

#[cfg(target_arch = "wasm32")]
mod wasm_bindings;

/// A line-based edit using the same 0-based half-open ranges as the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEdit {
    pub old_start: u32,
    pub old_end: u32,
    pub new_start: u32,
    pub new_end: u32,
}

/// A collection of changed line ranges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinePatch {
    pub edits: Vec<LineEdit>,
}

/// A pending agent-authored span tracked across base/current documents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTextSpan {
    pub base_from: u32,
    pub base_to: u32,
    pub current_from: u32,
    pub current_to: u32,
}

/// Ordered, non-overlapping collection of agent text spans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextRangePatch {
    pub spans: Vec<AgentTextSpan>,
}

/// Full precomputed patch payload consumed by the frontend ActionLog model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackedFilePatches {
    pub line_patch: LinePatch,
    pub text_range_patch: TextRangePatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDiffRange {
    pub from: u32,
    pub to: u32,
    pub base_from: u32,
    pub base_to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HunkWordDiffs {
    pub buffer_ranges: Vec<WordDiffRange>,
    pub base_ranges: Vec<WordDiffRange>,
}

/// Mirrors JavaScript's `text.split("\n")` semantics exactly, including the trailing
/// empty segment when the text ends with a newline.
#[derive(Clone, Copy, Debug)]
struct JsSplitLines<'a>(&'a str);

impl<'a> TokenSource for JsSplitLines<'a> {
    type Token = &'a str;
    type Tokenizer = Split<'a, char>;

    fn tokenize(&self) -> Self::Tokenizer {
        self.0.split('\n')
    }

    fn estimate_tokens(&self) -> u32 {
        self.0
            .bytes()
            .filter(|&byte| byte == b'\n')
            .count()
            .saturating_add(1)
            .try_into()
            .unwrap_or(u32::MAX)
    }
}

/// Computes a line diff using Histogram plus line postprocessing.
/// The tokenization intentionally follows the frontend's existing `split("\n")`
/// behavior rather than `imara-diff`'s default line source so that integration can
/// preserve current line-number semantics.
pub fn compute_line_diff(old_text: &str, new_text: &str) -> LinePatch {
    let input = InternedInput::new(JsSplitLines(old_text), JsSplitLines(new_text));
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);

    LinePatch {
        edits: diff
            .hunks()
            .map(|hunk| LineEdit {
                old_start: hunk.before.start,
                old_end: hunk.before.end,
                new_start: hunk.after.start,
                new_end: hunk.after.end,
            })
            .collect(),
    }
}

fn build_line_start_offsets_utf16(units: &[u16]) -> Vec<u32> {
    let mut offsets = vec![0];
    for (index, unit) in units.iter().enumerate() {
        if *unit == b'\n' as u16 {
            offsets.push((index + 1).try_into().unwrap_or(u32::MAX));
        }
    }
    offsets
}

fn line_index_to_offset(line_starts: &[u32], text_len: u32, line: u32) -> u32 {
    if line == 0 {
        return 0;
    }

    let Some(&offset) = line_starts.get(line as usize) else {
        return text_len;
    };
    offset
}

fn common_prefix_length_utf16(left: &[u16], right: &[u16]) -> u32 {
    let mut index = 0;
    let limit = left.len().min(right.len());

    while index < limit && left[index] == right[index] {
        index += 1;
    }

    index.try_into().unwrap_or(u32::MAX)
}

fn common_suffix_length_utf16(left: &[u16], right: &[u16], prefix_length: u32) -> u32 {
    let max_suffix = left
        .len()
        .min(right.len())
        .saturating_sub(prefix_length as usize);
    let mut index = 0;

    while index < max_suffix && left[left.len() - 1 - index] == right[right.len() - 1 - index] {
        index += 1;
    }

    index.try_into().unwrap_or(u32::MAX)
}

pub fn compute_text_range_patch(
    old_text: &str,
    new_text: &str,
    line_patch: &LinePatch,
) -> TextRangePatch {
    if line_patch.edits.is_empty() {
        return TextRangePatch::default();
    }

    let old_units: Vec<u16> = old_text.encode_utf16().collect();
    let new_units: Vec<u16> = new_text.encode_utf16().collect();
    let old_line_starts = build_line_start_offsets_utf16(&old_units);
    let new_line_starts = build_line_start_offsets_utf16(&new_units);

    let spans = line_patch
        .edits
        .iter()
        .filter_map(|edit| {
            let base_window_start =
                line_index_to_offset(&old_line_starts, old_units.len() as u32, edit.old_start)
                    as usize;
            let base_window_end =
                line_index_to_offset(&old_line_starts, old_units.len() as u32, edit.old_end)
                    as usize;
            let current_window_start =
                line_index_to_offset(&new_line_starts, new_units.len() as u32, edit.new_start)
                    as usize;
            let current_window_end =
                line_index_to_offset(&new_line_starts, new_units.len() as u32, edit.new_end)
                    as usize;

            let base_window = &old_units[base_window_start..base_window_end];
            let current_window = &new_units[current_window_start..current_window_end];

            if base_window == current_window {
                return None;
            }

            let prefix_length = common_prefix_length_utf16(base_window, current_window);
            let suffix_length =
                common_suffix_length_utf16(base_window, current_window, prefix_length);

            Some(AgentTextSpan {
                base_from: base_window_start as u32 + prefix_length,
                base_to: base_window_end as u32 - suffix_length,
                current_from: current_window_start as u32 + prefix_length,
                current_to: current_window_end as u32 - suffix_length,
            })
        })
        .collect();

    TextRangePatch { spans }
}

pub fn compute_tracked_file_patch(old_text: &str, new_text: &str) -> TrackedFilePatches {
    let line_patch = compute_line_diff(old_text, new_text);
    let text_range_patch = compute_text_range_patch(old_text, new_text, &line_patch);

    TrackedFilePatches {
        line_patch,
        text_range_patch,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WordTokenKind {
    Whitespace,
    Word,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WordDiffToken {
    units: Vec<u16>,
    from: u32,
    to: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Utf16Range {
    from: u32,
    to: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TokenEdit {
    old_start: usize,
    old_end: usize,
    new_start: usize,
    new_end: usize,
}

fn is_word_unit(unit: u16) -> bool {
    (b'0' as u16 <= unit && unit <= b'9' as u16)
        || (b'A' as u16 <= unit && unit <= b'Z' as u16)
        || (b'a' as u16 <= unit && unit <= b'z' as u16)
        || unit == b'_' as u16
}

fn is_whitespace_unit(unit: u16) -> bool {
    char::from_u32(unit as u32)
        .map(char::is_whitespace)
        .unwrap_or(false)
}

fn classify_word_unit(unit: u16) -> WordTokenKind {
    if is_whitespace_unit(unit) {
        WordTokenKind::Whitespace
    } else if is_word_unit(unit) {
        WordTokenKind::Word
    } else {
        WordTokenKind::Other
    }
}

fn tokenize_word_diff_text(units: &[u16], absolute_offset: u32) -> Vec<WordDiffToken> {
    if units.is_empty() {
        return Vec::new();
    }

    let mut tokens = Vec::new();
    let mut start = 0usize;

    while start < units.len() {
        let kind = classify_word_unit(units[start]);
        let mut end = start + 1;

        while end < units.len() && classify_word_unit(units[end]) == kind {
            end += 1;
        }

        tokens.push(WordDiffToken {
            units: units[start..end].to_vec(),
            from: absolute_offset + start as u32,
            to: absolute_offset + end as u32,
        });

        start = end;
    }

    tokens
}

fn build_token_diff_edits(
    old_tokens: &[WordDiffToken],
    new_tokens: &[WordDiffToken],
) -> Vec<TokenEdit> {
    let rows = old_tokens.len() + 1;
    let cols = new_tokens.len() + 1;
    let mut table = vec![vec![0usize; cols]; rows];

    for row in 1..rows {
        for col in 1..cols {
            table[row][col] = if old_tokens[row - 1].units == new_tokens[col - 1].units {
                table[row - 1][col - 1] + 1
            } else {
                table[row - 1][col].max(table[row][col - 1])
            };
        }
    }

    let mut edits = Vec::new();
    let mut old_index = old_tokens.len();
    let mut new_index = new_tokens.len();
    let mut current_edit: Option<TokenEdit> = None;

    while old_index > 0 || new_index > 0 {
        if old_index > 0
            && new_index > 0
            && old_tokens[old_index - 1].units == new_tokens[new_index - 1].units
        {
            if let Some(edit) = current_edit.take() {
                edits.push(edit);
            }
            old_index -= 1;
            new_index -= 1;
        } else if new_index > 0
            && (old_index == 0
                || table[old_index][new_index - 1] >= table[old_index - 1][new_index])
        {
            if let Some(edit) = &mut current_edit {
                edit.new_start = new_index - 1;
            } else {
                current_edit = Some(TokenEdit {
                    old_start: old_index,
                    old_end: old_index,
                    new_start: new_index - 1,
                    new_end: new_index,
                });
            }
            new_index -= 1;
        } else {
            if let Some(edit) = &mut current_edit {
                edit.old_start = old_index - 1;
            } else {
                current_edit = Some(TokenEdit {
                    old_start: old_index - 1,
                    old_end: old_index,
                    new_start: new_index,
                    new_end: new_index,
                });
            }
            old_index -= 1;
        }
    }

    if let Some(edit) = current_edit {
        edits.push(edit);
    }

    edits.reverse();
    edits
}

fn token_boundary_offset(
    tokens: &[WordDiffToken],
    token_index: usize,
    line_start: u32,
    line_end: u32,
) -> u32 {
    if token_index == 0 {
        return line_start;
    }
    if token_index >= tokens.len() {
        return line_end;
    }
    tokens[token_index].from
}

fn trim_whitespace_range(units: &[u16], from: u32, to: u32) -> Utf16Range {
    let mut start = from as usize;
    let mut end = to as usize;

    while start < end && is_whitespace_unit(units[start]) {
        start += 1;
    }
    while end > start && is_whitespace_unit(units[end - 1]) {
        end -= 1;
    }

    Utf16Range {
        from: start as u32,
        to: end as u32,
    }
}

fn merge_word_diff_ranges(ranges: &[WordDiffRange]) -> Vec<WordDiffRange> {
    if ranges.len() <= 1 {
        return ranges.to_vec();
    }

    let mut sorted = ranges.to_vec();
    sorted.sort_by(|left, right| left.from.cmp(&right.from));

    let mut merged = vec![sorted[0].clone()];
    for range in sorted.into_iter().skip(1) {
        let previous = merged
            .last_mut()
            .expect("merged always contains the first range");
        if range.from <= previous.to && range.base_from <= previous.base_to {
            previous.to = previous.to.max(range.to);
            previous.base_to = previous.base_to.max(range.base_to);
        } else {
            merged.push(range);
        }
    }

    merged
}

fn line_content_range(line_starts: &[u32], text_len: u32, line_index: u32) -> Utf16Range {
    let from = line_index_to_offset(line_starts, text_len, line_index);
    if line_index + 1 >= line_starts.len() as u32 {
        return Utf16Range { from, to: text_len };
    }

    Utf16Range {
        from,
        to: line_starts[(line_index + 1) as usize].saturating_sub(1),
    }
}

fn compute_word_diffs_for_line(
    base_units: &[u16],
    current_units: &[u16],
    base_range: Utf16Range,
    current_range: Utf16Range,
) -> Option<HunkWordDiffs> {
    let base_line = &base_units[base_range.from as usize..base_range.to as usize];
    let current_line = &current_units[current_range.from as usize..current_range.to as usize];

    if base_line == current_line {
        return None;
    }

    let old_tokens = tokenize_word_diff_text(base_line, base_range.from);
    let new_tokens = tokenize_word_diff_text(current_line, current_range.from);
    let token_edits = build_token_diff_edits(&old_tokens, &new_tokens);

    if token_edits.is_empty() {
        return None;
    }

    let mut buffer_ranges = Vec::new();
    let mut base_ranges = Vec::new();

    for edit in token_edits {
        let base_from =
            token_boundary_offset(&old_tokens, edit.old_start, base_range.from, base_range.to);
        let base_to =
            token_boundary_offset(&old_tokens, edit.old_end, base_range.from, base_range.to);
        let current_from = token_boundary_offset(
            &new_tokens,
            edit.new_start,
            current_range.from,
            current_range.to,
        );
        let current_to = token_boundary_offset(
            &new_tokens,
            edit.new_end,
            current_range.from,
            current_range.to,
        );

        let trimmed_base = trim_whitespace_range(base_units, base_from, base_to);
        let trimmed_current = trim_whitespace_range(current_units, current_from, current_to);

        if trimmed_current.from < trimmed_current.to {
            buffer_ranges.push(WordDiffRange {
                from: trimmed_current.from,
                to: trimmed_current.to,
                base_from: trimmed_base.from,
                base_to: trimmed_base.to,
            });
        }

        if trimmed_base.from < trimmed_base.to {
            base_ranges.push(WordDiffRange {
                from: trimmed_base.from,
                to: trimmed_base.to,
                base_from: trimmed_base.from,
                base_to: trimmed_base.to,
            });
        }
    }

    if buffer_ranges.is_empty() && base_ranges.is_empty() {
        return None;
    }

    Some(HunkWordDiffs {
        buffer_ranges: merge_word_diff_ranges(&buffer_ranges),
        base_ranges: merge_word_diff_ranges(&base_ranges),
    })
}

pub fn compute_word_diffs_for_hunk(
    base_text: &str,
    current_text: &str,
    edit: &LineEdit,
    max_lines: u32,
    max_chars: u32,
) -> Option<HunkWordDiffs> {
    let old_line_count = edit.old_end.saturating_sub(edit.old_start);
    let new_line_count = edit.new_end.saturating_sub(edit.new_start);

    if old_line_count == 0 || new_line_count == 0 {
        return None;
    }
    if old_line_count != new_line_count {
        return None;
    }
    if old_line_count > max_lines {
        return None;
    }

    let base_units: Vec<u16> = base_text.encode_utf16().collect();
    let current_units: Vec<u16> = current_text.encode_utf16().collect();
    let base_line_starts = build_line_start_offsets_utf16(&base_units);
    let current_line_starts = build_line_start_offsets_utf16(&current_units);

    let base_window_start =
        line_index_to_offset(&base_line_starts, base_units.len() as u32, edit.old_start);
    let base_window_end =
        line_index_to_offset(&base_line_starts, base_units.len() as u32, edit.old_end);
    let current_window_start = line_index_to_offset(
        &current_line_starts,
        current_units.len() as u32,
        edit.new_start,
    );
    let current_window_end = line_index_to_offset(
        &current_line_starts,
        current_units.len() as u32,
        edit.new_end,
    );

    if (base_window_end - base_window_start).max(current_window_end - current_window_start)
        > max_chars
    {
        return None;
    }

    let mut buffer_ranges = Vec::new();
    let mut base_ranges = Vec::new();

    for line_offset in 0..old_line_count {
        let base_range = line_content_range(
            &base_line_starts,
            base_units.len() as u32,
            edit.old_start + line_offset,
        );
        let current_range = line_content_range(
            &current_line_starts,
            current_units.len() as u32,
            edit.new_start + line_offset,
        );

        let Some(line_diff) =
            compute_word_diffs_for_line(&base_units, &current_units, base_range, current_range)
        else {
            continue;
        };

        buffer_ranges.extend(line_diff.buffer_ranges);
        base_ranges.extend(line_diff.base_ranges);
    }

    if buffer_ranges.is_empty() && base_ranges.is_empty() {
        return None;
    }

    Some(HunkWordDiffs {
        buffer_ranges: merge_word_diff_ranges(&buffer_ranges),
        base_ranges: merge_word_diff_ranges(&base_ranges),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_texts() {
        let result = compute_line_diff("", "");
        assert!(result.edits.is_empty());
    }

    #[test]
    fn identical_texts() {
        let result = compute_line_diff("hello\nworld\n", "hello\nworld\n");
        assert!(result.edits.is_empty());
    }

    #[test]
    fn single_line_addition() {
        let result = compute_line_diff("a\n", "a\nb\n");

        assert_eq!(
            result.edits,
            vec![LineEdit {
                old_start: 1,
                old_end: 1,
                new_start: 1,
                new_end: 2,
            }],
        );
    }

    #[test]
    fn single_line_removal() {
        let result = compute_line_diff("a\nb\n", "a\n");

        assert_eq!(
            result.edits,
            vec![LineEdit {
                old_start: 1,
                old_end: 2,
                new_start: 1,
                new_end: 1,
            }],
        );
    }

    #[test]
    fn modification() {
        let result = compute_line_diff("a\nb\nc\n", "a\nB\nc\n");

        assert_eq!(
            result.edits,
            vec![LineEdit {
                old_start: 1,
                old_end: 2,
                new_start: 1,
                new_end: 2,
            }],
        );
    }

    #[test]
    fn preserves_split_newline_semantics() {
        let result = compute_line_diff("a\n", "a");

        assert_eq!(
            result.edits,
            vec![LineEdit {
                old_start: 1,
                old_end: 2,
                new_start: 1,
                new_end: 1,
            }],
        );
    }

    #[test]
    fn large_file_doesnt_panic() {
        let old: String = (0..10_000).map(|i| format!("line {i}\n")).collect();
        let new: String = (0..10_000)
            .map(|i| {
                if i % 100 == 0 {
                    format!("changed line {i}\n")
                } else {
                    format!("line {i}\n")
                }
            })
            .collect();

        let result = compute_line_diff(&old, &new);
        assert_eq!(result.edits.len(), 100);
    }

    #[test]
    fn computes_inline_text_ranges_for_single_line_change() {
        let result = compute_tracked_file_patch("alpha", "alpHa");

        assert_eq!(
            result.text_range_patch.spans,
            vec![AgentTextSpan {
                base_from: 3,
                base_to: 4,
                current_from: 3,
                current_to: 4,
            }],
        );
    }

    #[test]
    fn computes_inline_text_ranges_for_multiline_change() {
        let result = compute_tracked_file_patch(
            "first line\nalpha\nlast line",
            "first line\nalpHa\nlast line",
        );

        assert_eq!(
            result.text_range_patch.spans,
            vec![AgentTextSpan {
                base_from: 14,
                base_to: 15,
                current_from: 14,
                current_to: 15,
            }],
        );
    }

    #[test]
    fn uses_utf16_offsets_for_unicode_spans() {
        let result = compute_tracked_file_patch("a🙂b", "a🙂B");

        assert_eq!(
            result.text_range_patch.spans,
            vec![AgentTextSpan {
                base_from: 3,
                base_to: 4,
                current_from: 3,
                current_to: 4,
            }],
        );
    }

    #[test]
    fn computes_word_diffs_for_small_modified_hunk() {
        let edit = compute_line_diff("alpha beta gamma", "alpha BETA delta gamma")
            .edits
            .into_iter()
            .next()
            .expect("expected one hunk");

        let result = compute_word_diffs_for_hunk(
            "alpha beta gamma",
            "alpha BETA delta gamma",
            &edit,
            5,
            240,
        )
        .expect("expected refined word diffs");

        assert_eq!(
            result.buffer_ranges,
            vec![WordDiffRange {
                from: 6,
                to: 16,
                base_from: 6,
                base_to: 10,
            }],
        );
        assert_eq!(
            result.base_ranges,
            vec![WordDiffRange {
                from: 6,
                to: 10,
                base_from: 6,
                base_to: 10,
            }],
        );
    }

    #[test]
    fn skips_word_diff_for_large_hunks() {
        let base_text = ["a", "b", "c", "d", "e", "f"].join("\n");
        let current_text = ["A", "B", "C", "D", "E", "F"].join("\n");
        let edit = compute_line_diff(&base_text, &current_text)
            .edits
            .into_iter()
            .next()
            .expect("expected one hunk");

        assert_eq!(
            compute_word_diffs_for_hunk(&base_text, &current_text, &edit, 5, 240),
            None,
        );
    }

    #[test]
    fn skips_word_diff_for_additions_and_deletions() {
        let added = compute_line_diff("alpha", "alpha\nbeta")
            .edits
            .into_iter()
            .next()
            .expect("expected add hunk");
        let deleted = compute_line_diff("alpha\nbeta", "alpha")
            .edits
            .into_iter()
            .next()
            .expect("expected delete hunk");

        assert_eq!(
            compute_word_diffs_for_hunk("alpha", "alpha\nbeta", &added, 5, 240),
            None,
        );
        assert_eq!(
            compute_word_diffs_for_hunk("alpha\nbeta", "alpha", &deleted, 5, 240),
            None,
        );
    }
}
