import type { TrackedFile } from "./actionLogTypes";
import {
    getFileOperation,
    unreviewedEditsToHunks,
} from "../store/actionLogModel";
import type { AIFileDiff, AIFileDiffHunk } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffLine {
    type: "add" | "remove" | "context" | "separator";
    prefix: string;
    text: string;
    oldLineNumber?: number | null;
    newLineNumber?: number | null;
    exact?: boolean;
    hunkIndex?: number;
    decisionHunkIndex?: number;
    visualBlockIndex?: number;
}

export interface DiffStats {
    additions: number;
    deletions: number;
    approximate?: boolean;
}

export interface ChangeHunk {
    index: number;
    lines: DiffLine[];
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

export type DecisionHunk = ChangeHunk;

export interface VisualDiffBlock extends ChangeHunk {
    decisionHunkIndexes: number[];
}

export interface StructuredDiffResult {
    hunks: VisualDiffBlock[];
    decisionHunks: DecisionHunk[];
    visualBlocks: VisualDiffBlock[];
    lines: DiffLine[];
}

export type GroupedDiffResult = StructuredDiffResult;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FULL_DIFF_MAX_LINES = 700;
const LARGE_FILE_PREVIEW_MAX_LINES = 2000;
const DIFF_CONTEXT_LINES = 5;
const UNIFIED_DIFF_HUNK_HEADER_REGEX =
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export const DIFF_PANEL_MAX_HEIGHT = 520;
export const DIFF_ZOOM_MIN = 0.64;
export const DIFF_ZOOM_MAX = 0.96;
export const DIFF_ZOOM_STEP = 0.04;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function splitDiffText(text?: string | null): string[] {
    if (!text) {
        return [];
    }

    return text.split("\n");
}

function isLargeUpdateDiff(oldLines: string[], newLines: string[]): boolean {
    return Math.max(oldLines.length, newLines.length) > FULL_DIFF_MAX_LINES;
}

interface DiffOp {
    type: "context" | "add" | "remove";
    text: string;
    oldIndex: number | null;
    newIndex: number | null;
}

interface RawChangeHunk {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    startOpIndex: number;
    endOpIndex: number;
}

function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table = Array.from({ length: rows }, () =>
        new Array<number>(cols).fill(0),
    );

    for (let row = 1; row < rows; row++) {
        for (let col = 1; col < cols; col++) {
            table[row][col] =
                oldLines[row - 1] === newLines[col - 1]
                    ? table[row - 1][col - 1] + 1
                    : Math.max(table[row - 1][col], table[row][col - 1]);
        }
    }

    return table;
}

function buildDiffOps(oldLines: string[], newLines: string[]): DiffOp[] {
    const lcs = buildLcsTable(oldLines, newLines);
    const ops: DiffOp[] = [];

    let oldIndex = oldLines.length;
    let newIndex = newLines.length;

    while (oldIndex > 0 || newIndex > 0) {
        if (
            oldIndex > 0 &&
            newIndex > 0 &&
            oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ) {
            ops.push({
                type: "context",
                text: oldLines[oldIndex - 1],
                oldIndex: oldIndex - 1,
                newIndex: newIndex - 1,
            });
            oldIndex -= 1;
            newIndex -= 1;
            continue;
        }

        if (
            newIndex > 0 &&
            (oldIndex === 0 ||
                lcs[oldIndex][newIndex - 1] >= lcs[oldIndex - 1][newIndex])
        ) {
            ops.push({
                type: "add",
                text: newLines[newIndex - 1],
                oldIndex: null,
                newIndex: newIndex - 1,
            });
            newIndex -= 1;
            continue;
        }

        ops.push({
            type: "remove",
            text: oldLines[oldIndex - 1],
            oldIndex: oldIndex - 1,
            newIndex: null,
        });
        oldIndex -= 1;
    }

    ops.reverse();
    return ops;
}

function collectRawChangeHunks(ops: DiffOp[]): RawChangeHunk[] {
    const hunks: RawChangeHunk[] = [];
    let current: RawChangeHunk | null = null;
    let oldPos = 0;
    let newPos = 0;

    ops.forEach((op, opIndex) => {
        if (op.type === "context") {
            if (current) {
                current.endOpIndex = opIndex;
                current.oldEnd = oldPos;
                current.newEnd = newPos;
                hunks.push(current);
                current = null;
            }

            oldPos += 1;
            newPos += 1;
            return;
        }

        if (!current) {
            current = {
                oldStart: oldPos,
                oldEnd: oldPos,
                newStart: newPos,
                newEnd: newPos,
                startOpIndex: opIndex,
                endOpIndex: opIndex + 1,
            };
        }

        current.endOpIndex = opIndex + 1;

        if (op.type === "remove") {
            oldPos += 1;
            current.oldEnd = oldPos;
            current.newEnd = newPos;
            return;
        }

        newPos += 1;
        current.oldEnd = oldPos;
        current.newEnd = newPos;
    });

    if (current) {
        const finalHunk: RawChangeHunk = current;
        finalHunk.endOpIndex = ops.length;
        finalHunk.oldEnd = oldPos;
        finalHunk.newEnd = newPos;
        hunks.push(finalHunk);
    }

    return hunks;
}

