import { describe, expect, it } from "vitest";
import type { TrackedFile } from "./actionLogTypes";
import {
    buildReviewChunks,
    buildReviewHunks,
    buildReviewProjection,
    getReviewChunkById,
    getReviewHunkById,
    getReviewHunksForChunk,
    isReviewChunkMultiHunk,
    reviewHunkIdsStableWithinVersion,
    reviewProjectionMatchesSpans,
    summarizeReviewProjectionInlineState,
    validateReviewProjection,
} from "./reviewProjection";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
} from "../store/actionLogModel";

function createTrackedFile(
    diffBase: string,
    currentText: string,
    overrides: Partial<TrackedFile> = {},
): TrackedFile {
    return {
        identityKey: overrides.identityKey ?? "test.md",
        originPath: overrides.originPath ?? "test.md",
        path: overrides.path ?? "test.md",
        previousPath: overrides.previousPath ?? null,
        status: overrides.status ?? { kind: "modified" },
        reviewState: overrides.reviewState ?? "finalized",
        diffBase,
        currentText,
        unreviewedRanges:
            overrides.unreviewedRanges ??
            buildTextRangePatchFromTexts(diffBase, currentText),
        unreviewedEdits:
            overrides.unreviewedEdits ??
            buildPatchFromTexts(diffBase, currentText),
        version: overrides.version ?? 1,
        isText: overrides.isText ?? true,
        updatedAt: overrides.updatedAt ?? 1,
        conflictHash: overrides.conflictHash ?? null,
    };
}

