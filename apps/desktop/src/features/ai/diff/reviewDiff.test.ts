import { describe, expect, it } from "vitest";
import {
    clampDiffZoom,
    computeChangeHunks,
    computeDecisionHunks,
    computeDiffLines,
    computeDiffStats,
    computeFileDiffStats,
    computeMergedText,
    computeVisualDiffBlocks,
    computeUnifiedDiffLines,
    createDiffFromEditedFileEntry,
    formatDiffStat,
    getCompactPath,
    getFileNameFromPath,
    groupDiffLinesIntoHunks,
    stepDiffZoom,
    DIFF_ZOOM_MAX,
    DIFF_ZOOM_MIN,
} from "./reviewDiff";
import type { AIEditedFileBufferEntry, AIFileDiff } from "../types";

describe("reviewDiff", () => {
    // -----------------------------------------------------------------------
    // computeDiffLines
    // -----------------------------------------------------------------------

    describe("computeDiffLines", () => {
        it("returns add lines for new files", () => {
            const diff: AIFileDiff = {
                path: "new.md",
                kind: "add",
                new_text: "hello\nworld",
            };
            const lines = computeDiffLines(diff);
            expect(lines).toEqual([
                { type: "add", prefix: "+ ", text: "hello" },
                { type: "add", prefix: "+ ", text: "world" },
            ]);
        });

        it("returns remove lines for deleted files", () => {
            const diff: AIFileDiff = {
                path: "old.md",
                kind: "delete",
                reversible: true,
                old_text: "foo\nbar",
            };
            const lines = computeDiffLines(diff);
            expect(lines).toEqual([
                { type: "remove", prefix: "- ", text: "foo" },
                { type: "remove", prefix: "- ", text: "bar" },
            ]);
        });

        it("returns separator for irreversible deletes", () => {
            const diff: AIFileDiff = {
                path: "gone.md",
                kind: "delete",
                reversible: false,
                old_text: null,
            };
            const lines = computeDiffLines(diff);
            expect(lines).toHaveLength(1);
            expect(lines[0].type).toBe("separator");
        });

        it("returns empty for binary diffs", () => {
            const diff: AIFileDiff = {
                path: "img.png",
                kind: "update",
                is_text: false,
            };
            expect(computeDiffLines(diff)).toEqual([]);
        });

        it("returns empty for pure moves", () => {
            const diff: AIFileDiff = {
                path: "b.md",
                kind: "move",
                previous_path: "a.md",
                old_text: "same",
                new_text: "same",
            };
            expect(computeDiffLines(diff)).toEqual([]);
        });

        it("returns empty for empty added files", () => {
            const diff: AIFileDiff = {
                path: "empty.txt",
                kind: "add",
                old_text: null,
                new_text: "",
            };
            expect(computeDiffLines(diff)).toEqual([]);
        });

        it("computes context + changed lines for updates", () => {
            const diff: AIFileDiff = {
                path: "test.md",
                kind: "update",
                old_text: "a\nb\nc",
                new_text: "a\nB\nc",
            };
            const lines = computeDiffLines(diff);
            const types = lines.map((l) => l.type);
            expect(types).toContain("context");
            expect(types).toContain("remove");
            expect(types).toContain("add");
        });

        it("uses exact hunk line numbers when available", () => {
            const diff: AIFileDiff = {
                path: "exact.md",
                kind: "update",
                old_text: "ignored",
                new_text: "ignored",
                hunks: [
                    {
                        old_start: 10,
                        old_count: 2,
                        new_start: 10,
                        new_count: 2,
                        lines: [
                            { type: "context", text: "alpha" },
                            { type: "remove", text: "beta" },
                            { type: "add", text: "BETA" },
                        ],
                    },
                    {
                        old_start: 20,
                        old_count: 1,
                        new_start: 21,
                        new_count: 2,
                        lines: [
                            { type: "remove", text: "tail" },
                            { type: "add", text: "tail" },
                            { type: "add", text: "extra" },
                        ],
                    },
                ],
            };

            expect(computeDiffLines(diff)).toEqual([
                {
                    type: "context",
                    prefix: "",
                    text: "alpha",
                    oldLineNumber: 10,
                    newLineNumber: 10,
                    exact: true,
                    hunkIndex: 0,
                    decisionHunkIndex: 0,
                    visualBlockIndex: 0,
                },
                {
                    type: "remove",
                    prefix: "",
                    text: "beta",
                    oldLineNumber: 11,
                    newLineNumber: null,
                    exact: true,
                    hunkIndex: 0,
                    decisionHunkIndex: 0,
                    visualBlockIndex: 0,
                },
                {
                    type: "add",
                    prefix: "",
                    text: "BETA",
                    oldLineNumber: null,
                    newLineNumber: 11,
                    exact: true,
                    hunkIndex: 0,
                    decisionHunkIndex: 0,
                    visualBlockIndex: 0,
                },
                {
                    type: "separator",
                    prefix: "",
                    text: "···",
                    oldLineNumber: null,
                    newLineNumber: null,
                    exact: true,
                },
                {
                    type: "remove",
                    prefix: "",
                    text: "tail",
                    oldLineNumber: 20,
                    newLineNumber: null,
                    exact: true,
                    hunkIndex: 1,
                    decisionHunkIndex: 1,
                    visualBlockIndex: 1,
                },
                {
                    type: "add",
                    prefix: "",
                    text: "tail",
                    oldLineNumber: null,
                    newLineNumber: 21,
                    exact: true,
                    hunkIndex: 1,
                    decisionHunkIndex: 1,
                    visualBlockIndex: 1,
                },
                {
                    type: "add",
                    prefix: "",
                    text: "extra",
                    oldLineNumber: null,
                    newLineNumber: 22,
                    exact: true,
                    hunkIndex: 1,
                    decisionHunkIndex: 1,
                    visualBlockIndex: 1,
                },
            ]);
        });

        it("parses unified diff text into exact lines", () => {
            expect(
                computeUnifiedDiffLines(
                    [
                        "--- a/test.md",
                        "+++ b/test.md",
                        "@@ -10,2 +10,3 @@",
                        " alpha",
                        "-beta",
                        "+BETA",
                        " gamma",
                    ].join("\n"),
                ),
            ).toEqual([
                {
                    type: "context",
                    prefix: "",
                    text: "alpha",
                    oldLineNumber: 10,
                    newLineNumber: 10,
                    exact: true,
                    hunkIndex: 0,
                    decisionHunkIndex: 0,
                    visualBlockIndex: 0,
                },
                {
                    type: "remove",
                    prefix: "",
                    text: "beta",
                    oldLineNumber: 11,
                    newLineNumber: null,
                    exact: true,
                    hunkIndex: 0,
                    decisionHunkIndex: 0,
                    visualBlockIndex: 0,
                },
                {
                    type: "add",
                    prefix: "",
                    text: "BETA",
                    oldLineNumber: null,
                    newLineNumber: 11,
                    exact: true,
                    hunkIndex: 0,
                    decisionHunkIndex: 0,
                    visualBlockIndex: 0,
                },
                {
                    type: "context",
                    prefix: "",
                    text: "gamma",
                    oldLineNumber: 12,
                    newLineNumber: 12,
                    exact: true,
                    hunkIndex: 0,
                    decisionHunkIndex: 0,
                    visualBlockIndex: 0,
                },
            ]);
        });
    });

    describe("groupDiffLinesIntoHunks", () => {
        it("merges nearby change windows into a single visual hunk", () => {
            const baseText = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl";
            const appliedText = "a\nb\nC\nd\ne\nf\ng\nH\ni\nj\nk\nl";

            const result = groupDiffLinesIntoHunks(baseText, appliedText);

            expect(result.decisionHunks).toHaveLength(2);
            expect(result.visualBlocks).toHaveLength(1);
            expect(result.hunks).toHaveLength(1);
            expect(result.visualBlocks[0].decisionHunkIndexes).toEqual([0, 1]);
            expect(
                new Set(
                    result.visualBlocks[0].lines.map((line) => line.hunkIndex),
                ),
            ).toEqual(new Set([0]));
            expect(
                result.visualBlocks[0].lines
                    .filter((line) => line.type !== "context")
                    .map((line) => line.decisionHunkIndex),
            ).toEqual([0, 0, 1, 1]);
            expect(result.visualBlocks[0].oldStart).toBe(2);
            expect(result.visualBlocks[0].oldEnd).toBe(8);
            expect(result.visualBlocks[0].newStart).toBe(2);
            expect(result.visualBlocks[0].newEnd).toBe(8);
        });
    });

    describe("computeChangeHunks", () => {
        it("returns normalized exact hunks when metadata is available", () => {
            const diff: AIFileDiff = {
                path: "exact.md",
                kind: "update",
                hunks: [
                    {
                        old_start: 4,
                        old_count: 2,
                        new_start: 4,
                        new_count: 3,
                        lines: [
                            { type: "context", text: "ctx" },
                            { type: "remove", text: "old" },
                            { type: "add", text: "new" },
                            { type: "add", text: "extra" },
                        ],
                    },
                ],
            };

            expect(computeChangeHunks(diff)).toEqual([
                {
                    index: 0,
                    decisionHunkIndexes: [0],
                    lines: [
                        {
                            type: "context",
                            prefix: "",
                            text: "ctx",
                            oldLineNumber: 4,
                            newLineNumber: 4,
                            exact: true,
                            hunkIndex: 0,
                            decisionHunkIndex: 0,
                            visualBlockIndex: 0,
                        },
                        {
                            type: "remove",
                            prefix: "",
                            text: "old",
                            oldLineNumber: 5,
                            newLineNumber: null,
                            exact: true,
                            hunkIndex: 0,
                            decisionHunkIndex: 0,
                            visualBlockIndex: 0,
                        },
                        {
                            type: "add",
                            prefix: "",
                            text: "new",
                            oldLineNumber: null,
                            newLineNumber: 5,
                            exact: true,
                            hunkIndex: 0,
                            decisionHunkIndex: 0,
                            visualBlockIndex: 0,
                        },
                        {
                            type: "add",
                            prefix: "",
                            text: "extra",
                            oldLineNumber: null,
                            newLineNumber: 6,
                            exact: true,
                            hunkIndex: 0,
                            decisionHunkIndex: 0,
                            visualBlockIndex: 0,
                        },
                    ],
                    oldStart: 3,
                    oldEnd: 5,
                    newStart: 3,
                    newEnd: 6,
                },
            ]);
        });
    });

    describe("computeDecisionHunks", () => {
        it("returns raw decision hunks without collapsing nearby changes", () => {
            const diff: AIFileDiff = {
                path: "nearby.md",
                kind: "update",
                old_text: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
                new_text: "a\nb\nC\nd\ne\nf\ng\nH\ni\nj\nk\nl",
            };

            expect(computeDecisionHunks(diff)).toEqual([
                {
                    index: 0,
                    oldStart: 2,
                    oldEnd: 3,
                    newStart: 2,
                    newEnd: 3,
                    lines: [
                        {
                            type: "remove",
                            prefix: "- ",
                            text: "c",
                            hunkIndex: 0,
                            decisionHunkIndex: 0,
                            visualBlockIndex: 0,
                        },
                        {
                            type: "add",
                            prefix: "+ ",
                            text: "C",
                            hunkIndex: 0,
                            decisionHunkIndex: 0,
                            visualBlockIndex: 0,
                        },
                    ],
                },
                {
                    index: 1,
                    oldStart: 7,
                    oldEnd: 8,
                    newStart: 7,
                    newEnd: 8,
                    lines: [
                        {
                            type: "remove",
                            prefix: "- ",
                            text: "h",
                            hunkIndex: 1,
                            decisionHunkIndex: 1,
                            visualBlockIndex: 1,
                        },
                        {
                            type: "add",
                            prefix: "+ ",
                            text: "H",
                            hunkIndex: 1,
                            decisionHunkIndex: 1,
                            visualBlockIndex: 1,
                        },
                    ],
                },
            ]);
        });
    });

    describe("computeVisualDiffBlocks", () => {
        it("keeps compatibility by returning merged visual blocks", () => {
            const diff: AIFileDiff = {
                path: "nearby.md",
                kind: "update",
                old_text: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
                new_text: "a\nb\nC\nd\ne\nf\ng\nH\ni\nj\nk\nl",
            };

            expect(computeVisualDiffBlocks(diff)).toHaveLength(1);
            expect(computeChangeHunks(diff)).toEqual(
                computeVisualDiffBlocks(diff),
            );
        });
    });

    describe("computeMergedText", () => {
        it("merges accepted and rejected hunks back into a single document", () => {
            const baseText = [
                "l1",
                "l2",
                "l3",
                "l4",
                "l5",
                "l6",
                "l7",
                "l8",
                "l9",
                "l10",
                "l11",
                "l12",
                "l13",
                "l14",
                "l15",
                "l16",
                "l17",
                "l18",
                "l19",
                "l20",
            ].join("\n");
            const appliedText = [
                "l1",
                "L2",
                "l3",
                "l4",
                "l5",
                "l6",
                "l7",
                "l8",
                "l9",
                "l10",
                "l11",
                "l12",
                "l13",
                "l14",
                "l15",
                "l16",
                "l17",
                "L18",
                "l19",
                "l20",
            ].join("\n");

            const { decisionHunks } = groupDiffLinesIntoHunks(
                baseText,
                appliedText,
            );
            const merged = computeMergedText(
                baseText,
                appliedText,
                decisionHunks,
                new Map([
                    [0, "accepted"],
                    [1, "rejected"],
                ]),
            );

            expect(merged).toBe(
                [
                    "l1",
                    "L2",
                    "l3",
                    "l4",
                    "l5",
                    "l6",
                    "l7",
                    "l8",
                    "l9",
                    "l10",
                    "l11",
                    "l12",
                    "l13",
                    "l14",
                    "l15",
                    "l16",
                    "l17",
                    "l18",
                    "l19",
                    "l20",
                ].join("\n"),
            );
        });
    });

    // -----------------------------------------------------------------------
    // computeFileDiffStats / computeDiffStats
    // -----------------------------------------------------------------------

    describe("computeFileDiffStats", () => {
        it("counts additions for new files", () => {
            const diff: AIFileDiff = {
                path: "new.md",
                kind: "add",
                new_text: "a\nb\nc",
            };
            expect(computeFileDiffStats(diff)).toEqual({
                additions: 3,
                deletions: 0,
            });
        });

        it("counts deletions for deleted files", () => {
            const diff: AIFileDiff = {
                path: "old.md",
                kind: "delete",
                reversible: true,
                old_text: "x\ny",
            };
            expect(computeFileDiffStats(diff)).toEqual({
                additions: 0,
                deletions: 2,
            });
        });

        it("returns approximate for irreversible deletes", () => {
            const diff: AIFileDiff = {
                path: "gone.md",
                kind: "delete",
                reversible: false,
            };
            expect(computeFileDiffStats(diff)).toEqual({
                additions: 0,
                deletions: 0,
                approximate: true,
            });
        });

        it("returns zero for binary files", () => {
            const diff: AIFileDiff = {
                path: "img.png",
                kind: "update",
                is_text: false,
            };
            expect(computeFileDiffStats(diff)).toEqual({
                additions: 0,
                deletions: 0,
            });
        });

        it("uses exact hunk metadata when available", () => {
            const diff: AIFileDiff = {
                path: "exact.md",
                kind: "update",
                old_text: "ignored",
                new_text: "ignored",
                hunks: [
                    {
                        old_start: 8,
                        old_count: 2,
                        new_start: 8,
                        new_count: 3,
                        lines: [
                            { type: "context", text: "ctx" },
                            { type: "remove", text: "old" },
                            { type: "add", text: "new" },
                            { type: "add", text: "extra" },
                        ],
                    },
                ],
            };

            expect(computeFileDiffStats(diff)).toEqual({
                additions: 2,
                deletions: 1,
            });
        });

        it("does not invent line changes for empty added files", () => {
            const diff: AIFileDiff = {
                path: "/vault/empty.txt",
                kind: "add",
                old_text: null,
                new_text: "",
            };
            expect(computeFileDiffStats(diff)).toEqual({
                additions: 0,
                deletions: 0,
            });
        });

        it("does not invent line changes for empty deleted files", () => {
            const diff: AIFileDiff = {
                path: "/vault/empty.txt",
                kind: "delete",
                reversible: true,
                old_text: "",
                new_text: null,
            };
            expect(computeFileDiffStats(diff)).toEqual({
                additions: 0,
                deletions: 0,
            });
        });
    });

    describe("computeDiffStats", () => {
        it("aggregates multiple diffs", () => {
            const diffs: AIFileDiff[] = [
                { path: "a.md", kind: "add", new_text: "x\ny" },
                {
                    path: "b.md",
                    kind: "delete",
                    reversible: true,
                    old_text: "z",
                },
            ];
            const stats = computeDiffStats(diffs);
            expect(stats.additions).toBe(2);
            expect(stats.deletions).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // formatDiffStat
    // -----------------------------------------------------------------------

    describe("formatDiffStat", () => {
        it("formats exact values", () => {
            expect(formatDiffStat(42)).toBe("42");
        });

        it("prepends ~ for approximate values", () => {
            expect(formatDiffStat(42, true)).toBe("~42");
        });
    });

    // -----------------------------------------------------------------------
    // clampDiffZoom / stepDiffZoom
    // -----------------------------------------------------------------------

    describe("clampDiffZoom", () => {
        it("clamps below min", () => {
            expect(clampDiffZoom(0)).toBe(DIFF_ZOOM_MIN);
        });

        it("clamps above max", () => {
            expect(clampDiffZoom(2)).toBe(DIFF_ZOOM_MAX);
        });

        it("preserves values in range", () => {
            expect(clampDiffZoom(0.8)).toBe(0.8);
        });
    });

    describe("stepDiffZoom", () => {
        it("increments within range", () => {
            const result = stepDiffZoom(0.8, 0.04);
            expect(result).toBe(0.84);
        });

        it("clamps at boundaries", () => {
            const result = stepDiffZoom(DIFF_ZOOM_MAX, 0.04);
            expect(result).toBe(DIFF_ZOOM_MAX);
        });
    });

    // -----------------------------------------------------------------------
    // getFileNameFromPath / getCompactPath
    // -----------------------------------------------------------------------

    describe("getFileNameFromPath", () => {
        it("returns the last segment", () => {
            expect(getFileNameFromPath("/vault/daily/note.md")).toBe("note.md");
        });

        it("returns path itself if no slashes", () => {
            expect(getFileNameFromPath("note.md")).toBe("note.md");
        });
    });

    describe("getCompactPath", () => {
        it("returns full path when short enough", () => {
            expect(getCompactPath("a/b/c")).toBe("a/b/c");
        });

        it("abbreviates long paths", () => {
            expect(getCompactPath("/vault/deep/nested/file.md")).toBe(
                ".../deep/nested/file.md",
            );
        });
    });

    // -----------------------------------------------------------------------
    // createDiffFromEditedFileEntry
    // -----------------------------------------------------------------------

    describe("createDiffFromEditedFileEntry", () => {
        it("creates add diff", () => {
            const entry: AIEditedFileBufferEntry = {
                identityKey: "k1",
                originPath: "/vault/new.md",
                path: "/vault/new.md",
                operation: "add",
                baseText: null,
                appliedText: "content",
                reversible: true,
                isText: true,
                supported: true,
                status: "pending",
                appliedHash: "abc",
                additions: 1,
                deletions: 0,
                updatedAt: Date.now(),
            };
            const diff = createDiffFromEditedFileEntry(entry);
            expect(diff.kind).toBe("add");
            expect(diff.path).toBe("/vault/new.md");
            expect(diff.new_text).toBe("content");
        });

        it("creates move diff when paths differ", () => {
            const entry: AIEditedFileBufferEntry = {
                identityKey: "k2",
                originPath: "/vault/old.md",
                path: "/vault/new.md",
                operation: "update",
                baseText: "old",
                appliedText: "new",
                reversible: true,
                isText: true,
                supported: true,
                status: "pending",
                appliedHash: "def",
                additions: 1,
                deletions: 1,
                updatedAt: Date.now(),
            };
            const diff = createDiffFromEditedFileEntry(entry);
            expect(diff.kind).toBe("move");
            expect(diff.previous_path).toBe("/vault/old.md");
        });

        it("uses previousPath when available", () => {
            const entry: AIEditedFileBufferEntry = {
                identityKey: "k3",
                originPath: "/vault/a.md",
                path: "/vault/a.md",
                previousPath: "/vault/orig.md",
                operation: "update",
                baseText: "x",
                appliedText: "y",
                reversible: true,
                isText: true,
                supported: true,
                status: "pending",
                appliedHash: "ghi",
                additions: 1,
                deletions: 1,
                updatedAt: Date.now(),
            };
            const diff = createDiffFromEditedFileEntry(entry);
            expect(diff.kind).toBe("move");
            expect(diff.previous_path).toBe("/vault/orig.md");
        });

        it("preserves exact hunks from the edited files buffer", () => {
            const entry: AIEditedFileBufferEntry = {
                identityKey: "k4",
                originPath: "/vault/exact.md",
                path: "/vault/exact.md",
                operation: "update",
                baseText: "old",
                appliedText: "new",
                reversible: true,
                isText: true,
                hunks: [
                    {
                        old_start: 4,
                        old_count: 1,
                        new_start: 4,
                        new_count: 1,
                        lines: [{ type: "remove", text: "old" }],
                    },
                ],
                supported: true,
                status: "pending",
                appliedHash: "jkl",
                additions: 1,
                deletions: 1,
                updatedAt: Date.now(),
            };

            const diff = createDiffFromEditedFileEntry(entry);

            expect(diff.hunks).toEqual(entry.hunks);
        });
    });
});
