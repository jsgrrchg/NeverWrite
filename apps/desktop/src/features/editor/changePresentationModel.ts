import type { Text } from "@codemirror/state";
import type { Chunk } from "@codemirror/merge";
import type {
    LineEdit,
    ReviewState,
    TrackedFile,
} from "../ai/diff/actionLogTypes";
import {
    getTrackedFileReviewState,
    syncDerivedLinePatch,
} from "../ai/store/actionLogModel";
import {
    getChunkKind,
    getChunkLineRangeInDocB,
    getChunkMarkerKey,
} from "./mergeChunkRange";

export type ChangePresentationLevel =
    | "small"
    | "medium"
    | "large"
    | "very-large";

export type ChangeRailMarkerKind = "add" | "modify" | "delete";

export interface ChangeRailMarker {
    key: string;
    startLine: number;
    endLine: number;
    anchorLine: number;
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
    collapsedDeleteBlockIndexes: number[];
}

const SMALL_MAX_LINES = 3;
const SMALL_MAX_VISIBLE_CHARS = 120;
export const MEDIUM_MAX_HUNKS = 8;
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
    let additions = 0;
    let deletions = 0;
    let totalChangedLines = 0;
    let largestHunkLines = 0;
    let largestDeleteBlockLines = 0;
    let visibleChars = 0;

    edits.forEach((edit) => {
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
    });

    const level = classifyPresentationLevel({
        hunkCount: edits.length,
        totalChangedLines,
        largestHunkLines,
        largestDeleteBlockLines,
        visibleChars,
    });
    const collapseLargeDeletes = level === "large" || level === "very-large";
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
        collapsedDeleteBlockIndexes,
    };
}

export function deriveMarkersFromChunks(
    chunks: readonly Chunk[],
    docB: Text,
    reviewState: ReviewState,
): ChangeRailMarker[] {
    const totalLines = Math.max(docB.lines, 1);

    return chunks.map((chunk, index) => {
        const range = getChunkLineRangeInDocB(chunk, docB);
        const lineSpan = Math.max(range.endLine - range.startLine, 1);
        const minHeightRatio = 1 / totalLines;
        const heightRatio = clamp(lineSpan / totalLines, minHeightRatio, 1);
        const rawTopRatio = totalLines <= 1 ? 0 : range.anchorLine / totalLines;
        const maxTopRatio = Math.max(0, 1 - heightRatio);

        return {
            key: getChunkMarkerKey(chunk, index),
            startLine: range.startLine,
            endLine: range.endLine,
            anchorLine: range.anchorLine,
            kind: getChunkKind(chunk),
            reviewState,
            topRatio: clamp(rawTopRatio, 0, maxTopRatio),
            heightRatio,
        };
    });
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
