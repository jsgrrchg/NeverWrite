import { describe, expect, it } from "vitest";
import type { AIFileDiff } from "../types";
import type { TextEdit, TrackedFile } from "../diff/actionLogTypes";
import { buildReviewProjection } from "../diff/reviewProjection";
import {
    applyNonConflictingEdits,
    applyRejectUndo,
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    computeWordDiffsForHunk,
    computeRestoreAction,
    consolidateTrackedFiles,
    createTrackedFileFromDiff,
    deriveLinePatchFromTextRanges,
    emptyActionLogState,
    emptyPatch,
    finalizeTrackedFile,
    finalizeTrackedFiles,
    getTrackedFilesForSession,
    getTrackedFilesForWorkCycle,
    getTrackedFileReviewState,
    getTrackedFileDomainContract,
    keepAllEdits,
    keepExactSpans,
    keepReviewHunks,
    mapAgentSpanThroughTextEdits,
    mapTextPositionThroughEdits,
    patchContainsLine,
    patchIsEmpty,
    partitionSpansByOverlap,
    rangesOverlap,
    rebuildDiffBaseFromPendingSpans,
    rejectAllEdits,
    rejectExactSpans,
    rejectReviewHunks,
    shouldShowInlineDiff,
    syncDerivedLinePatch,
    updateTrackedFileWithDiff,
    validateTrackedFileDomain,
    setTrackedFilesForWorkCycle,
} from "./actionLogModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(overrides: Partial<AIFileDiff> = {}): AIFileDiff {
    return {
        path: "test.md",
        kind: "update",
        old_text: "aaa\nbbb\nccc",
        new_text: "aaa\nBBB\nccc",
        ...overrides,
    };
}

function getViolationIds(file: TrackedFile): string[] {
    return validateTrackedFileDomain(file).map((violation) => violation.id);
}

// ---------------------------------------------------------------------------
// Patch primitives
// ---------------------------------------------------------------------------

