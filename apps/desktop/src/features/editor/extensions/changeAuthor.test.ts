/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
    changeAuthorAnnotation,
    computeChangedTextEdits,
    userEditNotifier,
} from "./changeAuthor";
import type { TextEdit } from "../../ai/diff/actionLogTypes";

describe("computeChangedTextEdits", () => {
    it("returns empty for non-doc-changed updates", () => {
        let lastEdits: TextEdit[] = [];
        const state = EditorState.create({
            doc: "hello\nworld",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedTextEdits(update);
                }),
            ],
        });
        const view = new EditorView({ state });
        view.dispatch({ selection: { anchor: 0 } });
        expect(lastEdits).toEqual([]);
        view.destroy();
    });

    it("detects single line edit", () => {
        let lastEdits: TextEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nbbb\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedTextEdits(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        // Replace "bbb" with "BBB" (line 1, 0-based)
        view.dispatch({
            changes: { from: 4, to: 7, insert: "BBB" },
        });

        expect(lastEdits).toHaveLength(1);
        expect(lastEdits[0]).toEqual({
            oldFrom: 4,
            oldTo: 7,
            newFrom: 4,
            newTo: 7,
        });
        view.destroy();
    });

    it("detects insertion of new lines", () => {
        let lastEdits: TextEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedTextEdits(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        // Insert "bbb\n" between aaa and ccc
        view.dispatch({
            changes: { from: 4, to: 4, insert: "bbb\n" },
        });

        expect(lastEdits).toHaveLength(1);
        expect(lastEdits[0]).toEqual({
            oldFrom: 4,
            oldTo: 4,
            newFrom: 4,
            newTo: 8,
        });
        view.destroy();
    });

    it("detects deletion of lines", () => {
        let lastEdits: TextEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nbbb\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedTextEdits(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        // Delete "bbb\n" (chars 4-8)
        view.dispatch({
            changes: { from: 4, to: 8, insert: "" },
        });

        expect(lastEdits).toHaveLength(1);
        expect(lastEdits[0]).toEqual({
            oldFrom: 4,
            oldTo: 8,
            newFrom: 4,
            newTo: 4,
        });
        view.destroy();
    });

    it("reports inline insertions with exact offsets", () => {
        let lastEdits: TextEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nbbb\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedTextEdits(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        view.dispatch({
            changes: { from: 5, to: 5, insert: "X" },
        });

        expect(lastEdits).toEqual([
            { oldFrom: 5, oldTo: 5, newFrom: 5, newTo: 6 },
        ]);
        view.destroy();
    });

    it("reports inline deletions with exact offsets", () => {
        let lastEdits: TextEdit[] = [];
        const state = EditorState.create({
            doc: "aaa\nbbb\nccc",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedTextEdits(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        view.dispatch({
            changes: { from: 4, to: 5, insert: "" },
        });

        expect(lastEdits).toEqual([
            { oldFrom: 4, oldTo: 5, newFrom: 4, newTo: 4 },
        ]);
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

    it("captures multiple edits in a single transaction (find-replace scenario)", () => {
        let lastEdits: TextEdit[] = [];
        const state = EditorState.create({
            doc: "aaa bbb aaa bbb aaa",
            extensions: [
                EditorView.updateListener.of((update) => {
                    lastEdits = computeChangedTextEdits(update);
                }),
            ],
        });
        const view = new EditorView({ state });

        // Simulate find-replace: replace all "aaa" with "XXX"
        // Three separate changes in one dispatch
        view.dispatch({
            changes: [
                { from: 0, to: 3, insert: "XXX" },
                { from: 8, to: 11, insert: "XXX" },
                { from: 16, to: 19, insert: "XXX" },
            ],
        });

        expect(lastEdits).toHaveLength(3);
        expect(lastEdits[0]).toEqual({
            oldFrom: 0,
            oldTo: 3,
            newFrom: 0,
            newTo: 3,
        });
        expect(lastEdits[1]).toEqual({
            oldFrom: 8,
            oldTo: 11,
            newFrom: 8,
            newTo: 11,
        });
        expect(lastEdits[2]).toEqual({
            oldFrom: 16,
            oldTo: 19,
            newFrom: 16,
            newTo: 19,
        });
        view.destroy();
    });
});

// ---------------------------------------------------------------------------
// userEditNotifier — end-to-end extension test
// ---------------------------------------------------------------------------

describe("userEditNotifier", () => {
    it("calls onUserEdit with fileId, textEdits, and full text on user edit", () => {
        let capturedFileId: string | null = null;
        let capturedEdits: TextEdit[] = [];
        let capturedFullText = "";

        const state = EditorState.create({
            doc: "hello world",
            extensions: [
                userEditNotifier(
                    () => "test-note.md",
                    (fileId, edits, fullText) => {
                        capturedFileId = fileId;
                        capturedEdits = edits;
                        capturedFullText = fullText;
                    },
                ),
            ],
        });
        const view = new EditorView({ state });

        view.dispatch({
            changes: { from: 5, to: 5, insert: " beautiful" },
        });

        expect(capturedFileId).toBe("test-note.md");
        expect(capturedEdits).toHaveLength(1);
        expect(capturedEdits[0]).toEqual({
            oldFrom: 5,
            oldTo: 5,
            newFrom: 5,
            newTo: 15,
        });
        expect(capturedFullText).toBe("hello beautiful world");
        view.destroy();
    });

    it("does not call onUserEdit for agent-annotated transactions", () => {
        let callCount = 0;

        const state = EditorState.create({
            doc: "hello",
            extensions: [
                userEditNotifier(
                    () => "test-note.md",
                    () => {
                        callCount++;
                    },
                ),
            ],
        });
        const view = new EditorView({ state });

        view.dispatch({
            changes: { from: 0, to: 5, insert: "AGENT" },
            annotations: [changeAuthorAnnotation.of("agent")],
        });

        expect(callCount).toBe(0);
        view.destroy();
    });

    it("does not call onUserEdit when getFileId returns null", () => {
        let callCount = 0;

        const state = EditorState.create({
            doc: "hello",
            extensions: [
                userEditNotifier(
                    () => null,
                    () => {
                        callCount++;
                    },
                ),
            ],
        });
        const view = new EditorView({ state });

        view.dispatch({
            changes: { from: 0, to: 5, insert: "world" },
        });

        expect(callCount).toBe(0);
        view.destroy();
    });
});
