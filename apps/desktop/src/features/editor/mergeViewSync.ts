import type { EditorView } from "@codemirror/view";
import { Change } from "@codemirror/merge";
import { useChatStore } from "../ai/store/chatStore";
import type { AgentTextSpan } from "../ai/diff/actionLogTypes";
import {
    buildReviewProjection,
    type ReviewChunkId,
    type ReviewHunkId,
    type ReviewProjection,
} from "../ai/diff/reviewProjection";
import {
    getReviewProjectionDiagnostics,
    summarizeReviewProjectionInlineState,
    type ReviewProjectionInlineState,
    type ReviewProjectionMetrics,
} from "../ai/diff/reviewProjectionDiagnostics";
import type { AIChatSession } from "../ai/types";
import {
    isFileTab,
    isNoteTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { deriveFileChangePresentation } from "./changePresentationModel";
import {
    buildMergeStructuralSignature,
    getMergePresentationFlags,
} from "./mergeViewConfig";
import {
    buildReplaceOriginalDocEffect,
    createMergeViewRuntimeExtension,
    createMergeViewExtension,
    mergeControlsSignatureFacet,
    mergeEnabledFacet,
    mergeIdentityKeyFacet,
    mergeInlineStateFacet,
    mergeLevelFacet,
    mergeReviewStateFacet,
    mergeStatusKindFacet,
    mergeSessionIdFacet,
    mergeTargetIdFacet,
    mergeTargetKindFacet,
    mergeTrackedVersionFacet,
    mergeTransitionReasonFacet,
    mergeViewCompartment,
    setLastDispatchedDiffBase,
    type MergeInlineState,
    type MergeTargetKind,
    type MergeTransitionReason,
    type MergeViewRuntimeConfig,
} from "./extensions/mergeViewDiff";
import {
    resolveEditorTargetForTrackedPath,
    resolveEditorTargetForOpenTab,
    type EditorTarget,
} from "./editorTargetResolver";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";

const MERGE_RESYNC_RETRY_DELAY_MS = 48;
const MERGE_RESYNC_MAX_RETRIES = 3;

type MergeResyncRetryState = {
    key: string;
    attempts: number;
    timeout: ReturnType<typeof setTimeout> | null;
};

type MergeResyncRetryReason = "stale-doc" | "dispatch-failed";

type MergeResyncRetryIdentity = {
    reason: MergeResyncRetryReason;
    mode: "source" | "preview";
    candidatePaths: string[];
    sessionId: string | null;
    identityKey: string | null;
    trackedVersion: number | null;
    editorDocSignature: string;
    trackedTextSignature: string | null;
    projectionSignature?: string | null;
};

const mergeResyncRetryByView = new WeakMap<EditorView, MergeResyncRetryState>();
const mergeProjectionDiagnosticsWarnKeyByView = new WeakMap<
    EditorView,
    string
>();
const mergeDebugLogKeyByView = new WeakMap<EditorView, string>();

function buildProjectionDiagnosticsLogInfo(
    projection: ReviewProjection | null,
): {
    warnKey: string;
    invalidChunkKeys: string[];
    invalidHunkKeys: string[];
} | null {
    if (!projection) return null;
    const diagnostics = getReviewProjectionDiagnostics(projection);
    const invalidChunkKeys = Object.entries(diagnostics.chunkInvariantIdsByKey)
        .filter(([, ids]) => ids.length > 0)
        .map(([key]) => key);
    const invalidHunkKeys = Object.entries(diagnostics.hunkInvariantIdsByKey)
        .filter(([, ids]) => ids.length > 0)
        .map(([key]) => key);
    if (invalidChunkKeys.length === 0 && invalidHunkKeys.length === 0) {
        return null;
    }
    const warnKey = [...invalidChunkKeys, ...invalidHunkKeys].sort().join(",");
    return { warnKey, invalidChunkKeys, invalidHunkKeys };
}

function toProjectionMetrics(
    state: ReviewProjectionInlineState,
): ReviewProjectionMetrics {
    return {
        totalLines: state.totalLines,
        hunkCount: state.hunkCount,
        chunkCount: state.chunkCount,
        visibleChunkCount: state.visibleChunkCount,
        invalidChunkCount: state.invalidChunkCount,
        inlineSafeChunkCount: state.inlineSafeChunkCount,
        degradedChunkCount: state.degradedChunkCount,
        status: state.projectionState,
    };
}

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
        inlineState: view.state.facet(mergeInlineStateFacet),
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
        clearMergeDebugLog(view);
        setMergeTransitioning(view, false);
        reconfigureMergeView(view, currentSignature, {
            shouldShowMerge: false,
            sessionId: null,
            identityKey: null,
            trackedVersion: null,
            inlineState: "disabled",
            reviewState: "finalized",
            level: "small",
            statusKind: null,
            mode: options.mode,
            transitionReason: "no_candidate_paths",
            targetKind: null,
            targetId: null,
        });
        return;
    }

    const { match } = resolveTrackedFileMatchForPaths(
        candidatePaths,
        sessionsById,
        {
            vaultPath: useVaultStore.getState().vaultPath,
        },
    );
    if (!match || options.mode === "preview") {
        clearMergeResyncRetry(view);
        clearMergeDebugLog(view);
        setMergeTransitioning(view, false);
        reconfigureMergeView(view, currentSignature, {
            shouldShowMerge: false,
            sessionId: null,
            identityKey: null,
            trackedVersion: null,
            inlineState: "disabled",
            reviewState: "finalized",
            level: "small",
            statusKind: null,
            mode: options.mode,
            transitionReason:
                options.mode === "preview" ? "preview_mode" : "no_tracked_file",
            targetKind: null,
            targetId: null,
        });
        return;
    }

    const { trackedFile, sessionId } = match;
    const presentation = deriveFileChangePresentation(trackedFile);
    const target = resolveEditorTargetForTrackedPath(trackedFile.path);
    const targetKind = getMergeTargetKind(target);
    const targetId = getMergeTargetId(target);
    if (!isResolvedTargetActiveForCandidates(target, candidatePaths)) {
        clearMergeResyncRetry(view);
        setMergeTransitioning(view, true);
        logMergeSyncState(
            view,
            "debug",
            "[merge-inline] waiting for editor target",
            {
                candidatePaths,
                sessionId,
                identityKey: trackedFile.identityKey,
                trackedVersion: trackedFile.version,
                trackedPath: trackedFile.path,
                inlineState: "waiting_for_editor_target",
                transitionReason: target
                    ? "target_not_active"
                    : "target_not_resolved",
                target,
                editorDocSignature: buildNormalizedTextSignature(
                    view.state.doc.toString(),
                ),
                trackedTextSignature: buildNormalizedTextSignature(
                    trackedFile.currentText,
                ),
            },
        );
        reconfigureMergeView(view, currentSignature, {
            shouldShowMerge: false,
            sessionId,
            identityKey: trackedFile.identityKey,
            trackedVersion: trackedFile.version,
            inlineState: "waiting_for_editor_target",
            reviewState: presentation.reviewState,
            level: presentation.level,
            statusKind: trackedFile.status.kind,
            mode: options.mode,
            transitionReason: target
                ? "target_not_active"
                : "target_not_resolved",
            targetKind,
            targetId,
        });
        return;
    }

    if (isTransientlyEmptyEditorDoc(view, trackedFile.currentText)) {
        setMergeTransitioning(view, true);
        scheduleMergeResyncRetry(view, retryContext, {
            reason: "stale-doc",
            mode: options.mode,
            candidatePaths,
            sessionId,
            identityKey: trackedFile.identityKey,
            trackedVersion: trackedFile.version,
            editorDocSignature: buildNormalizedTextSignature(
                view.state.doc.toString(),
            ),
            trackedTextSignature: buildNormalizedTextSignature(
                trackedFile.currentText,
            ),
        });
        logMergeSyncState(
            view,
            "debug",
            "[merge-inline] waiting for editor reload to settle",
            {
                candidatePaths,
                sessionId,
                identityKey: trackedFile.identityKey,
                trackedVersion: trackedFile.version,
                trackedPath: trackedFile.path,
                inlineState: "waiting_for_editor_doc",
                transitionReason: "editor_doc_stale",
                target,
                editorDocSignature: buildNormalizedTextSignature(
                    view.state.doc.toString(),
                ),
                trackedTextSignature: buildNormalizedTextSignature(
                    trackedFile.currentText,
                ),
                editorLength: view.state.doc.length,
                trackedLength: countNormalizedLength(trackedFile.currentText),
            },
        );
        return;
    }

    const isDocSynced = isEditorDocSyncedWithTrackedCurrentText(
        view,
        trackedFile.currentText,
    );
    if (!isDocSynced) {
        setMergeTransitioning(view, true);
        const editorDocSignature = buildNormalizedTextSignature(
            view.state.doc.toString(),
        );
        const trackedTextSignature = buildNormalizedTextSignature(
            trackedFile.currentText,
        );
        scheduleMergeResyncRetry(view, retryContext, {
            reason: "stale-doc",
            mode: options.mode,
            candidatePaths,
            sessionId,
            identityKey: trackedFile.identityKey,
            trackedVersion: trackedFile.version,
            editorDocSignature,
            trackedTextSignature,
        });
        logMergeSyncState(
            view,
            "debug",
            "[merge-inline] defer merge sync while editor is stale",
            {
                candidatePaths,
                sessionId,
                identityKey: trackedFile.identityKey,
                trackedVersion: trackedFile.version,
                trackedPath: trackedFile.path,
                inlineState: "waiting_for_editor_doc",
                transitionReason: "editor_doc_stale",
                target,
                editorDocSignature,
                trackedTextSignature,
                editorLength: view.state.doc.length,
                trackedLength: countNormalizedLength(trackedFile.currentText),
            },
        );
        reconfigureMergeView(view, currentSignature, {
            shouldShowMerge: false,
            sessionId,
            identityKey: trackedFile.identityKey,
            trackedVersion: trackedFile.version,
            inlineState: "waiting_for_editor_doc",
            reviewState: presentation.reviewState,
            level: presentation.level,
            statusKind: trackedFile.status.kind,
            mode: options.mode,
            transitionReason: "editor_doc_stale",
            targetKind,
            targetId,
        });
        return;
    } else {
        clearMergeResyncRetry(view);
        clearMergeDebugLog(view);
        setMergeTransitioning(view, false);
    }

    const reviewProjection = buildReviewProjectionSafely(trackedFile);
    const projectionState = reviewProjection
        ? summarizeReviewProjectionInlineState(reviewProjection)
        : EMPTY_INLINE_STATE;
    const projectionDiagnostics =
        reviewProjection &&
        projectionState.projectionState !== "projection_ready"
            ? buildProjectionDiagnosticsLogInfo(reviewProjection)
            : null;

    if (
        projectionDiagnostics &&
        mergeProjectionDiagnosticsWarnKeyByView.get(view) !==
            projectionDiagnostics.warnKey
    ) {
        mergeProjectionDiagnosticsWarnKeyByView.set(
            view,
            projectionDiagnostics.warnKey,
        );
        logMergeSyncState(
            view,
            "warn",
            projectionState.projectionState === "projection_partial"
                ? "[merge-inline] review projection partially degraded"
                : "[merge-inline] review projection invalid",
            {
                candidatePaths,
                sessionId,
                identityKey: trackedFile.identityKey,
                trackedVersion: trackedFile.version,
                trackedPath: trackedFile.path,
                inlineState: projectionState.projectionState,
                transitionReason:
                    projectionState.projectionState === "projection_invalid"
                        ? "projection_invalid"
                        : "none",
                target,
                totalLines: projectionState.totalLines,
                chunkCount: projectionState.chunkCount,
                visibleChunkCount: projectionState.visibleChunkCount,
                inlineSafeChunkCount: projectionState.inlineSafeChunkCount,
                degradedChunkCount: projectionState.degradedChunkCount,
                invalidChunkCount: projectionState.invalidChunkCount,
                invalidChunkKeys: projectionDiagnostics.invalidChunkKeys,
                invalidHunkKeys: projectionDiagnostics.invalidHunkKeys,
                editorDocSignature: buildNormalizedTextSignature(
                    view.state.doc.toString(),
                ),
                trackedTextSignature: buildNormalizedTextSignature(
                    trackedFile.currentText,
                ),
            },
        );
    } else if (!projectionDiagnostics) {
        clearMergeDebugLog(view);
        mergeProjectionDiagnosticsWarnKeyByView.delete(view);
    }
    const nextControlsSignature = buildMergeControlsSignature(reviewProjection);
    const resolvedInlineState: MergeInlineState =
        projectionState.projectionState === "projection_ready"
            ? "projection_ready"
            : projectionState.projectionState === "projection_partial"
              ? "projection_partial"
              : "disabled";
    const nextSignature = buildMergeStructuralSignature({
        shouldShowMerge: true,
        sessionId,
        identityKey: trackedFile.identityKey,
        trackedVersion: trackedFile.version,
        inlineState: resolvedInlineState,
        reviewState: presentation.reviewState,
        level: presentation.level,
        statusKind: trackedFile.status.kind,
        mode: options.mode,
    });

    if (
        currentSignature !== nextSignature ||
        currentControlsSignature !== nextControlsSignature
    ) {
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
                        targetKind,
                        targetId,
                        controlsSignature: nextControlsSignature,
                        reviewState: presentation.reviewState,
                        level: presentation.level,
                        statusKind: trackedFile.status.kind,
                        inlineState: resolvedInlineState,
                        projectionMetrics: toProjectionMetrics(projectionState),
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
                                    {
                                        reason: "dispatch-failed",
                                        mode: options.mode,
                                        candidatePaths,
                                        sessionId: liveSessionId,
                                        identityKey: liveIdentityKey,
                                        trackedVersion: liveTrackedVersion,
                                        editorDocSignature:
                                            buildNormalizedTextSignature(
                                                mergeView.state.doc.toString(),
                                            ),
                                        trackedTextSignature:
                                            buildNormalizedTextSignature(
                                                trackedFile.currentText,
                                            ),
                                    },
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
            scheduleMergeResyncRetry(view, retryContext, {
                reason: "dispatch-failed",
                mode: options.mode,
                candidatePaths,
                sessionId,
                identityKey: trackedFile.identityKey,
                trackedVersion: trackedFile.version,
                editorDocSignature: buildNormalizedTextSignature(
                    view.state.doc.toString(),
                ),
                trackedTextSignature: buildNormalizedTextSignature(
                    trackedFile.currentText,
                ),
                projectionSignature: nextControlsSignature,
            });
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
    identity: MergeResyncRetryIdentity,
) {
    const key = buildMergeResyncRetryKey(identity);
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
    nextConfig: Parameters<typeof buildMergeStructuralSignature>[0] & {
        transitionReason: MergeTransitionReason;
        targetKind: MergeTargetKind | null;
        targetId: string | null;
    },
) {
    const nextSignature = buildMergeStructuralSignature(nextConfig);
    const nextRuntimeConfig: MergeViewRuntimeConfig = {
        enabled: nextConfig.shouldShowMerge,
        trackedVersion: nextConfig.trackedVersion,
        sessionId: nextConfig.sessionId,
        identityKey: nextConfig.identityKey,
        targetKind: nextConfig.targetKind,
        targetId: nextConfig.targetId,
        controlsSignature: null,
        reviewState: nextConfig.reviewState,
        level: nextConfig.level,
        statusKind: nextConfig.statusKind,
        inlineState: nextConfig.inlineState,
        transitionReason: nextConfig.transitionReason,
        projectionMetrics: EMPTY_PROJECTION_METRICS,
    };

    if (
        currentSignature === nextSignature &&
        isEquivalentMergeRuntimeConfig(view, nextRuntimeConfig)
    ) {
        return;
    }

    try {
        view.dispatch({
            effects: mergeViewCompartment.reconfigure(
                createMergeViewRuntimeExtension(nextRuntimeConfig),
            ),
        });
    } catch (error) {
        if (error instanceof RangeError) {
            setMergeTransitioning(view, true);
            return;
        }
        throw error;
    }
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

function buildNormalizedTextSignature(text: string) {
    const normalized = normalizeEditorText(text);
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${normalized.length}:${(hash >>> 0).toString(16)}`;
}

function buildMergeResyncRetryKey(identity: MergeResyncRetryIdentity) {
    return JSON.stringify(identity);
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

const EMPTY_PROJECTION_METRICS: ReviewProjectionMetrics = {
    totalLines: 0,
    hunkCount: 0,
    chunkCount: 0,
    visibleChunkCount: 0,
    invalidChunkCount: 0,
    inlineSafeChunkCount: 0,
    degradedChunkCount: 0,
    status: "projection_invalid",
};

const EMPTY_INLINE_STATE: ReviewProjectionInlineState = {
    projectionState: "projection_invalid",
    reviewProjectionReady: false,
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

function isResolvedTargetActiveForCandidates(
    target: EditorTarget | null,
    candidatePaths: string[],
) {
    if (!target?.openTab) {
        return false;
    }

    const targetPaths =
        target.kind === "note"
            ? [
                  target.absolutePath,
                  target.noteId,
                  target.noteId.endsWith(".md")
                      ? target.noteId
                      : `${target.noteId}.md`,
              ]
            : [target.absolutePath, target.relativePath];

    return candidatePaths.some((candidatePath) =>
        targetPaths.some((targetPath) =>
            matchesCandidatePath(targetPath, candidatePath),
        ),
    );
}

function matchesCandidatePath(targetPath: string, candidatePath: string) {
    const normalizedTarget = normalizeTrackedPath(targetPath);
    const normalizedCandidate = normalizeTrackedPath(candidatePath);

    if (normalizedTarget === normalizedCandidate) {
        return true;
    }

    if (!normalizedCandidate.startsWith("/")) {
        return normalizedTarget.endsWith(`/${normalizedCandidate}`);
    }

    return false;
}

function normalizeTrackedPath(path: string) {
    return path.replace(/\\/g, "/");
}

function isTransientlyEmptyEditorDoc(
    view: EditorView,
    trackedCurrentText: string,
) {
    return (
        view.state.doc.length === 0 &&
        countNormalizedLength(trackedCurrentText) > 0
    );
}

function getMergeTargetKind(
    target: EditorTarget | null,
): MergeTargetKind | null {
    return target?.kind ?? null;
}

function getMergeTargetId(target: EditorTarget | null) {
    if (!target) {
        return null;
    }

    return target.kind === "note" ? target.noteId : target.relativePath;
}

function getActiveEditorTargetDebugInfo() {
    const { tabs, activeTabId } = useEditorStore.getState();
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    const editorTab =
        activeTab && (isNoteTab(activeTab) || isFileTab(activeTab))
            ? activeTab
            : null;
    const activeTarget = resolveEditorTargetForOpenTab(editorTab);

    return {
        activeTabId: activeTab?.id ?? null,
        activeTabKind: editorTab
            ? isNoteTab(editorTab)
                ? "note"
                : "file"
            : (activeTab?.kind ?? null),
        activeTargetKind: getMergeTargetKind(activeTarget),
        activeTargetId: getMergeTargetId(activeTarget),
    };
}

function isEquivalentMergeRuntimeConfig(
    view: EditorView,
    config: MergeViewRuntimeConfig,
) {
    const state = view.state;
    return (
        state.facet(mergeEnabledFacet) === config.enabled &&
        state.facet(mergeSessionIdFacet) === config.sessionId &&
        state.facet(mergeIdentityKeyFacet) === config.identityKey &&
        state.facet(mergeTrackedVersionFacet) === config.trackedVersion &&
        state.facet(mergeTargetKindFacet) === config.targetKind &&
        state.facet(mergeTargetIdFacet) === config.targetId &&
        state.facet(mergeControlsSignatureFacet) === config.controlsSignature &&
        state.facet(mergeReviewStateFacet) === config.reviewState &&
        state.facet(mergeLevelFacet) === config.level &&
        state.facet(mergeStatusKindFacet) === config.statusKind &&
        state.facet(mergeInlineStateFacet) === config.inlineState &&
        state.facet(mergeTransitionReasonFacet) === config.transitionReason
    );
}

function clearMergeDebugLog(view: EditorView) {
    mergeDebugLogKeyByView.delete(view);
}

function logMergeSyncState(
    view: EditorView,
    level: "debug" | "warn",
    message: string,
    payload: {
        candidatePaths: string[];
        sessionId: string | null;
        identityKey: string | null;
        trackedVersion: number | null;
        trackedPath: string;
        inlineState: MergeInlineState;
        transitionReason: MergeTransitionReason;
        target: EditorTarget | null;
        editorDocSignature: string;
        trackedTextSignature: string | null;
        editorLength?: number;
        trackedLength?: number;
        docLines?: number;
        outOfRangeChunkCount?: number;
        maxStartLine?: number;
        maxEndLine?: number;
        totalLines?: number;
        chunkCount?: number;
        visibleChunkCount?: number;
        inlineSafeChunkCount?: number;
        degradedChunkCount?: number;
        invalidChunkCount?: number;
        invalidChunkKeys?: string[];
        invalidHunkKeys?: string[];
    },
) {
    const activeTarget = getActiveEditorTargetDebugInfo();
    const targetKind = getMergeTargetKind(payload.target);
    const targetId = getMergeTargetId(payload.target);
    const targetAbsolutePath = payload.target?.absolutePath ?? null;
    const key = JSON.stringify({
        level,
        message,
        sessionId: payload.sessionId,
        identityKey: payload.identityKey,
        trackedVersion: payload.trackedVersion,
        trackedPath: payload.trackedPath,
        inlineState: payload.inlineState,
        transitionReason: payload.transitionReason,
        candidatePaths: payload.candidatePaths,
        targetKind,
        targetId,
        targetAbsolutePath,
        activeTabId: activeTarget.activeTabId,
        activeTabKind: activeTarget.activeTabKind,
        activeTargetKind: activeTarget.activeTargetKind,
        activeTargetId: activeTarget.activeTargetId,
        editorDocSignature: payload.editorDocSignature,
        trackedTextSignature: payload.trackedTextSignature,
        editorLength: payload.editorLength,
        trackedLength: payload.trackedLength,
        docLines: payload.docLines,
        outOfRangeChunkCount: payload.outOfRangeChunkCount,
        maxStartLine: payload.maxStartLine,
        maxEndLine: payload.maxEndLine,
    });
    if (mergeDebugLogKeyByView.get(view) === key) {
        return;
    }

    mergeDebugLogKeyByView.set(view, key);

    const logger = level === "warn" ? console.warn : console.debug;
    logger(message, {
        sessionId: payload.sessionId,
        identityKey: payload.identityKey,
        trackedVersion: payload.trackedVersion,
        trackedPath: payload.trackedPath,
        inlineState: payload.inlineState,
        transitionReason: payload.transitionReason,
        candidatePaths: payload.candidatePaths,
        targetKind,
        targetId,
        targetAbsolutePath,
        activeTabId: activeTarget.activeTabId,
        activeTabKind: activeTarget.activeTabKind,
        activeTargetKind: activeTarget.activeTargetKind,
        activeTargetId: activeTarget.activeTargetId,
        editorDocSignature: payload.editorDocSignature,
        trackedTextSignature: payload.trackedTextSignature,
        editorLength: payload.editorLength,
        trackedLength: payload.trackedLength,
        docLines: payload.docLines,
        outOfRangeChunkCount: payload.outOfRangeChunkCount,
        maxStartLine: payload.maxStartLine,
        maxEndLine: payload.maxEndLine,
    });
}