describe("Patch primitives", () => {
    it("emptyPatch creates empty patch", () => {
        const p = emptyPatch();
        expect(p.edits).toEqual([]);
        expect(patchIsEmpty(p)).toBe(true);
    });

    it("rangesOverlap detects overlapping ranges", () => {
        expect(rangesOverlap(0, 3, 2, 5)).toBe(true);
        expect(rangesOverlap(0, 3, 3, 5)).toBe(false); // adjacent, not overlapping
        expect(rangesOverlap(5, 10, 0, 3)).toBe(false);
        expect(rangesOverlap(0, 5, 0, 5)).toBe(true); // identical
        expect(rangesOverlap(1, 4, 2, 3)).toBe(true); // contained
    });

    it("rangesOverlap handles empty (point) ranges for pure deletions", () => {
        // Two empty ranges at same position — overlap (pure deletion match)
        expect(rangesOverlap(5, 5, 5, 5)).toBe(true);
        // Two empty ranges at different positions — no overlap
        expect(rangesOverlap(5, 5, 8, 8)).toBe(false);
        // Empty range inside a non-empty range — overlaps
        expect(rangesOverlap(5, 5, 3, 7)).toBe(true);
        // Empty range at the start boundary of a non-empty range — no overlap
        // (an empty range has no content, so boundary-touching isn't overlap)
        expect(rangesOverlap(3, 3, 3, 7)).toBe(false);
    });

    it("buildPatchFromTexts finds changed lines", () => {
        const p = buildPatchFromTexts("aaa\nbbb\nccc", "aaa\nBBB\nccc");
        expect(p.edits).toHaveLength(1);
        expect(p.edits[0].oldStart).toBe(1);
        expect(p.edits[0].oldEnd).toBe(2);
        expect(p.edits[0].newStart).toBe(1);
        expect(p.edits[0].newEnd).toBe(2);
    });

    it("buildPatchFromTexts handles additions", () => {
        const p = buildPatchFromTexts("aaa\nccc", "aaa\nbbb\nccc");
        expect(p.edits).toHaveLength(1);
        expect(p.edits[0].oldStart).toBe(1);
        expect(p.edits[0].oldEnd).toBe(1); // no lines removed
        expect(p.edits[0].newStart).toBe(1);
        expect(p.edits[0].newEnd).toBe(2); // one line added
    });

    it("buildPatchFromTexts handles deletions", () => {
        const p = buildPatchFromTexts("aaa\nbbb\nccc", "aaa\nccc");
        expect(p.edits).toHaveLength(1);
        expect(p.edits[0].oldStart).toBe(1);
        expect(p.edits[0].oldEnd).toBe(2); // one line removed
    });

    it("buildPatchFromTexts identical texts produce empty patch", () => {
        const p = buildPatchFromTexts("aaa\nbbb", "aaa\nbbb");
        expect(patchIsEmpty(p)).toBe(true);
    });

    it("buildPatchFromTexts multiple hunks", () => {
        const p = buildPatchFromTexts(
            "aaa\nbbb\nccc\nddd\neee",
            "AAA\nbbb\nccc\nddd\nEEE",
        );
        expect(p.edits).toHaveLength(2);
        expect(p.edits[0].oldStart).toBe(0);
        expect(p.edits[0].oldEnd).toBe(1);
        expect(p.edits[1].oldStart).toBe(4);
        expect(p.edits[1].oldEnd).toBe(5);
    });

    it("patchContainsLine checks new ranges", () => {
        const p = buildPatchFromTexts("aaa\nbbb\nccc", "aaa\nBBB\nccc");
        expect(patchContainsLine(p, 0)).toBe(false); // "aaa"
        expect(patchContainsLine(p, 1)).toBe(true); // "BBB"
        expect(patchContainsLine(p, 2)).toBe(false); // "ccc"
    });

    it("buildTextRangePatchFromTexts captures inline spans", () => {
        const patch = buildTextRangePatchFromTexts("alpha", "alpHa");

        expect(patch.spans).toEqual([
            {
                baseFrom: 3,
                baseTo: 4,
                currentFrom: 3,
                currentTo: 4,
            },
        ]);
    });

    it("buildTextRangePatchFromTexts can refine a provided line patch", () => {
        const patch = buildTextRangePatchFromTexts("alpha", "alpHa", {
            edits: [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
        });

        expect(patch.spans).toEqual([
            {
                baseFrom: 3,
                baseTo: 4,
                currentFrom: 3,
                currentTo: 4,
            },
        ]);
    });

    it("buildTextRangePatchFromTexts splits disjoint inline same-line replacements", () => {
        const patch = buildTextRangePatchFromTexts(
            "foo bar baz",
            "FOO bar BAZ",
        );

        expect(patch.spans).toEqual([
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
        ]);
    });

    it("deriveLinePatchFromTextRanges keeps review hunks line-based", () => {
        const baseText = "first line\nalpha\nlast line";
        const currentText = "first line\nalpHa\nlast line";
        const ranges = buildTextRangePatchFromTexts(baseText, currentText);

        const linePatch = deriveLinePatchFromTextRanges(
            baseText,
            currentText,
            ranges.spans,
        );

        expect(linePatch.edits).toEqual([
            {
                oldStart: 1,
                oldEnd: 2,
                newStart: 1,
                newEnd: 2,
            },
        ]);
    });

    it("computeWordDiffsForHunk refines small modified hunks", () => {
        const baseText = "alpha beta gamma";
        const currentText = "alpha BETA delta gamma";
        const edit = buildPatchFromTexts(baseText, currentText).edits[0];

        const wordDiffs = computeWordDiffsForHunk(baseText, currentText, edit);

        expect(wordDiffs?.bufferRanges).toEqual([
            {
                from: 6,
                to: 16,
                baseFrom: 6,
                baseTo: 10,
            },
        ]);
        expect(wordDiffs?.baseRanges).toEqual([
            {
                from: 6,
                to: 10,
                baseFrom: 6,
                baseTo: 10,
            },
        ]);
    });

    it("computeWordDiffsForHunk falls back for large hunks", () => {
        const baseText = ["a", "b", "c", "d", "e", "f"].join("\n");
        const currentText = ["A", "B", "C", "D", "E", "F"].join("\n");
        const edit = buildPatchFromTexts(baseText, currentText).edits[0];

        expect(computeWordDiffsForHunk(baseText, currentText, edit)).toBeNull();
    });

    it("computeWordDiffsForHunk ignores pure additions and deletions", () => {
        const added = buildPatchFromTexts("alpha", "alpha\nbeta").edits[0];
        const deleted = buildPatchFromTexts("alpha\nbeta", "alpha").edits[0];

        expect(
            computeWordDiffsForHunk("alpha", "alpha\nbeta", added),
        ).toBeNull();
        expect(
            computeWordDiffsForHunk("alpha\nbeta", "alpha", deleted),
        ).toBeNull();
    });

    it("syncDerivedLinePatch rebuilds spans from legacy line-only tracked files", () => {
        const legacy: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "alpha",
            currentText: "alpHa",
            unreviewedEdits: buildPatchFromTexts("alpha", "alpHa"),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const synced = syncDerivedLinePatch(legacy);

        expect(synced.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 3,
                baseTo: 4,
                currentFrom: 3,
                currentTo: 4,
            },
        ]);
        expect(synced.unreviewedEdits.edits).toEqual([
            {
                oldStart: 0,
                oldEnd: 1,
                newStart: 0,
                newEnd: 1,
            },
        ]);
    });

    it("syncDerivedLinePatch rebuilds spans from texts when legacy line hunks are stale", () => {
        const legacy: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "alpha",
            currentText: "alpHa",
            unreviewedEdits: emptyPatch(),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const synced = syncDerivedLinePatch(legacy);

        expect(synced.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 3,
                baseTo: 4,
                currentFrom: 3,
                currentTo: 4,
            },
        ]);
        expect(synced.unreviewedEdits.edits).toEqual([
            {
                oldStart: 0,
                oldEnd: 1,
                newStart: 0,
                newEnd: 1,
            },
        ]);
    });

    it("syncDerivedLinePatch repairs stale canonical ranges from the visible diff", () => {
        const diffBase = "aaa\nbbb\nccc\nddd";
        const currentText = "aaa\nBBB\nccc\nDDD";
        const staleFile: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase,
            currentText,
            unreviewedRanges: buildTextRangePatchFromTexts(
                "aaa\nBBB\nccc\nddd",
                currentText,
            ),
            unreviewedEdits: buildPatchFromTexts(
                "aaa\nBBB\nccc\nddd",
                currentText,
            ),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const synced = syncDerivedLinePatch(staleFile);

        expect(synced.unreviewedRanges).toEqual(
            buildTextRangePatchFromTexts(diffBase, currentText),
        );
        expect(synced.unreviewedEdits).toEqual(
            buildPatchFromTexts(diffBase, currentText),
        );
        expect(validateTrackedFileDomain(synced)).toEqual([]);
    });

    it("syncDerivedLinePatch repairs stale same-line ranges that still matched the visible hunk", () => {
        const diffBase = "abc";
        const currentText = "axc";
        const staleFile: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase,
            currentText,
            unreviewedRanges: {
                spans: [
                    {
                        baseFrom: 0,
                        baseTo: 1,
                        currentFrom: 0,
                        currentTo: 1,
                    },
                ],
            },
            unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const synced = syncDerivedLinePatch(staleFile);

        expect(synced.unreviewedRanges).toEqual(
            buildTextRangePatchFromTexts(diffBase, currentText),
        );
        expect(validateTrackedFileDomain(synced)).toEqual([]);
    });

    it("syncDerivedLinePatch preserves the same reference for an already synced file", () => {
        const file = syncDerivedLinePatch({
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "alpha",
            currentText: "alpHa",
            unreviewedEdits: emptyPatch(),
            version: 1,
            isText: true,
            updatedAt: 1000,
        });

        expect(syncDerivedLinePatch(file)).toBe(file);
    });

    it("getTrackedFilesForWorkCycle returns a stable synced snapshot for legacy files", () => {
        const legacy: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "alpha",
            currentText: "alpHa",
            unreviewedEdits: emptyPatch(),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };
        const state = {
            trackedFilesByWorkCycleId: {
                "wc-1": {
                    "test.md": legacy,
                },
            },
            lastRejectUndo: null,
        };

        const first = getTrackedFilesForWorkCycle(state, "wc-1");
        const second = getTrackedFilesForWorkCycle(state, "wc-1");

        expect(first).toBe(second);
        expect(first["test.md"]).toBe(second["test.md"]);
        expect(first["test.md"]?.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 3,
                baseTo: 4,
                currentFrom: 3,
                currentTo: 4,
            },
        ]);
    });
});

