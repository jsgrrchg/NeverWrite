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
    type Chunk,
    type Change,
} from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import type { ReviewState } from "../../ai/diff/actionLogTypes";
import type { ChangePresentationLevel } from "../changePresentationModel";
import {
    mergeChunkSnapshotPlugin,
    findMergeChunkAtPos,
    readMergeChunkSnapshot,
} from "../mergeChunks";
import { mergeViewTheme } from "./mergeViewTheme";

export interface MergeDecisionPayload {
    decision: "accepted" | "rejected";
    chunk: Chunk;
    view: EditorView;
}

export interface CreateMergeViewExtensionConfig {
    original: string;
    diffChanges?: readonly Change[];
    sessionId: string | null;
    identityKey: string | null;
    reviewState: ReviewState;
    level: ChangePresentationLevel;
    statusKind: string | null;
    highlightChanges: boolean;
    allowInlineDiffs: boolean;
    enableControls: boolean;
    syntaxHighlightDeletions: boolean;
    syntaxHighlightDeletionsMaxLength: number;
    onDecision: (payload: MergeDecisionPayload) => void;
}

export const mergeViewCompartment = new Compartment();

export const mergeSessionIdFacet = defineSingleFacet<string | null>(null);
export const mergeIdentityKeyFacet = defineSingleFacet<string | null>(null);
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
        mergeChunkSnapshotPlugin,
        mergeSessionIdFacet.of(config.sessionId),
        mergeIdentityKeyFacet.of(config.identityKey),
        mergeReviewStateFacet.of(config.reviewState),
        mergeLevelFacet.of(config.level),
        mergeStatusKindFacet.of(config.statusKind),
        mergeEnabledFacet.of(true),
        EditorView.editorAttributes.of({
            "data-merge-enabled": "true",
            "data-merge-review-state": config.reviewState,
            "data-merge-level": config.level,
        }),
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
            mergeControls: config.enableControls
                ? (type) =>
                      createDecisionButton(type, (event, button) => {
                          event.preventDefault();
                          event.stopPropagation();

                          const editorRoot = button.closest(".cm-editor");
                          const view = editorRoot
                              ? EditorView.findFromDOM(
                                    editorRoot as HTMLElement,
                                )
                              : null;
                          if (!view) {
                              return;
                          }

                          const snapshot = findMergeChunkAtCurrentDom(
                              view,
                              button,
                          );
                          if (!snapshot) {
                              return;
                          }

                          config.onDecision({
                              decision:
                                  type === "accept" ? "accepted" : "rejected",
                              chunk: snapshot,
                              view,
                          });
                      })
                : false,
        }),
    ];
}

function createDecisionButton(
    type: "accept" | "reject",
    onMouseDown: (event: MouseEvent, button: HTMLButtonElement) => void,
) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-merge-action cm-merge-action-${type}`;
    button.dataset.mergeDecision = type;
    button.textContent = type === "accept" ? "Accept" : "Reject";
    button.onmousedown = (event) => onMouseDown(event, button);
    return button;
}

function findMergeChunkAtCurrentDom(
    view: EditorView,
    target: HTMLElement,
): Chunk | null {
    const pos = view.posAtDOM(target);
    const snapshot = readMergeChunkSnapshot(view.state);
    return snapshot ? findMergeChunkAtPos(snapshot.chunks, pos) : null;
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
