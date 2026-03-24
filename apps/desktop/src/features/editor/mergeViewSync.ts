import type { EditorView } from "@codemirror/view";
import { Change } from "@codemirror/merge";
import { useChatStore } from "../ai/store/chatStore";
import type { AgentTextSpan } from "../ai/diff/actionLogTypes";
import {
    buildReviewProjection,
    summarizeReviewProjectionInlineState,
    type ReviewChunkId,
    type ReviewHunkId,
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

const MERGE_RESYNC_RETRY_DELAY_MS = 48;
const MERGE_RESYNC_MAX_RETRIES = 3;

type MergeResyncRetryState = {
    key: string;
    attempts: number;
    timeout: ReturnType<typeof setTimeout> | null;
};

const mergeResyncRetryByView = new WeakMap<EditorView, MergeResyncRetryState>();
const mergeOutOfRangeProjectionWarnKeyByView = new WeakMap<
    EditorView,
    string
>();

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

    const retryContext = {
        candidatePaths,
        options,
        sessionsById,
    };
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
        clearMergeResyncRetry(view);
        setMergeTransitioning(view, false);
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
        clearMergeResyncRetry(view);
        setMergeTransitioning(view, false);
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
    if (
        !isEditorDocSyncedWithTrackedCurrentText(view, trackedFile.currentText)
    ) {
        setMergeTransitioning(view, true);
        scheduleMergeResyncRetry(view, retryContext);
        console.debug("[merge-inline] defer merge sync while editor is stale", {
            sessionId,
            identityKey: trackedFile.identityKey,
            trackedVersion: trackedFile.version,
            editorLength: view.state.doc.length,
            trackedLength: countNormalizedLength(trackedFile.currentText),
        });
        return;
    }

    clearMergeResyncRetry(view);
    setMergeTransitioning(view, false);

    const presentation = deriveFileChangePresentation(trackedFile);
    const reviewProjection = buildReviewProjectionSafely(trackedFile);
    const outOfRangeInfo =
        reviewProjection &&
        getOutOfRangeProjectionInfo(reviewProjection, view.state.doc.lines);
    if (outOfRangeInfo) {
        setMergeTransitioning(view, true);
        scheduleMergeResyncRetry(view, retryContext);

        const warnKey = JSON.stringify([
            trackedFile.identityKey,
            trackedFile.version,
            outOfRangeInfo.maxStartLine,
            outOfRangeInfo.maxEndLine,
            outOfRangeInfo.docLines,
        ]);
        if (mergeOutOfRangeProjectionWarnKeyByView.get(view) !== warnKey) {
            mergeOutOfRangeProjectionWarnKeyByView.set(view, warnKey);
            console.warn(
                "[merge-inline] review projection out of range; scheduling resync",
                {
                    sessionId,
                    identityKey: trackedFile.identityKey,
                    trackedVersion: trackedFile.version,
                    docLines: outOfRangeInfo.docLines,
                    outOfRangeChunkCount: outOfRangeInfo.outOfRangeChunkCount,
                    maxStartLine: outOfRangeInfo.maxStartLine,
                    maxEndLine: outOfRangeInfo.maxEndLine,
                },
            );
        }
        return;
    }
    mergeOutOfRangeProjectionWarnKeyByView.delete(view);
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
                            chunkId,
                            hunkIds,
                            view: mergeView,
                        }) => {
                            const liveSessionId =
                                mergeView.state.facet(mergeSessionIdFacet);
                            const liveIdentityKey = mergeView.state.facet(
                                mergeIdentityKeyFacet,
                            );
                            const liveTrackedVersion = mergeView.state.facet(
                                mergeTrackedVersionFacet,
                            );
                            if (!liveSessionId || !liveIdentityKey) {
                                return;
                            }
                            if (
                                mergeView.dom.dataset.mergeTransitioning ===
                                "true"
                            ) {
                                return;
                            }
                            if (
                                !isEditorDocSyncedWithTrackedCurrentText(
                                    mergeView,
                                    trackedFile.currentText,
                                )
                            ) {
                                return;
                            }
                            if (
                                isMergeDecisionStale(
                                    liveTrackedVersion,
                                    chunkId,
                                    hunkIds,
                                )
                            ) {
                                setMergeTransitioning(mergeView, true);
                                scheduleMergeResyncRetry(
                                    mergeView,
                                    retryContext,
                                );
                                console.debug(
                                    "[merge-inline] stale inline decision ignored; refreshing",
                                    {
                                        sessionId: liveSessionId,
                                        identityKey: liveIdentityKey,
                                        liveTrackedVersion,
                                        chunkTrackedVersion:
                                            chunkId.trackedVersion,
                                        hunkTrackedVersions: hunkIds.map(
                                            (id) => id.trackedVersion,
                                        ),
                                    },
                                );
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
            // yet updated after reject). Schedule a short retry.
            setMergeTransitioning(view, true);
            scheduleMergeResyncRetry(view, retryContext);
        }
        return;
    }

    const effect = buildReplaceOriginalDocEffect(view, trackedFile.diffBase);
    if (effect) {
        view.dispatch({ effects: [effect] });
    }
}

