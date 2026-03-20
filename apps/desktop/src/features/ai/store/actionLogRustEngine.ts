import {
    default as initActionLogWasm,
    initSync as initActionLogWasmSync,
    apply_non_conflicting_edits_json,
    apply_reject_undo_json,
    build_patch_from_texts_json,
    build_text_range_patch_from_texts_json,
    compute_word_diffs_for_hunk_json,
    derive_line_patch_from_text_ranges_json,
    keep_edits_in_range_json,
    map_agent_span_through_text_edits_json,
    map_text_position_through_edits_json,
    partition_spans_by_overlap_json,
    rebuild_diff_base_from_pending_spans_json,
    reject_all_edits_json,
    reject_edits_in_ranges_json,
    sync_derived_line_patch_json,
} from "./wasm/vault_ai_diff";
import wasmUrl from "./wasm/vault_ai_diff_bg.wasm?url";
import type {
    AgentTextSpan,
    HunkWordDiffs,
    LinePatch,
    PerFileUndo,
    TextEdit,
    TextRangePatch,
    TrackedFile,
} from "../diff/actionLogTypes";
import {
    applyNonConflictingEditsFallback,
    applyRejectUndoFallback,
    buildPatchFromTextsFallback,
    buildTextRangePatchFromTextsFallback,
    computeWordDiffsForHunkFallback,
    deriveLinePatchFromTextRangesFallback,
    keepEditsInRangeFallback,
    mapAgentSpanThroughTextEditsFallback,
    mapTextPositionThroughEditsFallback,
    partitionSpansByOverlapFallback,
    rebuildDiffBaseFromPendingSpansFallback,
    rejectAllEditsFallback,
    rejectEditsInRangesFallback,
    syncDerivedLinePatchFallback,
} from "./actionLogJsFallback";

let rustEngineReady = false;
let rustEngineInitError: unknown = null;
let rustEngineRuntimeFallbackWarned = false;

async function initActionLogRustEngine() {
    if (import.meta.env.MODE === "test") {
        const { readFile } = await import(
            /* @vite-ignore */ "node:fs/promises"
        );
        const { join } = await import(/* @vite-ignore */ "node:path");

        if (/^file:/.test(wasmUrl)) {
            const { fileURLToPath } = await import(
                /* @vite-ignore */ "node:url"
            );
            initActionLogWasmSync({
                module: await readFile(fileURLToPath(wasmUrl)),
            });
            return;
        }

        if (/^https?:/.test(wasmUrl)) {
            const response = await fetch(wasmUrl);
            initActionLogWasmSync({
                module: new Uint8Array(await response.arrayBuffer()),
            });
            return;
        }

        const cwd =
            (
                globalThis as {
                    process?: { cwd?: () => string };
                }
            ).process?.cwd?.() ?? "";
        const filesystemPath = wasmUrl.startsWith("/@fs/")
            ? wasmUrl.slice("/@fs".length)
            : join(cwd, wasmUrl.replace(/^\/+/, ""));

        initActionLogWasmSync({
            module: await readFile(filesystemPath),
        });
        return;
    }

    await initActionLogWasm({ module_or_path: wasmUrl });
}

await (async () => {
    try {
        await initActionLogRustEngine();
        rustEngineReady = true;
    } catch (error) {
        rustEngineInitError = error;
        console.warn(
            "Failed to initialize the Rust/WASM action log engine; using the JS emergency fallback.",
            error,
        );
    }
})();

type RejectEditsResult = {
    file: TrackedFile;
    undoData: PerFileUndo;
};

type PartitionedSpans = {
    overlapping: AgentTextSpan[];
    nonOverlapping: AgentTextSpan[];
};

function parseJson<T>(json: string): T {
    return JSON.parse(json) as T;
}

function callWithFallback<T>(rustCall: () => T, fallbackCall: () => T): T {
    if (!rustEngineReady) {
        return fallbackCall();
    }

    try {
        return rustCall();
    } catch (error) {
        if (!rustEngineRuntimeFallbackWarned) {
            rustEngineRuntimeFallbackWarned = true;
            console.warn(
                "Rust/WASM action log call failed; using the JS emergency fallback for this session.",
                error,
                rustEngineInitError,
            );
        }
        return fallbackCall();
    }
}

export function buildPatchFromTextsRust(
    oldText: string,
    newText: string,
): LinePatch {
    return callWithFallback(
        () => parseJson(build_patch_from_texts_json(oldText, newText)),
        () => buildPatchFromTextsFallback(oldText, newText),
    );
}

export function buildTextRangePatchFromTextsRust(
    oldText: string,
    newText: string,
    linePatch?: LinePatch,
): TextRangePatch {
    return callWithFallback(
        () =>
            parseJson(
                build_text_range_patch_from_texts_json(
                    oldText,
                    newText,
                    linePatch ? JSON.stringify(linePatch) : undefined,
                ),
            ),
        () => buildTextRangePatchFromTextsFallback(oldText, newText, linePatch),
    );
}