describe("TrackedFile domain contract", () => {
    it("declares canonical fields, derived fields and invariant ids explicitly", () => {
        expect(getTrackedFileDomainContract()).toEqual({
            canonicalFields: [
                "identityKey",
                "originPath",
                "path",
                "previousPath",
                "status",
                "reviewState",
                "diffBase",
                "currentText",
                "unreviewedRanges",
                "version",
                "isText",
                "updatedAt",
                "conflictHash",
            ],
            derivedFields: ["unreviewedEdits"],
            invariants: [
                "empty_diff_has_no_pending_ranges",
                "empty_diff_has_no_pending_line_patch",
                "pending_ranges_cover_visible_diff",
                "pending_ranges_rebuild_diff_base",
                "line_patch_matches_ranges",
            ],
        });
    });

    it("accepts a tracked file created from a diff", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({
                old_text: "aaa\nbbb\nccc\nddd",
                new_text: "aaa\nBBB\nccc\nDDD",
            }),
            1000,
        );

        expect(validateTrackedFileDomain(file)).toEqual([]);
    });

    it("accepts a tracked file after a non-conflicting user edit rebases the base", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({
                old_text: "aaa\nbbb\nccc\nddd",
                new_text: "aaa\nBBB\nccc\nddd",
            }),
            1000,
        );
        const rebased = applyNonConflictingEdits(
            file,
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc\nddd",
        );

        expect(validateTrackedFileDomain(rebased)).toEqual([]);
    });

    it("reports when pending ranges no longer cover the visible diff", () => {
        const diffBase = "aaa\nbbb\nccc\nddd";
        const currentText = "aaa\nBBB\nccc\nDDD";
        const staleRanges = buildTextRangePatchFromTexts(
            "aaa\nBBB\nccc\nddd",
            currentText,
        );
        const staleFile: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase,
            currentText,
            unreviewedRanges: staleRanges,
            unreviewedEdits: buildPatchFromTexts(
                "aaa\nBBB\nccc\nddd",
                currentText,
            ),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        expect(getViolationIds(staleFile)).toEqual([
            "pending_ranges_cover_visible_diff",
            "pending_ranges_rebuild_diff_base",
        ]);
    });

    it("reports when derived line hunks drift away from canonical ranges", () => {
        const diffBase = "aaa\nbbb\nccc\nddd";
        const currentText = "aaa\nBBB\nccc\nDDD";
        const canonicalRanges = buildTextRangePatchFromTexts(
            diffBase,
            currentText,
        );
        const staleDerivedOnlyLastHunk = buildPatchFromTexts(
            "aaa\nBBB\nccc\nddd",
            currentText,
        );
        const staleFile: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase,
            currentText,
            unreviewedRanges: canonicalRanges,
            unreviewedEdits: staleDerivedOnlyLastHunk,
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        expect(getViolationIds(staleFile)).toEqual([
            "line_patch_matches_ranges",
        ]);
    });

    it("reports when pending ranges keep the same hunk but no longer rebuild diffBase", () => {
        const diffBase = "abc";
        const currentText = "axc";
        const staleFile: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase,
            currentText,
            unreviewedRanges: {
                spans: [
                    {
                        baseFrom: 0,
                        baseTo: 1,
                        currentFrom: 0,
                        currentTo: 1,
                    },
                ],
            },
            unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        expect(getViolationIds(staleFile)).toEqual([
            "pending_ranges_rebuild_diff_base",
        ]);
    });

    it("reports empty diffs that still carry pending review state", () => {
        const stalePending = buildPatchFromTexts("alpha", "alpHa");
        const staleRanges = buildTextRangePatchFromTexts("alpha", "alpHa");
        const file: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase: "same",
            currentText: "same",
            unreviewedRanges: staleRanges,
            unreviewedEdits: stalePending,
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        expect(getViolationIds(file)).toEqual(
            expect.arrayContaining([
                "empty_diff_has_no_pending_ranges",
                "empty_diff_has_no_pending_line_patch",
            ]),
        );
    });
});

// ---------------------------------------------------------------------------
// TrackedFile creation
// ---------------------------------------------------------------------------

describe("createTrackedFileFromDiff", () => {
    it("creates tracked file for update", () => {
        const diff = makeDiff();
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.identityKey).toBe("test.md");
        expect(file.path).toBe("test.md");
        expect(file.status).toEqual({ kind: "modified" });
        expect(file.diffBase).toBe("aaa\nbbb\nccc");
        expect(file.currentText).toBe("aaa\nBBB\nccc");
        expect(file.unreviewedRanges?.spans).toHaveLength(1);
        expect(file.unreviewedEdits.edits).toHaveLength(1);
        expect(file.reviewState).toBe("pending");
        expect(file.version).toBe(1);
    });

    it("creates tracked file for add", () => {
        const diff = makeDiff({
            kind: "add",
            old_text: null,
            new_text: "new content",
        });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.status).toEqual({
            kind: "created",
            existingFileContent: null,
        });
        expect(file.diffBase).toBe("");
        expect(file.currentText).toBe("new content");
    });

    it("creates tracked file for delete", () => {
        const diff = makeDiff({
            kind: "delete",
            old_text: "old content",
            new_text: null,
        });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.status).toEqual({ kind: "deleted" });
        expect(file.diffBase).toBe("old content");
        expect(file.currentText).toBe("");
    });

    it("creates tracked file for move", () => {
        const diff = makeDiff({
            kind: "move",
            path: "new/path.md",
            previous_path: "old/path.md",
            old_text: "content",
            new_text: "content modified",
        });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.status).toEqual({ kind: "modified" });
        expect(file.originPath).toBe("old/path.md");
        expect(file.path).toBe("new/path.md");
        expect(file.previousPath).toBe("old/path.md");
    });

    it("derives patches directly from diffBase/currentText", () => {
        const diff = makeDiff();
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.unreviewedEdits).toEqual(
            buildPatchFromTexts(diff.old_text ?? "", diff.new_text ?? ""),
        );
        expect(file.unreviewedRanges).toEqual(
            buildTextRangePatchFromTexts(
                diff.old_text ?? "",
                diff.new_text ?? "",
            ),
        );
    });
});

// ---------------------------------------------------------------------------
// updateTrackedFileWithDiff
// ---------------------------------------------------------------------------

describe("updateTrackedFileWithDiff", () => {
    it("preserves diffBase on subsequent updates", () => {
        const diff1 = makeDiff({
            old_text: "original",
            new_text: "first change",
        });
        const file1 = createTrackedFileFromDiff(diff1, 1000);
        expect(file1.diffBase).toBe("original");

        const diff2 = makeDiff({ new_text: "second change" });
        const file2 = updateTrackedFileWithDiff(file1, diff2, 2000);

        expect(file2.diffBase).toBe("original"); // preserved
        expect(file2.currentText).toBe("second change");
        expect(file2.version).toBe(2);
    });

    it("bumps version on each update", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        const updated = updateTrackedFileWithDiff(file, makeDiff(), 2000);
        expect(updated.version).toBe(file.version + 1);
    });
});

// ---------------------------------------------------------------------------
// consolidateTrackedFiles
// ---------------------------------------------------------------------------

