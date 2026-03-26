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
        projectionState: "projection_ready",
        reviewProjectionReady: true,
        hasAmbiguousChunks: false,
        hasConflicts: false,
        hasMultiHunkChunks: false,
        totalLines: 0,
        hunkCount: 0,
        chunkCount: 0,
        visibleChunkCount: 0,
        invalidChunkCount: 0,
        inlineSafeChunkCount: 0,
        degradedChunkCount: 0,
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

    it("keeps exact inline actions available for large presentations", () => {
        expect(
            getMergePresentationFlags(
                makePresentation({ level: "large" }),
                makeProjectionState(),
            ),
        ).toEqual({
            allowInlineDiffs: false,
            enableControls: true,
            highlightChanges: true,
            showControlWidgets: true,
            syntaxHighlightDeletions: true,
            syntaxHighlightDeletionsMaxLength: 3000,
        });
    });

    it("keeps controls available while review is pending", () => {
        const flags = getMergePresentationFlags(
            makePresentation({
                level: "medium",
                reviewState: "pending",
            }),
            makeProjectionState(),
        );

        expect(flags.enableControls).toBe(true);
        expect(flags.allowInlineDiffs).toBe(true);
        expect(flags.showControlWidgets).toBe(true);
    });

    it("keeps controls available for very-large files", () => {
        const flags = getMergePresentationFlags(
            makePresentation({
                level: "very-large",
                reviewState: "pending",
            }),
            makeProjectionState(),
        );

        expect(flags.enableControls).toBe(true);
        expect(flags.showControlWidgets).toBe(true);
        expect(flags.allowInlineDiffs).toBe(false);
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
            inlineState: "projection_ready",
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
            inlineState: "projection_ready",
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
            inlineState: "projection_ready",
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
            inlineState: "projection_ready",
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
