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

export interface ReviewProjection {
    trackedVersion: number;
    hunks: ReviewHunk[];
    chunks: ReviewChunk[];
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
    reviewProjectionReady: boolean;
    hasAmbiguousChunks: boolean;
    hasConflicts: boolean;
    hasMultiHunkChunks: boolean;
}

export type ReviewProjectionInvariantId =
    | "review_projection_matches_spans"
    | "review_hunk_ids_stable_within_version";

export interface ReviewProjectionInvariantViolation {
    id: ReviewProjectionInvariantId;
    message: string;
}

const projectionCache = new WeakMap<TrackedFile, ReviewProjection>();
const DEFAULT_CHUNK_LINE_GAP = 1;

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
        const visualStartLine = Math.min(
            lineRange.oldStartLine,
            lineRange.newStartLine,
        );
        const visualEndLine = Math.max(
            lineRange.oldEndLine,
            lineRange.newEndLine,
        );

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
            reviewProjectionReady: false,
            hasAmbiguousChunks: false,
            hasConflicts: false,
            hasMultiHunkChunks: false,
        };
    }

    return {
        reviewProjectionReady: true,
        hasAmbiguousChunks: projection.chunks.some((chunk) => chunk.ambiguous),
        hasConflicts: projection.chunks.some((chunk) => chunk.hasConflict),
        hasMultiHunkChunks: projection.chunks.some((chunk) => chunk.multiHunk),
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
        });
    }

    if (!reviewHunkIdsStableWithinVersion(file, projection)) {
        violations.push({
            id: "review_hunk_ids_stable_within_version",
            message:
                "ReviewHunk ids are not stable for the current trackedVersion.",
        });
    }

    return violations;
}