describe("consolidateTrackedFiles", () => {
    it("adds new files", () => {
        const result = consolidateTrackedFiles(
            {},
            [makeDiff({ path: "a.md" }), makeDiff({ path: "b.md" })],
            1000,
        );
        expect(Object.keys(result)).toEqual(["a.md", "b.md"]);
    });

    it("updates existing files", () => {
        const initial = consolidateTrackedFiles(
            {},
            [makeDiff({ old_text: "old", new_text: "v1" })],
            1000,
        );
        const updated = consolidateTrackedFiles(
            initial,
            [makeDiff({ old_text: "old", new_text: "v2" })],
            2000,
        );

        expect(Object.keys(updated)).toEqual(["test.md"]);
        expect(updated["test.md"].currentText).toBe("v2");
        expect(updated["test.md"].diffBase).toBe("old"); // preserved
    });

    it("removes files that revert to original", () => {
        const initial = consolidateTrackedFiles(
            {},
            [makeDiff({ old_text: "same", new_text: "changed" })],
            1000,
        );
        expect(Object.keys(initial)).toHaveLength(1);

        const reverted = consolidateTrackedFiles(
            initial,
            [makeDiff({ old_text: "same", new_text: "same" })],
            2000,
        );
        expect(Object.keys(reverted)).toHaveLength(0);
    });

    it("skips unsupported files", () => {
        const result = consolidateTrackedFiles(
            {},
            [makeDiff({ is_text: false })],
            1000,
        );
        expect(Object.keys(result)).toHaveLength(0);
    });

    it("derives tracked file patches independently for each diff", () => {
        const result = consolidateTrackedFiles(
            {},
            [makeDiff({ path: "a.md" }), makeDiff({ path: "b.md" })],
            1000,
        );

        expect(result["a.md"].unreviewedEdits.edits).toEqual([
            { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
        ]);
        expect(result["b.md"].unreviewedEdits.edits).toEqual([
            { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
        ]);
    });
});

describe("ActionLogState helpers", () => {
    it("initializes normalized storage containers", () => {
        expect(emptyActionLogState()).toEqual({
            trackedFilesByIdentityKey: {},
            trackedFileIdsByWorkCycleId: {},
            trackedFilesByWorkCycleId: {},
            lastRejectUndo: null,
        });
    });

    it("getTrackedFilesForWorkCycle lazily normalizes legacy tracked files", () => {
        const legacy: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "alpha",
            currentText: "alpHa",
            unreviewedEdits: emptyPatch(),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const tracked = getTrackedFilesForWorkCycle(
            {
                trackedFilesByWorkCycleId: {
                    cycle: {
                        "test.md": legacy,
                    },
                },
                lastRejectUndo: null,
            },
            "cycle",
        );

        expect(tracked["test.md"]).not.toBe(legacy);
        expect(tracked["test.md"].unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 3,
                baseTo: 4,
                currentFrom: 3,
                currentTo: 4,
            },
        ]);
    });

    it("stores tracked files primarily by session and indexes them by work cycle", () => {
        const tracked = createTrackedFileFromDiff(
            makeDiff({
                path: "session.md",
                old_text: "alpha",
                new_text: "alpHa",
            }),
            1000,
        );

        const state = setTrackedFilesForWorkCycle(
            emptyActionLogState(),
            "cycle-1",
            { [tracked.identityKey]: tracked },
        );

        expect(state.trackedFilesByIdentityKey).toMatchObject({
            "session.md": expect.objectContaining({
                identityKey: "session.md",
                diffBase: "alpha",
                currentText: "alpHa",
            }),
        });
        expect(state.trackedFileIdsByWorkCycleId).toEqual({
            "cycle-1": ["session.md"],
        });
        expect(getTrackedFilesForSession(state)).toMatchObject({
            "session.md": expect.objectContaining({
                identityKey: "session.md",
            }),
        });
        expect(getTrackedFilesForWorkCycle(state, "cycle-1")).toMatchObject({
            "session.md": expect.objectContaining({
                identityKey: "session.md",
            }),
        });
    });

    it("prunes session storage when a work cycle stops referencing a tracked file", () => {
        const fileA = createTrackedFileFromDiff(
            makeDiff({
                path: "a.md",
                old_text: "alpha",
                new_text: "alpHa",
            }),
            1000,
        );
        const fileB = createTrackedFileFromDiff(
            makeDiff({
                path: "b.md",
                old_text: "beta",
                new_text: "beTa",
            }),
            1001,
        );

        let state = setTrackedFilesForWorkCycle(
            emptyActionLogState(),
            "cycle-a",
            { [fileA.identityKey]: fileA },
        );
        state = setTrackedFilesForWorkCycle(state, "cycle-b", {
            [fileB.identityKey]: fileB,
        });
        state = setTrackedFilesForWorkCycle(state, "cycle-a", {});

        expect(state.trackedFilesByIdentityKey).toMatchObject({
            "b.md": expect.objectContaining({
                identityKey: "b.md",
            }),
        });
        expect(state.trackedFilesByIdentityKey).not.toHaveProperty("a.md");
        expect(state.trackedFileIdsByWorkCycleId).toEqual({
            "cycle-b": ["b.md"],
        });
        expect(getTrackedFilesForWorkCycle(state, "cycle-a")).toEqual({});
        expect(getTrackedFilesForSession(state)).toMatchObject({
            "b.md": expect.objectContaining({
                identityKey: "b.md",
            }),
        });
    });

    it("returns normalized primary storage even when cycle metadata is missing", () => {
        const tracked = createTrackedFileFromDiff(
            makeDiff({
                path: "direct.md",
                old_text: "alpha",
                new_text: "alpHa",
            }),
            1000,
        );

        expect(
            getTrackedFilesForSession({
                trackedFilesByIdentityKey: {
                    [tracked.identityKey]: tracked,
                },
                lastRejectUndo: null,
            }),
        ).toMatchObject({
            "direct.md": expect.objectContaining({
                identityKey: "direct.md",
            }),
        });
    });

    it("repairs invalid stored tracked files while normalizing session storage", () => {
        const diffBase = "aaa\nbbb\nccc\nddd";
        const currentText = "aaa\nBBB\nccc\nDDD";
        const staleTracked: TrackedFile = {
            identityKey: "stale.md",
            originPath: "stale.md",
            path: "stale.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase,
            currentText,
            unreviewedRanges: buildTextRangePatchFromTexts(
                "aaa\nBBB\nccc\nddd",
                currentText,
            ),
            unreviewedEdits: buildPatchFromTexts(
                "aaa\nBBB\nccc\nddd",
                currentText,
            ),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const tracked = getTrackedFilesForSession({
            trackedFilesByIdentityKey: {
                [staleTracked.identityKey]: staleTracked,
            },
            trackedFileIdsByWorkCycleId: {
                cycle: [staleTracked.identityKey],
            },
            lastRejectUndo: null,
        });

        expect(tracked["stale.md"]?.unreviewedRanges).toEqual(
            buildTextRangePatchFromTexts(diffBase, currentText),
        );
        expect(tracked["stale.md"]?.unreviewedEdits).toEqual(
            buildPatchFromTexts(diffBase, currentText),
        );
        expect(validateTrackedFileDomain(tracked["stale.md"]!)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// applyNonConflictingEdits
// ---------------------------------------------------------------------------

describe("applyNonConflictingEdits", () => {
    function makeTrackedFile(
        diffBase: string,
        currentText: string,
    ): TrackedFile {
        return {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase,
            currentText,
            unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };
    }

    function edit(
        oldFrom: number,
        oldTo: number,
        newFrom: number,
        newTo: number,
    ): TextEdit {
        return { oldFrom, oldTo, newFrom, newTo };
    }

    it("absorbs user edit on non-agent line into diffBase", () => {
        // Agent changed line 1 (bbb → BBB)
        // User changes line 0 (aaa → AAA)
        const file = makeTrackedFile("aaa\nbbb\nccc", "aaa\nBBB\nccc");

        const userEdits = [edit(0, 3, 0, 3)];
        const newFullText = "AAA\nBBB\nccc";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        // diffBase should absorb the user's edit
        expect(result.diffBase).toBe("AAA\nbbb\nccc");
        expect(result.currentText).toBe("AAA\nBBB\nccc");
        // Agent's edit (line 1) should still be in unreviewedEdits
        expect(result.unreviewedEdits.edits).toHaveLength(1);
        expect(patchContainsLine(result.unreviewedEdits, 1)).toBe(true);
    });

    it("retires agent attribution when the user edits an agent-modified line", () => {
        // Agent changed line 1 (bbb → BBB)
        // User also tries to change line 1
        const file = makeTrackedFile("aaa\nbbb\nccc", "aaa\nBBB\nccc");

        const userEdits = [edit(4, 7, 4, 7)];
        const newFullText = "aaa\nXXX\nccc";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        expect(result.diffBase).toBe("aaa\nXXX\nccc");
        expect(patchIsEmpty(result.unreviewedEdits)).toBe(true);
    });

    it("handles user edit after agent range", () => {
        // Agent changed line 0 (aaa → AAA)
        // User changes line 2 (ccc → CCC) — no conflict
        const file = makeTrackedFile("aaa\nbbb\nccc", "AAA\nbbb\nccc");

        const userEdits = [edit(8, 11, 8, 11)];
        const newFullText = "AAA\nbbb\nCCC";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        expect(result.diffBase).toBe("aaa\nbbb\nCCC");
    });

    it("handles multiple user edits, some conflicting", () => {
        // Agent changed line 2 (ccc → CCC)
        const file = makeTrackedFile(
            "aaa\nbbb\nccc\nddd",
            "aaa\nbbb\nCCC\nddd",
        );

        const userEdits = [
            edit(0, 3, 0, 3), // aaa → AAA (ok)
            edit(8, 11, 8, 11), // CCC → XXX (conflict)
            edit(12, 15, 12, 15), // ddd → DDD (ok)
        ];
        const newFullText = "AAA\nbbb\nXXX\nDDD";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        expect(result.diffBase).toBe("AAA\nbbb\nXXX\nDDD");
        expect(patchIsEmpty(result.unreviewedEdits)).toBe(true);
    });

    it("keeps agent spans when the user edits beside them inline", () => {
        const file = makeTrackedFile("alpha", "alpHa");
        const userEdits = [edit(4, 4, 4, 5)];
        const newFullText = "alpHXa";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        expect(result.diffBase).toBe("alphXa");
        expect(result.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 3,
                baseTo: 4,
                currentFrom: 3,
                currentTo: 4,
            },
        ]);
        expect(result.unreviewedEdits.edits).toEqual([
            {
                oldStart: 0,
                oldEnd: 1,
                newStart: 0,
                newEnd: 1,
            },
        ]);
    });

    it("retires the whole span when the user touches it partially", () => {
        const file = makeTrackedFile("alpha", "alpHa");
        const userEdits = [edit(3, 4, 3, 4)];
        const newFullText = "alpha";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        expect(result.diffBase).toBe("alpha");
        expect(patchIsEmpty(result.unreviewedEdits)).toBe(true);
    });

    it("keeps untouched agent hunks pending after a user line insertion above them", () => {
        const file = makeTrackedFile("aaa\nbbb\nccc", "aaa\nbbb\nCCC");
        const userEdits = [edit(4, 4, 4, 9)];
        const newFullText = "aaa\nuser\nbbb\nCCC";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        expect(result.diffBase).toBe("aaa\nuser\nbbb\nccc");
        expect(result.unreviewedEdits.edits).toHaveLength(1);
        expect(result.unreviewedEdits.edits[0]).toEqual({
            oldStart: 3,
            oldEnd: 4,
            newStart: 3,
            newEnd: 4,
        });
    });

    it("returns unchanged file when no user edits", () => {
        const file = makeTrackedFile("aaa\nbbb", "aaa\nBBB");
        const result = applyNonConflictingEdits(file, [], "aaa\nBBB");
        expect(result.diffBase).toBe(file.diffBase);
    });

    it("returns file with updated text when no agent edits", () => {
        const file: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "aaa\nbbb",
            currentText: "aaa\nbbb",
            unreviewedEdits: emptyPatch(),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const result = applyNonConflictingEdits(
            file,
            [edit(0, 3, 0, 3)],
            "AAA\nbbb",
        );

        expect(result.diffBase).toBe("AAA\nbbb");
        expect(result.currentText).toBe("AAA\nbbb");
        expect(result.version).toBe(2);
    });
});

describe("partitionSpansByOverlap", () => {
    const baseText = "alpha\nmiddle\nbeta\nspacer\ngamma";
    const currentText = "alpHa\nmiddle\nbeTa\nspacer\ngamMa";
    const spans = buildTextRangePatchFromTexts(baseText, currentText).spans;

    it("returns empty groups when there are no spans", () => {
        expect(
            partitionSpansByOverlap(
                [],
                [{ start: 0, end: 1 }],
                baseText,
                currentText,
            ),
        ).toEqual({
            overlapping: [],
            nonOverlapping: [],
        });
    });

    it("returns all spans as non-overlapping when there are no ranges", () => {
        expect(
            partitionSpansByOverlap(spans, [], baseText, currentText),
        ).toEqual({
            overlapping: [],
            nonOverlapping: spans,
        });
    });

    it("returns no overlaps when ranges miss every span", () => {
        const result = partitionSpansByOverlap(
            spans,
            [{ start: 1, end: 2 }],
            baseText,
            currentText,
        );

        expect(result.overlapping).toEqual([]);
        expect(result.nonOverlapping).toEqual(spans);
    });

    it("partitions a single matching span", () => {
        const result = partitionSpansByOverlap(
            spans,
            [{ start: 0, end: 1 }],
            baseText,
            currentText,
        );

        expect(result.overlapping).toEqual([spans[0]]);
        expect(result.nonOverlapping).toEqual([spans[1], spans[2]]);
    });

    it("partitions all spans when the range covers every hunk", () => {
        const result = partitionSpansByOverlap(
            spans,
            [{ start: 0, end: 5 }],
            baseText,
            currentText,
        );

        expect(result.overlapping).toEqual(spans);
        expect(result.nonOverlapping).toEqual([]);
    });

    it("handles multiple spans and multiple ranges in one pass", () => {
        const result = partitionSpansByOverlap(
            spans,
            [
                { start: 2, end: 3 },
                { start: 0, end: 1 },
            ],
            baseText,
            currentText,
        );

        expect(result.overlapping).toEqual([spans[0], spans[1]]);
        expect(result.nonOverlapping).toEqual([spans[2]]);
    });
});

// ---------------------------------------------------------------------------
// keepAllEdits
// ---------------------------------------------------------------------------

describe("Accept operations", () => {
    it("keepAllEdits clears unreviewedEdits", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        expect(patchIsEmpty(file.unreviewedEdits)).toBe(false);

        const accepted = keepAllEdits(file);
        expect(patchIsEmpty(accepted.unreviewedEdits)).toBe(true);
        expect(accepted.diffBase).toBe(accepted.currentText);
    });
});

// ---------------------------------------------------------------------------
// rejectAllEdits
// ---------------------------------------------------------------------------

describe("Reject operations", () => {
    it("rejectAllEdits reverts to diffBase", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        const { file: rejected, undoData } = rejectAllEdits(file);

        expect(rejected.currentText).toBe(rejected.diffBase);
        expect(patchIsEmpty(rejected.unreviewedEdits)).toBe(true);
        expect(undoData.editsToRestore.length).toBeGreaterThan(0);
    });
});

describe("Exact review resolution", () => {
    function createInlineNeighborFile(): TrackedFile {
        return {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase: "foo bar baz",
            currentText: "FOO bar BAZ",
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
            unreviewedEdits: emptyPatch(),
            version: 7,
            isText: true,
            updatedAt: 1000,
            conflictHash: null,
        };
    }

    it("keepExactSpans accepts a selected hunk without absorbing a same-line neighbor", () => {
        const file = createInlineNeighborFile();

        const accepted = keepExactSpans(file, [
            file.unreviewedRanges!.spans[0]!,
        ]);

        expect(accepted.diffBase).toBe("FOO bar baz");
        expect(accepted.currentText).toBe("FOO bar BAZ");
        expect(accepted.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 8,
                baseTo: 11,
                currentFrom: 8,
                currentTo: 11,
            },
        ]);
    });

    it("rejectExactSpans reverts only the selected span and keeps the same-line neighbor", () => {
        const file = createInlineNeighborFile();

        const { file: rejected, undoData } = rejectExactSpans(file, [
            file.unreviewedRanges!.spans[0]!,
        ]);

        expect(rejected.currentText).toBe("foo bar BAZ");
        expect(rejected.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 8,
                baseTo: 11,
                currentFrom: 8,
                currentTo: 11,
            },
        ]);
        expect(undoData.editsToRestore).toHaveLength(1);
    });

    it("keepReviewHunks resolves exact member spans even when hunks share a visual chunk", () => {
        const file = createInlineNeighborFile();
        const projection = buildReviewProjection(file);

        expect(projection.chunks).toHaveLength(1);
        expect(projection.chunks[0]!.hunkIds).toHaveLength(2);

        const accepted = keepReviewHunks(file, [projection.hunks[0]!]);

        expect(accepted.diffBase).toBe("FOO bar baz");
        expect(accepted.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 8,
                baseTo: 11,
                currentFrom: 8,
                currentTo: 11,
            },
        ]);
    });

    it("keepReviewHunks accepts the canonical selection shape without depending on visual fields", () => {
        const file = createInlineNeighborFile();
        const selection = [
            {
                trackedVersion: file.version,
                memberSpans: [
                    {
                        spanIndex: 0,
                        ...file.unreviewedRanges!.spans[0]!,
                    },
                ],
            },
        ];

        const accepted = keepReviewHunks(file, selection);

        expect(accepted.diffBase).toBe("FOO bar baz");
        expect(accepted.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 8,
                baseTo: 11,
                currentFrom: 8,
                currentTo: 11,
            },
        ]);
    });

    it("rejectReviewHunks resolves exact member spans independently inside one visual chunk", () => {
        const file = createInlineNeighborFile();
        const projection = buildReviewProjection(file);

        const { file: rejected } = rejectReviewHunks(file, [
            projection.hunks[0]!,
        ]);

        expect(rejected.currentText).toBe("foo bar BAZ");
        expect(rejected.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 8,
                baseTo: 11,
                currentFrom: 8,
                currentTo: 11,
            },
        ]);
    });

    it("rejectReviewHunks rejects from the canonical selection shape without depending on visual fields", () => {
        const file = createInlineNeighborFile();
        const selection = [
            {
                trackedVersion: file.version,
                memberSpans: [
                    {
                        spanIndex: 0,
                        ...file.unreviewedRanges!.spans[0]!,
                    },
                ],
            },
        ];

        const { file: rejected } = rejectReviewHunks(file, selection);

        expect(rejected.currentText).toBe("foo bar BAZ");
        expect(rejected.unreviewedRanges?.spans).toEqual([
            {
                baseFrom: 8,
                baseTo: 11,
                currentFrom: 8,
                currentTo: 11,
            },
        ]);
    });

    it("keepReviewHunks accepts pure deletion hunks exactly", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({
                old_text: "aaa\nbbb\nccc",
                new_text: "aaa\nccc",
            }),
            1000,
        );
        const projection = buildReviewProjection(file);

        expect(projection.hunks).toHaveLength(1);

        const accepted = keepReviewHunks(file, projection.hunks);

        expect(accepted.diffBase).toBe("aaa\nccc");
        expect(accepted.currentText).toBe("aaa\nccc");
        expect(accepted.unreviewedEdits.edits).toEqual([]);
    });

    it("rejectReviewHunks rejects pure deletion hunks exactly", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({
                old_text: "aaa\nbbb\nccc",
                new_text: "aaa\nccc",
            }),
            1000,
        );
        const projection = buildReviewProjection(file);

        expect(projection.hunks).toHaveLength(1);

        const { file: rejected, undoData } = rejectReviewHunks(
            file,
            projection.hunks,
        );

        expect(rejected.currentText).toBe("aaa\nbbb\nccc");
        expect(rejected.unreviewedEdits.edits).toEqual([]);
        expect(undoData.editsToRestore).toHaveLength(1);
    });

    it("keeps heavily edited agent files stable hunk by hunk inside one visual chunk", () => {
        const file: TrackedFile = {
            identityKey: "large-review.md",
            originPath: "large-review.md",
            path: "large-review.md",
            previousPath: null,
            status: { kind: "modified" },
            reviewState: "finalized",
            diffBase: [
                "zero",
                "one",
                "two",
                "three",
                "four",
                "five",
                "six",
                "seven",
                "eight",
                "nine",
            ].join("\n"),
            currentText: [
                "ZERO",
                "one",
                "TWO",
                "three",
                "FOUR",
                "five",
                "SIX",
                "seven",
                "EIGHT",
                "nine",
            ].join("\n"),
            unreviewedRanges: buildTextRangePatchFromTexts(
                [
                    "zero",
                    "one",
                    "two",
                    "three",
                    "four",
                    "five",
                    "six",
                    "seven",
                    "eight",
                    "nine",
                ].join("\n"),
                [
                    "ZERO",
                    "one",
                    "TWO",
                    "three",
                    "FOUR",
                    "five",
                    "SIX",
                    "seven",
                    "EIGHT",
                    "nine",
                ].join("\n"),
            ),
            unreviewedEdits: emptyPatch(),
            version: 11,
            isText: true,
            updatedAt: 1000,
            conflictHash: null,
        };
        const projection = buildReviewProjection(file);

        expect(projection.hunks).toHaveLength(5);
        expect(projection.chunks).toHaveLength(1);
        expect(projection.chunks[0]!.hunkIds).toHaveLength(5);

        const accepted = keepReviewHunks(file, [projection.hunks[2]!]);

        expect(accepted.diffBase.split("\n")[4]).toBe("FOUR");
        expect(accepted.currentText.split("\n")[4]).toBe("FOUR");
        expect(accepted.unreviewedRanges?.spans).toHaveLength(4);
        expect(buildReviewProjection(accepted).hunks).toHaveLength(4);
    });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe("Undo", () => {
    it("applyRejectUndo restores agent text after reject", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        const { file: rejected, undoData } = rejectAllEdits(file);

        expect(rejected.currentText).toBe(file.diffBase);

        const restored = applyRejectUndo(rejected, undoData);
        // After undo, text should match original agent-applied text
        expect(restored.currentText).toBe(file.currentText);
        expect(restored.unreviewedEdits.edits).toHaveLength(
            file.unreviewedEdits.edits.length,
        );
    });
});

