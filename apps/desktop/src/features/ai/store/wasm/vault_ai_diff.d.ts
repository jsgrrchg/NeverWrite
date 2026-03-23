/* tslint:disable */
/* eslint-disable */

export function apply_non_conflicting_edits_json(file_json: string, user_edits_json: string, new_full_text: string): string;

export function apply_reject_undo_json(file_json: string, undo_json: string): string;

export function build_patch_from_texts_json(old_text: string, new_text: string): string;

export function build_text_range_patch_from_texts_json(old_text: string, new_text: string, line_patch_json?: string | null): string;

export function compute_word_diffs_for_hunk_json(base_text: string, current_text: string, edit_json: string, max_lines: number, max_chars: number): string;

export function derive_line_patch_from_text_ranges_json(base_text: string, current_text: string, spans_json: string): string;

export function keep_edits_in_range_json(file_json: string, start_line: number, end_line: number): string;

export function keep_exact_spans_json(file_json: string, spans_json: string): string;

export function map_agent_span_through_text_edits_json(span_json: string, edits_json: string): string;

export function map_text_position_through_edits_json(position: number, edits_json: string, assoc: number): number;

export function partition_spans_by_overlap_json(spans_json: string, ranges_json: string, base_text: string, current_text: string): string;

export function rebuild_diff_base_from_pending_spans_json(original_diff_base: string, current_text: string, spans_json: string): string;

export function reject_all_edits_json(file_json: string): string;

export function reject_edits_in_ranges_json(file_json: string, ranges_json: string): string;

export function reject_exact_spans_json(file_json: string, spans_json: string): string;

export function sync_derived_line_patch_json(file_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly apply_non_conflicting_edits_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly apply_reject_undo_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly build_patch_from_texts_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly build_text_range_patch_from_texts_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly compute_word_diffs_for_hunk_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly derive_line_patch_from_text_ranges_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly keep_edits_in_range_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly keep_exact_spans_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly map_agent_span_through_text_edits_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly map_text_position_through_edits_json: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly partition_spans_by_overlap_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly rebuild_diff_base_from_pending_spans_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly reject_all_edits_json: (a: number, b: number) => [number, number, number, number];
    readonly reject_edits_in_ranges_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly reject_exact_spans_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly sync_derived_line_patch_json: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
