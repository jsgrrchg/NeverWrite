/**
 * ActionLog model — Pure functions for patch-based change tracking.
 *
 * Follows the same pattern as editedFilesBufferModel.ts: no store imports,
 * all functions are pure and testable in isolation.
 */

import type {
    ActionLogState,
    AgentTextSpan,
    LineEdit,
    LinePatch,
    PerFileUndo,
    TextEdit,
    TextRangePatch,
    TrackedFile,
    TrackedFileStatus,
} from "../diff/actionLogTypes";
import type { AIFileDiff, AIFileDiffHunk, AIFileDiffHunkLine } from "../types";

// ---------------------------------------------------------------------------
// Patch primitives
// ---------------------------------------------------------------------------

export function emptyPatch(): LinePatch {
    return { edits: [] };
}

export function emptyTextRangePatch(): TextRangePatch {
    return { spans: [] };
}

export function patchIsEmpty(patch: LinePatch): boolean {
    return patch.edits.length === 0;
}

/** Check whether `line` falls inside any edit's *new* range. */
export function patchContainsLine(patch: LinePatch, line: number): boolean {
    return patch.edits.some(
        (edit) => line >= edit.newStart && line < edit.newEnd,
    );
}

/** Do [aStart, aEnd) and [bStart, bEnd) overlap? */
export function rangesOverlap(
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
): boolean {
    // Two empty (point) ranges at the same position overlap — needed for
    // pure deletions where newStart === newEnd.
    if (aStart === aEnd && bStart === bEnd) return aStart === bStart;
    return aStart < bEnd && bStart < aEnd;
}

/**
 * Shift all edits whose newStart >= `afterLine` by `delta` lines.
 * Returns a new array (does not mutate).
 */
export function shiftEditsAfter(
    edits: LineEdit[],
    afterLine: number,
    delta: number,
): LineEdit[] {
    return edits.map((edit) => {
        if (edit.newStart >= afterLine) {
            return {
                ...edit,
                newStart: edit.newStart + delta,
                newEnd: edit.newEnd + delta,
            };
        }
        return edit;
    });
}

function buildLineStartOffsets(text: string): number[] {
    const offsets = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") {
            offsets.push(index + 1);
        }
    }
    return offsets;
}

function lineIndexAtOffset(lineStarts: number[], offset: number): number {
    if (lineStarts.length === 0) return 0;
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= offset) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return Math.max(0, high);
}

function insertionLineIndexAtOffset(
    lineStarts: number[],
    offset: number,
): number {
    let low = 0;
    let high = lineStarts.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] < offset) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
}

function lineIndexToOffset(lineStarts: number[], text: string, line: number) {
    if (line <= 0) return 0;
    if (line >= lineStarts.length) return text.length;
    return lineStarts[line];
}

function commonPrefixLength(a: string, b: string): number {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) {
        index += 1;
    }
    return index;
}

function commonSuffixLength(
    a: string,
    b: string,
    prefixLength: number,
): number {
    const maxSuffix = Math.min(a.length, b.length) - prefixLength;
    let index = 0;
    while (
        index < maxSuffix &&
        a[a.length - 1 - index] === b[b.length - 1 - index]
    ) {
        index += 1;
    }
    return index;
}

function buildTextRangePatchFromLinePatch(
    baseText: string,
    currentText: string,
    patch: LinePatch,
): TextRangePatch {
    if (patchIsEmpty(patch)) {
        return emptyTextRangePatch();
    }

    const baseLineStarts = buildLineStartOffsets(baseText);
    const currentLineStarts = buildLineStartOffsets(currentText);
    const spans: AgentTextSpan[] = [];

    for (const edit of patch.edits) {
        const baseWindowStart = lineIndexToOffset(
            baseLineStarts,
            baseText,
            edit.oldStart,
        );
        const baseWindowEnd = lineIndexToOffset(
            baseLineStarts,
            baseText,
            edit.oldEnd,
        );
        const currentWindowStart = lineIndexToOffset(
            currentLineStarts,
            currentText,
            edit.newStart,
        );
        const currentWindowEnd = lineIndexToOffset(
            currentLineStarts,
            currentText,
            edit.newEnd,
        );

        const baseWindowText = baseText.slice(baseWindowStart, baseWindowEnd);
        const currentWindowText = currentText.slice(
            currentWindowStart,
            currentWindowEnd,
        );

        if (baseWindowText === currentWindowText) {
            continue;
        }

        const prefixLength = commonPrefixLength(
            baseWindowText,
            currentWindowText,
        );
        const suffixLength = commonSuffixLength(
            baseWindowText,
            currentWindowText,
            prefixLength,
        );

        spans.push({
            baseFrom: baseWindowStart + prefixLength,
            baseTo: baseWindowEnd - suffixLength,
            currentFrom: currentWindowStart + prefixLength,
            currentTo: currentWindowEnd - suffixLength,
        });
    }

    return { spans };
}

