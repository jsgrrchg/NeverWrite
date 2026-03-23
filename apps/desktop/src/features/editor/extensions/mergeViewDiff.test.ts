/**
 * @vitest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    buildReplaceOriginalDocEffect,
    createMergeViewExtension,
    mergeViewCompartment,
    readMergeViewRuntimeState,
    type CreateMergeViewExtensionConfig,
    type MergeDecisionPayload,
} from "./mergeViewDiff";

function mountMergeView(
    overrides: Partial<CreateMergeViewExtensionConfig> & { doc: string },
) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const config: CreateMergeViewExtensionConfig = {
        identityKey: "note.md",
        level: "small",
        original: "alpha\nbeta\n",
        reviewState: "finalized",
        sessionId: "session-1",
        statusKind: "modified",
        trackedVersion: 1,
        controlsSignature: null,
        highlightChanges: true,
        allowInlineDiffs: true,
        enableControls: true,
        showControlWidgets: true,
        syntaxHighlightDeletions: true,
        syntaxHighlightDeletionsMaxLength: 3000,
        reviewHunks: [],
        reviewChunks: [],
        onDecision() {},
        ...overrides,
    };

    const state = EditorState.create({
        doc: overrides.doc,
        extensions: [mergeViewCompartment.of(createMergeViewExtension(config))],
    });
    const view = new EditorView({ state, parent });

    return {
        view,
        destroy() {
            view.destroy();
            parent.remove();
        },
    };
}

function makeReviewChunk(
    overrides: Partial<
        CreateMergeViewExtensionConfig["reviewChunks"][number]
    > = {},
): CreateMergeViewExtensionConfig["reviewChunks"][number] {
    return {
        id: { trackedVersion: 1, key: "chunk-1" },
        identityKey: "note.md",
        trackedVersion: 1,
        startLine: 0,
        endLine: 0,
        hunkIds: [{ trackedVersion: 1, key: "hunk-1" }],
        multiHunk: false,
        hasConflict: false,
        ambiguous: false,
        controlMode: "chunk",
        canResolveInlineExactly: true,
        ...overrides,
    };
}

function makeReviewHunk(
    overrides: Partial<
        CreateMergeViewExtensionConfig["reviewHunks"][number]
    > = {},
): CreateMergeViewExtensionConfig["reviewHunks"][number] {
    return {
        id: { trackedVersion: 1, key: "hunk-1" },
        identityKey: "note.md",
        trackedVersion: 1,
        oldStartLine: 0,
        oldEndLine: 1,
        newStartLine: 0,
        newEndLine: 1,
        visualStartLine: 0,
        visualEndLine: 1,
        baseFrom: 0,
        baseTo: 5,
        currentFrom: 0,
        currentTo: 5,
        memberSpans: [
            {
                spanIndex: 0,
                baseFrom: 0,
                baseTo: 5,
                currentFrom: 0,
                currentTo: 5,
            },
        ],
        chunkId: { trackedVersion: 1, key: "chunk-1" },
        hasConflict: false,
        ambiguous: false,
        ...overrides,
    };
}

describe("mergeViewDiff", () => {
    it("creates a merge-backed editor state with public metadata", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
        });

        expect(getOriginalDoc(view.state).toString()).toBe("alpha\nbeta\n");
        expect(getChunks(view.state)?.chunks.length).toBe(1);
        expect(readMergeViewRuntimeState(view.state)).toEqual({
            enabled: true,
            identityKey: "note.md",
            level: "small",
            reviewState: "finalized",
            sessionId: "session-1",
            statusKind: "modified",
        });

        destroy();
    });

    it("replaces the original document through originalDocChangeEffect", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
        });

        const currentDoc = view.state.doc.toString();
        const effect = buildReplaceOriginalDocEffect(view, "gamma\n");

        expect(effect).not.toBeNull();
        view.dispatch({
            effects: effect ? [effect] : [],
        });

        expect(getOriginalDoc(view.state).toString()).toBe("gamma\n");
        expect(view.state.doc.toString()).toBe(currentDoc);

        destroy();
    });

    it("renders merge controls for pure insertions", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta\nnew line\n",
            original: "alpha\nbeta\n",
            reviewHunks: [
                makeReviewHunk({
                    oldStartLine: 2,
                    oldEndLine: 2,
                    newStartLine: 2,
                    newEndLine: 3,
                    visualStartLine: 2,
                    visualEndLine: 3,
                    baseFrom: 11,
                    baseTo: 11,
                    currentFrom: 11,
                    currentTo: 20,
                    memberSpans: [
                        {
                            spanIndex: 0,
                            baseFrom: 11,
                            baseTo: 11,
                            currentFrom: 11,
                            currentTo: 20,
                        },
                    ],
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 2,
                    endLine: 3,
                }),
            ],
        });

        expect(
            view.dom.querySelectorAll("[data-review-decision]"),
        ).toHaveLength(2);
        expect(
            view.dom.querySelector('[data-review-decision="accept"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-review-decision="reject"]'),
        ).not.toBeNull();

        destroy();
    });

    it("routes chunk actions through the external handler", () => {
        const calls: MergeDecisionPayload[] = [];
        const { view, destroy } = mountMergeView({
            doc: "alpha\n",
            original: "alpha\nbeta\n",
            reviewHunks: [makeReviewHunk()],
            reviewChunks: [makeReviewChunk()],
            onDecision(context) {
                calls.push(context);
            },
        });

        const rejectButton = view.dom.querySelector(
            '[data-review-decision="reject"]',
        ) as HTMLButtonElement | null;

        expect(rejectButton).not.toBeNull();
        if (rejectButton) {
            fireEvent.mouseDown(rejectButton);
        }

        expect(calls).toHaveLength(1);
        expect(calls[0]?.decision).toBe("rejected");
        expect(calls[0]?.chunkId).toEqual({
            trackedVersion: 1,
            key: "chunk-1",
        });
        expect(calls[0]?.hunkIds).toEqual([
            { trackedVersion: 1, key: "hunk-1" },
        ]);
        expect(view.state.doc.toString()).toBe("alpha\n");

        destroy();
    });

    it("renders an ambiguous chunk without destructive inline actions", () => {
        const calls: MergeDecisionPayload[] = [];
        const { view, destroy } = mountMergeView({
            doc: "alpha\n",
            original: "alpha\nbeta\n",
            reviewHunks: [makeReviewHunk({ ambiguous: true })],
            reviewChunks: [
                makeReviewChunk({
                    ambiguous: true,
                    controlMode: "panel-only",
                    canResolveInlineExactly: false,
                }),
            ],
            onDecision(context) {
                calls.push(context);
            },
        });

        expect(
            view.dom.querySelector('[data-review-decision="accept"]'),
        ).toBeNull();
        expect(
            view.dom.querySelector('[data-review-decision="reject"]'),
        ).toBeNull();
        expect(view.dom.textContent).toContain("Review in Changes");
        expect(calls).toHaveLength(0);
        destroy();
    });

    it("renders per-hunk inline actions for separable multi-hunk chunks", () => {
        const { view, destroy } = mountMergeView({
            doc: "ONE\ntwo\nTHREE\nfour\n",
            original: "one\ntwo\nthree\nfour\n",
            reviewHunks: [
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-1" },
                    oldStartLine: 0,
                    oldEndLine: 1,
                    newStartLine: 0,
                    newEndLine: 1,
                    visualStartLine: 0,
                    visualEndLine: 1,
                }),
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-2" },
                    oldStartLine: 2,
                    oldEndLine: 3,
                    newStartLine: 2,
                    newEndLine: 3,
                    visualStartLine: 2,
                    visualEndLine: 3,
                    baseFrom: 8,
                    baseTo: 13,
                    currentFrom: 8,
                    currentTo: 13,
                    memberSpans: [
                        {
                            spanIndex: 1,
                            baseFrom: 8,
                            baseTo: 13,
                            currentFrom: 8,
                            currentTo: 13,
                        },
                    ],
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 0,
                    endLine: 3,
                    hunkIds: [
                        { trackedVersion: 1, key: "hunk-1" },
                        { trackedVersion: 1, key: "hunk-2" },
                    ],
                    multiHunk: true,
                    controlMode: "hunk",
                }),
            ],
        });

        expect(
            view.dom.querySelectorAll('[data-review-decision="accept"]'),
        ).toHaveLength(2);
        expect(
            view.dom.querySelectorAll('[data-review-decision="reject"]'),
        ).toHaveLength(2);
        expect(
            view.dom.querySelector('[data-review-hunk-key="hunk-1"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-review-hunk-key="hunk-2"]'),
        ).not.toBeNull();
        expect(view.dom.textContent).toContain("1 change");

        destroy();
    });

    it("routes per-hunk actions through the external handler with an exact subset", () => {
        const calls: MergeDecisionPayload[] = [];
        const { view, destroy } = mountMergeView({
            doc: "ONE\ntwo\nTHREE\nfour\n",
            original: "one\ntwo\nthree\nfour\n",
            reviewHunks: [
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-1" },
                    oldStartLine: 0,
                    oldEndLine: 1,
                    newStartLine: 0,
                    newEndLine: 1,
                    visualStartLine: 0,
                    visualEndLine: 1,
                }),
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-2" },
                    oldStartLine: 2,
                    oldEndLine: 3,
                    newStartLine: 2,
                    newEndLine: 3,
                    visualStartLine: 2,
                    visualEndLine: 3,
                    baseFrom: 8,
                    baseTo: 13,
                    currentFrom: 8,
                    currentTo: 13,
                    memberSpans: [
                        {
                            spanIndex: 1,
                            baseFrom: 8,
                            baseTo: 13,
                            currentFrom: 8,
                            currentTo: 13,
                        },
                    ],
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 0,
                    endLine: 3,
                    hunkIds: [
                        { trackedVersion: 1, key: "hunk-1" },
                        { trackedVersion: 1, key: "hunk-2" },
                    ],
                    multiHunk: true,
                    controlMode: "hunk",
                }),
            ],
            onDecision(context) {
                calls.push(context);
            },
        });

        const acceptButton = view.dom.querySelector(
            '[data-review-decision="accept"][data-review-hunk-key="hunk-2"]',
        ) as HTMLButtonElement | null;

        expect(acceptButton).not.toBeNull();
        if (acceptButton) {
            fireEvent.mouseDown(acceptButton);
        }

        expect(calls).toHaveLength(1);
        expect(calls[0]?.decision).toBe("accepted");
        expect(calls[0]?.chunkId).toEqual({
            trackedVersion: 1,
            key: "chunk-1",
        });
        expect(calls[0]?.hunkIds).toEqual([
            { trackedVersion: 1, key: "hunk-2" },
        ]);

        destroy();
    });

    it("renders a panel CTA instead of buttons when widgets are gated off", () => {
        const calls: MergeDecisionPayload[] = [];
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
            enableControls: false,
            showControlWidgets: true,
            reviewHunks: [makeReviewHunk()],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 1,
                    endLine: 2,
                }),
            ],
            onDecision(context) {
                calls.push(context);
            },
        });

        expect(view.dom.querySelector("[data-review-decision]")).toBeNull();
        expect(view.dom.textContent).toContain("Review in Changes");
        expect(calls).toHaveLength(0);

        destroy();
    });

    it("hides merge controls while review is pending", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
            reviewState: "pending",
            enableControls: false,
            showControlWidgets: false,
        });

        expect(view.dom.querySelector("[data-review-decision]")).toBeNull();
        expect(view.dom.getAttribute("data-merge-review-state")).toBe(
            "pending",
        );

        destroy();
    });
});
