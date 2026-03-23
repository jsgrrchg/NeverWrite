import type { EditorView } from "@codemirror/view";
import { Change } from "@codemirror/merge";
import { useChatStore } from "../ai/store/chatStore";
import type { AgentTextSpan } from "../ai/diff/actionLogTypes";
import {
    buildReviewProjection,
    summarizeReviewProjectionInlineState,
    type ReviewProjection,
    type ReviewProjectionInlineState,
} from "../ai/diff/reviewProjection";
import type { AIChatSession } from "../ai/types";
import { deriveFileChangePresentation } from "./changePresentationModel";
import {
    buildMergeStructuralSignature,
    getMergePresentationFlags,
} from "./mergeViewConfig";
import {
    buildReplaceOriginalDocEffect,
    createMergeViewExtension,
    mergeControlsSignatureFacet,
    mergeEnabledFacet,
    mergeIdentityKeyFacet,
    mergeLevelFacet,
    mergeReviewStateFacet,
    mergeStatusKindFacet,
    mergeSessionIdFacet,
    mergeTrackedVersionFacet,
    mergeViewCompartment,
    setLastDispatchedDiffBase,
} from "./extensions/mergeViewDiff";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";

export function syncMergeViewForPaths(
    view: EditorView | null,
    candidatePaths: string[],
    sessionsById: Record<string, AIChatSession>,
    options: {
        mode: "source" | "preview";
    } = { mode: "source" },
) {
    if (!view) {
        return;
    }

    const currentSignature = buildMergeStructuralSignature({
        shouldShowMerge: view.state.facet(mergeEnabledFacet),
        sessionId: view.state.facet(mergeSessionIdFacet),
        identityKey: view.state.facet(mergeIdentityKeyFacet),
        trackedVersion: view.state.facet(mergeTrackedVersionFacet),
        reviewState: view.state.facet(mergeReviewStateFacet),
        level: view.state.facet(mergeLevelFacet),
        statusKind: view.state.facet(mergeStatusKindFacet),
        mode: options.mode,
    });
    const currentControlsSignature = view.state.facet(
        mergeControlsSignatureFacet,
    );

    if (candidatePaths.length === 0) {
        reconfigureMergeView(view, currentSignature, {
            shouldShowMerge: false,
            sessionId: null,
            identityKey: null,
            trackedVersion: null,
            reviewState: "finalized",
            level: "small",
            statusKind: null,
            mode: options.mode,
        });
        return;
    }

    const { match } = resolveTrackedFileMatchForPaths(
        candidatePaths,
        sessionsById,
    );
    if (!match || options.mode === "preview") {
        reconfigureMergeView(view, currentSignature, {
            shouldShowMerge: false,
            sessionId: null,
            identityKey: null,
            trackedVersion: null,
            reviewState: "finalized",
            level: "small",
            statusKind: null,
            mode: options.mode,
        });
        return;
    }

    const { trackedFile, sessionId } = match;
    const presentation = deriveFileChangePresentation(trackedFile);
    const reviewProjection = buildReviewProjectionSafely(trackedFile);
    const nextControlsSignature = buildMergeControlsSignature(reviewProjection);
    const nextSignature = buildMergeStructuralSignature({
        shouldShowMerge: true,
        sessionId,
        identityKey: trackedFile.identityKey,
        trackedVersion: trackedFile.version,
        reviewState: presentation.reviewState,
        level: presentation.level,
        statusKind: trackedFile.status.kind,
        mode: options.mode,
    });

    if (
        currentSignature !== nextSignature ||
        currentControlsSignature !== nextControlsSignature
    ) {
        const projectionState = reviewProjection
            ? summarizeReviewProjectionInlineState(reviewProjection)
            : EMPTY_INLINE_STATE;
        const flags = getMergePresentationFlags(presentation, projectionState);
        // CodeMirror normalizes \r\n → \n, so raw string lengths can exceed
        // the internal document length. Use normalized lengths for clamping.
        const normalizedOriginalLength = countNormalizedLength(
            trackedFile.diffBase,
        );
        const currentLength = Math.min(
            view.state.doc.length,
            countNormalizedLength(trackedFile.currentText),
        );
        try {
            view.dispatch({
                effects: mergeViewCompartment.reconfigure(
                    createMergeViewExtension({
                        original: trackedFile.diffBase,
                        diffChanges: buildMergeDiffChanges(
                            trackedFile.unreviewedRanges?.spans ?? [],
                            normalizedOriginalLength,
                            currentLength,
                        ),
                        trackedVersion: trackedFile.version,
                        sessionId,
                        identityKey: trackedFile.identityKey,
                        controlsSignature: nextControlsSignature,
                        reviewState: presentation.reviewState,
                        level: presentation.level,
                        statusKind: trackedFile.status.kind,
                        highlightChanges: flags.highlightChanges,
                        allowInlineDiffs: flags.allowInlineDiffs,
                        enableControls: flags.enableControls,
                        showControlWidgets: flags.showControlWidgets,
                        syntaxHighlightDeletions:
                            flags.syntaxHighlightDeletions,
                        syntaxHighlightDeletionsMaxLength:
                            flags.syntaxHighlightDeletionsMaxLength,
                        reviewHunks: reviewProjection?.hunks ?? [],
                        reviewChunks: reviewProjection?.chunks ?? [],
                        onDecision: ({
                            decision,
                            hunkIds,
                            view: mergeView,
                        }) => {
                            const liveSessionId =
                                mergeView.state.facet(mergeSessionIdFacet);
                            const liveIdentityKey = mergeView.state.facet(
                                mergeIdentityKeyFacet,
                            );
                            if (!liveSessionId || !liveIdentityKey) {
                                return;
                            }

                            void useChatStore
                                .getState()
                                .resolveReviewHunks(
                                    liveSessionId,
                                    liveIdentityKey,
                                    decision,
                                    trackedFile.version,
                                    hunkIds,
                                );
                        },
                    }),
                ),
            });
            setLastDispatchedDiffBase(view, trackedFile.diffBase);
        } catch {
            // Position mismatch during state transition (e.g. editor doc not
            // yet updated after reject). The next sync cycle will retry.
        }
        return;
    }

    const effect = buildReplaceOriginalDocEffect(view, trackedFile.diffBase);
    if (effect) {
        view.dispatch({ effects: [effect] });
    }
}

