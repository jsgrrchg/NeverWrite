import type { EditorView } from "@codemirror/view";
import { Change } from "@codemirror/merge";
import { useChatStore } from "../ai/store/chatStore";
import type { LineEdit } from "../ai/diff/actionLogTypes";
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
    mergeTrackedVersionFacet,
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
        trackedVersion: view.state.facet(mergeTrackedVersionFacet),
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

    if (currentSignature !== nextSignature) {
        const flags = getMergePresentationFlags(presentation);
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
                        reviewState: presentation.reviewState,
                        level: presentation.level,
                        statusKind: trackedFile.status.kind,
                        highlightChanges: flags.highlightChanges,
                        allowInlineDiffs: flags.allowInlineDiffs,
                        enableControls: flags.enableControls,
                        syntaxHighlightDeletions:
                            flags.syntaxHighlightDeletions,
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

                            const range = resolveChunkDecisionRange(
                                chunk,
                                mergeView.state.doc,
                                trackedFile.unreviewedEdits.edits,
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

function resolveChunkDecisionRange(
    chunk: Parameters<typeof getChunkLineRangeInDocB>[0],
    doc: Parameters<typeof getChunkLineRangeInDocB>[1],
    edits: readonly LineEdit[],
) {
    const range = getChunkLineRangeInDocB(chunk, doc);
    const matchingEdit = findDecisionEditForAnchor(range.anchorLine, edits);
    if (!matchingEdit) {
        return range;
    }

    return {
        startLine: matchingEdit.newStart,
        endLine: matchingEdit.newEnd,
        anchorLine: matchingEdit.newStart,
    };
}

function findDecisionEditForAnchor(
    anchorLine: number,
    edits: readonly LineEdit[],
): LineEdit | null {
    const matches = edits.filter((edit) => editMatchesAnchor(anchorLine, edit));
    if (matches.length === 0) {
        if (edits.length === 1) {
            return edits[0] ?? null;
        }

        const nearest = findNearestDecisionEdit(anchorLine, edits);
        if (nearest) {
            return nearest.edit;
        }

        return null;
    }

    matches.sort((left, right) => {
        const leftSpan = Math.max(left.newEnd - left.newStart, 0);
        const rightSpan = Math.max(right.newEnd - right.newStart, 0);
        return leftSpan - rightSpan || left.newStart - right.newStart;
    });
    return matches[0] ?? null;
}

function findNearestDecisionEdit(
    anchorLine: number,
    edits: readonly LineEdit[],
) {
    let best: {
        edit: LineEdit;
        distance: number;
        span: number;
    } | null = null;

    for (const edit of edits) {
        const span = Math.max(edit.newEnd - edit.newStart, 0);
        const distance =
            edit.newStart === edit.newEnd
                ? Math.abs(edit.newStart - anchorLine)
                : anchorLine < edit.newStart
                  ? edit.newStart - anchorLine
                  : anchorLine >= edit.newEnd
                    ? anchorLine - (edit.newEnd - 1)
                    : 0;

        if (
            !best ||
            distance < best.distance ||
            (distance === best.distance && span < best.span)
        ) {
            best = { edit, distance, span };
        }
    }

    return best;
}

function editMatchesAnchor(anchorLine: number, edit: LineEdit) {
    if (edit.newStart === edit.newEnd) {
        return edit.newStart === anchorLine;
    }

    return anchorLine >= edit.newStart && anchorLine < edit.newEnd;
}
