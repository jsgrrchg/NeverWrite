import type { AgentTextSpan, TrackedFile } from "./actionLogTypes";
import {
    deriveLinePatchFromTextRanges,
    syncDerivedLinePatch,
} from "../store/actionLogModel";

export interface ReviewHunkId {
    trackedVersion: number;
    key: string;
}

export interface ReviewChunkId {
    trackedVersion: number;
    key: string;
}

export type ReviewChunkControlMode =
    | "chunk"
    | "hunk"
    | "inline-overlap"
    | "panel-only";

export interface ReviewHunkMemberSpan {
    spanIndex: number;
    baseFrom: number;
    baseTo: number;
    currentFrom: number;
    currentTo: number;
}

export interface ReviewHunk {
    id: ReviewHunkId;
    identityKey: string;
    trackedVersion: number;
    oldStartLine: number;
    oldEndLine: number;
    newStartLine: number;
    newEndLine: number;
    visualStartLine: number;
    visualEndLine: number;
    baseFrom: number;
    baseTo: number;
    currentFrom: number;
    currentTo: number;
    memberSpans: ReviewHunkMemberSpan[];
    chunkId: ReviewChunkId;
    overlapGroupId: string;
    overlapGroupSize: number;
    hasConflict: boolean;
    ambiguous: boolean;
}

export interface ReviewChunk {
    id: ReviewChunkId;
    identityKey: string;
    trackedVersion: number;
    startLine: number;
    endLine: number;
    hunkIds: ReviewHunkId[];
    overlapGroupIds: string[];
    multiHunk: boolean;
    hasConflict: boolean;
    ambiguous: boolean;
    controlMode: ReviewChunkControlMode;
    canResolveInlineExactly: boolean;
}

export type ReviewProjectionStatus =
    | "projection_ready"
    | "projection_partial"
    | "projection_invalid";

export type ReviewChunkRenderState = "inline-safe" | "degraded" | "invalid";

export interface ReviewProjectionMetrics {
    totalLines: number;
    hunkCount: number;
    chunkCount: number;
    visibleChunkCount: number;
    invalidChunkCount: number;
    inlineSafeChunkCount: number;
    degradedChunkCount: number;
    status: ReviewProjectionStatus;
}

export interface ReviewProjectionDiagnostics {
    metrics: ReviewProjectionMetrics;
    hunkInvariantIdsByKey: Record<string, ReviewProjectionInvariantId[]>;
    chunkInvariantIdsByKey: Record<string, ReviewProjectionInvariantId[]>;
    chunkRenderStateByKey: Record<string, ReviewChunkRenderState>;
}

export interface ReviewProjection {
    trackedVersion: number;
    hunks: ReviewHunk[];
    chunks: ReviewChunk[];
    diagnostics: ReviewProjectionDiagnostics;
}

interface ReviewHunkSeed {
    id: ReviewHunkId;
    identityKey: string;
    trackedVersion: number;
    oldStartLine: number;
    oldEndLine: number;
    newStartLine: number;
    newEndLine: number;
    baseFrom: number;
    baseTo: number;
    currentFrom: number;
    currentTo: number;
    memberSpans: ReviewHunkMemberSpan[];
    hasConflict: boolean;
    visualStartLine: number;
    visualEndLine: number;
}

interface ReviewChunkSeed {
    id: ReviewChunkId;
    identityKey: string;
    trackedVersion: number;
    startLine: number;
    endLine: number;
    hunkIds: ReviewHunkId[];
    overlapGroupIds: string[];
    overlapGroupByHunkKey: Record<string, string>;
    overlapGroupSizeByHunkKey: Record<string, number>;
    multiHunk: boolean;
    hasConflict: boolean;
    ambiguous: boolean;
    controlMode: ReviewChunkControlMode;
    canResolveInlineExactly: boolean;
}

export interface ReviewProjectionInlineState {
    projectionState: ReviewProjectionStatus;
    reviewProjectionReady: boolean;
    hasAmbiguousChunks: boolean;
    hasConflicts: boolean;
    hasMultiHunkChunks: boolean;
    totalLines: number;
    hunkCount: number;
    chunkCount: number;
    visibleChunkCount: number;
    invalidChunkCount: number;
    inlineSafeChunkCount: number;
    degradedChunkCount: number;
}

