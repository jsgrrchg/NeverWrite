import {
    ChangeSet,
    type EditorState,
    Facet,
    type Extension,
    Compartment,
    type StateEffect,
} from "@codemirror/state";
import {
    getOriginalDoc,
    originalDocChangeEffect,
    unifiedMergeView,
    type Change,
} from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import type { ReviewState } from "../../ai/diff/actionLogTypes";
import type {
    ReviewChunk,
    ReviewChunkId,
    ReviewHunk,
    ReviewHunkId,
} from "../../ai/diff/reviewProjection";
import type { ChangePresentationLevel } from "../changePresentationModel";
import { createReviewProjectionControlsExtension } from "./reviewProjectionControls";
import { mergeViewTheme } from "./mergeViewTheme";

export interface MergeDecisionPayload {
    decision: "accepted" | "rejected";
    chunkId: ReviewChunkId;
    hunkIds: ReviewHunkId[];
    view: EditorView;
}

export interface CreateMergeViewExtensionConfig {
    original: string;
    diffChanges?: readonly Change[];
    trackedVersion: number | null;
    sessionId: string | null;
    identityKey: string | null;
    controlsSignature: string | null;
    reviewState: ReviewState;
    level: ChangePresentationLevel;
    statusKind: string | null;
    highlightChanges: boolean;
    allowInlineDiffs: boolean;
    enableControls: boolean;
    showControlWidgets: boolean;
    syntaxHighlightDeletions: boolean;
    syntaxHighlightDeletionsMaxLength: number;
    reviewHunks: ReviewHunk[];
    reviewChunks: ReviewChunk[];
    onDecision: (payload: MergeDecisionPayload) => void;
}

export const mergeViewCompartment = new Compartment();

export const mergeSessionIdFacet = defineSingleFacet<string | null>(null);
export const mergeIdentityKeyFacet = defineSingleFacet<string | null>(null);
export const mergeTrackedVersionFacet = defineSingleFacet<number | null>(null);
export const mergeControlsSignatureFacet = defineSingleFacet<string | null>(
    null,
);
export const mergeReviewStateFacet =
    defineSingleFacet<ReviewState>("finalized");
export const mergeLevelFacet =
    defineSingleFacet<ChangePresentationLevel>("small");
export const mergeStatusKindFacet = defineSingleFacet<string | null>(null);
export const mergeEnabledFacet = defineSingleFacet(false);

export function createMergeViewExtension(
    config: CreateMergeViewExtensionConfig,
): Extension[] {
    return [
        mergeViewTheme,
        mergeSessionIdFacet.of(config.sessionId),
        mergeIdentityKeyFacet.of(config.identityKey),
        mergeTrackedVersionFacet.of(config.trackedVersion),
        mergeControlsSignatureFacet.of(config.controlsSignature),
        mergeReviewStateFacet.of(config.reviewState),
        mergeLevelFacet.of(config.level),
        mergeStatusKindFacet.of(config.statusKind),
        mergeEnabledFacet.of(true),
        EditorView.editorAttributes.of({
            "data-merge-enabled": "true",
            "data-merge-review-state": config.reviewState,
            "data-merge-level": config.level,
        }),
        ...(config.showControlWidgets
            ? createReviewProjectionControlsExtension({
                  allowDecisionActions: config.enableControls,
                  hunks: config.reviewHunks,
                  chunks: config.reviewChunks,
                  onDecision: ({ decision, chunkId, hunkIds, view }) =>
                      config.onDecision({
                          decision,
                          chunkId,
                          hunkIds,
                          view,
                      }),
              })
            : []),
        unifiedMergeView({
            original: config.original,
            diffConfig: config.diffChanges
                ? {
                      override: () => config.diffChanges ?? [],
                  }
                : undefined,
            gutter: false,
            highlightChanges: config.highlightChanges,
            allowInlineDiffs: config.allowInlineDiffs,
            syntaxHighlightDeletions: config.syntaxHighlightDeletions,
            syntaxHighlightDeletionsMaxLength:
                config.syntaxHighlightDeletionsMaxLength,
            mergeControls: false,
        }),
    ];
}

export function readMergeViewRuntimeState(state: EditorState | null) {
    if (!state) {
        return null;
    }

    return {
        enabled: state.facet(mergeEnabledFacet),
        sessionId: state.facet(mergeSessionIdFacet),
        identityKey: state.facet(mergeIdentityKeyFacet),
        reviewState: state.facet(mergeReviewStateFacet),
        level: state.facet(mergeLevelFacet),
        statusKind: state.facet(mergeStatusKindFacet),
    };
}

const lastDispatchedDiffBase = new WeakMap<EditorView, string>();

export function setLastDispatchedDiffBase(view: EditorView, diffBase: string) {
    lastDispatchedDiffBase.set(view, diffBase);
}

export function buildReplaceOriginalDocEffect(
    view: EditorView,
    nextOriginal: string,
): StateEffect<{
    doc: import("@codemirror/state").Text;
    changes: ChangeSet;
}> | null {
    if (lastDispatchedDiffBase.get(view) === nextOriginal) {
        return null;
    }

    const currentOriginal = getOriginalDoc(view.state);
    const changes = ChangeSet.of(
        [
            {
                from: 0,
                to: currentOriginal.length,
                insert: nextOriginal,
            },
        ],
        currentOriginal.length,
    );

    lastDispatchedDiffBase.set(view, nextOriginal);
    return originalDocChangeEffect(view.state, changes);
}

function defineSingleFacet<T>(fallback: T) {
    return Facet.define<T, T>({
        combine(values) {
            return values.length > 0 ? values[0] : fallback;
        },
    });
}
