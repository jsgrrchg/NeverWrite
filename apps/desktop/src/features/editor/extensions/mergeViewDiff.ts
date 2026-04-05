import {
    ChangeSet,
    RangeSetBuilder,
    type EditorState,
    Facet,
    type Extension,
    Compartment,
    type StateEffect,
} from "@codemirror/state";
import {
    getChunks,
    getOriginalDoc,
    originalDocChangeEffect,
    unifiedMergeView,
    type Change,
} from "@codemirror/merge";
import {
    Decoration,
    EditorView,
    ViewPlugin,
    type DecorationSet,
} from "@codemirror/view";
import type { ReviewState } from "../../ai/diff/actionLogTypes";
import type {
    ReviewChunk,
    ReviewChunkId,
    ReviewHunk,
    ReviewHunkId,
} from "../../ai/diff/reviewProjection";
import type { ReviewProjectionMetrics } from "../../ai/diff/reviewProjectionDiagnostics";
import type { ChangePresentationLevel } from "../changePresentationModel";
import { createChangeRailExtension } from "./changeRail";
import { createReviewProjectionControlsExtension } from "./reviewProjectionControls";
import { mergeViewTheme } from "./mergeViewTheme";

export type MergeInlineState =
    | "disabled"
    | "waiting_for_editor_target"
    | "waiting_for_editor_doc"
    | "projection_ready"
    | "projection_partial"
    | "projection_invalid";

export type MergeTransitionReason =
    | "none"
    | "no_candidate_paths"
    | "preview_mode"
    | "no_tracked_file"
    | "target_not_resolved"
    | "target_not_active"
    | "editor_doc_stale"
    | "projection_invalid";

export type MergeTargetKind = "note" | "file";

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
    targetKind: MergeTargetKind | null;
    targetId: string | null;
    controlsSignature: string | null;
    reviewState: ReviewState;
    level: ChangePresentationLevel;
    statusKind: string | null;
    inlineState: MergeInlineState;
    projectionMetrics: ReviewProjectionMetrics;
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

export interface MergeViewRuntimeConfig {
    enabled: boolean;
    trackedVersion: number | null;
    sessionId: string | null;
    identityKey: string | null;
    targetKind: MergeTargetKind | null;
    targetId: string | null;
    controlsSignature: string | null;
    reviewState: ReviewState;
    level: ChangePresentationLevel;
    statusKind: string | null;
    inlineState: MergeInlineState;
    transitionReason: MergeTransitionReason;
    projectionMetrics: ReviewProjectionMetrics;
}

export const mergeViewCompartment = new Compartment();

const pureInsertionHighlightScope = Decoration.mark({
    class: "cm-pure-insertion-content",
});

type MergeChunkLike = {
    fromA: number;
    toA: number;
    fromB: number;
    toB: number;
};

function isPureInsertionChunk(chunk: MergeChunkLike) {
    return chunk.fromA === chunk.toA && chunk.fromB < chunk.toB;
}

function isPureDeletionChunk(chunk: MergeChunkLike) {
    return chunk.fromA < chunk.toA && chunk.fromB === chunk.toB;
}

function buildPureInsertionDecorations(state: EditorState): DecorationSet {
    const mergeChunks = getChunks(state)?.chunks ?? [];
    if (mergeChunks.length === 0) {
        return Decoration.none;
    }

    const builder = new RangeSetBuilder<Decoration>();
    for (const chunk of mergeChunks) {
        if (!isPureInsertionChunk(chunk)) {
            continue;
        }
        builder.add(chunk.fromB, chunk.toB, pureInsertionHighlightScope);
    }

    return builder.finish();
}

function syncDeletedChunkSemantics(view: EditorView) {
    const mergeChunks = getChunks(view.state)?.chunks ?? [];
    const deletedChunkElements =
        view.dom.querySelectorAll<HTMLElement>(".cm-deletedChunk");

    deletedChunkElements.forEach((element, index) => {
        const chunk = mergeChunks[index];
        element.classList.toggle(
            "cm-pure-deletion-chunk",
            chunk != null && isPureDeletionChunk(chunk),
        );
    });
}

const mergeChunkSemanticsPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        private readonly view: EditorView;

        constructor(view: EditorView) {
            this.view = view;
            this.decorations = buildPureInsertionDecorations(view.state);
            this.scheduleDeletedChunkSync();
        }

        update(update: { state: EditorState; startState: EditorState }) {
            const previousChunks = getChunks(update.startState)?.chunks ?? null;
            const nextChunks = getChunks(update.state)?.chunks ?? null;
            if (previousChunks !== nextChunks) {
                this.decorations = buildPureInsertionDecorations(update.state);
            }
            this.scheduleDeletedChunkSync();
        }

        private scheduleDeletedChunkSync() {
            this.view.requestMeasure({
                read: () => null,
                write: () => {
                    syncDeletedChunkSemantics(this.view);
                },
            });
        }
    },
    {
        decorations: (value) => value.decorations,
    },
);

