import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { selectionTouchesRange } from "./selectionActivity";

describe("selectionTouchesRange", () => {
    it("does not treat a caret at the right edge as overlapping the range", () => {
        const state = EditorState.create({
            doc: "==highlight==.",
            selection: EditorSelection.cursor(13),
        });

        expect(selectionTouchesRange(state, 11, 13)).toBe(false);
    });

    it("treats a caret inside the range as overlapping it", () => {
        const state = EditorState.create({
            doc: "==highlight==.",
            selection: EditorSelection.cursor(12),
        });

        expect(selectionTouchesRange(state, 11, 13)).toBe(true);
    });

    it("treats non-empty selections as half-open range intersections", () => {
        const state = EditorState.create({
            doc: "==highlight==.",
            selection: EditorSelection.range(2, 11),
        });

        expect(selectionTouchesRange(state, 11, 13)).toBe(false);
        expect(selectionTouchesRange(state, 2, 11)).toBe(true);
    });
});
