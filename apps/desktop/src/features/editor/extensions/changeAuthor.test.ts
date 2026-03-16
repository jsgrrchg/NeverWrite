/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
    changeAuthorAnnotation,
    computeChangedLineRanges,
} from "./changeAuthor";
import type { LineEdit } from "../../ai/diff/actionLogTypes";

describe("computeChangedLineRanges", () => {
    it("returns empty for non-doc-changed updates", () => {
        let lastEdits: LineEdit[] = [];
        const state = EditorState.create({
            doc: "hello\nworld",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedLineRanges(update);
                }),
            ],
        });
        const view = new EditorView({ state });
        view.dispatch({ selection: { anchor: 0 } });
        expect(lastEdits).toEqual([]);
        view.destroy();
    });

    it("detects single line edit", () => {
        let lastEdits: LineEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nbbb\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedLineRanges(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        // Replace "bbb" with "BBB" (line 1, 0-based)
        view.dispatch({
            changes: { from: 4, to: 7, insert: "BBB" },
        });

        expect(lastEdits).toHaveLength(1);
        expect(lastEdits[0].oldStart).toBe(1);
        expect(lastEdits[0].oldEnd).toBe(2);
        expect(lastEdits[0].newStart).toBe(1);
        expect(lastEdits[0].newEnd).toBe(2);
        view.destroy();
    });

    it("detects insertion of new lines", () => {
        let lastEdits: LineEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedLineRanges(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        // Insert "bbb\n" between aaa and ccc
        view.dispatch({
            changes: { from: 4, to: 4, insert: "bbb\n" },
        });

        expect(lastEdits).toHaveLength(1);
        // No old lines removed (oldStart === oldEnd)
        expect(lastEdits[0].oldStart).toBe(lastEdits[0].oldEnd);
        // New lines inserted
        expect(lastEdits[0].newEnd).toBeGreaterThan(lastEdits[0].newStart);
        view.destroy();
    });

    it("detects deletion of lines", () => {
        let lastEdits: LineEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nbbb\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedLineRanges(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        // Delete "bbb\n" (chars 4-8)
        view.dispatch({
            changes: { from: 4, to: 8, insert: "" },
        });

        expect(lastEdits).toHaveLength(1);
        // Old lines were removed
        expect(lastEdits[0].oldEnd).toBeGreaterThan(lastEdits[0].oldStart);
        // No new lines inserted
        expect(lastEdits[0].newStart).toBe(lastEdits[0].newEnd);
        view.destroy();
    });

    it("skips agent-annotated transactions", () => {
        let notifyCount = 0;
        const state = EditorState.create({
            doc: "hello",
            extensions: [
                EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    if (update.transactions.length === 0) return;
                    const isAgent = update.transactions.some(
                        (tr) =>
                            tr.annotation(changeAuthorAnnotation) === "agent",
                    );
                    if (!isAgent) notifyCount++;
                }),
            ],
        });
        const view = new EditorView({ state });

        // Agent edit — should NOT notify
        view.dispatch({
            changes: { from: 0, to: 5, insert: "world" },
            annotations: [changeAuthorAnnotation.of("agent")],
        });
        expect(notifyCount).toBe(0);

        // User edit — SHOULD notify
        view.dispatch({
            changes: { from: 0, to: 5, insert: "user" },
        });
        expect(notifyCount).toBe(1);
        view.destroy();
    });
});
