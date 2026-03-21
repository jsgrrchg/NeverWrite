/**
 * ActionLog model — Pure functions for patch-based change tracking.
 *
 * Follows the same pattern as editedFilesBufferModel.ts: no store imports,
 * all functions are pure and testable in isolation.
 */

import type {
    ActionLogState,
    AgentTextSpan,
    HunkWordDiffs,
    LineEdit,
    LinePatch,
    PerFileUndo,
    ReviewState,
    TextEdit,
    TextRangePatch,
    TrackedFile,
    TrackedFileStatus,
} from "../diff/actionLogTypes";
import type { AIFileDiff, AIFileDiffHunk, AIFileDiffHunkLine } from "../types";
import {
    applyNonConflictingEditsRust,
    applyRejectUndoRust,
    buildPatchFromTextsRust,
    buildTextRangePatchFromTextsRust,
    computeWordDiffsForHunkRust,
    deriveLinePatchFromTextRangesRust,
    keepEditsInRangeRust,
    mapAgentSpanThroughTextEditsRust,
    mapTextPositionThroughEditsRust,
    partitionSpansByOverlapRust,
    rebuildDiffBaseFromPendingSpansRust,
    rejectAllEditsRust,
    rejectEditsInRangesRust,
    syncDerivedLinePatchRust,
} from "./actionLogRustEngine";
import {
    keepEditsInRangeFallback,
    rejectEditsInRangesFallback,
} from "./actionLogJsFallback";

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

export interface PrecomputedTrackedFilePatches {
    linePatch: LinePatch;
    textRangePatch?: TextRangePatch;
}

const syncedTrackedFileCache = new WeakMap<TrackedFile, TrackedFile>();
const syncedTrackedFilesCache = new WeakMap<
    Record<string, TrackedFile>,
    Record<string, TrackedFile>
>();
const syncedSessionTrackedFilesCache = new WeakMap<
    ActionLogState,
    Record<string, TrackedFile>
>();

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

function resolveTrackedFilePatches(
    diffBase: string,
    currentText: string,
    precomputed?: PrecomputedTrackedFilePatches,
): { unreviewedEdits: LinePatch; unreviewedRanges: TextRangePatch } {
    if (diffBase === currentText) {
        return {
            unreviewedEdits: emptyPatch(),
            unreviewedRanges: emptyTextRangePatch(),
        };
    }

    const unreviewedEdits =
        precomputed?.linePatch ?? buildPatchFromTexts(diffBase, currentText);
    const unreviewedRanges =
        precomputed?.textRangePatch ??
        buildTextRangePatchFromTexts(diffBase, currentText, unreviewedEdits);

    return {
        unreviewedEdits,
        unreviewedRanges,
    };
}

export function mapTextPositionThroughEdits(
    position: number,
    edits: TextEdit[],
    assoc: -1 | 1,
): number {
    return mapTextPositionThroughEditsRust(position, edits, assoc);
}

export function mapAgentSpanThroughTextEdits(
    span: AgentTextSpan,
    edits: TextEdit[],
): AgentTextSpan | null {
    return mapAgentSpanThroughTextEditsRust(span, edits);
}

export function rebuildDiffBaseFromPendingSpans(
    originalDiffBase: string,
    currentText: string,
    spans: AgentTextSpan[],
): string {
    return rebuildDiffBaseFromPendingSpansRust(
        originalDiffBase,
        currentText,
        spans,
    );
}

export function partitionSpansByOverlap(
    spans: AgentTextSpan[],
    ranges: Array<{ start: number; end: number }>,
    baseText: string,
    currentText: string,
): {
    overlapping: AgentTextSpan[];
    nonOverlapping: AgentTextSpan[];
} {
    return partitionSpansByOverlapRust(spans, ranges, baseText, currentText);
}

/** Build a line patch through the shared Rust diff engine. */
export function buildPatchFromTexts(
    oldText: string,
    newText: string,
): LinePatch {
    return buildPatchFromTextsRust(oldText, newText);
}

export function buildTextRangePatchFromTexts(
    oldText: string,
    newText: string,
    linePatch?: LinePatch,
): TextRangePatch {
    return buildTextRangePatchFromTextsRust(oldText, newText, linePatch);
}

