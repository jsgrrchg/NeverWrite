import { describe, expect, it } from "vitest";
import type { AIEditedFileBufferEntry, AIFileDiff } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import {
    applyNonConflictingEdits,
    applyRejectUndo,
    buildPatchFromTexts,
    computeRestoreAction,
    consolidateTrackedFiles,
    createTrackedFileFromDiff,
    emptyPatch,
    keepAllEdits,
    keepEditsInRange,
    patchContainsLine,
    patchIsEmpty,
    rangesOverlap,
    rejectAllEdits,
    rejectEditsInRanges,
    trackedFileFromLegacyEntry,
    trackedFileToLegacyEntry,
    updateTrackedFileWithDiff,
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

function lines(text: string): string[] {
    return text.split("\n");
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
        expect(file.unreviewedEdits.edits).toHaveLength(1);
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

    it("absorbs user edit on non-agent line into diffBase", () => {
        // Agent changed line 1 (bbb → BBB)
        // User changes line 0 (aaa → AAA)
        const file = makeTrackedFile("aaa\nbbb\nccc", "aaa\nBBB\nccc");

        const userEdits = [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }];
        const newFullText = "AAA\nBBB\nccc";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        // diffBase should absorb the user's edit
        expect(result.diffBase).toBe("AAA\nbbb\nccc");
        expect(result.currentText).toBe("AAA\nBBB\nccc");
        // Agent's edit (line 1) should still be in unreviewedEdits
        expect(result.unreviewedEdits.edits).toHaveLength(1);
        expect(patchContainsLine(result.unreviewedEdits, 1)).toBe(true);
    });

    it("ignores user edit on agent-modified line", () => {
        // Agent changed line 1 (bbb → BBB)
        // User also tries to change line 1
        const file = makeTrackedFile("aaa\nbbb\nccc", "aaa\nBBB\nccc");

        const userEdits = [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }];
        const newFullText = "aaa\nXXX\nccc";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        // diffBase should NOT absorb the user's edit (conflict)
        expect(result.diffBase).toBe("aaa\nbbb\nccc");
    });

    it("handles user edit after agent range", () => {
        // Agent changed line 0 (aaa → AAA)
        // User changes line 2 (ccc → CCC) — no conflict
        const file = makeTrackedFile("aaa\nbbb\nccc", "AAA\nbbb\nccc");

        const userEdits = [{ oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 3 }];
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
            { oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }, // aaa → AAA (ok)
            { oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 3 }, // CCC → XXX (conflict)
            { oldStart: 3, oldEnd: 4, newStart: 3, newEnd: 4 }, // ddd → DDD (ok)
        ];
        const newFullText = "AAA\nbbb\nXXX\nDDD";

        const result = applyNonConflictingEdits(file, userEdits, newFullText);

        // Only non-conflicting edits absorbed
        expect(lines(result.diffBase)).toContain("AAA");
        expect(lines(result.diffBase)).toContain("DDD");
        // Original "ccc" still in diffBase (conflict edit ignored)
        expect(lines(result.diffBase)).toContain("ccc");
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
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            "AAA\nbbb",
        );

        expect(result.currentText).toBe("AAA\nbbb");
        expect(result.version).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// keepAllEdits / keepEditsInRange
// ---------------------------------------------------------------------------

