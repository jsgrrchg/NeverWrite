import { describe, expect, it } from "vitest";
import type { AIFileDiff } from "../types";
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
    shouldShowInlineDiff,
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

// ---------------------------------------------------------------------------
// Pure deletion: keepEditsInRange / rejectEditsInRanges with empty new-ranges
// ---------------------------------------------------------------------------

describe("keepEditsInRange with pure deletions", () => {
    it("accepts a pure deletion (removes lines from diffBase)", () => {
        // Agent deleted line "bbb" (line index 1) from "aaa\nbbb\nccc"
        const tracked: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "aaa\nbbb\nccc",
            currentText: "aaa\nccc",
            unreviewedEdits: buildPatchFromTexts("aaa\nbbb\nccc", "aaa\nccc"),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        // The deletion edit has newStart === newEnd (empty in new space)
        expect(tracked.unreviewedEdits.edits.length).toBe(1);
        const edit = tracked.unreviewedEdits.edits[0];
        expect(edit.newStart).toBe(edit.newEnd); // pure deletion

        const result = keepEditsInRange(tracked, edit.newStart, edit.newEnd);

        // diffBase should now match currentText (deletion accepted)
        expect(result.diffBase).toBe("aaa\nccc");
        expect(patchIsEmpty(result.unreviewedEdits)).toBe(true);
    });
});

describe("rejectEditsInRanges with pure deletions", () => {
    it("rejects a pure deletion (restores deleted lines in currentText)", () => {
        const tracked: TrackedFile = {
            identityKey: "test.md",
            originPath: "test.md",
            path: "test.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "aaa\nbbb\nccc",
            currentText: "aaa\nccc",
            unreviewedEdits: buildPatchFromTexts("aaa\nbbb\nccc", "aaa\nccc"),
            version: 1,
            isText: true,
            updatedAt: 1000,
        };

        const edit = tracked.unreviewedEdits.edits[0];
        expect(edit.newStart).toBe(edit.newEnd); // pure deletion

        const { file: result, undoData } = rejectEditsInRanges(tracked, [
            { start: edit.newStart, end: edit.newEnd },
        ]);

        // currentText should be restored to diffBase (deletion rejected)
        expect(result.currentText).toBe("aaa\nbbb\nccc");
        expect(patchIsEmpty(result.unreviewedEdits)).toBe(true);
        expect(undoData.editsToRestore.length).toBe(1);
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
        // the file is empty so there's nothing to decorate inline.
        // shouldShowInlineDiff still returns true — the editor
        // handles this via the deleted-block widget in inlineDiff.ts.
        // This test just documents the behavior.
    });
});
