import { describe, expect, it } from "vitest";
import { computeDiffLines, computeFileDiffStats } from "../diff/reviewDiff";

describe("editedFilesPresentation", () => {
    it("does not invent line changes for empty added files", () => {
        const diff = {
            path: "/vault/empty.txt",
            kind: "add" as const,
            old_text: null,
            new_text: "",
        };

        expect(computeFileDiffStats(diff)).toEqual({
            additions: 0,
            deletions: 0,
        });
        expect(computeDiffLines(diff)).toEqual([]);
    });

    it("does not invent line changes for empty deleted files", () => {
        const diff = {
            path: "/vault/empty.txt",
            kind: "delete" as const,
            reversible: true,
            old_text: "",
            new_text: null,
        };

        expect(computeFileDiffStats(diff)).toEqual({
            additions: 0,
            deletions: 0,
        });
        expect(computeDiffLines(diff)).toEqual([]);
    });
});
