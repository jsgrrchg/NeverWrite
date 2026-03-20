import type { TrackedFile } from "./actionLogTypes";
import {
    computeDecisionHunks,
    computeDiffLines,
    computeDiffStats,
    createDiffFromTrackedFile,
    getFileNameFromPath,
    type DiffLine,
} from "./reviewDiff";
import type { AIFileDiff } from "../types";
import {
    getFileOperation,
    getTrackedFileReviewState,
} from "../store/actionLogModel";

export interface ReviewFileItem {
    file: TrackedFile;
    diff: AIFileDiff;
    lines: DiffLine[];
    stats: { additions: number; deletions: number; approximate: boolean };
    tone: { accent: string; badge: string | null };
    summary: string;
    canOpen: boolean;
    canReject: boolean;
    canResolveHunks: boolean;
}

export interface ReviewSummary {
    fileCount: number;
    additions: number;
    deletions: number;
    approximate: boolean;
    conflictCount: number;
    partialCount: number;
}

export function getFileTone(file: TrackedFile) {
    if (file.conflictHash != null) {
        return { accent: "var(--diff-warn)", badge: "Conflict" };
    }
    if (!file.isText) {
        return { accent: "var(--diff-warn)", badge: "Partial" };
    }
    const op = getFileOperation(file);
    if (op === "move") {
        return { accent: "var(--diff-move)", badge: null };
    }
    switch (op) {
        case "add":
            return { accent: "var(--diff-add)", badge: null };
        case "delete":
            return { accent: "var(--diff-remove)", badge: null };
        default:
            return { accent: "var(--diff-update)", badge: null };
    }
}

export function getFileSummary(file: TrackedFile) {
    const op = getFileOperation(file);
    if (op === "move") {
        return `Moved from ${getFileNameFromPath(file.originPath)}`;
    }
    switch (op) {
        case "add":
            return "New file";
        case "delete":
            return "Deleted";
        default:
            return "Modified";
    }
}

export function canResolveFileHunks(file: TrackedFile, diff?: AIFileDiff) {
    const candidateDiff = diff ?? createDiffFromTrackedFile(file);
    const op = getFileOperation(file);
    return (
        file.isText &&
        file.conflictHash == null &&
        getTrackedFileReviewState(file) === "finalized" &&
        op !== "add" &&
        op !== "delete" &&
        computeDecisionHunks(candidateDiff).length > 0
    );
}

export function deriveReviewItems(
    files: TrackedFile[],
    canOpenByPath: Set<string>,
): ReviewFileItem[] {
    return files
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((file) => {
            const diff = createDiffFromTrackedFile(file);
            const canResolveHunks = canResolveFileHunks(file, diff);
            const stats = computeDiffStats([diff]);
            return {
                file,
                diff,
                lines: computeDiffLines(diff),
                stats: {
                    additions: stats.additions,
                    deletions: stats.deletions,
                    approximate: stats.approximate === true,
                },
                tone: getFileTone(file),
                summary: getFileSummary(file),
                canOpen: canOpenByPath.has(file.path),
                canReject:
                    file.isText &&
                    file.conflictHash == null &&
                    getTrackedFileReviewState(file) === "finalized",
                canResolveHunks,
            };
        });
}

export function deriveReviewSummary(items: ReviewFileItem[]): ReviewSummary {
    const diffs = items.map((item) => item.diff);
    const stats = computeDiffStats(diffs);
    return {
        fileCount: items.length,
        additions: stats.additions,
        deletions: stats.deletions,
        approximate: stats.approximate === true,
        conflictCount: items.filter((item) => item.file.conflictHash != null)
            .length,
        partialCount: items.filter((item) => !item.file.isText).length,
    };
}