export type ReviewProjectionInvariantId =
    | "review_projection_matches_spans"
    | "review_hunk_ids_stable_within_version"
    | "review_projection_within_current_doc"
    | "review_hunk_member_spans_non_empty"
    | "review_hunk_line_range_ordered"
    | "review_hunk_line_range_within_current_doc"
    | "review_chunk_hunk_ids_non_empty"
    | "review_chunk_line_range_ordered"
    | "review_chunk_line_range_within_current_doc"
    | "review_chunk_covers_hunk_lines";

export interface ReviewProjectionInvariantViolation {
    id: ReviewProjectionInvariantId;
    message: string;
    subject: "projection" | "hunk" | "chunk";
    entityKey?: string;
}

const projectionCache = new WeakMap<TrackedFile, ReviewProjection>();
const DEFAULT_CHUNK_LINE_GAP = 1;
const EMPTY_PROJECTION_METRICS: ReviewProjectionMetrics = {
    totalLines: 0,
    hunkCount: 0,
    chunkCount: 0,
    visibleChunkCount: 0,
    invalidChunkCount: 0,
    inlineSafeChunkCount: 0,
    degradedChunkCount: 0,
    status: "projection_invalid",
};

function compareCanonicalSpans(
    left: Pick<
        AgentTextSpan,
        "currentFrom" | "currentTo" | "baseFrom" | "baseTo"
    >,
    right: Pick<
        AgentTextSpan,
        "currentFrom" | "currentTo" | "baseFrom" | "baseTo"
    >,
): number {
    return (
        left.currentFrom - right.currentFrom ||
        left.currentTo - right.currentTo ||
        left.baseFrom - right.baseFrom ||
        left.baseTo - right.baseTo
    );
}

function compareReviewHunkSeeds(
    left: Pick<
        ReviewHunkSeed,
        | "visualStartLine"
        | "visualEndLine"
        | "currentFrom"
        | "currentTo"
        | "baseFrom"
        | "baseTo"
        | "id"
    >,
    right: Pick<
        ReviewHunkSeed,
        | "visualStartLine"
        | "visualEndLine"
        | "currentFrom"
        | "currentTo"
        | "baseFrom"
        | "baseTo"
        | "id"
    >,
): number {
    return (
        left.visualStartLine - right.visualStartLine ||
        left.visualEndLine - right.visualEndLine ||
        compareCanonicalSpans(left, right) ||
        left.id.key.localeCompare(right.id.key)
    );
}

