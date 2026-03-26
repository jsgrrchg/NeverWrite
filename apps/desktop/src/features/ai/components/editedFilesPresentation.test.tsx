import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { computeDiffLines, computeFileDiffStats } from "../diff/reviewDiff";
import { DiffLineView } from "./editedFilesPresentation";

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

describe("DiffLineView", () => {
    it("renders unwrapped code lines when line wrapping is disabled", () => {
        render(
            <DiffLineView
                line={{
                    type: "add",
                    text: "const example = newVeryLongValueWithoutWrapping;",
                    newLineNumber: 12,
                }}
                lineWrapping={false}
            />,
        );

        const row = screen
            .getByText("const example = newVeryLongValueWithoutWrapping;")
            .closest("[data-diff-line]");
        expect(row).not.toBeNull();
        expect(row).toHaveAttribute("data-line-wrapping", "false");
        expect(row).toHaveStyle({
            whiteSpace: "pre",
            wordBreak: "normal",
            overflowWrap: "normal",
        });
    });

    it("keeps wrapped diff lines in the default mode", () => {
        render(
            <DiffLineView
                line={{
                    type: "add",
                    text: "const example = wrapped;",
                    newLineNumber: 7,
                }}
            />,
        );

        const row = screen
            .getByText("const example = wrapped;")
            .closest("[data-diff-line]");
        expect(row).not.toBeNull();
        expect(row).toHaveAttribute("data-line-wrapping", "true");
        expect(row).toHaveStyle({
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
        });
    });
});