function buildVisualDiffLine(
    op: DiffOp,
    visualBlockIndex: number,
    decisionHunkIndex?: number,
): DiffLine {
    return {
        type: op.type,
        prefix: op.type === "context" ? "  " : op.type === "add" ? "+ " : "- ",
        text: op.text,
        oldLineNumber: op.oldIndex != null ? op.oldIndex + 1 : null,
        newLineNumber: op.newIndex != null ? op.newIndex + 1 : null,
        hunkIndex: visualBlockIndex,
        decisionHunkIndex,
        visualBlockIndex,
    };
}

function buildExactHunkData(hunks: AIFileDiffHunk[]): GroupedDiffResult {
    const decisionHunks: DecisionHunk[] = [];
    const visualBlocks: VisualDiffBlock[] = [];
    const lines: DiffLine[] = [];

    hunks.forEach((hunk, hunkIndex) => {
        if (hunkIndex > 0) {
            lines.push({
                type: "separator",
                prefix: "",
                text: "···",
                oldLineNumber: null,
                newLineNumber: null,
                exact: true,
            });
        }

        let oldLineNumber = hunk.old_start;
        let newLineNumber = hunk.new_start;
        const hunkLines: DiffLine[] = [];

        for (const line of hunk.lines) {
            const diffLine: DiffLine =
                line.type === "context"
                    ? {
                          type: "context",
                          prefix: "",
                          text: line.text,
                          oldLineNumber,
                          newLineNumber,
                          exact: true,
                          hunkIndex,
                          decisionHunkIndex: hunkIndex,
                          visualBlockIndex: hunkIndex,
                      }
                    : line.type === "remove"
                      ? {
                            type: "remove",
                            prefix: "",
                            text: line.text,
                            oldLineNumber,
                            newLineNumber: null,
                            exact: true,
                            hunkIndex,
                            decisionHunkIndex: hunkIndex,
                            visualBlockIndex: hunkIndex,
                        }
                      : {
                            type: "add",
                            prefix: "",
                            text: line.text,
                            oldLineNumber: null,
                            newLineNumber,
                            exact: true,
                            hunkIndex,
                            decisionHunkIndex: hunkIndex,
                            visualBlockIndex: hunkIndex,
                        };

            hunkLines.push(diffLine);
            lines.push(diffLine);

            if (line.type !== "add") {
                oldLineNumber += 1;
            }

            if (line.type !== "remove") {
                newLineNumber += 1;
            }
        }

        const normalizedHunk: DecisionHunk = {
            index: hunkIndex,
            lines: hunkLines,
            oldStart: Math.max(0, hunk.old_start - 1),
            oldEnd: Math.max(0, hunk.old_start - 1) + hunk.old_count,
            newStart: Math.max(0, hunk.new_start - 1),
            newEnd: Math.max(0, hunk.new_start - 1) + hunk.new_count,
        };
        decisionHunks.push(normalizedHunk);
        visualBlocks.push({
            ...normalizedHunk,
            decisionHunkIndexes: [hunkIndex],
        });
    });

    return {
        hunks: visualBlocks,
        decisionHunks,
        visualBlocks,
        lines,
    };
}

export function parseUnifiedDiffHunks(text: string): AIFileDiffHunk[] {
    const hunks: AIFileDiffHunk[] = [];
    let currentHunk: AIFileDiffHunk | null = null;

    for (const rawLine of text.split("\n")) {
        const headerMatch = UNIFIED_DIFF_HUNK_HEADER_REGEX.exec(rawLine);
        if (headerMatch) {
            currentHunk = {
                old_start: Number.parseInt(headerMatch[1], 10),
                old_count: Number.parseInt(headerMatch[2] ?? "1", 10),
                new_start: Number.parseInt(headerMatch[3], 10),
                new_count: Number.parseInt(headerMatch[4] ?? "1", 10),
                lines: [],
            };
            hunks.push(currentHunk);
            continue;
        }

        if (!currentHunk) {
            continue;
        }

        if (rawLine === "\\ No newline at end of file") {
            continue;
        }

        const marker = rawLine[0];
        const text = rawLine.slice(1);
        if (marker === " ") {
            currentHunk.lines.push({ type: "context", text });
            continue;
        }

        if (marker === "-") {
            currentHunk.lines.push({ type: "remove", text });
            continue;
        }

        if (marker === "+") {
            currentHunk.lines.push({ type: "add", text });
        }
    }

    return hunks.filter((hunk) => hunk.lines.length > 0);
}

