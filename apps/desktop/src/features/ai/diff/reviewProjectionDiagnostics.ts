import { compareReviewSpans } from "./reviewProjectionIndex";
import type { TrackedFile } from "./actionLogTypes";
import { syncDerivedLinePatch } from "../store/actionLogModel";
import type {
    ReviewChunk,
    ReviewHunk,
    ReviewProjection,
} from "./reviewProjection";

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

type ReviewProjectionWithDiagnostics = ReviewProjection & {
    diagnostics: ReviewProjectionDiagnostics;
};

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

const reviewProjectionDiagnosticsCache = new WeakMap<
    ReviewProjection,
    ReviewProjectionDiagnostics
>();
const reviewProjectionDiagnosticsBuilderCache = new WeakMap<
    ReviewProjection,
    () => ReviewProjectionDiagnostics
>();

export function deriveCurrentDocLineCount(text: string): number {
    return text.length === 0 ? 1 : text.split("\n").length;
}

export function isLineRangeOrdered(
    startLine: number,
    endLine: number,
): boolean {
    return startLine >= 0 && endLine >= startLine;
}

export function isLineRangeWithinCurrentDoc(
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

export function buildReviewProjectionDiagnostics(
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

export function attachLazyReviewProjectionDiagnostics(
    projection: ReviewProjection,
    buildDiagnostics: () => ReviewProjectionDiagnostics,
): ReviewProjectionWithDiagnostics {
    reviewProjectionDiagnosticsBuilderCache.set(projection, buildDiagnostics);

    Object.defineProperty(projection, "diagnostics", {
        configurable: true,
        enumerable: true,
        get() {
            return getReviewProjectionDiagnostics(projection);
        },
    });

    return projection as ReviewProjectionWithDiagnostics;
}

export function getReviewProjectionDiagnostics(
    projection: ReviewProjection,
): ReviewProjectionDiagnostics {
    const cached = reviewProjectionDiagnosticsCache.get(projection);
    if (cached) {
        return cached;
    }

    const builder = reviewProjectionDiagnosticsBuilderCache.get(projection);
    if (!builder) {
        throw new Error("Missing ReviewProjection diagnostics builder.");
    }

    const diagnostics = builder();
    reviewProjectionDiagnosticsCache.set(projection, diagnostics);
    return diagnostics;
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

    const totalLines = projection.currentDocLineCount;
    const hunkInvariantCounts = new Map<string, number>();
    const hunkByIdKey = new Map(
        projection.hunks.map((hunk) => [hunk.id.key, hunk]),
    );

    projection.hunks.forEach((hunk) => {
        let invariantCount = 0;
        if (hunk.memberSpans.length === 0) {
            invariantCount += 1;
        }
        if (!isLineRangeOrdered(hunk.visualStartLine, hunk.visualEndLine)) {
            invariantCount += 1;
        } else if (
            !isLineRangeWithinCurrentDoc(
                hunk.visualStartLine,
                hunk.visualEndLine,
                totalLines,
            )
        ) {
            invariantCount += 1;
        }
        hunkInvariantCounts.set(hunk.id.key, invariantCount);
    });

    let invalidChunkCount = 0;
    let degradedChunkCount = 0;
    let inlineSafeChunkCount = 0;

    projection.chunks.forEach((chunk) => {
        let chunkInvalid = false;

        if (chunk.hunkIds.length === 0) {
            chunkInvalid = true;
        }

        if (!isLineRangeOrdered(chunk.startLine, chunk.endLine)) {
            chunkInvalid = true;
        } else if (
            !isLineRangeWithinCurrentDoc(
                chunk.startLine,
                chunk.endLine,
                totalLines,
            )
        ) {
            chunkInvalid = true;
        }

        const coversAllMemberHunks = chunk.hunkIds.every((hunkId) => {
            const hunk = hunkByIdKey.get(hunkId.key);
            if (!hunk) {
                return false;
            }
            if ((hunkInvariantCounts.get(hunk.id.key) ?? 0) > 0) {
                return false;
            }
            return (
                hunk.visualStartLine >= chunk.startLine &&
                hunk.visualEndLine <= chunk.endLine
            );
        });
        if (!coversAllMemberHunks) {
            chunkInvalid = true;
        }

        const hasInvalidMembers = chunk.hunkIds.some(
            (hunkId) => (hunkInvariantCounts.get(hunkId.key) ?? 0) > 0,
        );

        if (chunkInvalid || hasInvalidMembers) {
            invalidChunkCount += 1;
            return;
        }

        if (
            chunk.controlMode === "panel-only" ||
            !chunk.canResolveInlineExactly
        ) {
            degradedChunkCount += 1;
            return;
        }

        inlineSafeChunkCount += 1;
    });

    const visibleChunkCount = projection.chunks.length - invalidChunkCount;
    const status: ReviewProjectionStatus =
        projection.chunks.length === 0 || invalidChunkCount === 0
            ? "projection_ready"
            : visibleChunkCount > 0
              ? "projection_partial"
              : "projection_invalid";
    const metrics: ReviewProjectionMetrics = {
        totalLines,
        hunkCount: projection.hunks.length,
        chunkCount: projection.chunks.length,
        visibleChunkCount,
        invalidChunkCount,
        inlineSafeChunkCount,
        degradedChunkCount,
        status,
    };
    return {
        projectionState: metrics.status,
        reviewProjectionReady: metrics.visibleChunkCount > 0,
        hasAmbiguousChunks: projection.chunks.some((chunk) => chunk.ambiguous),
        hasConflicts: projection.chunks.some((chunk) => chunk.hasConflict),
        hasMultiHunkChunks: projection.chunks.some((chunk) => chunk.multiHunk),
        ...metrics,
    };
}

export function getReviewChunkRenderState(
    projection: ReviewProjection,
    chunkId: { key: string },
): ReviewChunkRenderState {
    return (
        getReviewProjectionDiagnostics(projection).chunkRenderStateByKey[
            chunkId.key
        ] ?? "invalid"
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

export function reviewProjectionMatchesSpans(
    file: TrackedFile,
    projection: ReviewProjection,
): boolean {
    const syncedFile = syncDerivedLinePatch(file);

    if (projection.trackedVersion !== syncedFile.version) {
        return false;
    }

    const spans = [...(syncedFile.unreviewedRanges?.spans ?? [])].sort(
        compareReviewSpans,
    );
    const projectionSpans = projection.hunks
        .flatMap((hunk) =>
            hunk.memberSpans.map((span) => ({
                baseFrom: span.baseFrom,
                baseTo: span.baseTo,
                currentFrom: span.currentFrom,
                currentTo: span.currentTo,
            })),
        )
        .sort(compareReviewSpans);

    if (projectionSpans.length !== spans.length) {
        return false;
    }

    return projectionSpans.every((span, indexPosition) => {
        const current = spans[indexPosition];
        return (
            !!current &&
            current.baseFrom === span.baseFrom &&
            current.baseTo === span.baseTo &&
            current.currentFrom === span.currentFrom &&
            current.currentTo === span.currentTo
        );
    });
}