function isLineBoundary(text: string, offset: number): boolean {
    if (offset <= 0 || offset >= text.length) return true;
    return text[offset - 1] === "\n";
}

function isSingleLineTextRange(
    _text: string,
    lineStarts: number[],
    from: number,
    to: number,
): boolean {
    if (from >= to) return true;
    return (
        lineIndexAtOffset(lineStarts, from) ===
        lineIndexAtOffset(lineStarts, to - 1)
    );
}

function spanPartToLineRange(
    text: string,
    lineStarts: number[],
    from: number,
    to: number,
    counterpartText: string,
    counterpartFrom: number,
    counterpartTo: number,
): { start: number; end: number } {
    if (from === to && counterpartFrom === counterpartTo) {
        const point = insertionLineIndexAtOffset(lineStarts, from);
        return { start: point, end: point };
    }

    if (from === to) {
        const insertedText = counterpartText.slice(
            counterpartFrom,
            counterpartTo,
        );
        const inlineSingleLineInsert =
            !insertedText.includes("\n") &&
            !isLineBoundary(text, from) &&
            !isLineBoundary(counterpartText, counterpartFrom);

        if (inlineSingleLineInsert) {
            const line = lineIndexAtOffset(lineStarts, Math.max(0, from - 1));
            return { start: line, end: line + 1 };
        }

        const point = insertionLineIndexAtOffset(lineStarts, from);
        return { start: point, end: point };
    }

    const changedText = text.slice(from, to);
    const counterpartChangedText = counterpartText.slice(
        counterpartFrom,
        counterpartTo,
    );
    const inlineSingleLineChange =
        !changedText.includes("\n") &&
        !counterpartChangedText.includes("\n") &&
        isSingleLineTextRange(text, lineStarts, from, to);

    if (inlineSingleLineChange) {
        const line = lineIndexAtOffset(lineStarts, from);
        return { start: line, end: line + 1 };
    }

    return {
        start: lineIndexAtOffset(lineStarts, from),
        end: lineIndexAtOffset(lineStarts, to - 1) + 1,
    };
}

function mergeOverlappingLineEdits(edits: LineEdit[]): LineEdit[] {
    if (edits.length <= 1) return edits;

    const sorted = [...edits].sort((left, right) => {
        if (left.newStart !== right.newStart) {
            return left.newStart - right.newStart;
        }
        if (left.newEnd !== right.newEnd) {
            return left.newEnd - right.newEnd;
        }
        if (left.oldStart !== right.oldStart) {
            return left.oldStart - right.oldStart;
        }
        return left.oldEnd - right.oldEnd;
    });

    const merged: LineEdit[] = [sorted[0]];
    for (const edit of sorted.slice(1)) {
        const previous = merged[merged.length - 1];
        const overlapsOld = rangesOverlap(
            previous.oldStart,
            previous.oldEnd,
            edit.oldStart,
            edit.oldEnd,
        );
        const overlapsNew = rangesOverlap(
            previous.newStart,
            previous.newEnd,
            edit.newStart,
            edit.newEnd,
        );

        if (overlapsOld || overlapsNew) {
            previous.oldStart = Math.min(previous.oldStart, edit.oldStart);
            previous.oldEnd = Math.max(previous.oldEnd, edit.oldEnd);
            previous.newStart = Math.min(previous.newStart, edit.newStart);
            previous.newEnd = Math.max(previous.newEnd, edit.newEnd);
            continue;
        }

        merged.push({ ...edit });
    }

    return merged;
}