export function computeUnifiedDiffLines(text: string): DiffLine[] {
    const hunks = parseUnifiedDiffHunks(text);
    if (hunks.length === 0) {
        return [];
    }

    return buildExactHunkData(hunks).lines;
}

export function groupDiffLinesIntoHunks(
    baseText: string,
    appliedText: string,
): GroupedDiffResult {
    const baseLines = splitDiffText(baseText);
    const appliedLines = splitDiffText(appliedText);
    const ops = buildDiffOps(baseLines, appliedLines);
    const rawHunks = collectRawChangeHunks(ops);

    if (rawHunks.length === 0) {
        return { hunks: [], decisionHunks: [], visualBlocks: [], lines: [] };
    }

    const decisionHunks: DecisionHunk[] = rawHunks.map((hunk, index) => ({
        index,
        oldStart: hunk.oldStart,
        oldEnd: hunk.oldEnd,
        newStart: hunk.newStart,
        newEnd: hunk.newEnd,
        lines: ops
            .slice(hunk.startOpIndex, hunk.endOpIndex)
            .map((op) => buildVisualDiffLine(op, index, index)),
    }));

    const windows = rawHunks.map((hunk, index) => ({
        start: Math.max(0, hunk.startOpIndex - DIFF_CONTEXT_LINES),
        end: Math.min(ops.length, hunk.endOpIndex + DIFF_CONTEXT_LINES),
        decisionHunkIndexes: [index],
        oldStart: hunk.oldStart,
        oldEnd: hunk.oldEnd,
        newStart: hunk.newStart,
        newEnd: hunk.newEnd,
    }));

    const mergedWindows: Array<{
        start: number;
        end: number;
        decisionHunkIndexes: number[];
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
    }> = [];

    for (const window of windows) {
        const lastWindow = mergedWindows[mergedWindows.length - 1];
        if (!lastWindow || window.start > lastWindow.end) {
            mergedWindows.push({ ...window });
            continue;
        }

        lastWindow.end = Math.max(lastWindow.end, window.end);
        lastWindow.decisionHunkIndexes.push(...window.decisionHunkIndexes);
        lastWindow.oldStart = Math.min(lastWindow.oldStart, window.oldStart);
        lastWindow.oldEnd = Math.max(lastWindow.oldEnd, window.oldEnd);
        lastWindow.newStart = Math.min(lastWindow.newStart, window.newStart);
        lastWindow.newEnd = Math.max(lastWindow.newEnd, window.newEnd);
    }

    const resultLines: DiffLine[] = [];
    const visualBlocks: VisualDiffBlock[] = [];

    const opDecisionHunkIndexes = new Map<number, number>();
    rawHunks.forEach((hunk, hunkIndex) => {
        for (
            let opIndex = hunk.startOpIndex;
            opIndex < hunk.endOpIndex;
            opIndex++
        ) {
            opDecisionHunkIndexes.set(opIndex, hunkIndex);
        }
    });

    mergedWindows.forEach((window, visualBlockIndex) => {
        if (visualBlockIndex > 0) {
            resultLines.push({
                type: "separator",
                prefix: "",
                text: "···",
            });
        }

        const blockLines = ops
            .slice(window.start, window.end)
            .map((op, relativeIndex) =>
                buildVisualDiffLine(
                    op,
                    visualBlockIndex,
                    opDecisionHunkIndexes.get(window.start + relativeIndex),
                ),
            );

        resultLines.push(...blockLines);
        visualBlocks.push({
            index: visualBlockIndex,
            lines: blockLines,
            oldStart: window.oldStart,
            oldEnd: window.oldEnd,
            newStart: window.newStart,
            newEnd: window.newEnd,
            decisionHunkIndexes: [...window.decisionHunkIndexes],
        });
    });

    return {
        hunks: visualBlocks,
        decisionHunks,
        visualBlocks,
        lines: resultLines,
    };
}