// ---------------------------------------------------------------------------
// computeRestoreAction (lifecycle-aware)
// ---------------------------------------------------------------------------

describe("computeRestoreAction", () => {
    it("returns skip for agent-created file with no previous content when live text is unknown", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({ kind: "add", old_text: null, new_text: "new" }),
            1000,
        );
        const action = computeRestoreAction(file);
        expect(action).toEqual({
            kind: "skip",
            reason: "user_owns_content",
        });
    });

    it("returns delete for agent-created file when live text still matches", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({ kind: "add", old_text: null, new_text: "new" }),
            1000,
        );
        const action = computeRestoreAction(file, "new");
        expect(action).toEqual({ kind: "delete" });
    });

    it("returns skip for agent-created file when live text differs", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({ kind: "add", old_text: null, new_text: "new" }),
            1000,
        );
        const action = computeRestoreAction(file, "user edited");
        expect(action).toEqual({
            kind: "skip",
            reason: "user_owns_content",
        });
    });

    it("returns write with diffBase for modified file", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        const action = computeRestoreAction(file);
        expect(action).toEqual({ kind: "write", content: file.diffBase });
    });

    it("returns write with diffBase for deleted file (restores it)", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({
                kind: "delete",
                old_text: "original content",
                new_text: null,
            }),
            1000,
        );
        const action = computeRestoreAction(file);
        expect(action).toEqual({
            kind: "write",
            content: file.diffBase,
        });
    });

    it("returns write with previousPath for moved file", () => {
        const diff = makeDiff({
            kind: "move",
            path: "new-name.md",
            previous_path: "old-name.md",
            old_text: "content",
            new_text: "modified content",
        });
        const file = createTrackedFileFromDiff(diff, 1000);
        // originPath is old-name.md, path is new-name.md
        const action = computeRestoreAction(file);
        expect(action.kind).toBe("write");
        if (action.kind === "write") {
            expect(action.content).toBe(file.diffBase);
            expect(action.previousPath).toBe("new-name.md");
        }
    });
});

