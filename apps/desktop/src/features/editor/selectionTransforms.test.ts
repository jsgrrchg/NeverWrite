import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
    getBlockquoteTransform,
    getCodeBlockLanguageAtSelection,
    getCodeBlockTransform,
    getHeadingTransform,
    getHorizontalRuleTransform,
    getSelectionTransform,
    getSetCodeBlockLanguageTransform,
} from "./selectionTransforms";

function applyHeading(
    doc: string,
    selection: EditorSelection | { anchor: number; head?: number },
    level: 0 | 1 | 2 | 3 | 4 | 5 | 6,
) {
    const state = EditorState.create({
        doc,
        selection,
        extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const transform = getHeadingTransform(state, level);
    expect(transform).not.toBeNull();

    return state
        .update({
            changes: transform!.changes,
            selection: transform!.selection,
        })
        .state.doc.toString();
}

function applyTransform(
    doc: string,
    selection: EditorSelection | { anchor: number; head?: number },
    getTransform: (
        state: EditorState,
    ) => ReturnType<typeof getHeadingTransform>,
) {
    const state = EditorState.create({
        doc,
        selection,
        extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const transform = getTransform(state);
    expect(transform).not.toBeNull();

    return state.update({
        changes: transform!.changes,
        selection: transform!.selection,
    }).state;
}

describe("getHeadingTransform", () => {
    it("converts the current line to an ATX heading", () => {
        expect(applyHeading("Hello world", EditorSelection.cursor(0), 1)).toBe(
            "# Hello world",
        );
    });

    it("removes an ATX heading", () => {
        expect(
            applyHeading("## Hello world", EditorSelection.cursor(4), 0),
        ).toBe("Hello world");
    });

    it("normalizes setext headings to ATX headings", () => {
        expect(
            applyHeading("Hello world\n---", EditorSelection.cursor(0), 2),
        ).toBe("## Hello world");
    });

    it("applies headings to every selected line", () => {
        expect(applyHeading("One\nTwo", EditorSelection.range(0, 7), 3)).toBe(
            "### One\n### Two",
        );
    });

    it("resolves heading toolbar actions through the shared selection transform switch", () => {
        const state = EditorState.create({
            doc: "Hello world",
            selection: EditorSelection.range(0, 5),
            extensions: [EditorState.allowMultipleSelections.of(true)],
        });

        const transform = getSelectionTransform(state, "heading-2");
        expect(transform).not.toBeNull();

        const nextState = state.update({
            changes: transform!.changes,
            selection: transform!.selection,
        }).state;

        expect(nextState.doc.toString()).toBe("## Hello world");
    });

    it("toggles a blockquote on the current line with only a caret", () => {
        const quoted = applyTransform(
            "Hello world",
            EditorSelection.cursor(3),
            getBlockquoteTransform,
        );

        expect(quoted.doc.toString()).toBe("> Hello world");

        const unquoted = applyTransform(
            quoted.doc.toString(),
            EditorSelection.cursor(3),
            getBlockquoteTransform,
        );

        expect(unquoted.doc.toString()).toBe("Hello world");
    });

    it("wraps selected lines in a fenced code block", () => {
        const state = applyTransform(
            "alpha\nbeta",
            EditorSelection.range(0, 10),
            getCodeBlockTransform,
        );

        expect(state.doc.toString()).toBe("```\nalpha\nbeta\n```");
    });

    it("removes a fenced code block when the selection is inside it", () => {
        const state = applyTransform(
            "```\nalpha\nbeta\n```",
            EditorSelection.cursor(6),
            getCodeBlockTransform,
        );

        expect(state.doc.toString()).toBe("alpha\nbeta");
    });

    it("inserts an empty fenced code block on a blank line", () => {
        const state = applyTransform(
            "",
            EditorSelection.cursor(0),
            getCodeBlockTransform,
        );

        expect(state.doc.toString()).toBe("```\n\n```");
        expect(state.selection.main.from).toBe(4);
    });

    it("does nothing for code block insertion when multiple selections are present", () => {
        const state = EditorState.create({
            doc: "alpha\nbeta",
            selection: EditorSelection.create(
                [EditorSelection.cursor(0), EditorSelection.cursor(6)],
                0,
            ),
            extensions: [EditorState.allowMultipleSelections.of(true)],
        });

        expect(getCodeBlockTransform(state)).toBeNull();
        expect(getCodeBlockLanguageAtSelection(state)).toBeNull();
        expect(getSetCodeBlockLanguageTransform(state, "ts")).toBeNull();
    });

    it("reads and updates the fenced code block language", () => {
        const initialState = EditorState.create({
            doc: "```js\nconst value = 1;\n```",
            selection: EditorSelection.cursor(8),
        });

        expect(getCodeBlockLanguageAtSelection(initialState)).toBe("js");

        const transform = getSetCodeBlockLanguageTransform(initialState, "ts");
        expect(transform).not.toBeNull();

        const updatedState = initialState.update({
            changes: transform!.changes,
            selection: transform!.selection,
        }).state;

        expect(updatedState.doc.toString()).toBe(
            "```ts\nconst value = 1;\n```",
        );
    });

    it("clears the fenced code block language when the next value is empty", () => {
        const state = applyTransform(
            "```ts\nconst value = 1;\n```",
            EditorSelection.cursor(9),
            (editorState) => getSetCodeBlockLanguageTransform(editorState, ""),
        );

        expect(state.doc.toString()).toBe("```\nconst value = 1;\n```");
    });

    it("inserts a horizontal rule after the current non-empty line", () => {
        const state = applyTransform(
            "Hello world\nNext line",
            EditorSelection.cursor(2),
            getHorizontalRuleTransform,
        );

        expect(state.doc.toString()).toBe("Hello world\n---\nNext line");
    });
});