export function mapTextPositionThroughEdits(
    position: number,
    edits: TextEdit[],
    assoc: -1 | 1,
): number {
    let delta = 0;

    for (const edit of edits) {
        const changeDelta =
            edit.newTo - edit.newFrom - (edit.oldTo - edit.oldFrom);

        if (edit.oldTo < position || (edit.oldTo === position && assoc > 0)) {
            delta += changeDelta;
            continue;
        }

        break;
    }

    return position + delta;
}

export function mapAgentSpanThroughTextEdits(
    span: AgentTextSpan,
    edits: TextEdit[],
): AgentTextSpan | null {
    const touchedByUser = edits.some((edit) =>
        rangesOverlap(
            edit.oldFrom,
            edit.oldTo,
            span.currentFrom,
            span.currentTo,
        ),
    );

    if (touchedByUser) {
        return null;
    }

    return {
        ...span,
        currentFrom: mapTextPositionThroughEdits(span.currentFrom, edits, 1),
        currentTo: mapTextPositionThroughEdits(span.currentTo, edits, -1),
    };
}

export function rebuildDiffBaseFromPendingSpans(
    originalDiffBase: string,
    currentText: string,
    spans: AgentTextSpan[],
): string {
    if (spans.length === 0) {
        return currentText;
    }

    const sortedSpans = [...spans].sort(
        (left, right) => left.currentFrom - right.currentFrom,
    );
    const parts: string[] = [];
    let cursor = 0;

    for (const span of sortedSpans) {
        parts.push(currentText.slice(cursor, span.currentFrom));
        parts.push(originalDiffBase.slice(span.baseFrom, span.baseTo));
        cursor = span.currentTo;
    }

    parts.push(currentText.slice(cursor));
    return parts.join("");
}

function getLineEditForSpan(
    baseText: string,
    currentText: string,
    span: AgentTextSpan,
): LineEdit | null {
    const patch = deriveLinePatchFromTextRanges(baseText, currentText, [span]);
    return patch.edits[0] ?? null;
}

function spanMatchesLineRange(
    baseText: string,
    currentText: string,
    span: AgentTextSpan,
    startLine: number,
    endLine: number,
): boolean {
    const edit = getLineEditForSpan(baseText, currentText, span);
    if (!edit) return false;
    return rangesOverlap(startLine, endLine, edit.newStart, edit.newEnd);
}

/**
 * Build a LinePatch from two texts by running a simple LCS diff.
 * Groups consecutive add/remove operations into contiguous edits.
 */
export function buildPatchFromTexts(
    oldText: string,
    newText: string,
): LinePatch {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    // Build LCS table
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table: number[][] = Array.from({ length: rows }, () =>
        new Array<number>(cols).fill(0),
    );
    for (let r = 1; r < rows; r++) {
        for (let c = 1; c < cols; c++) {
            table[r][c] =
                oldLines[r - 1] === newLines[c - 1]
                    ? table[r - 1][c - 1] + 1
                    : Math.max(table[r - 1][c], table[r][c - 1]);
        }
    }

    // Backtrack to collect change hunks
    const edits: LineEdit[] = [];
    let oi = oldLines.length;
    let ni = newLines.length;
    let currentEdit: LineEdit | null = null;

    // Walk backward through LCS table
    while (oi > 0 || ni > 0) {
        if (oi > 0 && ni > 0 && oldLines[oi - 1] === newLines[ni - 1]) {
            // Context — close open edit
            if (currentEdit) {
                edits.push(currentEdit);
                currentEdit = null;
            }
            oi--;
            ni--;
        } else if (
            ni > 0 &&
            (oi === 0 || table[oi][ni - 1] >= table[oi - 1][ni])
        ) {
            // Addition in new text
            if (!currentEdit) {
                currentEdit = {
                    oldStart: oi,
                    oldEnd: oi,
                    newStart: ni - 1,
                    newEnd: ni,
                };
            } else {
                currentEdit.newStart = ni - 1;
            }
            ni--;
        } else {
            // Removal from old text
            if (!currentEdit) {
                currentEdit = {
                    oldStart: oi - 1,
                    oldEnd: oi,
                    newStart: ni,
                    newEnd: ni,
                };
            } else {
                currentEdit.oldStart = oi - 1;
            }
            oi--;
        }
    }

    if (currentEdit) {
        edits.push(currentEdit);
    }

    // We built edits backward — reverse to get sorted order.
    edits.reverse();
    return { edits };
}

