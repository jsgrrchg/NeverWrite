import { EditorSelection, EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import {
    backspaceMarkdownListMarker,
    continueMarkdownListItem,
    insertConfiguredTab,
    removeConfiguredTab,
} from "./markdownLists";

function applyListCommand(
    doc: string,
    selection: EditorSelection | { anchor: number; head?: number },
    command: typeof continueMarkdownListItem,
) {
    let state = EditorState.create({
        doc,
        selection,
        extensions: [indentUnit.of("  ")],
    });

    const handled = command({
        state,
        dispatch: (transaction) => {
            state = transaction.state;
        },
    });

    return {
        handled,
        state,
    };
}

describe("markdownLists", () => {
    it("continues the current markdown list item on Enter", () => {
        const { handled, state } = applyListCommand(
            "- Item",
            EditorSelection.cursor(6),
            continueMarkdownListItem,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("- Item\n- ");
    });

    it("removes an empty list item marker on Backspace", () => {
        const { handled, state } = applyListCommand(
            "- ",
            EditorSelection.cursor(2),
            backspaceMarkdownListMarker,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("");
    });

    it("indents selected markdown list items on Tab", () => {
        const { handled, state } = applyListCommand(
            "- One\n- Two",
            EditorSelection.range(0, 11),
            insertConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("  - One\n  - Two");
    });

    it("outdents selected markdown list items on Shift+Tab", () => {
        const { handled, state } = applyListCommand(
            "  - One\n  - Two",
            EditorSelection.range(0, 15),
            removeConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("- One\n- Two");
    });
});
