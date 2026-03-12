import {
    computeDecisionHunks,
    computeDiffLines,
    computeDiffStats,
    createDiffFromEditedFileEntry,
    getFileNameFromPath,
    type DiffLine,
} from "../diff/reviewDiff";
import type { AIEditedFileBufferEntry, AIFileDiff } from "../types";

export interface ReviewFileItem {
    entry: AIEditedFileBufferEntry;
    diff: AIFileDiff;
    lines: DiffLine[];
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

export function getEntryTone(entry: AIEditedFileBufferEntry) {
    if (entry.status === "conflict") {
        return { accent: "var(--diff-warn)", badge: "Conflict" };
    }
    if (!entry.supported) {
        return { accent: "var(--diff-warn)", badge: "Partial" };
    }
    if (entry.originPath !== entry.path || entry.operation === "move") {
        return { accent: "var(--diff-move)", badge: null };
    }
    switch (entry.operation) {
        case "add":
            return { accent: "var(--diff-add)", badge: null };
        case "delete":
            return { accent: "var(--diff-remove)", badge: null };
        default:
            return { accent: "var(--diff-update)", badge: null };
    }
}

export function getEntrySummary(entry: AIEditedFileBufferEntry) {
    if (entry.originPath !== entry.path || entry.operation === "move") {
        return `Moved from ${getFileNameFromPath(entry.originPath)}`;
    }
    switch (entry.operation) {
        case "add":
            return "New file";
        case "delete":
            return "Deleted";
        default:
            return "Modified";
    }
}

export function canResolveEntryHunks(
    entry: AIEditedFileBufferEntry,
    diff?: AIFileDiff,
) {
    const candidateDiff = diff ?? createDiffFromEditedFileEntry(entry);
    return (
        entry.supported &&
        entry.status !== "conflict" &&
        entry.baseText != null &&
        entry.appliedText != null &&
        entry.operation !== "add" &&
        entry.operation !== "delete" &&
        computeDecisionHunks(candidateDiff).length > 0
    );
}

export function deriveReviewItems(
    entries: AIEditedFileBufferEntry[],
    canOpenByPath: Set<string>,
): ReviewFileItem[] {
    return entries
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((entry) => {
            const diff = createDiffFromEditedFileEntry(entry);
            const canResolveHunks = canResolveEntryHunks(entry, diff);
            return {
                entry,
                diff,
                lines: computeDiffLines(diff),
                tone: getEntryTone(entry),
                summary: getEntrySummary(entry),
                canOpen: canOpenByPath.has(entry.path),
                canReject: entry.supported && entry.status !== "conflict",
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
        conflictCount: items.filter((item) => item.entry.status === "conflict")
            .length,
        partialCount: items.filter((item) => !item.entry.supported).length,
    };
}
