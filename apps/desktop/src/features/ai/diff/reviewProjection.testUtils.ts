import type { TrackedFile } from "./actionLogTypes";
import { reviewHunkIdEquals } from "./reviewProjectionIndex";
import {
    buildReviewProjection,
    type ReviewProjection,
} from "./reviewProjection";
import {
    deriveCurrentDocLineCount,
    getReviewProjectionDiagnostics,
    isLineRangeWithinCurrentDoc,
    reviewProjectionMatchesSpans,
    type ReviewProjectionInvariantId,
} from "./reviewProjectionDiagnostics";

// Test-only invariant checks for review projection behavior.
export interface ReviewProjectionInvariantViolation {
    id: ReviewProjectionInvariantId;
    message: string;
    subject: "projection" | "hunk" | "chunk";
    entityKey?: string;
}

export function reviewHunkIdsStableWithinVersion(
    file: TrackedFile,
    projection: ReviewProjection,
): boolean {
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

    return rebuilt.hunks.every((hunk, indexPosition) =>
        reviewHunkIdEquals(hunk.id, projection.hunks[indexPosition]!.id),
    );
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

export function validateReviewProjection(
    file: TrackedFile,
    projection: ReviewProjection,
): ReviewProjectionInvariantViolation[] {
    const violations: ReviewProjectionInvariantViolation[] = [];
    const diagnostics = getReviewProjectionDiagnostics(projection);

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

    Object.entries(diagnostics.hunkInvariantIdsByKey).forEach(
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

    Object.entries(diagnostics.chunkInvariantIdsByKey).forEach(
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