describe("reviewProjection", () => {
    it("builds a single ReviewHunk for an isolated canonical span", () => {
        const file = createTrackedFile(
            "alpha\nbeta\ngamma",
            "alpha\nBETA\ngamma",
        );

        const hunks = buildReviewHunks(file);
        const chunks = buildReviewChunks(file);

        expect(hunks).toHaveLength(1);
        expect(chunks).toHaveLength(1);
        expect(hunks[0]).toMatchObject({
            trackedVersion: 1,
            oldStartLine: 1,
            oldEndLine: 2,
            newStartLine: 1,
            newEndLine: 2,
            baseFrom: file.unreviewedRanges!.spans[0]!.baseFrom,
            baseTo: file.unreviewedRanges!.spans[0]!.baseTo,
            currentFrom: file.unreviewedRanges!.spans[0]!.currentFrom,
            currentTo: file.unreviewedRanges!.spans[0]!.currentTo,
            ambiguous: false,
        });
        expect(hunks[0]!.memberSpans).toEqual([
            {
                spanIndex: 0,
                ...file.unreviewedRanges!.spans[0]!,
            },
        ]);
        expect(hunks[0]!.chunkId).toEqual(chunks[0]!.id);
        expect(chunks[0]!.controlMode).toBe("chunk");
        expect(chunks[0]!.canResolveInlineExactly).toBe(true);
    });

    it("groups nearby hunks into one ReviewChunk without collapsing their identities", () => {
        const file = createTrackedFile(
            "one\ntwo\nthree\nfour",
            "ONE\ntwo\nTHREE\nfour",
        );

        const projection = buildReviewProjection(file);

        expect(projection.hunks).toHaveLength(2);
        expect(projection.chunks).toHaveLength(1);
        expect(projection.chunks[0]!.hunkIds).toEqual([
            projection.hunks[0]!.id,
            projection.hunks[1]!.id,
        ]);
        expect(isReviewChunkMultiHunk(projection.chunks[0]!)).toBe(true);
        expect(projection.chunks[0]!.multiHunk).toBe(true);
        expect(projection.chunks[0]!.ambiguous).toBe(false);
        expect(projection.chunks[0]!.controlMode).toBe("hunk");
        expect(projection.chunks[0]!.canResolveInlineExactly).toBe(true);
    });

    it("marks a chunk as ambiguous when multiple hunks share the same visual line", () => {
        const file = createTrackedFile("foo bar baz", "FOO bar BAZ", {
            unreviewedRanges: {
                spans: [
                    {
                        baseFrom: 0,
                        baseTo: 3,
                        currentFrom: 0,
                        currentTo: 3,
                    },
                    {
                        baseFrom: 8,
                        baseTo: 11,
                        currentFrom: 8,
                        currentTo: 11,
                    },
                ],
            },
        });

        const projection = buildReviewProjection(file);
        const [chunk] = projection.chunks;

        expect(projection.hunks).toHaveLength(2);
        expect(chunk).toBeDefined();
        expect(chunk!.ambiguous).toBe(true);
        expect(chunk!.controlMode).toBe("panel-only");
        expect(chunk!.canResolveInlineExactly).toBe(false);
        expect(projection.hunks.every((hunk) => hunk.ambiguous)).toBe(true);
        expect(getReviewHunksForChunk(projection, chunk!.id)).toEqual(
            projection.hunks,
        );
    });

    it("changes Review ids when trackedVersion changes", () => {
        const base = "alpha\nbeta\ngamma";
        const current = "alpha\nBETA\ngamma";
        const first = createTrackedFile(base, current, { version: 1 });
        const second = createTrackedFile(base, current, { version: 2 });

        const firstProjection = buildReviewProjection(first);
        const secondProjection = buildReviewProjection(second);

        expect(firstProjection.hunks[0]!.id).not.toEqual(
            secondProjection.hunks[0]!.id,
        );
        expect(firstProjection.chunks[0]!.id).not.toEqual(
            secondProjection.chunks[0]!.id,
        );
    });

    it("exposes lookup helpers for hunks and chunks by stable id", () => {
        const file = createTrackedFile(
            "one\ntwo\nthree\nfour",
            "ONE\ntwo\nTHREE\nfour",
        );
        const projection = buildReviewProjection(file);
        const targetHunk = projection.hunks[1]!;
        const targetChunk = projection.chunks[0]!;

        expect(getReviewHunkById(projection, targetHunk.id)).toBe(targetHunk);
        expect(getReviewChunkById(projection, targetChunk.id)).toBe(
            targetChunk,
        );
    });

    it("propagates file conflict state into hunks and chunks", () => {
        const file = createTrackedFile("alpha\nbeta", "alpha\nBETA", {
            conflictHash: "conflict",
        });

        const projection = buildReviewProjection(file);

        expect(projection.hunks[0]!.hasConflict).toBe(true);
        expect(projection.chunks[0]!.hasConflict).toBe(true);
    });

    it("summarizes inline gating flags from the projection", () => {
        const file = createTrackedFile("foo bar baz", "FOO bar BAZ", {
            conflictHash: "conflict",
            unreviewedRanges: {
                spans: [
                    {
                        baseFrom: 0,
                        baseTo: 3,
                        currentFrom: 0,
                        currentTo: 3,
                    },
                    {
                        baseFrom: 8,
                        baseTo: 11,
                        currentFrom: 8,
                        currentTo: 11,
                    },
                ],
            },
        });

        expect(
            summarizeReviewProjectionInlineState(buildReviewProjection(file)),
        ).toEqual({
            reviewProjectionReady: true,
            hasAmbiguousChunks: true,
            hasConflicts: true,
            hasMultiHunkChunks: true,
        });
    });

    it("keeps review projection aligned with canonical spans", () => {
        const file = createTrackedFile("foo bar baz", "FOO bar BAZ", {
            unreviewedRanges: {
                spans: [
                    {
                        baseFrom: 0,
                        baseTo: 3,
                        currentFrom: 0,
                        currentTo: 3,
                    },
                    {
                        baseFrom: 8,
                        baseTo: 11,
                        currentFrom: 8,
                        currentTo: 11,
                    },
                ],
            },
        });
        const projection = buildReviewProjection(file);

        expect(reviewProjectionMatchesSpans(file, projection)).toBe(true);
        expect(validateReviewProjection(file, projection)).toEqual([]);
    });

    it("keeps ReviewHunk ids stable within one trackedVersion", () => {
        const file = createTrackedFile(
            "one\ntwo\nthree\nfour",
            "ONE\ntwo\nTHREE\nfour",
        );
        const projection = buildReviewProjection(file);

        expect(reviewHunkIdsStableWithinVersion(file, projection)).toBe(true);
        expect(validateReviewProjection(file, projection)).toEqual([]);
    });
});