export function computeWordDiffsForHunk(
    baseText: string,
    currentText: string,
    edit: LineEdit,
    options: {
        maxLines?: number;
        maxChars?: number;
    } = {},
): HunkWordDiffs | null {
    return computeWordDiffsForHunkRust(baseText, currentText, edit, options);
}

export function deriveLinePatchFromTextRanges(
    baseText: string,
    currentText: string,
    spans: AgentTextSpan[],
): LinePatch {
    return deriveLinePatchFromTextRangesRust(baseText, currentText, spans);
}

export function syncDerivedLinePatch(file: TrackedFile): TrackedFile {
    const cached = syncedTrackedFileCache.get(file);
    if (cached) {
        return cached;
    }

    const synced = syncDerivedLinePatchRust(file);
    const result =
        file.unreviewedRanges &&
        synced.unreviewedRanges &&
        spansEqual(
            file.unreviewedRanges.spans,
            synced.unreviewedRanges.spans,
        ) &&
        linePatchesEqual(file.unreviewedEdits, synced.unreviewedEdits)
            ? file
            : synced;

    syncedTrackedFileCache.set(file, result);
    return result;
}

function syncTrackedFiles(
    files: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
    const cached = syncedTrackedFilesCache.get(files);
    if (cached) {
        return cached;
    }

    let changed = false;
    const next: Record<string, TrackedFile> = {};

    for (const [key, file] of Object.entries(files)) {
        const synced = syncDerivedLinePatch(file);
        next[key] = synced;
        if (synced !== file) {
            changed = true;
        }
    }

    const result = changed ? next : files;
    syncedTrackedFilesCache.set(files, result);
    return result;
}

export function getTrackedFileReviewState(file: TrackedFile): ReviewState {
    return file.reviewState ?? "finalized";
}

export function finalizeTrackedFile(file: TrackedFile): TrackedFile {
    if (getTrackedFileReviewState(file) === "finalized") {
        return file;
    }

    return {
        ...file,
        reviewState: "finalized",
        version: file.version + 1,
    };
}

