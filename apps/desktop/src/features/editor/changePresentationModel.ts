import type {
    LineEdit,
    ReviewState,
    TrackedFile,
} from "../ai/diff/actionLogTypes";
import {
    getTrackedFileReviewState,
    syncDerivedLinePatch,
} from "../ai/store/actionLogModel";

export type ChangePresentationLevel =
    | "small"
    | "medium"
    | "large"
    | "very-large";

export type ChangeRailMarkerKind = "add" | "modify" | "delete";

export interface ChangeRailMarker {
    key: string;
    editIndex: number;
    newStart: number;
    newEnd: number;
    oldStart: number;
    oldEnd: number;
    kind: ChangeRailMarkerKind;
    reviewState: ReviewState;
    topRatio: number;
    heightRatio: number;
}

export interface FileChangePresentation {
    level: ChangePresentationLevel;
    reviewState: ReviewState;
    hunkCount: number;
    totalChangedLines: number;
    largestHunkLines: number;
    additions: number;
    deletions: number;
    preferReview: boolean;
    showInlineActions: boolean;
    showWordDiff: boolean;
    collapseLargeDeletes: boolean;
    reducedInlineMode: boolean;
    railMarkers: ChangeRailMarker[];
    collapsedDeleteBlockIndexes: number[];
}

const SMALL_MAX_LINES = 3;
const SMALL_MAX_VISIBLE_CHARS = 120;
const MEDIUM_MAX_HUNKS = 8;
const MEDIUM_MAX_LINES = 40;
const MEDIUM_MAX_HUNK_LINES = 12;
export const LARGE_DELETE_COLLAPSE_LINES = 8;
const VERY_LARGE_MAX_HUNKS = 20;
const VERY_LARGE_MAX_LINES = 200;

export function deriveFileChangePresentation(
    trackedFile: TrackedFile,
): FileChangePresentation {
    const syncedFile = syncDerivedLinePatch(trackedFile);
    const edits = syncedFile.unreviewedEdits.edits;
    const reviewState = getTrackedFileReviewState(syncedFile);
    const currentLines = splitLinesForDisplay(syncedFile.currentText);
    const baseLines = splitLinesForDisplay(syncedFile.diffBase);
    const totalLines = Math.max(currentLines.length, 1);

    let additions = 0;
    let deletions = 0;
    let totalChangedLines = 0;
    let largestHunkLines = 0;
    let largestDeleteBlockLines = 0;
    let visibleChars = 0;

    const railMarkers = edits.map((edit, index) => {
        const oldLineCount = Math.max(edit.oldEnd - edit.oldStart, 0);
        const newLineCount = Math.max(edit.newEnd - edit.newStart, 0);
        const changedLineCount = getChangedLineCount(edit);

        additions += newLineCount;
        deletions += oldLineCount;
        totalChangedLines += changedLineCount;
        largestHunkLines = Math.max(largestHunkLines, changedLineCount);
        if (newLineCount === 0) {
            largestDeleteBlockLines = Math.max(
                largestDeleteBlockLines,
                oldLineCount,
            );
        }
        visibleChars += getVisibleCharCount(edit, baseLines, currentLines);

        return buildRailMarker(edit, index, totalLines, reviewState);
    });

    const level = classifyPresentationLevel({
        hunkCount: edits.length,
        totalChangedLines,
        largestHunkLines,
        largestDeleteBlockLines,
        visibleChars,
    });
    const collapseLargeDeletes =
        level === "large" || level === "very-large";
    const collapsedDeleteBlockIndexes = collapseLargeDeletes
        ? edits.flatMap((edit, index) =>
              edit.newStart === edit.newEnd &&
              edit.oldEnd - edit.oldStart > LARGE_DELETE_COLLAPSE_LINES
                  ? index
                  : [],
          )
        : [];

    return {
        level,
        reviewState,
        hunkCount: edits.length,
        totalChangedLines,
        largestHunkLines,
        additions,
        deletions,
        preferReview: level === "large" || level === "very-large",
        showInlineActions:
            reviewState === "finalized" &&
            (level === "small" || level === "medium"),
        showWordDiff: level === "small" || level === "medium",
        collapseLargeDeletes,
        reducedInlineMode: level === "large" || level === "very-large",
        railMarkers,
        collapsedDeleteBlockIndexes,
    };
}

