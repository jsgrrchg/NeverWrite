import type { TrackedFile } from "./actionLogTypes";
import {
    buildReviewProjectionIndex,
    reviewChunkIdEquals as reviewChunkIdEqualsIndex,
    reviewHunkIdEquals,
    type ReviewChunkId,
    type ReviewHunkId,
    type ReviewProjectionIndexChunk,
    type ReviewProjectionIndexHunk,
} from "./reviewProjectionIndex";
import {
    attachLazyReviewProjectionDiagnostics,
    buildReviewProjectionDiagnostics,
    deriveCurrentDocLineCount,
    type ReviewProjectionDiagnostics,
} from "./reviewProjectionDiagnostics";

export type {
    ReviewChunkId,
    ReviewHunkId,
    ReviewHunkMemberSpan,
} from "./reviewProjectionIndex";
export type {
    ReviewChunkRenderState,
    ReviewProjectionInlineState,
    ReviewProjectionInvariantId,
    ReviewProjectionMetrics,
    ReviewProjectionStatus,
} from "./reviewProjectionDiagnostics";

export interface ReviewProjection {
    trackedVersion: number;
    currentDocLineCount: number;
    hunks: ReviewHunk[];
    chunks: ReviewChunk[];
    diagnostics: ReviewProjectionDiagnostics;
}

export type ReviewChunkControlMode =
    | "chunk"
    | "hunk"
    | "inline-overlap"
    | "panel-only";

export interface ReviewHunk extends ReviewProjectionIndexHunk {
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

const projectionCache = new WeakMap<TrackedFile, ReviewProjection>();

function toReviewChunk(chunk: ReviewProjectionIndexChunk): ReviewChunk {
    const controlMode = getReviewChunkControlMode(chunk);
    return {
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
        controlMode,
        canResolveInlineExactly: canResolveReviewChunkInlineExactly(chunk),
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

export function reviewChunkIdEquals(
    left: ReviewChunkId,
    right: ReviewChunkId,
): boolean {
    return reviewChunkIdEqualsIndex(left, right);
}

export function buildReviewProjection(file: TrackedFile): ReviewProjection {
    const index = buildReviewProjectionIndex(file);
    const cached = projectionCache.get(index.trackedFile);
    if (cached) {
        return cached;
    }

    const ambiguousChunkKeys = new Set(
        index.chunks
            .filter((chunk) => chunk.ambiguous)
            .map((chunk) => chunk.id.key),
    );
    const hunks: ReviewHunk[] = index.hunks.map((hunk) => ({
        ...hunk,
        ambiguous: ambiguousChunkKeys.has(hunk.chunkId.key),
    }));
    const chunks = index.chunks.map(toReviewChunk);

    const projection = attachLazyReviewProjectionDiagnostics(
        {
            trackedVersion: index.trackedVersion,
            currentDocLineCount: deriveCurrentDocLineCount(
                index.trackedFile.currentText,
            ),
            hunks,
            chunks,
        } as ReviewProjection,
        () =>
            buildReviewProjectionDiagnostics(index.trackedFile, hunks, chunks),
    );

    projectionCache.set(index.trackedFile, projection);
    if (index.trackedFile !== file) {
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
    return chunks.find((chunk) => reviewChunkIdEqualsIndex(chunk.id, id));
}

export function getReviewHunksForChunk(
    projection: ReviewProjection,
    chunkId: ReviewChunkId,
): ReviewHunk[] {
    return projection.hunks.filter((hunk) =>
        reviewChunkIdEqualsIndex(hunk.chunkId, chunkId),
    );
}

export function isReviewChunkMultiHunk(chunk: ReviewChunk): boolean {
    return chunk.hunkIds.length > 1;
}