function largeFilePreview(oldLines: string[], newLines: string[]): DiffLine[] {
    const limit = Math.min(
        Math.max(oldLines.length, newLines.length),
        LARGE_FILE_PREVIEW_MAX_LINES,
    );
    const result: DiffLine[] = [];

    let oldNum = 1;
    let newNum = 1;
    for (let idx = 0; idx < limit; idx++) {
        const oldLine = oldLines[idx];
        const newLine = newLines[idx];

        if (oldLine === newLine) {
            result.push({
                type: "context",
                prefix: "  ",
                text: newLine ?? oldLine ?? "",
                oldLineNumber: oldNum,
                newLineNumber: newNum,
            });
            oldNum++;
            newNum++;
            continue;
        }

        if (oldLine !== undefined) {
            result.push({
                type: "remove",
                prefix: "- ",
                text: oldLine,
                oldLineNumber: oldNum,
                newLineNumber: null,
            });
            oldNum++;
        }

        if (newLine !== undefined) {
            result.push({
                type: "add",
                prefix: "+ ",
                text: newLine,
                oldLineNumber: null,
                newLineNumber: newNum,
            });
            newNum++;
        }
    }

    const total = Math.max(oldLines.length, newLines.length);
    const previewLabel =
        total > LARGE_FILE_PREVIEW_MAX_LINES
            ? `(large file preview — showing first ${LARGE_FILE_PREVIEW_MAX_LINES} of ${total} lines)`
            : `(large file preview — ${total} lines shown without full diff matching)`;
    result.push({
        type: "separator",
        prefix: "",
        text: previewLabel,
    });

    return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeDiffLines(diff: AIFileDiff): DiffLine[] {
    if (diff.is_text === false) {
        return [];
    }

    if (diff.hunks && diff.hunks.length > 0) {
        return buildExactHunkData(diff.hunks).lines;
    }

    const oldLines = splitDiffText(diff.old_text);
    const newLines = splitDiffText(diff.new_text);
    const isPureMove =
        diff.kind === "move" && (diff.old_text ?? "") === (diff.new_text ?? "");

    if (diff.kind === "add") {
        return newLines.map((line, idx) => ({
            type: "add" as const,
            prefix: "+ ",
            text: line,
            oldLineNumber: null,
            newLineNumber: idx + 1,
        }));
    }

    if (diff.kind === "delete") {
        if (diff.reversible === false) {
            return [
                {
                    type: "separator",
                    prefix: "",
                    text: "(partial preview — delete snapshot unavailable)",
                },
            ];
        }
        return oldLines.map((line, idx) => ({
            type: "remove" as const,
            prefix: "- ",
            text: line,
            oldLineNumber: idx + 1,
            newLineNumber: null,
        }));
    }

    if (isPureMove) {
        return [];
    }

    if (isLargeUpdateDiff(oldLines, newLines)) {
        return largeFilePreview(oldLines, newLines);
    }

    return groupDiffLinesIntoHunks(diff.old_text ?? "", diff.new_text ?? "")
        .lines;
}

export function computeChangeHunks(diff: AIFileDiff): ChangeHunk[] {
    return computeVisualDiffBlocks(diff);
}

export function computeVisualDiffBlocks(diff: AIFileDiff): VisualDiffBlock[] {
    if (diff.is_text === false) {
        return [];
    }

    if (diff.hunks && diff.hunks.length > 0) {
        return buildExactHunkData(diff.hunks).hunks;
    }

    const oldLines = splitDiffText(diff.old_text);
    const newLines = splitDiffText(diff.new_text);
    const isPureMove =
        diff.kind === "move" && (diff.old_text ?? "") === (diff.new_text ?? "");

    if (
        diff.kind === "add" ||
        diff.kind === "delete" ||
        isPureMove ||
        isLargeUpdateDiff(oldLines, newLines)
    ) {
        return [];
    }

    return groupDiffLinesIntoHunks(diff.old_text ?? "", diff.new_text ?? "")
        .hunks;
}

export function computeDecisionHunks(diff: AIFileDiff): DecisionHunk[] {
    if (diff.is_text === false) {
        return [];
    }

    if (diff.hunks && diff.hunks.length > 0) {
        return buildExactHunkData(diff.hunks).decisionHunks;
    }

    const oldLines = splitDiffText(diff.old_text);
    const newLines = splitDiffText(diff.new_text);
    const isPureMove =
        diff.kind === "move" && (diff.old_text ?? "") === (diff.new_text ?? "");

    if (
        diff.kind === "add" ||
        diff.kind === "delete" ||
        isPureMove ||
        isLargeUpdateDiff(oldLines, newLines)
    ) {
        return [];
    }

    return groupDiffLinesIntoHunks(diff.old_text ?? "", diff.new_text ?? "")
        .decisionHunks;
}

export function computeMergedText(
    baseText: string,
    appliedText: string,
    hunks: ChangeHunk[],
    decisions: Map<number, "accepted" | "rejected">,
): string {
    const baseLines = splitDiffText(baseText);
    const appliedLines = splitDiffText(appliedText);
    const orderedHunks = [...hunks].sort((left, right) =>
        left.oldStart === right.oldStart
            ? left.newStart - right.newStart
            : left.oldStart - right.oldStart,
    );
    const result: string[] = [];
    let basePos = 0;

    for (const hunk of orderedHunks) {
        result.push(...baseLines.slice(basePos, hunk.oldStart));

        if (decisions.get(hunk.index) === "accepted") {
            result.push(...appliedLines.slice(hunk.newStart, hunk.newEnd));
        } else {
            result.push(...baseLines.slice(hunk.oldStart, hunk.oldEnd));
        }

        basePos = hunk.oldEnd;
    }

    result.push(...baseLines.slice(basePos));
    return result.join("\n");
}

export function computeFileDiffStats(diff: AIFileDiff): DiffStats {
    if (diff.is_text === false) {
        return { additions: 0, deletions: 0 };
    }

    if (diff.hunks && diff.hunks.length > 0) {
        let additions = 0;
        let deletions = 0;

        for (const hunk of diff.hunks) {
            for (const line of hunk.lines) {
                if (line.type === "add") additions += 1;
                if (line.type === "remove") deletions += 1;
            }
        }

        return { additions, deletions };
    }

    const oldLines = splitDiffText(diff.old_text);
    const newLines = splitDiffText(diff.new_text);

    if (diff.kind === "add") {
        return { additions: newLines.length, deletions: 0 };
    }

    if (diff.kind === "delete") {
        if (diff.reversible === false) {
            return { additions: 0, deletions: 0, approximate: true };
        }
        return { additions: 0, deletions: oldLines.length };
    }

    if (isLargeUpdateDiff(oldLines, newLines)) {
        let additions = 0;
        let deletions = 0;
        const limit = Math.min(
            Math.max(oldLines.length, newLines.length),
            LARGE_FILE_PREVIEW_MAX_LINES,
        );

        for (let idx = 0; idx < limit; idx++) {
            const oldLine = oldLines[idx];
            const newLine = newLines[idx];
            if (oldLine === newLine) continue;
            if (oldLine !== undefined) deletions++;
            if (newLine !== undefined) additions++;
        }

        return { additions, deletions, approximate: true };
    }

    const lines = groupDiffLinesIntoHunks(
        diff.old_text ?? "",
        diff.new_text ?? "",
    ).lines;
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
        if (line.type === "add") additions++;
        if (line.type === "remove") deletions++;
    }

    return { additions, deletions };
}

