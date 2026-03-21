import type { EditorView } from "@codemirror/view";
import { Change } from "@codemirror/merge";
import { useChatStore } from "../ai/store/chatStore";
import type { AgentTextSpan } from "../ai/diff/actionLogTypes";
import type { AIChatSession } from "../ai/types";
import { deriveFileChangePresentation } from "./changePresentationModel";
import {
    buildMergeStructuralSignature,
    getMergePresentationFlags,
} from "./mergeViewConfig";
import {
    buildReplaceOriginalDocEffect,
    createMergeViewExtension,
    mergeEnabledFacet,
    mergeIdentityKeyFacet,
    mergeLevelFacet,
    mergeReviewStateFacet,
    mergeStatusKindFacet,
    mergeSessionIdFacet,
    mergeViewCompartment,
    setLastDispatchedDiffBase,
} from "./extensions/mergeViewDiff";
import { getChunkLineRangeInDocB } from "./mergeChunkRange";
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
        reviewState: view.state.facet(mergeReviewStateFacet),
        level: view.state.facet(mergeLevelFacet),
        statusKind: view.state.facet(mergeStatusKindFacet),
        mode: options.mode,
    });

    if (candidatePaths.length === 0) {
        reconfigureMergeView(view, currentSignature, {
            shouldShowMerge: false,
            sessionId: null,
            identityKey: null,
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
            reviewState: "finalized",
            level: "small",
            statusKind: null,
            mode: options.mode,
        });
        return;
    }

    const { trackedFile, sessionId } = match;
    const presentation = deriveFileChangePresentation(trackedFile);
    const nextSignature = buildMergeStructuralSignature({
        shouldShowMerge: true,
        sessionId,
        identityKey: trackedFile.identityKey,
        reviewState: presentation.reviewState,
        level: presentation.level,
        statusKind: trackedFile.status.kind,
        mode: options.mode,
    });

    if (currentSignature !== nextSignature) {
        const flags = getMergePresentationFlags(presentation);
        view.dispatch({
            effects: mergeViewCompartment.reconfigure(
                createMergeViewExtension({
                    original: trackedFile.diffBase,
                    diffChanges: buildMergeDiffChanges(
                        trackedFile.unreviewedRanges?.spans ?? [],
                        trackedFile.diffBase.length,
                        view.state.doc.length,
                    ),
                    sessionId,
                    identityKey: trackedFile.identityKey,
                    reviewState: presentation.reviewState,
                    level: presentation.level,
                    statusKind: trackedFile.status.kind,
                    highlightChanges: flags.highlightChanges,
                    allowInlineDiffs: flags.allowInlineDiffs,
                    enableControls: flags.enableControls,
                    syntaxHighlightDeletions: flags.syntaxHighlightDeletions,
                    syntaxHighlightDeletionsMaxLength:
                        flags.syntaxHighlightDeletionsMaxLength,
                    onDecision: ({ chunk, decision, view: mergeView }) => {
                        const liveSessionId =
                            mergeView.state.facet(mergeSessionIdFacet);
                        const liveIdentityKey = mergeView.state.facet(
                            mergeIdentityKeyFacet,
                        );
                        if (!liveSessionId || !liveIdentityKey) {
                            return;
                        }

                        const range = getChunkLineRangeInDocB(
                            chunk,
                            mergeView.state.doc,
                        );

                        void useChatStore
                            .getState()
                            .resolveHunkEdits(
                                liveSessionId,
                                liveIdentityKey,
                                decision,
                                range.startLine,
                                range.endLine,
                            );
                    },
                }),
            ),
        });
        setLastDispatchedDiffBase(view, trackedFile.diffBase);
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