export function buildTextRangePatchFromTexts(
    oldText: string,
    newText: string,
): TextRangePatch {
    if (oldText === newText) {
        return emptyTextRangePatch();
    }

    return buildTextRangePatchFromLinePatch(
        oldText,
        newText,
        buildPatchFromTexts(oldText, newText),
    );
}

export function deriveLinePatchFromTextRanges(
    baseText: string,
    currentText: string,
    spans: AgentTextSpan[],
): LinePatch {
    if (spans.length === 0) {
        return emptyPatch();
    }

    const baseLineStarts = buildLineStartOffsets(baseText);
    const currentLineStarts = buildLineStartOffsets(currentText);
    const edits = spans.map((span) => {
        const oldRange = spanPartToLineRange(
            baseText,
            baseLineStarts,
            span.baseFrom,
            span.baseTo,
            currentText,
            span.currentFrom,
            span.currentTo,
        );
        const newRange = spanPartToLineRange(
            currentText,
            currentLineStarts,
            span.currentFrom,
            span.currentTo,
            baseText,
            span.baseFrom,
            span.baseTo,
        );

        return {
            oldStart: oldRange.start,
            oldEnd: oldRange.end,
            newStart: newRange.start,
            newEnd: newRange.end,
        };
    });

    return { edits: mergeOverlappingLineEdits(edits) };
}

