import { describe, expect, it } from "vitest";
import type { TrackedFile } from "./actionLogTypes";
import {
  buildReviewChunks,
  buildReviewHunks,
  buildReviewProjection,
  canResolveReviewChunkInlineExactly,
  getReviewChunkControlMode,
  getReviewChunkById,
  getReviewHunkById,
  getReviewHunksForChunk,
  isReviewChunkMultiHunk,
} from "./reviewProjection";
import {
  getReviewProjectionDiagnostics,
  getReviewChunkRenderState,
  getRenderableReviewChunks,
  reviewProjectionMatchesSpans,
  summarizeReviewProjectionInlineState,
} from "./reviewProjectionDiagnostics";
import { expandReviewIndexHunksToOverlapClosure } from "./reviewProjectionIndex";
import {
  reviewHunkIdsStableWithinVersion,
  validateReviewProjection,
} from "./reviewProjectionValidation";
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
      overrides.unreviewedEdits ?? buildPatchFromTexts(diffBase, currentText),
    version: overrides.version ?? 1,
    isText: overrides.isText ?? true,
    updatedAt: overrides.updatedAt ?? 1,
    conflictHash: overrides.conflictHash ?? null,
  };
}

describe("reviewProjection", () => {
  function buildSameLineDisjointFile(changeCount: number) {
    const words = ["aa", "bb", "cc", "dd", "ee"].slice(0, changeCount);
    const diffBase = words.join(" ");
    const currentText = words.map((word) => word.toUpperCase()).join(" ");
    let offset = 0;
    const spans = words.map((word) => {
      const span = {
        baseFrom: offset,
        baseTo: offset + word.length,
        currentFrom: offset,
        currentTo: offset + word.length,
      };
      offset += word.length + 1;
      return span;
    });

    return createTrackedFile(diffBase, currentText, {
      unreviewedRanges: { spans },
    });
  }

  it("builds a single ReviewHunk for an isolated canonical span", () => {
    const file = createTrackedFile("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");

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

  it("keeps chunking and hunk order stable even if canonical spans arrive out of order", () => {
    const diffBase = "one\ntwo\nthree\nfour";
    const currentText = "ONE\ntwo\nTHREE\nfour";
    const orderedSpans = [
      {
        baseFrom: 0,
        baseTo: 3,
        currentFrom: 0,
        currentTo: 3,
      },
      {
        baseFrom: 8,
        baseTo: 13,
        currentFrom: 8,
        currentTo: 13,
      },
    ];
    const orderedFile = createTrackedFile(diffBase, currentText, {
      unreviewedRanges: { spans: orderedSpans },
    });
    const unorderedFile = createTrackedFile(diffBase, currentText, {
      unreviewedRanges: { spans: [orderedSpans[1]!, orderedSpans[0]!] },
    });

    const orderedProjection = buildReviewProjection(orderedFile);
    const unorderedProjection = buildReviewProjection(unorderedFile);

    expect(unorderedProjection.hunks.map((hunk) => hunk.id.key)).toEqual(
      orderedProjection.hunks.map((hunk) => hunk.id.key),
    );
    expect(
      unorderedProjection.hunks.map((hunk) => hunk.visualStartLine),
    ).toEqual(orderedProjection.hunks.map((hunk) => hunk.visualStartLine));
    expect(
      unorderedProjection.chunks.map((chunk) => ({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        hunkKeys: chunk.hunkIds.map((id) => id.key),
      })),
    ).toEqual(
      orderedProjection.chunks.map((chunk) => ({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        hunkKeys: chunk.hunkIds.map((id) => id.key),
      })),
    );
    expect(
      reviewProjectionMatchesSpans(unorderedFile, unorderedProjection),
    ).toBe(true);
  });

  it.each([2, 3, 4, 5])(
    "keeps %i disjoint hunks on the same visual line inline-resolvable",
    (changeCount) => {
      const file = buildSameLineDisjointFile(changeCount);
      const projection = buildReviewProjection(file);
      const [chunk] = projection.chunks;

      expect(projection.hunks).toHaveLength(changeCount);
      expect(chunk).toBeDefined();
      expect(chunk!.multiHunk).toBe(changeCount > 1);
      expect(chunk!.ambiguous).toBe(false);
      expect(chunk!.controlMode).toBe(changeCount > 1 ? "hunk" : "chunk");
      expect(chunk!.canResolveInlineExactly).toBe(true);
      expect(projection.hunks.every((hunk) => hunk.ambiguous)).toBe(false);
      expect(getReviewHunksForChunk(projection, chunk!.id)).toEqual(
        projection.hunks,
      );
    },
  );

  it("uses inline-overlap mode for ambiguous chunks and expands overlap closures", () => {
    expect(
      getReviewChunkControlMode({
        ambiguous: true,
        hasConflict: false,
        multiHunk: true,
      }),
    ).toBe("inline-overlap");
    expect(
      canResolveReviewChunkInlineExactly({
        ambiguous: true,
        hasConflict: false,
        multiHunk: true,
      }),
    ).toBe(true);

    const chunkId = { trackedVersion: 1, key: "chunk-1" };
    const overlapGroupId = "chunk-1::hunk-1|hunk-2";
    const projection = {
      trackedVersion: 1,
      chunks: [
        {
          id: chunkId,
          identityKey: "test.md",
          trackedVersion: 1,
          startLine: 0,
          endLine: 1,
          hunkIds: [
            { trackedVersion: 1, key: "hunk-1" },
            { trackedVersion: 1, key: "hunk-2" },
          ],
          overlapGroupIds: [overlapGroupId],
          multiHunk: true,
          hasConflict: false,
          ambiguous: true,
          controlMode: "inline-overlap" as const,
          canResolveInlineExactly: true,
        },
      ],
      hunks: [
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
          baseFrom: 2,
          baseTo: 5,
          currentFrom: 2,
          currentTo: 5,
          memberSpans: [
            {
              spanIndex: 1,
              baseFrom: 2,
              baseTo: 5,
              currentFrom: 2,
              currentTo: 5,
            },
          ],
          chunkId,
          overlapGroupId,
          overlapGroupSize: 2,
          hasConflict: false,
          ambiguous: true,
        },
      ],
      diagnostics: {
        metrics: {
          totalLines: 0,
          hunkCount: 2,
          chunkCount: 1,
          visibleChunkCount: 1,
          invalidChunkCount: 0,
          inlineSafeChunkCount: 0,
          degradedChunkCount: 0,
          status: "projection_ready" as const,
        },
        hunkInvariantIdsByKey: {},
        chunkInvariantIdsByKey: {},
        chunkRenderStateByKey: {},
      },
    };

    const closure = expandReviewIndexHunksToOverlapClosure(projection, [
      projection.hunks[0]!,
    ]);
    expect(closure).toHaveLength(2);
    expect(closure).toEqual(projection.hunks);
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
    expect(getReviewChunkById(projection, targetChunk.id)).toBe(targetChunk);
  });

  it("propagates file conflict state into hunks and chunks", () => {
    const file = createTrackedFile("alpha\nbeta", "alpha\nBETA", {
      conflictHash: "conflict",
    });

    const projection = buildReviewProjection(file);

    expect(projection.hunks[0]!.hasConflict).toBe(true);
    expect(projection.chunks[0]!.hasConflict).toBe(true);
  });

  it("marks conflicting chunks as degraded while keeping them renderable", () => {
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

    const projection = buildReviewProjection(file);

    expect(
      getReviewChunkRenderState(projection, projection.chunks[0]!.id),
    ).toBe("degraded");
    expect(getRenderableReviewChunks(projection)).toEqual(projection.chunks);
    expect(projection.diagnostics.metrics.degradedChunkCount).toBe(1);
    expect(projection.diagnostics.metrics.invalidChunkCount).toBe(0);
  });

  it("computes projection diagnostics lazily and caches them once accessed", () => {
    const file = createTrackedFile("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");

    const projection = buildReviewProjection(file);
    const diagnosticsDescriptor = Object.getOwnPropertyDescriptor(
      projection,
      "diagnostics",
    );

    expect(diagnosticsDescriptor?.get).toBeTypeOf("function");

    const firstDiagnostics = getReviewProjectionDiagnostics(projection);
    const secondDiagnostics = getReviewProjectionDiagnostics(projection);

    expect(firstDiagnostics).toBe(secondDiagnostics);
    expect(projection.diagnostics).toBe(firstDiagnostics);
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
    ).toMatchObject({
      projectionState: "projection_ready",
      reviewProjectionReady: true,
      hasAmbiguousChunks: false,
      hasConflicts: true,
      hasMultiHunkChunks: true,
      totalLines: 1,
      hunkCount: 2,
      chunkCount: 1,
      visibleChunkCount: 1,
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

  it("validates against synced canonical spans even when derived ranges are stale", () => {
    const file = createTrackedFile("foo bar baz", "FOO bar BAZ", {
      unreviewedRanges: {
        spans: [
          {
            baseFrom: 0,
            baseTo: 3,
            currentFrom: 0,
            currentTo: 3,
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

  it("keeps EOF deletions anchored within the current document", () => {
    const file = createTrackedFile("one\ntwo\nthree\nfour", "one\ntwo\n");

    const projection = buildReviewProjection(file);

    expect(projection.hunks).toHaveLength(1);
    expect(projection.chunks).toHaveLength(1);
    expect(projection.hunks[0]!.visualStartLine).toBeLessThanOrEqual(3);
    expect(projection.hunks[0]!.visualEndLine).toBeLessThanOrEqual(3);
    expect(projection.chunks[0]!.startLine).toBeLessThanOrEqual(3);
    expect(projection.chunks[0]!.endLine).toBeLessThanOrEqual(3);
    expect(validateReviewProjection(file, projection)).toEqual([]);
  });

  it("keeps EOF deletions anchored when the current file has no trailing newline", () => {
    const file = createTrackedFile("one\ntwo\nthree", "one\ntwo");

    const projection = buildReviewProjection(file);

    expect(projection.hunks).toHaveLength(1);
    expect(projection.chunks).toHaveLength(1);
    expect(projection.hunks[0]!.visualStartLine).toBe(1);
    expect(projection.hunks[0]!.visualEndLine).toBe(1);
    expect(projection.chunks[0]!.startLine).toBe(1);
    expect(projection.chunks[0]!.endLine).toBe(1);
    expect(validateReviewProjection(file, projection)).toEqual([]);
  });
});
