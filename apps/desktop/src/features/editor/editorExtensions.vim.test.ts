import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getVimExtension, getLineNumberExtension } from "./editorExtensions";

describe("getVimExtension", () => {
    it("returns no extension when disabled", () => {
        expect(getVimExtension(false)).toEqual([]);
    });

    it("returns a non-empty extension when enabled", () => {
        const ext = getVimExtension(true);
        expect(Array.isArray(ext)).toBe(true);
        expect((ext as unknown[]).length).toBeGreaterThan(0);
        // Should build into a valid editor state without throwing.
        expect(() =>
            EditorState.create({ doc: "hello", extensions: ext }),
        ).not.toThrow();
    });
});

describe("getLineNumberExtension", () => {
    it("renders no gutter in live-preview mode", () => {
        expect(getLineNumberExtension(true, false)).toEqual([]);
        expect(getLineNumberExtension(true, true)).toEqual([]);
    });

    it("builds an absolute gutter in code mode", () => {
        expect(() =>
            EditorState.create({
                doc: "one\ntwo",
                extensions: getLineNumberExtension(false, false),
            }),
        ).not.toThrow();
    });

    it("builds a relative gutter in code mode without throwing", () => {
        expect(() =>
            EditorState.create({
                doc: "one\ntwo\nthree",
                selection: { anchor: 4 },
                extensions: getLineNumberExtension(false, true),
            }),
        ).not.toThrow();
    });
});

describe("relative line number gutter", () => {
    let view: EditorView | null = null;
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    afterEach(() => {
        view?.destroy();
        view = null;
    });

    function gutterLabels(v: EditorView) {
        return Array.from(
            v.dom.querySelectorAll<HTMLElement>(
                ".cm-lineNumbers .cm-gutterElement",
            ),
        )
            // Skip the hidden width-spacer element kept for layout stability.
            .filter((el) => el.style.visibility !== "hidden")
            .map((el) => el.textContent ?? "");
    }

    it("recomputes labels relative to the cursor when the selection moves", () => {
        view = new EditorView({
            state: EditorState.create({
                doc: "one\ntwo\nthree\nfour",
                selection: { anchor: 0 }, // line 1
                extensions: getLineNumberExtension(false, true),
            }),
            parent,
        });

        // Cursor on line 1: current line shows absolute "1", others show distance.
        expect(gutterLabels(view)).toEqual(["1", "1", "2", "3"]);

        // Move cursor to line 3 ("three"): distances recompute around it.
        view.dispatch({ selection: EditorSelection.cursor(8) });
        expect(gutterLabels(view)).toEqual(["2", "1", "3", "1"]);
    });
});
