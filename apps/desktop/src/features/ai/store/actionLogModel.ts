/**
 * ActionLog model — Pure functions for patch-based change tracking.
 *
 * Follows the same pattern as editedFilesBufferModel.ts: no store imports,
 * all functions are pure and testable in isolation.
 */

import type {
    ActionLogState,
    LineEdit,
    LinePatch,
    PerFileUndo,
    TrackedFile,
    TrackedFileStatus,
} from "../diff/actionLogTypes";
import type {
    AIEditedFileBufferEntry,
    AIFileDiff,
    AIFileDiffHunk,
    AIFileDiffHunkLine,
} from "../types";

// ---------------------------------------------------------------------------
// Patch primitives
// ---------------------------------------------------------------------------

export function emptyPatch(): LinePatch {
    return { edits: [] };
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

    return {
        identityKey: diff.path,
        originPath: diff.previous_path ?? diff.path,
        path: diff.path,
        previousPath: diff.previous_path ?? null,
        status,
        diffBase,
        currentText,
        unreviewedEdits,
        version: 1,
        isText: diff.is_text !== false,
        updatedAt: timestamp,
    };
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
        unreviewedEdits,
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
            if (!patchIsEmpty(tracked.unreviewedEdits)) {
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
 * edits into diffBase if they don't overlap with unreviewedEdits.
 *
 * - Non-conflicting user edits → applied to diffBase (absorbed)
 * - Conflicting user edits → ignored (agent's edit stays visible)
 *
 * Returns updated TrackedFile (immutable).
 */
export function applyNonConflictingEdits(
    file: TrackedFile,
    userEdits: LineEdit[],
    newFullText: string,
): TrackedFile {
    if (userEdits.length === 0 || patchIsEmpty(file.unreviewedEdits)) {
        return {
            ...file,
            currentText: newFullText,
            version: file.version + 1,
        };
    }

    const diffBaseLines = file.diffBase.split("\n");
    let appliedDelta = 0;
    const agentEdits = [...file.unreviewedEdits.edits];

    for (const userEdit of userEdits) {
        const conflicts = agentEdits.some((agentEdit) =>
            rangesOverlap(
                userEdit.oldStart,
                userEdit.oldEnd,
                agentEdit.newStart,
                agentEdit.newEnd,
            ),
        );

        if (conflicts) {
            continue;
        }

        // Non-conflicting: absorb into diffBase
        const newLines = newFullText
            .split("\n")
            .slice(userEdit.newStart, userEdit.newEnd);
        const spliceStart = userEdit.oldStart + appliedDelta;
        const deleteCount = userEdit.oldEnd - userEdit.oldStart;
        diffBaseLines.splice(spliceStart, deleteCount, ...newLines);

        const lineDelta = userEdit.newEnd - userEdit.newStart - deleteCount;
        appliedDelta += lineDelta;
    }

    const newDiffBase = diffBaseLines.join("\n");

    // Recompute unreviewedEdits from the (possibly updated) diffBase
    const unreviewedEdits =
        newDiffBase === newFullText
            ? emptyPatch()
            : buildPatchFromTexts(newDiffBase, newFullText);

    return {
        ...file,
        diffBase: newDiffBase,
        currentText: newFullText,
        unreviewedEdits,
        version: file.version + 1,
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
    return {
        ...file,
        diffBase: file.currentText,
        unreviewedEdits: emptyPatch(),
        version: file.version + 1,
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
    const currentLines = file.currentText.split("\n");
    const diffBaseLines = file.diffBase.split("\n");
    let delta = 0;

    const remaining: LineEdit[] = [];

    for (const edit of file.unreviewedEdits.edits) {
        if (rangesOverlap(startLine, endLine, edit.newStart, edit.newEnd)) {
            // Accept: apply this edit to diffBase
            const newLines = currentLines.slice(edit.newStart, edit.newEnd);
            const spliceStart = edit.oldStart + delta;
            const deleteCount = edit.oldEnd - edit.oldStart;
            diffBaseLines.splice(spliceStart, deleteCount, ...newLines);
            delta += newLines.length - deleteCount;
        } else {
            remaining.push(edit);
        }
    }

    const newDiffBase = diffBaseLines.join("\n");
    // Recompute remaining edits from new diffBase
    const unreviewedEdits =
        remaining.length === 0
            ? emptyPatch()
            : buildPatchFromTexts(newDiffBase, file.currentText);

    return {
        ...file,
        diffBase: newDiffBase,
        unreviewedEdits,
        version: file.version + 1,
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
    const currentLines = file.currentText.split("\n");

    const editsToRestore = file.unreviewedEdits.edits.map((edit) => ({
        startLine: edit.newStart,
        endLine: edit.newEnd,
        text: currentLines.slice(edit.newStart, edit.newEnd).join("\n"),
    }));

    const undoData: PerFileUndo = {
        path: file.path,
        editsToRestore,
        previousStatus: file.status,
    };

    const revertedFile: TrackedFile = {
        ...file,
        currentText: file.diffBase,
        unreviewedEdits: emptyPatch(),
        version: file.version + 1,
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
    const currentLines = file.currentText.split("\n");
    const diffBaseLines = file.diffBase.split("\n");
    const resultLines = [...currentLines];
    let delta = 0;

    const editsToRestore: PerFileUndo["editsToRestore"] = [];

    for (const edit of file.unreviewedEdits.edits) {
        const isRejected = ranges.some((range) =>
            rangesOverlap(range.start, range.end, edit.newStart, edit.newEnd),
        );

        if (isRejected) {
            // Capture agent text for undo
            editsToRestore.push({
                startLine: edit.newStart,
                endLine: edit.newEnd,
                text: currentLines.slice(edit.newStart, edit.newEnd).join("\n"),
            });

            // Replace agent lines with diffBase lines in result
            const baseLines = diffBaseLines.slice(edit.oldStart, edit.oldEnd);
            const spliceStart = edit.newStart + delta;
            const deleteCount = edit.newEnd - edit.newStart;
            resultLines.splice(spliceStart, deleteCount, ...baseLines);
            delta += baseLines.length - deleteCount;
        }
    }

    const newCurrentText = resultLines.join("\n");
    // Recompute diff from diffBase to the new (partially reverted) text
    const unreviewedEdits =
        file.diffBase === newCurrentText
            ? emptyPatch()
            : buildPatchFromTexts(file.diffBase, newCurrentText);

    const undoData: PerFileUndo = {
        path: file.path,
        editsToRestore,
        previousStatus: file.status,
    };

    return {
        file: {
            ...file,
            currentText: newCurrentText,
            unreviewedEdits,
            version: file.version + 1,
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
    const lines = file.currentText.split("\n");
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
        const matchingEdit = file.unreviewedEdits.edits.find(
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
        file.diffBase === newCurrentText
            ? emptyPatch()
            : buildPatchFromTexts(file.diffBase, newCurrentText);

    return {
        ...file,
        currentText: newCurrentText,
        unreviewedEdits,
        status: undo.previousStatus,
        version: file.version + 1,
    };
}

// ---------------------------------------------------------------------------
// Migration: legacy AIEditedFileBufferEntry ↔ TrackedFile
// ---------------------------------------------------------------------------

export function trackedFileFromLegacyEntry(
    entry: AIEditedFileBufferEntry,
): TrackedFile {
    const diffBase = entry.baseText ?? "";
    const currentText = entry.appliedText ?? "";

    let status: TrackedFileStatus;
    switch (entry.operation) {
        case "add":
            status = { kind: "created", existingFileContent: null };
            break;
        case "delete":
            status = { kind: "deleted" };
            break;
        default:
            status = { kind: "modified" };
    }

    const unreviewedEdits =
        diffBase === currentText
            ? emptyPatch()
            : buildPatchFromTexts(diffBase, currentText);

    return {
        identityKey: entry.identityKey,
        originPath: entry.originPath,
        path: entry.path,
        previousPath: entry.previousPath ?? null,
        status,
        diffBase,
        currentText,
        unreviewedEdits,
        version: 1,
        isText: entry.isText,
        updatedAt: entry.updatedAt,
    };
}

function hashTextContent(text: string | null | undefined): string | null {
    if (text == null) return null;
    const bytes = new TextEncoder().encode(text);
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
}

function statusToOperation(
    status: TrackedFileStatus,
): AIEditedFileBufferEntry["operation"] {
    switch (status.kind) {
        case "created":
            return "add";
        case "deleted":
            return "delete";
        case "modified":
            return "update";
        default: {
            const _exhaustive: never = status.kind;
            return _exhaustive;
        }
    }
}

/**
 * Convert a TrackedFile's unreviewedEdits into AIFileDiffHunk[] so that
 * the diff display can use the exact hunk path (buildExactHunkData)
 * instead of recomputing LCS. This bypasses the 700-line limit.
 */
function unreviewedEditsToHunks(file: TrackedFile): AIFileDiffHunk[] {
    if (patchIsEmpty(file.unreviewedEdits)) return [];

    const baseLines = file.diffBase.split("\n");
    const currentLines = file.currentText.split("\n");

    return file.unreviewedEdits.edits.map((edit) => {
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

export function trackedFileToLegacyEntry(
    file: TrackedFile,
): AIEditedFileBufferEntry {
    const hunks = unreviewedEditsToHunks(file);

    return {
        identityKey: file.identityKey,
        originPath: file.originPath,
        path: file.path,
        previousPath: file.previousPath,
        operation: statusToOperation(file.status),
        baseText: file.diffBase,
        appliedText: file.currentText,
        reversible: true,
        isText: file.isText,
        supported: file.isText,
        status: "pending",
        appliedHash: hashTextContent(file.currentText),
        currentHash: null,
        additions: hunks.reduce(
            (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
            0,
        ),
        deletions: hunks.reduce(
            (sum, h) => sum + h.lines.filter((l) => l.type === "remove").length,
            0,
        ),
        ...(hunks.length > 0 ? { hunks } : {}),
        updatedAt: file.updatedAt,
    };
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
    return state.trackedFilesByWorkCycleId[workCycleId] ?? {};
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
        next[workCycleId] = files;
    }
    return { ...state, trackedFilesByWorkCycleId: next };
}

/** Convert all tracked files in a work cycle to legacy entries for the UI. */
export function trackedFilesToLegacyEntries(
    files: Record<string, TrackedFile>,
): AIEditedFileBufferEntry[] {
    return Object.values(files)
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map(trackedFileToLegacyEntry);
}