export function computeWordDiffsForHunkRust(
    baseText: string,
    currentText: string,
    edit: {
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
    },
    options: {
        maxLines?: number;
        maxChars?: number;
    } = {},
): HunkWordDiffs | null {
    return callWithFallback(
        () =>
            parseJson(
                compute_word_diffs_for_hunk_json(
                    baseText,
                    currentText,
                    JSON.stringify(edit),
                    options.maxLines ?? 5,
                    options.maxChars ?? 240,
                ),
            ),
        () =>
            computeWordDiffsForHunkFallback(
                baseText,
                currentText,
                edit,
                options,
            ),
    );
}

export function deriveLinePatchFromTextRangesRust(
    baseText: string,
    currentText: string,
    spans: AgentTextSpan[],
): LinePatch {
    return callWithFallback(
        () =>
            parseJson(
                derive_line_patch_from_text_ranges_json(
                    baseText,
                    currentText,
                    JSON.stringify(spans),
                ),
            ),
        () =>
            deriveLinePatchFromTextRangesFallback(baseText, currentText, spans),
    );
}

export function syncDerivedLinePatchRust(file: TrackedFile): TrackedFile {
    return callWithFallback(
        () => parseJson(sync_derived_line_patch_json(JSON.stringify(file))),
        () => syncDerivedLinePatchFallback(file),
    );
}

export function applyNonConflictingEditsRust(
    file: TrackedFile,
    userEdits: TextEdit[],
    newFullText: string,
): TrackedFile {
    return callWithFallback(
        () =>
            parseJson(
                apply_non_conflicting_edits_json(
                    JSON.stringify(file),
                    JSON.stringify(userEdits),
                    newFullText,
                ),
            ),
        () => applyNonConflictingEditsFallback(file, userEdits, newFullText),
    );
}

export function keepEditsInRangeRust(
    file: TrackedFile,
    startLine: number,
    endLine: number,
): TrackedFile {
    return callWithFallback(
        () =>
            parseJson(
                keep_edits_in_range_json(
                    JSON.stringify(file),
                    startLine,
                    endLine,
                ),
            ),
        () => keepEditsInRangeFallback(file, startLine, endLine),
    );
}

export function rejectAllEditsRust(file: TrackedFile): RejectEditsResult {
    return callWithFallback(
        () => parseJson(reject_all_edits_json(JSON.stringify(file))),
        () => rejectAllEditsFallback(file),
    );
}

export function rejectEditsInRangesRust(
    file: TrackedFile,
    ranges: Array<{ start: number; end: number }>,
): RejectEditsResult {
    return callWithFallback(
        () =>
            parseJson(
                reject_edits_in_ranges_json(
                    JSON.stringify(file),
                    JSON.stringify(ranges),
                ),
            ),
        () => rejectEditsInRangesFallback(file, ranges),
    );
}

export function applyRejectUndoRust(
    file: TrackedFile,
    undo: PerFileUndo,
): TrackedFile {
    return callWithFallback(
        () =>
            parseJson(
                apply_reject_undo_json(
                    JSON.stringify(file),
                    JSON.stringify(undo),
                ),
            ),
        () => applyRejectUndoFallback(file, undo),
    );
}

export function mapTextPositionThroughEditsRust(
    position: number,
    edits: TextEdit[],
    assoc: -1 | 1,
): number {
    return callWithFallback(
        () =>
            map_text_position_through_edits_json(
                position,
                JSON.stringify(edits),
                assoc,
            ),
        () => mapTextPositionThroughEditsFallback(position, edits, assoc),
    );
}

export function mapAgentSpanThroughTextEditsRust(
    span: AgentTextSpan,
    edits: TextEdit[],
): AgentTextSpan | null {
    return callWithFallback(
        () =>
            parseJson(
                map_agent_span_through_text_edits_json(
                    JSON.stringify(span),
                    JSON.stringify(edits),
                ),
            ),
        () => mapAgentSpanThroughTextEditsFallback(span, edits),
    );
}

export function rebuildDiffBaseFromPendingSpansRust(
    originalDiffBase: string,
    currentText: string,
    spans: AgentTextSpan[],
): string {
    return callWithFallback(
        () =>
            rebuild_diff_base_from_pending_spans_json(
                originalDiffBase,
                currentText,
                JSON.stringify(spans),
            ),
        () =>
            rebuildDiffBaseFromPendingSpansFallback(
                originalDiffBase,
                currentText,
                spans,
            ),
    );
}

export function partitionSpansByOverlapRust(
    spans: AgentTextSpan[],
    ranges: Array<{ start: number; end: number }>,
    baseText: string,
    currentText: string,
): PartitionedSpans {
    return callWithFallback(
        () =>
            parseJson(
                partition_spans_by_overlap_json(
                    JSON.stringify(spans),
                    JSON.stringify(ranges),
                    baseText,
                    currentText,
                ),
            ),
        () =>
            partitionSpansByOverlapFallback(
                spans,
                ranges,
                baseText,
                currentText,
            ),
    );
}