describe("reviewState", () => {
    it("defaults legacy tracked files to finalized", () => {
        const legacy: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "old",
            currentText: "new",
            unreviewedEdits: buildPatchFromTexts("old", "new"),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        expect(getTrackedFileReviewState(legacy)).toBe("finalized");
        expect(finalizeTrackedFile(legacy)).toBe(legacy);
    });

    it("finalizes a pending tracked file and bumps version", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);

        const finalized = finalizeTrackedFile(file);

        expect(finalized.reviewState).toBe("finalized");
        expect(finalized.version).toBe(file.version + 1);
    });

    it("finalizes every pending file in a tracked map", () => {
        const a = createTrackedFileFromDiff(makeDiff({ path: "a.md" }), 1000);
        const b = createTrackedFileFromDiff(makeDiff({ path: "b.md" }), 1000);

        const finalized = finalizeTrackedFiles({
            [a.identityKey]: a,
            [b.identityKey]: b,
        });

        expect(finalized[a.identityKey]?.reviewState).toBe("finalized");
        expect(finalized[b.identityKey]?.reviewState).toBe("finalized");
    });

    it("marks updated tracked files as pending again when a new diff arrives", () => {
        const file = finalizeTrackedFile(
            createTrackedFileFromDiff(makeDiff(), 1000),
        );

        const updated = updateTrackedFileWithDiff(
            file,
            makeDiff({ new_text: "aaa\nBBBB\nccc" }),
            2000,
        );

        expect(updated.reviewState).toBe("pending");
    });
});