export function computeDiffStats(diffs: AIFileDiff[]): DiffStats {
    let additions = 0;
    let deletions = 0;
    let approximate = false;

    for (const diff of diffs) {
        const stats = computeFileDiffStats(diff);
        additions += stats.additions;
        deletions += stats.deletions;
        approximate ||= stats.approximate === true;
    }

    return { additions, deletions, approximate };
}

export function formatDiffStat(value: number, approximate?: boolean): string {
    return `${approximate ? "~" : ""}${value}`;
}

export function clampDiffZoom(value: number): number {
    return Math.min(DIFF_ZOOM_MAX, Math.max(DIFF_ZOOM_MIN, value));
}

export function stepDiffZoom(value: number, delta: number): number {
    return Math.round(clampDiffZoom(value + delta) * 100) / 100;
}

export function getFileNameFromPath(path: string) {
    return path.split("/").pop() ?? path;
}

export function getCompactPath(path: string, tailSegments = 3) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= tailSegments) {
        return path;
    }

    return `.../${parts.slice(-tailSegments).join("/")}`;
}

export function createDiffFromTrackedFile(file: TrackedFile): AIFileDiff {
    const previousPath =
        file.previousPath ??
        (file.originPath !== file.path ? file.originPath : null);
    const op = getFileOperation(file);
    const kind = previousPath && op !== "add" && op !== "delete" ? "move" : op;
    const hunks = unreviewedEditsToHunks(file);

    return {
        path: file.path,
        kind,
        previous_path: previousPath,
        reversible: true,
        is_text: file.isText,
        old_text: file.diffBase,
        new_text: file.currentText,
        ...(hunks.length > 0 ? { hunks } : {}),
    };
}