function buildLineStartOffsets(text: string): number[] {
    const offsets = [0];
    for (let index = 0; index < text.length; index += 1) {
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

function deriveOffsetLineRange(
    lineStarts: number[],
    from: number,
    to: number,
): { start: number; end: number } {
    if (from === to) {
        const point = insertionLineIndexAtOffset(lineStarts, from);
        return { start: point, end: point };
    }

    return {
        start: lineIndexAtOffset(lineStarts, from),
        end: lineIndexAtOffset(lineStarts, to - 1) + 1,
    };
}

function deriveSpanLineRange(
    baseText: string,
    currentText: string,
    span: AgentTextSpan,
): {
    oldStartLine: number;
    oldEndLine: number;
    newStartLine: number;
    newEndLine: number;
} {
    const patch = deriveLinePatchFromTextRanges(baseText, currentText, [span]);
    if (patch.edits.length > 0) {
        const oldStartLine = Math.min(
            ...patch.edits.map((edit) => edit.oldStart),
        );
        const oldEndLine = Math.max(...patch.edits.map((edit) => edit.oldEnd));
        const newStartLine = Math.min(
            ...patch.edits.map((edit) => edit.newStart),
        );
        const newEndLine = Math.max(...patch.edits.map((edit) => edit.newEnd));
        return { oldStartLine, oldEndLine, newStartLine, newEndLine };
    }

    const baseLineStarts = buildLineStartOffsets(baseText);
    const currentLineStarts = buildLineStartOffsets(currentText);
    const baseRange = deriveOffsetLineRange(
        baseLineStarts,
        span.baseFrom,
        span.baseTo,
    );
    const currentRange = deriveOffsetLineRange(
        currentLineStarts,
        span.currentFrom,
        span.currentTo,
    );

    return {
        oldStartLine: baseRange.start,
        oldEndLine: baseRange.end,
        newStartLine: currentRange.start,
        newEndLine: currentRange.end,
    };
}

function deriveCurrentDocLineCount(text: string): number {
    return buildLineStartOffsets(text).length;
}

function isLineRangeOrdered(startLine: number, endLine: number): boolean {
    return startLine >= 0 && endLine >= startLine;
}

function isLineRangeWithinCurrentDoc(
    startLine: number,
    endLine: number,
    docLines: number,
): boolean {
    return (
        isLineRangeOrdered(startLine, endLine) &&
        startLine < docLines &&
        endLine <= docLines
    );
}

function rangesStrictlyOverlap(
    leftStart: number,
    leftEnd: number,
    rightStart: number,
    rightEnd: number,
): boolean {
    if (leftStart === leftEnd && rightStart === rightEnd) {
        return leftStart === rightStart;
    }

    return leftStart < rightEnd && rightStart < leftEnd;
}

function hunksOverlapCanonically(
    left: Pick<
        ReviewHunkSeed,
        "baseFrom" | "baseTo" | "currentFrom" | "currentTo"
    >,
    right: Pick<
        ReviewHunkSeed,
        "baseFrom" | "baseTo" | "currentFrom" | "currentTo"
    >,
): boolean {
    return (
        rangesStrictlyOverlap(
            left.baseFrom,
            left.baseTo,
            right.baseFrom,
            right.baseTo,
        ) ||
        rangesStrictlyOverlap(
            left.currentFrom,
            left.currentTo,
            right.currentFrom,
            right.currentTo,
        )
    );
}

function buildReviewHunkId(
    trackedVersion: number,
    memberSpans: ReviewHunkMemberSpan[],
): ReviewHunkId {
    return {
        trackedVersion,
        key: memberSpans
            .map(
                (span) =>
                    `${span.baseFrom}:${span.baseTo}:${span.currentFrom}:${span.currentTo}`,
            )
            .join("|"),
    };
}

function buildReviewChunkId(
    trackedVersion: number,
    hunkIds: ReviewHunkId[],
): ReviewChunkId {
    return {
        trackedVersion,
        key: hunkIds.map((id) => id.key).join("||"),
    };
}

export function getReviewChunkControlMode(chunk: {
    ambiguous: boolean;
    hasConflict: boolean;
    multiHunk: boolean;
}): ReviewChunkControlMode {
    if (chunk.hasConflict) {
        return "panel-only";
    }

    if (chunk.ambiguous) {
        return "inline-overlap";
    }

    return chunk.multiHunk ? "hunk" : "chunk";
}

export function canResolveReviewChunkInlineExactly(chunk: {
    ambiguous: boolean;
    hasConflict: boolean;
    multiHunk: boolean;
}): boolean {
    return getReviewChunkControlMode(chunk) !== "panel-only";
}

function buildReviewHunkSeeds(file: TrackedFile): ReviewHunkSeed[] {
    const spans = file.unreviewedRanges?.spans ?? [];
    const hasConflict = file.conflictHash != null;

    return spans.map((span, spanIndex) => {
        const memberSpan: ReviewHunkMemberSpan = {
            spanIndex,
            baseFrom: span.baseFrom,
            baseTo: span.baseTo,
            currentFrom: span.currentFrom,
            currentTo: span.currentTo,
        };
        const lineRange = deriveSpanLineRange(
            file.diffBase,
            file.currentText,
            span,
        );
        // Inline controls render against the current editor document, not the
        // historical base snapshot. For deletions near EOF, using the max of
        // old/new line ranges can place controls beyond the current doc.
        const visualStartLine = lineRange.newStartLine;
        const visualEndLine = lineRange.newEndLine;

        return {
            id: buildReviewHunkId(file.version, [memberSpan]),
            identityKey: file.identityKey,
            trackedVersion: file.version,
            oldStartLine: lineRange.oldStartLine,
            oldEndLine: lineRange.oldEndLine,
            newStartLine: lineRange.newStartLine,
            newEndLine: lineRange.newEndLine,
            baseFrom: span.baseFrom,
            baseTo: span.baseTo,
            currentFrom: span.currentFrom,
            currentTo: span.currentTo,
            memberSpans: [memberSpan],
            hasConflict,
            visualStartLine,
            visualEndLine,
        };
    });
}

function buildReviewChunkSeeds(hunks: ReviewHunkSeed[]): ReviewChunkSeed[] {
    if (hunks.length === 0) {
        return [];
    }

    const chunks: ReviewChunkSeed[] = [];
    let currentHunks: ReviewHunkSeed[] = [hunks[0]!];
    let currentStartLine = hunks[0]!.visualStartLine;
    let currentEndLine = hunks[0]!.visualEndLine;

    const flushCurrentChunk = () => {
        const hunkIds = currentHunks.map((hunk) => hunk.id);
        const multiHunk = currentHunks.length > 1;
        const chunkId = buildReviewChunkId(
            currentHunks[0]!.trackedVersion,
            hunkIds,
        );
        const overlapGroupByHunkKey: Record<string, string> = {};
        const overlapGroupSizeByHunkKey: Record<string, number> = {};
        const overlapGroupIds: string[] = [];
        const visited = new Set<number>();

        for (let index = 0; index < currentHunks.length; index += 1) {
            if (visited.has(index)) {
                continue;
            }

            const stack = [index];
            const componentIndices: number[] = [];

            while (stack.length > 0) {
                const cursor = stack.pop();
                if (cursor == null || visited.has(cursor)) {
                    continue;
                }

                visited.add(cursor);
                componentIndices.push(cursor);

                for (
                    let candidate = 0;
                    candidate < currentHunks.length;
                    candidate += 1
                ) {
                    if (visited.has(candidate) || candidate === cursor) {
                        continue;
                    }

                    if (
                        hunksOverlapCanonically(
                            currentHunks[cursor]!,
                            currentHunks[candidate]!,
                        )
                    ) {
                        stack.push(candidate);
                    }
                }
            }

            componentIndices.sort((left, right) => left - right);
            const componentKeys = componentIndices.map(
                (componentIndex) => currentHunks[componentIndex]!.id.key,
            );
            const overlapGroupId = `${chunkId.key}::${componentKeys.join("|")}`;
            const overlapGroupSize = componentKeys.length;
            overlapGroupIds.push(overlapGroupId);

            componentKeys.forEach((hunkKey) => {
                overlapGroupByHunkKey[hunkKey] = overlapGroupId;
                overlapGroupSizeByHunkKey[hunkKey] = overlapGroupSize;
            });
        }

        const maxOverlapGroupSize = Object.values(
            overlapGroupSizeByHunkKey,
        ).reduce((maxSize, size) => Math.max(maxSize, size), 0);
        const ambiguous = multiHunk && maxOverlapGroupSize > 1;
        const hasConflict = currentHunks.some((hunk) => hunk.hasConflict);
        const controlMode = getReviewChunkControlMode({
            ambiguous,
            hasConflict,
            multiHunk,
        });

        chunks.push({
            id: chunkId,
            identityKey: currentHunks[0]!.identityKey,
            trackedVersion: currentHunks[0]!.trackedVersion,
            startLine: currentStartLine,
            endLine: currentEndLine,
            hunkIds,
            overlapGroupIds,
            overlapGroupByHunkKey,
            overlapGroupSizeByHunkKey,
            multiHunk,
            hasConflict,
            ambiguous,
            controlMode,
            canResolveInlineExactly: controlMode !== "panel-only",
        });
    };

    for (const hunk of hunks.slice(1)) {
        const gap = hunk.visualStartLine - currentEndLine;
        if (gap <= DEFAULT_CHUNK_LINE_GAP) {
            currentHunks.push(hunk);
            currentStartLine = Math.min(currentStartLine, hunk.visualStartLine);
            currentEndLine = Math.max(currentEndLine, hunk.visualEndLine);
            continue;
        }

        flushCurrentChunk();
        currentHunks = [hunk];
        currentStartLine = hunk.visualStartLine;
        currentEndLine = hunk.visualEndLine;
    }

    flushCurrentChunk();
    return chunks;
}

export function reviewHunkIdEquals(
    left: ReviewHunkId,
    right: ReviewHunkId,
): boolean {
    return (
        left.trackedVersion === right.trackedVersion && left.key === right.key
    );
}

export function reviewChunkIdEquals(
    left: ReviewChunkId,
    right: ReviewChunkId,
): boolean {
    return (
        left.trackedVersion === right.trackedVersion && left.key === right.key
    );
}

export function isReviewChunkMultiHunk(chunk: ReviewChunk): boolean {
    return chunk.hunkIds.length > 1;
}

function getReviewHunkInvariantIds(
    hunk: ReviewHunk,
    docLines: number,
): ReviewProjectionInvariantId[] {
    const invariantIds: ReviewProjectionInvariantId[] = [];

    if (hunk.memberSpans.length === 0) {
        invariantIds.push("review_hunk_member_spans_non_empty");
    }

    if (!isLineRangeOrdered(hunk.visualStartLine, hunk.visualEndLine)) {
        invariantIds.push("review_hunk_line_range_ordered");
    } else if (
        !isLineRangeWithinCurrentDoc(
            hunk.visualStartLine,
            hunk.visualEndLine,
            docLines,
        )
    ) {
        invariantIds.push("review_hunk_line_range_within_current_doc");
    }

    return invariantIds;
}

function getReviewChunkInvariantIds(
    chunk: ReviewChunk,
    hunkByIdKey: Map<string, ReviewHunk>,
    hunkInvariantIdsByKey: Record<string, ReviewProjectionInvariantId[]>,
    docLines: number,
): ReviewProjectionInvariantId[] {
    const invariantIds: ReviewProjectionInvariantId[] = [];

    if (chunk.hunkIds.length === 0) {
        invariantIds.push("review_chunk_hunk_ids_non_empty");
    }

    if (!isLineRangeOrdered(chunk.startLine, chunk.endLine)) {
        invariantIds.push("review_chunk_line_range_ordered");
    } else if (
        !isLineRangeWithinCurrentDoc(chunk.startLine, chunk.endLine, docLines)
    ) {
        invariantIds.push("review_chunk_line_range_within_current_doc");
    }

    const coversAllMemberHunks = chunk.hunkIds.every((hunkId) => {
        const hunk = hunkByIdKey.get(hunkId.key);
        if (!hunk) {
            return false;
        }
        if ((hunkInvariantIdsByKey[hunk.id.key] ?? []).length > 0) {
            return false;
        }
        return (
            hunk.visualStartLine >= chunk.startLine &&
            hunk.visualEndLine <= chunk.endLine
        );
    });
    if (!coversAllMemberHunks) {
        invariantIds.push("review_chunk_covers_hunk_lines");
    }

    return invariantIds;
}

function buildReviewProjectionDiagnostics(
    file: TrackedFile,
    hunks: ReviewHunk[],
    chunks: ReviewChunk[],
): ReviewProjectionDiagnostics {
    const totalLines = deriveCurrentDocLineCount(file.currentText);
    const hunkByIdKey = new Map(hunks.map((hunk) => [hunk.id.key, hunk]));
    const hunkInvariantIdsByKey: Record<string, ReviewProjectionInvariantId[]> =
        {};
    const chunkInvariantIdsByKey: Record<
        string,
        ReviewProjectionInvariantId[]
    > = {};
    const chunkRenderStateByKey: Record<string, ReviewChunkRenderState> = {};

    hunks.forEach((hunk) => {
        hunkInvariantIdsByKey[hunk.id.key] = getReviewHunkInvariantIds(
            hunk,
            totalLines,
        );
    });

    let invalidChunkCount = 0;
    let inlineSafeChunkCount = 0;
    let degradedChunkCount = 0;

    chunks.forEach((chunk) => {
        const chunkInvariantIds = getReviewChunkInvariantIds(
            chunk,
            hunkByIdKey,
            hunkInvariantIdsByKey,
            totalLines,
        );
        chunkInvariantIdsByKey[chunk.id.key] = chunkInvariantIds;

        const hasInvalidMembers = chunk.hunkIds.some(
            (hunkId) => (hunkInvariantIdsByKey[hunkId.key] ?? []).length > 0,
        );
        const renderState: ReviewChunkRenderState =
            chunkInvariantIds.length > 0 || hasInvalidMembers
                ? "invalid"
                : chunk.controlMode === "panel-only" ||
                    !chunk.canResolveInlineExactly
                  ? "degraded"
                  : "inline-safe";
        chunkRenderStateByKey[chunk.id.key] = renderState;

        if (renderState === "invalid") {
            invalidChunkCount += 1;
        } else if (renderState === "degraded") {
            degradedChunkCount += 1;
        } else {
            inlineSafeChunkCount += 1;
        }
    });

    const visibleChunkCount = chunks.length - invalidChunkCount;
    const status: ReviewProjectionStatus =
        chunks.length === 0 || invalidChunkCount === 0
            ? "projection_ready"
            : visibleChunkCount > 0
              ? "projection_partial"
              : "projection_invalid";

    return {
        metrics: {
            totalLines,
            hunkCount: hunks.length,
            chunkCount: chunks.length,
            visibleChunkCount,
            invalidChunkCount,
            inlineSafeChunkCount,
            degradedChunkCount,
            status,
        },
        hunkInvariantIdsByKey,
        chunkInvariantIdsByKey,
        chunkRenderStateByKey,
    };
}

export function buildReviewProjection(file: TrackedFile): ReviewProjection {
    const syncedFile = syncDerivedLinePatch(file);
    const cached = projectionCache.get(syncedFile);
    if (cached) {
        return cached;
    }

    const hunkSeeds = buildReviewHunkSeeds(syncedFile).sort(
        compareReviewHunkSeeds,
    );
    const chunkSeeds = buildReviewChunkSeeds(hunkSeeds);
    const chunkIdByHunkKey = new Map<string, ReviewChunkId>();
    const ambiguousChunkKeys = new Set<string>();
    const overlapGroupIdByHunkKey = new Map<string, string>();
    const overlapGroupSizeByHunkKey = new Map<string, number>();

    chunkSeeds.forEach((chunk) => {
        if (chunk.ambiguous) {
            ambiguousChunkKeys.add(chunk.id.key);
        }
        chunk.hunkIds.forEach((hunkId) => {
            chunkIdByHunkKey.set(hunkId.key, chunk.id);
            overlapGroupIdByHunkKey.set(
                hunkId.key,
                chunk.overlapGroupByHunkKey[hunkId.key] ?? chunk.id.key,
            );
            overlapGroupSizeByHunkKey.set(
                hunkId.key,
                chunk.overlapGroupSizeByHunkKey[hunkId.key] ?? 1,
            );
        });
    });

    const hunks: ReviewHunk[] = hunkSeeds.map((seed) => {
        const chunkId = chunkIdByHunkKey.get(seed.id.key);
        if (!chunkId) {
            throw new Error(
                `Missing ReviewChunk for ReviewHunk ${seed.id.key}`,
            );
        }

        return {
            id: seed.id,
            identityKey: seed.identityKey,
            trackedVersion: seed.trackedVersion,
            oldStartLine: seed.oldStartLine,
            oldEndLine: seed.oldEndLine,
            newStartLine: seed.newStartLine,
            newEndLine: seed.newEndLine,
            visualStartLine: seed.visualStartLine,
            visualEndLine: seed.visualEndLine,
            baseFrom: seed.baseFrom,
            baseTo: seed.baseTo,
            currentFrom: seed.currentFrom,
            currentTo: seed.currentTo,
            memberSpans: seed.memberSpans,
            chunkId,
            overlapGroupId:
                overlapGroupIdByHunkKey.get(seed.id.key) ?? chunkId.key,
            overlapGroupSize: overlapGroupSizeByHunkKey.get(seed.id.key) ?? 1,
            hasConflict: seed.hasConflict,
            ambiguous: ambiguousChunkKeys.has(chunkId.key),
        };
    });

    const chunks: ReviewChunk[] = chunkSeeds.map((chunk) => ({
        id: chunk.id,
        identityKey: chunk.identityKey,
        trackedVersion: chunk.trackedVersion,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        hunkIds: chunk.hunkIds,
        overlapGroupIds: chunk.overlapGroupIds,
        multiHunk: chunk.multiHunk,
        hasConflict: chunk.hasConflict,
        ambiguous: chunk.ambiguous,
        controlMode: chunk.controlMode,
        canResolveInlineExactly: chunk.canResolveInlineExactly,
    }));

    const projection: ReviewProjection = {
        trackedVersion: syncedFile.version,
        hunks,
        chunks,
        diagnostics: buildReviewProjectionDiagnostics(
            syncedFile,
            hunks,
            chunks,
        ),
    };

    projectionCache.set(syncedFile, projection);
    if (syncedFile !== file) {
        projectionCache.set(file, projection);
    }

    return projection;
}

export function buildReviewHunks(file: TrackedFile): ReviewHunk[] {
    return buildReviewProjection(file).hunks;
}

export function buildReviewChunks(file: TrackedFile): ReviewChunk[] {
    return buildReviewProjection(file).chunks;
}

export function summarizeReviewProjectionInlineState(
    projection: ReviewProjection | null | undefined,
): ReviewProjectionInlineState {
    if (!projection) {
        return {
            projectionState: "projection_invalid",
            reviewProjectionReady: false,
            hasAmbiguousChunks: false,
            hasConflicts: false,
            hasMultiHunkChunks: false,
            ...EMPTY_PROJECTION_METRICS,
        };
    }

    const { metrics } = projection.diagnostics;
    return {
        projectionState: metrics.status,
        reviewProjectionReady: metrics.visibleChunkCount > 0,
        hasAmbiguousChunks: projection.chunks.some((chunk) => chunk.ambiguous),
        hasConflicts: projection.chunks.some((chunk) => chunk.hasConflict),
        hasMultiHunkChunks: projection.chunks.some((chunk) => chunk.multiHunk),
        ...metrics,
    };
}

export function getReviewHunkById(
    source: ReviewProjection | readonly ReviewHunk[],
    id: ReviewHunkId,
): ReviewHunk | undefined {
    const hunks: readonly ReviewHunk[] =
        "hunks" in source ? source.hunks : source;
    return hunks.find((hunk) => reviewHunkIdEquals(hunk.id, id));
}

export function getReviewChunkById(
    source: ReviewProjection | readonly ReviewChunk[],
    id: ReviewChunkId,
): ReviewChunk | undefined {
    const chunks: readonly ReviewChunk[] =
        "chunks" in source ? source.chunks : source;
    return chunks.find((chunk) => reviewChunkIdEquals(chunk.id, id));
}

export function getReviewChunkRenderState(
    projection: ReviewProjection,
    chunkId: ReviewChunkId,
): ReviewChunkRenderState {
    return (
        projection.diagnostics.chunkRenderStateByKey[chunkId.key] ?? "invalid"
    );
}

export function getRenderableReviewChunks(
    projection: ReviewProjection,
): ReviewChunk[] {
    return projection.chunks.filter(
        (chunk) =>
            getReviewChunkRenderState(projection, chunk.id) !== "invalid",
    );
}

export function getRenderableReviewHunks(
    projection: ReviewProjection,
): ReviewHunk[] {
    const renderableChunkKeys = new Set(
        getRenderableReviewChunks(projection).map((chunk) => chunk.id.key),
    );
    return projection.hunks.filter((hunk) =>
        renderableChunkKeys.has(hunk.chunkId.key),
    );
}

export function getReviewHunksForChunk(
    projection: ReviewProjection,
    chunkId: ReviewChunkId,
): ReviewHunk[] {
    return projection.hunks.filter((hunk) =>
        reviewChunkIdEquals(hunk.chunkId, chunkId),
    );
}

export function expandReviewHunksToOverlapClosure(
    projection: ReviewProjection,
    selectedHunks: readonly ReviewHunk[],
): ReviewHunk[] {
    if (selectedHunks.length === 0) {
        return [];
    }

    const selectedOverlapGroupIds = new Set(
        selectedHunks.map((hunk) => hunk.overlapGroupId),
    );
    const expanded = projection.hunks.filter((hunk) =>
        selectedOverlapGroupIds.has(hunk.overlapGroupId),
    );

    if (expanded.length === 0) {
        return [...selectedHunks];
    }

    return expanded;
}

export function reviewProjectionMatchesSpans(
    file: TrackedFile,
    projection: ReviewProjection = buildReviewProjection(file),
): boolean {
    const spans = [
        ...(syncDerivedLinePatch(file).unreviewedRanges?.spans ?? []),
    ].sort(compareCanonicalSpans);
    const projectionSpans = projection.hunks
        .flatMap((hunk) =>
            hunk.memberSpans.map((span) => ({
                baseFrom: span.baseFrom,
                baseTo: span.baseTo,
                currentFrom: span.currentFrom,
                currentTo: span.currentTo,
            })),
        )
        .sort(compareCanonicalSpans);

    if (projection.trackedVersion !== file.version) {
        return false;
    }

    if (projectionSpans.length !== spans.length) {
        return false;
    }

    return projectionSpans.every((span, index) => {
        const current = spans[index];
        return (
            !!current &&
            current.baseFrom === span.baseFrom &&
            current.baseTo === span.baseTo &&
            current.currentFrom === span.currentFrom &&
            current.currentTo === span.currentTo
        );
    });
}

export function reviewHunkIdsStableWithinVersion(
    file: TrackedFile,
    projection: ReviewProjection = buildReviewProjection(file),
): boolean {
    if (projection.trackedVersion !== file.version) {
        return false;
    }

    const rebuilt = buildReviewProjection({
        ...file,
        unreviewedEdits: file.unreviewedEdits,
    });

    if (rebuilt.trackedVersion !== projection.trackedVersion) {
        return false;
    }

    if (rebuilt.hunks.length !== projection.hunks.length) {
        return false;
    }

    return rebuilt.hunks.every((hunk, index) =>
        reviewHunkIdEquals(hunk.id, projection.hunks[index]!.id),
    );
}

export function validateReviewProjection(
    file: TrackedFile,
    projection: ReviewProjection = buildReviewProjection(file),
): ReviewProjectionInvariantViolation[] {
    const violations: ReviewProjectionInvariantViolation[] = [];

    if (!reviewProjectionMatchesSpans(file, projection)) {
        violations.push({
            id: "review_projection_matches_spans",
            message:
                "ReviewProjection no longer matches the canonical pending spans for this TrackedFile.",
            subject: "projection",
        });
    }

    if (!reviewHunkIdsStableWithinVersion(file, projection)) {
        violations.push({
            id: "review_hunk_ids_stable_within_version",
            message:
                "ReviewHunk ids are not stable for the current trackedVersion.",
            subject: "projection",
        });
    }

    if (!reviewProjectionWithinCurrentDoc(file, projection)) {
        violations.push({
            id: "review_projection_within_current_doc",
            message:
                "ReviewProjection contains hunks or chunks outside the current document line range.",
            subject: "projection",
        });
    }

    Object.entries(projection.diagnostics.hunkInvariantIdsByKey).forEach(
        ([hunkKey, invariantIds]) => {
            invariantIds.forEach((id) => {
                violations.push({
                    id,
                    message: getReviewProjectionInvariantMessage(id, "hunk"),
                    subject: "hunk",
                    entityKey: hunkKey,
                });
            });
        },
    );

    Object.entries(projection.diagnostics.chunkInvariantIdsByKey).forEach(
        ([chunkKey, invariantIds]) => {
            invariantIds.forEach((id) => {
                violations.push({
                    id,
                    message: getReviewProjectionInvariantMessage(id, "chunk"),
                    subject: "chunk",
                    entityKey: chunkKey,
                });
            });
        },
    );

    return violations;
}

function reviewProjectionWithinCurrentDoc(
    file: TrackedFile,
    projection: ReviewProjection,
): boolean {
    const docLines = deriveCurrentDocLineCount(file.currentText);

    const hunksWithinBounds = projection.hunks.every((hunk) =>
        isLineRangeWithinCurrentDoc(
            hunk.visualStartLine,
            hunk.visualEndLine,
            docLines,
        ),
    );
    if (!hunksWithinBounds) {
        return false;
    }

    return projection.chunks.every((chunk) =>
        isLineRangeWithinCurrentDoc(chunk.startLine, chunk.endLine, docLines),
    );
}

function getReviewProjectionInvariantMessage(
    id: ReviewProjectionInvariantId,
    subject: "projection" | "hunk" | "chunk",
): string {
    switch (id) {
        case "review_hunk_member_spans_non_empty":
            return "ReviewHunk must contain at least one member span.";
        case "review_hunk_line_range_ordered":
            return "ReviewHunk visual line range must be ordered and non-negative.";
        case "review_hunk_line_range_within_current_doc":
            return "ReviewHunk visual line range must stay within the current document.";
        case "review_chunk_hunk_ids_non_empty":
            return "ReviewChunk must reference at least one ReviewHunk.";
        case "review_chunk_line_range_ordered":
            return "ReviewChunk line range must be ordered and non-negative.";
        case "review_chunk_line_range_within_current_doc":
            return "ReviewChunk line range must stay within the current document.";
        case "review_chunk_covers_hunk_lines":
            return "ReviewChunk line range must cover every member ReviewHunk line range.";
        case "review_projection_matches_spans":
            return "ReviewProjection no longer matches the canonical pending spans for this TrackedFile.";
        case "review_hunk_ids_stable_within_version":
            return "ReviewHunk ids are not stable for the current trackedVersion.";
        case "review_projection_within_current_doc":
            return `ReviewProjection contains ${subject}s outside the current document line range.`;
        default:
            return "ReviewProjection invariant violation.";
    }
}