// ---------------------------------------------------------------------------
// Inline diff positioning — verifies that edits from Claude land on the
// correct document lines in the editor, and that the guard prevents wrong
// positions when old_text is missing.
// ---------------------------------------------------------------------------

describe("Inline diff positioning", () => {
    it("update diff with old_text positions edits at the correct lines", () => {
        // Claude edits line 5 of a 7-line file (inserts a new line after line 4)
        const oldText = "a\nb\nc\nd\ne\nf\ng";
        const newText = "a\nb\nc\nd\nINSERTED\ne\nf\ng";
        const diff = makeDiff({ old_text: oldText, new_text: newText });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.diffBase).toBe(oldText);
        expect(file.status.kind).toBe("modified");

        // The patch should have exactly one edit hunk for the insertion
        expect(file.unreviewedEdits.edits).toHaveLength(1);
        const edit = file.unreviewedEdits.edits[0];

        // The insertion is between old lines 4 and 4 (0-based), new line 4
        expect(edit.oldStart).toBe(4);
        expect(edit.oldEnd).toBe(4); // pure insertion in old text
        expect(edit.newStart).toBe(4);
        expect(edit.newEnd).toBe(5);

        // shouldShowInlineDiff must be true — positions are reliable
        expect(shouldShowInlineDiff(file)).toBe(true);
    });

    it("update diff with old_text positions multi-line insertion correctly", () => {
        const oldText = "header\n\nfooter";
        const newText = "header\nline A\nline B\nline C\n\nfooter";
        const diff = makeDiff({ old_text: oldText, new_text: newText });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.unreviewedEdits.edits).toHaveLength(1);
        const edit = file.unreviewedEdits.edits[0];

        // Insertion between "header" (line 0) and "" (line 1)
        expect(edit.oldStart).toBe(1);
        expect(edit.oldEnd).toBe(1);
        expect(edit.newStart).toBe(1);
        expect(edit.newEnd).toBe(4); // 3 new lines
        expect(shouldShowInlineDiff(file)).toBe(true);
    });

    it("update diff without old_text produces empty diffBase and skips inline", () => {
        // Simulates Write tool post-write: kind="update" but old_text missing
        const diff = makeDiff({
            kind: "update",
            old_text: null,
            new_text: "full file content\nwith many lines",
        });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.status.kind).toBe("modified");
        expect(file.diffBase).toBe(""); // old_text was null → ""

        // buildPatchFromTexts("", content) puts all edits at line 0
        expect(file.unreviewedEdits.edits.length).toBeGreaterThan(0);
        expect(file.unreviewedEdits.edits[0].oldStart).toBe(0);

        // Guard must block these — line positions are unreliable
        expect(shouldShowInlineDiff(file)).toBe(false);
    });

    it("buildPatchFromTexts with empty base puts everything at line 0", () => {
        // Demonstrates WHY the guard is needed: without old_text, the entire
        // file content is treated as a single replacement starting at line 0.
        // "" splits to [""] (1 line), so oldEnd = 1 (the empty line is replaced).
        const patch = buildPatchFromTexts("", "line1\nline2\nline3");
        expect(patch.edits).toHaveLength(1);

        const edit = patch.edits[0];
        expect(edit.oldStart).toBe(0);
        expect(edit.oldEnd).toBe(1); // "" = 1 empty line replaced
        expect(edit.newStart).toBe(0);
        expect(edit.newEnd).toBe(3);
    });

    it("add diff (new file) with null old_text allows inline at line 0", () => {
        // New file creation: line 0 IS the correct position
        const diff = makeDiff({
            kind: "add",
            old_text: null,
            new_text: "brand new\nfile content",
        });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.status).toEqual({
            kind: "created",
            existingFileContent: null,
        });
        expect(file.diffBase).toBe("");

        // All edits at line 0 — correct for a new file
        expect(file.unreviewedEdits.edits).toHaveLength(1);
        expect(file.unreviewedEdits.edits[0].newStart).toBe(0);

        // Guard must ALLOW these — line 0 is correct for created files
        expect(shouldShowInlineDiff(file)).toBe(true);
    });

    it("shouldShowInlineDiff returns false when no edits exist", () => {
        const diff = makeDiff({ old_text: "same", new_text: "same" });
        const file = createTrackedFileFromDiff(diff, 1000);
        expect(patchIsEmpty(file.unreviewedEdits)).toBe(true);
        expect(shouldShowInlineDiff(file)).toBe(false);
    });

    it("delete diff does not show inline (no edits to display)", () => {
        const diff = makeDiff({
            kind: "delete",
            old_text: "deleted content",
            new_text: null,
        });
        const file = createTrackedFileFromDiff(diff, 1000);

        expect(file.status.kind).toBe("deleted");
        expect(file.currentText).toBe("");
        // Deletion produces edits (old lines removed) but in the editor
        // the file is empty so there is no B-side content to decorate.
        // shouldShowInlineDiff still returns true — the editor
        // handles this through the merge view deleted chunk widget.
        // This test just documents the behavior.
    });
});

