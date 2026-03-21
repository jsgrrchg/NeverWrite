import { describe, expect, it } from "vitest";
import type { FileChangePresentation } from "./changePresentationModel";
import {
    buildMergeStructuralSignature,
    getMergePresentationFlags,
} from "./mergeViewConfig";

function makePresentation(
    overrides: Partial<FileChangePresentation>,
): FileChangePresentation {
    return {
        level: "small",
        reviewState: "finalized",
        hunkCount: 1,
        totalChangedLines: 1,
        largestHunkLines: 1,
        additions: 1,
        deletions: 0,
        preferReview: false,
        showInlineActions: true,
        showWordDiff: true,
        collapseLargeDeletes: false,
        reducedInlineMode: false,
        collapsedDeleteBlockIndexes: [],
        ...overrides,
    };
}

describe("mergeViewConfig", () => {
    it("keeps small finalized diffs fully inline", () => {
        expect(
            getMergePresentationFlags(makePresentation({ level: "small" })),
        ).toEqual({
            allowInlineDiffs: true,
            enableControls: true,
            highlightChanges: true,
            syntaxHighlightDeletions: true,
            syntaxHighlightDeletionsMaxLength: 3000,
        });
    });

    it("disables inline diffs for large presentations", () => {
        expect(
            getMergePresentationFlags(makePresentation({ level: "large" })),
        ).toEqual({
            allowInlineDiffs: false,
            enableControls: true,
            highlightChanges: true,
            syntaxHighlightDeletions: true,
            syntaxHighlightDeletionsMaxLength: 3000,
        });
    });

    it("disables controls while review is pending", () => {
        const flags = getMergePresentationFlags(
            makePresentation({
                level: "medium",
                reviewState: "pending",
            }),
        );

        expect(flags.enableControls).toBe(false);
        expect(flags.allowInlineDiffs).toBe(true);
    });

    it("includes merge-critical fields in the structural signature", () => {
        const a = buildMergeStructuralSignature({
            identityKey: "note.md",
            level: "medium",
            mode: "source",
            reviewState: "finalized",
            sessionId: "session-1",
            shouldShowMerge: true,
            statusKind: "modified",
            trackedVersion: 1,
        });
        const b = buildMergeStructuralSignature({
            identityKey: "note.md",
            level: "large",
            mode: "source",
            reviewState: "finalized",
            sessionId: "session-1",
            shouldShowMerge: true,
            statusKind: "modified",
            trackedVersion: 1,
        });

        expect(a).not.toBe(b);
    });

    it("includes tracked version in the structural signature", () => {
        const a = buildMergeStructuralSignature({
            identityKey: "note.md",
            level: "medium",
            mode: "source",
            reviewState: "finalized",
            sessionId: "session-1",
            shouldShowMerge: true,
            statusKind: "modified",
            trackedVersion: 1,
        });
        const b = buildMergeStructuralSignature({
            identityKey: "note.md",
            level: "medium",
            mode: "source",
            reviewState: "finalized",
            sessionId: "session-1",
            shouldShowMerge: true,
            statusKind: "modified",
            trackedVersion: 2,
        });

        expect(a).not.toBe(b);
    });
});
