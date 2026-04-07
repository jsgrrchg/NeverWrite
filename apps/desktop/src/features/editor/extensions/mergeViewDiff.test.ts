/**
 * @vitest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    buildReplaceOriginalDocEffect,
    createMergeViewExtension,
    mergeViewCompartment,
    readMergeViewRuntimeState,
    type CreateMergeViewExtensionConfig,
    type MergeDecisionPayload,
} from "./mergeViewDiff";
import { refreshReviewProjectionControlsGeometry } from "./reviewProjectionControls";

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
        targetKind: "note",
        targetId: "notes/current",
        controlsSignature: null,
        highlightChanges: true,
        allowInlineDiffs: true,
        enableControls: true,
        showControlWidgets: true,
        syntaxHighlightDeletions: true,
        syntaxHighlightDeletionsMaxLength: 3000,
        inlineState: "projection_ready",
        projectionMetrics: {
            totalLines: 0,
            hunkCount: 0,
            chunkCount: 0,
            visibleChunkCount: 0,
            invalidChunkCount: 0,
            inlineSafeChunkCount: 0,
            degradedChunkCount: 0,
            status: "projection_ready",
        },
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
        overlapGroupIds: ["chunk-1::hunk-1"],
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
        overlapGroupId: "chunk-1::hunk-1",
        overlapGroupSize: 1,
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
            inlineState: "projection_ready",
            level: "small",
            totalLines: 0,
            hunkCount: 0,
            chunkCount: 0,
            visibleChunkCount: 0,
            invalidChunkCount: 0,
            inlineSafeChunkCount: 0,
            degradedChunkCount: 0,
            status: "projection_ready",
            reviewState: "finalized",
            sessionId: "session-1",
            statusKind: "modified",
            targetId: "notes/current",
            targetKind: "note",
            trackedVersion: 1,
            transitionReason: "none",
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

    it("keeps pure deletion anchors interactive without tinting the surviving line", () => {
        const { view, destroy } = mountMergeView({
            doc: "keep\nstay\n",
            original: "keep\nremove me\nstay\n",
            reviewHunks: [
                makeReviewHunk({
                    oldStartLine: 1,
                    oldEndLine: 2,
                    newStartLine: 1,
                    newEndLine: 1,
                    visualStartLine: 1,
                    visualEndLine: 1,
                    baseFrom: 5,
                    baseTo: 15,
                    currentFrom: 5,
                    currentTo: 5,
                    memberSpans: [
                        {
                            spanIndex: 0,
                            baseFrom: 5,
                            baseTo: 15,
                            currentFrom: 5,
                            currentTo: 5,
                        },
                    ],
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 1,
                    endLine: 1,
                }),
            ],
        });

        expect(
            view.dom.querySelector(".cm-review-chunk-controls"),
        ).not.toBeNull();
        expect(view.dom.querySelectorAll(".cm-review-chunk-line")).toHaveLength(
            0,
        );

        destroy();
    });

    it("renders inline review deletions without line-through decoration", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha changed\n",
            original: "alpha beta\n",
        });

        const deletedText = view.dom.querySelector(
            "del.cm-deletedText",
        ) as HTMLElement | null;

        expect(deletedText).not.toBeNull();
        expect(
            window.getComputedStyle(deletedText as HTMLElement).textDecoration,
        ).not.toContain("line-through");

        destroy();
    });

    it("renders inline overlap actions for ambiguous chunks", () => {
        const calls: MergeDecisionPayload[] = [];
        const { view, destroy } = mountMergeView({
            doc: "alpha\n",
            original: "beta\nALPHA\n",
            reviewHunks: [
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-1" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    ambiguous: true,
                    overlapGroupId: "chunk-1::overlap-1",
                    overlapGroupSize: 2,
                }),
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-2" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    baseFrom: 2,
                    baseTo: 4,
                    currentFrom: 2,
                    currentTo: 4,
                    ambiguous: true,
                    overlapGroupId: "chunk-1::overlap-1",
                    overlapGroupSize: 2,
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    ambiguous: true,
                    multiHunk: true,
                    controlMode: "inline-overlap",
                    canResolveInlineExactly: true,
                    hunkIds: [
                        { trackedVersion: 1, key: "hunk-1" },
                        { trackedVersion: 1, key: "hunk-2" },
                    ],
                    overlapGroupIds: ["chunk-1::overlap-1"],
                }),
            ],
            onDecision(context) {
                calls.push(context);
            },
        });

        expect(
            view.dom.querySelector('[data-review-decision="accept"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-review-decision="reject"]'),
        ).not.toBeNull();
        expect(view.dom.textContent).toContain("Overlapping");
        expect(calls).toHaveLength(0);
        destroy();
    });

    it("does not label singleton overlap groups as overlapping", () => {
        const { view, destroy } = mountMergeView({
            doc: "AA\nBB\nCC\nDD\nEE\n",
            original: "aa\nbb\ncc\ndd\nee\n",
            reviewHunks: [
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-1" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    oldStartLine: 0,
                    oldEndLine: 1,
                    newStartLine: 0,
                    newEndLine: 1,
                    visualStartLine: 0,
                    visualEndLine: 1,
                    ambiguous: true,
                    overlapGroupId: "chunk-1::overlap-1",
                    overlapGroupSize: 2,
                }),
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-2" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    oldStartLine: 1,
                    oldEndLine: 2,
                    newStartLine: 1,
                    newEndLine: 2,
                    visualStartLine: 1,
                    visualEndLine: 2,
                    baseFrom: 3,
                    baseTo: 5,
                    currentFrom: 3,
                    currentTo: 5,
                    ambiguous: true,
                    overlapGroupId: "chunk-1::overlap-1",
                    overlapGroupSize: 2,
                    memberSpans: [
                        {
                            spanIndex: 1,
                            baseFrom: 3,
                            baseTo: 5,
                            currentFrom: 3,
                            currentTo: 5,
                        },
                    ],
                }),
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-3" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    oldStartLine: 3,
                    oldEndLine: 4,
                    newStartLine: 3,
                    newEndLine: 4,
                    visualStartLine: 3,
                    visualEndLine: 4,
                    baseFrom: 9,
                    baseTo: 11,
                    currentFrom: 9,
                    currentTo: 11,
                    ambiguous: true,
                    overlapGroupId: "chunk-1::singleton",
                    overlapGroupSize: 1,
                    memberSpans: [
                        {
                            spanIndex: 2,
                            baseFrom: 9,
                            baseTo: 11,
                            currentFrom: 9,
                            currentTo: 11,
                        },
                    ],
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    id: { trackedVersion: 1, key: "chunk-1" },
                    startLine: 0,
                    endLine: 4,
                    ambiguous: true,
                    multiHunk: true,
                    controlMode: "inline-overlap",
                    canResolveInlineExactly: true,
                    hunkIds: [
                        { trackedVersion: 1, key: "hunk-1" },
                        { trackedVersion: 1, key: "hunk-2" },
                        { trackedVersion: 1, key: "hunk-3" },
                    ],
                    overlapGroupIds: [
                        "chunk-1::overlap-1",
                        "chunk-1::singleton",
                    ],
                }),
            ],
        });

        const controls = Array.from(
            view.dom.querySelectorAll<HTMLElement>(".cm-review-chunk-controls"),
        );
        expect(controls).toHaveLength(2);
        expect(
            controls.filter(
                (control) => control.dataset.reviewOverlap === "true",
            ),
        ).toHaveLength(1);
        expect(
            controls.find(
                (control) => control.dataset.reviewChangeCount === "1",
            )?.textContent,
        ).not.toContain("Overlapping");

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

    it("degrades visually tall multi-hunk chunks to a grouped inline control", () => {
        const calls: MergeDecisionPayload[] = [];
        const { view, destroy } = mountMergeView({
            doc: "ONE\ntwo\nTHREE\nTHREE-2\nTHREE-3\nfour\n",
            original: "one\ntwo\nthree\nfour\n",
            reviewHunks: [
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-1" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    oldStartLine: 0,
                    oldEndLine: 1,
                    newStartLine: 0,
                    newEndLine: 1,
                    visualStartLine: 0,
                    visualEndLine: 1,
                }),
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-2" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    oldStartLine: 2,
                    oldEndLine: 3,
                    newStartLine: 2,
                    newEndLine: 5,
                    visualStartLine: 2,
                    visualEndLine: 5,
                    baseFrom: 8,
                    baseTo: 13,
                    currentFrom: 8,
                    currentTo: 29,
                    memberSpans: [
                        {
                            spanIndex: 1,
                            baseFrom: 8,
                            baseTo: 13,
                            currentFrom: 8,
                            currentTo: 29,
                        },
                    ],
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    id: { trackedVersion: 1, key: "chunk-1" },
                    startLine: 0,
                    endLine: 5,
                    multiHunk: true,
                    controlMode: "hunk",
                    hunkIds: [
                        { trackedVersion: 1, key: "hunk-1" },
                        { trackedVersion: 1, key: "hunk-2" },
                    ],
                }),
            ],
            onDecision(context) {
                calls.push(context);
            },
        });

        const controls = view.dom.querySelectorAll<HTMLElement>(
            ".cm-review-chunk-controls",
        );
        expect(controls).toHaveLength(1);
        expect(controls[0]?.dataset.reviewPresentationMode).toBe("grouped");
        expect(controls[0]?.dataset.reviewChangeCount).toBe("2");
        expect(controls[0]?.textContent).toContain("2 changes");
        expect(
            view.dom.querySelector('[data-review-hunk-key="hunk-1"]'),
        ).toBeNull();

        const rejectButton = view.dom.querySelector(
            '[data-review-decision="reject"]',
        ) as HTMLButtonElement | null;
        expect(rejectButton?.dataset.reviewDecisionScope).toBe("chunk");
        if (rejectButton) {
            fireEvent.mouseDown(rejectButton);
        }

        expect(calls).toHaveLength(1);
        expect(calls[0]?.chunkId).toEqual({
            trackedVersion: 1,
            key: "chunk-1",
        });
        expect(calls[0]?.hunkIds).toEqual([
            { trackedVersion: 1, key: "hunk-1" },
            { trackedVersion: 1, key: "hunk-2" },
        ]);

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

    it("keeps nearby controls from different chunks in separate visual stacks", () => {
        const { view, destroy } = mountMergeView({
            doc: "ONE\ntwo\nTHREE\nfour\nFIVE\nsix\n",
            original: "one\ntwo\nthree\nfour\nfive\nsix\n",
            reviewHunks: [
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-1" },
                    chunkId: { trackedVersion: 1, key: "chunk-1" },
                    oldStartLine: 0,
                    oldEndLine: 1,
                    newStartLine: 0,
                    newEndLine: 1,
                    visualStartLine: 0,
                    visualEndLine: 1,
                }),
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-2" },
                    chunkId: { trackedVersion: 1, key: "chunk-2" },
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
                    id: { trackedVersion: 1, key: "chunk-1" },
                    startLine: 0,
                    endLine: 1,
                }),
                makeReviewChunk({
                    id: { trackedVersion: 1, key: "chunk-2" },
                    startLine: 2,
                    endLine: 3,
                    hunkIds: [{ trackedVersion: 1, key: "hunk-2" }],
                }),
            ],
        });

        const controls = Array.from(
            view.dom.querySelectorAll<HTMLElement>(".cm-review-chunk-controls"),
        );
        expect(controls).toHaveLength(2);
        expect(controls[0]?.dataset.reviewDenseSlot).toBe("0");
        expect(controls[1]?.dataset.reviewDenseSlot).toBe("0");
        expect(controls[0]?.dataset.reviewDenseColumn).toBe("0");
        expect(controls[1]?.dataset.reviewDenseColumn).toBe("0");
        expect(controls[0]?.dataset.reviewPresentationMode).toBe("individual");
        expect(controls[1]?.dataset.reviewPresentationMode).toBe("individual");
        expect(
            controls[1]?.style.getPropertyValue(
                "--review-control-dense-offset",
            ),
        ).toBe("0px");

        destroy();
    });

    it("does not compact independent chunks into one dense control stack", () => {
        const reviewHunks = Array.from({ length: 5 }, (_, index) =>
            makeReviewHunk({
                id: { trackedVersion: 1, key: `hunk-${index + 1}` },
                chunkId: { trackedVersion: 1, key: `chunk-${index + 1}` },
                oldStartLine: index,
                oldEndLine: index + 1,
                newStartLine: index,
                newEndLine: index + 1,
                visualStartLine: index,
                visualEndLine: index + 1,
                baseFrom: index * 4,
                baseTo: index * 4 + 3,
                currentFrom: index * 4,
                currentTo: index * 4 + 3,
                memberSpans: [
                    {
                        spanIndex: index,
                        baseFrom: index * 4,
                        baseTo: index * 4 + 3,
                        currentFrom: index * 4,
                        currentTo: index * 4 + 3,
                    },
                ],
            }),
        );
        const reviewChunks = Array.from({ length: 5 }, (_, index) =>
            makeReviewChunk({
                id: { trackedVersion: 1, key: `chunk-${index + 1}` },
                startLine: index,
                endLine: index + 1,
                hunkIds: [{ trackedVersion: 1, key: `hunk-${index + 1}` }],
            }),
        );
        const { view, destroy } = mountMergeView({
            doc: "ONE\nTWO\nTHREE\nFOUR\nFIVE\nsix\n",
            original: "one\ntwo\nthree\nfour\nfive\nsix\n",
            reviewHunks,
            reviewChunks,
        });

        const controls = Array.from(
            view.dom.querySelectorAll<HTMLElement>(".cm-review-chunk-controls"),
        );

        expect(controls).toHaveLength(5);
        controls.forEach((control) => {
            expect(control.dataset.reviewDenseCompact).toBe("false");
            expect(control.dataset.reviewDenseGroupSize).toBe("1");
            expect(control.dataset.reviewDenseSlot).toBe("0");
            expect(control.dataset.reviewDenseColumn).toBe("0");
        });

        destroy();
    });

    it("remounts control widgets when geometry refresh is requested", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
            reviewHunks: [makeReviewHunk()],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 1,
                    endLine: 2,
                }),
            ],
        });

        const firstControl = view.dom.querySelector<HTMLElement>(
            ".cm-review-chunk-controls",
        );
        expect(firstControl).not.toBeNull();

        refreshReviewProjectionControlsGeometry(view);

        const refreshedControl = view.dom.querySelector<HTMLElement>(
            ".cm-review-chunk-controls",
        );
        expect(refreshedControl).not.toBeNull();
        expect(refreshedControl).not.toBe(firstControl);

        destroy();
    });

    it("refreshes geometry after window focus when metrics drift", () => {
        vi.useFakeTimers();
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
            reviewHunks: [makeReviewHunk()],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 1,
                    endLine: 2,
                }),
            ],
        });

        const firstControl = view.dom.querySelector<HTMLElement>(
            ".cm-review-chunk-controls",
        );
        expect(firstControl).not.toBeNull();

        const widthA = view.scrollDOM.clientWidth || 0;
        const widthB = view.contentDOM.clientWidth || 0;
        Object.defineProperty(view.scrollDOM, "clientWidth", {
            configurable: true,
            value: widthA + 120,
        });
        Object.defineProperty(view.contentDOM, "clientWidth", {
            configurable: true,
            value: widthB + 120,
        });

        window.dispatchEvent(new Event("focus"));
        vi.runAllTimers();

        const refreshedControl = view.dom.querySelector<HTMLElement>(
            ".cm-review-chunk-controls",
        );
        expect(refreshedControl).not.toBeNull();
        expect(refreshedControl).not.toBe(firstControl);

        destroy();
        vi.useRealTimers();
    });

    it("cancels a pending geometry refresh frame on destroy", () => {
        const pendingFrames = new Map<number, FrameRequestCallback>();
        let nextFrameId = 1;
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            const frameId = nextFrameId;
            nextFrameId += 1;
            pendingFrames.set(frameId, callback);
            return frameId;
        });
        const cancelFrame = vi.fn((frameId: number) => {
            pendingFrames.delete(frameId);
        });

        vi.stubGlobal("requestAnimationFrame", requestFrame);
        vi.stubGlobal("cancelAnimationFrame", cancelFrame);

        try {
            const { destroy } = mountMergeView({
                doc: "alpha\nbeta changed\n",
                original: "alpha\nbeta\n",
                reviewHunks: [makeReviewHunk()],
                reviewChunks: [
                    makeReviewChunk({
                        startLine: 1,
                        endLine: 2,
                    }),
                ],
            });

            window.dispatchEvent(new Event("focus"));

            expect(requestFrame).toHaveBeenCalled();
            expect(pendingFrames.size).toBeGreaterThan(0);

            destroy();

            expect(cancelFrame).toHaveBeenCalled();
            expect(pendingFrames.size).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("bounds out-of-range control warnings while still deduping repeats", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const warningPrefix = `warning-${crypto.randomUUID()}`;

        const mountOutOfRangeView = (index: number) =>
            mountMergeView({
                doc: "alpha\nbeta changed\n",
                original: "alpha\nbeta\n",
                reviewHunks: [
                    makeReviewHunk({
                        id: {
                            trackedVersion: 1,
                            key: `${warningPrefix}-h-${index}`,
                        },
                        oldStartLine: 20 + index,
                        oldEndLine: 21 + index,
                        newStartLine: 20 + index,
                        newEndLine: 21 + index,
                        visualStartLine: 20 + index,
                        visualEndLine: 21 + index,
                    }),
                ],
                reviewChunks: [
                    makeReviewChunk({
                        id: {
                            trackedVersion: 1,
                            key: `${warningPrefix}-c-${index}`,
                        },
                        hunkIds: [
                            {
                                trackedVersion: 1,
                                key: `${warningPrefix}-h-${index}`,
                            },
                        ],
                        overlapGroupIds: [`${warningPrefix}-g-${index}`],
                        startLine: 20 + index,
                        endLine: 21 + index,
                    }),
                ],
            });

        try {
            const first = mountOutOfRangeView(0);
            first.destroy();

            const duplicate = mountOutOfRangeView(0);
            duplicate.destroy();

            expect(warnSpy).toHaveBeenCalledTimes(1);

            for (let index = 1; index <= 256; index += 1) {
                const view = mountOutOfRangeView(index);
                view.destroy();
            }

            const afterEviction = mountOutOfRangeView(0);
            afterEviction.destroy();

            expect(warnSpy).toHaveBeenCalledTimes(258);
        } finally {
            warnSpy.mockRestore();
        }
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

    it("skips out-of-range controls instead of clamping them to the document end", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta\n",
            original: "alpha\nbeta\n",
            reviewHunks: [
                makeReviewHunk({
                    id: { trackedVersion: 1, key: "hunk-out-of-range" },
                    chunkId: { trackedVersion: 1, key: "chunk-out-of-range" },
                    oldStartLine: 20,
                    oldEndLine: 21,
                    newStartLine: 20,
                    newEndLine: 21,
                    visualStartLine: 20,
                    visualEndLine: 21,
                }),
            ],
            reviewChunks: [
                makeReviewChunk({
                    id: { trackedVersion: 1, key: "chunk-out-of-range" },
                    startLine: 20,
                    endLine: 21,
                    hunkIds: [{ trackedVersion: 1, key: "hunk-out-of-range" }],
                }),
            ],
        });

        expect(
            view.dom.querySelector(
                '[data-review-control-id="chunk:chunk-out-of-range"]',
            ),
        ).toBeNull();
        expect(view.dom.querySelector("[data-review-decision]")).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            "[merge-inline] skipping out-of-range inline control",
            expect.objectContaining({
                controlId: "hunk:hunk-out-of-range",
                trackedVersion: 1,
                startLine: 20,
                endLine: 21,
            }),
        );

        warn.mockRestore();
        destroy();
    });

    it("keeps merge controls visible while review is pending", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
            reviewState: "pending",
            enableControls: true,
            showControlWidgets: true,
            reviewHunks: [makeReviewHunk()],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 1,
                    endLine: 2,
                }),
            ],
        });

        expect(
            view.dom.querySelectorAll("[data-review-decision]"),
        ).toHaveLength(2);
        expect(view.dom.getAttribute("data-merge-review-state")).toBe(
            "pending",
        );

        destroy();
    });

    it("keeps inline action tooltip stable while merge is transitioning", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
            reviewHunks: [makeReviewHunk()],
            reviewChunks: [
                makeReviewChunk({
                    startLine: 1,
                    endLine: 2,
                }),
            ],
        });

        view.dom.dataset.mergeTransitioning = "true";
        const acceptButton = view.dom.querySelector(
            '[data-review-decision="accept"]',
        ) as HTMLButtonElement | null;

        expect(acceptButton).not.toBeNull();
        if (acceptButton) {
            fireEvent.mouseEnter(acceptButton);
            expect(acceptButton.dataset.reviewStale).toBeUndefined();
            expect(acceptButton.title).toBe("Accept change");
        }

        destroy();
    });
});