function buildMergeDiffChanges(
    spans: AgentTextSpan[],
    originalLength: number,
    currentLength: number,
) {
    return spans
        .filter(
            (span) =>
                span.baseFrom <= originalLength &&
                span.currentFrom <= currentLength,
        )
        .map(
            (span) =>
                new Change(
                    Math.min(span.baseFrom, originalLength),
                    Math.min(span.baseTo, originalLength),
                    Math.min(span.currentFrom, currentLength),
                    Math.min(span.currentTo, currentLength),
                ),
        );
}

function reconfigureMergeView(
    view: EditorView,
    currentSignature: string,
    nextConfig: Parameters<typeof buildMergeStructuralSignature>[0],
) {
    const nextSignature = buildMergeStructuralSignature(nextConfig);
    if (currentSignature === nextSignature) {
        return;
    }

    view.dispatch({
        effects: mergeViewCompartment.reconfigure([]),
    });
}

function countNormalizedLength(text: string) {
    let len = text.length;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 13 /* \r */) {
            len--;
        }
    }
    return len;
}

function buildMergeControlsSignature(
    reviewProjection: ReviewProjection | null,
): string | null {
    if (!reviewProjection) {
        return null;
    }

    return JSON.stringify({
        chunks: reviewProjection.chunks.map((chunk) => [
            chunk.id.key,
            chunk.startLine,
            chunk.endLine,
            chunk.controlMode,
            chunk.canResolveInlineExactly,
            chunk.hunkIds.map((id) => id.key),
        ]),
        hunks: reviewProjection.hunks.map((hunk) => [
            hunk.id.key,
            hunk.chunkId.key,
            hunk.visualStartLine,
            hunk.visualEndLine,
        ]),
    });
}

const EMPTY_INLINE_STATE: ReviewProjectionInlineState = {
    reviewProjectionReady: false,
    hasAmbiguousChunks: false,
    hasConflicts: false,
    hasMultiHunkChunks: false,
};

function buildReviewProjectionSafely(
    trackedFile: Parameters<typeof buildReviewProjection>[0],
): ReviewProjection | null {
    try {
        return buildReviewProjection(trackedFile);
    } catch {
        return null;
    }
}