export const mergeSessionIdFacet = defineSingleFacet<string | null>(null);
export const mergeIdentityKeyFacet = defineSingleFacet<string | null>(null);
export const mergeTrackedVersionFacet = defineSingleFacet<number | null>(null);
export const mergeTargetKindFacet = defineSingleFacet<MergeTargetKind | null>(
    null,
);
export const mergeTargetIdFacet = defineSingleFacet<string | null>(null);
export const mergeControlsSignatureFacet = defineSingleFacet<string | null>(
    null,
);
export const mergeReviewStateFacet =
    defineSingleFacet<ReviewState>("finalized");
export const mergeLevelFacet =
    defineSingleFacet<ChangePresentationLevel>("small");
export const mergeStatusKindFacet = defineSingleFacet<string | null>(null);
export const mergeEnabledFacet = defineSingleFacet(false);
export const mergeInlineStateFacet =
    defineSingleFacet<MergeInlineState>("disabled");
export const mergeTransitionReasonFacet =
    defineSingleFacet<MergeTransitionReason>("none");
export const mergeProjectionMetricsFacet =
    defineSingleFacet<ReviewProjectionMetrics>({
        totalLines: 0,
        hunkCount: 0,
        chunkCount: 0,
        visibleChunkCount: 0,
        invalidChunkCount: 0,
        inlineSafeChunkCount: 0,
        degradedChunkCount: 0,
        status: "projection_invalid",
    });

export function createMergeViewRuntimeExtension(
    config: MergeViewRuntimeConfig,
): Extension[] {
    return [
        mergeSessionIdFacet.of(config.sessionId),
        mergeIdentityKeyFacet.of(config.identityKey),
        mergeTrackedVersionFacet.of(config.trackedVersion),
        mergeTargetKindFacet.of(config.targetKind),
        mergeTargetIdFacet.of(config.targetId),
        mergeControlsSignatureFacet.of(config.controlsSignature),
        mergeReviewStateFacet.of(config.reviewState),
        mergeLevelFacet.of(config.level),
        mergeStatusKindFacet.of(config.statusKind),
        mergeEnabledFacet.of(config.enabled),
        mergeInlineStateFacet.of(config.inlineState),
        mergeTransitionReasonFacet.of(config.transitionReason),
        mergeProjectionMetricsFacet.of(config.projectionMetrics),
        EditorView.editorAttributes.of({
            "data-merge-enabled": config.enabled ? "true" : "false",
            "data-merge-review-state": config.reviewState,
            "data-merge-level": config.level,
            "data-merge-inline-state": config.inlineState,
            "data-merge-transition-reason": config.transitionReason,
            "data-merge-target-kind": config.targetKind ?? "",
            "data-merge-target-id": config.targetId ?? "",
        }),
    ];
}

export function createMergeViewExtension(
    config: CreateMergeViewExtensionConfig,
): Extension[] {
    return [
        mergeViewTheme,
        mergeChunkSemanticsPlugin,
        ...createMergeViewRuntimeExtension({
            enabled: true,
            trackedVersion: config.trackedVersion,
            sessionId: config.sessionId,
            identityKey: config.identityKey,
            targetKind: config.targetKind,
            targetId: config.targetId,
            controlsSignature: config.controlsSignature,
            reviewState: config.reviewState,
            level: config.level,
            statusKind: config.statusKind,
            inlineState: config.inlineState,
            transitionReason: "none",
            projectionMetrics: config.projectionMetrics,
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
        ...(config.highlightChanges && config.reviewHunks.length > 0
            ? createChangeRailExtension(config.reviewHunks)
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
        inlineState: state.facet(mergeInlineStateFacet),
        transitionReason: state.facet(mergeTransitionReasonFacet),
        sessionId: state.facet(mergeSessionIdFacet),
        identityKey: state.facet(mergeIdentityKeyFacet),
        trackedVersion: state.facet(mergeTrackedVersionFacet),
        targetKind: state.facet(mergeTargetKindFacet),
        targetId: state.facet(mergeTargetIdFacet),
        reviewState: state.facet(mergeReviewStateFacet),
        level: state.facet(mergeLevelFacet),
        statusKind: state.facet(mergeStatusKindFacet),
        ...state.facet(mergeProjectionMetricsFacet),
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
