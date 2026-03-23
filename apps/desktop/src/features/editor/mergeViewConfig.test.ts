import { describe, expect, it } from "vitest";
import type { ReviewProjectionInlineState } from "../ai/diff/reviewProjection";
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

function makeProjectionState(
    overrides: Partial<ReviewProjectionInlineState> = {},
): ReviewProjectionInlineState {
    return {
        reviewProjectionReady: true,
        hasAmbiguousChunks: false,
        hasConflicts: false,
        hasMultiHunkChunks: false,
        ...overrides,
    };
}

describe("mergeViewConfig", () => {
    it("keeps small finalized diffs fully inline", () => {
        expect(
            getMergePresentationFlags(
                makePresentation({ level: "small" }),
                makeProjectionState(),
            ),
        ).toEqual({
            allowInlineDiffs: true,
            enableControls: true,
            highlightChanges: true,
            showControlWidgets: true,
            syntaxHighlightDeletions: true,
            syntaxHighlightDeletionsMaxLength: 3000,
        });
    });

    it("degrades large presentations to non-destructive inline widgets", () => {
        expect(
            getMergePresentationFlags(
                makePresentation({ level: "large" }),
                makeProjectionState(),
            ),
        ).toEqual({
            allowInlineDiffs: false,
            enableControls: false,
            highlightChanges: true,
            showControlWidgets: true,
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
            makeProjectionState(),
        );

        expect(flags.enableControls).toBe(false);
        expect(flags.allowInlineDiffs).toBe(true);
        expect(flags.showControlWidgets).toBe(false);
    });

    it("keeps chunk-level actions available even when some chunks are ambiguous or conflicting", () => {
        const ambiguousFlags = getMergePresentationFlags(
            makePresentation({ level: "medium" }),
            makeProjectionState({ hasAmbiguousChunks: true }),
        );
        const conflictFlags = getMergePresentationFlags(
            makePresentation({ level: "medium" }),
            makeProjectionState({ hasConflicts: true }),
        );

        expect(ambiguousFlags.enableControls).toBe(true);
        expect(ambiguousFlags.showControlWidgets).toBe(true);
        expect(conflictFlags.enableControls).toBe(true);
        expect(conflictFlags.showControlWidgets).toBe(true);
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
