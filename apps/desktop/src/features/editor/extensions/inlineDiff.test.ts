/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AgentTextSpan, LineEdit } from "../../ai/diff/actionLogTypes";
import { getInlineDiffExtension, setInlineDiff } from "./inlineDiff";

function mountView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
        doc,
        extensions: [getInlineDiffExtension()],
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

function applyInlineDiff(
    view: EditorView,
    edits: LineEdit[],
    spans: AgentTextSpan[],
    deletedTexts: string[][] = edits.map(() => []),
    diffBase = "",
    reviewState: "pending" | "finalized" = "finalized",
) {
    view.dispatch({
        effects: setInlineDiff.of({
            edits,
            spans,
            deletedTexts,
            sessionId: "session-1",
            identityKey: "note.md",
            diffBase,
            reviewState,
            version: 1,
        }),
    });
}

describe("inlineDiff", () => {
    it("renders inline modified marks without a line background for partial word changes", () => {
        const { view, destroy } = mountView("alpHa");

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [{ baseFrom: 3, baseTo: 4, currentFrom: 3, currentTo: 4 }],
            undefined,
            "",
        );

        expect(
            view.dom.querySelector(".cm-diff-inline-modified"),
        ).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-modified")).toBeNull();
        expect(view.dom.querySelector(".cm-diff-hunk-controls")).not.toBeNull();

        destroy();
    });

    it("renders inline added marks for inserted text", () => {
        const { view, destroy } = mountView("alpHXa");

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [{ baseFrom: 4, baseTo: 4, currentFrom: 4, currentTo: 5 }],
            undefined,
            "",
        );

        expect(view.dom.querySelector(".cm-diff-inline-add")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-added")).toBeNull();

        destroy();
    });

    it("keeps deleted text as a block widget with controls", () => {
        const { view, destroy } = mountView("aaa\nccc");

        applyInlineDiff(
            view,
            [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }],
            [{ baseFrom: 4, baseTo: 8, currentFrom: 4, currentTo: 4 }],
            [["bbb"]],
            "",
        );

        expect(view.dom.querySelector(".cm-diff-deleted-block")).not.toBeNull();
        expect(
            view.dom.querySelector(".cm-diff-deleted-line")?.textContent,
        ).toBe("bbb");
        expect(view.dom.querySelectorAll(".cm-diff-hunk-btn")).toHaveLength(2);

        destroy();
    });

    it("hides hunk controls while the diff is pending", () => {
        const { view, destroy } = mountView("alpHa");

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [{ baseFrom: 3, baseTo: 4, currentFrom: 3, currentTo: 4 }],
            undefined,
            "",
            "pending",
        );

        expect(view.dom.querySelector(".cm-diff-hunk-controls")).toBeNull();
        expect(view.dom.querySelector(".cm-diff-pending")).not.toBeNull();

        destroy();
    });

    it("hides deleted-block controls while the diff is pending", () => {
        const { view, destroy } = mountView("aaa\nccc");

        applyInlineDiff(
            view,
            [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }],
            [{ baseFrom: 4, baseTo: 8, currentFrom: 4, currentTo: 4 }],
            [["bbb"]],
            "",
            "pending",
        );

        expect(view.dom.querySelector(".cm-diff-deleted-block")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-deleted-controls")).toBeNull();
        expect(view.dom.querySelectorAll(".cm-diff-hunk-btn")).toHaveLength(0);

        destroy();
    });

    it("renders multiple inline spans on the same line", () => {
        // "before AAA middle BBB after" — two agent spans on one line
        const { view, destroy } = mountView("before AAA middle BBB after");

        applyInlineDiff(
            view,
            // Single line edit covering the whole line
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [
                // "aaa" → "AAA" at positions [7,10]
                { baseFrom: 7, baseTo: 10, currentFrom: 7, currentTo: 10 },
                // "bbb" → "BBB" at positions [18,21]
                { baseFrom: 18, baseTo: 21, currentFrom: 18, currentTo: 21 },
            ],
            undefined,
            "",
        );

        const modifiedMarks = view.dom.querySelectorAll(
            ".cm-diff-inline-modified",
        );
        expect(modifiedMarks.length).toBe(2);

        // No line background — the spans don't cover the full line
        expect(view.dom.querySelector(".cm-diff-modified")).toBeNull();

        destroy();
    });

    it("renders mixed inline add and modified spans on the same line", () => {
        // "alpHa betXYZa" — one modified span and one insertion
        const { view, destroy } = mountView("alpHa betXYZa");

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [
                // "h" → "H" at [3,4]
                { baseFrom: 3, baseTo: 4, currentFrom: 3, currentTo: 4 },
                // inserted "XYZ" at [9,9] → [9,12] in current
                { baseFrom: 9, baseTo: 9, currentFrom: 9, currentTo: 12 },
            ],
            undefined,
            "",
        );

        expect(
            view.dom.querySelector(".cm-diff-inline-modified"),
        ).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-inline-add")).not.toBeNull();

        destroy();
    });

    it("uses only a line background for a full-line change", () => {
        const { view, destroy } = mountView("changed line");

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [{ baseFrom: 0, baseTo: 12, currentFrom: 0, currentTo: 12 }],
            undefined,
            "",
        );

        expect(view.dom.querySelector(".cm-diff-modified")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-inline-modified")).toBeNull();

        destroy();
    });

    it("uses only line backgrounds for multiline changes", () => {
        const { view, destroy } = mountView("first line\nsecond line");

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 2 }],
            [{ baseFrom: 0, baseTo: 22, currentFrom: 0, currentTo: 22 }],
            undefined,
            "",
        );

        expect(view.dom.querySelector(".cm-diff-modified")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-inline-modified")).toBeNull();

        destroy();
    });

    it("uses word-diff marks for small modified hunks", () => {
        const baseText = "alpha beta gamma";
        const currentText = "alpha BETA delta gamma";
        const { view, destroy } = mountView(currentText);

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [{ baseFrom: 6, baseTo: 16, currentFrom: 6, currentTo: 16 }],
            undefined,
            baseText,
        );

        expect(view.dom.querySelector(".cm-diff-word-line-bg")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-word-changed")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-inline-modified")).toBeNull();

        destroy();
    });

    it("keeps word-diff marks while the diff is pending to avoid visual jumps", () => {
        const baseText = "alpha beta gamma";
        const currentText = "alpha BETA delta gamma";
        const { view, destroy } = mountView(currentText);

        applyInlineDiff(
            view,
            [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }],
            [{ baseFrom: 6, baseTo: 16, currentFrom: 6, currentTo: 16 }],
            undefined,
            baseText,
            "pending",
        );

        expect(view.dom.querySelector(".cm-diff-word-line-bg")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-word-changed")).not.toBeNull();
        expect(view.dom.querySelector(".cm-diff-inline-modified")).toBeNull();
        expect(view.dom.querySelector(".cm-diff-hunk-controls")).toBeNull();

        destroy();
    });

    it("highlights removed words inside small deleted blocks", () => {
        const { view, destroy } = mountView("aaa\nccc");

        applyInlineDiff(
            view,
            [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }],
            [{ baseFrom: 4, baseTo: 17, currentFrom: 4, currentTo: 4 }],
            [["beta", "delta words"]],
            "aaa\nbeta\ndelta words\nccc",
        );

        expect(view.dom.querySelectorAll(".cm-diff-word-removed").length).toBe(
            3,
        );

        destroy();
    });
});