function normalizeEditorText(text: string) {
    return text.replace(/\r\n?/g, "\n");
}

function isEditorDocSyncedWithTrackedCurrentText(
    view: EditorView,
    trackedCurrentText: string,
) {
    return (
        normalizeEditorText(view.state.doc.toString()) ===
        normalizeEditorText(trackedCurrentText)
    );
}

function setMergeTransitioning(view: EditorView, transitioning: boolean) {
    if (transitioning) {
        view.dom.dataset.mergeTransitioning = "true";
        return;
    }

    delete view.dom.dataset.mergeTransitioning;
}

function scheduleMergeResyncRetry(
    view: EditorView,
    context: {
        candidatePaths: string[];
        options: { mode: "source" | "preview" };
        sessionsById: Record<string, AIChatSession>;
    },
) {
    const key = JSON.stringify([context.options.mode, context.candidatePaths]);
    const current = mergeResyncRetryByView.get(view);
    if (current?.key !== key && current?.timeout) {
        clearTimeout(current.timeout);
    }

    const state: MergeResyncRetryState =
        current && current.key === key
            ? current
            : {
                  key,
                  attempts: 0,
                  timeout: null,
              };

    if (state.timeout || state.attempts >= MERGE_RESYNC_MAX_RETRIES) {
        mergeResyncRetryByView.set(view, state);
        return;
    }

    state.attempts += 1;
    state.timeout = setTimeout(() => {
        const liveState = mergeResyncRetryByView.get(view);
        if (!liveState || liveState.key !== key) {
            return;
        }
        liveState.timeout = null;
        mergeResyncRetryByView.set(view, liveState);

        if (!view.dom.isConnected) {
            clearMergeResyncRetry(view);
            return;
        }

        const liveSessions = useChatStore.getState().sessionsById;
        const retrySessions =
            Object.keys(liveSessions).length > 0
                ? liveSessions
                : context.sessionsById;
        syncMergeViewForPaths(
            view,
            context.candidatePaths,
            retrySessions,
            context.options,
        );
    }, MERGE_RESYNC_RETRY_DELAY_MS);

    mergeResyncRetryByView.set(view, state);
}

function clearMergeResyncRetry(view: EditorView) {
    const current = mergeResyncRetryByView.get(view);
    if (!current) {
        return;
    }

    if (current.timeout) {
        clearTimeout(current.timeout);
    }

    mergeResyncRetryByView.delete(view);
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

export function isMergeDecisionStale(
    liveTrackedVersion: number | null,
    chunkId: ReviewChunkId,
    hunkIds: ReviewHunkId[],
) {
    if (liveTrackedVersion == null) {
        return true;
    }

    if (chunkId.trackedVersion !== liveTrackedVersion) {
        return true;
    }

    return hunkIds.some(
        (hunkId) => hunkId.trackedVersion !== liveTrackedVersion,
    );
}

function getOutOfRangeProjectionInfo(
    reviewProjection: ReviewProjection,
    docLines: number,
) {
    const outOfRangeChunks = reviewProjection.chunks.filter(
        (chunk) => chunk.startLine >= docLines || chunk.endLine > docLines,
    );
    if (outOfRangeChunks.length === 0) {
        return null;
    }

    return {
        docLines,
        outOfRangeChunkCount: outOfRangeChunks.length,
        maxStartLine: Math.max(
            ...outOfRangeChunks.map((chunk) => chunk.startLine),
        ),
        maxEndLine: Math.max(...outOfRangeChunks.map((chunk) => chunk.endLine)),
    };
}