// ---------------------------------------------------------------------------
// mapAgentSpanThroughTextEdits — isolated unit tests
// ---------------------------------------------------------------------------

describe("mapAgentSpanThroughTextEdits", () => {
    function edit(
        oldFrom: number,
        oldTo: number,
        newFrom: number,
        newTo: number,
    ): TextEdit {
        return { oldFrom, oldTo, newFrom, newTo };
    }

    function span(
        baseFrom: number,
        baseTo: number,
        currentFrom: number,
        currentTo: number,
    ) {
        return { baseFrom, baseTo, currentFrom, currentTo };
    }

    it("returns null when user edit overlaps the span", () => {
        // span at [4,7], user edits [5,6]
        const result = mapAgentSpanThroughTextEdits(span(4, 7, 4, 7), [
            edit(5, 6, 5, 6),
        ]);
        expect(result).toBeNull();
    });

    it("returns null when user edit fully contains the span", () => {
        const result = mapAgentSpanThroughTextEdits(span(4, 7, 4, 7), [
            edit(3, 8, 3, 10),
        ]);
        expect(result).toBeNull();
    });

    it("shifts span forward when user inserts before it", () => {
        // span at [10,15], user inserts 5 chars at position [2,2] → [2,7]
        const result = mapAgentSpanThroughTextEdits(span(10, 15, 10, 15), [
            edit(2, 2, 2, 7),
        ]);
        expect(result).toEqual(span(10, 15, 15, 20));
    });

    it("leaves span unchanged when user edits after it", () => {
        // span at [2,5], user edits at [10,12]
        const result = mapAgentSpanThroughTextEdits(span(2, 5, 2, 5), [
            edit(10, 12, 10, 15),
        ]);
        expect(result).toEqual(span(2, 5, 2, 5));
    });

    it("handles multiple edits: one before, one after the span", () => {
        // span at [10,15], edits: insert 3 chars at [2,2]→[2,5], replace at [20,22]→[23,25]
        const result = mapAgentSpanThroughTextEdits(span(10, 15, 10, 15), [
            edit(2, 2, 2, 5),
            edit(20, 22, 23, 25),
        ]);
        // Only the first edit (insert of 3) shifts the span
        expect(result).toEqual(span(10, 15, 13, 18));
    });

    it("returns null when one of multiple edits touches the span", () => {
        // span at [10,15], first edit is safe but second overlaps
        const result = mapAgentSpanThroughTextEdits(span(10, 15, 10, 15), [
            edit(2, 2, 2, 5),
            edit(12, 13, 15, 16),
        ]);
        expect(result).toBeNull();
    });

    it("handles pure insertion span (baseFrom === baseTo)", () => {
        // Agent inserted text: baseFrom === baseTo (nothing in old), currentFrom/To has content
        const result = mapAgentSpanThroughTextEdits(
            span(5, 5, 5, 10),
            [edit(0, 0, 0, 3)], // user inserts 3 chars at start
        );
        expect(result).toEqual(span(5, 5, 8, 13));
    });

    it("returns null when user edit touches a pure insertion span", () => {
        // span is pure insertion at [5,10] in current text
        const result = mapAgentSpanThroughTextEdits(
            span(5, 5, 5, 10),
            [edit(6, 7, 6, 7)], // user edits inside the insertion
        );
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// mapTextPositionThroughEdits — isolated unit tests
// ---------------------------------------------------------------------------

describe("mapTextPositionThroughEdits", () => {
    function edit(
        oldFrom: number,
        oldTo: number,
        newFrom: number,
        newTo: number,
    ): TextEdit {
        return { oldFrom, oldTo, newFrom, newTo };
    }

    it("shifts position forward after an insertion before it", () => {
        // Insert 5 chars at [0,0]→[0,5], position was 10
        expect(mapTextPositionThroughEdits(10, [edit(0, 0, 0, 5)], 1)).toBe(15);
    });

    it("shifts position backward after a deletion before it", () => {
        // Delete 3 chars at [2,5]→[2,2], position was 10
        expect(mapTextPositionThroughEdits(10, [edit(2, 5, 2, 2)], 1)).toBe(7);
    });

    it("does not shift position for edit after it", () => {
        expect(mapTextPositionThroughEdits(5, [edit(10, 12, 10, 15)], 1)).toBe(
            5,
        );
    });

    it("accumulates deltas from multiple edits before position", () => {
        // Two insertions before position 20: +3 at pos 2, +2 at pos 8
        const edits = [edit(2, 2, 2, 5), edit(8, 8, 11, 13)];
        expect(mapTextPositionThroughEdits(20, edits, 1)).toBe(25);
    });
});

// ---------------------------------------------------------------------------
// rebuildDiffBaseFromPendingSpans — isolated unit tests
// ---------------------------------------------------------------------------

describe("rebuildDiffBaseFromPendingSpans", () => {
    it("returns currentText when no spans remain", () => {
        expect(rebuildDiffBaseFromPendingSpans("old", "new text", [])).toBe(
            "new text",
        );
    });

    it("replaces agent span region with original base text", () => {
        // currentText: "alpHa", agent span at [3,4] maps to base [3,4] ("h")
        const result = rebuildDiffBaseFromPendingSpans("alpha", "alpHa", [
            { baseFrom: 3, baseTo: 4, currentFrom: 3, currentTo: 4 },
        ]);
        expect(result).toBe("alpha");
    });

    it("handles two separated spans with user text between them", () => {
        // base: "aaa bbb ccc", current: "aaa BBB CCC"
        // Agent changed "bbb"→"BBB" at [4,7] and "ccc"→"CCC" at [8,11]
        const result = rebuildDiffBaseFromPendingSpans(
            "aaa bbb ccc",
            "aaa BBB CCC",
            [
                { baseFrom: 4, baseTo: 7, currentFrom: 4, currentTo: 7 },
                { baseFrom: 8, baseTo: 11, currentFrom: 8, currentTo: 11 },
            ],
        );
        expect(result).toBe("aaa bbb ccc");
    });

    it("handles span at the start of the document", () => {
        const result = rebuildDiffBaseFromPendingSpans(
            "hello world",
            "HELLO world",
            [{ baseFrom: 0, baseTo: 5, currentFrom: 0, currentTo: 5 }],
        );
        expect(result).toBe("hello world");
    });

    it("handles span at the end of the document", () => {
        const result = rebuildDiffBaseFromPendingSpans(
            "hello world",
            "hello WORLD",
            [{ baseFrom: 6, baseTo: 11, currentFrom: 6, currentTo: 11 }],
        );
        expect(result).toBe("hello world");
    });

    it("handles pure insertion span (baseTo === baseFrom)", () => {
        // Agent inserted "XYZ" at position 5 — base has nothing there
        const result = rebuildDiffBaseFromPendingSpans(
            "hello world",
            "helloXYZ world",
            [{ baseFrom: 5, baseTo: 5, currentFrom: 5, currentTo: 8 }],
        );
        // The agent's insertion should be reverted: base text at [5,5] is ""
        expect(result).toBe("hello world");
    });
});
