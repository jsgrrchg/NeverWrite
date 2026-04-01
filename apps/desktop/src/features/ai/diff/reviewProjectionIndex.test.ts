import { describe, expect, it } from "vitest";
import type { TrackedFile } from "./actionLogTypes";
import type { ReviewHunk, ReviewProjection } from "./reviewProjection";
import {
    buildReviewProjectionIndex,
    expandReviewHunkIdsToOverlapClosure,
    getReviewIndexHunk,
    resolveReviewHunkIdsToExactSpans,
    type ReviewProjectionIndexChunk,
    type ReviewProjectionIndex,
} from "./reviewProjectionIndex";
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

function createSyntheticIndex(
    projection: ReviewProjection,
): ReviewProjectionIndex {
    const chunks: ReviewProjectionIndexChunk[] = projection.chunks.map(
        (chunk) => ({
            id: chunk.id,
            identityKey: chunk.identityKey,
            trackedVersion: chunk.trackedVersion,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            hunkIds: chunk.hunkIds,
            overlapGroupIds: chunk.overlapGroupIds,
            overlapGroupByHunkKey: Object.fromEntries(
                projection.hunks.map((hunk) => [
                    hunk.id.key,
                    hunk.overlapGroupId,
                ]),
            ),
            overlapGroupSizeByHunkKey: Object.fromEntries(
                projection.hunks.map((hunk) => [
                    hunk.id.key,
                    hunk.overlapGroupSize,
                ]),
            ),
            multiHunk: chunk.multiHunk,
            hasConflict: chunk.hasConflict,
            ambiguous: chunk.ambiguous,
        }),
    );
    return {
        trackedVersion: projection.trackedVersion,
        trackedFile: createTrackedFile("", "", {
            version: projection.trackedVersion,
        }),
        hunks: projection.hunks,
        chunks,
        hunkByIdKey: new Map(
            projection.hunks.map((hunk) => [hunk.id.key, hunk]),
        ),
        chunkByIdKey: new Map(chunks.map((chunk) => [chunk.id.key, chunk])),
    };
}

describe("reviewProjectionIndex", () => {
    it("indexes stable hunk lookups for inline-resolvable multi-hunk chunks", () => {
        const file = createTrackedFile(
            "one\ntwo\nthree\nfour",
            "ONE\ntwo\nTHREE\nfour",
        );

        const index = buildReviewProjectionIndex(file);

        expect(index.trackedVersion).toBe(1);
        expect(index.hunks).toHaveLength(2);
        expect(index.chunks).toHaveLength(1);
        expect(getReviewIndexHunk(index, index.hunks[0]!.id)).toBe(
            index.hunks[0],
        );
        expect(index.chunks[0]!.hunkIds).toEqual(
            index.hunks.map((hunk) => hunk.id),
        );
    });

    it("resolves exact spans by hunk id without absorbing a same-line neighbor", () => {
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

        const index = buildReviewProjectionIndex(file);
        const [firstHunk] = index.hunks;

        expect(index.chunks).toHaveLength(1);
        expect(
            resolveReviewHunkIdsToExactSpans(index, [firstHunk!.id]),
        ).toEqual([
            {
                baseFrom: 0,
                baseTo: 3,
                currentFrom: 0,
                currentTo: 3,
            },
        ]);
    });

    it("expands overlap closure by hunk id using the canonical overlap groups", () => {
        const chunkId = { trackedVersion: 1, key: "chunk-1" };
        const overlapGroupId = "chunk-1::hunk-1|hunk-2";
        const hunks: ReviewHunk[] = [
            {
                id: { trackedVersion: 1, key: "hunk-1" },
                identityKey: "test.md",
                trackedVersion: 1,
                oldStartLine: 0,
                oldEndLine: 1,
                newStartLine: 0,
                newEndLine: 1,
                visualStartLine: 0,
                visualEndLine: 1,
                baseFrom: 0,
                baseTo: 3,
                currentFrom: 0,
                currentTo: 3,
                memberSpans: [
                    {
                        spanIndex: 0,
                        baseFrom: 0,
                        baseTo: 3,
                        currentFrom: 0,
                        currentTo: 3,
                    },
                ],
                chunkId,
                overlapGroupId,
                overlapGroupSize: 2,
                hasConflict: false,
                ambiguous: true,
            },
            {
                id: { trackedVersion: 1, key: "hunk-2" },
                identityKey: "test.md",
                trackedVersion: 1,
                oldStartLine: 0,
                oldEndLine: 1,
                newStartLine: 0,
                newEndLine: 1,
                visualStartLine: 0,
                visualEndLine: 1,
                baseFrom: 4,
                baseTo: 7,
                currentFrom: 4,
                currentTo: 7,
                memberSpans: [
                    {
                        spanIndex: 1,
                        baseFrom: 4,
                        baseTo: 7,
                        currentFrom: 4,
                        currentTo: 7,
                    },
                ],
                chunkId,
                overlapGroupId,
                overlapGroupSize: 2,
                hasConflict: false,
                ambiguous: true,
            },
        ];
        const chunks = [
            {
                id: chunkId,
                identityKey: "test.md",
                trackedVersion: 1,
                startLine: 0,
                endLine: 1,
                hunkIds: hunks.map((hunk) => hunk.id),
                overlapGroupIds: [overlapGroupId],
                multiHunk: true,
                hasConflict: false,
                ambiguous: true,
                controlMode: "inline-overlap" as const,
                canResolveInlineExactly: true,
            },
        ];
        const index = createSyntheticIndex({
            trackedVersion: 1,
            currentDocLineCount: 1,
            hunks,
            chunks,
            diagnostics: {
                metrics: {
                    totalLines: 1,
                    hunkCount: 2,
                    chunkCount: 1,
                    visibleChunkCount: 1,
                    invalidChunkCount: 0,
                    inlineSafeChunkCount: 1,
                    degradedChunkCount: 0,
                    status: "projection_ready",
                },
                hunkInvariantIdsByKey: {},
                chunkInvariantIdsByKey: {},
                chunkRenderStateByKey: {},
            },
        });

        expect(
            expandReviewHunkIdsToOverlapClosure(index, [hunks[0]!.id]),
        ).toEqual(hunks.map((hunk) => hunk.id));
    });
});