export function finalizeTrackedFiles(
    files: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
    let changed = false;
    const next: Record<string, TrackedFile> = {};

    for (const [key, file] of Object.entries(files)) {
        const finalized = finalizeTrackedFile(file);
        next[key] = finalized;
        if (finalized !== file) {
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
    precomputed?: PrecomputedTrackedFilePatches,
): TrackedFile {
    const oldText = diff.old_text ?? "";
    const newText = diff.new_text ?? "";
    const status = statusFromDiffKind(diff.kind);

    // For "add", diffBase is empty (file didn't exist).
    // For "delete", currentText is empty (file will be removed).
    const diffBase = diff.kind === "add" ? "" : oldText;
    const currentText = diff.kind === "delete" ? "" : newText;

    const { unreviewedEdits, unreviewedRanges } = resolveTrackedFilePatches(
        diffBase,
        currentText,
        precomputed,
    );

    return {
        identityKey: diff.path,
        originPath: diff.previous_path ?? diff.path,
        path: diff.path,
        previousPath: diff.previous_path ?? null,
        status,
        reviewState: "pending",
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
    precomputed?: PrecomputedTrackedFilePatches,
): TrackedFile {
    const newText = diff.new_text ?? "";
    const currentText = diff.kind === "delete" ? "" : newText;

    // diffBase stays the same (always the pre-agent state)
    const { unreviewedEdits, unreviewedRanges } = resolveTrackedFilePatches(
        file.diffBase,
        currentText,
        precomputed,
    );

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
        reviewState: "pending",
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
    precomputedPatches?: Array<PrecomputedTrackedFilePatches | undefined>,
): Record<string, TrackedFile> {
    const next = { ...files };

    for (const [index, diff] of diffs.entries()) {
        if (diff.is_text === false || diff.reversible === false) {
            continue; // Skip unsupported files
        }

        const precomputed = precomputedPatches?.[index];
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
                precomputed,
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
            const tracked = createTrackedFileFromDiff(
                diff,
                timestamp,
                precomputed,
            );
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
    return applyNonConflictingEditsRust(file, userEdits, newFullText);
}

// ---------------------------------------------------------------------------
// Lifecycle-aware restore action
// ---------------------------------------------------------------------------

export type RestoreAction =
    | { kind: "delete" }
    | { kind: "write"; content: string; previousPath?: string }
    | { kind: "skip"; reason: "user_owns_content" };

/**
 * Compute the disk restore action needed to reject a tracked file,
 * based on its lifecycle status.
 */
export function computeRestoreAction(
    file: TrackedFile,
    liveText?: string | null,
): RestoreAction {
    switch (file.status.kind) {
        case "created":
            if (file.status.existingFileContent === null) {
                // Agent created the file from nothing — delete it only if the
                // live content still matches the agent-authored snapshot.
                if (
                    liveText === null ||
                    (typeof liveText === "string" &&
                        liveText !== file.currentText)
                ) {
                    return {
                        kind: "skip",
                        reason: "user_owns_content",
                    };
                }
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
    // Temporary safety valve for inline merge hunks that resolve to a point
    // range in the editor. The JS path matches those cases reliably in the
    // app runtime while we keep the Rust/WASM path for the general case.
    if (startLine === endLine) {
        console.debug("[merge-inline] forcing JS fallback for point keep", {
            identityKey: file.identityKey,
            startLine,
            endLine,
        });
        return keepEditsInRangeFallback(file, startLine, endLine);
    }

    return keepEditsInRangeRust(file, startLine, endLine);
}

/**
 * Reject all agent edits — revert file to diffBase.
 * Returns updated file + undo data.
 */
export function rejectAllEdits(file: TrackedFile): {
    file: TrackedFile;
    undoData: PerFileUndo;
} {
    return rejectAllEditsRust(file);
}

/**
 * Reject agent edits in specific line ranges (in *new* text space).
 * Reverts only overlapping edits to diffBase; keeps the rest.
 */
export function rejectEditsInRanges(
    file: TrackedFile,
    ranges: Array<{ start: number; end: number }>,
): { file: TrackedFile; undoData: PerFileUndo } {
    // Temporary safety valve for inline merge hunks that resolve to point
    // ranges. Keep the fallback narrowly scoped so the normal Rust/WASM path
    // remains the default for non-point hunk resolution.
    if (ranges.every((range) => range.start === range.end)) {
        console.debug("[merge-inline] forcing JS fallback for point reject", {
            identityKey: file.identityKey,
            ranges,
        });
        return rejectEditsInRangesFallback(file, ranges);
    }

    return rejectEditsInRangesRust(file, ranges);
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
    return applyRejectUndoRust(file, undo);
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

function shouldPreferTrackedFile(
    candidate: TrackedFile,
    current: TrackedFile,
): boolean {
    if (candidate.updatedAt !== current.updatedAt) {
        return candidate.updatedAt > current.updatedAt;
    }
    if (candidate.version !== current.version) {
        return candidate.version > current.version;
    }
    const candidatePending = getTrackedFileReviewState(candidate) === "pending";
    const currentPending = getTrackedFileReviewState(current) === "pending";
    if (candidatePending !== currentPending) {
        return candidatePending;
    }
    return candidate.path >= current.path;
}

export function getTrackedFilesForSession(
    state: ActionLogState | null | undefined,
): Record<string, TrackedFile> {
    if (!state) {
        return {};
    }

    const cached = syncedSessionTrackedFilesCache.get(state);
    if (cached) {
        return cached;
    }

    const merged: Record<string, TrackedFile> = {};
    for (const workCycleId of Object.keys(state.trackedFilesByWorkCycleId)) {
        const syncedFiles = getTrackedFilesForWorkCycle(state, workCycleId);
        for (const [identityKey, file] of Object.entries(syncedFiles)) {
            const current = merged[identityKey];
            if (!current || shouldPreferTrackedFile(file, current)) {
                merged[identityKey] = file;
            }
        }
    }

    syncedSessionTrackedFilesCache.set(state, merged);
    return merged;
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
