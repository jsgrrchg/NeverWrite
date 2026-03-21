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
        highlightChanges: true,
        allowInlineDiffs: true,
        enableControls: true,
        syntaxHighlightDeletions: true,
        syntaxHighlightDeletionsMaxLength: 3000,
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
        });

        expect(view.dom.querySelectorAll("[data-merge-decision]")).toHaveLength(
            2,
        );
        expect(
            view.dom.querySelector('[data-merge-decision="accept"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-merge-decision="reject"]'),
        ).not.toBeNull();

        destroy();
    });

    it("routes chunk actions through the external handler", () => {
        const calls: MergeDecisionPayload[] = [];
        const { view, destroy } = mountMergeView({
            doc: "alpha\n",
            original: "alpha\nbeta\n",
            onDecision(context) {
                calls.push(context);
            },
        });

        const rejectButton = view.dom.querySelector(
            '[data-merge-decision="reject"]',
        ) as HTMLButtonElement | null;

        expect(rejectButton).not.toBeNull();
        if (rejectButton) {
            fireEvent.mouseDown(rejectButton);
        }

        expect(calls).toHaveLength(1);
        expect(calls[0]?.decision).toBe("rejected");
        expect(view.state.doc.toString()).toBe("alpha\n");

        destroy();
    });

    it("hides merge controls while review is pending", () => {
        const { view, destroy } = mountMergeView({
            doc: "alpha\nbeta changed\n",
            original: "alpha\nbeta\n",
            reviewState: "pending",
            enableControls: false,
        });

        expect(view.dom.querySelector("[data-merge-decision]")).toBeNull();
        expect(view.dom.getAttribute("data-merge-review-state")).toBe(
            "pending",
        );

        destroy();
    });
});