function classifyPresentationLevel(metrics: {
    hunkCount: number;
    totalChangedLines: number;
    largestHunkLines: number;
    largestDeleteBlockLines: number;
    visibleChars: number;
}): ChangePresentationLevel {
    if (
        metrics.hunkCount > VERY_LARGE_MAX_HUNKS ||
        metrics.totalChangedLines > VERY_LARGE_MAX_LINES
    ) {
        return "very-large";
    }

    if (
        metrics.hunkCount > MEDIUM_MAX_HUNKS ||
        metrics.totalChangedLines > MEDIUM_MAX_LINES ||
        metrics.largestHunkLines > MEDIUM_MAX_HUNK_LINES ||
        metrics.largestDeleteBlockLines > LARGE_DELETE_COLLAPSE_LINES
    ) {
        return "large";
    }

    if (
        metrics.hunkCount === 1 &&
        metrics.totalChangedLines <= SMALL_MAX_LINES &&
        metrics.visibleChars <= SMALL_MAX_VISIBLE_CHARS
    ) {
        return "small";
    }

    return "medium";
}

function buildRailMarker(
    edit: LineEdit,
    index: number,
    totalLines: number,
    reviewState: ReviewState,
): ChangeRailMarker {
    const kind = getMarkerKind(edit);
    const lineSpan = Math.max(getChangedLineCount(edit), 1);
    const anchorLine =
        totalLines <= 1
            ? 0
            : clamp(edit.newStart, 0, Math.max(totalLines - 1, 0));
    const minHeightRatio = 1 / totalLines;
    const unclampedHeightRatio = lineSpan / totalLines;
    const heightRatio = clamp(unclampedHeightRatio, minHeightRatio, 1);
    const rawTopRatio = totalLines <= 1 ? 0 : anchorLine / totalLines;
    const maxTopRatio = Math.max(0, 1 - heightRatio);
    const topRatio = clamp(rawTopRatio, 0, maxTopRatio);

    return {
        key: getChangeRailMarkerKey(edit, index),
        editIndex: index,
        newStart: edit.newStart,
        newEnd: edit.newEnd,
        oldStart: edit.oldStart,
        oldEnd: edit.oldEnd,
        kind,
        reviewState,
        topRatio,
        heightRatio,
    };
}

function getMarkerKind(edit: LineEdit): ChangeRailMarkerKind {
    if (edit.oldStart === edit.oldEnd) return "add";
    if (edit.newStart === edit.newEnd) return "delete";
    return "modify";
}

export function getChangeRailMarkerKey(edit: LineEdit, index: number) {
    const kind = getMarkerKind(edit);
    return `edit-${index}-${kind}-${edit.newStart}-${edit.newEnd}-${edit.oldStart}-${edit.oldEnd}`;
}

function getChangedLineCount(edit: LineEdit) {
    const oldLineCount = Math.max(edit.oldEnd - edit.oldStart, 0);
    const newLineCount = Math.max(edit.newEnd - edit.newStart, 0);
    return Math.max(oldLineCount, newLineCount, 1);
}

function getVisibleCharCount(
    edit: LineEdit,
    baseLines: string[],
    currentLines: string[],
) {
    const baseSegment = baseLines.slice(edit.oldStart, edit.oldEnd).join("\n");
    const currentSegment = currentLines
        .slice(edit.newStart, edit.newEnd)
        .join("\n");

    return Math.max(baseSegment.length, currentSegment.length);
}

function splitLinesForDisplay(text: string) {
    return text.length === 0 ? [""] : text.split("\n");
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

export function buildFileChangePresentation(
    trackedFile: TrackedFile | null | undefined,
) {
    return trackedFile ? deriveFileChangePresentation(trackedFile) : null;
}
