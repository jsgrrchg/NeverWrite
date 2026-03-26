import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import { describe, expect, it } from "vitest";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
} from "../ai/store/actionLogModel";
import {
    deriveFileChangePresentation,
    deriveMarkersFromChunks,
} from "./changePresentationModel";

function makeTrackedFile(
    diffBase: string,
    currentText: string,
    overrides: Partial<TrackedFile> = {},
): TrackedFile {
    return {
        identityKey: "/vault/test.md",
        originPath: "/vault/test.md",
        path: "/vault/test.md",
        previousPath: null,
        status: { kind: "modified" },
        reviewState: "finalized",
        diffBase,
        currentText,
        unreviewedRanges: buildTextRangePatchFromTexts(diffBase, currentText),
        unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
        version: 1,
        isText: true,
        updatedAt: 1,
        ...overrides,
    };
}

function replaceLines(
    lineCount: number,
    replacements: Record<number, string>,
): string {
    return Array.from(
        { length: lineCount },
        (_, index) => replacements[index] ?? `line-${index}`,
    ).join("\n");
}

function buildMarkers(diffBase: string, currentText: string) {
    return deriveMarkersFromChunks(
        Chunk.build(
            Text.of(diffBase.split("\n")),
            Text.of(currentText.split("\n")),
        ),
        Text.of(currentText.split("\n")),
        "finalized",
    );
}

describe("changePresentationModel", () => {
    it("classifies a compact single hunk as small", () => {
        const presentation = deriveFileChangePresentation(
            makeTrackedFile("alpha beta gamma", "alpha BETA gamma"),
        );

        expect(presentation.level).toBe("small");
        expect(presentation.hunkCount).toBe(1);
        expect(presentation.showInlineActions).toBe(true);
        expect(presentation.showWordDiff).toBe(true);
        expect(presentation.preferReview).toBe(false);
    });

    it("classifies moderate scattered changes as medium", () => {
        const diffBase = replaceLines(20, {});
        const currentText = replaceLines(20, {
            1: "changed-1",
            5: "changed-5",
            9: "changed-9",
            13: "changed-13",
        });

        const presentation = deriveFileChangePresentation(
            makeTrackedFile(diffBase, currentText),
        );

        expect(presentation.level).toBe("medium");
        expect(presentation.hunkCount).toBe(4);
        expect(presentation.totalChangedLines).toBe(4);
        expect(presentation.showInlineActions).toBe(true);
        expect(presentation.showWordDiff).toBe(true);
    });

    it("classifies many hunks as large and collapses long deletes", () => {
        const diffBase = [
            "keep-0",
            "remove-1",
            "remove-2",
            "remove-3",
            "remove-4",
            "remove-5",
            "remove-6",
            "remove-7",
            "remove-8",
            "remove-9",
            "keep-10",
        ].join("\n");
        const currentText = ["keep-0", "keep-10"].join("\n");

        const presentation = deriveFileChangePresentation(
            makeTrackedFile(diffBase, currentText),
        );

        expect(presentation.level).toBe("large");
        expect(presentation.preferReview).toBe(true);
        expect(presentation.showInlineActions).toBe(false);
        expect(presentation.showWordDiff).toBe(false);
        expect(presentation.collapseLargeDeletes).toBe(true);
        expect(presentation.collapsedDeleteBlockIndexes).toEqual([0]);
    });

    it("classifies very large diffs from total changed lines", () => {
        const diffBase = replaceLines(240, {});
        const currentText = replaceLines(
            240,
            Object.fromEntries(
                Array.from({ length: 210 }, (_, index) => [
                    index,
                    `changed-${index}`,
                ]),
            ),
        );

        const presentation = deriveFileChangePresentation(
            makeTrackedFile(diffBase, currentText),
        );

        expect(presentation.level).toBe("very-large");
        expect(presentation.preferReview).toBe(true);
        expect(presentation.showInlineActions).toBe(false);
        expect(presentation.showWordDiff).toBe(false);
    });

    it("derives add markers from merge chunks", () => {
        const markers = buildMarkers("alpha\nbeta", "alpha\nbeta\nnew line");

        expect(markers).toHaveLength(1);
        expect(markers[0]?.kind).toBe("add");
        expect(markers[0]?.startLine).toBe(2);
        expect(markers[0]?.endLine).toBe(3);
    });

    it("derives add markers from merge chunks for modified lines", () => {
        const markers = buildMarkers("alpha\nbeta", "alpha\nBETA");

        expect(markers).toHaveLength(1);
        expect(markers[0]?.kind).toBe("add");
        expect(markers[0]?.heightRatio).toBeGreaterThan(0);
    });

    it("derives delete markers from merge chunks", () => {
        const markers = buildMarkers("alpha\nbeta\ngamma", "alpha\ngamma");

        expect(markers).toHaveLength(1);
        expect(markers[0]?.kind).toBe("delete");
        expect(markers[0]?.startLine).toBe(1);
        expect(markers[0]?.endLine).toBe(1);
    });

    it("keeps add markers stable at EOF", () => {
        const markers = buildMarkers("alpha\nbeta", "alpha\nbeta\ngamma");

        expect(markers).toHaveLength(1);
        expect(markers[0]?.kind).toBe("add");
        expect(markers[0]?.startLine).toBe(2);
        expect(markers[0]?.endLine).toBe(3);
    });

    it("keeps delete markers stable near EOF", () => {
        const markers = buildMarkers("alpha\nbeta\ngamma", "alpha\nbeta");

        expect(markers).toHaveLength(1);
        expect(markers[0]?.kind).toBe("delete");
        expect(markers[0]?.startLine).toBe(2);
        expect(markers[0]?.endLine).toBe(2);
    });

    it("suppresses inline actions while review is pending", () => {
        const presentation = deriveFileChangePresentation(
            makeTrackedFile("alpha", "alpHa", {
                reviewState: "pending",
            }),
        );

        expect(presentation.reviewState).toBe("pending");
        expect(presentation.showInlineActions).toBe(false);
        expect(presentation.showWordDiff).toBe(true);
    });
});