function spansEqual(a: AgentTextSpan[], b: AgentTextSpan[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((span, index) => {
        const other = b[index];
        return (
            span.baseFrom === other.baseFrom &&
            span.baseTo === other.baseTo &&
            span.currentFrom === other.currentFrom &&
            span.currentTo === other.currentTo
        );
    });
}

function linePatchesEqual(a: LinePatch, b: LinePatch): boolean {
    if (a.edits.length !== b.edits.length) return false;
    return a.edits.every((edit, index) => {
        const other = b.edits[index];
        return (
            edit.oldStart === other.oldStart &&
            edit.oldEnd === other.oldEnd &&
            edit.newStart === other.newStart &&
            edit.newEnd === other.newEnd
        );
    });
}

export function syncDerivedLinePatch(file: TrackedFile): TrackedFile {
    const unreviewedRanges = file.unreviewedRanges
        ? file.unreviewedRanges
        : buildTextRangePatchFromTexts(file.diffBase, file.currentText);
    const unreviewedEdits = deriveLinePatchFromTextRanges(
        file.diffBase,
        file.currentText,
        unreviewedRanges.spans,
    );

    if (
        file.unreviewedRanges &&
        spansEqual(file.unreviewedRanges.spans, unreviewedRanges.spans) &&
        linePatchesEqual(file.unreviewedEdits, unreviewedEdits)
    ) {
        return file;
    }

    return {
        ...file,
        unreviewedRanges,
        unreviewedEdits,
    };
}

function syncTrackedFiles(
    files: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
    let changed = false;
    const next: Record<string, TrackedFile> = {};

    for (const [key, file] of Object.entries(files)) {
        const synced = syncDerivedLinePatch(file);
        next[key] = synced;
        if (synced !== file) {
            changed = true;
        }
    }

    return changed ? next : files;
}

// ---------------------------------------------------------------------------
// TrackedFile creation / update from AIFileDiff
// ---------------------------------------------------------------------------

function statusFromDiffKind(kind: AIFileDiff["kind"]): TrackedFileStatus {
    switch (kind) {
        case "add":
            return { kind: "created", existingFileContent: null };
        case "delete":
            return { kind: "deleted" };
        default:
            // "update" | "move"
            return { kind: "modified" };
    }
}

export function createTrackedFileFromDiff(
    diff: AIFileDiff,
    timestamp: number,
): TrackedFile {
    const oldText = diff.old_text ?? "";
    const newText = diff.new_text ?? "";
    const status = statusFromDiffKind(diff.kind);

    // For "add", diffBase is empty (file didn't exist).
    // For "delete", currentText is empty (file will be removed).
    const diffBase = diff.kind === "add" ? "" : oldText;
    const currentText = diff.kind === "delete" ? "" : newText;

    const unreviewedEdits =
        diffBase === currentText
            ? emptyPatch()
            : buildPatchFromTexts(diffBase, currentText);
    const unreviewedRanges =
        diffBase === currentText
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTexts(diffBase, currentText);

    return {
        identityKey: diff.path,
        originPath: diff.previous_path ?? diff.path,
        path: diff.path,
        previousPath: diff.previous_path ?? null,
        status,
        diffBase,
        currentText,
        unreviewedRanges,
        unreviewedEdits,
        version: 1,
        isText: diff.is_text !== false,
        updatedAt: timestamp,
    };
}

/**
 * Whether a TrackedFile has reliable enough data to show inline
 * decorations in the editor.  When `diffBase` is empty for a
 * non-created file it means `old_text` was missing from the agent
 * diff, so the computed line positions would be wrong (everything
 * at line 0).
 */
export function shouldShowInlineDiff(tracked: TrackedFile): boolean {
    const synced = syncDerivedLinePatch(tracked);
    if (synced.unreviewedEdits.edits.length === 0) return false;
    if (synced.diffBase === "" && synced.status.kind !== "created")
        return false;
    return true;
}

export function updateTrackedFileWithDiff(
    file: TrackedFile,
    diff: AIFileDiff,
    timestamp: number,
): TrackedFile {
    const newText = diff.new_text ?? "";
    const currentText = diff.kind === "delete" ? "" : newText;

    // diffBase stays the same (always the pre-agent state)
    const unreviewedEdits =
        file.diffBase === currentText
            ? emptyPatch()
            : buildPatchFromTexts(file.diffBase, currentText);
    const unreviewedRanges =
        file.diffBase === currentText
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTexts(file.diffBase, currentText);

    // Update status if operation changed (e.g. update → delete)
    let { status } = file;
    if (diff.kind === "delete") {
        status = { kind: "deleted" };
    } else if (
        status.kind === "deleted" &&
        (diff.kind === "update" || diff.kind === "move")
    ) {
        status = { kind: "modified" };
    }

    return {
        ...file,
        path: diff.path,
        previousPath: diff.previous_path ?? file.previousPath,
        status,
        currentText,
        unreviewedRanges,
        unreviewedEdits,
        conflictHash: null,
        version: file.version + 1,
        updatedAt: timestamp,
    };
}

// ---------------------------------------------------------------------------
// Consolidation (replaces consolidateEditedFilesBuffer for new sessions)
// ---------------------------------------------------------------------------

function getDiffLookupKey(diff: AIFileDiff): string {
    return diff.kind === "move" && diff.previous_path
        ? diff.previous_path
        : diff.path;
}

function findTrackedFile(
    files: Record<string, TrackedFile>,
    diff: AIFileDiff,
): TrackedFile | null {
    const key = getDiffLookupKey(diff);
    if (files[key]) return files[key];

    // Fallback: search by path or originPath for moves
    if (diff.kind === "move" && diff.previous_path) {
        for (const file of Object.values(files)) {
            if (
                file.path === diff.previous_path ||
                file.originPath === diff.previous_path
            ) {
                return file;
            }
        }
    }

    return null;
}

export function consolidateTrackedFiles(
    files: Record<string, TrackedFile>,
    diffs: AIFileDiff[],
    timestamp: number,
): Record<string, TrackedFile> {
    const next = { ...files };

    for (const diff of diffs) {
        if (diff.is_text === false || diff.reversible === false) {
            continue; // Skip unsupported files
        }

        const existing = findTrackedFile(next, diff);

        if (existing) {
            // Remove old key if identity changed (e.g. move)
            if (existing.identityKey !== diff.path) {
                delete next[existing.identityKey];
            }
            const updated = updateTrackedFileWithDiff(
                existing,
                diff,
                timestamp,
            );
            // If changes revert to original, remove from tracking
            if (
                patchIsEmpty(updated.unreviewedEdits) &&
                updated.path === updated.originPath
            ) {
                delete next[updated.identityKey];
            } else {
                next[updated.identityKey] = updated;
            }
        } else {
            const tracked = createTrackedFileFromDiff(diff, timestamp);
            // Track if there are text changes, or if this is a move (path changed)
            if (
                !patchIsEmpty(tracked.unreviewedEdits) ||
                tracked.path !== tracked.originPath
            ) {
                next[tracked.identityKey] = tracked;
            }
        }
    }

    return next;
}

// ---------------------------------------------------------------------------
// applyNonConflictingEdits — the core algorithm from Zed
// ---------------------------------------------------------------------------

/**
 * When the user edits a file that has pending agent changes, absorb user
 * edits into diffBase while preserving only the agent hunks the user has not
 * touched.
 *
 * - Untouched agent hunks stay pending review
 * - Any agent hunk touched by the user is retired from agent attribution
 *
 * Returns updated TrackedFile (immutable).
 */
export function applyNonConflictingEdits(
    file: TrackedFile,
    userEdits: TextEdit[],
    newFullText: string,
): TrackedFile {
    const syncedFile = syncDerivedLinePatch(file);

    if (userEdits.length === 0) {
        return {
            ...syncedFile,
            currentText: newFullText,
            version: syncedFile.version + 1,
        };
    }

    if (
        syncedFile.unreviewedRanges == null ||
        syncedFile.unreviewedRanges.spans.length === 0
    ) {
        return {
            ...syncedFile,
            diffBase: newFullText,
            currentText: newFullText,
            unreviewedRanges: emptyTextRangePatch(),
            unreviewedEdits: emptyPatch(),
            version: syncedFile.version + 1,
        };
    }

    const survivingSpans = syncedFile.unreviewedRanges.spans
        .map((span) => mapAgentSpanThroughTextEdits(span, userEdits))
        .filter((span): span is AgentTextSpan => span !== null);
    const newDiffBase = rebuildDiffBaseFromPendingSpans(
        syncedFile.diffBase,
        newFullText,
        survivingSpans,
    );
    const unreviewedRanges =
        survivingSpans.length === 0
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTexts(newDiffBase, newFullText);
    const unreviewedEdits = deriveLinePatchFromTextRanges(
        newDiffBase,
        newFullText,
        unreviewedRanges.spans,
    );

    return {
        ...syncedFile,
        diffBase: newDiffBase,
        currentText: newFullText,
        unreviewedRanges,
        unreviewedEdits,
        version: syncedFile.version + 1,
    };
}

// ---------------------------------------------------------------------------
// Lifecycle-aware restore action
// ---------------------------------------------------------------------------

export type RestoreAction =
    | { kind: "delete" }
    | { kind: "write"; content: string; previousPath?: string };

/**
 * Compute the disk restore action needed to reject a tracked file,
 * based on its lifecycle status.
 */
export function computeRestoreAction(file: TrackedFile): RestoreAction {
    switch (file.status.kind) {
        case "created":
            if (file.status.existingFileContent === null) {
                // Agent created the file from nothing — delete it
                return { kind: "delete" };
            }
            // Agent overwrote an existing file — restore previous content
            return { kind: "write", content: file.status.existingFileContent };
        case "modified":
            // Revert to diffBase; undo rename if path changed
            return {
                kind: "write",
                content: file.diffBase,
                previousPath:
                    file.originPath !== file.path ? file.path : undefined,
            };
        case "deleted":
            // Agent deleted the file — restore from diffBase
            return { kind: "write", content: file.diffBase };
    }
}

// ---------------------------------------------------------------------------
// Accept / Reject operations
// ---------------------------------------------------------------------------

/**
 * Accept all agent edits for a file — clears unreviewed state.
 * The file is removed from tracking (caller should delete from map).
 */
export function keepAllEdits(file: TrackedFile): TrackedFile {
    const syncedFile = syncDerivedLinePatch(file);
    return {
        ...syncedFile,
        diffBase: syncedFile.currentText,
        unreviewedRanges: emptyTextRangePatch(),
        unreviewedEdits: emptyPatch(),
        version: syncedFile.version + 1,
    };
}

/**
 * Accept agent edits in a specific line range (in the *new* text space).
 * Edits inside the range are absorbed into diffBase; others stay.
 */
export function keepEditsInRange(
    file: TrackedFile,
    startLine: number,
    endLine: number,
): TrackedFile {
    const syncedFile = syncDerivedLinePatch(file);
    const currentSpans = syncedFile.unreviewedRanges?.spans ?? [];
    const remainingSpans = currentSpans.filter(
        (span) =>
            !spanMatchesLineRange(
                syncedFile.diffBase,
                syncedFile.currentText,
                span,
                startLine,
                endLine,
            ),
    );
    const newDiffBase = rebuildDiffBaseFromPendingSpans(
        syncedFile.diffBase,
        syncedFile.currentText,
        remainingSpans,
    );
    const unreviewedRanges =
        remainingSpans.length === 0
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTexts(newDiffBase, syncedFile.currentText);
    const unreviewedEdits = deriveLinePatchFromTextRanges(
        newDiffBase,
        syncedFile.currentText,
        unreviewedRanges.spans,
    );

    return {
        ...syncedFile,
        diffBase: newDiffBase,
        unreviewedRanges,
        unreviewedEdits,
        version: syncedFile.version + 1,
    };
}

/**
 * Reject all agent edits — revert file to diffBase.
 * Returns updated file + undo data.
 */
export function rejectAllEdits(file: TrackedFile): {
    file: TrackedFile;
    undoData: PerFileUndo;
} {
    const syncedFile = syncDerivedLinePatch(file);
    const currentLines = syncedFile.currentText.split("\n");

    const editsToRestore = syncedFile.unreviewedEdits.edits.map((edit) => ({
        startLine: edit.newStart,
        endLine: edit.newEnd,
        text: currentLines.slice(edit.newStart, edit.newEnd).join("\n"),
    }));

    const undoData: PerFileUndo = {
        path: syncedFile.path,
        editsToRestore,
        previousStatus: syncedFile.status,
    };

    const revertedFile: TrackedFile = {
        ...syncedFile,
        currentText: syncedFile.diffBase,
        unreviewedRanges: emptyTextRangePatch(),
        unreviewedEdits: emptyPatch(),
        version: syncedFile.version + 1,
    };

    return { file: revertedFile, undoData };
}

/**
 * Reject agent edits in specific line ranges (in *new* text space).
 * Reverts only overlapping edits to diffBase; keeps the rest.
 */
export function rejectEditsInRanges(
    file: TrackedFile,
    ranges: Array<{ start: number; end: number }>,
): { file: TrackedFile; undoData: PerFileUndo } {
    const syncedFile = syncDerivedLinePatch(file);
    const currentLines = syncedFile.currentText.split("\n");
    const currentSpans = syncedFile.unreviewedRanges?.spans ?? [];
    const rejectedSpans = currentSpans.filter((span) =>
        ranges.some((range) =>
            spanMatchesLineRange(
                syncedFile.diffBase,
                syncedFile.currentText,
                span,
                range.start,
                range.end,
            ),
        ),
    );
    const remainingSpans = currentSpans.filter(
        (span) => !rejectedSpans.includes(span),
    );

    const editsToRestore: PerFileUndo["editsToRestore"] = [];
    for (const span of rejectedSpans) {
        const edit = getLineEditForSpan(
            syncedFile.diffBase,
            syncedFile.currentText,
            span,
        );
        if (!edit) continue;

        editsToRestore.push({
            startLine: edit.newStart,
            endLine: edit.newEnd,
            text: currentLines.slice(edit.newStart, edit.newEnd).join("\n"),
        });
    }

    const newCurrentText = rebuildDiffBaseFromPendingSpans(
        syncedFile.diffBase,
        syncedFile.currentText,
        rejectedSpans,
    );
    const unreviewedRanges =
        remainingSpans.length === 0
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTexts(syncedFile.diffBase, newCurrentText);
    const unreviewedEdits = deriveLinePatchFromTextRanges(
        syncedFile.diffBase,
        newCurrentText,
        unreviewedRanges.spans,
    );

    const undoData: PerFileUndo = {
        path: syncedFile.path,
        editsToRestore,
        previousStatus: syncedFile.status,
    };

    return {
        file: {
            ...syncedFile,
            currentText: newCurrentText,
            unreviewedRanges,
            unreviewedEdits,
            version: syncedFile.version + 1,
        },
        undoData,
    };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Restore agent edits that were previously rejected.
 * Applies the stored text back into the file.
 */
export function applyRejectUndo(
    file: TrackedFile,
    undo: PerFileUndo,
): TrackedFile {
    const syncedFile = syncDerivedLinePatch(file);
    const lines = syncedFile.currentText.split("\n");
    let delta = 0;

    for (const entry of undo.editsToRestore) {
        const restoreLines = entry.text.split("\n");
        const spliceStart = entry.startLine + delta;
        // When the edit was rejected, the agent lines were replaced with
        // base lines. We need to figure out how many lines are currently
        // there. Since we don't store the old base line count, we use the
        // fact that restoring should put us back to the agent's state.
        // The safest approach: just splice at the position and insert.
        // But we need to know how many lines to remove.
        // Find the corresponding old range from unreviewedEdits
        const matchingEdit = syncedFile.unreviewedEdits.edits.find(
            (e) => e.newStart === entry.startLine + delta,
        );
        const deleteCount = matchingEdit
            ? matchingEdit.newEnd - matchingEdit.newStart
            : restoreLines.length;

        lines.splice(spliceStart, deleteCount, ...restoreLines);
        delta += restoreLines.length - deleteCount;
    }

    const newCurrentText = lines.join("\n");
    const unreviewedEdits =
        syncedFile.diffBase === newCurrentText
            ? emptyPatch()
            : buildPatchFromTexts(syncedFile.diffBase, newCurrentText);
    const unreviewedRanges = buildTextRangePatchFromLinePatch(
        syncedFile.diffBase,
        newCurrentText,
        unreviewedEdits,
    );

    return {
        ...syncedFile,
        currentText: newCurrentText,
        unreviewedRanges,
        unreviewedEdits,
        status: undo.previousStatus,
        version: syncedFile.version + 1,
    };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashTextContent(
    text: string | null | undefined,
): string | null {
    if (text == null) return null;
    const bytes = new TextEncoder().encode(text);
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
}

/** Derive the display operation from a TrackedFile's status and paths. */
export function getFileOperation(
    file: TrackedFile,
): "add" | "delete" | "move" | "update" {
    if (file.status.kind === "created") return "add";
    if (file.status.kind === "deleted") return "delete";
    if (file.originPath !== file.path) return "move";
    return "update";
}

/**
 * Convert a TrackedFile's unreviewedEdits into AIFileDiffHunk[] so that
 * the diff display can use the exact hunk path (buildExactHunkData)
 * instead of recomputing LCS. This bypasses the 700-line limit.
 */
export function unreviewedEditsToHunks(file: TrackedFile): AIFileDiffHunk[] {
    const syncedFile = syncDerivedLinePatch(file);
    if (patchIsEmpty(syncedFile.unreviewedEdits)) return [];

    const baseLines = syncedFile.diffBase.split("\n");
    const currentLines = syncedFile.currentText.split("\n");

    return syncedFile.unreviewedEdits.edits.map((edit) => {
        const lines: AIFileDiffHunkLine[] = [];

        for (let i = edit.oldStart; i < edit.oldEnd; i++) {
            lines.push({ type: "remove", text: baseLines[i] ?? "" });
        }
        for (let i = edit.newStart; i < edit.newEnd; i++) {
            lines.push({ type: "add", text: currentLines[i] ?? "" });
        }

        return {
            old_start: edit.oldStart + 1, // 0-based → 1-based
            old_count: edit.oldEnd - edit.oldStart,
            new_start: edit.newStart + 1,
            new_count: edit.newEnd - edit.newStart,
            lines,
        };
    });
}

// ---------------------------------------------------------------------------
// ActionLogState helpers
// ---------------------------------------------------------------------------

export function emptyActionLogState(): ActionLogState {
    return {
        trackedFilesByWorkCycleId: {},
        lastRejectUndo: null,
    };
}

export function getTrackedFilesForWorkCycle(
    state: ActionLogState,
    workCycleId: string | null | undefined,
): Record<string, TrackedFile> {
    if (!workCycleId) return {};
    const files = state.trackedFilesByWorkCycleId[workCycleId] ?? {};
    return syncTrackedFiles(files);
}

export function setTrackedFilesForWorkCycle(
    state: ActionLogState,
    workCycleId: string,
    files: Record<string, TrackedFile>,
): ActionLogState {
    const next = { ...state.trackedFilesByWorkCycleId };
    if (Object.keys(files).length === 0) {
        delete next[workCycleId];
    } else {
        next[workCycleId] = syncTrackedFiles(files);
    }
    return { ...state, trackedFilesByWorkCycleId: next };
}