describe("Accept operations", () => {
    it("keepAllEdits clears unreviewedEdits", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        expect(patchIsEmpty(file.unreviewedEdits)).toBe(false);

        const accepted = keepAllEdits(file);
        expect(patchIsEmpty(accepted.unreviewedEdits)).toBe(true);
        expect(accepted.diffBase).toBe(accepted.currentText);
    });

    it("keepEditsInRange accepts only matching edits", () => {
        // Two hunks: line 0 and line 4
        const diff = makeDiff({
            old_text: "aaa\nbbb\nccc\nddd\neee",
            new_text: "AAA\nbbb\nccc\nddd\nEEE",
        });
        const file = createTrackedFileFromDiff(diff, 1000);
        expect(file.unreviewedEdits.edits).toHaveLength(2);

        // Accept only the first hunk (line 0)
        const accepted = keepEditsInRange(file, 0, 1);
        expect(lines(accepted.diffBase)).toContain("AAA");
        // The second hunk should still be unreviewed
        expect(accepted.unreviewedEdits.edits.length).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// rejectAllEdits / rejectEditsInRanges
// ---------------------------------------------------------------------------

describe("Reject operations", () => {
    it("rejectAllEdits reverts to diffBase", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        const { file: rejected, undoData } = rejectAllEdits(file);

        expect(rejected.currentText).toBe(rejected.diffBase);
        expect(patchIsEmpty(rejected.unreviewedEdits)).toBe(true);
        expect(undoData.editsToRestore.length).toBeGreaterThan(0);
    });

    it("rejectEditsInRanges reverts only matching hunks", () => {
        const diff = makeDiff({
            old_text: "aaa\nbbb\nccc\nddd\neee",
            new_text: "AAA\nbbb\nccc\nddd\nEEE",
        });
        const file = createTrackedFileFromDiff(diff, 1000);

        // Reject only line 0 (first hunk)
        const { file: rejected, undoData } = rejectEditsInRanges(file, [
            { start: 0, end: 1 },
        ]);

        // Line 0 should be reverted to "aaa"
        expect(lines(rejected.currentText)[0]).toBe("aaa");
        // Line 4 should still be "EEE" (not rejected)
        expect(lines(rejected.currentText)[4]).toBe("EEE");
        // Undo should capture the rejected agent text
        expect(undoData.editsToRestore).toHaveLength(1);
        expect(undoData.editsToRestore[0].text).toBe("AAA");
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
// Migration: legacy ↔ TrackedFile
// ---------------------------------------------------------------------------

describe("Migration", () => {
    it("trackedFileFromLegacyEntry converts correctly", () => {
        const entry: AIEditedFileBufferEntry = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            operation: "update",
            baseText: "old",
            appliedText: "new",
            reversible: true,
            isText: true,
            supported: true,
            status: "pending",
            appliedHash: "abc",
            currentHash: null,
            additions: 1,
            deletions: 1,
            updatedAt: 1000,
        };

        const file = trackedFileFromLegacyEntry(entry);
        expect(file.identityKey).toBe("test.md");
        expect(file.diffBase).toBe("old");
        expect(file.currentText).toBe("new");
        expect(file.status).toEqual({ kind: "modified" });
        expect(file.unreviewedEdits.edits).toHaveLength(1);
    });

    it("trackedFileToLegacyEntry converts back", () => {
        const diff = makeDiff();
        const file = createTrackedFileFromDiff(diff, 1000);
        const entry = trackedFileToLegacyEntry(file);

        expect(entry.identityKey).toBe("test.md");
        expect(entry.baseText).toBe(file.diffBase);
        expect(entry.appliedText).toBe(file.currentText);
        expect(entry.operation).toBe("update");
        expect(entry.status).toBe("pending");
        expect(entry.supported).toBe(true);
        // additions/deletions computed from unreviewedEdits
        expect(entry.additions).toBe(1);
        expect(entry.deletions).toBe(1);
    });

    it("roundtrip preserves key data", () => {
        const diff = makeDiff({ kind: "add", old_text: null, new_text: "new" });
        const file = createTrackedFileFromDiff(diff, 1000);
        const entry = trackedFileToLegacyEntry(file);
        const roundtripped = trackedFileFromLegacyEntry(entry);

        expect(roundtripped.diffBase).toBe(file.diffBase);
        expect(roundtripped.currentText).toBe(file.currentText);
        expect(roundtripped.status.kind).toBe(file.status.kind);
    });

    it("trackedFileToLegacyEntry includes hunks from unreviewedEdits", () => {
        const diff = makeDiff({
            old_text: "aaa\nbbb\nccc\nddd\neee",
            new_text: "AAA\nbbb\nccc\nddd\nEEE",
        });
        const file = createTrackedFileFromDiff(diff, 1000);
        const entry = trackedFileToLegacyEntry(file);

        expect(entry.hunks).toBeDefined();
        expect(entry.hunks).toHaveLength(2);

        // First hunk: line 0 changed (aaa → AAA)
        const h0 = entry.hunks![0];
        expect(h0.old_start).toBe(1); // 1-based
        expect(h0.old_count).toBe(1);
        expect(h0.new_start).toBe(1);
        expect(h0.new_count).toBe(1);
        expect(h0.lines).toEqual([
            { type: "remove", text: "aaa" },
            { type: "add", text: "AAA" },
        ]);

        // Second hunk: line 4 changed (eee → EEE)
        const h1 = entry.hunks![1];
        expect(h1.old_start).toBe(5); // 1-based
        expect(h1.old_count).toBe(1);
        expect(h1.new_start).toBe(5);
        expect(h1.new_count).toBe(1);
        expect(h1.lines).toEqual([
            { type: "remove", text: "eee" },
            { type: "add", text: "EEE" },
        ]);
    });

    it("trackedFileToLegacyEntry omits hunks when no unreviewed edits", () => {
        const file = createTrackedFileFromDiff(makeDiff(), 1000);
        const accepted = keepAllEdits(file);
        const entry = trackedFileToLegacyEntry(accepted);

        expect(entry.hunks).toBeUndefined();
    });

    it("hunks enable large file interactive diff (>700 lines)", () => {
        // Generate a large file (800 lines) with a single change at line 400
        const largeLines = Array.from({ length: 800 }, (_, i) => `line-${i}`);
        const oldText = largeLines.join("\n");
        const newLines = [...largeLines];
        newLines[400] = "MODIFIED-400";
        const newText = newLines.join("\n");

        const diff = makeDiff({ old_text: oldText, new_text: newText });
        const file = createTrackedFileFromDiff(diff, 1000);
        const entry = trackedFileToLegacyEntry(file);

        // The entry has hunks, so reviewDiff.ts will use buildExactHunkData
        // instead of LCS, bypassing the 700-line limit
        expect(entry.hunks).toBeDefined();
        expect(entry.hunks).toHaveLength(1);
        expect(entry.hunks![0].old_start).toBe(401); // 1-based
        expect(entry.hunks![0].lines).toEqual([
            { type: "remove", text: "line-400" },
            { type: "add", text: "MODIFIED-400" },
        ]);
    });
});

// ---------------------------------------------------------------------------
// computeRestoreAction (lifecycle-aware)
// ---------------------------------------------------------------------------

describe("computeRestoreAction", () => {
    it("returns delete for agent-created file with no previous content", () => {
        const file = createTrackedFileFromDiff(
            makeDiff({ kind: "add", old_text: null, new_text: "new" }),
            1000,
        );
        const action = computeRestoreAction(file);
        expect(action).toEqual({ kind: "delete" });
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
